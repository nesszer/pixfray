// Where fighters walk: duelists to their meeting point, everyone else along their lane and clear of running duels.
import type { ArenaDuel } from "./parse.ts";
import { DUEL_GROW, findPlayer, meetPoints, openDuels, players, size, width } from "./overlay-stage.ts";
import type { Player } from "./overlay-stage.ts";
import { placeMeet } from "./overlay-duels.ts";

export const LABEL_ROW = 20; // nameplate line height; fighters whose lanes differ by this much pass each other
type Zone = { x: number; gap: number; label: number };

// Ground taken by running duels: where the two fighters stand, plus room for their nameplates (fixed 20px text, often
// wider than the sprite). labelWidth is measured when the nameplate is drawn (last frame).
export const duelZones = (): Zone[] =>
  openDuels().flatMap((d) => {
    const meet = meetPoints.get(d.id);
    if (!meet) return [];
    const label = Math.max(findPlayer(String(d.a))?.labelWidth || 0, findPlayer(String(d.b))?.labelWidth || 0);
    return [{ x: meet.x, gap: meet.gap, label }];
  });

// Moves one fighter for this frame; true while it walks.
export function moveFighter(p: Player, duel: ArenaDuel | null, clock: number, dt: number, zones: Zone[]) {
  const opponent = duel ? findPlayer(String(duel.a) === p.userId ? duel.b : duel.a) : null;
  const ko = p.koUntil > clock;
  let moving = false;
  if (duel?.status === "active" && opponent) {
    // Duels happen where the characters stand: both walk to the midpoint between them and face each other.
    let meet = meetPoints.get(duel.id);
    if (!meet) {
      const a = findPlayer(duel.a) || p,
        b = findPlayer(duel.b) || opponent;
      meet = { ...placeMeet((a.x + b.x) / 2), aLeft: a.x <= b.x };
      meetPoints.set(duel.id, meet);
    }
    const isA = String(duel.a) === p.userId;
    const diff = meet.x + (isA === meet.aLeft ? -meet.gap / 2 : meet.gap / 2) - p.x;
    if (Math.abs(diff) > 2) {
      p.x += Math.sign(diff) * Math.min(Math.abs(diff), (meet.speed || 110) * dt);
      moving = true;
      p.direction = Math.sign(diff);
    } else p.direction = opponent.x >= p.x ? 1 : -1;
  } else if (duel?.status === "pending" && opponent) {
    p.direction = opponent.x >= p.x ? 1 : -1;
  } else if (!ko && !(p.holdUntil > clock)) {
    // Personal space: a walker about to run into a neighbour's nameplate turns around (at most every 1.5 s, so a dense
    // crowd doesn't jitter). Fighters in different lanes have nameplates at different heights and pass.
    if (clock - (p.turnedAt || 0) > 1500) {
      for (const q of players.values()) {
        if (q === p || q.koUntil > clock || Math.abs(q.lane - p.lane) >= LABEL_ROW) continue;
        const dx = q.x - p.x;
        if (
          Math.sign(dx) === p.direction &&
          Math.abs(dx) < ((p.labelWidth || size) + (q.labelWidth || size)) / 2 + 12
        ) {
          p.direction = -p.direction;
          p.turnedAt = clock;
          break;
        }
      }
    }
    p.x += p.speed * p.direction * dt;
    moving = true;
  }
  const left = Math.min(size / 2, width / 2),
    right = Math.max(left, width - size / 2);
  if (duel?.status !== "active" && !ko) {
    // A bystander who walks into a duel turns back; one already inside walks out the nearer open side.
    const zone = zones
      .map((z) => {
        const half = z.gap / 2 + Math.max((size * DUEL_GROW) / 2 + size / 2, (z.label + (p.labelWidth || 0)) / 2 + 12);
        return { lo: z.x - half, hi: z.x + half };
      })
      .find((z) => p.x > z.lo && p.x < z.hi);
    if (zone && (zone.lo >= left || zone.hi <= right)) {
      const out = zone.hi > right || (zone.lo >= left && p.x - zone.lo < zone.hi - p.x) ? -1 : 1;
      p.direction = out;
      p.x += out * Math.max(p.speed, 90) * dt;
      moving = true;
    }
  }
  if (p.x < left) {
    p.x = left;
    p.direction = 1;
  }
  if (p.x > right) {
    p.x = right;
    p.direction = -1;
  }
  p.vy += 750 * dt;
  p.y += p.vy * dt;
  if (p.y >= 0) {
    p.y = 0;
    p.vy = 0;
  }
  return moving;
}
