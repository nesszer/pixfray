import { ChannelRoom } from "./channel.ts";
import site from "../site.config.js";
import {
  AuthStore,
  record,
  session,
  isOwner,
  configured,
  handleAuth,
  access,
  CHANNELS,
  touchBroadcaster,
  markModsConnected,
  unseal,
  POINTS_SCOPE,
} from "./auth.ts";
import { handleDeveloper, logWorkerError } from "./developer.ts";
import { backupChannels } from "./backups.ts";
import { handleUploads } from "./uploads.ts";
import { handlePets } from "./pets.ts";
import { handleSprites } from "./sprites.ts";
import {
  createReward,
  deleteReward,
  markRedemption,
  pointsLoginUrl,
  rewardProblem,
  MAX_POINT_REWARDS,
} from "./points.ts";
import type { PointReward } from "./points.ts";
import {
  EVENTSUB_PATH,
  BOT_LOGIN_URL,
  handleEventsub,
  connectChat,
  disconnectChat,
  sendChatMessages,
  twitchUserId,
} from "./eventsub.ts";
import { handleStreamElements, seCommandLines, seHelpText, SE_SUBSCRIPTION_ID } from "./streamelements.ts";
import { channelState, isOn, offError, setPaused, publicChannels, listRecords, isFull } from "./channels.ts";
import { parseAdminBody, parseDevAccount, parseDevLive, parseProfileSave, parseShopBuy } from "./parse.ts";
import { siteOrigin, channelPageRedirect, isPage } from "./hosts.ts";
import { secure, PAGE_CSP, API_CSP } from "./security.ts";
import { writeLimit } from "./ratelimit.ts";
import type { Env } from "./env.ts";
import type { TwitchUser } from "./auth.ts";
import type { SeSettings } from "./channel.ts";
import type { ChatStatus } from "./game.ts";
export { ChannelRoom, AuthStore };
import type { JsonObject } from "./parse.ts";
/** What bodyJson, setPaused and chatAction throw: an Error with the HTTP status to answer and chat details. */
type HttpError = Error & { status?: number; reason?: string; reconnect?: unknown; connectedElsewhere?: unknown };

/** A built-in or uploaded catalog entry (the fields read here). */
type CatalogEntry = { id: string; owner?: string; [field: string]: unknown };
/** A leaderboard row (the fields read here). */
type BoardRow = { displayName: string; username: string; elo: number; avatar: string; wins: number; losses: number };
/** The viewer's base look on another channel (fightersElsewhere). */
type Fighter = { channel: string; avatar: string; color: unknown; defaultAbility: unknown; lastSeen: number };
/** A saved profile as the room's GET /profile returns it (the fields read here). */
type SavedLook = { avatar?: unknown; color?: unknown; defaultAbility?: unknown; lastSeen?: unknown } | null;
/** The /play/ picker reply. */
type PickerData = {
  channels: {
    login: string;
    top: Pick<BoardRow, "displayName" | "username" | "elo" | "avatar">[];
    catalog?: CatalogEntry[];
  }[];
  catalog: CatalogEntry[];
  full: boolean;
};
/** The room's admin reply (the fields read here). */
type AdminReply = { streamelements?: Partial<SeSettings> | null; [field: string]: unknown };
// A turned-off channel keeps its admin page (to turn it back on) and its public lists; the overlay feed, the viewer
// page's state and profile saves are refused.
const OPEN_WHEN_PAUSED = ["access", "admin", "leaderboard", "catalog", "assets", "pets", "sprites"];
const WRITE_ROUTES = ["profile", "shop", "assets", "pets", "admin", "sprite", "sprites"];
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
// Raw call into a ChannelRoom. Adds the internal secret and channel binding; the caller owns method/body.
function roomFetch(request: Request | null, env: Env, channel: string, path: string, init: RequestInit = {}) {
  const h = new Headers(init.headers || {});
  h.set("X-Mini-Internal", env.INTERNAL_SECRET);
  h.set("X-Mini-Channel", channel);
  if (request?.headers.get("Upgrade")) {
    h.set("Upgrade", "websocket");
    const ip = request.headers.get("CF-Connecting-IP");
    if (ip) h.set("X-Mini-Client-Ip", ip);
  }
  return env.ROOMS.get(env.ROOMS.idFromName(channel)).fetch("https://room" + path, { ...init, headers: h });
}
// Fighters are saved per channel. AuthStore `fighters:<userId>` lists the channels a viewer saved one on, newest first,
// so a channel where they have none yet can offer the look they use elsewhere (GET /api/profile/:channel/others).
const FIGHTER_INDEX_MAX = 8,
  FIGHTER_INDEX_MS = 90 * 86400000,
  OTHERS_MAX = 5; // AuthStore keeps keys like this at most 100 days
async function rememberFighter(env: Env, userId: string, channel: string) {
  const prev = (await record<{ channels?: string[] } | null>(env, "fighters:" + userId))?.channels || []; // rewritten on every save, so the expiry moves with it
  await record(
    env,
    "fighters:" + userId,
    { channels: [channel, ...prev.filter((c) => c !== channel)].slice(0, FIGHTER_INDEX_MAX) },
    Date.now() + FIGHTER_INDEX_MS,
  );
}
// The viewer's base look (character, color, ability) on their other channels, newest save first. The built-in channels
// are always checked, since fighters saved before the index existed aren't in it. Gear stays per channel.
async function fightersElsewhere(request: Request, env: Env, user: TwitchUser, channel: string) {
  const indexed = (await record<{ channels?: string[] } | null>(env, "fighters:" + user.id))?.channels || [];
  const candidates = [...new Set([...indexed, ...CHANNELS])]
    .filter((c) => c !== channel && /^[a-z0-9_]{1,25}$/.test(c))
    .slice(0, OTHERS_MAX);
  const found = await Promise.all(
    candidates.map(async (c) => {
      try {
        const st = await channelState(env, c);
        if (!isOn(st) && st !== "paused") return null;
        const r = await internal(request, env, c, "/profile?userId=" + encodeURIComponent(user.id));
        if (!r.ok) return null;
        const p = await r.json<SavedLook>();
        if (!p || typeof p.avatar !== "string") return null;
        return {
          channel: c,
          avatar: p.avatar,
          color: p.color,
          defaultAbility: p.defaultAbility,
          lastSeen: Number(p.lastSeen) || 0,
        };
      } catch {
        return null;
      }
    }),
  );
  // filter(Boolean) drops the nulls
  return (found.filter(Boolean) as Fighter[]).sort((a, b) => b.lastSeen - a.lastSeen);
}
function internal(request: Request, env: Env, channel: string, path: string, body?: JsonObject) {
  const h: { [name: string]: string } = {};
  // a Twitch id string from the session or a checked profile; /admin spreads the client's data first, so a userId
  // there is whatever the page sent, and the room reads actorId instead
  if (body?.userId) h["X-Mini-User-Id"] = body.userId as string;
  else if (body?.actorId) h["X-Mini-User-Id"] = body.actorId as string; // as above
  if (body !== undefined) h["Content-Type"] = "application/json";
  return roomFetch(request, env, channel, path, {
    method: body === undefined ? "GET" : "POST",
    headers: h,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
// A save refused here never reaches the room, so log it there as the room logs its own refusals (owner log, warn row).
async function refuseSave(
  request: Request,
  env: Env,
  channel: string,
  user: TwitchUser,
  reason: string,
  error: string,
  status: number,
) {
  await internal(request, env, channel, "/dev/log", {
    source: "warn",
    message: `${user.login} profile not saved: ${reason}`,
    context: { channel, action: "save", userId: user.id, user: user.login, reason },
  }).catch(() => {});
  return json({ error }, status);
}
async function bodyJson(request: Request, limit = 2200000): Promise<JsonObject> {
  if (Number(request.headers.get("Content-Length")) > limit)
    throw Object.assign(new Error("Request too large"), { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > limit) {
      await reader.cancel();
      throw Object.assign(new Error("Request too large"), { status: 413 });
    }
    chunks.push(value);
  }
  const raw = new Uint8Array(bytes);
  let p = 0;
  for (const v of chunks) {
    raw.set(v, p);
    p += v.length;
  }
  let value;
  try {
    value = bytes ? JSON.parse(new TextDecoder().decode(raw)) : {};
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Object.assign(new Error("JSON object required"), { status: 400 });
  return value;
}
// Chat source lifecycle (owner or mod via /api/admin, owner via /api/dev). The room only records the outcome.
// Channel point rewards (server/points.ts): Twitch first, then the room. A reward the room refuses is removed again.
async function pointsAction(
  env: Env,
  url: URL,
  channel: string,
  action: "createPointReward" | "deletePointReward",
  data: JsonObject,
  actor: string,
): Promise<Response> {
  const room = (path: string, body?: JsonObject) =>
    roomFetch(
      null,
      env,
      channel,
      path,
      body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {},
    );
  const { rewards } = await (await room("/points")).json<{ rewards: PointReward[] }>();
  if (action === "deletePointReward") {
    const reward = rewards.find((r) => r.rewardId === data.rewardId);
    if (!reward) return json({ ok: false, reason: "reward_not_found", error: "reward_not_found" }, 404);
    await deleteReward(env, { channel, rewardId: reward.rewardId, subscriptionId: reward.subscriptionId, url });
    return room("/points/rewards", { op: "remove", rewardId: reward.rewardId, actor });
  }
  const { cost, dollars } = data,
    title = typeof data.title === "string" ? data.title.trim() : data.title;
  const problem = rewardProblem(title, cost, dollars);
  if (problem) return json({ ok: false, reason: problem, error: problem }, 400);
  if (rewards.length >= MAX_POINT_REWARDS)
    return json({ ok: false, reason: "points_max_rewards", error: "points_max_rewards" }, 409);
  const reward = await createReward(env, {
    channel,
    title: title as string, // rewardProblem checked these three
    cost: cost as number,
    dollars: dollars as number,
    origin: siteOrigin(env, url, channel),
    url,
  });
  const r = await room("/points/rewards", { op: "add", reward, actor });
  if (!r.ok)
    await deleteReward(env, { channel, rewardId: reward.rewardId, subscriptionId: reward.subscriptionId, url }).catch(
      (e) => console.warn("point reward undo failed", e?.message),
    );
  return r;
}

async function chatAction(
  env: Env,
  url: URL,
  channel: string,
  action: string,
  { takeover = false }: { takeover?: boolean } = {},
): Promise<Response> {
  const room = (path: string, body?: JsonObject) =>
    roomFetch(
      null,
      env,
      channel,
      path,
      body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {},
    );
  const current = await (await room("/chat")).json<ChatStatus>();
  if (action === "connectChat" && env.SE_ONLY === "1")
    throw Object.assign(new Error("This site uses StreamElements for chat. Choose Use StreamElements."), {
      status: 400,
    });
  if (action === "useStreamElements") {
    if (current.subscriptionId && current.subscriptionId !== SE_SUBSCRIPTION_ID)
      await disconnectChat(env, { subscriptionId: current.subscriptionId, url });
    return room("/chat", {
      action: "connected",
      subscriptionId: SE_SUBSCRIPTION_ID,
      status: "enabled",
      createdAt: Date.now(),
    });
  }
  if (action === "disconnectChat") {
    await disconnectChat(env, { subscriptionId: current.subscriptionId, url });
    return room("/chat", { action: "disconnected", reason: "disconnected" });
  }
  // CHAT_BOT (test site): chat is read and answered by the PixFray bot account (bot:twitch, signed in at /auth/login?bot=1).
  if (env.CHAT_BOT === "1") {
    const bot = await record<{ id?: string } | null>(env, "bot:twitch");
    if (!bot?.id)
      throw Object.assign(new Error("Sign in the PixFray bot account first at " + BOT_LOGIN_URL), {
        status: 409,
        reconnect: BOT_LOGIN_URL,
      });
    const broadcasterId =
      (channel === site.defaultChannel && env.OWNER_TWITCH_ID) || (await twitchUserId(env, channel));
    if (!broadcasterId) throw Object.assign(new Error("Twitch has no channel named " + channel), { status: 404 });
    const sub = await connectChat(env, {
      broadcasterId,
      userId: bot.id,
      channel,
      origin: env.PUBLIC_ORIGIN || url.origin,
      url,
      takeover,
    });
    return room("/chat", { action: "connected", ...sub });
  }
  const broadcasterId =
    env.OWNER_TWITCH_ID || (await record<{ id?: string } | null>(env, "owner:" + channel))?.id || "";
  const sub = await connectChat(env, { broadcasterId, origin: env.PUBLIC_ORIGIN || url.origin, url, takeover });
  return room("/chat", { action: "connected", ...sub });
}
// Pages pass through the Worker (run_worker_first), and public/_headers doesn't reach responses a Worker returns,
// so the page headers are set here: no framing by other sites (clickjacking), and the staging and test sites stay out of search.
// The home page (/) is the intro; with ?channel= it is that channel's fighter page. /play/ is the channel picker (the
// viewer page without a channel), and /intro/ was the intro's old address.
async function page(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname,
    channel = url.searchParams.get("channel");
  if (/^\/intro(\/(index\.html)?)?$/.test(path)) return Response.redirect(url.origin + "/" + url.search, 301);
  if (path === "/play") return Response.redirect(url.origin + "/play/" + url.search, 301);
  if (path === "/changelog") return Response.redirect(url.origin + "/changelog/", 301);
  if (path === "/play/" && channel) return Response.redirect(url.origin + "/" + url.search, 302);
  if (path === "/admin/" && !channel) {
    const own = await ownAdmin(request, env, url);
    if (own) return Response.redirect(own, 302);
  }
  const doc = path === "/" && !channel ? "/intro/" : path === "/play/" ? "/" : "";
  const r = await env.ASSETS.fetch(doc ? new Request(url.origin + doc, request) : request);
  if (!isPage(path)) return r;
  const out = new Response(r.body, r);
  out.headers.set("Content-Security-Policy", PAGE_CSP);
  out.headers.set("X-Frame-Options", "DENY");
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (/^(staging|test)\./.test(url.hostname)) out.headers.set("X-Robots-Tag", "noindex, nofollow");
  return out;
}
// The bare mod page (/admin/ without ?channel=) for a signed-in streamer: their own channel's controls. Decided here,
// so the page doesn't load once to find out and then jump. Anyone else gets the page's sign-in or set-up message.
async function ownAdmin(request: Request, env: Env, url: URL): Promise<string | null> {
  if (!env.AUTH_SECRET || !env.INTERNAL_SECRET) return null;
  try {
    const user = (await session(request, env))?.user;
    if (!user?.login) return null;
    const st = await channelState(env, user.login);
    if (!isOn(st) && st !== "paused") return null;
    if (!(await access(env, user, user.login)).canManage) return null;
    const to = new URL(url);
    to.searchParams.set("channel", user.login);
    return to.href;
  } catch {
    return null;
  }
}
// robots.txt and sitemap.xml follow the host: the production site lists its public pages, and the test site stays out of search.
const PUBLIC_PAGES = ["/", "/play/", "/start/", "/changelog/"];
function seoFile(url: URL, path: string): Response {
  const text = (body: string, type: string) =>
    new Response(body, {
      headers: { "Content-Type": type + "; charset=utf-8", "Cache-Control": "public, max-age=3600" },
    });
  const main = url.origin === site.origins.production;
  if (path === "/sitemap.xml") {
    if (!main) return new Response("Not found", { status: 404 });
    return text(
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        PUBLIC_PAGES.map((p) => "  <url><loc>" + url.origin + p + "</loc></url>\n").join("") +
        "</urlset>\n",
      "application/xml",
    );
  }
  if (url.origin === site.origins.test || /^(staging|test)\./.test(url.hostname))
    return text("User-agent: *\nDisallow: /\n", "text/plain");
  return text(
    "User-agent: *\nDisallow: /api/\nDisallow: /auth/\n" + (main ? "\nSitemap: " + url.origin + "/sitemap.xml\n" : ""),
    "text/plain",
  );
}
// Admin-only view of the StreamElements setup: the key and the paste-ready command replies.
function seView(env: Env, url: URL, channel: string, se: Partial<SeSettings> | null | undefined) {
  if (!se?.secret) return null;
  const origin = siteOrigin(env, url, channel);
  return {
    key: se.secret,
    names: se.names,
    origin,
    lastCommandAt: se.lastCommandAt || 0,
    rejectedAt: se.rejectedAt || 0,
    seen: se.seen || {},
    duelModuleOff: !!se.duelModuleOff,
    commands: seCommandLines(origin, channel, se.secret, se.names),
    timerText: seHelpText({ names: se.names, origin, channel }),
  };
}
// Test site only: DEV_TOOLS_TOKEN is declared only by `cf deploy --mode test`, and only the test secrets file holds it
// (cf deploy uploads every key in the file, declared or not), so production has no token to match.
// A matching "Authorization: Bearer" acts as the owner, for scripts/devtools.ts (docs/DEVTOOLS.md).
async function devToken(request: Request, env: Env): Promise<boolean> {
  const m = /^Bearer ([A-Za-z0-9_-]{32,200})$/.exec(request.headers.get("Authorization") || "");
  if (!env.DEV_TOOLS_TOKEN || env.DEV_TOOLS_TOKEN.length < 32 || !m) return false;
  const hash = async (v: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  const [a, b] = await Promise.all([hash(m[1]!), hash(env.DEV_TOOLS_TOKEN)]); // the pattern has one group
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!; // both are 32-byte SHA-256 digests
  return diff === 0;
}
async function devUser(env: Env): Promise<TwitchUser | null> {
  const id = env.OWNER_TWITCH_ID || (await record<{ id?: string } | null>(env, "owner:" + site.owner.login))?.id || "";
  return id ? { id, login: site.owner.login, displayName: site.owner.login + " (dev token)" } : null;
}
// Dev-token routes: save a profile for any account (test bots, an alt), or feed one chat line through the room as if
// Twitch had delivered it. The room repeats the DEV_TOOLS_TOKEN check.
async function handleDevtools(
  request: Request,
  env: Env,
  channel: string,
  action: string,
  data: JsonObject,
): Promise<Response> {
  // {live:true} starts a pretend stream for !checkin (a new stream id each time), {live:false} ends it, {live:null} asks Twitch again.
  if (action === "live") {
    const live = parseDevLive(data);
    if (!live.ok) return json({ error: live.error }, 400);
    return roomFetch(null, env, channel, "/dev-live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ live: live.value.live, streamId: live.value.streamId.slice(0, 40) }),
    });
  }
  const account = parseDevAccount(data);
  if (!account.ok) return json({ error: account.error }, 400);
  const userId = account.value.userId,
    username = account.value.username.toLowerCase(),
    displayName = (account.value.displayName || username).slice(0, 48);
  if (!/^[a-zA-Z0-9_:-]{1,64}$/.test(userId) || !/^[a-z0-9_]{1,25}$/.test(username))
    return json({ error: "userId and username required" }, 400);
  if (action === "profile") {
    // The dev tools may leave the look out (a plain fighter), and never send upgrades or a hat.
    const look = parseProfileSave({
      ...data,
      avatar: data.avatar === undefined ? "player" : data.avatar,
      color: data.color === undefined ? "#4FA3FF" : data.color,
      defaultAbility: data.defaultAbility === undefined ? "strike" : data.defaultAbility,
      stats: undefined,
      hat: undefined,
    });
    if (!look.ok) return json({ error: "Invalid profile fields" }, 400);
    const { avatar, color, defaultAbility, pet, loadout } = look.value;
    return internal(request, env, channel, "/profile", {
      userId,
      username,
      displayName,
      avatar,
      color,
      defaultAbility,
      pet,
      ...loadout,
    });
  }
  // A bot buys a pet, a hat, a cosmetic or a build slot, the same room call as POST /api/shop.
  if (action === "shop") {
    const item = parseShopBuy(data);
    if (!item.ok) return json({ error: "Invalid item" }, 400);
    return internal(request, env, channel, "/shop", { userId, ...item.value });
  }
  if (action === "chat") {
    const text = account.value.text.slice(0, 500);
    if (!text.trim()) return json({ error: "text required" }, 400);
    return roomFetch(null, env, channel, "/dev-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, username, displayName, text }),
    });
  }
  return json({ error: "Not found" }, 404);
}
async function staticCatalog(env: Env, url: URL): Promise<CatalogEntry[]> {
  const r = await env.ASSETS.fetch(new Request(url.origin + "/assets/characters.json"));
  return r.ok ? r.json<CatalogEntry[]>() : [];
}
// The /play/ channel picker in one request: each listed channel with its top three ranked fighters (and the uploaded
// looks they wear, which only that channel's catalog has), plus the built-in catalog once, and whether this site is full
// (the search then can't invite a streamer here). Kept a minute per isolate.
let pickerCache: { data: PickerData; at: number } | null = null;
async function picker(request: Request, env: Env, url: URL): Promise<PickerData> {
  if (pickerCache && Date.now() - pickerCache.at < 60000) return pickerCache.data;
  const [logins, catalog, full] = await Promise.all([publicChannels(env), staticCatalog(env, url), isFull(env)]),
    builtin = new Set(catalog.map((e) => e.id));
  const channels = await Promise.all(
    logins.map(async (login) => {
      try {
        const r = await internal(request, env, login, "/leaderboard"),
          board = r.ok ? await r.json<BoardRow[]>() : [];
        const top = board
          .filter((p) => p.wins + p.losses > 0)
          .slice(0, 3)
          .map(({ displayName, username, elo, avatar }) => ({ displayName, username, elo, avatar }));
        const own = top.filter((p) => !builtin.has(p.avatar)).map((p) => p.avatar);
        const c = own.length ? await internal(request, env, login, "/catalog") : null,
          looks = c?.ok ? (await c.json<CatalogEntry[]>()).filter((e) => own.includes(e.id)) : [];
        return { login, top, ...(looks.length ? { catalog: looks } : {}) };
      } catch {
        return { login, top: [] };
      }
    }),
  );
  pickerCache = { data: { channels, catalog, full }, at: Date.now() };
  return pickerCache.data;
}
// Every response leaves through secure() (server/security.ts): HSTS on https, and a locked-down CSP on /api and /auth.
const API_PATH = /^\/(api|auth)\//;
export default {
  // tests call it without a ctx
  async fetch(request: Request, env: Env, ctx?: ExecutionContext) {
    const r = await handle(request, env, ctx),
      url = new URL(request.url);
    return secure(r, url, API_PATH.test(url.pathname) ? API_CSP : "");
  },
  // The daily cron (cloudflare.config.ts): back up every channel into D1 (server/backups.ts).
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (!env.BACKUPS || !env.INTERNAL_SECRET) return;
    const run = backupChannels(env, controller.scheduledTime, (channel, p, init) =>
      roomFetch(null, env, channel, p, init),
    )
      .then((results) => {
        const failed = results.filter((r) => !r.ok);
        if (failed.length)
          return logWorkerError(env, new Error("Daily backup failed for " + failed.length + " channel(s)"), { failed });
      })
      .catch((e) => logWorkerError(env, e, { source: "backup" }));
    ctx.waitUntil(run);
  },
} satisfies ExportedHandler<Env>;
async function handle(request: Request, env: Env, ctx: ExecutionContext | undefined): Promise<Response> {
  let path = "";
  try {
    const url = new URL(request.url),
      mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    path = url.pathname;
    // Twitch EventSub posts here: no session and no Origin header; the HMAC signature authenticates it.
    if (path === EVENTSUB_PATH) {
      if (!env.INTERNAL_SECRET || !env.AUTH_SECRET) return json({ error: "Server secrets are not configured" }, 503);
      return await handleEventsub(request, env, {
        channels: CHANNELS,
        roomFetch: (channel, p, init) => roomFetch(null, env, channel, p, init),
        origin: (channel) => siteOrigin(env, url, channel),
        findChannel: async (id) =>
          (id && (await listRecords(env, "channel:")).find((x) => x.value?.id === id)?.value?.login) || "",
        isEnabled: async (channel) => isOn(await channelState(env, channel)),
        botUserId: async () => (env.CHAT_BOT === "1" ? String((await record(env, "bot:twitch"))?.id || "") : ""),
        // The bot's reply goes out after Twitch has its 204; what Twitch said goes back to the room (bot status and owner log).
        sendChat: (args) =>
          ctx?.waitUntil?.(
            sendChatMessages(env, args)
              .then((results) =>
                roomFetch(null, env, args.channel, "/bot-sent", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ results }),
                }),
              )
              .catch((e) => console.warn("bot reply report failed", e?.message)),
          ),
        // A redemption: mark it on Twitch (FULFILLED, or CANCELED to refund), tell the room, then post the bot's line.
        onRedeemed: ({ redemption: r, mark, reply }) =>
          ctx?.waitUntil?.(
            (async () => {
              if (mark) {
                const status = await markRedemption(env, {
                  channel: r.channel,
                  rewardId: r.rewardId,
                  redemptionId: r.id,
                  status: mark,
                });
                await roomFetch(null, env, r.channel, "/points/marked", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ redemptionId: r.id, status }),
                });
              }
              const botId = env.CHAT_BOT === "1" ? String((await record(env, "bot:twitch"))?.id || "") : "";
              if (!reply || !botId) return;
              const results = await sendChatMessages(env, {
                broadcasterId: r.broadcasterId,
                senderId: botId,
                messages: [reply],
              });
              await roomFetch(null, env, r.channel, "/bot-sent", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ results }),
              });
            })().catch((e) => console.warn("redemption follow-up failed", e?.message)),
          ),
      });
    }
    // StreamElements custom commands ($(customapi ...)): GET with the channel's key, answered with one chat line.
    if (path.startsWith("/api/se/")) {
      if (!env.INTERNAL_SECRET) return new Response("PixFray is not configured", { status: 503 });
      return await handleStreamElements(request, env, {
        url,
        origin: siteOrigin(env, url, path.split("/")[3] || ""),
        channelState: (channel) => channelState(env, channel),
        roomFetch: (channel, p, init) => roomFetch(null, env, channel, p, init),
        // StreamElements took over from a Twitch EventSub subscription: delete it so Twitch stops sending chat.
        dropSubscription: (subscriptionId) =>
          ctx?.waitUntil?.(
            disconnectChat(env, { subscriptionId, url }).catch((e) => console.warn("eventsub drop failed", e?.message)),
          ),
      });
    }
    // A dev token is not a browser credential, so it skips the same-origin check; a wrong one is refused outright.
    const dev = request.headers.has("Authorization") ? await devToken(request, env) : false;
    if (request.headers.has("Authorization") && !dev && path.startsWith("/api/"))
      return json({ error: "Invalid dev token" }, 401);
    if (mutating && !dev && request.headers.get("Origin") !== url.origin)
      return json({ error: "Same-origin request required" }, 403);
    if (path.startsWith("/auth/")) return await handleAuth(request, env);
    if (path === "/robots.txt" || path === "/sitemap.xml") return seoFile(url, path);
    if (!path.startsWith("/api/")) return channelPageRedirect(env, url) || (await page(request, env, url));
    // Public health check: up or not, nothing else. Version and Twitch setup are in the owner's /api/dev/diagnostics (worker.version, worker.twitchConfigured).
    if (path === "/api/health")
      return env.INTERNAL_SECRET && env.AUTH_SECRET ? json({ ok: true }) : json({ ok: false }, 503);
    if (!env.INTERNAL_SECRET || !env.AUTH_SECRET) return json({ error: "Server secrets are not configured" }, 503);
    const s = dev ? null : await session(request, env),
      user = dev ? await devUser(env) : s?.user || null,
      owner = await isOwner(env, user);
    // both groups are required in the pattern, so a match has them
    const devMatch = path.match(/^\/api\/devtools\/([a-z0-9_]{1,25})\/(profile|chat|live|shop|export)$/) as
      | (RegExpMatchArray & [string, string, string])
      | null;
    if (path.startsWith("/api/devtools/")) {
      if (!dev || !devMatch) return json({ error: "Not found" }, 404);
      const st = await channelState(env, devMatch[1]);
      if (!isOn(st)) return json(offError(st), 403);
      // A copy of the channel for a site of its own (branch miolaf-frozen imports it): room tables and mod access.
      if (devMatch[2] === "export") {
        if (request.method !== "GET") return json({ error: "Use GET" }, 405);
        const r = await roomFetch(null, env, devMatch[1], "/export");
        if (!r.ok) return json(await r.json(), r.status);
        const [broadcaster, modsconnected] = await Promise.all([
          record(env, "broadcaster:" + devMatch[1]),
          record(env, "modsconnected:" + devMatch[1]),
        ]);
        return json({
          channel: devMatch[1],
          at: Date.now(),
          tables: await r.json(),
          auth: { broadcaster, modsconnected },
        });
      }
      if (request.method !== "POST") return json({ error: "Use POST" }, 405);
      return await handleDevtools(request, env, devMatch[1], devMatch[2], await bodyJson(request, 4000));
    }
    if (path === "/api/session")
      return json({ user, owner, configured: configured(env), channels: CHANNELS, productionEnabled: false });
    // /play/ asks which stream the viewer watches, so nobody saves a fighter on the wrong channel.
    if (path === "/api/channels")
      return json({ channels: await publicChannels(env), defaultChannel: site.defaultChannel });
    if (path === "/api/picker") return json(await picker(request, env, url));
    if (path.startsWith("/api/dev/"))
      return await handleDeveloper(request, env, {
        user,
        owner,
        dev,
        url,
        path,
        bodyJson,
        roomFetch: (channel, p, init) => roomFetch(null, env, channel, p, init),
        chatAction: (channel, action, opts) => chatAction(env, url, channel, action, opts),
        waitUntil: (p) => ctx?.waitUntil?.(p),
      });
    const match = path.match(
      /^\/api\/(state|live|profile|leaderboard|looks|catalog|access|admin|assets|pets|shop|sprite|sprites)\/([a-z0-9_]{1,25})(?:\/([a-z0-9_-]{1,64}))?$/,
    );
    if (!match) return json({ error: "Not found" }, 404);
    // route and channel are required groups in the pattern; id is optional
    const [, route, channel, id] = match as RegExpMatchArray & [string, string, string, string | undefined];
    const state = await channelState(env, channel);
    // The shop list and the viewer's own profile stay readable while paused (like pets), so viewers still see their
    // fighter and what they own; saving and buying stay closed.
    const openWhenPaused =
      OPEN_WHEN_PAUSED.includes(route) || ((route === "shop" || route === "profile") && request.method === "GET");
    if (!isOn(state) && !(state === "paused" && openWhenPaused)) return json(offError(state), 403);
    if (route === "live" && request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return json({ error: "WebSocket upgrade required" }, 426);
    // 30 writes a minute per signed-in user (profile saves, buys, uploads, admin changes), counted in AuthStore across channels. Reads and dev-token calls are not counted.
    if (mutating && user && !dev && WRITE_ROUTES.includes(route)) {
      const limited = await writeLimit(env, user.id);
      if (limited) return limited;
    }
    if (route === "access") return json(await access(env, user, channel));
    if (route === "assets")
      return await handleUploads(request, env, {
        user,
        owner,
        channel,
        id: id || "",
        url,
        bodyJson,
        access: () => access(env, user, channel),
        roomFetch: (p, init) => roomFetch(null, env, channel, p, init),
      });
    // Pets (server/pets.ts): the public catalog and images; mods upload and delete their own.
    if (route === "pets")
      return await handlePets(request, env, {
        user,
        id: id || "",
        bodyJson,
        access: () => access(env, user, channel),
        roomFetch: (p, init) => roomFetch(null, env, channel, p, init),
      });
    // Viewer sprites (server/sprites.ts): a viewer sends one made from their own image (optionally redrawn by Workers AI),
    // mods approve or reject it.
    if (route === "sprite" || route === "sprites")
      return await handleSprites(
        request,
        env,
        {
          user,
          id: id || "",
          bodyJson,
          access: () => access(env, user, channel),
          roomFetch: (p, init) => roomFetch(null, env, channel, p, init),
        },
        route === "sprite",
      );
    // Shop: the public list with this channel's prices (GET), and a signed-in viewer buying with PixFray dollars (POST).
    if (route === "shop") {
      if (request.method === "GET" && !id) return await internal(request, env, channel, "/shop");
      if (request.method !== "POST" || id) return json({ error: "Use GET or POST" }, 405);
      if (!user) return json({ error: "Sign in to shop" }, 401);
      const item = parseShopBuy(await bodyJson(request, 1000));
      if (!item.ok) return json({ error: "Invalid item" }, 400);
      return await internal(request, env, channel, "/shop", { userId: user.id, ...item.value });
    }
    if (route === "profile") {
      if (!user) return json({ error: "Sign in to customize your profile" }, 401);
      if (id && (id !== "others" || request.method !== "GET")) return json({ error: "Not found" }, 404);
      if (id) return json({ fighters: await fightersElsewhere(request, env, user, channel) });
      if (request.method === "GET")
        return await internal(request, env, channel, "/profile?userId=" + encodeURIComponent(user.id));
      if (request.method !== "POST") return json({ error: "Use GET or POST" }, 405);
      // stats/hat are optional; the room checks them against the saved wins (server/upgrades.ts).
      const look = parseProfileSave(await bodyJson(request, 4000));
      if (!look.ok) return await refuseSave(request, env, channel, user, look.error, "Invalid profile fields", 400);
      const { avatar, color, defaultAbility, stats, hat, pet, loadout } = look.value;
      const dynamicRes = await internal(request, env, channel, "/catalog");
      const dynamic = dynamicRes.ok ? await dynamicRes.json<CatalogEntry[]>() : [];
      const character = [...(await staticCatalog(env, url)), ...dynamic].find((x) => x.id === avatar);
      if (!character)
        return await refuseSave(request, env, channel, user, "unknown_character", "Unknown character", 400);
      // An approved viewer sprite belongs to the viewer who made it.
      if (character.owner && character.owner !== user.id)
        return await refuseSave(
          request,
          env,
          channel,
          user,
          "sprite_not_owned",
          "That sprite belongs to another viewer",
          403,
        );
      const saved = await internal(request, env, channel, "/profile", {
        userId: user.id,
        username: user.login,
        displayName: user.displayName,
        avatar,
        color,
        defaultAbility,
        stats,
        hat,
        pet,
        ...loadout,
      });
      if (saved.ok)
        await rememberFighter(env, user.id, channel).catch((e) =>
          console.warn("fighter index write failed", e?.message),
        );
      return saved;
    }
    if (route === "admin") {
      if (request.method !== "GET" && request.method !== "POST") return json({ error: "Use GET or POST" }, 405);
      const roles = await access(env, user, channel);
      if (!roles.canManage) return json({ error: roles.reason || "Moderator role required" }, user ? 403 : 401);
      if (request.method === "GET") {
        const r = await internal(request, env, channel, "/admin");
        if (!r.ok) return r;
        const data = await r.json<AdminReply>();
        // modsReady: the broadcaster's token is stored, so moderators can be checked and open this page too.
        // modsLapsed: mod access was connected once (modsconnected:<login>, never expires) but the token has expired since.
        // Viewing this page keeps a stored token alive, and a token seen without its marker (connected before the marker
        // existed) gets one.
        const [broadcaster, marker] = await Promise.all([
          record(env, "broadcaster:" + channel),
          record(env, "modsconnected:" + channel),
        ]);
        const modsReady = !!broadcaster,
          modsLapsed = !modsReady && !!marker;
        // pointsReady: the stored token carries channel:manage:redemptions (the points sign-in), read from the scopes sealed
        // with it; renewals keep them. Twitch can still refuse later, which createPointReward answers with the sign-in link.
        const pointsReady = broadcaster
          ? !!(await unseal<{ scopes?: string[] }>(env, broadcaster).catch(() => null))?.scopes?.includes(POINTS_SCOPE)
          : false;
        if (broadcaster)
          await Promise.all([
            touchBroadcaster(env, channel, broadcaster),
            marker ? null : markModsConnected(env, channel),
          ]).catch((e) => console.warn("mods record refresh failed", e?.message)); // rare writes: weekly, and once per channel
        const bot = env.CHAT_BOT === "1" ? await record<{ login?: string } | null>(env, "bot:twitch") : null;
        return json({
          ...data,
          streamelements: seView(env, url, channel, data.streamelements),
          access: roles,
          checkinTestAllowed: channel === site.defaultChannel,
          seOnly: env.SE_ONLY === "1",
          chatBot: env.CHAT_BOT === "1" ? { login: bot?.login || "", debug: env.BOT_DEBUG === "1" } : null,
          modsReady,
          modsLapsed,
          pointsLogin: pointsLoginUrl(channel),
          pointsReady,
          channelState: state,
        });
      }
      // Until the role checks below pass, data.action and data.takeover are only compared; then the body is parsed.
      const data = await bodyJson(request, 12000);
      // Turn PixFray off or back on: the broadcaster or the owner, never a mod. Fighters and ranks are kept.
      if (data.action === "pauseChannel" || data.action === "resumeChannel") {
        if (!roles.owner && !roles.broadcaster)
          return json({ error: "Only " + channel + " can turn PixFray off or on" }, 403);
        await setPaused(env, channel, data.action === "pauseChannel", roles.owner ? "owner" : "broadcaster");
        return json({ ok: true, channelState: data.action === "pauseChannel" ? "paused" : "on" });
      }
      // Sets one fighter's rank by hand, to repair a rank lost to a bug: the site owner only, so no channel can raise its own.
      if (data.action === "restoreRank" && !roles.owner)
        return json({ error: "Only the site owner can restore a rank", reason: "owner_only" }, 403);
      // Can't be undone, or moves chat away from another site: the broadcaster or the owner, never a mod.
      const only =
        data.action === "resetAllRanks"
          ? "reset all ranks"
          : data.action === "rotateSeKey"
            ? "make a new StreamElements key"
            : data.takeover === true
              ? "move chat from another site"
              : data.action === "createPointReward" || data.action === "deletePointReward"
                ? "change channel point rewards"
                : "";
      if (only && !roles.owner && !roles.broadcaster)
        return json({ error: "Only " + channel + " can " + only, reason: "broadcaster_only" }, 403);
      const admin = parseAdminBody(data);
      if (!admin.ok) return json({ ok: false, reason: admin.error, error: admin.error }, 400);
      const { action, takeover, value, names } = admin.value;
      if (action === "rotateSeKey" || action === "setSeNames" || action === "setDuelModuleOff") {
        const r = await roomFetch(null, env, channel, "/se-admin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, names, value }),
        });
        const out = await r.json<AdminReply>();
        if (!r.ok) return json(out, r.status);
        return json({ ok: true, streamelements: seView(env, url, channel, out.streamelements) });
      }
      // Check-in test mode: !checkin answers while offline for 15 minutes, saving nothing. Any mod can turn it on or off,
      // on the site's own channel only, so a test never reaches another streamer's chat.
      if (action === "checkinTest") {
        if (channel !== site.defaultChannel)
          return json({ error: "Check-in test mode is only for " + site.defaultChannel + "'s channel" }, 403);
        const r = await roomFetch(null, env, channel, "/checkin-test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // canManage above means a signed-in user
          body: JSON.stringify({ on: value, by: user!.displayName || user!.login }),
        });
        return json(await r.json(), r.status);
      }
      if (action === "createPointReward" || action === "deletePointReward")
        return await pointsAction(env, url, channel, action, admin.value.payload, user!.displayName || user!.login); // canManage: signed in
      if (action === "connectChat" && env.CHAT_BOT !== "1" && (channel !== site.defaultChannel || env.SE_ONLY === "1"))
        return json({ error: "This channel uses StreamElements for chat. Choose Use StreamElements." }, 400);
      if (action === "connectChat" || action === "disconnectChat" || action === "useStreamElements")
        return await chatAction(env, url, channel, action, { takeover });
      return await internal(request, env, channel, "/admin", {
        ...admin.value.fields,
        actorId: user!.id, // canManage above means a signed-in user
        actorName: user!.displayName || user!.login, // as above
      });
    }
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    if (route === "catalog") {
      const [s, d] = await Promise.all([staticCatalog(env, url), internal(request, env, channel, "/catalog")]);
      return json([...s, ...(d.ok ? await d.json<CatalogEntry[]>() : [])]);
    }
    // Saved looks for the overlay: public, the same fields the leaderboard shows.
    if (route === "live")
      return await internal(
        request,
        env,
        channel,
        url.searchParams.get("role") === "overlay" ? "/live?role=overlay" : "/live",
      );
    if (route === "looks")
      return await internal(
        request,
        env,
        channel,
        "/looks?u=" + encodeURIComponent((url.searchParams.get("u") || "").slice(0, 600)),
      );
    // The leaderboard is public; ?private=1 (the mod page) adds dollars for mods and the owner only.
    if (route === "leaderboard" && url.searchParams.get("private") === "1") {
      if (!(await access(env, user, channel)).canManage)
        return json({ error: "Moderator role required" }, user ? 403 : 401);
      return await internal(request, env, channel, "/leaderboard?private=1");
    }
    return await internal(request, env, channel, "/" + route);
  } catch (error) {
    // each `as HttpError` below: what bodyJson, setPaused and chatAction throw; another Error has no status (a thrown
    // null or undefined would fail here, as it does on main)
    if (!(error as HttpError).status) ctx?.waitUntil?.(logWorkerError(env, error, { path }));
    return json(
      {
        error: (error as HttpError).status
          ? (error as HttpError).message
          : "Service unavailable; check owner diagnostics",
        ...((error as HttpError).status && (error as HttpError).reason ? { reason: (error as HttpError).reason } : {}),
        ...((error as HttpError).reconnect ? { reconnect: (error as HttpError).reconnect } : {}),
        ...((error as HttpError).connectedElsewhere
          ? { connectedElsewhere: (error as HttpError).connectedElsewhere }
          : {}),
      },
      (error as HttpError).status || 503,
    );
  }
}
