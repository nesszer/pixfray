// Channel registry. CHANNELS (server/auth.js) are built in and always on; any other streamer signs up on /start and
// their channel lives in AuthStore:
//   channel:<login> = { id, login, enabledAt, pausedAt?, pausedBy? }   kept ~20 years; paused keeps fighters and ranks
import { record, CHANNELS } from './auth.js';
import { helix } from './eventsub.js';

export const MAX_CHANNELS = 200;
export const CHANNEL_MS = 20 * 365 * 86400000;
export const LOGIN = /^[a-z0-9_]{3,25}$/;

// Per-isolate cache, so a page load or a chat command doesn't read AuthStore every time. Another isolate can serve
// a just-paused channel for up to a minute.
const cache = new Map();
const HIT_MS = 60000, MISS_MS = 10000;
export function forgetChannel(channel) { if (channel) cache.delete(channel); else cache.clear(); }

// 'builtin' | 'on' | 'paused' | null (never set up)
export async function channelState(env, channel) {
  if (CHANNELS.includes(channel)) return 'builtin';
  if (!LOGIN.test(channel || '')) return null;
  const hit = cache.get(channel), now = Date.now();
  if (hit && now - hit.at < (hit.state ? HIT_MS : MISS_MS)) return hit.state;
  const rec = await record(env, 'channel:' + channel);
  const state = !rec ? null : rec.pausedAt ? 'paused' : 'on';
  if (cache.size > 1000) cache.clear();
  cache.set(channel, { state, at: now });
  return state;
}
export const isOn = state => state === 'builtin' || state === 'on';
export async function enabledChannel(env, channel) { return isOn(await channelState(env, channel)); }
// The refusal for a channel that is off: 403 with off = 'paused' | 'not_enabled'.
export const offError = state => state === 'paused'
  ? { error: 'PixFray is off on this channel right now', off: 'paused' }
  : { error: 'PixFray is not enabled for this channel', off: 'not_enabled' };

// Live rows under a prefix ('channel:'), at most 500.
export async function listRecords(env, prefix) {
  const stub = env.AUTH.get(env.AUTH.idFromName('auth'));
  const r = await stub.fetch('https://auth/list?key=' + encodeURIComponent(prefix), { headers: { 'X-Mini-Internal': env.INTERNAL_SECRET } });
  if (!r.ok) throw new Error('Auth storage unavailable');
  return r.json();
}

// Public: the logins a viewer can pick on the bare site (built-in channels first, then by sign-up). Cached a minute.
let channelList = null;
export async function publicChannels(env) {
  if (channelList && Date.now() - channelList.at < HIT_MS) return channelList.logins;
  const rows = (await listRecords(env, 'channel:')).map((r) => r.value).filter((c) => c && !c.pausedAt && LOGIN.test(c.login || '') && !CHANNELS.includes(c.login));
  const logins = [...CHANNELS, ...rows.sort((a, b) => (a.enabledAt || 0) - (b.enabledAt || 0)).map((c) => c.login)];
  channelList = { logins, at: Date.now() };
  return logins;
}

// Public: Twitch channels matching a typed name, so a viewer can find any stream, not only the ones listed. Each row
// says whether PixFray is on there. Channels with PixFray on come first, then live ones. Answers are cached per
// isolate for a minute, and each address gets 30 searches a minute, so typing can't burn the app's Helix budget.
const searches = new Map(), searchers = new Map();
const SEARCH_MS = 60000, SEARCHES_PER_MIN = 30;
export const searchQuery = q => String(q || '').replace(/[\u0000-\u001f]/g, '').trim().toLowerCase().slice(0, 40);
export async function searchChannels(env, q, ip = '') {
  const query = searchQuery(q);
  if (query.length < 2) return [];
  const now = Date.now(), hit = searches.get(query);
  if (hit && now - hit.at < SEARCH_MS) return hit.rows;
  const seen = searchers.get(ip);
  const used = seen && now - seen.at < 60000 ? seen : { at: now, n: 0 };
  if (++used.n > SEARCHES_PER_MIN) throw fail(429, 'Too many searches, try again in a minute', 'busy');
  if (searchers.size > 5000) searchers.clear();
  searchers.set(ip, used);
  const r = await helix(env, 'GET', '/search/channels?first=10&query=' + encodeURIComponent(query));
  if (!r.ok) throw fail(502, 'Twitch search is unavailable right now', 'twitch');
  const data = (await r.json()).data || [];
  const rows = await Promise.all(data.filter((c) => LOGIN.test(c.broadcaster_login || '')).map(async (c, i) => {
    const state = await channelState(env, c.broadcaster_login);
    return { login: c.broadcaster_login, name: String(c.display_name || c.broadcaster_login).slice(0, 40), live: !!c.is_live, game: String(c.game_name || '').slice(0, 60), pixfray: isOn(state), i };
  }));
  rows.sort((a, b) => (b.pixfray - a.pixfray) || (b.live - a.live) || (a.i - b.i));
  const out = rows.map(({ i, ...row }) => row);
  if (searches.size > 500) searches.clear();
  searches.set(query, { rows: out, at: now });
  return out;
}

const saveChannel = (env, rec) => { forgetChannel(rec.login); return record(env, 'channel:' + rec.login, rec, Date.now() + CHANNEL_MS); };
const enabledCount = rows => rows.filter(r => !r.value.pausedAt).length;
const fail = (status, error, reason) => Object.assign(new Error(error), { status, reason });

// Sign-up from /start: the signed-in Twitch account turns on its own channel, never anyone else's. Signing up again
// is a no-op (a channel turned off stays off; its broadcaster turns it back on from Stream setup).
export async function signUp(env, user) {
  const login = String(user.login || '').toLowerCase();
  if (!LOGIN.test(login)) throw fail(400, 'This Twitch account name is not supported', 'failed');
  if (CHANNELS.includes(login)) return login;
  const existing = await record(env, 'channel:' + login);
  if (existing) return login;
  if (enabledCount(await listRecords(env, 'channel:')) >= MAX_CHANNELS) throw fail(403, 'PixFray is full right now', 'full');
  await saveChannel(env, { id: user.id, login, enabledAt: Date.now() });
  return login;
}

// Off and back on. by = 'owner' | 'broadcaster'. A channel the owner turned off stays off until the owner turns it
// back on; that's the owner's switch for a channel that misuses open sign-up.
export async function setPaused(env, login, paused, by = 'owner') {
  if (CHANNELS.includes(login)) throw fail(400, login + ' is built in and always on', 'builtin');
  const rec = await record(env, 'channel:' + login);
  if (!rec) throw fail(404, login + ' is not set up', 'not_found');
  if (!paused && rec.pausedBy === 'owner' && by !== 'owner') throw fail(403, 'The site owner turned PixFray off for this channel', 'owner_off');
  if (!paused && rec.pausedAt && enabledCount(await listRecords(env, 'channel:')) >= MAX_CHANNELS) throw fail(403, 'PixFray is full right now', 'full');
  const { pausedAt, pausedBy, ...rest } = rec;
  const next = paused ? { ...rest, pausedAt: pausedAt || Date.now(), pausedBy: pausedBy === 'owner' ? 'owner' : by } : rest;
  await saveChannel(env, next);
  return next;
}

// Owner view for /admin/dev: live channels, newest first.
export async function overview(env) {
  const channels = await listRecords(env, 'channel:');
  return {
    builtin: CHANNELS,
    max: MAX_CHANNELS,
    channels: channels.map(r => ({ login: r.value.login, enabledAt: r.value.enabledAt, pausedAt: r.value.pausedAt || 0, pausedBy: r.value.pausedBy || '' })).sort((a, b) => b.enabledAt - a.enabledAt),
  };
}
