import { DurableObject } from "cloudflare:workers";
import site from "../site.config.js";
import { channelState, signUp, isBroadcaster, reviewReasons } from "./channels.ts";
import { authOrigin } from "./hosts.ts";
import { fromBase64, toBase64 } from "./http.ts";
import { hit } from "./ratelimit.ts";
import { parseHelixPage, parseHelixUsers, parseModerators, parseTwitchTokens, parseTwitchValidation } from "./parse.ts";
import type { HelixPage } from "./channels.ts";
import type { Env } from "./env.ts";
import type { Parsed, TwitchTokens } from "./parse.ts";

/** A signed-in Twitch account: the immutable id, the login and the display name Twitch gave at sign-in. */
export type TwitchUser = { id: string; login: string; displayName: string };
/** The session:<sha256 of the mini_session cookie> record in AuthStore, written at sign-in. */
export type Session = { user: TwitchUser; createdAt: number };
/**
 * What access() decides for a user on a channel. `owner` and `broadcaster` tell the roles apart; a refusal and a
 * moderator check carry `reason` ('' for a moderator). Every member names every key, so callers can read any of them.
 */
export type Access =
  | { owner: true; broadcaster?: never; moderator: false; canManage: true; reason?: never }
  | { owner: false; broadcaster: true; moderator: false; canManage: true; reason?: never }
  | { owner: false; broadcaster?: never; moderator: boolean; canManage: boolean; reason: string };
/** An AES-GCM sealed value (seal/unseal), as base64 parts. */
export type Sealed = { iv: string; data: string };
/** broadcaster:<login>: the sealed broadcaster token plus when it was last used. */
export type StoredSeal = Sealed & { touched?: number };
/** The sign-in's pending details, sealed into the OAuth state (sealState/openState). */
export type OAuthPending = {
  bot?: boolean;
  signup?: boolean;
  mods?: boolean;
  channel?: string;
  connect?: boolean;
  connectMods?: boolean;
  connectBot?: boolean;
  connectPoints?: boolean;
  next?: string;
};
/** The broadcaster token as it is sealed in broadcaster:<login>: Twitch's token answer plus the account and check. */
type BroadcasterToken = TwitchTokens & { userId: string; validatedAt: number; scopes?: string[] };
/** A Helix /users row (the fields read here and in reviewReasons), as parseHelixUsers answers it. */
export type HelixUser = {
  id: string;
  login: string;
  display_name: string;
  created_at?: string | undefined;
  broadcaster_type?: string | undefined;
};
type EntryRow = { value: string; expires: number };

export class AuthStore extends DurableObject<Env, unknown> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)",
    );
  }
  async fetch(request: Request): Promise<Response> {
    if (!this.env.INTERNAL_SECRET || request.headers.get("X-Mini-Internal") !== this.env.INTERNAL_SECRET)
      return Response.json({ error: "Forbidden" }, { status: 403 });
    const url = new URL(request.url),
      key = url.searchParams.get("key");
    if (!key || key.length > 200) return Response.json({ error: "Invalid key" }, { status: 400 });
    const sql = this.ctx.storage.sql;
    if (url.pathname === "/hit" && request.method === "POST") {
      // sent by writeLimit (ratelimit.ts) as numbers; hit() clamps whatever arrives
      const { limit, windowMs } = await request
        .json<{ limit?: number; windowMs?: number }>()
        .catch((): { limit?: number; windowMs?: number } => ({}));
      return Response.json(await hit(this.ctx, key, limit, windowMs));
    } // per-user write limit (server/ratelimit.ts)
    if (url.pathname === "/consume" && request.method === "POST") {
      // One statement: the row is removed and returned atomically, so a code can only ever be read once.
      const row = sql.exec<EntryRow>("DELETE FROM entries WHERE key=? RETURNING value,expires", key).toArray()[0];
      const value = row && row.expires > Date.now() ? JSON.parse(row.value) : null;
      return Response.json(value);
    }
    if (url.pathname === "/list" && request.method === "GET") {
      // Owner listings only: the channel registry (server/channels.ts). Never sessions or tokens.
      if (key !== "channel:") return Response.json({ error: "Invalid prefix" }, { status: 400 });
      const end = key.slice(0, -1) + ";"; // ';' sorts right after ':'
      const rows = [
        ...sql.exec<{ key: string; value: string }>(
          "SELECT key,value FROM entries WHERE key>=? AND key<? AND expires>? ORDER BY key LIMIT 500",
          key,
          end,
          Date.now(),
        ),
      ];
      return Response.json(rows.map((r) => ({ key: r.key, value: JSON.parse(r.value) })));
    }
    if (request.method === "GET") {
      const rows = [...sql.exec<EntryRow>("SELECT value,expires FROM entries WHERE key=?", key)];
      return Response.json(rows[0] && rows[0].expires > Date.now() ? JSON.parse(rows[0].value) : null);
    }
    if (request.method === "POST") {
      // expires is checked with Number.isFinite below before it is used
      const { value, expires } = await request.json<{ value: unknown; expires: number }>();
      // Channel registry rows and the modsconnected markers live ~20 years; everything else at most 100 days.
      if (
        !Number.isFinite(expires) ||
        expires > Date.now() + (/^(channel|modsconnected|bot):/.test(key) ? 21 * 365 : 100) * 86400000
      )
        return Response.json({ error: "Invalid expiry" }, { status: 400 });
      if (JSON.stringify(value).length > 20000) return Response.json({ error: "Record too large" }, { status: 413 });
      sql.exec(
        "INSERT INTO entries(key,value,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=excluded.expires",
        key,
        JSON.stringify(value),
        expires,
      );
      // Only when none is pending: pushing it back on every write would keep it from ever running under steady traffic.
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 3600000);
      return Response.json({ ok: true });
    }
    if (request.method === "DELETE") {
      sql.exec("DELETE FROM entries WHERE key=?", key);
      return Response.json({ ok: true });
    }
    return new Response("Method not allowed", { status: 405 });
  }
  async alarm() {
    this.ctx.storage.sql.exec("DELETE FROM entries WHERE expires<=?", Date.now());
    // as: COUNT(*) always returns exactly one row
    const [{ n }] = [...this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM entries")] as [
      { n: number },
    ];
    if (n) await this.ctx.storage.setAlarm(Date.now() + 3600000);
  }
}
export const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, "0")).join("");
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async (value: string): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
// Sign-in lasts 30 days, so a viewer coming back for the next stream still sees their own fighter. Signing out ends it.
export const SESSION_S = 30 * 86400;
// T is what the caller knows the key holds (null when it is missing or expired). The default is any for the .js
// callers (worker.ts, developer.ts), which read fields straight off the result; .ts callers pass T.
export async function record<T = any>(env: Env, key: string, value?: unknown, expires?: number): Promise<T> {
  const stub = env.AUTH.get(env.AUTH.idFromName("auth"));
  const res = await stub.fetch("https://auth/entry?key=" + encodeURIComponent(key), {
    method: value === undefined ? "GET" : value === null ? "DELETE" : "POST",
    headers: { "X-Mini-Internal": env.INTERNAL_SECRET, "Content-Type": "application/json" },
    ...(value !== undefined && value !== null ? { body: JSON.stringify({ value, expires }) } : {}),
  });
  if (!res.ok) throw new Error("Auth storage unavailable");
  return res.json<T>();
}
// Broadcaster token (Helix moderator checks): kept 90 days from its last use. `touched` sits beside the sealed fields, so
// a successful check or an admin page view can push the expiry out without opening the token.
const TOKEN_MS = 90 * 86400000,
  TOUCH_MS = 7 * 86400000,
  MARKER_MS = 20 * 365 * 86400000;
export const keepBroadcaster = (env: Env, channel: string, sealed: StoredSeal): Promise<unknown> =>
  record(env, "broadcaster:" + channel, { ...sealed, touched: Date.now() }, Date.now() + TOKEN_MS);
export const touchBroadcaster = (env: Env, channel: string, sealed: StoredSeal): Promise<unknown> | null =>
  Date.now() - (sealed?.touched || 0) > TOUCH_MS ? keepBroadcaster(env, channel, sealed) : null;
// modsconnected:<login> = {at}: written whenever mod access is connected and never expires, so the admin page can tell
// "never connected" from "connected, but the token lapsed" (modsLapsed).
export const markModsConnected = (env: Env, channel: string): Promise<unknown> =>
  record(env, "modsconnected:" + channel, { at: Date.now() }, Date.now() + MARKER_MS);
export async function consume(env: Env, key: string): Promise<unknown> {
  const stub = env.AUTH.get(env.AUTH.idFromName("auth"));
  const r = await stub.fetch("https://auth/consume?key=" + encodeURIComponent(key), {
    method: "POST",
    headers: { "X-Mini-Internal": env.INTERNAL_SECRET },
  });
  if (!r.ok) throw new Error("Auth storage unavailable");
  return r.json();
}
/** The AES-GCM key derived from AUTH_SECRET. */
const sealKey = async (env: Env, use: "encrypt" | "decrypt"): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.AUTH_SECRET)),
    { name: "AES-GCM" },
    false,
    [use],
  );
export async function seal(env: Env, value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12)),
    data = new TextEncoder().encode(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(env, "encrypt"), data);
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(cipher)) };
}
// OAuth state: the sign-in's pending details, sealed with AUTH_SECRET and carried in the state parameter and the
// mini_oauth cookie, so /auth/login writes nothing to AuthStore (a sign-in flood can't use up its quota).
const b64url = (bytes: Uint8Array): string =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (text: string): Uint8Array => fromBase64(text.replace(/-/g, "+").replace(/_/g, "/"));
export const OAUTH_STATE = /^[A-Za-z0-9_-]{40,1500}$/;
export async function sealState(env: Env, pending: OAuthPending): Promise<string> {
  const { iv, data } = await seal(env, { oauth: pending, exp: Date.now() + 600000, n: randomToken().slice(0, 16) });
  return b64url(new Uint8Array([...fromBase64(iv), ...fromBase64(data)]));
}
export async function openState(env: Env, state: string): Promise<OAuthPending | null> {
  if (!OAUTH_STATE.test(state || "")) return null;
  try {
    const raw = unb64url(state);
    if (raw.length < 29) return null;
    const v = await unseal<{ oauth?: OAuthPending; exp?: unknown } | null>(env, {
      iv: toBase64(raw.slice(0, 12)),
      data: toBase64(raw.slice(12)),
    });
    return v && v.oauth && typeof v.exp === "number" && v.exp > Date.now() ? v.oauth : null;
  } catch {
    return null;
  }
}
// T is what the caller sealed; unseal only decrypts and parses it.
export async function unseal<T = unknown>(env: Env, value: Sealed): Promise<T> {
  const key = await sealKey(env, "decrypt");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(value.iv) }, key, fromBase64(value.data));
  return JSON.parse(new TextDecoder().decode(plain));
}
// connect=1 (the default channel only): mod checks plus the chat-read scopes the EventSub channel.chat.message webhook needs.
// Built-in channels. Only the default channel can use EventSub; every other channel uses StreamElements.
export const CHANNELS = site.builtinChannels;
export const CONNECT_SCOPES = ["moderation:read", "user:read:chat", "user:bot", "channel:bot"];
// bot=1 (test site, CHAT_BOT): the BOT_LOGIN account lets the app read and send chat as it. Only its id is stored
// (bot:twitch); the app token does the rest. connect=bot: a broadcaster allows the bot in their chat (channel:bot).
export const BOT_SCOPES = ["user:read:chat", "user:write:chat", "user:bot"];
// connect=points: a broadcaster lets PixFray make channel point rewards and fulfil or refund their redemptions.
export const POINTS_SCOPE = "channel:manage:redemptions";
// The points sign-in replaces the stored broadcaster token, so it asks again for every scope the earlier sign-ins
// granted (the default channel's chat read included): Twitch may give the new token only what it asks for.
export function pointsScopes(env: Env, channel: string): string[] {
  const base =
    channel === site.defaultChannel
      ? CONNECT_SCOPES
      : env.CHAT_BOT === "1"
        ? ["moderation:read", "channel:bot"]
        : ["moderation:read"];
  return [...base, POINTS_SCOPE];
}
/** A Twitch answer through its parser (server/parse.ts): null for an error status, a non-JSON body or a refusal. */
async function answer<T>(r: Response | null, parse: (v: unknown) => Parsed<T>): Promise<T | null> {
  if (!r?.ok) return null;
  const parsed = parse(await r.json<unknown>().catch(() => undefined));
  return parsed.ok ? parsed.value : null;
}
/** A JSON refusal { error } with this status. */
const fail = (error: string, status: number): Response => Response.json({ error }, { status });
export function configured(env: Env): boolean {
  return !!(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET && env.AUTH_SECRET && env.INTERNAL_SECRET);
}
// The raw mini_session cookie, matched at a cookie-name boundary so a cookie such as xmini_session isn't read as it.
const sessionCookie = (request: Request) =>
  request.headers.get("Cookie")?.match(/(?:^|;\s*)mini_session=([a-f0-9]{64})(?:;|$)/)?.[1];
export async function session(request: Request, env: Env): Promise<Session | null> {
  const raw = sessionCookie(request);
  return raw ? record<Session | null>(env, "session:" + (await digest(raw))) : null;
}
export async function isOwner(env: Env, user: TwitchUser | null | undefined): Promise<boolean> {
  if (!user) return false;
  if (env.OWNER_TWITCH_ID) return user.id === env.OWNER_TWITCH_ID;
  const owner = await record<{ id: string } | null>(env, "owner:" + site.owner.login);
  return owner?.id === user.id;
}
// Where sign-in returns: a page on this site (the one the sign-in started on, with its ?channel= and #tab), never
// another site, /auth/ or /api/.
export function safeNext(v: unknown): string {
  if (typeof v !== "string" || v.length > 500 || !/^\/(?![/\\])/.test(v) || /[\u0000-\u001f\\]/.test(v)) return "/";
  const u = new URL(v, "https://next.invalid");
  return u.origin === "https://next.invalid" && !/^\/(auth|api)(\/|$)/.test(u.pathname)
    ? u.pathname + u.search + u.hash
    : "/";
}
export function cookie(name: string, value: string, age: number): string {
  return name + "=" + value + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=" + age;
}
export async function handleAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname;
  if (path === "/auth/logout") {
    if (request.method !== "POST") return new Response("Use POST", { status: 405 });
    const raw = sessionCookie(request);
    if (raw) await record(env, "session:" + (await digest(raw)), null);
    // the page reloads itself, so signing out stays on the same page and channel
    return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie("mini_session", "", 0) } });
  }
  if (!configured(env))
    return fail("Twitch app is not configured yet. Add the app client ID and secret to the Worker.", 503);
  const callback = authOrigin(env, url) + "/auth/callback";
  if (path === "/auth/login") {
    let pending: OAuthPending,
      scope = "";
    if (url.searchParams.get("bot") === "1") {
      if (env.CHAT_BOT !== "1" || !env.BOT_LOGIN) return fail("This site has no PixFray chat bot", 403);
      pending = { bot: true, channel: site.defaultChannel, next: "/admin/" };
      scope = BOT_SCOPES.join(" ");
    } else if (url.searchParams.get("signup") === "1") {
      // Sign-up from /start turns on the signed-in account's own channel. moderation:read lets its mods open the
      // admin page; on bot sites channel:bot lets the PixFray bot read and answer its chat. mods=0 asks for neither.
      const mods = url.searchParams.get("mods") !== "0";
      pending = { signup: true, mods, next: "/admin/" };
      scope = mods ? (env.CHAT_BOT === "1" ? "moderation:read channel:bot" : "moderation:read") : "";
    } else {
      // No ?channel (the bare /admin/ page): sign in only; the Worker then opens the account's own channel (worker.ts ownAdmin).
      const asked = safeNext(url.searchParams.get("next") || "/"),
        askedUrl = new URL(asked, "https://next.invalid");
      const bare =
          !url.searchParams.get("channel") && askedUrl.pathname === "/admin/" && !askedUrl.searchParams.get("channel"),
        channel = url.searchParams.get("channel") || site.defaultChannel;
      // A turned-off channel still signs in, so its broadcaster can turn it back on.
      if (!(await channelState(env, channel))) return fail("PixFray is not enabled for this channel", 403);
      const connect = url.searchParams.get("connect") === "1",
        connectBot = env.CHAT_BOT === "1" && url.searchParams.get("connect") === "bot",
        connectPoints = url.searchParams.get("connect") === "points",
        connectMods = connectBot || connectPoints || url.searchParams.get("connect") === "mods";
      if (connect && channel !== site.defaultChannel)
        return fail("Chat for this channel comes through StreamElements; no Twitch connection needed", 403);
      const next = connectMods ? "/admin/" : asked;
      pending = {
        ...(bare && !connect && !connectMods ? {} : { channel }),
        connect,
        ...(connectMods ? { connectMods: true } : {}),
        ...(connectBot ? { connectBot: true } : {}),
        ...(connectPoints ? { connectPoints: true } : {}),
        next,
      };
      scope = connect
        ? CONNECT_SCOPES.join(" ")
        : connectPoints
          ? pointsScopes(env, channel).join(" ")
          : connectBot
            ? "moderation:read channel:bot"
            : connectMods
              ? "moderation:read"
              : "";
    }
    const nonce = await sealState(env, pending);
    const target = new URL("https://id.twitch.tv/oauth2/authorize");
    // Only sign-up asks Twitch to show the account picker (it decides which channel gets PixFray); other sign-ins go straight through.
    Object.entries({
      client_id: env.TWITCH_CLIENT_ID,
      redirect_uri: callback,
      response_type: "code",
      scope,
      state: nonce,
      ...(pending.signup ? { force_verify: "true" } : {}),
    }).forEach(([k, v]) => target.searchParams.set(k, v));
    return new Response(null, {
      status: 302,
      headers: { Location: target.href, "Set-Cookie": cookie("mini_oauth", nonce, 600) },
    });
  }
  if (path !== "/auth/callback") return new Response("Not found", { status: 404 });
  const state = url.searchParams.get("state"),
    cookieState = request.headers.get("Cookie")?.match(/(?:^|;\s*)mini_oauth=([A-Za-z0-9_-]+)/)?.[1];
  if (!state || state !== cookieState) return fail("OAuth state mismatch. Restart sign-in.", 400);
  const pending = await openState(env, state);
  if (pending?.signup && !url.searchParams.get("code"))
    return startPage(url.searchParams.get("error") === "access_denied" ? "denied" : "failed");
  // !: a connectMods sign-in always carries its channel (the login branch above)
  if (pending?.connectMods && !url.searchParams.get("code"))
    return adminPage(pending.channel!, pending.connectPoints ? "points=denied" : "mods=denied");
  if (!pending || !url.searchParams.get("code")) return fail("Authorization expired or denied", 400);
  const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      // !: checked by the `!url.searchParams.get("code")` return above
      code: url.searchParams.get("code")!,
      grant_type: "authorization_code",
      redirect_uri: callback,
    }),
  });
  const tokens = await answer(tokenRes, parseTwitchTokens);
  if (!tokens) return fail("Twitch token exchange failed", 502);
  const headers = { "Client-Id": env.TWITCH_CLIENT_ID, Authorization: "Bearer " + tokens.access_token };
  const [identityRes, validationRes] = await Promise.all([
    fetch("https://api.twitch.tv/helix/users", { headers }),
    fetch("https://id.twitch.tv/oauth2/validate", { headers: { Authorization: "OAuth " + tokens.access_token } }),
  ]);
  const identities = await answer(identityRes, parseHelixUsers),
    validation = await answer(validationRes, parseTwitchValidation);
  if (!identities || !validation) return fail("Twitch identity validation failed", 502);
  const identity = identities[0];
  if (!identity || validation.client_id !== env.TWITCH_CLIENT_ID || validation.user_id !== identity.id)
    return fail("Twitch identity mismatch", 403);
  const user = { id: identity.id, login: identity.login, displayName: identity.display_name };
  // Resolve the channel's current immutable ID from Twitch, never from a claimed form field.
  // A failed lookup only blocks connecting chat; viewers still sign in and the last stored owner record stays.
  const ownerRes = await fetch("https://api.twitch.tv/helix/users?login=" + site.owner.login, { headers }).catch(
    (): null => null, // typed: the loose worker program would widen a bare null to any
  );
  const owner = (await answer(ownerRes, parseHelixUsers))?.[0]; // an unreadable answer counts as a failed lookup
  if (owner) {
    if (env.OWNER_TWITCH_ID && env.OWNER_TWITCH_ID !== owner.id) return fail("Owner configuration mismatch", 403);
    await record(env, "owner:" + site.owner.login, { id: owner.id }, Date.now() + 90 * 86400000);
  } else if (pending.connect) return fail("Cannot resolve channel owner", 502);
  const lacking = (need: string[]) => need.filter((x) => !validation.scopes?.includes(x));
  const notGranted = (missing: string[], restart: string) =>
    fail(`Twitch permissions were not granted: ${missing.join(", ")}. Restart at /auth/login?${restart}.`, 403);
  // The broadcaster token, sealed with the account it belongs to, plus the mods-connected marker.
  const keepToken = async (channel: string, extra: { scopes?: string[] } = {}) => {
    const sealed = await seal(env, { ...tokens, userId: user.id, ...extra, validatedAt: Date.now() });
    await keepBroadcaster(env, channel, sealed);
    await markModsConnected(env, channel);
  };
  if (pending.connect) {
    // !: without an owner, pending.connect returned 502 above
    if (user.id !== owner!.id) return fail("Only " + site.owner.login + " can connect broadcaster authorization", 403);
    const missing = lacking(CONNECT_SCOPES);
    if (missing.length) return notGranted(missing, "connect=1");
    await keepToken(site.defaultChannel);
  }
  if (pending.bot) {
    if (String(user.login).toLowerCase() !== String(env.BOT_LOGIN).toLowerCase())
      return fail("Sign in as the bot account " + env.BOT_LOGIN + ", not " + user.login, 403);
    const missing = lacking(BOT_SCOPES);
    if (missing.length) return notGranted(missing, "bot=1");
    await record(env, "bot:twitch", { id: user.id, login: user.login, at: Date.now() }, Date.now() + MARKER_MS);
  }
  const modScope = validation.scopes?.includes("moderation:read"),
    botScope = env.CHAT_BOT === "1" && validation.scopes?.includes("channel:bot");
  if (pending.signup) {
    const helix = async (p: string): Promise<HelixPage> => {
      const r = await fetch("https://api.twitch.tv/helix" + p, { headers });
      if (!r.ok) throw new Error("helix " + r.status);
      const page = parseHelixPage(await r.json<unknown>().catch(() => undefined));
      if (!page.ok) throw new Error("helix " + page.error); // reviewReasons reads a throw as 'unchecked'
      return page.value;
    };
    try {
      pending.channel = await signUp(env, user, () => reviewReasons(identity, helix));
    } catch (e: any /* any: signUp's fail() Error carries .reason; anything else is rethrown */) {
      if (!e.reason) throw e;
      return startPage(e.reason);
    }
    if (pending.mods && modScope) await keepToken(pending.channel);
  }
  if (pending.connectMods) {
    const channel = pending.channel!; // !: a connectMods sign-in always carries its channel (the login branch above)
    if (!(await isBroadcaster(env, user, channel))) return adminPage(channel, "mods=wrong_account");
    if (pending.connectPoints) {
      if (lacking(pointsScopes(env, channel)).length) return adminPage(channel, "points=denied");
    } else if (!modScope || (pending.connectBot && !validation.scopes?.includes("channel:bot")))
      return adminPage(channel, "mods=denied");
    await keepToken(channel, { scopes: validation.scopes || [] });
  }
  const key = randomToken();
  await record(env, "session:" + (await digest(key)), { user, createdAt: Date.now() }, Date.now() + SESSION_S * 1000);
  // Back to the page the sign-in started on; the viewer and mod pages get the channel when the address lacks it.
  const to = new URL(safeNext(pending.next || "/"), url.origin);
  for (const k of ["signed_in", "mods", "bot", "points"]) to.searchParams.delete(k);
  if (pending.channel && ["/", "/admin/"].includes(to.pathname) && !to.searchParams.get("channel"))
    to.searchParams.set("channel", pending.channel);
  to.searchParams.set("signed_in", "1");
  // bot=allowed: the admin page connects chat through the PixFray bot as soon as it opens
  if (pending.connectBot || (pending.signup && botScope)) to.searchParams.set("bot", "allowed");
  else if (pending.connectPoints) to.searchParams.set("points", "connected");
  else if (pending.connectMods) to.searchParams.set("mods", "connected");
  if (pending.bot) to.searchParams.set("bot", "connected");
  if (pending.signup || pending.connectMods) to.hash = "chat";
  const response = new Response(null, { status: 303, headers: { Location: to.pathname + to.search + to.hash } });
  response.headers.append("Set-Cookie", cookie("mini_session", key, SESSION_S));
  response.headers.append("Set-Cookie", cookie("mini_oauth", "", 0));
  return response;
}
// Back to a page, with the sign-in's state cookie cleared.
const backTo = (location: string): Response =>
  new Response(null, { status: 303, headers: { Location: location, "Set-Cookie": cookie("mini_oauth", "", 0) } });
// Back to /start with the reason sign-up didn't finish (full, denied, failed).
const startPage = (error: string) => backTo("/start/?error=" + encodeURIComponent(error));
const adminPage = (channel: string, query: string) => backTo("/admin/?channel=" + channel + "&" + query + "#chat");
/** A channel's stored broadcaster token (broadcaster:<login>), from openBroadcaster. */
export type Broadcaster = {
  userId: string;
  /** The scopes Twitch granted: from the hourly validation, else the token answer. */
  scopes: () => string[];
  /** Checks the token with Twitch at most hourly (renewing it when expired); `checked` says whether it ran now. */
  validate: () => Promise<{ scopes: string[]; checked: boolean }>;
  /** A Helix call as the broadcaster; a 401 renews the token once and retries. */
  helix: (path: string, init?: RequestInit) => Promise<Response>;
};
// The broadcaster token a sign-in stored for this channel, or null. Renewals and validations are saved back.
export async function openBroadcaster(env: Env, channel: string): Promise<Broadcaster | null> {
  const encrypted = await record<StoredSeal | null>(env, "broadcaster:" + channel);
  if (!encrypted) return null;
  let token = await unseal<BroadcasterToken>(env, encrypted);
  const keep = async () => keepBroadcaster(env, channel, await seal(env, token));
  const renew = async () => {
    const r = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: env.TWITCH_CLIENT_ID,
        client_secret: env.TWITCH_CLIENT_SECRET,
      }),
    });
    const renewed = await answer(r, parseTwitchTokens);
    if (!renewed) throw new Error("Broadcaster must reconnect Twitch");
    token = { ...token, ...renewed, validatedAt: 0 };
  };
  // Twitch's token answer lists its scopes as `scope`; a validation stores them as `scopes`.
  const scopes = (): string[] =>
    token.scopes || (Array.isArray(token.scope) ? token.scope.filter((x) => typeof x === "string") : []);
  return {
    userId: token.userId,
    scopes,
    async validate() {
      if (Date.now() - token.validatedAt <= 3600000) return { scopes: scopes(), checked: false };
      const check = () =>
        fetch("https://id.twitch.tv/oauth2/validate", { headers: { Authorization: "OAuth " + token.access_token } });
      let r = await check();
      if (r.status === 401) {
        await renew();
        r = await check();
      }
      const v = await answer(r, parseTwitchValidation);
      if (!v) throw new Error("Twitch authorization unavailable");
      if (v.user_id !== token.userId || v.client_id !== env.TWITCH_CLIENT_ID)
        throw new Error("Broadcaster authorization is invalid");
      token = { ...token, scopes: v.scopes || [], validatedAt: Date.now() };
      await keep();
      return { scopes: scopes(), checked: true };
    },
    async helix(path, init = {}) {
      const call = () =>
        fetch("https://api.twitch.tv/helix" + path, {
          ...init,
          headers: {
            "Client-Id": env.TWITCH_CLIENT_ID,
            Authorization: "Bearer " + token.access_token,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
          },
        });
      let r = await call();
      if (r.status === 401) {
        await renew();
        await keep();
        r = await call();
      }
      return r;
    },
  };
}
const verdict = (moderator: boolean, reason = moderator ? "" : "Current Twitch moderator role required"): Access => ({
  owner: false,
  moderator,
  canManage: moderator,
  reason,
});
export async function access(env: Env, user: TwitchUser | null | undefined, channel: string): Promise<Access> {
  const owner = await isOwner(env, user);
  if (owner) return { owner: true, moderator: false, canManage: true };
  if (!user) return { owner: false, moderator: false, canManage: false, reason: "Sign in with Twitch" };
  // The broadcaster manages their own channel; the login comes from Twitch at sign-in, never from a form field.
  if (await isBroadcaster(env, user, channel))
    return { owner: false, broadcaster: true, moderator: false, canManage: true };
  // The Helix verdict is cached for a minute so a raid of signed-in viewers can't exhaust the broadcaster's rate limit.
  const cacheKey = "mod:" + channel + ":" + user.id,
    cached = await record<boolean | null>(env, cacheKey);
  if (cached !== null) return verdict(cached === true);
  const broadcaster = await openBroadcaster(env, channel);
  if (!broadcaster) return verdict(false, "Broadcaster must connect moderator authorization");
  const { scopes, checked } = await broadcaster.validate();
  if (checked && !scopes.includes("moderation:read")) throw new Error("Broadcaster authorization is invalid");
  const r = await broadcaster.helix(
    "/moderation/moderators?broadcaster_id=" + broadcaster.userId + "&user_id=" + encodeURIComponent(user.id),
  );
  const mods = await answer(r, parseModerators);
  if (!mods) throw new Error("Current moderator role cannot be verified");
  const moderator = mods.includes(user.id);
  await record(env, cacheKey, moderator, Date.now() + 60000);
  return verdict(moderator);
}
