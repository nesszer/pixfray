// Duels on stage: the arena events played one beat at a time, the announcement lines, and where each duel meets.
import { TAUNTS } from "./cosmetics.ts";
import { clipName, truncateText } from "./text.ts";
import type { ArenaDuel, ArenaEvent } from "./parse.ts";
import {
  arena,
  bubblesOn,
  DUEL_GROW,
  findPlayer,
  inReplay,
  KO_HOLD_MS,
  meetPoints,
  profilesById,
  replays,
  size,
  width,
} from "./overlay-stage.ts";
import type { Meet, Player } from "./overlay-stage.ts";
import { banners, burst, floatText, knockout, landBlow, playSound } from "./overlay-fx.ts";
import { updateStatus } from "./overlay-sync.ts";

type DuelQueue = { items: { event: ArenaEvent; received: number }[]; busy: boolean };

// Arena events (docs/CONTRACTS.md section 3) older than this are history from the first snapshot, not news.
const EVENT_FRESH_MS = 10_000;
const CANCEL_TEXT: Record<string, string> = {
  inactivity: "no action for a while",
  chat_disconnected: "chat offline",
  duels_disabled: "duels turned off",
  moderator_cancelled: "cancelled by a moderator",
  moderator_reset: "reset by a moderator",
  player_removed: "player removed",
};

// Top banner lines: one per duel id and one for the arena; a newer line for the same key replaces the old one.
const announcements: { key: string; text: string; color: string; until: number }[] = [];
function announceArena(text: string, color = "#fde68a", key = "arena") {
  if (!text) return;
  const i = announcements.findIndex((a) => a.key === key);
  if (i >= 0) announcements.splice(i, 1);
  announcements.push({ key, text: truncateText(text, 100), color, until: Date.now() + 5500 });
  if (announcements.length > 3) announcements.shift();
}
export const liveAnnouncements = () => announcements.filter((a) => Date.now() < a.until);
const nameOf = (id: unknown) => {
  const profile = profilesById.get(String(id));
  return clipName(profile?.displayName || profile?.username || "Player");
};
const signed = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n);

// A quick-duel roll (an event with a die) pops above the fighter who rolled, then plays out. A counter is the
// defender answering a bad roll, so the die belongs to its target.
const ROLL_REVEAL_MS = 450,
  IMPACT_MS = 200;
function playRoll(event: ArenaEvent, replay: ArenaDuel | undefined) {
  const now = Date.now();
  const dealer = findPlayer(event.userId),
    target = findPlayer(event.targetId);
  const roller = event.counter ? target : dealer,
    other = event.counter ? dealer : target;
  // playRoll runs only for events whose die passed Number.isFinite
  if (roller) roller.die = { value: Math.max(1, Math.min(6, Math.round(event.die!))), start: now, until: now + 1000 };
  if (replay) {
    replay.rolls = (replay.rolls || 0) + 1;
    if (replay.rolls === 13)
      banners.push({
        x: meetPoints.get(replay.id)?.x ?? roller?.x ?? width / 2,
        text: "Sudden death!",
        title: "Sudden death!",
        color: "#fde047",
        start: now,
        until: now + 1200,
      });
  }
  const showHp = () => {
    if (replay && event.hp && typeof event.hp === "object") replay.hp = { ...event.hp };
  }; // the bar moves when the blow lands
  setTimeout(() => {
    const t = Date.now(),
      look = event.ability === "heavy" ? "smash" : event.ability === "heal" ? "glow" : "slash";
    if (event.miss) {
      if (roller) {
        roller.anim = { kind: "attack", start: t, until: t + 450 };
        roller.whoosh = { start: t + 80, until: t + 480 };
      }
      if (other) other.anim = { kind: "dodge", start: t + 60, until: t + 600 };
      floatText(other, event.dodged ? "DODGE" : "MISS", "#e2e8f0");
      showHp();
      playSound("miss");
      return;
    }
    let swing = t;
    if (event.counter && dealer) {
      // a dodge that turned into a counter shows the dodge first
      const parry = event.dodged ? t + 300 : t;
      if (event.dodged) {
        dealer.anim = { kind: "dodge", start: t, until: t + 300 };
        floatText(dealer, "DODGE", "#e2e8f0");
      }
      dealer.parry = { start: parry, until: parry + 380 };
      setTimeout(() => floatText(dealer, "COUNTER", "#fbbf24"), parry - t);
      swing = parry + 300;
      playSound("parry");
    }
    const heavy = look === "smash" || event.crit === true,
      impact = swing + IMPACT_MS,
      stop = event.finisher ? 260 : 80;
    if (dealer) dealer.anim = { kind: "attack", heavy, start: swing, until: swing + 450 };
    if (target) target.anim = { kind: "hit", heavy, start: impact, until: impact + 400 };
    if (look === "glow" && dealer) dealer.fx = { look: "aura", start: swing, until: swing + 600 };
    for (const f of [dealer, target])
      if (f) {
        f.stopStart = impact;
        f.stopUntil = impact + stop;
      }
    setTimeout(
      () => {
        const at = Date.now(),
          amount = Number(event.amount) || 0;
        showHp();
        if (target) target.fx = { look, start: at, until: at + 450 };
        const color = event.crit ? "#fde047" : look === "smash" ? "#f97316" : look === "glow" ? "#4ade80" : "#fb7185";
        burst(target, color, event.crit || event.finisher ? 22 : 10, false);
        landBlow(target, dealer, color, event.finisher ? 3 : heavy ? 2 : 1);
        const label = `${event.luckyCrit ? "LUCKY CRIT " : event.crit ? "CRIT! " : ""}-${amount}`;
        floatText(target, label, event.crit ? "#fde047" : "#fb7185");
        if (event.finisher && target) {
          knockout(target, at);
          if (!(target.koUntil > at)) target.koStart = at;
          target.koUntil = target.koHoldUntil = Math.max(target.koUntil || 0, at + KO_HOLD_MS + 1500);
        }
        playSound(event.finisher ? "ko" : "hit");
      },
      Math.max(0, impact - Date.now()),
    );
  }, ROLL_REVEAL_MS);
}
// A quick duel arrives at once and plays one beat at a time: the walk to meet, about 1.8 s per roll, and the result
// once the knockout has landed.
const DUEL_EVENT_GAP_MS: { [type: string]: number; duel_started: number; duel_action: number } = {
  duel_started: 700,
  duel_action: 1800,
};
const FINISHER_GAP_MS = 1300;
const DUEL_WALK_MS = 2000; // longest walk to the meet point; far-apart fighters walk faster
export const duelQueues = new Map<string, DuelQueue>();
// The fighter's knockout is queued but not played yet (a finishing blow or the result of a duel still in the queue).
const pendingKnockout = (p: Player) =>
  [...duelQueues.values()].some((q) =>
    q.items.some(
      ({ event: e }) =>
        (e.type === "duel_action" && e.finisher && String(e.targetId) === p.userId) ||
        (e.type === "duel_completed" && String(e.loserId) === p.userId),
    ),
  );
export function queueArenaEvent(event: ArenaEvent) {
  const id = event.duelId;
  if (!id) return handleArenaEvent(event);
  let q = duelQueues.get(id);
  if (!q) duelQueues.set(id, (q = { items: [], busy: false }));
  q.items.push({ event, received: Date.now() });
  if (!q.busy) pumpDuel(id, q);
}
function pumpDuel(id: string, q: DuelQueue) {
  const item = q.items.shift();
  if (!item) {
    q.busy = false;
    duelQueues.delete(id);
    return;
  }
  q.busy = true;
  const { event, received } = item,
    waited = Date.now() - received;
  handleArenaEvent(waited && Number.isFinite(event.at) ? { ...event, at: event.at + waited } : event);
  const gap =
    event.type === "duel_started"
      ? Math.max(DUEL_EVENT_GAP_MS.duel_started, (meetPoints.get(id)?.walkMs || 0) + 200)
      : event.type === "duel_action" && event.finisher && Number.isFinite(event.die)
        ? FINISHER_GAP_MS
        : DUEL_EVENT_GAP_MS[event.type] || 0;
  if (gap) setTimeout(() => pumpDuel(id, q), gap);
  else pumpDuel(id, q);
}
// Events that only announce a line: its text and color, or null for no line.
const ANNOUNCED: Partial<Record<string, (event: ArenaEvent) => [string, string?] | null>> = {
  challenge_created: (e) => [`${nameOf(e.a)} challenges ${nameOf(e.b)} to a duel`],
  challenge_declined: (e) => [`${nameOf(e.declinedBy)} declined the duel`, "#e2e8f0"],
  challenge_expired: (e) => [`Challenge to ${nameOf(e.b)} expired`, "#e2e8f0"],
  // !: a missing reason reads the key "undefined", which falls through to "not scored"
  duel_cancelled: (e) => [`Duel cancelled · ${CANCEL_TEXT[e.reason!] || "not scored"}`, "#e2e8f0"],
  chat_disconnected: () => ["Duels paused · chat offline", "#e2e8f0"],
  chat_connected: () => (arena.chat?.connected !== false ? ["Duels are live", "#a7f3d0"] : null),
};
// every winner the overlay showed (debug and e2e)
export const results: { duelId: string | undefined; text: string; at: number }[] = [];
// Events that move the fighters.
const ON_EVENT: Partial<Record<string, (event: ArenaEvent, now: number) => void>> = {
  duel_started(event, now) {
    if (event.duelId && event.a && event.b) {
      replays.set(event.duelId, {
        id: event.duelId,
        a: String(event.a),
        b: String(event.b),
        status: "active",
        hp: { ...event.hp },
        ...(event.maxHp ? { maxHp: { ...event.maxHp } } : {}),
        rules: { maxHp: Number(arena.config.maxHp) || 100 },
      });
      const fa = findPlayer(String(event.a)),
        fb = findPlayer(String(event.b));
      if (fa && fb && !meetPoints.has(event.duelId)) {
        const meet: Meet = { ...placeMeet((fa.x + fb.x) / 2), aLeft: fa.x <= fb.x };
        const far = Math.max(Math.abs(fa.x - meet.x), Math.abs(fb.x - meet.x));
        meet.speed = Math.max(110, far / (DUEL_WALK_MS / 1000));
        meet.walkMs = Math.min(DUEL_WALK_MS, (far / meet.speed) * 1000);
        meetPoints.set(event.duelId, meet);
      }
      for (const id of [event.a, event.b]) {
        const f = findPlayer(String(id));
        if (f && !(f.koHoldUntil > now)) f.koUntil = 0;
      } // state may already show the KO
      // safety net if duel_completed never arrives (!: duel events carry a duelId; without one this deletes nothing)
      setTimeout(() => replays.delete(event.duelId!), 60000);
    }
    announceArena(`Round ${event.round}: ${nameOf(event.a)} vs ${nameOf(event.b)}`, undefined, event.duelId);
  },
  duel_action(event, now) {
    const replay = replays.get(event.duelId!); // !: an event without a duelId finds no replay
    if (Number.isFinite(event.die)) return playRoll(event, replay);
    if (replay && event.hp && typeof event.hp === "object") replay.hp = { ...event.hp };
    const actor = findPlayer(event.userId),
      target = findPlayer(event.targetId);
    if (event.ability === "heal") {
      if (actor) actor.anim = { kind: "heal", start: now, until: now + 900 };
      burst(actor, "#4ade80", 10, true);
      floatText(actor, `+${Number(event.amount) || 0}`, "#4ade80");
      return;
    }
    const heavy = event.ability === "heavy";
    if (actor) actor.anim = { kind: "attack", heavy, start: now, until: now + 450 };
    if (target) target.anim = { kind: "hit", heavy, start: now + 120, until: now + 520 };
    if (event.miss) {
      if (target) {
        target.anim = null;
        target.vy = -180;
      }
      return floatText(target, "MISS", "#e2e8f0");
    }
    burst(target, heavy ? "#f97316" : "#fb7185", heavy ? 16 : 8, false);
    landBlow(target, actor, heavy ? "#f97316" : "#fb7185", heavy ? 2 : 1);
    const label = event.counter ? "COUNTER" : `${event.crit ? "CRIT! " : ""}-${Number(event.amount) || 0}`;
    floatText(target, label, event.crit ? "#fde047" : "#fb7185");
  },
  duel_completed(event, now) {
    const winner = findPlayer(event.winnerId),
      loser = findPlayer(event.loserId);
    // !: an event without a duelId deletes nothing
    replays.delete(event.duelId!);
    meetPoints.delete(event.duelId!);
    if (loser) {
      const down = loser.koUntil > now; // the finishing blow already knocked them down
      if (!down) {
        loser.koStart = now;
        burst(loser, "#fbbf24", 18, false);
        knockout(loser, now);
      }
      loser.koUntil = loser.koHoldUntil = Math.max(Number(event.respawnAt) || 0, now + KO_HOLD_MS);
    }
    // Both stay big and in place for the afterglow, then walk off.
    for (const f of [winner, loser])
      if (f) {
        f.bigUntil = now + KO_HOLD_MS;
        f.holdUntil = now + KO_HOLD_MS;
      }
    if (winner) {
      winner.anim = { kind: "cheer", start: now, until: now + 1400 };
      winner.vy = -220;
    }
    // The winner's win effect and taunt (preset lines only; no taunt bubble with bubbles=0).
    if (winner?.winEffect) winner.winFx = { id: winner.winEffect, start: now, seed: (now % 997) + 1 };
    if (bubblesOn && winner && TAUNTS[winner.taunt]) {
      winner.text = TAUNTS[winner.taunt];
      winner.messageId = "";
      winner.bubbleUntil = now + 4500;
    }
    // An unrated duel ("new_account" or "pair_cap") moves no Elo: "Just for fun" instead of "+0 Elo".
    const unrated = Boolean(event.unrated);
    // !: a missing id reads the key "undefined", which holds no rating
    const rw = unrated ? null : event.ratings?.[event.winnerId!],
      rl = unrated ? null : event.ratings?.[event.loserId!];
    if (unrated) floatText(winner, "Just for fun", "#e2e8f0", 2200);
    if (Number.isFinite(rw?.delta)) floatText(winner, `${signed(rw.delta)} Elo`, "#4ade80", 2200);
    if (Number.isFinite(rl?.delta)) floatText(loser, `${signed(rl.delta)} Elo`, "#fb7185", 2200);
    const onHp = event.decision === "hp",
      elo = Number.isFinite(rw?.delta) ? ` ${signed(rw.delta)} Elo` : "";
    const text = `${onHp ? "Time! " : ""}${nameOf(event.winnerId)} wins${onHp ? " on HP" : ""}${event.flawless ? ", FLAWLESS!" : "!"}${elo}`;
    // No winner banner (the bot names the winner in chat); the debug hook still lists each winner.
    results.push({ duelId: event.duelId, text, at: now });
    if (results.length > 20) results.shift();
  },
  player_respawned(event, now) {
    const p = findPlayer(event.userId);
    // The overlay's replay runs longer than the server's settled duel: the respawn waits for it and the KO hold.
    if (p && (inReplay(p) || pendingKnockout(p)) && (event.tries || 0) < 400)
      setTimeout(() => handleArenaEvent({ ...event, at: undefined, tries: (event.tries || 0) + 1 }), 250);
    else if (p && p.koHoldUntil > now)
      setTimeout(() => handleArenaEvent({ ...event, at: undefined }), p.koHoldUntil - now + 20); // stand up after the replayed KO
    else if (p) {
      p.koUntil = 0;
      p.anim = { kind: "respawn", start: now, until: now + 700 };
      burst(p, "#bfdbfe", 10, true);
    }
  },
};
function handleArenaEvent(event: ArenaEvent) {
  if (Number.isFinite(event.at) && Date.now() - event.at > EVENT_FRESH_MS) return;
  const now = Date.now(),
    line = ANNOUNCED[event.type]?.(event);
  if (line) announceArena(line[0], line[1], event.duelId);
  ON_EVENT[event.type]?.(event, now);
  updateStatus();
}

// Distance between a duel's fighters when there is room; placeMeet shrinks it down to duelGapMin when crowded.
const duelGap = () => Math.max(size * 2, 190);
const duelGapMin = () => Math.min(duelGap(), Math.max(96, size * DUEL_GROW));
const barBase = (s: number) => Math.max(72, Math.min(116, s * 0.9)); // the hp bar; its "100/100" text fits the minimum
// Bars shrink (to 64 px at least) only when neighbouring meeting points are packed so close that full bars would touch.
export function barWidthOf(s: number) {
  const base = barBase(s),
    xs = [...meetPoints.values()].sort((p, q) => p.x - q.x);
  let room = Infinity;
  for (let i = 0; i < xs.length; i++) {
    // i (and i - 1 when i > 0) are indexes of xs
    room = Math.min(room, xs[i]!.gap - 8);
    if (i) room = Math.min(room, xs[i]!.x - xs[i - 1]!.x - (xs[i]!.gap + xs[i - 1]!.gap) / 2 - 8);
  }
  return Math.max(64, Math.min(base, room));
}
// The free spot nearest the midpoint that keeps neighbouring duels' hp bars and dice clear; when none is left the gap
// shrinks 8 px at a time down to duelGapMin, which also tightens the slot to bar width plus a margin.
export function placeMeet(mid: number) {
  const full = duelGap(),
    least = duelGapMin(),
    clearBars = barBase(size * DUEL_GROW) + 16;
  const taken = [...meetPoints.values()];
  let best = { x: mid, gap: least };
  for (let gap = full; ; gap = Math.max(least, gap - 8)) {
    const comfort = full > least ? ((gap - least) / (full - least)) * (full + size - clearBars) : 0;
    const lo = gap,
      hi = Math.max(gap, width - gap),
      clamp = (x: number) => Math.max(lo, Math.min(hi, x));
    const slack = (x: number) =>
      taken.length
        ? Math.min(...taken.map((t) => Math.abs(t.x - x) - ((t.gap + gap) / 2 + clearBars + comfort)))
        : Infinity;
    let bestSlack = -Infinity;
    for (let k = 0; k <= Math.ceil(width / 12) + 1; k++) {
      for (const x of k ? [clamp(mid + k * 12), clamp(mid - k * 12)] : [clamp(mid)]) {
        const s = slack(x);
        if (s >= 0) return { x, gap };
        if (s > bestSlack) {
          bestSlack = s;
          best = { x, gap };
        }
      }
    }
    if (gap === least) break;
  }
  // No free spot even at the smallest gap: spread every meeting point evenly at that gap (existing duels walk a little).
  const items: { m: Meet | null; x: number }[] = [...meetPoints.values()].map((m) => ({ m, x: m.x })),
    fresh = { m: null, x: best.x };
  items.push(fresh);
  items.sort((p, q) => p.x - q.x);
  const lo = least,
    hi = Math.max(least, width - least),
    step = items.length > 1 ? Math.min(least + clearBars, (hi - lo) / (items.length - 1)) : 0;
  let prev = -Infinity,
    next = Infinity;
  for (const it of items) {
    it.x = Math.max(lo, it.x, prev + step);
    prev = it.x;
  }
  for (let i = items.length - 1; i >= 0; i--) {
    // i counts down over the list
    items[i]!.x = Math.min(hi, items[i]!.x, next - step);
    next = items[i]!.x;
  }
  for (const it of items)
    if (it.m) {
      it.m.x = it.x;
      it.m.gap = least;
      it.m.speed = Math.max(it.m.speed || 110, 180);
    }
  return { x: fresh.x, gap: least };
}
