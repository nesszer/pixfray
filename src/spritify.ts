// Turns any picture into a PixFray sprite in the browser, with no AI: find the subject (src/autosprite.ts), shrink it
// to fighter size with a small Oklab palette, add a dark outline in a shade of the colors it borders and double the
// pixels. The result is a PNG of at most 128x128 that server/sprites.ts accepts. The steps work on plain {width, height, data} images, so tests run them without a DOM.
import { subjectMask, labOf, kmeans, d3, toRgb } from "./autosprite.ts";

export const SPRITE_MAX = 128;
export const SOURCE_MAX = 512; // pictures are decoded at most this size before any step
export const REDRAW_MAX = 504; // the AI model takes images under 512 px a side
export const FILE_MAX = 10 * 1024 * 1024;
/** A plain RGBA image in ImageData's shape (4 bytes a pixel), so tests run the steps without a DOM. */
export type Img = { width: number; height: number; data: Uint8ClampedArray };
/** A rectangle inside an image, in pixels. */
export type Box = { x: number; y: number; width: number; height: number };

const image = (width: number, height: number): Img => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4),
});

// The largest size within max x max that keeps the aspect ratio (never enlarges).
export function fitSize(width: number, height: number, max: number) {
  const k = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

// True when the picture already has a cut-out (enough see-through pixels on its border).
export function hasCutout(img: Img) {
  const { width: w, height: h, data: d } = img;
  let clear = 0,
    n = 0;
  const at = (x: number, y: number) => {
    n++;
    if (d[(y * w + x) * 4 + 3]! < 128) clear++; // in range: x and y are on the border
  };
  for (let x = 0; x < w; x++) {
    at(x, 0);
    at(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    at(0, y);
    at(w - 1, y);
  }
  return clear / n > 0.3;
}

// Clears the background: the subject finder in src/autosprite.ts decides what is subject, and everything else turns
// see-through. A scene with no clear subject keeps the whole picture, and a picture that already has a cut-out keeps
// its own.
export function removeBackground(img: Img) {
  if (hasCutout(img)) return img;
  const { mask } = subjectMask(img),
    d = new Uint8ClampedArray(img.data);
  for (let p = 0; p < mask.length; p++) if (!mask[p]) d[p * 4 + 3] = 0;
  return { width: img.width, height: img.height, data: d };
}

// The smallest box around the solid pixels, or null when there are none.
export function contentBox(img: Img, alphaMin = 128): Box | null {
  const { width: w, height: h, data: d } = img;
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      // in range: x and y are inside the image
      if (d[(y * w + x) * 4 + 3]! >= alphaMin) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

export function enlarge(img: Img, k: number) {
  if (k === 1) return img;
  const out = image(img.width * k, img.height * k);
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const i = (((y / k) | 0) * img.width + ((x / k) | 0)) * 4;
      out.data.set(img.data.subarray(i, i + 4), (y * out.width + x) * 4);
    }
  return out;
}

// The most common value in a non-empty list.
function mode(v: number[]) {
  const seen = new Map<number, number>();
  let best = v[0]!, // the callers pass at least one value
    bc = 0;
  for (const x of v) {
    const c = (seen.get(x) ?? 0) + 1;
    seen.set(x, c);
    if (c > bc) {
      bc = c;
      best = x;
    }
  }
  return best;
}

// The whole recipe. height = the subject's height in sprite pixels before doubling (the overlay scales sprites to the
// same bulk anyway). Returns null when nothing is left after the background goes. Every `!` below reads a typed array
// or list at an index its loop or bounds check keeps in range.
export function spritify(
  img: Img,
  {
    removeBg = true,
    height = 56,
    colors = 14,
    edge = true,
  }: { removeBg?: boolean; height?: number; colors?: number; edge?: boolean } = {},
) {
  const cut = removeBg ? removeBackground(img) : img;
  const box = contentBox(cut);
  if (!box) return null;
  const W = cut.width,
    solid = (p: number) => cut.data[p * 4 + 3]! >= 128,
    pad = edge ? 2 : 0,
    room = SPRITE_MAX / 2 - pad,
    k = Math.min(height / box.height, room / box.width, room / box.height, 1),
    ow = Math.max(1, Math.round(box.width * k)),
    oh = Math.max(1, Math.round(box.height * k)),
    x1 = box.x + box.width - 1,
    y1 = box.y + box.height - 1;

  // palette: k-means in Oklab over the subject's colors, binned to 5 bits a channel so it stays quick
  const lab = labOf(cut),
    binW = new Float32Array(32768),
    binSum = new Float64Array(32768 * 3);
  for (let y = box.y; y <= y1; y++)
    for (let x = box.x; x <= x1; x++) {
      const p = y * W + x,
        i = p * 4;
      if (!solid(p)) continue;
      const b = ((cut.data[i]! >> 3) << 10) | ((cut.data[i + 1]! >> 3) << 5) | (cut.data[i + 2]! >> 3);
      binW[b]!++;
      for (let j = 0; j < 3; j++) binSum[b * 3 + j]! += lab[p * 3 + j]!;
    }
  const used: number[] = [];
  for (let b = 0; b < 32768; b++) if (binW[b]) used.push(b);
  const pts = new Float32Array(used.length * 3),
    wts = new Float32Array(used.length);
  used.forEach((b, i) => {
    wts[i] = binW[b]!;
    for (let j = 0; j < 3; j++) pts[i * 3 + j] = binSum[b * 3 + j]! / binW[b]!;
  });
  const { centers } = kmeans(pts, wts, colors),
    K = centers.length / 3;
  // a little more chroma: pixel art palettes read brighter than photos
  for (let c = 0; c < K; c++) {
    centers[c * 3 + 1]! *= 1.12;
    centers[c * 3 + 2]! *= 1.12;
  }
  const nearest = (p: number) => {
    let bk = 0,
      bd = Infinity;
    for (let c = 0; c < K; c++) {
      const v = d3(lab, p * 3, centers, c * 3);
      if (v < bd) {
        bd = v;
        bk = c;
      }
    }
    return bk;
  };

  // each sprite cell at least 45% covered takes the palette color with the most pixels, boosted when its lightness
  // stands out from the cell's (thin dark lines and bright eyes survive the shrink)
  const cells = new Int32Array(ow * oh).fill(-1),
    sx = box.width / ow,
    sy = box.height / oh,
    cnt = new Float64Array(K);
  for (let y = 0; y < oh; y++)
    for (let x = 0; x < ow; x++) {
      cnt.fill(0);
      let cover = 0,
        tot = 0,
        Lsum = 0;
      const ya = box.y + Math.floor(y * sy),
        yb = box.y + Math.max(Math.floor(y * sy) + 1, Math.floor((y + 1) * sy)),
        xa = box.x + Math.floor(x * sx),
        xb = box.x + Math.max(Math.floor(x * sx) + 1, Math.floor((x + 1) * sx));
      for (let yy = ya; yy < yb && yy <= y1; yy++)
        for (let xx = xa; xx < xb && xx <= x1; xx++) {
          const p = yy * W + xx;
          tot++;
          if (!solid(p)) continue;
          cover++;
          cnt[nearest(p)]!++;
          Lsum += lab[p * 3]!;
        }
      if (!tot || cover / tot < 0.45) continue;
      const Lm = Lsum / cover;
      let bk = 0,
        bs = -1;
      for (let c = 0; c < K; c++) {
        const v = cnt[c]! * (1 + 4 * Math.abs(centers[c * 3]! - Lm));
        if (v > bs) {
          bs = v;
          bk = c;
        }
      }
      cells[y * ow + x] = bk;
    }

  // cleanup: drop lone pixels, fill pinholes, and give a pixel unlike every neighbor their color unless its
  // lightness stands out (eyes, highlights)
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= ow || y >= oh ? -1 : cells[y * ow + x]!);
  const fixed = Int32Array.from(cells);
  for (let y = 0; y < oh; y++)
    for (let x = 0; x < ow; x++) {
      const c = at(x, y),
        nb = [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)],
        solidN = nb.filter((v) => v >= 0).length;
      if (c >= 0 && solidN <= 1 && ow * oh > 1) fixed[y * ow + x] = -1;
      else if (c < 0 && solidN >= 3) fixed[y * ow + x] = mode(nb.filter((v) => v >= 0));
      else if (c >= 0) {
        const ring = [...nb, at(x - 1, y - 1), at(x + 1, y - 1), at(x - 1, y + 1), at(x + 1, y + 1)].filter(
          (v) => v >= 0,
        );
        if (!ring.length || ring.includes(c)) continue;
        const m = mode(ring);
        if (Math.abs(centers[c * 3]! - centers[m * 3]!) < 0.18) fixed[y * ow + x] = m;
      }
    }
  if (!fixed.some((c) => c >= 0)) return null;

  // draw, with a one-pixel outline in a dark shade of the colors it borders (corners stay clear: a rounder outline)
  const p0 = pad / 2,
    OW = ow + pad,
    OH = oh + pad,
    out = image(OW, OH),
    rgb = [...Array(K).keys()].map((c) => toRgb(centers[c * 3]!, centers[c * 3 + 1]!, centers[c * 3 + 2]!)),
    get = (x: number, y: number) => (x < 0 || y < 0 || x >= ow || y >= oh ? -1 : fixed[y * ow + x]!);
  for (let y = 0; y < OH; y++)
    for (let x = 0; x < OW; x++) {
      const o = (y * OW + x) * 4,
        cx = x - p0,
        cy = y - p0,
        c = get(cx, cy);
      if (c >= 0) {
        out.data.set(rgb[c]!, o);
        out.data[o + 3] = 255;
        continue;
      }
      if (!edge) continue;
      const nb = [get(cx - 1, cy), get(cx + 1, cy), get(cx, cy - 1), get(cx, cy + 1)].filter((v) => v >= 0);
      if (!nb.length) continue;
      let L = 0,
        a = 0,
        b = 0;
      for (const v of nb) {
        L += centers[v * 3]!;
        a += centers[v * 3 + 1]!;
        b += centers[v * 3 + 2]!;
      }
      out.data.set(toRgb(Math.min(0.22, (L / nb.length) * 0.3), (a / nb.length) * 0.5, (b / nb.length) * 0.5), o);
      out.data[o + 3] = 255;
    }
  return enlarge(out, 2);
}

// ---- browser only below ----

// A File -> ImageData no bigger than max x max. Throws Error with a viewer-facing message.
export async function decodeFile(file: File | null | undefined, max = SOURCE_MAX) {
  if (!file?.type?.startsWith("image/")) throw new Error("Choose a picture file (PNG, JPEG, WebP or GIF).");
  if (file.size > FILE_MAX) throw new Error("That picture is over 10 MB. Choose a smaller one.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That picture couldn't be opened. Try a PNG or JPEG.");
  }
  return drawBitmap(bitmap, max);
}
export async function decodeBase64(b64: string, max = SOURCE_MAX) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return drawBitmap(await createImageBitmap(new Blob([bytes])), max);
}
function drawBitmap(bitmap: ImageBitmap, max: number) {
  const { width, height } = fitSize(bitmap.width, bitmap.height, max);
  const canvas = new OffscreenCanvas(width, height),
    ctx = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D; // a new canvas always has a 2D context
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return ctx.getImageData(0, 0, width, height);
}

// An image -> base64 PNG, or JPEG for the AI's input (smaller upload; flattened onto white).
export async function encode(img: Img, type = "image/png") {
  const canvas = new OffscreenCanvas(img.width, img.height),
    ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D; // a new canvas always has a 2D context
  if (type === "image/jpeg") {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, img.width, img.height);
  }
  const tmp = new OffscreenCanvas(img.width, img.height);
  // as: a new canvas always has a 2D context
  (tmp.getContext("2d") as OffscreenCanvasRenderingContext2D).putImageData(
    new ImageData(new Uint8ClampedArray(img.data), img.width, img.height),
    0,
    0,
  );
  ctx.drawImage(tmp, 0, 0);
  const blob = await canvas.convertToBlob({ type, quality: 0.9 });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Draws a sprite onto a visible canvas at whole-pixel scale, centered and standing on the bottom edge.
export function paint(canvas: HTMLCanvasElement, img: Img | null | undefined) {
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D; // a canvas only drawn in 2D always has one
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!img) return;
  const k = Math.max(1, Math.floor(Math.min(canvas.width / img.width, canvas.height / img.height)));
  const tmp = new OffscreenCanvas(img.width, img.height);
  // as: a new canvas always has a 2D context
  (tmp.getContext("2d") as OffscreenCanvasRenderingContext2D).putImageData(
    new ImageData(new Uint8ClampedArray(img.data), img.width, img.height),
    0,
    0,
  );
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    tmp,
    Math.round((canvas.width - img.width * k) / 2),
    canvas.height - img.height * k,
    img.width * k,
    img.height * k,
  );
}
