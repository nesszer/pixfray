// Minimal PNG decoder/encoder and image helpers on top of node:zlib, so the character build adds no dependency.
// Decodes what the pinned source archives hold: non-interlaced 8-bit RGB and RGBA, and 1-8-bit palette images.
import zlib from "node:zlib";

// An RGBA8 image: 4 bytes per pixel, rows top to bottom.
export type Image = { width: number; height: number; data: Buffer };
// A pixel rectangle inside an image.
export type Rect = { x: number; y: number; w: number; h: number };

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 2: 3, 3: 1, 6: 4 };

const CRC = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// The PNG row filters: each predicts a byte from its left (a), up (b) and up-left (c) neighbours.
const FILTERS = [
  () => 0,
  (a: number) => a,
  (_: number, b: number) => b,
  (a: number, b: number) => (a + b) >> 1,
  (a: number, b: number, c: number) => {
    const p = a + b - c;
    const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  },
];

export function decodePng(buf: Buffer): Image {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let ihdr: Buffer = Buffer.alloc(13),
    palette: Buffer = Buffer.alloc(0),
    trns: Buffer = Buffer.alloc(0);
  const idat: Buffer[] = [];
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p),
      type = buf.toString("latin1", p + 4, p + 8),
      data = buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === "IHDR") ihdr = data;
    else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  const [width, height] = [ihdr.readUInt32BE(0), ihdr.readUInt32BE(4)];
  const [depth, ctype, interlace] = [ihdr[8] ?? 0, ihdr[9] ?? 0, ihdr[12] ?? 0];
  const channels = CHANNELS[ctype];
  if (!channels || interlace || depth > 8 || (ctype !== 3 && depth !== 8))
    throw new Error(`unsupported PNG: colour type ${ctype}, depth ${depth}, interlace ${interlace}`);
  const bpp = Math.max(1, (channels * depth) >> 3); // bytes per pixel for filtering
  const stride = Math.ceil((width * channels * depth) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const src = y * (stride + 1) + 1,
      dst = y * stride,
      filter = FILTERS[raw[src - 1] ?? 0];
    if (!filter) throw new Error("bad PNG filter " + raw[src - 1]);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? (px[dst + i - bpp] ?? 0) : 0,
        b = y ? (px[dst - stride + i] ?? 0) : 0,
        c = i >= bpp && y ? (px[dst - stride + i - bpp] ?? 0) : 0;
      px[dst + i] = ((raw[src + i] ?? 0) + filter(a, b, c)) & 255;
    }
  }
  // The idx-th sample of a row: the byte itself at depth 8, the packed bits below it.
  const sample = (row: number, idx: number): number => {
    if (depth === 8) return px[row + idx] ?? 0;
    const per = 8 / depth;
    return ((px[row + Math.floor(idx / per)] ?? 0) >> (8 - depth * ((idx % per) + 1))) & ((1 << depth) - 1);
  };
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (ctype === 3) {
        const i = sample(y * stride, x);
        palette.copy(out, o, i * 3, i * 3 + 3);
        out[o + 3] = trns[i] ?? 255;
      } else {
        for (let k = 0; k < channels; k++) out[o + k] = sample(y * stride, x * channels + k);
        if (channels === 3) out[o + 3] = 255;
      }
    }
  return { width, height, data: out };
}

export function encodePng({ width, height, data }: Image): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const chunk = (type: string, body: Uint8Array): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 8, 6, 0, 0, 0]); // 8-bit RGBA
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([
    SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const blank = (width: number, height: number): Image => ({
  width,
  height,
  data: Buffer.alloc(width * height * 4),
});

// Bounding box of the pixels that aren't fully transparent, or null when the image is empty.
export function alphaBounds({ width, height, data }: Image): Rect | null {
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3]) {
        [x0, x1] = [Math.min(x0, x), Math.max(x1, x)];
        [y0, y1] = [Math.min(y0, y), Math.max(y1, y)];
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function crop(img: Image, r: Rect): Image {
  const out = blank(r.w, r.h);
  for (let y = 0; y < r.h; y++)
    img.data.copy(out.data, y * r.w * 4, ((r.y + y) * img.width + r.x) * 4, ((r.y + y) * img.width + r.x + r.w) * 4);
  return out;
}

// Writes pixel o of out as the premultiplied-alpha average of the source taps [x, y, weight]; the weights sum to wsum.
function mix(img: Image, out: Image, o: number, taps: [number, number, number][], wsum: number): void {
  let [r, g, b, a] = [0, 0, 0, 0];
  for (const [x, y, wt] of taps) {
    const i = (y * img.width + x) * 4,
      al = (img.data[i + 3] ?? 0) / 255;
    r += (img.data[i] ?? 0) * al * wt;
    g += (img.data[i + 1] ?? 0) * al * wt;
    b += (img.data[i + 2] ?? 0) * al * wt;
    a += al * wt;
  }
  if (a > 0) out.data.set([r / a, g / a, b / a, (a / wsum) * 255].map(Math.round), o);
}

// Area-average resample, used for downscaling; exact box filter, so no ringing and no halos.
export function resizeArea(img: Image, w: number, h: number): Image {
  const out = blank(w, h),
    sx = img.width / w,
    sy = img.height / h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [x0, x1, y0, y1] = [x * sx, (x + 1) * sx, y * sy, (y + 1) * sy];
      const taps: [number, number, number][] = [];
      for (let yy = Math.floor(y0); yy < Math.min(img.height, Math.ceil(y1)); yy++)
        for (let xx = Math.floor(x0); xx < Math.min(img.width, Math.ceil(x1)); xx++)
          taps.push([xx, yy, (Math.min(yy + 1, y1) - Math.max(yy, y0)) * (Math.min(xx + 1, x1) - Math.max(xx, x0))]);
      mix(
        img,
        out,
        (y * w + x) * 4,
        taps,
        taps.reduce((sum, [, , wt]) => sum + wt, 0),
      );
    }
  return out;
}

// Integer bilinear upscale for smooth vector-style art; edges stay soft instead of blocky.
export function resizeBilinear(img: Image, factor: number): Image {
  const out = blank(img.width * factor, img.height * factor);
  // The two source pixels around output pixel v along one axis, and how far v sits towards the second.
  const axis = (v: number, size: number): [number, number, number] => {
    const f = Math.max(0, Math.min(size - 1, (v + 0.5) / factor - 0.5));
    return [Math.floor(f), Math.min(size - 1, Math.floor(f) + 1), f - Math.floor(f)];
  };
  for (let y = 0; y < out.height; y++) {
    const [y0, y1, ty] = axis(y, img.height);
    for (let x = 0; x < out.width; x++) {
      const [x0, x1, tx] = axis(x, img.width);
      const taps: [number, number, number][] = [
        [x0, y0, (1 - tx) * (1 - ty)],
        [x1, y0, tx * (1 - ty)],
        [x0, y1, (1 - tx) * ty],
        [x1, y1, tx * ty],
      ];
      mix(img, out, (y * out.width + x) * 4, taps, 1);
    }
  }
  return out;
}

// Integer nearest-neighbour upscale for pixel art.
export function resizeNearest(img: Image, factor: number): Image {
  const out = blank(img.width * factor, img.height * factor);
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const s = (Math.floor(y / factor) * img.width + Math.floor(x / factor)) * 4;
      img.data.copy(out.data, (y * out.width + x) * 4, s, s + 4);
    }
  return out;
}

// Copies src into dst at (dx, dy), clipped. Cells start transparent and never overlap, so a plain copy is enough.
export function blit(dst: Image, src: Image, dx: number, dy: number): void {
  for (let y = Math.max(0, -dy); y < Math.min(src.height, dst.height - dy); y++) {
    const x0 = Math.max(0, -dx),
      x1 = Math.min(src.width, dst.width - dx);
    if (x1 > x0)
      src.data.copy(dst.data, ((dy + y) * dst.width + dx + x0) * 4, (y * src.width + x0) * 4, (y * src.width + x1) * 4);
  }
}
