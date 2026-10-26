// Channel registry, open sign-up through /start, mod access later, and turning a channel off (server/channels.ts).
// AuthStore runs for real on node:sqlite; rooms are a fake that echoes.
import test from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import worker from "../server/worker.ts";
import { record } from "../server/auth.ts";
import { forgetChannel, isFull, MAX_CHANNELS } from "../server/channels.ts";
import { OFF_TEXT } from "../server/streamelements.ts";
import type { HelixUser } from "../server/auth.ts";
import type { HelixPage } from "../server/channels.ts";
import type { Env } from "../server/env.ts";
import { asEnv, must } from "./fakes.ts";
import { ORIGIN, OWNER, SECRETS, namespace, sqliteAuth, signIn, req, call, status, type User } from "./worker-fakes.ts";

function environment() {
  forgetChannel();
  const { store, ctx, AUTH } = sqliteAuth(),
    rooms: { channel: string; path: string }[] = [];
  const env = asEnv({
    ...SECRETS,
    OWNER_TWITCH_ID: "1",
    AUTH,
    ROOMS: namespace(async (channel, url) => {
      const path = new URL(url).pathname;
      rooms.push({ channel, path });
      return Response.json(path === "/se" ? { reply: "room answered" } : { channel });
    }),
    ASSETS: { fetch: async () => new Response("page") },
  });
  return { env, store, ctx, rooms };
}
const STREAMER = { id: "55", login: "newstreamer", displayName: "NewStreamer" },
  VIEWER9 = { id: "9", login: "viewer", displayName: "viewer" },
  DAY = 86400000,
  SE_KEY = "a1".repeat(24);
const BACK = "/admin/?channel=newstreamer&signed_in=1#chat";
// Twitch, as seen by the callback: `as` is the account that signs in, `scopes` what it granted.
type Account = User & { videos?: number | "fail"; createdAt?: string; type?: string };
function twitch(t: TestContext, as: Account, scopes: string[]) {
  return t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.endsWith("/oauth2/token")) return Response.json({ access_token: "user-token", refresh_token: "r" });
    if (u.endsWith("/oauth2/validate")) return Response.json({ client_id: "test-app", user_id: as.id, scopes });
    if (u.includes("login=nesszerra"))
      return Response.json({ data: [{ id: "1", login: "nesszerra", display_name: "nesszerra" }] });
    // nobody here is a channel mod: the access checks in these tests turn on who owns the channel
    if (u.includes("/helix/moderation/moderators")) return Response.json({ data: [] });
    if (u.includes("/helix/videos"))
      return as.videos === "fail"
        ? new Response("", { status: 503 })
        : Response.json({ data: Array(as.videos ?? 1).fill({ id: "v1" }) });
    const identity = {
      id: as.id,
      login: as.login,
      display_name: as.displayName,
      created_at: as.createdAt ?? "2020-01-01T00:00:00Z",
      broadcaster_type: as.type ?? "",
    };
    return Response.json({ data: [identity] });
  });
}
const login = (env: Env, query: string) => worker.fetch(req("/auth/login?" + query), env);
const loginParams = async (env: Env, query: string) =>
  new URL(must((await login(env, query)).headers.get("Location"))).searchParams;
const callback = (env: Env, state: string | null, query = "code=c") =>
  worker.fetch(
    new Request(ORIGIN + "/auth/callback?" + query + "&state=" + state, { headers: { Cookie: "mini_oauth=" + state } }),
    env,
  );
/** Signs in from /auth/login?<query> as `as`, granting `scopes`; returns the callback's answer. */
async function signUp(t: TestContext, env: Env, as: Account, scopes = ["moderation:read"], query = "signup=1") {
  const state = (await loginParams(env, query)).get("state"),
    mock = twitch(t, as, scopes);
  const r = await callback(env, state);
  mock.mock.restore();
  return r;
}
const where = async (...args: Parameters<typeof signUp>) => (await signUp(...args)).headers.get("Location");
const noSession = (r: Response) => assert.equal(must(r.headers.get("Set-Cookie")).includes("mini_session"), false);
const enable = (env: Env, login: string, id: string, enabledAt = 1) =>
  record(env, "channel:" + login, { id, login, enabledAt }, Date.now() + DAY);

test("AuthStore lists only the channel prefix; only channel rows may live for years", async () => {
  const { env, store } = environment();
  const list = (key: string) =>
    store.fetch(
      new Request("https://auth/list?key=" + encodeURIComponent(key), {
        headers: { "X-Mini-Internal": env.INTERNAL_SECRET },
      }),
    );
  for (const prefix of ["session:", "broadcaster:", "invite:"]) assert.equal((await list(prefix)).status, 400, prefix);
  await record(env, "channel:abc", { login: "abc" }, Date.now() + 10 * 365 * DAY);
  await record(env, "channelz", { login: "not a row" }, Date.now() + 60000);
  await assert.rejects(record(env, "session:x", {}, Date.now() + 200 * DAY));
  assert.deepEqual(await (await list("channel:")).json(), [{ key: "channel:abc", value: { login: "abc" } }]);
});

test("sign-up: any streamer signs in with moderation:read and their own channel turns on", async (t) => {
  const { env, rooms } = environment();
  assert.equal(await status(env, "/api/state/newstreamer"), 403, "not on before sign-up");
  const r = await login(env, "signup=1");
  assert.equal(r.status, 302);
  const asked = new URL(must(r.headers.get("Location"))).searchParams;
  assert.equal(asked.get("scope"), "moderation:read");
  assert.equal(asked.get("force_verify"), "true", "sign-up shows the account picker");
  const done = await signUp(t, env, STREAMER);
  assert.equal(done.status, 303);
  assert.equal(done.headers.get("Location"), BACK);
  assert.match(must(done.headers.get("Set-Cookie")), /mini_session=[a-f0-9]{64}/);
  const channel = await record(env, "channel:newstreamer");
  assert.deepEqual([channel.id, channel.login], ["55", "newstreamer"]);
  assert.ok(await record(env, "broadcaster:newstreamer"), "mods can be checked");
  assert.equal(await status(env, "/api/state/newstreamer"), 200);
  assert.equal(must(rooms.at(-1)).channel, "newstreamer");
  // signing up again keeps the first record
  assert.equal(await where(t, env, STREAMER), BACK);
  assert.equal((await record(env, "channel:newstreamer")).enabledAt, channel.enabledAt);
});

test("a renamed Twitch name: the new holder of the login gets no say over the old channel and cannot sign up over it", async (t) => {
  const { env, ctx } = environment();
  assert.equal((await signUp(t, env, STREAMER)).status, 303);
  const newcomer = { id: "77", login: "newstreamer", displayName: "newstreamer" };
  const cookie = await signIn(env, newcomer);
  const mock = twitch(t, newcomer, []); // Helix: not a moderator of the old channel
  assert.deepEqual((await call(env, "/api/access/newstreamer", "GET", undefined, cookie)).body, {
    owner: false,
    moderator: false,
    canManage: false,
    reason: "Current Twitch moderator role required",
  });
  assert.equal(await status(env, "/api/admin/newstreamer", "POST", { action: "pauseChannel" }, cookie), 403);
  mock.mock.restore();
  assert.equal(await where(t, env, newcomer), "/start/?error=taken");
  assert.equal(
    (await record(env, "channel:newstreamer")).id,
    "55",
    "the channel stays with the account that set it up",
  );
  // the original account, still signed in under its id, keeps the channel
  const original = await signIn(env, STREAMER);
  assert.equal((await call(env, "/api/access/newstreamer", "GET", undefined, original)).body.broadcaster, true);
  // the cleanup alarm is set once, not pushed back by every write
  const first = ctx.storage.alarm;
  assert.ok((first as number) > Date.now()); // null fails the comparison, as it did before types
  await new Promise((r) => setTimeout(r, 5));
  await record(env, "session:x", { user: STREAMER }, Date.now() + 60000);
  assert.equal(ctx.storage.alarm, first);
});

test("sign-up on a bot site also asks for channel:bot and comes back with bot=allowed only when it was granted", async (t) => {
  const { env } = environment();
  env.CHAT_BOT = "1";
  env.BOT_LOGIN = "pixfray";
  assert.equal((await loginParams(env, "signup=1")).get("scope"), "moderation:read channel:bot");
  assert.equal(
    await where(t, env, STREAMER, ["moderation:read", "channel:bot"]),
    "/admin/?channel=newstreamer&signed_in=1&bot=allowed#chat",
  );
  // Twitch handed back moderation:read alone: no bot flag, the page shows the Add the PixFray bot step
  assert.equal(await where(t, env, STREAMER), BACK);
  assert.equal((await loginParams(env, "signup=1&mods=0")).get("scope"), "", "mods=0 asks for neither");
});

test("sign-up without mod access (mods=0) asks for no scope and stores no broadcaster token", async (t) => {
  const { env } = environment();
  assert.equal((await loginParams(env, "signup=1&mods=0")).get("scope"), "");
  assert.equal((await signUp(t, env, STREAMER, [], "signup=1&mods=0")).status, 303);
  assert.ok(await record(env, "channel:newstreamer"));
  assert.equal(await record(env, "broadcaster:newstreamer"), null);
});

test("a cancelled consent goes back to /start with no channel and no session", async () => {
  const { env } = environment();
  const state = (await loginParams(env, "signup=1")).get("state");
  const denied = await callback(env, state, "error=access_denied&error_description=x");
  assert.equal(denied.headers.get("Location"), "/start/?error=denied");
  noSession(denied);
  assert.equal(await record(env, "channel:newstreamer"), null);
});

test("a built-in channel signing up stays built in", async (t) => {
  const { env } = environment();
  const mio = { id: "2", login: "miolafff", displayName: "miolafff" };
  assert.equal(await where(t, env, mio), "/admin/?channel=miolafff&signed_in=1#chat");
  assert.equal(await record(env, "channel:miolafff"), null);
});

test("sign-up: a Twitch account under 30 days old or that never streamed waits, off, for the owner to approve it", async (t) => {
  const { env } = environment();
  const young = { ...STREAMER, createdAt: new Date(Date.now() - 5 * DAY).toISOString(), videos: 0 };
  const r = await signUp(t, env, young);
  assert.equal(r.headers.get("Location"), "/start/?error=review");
  noSession(r);
  assert.equal(await record(env, "broadcaster:newstreamer"), null, "no mod access until approved");
  const rec = await record(env, "channel:newstreamer");
  assert.deepEqual(rec.review.reasons, ["young", "never_streamed"]);
  assert.equal(rec.pausedBy, "owner");
  assert.equal(await status(env, "/api/state/newstreamer"), 403, "off while it waits");
  // signing in again still waits, even once the account would pass
  assert.equal(await where(t, env, STREAMER), "/start/?error=review");
  // the owner sees why on the owner page and turns it on, which approves it
  const owner = await signIn(env, OWNER);
  const list = (await call(env, "/api/dev/channels", "GET", undefined, owner)).body;
  assert.deepEqual(list.channels.find((c: { login: string }) => c.login === "newstreamer").review.reasons, [
    "young",
    "never_streamed",
  ]);
  assert.equal(await status(env, "/api/dev/channels", "POST", { action: "resume", login: "newstreamer" }, owner), 200);
  const approved = await record(env, "channel:newstreamer");
  assert.equal(approved.review, undefined);
  assert.equal(approved.pausedAt, undefined);
  assert.equal(await where(t, env, STREAMER), BACK);
});

test("the streamer check: Affiliates and Partners skip the past-broadcast lookup; a failed lookup goes to review", async () => {
  // the identities below hold only the fields reviewReasons reads (id, created_at, broadcaster_type)
  const { reviewReasons } = (await import("../server/channels.ts")) as {
    reviewReasons: (
      identity: Partial<HelixUser>,
      helix: (path: string) => Promise<HelixPage | null | undefined>,
      now?: number,
    ) => Promise<string[]>;
  };
  const now = Date.parse("2026-10-07T00:00:00Z"),
    old = "2025-01-01T00:00:00Z";
  const never = () => {
    throw new Error("not asked");
  };
  const down = async () => {
    throw new Error("503");
  };
  const cases: [identity: Partial<HelixUser>, helix: () => Promise<HelixPage>, reasons: string[], why: string][] = [
    [{ created_at: old, broadcaster_type: "affiliate" }, never, [], "affiliate"],
    [{ created_at: old, broadcaster_type: "partner" }, never, [], "partner"],
    [{ created_at: old, broadcaster_type: "" }, async () => ({ data: [{}] }), [], "streamed before"],
    [{ created_at: old, broadcaster_type: "" }, async () => ({ data: [] }), ["never_streamed"], "never streamed"],
    [{ created_at: old, broadcaster_type: "" }, down, ["unchecked"], "lookup failed"],
    [{ created_at: "2026-09-20T00:00:00Z", broadcaster_type: "affiliate" }, never, ["young"], "young"],
    [{ broadcaster_type: "partner" }, never, ["young"], "no creation date counts as young"],
  ];
  for (const [identity, helix, reasons, why] of cases)
    assert.deepEqual(await reviewReasons({ id: "5", ...identity }, helix, now), reasons, why);
});

test(`the registry is capped at ${MAX_CHANNELS} channels that are on`, async (t) => {
  const { env } = environment();
  for (let i = 0; i < MAX_CHANNELS; i++) await enable(env, "filler" + i, String(1000 + i));
  const full = await signUp(t, env, STREAMER);
  assert.equal(full.headers.get("Location"), "/start/?error=full");
  noSession(full);
  assert.equal(await record(env, "channel:newstreamer"), null);
  assert.equal(await isFull(env), true, "the /play/ search stops inviting (picker full)");
});

test("turning a channel off keeps its admin page; overlay feed, viewer page and commands say it is off", async () => {
  const { env } = environment();
  await enable(env, "newstreamer", "55");
  const streamer = await signIn(env, STREAMER),
    viewer = await signIn(env, VIEWER9),
    action = (cookie: string, name: string, channel = "newstreamer") =>
      call(env, "/api/admin/" + channel, "POST", { action: name }, cookie),
    seText = async (channel: string) => (await worker.fetch(req(`/api/se/${channel}/help?k=${SE_KEY}`), env)).text();
  assert.equal((await action(viewer, "pauseChannel")).status, 403);
  assert.deepEqual((await action(streamer, "pauseChannel")).body, { ok: true, channelState: "paused" });
  assert.ok((await record(env, "channel:newstreamer")).pausedAt > 0);
  assert.deepEqual(await call(env, "/api/state/newstreamer"), {
    status: 403,
    body: { error: "PixFray is off on this channel right now", off: "paused" },
  });
  assert.equal(await status(env, "/api/looks/newstreamer?u=a"), 403);
  assert.equal(await seText("newstreamer"), OFF_TEXT);
  const cases: [method: string, path: string, data: object | undefined, code: number, why: string][] = [
    ["GET", "leaderboard", undefined, 200, "the leaderboard stays readable"],
    ["GET", "shop", undefined, 200, "the shop list stays readable"],
    ["POST", "shop", { kind: "pet", id: "fox" }, 403, "buying is closed"],
    ["POST", "profile", { avatar: "player" }, 403, "saving is closed"],
  ];
  for (const [method, path, data, code, why] of cases)
    assert.equal(await status(env, `/api/${path}/newstreamer`, method, data, viewer), code, why);
  assert.notEqual(
    await status(env, "/api/profile/newstreamer", "GET", undefined, viewer),
    403,
    "the saved fighter stays readable",
  );
  const admin = await call(env, "/api/admin/newstreamer", "GET", undefined, streamer);
  assert.deepEqual([admin.status, admin.body.channelState], [200, "paused"]);
  // the broadcaster can still sign in to turn it back on
  assert.equal((await login(env, "channel=newstreamer&next=/admin/")).status, 302);
  await action(streamer, "resumeChannel");
  assert.equal(await status(env, "/api/state/newstreamer"), 200);
  assert.equal(await seText("newstreamer"), "room answered");
  // built-ins are always on; channels never set up stay closed
  assert.equal((await action(await signIn(env, OWNER), "pauseChannel", "miolafff")).status, 400);
  assert.deepEqual((await call(env, "/api/state/nobodyhere")).body, {
    error: "PixFray is not enabled for this channel",
    off: "not_enabled",
  });
  assert.equal(await status(env, `/api/se/nobodyhere/help?k=${SE_KEY}`), 404);
  assert.equal((await login(env, "channel=nobodyhere")).status, 403);
});

test("owner Channels box: list, turn a channel off and on; the owner's off sticks", async () => {
  const { env } = environment();
  await enable(env, "live1", "5", 2);
  const owner = await signIn(env, OWNER),
    streamer = await signIn(env, { id: "5", login: "live1", displayName: "live1" });
  const post = async (data: object) => (await call(env, "/api/dev/channels", "POST", data, owner)).body;
  const list = (await call(env, "/api/dev/channels", "GET", undefined, owner)).body;
  assert.deepEqual(list.builtin, ["nesszerra", "miolafff"]);
  assert.deepEqual(list.channels, [{ login: "live1", enabledAt: 2, pausedAt: 0, pausedBy: "" }]);
  assert.equal("invites" in list, false);
  const off = await post({ action: "pause", login: "live1" });
  assert.deepEqual([off.channels[0].pausedAt > 0, off.channels[0].pausedBy], [true, "owner"]);
  assert.equal(await status(env, "/api/state/live1"), 403);
  // the streamer can't undo the owner's off
  const refused = await call(env, "/api/admin/live1", "POST", { action: "resumeChannel" }, streamer);
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /site owner turned PixFray off/);
  assert.equal(refused.body.reason, "owner_off");
  assert.equal((await post({ action: "resume", login: "live1" })).channels[0].pausedAt, 0);
  assert.equal(await status(env, "/api/state/live1"), 200);
  assert.equal((await post({ action: "invite", login: "someone" })).reason, "unknown_action");
  assert.equal(await status(env, "/api/invite/" + "f".repeat(32)), 404, "the invite lookup is gone");
});

test("connect=mods: only the broadcaster can store the mod-list permission later", async (t) => {
  const { env } = environment(),
    query = "channel=newstreamer&connect=mods";
  await enable(env, "newstreamer", "55");
  assert.equal((await loginParams(env, query)).get("scope"), "moderation:read");
  assert.equal(
    await where(t, env, VIEWER9, ["moderation:read"], query),
    "/admin/?channel=newstreamer&mods=wrong_account#chat",
  );
  assert.equal(await record(env, "broadcaster:newstreamer"), null);
  assert.equal(
    await where(t, env, STREAMER, ["moderation:read"], query),
    "/admin/?channel=newstreamer&signed_in=1&mods=connected#chat",
  );
  assert.ok(await record(env, "broadcaster:newstreamer"));
});
