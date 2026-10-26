// Twitch channel point rewards that add style dollars (docs/CONTRACTS.md §2, §4, §7). The broadcaster allows it once
// at /auth/login?channel=<login>&connect=points (channel:manage:redemptions). PixFray creates each reward with the
// broadcaster's token, so only PixFray can fulfil, refund or delete it, and subscribes to that reward's redemptions.
// A redemption adds the reward's dollars to the viewer's style balance (profiles.style_dollars: looks and build slots,
// never pets, never moved by !give) and is marked FULFILLED; with no fighter it is CANCELED, which gives the viewer
// their points back.
import { openBroadcaster, POINTS_SCOPE, randomToken } from "./auth.ts";
import { appHelix, deleteSubscription, eventsubSecret, localTestMode, EVENTSUB_PATH } from "./eventsub.ts";
import { logRoomEvent } from "./developer.ts";
import { count } from "./tracker.ts";
import { isObject } from "./parse.ts";
import type { JsonObject } from "./parse.ts";
import type { Env } from "./env.ts";

export const REDEMPTION_TYPE = "channel.channel_points_custom_reward_redemption.add";
/** Rewards one channel can have through PixFray (Twitch allows 50 of every kind). */
export const MAX_POINT_REWARDS = 5;
export const POINT_LIMITS = { titleMax: 45, costMax: 1_000_000, dollarsMax: 10_000 };
/** Redemption rows kept per room (the admin page shows the newest; ids older than this can't be retried by Twitch). */
const KEEP_REDEMPTIONS = 500;

export const pointsLoginUrl = (channel: string): string => "/auth/login?channel=" + channel + "&connect=points";

/** A reward as the room stores it and the admin page shows it. */
export type PointReward = {
  rewardId: string;
  title: string;
  cost: number;
  dollars: number;
  subscriptionId: string;
  status: string;
  createdAt: number;
};
/** What happened to one redemption. `refunded` and `granted` are marked on Twitch; the rest are not. */
export type RedeemOutcome = "granted" | "refunded" | "no_fighter" | "ignored";
/** The fields of a redemption event PixFray reads (Twitch EventSub reference, redemption add). */
export type Redemption = {
  id: string;
  broadcasterId: string;
  channel: string;
  userId: string;
  userLogin: string;
  userName: string;
  rewardId: string;
  status: string;
};

const fail = (message: string, status: number, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { status, ...extra });
const str = (v: unknown, n: number): string => (typeof v === "string" ? v.slice(0, n) : "");

/** The redemption event Twitch sent, cut to the fields PixFray reads; null without an id, user or reward. */
export function parseRedemption(ev: JsonObject | null): Redemption | null {
  if (!ev) return null;
  const reward = isObject(ev.reward) ? ev.reward : {};
  const r = {
    id: str(ev.id, 100),
    broadcasterId: str(ev.broadcaster_user_id, 100),
    channel: str(ev.broadcaster_user_login, 64).toLowerCase(),
    userId: str(ev.user_id, 100),
    userLogin: str(ev.user_login, 64),
    userName: str(ev.user_name, 100),
    rewardId: str(reward.id, 100),
    status: str(ev.status, 20),
  };
  return r.id && r.userId && r.rewardId && r.channel ? r : null;
}

/** Checks a new reward's title, cost and dollars; answers the reason code it fails with, or "". */
export function rewardProblem(title: unknown, cost: unknown, dollars: unknown): string {
  if (typeof title !== "string" || !title.trim() || title.trim().length > POINT_LIMITS.titleMax) return "invalid_title";
  if (!Number.isInteger(cost) || (cost as number) < 1 || (cost as number) > POINT_LIMITS.costMax) return "invalid_cost"; // as: checked integer
  if (!Number.isInteger(dollars) || (dollars as number) < 1 || (dollars as number) > POINT_LIMITS.dollarsMax)
    // as: checked integer
    return "invalid_dollars";
  return "";
}

// ---------- Worker side: Helix with the broadcaster's token, EventSub with the app token ----------

// The refusal that sends the streamer to the points sign-in link.
const notConnected = (channel: string) =>
  fail(channel + " must allow channel point rewards at " + pointsLoginUrl(channel), 409, {
    reason: "points_not_connected",
    reconnect: pointsLoginUrl(channel),
  });
const rewardPath = (broadcasterId: string, rewardId: string) =>
  "/channel_points/custom_rewards?broadcaster_id=" + broadcasterId + "&id=" + encodeURIComponent(rewardId);

// The broadcaster's token, refused with the points sign-in link when it is missing or lacks channel:manage:redemptions.
async function pointsToken(env: Env, channel: string) {
  // an expired or revoked token throws from the renewal or the validation; both mean sign in again
  const b = await openBroadcaster(env, channel).catch(() => null);
  if (!b) throw notConnected(channel);
  const { scopes } = await b.validate().catch(() => ({ scopes: [] as string[] }));
  if (!scopes.includes(POINTS_SCOPE)) throw notConnected(channel);
  return b;
}

/** Creates the reward on Twitch and subscribes this site to its redemptions. Undoes the reward if the subscription fails. */
export async function createReward(
  env: Env,
  {
    channel,
    title,
    cost,
    dollars,
    origin,
    url,
  }: { channel: string; title: string; cost: number; dollars: number; origin: string; url: URL },
): Promise<PointReward> {
  if (localTestMode(env, url)) {
    const id = "local-" + randomToken().slice(0, 16);
    return { rewardId: id, title, cost, dollars, subscriptionId: id, status: "enabled", createdAt: Date.now() };
  }
  if (!String(origin).startsWith("https://")) throw fail("PUBLIC_ORIGIN must be https for Twitch webhooks", 400);
  const b = await pointsToken(env, channel);
  // should_redemptions_skip_request_queue stays false: only an UNFULFILLED redemption can be refunded.
  const r = await b.helix("/channel_points/custom_rewards?broadcaster_id=" + b.userId, {
    method: "POST",
    body: JSON.stringify({
      title,
      cost,
      prompt:
        "Adds $" +
        dollars +
        " style dollars for looks, hats and build slots (not pets). Save a fighter first, or your points come back.",
      should_redemptions_skip_request_queue: false,
    }),
  });
  if (r.status === 403)
    throw fail(
      "Twitch only gives channel points to Affiliates and Partners, and " + channel + " is neither yet.",
      403,
      {
        reason: "points_not_affiliate",
      },
    );
  if (r.status === 401) throw notConnected(channel);
  if (r.status === 400) {
    const d = await r.json<{ message?: unknown }>().catch(() => ({}) as { message?: unknown });
    throw fail("Twitch refused the reward: " + String(d.message || "check the title and cost"), 400, {
      reason: "points_rejected",
    });
  }
  if (!r.ok) throw fail("Twitch reward create failed (" + r.status + ")", 502);
  const created = (await r.json<{ data?: { id?: string }[] }>()).data?.[0];
  if (!created?.id) throw fail("Twitch returned no reward", 502);
  const rewardId = created.id;
  // A new reward id has no subscription anywhere yet, so no other site can hold one.
  const s = await appHelix(env, "POST", "/eventsub/subscriptions", {
    type: REDEMPTION_TYPE,
    version: "1",
    condition: { broadcaster_user_id: b.userId, reward_id: rewardId },
    transport: { method: "webhook", callback: origin + EVENTSUB_PATH, secret: await eventsubSecret(env) },
  });
  const sub = s.ok ? (await s.json<{ data?: { id?: string; status?: string }[] }>()).data?.[0] : null;
  if (!sub?.id) {
    await b.helix(rewardPath(b.userId, rewardId), { method: "DELETE" }).catch(() => null);
    throw fail("Twitch refused the redemption subscription (" + s.status + "), so the reward was removed again", 502);
  }
  return {
    rewardId,
    title,
    cost,
    dollars,
    subscriptionId: sub.id,
    status: String(sub.status || "pending"),
    createdAt: Date.now(),
  };
}

/** Deletes the reward on Twitch (gone already is fine) and its subscription. */
export async function deleteReward(
  env: Env,
  { channel, rewardId, subscriptionId, url }: { channel: string; rewardId: string; subscriptionId: string; url: URL },
): Promise<void> {
  if (localTestMode(env, url) || rewardId.startsWith("local-")) return;
  const b = await pointsToken(env, channel);
  const r = await b.helix(rewardPath(b.userId, rewardId), { method: "DELETE" });
  if (!r.ok && r.status !== 404) throw fail("Twitch reward delete failed (" + r.status + ")", 502);
  if (subscriptionId) await deleteSubscription(env, subscriptionId);
}

/** Marks one redemption FULFILLED or CANCELED (a refund). Answers Twitch's status code; 0 when Twitch can't be reached. */
export async function markRedemption(
  env: Env,
  {
    channel,
    rewardId,
    redemptionId,
    status,
  }: { channel: string; rewardId: string; redemptionId: string; status: "FULFILLED" | "CANCELED" },
): Promise<number> {
  try {
    const b = await openBroadcaster(env, channel);
    if (!b) return 401;
    const r = await b.helix(
      "/channel_points/custom_rewards/redemptions?broadcaster_id=" +
        b.userId +
        "&reward_id=" +
        encodeURIComponent(rewardId) +
        "&id=" +
        encodeURIComponent(redemptionId),
      { method: "PATCH", body: JSON.stringify({ status }) },
    );
    return r.status;
  } catch {
    return 0;
  }
}

// ---------- Room side ----------

type Room = { ctx: DurableObjectState };
type RewardRow = {
  reward_id: string;
  title: string;
  cost: number;
  dollars: number;
  subscription_id: string;
  status: string;
  created_at: number;
};
type RedemptionRow = {
  id: string;
  at: number;
  reward_id: string;
  user_id: string;
  user_login: string;
  outcome: string;
  dollars: number;
  marked: number;
};

export function ensurePointsSchema(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS point_rewards (reward_id TEXT PRIMARY KEY, title TEXT NOT NULL, cost INTEGER NOT NULL, dollars INTEGER NOT NULL, subscription_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL)",
  );
  // id is Twitch's redemption id: a retried notification finds its row and changes nothing.
  // marked: Twitch's answer to FULFILLED or CANCELED (0 until the Worker reports it, -1 when not marked at all).
  sql.exec(
    "CREATE TABLE IF NOT EXISTS point_redemptions (id TEXT PRIMARY KEY, at INTEGER NOT NULL, reward_id TEXT NOT NULL, user_id TEXT NOT NULL, user_login TEXT NOT NULL, outcome TEXT NOT NULL, dollars INTEGER NOT NULL, marked INTEGER NOT NULL DEFAULT 0)",
  );
}

const toReward = (r: RewardRow): PointReward => ({
  rewardId: r.reward_id,
  title: r.title,
  cost: r.cost,
  dollars: r.dollars,
  subscriptionId: r.subscription_id,
  status: r.status,
  createdAt: r.created_at,
});

/** The channel's rewards and newest redemptions, for the admin page. */
export function pointsView(room: Room) {
  const sql = room.ctx.storage.sql;
  return {
    rewards: sql.exec<RewardRow>("SELECT * FROM point_rewards ORDER BY created_at").toArray().map(toReward),
    redemptions: sql
      .exec<RedemptionRow>("SELECT * FROM point_redemptions ORDER BY at DESC LIMIT 20")
      .toArray()
      .map((r) => ({
        id: r.id,
        at: r.at,
        rewardId: r.reward_id,
        user: r.user_login,
        outcome: r.outcome,
        dollars: r.dollars,
        marked: r.marked,
      })),
    limits: { ...POINT_LIMITS, maxRewards: MAX_POINT_REWARDS },
  };
}

/** The reply a redemption gets: the outcome, the line the bot posts, and how Twitch should mark it (null: leave it). */
export type RedeemReply = {
  ok: true;
  outcome: RedeemOutcome;
  repeat: boolean;
  mark: "FULFILLED" | "CANCELED" | null;
  reply: string;
  dollars: number;
};

/**
 * Adds a reward's dollars to the redeeming viewer's style balance, once per redemption id. A reward PixFray doesn't own is
 * ignored (Twitch lets only the app that made it change it). With no fighter the redemption is refunded when it is still
 * UNFULFILLED, which it always is for PixFray's rewards unless the streamer turned on skipping the request queue.
 */
export function redeem(
  room: Room,
  r: Redemption,
  { maxDollars, origin }: { maxDollars: number; origin: string },
): RedeemReply {
  const sql = room.ctx.storage.sql;
  const nothing = (outcome: RedeemOutcome, repeat = false): RedeemReply => ({
    ok: true,
    outcome,
    repeat,
    mark: null,
    reply: "",
    dollars: 0,
  });
  const reward = sql.exec<RewardRow>("SELECT * FROM point_rewards WHERE reward_id = ?", r.rewardId).toArray()[0];
  if (!reward) return nothing("ignored");
  const seen = sql.exec<RedemptionRow>("SELECT * FROM point_redemptions WHERE id = ?", r.id).toArray()[0];
  if (seen) return nothing(seen.outcome as RedeemOutcome, true); // as: only redeem writes outcome, from RedeemOutcome
  const profile = sql
    .exec<{ user_id: string; username: string; style_dollars: number }>(
      "SELECT user_id, username, style_dollars FROM profiles WHERE user_id = ?",
      r.userId,
    )
    .toArray()[0];
  const unfulfilled = r.status === "unfulfilled";
  const outcome: RedeemOutcome = profile ? "granted" : unfulfilled ? "refunded" : "no_fighter";
  const name = r.userName || r.userLogin;
  let total = 0,
    reply = "";
  room.ctx.storage.transactionSync(() => {
    if (profile) {
      total = Math.max(0, Math.min(maxDollars, profile.style_dollars + reward.dollars));
      sql.exec("UPDATE profiles SET style_dollars = ? WHERE user_id = ?", total, r.userId);
    }
    sql.exec(
      "INSERT INTO point_redemptions (id, at, reward_id, user_id, user_login, outcome, dollars, marked) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      r.id,
      Date.now(),
      r.rewardId,
      r.userId,
      r.userLogin,
      outcome,
      profile ? reward.dollars : 0,
      unfulfilled ? 0 : -1,
    );
    sql.exec(
      "DELETE FROM point_redemptions WHERE id IN (SELECT id FROM point_redemptions ORDER BY at DESC LIMIT -1 OFFSET ?)",
      KEEP_REDEMPTIONS,
    );
  });
  // The wallet total, or the redemption id's tail, makes each line differ: Twitch drops a repeat within 30 s.
  if (profile)
    reply = `@${name} got $${reward.dollars} style dollars from ${reward.title} for looks, hats and build slots. Style: $${total}.`;
  else
    reply =
      `@${name} needs a saved fighter first: make one at ${origin}/?channel=${r.channel}` +
      (unfulfilled ? ". Your channel points were refunded" : "") +
      ` (redemption ${r.id.slice(-4)}).`;
  count(room, "points_" + outcome);
  logRoomEvent(room, "points", `${r.userLogin} redeemed ${reward.title}: ${outcome}`, {
    channel: r.channel,
    redemptionId: r.id,
    rewardId: r.rewardId,
    userId: r.userId,
    user: r.userLogin,
    dollars: profile ? reward.dollars : 0,
    wallet: total,
    outcome,
  });
  return {
    ok: true,
    outcome,
    repeat: false,
    mark: outcome === "granted" && unfulfilled ? "FULFILLED" : outcome === "refunded" ? "CANCELED" : null,
    reply,
    dollars: profile ? reward.dollars : 0,
  };
}

/** Stores Twitch's answer to marking a redemption; a failure is counted and logged, since the streamer may then refund by hand. */
export function noteMarked(room: Room, channel: string, redemptionId: string, status: number): void {
  room.ctx.storage.sql.exec("UPDATE point_redemptions SET marked = ? WHERE id = ?", status || 1, redemptionId);
  if (status >= 200 && status < 300) return;
  count(room, "points_mark_failed");
  logRoomEvent(room, "warn", "channel point redemption not marked (" + (status || "network") + ")", {
    channel,
    redemptionId,
    status,
  });
}

/** Adds a reward the Worker created; refused past MAX_POINT_REWARDS. */
export function addReward(room: Room, channel: string, reward: PointReward, actor: string): boolean {
  const sql = room.ctx.storage.sql;
  // COUNT(*) always returns one row
  if (sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM point_rewards").toArray()[0]!.n >= MAX_POINT_REWARDS)
    return false;
  sql.exec(
    "INSERT OR REPLACE INTO point_rewards (reward_id, title, cost, dollars, subscription_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    reward.rewardId,
    reward.title,
    reward.cost,
    reward.dollars,
    reward.subscriptionId,
    reward.status,
    reward.createdAt,
  );
  logRoomEvent(room, "points", `${actor || "someone"} added reward ${reward.title}`, {
    channel,
    rewardId: reward.rewardId,
    cost: reward.cost,
    dollars: reward.dollars,
  });
  return true;
}

export function removeReward(room: Room, channel: string, rewardId: string, actor: string): void {
  room.ctx.storage.sql.exec("DELETE FROM point_rewards WHERE reward_id = ?", rewardId);
  logRoomEvent(room, "points", `${actor || "someone"} removed reward ${rewardId}`, { channel, rewardId });
}

/** A revoked subscription (the broadcaster removed PixFray's access, or Twitch gave up on the callback). */
export function noteRevoked(room: Room, channel: string, subscriptionId: string, status: string): void {
  const cut = room.ctx.storage.sql.exec(
    "UPDATE point_rewards SET status = ? WHERE subscription_id = ?",
    status || "revoked",
    subscriptionId,
  );
  if (cut.rowsWritten)
    logRoomEvent(room, "warn", "channel point subscription revoked: " + status, { channel, subscriptionId, status });
}

const reply = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const refuse = (status: number, reason: string): Response => reply({ ok: false, reason, error: reason }, status);

function parseReward(v: unknown): PointReward | null {
  if (!isObject(v)) return null;
  const { rewardId, title, cost, dollars, subscriptionId, status, createdAt } = v;
  if (typeof rewardId !== "string" || !rewardId || typeof subscriptionId !== "string") return null;
  if (rewardProblem(title, cost, dollars) || typeof status !== "string" || typeof createdAt !== "number") return null;
  // rewardProblem checked title is a string and cost and dollars integers
  return {
    rewardId,
    title: (title as string).trim(),
    cost: cost as number,
    dollars: dollars as number,
    subscriptionId,
    status,
    createdAt,
  };
}

/**
 * The room's Worker-only points routes: GET /points (the admin view); POST /points/rewards {op: add|remove|revoked};
 * POST /points/redeem {redemption, origin}; POST /points/marked {redemptionId, status}.
 */
export async function handleRoomPoints(
  room: Room,
  request: Request,
  { path, channel, maxDollars }: { path: string; channel: string; maxDollars: number },
): Promise<Response> {
  if (path === "/points" && request.method === "GET") return reply(pointsView(room));
  if (request.method !== "POST") return refuse(405, "method_not_allowed");
  const body: unknown = await request.json().catch(() => null);
  if (!isObject(body)) return refuse(400, "invalid_body");
  if (path === "/points/redeem") {
    const r = parseRedemption(isObject(body.redemption) ? body.redemption : null);
    if (!r || r.channel !== channel) return refuse(400, "invalid_redemption");
    return reply(redeem(room, r, { maxDollars, origin: typeof body.origin === "string" ? body.origin : "" }));
  }
  if (path === "/points/marked") {
    const { redemptionId, status } = body;
    if (typeof redemptionId !== "string" || !Number.isInteger(status)) return refuse(400, "invalid_body");
    noteMarked(room, channel, redemptionId, status as number); // as: checked integer
    return reply({ ok: true });
  }
  if (path === "/points/rewards") {
    const actor = typeof body.actor === "string" ? body.actor.slice(0, 48) : "";
    if (body.op === "add") {
      const reward = parseReward(body.reward);
      if (!reward) return refuse(400, "invalid_reward");
      return addReward(room, channel, reward, actor)
        ? reply({ ok: true, ...pointsView(room) })
        : refuse(409, "points_max_rewards");
    }
    if (body.op === "remove" && typeof body.rewardId === "string") {
      removeReward(room, channel, body.rewardId, actor);
      return reply({ ok: true, ...pointsView(room) });
    }
    if (body.op === "revoked" && typeof body.subscriptionId === "string") {
      noteRevoked(room, channel, body.subscriptionId, typeof body.status === "string" ? body.status.slice(0, 64) : "");
      return reply({ ok: true });
    }
    return refuse(400, "invalid_body");
  }
  return refuse(404, "not_found");
}
