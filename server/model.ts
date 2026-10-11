// The game's data shapes (types only): the channel config, the state ChannelRoom keeps, the events reduceGame
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
export type Abilities = {
  strike: { damage: number; cooldownMs: number };
  heavy: { damage: number; cooldownMs: number };
  heal: { amount: number; cooldownMs: number };
};

/** A channel's settings (DEFAULT_CONFIG in server/game.ts; ranges in validateConfigPatch, docs/CONTRACTS.md §7). */
export type Config = {
  enabled: boolean;
  quickDuel: boolean;
  /** Overlay duel banner: "off", "top" or "bottom". */
  announce: string;
  maxOnStream: number;
  maxHp: number;
  maxDuels: number;
  challengeTimeoutMs: number;
  inactivityMs: number;
  respawnMs: number;
  rematchDelayMs: number;
  streamDelayMs: number;
  sharedCooldownMs: number;
  initialElo: number;
  eloK: number;
  checkinPoints: number;
  streakBonus: boolean;
  winDollars: number;
  lossDollars: number;
  giveEnabled: boolean;
  giveMaxPerStream: number;
  giveMinDuels: number;
  reminderMin: number;
  botEnabled: boolean;
  petPriceCommon: number;
  petPriceUncommon: number;
  petPriceRare: number;
  petPriceEpic: number;
  petPriceLegendary: number;
  hatPricePerWin: number;
  recolorPrice: number;
  petColorPrice: number;
  accessoryPrice: number;
  trailPrice: number;
  effectPrice: number;
  tauntPrice: number;
  titlePrice: number;
  buildSlotPrice: number;
  buildSlotPriceMore: number;
  abilities: Abilities;
};

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

/**
 * A fighter as a caller hands it to the reducer: a saved profile row, a dashboard save or a stub built from a chat
 * message. Any field may be missing; rows carry extra columns (dollars, build, streak...).
 */
export type ProfileInput = { [K in keyof Player]?: Player[K] | undefined } & {
  dollars?: number | undefined;
  [key: string]: unknown;
};

export type DuelStatus = "pending" | "active" | "completed" | "cancelled" | "expired" | "declined";
export type Cooldowns = { sharedUntil: number; strikeUntil: number; heavyUntil: number; healUntil: number };
/** The config a duel was started with, so a mid-duel config change doesn't touch it. */
export type DuelRules = {
  maxHp: number;
  inactivityMs: number;
  respawnMs: number;
  rematchDelayMs: number;
  sharedCooldownMs: number;
  abilities: Abilities;
};
export type Rating = { before: number; after: number; delta: number; bonus?: number };

/** A challenge or duel (docs/CONTRACTS.md §3 Duel). The fields below `winnerId` are set once it starts or ends. */
export type Duel = {
  id: string;
  a: string;
  b: string;
  status: DuelStatus;
  createdAt: number;
  expiresAt: number;
  /** userId -> hp; both fighters have an entry once the duel starts. */
  hp: Record<string, number>;
  winnerId: string | null;
  startedAt?: number;
  lastActionAt?: number;
  round?: number;
  rules?: DuelRules;
  cooldowns?: Record<string, Cooldowns>;
  /** Played out, but moves no Elo, wins, losses or dollars. */
  unrated?: "new_account" | "pair_cap";
  endedAt?: number;
  cancelReason?: string;
  ratings?: Record<string, Rating>;
  flawless?: boolean;
  /** userId -> dollars the room pays out once (server/channel.js payDuels). */
  payout?: Record<string, number>;
  /** How a quick duel ended when not by knockout: "hp" or "sudden_death". */
  decision?: string;
  /** Until this time chat keeps the result hidden (hiddenResults). */
  revealAt?: number;
};

/** One entry of the event log the overlay plays (docs/CONTRACTS.md §3, event types table). */
export type GameLogEvent = { id: string; type: string; at: number; [field: string]: unknown };

/** The chat source (one Twitch EventSub subscription, or StreamElements). */
export type ChatState = {
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

/** What ChannelRoom stores for a channel (createInitialState, normalizeState in server/game.ts). */
export type GameState = {
  channel: string;
  revision: number;
  chat: ChatState;
  config: Config;
  configVersion: number;
  round: number;
  players: Player[];
  duels: Duel[];
  rematchLocks: { pair: string; until: number }[];
  pairPlays: { pair: string; at: number }[];
  events: GameLogEvent[];
  appliedMessageIds: string[];
  nextDuelId: number;
  /** 2 once the 2026-10-06 price cut has been applied. */
  priceSchema?: number;
  /** Removed with the relay; normalizeState deletes it from old stored states. */
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
};

/** A chat command as the room hands it to the reducer (server/channel.js processChatMessage). */
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
  lucky?: true;
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
