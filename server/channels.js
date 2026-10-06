// Channel registry. CHANNELS (server/auth.js) are built in and always on; any other streamer signs up on /start and
// their channel lives in AuthStore:
//   channel:<login> = { id, login, enabledAt, pausedAt?, pausedBy?, review? }   kept ~20 years; paused keeps fighters and ranks
//   review = { reasons, at }: sign-up didn't pass the streamer check and waits, off, for the owner to turn it on.
import { record, CHANNELS } from './auth.js';

export const MAX_CHANNELS = 200;
export const CHANNEL_MS = 20 * 365 * 86400000;
export const LOGIN = /^[a-z0-9_]{3,25}$/;
export const STREAMER_MIN_AGE_MS = 30 * 86400000;

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

const saveChannel = (env, rec) => { forgetChannel(rec.login); return record(env, 'channel:' + rec.login, rec, Date.now() + CHANNEL_MS); };
const enabledCount = rows => rows.filter(r => !r.value.pausedAt).length;
const fail = (status, error, reason) => Object.assign(new Error(error), { status, reason });

// The streamer check for a new sign-up, from the signed-in Helix user: why it needs the owner's approval, [] when it
// doesn't. 'young': the account is under 30 days old. 'never_streamed': not Affiliate or Partner and no past broadcast
// saved. 'unchecked': the past-broadcast lookup failed. helix(path) returns the parsed JSON or throws.
export async function reviewReasons(identity, helix, now = Date.now()) {
  const reasons = [], created = Date.parse(identity?.created_at) || 0;
  if (!created || now - created < STREAMER_MIN_AGE_MS) reasons.push('young');
  if (!['affiliate', 'partner'].includes(identity?.broadcaster_type)) {
    const streamed = await helix('/videos?type=archive&first=1&user_id=' + encodeURIComponent(identity.id)).then((d) => d?.data?.length > 0, () => null);
    if (!streamed) reasons.push(streamed === null ? 'unchecked' : 'never_streamed');
  }
  return reasons;
}

// Sign-up from /start: the signed-in Twitch account turns on its own channel, never anyone else's. Signing up again
// is a no-op (a channel turned off stays off; its broadcaster turns it back on from Stream setup). A new channel that
// fails check() is saved off with a review note for the owner, and sign-up stops with 'review'.
export async function signUp(env, user, check = async () => []) {
  const login = String(user.login || '').toLowerCase();
  if (!LOGIN.test(login)) throw fail(400, 'This Twitch account name is not supported', 'failed');
  if (CHANNELS.includes(login)) return login;
  const existing = await record(env, 'channel:' + login);
  // A Twitch name can pass to a new account after a rename; the channel stays with the account that set it up.
  if (existing?.id && existing.id !== user.id) throw fail(403, 'This channel name was set up by another Twitch account', 'taken');
  if (existing?.review) throw fail(403, 'This channel is waiting for the site owner to approve it', 'review');
  if (existing) return login;
  if (enabledCount(await listRecords(env, 'channel:')) >= MAX_CHANNELS) throw fail(403, 'PixFray is full right now', 'full');
  const reasons = await check();
  if (reasons.length) {
    const now = Date.now();
    await saveChannel(env, { id: user.id, login, enabledAt: now, pausedAt: now, pausedBy: 'owner', review: { reasons, at: now } });
    throw fail(403, 'This channel is waiting for the site owner to approve it', 'review');
  }
  await saveChannel(env, { id: user.id, login, enabledAt: Date.now() });
  return login;
}

// The signed-in account is this channel's broadcaster: same login and, for a signed-up channel, the same Twitch id it
// signed up with (a new holder of a renamed account's old name gets nothing). Built-in channels match on login.
export async function isBroadcaster(env, user, channel) {
  if (!user || String(user.login || '').toLowerCase() !== channel) return false;
  if (CHANNELS.includes(channel)) return true;
  const rec = await record(env, 'channel:' + channel);
  return !rec?.id || rec.id === user.id;
}

// Off and back on. by = 'owner' | 'broadcaster'. A channel the owner turned off stays off until the owner turns it
// back on; that's the owner's switch for a channel that misuses open sign-up.
export async function setPaused(env, login, paused, by = 'owner') {
  if (CHANNELS.includes(login)) throw fail(400, login + ' is built in and always on', 'builtin');
  const rec = await record(env, 'channel:' + login);
  if (!rec) throw fail(404, login + ' is not set up', 'not_found');
  if (!paused && rec.pausedBy === 'owner' && by !== 'owner') throw fail(403, 'The site owner turned PixFray off for this channel', 'owner_off');
  if (!paused && rec.pausedAt && enabledCount(await listRecords(env, 'channel:')) >= MAX_CHANNELS) throw fail(403, 'PixFray is full right now', 'full');
  // turning it on approves a channel waiting for review
  const { pausedAt, pausedBy, review, ...rest } = rec;
  const next = paused ? { ...rest, pausedAt: pausedAt || Date.now(), pausedBy: pausedBy === 'owner' ? 'owner' : by, ...(review ? { review } : {}) } : rest;
  await saveChannel(env, next);
  return next;
}

// Owner view for /admin/dev: live channels, newest first.
export async function overview(env) {
  const channels = await listRecords(env, 'channel:');
  return {
    builtin: CHANNELS,
    max: MAX_CHANNELS,
    channels: channels.map(r => ({ login: r.value.login, enabledAt: r.value.enabledAt, pausedAt: r.value.pausedAt || 0, pausedBy: r.value.pausedBy || '', ...(r.value.review ? { review: r.value.review } : {}) })).sort((a, b) => b.enabledAt - a.enabledAt),
  };
}
