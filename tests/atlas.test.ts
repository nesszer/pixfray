// Lane D: the browser atlas packer (src/served/atlas.ts) against the server's upload limits and validation
// (server/uploads.ts). Its own file because it imports both a Worker module and a DOM module
// (tsconfig.node-all.json).
// Run with: node --import ./tests/register.ts --test tests/atlas.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { UPLOAD_LIMITS, validateUpload } from "../server/uploads.ts";
import { LIMITS, pngInfo, checkFrames, planAtlas, fitSingle, drawAtlas, uploadBody } from "../src/served/atlas.ts";
import { makePng, b64 } from "./upload-helpers.ts";
import { must } from "./fakes.ts";

/** The 2D context calls drawAtlas makes. */
type FakeContext2D = Pick<CanvasRenderingContext2D, "imageSmoothingEnabled" | "clearRect" | "drawImage">;

test("browser limits match the server limits", () => {
  for (const k of [
    "maxFrames",
    "frameSize",
    "maxAtlasBytes",
    "maxCharacters",
    "maxAtlasSide",
    "maxLabel",
    "mime",
  ] satisfies (keyof typeof LIMITS)[])
    assert.equal(LIMITS[k], UPLOAD_LIMITS[k], k);
});

test("pngInfo reads the size and rejects non-PNG bytes", () => {
  assert.deepEqual(pngInfo(makePng(33, 17)), { width: 33, height: 17 });
  assert.equal(pngInfo(Buffer.from("GIF89a" + "x".repeat(40))), null);
  assert.equal(pngInfo(new Uint8Array(4)), null);
});

test("checkFrames enforces the frame count and size limits", () => {
  assert.deepEqual(checkFrames({ walk: [{ w: 64, h: 64 }] }), []);
  // as string: these groups break a limit, so checkFrames returns at least one message (match fails the test if not)
  assert.match(checkFrames({})[0] as string, /at least one/);
  assert.match(
    // as string: as above
    checkFrames({ walk: Array(20).fill({ w: 8, h: 8 }), attack: Array(5).fill({ w: 8, h: 8 }) })[0] as string,
    /at most 24/,
  );
  // as string: as above
  assert.match(checkFrames({ idle: [{ w: 129, h: 10 }] })[0] as string, /129 x 10/);
});

test("planAtlas packs frames bottom-centre into a uniform grid", () => {
  const plan = planAtlas({
    idle: [{ w: 40, h: 50 }],
    walk: [
      { w: 64, h: 60 },
      { w: 60, h: 64 },
    ],
    ko: [{ w: 64, h: 30 }],
  });
  assert.deepEqual(plan.cell, { w: 64, h: 64 });
  assert.deepEqual([plan.cols, plan.rows, plan.width, plan.height], [4, 1, 256, 64]);
  assert.deepEqual(plan.placements[0], { slot: "idle", index: 0, w: 40, h: 50, x: 0, y: 0, dx: 12, dy: 14 });
  assert.deepEqual(plan.placements[3], { slot: "ko", index: 0, w: 64, h: 30, x: 192, y: 0, dx: 192, dy: 34 });
  assert.deepEqual(plan.frames, plan.animations.walk, "frames falls back to the walk loop");
  assert.deepEqual(Object.keys(plan.animations), ["idle", "walk", "ko"]);
  const full = planAtlas({ walk: Array(24).fill({ w: 128, h: 128 }) });
  assert.deepEqual([full.cols, full.rows, full.width, full.height], [8, 3, 1024, 384]);
  assert.deepEqual(planAtlas({ idle: [{ w: 10, h: 10 }] }).frames, [{ x: 0, y: 0, w: 10, h: 10 }]);
  assert.throws(() => planAtlas({}));
});

test("fitSingle scales large single images down, never up", () => {
  assert.deepEqual(fitSingle(64, 32), { w: 64, h: 32, scale: 1 });
  assert.deepEqual(fitSingle(512, 256), { w: 128, h: 64, scale: 0.25 });
  assert.equal(fitSingle(100, 400).h, 128);
});

test("drawAtlas draws every frame at its aligned spot", () => {
  const plan = planAtlas({
    walk: [
      { w: 32, h: 20 },
      { w: 30, h: 32 },
    ],
  });
  const draws: unknown[][] = [];
  // stand-in images: the fake context only records what drawAtlas hands it
  const canvas = drawAtlas(plan, { walk: ["A", "B"] as unknown as CanvasImageSource[] }, (w, h) => ({
    w,
    h,
    // the fake has only the calls drawAtlas makes; drawAtlas sets imageSmoothingEnabled on it itself
    getContext: () => ({ clearRect() {}, drawImage: (...a: unknown[]) => draws.push(a) }) as unknown as FakeContext2D,
  }));
  assert.deepEqual([canvas.w, canvas.h], [64, 32]);
  assert.deepEqual(draws, [
    ["A", 0, 12, 32, 20],
    ["B", 33, 0, 30, 32],
  ]);
});

test("a packed plan plus its PNG passes server validation end to end", () => {
  const groups = {
    idle: [{ w: 48, h: 64 }],
    walk: Array(6).fill({ w: 64, h: 64 }),
    attack: Array(3).fill({ w: 80, h: 70 }),
    ko: [{ w: 90, h: 40 }],
  };
  const plan = planAtlas(groups);
  const req = uploadBody(plan, { label: "  Brawler  ", fps: 10, atlas: b64(makePng(plan.width, plan.height)) });
  const r = validateUpload(req);
  assert.equal(r.meta.label, "Brawler");
  assert.equal(r.meta.combatFallback, undefined);
  assert.equal(must(r.meta.animations.attack).length, 3);
  const single = planAtlas({ idle: [fitSingle(300, 200)] });
  assert.equal(
    validateUpload(
      uploadBody(single, { label: "Blob", mode: "single", atlas: b64(makePng(single.width, single.height)) }),
    ).meta.mode,
    "single",
  );
});
