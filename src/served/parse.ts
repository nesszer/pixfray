// What the browser receives, checked once where it arrives: the /api/live socket and /api/state (arena-client.ts),
// /api/looks, the overlay's saved chat looks in localStorage and the demo's postMessage (overlay.ts). Pages import
// these helpers too (src/parse.ts adds the page routes). Like server/parse.ts, each parser answers
// { ok: true, value } or { ok: false, error } and checks only the fields the browser reads, with the types it reads
// them as; other fields pass through untouched. A value that passes is the input object itself, narrowed, so extra
// fields (a snapshot's build, a duel's rules) stay and nothing is copied. One bad entry in a list (a player, a duel, an event) drops only
// that entry, so an odd old event kept in the room's last 50 can't freeze the overlay; a bad frame is dropped whole
// and the page keeps its last good state. warnOnce logs each kind of drop once per page load, not once per frame.
//
// This file is served as /parse.js next to the overlay (docs/CONTRACTS.md §8), so it imports nothing at runtime
// from outside src/served/.

/** A JSON object, as JSON.parse returns it. */
export type JsonObject = { [field: string]: unknown };
/** A parser's answer. Each side names the other's field as optional, so either one narrows it. */
export type Parsed<T> = { ok: true; value: T; error?: undefined } | { ok: false; error: string; value?: undefined };

export const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
export const bad = (error: string): { ok: false; error: string; value?: undefined } => ({ ok: false, error });
export const optString = (v: unknown): v is string | undefined => v === undefined || typeof v === "string";
export const optNumber = (v: unknown): v is number | undefined =>
  v === undefined || (typeof v === "number" && Number.isFinite(v));
export const optBoolean = (v: unknown): v is boolean | undefined => v === undefined || typeof v === "boolean";
export const optObject = (v: unknown): v is JsonObject | undefined => v === undefined || isObject(v);
export const isNumberMap = (v: unknown): v is Record<string, number> =>
  isObject(v) && Object.values(v).every((n) => typeof n === "number" && Number.isFinite(n));
/** A list of objects, each one passing the check. */
export const isListOf = <T>(v: unknown, check: (item: unknown) => item is T): v is T[] =>
  Array.isArray(v) && v.every(check);

const warned = new Set<string>();
/** Logs a dropped input once per kind per page load: a broken stream would otherwise log on every frame. */
export function warnOnce(kind: string, error: string) {
  if (warned.has(kind)) return;
  warned.add(kind);
  console.warn("PixFray dropped " + kind + ": " + error);
}
/** Tests only: forget which kinds have warned. */
export function resetWarnings() {
  warned.clear();
}

/** The fields of `value` named in `fields` that fail `check`: the first one, or "" when all pass. */
function badField(value: JsonObject, fields: readonly string[], check: (v: unknown) => boolean) {
  return fields.find((field) => !check(value[field])) ?? "";
}
/**
 * Keeps the entries of a list that pass `parse`, warning once for `kind` when one fails. The list itself is returned
 * when every entry passes.
 */
export function keepGood<T>(list: unknown[], kind: string, parse: (item: unknown) => Parsed<T>): T[] {
  const out: T[] = [];
  let dropped = "";
  for (const item of list) {
    const parsed = parse(item);
    if (parsed.ok) out.push(parsed.value);
    else dropped ||= parsed.error;
  }
  if (dropped) warnOnce(kind, dropped);
  return out;
}

// ---------- the arena (the /api/live socket and /api/state; server/model.ts Snapshot) ----------
// These mirror server/model.ts (Snapshot, Player, Duel, GameLogEvent) with only the fields the overlay reads, plus
// the few its demo writes.

export type Rating = { before?: number; after?: number; delta?: number };
const RATING_FIELDS = ["before", "after", "delta"] as const;
const isRating = (v: unknown): v is Rating => isObject(v) && !badField(v, RATING_FIELDS, optNumber);
const isRatings = (v: unknown): v is Record<string, Rating> | null | undefined =>
  v == null || (isObject(v) && Object.values(v).every(isRating));

/** A fighter in the snapshot, or a saved look from /api/looks or a looks push. */
export type ArenaProfile = {
  userId?: string | undefined;
  username?: string | undefined;
  displayName?: string | undefined;
  registered?: boolean | undefined;
  avatar?: string | undefined;
  color?: string | undefined;
  hat?: string | undefined;
  pet?: string | undefined;
  petTier?: string | undefined;
  defaultAbility?: string | undefined;
  recolor?: string | undefined;
  petColor?: string | undefined;
  accessory?: string | undefined;
  trail?: string | undefined;
  winEffect?: string | undefined;
  taunt?: string | undefined;
  title?: string | undefined;
  elo?: number | undefined;
  lastSeen?: number | undefined;
  respawnAt?: number | undefined;
  // the overlay's lookOf copies the look fields by name
  [field: string]: unknown;
};
const PROFILE_STRINGS = [
  "userId",
  "username",
  "displayName",
  "avatar",
  "color",
  "hat",
  "pet",
  "petTier",
  "defaultAbility",
  "recolor",
  "petColor",
  "accessory",
  "trail",
  "winEffect",
  "taunt",
  "title",
] as const;
const PROFILE_NUMBERS = ["elo", "lastSeen", "respawnAt"] as const;

const isLook = (v: unknown): v is ArenaProfile =>
  isObject(v) &&
  !badField(v, PROFILE_STRINGS, optString) &&
  !badField(v, PROFILE_NUMBERS, optNumber) &&
  optBoolean(v.registered);
/** A saved look (/api/looks, a looks push): the look fields typed as the overlay reads them, when present. */
export function parseLook(value: unknown): Parsed<ArenaProfile> {
  return isLook(value) ? ok(value) : bad(isObject(value) ? "a look field has the wrong type" : "look is not an object");
}
const isPlayer = (v: unknown): v is ArenaProfile & { userId: string } =>
  isLook(v) && typeof v.userId === "string" && v.userId !== "";
/** A snapshot player: a look with a userId. */
export function parseArenaPlayer(value: unknown): Parsed<ArenaProfile & { userId: string }> {
  if (isPlayer(value)) return ok(value);
  if (!isObject(value)) return bad("player is not an object");
  return bad(isLook(value) ? "player.userId is missing" : "a player field has the wrong type");
}

export type ArenaDuel = {
  id: string;
  a: string;
  b: string;
  status: string;
  hp: Record<string, number>;
  /** userId -> full health with vitality; older duels have none and use rules.maxHp. */
  maxHp?: Record<string, number> | undefined;
  rules?: { maxHp?: number | undefined; [field: string]: unknown } | undefined;
  ratings?: Record<string, Rating> | null | undefined;
  /** Rolls replayed so far (replays only). */
  rolls?: number;
  round?: number | undefined;
  winnerId?: string | null | undefined;
  // The demo writes these like the server; not read here.
  flawless?: boolean;
  decision?: string;
};
const isDuel = (v: unknown): v is ArenaDuel =>
  isObject(v) &&
  typeof v.id === "string" &&
  typeof v.a === "string" &&
  typeof v.b === "string" &&
  typeof v.status === "string" &&
  isNumberMap(v.hp) &&
  (v.maxHp === undefined || isNumberMap(v.maxHp)) &&
  (v.rules === undefined || (isObject(v.rules) && optNumber(v.rules.maxHp))) &&
  isRatings(v.ratings) &&
  optNumber(v.round) &&
  (v.winnerId === null || optString(v.winnerId));
export function parseArenaDuel(value: unknown): Parsed<ArenaDuel> {
  return isDuel(value) ? ok(value) : bad(isObject(value) ? "a duel field has the wrong type" : "duel is not an object");
}

/** A game log event (server/model.ts GameLogEvent) with the fields the overlay reads. */
export type ArenaEvent = {
  id?: string | undefined;
  type: string;
  at?: number | undefined;
  duelId?: string | undefined;
  a?: string | undefined;
  b?: string | undefined;
  declinedBy?: string | undefined;
  round?: number | undefined;
  hp?: Record<string, number> | undefined;
  maxHp?: Record<string, number> | undefined;
  userId?: string | undefined;
  targetId?: string | undefined;
  die?: number | undefined;
  counter?: boolean | undefined;
  miss?: boolean | undefined;
  ability?: string | undefined;
  amount?: number | undefined;
  crit?: boolean | undefined;
  luckyCrit?: boolean | undefined;
  dodged?: boolean | undefined;
  finisher?: boolean | undefined;
  winnerId?: string | undefined;
  loserId?: string | undefined;
  respawnAt?: number | undefined;
  unrated?: string | undefined;
  ratings?: Record<string, Rating> | null | undefined;
  decision?: string | undefined;
  flawless?: boolean | undefined;
  reason?: string | undefined;
  /** How often a player_respawned event has waited for a replay (set by the overlay). */
  tries?: number;
};
const EVENT_STRINGS = [
  "id",
  "duelId",
  "a",
  "b",
  "declinedBy",
  "userId",
  "targetId",
  "ability",
  "winnerId",
  "loserId",
  "unrated",
  "decision",
  "reason",
] as const;
const EVENT_NUMBERS = ["at", "round", "die", "amount", "respawnAt"] as const;
const EVENT_BOOLEANS = ["counter", "miss", "crit", "luckyCrit", "dodged", "finisher", "flawless"] as const;
const isEvent = (v: unknown): v is ArenaEvent =>
  isObject(v) &&
  typeof v.type === "string" &&
  v.type !== "" &&
  !badField(v, EVENT_STRINGS, optString) &&
  !badField(v, EVENT_NUMBERS, optNumber) &&
  !badField(v, EVENT_BOOLEANS, optBoolean) &&
  (v.hp === undefined || isNumberMap(v.hp)) &&
  (v.maxHp === undefined || isNumberMap(v.maxHp)) &&
  isRatings(v.ratings);
export function parseArenaEvent(value: unknown): Parsed<ArenaEvent> {
  if (isEvent(value)) return ok(value);
  if (!isObject(value)) return bad("event is not an object");
  return bad(
    typeof value.type === "string" && value.type
      ? "event " + value.type + " has a field of the wrong type"
      : "event.type is missing",
  );
}

export type ArenaChat = { connected?: boolean | undefined; lastSeen?: number | undefined; status?: string | undefined };
export type ArenaConfig = {
  maxHp?: number | undefined;
  announce?: string | undefined;
  maxOnStream?: number | undefined;
};
export type ArenaSnapshot = {
  chat?: ArenaChat | null | undefined;
  config?: ArenaConfig | undefined;
  build?: string | undefined;
  paused?: boolean | undefined;
  revision?: number | undefined;
  serverNow?: number | undefined;
  players?: ArenaProfile[] | undefined;
  duels?: ArenaDuel[] | undefined;
  events?: ArenaEvent[] | undefined;
  // The demo writes this like the server; not read here.
  channel?: string;
};
/** chat as the overlay and the mod page read it; null (or absent) means no chat state yet. */
export const isArenaChat = (v: unknown): v is ArenaChat | null | undefined =>
  v == null || (isObject(v) && optBoolean(v.connected) && optNumber(v.lastSeen) && optString(v.status));
const isConfig = (v: unknown): v is ArenaConfig | undefined =>
  v === undefined || (isObject(v) && optNumber(v.maxHp) && optString(v.announce) && optNumber(v.maxOnStream));
const isSnapshotTop = (
  v: JsonObject,
): v is Omit<ArenaSnapshot, "players" | "duels" | "events"> & {
  players?: unknown[];
  duels?: unknown[];
  events?: unknown[];
} =>
  optNumber(v.revision) &&
  optNumber(v.serverNow) &&
  optBoolean(v.paused) &&
  optString(v.build) &&
  isArenaChat(v.chat) &&
  isConfig(v.config) &&
  (v.players === undefined || Array.isArray(v.players)) &&
  (v.duels === undefined || Array.isArray(v.duels)) &&
  (v.events === undefined || Array.isArray(v.events));
/**
 * A snapshot frame or /api/state answer, already unwrapped from { snapshot } or { state }. The frame fails on a
 * wrong top-level field; a bad player, duel or event is dropped from its list with one warning per kind.
 */
export function parseArenaSnapshot(value: unknown): Parsed<ArenaSnapshot> {
  if (!isObject(value)) return bad("snapshot is not an object");
  if (!isSnapshotTop(value)) return bad("a snapshot field has the wrong type");
  const { players, duels, events, ...top } = value;
  if ((!players || players.every(isPlayer)) && (!duels || duels.every(isDuel)) && (!events || events.every(isEvent))) {
    // every list entry passed the checks just above
    return ok(value as ArenaSnapshot);
  }
  return ok({
    ...top,
    ...(players && { players: keepGood(players, "an arena player", parseArenaPlayer) }),
    ...(duels && { duels: keepGood(duels, "an arena duel", parseArenaDuel) }),
    ...(events && { events: keepGood(events, "an arena event", parseArenaEvent) }),
  });
}

/** A {type:"looks"} push: login -> the saved look, or null when the fighter was deleted. */
export type LooksMessage = { type?: unknown; reset?: boolean | undefined; looks: Record<string, ArenaProfile | null> };
export function parseLooksMessage(value: unknown): Parsed<LooksMessage> {
  if (!isObject(value)) return bad("looks push is not an object");
  const { looks, reset } = value;
  if (!isObject(looks)) return bad("looks push has no looks");
  if (!optBoolean(reset)) return bad("looks push reset is not a boolean");
  const entries = Object.entries(looks);
  const good = entries.filter(([, look]) => look === null || isLook(look));
  // every entry passed the filter, or the filtered map replaces looks: either way each one is null or a look
  if (good.length === entries.length) return ok(value as LooksMessage);
  warnOnce("a pushed look", "a look field has the wrong type");
  // the filter above kept only null or looks that pass isLook
  return ok({ ...value, looks: Object.fromEntries(good) as Record<string, ArenaProfile | null> });
}

// ---------- the overlay's own inputs ----------

/** The chat looks the overlay remembers per channel in localStorage: login -> { avatar, color }. */
export type CosmeticSettings = Record<string, { avatar?: string | undefined; color?: string | undefined }>;
/** The stored JSON text (or null when there is none); entries that aren't { avatar?, color? } strings are dropped. */
export function parseCosmeticSettings(text: string | null): Parsed<CosmeticSettings> {
  let value: unknown;
  try {
    value = JSON.parse(text || "{}");
  } catch {
    return bad("saved chat looks are not JSON");
  }
  if (!isObject(value)) return bad("saved chat looks are not an object");
  // as: Object.create(null) has no prototype, so a login like "__proto__" or "constructor" is a plain key
  const out = Object.create(null) as CosmeticSettings;
  for (const [login, entry] of Object.entries(value))
    if (isObject(entry) && optString(entry.avatar) && optString(entry.color))
      out[login] = { avatar: entry.avatar, color: entry.color };
  return ok(out);
}
/**
 * The site page that embeds the demo overlay posts { demoPaused } while it scrolls the demo out of view. Answers null
 * for a message without a demoPaused field: browser extensions post their own messages to the page.
 */
export function parseDemoMessage(value: unknown): Parsed<{ demoPaused: boolean }> | null {
  if (!isObject(value) || !("demoPaused" in value)) return null;
  if (typeof value.demoPaused !== "boolean") return bad("demo message has no demoPaused switch");
  return ok({ demoPaused: value.demoPaused });
}
