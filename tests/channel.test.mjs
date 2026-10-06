// ChannelRoom and AuthStore against real SQLite (node:sqlite) behind a minimal fake DO context.
// Run with: node --import ./tests/register.mjs --test tests/channel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ChannelRoom } from '../server/channel.js';
import { AuthStore } from '../server/auth.js';
import { logRoomError } from '../server/developer.js';
import { createInitialState, defaultConfig } from '../server/game.js';
import { makePng, b64 } from './upload-helpers.mjs';
import { effectiveStats } from '../server/upgrades.js';
import { tierBoost, petOf, PETS, boostText } from '../server/pets.js';

const SECRET = 'test-only-internal-secret-0123456789';

function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sockets = [];
  let depth = 0;
  const storage = {
    sql: { exec(query, ...params) { const rows = db.prepare(query).all(...params).map((r) => ({ ...r })); return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } },
    transactionSync(fn) {
      if (depth) return fn();
      depth++; db.exec('BEGIN');
      try { const v = fn(); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { depth--; }
    },
    alarm: null,
    async setAlarm(t) { this.alarm = t; }, async getAlarm() { return this.alarm ?? null; },
    async deleteAlarm() { this.alarm = null; },
  };
  return {
    storage,
    acceptWebSocket(ws, tags) { ws.tags = tags; sockets.push(ws); },
    getWebSockets(tag) { return sockets.filter((s) => s.tags.includes(tag) && s.readyState === 1); },
    sockets,
  };
}
function fakeSocket(attachment, tag) {
  return { tags: [tag], readyState: 1, sent: [], closed: null, att: attachment,
    send(m) { this.sent.push(JSON.parse(m)); }, close(code, reason) { this.closed = [code, reason]; this.readyState = 3; },
    serializeAttachment(a) { this.att = a; }, deserializeAttachment() { return this.att; } };
}
// HP-fight tests run with quick duels off; pass { quick: true } for the one-hit mode.
function room(env = {}, { quick = false } = {}) {
  const ctx = fakeCtx();
  const r = new ChannelRoom(ctx, { INTERNAL_SECRET: SECRET, ...env });
  if (!quick) r.writeState({ ...createInitialState('nesszerra'), config: { ...defaultConfig(), quickDuel: false } });
  r.call = async (path, { method = 'GET', body, userId, secret = SECRET } = {}) => {
    const headers = { 'X-Mini-Internal': secret, 'X-Mini-Channel': 'nesszerra' };
    if (userId) headers['X-Mini-User-Id'] = userId;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await r.fetch(new Request('https://room' + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
  r.save = (id, login, extra = {}) => r.call('/profile', { method: 'POST', userId: id, body: { userId: id, username: login, displayName: login, avatar: 'player', color: '#123456', defaultAbility: 'strike', ...extra } });
  // Chat arrives as verified EventSub messages that the Worker forwards to POST /eventsub.
  r.connectChat = (subscriptionId = 'sub-1', status = 'enabled') => r.call('/chat', { method: 'POST', body: { action: 'connected', subscriptionId, status, createdAt: Date.now() } });
  let n = 0;
  r.notify = (messageType, extra = {}) => r.call('/eventsub', { method: 'POST', body: { messageId: 'e' + (++n), messageType, subscriptionType: 'channel.chat.message', timestamp: Date.now(), subscription: { id: 'sub-1', status: 'enabled' }, event: null, ...extra } });
  r.chat = (id, login, text, { color = '#FF4500', ...extra } = {}) => r.notify('notification', { event: { broadcaster_user_login: 'nesszerra', chatter_user_id: id, chatter_user_login: login, chatter_user_name: login, message_id: 'm' + (n + 1), message: { text }, color }, ...extra });
  r.live = () => { const ws = fakeSocket({ kind: 'live', channel: 'nesszerra' }, 'live'); ctx.sockets.push(ws); return ws; };
  r.ctx = ctx;
  return r;
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

test('export: every table a copy needs, BLOBs as base64', async () => {
  const r = room();
  await r.save('u1', 'alice');
  r.ctx.storage.sql.exec("INSERT INTO custom_characters (id, meta, atlas, bytes, created_by, created_at) VALUES ('c-1', '{}', ?, 3, 'u1', 1)", new Uint8Array([1, 2, 255]));
  const { status, body } = await r.call('/export');
  assert.equal(status, 200);
  assert.equal(body.game_state[0].channel, 'nesszerra');
  assert.deepEqual(body.profiles.map((p) => p.username), ['alice']);
  assert.deepEqual(body.custom_characters[0].atlas, { $b64: 'AQL/' });
  for (const t of ['config_history', 'se_settings', 'builds', 'streams', 'custom_pets', 'owned_items']) assert.ok(Array.isArray(body[t]), t);
  assert.equal((await r.call('/export', { secret: 'wrong' })).status, 403);
});

test('room rejects calls without the internal secret', async () => {
  const r = room();
  assert.equal((await r.call('/state', { secret: 'wrong-wrong-wrong-wrong' })).status, 403);
});

test('profiles are saved server-side and identity must match the session user', async () => {
  const r = room();
  assert.equal((await r.call('/profile', { method: 'POST', userId: 'u1', body: { userId: 'u2', username: 'x', avatar: 'player', color: '#123456', defaultAbility: 'heal' } })).status, 403);
  const saved = await r.save('u1', 'alice', { defaultAbility: 'heavy' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.profile.defaultAbility, 'heavy');
  const got = await r.call('/profile?userId=u1');
  assert.equal(got.body.username, 'alice');
  assert.equal(got.body.elo, 1000);
  assert.equal((await r.call('/profile?userId=nobody')).body, null);
});

test('a renamed Twitch login can be reused by another account', async () => {
  const r = room();
  await r.save('u1', 'alice');
  assert.equal((await r.save('u2', 'alice')).status, 200);
  assert.equal((await r.call('/profile?userId=u2')).body.username, 'alice');
});

test('chat commands run a full duel; Elo persists to the leaderboard; overlays get snapshots', async () => {
  const r = room();
  await r.save('u1', 'alice');
  await r.save('u2', 'bob');
  const live = r.live();
  assert.equal((await r.connectChat()).body.chatStatus.connected, true);
  assert.equal((await r.chat('u1', 'alice', '!challenge @bob')).body.ok, true);
  const accepted = await r.chat('u2', 'bob', '!accept');
  assert.deepEqual([accepted.status, accepted.body.ok], [200, true]);
  for (let i = 0; i < 4; i++) {
    await r.chat('u1', 'alice', '!heavy');
    // The first heavy succeeds; later ones hit the 5 s cooldown. Force the cooldown clear for the test.
    const s = r.readState('nesszerra');
    const duel = s.duels.find((d) => d.status === 'active');
    if (!duel) break;
    duel.cooldowns.u1 = { sharedUntil: 0, strikeUntil: 0, heavyUntil: 0, healUntil: 0 };
    r.writeState(s);
  }
  const state = (await r.call('/state')).body;
  assert.equal(state.duels[0].status, 'completed');
  assert.equal(state.duels[0].winnerId, 'u1');
  assert.equal(state.round, 1);
  assert.equal(state.chat.connected, true);
  assert.ok(state.chat.lastSeen > 0, 'last notification time is recorded');
  const board = (await r.call('/leaderboard')).body;
  assert.deepEqual(board.map((p) => [p.username, p.elo, p.wins, p.losses]), [['alice', 1012, 1, 0], ['bob', 988, 0, 1]]);
  assert.equal(board.some((p) => 'dollars' in p), false, 'dollars stay off the public leaderboard');
  assert.ok((await r.call('/leaderboard?private=1')).body.every((p) => Number.isInteger(p.dollars)), 'mods see them');
  assert.ok(live.sent.length > 3);
  assert.equal(live.sent.at(-1).type, 'snapshot');
  assert.equal(live.sent.at(-1).revision, state.revision);
  assert.equal('appliedMessageIds' in live.sent.at(-1), false, 'internal bookkeeping is not broadcast');
  assert.equal('relay' in live.sent.at(-1), false);
});

test('chat bots like StreamElements never join the arena', async () => {
  const r = room();
  await r.connectChat();
  assert.equal((await r.chat('b1', 'streamelements', 'Thank you for following!')).body.reason, 'chat_bot');
  assert.equal((await r.chat('b2', 'nightbot', '!challenge @alice')).body.reason, 'chat_bot');
  assert.equal((await r.chat('b3', 'pixfray', 'Fight on: alice vs bob!')).body.reason, 'chat_bot');
  assert.equal(r.readState('nesszerra').players.length, 0);
});

test('unregistered chatters appear in their Twitch color but cannot duel; rejections are logged', async () => {
  const r = room();
  await r.save('u1', 'alice');
  await r.connectChat();
  assert.equal((await r.chat('g1', 'guest', 'hello chat', { color: '#1e90ff' })).body.reason, 'presence_updated');
  let state = r.readState('nesszerra');
  assert.equal(state.players.find((p) => p.userId === 'g1').color, '#1E90FF');
  const rejected = await r.chat('g1', 'guest', '!challenge @alice');
  assert.deepEqual([rejected.body.ok, rejected.body.reason], [false, 'ranked_sign_in_required']);
  state = r.readState('nesszerra');
  assert.deepEqual(state.events.at(-1), { id: String(state.revision), type: 'command_rejected', at: state.events.at(-1).at, userId: 'g1', command: 'duel', reason: 'ranked_sign_in_required' });
  // registered players keep their saved color, whatever Twitch says
  await r.chat('u1', 'alice', 'hi', { color: '#00FF00' });
  assert.equal(r.readState('nesszerra').players.find((p) => p.userId === 'u1').color, '#123456');
});

test('plain chat refreshes presence at most every 30 s', async () => {
  const r = room();
  await r.connectChat();
  await r.chat('g1', 'guest', 'one');
  const rev = r.readState('nesszerra').revision;
  assert.equal((await r.chat('g1', 'guest', 'two')).body.reason, 'presence_fresh');
  assert.equal(r.readState('nesszerra').revision, rev, 'no event and no broadcast');
});

test('replayed EventSub messages are ignored; other subscriptions and offline chat are refused', async () => {
  const r = room();
  await r.save('u1', 'alice');
  await r.save('u2', 'bob');
  const body = (messageId, subscriptionId = 'sub-1') => ({ method: 'POST', body: { messageId, messageType: 'notification', subscriptionType: 'channel.chat.message', timestamp: Date.now(), subscription: { id: subscriptionId, status: 'enabled' },
    event: { broadcaster_user_login: 'nesszerra', chatter_user_id: 'u1', chatter_user_login: 'alice', chatter_user_name: 'alice', message_id: 'chat-' + messageId, message: { text: '!challenge @bob' } } } });
  assert.equal((await r.call('/eventsub', body('x0'))).body.reason, 'unknown_subscription', 'nothing is processed before Connect chat');
  await r.connectChat();
  assert.equal((await r.call('/eventsub', body('x1'))).body.ok, true);
  const rev = r.readState('nesszerra').revision;
  assert.deepEqual((await r.call('/eventsub', body('x1'))).body, { ok: true, duplicate: true });
  assert.equal(r.readState('nesszerra').revision, rev);
  assert.equal(r.readState('nesszerra').duels.length, 1);
  assert.equal((await r.call('/eventsub', body('x2', 'sub-stale'))).body.reason, 'unknown_subscription');
});

test('webhook verification connects chat in either order; revocation records the reason', async () => {
  const r = room();
  // verification first, then the create response
  await r.notify('webhook_callback_verification', { subscription: { id: 'sub-1', status: 'webhook_callback_verification_pending' } });
  assert.equal((await r.call('/state')).body.chat.connected, false);
  assert.equal((await r.connectChat('sub-1', 'webhook_callback_verification_pending')).body.chatStatus.connected, true);
  // a revocation for another subscription is ignored
  assert.equal((await r.notify('revocation', { subscription: { id: 'sub-old', status: 'authorization_revoked' } })).body.ignored, true);
  await r.save('u1', 'alice');
  await r.save('u2', 'bob');
  await r.chat('u1', 'alice', '!challenge @bob');
  await r.chat('u2', 'bob', '!accept');
  await r.notify('revocation', { subscription: { id: 'sub-1', status: 'authorization_revoked' } });
  const state = (await r.call('/state')).body;
  assert.equal(state.paused, true);
  assert.equal(state.duels[0].cancelReason, 'chat_disconnected');
  const admin = (await r.call('/admin')).body;
  assert.equal(admin.chatStatus.connected, false);
  assert.equal(admin.chatStatus.lastRevocationReason, 'authorization_revoked');
  // create response first, then verification
  await r.connectChat('sub-2', 'webhook_callback_verification_pending');
  assert.equal((await r.call('/chat')).body.connected, false);
  await r.notify('webhook_callback_verification', { subscription: { id: 'sub-2', status: 'webhook_callback_verification_pending' } });
  assert.deepEqual([(await r.call('/chat')).body.connected, (await r.call('/chat')).body.status], [true, 'enabled']);
});

test('chat disconnect cancels open duels without scoring', async () => {
  const r = room();
  await r.save('u1', 'alice');
  await r.save('u2', 'bob');
  await r.connectChat();
  await r.chat('u1', 'alice', '!challenge @bob');
  await r.chat('u2', 'bob', '!accept');
  await r.chat('u1', 'alice', '!strike');
  const off = await r.call('/chat', { method: 'POST', body: { action: 'disconnected', reason: 'disconnected' } });
  assert.equal(off.body.reason, 'chat_disconnected');
  const state = (await r.call('/state')).body;
  assert.equal(state.duels[0].status, 'cancelled');
  assert.equal(state.duels[0].cancelReason, 'chat_disconnected');
  assert.equal(state.paused, true);
  assert.equal(state.events.at(-1).type, 'chat_disconnected');
  const board = (await r.call('/leaderboard')).body;
  assert.ok(board.every((p) => p.elo === 1000 && p.wins === 0 && p.losses === 0));
  assert.equal((await r.chat('u1', 'alice', '!challenge @bob')).body.reason, 'unknown_subscription');
});

test('the hourly alarm re-checks the Helix subscription and disconnects only on a definite answer', async (t) => {
  const store = new AuthStore(fakeCtx(), { INTERNAL_SECRET: SECRET });
  const AUTH = { idFromName: () => 'auth', get: () => ({ fetch: (url, init) => store.fetch(new Request(url, init)) }) };
  const r = room({ AUTH, AUTH_SECRET: 'a'.repeat(64), TWITCH_CLIENT_ID: 'client-id', TWITCH_CLIENT_SECRET: 'client-secret' });
  let helix = () => Response.json({ data: [{ id: 'sub-1', status: 'enabled' }], pagination: {} });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://id.twitch.tv/oauth2/token')) return Response.json({ access_token: 'app-token', expires_in: 3600 });
    return helix();
  });
  await r.connectChat();
  assert.ok(r.ctx.storage.alarm <= Date.now() + 3_600_000 + 50, 'the check is scheduled at most an hour out');
  await r.alarm();
  assert.equal(calls.length, 0, 'not due yet: no Helix call');
  const age = () => { const s = r.readState('nesszerra'); s.chat.checkedAt = Date.now() - 3_600_001; r.writeState(s); };
  age(); await r.alarm();
  assert.equal(calls.filter((u) => u.includes('/helix/eventsub/subscriptions')).length, 1);
  assert.equal((await r.call('/chat')).body.connected, true);
  helix = () => new Response('down', { status: 503 });
  age(); await r.alarm();
  assert.equal((await r.call('/chat')).body.connected, true, 'a failed check changes nothing');
  helix = () => Response.json({ data: [], pagination: {} });
  age(); await r.alarm();
  const status = (await r.call('/chat')).body;
  assert.deepEqual([status.connected, status.lastRevocationReason], [false, 'subscription_missing']);
  assert.equal(calls.filter((u) => u.startsWith('https://id.twitch.tv')).length, 1, 'the app token is cached sealed in AuthStore');
});

test('a subscription stuck awaiting verification is re-checked within minutes and a failed verification is recorded', async (t) => {
  const store = new AuthStore(fakeCtx(), { INTERNAL_SECRET: SECRET });
  const AUTH = { idFromName: () => 'auth', get: () => ({ fetch: (url, init) => store.fetch(new Request(url, init)) }) };
  const r = room({ AUTH, AUTH_SECRET: 'a'.repeat(64), TWITCH_CLIENT_ID: 'client-id', TWITCH_CLIENT_SECRET: 'client-secret' });
  let status = 'webhook_callback_verification_pending';
  t.mock.method(globalThis, 'fetch', async (url) => String(url).startsWith('https://id.twitch.tv') ? Response.json({ access_token: 'app-token', expires_in: 3600 }) : Response.json({ data: [{ id: 'sub-1', status }], pagination: {} }));
  await r.connectChat('sub-1', 'webhook_callback_verification_pending');
  assert.ok(r.ctx.storage.alarm <= Date.now() + 5 * 60_000, 'a pending subscription is checked within minutes, not an hour');
  const age = () => { const s = r.readState('nesszerra'); s.chat.checkedAt = Date.now() - 3 * 60_000 - 1; r.writeState(s); };
  age(); await r.alarm();
  let chat = (await r.call('/chat')).body;
  assert.deepEqual([chat.connected, chat.subscriptionId], [false, 'sub-1'], 'still pending: unchanged');
  assert.ok(r.ctx.storage.alarm > Date.now() + 60_000, 'the next pending check waits another interval');
  status = 'webhook_callback_verification_failed';
  age(); await r.alarm();
  chat = (await r.call('/chat')).body;
  assert.deepEqual([chat.connected, chat.subscriptionId, chat.lastRevocationReason], [false, '', 'webhook_callback_verification_failed']);
  assert.equal(r.ctx.storage.alarm, null, 'no further checks once disconnected');
  // a pending subscription that Twitch reports enabled (verification message lost) becomes connected
  await r.connectChat('sub-1', 'webhook_callback_verification_pending');
  status = 'enabled';
  age(); await r.alarm();
  assert.equal((await r.call('/chat')).body.connected, true);
});

test('versioned config editor: history, optimistic version check, rollback', async () => {
  const r = room();
  const a = await r.call('/admin', { method: 'POST', body: { actorId: 'mod1', actorName: 'ModOne', action: 'config', payload: { baseVersion: 1, patch: { abilities: { heavy: { damage: 30 } } }, note: 'buff heavy' } } });
  assert.equal(a.status, 200);
  assert.equal(a.body.configVersion, 2);
  const conflict = await r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'config', payload: { baseVersion: 1, patch: { maxHp: 150 } } } });
  assert.equal(conflict.status, 409);
  const bad = await r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'config', payload: { patch: { maxHp: -1 } } } });
  assert.equal(bad.status, 400);
  const view = (await r.call('/admin')).body;
  assert.deepEqual(view.history.map((h) => [h.version, h.actorId, h.note]), [[2, 'mod1', 'buff heavy'], [1, 'system', 'initial']]);
  assert.equal(view.history[0].config.abilities.heavy.damage, 30);
  assert.equal(view.history[0].actorName, 'ModOne', 'history keeps the actor display name');
  assert.deepEqual(view.customUsage, { count: 0, limit: 24, bytes: 0 });
  const rb = await r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'rollbackConfig', payload: { version: 1 } } });
  assert.equal(rb.status, 200);
  assert.equal(rb.body.configVersion, 3);
  const after = (await r.call('/admin')).body;
  assert.equal(after.config.abilities.heavy.damage, 35);
  assert.equal(after.history[0].note, 'rollback to v1');
  assert.equal((await r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'rollbackConfig', payload: { version: 99 } } })).status, 404);
  // A version saved before a setting existed (here: the Stage 4 prices) restores that setting's default.
  const old = JSON.parse(r.ctx.storage.sql.exec('SELECT config FROM config_history WHERE version = 1').toArray()[0].config);
  delete old.trailPrice; delete old.buildSlotPrice;
  r.ctx.storage.sql.exec('UPDATE config_history SET config = ? WHERE version = 1', JSON.stringify(old));
  const cheap = await r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'config', payload: { baseVersion: 3, patch: { trailPrice: 7, buildSlotPrice: 11 } } } });
  assert.equal(cheap.status, 200);
  assert.equal((await r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'rollbackConfig', payload: { version: 1 } } })).status, 200);
  const restored = (await r.call('/admin')).body.config;
  assert.equal(restored.trailPrice, 40, 'a setting missing from the old version goes back to its default');
  assert.equal(restored.buildSlotPrice, 60);
});

test('rank reset reaches stored profiles; removePlayer deletes the profile', async () => {
  const r = room();
  await r.save('u1', 'alice');
  r.ctx.storage.sql.exec('UPDATE profiles SET elo = 1300, wins = 9 WHERE user_id = ?', 'u1');
  await r.save('u2', 'bob');
  const res = await r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'resetRank', payload: { userId: 'u1' } } });
  assert.equal(res.status, 200);
  assert.equal((await r.call('/profile?userId=u1')).body.elo, 1000);
  const rm = await r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'removePlayer', payload: { userId: 'u2' } } });
  assert.equal(rm.status, 200);
  assert.equal((await r.call('/profile?userId=u2')).body, null);
  assert.equal((await r.call('/admin', { method: 'POST', body: { action: 'resetAll' } })).status, 403);
});

test('catalog, assets and dev routes answer inside the room; uploads validate', async () => {
  const r = room();
  assert.deepEqual((await r.call('/catalog')).body, []);
  assert.equal((await r.call('/asset/c-missing')).status, 404);
  assert.equal((await r.call('/asset')).body.usage.limit, 24);
  const bad = await r.call('/asset', { method: 'POST', body: {} });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.reason, 'invalid_label');
  const diag = (await r.call('/dev/diagnostics')).body;
  assert.equal(diag.channel, 'nesszerra');
  assert.deepEqual(diag.chatStatus, { connected: false, source: '', status: 'disconnected', subscriptionId: '', createdAt: 0, lastNotificationAt: 0, lastRevocationReason: '', checkedAt: 0 });
  assert.deepEqual(diag.sockets, { live: 0 });
  logRoomError(r, new Error('boom'), { path: '/x' });
  const logs = (await r.call('/dev/logs')).body;
  assert.equal(logs[0].message, 'boom');
});

test('AuthStore consume returns a value exactly once', async () => {
  const ctx = fakeCtx();
  const store = new AuthStore(ctx, { INTERNAL_SECRET: SECRET });
  const call = (path, method, body) => store.fetch(new Request('https://auth' + path, { method, headers: { 'X-Mini-Internal': SECRET, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })).then((x) => x.json());
  await call('/entry?key=pair:abc', 'POST', { value: { channel: 'nesszerra' }, expires: Date.now() + 60_000 });
  const results = await Promise.all([call('/consume?key=pair:abc', 'POST'), call('/consume?key=pair:abc', 'POST')]);
  assert.deepEqual(results.filter(Boolean), [{ channel: 'nesszerra' }]);
  await call('/entry?key=pair:old', 'POST', { value: { channel: 'nesszerra' }, expires: Date.now() + 5 });
  await sleep(10);
  assert.equal(await call('/consume?key=pair:old', 'POST'), null);
  assert.equal(await call('/entry?key=pair:old', 'GET'), null, 'expired code is gone after consume');
});

test('StreamElements commands run a duel with chat replies; the key and command names are enforced', async () => {
  const r = room();
  const admin = async () => (await r.call('/admin')).body;
  const se = (await admin()).streamelements;
  assert.match(se.secret, /^[0-9a-f]{48}$/);
  assert.equal(se.names.accept, '!fight');
  let m = 0;
  const cmd = (id, login, action, target = '', key = se.secret) => r.call('/se?origin=https%3A%2F%2Ftest.example', { method: 'POST', body: { key, action, userId: id, username: login, displayName: login, target, messageId: 'se' + (++m) } });
  assert.deepEqual([se.lastCommandAt, se.rejectedAt], [0, 0], 'no command has reached the room yet');
  assert.equal((await cmd('u1', 'alice', 'challenge', 'bob', 'wrong')).status, 403);
  assert.deepEqual([(await admin()).streamelements.lastCommandAt, (await admin()).streamelements.rejectedAt > 0], [0, true], 'a wrong key is recorded');
  assert.equal(se.duelModuleOff, false);
  assert.deepEqual(se.seen, {});
  // The first command with the right key makes StreamElements the chat source. A sign-in refusal names who is missing a fighter.
  const first = (await cmd('u1', 'alice', 'challenge', 'bob')).body;
  assert.deepEqual(first, { reply: '@alice, you have no fighter in the arena yet! Gear up at https://test.example/?channel=nesszerra' }, 'no Twitch subscription to drop');
  assert.equal((await admin()).chatStatus.source, 'streamelements');
  assert.ok((await admin()).streamelements.lastCommandAt > 0, 'a command with the right key is recorded');
  assert.deepEqual(Object.keys((await admin()).streamelements.seen), ['challenge'], 'each command is marked as seen');
  await r.save('u1', 'alice');
  assert.equal((await cmd('u1', 'alice', 'challenge', 'bob')).body.reply, '@bob has no fighter in the arena yet! Send them to https://test.example/?channel=nesszerra');
  await r.save('u2', 'bob');
  assert.equal((await cmd('u1', 'alice', 'challenge')).body.reply, 'Challenge who? Name your rival: !challenge @name');
  assert.equal((await cmd('u1', 'alice', 'challenge', 'alice')).body.reply, "alice, you can't fight your own shadow! Name a rival: !challenge @name");
  assert.equal((await cmd('u1', 'alice', 'challenge', 'bob')).body.reply, 'alice challenges @bob! @bob, type !fight to fight or !decline to back out within 30 s.');
  // Quick duels are off in this room, but StreamElements has no attack commands, so !fight settles the duel at once.
  assert.equal((await cmd('u2', 'bob', 'accept')).body.reply, 'Fight on: alice vs bob! Watch the stream for the winner.');
  assert.equal(r.readState('nesszerra').duels.filter((d) => d.status === 'active').length, 0);
  assert.equal((await cmd('u1', 'alice', 'heavy')).body.reply, 'Lost in the arena? Type !fray');
  // Renamed commands show up in replies; duplicates and bad names are refused.
  assert.equal((await r.call('/se-admin', { method: 'POST', body: { action: 'setSeNames', names: { accept: '!yes', decline: 'no' } } })).body.streamelements.names.decline, '!no');
  assert.equal((await r.call('/se-admin', { method: 'POST', body: { action: 'setSeNames', names: { accept: '!challenge' } } })).status, 400);
  assert.equal((await r.call('/se-admin', { method: 'POST', body: { action: 'setSeNames', names: { accept: 'bad name' } } })).status, 400);
  const rotated = (await r.call('/se-admin', { method: 'POST', body: { action: 'rotateSeKey' } })).body.streamelements;
  assert.notEqual(rotated.secret, se.secret);
  assert.deepEqual([rotated.lastCommandAt, rotated.rejectedAt, rotated.seen], [0, 0, {}], 'a new key starts unheard');
  assert.equal((await cmd('u1', 'alice', 'decline')).status, 403);
  // Disconnecting the StreamElements source never calls Twitch and pauses duels.
  await r.call('/chat', { method: 'POST', body: { action: 'disconnected', reason: 'disconnected' } });
  assert.match((await cmd('u1', 'alice', 'decline', '', rotated.secret)).body.reply, /arena is closed/);
});

test('the first StreamElements command moves a Twitch-chat channel over, but not one a mod turned off; seen times are throttled', async () => {
  const r = room({}, { quick: true });
  const admin = async () => (await r.call('/admin')).body;
  const se = (await admin()).streamelements;
  let m = 0;
  const cmd = (action) => r.call('/se?origin=https%3A%2F%2Ftest.example', { method: 'POST', body: { key: se.secret, action, userId: 'u1', username: 'alice', displayName: 'alice', target: '', messageId: 'se' + (++m) } });
  await r.connectChat('sub-1');
  await r.save('u1', 'alice');
  const first = (await cmd('decline')).body;
  assert.equal(first.switchedFrom, 'sub-1', 'the Worker deletes the old EventSub subscription');
  assert.match(first.reply, /nobody has challenged you/);
  assert.equal((await admin()).chatStatus.source, 'streamelements');
  assert.equal((await cmd('decline')).body.switchedFrom, undefined, 'only the switch reports it');
  const seenAt = (await admin()).streamelements.seen.decline;
  await sleep(5);
  await cmd('decline');
  assert.equal((await admin()).streamelements.seen.decline, seenAt, 'written at most once a minute per command');
  await cmd('help');
  assert.deepEqual(Object.keys((await admin()).streamelements.seen).sort(), ['decline', 'help']);
  // Disconnect chat on purpose: commands don't turn it back on; Use StreamElements does.
  await r.call('/chat', { method: 'POST', body: { action: 'disconnected', reason: 'disconnected' } });
  assert.match((await cmd('decline')).body.reply, /arena is closed/);
  assert.equal((await admin()).chatStatus.connected, false);
  // The Duel-module tick is saved and survives a new key.
  assert.equal((await r.call('/se-admin', { method: 'POST', body: { action: 'setDuelModuleOff', value: true } })).body.streamelements.duelModuleOff, true);
  assert.equal((await r.call('/se-admin', { method: 'POST', body: { action: 'rotateSeKey' } })).body.streamelements.duelModuleOff, true);
  assert.equal((await r.call('/se-admin', { method: 'POST', body: { action: 'setDuelModuleOff', value: false } })).body.streamelements.duelModuleOff, false);
});

test('SE_ONLY: a StreamElements command with the right key makes StreamElements the chat source', async () => {
  const r = room({ SE_ONLY: '1' }, { quick: true });
  const se = (await r.call('/admin')).body.streamelements;
  await r.connectChat('sub-1');   // a Twitch subscription from before the switch
  const cmd = (key) => r.call('/se?origin=https%3A%2F%2Ftest.example', { method: 'POST', body: { key, action: 'decline', userId: 'u1', username: 'alice', displayName: 'alice', target: '', messageId: 'x' + key.length } });
  assert.equal((await cmd('wrong')).status, 403);
  assert.equal((await r.call('/admin')).body.chatStatus.source, 'twitch', 'a wrong key changes nothing');
  assert.doesNotMatch((await cmd(se.secret)).body.reply, /closed/);
  assert.equal((await r.call('/admin')).body.chatStatus.source, 'streamelements');
});

test('StreamElements quick duel: !fight settles it at once, but chat sees the result only after the stream shows it', async () => {
  const r = room({}, { quick: true });
  const se = (await r.call('/admin')).body.streamelements;
  await r.call('/chat', { method: 'POST', body: { action: 'connected', subscriptionId: 'se-streamelements', status: 'enabled', createdAt: Date.now() } });
  await r.save('u1', 'alice'); await r.save('u2', 'bob');
  let m = 0;
  const cmd = (id, login, action, target = '') => r.call('/se?origin=https%3A%2F%2Ftest.example', { method: 'POST', body: { key: se.secret, action, userId: id, username: login, displayName: login, target, messageId: 'q' + (++m) } });
  await cmd('u1', 'alice', 'challenge', 'bob');
  assert.equal((await cmd('u2', 'bob', 'accept')).body.reply, 'Fight on: alice vs bob! Watch the stream for the winner.');
  assert.equal((await cmd('u2', 'bob', 'accept')).body.reply, 'bob, nobody has challenged you yet. Start one: !challenge @name');
  // Until the overlay has played the duel (plus stream delay), every read shows the pre-fight numbers.
  const duel = r.readState('nesszerra').duels.find((d) => d.status === 'completed');
  assert.ok(duel.revealAt - Date.now() > 6000 && duel.revealAt - Date.now() < 40_000, 'revealed after the replay and the stream delay');
  const before = (await r.call('/leaderboard')).body;
  assert.deepEqual(before.map((p) => [p.elo, p.wins, p.losses]), [[1000, 0, 0], [1000, 0, 0]], 'leaderboard holds the result back');
  assert.equal((await cmd('u1', 'alice', 'elo')).body.reply, 'alice: 1000 Elo, rank 1 of 2, 0 wins and 0 losses.');
  assert.match((await cmd('u2', 'bob', 'top')).body.reply, /^Top 2: 1\. alice 1000 · 2\. bob 1000\./);
  assert.equal((await r.call('/profile?userId=u2')).body.wins, 0);
  assert.equal((await r.call('/looks?u=alice')).body.alice.elo, 1000);
  // The loser's knockout (hp 0, respawnAt) would name them, so public reads leave it out; so does a website save.
  assert.ok(before.every((p) => p.hp === 100 && !(p.respawnAt > Date.now())), 'leaderboard shows nobody knocked out');
  for (const id of ['u1', 'u2']) { const p = (await r.call('/profile?userId=' + id)).body; assert.ok(p.hp !== 0 && !(p.respawnAt > Date.now()), id); }
  assert.deepEqual((({ elo, wins, losses }) => [elo, wins, losses])((await r.save('u1', 'alice')).body.profile), [1000, 0, 0], 'a save answers with the shown numbers');
  // A third viewer challenging either fighter hears the same thing, so the reply can't tell the winner from the loser.
  await r.save('u3', 'cara');
  for (const target of ['alice', 'bob']) assert.equal((await cmd('u3', 'cara', 'challenge', target)).body.reply, 'That fight is still playing on stream. Give it a few seconds!');
  const realNow = Date.now;
  Date.now = () => duel.revealAt + 1;
  try {
    const after = (await r.call('/leaderboard')).body;
    assert.deepEqual([after[0].wins, after.at(-1).losses, after[0].elo > 1000, after.at(-1).elo < 1000], [1, 1, true, true], 'shown once the stream has shown it');
    assert.match((await cmd('u1', 'alice', 'elo')).body.reply, new RegExp(`^alice: ${after.find((p) => p.username === 'alice').elo} Elo, rank ${after.findIndex((p) => p.username === 'alice') + 1} of 3`));
  } finally { Date.now = realNow; }
  // The result is saved, so the next command (which reloads the stored profile) keeps it.
  const saved = Object.fromEntries(r.ctx.storage.sql.exec('SELECT user_id, elo, wins, losses FROM profiles').toArray().map((x) => [x.user_id, x]));
  assert.deepEqual([saved.u1.wins + saved.u2.wins, saved.u1.losses + saved.u2.losses, [2000, 2003].includes(saved.u1.elo + saved.u2.elo)], [1, 1, true]);   // +3 if flawless
  assert.notEqual(saved.u1.elo, 1000);
  // Every command lands in the dev log with what came in, the game's decision and the reply.
  const log = (await r.call('/dev/logs?source=command')).body;
  assert.deepEqual(log.map((x) => x.context.reason).reverse(), ['challenge', 'quick_duel', 'challenge_not_found', 'elo', 'top', 'result_hidden', 'result_hidden', 'elo']);
  const quick = log.find((x) => x.context.reason === 'quick_duel');
  assert.match(quick.context.swings, /^([1-6][hxcm] ?)+$/);
  assert.equal((await r.call('/dev/logs?source=warn')).body.length, 0);
  // A result that didn't reach the stored profile is flagged.
  const state = r.readState('nesszerra');
  state.players.find((p) => p.userId === 'u1').wins += 5;
  r.checkSavedProfiles(state, quick.context.duelId);
  assert.match((await r.call('/dev/logs?source=warn')).body[0].message, /profile for alice not saved/);
});

test('StreamElements !rematch challenges the last opponent, saved with the profile; two !rematch start the duel', async () => {
  const r = room({}, { quick: true });
  const se = (await r.call('/admin')).body.streamelements;
  await r.call('/chat', { method: 'POST', body: { action: 'connected', subscriptionId: 'se-streamelements', status: 'enabled', createdAt: Date.now() } });
  await r.save('u1', 'alice'); await r.save('u2', 'bob'); await r.save('u3', 'cara');
  let m = 0;
  const cmd = (id, login, action, target = '') => r.call('/se?origin=https%3A%2F%2Ftest.example', { method: 'POST', body: { key: se.secret, action, userId: id, username: login, displayName: login, target, messageId: 'r' + (++m) } });
  assert.equal((await cmd('u1', 'alice', 'rematch')).body.reply, 'alice, you have nobody to rematch yet. Start one: !challenge @name');
  await cmd('u1', 'alice', 'challenge', 'bob');
  assert.match((await cmd('u2', 'bob', 'accept')).body.reply, /^Fight on: alice vs bob!/);
  assert.deepEqual(r.ctx.storage.sql.exec('SELECT user_id, last_opponent FROM profiles ORDER BY user_id').toArray().map((x) => [x.user_id, x.last_opponent]), [['u1', 'u2'], ['u2', 'u1'], ['u3', '']]);
  assert.match((await cmd('u2', 'bob', 'rematch')).body.reply, /^Rematch in \d+ s! Catch your breath first\.$|^That fight is still playing on stream/);
  // A website save carries no opponent and must not clear it; the game state forgetting the players must not either.
  await r.save('u2', 'bob', { color: '#445566' });
  const s = r.readState('nesszerra'); s.players = []; s.rematchLocks = []; r.writeState(s);
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;   // past the respawn and the stream reveal
  try {
    assert.equal((await cmd('u2', 'bob', 'rematch', 'cara')).body.reply, 'bob wants a rematch with @alice! @alice, type !rematch or !fight to fight, or !decline to back out within 30 s.', 'a name after !rematch is ignored');
    assert.equal((await cmd('u3', 'cara', 'challenge', 'alice')).body.reply, 'One of you is already fighting! Wait for the bell, then try again.');
    assert.equal((await cmd('u1', 'alice', 'rematch')).body.reply, 'Fight on: bob vs alice! Watch the stream for the winner.', 'answering !rematch with !rematch starts it');
  } finally { Date.now = realNow; }
  const reasons = (await r.call('/dev/logs?source=command')).body.map((x) => x.context.reason).reverse();
  assert.deepEqual([...reasons.slice(0, 3), ...reasons.slice(4)], ['no_previous_opponent', 'challenge', 'quick_duel', 'rematch', 'player_busy', 'quick_duel']);
  assert.match(reasons[3], /^(rematch_cooldown|respawning)$/);
});


test('StreamElements !ranks, !elo, !fray and !look work even while duels are paused', async () => {
  const r = room();
  const se = (await r.call('/admin')).body.streamelements;
  assert.deepEqual([se.names.top, se.names.elo, se.names.help, se.names.look], ['!ranks', '!elo', '!fray', '!look']);
  let m = 0;
  const cmd = (id, login, action, target = '') => r.call('/se?origin=https%3A%2F%2Ftest.example', { method: 'POST', body: { key: se.secret, action, userId: id, username: login, displayName: login, target, messageId: 't' + (++m) } });
  assert.equal((await cmd('u1', 'alice', 'help')).body.reply, 'PixFray duels: gear up at https://test.example/?channel=nesszerra, then name your rival with !challenge @name. They answer !fight. Again? !rematch. More: !checkin !wallet !ranks !look');
  assert.equal((await cmd('u1', 'alice', 'top')).body.reply, 'The arena has no champions yet! Gear up at https://test.example/?channel=nesszerra and win a duel.');
  assert.equal((await cmd('u1', 'alice', 'elo')).body.reply, '@alice, you have no fighter in the arena yet! Gear up at https://test.example/?channel=nesszerra');
  assert.equal((await cmd('u1', 'alice', 'look')).body.reply, '@alice, pick your fighter here: https://test.example/?channel=nesszerra#fighter');
  await r.save('u1', 'alice'); await r.save('u2', 'bob'); await r.save('u3', 'cara');
  assert.equal((await cmd('u1', 'alice', 'look')).body.reply, '@alice, change your look here: https://test.example/?channel=nesszerra#fighter');
  r.ctx.storage.sql.exec("UPDATE profiles SET elo = 1040, wins = 3, losses = 1 WHERE user_id = 'u2'");
  r.ctx.storage.sql.exec("UPDATE profiles SET elo = 990, wins = 0, losses = 1 WHERE user_id = 'u3'");
  assert.equal((await cmd('u1', 'alice', 'top')).body.reply, 'Top 3: 1. bob 1040 · 2. alice 1000 · 3. cara 990. Full list: https://test.example/?channel=nesszerra#ranks');
  assert.equal((await cmd('u1', 'alice', 'elo')).body.reply, 'alice: 1000 Elo, rank 2 of 3, 0 wins and 0 losses.');
  assert.equal((await cmd('u1', 'alice', 'elo', 'bob')).body.reply, 'bob: 1040 Elo, rank 1 of 3, 3 wins and 1 loss.');
  assert.equal((await cmd('u1', 'alice', 'elo', 'zed')).body.reply, '@zed has no fighter in the arena yet! Send them to https://test.example/?channel=nesszerra');
  assert.equal((await r.call('/dev/logs?source=command')).body[0].context.reason, 'elo_not_found');
  // A channel that stored the old !top name gets !ranks: StreamElements' built-in !top can't be replaced.
  await r.call('/se-admin', { method: 'POST', body: { action: 'setSeNames', names: { top: '!top' } } });
  assert.equal((await r.call('/admin')).body.streamelements.names.top, '!ranks');
  // The same for a stored !give: StreamElements' !givepoints answers to it, so it becomes !pay.
  await r.call('/se-admin', { method: 'POST', body: { action: 'setSeNames', names: { give: '!give' } } });
  assert.equal((await r.call('/admin')).body.streamelements.names.give, '!pay');
  // A stored !minichat (the name before PixFray) becomes !fray.
  await r.call('/se-admin', { method: 'POST', body: { action: 'setSeNames', names: { help: '!minichat' } } });
  assert.equal((await r.call('/admin')).body.streamelements.names.help, '!fray');
  // Renamed commands show up in !fray.
  await r.call('/se-admin', { method: 'POST', body: { action: 'setSeNames', names: { challenge: '!duel', accept: '!yes' } } });
  assert.match((await cmd('u1', 'alice', 'help')).body.reply, /!duel @name\. They answer !yes\. Again\? !rematch\. More: /);
});

test('!checkin: once per stream while live, streaks with one free miss a week, milestone bonus; points survive a rank reset', async () => {
  const r = room({ DEV_TOOLS_TOKEN: 'x'.repeat(40) }, { quick: true });
  const se = (await r.call('/admin')).body.streamelements;
  assert.equal(se.names.checkin, '!checkin');
  let m = 0;
  const cmd = (id, login) => r.call('/se?origin=https%3A%2F%2Ftest.example', { method: 'POST', body: { key: se.secret, action: 'checkin', userId: id, username: login, displayName: login, messageId: 'c' + (++m) } });
  const live = (body) => r.call('/dev-live', { method: 'POST', body });
  const say = async (id, login) => (await cmd(id, login)).body.reply;
  assert.equal(await say('u1', 'alice'), '@alice, you have no fighter in the arena yet! Gear up at https://test.example/?channel=nesszerra');
  await r.save('u1', 'alice'); await r.save('u2', 'bob');
  assert.deepEqual((await live({ live: false })).body, { ok: true, live: false, streamId: '' });
  assert.equal(await say('u1', 'alice'), 'Check-ins open while nesszerra is live. See you next stream!');
  await live({ live: true, streamId: 's1' });
  assert.equal(await say('u1', 'alice'), '@alice checked in: +1 upgrade point (1-stream streak). 1 of 20 points. Spend them at https://test.example/?channel=nesszerra#upgrades');
  assert.equal(await say('u1', 'alice'), '@alice, you already checked in this stream (1-stream streak). Come back next stream!');
  await live({ live: true, streamId: 's2' });
  assert.ok((await say('u1', 'alice')).includes('+1 upgrade point (2-stream streak). 2 of 20'));
  await live({ live: true, streamId: 's3' });
  assert.ok((await say('u1', 'alice')).includes('+2 upgrade points (3-stream streak, streak bonus). 4 of 20'));
  // Alice misses s4: the free miss keeps her streak. Missing s6 too, within the week, starts it over.
  for (const [stream, who] of [['s4', ['u2', 'bob']], ['s5', ['u1', 'alice']], ['s6', ['u2', 'bob']], ['s7', ['u1', 'alice']]]) {
    await live({ live: true, streamId: stream });
    const reply = await say(...who);
    if (stream === 's5') assert.ok((reply).includes('+1 upgrade point (4-stream streak, free miss used). 5 of 20'));
    if (stream === 's7') assert.ok((reply).includes('+1 upgrade point (1-stream streak). 6 of 20'));
  }
  let p = (await r.call('/profile?userId=u1')).body;
  assert.deepEqual([p.bonus, p.checkins, p.streak, p.upgrades.points, p.upgrades.fromCheckins], [6, 5, 1, 6, 6]);
  assert.equal((await r.call('/state')).body.players.find((x) => x.userId === 'u1').bonus, 6, 'the next duel counts the new points');
  assert.equal((await r.call('/dev/logs?source=command')).body[0].context.reason, 'checked_in');
  // The points are spendable, and a rank reset keeps them.
  r.ctx.storage.sql.exec("UPDATE profiles SET wins = 3 WHERE user_id = 'u1'");
  const saved = (await r.save('u1', 'alice', { stats: { power: 8, guard: 1 } })).body.profile;
  assert.deepEqual([saved.bonus, saved.checkins, saved.streak], [6, 5, 1], 'the save answer keeps the streak');
  assert.equal((await r.save('u1', 'alice', { stats: { power: 8, guard: 2 } })).body.error, 'invalid_upgrades');
  await r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'resetRank', payload: { userId: 'u1' } } });
  p = (await r.call('/profile?userId=u1')).body;
  assert.deepEqual([p.wins, p.bonus, p.upgrades.points], [0, 6, 6]);
  // Mods tune it: no points per check-in and no streak bonus still count the streak.
  const cfg = (patch) => r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'config', payload: { patch } } });
  assert.equal((await cfg({ checkinPoints: 4 })).body.error, 'invalid_config_checkinPoints');
  assert.equal((await cfg({ streakBonus: 'yes' })).body.error, 'invalid_config_streakBonus');
  assert.equal((await cfg({ checkinPoints: 0, streakBonus: false })).status, 200);
  await live({ live: true, streamId: 's8' });
  assert.equal(await say('u1', 'alice'), '@alice checked in: 2-stream streak. 6 of 20 points.');
  // A wrong key never reaches the check-in.
  assert.equal((await r.call('/se', { method: 'POST', body: { key: 'f'.repeat(48), action: 'checkin', userId: 'u1', username: 'alice' } })).status, 403);
});

test('dollars: paid once per finished duel and hidden until the stream shows it; mod gifts; !wallet; !give and its limits', async () => {
  const r = room({ DEV_TOOLS_TOKEN: 'x'.repeat(40) }, { quick: true });
  const se = (await r.call('/admin')).body.streamelements;
  assert.deepEqual([se.names.wallet, se.names.give], ['!wallet', '!pay']);
  await r.call('/chat', { method: 'POST', body: { action: 'connected', subscriptionId: 'se-streamelements', status: 'enabled', createdAt: Date.now() } });
  await r.save('u1', 'alice'); await r.save('u2', 'bob'); await r.save('u3', 'cara');
  let m = 0;
  const cmd = async (id, login, action, target = '', amount) => (await r.call('/se?origin=https%3A%2F%2Ftest.example', { method: 'POST', body: { key: se.secret, action, userId: id, username: login, displayName: login, target, messageId: 'd' + (++m), ...(amount !== undefined ? { amount } : {}) } })).body.reply;
  const dollars = () => Object.fromEntries(r.ctx.storage.sql.exec('SELECT username, dollars FROM profiles').toArray().map((x) => [x.username, x.dollars]));
  await cmd('u1', 'alice', 'challenge', 'bob');
  await cmd('u2', 'bob', 'accept');
  const duel = r.readState('nesszerra').duels.find((d) => d.status === 'completed');
  const [win, lose] = duel.winnerId === 'u1' ? ['alice', 'bob'] : ['bob', 'alice'];
  assert.deepEqual([dollars()[win], dollars()[lose], duel.paid], [5, 3, true], 'paid in the same transaction as the result');
  // Until the stream has shown the fight, !wallet and the website show the old balance.
  assert.equal(await cmd('u1', 'alice', 'wallet'), '@alice: $0 PixFray dollars, 0 of 20 upgrade points, 0-stream streak.');
  assert.equal((await r.call('/profile?userId=u1')).body.dollars, 0);
  const winId = win === 'alice' ? 'u1' : 'u2', point = { stats: { power: 1, guard: 0, luck: 0 } };
  assert.equal((await r.save(winId, win, point)).body.error, 'invalid_upgrades', 'a save cannot spend (or reveal) a win the stream has not shown');
  const realNow = Date.now;
  Date.now = () => duel.revealAt + 1;
  try {
    assert.equal((await r.save(winId, win, point)).body.profile.stats.power, 1, 'the point is spendable once shown');
    assert.equal(await cmd(win === 'alice' ? 'u1' : 'u2', win, 'wallet'), `@${win}: $5 PixFray dollars, 1 of 20 upgrade points, 0-stream streak.`);
    r.advance('nesszerra', { type: 'tick' }, Date.now());
    assert.deepEqual([dollars()[win], dollars()[lose]], [5, 3], 'never paid twice');
  } finally { Date.now = realNow; }
  // A website save and a rank reset keep dollars.
  assert.equal((await r.save('u3', 'cara')).body.profile.dollars, 0);
  const gift = (username, amount) => r.call('/admin', { method: 'POST', body: { actorId: 'mod1', actorName: 'Mod', action: 'giftDollars', payload: { username, amount } } });
  assert.deepEqual((({ ok, username, amount, dollars }) => [ok, username, amount, dollars])((await gift('@Cara', 50)).body), [true, 'cara', 50, 50]);
  assert.equal((await gift('cara', 0)).body.error, 'invalid_amount');
  assert.equal((await gift('cara', 10_001)).body.error, 'invalid_amount');
  assert.equal((await gift('nobody', 5)).status, 404);
  assert.equal((await gift('cara', -80)).body.dollars, 0, 'taking back never goes below 0');
  await gift('cara', 50);
  assert.match((await r.call('/dev/logs?source=command')).body[0].message, /^Mod gift 50 -> cara$/);
  await r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'resetRank', payload: { userId: 'u3' } } });
  assert.equal((await r.save('u3', 'cara')).body.profile.dollars, 50, 'a rank reset and a save keep dollars');
  // !give: usage, targets and the live check come first.
  const live = (body) => r.call('/dev-live', { method: 'POST', body });
  assert.equal(await cmd('u3', 'cara', 'give', 'alice'), 'Give who, and how much? Type !pay @name 10');
  assert.equal(await cmd('u3', 'cara', 'give', 'nobody', '5'), '@nobody has no fighter in the arena yet! Send them to https://test.example/?channel=nesszerra');
  assert.equal(await cmd('u3', 'cara', 'give', 'cara', '5'), "@cara, you can't give dollars to yourself!");
  assert.equal(await cmd('u9', 'zed', 'give', 'alice', '5'), '@zed, you have no fighter in the arena yet! Gear up at https://test.example/?channel=nesszerra');
  await live({ live: false });
  assert.equal(await cmd('u3', 'cara', 'give', 'alice', '5'), 'Giving opens while nesszerra is live. See you next stream!');
  await live({ live: true, streamId: 's1' });
  assert.equal(await cmd('u3', 'cara', 'give', 'alice', '5'), '@cara, finish 5 duels before giving dollars. You have 0 so far.');
  r.ctx.storage.sql.exec("UPDATE profiles SET wins = 3, losses = 2 WHERE user_id = 'u3'");
  assert.equal(await cmd('u3', 'cara', 'give', 'alice', '60'), '@cara, you only have $50.');
  const before = dollars().alice;
  assert.equal(await cmd('u3', 'cara', 'give', 'alice', '$30'), '@cara gave $30 to @alice. You have $20 left.');
  assert.deepEqual([dollars().cara, dollars().alice], [20, before + 30]);
  await gift('cara', 200);
  assert.equal(await cmd('u3', 'cara', 'give', 'alice', '80'), '@cara, you can give $70 more this stream.');
  assert.equal(await cmd('u3', 'cara', 'give', 'alice', '70'), '@cara gave $70 to @alice. You have $150 left.');
  assert.equal(await cmd('u3', 'cara', 'give', 'bob', '1'), '@cara, you gave the most for this stream ($100). Give more next stream!');
  await live({ live: true, streamId: 's2' });
  assert.equal(await cmd('u3', 'cara', 'give', 'bob', '10'), '@cara gave $10 to @bob. You have $140 left.', 'a new stream starts a new limit');
  const log = (await r.call('/dev/logs?source=command')).body;
  assert.deepEqual([log[0].context.reason, log[0].context.amount], ['given', 10]);
  // The dev chat (test site) answers like the bot would.
  const dev = async (text) => (await r.call('/dev-chat', { method: 'POST', body: { userId: 'u3', username: 'cara', displayName: 'cara', text } })).body.reply;
  assert.equal(await dev('!wallet'), '@cara: $140 PixFray dollars, 3 of 20 upgrade points, 0-stream streak.');
  assert.equal(await dev('!pay @bob 5'), '@cara gave $5 to @bob. You have $135 left.');
  // A wallet at the $1,000,000 cap: a gift that wouldn't fit is refused, and nobody loses dollars.
  await live({ live: true, streamId: 's3' });
  r.ctx.storage.sql.exec("UPDATE profiles SET dollars = 999990 WHERE user_id = 'u2'");
  assert.equal(await dev('!pay @bob 20'), '@bob can hold only $10 more.');
  assert.deepEqual([dollars().cara, dollars().bob], [135, 999990]);
  assert.equal(await dev('!pay @bob 10'), '@cara gave $10 to @bob. You have $125 left.');
  assert.equal(await dev('!pay @bob 1'), '@bob already holds the most dollars a fighter can.');
  // Mods tune it or turn !give off; payouts follow the config.
  const cfg = (patch) => r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'config', payload: { patch } } });
  assert.equal((await cfg({ winDollars: 101 })).body.error, 'invalid_config_winDollars');
  assert.equal((await cfg({ giveEnabled: 'no' })).body.error, 'invalid_config_giveEnabled');
  assert.equal((await cfg({ giveEnabled: false, winDollars: 0, lossDollars: 1 })).status, 200);
  assert.equal(await cmd('u3', 'cara', 'give', 'bob', '5'), 'Giving dollars is off on this channel.');
  await r.save('u4', 'dan');   // alice and bob's duel is still hidden from chat
  await cmd('u3', 'cara', 'challenge', 'dan');
  await cmd('u4', 'dan', 'accept');
  const second = r.readState('nesszerra').duels.filter((d) => d.status === 'completed').at(-1);
  assert.deepEqual(Object.values(second.payout), [1], 'no win payout at 0; the loser gets 1');
});

test('!checkin asks Twitch whether the channel is live, keeps the answer a minute, and says try again when Twitch fails', async (t) => {
  const store = new AuthStore(fakeCtx(), { INTERNAL_SECRET: SECRET });
  const AUTH = { idFromName: () => 'auth', get: () => ({ fetch: (url, init) => store.fetch(new Request(url, init)) }) };
  const r = room({ AUTH, AUTH_SECRET: 'a'.repeat(64), TWITCH_CLIENT_ID: 'client-id', TWITCH_CLIENT_SECRET: 'client-secret' });
  let helix = () => new Response('down', { status: 503 });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://id.twitch.tv/oauth2/token')) return Response.json({ access_token: 'app-token', expires_in: 3600 });
    return helix();
  });
  const se = (await r.call('/admin')).body.streamelements;
  const say = async (id, login) => (await r.call('/se', { method: 'POST', body: { key: se.secret, action: 'checkin', userId: id, username: login, displayName: login } })).body.reply;
  await r.save('u1', 'alice'); await r.save('u2', 'bob');
  assert.equal(await say('u1', 'alice'), "Couldn't reach Twitch to check the stream. Try again in a minute!");
  assert.equal((await r.call('/profile?userId=u1')).body.bonus, 0);
  assert.equal((await r.call('/dev-live', { method: 'POST', body: { live: true } })).status, 404, 'no pretend streams without the dev token');
  helix = () => Response.json({ data: [{ id: '4242', type: 'live', started_at: '2026-10-04T10:00:00Z' }] });
  assert.ok((await say('u1', 'alice')).includes('@alice checked in: +1 upgrade point'));
  assert.match(await say('u2', 'bob'), /^@bob checked in/);
  assert.equal(calls.filter((u) => u.includes('/helix/streams?user_login=nesszerra')).length, 2, 'the failed lookup was not cached; the live answer is');
  assert.equal(r.ctx.storage.sql.exec("SELECT stream_id FROM streams").toArray()[0].stream_id, '4242');
});

test('/looks returns saved looks by login for the overlay: saved profiles only, at most 20 logins', async () => {
  const r = room();
  await r.save('u1', 'Alice', { avatar: 'toon-ghoul', color: '#112233' });
  const looks = (await r.call('/looks?u=alice,nobody,bad%20name,ALICE')).body;
  assert.deepEqual(looks, { alice: { avatar: 'toon-ghoul', color: '#112233', hat: '', pet: '', petTier: '', recolor: '', petColor: '', accessory: '', trail: '', winEffect: '', taunt: '', title: '', displayName: 'Alice', elo: 1000 } });
  assert.deepEqual((await r.call('/looks')).body, {});
  for (let i = 0; i < 25; i++) await r.save('x' + i, 'v' + i);
  const many = (await r.call('/looks?u=' + Array.from({ length: 25 }, (_, i) => 'v' + i).join(','))).body;
  assert.equal(Object.keys(many).length, 20);
});

test('dev-chat (test site only): refused without DEV_TOOLS_TOKEN; with it, a line plays like real chat and returns the bot reply', async () => {
  const off = room({}, { quick: true });
  await off.connectChat();
  assert.equal((await off.call('/dev-chat', { method: 'POST', body: { userId: 'b1', username: 'testbot_a', displayName: 'testbot_a', text: 'hi' } })).status, 404);
  const r = room({ DEV_TOOLS_TOKEN: 'x'.repeat(40) }, { quick: true });
  await r.connectChat();
  await r.save('b1', 'testbot_a');
  await r.save('b2', 'testbot_b');
  const say = (id, login, text) => r.call('/dev-chat', { method: 'POST', body: { userId: id, username: login, displayName: login, text } });
  assert.equal((await say('b2', 'testbot_b', 'hello')).body.reply, '', 'a plain line only refreshes presence');
  const ch = await say('b1', 'testbot_a', '!challenge @testbot_b');
  assert.equal(ch.status, 200);
  assert.equal(ch.body.ok, true);
  const fight = await say('b2', 'testbot_b', '!fight');
  assert.equal(fight.body.reason, 'quick_duel');
  assert.equal(fight.body.reply, 'Fight on: testbot_a vs testbot_b! Watch the stream for the winner.');
  assert.equal(r.ctx.storage.sql.exec('SELECT wins, losses FROM profiles').toArray().filter((p) => p.wins + p.losses === 1).length, 2, 'Elo and records are saved');

  await r.call('/dev-live', { method: 'POST', body: { live: true, streamId: 's1' } });
  const checked = await say('b1', 'testbot_a', '!checkin');
  assert.equal(checked.body.reason, 'checked_in');
  assert.ok(checked.body.reply.startsWith('@testbot_a checked in: +1 upgrade point'), checked.body.reply);
});

test('account age: looked up once per fighter; a duel with an account under 7 days old is just for fun', async () => {
  const r = room({ DEV_TOOLS_TOKEN: 'x'.repeat(40), TWITCH_CLIENT_ID: 'cid' }, { quick: true });
  const age = { b1: Date.now() - 400 * 86_400_000, b2: Date.now() - 2 * 86_400_000 };
  const looked = [];
  r.lookupAccount = async (id) => { looked.push(id); if (id === 'b3') throw new Error('helix down'); return age[id] ?? 0; };
  await r.connectChat();
  for (const [id, login] of [['b1', 'testbot_a'], ['b2', 'testbot_b'], ['b3', 'testbot_c']]) await r.save(id, login);
  const say = (id, login, text) => r.call('/dev-chat', { method: 'POST', body: { userId: id, username: login, displayName: login, text } });
  await say('b1', 'testbot_a', '!challenge @testbot_b');
  const fight = await say('b2', 'testbot_b', '!fight');
  assert.equal(fight.body.reason, 'quick_duel');
  assert.ok(fight.body.reply.endsWith('Just for fun (a Twitch account under 7 days old): no Elo or dollars.'), fight.body.reply);
  assert.deepEqual(r.ctx.storage.sql.exec('SELECT wins, losses, dollars FROM profiles').toArray().map((p) => p.wins + p.losses + p.dollars), [0, 0, 0]);
  await say('b1', 'testbot_a', 'hi');
  assert.deepEqual(looked, ['b1', 'b2'], 'a known age is not looked up again');
  const failed = await say('b3', 'testbot_c', 'hi');
  assert.equal(failed.status, 200, 'a failed lookup does not block chat');
  await say('b3', 'testbot_c', 'hi again');
  assert.deepEqual(looked, ['b1', 'b2', 'b3'], 'a failed lookup waits an hour before retrying');
});

test('overlay sockets: one network is capped; a full room drops the oldest viewer socket, never an overlay', async () => {
  const r = room();
  const upgrade = (ip) => r.upgrade(new Request('https://room/live', { headers: { Upgrade: 'websocket', 'X-Mini-Client-Ip': ip } }), 'live', 'nesszerra');
  r.ctx.acceptWebSocket(fakeSocket(null, 'live'), ['live', 'ip:198.51.100.7', 'overlay']);   // the streamer's OBS source, first in
  for (let i = 1; i < 16; i++) r.ctx.acceptWebSocket(fakeSocket(null, 'live'), ['live', 'ip:198.51.100.7']);
  const capped = await upgrade('198.51.100.7');
  assert.equal(capped.status, 429);
  for (let i = 16; i < 200; i++) r.ctx.acceptWebSocket(fakeSocket(null, 'live'), ['live', 'ip:203.0.113.' + i]);
  const [obs, oldestViewer] = r.ctx.sockets;
  const saved = globalThis.WebSocketPair;
  globalThis.WebSocketPair = class { constructor() { this[0] = {}; this[1] = fakeSocket(null, 'live'); } };
  try { await upgrade('192.0.2.1').catch(() => {}); }   // Node's Response can't build a 101; the eviction happens first
  finally { globalThis.WebSocketPair = saved; }
  assert.equal(obs.closed, null, 'the overlay stays');
  assert.deepEqual(oldestViewer.closed, [1013, 'room full']);
  assert.ok(r.ctx.sockets.at(-1).tags.includes('ip:192.0.2.1'), 'the new socket is tagged with its network');
  // A room holding only overlays refuses the newcomer rather than dropping one.
  const full = room();
  for (let i = 0; i < 200; i++) full.ctx.acceptWebSocket(fakeSocket(null, 'live'), ['live', 'ip:203.0.113.' + (i % 100), 'overlay']);
  const refused = await full.upgrade(new Request('https://room/live', { headers: { Upgrade: 'websocket', 'X-Mini-Client-Ip': '192.0.2.9' } }), 'live', 'nesszerra');
  assert.equal(refused.status, 503);
  assert.ok(full.ctx.sockets.every((ws) => ws.closed === null));
});

test('overlay sockets opened with role=overlay are counted for the admin setup checklist', async () => {
  const r = room();
  assert.equal((await r.call('/admin')).body.overlays, 0);
  const saved = globalThis.WebSocketPair;
  globalThis.WebSocketPair = class { constructor() { this[0] = {}; this[1] = fakeSocket(null, 'live'); } };
  const open = (path) => r.fetch(new Request('https://room' + path, { headers: { Upgrade: 'websocket', 'X-Mini-Internal': SECRET, 'X-Mini-Channel': 'nesszerra' } })).catch(() => {});
  try { await open('/live?role=overlay'); await open('/live'); }   // Node's Response can't build a 101; the socket is accepted first
  finally { globalThis.WebSocketPair = saved; }
  assert.deepEqual(r.ctx.sockets.map((s) => s.tags.includes('overlay')), [true, false]);
  assert.equal((await r.call('/admin')).body.overlays, 1);
});

test('profiles save upgrades and hats within the points and unlocks the saved wins allow', async () => {
  const r = room();
  await r.save('u1', 'alice');
  assert.equal((await r.save('u1', 'alice', { stats: { power: 1 } })).body.error, 'invalid_upgrades');
  assert.equal((await r.save('u1', 'alice', { hat: 'crown' })).body.error, 'hat_locked');
  assert.equal((await r.save('u1', 'alice', { hat: 'sombrero' })).status, 400);
  // Six wins, in the database and in the live game state (duels keep the two in step).
  r.ctx.storage.sql.exec("UPDATE profiles SET wins = 6 WHERE user_id = 'u1'");
  const live = r.readState('nesszerra'); live.players.find((p) => p.userId === 'u1').wins = 6; r.writeState(live);
  const saved = await r.save('u1', 'alice', { stats: { power: 3, luck: 2 }, hat: 'tophat' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.profile.stats, { power: 3, guard: 0, luck: 2 });
  const got = (await r.call('/profile?userId=u1')).body;
  assert.equal(got.hat, 'tophat');
  assert.deepEqual(got.stats, { power: 3, guard: 0, luck: 2 });
  assert.equal(got.upgrades.points, 6);
  assert.equal(got.upgrades.hats.find((h) => h.id === 'tophat').unlocked, true);
  // Leaving stats and hat out keeps them.
  assert.equal((await r.save('u1', 'alice', { color: '#654321' })).body.profile.hat, 'tophat');
  assert.equal((await r.call('/profile?userId=u1')).body.stats.power, 3);
  // Overlays get the hat with the player.
  const state = (await r.call('/state')).body;
  assert.equal(state.players.find((p) => p.userId === 'u1')?.hat, 'tophat');
});

test('snapshots carry the deploy build id and the announce setting so open overlays follow them', () => {
  const r = room({ CF_VERSION_METADATA: { id: 'build-42' } });
  const snap = r.publicState(r.readState('nesszerra'));
  assert.equal(snap.build, 'build-42');
  assert.equal(snap.config.announce, 'off');
  assert.equal(room().publicState(createInitialState('nesszerra')).build, '');
});

test('pets: tier boosts, added after the upgrade cap', () => {
  assert.deepEqual(tierBoost('common', 'power'), { power: 1, guard: 0, luck: 0 });
  assert.deepEqual(tierBoost('rare', 'luck'), { power: 0, guard: 0, luck: 2 });
  assert.deepEqual(tierBoost('epic', 'guard', 'power'), { power: 1, guard: 2, luck: 0 });
  assert.deepEqual(tierBoost('epic', 'guard', 'guard'), { power: 0, guard: 2, luck: 0 }, 'an epic second stat must differ');
  assert.deepEqual(tierBoost('legendary'), { power: 1, guard: 1, luck: 1 });
  assert.deepEqual(tierBoost('mythic', 'power'), { power: 0, guard: 0, luck: 0 });
  assert.equal(PETS.length, 14);
  assert.equal(petOf('p-gone', ''), null, 'a deleted upload is no pet');
  assert.deepEqual(petOf('p-blob-1a2b3c', 'rare:power:').boost, { power: 2, guard: 0, luck: 0 });
  // 8 power at 8 points stays 8 before the pet, then the fox's +2 goes past the per-stat cap.
  assert.deepEqual(effectiveStats({ power: 8 }, 8, 0, tierBoost('rare', 'power')), { power: 10, guard: 0, luck: 0 });
  assert.deepEqual(effectiveStats({ power: 8 }, 3, 0, null), { power: 3, guard: 0, luck: 0 });
});

test('shop: buy pets and hats with shown dollars, equip on save, !pet, custom pet uploads and deletes', async () => {
  const r = room({ DEV_TOOLS_TOKEN: 'x'.repeat(40) }, { quick: true });
  const se = (await r.call('/admin')).body.streamelements;
  assert.equal(se.names.pet, '!pet');
  await r.save('u1', 'alice'); await r.save('u2', 'bob');
  const gift = (username, amount) => r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'giftDollars', payload: { username, amount } } });
  const buy = (userId, kind, id) => r.call('/shop', { method: 'POST', userId, body: { userId, kind, id } });
  const cmd = async (id, login, target = '') => (await r.call('/se?origin=https%3A%2F%2Ftest.example', { method: 'POST', body: { key: se.secret, action: 'pet', userId: id, username: login, displayName: login, target } })).body.reply;
  // The catalog: built-ins with the config prices, and the hat price per win.
  const catalog = (await r.call('/pets')).body;
  assert.equal(catalog.pets.length, 14);
  assert.deepEqual(catalog.pets.find((p) => p.id === 'fox'), { id: 'fox', label: 'Fox', tier: 'rare', boost: { power: 2, guard: 0, luck: 0 }, price: 60, custom: false });
  assert.equal(catalog.hatPricePerWin, 3);
  // Buying: identity, unknown items, money.
  assert.equal((await r.call('/shop', { method: 'POST', userId: 'u1', body: { userId: 'u2', kind: 'pet', id: 'fox' } })).status, 403);
  assert.equal((await buy('u9', 'pet', 'fox')).body.error, 'no_fighter');
  assert.equal((await buy('u1', 'pet', 'unicorn')).body.error, 'unknown_item');
  assert.deepEqual((({ status, body }) => [status, body.error, body.price, body.dollars])(await buy('u1', 'pet', 'fox')), [409, 'not_enough', 60, 0]);
  await gift('alice', 250);
  const bought = (await buy('u1', 'pet', 'fox')).body;
  assert.deepEqual([bought.ok, bought.price, bought.dollars, bought.owned.pets, bought.owned.hats, bought.owned.slots], [true, 60, 190, ['fox'], [], 1]);
  assert.equal((await buy('u1', 'pet', 'fox')).body.error, 'owned');
  // Hats: free ones are already unlocked; locked ones cost wins x hatPricePerWin; 0 turns hat sales off.
  assert.equal((await buy('u1', 'hat', 'cap')).body.error, 'already_unlocked');
  assert.equal((await buy('u1', 'hat', 'wizard')).body.price, 9);
  assert.equal((await r.save('u1', 'alice', { hat: 'tophat' })).body.error, 'hat_locked');
  assert.equal((await r.save('u1', 'alice', { hat: 'wizard' })).body.profile.hat, 'wizard', 'a bought hat saves before its wins');
  const cfg = (patch) => r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'config', payload: { patch } } });
  assert.equal((await cfg({ petPriceRare: 0 })).body.error, 'invalid_config_petPriceRare');
  assert.equal((await cfg({ hatPricePerWin: 0 })).status, 200);
  assert.equal((await buy('u1', 'hat', 'crown')).body.error, 'hats_not_for_sale');
  // Equip: only owned pets; the profile, the game state and /looks carry it.
  assert.equal(await cmd('u1', 'alice'), '@alice, you have no pet yet. Buy one with PixFray dollars at https://test.example/?channel=nesszerra#pets');
  assert.equal((await r.save('u1', 'alice', { pet: 'wolf' })).body.error, 'pet_locked');
  assert.equal((await r.save('u1', 'alice', { pet: 7 })).body.error, 'invalid_profile');
  const saved = (await r.save('u1', 'alice', { pet: 'fox' })).body.profile;
  assert.deepEqual([saved.pet, saved.petTier, saved.petBoost, saved.dollars], ['fox', 'rare', { power: 2, guard: 0, luck: 0 }, 181]);
  assert.deepEqual((({ pets, hats }) => ({ pets, hats }))((await r.call('/profile?userId=u1')).body.owned), { pets: ['fox'], hats: ['wizard'] });
  assert.equal(r.readState('nesszerra').players.find((p) => p.userId === 'u1').petBoost.power, 2, 'duels count the boost');
  assert.deepEqual((({ pet, petTier }) => [pet, petTier])((await r.call('/looks?u=alice')).body.alice), ['fox', 'rare']);
  assert.equal((await r.save('u1', 'alice', { avatar: 'toon-ghoul' })).body.profile.pet, 'fox', 'a save without pet keeps it');
  assert.equal(await cmd('u1', 'alice'), "@alice's pet: Fox (rare), +2 power.");
  assert.equal(await cmd('u2', 'bob', 'alice'), "@alice's pet: Fox (rare), +2 power.");
  assert.equal(await cmd('u1', 'alice', 'bob'), '@bob has no pet yet.');
  assert.equal(await cmd('u1', 'alice', 'nobody'), '@nobody has no fighter in the arena yet! Send them to https://test.example/?channel=nesszerra');
  assert.equal((await r.call('/dev-chat', { method: 'POST', body: { userId: 'u2', username: 'bob', displayName: 'bob', text: '!pet @alice' } })).body.reply, "@alice's pet: Fox (rare), +2 power.");
  // A duel's result write keeps the pet (upsertProfile from the game state).
  await r.call('/chat', { method: 'POST', body: { action: 'connected', subscriptionId: 'se-streamelements', status: 'enabled', createdAt: Date.now() } });
  const duel = async (id, login, action, target = '') => r.call('/se', { method: 'POST', body: { key: se.secret, action, userId: id, username: login, displayName: login, target } });
  await duel('u1', 'alice', 'challenge', 'bob'); await duel('u2', 'bob', 'accept');
  assert.ok(r.readState('nesszerra').duels.some((d) => d.status === 'completed'));
  assert.equal(r.ctx.storage.sql.exec("SELECT pet FROM profiles WHERE user_id = 'u1'").toArray()[0].pet, 'fox');
  // Custom pets: checked uploads, priced by tier; deleting one takes it off fighters and owners.
  const upload = (body) => r.call('/pets', { method: 'POST', body: { label: 'Blob', tier: 'epic', stat: 'luck', stat2: 'guard', image: b64(makePng(32, 32)), createdBy: 'mod1', ...body } });
  assert.equal((await upload({ stat2: 'luck' })).body.reason, 'invalid_stat');
  assert.equal((await upload({ tier: 'mythic' })).body.reason, 'invalid_tier');
  assert.equal((await upload({ image: b64(makePng(65, 32)) })).body.reason, 'image_dimensions');
  assert.equal((await upload({ image: b64(Buffer.from('not a png at all, just some text that is long enough to read')) })).body.reason, 'not_png');
  const item = (await upload({})).body.item;
  assert.match(item.id, /^p-blob-[0-9a-f]{6}$/);
  assert.deepEqual([item.tier, item.boost, item.price, item.url], ['epic', { power: 0, guard: 1, luck: 2 }, 140, '/api/pets/nesszerra/' + item.id]);
  const png = await r.fetch(new Request('https://room/pets/' + item.id, { headers: { 'X-Mini-Internal': SECRET, 'X-Mini-Channel': 'nesszerra' } }));
  assert.equal(png.headers.get('content-type'), 'image/png');
  await gift('bob', 500);
  assert.equal((await buy('u2', 'pet', item.id)).body.price, 140);
  assert.equal((await r.save('u2', 'bob', { pet: item.id })).body.profile.petTier, 'epic');
  assert.equal(await cmd('u2', 'bob'), "@bob's pet: Blob (epic), +1 guard, +2 luck.");
  assert.equal((await r.call('/pets/' + item.id, { method: 'DELETE' })).body.ok, true);
  assert.equal((await r.call('/profile?userId=u2')).body.pet, '');
  assert.deepEqual((await r.call('/profile?userId=u2')).body.owned.pets, []);
  assert.equal(r.readState('nesszerra').players.find((p) => p.userId === 'u2').pet, '');
  assert.equal((await r.call('/pets/' + item.id, { method: 'DELETE' })).status, 404);
  // A deleted profile takes its purchases with it.
  await r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'removePlayer', payload: { userId: 'u1' } } });
  assert.equal(r.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM owned_items WHERE user_id = 'u1'").toArray()[0].n, 0);
});

test('cosmetics and builds: the shop list, buying, wearing, build slots with their own loadout, duels keep them', async () => {
  const r = room({}, { quick: true });
  await r.save('u1', 'alice'); await r.save('u2', 'bob');
  const gift = (username, amount) => r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'giftDollars', payload: { username, amount } } });
  const buy = (kind, id, price) => r.call('/shop', { method: 'POST', userId: 'u1', body: { userId: 'u1', kind, id, price } });
  // The public list: every kind with the config price, and the build slot prices.
  const shop = (await r.call('/shop')).body;
  assert.equal(shop.pets.length, 14);
  assert.deepEqual(Object.keys(shop.items), ['recolor', 'petcolor', 'accessory', 'trail', 'effect', 'taunt', 'title']);
  assert.deepEqual(shop.items.trail.find((x) => x.id === 'flames'), { id: 'flames', label: 'Flames', price: 40 });
  assert.deepEqual(shop.slots, { max: 5, prices: [60, 120, 120, 120] });
  // Buying: unknown ids, money, owned.
  assert.equal((await buy('accessory', 'jetpack')).body.error, 'unknown_item');
  assert.equal((await buy('trail', 'flames')).body.error, 'not_enough');
  await gift('alice', 2000);
  // The page sends the price it showed; after a mod's change the buy is refused with the new price.
  const stale = await buy('trail', 'flames', 100);
  assert.deepEqual([stale.status, stale.body.error, stale.body.price], [409, 'price_changed', 40]);
  assert.deepEqual((({ price, dollars }) => [price, dollars])((await buy('trail', 'flames', 40)).body), [40, 1960]);
  assert.equal((await buy('trail', 'flames')).status, 409);
  for (const [kind, id] of [['recolor', 'crimson'], ['petcolor', 'gold'], ['accessory', 'cape'], ['effect', 'fireworks'], ['taunt', 'gg'], ['title', 'legend']]) assert.equal((await buy(kind, id)).body.ok, true, kind);
  // Wearing: only bought ones; "" takes one off; left out keeps it.
  assert.equal((await r.save('u1', 'alice', { accessory: 'glasses' })).body.error, 'item_locked');
  assert.equal((await r.save('u1', 'alice', { title: 'Supreme Leader' })).body.error, 'invalid_profile');
  const worn = { recolor: 'crimson', petColor: 'gold', accessory: 'cape', trail: 'flames', winEffect: 'fireworks', taunt: 'gg', title: 'legend' };
  let p = (await r.save('u1', 'alice', worn)).body.profile;
  assert.deepEqual((({ recolor, petColor, accessory, trail, winEffect, taunt, title }) => ({ recolor, petColor, accessory, trail, winEffect, taunt, title }))(p), worn);
  assert.equal((await r.save('u1', 'alice', { avatar: 'toon-ghoul' })).body.profile.trail, 'flames', 'a save without cosmetics keeps them');
  assert.equal((await r.save('u1', 'alice', { title: '' })).body.profile.title, '');
  await r.save('u1', 'alice', { title: 'legend' });
  const looks = (await r.call('/looks?u=alice')).body.alice;
  assert.deepEqual([looks.recolor, looks.accessory, looks.trail, looks.winEffect, looks.taunt, looks.title], ['crimson', 'cape', 'flames', 'fireworks', 'gg', 'legend']);
  assert.equal(r.readState('nesszerra').players.find((x) => x.userId === 'u1').trail, 'flames', 'the overlay state carries them');
  // Build slots: 1 free, the 2nd costs 60, then 120 each, up to 5.
  assert.equal((await r.save('u1', 'alice', { build: 1 })).body.error, 'invalid_build');
  assert.deepEqual((({ price, owned }) => [price, owned.slots])((await buy('slot', '')).body), [60, 2]);
  // Slot 1 keeps its own character, stats and cosmetics; slot 0 is untouched.
  p = (await r.save('u1', 'alice', { build: 1, avatar: 'soldier', stats: { power: 0, guard: 0, luck: 0 }, recolor: '', trail: '', title: 'legend' })).body.profile;
  assert.deepEqual([p.build, p.avatar, p.recolor, p.trail], [1, 'soldier', '', '']);
  let prof = (await r.call('/profile?userId=u1')).body;
  assert.deepEqual([prof.build, prof.builds.length, prof.builds[0].avatar, prof.builds[0].trail, prof.builds[1].avatar, prof.builds[1].trail], [1, 2, 'player', 'flames', 'soldier', '']);
  // Switching back = saving slot 0's loadout to slot 0.
  p = (await r.save('u1', 'alice', { ...prof.builds[0], build: 0 })).body.profile;
  assert.deepEqual([p.build, p.avatar, p.trail], [0, 'player', 'flames']);
  for (const price of [120, 120, 120]) assert.equal((await buy('slot', '')).body.price, price);
  assert.equal((await buy('slot', '')).body.error, 'max_slots');
  prof = (await r.call('/profile?userId=u1')).body;
  assert.deepEqual([prof.owned.slots, prof.builds.length, prof.builds[2]], [5, 5, null]);
  // A build saved with an uploaded pet that was deleted since loads with no pet.
  r.ctx.storage.sql.exec("INSERT INTO builds (user_id, slot, data) VALUES ('u1', 2, ?)", JSON.stringify({ ...prof.builds[0], pet: 'c-gone-abc123' }));
  prof = (await r.call('/profile?userId=u1')).body;
  assert.deepEqual([prof.builds[2].pet, prof.builds[2].trail], ['', 'flames']);
  // A duel's result write keeps the cosmetics; a removed fighter loses builds and purchases.
  const se = (await r.call('/admin')).body.streamelements;
  await r.call('/chat', { method: 'POST', body: { action: 'connected', subscriptionId: 'se-streamelements', status: 'enabled', createdAt: Date.now() } });
  const duel = (id, login, action, target = '') => r.call('/se', { method: 'POST', body: { key: se.secret, action, userId: id, username: login, displayName: login, target } });
  await duel('u1', 'alice', 'challenge', 'bob'); await duel('u2', 'bob', 'accept');
  assert.ok(r.readState('nesszerra').duels.some((d) => d.status === 'completed'));
  assert.deepEqual(r.ctx.storage.sql.exec("SELECT trail, title, build FROM profiles WHERE user_id = 'u1'").toArray()[0], { trail: 'flames', title: 'legend', build: 0 });
  await r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'removePlayer', payload: { userId: 'u1' } } });
  assert.equal(r.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM builds WHERE user_id = 'u1'").toArray()[0].n, 0);
});

test('cosmetic ids: the overlay drawings (public/cosmetics.js) match the server lists', async () => {
  const server = await import('../server/cosmetics.js');
  const client = await import('../public/cosmetics.js');
  for (const kind of server.COSMETIC_KINDS) {
    const ids = server.COSMETICS[kind].map((x) => x.id);
    assert.deepEqual(client.COSMETIC_IDS[kind], ids, kind);
  }
  assert.deepEqual(Object.keys(client.TAUNTS), server.COSMETICS.taunt.map((x) => x.id));
  assert.deepEqual(Object.values(client.TITLES), server.COSMETICS.title.map((x) => x.label));
});

test('pet boost text: legendary pets read "+1 to all stats", like the viewer page', () => {
  assert.equal(boostText(tierBoost('legendary')), '+1 to all stats');
  assert.equal(boostText({ power: 2, guard: 1, luck: 0 }), '+2 power, +1 guard');
  assert.equal(boostText({ power: 0, guard: 0, luck: 1 }), '+1 luck');
});

test('chat bot: commands by the channel names get a reply; chat, other commands and other subscriptions get none', async () => {
  const r = room({ CHAT_BOT: '1' }, { quick: true });
  await r.save('u1', 'alice'); await r.save('u2', 'bob');
  await r.connectChat('sub-bot');
  let n = 0;
  const say = async (id, login, text, sub = 'sub-bot') => (await r.call('/eventsub?origin=' + encodeURIComponent('https://staging.example'), { method: 'POST', body: { messageId: 'b' + (++n), messageType: 'notification', bot: true, timestamp: Date.now(), subscription: { id: sub, status: 'enabled' }, event: { broadcaster_user_login: 'nesszerra', chatter_user_id: id, chatter_user_login: login, chatter_user_name: login, message_id: 'tm' + n, message: { text } } } })).body.reply;
  assert.match(await say('u1', 'alice', '!fray'), /staging\.example\/\?channel=nesszerra/);
  assert.equal(await say('u1', 'alice', '!discord'), '', "another bot's command");
  assert.equal(await say('u1', 'alice', '!fray', 'sub-old'), '', 'a subscription the room no longer uses');
  assert.match(await say('u1', 'alice', '!challenge @bob'), /bob/);
  await say('u2', 'bob', '!FIGHT');
  assert.ok(r.readState('nesszerra').duels.some((d) => d.status === 'completed'), 'a quick duel through the bot');
  // StreamElements posts nothing while the bot is connected, and doesn't take the chat source back.
  const se = (await r.call('/admin')).body.streamelements;
  assert.equal((await r.call('/se', { method: 'POST', body: { key: se.secret, action: 'help', userId: 'u1', username: 'alice' } })).body.reply, '');
  assert.equal(r.readState('nesszerra').chat.subscriptionId, 'sub-bot');
  // At most 18 lines per 30 s (Twitch allows 20 for a bot that isn't a mod), and command replies stop 4 short of that
  // so the bot's own result lines still fit; 3 were sent above.
  const replies = [];
  for (let i = 0; i < 20; i++) replies.push(await say('u1', 'alice', '!elo'));
  assert.equal(replies.filter(Boolean).length, 11);
});

test('chat bot: a notification confirms a pending subscription; without CHAT_BOT, StreamElements takes over as before', async () => {
  const r = room({ CHAT_BOT: '1' }, { quick: true });
  await r.connectChat('sub-bot', 'webhook_callback_verification_pending');
  const reply = (await r.call('/eventsub', { method: 'POST', body: { messageId: 'p1', messageType: 'notification', bot: true, timestamp: Date.now(), subscription: { id: 'sub-bot' }, event: { chatter_user_id: 'u1', chatter_user_login: 'alice', chatter_user_name: 'alice', message_id: 'x1', message: { text: '!ranks' } } } })).body.reply;
  assert.ok(reply);
  assert.equal(r.readState('nesszerra').chat.connected, true);
  const plain = room({}, { quick: true });
  await plain.connectChat('sub-bot');
  const se = (await plain.call('/admin')).body.streamelements;
  assert.notEqual((await plain.call('/se', { method: 'POST', body: { key: se.secret, action: 'help', userId: 'u1', username: 'alice' } })).body.reply, '');
  assert.equal(plain.readState('nesszerra').chat.subscriptionId, 'se-streamelements');
});

// BOT_DEBUG: the bot account (u9 pixbot) plays back. The Worker forwards the subscription's bot id and a mod flag.
function botRoom(env) {
  const r = room({ CHAT_BOT: '1', DEV_TOOLS_TOKEN: 'x'.repeat(40), ...env }, { quick: true });
  let n = 0;
  r.say = async (id, login, text, { mod = false } = {}) => (await r.call('/eventsub?origin=' + encodeURIComponent('https://staging.example'), { method: 'POST', body: { messageId: 'd' + (++n), messageType: 'notification', bot: true, botId: 'u9', timestamp: Date.now(), subscription: { id: 'sub-bot', status: 'enabled' }, event: { broadcaster_user_id: 'owner1', broadcaster_user_login: 'nesszerra', chatter_user_id: id, chatter_user_login: login, chatter_user_name: login, message_id: 'dm' + n, message: { text }, mod } } })).body;
  return r;
}

test('chat bot: !give gives dollars (and !pay still does); replies name !give', async () => {
  const r = botRoom({});
  await r.save('u1', 'alice'); await r.save('u2', 'bob');
  await r.connectChat('sub-bot');
  assert.match((await r.say('u1', 'alice', '!give')).reply, /!give @name/);
  assert.match((await r.say('u1', 'alice', '!pay')).reply, /!give @name/, '!pay is an alias');
  assert.equal((await r.say('u1', 'alice', '!givepoints')).reply, '', "StreamElements' name isn't ours");
});

test('chat bot: text commands from the admin page answer in chat, with counters, cooldowns and protected names', async () => {
  const r = botRoom({});
  await r.connectChat('sub-bot');
  const admin = async (action, payload) => (await r.call('/admin', { method: 'POST', body: { actorId: 'owner1', actorName: 'nesszerra', action, payload } }));
  assert.equal((await admin('saveCommand', { name: 'sens', reply: '0.14 3600dpi' })).body.ok, true);
  const saved = await admin('saveCommand', { name: '!NT', reply: 'Nesszerra has tried $(count nt) times!' });
  assert.deepEqual(saved.body.botCommands.counters, [{ name: 'nt', value: 0 }], 'a new counter starts at 0');
  assert.equal((await admin('setCounter', { name: 'nt', value: 1 })).body.ok, true);
  assert.equal((await r.say('u1', 'alice', '!sens')).reply, '0.14 3600dpi');
  assert.equal((await r.say('u1', 'alice', '!nt')).reply, 'Nesszerra has tried 2 times!');
  assert.equal((await r.say('u2', 'bob', '!nt')).reply, '', 'global cooldown');
  assert.equal((await r.say('u1', 'alice', 'sens')).reply, '', 'needs the !');
  r.commandCooldowns.clear();
  assert.equal((await r.say('u2', 'bob', '!NT now')).reply, 'Nesszerra has tried 3 times!');
  await admin('saveCommand', { name: 'hug', reply: '${user} hugs ${touser} (${getcount nt})' });
  assert.equal((await r.say('u1', 'alice', '!hug @bob')).reply, 'alice hugs bob (3)');
  assert.equal((await r.say('u1', 'alice', '!unknown')).reason, 'not_command');
  // Names PixFray uses, and bad input, are refused.
  for (const name of ['fray', '!give', 'pay', 'fight', 'challenge']) assert.equal((await admin('saveCommand', { name, reply: 'x' })).body.error, 'command_name_taken', name);
  assert.equal((await admin('saveCommand', { name: 'a b', reply: 'x' })).body.error, 'invalid_command_name');
  assert.equal((await admin('saveCommand', { name: 'x', reply: '  ' })).body.error, 'empty_command_reply');
  assert.equal((await admin('saveCommand', { name: 'sens', reply: 'dup' })).body.error, 'command_exists');
  assert.equal((await admin('setCounter', { name: 'nt', value: -1 })).body.error, 'invalid_counter_value');
  // Edit with a rename, then delete; the admin page sees the list.
  assert.equal((await admin('saveCommand', { name: 'sensitivity', reply: '0.15', oldName: '!sens' })).body.ok, true);
  assert.deepEqual((await r.call('/admin')).body.botCommands.commands.map((c) => c.name), ['!hug', '!nt', '!sensitivity']);
  r.commandCooldowns.clear();
  assert.equal((await r.say('u1', 'alice', '!sens')).reply, '');
  assert.equal((await admin('deleteCommand', { name: 'hug' })).body.botCommands.commands.length, 2);
  // A reply the cap would drop doesn't count or start the cooldown.
  r.commandCooldowns.clear();
  r.botReplies = Array(14).fill(Date.now());
  assert.equal((await r.say('u1', 'alice', '!nt')).reason, 'reply_limit');
  r.botReplies = [];
  assert.equal((await r.say('u1', 'alice', '!nt')).reply, 'Nesszerra has tried 4 times!');
  // A reply that can outgrow a chat line saves with a warning and is cut at a word break.
  assert.equal(saved.body.warning, undefined);
  const long = await admin('saveCommand', { name: 'long', reply: '${user} '.repeat(10) + 'x'.repeat(300) });
  assert.deepEqual([long.body.ok, long.body.warning, long.body.longest, long.body.max], [true, 'reply_may_be_cut', 560, 480]);
  const cut = (await r.say('u3', 'abcdefghijklmnopqrstuvwxy', '!long')).reply;
  assert.ok(cut.length <= 480 && cut.endsWith('abcdefghijklmnopqrstuvwxy…'), cut);
});

test('chat bot status: heard, sent and dropped replies, held-back replies and !fray debug for mods', async () => {
  const r = botRoom({});
  await r.save('u1', 'alice');
  await r.connectChat('sub-bot');
  assert.deepEqual((({ heardAt, sent, failed }) => [heardAt, sent, failed])((await r.call('/admin')).body.botStatus), [0, 0, 0]);
  await r.say('u1', 'alice', '!elo');
  await r.call('/bot-sent', { method: 'POST', body: { results: [{ sent: true, reason: '' }] } });
  await r.call('/bot-sent', { method: 'POST', body: { results: [{ sent: false, reason: 'msg_duplicate' }] } });
  const s = (await r.call('/admin')).body.botStatus;
  assert.equal(s.heard, 'alice !elo');
  assert.ok(s.heardAt > 0 && s.sentAt > 0 && s.failedAt >= s.sentAt);
  assert.deepEqual([s.sent, s.failed, s.failedReason, s.failedText], [1, 1, 'msg_duplicate', 'the same line twice within 30 s (msg_duplicate)']);
  assert.match((await r.call('/dev/logs?source=warn')).body[0].message, /^bot reply dropped: the same line twice/);
  // !fray debug: broadcaster, mods and the bot get the status line; viewers get a no
  const line = (await r.say('u2', 'modmia', '!fray debug', { mod: true })).reply;
  assert.match(line, /^PixFray debug: chat connected · last command alice !elo \d+ s · replies 1 sent, 1 dropped \(last drop \d+ s: the same line twice within 30 s \(msg_duplicate\)\) · \d+\/18 replies in 30 s · reminder off$/);
  assert.match((await r.say('u1', 'alice', '!fray debug')).reply, /only the broadcaster or a mod/);
  // An old subscription's line, and the reply cap, are held back, noted and logged.
  await r.call('/eventsub', { method: 'POST', body: { messageId: 'old1', messageType: 'notification', bot: true, botId: 'u9', timestamp: Date.now(), subscription: { id: 'sub-old' }, event: { chatter_user_id: 'u1', chatter_user_login: 'alice', message_id: 'o1', message: { text: '!elo' } } } });
  assert.equal((await r.call('/admin')).body.botStatus.heldReason, 'unknown_subscription');
  for (let i = 0; i < 20; i++) await r.say('u1', 'alice', '!elo');
  assert.equal((await r.call('/admin')).body.botStatus.heldReason, 'reply_limit');
  const warns = (await r.call('/dev/logs?source=warn')).body.map((x) => x.message);
  assert.ok(warns.includes('bot reply held back: unknown_subscription') && warns.includes('bot reply held back: reply_limit'));
  assert.equal(warns.filter((m) => m === 'bot reply held back: reply_limit').length, 1, 'once a minute per reason');
});

// The reminder posts through Helix as the bot. Twitch is faked: an app token, then every chat line is recorded.
// down: true makes every chat send fail (Twitch 503).
function fakeTwitch() {
  const sent = [], real = globalThis.fetch;
  const AUTH = { idFromName: () => 'auth', get: () => ({ fetch: async () => Response.json(null) }) };
  const tw = { sent, down: false, env: { AUTH, AUTH_SECRET: 'test-auth-secret', TWITCH_CLIENT_ID: 'cid' }, restore: () => { globalThis.fetch = real; } };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith('https://id.twitch.tv/oauth2/token')) return Response.json({ access_token: 'app', expires_in: 3600 });
    if (url.endsWith('/helix/chat/messages')) {
      if (tw.down) return new Response('unavailable', { status: 503 });
      sent.push(JSON.parse(init.body)); return Response.json({ data: [{ is_sent: true }] });
    }
    throw new Error('unexpected fetch ' + url);
  };
  return tw;
}

test('chat bot reminder: off by default; on, it posts the !fray line as the bot each interval, only while live', async () => {
  const tw = fakeTwitch();
  try {
    const r = botRoom(tw.env);
    await r.save('u1', 'alice');
    await r.connectChat('sub-bot');
    await r.say('u1', 'alice', '!elo');   // the room learns the bot (u9) and the channel (owner1)
    assert.equal(r.reminderDue(r.readState('nesszerra')), 0, 'off by default');
    const state = r.readState('nesszerra');
    r.writeState({ ...state, config: { ...state.config, reminderMin: 30 } });
    const due = r.reminderDue(r.readState('nesszerra'));
    assert.ok(due > Date.now() + 29 * 60000 && due <= Date.now() + 30 * 60000, 'first one a full interval out');
    await r.scheduleAlarm(r.readState('nesszerra'));
    assert.ok(r.ctx.storage.alarm <= due);
    // Offline: nothing posted, and it waits another interval.
    await r.call('/dev-live', { method: 'POST', body: { live: false } });
    await r.postReminder('nesszerra', due);
    assert.equal(tw.sent.length, 0);
    assert.equal(r.reminderDue(r.readState('nesszerra'), due), due + 30 * 60000);
    // Live: one line from the bot in the channel, with this channel's names and link.
    await r.call('/dev-live', { method: 'POST', body: { live: true } });
    await r.postReminder('nesszerra', due + 30 * 60000);
    assert.equal(tw.sent.length, 1);
    assert.equal(tw.sent[0].broadcaster_id, 'owner1');
    assert.equal(tw.sent[0].sender_id, 'u9');
    assert.match(tw.sent[0].message, /^PixFray duels: gear up at https:\/\/staging\.example\/\?channel=nesszerra.*Again\? !rematch\. More: !checkin !wallet !ranks !look$/);
    await r.postReminder('nesszerra', due + 30 * 60000 + 1000);
    assert.equal(tw.sent.length, 1, 'not again until the next interval');
    // Turned off, or the bot disconnected: nothing due.
    r.writeState({ ...r.readState('nesszerra'), config: { ...r.readState('nesszerra').config, reminderMin: 0 } });
    assert.equal(r.reminderDue(r.readState('nesszerra')), 0);
  } finally { tw.restore(); }
});

test('chat bot: an unanswered challenge gets a "challenge expired" line, from the alarm or the next command, once', async () => {
  const tw = fakeTwitch();
  try {
    const r = botRoom(tw.env);
    await r.save('u1', 'alice'); await r.save('u2', 'bob');
    await r.connectChat('sub-bot');
    const expire = () => { const s = r.readState('nesszerra'); for (const d of s.duels) if (d.status === 'pending') d.expiresAt = Date.now() - 1; r.writeState(s); };
    // The alarm notices it: the bot posts the line itself, and it counts as a sent reply.
    assert.match((await r.say('u1', 'alice', '!challenge @bob')).reply, /alice challenges @bob/);
    expire();
    await r.alarm();
    assert.deepEqual(tw.sent.map((m) => [m.sender_id, m.message]), [['u9', "Challenge expired: @bob didn't answer alice within 30 s. alice, try again with !challenge @bob"]]);
    assert.equal((await r.call('/admin')).body.botStatus.sent, 1);
    await r.alarm();
    assert.equal(tw.sent.length, 1, 'said once');
    // A later command notices it first: the line comes before that command's reply, and the alarm doesn't repeat it.
    await r.say('u1', 'alice', '!challenge @bob');
    expire();
    const late = await r.say('u2', 'bob', '!fight');
    assert.match(late.replies[0], /^Challenge expired: @bob didn't answer alice/);
    assert.match(late.replies[1], /nobody has challenged you yet/);
    await r.alarm();
    assert.equal(tw.sent.length, 1);
  } finally { tw.restore(); }
});

test('chat bot: after the stream has played a duel, the bot says who won and the Elo change, once', async () => {
  const tw = fakeTwitch();
  try {
    const r = botRoom(tw.env);
    await r.save('u1', 'alice'); await r.save('u2', 'bob');
    await r.connectChat('sub-bot');
    await r.say('u1', 'alice', '!challenge @bob');
    assert.match((await r.say('u2', 'bob', '!fight')).replies.join(' '), /Watch the stream for the winner/);
    const duel = r.readState('nesszerra').duels.find((d) => d.status === 'completed');
    assert.ok(duel.revealAt > Date.now());
    await r.scheduleAlarm(r.readState('nesszerra'));
    assert.ok(r.ctx.storage.alarm <= duel.revealAt + 1, 'the alarm wakes for the reveal');
    await r.alarm();
    assert.equal(tw.sent.length, 0, 'nothing before the stream has shown it');
    const s = r.readState('nesszerra'); s.duels.find((d) => d.id === duel.id).revealAt = Date.now() - 1; r.writeState(s);
    await r.alarm();
    const [w, l] = duel.winnerId === 'u1' ? ['alice', 'bob'] : ['bob', 'alice'];
    assert.equal(tw.sent.length, 1);
    assert.match(tw.sent[0].message, new RegExp(`^${w} beat ${l}(?: on HP| in sudden death)?(?:, flawless)?! ${w} \\d+ Elo \\(\\+\\d+\\), ${l} \\d+ Elo \\(-\\d+\\)\\.$`));
    await r.alarm();
    assert.equal(tw.sent.length, 1, 'said once');
  } finally { tw.restore(); }
});

test('chat bot: a result line survives a full reply cap, a Twitch outage, a missed alarm and an alarm error', async () => {
  const tw = fakeTwitch();
  try {
    const r = botRoom(tw.env);
    await r.save('u1', 'alice'); await r.save('u2', 'bob'); await r.save('u3', 'cara');
    await r.connectChat('sub-bot');
    const reveal = () => { const s = r.readState('nesszerra'); for (const d of s.duels) if (d.revealAt > Date.now()) d.revealAt = Date.now() - 1; r.writeState(s); };
    const duel = async ({ shown = true } = {}) => {
      await r.say('u1', 'alice', '!challenge @bob'); await r.say('u2', 'bob', '!fight');
      const s = r.readState('nesszerra'); s.rematchLocks = []; for (const p of s.players) p.respawnAt = 0; r.writeState(s);
      if (shown) reveal();
    };
    const results = () => tw.sent.filter((m) => / beat /.test(m.message)).length;
    // A viewer spamming commands fills only the command share of the cap; the result still goes out.
    await duel({ shown: false });
    for (let i = 0; i < 20; i++) await r.say('u3', 'cara', '!elo');
    assert.equal(r.botStatus().heldReason, 'reply_limit', 'commands hit their share of the cap');
    reveal();
    await r.alarm();
    assert.equal(results(), 1, 'the reserved lines carry the result');
    // Twitch down: the line stays due and the alarm comes back within seconds, then it goes out once.
    r.botReplies = [];
    tw.down = true;
    await duel();
    await r.alarm();
    assert.equal(results(), 1);
    assert.ok(r.ctx.storage.alarm <= Date.now() + 5000, 'retried soon');
    tw.down = false;
    await r.alarm();
    assert.equal(results(), 2);
    await r.alarm();
    assert.equal(results(), 2, 'once');
    // The alarm never ran: the next command posts the result before its own reply.
    await duel();
    const before = tw.sent.length;
    await r.say('u3', 'cara', '!look');
    assert.equal(results(), 3);
    assert.match(tw.sent[before].message, / beat /);
    // An error inside the alarm is logged and the next alarm is still set.
    const real = r.postReminder;
    r.postReminder = async () => { throw new Error('boom'); };
    await duel();
    r.ctx.storage.alarm = null;
    await r.alarm();
    r.postReminder = real;
    assert.equal(results(), 4, 'results go out before the failing step');
    assert.match((await r.call('/dev/logs?source=room')).body[0].message, /^boom$/);
    assert.ok(r.ctx.storage.alarm, 'the alarm is set again');
  } finally { tw.restore(); }
});

test('chat bot: !accept, !duel and !top are hidden aliases, unless the channel uses those names', async () => {
  const r = botRoom({});
  await r.save('u1', 'alice'); await r.save('u2', 'bob');
  await r.connectChat('sub-bot');
  assert.match((await r.say('u1', 'alice', '!duel @bob')).reply, /^alice challenges @bob!/);
  assert.match((await r.say('u2', 'bob', '!ACCEPT')).reply, /^Fight on: alice vs bob!/);
  assert.match((await r.say('u1', 'alice', '!top')).reply, /^Top \d: /);
  // Trailing punctuation still names the viewer.
  assert.match((await r.say('u1', 'alice', '!elo @bob,')).reply, /^bob: /);
  // A channel that renamed !challenge to !duel keeps its own meaning; a custom !top command wins over the alias.
  const admin = async (action, payload) => (await r.call('/admin', { method: 'POST', body: { actorId: 'owner1', actorName: 'nesszerra', action, payload } }));
  assert.equal((await admin('saveCommand', { name: '!top', reply: 'custom top' })).body.ok, true);
  assert.equal((await r.say('u1', 'alice', '!top')).reply, 'custom top');
});

test('!checkin does not count a win the stream has not shown yet', async () => {
  const r = botRoom({ DEV_TOOLS_TOKEN: 'x'.repeat(40) });
  await r.save('u1', 'alice'); await r.save('u2', 'bob');
  await r.connectChat('sub-bot');
  await r.call('/dev-live', { method: 'POST', body: { live: true, streamId: 's1' } });
  await r.say('u1', 'alice', '!challenge @bob'); await r.say('u2', 'bob', '!fight');
  const d = r.readState('nesszerra').duels.find((x) => x.status === 'completed');
  assert.ok(d.revealAt > Date.now());
  const winner = d.winnerId === 'u1' ? ['u1', 'alice'] : ['u2', 'bob'];
  assert.match((await r.say(winner[0], winner[1], '!checkin')).reply, / 1 of 20 points\./, 'the hidden win is not counted');
});

test('debug bot: a challenge aimed at the bot is fought back, !fray spar challenges you; off without BOT_DEBUG', async () => {
  const r = botRoom({ BOT_DEBUG: '1' });
  await r.save('u1', 'alice'); await r.save('u9', 'pixbot');
  await r.connectChat('sub-bot');
  await r.call('/dev-live', { method: 'POST', body: { live: false } });
  const fought = await r.say('u1', 'alice', '!challenge @pixbot');
  assert.equal(fought.replies.length, 2);
  assert.match(fought.replies[0], /alice challenges @pixbot/);
  assert.match(fought.replies[1], /Fight on: alice vs pixbot/);
  assert.ok(r.readState('nesszerra').duels.some((d) => d.status === 'completed' && d.a === 'u1' && d.b === 'u9'));
  await sleep(10);
  const s = r.readState('nesszerra'); s.rematchLocks = []; for (const p of s.players) p.respawnAt = 0; for (const d of s.duels) d.revealAt = 0; r.writeState(s);
  const spar = await r.say('u1', 'alice', '!fray spar');
  assert.deepEqual(spar.replies.length, 1);
  assert.match(spar.reply, /pixbot challenges @alice/);
  assert.ok(r.readState('nesszerra').duels.some((d) => d.status === 'pending' && d.a === 'u9' && d.b === 'u1'));
  assert.match((await r.say('u9', 'pixbot', '!fray spar')).reply, /can't spar with itself/);

  const plain = botRoom({});
  await plain.save('u1', 'alice'); await plain.save('u9', 'pixbot');
  await plain.connectChat('sub-bot');
  // Without BOT_DEBUG the bot account is refused as a rival or a wallet.
  const once = await plain.say('u1', 'alice', '!challenge @pixbot');
  assert.deepEqual(once.replies, ["The bot doesn't fight (yet)! Name a rival: !challenge @name"]);
  assert.ok(!plain.readState('nesszerra').duels.length, 'no challenge opened');
  assert.equal((await plain.say('u1', 'alice', '!give @pixbot 5')).reply, "The bot doesn't take dollars. Give them to a rival!");
  assert.match((await plain.say('u1', 'alice', '!fray spar')).reply, /gear up/i, 'spar is just the help reply');
});

test('debug bot: !fray e2e plays every command once against the asker and posts which steps passed', async () => {
  const r = botRoom({ BOT_DEBUG: '1' });
  await r.save('u1', 'alice'); await r.save('u9', 'pixbot');
  await r.connectChat('sub-bot');
  await r.call('/dev-live', { method: 'POST', body: { live: false } });
  assert.match((await r.say('u1', 'alice', '!fray e2e')).reply, /only the broadcaster or a mod/);
  const run = await r.say('u1', 'alice', '!fray e2e', { mod: true });
  assert.match(run.replies[0], /^PixFray e2e, pixbot vs alice: 17 of 17 steps passed\.$/);
  const detail = run.replies.slice(1).join(' · ');
  assert.doesNotMatch(detail, /FAIL/);
  assert.match(detail, /checkin ok \(not_live\)/);
  assert.match(detail, /fight by alice ok \(quick_duel\)/);
  assert.ok(run.replies.every((line) => line.length <= 480));
  const state = r.readState('nesszerra');
  assert.equal(state.duels.filter((d) => d.status === 'pending' || d.status === 'active').length, 0, 'the run leaves no open duel');
  // Right after, the pair is still in its cooldown: the run stops at the first challenge and says so.
  const again = await r.say('u1', 'alice', '!fray e2e', { mod: true });
  assert.match(again.replies[0], /stopped early/);
  assert.match(again.replies.slice(1).join(' '), /FAIL challenge @alice/);
  // The bot account names an opponent; nobody needs a fighter it doesn't have.
  assert.match((await r.say('u9', 'pixbot', '!fray e2e')).reply, /name the opponent/);
  assert.match((await r.say('u9', 'pixbot', '!fray e2e @nobody')).reply, /@nobody has no saved fighter/);
  assert.match((await r.say('owner1', 'nesszerra', '!fray e2e')).reply, /@nesszerra has no saved fighter/);
});

test('!checkin test mode: answers while offline with what a check-in would give, saves nothing, ends by itself, and steps aside when live', async (t) => {
  const r = room({ DEV_TOOLS_TOKEN: 'x'.repeat(40) }, { quick: true });
  const se = (await r.call('/admin')).body.streamelements;
  let m = 0;
  const say = async (id, login) => (await r.call('/se?origin=https%3A%2F%2Ftest.example', { method: 'POST', body: { key: se.secret, action: 'checkin', userId: id, username: login, displayName: login, messageId: 't' + (++m) } })).body.reply;
  const live = (body) => r.call('/dev-live', { method: 'POST', body });
  const test = (on) => r.call('/checkin-test', { method: 'POST', body: { on, by: 'ModMia' } });
  await r.save('u1', 'alice');
  await live({ live: true, streamId: 's1' });
  assert.match(await say('u1', 'alice'), /^@alice checked in: \+1 upgrade point \(1-stream streak\)/);
  await live({ live: false });
  assert.equal((await r.call('/admin')).body.checkinTest, null);
  const on = (await test(true)).body.checkinTest;
  assert.equal(on.by, 'ModMia');
  assert.ok(on.until > Date.now() + 14 * 60_000 && on.until <= Date.now() + 15 * 60_000);
  assert.deepEqual((await r.call('/admin')).body.checkinTest, on);
  const before = (await r.call('/profile?userId=u1')).body;
  const reply = '[Test, not saved] @alice would check in: +1 upgrade point (2-stream streak). 2 of 20 points.';
  assert.equal(await say('u1', 'alice'), reply, 'the next stream continues the streak');
  assert.equal(await say('u1', 'alice'), reply, 'repeatable: nothing was saved');
  const after = (await r.call('/profile?userId=u1')).body;
  assert.deepEqual([after.bonus, after.checkins, after.streak], [before.bonus, before.checkins, before.streak]);
  assert.equal(r.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM streams').toArray()[0].n, 1, 'no stream row for a test');
  assert.match(await say('u2', 'bob'), /no fighter/, 'a viewer without a fighter still hears how to get one');
  // live wins over test mode: a real check-in, saved
  await live({ live: true, streamId: 's2' });
  assert.match(await say('u1', 'alice'), /^@alice checked in: \+1 upgrade point \(2-stream streak\)/);
  await live({ live: false });
  assert.equal((await test(false)).body.checkinTest, null);
  assert.equal(await say('u1', 'alice'), 'Check-ins open while nesszerra is live. See you next stream!');
  // it switches itself off after 15 minutes
  await test(true);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 15 * 60_000 + 1);
  assert.equal(await say('u1', 'alice'), 'Check-ins open while nesszerra is live. See you next stream!');
  assert.equal((await r.call('/admin')).body.checkinTest, null);
});
