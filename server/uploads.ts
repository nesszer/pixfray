// Custom characters (/api/assets/:channel[/:id] and the room's /catalog). Owned by Lane D.
// worker.ts and channel.ts only call the exports below; keep the signatures (see docs/CONTRACTS.md, "Lane modules").
//
// POST /api/assets/:channel (canManage, same origin), JSON body, at most UPLOAD_BODY_LIMIT bytes:
//   { label:"1-32 chars", mode:"single"|"frames", fps:1-30, atlas:"<base64 PNG, data: prefix allowed>",
//     frames:[Frame], animations:{idle?,walk?,attack?,ko?,jump?,cheer?:[Frame]} }   Frame = {x,y,w,h}
//   201 -> {ok:true, item:CatalogEntry, usage:{count,limit,bytes}}
//   Errors -> {ok:false, reason, error}: 400 invalid_* / too_many_frames / frame_too_large / frame_out_of_bounds /
//   atlas_dimensions, 413 atlas_too_large, 415 not_png, 409 custom_limit_reached.
// DELETE /api/assets/:channel/:id (canManage) -> {ok:true, id, usage} or 404 {reason:"not_found"}.
// The same validation runs in the Worker (cheap rejection) and again in the ChannelRoom before the insert.
import { bodyOr, fromBase64, json, png, postJson, refuse as fail } from "./http.ts";
import { parseUploadMeta } from "./parse.ts";
import type { Env } from "./env.ts";
import type { PetsContext } from "./pets.ts";

/** One frame of the atlas, in pixels. */
export type Frame = { x: number; y: number; w: number; h: number };
/** The meta JSON stored with a custom character (custom_characters.meta). */
export type UploadMeta = {
  label: string;
  mode: "single" | "frames";
  fps: number;
  frames: Frame[];
  animations: { [name: string]: Frame[] };
  anchor: { x: number; y: number };
  license: string;
  source: string;
  combatFallback?: string;
};
/** A checked upload: validateUpload's result. */
export type CheckedUpload = { meta: UploadMeta; bytes: Uint8Array<ArrayBuffer>; png: PngSize };
/** A PNG's size from its IHDR chunk. */
export type PngSize = { width: number; height: number };
/** A catalog entry: the stored meta plus the id and URL (the room's /catalog). */
export type CatalogEntry = { [field: string]: unknown; id: string; url: string; custom: boolean };
/** Custom character usage shown on /admin. */
export type CustomUsage = { count: number; limit: number; bytes: number };
/** The Worker's request context for /api/assets (server/worker.ts): the pets one plus a few unused fields. */
export type UploadsContext = PetsContext & { owner?: unknown; channel?: string; url?: URL };

export const UPLOAD_LIMITS = Object.freeze({
  maxFrames: 24,
  frameSize: 128,
  maxAtlasBytes: 1_572_864,
  maxCharacters: 24,
  mime: "image/png",
  maxAtlasSide: 1024,
  maxLabel: 32,
});
export const CUSTOM_ID = /^c-[a-z0-9-]{1,40}$/;
export const ANIMATIONS = Object.freeze(["idle", "walk", "attack", "ko", "jump", "cheer"]);
// base64 of the largest atlas plus room for the frame lists and label.
export const UPLOAD_BODY_LIMIT = Math.ceil(UPLOAD_LIMITS.maxAtlasBytes / 3) * 4 + 64_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const UPLOAD_LICENSE = "Uploaded by channel staff";
class UploadError extends Error {
  declare status: number;
  declare reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}
// Annotated on the const so a call narrows like a throw
const reject: (status: number, reason: string, message: string) => never = (status, reason, message) => {
  throw new UploadError(status, reason, message);
};

// Worker side. c = { user, owner, channel, id, url, access(): Promise<{canManage,reason}>, roomFetch(path, init?), bodyJson(request, limit) }
export async function handleUploads(request: Request, env: Env, c: UploadsContext): Promise<Response> {
  // Public: atlas PNG bytes, used by overlays and the dashboard preview.
  if (request.method === "GET" && c.id) return c.roomFetch("/asset/" + c.id);
  const roles = await c.access();
  if (!roles.canManage) return json({ error: roles.reason || "Moderator role required" }, c.user ? 403 : 401);
  if (request.method === "GET" && !c.id) return c.roomFetch("/asset");
  if (request.method === "POST" && !c.id) {
    const body = await bodyOr(c.bodyJson(request, UPLOAD_BODY_LIMIT), [
      "atlas_too_large",
      "Upload is larger than the 1.5 MB atlas limit",
    ]);
    if (body instanceof Response) return body;
    const upload = checked(body);
    if (upload instanceof Response) return upload;
    // canManage (checked above) is only true for a signed-in user
    return c.roomFetch("/asset", postJson({ ...body, createdBy: c.user!.id }));
  }
  if (request.method === "DELETE" && c.id) {
    if (!CUSTOM_ID.test(c.id)) return fail(404, "not_found", "Custom character not found");
    return c.roomFetch("/asset/" + c.id, { method: "DELETE" });
  }
  return json({ error: "Method not allowed" }, 405);
}

// Durable Object side (ChannelRoom). Handles GET /catalog and everything under /asset.
export async function handleRoomAssets(
  room: { ctx: DurableObjectState },
  request: Request,
  { path, channel }: { path: string; channel: string },
): Promise<Response> {
  const sql = room.ctx.storage.sql;
  if (path === "/catalog" && request.method === "GET") {
    return json(
      sql
        .exec<{ id: string; meta: string }>("SELECT id, meta FROM custom_characters ORDER BY created_at, id")
        .toArray()
        .map((row) => catalogEntry(channel, row)),
    );
  }
  if (path === "/asset" && request.method === "GET") {
    const items = sql
      .exec<{ id: string; meta: string; bytes: number; created_by: string; created_at: number }>(
        "SELECT id, meta, bytes, created_by, created_at FROM custom_characters ORDER BY created_at, id",
      )
      .toArray()
      .map((row) => ({
        ...catalogEntry(channel, row),
        bytes: row.bytes,
        createdBy: row.created_by,
        createdAt: row.created_at,
      }));
    return json({ items, usage: customUsage(room), limits: UPLOAD_LIMITS });
  }
  if (path === "/asset" && request.method === "POST") {
    let body;
    try {
      // Any JSON: validateUpload refuses anything but an object, and createdBy is checked with typeof below
      body = await request.json<{ [field: string]: unknown }>();
    } catch {
      return fail(400, "invalid_upload", "Invalid JSON");
    }
    const upload = checked(body);
    if (upload instanceof Response) return upload;
    const createdBy = typeof body.createdBy === "string" && body.createdBy ? body.createdBy.slice(0, 64) : "unknown";
    const id = slugId("c-", upload.meta.label, "char"),
      now = Date.now();
    // Count and insert in one transaction so two moderators can't both take the last slot.
    const inserted = room.ctx.storage.transactionSync(() => {
      // COUNT(*) always returns one row
      const [{ count }] = sql.exec("SELECT COUNT(*) AS count FROM custom_characters").toArray() as [{ count: number }];
      if (count >= UPLOAD_LIMITS.maxCharacters) return false;
      sql.exec(
        "INSERT INTO custom_characters (id, meta, atlas, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        JSON.stringify(upload.meta),
        upload.bytes,
        upload.bytes.byteLength,
        createdBy,
        now,
      );
      return true;
    });
    if (!inserted)
      return fail(
        409,
        "custom_limit_reached",
        "This channel already has " + UPLOAD_LIMITS.maxCharacters + " custom characters; delete one first",
      );
    return json(
      {
        ok: true,
        item: {
          ...catalogEntry(channel, { id, meta: JSON.stringify(upload.meta) }),
          bytes: upload.bytes.byteLength,
          createdBy,
          createdAt: now,
        },
        usage: customUsage(room),
      },
      201,
    );
  }
  const id = path.startsWith("/asset/") ? path.slice(7) : "";
  if (id && request.method === "GET") {
    if (!CUSTOM_ID.test(id)) return json({ error: "Not found" }, 404);
    const row = sql.exec<{ atlas: ArrayBuffer }>("SELECT atlas FROM custom_characters WHERE id = ?", id).toArray()[0];
    if (!row) return json({ error: "Not found" }, 404);
    return png(row.atlas, "public, max-age=300");
  }
  if (id && request.method === "DELETE") {
    if (!CUSTOM_ID.test(id)) return fail(404, "not_found", "Custom character not found");
    const found = sql.exec("SELECT id FROM custom_characters WHERE id = ?", id).toArray().length > 0;
    if (!found) return fail(404, "not_found", "Custom character not found");
    sql.exec("DELETE FROM custom_characters WHERE id = ?", id);
    return json({ ok: true, id, usage: customUsage(room) });
  }
  return json({ error: "Method not allowed" }, 405);
}

// Called from ChannelRoom's constructor.
export function ensureUploadSchema(sql: SqlStorage): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS custom_characters (id TEXT PRIMARY KEY, meta TEXT NOT NULL, atlas BLOB NOT NULL, bytes INTEGER NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)",
  );
}

// Shown on /admin. { count, limit, bytes }
export function customUsage(room: { ctx: DurableObjectState }): CustomUsage {
  const [row] = room.ctx.storage.sql
    .exec("SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM custom_characters")
    // COUNT(*) and COALESCE(SUM) always return one row of numbers
    .toArray() as [{ count: number; bytes: number }];
  return { count: row.count, limit: UPLOAD_LIMITS.maxCharacters, bytes: row.bytes };
}

// validateUpload, or its refusal as a response.
function checked(body: { [field: string]: unknown }): CheckedUpload | Response {
  try {
    return validateUpload(body);
  } catch (error) {
    if (error instanceof UploadError) return fail(error.status, error.reason, error.message);
    throw error;
  }
}

// Validates an upload body. Returns {meta, bytes:Uint8Array, png:{width,height}} or throws UploadError.
export function validateUpload(body: { [field: string]: unknown } | null | undefined): CheckedUpload {
  if (!body || typeof body !== "object" || Array.isArray(body)) reject(400, "invalid_upload", "JSON object required");
  const label = typeof body.label === "string" ? body.label.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  if (!label || label.length > UPLOAD_LIMITS.maxLabel)
    reject(400, "invalid_label", "Name must be 1 to " + UPLOAD_LIMITS.maxLabel + " characters");
  const mode = body.mode === undefined ? "frames" : body.mode;
  if (mode !== "single" && mode !== "frames") reject(400, "invalid_upload", 'mode must be "single" or "frames"');
  const fps = body.fps === undefined ? 8 : body.fps;
  if (!Number.isInteger(fps) || fps < 1 || fps > 30) reject(400, "invalid_fps", "fps must be an integer from 1 to 30");
  const bytes = decodeAtlas(body.atlas);
  const png = readPng(bytes);
  if (png.width > UPLOAD_LIMITS.maxAtlasSide || png.height > UPLOAD_LIMITS.maxAtlasSide)
    reject(400, "atlas_dimensions", "Atlas must be at most " + UPLOAD_LIMITS.maxAtlasSide + " px on each side");
  const unique = new Set<string>();
  const rects = (list: unknown, name: string): Frame[] => {
    if (!Array.isArray(list) || !list.length || list.length > UPLOAD_LIMITS.maxFrames)
      reject(400, "invalid_frames", name + " must list 1 to " + UPLOAD_LIMITS.maxFrames + " frames");
    return list.map((f) => {
      if (!f || typeof f !== "object" || ![f.x, f.y, f.w, f.h].every(Number.isInteger))
        reject(400, "invalid_frames", name + " has a frame that is not {x,y,w,h} integers");
      if (f.w < 1 || f.h < 1 || f.w > UPLOAD_LIMITS.frameSize || f.h > UPLOAD_LIMITS.frameSize)
        reject(
          400,
          "frame_too_large",
          "Frames must be at most " + UPLOAD_LIMITS.frameSize + " x " + UPLOAD_LIMITS.frameSize + " px",
        );
      if (f.x < 0 || f.y < 0 || f.x + f.w > png.width || f.y + f.h > png.height)
        reject(
          400,
          "frame_out_of_bounds",
          name + " has a frame outside the " + png.width + " x " + png.height + " atlas",
        );
      unique.add(f.x + "," + f.y + "," + f.w + "," + f.h);
      return { x: f.x, y: f.y, w: f.w, h: f.h };
    });
  };
  const frames = rects(body.frames, "frames");
  const animations: { [name: string]: Frame[] } = {};
  const anims = body.animations === undefined ? {} : body.animations;
  if (!anims || typeof anims !== "object" || Array.isArray(anims))
    reject(400, "invalid_animation", "animations must be an object");
  for (const [name, list] of Object.entries(anims)) {
    if (!ANIMATIONS.includes(name))
      reject(
        400,
        "invalid_animation",
        'Unknown animation "' + String(name).slice(0, 20) + '"; use ' + ANIMATIONS.join(", "),
      );
    animations[name] = rects(list, name);
  }
  if (unique.size > UPLOAD_LIMITS.maxFrames)
    reject(
      400,
      "too_many_frames",
      "At most " + UPLOAD_LIMITS.maxFrames + " frames per character (got " + unique.size + ")",
    );
  const meta: UploadMeta = {
    label,
    mode,
    fps,
    frames,
    animations,
    anchor: { x: 0.5, y: 1 },
    license: UPLOAD_LICENSE,
    source: "upload",
  };
  if (!animations.attack) meta.combatFallback = "effects";
  return { meta, bytes, png };
}

function decodeAtlas(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !value) reject(400, "invalid_upload", "atlas must be a base64 PNG");
  const b64 = value.replace(/^data:[^,]*;base64,/, "");
  if (b64.length > Math.ceil(UPLOAD_LIMITS.maxAtlasBytes / 3) * 4)
    reject(413, "atlas_too_large", "Atlas is larger than 1.5 MB");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(b64);
  } catch {
    reject(400, "invalid_upload", "atlas is not valid base64");
  }
  if (bytes.length > UPLOAD_LIMITS.maxAtlasBytes) reject(413, "atlas_too_large", "Atlas is larger than 1.5 MB");
  return bytes;
}

// Checks the PNG signature, the IHDR chunk (with CRC) and the chunk layout through IEND. Returns {width, height}.
// bytes may be anything: the instanceof check below refuses what isn't a Uint8Array.
export function readPng(bytes: unknown): PngSize {
  // Annotated on the const so a call narrows like a throw
  const notPng: (why: string) => never = (why) => reject(415, "not_png", "Only PNG images are accepted (" + why + ")");
  if (!(bytes instanceof Uint8Array) || bytes.length < 57) notPng("file too short");
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) notPng("bad signature");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Called at offsets the length checks keep inside bytes (12, and a chunk start at least 12 bytes from the end)
  const type = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (view.getUint32(8) !== 13 || type(12) !== "IHDR") notPng("IHDR must be the first chunk");
  if (crc32(bytes, 12, 29) !== view.getUint32(29)) notPng("IHDR checksum mismatch");
  const width = view.getUint32(16),
    height = view.getUint32(20),
    // bytes is at least 57 long (checked above), so offsets 24 to 28 exist
    depth = bytes[24]!,
    color = bytes[25]!;
  // Indexed by any color byte; an unknown color reads undefined, refused below
  const depths = (
    { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] } as Record<number, number[]>
  )[color];
  // Offset 28 exists, as above
  if (!width || !height || !depths || !depths.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28]! > 1)
    notPng("invalid IHDR");
  let at = 33,
    idat = false,
    end = false;
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at),
      name = type(at + 4);
    if (len > bytes.length - at - 12) notPng("truncated chunk");
    if (name === "IHDR") notPng("duplicate IHDR");
    if (name === "IDAT") idat = true;
    at += 12 + len;
    if (name === "IEND") {
      end = true;
      break;
    }
  }
  if (!idat || !end) notPng("missing image data or IEND");
  if (at !== bytes.length) notPng("data after IEND");
  return { width, height };
}

let crcTable: Uint32Array | undefined;
export function crc32(bytes: Uint8Array, start: number = 0, end: number = bytes.length): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  // i stays below end (at most bytes.length), and a byte-masked index is inside the 256-entry table
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A new id from a label: prefix, a slug of at most 30 characters (fallback when empty), 6 random hex digits. */
export function slugId(prefix: string, label: string, fallback: string): string {
  const slug =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30)
      .replace(/-+$/, "") || fallback;
  const rand = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return prefix + slug + "-" + rand;
}

// Stored meta that is not a JSON object adds no fields.
function catalogEntry(channel: string, row: { id: string; meta: string }): CatalogEntry {
  const meta = parseUploadMeta(row.meta);
  return { ...(meta.ok ? meta.value : {}), id: row.id, url: "/api/assets/" + channel + "/" + row.id, custom: true };
}
