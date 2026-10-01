// End-to-end relay test against local fakes: Twitch OAuth/Helix (HTTP), EventSub (WebSocket)
// and the Worker relay socket (WebSocket). Nothing touches the network beyond 127.0.0.1.
import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { Relay } from '../relay/lib/relay.mjs';
import { BROADCASTER, CREDENTIAL, startFakes, waitFor } from './relay-fakes.mjs';

function makeRelay(fakes, overrides = {}) {
  const saved = [];
  const config = {
    version: 2,
    backend: { origin: 'http://127.0.0.1:' + fakes.workerPort, channel: 'nesszerra', credential: CREDENTIAL, pairedAt: 0, expiresAt: Date.now() + 86_400_000 },
    twitch: { clientId: 'client123', accessToken: 'access-1', refreshToken: 'refresh-1', userId: BROADCASTER, login: 'nesszerra', scopes: ['user:read:chat'], expiresAt: Date.now() + 3_600_000 },
  };
  const relay = new Relay({
    config, WebSocket, persist: async (next) => { saved.push(next); },
    eventsubUrl: 'ws://127.0.0.1:' + fakes.eventsubPort + '/ws',
    idBase: 'http://127.0.0.1:' + fakes.httpPort,
    helixBase: 'http://127.0.0.1:' + fakes.httpPort + '/helix',
    baseMs: 40, maxMs: 200, ...overrides,
  });
  const fatal = [];
  relay.on('fatal', (f) => fatal.push(f));
  return { relay, saved, fatal };
}

const all = (conn, type) => conn.messages.filter((m) => m.type === type);

test('relay forwards chat, survives a Worker drop and an EventSub migration, and goes offline cleanly', async () => {
  const fakes = await startFakes();
  const { relay, fatal } = makeRelay(fakes);
  try {
    await relay.start();
    const es1 = await waitFor(() => fakes.eventsub.sockets[0], 'EventSub connection');
    assert.equal(es1.path, '/ws');
    const session1 = fakes.eventsub.welcome(es1);
    await waitFor(() => fakes.twitch.subscriptions.length === 1, 'subscription');
    assert.deepEqual(fakes.twitch.subscriptions[0], {
      type: 'channel.chat.message', version: '1',
      condition: { broadcaster_user_id: BROADCASTER, user_id: BROADCASTER },
      transport: { method: 'websocket', session_id: session1 },
    });

    // The Worker socket opens only after Twitch is subscribed; the first heartbeat goes out on hello.
    const w1 = await waitFor(() => fakes.worker.connections[0], 'Worker connection');
    await waitFor(() => all(w1, 'heartbeat').length >= 1, 'first heartbeat');
    assert.equal(all(w1, 'heartbeat')[0].twitchConnected, true);
    await waitFor(() => all(w1, 'heartbeat').length >= 3, 'periodic heartbeats', 2_000);

    // Commands flow as `command`, other chat as throttled `presence`, duplicates are dropped.
    const duelId = fakes.eventsub.chat(es1, '!duel @Bob', { eventId: 'dup-1' });
    fakes.eventsub.chat(es1, '!duel @Bob', { eventId: 'dup-1' }); // Twitch redelivery of the same notification
    fakes.eventsub.chat(es1, 'hello chat', { userId: '3003', login: 'viewer_two' });
    fakes.eventsub.chat(es1, 'second line', { userId: '3003', login: 'viewer_two' });
    fakes.eventsub.chat(es1, '!dance', { userId: '4004', login: 'viewer_three' });
    await waitFor(() => all(w1, 'presence').length === 2 && all(w1, 'command').length === 1, 'forwarded chat');
    const command = all(w1, 'command')[0];
    assert.equal(command.messageId, duelId);
    assert.equal(command.text, '!duel @Bob');
    assert.equal(command.userId, '2002');
    assert.equal(command.username, 'viewer_one');
    assert.ok(Math.abs(command.timestamp - Date.now()) < 5_000);
    assert.deepEqual(all(w1, 'presence').map((p) => p.text), ['hello chat', '!dance']);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(all(w1, 'command').length, 1, 'duplicate notification not forwarded');

    // Worker drop (socket error, code 1006) -> reconnect with backoff, new hello, heartbeat, commands flow.
    w1.ws.terminate();
    const w2 = await waitFor(() => fakes.worker.connections[1], 'Worker reconnect');
    await waitFor(() => all(w2, 'heartbeat').length >= 1, 'heartbeat after reconnect');
    fakes.eventsub.chat(es1, '!strike @viewer_two');
    await waitFor(() => all(w2, 'command').length === 1, 'command after reconnect');

    // EventSub session_reconnect: connect to the new URL, keep subscriptions, close the old socket.
    es1.ws.send(JSON.stringify({ metadata: { message_id: 'r1', message_type: 'session_reconnect', message_timestamp: new Date().toISOString() }, payload: { session: { id: session1, status: 'reconnecting', reconnect_url: 'ws://127.0.0.1:' + fakes.eventsubPort + '/reconnect' } } }));
    const es2 = await waitFor(() => fakes.eventsub.sockets[1], 'EventSub migration socket');
    assert.equal(es2.path, '/reconnect');
    fakes.eventsub.welcome(es2);
    await waitFor(() => es1.closed, 'old EventSub socket closed by the relay');
    fakes.eventsub.chat(es2, '!heal');
    await waitFor(() => all(w2, 'command').length === 2, 'command on migrated session');
    assert.equal(fakes.twitch.subscriptions.length, 1, 'migration does not resubscribe');
    assert.equal(fakes.worker.connections.length, 2, 'migration does not touch the Worker socket');

    // EventSub drop -> fresh session -> resubscribe.
    es2.ws.terminate();
    const es3 = await waitFor(() => fakes.eventsub.sockets[2], 'EventSub reconnect');
    assert.equal(es3.path, '/ws');
    const session3 = fakes.eventsub.welcome(es3);
    await waitFor(() => fakes.twitch.subscriptions.length === 2, 'resubscribe');
    assert.equal(fakes.twitch.subscriptions[1].transport.session_id, session3);
    fakes.eventsub.chat(es3, '!accept');
    await waitFor(() => all(w2, 'command').length === 3, 'command after EventSub reconnect');

    // Clean stop sends offline.
    await relay.stop();
    assert.equal(all(w2, 'offline').length, 1);
    await waitFor(() => w2.closed, 'Worker socket closed');
    assert.deepEqual(fatal, []);
    assert.equal(fakes.worker.authFailures, 0);
  } finally {
    await relay.stop({ offline: false });
    await fakes.close();
  }
});

test('Twitch outage past the grace period reports twitchConnected:false, then the relay rejoins', async () => {
  const fakes = await startFakes({ heartbeatMs: 50 });
  const { relay, fatal } = makeRelay(fakes, { twitchGraceMs: 150 });
  try {
    await relay.start();
    const es1 = await waitFor(() => fakes.eventsub.sockets[0], 'EventSub connection');
    fakes.eventsub.welcome(es1);
    const w1 = await waitFor(() => fakes.worker.connections[0], 'Worker connection');
    await waitFor(() => all(w1, 'heartbeat').length >= 1, 'heartbeat');

    // Make EventSub unreachable for a while: refuse the next sessions by closing them at once.
    fakes.eventsub.refuse = true;
    const refuse = (entry) => { if (fakes.eventsub.refuse) entry.ws.close(4000, 'down'); };
    const timer = setInterval(() => fakes.eventsub.sockets.slice(1).forEach(refuse), 5);
    es1.ws.terminate();
    await waitFor(() => all(w1, 'heartbeat').some((h) => h.twitchConnected === false), 'twitchConnected:false heartbeat');
    await waitFor(() => w1.closed, 'Worker closed the socket with 1012');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fakes.worker.connections.length, 1, 'relay waits for Twitch before reconnecting to the Worker');

    fakes.eventsub.refuse = false;
    clearInterval(timer);
    await new Promise((r) => setTimeout(r, 100)); // let refused sockets finish closing
    const next = await waitFor(() => fakes.eventsub.sockets.find((s) => !s.closed && s !== es1 && !s.welcomed && (s.welcomed = true)), 'new EventSub socket', 5_000);
    fakes.eventsub.welcome(next);
    const w2 = await waitFor(() => fakes.worker.connections[1], 'Worker reconnect after Twitch returns', 5_000);
    await waitFor(() => all(w2, 'heartbeat').some((h) => h.twitchConnected === true), 'healthy heartbeat');
    fakes.eventsub.chat(next, '!strike');
    await waitFor(() => all(w2, 'command').length === 1, 'commands flow again');
    assert.deepEqual(fatal, []);
  } finally {
    await relay.stop({ offline: false });
    await fakes.close();
  }
});

test('expired access token is refreshed, persisted, and used for the subscription', async () => {
  const fakes = await startFakes();
  fakes.twitch.accessToken = 'server-side-only'; // the stored access-1 token no longer validates
  const { relay, saved, fatal } = makeRelay(fakes);
  try {
    // Refresh rotates to access-2 on the fake server.
    await relay.start();
    assert.equal(fakes.twitch.refreshes, 1);
    assert.equal(saved.at(-1).twitch.accessToken, 'access-2');
    assert.equal(saved.at(-1).twitch.refreshToken, 'refresh-2');
    const es1 = await waitFor(() => fakes.eventsub.sockets[0], 'EventSub connection');
    fakes.eventsub.welcome(es1);
    await waitFor(() => fakes.twitch.subscriptions.length === 1, 'subscription with refreshed token');
    await waitFor(() => fakes.worker.connections[0], 'Worker connection');
    assert.deepEqual(fatal, []);
  } finally {
    await relay.stop({ offline: false });
    await fakes.close();
  }
});

test('Worker close 4003 (revoked) stops the relay without reconnecting', async () => {
  const fakes = await startFakes();
  const { relay, fatal } = makeRelay(fakes);
  try {
    await relay.start();
    const es1 = await waitFor(() => fakes.eventsub.sockets[0], 'EventSub connection');
    fakes.eventsub.welcome(es1);
    const w1 = await waitFor(() => fakes.worker.connections[0], 'Worker connection');
    await waitFor(() => all(w1, 'heartbeat').length >= 1, 'heartbeat');
    w1.ws.close(4003, 'Relay credential revoked');
    await waitFor(() => fatal.length === 1, 'fatal event');
    assert.equal(fatal[0].reason, 'credential_revoked');
    await waitFor(() => es1.closed, 'EventSub closed after fatal');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fakes.worker.connections.length, 1, 'no reconnect after 4003');
  } finally {
    await relay.stop({ offline: false });
    await fakes.close();
  }
});

test('a rejected credential at upgrade (403) is fatal', async () => {
  const fakes = await startFakes();
  const { relay, fatal } = makeRelay(fakes);
  relay.config.backend.credential = 'd'.repeat(64);
  try {
    await relay.start();
    fakes.eventsub.welcome(await waitFor(() => fakes.eventsub.sockets[0], 'EventSub connection'));
    await waitFor(() => fatal.length === 1, 'fatal on 403');
    assert.equal(fatal[0].reason, 'credential_rejected');
    assert.equal(fakes.worker.authFailures, 1);
  } finally {
    await relay.stop({ offline: false });
    await fakes.close();
  }
});

test('transient Twitch failures at start are retried; auth failures are fatal', async () => {
  const fakes = await startFakes();
  fakes.twitch.failValidates = 2;
  const { relay } = makeRelay(fakes);
  const statuses = [];
  relay.on('status', (s) => statuses.push(s.event));
  try {
    await relay.start();
    assert.equal(statuses.filter((e) => e === 'start_retry').length, 2);
    fakes.eventsub.welcome(await waitFor(() => fakes.eventsub.sockets[0], 'EventSub connection after retries'));
    await waitFor(() => fakes.worker.connections[0], 'Worker connection');
  } finally {
    await relay.stop({ offline: false });
  }
  // A token that no longer validates and cannot be refreshed needs a new login.
  fakes.twitch.accessToken = 'server-side-only';
  const second = makeRelay(fakes);
  second.relay.config.twitch.clientId = 'wrong-client';
  try {
    await assert.rejects(second.relay.start(), /refresh failed/);
    assert.equal(fakes.eventsub.sockets.length, 1, 'no EventSub connection without a valid token');
  } finally {
    await second.relay.stop({ offline: false });
    await fakes.close();
  }
});
