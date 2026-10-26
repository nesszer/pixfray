// Channel point rewards (server/points.ts): signed redemptions through handleEventsub into a real room on node:sqlite,
// and the admin actions through the Worker with Twitch mocked.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { record, seal, handleAuth, POINTS_SCOPE } from "../server/auth.ts";
import { forgetChannel } from "../server/channels.ts";
import { eventsubSecret, handleEventsub, signEventsub } from "../server/eventsub.ts";
import { ensurePointsSchema, handleRoomPoints, REDEMPTION_TYPE } from "../server/points.ts";
import type { PointReward, Redemption } from "../server/points.ts";
import { ensureDeveloperSchema } from "../server/developer.ts";
import { ensureTrackerSchema, readCounts } from "../server/tracker.ts";
import { postJson } from "../server/http.ts";
import { asEnv, fakeCtx } from "./fakes.ts";
import { call, namespace, ORIGIN, SECRETS, signIn, sqliteAuth, twitchApi } from "./worker-fakes.ts";

const NOW = 1_800_000_000_000;

function pointsRoom() {
  const ctx = fakeCtx(),
    sql = ctx.storage.sql;
  sql.exec(
    "CREATE TABLE profiles (user_id TEXT PRIMARY KEY, username TEXT NOT NULL, dollars INTEGER NOT NULL, style_dollars INTEGER NOT NULL DEFAULT 0)",
  );
  ensureDeveloperSchema(sql);
  ensureTrackerSchema(sql);
  ensurePointsSchema(sql);
  const room = { ctx };
  const call = (channel: string, path: string, init: RequestInit = {}) =>
    handleRoomPoints(room, new Request("https://room" + path, init), { path, channel, maxDollars: 1_000_000 });
  const wallet = (userId: string) =>
    sql
      .exec<{ dollars: number; style: number }>(
        "SELECT dollars, style_dollars AS style FROM profiles WHERE user_id = ?",
        userId,
      )
      .toArray()[0];
  return { room, sql, call, wallet };
}
const REWARD = {
  rewardId: "rw1",
  title: "PixFray $50",
  cost: 500,
  dollars: 50,
  subscriptionId: "sub1",
  status: "enabled",
  createdAt: 1,
};
const env = asEnv(SECRETS);

function redemption(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    broadcaster_user_id: "55",
    broadcaster_user_login: "newstreamer",
    broadcaster_user_name: "NewStreamer",
    user_id: "7",
    user_login: "viewer",
    user_name: "Viewer",
    user_input: "",
    status: "unfulfilled",
    redeemed_at: "2027-01-15T08:00:00Z",
    reward: { id: "rw1", title: "PixFray $50", cost: 500, prompt: "" },
    ...over,
  };
}
async function signed(type: string, body: object) {
  const raw = JSON.stringify(body),
    id = "m-" + Math.random(),
    timestamp = new Date(NOW).toISOString();
  return new Request(ORIGIN + "/api/eventsub", {
    method: "POST",
    headers: {
      "Twitch-Eventsub-Message-Id": id,
      "Twitch-Eventsub-Message-Timestamp": timestamp,
      "Twitch-Eventsub-Message-Signature": await signEventsub(await eventsubSecret(env), id, timestamp, raw),
      "Twitch-Eventsub-Message-Type": type,
      "Twitch-Eventsub-Subscription-Type": REDEMPTION_TYPE,
    },
    body: raw,
  });
}
const subscription = { id: "sub1", status: "enabled", condition: { broadcaster_user_id: "55", reward_id: "rw1" } };

/** A room hooked to eventsub, with the reward added unless `reward` is false and a profile row when `wallet` is given. */
async function redeemRoom(wallet = "", reward = true) {
  const r = pointsRoom();
  const done: { redemption: Redemption; mark: string | null; reply: string }[] = [],
    paths: string[] = [];
  const deliver = async (type: string, body: object) =>
    handleEventsub(await signed(type, body), env, {
      channels: ["nesszers"],
      roomFetch: (channel, path, init) => {
        paths.push(channel + " " + path);
        return r.call(channel, path, init);
      },
      origin: () => ORIGIN,
      findChannel: async (id) => (id === "55" ? "newstreamer" : ""),
      onRedeemed: (d) => done.push(d),
      now: NOW,
    });
  if (wallet)
    r.sql.exec(`INSERT INTO profiles (user_id, username, dollars, style_dollars) VALUES ('7', 'viewer', ${wallet})`);
  if (reward)
    assert.equal((await r.call("newstreamer", "/points/rewards", postJson({ op: "add", reward: REWARD }))).status, 200);
  const redeem = (id: string, over?: Record<string, unknown>) =>
    deliver("notification", { subscription, event: redemption(id, over) });
  return { r, done, paths, deliver, redeem };
}

test("a redemption adds the reward's dollars to style dollars once, even when Twitch retries it; duel dollars stay", async () => {
  const { r, done, redeem } = await redeemRoom("100, 0");
  const first = await redeem("red-1");
  const retry = await redeem("red-1");
  assert.deepEqual([first.status, retry.status], [204, 204]);
  assert.deepEqual({ ...r.wallet("7") }, { dollars: 100, style: 50 });
  assert.equal(done.length, 1, "the retry marks nothing and posts nothing");
  assert.equal(done[0]?.mark, "FULFILLED");
  assert.equal(
    done[0]?.reply,
    "@Viewer got $50 style dollars from PixFray $50 for looks, hats and build slots. Style: $50.",
  );
  assert.equal(readCounts(r.room)[0]?.counts.points_granted, 1);
});

test("a reward PixFray doesn't hold is ignored: no dollars, no mark", async () => {
  const { r, done, redeem } = await redeemRoom("100, 0", false);
  const res = await redeem("red-2", { reward: { id: "other", title: "Hydrate", cost: 100 } });
  assert.equal(res.status, 204);
  assert.deepEqual({ ...r.wallet("7") }, { dollars: 100, style: 0 });
  assert.deepEqual(done, []);
});

test("a viewer with no fighter gets their points back and a line that differs per redemption", async () => {
  const { done, redeem } = await redeemRoom();
  await redeem("red-aaaa");
  await redeem("red-bbbb");
  const refunded = (id: string) => [
    "CANCELED",
    `@Viewer needs a saved fighter first: make one at ${ORIGIN}/?channel=newstreamer. Your channel points were refunded (redemption ${id}).`,
  ];
  const marks = done.map((d) => [d.mark, d.reply]);
  assert.deepEqual(marks, [refunded("aaaa"), refunded("bbbb")]);
});

test("style dollars never pass the dollar cap", async () => {
  const { r, redeem } = await redeemRoom("5, 999990");
  await redeem("red-3");
  assert.deepEqual({ ...r.wallet("7") }, { dollars: 5, style: 1_000_000 });
});

test("the redemption subscription's challenge is answered, and a revocation marks the reward", async () => {
  const { r, paths, deliver } = await redeemRoom();
  const verify = await deliver("webhook_callback_verification", { subscription, challenge: "abc123" });
  assert.equal(await verify.text(), "abc123");
  const revoked = await deliver("revocation", { subscription: { ...subscription, status: "authorization_revoked" } });
  assert.equal(revoked.status, 204);
  assert.ok(paths.includes("newstreamer /points/rewards"), "the broadcaster's own room hears the revocation");
  const view = await (await r.call("newstreamer", "/points")).json<{ rewards: { status: string }[] }>();
  assert.equal(view.rewards[0]?.status, "authorization_revoked");
});

test("a room failure fails the delivery, so Twitch retries it", async () => {
  await assert.rejects(
    handleEventsub(await signed("notification", { subscription, event: redemption("red-4") }), env, {
      channels: [],
      roomFetch: async () => new Response("down", { status: 500 }),
      now: NOW,
    }),
    /Room rejected redemption \(500\)/,
  );
});

// ---------- Admin actions through the Worker ----------

async function site(t: TestContext, { scopes = ["moderation:read", POINTS_SCOPE] } = {}) {
  forgetChannel();
  t.mock.method(Date, "now", () => NOW);
  const r = pointsRoom();
  const ROOMS = namespace(async (channel, url, init) => {
    const path = new URL(url).pathname;
    return path.startsWith("/points") ? r.call(channel, path, init) : Response.json({});
  });
  const ASSETS = { fetch: async () => new Response("page") };
  const env = asEnv({
    ...SECRETS,
    OWNER_TWITCH_ID: "1",
    PUBLIC_ORIGIN: ORIGIN,
    AUTH: sqliteAuth().AUTH,
    ROOMS,
    ASSETS,
  });
  await record(env, "channel:newstreamer", { id: "55", login: "newstreamer", enabledAt: 1 }, NOW + 86400000);
  const token = { access_token: "a1", refresh_token: "r1", userId: "55", scopes, validatedAt: NOW };
  await record(env, "broadcaster:newstreamer", await seal(env, token), NOW + 86400000);
  return {
    cookie: (id: string, login: string) => signIn(env, { id, login, displayName: login }),
    admin: (data: object, cookie: string) => call(env, "/api/admin/newstreamer", "POST", data, cookie),
  };
}
const CREATE = { action: "createPointReward", payload: { title: "PixFray $50", cost: 500, dollars: 50 } };

test("a channel that isn't an Affiliate hears so in plain words when it makes a reward", async (t) => {
  const s = await site(t);
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (String(url).includes("/helix/channel_points/custom_rewards")) return new Response("forbidden", { status: 403 });
    throw new Error("unexpected fetch " + url);
  });
  const res = await s.admin(CREATE, await s.cookie("55", "newstreamer"));
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, {
    error: "Twitch only gives channel points to Affiliates and Partners, and newstreamer is neither yet.",
    reason: "points_not_affiliate",
  });
});

test("rewards need the broadcaster's points sign-in, and only the broadcaster or the owner can make one", async (t) => {
  const s = await site(t, { scopes: ["moderation:read"] });
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (String(url).includes("/helix/moderation/moderators")) return Response.json({ data: [{ user_id: "9" }] });
    throw new Error("unexpected fetch " + url);
  });
  const mod = await s.admin(CREATE, await s.cookie("9", "amod"));
  assert.equal(mod.status, 403);
  assert.equal(mod.body.reason, "broadcaster_only");
  const res = await s.admin(CREATE, await s.cookie("55", "newstreamer"));
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, {
    error: "newstreamer must allow channel point rewards at /auth/login?channel=newstreamer&connect=points",
    reason: "points_not_connected",
    reconnect: "/auth/login?channel=newstreamer&connect=points",
  });
});

test("a new reward is subscribed to, and removed again when Twitch refuses the subscription", async (t) => {
  const s = await site(t),
    calls: string[] = [];
  let subscribe = 202;
  twitchApi(t, async (url, init) => {
    const u = url.pathname.replace("/helix", "");
    calls.push((init.method || "GET") + " " + u);
    if (u === "/channel_points/custom_rewards" && init.method === "POST") {
      assert.deepEqual(JSON.parse(String(init.body)), {
        title: "PixFray $50",
        cost: 500,
        prompt:
          "Adds $50 style dollars for looks, hats and build slots (not pets). Save a fighter first, or your points come back.",
        should_redemptions_skip_request_queue: false,
      });
      return Response.json({ data: [{ id: "rw-new" }] });
    }
    if (u === "/channel_points/custom_rewards" && init.method === "DELETE") return new Response(null, { status: 204 });
    if (u === "/eventsub/subscriptions") {
      const body = JSON.parse(String(init.body));
      assert.deepEqual(
        [body.type, body.condition, body.transport.callback],
        [REDEMPTION_TYPE, { broadcaster_user_id: "55", reward_id: "rw-new" }, ORIGIN + "/api/eventsub"],
      );
      return subscribe === 202
        ? Response.json({ data: [{ id: "sub-new", status: "webhook_callback_verification_pending" }] }, { status: 202 })
        : new Response("no", { status: subscribe });
    }
    throw new Error("unexpected fetch " + url);
  });
  const streamer = await s.cookie("55", "newstreamer");
  const made = await s.admin(CREATE, streamer);
  assert.equal(made.status, 200);
  const ids = made.body.rewards.map((x: PointReward) => [x.rewardId, x.subscriptionId]);
  assert.deepEqual(ids, [["rw-new", "sub-new"]]);
  subscribe = 409;
  calls.length = 0;
  const refused = await s.admin(CREATE, streamer);
  assert.equal(refused.status, 502);
  assert.ok(calls.includes("DELETE /channel_points/custom_rewards"), "the orphan reward is deleted");
});

test("the points sign-in asks for the earlier scopes plus channel:manage:redemptions", async () => {
  forgetChannel();
  const env = asEnv({ ...SECRETS, CHAT_BOT: "1", AUTH: sqliteAuth().AUTH });
  await record(env, "channel:newstreamer", { id: "55", login: "newstreamer", enabledAt: 1 }, Date.now() + 86400000);
  const res = await handleAuth(new Request(ORIGIN + "/auth/login?channel=newstreamer&connect=points"), env);
  const to = new URL(String(res.headers.get("Location")));
  assert.equal(to.searchParams.get("scope"), "moderation:read channel:bot channel:manage:redemptions");
});
