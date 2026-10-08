// The browser's picture-to-sprite steps (src/spritify.js) on plain images, and the server checks they must pass.
import test from "node:test";
import assert from "node:assert/strict";
import {
  fitSize,
  hasCutout,
  removeBackground,
  contentBox,
  palette,
  quantize,
  outline,
  enlarge,
  spritify,
  SPRITE_MAX,
  OUTLINE,
} from "../src/spritify.js";
import { validateSprite, validateRedrawImage, jpegSize, spriteDay, SPRITE_LIMITS } from "../server/sprites.js";
import { makePng, b64 } from "./upload-helpers.mjs";

// A w x h picture: `pixel(x, y)` gives [r, g, b, a].
function picture(w, h, pixel) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(pixel(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}
const at = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
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
  assert.deepEqual(contentBox(cut), { x: 91, y: 41, width: 119, height: 119 });
  // A picture that is already cut out is left alone.
  const png = picture(20, 20, (x, y) => (x > 5 && x < 15 ? [0, 0, 0, 255] : [255, 255, 255, 0]));
  assert.equal(hasCutout(png), true);
  assert.equal(removeBackground(png), png);
  // A subject touching the border keeps its body: only the border's main colors are background.
  const tall = picture(100, 100, (x, y) => (x > 40 && x < 60 ? [200, 20, 20, 255] : [255, 255, 255, 255]));
  const kept = removeBackground(tall);
  assert.equal(at(kept, 50, 0)[3], 255);
  assert.equal(at(kept, 10, 50)[3], 0);
  assert.equal(contentBox(picture(4, 4, () => [0, 0, 0, 0])), null);
});

test("spritify: palette, outline and pixel doubling", () => {
  const stripes = picture(16, 4, (x) => [x * 16, 255 - x * 16, 0, 255]);
  assert.ok(palette(stripes, 4).length <= 4);
  const q = quantize(stripes, 4),
    colors = new Set();
  for (let i = 0; i < q.data.length; i += 4) colors.add(q.data.slice(i, i + 3).join());
  assert.ok(colors.size <= 4);
  const dot = picture(1, 1, () => [200, 0, 0, 255]),
    ring = outline(dot);
  assert.deepEqual([ring.width, ring.height], [3, 3]);
  assert.deepEqual(at(ring, 1, 1), [200, 0, 0, 255]);
  assert.deepEqual(at(ring, 1, 0), [...OUTLINE, 255]);
  assert.equal(at(ring, 0, 0)[3], 0); // corners stay clear: a rounder outline
  const big = enlarge(ring, 2);
  assert.deepEqual([big.width, big.height], [6, 6]);
  assert.deepEqual(at(big, 3, 3), [200, 0, 0, 255]);
});

test("spritify: a photo becomes a small hard-edged sprite inside 128 px that the server accepts", () => {
  const sprite = spritify(ball());
  assert.ok(sprite.width <= SPRITE_MAX && sprite.height <= SPRITE_MAX);
  assert.equal(sprite.height, (56 + 2) * 2);
  for (let i = 3; i < sprite.data.length; i += 4) assert.ok(sprite.data[i] === 0 || sprite.data[i] === 255);
  const colors = new Set();
  for (let i = 0; i < sprite.data.length; i += 4)
    if (sprite.data[i + 3]) colors.add(sprite.data.slice(i, i + 3).join());
  assert.ok(colors.size <= 15, colors.size);
  // A wide subject is limited by width.
  const wide = spritify(
    picture(400, 40, (x, y) => (y > 10 && y < 30 && x > 10 && x < 390 ? [0, 120, 0, 255] : [255, 255, 255, 255])),
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
