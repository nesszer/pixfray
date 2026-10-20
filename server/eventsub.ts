// Twitch EventSub over webhooks: the only chat source. Twitch POSTs channel.chat.message to /api/eventsub,
// so no local process is needed and everything runs on Cloudflare (1 Worker request + 1 DO request per message).
import { record, seal, unseal, randomToken } from "./auth.ts";
import site from "../site.config.js";
import type { Sealed } from "./auth.ts";
import type { Env } from "./env.ts";
import { isObject, parseEventsubEnvelope } from "./parse.ts";
import type { JsonObject } from "./parse.ts";
import type { ChatEvent, SendResult } from "./model.ts";
import { parseRedemption, REDEMPTION_TYPE } from "./points.ts";
import type { Redemption } from "./points.ts";

/** The bot's reply lines for one command, handed to deps.sendChat after the 204. */
export type BotChat = { channel: string; broadcasterId: string; senderId: string; messages: string[]; replyTo: string };
/** What handleEventsub needs from the Worker (see the comment above handleEventsub). */
export type EventsubDeps = {
  channels: string[];
  roomFetch: (channel: string, path: string, init?: RequestInit) => Promise<Response>;
  origin?: (channel: string) => string;
  sendChat?: (opts: BotChat) => void; // posts after the 204; the Worker hands the promise to waitUntil
  findChannel?: (broadcasterId: string) => Promise<string>;
  isEnabled?: (login: string) => Promise<boolean>;
  botUserId?: () => Promise<string>;
  // after the 204: marks the redemption on Twitch and posts the bot line (server/points.ts)
  onRedeemed?: (done: { redemption: Redemption; mark: "FULFILLED" | "CANCELED" | null; reply: string }) => void;
  now?: number;
};
/** A Helix EventSub subscription (the fields read here). */
export type ChatSubscription = {
  id: string;
  status: string;
  version?: string;
  created_at: string;
  condition?: { broadcaster_user_id?: string; user_id?: string };
  transport?: { method?: string; callback?: string };
};
/** What connectChat returns and the room stores as its chat subscription. */
export type ChatSubscriptionSummary = { subscriptionId: string; status: string; createdAt: number };
/** connectChat's options. userId is the account that reads chat (the broadcaster or the PixFray bot). */
export type ConnectChatOptions = {
  broadcasterId: string;
  userId?: string;
  channel?: string;
  origin: string;
  url: URL;
  takeover?: boolean;
};
/** One bot line for sendChatMessage. */
export type ChatLine = {
  broadcasterId: string;
  senderId: string;
  message: string;
  replyTo?: string;
  sleep?: (ms: number) => Promise<unknown>;
};
export const EVENTSUB_PATH = "/api/eventsub";
export const MAX_EVENTSUB_BYTES = 64 * 1024;
export const RECONNECT_URL = "/auth/login?connect=1";
export const BOT_LOGIN_URL = "/auth/login?bot=1";
export const MAX_BOT_MESSAGE = 480; // Twitch allows 500 characters
const HELIX = "https://api.twitch.tv/helix";
const enc = new TextEncoder();
const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join("");
const fail = (message: string, status: number, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { status, ...extra });
const text = (body: string, status: number): Response =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
const hmacKey = (secret: string, usage: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

// Derived, not a new binding: hex(HMAC-SHA256(AUTH_SECRET, 'mini-chat:eventsub:v1')). Cached per isolate.
let cached: { from: string; value: Promise<string> } | null = null;
export async function eventsubSecret(env: Env): Promise<string> {
  if (cached?.from !== env.AUTH_SECRET)
    cached = {
      from: env.AUTH_SECRET,
      value: hmacKey(env.AUTH_SECRET, "sign")
        .then((k) => crypto.subtle.sign("HMAC", k, enc.encode("mini-chat:eventsub:v1")))
        .then(hex),
    };
  return cached.value;
}
// 'sha256=' + hex(HMAC-SHA256(secret, messageId + timestamp + rawBody)). Exported for tests.
export async function signEventsub(
  secret: string,
  messageId: string,
  timestamp: string,
  raw: string | Uint8Array,
): Promise<string> {
  const body = typeof raw === "string" ? enc.encode(raw) : raw;
  return (
    "sha256=" +
    hex(
      await crypto.subtle.sign(
        "HMAC",
        await hmacKey(secret, "sign"),
        concat(enc.encode(messageId), enc.encode(timestamp), body),
      ),
    )
  );
}
async function verify(
  env: Env,
  messageId: string,
  timestamp: string,
  raw: Uint8Array,
  signature: string,
): Promise<boolean> {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signature);
  if (!m) return false;
  // !: the pattern matched, so group 1 holds 64 hex digits, which split into 32 pairs
  const mac = Uint8Array.from(m[1]!.match(/../g)!, (x) => parseInt(x, 16));
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(await eventsubSecret(env), "verify"),
    mac,
    concat(enc.encode(messageId), enc.encode(timestamp), raw),
  );
}
// Twitch sends RFC3339 with up to nanosecond fractions; Date.parse wants at most milliseconds.
export function parseTwitchTime(value: string): number {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(value)) return NaN;
  return Date.parse(value.replace(/\.(\d{1,3})\d*/, ".$1"));
}
async function readRaw(request: Request, limit: number): Promise<Uint8Array> {
  if (Number(request.headers.get("Content-Length")) > limit) throw fail("Request too large", 413);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > limit) {
      await reader.cancel();
      throw fail("Request too large", 413);
    }
    chunks.push(value);
  }
  return concat(...chunks);
}

// A lead moderator wears only lead_moderator (no moderator badge), so it has to count on its own.
const MOD_BADGES = new Set(["broadcaster", "moderator", "lead_moderator"]);
const str = (v: unknown, n: number): string => (typeof v === "string" ? v.slice(0, n) : "");
// ev is channel.chat.message's event as Twitch sent it (parseEventsubEnvelope checked it is an object).
function slimEvent(ev: JsonObject | null): ChatEvent | null {
  if (!ev) return null;
  const message = isObject(ev.message) ? ev.message : {};
  // caps sit above every valid length, so the room's own validation still decides
  return {
    broadcaster_user_id: str(ev.broadcaster_user_id, 100),
    broadcaster_user_login: str(ev.broadcaster_user_login, 64),
    chatter_user_id: str(ev.chatter_user_id, 100),
    chatter_user_login: str(ev.chatter_user_login, 64),
    chatter_user_name: str(ev.chatter_user_name, 100),
    color: str(ev.color, 16),
    message_id: str(ev.message_id, 100),
    message: { text: str(message.text, 512) },
    mod: Array.isArray(ev.badges) && ev.badges.some((b) => b && MOD_BADGES.has(b.set_id)),
  };
}

// POST /api/eventsub. No session, no same-origin check: the HMAC signature is the authentication.
// A subscription whose user_id is not the broadcaster reads chat as the PixFray bot: only messages starting with '!' reach
// the room, which answers commands like the StreamElements route does, and sendChat posts the reply as the bot.
// channels: the built-in rooms. findChannel(broadcasterId) names a signed-up channel's room, isEnabled(login) says whether
// a signed-up channel is on, and botUserId() is the signed-in PixFray bot (which can also be the broadcaster of its own channel).
export async function handleEventsub(
  request: Request,
  env: Env,
  {
    channels,
    roomFetch,
    origin = () => "",
    sendChat,
    findChannel = async () => "",
    isEnabled = async () => false,
    botUserId = async () => "",
    onRedeemed,
    now = Date.now(),
  }: EventsubDeps,
): Promise<Response> {
  if (request.method !== "POST") return text("Use POST", 405);
  const h = (name: string): string => request.headers.get("Twitch-Eventsub-" + name) || "";
  const id = h("Message-Id"),
    timestamp = h("Message-Timestamp"),
    signature = h("Message-Signature"),
    type = h("Message-Type"),
    subType = h("Subscription-Type");
  if (!id || !timestamp || !signature || !type || !subType || id.length > 100 || timestamp.length > 40)
    return text("Missing EventSub headers", 400);
  const raw = await readRaw(request, MAX_EVENTSUB_BYTES); // read once
  if (!(await verify(env, id, timestamp, raw, signature))) return text("Invalid signature", 403);
  const at = parseTwitchTime(timestamp);
  if (!Number.isFinite(at) || now - at > 600000 || at - now > 60000) return text("Stale message", 403);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return text("Invalid JSON", 400);
  }
  const envelope = parseEventsubEnvelope(parsed);
  if (!envelope.ok) return text(envelope.error, 400);
  const body = envelope.value,
    { subscription, condition } = body,
    chat = slimEvent(body.event); // the only event fields read here or forwarded to a room
  const message = {
    messageId: id,
    messageType: type,
    subscriptionType: subType,
    timestamp: at,
    subscription: {
      id: String(subscription.id || "").slice(0, 100),
      status: String(subscription.status || "").slice(0, 64),
    },
  };
  // Only the fields the room reads are forwarded (fragments, badges, reply and cheer are dropped), so an emote-heavy
  // message stays a few hundred bytes. A room 4xx for a validly signed message is acknowledged (204) so Twitch does not
  // retry it into notification_failures_exceeded; only real room failures (5xx) answer 503 for a retry.
  const reader = condition.user_id ? String(condition.user_id).slice(0, 100) : "";
  let botId = reader && reader !== condition.broadcaster_user_id ? reader : "";
  // Verifications and revocations carry only the broadcaster id: the built-in rooms plus that broadcaster's signed-up room.
  const rooms = async () => {
    const own = await findChannel(String(condition.broadcaster_user_id || "")).catch(() => "");
    return own && !channels.includes(own) ? [...channels, own] : channels;
  };
  const send = async (channel: string, extra: { bot?: boolean; botId?: string } = {}): Promise<Response> => {
    const r = await roomFetch(
      channel,
      "/eventsub" + (extra.bot ? "?origin=" + encodeURIComponent(origin(channel)) : ""),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...message, ...extra, event: chat }),
      },
    );
    if (r.status >= 500) throw new Error("Room rejected EventSub message (" + r.status + ")");
    return r;
  };
  if (type === "webhook_callback_verification") {
    if (typeof body.challenge !== "string" || !body.challenge || body.challenge.length > 1000)
      return text("Missing challenge", 400);
    if (subType === "channel.chat.message") for (const channel of await rooms()) await send(channel);
    return text(body.challenge, 200);
  }
  // Channel point redemptions (server/points.ts). The redemption id keys the room's row, so a retry grants nothing twice.
  if (subType === REDEMPTION_TYPE) {
    const points = (channel: string, path: string, data: object) =>
      roomFetch(channel, path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    if (type === "revocation") {
      for (const channel of await rooms())
        await points(channel, "/points/rewards", {
          op: "revoked",
          subscriptionId: message.subscription.id,
          status: message.subscription.status,
        });
      return new Response(null, { status: 204 });
    }
    const r = type === "notification" ? parseRedemption(body.event) : null;
    // No isEnabled gate: each subscription is for a reward PixFray made, and the room ignores rewards it doesn't hold.
    // A paused channel still grants, so a viewer's spent points never sit unmarked in the streamer's queue.
    if (!r) return new Response(null, { status: 204 });
    const res = await points(r.channel, "/points/redeem", { redemption: body.event, origin: origin(r.channel) });
    if (res.status >= 500) throw new Error("Room rejected redemption (" + res.status + ")");
    const d: { mark?: unknown; reply?: unknown } = res.ok ? await res.json<object>().catch(() => ({})) : {};
    const mark = d.mark === "FULFILLED" || d.mark === "CANCELED" ? d.mark : null,
      reply = typeof d.reply === "string" ? d.reply : "";
    if ((mark || reply) && onRedeemed) onRedeemed({ redemption: r, mark, reply });
    return new Response(null, { status: 204 });
  }
  if (type === "revocation") {
    if (subType === "channel.chat.message") for (const channel of await rooms()) await send(channel); // rooms ignore ids they don't own
    return new Response(null, { status: 204 });
  }
  if (type === "notification" && subType === "channel.chat.message") {
    const channel = (chat?.broadcaster_user_login || "").toLowerCase();
    if (!channels.includes(channel) && !(await isEnabled(channel).catch(() => false)))
      return new Response(null, { status: 204 });
    if (!botId && reader && reader === (await botUserId().catch(() => ""))) botId = reader;
    if (!botId) {
      await send(channel);
      return new Response(null, { status: 204 });
    }
    if (!chat?.message.text.trimStart().startsWith("!")) return new Response(null, { status: 204 }); // chat, not a command: no room request
    const r = await send(channel, { bot: true, botId });
    const d: { replies?: unknown; reply?: unknown } = r.ok ? await r.json<object>().catch(() => ({})) : {};
    const messages = (Array.isArray(d.replies) ? d.replies : [d.reply])
      .map((x) => String(x || ""))
      .filter(Boolean)
      .slice(0, 6);
    if (messages.length && sendChat)
      sendChat({
        channel,
        broadcasterId: String(chat.broadcaster_user_id || condition.broadcaster_user_id || ""),
        senderId: botId,
        messages,
        replyTo: chat.message_id,
      });
  }
  return new Response(null, { status: 204 }); // other channels, subscription types and message types are ignored
}

// ---------- Helix subscription lifecycle (app access token) ----------
const loopback = (host: string): boolean => host === "127.0.0.1" || host === "localhost" || host === "[::1]";
// Test-only: chat can be marked connected without Twitch ONLY in a local `cf dev` started with MINI_LOCAL_TEST=1
// (cloudflare.config.ts refuses to build or deploy with it), with a loopback PUBLIC_ORIGIN and a loopback request.
export function localTestMode(env: Env, url: URL): boolean {
  if (env.MINI_LOCAL_TEST !== "1" || !env.PUBLIC_ORIGIN) return false;
  try {
    return loopback(new URL(env.PUBLIC_ORIGIN).hostname) && loopback(url.hostname);
  } catch {
    return false;
  }
}
export async function appToken(env: Env, fresh = false): Promise<string> {
  if (!fresh) {
    const sealed = await record<Sealed | null>(env, "app-token:twitch");
    if (sealed) {
      try {
        const t = await unseal<{ access_token: string; expiresAt: number }>(env, sealed);
        if (t.expiresAt > Date.now() + 60000) return t.access_token;
      } catch {}
    }
  }
  const r = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!r.ok) throw fail("Twitch app token request failed (" + r.status + ")", 502);
  const t = await r.json<{ access_token?: string; expires_in?: unknown }>();
  if (!t.access_token) throw fail("Twitch app token request failed", 502);
  const expiresAt = Date.now() + Math.min(Number(t.expires_in) || 3600, 99 * 86400) * 1000;
  await record(env, "app-token:twitch", await seal(env, { access_token: t.access_token, expiresAt }), expiresAt);
  return t.access_token;
}
/** A Helix call with the app access token; a 401 fetches a fresh token once. */
export async function appHelix(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
  const call = async (token: string) =>
    fetch(HELIX + path, {
      method,
      headers: {
        "Client-Id": env.TWITCH_CLIENT_ID,
        Authorization: "Bearer " + token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  let r = await call(await appToken(env));
  if (r.status === 401) r = await call(await appToken(env, true));
  return r;
}
export async function listChatSubscriptions(env: Env): Promise<ChatSubscription[]> {
  const all: ChatSubscription[] = [];
  let after = "";
  for (let page = 0; page < 10; page++) {
    const r = await appHelix(
      env,
      "GET",
      "/eventsub/subscriptions?type=channel.chat.message" + (after ? "&after=" + encodeURIComponent(after) : ""),
    );
    if (!r.ok) throw fail("Twitch subscription list failed (" + r.status + ")", 502);
    const d = await r.json<{ data?: ChatSubscription[]; pagination?: { cursor?: string } }>();
    all.push(...(d.data || []));
    after = d.pagination?.cursor || "";
    if (!after) break;
  }
  return all;
}
export async function deleteSubscription(env: Env, id: string): Promise<void> {
  const r = await appHelix(env, "DELETE", "/eventsub/subscriptions?id=" + encodeURIComponent(id));
  if (!r.ok && r.status !== 404) throw fail("Twitch subscription delete failed (" + r.status + ")", 502);
}
const summary = (s: ChatSubscription): ChatSubscriptionSummary => ({
  subscriptionId: String(s.id),
  status: String(s.status || "pending"),
  createdAt: Date.parse(s.created_at) || Date.now(),
});
// Twitch allows one subscription per type + condition, whatever the callback. Both sites share one Twitch app, so only
// one site at a time can receive chat: a live subscription for the same condition on another callback is a conflict
// (409, connectedElsewhere) unless the caller asks to take it over, which deletes it there.
const callbackOrigin = (s: ChatSubscription): string => {
  try {
    // !: a missing transport or callback throws here on purpose, and the catch answers instead
    return new URL(s.transport!.callback!).origin;
  } catch {
    return s.transport?.method || "another callback";
  }
};
const conflict = (where: string) =>
  fail(
    "Chat is connected to " +
      where +
      ". Only one site can receive chat at a time: disconnect it there, or take it over here.",
    409,
    { connectedElsewhere: where },
  );
// Ensures exactly one enabled channel.chat.message v1 webhook for this callback; stale or duplicate ones are deleted.
// userId is the account that reads chat: the broadcaster or the PixFray bot.
export async function connectChat(
  env: Env,
  { broadcasterId, userId = broadcasterId, channel = "", origin, url, takeover = false }: ConnectChatOptions,
): Promise<ChatSubscriptionSummary> {
  if (localTestMode(env, url))
    return { subscriptionId: "local-" + randomToken().slice(0, 16), status: "enabled", createdAt: Date.now() };
  if (!broadcasterId)
    throw fail("Sign in as " + site.owner.login + " with " + RECONNECT_URL + " before connecting chat", 409, {
      reconnect: RECONNECT_URL,
    });
  const asBot = userId !== broadcasterId,
    allowBot = "/auth/login?channel=" + channel + "&connect=bot";
  if (!String(origin).startsWith("https://")) throw fail("PUBLIC_ORIGIN must be https for Twitch webhooks", 400);
  const callback = origin + EVENTSUB_PATH;
  const all = await listChatSubscriptions(env);
  const ours = (s: ChatSubscription): boolean => s.transport?.method === "webhook" && s.transport.callback === callback;
  const sameCondition = (s: ChatSubscription): boolean =>
    s.condition?.broadcaster_user_id === broadcasterId && s.condition?.user_id === userId;
  const elsewhere = all.filter((s) => !ours(s) && sameCondition(s));
  const live = elsewhere.find((s) => s.status === "enabled" || s.status === "webhook_callback_verification_pending");
  if (live && !takeover) throw conflict(callbackOrigin(live));
  for (const s of elsewhere) await deleteSubscription(env, s.id); // dead ones always; live ones only on takeover
  // This site's subscriptions for this channel; other channels on the same callback (the bot reads several) stay.
  const mine = all.filter((s) => ours(s) && s.condition?.broadcaster_user_id === broadcasterId);
  const keep = mine.find((s) => s.status === "enabled" && s.version === "1" && sameCondition(s));
  for (const s of mine) if (s !== keep) await deleteSubscription(env, s.id);
  if (keep) return summary(keep);
  const r = await appHelix(env, "POST", "/eventsub/subscriptions", {
    type: "channel.chat.message",
    version: "1",
    condition: { broadcaster_user_id: broadcasterId, user_id: userId },
    transport: { method: "webhook", callback, secret: await eventsubSecret(env) },
  });
  if (asBot && (r.status === 401 || r.status === 403))
    throw fail(
      "Twitch refused the chat bot. " +
        channel +
        " must allow it at " +
        allowBot +
        " (or make the bot a moderator), and the bot account must be signed in at " +
        BOT_LOGIN_URL +
        ".",
      403,
      { reconnect: allowBot },
    );
  if (r.status === 401 || r.status === 403)
    throw fail(
      "Twitch rejected the chat subscription: missing authorization. Reconnect Twitch at " +
        RECONNECT_URL +
        ", then click Connect chat.",
      403,
      { reconnect: RECONNECT_URL },
    );
  if (r.status === 409) throw conflict("another site"); // created elsewhere between our list and our create
  if (!r.ok) throw fail("Twitch rejected the chat subscription (" + r.status + ")", 502);
  const created = (await r.json<{ data?: ChatSubscription[] }>()).data?.[0];
  if (!created?.id) throw fail("Twitch returned no subscription", 502);
  return summary(created);
}
export async function disconnectChat(
  env: Env,
  { subscriptionId, url }: { subscriptionId?: string | null; url: URL },
): Promise<void> {
  if (
    !subscriptionId ||
    subscriptionId.startsWith("local-") ||
    subscriptionId.startsWith("se-") ||
    localTestMode(env, url)
  )
    return;
  await deleteSubscription(env, subscriptionId);
}
// The bot's chat line, sent with the app token (the bot granted user:write:chat + user:bot, the channel channel:bot).
// A reply never starts with a command character, so the bot can't trigger itself or another bot.
export function botMessage(message: unknown): string {
  const text = String(message || "")
    .replace(/\s+/g, " ")
    .trim();
  return (/^[!/.]/.test(text) ? "PixFray: " + text : text).slice(0, MAX_BOT_MESSAGE);
}
// Twitch's reason for a line the bot couldn't post, in words for the owner log, the admin page and "!fray debug".
// reason is a drop_reason code from Helix, or the error sendChatMessage threw ("... failed (403)").
const DROP_TEXT = new Map(
  Object.entries({
    msg_duplicate: "the same line twice within 30 s",
    msg_rejected: "held by AutoMod",
    msg_rejected_mandatory: "blocked by AutoMod or blocked terms",
    msg_banned: "the bot is banned in this channel",
    msg_timedout: "the bot is timed out",
    msg_ratelimit: "Twitch rate limit",
    msg_followersonly: "followers-only chat",
    msg_subsonly: "subscriber-only chat",
    msg_slowmode: "slow mode",
    msg_emoteonly: "emote-only chat",
    msg_verified_email: "the bot account needs a verified email",
    empty: "nothing to send",
  }),
);
export function botDropText(reason: string | null | undefined): string {
  reason = String(reason || "");
  const text = DROP_TEXT.get(reason);
  if (text) return text + " (" + reason + ")";
  const status = /\((\d{3})\)/.exec(reason)?.[1];
  if (status === "401") return "Twitch didn't accept the app token (401)";
  if (status === "403")
    return "Twitch says the bot may not chat here (403): sign the bot in again, and check it is not banned";
  if (status === "429") return "Twitch rate limit (429)";
  return reason || "unknown";
}
// A bot that isn't a channel mod may send about one line per second there, so a 429 is retried twice after a short wait.
export async function sendChatMessage(
  env: Env,
  { broadcasterId, senderId, message, replyTo = "", sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: ChatLine,
): Promise<SendResult> {
  const text = botMessage(message);
  if (!text || !broadcasterId || !senderId) return { sent: false, reason: "empty" };
  const post = async (message: string): Promise<SendResult> => {
    const body = {
      broadcaster_id: broadcasterId,
      sender_id: senderId,
      message,
      ...(replyTo ? { reply_parent_message_id: replyTo } : {}),
    };
    let r = await appHelix(env, "POST", "/chat/messages", body);
    for (const wait of [1100, 2200]) {
      if (r.status !== 429) break;
      await sleep(wait);
      r = await appHelix(env, "POST", "/chat/messages", body);
    }
    if (!r.ok) throw fail("Twitch send chat message failed (" + r.status + ")", 502);
    const d = (await r.json<{ data?: { is_sent?: boolean; drop_reason?: { code?: string } | null }[] }>()).data?.[0];
    return { sent: d?.is_sent === true, reason: String(d?.drop_reason?.code || "") };
  };
  // Twitch drops a line identical to the sender's previous one within 30 s (two viewers asking !fray). An invisible tag
  // character (U+E0000) makes it differ; twice when the previous line already carried one.
  let out = await post(text);
  for (const tail of [" \u{E0000}", " \u{E0000}\u{E0000}"]) {
    if (out.reason !== "msg_duplicate") break;
    out = await post(text + tail);
  }
  return out;
}
// The room's reply lines, in order and about a second apart (a bot that isn't a mod gets ~1 line per second).
export async function sendChatMessages(
  env: Env,
  {
    messages = [],
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    ...rest
  }: Omit<ChatLine, "message"> & { messages?: string[] },
): Promise<SendResult[]> {
  const out: SendResult[] = [];
  for (const [i, message] of messages.entries()) {
    if (i) await sleep(1100);
    out.push(
      await sendChatMessage(env, { ...rest, message, sleep }).catch((e) => ({
        sent: false,
        reason: String(e?.message || e),
      })),
    );
  }
  return out;
}
// A channel's immutable Twitch id from its login, or '' when Twitch doesn't know it.
export async function twitchUserId(env: Env, login: string): Promise<string> {
  const r = await appHelix(env, "GET", "/users?login=" + encodeURIComponent(login));
  if (!r.ok) throw fail("Twitch user lookup failed (" + r.status + ")", 502);
  return String((await r.json<{ data?: { id?: string }[] }>()).data?.[0]?.id || "");
}
// !checkin: the channel's current stream as {id,startedAt}, or null when it is offline. Throws when Twitch can't be reached.
export async function liveStream(env: Env, login: string): Promise<{ id: string; startedAt: number } | null> {
  const r = await appHelix(env, "GET", "/streams?user_login=" + encodeURIComponent(login));
  if (!r.ok) throw fail("Twitch stream lookup failed (" + r.status + ")", 502);
  const s = (await r.json<{ data?: { id?: string; type?: string; started_at: string }[] }>()).data?.[0];
  return s?.id && s.type === "live" ? { id: String(s.id), startedAt: Date.parse(s.started_at) || 0 } : null;
}
// Hourly alarm check. Returns the subscription status, 'missing', or null when Twitch can't be reached (no change then).
export async function checkChatSubscription(env: Env, subscriptionId: string): Promise<string | null> {
  try {
    const s = (await listChatSubscriptions(env)).find((x) => x.id === subscriptionId);
    return s ? String(s.status) : "missing";
  } catch {
    return null;
  }
}
