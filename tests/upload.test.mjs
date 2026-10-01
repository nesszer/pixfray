// Lane D: upload validation (server/uploads.js), storage in the ChannelRoom, and the browser atlas packer (public/atlas.js).
// Run with: node --import ./tests/register.mjs --test tests/upload.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { UPLOAD_LIMITS, UPLOAD_BODY_LIMIT, validateUpload, readPng, handleUploads, handleRoomAssets, ensureUploadSchema, customUsage } from '../server/uploads.js';
import { ChannelRoom } from '../server/channel.js';
import { LIMITS, pngInfo, checkFrames, planAtlas, fitSingle, drawAtlas, uploadBody } from '../public/atlas.js';
import { makePng, b64, fakeRoomCtx } from './upload-helpers.mjs';

const SECRET = 'test-only-internal-secret-0123456789';
const strip = (w, h, n) => Array.from({ length: n }, (_, i) => ({ x: i * w, y: 0, w, h }));
function body(extra = {}) {
  return { label: 'Night Knight', mode: 'frames', fps: 8, atlas: b64(makePng(256, 64)), frames: strip(64, 64, 4), animations: { idle: strip(64, 64, 1), walk: strip(64, 64, 4) }, ...extra };
}
function rejects(fn, status, reason) {
  assert.throws(fn, (e) => { assert.equal(e.reason, reason, e.message); assert.equal(e.status, status); return true; });
}

// ---------- server validation ----------
test('a good PNG atlas passes and produces catalog metadata', () => {
  const r = validateUpload(body());
  assert.deepEqual(r.png, { width: 256, height: 64 });
  assert.equal(r.meta.label, 'Night Knight');
  assert.equal(r.meta.frames.length, 4);
  assert.equal(r.meta.combatFallback, 'effects', 'no attack frames -> effects flag');
  assert.deepEqual(r.meta.anchor, { x: 0.5, y: 1 });
  const withAttack = validateUpload(body({ animations: { walk: strip(64, 64, 2), attack: [{ x: 128, y: 0, w: 64, h: 64 }] } }));
  assert.equal(withAttack.meta.combatFallback, undefined);
  assert.equal(validateUpload(body({ atlas: 'data:image/png;base64,' + b64(makePng(256, 64)) })).png.width, 256);
});

test('non-PNG bytes are rejected by signature and IHDR checks, whatever they claim to be', () => {
  rejects(() => validateUpload(body({ atlas: b64(Buffer.from('GIF89a' + 'x'.repeat(80))) })), 415, 'not_png');
  rejects(() => validateUpload(body({ atlas: b64(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(80).fill(0)])) })), 415, 'not_png');
  const png = makePng(256, 64);
  const badCrc = Buffer.from(png); badCrc[20] ^= 1;                 // height byte changed, IHDR CRC no longer matches
  rejects(() => validateUpload(body({ atlas: b64(badCrc) })), 415, 'not_png');
  rejects(() => validateUpload(body({ atlas: b64(Buffer.concat([png, Buffer.from('trailing')])) })), 415, 'not_png');
  rejects(() => validateUpload(body({ atlas: b64(png.subarray(0, png.length - 12)) })), 415, 'not_png');   // no IEND
  rejects(() => validateUpload(body({ atlas: '***not base64***' })), 400, 'invalid_upload');
  rejects(() => validateUpload(body({ atlas: undefined })), 400, 'invalid_upload');
});

test('an atlas over 1.5 MB is rejected', () => {
  const big = makePng(256, 64, { extra: [['tEXt', Buffer.alloc(UPLOAD_LIMITS.maxAtlasBytes, 0x41)]] });
  assert.ok(big.length > UPLOAD_LIMITS.maxAtlasBytes);
  assert.doesNotThrow(() => readPng(big), 'it is still a structurally valid PNG');
  rejects(() => validateUpload(body({ atlas: b64(big) })), 413, 'atlas_too_large');
  const justUnder = makePng(256, 64);
  const pad = UPLOAD_LIMITS.maxAtlasBytes - justUnder.length - 12;
  const atLimit = makePng(256, 64, { extra: [['tEXt', Buffer.alloc(pad, 0x41)]] });
  assert.equal(atLimit.length, UPLOAD_LIMITS.maxAtlasBytes);
  assert.equal(validateUpload(body({ atlas: b64(atLimit) })).bytes.length, UPLOAD_LIMITS.maxAtlasBytes);
  assert.ok(UPLOAD_BODY_LIMIT >= Math.ceil(UPLOAD_LIMITS.maxAtlasBytes / 3) * 4, 'the body limit fits a full-size base64 atlas');
});

test('frame limits: 24 frames, 128 x 128, inside the atlas, known animations only', () => {
  const wide = b64(makePng(1024, 384));
  const grid = (n) => Array.from({ length: n }, (_, i) => ({ x: (i % 8) * 128, y: Math.floor(i / 8) * 128, w: 128, h: 128 }));
  assert.equal(validateUpload(body({ atlas: wide, frames: grid(24), animations: { walk: grid(24) } })).meta.frames.length, 24);
  rejects(() => validateUpload(body({ atlas: wide, frames: grid(24), animations: { attack: [{ x: 0, y: 0, w: 64, h: 64 }] } })), 400, 'too_many_frames');
  rejects(() => validateUpload(body({ atlas: wide, frames: grid(25) })), 400, 'invalid_frames');
  rejects(() => validateUpload(body({ atlas: b64(makePng(300, 64)), frames: [{ x: 0, y: 0, w: 129, h: 64 }] })), 400, 'frame_too_large');
  rejects(() => validateUpload(body({ frames: [{ x: 200, y: 0, w: 64, h: 64 }] })), 400, 'frame_out_of_bounds');
  rejects(() => validateUpload(body({ frames: [{ x: -1, y: 0, w: 64, h: 64 }] })), 400, 'frame_out_of_bounds');
  rejects(() => validateUpload(body({ frames: [{ x: 0.5, y: 0, w: 64, h: 64 }] })), 400, 'invalid_frames');
  rejects(() => validateUpload(body({ frames: [] })), 400, 'invalid_frames');
  rejects(() => validateUpload(body({ animations: { dance: strip(64, 64, 1) } })), 400, 'invalid_animation');
  rejects(() => validateUpload(body({ atlas: b64(makePng(1025, 8)), frames: [{ x: 0, y: 0, w: 8, h: 8 }] })), 400, 'atlas_dimensions');
  rejects(() => validateUpload(body({ label: '   ' })), 400, 'invalid_label');
  rejects(() => validateUpload(body({ label: 'x'.repeat(33) })), 400, 'invalid_label');
  rejects(() => validateUpload(body({ fps: 0 })), 400, 'invalid_fps');
  rejects(() => validateUpload(body({ mode: 'gif' })), 400, 'invalid_upload');
});

// ---------- room storage ----------
function room() {
  const r = new ChannelRoom(fakeRoomCtx(), { INTERNAL_SECRET: SECRET });
  r.call = async (path, { method = 'GET', data } = {}) => {
    const headers = { 'X-Mini-Internal': SECRET, 'X-Mini-Channel': 'nesszerra', ...(data ? { 'Content-Type': 'application/json' } : {}) };
    const res = await r.fetch(new Request('https://room' + path, { method, headers, ...(data ? { body: JSON.stringify(data) } : {}) }));
    const type = res.headers.get('content-type') || '';
    return { status: res.status, type, body: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
  };
  return r;
}

test('the room stores up to 8 characters and refuses the 9th', async () => {
  const r = room();
  const ids = [];
  for (let i = 1; i <= 8; i++) {
    const res = await r.call('/asset', { method: 'POST', data: { ...body({ label: 'Knight ' + i }), createdBy: 'u' + i } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.item.id, /^c-knight-\d-[0-9a-f]{6}$/);
    assert.equal(res.body.item.url, '/api/assets/nesszerra/' + res.body.item.id);
    assert.equal(res.body.usage.count, i);
    ids.push(res.body.item.id);
  }
  const ninth = await r.call('/asset', { method: 'POST', data: body({ label: 'Knight 9' }) });
  assert.equal(ninth.status, 409);
  assert.equal(ninth.body.reason, 'custom_limit_reached');
  assert.deepEqual(customUsage(r), { count: 8, limit: 8, bytes: 8 * makePng(256, 64).length });

  const catalog = await r.call('/catalog');
  assert.equal(catalog.body.length, 8);
  assert.ok(catalog.body.every((e) => e.custom === true && e.license && e.frames.length && !('atlas' in e)));

  const png = await r.call('/asset/' + ids[0]);
  assert.equal(png.status, 200);
  assert.equal(png.type, 'image/png');
  assert.deepEqual(readPng(png.body), { width: 256, height: 64 });

  const list = await r.call('/asset');
  assert.equal(list.body.items.length, 8);
  assert.equal(list.body.items[0].createdBy, 'u1');
  assert.equal(list.body.limits.maxCharacters, 8);

  const del = await r.call('/asset/' + ids[0], { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(del.body.usage.count, 7);
  assert.equal((await r.call('/asset/' + ids[0])).status, 404);
  assert.equal((await r.call('/asset/' + ids[0], { method: 'DELETE' })).status, 404);
  assert.equal((await r.call('/asset', { method: 'POST', data: body({ label: 'Replacement' }) })).status, 201);
});

test('the room re-validates uploads even from an internal caller', async () => {
  const r = room();
  const res = await r.call('/asset', { method: 'POST', data: body({ atlas: b64(Buffer.from('not a png at all, just text padding padding padding padding')) }) });
  assert.equal(res.status, 415);
  assert.equal(customUsage(r).count, 0);
  assert.equal((await r.call('/asset/../../etc')).status, 404);
});

// ---------- worker gate ----------
function workerCtx({ canManage = true, user = { id: '1', login: 'nesszerra' }, id = '' } = {}) {
  const calls = [];
  return {
    calls, user, owner: canManage, channel: 'nesszerra', id,
    access: async () => ({ canManage, reason: canManage ? undefined : 'Moderator role required' }),
    bodyJson: async (request, limit) => { const text = await request.text(); if (text.length > limit) throw Object.assign(new Error('Request too large'), { status: 413 }); return JSON.parse(text); },
    roomFetch: async (path, init = {}) => { calls.push({ path, init, body: init.body ? JSON.parse(init.body) : undefined }); return Response.json({ ok: true }, { status: 201 }); },
  };
}
const post = (data) => new Request('https://chat.miolaf.xyz/api/assets/nesszerra', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof data === 'string' ? data : JSON.stringify(data) });

test('the worker checks roles and limits before the room is touched', async () => {
  const anon = workerCtx({ canManage: false, user: null });
  assert.equal((await handleUploads(post(body()), {}, anon)).status, 401);
  const viewer = workerCtx({ canManage: false, user: { id: '2' } });
  assert.equal((await handleUploads(post(body()), {}, viewer)).status, 403);
  assert.equal(viewer.calls.length, 0);

  const mod = workerCtx();
  const notPng = await handleUploads(post(body({ atlas: b64(Buffer.from('GIF89a' + 'x'.repeat(80))) })), {}, mod);
  assert.equal(notPng.status, 415);
  assert.equal((await notPng.json()).reason, 'not_png');
  const huge = await handleUploads(post('{"atlas":"' + 'A'.repeat(UPLOAD_BODY_LIMIT) + '"}'), {}, mod);
  assert.equal(huge.status, 413);
  assert.equal(mod.calls.length, 0);

  const ok = await handleUploads(post({ ...body(), createdBy: 'forged' }), {}, mod);
  assert.equal(ok.status, 201);
  assert.equal(mod.calls[0].path, '/asset');
  assert.equal(mod.calls[0].body.createdBy, '1', 'createdBy is the session user, never the body');

  const del = workerCtx({ id: 'c-knight-abc123' });
  await handleUploads(new Request('https://x/api/assets/nesszerra/c-knight-abc123', { method: 'DELETE' }), {}, del);
  assert.deepEqual([del.calls[0].path, del.calls[0].init.method], ['/asset/c-knight-abc123', 'DELETE']);
  const badId = workerCtx({ id: 'adventurer' });
  assert.equal((await handleUploads(new Request('https://x/api/assets/nesszerra/adventurer', { method: 'DELETE' }), {}, badId)).status, 404);
  assert.equal(badId.calls.length, 0);
});

// ---------- browser packer ----------
test('browser limits match the server limits', () => {
  for (const k of ['maxFrames', 'frameSize', 'maxAtlasBytes', 'maxCharacters', 'maxAtlasSide', 'maxLabel', 'mime']) assert.equal(LIMITS[k], UPLOAD_LIMITS[k], k);
});

test('pngInfo reads the size and rejects non-PNG bytes', () => {
  assert.deepEqual(pngInfo(makePng(33, 17)), { width: 33, height: 17 });
  assert.equal(pngInfo(Buffer.from('GIF89a' + 'x'.repeat(40))), null);
  assert.equal(pngInfo(new Uint8Array(4)), null);
});

test('checkFrames enforces the frame count and size limits', () => {
  assert.deepEqual(checkFrames({ walk: [{ w: 64, h: 64 }] }), []);
  assert.match(checkFrames({})[0], /at least one/);
  assert.match(checkFrames({ walk: Array(20).fill({ w: 8, h: 8 }), attack: Array(5).fill({ w: 8, h: 8 }) })[0], /at most 24/);
  assert.match(checkFrames({ idle: [{ w: 129, h: 10 }] })[0], /129 x 10/);
});

test('planAtlas packs frames bottom-centre into a uniform grid', () => {
  const plan = planAtlas({ idle: [{ w: 40, h: 50 }], walk: [{ w: 64, h: 60 }, { w: 60, h: 64 }], ko: [{ w: 64, h: 30 }] });
  assert.deepEqual(plan.cell, { w: 64, h: 64 });
  assert.deepEqual([plan.cols, plan.rows, plan.width, plan.height], [4, 1, 256, 64]);
  assert.deepEqual(plan.placements[0], { slot: 'idle', index: 0, w: 40, h: 50, x: 0, y: 0, dx: 12, dy: 14 });
  assert.deepEqual(plan.placements[3], { slot: 'ko', index: 0, w: 64, h: 30, x: 192, y: 0, dx: 192, dy: 34 });
  assert.deepEqual(plan.frames, plan.animations.walk, 'frames falls back to the walk loop');
  assert.deepEqual(Object.keys(plan.animations), ['idle', 'walk', 'ko']);
  const full = planAtlas({ walk: Array(24).fill({ w: 128, h: 128 }) });
  assert.deepEqual([full.cols, full.rows, full.width, full.height], [8, 3, 1024, 384]);
  assert.deepEqual(planAtlas({ idle: [{ w: 10, h: 10 }] }).frames, [{ x: 0, y: 0, w: 10, h: 10 }]);
  assert.throws(() => planAtlas({}));
});

test('fitSingle scales large single images down, never up', () => {
  assert.deepEqual(fitSingle(64, 32), { w: 64, h: 32, scale: 1 });
  assert.deepEqual(fitSingle(512, 256), { w: 128, h: 64, scale: 0.25 });
  assert.equal(fitSingle(100, 400).h, 128);
});

test('drawAtlas draws every frame at its aligned spot', () => {
  const plan = planAtlas({ walk: [{ w: 32, h: 20 }, { w: 30, h: 32 }] });
  const draws = [];
  const canvas = drawAtlas(plan, { walk: ['A', 'B'] }, (w, h) => ({ w, h, getContext: () => ({ clearRect() {}, drawImage: (...a) => draws.push(a) }) }));
  assert.deepEqual([canvas.w, canvas.h], [64, 32]);
  assert.deepEqual(draws, [['A', 0, 12, 32, 20], ['B', 33, 0, 30, 32]]);
});

test('a packed plan plus its PNG passes server validation end to end', () => {
  const groups = { idle: [{ w: 48, h: 64 }], walk: Array(6).fill({ w: 64, h: 64 }), attack: Array(3).fill({ w: 80, h: 70 }), ko: [{ w: 90, h: 40 }] };
  const plan = planAtlas(groups);
  const req = uploadBody(plan, { label: '  Brawler  ', fps: 10, atlas: b64(makePng(plan.width, plan.height)) });
  const r = validateUpload(req);
  assert.equal(r.meta.label, 'Brawler');
  assert.equal(r.meta.combatFallback, undefined);
  assert.equal(r.meta.animations.attack.length, 3);
  const single = planAtlas({ idle: [fitSingle(300, 200)] });
  assert.equal(validateUpload(uploadBody(single, { label: 'Blob', mode: 'single', atlas: b64(makePng(single.width, single.height)) })).meta.mode, 'single');
});

test('ensureUploadSchema is idempotent', () => {
  const ctx = fakeRoomCtx();
  ensureUploadSchema(ctx.storage.sql); ensureUploadSchema(ctx.storage.sql);
  assert.deepEqual(customUsage({ ctx }), { count: 0, limit: 8, bytes: 0 });
  assert.equal(typeof handleRoomAssets, 'function');
});
