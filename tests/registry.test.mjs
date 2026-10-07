// Channel registry, open sign-up through /start, mod access later, and turning a channel off (server/channels.js).
// AuthStore runs for real on node:sqlite; rooms are a fake that echoes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../server/worker.js';
import { AuthStore, digest, record } from '../server/auth.js';
import { forgetChannel, isFull, MAX_CHANNELS } from '../server/channels.js';
import { OFF_TEXT } from '../server/streamelements.js';

const ORIGIN = 'https://chat.miolaf.xyz';
function store() {
  const db = new DatabaseSync(':memory:');
  const ctx = { storage: { sql: { exec(q, ...p) { const rows = db.prepare(q).all(...p).map(r => ({ ...r })); return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } }, alarm: null, async getAlarm() { return this.alarm; }, async setAlarm(t) { this.alarm = t; } } };
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
    if (u.includes('/helix/videos')) return as.videos === 'fail' ? new Response('', { status: 503 }) : Response.json({ data: Array(as.videos ?? 1).fill({ id: 'v1' }) });
    return Response.json({ data: [{ id: as.id, login: as.login, display_name: as.displayName, created_at: as.createdAt ?? '2020-01-01T00:00:00Z', broadcaster_type: as.type ?? '' }] });
  });
}
async function login(env, query) {
  const r = await worker.fetch(req('/auth/login?' + query), env);
  return { r, state: r.status === 302 ? new URL(r.headers.get('Location')).searchParams.get('state') : '' };
}
const callback = (env, state, query = 'code=c') => worker.fetch(new Request(ORIGIN + '/auth/callback?' + query + '&state=' + state, { headers: { Cookie: 'mini_oauth=' + state } }), env);
test('AuthStore lists only the channel prefix; only channel rows may live for years', async () => {
  const { env } = environment();
  const list = key => env.AUTH.get().fetch('https://auth/list?key=' + encodeURIComponent(key), { headers: { 'X-Mini-Internal': env.INTERNAL_SECRET } });
  assert.equal((await list('session:')).status, 400);
  assert.equal((await list('broadcaster:')).status, 400);
  assert.equal((await list('invite:')).status, 400);
  await record(env, 'channel:abc', { login: 'abc' }, Date.now() + 10 * 365 * 86400000);
  await record(env, 'channelz', { login: 'not a row' }, Date.now() + 60000);
  await assert.rejects(record(env, 'session:x', {}, Date.now() + 200 * 86400000));
  assert.deepEqual(await (await list('channel:')).json(), [{ key: 'channel:abc', value: { login: 'abc' } }]);
});

test('sign-up: any streamer signs in with moderation:read and their own channel turns on', async (t) => {
  const { env, rooms } = environment();
  assert.equal((await worker.fetch(req('/api/state/newstreamer'), env)).status, 403, 'not on before sign-up');
  const { r, state } = await login(env, 'signup=1');
  assert.equal(r.status, 302);
  assert.equal(new URL(r.headers.get('Location')).searchParams.get('scope'), 'moderation:read');
  assert.equal(new URL(r.headers.get('Location')).searchParams.get('force_verify'), 'true', 'sign-up shows the account picker');
  twitch(t, STREAMER, ['moderation:read']);
  const done = await callback(env, state);
  assert.equal(done.status, 303);
  assert.equal(done.headers.get('Location'), '/admin/?channel=newstreamer&signed_in=1#chat');
  assert.match(done.headers.get('Set-Cookie'), /mini_session=[a-f0-9]{64}/);
  const channel = await record(env, 'channel:newstreamer');
  assert.deepEqual([channel.id, channel.login], ['55', 'newstreamer']);
  assert.ok(await record(env, 'broadcaster:newstreamer'), 'mods can be checked');
  assert.equal((await worker.fetch(req('/api/state/newstreamer'), env)).status, 200);
  assert.equal(rooms.at(-1).channel, 'newstreamer');
  // signing up again keeps the first record
  t.mock.restoreAll();
  const again = await login(env, 'signup=1');
  twitch(t, STREAMER, ['moderation:read']);
  assert.equal((await callback(env, again.state)).headers.get('Location'), '/admin/?channel=newstreamer&signed_in=1#chat');
  assert.equal((await record(env, 'channel:newstreamer')).enabledAt, channel.enabledAt);
});

test('a renamed Twitch name: the new holder of the login gets no say over the old channel and cannot sign up over it', async (t) => {
  const { env, auth } = environment();
  const { state } = await login(env, 'signup=1');
  twitch(t, STREAMER, ['moderation:read']);
  assert.equal((await callback(env, state)).status, 303);
  t.mock.restoreAll();
  const newcomer = { id: '77', login: 'newstreamer', displayName: 'newstreamer' };
  const cookie = await signIn(env, newcomer);
  twitch(t, newcomer, []);   // Helix: not a moderator of the old channel
  assert.deepEqual(await (await worker.fetch(req('/api/access/newstreamer', 'GET', undefined, cookie), env)).json(),
    { owner: false, moderator: false, canManage: false, reason: 'Current Twitch moderator role required' });
  assert.equal((await worker.fetch(req('/api/admin/newstreamer', 'POST', { action: 'pauseChannel' }, cookie), env)).status, 403);
  const again = await login(env, 'signup=1');
  assert.equal((await callback(env, again.state)).headers.get('Location'), '/start/?error=taken');
  assert.equal((await record(env, 'channel:newstreamer')).id, '55', 'the channel stays with the account that set it up');
  // the original account, still signed in under its id, keeps the channel
  assert.equal((await (await worker.fetch(req('/api/access/newstreamer', 'GET', undefined, await signIn(env, STREAMER)), env)).json()).broadcaster, true);
  // the cleanup alarm is set once, not pushed back by every write
  const first = auth.ctx.storage.alarm;
  assert.ok(first > Date.now());
  await new Promise((r) => setTimeout(r, 5));
  await record(env, 'session:x', { user: STREAMER }, Date.now() + 60000);
  assert.equal(auth.ctx.storage.alarm, first);
});

test('sign-up on a bot site also asks for channel:bot and comes back with bot=allowed only when it was granted', async (t) => {
  const { env } = environment();
  env.CHAT_BOT = '1'; env.BOT_LOGIN = 'pixfray';
  const { r, state } = await login(env, 'signup=1');
  assert.equal(new URL(r.headers.get('Location')).searchParams.get('scope'), 'moderation:read channel:bot');
  twitch(t, STREAMER, ['moderation:read', 'channel:bot']);
  assert.equal((await callback(env, state)).headers.get('Location'), '/admin/?channel=newstreamer&signed_in=1&bot=allowed#chat');
  t.mock.restoreAll();
  // Twitch handed back moderation:read alone: no bot flag, the page shows the Add the PixFray bot step
  const again = await login(env, 'signup=1');
  twitch(t, STREAMER, ['moderation:read']);
  assert.equal((await callback(env, again.state)).headers.get('Location'), '/admin/?channel=newstreamer&signed_in=1#chat');
  t.mock.restoreAll();
  const bare = await login(env, 'signup=1&mods=0');
  assert.equal(new URL(bare.r.headers.get('Location')).searchParams.get('scope'), '', 'mods=0 asks for neither');
});

test('sign-up without mod access (mods=0) asks for no scope and stores no broadcaster token', async (t) => {
  const { env } = environment();
  const { r, state } = await login(env, 'signup=1&mods=0');
  assert.equal(new URL(r.headers.get('Location')).searchParams.get('scope'), '');
  twitch(t, STREAMER, []);
  assert.equal((await callback(env, state)).status, 303);
  assert.ok(await record(env, 'channel:newstreamer'));
  assert.equal(await record(env, 'broadcaster:newstreamer'), null);
});

test('a cancelled consent goes back to /start with no channel and no session', async () => {
  const { env } = environment();
  const { state } = await login(env, 'signup=1');
  const denied = await callback(env, state, 'error=access_denied&error_description=x');
  assert.equal(denied.headers.get('Location'), '/start/?error=denied');
  assert.equal(denied.headers.get('Set-Cookie').includes('mini_session'), false);
  assert.equal(await record(env, 'channel:newstreamer'), null);
});

test('a built-in channel signing up stays built in', async (t) => {
  const { env } = environment();
  const { state } = await login(env, 'signup=1');
  twitch(t, { id: '2', login: 'miolafff', displayName: 'miolafff' }, ['moderation:read']);
  assert.equal((await callback(env, state)).headers.get('Location'), '/admin/?channel=miolafff&signed_in=1#chat');
  assert.equal(await record(env, 'channel:miolafff'), null);
});

test('sign-up: a Twitch account under 30 days old or that never streamed waits, off, for the owner to approve it', async (t) => {
  const { env } = environment();
  const young = { ...STREAMER, createdAt: new Date(Date.now() - 5 * 86400000).toISOString(), videos: 0 };
  const { state } = await login(env, 'signup=1');
  twitch(t, young, ['moderation:read']);
  const r = await callback(env, state);
  assert.equal(r.headers.get('Location'), '/start/?error=review');
  assert.equal(r.headers.get('Set-Cookie').includes('mini_session'), false);
  assert.equal(await record(env, 'broadcaster:newstreamer'), null, 'no mod access until approved');
  const rec = await record(env, 'channel:newstreamer');
  assert.deepEqual(rec.review.reasons, ['young', 'never_streamed']);
  assert.equal(rec.pausedBy, 'owner');
  assert.equal((await worker.fetch(req('/api/state/newstreamer'), env)).status, 403, 'off while it waits');
  // signing in again still waits, even once the account would pass
  t.mock.restoreAll();
  const again = await login(env, 'signup=1');
  twitch(t, STREAMER, ['moderation:read']);
  assert.equal((await callback(env, again.state)).headers.get('Location'), '/start/?error=review');
  // the owner sees why on the owner page and turns it on, which approves it
  const owner = await signIn(env, OWNER);
  const list = await (await worker.fetch(req('/api/dev/channels', 'GET', undefined, owner), env)).json();
  assert.deepEqual(list.channels.find((c) => c.login === 'newstreamer').review.reasons, ['young', 'never_streamed']);
  assert.equal((await worker.fetch(req('/api/dev/channels', 'POST', { action: 'resume', login: 'newstreamer' }, owner), env)).status, 200);
  const approved = await record(env, 'channel:newstreamer');
  assert.equal(approved.review, undefined);
  assert.equal(approved.pausedAt, undefined);
  t.mock.restoreAll();
  const later = await login(env, 'signup=1');
  twitch(t, STREAMER, ['moderation:read']);
  assert.equal((await callback(env, later.state)).headers.get('Location'), '/admin/?channel=newstreamer&signed_in=1#chat');
});

test('the streamer check: Affiliates and Partners skip the past-broadcast lookup; a failed lookup goes to review', async () => {
  const { reviewReasons } = await import('../server/channels.js');
  const now = Date.parse('2026-10-07T00:00:00Z'), old = '2025-01-01T00:00:00Z';
  const never = () => { throw new Error('not asked'); };
  assert.deepEqual(await reviewReasons({ id: '5', created_at: old, broadcaster_type: 'affiliate' }, never, now), []);
  assert.deepEqual(await reviewReasons({ id: '5', created_at: old, broadcaster_type: 'partner' }, never, now), []);
  assert.deepEqual(await reviewReasons({ id: '5', created_at: old, broadcaster_type: '' }, async () => ({ data: [{}] }), now), []);
  assert.deepEqual(await reviewReasons({ id: '5', created_at: old, broadcaster_type: '' }, async () => ({ data: [] }), now), ['never_streamed']);
  assert.deepEqual(await reviewReasons({ id: '5', created_at: old, broadcaster_type: '' }, async () => { throw new Error('503'); }, now), ['unchecked']);
  assert.deepEqual(await reviewReasons({ id: '5', created_at: '2026-09-20T00:00:00Z', broadcaster_type: 'affiliate' }, never, now), ['young']);
  assert.deepEqual(await reviewReasons({ id: '5', broadcaster_type: 'partner' }, never, now), ['young'], 'no creation date counts as young');
});

test(`the registry is capped at ${MAX_CHANNELS} channels that are on`, async (t) => {
  const { env } = environment();
  for (let i = 0; i < MAX_CHANNELS; i++) await record(env, 'channel:filler' + i, { id: String(1000 + i), login: 'filler' + i, enabledAt: 1 }, Date.now() + 86400000);
  const { state } = await login(env, 'signup=1');
  twitch(t, STREAMER, ['moderation:read']);
  const full = await callback(env, state);
  assert.equal(full.headers.get('Location'), '/start/?error=full');
  assert.equal(full.headers.get('Set-Cookie').includes('mini_session'), false);
  assert.equal(await record(env, 'channel:newstreamer'), null);
  assert.equal(await isFull(env), true, 'the /play/ search stops inviting (picker full)');
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
  assert.deepEqual(await off.json(), { error: 'PixFray is off on this channel right now', off: 'paused' });
  assert.equal((await worker.fetch(req('/api/looks/newstreamer?u=a'), env)).status, 403);
  assert.equal(await (await worker.fetch(req('/api/se/newstreamer/help?k=' + 'a1'.repeat(24)), env)).text(), OFF_TEXT);
  assert.equal((await worker.fetch(req('/api/leaderboard/newstreamer'), env)).status, 200);
  assert.equal((await worker.fetch(req('/api/shop/newstreamer'), env)).status, 200, 'the shop list stays readable');
  assert.equal((await worker.fetch(req('/api/shop/newstreamer', 'POST', { kind: 'pet', id: 'fox' }, viewer), env)).status, 403, 'buying is closed');
  assert.notEqual((await worker.fetch(req('/api/profile/newstreamer', 'GET', undefined, viewer), env)).status, 403, 'the saved fighter stays readable');
  assert.equal((await worker.fetch(req('/api/profile/newstreamer', 'POST', { avatar: 'player' }, viewer), env)).status, 403, 'saving is closed');
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
  assert.deepEqual(await (await worker.fetch(req('/api/state/nobodyhere'), env)).json(), { error: 'PixFray is not enabled for this channel', off: 'not_enabled' });
  assert.equal((await worker.fetch(req('/api/se/nobodyhere/help?k=' + 'a1'.repeat(24)), env)).status, 404);
  assert.equal((await login(env, 'channel=nobodyhere')).r.status, 403);
});

test("owner Channels box: list, turn a channel off and on; the owner's off sticks", async () => {
  const { env } = environment();
  await record(env, 'channel:live1', { id: '5', login: 'live1', enabledAt: 2 }, Date.now() + 86400000);
  const owner = await signIn(env, OWNER), streamer = await signIn(env, { id: '5', login: 'live1', displayName: 'live1' });
  const post = data => worker.fetch(req('/api/dev/channels', 'POST', data, owner), env).then(r => r.json());
  const list = await (await worker.fetch(req('/api/dev/channels', 'GET', undefined, owner), env)).json();
  assert.deepEqual(list.builtin, ['nesszerra', 'miolafff']);
  assert.deepEqual(list.channels, [{ login: 'live1', enabledAt: 2, pausedAt: 0, pausedBy: '' }]);
  assert.equal('invites' in list, false);
  const off = await post({ action: 'pause', login: 'live1' });
  assert.deepEqual([off.channels[0].pausedAt > 0, off.channels[0].pausedBy], [true, 'owner']);
  assert.equal((await worker.fetch(req('/api/state/live1'), env)).status, 403);
  // the streamer can't undo the owner's off
  const refused = await worker.fetch(req('/api/admin/live1', 'POST', { action: 'resumeChannel' }, streamer), env);
  assert.equal(refused.status, 403);
  const refusedBody = await refused.json();
  assert.match(refusedBody.error, /site owner turned PixFray off/);
  assert.equal(refusedBody.reason, 'owner_off');
  assert.equal((await post({ action: 'resume', login: 'live1' })).channels[0].pausedAt, 0);
  assert.equal((await worker.fetch(req('/api/state/live1'), env)).status, 200);
  assert.equal((await post({ action: 'invite', login: 'someone' })).reason, 'unknown_action');
  assert.equal((await worker.fetch(req('/api/invite/' + 'f'.repeat(32)), env)).status, 404, 'the invite lookup is gone');
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
