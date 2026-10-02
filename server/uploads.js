// Custom characters (/api/assets/:channel[/:id] and the room's /catalog). Owned by Lane D.
// worker.js and channel.js only call the exports below; keep the signatures (see CONTRACTS.md, "Lane modules").
//
// POST /api/assets/:channel (canManage, same origin), JSON body, at most UPLOAD_BODY_LIMIT bytes:
//   { label:"1-32 chars", mode:"single"|"frames", fps:1-30, atlas:"<base64 PNG, data: prefix allowed>",
//     frames:[Frame], animations:{idle?,walk?,attack?,ko?,jump?,cheer?:[Frame]} }   Frame = {x,y,w,h}
//   201 -> {ok:true, item:CatalogEntry, usage:{count,limit,bytes}}
//   Errors -> {ok:false, reason, error}: 400 invalid_* / too_many_frames / frame_too_large / frame_out_of_bounds /
//   atlas_dimensions, 413 atlas_too_large, 415 not_png, 409 custom_limit_reached.
// DELETE /api/assets/:channel/:id (canManage) -> {ok:true, id, usage} or 404 {reason:"not_found"}.
// The same validation runs in the Worker (cheap rejection) and again in the ChannelRoom before the insert.
export const UPLOAD_LIMITS = Object.freeze({ maxFrames: 24, frameSize: 128, maxAtlasBytes: 1_572_864, maxCharacters: 24, mime: 'image/png', maxAtlasSide: 1024, maxLabel: 32 });
export const CUSTOM_ID = /^c-[a-z0-9-]{1,40}$/;
export const ANIMATIONS = Object.freeze(['idle', 'walk', 'attack', 'ko', 'jump', 'cheer']);
// base64 of the largest atlas plus room for the frame lists and label.
export const UPLOAD_BODY_LIMIT = Math.ceil(UPLOAD_LIMITS.maxAtlasBytes / 3) * 4 + 64_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const UPLOAD_LICENSE = 'Uploaded by channel staff';
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const fail = (status, reason, error) => json({ ok: false, reason, error }, status);
class UploadError extends Error { constructor(status, reason, message) { super(message); this.status = status; this.reason = reason; } }
const reject = (status, reason, message) => { throw new UploadError(status, reason, message); };

// Worker side. c = { user, owner, channel, id, url, access(): Promise<{canManage,reason}>, roomFetch(path, init?), bodyJson(request, limit) }
export async function handleUploads(request, env, c) {
  // Public: atlas PNG bytes, used by overlays and the dashboard preview.
  if (request.method === 'GET' && c.id) return c.roomFetch('/asset/' + c.id);
  const roles = await c.access();
  if (!roles.canManage) return json({ error: roles.reason || 'Moderator role required' }, c.user ? 403 : 401);
  if (request.method === 'GET' && !c.id) return c.roomFetch('/asset');
  if (request.method === 'POST' && !c.id) {
    let body;
    try { body = await c.bodyJson(request, UPLOAD_BODY_LIMIT); }
    catch (error) { return error.status === 413 ? fail(413, 'atlas_too_large', 'Upload is larger than the 1.5 MB atlas limit') : fail(error.status || 400, 'invalid_upload', error.message || 'Invalid JSON'); }
    try { validateUpload(body); } catch (error) { if (error instanceof UploadError) return fail(error.status, error.reason, error.message); throw error; }
    return c.roomFetch('/asset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, createdBy: c.user.id }) });
  }
  if (request.method === 'DELETE' && c.id) {
    if (!CUSTOM_ID.test(c.id)) return fail(404, 'not_found', 'Custom character not found');
    return c.roomFetch('/asset/' + c.id, { method: 'DELETE' });
  }
  return json({ error: 'Method not allowed' }, 405);
}

// Durable Object side (ChannelRoom). Handles GET /catalog and everything under /asset.
export async function handleRoomAssets(room, request, { path, channel }) {
  const sql = room.ctx.storage.sql;
  if (path === '/catalog' && request.method === 'GET') {
    return json(sql.exec('SELECT id, meta FROM custom_characters ORDER BY created_at, id').toArray().map((row) => catalogEntry(channel, row)));
  }
  if (path === '/asset' && request.method === 'GET') {
    const items = sql.exec('SELECT id, meta, bytes, created_by, created_at FROM custom_characters ORDER BY created_at, id').toArray()
      .map((row) => ({ ...catalogEntry(channel, row), bytes: row.bytes, createdBy: row.created_by, createdAt: row.created_at }));
    return json({ items, usage: customUsage(room), limits: UPLOAD_LIMITS });
  }
  if (path === '/asset' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return fail(400, 'invalid_upload', 'Invalid JSON'); }
    let upload;
    try { upload = validateUpload(body); } catch (error) { if (error instanceof UploadError) return fail(error.status, error.reason, error.message); throw error; }
    const createdBy = typeof body.createdBy === 'string' && body.createdBy ? body.createdBy.slice(0, 64) : 'unknown';
    const id = customId(upload.meta.label), now = Date.now();
    // Count and insert in one transaction so two moderators can't both take the last slot.
    const inserted = room.ctx.storage.transactionSync(() => {
      const [{ count }] = sql.exec('SELECT COUNT(*) AS count FROM custom_characters').toArray();
      if (count >= UPLOAD_LIMITS.maxCharacters) return false;
      sql.exec('INSERT INTO custom_characters (id, meta, atlas, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, JSON.stringify(upload.meta), upload.bytes, upload.bytes.byteLength, createdBy, now);
      return true;
    });
    if (!inserted) return fail(409, 'custom_limit_reached', 'This channel already has ' + UPLOAD_LIMITS.maxCharacters + ' custom characters; delete one first');
    return json({ ok: true, item: { ...catalogEntry(channel, { id, meta: JSON.stringify(upload.meta) }), bytes: upload.bytes.byteLength, createdBy, createdAt: now }, usage: customUsage(room) }, 201);
  }
  const id = path.startsWith('/asset/') ? path.slice(7) : '';
  if (id && request.method === 'GET') {
    if (!CUSTOM_ID.test(id)) return json({ error: 'Not found' }, 404);
    const row = sql.exec('SELECT atlas FROM custom_characters WHERE id = ?', id).toArray()[0];
    if (!row) return json({ error: 'Not found' }, 404);
    return new Response(row.atlas, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' } });
  }
  if (id && request.method === 'DELETE') {
    if (!CUSTOM_ID.test(id)) return fail(404, 'not_found', 'Custom character not found');
    const found = sql.exec('SELECT id FROM custom_characters WHERE id = ?', id).toArray().length > 0;
    if (!found) return fail(404, 'not_found', 'Custom character not found');
    sql.exec('DELETE FROM custom_characters WHERE id = ?', id);
    return json({ ok: true, id, usage: customUsage(room) });
  }
  return json({ error: 'Method not allowed' }, 405);
}

// Called from ChannelRoom's constructor.
export function ensureUploadSchema(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS custom_characters (id TEXT PRIMARY KEY, meta TEXT NOT NULL, atlas BLOB NOT NULL, bytes INTEGER NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)');
}

// Shown on /admin. { count, limit, bytes }
export function customUsage(room) {
  const [row] = room.ctx.storage.sql.exec('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM custom_characters').toArray();
  return { count: row.count, limit: UPLOAD_LIMITS.maxCharacters, bytes: row.bytes };
}

// Validates an upload body. Returns {meta, bytes:Uint8Array, png:{width,height}} or throws UploadError.
export function validateUpload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) reject(400, 'invalid_upload', 'JSON object required');
  const label = typeof body.label === 'string' ? body.label.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  if (!label || label.length > UPLOAD_LIMITS.maxLabel) reject(400, 'invalid_label', 'Name must be 1 to ' + UPLOAD_LIMITS.maxLabel + ' characters');
  const mode = body.mode === undefined ? 'frames' : body.mode;
  if (mode !== 'single' && mode !== 'frames') reject(400, 'invalid_upload', 'mode must be "single" or "frames"');
  const fps = body.fps === undefined ? 8 : body.fps;
  if (!Number.isInteger(fps) || fps < 1 || fps > 30) reject(400, 'invalid_fps', 'fps must be an integer from 1 to 30');
  const bytes = decodeAtlas(body.atlas);
  const png = readPng(bytes);
  if (png.width > UPLOAD_LIMITS.maxAtlasSide || png.height > UPLOAD_LIMITS.maxAtlasSide) reject(400, 'atlas_dimensions', 'Atlas must be at most ' + UPLOAD_LIMITS.maxAtlasSide + ' px on each side');
  const unique = new Set();
  const rects = (list, name) => {
    if (!Array.isArray(list) || !list.length || list.length > UPLOAD_LIMITS.maxFrames) reject(400, 'invalid_frames', name + ' must list 1 to ' + UPLOAD_LIMITS.maxFrames + ' frames');
    return list.map((f) => {
      if (!f || typeof f !== 'object' || ![f.x, f.y, f.w, f.h].every(Number.isInteger)) reject(400, 'invalid_frames', name + ' has a frame that is not {x,y,w,h} integers');
      if (f.w < 1 || f.h < 1 || f.w > UPLOAD_LIMITS.frameSize || f.h > UPLOAD_LIMITS.frameSize) reject(400, 'frame_too_large', 'Frames must be at most ' + UPLOAD_LIMITS.frameSize + ' x ' + UPLOAD_LIMITS.frameSize + ' px');
      if (f.x < 0 || f.y < 0 || f.x + f.w > png.width || f.y + f.h > png.height) reject(400, 'frame_out_of_bounds', name + ' has a frame outside the ' + png.width + ' x ' + png.height + ' atlas');
      unique.add(f.x + ',' + f.y + ',' + f.w + ',' + f.h);
      return { x: f.x, y: f.y, w: f.w, h: f.h };
    });
  };
  const frames = rects(body.frames, 'frames');
  const animations = {};
  const anims = body.animations === undefined ? {} : body.animations;
  if (!anims || typeof anims !== 'object' || Array.isArray(anims)) reject(400, 'invalid_animation', 'animations must be an object');
  for (const [name, list] of Object.entries(anims)) {
    if (!ANIMATIONS.includes(name)) reject(400, 'invalid_animation', 'Unknown animation "' + String(name).slice(0, 20) + '"; use ' + ANIMATIONS.join(', '));
    animations[name] = rects(list, name);
  }
  if (unique.size > UPLOAD_LIMITS.maxFrames) reject(400, 'too_many_frames', 'At most ' + UPLOAD_LIMITS.maxFrames + ' frames per character (got ' + unique.size + ')');
  const meta = { label, mode, fps, frames, animations, anchor: { x: 0.5, y: 1 }, license: UPLOAD_LICENSE, source: 'upload' };
  if (!animations.attack) meta.combatFallback = 'effects';
  return { meta, bytes, png };
}

function decodeAtlas(value) {
  if (typeof value !== 'string' || !value) reject(400, 'invalid_upload', 'atlas must be a base64 PNG');
  const b64 = value.replace(/^data:[^,]*;base64,/, '');
  if (b64.length > Math.ceil(UPLOAD_LIMITS.maxAtlasBytes / 3) * 4) reject(413, 'atlas_too_large', 'Atlas is larger than 1.5 MB');
  let binary;
  try { binary = atob(b64); } catch { reject(400, 'invalid_upload', 'atlas is not valid base64'); }
  if (binary.length > UPLOAD_LIMITS.maxAtlasBytes) reject(413, 'atlas_too_large', 'Atlas is larger than 1.5 MB');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Checks the PNG signature, the IHDR chunk (with CRC) and the chunk layout through IEND. Returns {width, height}.
export function readPng(bytes) {
  const notPng = (why) => reject(415, 'not_png', 'Only PNG images are accepted (' + why + ')');
  if (!(bytes instanceof Uint8Array) || bytes.length < 57) notPng('file too short');
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) notPng('bad signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = (at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (view.getUint32(8) !== 13 || type(12) !== 'IHDR') notPng('IHDR must be the first chunk');
  if (crc32(bytes, 12, 29) !== view.getUint32(29)) notPng('IHDR checksum mismatch');
  const width = view.getUint32(16), height = view.getUint32(20), depth = bytes[24], color = bytes[25];
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[color];
  if (!width || !height || !depths || !depths.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) notPng('invalid IHDR');
  let at = 33, idat = false, end = false;
  while (at + 12 <= bytes.length) {
    const len = view.getUint32(at), name = type(at + 4);
    if (len > bytes.length - at - 12) notPng('truncated chunk');
    if (name === 'IHDR') notPng('duplicate IHDR');
    if (name === 'IDAT') idat = true;
    at += 12 + len;
    if (name === 'IEND') { end = true; break; }
  }
  if (!idat || !end) notPng('missing image data or IEND');
  if (at !== bytes.length) notPng('data after IEND');
  return { width, height };
}

let crcTable;
export function crc32(bytes, start = 0, end = bytes.length) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function customId(label) {
  const slug = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'char';
  const rand = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return 'c-' + slug + '-' + rand;
}

function catalogEntry(channel, row) {
  let meta = {};
  try { meta = JSON.parse(row.meta); } catch {}
  return { ...meta, id: row.id, url: '/api/assets/' + channel + '/' + row.id, custom: true };
}
