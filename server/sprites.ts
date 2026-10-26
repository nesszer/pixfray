// Viewer sprites: any signed-in viewer turns an image into a pixel sprite on /play/ (src/spritify.ts does the
// pixelating in the browser, and the optional AI redraw runs on Workers AI here). A sprite waits for a moderator on
// /admin/; once approved it joins the channel catalog (ids "v-...", with `owner`), only its uploader can wear it, and
// it goes on their saved fighter. A viewer has at most one approved sprite and one waiting.
//
// Viewer, signed in (route "sprite"):
//   GET    /api/sprite/:channel          -> {live, pending, rejected, limits, ai:{available, left}}
//   GET    /api/sprite/:channel/pending  -> the viewer's own waiting PNG
//   POST   /api/sprite/:channel          {label, image:"<base64 PNG>", ai?:bool} -> 201 {ok, pending}
//   POST   /api/sprite/:channel/redraw   {image:"<base64 PNG or JPEG, under 512 px a side>"} -> {ok, image:"<base64>", left}
//   DELETE /api/sprite/:channel/pending  withdraw the waiting sprite; /live removes the approved one
// Moderators (route "sprites", canManage):
//   GET    /api/sprites/:channel         -> {pending:[Row], live:[Row], limits}
//   GET    /api/sprites/:channel/:id     -> that sprite's PNG, waiting or approved
//   POST   /api/sprites/:channel/:id     {action:"approve"|"reject"|"remove"} -> {ok, id, status}
// Approved PNGs are public at /api/assets/:channel/:id (server/uploads.ts forwards v- ids to the room).
import { readPng, slugId } from "./uploads.ts";
import { bodyOr, json, png, postJson, refuse as fail } from "./http.ts";
import {
  isObject,
  parseRedraw,
  parseRoomSpriteAi,
  parseRoomSpriteReview,
  parseRoomSpriteSubmit,
  parseSpriteReview,
  parseSpriteSubmit,
} from "./parse.ts";
import type { PngSize } from "./uploads.ts";
import type { OrRefusal, PetsContext } from "./pets.ts";
import type { Env } from "./env.ts";
import type { SpriteSubmit } from "./parse.ts";

/** A refused image or sprite: the HTTP status and the reason the page shows. */
export type SpriteRefusal = {
  status: number;
  reason: "invalid_label" | "invalid_image" | "image_too_large" | "not_png" | "image_dimensions";
  error: string;
};
/** A checked sprite submission (validateSprite). */
export type SpriteUpload = {
  label: string;
  bytes: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  ai: boolean;
};
/** A checked redraw input (validateRedrawImage). */
export type RedrawImage = { bytes: Uint8Array<ArrayBuffer>; type: "image/jpeg" | "image/png" };
/** The Worker's request context for /api/sprite and /api/sprites (server/worker.ts). */
export type SpritesContext = Omit<PetsContext, "user"> & {
  user: { id: string; login: string; displayName?: string } | null | undefined;
};
/** A viewer_sprites row as SELECT ${ROW} reads it. */
type SpriteDbRow = {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  label: string;
  status: string;
  bytes: number;
  width: number;
  height: number;
  ai: number;
  createdAt: number;
  reviewedBy: string;
  reviewedAt: number;
};
/** A sprite as the room answers it (and passes to hooks.approved): ai as a boolean. */
export type SpriteRow = Omit<SpriteDbRow, "ai"> & { ai: boolean };
/** channel.ts callbacks: approved puts the sprite on the fighter, removed takes it off. */
export type SpriteHooks = {
  approved?: (row: SpriteRow, previousLiveId: string) => void;
  removed?: (id: string, userId: string) => void;
};
/** A live viewer_sprites row as spriteCatalog selects it. */
type CatalogRow = { id: string; user_id: string; display_name: string; label: string; width: number; height: number };

export const SPRITE_ID = /^v-[a-z0-9-]{1,48}$/;
export const SPRITE_LIMITS = Object.freeze({
  maxSide: 128,
  maxBytes: 65_536,
  maxLabel: 24,
  maxPending: 40, // waiting sprites per channel
  maxLive: 300, // approved sprites per channel (each one is a catalog entry the overlay loads)
  submitsPerDay: 6, // per viewer per channel, UTC day
  aiPerDay: 3, // AI redraws per viewer per channel, UTC day
  aiChannelPerDay: 60, // AI redraws per channel, UTC day (about 1,900 of the 10,000 free daily neurons)
  aiMaxSide: 511,
  aiMaxBytes: 786_432,
});
export const AI_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
export const AI_PROMPT =
  "Redraw the main subject of image 0 as a single full-body 16-bit pixel art game character sprite, " +
  "facing right, standing, chunky pixels, bold dark outline, limited color palette, centered, plain flat white background, " +
  "no text, no shadow, no scenery.";
const BODY_LIMIT = Math.ceil(SPRITE_LIMITS.maxBytes / 3) * 4 + 2_000;
const AI_BODY_LIMIT = Math.ceil(SPRITE_LIMITS.aiMaxBytes / 3) * 4 + 2_000;
const JPEG = [0xff, 0xd8, 0xff];

export const spriteDay = (now: number = Date.now()): string => new Date(now).toISOString().slice(0, 10);

function decodeB64(value: unknown, maxBytes: number): OrRefusal<{ bytes: Uint8Array<ArrayBuffer> }, SpriteRefusal> {
  const b64 = String(value || "").replace(/^data:[^,]*;base64,/, "");
  if (!b64) return { status: 400, reason: "invalid_image", error: "Choose an image" };
  if (b64.length > Math.ceil(maxBytes / 3) * 4)
    return {
      status: 413,
      reason: "image_too_large",
      error: `The image is larger than ${Math.round(maxBytes / 1024)} KB`,
    };
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    return { status: 400, reason: "invalid_image", error: "The image is not valid base64" };
  }
  return { bytes: Uint8Array.from(binary, (c) => c.charCodeAt(0)) };
}

// Submit body (label and image already strings, parseSpriteSubmit) -> { label, bytes, width, height, ai } or
// { status, reason, error }.
export function validateSprite(
  body: Omit<SpriteSubmit, "ai"> & { ai?: boolean },
): OrRefusal<SpriteUpload, SpriteRefusal> {
  const label = body.label
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  if (!label || label.length > SPRITE_LIMITS.maxLabel)
    return { status: 400, reason: "invalid_label", error: `Name your sprite (1-${SPRITE_LIMITS.maxLabel} characters)` };
  const image = decodeB64(body.image, SPRITE_LIMITS.maxBytes);
  if (image.reason) return image;
  let size: PngSize;
  try {
    size = readPng(image.bytes);
  } catch (error) {
    // readPng throws only UploadError (an Error)
    return { status: 415, reason: "not_png", error: (error as Error).message };
  }
  if (size.width > SPRITE_LIMITS.maxSide || size.height > SPRITE_LIMITS.maxSide)
    return {
      status: 400,
      reason: "image_dimensions",
      error: `Sprites are at most ${SPRITE_LIMITS.maxSide}x${SPRITE_LIMITS.maxSide} pixels`,
    };
  return { label, bytes: image.bytes, width: size.width, height: size.height, ai: body.ai === true };
}

// The message for a parseSpriteSubmit refusal, the same one validateSprite gives for that field.
function submitError(reason: string): string {
  if (reason === "invalid_label") return `Name your sprite (1-${SPRITE_LIMITS.maxLabel} characters)`;
  if (reason === "invalid_image") return "Choose an image";
  return "Send {label, image, ai?}";
}

// Redraw input -> { bytes, type } or { status, reason, error }. PNG or JPEG, each side under 512 px (the model's limit).
export function validateRedrawImage(value: unknown): OrRefusal<RedrawImage, SpriteRefusal> {
  const image = decodeB64(value, SPRITE_LIMITS.aiMaxBytes);
  if (image.reason) return image;
  const b = image.bytes;
  if (JPEG.every((v, i) => b[i] === v)) {
    const size = jpegSize(b);
    if (!size) return { status: 415, reason: "invalid_image", error: "The JPEG couldn't be read" };
    if (size.width > SPRITE_LIMITS.aiMaxSide || size.height > SPRITE_LIMITS.aiMaxSide)
      return { status: 400, reason: "image_dimensions", error: `Send at most ${SPRITE_LIMITS.aiMaxSide} px a side` };
    return { bytes: b, type: "image/jpeg" };
  }
  let size: PngSize;
  try {
    size = readPng(b);
  } catch {
    return { status: 415, reason: "invalid_image", error: "Send a PNG or JPEG image" };
  }
  if (size.width > SPRITE_LIMITS.aiMaxSide || size.height > SPRITE_LIMITS.aiMaxSide)
    return { status: 400, reason: "image_dimensions", error: `Send at most ${SPRITE_LIMITS.aiMaxSide} px a side` };
  return { bytes: b, type: "image/png" };
}

// Width and height from the first SOFn marker, or null.
export function jpegSize(b: Uint8Array): PngSize | null {
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null;
    // at + 9 < b.length (the loop condition), so b[at + 1] to b[at + 8] exist
    const marker = b[at + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    // Inside b, as above
    const len = (b[at + 2]! << 8) | b[at + 3]!;
    if (len < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      // Inside b, as above
      return { height: (b[at + 5]! << 8) | b[at + 6]!, width: (b[at + 7]! << 8) | b[at + 8]! };
    at += 2 + len;
  }
  return null;
}

// Worker side. c = { user, id, access(), roomFetch(path, init?), bodyJson(request, limit), env }
// mine = true for /api/sprite (the viewer's own), false for /api/sprites (moderators).
export async function handleSprites(request: Request, env: Env, c: SpritesContext, mine: boolean): Promise<Response> {
  if (!c.user) return json({ error: "Sign in with Twitch first" }, 401);
  const post = (path: string, body: unknown): Promise<Response> => c.roomFetch(path, postJson(body));
  const who = { userId: c.user.id, username: c.user.login, displayName: c.user.displayName || c.user.login };
  if (mine) {
    if (request.method === "GET" && !c.id) {
      const r = await c.roomFetch("/sprites/mine?userId=" + encodeURIComponent(c.user.id));
      if (!r.ok) return r;
      // The room's /sprites/mine answer (handleRoomSprites below)
      const data = await r.json<{ [field: string]: unknown; aiLeft: number }>();
      return json({ ...data, ai: { available: Boolean(env.AI), left: env.AI ? data.aiLeft : 0 } });
    }
    if (request.method === "GET" && c.id === "pending")
      return c.roomFetch("/sprites/png/pending?userId=" + encodeURIComponent(c.user.id));
    if (request.method === "DELETE" && (c.id === "pending" || c.id === "live"))
      return c.roomFetch("/sprites/mine?kind=" + c.id + "&userId=" + encodeURIComponent(c.user.id), {
        method: "DELETE",
      });
    if (request.method === "POST" && !c.id) {
      const body = await bodyOr(c.bodyJson(request, BODY_LIMIT), [
        "image_too_large",
        "The sprite is larger than 64 KB",
      ]);
      if (body instanceof Response) return body;
      const input = parseSpriteSubmit(body);
      if (!input.ok) return fail(400, input.error, submitError(input.error));
      const checked = validateSprite(input.value);
      if (checked.reason) return fail(checked.status, checked.reason, checked.error);
      return post("/sprites", { ...who, label: checked.label, image: input.value.image, ai: checked.ai });
    }
    if (request.method === "POST" && c.id === "redraw") return redraw(request, env, c, post);
    return json({ error: "Method not allowed" }, 405);
  }
  const roles = await c.access();
  if (!roles.canManage) return json({ error: roles.reason || "Moderator role required" }, 403);
  if (request.method === "GET" && !c.id) return c.roomFetch("/sprites/list");
  if (!SPRITE_ID.test(c.id || "")) return fail(404, "not_found", "Sprite not found");
  if (request.method === "GET") return c.roomFetch("/sprites/png/" + c.id);
  if (request.method === "POST") {
    const body = await bodyOr(c.bodyJson(request, 1000), null, "invalid_request");
    if (body instanceof Response) return body;
    const review = parseSpriteReview(body);
    if (!review.ok) return fail(400, review.error, "action must be approve, reject or remove");
    return post("/sprites/review", {
      id: c.id,
      action: review.value.action,
      actorId: c.user.id,
      actorName: c.user.displayName || c.user.login,
    });
  }
  return json({ error: "Method not allowed" }, 405);
}

// AI redraw: take one from the daily quota in the room, run the model, give it back if the model fails.
async function redraw(
  request: Request,
  env: Env,
  c: SpritesContext,
  post: (path: string, body: unknown) => Promise<Response>,
): Promise<Response> {
  if (!env.AI) return fail(503, "ai_unavailable", "AI redraw isn't available on this site");
  const body = await bodyOr(c.bodyJson(request, AI_BODY_LIMIT), [
    "image_too_large",
    "The image is too large to redraw",
  ]);
  if (body instanceof Response) return body;
  const input = parseRedraw(body);
  if (!input.ok) return fail(400, input.error, "Choose an image");
  const image = validateRedrawImage(input.value.image);
  if (image.reason) return fail(image.status, image.reason, image.error);
  // handleSprites returns before calling redraw when nobody is signed in
  const quota = await post("/sprites/ai", { userId: c.user!.id, op: "take" });
  // The room's /sprites/ai answer: {ok, left} or a refusal
  const q = await quota.json<{ left?: number }>();
  if (!quota.ok) return json(q, quota.status);
  try {
    const form = new FormData();
    form.append("input_image_0", new Blob([image.bytes], { type: image.type }));
    form.append("prompt", AI_PROMPT);
    form.append("width", "512");
    form.append("height", "512");
    const encoded = new Response(form);
    const out = await env.AI.run(AI_MODEL, {
      // A Response made from FormData always has a body and a multipart Content-Type
      multipart: { body: encoded.body as ReadableStream, contentType: encoded.headers.get("content-type") as string },
    });
    const result = typeof out?.image === "string" ? out.image : "";
    if (!result) throw new Error("no image in the model's answer");
    return json({ ok: true, image: result, left: q.left });
  } catch (error) {
    // Anything may be thrown: ?. covers null and undefined, and other values read undefined
    console.warn("sprite redraw failed", (error as Error | null | undefined)?.message || error);
    // Signed in, as above
    await post("/sprites/ai", { userId: c.user!.id, op: "refund" }).catch(() => {});
    return fail(502, "ai_failed", "The AI redraw didn't work this time. Try again, or use the pixel version.");
  }
}

// Schema: called from ChannelRoom's constructor. status: "pending" | "live" | "rejected" (a rejected row keeps no image).
export function ensureSpriteSchema(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS viewer_sprites (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL, display_name TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL, png BLOB NOT NULL, bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, ai INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, reviewed_by TEXT NOT NULL DEFAULT '', reviewed_at INTEGER NOT NULL DEFAULT 0)",
  );
  sql.exec("CREATE INDEX IF NOT EXISTS viewer_sprites_user ON viewer_sprites(user_id, status)");
  sql.exec(
    "CREATE TABLE IF NOT EXISTS sprite_usage (user_id TEXT NOT NULL, day TEXT NOT NULL, submits INTEGER NOT NULL DEFAULT 0, ai INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day))",
  );
}

// Approved sprites as catalog entries (server/uploads.ts shape, mode "single": the overlay bobs and squashes them).
export function spriteCatalog(sql: SqlStorage, channel: string) {
  return sql
    .exec<CatalogRow>(
      "SELECT id, user_id, display_name, label, width, height FROM viewer_sprites WHERE status = 'live' ORDER BY reviewed_at, id",
    )
    .toArray()
    .map(catalogEntry(channel));
}
const catalogEntry = (channel: string) => (r: CatalogRow) => ({
  id: r.id,
  label: r.label,
  url: `/api/assets/${channel}/${r.id}`,
  frames: [{ x: 0, y: 0, w: r.width, h: r.height }],
  fps: 8,
  anchor: { x: 0.5, y: 1 },
  mode: "single",
  combatFallback: "effects",
  animations: {},
  license: "Uploaded by " + r.display_name,
  source: "viewer",
  custom: true,
  owner: r.user_id,
});

const ROW =
  "id, user_id AS userId, username, display_name AS displayName, label, status, bytes, width, height, ai, created_at AS createdAt, reviewed_by AS reviewedBy, reviewed_at AS reviewedAt";
const shape = (r: SpriteDbRow): SpriteRow => r && { ...r, ai: Boolean(r.ai) };

function usage(sql: SqlStorage, userId: string, day: string): { submits: number; ai: number } {
  return (
    sql
      .exec<{ submits: number; ai: number }>(
        "SELECT submits, ai FROM sprite_usage WHERE user_id = ? AND day = ?",
        userId,
        day,
      )
      .toArray()[0] || {
      submits: 0,
      ai: 0,
    }
  );
}
function aiLeft(sql: SqlStorage, userId: string, day: string): number {
  const channel = sql
    .exec<{ n: number }>("SELECT COALESCE(SUM(ai), 0) AS n FROM sprite_usage WHERE day = ?", day)
    // COALESCE(SUM) always returns one row
    .toArray()[0]!.n;
  return Math.max(
    0,
    Math.min(SPRITE_LIMITS.aiPerDay - usage(sql, userId, day).ai, SPRITE_LIMITS.aiChannelPerDay - channel),
  );
}

// Durable Object side: everything under /sprites. hooks.approved(row, previousLiveId) puts the sprite on the fighter;
// hooks.removed(id, userId) takes a removed sprite off it (channel.ts).
export async function handleRoomSprites(
  room: { ctx: DurableObjectState },
  request: Request,
  { path, url, channel, hooks = {} }: { path: string; url: URL; channel: string; hooks?: SpriteHooks },
): Promise<Response> {
  const sql = room.ctx.storage.sql,
    now = Date.now(),
    day = spriteDay(now);
  const read = async () => {
    try {
      // Any JSON: each route checks it with its parse.ts parser
      return await request.json<unknown>();
    } catch {
      return null;
    }
  };
  if (path === "/sprites/mine" && request.method === "GET") {
    const userId = url.searchParams.get("userId") || "";
    const rows = sql
      .exec<SpriteDbRow>(`SELECT ${ROW} FROM viewer_sprites WHERE user_id = ? ORDER BY created_at DESC`, userId)
      .toArray()
      .map(shape);
    const live = rows.find((r) => r.status === "live") || null,
      pending = rows.find((r) => r.status === "pending") || null;
    const rejected = !pending && rows[0]?.status === "rejected" ? rows[0] : null;
    return json({
      live: live && { ...live, url: `/api/assets/${channel}/${live.id}` },
      pending,
      rejected,
      limits: SPRITE_LIMITS,
      submitsLeft: Math.max(0, SPRITE_LIMITS.submitsPerDay - usage(sql, userId, day).submits),
      aiLeft: aiLeft(sql, userId, day),
    });
  }
  if (path === "/sprites/mine" && request.method === "DELETE") {
    const userId = url.searchParams.get("userId") || "",
      kind = url.searchParams.get("kind");
    const row = sql
      .exec<{ id: string }>(
        "SELECT id FROM viewer_sprites WHERE user_id = ? AND status = ?",
        userId,
        kind === "live" ? "live" : "pending",
      )
      .toArray()[0];
    if (!row)
      return fail(404, "not_found", kind === "live" ? "You have no approved sprite" : "You have no sprite waiting");
    sql.exec("DELETE FROM viewer_sprites WHERE id = ?", row.id);
    if (kind === "live") hooks.removed?.(row.id, userId);
    return json({ ok: true, id: row.id });
  }
  if (path === "/sprites" && request.method === "POST") {
    const body = await read();
    if (!isObject(body)) return fail(400, "invalid_upload", "Invalid JSON");
    const input = parseRoomSpriteSubmit(body);
    if (!input.ok) return fail(400, input.error, submitError(input.error));
    const sprite = validateSprite(input.value);
    if (sprite.reason) return fail(sprite.status, sprite.reason, sprite.error);
    const userId = input.value.userId.slice(0, 64),
      username = input.value.username.slice(0, 25),
      displayName = (input.value.displayName || username).slice(0, 48);
    if (!userId || !username) return fail(400, "invalid_upload", "Missing viewer");
    const id = slugId("v-", sprite.label, "sprite");
    const result = room.ctx.storage.transactionSync(() => {
      if (usage(sql, userId, day).submits >= SPRITE_LIMITS.submitsPerDay)
        return fail(
          429,
          "daily_limit",
          `You can send ${SPRITE_LIMITS.submitsPerDay} sprites a day. Try again tomorrow.`,
        );
      // A new sprite replaces the viewer's waiting one and clears an old rejection.
      sql.exec("DELETE FROM viewer_sprites WHERE user_id = ? AND status IN ('pending', 'rejected')", userId);
      if (
        // COUNT(*) always returns one row
        sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM viewer_sprites WHERE status = 'pending'").toArray()[0]!.n >=
        SPRITE_LIMITS.maxPending
      )
        return fail(409, "queue_full", "The mods have a full review list right now. Try again later.");
      sql.exec(
        "INSERT INTO viewer_sprites (id, user_id, username, display_name, label, status, png, bytes, width, height, ai, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)",
        id,
        userId,
        username,
        displayName,
        sprite.label,
        sprite.bytes,
        sprite.bytes.byteLength,
        sprite.width,
        sprite.height,
        sprite.ai ? 1 : 0,
        now,
      );
      sql.exec(
        "INSERT INTO sprite_usage (user_id, day, submits) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET submits = submits + 1",
        userId,
        day,
      );
      return null;
    });
    if (result) return result;
    return json(
      // The row was inserted just above (the transaction returned null only after the INSERT)
      {
        ok: true,
        pending: shape(sql.exec<SpriteDbRow>(`SELECT ${ROW} FROM viewer_sprites WHERE id = ?`, id).toArray()[0]!),
      },
      201,
    );
  }
  if (path === "/sprites/ai" && request.method === "POST") {
    const body = parseRoomSpriteAi(await read());
    if (!body.ok) return fail(400, body.error, "Send {userId, op}");
    const { userId, op } = body.value;
    if (!userId) return fail(400, "invalid_request", "Missing viewer");
    if (op === "refund") {
      sql.exec("UPDATE sprite_usage SET ai = MAX(0, ai - 1) WHERE user_id = ? AND day = ?", userId, day);
      return json({ ok: true });
    }
    return room.ctx.storage.transactionSync(() => {
      if (usage(sql, userId, day).ai >= SPRITE_LIMITS.aiPerDay)
        return fail(
          429,
          "ai_daily_limit",
          `You've used your ${SPRITE_LIMITS.aiPerDay} AI redraws today. The pixel version still works.`,
        );
      if (aiLeft(sql, userId, day) <= 0)
        return fail(
          429,
          "ai_channel_limit",
          "This channel has used today's AI redraws. The pixel version still works.",
        );
      sql.exec(
        "INSERT INTO sprite_usage (user_id, day, ai) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET ai = ai + 1",
        userId,
        day,
      );
      return json({ ok: true, left: aiLeft(sql, userId, day) });
    });
  }
  if (path === "/sprites/list" && request.method === "GET") {
    const rows = sql
      .exec<SpriteDbRow>(`SELECT ${ROW} FROM viewer_sprites WHERE status IN ('pending', 'live') ORDER BY created_at`)
      .toArray()
      .map(shape);
    return json({
      pending: rows.filter((r) => r.status === "pending"),
      live: rows.filter((r) => r.status === "live").sort((a, b) => b.reviewedAt - a.reviewedAt),
      limits: SPRITE_LIMITS,
    });
  }
  if (path.startsWith("/sprites/png/") && request.method === "GET") {
    const key = path.slice(13),
      userId = url.searchParams.get("userId");
    const row =
      key === "pending"
        ? sql
            .exec<{ png: ArrayBuffer }>(
              "SELECT png FROM viewer_sprites WHERE user_id = ? AND status = 'pending'",
              userId || "",
            )
            .toArray()[0]
        : SPRITE_ID.test(key) &&
          sql
            .exec<{ png: ArrayBuffer }>(
              "SELECT png FROM viewer_sprites WHERE id = ? AND status IN ('pending', 'live')",
              key,
            )
            .toArray()[0];
    return row ? png(row.png, "private, no-store") : json({ error: "Not found" }, 404);
  }
  if (path === "/sprites/review" && request.method === "POST") {
    const body = parseRoomSpriteReview(await read());
    if (!body.ok) return fail(400, body.error, "Send {id, action}");
    const { id, action } = body.value,
      actor = (body.value.actorName || body.value.actorId || "mod").slice(0, 48);
    const row =
      SPRITE_ID.test(id) && sql.exec<SpriteDbRow>(`SELECT ${ROW} FROM viewer_sprites WHERE id = ?`, id).toArray()[0];
    if (!row || row.status === "rejected") return fail(404, "not_found", "That sprite is gone; reload the list");
    if (
      (action === "approve" && row.status !== "pending") ||
      (action === "reject" && row.status !== "pending") ||
      (action === "remove" && row.status !== "live")
    )
      return fail(409, "wrong_status", "That sprite was already reviewed; reload the list");
    if (action === "approve") {
      const result = room.ctx.storage.transactionSync(() => {
        if (
          sql
            .exec<{ n: number }>(
              "SELECT COUNT(*) AS n FROM viewer_sprites WHERE status = 'live' AND user_id <> ?",
              row.userId,
            )
            // COUNT(*) always returns one row
            .toArray()[0]!.n >= SPRITE_LIMITS.maxLive
        )
          return fail(
            409,
            "live_limit",
            `This channel has ${SPRITE_LIMITS.maxLive} approved sprites; remove one first`,
          );
        const previous =
          sql
            .exec<{ id: string }>("SELECT id FROM viewer_sprites WHERE user_id = ? AND status = 'live'", row.userId)
            .toArray()[0]?.id || "";
        if (previous) sql.exec("DELETE FROM viewer_sprites WHERE id = ?", previous);
        sql.exec(
          "UPDATE viewer_sprites SET status = 'live', reviewed_by = ?, reviewed_at = ? WHERE id = ?",
          actor,
          now,
          id,
        );
        return { previous };
      });
      if (result instanceof Response) return result;
      // Outside the transaction: the hook saves the profile, which runs its own.
      hooks.approved?.(shape(row), result.previous);
    } else if (action === "reject") {
      sql.exec(
        "UPDATE viewer_sprites SET status = 'rejected', png = X'', bytes = 0, reviewed_by = ?, reviewed_at = ? WHERE id = ?",
        actor,
        now,
        id,
      );
    } else {
      sql.exec("DELETE FROM viewer_sprites WHERE id = ?", id);
      hooks.removed?.(id, row.userId);
    }
    return json({ ok: true, id, status: action === "approve" ? "live" : action === "reject" ? "rejected" : "removed" });
  }
  // An approved sprite's PNG (public, through /api/assets/:channel/:id). The id changes with every approval.
  if (path.startsWith("/asset/v-") && request.method === "GET") {
    const id = path.slice(7);
    const row =
      SPRITE_ID.test(id) &&
      sql
        .exec<{ png: ArrayBuffer }>("SELECT png FROM viewer_sprites WHERE id = ? AND status = 'live'", id)
        .toArray()[0];
    return row ? png(row.png, "public, max-age=86400, immutable") : json({ error: "Not found" }, 404);
  }
  return json({ error: "Method not allowed" }, 405);
}
