// Channel registry, invites, signup through /start, mod access later, and turning a channel off (server/channels.js).
// AuthStore runs for real on node:sqlite; rooms are a fake that echoes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../server/worker.js';
import { AuthStore, digest, record } from '../server/auth.js';
import { forgetChannel, MAX_CHANNELS, INVITE_MS } from '../server/channels.js';
import { OFF_TEXT } from '../server/streamelements.js';

const ORIGIN = 'https://chat.miolaf.xyz';
function store() {
  const db = new DatabaseSync(':memory:');
  const ctx = { storage: { sql: { exec(q, ...p) { const rows = db.prepare(q).all(...p).map(r => ({ ...r })); return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } }, async setAlarm() {} } };
  return new AuthStore(ctx, { INTERNAL_SECRET: 'test-only-internal-key' });
}
function environment() {
  forgetChannel();
  const auth = store(), rooms = [];
  const env = {
    AUTH_SECRET: 'test-only-auth-key', INTERNAL_SECRET: 'test-only-internal-key', OWNER_TWITCH_ID: '1',
    TWITCH_CLIENT_ID: 'test-app', TWITCH_CLIENT_SECRET: 'test-secret',
    AUTH: { idFromName: x => x, get: () => ({ fetch: (url, init) => auth.fetch(new Request(url, init)) }) },
    ROOMS: { idFromName: x => x, get: channel => ({ async fetch(url, init) { rooms.push({ channel, path: new URL(url).pathname }); return Response.json(new URL(url).pathname === '/se' ? { reply: 'room answered' } : { channel }); } }) },
    ASSETS: { fetch: async () => new Response('page') },
  };
  return { env, auth, rooms };
}
async function signIn(env, user) {
  const cookie = String(user.id).padStart(64, 'c').slice(-64).replace(/[^a-f0-9]/g, 'c');
  await record(env, 'session:' + await digest(cookie), { user }, Date.now() + 3600000);
  return 'mini_session=' + cookie;
}
const OWNER = { id: '1', login: 'nesszerra', displayName: 'nesszerra' };
const STREAMER = { id: '55', login: 'newstreamer', displayName: 'NewStreamer' };
function req(path, method = 'GET', data, cookie) {
  return new Request(ORIGIN + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
}
// Twitch, as seen by the callback: `as` is the account that signs in, `scopes` what it granted.
function twitch(t, as, scopes) {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    if (u.endsWith('/oauth2/token')) return Response.json({ access_token: 'user-token', refresh_token: 'r' });
    if (u.endsWith('/oauth2/validate')) return Response.json({ client_id: 'test-app', user_id: as.id, scopes });
    if (u.includes('login=nesszerra')) return Response.json({ data: [{ id: '1', login: 'nesszerra', display_name: 'nesszerra' }] });
    return Response.json({ data: [{ id: as.id, login: as.login, display_name: as.displayName }] });
  });
}
async function login(env, query) {
  const r = await worker.fetch(req('/auth/login?' + query), env);
  return { r, state: r.status === 302 ? new URL(r.headers.get('Location')).searchParams.get('state') : '' };
}
const callback = (env, state, query = 'code=c') => worker.fetch(new Request(ORIGIN + '/auth/callback?' + query + '&state=' + state, { headers: { Cookie: 'mini_oauth=' + state } }), env);
async function invite(env, loginName = 'newstreamer') {
  const owner = await signIn(env, OWNER);
  const r = await worker.fetch(req('/api/dev/channels', 'POST', { action: 'invite', login: loginName }, owner), env);
  return { r, body: await r.json() };
}

test('AuthStore lists only the channel and invite prefixes; only channel rows may live for years', async () => {
  const { env } = environment();
  const list = key => env.AUTH.get().fetch('https://auth/list?key=' + encodeURIComponent(key), { headers: { 'X-Mini-Internal': env.INTERNAL_SECRET } });
  assert.equal((await list('session:')).status, 400);
  assert.equal((await list('broadcaster:')).status, 400);
  await record(env, 'channel:abc', { login: 'abc' }, Date.now() + 10 * 365 * 86400000);
  await record(env, 'channelz', { login: 'not a row' }, Date.now() + 60000);
  await assert.rejects(record(env, 'session:x', {}, Date.now() + 200 * 86400000));
  assert.deepEqual(await (await list('channel:')).json(), [{ key: 'channel:abc', value: { login: 'abc' } }]);
});

test('owner invites a streamer; /api/invite tells /start who it is for', async () => {
  const { env } = environment();
  const { r, body } = await invite(env, '@NewStreamer');
  assert.equal(r.status, 200);
  assert.match(body.token, /^[a-f0-9]{32}$/);
  assert.equal(body.link, ORIGIN + '/start/?invite=' + body.token);
  assert.deepEqual(body.invites.map(i => [i.login, i.status]), [['newstreamer', 'valid']]);
  assert.deepEqual(await (await worker.fetch(req('/api/invite/' + body.token), env)).json(), { status: 'valid', login: 'newstreamer' });
  assert.deepEqual(await (await worker.fetch(req('/api/invite/' + 'f'.repeat(32)), env)).json(), { status: 'invalid' });
  // built-ins and bad logins are refused; a viewer can't invite
  assert.equal((await invite(env, 'miolafff')).r.status, 409);
  assert.equal((await invite(env, 'a b')).r.status, 400);
  const viewer = await signIn(env, { id: '9', login: 'viewer', displayName: 'viewer' });
  assert.equal((await worker.fetch(req('/api/dev/channels', 'POST', { action: 'invite', login: 'x' }, viewer), env)).status, 403);
});

test('signup: the invited account signs in with moderation:read, the channel turns on, the invite is spent', async (t) => {
  const { env, rooms } = environment();
  const { body } = await invite(env);
  assert.equal((await worker.fetch(req('/api/state/newstreamer'), env)).status, 403, 'not on before signup');
  const { r, state } = await login(env, 'invite=' + body.token);
  assert.equal(r.status, 302);
  assert.equal(new URL(r.headers.get('Location')).searchParams.get('scope'), 'moderation:read');
  twitch(t, STREAMER, ['moderation:read']);
  const done = await callback(env, state);
  assert.equal(done.status, 303);
  assert.equal(done.headers.get('Location'), '/admin/?channel=newstreamer&signed_in=1#chat');
  assert.match(done.headers.get('Set-Cookie'), /mini_session=[a-f0-9]{64}/);
  const channel = await record(env, 'channel:newstreamer');
  assert.equal(channel.id, '55');
  assert.ok(await record(env, 'broadcaster:newstreamer'), 'mods can be checked');
  assert.equal((await record(env, 'invite:' + body.token)).usedAt > 0, true);
  assert.equal((await worker.fetch(req('/api/state/newstreamer'), env)).status, 200);
  assert.equal(rooms.at(-1).channel, 'newstreamer');
  assert.deepEqual(await (await worker.fetch(req('/api/invite/' + body.token), env)).json(), { status: 'used', login: 'newstreamer' });
  // a second use goes back to /start with the reason
  const again = await login(env, 'invite=' + body.token);
  assert.equal(again.r.status, 303);
  assert.equal(again.r.headers.get('Location'), '/start/?invite=' + body.token + '&error=used');
});

test('signup without mod access (mods=0) asks for no scope and stores no broadcaster token', async (t) => {
  const { env } = environment();
  const { body } = await invite(env);
  const { r, state } = await login(env, 'invite=' + body.token + '&mods=0');
  assert.equal(new URL(r.headers.get('Location')).searchParams.get('scope'), '');
  twitch(t, STREAMER, []);
  assert.equal((await callback(env, state)).status, 303);
  assert.ok(await record(env, 'channel:newstreamer'));
  assert.equal(await record(env, 'broadcaster:newstreamer'), null);
});

test('an invite only works for its own Twitch account, and a cancelled consent goes back to /start', async (t) => {
  const { env } = environment();
  const { body } = await invite(env);
  let { state } = await login(env, 'invite=' + body.token);
  twitch(t, { id: '77', login: 'someoneelse', displayName: 'someoneelse' }, ['moderation:read']);
  const wrong = await callback(env, state);
  assert.equal(wrong.headers.get('Location'), '/start/?invite=' + body.token + '&error=wrong_account');
  assert.equal(wrong.headers.get('Set-Cookie').includes('mini_session'), false, 'no session from a refused signup');
  assert.equal(await record(env, 'channel:someoneelse'), null);
  assert.equal(await record(env, 'channel:newstreamer'), null);
  assert.equal((await (await worker.fetch(req('/api/invite/' + body.token), env)).json()).status, 'valid', 'still usable by the right account');
  ({ state } = await login(env, 'invite=' + body.token));
  const denied = await callback(env, state, 'error=access_denied&error_description=x');
  assert.equal(denied.headers.get('Location'), '/start/?invite=' + body.token + '&error=denied');
});

test('invites expire after 7 days', async () => {
  const { env } = environment();
  const { body } = await invite(env);
  const inv = await record(env, 'invite:' + body.token);
  await record(env, 'invite:' + body.token, { ...inv, createdAt: Date.now() - INVITE_MS - 1000 }, Date.now() + 86400000);
  assert.equal((await (await worker.fetch(req('/api/invite/' + body.token), env)).json()).status, 'expired');
  assert.equal((await login(env, 'invite=' + body.token)).r.headers.get('Location'), '/start/?invite=' + body.token + '&error=expired');
});

test(`the registry is capped at ${MAX_CHANNELS} channels that are on`, async (t) => {
  const { env } = environment();
  const { body } = await invite(env);
  for (let i = 0; i < MAX_CHANNELS; i++) await record(env, 'channel:filler' + i, { id: String(1000 + i), login: 'filler' + i, enabledAt: 1 }, Date.now() + 86400000);
  const { state } = await login(env, 'invite=' + body.token);
  twitch(t, STREAMER, ['moderation:read']);
  assert.equal((await callback(env, state)).headers.get('Location'), '/start/?invite=' + body.token + '&error=full');
  assert.equal(await record(env, 'channel:newstreamer'), null);
});

test('turning a channel off keeps its admin page; overlay feed, viewer page and commands say it is off', async (t) => {
  const { env } = environment();
  await record(env, 'channel:newstreamer', { id: '55', login: 'newstreamer', enabledAt: 1 }, Date.now() + 86400000);
  const streamer = await signIn(env, STREAMER), viewer = await signIn(env, { id: '9', login: 'viewer', displayName: 'viewer' });
  assert.equal((await worker.fetch(req('/api/admin/newstreamer', 'POST', { action: 'pauseChannel' }, viewer), env)).status, 403);
  assert.deepEqual(await (await worker.fetch(req('/api/admin/newstreamer', 'POST', { action: 'pauseChannel' }, streamer), env)).json(), { ok: true, channelState: 'paused' });
  assert.ok((await record(env, 'channel:newstreamer')).pausedAt > 0);
  const off = await worker.fetch(req('/api/state/newstreamer'), env);
  assert.equal(off.status, 403);
  assert.deepEqual(await off.json(), { error: 'Mini Chat is off on this channel right now', off: 'paused' });
  assert.equal((await worker.fetch(req('/api/looks/newstreamer?u=a'), env)).status, 403);
  assert.equal(await (await worker.fetch(req('/api/se/newstreamer/help?k=' + 'a1'.repeat(24)), env)).text(), OFF_TEXT);
  assert.equal((await worker.fetch(req('/api/leaderboard/newstreamer'), env)).status, 200);
  const admin = await worker.fetch(req('/api/admin/newstreamer', 'GET', undefined, streamer), env);
  assert.equal(admin.status, 200);
  assert.equal((await admin.json()).channelState, 'paused');
  // the broadcaster can still sign in to turn it back on
  assert.equal((await login(env, 'channel=newstreamer&next=/admin/')).r.status, 302);
  await worker.fetch(req('/api/admin/newstreamer', 'POST', { action: 'resumeChannel' }, streamer), env);
  assert.equal((await worker.fetch(req('/api/state/newstreamer'), env)).status, 200);
  assert.equal(await (await worker.fetch(req('/api/se/newstreamer/help?k=' + 'a1'.repeat(24)), env)).text(), 'room answered');
  // built-ins are always on; channels never set up stay closed
  const owner = await signIn(env, OWNER);
  assert.equal((await worker.fetch(req('/api/admin/miolafff', 'POST', { action: 'pauseChannel' }, owner), env)).status, 400);
  assert.deepEqual(await (await worker.fetch(req('/api/state/nobodyhere'), env)).json(), { error: 'Mini Chat is not enabled for this channel', off: 'not_enabled' });
  assert.equal((await worker.fetch(req('/api/se/nobodyhere/help?k=' + 'a1'.repeat(24)), env)).status, 404);
  assert.equal((await login(env, 'channel=nobodyhere')).r.status, 403);
});

test('owner Channels box: list, revoke an invite, turn a channel off and on', async () => {
  const { env } = environment();
  const { body } = await invite(env);
  await record(env, 'channel:live1', { id: '5', login: 'live1', enabledAt: 2 }, Date.now() + 86400000);
  const owner = await signIn(env, OWNER);
  const post = data => worker.fetch(req('/api/dev/channels', 'POST', data, owner), env).then(r => r.json());
  const list = await (await worker.fetch(req('/api/dev/channels', 'GET', undefined, owner), env)).json();
  assert.deepEqual(list.builtin, ['nesszerra', 'miolafff']);
  assert.deepEqual(list.channels, [{ login: 'live1', enabledAt: 2, pausedAt: 0 }]);
  assert.equal((await post({ action: 'pause', login: 'live1' })).channels[0].pausedAt > 0, true);
  assert.equal((await worker.fetch(req('/api/state/live1'), env)).status, 403);
  assert.equal((await post({ action: 'resume', login: 'live1' })).channels[0].pausedAt, 0);
  assert.deepEqual((await post({ action: 'revoke', token: body.token })).invites, []);
  assert.equal((await (await worker.fetch(req('/api/invite/' + body.token), env)).json()).status, 'invalid');
  // a channel that is already set up can't be invited again
  assert.equal((await invite(env, 'live1')).r.status, 409);
});

test('connect=mods: only the broadcaster can store the mod-list permission later', async (t) => {
  const { env } = environment();
  await record(env, 'channel:newstreamer', { id: '55', login: 'newstreamer', enabledAt: 1 }, Date.now() + 86400000);
  let { r, state } = await login(env, 'channel=newstreamer&connect=mods');
  assert.equal(new URL(r.headers.get('Location')).searchParams.get('scope'), 'moderation:read');
  twitch(t, { id: '9', login: 'viewer', displayName: 'viewer' }, ['moderation:read']);
  assert.equal((await callback(env, state)).headers.get('Location'), '/admin/?channel=newstreamer&mods=wrong_account#chat');
  assert.equal(await record(env, 'broadcaster:newstreamer'), null);
  t.mock.restoreAll();
  ({ state } = await login(env, 'channel=newstreamer&connect=mods'));
  twitch(t, STREAMER, ['moderation:read']);
  assert.equal((await callback(env, state)).headers.get('Location'), '/admin/?channel=newstreamer&signed_in=1&mods=connected#chat');
  assert.ok(await record(env, 'broadcaster:newstreamer'));
});
