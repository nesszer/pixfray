// Arena client: server times are shifted into the local clock, so a PC with a wrong clock still plays fresh events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createArenaClient } from '../public/arena-client.js';

function harness() {
  globalThis.location = { protocol: 'https:', host: 'test.example' };
  const sockets = [], events = [], snapshots = [], looks = [];
  function FakeSocket() { this.close = () => {}; sockets.push(this); }
  const client = createArenaClient({
    channel: 'nesszerra',
    onSnapshot: (s) => snapshots.push(s),
    onEvent: (e) => events.push(e),
    onLooks: (m) => looks.push(m),
    fetchImpl: () => new Promise(() => {}),
    WebSocketImpl: FakeSocket,
  });
  const send = (payload) => sockets.at(-1).onmessage({ data: JSON.stringify(payload) });
  return { client, events, snapshots, looks, send };
}

test('arena client: a local clock 11 s ahead of the server still sees events as fresh', () => {
  const h = harness();
  const serverNow = Date.now() - 11_000;
  h.send({ type: 'snapshot', revision: 5, serverNow, chat: { connected: true, lastSeen: serverNow - 1000 },
    players: [{ userId: 'a', respawnAt: serverNow + 3000 }, { userId: 'b', respawnAt: 0 }],
    events: [{ id: '5', type: 'duel_completed', at: serverNow - 500, respawnAt: serverNow + 3000 }] });
  const e = h.events[0];
  assert.ok(Math.abs(Date.now() - 500 - e.at) < 200, 'event time converted to the local clock');
  assert.ok(Math.abs(Date.now() + 3000 - e.respawnAt) < 200);
  const s = h.snapshots[0];
  assert.ok(Math.abs(Date.now() + 3000 - s.players[0].respawnAt) < 200);
  assert.equal(s.players[1].respawnAt, 0, 'zero stays zero');
  assert.ok(Math.abs(Date.now() - 1000 - s.chat.lastSeen) < 200);
  h.client.disconnect();
});

test('arena client: a looks push goes to onLooks, not to events, and leaves the revision alone', () => {
  const h = harness();
  h.send({ type: 'snapshot', revision: 7, players: [], events: [] });
  h.send({ type: 'looks', looks: { cleo: null }, reset: true });
  h.send({ type: 'looks' });   // no looks map: dropped
  assert.deepEqual(h.looks, [{ type: 'looks', looks: { cleo: null }, reset: true }]);
  assert.equal(h.events.length, 0);
  h.send({ type: 'event', revision: 7, event: { id: '8', type: 'challenge_created', at: Date.now() } });
  assert.equal(h.events.length, 1, 'an event at the same revision still plays');
  h.client.disconnect();
});

test('arena client: snapshots without serverNow pass through unchanged', () => {
  const h = harness();
  const at = Date.now() - 2000;
  h.send({ type: 'snapshot', revision: 1, players: [], events: [{ id: '1', type: 'challenge_created', at }] });
  assert.equal(h.events[0].at, at);
  h.client.disconnect();
});

// Watchdog: the server sends no pings, so a half-open socket looks like a quiet arena. After 45 s of silence the client
// asks /api/state and reconnects only if the arena moved on.
function watchdogHarness(stateRevision) {
  globalThis.location = { protocol: 'https:', host: 'test.example' };
  const sockets = [], snapshots = [], fetches = [];
  function FakeSocket() { this.closed = false; this.close = () => { this.closed = true; }; sockets.push(this); }
  const client = createArenaClient({
    channel: 'nesszerra',
    onSnapshot: (s) => snapshots.push(s),
    fetchImpl: async (url) => {
      fetches.push(url);
      if (fetches.length === 1) return new Promise(() => {});   // the initial snapshot fetch never answers
      return { ok: true, json: async () => ({ type: 'snapshot', revision: stateRevision(), players: [], events: [] }) };
    },
    WebSocketImpl: FakeSocket,
  });
  const send = (payload) => sockets.at(-1).onmessage({ data: JSON.stringify(payload) });
  return { client, sockets, snapshots, fetches, send };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('arena client watchdog: 45 s of silence and a newer /api/state revision reconnects the socket', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let revision = 5;
  const h = watchdogHarness(() => revision);
  h.send({ type: 'snapshot', revision: 5, players: [], events: [] });
  t.mock.timers.tick(44_999);
  await flush();
  assert.equal(h.fetches.length, 1, 'no state fetch before 45 s');
  revision = 8;   // the arena moved on while the socket said nothing
  t.mock.timers.tick(1);
  await flush();
  assert.equal(h.fetches.length, 2, 'one /api/state fetch');
  assert.equal(h.fetches[1], '/api/state/nesszerra');
  assert.equal(h.sockets.length, 2, 'a fresh socket was opened');
  assert.equal(h.sockets[0].closed, true, 'the silent one was dropped');
  assert.equal(h.snapshots.at(-1).revision, 8, 'the newer state was applied');
  assert.equal(h.client.revision, 8);
  h.client.disconnect();
});

test('arena client watchdog: an unchanged revision keeps the socket and asks again 45 s later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = watchdogHarness(() => 5);
  h.send({ type: 'snapshot', revision: 5, players: [], events: [] });
  t.mock.timers.tick(45_000);
  await flush();
  assert.equal(h.fetches.length, 2);
  assert.equal(h.sockets.length, 1, 'a quiet arena is not a dead socket');
  t.mock.timers.tick(45_000);
  await flush();
  assert.equal(h.fetches.length, 3, 'the watchdog re-arms');
  h.client.disconnect();
});

test('arena client watchdog: every message restarts the 45 s wait, and disconnect stops it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = watchdogHarness(() => 9);
  t.mock.timers.tick(40_000);
  h.send({ type: 'snapshot', revision: 5, players: [], events: [] });
  t.mock.timers.tick(40_000);
  await flush();
  assert.equal(h.fetches.length, 1, '40 s after the last message is not silence yet');
  h.client.disconnect();
  t.mock.timers.tick(200_000);
  await flush();
  assert.equal(h.fetches.length, 1, 'no checks after disconnect');
});
