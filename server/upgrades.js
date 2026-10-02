// Fighter upgrades and hats: the rules live here so the duel math, profile saving and the dashboard agree.
// Every win earns one upgrade point (up to MAX_POINTS). Points go into three stats, at most MAX_PER_STAT each,
// and can be moved around (respec) for free whenever the fighter is not in a duel.
//   power: +4% damage dealt per point      guard: -4% damage taken per point
//   luck:  4% per point that a miss still lands as a hit
// Hats are cosmetic; some unlock at a number of wins. The overlay draws them (public/hats.js).

export const STATS = ["power", "guard", "luck"];
export const MAX_PER_STAT = 5;
export const MAX_POINTS = 10;
export const STAT_STEP = 0.04;

export const HATS = [
  { id: "", label: "No hat", wins: 0 },
  { id: "cap", label: "Cap", wins: 0 },
  { id: "bandana", label: "Bandana", wins: 0 },
  { id: "beanie", label: "Beanie", wins: 1 },
  { id: "wizard", label: "Wizard hat", wins: 3 },
  { id: "tophat", label: "Top hat", wins: 5 },
  { id: "horns", label: "Horns", wins: 8 },
  { id: "halo", label: "Halo", wins: 12 },
  { id: "crown", label: "Crown", wins: 20 },
];
const HAT_WINS = new Map(HATS.map((h) => [h.id, h.wins]));

export const pointsFor = (wins) => Math.max(0, Math.min(MAX_POINTS, Number.isInteger(wins) ? wins : 0));

export function emptyStats() {
  return { power: 0, guard: 0, luck: 0 };
}

// Any input -> whole numbers within 0..MAX_PER_STAT for each stat.
export function cleanStats(input) {
  const out = emptyStats();
  for (const key of STATS) {
    const v = Number(input?.[key]);
    out[key] = Number.isInteger(v) ? Math.max(0, Math.min(MAX_PER_STAT, v)) : 0;
  }
  return out;
}

// Stats the fighter can use with this many wins. A rank reset lowers the points; the excess comes off
// luck first, then guard, then power, so a stored build never counts for more than the wins allow.
export function effectiveStats(stats, wins) {
  const out = cleanStats(stats);
  let extra = STATS.reduce((sum, key) => sum + out[key], 0) - pointsFor(wins);
  for (const key of ["luck", "guard", "power"]) {
    const cut = Math.min(out[key], Math.max(0, extra));
    out[key] -= cut;
    extra -= cut;
  }
  return out;
}

// For saving: null when the build spends more points than the wins give or breaks a stat cap.
export function validStats(input, wins) {
  if (input === undefined || input === null) return emptyStats();
  if (typeof input !== "object" || Array.isArray(input)) return null;
  const out = emptyStats();
  for (const key of STATS) {
    const v = input[key] ?? 0;
    if (!Number.isInteger(v) || v < 0 || v > MAX_PER_STAT) return null;
    out[key] = v;
  }
  return STATS.reduce((sum, key) => sum + out[key], 0) <= pointsFor(wins) ? out : null;
}

export const knownHat = (id) => HAT_WINS.has(typeof id === "string" ? id : "");
export const hatUnlocked = (id, wins) => knownHat(id) && (Number.isInteger(wins) ? wins : 0) >= HAT_WINS.get(id);

// Damage after the dealer's power and the target's guard; at least 1 so a blow always counts.
export function scaledDamage(base, dealerStats, targetStats) {
  const factor = (1 + STAT_STEP * (dealerStats?.power || 0)) * (1 - STAT_STEP * (targetStats?.guard || 0));
  return Math.max(1, Math.round(base * factor));
}

// Rules for the dashboard, sent with the profile so the page never hard-codes them.
export function upgradeRules(wins) {
  return {
    stats: STATS,
    maxPerStat: MAX_PER_STAT,
    maxPoints: MAX_POINTS,
    points: pointsFor(wins),
    step: STAT_STEP,
    hats: HATS.map((h) => ({ ...h, unlocked: (Number.isInteger(wins) ? wins : 0) >= h.wins })),
  };
}
