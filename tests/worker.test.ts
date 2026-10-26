// Worker routing, gates and validation, with in-memory AuthStore/ChannelRoom stubs.
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../server/worker.ts";
import type { Env } from "../server/env.ts";
import { forgetChannel } from "../server/channels.ts";
import {
  eventsubSecret,
  signEventsub,
  localTestMode,
  sendChatMessage,
  sendChatMessages,
  botDropText,
} from "../server/eventsub.ts";
import { asEnv, asExecutionContext, must, type Loose } from "./fakes.ts";
import { makePng } from "./upload-helpers.ts";
import { ORIGIN, SECRETS, memoryAuth, namespace, signedIn, req, call, status, twitchApi } from "./worker-fakes.ts";
import type { StubInit } from "./worker-fakes.ts";

type Fixture = ReturnType<typeof environment>;
type RoomFetch = (channel: string, url: string, init: StubInit) => Promise<Response>;

function environment() {
  // Loose: stored values and forwarded room calls, which the tests read by property
  const entries = new Map<string, Loose>(),
    forwarded: Loose[] = [];
  const room: RoomFetch = async (channel, url, options) => {
    const path = new URL(url).pathname;
    forwarded.push({ channel, path, options, body: options.body ? JSON.parse(options.body) : undefined });
    if (path === "/catalog") return Response.json([{ id: "c-robot" }]);
    if (path === "/admin" && (options.method || "GET") === "GET") return Response.json({ revision: 3, history: [] });
    return Response.json({ path });
  };
  const env = asEnv({
    ...SECRETS,
    AUTH: memoryAuth(entries),
    ROOMS: namespace(room),
    ASSETS: { fetch: async () => Response.json([{ id: "player" }]) },
  });
  /** Answers room calls with `fetch`, which may hand any call back to the default room. */
  const rooms = (fetch: (channel: string, url: string, init: StubInit, next: RoomFetch) => Promise<Response>) => {
    env.ROOMS = namespace((c, u, o) => fetch(c, u, o, room));
  };
  const st = (...args: Parameters<typeof req>) => status(env, ...args);
  const json = async (...args: Parameters<typeof req>) => (await call(env, ...args)).body;
  return { env, entries, forwarded, rooms, st, json };
}
const b64png = (w: number, h: number) => Buffer.from(makePng(w, h)).toString("base64");
const look = { avatar: "c-robot", color: "#aabbcc", defaultAbility: "heal" },
  basic = { avatar: "player", color: "#aabbcc", defaultAbility: "heal" };

test("admin dashboard data requires a mod or the owner", async () => {
  const f = environment();
  assert.equal(await f.st("/api/admin/nesszerra"), 401);
  assert.equal(await f.st("/api/admin/nesszerra", "GET", undefined, await signedIn(f)), 403);
  const r = await call(f.env, "/api/admin/nesszerra", "GET", undefined, await signedIn(f, true));
  assert.deepEqual([r.status, r.body.revision, r.body.access.canManage], [200, 3, true]);
});

test("admin actions carry the session user as actor, never a forged one", async () => {
  const f = environment(),
    cookie = await signedIn(f, true);
  assert.equal(await f.st("/api/admin/nesszerra", "POST", { actorId: "forged", action: "resetRound" }, cookie), 200);
  assert.equal(f.forwarded.at(-1).body.actorId, "1");
});

test("custom character uploads are gated; atlas reads are public", async () => {
  const f = environment();
  assert.equal(await f.st("/api/assets/nesszerra"), 401);
  assert.equal(await f.st("/api/assets/nesszerra", "POST", {}, await signedIn(f)), 403);
  const bad = await call(f.env, "/api/assets/nesszerra", "POST", {}, await signedIn(f, true));
  assert.deepEqual([bad.status, bad.body.reason], [400, "invalid_label"], "an empty upload stops in the Worker");
  assert.equal(await f.st("/api/assets/nesszerra/c-robot"), 200);
  assert.equal(f.forwarded.at(-1).path, "/asset/c-robot");
});

test("catalog merges static and custom characters; profiles may pick either", async () => {
  const f = environment(),
    cookie = await signedIn(f);
  assert.deepEqual(
    (await f.json("/api/catalog/nesszerra")).map((x: { id: string }) => x.id),
    ["player", "c-robot"],
  );
  for (const [body, code] of [
    [look, 200],
    [{ ...look, avatar: "ghost" }, 400],
    [{ ...basic, color: "red" }, 400],
  ] as const)
    assert.equal(await f.st("/api/profile/nesszerra", "POST", body, cookie), code);
});

test("a saved fighter is indexed per viewer, and /others lists their look on other channels", async () => {
  const f = environment(),
    cookie = await signedIn(f);
  // Rooms: the viewer (id 2) has a fighter on miolafff and on newstreamer, none on nesszerra.
  const saved: Record<string, object> = {
    miolafff: { avatar: "cowgirl", color: "#F87171", defaultAbility: "heal", lastSeen: 100, hat: "crown" },
    newstreamer: { avatar: "dog", color: "#FBBF24", defaultAbility: "strike", lastSeen: 200 },
  };
  f.rooms(async (channel, url, options, next) => {
    const u = new URL(url);
    if (u.pathname !== "/profile" || (options.method || "GET") !== "GET") return next(channel, url, options);
    f.forwarded.push({ channel, path: "/profile" });
    return Response.json(u.searchParams.get("userId") === "2" ? saved[channel] || null : null);
  });
  f.entries.set("channel:newstreamer", { id: "77", login: "newstreamer", enabledAt: 1 });
  assert.equal(await f.st("/api/profile/nesszerra/others"), 401);
  assert.equal(await f.st("/api/profile/nesszerra/other", "GET", undefined, cookie), 404);
  assert.equal(await f.st("/api/profile/nesszerra/others", "POST", {}, cookie), 404);
  const others = async () =>
    (await f.json("/api/profile/nesszerra/others", "GET", undefined, cookie)).fighters as { channel: string }[];
  // Before any save the index is empty: only the built-in channels are checked, never this one.
  assert.deepEqual(
    await others(),
    [{ channel: "miolafff", avatar: "cowgirl", color: "#F87171", defaultAbility: "heal", lastSeen: 100 }],
    "base look only, no gear",
  );
  assert.equal(f.entries.has("fighters:2"), false);
  // A save on newstreamer puts it first in the index; then it is listed too, newest first.
  f.forwarded.length = 0;
  assert.equal(await f.st("/api/profile/newstreamer", "POST", look, cookie), 200);
  assert.deepEqual(f.entries.get("fighters:2"), { channels: ["newstreamer"] });
  assert.equal(await f.st("/api/profile/nesszerra", "POST", look, cookie), 200);
  assert.deepEqual(f.entries.get("fighters:2"), { channels: ["nesszerra", "newstreamer"] });
  assert.deepEqual(
    (await others()).map((x) => x.channel),
    ["newstreamer", "miolafff"],
  );
  assert.ok(
    !f.forwarded.some((x) => x.channel === "nesszerra" && x.path === "/profile" && !x.body),
    "this channel is not asked",
  );
  // A channel that was turned off is skipped.
  f.entries.delete("channel:newstreamer");
  forgetChannel("newstreamer");
  assert.deepEqual(
    (await others()).map((x) => x.channel),
    ["miolafff"],
  );
});

test("malformed and oversized bodies are rejected before reaching a room", async () => {
  const f = environment(),
    cookie = await signedIn(f);
  for (const [body, code] of [
    ["null", 400],
    ["[1]", 400],
    ["{bad", 400],
    [JSON.stringify({ avatar: "x".repeat(5000) }), 413],
  ] as const)
    assert.equal(await f.st("/api/profile/nesszerra", "POST", body, cookie), code, body.slice(0, 10));
  assert.equal(f.forwarded.length, 0);
});

test("live sockets require a WebSocket upgrade; the relay routes are gone", async () => {
  const f = environment();
  assert.equal(await f.st("/api/live/nesszerra"), 426);
  assert.equal(await f.st("/api/relay/nesszerra", "GET", undefined, undefined, { Upgrade: "websocket" }), 404);
  assert.equal(await f.st("/api/relay/code", "POST", {}, await signedIn(f, true)), 404);
  assert.equal(f.forwarded.length, 0);
});

test("unknown routes and channels that are not enabled", async () => {
  const f = environment();
  assert.equal(await f.st("/api/leaderboard/somechannel"), 403);
  assert.equal(await f.st("/api/state/nesszerra", "DELETE"), 405);
});

// ---------- Twitch EventSub webhook ----------
const NOW = Date.parse("2026-10-01T12:00:00Z");
type Delivery = {
  type?: string;
  id?: string;
  at?: number;
  sign?: boolean;
  signature?: string;
  headers?: Record<string, string>;
  origin?: string;
  ctx?: ExecutionContext;
};
async function eventsub(f: Fixture, body: unknown, options: Delivery = {}) {
  const { type = "notification", id = "msg-" + Math.random().toString(16).slice(2), at = NOW } = options;
  const raw = typeof body === "string" ? body : JSON.stringify(body),
    timestamp = new Date(at).toISOString().replace("Z", "123456Z");
  const sig =
    options.signature ??
    (options.sign === false
      ? "sha256=" + "0".repeat(64)
      : await signEventsub(await eventsubSecret(f.env), id, timestamp, raw));
  // no Origin and no cookie, like Twitch
  const request = new Request((options.origin ?? ORIGIN) + "/api/eventsub", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Twitch-Eventsub-Message-Id": id,
      "Twitch-Eventsub-Message-Timestamp": timestamp,
      "Twitch-Eventsub-Message-Signature": sig,
      "Twitch-Eventsub-Message-Type": type,
      "Twitch-Eventsub-Subscription-Type": "channel.chat.message",
      "Twitch-Eventsub-Subscription-Version": "1",
      ...options.headers,
    },
    body: raw,
  });
  return worker.fetch(request, f.env, options.ctx);
}
/** A chat notification; tests add the optional fields a message can carry. */
type ChatBody = {
  subscription: { id: string; status: string; type: string; condition?: object };
  event: {
    broadcaster_user_id?: string;
    broadcaster_user_login: string;
    chatter_user_id: string;
    chatter_user_login: string;
    chatter_user_name: string;
    message_id: string;
    message: { text: string; fragments?: object[] };
    color?: string;
    badges?: { set_id: string; id: string; info: string }[];
    reply?: { parent_message_body: string };
  };
};
const chatBody = (channel = "nesszerra"): ChatBody => ({
  subscription: { id: "sub-1", status: "enabled", type: "channel.chat.message" },
  event: {
    broadcaster_user_login: channel,
    chatter_user_id: "7",
    chatter_user_login: "viewer",
    chatter_user_name: "Viewer",
    message_id: "chat-1",
    message: { text: "!strike" },
    color: "#FF0000",
  },
});

test("eventsub: the secret is derived from AUTH_SECRET; signed notifications reach the room without Origin or session", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const f = environment();
  const expected = createHmac("sha256", f.env.AUTH_SECRET).update("mini-chat:eventsub:v1").digest("hex");
  assert.equal(await eventsubSecret(f.env), expected);
  assert.equal((await eventsub(f, chatBody(), { id: "n-1" })).status, 204);
  const { channel, path, body } = f.forwarded.at(-1);
  assert.deepEqual(
    [channel, path, body.messageId, body.messageType, body.subscription.id, body.timestamp],
    ["nesszerra", "/eventsub", "n-1", "notification", "sub-1", NOW],
    "nanosecond fractions are truncated to milliseconds",
  );
  assert.equal(body.event.message.text, "!strike");
  // a disabled channel is accepted (204) but never routed
  const before = f.forwarded.length;
  assert.equal((await eventsub(f, chatBody("somechannel"))).status, 204);
  assert.equal(f.forwarded.length, before);
});

test("eventsub: bad signatures, stale or future timestamps, missing headers and oversized bodies are refused", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const f = environment();
  // a valid signature for a different body
  const other = await signEventsub(
    await eventsubSecret(f.env),
    "x",
    new Date(NOW).toISOString().replace("Z", "123456Z"),
    "{}",
  );
  for (const [options, code, why] of [
    [{ sign: false }, 403, "unsigned"],
    [{ signature: "nonsense" }, 403, "nonsense signature"],
    [{ id: "x", signature: other }, 403, "another body's signature"],
    [{ at: NOW - 601_000 }, 403, "older than 10 minutes"],
    [{ at: NOW + 61_000 }, 403, "more than 1 minute in the future"],
    [{ at: NOW - 590_000 }, 204, "inside the window"],
    [{ headers: { "Twitch-Eventsub-Message-Id": "" } }, 400, "no message id"],
  ] satisfies [Delivery, number, string][])
    assert.equal((await eventsub(f, chatBody(), options)).status, code, why);
  assert.equal((await eventsub(f, "x".repeat(64 * 1024 + 1))).status, 413);
  assert.equal((await eventsub(f, "{not json")).status, 400);
  assert.equal(f.forwarded.length, 1);
  assert.equal((await worker.fetch(new Request(ORIGIN + "/api/eventsub"), f.env)).status, 405);
});

test("eventsub: verification answers the challenge as text/plain; revocation is forwarded; unknown types are ignored", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const f = environment();
  const res = await eventsub(
    f,
    {
      challenge: "pogchamp-kappa-360noscope",
      subscription: { id: "sub-1", status: "webhook_callback_verification_pending" },
    },
    { type: "webhook_callback_verification" },
  );
  assert.equal(res.status, 200);
  assert.match(must(res.headers.get("content-type")), /^text\/plain/);
  assert.equal(await res.text(), "pogchamp-kappa-360noscope");
  assert.equal(f.forwarded.at(-1).body.messageType, "webhook_callback_verification");
  const revoked = { subscription: { id: "sub-1", status: "authorization_revoked" } };
  assert.equal((await eventsub(f, revoked, { type: "revocation" })).status, 204);
  const { body } = f.forwarded.at(-1);
  assert.deepEqual([body.messageType, body.subscription.status], ["revocation", "authorization_revoked"]);
  const n = f.forwarded.length;
  assert.equal((await eventsub(f, { subscription: {} }, { type: "something_new" })).status, 204);
  assert.equal(f.forwarded.length, n);
});

test("eventsub: a room failure is not acknowledged, so Twitch retries; a room 4xx is acknowledged", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const f = environment();
  f.rooms(async () => new Response("boom", { status: 500 }));
  assert.equal((await eventsub(f, chatBody())).status, 503);
  // a room refusing a validly signed message must not turn into a Twitch retry loop
  f.rooms(async () => Response.json({ error: "request body too large" }, { status: 400 }));
  assert.equal((await eventsub(f, chatBody())).status, 204);
});

test("eventsub: an emote-heavy message (~30 KB) is forwarded as a few hundred bytes", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const f = environment(),
    body = chatBody();
  const emote = {
    type: "emote",
    text: "Kappa",
    cheermote: null,
    emote: {
      id: "emotesv2_" + "a".repeat(32),
      emote_set_id: "0123456789",
      owner_id: "0123456789",
      format: ["static", "animated"],
    },
    mention: null,
  };
  const space = { type: "text", text: " ", cheermote: null, emote: null, mention: null };
  body.event.message = {
    text: "!strike " + "Kappa ".repeat(80),
    fragments: [...Array.from({ length: 120 }, (_, i) => (i % 2 ? space : emote)), ...Array(60).fill(emote)],
  };
  body.event.badges = Array.from({ length: 20 }, () => ({ set_id: "subscriber", id: "12", info: "12" }));
  body.event.reply = { parent_message_body: "x".repeat(500) };
  const raw = JSON.stringify(body);
  assert.ok(raw.length > 28_000 && raw.length < 64 * 1024, "body is " + raw.length + " bytes");
  assert.equal((await eventsub(f, body)).status, 204);
  const sent = f.forwarded.at(-1),
    event = sent.body.event;
  assert.ok(sent.options.body.length < 1500, "room payload is " + sent.options.body.length + " bytes");
  assert.equal(event.message.text, body.event.message.text.slice(0, 512));
  assert.equal(event.message.fragments, undefined);
  assert.deepEqual(
    [event.chatter_user_id, event.chatter_user_login, event.color, event.message_id],
    ["7", "viewer", "#FF0000", "chat-1"],
  );
});

test("eventsub: broadcaster, moderator and lead moderator badges mark the chatter as a mod; others do not", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const f = environment();
  for (const [badges, mod] of [
    [["lead_moderator", "founder"], true],
    [["moderator"], true],
    [["broadcaster"], true],
    [["vip", "subscriber"], false],
    [[], false],
  ] satisfies [string[], boolean][]) {
    const body = chatBody();
    body.event.badges = badges.map((set_id) => ({ set_id, id: "1", info: "" }));
    assert.equal((await eventsub(f, body)).status, 204);
    assert.equal(f.forwarded.at(-1).body.event.mod, mod, badges.join(",") || "no badges");
  }
});

// ---------- Connect chat (Helix lifecycle) ----------
function helixMock(
  t: TestContext,
  { subscriptions = [], create = 202 }: { subscriptions?: object[]; create?: number } = {},
) {
  const calls: Loose[] = []; // Loose: call records the tests read by property
  twitchApi(t, (url, init) => {
    const method = init.method || "GET";
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.Authorization });
    if (method === "GET") return Response.json({ data: subscriptions, pagination: {} });
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (create !== 202) return Response.json({ message: "missing authorization" }, { status: create });
    const data = [
      { id: "sub-new", status: "webhook_callback_verification_pending", created_at: "2026-10-01T12:00:00Z" },
    ];
    return Response.json({ data }, { status: 202 });
  });
  const deleted = () => calls.filter((c) => c.method === "DELETE").map((c) => c.url.searchParams.get("id"));
  const created = () => calls.filter((c) => c.method === "POST" && c.url.host === "api.twitch.tv");
  return { calls, deleted, created };
}
const callback = ORIGIN + "/api/eventsub";
const sub = (id: string, extra: object = {}) => ({
  id,
  status: "enabled",
  type: "channel.chat.message",
  version: "1",
  condition: { broadcaster_user_id: "1", user_id: "1" },
  transport: { method: "webhook", callback },
  created_at: "2026-09-30T00:00:00Z",
  ...extra,
});
const connect = async (f: Fixture, extra: object = {}) =>
  call(f.env, "/api/admin/nesszerra", "POST", { action: "connectChat", ...extra }, await signedIn(f, true));

test("connectChat creates exactly one webhook with the broadcaster condition and deletes stale ones", async (t) => {
  const f = environment();
  const helix = helixMock(t, {
    subscriptions: [
      sub("old-revoked", { status: "authorization_revoked" }),
      sub("wrong-user", { condition: { broadcaster_user_id: "1", user_id: "9" } }),
      sub("other-channel", {
        condition: { broadcaster_user_id: "5", user_id: "5" },
        transport: { method: "webhook", callback: "https://other.example/api/eventsub" },
      }),
    ],
  });
  assert.equal((await connect(f)).status, 200);
  assert.deepEqual(helix.deleted(), ["old-revoked", "wrong-user"]);
  const created = helix.created()[0];
  assert.deepEqual(created.body.condition, { broadcaster_user_id: "1", user_id: "1" });
  const { type, version, transport } = created.body;
  assert.deepEqual(
    [type, version, transport.method, transport.callback],
    ["channel.chat.message", "1", "webhook", callback],
  );
  assert.equal(transport.secret, await eventsubSecret(f.env));
  assert.equal(created.auth, "Bearer app-token-1");
  assert.deepEqual(f.forwarded.at(-1).body, {
    action: "connected",
    subscriptionId: "sub-new",
    status: "webhook_callback_verification_pending",
    createdAt: Date.parse("2026-10-01T12:00:00Z"),
  });
  // the app token is cached sealed, never stored in plain text
  assert.ok(f.entries.has("app-token:twitch"));
  assert.equal(JSON.stringify(f.entries.get("app-token:twitch")).includes("app-token-1"), false);
});

test("connectChat keeps an existing matching webhook instead of creating another", async (t) => {
  const f = environment();
  const { calls } = helixMock(t, {
    subscriptions: [sub("keep-me"), sub("dupe-pending", { status: "webhook_callback_verification_pending" })],
  });
  assert.equal((await connect(f)).status, 200);
  assert.deepEqual(
    calls
      .filter((c) => c.method !== "GET" && c.url.host === "api.twitch.tv")
      .map((c) => c.method + " " + (c.url.searchParams.get("id") || "")),
    ["DELETE dupe-pending"],
  );
  assert.equal(f.forwarded.at(-1).body.subscriptionId, "keep-me");
});

test("connectChat: a live subscription for the same channel on the other site is a clear 409 unless taken over", async (t) => {
  const f = environment();
  const helix = helixMock(t, {
    subscriptions: [
      sub("on-test-site", { transport: { method: "webhook", callback: "https://test.chat.miolaf.xyz/api/eventsub" } }),
      sub("dead-elsewhere", {
        status: "webhook_callback_verification_failed",
        transport: { method: "webhook", callback: "https://old.example/api/eventsub" },
      }),
    ],
  });
  const res = await connect(f);
  assert.deepEqual([res.status, res.body.connectedElsewhere], [409, "https://test.chat.miolaf.xyz"]);
  assert.match(
    res.body.error,
    /Chat is connected to https:\/\/test\.chat\.miolaf\.xyz\. Only one site can receive chat at a time/,
  );
  assert.equal(
    helix.calls.some((c) => c.method !== "GET" && c.url.host === "api.twitch.tv"),
    false,
    "nothing is deleted or created without takeover",
  );
  assert.equal(
    f.forwarded.some((x) => x.path === "/chat" && x.body),
    false,
  );
  // takeover deletes the other site's subscription (and dead ones for this channel), then creates ours
  assert.equal((await connect(f, { takeover: true })).status, 200);
  assert.deepEqual(helix.deleted(), ["on-test-site", "dead-elsewhere"]);
  assert.equal(helix.created().length, 1);
  assert.equal(f.forwarded.at(-1).body.subscriptionId, "sub-new");
  // the owner dev settings route takes the same option
  const dev = await call(f.env, "/api/dev/settings", "POST", { action: "connectChat" }, await signedIn(f, true));
  assert.deepEqual([dev.status, dev.body.connectedElsewhere], [409, "https://test.chat.miolaf.xyz"]);
});

test("connectChat: a Helix 409 on create (raced by another site) is the same clear conflict", async (t) => {
  const f = environment();
  helixMock(t, { create: 409 });
  const res = await connect(f);
  assert.deepEqual([res.status, res.body.connectedElsewhere], [409, "another site"]);
  assert.match(res.body.error, /Only one site can receive chat at a time/);
});

test("connectChat: a Twitch authorization error tells the owner to reconnect Twitch", async (t) => {
  const f = environment();
  helixMock(t, { create: 403 });
  const res = await connect(f);
  assert.deepEqual([res.status, res.body.reconnect], [403, "/auth/login?connect=1"]);
  assert.match(res.body.error, /Reconnect Twitch at \/auth\/login\?connect=1/);
  assert.equal(
    f.forwarded.some((x) => x.path === "/chat" && x.body),
    false,
    "the room is not told anything",
  );
});

test("disconnectChat deletes the subscription and pauses the room; viewers cannot manage chat", async (t) => {
  const f = environment();
  f.rooms(async (c, url, o, next) =>
    new URL(url).pathname === "/chat" && !o.body
      ? Response.json({ connected: true, subscriptionId: "sub-9" })
      : next(c, url, o),
  );
  const helix = helixMock(t);
  const owner = await signedIn(f, true);
  assert.equal(await f.st("/api/admin/nesszerra", "POST", { action: "disconnectChat" }, owner), 200);
  assert.deepEqual(helix.deleted(), ["sub-9"]);
  assert.deepEqual(f.forwarded.at(-1).body, { action: "disconnected", reason: "disconnected" });
  assert.equal(await f.st("/api/admin/nesszerra", "POST", { action: "connectChat" }, await signedIn(f)), 403);
});

test("local test mode marks chat connected without Twitch only for a loopback cf dev", async (t) => {
  const { calls } = helixMock(t);
  const f = environment(),
    owner = await signedIn(f, true),
    local = "http://127.0.0.1:5199";
  Object.assign(f.env, { MINI_LOCAL_TEST: "1", PUBLIC_ORIGIN: local });
  const connectLocal = () =>
    worker.fetch(
      new Request(local + "/api/admin/nesszerra", {
        method: "POST",
        headers: { Origin: local, Cookie: owner, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "connectChat" }),
      }),
      f.env,
    );
  assert.equal((await connectLocal()).status, 200);
  assert.match(f.forwarded.at(-1).body.subscriptionId, /^local-[a-f0-9]{16}$/);
  assert.equal(calls.length, 0, "no Twitch calls in local test mode");
  // the same flag on a public origin does nothing: production must talk to Twitch
  for (const [flag, origin, url] of [
    ["1", ORIGIN, ORIGIN],
    ["1", local, ORIGIN],
    ["true", local, local],
  ])
    assert.equal(localTestMode(asEnv({ MINI_LOCAL_TEST: flag, PUBLIC_ORIGIN: origin }), new URL(url + "/")), false);
  // an http origin without local test mode is refused before calling Twitch
  delete f.env.MINI_LOCAL_TEST;
  assert.equal((await connectLocal()).status, 400);
});

// ---------- Dev token (test site only) ----------
const DEV = "dev-token-for-tests-0123456789abcdefghij";
function devReq(path: string, data?: unknown, token = DEV) {
  return new Request("https://test.chat.miolaf.xyz" + path, {
    method: data === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
}
const dev = async (f: Fixture, ...args: Parameters<typeof devReq>) =>
  (await worker.fetch(devReq(...args), f.env)).status;

test("dev token (test site only): a missing binding, a wrong token or no token is refused", async () => {
  const f = environment();
  f.entries.set("owner:nesszerra", { id: "1" });
  // production: no DEV_TOOLS_TOKEN binding, so even a well-formed token is refused and devtools do not exist
  assert.equal(await dev(f, "/api/dev/diagnostics"), 401);
  assert.equal(
    await dev(f, "/api/devtools/nesszerra/chat", { userId: "t1", username: "testbot_a", text: "!fight" }),
    401,
  );
  const line = { userId: "t1", username: "testbot_a", text: "hi" };
  const session = await f.st("/api/devtools/nesszerra/chat", "POST", line, await signedIn(f, true));
  assert.equal(session, 404, "an owner session alone does not open devtools");
  f.env.DEV_TOOLS_TOKEN = DEV;
  assert.equal(await dev(f, "/api/dev/diagnostics", undefined, DEV.slice(0, -1) + "x"), 401);
  assert.equal(await dev(f, "/api/dev/diagnostics", undefined, "short"), 401);
  assert.equal(await f.st("/api/admin/nesszerra"), 401);
  // a token shorter than 32 characters in the binding never matches
  f.env.DEV_TOOLS_TOKEN = "x".repeat(31);
  assert.equal(await dev(f, "/api/dev/diagnostics", undefined, "x".repeat(31)), 401);
  assert.equal(f.forwarded.length, 0, "nothing reached a room");
});

test("channel export (dev token only): room tables plus mod access, for a site of its own", async () => {
  const f = environment();
  const session = await f.st("/api/devtools/miolafff/export", "GET", undefined, await signedIn(f, true));
  assert.equal(session, 404, "an owner session alone cannot export");
  f.env.DEV_TOOLS_TOKEN = DEV;
  f.entries.set("broadcaster:miolafff", { sealed: "x" });
  f.entries.set("modsconnected:miolafff", { at: 5 });
  const res = await worker.fetch(devReq("/api/devtools/miolafff/export"), f.env);
  assert.equal(res.status, 200);
  const out = await res.json<Loose>(); // Loose: the JSON reply, read by property
  assert.deepEqual(
    { channel: out.channel, tables: out.tables, auth: out.auth },
    {
      channel: "miolafff",
      tables: { path: "/export" },
      auth: { broadcaster: { sealed: "x" }, modsconnected: { at: 5 } },
    },
  );
  const last = f.forwarded.at(-1);
  assert.deepEqual([last.channel, last.options.method], ["miolafff", undefined]);
  assert.equal(await dev(f, "/api/devtools/miolafff/export", {}), 405);
});

test("dev token (test site only): the right token acts as the owner and can seed profiles and chat lines", async () => {
  const f = environment(),
    bot = { userId: "testbot:a", username: "testbot_a" };
  f.entries.set("owner:nesszerra", { id: "1" });
  f.env.DEV_TOOLS_TOKEN = DEV;
  const last = () => f.forwarded.at(-1);
  assert.equal(await dev(f, "/api/dev/diagnostics"), 200);
  assert.equal(
    await dev(f, "/api/admin/nesszerra", { action: "removePlayer", userId: "testbot:a" }),
    200,
    "no Origin needed",
  );
  assert.equal(last().body.actorId, "1");
  const settings = await dev(f, "/api/dev/settings", { action: "config", payload: { patch: { quickDuel: false } } });
  assert.notEqual(settings, 403, "dev routes skip the Origin check with a token too");
  const seeded = {
    userId: "testbot:a",
    username: "TestBot_A",
    avatar: "player",
    color: "#22aa44",
    defaultAbility: "heavy",
  };
  assert.equal(await dev(f, "/api/devtools/nesszerra/profile", seeded), 200);
  assert.deepEqual(
    [last().path, new Headers(last().options.headers).get("X-Mini-User-Id"), last().body.username],
    ["/profile", "testbot:a", "testbot_a"],
  );
  assert.equal(await dev(f, "/api/devtools/miolafff/chat", { ...bot, text: "!fight" }), 200);
  assert.deepEqual([last().channel, last().path, last().body.text], ["miolafff", "/dev-chat", "!fight"]);
  // Bots buy and bring pets through the same room calls as signed-in viewers.
  assert.equal(await dev(f, "/api/devtools/nesszerra/shop", { ...bot, kind: "pet", id: "fox" }), 200);
  assert.deepEqual([last().path, last().body], ["/shop", { userId: "testbot:a", kind: "pet", id: "fox" }]);
  // Style dollars reach the room as a whole amount; anything else stops at the Worker.
  await dev(f, "/api/devtools/nesszerra/style", { ...bot, amount: 200 });
  assert.deepEqual([last().path, last().body], ["/dev-style", { userId: "testbot:a", amount: 200 }]);
  await dev(f, "/api/devtools/nesszerra/profile", { ...bot, pet: "fox" });
  assert.equal(last().body.pet, "fox");
  for (const [path, data, code] of [
    ["nesszerra/profile", { userId: "bad id!", username: "x" }, 400],
    ["nesszerra/profile", { userId: "t", username: "x", color: "red" }, 400],
    ["somechannel/chat", { userId: "t", username: "x", text: "hi" }, 403],
    ["nesszerra/nope", {}, 404],
    ["nesszerra/shop", { ...bot, kind: "car", id: "fox" }, 400],
    ["nesszerra/style", { ...bot, amount: 1.5 }, 400],
    ["nesszerra/style", { ...bot, amount: "200" }, 400],
    ["nesszerra/style", { ...bot, amount: 100001 }, 400],
    ["nesszerra/profile", { ...bot, pet: 7 }, 400],
  ] as const)
    assert.equal(await dev(f, "/api/devtools/" + path, data), code, path + " " + JSON.stringify(data));
});

test("dev token binding: declared for the test deploy only, never for production", async () => {
  const { default: config } = await import("../cloudflare.config.ts");
  // only the mode is read here; isPreview stays unset as before
  const env = (mode?: string) => config({ mode } as Parameters<typeof config>[0]).worker.env;
  assert.ok("DEV_TOOLS_TOKEN" in env("test"));
  assert.ok(!("DEV_TOOLS_TOKEN" in env(undefined)));
  assert.ok(!("DEV_TOOLS_TOKEN" in env("production")));
});

test("pets: the catalog and images are public; uploads and deletes need a mod; the shop needs sign-in", async () => {
  const f = environment(),
    last = () => f.forwarded.at(-1);
  assert.equal(await f.st("/api/pets/nesszerra"), 200);
  assert.equal(last().path, "/pets");
  await f.st("/api/pets/nesszerra/p-blob-abc123");
  assert.equal(last().path, "/pets/p-blob-abc123");
  assert.equal(await f.st("/api/pets/nesszerra", "POST", {}), 401);
  assert.equal(await f.st("/api/pets/nesszerra", "POST", {}, await signedIn(f)), 403);
  const owner = await signedIn(f, true),
    sent = f.forwarded.length;
  assert.equal(
    (await f.json("/api/pets/nesszerra", "POST", { label: "Blob", tier: "mythic" }, owner)).reason,
    "invalid_tier",
  );
  assert.equal(
    await f.st("/api/pets/nesszerra/fox", "DELETE", undefined, owner),
    404,
    "built-in pets cannot be deleted",
  );
  assert.equal(f.forwarded.length, sent, "rejected uploads and deletes never reach the room");
  assert.equal(await f.st("/api/pets/nesszerra/p-blob-abc123", "DELETE", undefined, owner), 200);
  assert.equal(last().path, "/pets/p-blob-abc123");

  assert.equal(await f.st("/api/shop/nesszerra", "POST", { kind: "pet", id: "fox" }), 401);
  const viewer = await signedIn(f);
  const shop = (body: object) => f.st("/api/shop/nesszerra", "POST", body, viewer),
    save = (body: object) => f.st("/api/profile/nesszerra", "POST", { ...basic, ...body }, viewer);
  for (const body of [
    { kind: "car", id: "fox" },
    { kind: "pet", id: "x".repeat(65) },
    ...["30", -1, 1.5, null].map((price) => ({ kind: "pet", id: "fox", price })),
  ])
    assert.equal(await shop(body), 400, JSON.stringify(body));
  assert.equal(await f.st("/api/shop/nesszerra", "GET"), 200, "the shop list is public");
  assert.equal(last().path, "/shop");
  assert.equal(await f.st("/api/shop/nesszerra/x", "GET"), 405);
  assert.equal(await shop({ kind: "trail", id: "flames" }), 200);
  assert.equal(await shop({ kind: "slot" }), 200);
  assert.deepEqual(last().body, { userId: "2", kind: "slot", id: "" });
  assert.equal(await shop({ kind: "pet", id: "fox", userId: "forged" }), 200);
  assert.deepEqual([last().path, last().body], ["/shop", { userId: "2", kind: "pet", id: "fox" }]);
  assert.equal(await save({ pet: 7 }), 400);
  assert.equal(await save({ pet: "fox" }), 200);
  assert.equal(last().body.pet, "fox");
  // Cosmetics and the build slot ride along; the room checks ownership.
  for (const bad of [{ title: 7 }, { trail: "x".repeat(33) }, { build: 5 }, { build: 1.5 }, { build: "1" }])
    assert.equal(await save(bad), 400, JSON.stringify(bad));
  assert.equal(await save({ title: "legend", winEffect: "", build: 2 }), 200);
  const { title, winEffect, build, trail } = last().body;
  assert.deepEqual([title, winEffect, build, trail], ["legend", "", 2, undefined]);
});

// ---------- PixFray chat bot (CHAT_BOT) ----------
const botBody = (text: string): ChatBody => ({
  subscription: {
    id: "sub-bot",
    status: "enabled",
    type: "channel.chat.message",
    condition: { broadcaster_user_id: "1", user_id: "99" },
  },
  event: {
    broadcaster_user_id: "1",
    broadcaster_user_login: "nesszerra",
    chatter_user_id: "7",
    chatter_user_login: "viewer",
    chatter_user_name: "Viewer",
    message_id: "chat-9",
    message: { text },
  },
});
/** The bot's fixture: rooms answer every command with `reply`, Helix accepts every chat post. */
function botEnvironment(t: TestContext, reply: string) {
  t.mock.method(Date, "now", () => NOW);
  const f = environment(),
    waits: Promise<unknown>[] = [],
    helix: Loose[] = []; // Loose: Helix posts the test reads by property
  f.rooms(async (channel, url, options) => {
    f.forwarded.push({ channel, url, body: JSON.parse(String(options.body)) }); // bot commands always carry a body
    return Response.json({ ok: true, reply });
  });
  twitchApi(t, (url, init) => {
    helix.push({ url: String(url), body: JSON.parse(String(init.body)) }); // Helix chat posts always carry a body
    return Response.json({ data: [{ message_id: "r1", is_sent: true }] });
  });
  const ctx = asExecutionContext({ waitUntil: (p) => waits.push(p) });
  const post = (body: object, type = "notification") =>
    eventsub(f, body, { type, origin: "https://staging.pixfray.xyz", ctx });
  return { f, waits, helix, post };
}

test("chat bot: only commands reach the room; its reply is sent as the bot, threaded, never as a command", async (t) => {
  const { f, waits, helix, post } = botEnvironment(t, "!ranks are at pixfray");
  assert.equal((await post(botBody("hello chat"))).status, 204);
  assert.equal(f.forwarded.length, 0, "plain chat costs no room request");
  assert.equal((await post(botBody("  !ranks"))).status, 204);
  assert.equal(f.forwarded.length, 1);
  assert.deepEqual([f.forwarded[0].body.bot, f.forwarded[0].body.botId], [true, "99"]);
  assert.match(f.forwarded[0].url, /\/eventsub\?origin=https%3A%2F%2F/);
  await Promise.all(waits);
  assert.equal(helix.length, 1);
  assert.equal(helix[0].url, "https://api.twitch.tv/helix/chat/messages");
  assert.deepEqual(helix[0].body, {
    broadcaster_id: "1",
    sender_id: "99",
    message: "PixFray: !ranks are at pixfray",
    reply_parent_message_id: "chat-9",
  });
  // what Twitch said goes back to the room, for the bot status and the owner log
  await Promise.all(waits);
  assert.equal(f.forwarded.length, 2);
  assert.match(f.forwarded[1].url, /\/bot-sent$/);
  assert.deepEqual(f.forwarded[1].body, { results: [{ sent: true, reason: "" }] });
});

test("chat bot: drop reasons read as words", () => {
  assert.equal(botDropText("msg_duplicate"), "the same line twice within 30 s (msg_duplicate)");
  assert.match(botDropText("Twitch send chat message failed (403)"), /may not chat here \(403\)/);
  assert.equal(botDropText("Twitch send chat message failed (500)"), "Twitch send chat message failed (500)");
  assert.equal(botDropText(""), "unknown");
  for (const key of ["constructor", "__proto__", "toString"]) assert.equal(botDropText(key), key);
});

test("chat bot: a signed-up channel gets its verification, and the bot answers on its own channel", async (t) => {
  const { f, waits, helix, post } = botEnvironment(t, "solo has 1000 elo");
  f.env.CHAT_BOT = "1";
  f.entries.set("channel:solo", { id: "42", login: "solo", enabledAt: NOW });
  f.entries.set("bot:twitch", { id: "42", login: "solo" });
  const condition = { broadcaster_user_id: "42", user_id: "42" };
  const verify = await post(
    {
      subscription: {
        id: "sub-solo",
        status: "webhook_callback_verification_pending",
        type: "channel.chat.message",
        condition,
      },
      challenge: "abc",
    },
    "webhook_callback_verification",
  );
  assert.equal(await verify.text(), "abc");
  assert.deepEqual(
    f.forwarded.map((x) => x.channel),
    ["nesszerra", "miolafff", "solo"],
    "the signed-up room hears its verification",
  );
  f.forwarded.length = 0;
  const line = (login: string, text: string) => {
    const body = botBody(text);
    body.subscription = { id: "sub-solo", status: "enabled", type: "channel.chat.message", condition };
    Object.assign(body.event, { broadcaster_user_id: "42", broadcaster_user_login: login, chatter_user_id: "42" });
    Object.assign(body.event, { chatter_user_login: "solo", chatter_user_name: "solo", message_id: "chat-42" });
    return body;
  };
  assert.equal((await post(line("stranger", "!elo"))).status, 204);
  assert.equal(f.forwarded.length, 0, "a channel that never signed up is ignored");
  assert.equal((await post(line("solo", "!elo"))).status, 204);
  assert.equal(f.forwarded.length, 1);
  assert.equal(f.forwarded[0].channel, "solo");
  assert.equal(f.forwarded[0].body.bot, true, "the bot is also the broadcaster here");
  assert.equal(f.forwarded[0].body.botId, "42");
  await Promise.all(waits);
  assert.deepEqual(
    helix.map((x) => x.body.sender_id),
    ["42"],
  );
});

test("chat bot: Connect chat subscribes as the signed-in bot account, and asks for it first", async (t) => {
  const f = environment();
  Object.assign(f.env, { CHAT_BOT: "1", BOT_LOGIN: "pixbot", OWNER_TWITCH_ID: "1" });
  const helix = helixMock(t, {
    subscriptions: [
      sub("broadcaster-self"),
      sub("other-channel", { condition: { broadcaster_user_id: "5", user_id: "99" } }),
    ],
  });
  const first = await connect(f);
  assert.equal(first.status, 409);
  assert.match(first.body.error, /\/auth\/login\?bot=1/);
  f.entries.set("bot:twitch", { id: "99", login: "pixbot" });
  assert.equal((await connect(f)).status, 200);
  assert.deepEqual(helix.created()[0].body.condition, { broadcaster_user_id: "1", user_id: "99" });
  assert.deepEqual(
    helix.deleted(),
    ["broadcaster-self"],
    "the channel's old self-read subscription goes; another channel's bot subscription stays",
  );
  const view = await f.json("/api/admin/nesszerra", "GET", undefined, await signedIn(f, true));
  assert.deepEqual(view.chatBot, { login: "pixbot", debug: false });
});

test("chat bot: bot sign-in needs CHAT_BOT and asks for the chat scopes", async () => {
  const f = environment();
  const scope = async (path: string) =>
    new URL(must((await worker.fetch(req(path), f.env)).headers.get("Location"))).searchParams.get("scope");
  assert.equal(await f.st("/auth/login?bot=1"), 403);
  Object.assign(f.env, { CHAT_BOT: "1", BOT_LOGIN: "pixbot" });
  assert.equal(await f.st("/auth/login?bot=1"), 302);
  assert.equal(await scope("/auth/login?bot=1"), "user:read:chat user:write:chat user:bot");
  assert.equal(await scope("/auth/login?channel=nesszerra&connect=bot"), "moderation:read channel:bot");
});

/** Answers each Helix chat post with the next queued reply; `sent` records the lines posted. */
function chatPosts(t: TestContext, next: () => Response) {
  const sent: string[] = [];
  twitchApi(t, (_, init) => {
    sent.push(JSON.parse(String(init.body)).message); // chat posts always carry a body
    return next();
  });
  return sent;
}
const delivered = (id = "r1") => Response.json({ data: [{ message_id: id, is_sent: true }] });

test("chat bot: a rate-limited reply (429) is retried after a short wait, then gives up", async (t) => {
  const f = environment(),
    waits: number[] = [];
  let statuses = [429, 200];
  chatPosts(t, () => {
    const code = must(statuses.shift()); // the test queues one status per call
    return code === 200 ? delivered() : new Response("{}", { status: code });
  });
  const send = () =>
    sendChatMessage(f.env, {
      broadcasterId: "1",
      senderId: "99",
      message: "hi",
      replyTo: "m1",
      sleep: async (ms) => waits.push(ms),
    });
  assert.deepEqual(await send(), { sent: true, reason: "" });
  assert.deepEqual(waits, [1100]);
  statuses = [429, 429, 429];
  await assert.rejects(send(), /\(429\)/);
  assert.deepEqual(waits, [1100, 1100, 2200]);
});

test("chat bot: a line Twitch drops as a duplicate is resent with an invisible tag character, at most twice", async (t) => {
  const f = environment();
  let dupes = 1;
  const sent = chatPosts(t, () =>
    dupes-- > 0
      ? Response.json({ data: [{ message_id: "", is_sent: false, drop_reason: { code: "msg_duplicate" } }] })
      : delivered(),
  );
  const send = () =>
    sendChatMessage(f.env, { broadcasterId: "1", senderId: "99", message: "PixFray help", replyTo: "m1" });
  assert.deepEqual(await send(), { sent: true, reason: "" });
  assert.deepEqual(sent, ["PixFray help", "PixFray help \u{E0000}"]);
  sent.length = 0;
  dupes = 9;
  assert.deepEqual(await send(), { sent: false, reason: "msg_duplicate" });
  assert.deepEqual(sent, ["PixFray help", "PixFray help \u{E0000}", "PixFray help \u{E0000}\u{E0000}"]);
});

test("chat bot: several reply lines go out in order, about a second apart, and one failure does not stop the rest", async (t) => {
  const f = environment(),
    waits: number[] = [];
  let first = true;
  const sent = chatPosts(t, () => (first ? ((first = false), new Response("{}", { status: 500 })) : delivered("r")));
  const out = await sendChatMessages(f.env, {
    broadcasterId: "1",
    senderId: "99",
    replyTo: "m1",
    messages: ["one", "two", "three"],
    sleep: async (ms) => waits.push(ms),
  });
  assert.deepEqual(sent, ["one", "two", "three"]);
  assert.deepEqual(waits, [1100, 1100]);
  assert.deepEqual(
    out.map((r) => r.sent),
    [false, true, true],
  );
});

test("check-in test mode: a mod or the owner turns it on, only on the site channel; viewers cannot", async () => {
  const f = environment(),
    on = { action: "checkinTest", value: true };
  assert.equal(await f.st("/api/admin/nesszerra", "POST", on, await signedIn(f)), 403);
  const other = await call(f.env, "/api/admin/miolafff", "POST", on, await signedIn(f, true));
  assert.equal(other.status, 403);
  assert.match(other.body.error, /only for nesszerra's channel/);
  assert.equal(
    f.forwarded.some((x) => x.path === "/checkin-test"),
    false,
  );
  assert.equal(await f.st("/api/admin/nesszerra", "POST", on, await signedIn(f, true)), 200);
  assert.deepEqual(f.forwarded.find((x) => x.path === "/checkin-test").body, { on: true, by: "nesszerra" });
});

test("viewer sprites: only the owner may wear one; sends need sign-in, reviews need a mod, AI redraw refunds on failure", async () => {
  const f = environment(),
    cookie = await signedIn(f);
  f.rooms(async (channel, url, options, next) => {
    const path = new URL(url).pathname;
    if (path === "/catalog")
      return Response.json([
        { id: "v-mine-aaaaaa", owner: "2" },
        { id: "v-theirs-bbbbbb", owner: "9" },
      ]);
    if (path !== "/sprites/ai") return next(channel, url, options);
    f.forwarded.push({ path, body: JSON.parse(String(options.body)) }); // redraw calls always carry a body
    return Response.json({ ok: true, left: 2 });
  });
  const save = (avatar: string) => call(f.env, "/api/profile/nesszerra", "POST", { ...look, avatar }, cookie);
  assert.equal((await save("v-mine-aaaaaa")).status, 200);
  const theirs = await save("v-theirs-bbbbbb");
  assert.deepEqual([theirs.status, theirs.body.error], [403, "That sprite belongs to another viewer"]);
  assert.deepEqual(f.forwarded.filter((x) => x.path === "/dev/log").at(-1)?.body, {
    source: "warn",
    message: "viewer profile not saved: sprite_not_owned",
    context: { channel: "nesszerra", action: "save", userId: "2", user: "viewer", reason: "sprite_not_owned" },
  });

  assert.equal(await f.st("/api/sprite/nesszerra"), 401);
  assert.deepEqual((await f.json("/api/sprite/nesszerra", "GET", undefined, cookie)).ai, { available: false, left: 0 });
  // The room gets the session's identity, never one from the body.
  const png = "data:image/png;base64," + b64png(32, 48);
  assert.equal(await f.st("/api/sprite/nesszerra", "POST", { label: "Cat", image: png, userId: "1" }, cookie), 200);
  const { userId, username, label } = f.forwarded.at(-1).body;
  assert.deepEqual({ userId, username, label }, { userId: "2", username: "viewer", label: "Cat" });
  assert.equal(await f.st("/api/sprite/nesszerra", "POST", { label: "Cat", image: b64png(200, 20) }, cookie), 400);
  // Mods only: the review list and actions.
  assert.equal(await f.st("/api/sprites/nesszerra", "GET", undefined, cookie), 403);
  assert.equal(await f.st("/api/sprites/nesszerra/v-mine-aaaaaa", "POST", { action: "approve" }, cookie), 403);

  // AI redraw: off without the binding; with it, a failed model call gives the redraw back.
  const redraw = (w: number) => call(f.env, "/api/sprite/nesszerra/redraw", "POST", { image: b64png(w, 64) }, cookie);
  assert.equal((await redraw(64)).status, 503);
  let input: Loose = null; // Loose: set by the fake model below, read after the call
  const ai = (
    run: (model: string, options: { multipart: { contentType: string } }) => Promise<object>,
  ): Partial<Env> => ({
    AI: { run } as unknown as Ai, // a fake with only run, the one Ai call the redraw makes
  });
  Object.assign(
    f.env,
    ai(async (model, { multipart }) => {
      input = { model, type: multipart.contentType };
      return { image: "QUJD" };
    }),
  );
  assert.deepEqual((await redraw(64)).body, { ok: true, image: "QUJD", left: 2 });
  assert.equal(input.model, "@cf/black-forest-labs/flux-2-klein-4b");
  assert.match(input.type, /^multipart\/form-data/);
  assert.equal((await redraw(512)).status, 400);
  Object.assign(
    f.env,
    ai(async () => {
      throw new Error("capacity");
    }),
  );
  assert.equal((await redraw(64)).status, 502);
  assert.deepEqual(
    f.forwarded.filter((x) => x.path === "/sprites/ai").map((x) => x.body.op),
    ["take", "take", "refund"],
  );
});
