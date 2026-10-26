// Free-plan hardening: StreamElements floods stop in the Worker, owner access survives record expiry, and a lapsed
// moderator token is reported as modsLapsed. In-memory AuthStore that also keeps each entry's expiry.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../server/worker.ts";
import { ChannelRoom } from "../server/channel.ts";
import { seal, unseal, isOwner, access } from "../server/auth.ts";
import { forgetRefused, seKeyHash, WRONG_KEY_TEXT, LOST_TEXT, OFF_TEXT, SE_KEY } from "../server/streamelements.ts";
import { forgetChannel } from "../server/channels.ts";
import { asEnv, fakeCtx, must, type Loose } from "./fakes.ts";
import { INTERNAL, ORIGIN, SECRETS, memoryAuth, namespace, signIn, sqliteAuth, twitchSignIn } from "./worker-fakes.ts";
import type { StubInit } from "./worker-fakes.ts";

const DAY = 86400000,
  KEY = "ab".repeat(24),
  OTHER = "cd".repeat(24);
const ME = { id: "445610108", login: "nesszerra", displayName: "nesszerra" },
  MOD = { id: "2", login: "viewer", displayName: "V" };

type RoomFetch = (channel: string, url: string, init: StubInit) => Promise<Response>;
const answered: RoomFetch = async (_, url) =>
  new URL(url).pathname === "/admin"
    ? Response.json({ revision: 1, history: [] })
    : Response.json({ reply: "room answered" });
// The Worker over an in-memory AuthStore; `room` answers the room calls, which `fetched` lists with their bodies.
function environment(room = answered) {
  // entries hold whatever JSON the Worker stored; tests read them by property
  const entries = new Map<string, Loose>(),
    expires = new Map<string, number>(),
    // Loose: the parsed request body, read by field
    fetched: { channel: string; path: string; body?: Loose }[] = [];
  const env = asEnv({
    ...SECRETS,
    PUBLIC_ORIGIN: ORIGIN,
    AUTH: memoryAuth(entries, expires),
    ROOMS: namespace(async (channel, url, init) => {
      fetched.push({ channel, path: new URL(url).pathname, body: init.body ? JSON.parse(init.body) : undefined });
      return room(channel, url, init);
    }),
    ASSETS: { fetch: async () => Response.json([]) },
  });
  return { env, entries, expires, fetched };
}
type Fixture = ReturnType<typeof environment>;
const se = (f: Fixture, path: string, init?: RequestInit) => worker.fetch(new Request(ORIGIN + path, init), f.env);
const text = async (r: Response): Promise<[number, string]> => [r.status, await r.text()];
/** Asserts that `key` expires about `days` days after `before`. */
function expiresIn(f: Fixture, key: string, before: number, days = 90) {
  const left = must(f.expires.get(key)) - before;
  assert.ok(left > (days - 1) * DAY && left <= days * DAY + 5000, key + " expires in " + left);
}
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
  const f = environment(),
    missing = "PixFray: missing key. Copy the commands again from the admin page.";
  f.entries.set("channel:oldone", { id: "5", login: "oldone", enabledAt: 1, pausedAt: 2 });
  const cases: [path: string, answer: [number, string]][] = [
    ["nesszerra/help", [200, missing]],
    ["nesszerra/help?k=" + "x".repeat(129), [200, missing]],
    ...["key", "AB".repeat(24), "ab".repeat(23), "ab".repeat(32)].map((k): [string, [number, string]] => [
      "nesszerra/help?k=" + k,
      [200, WRONG_KEY_TEXT],
    ]),
    ["nesszerra/attack?k=" + KEY, [200, LOST_TEXT]],
    ["nesszerra/" + "a".repeat(20) + "?k=" + KEY, [404, "Unknown command"]],
    ["Not-A-Channel/help?k=" + KEY, [404, "Unknown command"]],
    ["nobodyhere/help?k=" + KEY, [404, "PixFray is not enabled for this channel"]],
    ["oldone/help?k=" + KEY, [200, OFF_TEXT]],
  ];
  for (const [path, answer] of cases) assert.deepEqual(await text(await se(f, "/api/se/" + path)), answer, path);
  assert.deepEqual(await text(await se(f, "/api/se/nesszerra/help?k=" + KEY, { method: "POST" })), [405, "Use GET"]);
  assert.equal(f.fetched.length, 0, "no ChannelRoom request for any of them");
});

test("SE: malformed keys and bad actions do not even read AuthStore for an unknown channel", async () => {
  const f = environment();
  let reads = 0;
  f.env.AUTH = namespace(async () => (reads++, Response.json(null)));
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
  const { channel, path, body } = must(f.fetched[0]);
  assert.deepEqual([channel, path], ["nesszerra", "/se"]);
  assert.deepEqual([body.key, body.action, body.username, body.target], [KEY, "challenge", "bob", "alice"]);
});

test("SE: once the room has sent its key hash, random keys are refused in the Worker; a rotated key gets through within 10 s", async (t) => {
  let now = Date.parse("2026-10-03T10:00:00Z"),
    current = KEY;
  t.mock.method(Date, "now", () => now);
  const f = environment(async (_, __, init) => {
    // the Worker's /se call always sends a JSON body
    const ok = JSON.parse(String(init.body)).key === current;
    return Response.json(
      { reply: ok ? "ok" : WRONG_KEY_TEXT },
      { status: ok ? 200 : 403, headers: { "X-Se-Key": await seKeyHash(current) } },
    );
  });
  const call = (key: string) => se(f, "/api/se/nesszerra/help?k=" + key).then(text);
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
  const f = environment(async (_, __, init) =>
    String(init.body).includes(KEY)
      ? Response.json({ reply: "ok" })
      : Response.json({ reply: WRONG_KEY_TEXT }, { status: 403 }),
  );
  const call = (key = OTHER, channel = "nesszerra") => se(f, `/api/se/${channel}/help?k=${key}`).then(text);
  // [the key, the channel, then how many room calls there have been, and why]
  const steps: [key: string, channel: string, calls: number, why: string][] = [
    [OTHER, "nesszerra", 1, "the first refusal reaches the room (it records rejected_at)"],
    ...Array.from({ length: 5 }, (): [string, string, number, string] => [
      OTHER,
      "nesszerra",
      1,
      "repeats make no room request",
    ]),
    ["ef".repeat(24), "nesszerra", 2, "a different key is its own pair"],
    [OTHER, "miolafff", 3, "so is the same key on another channel"],
    [KEY, "nesszerra", 4, "the valid key is never cached as refused"],
    [KEY, "nesszerra", 5, "and asked each time"],
  ];
  for (const [key, channel, calls, why] of steps) {
    assert.deepEqual(
      await call(key, channel),
      [200, key === KEY ? "ok" : WRONG_KEY_TEXT],
      "HTTP 200 so the bot shows it",
    );
    assert.equal(f.fetched.length, calls, why);
  }
  now += 59_000;
  await call();
  assert.equal(f.fetched.length, 5, "still remembered after 59 s");
  now += 2_000;
  await call();
  assert.equal(f.fetched.length, 6, "asked again after 60 s");
});

// Real ChannelRooms on SQLite behind the Worker: the first refusal is recorded for the admin page.
function realRooms(): RoomFetch {
  const rooms = new Map<string, ChannelRoom>();
  return async (channel, url, init) => {
    if (!rooms.has(channel)) rooms.set(channel, new ChannelRoom(fakeCtx(), asEnv({ INTERNAL_SECRET: INTERNAL })));
    return must(rooms.get(channel)).fetch(new Request(url, init));
  };
}

test("SE with a real room: the first refusal records rejected_at, repeats are served from the cache, the right key works", async () => {
  const f = environment(realRooms()),
    room = f.env.ROOMS.get(f.env.ROOMS.idFromName("nesszerra"));
  const admin = async () =>
    (
      await room
        .fetch("https://room/admin", { headers: { "X-Mini-Internal": INTERNAL, "X-Mini-Channel": "nesszerra" } })
        .then((r) => r.json<Loose>())
    ).streamelements; // Loose: the room's admin snapshot, read by field
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
    other = { id: "9", login: "viewer", displayName: "viewer" };
  f.env.OWNER_TWITCH_ID = ME.id;
  assert.equal(f.entries.has("owner:nesszerra"), false);
  assert.equal(await isOwner(f.env, ME), true, "no record needed");
  assert.equal(await isOwner(f.env, other), false);
  assert.equal(await isOwner(f.env, null), false);
  f.entries.set("owner:nesszerra", { id: ME.id });
  assert.equal(await isOwner(f.env, ME), true, "record and env agree");
  f.entries.set("owner:nesszerra", { id: "9" });
  assert.equal(
    await isOwner(f.env, other),
    false,
    "a stale or wrong record cannot grant ownership while the env is set",
  );
  assert.deepEqual(await access(f.env, ME, "nesszerra"), { owner: true, moderator: false, canManage: true });
  // without the env the record decides (local test server)
  delete f.env.OWNER_TWITCH_ID;
  assert.equal(await isOwner(f.env, other), true);
  f.entries.delete("owner:nesszerra");
  assert.equal(await isOwner(f.env, ME), false, "the lapse this env value prevents");
});

// The owner's admin snapshot, signed in with OWNER_TWITCH_ID set and no owner record.
async function snapshotter(f: Fixture) {
  f.env.OWNER_TWITCH_ID = ME.id;
  const cookie = await signIn(f.env, ME);
  return async () => {
    const r = await worker.fetch(new Request(ORIGIN + "/api/admin/nesszerra", { headers: { Cookie: cookie } }), f.env);
    assert.equal(r.status, 200);
    return r.json<Loose>(); // Loose: the admin snapshot, read by field
  };
}

test("an owner session keeps working after the owner record has expired", async () => {
  const f = environment(),
    snapshot = await snapshotter(f);
  assert.equal(f.entries.has("owner:nesszerra"), false);
  assert.equal((await snapshot()).access.owner, true);
});

test("sign-in refreshes the owner record for 90 days when it agrees with OWNER_TWITCH_ID, and refuses a mismatch", async (t) => {
  const f = environment(),
    viewer = { id: "9", login: "viewer", displayName: "viewer" };
  f.env.OWNER_TWITCH_ID = ME.id;
  const before = Date.now();
  assert.equal((await twitchSignIn(t, f.env, "channel=nesszerra", { as: viewer, owner: ME })).status, 303);
  assert.deepEqual(f.entries.get("owner:nesszerra"), { id: ME.id });
  expiresIn(f, "owner:nesszerra", before);
  // Twitch reports a different owner id than the configured one: refuse and keep the record as it was
  f.entries.delete("owner:nesszerra");
  const wrong = { ...ME, id: "777" };
  assert.equal((await twitchSignIn(t, f.env, "channel=nesszerra", { as: viewer, owner: wrong })).status, 403);
  assert.equal(f.entries.has("owner:nesszerra"), false);
});

// ---------- moderator token ----------
const broadcasterToken = (f: Fixture, extra: object = {}) =>
  seal(f.env, { access_token: "a1", refresh_token: "r1", userId: ME.id, validatedAt: Date.now(), ...extra });

test("connecting mod access writes the non-expiring modsconnected marker next to the 90-day token", async (t) => {
  const f = environment(),
    mio = { id: "123", login: "miolafff", displayName: "miolafff" };
  const before = Date.now();
  const r = await twitchSignIn(t, f.env, "channel=miolafff&connect=mods", {
    as: mio,
    scopes: ["moderation:read"],
    owner: ME,
  });
  assert.equal(r.status, 303);
  assert.match(must(r.headers.get("Location")), /mods=connected/);
  expiresIn(f, "broadcaster:miolafff", before);
  assert.ok(f.entries.get("broadcaster:miolafff").touched >= before, "touched sits beside the sealed fields");
  assert.ok(f.entries.get("modsconnected:miolafff").at >= before);
  assert.ok(must(f.expires.get("modsconnected:miolafff")) - before > 19 * 365 * DAY, "about 20 years");
});

test("the AuthStore accepts ~20-year expiry for modsconnected markers but caps other keys at 100 days", async () => {
  const { store } = sqliteAuth();
  const put = (key: string, days: number) =>
    store
      .fetch(
        new Request("https://auth/entry?key=" + key, {
          method: "POST",
          headers: { "X-Mini-Internal": INTERNAL, "Content-Type": "application/json" },
          body: JSON.stringify({ value: { at: 1 }, expires: Date.now() + days * DAY }),
        }),
      )
      .then((r) => r.status);
  const cases: [key: string, days: number, status: number][] = [
    ["modsconnected:miolafff", 20 * 365, 200],
    ["channel:miolafff", 20 * 365, 200],
    ["broadcaster:miolafff", 90, 200],
    ["broadcaster:miolafff", 120, 400],
    ["session:x", 20 * 365, 400],
  ];
  for (const [key, days, status] of cases) assert.equal(await put(key, days), status, key + " " + days);
});

test("a successful moderator check pushes the token expiry out 90 days", async (t) => {
  const f = environment();
  f.entries.set("broadcaster:nesszerra", await broadcasterToken(f, { validatedAt: Date.now() - 2 * 3600000 }));
  f.expires.set("broadcaster:nesszerra", Date.now() + 3 * DAY); // nearly lapsed
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/oauth2/validate"))
      return Response.json({ client_id: "test-app", user_id: ME.id, scopes: ["moderation:read"] });
    if (u.includes("/helix/moderation/moderators")) return Response.json({ data: [{ user_id: "2" }] });
    throw new Error("unexpected fetch " + u);
  });
  const before = Date.now();
  assert.equal((await access(f.env, MOD, "nesszerra")).moderator, true);
  expiresIn(f, "broadcaster:nesszerra", before);
  assert.ok(f.entries.get("broadcaster:nesszerra").touched >= before);
});

test("an expired Twitch access token is renewed with the stored refresh token, and the new token is stored for 90 days", async (t) => {
  const f = environment(),
    calls: string[] = [];
  f.entries.set("broadcaster:nesszerra", await broadcasterToken(f));
  t.mock.method(
    globalThis,
    "fetch",
    async (url: RequestInfo | URL, init: { headers?: Record<string, string>; body?: string } = {}) => {
      const u = String(url),
        auth = init.headers?.Authorization;
      calls.push(must(u.split("?")[0]).replace("https://", "") + " " + (auth || ""));
      if (u.endsWith("/oauth2/token")) {
        assert.equal(new URLSearchParams(init.body).get("refresh_token"), "r1");
        return Response.json({ access_token: "a2", refresh_token: "r2" });
      }
      if (u.includes("/oauth2/validate"))
        return Response.json({ client_id: "test-app", user_id: ME.id, scopes: ["moderation:read"] });
      if (u.includes("/helix/moderation/moderators"))
        return auth === "Bearer a1"
          ? new Response("expired", { status: 401 })
          : Response.json({ data: [{ user_id: "2" }] });
      throw new Error("unexpected fetch " + u);
    },
  );
  const before = Date.now();
  assert.equal((await access(f.env, MOD, "nesszerra")).moderator, true);
  assert.ok(calls.includes("id.twitch.tv/oauth2/token "), "refresh token used");
  const stored = await unseal<{ access_token: string; refresh_token: string; userId: string }>(
    f.env,
    f.entries.get("broadcaster:nesszerra"),
  );
  assert.deepEqual([stored.access_token, stored.refresh_token, stored.userId], ["a2", "r2", ME.id]);
  expiresIn(f, "broadcaster:nesszerra", before);
});

test("a refresh that Twitch refuses surfaces as a reconnect error and keeps the old record", async (t) => {
  const f = environment();
  f.entries.set("broadcaster:nesszerra", await broadcasterToken(f, { validatedAt: 0 }));
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL) =>
    String(url).includes("/oauth2/validate")
      ? new Response("no", { status: 401 })
      : new Response("no", { status: 400 }),
  );
  await assert.rejects(access(f.env, MOD, "nesszerra"), /reconnect Twitch/);
  assert.ok(f.entries.has("broadcaster:nesszerra"));
});

// ---------- modsLapsed in the admin snapshot ----------
test("admin snapshot: modsLapsed is true only when mod access was connected and the token is gone", async () => {
  const f = environment(),
    snapshot = await snapshotter(f),
    mods = async () => {
      const s = await snapshot();
      return [s.modsReady, s.modsLapsed];
    };
  assert.deepEqual(await mods(), [false, false], "never connected");
  f.entries.set("modsconnected:nesszerra", { at: 1 });
  assert.deepEqual(await mods(), [false, true], "connected once, token expired");
  f.entries.set("broadcaster:nesszerra", await broadcasterToken(f));
  assert.deepEqual(await mods(), [true, false], "token present");
  f.entries.delete("broadcaster:nesszerra");
  assert.deepEqual(await mods(), [false, true], "and lapsed again once it expires");
});

test("admin snapshot: pointsReady is true only when the stored token has channel:manage:redemptions", async () => {
  const f = environment(),
    snapshot = await snapshotter(f);
  const s = await snapshot();
  assert.deepEqual([s.pointsReady, s.pointsLogin], [false, "/auth/login?channel=nesszerra&connect=points"], "no token");
  const scopes = ["moderation:read", "channel:bot"];
  f.entries.set("broadcaster:nesszerra", await broadcasterToken(f, { scopes }));
  assert.equal((await snapshot()).pointsReady, false, "mod access only");
  f.entries.set(
    "broadcaster:nesszerra",
    await broadcasterToken(f, { scopes: [...scopes, "channel:manage:redemptions"] }),
  );
  assert.equal((await snapshot()).pointsReady, true, "after the points sign-in");
});

test("admin snapshot: a token seen without a marker gets one, and viewing keeps a stale token alive", async () => {
  const f = environment(),
    snapshot = await snapshotter(f);
  f.entries.set("broadcaster:nesszerra", await broadcasterToken(f)); // connected before markers existed: no `touched`
  assert.equal(f.entries.has("modsconnected:nesszerra"), false);
  const before = Date.now();
  const s = await snapshot();
  assert.deepEqual([s.modsReady, s.modsLapsed], [true, false]);
  assert.ok(f.entries.get("modsconnected:nesszerra").at >= before);
  assert.ok(f.entries.get("broadcaster:nesszerra").touched >= before);
  expiresIn(f, "broadcaster:nesszerra", before);
  // a second view within a week writes nothing more
  const stamp = f.entries.get("broadcaster:nesszerra").touched,
    writes = f.expires.get("broadcaster:nesszerra");
  await new Promise((r) => setTimeout(r, 5));
  await snapshot();
  assert.equal(f.entries.get("broadcaster:nesszerra").touched, stamp);
  assert.equal(f.expires.get("broadcaster:nesszerra"), writes);
  // and the token can still be opened after the extra field was added
  assert.equal(
    (await unseal<{ access_token: string }>(f.env, f.entries.get("broadcaster:nesszerra"))).access_token,
    "a1",
  );
});

test("robots.txt and sitemap.xml follow the host: production lists its pages, the test site stays out of search", async () => {
  const site = (await import("../site.config.js")).default,
    { env } = environment();
  const get = async (origin: string, path: string) => {
    const r = await worker.fetch(new Request(origin + path), env);
    return { status: r.status, body: await r.text() };
  };
  const robots = await get(site.origins.production, "/robots.txt");
  assert.match(robots.body, /Disallow: \/api\//);
  assert.match(robots.body, new RegExp("Sitemap: " + site.origins.production + "/sitemap.xml"));
  const map = await get(site.origins.production, "/sitemap.xml");
  for (const p of ["/", "/play/", "/start/", "/changelog/"])
    assert.match(map.body, new RegExp("<loc>" + site.origins.production + p + "</loc>"));
  assert.equal((await get(site.origins.test, "/robots.txt")).body, "User-agent: *\nDisallow: /\n");
  assert.equal((await get(site.origins.test, "/sitemap.xml")).status, 404);
});
