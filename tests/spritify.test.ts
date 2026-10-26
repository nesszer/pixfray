// The browser's picture-to-sprite steps (src/spritify.ts) on plain images, and the server checks they must pass.
import test from "node:test";
import assert from "node:assert/strict";
import { fitSize, hasCutout, removeBackground, contentBox, enlarge, spritify, SPRITE_MAX } from "../src/spritify.ts";
import { validateSprite, validateRedrawImage, jpegSize, spriteDay, SPRITE_LIMITS } from "../server/sprites.ts";
import type { Img } from "../src/spritify.ts";
import { dropEdgeLeak, labOf } from "../src/autosprite.ts";
import { makePng, b64 } from "./upload-helpers.ts";
import { must } from "./fakes.ts";

// A w x h picture: `pixel(x, y)` gives [r, g, b, a].
function picture(w: number, h: number, pixel: (x: number, y: number) => readonly number[]): Img {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(pixel(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}
const at = (img: Img, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4).subarray(0, 4)];
// A red ball with a blue stripe on a white photo background, touching nothing.
const ball = (w = 300, h = 200) =>
  picture(w, h, (x, y) =>
    (x - 150) ** 2 + (y - 100) ** 2 < 60 ** 2
      ? Math.abs(y - 100) < 8
        ? [30, 40, 220, 255]
        : [220, 30, 30, 255]
      : [250, 250, 248, 255],
  );

test("spritify: sizes, cut-outs and the background fill", () => {
  assert.deepEqual(fitSize(1000, 500, 512), { width: 512, height: 256 });
  assert.deepEqual(fitSize(40, 30, 512), { width: 40, height: 30 });
  const img = ball();
  assert.equal(hasCutout(img), false);
  const cut = removeBackground(img);
  assert.equal(at(cut, 0, 0)[3], 0);
  assert.equal(at(cut, 150, 100)[3], 255);
  assert.deepEqual(contentBox(cut), { x: 92, y: 41, width: 118, height: 120 });
  // A picture that is already cut out is left alone.
  const png = picture(20, 20, (x) => (x > 5 && x < 15 ? [0, 0, 0, 255] : [255, 255, 255, 0]));
  assert.equal(hasCutout(png), true);
  assert.equal(removeBackground(png), png);
  // A subject touching the border keeps its body: only the border's main colors are background.
  const tall = picture(100, 100, (x) => (x > 40 && x < 60 ? [200, 20, 20, 255] : [255, 255, 255, 255]));
  const kept = removeBackground(tall);
  assert.equal(at(kept, 50, 0)[3], 255);
  assert.equal(at(kept, 10, 50)[3], 0);
  assert.equal(contentBox(picture(4, 4, () => [0, 0, 0, 0])), null);
  // A scene with no clear subject (sky over hills) keeps the whole picture instead of a random piece of it.
  const scene = picture(120, 80, (x, y) =>
    y < 24 + 6 * Math.sin(x / 9) ? [90 + y, 150 + y, 230, 255] : [40, 110 + ((x * 7 + y * 3) % 30), 50, 255],
  );
  const whole = removeBackground(scene);
  assert.equal(at(whole, 0, 0)[3], 255);
  assert.equal(at(whole, 119, 79)[3], 255);
  assert.deepEqual(contentBox(whole), { x: 0, y: 0, width: 120, height: 80 });
  // A bust under a sky with a pink cloud that touches only the top edge and the head: the cloud goes with the sky.
  const bust = picture(120, 120, (x, y) => {
    const head = (x - 60) ** 2 + (y - 45) ** 2 < 28 ** 2,
      body = y > 70 && Math.abs(x - 60) < 40 + (y - 70) / 2,
      cloud = y < 18 && x > 64 && x < 100 + 4 * Math.sin(y);
    if (head) return [240, 170, 40, 255];
    if (body) return [30, 30, 60, 255];
    return cloud ? [230, 120, 200, 255] : [80, 110, 200 + (y % 7), 255];
  });
  const cutBust = removeBackground(bust);
  assert.deepEqual(
    [at(cutBust, 85, 5)[3], at(cutBust, 5, 5)[3], at(cutBust, 60, 45)[3], at(cutBust, 60, 110)[3]],
    [0, 0, 255, 255],
  );
});

test("autosprite: background the cut kept stuck to the subject goes, the subject stays", () => {
  // A cut that kept a pink cloud joined to the head and running off the top edge, plus a piece of the same cloud split
  // off on the head's other side.
  const shape = (x: number, y: number) =>
    (x - 55) ** 2 + (y - 50) ** 2 < 26 ** 2
      ? "head"
      : y > 72 && Math.abs(x - 55) < 38 + (y - 72) / 2
        ? "body"
        : (y < 30 && x > 62 && x < 110 && y > (x - 62) / 4 - 6) || (y > 20 && y < 28 && x > 14 && x < 46)
          ? "cloud"
          : "sky";
  const color = {
    head: [240, 170, 40, 255],
    body: [30, 30, 60, 255],
    cloud: [235, 150, 205, 255],
    sky: [80, 110, 210, 255],
  };
  const img = picture(120, 120, (x, y) => color[shape(x, y)]);
  const fg = new Uint8Array(120 * 120).map((_, p) => (shape(p % 120, Math.floor(p / 120)) === "sky" ? 0 : 1));
  dropEdgeLeak(fg, labOf(img), 120, 120);
  const kept = (x: number, y: number) => fg[y * 120 + x];
  assert.deepEqual(
    [kept(95, 3), kept(70, 20), kept(20, 24), kept(55, 50), kept(30, 50), kept(55, 110)],
    [0, 0, 0, 1, 1, 1],
  );
  // A subject that runs off the edge itself (a duck in ice) is left alone: taking the ice would take too much.
  const ice = picture(60, 60, (x, y) =>
    Math.abs(x - 30) < 10 && y > 10 && y < 30 ? [240, 170, 40, 255] : [235, 240, 250, 255],
  );
  const all = new Uint8Array(60 * 60).fill(1);
  dropEdgeLeak(all, labOf(ice), 60, 60);
  assert.ok(all.every((v) => v === 1));
});

test("spritify: shaded outline and pixel doubling", () => {
  // One red pixel: a dark red outline around it, corners clear (a rounder outline), then every pixel doubled.
  const red = picture(1, 1, () => [200, 0, 0, 255]);
  const dot = must(spritify(red, { removeBg: false }));
  assert.deepEqual([dot.width, dot.height], [6, 6]);
  assert.deepEqual(at(dot, 2, 2), [209, 0, 0, 255]);
  assert.deepEqual(at(dot, 2, 0), [47, 0, 0, 255]);
  assert.equal(at(dot, 0, 0)[3], 0);
  const px = picture(1, 1, () => [1, 2, 3, 255]);
  const big = enlarge(px, 2);
  assert.deepEqual([big.width, big.height], [2, 2]);
  assert.deepEqual(at(big, 1, 1), [1, 2, 3, 255]);
});

test("spritify: a photo becomes a small hard-edged sprite inside 128 px that the server accepts", () => {
  const sprite = must(spritify(ball()));
  assert.ok(sprite.width <= SPRITE_MAX && sprite.height <= SPRITE_MAX);
  assert.equal(sprite.height, (56 + 2) * 2);
  for (let i = 3; i < sprite.data.length; i += 4) assert.ok(sprite.data[i] === 0 || sprite.data[i] === 255);
  const colors = new Set();
  for (let i = 0; i < sprite.data.length; i += 4)
    if (sprite.data[i + 3]) colors.add(sprite.data.slice(i, i + 3).join());
  assert.ok(colors.size <= 15, String(colors.size));
  // A wide subject is limited by width.
  const wide = must(
    spritify(
      picture(400, 40, (x, y) => (y > 10 && y < 30 && x > 10 && x < 390 ? [0, 120, 0, 255] : [255, 255, 255, 255])),
    ),
  );
  assert.ok(wide.width <= SPRITE_MAX);
  // Nothing left after the background goes.
  assert.equal(spritify(picture(50, 50, () => [255, 255, 255, 255])), null);
  // The server side of the same sprite.
  const png = makePng(sprite.width, sprite.height, { pixel: (x, y) => at(sprite, x, y) });
  const ok = validateSprite({ label: "  My   Cat ", image: "data:image/png;base64," + b64(png) });
  assert.deepEqual([ok.label, ok.width, ok.height, ok.ai], ["My Cat", sprite.width, sprite.height, false]);
});

test("sprite checks: label, size and type; the AI input takes PNG or JPEG under 512 px", () => {
  assert.equal(validateSprite({ label: "", image: b64(makePng(8, 8)) }).reason, "invalid_label");
  assert.equal(validateSprite({ label: "a", image: "" }).reason, "invalid_image");
  assert.equal(validateSprite({ label: "a", image: b64(makePng(8, 129)) }).reason, "image_dimensions");
  assert.equal(
    validateSprite({ label: "a", image: "A".repeat(Math.ceil(SPRITE_LIMITS.maxBytes / 3) * 4 + 4) }).reason,
    "image_too_large",
  );
  // A minimal JPEG header: SOI, APP0, SOF0 with 300 x 200.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 200, 1, 44, 3, 0, 0, 0]);
  assert.deepEqual(jpegSize(jpeg), { width: 300, height: 200 });
  assert.equal(validateRedrawImage(b64(jpeg)).type, "image/jpeg");
  assert.equal(validateRedrawImage(b64(makePng(511, 20))).type, "image/png");
  assert.equal(validateRedrawImage(b64(makePng(512, 20))).reason, "image_dimensions");
  assert.equal(validateRedrawImage(b64(Buffer.from("GIF89a..."))).reason, "invalid_image");
  assert.equal(spriteDay(Date.UTC(2026, 9, 7, 23, 59)), "2026-10-07");
});
