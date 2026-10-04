// Cosmetics drawn on stream (overlay.js) and in the website preview (src/ui.js). Looks only, no stat changes.
// The lists, prices and ownership live in server/cosmetics.js; the ids here must match (tests/channel.test.mjs).
import { headFor } from './hats.js';

export const COSMETIC_IDS = {
  recolor: ['crimson', 'ocean', 'forest', 'violet', 'gold', 'ghost', 'shadow', 'negative'],
  petcolor: ['crimson', 'ocean', 'forest', 'violet', 'gold', 'ghost', 'shadow', 'negative'],
  accessory: ['glasses', 'shades', 'monocle', 'bowtie', 'scarf', 'cape'],
  trail: ['sparkles', 'hearts', 'flames', 'bubbles', 'stars', 'notes'],
  effect: ['confetti', 'fireworks', 'banner'],
  taunt: ['gg', 'next', 'easy', 'rematch', 'bow', 'nap', 'luck', 'chat'],
  title: ['rookie', 'brawler', 'lucky', 'wall', 'cannon', 'owl', 'menace', 'champion', 'legend'],
};
// Preset lines only: nothing a viewer types reaches the stream.
export const TAUNTS = { gg: 'GG!', next: "Who's next?", easy: 'Too easy.', rematch: 'Rematch? Any time.', bow: 'Take a bow.', nap: 'That was my warm-up.', luck: 'Better luck next time!', chat: 'Chat, did you see that?' };
export const TITLES = { rookie: 'Rookie', brawler: 'Brawler', lucky: 'Lucky Star', wall: 'Iron Wall', cannon: 'Glass Cannon', owl: 'Night Owl', menace: 'Chat Menace', champion: 'Champion', legend: 'Legend' };

// Recolors are canvas filters on the body only (hats and accessories keep their colors). Sepia first evens out
// the source colors, so every character ends up in the same tint. Pet colors use the same list.
const RECOLORS = {
  crimson: 'sepia(1) saturate(4) hue-rotate(-45deg) brightness(.92)',
  ocean: 'sepia(1) saturate(3.2) hue-rotate(165deg) brightness(.95)',
  forest: 'sepia(1) saturate(3) hue-rotate(55deg) brightness(.88)',
  violet: 'sepia(1) saturate(3) hue-rotate(225deg) brightness(.95)',
  gold: 'sepia(1) saturate(5) brightness(1.12)',
  ghost: 'grayscale(1) brightness(1.7) opacity(.72)',
  shadow: 'grayscale(.6) brightness(.38)',
  negative: 'invert(1) hue-rotate(180deg)',
};
export const recolorFilter = (id) => RECOLORS[id] || '';
// One sprite frame with a recolor baked in, cached per image, frame and recolor. Drawing with ctx.filter set costs
// a filter pass over the whole stage canvas per fighter: a crowd of 50 recolored fighters ran at about 1 fps.
const tintedFrames = new WeakMap();
export function recoloredFrame(image, frame, id) {
  const filter = recolorFilter(id);
  if (!filter) return null;
  let byKey = tintedFrames.get(image);
  if (!byKey) tintedFrames.set(image, byKey = new Map());
  const key = id + '|' + frame.x + ',' + frame.y + ',' + frame.w + ',' + frame.h;
  if (!byKey.has(key)) {
    const w = Math.max(1, Math.round(frame.w)), h = Math.max(1, Math.round(frame.h));
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const g = canvas.getContext('2d');
    if (g) { g.filter = filter; g.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, w, h); }
    byKey.set(key, g ? canvas : null);
  }
  return byKey.get(key);
}
// The swatch color shown for a recolor in lists.
export const RECOLOR_SWATCH = { crimson: '#c0392b', ocean: '#2f80c9', forest: '#3f8f3a', violet: '#7c4dcc', gold: '#e0a526', ghost: '#e8edf2', shadow: '#2b2b33', negative: '#38c7c0' };

// ---------- accessories ----------
// Drawn in the sprite's own box (dx, dy, dw, dh), facing right; callers mirror for left. The cape is behind the body
// (layer "back"), the rest in front. Placement follows the head found by hats.js.
export const BACK_ACCESSORIES = new Set(['cape']);
export function drawAccessory(ctx, id, image, frame, dx, dy, dw, dh, { headHint = null, layer = 'front', t = 0, moving = false } = {}) {
  if (!id || !image || !frame || BACK_ACCESSORIES.has(id) !== (layer === 'back')) return;
  const head = headFor(image, frame, headHint);
  const x0 = dx + head.left * dw, hw = Math.max(4, (head.right - head.left) * dw), cx = x0 + hw / 2, top = dy + head.top * dh;
  const eyeY = top + hw * 0.46, neckY = Math.min(dy + dh * 0.72, top + hw * 0.95);
  const line = Math.max(1.5, hw * 0.055);
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (id === 'glasses' || id === 'shades') {
    const r = hw * 0.13, a = cx + hw * 0.02, b = cx + hw * 0.32;
    ctx.strokeStyle = '#111318'; ctx.lineWidth = line;
    ctx.beginPath(); ctx.moveTo(a - r, eyeY); ctx.lineTo(x0 + hw * 0.05, eyeY - r * 0.3); ctx.stroke();   // the arm to the ear
    ctx.beginPath(); ctx.moveTo(a + r, eyeY); ctx.lineTo(b - r, eyeY); ctx.stroke();                        // the bridge
    for (const ex of [a, b]) {
      if (id === 'shades') {
        ctx.fillStyle = '#0b0c10';
        ctx.beginPath(); ctx.roundRect(ex - r * 1.15, eyeY - r * 0.8, r * 2.3, r * 1.6, r * 0.5); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = line * 0.6;
        ctx.beginPath(); ctx.moveTo(ex - r * 0.6, eyeY - r * 0.35); ctx.lineTo(ex - r * 0.1, eyeY - r * 0.35); ctx.stroke();
        ctx.strokeStyle = '#111318'; ctx.lineWidth = line;
      } else {
        ctx.fillStyle = 'rgba(190,225,255,.35)';
        ctx.beginPath(); ctx.arc(ex, eyeY, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
  } else if (id === 'monocle') {
    const r = hw * 0.15, ex = cx + hw * 0.28;
    ctx.strokeStyle = '#d4a017'; ctx.lineWidth = line;
    ctx.fillStyle = 'rgba(190,225,255,.3)';
    ctx.beginPath(); ctx.arc(ex, eyeY, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.lineWidth = line * 0.6;
    ctx.beginPath(); ctx.moveTo(ex, eyeY + r); ctx.quadraticCurveTo(ex - r * 0.4, eyeY + hw * 0.4, ex - r * 1.6, eyeY + hw * 0.5); ctx.stroke();
  } else if (id === 'bowtie') {
    const w = hw * 0.2, hgt = hw * 0.15, bx = cx + hw * 0.08;
    ctx.fillStyle = '#d62839'; ctx.strokeStyle = '#7f1020'; ctx.lineWidth = line * 0.6;
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(bx, neckY); ctx.lineTo(bx + s * w, neckY - hgt); ctx.lineTo(bx + s * w, neckY + hgt); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    ctx.fillStyle = '#7f1020'; ctx.fillRect(bx - hw * 0.045, neckY - hw * 0.05, hw * 0.09, hw * 0.1);
  } else if (id === 'scarf') {
    const sway = Math.sin(t / 180) * hw * (moving ? 0.12 : 0.04), bandH = hw * 0.15;
    ctx.fillStyle = '#2f6fd6';
    ctx.beginPath(); ctx.roundRect(cx - hw * 0.4, neckY - bandH / 2, hw * 0.8, bandH, bandH / 2); ctx.fill();
    // the tail blows backwards
    ctx.beginPath(); ctx.moveTo(cx - hw * 0.3, neckY); ctx.lineTo(cx - hw * 0.62 + sway, neckY + hw * 0.32); ctx.lineTo(cx - hw * 0.44 + sway, neckY + hw * 0.36); ctx.lineTo(cx - hw * 0.14, neckY + bandH / 2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#f5f7fb';
    for (const k of [-0.22, 0.02, 0.26]) ctx.fillRect(cx + hw * k, neckY - bandH / 2, hw * 0.06, bandH);
  } else if (id === 'cape') {
    const sway = Math.sin(t / 200) * hw * (moving ? 0.16 : 0.05), bottom = dy + dh * 0.93;
    const grad = ctx.createLinearGradient(0, neckY, 0, bottom);
    grad.addColorStop(0, '#9b1c22'); grad.addColorStop(1, '#c62a32');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx - hw * 0.28, neckY);
    ctx.lineTo(cx + hw * 0.12, neckY);
    ctx.quadraticCurveTo(cx + hw * 0.05, (neckY + bottom) / 2, cx - hw * 0.05 - sway * 0.4, bottom);
    ctx.lineTo(cx - hw * 0.72 - sway, bottom - hw * 0.08);
    ctx.quadraticCurveTo(cx - hw * 0.5, (neckY + bottom) / 2, cx - hw * 0.28, neckY);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#f2c94c'; ctx.beginPath(); ctx.arc(cx - hw * 0.08, neckY, hw * 0.06, 0, Math.PI * 2); ctx.fill();   // the clasp
  }
  ctx.restore();
}

// ---------- walking trails ----------
// A trail leaves particles where the fighter walked. Each call site keeps one createTrail() list and spawns
// while its fighter moves; vx lets the website preview scroll them backwards as if walking.
const TRAIL_EVERY_MS = 90, TRAIL_LIFE_MS = 950;
export function createTrail(limit = 400) {
  const parts = [];
  const last = new Map();
  return {
    // key: one per fighter, so the spawn rate holds per fighter. x, y: the feet. size: the fighter's height.
    spawn(key, id, x, y, size, dir, now, vx = 0) {
      if (!COSMETIC_IDS.trail.includes(id) || now - (last.get(key) || 0) < TRAIL_EVERY_MS) return;
      last.set(key, now);
      const seed = now % 997 + parts.length;
      parts.push({ id, x: x - dir * size * 0.18 + (rnd(seed, 1) - 0.5) * size * 0.2, y: y - size * (0.08 + rnd(seed, 2) * 0.45), born: now, size, seed, vx,
        vy: id === 'stars' ? size * 0.25 : id === 'flames' ? -size * 0.35 : -size * (0.3 + rnd(seed, 3) * 0.3) });
      if (parts.length > limit) parts.splice(0, parts.length - limit);
    },
    draw(ctx, now) {
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i], age = now - p.born;
        if (age > TRAIL_LIFE_MS || age < 0) { parts.splice(i, 1); continue; }
        const k = age / TRAIL_LIFE_MS, s = age / 1000;
        drawTrailPart(ctx, p.id, p.x + p.vx * s + Math.sin(p.seed + age / 160) * p.size * (p.id === 'bubbles' || p.id === 'notes' ? 0.04 : 0), p.y + p.vy * s, p.size, k, p.seed, age);
      }
    },
    clear() { parts.length = 0; last.clear(); },
    get size() { return parts.length; },
  };
}
// One still particle for list thumbnails: k is its age (0..1).
export function drawTrailSample(ctx, id, x, y, size) {
  [[0, 0.2, 0.15], [-0.32, 0.45, 0.4], [-0.62, 0.15, 0.65], [-0.9, 0.38, 0.85]].forEach(([ox, oy, k], i) => drawTrailPart(ctx, id, x + ox * size, y - oy * size, size, k, i * 7 + 3, k * 900));
}
function drawTrailPart(ctx, id, x, y, size, k, seed, age) {
  const fade = 1 - k * k, r = size * 0.065;
  ctx.save();
  ctx.globalAlpha = Math.max(0, fade);
  ctx.translate(x, y);
  if (id === 'sparkles') { const tw = 0.6 + 0.4 * Math.sin(age / 70 + seed); star4(ctx, r * 1.3 * tw, '#fff3b0'); }
  else if (id === 'hearts') { heart(ctx, r * (1 - k * 0.3), '#f472b6'); }
  else if (id === 'flames') {
    ctx.fillStyle = k < 0.3 ? '#fde047' : k < 0.6 ? '#fb923c' : '#dc2626';
    ctx.beginPath(); ctx.arc(0, 0, r * (1.2 - k * 0.9), 0, Math.PI * 2); ctx.fill();
  } else if (id === 'bubbles') {
    ctx.strokeStyle = '#8fd8ff'; ctx.lineWidth = Math.max(1, r * 0.25);
    ctx.beginPath(); ctx.arc(0, 0, r * (0.7 + k * 0.5), 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fillRect(-r * 0.35, -r * 0.45, r * 0.25, r * 0.25);
  } else if (id === 'stars') { ctx.rotate(age / 300 + seed); star5(ctx, r * 1.1, '#facc15'); }
  else if (id === 'notes') {
    ctx.fillStyle = ctx.strokeStyle = '#c4b5fd'; ctx.lineWidth = Math.max(1, r * 0.28);
    ctx.beginPath(); ctx.ellipse(0, 0, r * 0.7, r * 0.5, -0.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(r * 0.6, 0); ctx.lineTo(r * 0.6, -r * 2); ctx.quadraticCurveTo(r * 1.4, -r * 1.6, r * 1.3, -r * 0.9); ctx.stroke();
  }
  ctx.restore();
}
function star4(ctx, r, color) {
  ctx.fillStyle = color; ctx.beginPath();
  for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, d = i % 2 ? r * 0.3 : r; ctx.lineTo(Math.cos(a) * d, Math.sin(a) * d); }
  ctx.closePath(); ctx.fill();
}
function star5(ctx, r, color) {
  ctx.fillStyle = color; ctx.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, d = i % 2 ? r * 0.45 : r; ctx.lineTo(Math.cos(a) * d, Math.sin(a) * d); }
  ctx.closePath(); ctx.fill();
}
function heart(ctx, r, color) {
  ctx.fillStyle = color; ctx.beginPath();
  ctx.moveTo(0, r * 0.9);
  ctx.bezierCurveTo(-r * 1.6, -r * 0.2, -r * 0.6, -r * 1.3, 0, -r * 0.45);
  ctx.bezierCurveTo(r * 0.6, -r * 1.3, r * 1.6, -r * 0.2, 0, r * 0.9);
  ctx.fill();
}

// ---------- win effects ----------
// Played over the winner for WIN_EFFECT_MS after a duel. Pure function of the time (k = 0..1) and a seed, so the
// overlay and the preview draw the same thing and a test frame is repeatable.
export const WIN_EFFECT_MS = 3000;
const rnd = (seed, i) => { const v = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453; return v - Math.floor(v); };
const CONFETTI = ['#f87171', '#fbbf24', '#34d399', '#60a5fa', '#c084fc', '#f472b6'];
export function drawWinEffect(ctx, id, x, groundY, size, k, seed = 1) {
  if (!COSMETIC_IDS.effect.includes(id) || !(k >= 0 && k <= 1)) return;
  const sec = k * WIN_EFFECT_MS / 1000, fade = k > 0.8 ? (1 - k) / 0.2 : 1;
  ctx.save();
  if (id === 'confetti') {
    const ox = x, oy = groundY - size * 1.05, g = size * 2.2;
    for (let i = 0; i < 46; i++) {
      const vx = (rnd(seed, i) - 0.5) * size * 2.6, vy = -(size * 1.3 + rnd(seed, i + 50) * size * 1.6);
      const t = Math.min(sec, 2.6), drag = 1 - Math.min(0.6, t * 0.25);
      const px = ox + vx * t * drag + Math.sin(sec * 5 + i) * size * 0.05;
      const py = oy + vy * t * drag + g * t * t / 2 * 0.55;
      if (py > groundY + size * 0.05) continue;
      ctx.globalAlpha = fade;
      ctx.save(); ctx.translate(px, py); ctx.rotate(sec * (3 + rnd(seed, i + 9) * 6) + i);
      ctx.scale(1, Math.cos(sec * 8 + i));
      ctx.fillStyle = CONFETTI[i % CONFETTI.length];
      ctx.fillRect(-size * 0.035, -size * 0.02, size * 0.07, size * 0.04);
      ctx.restore();
    }
  } else if (id === 'fireworks') {
    const colors = ['#fde047', '#f472b6', '#60a5fa'];
    for (let b = 0; b < 3; b++) {
      const start = b * 0.22, local = (k - start) / 0.6;
      if (local < 0 || local > 1) continue;
      const bx = x + (b - 1) * size * 0.85, by = groundY - size * (1.75 + (b % 2) * 0.35);
      if (local < 0.2) {   // the rocket going up
        const q = local / 0.2;
        ctx.fillStyle = '#fff7d6'; ctx.globalAlpha = 1;
        ctx.fillRect(bx - 1.5, groundY - size * 0.6 + (by - groundY + size * 0.6) * q, 3, size * 0.12);
        continue;
      }
      const q = (local - 0.2) / 0.8, radius = size * 0.7 * (1 - Math.pow(1 - q, 3));
      ctx.globalAlpha = Math.max(0, 1 - q) * fade;
      ctx.fillStyle = colors[b];
      for (let i = 0; i < 22; i++) {
        const a = i / 22 * Math.PI * 2 + rnd(seed, b * 30 + i) * 0.2, d = radius * (0.85 + rnd(seed, b * 60 + i) * 0.15);
        const r = Math.max(1.5, size * 0.03 * (1 - q * 0.5));
        ctx.beginPath(); ctx.arc(bx + Math.cos(a) * d, by + Math.sin(a) * d + q * q * size * 0.25, r, 0, Math.PI * 2); ctx.fill();
      }
    }
  } else if (id === 'banner') {
    const unroll = Math.min(1, k / 0.15), w = size * 1.8 * unroll, hgt = size * 0.34, cy = groundY - size * 1.5, tail = hgt * 0.7;
    ctx.globalAlpha = fade;
    ctx.fillStyle = '#b45309';
    for (const s of [-1, 1]) {   // the notched ends behind
      const ex = x + s * (w / 2 + tail * 0.2);
      ctx.beginPath(); ctx.moveTo(ex - s * tail, cy - hgt * 0.3); ctx.lineTo(ex + s * tail * 0.6, cy - hgt * 0.3); ctx.lineTo(ex + s * tail * 0.15, cy + hgt * 0.15);
      ctx.lineTo(ex + s * tail * 0.6, cy + hgt * 0.6); ctx.lineTo(ex - s * tail, cy + hgt * 0.6); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = '#f59e0b'; ctx.fillRect(x - w / 2, cy - hgt / 2, w, hgt);
    ctx.fillStyle = '#fcd34d'; ctx.fillRect(x - w / 2, cy - hgt / 2, w, hgt * 0.14);
    if (unroll === 1) {
      ctx.fillStyle = '#3b1d04';
      ctx.font = '800 ' + Math.round(hgt * 0.62) + 'px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('VICTORY', x, cy + hgt * 0.04, w * 0.9);
      for (let i = 0; i < 6; i++) {   // glints around it
        const a = sec * 2 + i * 1.05, gx = x + Math.cos(a) * w * 0.62, gy = cy + Math.sin(a) * hgt * 1.4;
        ctx.save(); ctx.translate(gx, gy); ctx.globalAlpha = fade * (0.5 + 0.5 * Math.sin(sec * 9 + i)); star4(ctx, size * 0.05, '#fff7d6'); ctx.restore();
      }
    }
  }
  ctx.restore();
}
