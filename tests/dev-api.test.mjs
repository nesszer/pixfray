// Live-fix API (/api/dev/*): owner gate, not-configured paths, request validation, GitHub calls,
// and the ChannelRoom side on real SQLite. GitHub and Cloudflare are stubbed through globalThis.fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker from "../server/worker.js";
import { digest } from "../server/auth.js";
import { ChannelRoom } from "../server/channel.js";
import { validPath, usage, logRoomEvent } from "../server/developer.js";

const ORIGIN = "https://chat.miolaf.xyz";
const SECRET = "test-only-internal-secret-0123456789";

function fakeCtx() {
  const db = new DatabaseSync(":memory:");
  return {
    storage: {
      sql: {
        exec(query, ...params) {
          const rows = db
            .prepare(query)
            .all(...params)
            .map((r) => ({ ...r }));
          return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
        },
      },
      transactionSync(fn) {
        return fn();
      },
      async setAlarm() {},
      async deleteAlarm() {},
    },
    acceptWebSocket() {},
    getWebSockets: () => [],
  };
}

// A real ChannelRoom (node:sqlite) behind ROOMS, and an in-memory AuthStore.
function environment(extra = {}) {
  const entries = new Map(),
    rooms = new Map();
  const env = {
    AUTH_SECRET: "test-only-auth-key",
    INTERNAL_SECRET: SECRET,
    TWITCH_CLIENT_ID: "test-app",
    TWITCH_CLIENT_SECRET: "test-secret",
    AUTH: {
      idFromName: (x) => x,
      get: () => ({
        async fetch(url, options) {
          const u = new URL(url),
            key = u.searchParams.get("key");
          if (u.pathname === "/list")
            return Response.json(
              [...entries].filter(([k]) => k.startsWith(key)).map(([k, value]) => ({ key: k, value })),
            );
          if (u.pathname === "/consume") {
            const v = entries.get(key) ?? null;
            entries.delete(key);
            return Response.json(v);
          }
          if (options.method === "GET") return Response.json(entries.get(key) ?? null);
          if (options.method === "DELETE") {
            entries.delete(key);
            return Response.json({ ok: true });
          }
          entries.set(key, JSON.parse(options.body).value);
          return Response.json({ ok: true });
        },
      }),
    },
    ROOMS: {
      idFromName: (x) => x,
      get: (name) => {
        if (!rooms.has(name))
          rooms.set(name, new ChannelRoom(fakeCtx(), { INTERNAL_SECRET: SECRET, BACKUPS: env.BACKUPS }));
        const room = rooms.get(name);
        return { fetch: (url, init) => room.fetch(new Request(url, init)) };
      },
    },
    ASSETS: { fetch: async () => Response.json([{ id: "player" }]) },
    ...extra,
  };
  return { env, entries, rooms };
}
// D1 (prepare/bind/run/all/first/batch) over node:sqlite. Blobs come back as arrays of numbers, as D1 returns them.
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const args = (params) => params.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
  const row = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? [...v] : v]));
  const statement = (query, params = []) => ({
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
    prepare: (query) => statement(query),
    async batch(list) {
      const out = [];
      for (const st of list) out.push(await st.run());
      return out;
    },
  };
}
async function cron(f, at) {
  const pending = [];
  await worker.scheduled({ scheduledTime: at, cron: "0 9 * * *" }, f.env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
}
const GITHUB = { GITHUB_TOKEN: "test-only-gh-token", GITHUB_REPO: "Finesssee/pixfray" };
async function cookieFor(f, owner) {
  const cookie = (owner ? "a" : "b").repeat(64),
    user = owner
      ? { id: "1", login: "nesszerra", displayName: "nesszerra" }
      : { id: "2", login: "viewer", displayName: "Viewer" };
  f.entries.set("owner:nesszerra", { id: "1" });
  f.entries.set("session:" + (await digest(cookie)), { user });
  return "mini_session=" + cookie;
}
function req(path, method = "GET", data, cookie, headers = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== "GET" ? { Origin: ORIGIN, "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(data !== undefined ? { body: typeof data === "string" ? data : JSON.stringify(data) } : {}),
  });
}
async function call(f, path, method, data, cookie, headers) {
  const r = await worker.fetch(req(path, method, data, cookie, headers), f.env, { waitUntil() {} });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// Records GitHub/Cloudflare calls and answers from a route table; anything unexpected fails the test.
function stubFetch(t, routes) {
  const calls = [],
    original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input),
      method = init.method || "GET";
    calls.push({
      url,
      method,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      headers: init.headers,
    });
    for (const [pattern, reply] of routes) {
      const [m, re] = pattern;
      if (m === method && re.test(url)) {
        const [status, body] = typeof reply === "function" ? reply(url, init) : reply;
        return new Response(body === null ? null : JSON.stringify(body), { status });
      }
    }
    throw new Error("Unexpected fetch " + method + " " + url);
  };
  t.after(() => {
    globalThis.fetch = original;
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
    viewer = await cookieFor(f, false);
  for (const p of ROUTES) {
    assert.equal((await call(f, "/api/dev/" + p)).status, 401, p);
    const r = await call(f, "/api/dev/" + p, "GET", undefined, viewer);
    assert.equal(r.status, 403, p);
    assert.equal(r.body.reason, "owner_only");
  }
  for (const p of POSTS) assert.equal((await call(f, "/api/dev/" + p, "POST", {}, viewer)).status, 403, p);
  assert.equal((await call(f, "/api/dev/logs", "DELETE", undefined, viewer)).status, 403);
});

test("mutations must be same-origin, unknown routes 404, wrong methods 405", async () => {
  const f = environment(GITHUB),
    owner = await cookieFor(f, true);
  assert.equal(
    (
      await call(f, "/api/dev/channels", "POST", { action: "pause", login: "someone" }, owner, {
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );
  assert.equal((await call(f, "/api/dev/nope", "GET", undefined, owner)).status, 404);
  assert.equal((await call(f, "/api/dev/codex", "GET", undefined, owner)).status, 404, "the Codex switch is gone");
  assert.equal((await call(f, "/api/dev/deploy", "GET", undefined, owner)).status, 405);
  assert.equal((await call(f, "/api/dev/diagnostics", "POST", {}, owner)).status, 405);
  assert.equal((await call(f, "/api/dev/channels", "POST", "[1]", owner)).status, 400);
  assert.equal((await call(f, "/api/dev/channels", "POST", "{bad", owner)).status, 400);
});

test("GitHub and Cloudflare routes answer 501 not configured when their secrets are missing", async (t) => {
  stubFetch(t, []);
  const f = environment(),
    owner = await cookieFor(f, true);
  for (const [p, m] of [
    ["code/tree", "GET"],
    ["code/file?path=README.md", "GET"],
    ["runs", "GET"],
    ["code/save", "POST"],
    ["code/pr", "POST"],
    ["deploy", "POST"],
    ["promote", "POST"],
    ["hotfix", "POST"],
    ["rollback", "POST"],
  ]) {
    const r = await call(f, "/api/dev/" + p, m, m === "POST" ? {} : undefined, owner);
    assert.equal(r.status, 501, p);
    assert.equal(r.body.reason, "github_not_configured");
    assert.deepEqual(r.body.missing, ["GITHUB_TOKEN", "GITHUB_REPO"]);
  }
  const half = environment({ GITHUB_TOKEN: "x", GITHUB_REPO: "not a repo" }),
    o2 = await cookieFor(half, true);
  assert.deepEqual((await call(half, "/api/dev/runs", "GET", undefined, o2)).body.missing, ["GITHUB_REPO"]);
  const v = await call(f, "/api/dev/versions", "GET", undefined, owner);
  assert.equal(v.status, 501);
  assert.equal(v.body.reason, "cloudflare_not_configured");
  const u = await call(f, "/api/dev/usage", "GET", undefined, owner);
  assert.equal(u.status, 200);
  assert.equal(u.body.configured, false);
  assert.equal(u.body.limit, 100000);
});

test("diagnostics keeps the contract shape and reports integrations and usage", async (t) => {
  stubFetch(t, []);
  const f = environment({ CF_VERSION_METADATA: { id: "v-1", tag: "gh-abc", timestamp: "2026-10-01T00:00:00Z" } }),
    owner = await cookieFor(f, true);
  const r = await call(f, "/api/dev/diagnostics", "GET", undefined, owner);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.worker).slice(0, 3), ["version", "twitchConfigured", "productionEnabled"]);
  assert.equal(r.body.worker.productionEnabled, false);
  assert.equal(r.body.worker.deployedVersion.id, "v-1");
  assert.equal(r.body.room.channel, "nesszerra");
  assert.equal(r.body.room.chat.connected, false);
  assert.equal(r.body.room.chatStatus.status, "disconnected");
  assert.equal(r.body.room.paused, true);
  assert.deepEqual(r.body.room.sockets, { live: 0 });
  assert.equal(r.body.integrations.github.configured, false);
  assert.equal(r.body.integrations.cloudflare.configured, false);
  assert.equal(r.body.usage.configured, false);
  assert.equal("codex" in r.body, false);
  assert.equal(r.body.room.seLastCommandAt, 0);
});

test("channels lists the registry without reading any room, and progress answers per channel", async () => {
  const f = environment(),
    owner = await cookieFor(f, true),
    reads = [];
  const get = f.env.ROOMS.get;
  f.env.ROOMS.get = (name) => {
    reads.push(name);
    return get(name);
  };
  const list = await call(f, "/api/dev/channels", "GET", undefined, owner);
  assert.equal(list.status, 200);
  assert.equal("progress" in list.body, false, "progress comes from /api/dev/progress");
  assert.equal(list.body.progressBatch, 40);
  assert.deepEqual(list.body.builtin, ["nesszerra", "miolafff"]);
  assert.equal(reads.length, 0);
  const r = await call(f, "/api/dev/progress?logins=nesszerra,MIOLAFFF", "GET", undefined, owner);
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
  assert.equal(p.overlays, 0);
  assert.equal(p.source, "");
  assert.equal(p.commands, 12);
  assert.equal(p.commandsWorking, 0);
});

test("progress covers more than 40 channels across batched calls, 40 room reads at most per call", async () => {
  const f = environment(),
    owner = await cookieFor(f, true),
    reads = [];
  const logins = Array.from({ length: 95 }, (_, i) => "streamer_" + String(i).padStart(3, "0"));
  logins.forEach((login, i) =>
    f.entries.set("channel:" + login, {
      id: String(100 + i),
      login,
      enabledAt: 1000 + i,
      ...(i === 94 ? { pausedAt: 5 } : {}),
    }),
  );
  const get = f.env.ROOMS.get;
  f.env.ROOMS.get = (name) => {
    reads.push(name);
    return get(name);
  };
  const list = await call(f, "/api/dev/channels", "GET", undefined, owner);
  const on = [...list.body.builtin, ...list.body.channels.filter((c) => !c.pausedAt).map((c) => c.login)];
  assert.equal(on.length, 96);
  assert.equal(list.body.channels.length, 95);
  const seen = {};
  for (let i = 0; i < on.length; i += list.body.progressBatch) {
    reads.length = 0;
    const r = await call(
      f,
      "/api/dev/progress?logins=" + on.slice(i, i + list.body.progressBatch).join(","),
      "GET",
      undefined,
      owner,
    );
    assert.equal(r.status, 200);
    assert.ok(reads.length <= 40, "room reads in one call: " + reads.length);
    Object.assign(seen, r.body.progress);
  }
  assert.deepEqual(Object.keys(seen).sort(), [...on].sort());
  assert.equal(seen.streamer_050.commands, 12);
});

test("progress validates logins: required, at most 40, only channels that are on", async () => {
  const f = environment(),
    owner = await cookieFor(f, true);
  f.entries.set("channel:oldone", { id: "7", login: "oldone", enabledAt: 1, pausedAt: 2 });
  f.entries.set("channel:newone", { id: "8", login: "newone", enabledAt: 1 });
  const get = (q) => call(f, "/api/dev/progress" + q, "GET", undefined, owner);
  assert.equal((await get("")).body.reason, "logins_required");
  assert.equal((await get("?logins=,,")).status, 400);
  const many = await get("?logins=" + Array.from({ length: 41 }, (_, i) => "channel" + i).join(","));
  assert.deepEqual([many.status, many.body.reason, many.body.max], [400, "too_many_logins", 40]);
  const unknown = await get("?logins=nesszerra,nobody_here");
  assert.deepEqual(
    [unknown.status, unknown.body.reason, unknown.body.invalid],
    [400, "unknown_channel", ["nobody_here"]],
  );
  assert.equal((await get("?logins=oldone")).body.reason, "unknown_channel", "a channel that is off has no progress");
  assert.equal((await get("?logins=../x,a")).status, 400);
  const dup = await get("?logins=newone,newone, NewOne");
  assert.equal(dup.status, 200);
  assert.deepEqual(Object.keys(dup.body.progress), ["newone"]);
  assert.equal((await call(f, "/api/dev/progress?logins=nesszerra", "POST", {}, owner)).status, 405);
});

test("progress and export answer 401 signed out and 403 for a non-owner", async () => {
  const f = environment(),
    viewer = await cookieFor(f, false);
  for (const p of ["progress?logins=nesszerra", "export?channel=nesszerra", "export?registry=1"]) {
    assert.equal((await call(f, "/api/dev/" + p)).status, 401, p);
    const r = await call(f, "/api/dev/" + p, "GET", undefined, viewer);
    assert.deepEqual([r.status, r.body.reason], [403, "owner_only"], p);
  }
});

test("export downloads one room as JSON: fighters, ranks, config, history, characters, command names, no key", async () => {
  const f = environment(),
    owner = await cookieFor(f, true);
  f.env.ROOMS.get("nesszerra");
  const room = f.rooms.get("nesszerra"),
    sql = room.ctx.storage.sql;
  const secret = room.seSettings().secret;
  assert.match(secret, /^[a-f0-9]{16,}$/);
  sql.exec(
    "INSERT INTO profiles (user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen, power, guard, luck, hat) VALUES ('11', 'fighter1', 'Fighter1', 'player', '#ff0000', 'strike', 1234, 9, 3, 5, 1, 2, 3, 'crown')",
  );
  sql.exec(
    "INSERT INTO profiles (user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen) VALUES ('12', 'fighter2', 'Fighter2', 'player', '#00ff00', 'heal', 900, 1, 8, 6)",
  );
  sql.exec("UPDATE profiles SET dollars = 70, title = 'legend', build = 1 WHERE user_id = '11'");
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
  await call(
    f,
    "/api/dev/settings",
    "POST",
    { action: "config", payload: { patch: { maxHp: 120 }, baseVersion: 1, note: "tankier" } },
    owner,
  );

  const res = await worker.fetch(req("/api/dev/export?channel=NessZerra", "GET", undefined, owner), f.env, {
    waitUntil() {},
  });
  assert.equal(res.status, 200);
  assert.match(
    res.headers.get("Content-Disposition"),
    /^attachment; filename="mini-chat-nesszerra-\d{4}-\d{2}-\d{2}\.json"$/,
  );
  assert.match(res.headers.get("Content-Type"), /^application\/json/);
  const text = await res.text(),
    data = JSON.parse(text);
  assert.deepEqual(
    [data.format, data.version, data.kind, data.channel, data.status],
    ["mini-chat-export", 1, "channel", "nesszerra", "builtin"],
  );
  assert.deepEqual(
    data.profiles.map((p) => [p.username, p.elo, p.wins, p.losses]),
    [
      ["fighter1", 1234, 9, 3],
      ["fighter2", 900, 1, 8],
    ],
  );
  assert.deepEqual(
    [data.profiles[0].power, data.profiles[0].hat, data.profiles[0].defaultAbility, data.profiles[0].userId],
    [1, "crown", "strike", "11"],
  );
  assert.equal(data.config.maxHp, 120);
  assert.equal(data.configVersion, 2);
  assert.deepEqual(
    data.configHistory.map((h) => [h.version, h.note]),
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
  assert.deepEqual(
    [data.profiles[0].dollars, data.profiles[0].title, data.profiles[0].build, data.profiles[0].bonus],
    [70, "legend", 1, 0],
  );
  assert.deepEqual(data.purchases, [{ userId: "11", kind: "title", itemId: "legend", price: 50, boughtAt: 7 }]);
  assert.deepEqual(data.builds, [{ userId: "11", slot: 0, data: { title: "" } }]);
  assert.ok(!text.includes(secret), "the StreamElements key is not exported");
  assert.doesNotMatch(text, /secret|subscriptionId|token/i);
});

// Point-in-time restore. Node has no PITR, so the room's storage gets a fake one: bookmarks are 'b<ms>' style hex
// strings, onNextSessionRestoreBookmark returns an undo point, and abort() throws as the real one ends the session.
function fakePitr(room) {
  const calls = { armed: [], aborted: 0, times: [] };
  Object.assign(room.ctx.storage, {
    async getBookmarkForTime(t) {
      calls.times.push(t);
      return "0000007b-" + Number(t).toString(16).padStart(12, "0") + "-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b";
    },
    async onNextSessionRestoreBookmark(b) {
      calls.armed.push(b);
      return "0000007c-00000000ffff-00001539-" + "e".repeat(32);
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
    owner = await cookieFor(f, true);
  f.env.ROOMS.get("nesszerra");
  const room = f.rooms.get("nesszerra"),
    pitr = fakePitr(room);
  const state = room.readState("nesszerra");
  state.revision = 40;
  room.writeState(state);
  room.ctx.storage.sql.exec(
    "INSERT INTO profiles (user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen) VALUES ('11', 'fighter1', 'Fighter1', 'player', '#ff0000', 'strike', 1000, 0, 0, 0)",
  );
  const at = Date.now() - 3 * 3600000;

  assert.deepEqual((await call(f, "/api/dev/restore?channel=nesszerra", "GET", undefined, owner)).body, {
    channel: "nesszerra",
    last: null,
    windowDays: 30,
  });
  const r = await call(f, "/api/dev/restore", "POST", { channel: "NessZerra", at }, owner);
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
  assert.deepEqual(
    [saved.at, saved.by, saved.undo],
    [at, "nesszerra", "0000007c-00000000ffff-00001539-" + "e".repeat(32)],
  );
  const info = (await call(f, "/api/dev/restore?channel=nesszerra", "GET", undefined, owner)).body;
  assert.deepEqual([info.last.at, info.last.by], [at, "nesszerra"]);
  assert.equal("undo" in info.last, false, "the undo point stays on the server");

  const u = await call(f, "/api/dev/restore", "POST", { channel: "nesszerra", undo: true }, owner);
  assert.deepEqual([u.status, u.body.undone], [200, true]);
  assert.equal(pitr.armed[1], saved.undo, "undo restores to the saved point");
  assert.equal(pitr.aborted, 2);
  assert.equal(f.entries.has("restore:nesszerra"), false, "an undone restore leaves nothing to undo");
  const again = await call(f, "/api/dev/restore", "POST", { channel: "nesszerra", undo: true }, owner);
  assert.deepEqual([again.status, again.body.reason], [409, "nothing_to_undo"]);
});

test("restore refuses times outside the 30-day window, unknown channels, and local dev without PITR", async () => {
  const f = environment(),
    owner = await cookieFor(f, true),
    day = 86400000,
    now = Date.now();
  for (const at of [now - 31 * day, now, now + day, "yesterday", undefined]) {
    const r = await call(f, "/api/dev/restore", "POST", { channel: "nesszerra", at }, owner);
    assert.deepEqual([r.status, r.body.reason], [400, "invalid_restore_time"], String(at));
  }
  const unknown = await call(f, "/api/dev/restore", "POST", { channel: "nobody_here", at: now - day }, owner);
  assert.deepEqual([unknown.status, unknown.body.reason], [404, "unknown_channel"]);
  assert.equal((await call(f, "/api/dev/restore?channel=bad%20login", "GET", undefined, owner)).status, 400);
  const local = await call(f, "/api/dev/restore", "POST", { channel: "nesszerra", at: now - day }, owner);
  assert.deepEqual([local.status, local.body.reason], [501, "restore_unavailable"]);
  assert.equal(f.entries.has("restore:nesszerra"), false);
  f.env.ROOMS.get("nesszerra");
  const room = f.rooms.get("nesszerra");
  fakePitr(room);
  room.ctx.storage.getBookmarkForTime = async () => "not a bookmark; DROP TABLE";
  const bad = await call(f, "/api/dev/restore", "POST", { channel: "nesszerra", at: now - day }, owner);
  assert.deepEqual([bad.status, bad.body.reason], [502, "invalid_bookmark"]);
  const crossOrigin = await call(f, "/api/dev/restore", "POST", { channel: "nesszerra", at: now - day }, owner, {
    Origin: "https://evil.example",
  });
  assert.equal(crossOrigin.status, 403);
});

test("export does not create a StreamElements key or change the room", async () => {
  const f = environment(),
    owner = await cookieFor(f, true);
  f.env.ROOMS.get("miolafff");
  const sql = f.rooms.get("miolafff").ctx.storage.sql,
    count = () => sql.exec("SELECT COUNT(*) AS n FROM se_settings").toArray()[0].n;
  assert.equal(count(), 0);
  const r = await call(f, "/api/dev/export?channel=miolafff", "GET", undefined, owner);
  assert.equal(r.status, 200);
  assert.equal(r.body.profiles.length, 0);
  assert.equal(count(), 0);
});

test("export of an unknown channel is 404, a paused channel still exports, and a target is required", async () => {
  const f = environment(),
    owner = await cookieFor(f, true);
  f.entries.set("channel:paused_one", { id: "9", login: "paused_one", enabledAt: 1, pausedAt: 2 });
  const miss = await call(f, "/api/dev/export?channel=nobody_here", "GET", undefined, owner);
  assert.deepEqual([miss.status, miss.body.reason], [404, "unknown_channel"]);
  assert.equal((await call(f, "/api/dev/export?channel=../etc", "GET", undefined, owner)).status, 404);
  assert.equal((await call(f, "/api/dev/export", "GET", undefined, owner)).status, 400);
  const ok = await call(f, "/api/dev/export?channel=paused_one", "GET", undefined, owner);
  assert.deepEqual([ok.status, ok.body.channel, ok.body.status], [200, "paused_one", "paused"]);
});

test("export of the channel list has every channel and who turned it off", async () => {
  const f = environment(),
    owner = await cookieFor(f, true);
  f.entries.set("channel:oldone", { id: "7", login: "oldone", enabledAt: 1000, pausedAt: 2000 });
  const res = await worker.fetch(req("/api/dev/export?registry=1", "GET", undefined, owner), f.env, { waitUntil() {} });
  assert.match(
    res.headers.get("Content-Disposition"),
    /^attachment; filename="mini-chat-channels-\d{4}-\d{2}-\d{2}\.json"$/,
  );
  const text = await res.text(),
    data = JSON.parse(text);
  assert.deepEqual([data.kind, data.builtin], ["registry", ["nesszerra", "miolafff"]]);
  assert.deepEqual(data.channels, [{ id: "7", login: "oldone", enabledAt: 1000, pausedAt: 2000, pausedBy: "" }]);
  assert.equal("invites" in data, false);
});

test("the daily cron backs up every channel into D1; the owner lists the days, downloads one and reads one fighter", async () => {
  const f = environment({ BACKUPS: fakeD1() }),
    owner = await cookieFor(f, true);
  f.entries.set("channel:paused_one", { id: "9", login: "paused_one", enabledAt: 1, pausedAt: 2 });
  f.env.ROOMS.get("nesszerra");
  const sql = f.rooms.get("nesszerra").ctx.storage.sql;
  sql.exec(
    "INSERT INTO profiles (user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen) VALUES ('11', 'fighter1', 'Fighter1', 'player', '#ff0000', 'strike', 1234, 9, 3, 5)",
  );
  sql.exec(
    "INSERT INTO owned_items (user_id, kind, item_id, price, bought_at) VALUES ('11', 'title', 'legend', 50, 7), ('12', 'hat', 'crown', 40, 8)",
  );
  sql.exec("INSERT INTO builds (user_id, slot, data) VALUES ('11', 0, '{\"title\":\"legend\"}')");
  const at = Date.UTC(2026, 9, 9, 9);
  await cron(f, at);
  // A reset after the backup doesn't reach it.
  sql.exec("UPDATE profiles SET elo = 1000, wins = 0, losses = 0 WHERE user_id = '11'");

  const list = await call(f, "/api/dev/backups?channel=NessZerra", "GET", undefined, owner);
  assert.equal(list.status, 200);
  assert.equal(list.body.keepDays, 90);
  assert.deepEqual(
    list.body.backups.map((b) => [b.day, b.at]),
    [["2026-10-09", at]],
  );
  assert.ok(list.body.backups[0].bytes > 100);
  for (const user of ["fighter1", "@FIGHTER1", "11"]) {
    const one = await call(
      f,
      "/api/dev/backups?channel=nesszerra&day=2026-10-09&user=" + user,
      "GET",
      undefined,
      owner,
    );
    assert.equal(one.status, 200, user);
    assert.deepEqual(
      [one.body.day, one.body.exportedAt, one.body.profile.elo, one.body.profile.wins, one.body.profile.losses],
      ["2026-10-09", "2026-10-09T09:00:00.000Z", 1234, 9, 3],
    );
    assert.deepEqual(
      one.body.purchases.map((p) => p.itemId),
      ["legend"],
    );
    assert.deepEqual(one.body.builds, [{ userId: "11", slot: 0, data: { title: "legend" } }]);
  }
  const res = await worker.fetch(
    req("/api/dev/backups?channel=nesszerra&day=2026-10-09", "GET", undefined, owner),
    f.env,
    {
      waitUntil() {},
    },
  );
  assert.equal(
    res.headers.get("Content-Disposition"),
    'attachment; filename="mini-chat-nesszerra-2026-10-09-backup.json"',
  );
  const data = await res.json();
  assert.deepEqual(
    [data.format, data.kind, data.channel, data.status, data.counts.profiles, data.counts.purchases],
    ["mini-chat-export", "channel", "nesszerra", "builtin", 1, 2],
  );
  const paused = await call(f, "/api/dev/backups?channel=paused_one&day=2026-10-09", "GET", undefined, owner);
  assert.deepEqual([paused.status, paused.body.status], [200, "paused"]);
  assert.equal((await call(f, "/api/dev/backups?channel=miolafff", "GET", undefined, owner)).body.backups.length, 1);

  const reason = async (q) => {
    const r = await call(f, "/api/dev/backups?" + q, "GET", undefined, owner);
    return [r.status, r.body.reason];
  };
  assert.deepEqual(await reason(""), [400, "channel_required"]);
  assert.deepEqual(await reason("channel=nesszerra&day=yesterday"), [400, "invalid_day"]);
  assert.deepEqual(await reason("channel=nesszerra&day=2026-10-08"), [404, "no_backup"]);
  assert.deepEqual(await reason("channel=nesszerra&day=2026-10-09&user=nobody"), [404, "fighter_not_in_backup"]);
});

test("backups keep 90 days, and a second backup on the same day replaces that day's", async () => {
  const f = environment({ BACKUPS: fakeD1() }),
    owner = await cookieFor(f, true),
    day = 86400000,
    start = Date.UTC(2026, 6, 1, 9);
  const list = async () => (await call(f, "/api/dev/backups?channel=nesszerra", "GET", undefined, owner)).body.backups;
  await cron(f, start);
  await cron(f, start + day);
  await cron(f, start + day + 60000);
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
    owner = await cookieFor(f, true);
  const now = await call(f, "/api/dev/backups", "POST", { channel: "NessZerra" }, owner);
  assert.equal(now.status, 200);
  assert.match(now.body.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(
    now.body.channels.map((c) => [c.channel, c.ok]),
    [["nesszerra", true]],
  );
  assert.equal((await call(f, "/api/dev/backups?channel=miolafff", "GET", undefined, owner)).body.backups.length, 0);
  const all = await call(f, "/api/dev/backups", "POST", {}, owner);
  assert.deepEqual(
    all.body.channels.map((c) => c.channel),
    ["nesszerra", "miolafff"],
  );
  const unknown = await call(f, "/api/dev/backups", "POST", { channel: "nobody_here" }, owner);
  assert.deepEqual([unknown.status, unknown.body.reason], [404, "unknown_channel"]);
  const room = await f.env.ROOMS.get("nesszerra").fetch("https://room/dev/backup", {
    method: "POST",
    headers: { "X-Mini-Internal": SECRET, "X-Mini-Channel": "nesszerra" },
    body: JSON.stringify({ at: "soon", status: "on" }),
  });
  assert.deepEqual([room.status, (await room.json()).reason], [400, "invalid_backup"]);

  const bare = environment(),
    cookie = await cookieFor(bare, true);
  for (const [method, p] of [
    ["GET", "/api/dev/backups?channel=nesszerra"],
    ["POST", "/api/dev/backups"],
  ]) {
    const r = await call(bare, p, method, method === "POST" ? {} : undefined, cookie);
    assert.deepEqual([r.status, r.body.reason], [501, "backups_unavailable"], method);
  }
  await cron(bare, Date.now());
  assert.equal(bare.rooms.size, 0);
});

test("a room that fails its backup is logged, and the other channels are still backed up", async () => {
  const f = environment({ BACKUPS: fakeD1() }),
    owner = await cookieFor(f, true),
    get = f.env.ROOMS.get;
  f.env.ROOMS.get = (name) =>
    name === "miolafff"
      ? {
          fetch: async () => {
            throw new Error("room down");
          },
        }
      : get(name);
  await cron(f, Date.UTC(2026, 9, 9, 9));
  assert.equal((await call(f, "/api/dev/backups?channel=nesszerra", "GET", undefined, owner)).body.backups.length, 1);
  const logs = await call(f, "/api/dev/logs?source=worker", "GET", undefined, owner);
  assert.deepEqual(
    logs.body.map((l) => [l.message, l.context.failed]),
    [["Daily backup failed for 1 channel(s)", [{ channel: "miolafff", ok: false, reason: "room down" }]]],
  );
});

test("rooms no longer create the leftover dev_settings table", () => {
  const ctx = fakeCtx();
  new ChannelRoom(ctx, { INTERNAL_SECRET: SECRET });
  assert.equal(ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'dev_settings'").toArray().length, 0);
});

test("error log: worker errors land in the room, can be filtered, and cleared", async () => {
  const f = environment(),
    owner = await cookieFor(f, true);
  const roomStub = f.env.ROOMS.get("nesszerra");
  await roomStub.fetch("https://room/dev/log", {
    method: "POST",
    headers: { "X-Mini-Internal": SECRET, "X-Mini-Channel": "nesszerra" },
    body: JSON.stringify({ message: "boom", context: { path: "/api/x", big: "y".repeat(5000) } }),
  });
  const logs = await call(f, "/api/dev/logs?source=worker&limit=5", "GET", undefined, owner);
  assert.equal(logs.status, 200);
  assert.equal(logs.body.length, 1);
  assert.equal(logs.body[0].message, "boom");
  assert.equal(typeof logs.body[0].context.truncated, "string");
  assert.equal((await call(f, "/api/dev/logs?source=room", "GET", undefined, owner)).body.length, 0);
  // Chat command lines and warnings share the log but don't count as errors.
  logRoomEvent(f.rooms.get("nesszerra"), "command", "alice challenge @bob -> challenge");
  logRoomEvent(f.rooms.get("nesszerra"), "warn", "slow");
  const d = await call(f, "/api/dev/diagnostics", "GET", undefined, owner);
  assert.equal(d.body.room.errors, 1);
  assert.equal(d.body.room.errorsBySource.command, 1);
  assert.equal(d.body.room.errorsBySource.worker, 1);
  assert.equal(d.body.room.lastError.message, "boom");
  assert.equal((await call(f, "/api/dev/logs", "DELETE", undefined, owner)).status, 200);
  assert.equal((await call(f, "/api/dev/logs", "GET", undefined, owner)).body.length, 0);
});

test("live settings passthrough edits the versioned config as the session user", async () => {
  const f = environment(),
    owner = await cookieFor(f, true);
  const before = await call(f, "/api/dev/settings", "GET", undefined, owner);
  assert.equal(before.status, 200);
  assert.equal(before.body.configVersion, 1);
  assert.equal((await call(f, "/api/dev/settings", "POST", { action: "resetAll" }, owner)).status, 400);
  assert.equal((await call(f, "/api/dev/settings", "POST", { action: "config" }, owner)).status, 400);
  const bad = await call(f, "/api/dev/settings", "POST", { action: "config", payload: { patch: { maxHp: 0 } } }, owner);
  assert.equal(bad.status, 400);
  const ok = await call(
    f,
    "/api/dev/settings",
    "POST",
    { action: "config", payload: { patch: { maxHp: 120 }, baseVersion: 1, note: "tankier" }, actorId: "forged" },
    owner,
  );
  assert.equal(ok.status, 200);
  const conflict = await call(
    f,
    "/api/dev/settings",
    "POST",
    { action: "config", payload: { patch: { maxHp: 130 }, baseVersion: 1 } },
    owner,
  );
  assert.equal(conflict.status, 409);
  const after = await call(f, "/api/dev/settings", "GET", undefined, owner);
  assert.equal(after.body.config.maxHp, 120);
  assert.equal(after.body.history[0].actorId, "1");
  const back = await call(f, "/api/dev/settings", "POST", { action: "rollbackConfig", payload: { version: 1 } }, owner);
  assert.equal(back.status, 200);
  assert.equal((await call(f, "/api/dev/settings", "GET", undefined, owner)).body.config.maxHp, 100);
});

test("owner can connect and disconnect Twitch chat from the dev settings; diagnostics report it", async (t) => {
  const f = environment(),
    owner = await cookieFor(f, true);
  const calls = stubFetch(t, [
    [
      ["POST", /id\.twitch\.tv\/oauth2\/token/],
      [200, { access_token: "app-token", expires_in: 3600 }],
    ],
    [
      ["GET", /helix\/eventsub\/subscriptions/],
      [200, { data: [], pagination: {} }],
    ],
    [
      ["POST", /helix\/eventsub\/subscriptions/],
      [202, { data: [{ id: "sub-dev", status: "enabled", created_at: "2026-10-01T00:00:00Z" }] }],
    ],
    [
      ["DELETE", /helix\/eventsub\/subscriptions\?id=sub-dev/],
      [204, null],
    ],
  ]);
  const on = await call(f, "/api/dev/settings", "POST", { action: "connectChat" }, owner);
  assert.equal(on.status, 200);
  assert.deepEqual([on.body.chatStatus.connected, on.body.chatStatus.subscriptionId], [true, "sub-dev"]);
  const diag = (await call(f, "/api/dev/diagnostics", "GET", undefined, owner)).body;
  assert.deepEqual([diag.room.chat.connected, diag.room.paused, diag.room.chatStatus.status], [true, false, "enabled"]);
  const off = await call(f, "/api/dev/settings", "POST", { action: "disconnectChat" }, owner);
  assert.equal(off.body.chatStatus.connected, false);
  assert.ok(calls.some((c) => c.method === "DELETE"));
  const viewer = await cookieFor(f, false);
  assert.equal((await call(f, "/api/dev/settings", "POST", { action: "connectChat" }, viewer)).status, 403);
});

test("editor paths reject traversal and protected files", () => {
  for (const p of ["server/worker.js", "public/dev.js", "README.md", "docs/LIVE_FIX.md"])
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

test("code editor request validation happens before GitHub is called", async (t) => {
  const calls = stubFetch(t, []);
  const f = environment(GITHUB),
    owner = await cookieFor(f, true);
  const bad = [
    ["code/file?path=.dev.vars", "GET"],
    ["code/file?path=README.md&branch=main2", "GET"],
    ["code/tree?ref=feature/x", "GET"],
    ["code/save", "POST", { path: "../x", content: "", branch: "live-fix/a" }],
    ["code/save", "POST", { path: "README.md", content: 5, branch: "live-fix/a" }],
    ["code/save", "POST", { path: "README.md", content: "x", branch: "main" }],
    ["code/save", "POST", { path: "README.md", content: "x", branch: "live-fix/A B" }],
    ["code/save", "POST", { path: "README.md", content: "x", branch: "live-fix/a", sha: "abc" }],
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
  ];
  for (const [p, m, body] of bad) {
    const r = await call(f, "/api/dev/" + p, m, body, owner);
    assert.equal(r.status, 400, p + " " + JSON.stringify(body));
    assert.ok(r.body.reason, p);
  }
  const big = await call(
    f,
    "/api/dev/code/save",
    "POST",
    { path: "README.md", content: "x".repeat(600 * 1024), branch: "live-fix/a" },
    owner,
  );
  assert.equal(big.status, 413);
  // Files the deploy workflow runs with its Cloudflare token can be read but not saved.
  for (const path of [
    "package.json",
    "package-lock.json",
    "bun.lock",
    "bunfig.toml",
    ".npmrc",
    "site.config.js",
    "cloudflare.config.ts",
    "vite.config.js",
    "vite.config.ts",
    "site.config.ts",
    "tsconfig.json",
    "tsconfig.strict.json",
    "types/lib-guards.d.ts",
    "scripts/release.mjs",
    "scripts/lib/zip-read.mjs",
  ]) {
    assert.equal(validPath(path), true, path);
    const r = await call(f, "/api/dev/code/save", "POST", { path, content: "x", branch: "live-fix/a" }, owner);
    assert.deepEqual([r.status, r.body.reason], [403, "build_file"], path);
  }
  assert.equal(calls.length, 0);
});

test("the editor saves TypeScript source files, which are not build files", async (t) => {
  const calls = stubFetch(t, [
    [
      ["GET", /\/git\/ref\/heads\/live-fix\/types$/],
      [200, { object: { sha: "b".repeat(40) } }],
    ],
    [
      ["PUT", /\/contents\/(server\/game|src\/admin)\.ts$/],
      [200, { content: { sha: "c".repeat(40) }, commit: { sha: "d".repeat(40) } }],
    ],
  ]);
  const f = environment(GITHUB),
    owner = await cookieFor(f, true);
  for (const path of ["server/game.ts", "src/admin.ts"]) {
    const r = await call(
      f,
      "/api/dev/code/save",
      "POST",
      { path, content: "export {};\n", branch: "live-fix/types", sha: "a".repeat(40) },
      owner,
    );
    assert.deepEqual([r.status, r.body.path], [200, path], path);
  }
  assert.equal(calls.filter((c) => c.method === "PUT").length, 2);
});

test("the dev token can deploy the test site but not production", async (t) => {
  const calls = stubFetch(t, [
    [
      ["POST", /\/actions\/workflows\/deploy\.yml\/dispatches$/],
      [204, null],
    ],
  ]);
  const token = "d".repeat(40),
    f = environment({ ...GITHUB, DEV_TOOLS_TOKEN: token, OWNER_TWITCH_ID: "1" });
  const dev = (p, body) => call(f, "/api/dev/" + p, "POST", body, undefined, { Authorization: "Bearer " + token });
  for (const [p, body] of [
    ["promote", {}],
    ["hotfix", { branch: "hotfix/a" }],
    ["rollback", { target: "production" }],
  ]) {
    const r = await dev(p, body);
    assert.deepEqual([r.status, r.body.reason], [403, "owner_session_required"], p);
  }
  assert.equal(calls.length, 0);
  assert.equal((await dev("deploy", { ref: "live-fix/a" })).status, 202);
  assert.equal((await dev("rollback", { target: "test" })).status, 202);
});

test("save creates the live-fix branch from main, then commits the file", async (t) => {
  const calls = stubFetch(t, [
    [
      ["GET", /\/git\/ref\/heads\/live-fix\/overlay$/],
      [404, { message: "Not Found" }],
    ],
    [
      ["GET", /\/git\/ref\/heads\/main$/],
      [200, { object: { sha: "b".repeat(40) } }],
    ],
    [
      ["POST", /\/git\/refs$/],
      [201, { ref: "refs/heads/live-fix/overlay" }],
    ],
    [
      ["PUT", /\/contents\/public\/overlay\.js$/],
      [200, { content: { sha: "c".repeat(40) }, commit: { sha: "d".repeat(40) } }],
    ],
  ]);
  const f = environment(GITHUB),
    owner = await cookieFor(f, true);
  const r = await call(
    f,
    "/api/dev/code/save",
    "POST",
    {
      path: "public/overlay.js",
      content: "héllo ✓\n",
      branch: "live-fix/overlay",
      sha: "a".repeat(40),
      message: "Fix overlay",
    },
    owner,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    ok: true,
    path: "public/overlay.js",
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
  assert.equal(put.branch, "live-fix/overlay");
  assert.equal(put.sha, "a".repeat(40));
  assert.equal(put.message, "Fix overlay");
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(put.content), (ch) => ch.charCodeAt(0))), "héllo ✓\n");
});

test("save conflict and GitHub failures map to clear errors without leaking the token", async (t) => {
  stubFetch(t, [
    [
      ["GET", /\/git\/ref\/heads\/live-fix\/a$/],
      [200, { object: { sha: "b".repeat(40) } }],
    ],
    [
      ["PUT", /\/contents\//],
      [409, { message: "README.md does not match" }],
    ],
  ]);
  const f = environment(GITHUB),
    owner = await cookieFor(f, true);
  const r = await call(
    f,
    "/api/dev/code/save",
    "POST",
    { path: "README.md", content: "x", branch: "live-fix/a" },
    owner,
  );
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, "github_error");
  assert.match(r.body.error, /conflict/i);
  assert.doesNotMatch(JSON.stringify(r.body), /test-only-gh-token/);
});

test("reading a file falls back to main when the branch does not exist and rejects binaries", async (t) => {
  const text = btoa("export const a = 1;\n").replace(/(.{8})/g, "$1\n");
  const calls = stubFetch(t, [
    [
      ["GET", /\/contents\/server\/game\.js\?ref=live-fix%2Fnew$/],
      [404, { message: "No commit found for the ref live-fix/new" }],
    ],
    [
      ["GET", /\/git\/ref\/heads\/live-fix\/new$/],
      [404, { message: "Not Found" }],
    ],
    [
      ["GET", /\/contents\/server\/game\.js\?ref=main$/],
      [200, { type: "file", encoding: "base64", size: 20, sha: "e".repeat(40), content: text }],
    ],
    [
      ["GET", /\/contents\/public\/assets\/player\.png\?ref=main$/],
      [200, { type: "file", encoding: "base64", size: 4, sha: "f".repeat(40), content: btoa("\x89PN\xff") }],
    ],
  ]);
  const f = environment(GITHUB),
    owner = await cookieFor(f, true);
  const r = await call(f, "/api/dev/code/file?path=server/game.js&branch=live-fix/new", "GET", undefined, owner);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    path: "server/game.js",
    ref: "main",
    sha: "e".repeat(40),
    size: 20,
    content: "export const a = 1;\n",
  });
  assert.equal(calls.length, 3);
  assert.equal(
    (await call(f, "/api/dev/code/file?path=public/assets/player.png", "GET", undefined, owner)).status,
    415,
  );
});

test("test deploy, promote, hotfix and rollback dispatch the deploy workflow with checked inputs", async (t) => {
  const calls = stubFetch(t, [
    [
      ["POST", /\/actions\/workflows\/deploy\.yml\/dispatches$/],
      [204, null],
    ],
    [
      ["GET", /\/pulls\/7$/],
      [
        200,
        {
          number: 7,
          state: "open",
          merged: false,
          base: { ref: "main" },
          head: { ref: "live-fix/overlay", sha: "1".repeat(40) },
        },
      ],
    ],
    [
      ["PUT", /\/pulls\/7\/merge$/],
      [200, { sha: "2".repeat(40), merged: true }],
    ],
    [
      ["GET", /\/pulls\/8$/],
      [
        200,
        {
          number: 8,
          state: "open",
          merged: false,
          base: { ref: "main" },
          head: { ref: "feature/x", sha: "1".repeat(40) },
        },
      ],
    ],
    [
      ["GET", /\/pulls\?state=open&head=Finesssee%3Ahotfix%2Fcrash$/],
      [200, []],
    ],
    [
      ["POST", /\/pulls$/],
      [201, { number: 9, html_url: "https://github.com/Finesssee/pixfray/pull/9" }],
    ],
  ]);
  const f = environment(GITHUB),
    owner = await cookieFor(f, true);
  const dispatches = () => calls.filter((c) => c.url.endsWith("/dispatches")).map((c) => c.body);

  const d = await call(f, "/api/dev/deploy", "POST", { ref: "live-fix/overlay" }, owner);
  assert.equal(d.status, 202);
  assert.match(d.body.requestId, /^r[0-9a-f]{10}$/);
  assert.deepEqual(dispatches()[0], {
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

  const p = await call(f, "/api/dev/promote", "POST", { number: 7, percentage: 25 }, owner);
  assert.equal(p.status, 202);
  assert.deepEqual(p.body.merged, { number: 7, sha: "2".repeat(40), alreadyMerged: false });
  assert.deepEqual(calls.find((c) => c.method === "PUT").body, { merge_method: "squash", sha: "1".repeat(40) });
  assert.equal(dispatches()[1].ref, "main");
  assert.equal(dispatches()[1].inputs.target, "production");
  assert.equal(dispatches()[1].inputs.sha, "2".repeat(40));
  assert.equal(dispatches()[1].inputs.percentage, "25");
  assert.equal((await call(f, "/api/dev/promote", "POST", { number: 8 }, owner)).status, 400);

  const h = await call(f, "/api/dev/hotfix", "POST", { branch: "hotfix/crash", reason: "overlay crash" }, owner);
  assert.equal(h.status, 202);
  assert.equal(h.body.pr.number, 9);
  assert.deepEqual(
    [dispatches()[2].ref, dispatches()[2].inputs.target, dispatches()[2].inputs.hotfix, dispatches()[2].inputs.reason],
    ["hotfix/crash", "production", "true", "overlay crash"],
  );

  const r = await call(
    f,
    "/api/dev/rollback",
    "POST",
    { target: "production", versionId: "0123abcd-0000-4000-8000-0123456789ab" },
    owner,
  );
  assert.equal(r.status, 202);
  assert.deepEqual(
    [
      dispatches()[3].ref,
      dispatches()[3].inputs.operation,
      dispatches()[3].inputs.target,
      dispatches()[3].inputs.version_id,
    ],
    ["main", "rollback", "production", "0123abcd-0000-4000-8000-0123456789ab"],
  );
  assert.equal(dispatches().length, 4);
});

test("runs and versions map the upstream responses", async (t) => {
  stubFetch(t, [
    [
      ["GET", /\/actions\/workflows\/deploy\.yml\/runs\?per_page=10$/],
      [
        200,
        {
          workflow_runs: [
            {
              id: 5,
              display_title: "deploy test live-fix/a r1",
              status: "completed",
              conclusion: "success",
              head_branch: "live-fix/a",
              head_sha: "a".repeat(40),
              created_at: "2026-10-01T00:00:00Z",
              html_url: "https://github.com/x",
            },
          ],
        },
      ],
    ],
    [
      ["GET", /\/workers\/scripts\/nesszerra-mini-chat(-test)?\/deployments$/],
      [
        200,
        {
          success: true,
          result: {
            deployments: [
              {
                id: "d1",
                created_on: "2026-10-01",
                source: "api",
                versions: [{ version_id: "v2", percentage: 100 }],
                annotations: { "workers/message": "promote #7" },
              },
            ],
          },
        },
      ],
    ],
    [
      ["GET", /\/workers\/scripts\/nesszerra-mini-chat(-test)?\/versions$/],
      [
        200,
        {
          success: true,
          result: {
            items: [
              {
                id: "v2",
                number: 2,
                metadata: { created_on: "2026-10-01" },
                annotations: { "workers/tag": "gh-aaaaaaa-1" },
              },
            ],
          },
        },
      ],
    ],
  ]);
  const f = environment({ ...GITHUB, CF_API_TOKEN: "test-only-cf", CF_ACCOUNT_ID: "a".repeat(32) }),
    owner = await cookieFor(f, true);
  const runs = await call(f, "/api/dev/runs", "GET", undefined, owner);
  assert.equal(runs.status, 200);
  assert.equal(runs.body[0].conclusion, "success");
  const v = await call(f, "/api/dev/versions", "GET", undefined, owner);
  assert.equal(v.status, 200);
  assert.equal(v.body.production.script, "nesszerra-mini-chat");
  assert.equal(v.body.test.script, "nesszerra-mini-chat-test");
  assert.deepEqual(v.body.production.deployments[0].versions, [{ versionId: "v2", percentage: 100 }]);
  assert.equal(v.body.production.versions[0].tag, "gh-aaaaaaa-1");
});

test("request usage sums every Worker on the account for the current UTC day", async (t) => {
  const calls = stubFetch(t, [
    [
      ["POST", /\/client\/v4\/graphql$/],
      [
        200,
        {
          data: {
            viewer: {
              accounts: [
                {
                  workersInvocationsAdaptive: [
                    {
                      sum: { requests: 1200, errors: 3, subrequests: 10 },
                      dimensions: { scriptName: "nesszerra-mini-chat" },
                    },
                    {
                      sum: { requests: 300, errors: 0, subrequests: 0 },
                      dimensions: { scriptName: "nesszerra-mini-chat-test" },
                    },
                    {
                      sum: { requests: 500, errors: 1, subrequests: 0 },
                      dimensions: { scriptName: "nesszerra-mini-chat" },
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    ],
  ]);
  const u = await usage(
    { CF_API_TOKEN: "test-only-cf", CF_ACCOUNT_ID: "a".repeat(32) },
    Date.parse("2026-10-01T15:30:00Z"),
  );
  assert.equal(u.requests, 2000);
  assert.equal(u.percent, 2);
  assert.equal(u.scripts["nesszerra-mini-chat"].requests, 1700);
  assert.equal(u.since, "2026-10-01T00:00:00.000Z");
  assert.equal(u.resetsAt, "2026-10-02T00:00:00.000Z");
  assert.equal(calls[0].body.variables.a, "a".repeat(32));
});

test("request usage reports an analytics error instead of throwing", async (t) => {
  stubFetch(t, [
    [
      ["POST", /graphql/],
      [200, { errors: [{ message: "no access" }], data: null }],
    ],
  ]);
  const u = await usage({ CF_API_TOKEN: "x", CF_ACCOUNT_ID: "a".repeat(32) });
  assert.equal(u.configured, true);
  assert.ok(u.error);
  assert.equal(u.requests, undefined);
});

test("an upstream network failure returns 503 and is logged, never thrown", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const f = environment(GITHUB),
    owner = await cookieFor(f, true),
    pending = [];
  const r = await worker.fetch(req("/api/dev/runs", "GET", undefined, owner), f.env, {
    waitUntil: (p) => pending.push(p),
  });
  assert.equal(r.status, 503);
  await Promise.all(pending);
  const logs = await call(f, "/api/dev/logs", "GET", undefined, owner);
  assert.equal(logs.body[0].message, "network down");
  assert.equal(logs.body[0].context.path, "/api/dev/runs");
});
