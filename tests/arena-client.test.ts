// Arena client: server times are shifted into the local clock, so a PC with a wrong clock still plays fresh events.
import test from "node:test";
import assert from "node:assert/strict";
import { createArenaClient } from "../src/served/arena-client.ts";
import { resetWarnings } from "../src/served/parse.ts";
import type { ArenaSnapshot, LooksMessage } from "../src/served/parse.ts";
import { must } from "./fakes.ts";
import type { Loose } from "./fakes.ts";

/** The client's socket constructor; the fakes below are plain constructor functions. */
type SocketConstructor = new (url: string) => WebSocket;
/** A message as the client's onmessage reads it. */
type FakeMessage = { data: string };

/** The socket harness() hands the client: onmessage is set by the client before any message arrives. */
type FakeSocket = { close(): void; onmessage(message: FakeMessage): void };
function harness() {
  // a partial Location on purpose: the client reads only protocol and host
  globalThis.location = { protocol: "https:", host: "test.example" } as Location;
  const sockets: FakeSocket[] = [],
    // Loose: events and snapshots are the client's output, which the tests read by property
    events: Loose[] = [],
    snapshots: Loose[] = [], // Loose: as above
    looks: LooksMessage[] = [];
  function FakeSocket(this: FakeSocket) {
    this.close = () => {};
    sockets.push(this);
  }
  const client = createArenaClient({
    channel: "nesszerra",
    onSnapshot: (s) => snapshots.push(s),
    onEvent: (e) => events.push(e),
    onLooks: (m) => looks.push(m),
    fetchImpl: () => new Promise<Response>(() => {}),
    // a constructor function standing in for WebSocket: the client calls only close and sets onmessage
    WebSocketImpl: FakeSocket as unknown as SocketConstructor,
  });
  const send = (payload: unknown) => must(sockets.at(-1)).onmessage({ data: JSON.stringify(payload) });
  return { client, events, snapshots, looks, send };
}

test("arena client: a local clock 11 s ahead of the server still sees events as fresh", () => {
  const h = harness();
  const serverNow = Date.now() - 11_000;
  h.send({
    type: "snapshot",
    revision: 5,
    serverNow,
    chat: { connected: true, lastSeen: serverNow - 1000 },
    players: [
      { userId: "a", respawnAt: serverNow + 3000 },
      { userId: "b", respawnAt: 0 },
    ],
    events: [{ id: "5", type: "duel_completed", at: serverNow - 500, respawnAt: serverNow + 3000 }],
  });
  const e = h.events[0];
  assert.ok(Math.abs(Date.now() - 500 - e.at) < 200, "event time converted to the local clock");
  assert.ok(Math.abs(Date.now() + 3000 - e.respawnAt) < 200);
  const s = h.snapshots[0];
  assert.ok(Math.abs(Date.now() + 3000 - s.players[0].respawnAt) < 200);
  assert.equal(s.players[1].respawnAt, 0, "zero stays zero");
  assert.ok(Math.abs(Date.now() - 1000 - s.chat.lastSeen) < 200);
  h.client.disconnect();
});

test("arena client: a looks push goes to onLooks, not to events, and leaves the revision alone", () => {
  const h = harness();
  h.send({ type: "snapshot", revision: 7, players: [], events: [] });
  h.send({ type: "looks", looks: { cleo: null }, reset: true });
  h.send({ type: "looks" }); // no looks map: dropped
  assert.deepEqual(h.looks, [{ type: "looks", looks: { cleo: null }, reset: true }]);
  assert.equal(h.events.length, 0);
  h.send({ type: "event", revision: 7, event: { id: "8", type: "challenge_created", at: Date.now() } });
  assert.equal(h.events.length, 1, "an event at the same revision still plays");
  h.client.disconnect();
});

test("arena client: snapshots without serverNow pass through unchanged", () => {
  const h = harness();
  const at = Date.now() - 2000;
  h.send({ type: "snapshot", revision: 1, players: [], events: [{ id: "1", type: "challenge_created", at }] });
  assert.equal(h.events[0].at, at);
  h.client.disconnect();
});

// Parsing (src/served/parse.ts): a malformed frame is dropped whole, after one warning per kind, and changes nothing.
test("arena client: malformed frames are dropped and leave the revision, seen events and clock alone", (t) => {
  resetWarnings();
  const warn = t.mock.method(console, "warn", () => {});
  const h = harness();
  const at = Date.now() - 2000;
  h.send({ type: "snapshot", revision: 5, players: [], events: [{ id: "5", type: "challenge_created", at }] });
  // a server clock a minute behind would shift event times, if this frame were taken
  h.send({
    type: "snapshot",
    revision: 9,
    serverNow: Date.now() - 60_000,
    players: "nobody",
    events: [{ id: "9", type: "challenge_created", at }],
  });
  h.send({ type: "snapshot", revision: 10, paused: "yes", players: [], events: [] });
  h.send("{not json");
  assert.equal(h.client.revision, 5, "the revision stays at the last good snapshot");
  assert.equal(h.snapshots.length, 1, "no snapshot reached the overlay");
  assert.equal(h.events.length, 1, "no event from a dropped frame played");
  assert.equal(warn.mock.callCount(), 2, "one warning for both bad snapshots, one for the broken JSON");
  h.send({ type: "event", revision: 9, event: { id: "9", type: "challenge_created", at } });
  assert.equal(h.events.length, 2, "event 9 was never marked as seen, so it plays now");
  assert.equal(h.events[1].at, at, "the dropped frame's serverNow did not shift the clock");
  assert.equal(h.client.revision, 9);
  h.client.disconnect();
});

test("arena client: one bad event or player in a snapshot is dropped and the rest still play", (t) => {
  resetWarnings();
  const warn = t.mock.method(console, "warn", () => {});
  const h = harness();
  const at = Date.now() - 1000;
  h.send({
    type: "snapshot",
    revision: 3,
    players: [{ userId: "a", username: "a" }, { userId: "b", elo: "lots" }, "c"],
    events: [
      { id: "1", type: "challenge_created", at, a: "a", b: "b" },
      { id: "2", type: "duel_action", at, amount: "9" },
      { id: "3", type: "challenge_declined", at, declinedBy: "b" },
    ],
  });
  assert.deepEqual(
    h.events.map((e) => e.id),
    ["1", "3"],
  );
  assert.deepEqual(h.snapshots[0].players, [{ userId: "a", username: "a" }]);
  assert.equal(h.client.revision, 3);
  assert.equal(warn.mock.callCount(), 2, "one warning for players, one for events");
  h.client.disconnect();
});

// Ping and watchdog: the client sends "ping" every 20 s, the room's auto-response answers "pong", and a socket with no
// message at all for 45 s is half open, so it gets replaced. No /api/state polling.
/** The socket watchdogHarness() hands the client: onopen and onmessage are set by the client. */
type WatchedSocket = {
  readyState: number;
  sent: string[];
  closed: boolean;
  send(message: string): void;
  close(): void;
  onopen(): void;
  onmessage(message: FakeMessage): void;
};
function watchdogHarness() {
  // a partial Location on purpose: the client reads only protocol and host
  globalThis.location = { protocol: "https:", host: "test.example" } as Location;
  const sockets: WatchedSocket[] = [],
    snapshots: ArenaSnapshot[] = [],
    events: unknown[] = [],
    fetches: (RequestInfo | URL)[] = [];
  function FakeSocket(this: WatchedSocket) {
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
    this.send = (m) => this.sent.push(m);
    this.close = () => {
      this.closed = true;
      this.readyState = 3;
    };
    sockets.push(this);
  }
  const client = createArenaClient({
    channel: "nesszerra",
    onSnapshot: (s) => snapshots.push(s),
    onEvent: (e) => events.push(e),
    fetchImpl: (url) => {
      fetches.push(url);
      return new Promise<Response>(() => {});
    },
    // a constructor function standing in for WebSocket: the client calls send and close and reads readyState
    WebSocketImpl: FakeSocket as unknown as SocketConstructor,
  });
  const open = () => {
    const ws = must(sockets.at(-1));
    ws.readyState = 1;
    ws.onopen();
  };
  const send = (data: unknown) =>
    must(sockets.at(-1)).onmessage({ data: typeof data === "string" ? data : JSON.stringify(data) });
  return { client, sockets, snapshots, events, fetches, open, send };
}

test('arena client ping: an open socket sends "ping" every 20 s, and "pong" keeps it without polling /api/state', (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = watchdogHarness();
  h.open();
  h.send({ type: "snapshot", revision: 5, players: [], events: [] });
  const fetched = h.fetches.length;
  for (let i = 0; i < 6; i++) {
    t.mock.timers.tick(20_000);
    h.send("pong");
  }
  assert.equal(must(h.sockets[0]).sent.filter((m) => m === "ping").length, 6, "one ping per 20 s");
  assert.equal(h.sockets.length, 1, "answered pings keep the socket");
  assert.equal(h.fetches.length, fetched, "no /api/state polling");
  assert.equal(h.snapshots.length, 1, "pong is not a snapshot");
  assert.equal(h.events.length, 0, "or an event");
  h.client.disconnect();
});

test("arena client watchdog: 45 s with no pong or message replaces the socket", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = watchdogHarness();
  h.open();
  h.send({ type: "snapshot", revision: 5, players: [], events: [] });
  const fetched = h.fetches.length;
  t.mock.timers.tick(44_999);
  assert.equal(h.sockets.length, 1, "two pings unanswered is not yet 45 s");
  t.mock.timers.tick(1);
  assert.equal(h.sockets.length, 2, "a fresh socket was opened");
  assert.equal(must(h.sockets[0]).closed, true, "the silent one was dropped");
  assert.equal(
    h.fetches.length,
    fetched,
    "the watchdog itself fetches nothing; the new socket asks for state once it opens",
  );
  t.mock.timers.tick(20_000);
  assert.equal(must(h.sockets[0]).sent.length, 2, "the dropped socket gets no more pings");
  assert.equal(must(h.sockets[1]).sent.length, 0, "a socket that is still connecting gets none either");
  h.client.disconnect();
});

test("arena client watchdog: every message restarts the 45 s wait, and disconnect stops pings and the watchdog", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = watchdogHarness();
  h.open();
  t.mock.timers.tick(40_000);
  h.send({ type: "snapshot", revision: 5, players: [], events: [] });
  t.mock.timers.tick(40_000);
  assert.equal(h.sockets.length, 1, "40 s after the last message is not silence yet");
  h.client.disconnect();
  const sent = must(h.sockets[0]).sent.length;
  t.mock.timers.tick(200_000);
  assert.equal(h.sockets.length, 1, "no reconnect after disconnect");
  assert.equal(must(h.sockets[0]).sent.length, sent, "no pings after disconnect");
});
