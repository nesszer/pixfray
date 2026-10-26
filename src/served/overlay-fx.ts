// Duel effects: hit sparks and glows, the knockout push-in, shakes, floating text, dice, banners and sounds.
import { ctx, DUEL_GROW, FLOOR, fxOn, height, players, size, sound, width } from "./overlay-stage.ts";
import type { Player, Span } from "./overlay-stage.ts";
import { dot } from "./pixels.ts";

// A particle, a spark or a glow; x and y are relative to the owner's lane.
type Fx = { owner: Player; color: string; y: number; born: number; life: number };
type Particle = Fx & { x: number; vx: number; vy: number };
type Glow = Fx & { r: number };
type Banner = Span & { x: number; text: string; title: string; color: string; sub?: string };

const particles: Particle[] = [];
export const glows: Glow[] = []; // light flashes where blows land
export const sparks: Particle[] = []; // bright streaks thrown off by blows; they hold still during hit stop
export const banners: Banner[] = []; // the "Sudden death!" banner above a duel that goes to sudden death
export let push: { x: number; y: number; start: number } | null = null; // knockout push-in: the view zooms toward it
const PUSH = 0.18,
  PUSH_IN = 250,
  PUSH_HOLD = 1600,
  PUSH_OUT = 700;

// Drops the finished items, counting down so splice leaves the indexes still to visit alone.
function prune<T>(list: T[], done: (item: T) => boolean) {
  for (let i = list.length - 1; i >= 0; i--) if (done(list[i]!)) list.splice(i, 1); // i counts down over the list
}

export function burst(p: Player | null, color: string, count: number, rise: boolean) {
  if (!p) return;
  for (let i = 0; i < count; i++) {
    particles.push({
      x: p.x + (Math.random() - 0.5) * size * 0.5,
      y: -size * (p.grow || 1) * (0.3 + Math.random() * 0.5),
      owner: p,
      color,
      vx: (Math.random() - 0.5) * 120,
      vy: rise ? -40 - Math.random() * 60 : -120 - Math.random() * 120,
      born: Date.now(),
      life: 700,
    });
  }
  if (particles.length > 300) particles.splice(0, particles.length - 300);
}
// A landed blow: a flash of light on the target and a spray of sparks away from the attacker.
// power: 1 a normal blow, 2 heavy or crit, 3 the finishing blow.
export function landBlow(target: Player | null, dealer: Player | null, color: string, power: number) {
  if (!fxOn || !target) return;
  const now = Date.now(),
    s = size * (target.grow || 1);
  const dir = dealer ? Math.sign(target.x - dealer.x) || 1 : 0;
  glows.push({ owner: target, color, y: -s * 0.55, r: s * (0.6 + 0.25 * power), born: now, life: 200 + 90 * power });
  for (let i = 0, n = 6 + power * 7; i < n; i++) {
    const a = (Math.random() - 0.5) * 2.2 - 0.4,
      speed = (220 + Math.random() * 320) * (0.7 + power * 0.2);
    const side = dir || (Math.random() < 0.5 ? -1 : 1);
    sparks.push({
      owner: target,
      color,
      x: target.x,
      y: -s * (0.4 + Math.random() * 0.3),
      vx: Math.cos(a) * speed * side,
      vy: Math.sin(a) * speed,
      born: now,
      life: 320 + Math.random() * 260,
    });
  }
  if (sparks.length > 240) sparks.splice(0, sparks.length - 240);
  if (power >= 2 && !(target.shake && now < target.shake.until))
    target.shake = { start: now, until: now + 220, mag: 4 };
}
// The knockout: the fallen fighter shakes hard, and the view pushes in on it, holds, and eases back.
export function knockout(p: Player | null, at: number) {
  if (!fxOn || !p) return;
  p.shake = { start: at, until: at + 450, mag: 9 };
  push = { x: p.x, y: height - FLOOR - p.lane, start: at };
}
// Only the struck fighter shakes, side to side on a smooth curve that dies out. Shaking the whole stage by a random
// offset each frame moved every nameplate and bubble over a still game, and on stream that read as the overlay lagging.
export function shakeOffset(p: Player, clock: number) {
  const k = p.shake;
  if (!k || clock >= k.until) return 0;
  const t = clock - k.start;
  return t < 0 ? 0 : k.mag * (1 - t / (k.until - k.start)) * Math.sin((t / 70) * Math.PI * 2);
}
export function pushZoom(clock: number) {
  if (!push) return 1;
  const t = clock - push.start,
    ease = (u: number) => u * u * (3 - 2 * u);
  if (t < 0) return 1;
  if (t < PUSH_IN) return 1 + PUSH * (1 - (1 - t / PUSH_IN) ** 3);
  if (t < PUSH_IN + PUSH_HOLD) return 1 + PUSH;
  if (t < PUSH_IN + PUSH_HOLD + PUSH_OUT) return 1 + PUSH * (1 - ease((t - PUSH_IN - PUSH_HOLD) / PUSH_OUT));
  push = null;
  return 1;
}
export function floatText(p: Player | null, text: string, color: string, life = 1200) {
  if (p) p.floatText = { text, color, life, until: Date.now() + life };
}
// Outlined game text: the current stroke under the current fill.
export function outlined(text: string, x: number, y: number, maxWidth?: number) {
  ctx.strokeText(text, x, y, maxWidth);
  ctx.fillText(text, x, y, maxWidth);
}
// &sound=1: short synthesized blips, no audio files. Browsers and OBS allow this without a click.
let audio: AudioContext | null = null;
export function playSound(kind: "hit" | "parry" | "ko" | "miss") {
  if (!sound) return;
  try {
    audio ||= new AudioContext();
    const t = audio.currentTime,
      gain = audio.createGain();
    gain.connect(audio.destination);
    if (kind === "miss") {
      const len = Math.floor(audio.sampleRate * 0.22),
        buffer = audio.createBuffer(1, len, audio.sampleRate),
        data = buffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.sin((Math.PI * i) / len);
      const src = audio.createBufferSource(),
        band = audio.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.setValueAtTime(700, t);
      band.frequency.exponentialRampToValueAtTime(2600, t + 0.22);
      src.buffer = buffer;
      src.connect(band);
      band.connect(gain);
      gain.gain.value = 0.12;
      src.start(t);
      return;
    }
    const [type, from, to, dur, vol] = (
      {
        hit: ["square", 190, 55, 0.13, 0.07],
        parry: ["triangle", 1100, 1500, 0.09, 0.08],
        ko: ["sawtooth", 240, 50, 0.6, 0.06],
      } satisfies Record<string, [OscillatorType, number, number, number, number]>
    )[kind];
    const osc = audio.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  } catch {
    /* No audio is fine. */
  }
}

// Die face above the fighter who rolled: it tumbles for a moment, then settles on the rolled value.
// The pips of each face as cells of a 3x3 grid, read left to right and top to bottom.
const PIPS = ["", "4", "08", "048", "0268", "02468", "023568"];
function drawDie(p: Player, x: number, y: number, s: number, now: number) {
  const d = p.die;
  if (!d || now >= d.until) return;
  const age = now - d.start,
    rolling = age < 350;
  const value = rolling ? 1 + (Math.floor(age / 60 + p.phase) % 6) : d.value;
  const side =
    34 * (rolling ? 0.85 + 0.15 * Math.sin(age / 35) : Math.min(1.15, 1 + Math.max(0, (420 - age) / 400) * 0.15));
  ctx.save();
  ctx.globalAlpha = Math.min(1, (d.until - now) / 250);
  ctx.translate(x, y - s - 66);
  if (rolling) ctx.rotate(Math.sin(age / 40) * 0.5);
  ctx.fillStyle = d.value === 6 && !rolling ? "#fde047" : "#ffffff";
  ctx.strokeStyle = "rgba(0,0,0,.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(-side / 2, -side / 2, side, side, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#111827";
  // value is a whole number from 1 to 6, and PIPS has all six
  for (const cell of PIPS[value]!) {
    const n = Number(cell);
    dot(ctx, ((n % 3) - 1) * side * 0.27, (Math.floor(n / 3) - 1) * side * 0.27, side * 0.09);
  }
  ctx.restore();
}
// The look of a blow (the fighter's default ability): stroke color, line width and path, at progress t from 0 to 1.
type Strike = [string, number, (x: number, y: number, s: number, t: number) => void];
const STRIKES: Partial<Record<string, Strike>> = {
  slash: [
    "#ffffff",
    5,
    (x, y, s, t) =>
      ctx.arc(
        x - s * 0.35,
        y - s * 0.35,
        s * 0.55,
        -Math.PI * 0.55,
        -Math.PI * 0.55 + Math.PI * 0.7 * Math.min(1, t * 2.5),
      ),
  ],
  smash: [
    "#f97316",
    5,
    (x, y, s, t) => ctx.ellipse(x, y - 2, s * (0.3 + t * 0.7), s * 0.1 * (1 + t), 0, 0, Math.PI * 2),
  ],
};
const GLOW: Strike = ["#4ade80", 4, (x, y, s, t) => ctx.arc(x, y - s * 0.5, s * (0.35 + t * 0.35), 0, Math.PI * 2)];
// A blow's look, a parry flash and a miss whoosh.
function drawStrikeFx(p: Player, x: number, y: number, s: number, now: number) {
  const fade = (fx: Span) => Math.max(0, Math.min(1, (now - fx.start) / (fx.until - fx.start)));
  ctx.save();
  ctx.lineCap = "round";
  if (p.fx && now >= p.fx.start && now < p.fx.until) {
    const t = fade(p.fx),
      [color, lineWidth, path] = STRIKES[p.fx.look] || GLOW;
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    path(x, y, s, t);
    ctx.stroke();
  }
  if (p.parry && now >= p.parry.start && now < p.parry.until) {
    const t = fade(p.parry),
      cx = x + p.direction * s * 0.35,
      cy = y - s * 0.6;
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = "#fde68a";
    ctx.lineWidth = 4;
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4,
        r0 = s * 0.08,
        r1 = s * (0.2 + t * 0.25);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
    }
  }
  if (p.whoosh && now >= p.whoosh.start && now < p.whoosh.until) {
    const t = fade(p.whoosh);
    ctx.globalAlpha = 0.8 * (1 - t);
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 3;
    for (let i = 0; i < 3; i++) {
      const cx = x + p.direction * s * (0.45 + t * 0.5),
        cy = y - s * (0.35 + i * 0.18);
      ctx.beginPath();
      ctx.moveTo(cx - p.direction * s * (0.5 - i * 0.08), cy);
      ctx.lineTo(cx, cy);
      ctx.stroke();
    }
  }
  ctx.restore();
}
export function drawBanners(now: number) {
  prune(banners, (b) => now >= b.until);
  for (const b of banners) {
    // Outlined game text like the hit numbers, no box: it pops in a little large, settles, and fades out rising.
    const age = now - b.start,
      t = Math.min(1, age / 220),
      out = Math.max(0, 1 - (b.until - now) / 300);
    const pop = 1 + 0.35 * (1 - t) * (1 - t) - 0.06 * Math.sin(Math.PI * t);
    ctx.save();
    ctx.globalAlpha = Math.min(1, age / 80) * (1 - out);
    ctx.font = "800 34px system-ui, sans-serif";
    const w = Math.min(width - 16, ctx.measureText(b.title).width + 16),
      x = Math.max(w / 2 + 8, Math.min(width - w / 2 - 8, b.x));
    const top = height - FLOOR - 28 - size * DUEL_GROW - 150 - out * 8;
    ctx.translate(x, top + 24);
    ctx.scale(pop, pop);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 7;
    ctx.strokeStyle = "rgba(10,12,20,.92)";
    ctx.fillStyle = b.color;
    outlined(b.title, 0, 0, w);
    if (b.sub) {
      ctx.font = "800 17px system-ui, sans-serif";
      ctx.lineWidth = 5;
      ctx.fillStyle = "#fbbf24";
      outlined(b.sub, 0, 28, w);
    }
    ctx.restore();
  }
}
// The ring color an animation flashes around its fighter.
const RING: Partial<Record<string, string>> = { heal: "#4ade80", hit: "#fb7185", respawn: "#bfdbfe" };
export function drawEffects(p: Player, x: number, y: number, now: number, s: number, animNow: number) {
  const anim = p.anim && animNow < p.anim.until ? p.anim : null;
  const ring = anim && RING[anim.kind];
  if (anim && ring) {
    const t = Math.max(0, Math.min(1, (animNow - anim.start) / (anim.until - anim.start)));
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = ring;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y - s * 0.55, s * (0.4 + t * 0.25), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  drawStrikeFx(p, x, y, s, now);
  if (p.floatText && now < p.floatText.until) {
    const t = 1 - (p.floatText.until - now) / p.floatText.life;
    ctx.save();
    ctx.globalAlpha = Math.min(1, 2 - t * 2);
    ctx.font = "bold 28px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(0,0,0,.85)";
    ctx.fillStyle = p.floatText.color;
    outlined(p.floatText.text, x, y - s - 46 - t * 30);
    ctx.restore();
  }
  drawDie(p, x, y, s, now);
}
export function drawParticles(now: number, dt: number) {
  prune(particles, (s) => now - s.born > s.life || !players.has(s.owner.key));
  for (const s of particles) {
    s.vy += 380 * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    ctx.globalAlpha = 1 - (now - s.born) / s.life;
    ctx.fillStyle = s.color;
    ctx.fillRect(s.x - 3, height - FLOOR - s.owner.lane + s.y - 3, 6, 6);
  }
  ctx.globalAlpha = 1;
}
// Glows and sparks add light (on a transparent overlay that brightens whatever is behind it), so their order is free.
export function drawImpacts(now: number, dt: number) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  prune(glows, (g) => now - g.born >= g.life || !players.has(g.owner.key));
  for (const g of glows) {
    const t = (now - g.born) / g.life,
      x = g.owner.x,
      y = height - FLOOR - g.owner.lane + g.y,
      r = g.r * (0.7 + 0.3 * t);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "#ffffff");
    grad.addColorStop(0.2, g.color);
    grad.addColorStop(1, g.color + "00");
    ctx.globalAlpha = 0.75 * (1 - t) ** 2;
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.lineCap = "square";
  prune(sparks, (k) => now - k.born > k.life || !players.has(k.owner.key));
  for (const k of sparks) {
    const o = k.owner,
      age = now - k.born;
    if (o.stopUntil && now >= o.stopStart && now < o.stopUntil) k.born += dt * 1000; // hit stop: hold still, don't age
    else {
      k.vy += 900 * dt;
      k.vx *= 1 - 3 * dt;
      k.vy *= 1 - 3 * dt;
      k.x += k.vx * dt;
      k.y += k.vy * dt;
    }
    const x = k.x,
      y = height - FLOOR - o.lane + k.y,
      f = 1 - age / k.life;
    ctx.globalAlpha = f;
    ctx.strokeStyle = k.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - k.vx * 0.035, y - k.vy * 0.035);
    ctx.stroke();
    if (f > 0.5) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - k.vx * 0.015, y - k.vy * 0.015);
      ctx.stroke();
    }
  }
  ctx.restore();
}
