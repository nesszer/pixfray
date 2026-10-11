import { chatStatus } from "./game.ts";
import site from "../site.config.js";
import { CHANNELS, record } from "./auth.ts";
import { channelState, overview, listRecords, setPaused, LOGIN } from "./channels.ts";
import { SE_ACTIONS, DEFAULT_SE_NAMES } from "./streamelements.ts";
import { rankHistory } from "./ranklog.ts";
import {
  isObject,
  parseBackupsRun,
  parseChannelsAction,
  parseCodePr,
  parseRestore,
  parseRoomRestore,
  parseRoomRestored,
  parseSettings,
} from "./parse.ts";
import { BACKUP_DAYS, backupChannels, backupDay, listBackups, readBackup, writeBackup } from "./backups.ts";
import type { TwitchUser } from "./auth.ts";
import type { Env } from "./env.ts";
import type { GameState } from "./model.ts";
import type { JsonObject } from "./parse.ts";
// Live-fix space (/api/dev/*). Owned by Lane E. worker.ts and channel.ts only call the exports below;
// keep the signatures (see docs/CONTRACTS.md, "Lane modules"). Every route is owner-only (isOwner = the
// configured owner account). Optional integrations degrade to 501 {reason:"*_not_configured"}:
//   GitHub (code editor + deploy flow): secret GITHUB_TOKEN, text GITHUB_REPO ("owner/name"),
//     optional GITHUB_BASE_BRANCH (main) and GITHUB_WORKFLOW (deploy.yml).
//   Cloudflare read-only API (request usage, versions): secret CF_API_TOKEN, text CF_ACCOUNT_ID.
//   Current version: version_metadata binding CF_VERSION_METADATA.
// The Worker never holds a token that can deploy; deploys run in GitHub Actions (docs/LIVE_FIX.md).

/** What bodyJson, setPaused and chatAction throw: an Error with the HTTP status to answer and chat details. */
type HttpError = Error & { status?: number; reason?: string; reconnect?: unknown; connectedElsewhere?: unknown };
/** The Worker's request context for /api/dev/* (server/worker.ts). */
export type DevContext = {
  user: TwitchUser | null;
  owner: boolean;
  /** The test site's dev token: no Origin check, no production changes. */
  dev: boolean;
  url: URL;
  path: string;
  roomFetch: (channel: string, path: string, init?: RequestInit) => Promise<Response>;
  chatAction: (channel: string, action: string, options: { takeover?: boolean }) => Promise<Response>;
  /** Throws an HttpError (status 400 or 413) unless the body is a JSON object. */
  bodyJson: (request: Request, limit: number) => Promise<JsonObject>;
  waitUntil?: (promise: Promise<unknown>) => void;
};
/** The context once handleDeveloper has checked the owner is signed in. */
type OwnerContext = DevContext & { user: TwitchUser };
/** What every route handler gets. body is the parsed POST body (routes that read it are POST only). */
type RouteArgs = {
  request: Request;
  env: Env;
  c: OwnerContext;
  body: JsonObject;
  query: URLSearchParams;
  room: (path: string, init?: RequestInit) => Promise<Response>;
};
type Handler = (args: RouteArgs) => Response | Promise<Response>;
/** A GitHub or Cloudflare REST answer: data is the parsed JSON (null when there is none). */
type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; data: T | null };
type GithubConfig = ReturnType<typeof githubConfig>;
type Gh = <T = unknown>(path: string, init?: RequestInit) => Promise<ApiResult<T>>;
type GithubArgs = RouteArgs & { g: GithubConfig; gh: Gh };
/**
 * A step that either worked or already holds the error response. Each side names the other's fields as optional, so
 * the loose worker program (no strictNullChecks, where a false branch doesn't narrow) can still read them.
 */
type Step<T> =
  | ({ ok: true; response?: undefined } & T)
  | ({ ok: false; response: Response } & { [K in keyof T]?: undefined });
/** The fields of a Cloudflare API envelope that cf() checks. */
type CfEnvelope = { success?: boolean; errors?: unknown[] };
/** The room side of ChannelRoom that the /dev/* routes use (server/channel.ts). */
export type DevRoom = {
  ctx: DurableObjectState;
  env: Env;
  readState(channel: string): GameState;
  writeState(state: GameState): void;
  broadcast(state: GameState): void;
  looksReset: boolean;
  flushLooksSoon(): void;
};
const MAX_LOG_ROWS = 500;
const VERSION = "0.2.0";
const DAILY_REQUEST_LIMIT = 100000;
const SCRIPTS = site.workers;
const MAX_FILE_BYTES = 512 * 1024;
const BRANCH = /^(live-fix|hotfix)\/[a-z0-9][a-z0-9._-]{0,60}$/;
const SHA = /^[a-f0-9]{40}$/;
// Restore points from the PITR API, e.g. 0000007b-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b.
const BOOKMARK = /^[0-9a-f]{1,32}(-[0-9a-f]{1,64}){1,7}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
// Paths the web editor may never read or write: local secrets, generated output, CI definitions.
const DENIED_PATH =
  /(^|\/)(\.dev\.vars[^/]*|\.secrets[^/]*|\.env[^/]*|node_modules|\.git|\.wrangler|\.cloudflare|dist)(\/|$)|^\.github\/|\.dpapi$/i;
// Files that run, or decide what runs, in the release build that holds the deploy token, plus wrangler config as a
// precaution: readable, never saved here.
const BUILD_FILE =
  /^(package\.json|package-lock\.json|bun\.lock|bunfig\.toml|\.npmrc|site\.config\.(js|ts)|cloudflare\.config\.ts|vite\.config\.[cm]?[jt]s|postcss\.config\.[cm]?[jt]s|\.postcssrc(\.(json|ya?ml|[cm]?[jt]s))?|wrangler\.(jsonc?|toml)|tsconfig(\.[^/]+)?\.json|types\/|scripts\/|\.github\/)/i;
// Production changes need the owner signed in with Twitch; the test site's dev token can't make them.
const productionChange = (op: string, body: JsonObject | null): boolean =>
  op === "promote" || op === "hotfix" || (op === "rollback" && body?.target === "production");
const json = (data: unknown, status = 200): Response =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const fail = (status: number, error: string, reason: string, extra: JsonObject = {}): Response =>
  json({ error, reason, ...extra }, status);

// ---------- Worker side ----------
// c = { user, owner, dev (test-site dev token: no Origin check), url, path, roomFetch(channel, path, init?), chatAction(channel, action, { takeover? }), bodyJson(request, limit), waitUntil(promise) }
export async function handleDeveloper(request: Request, env: Env, c: DevContext): Promise<Response> {
  if (!c.user) return fail(401, "Sign in with Twitch", "sign_in_required");
  if (!c.owner) return fail(403, "Owner only", "owner_only");
  const method = request.method,
    op = c.path.slice("/api/dev/".length).replace(/\/+$/, "");
  if (!c.dev && !["GET", "HEAD"].includes(method) && request.headers.get("Origin") !== c.url.origin)
    return fail(403, "Same-origin request required", "cross_origin");
  const route = ROUTES[op];
  if (!route) return fail(404, "Unknown developer route", "unknown_route", { op });
  const handler = route[method === "HEAD" ? "GET" : method];
  if (!handler) return fail(405, "Use " + Object.keys(route).join(" or "), "method_not_allowed", { op });
  let body: JsonObject | null = null;
  // Caught here so a bad body gets its own reason rather than the generic upstream error.
  if (method === "POST")
    try {
      body = await c.bodyJson(request, op === "code/save" ? MAX_FILE_BYTES * 2 + 4096 : 8000);
    } catch (e) {
      return fail(
        // bodyJson throws an HttpError (status 400 or 413)
        (e as HttpError).status || 400,
        // bodyJson throws an HttpError, as above
        (e as HttpError).message || "Invalid request body",
        // bodyJson throws an HttpError, as above
        (e as HttpError).status === 413 ? "body_too_large" : "invalid_body",
      );
    }
  if (c.dev && productionChange(op, body))
    return fail(
      403,
      "Production deploys need the owner signed in with Twitch, not the dev token",
      "owner_session_required",
    );
  // ?channel= picks which channel's room to read (logs, diagnostics); Worker errors land in the default channel.
  const asked = c.url.searchParams.get("channel") || "",
    channel = asked && (await channelState(env, asked)) ? asked : site.defaultChannel;
  try {
    return await handler({
      request,
      env,
      c: c as OwnerContext, // c.user is checked at the top
      body: body as JsonObject, // null only for GET, HEAD and DELETE, whose handlers never read it
      query: c.url.searchParams,
      room: (path, init) => c.roomFetch(channel, path, init),
    });
  } catch (error) {
    c.waitUntil?.(logWorkerError(env, error, { path: c.path }));
    return fail(503, "Service unavailable; check owner diagnostics", "upstream_error");
  }
}

const ROUTES: { [op: string]: { [method: string]: Handler } } = {
  diagnostics: { GET: diagnostics },
  channels: { GET: channelsList, POST: channelsAction },
  progress: { GET: progress },
  export: { GET: exportData },
  restore: { GET: restoreInfo, POST: restore },
  logs: {
    GET: ({ room, query }) => room("/dev/logs?" + logQuery(query)),
    DELETE: ({ room }) => room("/dev/logs", { method: "DELETE" }),
  },
  backups: { GET: backupsRead, POST: backupsRun },
  ranks: {
    GET: ({ room, query }) =>
      room("/dev/ranks?" + new URLSearchParams({ user: query.get("user") || "", limit: query.get("limit") || "" })),
  },
  settings: { GET: ({ room }) => room("/admin"), POST: settings },
  usage: { GET: async ({ env }) => json(await usage(env)) },
  versions: { GET: versions },
  "code/tree": { GET: withGithub(codeTree) },
  "code/file": { GET: withGithub(codeFile) },
  "code/save": { POST: withGithub(codeSave) },
  "code/pr": { POST: withGithub(codePr) },
  runs: { GET: withGithub(runs) },
  deploy: { POST: withGithub(deployTest) },
  promote: { POST: withGithub(promote) },
  hotfix: { POST: withGithub(hotfix) },
  rollback: { POST: withGithub(rollback) },
};

// Owner Channels table. Setup progress is a separate route (below), read in batches by the page, because each
// channel's progress is one room read and a Worker request may make at most 50 subrequests (Free plan).
const PROGRESS_MAX = 40;
async function channelsList({ env }: RouteArgs): Promise<Response> {
  return json({ ...(await overview(env)), progressBatch: PROGRESS_MAX });
}

// GET /api/dev/progress?logins=a,b,c: setup progress for up to 40 channels that are on (built in or enabled).
// One AuthStore read plus one room read per login, so 41 subrequests at most.
async function progress({ env, c, query }: RouteArgs): Promise<Response> {
  const raw = String(query.get("logins") || "")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
    logins = [...new Set(raw)];
  if (!logins.length)
    return fail(
      400,
      "logins is required: up to " + PROGRESS_MAX + " comma-separated channel logins",
      "logins_required",
    );
  if (logins.length > PROGRESS_MAX)
    return fail(400, "At most " + PROGRESS_MAX + " logins per request", "too_many_logins", { max: PROGRESS_MAX });
  const on = new Set([
    ...CHANNELS,
    ...(await listRecords(env, "channel:")).filter((r) => !r.value.pausedAt).map((r) => r.value.login),
  ]);
  const invalid = logins.filter((login) => !LOGIN.test(login) || !on.has(login));
  if (invalid.length)
    return fail(400, "Not a channel that is on: " + invalid.slice(0, 5).join(", "), "unknown_channel", { invalid });
  const reads = await Promise.all(
    logins.map((login) =>
      c
        .roomFetch(login, "/dev/progress")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ),
  );
  return json({ progress: Object.fromEntries(logins.map((login, i) => [login, reads[i]]).filter(([, p]) => p)) });
}

// Backups. GET /api/dev/export?channel=<login> downloads one room's data; ?registry=1 downloads the channel list.
// Neither contains the StreamElements key or Twitch tokens.
function download(data: unknown, filename: string): Response {
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
async function exportData({ env, c, query }: RouteArgs): Promise<Response> {
  const now = new Date(),
    day = now.toISOString().slice(0, 10),
    head = exportHead(now.getTime());
  if (query.get("registry") === "1") {
    const channels = await listRecords(env, "channel:");
    return download(
      {
        ...head,
        kind: "registry",
        builtin: CHANNELS,
        channels: channels.map((r) => ({
          id: r.value.id,
          login: r.value.login,
          enabledAt: r.value.enabledAt,
          pausedAt: r.value.pausedAt || 0,
          pausedBy: r.value.pausedBy || "",
        })),
      },
      `mini-chat-channels-${day}.json`,
    );
  }
  const login = String(query.get("channel") || "").toLowerCase();
  if (!login) return fail(400, "Use ?channel=<login> or ?registry=1", "export_target_required");
  const state = await channelState(env, login);
  if (!state) return fail(404, login + " is not set up", "unknown_channel");
  const r = await c.roomFetch(login, "/dev/export");
  if (!r.ok) return fail(502, "The channel room could not be read", "room_unavailable", { status: r.status });
  return download(
    // the room's roomExport()
    { ...head, kind: "channel", channel: login, status: state, ...(await r.json<JsonObject>()) },
    `mini-chat-${login}-${day}.json`,
  );
}

const exportHead = (at: number) => ({
  format: "mini-chat-export",
  version: 1,
  exportedAt: new Date(at).toISOString(),
});

// Daily backups (server/backups.ts). GET ?channel= lists the days kept; &day= downloads that day's export; &user= (login
// or id) reads one fighter from it. POST {channel?} backs up one channel or all of them now.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
async function backupsRead({ env, query }: RouteArgs): Promise<Response> {
  if (!env.BACKUPS) return fail(501, "No BACKUPS database is bound (local dev)", "backups_unavailable");
  const login = String(query.get("channel") || "").toLowerCase(),
    day = query.get("day") || "",
    user = String(query.get("user") || "")
      .replace(/^@/, "")
      .slice(0, 64);
  if (!LOGIN.test(login)) return fail(400, "Use ?channel=<login>", "channel_required");
  if (!day) return json({ channel: login, keepDays: BACKUP_DAYS, backups: await listBackups(env.BACKUPS, login) });
  if (!DAY.test(day)) return fail(400, "Use &day=YYYY-MM-DD", "invalid_day");
  const data = await readBackup(env.BACKUPS, login, day);
  if (!data) return fail(404, "No backup of " + login + " on " + day, "no_backup");
  if (!user) return download(data, `mini-chat-${login}-${day}-backup.json`);
  const lower = user.toLowerCase(),
    profile = data.profiles.find((p) => p.userId === user || String(p.username).toLowerCase() === lower);
  if (!profile) return fail(404, user + " is not in the " + day + " backup", "fighter_not_in_backup");
  const mine = (x: { userId: string }) => x.userId === profile.userId;
  return json({
    channel: login,
    day,
    exportedAt: data.exportedAt,
    profile,
    purchases: data.purchases.filter(mine),
    builds: data.builds.filter(mine),
  });
}
async function backupsRun({ env, c, body }: RouteArgs): Promise<Response> {
  if (!env.BACKUPS) return fail(501, "No BACKUPS database is bound (local dev)", "backups_unavailable");
  const input = parseBackupsRun(body);
  if (!input.ok) return fail(400, "channel must be a login", input.error);
  const login = input.value.channel.toLowerCase();
  if (login && !(await channelState(env, login))) return fail(404, login + " is not set up", "unknown_channel");
  const now = Date.now();
  return json({ day: backupDay(now), channels: await backupChannels(env, now, c.roomFetch, login) });
}

// Point-in-time restore. Cloudflare keeps 30 days of every change to a room's SQLite storage (fighters, ranks, dollars,
// settings, logs), so one channel can go back to any minute in that window. POST {channel, at} restores to `at`;
// POST {channel, undo: true} goes back to just before the last restore. The undo point lives in AuthStore, because the
// room's own storage is the thing being rolled back. GET ?channel= reads the last restore for the owner page.
/** The last restore of a channel, kept in AuthStore under restore:<login>. */
type RestoreRecord = { at: number; restoredAt: number; by: string; undo: string };
/** A room's refusal body. */
type RoomRefusal = { error?: string; reason?: string };
const DAY_MS = 86400000,
  RESTORE_WINDOW_MS = 30 * DAY_MS,
  RESTORE_MARGIN_MS = 60000;
async function restoreInfo({ env, query }: RouteArgs): Promise<Response> {
  const login = String(query.get("channel") || "").toLowerCase();
  if (!LOGIN.test(login)) return fail(400, "Use ?channel=<login>", "channel_required");
  const last = await record<RestoreRecord | null>(env, "restore:" + login);
  return json({
    channel: login,
    last: last ? { at: last.at, restoredAt: last.restoredAt, by: last.by } : null,
    windowDays: 30,
  });
}
async function restore({ env, c, body }: RouteArgs): Promise<Response> {
  const input = parseRestore(body);
  if (!input.ok) return fail(400, "Send {channel, at} or {channel, undo: true}", input.error);
  const login = input.value.channel.toLowerCase(),
    { undo, at } = input.value,
    now = Date.now();
  if (!LOGIN.test(login) || !(await channelState(env, login)))
    return fail(404, (login || "That channel") + " is not set up", "unknown_channel");
  const last = undo ? await record<RestoreRecord | null>(env, "restore:" + login) : null;
  if (undo && !last?.undo) return fail(409, "There is no restore to undo on " + login, "nothing_to_undo");
  if (
    !undo &&
    !(Number.isFinite(at) && at >= now - RESTORE_WINDOW_MS + RESTORE_MARGIN_MS && at <= now - RESTORE_MARGIN_MS)
  ) {
    return fail(400, "Pick a time between 30 days ago and 1 minute ago", "invalid_restore_time");
  }
  const post = (path: string, data: unknown) =>
    c.roomFetch(login, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  // undo is only true here when last.undo is set (checked above)
  const r = await post("/dev/restore", undo ? { bookmark: last!.undo } : { at });
  if (!r.ok) {
    const e = await r.json<RoomRefusal>().catch((): RoomRefusal => ({}));
    return fail(
      r.status === 501 ? 501 : 502,
      e.error || "The channel room could not be restored",
      e.reason || "room_unavailable",
    );
  }
  const point = await r.json<{ undo: string; revision: number }>(); // the room's /dev/restore answer
  // The restore is now armed for the room's next start, so restart it right away: waiting would apply it at some
  // random later moment. ctx.abort() ends the room's session, so this call fails by design.
  await post("/dev/restart", {}).catch(() => null);
  let after: { players: number; profiles: number } | null = null;
  for (let i = 0; i < 3 && !after; i++)
    after = await post("/dev/restored", { revision: point.revision })
      // the room's /dev/restored answer
      .then((x) => (x.ok ? x.json<{ players: number; profiles: number }>() : null))
      .catch(() => null);
  let undoSaved = true;
  try {
    await record(
      env,
      "restore:" + login,
      undo ? null : { at, restoredAt: now, by: c.user.login, undo: point.undo },
      now + RESTORE_WINDOW_MS,
    );
  } catch {
    undoSaved = false;
  }
  if (!after)
    return fail(
      502,
      "Restored, but the room has not started again yet. Open the channel page in a minute to check.",
      "restart_pending",
      { undoSaved },
    );
  return json({
    ok: true,
    channel: login,
    at: undo ? null : at,
    undone: undo,
    undoSaved,
    players: after.players,
    profiles: after.profiles,
  });
}

// Owner Channels box: turn a channel off or on. Off from here sticks: the streamer can't turn it back on.
async function channelsAction({ env, body }: RouteArgs): Promise<Response> {
  const input = parseChannelsAction(body);
  if (!input.ok) return fail(400, "login must be a channel login", input.error);
  const { action, login } = input.value;
  try {
    if (action === "pause" || action === "resume") await setPaused(env, login, action === "pause", "owner");
    else return fail(400, "Unknown action", "unknown_action");
  } catch (e) {
    // setPaused throws an HttpError with a status and reason; anything else is unexpected. Each cast reads that error.
    if ((e as HttpError).reason)
      return fail((e as Required<HttpError>).status, (e as HttpError).message, (e as Required<HttpError>).reason);
    throw e;
  }
  return json({ ok: true, ...(await overview(env)) });
}

async function diagnostics({ env, room }: RouteArgs): Promise<Response> {
  const [r, use] = await Promise.all([room("/dev/diagnostics"), usage(env)]);
  const meta = env.CF_VERSION_METADATA;
  return json({
    worker: {
      version: VERSION,
      twitchConfigured: !!(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET),
      productionEnabled: false,
      deployedVersion: meta?.id ? { id: meta.id, tag: meta.tag || "", timestamp: meta.timestamp || "" } : null,
    },
    room: r.ok ? await r.json() : { error: "Room unavailable", status: r.status },
    integrations: { github: githubPublic(env), cloudflare: cloudflarePublic(env) },
    usage: use,
  });
}

function logQuery(query: URLSearchParams): string {
  const out = new URLSearchParams(),
    source = query.get("source"),
    limit = Number(query.get("limit"));
  if (source === "room" || source === "worker") out.set("source", source);
  if (Number.isInteger(limit) && limit >= 1 && limit <= 100) out.set("limit", String(limit));
  return out.toString();
}

// Live settings editor: a thin passthrough to the room's versioned config (docs/CONTRACTS.md section 7),
// plus the chat source lifecycle (connectChat / disconnectChat, handled by the Worker's EventSub helpers).
async function settings({ body, c, room }: RouteArgs): Promise<Response> {
  const input = parseSettings(body);
  if (!input.ok) return fail(400, "takeover must be true or false", input.error);
  const { action, takeover } = input.value;
  if (action === "connectChat" || action === "disconnectChat") {
    try {
      return await c.chatAction(site.defaultChannel, action, { takeover });
    } catch (e) {
      // chatAction throws an HttpError (status, maybe reconnect or connectedElsewhere) for answers the page shows;
      // each cast below reads that error
      if ((e as HttpError).status)
        return fail((e as Required<HttpError>).status, (e as HttpError).message, "chat_error", {
          ...((e as HttpError).reconnect ? { reconnect: (e as HttpError).reconnect } : {}),
          ...((e as HttpError).connectedElsewhere ? { connectedElsewhere: (e as HttpError).connectedElsewhere } : {}),
        });
      throw e;
    }
  }
  if (action !== "config" && action !== "rollbackConfig")
    return fail(400, "action must be config, rollbackConfig, connectChat or disconnectChat", "invalid_action");
  const { payload } = input.value;
  if (!isObject(payload)) return fail(400, "payload object required", "invalid_payload");
  return room("/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Mini-User-Id": c.user.id },
    body: JSON.stringify({ action, payload, actorId: c.user.id, actorName: c.user.displayName || c.user.login }),
  });
}

// ---------- Cloudflare (read-only) ----------
function cloudflarePublic(env: Env) {
  const missing = [
    !env.CF_API_TOKEN && "CF_API_TOKEN",
    !(env.CF_ACCOUNT_ID && /^[a-f0-9]{32}$/.test(env.CF_ACCOUNT_ID)) && "CF_ACCOUNT_ID",
  ].filter(Boolean);
  return { configured: !missing.length, missing, versionMetadata: !!env.CF_VERSION_METADATA };
}
async function cf<T = unknown>(env: Env, path: string, init: RequestInit = {}): Promise<ApiResult<T & CfEnvelope>> {
  const r = await fetch("https://api.cloudflare.com/client/v4" + path, {
    ...init,
    headers: { Authorization: "Bearer " + env.CF_API_TOKEN, "Content-Type": "application/json" },
  });
  const data = await r.json<T & CfEnvelope>().catch(() => null); // REST shapes are parsed in TS19
  // ok answers carry a JSON envelope; an ok answer with a bad body still has data null, and the caller's read of it
  // throws, which answers an error
  return { ok: r.ok && data?.success !== false && !data?.errors?.length, status: r.status, data } as ApiResult<
    T & CfEnvelope
  >;
}

/** The GraphQL Analytics answer, as far as usage() reads it. */
type Analytics = {
  data?: {
    viewer?: {
      accounts?: {
        workersInvocationsAdaptive?: {
          sum?: { requests?: number; errors?: number; subrequests?: number };
          dimensions?: { scriptName?: string };
        }[];
      }[];
    };
  };
};
/** The Workers deployments and versions lists, as far as versions() reads them. */
type CfDeployments = {
  result?: {
    deployments?: {
      id?: string;
      created_on?: string;
      source?: string;
      annotations?: { [key: string]: string };
      versions?: { version_id?: string; percentage?: number }[];
    }[];
  };
};
type CfVersions = {
  result?: {
    items?: {
      id?: string;
      number?: number;
      metadata?: { created_on?: string };
      annotations?: { [key: string]: string };
    }[];
  };
};

// Today's Worker requests (UTC day, account-wide, which is how the Free limit counts) from the GraphQL Analytics API.
export async function usage(env: Env, now = Date.now()) {
  const day = new Date(now),
    since = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const base = {
    limit: DAILY_REQUEST_LIMIT,
    since: since.toISOString(),
    resetsAt: new Date(since.getTime() + 86400000).toISOString(),
  };
  if (!cloudflarePublic(env).configured)
    return {
      ...base,
      configured: false,
      reason: "cloudflare_not_configured",
      error: "Set CF_API_TOKEN and CF_ACCOUNT_ID to read request usage",
    };
  const query =
    "query($a:String!,$s:Time!,$u:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:100,filter:{datetime_geq:$s,datetime_leq:$u}){sum{requests errors subrequests} dimensions{scriptName}}}}}";
  try {
    const r = await cf<Analytics>(env, "/graphql", {
      method: "POST",
      body: JSON.stringify({
        query,
        variables: { a: env.CF_ACCOUNT_ID, s: since.toISOString(), u: new Date(now).toISOString() },
      }),
    });
    const rows = r.data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
    if (!r.ok || !Array.isArray(rows))
      return { ...base, configured: true, error: "Analytics query failed", status: r.status };
    const scripts: { [script: string]: { requests: number; errors: number; subrequests: number } } = {};
    for (const row of rows) {
      const s = (scripts[row.dimensions?.scriptName || "unknown"] ||= { requests: 0, errors: 0, subrequests: 0 });
      s.requests += row.sum?.requests || 0;
      s.errors += row.sum?.errors || 0;
      s.subrequests += row.sum?.subrequests || 0;
    }
    const requests = Object.values(scripts).reduce((n, s) => n + s.requests, 0);
    return {
      ...base,
      configured: true,
      requests,
      percent: Math.round((requests / DAILY_REQUEST_LIMIT) * 1000) / 10,
      scripts,
    };
  } catch {
    return { ...base, configured: true, error: "Analytics unavailable" };
  }
}

async function versions({ env }: RouteArgs): Promise<Response> {
  const conf = cloudflarePublic(env);
  if (!conf.configured)
    return fail(
      501,
      "Cloudflare API is not configured: set CF_API_TOKEN and CF_ACCOUNT_ID",
      "cloudflare_not_configured",
      { missing: conf.missing },
    );
  const out: { [target: string]: unknown } = {};
  for (const [target, script] of Object.entries(SCRIPTS)) {
    const base = `/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${script}`;
    const [d, v] = await Promise.all([
      cf<CfDeployments>(env, base + "/deployments"),
      cf<CfVersions>(env, base + "/versions"),
    ]);
    out[target] = {
      script,
      deployments: d.ok
        ? (d.data.result?.deployments || []).slice(0, 5).map((x) => ({
            id: x.id,
            createdOn: x.created_on,
            source: x.source,
            message: x.annotations?.["workers/message"] || "",
            versions: (x.versions || []).map((y) => ({ versionId: y.version_id, percentage: y.percentage })),
          }))
        : [],
      versions: v.ok
        ? (v.data.result?.items || []).slice(0, 10).map((x) => ({
            id: x.id,
            number: x.number,
            createdOn: x.metadata?.created_on,
            tag: x.annotations?.["workers/tag"] || "",
            message: x.annotations?.["workers/message"] || "",
          }))
        : [],
      error: d.ok && v.ok ? undefined : "Cloudflare API error " + (d.ok ? v.status : d.status),
    };
  }
  return json(out);
}

// ---------- GitHub ----------
function githubConfig(env: Env) {
  const repo = String(env.GITHUB_REPO || ""),
    base = String(env.GITHUB_BASE_BRANCH || "main"),
    workflow = String(env.GITHUB_WORKFLOW || "deploy.yml");
  const missing = [!env.GITHUB_TOKEN && "GITHUB_TOKEN", !REPO.test(repo) && "GITHUB_REPO"].filter(Boolean);
  return { configured: !missing.length, missing, repo, base, workflow };
}
function githubPublic(env: Env) {
  const { configured, missing, repo, base, workflow } = githubConfig(env);
  return { configured, missing, repo: configured ? repo : "", base, workflow };
}
function withGithub(fn: (args: GithubArgs) => Promise<Response>): Handler {
  return (ctx) => {
    const g = githubConfig(ctx.env);
    if (!g.configured)
      return fail(
        501,
        "GitHub is not configured: set the GITHUB_TOKEN secret and GITHUB_REPO (see docs/LIVE_FIX.md)",
        "github_not_configured",
        { missing: g.missing },
      );
    return fn({ ...ctx, g, gh: (path, init) => gh(ctx.env, g, path, init) });
  };
}
async function gh<T = unknown>(env: Env, g: GithubConfig, path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const r = await fetch("https://api.github.com/repos/" + g.repo + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + env.GITHUB_TOKEN,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": site.workers.production,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const data = r.status === 204 ? null : await r.json<T>().catch(() => null); // REST shapes are parsed in TS19
  // ok answers carry JSON except 204 (dispatch reads no data); an ok answer with a bad body still has data null, and
  // the caller's read of it throws, which answers 503
  return { ok: r.ok, status: r.status, data } as ApiResult<T>;
}
function ghError(r: { status: number; data: unknown }, what: string): Response {
  const status = [404, 409, 422].includes(r.status) ? (r.status === 422 ? 409 : r.status) : 502;
  return fail(
    status,
    // GitHub error bodies are { message } or unreadable (null); clean() reads anything through String()
    `${what}: GitHub ${r.status} ${clean((r.data as { message?: string } | null)?.message || "", 200)}`.trim(),
    "github_error",
    {
      githubStatus: r.status,
    },
  );
}
const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export function validPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length < 1 || path.length > 200 || !/^[A-Za-z0-9._\-/]+$/.test(path))
    return false;
  if (path.split("/").some((s) => !s || s === "." || s === "..")) return false;
  return !DENIED_PATH.test(path);
}
const validRef = (ref: string, base: string) => ref === base || BRANCH.test(ref);

async function codeTree({ g, gh, query }: GithubArgs): Promise<Response> {
  const ref = query.get("ref") || g.base;
  if (!validRef(ref, g.base)) return fail(400, "ref must be the base branch, live-fix/* or hotfix/*", "invalid_ref");
  const r = await gh<{ tree?: { type?: string; path?: string; size?: number }[]; truncated?: boolean }>(
    "/git/trees/" + enc(ref) + "?recursive=1",
  );
  if (!r.ok) return ghError(r, "Read tree");
  const files = (r.data.tree || [])
    .filter((x) => x.type === "blob" && validPath(x.path))
    .slice(0, 2000)
    .map((x) => ({ path: x.path, size: x.size }));
  return json({ ref, files, truncated: !!r.data.truncated });
}

/** GitHub's contents answer: a file, or a directory listing (an array). */
type GhContent = { type?: string; size: number; encoding?: string; content?: string; sha?: string } | unknown[];

// Reads from `branch` when it exists, otherwise from the base branch, so a new edit starts from main.
async function codeFile({ g, gh, query }: GithubArgs): Promise<Response> {
  const path = query.get("path"),
    branch = query.get("branch") || "";
  if (!validPath(path)) return fail(400, "Invalid or protected path", "invalid_path");
  if (branch && !validRef(branch, g.base)) return fail(400, "branch must be live-fix/* or hotfix/*", "invalid_branch");
  let ref = branch || g.base,
    r = await gh<GhContent>("/contents/" + enc(path) + "?ref=" + encodeURIComponent(ref));
  if (r.status === 404 && branch && branch !== g.base && !(await gh("/git/ref/heads/" + enc(branch))).ok) {
    ref = g.base;
    r = await gh<GhContent>("/contents/" + enc(path) + "?ref=" + encodeURIComponent(ref));
  }
  if (!r.ok) return ghError(r, "Read file");
  if (Array.isArray(r.data) || r.data?.type !== "file") return fail(400, "Path is not a file", "not_a_file");
  if (r.data.size > MAX_FILE_BYTES || r.data.encoding !== "base64")
    return fail(413, "File is too large for the web editor (512 KB max)", "file_too_large");
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(fromBase64(r.data.content));
  } catch {
    return fail(415, "Binary files cannot be edited here", "binary_file");
  }
  return json({ path, ref, sha: r.data.sha, size: r.data.size, content });
}

async function ensureBranch(g: GithubConfig, gh: Gh, branch: string): Promise<Step<{ created: boolean }>> {
  const existing = await gh("/git/ref/heads/" + enc(branch));
  if (existing.ok) return { ok: true, created: false };
  if (existing.status !== 404) return { ok: false, response: ghError(existing, "Read branch") };
  const base = await gh<{ object: { sha: string } }>("/git/ref/heads/" + enc(g.base));
  if (!base.ok) return { ok: false, response: ghError(base, "Read base branch") };
  const made = await gh("/git/refs", {
    method: "POST",
    body: JSON.stringify({ ref: "refs/heads/" + branch, sha: base.data.object.sha }),
  });
  return made.ok ? { ok: true, created: true } : { ok: false, response: ghError(made, "Create branch") };
}

async function codeSave({ g, gh, body }: GithubArgs): Promise<Response> {
  const { path, content, branch, sha } = body;
  if (!validPath(path)) return fail(400, "Invalid or protected path", "invalid_path");
  if (BUILD_FILE.test(path))
    return fail(
      403,
      "Build and deploy files (package.json, scripts/, configs, .github/) are changed in the repository, not here",
      "build_file",
    );
  if (typeof content !== "string") return fail(400, "content must be a string", "invalid_content");
  const bytes = new TextEncoder().encode(content);
  if (bytes.length > MAX_FILE_BYTES)
    return fail(413, "File is too large for the web editor (512 KB max)", "file_too_large");
  if (typeof branch !== "string" || !BRANCH.test(branch))
    return fail(
      400,
      "branch must look like live-fix/<name> or hotfix/<name>; the base branch only changes through promote",
      "invalid_branch",
    );
  if (sha !== undefined && (typeof sha !== "string" || !SHA.test(sha)))
    return fail(400, "sha must be a 40-character blob sha", "invalid_sha");
  const message = clean(
    typeof body.message === "string" && body.message.trim() ? body.message : "Live fix: " + path,
    200,
  );
  const b = await ensureBranch(g, gh, branch);
  if (!b.ok) return b.response;
  const r = await gh<{ content?: { sha?: string }; commit?: { sha?: string } }>("/contents/" + enc(path), {
    method: "PUT",
    body: JSON.stringify({ message, content: toBase64(bytes), branch, ...(sha ? { sha } : {}) }),
  });
  if (!r.ok)
    return ghError(
      r,
      r.status === 409 || r.status === 422 ? "Save conflict (reload the file from this branch)" : "Save file",
    );
  return json({
    ok: true,
    path,
    branch,
    branchCreated: b.created,
    sha: r.data.content?.sha,
    commit: r.data.commit?.sha,
  });
}

/** A pull request as openPr reads it. */
type GhPr = { number: number; html_url: string };
async function openPr(
  g: GithubConfig,
  gh: Gh,
  branch: string,
  title: string,
  text: string,
): Promise<Step<{ pr: { number: number; url: string; existing: boolean } }>> {
  const owner = g.repo.split("/")[0];
  const found = await gh<GhPr[]>("/pulls?state=open&head=" + encodeURIComponent(owner + ":" + branch));
  if (found.ok && found.data?.[0])
    return { ok: true, pr: { number: found.data[0].number, url: found.data[0].html_url, existing: true } };
  const r = await gh<GhPr>("/pulls", {
    method: "POST",
    body: JSON.stringify({ title, head: branch, base: g.base, body: text }),
  });
  return r.ok
    ? { ok: true, pr: { number: r.data.number, url: r.data.html_url, existing: false } }
    : { ok: false, response: ghError(r, "Open pull request") };
}

async function codePr({ g, gh, body }: GithubArgs): Promise<Response> {
  const input = parseCodePr(body);
  if (!input.ok) return fail(400, "title and body must be text", input.error);
  const { branch, title, text } = input.value;
  if (typeof branch !== "string" || !BRANCH.test(branch))
    return fail(400, "branch must be live-fix/* or hotfix/*", "invalid_branch");
  const p = await openPr(
    g,
    gh,
    branch,
    clean(title || "Live fix: " + branch, 120),
    clean(text || "Opened from the mini-chat live-fix space.", 2000),
  );
  return p.ok ? json({ ok: true, ...p.pr }) : p.response;
}

async function runs({ g, gh }: GithubArgs): Promise<Response> {
  const r = await gh<{ workflow_runs?: GhRun[] }>("/actions/workflows/" + enc(g.workflow) + "/runs?per_page=10");
  if (!r.ok) return ghError(r, "List workflow runs");
  return json(
    (r.data.workflow_runs || []).map((x) => ({
      id: x.id,
      title: x.display_title,
      status: x.status,
      conclusion: x.conclusion,
      branch: x.head_branch,
      sha: x.head_sha,
      createdAt: x.created_at,
      url: x.html_url,
    })),
  );
}

/** A workflow run as runs() reads it. */
type GhRun = {
  id: number;
  display_title?: string;
  status?: string;
  conclusion?: string | null;
  head_branch?: string;
  head_sha?: string;
  created_at?: string;
  html_url?: string;
};

// Every deploy, promote, hotfix and rollback is one workflow_dispatch of .github/workflows/deploy.yml.
async function dispatch(
  g: GithubConfig,
  gh: Gh,
  ref: string,
  inputs: { [input: string]: unknown },
): Promise<Step<{ dispatched: { [field: string]: unknown } }>> {
  const requestId =
    "r" + Array.from(crypto.getRandomValues(new Uint8Array(5)), (x) => x.toString(16).padStart(2, "0")).join("");
  const all = {
    operation: "deploy",
    target: "test",
    sha: "",
    percentage: "100",
    version_id: "",
    hotfix: "false",
    reason: "",
    ...inputs,
    request_id: requestId,
  };
  const r = await gh("/actions/workflows/" + enc(g.workflow) + "/dispatches", {
    method: "POST",
    body: JSON.stringify({ ref, inputs: all }),
  });
  return r.ok
    ? { ok: true, dispatched: { requestId, ref, ...all } }
    : { ok: false, response: ghError(r, "Start workflow") };
}
function common(
  body: JsonObject,
): { error: Response; sha?: undefined; reason?: undefined } | { error?: undefined; sha: unknown; reason: string } {
  if (body.sha !== undefined && body.sha !== "" && (typeof body.sha !== "string" || !SHA.test(body.sha)))
    return { error: fail(400, "sha must be a 40-character commit sha", "invalid_sha") };
  if (body.reason !== undefined && typeof body.reason !== "string")
    return { error: fail(400, "reason must be a string", "invalid_reason") };
  return { sha: body.sha || "", reason: clean(body.reason || "", 100) };
}

async function deployTest({ g, gh, body }: GithubArgs): Promise<Response> {
  if (body.target !== undefined && body.target !== "test")
    return fail(400, "deploy only targets test; use promote or hotfix for production", "invalid_target");
  const ref = body.ref || g.base;
  if (typeof ref !== "string" || !validRef(ref, g.base))
    return fail(400, "ref must be the base branch, live-fix/* or hotfix/*", "invalid_ref");
  const x = common(body);
  if (x.error) return x.error;
  const d = await dispatch(g, gh, ref, { target: "test", sha: x.sha, reason: x.reason || "test deploy of " + ref });
  return d.ok ? json({ ok: true, ...d.dispatched }, 202) : d.response;
}

const percentOf = (v: unknown) => (v === undefined ? 100 : Number.isInteger(v) && v >= 1 && v <= 100 ? v : null);

/** A pull request as promote reads it. */
type GhPull = {
  base?: { ref?: string };
  head: { ref?: string; sha: string };
  merged?: boolean;
  merge_commit_sha?: string;
  state?: string;
};

// Promote: optionally squash-merge the live-fix PR, then deploy the base branch to production.
async function promote({ g, gh, body }: GithubArgs): Promise<Response> {
  const percentage = percentOf(body.percentage);
  if (percentage === null) return fail(400, "percentage must be an integer from 1 to 100", "invalid_percentage");
  if (body.number !== undefined && (!Number.isInteger(body.number) || body.number < 1))
    return fail(400, "number must be a pull request number", "invalid_number");
  const x = common(body);
  if (x.error) return x.error;
  let merged: { number: unknown; sha: unknown; alreadyMerged: boolean } | null = null,
    sha = x.sha;
  if (body.number) {
    const pr = await gh<GhPull>("/pulls/" + body.number);
    if (!pr.ok) return ghError(pr, "Read pull request");
    if (pr.data.base?.ref !== g.base || !BRANCH.test(pr.data.head?.ref || ""))
      return fail(
        400,
        "Only live-fix/* or hotfix/* pull requests into the base branch can be promoted",
        "invalid_pull_request",
      );
    if (pr.data.merged) merged = { number: body.number, sha: pr.data.merge_commit_sha, alreadyMerged: true };
    else {
      if (pr.data.state !== "open") return fail(409, "Pull request is closed", "pull_request_closed");
      const m = await gh<{ sha?: string }>("/pulls/" + body.number + "/merge", {
        method: "PUT",
        body: JSON.stringify({ merge_method: "squash", sha: pr.data.head.sha }),
      });
      if (!m.ok) return ghError(m, "Merge pull request");
      merged = { number: body.number, sha: m.data.sha, alreadyMerged: false };
    }
    sha = merged.sha;
  }
  const d = await dispatch(g, gh, g.base, {
    target: "production",
    sha,
    percentage: String(percentage),
    reason: x.reason || (merged ? "promote #" + merged.number : "promote " + g.base),
  });
  return d.ok ? json({ ok: true, merged, ...d.dispatched }, 202) : d.response;
}

// Hotfix: deploy a hotfix/* branch straight to production (unit tests still run), and open a PR so
// the base branch picks the change up before the next promote.
async function hotfix({ g, gh, body }: GithubArgs): Promise<Response> {
  if (typeof body.branch !== "string" || !body.branch.startsWith("hotfix/") || !BRANCH.test(body.branch))
    return fail(400, "branch must look like hotfix/<name>", "invalid_branch");
  const x = common(body);
  if (x.error) return x.error;
  const d = await dispatch(g, gh, body.branch, {
    target: "production",
    sha: x.sha,
    hotfix: "true",
    reason: x.reason || "hotfix " + body.branch,
  });
  if (!d.ok) return d.response;
  const p = await openPr(
    g,
    gh,
    body.branch,
    "Hotfix: " + body.branch,
    "Deployed to production as a hotfix from the live-fix space. Merge so the base branch keeps it.",
  );
  return json(
    {
      ok: true,
      ...d.dispatched,
      pr: p.ok ? p.pr : null,
      prError: p.ok ? undefined : "Pull request not opened; open it manually",
    },
    202,
  );
}

async function rollback({ g, gh, body }: GithubArgs): Promise<Response> {
  // Object.hasOwn turns any value into a key, so a non-string target is simply not found
  if (!Object.hasOwn(SCRIPTS, body.target as PropertyKey))
    return fail(400, "target must be test or production", "invalid_target");
  if (
    body.versionId !== undefined &&
    body.versionId !== "" &&
    (typeof body.versionId !== "string" || !UUID.test(body.versionId))
  )
    return fail(400, "versionId must be a Worker version UUID", "invalid_version");
  const x = common(body);
  if (x.error) return x.error;
  const d = await dispatch(g, gh, g.base, {
    operation: "rollback",
    target: body.target,
    version_id: body.versionId || "",
    reason: x.reason || "rollback " + body.target,
  });
  return d.ok ? json({ ok: true, ...d.dispatched }, 202) : d.response;
}

function clean(value: unknown, max: number): string {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, max);
}
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(text: unknown): Uint8Array {
  const s = atob(String(text).replace(/\s+/g, ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------- Durable Object side (ChannelRoom) ----------
// Reached only with the internal secret (ChannelRoom.authorized), so these routes trust the caller.
/** An error_log row. */
type LogRow = { id: number; at: number; source: string; message: string; context: string };

export async function handleRoomDeveloper(
  room: DevRoom,
  request: Request,
  { path, channel, url }: { path: string; channel: string; url?: URL | undefined },
): Promise<Response> {
  const sql = room.ctx.storage.sql,
    method = request.method;
  if (path === "/dev/diagnostics" && method === "GET") {
    const state = room.readState(channel);
    const counts = Object.fromEntries(
      sql
        .exec<{ source: string; n: number }>("SELECT source, COUNT(*) AS n FROM error_log GROUP BY source")
        .toArray()
        .map((r): [string, number] => [r.source, r.n]),
    );
    // Chat command lines and warnings share the log but aren't errors; the health summary counts room and Worker errors only.
    const last =
      sql
        .exec<Omit<LogRow, "id" | "context">>(
          "SELECT at, source, message FROM error_log WHERE source IN ('room', 'worker') ORDER BY id DESC LIMIT 1",
        )
        .toArray()[0] || null;
    return json({
      channel,
      revision: state.revision,
      chat: {
        connected: Boolean(state.chat?.connected),
        lastSeen: Number(state.chat?.lastSeen) || 0,
        status: String(state.chat?.status || "disconnected"),
      },
      chatStatus: chatStatus(state),
      seLastCommandAt:
        Number(
          sql.exec<{ last_command_at: number }>("SELECT last_command_at FROM se_settings WHERE id = 1").toArray()[0]
            ?.last_command_at,
        ) || 0,
      paused: !state.chat?.connected || !state.config?.enabled,
      configVersion: state.configVersion,
      players: state.players.length,
      openDuels: state.duels.filter((d) => d.status === "pending" || d.status === "active").length,
      sockets: { live: room.ctx.getWebSockets("live").length },
      errors: (counts.room || 0) + (counts.worker || 0),
      errorsBySource: counts,
      lastError: last,
    });
  }
  if (path === "/dev/logs" && method === "GET") {
    const q = url || new URL(request.url),
      source = q.searchParams.get("source"),
      limit = Math.min(100, Math.max(1, Number(q.searchParams.get("limit")) || 100));
    // includes() is false for a missing source (null)
    const rows = ["room", "worker", "command", "warn"].includes(source as string)
      ? sql
          .exec<LogRow>(
            "SELECT id, at, source, message, context FROM error_log WHERE source = ? ORDER BY id DESC LIMIT ?",
            source,
            limit,
          )
          .toArray()
      : sql
          .exec<LogRow>("SELECT id, at, source, message, context FROM error_log ORDER BY id DESC LIMIT ?", limit)
          .toArray();
    return json(rows.map((r) => ({ ...r, context: safeParse(r.context) })));
  }
  // A fighter's rank history, newest first: ?user=<login or id>&limit=1..500 (default 100).
  if (path === "/dev/ranks" && method === "GET") {
    const q = url || new URL(request.url),
      user = (q.searchParams.get("user") || "").replace(/^@/, "").slice(0, 64),
      limit = Math.min(500, Math.max(1, Number(q.searchParams.get("limit")) || 100));
    if (!user) return json({ error: "Name a fighter with ?user=", reason: "invalid_user" }, 400);
    return json(rankHistory(sql, user, limit));
  }
  if (path === "/dev/logs" && method === "DELETE") {
    sql.exec("DELETE FROM error_log");
    return json({ ok: true });
  }
  if (path === "/dev/log" && method === "POST") {
    // Any JSON: insertLog stringifies and clips every field
    const body = await request
      .json<{ source?: unknown; message?: unknown; context?: unknown } | null>()
      .catch((): { source?: unknown; message?: unknown; context?: unknown } => ({}));
    // The Worker logs errors here, and as "warn" the profile saves it refuses before they reach the room.
    insertLog(sql, body?.source === "warn" ? "warn" : "worker", body?.message, body?.context);
    return json({ ok: true });
  }
  // Setup progress for the owner's Channels table: read only, so it never creates a StreamElements key.
  if (path === "/dev/progress" && method === "GET") {
    const state = room.readState(channel),
      chat = chatStatus(state);
    const se = sql
      .exec<{ last_command_at: number; rejected_at: number; seen_json: string; duel_module_off: number }>(
        "SELECT last_command_at, rejected_at, seen_json, duel_module_off FROM se_settings WHERE id = 1",
      )
      .toArray()[0];
    const seen: { [action: string]: unknown } = se ? safeParse<{ [action: string]: unknown }>(se.seen_json) || {} : {};
    return json({
      overlays: room.ctx.getWebSockets("overlay").length,
      source: chat.connected ? chat.source : "",
      commandsWorking: SE_ACTIONS.filter((a) => Number(seen[a]) > 0).length,
      commands: SE_ACTIONS.length,
      duelCommands: ["challenge", "accept", "decline"].every((a) => Number(seen[a]) > 0),
      duelModuleOff: se?.duel_module_off === 1,
      lastCommandAt: Number(se?.last_command_at) || 0,
      rejectedAt: Number(se?.rejected_at) || 0,
      lastChatAt: Number(chat.lastNotificationAt) || 0,
      players: state.players.length,
    });
  }
  if (path === "/dev/export" && method === "GET") return json(roomExport(room, channel));
  // Daily backup (server/backups.ts): this room's export, written by the room itself so the cron run stays small.
  if (path === "/dev/backup" && method === "POST") {
    if (!room.env.BACKUPS) return json({ error: "No BACKUPS database is bound", reason: "backups_unavailable" }, 501);
    // Any JSON: both fields are checked below
    const { at, status } = await request
      .json<{ at?: unknown; status?: unknown }>()
      .catch((): { at?: unknown; status?: unknown } => ({}));
    // includes() is false for anything but those strings
    if (!Number.isInteger(at) || !["builtin", "on", "paused"].includes(status as string))
      return json({ error: "Send {at, status}", reason: "invalid_backup" }, 400);
    const data = { ...exportHead(at), kind: "channel", channel, status, ...roomExport(room, channel) };
    return json({ ok: true, bytes: await writeBackup(room.env.BACKUPS, channel, at, data) });
  }
  // Point-in-time restore, called by the Worker's restore() in this order: restore arms the restore point and returns
  // the undo point; restart ends this session so the next one loads the restored storage; restored moves the revision
  // past the pre-restore one, because open overlays drop a snapshot older than the last revision they saw.
  if (path === "/dev/restore" && method === "POST") {
    // Any JSON, checked by parseRoomRestore: unreadable JSON is refused the same way
    const body = parseRoomRestore(await request.json<unknown>().catch(() => undefined)),
      storage = room.ctx.storage;
    if (!body.ok) return json({ error: "Send {bookmark} or {at}", reason: body.error }, 400);
    const unavailable = () =>
      json({ error: "Restore works on Cloudflare only, not in local dev", reason: "restore_unavailable" }, 501);
    if (typeof storage.getBookmarkForTime !== "function" || typeof storage.onNextSessionRestoreBookmark !== "function")
      return unavailable();
    let bookmark: string;
    try {
      bookmark = body.value.bookmark || (await storage.getBookmarkForTime(body.value.at));
    } catch {
      return unavailable();
    }
    if (!BOOKMARK.test(bookmark)) return json({ error: "Invalid restore point", reason: "invalid_bookmark" }, 400);
    const revision = room.readState(channel).revision,
      undo = await storage.onNextSessionRestoreBookmark(bookmark);
    return json({ ok: true, undo, revision });
  }
  if (path === "/dev/restart" && method === "POST") {
    room.ctx.abort("Restoring channel data");
    return json({ ok: true });
  }
  if (path === "/dev/restored" && method === "POST") {
    // Any JSON, checked by parseRoomRestored: unreadable JSON is refused the same way
    const body = parseRoomRestored(await request.json<unknown>().catch(() => undefined));
    if (!body.ok) return json({ error: "Send {revision}", reason: body.error }, 400);
    const state = room.readState(channel);
    state.revision = Math.max(Number(state.revision) || 0, body.value.revision || 0) + 1;
    room.writeState(state);
    logRoomEvent(room, "warn", "Channel data restored to an earlier time", { revision: state.revision });
    room.broadcast(state);
    room.looksReset = true;
    room.flushLooksSoon(); // overlays drop the saved looks they cached and fetch them again
    return json({
      ok: true,
      revision: state.revision,
      players: state.players.length,
      profiles: Number(sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM profiles").toArray()[0]?.n) || 0,
    });
  }
  return json({ error: "Not found" }, 404);
}

// Called from ChannelRoom's constructor.
export function ensureDeveloperSchema(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS error_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL, context TEXT NOT NULL)",
  );
}

// Called by ChannelRoom when one of its handlers throws. Must never throw.
export function logRoomError(room: { ctx: DurableObjectState }, error: unknown, context: JsonObject = {}): void {
  try {
    // anything can be thrown; an Error's message reads best
    insertLog(
      room.ctx.storage.sql,
      "room",
      (error as { message?: unknown } | null | undefined)?.message || String(error),
      context,
    );
  } catch {}
}

// One line per chat command (source 'command') or a broken invariant (source 'warn'), so a wrong reply
// can be traced without a crash. Also printed for `wrangler tail`. Must never throw.
export function logRoomEvent(
  room: { ctx: DurableObjectState },
  source: string,
  message: string,
  context: JsonObject = {},
): void {
  try {
    console.log(JSON.stringify({ log: source, message, ...context }));
  } catch {}
  try {
    insertLog(room.ctx.storage.sql, source, message, context);
  } catch {}
}

// Called by the Worker's top-level catch (through ctx.waitUntil). Must never throw.
export async function logWorkerError(env: Env, error: unknown, context: JsonObject = {}): Promise<void> {
  try {
    if (!env.INTERNAL_SECRET || !env.ROOMS) return;
    await env.ROOMS.get(env.ROOMS.idFromName(site.defaultChannel)).fetch("https://room/dev/log", {
      method: "POST",
      headers: {
        "X-Mini-Internal": env.INTERNAL_SECRET,
        "X-Mini-Channel": site.defaultChannel,
        "Content-Type": "application/json",
      },
      // anything can be thrown; an Error's message reads best
      body: JSON.stringify({
        message: (error as { message?: unknown } | null | undefined)?.message || String(error),
        context,
      }),
    });
  } catch {}
}

// Backup of this room (read only). StreamElements: command names only, never the key (and not seSettings(),
// which would create a key in a room that has none). Custom characters and pets: metadata, not the images.
function roomExport(room: DevRoom, channel: string) {
  const sql = room.ctx.storage.sql;
  const state = room.readState(channel);
  const profiles = sql
    .exec("SELECT * FROM profiles ORDER BY elo DESC, wins DESC, username COLLATE NOCASE ASC")
    .toArray()
    .map((p) => ({
      userId: p.user_id,
      username: p.username,
      displayName: p.display_name,
      avatar: p.avatar,
      color: p.color,
      defaultAbility: p.default_ability,
      elo: p.elo,
      wins: p.wins,
      losses: p.losses,
      lastSeen: p.last_seen,
      power: p.power,
      guard: p.guard,
      luck: p.luck,
      hat: p.hat,
      lastOpponentId: p.last_opponent,
      bonus: p.bonus_points,
      checkins: p.checkins,
      streak: p.streak,
      dollars: p.dollars,
      pet: p.pet,
      recolor: p.recolor,
      petColor: p.pet_color,
      accessory: p.accessory,
      trail: p.trail,
      winEffect: p.win_effect,
      taunt: p.taunt,
      title: p.title,
      build: p.build,
    }));
  const purchases = sql
    .exec("SELECT user_id, kind, item_id, price, bought_at FROM owned_items ORDER BY bought_at, user_id")
    .toArray()
    .map((x) => ({ userId: x.user_id, kind: x.kind, itemId: x.item_id, price: x.price, boughtAt: x.bought_at }));
  const builds = sql
    .exec<{ user_id: string; slot: number; data: string }>(
      "SELECT user_id, slot, data FROM builds ORDER BY user_id, slot",
    )
    .toArray()
    .map((x) => ({ userId: x.user_id, slot: x.slot, data: safeParse(x.data) || {} }));
  const pets = sql
    .exec(
      "SELECT id, label, tier, stat, stat2, bytes, width, height, created_by, created_at FROM custom_pets ORDER BY created_at",
    )
    .toArray()
    .map((x) => ({
      id: x.id,
      label: x.label,
      tier: x.tier,
      stat: x.stat,
      stat2: x.stat2,
      bytes: x.bytes,
      width: x.width,
      height: x.height,
      createdBy: x.created_by,
      createdAt: x.created_at,
    }));
  const history = sql
    .exec<{ version: number; config: string; actor_id: string; actor_name: string; at: number; note: string }>(
      "SELECT version, config, actor_id, actor_name, at, note FROM config_history ORDER BY version DESC",
    )
    .toArray()
    .map((h) => ({
      version: h.version,
      config: safeParse(h.config) || {},
      actorId: h.actor_id,
      actorName: h.actor_name,
      at: h.at,
      note: h.note,
    }));
  const characters = sql
    .exec<{ id: string; meta: string; bytes: number; created_by: string; created_at: number }>(
      "SELECT id, meta, bytes, created_by, created_at FROM custom_characters ORDER BY created_at",
    )
    .toArray()
    .map((x) => ({
      id: x.id,
      meta: safeParse(x.meta) || {},
      bytes: x.bytes,
      createdBy: x.created_by,
      createdAt: x.created_at,
    }));
  const stored =
      safeParse<{ [action: string]: string }>(
        sql.exec<{ names: string }>("SELECT names FROM se_settings WHERE id = 1").toArray()[0]?.names,
      ) || {},
    names = { ...DEFAULT_SE_NAMES, ...stored };
  if (names.accept === "!accept") names.accept = DEFAULT_SE_NAMES.accept;
  if (names.top === "!top") names.top = DEFAULT_SE_NAMES.top;
  return {
    counts: {
      profiles: profiles.length,
      configVersions: history.length,
      customCharacters: characters.length,
      purchases: purchases.length,
      builds: builds.length,
      customPets: pets.length,
    },
    profiles,
    purchases,
    builds,
    customPets: pets,
    config: state.config,
    configVersion: state.configVersion,
    configHistory: history,
    customCharacters: characters,
    streamelements: { commandNames: names },
  };
}

function insertLog(sql: SqlStorage, source: string, message: unknown, context: unknown): void {
  let ctx = JSON.stringify(context ?? {}) || "{}";
  if (ctx.length > 2000) ctx = JSON.stringify({ truncated: ctx.slice(0, 1900) });
  sql.exec(
    "INSERT INTO error_log (at, source, message, context) VALUES (?, ?, ?, ?)",
    Date.now(),
    source,
    String(message || "unknown").slice(0, 500),
    ctx,
  );
  sql.exec("DELETE FROM error_log WHERE id <= (SELECT MAX(id) FROM error_log) - ?", MAX_LOG_ROWS);
}

// T is the shape the caller stored; null when the value is missing or not JSON.
function safeParse<T = unknown>(value: string | undefined): T | null {
  try {
    return JSON.parse(value as string); // undefined throws here and reads as null
  } catch {
    return null;
  }
}
