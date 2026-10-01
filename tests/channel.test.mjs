// ChannelRoom and AuthStore against real SQLite (node:sqlite) behind a minimal fake DO context.
// Run with: node --import ./tests/register.mjs --test tests/channel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ChannelRoom } from '../server/channel.js';
import { AuthStore } from '../server/auth.js';
import { logRoomError } from '../server/developer.js';

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
function room() {
  const ctx = fakeCtx();
  const r = new ChannelRoom(ctx, { INTERNAL_SECRET: SECRET });
  r.call = async (path, { method = 'GET', body, userId, secret = SECRET } = {}) => {
    const headers = { 'X-Mini-Internal': secret, 'X-Mini-Channel': 'nesszerra' };
    if (userId) headers['X-Mini-User-Id'] = userId;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await r.fetch(new Request('https://room' + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
  r.save = (id, login, extra = {}) => r.call('/profile', { method: 'POST', userId: id, body: { userId: id, username: login, displayName: login, avatar: 'player', color: '#123456', defaultAbility: 'strike', ...extra } });
  r.connectRelay = async (sessionId = 's1') => {
    const ws = fakeSocket({ kind: 'relay', sessionId, channel: 'nesszerra' }, 'relay');
    ctx.sockets.push(ws);
    r.advance('nesszerra', { type: 'relay_connected', sessionId }, Date.now());
    await r.webSocketMessage(ws, JSON.stringify({ type: 'heartbeat', twitchConnected: true }));
    return ws;
  };
  let n = 0;
  r.chat = (ws, id, login, text) => r.webSocketMessage(ws, JSON.stringify({ type: 'command', messageId: 'm' + (++n), userId: id, username: login, displayName: login, text, timestamp: Date.now() }));
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

test('relay commands run a full duel; Elo persists to the leaderboard; overlays get snapshots', async () => {
  const r = room();
  await r.save('u1', 'alice');
  await r.save('u2', 'bob');
  const live = r.live();
  const relay = await r.connectRelay();
  await r.chat(relay, 'u1', 'alice', '!challenge @bob');
  await r.chat(relay, 'u2', 'bob', '!accept');
  assert.equal(relay.sent.at(-1).type, 'ack');
  assert.equal(relay.sent.at(-1).ok, true);
  for (let i = 0; i < 4; i++) {
    await r.chat(relay, 'u1', 'alice', '!heavy');
    // The first heavy succeeds; later ones hit the 8 s cooldown. Force the cooldown clear for the test.
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
  const board = (await r.call('/leaderboard')).body;
  assert.deepEqual(board.map((p) => [p.username, p.elo, p.wins, p.losses]), [['alice', 1012, 1, 0], ['bob', 988, 0, 1]]);
  assert.ok(live.sent.length > 3);
  assert.equal(live.sent.at(-1).type, 'snapshot');
  assert.equal(live.sent.at(-1).revision, state.revision);
  assert.equal('appliedMessageIds' in live.sent.at(-1), false, 'internal bookkeeping is not broadcast');
});

test('unregistered chatters can be seen but cannot duel; bad relay messages close the socket', async () => {
  const r = room();
  await r.save('u1', 'alice');
  const relay = await r.connectRelay();
  await r.chat(relay, 'g1', 'guest', '!challenge @alice');
  assert.deepEqual([relay.sent.at(-1).ok, relay.sent.at(-1).reason], [false, 'ranked_sign_in_required']);
  await r.webSocketMessage(relay, 'not json');
  assert.equal(relay.closed[0], 1007);
});

test('relay drop cancels open duels without scoring', async () => {
  const r = room();
  await r.save('u1', 'alice');
  await r.save('u2', 'bob');
  const relay = await r.connectRelay();
  await r.chat(relay, 'u1', 'alice', '!challenge @bob');
  await r.chat(relay, 'u2', 'bob', '!accept');
  await r.chat(relay, 'u1', 'alice', '!strike');
  await r.webSocketClose(relay);
  const state = (await r.call('/state')).body;
  assert.equal(state.duels[0].status, 'cancelled');
  assert.equal(state.paused, true);
  const board = (await r.call('/leaderboard')).body;
  assert.ok(board.every((p) => p.elo === 1000 && p.wins === 0 && p.losses === 0));
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
  assert.equal(after.config.abilities.heavy.damage, 25);
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

test('disconnectRelay closes the relay socket and pauses combat', async () => {
  const r = room();
  const relay = await r.connectRelay();
  assert.equal((await r.call('/state')).body.relay.connected, true);
  const res = await r.call('/admin', { method: 'POST', body: { actorId: 'owner', action: 'disconnectRelay' } });
  assert.equal(res.status, 200);
  assert.equal(relay.closed[0], 4003);
  assert.equal((await r.call('/state')).body.relay.connected, false);
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
