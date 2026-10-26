// The browser's edge parsers (src/served/parse.ts for the overlay, src/parse.ts for the pages): a value that fits
// passes as itself with its extra fields, a value that doesn't fails with the reason, and a bad list entry is dropped
// after one warning per kind.
import assert from "node:assert/strict";
import test from "node:test";
import {
  UNREADABLE,
  acceptedUnreadable,
  parseAccess,
  parseAdmin,
  parseAdminSnapshot,
  parseAnswer,
  parseBought,
  parseChannels,
  parseDraft,
  parseLeaderboard,
  parseLogs,
  parseProfile,
  parseProfileOrNone,
  parseProfileSaved,
  parseProgress,
  parseRuns,
  parseSession,
  parseSettings,
  parseShop,
  parseStateConfig,
  parseStats,
  parseVersions,
} from "../src/parse.ts";
import {
  keepGood,
  parseArenaDuel,
  parseArenaEvent,
  parseArenaPlayer,
  parseArenaSnapshot,
  parseCosmeticSettings,
  parseDemoMessage,
  parseLook,
  parseLooksMessage,
  resetWarnings,
  warnOnce,
} from "../src/served/parse.ts";

test.beforeEach(() => resetWarnings());

/** A value that fits passes as itself, extra fields and all. */
function fits<T>(parse: (value: T) => unknown, value: T) {
  assert.deepEqual(parse(value), { ok: true, value });
}

const DUEL = { id: "d", a: "1", b: "2", status: "active", hp: { 1: 10, 2: 9 }, winnerId: null, extra: true };

// Each parse that fails, with the reason it gives.
const FAILS: [() => unknown, string][] = [
  [() => parseLook({ color: 7 }), "a look field has the wrong type"],
  [() => parseLook(null), "look is not an object"],
  [() => parseArenaPlayer({ username: "a" }), "player.userId is missing"],
  [() => parseArenaPlayer({ userId: "1", elo: "high" }), "a player field has the wrong type"],
  [() => parseArenaDuel({ ...DUEL, hp: { 1: "10" } }), "a duel field has the wrong type"],
  [() => parseArenaDuel({ id: "d", a: "1", b: "2", status: "active" }), "a duel field has the wrong type"],
  [() => parseArenaEvent({ type: "roll", die: "6" }), "event roll has a field of the wrong type"],
  [() => parseArenaEvent([]), "event is not an object"],
  [() => parseArenaSnapshot({ revision: "4" }), "a snapshot field has the wrong type"],
  [() => parseArenaSnapshot({ players: {} }), "a snapshot field has the wrong type"],
  [() => parseArenaSnapshot("snap"), "snapshot is not an object"],
  [() => parseLooksMessage({ type: "looks" }), "looks push has no looks"],
  [() => parseCosmeticSettings("{oops"), "saved chat looks are not JSON"],
  [() => parseCosmeticSettings("[1]"), "saved chat looks are not an object"],
  [() => parseDemoMessage({ demoPaused: "yes" }), "demo message has no demoPaused switch"],
  [() => parseSession({ owner: "yes" }), "session.owner has the wrong type"],
  [() => parseSession(null), "session is not an object"],
  [() => parseAccess({ canManage: 1 }), "access.canManage has the wrong type"],
  [() => parseProfile({ wins: 1, losses: 0 }), "profile.elo has the wrong type"],
  [() => parseProfileSaved({}), "profile is not an object"],
  [() => parseBought({ dollars: 3, owned: { slots: "2" } }), "purchase.owned has the wrong type"],
  [() => parseShop({ pets: [{ id: "cat", label: "Cat" }] }), "shop.pets has the wrong type"],
  [() => parseStateConfig({ config: { initialElo: 1000 } }), "state.config.challengeTimeoutMs has the wrong type"],
  [() => parseLeaderboard({}), "leaderboard is not a list"],
  [() => parseDraft("{"), "draft is not JSON"],
  [() => parseDraft('{"d":"mage","at":5}'), "draft.d has the wrong type"],
  [() => parseRuns(null), "runs is not a list"],
  [() => parseSettings({ config: [], configVersion: 3 }), "settings.config has the wrong type"],
  [() => parseChannels({ max: 10, builtin: [1], channels: [] }), "channels.builtin has the wrong type"],
  [() => parseProgress({}), "progress is not an object"],
  [() => parseStats({ channel: "ann" }), "stats.days is not a list"],
];

test("a value that doesn't fit fails with the reason", () => {
  for (const [parse, error] of FAILS) assert.deepEqual(parse(), { ok: false, error }, error);
});

test("warnOnce logs each kind once until the warnings are reset", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  warnOnce("a frame", "not JSON");
  warnOnce("a frame", "still not JSON");
  warnOnce("a look", "bad color");
  assert.deepEqual(
    warn.mock.calls.map((c) => c.arguments),
    [["PixFray dropped a frame: not JSON"], ["PixFray dropped a look: bad color"]],
  );
  resetWarnings();
  warnOnce("a frame", "again");
  assert.equal(warn.mock.callCount(), 3);
});

test("keepGood drops the entries that fail, warning once with the first reason", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const list = [{ type: "duel_started" }, { type: 5 }, "x", { type: "duel_won", at: 3 }];
  assert.deepEqual(keepGood(list, "an event", parseArenaEvent), [
    { type: "duel_started" },
    { type: "duel_won", at: 3 },
  ]);
  assert.deepEqual(warn.mock.calls[0]?.arguments, ["PixFray dropped an event: event.type is missing"]);
  assert.equal(warn.mock.callCount(), 1);
});

test("overlay looks, players, duels and snapshots: typed fields checked, extra fields kept", () => {
  fits(parseLook, { avatar: "knight", color: "#fff", elo: 1000, registered: true, sparkle: [1] });
  fits(parseArenaPlayer, { userId: "1", username: "a" });
  fits(parseArenaDuel, DUEL);
  const snapshot = { revision: 4, paused: false, chat: null, build: "abc", players: [], duels: [], events: [] };
  assert.equal(parseArenaSnapshot(snapshot).value, snapshot, "a snapshot that fits passes as itself");
});

test("overlay looks push, saved chat looks and demo messages", () => {
  fits(parseLooksMessage, { type: "looks", looks: { ann: { avatar: "mage" }, bob: null } });

  const saved = parseCosmeticSettings('{"ann":{"avatar":"mage"},"bob":{"color":5},"__proto__":{"color":"#000"}}');
  assert.equal(saved.ok, true);
  assert.deepEqual(
    { ...saved.value },
    { ann: { avatar: "mage", color: undefined }, ["__proto__"]: { avatar: undefined, color: "#000" } },
  );
  assert.deepEqual({ ...parseCosmeticSettings(null).value }, {}, "no saved looks reads as none");

  assert.deepEqual(parseDemoMessage({ demoPaused: true, other: 1 }), { ok: true, value: { demoPaused: true } });
  for (const other of ["hello", { source: "react-devtools-content-script" }, null, [true]])
    assert.equal(parseDemoMessage(other), null, "a message that isn't the demo's is ignored: " + JSON.stringify(other));
});

test("parseAnswer: an ok body that fails turns into a failed answer; a failed answer keeps its body", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const answer = { ok: true, status: 200, data: { user: null } };
  assert.deepEqual(parseAnswer(answer, parseSession, "the session"), answer);
  assert.deepEqual(parseAnswer({ ok: true, status: 200, data: { user: { id: 1 } } }, parseSession, "the session"), {
    ok: false,
    status: 200,
    data: { error: UNREADABLE },
  });
  assert.deepEqual(warn.mock.calls[0]?.arguments, ["PixFray dropped the session: session.user has the wrong type"]);
  const refused = { ok: false, status: 403, data: { off: "paused" } };
  assert.deepEqual(parseAnswer(refused, parseAccess, "the access check"), refused);
});

test("acceptedUnreadable: only a 2xx answer whose body failed may have gone through", (t) => {
  t.mock.method(console, "warn", () => {});
  const save = (r: { ok: boolean; status: number; data: unknown }) =>
    acceptedUnreadable(parseAnswer(r, parseProfileSaved, "the saved profile"));
  assert.equal(save({ ok: true, status: 200, data: null }), true, "the save went through, the body didn't parse");
  assert.equal(save({ ok: true, status: 200, data: { profile: "x" } }), true);
  assert.equal(
    save({ ok: true, status: 200, data: { profile: { wins: 0, losses: 0, elo: 1000, dollars: 0 } } }),
    false,
    "a save read in full",
  );
  assert.equal(save({ ok: false, status: 400, data: { error: "invalid_profile" } }), false, "a refused save");
  assert.equal(save({ ok: false, status: 0, data: { error: "Network error" } }), false, "no answer at all");
});

test("session and access", () => {
  fits(parseSession, { user: { id: "1", login: "ann" }, owner: false, channels: ["x"] });
  fits(parseSession, {});
  fits(parseAccess, { canManage: true });
});

const PROFILE = { wins: 1, losses: 0, elo: 1000, dollars: 5, avatar: "knight", hat: "cap" };
const ROW = { userId: "1", username: "ann", color: "#fff", avatar: "knight", elo: 1010, wins: 2, losses: 1 };
const CONFIG = { maxDuels: 3, maxHp: 100, inactivityMs: 30000 };
const MOD_DUEL = { id: "d", a: "1", b: "2", status: "pending", expiresAt: 9 };
const PLAYER = {
  userId: "1",
  username: "ann",
  color: "#fff",
  respawnAt: 0,
  hp: 100,
  elo: 1000,
  wins: 0,
  losses: 0,
  lastSeen: 1,
};
const ROOM = { revision: 1, config: CONFIG, configVersion: 2, duels: [MOD_DUEL], players: [PLAYER] };
const ADMIN = { ...ROOM, overlays: 1, history: [{ version: 1 }] };
const RUN = { createdAt: "2026-10-12", url: "u", title: null, id: 1, branch: null, conclusion: null, status: "queued" };
const TARGET = { deployments: [{ createdOn: "x", versions: [] }], versions: [{ id: "v" }] };
const VERSION = { version: 3, at: 1, note: null };
const CHANNEL = { login: "bob", pausedAt: null };
const PROGRESS = { overlays: 1, rejectedAt: 0, lastCommandAt: 0, lastChatAt: 0, commandsWorking: 1, commands: 2 };
const LOG = { at: 1, source: "chat", message: "hi", context: { a: 1 } };
const DAY = { day: "2026-10-16", counts: { requests: 40, alarms: 3 } };

// Each list with a bad entry: what passes, and how many warnings (one per list kind) it logs.
const DROPS: [string, () => unknown, unknown, number][] = [
  [
    "overlay snapshot",
    () => parseArenaSnapshot({ revision: 5, players: [{ userId: "1" }, { userId: 2 }], events: [{ type: "" }] }),
    { revision: 5, players: [{ userId: "1" }], events: [] },
    2,
  ],
  [
    "looks push",
    () => parseLooksMessage({ type: "looks", looks: { ann: { avatar: 1 }, bob: null } }),
    { type: "looks", looks: { bob: null } },
    1,
  ],
  [
    "saved builds",
    () => parseProfile({ ...PROFILE, builds: [{ avatar: "mage" }, "lost", { color: 3 }] }),
    { ...PROFILE, builds: [{ avatar: "mage" }, null, null] },
    1,
  ],
  ["leaderboard", () => parseLeaderboard([ROW, { ...ROW, elo: "high" }]), [ROW], 1],
  [
    "admin duels and players",
    () => parseAdmin({ ...ADMIN, duels: [MOD_DUEL, { id: "e" }], players: [{ userId: "2" }] }),
    { ...ADMIN, duels: [MOD_DUEL], players: [] },
    2,
  ],
  ["runs", () => parseRuns([RUN, { ...RUN, id: "1" }]), [RUN], 1],
  ["deploy targets", () => parseVersions({ prod: TARGET, test: { deployments: "none" } }), { prod: TARGET }, 1],
  [
    "config versions",
    () => parseSettings({ config: null, configVersion: 3, history: [VERSION, { version: "2" }] }),
    { config: null, configVersion: 3, history: [VERSION] },
    1,
  ],
  [
    "channels",
    () => parseChannels({ max: 10, builtin: ["ann"], channels: [CHANNEL, { login: 5 }] }),
    { max: 10, builtin: ["ann"], channels: [CHANNEL] },
    1,
  ],
  [
    "progress",
    () => parseProgress({ progress: { ann: PROGRESS, bob: { overlays: "1" } } }),
    { progress: { ann: PROGRESS } },
    1,
  ],
  ["logs", () => parseLogs([LOG, { at: 1 }]), [LOG], 1],
  [
    "stats",
    () => parseStats({ channel: "ann", days: [DAY, { day: "2026-10-15", counts: { alarms: "3" } }] }),
    [DAY],
    1,
  ],
];

test("a bad list entry drops only that entry, with one warning per list kind", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  for (const [name, parse, value, warnings] of DROPS) {
    resetWarnings();
    warn.mock.resetCalls();
    assert.deepEqual(parse(), { ok: true, value }, name);
    assert.equal(warn.mock.callCount(), warnings, name + " warnings");
  }
});

test("fighter page: profile, saved builds, purchases, shop, config and the stored draft", () => {
  fits(parseProfile, { ...PROFILE, builds: [null, { avatar: "mage" }] });
  fits(parseProfile, { wins: 1, losses: 0, elo: 1000 });
  fits(parseProfileOrNone, null);
  fits(parseProfileSaved, { profile: { wins: 0, losses: 0, elo: 1000, dollars: 0 } });
  fits(parseBought, { dollars: 3, owned: { pets: ["cat"], slots: 2 } });
  fits(parseShop, {
    pets: [{ id: "cat", label: "Cat", tier: "common", price: null, boost: { atk: 1 } }],
    items: { hats: [{ id: "cap", label: "Cap", price: 20 }] },
    slots: { prices: [null, 40], max: 3 },
  });
  const config = { initialElo: 1000, challengeTimeoutMs: 60000, rematchDelayMs: 0, quickDuel: true };
  assert.deepEqual(parseStateConfig({ config, players: [] }), { ok: true, value: config });
  fits(parseDraft, null);
  assert.deepEqual(parseDraft('{"d":{"avatar":"mage"},"at":5}'), { ok: true, value: { d: { avatar: "mage" }, at: 5 } });
});

test("mod page: the admin answer and live snapshots", () => {
  fits(parseAdmin, ADMIN);
  for (const [patch, error] of [
    [{ config: { maxDuels: 3 } }, "admin.config has the wrong type"],
    [{ streamelements: "on" }, "admin.streamelements has the wrong type"],
  ] as const)
    assert.deepEqual(parseAdmin({ ...ADMIN, ...patch }), { ok: false, error });
  // the page reads these loosely (overlays || 0, botStatus?.heardAt), so an answer without them still reads
  fits(parseAdmin, { ...ROOM, history: [{ version: 1 }], botStatus: null });
  const snap = { ...ROOM, type: "snapshot", revision: 2, duels: [], events: [] };
  fits(parseAdminSnapshot, snap);
  assert.deepEqual(parseAdminSnapshot({ ...snap, type: "events" }), {
    ok: false,
    error: "snapshot.type has the wrong type",
  });
});
