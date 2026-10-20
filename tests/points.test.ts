// Channel point rewards (server/points.ts): signed redemptions through handleEventsub into a real room on node:sqlite,
// and the admin actions through the Worker with Twitch mocked.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import worker from "../server/worker.ts";
import { AuthStore, digest, record, seal, handleAuth, POINTS_SCOPE } from "../server/auth.ts";
import { forgetChannel } from "../server/channels.ts";
import { eventsubSecret, handleEventsub, signEventsub } from "../server/eventsub.ts";
import { ensurePointsSchema, handleRoomPoints, REDEMPTION_TYPE } from "../server/points.ts";
import type { Redemption } from "../server/points.ts";
import { ensureDeveloperSchema } from "../server/developer.ts";
import { ensureTrackerSchema, readCounts } from "../server/tracker.ts";
import type { Env } from "../server/env.ts";
import { asEnv, fakeCtx, type FakeSql } from "./fakes.ts";

const ORIGIN = "https://staging.pixfray.xyz",
  NOW = 1_800_000_000_000;

function pointsRoom() {
  const ctx = fakeCtx(),
    sql = ctx.storage.sql;
  sql.exec("CREATE TABLE profiles (user_id TEXT PRIMARY KEY, username TEXT NOT NULL, dollars INTEGER NOT NULL)");
  ensureDeveloperSchema(sql);
  ensureTrackerSchema(sql);
  ensurePointsSchema(sql);
  const room = { ctx };
  const call = (channel: string, path: string, init: RequestInit = {}) =>
    handleRoomPoints(room, new Request("https://room" + path, init), { path, channel, maxDollars: 1_000_000 });
  const wallet = (userId: string) =>
    sql.exec<{ dollars: number }>("SELECT dollars FROM profiles WHERE user_id = ?", userId).toArray()[0]?.dollars;
  return { room, sql, call, wallet };
}
const post = (body: object): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const REWARD = {
  rewardId: "rw1",
  title: "PixFray $50",
  cost: 500,
  dollars: 50,
  subscriptionId: "sub1",
  status: "enabled",
  createdAt: 1,
};
const env = asEnv({ AUTH_SECRET: "test-only-auth-key", INTERNAL_SECRET: "test-only-internal-key" });

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

function eventsub(r: ReturnType<typeof pointsRoom>) {
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
  return { done, paths, deliver };
}

test("a redemption adds the reward's dollars once, even when Twitch retries it", async () => {
  const r = pointsRoom(),
    e = eventsub(r);
  r.sql.exec("INSERT INTO profiles VALUES ('7', 'viewer', 100)");
  assert.equal((await r.call("newstreamer", "/points/rewards", post({ op: "add", reward: REWARD }))).status, 200);
  const first = await e.deliver("notification", { subscription, event: redemption("red-1") });
  const retry = await e.deliver("notification", { subscription, event: redemption("red-1") });
  assert.deepEqual([first.status, retry.status], [204, 204]);
  assert.equal(r.wallet("7"), 150);
  assert.equal(e.done.length, 1, "the retry marks nothing and posts nothing");
  assert.equal(e.done[0]?.mark, "FULFILLED");
  assert.equal(e.done[0]?.reply, "@Viewer got $50 PixFray dollars from PixFray $50. Wallet: $150.");
  assert.equal(readCounts(r.room)[0]?.counts.points_granted, 1);
});

test("a reward PixFray doesn't hold is ignored: no dollars, no mark", async () => {
  const r = pointsRoom(),
    e = eventsub(r);
  r.sql.exec("INSERT INTO profiles VALUES ('7', 'viewer', 100)");
  const res = await e.deliver("notification", {
    subscription,
    event: redemption("red-2", { reward: { id: "other", title: "Hydrate", cost: 100 } }),
  });
  assert.equal(res.status, 204);
  assert.equal(r.wallet("7"), 100);
  assert.deepEqual(e.done, []);
});

test("a viewer with no fighter gets their points back and a line that differs per redemption", async () => {
  const r = pointsRoom(),
    e = eventsub(r);
  await r.call("newstreamer", "/points/rewards", post({ op: "add", reward: REWARD }));
  await e.deliver("notification", { subscription, event: redemption("red-aaaa") });
  await e.deliver("notification", { subscription, event: redemption("red-bbbb") });
  assert.deepEqual(
    e.done.map((d) => [d.mark, d.reply]),
    [
      [
        "CANCELED",
        `@Viewer needs a saved fighter first: make one at ${ORIGIN}/?channel=newstreamer. Your channel points were refunded (redemption aaaa).`,
      ],
      [
        "CANCELED",
        `@Viewer needs a saved fighter first: make one at ${ORIGIN}/?channel=newstreamer. Your channel points were refunded (redemption bbbb).`,
      ],
    ],
  );
});

test("a wallet never passes the dollar cap", async () => {
  const r = pointsRoom(),
    e = eventsub(r);
  r.sql.exec("INSERT INTO profiles VALUES ('7', 'viewer', 999990)");
  await r.call("newstreamer", "/points/rewards", post({ op: "add", reward: REWARD }));
  await e.deliver("notification", { subscription, event: redemption("red-3") });
  assert.equal(r.wallet("7"), 1_000_000);
});

test("the redemption subscription's challenge is answered, and a revocation marks the reward", async () => {
  const r = pointsRoom(),
    e = eventsub(r);
  await r.call("newstreamer", "/points/rewards", post({ op: "add", reward: REWARD }));
  const verify = await e.deliver("webhook_callback_verification", { subscription, challenge: "abc123" });
  assert.equal(await verify.text(), "abc123");
  const revoked = await e.deliver("revocation", {
    subscription: { ...subscription, status: "authorization_revoked" },
  });
  assert.equal(revoked.status, 204);
  assert.ok(e.paths.includes("newstreamer /points/rewards"), "the broadcaster's own room hears the revocation");
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

function store(): AuthStore {
  const db = new DatabaseSync(":memory:");
  const sql: FakeSql = {
    exec(q: string, ...p: SQLInputValue[]) {
      const rows = db
        .prepare(q)
        .all(...p)
        .map((x) => ({ ...x }));
      return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  };
  let alarm: number | null = null;
  const ctx = {
    storage: {
      sql,
      getAlarm: async () => alarm,
      setAlarm: async (t: number) => void (alarm = t),
    },
  };
  // the fake context has only the sql and alarm calls AuthStore makes
  return new AuthStore(ctx as unknown as DurableObjectState, asEnv({ INTERNAL_SECRET: "test-only-internal-key" }));
}
async function site(t: TestContext, { scopes = ["moderation:read", POINTS_SCOPE] } = {}) {
  forgetChannel();
  t.mock.method(Date, "now", () => NOW);
  const auth = store(),
    r = pointsRoom();
  const e = {
    AUTH_SECRET: "test-only-auth-key",
    INTERNAL_SECRET: "test-only-internal-key",
    OWNER_TWITCH_ID: "1",
    TWITCH_CLIENT_ID: "test-app",
    TWITCH_CLIENT_SECRET: "test-secret",
    PUBLIC_ORIGIN: ORIGIN,
    AUTH: {
      idFromName: (x: string) => x,
      get: () => ({ fetch: (u: string, i?: RequestInit) => auth.fetch(new Request(u, i)) }),
    },
    ROOMS: {
      idFromName: (x: string) => x,
      get: (channel: string) => ({
        async fetch(url: string, init?: RequestInit) {
          const path = new URL(url).pathname;
          return path.startsWith("/points") ? r.call(channel, path, init) : Response.json({});
        },
      }),
    },
    ASSETS: { fetch: async () => new Response("page") },
  };
  const env = e as typeof e & Env; // a partial Env: the bindings worker.fetch reads
  await record(env, "channel:newstreamer", { id: "55", login: "newstreamer", enabledAt: 1 }, NOW + 86400000);
  await record(
    env,
    "broadcaster:newstreamer",
    await seal(env, { access_token: "a1", refresh_token: "r1", userId: "55", scopes, validatedAt: NOW }),
    NOW + 86400000,
  );
  const cookie = async (id: string, login: string) => {
    const key = id.padStart(64, "c");
    await record(env, "session:" + (await digest(key)), { user: { id, login, displayName: login } }, NOW + 3600000);
    return "mini_session=" + key;
  };
  const admin = (data: object, c: string) =>
    worker.fetch(
      new Request(ORIGIN + "/api/admin/newstreamer", {
        method: "POST",
        headers: { Cookie: c, Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
      env,
    );
  return { env, r, cookie, admin };
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
  assert.deepEqual(await res.json(), {
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
  assert.equal((await mod.json<{ reason: string }>()).reason, "broadcaster_only");
  const res = await s.admin(CREATE, await s.cookie("55", "newstreamer"));
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), {
    error: "newstreamer must allow channel point rewards at /auth/login?channel=newstreamer&connect=points",
    reason: "points_not_connected",
    reconnect: "/auth/login?channel=newstreamer&connect=points",
  });
});

test("a new reward is subscribed to, and removed again when Twitch refuses the subscription", async (t) => {
  const s = await site(t),
    calls: string[] = [];
  let subscribe = 202;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init: { method?: string; body?: string } = {}) => {
      const u = String(url).replace("https://api.twitch.tv/helix", "");
      calls.push((init.method || "GET") + " " + u.split("?")[0]);
      if (u.startsWith("/channel_points/custom_rewards") && init.method === "POST") {
        assert.deepEqual(JSON.parse(String(init.body)), {
          title: "PixFray $50",
          cost: 500,
          prompt: "Adds $50 PixFray dollars to your fighter. Save a fighter first, or your points come back.",
          should_redemptions_skip_request_queue: false,
        });
        return Response.json({ data: [{ id: "rw-new" }] });
      }
      if (u.startsWith("/channel_points/custom_rewards") && init.method === "DELETE")
        return new Response(null, { status: 204 });
      if (u.endsWith("/oauth2/token")) return Response.json({ access_token: "app", expires_in: 3600 });
      if (u.startsWith("/eventsub/subscriptions")) {
        const body = JSON.parse(String(init.body));
        assert.deepEqual(
          [body.type, body.condition, body.transport.callback],
          [REDEMPTION_TYPE, { broadcaster_user_id: "55", reward_id: "rw-new" }, ORIGIN + "/api/eventsub"],
        );
        return subscribe === 202
          ? Response.json(
              { data: [{ id: "sub-new", status: "webhook_callback_verification_pending" }] },
              { status: 202 },
            )
          : new Response("no", { status: subscribe });
      }
      throw new Error("unexpected fetch " + u);
    },
  );
  const streamer = await s.cookie("55", "newstreamer");
  const made = await s.admin(CREATE, streamer);
  assert.equal(made.status, 200);
  assert.deepEqual(
    (await made.json<{ rewards: { rewardId: string; subscriptionId: string }[] }>()).rewards.map((x) => [
      x.rewardId,
      x.subscriptionId,
    ]),
    [["rw-new", "sub-new"]],
  );
  subscribe = 409;
  calls.length = 0;
  const refused = await s.admin(CREATE, streamer);
  assert.equal(refused.status, 502);
  assert.ok(calls.includes("DELETE /channel_points/custom_rewards"), "the orphan reward is deleted");
});

test("the points sign-in asks for the earlier scopes plus channel:manage:redemptions", async () => {
  forgetChannel();
  const auth = store();
  const e = {
    AUTH_SECRET: "test-only-auth-key",
    INTERNAL_SECRET: "test-only-internal-key",
    TWITCH_CLIENT_ID: "test-app",
    TWITCH_CLIENT_SECRET: "test-secret",
    CHAT_BOT: "1",
    AUTH: {
      idFromName: (x: string) => x,
      get: () => ({ fetch: (u: string, i?: RequestInit) => auth.fetch(new Request(u, i)) }),
    },
  };
  const env = e as typeof e & Env; // the bindings handleAuth reads
  await record(env, "channel:newstreamer", { id: "55", login: "newstreamer", enabledAt: 1 }, Date.now() + 86400000);
  const res = await handleAuth(new Request(ORIGIN + "/auth/login?channel=newstreamer&connect=points"), env);
  const to = new URL(String(res.headers.get("Location")));
  assert.equal(to.searchParams.get("scope"), "moderation:read channel:bot channel:manage:redemptions");
});
