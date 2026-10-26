// The frame loop: fighters with their cosmetics, health bars, nameplates, chat bubbles and the announcement lines.
import {
  createTrail,
  drawAccessory,
  drawWinEffect,
  recoloredFrame,
  recolorFilter,
  TITLES,
  WIN_EFFECT_MS,
} from "./cosmetics.ts";
import { drawHat } from "./hats.ts";
import { drawPet } from "./pets.ts";
import { parseDemoMessage, warnOnce } from "./parse.ts";
import type { ArenaDuel } from "./parse.ts";
import { readableColor, truncateText } from "./text.ts";
import {
  arena,
  ctx,
  demo,
  DUEL_GROW,
  duelFor,
  FLOOR,
  height,
  players,
  replayRatings,
  size,
  width,
} from "./overlay-stage.ts";
import type { Player, WinFx } from "./overlay-stage.ts";
import { frameFor, petArt, sprites } from "./overlay-sprites.ts";
import {
  drawBanners,
  drawEffects,
  drawImpacts,
  drawParticles,
  outlined,
  push,
  pushZoom,
  shakeOffset,
} from "./overlay-fx.ts";
import { barWidthOf, liveAnnouncements } from "./overlay-duels.ts";
import { duelZones, LABEL_ROW, moveFighter } from "./overlay-move.ts";
import { updateStatus } from "./overlay-sync.ts";

type Box = { lo: number; hi: number; top: number; bottom: number };
type Label = { text: string; color: string; x: number; y: number; w: number; rank: number; title: string };
type Bubble = { text: string; x: number; top: number; w: number; until: number };

const TITLE_ROW = 16,
  BUBBLE_H = 25;
const trail = createTrail(); // walking trails, in screen space
let lastFrame = performance.now(),
  lastCleanup = 0;

function healthOf(p: Player, duel: ArenaDuel | null) {
  if (!duel || duel.status !== "active") return null;
  const current = Number(duel.hp?.[p.userId]);
  if (!Number.isFinite(current)) return null;
  const max = Number(duel.maxHp?.[p.userId] ?? duel.rules?.maxHp ?? arena.config?.maxHp ?? 100);
  return { current: Math.max(0, current), max: Math.max(1, Number.isFinite(max) ? max : 100) };
}
function drawFallback(p: Player, x: number, y: number, time: number) {
  const step = Math.sin(time * 0.012 + p.phase) * 3;
  ctx.fillStyle = p.color;
  ctx.fillRect(x - 11, y - 31, 22, 22);
  ctx.fillRect(x - 8, y - 12, 6, 12 + step);
  ctx.fillRect(x + 2, y - 12, 6, 12 - step);
  ctx.beginPath();
  ctx.arc(x, y - 39, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x + p.direction * 3 - 5, y - 42, 3, 4);
  ctx.fillRect(x + p.direction * 3 + 2, y - 42, 3, 4);
}
function drawHealthBar(x: number, y: number, health: { current: number; max: number }, s: number) {
  const barWidth = barWidthOf(s);
  const left = x - barWidth / 2;
  const top = y - s - 20;
  const ratio = Math.max(0, Math.min(1, health.current / health.max));
  ctx.fillStyle = "rgba(9,12,18,.86)";
  ctx.fillRect(left - 2, top - 2, barWidth + 4, 12);
  ctx.fillStyle = ratio > 0.55 ? "#4ade80" : ratio > 0.25 ? "#fbbf24" : "#fb7185";
  ctx.fillRect(left, top, barWidth * ratio, 8);
  ctx.strokeStyle = "rgba(255,255,255,.72)";
  ctx.lineWidth = 1;
  ctx.strokeRect(left, top, barWidth, 8);
  ctx.font = "bold 16px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,.9)";
  ctx.fillStyle = "#e2e8f0";
  outlined(Math.round(health.current) + "/" + Math.round(health.max), x, top - 5);
}
function drawAnnouncement() {
  const lines = liveAnnouncements();
  if (!lines.length || arena.announce === "off") return;
  const above = height - FLOOR - 28 - size * DUEL_GROW - 150 - 64; // clear of the win effects and the fighters
  ctx.save();
  ctx.font = "700 24px system-ui, sans-serif";
  ctx.textAlign = "center";
  lines.forEach((line, i) => {
    const top = arena.announce === "bottom" ? Math.max(8, above - (lines.length - 1 - i) * 56) : 26 + i * 56;
    const boxWidth = Math.min(width - 24, Math.max(260, ctx.measureText(line.text).width + 40));
    const left = (width - boxWidth) / 2;
    ctx.fillStyle = "rgba(12,16,25,.82)";
    ctx.fillRect(left, top, boxWidth, 48);
    ctx.strokeStyle = "rgba(255,255,255,.2)";
    ctx.strokeRect(left, top, boxWidth, 48);
    ctx.fillStyle = line.color;
    ctx.fillText(line.text, width / 2, top + 33, boxWidth - 24);
  });
  ctx.restore();
}
// Hit stop: a fighter's animation clock pauses while a blow lands, then the animation carries on where it stopped.
function animClock(p: Player, clock: number) {
  if (!p.stopUntil || clock < p.stopStart) return clock;
  if (clock < p.stopUntil) return p.stopStart;
  if (p.anim && p.anim.until > p.stopStart) {
    const d = p.stopUntil - p.stopStart;
    p.anim = { ...p.anim, start: p.anim.start + d, until: p.anim.until + d };
  }
  p.stopUntil = 0;
  return clock;
}

const nameColors = new Map<string, string>(); // chat color -> readable nameplate color, computed once per color
export const nameColor = (color: string) => {
  let out = nameColors.get(color);
  if (out === undefined) {
    if (nameColors.size > 500) nameColors.clear();
    out = readableColor(color);
    nameColors.set(color, out);
  }
  return out;
};
const overlaps = (a: Box, b: Box) => a.lo < b.hi && a.hi > b.lo && a.top < b.bottom && a.bottom > b.top;
// Nameplates and bubbles are laid out after every fighter has moved, so none overlap or leave the screen. Nameplates:
// duelists first, then the most recent chatters; one that would cover a placed nameplate is skipped this frame.
// Bubbles: the oldest keeps its spot, newer ones stack up to three high above it, clear of duel health bars.
function drawLabels(labels: Label[], bubbles: Bubble[], bars: Box[]) {
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "bold 20px system-ui, sans-serif";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(0,0,0,.85)";
  const placed: Box[] = [];
  for (const l of labels.sort((a, b) => b.rank - a.rank)) {
    const x = Math.max(l.w / 2 + 4, Math.min(width - l.w / 2 - 4, l.x));
    if (l.title) l.y = Math.min(l.y, height - TITLE_ROW - 5); // a fighter on a low lane lifts its nameplate so the title stays on screen
    const box = {
      lo: x - l.w / 2 - 4,
      hi: x + l.w / 2 + 4,
      top: l.y - LABEL_ROW + 2,
      bottom: l.y + 2 + (l.title ? TITLE_ROW : 0),
    };
    if (placed.some((o) => overlaps(box, o))) continue;
    placed.push(box);
    ctx.fillStyle = l.color;
    outlined(l.text, x, l.y);
    if (l.title) {
      ctx.font = "bold 14px system-ui, sans-serif";
      ctx.lineWidth = 3;
      ctx.fillStyle = "#fde68a";
      outlined(l.title, x, l.y + TITLE_ROW);
      ctx.font = "bold 20px system-ui, sans-serif";
      ctx.lineWidth = 4;
    }
  }
  ctx.font = "bold 14px system-ui, sans-serif";
  const stacked = [...bars];
  for (const b of bubbles.sort((a, c) => a.until - c.until)) {
    const x = Math.max(b.w / 2, Math.min(width - b.w / 2, b.x));
    for (let level = 0; level < 3; level++) {
      const top = b.top - level * (BUBBLE_H + 4),
        box = { lo: x - b.w / 2 - 2, hi: x + b.w / 2 + 2, top, bottom: top + BUBBLE_H };
      if (stacked.some((o) => overlaps(box, o))) continue;
      stacked.push(box);
      ctx.fillStyle = "rgba(18,18,26,.88)";
      ctx.fillRect(x - b.w / 2, top, b.w, BUBBLE_H);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(b.text, x, top + 18, Math.max(1, b.w - 8));
      break;
    }
  }
  ctx.restore();
}

// Draws one fighter (pet, trail, body, hat, accessory) at its feet position; the canvas state is restored after.
function drawFighter(p: Player, y: number, s: number, clock: number, now: number, ac: number, moving: boolean) {
  const ko = p.koUntil > clock;
  const sprite = sprites.get(p.renderAvatar) || sprites.get(p.avatar);
  const anim = p.anim && ac < p.anim.until ? p.anim : null;
  const progress = anim ? (ac - anim.start) / (anim.until - anim.start) : 0;
  // Lunge for attacks, knockback for hits; both are fallbacks that also run on top of drawn frames.
  let offset = 0;
  if (anim?.kind === "attack" && progress > 0)
    offset = Math.sin(progress * Math.PI) * s * (anim.heavy ? 0.45 : 0.3) * p.direction;
  if (anim?.kind === "hit" && progress > 0)
    offset = -Math.sin(progress * Math.PI) * s * (anim.heavy ? 0.3 : 0.16) * p.direction;
  if (anim?.kind === "dodge" && progress > 0) offset = -Math.sin(progress * Math.PI) * s * 0.4 * p.direction;
  offset += shakeOffset(p, clock);
  // The pet trots behind its fighter, drawn first so the fighter stays in front.
  if (p.pet) {
    drawPet(ctx, petArt(p.pet), p.x - p.direction * s * 0.55, y, s * 0.42, {
      facing: p.direction,
      t: clock + p.phase,
      moving,
      tier: p.petTier,
      tint: recolorFilter(p.petColor) || "none",
    });
  }
  if (p.trail && moving && !ko) trail.spawn(p.key, p.trail, p.x, y, s, p.direction, clock);
  ctx.save();
  if (sprite?.loaded) {
    const { frame, drawn } = frameFor(sprite, p, ac, moving);
    const single = sprite.mode === "single" || sprite.frames.length === 1;
    const bob = single && moving ? Math.abs(Math.sin((clock + p.phase) / 140)) * s * 0.06 : 0;
    const squash = single && moving ? 1 + Math.sin((clock + p.phase) / 70) * 0.04 : 1;
    const h = s * (sprite.fit || 1),
      w = (h * frame.w) / frame.h;
    ctx.translate(p.x + offset, y - bob);
    if (ko && !drawn) {
      const fall = Math.min(1, (clock - (p.koStart || clock - 400)) / 400);
      ctx.globalAlpha = 0.55;
      ctx.rotate((-p.direction * fall * Math.PI) / 2);
    }
    const flash =
      anim?.kind === "hit" && progress > 0 && progress < 0.6
        ? "brightness(2.2) saturate(0.4)"
        : anim?.kind === "attack" && !drawn && progress > 0
          ? "brightness(1.35)"
          : "";
    ctx.scale(p.direction / squash, squash); // sources face right; mirror left walking
    const look = { headHint: sprite.head, t: clock + p.phase, moving };
    const place = [sprite.image, frame, -w / 2, -h, w, h] as const; // as const: a fixed tuple spread into the draw calls
    // The recolor and the hit flash tint the body only, from a cached tinted frame: ctx.filter on the stage costs a
    // filter pass over the whole 1920x1080 canvas, felt on stream as a hitch on every hit. A cape hangs behind the body.
    if (p.accessory) drawAccessory(ctx, p.accessory, ...place, { ...look, layer: "back" });
    const body = recoloredFrame(sprite.image, frame, p.recolor, flash);
    if (body) ctx.drawImage(body, 0, 0, body.width, body.height, -w / 2, -h, w, h);
    else ctx.drawImage(sprite.image, frame.x, frame.y, frame.w, frame.h, -w / 2, -h, w, h);
    if (p.hat) drawHat(ctx, p.hat, ...place, sprite.head);
    if (p.accessory) drawAccessory(ctx, p.accessory, ...place, look);
  } else {
    if (ko) ctx.globalAlpha = 0.5;
    ctx.translate(p.x + offset, y);
    ctx.scale(p.grow ?? 1, p.grow ?? 1); // draw() sets grow before it draws the fighter
    drawFallback(p, 0, 0, now);
  }
  ctx.restore();
}

function draw(now: number) {
  if (demoPaused) {
    drawing = false;
    return;
  }
  if (demo && now - lastFrame < 30) {
    requestAnimationFrame(draw);
    return;
  }
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  const clock = Date.now();
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  const zoom = pushZoom(clock);
  if (push && zoom !== 1) {
    ctx.translate(push.x, push.y);
    ctx.scale(zoom, zoom);
    ctx.translate(-push.x, -push.y);
  }
  if (clock - lastCleanup > 1000) {
    for (const [key, p] of players) if (!p.fromArena && clock - p.lastSeen > 600000) players.delete(key);
    lastCleanup = clock;
    updateStatus();
  }
  const labels: Label[] = [],
    bubbles: Bubble[] = [],
    bars: Box[] = [],
    wins: { fx: WinFx; x: number; y: number; s: number }[] = [];
  trail.draw(ctx, clock); // behind every fighter
  const zones = duelZones();
  for (const p of players.values()) {
    const duel = duelFor(p);
    const moving = moveFighter(p, duel, clock, dt, zones);
    const y = height - FLOOR - p.lane + p.y;
    const grow = duel?.status === "active" || p.bigUntil > clock ? DUEL_GROW : 1;
    p.grow = (p.grow || 1) + (grow - (p.grow || 1)) * Math.min(1, dt * 6);
    const s = size * p.grow;
    const ac = animClock(p, clock);
    drawFighter(p, y, s, clock, now, ac, moving);
    drawEffects(p, p.x, y, clock, s, ac);
    const health = healthOf(p, duel);
    if (health) {
      drawHealthBar(p.x, y, health, s);
      const half = barWidthOf(s) / 2 + 4; // the bar and its "hp/max" text: bubbles stay clear
      bars.push({ lo: p.x - half, hi: p.x + half, top: y - s - 40, bottom: y - s - 8 });
    }
    ctx.font = "bold 20px system-ui, sans-serif";
    const shownElo = replayRatings(p.userId)?.before ?? p.arenaProfile?.elo;
    const ranked = p.arenaProfile?.registered;
    const text = ranked && Number.isFinite(Number(shownElo)) ? p.label + " · " + Math.round(Number(shownElo)) : p.label;
    p.labelWidth = ctx.measureText(text).width;
    const title = ranked ? TITLES[p.title] || "" : "";
    labels.push({
      text,
      color: nameColor(p.color),
      x: p.x,
      y: y + 23,
      w: p.labelWidth,
      rank: duel ? Infinity : p.lastSeen,
      title,
    });
    if (p.winFx && clock - p.winFx.start < WIN_EFFECT_MS) wins.push({ fx: p.winFx, x: p.x, y, s });
    else p.winFx = null;
    if (p.text && clock < p.bubbleUntil && !health) {
      ctx.font = "bold 14px system-ui, sans-serif";
      if (p.shortFor !== p.text) {
        p.shortFor = p.text;
        p.short = truncateText(p.text, 38, "…"); // cut once per message, by whole characters
      }
      const w = Math.min(width, ctx.measureText(p.short).width + 16);
      bubbles.push({ text: p.short, x: p.x, top: y - s - 33, w, until: p.bubbleUntil });
    }
  }
  drawLabels(labels, bubbles, bars);
  drawParticles(clock, dt);
  drawImpacts(clock, dt);
  for (const w of wins) drawWinEffect(ctx, w.fx.id, w.x, w.y, w.s, (clock - w.fx.start) / WIN_EFFECT_MS, w.fx.seed);
  drawBanners(clock);
  ctx.restore();
  drawAnnouncement();
  requestAnimationFrame(draw);
}

// The demo embedded on the site (?demo=1) draws at 30 fps and stops while its page scrolls it out of view (the page
// posts { demoPaused }); the overlay on stream keeps the full frame rate.
let demoPaused = false,
  drawing = true;
export function startDrawing() {
  if (demo)
    addEventListener("message", (e) => {
      if (e.origin !== location.origin) return; // another site's message: not for the demo
      const message = parseDemoMessage(e.data);
      if (!message) return; // not the demo's message (an extension's, say)
      if (!message.ok) return warnOnce("a demo message", message.error);
      demoPaused = message.value.demoPaused;
      if (!demoPaused && !drawing) {
        drawing = true;
        lastFrame = performance.now();
        requestAnimationFrame(draw);
      }
    });
  requestAnimationFrame(draw);
}
