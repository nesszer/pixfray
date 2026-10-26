// Atlas packing for custom characters (Lane D). Pure logic plus one canvas draw step, so it runs in the browser
// and in node tests. The server repeats every limit check in server/uploads.ts.
export const LIMITS = Object.freeze({
  maxFrames: 24,
  frameSize: 128,
  maxAtlasBytes: 1_572_864,
  maxCharacters: 24,
  mime: "image/png",
  maxAtlasSide: 1024,
  maxLabel: 32,
});
export const ANIMATION_SLOTS = Object.freeze(["idle", "walk", "attack", "ko"] as const); // as const: the slot names are a type
export type Slot = (typeof ANIMATION_SLOTS)[number];
type Size = { w: number; h: number };
type Cell = { x: number; y: number; w: number; h: number };
type Groups = Partial<Record<Slot, Size[]>>;
export type AtlasPlan = ReturnType<typeof planAtlas>;
const ATLAS_COLUMNS = 8; // 8 x 128 = 1024 px wide at most; 24 frames -> 3 rows.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Reads width and height from PNG bytes (signature + IHDR). Returns null when the bytes are not a PNG.
export function pngInfo(bytes: ArrayLike<number> | null | undefined) {
  if (!bytes || bytes.length < 24) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  // ArrayLike indexes are number here: length >= 24 was checked above.
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== "IHDR") return null;
  const u32 = (at: number) =>
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
  const width = u32(16),
    height = u32(20);
  return width && height ? { width, height } : null;
}

// groups: {idle:[{w,h}], walk:[...], attack:[...], ko:[...]} in frame order. Returns a list of problems (empty = ok).
export function checkFrames(groups: Groups, limits: { maxFrames: number; frameSize: number } = LIMITS) {
  const problems: string[] = [];
  const all = ANIMATION_SLOTS.flatMap((slot) => (groups[slot] || []).map((f, i) => ({ ...f, slot, i })));
  if (!all.length) problems.push("Add at least one PNG frame.");
  if (all.length > limits.maxFrames)
    problems.push(`Use at most ${limits.maxFrames} frames in total (you have ${all.length}).`);
  for (const f of all) {
    if (f.w > limits.frameSize || f.h > limits.frameSize)
      problems.push(
        `${f.slot} frame ${f.i + 1} is ${f.w} x ${f.h} px; the limit is ${limits.frameSize} x ${limits.frameSize}.`,
      );
  }
  return problems;
}

// Lays every frame into a uniform grid. Each cell is as big as the largest frame; frames are bottom-centre
// aligned in their cell, so feet line up with the overlay anchor {x:0.5, y:1}.
// Returns {cell, cols, rows, width, height, placements:[{slot, index, x, y, dx, dy, w, h}], frames, animations}.
export function planAtlas(groups: Groups, { columns = ATLAS_COLUMNS }: { columns?: number } = {}) {
  const list = ANIMATION_SLOTS.flatMap((slot) =>
    (groups[slot] || []).map((f, index) => ({ slot, index, w: f.w, h: f.h })),
  );
  if (!list.length) throw new Error("No frames to pack");
  const cell = { w: Math.max(...list.map((f) => f.w)), h: Math.max(...list.map((f) => f.h)) };
  const cols = Math.min(columns, list.length),
    rows = Math.ceil(list.length / cols);
  const animations: Partial<Record<Slot, Cell[]>> = {};
  const placements = list.map((f, n) => {
    const x = (n % cols) * cell.w,
      y = Math.floor(n / cols) * cell.h;
    const p = { ...f, x, y, dx: x + Math.floor((cell.w - f.w) / 2), dy: y + cell.h - f.h };
    (animations[f.slot] ||= []).push({ x, y, w: cell.w, h: cell.h });
    return p;
  });
  // `frames` is the fallback loop: walk if present, else idle, else whatever exists first.
  // The keys of animations are slots; with no walk or idle at least one other exists (list is not empty).
  const frames = (animations.walk || animations.idle || animations[Object.keys(animations)[0] as Slot])!;
  return { cell, cols, rows, width: cols * cell.w, height: rows * cell.h, placements, frames, animations };
}

// Single-PNG mode: one image, scaled down (never up) to fit the frame limit. The engine animates it with movement
// and effects. Returns {w, h, scale}.
export function fitSingle(width: number, height: number, limit: number = LIMITS.frameSize) {
  const scale = Math.min(1, limit / width, limit / height);
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)), scale };
}

/** What drawAtlas needs of a canvas: a 2D context to draw the frames on. */
type AtlasCanvas = {
  getContext(type: "2d"): Pick<CanvasRenderingContext2D, "imageSmoothingEnabled" | "clearRect" | "drawImage"> | null;
};

// Draws the planned atlas. images: {slot: [CanvasImageSource]} matching the groups passed to planAtlas.
// createCanvas(w, h) returns a canvas-like object with getContext('2d').
export function drawAtlas<C extends AtlasCanvas>(
  plan: AtlasPlan,
  images: Partial<Record<Slot, CanvasImageSource[]>>,
  createCanvas: (w: number, h: number) => C,
): C {
  const canvas = createCanvas(plan.width, plan.height);
  const ctx = canvas.getContext("2d")!; // a new canvas of a size the limits allow has a 2D context
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, plan.width, plan.height);
  // images match the groups passed to planAtlas, so every placement has its image.
  for (const p of plan.placements) ctx.drawImage(images[p.slot]![p.index]!, p.dx, p.dy, p.w, p.h);
  return canvas;
}

// The JSON body for POST /api/assets/:channel (atlas is filled in by the caller).
export function uploadBody(
  plan: AtlasPlan,
  { label, fps = 8, mode = "frames", atlas = "" }: { label?: unknown; fps?: number; mode?: string; atlas?: string },
) {
  return {
    label: String(label || "")
      .trim()
      .slice(0, LIMITS.maxLabel),
    mode,
    fps,
    atlas,
    frames: plan.frames,
    animations: plan.animations,
  };
}

export function formatBytes(n: number) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}
