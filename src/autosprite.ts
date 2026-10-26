// Finds the subject of a picture with no AI and no input from the viewer, for src/spritify.ts. On a copy at most
// SEG_MAX a side: the border's colors that sit on the top or both sides are the background, a geodesic distance
// through color change plus the color distance to that background gives a first guess, a bust's body is widened
// below the head, and a graph cut with color models (GrabCut style) refines it. A scene with no clear subject keeps
// the whole picture. Every `!` in this file reads a typed array or list at an index its loop or bounds check keeps
// in range.
import type { Img } from "./spritify.ts";

const SEG_MAX = 160;
// dropEdgeLeak: Lab distance to the edge colors, the share of max(w, h) that counts, the shortest edge run, the most
// of the subject it may take, the share of a split-off patch that must border the background
const LEAK_TAU = 0.06,
  LEAK_MIN = 0.05,
  LEAK_RUN = 3,
  LEAK_MAX = 0.35,
  LEAK_RIM = 0.3;

// ---------- color: Oklab, so distances match what the eye sees ----------
const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function toLab(r: number, g: number, b: number): [number, number, number] {
  const R = lin(r),
    G = lin(g),
    B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B),
    m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B),
    s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
export function toRgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const c = (v: number) => Math.round(Math.min(255, Math.max(0, gam(v))));
  return [
    c(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    c(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    c(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}
// Each pixel's Oklab color, 3 floats a pixel.
export function labOf(img: Img) {
  const n = img.width * img.height,
    out = new Float32Array(n * 3),
    d = img.data;
  for (let p = 0; p < n; p++) out.set(toLab(d[p * 4]!, d[p * 4 + 1]!, d[p * 4 + 2]!), p * 3);
  return out;
}
// Distance between the colors at x[i..i+2] and y[j..j+2].
export const d3 = (x: ArrayLike<number>, i: number, y: ArrayLike<number>, j: number) =>
  Math.hypot(x[i]! - y[j]!, x[i + 1]! - y[j + 1]!, x[i + 2]! - y[j + 2]!);

// k-means on weighted Lab points with deterministic k-means++ seeding (the same picture always gives the same result).
export function kmeans(pts: Float32Array, wts: Float32Array, k: number, iters = 12) {
  const n = wts.length;
  if (!n) return { centers: [] as number[], label: new Int32Array(0) };
  let first = 0;
  for (let i = 1; i < n; i++) if (wts[i]! > wts[first]!) first = i;
  const centers: number[] = [...pts.subarray(first * 3, first * 3 + 3)];
  const near = new Float32Array(n).fill(Infinity);
  while (centers.length < k * 3) {
    const c = centers.length - 3;
    let best = -1,
      bv = 0;
    for (let i = 0; i < n; i++) {
      near[i] = Math.min(near[i]!, d3(pts, i * 3, centers, c) ** 2);
      if (near[i]! * wts[i]! > bv) {
        bv = near[i]! * wts[i]!;
        best = i;
      }
    }
    if (best < 0 || bv < 1e-7) break;
    centers.push(...pts.subarray(best * 3, best * 3 + 3));
  }
  const K = centers.length / 3,
    label = new Int32Array(n);
  for (let it = 0; it < iters; it++) {
    const sum = new Float64Array(K * 4);
    for (let i = 0; i < n; i++) {
      let bk = 0,
        bd = Infinity;
      for (let c = 0; c < K; c++) {
        const v = d3(pts, i * 3, centers, c * 3);
        if (v < bd) {
          bd = v;
          bk = c;
        }
      }
      label[i] = bk;
      const w = wts[i]!;
      for (let j = 0; j < 3; j++) sum[bk * 4 + j]! += pts[i * 3 + j]! * w;
      sum[bk * 4 + 3]! += w;
    }
    for (let c = 0; c < K; c++)
      if (sum[c * 4 + 3]! > 0) for (let j = 0; j < 3; j++) centers[c * 3 + j] = sum[c * 4 + j]! / sum[c * 4 + 3]!;
  }
  return { centers, label };
}

// Area-average resize (used to shrink only).
function resize(img: Img, width: number, height: number): Img {
  const out = new Uint8ClampedArray(width * height * 4),
    sx = img.width / width,
    sy = img.height / height,
    d = img.data;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const acc = [0, 0, 0, 0];
      let n = 0;
      const ya = Math.floor(y * sy),
        yb = Math.max(ya + 1, Math.floor((y + 1) * sy)),
        xa = Math.floor(x * sx),
        xb = Math.max(xa + 1, Math.floor((x + 1) * sx));
      for (let yy = ya; yy < yb && yy < img.height; yy++)
        for (let xx = xa; xx < xb && xx < img.width; xx++) {
          const i = (yy * img.width + xx) * 4;
          for (let c = 0; c < 4; c++) acc[c]! += d[i + c]!;
          n++;
        }
      for (let c = 0; c < 4; c++) out[(y * width + x) * 4 + c] = acc[c]! / n;
    }
  return { width, height, data: out };
}

// Max flow (Dinic) on edge lists. run() returns BFS levels: level >= 0 is the source side of the minimum cut.
class Flow {
  head: Int32Array;
  to: number[] = [];
  next: number[] = [];
  cap: number[] = [];
  readonly n: number;
  constructor(n: number) {
    this.n = n;
    this.head = new Int32Array(n).fill(-1);
  }
  add(u: number, v: number, c: number, rc = 0) {
    this.to.push(v, u);
    this.cap.push(c, rc);
    this.next.push(this.head[u]!, this.head[v]!);
    this.head[u] = this.to.length - 2;
    this.head[v] = this.to.length - 1;
  }
  run(s: number, t: number) {
    const { n, to, next, cap, head } = this,
      level = new Int32Array(n),
      it = new Int32Array(n),
      q = new Int32Array(n);
    const bfs = () => {
      level.fill(-1);
      level[s] = 0;
      let h = 0,
        tl = 0;
      q[tl++] = s;
      while (h < tl) {
        const u = q[h++]!;
        for (let e = head[u]!; e >= 0; e = next[e]!)
          if (cap[e]! > 1e-9 && level[to[e]!]! < 0) {
            level[to[e]!] = level[u]! + 1;
            q[tl++] = to[e]!;
          }
      }
      return level[t]! >= 0;
    };
    // an iterative DFS, so a large grid can't overflow the stack
    const stack = new Int32Array(n),
      via = new Int32Array(n);
    const dfs = () => {
      let pushed = 0;
      for (;;) {
        let sp = 0,
          found = false;
        stack[0] = s;
        while (sp >= 0) {
          const u = stack[sp]!;
          if (u === t) {
            found = true;
            break;
          }
          let e = it[u]!;
          for (; e >= 0; e = next[e]!) if (cap[e]! > 1e-9 && level[to[e]!] === level[u]! + 1) break;
          it[u] = e;
          if (e < 0) {
            level[u] = -1; // a dead end
            sp--;
            if (sp >= 0) it[stack[sp]!] = next[it[stack[sp]!]!]!;
            continue;
          }
          via[sp] = e;
          stack[++sp] = to[e]!;
        }
        if (!found) return pushed;
        let f = Infinity;
        for (let i = 0; i < sp; i++) f = Math.min(f, cap[via[i]!]!);
        for (let i = 0; i < sp; i++) {
          cap[via[i]!]! -= f;
          cap[via[i]! ^ 1]! += f;
        }
        pushed += f;
      }
    };
    while (bfs()) {
      it.set(head);
      if (!dfs()) break;
    }
    bfs();
    return level;
  }
}

// Otsu's threshold for values in 0-1.
function otsu(v: Float32Array) {
  const bins = 64,
    hist = new Float64Array(bins);
  for (const x of v) hist[Math.min(bins - 1, Math.floor(x * bins))]!++;
  const total = v.length;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i]!;
  let wb = 0,
    sb = 0,
    best = 0,
    bt = 0.5;
  for (let i = 0; i < bins; i++) {
    wb += hist[i]!;
    if (!wb || wb === total) continue;
    sb += i * hist[i]!;
    const between = wb * (total - wb) * (sb / wb - (sum - sb) / (total - wb)) ** 2;
    if (between > best) {
      best = between;
      bt = (i + 1) / bins;
    }
  }
  return bt;
}

// A mixture of round Gaussians in Lab fitted to the picked pixels, as a -log likelihood function.
function colorModel(lab: Float32Array, pick: (p: number) => boolean, n: number, k = 5) {
  const idx: number[] = [];
  for (let p = 0; p < n; p++) if (pick(p)) idx.push(p);
  const pts = new Float32Array(idx.length * 3);
  idx.forEach((p, i) => pts.set(lab.subarray(p * 3, p * 3 + 3), i * 3));
  const { centers, label } = kmeans(pts, new Float32Array(idx.length).fill(1), k, 6);
  const K = centers.length / 3,
    cnt = new Float64Array(K),
    v = new Float64Array(K);
  label.forEach((c, i) => {
    cnt[c]!++;
    v[c]! += d3(pts, i * 3, centers, c * 3) ** 2;
  });
  const comps = [...Array(K).keys()]
    .filter((c) => cnt[c]! > 0)
    .map((c) => ({ c, pi: cnt[c]! / idx.length, s2: Math.max(4e-4, v[c]! / cnt[c]! / 3) }));
  return (p: number) => {
    let like = 1e-12;
    for (const { c, pi, s2 } of comps)
      like += (pi / (2 * Math.PI * s2) ** 1.5) * Math.exp(-(d3(lab, p * 3, centers, c * 3) ** 2) / (2 * s2));
    return -Math.log(like);
  };
}

// The 4-connected pieces of mask === value: an id per pixel (-1 elsewhere), and each piece's size, box and whether it
// touches the image's edge.
function components(mask: Uint8Array, w: number, h: number, value: number) {
  const id = new Int32Array(w * h).fill(-1),
    sizes: number[] = [],
    boxes: [number, number, number, number][] = [],
    edge: boolean[] = [],
    q = new Int32Array(w * h);
  for (let p0 = 0; p0 < w * h; p0++) {
    if (mask[p0] !== value || id[p0]! >= 0) continue;
    const c = sizes.length;
    let hd = 0,
      tl = 0,
      x0 = w,
      y0 = h,
      x1 = 0,
      y1 = 0,
      touches = false;
    q[tl++] = p0;
    id[p0] = c;
    while (hd < tl) {
      const p = q[hd++]!,
        x = p % w,
        y = (p / w) | 0;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      if (!x || !y || x === w - 1 || y === h - 1) touches = true;
      for (const r of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1])
        if (r >= 0 && mask[r] === value && id[r]! < 0) {
          id[r] = c;
          q[tl++] = r;
        }
    }
    sizes.push(tl);
    boxes.push([x0, y0, x1, y1]);
    edge.push(touches);
  }
  return { id, sizes, boxes, edge };
}

// Keeps the biggest piece and the pieces inside its box (an emote sheet gives one emote, not four).
function keepMain(fg: Uint8Array, w: number, h: number) {
  const fc = components(fg, w, h, 1);
  if (!fc.sizes.length) return;
  const big = fc.sizes.indexOf(Math.max(...fc.sizes)),
    [bx0, by0, bx1, by1] = fc.boxes[big]!;
  const keep = fc.sizes.map((s, c) => {
    const [x0, y0, x1, y1] = fc.boxes[c]!;
    return c === big || (s >= 0.02 * fc.sizes[big]! && x1 > bx0 && x0 < bx1 && y1 > by0 && y0 < by1);
  });
  for (let p = 0; p < w * h; p++) fg[p] = fc.id[p]! >= 0 && keep[fc.id[p]!] ? 1 : 0;
}

// Morphological opening (erode, then dilate) with a square of radius r: cuts thin streaks off the subject.
function open(m: Uint8Array, w: number, h: number, r: number) {
  const pass = (src: Uint8Array, keep: 0 | 1) => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let v = keep;
        for (let dy = -r; dy <= r && v === keep; dy++)
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx,
              yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h && src[yy * w + xx] !== keep) {
              v = keep ? 0 : 1;
              break;
            }
          }
        out[y * w + x] = v;
      }
    return out;
  };
  return pass(pass(m, 1), 0);
}

// A w x h 0/1 mask scaled bilinearly to W x H, then cut at one half.
function upsample(m: Uint8Array, w: number, h: number, W: number, H: number) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = Math.min(h - 1, Math.max(0, ((y + 0.5) * h) / H - 0.5)),
      y0 = Math.floor(fy),
      y1 = Math.min(h - 1, y0 + 1),
      ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(w - 1, Math.max(0, ((x + 0.5) * w) / W - 0.5)),
        x0 = Math.floor(fx),
        x1 = Math.min(w - 1, x0 + 1),
        tx = fx - x0;
      const v =
        (m[y0 * w + x0]! * (1 - tx) + m[y0 * w + x1]! * tx) * (1 - ty) +
        (m[y1 * w + x0]! * (1 - tx) + m[y1 * w + x1]! * tx) * ty;
      out[y * W + x] = v >= 0.5 ? 1 : 0;
    }
  }
  return out;
}

// A binary heap of pixel ids ordered by key[p].
function heapOf(key: Float32Array) {
  const heap: number[] = [];
  const swap = (i: number, j: number) => ([heap[i], heap[j]] = [heap[j]!, heap[i]!]);
  return {
    get size() {
      return heap.length;
    },
    push(p: number) {
      heap.push(p);
      for (let i = heap.length - 1; i > 0;) {
        const j = (i - 1) >> 1;
        if (key[heap[j]!]! <= key[heap[i]!]!) break;
        swap(i, j);
        i = j;
      }
    },
    pop() {
      const top = heap[0]!,
        last = heap.pop()!;
      if (!heap.length) return top;
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < heap.length && key[heap[l]!]! < key[heap[m]!]!) m = l;
        if (r < heap.length && key[heap[r]!]! < key[heap[m]!]!) m = r;
        if (m === i) break;
        swap(i, m);
        i = m;
      }
      return top;
    },
  };
}

/** The subject at the image's own size (1 = subject, 0 = background). whole: no clear subject, so all of it. */
type Subject = { mask: Uint8Array; whole: boolean };

export function subjectMask(img: Img): Subject {
  const k0 = Math.min(1, SEG_MAX / Math.max(img.width, img.height)),
    w = Math.max(8, Math.round(img.width * k0)),
    h = Math.max(8, Math.round(img.height * k0)),
    small = resize(img, w, h),
    n = w * h,
    lab = labOf(small),
    up = (m: Uint8Array) => upsample(m, w, h, img.width, img.height);
  const border: number[] = [],
    side: number[] = []; // 0 top, 1 bottom, 2 left, 3 right
  for (let x = 0; x < w; x++) {
    border.push(x, (h - 1) * w + x);
    side.push(0, 1);
  }
  for (let y = 1; y < h - 1; y++) {
    border.push(y * w, y * w + w - 1);
    side.push(2, 3);
  }

  // background colors: border clusters on the top edge that also reach a side, fill half the top or stay off the
  // bottom edge, or on both side edges without filling the bottom edge (a bust's body fills the bottom and its
  // corners, the sky or wall behind it fills the top)
  const bpts = new Float32Array(border.length * 3);
  border.forEach((p, i) => bpts.set(lab.subarray(p * 3, p * 3 + 3), i * 3));
  const { centers: bc, label: bl } = kmeans(bpts, new Float32Array(border.length).fill(1), 8);
  const K = bc.length / 3,
    share = new Float64Array(K),
    sideHits = [...Array(K)].map(() => new Float64Array(4)),
    sideLen = [w, w, h - 2, h - 2];
  bl.forEach((c, i) => {
    share[c]!++;
    sideHits[c]![side[i]!]!++;
  });
  const hits = (c: number, s: number) => sideHits[c]![s]! / sideLen[s]!;
  const bg = [...Array(K).keys()].filter(
    (c) =>
      (hits(c, 0) >= 0.05 && (hits(c, 2) >= 0.08 || hits(c, 3) >= 0.08 || hits(c, 0) >= 0.5 || hits(c, 1) < 0.05)) ||
      (hits(c, 2) >= 0.08 && hits(c, 3) >= 0.08 && hits(c, 1) < 0.5),
  );
  if (!bg.length) bg.push([...Array(K).keys()].sort((a, b) => share[b]! - share[a]!)[0]!);
  const bgSet = new Set(bg);

  // geodesic distance from the background's part of the border, through color change. The bottom edge and the low
  // sides are where a bust is cut off, so they seed only in a color that also fills the top edge (sky over water).
  const geo = new Float32Array(n).fill(Infinity),
    heap = heapOf(geo),
    seed = new Uint8Array(n);
  border.forEach((p, i) => {
    const c = bl[i]!,
      low = side[i] === 1 || p >= 0.6 * h * w;
    if (bgSet.has(c) && (!low || hits(c, 0) >= 0.2)) {
      seed[p] = 1;
      geo[p] = 0;
      heap.push(p);
    }
  });
  const done = new Uint8Array(n);
  while (heap.size) {
    const p = heap.pop();
    if (done[p]) continue;
    done[p] = 1;
    const x = p % w;
    for (const r of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
      if (r < 0 || r >= n || done[r]) continue;
      const g = geo[p]! + d3(lab, p * 3, lab, r * 3) + 0.002;
      if (g < geo[r]!) {
        geo[r] = g;
        heap.push(r);
      }
    }
  }
  // the color distance to the nearest background color
  const con = new Float32Array(n);
  for (let p = 0; p < n; p++) con[p] = Math.min(...bg.map((c) => d3(lab, p * 3, bc, c * 3)));
  const norm = (v: Float32Array) => {
    const hi = [...v].sort((a, b) => a - b)[Math.floor(v.length * 0.98)]! || 1;
    return v.map((x) => Math.min(1, x / hi));
  };
  const gN = norm(geo),
    cN = norm(con),
    sal = new Float32Array(n);
  for (let p = 0; p < n; p++) sal[p] = 0.55 * gN[p]! + 0.45 * cN[p]!;
  const t = otsu(sal),
    sal0 = sal.slice();

  // nothing differs from the background in color: a blank picture has no subject at all, and a scene whose every
  // color is background (sky over a field) keeps the whole picture
  if (Math.max(...con) < 0.03) {
    let spread = 0;
    for (let p = 0; p < n; p++) spread = Math.max(spread, d3(lab, p * 3, bc, bg[0]! * 3));
    const blank = spread < 0.03;
    return { mask: new Uint8Array(img.width * img.height).fill(blank ? 0 : 1), whole: !blank };
  }
  let mean = 0;
  for (const v of sal0) mean += v / n;
  let tv = 0;
  for (const v of sal0) tv += (v - mean) ** 2;
  if (tv < 1e-9) return { mask: new Uint8Array(img.width * img.height).fill(1), whole: true };

  // body prior: when the first guess reaches the bottom edge near its middle (a bust), the body widens below the
  // head and runs to the bottom even where it matches the background's color
  {
    const g0 = new Uint8Array(n);
    for (let p = 0; p < n; p++) g0[p] = sal[p]! > t ? 1 : 0;
    keepMain(g0, w, h);
    let x0 = w,
      x1 = -1,
      y0 = h,
      bottom = 0,
      bx = 0;
    for (let p = 0; p < n; p++)
      if (g0[p]) {
        const x = p % w,
          y = (p / w) | 0;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        if (y === h - 1) {
          bottom++;
          bx += x;
        }
      }
    bx /= Math.max(1, bottom);
    const span = x1 - x0;
    if (bottom >= 0.04 * w && span > 0 && bx > x0 + 0.25 * span && bx < x1 - 0.25 * span) {
      // the head row: where the first guess is widest
      const rowW = new Float32Array(h);
      for (let p = 0; p < n; p++) if (g0[p]) rowW[(p / w) | 0]!++;
      let headY = y0,
        best = 0;
      for (let y = y0; y < h * 0.85; y++)
        if (rowW[y]! > best) {
          best = rowW[y]!;
          headY = y;
        }
      const cx = (x0 + x1) / 2,
        half = span / 2;
      if (headY < 0.6 * h)
        for (let p = (headY + 1) * w; p < n; p++) {
          const x = p % w,
            y = (p / w) | 0,
            reach = half * (0.7 + (0.6 * (y - headY)) / Math.max(1, h - 1 - headY));
          if (Math.abs(x - cx) < reach) sal[p] = Math.max(sal[p]!, t + 0.25 * (1 - Math.abs(x - cx) / reach));
        }
    }
  }

  // graph cut, refitting the color models a few times
  let fg = new Uint8Array(n);
  for (let p = 0; p < n; p++) fg[p] = sal[p]! > t ? 1 : 0;
  const right = (p: number) => d3(lab, p * 3, lab, p * 3 + 3) ** 2,
    below = (p: number) => d3(lab, p * 3, lab, (p + w) * 3) ** 2;
  let beta = 0,
    pairs = 0;
  for (let p = 0; p < n; p++) {
    if (p % w < w - 1) {
      beta += right(p);
      pairs++;
    }
    if (p + w < n) {
      beta += below(p);
      pairs++;
    }
  }
  beta = 1 / (2 * Math.max(1e-6, beta / pairs));
  const gamma = 6;
  for (let round = 0; round < 3; round++) {
    const cur = fg;
    if (cur.every((v) => v) || !cur.some((v) => v)) break;
    const Ufg = colorModel(lab, (p) => cur[p] === 1, n),
      Ubg = colorModel(lab, (p) => cur[p] === 0, n);
    const g = new Flow(n + 2),
      S = n,
      T = n + 1;
    for (let p = 0; p < n; p++) {
      // saliency keeps the cut from flipping whole regions the colors alone can't tell apart
      const prior = 2.5 * (sal[p]! - t),
        cf = Ufg(p) - prior,
        cb = Ubg(p) + prior;
      if (seed[p]) g.add(p, T, 1e9);
      else if (cb > cf) g.add(S, p, cb - cf);
      else g.add(p, T, cf - cb);
      if (p % w < w - 1) {
        const v = gamma * Math.exp(-beta * right(p));
        g.add(p, p + 1, v, v);
      }
      if (p + w < n) {
        const v = gamma * Math.exp(-beta * below(p));
        g.add(p, p + w, v, v);
      }
    }
    const level = g.run(S, T);
    fg = Uint8Array.from(level.subarray(0, n), (v) => (v >= 0 ? 1 : 0));
  }

  // cut thin streaks (cloud wisps, light rays) loose so keepMain drops them, then fill small holes
  fg = open(fg, w, h, Math.max(1, Math.round(Math.min(w, h) / 80)));
  keepMain(fg, w, h);

  const area = fg.reduce((s, v) => s + v, 0),
    holes = components(fg, w, h, 0);
  for (let p = 0; p < n; p++) {
    const c = holes.id[p]!;
    if (c >= 0 && !holes.edge[c] && holes.sizes[c]! < 0.06 * area) fg[p] = 1;
  }

  // nothing sensible found (a scene with no subject): keep the whole picture. Signs: tiny or near-total cover, a cut
  // running along the top edge, rows in the upper 60% cut edge to edge (a horizon), or a weak split of the saliency
  // (Otsu's between-class share of its variance)
  let cover = 0,
    top = 0,
    m1 = 0,
    c1 = 0,
    wide = 0;
  for (let p = 0; p < n; p++) {
    cover += fg[p]!;
    if (p < w) top += fg[p]!;
    if (sal0[p]! > t) {
      m1 += sal0[p]!;
      c1++;
    }
  }
  const m0 = (mean * n - m1) / Math.max(1, n - c1);
  m1 /= Math.max(1, c1);
  const sep = (c1 * (n - c1) * (m1 - m0) ** 2) / n / tv;
  for (let y = 0; y < 0.6 * h; y++) if (fg[y * w] && fg[y * w + w - 1]) wide++;
  cover /= n;
  const whole = cover < 0.04 || cover > 0.65 || top > 0.25 * w || wide > 0.09 * h || sep < 0.68;
  if (whole) return { mask: new Uint8Array(img.width * img.height).fill(1), whole };
  dropEdgeLeak(fg, lab, w, h);
  return { mask: up(fg), whole };
}

// Background the cut kept stuck to the subject (a cloud touching the head). Foreground running along the top edge
// or a side's upper part is background, so grow from those runs through pixels close to their colors; the subject's
// own colors stop the growth. A bust is cut off at the bottom, so that edge never seeds. Patches of the same color
// that the subject splits off (cloud on both sides of a head) go too when they sit no lower and are thin enough that
// much of them borders the background. Skipped when it would take a big share of the subject (the subject itself
// runs off the edge, like ice around a swimming duck).
export function dropEdgeLeak(fg: Uint8Array, lab: Float32Array, w: number, h: number) {
  const n = w * h,
    side = [...Array(Math.ceil(0.6 * h)).keys()].map((y) => y * w),
    edge: number[] = [];
  for (const line of [[...Array(w).keys()], side, side.map((p) => p + w - 1)])
    for (let i = 0; i < line.length;) {
      let j = i;
      while (j < line.length && fg[line[j]!]) j++;
      if (j - i >= LEAK_RUN) edge.push(...line.slice(i, j));
      i = j + 1;
    }
  if (edge.length < LEAK_MIN * Math.max(w, h)) return;
  const near = (p: number) => edge.some((q) => d3(lab, p * 3, lab, q * 3) < LEAK_TAU),
    around = (p: number) =>
      [p % w ? p - 1 : -1, p % w < w - 1 ? p + 1 : -1, p - w, p + w].filter((r) => r >= 0 && r < n),
    leak = new Uint8Array(n),
    todo = [...edge];
  for (const p of edge) leak[p] = 1;
  let low = 0;
  while (todo.length) {
    const p = todo.pop()!; // the loop runs while todo has items
    low = Math.max(low, Math.floor(p / w));
    for (const r of around(p))
      if (fg[r] && !leak[r] && near(r)) {
        leak[r] = 1;
        todo.push(r);
      }
  }
  const { id, sizes, boxes } = components(
      fg.map((v, p) => (v && !leak[p] && near(p) ? 1 : 0)),
      w,
      h,
      1,
    ),
    rim = sizes.map(() => 0);
  for (let p = 0; p < n; p++) if (id[p]! >= 0 && around(p).some((r) => !fg[r])) rim[id[p]!]!++;
  for (let p = 0; p < n; p++) {
    const c = id[p]!;
    if (c >= 0 && sizes[c]! >= LEAK_MIN * Math.max(w, h) && boxes[c]![3] <= low && rim[c]! >= LEAK_RIM * sizes[c]!)
      leak[p] = 1;
  }
  const area = (m: Uint8Array) => m.reduce((s, v) => s + v, 0),
    kept = fg.map((v, p) => (leak[p] ? 0 : v));
  keepMain(kept, w, h);
  if (area(kept) >= (1 - LEAK_MAX) * area(fg)) fg.set(kept);
}
