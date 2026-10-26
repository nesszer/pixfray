// Hats: original pixel art drawn in code (no image files), shared by the overlay and the dashboard preview.
// The list of hats and their unlocks lives in server/upgrades.ts; ids here must match it.
// Each hat is a grid ('.' = empty, letters = colors). span = the grid columns that cover the head's width;
// sink = how many grid rows the hat comes down over the top of the head (negative floats above it).
// Grids face right like the character sprites; the overlay mirrors both together.
import { drawGrid, frameKey, opaqueBox, perSource } from "./pixels.ts";
import type { Frame } from "./pixels.ts";
type Hat = { span: [number, number]; sink: number; colors: Record<string, string>; rows: string[] };
/** Where the head is in a frame, as fractions of it. */
export type Head = { top: number; left: number; right: number };

const HATS: Record<string, Hat> = {
  cap: {
    span: [1, 13],
    sink: 2,
    colors: { R: "#d63b3b", D: "#9e2424", W: "#ffffff" },
    rows: ["....RRRRR.....", "..RRRRRRRRR...", ".RRRRWRRRRRR..", ".RRRRRRRRRRR..", ".DDDDDDDDDDDDD"],
  },
  bandana: {
    span: [2, 14],
    sink: 4,
    colors: { K: "#2f6fd6", W: "#ffffff" },
    rows: ["..KKKKKKKKKKKK", "KKKWKKKWKKKWKK", "K.K..........."],
  },
  beanie: {
    span: [0, 12],
    sink: 3,
    colors: { G: "#2e9e5b", L: "#1f7a43", P: "#f1f1f1" },
    rows: [".....PP.....", "....PPPP....", "...GGGGGG...", "..GGGGGGGG..", ".GGGGGGGGGG.", "GLGLGLGLGLGL"],
  },
  wizard: {
    span: [2, 14],
    sink: 2,
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
    span: [1, 11],
    sink: 2,
    colors: { K: "#1d1d22", H: "#4a4a55", R: "#c0392b" },
    rows: ["..HKKKKKKK..", "..HKKKKKKK..", "..HKKKKKKK..", "..HKKKKKKK..", "..RRRRRRRR..", "KKKKKKKKKKKK"],
  },
  horns: {
    span: [1, 11],
    sink: 2,
    colors: { W: "#e8e0cc", K: "#6b5b45" },
    rows: ["K..........K", "KW........WK", ".WW......WW.", "..WW....WW.."],
  },
  halo: {
    span: [1, 11],
    sink: -2,
    colors: { Y: "#ffd84a" },
    rows: ["..YYYYYYYY..", "YY........YY", "..YYYYYYYY.."],
  },
  crown: {
    span: [0, 11],
    sink: 2,
    colors: { Y: "#f2c230", R: "#d63b3b", B: "#3b82d6" },
    rows: ["Y....Y....Y", "YY..YYY..YY", "YYYYYYYYYYY", "YRYYYBYYYRY", "YYYYYYYYYYY"],
  },
};

// Where the head is in one frame, as fractions of the frame: the top opaque row, and the widest opaque
// row in the top fifth of the figure. Measured once per frame; images the page can't read get a guess.
const heads = perSource<Head>();
const headOf = (image: CanvasImageSource, frame: Frame) =>
  heads(image, frameKey(frame), () => {
    const body = opaqueBox(image, frame);
    const band =
      body &&
      opaqueBox(
        image,
        frame,
        body.top,
        Math.min(frame.h - 1, body.top + Math.max(2, Math.round((body.bottom - body.top) * 0.2))),
      );
    return band
      ? { top: body.top / frame.h, left: band.left / frame.w, right: (band.right + 1) / frame.w }
      : { top: 0, left: 0.25, right: 0.75 };
  });

// A catalog entry may say where the head is ({top, left, right} as fractions of the cell) when the top of the figure
// isn't the head, like the turtle's shell.
const validHead = (h: Head | null) =>
  h &&
  (["top", "left", "right"] satisfies (keyof Head)[]).every((k) => Number.isFinite(h[k]) && h[k] >= 0 && h[k] <= 1) &&
  h.right > h.left;
// The head of a frame: the catalog hint when it has one, else measured. Accessories (cosmetics.ts) use it too.
// headHint! : validHead is false for null.
export const headFor = (image: CanvasImageSource, frame: Frame, headHint: Head | null = null): Head =>
  validHead(headHint) ? headHint! : headOf(image, frame);

// Draws hat `id` on a sprite frame drawn at (dx, dy, dw, dh) in the current transform. Unknown ids draw nothing.
export function drawHat(
  ctx: CanvasRenderingContext2D,
  id: string,
  image: CanvasImageSource | null | undefined,
  frame: Frame | null | undefined,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  headHint: Head | null = null,
) {
  const hat = HATS[id];
  if (!hat || !image || !frame) return;
  const head = headFor(image, frame, headHint);
  const px = ((head.right - head.left) * dw) / (hat.span[1] - hat.span[0]);
  const x0 = dx + head.left * dw - hat.span[0] * px;
  const y0 = dy + head.top * dh + hat.sink * px - hat.rows.length * px;
  drawGrid(ctx, hat.rows, hat.colors, x0, y0, px);
}
