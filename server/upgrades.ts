// Fighter upgrades and hats: the rules live here so the duel math, profile saving and the dashboard agree.
// Every win earns one upgrade point, and so does every stream check-in (bonus points, kept on a rank reset), with no
// cap. Points buy stat levels: levels 1-8 cost 1 point each, and the cost doubles every 8 levels after that (9-16
// cost 2, 17-24 cost 4, ...). Points can be moved around (respec) for free whenever the fighter is not in a duel.
//   power: +4% damage dealt per level      guard: -4% damage taken per level
//   luck:  4% per level that a miss still lands as a hit
//   crit:  4% per level that a hit becomes a crit; in an HP fight, 4% that a strike or heavy deals +50%
//   dodge: 4% per level that a hit or crit on you misses (quick duels)
//   counter: +2% counter damage per level, and 2% per level that a foe's miss becomes your counter (quick duels)
//   vitality: +4 max HP per level in a duel (both kinds), up to +60; blows stay sized on the channel's base max HP
// Above level 8 each level adds half a step at first and the effect closes in on the stat's ceiling (statValue).
// A channel's maxStatLevel (config) caps the levels that count there; levels above it stay saved.
// Hats are cosmetic; some unlock at a number of wins. The overlay draws them (src/served/hats.ts).

export const STATS = ["power", "guard", "luck", "crit", "dodge", "counter", "vitality"] as const; // const: each stat a literal, so Stat names them
export type Stat = (typeof STATS)[number];
/** Levels in each stat. */
export type Stats = Record<Stat, number>;
/** Stat-shaped input from storage, a request or a pet boost: any value per stat, cleaned before use. */
export type LooseStats = Partial<Record<Stat, unknown>>;
/** Levels up to here keep the full step and cost 1 point each. */
export const FULL_STEP_LEVELS = 8;
/** A sanity bound on stored levels; reaching it would cost over 268 million points. */
export const LEVEL_LIMIT = 200;
export const STAT_STEP = 0.04;
/** What one of the first 8 levels adds to each stat's effect, as a fraction (vitality: in HP). */
export const STAT_STEPS: Record<Stat, number> = {
  power: STAT_STEP,
  guard: STAT_STEP,
  luck: STAT_STEP,
  crit: STAT_STEP,
  dodge: STAT_STEP,
  counter: 0.02,
  vitality: 4,
};
/** The most each stat's effect can reach, as a fraction (0.6 is 60%; vitality: in HP). */
export const STAT_CEILING: Record<Stat, number> = {
  power: 0.6,
  guard: 0.6,
  luck: 0.5,
  crit: 0.5,
  dodge: 0.5,
  counter: 0.6,
  vitality: 60,
};
/** Counter's second effect: the chance a foe's miss becomes your counter. */
const COUNTER_CHANCE = { step: 0.02, ceiling: 0.5 };
/** An HP-fight crit adds this much to a strike or heavy. */
export const HP_CRIT_BONUS = 0.5;

export type Hat = { id: string; label: string; wins: number };
export const HATS: Hat[] = [
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

const whole = (n: unknown): number => (Number.isInteger(n) && n > 0 ? n : 0);
// Points from wins plus check-in (bonus) points.
export const pointsFor = (wins: unknown, bonus: unknown = 0): number => whole(wins) + whole(bonus);

// Points the level-th level of a stat costs: 1 for levels 1-8, then doubling every 8 levels.
export const levelCost = (level: number): number => 2 ** Math.floor((Math.max(1, level) - 1) / FULL_STEP_LEVELS);
// Points that buy a stat up to this level: 8 for level 8, 24 for 16, 56 for 24, 120 for 32.
export function levelSpend(level: number): number {
  const n = Math.max(0, Math.floor(level)),
    tiers = Math.floor(n / FULL_STEP_LEVELS);
  return FULL_STEP_LEVELS * (2 ** tiers - 1) + (n % FULL_STEP_LEVELS) * 2 ** tiers;
}
// Points a build spends.
export const spentOn = (stats: Stats): number => STATS.reduce((sum, key) => sum + levelSpend(stats[key]), 0);

// An effect at a level: the full step a level up to level 8 (so earlier builds keep their strength), then half that
// step at first, closing in on the ceiling without reaching it.
function effectAt(step: number, ceiling: number, level: number): number {
  const n = Math.max(0, level || 0);
  if (n <= FULL_STEP_LEVELS) return step * n;
  const base = step * FULL_STEP_LEVELS,
    room = ceiling - base;
  return base + room * (1 - Math.exp(-((step / 2) * (n - FULL_STEP_LEVELS)) / room));
}
// What a stat's levels do, as a fraction (for counter, the extra counter damage; for vitality, HP).
export const statValue = (stat: Stat, level: number): number => effectAt(STAT_STEPS[stat], STAT_CEILING[stat], level);
// The chance a foe's miss becomes this fighter's counter.
export const counterChance = (level: number): number => effectAt(COUNTER_CHANCE.step, COUNTER_CHANCE.ceiling, level);
// Whole extra max HP from vitality levels.
export const bonusHp = (level: number): number => Math.round(statValue("vitality", level));

export function emptyStats(): Stats {
  return { power: 0, guard: 0, luck: 0, crit: 0, dodge: 0, counter: 0, vitality: 0 };
}

// Any input -> whole numbers within 0..LEVEL_LIMIT for each stat.
export function cleanStats(input?: unknown): Stats {
  const out = emptyStats();
  for (const key of STATS) {
    // Any value: ?. reads undefined from null or undefined, and Number() turns whatever it reads into a number
    const v = Number((input as LooseStats | null | undefined)?.[key]);
    out[key] = Number.isInteger(v) ? Math.max(0, Math.min(LEVEL_LIMIT, v)) : 0;
  }
  return out;
}

// Levels the fighter can use with these points. A rank reset lowers the points; levels come off the last stat in
// STATS first (vitality, counter, dodge, crit, luck, guard, then power) until the build fits, so a stored build never counts
// for more than the points allow.
// maxLevel (the channel's maxStatLevel) then caps each stat; levels above it stay saved but don't count.
// boost (the active pet's, server/pets.ts) is added after both, so it may take a stat past the cap.
export function effectiveStats(
  stats: unknown,
  wins: unknown,
  bonus: unknown = 0,
  boost: LooseStats | null = null,
  maxLevel = LEVEL_LIMIT,
): Stats {
  const out = cleanStats(stats),
    points = pointsFor(wins, bonus);
  let spent = spentOn(out);
  for (const key of [...STATS].reverse()) while (spent > points && out[key] > 0) spent -= levelCost(out[key]--);
  for (const key of STATS) out[key] = Math.min(out[key], Math.max(0, maxLevel));
  if (boost) for (const key of STATS) out[key] += Number.isInteger(boost[key]) && boost[key] > 0 ? boost[key] : 0;
  return out;
}

// For saving: null when the build spends more points than the fighter has or isn't whole levels.
export function validStats(input: unknown, wins: unknown, bonus: unknown = 0): Stats | null {
  if (input === undefined || input === null) return emptyStats();
  if (typeof input !== "object" || Array.isArray(input)) return null;
  const out = emptyStats();
  for (const key of STATS) {
    // A non-array object (checked above); each value is checked below
    const v = (input as LooseStats)[key] ?? 0;
    if (!Number.isInteger(v) || v < 0 || v > LEVEL_LIMIT) return null;
    out[key] = v;
  }
  return spentOn(out) <= pointsFor(wins, bonus) ? out : null;
}

/** A suggested build: how much each stat weighs. */
export type Preset = { id: string; label: string; weights: Partial<Record<string, number>> };
// Suggested builds for the fighter page. A preset shows once every stat it weighs exists here.
export const PRESETS: Preset[] = [
  { id: "balanced", label: "Balanced", weights: { power: 1, guard: 1, luck: 1 } },
  { id: "brawler", label: "Brawler", weights: { power: 1, guard: 1 } },
  { id: "lucky-striker", label: "Lucky striker", weights: { power: 1, luck: 1 } },
  { id: "iron-wall", label: "Iron wall", weights: { guard: 3, power: 1 } },
  { id: "glass-cannon", label: "Glass cannon", weights: { power: 3, crit: 2, luck: 1 } },
  { id: "tank", label: "Tank", weights: { guard: 3, vitality: 3, power: 1 } },
  { id: "counter-puncher", label: "Counter-puncher", weights: { counter: 3, guard: 2, dodge: 1 } },
  { id: "duelist", label: "Duelist", weights: { power: 2, crit: 2, dodge: 1, luck: 1 } },
  { id: "gambler", label: "Gambler", weights: { luck: 3, crit: 3 } },
  { id: "ghost", label: "Ghost", weights: { dodge: 3, luck: 2, counter: 1 } },
  { id: "bruiser", label: "Bruiser", weights: { power: 2, vitality: 2, guard: 1 } },
  { id: "sharpshooter", label: "Sharpshooter", weights: { crit: 3, luck: 2, power: 1 } },
];
export const presetReady = (preset: Preset): boolean =>
  Object.keys(preset.weights).every((key) => (STATS as readonly string[]).includes(key));

// A preset spread over these points. Each step buys a level for the weighted stat furthest below its share (ties go
// in STATS order), until none can take another level.
export function presetStats(preset: Preset, points: number, maxLevel = LEVEL_LIMIT): Stats {
  const out = emptyStats(),
    weight = (key: Stat) => preset.weights[key] || 0,
    keys = STATS.filter((key) => weight(key) > 0),
    top = Math.min(maxLevel, LEVEL_LIMIT);
  let left = Math.max(0, points);
  for (;;) {
    const open = keys.filter((key) => out[key] < top && levelCost(out[key] + 1) <= left);
    const next = open.reduce<Stat | null>(
      (a, b) => (a === null || (out[b] + 1) / weight(b) < (out[a] + 1) / weight(a) ? b : a),
      null,
    );
    if (next === null) return out;
    left -= levelCost(++out[next]);
  }
}

export const knownHat = (id: unknown): boolean => HAT_WINS.has(typeof id === "string" ? id : "");
export const hatUnlocked = (id: unknown, wins: unknown): boolean =>
  // knownHat(id) is true only for a string id that HAT_WINS holds, so the cast holds and get() finds it
  knownHat(id) && (Number.isInteger(wins) ? wins : 0) >= HAT_WINS.get(id as string)!;

// Damage after the dealer's power and the target's guard (through statValue); at least 1 so a blow always counts.
export function scaledDamage(
  base: number,
  dealerStats?: Partial<Stats> | null,
  targetStats?: Partial<Stats> | null,
): number {
  const factor = (1 + statValue("power", dealerStats?.power || 0)) * (1 - statValue("guard", targetStats?.guard || 0));
  return Math.max(1, Math.round(base * factor));
}

/** The rules upgradeRules sends to the dashboard. */
export type UpgradeRules = {
  stats: typeof STATS;
  /** The channel's maxStatLevel: levels above it don't count there. */
  maxLevel: number;
  points: number;
  fromWins: number;
  fromCheckins: number;
  step: number;
  hats: (Hat & { unlocked: boolean })[];
};

// Rules for the dashboard, sent with the profile so the page never hard-codes them.
export function upgradeRules(wins: unknown, bonus: unknown = 0, maxLevel = LEVEL_LIMIT): UpgradeRules {
  return {
    stats: STATS,
    maxLevel,
    points: pointsFor(wins, bonus),
    fromWins: whole(wins),
    fromCheckins: whole(bonus),
    step: STAT_STEP,
    hats: HATS.map((h) => ({ ...h, unlocked: (Number.isInteger(wins) ? wins : 0) >= h.wins })),
  };
}
