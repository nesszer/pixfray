// Canvas helpers shared by the pixel-art modules (hats, pets, cosmetics) and the overlay.
/** A sprite frame's cell in its image, in pixels. */
export type Frame = { x: number; y: number; w: number; h: number };
type Box = { left: number; right: number; top: number; bottom: number };

// A 2D context on a new offscreen canvas, or null where the page has none.
export function blank(w: number, h: number, willReadFrequently = false) {
  const canvas =
    typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(w, h)
      : typeof document === "object"
        ? Object.assign(document.createElement("canvas"), { width: w, height: h })
        : null;
  return canvas?.getContext("2d", { willReadFrequently }) || null;
}

// A copy of `frame` of `image` at w x h with a canvas filter baked in. Drawing with ctx.filter set costs a filter pass
// over the whole stage canvas per sprite: a crowd of 50 recolored fighters ran at about 1 fps.
export function filtered(image: CanvasImageSource, frame: Frame, filter: string, w = frame.w, h = frame.h) {
  const g = blank(w, h);
  if (!g) return null;
  g.filter = filter;
  g.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, w, h);
  return g.canvas;
}

// A memo per source object: get(source, key, make) runs make once per pair. Weak, so images that leave free it.
export function perSource<T>() {
  const all = new WeakMap<object, Map<string, T>>();
  return (source: object, key: string, make: () => T): T => {
    let byKey = all.get(source);
    if (!byKey) all.set(source, (byKey = new Map()));
    if (!byKey.has(key)) byKey.set(key, make());
    return byKey.get(key) as T; // as: set on the line above
  };
}
export const frameKey = (f: Frame) => f.x + "," + f.y + "," + f.w + "," + f.h;

// The box of the opaque pixels of `frame` (inclusive, in frame pixels), over rows y0..y1 only when given; null when
// none are opaque or the image can't be read (cross-origin).
export function opaqueBox(image: CanvasImageSource, frame: Frame, y0 = 0, y1 = frame.h - 1): Box | null {
  try {
    const g = blank(frame.w, frame.h, true)!; // a null context throws on the next line and the catch answers null
    g.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
    const data = g.getImageData(0, 0, frame.w, frame.h).data;
    let box: Box | null = null;
    for (let y = y0; y <= y1; y++)
      for (let x = 0; x < frame.w; x++)
        // x, y lie inside the frame, so the index is inside the pixel data
        if (data[(y * frame.w + x) * 4 + 3]! > 40)
          box = box
            ? { left: Math.min(box.left, x), right: Math.max(box.right, x), top: box.top, bottom: y }
            : { left: x, right: x, top: y, bottom: y };
    return box;
  } catch {
    return null;
  }
}

// Paints a pixel-art grid ('.' = empty, letters = keys of colors) with its top left at (x0, y0), px per cell: one rect
// per run of a color, each `seam` px wider and taller to hide the seams between cells.
export function drawGrid(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  rows: readonly string[],
  colors: Record<string, string>,
  x0: number,
  y0: number,
  px: number,
  seam = 0.4,
) {
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length;) {
      const ch = row[c]!; // c < row.length
      let end = c + 1;
      while (end < row.length && row[end] === ch) end++;
      if (ch !== ".") {
        ctx.fillStyle = colors[ch]!; // every letter in a grid has a color
        ctx.fillRect(x0 + c * px, y0 + r * px, (end - c) * px + seam, px + seam);
      }
      c = end;
    }
  });
}
