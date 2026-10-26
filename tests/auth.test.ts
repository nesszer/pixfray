import test from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import worker from "../server/worker.ts";
import { digest, seal, unseal, openState, safeNext, CONNECT_SCOPES } from "../server/auth.ts";
import { asEnv, must, type Loose } from "./fakes.ts";
import { ORIGIN, OWNER, SECRETS, memoryAuth, namespace, signIn, signedIn, req, call, status } from "./worker-fakes.ts";
import { twitchSignIn, type StubInit } from "./worker-fakes.ts";

// An in-memory AuthStore and rooms that echo the body they were sent; `forwarded` lists the room calls.
function environment(extra: Record<string, unknown> = {}) {
  // entries hold whatever JSON the Worker stored; tests read them by property
  const entries = new Map<string, Loose>(),
    forwarded: { channel: string; url: string; init: StubInit }[] = [];
  const env = asEnv({
    ...SECRETS,
    AUTH: memoryAuth(entries),
    ROOMS: namespace(async (channel, url, init) => {
      forwarded.push({ channel, url, init });
      if (new URL(url).pathname === "/catalog") return Response.json([]);
      return Response.json(init.body ? JSON.parse(init.body) : { channel });
    }),
    ASSETS: { fetch: async () => Response.json([{ id: "player" }]) },
    ...extra,
  });
  return { env, entries, forwarded };
}
type Fixture = ReturnType<typeof environment>;
const MIO = { id: "7", login: "miolafff", displayName: "miolafff" };
const location = (r: Response) => new URL(must(r.headers.get("Location")), ORIGIN);
// openState reads a missing state as empty; a login always sets one
const stateOf = (r: Response) => location(r).searchParams.get("state") as string;
// a fake asset binding that echoes the path it was asked for
const ECHO = { ASSETS: { fetch: async (r: Request) => new Response("asset " + new URL(r.url).pathname) } };

test("cross-origin writes and unsigned profile writes are rejected", async () => {
  const f = environment(),
    body = { avatar: "player" };
  assert.equal(
    await status(f.env, "/api/profile/nesszerra", "POST", body, undefined, { Origin: "https://evil.example" }),
    403,
  );
  assert.equal(await status(f.env, "/api/profile/nesszerra", "POST", body), 401);
  assert.equal(f.forwarded.length, 0);
});
test("profile identity is derived from session, ignoring forged user IDs", async () => {
  const f = environment(),
    cookie = await signedIn(f);
  const forged = { userId: "1", username: "nesszerra", avatar: "player", color: "#ffffff", defaultAbility: "heal" };
  const r = await call(f.env, "/api/profile/nesszerra", "POST", forged, cookie);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.userId, r.body.username], ["2", "viewer"]);
  assert.equal(new Headers(must(f.forwarded.at(-1)).init.headers).get("X-Mini-Internal"), f.env.INTERNAL_SECRET);
});
test("channels that are not enabled stay inaccessible", async () => {
  const f = environment(),
    cookie = await signedIn(f, true);
  assert.equal(await status(f.env, "/api/state/somechannel", "GET", undefined, cookie), 403);
  assert.equal(f.forwarded.length, 0);
  assert.equal(await status(f.env, "/auth/login?channel=somechannel"), 403);
});
test("miolafff: the broadcaster manages their own channel, through StreamElements only", async () => {
  const f = environment();
  f.entries.set("owner:nesszerra", { id: "1" });
  const s = await signIn(f.env, MIO),
    admin = (channel: string, action: string, cookie = s) =>
      call(f.env, "/api/admin/" + channel, "POST", { action }, cookie);
  assert.deepEqual((await call(f.env, "/api/access/miolafff", "GET", undefined, s)).body, {
    owner: false,
    broadcaster: true,
    moderator: false,
    canManage: true,
  });
  assert.equal(await status(f.env, "/api/state/miolafff"), 200);
  assert.equal((await admin("miolafff", "resetAllRanks")).status, 200);
  assert.deepEqual(
    (await admin("miolafff", "restoreRank")).body,
    { error: "Only the site owner can restore a rank", reason: "owner_only" },
    "the broadcaster can't set ranks by hand",
  );
  assert.equal((await admin("miolafff", "connectChat")).status, 400, "no EventSub for other channels");
  // miolafff's account has no say over nesszerra, and a viewer has none over miolafff
  assert.equal((await admin("nesszerra", "resetAllRanks")).status, 403);
  assert.equal((await admin("miolafff", "resetAllRanks", await signedIn(f))).status, 403);
  // sign-in comes back to the channel's page; broadcaster chat authorization stays nesszerra-only
  const login = await worker.fetch(req("/auth/login?channel=miolafff&next=/admin/"), f.env);
  assert.equal(login.status, 302);
  assert.deepEqual(await openState(f.env, stateOf(login)), { channel: "miolafff", connect: false, next: "/admin/" });
  const wrote = [...f.entries.keys()].some((k) => k.startsWith("oauth:"));
  assert.equal(wrote, false, "sign-in start writes nothing to AuthStore");
  assert.equal(await status(f.env, "/auth/login?channel=miolafff&connect=1"), 403);
  // the bare /admin/ page signs in without naming a channel, so the page can send a streamer to their own
  const bare = await worker.fetch(req("/auth/login?next=%2Fadmin%2F"), f.env);
  assert.deepEqual(await openState(f.env, stateOf(bare)), { connect: false, next: "/admin/" });
});
test("a moderator cannot reset every rank, make a new StreamElements key or take chat over from another site", async () => {
  const f = environment(),
    cookie = await signedIn(f);
  f.entries.set("mod:nesszerra:2", true);
  assert.equal((await call(f.env, "/api/access/nesszerra", "GET", undefined, cookie)).body.moderator, true);
  for (const body of [
    { action: "resetAllRanks" },
    { action: "rotateSeKey" },
    { action: "connectChat", takeover: true },
  ]) {
    const r = await call(f.env, "/api/admin/nesszerra", "POST", body, cookie);
    assert.deepEqual([r.status, r.body.reason], [403, "broadcaster_only"], body.action);
  }
  const cleared = await status(f.env, "/api/admin/nesszerra", "POST", { action: "resetAll" }, cookie);
  assert.equal(cleared, 200, "clearing the arena stays with mods");
});
test("the leaderboard with dollars (?private=1) is for mods and the owner; the public one never asks for them", async () => {
  const f = environment(),
    path = "/api/leaderboard/nesszerra?private=",
    search = () => new URL(must(f.forwarded.at(-1)).url).search;
  assert.equal(await status(f.env, path + "1"), 401);
  assert.equal(await status(f.env, path + "1", "GET", undefined, await signedIn(f)), 403);
  assert.equal(f.forwarded.length, 0);
  assert.equal(await status(f.env, path + "1", "GET", undefined, await signedIn(f, true)), 200);
  assert.equal(search(), "?private=1");
  assert.equal(await status(f.env, path + "0"), 200);
  assert.equal(search(), "");
});
test("/api/picker lists every channel with its top three ranked fighters in one request", async () => {
  const boards: Record<string, object[]> = {
    nesszerra: [1, 2, 3, 4].map((n) => ({
      userId: String(n),
      username: "u" + n,
      displayName: "U" + n,
      elo: 1100 - n,
      wins: 1,
      losses: 0,
      avatar: n === 1 ? "up-1" : "player",
      dollars: 50,
    })),
    miolafff: [{ userId: "9", username: "idle", displayName: "Idle", elo: 1000, wins: 0, losses: 0, avatar: "player" }],
  };
  const f = environment({
    AUTH: namespace(async () => Response.json([])),
    ROOMS: namespace(async (channel, url) => {
      const path = new URL(url).pathname;
      if (path === "/leaderboard") return Response.json(boards[channel] || []);
      if (path === "/catalog")
        return Response.json([{ id: "up-1", url: "/api/assets/" + channel + "/up-1" }, { id: "up-2" }]);
      return Response.json({});
    }),
  });
  const { status: code, body: data } = await call(f.env, "/api/picker");
  assert.equal(code, 200);
  assert.deepEqual(data.catalog, [{ id: "player" }], "built-in catalog once");
  const [ness, mio] = ["nesszerra", "miolafff"].map((c) => data.channels.find((x: { login: string }) => x.login === c));
  const top = ness.top.map((p: { username: string }) => p.username);
  assert.deepEqual(top, ["u1", "u2", "u3"]);
  assert.deepEqual(Object.keys(ness.top[0]).sort(), ["avatar", "displayName", "elo", "username"], "no dollars or ids");
  assert.deepEqual(
    ness.catalog,
    [{ id: "up-1", url: "/api/assets/nesszerra/up-1" }],
    "only the uploads its top fighters wear",
  );
  assert.deepEqual(mio.top, [], "unranked fighters are left out");
  assert.equal("catalog" in mio, false);
  assert.equal(data.full, false, "room for more channels");
});
test("a viewer cannot grant themselves mod or developer permissions", async () => {
  const f = environment(),
    cookie = await signedIn(f);
  const forged = { actorId: "1", owner: true, action: "resetAllRanks" };
  assert.equal(await status(f.env, "/api/admin/nesszerra", "POST", forged, cookie), 403);
  assert.equal(await status(f.env, "/api/dev/save", "POST", { owner: true }, cookie), 403);
});
test("connect=1 asks for the chat scopes the EventSub webhook needs", async () => {
  const f = environment(),
    login = async (query: string) => location(await worker.fetch(req("/auth/login" + query), f.env)).searchParams;
  const r = await worker.fetch(req("/auth/login?connect=1"), f.env);
  assert.equal(r.status, 302);
  assert.deepEqual(must(location(r).searchParams.get("scope")).split(" "), CONNECT_SCOPES);
  assert.deepEqual(CONNECT_SCOPES, ["moderation:read", "user:read:chat", "user:bot", "channel:bot"]);
  assert.equal((await login("")).get("scope"), "", "plain sign-in asks for nothing");
  assert.equal((await login("?connect=1")).has("force_verify"), false, "only sign-up shows the account picker");
});
test("a connect=1 callback without every chat scope is refused with a restart hint", async (t) => {
  const f = environment();
  const r = await twitchSignIn(t, f.env, "connect=1", { as: OWNER, scopes: ["moderation:read", "user:read:chat"] });
  assert.equal(r.status, 403);
  const { error } = await r.json<{ error: string }>();
  assert.match(error, /user:bot, channel:bot\. Restart at \/auth\/login\?connect=1/);
  assert.equal(f.entries.has("broadcaster:nesszerra"), false);
});
test("OAuth state mismatch is rejected without a token exchange", async () => {
  assert.equal(await status(environment().env, "/auth/callback?state=wrong&code=forged"), 400);
});
test("stored Twitch tokens are authenticated ciphertext", async () => {
  const f = environment(),
    secret = { access_token: "private-value", refresh_token: "refresh-value" };
  const encrypted = await seal(f.env, secret);
  assert.equal(JSON.stringify(encrypted).includes("private-value"), false);
  assert.deepEqual(await unseal(f.env, encrypted), secret);
  const corrupted = { ...encrypted, data: encrypted.data.slice(0, 8) + "AAAA" + encrypted.data.slice(12) };
  await assert.rejects(unseal(f.env, corrupted));
});
test("a moderator check is cached for a minute, so repeat page loads do not call Twitch again", async (t) => {
  const f = environment(),
    cookie = await signedIn(f);
  f.entries.set(
    "broadcaster:nesszerra",
    await seal(f.env, { access_token: "a", refresh_token: "r", userId: "1", validatedAt: Date.now() }),
  );
  let helix = 0;
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL) => {
    if (!String(url).includes("/helix/moderation/moderators")) throw new Error("unexpected fetch " + url);
    helix++;
    return Response.json({ data: [{ user_id: "2" }] });
  });
  for (let i = 0; i < 3; i++)
    assert.equal((await call(f.env, "/api/access/nesszerra", "GET", undefined, cookie)).body.canManage, true);
  assert.equal(helix, 1);
  assert.equal(f.entries.get("mod:nesszerra:2"), true);
});
test("viewers can still sign in when Twitch fails to look up the channel owner", async (t) => {
  const r = await twitchSignIn(t, environment().env, "", { owner: new Response("busy", { status: 503 }) });
  assert.equal(r.status, 303);
  const cookie = must(r.headers.get("Set-Cookie"));
  assert.match(cookie, /mini_session=[a-f0-9]{64};[^,]*Max-Age=2592000/, "sign-in lasts 30 days");
});

// Signs in through /auth/login?<query> as a viewer and returns where the callback sends the browser.
async function signInFrom(t: TestContext, f: Fixture, query: string | URLSearchParams) {
  const r = await twitchSignIn(t, f.env, String(query));
  assert.equal(r.status, 303);
  return r.headers.get("Location");
}
test("sign-in comes back to the page, channel and tab it started on, never to another site", async (t) => {
  const f = environment(),
    from = (next: string, channel?: string) =>
      signInFrom(t, f, new URLSearchParams({ ...(channel ? { channel } : {}), next }));
  const cases: [next: string, channel: string | undefined, back: string, why?: string][] = [
    ["/?channel=miolafff#looks", "miolafff", "/?channel=miolafff&signed_in=1#looks"],
    ["/admin/?channel=miolafff#settings", "miolafff", "/admin/?channel=miolafff&signed_in=1#settings"],
    ["/play/", undefined, "/play/?signed_in=1", "the picker stays the picker"],
    ["/start/", undefined, "/start/?signed_in=1"],
    ["/admin/", undefined, "/admin/?signed_in=1", "the bare mod page: the Worker picks the channel next"],
    [
      "/admin/?channel=miolafff&mods=connected&signed_in=1",
      "miolafff",
      "/admin/?channel=miolafff&signed_in=1",
      "old one-time flags are dropped",
    ],
    ["//evil.example/x", undefined, "/?channel=nesszerra&signed_in=1"],
  ];
  for (const [next, channel, back, why] of cases) assert.equal(await from(next, channel), back, why ?? next);
  const older = await signInFrom(t, f, "channel=miolafff&next=/");
  assert.equal(older, "/?channel=miolafff&signed_in=1", "older links that name the channel still land on it");
  for (const bad of [
    "//evil.example",
    "/\\evil.example",
    "https://evil.example/",
    "/auth/logout",
    "/api/session",
    "/x\n",
    "x",
    "",
    null,
  ])
    assert.equal(safeNext(bad), "/", String(bad));
  assert.equal(safeNext("/start/?a=1#b"), "/start/?a=1#b");
});
const sessionKey = async (cookie: string) => "session:" + (await digest(cookie.replace("mini_session=", "")));
test("sign-out clears the session and leaves the page where it is (the page reloads itself)", async () => {
  const f = environment(),
    cookie = await signedIn(f);
  const r = await worker.fetch(req("/auth/logout", "POST", {}, cookie), f.env);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.match(must(r.headers.get("Set-Cookie")), /mini_session=;.*Max-Age=0/);
  assert.equal(f.entries.has(await sessionKey(cookie)), false);
});
test("sign-out reads only the cookie named mini_session, not one that ends in it", async () => {
  const f = environment(),
    cookie = await signedIn(f),
    other = await signIn(f.env, { id: "9", login: "other", displayName: "Other" });
  assert.equal(await status(f.env, "/auth/logout", "POST", {}, "x" + other + "; " + cookie), 200);
  assert.equal(f.entries.has(await sessionKey(cookie)), false, "the real session is gone");
  assert.equal(f.entries.has(await sessionKey(other)), true, "the look-alike cookie's session stays");
});
test("a room or auth route whose binding throws gets the Worker's error answer, not a rejected fetch", async () => {
  const down = namespace(async () => {
    throw new Error("binding down");
  });
  const rooms = environment({ ROOMS: down }),
    auth = environment();
  const cookie = await signedIn(auth);
  auth.env.AUTH = down;
  for (const r of [
    await call(rooms.env, "/api/shop/nesszerra"),
    await call(auth.env, "/auth/logout", "POST", {}, cookie),
  ])
    assert.deepEqual(r, { status: 503, body: { error: "Service unavailable; check owner diagnostics" } });
});
test("pages: / is the intro, /?channel= the fighter page, /play/ the picker, and /intro/ moves to /", async () => {
  const f = environment(ECHO);
  const get = (path: string) => worker.fetch(req(path), f.env),
    body = async (path: string) => (await get(path)).text();
  const moved = async (path: string, status: number) => {
    const r = await get(path);
    assert.equal(r.status, status, path);
    return r.headers.get("Location");
  };
  assert.equal(await body("/"), "asset /intro/");
  assert.equal(await body("/?signed_in=1"), "asset /intro/");
  assert.equal(await body("/?channel=miolafff"), "asset /");
  assert.equal(await body("/play/"), "asset /");
  assert.equal((await get("/")).headers.get("X-Frame-Options"), "DENY", "the intro gets the page headers too");
  assert.equal(await moved("/play", 301), ORIGIN + "/play/");
  assert.equal(await moved("/changelog", 301), ORIGIN + "/changelog/");
  assert.equal(await moved("/play/?channel=miolafff", 302), ORIGIN + "/?channel=miolafff");
  for (const old of ["/intro", "/intro/", "/intro/index.html"]) assert.equal(await moved(old, 301), ORIGIN + "/");
  assert.equal(await moved("/intro/?ref=x", 301), ORIGIN + "/?ref=x");
});
test("a streamer opening the bare mod page goes straight to their own channel; others get the page", async () => {
  const f = environment(ECHO),
    owner = await signedIn(f, true);
  const r = await worker.fetch(req("/admin/?signed_in=1", "GET", undefined, owner), f.env);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("Location"), ORIGIN + "/admin/?signed_in=1&channel=nesszerra");
  assert.equal(await status(f.env, "/admin/?channel=miolafff", "GET", undefined, owner), 200, "a named channel stays");
  const viewer = environment(ECHO),
    page = async (cookie?: string) => (await worker.fetch(req("/admin/", "GET", undefined, cookie), viewer.env)).text();
  assert.equal(await page(await signedIn(viewer)), "asset /admin/", "no channel of their own: the page explains");
  assert.equal(await page(), "asset /admin/", "signed out: the page offers sign-in");
});
