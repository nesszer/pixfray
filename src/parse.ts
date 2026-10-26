// What the pages receive from api() (and the fighter page's sessionStorage draft), checked once where it arrives.
// Each parser checks only the fields the page reads and passes the object through narrowed; one bad list entry drops
// only that entry. parseAnswer turns an ok answer whose body fails into a failed one, so a page never renders a
// half-read body. A few /api/admin panels and the Cloudflare versions are checked one level deep: their fields come
// from server code that builds them field by field.
import type { CosmeticKind } from "../server/cosmetics.ts";
import type { Stats } from "../server/upgrades.ts";
import { bad, isObject, keepGood, ok, warnOnce } from "./served/parse.ts";
import type { JsonObject, Parsed } from "./served/parse.ts";

// ---------- answers ----------

/** What a page shows when an ok answer's body can't be read. */
export const UNREADABLE = "The server sent an answer this page can't read. Reload the page and try again";

/** api()'s answer: ok with the parsed body, or failed with the body as sent (error bodies are read loosely). */
export type Answer<T> =
  | { ok: true; status: number; data: T }
  // any: an error body as the server sent it; errorText and the per-route codes (off, price) read it loosely
  | { ok: false; status: number; data: any };

/**
 * Parses an ok answer's body. A failed answer keeps its body (the fighter page reads `off` from a 403); an ok answer
 * whose body fails becomes a failed one with { error: UNREADABLE }, after one warning for `kind`.
 */
export function parseAnswer<T>(
  r: { ok: boolean; status: number; data: unknown },
  parse: (value: unknown) => Parsed<T>,
  kind: string,
): Answer<T> {
  if (!r.ok) return { ok: false, status: r.status, data: r.data };
  const parsed = parse(r.data);
  if (parsed.ok) return { ok: true, status: r.status, data: parsed.value };
  warnOnce(kind, parsed.error);
  return { ok: false, status: r.status, data: { error: UNREADABLE } };
}

/** An answer the server accepted (2xx) whose body this page couldn't read, so the write it answers may have gone through. */
export const acceptedUnreadable = (r: Answer<unknown>): boolean => !r.ok && r.status >= 200 && r.status < 300;

// ---------- field checks ----------

/** A check that narrows: the value is a T when it passes. */
type Check<T = unknown> = (v: unknown) => v is T;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";
const bool = (v: unknown): v is boolean => typeof v === "boolean";
// optional marks the field optional in Infer
const opt = <T>(check: Check<T>) =>
  Object.assign((v: unknown): v is T | undefined => v === undefined || check(v), { optional: true as const });
const orNull =
  <T>(check: Check<T>) =>
  (v: unknown): v is T | null =>
    v === null || check(v);
const listOf =
  <T>(check: Check<T>) =>
  (v: unknown): v is T[] =>
    Array.isArray(v) && v.every(check);
const mapOf =
  <T>(check: Check<T>) =>
  (v: unknown): v is Record<string, T> =>
    isObject(v) && Object.values(v).every(check);
const strList = listOf(str);
const numMap = mapOf(num);

/** Each field the page reads and the check its value must pass. */
type Spec = { readonly [field: string]: Check };
type Of<C> = C extends Check<infer T> ? T : never;
type Optional<S> = { [K in keyof S]: S[K] extends { optional: true } ? K : never }[keyof S];
/** The type a spec checks; a field whose check is opt() is optional. */
type Infer<S> = { [K in Exclude<keyof S, Optional<S>>]: Of<S[K]> } & {
  [K in Optional<S>]?: Exclude<Of<S[K]>, undefined>;
};
/** Why `value` doesn't fit `spec` ("not an object", or the first field that fails), or "" when it fits. */
function misfit(value: unknown, spec: Spec, what: string) {
  if (!isObject(value)) return what + " is not an object";
  for (const field in spec) if (!spec[field]!(value[field])) return what + "." + field + " has the wrong type"; // !: field is a key of spec
  return "";
}
const fits =
  <S extends Spec>(spec: S) =>
  (v: unknown): v is Infer<S> =>
    misfit(v, spec, "") === "";
/** List fields to read entry by entry: the warning kind and the parser for one entry. */
type Lists = { readonly [field: string]: readonly [kind: string, parse: (item: unknown) => Parsed<unknown>] };
/**
 * A parser for one shape: the value itself when it fits `spec`, the reason when it doesn't. Each entry of a `lists`
 * field that doesn't parse is dropped (keepGood); the value stays the same object when none is. T is the spec's type
 * unless a caller names a wider one (list fields, pass-through fields).
 */
function shape<S extends Spec, T = Infer<S>>(spec: S, what: string, lists: Lists = {}) {
  return (value: unknown): Parsed<T> => {
    const why = misfit(value, spec, what);
    if (why) return bad(why);
    // as: misfit answers "" only for an object
    let out = value as JsonObject;
    for (const [field, [kind, parse]] of Object.entries(lists)) {
      const list = out[field];
      if (!Array.isArray(list)) continue; // an optional list that isn't there
      const good = keepGood(list, kind, parse);
      if (good.length < list.length) out = { ...out, [field]: good };
    }
    // as T: misfit checked every field of T this page reads and each list entry was parsed; the rest pass through
    return ok(out as T);
  };
}
/** A parser for a list of one shape; an entry that doesn't parse is dropped. */
const rows =
  <S extends Spec>(name: string, kind: string, spec: S, what: string) =>
  (value: unknown): Parsed<Infer<S>[]> =>
    Array.isArray(value) ? ok(keepGood(value, kind, shape(spec, what))) : bad(name + " is not a list");
/** An object's entries that pass `check`; the rest are dropped after one warning for `kind`. */
function goodValues<T>(value: JsonObject, check: Check<T>, kind: string, why: string): Record<string, T> {
  // as: each value is checked here
  if (Object.values(value).every(check)) return value as Record<string, T>;
  warnOnce(kind, why);
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, T] => check(e[1])));
}
/** What a parser answers with when it succeeds. */
type Value<P> = P extends (value: unknown) => Parsed<infer T> ? T : never;

// ---------- session and access (every page) ----------

/** /api/session: who is signed in. */
export const parseSession = shape(
  { user: opt(orNull(fits({ id: str, login: str, displayName: opt(str) }))), configured: opt(bool), owner: opt(bool) },
  "session",
);
export type Session = Value<typeof parseSession>;

/** /api/access/:channel: whether the viewer may run this channel's duels, and why not. */
export const parseAccess = shape(
  { canManage: opt(bool), owner: opt(bool), broadcaster: opt(bool), reason: opt(str), off: opt(str) },
  "access",
);
export type Access = Value<typeof parseAccess>;

// ---------- the fighter page (src/dashboard.ts) ----------

/**
 * A saved build or profile, from the API or a stored draft. The page's loadoutOf reads hat, pet, stats and the look
 * fields through str() and effectiveStats(), so they stay unknown; avatar, color and defaultAbility are strings when
 * set.
 */
export type Build = { avatar?: string; color?: string; defaultAbility?: string; [field: string]: unknown };
const BUILD = { avatar: opt(str), color: opt(str), defaultAbility: opt(str) };
const isBuild = fits(BUILD);
/**
 * What a fighter owns: pets, hats, each cosmetic kind's items and the number of build slots, plus each legendary pet's
 * rolled stats and the legendaries whose free reroll is used.
 */
export type Owned = {
  pets: string[];
  hats: string[];
  slots: number;
  rolls: Record<string, string[]>;
  rerolled: string[];
} & Record<CosmeticKind, string[]>;
// slots a number, rolls an object of stat lists, every other list a list of ids
const isOwned = (v: unknown): v is Partial<Owned> =>
  isObject(v) &&
  Object.entries(v).every(([kind, list]) =>
    kind === "slots" ? num(list) : kind === "rolls" ? mapOf(strList)(list) : strList(list),
  );
const PROFILE = {
  ...BUILD,
  wins: num,
  losses: num,
  elo: num,
  dollars: opt(num), // absent on a fighter who never earned any (server/game.ts shownProfile)
  styleDollars: opt(num), // channel point rewards (server/points.ts): spent on anything but pets
  bonus: opt(num),
  streak: opt(num),
  build: opt(num),
  builds: opt(Array.isArray),
  owned: opt(isOwned),
};
export type Profile = Build & Omit<Infer<typeof PROFILE>, "builds"> & { builds?: (Build | null)[] };
/**
 * A profile (GET /api/profile, or the profile a save answers with). A saved build that doesn't read as one counts as
 * a slot never saved (null), so the other builds keep their slot numbers.
 */
export function parseProfile(value: unknown): Parsed<Profile> {
  const why = misfit(value, PROFILE, "profile");
  if (why) return bad(why);
  // as Profile: misfit checked each field above; builds is checked entry by entry below
  const profile = value as Profile;
  if (!profile.builds || profile.builds.every((b) => b === null || isBuild(b))) return ok(profile);
  warnOnce("a saved build", "a build is not an object, or its look has the wrong type");
  return ok({ ...profile, builds: profile.builds.map((b) => (b === null || isBuild(b) ? b : null)) });
}
/** GET /api/profile/:channel: the viewer's profile, or null before their first save. */
export const parseProfileOrNone = (value: unknown): Parsed<Profile | null> =>
  value === null ? ok(null) : parseProfile(value);
/** POST /api/profile/:channel: { profile } as saved. */
export function parseProfileSaved(value: unknown): Parsed<{ profile: Profile }> {
  if (!isObject(value)) return bad("save answer is not an object");
  const profile = parseProfile(value.profile);
  return profile.ok ? ok({ ...value, profile: profile.value }) : profile;
}
/** POST /api/shop/:channel: the dollars and style dollars left and what the fighter owns now. */
export const parseBought = shape({ dollars: num, styleDollars: opt(num), owned: opt(isOwned) }, "purchase");

/** A shop pet: its id, words, price (null when not for sale), tier, stat boost and, for an upload, its picture. */
const SHOP_PET = { id: str, label: str, tier: str, price: opt(orNull(num)), boost: opt(numMap), url: opt(str) };
export type ShopPet = Omit<Infer<typeof SHOP_PET>, "boost"> & { boost?: Partial<Stats> };
/** A cosmetic for sale; price null when it isn't. */
const SHOP_ITEM = { id: str, label: str, price: opt(orNull(num)) };
export type ShopItem = Infer<typeof SHOP_ITEM>;
/** GET /api/shop/:channel, or GET /api/pets/:channel (pets only) when the shop list isn't there. */
export type Shop = {
  pets: ShopPet[];
  items?: Partial<Record<CosmeticKind, ShopItem[]>>;
  hatPricePerWin?: number;
  slots?: { prices?: (number | null)[]; max?: number };
};
export const parseShop = shape<Spec, Shop>(
  {
    pets: listOf(fits(SHOP_PET)),
    items: opt(mapOf(listOf(fits(SHOP_ITEM)))),
    hatPricePerWin: opt(num),
    slots: opt(fits({ prices: opt(listOf(orNull(num))), max: opt(num) })),
  },
  "shop",
);

/** /api/state/:channel, as far as the fighter page reads it: the config (server/model.ts Config). */
const parseConfig = shape(
  {
    initialElo: num,
    challengeTimeoutMs: num,
    rematchDelayMs: num,
    checkinPoints: opt(num),
    maxStatLevel: opt(num),
    winDollars: opt(num),
    lossDollars: opt(num),
    giveEnabled: opt(bool),
    giveMaxPerStream: opt(num),
    giveMinDuels: opt(num),
    quickDuel: opt(bool),
  },
  "state.config",
);
export type StateConfig = Value<typeof parseConfig>;
export const parseStateConfig = (value: unknown): Parsed<StateConfig> =>
  isObject(value) ? parseConfig(value.config) : bad("state is not an object");

/** The leaderboard (GET /api/leaderboard/:channel); dollars only on the mods' ?private=1 list. */
export const parseLeaderboard = rows(
  "leaderboard",
  "a leaderboard row",
  {
    userId: str,
    username: str,
    displayName: opt(str),
    color: str,
    avatar: str,
    elo: num,
    wins: num,
    losses: num,
    dollars: opt(num),
  },
  "leaderboard row",
);
export type LeaderRow = Value<typeof parseLeaderboard>[number];

/** The fighter page's unsaved edits, kept in sessionStorage over the Twitch sign-in round trip. */
type Draft = { d: Build; withProfile?: boolean; at: number };
const parseDraftValue = shape<Spec, Draft>({ d: isBuild, withProfile: opt(bool), at: num }, "draft");
/** The stored draft text: null when there is none. */
export function parseDraft(text: string | null): Parsed<Draft | null> {
  if (text === null) return ok(null);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return bad("draft is not JSON");
  }
  return parseDraftValue(value);
}

// ---------- the mod page (src/admin.ts) ----------

const ADMIN_CONFIG = {
  enabled: opt(bool),
  maxDuels: num,
  maxHp: num,
  inactivityMs: num,
  announce: opt(str),
  maxOnStream: opt(num),
  botEnabled: opt(bool),
  quickDuel: opt(bool),
  abilities: opt(mapOf(numMap)),
};
export type AdminConfig = Infer<typeof ADMIN_CONFIG>;
const CHAT_STATUS = {
  connected: opt(bool),
  source: opt(str),
  status: opt(str),
  subscriptionId: opt(str),
  lastNotificationAt: opt(num),
  lastSeen: opt(num),
  lastRevocationReason: opt(str),
};
export type ChatStatus = Infer<typeof CHAT_STATUS>;
/** A duel as the mod page reads it; a pending duel has no startedAt yet. */
const parseAdminDuel = shape(
  {
    id: str,
    a: str,
    b: str,
    status: str,
    rules: opt(fits({ maxHp: opt(num) })),
    maxHp: opt(numMap),
    expiresAt: num,
    startedAt: opt(num),
    lastActionAt: opt(num),
    hp: opt(numMap),
    round: opt(num),
  },
  "duel",
);
type AdminDuel = Value<typeof parseAdminDuel>;
const parseAdminPlayer = shape(
  {
    userId: str,
    username: str,
    displayName: opt(str),
    color: str,
    registered: opt(bool),
    respawnAt: num,
    hp: num,
    elo: num,
    wins: num,
    losses: num,
    lastSeen: num,
  },
  "player",
);
export type AdminPlayer = Value<typeof parseAdminPlayer>;
/** A saved config version; the actor's name and the note are null when none was given. */
type HistoryRow = {
  version: number;
  config: AdminConfig;
  actorId: string;
  actorName?: string | null;
  at: number;
  note?: string | null;
};
export type Se = {
  key: string;
  names?: Record<string, string>;
  origin?: string;
  lastCommandAt: number;
  rejectedAt: number;
  seen?: Record<string, number>;
  duelModuleOff?: boolean;
  commands: { action: string; name: string; response: string }[];
  timerText?: string;
};
export type BotStatus = {
  heardAt: number;
  heard: string;
  sentAt: number;
  sent: number;
  failedAt: number;
  failed: number;
  failedText: string;
  heldAt: number;
  heldReason: string;
};
/** Channel point rewards and the newest redemptions (server/points.ts pointsView). */
type PointsPanel = {
  rewards: { rewardId: string; title: string; cost: number; dollars: number; status?: string; createdAt?: number }[];
  redemptions: {
    id: string;
    at: number;
    rewardId: string;
    user: string;
    outcome: string;
    dollars: number;
    marked: number;
  }[];
  limits: { titleMax: number; costMax: number; dollarsMax: number; maxRewards: number };
};
/** The room's lists: a duel or player that doesn't read is dropped. */
const ROOM = { duels: Array.isArray, players: Array.isArray };
type Room = { duels: AdminDuel[]; players: AdminPlayer[] };
const ROOM_LISTS: Lists = { duels: ["a duel", parseAdminDuel], players: ["a player", parseAdminPlayer] };
const ADMIN = {
  ...ROOM,
  revision: num,
  config: fits(ADMIN_CONFIG),
  configVersion: num,
  overlays: opt(num),
  chatStatus: opt(fits(CHAT_STATUS)),
  chat: opt(fits(CHAT_STATUS)),
  chatBot: opt(orNull(fits({ login: opt(str), debug: opt(bool) }))),
  seOnly: opt(bool),
  modsReady: opt(bool),
  modsLapsed: opt(bool),
  checkinTestAllowed: opt(bool),
  channelState: opt(str),
  pointsLogin: opt(str),
  pointsReady: opt(bool),
  // one level deep (see the top of this file)
  history: opt(listOf(isObject)),
  streamelements: opt(orNull(isObject)),
  botStatus: opt(orNull(isObject)),
  customUsage: opt(isObject),
  checkinTest: opt(orNull(isObject)),
  botCommands: opt(isObject),
  points: opt(isObject),
};
/** GET /api/admin/:channel: the room's state plus the mod page's panels. */
export type Admin = Omit<Infer<typeof ADMIN>, keyof OneLevel | keyof Room> & Room & Partial<OneLevel>;
type OneLevel = {
  history: HistoryRow[];
  streamelements: Se | null;
  botStatus: BotStatus | null;
  customUsage: { count: number; limit?: number; bytes: number };
  checkinTest: { until: number; by?: string } | null;
  botCommands: { commands: { name: string; reply: string }[]; counters: { name: string; value: number }[] };
  points: PointsPanel;
};
export const parseAdmin = shape<Spec, Admin>(ADMIN, "admin", ROOM_LISTS);
/** A snapshot on the mod page's /api/live socket, as far as it reads one. */
const ADMIN_SNAPSHOT = {
  ...ROOM,
  type: (v: unknown): v is "snapshot" => v === "snapshot",
  revision: num,
  paused: opt(bool),
  chat: opt(fits(CHAT_STATUS)),
  config: fits(ADMIN_CONFIG),
  configVersion: num,
  round: opt(num),
};
type AdminSnapshot = Omit<Infer<typeof ADMIN_SNAPSHOT>, keyof Room> & Room & { events?: unknown };
export const parseAdminSnapshot = shape<Spec, AdminSnapshot>(ADMIN_SNAPSHOT, "snapshot", ROOM_LISTS);

// ---------- the owner page (src/dev.ts) ----------

/** Deploy workflow runs (GET /api/dev/runs); GitHub sends null for a missing branch or a run still going. */
export const parseRuns = rows(
  "runs",
  "a deploy run",
  {
    createdAt: str,
    url: str,
    title: opt(orNull(str)),
    id: num,
    branch: opt(orNull(str)),
    conclusion: opt(orNull(str)),
    status: str,
  },
  "run",
);

/** One Worker's deployments and versions (GET /api/dev/versions), from the Cloudflare API. */
export type TargetVersions = {
  deployments: { createdOn: string; message?: string; versions: { versionId: string; percentage: number }[] }[];
  versions: { id: string; number?: number; tag?: string; createdOn?: string }[];
  error?: string;
};
// one level deep (see the top of this file): the leaves are Cloudflare's, passed through by server/developer.ts
const isTargetVersions = fits({
  deployments: listOf(fits({ versions: Array.isArray })),
  versions: listOf(isObject),
  error: opt(str),
});
/** Each target's versions; a target that doesn't read is dropped. */
export function parseVersions(value: unknown): Parsed<Record<string, TargetVersions>> {
  if (!isObject(value)) return bad("versions is not an object");
  const why = "its deployments or versions are not lists";
  // as: the leaves pass through unchecked (see above)
  return ok(goodValues(value, isTargetVersions, "a deploy target", why) as Record<string, TargetVersions>);
}

/** A saved config version on the owner page; the actor's name and the note are null when none was given. */
const parseConfigVersion = shape(
  { version: num, at: num, actorName: opt(orNull(str)), actorId: opt(orNull(str)), note: opt(orNull(str)) },
  "config version",
);
/** GET /api/dev/settings: the live config, its version and the saved versions. */
type Settings = { config: JsonObject | null; configVersion: number; history?: Value<typeof parseConfigVersion>[] };
export const parseSettings = shape<Spec, Settings>(
  { config: orNull(isObject), configVersion: num, history: opt(Array.isArray) },
  "settings",
  { history: ["a config version", parseConfigVersion] },
);

/** A signed-up channel (server/channels.ts): off when pausedAt is set, waiting for approval when review is. */
const parseChannel = shape(
  { login: str, pausedAt: opt(orNull(num)), pausedBy: opt(str), review: opt(fits({ reasons: strList, at: num })) },
  "channel",
);
export type Channel = Value<typeof parseChannel>;
/** GET or POST /api/dev/channels: the cap, the built-in channels and the signed-up ones. */
export type Channels = { max: number; builtin: string[]; channels: Channel[]; progressBatch?: number };
export const parseChannels = shape<Spec, Channels>(
  { max: num, builtin: strList, channels: Array.isArray, progressBatch: opt(num) },
  "channels",
  { channels: ["a channel", parseChannel] },
);

/** One channel's setup progress (GET /api/dev/progress, server/developer.ts /dev/progress). */
const isProgress = fits({
  source: opt(str),
  overlays: num,
  duelModuleOff: opt(bool),
  duelCommands: opt(bool),
  rejectedAt: num,
  lastCommandAt: num,
  lastChatAt: num,
  commandsWorking: num,
  commands: num,
});
export type Progress = Of<typeof isProgress>;
/** { progress } by login; a channel whose progress doesn't read is left out, as if its room didn't answer. */
export function parseProgress(value: unknown) {
  if (!isObject(value) || !isObject(value.progress)) return bad("progress is not an object");
  const why = "a progress field has the wrong type";
  return ok({ progress: goodValues(value.progress, isProgress, "a channel's setup progress", why) });
}

/** A log row (GET /api/dev/logs). */
export type LogRow = { at: number; source: string; message: string; context?: unknown };
export const parseLogs: (value: unknown) => Parsed<LogRow[]> = rows(
  "logs",
  "a log row",
  { at: num, source: str, message: str },
  "log row",
);

/** One UTC day of a room's counters (GET /api/dev/stats), newest day first. */
const parseDays = rows("stats.days", "a stats day", { day: str, counts: numMap }, "stats day");
export const parseStats = (value: unknown) => parseDays(isObject(value) ? value.days : undefined);
