// Minimal PNG decoder/encoder and image helpers on top of node:zlib, so the character build adds no dependency.
// Decodes non-interlaced PNGs (8/16-bit gray, gray+alpha, RGB, RGBA, 1-8-bit palette) to RGBA8.
import zlib from "node:zlib";

// An RGBA8 image: 4 bytes per pixel, rows top to bottom.
export type Image = { width: number; height: number; data: Buffer };
// A pixel rectangle inside an image.
export type Rect = { x: number; y: number; w: number; h: number };

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  // !: i < buf.length, and a value masked to 0..255 indexes the 256-entry table
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function decodePng(buf: Buffer): Image {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let p = 8,
    width = 0,
    height = 0,
    depth = 0,
    ctype = 0,
    interlace = 0,
    palette: Buffer | null = null,
    trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p),
      type = buf.toString("latin1", p + 4, p + 8),
      data = buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      // !: IHDR's body is 13 bytes (size, depth, colour type, compression, filter, interlace); same 2 lines below
      depth = data[8]!;
      ctype = data[9]!; // !: IHDR's body is 13 bytes
      interlace = data[12]!; // !: IHDR's body is 13 bytes
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (interlace) throw new Error("interlaced PNG is not supported");
  // as: the colour type comes from the file, so any number may look up the table and miss
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number | undefined>)[ctype];
  if (!channels) throw new Error("unsupported PNG colour type " + ctype);
  const bpp = Math.max(1, (channels * depth) >> 3); // bytes per pixel for filtering
  const stride = Math.ceil((width * channels * depth) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    // !: each of the height rows is a filter byte plus stride bytes, and the guards keep the left/up reads inside px
    // (this holds for the reads of raw and px in the next eight lines)
    const f = raw[y * (stride + 1)]!,
      src = y * (stride + 1) + 1,
      dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i]!; // !: src + i stays inside this row of raw
      const a = i >= bpp ? px[dst + i - bpp]! : 0, // !: the index is inside the rows decoded so far
        b = y ? px[dst - stride + i]! : 0, // !: the index is inside the rows decoded so far
        c = i >= bpp && y ? px[dst - stride + i - bpp]! : 0; // !: the index is inside the rows decoded so far
      let v: number;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) {
        const pp = a + b - c,
          pa = Math.abs(pp - a),
          pb = Math.abs(pp - b),
          pc = Math.abs(pp - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error("bad PNG filter " + f);
      px[dst + i] = v & 255;
    }
  }
  const out = Buffer.alloc(width * height * 4);
  const sample = (row: number, idx: number): number => {
    // idx-th sample of a row (high byte for 16-bit, raw value below 8-bit)
    // !: callers pass a sample index inside the row of stride bytes, so these reads stay inside px (three lines)
    if (depth === 8) return px[row + idx]!;
    if (depth === 16) return px[row + idx * 2]!; // !: idx is a sample inside the row
    const per = 8 / depth,
      byte = px[row + Math.floor(idx / per)]!, // !: idx is a sample inside the row
      shift = 8 - depth * ((idx % per) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (ctype === 6) {
        for (let k = 0; k < 4; k++) out[o + k] = sample(row, x * 4 + k);
      } else if (ctype === 2) {
        for (let k = 0; k < 3; k++) out[o + k] = sample(row, x * 3 + k);
        out[o + 3] = 255;
        if (trns && depth === 8 && out[o] === trns[1] && out[o + 1] === trns[3] && out[o + 2] === trns[5])
          out[o + 3] = 0;
      } else if (ctype === 3) {
        const i = sample(row, x);
        // !: colour type 3 requires a PLTE chunk and its indexes point inside it (the PNG spec); next two lines too
        out[o] = palette![i * 3]!;
        out[o + 1] = palette![i * 3 + 1]!; // !: type 3 has a PLTE holding index i
        out[o + 2] = palette![i * 3 + 2]!; // !: type 3 has a PLTE holding index i
        out[o + 3] = trns && i < trns.length ? trns[i]! : 255; // !: i < trns.length
      } else if (ctype === 4) {
        const g = sample(row, x * 2);
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = sample(row, x * 2 + 1);
      } else {
        let g = sample(row, x);
        if (depth < 8) g = Math.round((g * 255) / ((1 << depth) - 1));
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = 255;
      }
    }
  }
  return { width, height, data: out };
}

export function encodePng({ width, height, data }: Image): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type: string, body: Uint8Array): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
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

// Bounding box of pixels with alpha > threshold, or null when the image is empty.
export function alphaBounds({ width, height, data }: Image, threshold = 0): Rect | null {
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      // !: x < width and y < height, so the alpha byte is inside data
      if (data[(y * width + x) * 4 + 3]! > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function crop(img: Image, r: Rect): Image {
  const out = blank(r.w, r.h);
  for (let y = 0; y < r.h; y++)
    img.data.copy(out.data, y * r.w * 4, ((r.y + y) * img.width + r.x) * 4, ((r.y + y) * img.width + r.x + r.w) * 4);
  return out;
}

// Area-average resample (premultiplied alpha), used for downscaling; exact box filter, so no ringing and no halos.
export function resizeArea(img: Image, w: number, h: number): Image {
  const out = blank(w, h),
    sx = img.width / w,
    sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = y * sy,
      y1 = (y + 1) * sy;
    for (let x = 0; x < w; x++) {
      const x0 = x * sx,
        x1 = (x + 1) * sx;
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.min(img.height, Math.ceil(y1)); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.min(img.width, Math.ceil(x1)); xx++) {
          const wt = wy * (Math.min(xx + 1, x1) - Math.max(xx, x0)),
            i = (yy * img.width + xx) * 4,
            // !: the loops clamp xx and yy to the source size, so pixel i is inside img.data (four lines)
            al = img.data[i + 3]! / 255;
          r += img.data[i]! * al * wt; // !: pixel i is inside img.data
          g += img.data[i + 1]! * al * wt; // !: pixel i is inside img.data
          b += img.data[i + 2]! * al * wt; // !: pixel i is inside img.data
          a += al * wt;
          wsum += wt;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
        out.data[o + 3] = Math.round((a / wsum) * 255);
      }
    }
  }
  return out;
}

// Integer bilinear upscale (premultiplied alpha) for smooth vector-style art; edges stay soft instead of blocky.
export function resizeBilinear(img: Image, factor: number): Image {
  const w = img.width * factor,
    h = img.height * factor,
    out = blank(w, h);
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, Math.min(img.height - 1, (y + 0.5) / factor - 0.5)),
      y0 = Math.floor(fy),
      y1 = Math.min(img.height - 1, y0 + 1),
      ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, Math.min(img.width - 1, (x + 0.5) / factor - 0.5)),
        x0 = Math.floor(fx),
        x1 = Math.min(img.width - 1, x0 + 1),
        tx = fx - x0;
      const taps: [number, number, number][] = [
        [x0, y0, (1 - tx) * (1 - ty)],
        [x1, y0, tx * (1 - ty)],
        [x0, y1, (1 - tx) * ty],
        [x1, y1, tx * ty],
      ];
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (const [sx, sy, wt] of taps) {
        const i = (sy * img.width + sx) * 4,
          // !: the taps are clamped to the source size, so pixel i is inside img.data (four lines)
          al = (img.data[i + 3]! / 255) * wt;
        r += img.data[i]! * al; // !: pixel i is inside img.data
        g += img.data[i + 1]! * al; // !: pixel i is inside img.data
        b += img.data[i + 2]! * al; // !: pixel i is inside img.data
        a += al;
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
        out.data[o + 3] = Math.round(a * 255);
      }
    }
  }
  return out;
}

// Integer nearest-neighbour upscale for pixel art.
export function resizeNearest(img: Image, factor: number): Image {
  const w = img.width * factor,
    h = img.height * factor,
    out = blank(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / factor) * img.width + Math.floor(x / factor)) * 4;
      img.data.copy(out.data, (y * w + x) * 4, s, s + 4);
    }
  return out;
}

// Copies src into dst at (dx, dy), clipped. Cells start transparent and never overlap, so a plain copy is enough.
export function blit(dst: Image, src: Image, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      src.data.copy(dst.data, (ty * dst.width + tx) * 4, (y * src.width + x) * 4, (y * src.width + x) * 4 + 4);
    }
  }
}
