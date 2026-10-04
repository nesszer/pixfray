// Channel registry. CHANNELS (server/auth.js) are built in and always on; every other channel is added by an
// owner invite and lives in AuthStore:
//   channel:<login> = { id, login, enabledAt, pausedAt? }          kept ~20 years; paused keeps fighters and ranks
//   invite:<token>  = { login, createdAt, by, usedAt? }            valid 7 days, single use, listed 30 days more
import { record, consume, CHANNELS } from './auth.js';

export const MAX_CHANNELS = 200;
export const INVITE_MS = 7 * 86400000;
const INVITE_KEEP_MS = 30 * 86400000;
export const CHANNEL_MS = 20 * 365 * 86400000;
export const LOGIN = /^[a-z0-9_]{3,25}$/;
const TOKEN = /^[a-f0-9]{32}$/;

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

// Live rows under a prefix ('channel:' or 'invite:'), at most 500.
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

export function inviteStatus(invite, now = Date.now()) {
  if (!invite) return 'invalid';
  if (invite.usedAt) return 'used';
  return now - invite.createdAt > INVITE_MS ? 'expired' : 'valid';
}
// Public: what /start shows for ?invite=<token>. Only the invited login is revealed.
export async function readInvite(env, token) {
  if (!TOKEN.test(token || '')) return { status: 'invalid' };
  const invite = await record(env, 'invite:' + token);
  const status = inviteStatus(invite);
  return status === 'invalid' ? { status } : { status, login: invite.login };
}

const saveInvite = (env, token, invite) => record(env, 'invite:' + token, invite, invite.createdAt + INVITE_MS + INVITE_KEEP_MS);
const saveChannel = (env, rec) => { forgetChannel(rec.login); return record(env, 'channel:' + rec.login, rec, Date.now() + CHANNEL_MS); };
const enabledCount = rows => rows.filter(r => !r.value.pausedAt).length;
const fail = (status, error, reason) => Object.assign(new Error(error), { status, reason });

export async function createInvite(env, login, by) {
  login = String(login || '').trim().replace(/^@/, '').toLowerCase();
  if (!LOGIN.test(login)) throw fail(400, 'Type a Twitch login: 3 to 25 letters, digits or _', 'bad_login');
  if (CHANNELS.includes(login)) throw fail(409, login + ' is built in and always on', 'builtin');
  const existing = await record(env, 'channel:' + login);
  if (existing) throw fail(409, login + ' is already set up' + (existing.pausedAt ? ' (turned off; turn it back on below)' : ''), 'exists');
  const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('');
  await saveInvite(env, token, { login, createdAt: Date.now(), by: String(by || '') });
  return token;
}

// Sign-in with an invite: the Twitch account must be the invited login. Single use: the record is taken
// atomically, then written back marked used.
export async function claimInvite(env, token, user) {
  if (!TOKEN.test(token || '')) throw fail(400, 'This invite link is not valid', 'invalid');
  const invite = await record(env, 'invite:' + token), status = inviteStatus(invite);
  if (status !== 'valid') throw fail(403, status === 'used' ? 'This invite was already used' : status === 'expired' ? 'This invite has expired' : 'This invite link is not valid', status);
  if (invite.login !== String(user.login || '').toLowerCase()) throw fail(403, 'This invite is for ' + invite.login + '. Sign in to Twitch as ' + invite.login + '.', 'wrong_account');
  const existing = await record(env, 'channel:' + invite.login);
  if (!existing && enabledCount(await listRecords(env, 'channel:')) >= MAX_CHANNELS) throw fail(403, 'PixFray is full right now. Ask nesszerra for a spot.', 'full');
  const taken = await consume(env, 'invite:' + token);
  if (inviteStatus(taken) !== 'valid') throw fail(403, 'This invite was already used', 'used');
  const now = Date.now();
  await saveInvite(env, token, { ...taken, usedAt: now });
  await saveChannel(env, { id: user.id, login: invite.login, enabledAt: existing?.enabledAt || now });
  return invite.login;
}

export async function setPaused(env, login, paused) {
  if (CHANNELS.includes(login)) throw fail(400, login + ' is built in and always on', 'builtin');
  const rec = await record(env, 'channel:' + login);
  if (!rec) throw fail(404, login + ' is not set up', 'not_found');
  if (!paused && rec.pausedAt && enabledCount(await listRecords(env, 'channel:')) >= MAX_CHANNELS) throw fail(403, 'PixFray is full right now', 'full');
  const { pausedAt, ...rest } = rec;
  const next = paused ? { ...rest, pausedAt: pausedAt || Date.now() } : rest;
  await saveChannel(env, next);
  return next;
}

// Owner view for /admin/dev: live channels and invites, newest first.
export async function overview(env) {
  const [channels, invites] = await Promise.all([listRecords(env, 'channel:'), listRecords(env, 'invite:')]);
  const now = Date.now();
  return {
    builtin: CHANNELS,
    max: MAX_CHANNELS,
    channels: channels.map(r => ({ login: r.value.login, enabledAt: r.value.enabledAt, pausedAt: r.value.pausedAt || 0 })).sort((a, b) => b.enabledAt - a.enabledAt),
    invites: invites.map(r => ({ token: r.key.slice('invite:'.length), login: r.value.login, createdAt: r.value.createdAt, usedAt: r.value.usedAt || 0, status: inviteStatus(r.value, now) })).sort((a, b) => b.createdAt - a.createdAt),
  };
}
export async function revokeInvite(env, token) {
  if (!TOKEN.test(token || '')) throw fail(400, 'Unknown invite', 'invalid');
  await record(env, 'invite:' + token, null);
}
