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

// Ping and watchdog: the client sends "ping" every 20 s, the room's auto-response answers "pong", and a socket with no
// message at all for 45 s is half open, so it gets replaced. No /api/state polling.
function watchdogHarness() {
  globalThis.location = { protocol: 'https:', host: 'test.example' };
  const sockets = [], snapshots = [], events = [], fetches = [];
  function FakeSocket() { this.readyState = 0; this.sent = []; this.closed = false; this.send = (m) => this.sent.push(m); this.close = () => { this.closed = true; this.readyState = 3; }; sockets.push(this); }
  const client = createArenaClient({
    channel: 'nesszerra',
    onSnapshot: (s) => snapshots.push(s),
    onEvent: (e) => events.push(e),
    fetchImpl: (url) => { fetches.push(url); return new Promise(() => {}); },
    WebSocketImpl: FakeSocket,
  });
  const open = () => { const ws = sockets.at(-1); ws.readyState = 1; ws.onopen(); };
  const send = (data) => sockets.at(-1).onmessage({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  return { client, sockets, snapshots, events, fetches, open, send };
}

test('arena client ping: an open socket sends "ping" every 20 s, and "pong" keeps it without polling /api/state', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = watchdogHarness();
  h.open();
  h.send({ type: 'snapshot', revision: 5, players: [], events: [] });
  const fetched = h.fetches.length;
  for (let i = 0; i < 6; i++) { t.mock.timers.tick(20_000); h.send('pong'); }
  assert.equal(h.sockets[0].sent.filter((m) => m === 'ping').length, 6, 'one ping per 20 s');
  assert.equal(h.sockets.length, 1, 'answered pings keep the socket');
  assert.equal(h.fetches.length, fetched, 'no /api/state polling');
  assert.equal(h.snapshots.length, 1, 'pong is not a snapshot');
  assert.equal(h.events.length, 0, 'or an event');
  h.client.disconnect();
});

test('arena client watchdog: 45 s with no pong or message replaces the socket', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = watchdogHarness();
  h.open();
  h.send({ type: 'snapshot', revision: 5, players: [], events: [] });
  const fetched = h.fetches.length;
  t.mock.timers.tick(44_999);
  assert.equal(h.sockets.length, 1, 'two pings unanswered is not yet 45 s');
  t.mock.timers.tick(1);
  assert.equal(h.sockets.length, 2, 'a fresh socket was opened');
  assert.equal(h.sockets[0].closed, true, 'the silent one was dropped');
  assert.equal(h.fetches.length, fetched, 'the watchdog itself fetches nothing; the new socket asks for state once it opens');
  t.mock.timers.tick(20_000);
  assert.equal(h.sockets[0].sent.length, 2, 'the dropped socket gets no more pings');
  assert.equal(h.sockets[1].sent.length, 0, 'a socket that is still connecting gets none either');
  h.client.disconnect();
});

test('arena client watchdog: every message restarts the 45 s wait, and disconnect stops pings and the watchdog', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = watchdogHarness();
  h.open();
  t.mock.timers.tick(40_000);
  h.send({ type: 'snapshot', revision: 5, players: [], events: [] });
  t.mock.timers.tick(40_000);
  assert.equal(h.sockets.length, 1, '40 s after the last message is not silence yet');
  h.client.disconnect();
  const sent = h.sockets[0].sent.length;
  t.mock.timers.tick(200_000);
  assert.equal(h.sockets.length, 1, 'no reconnect after disconnect');
  assert.equal(h.sockets[0].sent.length, sent, 'no pings after disconnect');
});
