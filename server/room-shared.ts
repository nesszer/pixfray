import { cleanStats, emptyStats, knownHat } from "./upgrades.ts";
import { petOf } from "./pets.ts";
import { cleanCosmetics } from "./cosmetics.ts";
import { SE_SUBSCRIPTION_ID } from "./streamelements.ts";
import type {
  ChatEvent,
  Config,
  Cosmetics,
  Duel,
  GameEvent,
  GameState,
  Player,
  ReduceOutput,
  Snapshot,
} from "./model.ts";
import type { ChannelRoom } from "./channel.ts";

/** A JSON object request body, as readJson parses it; routes check each field they read. */
export type JsonObject = { [field: string]: unknown };
/** A profiles row: the table the constructor makes, with every column its migrations add. */
export type ProfileTable = {
  user_id: string;
  username: string;
  display_name: string;
  avatar: string;
  color: string;
  default_ability: string;
  elo: number;
  wins: number;
  losses: number;
  last_seen: number;
  power: number;
  guard: number;
  luck: number;
  crit: number;
  dodge: number;
  counter: number;
  vitality: number;
  hat: string;
  last_opponent: string;
  bonus_points: number;
  checkins: number;
  streak: number;
  last_stream_seq: number;
  free_miss_at: number;
  last_stream: string;
  dollars: number;
  style_dollars: number;
  given_in_stream: number;
  give_stream: string;
  pet: string;
  recolor: string;
  pet_color: string;
  accessory: string;
  trail: string;
  win_effect: string;
  taunt: string;
  title: string;
  build: number;
  account_created_at: number;
  account_checked_at: number;
};
/** What a SELECT of PROFILE_COLUMNS returns; getProfile also reads last_opponent. */
export type ProfileRow = Omit<
  ProfileTable,
  | "last_opponent"
  | "last_stream_seq"
  | "free_miss_at"
  | "last_stream"
  | "given_in_stream"
  | "give_stream"
  | "account_created_at"
  | "account_checked_at"
> & { pet_custom: string | null; pet_roll: string | null; last_opponent?: string };
/** A saved fighter as normalizeProfileRow builds it: the player plus the columns only the profile keeps. */
export type Profile = Player & {
  checkins: number;
  streak: number;
  dollars: number;
  styleDollars: number;
  build: number;
};
/** The bot_status row (the constructor's DDL). */
export type BotStatusRow = {
  id: number;
  heard_at: number;
  heard: string;
  sent_at: number;
  sent_total: number;
  failed_at: number;
  failed_total: number;
  failed_reason: string;
  held_at: number;
  held_reason: string;
};
/**
 * A chat message as /eventsub, /chat and /dev-chat hand it to the room (server/eventsub.ts): the EventSub envelope
 * fields the room reads, each unchecked until it is read.
 */
export type BotMessage = {
  messageId?: unknown;
  messageType?: unknown;
  subscription?: { id?: unknown; status?: unknown; [field: string]: unknown } | undefined;
  event?: Partial<ChatEvent> | undefined;
  botId?: unknown;
  bot?: unknown;
  timestamp?: unknown;
  quick?: unknown;
  botPlays?: boolean; // set only by runCommand for the BOT_DEBUG bot account
  [field: string]: unknown;
};
/** What the overlay sockets get: the state, or the saved looks that changed. */
export type LiveMessage =
  | (Snapshot & { build: string })
  | { type: "looks"; looks: { [login: string]: Look | null }; reset?: boolean };
/** What an overlay draws for a saved fighter (savedLook). */
export type Look = ReturnType<typeof savedLook>;
/** What a chat message did to the game (processChatMessage, advance). */
export type ChatOutcome = Pick<ReduceOutput, "state" | "result" | "changed" | "visible">;
/** A caught value: anything can be thrown, and an Error's message reads best. */
export type Thrown = { message?: unknown } | null | undefined;
/** A duel whose result chat may now hear (dueResults): completed, rated and revealed. */
export type DueDuel = Duel & { ratings: NonNullable<Duel["ratings"]>; revealAt: number };
/** readJson's answer. Each side names the other's fields as optional, for the loose worker program. */
export type ReadJson =
  | { ok: false; error: string; value?: undefined }
  | { ok: true; value: JsonObject; error?: undefined };
/** An event advance takes: any reducer event; the admin fields it logs are absent on the others. */
export type RoomEvent = GameEvent & { actorId?: unknown; actorName?: unknown; note?: unknown };
/** The fields upsertProfile writes: a state player, a saved profile or saveProfile's loadout. */
export type ProfileWrite = Pick<
  Player,
  | "userId"
  | "username"
  | "displayName"
  | "avatar"
  | "color"
  | "defaultAbility"
  | "elo"
  | "wins"
  | "losses"
  | "lastSeen"
  | "stats"
  | "hat"
> &
  Partial<Cosmetics> & { pet?: string; lastOpponentId?: string | undefined };
/** A profile saveProfile answers with: the saved loadout plus the columns only the profiles table keeps. */
export type SavedProfile = ProfileWrite & {
  bonus: number;
  checkins: number;
  streak: number;
  dollars: number;
  styleDollars: number;
  build: number;
};
export const INTERNAL_HEADER = "X-Mini-Internal";
export const CHANNEL_HEADER = "X-Mini-Channel";
export const MAX_PROFILE_ID_LENGTH = 64;
export const MAX_LIVE_SOCKETS = 200;
export const MAX_SOCKETS_PER_CLIENT = 16; // one network can't fill the room and lock OBS out
export const BOT_REPLIES_PER_30S = 18; // the bot's chat replies per channel; Twitch allows 20 per 30 s unless it is a mod
export const RESULT_WINDOW_MS = 120000; // a result line not sent within 2 minutes of its reveal is given up
export const RESULT_RETRY_MS = 5000; // how often the alarm retries a due result line that couldn't go out
export const MAX_EVENTSUB_IDS = 5_000;
export const CHAT_CHECK_MS = 60 * 60_000; // the alarm re-checks the Helix subscription at most hourly
export const CHAT_PENDING_CHECK_MS = 3 * 60_000; // a subscription still awaiting webhook verification is re-checked sooner
export const MAX_DOLLARS = 1_000_000; // a wallet never holds more
// Every query that builds a profile with normalizeProfileRow reads these columns.
export const PROFILE_COLUMNS =
  "user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen, power, guard, luck, crit, dodge, counter, vitality, hat, bonus_points, checkins, streak, dollars, style_dollars, pet, recolor, pet_color, accessory, trail, win_effect, taunt, title, build, (SELECT tier || ':' || stat || ':' || stat2 FROM custom_pets WHERE custom_pets.id = profiles.pet) AS pet_custom, (SELECT roll FROM owned_items o WHERE o.user_id = profiles.user_id AND o.kind = 'pet' AND o.item_id = profiles.pet) AS pet_roll";

export function json(data: unknown, status = 200, headers: { [name: string]: string } = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function text(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export function normalizeChannel(value: unknown): string {
  const channel = String(value || "")
    .trim()
    .toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(channel) ? channel : "";
}

export function validUserId(value: unknown): string {
  const id = String(value ?? "").trim();
  return id.length > 0 && id.length <= MAX_PROFILE_ID_LENGTH && /^[a-zA-Z0-9_:-]+$/.test(id) ? id : "";
}

export function normalizeUsername(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase()
    .slice(0, 25);
}

// Stage 4 cosmetics: profile field -> profiles column (server/cosmetics.ts).
export const COSMETIC_COLUMNS: { [field in keyof Cosmetics]: keyof ProfileTable } = {
  recolor: "recolor",
  petColor: "pet_color",
  accessory: "accessory",
  trail: "trail",
  winEffect: "win_effect",
  taunt: "taunt",
  title: "title",
};

// Leaderboard order, as in the SQL: Elo, then wins, then name.
export function boardOrder(
  a: { username: string; elo: number; wins: number },
  b: { username: string; elo: number; wins: number },
): number {
  const x = a.username.toLowerCase(),
    y = b.username.toLowerCase();
  return b.elo - a.elo || b.wins - a.wins || (x < y ? -1 : x > y ? 1 : 0);
}

// What an overlay draws for a viewer with a saved fighter: /looks and the "looks" push send the same fields.
export function savedLook(p: Player) {
  return {
    avatar: p.avatar,
    color: p.color,
    hat: p.hat || "",
    pet: p.pet || "",
    petTier: p.petTier || "",
    ...cleanCosmetics(p),
    displayName: p.displayName,
    elo: p.elo,
  };
}

export function normalizeProfileRow(row: ProfileRow, config: Config): Profile;
export function normalizeProfileRow(row: ProfileRow | null | undefined, config: Config): Profile | null;
export function normalizeProfileRow(row: ProfileRow | null | undefined, config: Config): Profile | null {
  if (!row) return null;
  return {
    userId: String(row.user_id),
    username: String(row.username || ""),
    displayName: String(row.display_name || row.username || ""),
    avatar: String(row.avatar || "player"),
    color: String(row.color || "#A78BFA"),
    defaultAbility: String(row.default_ability || "strike"),
    hp: config.maxHp,
    elo: Number.isInteger(row.elo) ? row.elo : config.initialElo,
    wins: Number.isInteger(row.wins) ? row.wins : 0,
    losses: Number.isInteger(row.losses) ? row.losses : 0,
    lastSeen: Number.isInteger(row.last_seen) ? row.last_seen : 0,
    registered: true,
    respawnAt: 0,
    stats: cleanStats(row),
    hat: knownHat(row.hat) ? row.hat : "",
    bonus: Number.isInteger(row.bonus_points) ? row.bonus_points : 0, // check-in points (checkin below)
    checkins: Number.isInteger(row.checkins) ? row.checkins : 0,
    streak: Number.isInteger(row.streak) ? row.streak : 0,
    dollars: Number.isInteger(row.dollars) ? row.dollars : 0, // PixFray dollars (payDuels, give, giftDollars)
    styleDollars: Number.isInteger(row.style_dollars) ? row.style_dollars : 0, // channel point rewards (server/points.ts)
    ...petFieldsOf(row),
    ...cleanCosmetics(
      // each COSMETIC_COLUMNS column is in PROFILE_COLUMNS
      Object.fromEntries(
        Object.entries(COSMETIC_COLUMNS).map(([field, column]) => [field, row[column as keyof ProfileRow]]),
      ),
    ),
    build: Number.isInteger(row.build) ? row.build : 0, // the active build slot (builds table)
    ...(row.last_opponent ? { lastOpponentId: String(row.last_opponent) } : {}), // only getProfile reads it
  };
}

// The active pet (server/pets.ts): its id, tier and boost (a legendary's from the owner's roll); none when it's gone
// (a deleted upload).
export function petFieldsOf(row: { pet: string; pet_custom: string | null; pet_roll: string | null }) {
  const pet = petOf(row.pet, row.pet_custom, row.pet_roll);
  return { pet: pet ? pet.id : "", petTier: pet ? pet.tier : "", petBoost: pet ? pet.boost : emptyStats() };
}

// T is the object the caller stored; F is what a missing, broken or non-object value reads as.
export function safeJsonParse<T extends object, F = T>(value: string | null | undefined, fallback: F): T | F {
  try {
    const parsed: unknown = JSON.parse(value as string); // null and undefined parse or throw into the fallback
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback; // the caller names what it stored
  } catch {
    return fallback;
  }
}

export function randomHex(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (x) => x.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

// Next Helix check time, or null: hourly while connected, every few minutes while a subscription awaits verification.
export function chatCheckDue(state: GameState): number | null {
  const id = state.chat?.subscriptionId;
  if (!id || id.startsWith("local-") || id === SE_SUBSCRIPTION_ID) return null;
  return (Number(state.chat.checkedAt) || 0) + (state.chat.connected ? CHAT_CHECK_MS : CHAT_PENDING_CHECK_MS);
}

export function getProfile(room: ChannelRoom, userId: string, config: Config): Profile | null {
  const row = room.ctx.storage.sql
    .exec<ProfileRow>(`SELECT ${PROFILE_COLUMNS}, last_opponent FROM profiles WHERE user_id = ?`, userId)
    .toArray()[0];
  return normalizeProfileRow(row, config);
}

export function getProfileByUsername(room: ChannelRoom, username: unknown, config: Config): Profile | null {
  const name = normalizeUsername(username);
  if (!name) return null;
  const row = room.ctx.storage.sql
    .exec<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE username = ? COLLATE NOCASE`, name)
    .toArray()[0];
  return normalizeProfileRow(row, config);
}

export function upsertProfile(room: ChannelRoom, profile: ProfileWrite): void {
  // Twitch logins can be renamed and later reused; free the login if a stale row still holds it.
  room.ctx.storage.sql.exec(
    "UPDATE profiles SET username = '~' || user_id WHERE username = ? COLLATE NOCASE AND user_id <> ?",
    profile.username,
    profile.userId,
  );
  room.ctx.storage.sql.exec(
    "INSERT INTO profiles (user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen, power, guard, luck, crit, dodge, counter, vitality, hat, last_opponent, pet) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, '')) " +
      "ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name, avatar = excluded.avatar, color = excluded.color, default_ability = excluded.default_ability, elo = excluded.elo, wins = excluded.wins, losses = excluded.losses, last_seen = excluded.last_seen, " +
      "power = excluded.power, guard = excluded.guard, luck = excluded.luck, crit = excluded.crit, dodge = excluded.dodge, counter = excluded.counter, vitality = excluded.vitality, hat = excluded.hat, " +
      // A game state player from before pets has no pet field; keep the stored one then.
      "pet = CASE WHEN ? IS NULL THEN profiles.pet ELSE excluded.pet END, " +
      // A website save carries no opponent; keep the stored one.
      "last_opponent = CASE WHEN excluded.last_opponent <> '' THEN excluded.last_opponent ELSE profiles.last_opponent END",
    profile.userId,
    profile.username,
    profile.displayName,
    profile.avatar,
    profile.color,
    profile.defaultAbility,
    profile.elo,
    profile.wins,
    profile.losses,
    Number.isInteger(profile.lastSeen) ? profile.lastSeen : 0,
    ...(({ power, guard, luck, crit, dodge, counter, vitality }) => [
      power,
      guard,
      luck,
      crit,
      dodge,
      counter,
      vitality,
    ])(cleanStats(profile.stats)),
    knownHat(profile.hat) ? profile.hat : "",
    String(profile.lastOpponentId || "").slice(0, 32),
    typeof profile.pet === "string" ? profile.pet : null,
    typeof profile.pet === "string" ? profile.pet : null,
  );
  // A game state player from before cosmetics has none of the fields; keep the stored ones then.
  if (typeof profile.recolor === "string") {
    const worn = cleanCosmetics(profile);
    room.ctx.storage.sql.exec(
      `UPDATE profiles SET ${Object.values(COSMETIC_COLUMNS)
        .map((c) => c + " = ?")
        .join(", ")} WHERE user_id = ?`,
      ...Object.keys(COSMETIC_COLUMNS).map((f) => worn[f as keyof Cosmetics]), // COSMETIC_COLUMNS's keys
      profile.userId,
    );
  }
  room.lookChanged(profile.userId);
}
