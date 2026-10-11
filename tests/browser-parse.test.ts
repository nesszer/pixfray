// The browser's edge parsers (src/served/parse.ts for the overlay, src/parse.ts for the pages): a value that fits
// passes as itself with its extra fields, a value that doesn't fails with the reason, and a bad list entry is dropped
// after one warning per kind.
import assert from "node:assert/strict";
import test from "node:test";
import {
  UNREADABLE,
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

test("overlay looks, players, duels and events: typed fields checked, extra fields kept", () => {
  const look = { avatar: "knight", color: "#fff", elo: 1000, registered: true, sparkle: [1] };
  assert.deepEqual(parseLook(look), { ok: true, value: look });
  assert.deepEqual(parseLook({ color: 7 }), { ok: false, error: "a look field has the wrong type" });
  assert.deepEqual(parseLook(null), { ok: false, error: "look is not an object" });

  assert.deepEqual(parseArenaPlayer({ userId: "1", username: "a" }), {
    ok: true,
    value: { userId: "1", username: "a" },
  });
  assert.deepEqual(parseArenaPlayer({ username: "a" }), { ok: false, error: "player.userId is missing" });
  assert.deepEqual(parseArenaPlayer({ userId: "1", elo: "high" }), {
    ok: false,
    error: "a player field has the wrong type",
  });

  const duel = { id: "d", a: "1", b: "2", status: "active", hp: { 1: 10, 2: 9 }, winnerId: null, extra: true };
  assert.deepEqual(parseArenaDuel(duel), { ok: true, value: duel });
  assert.deepEqual(parseArenaDuel({ ...duel, hp: { 1: "10" } }), {
    ok: false,
    error: "a duel field has the wrong type",
  });
  assert.deepEqual(parseArenaDuel({ id: "d", a: "1", b: "2", status: "active" }), {
    ok: false,
    error: "a duel field has the wrong type",
  });

  assert.deepEqual(parseArenaEvent({ type: "roll", die: "6" }), {
    ok: false,
    error: "event roll has a field of the wrong type",
  });
  assert.deepEqual(parseArenaEvent([]), { ok: false, error: "event is not an object" });
});

test("overlay snapshot: a wrong top-level field fails the frame, a bad entry drops only that entry", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const snapshot = { revision: 4, paused: false, chat: null, build: "abc", players: [], duels: [], events: [] };
  const good = parseArenaSnapshot(snapshot);
  assert.equal(good.value, snapshot, "a snapshot that fits passes as itself");
  assert.deepEqual(parseArenaSnapshot({ revision: "4" }), { ok: false, error: "a snapshot field has the wrong type" });
  assert.deepEqual(parseArenaSnapshot({ players: {} }), { ok: false, error: "a snapshot field has the wrong type" });
  assert.deepEqual(parseArenaSnapshot("snap"), { ok: false, error: "snapshot is not an object" });
  assert.deepEqual(
    parseArenaSnapshot({ revision: 5, players: [{ userId: "1" }, { userId: 2 }], events: [{ type: "" }] }),
    {
      ok: true,
      value: { revision: 5, players: [{ userId: "1" }], events: [] },
    },
  );
  assert.equal(warn.mock.callCount(), 2, "one warning for players, one for events");
});

test("overlay looks push, saved chat looks and demo messages", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const push = { type: "looks", looks: { ann: { avatar: "mage" }, bob: null } };
  assert.deepEqual(parseLooksMessage(push), { ok: true, value: push });
  assert.deepEqual(parseLooksMessage({ type: "looks", looks: { ann: { avatar: 1 }, bob: null } }), {
    ok: true,
    value: { type: "looks", looks: { bob: null } },
  });
  assert.deepEqual(parseLooksMessage({ type: "looks" }), { ok: false, error: "looks push has no looks" });
  assert.equal(warn.mock.callCount(), 1);

  const saved = parseCosmeticSettings('{"ann":{"avatar":"mage"},"bob":{"color":5},"__proto__":{"color":"#000"}}');
  assert.equal(saved.ok, true);
  assert.deepEqual(
    { ...saved.value },
    { ann: { avatar: "mage", color: undefined }, ["__proto__"]: { avatar: undefined, color: "#000" } },
  );
  assert.deepEqual({ ...parseCosmeticSettings(null).value }, {}, "no saved looks reads as none");
  assert.deepEqual(parseCosmeticSettings("{oops"), { ok: false, error: "saved chat looks are not JSON" });
  assert.deepEqual(parseCosmeticSettings("[1]"), { ok: false, error: "saved chat looks are not an object" });

  assert.deepEqual(parseDemoMessage({ demoPaused: true, other: 1 }), { ok: true, value: { demoPaused: true } });
  assert.deepEqual(parseDemoMessage({ demoPaused: "yes" }), {
    ok: false,
    error: "demo message has no demoPaused switch",
  });
});

test("parseAnswer: an ok body that fails turns into a failed answer; a failed answer keeps its body", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  assert.deepEqual(parseAnswer({ ok: true, status: 200, data: { user: null } }, parseSession, "the session"), {
    ok: true,
    status: 200,
    data: { user: null },
  });
  assert.deepEqual(parseAnswer({ ok: true, status: 200, data: { user: { id: 1 } } }, parseSession, "the session"), {
    ok: false,
    status: 200,
    data: { error: UNREADABLE },
  });
  assert.deepEqual(warn.mock.calls[0]?.arguments, ["PixFray dropped the session: session.user has the wrong type"]);
  assert.deepEqual(parseAnswer({ ok: false, status: 403, data: { off: "paused" } }, parseAccess, "the access check"), {
    ok: false,
    status: 403,
    data: { off: "paused" },
  });
});

test("session and access", () => {
  const session = { user: { id: "1", login: "ann" }, owner: false, channels: ["x"] };
  assert.deepEqual(parseSession(session), { ok: true, value: session });
  assert.deepEqual(parseSession({}), { ok: true, value: {} });
  assert.deepEqual(parseSession({ owner: "yes" }), { ok: false, error: "session.owner has the wrong type" });
  assert.deepEqual(parseSession(null), { ok: false, error: "session is not an object" });
  assert.deepEqual(parseAccess({ canManage: true }), { ok: true, value: { canManage: true } });
  assert.deepEqual(parseAccess({ canManage: 1 }), { ok: false, error: "access.canManage has the wrong type" });
});

test("fighter page: profile, saved builds, purchases, shop, config, leaderboard and the stored draft", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const profile = {
    wins: 1,
    losses: 0,
    elo: 1000,
    dollars: 5,
    avatar: "knight",
    hat: "cap",
    builds: [null, { avatar: "mage" }],
  };
  assert.deepEqual(parseProfile(profile), { ok: true, value: profile });
  assert.deepEqual(parseProfile({ ...profile, builds: [{ avatar: "mage" }, "lost", { color: 3 }] }), {
    ok: true,
    value: { ...profile, builds: [{ avatar: "mage" }, null, null] },
  });
  assert.equal(warn.mock.callCount(), 1, "one warning for the bad saved builds");
  assert.deepEqual(parseProfile({ wins: 1, losses: 0, elo: 1000 }), {
    ok: true,
    value: { wins: 1, losses: 0, elo: 1000 },
  });
  assert.deepEqual(parseProfile({ wins: 1, losses: 0 }), { ok: false, error: "profile.elo has the wrong type" });
  assert.deepEqual(parseProfileOrNone(null), { ok: true, value: null });
  assert.deepEqual(parseProfileSaved({ profile: { wins: 0, losses: 0, elo: 1000, dollars: 0 } }), {
    ok: true,
    value: { profile: { wins: 0, losses: 0, elo: 1000, dollars: 0 } },
  });
  assert.deepEqual(parseProfileSaved({}), { ok: false, error: "profile is not an object" });

  assert.deepEqual(parseBought({ dollars: 3, owned: { pets: ["cat"], slots: 2 } }), {
    ok: true,
    value: { dollars: 3, owned: { pets: ["cat"], slots: 2 } },
  });
  assert.deepEqual(parseBought({ dollars: 3, owned: { slots: "2" } }), {
    ok: false,
    error: "purchase.owned has the wrong type",
  });

  const shop = {
    pets: [{ id: "cat", label: "Cat", tier: "common", price: null, boost: { atk: 1 } }],
    items: { hats: [{ id: "cap", label: "Cap", price: 20 }] },
    slots: { prices: [null, 40], max: 3 },
  };
  assert.deepEqual(parseShop(shop), { ok: true, value: shop });
  assert.deepEqual(parseShop({ pets: [{ id: "cat", label: "Cat" }] }), {
    ok: false,
    error: "shop.pets has the wrong type",
  });

  const config = { initialElo: 1000, challengeTimeoutMs: 60000, rematchDelayMs: 0, quickDuel: true };
  assert.deepEqual(parseStateConfig({ config, players: [] }), { ok: true, value: config });
  assert.deepEqual(parseStateConfig({ config: { initialElo: 1000 } }), {
    ok: false,
    error: "state.config.challengeTimeoutMs has the wrong type",
  });

  const row = { userId: "1", username: "ann", color: "#fff", avatar: "knight", elo: 1010, wins: 2, losses: 1 };
  assert.deepEqual(parseLeaderboard([row, { ...row, elo: "high" }]), { ok: true, value: [row] });
  assert.deepEqual(parseLeaderboard({}), { ok: false, error: "leaderboard is not a list" });

  assert.deepEqual(parseDraft(null), { ok: true, value: null });
  assert.deepEqual(parseDraft('{"d":{"avatar":"mage"},"at":5}'), { ok: true, value: { d: { avatar: "mage" }, at: 5 } });
  assert.deepEqual(parseDraft("{"), { ok: false, error: "draft is not JSON" });
  assert.deepEqual(parseDraft('{"d":"mage","at":5}'), { ok: false, error: "draft.d has the wrong type" });
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
  const admin = {
    revision: 1,
    config,
    configVersion: 2,
    duels: [duel],
    players: [player],
    overlays: 1,
    history: [{ version: 1 }],
  };
  assert.deepEqual(parseAdmin(admin), { ok: true, value: admin });
  assert.deepEqual(parseAdmin({ ...admin, duels: [duel, { id: "e" }], players: [{ userId: "2" }] }), {
    ok: true,
    value: { ...admin, duels: [duel], players: [] },
  });
  assert.equal(warn.mock.callCount(), 2, "one warning for duels, one for players");
  assert.deepEqual(parseAdmin({ ...admin, config: { maxDuels: 3 } }), {
    ok: false,
    error: "admin.config has the wrong type",
  });
  assert.deepEqual(parseAdmin({ ...admin, streamelements: "on" }), {
    ok: false,
    error: "admin.streamelements has the wrong type",
  });
  // the page reads these loosely (overlays || 0, botStatus?.heardAt), so an answer without them still reads
  const { overlays, ...noOverlays } = admin;
  assert.equal(overlays, 1);
  assert.deepEqual(parseAdmin({ ...noOverlays, botStatus: null }), {
    ok: true,
    value: { ...noOverlays, botStatus: null },
  });

  const snap = { type: "snapshot", revision: 2, config, configVersion: 2, players: [player], duels: [], events: [] };
  assert.deepEqual(parseAdminSnapshot(snap), { ok: true, value: snap });
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
  assert.deepEqual(parseRuns(null), { ok: false, error: "runs is not a list" });

  const target = { deployments: [{ createdOn: "x", versions: [] }], versions: [{ id: "v" }] };
  assert.deepEqual(parseVersions({ prod: target, test: { deployments: "none" } }), {
    ok: true,
    value: { prod: target },
  });

  const settings = { config: null, configVersion: 3, history: [{ version: 3, at: 1, note: null }, { version: "2" }] };
  assert.deepEqual(parseSettings(settings), {
    ok: true,
    value: { ...settings, history: [{ version: 3, at: 1, note: null }] },
  });
  assert.deepEqual(parseSettings({ config: [], configVersion: 3 }), {
    ok: false,
    error: "settings.config has the wrong type",
  });

  const channels = { max: 10, builtin: ["ann"], channels: [{ login: "bob", pausedAt: null }, { login: 5 }] };
  assert.deepEqual(parseChannels(channels), {
    ok: true,
    value: { ...channels, channels: [{ login: "bob", pausedAt: null }] },
  });
  assert.deepEqual(parseChannels({ max: 10, builtin: [1], channels: [] }), {
    ok: false,
    error: "channels.builtin has the wrong type",
  });

  const progress = { overlays: 1, rejectedAt: 0, lastCommandAt: 0, lastChatAt: 0, commandsWorking: 1, commands: 2 };
  assert.deepEqual(parseProgress({ progress: { ann: progress, bob: { overlays: "1" } } }), {
    ok: true,
    value: { progress: { ann: progress } },
  });
  assert.deepEqual(parseProgress({}), { ok: false, error: "progress is not an object" });

  const log = { at: 1, source: "chat", message: "hi", context: { a: 1 } };
  assert.deepEqual(parseLogs([log, { at: 1 }]), { ok: true, value: [log] });
  assert.equal(
    warn.mock.callCount(),
    6,
    "one warning per list kind: runs, targets, config versions, channels, progress, logs",
  );
});
