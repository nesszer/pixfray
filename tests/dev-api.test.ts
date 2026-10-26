// Live-fix API (/api/dev/*): owner gate, not-configured paths, request validation, GitHub calls,
// and the ChannelRoom side on real SQLite. GitHub and Cloudflare are stubbed through globalThis.fetch.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import worker from "../server/worker.ts";
import { ChannelRoom } from "../server/channel.ts";
import { validPath, usage, logRoomEvent } from "../server/developer.ts";
import { asEnv, asExecutionContext, fakeCtx, must } from "./fakes.ts";
import type { FakeState, Loose } from "./fakes.ts";
import { INTERNAL, SECRETS, memoryAuth, namespace, signedIn, req, call } from "./worker-fakes.ts";

/** A ChannelRoom built on fakeCtx(), so its storage reads come back as plain rows. */
type DevRoom = Omit<ChannelRoom, "ctx"> & { ctx: FakeState };
type Fixture = ReturnType<typeof environment>;
type D1Value = SQLInputValue | ArrayBuffer;
type FakeStatement = {
  bind: (...p: D1Value[]) => FakeStatement;
  run: () => Promise<{ success: boolean }>;
  all: () => Promise<{ results: Record<string, unknown>[] }>;
  first: () => Promise<Record<string, unknown> | null>;
};
type Backup = { day: string; at: number };
type BackupResult = { channel: string; ok: boolean };
/** A stubbed upstream answer: method and URL pattern, then status and JSON body (null for none). */
type Route = [method: string, url: RegExp, status: number, body: unknown];

// Real ChannelRooms (node:sqlite) behind ROOMS, and an in-memory AuthStore. `reads` lists the room calls in order;
// a room named in `down` throws.
function environment(extra: Record<string, unknown> = {}) {
  // entries hold whatever JSON the Worker stored; tests read them by property
  const entries = new Map<string, Loose>(),
    rooms = new Map<string, DevRoom>(),
    reads: string[] = [],
    down = new Set<string>();
  const env = asEnv({
    ...SECRETS,
    AUTH: memoryAuth(entries),
    ASSETS: { fetch: async () => Response.json([{ id: "player" }]) },
    ...extra,
  });
  const room = (name: string) => {
    if (!rooms.has(name))
      // built on fakeCtx(), so its ctx is the FakeState
      rooms.set(
        name,
        new ChannelRoom(fakeCtx(), asEnv({ INTERNAL_SECRET: INTERNAL, BACKUPS: env.BACKUPS })) as DevRoom,
      );
    return must(rooms.get(name));
  };
  env.ROOMS = namespace(async (name, url, init) => {
    reads.push(name);
    if (down.has(name)) throw new Error("room down");
    return room(name).fetch(new Request(url, init));
  });
  const owner = () => signedIn({ env, entries }, true),
    viewer = () => signedIn({ env, entries });
  return { env, entries, rooms, room, reads, down, owner, viewer };
}
// D1 (prepare/bind/run/all/first/batch) over node:sqlite. Blobs come back as arrays of numbers, as D1 returns them.
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const args = (params: D1Value[]): SQLInputValue[] =>
    params.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
  const row = (r: Record<string, SQLOutputValue>) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? [...v] : v]));
  const statement = (query: string, params: D1Value[] = []): FakeStatement => ({
    bind: (...p) => statement(query, p),
    run: async () => (db.prepare(query).run(...args(params)), { success: true }),
    all: async () => ({
      results: db
        .prepare(query)
        .all(...args(params))
        .map(row),
    }),
    first: async () => {
      const r = db.prepare(query).get(...args(params));
      return r ? row(r) : null;
    },
  });
  return {
    prepare: (query: string) => statement(query),
    async batch(list: FakeStatement[]) {
      const out: { success: boolean }[] = [];
      for (const st of list) out.push(await st.run());
      return out;
    },
  };
}
async function cron(f: Fixture, at: number) {
  const pending: Promise<unknown>[] = [];
  await worker.scheduled(
    { scheduledTime: at, cron: "0 9 * * *" } as ScheduledController, // the Worker reads only these two fields
    f.env,
    asExecutionContext({ waitUntil: (p) => pending.push(p) }),
  );
  await Promise.all(pending);
}
const GITHUB = { GITHUB_TOKEN: "test-only-gh-token", GITHUB_REPO: "Finesssee/pixfray" };
const get = (f: Fixture, path: string, cookie: string) => call(f.env, "/api/dev/" + path, "GET", undefined, cookie);
const post = (f: Fixture, path: string, body: unknown, cookie: string) =>
  call(f.env, "/api/dev/" + path, "POST", body, cookie);
/** The raw response, for header checks on downloads. */
const download = (f: Fixture, path: string, cookie: string) =>
  worker.fetch(req("/api/dev/" + path, "GET", undefined, cookie), f.env);
const roomPost = (f: Fixture, path: string, body: object) =>
  f.room("nesszerra").fetch(
    new Request("https://room" + path, {
      method: "POST",
      headers: { "X-Mini-Internal": INTERNAL, "X-Mini-Channel": "nesszerra" },
      body: JSON.stringify(body),
    }),
  );
/** Adds a fighter row with the columns every test needs. */
function addFighter(room: DevRoom, id: string, name: string, [elo, wins, losses, seen]: number[], ability = "strike") {
  room.ctx.storage.sql.exec(
    "INSERT INTO profiles (user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen) VALUES (?, ?, ?, 'player', '#ff0000', ?, ?, ?, ?, ?)",
    id,
    name,
    name[0]?.toUpperCase() + name.slice(1),
    ability,
    must(elo),
    must(wins),
    must(losses),
    must(seen),
  );
}

// Records GitHub/Cloudflare calls and answers from a route table; anything unexpected fails the test.
function stubFetch(t: TestContext, routes: Route[]) {
  const calls: Loose[] = []; // stub call records: the tests read them by property
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input),
      method = init.method || "GET";
    calls.push({
      url,
      method,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      headers: init.headers,
    });
    const hit = routes.find(([m, re]) => m === method && re.test(url));
    if (!hit) throw new Error("Unexpected fetch " + method + " " + url);
    return new Response(hit[3] === null ? null : JSON.stringify(hit[3]), { status: hit[2] });
  });
  return calls;
}

const ROUTES = [
  "diagnostics",
  "logs",
  "settings",
  "channels",
  "progress?logins=nesszerra",
  "export?channel=nesszerra",
  "export?registry=1",
  "restore?channel=nesszerra",
  "backups?channel=nesszerra",
  "usage",
  "versions",
  "code/tree",
  "code/file?path=README.md",
  "runs",
];
const POSTS = [
  "settings",
  "channels",
  "restore",
  "backups",
  "code/save",
  "code/pr",
  "deploy",
  "promote",
  "hotfix",
  "rollback",
];

test("every developer route returns 401 signed out and 403 for a non-owner", async () => {
  const f = environment(GITHUB),
    viewer = await f.viewer();
  for (const p of ROUTES) {
    assert.equal((await call(f.env, "/api/dev/" + p)).status, 401, p);
    const r = await get(f, p, viewer);
    assert.deepEqual([r.status, r.body.reason], [403, "owner_only"], p);
  }
  for (const p of POSTS) assert.equal((await post(f, p, {}, viewer)).status, 403, p);
  assert.equal((await call(f.env, "/api/dev/logs", "DELETE", undefined, viewer)).status, 403);
});

test("mutations must be same-origin, unknown routes 404, wrong methods 405", async () => {
  const f = environment(GITHUB),
    owner = await f.owner();
  const evil = { Origin: "https://evil.example" };
  assert.equal(
    (await call(f.env, "/api/dev/channels", "POST", { action: "pause", login: "someone" }, owner, evil)).status,
    403,
  );
  for (const [method, path, code] of [
    ["GET", "nope", 404],
    ["GET", "codex", 404], // the Codex switch is gone
    ["GET", "deploy", 405],
    ["POST", "diagnostics", 405],
  ] as const)
    assert.equal(
      (await call(f.env, "/api/dev/" + path, method, method === "POST" ? {} : undefined, owner)).status,
      code,
      path,
    );
  for (const body of ["[1]", "{bad"]) assert.equal((await post(f, "channels", body, owner)).status, 400);
});

test("GitHub and Cloudflare routes answer 501 not configured when their secrets are missing", async (t) => {
  stubFetch(t, []);
  const f = environment(),
    owner = await f.owner();
  for (const p of ["code/tree", "code/file?path=README.md", "runs", ...POSTS.slice(4)]) {
    const r = await (POSTS.includes(p) ? post(f, p, {}, owner) : get(f, p, owner));
    assert.deepEqual(
      [r.status, r.body.reason, r.body.missing],
      [501, "github_not_configured", ["GITHUB_TOKEN", "GITHUB_REPO"]],
      p,
    );
  }
  const half = environment({ GITHUB_TOKEN: "x", GITHUB_REPO: "not a repo" });
  assert.deepEqual((await get(half, "runs", await half.owner())).body.missing, ["GITHUB_REPO"]);
  const v = await get(f, "versions", owner);
  assert.deepEqual([v.status, v.body.reason], [501, "cloudflare_not_configured"]);
  const u = await get(f, "usage", owner);
  assert.deepEqual([u.status, u.body.configured, u.body.limit], [200, false, 100000]);
});

test("diagnostics keeps the contract shape and reports integrations and usage", async (t) => {
  stubFetch(t, []);
  const f = environment({ CF_VERSION_METADATA: { id: "v-1", tag: "gh-abc", timestamp: "2026-10-01T00:00:00Z" } });
  const r = await get(f, "diagnostics", await f.owner()),
    { worker: w, room, integrations } = r.body;
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(w).slice(0, 3), ["version", "twitchConfigured", "productionEnabled"]);
  assert.deepEqual([w.productionEnabled, w.deployedVersion.id], [false, "v-1"]);
  assert.deepEqual(
    [room.channel, room.chat.connected, room.chatStatus.status, room.paused, room.sockets, room.seLastCommandAt],
    ["nesszerra", false, "disconnected", true, { live: 0 }, 0],
  );
  assert.deepEqual(
    [integrations.github.configured, integrations.cloudflare.configured, r.body.usage.configured],
    [false, false, false],
  );
  assert.equal("codex" in r.body, false);
});

test("channels lists the registry without reading any room, and progress answers per channel", async () => {
  const f = environment(),
    owner = await f.owner();
  const list = await get(f, "channels", owner);
  assert.equal(list.status, 200);
  assert.equal("progress" in list.body, false, "progress comes from /api/dev/progress");
  assert.equal(list.body.progressBatch, 40);
  assert.deepEqual(list.body.builtin, ["nesszerra", "miolafff"]);
  assert.equal(f.reads.length, 0);
  const r = await get(f, "progress?logins=nesszerra,MIOLAFFF", owner);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.progress).sort(), [...list.body.builtin].sort());
  const p = r.body.progress.nesszerra;
  assert.deepEqual(
    Object.keys(p).sort(),
    [
      "commands",
      "commandsWorking",
      "duelCommands",
      "duelModuleOff",
      "lastChatAt",
      "lastCommandAt",
      "overlays",
      "players",
      "rejectedAt",
      "source",
    ].sort(),
  );
  assert.deepEqual([p.overlays, p.source, p.commands, p.commandsWorking], [0, "", 14, 0]);
});

test("progress covers more than 40 channels across batched calls, 40 room reads at most per call", async () => {
  const f = environment(),
    owner = await f.owner();
  const logins = Array.from({ length: 95 }, (_, i) => "streamer_" + String(i).padStart(3, "0"));
  logins.forEach((login, i) =>
    f.entries.set("channel:" + login, {
      id: String(100 + i),
      login,
      enabledAt: 1000 + i,
      ...(i === 94 ? { pausedAt: 5 } : {}),
    }),
  );
  const list = (await get(f, "channels", owner)).body;
  const on = [
    ...list.builtin,
    ...list.channels.filter((c: { pausedAt?: number }) => !c.pausedAt).map((c: { login: string }) => c.login),
  ];
  assert.deepEqual([on.length, list.channels.length], [96, 95]);
  const seen: Record<string, Loose> = {}; // progress rows by login, read by property
  for (let i = 0; i < on.length; i += list.progressBatch) {
    f.reads.length = 0;
    const r = await get(f, "progress?logins=" + on.slice(i, i + list.progressBatch).join(","), owner);
    assert.equal(r.status, 200);
    assert.ok(f.reads.length <= 40, "room reads in one call: " + f.reads.length);
    Object.assign(seen, r.body.progress);
  }
  assert.deepEqual(Object.keys(seen).sort(), [...on].sort());
  assert.equal(seen.streamer_050.commands, 14);
});

test("progress validates logins: required, at most 40, only channels that are on", async () => {
  const f = environment(),
    owner = await f.owner();
  f.entries.set("channel:oldone", { id: "7", login: "oldone", enabledAt: 1, pausedAt: 2 });
  f.entries.set("channel:newone", { id: "8", login: "newone", enabledAt: 1 });
  const progress = async (q: string) => {
    const r = await get(f, "progress" + q, owner);
    return [r.status, r.body.reason];
  };
  const many = Array.from({ length: 41 }, (_, i) => "channel" + i).join(",");
  for (const [q, want] of [
    ["", [400, "logins_required"]],
    ["?logins=,,", [400, "logins_required"]],
    ["?logins=" + many, [400, "too_many_logins"]],
    ["?logins=nesszerra,nobody_here", [400, "unknown_channel"]],
    ["?logins=oldone", [400, "unknown_channel"]], // a channel that is off has no progress
  ] as const)
    assert.deepEqual(await progress(q), want, q.slice(0, 30));
  assert.equal((await get(f, "progress?logins=" + many, owner)).body.max, 40);
  assert.deepEqual((await get(f, "progress?logins=nesszerra,nobody_here", owner)).body.invalid, ["nobody_here"]);
  assert.equal((await get(f, "progress?logins=../x,a", owner)).status, 400);
  const dup = await get(f, "progress?logins=newone,newone, NewOne", owner);
  assert.equal(dup.status, 200);
  assert.deepEqual(Object.keys(dup.body.progress), ["newone"]);
  assert.equal((await post(f, "progress?logins=nesszerra", {}, owner)).status, 405);
});

test("export downloads one room as JSON: fighters, ranks, config, history, characters, command names, no key", async () => {
  const f = environment(),
    owner = await f.owner(),
    room = f.room("nesszerra"),
    sql = room.ctx.storage.sql;
  const secret = room.seSettings().secret;
  assert.match(secret, /^[a-f0-9]{16,}$/);
  addFighter(room, "11", "fighter1", [1234, 9, 3, 5]);
  addFighter(room, "12", "fighter2", [900, 1, 8, 6], "heal");
  sql.exec(
    "UPDATE profiles SET dollars = 70, title = 'legend', build = 1, power = 1, guard = 2, luck = 3, hat = 'crown' WHERE user_id = '11'",
  );
  sql.exec(
    "INSERT INTO owned_items (user_id, kind, item_id, price, bought_at) VALUES ('11', 'title', 'legend', 50, 7)",
  );
  sql.exec("INSERT INTO builds (user_id, slot, data) VALUES ('11', 0, '{\"title\":\"\"}')");
  sql.exec(
    "INSERT INTO custom_characters (id, meta, atlas, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    "c-orc-abc123",
    JSON.stringify({ label: "Orc", fps: 8 }),
    new Uint8Array([137, 80, 78, 71]),
    4,
    "11",
    99,
  );
  await post(
    f,
    "settings",
    { action: "config", payload: { patch: { maxHp: 120 }, baseVersion: 1, note: "tankier" } },
    owner,
  );

  const res = await download(f, "export?channel=NessZerra", owner);
  assert.equal(res.status, 200);
  // a missing header fails the match all the same
  const header = (name: string) => res.headers.get(name) as string;
  assert.match(header("Content-Disposition"), /^attachment; filename="mini-chat-nesszerra-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.match(header("Content-Type"), /^application\/json/);
  const text = await res.text(),
    data = JSON.parse(text),
    first = data.profiles[0];
  assert.deepEqual(
    [data.format, data.version, data.kind, data.channel, data.status],
    ["mini-chat-export", 1, "channel", "nesszerra", "builtin"],
  );
  assert.deepEqual(
    data.profiles.map((p: { username: string; elo: number; wins: number; losses: number }) => [
      p.username,
      p.elo,
      p.wins,
      p.losses,
    ]),
    [
      ["fighter1", 1234, 9, 3],
      ["fighter2", 900, 1, 8],
    ],
  );
  assert.deepEqual([first.power, first.hat, first.defaultAbility, first.userId], [1, "crown", "strike", "11"]);
  assert.deepEqual([first.dollars, first.title, first.build, first.bonus], [70, "legend", 1, 0]);
  // the export's field names and order, as the SQL aliases give them
  assert.equal(
    Object.keys(first).join(" "),
    "userId username displayName avatar color defaultAbility elo wins losses lastSeen power guard luck crit dodge " +
      "counter vitality hat lastOpponentId bonus checkins streak dollars styleDollars pet recolor petColor accessory " +
      "trail winEffect taunt title build",
  );
  assert.deepEqual([data.config.maxHp, data.configVersion], [120, 2]);
  assert.deepEqual(
    data.configHistory.map((h: { version: number; note: string }) => [h.version, h.note]),
    [
      [2, "tankier"],
      [1, "initial"],
    ],
  );
  assert.deepEqual(data.customCharacters, [
    { id: "c-orc-abc123", meta: { label: "Orc", fps: 8 }, bytes: 4, createdBy: "11", createdAt: 99 },
  ]);
  assert.equal("atlas" in data.customCharacters[0], false);
  assert.deepEqual(Object.keys(data.streamelements), ["commandNames"]);
  assert.ok(Object.keys(data.streamelements.commandNames).length >= 6);
  assert.deepEqual(data.counts, {
    profiles: 2,
    configVersions: 2,
    customCharacters: 1,
    purchases: 1,
    builds: 1,
    customPets: 0,
  });
  assert.deepEqual(data.purchases, [{ userId: "11", kind: "title", itemId: "legend", price: 50, boughtAt: 7 }]);
  assert.deepEqual(data.builds, [{ userId: "11", slot: 0, data: { title: "" } }]);
  assert.ok(!text.includes(secret), "the StreamElements key is not exported");
  assert.doesNotMatch(text, /secret|subscriptionId|token/i);
});

// Point-in-time restore. Node has no PITR, so the room's storage gets a fake one: bookmarks are 'b<ms>' style hex
// strings, onNextSessionRestoreBookmark returns an undo point, and abort() throws as the real one ends the session.
const UNDO = "0000007c-00000000ffff-00001539-" + "e".repeat(32);
function fakePitr(room: DevRoom) {
  const calls: { armed: string[]; aborted: number; times: (number | Date)[] } = { armed: [], aborted: 0, times: [] };
  Object.assign(room.ctx.storage, {
    async getBookmarkForTime(t: number | Date) {
      calls.times.push(t);
      return "0000007b-" + Number(t).toString(16).padStart(12, "0") + "-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b";
    },
    async onNextSessionRestoreBookmark(b: string) {
      calls.armed.push(b);
      return UNDO;
    },
  });
  room.ctx.abort = () => {
    calls.aborted++;
    throw new Error("Restoring channel data");
  };
  return calls;
}

test("restore arms the point, restarts the room, moves the revision past the old one and keeps an undo point", async () => {
  const f = environment(),
    owner = await f.owner(),
    room = f.room("nesszerra"),
    pitr = fakePitr(room);
  const state = room.readState("nesszerra");
  state.revision = 40;
  room.writeState(state);
  addFighter(room, "11", "fighter1", [1000, 0, 0, 0]);
  const at = Date.now() - 3 * 3600000;

  assert.deepEqual((await get(f, "restore?channel=nesszerra", owner)).body, {
    channel: "nesszerra",
    last: null,
    windowDays: 30,
  });
  const r = await post(f, "restore", { channel: "NessZerra", at }, owner);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(
    [r.body.ok, r.body.channel, r.body.at, r.body.undone, r.body.undoSaved, r.body.profiles],
    [true, "nesszerra", at, false, true, 1],
  );
  assert.deepEqual(pitr.times, [at]);
  assert.equal(pitr.armed.length, 1);
  assert.equal(pitr.aborted, 1, "the room was restarted right away");
  assert.equal(room.readState("nesszerra").revision, 41, "open overlays accept the restored state");
  const saved = f.entries.get("restore:nesszerra");
  assert.deepEqual([saved.at, saved.by, saved.undo], [at, "nesszerra", UNDO]);
  const info = (await get(f, "restore?channel=nesszerra", owner)).body;
  assert.deepEqual([info.last.at, info.last.by], [at, "nesszerra"]);
  assert.equal("undo" in info.last, false, "the undo point stays on the server");

  const u = await post(f, "restore", { channel: "nesszerra", undo: true }, owner);
  assert.deepEqual([u.status, u.body.undone], [200, true]);
  assert.equal(pitr.armed[1], saved.undo, "undo restores to the saved point");
  assert.equal(pitr.aborted, 2);
  assert.equal(f.entries.has("restore:nesszerra"), false, "an undone restore leaves nothing to undo");
  const again = await post(f, "restore", { channel: "nesszerra", undo: true }, owner);
  assert.deepEqual([again.status, again.body.reason], [409, "nothing_to_undo"]);
});

test("restore refuses times outside the 30-day window, unknown channels, and local dev without PITR", async () => {
  const f = environment(),
    owner = await f.owner(),
    day = 86400000,
    now = Date.now();
  const restore = async (channel: string, at: unknown) => {
    const r = await post(f, "restore", { channel, at }, owner);
    return [r.status, r.body.reason];
  };
  for (const at of [now - 31 * day, now, now + day, "yesterday", undefined])
    assert.deepEqual(await restore("nesszerra", at), [400, "invalid_restore_time"], String(at));
  assert.deepEqual(await restore("nobody_here", now - day), [404, "unknown_channel"]);
  assert.equal((await get(f, "restore?channel=bad%20login", owner)).status, 400);
  assert.deepEqual(await restore("nesszerra", now - day), [501, "restore_unavailable"]);
  assert.equal(f.entries.has("restore:nesszerra"), false);
  const room = f.room("nesszerra");
  fakePitr(room);
  room.ctx.storage.getBookmarkForTime = async () => "not a bookmark; DROP TABLE";
  assert.deepEqual(await restore("nesszerra", now - day), [502, "invalid_bookmark"]);
  const body = { channel: "nesszerra", at: now - day };
  assert.equal(
    (await call(f.env, "/api/dev/restore", "POST", body, owner, { Origin: "https://evil.example" })).status,
    403,
  );
});

test("export does not create a StreamElements key or change the room", async () => {
  const f = environment(),
    sql = f.room("miolafff").ctx.storage.sql,
    count = () => sql.exec("SELECT COUNT(*) AS n FROM se_settings").toArray()[0].n;
  assert.equal(count(), 0);
  const r = await get(f, "export?channel=miolafff", await f.owner());
  assert.deepEqual([r.status, r.body.profiles.length, count()], [200, 0, 0]);
});

test("export of an unknown channel is 404, a paused channel still exports, and a target is required", async () => {
  const f = environment(),
    owner = await f.owner();
  f.entries.set("channel:paused_one", { id: "9", login: "paused_one", enabledAt: 1, pausedAt: 2 });
  const miss = await get(f, "export?channel=nobody_here", owner);
  assert.deepEqual([miss.status, miss.body.reason], [404, "unknown_channel"]);
  assert.equal((await get(f, "export?channel=../etc", owner)).status, 404);
  assert.equal((await get(f, "export", owner)).status, 400);
  const ok = await get(f, "export?channel=paused_one", owner);
  assert.deepEqual([ok.status, ok.body.channel, ok.body.status], [200, "paused_one", "paused"]);
});

test("export of the channel list has every channel and who turned it off", async () => {
  const f = environment();
  f.entries.set("channel:oldone", { id: "7", login: "oldone", enabledAt: 1000, pausedAt: 2000 });
  const res = await download(f, "export?registry=1", await f.owner());
  assert.match(
    res.headers.get("Content-Disposition") as string, // a missing header fails the match all the same
    /^attachment; filename="mini-chat-channels-\d{4}-\d{2}-\d{2}\.json"$/,
  );
  const data = await res.json<Loose>(); // the export JSON, read by property
  assert.deepEqual([data.kind, data.builtin], ["registry", ["nesszerra", "miolafff"]]);
  assert.deepEqual(data.channels, [{ id: "7", login: "oldone", enabledAt: 1000, pausedAt: 2000, pausedBy: "" }]);
  assert.equal("invites" in data, false);
});

test("the daily cron backs up every channel into D1; the owner lists the days, downloads one and reads one fighter", async () => {
  const f = environment({ BACKUPS: fakeD1() }),
    owner = await f.owner(),
    room = f.room("nesszerra"),
    sql = room.ctx.storage.sql;
  f.entries.set("channel:paused_one", { id: "9", login: "paused_one", enabledAt: 1, pausedAt: 2 });
  addFighter(room, "11", "fighter1", [1234, 9, 3, 5]);
  sql.exec(
    "INSERT INTO owned_items (user_id, kind, item_id, price, bought_at) VALUES ('11', 'title', 'legend', 50, 7), ('12', 'hat', 'crown', 40, 8)",
  );
  sql.exec("INSERT INTO builds (user_id, slot, data) VALUES ('11', 0, '{\"title\":\"legend\"}')");
  const at = Date.UTC(2026, 9, 9, 9);
  await cron(f, at);
  // A reset after the backup doesn't reach it.
  sql.exec("UPDATE profiles SET elo = 1000, wins = 0, losses = 0 WHERE user_id = '11'");

  const list = await get(f, "backups?channel=NessZerra", owner);
  assert.deepEqual([list.status, list.body.keepDays], [200, 90]);
  assert.deepEqual(
    list.body.backups.map((b: Backup) => [b.day, b.at]),
    [["2026-10-09", at]],
  );
  assert.ok(list.body.backups[0].bytes > 100);
  for (const user of ["fighter1", "@FIGHTER1", "11"]) {
    const one = await get(f, "backups?channel=nesszerra&day=2026-10-09&user=" + user, owner),
      { profile } = one.body;
    assert.equal(one.status, 200, user);
    assert.deepEqual(
      [one.body.day, one.body.exportedAt, profile.elo, profile.wins, profile.losses],
      ["2026-10-09", "2026-10-09T09:00:00.000Z", 1234, 9, 3],
    );
    assert.deepEqual(
      one.body.purchases.map((p: { itemId: string }) => p.itemId),
      ["legend"],
    );
    assert.deepEqual(one.body.builds, [{ userId: "11", slot: 0, data: { title: "legend" } }]);
  }
  const res = await download(f, "backups?channel=nesszerra&day=2026-10-09", owner);
  assert.equal(
    res.headers.get("Content-Disposition"),
    'attachment; filename="mini-chat-nesszerra-2026-10-09-backup.json"',
  );
  const data = await res.json<Loose>(); // the export JSON, read by property
  assert.deepEqual(
    [data.format, data.kind, data.channel, data.status, data.counts.profiles, data.counts.purchases],
    ["mini-chat-export", "channel", "nesszerra", "builtin", 1, 2],
  );
  const paused = await get(f, "backups?channel=paused_one&day=2026-10-09", owner);
  assert.deepEqual([paused.status, paused.body.status], [200, "paused"]);
  assert.equal((await get(f, "backups?channel=miolafff", owner)).body.backups.length, 1);
  for (const [q, want] of [
    ["", [400, "channel_required"]],
    ["channel=nesszerra&day=yesterday", [400, "invalid_day"]],
    ["channel=nesszerra&day=2026-10-08", [404, "no_backup"]],
    ["channel=nesszerra&day=2026-10-09&user=nobody", [404, "fighter_not_in_backup"]],
  ] as const) {
    const r = await get(f, "backups?" + q, owner);
    assert.deepEqual([r.status, r.body.reason], want, q);
  }
});

test("backups keep 90 days, and a second backup on the same day replaces that day's", async () => {
  const f = environment({ BACKUPS: fakeD1() }),
    owner = await f.owner(),
    day = 86400000,
    start = Date.UTC(2026, 6, 1, 9);
  const list = async (): Promise<Backup[]> => (await get(f, "backups?channel=nesszerra", owner)).body.backups;
  for (const at of [start, start + day, start + day + 60000]) await cron(f, at);
  assert.deepEqual(
    (await list()).map((b) => [b.day, b.at]),
    [
      ["2026-07-02", start + day + 60000],
      ["2026-07-01", start],
    ],
  );
  await cron(f, start + 91 * day);
  assert.deepEqual(
    (await list()).map((b) => b.day),
    ["2026-09-30", "2026-07-02"],
  );
});

test("the owner can back up one channel now; without D1 the routes answer 501 and the cron does nothing", async () => {
  const f = environment({ BACKUPS: fakeD1() }),
    owner = await f.owner();
  const now = await post(f, "backups", { channel: "NessZerra" }, owner);
  assert.equal(now.status, 200);
  assert.match(now.body.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(
    now.body.channels.map((c: BackupResult) => [c.channel, c.ok]),
    [["nesszerra", true]],
  );
  assert.equal((await get(f, "backups?channel=miolafff", owner)).body.backups.length, 0);
  assert.deepEqual(
    (await post(f, "backups", {}, owner)).body.channels.map((c: BackupResult) => c.channel),
    ["nesszerra", "miolafff"],
  );
  const unknown = await post(f, "backups", { channel: "nobody_here" }, owner);
  assert.deepEqual([unknown.status, unknown.body.reason], [404, "unknown_channel"]);
  const room = await roomPost(f, "/dev/backup", { at: "soon", status: "on" });
  // the error body, read by property
  assert.deepEqual([room.status, (await room.json<Loose>()).reason], [400, "invalid_backup"]);

  const bare = environment(),
    cookie = await bare.owner();
  for (const r of [await get(bare, "backups?channel=nesszerra", cookie), await post(bare, "backups", {}, cookie)])
    assert.deepEqual([r.status, r.body.reason], [501, "backups_unavailable"]);
  await cron(bare, Date.now());
  assert.equal(bare.rooms.size, 0);
});

test("a room that fails its backup is logged, and the other channels are still backed up", async () => {
  const f = environment({ BACKUPS: fakeD1() }),
    owner = await f.owner();
  f.down.add("miolafff");
  await cron(f, Date.UTC(2026, 9, 9, 9));
  assert.equal((await get(f, "backups?channel=nesszerra", owner)).body.backups.length, 1);
  const logs = await get(f, "logs?source=worker", owner);
  assert.deepEqual(
    logs.body.map((l: { message: string; context: { failed: unknown } }) => [l.message, l.context.failed]),
    [["Daily backup failed for 1 channel(s)", [{ channel: "miolafff", ok: false, reason: "room down" }]]],
  );
});

test("rooms no longer create the leftover dev_settings table", () => {
  const ctx = fakeCtx();
  new ChannelRoom(ctx, asEnv({ INTERNAL_SECRET: INTERNAL }));
  assert.equal(ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'dev_settings'").toArray().length, 0);
});

test("error log: worker errors land in the room, can be filtered, and cleared", async () => {
  const f = environment(),
    owner = await f.owner();
  await roomPost(f, "/dev/log", { message: "boom", context: { path: "/api/x", big: "y".repeat(5000) } });
  const logs = await get(f, "logs?source=worker&limit=5", owner);
  assert.deepEqual([logs.status, logs.body.length, logs.body[0].message], [200, 1, "boom"]);
  assert.equal(typeof logs.body[0].context.truncated, "string");
  assert.equal((await get(f, "logs?source=room", owner)).body.length, 0);
  // Chat command lines and warnings share the log but don't count as errors.
  logRoomEvent(f.room("nesszerra"), "command", "alice challenge @bob -> challenge");
  logRoomEvent(f.room("nesszerra"), "warn", "slow");
  const { room } = (await get(f, "diagnostics", owner)).body;
  assert.deepEqual(
    [room.errors, room.errorsBySource.command, room.errorsBySource.worker, room.lastError.message],
    [1, 1, 1, "boom"],
  );
  assert.equal((await call(f.env, "/api/dev/logs", "DELETE", undefined, owner)).status, 200);
  assert.equal((await get(f, "logs", owner)).body.length, 0);
});

test("owner logs filter by every stored source, and stats show today's counters", async (t) => {
  for (const level of ["log", "warn", "error"] as const) t.mock.method(console, level, () => {});
  const f = environment(),
    owner = await f.owner(),
    r = f.room("nesszerra");
  logRoomEvent(r, "command", "alice challenge @bob -> challenge");
  logRoomEvent(r, "warn", "slow");
  logRoomEvent(r, "alarm", "ran rematch_lock");
  for (const source of ["command", "warn", "alarm"]) {
    const logs = await get(f, "logs?source=" + source, owner);
    assert.deepEqual(
      logs.body.map((l: { source: string }) => l.source),
      [source],
    );
  }
  const stats = await get(f, "stats?channel=nesszerra&days=3", owner);
  const { counts } = stats.body.days[0];
  assert.deepEqual([stats.status, stats.body.channel, counts.log_warn, counts.log_alarm], [200, "nesszerra", 1, 1]);
});

test("live settings passthrough edits the versioned config as the session user", async () => {
  const f = environment(),
    owner = await f.owner();
  const config = (payload?: object, extra: object = {}) =>
    post(f, "settings", { action: "config", payload, ...extra }, owner);
  const before = await get(f, "settings", owner);
  assert.deepEqual([before.status, before.body.configVersion], [200, 1]);
  assert.equal((await post(f, "settings", { action: "resetAll" }, owner)).status, 400);
  assert.equal((await post(f, "settings", { action: "config" }, owner)).status, 400);
  assert.equal((await config({ patch: { maxHp: 0 } })).status, 400);
  const ok = await config({ patch: { maxHp: 120 }, baseVersion: 1, note: "tankier" }, { actorId: "forged" });
  assert.equal(ok.status, 200);
  assert.equal((await config({ patch: { maxHp: 130 }, baseVersion: 1 })).status, 409);
  const after = await get(f, "settings", owner);
  assert.deepEqual([after.body.config.maxHp, after.body.history[0].actorId], [120, "1"]);
  assert.equal((await post(f, "settings", { action: "rollbackConfig", payload: { version: 1 } }, owner)).status, 200);
  assert.equal((await get(f, "settings", owner)).body.config.maxHp, 100);
});

test("owner can connect and disconnect Twitch chat from the dev settings; diagnostics report it", async (t) => {
  const f = environment(),
    owner = await f.owner();
  const calls = stubFetch(t, [
    ["POST", /id\.twitch\.tv\/oauth2\/token/, 200, { access_token: "app-token", expires_in: 3600 }],
    ["GET", /helix\/eventsub\/subscriptions/, 200, { data: [], pagination: {} }],
    [
      "POST",
      /helix\/eventsub\/subscriptions/,
      202,
      { data: [{ id: "sub-dev", status: "enabled", created_at: "2026-10-01T00:00:00Z" }] },
    ],
    ["DELETE", /helix\/eventsub\/subscriptions\?id=sub-dev/, 204, null],
  ]);
  const on = await post(f, "settings", { action: "connectChat" }, owner);
  assert.equal(on.status, 200);
  assert.deepEqual([on.body.chatStatus.connected, on.body.chatStatus.subscriptionId], [true, "sub-dev"]);
  const { room } = (await get(f, "diagnostics", owner)).body;
  assert.deepEqual([room.chat.connected, room.paused, room.chatStatus.status], [true, false, "enabled"]);
  const off = await post(f, "settings", { action: "disconnectChat" }, owner);
  assert.equal(off.body.chatStatus.connected, false);
  assert.ok(calls.some((c) => c.method === "DELETE"));
  assert.equal((await post(f, "settings", { action: "connectChat" }, await f.viewer())).status, 403);
});

test("editor paths reject traversal and protected files", () => {
  for (const p of ["server/worker.js", "src/dev.js", "README.md", "docs/LIVE_FIX.md"])
    assert.equal(validPath(p), true, p);
  for (const p of [
    "",
    "/etc/passwd",
    "../x",
    "a/../b",
    "a//b",
    "./a",
    ".dev.vars",
    ".dev.vars.test",
    ".secrets.local.json",
    ".env",
    "x/.env.local",
    "node_modules/a.js",
    ".git/config",
    ".github/workflows/deploy.yml",
    "old/token.dpapi",
    "dist/index.js",
    "a b.js",
    "a\\b.js",
    "x".repeat(201),
    5,
    null,
  ])
    assert.equal(validPath(p), false, String(p));
});

// Files the deploy workflow runs with its Cloudflare token: every config extension of vite, postcss and .postcssrc.
const JS = ["js", "cjs", "mjs", "ts", "cts", "mts"];
const BUILD_FILES = [
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bunfig.toml",
  ".npmrc",
  "site.config.js",
  "site.config.ts",
  "cloudflare.config.ts",
  "wrangler.json",
  "wrangler.jsonc",
  "wrangler.toml",
  "tsconfig.json",
  "tsconfig.strict.json",
  "types/lib-guards.d.ts",
  "scripts/release.ts",
  "scripts/lib/zip-read.ts",
  "PostCSS.config.js",
  ".postcssrc",
  ...JS.map((x) => "vite.config." + x),
  ...JS.map((x) => "postcss.config." + x),
  ...["json", "yaml", "yml", ...JS].map((x) => ".postcssrc." + x),
];

test("code editor request validation happens before GitHub is called", async (t) => {
  const calls = stubFetch(t, []);
  const f = environment(GITHUB),
    owner = await f.owner();
  const save = (body: object) =>
    ["code/save", "POST", { path: "README.md", content: "x", branch: "live-fix/a", ...body }] as const;
  for (const [p, m, body] of [
    ["code/file?path=.dev.vars", "GET"],
    ["code/file?path=README.md&branch=main2", "GET"],
    ["code/tree?ref=feature/x", "GET"],
    save({ path: "../x", content: "" }),
    save({ content: 5 }),
    save({ branch: "main" }),
    save({ branch: "live-fix/A B" }),
    save({ sha: "abc" }),
    ["code/pr", "POST", { branch: "main" }],
    ["deploy", "POST", { target: "production" }],
    ["deploy", "POST", { ref: "feature/x" }],
    ["deploy", "POST", { sha: "zz" }],
    ["promote", "POST", { percentage: 0 }],
    ["promote", "POST", { percentage: 50.5 }],
    ["promote", "POST", { number: -1 }],
    ["promote", "POST", { reason: 7 }],
    ["hotfix", "POST", { branch: "live-fix/a" }],
    ["hotfix", "POST", {}],
    ["rollback", "POST", { target: "staging" }],
    ["rollback", "POST", { target: "test", versionId: "v1" }],
  ] satisfies (readonly [string, string, object?])[]) {
    const r = await call(f.env, "/api/dev/" + p, m, body, owner);
    assert.equal(r.status, 400, p + " " + JSON.stringify(body));
    assert.ok(r.body.reason, p);
  }
  const big = { path: "README.md", content: "x".repeat(600 * 1024), branch: "live-fix/a" };
  assert.equal((await post(f, "code/save", big, owner)).status, 413);
  // Build files can be read but not saved.
  assert.equal(BUILD_FILES.length, 39);
  for (const path of BUILD_FILES) {
    assert.equal(validPath(path), true, path);
    const r = await post(f, "code/save", { path, content: "x", branch: "live-fix/a" }, owner);
    assert.deepEqual([r.status, r.body.reason], [403, "build_file"], path);
  }
  assert.equal(calls.length, 0);
});

test("the editor saves files whose names only resemble build configs, and TypeScript sources", async (t) => {
  const calls = stubFetch(t, [
    ["GET", /\/git\/ref\/heads\/live-fix\/(notes|types)$/, 200, { object: { sha: "b".repeat(40) } }],
    ["PUT", /\/contents\//, 200, { content: { sha: "c".repeat(40) }, commit: { sha: "d".repeat(40) } }],
  ]);
  const f = environment(GITHUB),
    owner = await f.owner();
  const notes = ["docs/postcss.md", "src/wrangler-notes.js", "docs/postcss.config.js", "docs/wrangler.toml"],
    sources = ["server/game.ts", "src/admin.ts", "src/types.ts", "server/types.ts", "typescript-notes.md"];
  for (const [branch, paths] of [
    ["live-fix/notes", notes],
    ["live-fix/types", sources],
  ] as const)
    for (const path of paths) {
      const r = await post(f, "code/save", { path, content: "export {};\n", branch, sha: "a".repeat(40) }, owner);
      assert.deepEqual([r.status, r.body.path], [200, path], path);
    }
  assert.deepEqual(
    calls
      .filter((c) => c.method === "PUT")
      .map((c) => must(decodeURIComponent(c.url).split("/contents/")[1]).split("?")[0]),
    [...notes, ...sources],
  );
});

test("the dev token can deploy the test site but not production", async (t) => {
  const calls = stubFetch(t, [["POST", /\/actions\/workflows\/deploy\.yml\/dispatches$/, 204, null]]);
  const token = "d".repeat(40),
    f = environment({ ...GITHUB, DEV_TOOLS_TOKEN: token, OWNER_TWITCH_ID: "1" });
  const dev = (p: string, body: object) =>
    call(f.env, "/api/dev/" + p, "POST", body, undefined, { Authorization: "Bearer " + token });
  for (const [p, body] of [
    ["promote", {}],
    ["hotfix", { branch: "hotfix/a" }],
    ["rollback", { target: "production" }],
  ] satisfies [string, object][]) {
    const r = await dev(p, body);
    assert.deepEqual([r.status, r.body.reason], [403, "owner_session_required"], p);
  }
  assert.equal(calls.length, 0);
  assert.equal((await dev("deploy", { ref: "live-fix/a" })).status, 202);
  assert.equal((await dev("rollback", { target: "test" })).status, 202);
});

test("save creates the live-fix branch from main, then commits the file", async (t) => {
  const calls = stubFetch(t, [
    ["GET", /\/git\/ref\/heads\/live-fix\/overlay$/, 404, { message: "Not Found" }],
    ["GET", /\/git\/ref\/heads\/main$/, 200, { object: { sha: "b".repeat(40) } }],
    ["POST", /\/git\/refs$/, 201, { ref: "refs/heads/live-fix/overlay" }],
    [
      "PUT",
      /\/contents\/src\/served\/overlay\.js$/,
      200,
      { content: { sha: "c".repeat(40) }, commit: { sha: "d".repeat(40) } },
    ],
  ]);
  const f = environment(GITHUB);
  const body = {
    path: "src/served/overlay.js",
    content: "héllo ✓\n",
    branch: "live-fix/overlay",
    sha: "a".repeat(40),
    message: "Fix overlay",
  };
  const r = await post(f, "code/save", body, await f.owner());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    ok: true,
    path: "src/served/overlay.js",
    branch: "live-fix/overlay",
    branchCreated: true,
    sha: "c".repeat(40),
    commit: "d".repeat(40),
  });
  assert.ok(calls.every((c) => c.url.startsWith("https://api.github.com/repos/Finesssee/pixfray/")));
  assert.equal(calls[0].headers.Authorization, "Bearer test-only-gh-token");
  assert.ok(calls[0].headers["User-Agent"]);
  assert.deepEqual(calls[2].body, { ref: "refs/heads/live-fix/overlay", sha: "b".repeat(40) });
  const put = calls[3].body;
  assert.deepEqual([put.branch, put.sha, put.message], ["live-fix/overlay", "a".repeat(40), "Fix overlay"]);
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(put.content), (ch) => ch.charCodeAt(0))), "héllo ✓\n");
});

test("save conflict and GitHub failures map to clear errors without leaking the token", async (t) => {
  stubFetch(t, [
    ["GET", /\/git\/ref\/heads\/live-fix\/a$/, 200, { object: { sha: "b".repeat(40) } }],
    ["PUT", /\/contents\//, 409, { message: "README.md does not match" }],
  ]);
  const f = environment(GITHUB);
  const r = await post(f, "code/save", { path: "README.md", content: "x", branch: "live-fix/a" }, await f.owner());
  assert.deepEqual([r.status, r.body.reason], [409, "github_error"]);
  assert.match(r.body.error, /conflict/i);
  assert.doesNotMatch(JSON.stringify(r.body), /test-only-gh-token/);
});

test("reading a file falls back to main when the branch does not exist and rejects binaries", async (t) => {
  const text = btoa("export const a = 1;\n").replace(/(.{8})/g, "$1\n");
  const calls = stubFetch(t, [
    [
      "GET",
      /\/contents\/server\/game\.js\?ref=live-fix%2Fnew$/,
      404,
      { message: "No commit found for the ref live-fix/new" },
    ],
    ["GET", /\/git\/ref\/heads\/live-fix\/new$/, 404, { message: "Not Found" }],
    [
      "GET",
      /\/contents\/server\/game\.js\?ref=main$/,
      200,
      { type: "file", encoding: "base64", size: 20, sha: "e".repeat(40), content: text },
    ],
    [
      "GET",
      /\/contents\/public\/assets\/player\.png\?ref=main$/,
      200,
      { type: "file", encoding: "base64", size: 4, sha: "f".repeat(40), content: btoa("\x89PN\xff") },
    ],
  ]);
  const f = environment(GITHUB),
    owner = await f.owner();
  const r = await get(f, "code/file?path=server/game.js&branch=live-fix/new", owner);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    path: "server/game.js",
    ref: "main",
    sha: "e".repeat(40),
    size: 20,
    content: "export const a = 1;\n",
  });
  assert.equal(calls.length, 3);
  assert.equal((await get(f, "code/file?path=public/assets/player.png", owner)).status, 415);
});

test("test deploy, promote, hotfix and rollback dispatch the deploy workflow with checked inputs", async (t) => {
  const pull = (number: number, head: string) => ({
    number,
    state: "open",
    merged: false,
    base: { ref: "main" },
    head: { ref: head, sha: "1".repeat(40) },
  });
  const calls = stubFetch(t, [
    ["POST", /\/actions\/workflows\/deploy\.yml\/dispatches$/, 204, null],
    ["GET", /\/pulls\/7$/, 200, pull(7, "live-fix/overlay")],
    ["PUT", /\/pulls\/7\/merge$/, 200, { sha: "2".repeat(40), merged: true }],
    ["GET", /\/pulls\/8$/, 200, pull(8, "feature/x")],
    ["GET", /\/pulls\?state=open&head=Finesssee%3Ahotfix%2Fcrash$/, 200, []],
    ["POST", /\/pulls$/, 201, { number: 9, html_url: "https://github.com/Finesssee/pixfray/pull/9" }],
  ]);
  const f = environment(GITHUB),
    owner = await f.owner();
  const dispatch = (i: number) => calls.filter((c) => c.url.endsWith("/dispatches"))[i]?.body;

  const d = await post(f, "deploy", { ref: "live-fix/overlay" }, owner);
  assert.equal(d.status, 202);
  assert.match(d.body.requestId, /^r[0-9a-f]{10}$/);
  assert.deepEqual(dispatch(0), {
    ref: "live-fix/overlay",
    inputs: {
      operation: "deploy",
      target: "test",
      sha: "",
      percentage: "100",
      version_id: "",
      hotfix: "false",
      reason: "test deploy of live-fix/overlay",
      request_id: d.body.requestId,
    },
  });

  const p = await post(f, "promote", { number: 7, percentage: 25 }, owner);
  assert.equal(p.status, 202);
  assert.deepEqual(p.body.merged, { number: 7, sha: "2".repeat(40), alreadyMerged: false });
  assert.deepEqual(calls.find((c) => c.method === "PUT").body, { merge_method: "squash", sha: "1".repeat(40) });
  const promoted = dispatch(1);
  assert.deepEqual(
    [promoted.ref, promoted.inputs.target, promoted.inputs.sha, promoted.inputs.percentage],
    ["main", "production", "2".repeat(40), "25"],
  );
  assert.equal((await post(f, "promote", { number: 8 }, owner)).status, 400);

  const h = await post(f, "hotfix", { branch: "hotfix/crash", reason: "overlay crash" }, owner);
  assert.deepEqual([h.status, h.body.pr.number], [202, 9]);
  const hot = dispatch(2);
  assert.deepEqual(
    [hot.ref, hot.inputs.target, hot.inputs.hotfix, hot.inputs.reason],
    ["hotfix/crash", "production", "true", "overlay crash"],
  );

  const versionId = "0123abcd-0000-4000-8000-0123456789ab";
  assert.equal((await post(f, "rollback", { target: "production", versionId }, owner)).status, 202);
  const back = dispatch(3);
  assert.deepEqual(
    [back.ref, back.inputs.operation, back.inputs.target, back.inputs.version_id],
    ["main", "rollback", "production", versionId],
  );
  assert.equal(dispatch(4), undefined, "four dispatches in all");
});

test("runs and versions map the upstream responses", async (t) => {
  const run = {
    id: 5,
    display_title: "deploy test live-fix/a r1",
    status: "completed",
    conclusion: "success",
    head_branch: "live-fix/a",
    head_sha: "a".repeat(40),
    created_at: "2026-10-01T00:00:00Z",
    html_url: "https://github.com/x",
  };
  const deployment = {
    id: "d1",
    created_on: "2026-10-01",
    source: "api",
    versions: [{ version_id: "v2", percentage: 100 }],
    annotations: { "workers/message": "promote #7" },
  };
  const version = {
    id: "v2",
    number: 2,
    metadata: { created_on: "2026-10-01" },
    annotations: { "workers/tag": "gh-aaaaaaa-1" },
  };
  const script = (path: string) => new RegExp("/workers/scripts/nesszerra-mini-chat(-test)?/" + path + "$");
  stubFetch(t, [
    ["GET", /\/actions\/workflows\/deploy\.yml\/runs\?per_page=10$/, 200, { workflow_runs: [run] }],
    ["GET", script("deployments"), 200, { success: true, result: { deployments: [deployment] } }],
    ["GET", script("versions"), 200, { success: true, result: { items: [version] } }],
  ]);
  const f = environment({ ...GITHUB, CF_API_TOKEN: "test-only-cf", CF_ACCOUNT_ID: "a".repeat(32) }),
    owner = await f.owner();
  const runs = await get(f, "runs", owner);
  assert.deepEqual([runs.status, runs.body[0].conclusion], [200, "success"]);
  const v = await get(f, "versions", owner),
    { production, test: staging } = v.body;
  assert.deepEqual(
    [v.status, production.script, staging.script],
    [200, "nesszerra-mini-chat", "nesszerra-mini-chat-test"],
  );
  assert.deepEqual(production.deployments[0].versions, [{ versionId: "v2", percentage: 100 }]);
  assert.equal(production.versions[0].tag, "gh-aaaaaaa-1");
});

test("request usage sums every Worker on the account for the current UTC day", async (t) => {
  const sum = (requests: number, errors: number, subrequests: number, scriptName: string) => ({
    sum: { requests, errors, subrequests },
    dimensions: { scriptName },
  });
  const rows = [
    sum(1200, 3, 10, "nesszerra-mini-chat"),
    sum(300, 0, 0, "nesszerra-mini-chat-test"),
    sum(500, 1, 0, "nesszerra-mini-chat"),
  ];
  const calls = stubFetch(t, [
    ["POST", /\/client\/v4\/graphql$/, 200, { data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } } }],
  ]);
  // the success shape; usage() returns a union of it and the error shapes
  const u: Loose = await usage(
    asEnv({ CF_API_TOKEN: "test-only-cf", CF_ACCOUNT_ID: "a".repeat(32) }),
    Date.parse("2026-10-01T15:30:00Z"),
  );
  assert.deepEqual(
    [u.requests, u.percent, u.scripts["nesszerra-mini-chat"].requests, u.since, u.resetsAt],
    [2000, 2, 1700, "2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z"],
  );
  assert.equal(calls[0].body.variables.a, "a".repeat(32));
});

test("request usage reports an analytics error instead of throwing", async (t) => {
  stubFetch(t, [["POST", /graphql/, 200, { errors: [{ message: "no access" }], data: null }]]);
  const u: { configured: boolean; error?: string; requests?: number } = await usage(
    asEnv({ CF_API_TOKEN: "x", CF_ACCOUNT_ID: "a".repeat(32) }),
  );
  assert.equal(u.configured, true);
  assert.ok(u.error);
  assert.equal(u.requests, undefined);
});

test("an upstream network failure returns 503 and is logged, never thrown", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network down");
  });
  const f = environment(GITHUB),
    owner = await f.owner(),
    pending: Promise<unknown>[] = [];
  const ctx = asExecutionContext({ waitUntil: (p) => pending.push(p) });
  const r = await worker.fetch(req("/api/dev/runs", "GET", undefined, owner), f.env, ctx);
  assert.equal(r.status, 503);
  await Promise.all(pending);
  const logs = await get(f, "logs", owner);
  assert.deepEqual([logs.body[0].message, logs.body[0].context.path], ["network down", "/api/dev/runs"]);
});
