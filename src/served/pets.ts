// Pets: original pixel art drawn in code (no image files), shared by the overlay and the dashboard preview.
// The list of pets, their tiers and boosts lives in server/pets.ts; ids here must match it. Uploaded (custom) pets
// are PNG images; drawPet takes their loaded image instead of an id.
// Each pet is a grid ('.' = empty, letters = colors) that faces right like the character sprites. fly = it hovers
// (legendary pets); wings = rows of a second frame swapped in every other beat while it moves or hovers.
type PetArt = { fly?: boolean; colors: Record<string, string>; rows: string[]; wings?: string[] };
/** A built-in pet id, or an uploaded pet's loaded image. */
type PetArg = string | { image?: HTMLImageElement | null } | null | undefined;
type PetCanvas = HTMLCanvasElement | OffscreenCanvas;
import { blank, drawGrid, filtered, perSource } from "./pixels.ts";

const PETS: Record<string, PetArt> = {
  mouse: {
    colors: { G: "#a3a9b5", D: "#6b7280", R: "#f9a8d4", K: "#111827", N: "#f472b6", T: "#f9a8d4" },
    rows: [
      ".......DD...",
      "......DRRD..",
      "...GGGGGGGD.",
      "..GGGGGGKGG.",
      "T.GGGGGGGGGN",
      ".TTGGGGGGGG.",
      "...D...D....",
    ],
  },
  chick: {
    colors: { Y: "#facc15", L: "#fde68a", O: "#f97316", K: "#1f2937" },
    rows: ["....YYY..", "...YYYYY.", "...YYKYOO", "YY.YYYYY.", "YYYYLLYY.", ".YYYLLYY.", "..YYYYY..", "...O.O..."],
  },
  slime: {
    colors: { G: "#4ade80", L: "#bbf7d0", D: "#16a34a", K: "#14532d" },
    rows: ["...GGGG...", ".GGLLGGGG.", "GGLGGGGGGG", "GGGGGKGGKG", "GGGGGGGGGG", "GGGGGGGGGG", ".DDDDDDDD."],
  },
  frog: {
    colors: { G: "#22c55e", L: "#bbf7d0", W: "#ffffff", K: "#052e16", R: "#15803d", S: "#166534" },
    rows: [
      "..GG....GG..",
      ".GWKG..GWKG.",
      ".GGGGGGGGGG.",
      "GGSGGGGGGSGG",
      "GGRRRRRRRRGG",
      ".GGLLLLLLGG.",
      "GG.GGGGGG.GG",
      "GG........GG",
    ],
  },
  cat: {
    colors: { O: "#fb923c", S: "#c2410c", W: "#fff7ed", K: "#1f2937", P: "#f9a8d4" },
    rows: [
      "........O..O",
      "T.......OOOO",
      "T.......OKOK",
      ".T......OOPO",
      ".TOOOOOOOOO.",
      "..OSOOSOOSO.",
      "..OOOOOOOOO.",
      "..WO.WO.WO.W",
    ],
  },
  pup: {
    colors: { B: "#a16207", D: "#713f12", W: "#fef3c7", K: "#1c1917", P: "#f472b6" },
    rows: [
      ".......BBB..",
      "......DBBBB.",
      "......DBBKBK",
      "B.....DBWWWW",
      ".B.BBBBBBWP.",
      "..BBBBBBBB..",
      "..BWBBBBWB..",
      "..W.W..W.W..",
    ],
  },
  fox: {
    colors: { O: "#f97316", D: "#c2410c", W: "#ffffff", K: "#1f2937" },
    rows: [
      "..........O..O",
      ".........OOOOO",
      ".........OOKOO",
      "OO.......WOOOOK",
      "OOO......WWWW..",
      "WOOOOOOOOOOW...",
      ".WOOOOOOOOOW...",
      "..OOOOOOOOO....",
      "..D.D...D.D....",
    ],
  },
  bunny: {
    colors: { W: "#f8fafc", G: "#cbd5e1", P: "#f9a8d4", K: "#1f2937" },
    rows: [
      ".........W.W.",
      ".........WPWP",
      ".........WPWP",
      ".........WWWW.",
      "........WWWKW.",
      "........WWWWP.",
      "..WWWWWWWWWW..",
      "WWWWWWWWWWWW..",
      ".WGWWWWWWWGW..",
      "..GG.....GG...",
    ],
  },
  turtle: {
    colors: { S: "#15803d", L: "#4ade80", Y: "#ca8a04", G: "#84cc16", K: "#1f2937" },
    rows: [
      "....SSSSS.....",
      "...SLSSSLS....",
      "..SSSLLLSSS...",
      ".SLSSSLSSSLS.GG",
      "YYYYYYYYYYYYGKG",
      ".GG.......GGGG.",
      ".GG......GG....",
    ],
  },
  wolf: {
    colors: { G: "#94a3b8", D: "#475569", W: "#e2e8f0", K: "#0f172a", B: "#38bdf8" },
    rows: [
      "...........D..D",
      "..........DGGGD",
      "..........GGBGG",
      "DD........GGGGGK",
      "DGG......GWWW...",
      ".DGGGGGGGGWW....",
      "..GGGGGGGGGG....",
      "..GWGGGGGGWG....",
      "..G.G....G.G....",
      "..D.D....D.D....",
    ],
  },
  owl: {
    colors: { B: "#92400e", L: "#d97706", C: "#fde68a", W: "#ffffff", K: "#1f2937", O: "#f59e0b" },
    rows: [
      "..B......B..",
      "..BBBBBBBB..",
      ".BWWWBBWWWB.",
      ".BWKWBBWKWB.",
      ".BWWWOOWWWB.",
      "BBBBBOOBBBBB",
      "BLLCCCCCCLLB",
      "BLLCLCCLCLLB",
      ".BLCCCCCCLB.",
      "..BBBBBBBB..",
      "...O....O...",
    ],
  },
  bear: {
    colors: { B: "#78350f", L: "#b45309", T: "#fcd34d", K: "#1c1917", N: "#451a03" },
    rows: [
      ".........BB.BB",
      ".........BLBBLB",
      "........BBBBBBB",
      "........BBBKBBT",
      ".BBBBBBBBBBBTTN",
      "BBBBBBBBBBBBBB.",
      "BBBBBBBBBBBBBB.",
      "BBLBBBBBBBBLBB.",
      ".BB.BB..BB.BB..",
    ],
  },
  dragon: {
    fly: true,
    colors: { P: "#8b5cf6", D: "#4c1d95", L: "#c4b5fd", B: "#ddd6fe", Y: "#fde047", K: "#1f2937" },
    rows: [
      "D..........Y.Y.",
      "DD.........PPP.",
      "DLD.......PPKPP",
      "DLLD......PPPPPP",
      "DLLLD....PPP....",
      ".DLLLDPPPPPP....",
      "..PPPPPPBBPP....",
      ".PP.PPPPBBP.....",
      "PP...PP..PP.....",
      "P...............",
    ],
    wings: [
      "...........Y.Y.",
      "...........PPP.",
      "..........PPKPP",
      "..........PPPPPP",
      ".........PPP....",
      "...DDDPPPPPP....",
      "..DLLLDPBBPP....",
      ".PDLLLDPBBP.....",
      "PP.DLD...PP.....",
      "P...D...........",
    ],
  },
  phoenix: {
    fly: true,
    colors: { R: "#ef4444", O: "#f97316", Y: "#facc15", W: "#fef9c3", K: "#1f2937" },
    rows: [
      "..YO.........",
      ".YOOR....RR..",
      "YOORRR..RRRY.",
      ".OORRRRRRRKOO",
      "....RRRRRRR..",
      "...YRRRRRR...",
      "..YOOY.......",
      ".YO.OY.......",
      "Y...Y........",
    ],
    wings: [
      ".............",
      ".........RR..",
      ".......RRRRY.",
      "...RRRRRRRKOO",
      ".YOORRRRRRR..",
      "YOORROOYRR...",
      "..YOOYYO.....",
      ".YO.OY.......",
      "Y...Y........",
    ],
  },
};

const RARE_SPARKLE: Record<string, string> = { epic: "#c4b5fd", legendary: "#fde047" };

// Each built-in pet frame is painted once into a small canvas (CELL px per pixel-art cell) and then drawn as one
// image; a pet color is baked into its own copy the same way (pixels.ts filtered).
const CELL = 8,
  frames = perSource<PetCanvas | null>(),
  tinted = perSource<CanvasImageSource>();
function petFrame(art: PetArt, rows: string[], cols: number, tint: string): PetCanvas | null {
  return frames(art, (rows === art.rows ? "" : "wings") + "|" + tint, () => {
    if (tint !== "none") {
      const plain = petFrame(art, rows, cols, "none");
      return plain && filtered(plain, { x: 0, y: 0, w: plain.width, h: plain.height }, tint);
    }
    const g = blank(cols * CELL, rows.length * CELL);
    if (g) drawGrid(g, rows, art.colors, 0, 0, CELL, 0);
    return g?.canvas || null;
  });
}

// Draws pet `pet` (a built-in id, or {image} for an uploaded pet) standing on (x, baseY), about `size` px tall, facing
// `facing` (1 right, -1 left). t is a clock in ms for the hop, hover and sparkles; tier adds the epic/legendary sparkle.
// Unknown ids draw nothing. Returns true when something was drawn.
// tint: a canvas filter (a pet color) baked into a cached copy of the pet, never run on ctx.
export function drawPet(
  ctx: CanvasRenderingContext2D,
  pet: PetArg,
  x: number,
  baseY: number,
  size: number,
  {
    facing = 1,
    t = 0,
    moving = false,
    tier = "",
    still = false,
    tint = "none",
  }: {
    facing?: number;
    t?: number;
    moving?: boolean;
    tier?: string | undefined;
    still?: boolean;
    tint?: string | undefined;
  } = {},
) {
  const art = typeof pet === "string" ? PETS[pet] : null;
  const image = pet && typeof pet === "object" ? pet.image : null;
  if (!art && !(image?.complete && image.naturalWidth)) return false;
  const hover = art?.fly || tier === "legendary";
  const lift = still
    ? hover
      ? size * 0.25
      : 0
    : hover
      ? size * (0.3 + 0.08 * Math.sin(t / 260))
      : moving
        ? Math.abs(Math.sin(t / 110)) * size * 0.18
        : 0;
  const filter = tint || "none";
  ctx.save();
  ctx.translate(x, baseY - lift);
  if (facing < 0) ctx.scale(-1, 1);
  ctx.imageSmoothingEnabled = false;
  if (art) {
    const flap = art.wings && !still && Math.floor(t / 180) % 2 === 1;
    const rows = flap ? art.wings! : art.rows, // flap is true only when wings exist
      cols = Math.max(...art.rows.map((r) => r.length));
    const px = size / Math.max(art.rows.length, cols * 0.8);
    const frame = petFrame(art, rows, cols, filter);
    if (frame) ctx.drawImage(frame, (-cols * px) / 2, -rows.length * px, cols * px, rows.length * px);
    else drawGrid(ctx, rows, art.colors, (-cols * px) / 2, -rows.length * px, px);
  } else {
    const img = image!; // art is null here, so the check at the top proved image is loaded
    const whole = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
    const scale = Math.min(size / whole.h, (size * 1.4) / whole.w);
    const source = filter === "none" ? img : tinted(img, filter, () => filtered(img, whole, filter) || img);
    ctx.drawImage(source, (-whole.w * scale) / 2, -whole.h * scale, whole.w * scale, whole.h * scale);
  }
  // Epic and legendary pets sparkle: a few small diamonds that circle the pet.
  const sparkle = RARE_SPARKLE[tier];
  if (sparkle && !still) {
    ctx.fillStyle = sparkle;
    const count = tier === "legendary" ? 3 : 2;
    for (let i = 0; i < count; i++) {
      const a = t / 600 + (i * Math.PI * 2) / count,
        r = size * 0.6,
        s = Math.max(2, size * (0.06 + 0.03 * Math.sin(t / 150 + i)));
      const sx = Math.cos(a) * r,
        sy = -size * 0.5 + Math.sin(a) * r * 0.5;
      ctx.beginPath();
      ctx.moveTo(sx, sy - s);
      ctx.lineTo(sx + s, sy);
      ctx.lineTo(sx, sy + s);
      ctx.lineTo(sx - s, sy);
      ctx.fill();
    }
  }
  ctx.restore();
  return true;
}
