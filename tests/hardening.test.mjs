// Free-plan hardening: StreamElements floods stop in the Worker, owner access survives record expiry, and a lapsed
// moderator token is reported as modsLapsed. In-memory AuthStore stub that also keeps each entry's expiry.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker from "../server/worker.js";
import { ChannelRoom } from "../server/channel.js";
import { digest, seal, unseal, isOwner, access } from "../server/auth.js";
import { forgetRefused, seKeyHash, WRONG_KEY_TEXT, LOST_TEXT, OFF_TEXT, SE_KEY } from "../server/streamelements.js";
import { forgetChannel } from "../server/channels.js";

const ORIGIN = "https://chat.miolaf.xyz",
  DAY = 86400000,
  KEY = "ab".repeat(24),
  OTHER = "cd".repeat(24);
const INTERNAL = "test-only-internal-key";

function environment({ rooms } = {}) {
  const entries = new Map(),
    expires = new Map(),
    fetched = [];
  const env = {
    AUTH_SECRET: "test-only-auth-key",
    INTERNAL_SECRET: INTERNAL,
    TWITCH_CLIENT_ID: "test-app",
    TWITCH_CLIENT_SECRET: "test-secret",
    PUBLIC_ORIGIN: ORIGIN,
    AUTH: {
      idFromName: (x) => x,
      get: () => ({
        async fetch(url, options) {
          const u = new URL(url),
            key = u.searchParams.get("key"),
            method = options.method;
          if (u.pathname === "/consume") {
            const value = entries.get(key) ?? null;
            entries.delete(key);
            return Response.json(value);
          }
          if (method === "GET") return Response.json(entries.get(key) ?? null);
          if (method === "DELETE") {
            entries.delete(key);
            expires.delete(key);
            return Response.json({ ok: true });
          }
          const body = JSON.parse(options.body);
          entries.set(key, body.value);
          expires.set(key, body.expires);
          return Response.json({ ok: true });
        },
      }),
    },
    ROOMS: {
      idFromName: (x) => x,
      get: (channel) => ({
        async fetch(url, options = {}) {
          const path = new URL(url).pathname;
          fetched.push({ channel, path, body: options.body ? JSON.parse(options.body) : undefined });
          if (rooms) return rooms(channel).fetch(url, options);
          if (path === "/admin") return Response.json({ revision: 1, history: [] });
          return Response.json({ reply: "room answered" });
        },
      }),
    },
    ASSETS: { fetch: async () => Response.json([]) },
  };
  return { env, entries, expires, fetched };
}
const seReq = (path, init) => new Request(ORIGIN + path, init);
const se = (f, path, init) => worker.fetch(seReq(path, init), f.env);
const text = async (r) => [r.status, await r.text()];
test.beforeEach(() => {
  forgetRefused();
  forgetChannel();
});

// ---------- StreamElements: bad requests never reach a room ----------
test("SE key shape matches how the room generates keys (24 random bytes as hex)", () => {
  assert.ok(SE_KEY.test(KEY));
  for (const bad of ["key", "k1", "AB".repeat(24), "ab".repeat(23), "ab".repeat(25), "zz".repeat(24)])
    assert.equal(SE_KEY.test(bad), false, bad);
});

test("SE: malformed key, unknown action, unknown or paused channel and wrong method are answered without a room call", async () => {
  const f = environment();
  f.entries.set("channel:oldone", { id: "5", login: "oldone", enabledAt: 1, pausedAt: 2 });
  assert.deepEqual(await text(await se(f, "/api/se/nesszerra/help")), [
    200,
    "PixFray: missing key. Copy the commands again from the admin page.",
  ]);
  assert.deepEqual(await text(await se(f, "/api/se/nesszerra/help?k=" + "x".repeat(129))), [
    200,
    "PixFray: missing key. Copy the commands again from the admin page.",
  ]);
  for (const k of ["key", "AB".repeat(24), "ab".repeat(23), "ab".repeat(32)])
    assert.deepEqual(await text(await se(f, "/api/se/nesszerra/help?k=" + k)), [200, WRONG_KEY_TEXT], k);
  assert.deepEqual(await text(await se(f, "/api/se/nesszerra/attack?k=" + KEY)), [200, LOST_TEXT]);
  assert.deepEqual(await text(await se(f, "/api/se/nesszerra/" + "a".repeat(20) + "?k=" + KEY)), [
    404,
    "Unknown command",
  ]);
  assert.deepEqual(await text(await se(f, "/api/se/Not-A-Channel/help?k=" + KEY)), [404, "Unknown command"]);
  assert.deepEqual(await text(await se(f, "/api/se/nobodyhere/help?k=" + KEY)), [
    404,
    "PixFray is not enabled for this channel",
  ]);
  assert.deepEqual(await text(await se(f, "/api/se/oldone/help?k=" + KEY)), [200, OFF_TEXT]);
  assert.deepEqual(await text(await se(f, "/api/se/nesszerra/help?k=" + KEY, { method: "POST" })), [405, "Use GET"]);
  assert.equal(f.fetched.length, 0, "no ChannelRoom request for any of them");
});

test("SE: malformed keys and bad actions do not even read AuthStore for an unknown channel", async () => {
  const f = environment();
  let reads = 0;
  const stub = f.env.AUTH.get;
  f.env.AUTH.get = () => ({
    fetch: (u, o) => {
      reads++;
      return stub().fetch(u, o);
    },
  });
  await se(f, "/api/se/randomname/help?k=short");
  await se(f, "/api/se/randomname/nope?k=" + KEY);
  assert.equal(reads, 0);
  assert.equal(f.fetched.length, 0);
});

test("SE: a valid key still reaches the room unchanged, with the same reply", async () => {
  const f = environment();
  const r = await se(f, "/api/se/nesszerra/challenge?k=" + KEY + "&id=7&u=Bob&d=Bob&t=%40alice&m=m1");
  assert.deepEqual(await text(r), [200, "room answered"]);
  assert.equal(f.fetched.length, 1);
  assert.deepEqual([f.fetched[0].channel, f.fetched[0].path], ["nesszerra", "/se"]);
  assert.deepEqual(
    [f.fetched[0].body.key, f.fetched[0].body.action, f.fetched[0].body.username, f.fetched[0].body.target],
    [KEY, "challenge", "bob", "alice"],
  );
});

test("SE: once the room has sent its key hash, random keys are refused in the Worker; a rotated key gets through within 10 s", async (t) => {
  let now = Date.parse("2026-10-03T10:00:00Z");
  t.mock.method(Date, "now", () => now);
  const f = environment();
  let current = KEY;
  f.env.ROOMS.get = (channel) => ({
    async fetch(url, options = {}) {
      f.fetched.push({ channel, path: new URL(url).pathname });
      const ok = JSON.parse(options.body).key === current;
      return Response.json(
        { reply: ok ? "ok" : WRONG_KEY_TEXT },
        { status: ok ? 200 : 403, headers: { "X-Se-Key": await seKeyHash(current) } },
      );
    },
  });
  const call = (key) => se(f, "/api/se/nesszerra/help?k=" + key).then(text);
  assert.deepEqual(await call(KEY), [200, "ok"]);
  assert.equal(f.fetched.length, 1);
  for (let i = 0; i < 20; i++)
    assert.deepEqual(await call((10 + i).toString(16).repeat(24).slice(0, 48)), [200, WRONG_KEY_TEXT]);
  assert.equal(f.fetched.length, 2, "one mismatch per 10 s reaches the room; the other random keys stop in the Worker");
  // the streamer rotates the key: the new one works as soon as the 10 s window passes, and is remembered
  current = OTHER;
  now += 10001;
  assert.deepEqual(await call(OTHER), [200, "ok"]);
  assert.deepEqual(await call(OTHER), [200, "ok"]);
  assert.equal(f.fetched.length, 4);
  assert.deepEqual(await call(KEY), [200, WRONG_KEY_TEXT], "the old key is refused");
});

test("SE: a refused (channel, key) pair is answered locally for 60 s, then asked again", async (t) => {
  let now = Date.parse("2026-10-03T10:00:00Z");
  t.mock.method(Date, "now", () => now);
  const f = environment();
  f.env.ROOMS.get = (channel) => ({
    async fetch(url, options = {}) {
      f.fetched.push({ channel, path: new URL(url).pathname, body: JSON.parse(options.body) });
      return options.body.includes(KEY)
        ? Response.json({ reply: "ok" })
        : Response.json({ reply: WRONG_KEY_TEXT }, { status: 403 });
    },
  });
  const call = (key = OTHER, channel = "nesszerra") => se(f, `/api/se/${channel}/help?k=${key}`).then(text);
  assert.deepEqual(await call(), [200, WRONG_KEY_TEXT], "HTTP 200 so the bot shows the text");
  assert.equal(f.fetched.length, 1, "the first refusal reaches the room (it records rejected_at)");
  for (let i = 0; i < 5; i++) assert.deepEqual(await call(), [200, WRONG_KEY_TEXT]);
  assert.equal(f.fetched.length, 1, "repeats make no room request");
  await call("ef".repeat(24));
  assert.equal(f.fetched.length, 2, "a different key is its own pair");
  await call(OTHER, "miolafff");
  assert.equal(f.fetched.length, 3, "so is the same key on another channel");
  assert.deepEqual(await call(KEY), [200, "ok"]);
  assert.equal(f.fetched.length, 4, "the valid key is never cached as refused");
  assert.deepEqual(await call(KEY), [200, "ok"]);
  assert.equal(f.fetched.length, 5);
  now += 59_000;
  await call();
  assert.equal(f.fetched.length, 5, "still remembered after 59 s");
  now += 2_000;
  await call();
  assert.equal(f.fetched.length, 6, "asked again after 60 s");
});

// A real ChannelRoom on SQLite behind the Worker: the first refusal is recorded for the admin page.
function realRooms() {
  const rooms = new Map();
  return (channel) => {
    if (!rooms.has(channel)) {
      const db = new DatabaseSync(":memory:");
      const storage = {
        sql: {
          exec(q, ...p) {
            const rows = db
              .prepare(q)
              .all(...p)
              .map((r) => ({ ...r }));
            return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
          },
        },
        transactionSync(fn) {
          db.exec("BEGIN");
          try {
            const v = fn();
            db.exec("COMMIT");
            return v;
          } catch (e) {
            db.exec("ROLLBACK");
            throw e;
          }
        },
        async setAlarm() {},
        async deleteAlarm() {},
      };
      rooms.set(
        channel,
        new ChannelRoom({ storage, acceptWebSocket() {}, getWebSockets: () => [] }, { INTERNAL_SECRET: INTERNAL }),
      );
    }
    return { fetch: (url, init) => rooms.get(channel).fetch(new Request(url, init)) };
  };
}
const roomCall = (f, path) =>
  f.env.ROOMS.get("nesszerra")
    .fetch("https://room" + path, { headers: { "X-Mini-Internal": INTERNAL, "X-Mini-Channel": "nesszerra" } })
    .then((r) => r.json());

test("SE with a real room: the first refusal records rejected_at, repeats are served from the cache, the right key works", async () => {
  const f = environment({ rooms: realRooms() });
  const admin = () => roomCall(f, "/admin").then((a) => a.streamelements);
  const secret = (await admin()).secret;
  assert.match(secret, SE_KEY);
  assert.equal((await admin()).rejectedAt, 0);
  const wrong = secret === KEY ? OTHER : KEY;
  const seCalls = () => f.fetched.filter((x) => x.path === "/se").length,
    before = seCalls();
  assert.deepEqual(await text(await se(f, "/api/se/nesszerra/help?k=" + wrong)), [200, WRONG_KEY_TEXT]);
  assert.ok((await admin()).rejectedAt > 0, 'the admin page can show "old key"');
  const asked = seCalls();
  for (let i = 0; i < 4; i++)
    assert.deepEqual(await text(await se(f, "/api/se/nesszerra/help?k=" + wrong)), [200, WRONG_KEY_TEXT]);
  assert.equal(seCalls(), asked, "repeats never reach the room");
  assert.equal(asked - before, 1);
  const ok = await text(await se(f, "/api/se/nesszerra/help?k=" + secret + "&id=7&u=bob&d=Bob&t=-&m=m1"));
  assert.equal(ok[0], 200);
  assert.match(ok[1], /PixFray duels/);
  assert.ok((await admin()).lastCommandAt > 0);
});

// ---------- owner access ----------
test("OWNER_TWITCH_ID decides ownership with or without the owner record", async () => {
  const f = environment(),
    me = { id: "445610108", login: "nesszerra" },
    other = { id: "9", login: "viewer" };
  f.env.OWNER_TWITCH_ID = "445610108";
  assert.equal(f.entries.has("owner:nesszerra"), false);
  assert.equal(await isOwner(f.env, me), true, "no record needed");
  assert.equal(await isOwner(f.env, other), false);
  assert.equal(await isOwner(f.env, null), false);
  f.entries.set("owner:nesszerra", { id: "445610108" });
  assert.equal(await isOwner(f.env, me), true, "record and env agree");
  f.entries.set("owner:nesszerra", { id: "9" });
  assert.equal(
    await isOwner(f.env, other),
    false,
    "a stale or wrong record cannot grant ownership while the env is set",
  );
  assert.deepEqual(await access(f.env, me, "nesszerra"), { owner: true, moderator: false, canManage: true });
  // without the env the record decides (local test server)
  delete f.env.OWNER_TWITCH_ID;
  assert.equal(await isOwner(f.env, other), true);
  f.entries.delete("owner:nesszerra");
  assert.equal(await isOwner(f.env, me), false, "the lapse this env value prevents");
});

test("an owner session keeps working after the owner record has expired", async () => {
  const f = environment(),
    cookie = "e".repeat(64);
  f.env.OWNER_TWITCH_ID = "445610108";
  f.entries.set("session:" + (await digest(cookie)), {
    user: { id: "445610108", login: "nesszerra", displayName: "nesszerra" },
  });
  const r = await worker.fetch(
    new Request(ORIGIN + "/api/admin/nesszerra", { headers: { Cookie: "mini_session=" + cookie } }),
    f.env,
  );
  assert.equal(r.status, 200);
  assert.equal((await r.json()).access.owner, true);
});

function twitch(t, { as, scopes = [], ownerId = "445610108" }) {
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = String(url);
    if (u.endsWith("/oauth2/token")) return Response.json({ access_token: "user-token", refresh_token: "refresh-1" });
    if (u.endsWith("/oauth2/validate")) return Response.json({ client_id: "test-app", user_id: as.id, scopes });
    if (u.includes("users?login=nesszerra"))
      return Response.json({ data: [{ id: ownerId, login: "nesszerra", display_name: "nesszerra" }] });
    return Response.json({ data: [{ id: as.id, login: as.login, display_name: as.login }] });
  });
}
async function signIn(f, query) {
  const login = await worker.fetch(new Request(ORIGIN + "/auth/login?" + query), f.env);
  const state = new URL(login.headers.get("Location")).searchParams.get("state");
  return worker.fetch(
    new Request(ORIGIN + "/auth/callback?code=c&state=" + state, { headers: { Cookie: "mini_oauth=" + state } }),
    f.env,
  );
}

test("sign-in refreshes the owner record for 90 days when it agrees with OWNER_TWITCH_ID, and refuses a mismatch", async (t) => {
  const f = environment();
  f.env.OWNER_TWITCH_ID = "445610108";
  twitch(t, { as: { id: "9", login: "viewer" } });
  const before = Date.now();
  assert.equal((await signIn(f, "channel=nesszerra")).status, 303);
  assert.deepEqual(f.entries.get("owner:nesszerra"), { id: "445610108" });
  const left = f.expires.get("owner:nesszerra") - before;
  assert.ok(left > 89 * DAY && left <= 90 * DAY + 5000, "expires in about 90 days: " + left);
  // Twitch reports a different owner id than the configured one: refuse and keep the record as it was
  f.entries.delete("owner:nesszerra");
  t.mock.restoreAll();
  twitch(t, { as: { id: "9", login: "viewer" }, ownerId: "777" });
  assert.equal((await signIn(f, "channel=nesszerra")).status, 403);
  assert.equal(f.entries.has("owner:nesszerra"), false);
});

// ---------- moderator token ----------
const broadcasterToken = (f, extra = {}) =>
  seal(f.env, { access_token: "a1", refresh_token: "r1", userId: "445610108", validatedAt: Date.now(), ...extra });
const MOD = { id: "2", login: "viewer", displayName: "V" };

test("connecting mod access writes the non-expiring modsconnected marker next to the 90-day token", async (t) => {
  const f = environment();
  twitch(t, { as: { id: "123", login: "miolafff" }, scopes: ["moderation:read"] });
  const before = Date.now();
  const r = await signIn(f, "channel=miolafff&connect=mods");
  assert.equal(r.status, 303);
  assert.match(r.headers.get("Location"), /mods=connected/);
  assert.ok(f.entries.has("broadcaster:miolafff"));
  const left = f.expires.get("broadcaster:miolafff") - before;
  assert.ok(left > 89 * DAY && left <= 90 * DAY + 5000);
  assert.ok(f.entries.get("broadcaster:miolafff").touched >= before, "touched sits beside the sealed fields");
  const marker = f.entries.get("modsconnected:miolafff");
  assert.ok(marker.at >= before);
  assert.ok(f.expires.get("modsconnected:miolafff") - before > 19 * 365 * DAY, "about 20 years");
});

test("the AuthStore accepts ~20-year expiry for modsconnected markers but caps other keys at 100 days", async () => {
  const { AuthStore } = await import("../server/auth.js");
  const db = new DatabaseSync(":memory:");
  const ctx = {
    storage: {
      sql: {
        exec(q, ...p) {
          const rows = db
            .prepare(q)
            .all(...p)
            .map((r) => ({ ...r }));
          return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
        },
      },
      alarm: null,
      async getAlarm() {
        return this.alarm;
      },
      async setAlarm(t) {
        this.alarm = t;
      },
    },
  };
  const store = new AuthStore(ctx, { INTERNAL_SECRET: INTERNAL });
  const put = (key, days) =>
    store
      .fetch(
        new Request("https://auth/entry?key=" + key, {
          method: "POST",
          headers: { "X-Mini-Internal": INTERNAL, "Content-Type": "application/json" },
          body: JSON.stringify({ value: { at: 1 }, expires: Date.now() + days * DAY }),
        }),
      )
      .then((r) => r.status);
  assert.equal(await put("modsconnected:miolafff", 20 * 365), 200);
  assert.equal(await put("channel:miolafff", 20 * 365), 200);
  assert.equal(await put("broadcaster:miolafff", 90), 200);
  assert.equal(await put("broadcaster:miolafff", 120), 400);
  assert.equal(await put("session:x", 20 * 365), 400);
});

test("a successful moderator check pushes the token expiry out 90 days", async (t) => {
  const f = environment();
  f.entries.set("broadcaster:nesszerra", await broadcasterToken(f, { validatedAt: Date.now() - 2 * 3600000 }));
  f.expires.set("broadcaster:nesszerra", Date.now() + 3 * DAY); // nearly lapsed
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = String(url);
    if (u.includes("/oauth2/validate"))
      return Response.json({ client_id: "test-app", user_id: "445610108", scopes: ["moderation:read"] });
    if (u.includes("/helix/moderation/moderators")) return Response.json({ data: [{ user_id: "2" }] });
    throw new Error("unexpected fetch " + u);
  });
  const before = Date.now();
  assert.equal((await access(f.env, MOD, "nesszerra")).moderator, true);
  const left = f.expires.get("broadcaster:nesszerra") - before;
  assert.ok(left > 89 * DAY && left <= 90 * DAY + 5000, "expiry refreshed: " + left);
  assert.ok(f.entries.get("broadcaster:nesszerra").touched >= before);
});

test("an expired Twitch access token is renewed with the stored refresh token, and the new token is stored for 90 days", async (t) => {
  const f = environment(),
    calls = [];
  f.entries.set("broadcaster:nesszerra", await broadcasterToken(f));
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const u = String(url),
      auth = init.headers?.Authorization;
    calls.push(u.split("?")[0].replace("https://", "") + " " + (auth || ""));
    if (u.endsWith("/oauth2/token")) {
      assert.equal(new URLSearchParams(init.body).get("refresh_token"), "r1");
      return Response.json({ access_token: "a2", refresh_token: "r2" });
    }
    if (u.includes("/oauth2/validate"))
      return Response.json({ client_id: "test-app", user_id: "445610108", scopes: ["moderation:read"] });
    if (u.includes("/helix/moderation/moderators"))
      return auth === "Bearer a1"
        ? new Response("expired", { status: 401 })
        : Response.json({ data: [{ user_id: "2" }] });
    throw new Error("unexpected fetch " + u);
  });
  const before = Date.now();
  assert.equal((await access(f.env, MOD, "nesszerra")).moderator, true);
  assert.ok(
    calls.some((c) => c === "id.twitch.tv/oauth2/token "),
    "refresh token used",
  );
  const stored = await unseal(f.env, f.entries.get("broadcaster:nesszerra"));
  assert.deepEqual([stored.access_token, stored.refresh_token, stored.userId], ["a2", "r2", "445610108"]);
  assert.ok(f.expires.get("broadcaster:nesszerra") - before > 89 * DAY);
});

test("a refresh that Twitch refuses surfaces as a reconnect error and keeps the old record", async (t) => {
  const f = environment();
  f.entries.set("broadcaster:nesszerra", await broadcasterToken(f, { validatedAt: 0 }));
  t.mock.method(globalThis, "fetch", async (url) =>
    String(url).includes("/oauth2/validate")
      ? new Response("no", { status: 401 })
      : new Response("no", { status: 400 }),
  );
  await assert.rejects(access(f.env, MOD, "nesszerra"), /reconnect Twitch/);
  assert.ok(f.entries.has("broadcaster:nesszerra"));
});

// ---------- modsLapsed in the admin snapshot ----------
const ownerCookie = async (f) => {
  const c = "f".repeat(64);
  f.env.OWNER_TWITCH_ID = "445610108";
  f.entries.set("session:" + (await digest(c)), {
    user: { id: "445610108", login: "nesszerra", displayName: "nesszerra" },
  });
  return "mini_session=" + c;
};
const snapshot = async (f, cookie, channel = "nesszerra") =>
  (await worker.fetch(new Request(ORIGIN + "/api/admin/" + channel, { headers: { Cookie: cookie } }), f.env)).json();

test("admin snapshot: modsLapsed is true only when mod access was connected and the token is gone", async () => {
  const f = environment(),
    cookie = await ownerCookie(f);
  let s = await snapshot(f, cookie);
  assert.deepEqual([s.modsReady, s.modsLapsed], [false, false], "never connected");
  f.entries.set("modsconnected:nesszerra", { at: 1 });
  s = await snapshot(f, cookie);
  assert.deepEqual([s.modsReady, s.modsLapsed], [false, true], "connected once, token expired");
  f.entries.set("broadcaster:nesszerra", await broadcasterToken(f));
  s = await snapshot(f, cookie);
  assert.deepEqual([s.modsReady, s.modsLapsed], [true, false], "token present");
  f.entries.delete("broadcaster:nesszerra");
  s = await snapshot(f, cookie);
  assert.deepEqual([s.modsReady, s.modsLapsed], [false, true], "and lapsed again once it expires");
});

test("admin snapshot: a token seen without a marker gets one, and viewing keeps a stale token alive", async () => {
  const f = environment(),
    cookie = await ownerCookie(f);
  f.entries.set("broadcaster:nesszerra", await broadcasterToken(f)); // connected before markers existed: no `touched`
  assert.equal(f.entries.has("modsconnected:nesszerra"), false);
  const before = Date.now();
  const s = await snapshot(f, cookie);
  assert.deepEqual([s.modsReady, s.modsLapsed], [true, false]);
  assert.ok(f.entries.get("modsconnected:nesszerra").at >= before);
  assert.ok(f.entries.get("broadcaster:nesszerra").touched >= before);
  assert.ok(f.expires.get("broadcaster:nesszerra") - before > 89 * DAY);
  // a second view within a week writes nothing more
  const stamp = f.entries.get("broadcaster:nesszerra").touched,
    writes = f.expires.get("broadcaster:nesszerra");
  await new Promise((r) => setTimeout(r, 5));
  await snapshot(f, cookie);
  assert.equal(f.entries.get("broadcaster:nesszerra").touched, stamp);
  assert.equal(f.expires.get("broadcaster:nesszerra"), writes);
  // and the token can still be opened after the extra field was added
  assert.equal((await unseal(f.env, f.entries.get("broadcaster:nesszerra"))).access_token, "a1");
});

test("robots.txt and sitemap.xml follow the host: production lists its pages, the test site stays out of search", async () => {
  const site = (await import("../site.config.js")).default,
    { env } = environment();
  const get = async (origin, path) => {
    const r = await worker.fetch(new Request(origin + path), env);
    return { status: r.status, body: await r.text() };
  };
  const robots = await get(site.origins.production, "/robots.txt");
  assert.match(robots.body, /Disallow: \/api\//);
  assert.match(robots.body, new RegExp("Sitemap: " + site.origins.production + "/sitemap.xml"));
  const map = await get(site.origins.production, "/sitemap.xml");
  for (const p of ["/", "/play/", "/start/"])
    assert.match(map.body, new RegExp("<loc>" + site.origins.production + p + "</loc>"));
  assert.equal((await get(site.origins.test, "/robots.txt")).body, "User-agent: *\nDisallow: /\n");
  assert.equal((await get(site.origins.test, "/sitemap.xml")).status, 404);
});
