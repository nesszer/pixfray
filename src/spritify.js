// Turns any picture into a PixFray sprite in the browser: cut out the subject, shrink it to fighter size, cut the
// colors to a small palette, add a dark outline and double the pixels. The result is a PNG of at most 128x128 that
// server/sprites.js accepts. The steps work on plain {width, height, data} images, so tests run them without a DOM.
export const SPRITE_MAX = 128;
export const SOURCE_MAX = 512;       // pictures are decoded at most this size before any step
export const REDRAW_MAX = 504;       // the AI model takes images under 512 px a side
export const FILE_MAX = 10 * 1024 * 1024;
export const OUTLINE = [24, 18, 30];

const image = (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) });
const dist2 = (d, i, r, g, b) => (d[i] - r) ** 2 + (d[i + 1] - g) ** 2 + (d[i + 2] - b) ** 2;

// The largest size within max x max that keeps the aspect ratio (never enlarges).
export function fitSize(width, height, max) {
  const k = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

// True when the picture already has a cut-out (enough see-through pixels on its border).
export function hasCutout(img) {
  const { width: w, height: h, data: d } = img;
  let clear = 0, n = 0;
  const at = (x, y) => { n++; if (d[(y * w + x) * 4 + 3] < 128) clear++; };
  for (let x = 0; x < w; x++) { at(x, 0); at(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { at(0, y); at(w - 1, y); }
  return clear / n > 0.3;
}

// Clears the background: the border's main colors (each on at least 15% of the border) are the background, and a
// flood fill from the border clears every connected pixel close to one of them. tolerance is a color distance
// (0-441). Pictures that already have a cut-out keep theirs.
export function removeBackground(img, tolerance = 40) {
  if (hasCutout(img)) return img;
  const { width: w, height: h, data: src } = img, d = new Uint8ClampedArray(src), t2 = tolerance * tolerance;
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
  const ring = { width: border.length, height: 1, data: new Uint8ClampedArray(border.length * 4) };
  border.forEach((p, k) => { ring.data.set(src.subarray(p * 4, p * 4 + 3), k * 4); ring.data[k * 4 + 3] = 255; });
  const pal = palette(ring, 4), share = pal.map(() => 0);
  const nearest = (i, data) => { let best = -1, bd = t2; pal.forEach((c, k) => { const v = dist2(data, i, c[0], c[1], c[2]); if (v <= bd) { bd = v; best = k; } }); return best; };
  for (let k = 0; k < border.length; k++) { const n = nearest(k * 4, ring.data); if (n >= 0) share[n]++; }
  const keep = new Set(pal.map((_, k) => k).filter((k) => share[k] >= border.length * 0.15));
  const background = (i) => src[i + 3] < 128 || keep.has(nearest(i, src));
  const seen = new Uint8Array(w * h), queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  const push = (p) => { if (!seen[p]) { seen[p] = 1; queue[tail++] = p; } };
  for (const p of border) push(p);
  while (head < tail) {
    const p = queue[head++], i = p * 4;
    if (!background(i)) continue;   // the subject's edge
    d[i + 3] = 0;
    const x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < w * (h - 1)) push(p + w);
  }
  return { width: w, height: h, data: d };
}

// The smallest box around the solid pixels, or null when there are none.
export function contentBox(img, alphaMin = 128) {
  const { width: w, height: h, data: d } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] >= alphaMin) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

export function crop(img, box) {
  const out = image(box.width, box.height);
  for (let y = 0; y < box.height; y++) {
    const from = ((box.y + y) * img.width + box.x) * 4;
    out.data.set(img.data.subarray(from, from + box.width * 4), y * box.width * 4);
  }
  return out;
}

// Area-average shrink to width x height. Colors are weighted by alpha so edges don't pick up the cleared background;
// alpha ends up fully on or off (sprites have hard edges).
export function shrink(img, width, height) {
  const out = image(width, height), sx = img.width / width, sy = img.height / height, d = img.data;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    const ya = Math.floor(y * sy), yb = Math.max(ya + 1, Math.floor((y + 1) * sy)), xa = Math.floor(x * sx), xb = Math.max(xa + 1, Math.floor((x + 1) * sx));
    for (let yy = ya; yy < yb && yy < img.height; yy++) for (let xx = xa; xx < xb && xx < img.width; xx++) {
      const i = (yy * img.width + xx) * 4, w = d[i + 3];
      r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; a += w; n++;
    }
    const o = (y * width + x) * 4;
    if (a / n >= 110) { out.data[o] = r / a; out.data[o + 1] = g / a; out.data[o + 2] = b / a; out.data[o + 3] = 255; }
  }
  return out;
}

// Median cut: a palette of at most `colors` from the solid pixels.
export function palette(img, colors) {
  const d = img.data, px = [];
  for (let i = 0; i < d.length; i += 4) if (d[i + 3]) px.push([d[i], d[i + 1], d[i + 2]]);
  if (!px.length) return [];
  const boxes = [px];
  while (boxes.length < colors) {
    let best = -1, bestRange = 0, bestCh = 0;
    boxes.forEach((box, k) => {
      if (box.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const p of box) { if (p[c] < lo) lo = p[c]; if (p[c] > hi) hi = p[c]; }
        if (hi - lo > bestRange) { bestRange = hi - lo; best = k; bestCh = c; }
      }
    });
    if (best < 0 || bestRange < 6) break;   // what's left is one color already
    const box = boxes[best].sort((a, b) => a[bestCh] - b[bestCh]), mid = box.length >> 1;
    boxes.splice(best, 1, box.slice(0, mid), box.slice(mid));
  }
  return boxes.map((box) => [0, 1, 2].map((c) => Math.round(box.reduce((s, p) => s + p[c], 0) / box.length)));
}

export function quantize(img, colors) {
  const pal = palette(img, colors), out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }, d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    let best = pal[0], bd = Infinity;
    for (const p of pal) { const v = dist2(d, i, p[0], p[1], p[2]); if (v < bd) { bd = v; best = p; } }
    d[i] = best[0]; d[i + 1] = best[1]; d[i + 2] = best[2];
  }
  return out;
}

// One pixel of dark outline around the solid pixels (the image grows by 1 on each side).
export function outline(img, color = OUTLINE) {
  const w = img.width + 2, h = img.height + 2, out = image(w, h), solid = (x, y) => x >= 0 && y >= 0 && x < img.width && y < img.height && img.data[(y * img.width + x) * 4 + 3] > 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (solid(x - 1, y - 1)) { out.data.set(img.data.subarray(((y - 1) * img.width + x - 1) * 4, ((y - 1) * img.width + x) * 4), o); continue; }
    if (solid(x - 2, y - 1) || solid(x, y - 1) || solid(x - 1, y - 2) || solid(x - 1, y)) { out.data[o] = color[0]; out.data[o + 1] = color[1]; out.data[o + 2] = color[2]; out.data[o + 3] = 255; }
  }
  return out;
}

export function enlarge(img, k) {
  if (k === 1) return img;
  const out = image(img.width * k, img.height * k);
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const i = (((y / k) | 0) * img.width + ((x / k) | 0)) * 4;
    out.data.set(img.data.subarray(i, i + 4), (y * out.width + x) * 4);
  }
  return out;
}

// The whole recipe. height = the subject's height in sprite pixels before doubling (the overlay scales sprites to the
// same bulk anyway). Returns null when nothing is left after the background goes.
export function spritify(img, { removeBg = true, tolerance = 40, height = 56, colors = 14, edge = true } = {}) {
  const cut = removeBg ? removeBackground(img, tolerance) : img;
  const box = contentBox(cut);
  if (!box) return null;
  const subject = crop(cut, box), pad = edge ? 2 : 0, room = SPRITE_MAX / 2 - pad;
  const k = Math.min(height / subject.height, room / subject.width, room / subject.height, 1);
  const small = shrink(subject, Math.max(1, Math.round(subject.width * k)), Math.max(1, Math.round(subject.height * k)));
  if (!contentBox(small)) return null;
  const done = edge ? outline(quantize(small, colors)) : quantize(small, colors);
  return enlarge(done, 2);
}

// ---- browser only below ----

// A File -> ImageData no bigger than max x max. Throws Error with a viewer-facing message.
export async function decodeFile(file, max = SOURCE_MAX) {
  if (!file?.type?.startsWith("image/")) throw new Error("Choose a picture file (PNG, JPEG, WebP or GIF).");
  if (file.size > FILE_MAX) throw new Error("That picture is over 10 MB. Choose a smaller one.");
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error("That picture couldn't be opened. Try a PNG or JPEG."); }
  return drawBitmap(bitmap, max);
}
export async function decodeBase64(b64, max = SOURCE_MAX) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return drawBitmap(await createImageBitmap(new Blob([bytes])), max);
}
function drawBitmap(bitmap, max) {
  const { width, height } = fitSize(bitmap.width, bitmap.height, max);
  const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return ctx.getImageData(0, 0, width, height);
}

// An image -> base64 PNG, or JPEG for the AI's input (smaller upload; flattened onto white).
export async function encode(img, type = "image/png") {
  const canvas = new OffscreenCanvas(img.width, img.height), ctx = canvas.getContext("2d");
  if (type === "image/jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, img.width, img.height); }
  const tmp = new OffscreenCanvas(img.width, img.height);
  tmp.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  ctx.drawImage(tmp, 0, 0);
  const blob = await canvas.convertToBlob({ type, quality: 0.9 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Draws a sprite onto a visible canvas at whole-pixel scale, centered and standing on the bottom edge.
export function paint(canvas, img) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!img) return;
  const k = Math.max(1, Math.floor(Math.min(canvas.width / img.width, canvas.height / img.height)));
  const tmp = new OffscreenCanvas(img.width, img.height);
  tmp.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, Math.round((canvas.width - img.width * k) / 2), canvas.height - img.height * k, img.width * k, img.height * k);
}
