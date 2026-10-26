import site from "../site.config.js";
import {
  bonusHp,
  cleanStats,
  counterChance,
  effectiveStats,
  emptyStats,
  knownHat,
  scaledDamage,
  statValue,
  syncPair,
  HP_CRIT_BONUS,
} from "./upgrades.ts";
import { cleanBoost, TIERS } from "./pets.ts";
import { cleanCosmetics } from "./cosmetics.ts";
import type { Stats } from "./upgrades.ts";
import type {
  Abilities,
  AbilityName,
  AdminEvent,
  AdminPayload,
  CommandEvent,
  Config,
  Cooldowns,
  Duel,
  GameEvent,
  GameResult,
  GameState,
  Player,
  ProfileInput,
  RankSet,
  ReduceOutput,
  Swing,
  Untrusted,
} from "./model.ts";

const DEFAULT_CONFIG: Config = {
  enabled: true,
  // Quick duels: accepting settles the duel at once with a d6 exchange (hit, counter or miss).
  // Off = the HP fight with !attack/!strike/!heavy/!heal. StreamElements has no attack commands, so its duels
  // always settle quickly (commands marked quick: true).
  quickDuel: true,
  // Overlay duel banner: "off", "top" or "bottom". Live overlays read it from the snapshot, so mods change it without a new OBS link.
  announce: "off",
  // Most characters walking on the overlay at once (the longest-quiet chatter leaves first). Overlays read it from the snapshot too.
  maxOnStream: 50,
  maxHp: 100,
  maxDuels: 5,
  challengeTimeoutMs: 30_000,
  inactivityMs: 45_000,
  respawnMs: 3_000,
  rematchDelayMs: 30_000,
  // How far the stream runs behind chat. Chat keeps a quick duel's result hidden this long after the overlay shows it.
  streamDelayMs: 6_000,
  sharedCooldownMs: 1_000,
  initialElo: 1_000,
  eloK: 24,
  // !checkin: upgrade points per stream check-in, and extra points at streak milestones (server/room-economy.ts
  // STREAK_MILESTONES: +1 at 3, 7, 14 and 30 streams, +2 at 60, +3 at 100, +5 at 200, +10 at 365).
  checkinPoints: 1,
  streakBonus: true,
  // The highest level of each upgrade stat that counts on this channel; levels above it stay saved.
  maxStatLevel: 16,
  // PixFray dollars (server/room-economy.ts payDuels, give). Saved fighters earn them per finished duel.
  winDollars: 5,
  lossDollars: 3,
  // Ranked duels per pair of fighters per live stream (0 = no limit). Past it they duel unrated for half the dollars.
  pairRankedPerStream: 0,
  // !give @name amount: on/off, the most one viewer can give per stream, and the finished duels needed first.
  giveEnabled: true,
  giveMaxPerStream: 100,
  giveMinDuels: 5,
  // The PixFray bot posts the !fray line every this many minutes while the channel is live (0 = off, else 10 to 240).
  reminderMin: 0,
  // The PixFray bot as a whole (!fray off / !fray on, or the admin page). Off: it ignores every command and posts nothing
  // (no replies, results, expired challenges or reminders); chatters still walk on the overlay.
  botEnabled: true,
  // Shop (server/pets.ts): pet prices by tier, and hats before their wins at wins needed x hatPricePerWin (0 = off).
  // A duel pays about $4, so a common pet is ~3 duels, a recolor ~5 and a legendary pet ~75 (prices cut to a third on 2026-10-06).
  petPriceCommon: 10,
  petPriceUncommon: 25,
  petPriceRare: 60,
  petPriceEpic: 140,
  petPriceLegendary: 300,
  hatPricePerWin: 3,
  // Stage 4 (server/cosmetics.ts): each cosmetic kind has one price, and build slots cost 60 for the 2nd, then 120 each.
  recolorPrice: 20,
  petColorPrice: 15,
  accessoryPrice: 25,
  trailPrice: 40,
  effectPrice: 50,
  tauntPrice: 10,
  titlePrice: 15,
  buildSlotPrice: 60,
  buildSlotPriceMore: 120,
  abilities: {
    strike: { damage: 20, cooldownMs: 2_000 },
    heavy: { damage: 35, cooldownMs: 5_000 },
    heal: { amount: 15, cooldownMs: 12_000 },
  },
};

// The first preset (10/25 damage) made duels drag on for 10+ hits. Channels that never edited it move to the current one.
// Shop prices before the 2026-10-06 cut. A stored config still at one of these moves to the new default once (priceSchema 2);
// a price a mod changed is kept.
const OLD_PRICES = {
  petPriceCommon: 30,
  petPriceUncommon: 75,
  petPriceRare: 180,
  petPriceEpic: 420,
  petPriceLegendary: 900,
  hatPricePerWin: 10,
  recolorPrice: 60,
  petColorPrice: 40,
  accessoryPrice: 80,
  trailPrice: 120,
  effectPrice: 150,
  tauntPrice: 25,
  titlePrice: 50,
  buildSlotPrice: 200,
  buildSlotPriceMore: 400,
};
const LEGACY_CONFIG = {
  ...DEFAULT_CONFIG,
  inactivityMs: 60_000,
  abilities: {
    strike: { damage: 10, cooldownMs: 3_000 },
    heavy: { damage: 25, cooldownMs: 8_000 },
    heal: { amount: 15, cooldownMs: 10_000 },
  },
};

// unknown[] so includes() can test values nobody has checked yet.
const ANNOUNCE: readonly unknown[] = ["off", "top", "bottom"];
const ON_STREAM: [number, number] = [15, 100];
const MAX_ACTIVE_PLAYERS = 100;
const MAX_RECENT_EVENTS = 100;
const MAX_APPLIED_MESSAGE_IDS = 1_000;
const MAX_DUEL_HISTORY = 25;
const ACTIVE_TTL_MS = 10 * 60_000;
// Anti-farming: mods may cap the ranked duels between two fighters per live stream (config.pairRankedPerStream), and a Twitch
// account younger than NEW_ACCOUNT_MS (the room looks it up) can duel but doesn't move Elo, wins or dollars.
export const NEW_ACCOUNT_MS = 7 * 86_400_000;
const MAX_PAIR_PLAYS = 2_000;
// Set<unknown> so has() can test values nobody has checked yet.
const ABILITIES = new Set<unknown>(["strike", "heavy", "heal"]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function safeString(value: unknown, maxLength = 64): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeUsername(value: unknown): string {
  return safeString(value, 25).replace(/^@/, "").toLowerCase();
}

function normalizeUserId(value: unknown): string {
  return safeString(String(value ?? ""), 64);
}

function defaultProfile(userId: string, config: Config, now: number): Player {
  return {
    userId,
    username: "",
    displayName: "",
    avatar: "player",
    color: "#A78BFA",
    defaultAbility: "strike",
    hp: config.maxHp,
    elo: config.initialElo,
    wins: 0,
    losses: 0,
    lastSeen: now,
    registered: false,
    respawnAt: 0,
    stats: emptyStats(),
    hat: "",
    bonus: 0, // check-in points (server/room-economy.ts checkin), added to the wins for upgrades
    pet: "", // the active pet's id (server/pets.ts), its tier for the overlay, and its stat boost
    petTier: "",
    petBoost: emptyStats(),
    ...cleanCosmetics(null), // recolor, petColor, accessory, trail, winEffect, taunt, title (server/cosmetics.ts)
  };
}

function boundedInt(value: unknown, min: number, max: number): number | null {
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function normalizeConfig(config: { [key: string]: unknown } | null | undefined): Config {
  const merged: { [key: string]: unknown; abilities: { [name: string]: { [key: string]: unknown } } } = {
    ...clone(DEFAULT_CONFIG),
    ...(config && typeof config === "object" ? config : {}),
    abilities: {
      ...clone(DEFAULT_CONFIG.abilities),
      ...(config?.abilities && typeof config.abilities === "object" ? config.abilities : {}),
    },
  };
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (key === "abilities") continue;
    if (typeof value === "boolean") merged[key] = Boolean(merged[key]);
    else if (key === "announce") merged[key] = ANNOUNCE.includes(merged[key]) ? merged[key] : value;
    else if (key === "maxOnStream")
      merged[key] = Number.isInteger(merged[key]) ? Math.max(ON_STREAM[0], Math.min(ON_STREAM[1], merged[key])) : value;
    else if (!Number.isInteger(merged[key])) merged[key] = value;
  }
  for (const [name, defaults] of Object.entries(DEFAULT_CONFIG.abilities)) {
    const candidate = merged.abilities[name] ?? {};
    merged.abilities[name] = {};
    for (const [key, value] of Object.entries(defaults)) {
      // set to {} just above
      merged.abilities[name]![key] = Number.isInteger(candidate[key]) ? candidate[key] : value;
    }
  }
  delete merged.relayLeaseMs;
  // every field was checked above, or reset to its default
  return merged as Config;
}

export function createInitialState(channel: unknown = site.defaultChannel): GameState {
  return {
    channel: safeString(channel, 25).toLowerCase() || site.defaultChannel,
    revision: 0,
    // Chat source: one Twitch EventSub webhook subscription (channel.chat.message). lastSeen = last notification.
    chat: {
      connected: false,
      lastSeen: 0,
      subscriptionId: "",
      status: "disconnected",
      createdAt: 0,
      revokedReason: "",
      checkedAt: 0,
      verifiedId: "",
    },
    config: clone(DEFAULT_CONFIG),
    configVersion: 1,
    round: 0,
    players: [],
    duels: [],
    rematchLocks: [],
    pairPlays: [],
    events: [],
    appliedMessageIds: [],
    nextDuelId: 1,
  };
}

function addEvent(state: GameState, type: string, now: number, details: { [field: string]: unknown } = {}): void {
  state.revision += 1;
  state.events.push({ id: String(state.revision), type, at: now, ...details });
  if (state.events.length > MAX_RECENT_EVENTS) {
    state.events.splice(0, state.events.length - MAX_RECENT_EVENTS);
  }
}

function openDuels(state: GameState): Duel[] {
  return state.duels.filter((duel) => duel.status === "pending" || duel.status === "active");
}

function player(state: GameState, userId: unknown): Player | undefined {
  return state.players.find((item) => item.userId === userId);
}

function duelHasUser(duel: Duel, userId: string): boolean {
  return duel.a === userId || duel.b === userId;
}

export function hasOpenDuel(state: GameState, userId: string): boolean {
  return openDuels(state).some((duel) => duelHasUser(duel, userId));
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join(":");
}

function recentProfile(
  state: GameState,
  profile: ProfileInput | null | undefined,
  now: number,
): Player | null | undefined {
  if (!profile || !profile.userId) return null;
  const userId = normalizeUserId(profile.userId);
  if (!userId) return null;
  const existing = player(state, userId);
  const base = existing ? { ...existing } : defaultProfile(userId, state.config, now);
  const username = normalizeUsername(profile.username);
  const displayName = safeString(profile.displayName || username || base.displayName, 48);
  const merged: Player = {
    ...base,
    username: username || base.username,
    displayName: displayName || username || base.displayName || userId,
    avatar: safeString(profile.avatar || base.avatar || "player", 64),
    color: cleanColor(profile.color, base.color || "#A78BFA"),
    defaultAbility: cleanAbility(profile.defaultAbility, base.defaultAbility || "strike"),
    registered: Boolean(base.registered || profile.registered),
    lastSeen: now,
  };
  if (Number.isInteger(profile.elo) && profile.registered) merged.elo = profile.elo;
  if (Number.isInteger(profile.wins) && profile.registered) merged.wins = profile.wins;
  if (Number.isInteger(profile.losses) && profile.registered) merged.losses = profile.losses;
  // Upgrades and hat come from the saved profile only (the dashboard sets them; chat can't).
  if (profile.registered && profile.stats) merged.stats = cleanStats(profile.stats);
  if (profile.registered && typeof profile.hat === "string") merged.hat = knownHat(profile.hat) ? profile.hat : "";
  if (profile.registered && Number.isInteger(profile.bonus)) merged.bonus = Math.max(0, profile.bonus);
  if (profile.registered && typeof profile.pet === "string") Object.assign(merged, petFields(profile));
  if (profile.registered && typeof profile.recolor === "string") Object.assign(merged, cleanCosmetics(profile));
  // hp/respawnAt only seed a new player, so a later chat message can never undo a KO.
  if (!existing && Number.isInteger(profile.hp) && profile.registered)
    merged.hp = Math.min(state.config.maxHp, Math.max(0, profile.hp));
  if (!existing && Number.isInteger(profile.respawnAt)) merged.respawnAt = profile.respawnAt;
  // !rematch: the last finished duel's opponent. The game's own value is newer than a saved one.
  if (profile.registered && !merged.lastOpponentId && normalizeUserId(profile.lastOpponentId))
    merged.lastOpponentId = normalizeUserId(profile.lastOpponentId);
  if (existing) Object.assign(existing, merged);
  else if (!addPlayer(state, merged)) return null;
  return player(state, userId);
}

const cleanColor = (value: unknown, fallback: string): string =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : fallback;
const cleanAbility = (value: unknown, fallback: string): string =>
  typeof value === "string" && ABILITIES.has(value) ? value : fallback;

// Adds a fighter, dropping the longest-quiet one not in a duel when the stage is full; false when all of them are.
function addPlayer(state: GameState, p: Player): boolean {
  if (state.players.length >= MAX_ACTIVE_PLAYERS) {
    const idle = state.players
      .filter((item) => !hasOpenDuel(state, item.userId))
      .sort((a, b) => a.lastSeen - b.lastSeen)[0];
    if (!idle) return false;
    state.players.splice(state.players.indexOf(idle), 1);
  }
  state.players.push(p);
  return true;
}

// Cancelled duels are unscored: no Elo, no wins/losses, no KO. Fighters are restored to full health.
function cancelDuel(state: GameState, duel: Duel, now: number, reason: string): boolean {
  if (duel.status !== "pending" && duel.status !== "active") return false;
  const wasActive = duel.status === "active";
  duel.status = "cancelled";
  duel.endedAt = now;
  duel.cancelReason = reason;
  duel.winnerId = null;
  if (wasActive) {
    for (const userId of [duel.a, duel.b]) {
      const p = player(state, userId);
      if (p) {
        p.hp = state.config.maxHp;
        p.respawnAt = 0;
      }
    }
  }
  addEvent(state, "duel_cancelled", now, { duelId: duel.id, a: duel.a, b: duel.b, reason, wasActive });
  return true;
}

function isTerminal(duel: Duel): boolean {
  return (
    duel.status === "completed" ||
    duel.status === "cancelled" ||
    duel.status === "expired" ||
    duel.status === "declined"
  );
}

function expireState(state: GameState, now: number): boolean {
  let changed = false;
  state.config = normalizeConfig(state.config);

  for (const duel of state.duels) {
    if (duel.status === "pending" && now >= duel.expiresAt) {
      duel.status = "expired";
      duel.endedAt = now;
      addEvent(state, "challenge_expired", now, { duelId: duel.id, a: duel.a, b: duel.b });
      changed = true;
      // an active duel has lastActionAt (beginDuel sets it)
    } else if (duel.status === "active" && now - duel.lastActionAt! >= state.config.inactivityMs) {
      cancelDuel(state, duel, now, "inactivity");
      changed = true;
    }
  }

  for (const p of state.players) {
    if (p.respawnAt && now >= p.respawnAt) {
      p.hp = state.config.maxHp;
      p.respawnAt = 0;
      addEvent(state, "player_respawned", now, { userId: p.userId });
      changed = true;
    }
  }

  const locks = state.rematchLocks.length;
  state.rematchLocks = state.rematchLocks.filter((lock) => lock.until > now);
  if (state.rematchLocks.length !== locks) changed = true; // unsaved, a stale lock re-arms the alarm for now in a loop
  const inDuel = new Set(openDuels(state).flatMap((duel) => [duel.a, duel.b]));
  const before = state.players.length;
  state.players = state.players.filter(
    (p) => inDuel.has(p.userId) || p.respawnAt > now || now - p.lastSeen <= ACTIVE_TTL_MS,
  );
  if (state.players.length !== before) changed = true;

  const terminal = state.duels.filter(isTerminal);
  if (terminal.length > MAX_DUEL_HISTORY) {
    const keep = new Set(terminal.slice(-MAX_DUEL_HISTORY).map((duel) => duel.id));
    state.duels = state.duels.filter(
      (duel) => duel.status === "pending" || duel.status === "active" || keep.has(duel.id),
    );
    changed = true;
  }
  return changed;
}

// reason?: undefined on the ok side lets the loose JS program (no strictNullChecks) read dedupe.reason.
function addRecent(
  state: GameState,
  event: CommandEvent,
): { ok: true; id: string; reason?: undefined } | { ok: false; reason: string } {
  const id = normalizeUserId(event.messageId || event.id);
  if (!id) return { ok: false, reason: "missing_message_id" };
  if (state.appliedMessageIds.includes(id)) return { ok: false, reason: "duplicate" };
  state.appliedMessageIds.push(id);
  if (state.appliedMessageIds.length > MAX_APPLIED_MESSAGE_IDS) {
    state.appliedMessageIds.splice(0, state.appliedMessageIds.length - MAX_APPLIED_MESSAGE_IDS);
  }
  return { ok: true, id };
}

function findTargetProfile(
  state: GameState,
  event: CommandEvent,
  targetUsername: string,
  now: number,
): Player | null | undefined {
  const existing = state.players.find((item) => item.username === targetUsername);
  if (existing) return existing;
  if (event.targetProfile && normalizeUsername(event.targetProfile.username) === targetUsername) {
    return recentProfile(state, event.targetProfile, now);
  }
  return null;
}

function registeredPlayer(state: GameState, userId: string, event: CommandEvent, now: number): Player | null {
  const p = recentProfile(state, event.profile, now) || player(state, userId);
  if (!p) return null;
  return p.userId === userId && p.registered ? p : null;
}

function createChallenge(state: GameState, actor: Player, target: Player, now: number): GameResult {
  if (!state.config.enabled) return { ok: false, reason: "duels_disabled" };
  if (!actor.registered || !target.registered) return { ok: false, reason: "ranked_sign_in_required" };
  if (actor.userId === target.userId) return { ok: false, reason: "self_duel" };
  if (hasOpenDuel(state, actor.userId) || hasOpenDuel(state, target.userId)) {
    return { ok: false, reason: "player_busy" };
  }
  const lock = state.rematchLocks.find(
    (item) => item.pair === pairKey(actor.userId, target.userId) && item.until > now,
  );
  // Until the stream has shown a fight, both fighters get the same answer, so a challenge can't tell who lost.
  const hidden = hiddenResults(state, now);
  if (!lock && (hidden.has(actor.userId) || hidden.has(target.userId))) return { ok: false, reason: "result_hidden" };
  const down = actor.respawnAt > now ? actor : target.respawnAt > now ? target : null;
  if (down) return { ok: false, reason: "respawning", userId: down.userId, retryAt: down.respawnAt }; // name who is knocked out, not who asked
  if (openDuels(state).length >= state.config.maxDuels) return { ok: false, reason: "channel_full" };
  if (lock) return { ok: false, reason: "rematch_cooldown", retryAt: lock.until };
  const duel: Duel = {
    id: "duel-" + state.nextDuelId++,
    a: actor.userId,
    b: target.userId,
    status: "pending",
    createdAt: now,
    expiresAt: now + state.config.challengeTimeoutMs,
    hp: {},
    winnerId: null,
  };
  state.duels.push(duel);
  addEvent(state, "challenge_created", now, {
    duelId: duel.id,
    a: actor.userId,
    b: target.userId,
    expiresAt: duel.expiresAt,
  });
  return { ok: true, duelId: duel.id };
}

// The room's latest answer to "is the channel live?" (undefined: no answer this time, keep the last one). A new stream
// drops the pair counts of earlier ones.
function noteStream(state: GameState, news: unknown): void {
  if (news === undefined) return;
  const live =
    news && typeof news === "object" && "id" in news && typeof news.id === "string" && news.id
      ? { id: news.id, startedAt: "startedAt" in news && Number.isFinite(news.startedAt) ? Number(news.startedAt) : 0 }
      : null;
  if (live && state.stream?.id !== live.id) state.pairPlays = state.pairPlays.filter((play) => countsFor(play, live));
  state.stream = live;
}

// Pair counts from before streams were tracked carry no stream id; they count for the stream they fall in.
function countsFor(play: GameState["pairPlays"][number], stream: GameState["stream"]): boolean {
  if (!stream) return !play.stream;
  return play.stream === stream.id || (play.stream === undefined && play.at >= stream.startedAt);
}

/** Ranked duels these two fighters have left this stream, or null when the channel sets no limit. */
export function pairRankedLeft(state: GameState, a: string, b: string): number | null {
  const cap = state.config.pairRankedPerStream;
  if (!(cap > 0)) return null;
  const pair = pairKey(a, b);
  return Math.max(
    0,
    cap - state.pairPlays.filter((play) => play.pair === pair && countsFor(play, state.stream)).length,
  );
}

function beginDuel(state: GameState, duel: Duel, now: number, event: { newAccounts?: unknown } = {}): GameResult {
  const a = player(state, duel.a);
  const b = player(state, duel.b);
  if (!a?.registered || !b?.registered) return { ok: false, reason: "ranked_sign_in_required" };
  const young = Array.isArray(event.newAccounts) ? event.newAccounts : [];
  const left = pairRankedLeft(state, duel.a, duel.b);
  if (state.stream === null) duel.unrated = "offline";
  else if (young.includes(duel.a) || young.includes(duel.b)) duel.unrated = "new_account";
  else if (left === 0) duel.unrated = "pair_cap";
  else if (left === 1) duel.lastRanked = true;
  state.round += 1;
  duel.round = state.round;
  duel.status = "active";
  duel.startedAt = now;
  duel.lastActionAt = now;
  // Each fighter's max HP: the channel's plus their vitality after level sync.
  const synced = duelStats(state, duel);
  duel.maxHp = {
    [duel.a]: state.config.maxHp + bonusHp(synced[duel.a]!.vitality),
    [duel.b]: state.config.maxHp + bonusHp(synced[duel.b]!.vitality),
  };
  duel.hp = clone(duel.maxHp);
  duel.rules = {
    maxHp: state.config.maxHp,
    inactivityMs: state.config.inactivityMs,
    respawnMs: state.config.respawnMs,
    rematchDelayMs: state.config.rematchDelayMs,
    sharedCooldownMs: state.config.sharedCooldownMs,
    abilities: clone(state.config.abilities),
  };
  duel.cooldowns = freshCooldowns(duel);
  a.hp = fullHp(duel, a.userId);
  b.hp = fullHp(duel, b.userId);
  a.respawnAt = 0;
  b.respawnAt = 0;
  addEvent(state, "duel_started", now, {
    duelId: duel.id,
    a: duel.a,
    b: duel.b,
    round: duel.round,
    hp: clone(duel.hp),
    maxHp: clone(duel.maxHp),
  });
  return { ok: true, duelId: duel.id };
}

// Both fighters' stats in this duel: their effective stats, then level sync (server/upgrades.ts syncPair).
function duelStats(state: GameState, duel: Duel): Record<string, Stats> {
  const of = (id: string): Stats => {
    const p = player(state, id);
    return effectiveStats(p?.stats, p ?? {}, p?.petBoost, state.config.maxStatLevel);
  };
  const [a, b] = syncPair(of(duel.a), of(duel.b));
  return { [duel.a]: a, [duel.b]: b };
}

// A fighter's full health in a started duel: their own max HP, or the rules' for a duel started before vitality.
// rules!: only started duels reach here, and beginDuel sets rules
const fullHp = (duel: Duel, userId: string): number => duel.maxHp?.[userId] ?? duel.rules!.maxHp;
const freshCooldowns = (duel: Duel): Record<string, Cooldowns> => ({
  [duel.a]: { sharedUntil: 0, strikeUntil: 0, heavyUntil: 0, healUntil: 0 },
  [duel.b]: { sharedUntil: 0, strikeUntil: 0, heavyUntil: 0, healUntil: 0 },
});

// Quick duel: a d6 exchange settled at once. Fighters take turns swinging, the challenger first:
// 6 is a crit (50% of the channel's max HP), 5 a hit (34%), 3-4 a miss, 1-2 the other fighter counters (34%).
// First to 0 HP loses. After QUICK_MAX_ROLLS rolls the fighter with more HP wins; equal HP goes to
// sudden death, where the next hit or counter knocks out. A winner who took no damage is flawless (+3 Elo).
// Upgrades (server/upgrades.ts) then change the swing in this order, each check with its own roll (slot k reads
// rolls[k * SLOT_ROLLS + i]): the attacker's luck turns a miss into a hit, their crit turns a hit into a crit, the
// defender's dodge turns a hit or crit into a miss, and the defender's counter turns a miss into their counter.
// Power and guard scale each blow, and counter adds its damage bonus to the defender's counters.
// rolls are numbers in [0, 1) from the room; missing ones come from a hash so the reducer stays pure.
const QUICK_MAX_ROLLS = 12;
// A quick duel is settled at once, but the overlay plays it out over seconds and viewers see the stream a few
// seconds behind chat (config.streamDelayMs). Until revealAt, chat replies, !elo, !ranks and the leaderboard keep the pre-fight
// numbers (hiddenResults), so the stream shows the winner first. Pacing mirrors src/served/overlay.ts: a walk-in
// of up to 2.2 s, then about 1.8 s per roll before the result banner.
// REPLAY_SLACK_MS covers the overlay running a little long on a 12-roll fight, so chat never gets ahead of it.
const REPLAY_WALK_MS = 2200,
  REPLAY_ROLL_MS = 1800,
  REPLAY_SLACK_MS = 500;
export const replayMs = (rolls: number): number =>
  REPLAY_WALK_MS + REPLAY_ROLL_MS * Math.max(1, rolls) + REPLAY_SLACK_MS;
const QUICK_FLAWLESS_BONUS = 3;
const SLOT_ROLLS = 24;
const SLOT = { die: 0, luck: 1, crit: 2, dodge: 3, counter: 4 };
function settleQuickDuel(state: GameState, duel: Duel, rolls: unknown, now: number): GameResult {
  const list = Array.isArray(rolls) ? rolls : [];
  const rollAt = (i: number): number =>
    Number.isFinite(list[i]) && list[i] >= 0 && list[i] < 1 ? list[i] : hashRoll(duel.id + ":" + now + ":" + i);
  const check = (slot: number, i: number, chance: number): boolean =>
    chance > 0 && rollAt(slot * SLOT_ROLLS + i) < chance;
  // the duel has started, so beginDuel set its rules
  const maxHp = duel.rules!.maxHp;
  const blow = { hit: Math.round(maxHp * 0.34), crit: Math.round(maxHp * 0.5), counter: Math.round(maxHp * 0.34) };
  const look = (id: string): string => player(state, id)?.defaultAbility || "strike"; // cosmetic: picks the attack effect on the overlay
  const stats = duelStats(state, duel);
  const swings: Swing[] = [];
  let attacker = duel.a,
    defender = duel.b,
    winnerId = "",
    loserId = "",
    decision = "ko";
  for (let i = 0; !winnerId && i < 200; i++) {
    const suddenDeath = i >= QUICK_MAX_ROLLS;
    if (i === QUICK_MAX_ROLLS) {
      if (duel.hp[duel.a] !== duel.hp[duel.b]) {
        decision = "hp";
        // beginDuel gave both fighters an hp entry
        winnerId = duel.hp[duel.a]! > duel.hp[duel.b]! ? duel.a : duel.b;
        loserId = winnerId === duel.a ? duel.b : duel.a;
        break;
      }
      decision = "sudden_death";
    }
    const die = 1 + Math.floor(rollAt(SLOT.die * SLOT_ROLLS + i) * 6);
    let outcome: Swing["outcome"] = die === 6 ? "crit" : die === 5 ? "hit" : die <= 2 ? "counter" : "miss";
    // stats has an entry for both fighters (built from [duel.a, duel.b] above)
    const mine = stats[attacker]!,
      theirs = stats[defender]!;
    const lucky = outcome === "miss" && check(SLOT.luck, i, statValue("luck", mine.luck));
    if (lucky) outcome = "hit";
    const luckyCrit = outcome === "hit" && check(SLOT.crit, i, statValue("crit", mine.crit));
    if (luckyCrit) outcome = "crit";
    const dodged = (outcome === "hit" || outcome === "crit") && check(SLOT.dodge, i, statValue("dodge", theirs.dodge));
    if (dodged) outcome = "miss";
    const countered = outcome === "miss" && check(SLOT.counter, i, counterChance(theirs.counter));
    if (countered) outcome = "counter";
    const swing: Swing = {
      attackerId: attacker,
      defenderId: defender,
      die,
      outcome,
      damage: 0,
      ...(lucky ? { lucky: true } : {}),
      ...(luckyCrit ? { luckyCrit: true } : {}),
      ...(dodged ? { dodged: true } : {}),
    };
    swings.push(swing);
    if (outcome === "miss") {
      addEvent(state, "duel_action", now, {
        duelId: duel.id,
        userId: attacker,
        targetId: defender,
        ability: look(attacker),
        amount: 0,
        hp: clone(duel.hp),
        miss: true,
        die,
        ...(dodged ? { dodged: true } : {}),
      });
    } else {
      const dealer = outcome === "counter" ? defender : attacker,
        target = outcome === "counter" ? attacker : defender;
      // hp[target]! (four times, to `finisher`): beginDuel gave both fighters an hp entry
      // a counter adds the dealer's counter bonus on top of power and guard
      const bonus = outcome === "counter" ? 1 + statValue("counter", stats[dealer]!.counter) : 1;
      const amount = suddenDeath
        ? duel.hp[target]!
        : Math.min(duel.hp[target]!, scaledDamage(Math.round(blow[outcome] * bonus), stats[dealer], stats[target]));
      duel.hp[target]! -= amount;
      swing.damage = amount;
      const finisher = duel.hp[target]! <= 0;
      addEvent(state, "duel_action", now, {
        duelId: duel.id,
        userId: dealer,
        targetId: target,
        ability: look(dealer),
        amount,
        hp: clone(duel.hp),
        die,
        ...(outcome === "counter" ? { counter: true } : {}),
        ...(outcome === "crit" ? { crit: true } : {}),
        ...(lucky ? { lucky: true } : {}),
        ...(luckyCrit ? { luckyCrit: true } : {}),
        ...(dodged ? { dodged: true } : {}),
        ...(finisher ? { finisher: true } : {}),
      });
      if (finisher) {
        winnerId = dealer;
        loserId = target;
      }
    }
    [attacker, defender] = [defender, attacker];
  }
  const flawless = duel.hp[winnerId] === fullHp(duel, winnerId);
  finishDuel(state, duel, winnerId, now, { decision, bonus: flawless ? QUICK_FLAWLESS_BONUS : 0 });
  duel.revealAt = now + replayMs(swings.length) + state.config.streamDelayMs;
  return {
    ok: true,
    reason: "quick_duel",
    duelId: duel.id,
    winnerId,
    loserId,
    swings,
    winnerHp: duel.hp[winnerId],
    flawless,
    decision,
  };
}

function hashRoll(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

function finishDuel(
  state: GameState,
  duel: Duel,
  winnerId: string,
  now: number,
  { decision = "ko", bonus = 0 }: { decision?: string; bonus?: number } = {},
): void {
  const a = player(state, duel.a);
  const b = player(state, duel.b);
  if (!a || !b) return;
  const ratingA = a.elo;
  const ratingB = b.elo;
  // An unrated duel (offline, new account, or past the pair's limit) is played out but changes no Elo, wins or losses.
  const rated = !duel.unrated;
  if (!rated) bonus = 0;
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const scoreA = winnerId === duel.a ? 1 : 0;
  const nextA = rated
    ? Math.round(ratingA + state.config.eloK * (scoreA - expectedA)) + (scoreA === 1 ? bonus : 0)
    : ratingA;
  const nextB = rated
    ? Math.round(ratingB + state.config.eloK * (1 - scoreA - (1 - expectedA))) + (scoreA === 0 ? bonus : 0)
    : ratingB;
  a.elo = nextA;
  b.elo = nextB;
  if (rated && winnerId === duel.a) {
    a.wins += 1;
    b.losses += 1;
  } else if (rated) {
    b.wins += 1;
    a.losses += 1;
  }
  if (rated && state.config.pairRankedPerStream > 0)
    state.pairPlays = [
      ...state.pairPlays,
      { pair: pairKey(duel.a, duel.b), at: now, stream: state.stream?.id || "" },
    ].slice(-MAX_PAIR_PLAYS);
  // The loser is knocked out (hp 0) and respawns at full health after respawnMs; the winner is healed at once.
  const winner = winnerId === duel.a ? a : b;
  const loser = winnerId === duel.a ? b : a;
  winner.hp = state.config.maxHp;
  winner.respawnAt = 0;
  loser.hp = 0;
  // finishDuel runs on a started duel, which has rules
  loser.respawnAt = now + duel.rules!.respawnMs;
  a.lastOpponentId = b.userId;
  b.lastOpponentId = a.userId;
  duel.status = "completed";
  duel.winnerId = winnerId;
  duel.endedAt = now;
  duel.ratings = {
    [duel.a]: { before: ratingA, after: nextA, delta: nextA - ratingA },
    [duel.b]: { before: ratingB, after: nextB, delta: nextB - ratingB },
  };
  if (bonus) {
    // ratings has an entry for both fighters, and winnerId is one of them
    duel.ratings[winnerId]!.bonus = bonus;
    duel.flawless = true;
  }
  // Dollars for saved fighters; the room adds them to the profiles once (server/room-economy.ts payDuels). Past the pair's
  // limit a duel pays half; offline and new-account duels pay nothing.
  const pay = (amount: number): number => (rated ? amount : duel.unrated === "pair_cap" ? Math.floor(amount / 2) : 0);
  const payout: Record<string, number> = {};
  if (winner.registered && pay(state.config.winDollars) > 0) payout[winner.userId] = pay(state.config.winDollars);
  if (loser.registered && pay(state.config.lossDollars) > 0) payout[loser.userId] = pay(state.config.lossDollars);
  if (Object.keys(payout).length) duel.payout = payout;
  if (decision !== "ko") duel.decision = decision;
  state.rematchLocks.push({
    pair: pairKey(duel.a, duel.b),
    // a started duel has rules
    until: now + duel.rules!.rematchDelayMs,
  });
  addEvent(state, "duel_completed", now, {
    duelId: duel.id,
    winnerId,
    loserId: loser.userId,
    round: duel.round,
    respawnAt: loser.respawnAt,
    hp: clone(duel.hp),
    ratings: clone(duel.ratings),
    ...(bonus ? { flawless: true } : {}),
    ...(decision !== "ko" ? { decision } : {}),
    ...(rated ? {} : { unrated: duel.unrated }),
  });
}

// An HP-fight strike or heavy crits (+HP_CRIT_BONUS damage) with the actor's crit chance, from the command's first
// roll (or a hash, so the reducer stays pure).
function applyAbility(
  state: GameState,
  duel: Duel,
  actor: Player,
  abilityName: string,
  now: number,
  rolls: unknown = [],
): GameResult {
  if (!ABILITIES.has(abilityName)) return { ok: false, reason: "invalid_ability" };
  // rules! and cooldowns! : applyCommand only picks an active duel, and beginDuel set both
  // abilityName passed ABILITIES above
  const ability = duel.rules!.abilities[abilityName as AbilityName];
  if (!ability) return { ok: false, reason: "invalid_ability" };
  const cooldown = duel.cooldowns![actor.userId];
  if (!cooldown) return { ok: false, reason: "not_in_duel" };
  const abilityUntilKey = abilityName + "Until";
  // the key is strikeUntil, heavyUntil or healUntil: abilityName passed ABILITIES above
  const availableAt = Math.max(cooldown.sharedUntil, cooldown[abilityUntilKey as keyof Cooldowns] || 0);
  if (now < availableAt) return { ok: false, reason: "cooldown", retryAt: availableAt };
  // hp! and rules! from here to the end of the function: an active duel has an hp entry for both fighters, and rules
  if (duel.hp[actor.userId]! <= 0) return { ok: false, reason: "respawning" };

  const targetId = actor.userId === duel.a ? duel.b : duel.a;
  let amount = 0,
    crit = false;
  if (abilityName === "heal") {
    const before = duel.hp[actor.userId]!;
    // the heal branch, so ability is abilities.heal
    duel.hp[actor.userId] = Math.min(fullHp(duel, actor.userId), before + (ability as Abilities["heal"]).amount);
    amount = duel.hp[actor.userId]! - before;
  } else {
    const before = duel.hp[targetId]!;
    const synced = duelStats(state, duel);
    const mine = synced[actor.userId]!;
    const first: unknown = Array.isArray(rolls) ? rolls[0] : undefined;
    const roll =
      typeof first === "number" && first >= 0 && first < 1
        ? first
        : hashRoll(duel.id + ":" + now + ":" + actor.userId + ":crit");
    crit = roll < statValue("crit", mine.crit);
    const damage = scaledDamage(
      // not the heal branch, so ability is abilities.strike or abilities.heavy
      Math.round((ability as Abilities["strike"]).damage * (crit ? 1 + HP_CRIT_BONUS : 1)),
      mine,
      synced[targetId],
    );
    duel.hp[targetId] = Math.max(0, before - damage);
    amount = before - duel.hp[targetId];
  }
  cooldown.sharedUntil = now + duel.rules!.sharedCooldownMs;
  // same key as above (ABILITIES checked abilityName)
  cooldown[abilityUntilKey as keyof Cooldowns] = now + ability.cooldownMs;
  duel.lastActionAt = now;
  actor.lastSeen = now;
  actor.hp = duel.hp[actor.userId]!;
  const target = player(state, targetId);
  if (target) target.hp = duel.hp[targetId]!;

  addEvent(state, "duel_action", now, {
    duelId: duel.id,
    userId: actor.userId,
    targetId: abilityName === "heal" ? actor.userId : targetId,
    ability: abilityName,
    amount,
    hp: clone(duel.hp),
    ...(crit ? { crit: true } : {}),
  });
  if (duel.hp[targetId]! <= 0) {
    finishDuel(state, duel, actor.userId, now);
    return {
      ok: true,
      reason: "duel_completed",
      duelId: duel.id,
      ability: abilityName,
      amount,
      winnerId: actor.userId,
    };
  }
  return { ok: true, reason: "action_applied", duelId: duel.id, ability: abilityName, amount };
}

function applyCommand(state: GameState, event: CommandEvent, now: number): GameResult {
  const parsed = parseGameCommand(event.text);
  if (!parsed) return { ok: false, reason: "not_game_command" };
  const userId = normalizeUserId(event.userId);
  const actor = registeredPlayer(state, userId, event, now);
  if (!actor) return { ok: false, reason: "ranked_sign_in_required" };
  const quick = state.config.quickDuel || event.quick === true;

  if (parsed.action === "duel" || parsed.action === "rematch") {
    let target;
    if (parsed.action === "rematch") {
      // Answer a waiting challenge, or challenge the last opponent of a finished duel (the room passes their saved
      // profile as targetProfile). A player has at most one open duel, so there is at most one waiting challenge.
      const incoming = openDuels(state).find((item) => item.status === "pending" && item.b === actor.userId);
      const lastId = incoming ? incoming.a : actor.lastOpponentId;
      target =
        lastId &&
        (player(state, lastId) ||
          (normalizeUserId(event.targetProfile?.userId) === lastId
            ? recentProfile(state, event.targetProfile, now)
            : null));
      if (!target) return { ok: false, reason: "no_previous_opponent" };
    } else {
      const username = normalizeUsername(parsed.target);
      if (!username) return { ok: false, reason: "target_required" };
      target = findTargetProfile(state, event, username, now);
      if (!target) return { ok: false, reason: "target_not_found" };
    }
    if (!target.registered) return { ok: false, reason: "ranked_sign_in_required" };
    // Challenging someone who already challenged you accepts their challenge.
    const mutual = openDuels(state).find(
      (item) => item.status === "pending" && item.a === target.userId && item.b === actor.userId,
    );
    if (mutual) {
      const started = beginDuel(state, mutual, now, event);
      if (started.ok && quick) return settleQuickDuel(state, mutual, event.rolls, now);
      return started.ok ? { ...started, reason: "duel_started" } : started;
    }
    return createChallenge(state, actor, target, now);
  }

  if (parsed.action === "accept" || parsed.action === "decline") {
    const challenger = normalizeUsername(parsed.target);
    const duel = openDuels(state).find((item) => {
      if (item.status !== "pending" || item.b !== actor.userId) return false;
      if (!challenger) return true;
      const a = player(state, item.a);
      return a?.username === challenger;
    });
    if (!duel) return { ok: false, reason: "challenge_not_found" };
    if (parsed.action === "decline") {
      duel.status = "declined";
      duel.endedAt = now;
      addEvent(state, "challenge_declined", now, { duelId: duel.id, declinedBy: actor.userId });
      return { ok: true, reason: "challenge_declined", duelId: duel.id };
    }
    const started = beginDuel(state, duel, now, event);
    if (started.ok && quick) return settleQuickDuel(state, duel, event.rolls, now);
    return started;
  }

  const abilityName = parsed.action === "attack" ? actor.defaultAbility : parsed.action;
  const duel = openDuels(state).find((item) => item.status === "active" && duelHasUser(item, actor.userId));
  if (!duel) return { ok: false, reason: "not_in_active_duel" };
  if (parsed.target) {
    const targetName = normalizeUsername(parsed.target);
    const opponentId = duel.a === actor.userId ? duel.b : duel.a;
    if (player(state, opponentId)?.username !== targetName) return { ok: false, reason: "wrong_opponent" };
  }
  return applyAbility(state, duel, actor, abilityName, now, event.rolls);
}

/** A config change as validateConfigPatch passes it on: known keys only, each in range. */
type ConfigPatch = { [key: string]: unknown; abilities?: { [name: string]: { [field: string]: number } } };
type Check = (value: unknown) => boolean;
const int =
  (min: number, max: number): Check =>
  (value) =>
    boundedInt(value, min, max) !== null;
const flag: Check = (value) => typeof value === "boolean";
const price = int(1, 100_000);
// The values a mod may set for each config key but abilities; anything else is refused as invalid_config_<key>.
const CONFIG_CHECKS: { [key in Exclude<keyof Config, "abilities">]: Check } = {
  enabled: flag,
  quickDuel: flag,
  announce: (value) => ANNOUNCE.includes(value),
  maxOnStream: int(...ON_STREAM),
  maxHp: int(1, 1_000),
  maxDuels: int(1, 5),
  challengeTimeoutMs: int(5_000, 300_000),
  inactivityMs: int(10_000, 600_000),
  respawnMs: int(0, 60_000),
  rematchDelayMs: int(0, 600_000),
  streamDelayMs: int(0, 60_000),
  sharedCooldownMs: int(250, 60_000),
  initialElo: int(0, 10_000),
  eloK: int(1, 100),
  checkinPoints: int(0, 3),
  streakBonus: flag,
  maxStatLevel: int(1, 200),
  winDollars: int(0, 100),
  lossDollars: int(0, 100),
  pairRankedPerStream: int(0, 50),
  giveEnabled: flag,
  giveMaxPerStream: int(0, 10_000),
  giveMinDuels: int(0, 1_000),
  reminderMin: (value) => value === 0 || int(10, 240)(value),
  botEnabled: flag,
  petPriceCommon: price,
  petPriceUncommon: price,
  petPriceRare: price,
  petPriceEpic: price,
  petPriceLegendary: price,
  hatPricePerWin: int(0, 1_000),
  recolorPrice: price,
  petColorPrice: price,
  accessoryPrice: price,
  trailPrice: price,
  effectPrice: price,
  tauntPrice: price,
  titlePrice: price,
  buildSlotPrice: price,
  buildSlotPriceMore: price,
};
const isRecord = (value: unknown): value is { [key: string]: unknown } =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
function validateConfigPatch(patch: Untrusted): { ok: true; patch: ConfigPatch } | { ok: false; reason: string } {
  if (!isRecord(patch)) return { ok: false, reason: "invalid_config" };
  const out: ConfigPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "relayLeaseMs") continue; // removed with the relay; old history versions may carry it, so rollbacks skip it
    if (key === "abilities") {
      if (!isRecord(value)) return { ok: false, reason: "invalid_config_abilities" };
      const abilities: { [name: string]: { [field: string]: number } } = {};
      for (const [name, spec] of Object.entries(value)) {
        if (!ABILITIES.has(name) || !isRecord(spec)) return { ok: false, reason: "invalid_config_ability" };
        const allowed = name === "heal" ? ["amount", "cooldownMs"] : ["damage", "cooldownMs"];
        const fields: { [field: string]: number } = {};
        for (const [field, amount] of Object.entries(spec)) {
          if (!allowed.includes(field)) return { ok: false, reason: "invalid_config_ability_field" };
          const valid = field === "cooldownMs" ? boundedInt(amount, 250, 600_000) : boundedInt(amount, 1, 1_000);
          if (valid === null) return { ok: false, reason: "invalid_config_ability_value" };
          fields[field] = valid;
        }
        abilities[name] = fields;
      }
      out.abilities = abilities;
    } else if (Object.hasOwn(CONFIG_CHECKS, key)) {
      // hasOwn: key is one of CONFIG_CHECKS' own keys
      if (!CONFIG_CHECKS[key as keyof typeof CONFIG_CHECKS](value))
        return { ok: false, reason: "invalid_config_" + key };
      out[key] = value;
    } else return { ok: false, reason: "unknown_config_field" };
  }
  return { ok: true, patch: out };
}

/** What every admin action gets: the acting mod, the payload and the profile id lists its result carries. */
type AdminCtx = {
  state: GameState;
  event: AdminEvent;
  payload: AdminPayload;
  actorId: string;
  now: number;
  ids: { dirtyProfileIds: string[]; deletedProfileIds: string[] };
};
// The fighter an action names, when they are on stage or have a saved profile (the room passes it as targetProfile).
function adminTarget({ state, event, payload }: AdminCtx): { userId: string; p: Player | undefined } | null {
  const userId = normalizeUserId(payload.userId);
  const p = player(state, userId);
  const stored = event.targetProfile?.userId === userId && event.targetProfile?.registered;
  return userId && (p?.registered || stored) ? { userId, p } : null;
}
const fits = (value: unknown, max: number): boolean => Number.isInteger(value) && value >= 0 && value <= max;
const ADMIN_ACTIONS: { [action: string]: (ctx: AdminCtx) => GameResult } = {
  config({ state, payload, actorId, now, ids }) {
    if (payload.baseVersion !== undefined && payload.baseVersion !== state.configVersion) {
      return { ok: false, reason: "config_version_conflict", configVersion: state.configVersion };
    }
    const patchResult = validateConfigPatch(payload.patch || payload.config);
    if (!patchResult.ok) return patchResult;
    const config: { [key: string]: unknown; abilities: { [name: string]: { [field: string]: number } } } = {
      ...state.config,
    };
    const { abilities, ...rest } = patchResult.patch;
    Object.assign(config, rest);
    if (abilities) {
      config.abilities = { ...config.abilities };
      for (const [name, spec] of Object.entries(abilities))
        config.abilities[name] = { ...config.abilities[name], ...spec };
    }
    state.config = normalizeConfig(config);
    state.configVersion += 1;
    if (!state.config.enabled) {
      for (const duel of openDuels(state)) cancelDuel(state, duel, now, "duels_disabled");
    }
    addEvent(state, "config_updated", now, {
      actorId,
      configVersion: state.configVersion,
      config: clone(state.config),
    });
    return {
      ok: true,
      reason: "config_updated",
      config: clone(state.config),
      configVersion: state.configVersion,
      ...ids,
    };
  },
  cancelDuel({ state, payload, now, ids }) {
    const duelId = safeString(payload.duelId, 64);
    const duel = openDuels(state).find((item) => item.id === duelId);
    if (!duel) return { ok: false, reason: "duel_not_found" };
    cancelDuel(state, duel, now, "moderator_cancelled");
    return { ok: true, reason: "duel_cancelled", duelId, ...ids };
  },
  resetHealth({ state, actorId, now, ids }) {
    for (const duel of state.duels) {
      if (duel.status !== "active") continue;
      for (const userId of [duel.a, duel.b]) {
        duel.hp[userId] = fullHp(duel, userId);
        const p = player(state, userId);
        if (p) {
          p.hp = fullHp(duel, userId);
          p.respawnAt = 0;
        }
      }
      duel.lastActionAt = now;
      duel.cooldowns = freshCooldowns(duel);
    }
    for (const p of state.players)
      if (!hasOpenDuel(state, p.userId)) {
        p.hp = state.config.maxHp;
        p.respawnAt = 0;
      }
    addEvent(state, "health_reset", now, { actorId });
    return { ok: true, reason: "health_reset", ...ids };
  },
  resetRank(ctx) {
    const target = adminTarget(ctx);
    if (!target) return { ok: false, reason: "profile_not_found" };
    if (target.p) Object.assign(target.p, { elo: ctx.state.config.initialElo, wins: 0, losses: 0 });
    addEvent(ctx.state, "rank_reset", ctx.now, { actorId: ctx.actorId, userId: target.userId });
    return { ok: true, reason: "rank_reset", ...ctx.ids, rankResetIds: [target.userId] };
  },
  restoreRank(ctx) {
    const target = adminTarget(ctx);
    if (!target) return { ok: false, reason: "profile_not_found" };
    const { elo, wins, losses } = ctx.payload;
    if (!fits(elo, 10_000) || !fits(wins, 1_000_000) || !fits(losses, 1_000_000))
      return { ok: false, reason: "invalid_rank" };
    // as: fits() checked elo, wins and losses above
    const rank = { elo, wins, losses } as Omit<RankSet, "userId">;
    if (target.p) Object.assign(target.p, rank);
    addEvent(ctx.state, "rank_restored", ctx.now, { actorId: ctx.actorId, userId: target.userId, ...rank });
    return { ok: true, reason: "rank_restored", ...ctx.ids, rankSet: { userId: target.userId, ...rank } };
  },
  resetAllRanks({ state, actorId, now, ids }) {
    for (const p of state.players) {
      if (!p.registered) continue;
      Object.assign(p, { elo: state.config.initialElo, wins: 0, losses: 0 });
      ids.dirtyProfileIds.push(p.userId);
    }
    state.pairPlays = []; // a fresh start for everyone, so the pair counts start over too
    addEvent(state, "all_ranks_reset", now, { actorId });
    return { ok: true, reason: "all_ranks_reset", ...ids, resetAllRanks: true };
  },
  // Mods start one pair's ranked count for this stream over (the room resolves the two names to user ids).
  resetPair({ state, payload, actorId, now }) {
    const a = normalizeUserId(payload.a),
      b = normalizeUserId(payload.b);
    if (!a || !b || a === b) return { ok: false, reason: "invalid_pair" };
    const pair = pairKey(a, b),
      before = state.pairPlays.length;
    state.pairPlays = state.pairPlays.filter((play) => play.pair !== pair);
    addEvent(state, "pair_reset", now, { actorId, a, b });
    return { ok: true, reason: "pair_reset", amount: before - state.pairPlays.length };
  },
  // Clears players, duels and rematch locks; stored profiles and ranks stay.
  resetAll({ state, actorId, now, ids }) {
    for (const duel of openDuels(state)) cancelDuel(state, duel, now, "moderator_reset");
    state.players = [];
    state.rematchLocks = [];
    addEvent(state, "game_reset", now, { actorId });
    return { ok: true, reason: "game_reset", ...ids, resetAllRanks: false };
  },
  resetRound({ state, actorId, now, ids }) {
    state.round = 0;
    addEvent(state, "round_reset", now, { actorId });
    return { ok: true, reason: "round_reset", round: 0, ...ids };
  },
  removePlayer({ state, payload, actorId, now, ids }) {
    const userId = normalizeUserId(payload.userId);
    if (!userId) return { ok: false, reason: "profile_not_found" };
    for (const duel of openDuels(state).filter((item) => duelHasUser(item, userId)))
      cancelDuel(state, duel, now, "player_removed");
    state.players = state.players.filter((p) => p.userId !== userId);
    ids.deletedProfileIds.push(userId);
    addEvent(state, "player_removed", now, { actorId, userId });
    return { ok: true, reason: "player_removed", ...ids };
  },
};

function applyAdmin(state: GameState, event: AdminEvent, now: number): GameResult {
  const actorId = normalizeUserId(event.actorId);
  if (!actorId) return { ok: false, reason: "unauthorized" };
  const action = safeString(event.action, 32);
  if (!Object.hasOwn(ADMIN_ACTIONS, action)) return { ok: false, reason: "unknown_admin_action" };
  const payload = event.payload && typeof event.payload === "object" ? event.payload : event;
  // hasOwn: action is one of the table's own keys
  return ADMIN_ACTIONS[action]!({
    state,
    event,
    payload,
    actorId,
    now,
    ids: { dirtyProfileIds: [], deletedProfileIds: [] },
  });
}

/** What the stream hasn't shown yet for one fighter. */
export type HiddenResult = { elo: number | undefined; wins: number; losses: number; dollars: number };
export function hiddenResults(state: GameState, now: number): Map<string, HiddenResult> {
  const out = new Map<string, HiddenResult>();
  for (const duel of state.duels) {
    // revealAt! : an HP duel has none, and undefined > now is false, so its result counts as shown
    if (duel.status !== "completed" || !(duel.revealAt! > now) || !duel.ratings) continue;
    for (const id of [duel.a, duel.b]) {
      const h = out.get(id) || { elo: duel.ratings[id]?.before, wins: 0, losses: 0, dollars: 0 }; // duels are in order, so the first is the pre-fight Elo
      if (!duel.unrated) {
        if (duel.winnerId === id) h.wins += 1;
        else h.losses += 1;
      }
      h.dollars += duel.payout?.[id] || 0;
      out.set(id, h);
    }
  }
  return out;
}

// A profile as the stream has shown it so far.
export function shownProfile<P extends { userId: string; wins: number; losses: number; dollars?: unknown }>(
  profile: P,
  hidden: Map<string, HiddenResult>,
): P {
  const h = profile && hidden.get(profile.userId);
  if (!h || !Number.isInteger(h.elo)) return profile;
  const shown = {
    ...profile,
    elo: h.elo,
    wins: Math.max(0, profile.wins - h.wins),
    losses: Math.max(0, profile.losses - h.losses),
  };
  if (Number.isInteger(profile.dollars)) shown.dollars = Math.max(0, profile.dollars - h.dollars);
  return shown;
}

// Chat clients append invisible characters (U+E0000 tag chars, U+034F, zero-width spaces) to repeated messages.
export const stripInvisible = (text: string): string =>
  text.replace(/[\u{E0000}-\u{E007F}\u034F\u180E\u200B-\u200D\u2060\uFEFF]/gu, "");

export function parseGameCommand(text: unknown): { action: string; target: string } | null {
  if (typeof text !== "string") return null;
  const match =
    /^!(duel|challenge|rematch|accept|fight|decline|attack|strike|heavy|heal)(?:\s+(@?[a-z0-9_]{1,25}))?\s*$/i.exec(
      stripInvisible(text).trim(),
    );
  if (!match) return null;
  // group 1 is not optional in the regex
  let action = match[1]!.toLowerCase();
  if (action === "challenge") action = "duel";
  if (action === "fight") action = "accept";
  const target = match[2] && action !== "rematch" ? normalizeUsername(match[2]) : ""; // !rematch always means the last opponent
  if (action === "duel" && !target) return null;
  return { action, target };
}

// The pet fields a saved profile carries (channel.ts normalizeProfileRow works them out from the pet id).
function petFields(profile: ProfileInput | null | undefined): { pet: string; petTier: string; petBoost: Stats } {
  const pet = safeString(profile?.pet, 48);
  return {
    pet,
    // includes() only compares, and when it is true the profile exists and petTier is one of TIERS
    petTier: pet && TIERS.includes(profile?.petTier as string) ? (profile!.petTier as string) : "",
    petBoost: pet ? cleanBoost(profile?.petBoost) : emptyStats(),
  };
}

export function applyProfile(
  state: GameState,
  profile: ProfileInput,
  now: number,
): { ok: true; profile: Player } | { ok: false; reason: string } {
  const normalized = {
    ...profile,
    userId: normalizeUserId(profile?.userId),
    username: normalizeUsername(profile?.username),
    displayName: safeString(profile?.displayName || profile?.username, 48),
    avatar: safeString(profile?.avatar || "player", 64),
    color: cleanColor(profile?.color, "#A78BFA"),
    defaultAbility: cleanAbility(profile?.defaultAbility, "strike"),
    stats: cleanStats(profile?.stats),
    hat: knownHat(profile?.hat) ? profile.hat : "",
    ...petFields(profile),
    ...cleanCosmetics(profile),
    registered: true,
  };
  if (!normalized.userId || !normalized.username) return { ok: false, reason: "invalid_profile" };
  const existing = player(state, normalized.userId);
  const p = existing || defaultProfile(normalized.userId, state.config, now);
  // A fighter who left the arena comes back with the rank and record saved in its profile.
  if (!existing) {
    // as const: the three keys are the Player number fields named here
    for (const key of ["elo", "wins", "losses"] as const) if (Number.isInteger(profile?.[key])) p[key] = profile[key];
    if (normalizeUserId(profile?.lastOpponentId)) p.lastOpponentId = normalizeUserId(profile.lastOpponentId);
  }
  // No respec while a challenge or duel is open: the build counts from when the duel starts to its end.
  const build = (x: { stats?: unknown; petBoost?: unknown }): string =>
    JSON.stringify([cleanStats(x.stats), cleanBoost(x.petBoost)]);
  if (existing && hasOpenDuel(state, p.userId) && build(p) !== build(normalized))
    return { ok: false, reason: "in_duel" };
  Object.assign(p, {
    username: normalized.username,
    displayName: normalized.displayName,
    avatar: normalized.avatar,
    color: normalized.color,
    defaultAbility: normalized.defaultAbility,
    stats: normalized.stats,
    hat: normalized.hat,
    pet: normalized.pet,
    petTier: normalized.petTier,
    petBoost: normalized.petBoost,
    ...cleanCosmetics(normalized),
    ...(Number.isInteger(profile?.bonus) ? { bonus: Math.max(0, profile.bonus) } : {}),
    registered: true,
    lastSeen: now,
  });
  if (!existing && !addPlayer(state, p)) return { ok: false, reason: "active_player_cap" };
  return { ok: true, profile: p };
}

/** What an event handler may note beyond its result: state to persist without a new snapshot, and saved profiles. */
type Step = { now: number; didExpire: boolean; touched: boolean; dirty: string[] };
// A chat message's sender as the reducer seeds them: their saved profile under the name chat shows now.
function chatter(
  event: { username?: string | undefined; displayName?: string | undefined; profile?: ProfileInput | null | undefined },
  userId: string,
): ProfileInput {
  const { username, displayName, profile } = event;
  if (!profile) return { userId, username, displayName };
  return {
    ...profile,
    userId,
    username: username || profile.username,
    displayName: displayName || profile.displayName,
  };
}
// One handler per GameEvent type; a type without one fails tsc here.
const EVENTS: {
  [type in GameEvent["type"]]: (state: GameState, event: Extract<GameEvent, { type: type }>, step: Step) => GameResult;
} = {
  // A subscription was created or found. Chat counts as connected once Twitch reports it enabled (or once its webhook
  // verification has already arrived; the two can race).
  chat_subscription(state, event, step) {
    const subscriptionId = safeString(event.subscriptionId, 100);
    const wasConnected = state.chat.connected;
    let status = safeString(event.status, 64) || "pending";
    if (subscriptionId && subscriptionId === state.chat.verifiedId) status = "enabled";
    state.chat = {
      ...state.chat,
      subscriptionId,
      status,
      connected: status === "enabled",
      createdAt: Number.isFinite(event.createdAt) ? event.createdAt : step.now,
      revokedReason: "",
      checkedAt: step.now,
      verifiedId: "",
    };
    if (state.chat.connected && !wasConnected) addEvent(state, "chat_connected", step.now);
    else step.touched = true;
    return { ok: true, reason: state.chat.connected ? "chat_connected" : "chat_pending", status };
  },
  chat_verified(state, event, step) {
    const subscriptionId = safeString(event.subscriptionId, 100);
    if (!subscriptionId) return { ok: false, reason: "invalid_event" };
    if (subscriptionId !== state.chat.subscriptionId) {
      state.chat.verifiedId = subscriptionId; // verification beat the create response
      step.touched = true;
      return { ok: true, reason: "chat_verified_early" };
    }
    if (state.chat.connected) return { ok: true, reason: "no_change" };
    state.chat = { ...state.chat, status: "enabled", connected: true, revokedReason: "" };
    addEvent(state, "chat_connected", step.now);
    return { ok: true, reason: "chat_connected" };
  },
  chat_checked(state, _event, step) {
    state.chat.checkedAt = step.now;
    step.touched = true;
    return { ok: true, reason: "chat_checked" };
  },
  chat_disconnected(state, event, { now }) {
    const reason = safeString(event.reason, 64) || "disconnected";
    for (const duel of openDuels(state)) cancelDuel(state, duel, now, "chat_disconnected");
    state.chat = {
      ...state.chat,
      connected: false,
      status: reason === "disconnected" ? "disconnected" : reason,
      subscriptionId: "",
      revokedReason: reason === "disconnected" ? "" : reason,
      checkedAt: now,
      verifiedId: "",
    };
    addEvent(state, "chat_disconnected", now, { reason });
    return { ok: true, reason: "chat_disconnected" };
  },
  command_rejected(state, event, { now }) {
    addEvent(state, "command_rejected", now, {
      userId: normalizeUserId(event.userId),
      command: safeString(event.command, 16) || "other",
      reason: safeString(event.reason, 64),
      ...(Number(event.retryAt) > 0 ? { retryAt: Number(event.retryAt) } : {}),
    });
    return { ok: true, reason: "logged" };
  },
  presence(state, event, { now }) {
    const userId = normalizeUserId(event.userId);
    if (!recentProfile(state, chatter(event, userId), now)) return { ok: false, reason: "active_player_cap" };
    addEvent(state, "player_seen", now, { userId });
    return { ok: true, reason: "presence_updated", userId };
  },
  command(state, event, { now }) {
    const dedupe = addRecent(state, event);
    if (!dedupe.ok) return { ok: false, reason: dedupe.reason };
    if (!state.chat.connected) return { ok: false, reason: "chat_offline" };
    if (!Number.isFinite(event.timestamp) || now - event.timestamp > 60_000 || event.timestamp - now > 10_000)
      return { ok: false, reason: "stale_command" };
    noteStream(state, event.stream);
    const userId = normalizeUserId(event.userId);
    const parsed = parseGameCommand(event.text);
    const actor = recentProfile(state, chatter(event, userId), now);
    if (!actor) return { ok: false, reason: "active_player_cap" };
    let targetProfile = event.targetProfile;
    if (parsed?.target && targetProfile)
      targetProfile = { ...targetProfile, username: normalizeUsername(targetProfile.username) };
    const result = applyCommand(state, { ...event, userId, profile: actor, targetProfile }, now);
    actor.lastSeen = now;
    addEvent(state, "command_seen", now, { userId, command: parsed?.action || "other" });
    return result;
  },
  profile_saved(state, event, step) {
    const applied = applyProfile(state, event.profile || {}, step.now);
    if (applied.ok) {
      step.dirty.push(applied.profile.userId);
      addEvent(state, "profile_saved", step.now, { userId: applied.profile.userId });
    }
    return applied;
  },
  admin: (state, event, { now }) => applyAdmin(state, event, now),
  tick: (_state, _event, { didExpire }) => ({ ok: true, reason: didExpire ? "state_advanced" : "no_change" }),
};

export function reduceGame(inputState: StoredState, event: GameEvent, now: number = Date.now()): ReduceOutput {
  const state = normalizeGameState(inputState);
  const beforeRevision = state.revision;
  const step: Step = { now, didExpire: expireState(state, now), touched: false, dirty: [] };
  // Untyped callers (tests, old stored events) can name a type without a handler.
  const handler = Object.hasOwn(EVENTS, String(event?.type))
    ? // each handler takes the event its type names, and event.type picked it
      (EVENTS[event.type] as (state: GameState, event: GameEvent, step: Step) => GameResult)
    : null;
  const result: GameResult = handler ? handler(state, event, step) : { ok: false, reason: "unknown_event" };
  // changed: state must be persisted. visible: overlays should receive a new snapshot.
  const visible = state.revision !== beforeRevision || step.didExpire;
  return {
    state,
    result,
    changed: visible || step.touched,
    visible,
    // only admin results carry profile id lists
    dirtyProfileIds: [...new Set([...step.dirty, ...(result.dirtyProfileIds || [])])],
    deletedProfileIds: [...new Set(result.deletedProfileIds)],
    rankResetIds: [...new Set(result.rankResetIds)],
    resetAllRanks: Boolean(result.resetAllRanks),
  };
}

/** A stored game state as read back from storage: any field may be missing or out of date. */
type StoredState = { [key: string]: unknown } | null | undefined;
// Stored state as the reducer sees it: defaults filled in, old presets migrated, never the caller's object.
export function normalizeGameState(input: StoredState): GameState {
  const initial = createInitialState(input?.channel || site.defaultChannel);
  const state = { ...initial, ...(input && typeof input === "object" ? clone(input) : {}) };
  state.channel = safeString(state.channel, 25).toLowerCase() || site.defaultChannel;
  state.revision = Number.isInteger(state.revision) && state.revision >= 0 ? state.revision : 0;
  state.chat = { ...initial.chat, ...(state.chat && typeof state.chat === "object" ? state.chat : {}) };
  delete state.relay;
  state.config = normalizeConfig(state.config);
  if (state.configVersion === 1 && JSON.stringify(state.config) === JSON.stringify(normalizeConfig(LEGACY_CONFIG)))
    state.config = clone(DEFAULT_CONFIG);
  if (state.priceSchema !== 2) {
    // OLD_PRICES only has Config price keys
    for (const [key, old] of Object.entries(OLD_PRICES) as [keyof typeof OLD_PRICES, number][])
      if (state.config[key] === old) state.config[key] = DEFAULT_CONFIG[key];
    state.priceSchema = 2;
  }
  state.players = Array.isArray(state.players)
    ? state.players.filter((p) => p && typeof p.userId === "string").slice(-MAX_ACTIVE_PLAYERS)
    : [];
  state.duels = Array.isArray(state.duels) ? state.duels : [];
  state.rematchLocks = Array.isArray(state.rematchLocks) ? state.rematchLocks : [];
  state.pairPlays = Array.isArray(state.pairPlays) ? state.pairPlays : [];
  if (state.stream && typeof state.stream.id !== "string") delete state.stream;
  state.events = Array.isArray(state.events) ? state.events.slice(-MAX_RECENT_EVENTS) : [];
  state.appliedMessageIds = Array.isArray(state.appliedMessageIds)
    ? state.appliedMessageIds.slice(-MAX_APPLIED_MESSAGE_IDS)
    : [];
  state.nextDuelId = Number.isInteger(state.nextDuelId) && state.nextDuelId > 0 ? state.nextDuelId : 1;
  state.configVersion = Number.isInteger(state.configVersion) && state.configVersion > 0 ? state.configVersion : 1;
  state.round = Number.isInteger(state.round) && state.round >= 0 ? state.round : 0;
  return state;
}

export function defaultConfig(): Config {
  return clone(DEFAULT_CONFIG);
}

/** The admin and diagnostics view of the chat source. */
export type ChatStatus = {
  connected: boolean;
  source: "streamelements" | "twitch" | "";
  status: string;
  subscriptionId: string;
  createdAt: number;
  lastNotificationAt: number;
  lastRevocationReason: string;
  checkedAt: number;
};
export function chatStatus(state: { chat?: Partial<GameState["chat"]> | null | undefined }): ChatStatus {
  const chat = state.chat || {};
  return {
    connected: Boolean(chat.connected),
    source: String(chat.subscriptionId || "").startsWith("se-")
      ? "streamelements"
      : chat.subscriptionId
        ? "twitch"
        : "",
    status: String(chat.status || "disconnected"),
    subscriptionId: String(chat.subscriptionId || ""),
    createdAt: Number(chat.createdAt) || 0,
    lastNotificationAt: Number(chat.lastSeen) || 0,
    lastRevocationReason: String(chat.revokedReason || ""),
    checkedAt: Number(chat.checkedAt) || 0,
  };
}
