// The game's data shapes: the channel config (with its defaults), the state ChannelRoom keeps, the events reduceGame
// takes, and what the overlay socket sends (docs/CONTRACTS.md §3 and §6).
import type { Stats } from "./upgrades.ts";

/** A chat message as server/eventsub.ts forwards it to the room: only the fields the room reads, capped in length. */
export type ChatEvent = {
  broadcaster_user_id: string;
  broadcaster_user_login: string;
  chatter_user_id: string;
  chatter_user_login: string;
  chatter_user_name: string;
  color: string;
  message_id: string;
  message: { text: string };
  /** Wears a MOD_BADGES badge (broadcaster, moderator or lead_moderator). */
  mod: boolean;
};

/** A value parsed from JSON whose fields nobody has checked yet. */
export type Untrusted = { [key: string]: unknown } | unknown[] | string | number | boolean | null | undefined;

export type AbilityName = "strike" | "heavy" | "heal";
/** A channel's settings and their defaults (ranges in CONFIG_CHECKS in server/game.ts, docs/CONTRACTS.md §7). */
export const DEFAULT_CONFIG = {
  enabled: true,
  // Off = the HP fight (!attack/!strike/!heavy/!heal). StreamElements has no attack commands, so its duels always
  // settle quickly.
  quickDuel: true,
  // "off", "top" or "bottom"
  announce: "off",
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
  checkinPoints: 1,
  streakBonus: true,
  // Levels above it stay saved but don't count on this channel.
  maxStatLevel: 16,
  winDollars: 5,
  lossDollars: 3,
  // 0 = no limit. Past it a pair duels unrated for half the dollars.
  pairRankedPerStream: 0,
  giveEnabled: true,
  giveMaxPerStream: 100,
  giveMinDuels: 5,
  // Minutes between the bot's !fray lines while live (0 = off, else 10 to 240).
  reminderMin: 0,
  botEnabled: true,
  // A duel pays about $4, so a common pet is ~3 duels, a recolor ~5 and a legendary pet ~75.
  petPriceCommon: 10,
  petPriceUncommon: 25,
  petPriceRare: 60,
  petPriceEpic: 140,
  petPriceLegendary: 300,
  hatPricePerWin: 3,
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
export type Config = typeof DEFAULT_CONFIG;

/** The cosmetics a fighter wears (server/cosmetics.ts cleanCosmetics); "" = none. */
export type Cosmetics = {
  recolor: string;
  petColor: string;
  accessory: string;
  trail: string;
  winEffect: string;
  taunt: string;
  title: string;
};

/** A fighter in the arena (docs/CONTRACTS.md §3 Player). */
export type Player = Cosmetics & {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  color: string;
  defaultAbility: string;
  hp: number;
  elo: number;
  wins: number;
  losses: number;
  lastSeen: number;
  registered: boolean;
  /** respawnAt > now means knocked out. */
  respawnAt: number;
  stats: Stats;
  hat: string;
  /** Check-in points, added to the wins for upgrades. */
  bonus: number;
  pet: string;
  petTier: string;
  petBoost: Stats;
  /** The last finished duel's opponent, for !rematch. */
  lastOpponentId?: string;
};

// A fighter as a caller hands it to the reducer (a profile row, a dashboard save or a chat stub). Any field may be
// missing; rows carry extra columns.
export type ProfileInput = { [K in keyof Player]?: Player[K] | undefined } & {
  dollars?: number | undefined;
  [key: string]: unknown;
};

export type Cooldowns = { sharedUntil: number; strikeUntil: number; heavyUntil: number; healUntil: number };

/** A challenge or duel (docs/CONTRACTS.md §3 Duel). The fields below `winnerId` are set once it starts or ends. */
export type Duel = {
  id: string;
  a: string;
  b: string;
  status: "pending" | "active" | "completed" | "cancelled" | "expired" | "declined";
  createdAt: number;
  expiresAt: number;
  /** userId -> hp; both fighters have an entry once the duel starts. */
  hp: Record<string, number>;
  winnerId: string | null;
  startedAt?: number;
  lastActionAt?: number;
  round?: number;
  /** The config the duel started with, so a mid-duel config change doesn't touch it. */
  rules?: Pick<Config, "maxHp" | "inactivityMs" | "respawnMs" | "rematchDelayMs" | "sharedCooldownMs" | "abilities">;
  /** userId -> full health in this duel: rules.maxHp plus vitality (server/upgrades.ts bonusHp). */
  maxHp?: Record<string, number>;
  cooldowns?: Record<string, Cooldowns>;
  /** Played out, but moves no Elo, wins or losses. Only "pair_cap" pays dollars, half (finishDuel). */
  unrated?: "offline" | "new_account" | "pair_cap";
  /** The pair's last ranked duel this stream (config.pairRankedPerStream). */
  lastRanked?: boolean;
  endedAt?: number;
  cancelReason?: string;
  ratings?: Record<string, { before: number; after: number; delta: number; bonus?: number }>;
  flawless?: boolean;
  /** userId -> dollars the room pays out once (server/room-economy.ts payDuels). */
  payout?: Record<string, number>;
  /** How a quick duel ended when not by knockout: "hp" or "sudden_death". */
  decision?: string;
  /** Until this time chat keeps the result hidden (hiddenResults). */
  revealAt?: number;
};

/** One entry of the event log the overlay plays (docs/CONTRACTS.md §3, event types table). */
export type GameLogEvent = { id: string; type: string; at: number; [field: string]: unknown };

/** What ChannelRoom stores for a channel (createInitialState, normalizeGameState in server/game.ts). */
export type GameState = {
  channel: string;
  revision: number;
  /** The chat source (one Twitch EventSub subscription, or StreamElements). */
  chat: {
    connected: boolean;
    /** Last notification. */
    lastSeen: number;
    subscriptionId: string;
    status: string;
    createdAt: number;
    revokedReason: string;
    checkedAt: number;
    verifiedId: string;
  };
  config: Config;
  configVersion: number;
  round: number;
  players: Player[];
  duels: Duel[];
  rematchLocks: { pair: string; until: number }[];
  /** Ranked duels per pair; `stream` is the stream id ("" when never known, missing on entries from before 2026-10-15). */
  pairPlays: { pair: string; at: number; stream?: string }[];
  /** The channel's live stream as the room last saw it: null offline, missing before the first answer (counts as live). */
  stream?: { id: string; startedAt: number } | null;
  events: GameLogEvent[];
  appliedMessageIds: string[];
  nextDuelId: number;
  /** 2 once the 2026-10-06 price cut has been applied. */
  priceSchema?: number;
  /** Removed with the relay; normalizeGameState deletes it from old stored states. */
  relay?: unknown;
};

/** The fields an admin action reads, at the top level or under `payload`. */
export type AdminPayload = {
  baseVersion?: unknown;
  patch?: Untrusted;
  config?: Untrusted;
  duelId?: unknown;
  userId?: unknown;
  elo?: unknown;
  wins?: unknown;
  losses?: unknown;
  /** resetPair: the two fighters' user ids. */
  a?: unknown;
  b?: unknown;
};

/** A chat command as the room hands it to the reducer (server/room-bot.ts processChatMessage). */
export type CommandEvent = {
  type: "command";
  messageId?: unknown;
  id?: unknown;
  userId?: unknown;
  username?: string | undefined;
  displayName?: string | undefined;
  text?: unknown;
  timestamp?: unknown;
  profile?: ProfileInput | null | undefined;
  targetProfile?: ProfileInput | null | undefined;
  /** userIds of Twitch accounts younger than NEW_ACCOUNT_MS. */
  newAccounts?: unknown;
  /** Settle at once even when config.quickDuel is off (StreamElements commands). */
  quick?: unknown;
  /** Numbers in [0, 1) for a quick duel; missing ones come from a hash. */
  rolls?: unknown;
  /** The room's live check for commands that can start a duel: {id, startedAt}, null offline, undefined unknown. */
  stream?: unknown;
};

export type AdminEvent = AdminPayload & {
  type: "admin";
  actorId?: unknown;
  actorName?: unknown;
  action?: unknown;
  payload?: AdminPayload | null | undefined;
  note?: unknown;
  targetProfile?: ProfileInput | null | undefined;
};

/** Everything reduceGame accepts; each `type` has one branch there. */
export type GameEvent =
  | { type: "chat_subscription"; subscriptionId?: unknown; status?: unknown; createdAt?: unknown }
  | { type: "chat_verified"; subscriptionId?: unknown }
  | { type: "chat_checked" }
  | { type: "chat_disconnected"; reason?: unknown }
  | { type: "command_rejected"; userId?: unknown; command?: unknown; reason?: unknown; retryAt?: unknown }
  | {
      type: "presence";
      userId?: unknown;
      username?: string | undefined;
      displayName?: string | undefined;
      profile?: ProfileInput | null | undefined;
    }
  | CommandEvent
  | { type: "profile_saved"; profile?: ProfileInput | null | undefined }
  | AdminEvent
  | { type: "tick" };

/** One roll of a quick duel. */
export type Swing = {
  attackerId: string;
  defenderId: string;
  die: number;
  outcome: "crit" | "hit" | "counter" | "miss";
  damage: number;
  /** Luck turned a miss into a hit. */
  lucky?: true;
  /** The crit stat turned a hit into a crit. */
  luckyCrit?: true;
  /** The defender's dodge turned a hit or crit into a miss (a counter may follow). */
  dodged?: true;
};

export type RankSet = { userId: string; elo: number; wins: number; losses: number };

/** What happened to one event. `reason` names the outcome or the refusal; the other fields depend on it. */
export type GameResult = {
  ok: boolean;
  reason?: string;
  status?: string;
  userId?: string;
  duelId?: string;
  retryAt?: number;
  winnerId?: string;
  loserId?: string;
  swings?: Swing[];
  winnerHp?: number | undefined;
  flawless?: boolean;
  decision?: string;
  ability?: string;
  amount?: number;
  profile?: Player;
  config?: Config;
  configVersion?: number;
  round?: number;
  dirtyProfileIds?: string[];
  deletedProfileIds?: string[];
  rankResetIds?: string[];
  resetAllRanks?: boolean;
  rankSet?: RankSet;
};

/** reduceGame's return: the next state, the result, and what the room must persist or broadcast. */
export type ReduceOutput = {
  state: GameState;
  result: GameResult;
  /** State must be persisted. */
  changed: boolean;
  /** Overlays should receive a new snapshot. */
  visible: boolean;
  dirtyProfileIds: string[];
  deletedProfileIds: string[];
  rankResetIds: string[];
  resetAllRanks: boolean;
};

/** What the overlay socket sends (docs/CONTRACTS.md §3). */
export type Snapshot = {
  type: "snapshot";
  channel: string;
  revision: number;
  /** Chat not connected, or config.enabled false. */
  paused: boolean;
  chat: { connected: boolean; lastSeen: number; status: string; bot: boolean };
  config: Config;
  configVersion: number;
  round: number;
  players: Player[];
  duels: Duel[];
  /** The last 50, oldest first. */
  events: GameLogEvent[];
  /** Server clock when sent. */
  serverNow: number;
};

/** Whether Twitch posted a line, and its drop_reason code (or the error) when it didn't. */
export type SendResult = { sent: boolean; reason: string };

// A room's export as backups.ts stores it. Only the fields developer.ts reads are named; exportedAt is an ISO time.
export type BackupExport = {
  exportedAt: string;
  profiles: { userId: string; username: string }[];
  purchases: { userId: string }[];
  builds: { userId: string }[];
  [key: string]: unknown;
};
