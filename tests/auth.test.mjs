import test from "node:test";
import assert from "node:assert/strict";
import worker from "../server/worker.js";
import { digest, seal, unseal, openState, safeNext, CONNECT_SCOPES } from "../server/auth.js";

function environment() {
  const entries = new Map(),
    forwarded = [];
  const env = {
    AUTH_SECRET: "test-only-auth-key",
    INTERNAL_SECRET: "test-only-internal-key",
    TWITCH_CLIENT_ID: "test-app",
    TWITCH_CLIENT_SECRET: "test-secret",
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
            return Response.json({ ok: true });
          }
          entries.set(key, JSON.parse(options.body).value);
          return Response.json({ ok: true });
        },
      }),
    },
    ROOMS: {
      idFromName: (x) => x,
      get: (channel) => ({
        async fetch(url, options) {
          forwarded.push({ channel, url, options });
          if (new URL(url).pathname === "/catalog") return Response.json([]);
          return Response.json(options.body ? JSON.parse(options.body) : { channel });
        },
      }),
    },
    ASSETS: { fetch: async () => Response.json([{ id: "player" }]) },
  };
  return { env, entries, forwarded };
}
async function signedIn(fixture, owner = false) {
  const cookie = "1".repeat(64),
    user = { id: owner ? "1" : "2", login: owner ? "nesszerra" : "viewer", displayName: "Viewer" };
  fixture.entries.set("owner:nesszerra", { id: "1" });
  fixture.entries.set("session:" + (await digest(cookie)), { user });
  return "mini_session=" + cookie;
}
function req(path, method = "GET", data, cookie, origin = "https://chat.miolaf.xyz") {
  return new Request("https://chat.miolaf.xyz" + path, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== "GET" ? { Origin: origin, "Content-Type": "application/json" } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
}

test("cross-origin writes and unsigned profile writes are rejected", async () => {
  const f = environment();
  assert.equal(
    (
      await worker.fetch(
        req("/api/profile/nesszerra", "POST", { avatar: "player" }, undefined, "https://evil.example"),
        f.env,
      )
    ).status,
    403,
  );
  assert.equal((await worker.fetch(req("/api/profile/nesszerra", "POST", { avatar: "player" }), f.env)).status, 401);
  assert.equal(f.forwarded.length, 0);
});
test("profile identity is derived from session, ignoring forged user IDs", async () => {
  const f = environment(),
    cookie = await signedIn(f);
  const r = await worker.fetch(
    req(
      "/api/profile/nesszerra",
      "POST",
      { userId: "1", username: "nesszerra", avatar: "player", color: "#ffffff", defaultAbility: "heal" },
      cookie,
    ),
    f.env,
  );
  assert.equal(r.status, 200);
  const saved = await r.json();
  assert.equal(saved.userId, "2");
  assert.equal(saved.username, "viewer");
  assert.equal(f.forwarded.at(-1).options.headers.get("X-Mini-Internal"), f.env.INTERNAL_SECRET);
});
test("channels that are not enabled stay inaccessible", async () => {
  const f = environment(),
    cookie = await signedIn(f, true);
  const r = await worker.fetch(req("/api/state/somechannel", "GET", undefined, cookie), f.env);
  assert.equal(r.status, 403);
  assert.equal(f.forwarded.length, 0);
  assert.equal((await worker.fetch(req("/auth/login?channel=somechannel"), f.env)).status, 403);
});
test("miolafff: the broadcaster manages their own channel, through StreamElements only", async () => {
  const f = environment(),
    cookie = "3".repeat(64);
  f.entries.set("owner:nesszerra", { id: "1" });
  f.entries.set("session:" + (await digest(cookie)), { user: { id: "7", login: "miolafff", displayName: "miolafff" } });
  const s = "mini_session=" + cookie;
  assert.deepEqual(await (await worker.fetch(req("/api/access/miolafff", "GET", undefined, s), f.env)).json(), {
    owner: false,
    broadcaster: true,
    moderator: false,
    canManage: true,
  });
  assert.equal((await worker.fetch(req("/api/state/miolafff"), f.env)).status, 200);
  assert.equal(
    (await worker.fetch(req("/api/admin/miolafff", "POST", { action: "resetAllRanks" }, s), f.env)).status,
    200,
  );
  assert.equal(
    (await worker.fetch(req("/api/admin/miolafff", "POST", { action: "connectChat" }, s), f.env)).status,
    400,
    "no EventSub for other channels",
  );
  // miolafff's account has no say over nesszerra, and a viewer has none over miolafff
  assert.equal(
    (await worker.fetch(req("/api/admin/nesszerra", "POST", { action: "resetAllRanks" }, s), f.env)).status,
    403,
  );
  const viewer = await signedIn(f);
  assert.equal(
    (await worker.fetch(req("/api/admin/miolafff", "POST", { action: "resetAllRanks" }, viewer), f.env)).status,
    403,
  );
  // sign-in comes back to the channel's page; broadcaster chat authorization stays nesszerra-only
  const login = await worker.fetch(req("/auth/login?channel=miolafff&next=/admin/"), f.env);
  assert.equal(login.status, 302);
  const nonce = new URL(login.headers.get("Location")).searchParams.get("state");
  assert.deepEqual(await openState(f.env, nonce), { channel: "miolafff", connect: false, next: "/admin/" });
  assert.equal(
    [...f.entries.keys()].some((k) => k.startsWith("oauth:")),
    false,
    "sign-in start writes nothing to AuthStore",
  );
  assert.equal((await worker.fetch(req("/auth/login?channel=miolafff&connect=1"), f.env)).status, 403); // the bare /admin/ page signs in without naming a channel, so the page can send a streamer to their own
  const bare = await worker.fetch(req("/auth/login?next=%2Fadmin%2F"), f.env);
  assert.deepEqual(await openState(f.env, new URL(bare.headers.get("Location")).searchParams.get("state")), {
    connect: false,
    next: "/admin/",
  });
});
test("a moderator cannot reset every rank, make a new StreamElements key or take chat over from another site", async () => {
  const f = environment(),
    cookie = await signedIn(f);
  f.entries.set("mod:nesszerra:2", true);
  assert.equal(
    (await (await worker.fetch(req("/api/access/nesszerra", "GET", undefined, cookie), f.env)).json()).moderator,
    true,
  );
  for (const body of [
    { action: "resetAllRanks" },
    { action: "rotateSeKey" },
    { action: "connectChat", takeover: true },
  ]) {
    const r = await worker.fetch(req("/api/admin/nesszerra", "POST", body, cookie), f.env);
    assert.deepEqual([r.status, (await r.json()).reason], [403, "broadcaster_only"], body.action);
  }
  assert.equal(
    (await worker.fetch(req("/api/admin/nesszerra", "POST", { action: "resetAll" }, cookie), f.env)).status,
    200,
    "clearing the arena stays with mods",
  );
});
test("the leaderboard with dollars (?private=1) is for mods and the owner; the public one never asks for them", async () => {
  const f = environment(),
    viewer = await signedIn(f);
  await worker.fetch(req("/api/leaderboard/nesszerra?private=1"), f.env).then((r) => assert.equal(r.status, 401));
  await worker
    .fetch(req("/api/leaderboard/nesszerra?private=1", "GET", undefined, viewer), f.env)
    .then((r) => assert.equal(r.status, 403));
  assert.equal(f.forwarded.length, 0);
  assert.equal(
    (await worker.fetch(req("/api/leaderboard/nesszerra?private=1", "GET", undefined, await signedIn(f, true)), f.env))
      .status,
    200,
  );
  assert.equal(new URL(f.forwarded.at(-1).url).search, "?private=1");
  assert.equal((await worker.fetch(req("/api/leaderboard/nesszerra?private=0"), f.env)).status, 200);
  assert.equal(new URL(f.forwarded.at(-1).url).search, "");
});
test("/api/picker lists every channel with its top three ranked fighters in one request", async () => {
  const f = environment(),
    boards = {
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
      miolafff: [
        { userId: "9", username: "idle", displayName: "Idle", elo: 1000, wins: 0, losses: 0, avatar: "player" },
      ],
    };
  f.env.AUTH = { idFromName: (x) => x, get: () => ({ fetch: async () => Response.json([]) }) };
  f.env.ROOMS = {
    idFromName: (x) => x,
    get: (channel) => ({
      async fetch(url) {
        const path = new URL(url).pathname;
        if (path === "/leaderboard") return Response.json(boards[channel] || []);
        if (path === "/catalog")
          return Response.json([{ id: "up-1", url: "/api/assets/" + channel + "/up-1" }, { id: "up-2" }]);
        return Response.json({});
      },
    }),
  };
  const r = await worker.fetch(req("/api/picker"), f.env),
    data = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual(data.catalog, [{ id: "player" }], "built-in catalog once");
  const [ness, mio] = ["nesszerra", "miolafff"].map((c) => data.channels.find((x) => x.login === c));
  assert.deepEqual(
    ness.top.map((p) => p.username),
    ["u1", "u2", "u3"],
  );
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
  assert.equal(
    (
      await worker.fetch(
        req("/api/admin/nesszerra", "POST", { actorId: "1", owner: true, action: "resetAllRanks" }, cookie),
        f.env,
      )
    ).status,
    403,
  );
  assert.equal(
    (await worker.fetch(req("/api/admin/nesszerra", "POST", { action: "connectChat" }, cookie), f.env)).status,
    403,
  );
  assert.equal((await worker.fetch(req("/api/dev/save", "POST", { owner: true }, cookie), f.env)).status, 403);
});
test("connect=1 asks for the chat scopes the EventSub webhook needs", async () => {
  const f = environment();
  const r = await worker.fetch(req("/auth/login?connect=1"), f.env);
  assert.equal(r.status, 302);
  assert.deepEqual(new URL(r.headers.get("Location")).searchParams.get("scope").split(" "), CONNECT_SCOPES);
  assert.deepEqual(CONNECT_SCOPES, ["moderation:read", "user:read:chat", "user:bot", "channel:bot"]);
  assert.equal(
    new URL((await worker.fetch(req("/auth/login"), f.env)).headers.get("Location")).searchParams.get("scope"),
    "",
    "plain sign-in asks for nothing",
  );
  assert.equal(
    new URL(r.headers.get("Location")).searchParams.has("force_verify"),
    false,
    "only sign-up shows the account picker",
  );
});
test("a connect=1 callback without every chat scope is refused with a restart hint", async (t) => {
  const f = environment();
  const login = await worker.fetch(req("/auth/login?connect=1"), f.env);
  const state = new URL(login.headers.get("Location")).searchParams.get("state");
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = String(url);
    if (u.endsWith("/oauth2/token")) return Response.json({ access_token: "user-token", refresh_token: "r" });
    if (u.endsWith("/oauth2/validate"))
      return Response.json({ client_id: "test-app", user_id: "1", scopes: ["moderation:read", "user:read:chat"] });
    return Response.json({ data: [{ id: "1", login: "nesszerra", display_name: "nesszerra" }] });
  });
  const r = await worker.fetch(
    new Request("https://chat.miolaf.xyz/auth/callback?code=c&state=" + state, {
      headers: { Cookie: "mini_oauth=" + state },
    }),
    f.env,
  );
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /user:bot, channel:bot\. Restart at \/auth\/login\?connect=1/);
  assert.equal(f.entries.has("broadcaster:nesszerra"), false);
});
test("OAuth state mismatch is rejected without a token exchange", async () => {
  const f = environment();
  const r = await worker.fetch(req("/auth/callback?state=wrong&code=forged"), f.env);
  assert.equal(r.status, 400);
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
test("a moderator check is cached for a minute, so repeat page loads do not call Twitch again", async () => {
  const f = environment(),
    cookie = await signedIn(f);
  f.entries.set(
    "broadcaster:nesszerra",
    await seal(f.env, { access_token: "a", refresh_token: "r", userId: "1", validatedAt: Date.now() }),
  );
  const realFetch = globalThis.fetch;
  let helix = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/helix/moderation/moderators")) {
      helix++;
      return Response.json({ data: [{ user_id: "2" }] });
    }
    throw new Error("unexpected fetch " + url);
  };
  try {
    for (let i = 0; i < 3; i++)
      assert.equal(
        (await (await worker.fetch(req("/api/access/nesszerra", "GET", undefined, cookie), f.env)).json()).canManage,
        true,
      );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(helix, 1);
  assert.equal(f.entries.get("mod:nesszerra:2"), true);
});
test("viewers can still sign in when Twitch fails to look up the channel owner", async (t) => {
  const f = environment();
  const login = await worker.fetch(req("/auth/login"), f.env);
  const state = new URL(login.headers.get("Location")).searchParams.get("state");
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = String(url);
    if (u.endsWith("/oauth2/token")) return Response.json({ access_token: "user-token", refresh_token: "r" });
    if (u.endsWith("/oauth2/validate")) return Response.json({ client_id: "test-app", user_id: "2", scopes: [] });
    if (u.includes("users?login=nesszerra")) return new Response("busy", { status: 503 });
    return Response.json({ data: [{ id: "2", login: "viewer", display_name: "Viewer" }] });
  });
  const r = await worker.fetch(
    new Request("https://chat.miolaf.xyz/auth/callback?code=c&state=" + state, {
      headers: { Cookie: "mini_oauth=" + state },
    }),
    f.env,
  );
  assert.equal(r.status, 303);
  assert.match(r.headers.get("Set-Cookie"), /mini_session=/);
  assert.match(r.headers.get("Set-Cookie"), /mini_session=[a-f0-9]{64};[^,]*Max-Age=2592000/, "sign-in lasts 30 days");
});

// Signs in through /auth/login?<query> as a viewer and returns where the callback sends the browser.
async function signInFrom(t, f, query) {
  const login = await worker.fetch(req("/auth/login?" + query), f.env);
  const state = new URL(login.headers.get("Location")).searchParams.get("state");
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = String(url);
    if (u.endsWith("/oauth2/token")) return Response.json({ access_token: "user-token", refresh_token: "r" });
    if (u.endsWith("/oauth2/validate")) return Response.json({ client_id: "test-app", user_id: "2", scopes: [] });
    return Response.json({
      data: [
        {
          id: u.includes("login=nesszerra") ? "1" : "2",
          login: u.includes("login=nesszerra") ? "nesszerra" : "viewer",
          display_name: "Viewer",
        },
      ],
    });
  });
  const r = await worker.fetch(
    new Request("https://chat.miolaf.xyz/auth/callback?code=c&state=" + state, {
      headers: { Cookie: "mini_oauth=" + state },
    }),
    f.env,
  );
  t.mock.restoreAll();
  assert.equal(r.status, 303);
  return r.headers.get("Location");
}
test("sign-in comes back to the page, channel and tab it started on, never to another site", async (t) => {
  const f = environment(),
    from = (next, channel) => signInFrom(t, f, new URLSearchParams({ ...(channel ? { channel } : {}), next }));
  assert.equal(await from("/?channel=miolafff#looks", "miolafff"), "/?channel=miolafff&signed_in=1#looks");
  assert.equal(
    await from("/admin/?channel=miolafff#settings", "miolafff"),
    "/admin/?channel=miolafff&signed_in=1#settings",
  );
  assert.equal(await from("/play/"), "/play/?signed_in=1", "the picker stays the picker");
  assert.equal(await from("/start/"), "/start/?signed_in=1");
  assert.equal(await from("/admin/"), "/admin/?signed_in=1", "the bare mod page: the Worker picks the channel next");
  assert.equal(
    await from("/admin/?channel=miolafff&mods=connected&signed_in=1", "miolafff"),
    "/admin/?channel=miolafff&signed_in=1",
    "old one-time flags are dropped",
  );
  assert.equal(
    await signInFrom(t, f, "channel=miolafff&next=/"),
    "/?channel=miolafff&signed_in=1",
    "older links that name the channel still land on it",
  );
  assert.equal(await from("//evil.example/x"), "/?channel=nesszerra&signed_in=1");
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
test("sign-out clears the session and leaves the page where it is (the page reloads itself)", async () => {
  const f = environment(),
    cookie = await signedIn(f);
  const r = await worker.fetch(req("/auth/logout", "POST", {}, cookie, "https://chat.miolaf.xyz"), f.env);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.match(r.headers.get("Set-Cookie"), /mini_session=;.*Max-Age=0/);
  assert.equal(f.entries.has("session:" + (await digest("1".repeat(64)))), false);
});
test("pages: / is the intro, /?channel= the fighter page, /play/ the picker, and /intro/ moves to /", async () => {
  const f = environment();
  f.env.ASSETS = { fetch: async (r) => new Response("asset " + new URL(r.url).pathname) };
  const get = (path) => worker.fetch(req(path), f.env),
    body = async (path) => (await get(path)).text();
  const moved = async (path, status) => {
    const r = await get(path);
    assert.equal(r.status, status, path);
    return r.headers.get("Location");
  };
  assert.equal(await body("/"), "asset /intro/");
  assert.equal(await body("/?signed_in=1"), "asset /intro/");
  assert.equal(await body("/?channel=miolafff"), "asset /");
  assert.equal(await body("/play/"), "asset /");
  assert.equal((await get("/")).headers.get("X-Frame-Options"), "DENY", "the intro gets the page headers too");
  assert.equal(await moved("/play", 301), "https://chat.miolaf.xyz/play/");
  assert.equal(await moved("/play/?channel=miolafff", 302), "https://chat.miolaf.xyz/?channel=miolafff");
  for (const old of ["/intro", "/intro/", "/intro/index.html"])
    assert.equal(await moved(old, 301), "https://chat.miolaf.xyz/");
  assert.equal(await moved("/intro/?ref=x", 301), "https://chat.miolaf.xyz/?ref=x");
});
test("a streamer opening the bare mod page goes straight to their own channel; others get the page", async () => {
  const f = environment();
  f.env.ASSETS = { fetch: async (r) => new Response("asset " + new URL(r.url).pathname) };
  const owner = await signedIn(f, true);
  const r = await worker.fetch(req("/admin/?signed_in=1", "GET", undefined, owner), f.env);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("Location"), "https://chat.miolaf.xyz/admin/?signed_in=1&channel=nesszerra");
  assert.equal(
    (await worker.fetch(req("/admin/?channel=miolafff", "GET", undefined, owner), f.env)).status,
    200,
    "a named channel stays",
  );
  const viewer = environment();
  viewer.env.ASSETS = f.env.ASSETS;
  assert.equal(
    await (await worker.fetch(req("/admin/", "GET", undefined, await signedIn(viewer)), viewer.env)).text(),
    "asset /admin/",
    "no channel of their own: the page explains",
  );
  assert.equal(
    await (await worker.fetch(req("/admin/"), viewer.env)).text(),
    "asset /admin/",
    "signed out: the page offers sign-in",
  );
});
