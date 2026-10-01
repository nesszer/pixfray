// Arena client: server times are shifted into the local clock, so a PC with a wrong clock still plays fresh events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createArenaClient } from '../public/arena-client.js';

function harness() {
  globalThis.location = { protocol: 'https:', host: 'test.example' };
  const sockets = [], events = [], snapshots = [];
  function FakeSocket() { this.close = () => {}; sockets.push(this); }
  const client = createArenaClient({
    channel: 'nesszerra',
    onSnapshot: (s) => snapshots.push(s),
    onEvent: (e) => events.push(e),
    fetchImpl: () => new Promise(() => {}),
    WebSocketImpl: FakeSocket,
  });
  const send = (payload) => sockets.at(-1).onmessage({ data: JSON.stringify(payload) });
  return { client, events, snapshots, send };
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

test('arena client: snapshots without serverNow pass through unchanged', () => {
  const h = harness();
  const at = Date.now() - 2000;
  h.send({ type: 'snapshot', revision: 1, players: [], events: [{ id: '1', type: 'challenge_created', at }] });
  assert.equal(h.events[0].at, at);
  h.client.disconnect();
});
