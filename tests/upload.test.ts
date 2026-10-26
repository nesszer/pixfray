// Lane D: upload validation (server/uploads.ts) and storage in the ChannelRoom. The browser atlas packer is in
// tests/atlas.test.ts.
// Run with: node --import ./tests/register.ts --test tests/upload.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  UPLOAD_LIMITS,
  UPLOAD_BODY_LIMIT,
  validateUpload,
  readPng,
  handleUploads,
  handleRoomAssets,
  ensureUploadSchema,
  customUsage,
} from "../server/uploads.ts";
import { ChannelRoom } from "../server/channel.ts";
import { makePng, b64 } from "./upload-helpers.ts";
import { fakeCtx, must } from "./fakes.ts";
import type { Loose } from "./fakes.ts";
import type { UploadsContext } from "../server/uploads.ts";
import type { Env } from "../server/env.ts";

const SECRET = "test-only-internal-secret-0123456789";
const strip = (w: number, h: number, n: number) => Array.from({ length: n }, (_, i) => ({ x: i * w, y: 0, w, h }));
function body(extra: Record<string, unknown> = {}) {
  return {
    label: "Night Knight",
    mode: "frames",
    fps: 8,
    atlas: b64(makePng(256, 64)),
    frames: strip(64, 64, 4),
    animations: { idle: strip(64, 64, 1), walk: strip(64, 64, 4) },
    ...extra,
  };
}
/** What validateUpload throws: an UploadError (not exported) with the HTTP status and a reason code. */
type Rejection = { status: number; reason: string; message: string };
/** Each case is [fields over body(), status, reason]: validateUpload must refuse it with exactly that. */
function refuses(cases: [Record<string, unknown>, number, string][]) {
  for (const [extra, status, reason] of cases)
    assert.throws(
      () => validateUpload(body(extra)),
      (e: Rejection) => {
        assert.equal(e.reason, reason, e.message);
        assert.equal(e.status, status);
        return true;
      },
    );
}
const frame = (x: number, w = 64, h = 64) => [{ x, y: 0, w, h }];

// ---------- server validation ----------
test("a good PNG atlas passes and produces catalog metadata", () => {
  const r = validateUpload(body());
  assert.deepEqual(r.png, { width: 256, height: 64 });
  assert.equal(r.meta.label, "Night Knight");
  assert.equal(r.meta.frames.length, 4);
  assert.equal(r.meta.combatFallback, "effects", "no attack frames -> effects flag");
  assert.deepEqual(r.meta.anchor, { x: 0.5, y: 1 });
  const withAttack = validateUpload(body({ animations: { walk: strip(64, 64, 2), attack: frame(128) } }));
  assert.equal(withAttack.meta.combatFallback, undefined);
  assert.equal(validateUpload(body({ atlas: "data:image/png;base64," + b64(makePng(256, 64)) })).png.width, 256);
});

test("non-PNG bytes are rejected by signature and IHDR checks, whatever they claim to be", () => {
  const png = makePng(256, 64);
  const badCrc = Buffer.from(png);
  badCrc[20] ^= 1; // height byte changed, IHDR CRC no longer matches
  const notPng = [
    Buffer.from("GIF89a" + "x".repeat(80)),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(80).fill(0)]), // JPEG
    badCrc,
    Buffer.concat([png, Buffer.from("trailing")]),
    png.subarray(0, png.length - 12), // no IEND
  ];
  refuses([
    ...notPng.map((bytes): [Record<string, unknown>, number, string] => [{ atlas: b64(bytes) }, 415, "not_png"]),
    [{ atlas: "***not base64***" }, 400, "invalid_upload"],
    [{ atlas: undefined }, 400, "invalid_upload"],
  ]);
});

test("an atlas over 1.5 MB is rejected", () => {
  const big = makePng(256, 64, { extra: [["tEXt", Buffer.alloc(UPLOAD_LIMITS.maxAtlasBytes, 0x41)]] });
  assert.ok(big.length > UPLOAD_LIMITS.maxAtlasBytes);
  assert.doesNotThrow(() => readPng(big), "it is still a structurally valid PNG");
  refuses([[{ atlas: b64(big) }, 413, "atlas_too_large"]]);
  const justUnder = makePng(256, 64);
  const pad = UPLOAD_LIMITS.maxAtlasBytes - justUnder.length - 12;
  const atLimit = makePng(256, 64, { extra: [["tEXt", Buffer.alloc(pad, 0x41)]] });
  assert.equal(atLimit.length, UPLOAD_LIMITS.maxAtlasBytes);
  assert.equal(validateUpload(body({ atlas: b64(atLimit) })).bytes.length, UPLOAD_LIMITS.maxAtlasBytes);
  const fullAtlas = Math.ceil(UPLOAD_LIMITS.maxAtlasBytes / 3) * 4;
  assert.ok(UPLOAD_BODY_LIMIT >= fullAtlas, "the body limit fits a full-size base64 atlas");
});

test("frame limits: 24 frames, 128 x 128, inside the atlas, known animations only", () => {
  const wide = b64(makePng(1024, 384));
  const grid = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ x: (i % 8) * 128, y: Math.floor(i / 8) * 128, w: 128, h: 128 }));
  const { meta } = validateUpload(body({ atlas: wide, frames: grid(24), animations: { walk: grid(24) } }));
  assert.equal(meta.frames.length, 24);
  refuses([
    [{ atlas: wide, frames: grid(24), animations: { attack: frame(0) } }, 400, "too_many_frames"],
    [{ atlas: wide, frames: grid(25) }, 400, "invalid_frames"],
    [{ atlas: b64(makePng(300, 64)), frames: frame(0, 129) }, 400, "frame_too_large"],
    [{ frames: frame(200) }, 400, "frame_out_of_bounds"],
    [{ frames: frame(-1) }, 400, "frame_out_of_bounds"],
    [{ frames: frame(0.5) }, 400, "invalid_frames"],
    [{ frames: [] }, 400, "invalid_frames"],
    [{ animations: { dance: strip(64, 64, 1) } }, 400, "invalid_animation"],
    [{ atlas: b64(makePng(1025, 8)), frames: frame(0, 8, 8) }, 400, "atlas_dimensions"],
    [{ label: "   " }, 400, "invalid_label"],
    [{ label: "x".repeat(33) }, 400, "invalid_label"],
    [{ fps: 0 }, 400, "invalid_fps"],
    [{ mode: "gif" }, 400, "invalid_upload"],
  ]);
});

// ---------- room storage ----------
// Loose: the body is the room's JSON reply (read by property) or the PNG bytes
type CallResult = { status: number; type: string; body: Loose };
/** A ChannelRoom with the call() helper room() attaches. */
type TestRoom = ChannelRoom & {
  call(path: string, options?: { method?: string; data?: unknown }): Promise<CallResult>;
};
function room(): TestRoom {
  // TestRoom: room() attaches call below before returning; Env: a partial Env on purpose (the room reads only these)
  const r = new ChannelRoom(fakeCtx(), { INTERNAL_SECRET: SECRET } as Env) as TestRoom;
  r.call = async (path, { method = "GET", data } = {}) => {
    const headers = {
      "X-Mini-Internal": SECRET,
      "X-Mini-Channel": "nesszerra",
      ...(data ? { "Content-Type": "application/json" } : {}),
    };
    const res = await r.fetch(
      new Request("https://room" + path, { method, headers, ...(data ? { body: JSON.stringify(data) } : {}) }),
    );
    const type = res.headers.get("content-type") || "";
    return {
      status: res.status,
      type,
      // Loose: the JSON reply body, which the tests read by property
      body: type.includes("json") ? await res.json<Loose>() : new Uint8Array(await res.arrayBuffer()),
    };
  };
  return r;
}

test("the room stores up to 24 characters and refuses the 25th", async () => {
  const r = room();
  const ids: string[] = [];
  for (let i = 1; i <= 24; i++) {
    const res = await r.call("/asset", {
      method: "POST",
      data: { ...body({ label: "Knight " + i }), createdBy: "u" + i },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.item.id, /^c-knight-\d+-[0-9a-f]{6}$/);
    assert.equal(res.body.item.url, "/api/assets/nesszerra/" + res.body.item.id);
    assert.equal(res.body.usage.count, i);
    ids.push(res.body.item.id);
  }
  const extra = await r.call("/asset", { method: "POST", data: body({ label: "Knight 25" }) });
  assert.equal(extra.status, 409);
  assert.equal(extra.body.reason, "custom_limit_reached");
  assert.deepEqual(customUsage(r), { count: 24, limit: 24, bytes: 24 * makePng(256, 64).length });

  const catalog = await r.call("/catalog");
  assert.equal(catalog.body.length, 24);
  assert.ok(
    catalog.body.every(
      (e: { custom: unknown; license: unknown; frames: unknown[] }) =>
        e.custom === true && e.license && e.frames.length && !("atlas" in e),
    ),
  );

  const png = await r.call("/asset/" + ids[0]);
  assert.equal(png.status, 200);
  assert.equal(png.type, "image/png");
  assert.deepEqual(readPng(png.body), { width: 256, height: 64 });

  const list = await r.call("/asset");
  assert.equal(list.body.items.length, 24);
  assert.equal(list.body.items[0].createdBy, "u1");
  assert.equal(list.body.limits.maxCharacters, 24);

  const del = await r.call("/asset/" + ids[0], { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal(del.body.usage.count, 23);
  assert.equal((await r.call("/asset/" + ids[0])).status, 404);
  assert.equal((await r.call("/asset/" + ids[0], { method: "DELETE" })).status, 404);
  assert.equal((await r.call("/asset", { method: "POST", data: body({ label: "Replacement" }) })).status, 201);
});

test("the room re-validates uploads even from an internal caller", async () => {
  const r = room();
  const res = await r.call("/asset", {
    method: "POST",
    data: body({ atlas: b64(Buffer.from("not a png at all, just text padding padding padding padding")) }),
  });
  assert.equal(res.status, 415);
  assert.equal(customUsage(r).count, 0);
  assert.equal((await r.call("/asset/../../etc")).status, 404);
});

// ---------- worker gate ----------
// Loose: the room request body as JSON, which the test reads by property
type RoomCall = { path: string; init: RequestInit; body: Loose };
type WorkerCtxOptions = { canManage?: boolean; user?: { id: string; login?: string } | null; id?: string };
function workerCtx({
  canManage = true,
  user = { id: "1", login: "nesszerra" },
  id = "",
}: WorkerCtxOptions = {}): UploadsContext & { calls: RoomCall[] } {
  const calls: RoomCall[] = [];
  return {
    calls,
    user,
    owner: canManage,
    channel: "nesszerra",
    id,
    // as string: the key stays present as undefined when canManage is true (exactOptionalPropertyTypes); handleUploads
    // reads it with ||, so undefined and a missing key behave the same
    access: async () => ({ canManage, reason: (canManage ? undefined : "Moderator role required") as string }),
    bodyJson: async (request, limit) => {
      const text = await request.text();
      if (text.length > limit) throw Object.assign(new Error("Request too large"), { status: 413 });
      return JSON.parse(text);
    },
    roomFetch: async (path, init = {}) => {
      calls.push({
        path,
        init,
        body: init.body ? JSON.parse(init.body as string) /* uploads.ts sends a JSON string */ : undefined,
      });
      return Response.json({ ok: true }, { status: 201 });
    },
  };
}
const post = (data: unknown) =>
  new Request("https://chat.miolaf.xyz/api/assets/nesszerra", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof data === "string" ? data : JSON.stringify(data),
  });
const remove = (id: string) => new Request("https://x/api/assets/nesszerra/" + id, { method: "DELETE" });
const gate = (request: Request, ctx: UploadsContext) => handleUploads(request, {} as Env /* reads no binding */, ctx);

test("the worker checks roles and limits before the room is touched", async () => {
  assert.equal((await gate(post(body()), workerCtx({ canManage: false, user: null }))).status, 401);
  const viewer = workerCtx({ canManage: false, user: { id: "2" } });
  assert.equal((await gate(post(body()), viewer)).status, 403);
  assert.equal(viewer.calls.length, 0);

  const mod = workerCtx();
  const notPng = await gate(post(body({ atlas: b64(Buffer.from("GIF89a" + "x".repeat(80))) })), mod);
  assert.equal(notPng.status, 415);
  // Loose: the JSON error reply; the test reads its reason
  assert.equal((await notPng.json<Loose>()).reason, "not_png");
  assert.equal((await gate(post('{"atlas":"' + "A".repeat(UPLOAD_BODY_LIMIT) + '"}'), mod)).status, 413);
  assert.equal(mod.calls.length, 0);

  assert.equal((await gate(post({ ...body(), createdBy: "forged" }), mod)).status, 201);
  assert.equal(must(mod.calls[0]).path, "/asset");
  assert.equal(must(mod.calls[0]).body.createdBy, "1", "createdBy is the session user, never the body");

  const del = workerCtx({ id: "c-knight-abc123" });
  await gate(remove("c-knight-abc123"), del);
  assert.deepEqual([must(del.calls[0]).path, must(del.calls[0]).init.method], ["/asset/c-knight-abc123", "DELETE"]);
  const badId = workerCtx({ id: "adventurer" });
  assert.equal((await gate(remove("adventurer"), badId)).status, 404);
  assert.equal(badId.calls.length, 0);
});

test("ensureUploadSchema is idempotent", () => {
  const ctx = fakeCtx();
  ensureUploadSchema(ctx.storage.sql);
  ensureUploadSchema(ctx.storage.sql);
  assert.deepEqual(customUsage({ ctx }), { count: 0, limit: 24, bytes: 0 });
  assert.equal(typeof handleRoomAssets, "function");
});
