// Hats: original pixel art drawn in code (no image files), shared by the overlay and the dashboard preview.
// The list of hats and their unlocks lives in server/upgrades.js; ids here must match it.
// Each hat is a grid ('.' = empty, letters = colors). span = the grid columns that cover the head's width;
// sink = how many grid rows the hat comes down over the top of the head (negative floats above it).
// Grids face right like the character sprites; the overlay mirrors both together.
const HATS = {
  cap: {
    span: [1, 13], sink: 2,
    colors: { R: "#d63b3b", D: "#9e2424", W: "#ffffff" },
    rows: [
      "....RRRRR.....",
      "..RRRRRRRRR...",
      ".RRRRWRRRRRR..",
      ".RRRRRRRRRRR..",
      ".DDDDDDDDDDDDD",
    ],
  },
  bandana: {
    span: [2, 14], sink: 4,
    colors: { K: "#2f6fd6", W: "#ffffff" },
    rows: [
      "..KKKKKKKKKKKK",
      "KKKWKKKWKKKWKK",
      "K.K...........",
    ],
  },
  beanie: {
    span: [0, 12], sink: 3,
    colors: { G: "#2e9e5b", L: "#1f7a43", P: "#f1f1f1" },
    rows: [
      ".....PP.....",
      "....PPPP....",
      "...GGGGGG...",
      "..GGGGGGGG..",
      ".GGGGGGGGGG.",
      "GLGLGLGLGLGL",
    ],
  },
  wizard: {
    span: [2, 14], sink: 2,
    colors: { N: "#3157b8", B: "#22408a", Y: "#f5d142" },
    rows: [
      ".......N........",
      "......NNN.......",
      "......NYN.......",
      ".....NNNNN......",
      ".....NNNNN......",
      "....NNNNYNN.....",
      "....NNNNNNN.....",
      "...NNYNNNNNN....",
      "...NNNNNNNNN....",
      "..NNNNNNNNNNN...",
      "BBBBBBBBBBBBBBBB",
    ],
  },
  tophat: {
    span: [1, 11], sink: 2,
    colors: { K: "#1d1d22", H: "#4a4a55", R: "#c0392b" },
    rows: [
      "..HKKKKKKK..",
      "..HKKKKKKK..",
      "..HKKKKKKK..",
      "..HKKKKKKK..",
      "..RRRRRRRR..",
      "KKKKKKKKKKKK",
    ],
  },
  horns: {
    span: [1, 11], sink: 2,
    colors: { W: "#e8e0cc", K: "#6b5b45" },
    rows: [
      "K..........K",
      "KW........WK",
      ".WW......WW.",
      "..WW....WW..",
    ],
  },
  halo: {
    span: [1, 11], sink: -2,
    colors: { Y: "#ffd84a" },
    rows: [
      "..YYYYYYYY..",
      "YY........YY",
      "..YYYYYYYY..",
    ],
  },
  crown: {
    span: [0, 11], sink: 2,
    colors: { Y: "#f2c230", R: "#d63b3b", B: "#3b82d6" },
    rows: [
      "Y....Y....Y",
      "YY..YYY..YY",
      "YYYYYYYYYYY",
      "YRYYYBYYYRY",
      "YYYYYYYYYYY",
    ],
  },
};

// Where the head is in one frame, as fractions of the frame: the top opaque row, and the widest opaque
// row in the top fifth of the figure. Measured once per frame; images the page can't read get a guess.
const heads = new WeakMap();
function headOf(image, frame) {
  let byFrame = heads.get(image);
  if (!byFrame) heads.set(image, (byFrame = new Map()));
  const key = frame.x + "," + frame.y + "," + frame.w + "," + frame.h;
  if (byFrame.has(key)) return byFrame.get(key);
  let head = { top: 0, left: 0.25, right: 0.75 };
  try {
    const c = document.createElement("canvas");
    c.width = frame.w; c.height = frame.h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
    const data = g.getImageData(0, 0, frame.w, frame.h).data;
    const solid = (x, y) => data[(y * frame.w + x) * 4 + 3] > 40;
    let top = -1, bottom = -1;
    for (let y = 0; y < frame.h && top < 0; y++) for (let x = 0; x < frame.w; x++) if (solid(x, y)) { top = y; break; }
    for (let y = frame.h - 1; y >= 0 && bottom < 0; y--) for (let x = 0; x < frame.w; x++) if (solid(x, y)) { bottom = y; break; }
    if (top >= 0) {
      let left = frame.w, right = -1;
      const last = top + Math.max(2, Math.round((bottom - top) * 0.2));
      for (let y = top; y <= last; y++) for (let x = 0; x < frame.w; x++) if (solid(x, y)) { left = Math.min(left, x); right = Math.max(right, x + 1); }
      if (right > left) head = { top: top / frame.h, left: left / frame.w, right: right / frame.w };
    }
  } catch { /* cross-origin image: keep the guess */ }
  byFrame.set(key, head);
  return head;
}

// A catalog entry may say where the head is ({top, left, right} as fractions of the cell) when the top of the figure
// isn't the head, like the turtle's shell.
const validHead = (h) => h && ["top", "left", "right"].every((k) => Number.isFinite(h[k]) && h[k] >= 0 && h[k] <= 1) && h.right > h.left;

// Draws hat `id` on a sprite frame drawn at (dx, dy, dw, dh) in the current transform. Unknown ids draw nothing.
export function drawHat(ctx, id, image, frame, dx, dy, dw, dh, headHint = null) {
  const hat = HATS[id];
  if (!hat || !image || !frame) return;
  const head = validHead(headHint) ? headHint : headOf(image, frame);
  const px = (head.right - head.left) * dw / (hat.span[1] - hat.span[0]);
  const x0 = dx + head.left * dw - hat.span[0] * px;
  const y0 = dy + head.top * dh + hat.sink * px - hat.rows.length * px;
  ctx.save();
  hat.rows.forEach((row, r) => {
    // One rect per run of a color; a slight overlap hides seams between cells.
    for (let c = 0; c < row.length;) {
      const ch = row[c];
      let end = c + 1;
      while (end < row.length && row[end] === ch) end++;
      if (ch !== ".") {
        ctx.fillStyle = hat.colors[ch];
        ctx.fillRect(x0 + c * px, y0 + r * px, (end - c) * px + 0.4, px + 0.4);
      }
      c = end;
    }
  });
  ctx.restore();
}
