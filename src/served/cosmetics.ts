// Cosmetics drawn on stream (overlay.ts) and in the website preview (src/ui.ts). Looks only, no stat changes.
// The lists, prices and ownership live in server/cosmetics.ts; the ids here must match (tests/cosmetics.test.ts).
import { headFor } from "./hats.ts";
import type { Head } from "./hats.ts";
import { filtered, frameKey, perSource } from "./pixels.ts";
import type { Frame } from "./pixels.ts";
type Ctx = CanvasRenderingContext2D;

// Preset lines only: nothing a viewer types reaches the stream.
export const TAUNTS: Record<string, string> = {
  gg: "GG!",
  next: "Who's next?",
  easy: "Too easy.",
  rematch: "Rematch? Any time.",
  bow: "Take a bow.",
  nap: "That was my warm-up.",
  luck: "Better luck next time!",
  chat: "Chat, did you see that?",
};
export const TITLES: Record<string, string> = {
  rookie: "Rookie",
  brawler: "Brawler",
  lucky: "Lucky Star",
  wall: "Iron Wall",
  cannon: "Glass Cannon",
  owl: "Night Owl",
  menace: "Chat Menace",
  champion: "Champion",
  legend: "Legend",
};

// Recolors are canvas filters on the body only (hats and accessories keep their colors). Sepia first evens out
// the source colors, so every character ends up in the same tint. Pet colors use the same list.
const RECOLORS: Record<string, string> = {
  crimson: "sepia(1) saturate(4) hue-rotate(-45deg) brightness(.92)",
  ocean: "sepia(1) saturate(3.2) hue-rotate(165deg) brightness(.95)",
  forest: "sepia(1) saturate(3) hue-rotate(55deg) brightness(.88)",
  violet: "sepia(1) saturate(3) hue-rotate(225deg) brightness(.95)",
  gold: "sepia(1) saturate(5) brightness(1.12)",
  ghost: "grayscale(1) brightness(1.7) opacity(.72)",
  shadow: "grayscale(.6) brightness(.38)",
  negative: "invert(1) hue-rotate(180deg)",
};
export const recolorFilter = (id: string) => RECOLORS[id] || "";
// One sprite frame with a recolor (and an optional extra filter, the overlay's hit flash) baked in, cached per image,
// frame and filter (pixels.ts filtered says why).
const recolored = perSource<HTMLCanvasElement | OffscreenCanvas | null>();
export function recoloredFrame(image: CanvasImageSource, frame: Frame, id: string, extra = "") {
  const filter = [recolorFilter(id), extra].filter(Boolean).join(" ");
  if (!filter) return null;
  const px = (n: number) => Math.max(1, Math.round(n));
  return recolored(image, filter + "|" + frameKey(frame), () =>
    filtered(image, frame, filter, px(frame.w), px(frame.h)),
  );
}

// ---------- accessories ----------
// Drawn in the sprite's own box, facing right; callers mirror for left. The cape is behind the body (layer "back"),
// the rest in front. Placement follows the head found by hats.ts: x0 and hw are its left edge and width.
type Wear = { x0: number; hw: number; cx: number; eyeY: number; neckY: number; line: number; bottom: number };
type Sway = { t: number; moving: boolean };
function specs(ctx: Ctx, { x0, hw, cx, eyeY, line }: Wear, shades: boolean) {
  const r = hw * 0.13,
    a = cx + hw * 0.02,
    b = cx + hw * 0.32;
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = line;
  ctx.beginPath();
  ctx.moveTo(a - r, eyeY);
  ctx.lineTo(x0 + hw * 0.05, eyeY - r * 0.3);
  ctx.stroke(); // the arm to the ear
  ctx.beginPath();
  ctx.moveTo(a + r, eyeY);
  ctx.lineTo(b - r, eyeY);
  ctx.stroke(); // the bridge
  for (const ex of [a, b]) {
    if (shades) {
      ctx.fillStyle = "#0b0c10";
      ctx.beginPath();
      ctx.roundRect(ex - r * 1.15, eyeY - r * 0.8, r * 2.3, r * 1.6, r * 0.5);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.55)";
      ctx.lineWidth = line * 0.6;
      ctx.beginPath();
      ctx.moveTo(ex - r * 0.6, eyeY - r * 0.35);
      ctx.lineTo(ex - r * 0.1, eyeY - r * 0.35);
      ctx.stroke();
      ctx.strokeStyle = "#111318";
      ctx.lineWidth = line;
    } else {
      ctx.fillStyle = "rgba(190,225,255,.35)";
      ctx.beginPath();
      ctx.arc(ex, eyeY, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}
const ACCESSORIES: Record<string, (ctx: Ctx, w: Wear, s: Sway) => void> = {
  glasses: (ctx, w) => specs(ctx, w, false),
  shades: (ctx, w) => specs(ctx, w, true),
  monocle(ctx, { hw, cx, eyeY, line }) {
    const r = hw * 0.15,
      ex = cx + hw * 0.28;
    ctx.strokeStyle = "#d4a017";
    ctx.lineWidth = line;
    ctx.fillStyle = "rgba(190,225,255,.3)";
    ctx.beginPath();
    ctx.arc(ex, eyeY, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.lineWidth = line * 0.6;
    ctx.beginPath();
    ctx.moveTo(ex, eyeY + r);
    ctx.quadraticCurveTo(ex - r * 0.4, eyeY + hw * 0.4, ex - r * 1.6, eyeY + hw * 0.5);
    ctx.stroke();
  },
  bowtie(ctx, { hw, cx, neckY, line }) {
    const w = hw * 0.2,
      hgt = hw * 0.15,
      bx = cx + hw * 0.08;
    ctx.fillStyle = "#d62839";
    ctx.strokeStyle = "#7f1020";
    ctx.lineWidth = line * 0.6;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(bx, neckY);
      ctx.lineTo(bx + s * w, neckY - hgt);
      ctx.lineTo(bx + s * w, neckY + hgt);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = "#7f1020";
    ctx.fillRect(bx - hw * 0.045, neckY - hw * 0.05, hw * 0.09, hw * 0.1);
  },
  scarf(ctx, { hw, cx, neckY }, { t, moving }) {
    const sway = Math.sin(t / 180) * hw * (moving ? 0.12 : 0.04),
      bandH = hw * 0.15;
    ctx.fillStyle = "#2f6fd6";
    ctx.beginPath();
    ctx.roundRect(cx - hw * 0.4, neckY - bandH / 2, hw * 0.8, bandH, bandH / 2);
    ctx.fill();
    // the tail blows backwards
    ctx.beginPath();
    ctx.moveTo(cx - hw * 0.3, neckY);
    ctx.lineTo(cx - hw * 0.62 + sway, neckY + hw * 0.32);
    ctx.lineTo(cx - hw * 0.44 + sway, neckY + hw * 0.36);
    ctx.lineTo(cx - hw * 0.14, neckY + bandH / 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#f5f7fb";
    for (const k of [-0.22, 0.02, 0.26]) ctx.fillRect(cx + hw * k, neckY - bandH / 2, hw * 0.06, bandH);
  },
  cape(ctx, { hw, cx, neckY, bottom }, { t, moving }) {
    const sway = Math.sin(t / 200) * hw * (moving ? 0.16 : 0.05);
    const grad = ctx.createLinearGradient(0, neckY, 0, bottom);
    grad.addColorStop(0, "#9b1c22");
    grad.addColorStop(1, "#c62a32");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx - hw * 0.28, neckY);
    ctx.lineTo(cx + hw * 0.12, neckY);
    ctx.quadraticCurveTo(cx + hw * 0.05, (neckY + bottom) / 2, cx - hw * 0.05 - sway * 0.4, bottom);
    ctx.lineTo(cx - hw * 0.72 - sway, bottom - hw * 0.08);
    ctx.quadraticCurveTo(cx - hw * 0.5, (neckY + bottom) / 2, cx - hw * 0.28, neckY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#f2c94c";
    ctx.beginPath();
    ctx.arc(cx - hw * 0.08, neckY, hw * 0.06, 0, Math.PI * 2);
    ctx.fill(); // the clasp
  },
};
export function drawAccessory(
  ctx: Ctx,
  id: string,
  image: CanvasImageSource | null | undefined,
  frame: Frame | null | undefined,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  {
    headHint = null,
    layer = "front",
    t = 0,
    moving = false,
  }: { headHint?: Head | null | undefined; layer?: string; t?: number; moving?: boolean } = {},
) {
  const draw = ACCESSORIES[id];
  if (!draw || !image || !frame || (id === "cape") !== (layer === "back")) return;
  const head = headFor(image, frame, headHint);
  const x0 = dx + head.left * dw,
    hw = Math.max(4, (head.right - head.left) * dw),
    top = dy + head.top * dh;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const wear = { x0, hw, cx: x0 + hw / 2, eyeY: top + hw * 0.46, line: Math.max(1.5, hw * 0.055) };
  draw(ctx, { ...wear, neckY: Math.min(dy + dh * 0.72, top + hw * 0.95), bottom: dy + dh * 0.93 }, { t, moving });
  ctx.restore();
}

// ---------- walking trails ----------
// A trail leaves particles where the fighter walked. Each call site keeps one createTrail() list and spawns
// while its fighter moves; vx lets the website preview scroll them backwards as if walking.
const TRAIL_EVERY_MS = 90,
  TRAIL_LIFE_MS = 950;
type TrailPart = { id: string; x: number; y: number; born: number; size: number; seed: number; vx: number; vy: number };
// draw paints one particle at the origin: r is its radius, k its age (0..1). vy: its speed in sizes per second (a
// random rise when unset); sway: it wobbles sideways.
type TrailKind = {
  draw: (ctx: Ctx, r: number, k: number, seed: number, age: number) => void;
  vy?: number;
  sway?: true;
};
const TRAILS: Record<string, TrailKind> = {
  sparkles: {
    draw: (ctx, r, _k, seed, age) => star(ctx, 4, r * 1.3 * (0.6 + 0.4 * Math.sin(age / 70 + seed)), 0.3, "#fff3b0"),
  },
  hearts: { draw: (ctx, r, k) => heart(ctx, r * (1 - k * 0.3), "#f472b6") },
  flames: {
    vy: -0.35,
    draw(ctx, r, k) {
      ctx.fillStyle = k < 0.3 ? "#fde047" : k < 0.6 ? "#fb923c" : "#dc2626";
      ctx.beginPath();
      ctx.arc(0, 0, r * (1.2 - k * 0.9), 0, Math.PI * 2);
      ctx.fill();
    },
  },
  bubbles: {
    sway: true,
    draw(ctx, r, k) {
      ctx.strokeStyle = "#8fd8ff";
      ctx.lineWidth = Math.max(1, r * 0.25);
      ctx.beginPath();
      ctx.arc(0, 0, r * (0.7 + k * 0.5), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,.7)";
      ctx.fillRect(-r * 0.35, -r * 0.45, r * 0.25, r * 0.25);
    },
  },
  stars: {
    vy: 0.25,
    draw(ctx, r, _k, seed, age) {
      ctx.rotate(age / 300 + seed);
      star(ctx, 5, r * 1.1, 0.45, "#facc15", -Math.PI / 2);
    },
  },
  notes: {
    sway: true,
    draw(ctx, r) {
      ctx.fillStyle = ctx.strokeStyle = "#c4b5fd";
      ctx.lineWidth = Math.max(1, r * 0.28);
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.7, r * 0.5, -0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(r * 0.6, 0);
      ctx.lineTo(r * 0.6, -r * 2);
      ctx.quadraticCurveTo(r * 1.4, -r * 1.6, r * 1.3, -r * 0.9);
      ctx.stroke();
    },
  },
};
export function createTrail(limit = 400) {
  const parts: TrailPart[] = [];
  const last = new Map<string, number>();
  return {
    // key: one per fighter, so the spawn rate holds per fighter. x, y: the feet. size: the fighter's height.
    spawn(key: string, id: string, x: number, y: number, size: number, dir: number, now: number, vx = 0) {
      const kind = TRAILS[id];
      if (!kind || now - (last.get(key) || 0) < TRAIL_EVERY_MS) return;
      last.set(key, now);
      if (last.size > 200) for (const [k, t] of last) if (now - t > TRAIL_LIFE_MS) last.delete(k); // fighters who left
      const seed = (now % 997) + parts.length;
      parts.push({
        id,
        x: x - dir * size * 0.18 + (rnd(seed, 1) - 0.5) * size * 0.2,
        y: y - size * (0.08 + rnd(seed, 2) * 0.45),
        born: now,
        size,
        seed,
        vx,
        vy: size * (kind.vy ?? -(0.3 + rnd(seed, 3) * 0.3)),
      });
      if (parts.length > limit) parts.splice(0, parts.length - limit);
    },
    draw(ctx: Ctx, now: number) {
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]!, // 0 <= i < parts.length
          age = now - p.born;
        if (age > TRAIL_LIFE_MS || age < 0) {
          parts.splice(i, 1);
          continue;
        }
        const s = age / 1000,
          wobble = TRAILS[p.id]!.sway ? Math.sin(p.seed + age / 160) * p.size * 0.04 : 0; // spawn takes only known ids
        drawTrailPart(ctx, p.id, p.x + p.vx * s + wobble, p.y + p.vy * s, p.size, age / TRAIL_LIFE_MS, p.seed, age);
      }
    },
    clear() {
      parts.length = 0;
      last.clear();
    },
    get size() {
      return parts.length;
    },
  };
}
// One still particle for list thumbnails: k is its age (0..1).
export function drawTrailSample(ctx: Ctx, id: string, x: number, y: number, size: number) {
  (
    [
      [0, 0.2, 0.15],
      [-0.32, 0.45, 0.4],
      [-0.62, 0.15, 0.65],
      [-0.9, 0.38, 0.85],
    ] satisfies [number, number, number][]
  ).forEach(([ox, oy, k], i) => drawTrailPart(ctx, id, x + ox * size, y - oy * size, size, k, i * 7 + 3, k * 900));
}
function drawTrailPart(ctx: Ctx, id: string, x: number, y: number, size: number, k: number, seed: number, age: number) {
  const kind = TRAILS[id];
  if (!kind) return;
  ctx.save();
  ctx.globalAlpha = Math.max(0, 1 - k * k);
  ctx.translate(x, y);
  kind.draw(ctx, size * 0.065, k, seed, age);
  ctx.restore();
}
// A star of n points at the origin; inner is the inner radius as a fraction of r, a0 the first point's angle.
function star(ctx: Ctx, n: number, r: number, inner: number, color: string, a0 = 0) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = a0 + (i * Math.PI) / n,
      d = i % 2 ? r * inner : r;
    ctx.lineTo(Math.cos(a) * d, Math.sin(a) * d);
  }
  ctx.closePath();
  ctx.fill();
}
function heart(ctx: Ctx, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, r * 0.9);
  ctx.bezierCurveTo(-r * 1.6, -r * 0.2, -r * 0.6, -r * 1.3, 0, -r * 0.45);
  ctx.bezierCurveTo(r * 0.6, -r * 1.3, r * 1.6, -r * 0.2, 0, r * 0.9);
  ctx.fill();
}

// ---------- win effects ----------
// Played over the winner for WIN_EFFECT_MS after a duel. Pure function of the time (k = 0..1) and a seed, so the
// overlay and the preview draw the same thing and a test frame is repeatable.
export const WIN_EFFECT_MS = 3000;
const rnd = (seed: number, i: number) => {
  const v = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  return v - Math.floor(v);
};
const CONFETTI = ["#f87171", "#fbbf24", "#34d399", "#60a5fa", "#c084fc", "#f472b6"];
// sec: seconds since the win; fade: 1, falling to 0 over the last fifth.
type Win = { x: number; groundY: number; size: number; k: number; seed: number; sec: number; fade: number };
const WIN_EFFECTS: Record<string, (ctx: Ctx, w: Win) => void> = {
  confetti(ctx, { x, groundY, size, seed, sec, fade }) {
    const oy = groundY - size * 1.05,
      g = size * 2.2;
    for (let i = 0; i < 46; i++) {
      const vx = (rnd(seed, i) - 0.5) * size * 2.6,
        vy = -(size * 1.3 + rnd(seed, i + 50) * size * 1.6);
      const t = Math.min(sec, 2.6),
        drag = 1 - Math.min(0.6, t * 0.25);
      const px = x + vx * t * drag + Math.sin(sec * 5 + i) * size * 0.05;
      const py = oy + vy * t * drag + ((g * t * t) / 2) * 0.55;
      if (py > groundY + size * 0.05) continue;
      ctx.globalAlpha = fade;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(sec * (3 + rnd(seed, i + 9) * 6) + i);
      ctx.scale(1, Math.cos(sec * 8 + i));
      ctx.fillStyle = CONFETTI[i % CONFETTI.length]!; // the index wraps inside the list
      ctx.fillRect(-size * 0.035, -size * 0.02, size * 0.07, size * 0.04);
      ctx.restore();
    }
  },
  fireworks(ctx, { x, groundY, size, k, seed, fade }) {
    const colors = ["#fde047", "#f472b6", "#60a5fa"];
    for (let b = 0; b < 3; b++) {
      const local = (k - b * 0.22) / 0.6;
      if (local < 0 || local > 1) continue;
      const bx = x + (b - 1) * size * 0.85,
        by = groundY - size * (1.75 + (b % 2) * 0.35);
      if (local < 0.2) {
        // the rocket going up
        ctx.fillStyle = "#fff7d6";
        ctx.globalAlpha = 1;
        ctx.fillRect(bx - 1.5, groundY - size * 0.6 + (by - groundY + size * 0.6) * (local / 0.2), 3, size * 0.12);
        continue;
      }
      const q = (local - 0.2) / 0.8,
        radius = size * 0.7 * (1 - Math.pow(1 - q, 3));
      ctx.globalAlpha = Math.max(0, 1 - q) * fade;
      ctx.fillStyle = colors[b]!; // b < 3, the length of colors
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * Math.PI * 2 + rnd(seed, b * 30 + i) * 0.2,
          d = radius * (0.85 + rnd(seed, b * 60 + i) * 0.15);
        const r = Math.max(1.5, size * 0.03 * (1 - q * 0.5));
        ctx.beginPath();
        ctx.arc(bx + Math.cos(a) * d, by + Math.sin(a) * d + q * q * size * 0.25, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  },
  banner(ctx, { x, groundY, size, k, sec, fade }) {
    const unroll = Math.min(1, k / 0.15),
      w = size * 1.8 * unroll,
      hgt = size * 0.34,
      cy = groundY - size * 1.5,
      tail = hgt * 0.7;
    ctx.globalAlpha = fade;
    ctx.fillStyle = "#b45309";
    for (const s of [-1, 1]) {
      // the notched ends behind
      const ex = x + s * (w / 2 + tail * 0.2);
      ctx.beginPath();
      ctx.moveTo(ex - s * tail, cy - hgt * 0.3);
      ctx.lineTo(ex + s * tail * 0.6, cy - hgt * 0.3);
      ctx.lineTo(ex + s * tail * 0.15, cy + hgt * 0.15);
      ctx.lineTo(ex + s * tail * 0.6, cy + hgt * 0.6);
      ctx.lineTo(ex - s * tail, cy + hgt * 0.6);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = "#f59e0b";
    ctx.fillRect(x - w / 2, cy - hgt / 2, w, hgt);
    ctx.fillStyle = "#fcd34d";
    ctx.fillRect(x - w / 2, cy - hgt / 2, w, hgt * 0.14);
    if (unroll < 1) return;
    ctx.fillStyle = "#3b1d04";
    ctx.font = "800 " + Math.round(hgt * 0.62) + "px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("VICTORY", x, cy + hgt * 0.04, w * 0.9);
    for (let i = 0; i < 6; i++) {
      // glints around it
      const a = sec * 2 + i * 1.05;
      ctx.save();
      ctx.translate(x + Math.cos(a) * w * 0.62, cy + Math.sin(a) * hgt * 1.4);
      ctx.globalAlpha = fade * (0.5 + 0.5 * Math.sin(sec * 9 + i));
      star(ctx, 4, size * 0.05, 0.3, "#fff7d6");
      ctx.restore();
    }
  },
};
export function drawWinEffect(ctx: Ctx, id: string, x: number, groundY: number, size: number, k: number, seed = 1) {
  const draw = WIN_EFFECTS[id];
  if (!draw || !(k >= 0 && k <= 1)) return;
  ctx.save();
  draw(ctx, { x, groundY, size, k, seed, sec: (k * WIN_EFFECT_MS) / 1000, fade: k > 0.8 ? (1 - k) / 0.2 : 1 });
  ctx.restore();
}

// The ids of each kind, in the server's order (server/cosmetics.ts; tests/cosmetics.test.ts).
export const COSMETIC_IDS = {
  recolor: Object.keys(RECOLORS),
  petcolor: Object.keys(RECOLORS),
  accessory: Object.keys(ACCESSORIES),
  trail: Object.keys(TRAILS),
  effect: Object.keys(WIN_EFFECTS),
  taunt: Object.keys(TAUNTS),
  title: Object.keys(TITLES),
};
