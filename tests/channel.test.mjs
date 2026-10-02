// ChannelRoom and AuthStore against real SQLite (node:sqlite) behind a minimal fake DO context.
// Run with: node --import ./tests/register.mjs --test tests/channel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ChannelRoom } from '../server/channel.js';
import { AuthStore } from '../server/auth.js';
import { logRoomError } from '../server/developer.js';
import { createInitialState, defaultConfig } from '../server/game.js';

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
    async setAlarm(t) { this.alarm = t; },
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
  assert.deepEqual(view.customUsage, { count: 0, limit: 8, bytes: 0 });
  const rb = await r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'rollbackConfig', payload: { version: 1 } } });
  assert.equal(rb.status, 200);
  assert.equal(rb.body.configVersion, 3);
  const after = (await r.call('/admin')).body;
  assert.equal(after.config.abilities.heavy.damage, 35);
  assert.equal(after.history[0].note, 'rollback to v1');
  assert.equal((await r.call('/admin', { method: 'POST', body: { actorId: 'mod1', action: 'rollbackConfig', payload: { version: 99 } } })).status, 404);
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
  assert.equal((await r.call('/asset')).body.usage.limit, 8);
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
  assert.match((await cmd('u1', 'alice', 'challenge', 'bob')).body.reply, /paused/);   // not the chat source yet
  assert.ok((await admin()).streamelements.lastCommandAt > 0, 'a command with the right key is recorded');
  await r.call('/chat', { method: 'POST', body: { action: 'connected', subscriptionId: 'se-streamelements', status: 'enabled', createdAt: Date.now() } });
  assert.equal((await admin()).chatStatus.source, 'streamelements');
  assert.match((await cmd('u1', 'alice', 'challenge', 'bob')).body.reply, /saved fighter/);
  await r.save('u1', 'alice'); await r.save('u2', 'bob');
  assert.match((await cmd('u1', 'alice', 'challenge')).body.reply, /who\?/);
  assert.match((await cmd('u1', 'alice', 'challenge', 'alice')).body.reply, /can't duel yourself/);
  assert.match((await cmd('u1', 'alice', 'challenge', 'bob')).body.reply, /alice challenges @bob.*!fight/);
  // Quick duels are off in this room, but StreamElements has no attack commands, so !fight settles the duel at once.
  assert.match((await cmd('u2', 'bob', 'accept')).body.reply, /^(alice|bob) beats (alice|bob) /);
  assert.equal(r.readState('nesszerra').duels.filter((d) => d.status === 'active').length, 0);
  assert.match((await cmd('u1', 'alice', 'heavy')).body.reply, /attack commands are gone/);
  // Renamed commands show up in replies; duplicates and bad names are refused.
  assert.equal((await r.call('/se-admin', { method: 'POST', body: { action: 'setSeNames', names: { accept: '!yes', decline: 'no' } } })).body.streamelements.names.decline, '!no');
  assert.equal((await r.call('/se-admin', { method: 'POST', body: { action: 'setSeNames', names: { accept: '!challenge' } } })).status, 400);
  assert.equal((await r.call('/se-admin', { method: 'POST', body: { action: 'setSeNames', names: { accept: 'bad name' } } })).status, 400);
  const rotated = (await r.call('/se-admin', { method: 'POST', body: { action: 'rotateSeKey' } })).body.streamelements;
  assert.notEqual(rotated.secret, se.secret);
  assert.deepEqual([rotated.lastCommandAt, rotated.rejectedAt], [0, 0], 'a new key starts unheard');
  assert.equal((await cmd('u1', 'alice', 'decline')).status, 403);
  // Disconnecting the StreamElements source never calls Twitch and pauses duels.
  await r.call('/chat', { method: 'POST', body: { action: 'disconnected', reason: 'disconnected' } });
  assert.match((await cmd('u1', 'alice', 'decline', '', rotated.secret)).body.reply, /paused/);
});

test('SE_ONLY: a StreamElements command with the right key makes StreamElements the chat source', async () => {
  const r = room({ SE_ONLY: '1' }, { quick: true });
  const se = (await r.call('/admin')).body.streamelements;
  await r.connectChat('sub-1');   // a Twitch subscription from before the switch
  const cmd = (key) => r.call('/se?origin=https%3A%2F%2Ftest.example', { method: 'POST', body: { key, action: 'decline', userId: 'u1', username: 'alice', displayName: 'alice', target: '', messageId: 'x' + key.length } });
  assert.equal((await cmd('wrong')).status, 403);
  assert.equal((await r.call('/admin')).body.chatStatus.source, 'twitch', 'a wrong key changes nothing');
  assert.doesNotMatch((await cmd(se.secret)).body.reply, /paused/);
  assert.equal((await r.call('/admin')).body.chatStatus.source, 'streamelements');
});

test('StreamElements quick duel: !fight rolls the dice and settles it in one reply', async () => {
  const r = room({}, { quick: true });
  const se = (await r.call('/admin')).body.streamelements;
  await r.call('/chat', { method: 'POST', body: { action: 'connected', subscriptionId: 'se-streamelements', status: 'enabled', createdAt: Date.now() } });
  await r.save('u1', 'alice'); await r.save('u2', 'bob');
  let m = 0;
  const cmd = (id, login, action, target = '') => r.call('/se?origin=https%3A%2F%2Ftest.example', { method: 'POST', body: { key: se.secret, action, userId: id, username: login, displayName: login, target, messageId: 'q' + (++m) } });
  await cmd('u1', 'alice', 'challenge', 'bob');
  assert.match((await cmd('u2', 'bob', 'accept')).body.reply, /^(alice|bob) beats (alice|bob) (in \d+ rolls?( \(sudden death\))?|on HP after 12 rolls) \((\d+ HP left|100 HP left, flawless, \+3 bonus)\)\. Elo: \w+ (1012|1015), \w+ 988\.$/);
  assert.match((await cmd('u2', 'bob', 'accept')).body.reply, /no pending challenge/);
  // The result is saved, so the next command (which reloads the stored profile) keeps it.
  const saved = Object.fromEntries(r.ctx.storage.sql.exec('SELECT user_id, elo, wins, losses FROM profiles').toArray().map((x) => [x.user_id, x]));
  assert.deepEqual([saved.u1.wins + saved.u2.wins, saved.u1.losses + saved.u2.losses, [2000, 2003].includes(saved.u1.elo + saved.u2.elo)], [1, 1, true]);   // +3 if flawless
  assert.notEqual(saved.u1.elo, 1000);
  // Every command lands in the dev log with what came in, the game's decision and the reply.
  const log = (await r.call('/dev/logs?source=command')).body;
  assert.deepEqual(log.map((x) => x.context.reason).reverse(), ['challenge', 'quick_duel', 'challenge_not_found']);
  assert.match(log[1].context.swings, /^([1-6][hxcm] ?)+$/);
  assert.equal((await r.call('/dev/logs?source=warn')).body.length, 0);
  // A result that didn't reach the stored profile is flagged.
  const state = r.readState('nesszerra');
  state.players.find((p) => p.userId === 'u1').wins += 5;
  r.checkSavedProfiles(state, log[1].context.duelId);
  assert.match((await r.call('/dev/logs?source=warn')).body[0].message, /profile for alice not saved/);
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
  assert.match(fight.body.reply, /testbot_[ab] beats testbot_[ab]/);
  assert.equal((await r.call('/leaderboard')).body.filter((p) => p.wins + p.losses === 1).length, 2, 'Elo and records are saved');
});

test('overlay sockets: one network is capped, and a full room drops an old socket instead of refusing', async () => {
  const r = room();
  const upgrade = (ip) => r.upgrade(new Request('https://room/live', { headers: { Upgrade: 'websocket', 'X-Mini-Client-Ip': ip } }), 'live', 'nesszerra');
  for (let i = 0; i < 16; i++) r.ctx.acceptWebSocket(fakeSocket(null, 'live'), ['live', 'ip:198.51.100.7']);
  const capped = await upgrade('198.51.100.7');
  assert.equal(capped.status, 429);
  for (let i = 16; i < 200; i++) r.ctx.acceptWebSocket(fakeSocket(null, 'live'), ['live', 'ip:203.0.113.' + i]);
  const oldest = r.ctx.sockets[0];
  const saved = globalThis.WebSocketPair;
  globalThis.WebSocketPair = class { constructor() { this[0] = {}; this[1] = fakeSocket(null, 'live'); } };
  try { await upgrade('192.0.2.1').catch(() => {}); }   // Node's Response can't build a 101; the eviction happens first
  finally { globalThis.WebSocketPair = saved; }
  assert.deepEqual(oldest.closed, [1013, 'room full']);
  assert.ok(r.ctx.sockets.at(-1).tags.includes('ip:192.0.2.1'), 'the new socket is tagged with its network');
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
