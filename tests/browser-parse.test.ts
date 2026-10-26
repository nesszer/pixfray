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

test("overlay looks, players and duels: typed fields checked, extra fields kept", () => {
  fits(parseLook, { avatar: "knight", color: "#fff", elo: 1000, registered: true, sparkle: [1] });
  fits(parseArenaPlayer, { userId: "1", username: "a" });
  fits(parseArenaDuel, DUEL);
});

test("overlay snapshot: a bad entry drops only that entry", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const snapshot = { revision: 4, paused: false, chat: null, build: "abc", players: [], duels: [], events: [] };
  assert.equal(parseArenaSnapshot(snapshot).value, snapshot, "a snapshot that fits passes as itself");
  assert.deepEqual(
    parseArenaSnapshot({ revision: 5, players: [{ userId: "1" }, { userId: 2 }], events: [{ type: "" }] }),
    { ok: true, value: { revision: 5, players: [{ userId: "1" }], events: [] } },
  );
  assert.equal(warn.mock.callCount(), 2, "one warning for players, one for events");
});

test("overlay looks push, saved chat looks and demo messages", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  fits(parseLooksMessage, { type: "looks", looks: { ann: { avatar: "mage" }, bob: null } });
  assert.deepEqual(parseLooksMessage({ type: "looks", looks: { ann: { avatar: 1 }, bob: null } }), {
    ok: true,
    value: { type: "looks", looks: { bob: null } },
  });
  assert.equal(warn.mock.callCount(), 1);

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

test("fighter page: profile, saved builds, purchases, shop, config, leaderboard and the stored draft", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const profile = { wins: 1, losses: 0, elo: 1000, dollars: 5, avatar: "knight", hat: "cap" };
  fits(parseProfile, { ...profile, builds: [null, { avatar: "mage" }] });
  assert.deepEqual(parseProfile({ ...profile, builds: [{ avatar: "mage" }, "lost", { color: 3 }] }), {
    ok: true,
    value: { ...profile, builds: [{ avatar: "mage" }, null, null] },
  });
  assert.equal(warn.mock.callCount(), 1, "one warning for the bad saved builds");
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

  const row = { userId: "1", username: "ann", color: "#fff", avatar: "knight", elo: 1010, wins: 2, losses: 1 };
  assert.deepEqual(parseLeaderboard([row, { ...row, elo: "high" }]), { ok: true, value: [row] });

  fits(parseDraft, null);
  assert.deepEqual(parseDraft('{"d":{"avatar":"mage"},"at":5}'), { ok: true, value: { d: { avatar: "mage" }, at: 5 } });
});

test("mod page: the admin answer and live snapshots, with bad duels and players dropped", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const config = { maxDuels: 3, maxHp: 100, inactivityMs: 30000 };
  const duel = { id: "d", a: "1", b: "2", status: "pending", expiresAt: 9 };
  const player = {
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
  const room = { revision: 1, config, configVersion: 2, duels: [duel], players: [player] };
  const admin = { ...room, overlays: 1, history: [{ version: 1 }] };
  fits(parseAdmin, admin);
  assert.deepEqual(parseAdmin({ ...admin, duels: [duel, { id: "e" }], players: [{ userId: "2" }] }), {
    ok: true,
    value: { ...admin, duels: [duel], players: [] },
  });
  assert.equal(warn.mock.callCount(), 2, "one warning for duels, one for players");
  for (const [patch, error] of [
    [{ config: { maxDuels: 3 } }, "admin.config has the wrong type"],
    [{ streamelements: "on" }, "admin.streamelements has the wrong type"],
  ] as const)
    assert.deepEqual(parseAdmin({ ...admin, ...patch }), { ok: false, error });
  // the page reads these loosely (overlays || 0, botStatus?.heardAt), so an answer without them still reads
  fits(parseAdmin, { ...room, history: [{ version: 1 }], botStatus: null });

  const snap = { ...room, type: "snapshot", revision: 2, duels: [], events: [] };
  fits(parseAdminSnapshot, snap);
  assert.deepEqual(parseAdminSnapshot({ ...snap, type: "events" }), {
    ok: false,
    error: "snapshot.type has the wrong type",
  });
});

test("owner page: runs, versions, settings, channels, progress and logs", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const run = {
    createdAt: "2026-10-12",
    url: "u",
    title: null,
    id: 1,
    branch: null,
    conclusion: null,
    status: "queued",
  };
  assert.deepEqual(parseRuns([run, { ...run, id: "1" }]), { ok: true, value: [run] });

  const target = { deployments: [{ createdOn: "x", versions: [] }], versions: [{ id: "v" }] };
  assert.deepEqual(parseVersions({ prod: target, test: { deployments: "none" } }), {
    ok: true,
    value: { prod: target },
  });

  const version = { version: 3, at: 1, note: null };
  assert.deepEqual(parseSettings({ config: null, configVersion: 3, history: [version, { version: "2" }] }), {
    ok: true,
    value: { config: null, configVersion: 3, history: [version] },
  });

  const channel = { login: "bob", pausedAt: null };
  assert.deepEqual(parseChannels({ max: 10, builtin: ["ann"], channels: [channel, { login: 5 }] }), {
    ok: true,
    value: { max: 10, builtin: ["ann"], channels: [channel] },
  });

  const progress = { overlays: 1, rejectedAt: 0, lastCommandAt: 0, lastChatAt: 0, commandsWorking: 1, commands: 2 };
  assert.deepEqual(parseProgress({ progress: { ann: progress, bob: { overlays: "1" } } }), {
    ok: true,
    value: { progress: { ann: progress } },
  });

  const log = { at: 1, source: "chat", message: "hi", context: { a: 1 } };
  assert.deepEqual(parseLogs([log, { at: 1 }]), { ok: true, value: [log] });
  const day = { day: "2026-10-16", counts: { requests: 40, alarms: 3 } };
  assert.deepEqual(parseStats({ channel: "ann", days: [day, { day: "2026-10-15", counts: { alarms: "3" } }] }), {
    ok: true,
    value: [day],
  });
  assert.equal(
    warn.mock.callCount(),
    7,
    "one warning per list kind: runs, targets, config versions, channels, progress, logs, stats",
  );
});
