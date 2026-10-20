// What the pages receive from api(), checked once where it arrives: the session and access every page reads, the
// fighter page's profile, shop, leaderboard and channel config, the mod page's /api/admin, leaderboard and live
// snapshots, the owner page's lists, and the fighter page's sessionStorage draft. Built on src/served/parse.ts (the
// overlay's half) and in the same style as server/parse.ts: each parser answers { ok: true, value } or
// { ok: false, error }, checks only the fields the page reads with the types it reads them as, and passes the input
// object through narrowed, so other fields stay. One bad entry in a list (a duel, a player, a log row) drops only that
// entry. parseAnswer turns an ok answer whose body fails into a failed one with an error the page shows, and warns
// once per kind (warnOnce), so a page never renders a half-read body.
//
// A few nested panels of /api/admin (history, StreamElements, the bot's status and commands, custom upload usage, the
// check-in test) and the owner page's Cloudflare versions are checked one level deep: an object or list where the
// page expects one. Their fields come from server code that builds them field by field.
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

type Check = (v: unknown) => boolean;
const num: Check = (v) => typeof v === "number" && Number.isFinite(v);
const str: Check = (v) => typeof v === "string";
const bool: Check = (v) => typeof v === "boolean";
const opt =
  (check: Check): Check =>
  (v) =>
    v === undefined || check(v);
const orNull =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);
const listOf =
  (check: Check): Check =>
  (v) =>
    Array.isArray(v) && v.every(check);
const mapOf =
  (check: Check): Check =>
  (v) =>
    isObject(v) && Object.values(v).every(check);
const strList = listOf(str);
const numMap = mapOf(num);

/** Each field the page reads and the check its value must pass. */
type Spec = { readonly [field: string]: Check };
/** Why `value` doesn't fit `spec` ("not an object", or the first field that fails), or "" when it fits. */
function misfit(value: unknown, spec: Spec, what: string) {
  if (!isObject(value)) return what + " is not an object";
  for (const field in spec) if (!spec[field]!(value[field])) return what + "." + field + " has the wrong type"; // !: field is a key of spec
  return "";
}
/** A parser for one shape: the value itself when it fits `spec`, the reason when it doesn't. */
function shape<T>(spec: Spec, what: string) {
  return (value: unknown): Parsed<T> => {
    const why = misfit(value, spec, what);
    // as T: misfit checked every field of T this page reads; the rest pass through as sent
    return why ? bad(why) : ok(value as T);
  };
}
const fits =
  (spec: Spec): Check =>
  (v) =>
    misfit(v, spec, "") === "";

// ---------- session and access (every page) ----------

/** /api/session: who is signed in. */
export type Session = {
  user?: { id: string; login: string; displayName?: string } | null;
  configured?: boolean;
  owner?: boolean;
};
const USER: Spec = { id: str, login: str, displayName: opt(str) };
export const parseSession = shape<Session>(
  { user: opt(orNull(fits(USER))), configured: opt(bool), owner: opt(bool) },
  "session",
);

/** /api/access/:channel: whether the viewer may run this channel's duels, and why not. */
export type Access = { canManage?: boolean; owner?: boolean; broadcaster?: boolean; reason?: string; off?: string };
export const parseAccess = shape<Access>(
  { canManage: opt(bool), owner: opt(bool), broadcaster: opt(bool), reason: opt(str), off: opt(str) },
  "access",
);

// ---------- the fighter page (src/dashboard.ts) ----------

/**
 * A saved build or profile, from the API or a stored draft. The page's loadoutOf reads hat, pet, stats and the look
 * fields through str() and effectiveStats(), so they stay unknown; avatar, color and defaultAbility are strings when
 * set.
 */
export type Build = { avatar?: string; color?: string; defaultAbility?: string; [field: string]: unknown };
const BUILD: Spec = { avatar: opt(str), color: opt(str), defaultAbility: opt(str) };
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
const isOwned: Check = (v) =>
  isObject(v) &&
  Object.entries(v).every(([kind, list]) =>
    kind === "slots"
      ? num(list)
      : kind === "rolls"
        ? isObject(list) && Object.values(list).every(strList)
        : strList(list),
  );
export type Profile = Build & {
  wins: number;
  losses: number;
  bonus?: number;
  elo: number;
  // absent on a fighter who never earned any (server/game.ts shownProfile)
  dollars?: number;
  streak?: number;
  build?: number;
  builds?: (Build | null)[];
  owned?: Partial<Owned>;
};
const PROFILE: Spec = {
  ...BUILD,
  wins: num,
  losses: num,
  elo: num,
  dollars: opt(num),
  bonus: opt(num),
  streak: opt(num),
  build: opt(num),
  builds: opt(Array.isArray),
  owned: opt(isOwned),
};
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
/** POST /api/shop/:channel: the dollars left and what the fighter owns now. */
export type Bought = { dollars: number; owned?: Partial<Owned> };
export const parseBought = shape<Bought>({ dollars: num, owned: opt(isOwned) }, "purchase");

/** A shop pet: its id, words, price (null when not for sale), tier, stat boost and, for an upload, its picture. */
export type ShopPet = {
  id: string;
  label: string;
  price?: number | null;
  tier: string;
  boost?: Partial<Stats>;
  url?: string;
};
const SHOP_PET: Spec = { id: str, label: str, tier: str, price: opt(orNull(num)), boost: opt(numMap), url: opt(str) };
/** A cosmetic for sale; price null when it isn't. */
export type ShopItem = { id: string; label: string; price?: number | null };
const SHOP_ITEM: Spec = { id: str, label: str, price: opt(orNull(num)) };
/** GET /api/shop/:channel, or GET /api/pets/:channel (pets only) when the shop list isn't there. */
export type Shop = {
  pets: ShopPet[];
  items?: Partial<Record<CosmeticKind, ShopItem[]>>;
  hatPricePerWin?: number;
  slots?: { prices?: (number | null)[]; max?: number };
};
const SLOTS: Spec = { prices: opt(listOf(orNull(num))), max: opt(num) };
export const parseShop = shape<Shop>(
  {
    pets: listOf(fits(SHOP_PET)),
    items: opt(mapOf(listOf(fits(SHOP_ITEM)))),
    hatPricePerWin: opt(num),
    slots: opt(fits(SLOTS)),
  },
  "shop",
);

/** The channel config the fighter page reads from /api/state/:channel (server/model.ts Config). */
export type StateConfig = {
  initialElo: number;
  challengeTimeoutMs: number;
  rematchDelayMs: number;
  checkinPoints?: number;
  maxStatLevel?: number;
  winDollars?: number;
  lossDollars?: number;
  giveEnabled?: boolean;
  giveMaxPerStream?: number;
  giveMinDuels?: number;
  quickDuel?: boolean;
};
const STATE_CONFIG: Spec = {
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
};
/** /api/state/:channel, as far as the fighter page reads it: the config. */
export function parseStateConfig(value: unknown): Parsed<StateConfig> {
  if (!isObject(value)) return bad("state is not an object");
  return shape<StateConfig>(STATE_CONFIG, "state.config")(value.config);
}

/** A leaderboard row (GET /api/leaderboard/:channel); dollars only on the mods' ?private=1 list. */
export type LeaderRow = {
  userId: string;
  username: string;
  displayName?: string;
  color: string;
  avatar: string;
  elo: number;
  wins: number;
  losses: number;
  dollars?: number;
};
const parseLeaderRow = shape<LeaderRow>(
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
/** The leaderboard: a list of rows; a row that doesn't read is dropped. */
export function parseLeaderboard(value: unknown): Parsed<LeaderRow[]> {
  if (!Array.isArray(value)) return bad("leaderboard is not a list");
  return ok(keepGood(value, "a leaderboard row", parseLeaderRow));
}

/** The fighter page's unsaved edits, kept in sessionStorage over the Twitch sign-in round trip. */
export type Draft = { d: Build; withProfile?: boolean; at: number };
const parseDraftValue = shape<Draft>({ d: isBuild, withProfile: opt(bool), at: num }, "draft");
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

export type AdminConfig = {
  enabled?: boolean;
  maxDuels: number;
  maxHp: number;
  inactivityMs: number;
  announce?: string;
  maxOnStream?: number;
  botEnabled?: boolean;
  quickDuel?: boolean;
  abilities?: Record<string, Record<string, number>>;
};
const ADMIN_CONFIG: Spec = {
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
export type ChatStatus = {
  connected?: boolean;
  source?: string;
  status?: string;
  subscriptionId?: string;
  lastNotificationAt?: number;
  lastSeen?: number;
  lastRevocationReason?: string;
};
const CHAT_STATUS: Spec = {
  connected: opt(bool),
  source: opt(str),
  status: opt(str),
  subscriptionId: opt(str),
  lastNotificationAt: opt(num),
  lastSeen: opt(num),
  lastRevocationReason: opt(str),
};
/** A duel as the mod page reads it; a pending duel has no startedAt yet. */
export type AdminDuel = {
  id: string;
  a: string;
  b: string;
  status: string;
  rules?: { maxHp?: number };
  maxHp?: Record<string, number>;
  expiresAt: number;
  startedAt?: number;
  lastActionAt?: number;
  hp?: Record<string, number>;
  round?: number;
};
const parseAdminDuel = shape<AdminDuel>(
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
export type AdminPlayer = {
  userId: string;
  username: string;
  displayName?: string;
  color: string;
  registered?: boolean;
  respawnAt: number;
  hp: number;
  elo: number;
  wins: number;
  losses: number;
  lastSeen: number;
};
const parseAdminPlayer = shape<AdminPlayer>(
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
/** A saved config version; the actor's name and the note are null when none was given. */
export type HistoryRow = {
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
export type BotCommands = {
  commands: { name: string; reply: string }[];
  counters: { name: string; value: number }[];
};
/** Channel point rewards and the newest redemptions (server/points.ts pointsView). */
export type PointsPanel = {
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
/** GET /api/admin/:channel: the room's state plus the mod page's panels. */
export type Admin = {
  revision: number;
  config: AdminConfig;
  configVersion: number;
  duels: AdminDuel[];
  players: AdminPlayer[];
  history?: HistoryRow[];
  chatStatus?: ChatStatus;
  chat?: ChatStatus;
  chatBot?: { login?: string; debug?: boolean } | null;
  streamelements?: Se | null;
  seOnly?: boolean;
  botStatus?: BotStatus | null;
  customUsage?: { count: number; limit?: number; bytes: number };
  overlays?: number;
  modsReady?: boolean;
  modsLapsed?: boolean;
  checkinTestAllowed?: boolean;
  checkinTest?: { until: number; by?: string } | null;
  botCommands?: BotCommands;
  points?: PointsPanel;
  pointsLogin?: string;
  pointsReady?: boolean;
  channelState?: string;
};
const ADMIN: Spec = {
  revision: num,
  config: fits(ADMIN_CONFIG),
  configVersion: num,
  duels: Array.isArray,
  players: Array.isArray,
  overlays: opt(num),
  chatStatus: opt(fits(CHAT_STATUS)),
  chat: opt(fits(CHAT_STATUS)),
  chatBot: opt(orNull(fits({ login: opt(str), debug: opt(bool) }))),
  seOnly: opt(bool),
  modsReady: opt(bool),
  modsLapsed: opt(bool),
  checkinTestAllowed: opt(bool),
  channelState: opt(str),
  // one level deep (see the top of this file)
  history: opt(listOf(isObject)),
  streamelements: opt(orNull(isObject)),
  botStatus: opt(orNull(isObject)),
  customUsage: opt(isObject),
  checkinTest: opt(orNull(isObject)),
  botCommands: opt(isObject),
  points: opt(isObject),
  pointsLogin: opt(str),
  pointsReady: opt(bool),
};
/** The room's lists, with each duel and player that doesn't read dropped. */
function roomLists<T extends { duels: AdminDuel[]; players: AdminPlayer[] }>(value: T): T {
  const duels = keepGood(value.duels, "a duel", parseAdminDuel),
    players = keepGood(value.players, "a player", parseAdminPlayer);
  return duels.length === value.duels.length && players.length === value.players.length
    ? value
    : { ...value, duels, players };
}
export function parseAdmin(value: unknown): Parsed<Admin> {
  const why = misfit(value, ADMIN, "admin");
  // as Admin: misfit checked each field the page reads (the panels one level deep); roomLists checks each entry
  return why ? bad(why) : ok(roomLists(value as Admin));
}
/** A snapshot on the mod page's /api/live socket, as far as it reads one. */
export type AdminSnapshot = {
  type: "snapshot";
  revision: number;
  paused?: boolean;
  chat?: ChatStatus;
  config: AdminConfig;
  configVersion: number;
  round?: number;
  players: AdminPlayer[];
  duels: AdminDuel[];
  events?: unknown;
};
const ADMIN_SNAPSHOT: Spec = {
  type: (v) => v === "snapshot",
  revision: num,
  paused: opt(bool),
  chat: opt(fits(CHAT_STATUS)),
  config: fits(ADMIN_CONFIG),
  configVersion: num,
  round: opt(num),
  players: Array.isArray,
  duels: Array.isArray,
};
export function parseAdminSnapshot(value: unknown): Parsed<AdminSnapshot> {
  const why = misfit(value, ADMIN_SNAPSHOT, "snapshot");
  // as AdminSnapshot: misfit checked each field above; roomLists checks each entry
  return why ? bad(why) : ok(roomLists(value as AdminSnapshot));
}

// ---------- the owner page (src/dev.ts) ----------

/** A deploy workflow run (GET /api/dev/runs); GitHub sends null for a missing branch or a run still going. */
export type Run = {
  createdAt: string;
  url: string;
  title?: string | null;
  id: number;
  branch?: string | null;
  conclusion?: string | null;
  status: string;
};
const parseRun = shape<Run>(
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
export function parseRuns(value: unknown): Parsed<Run[]> {
  return Array.isArray(value) ? ok(keepGood(value, "a deploy run", parseRun)) : bad("runs is not a list");
}

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
  if (Object.values(value).every(isTargetVersions)) return ok(value as Record<string, TargetVersions>); // as: each value checked just above
  warnOnce("a deploy target", "its deployments or versions are not lists");
  // as: only the entries that passed are kept
  return ok(
    Object.fromEntries(Object.entries(value).filter(([, v]) => isTargetVersions(v))) as Record<string, TargetVersions>,
  );
}

/** A saved config version on the owner page; the actor's name and the note are null when none was given. */
export type ConfigVersion = {
  version: number;
  at: number;
  actorName?: string | null;
  actorId?: string | null;
  note?: string | null;
};
const parseConfigVersion = shape<ConfigVersion>(
  { version: num, at: num, actorName: opt(orNull(str)), actorId: opt(orNull(str)), note: opt(orNull(str)) },
  "config version",
);
/** GET /api/dev/settings: the live config, its version and the saved versions. */
export type Settings = { config: JsonObject | null; configVersion: number; history?: ConfigVersion[] };
export function parseSettings(value: unknown): Parsed<Settings> {
  const why = misfit(value, { config: orNull(isObject), configVersion: num, history: opt(Array.isArray) }, "settings");
  if (why) return bad(why);
  // as Settings: misfit checked config and configVersion; history is checked entry by entry below
  const settings = value as Settings;
  if (!settings.history) return ok(settings);
  const history = keepGood(settings.history, "a config version", parseConfigVersion);
  return ok(history.length === settings.history.length ? settings : { ...settings, history });
}

/** A signed-up channel (server/channels.ts): off when pausedAt is set, waiting for approval when review is. */
export type Channel = {
  login: string;
  pausedAt?: number | null;
  pausedBy?: string;
  review?: { reasons: string[]; at: number };
};
const parseChannel = shape<Channel>(
  {
    login: str,
    pausedAt: opt(orNull(num)),
    pausedBy: opt(str),
    review: opt(fits({ reasons: strList, at: num })),
  },
  "channel",
);
/** GET or POST /api/dev/channels: the cap, the built-in channels and the signed-up ones. */
export type Channels = { max: number; builtin: string[]; channels: Channel[]; progressBatch?: number };
export function parseChannels(value: unknown): Parsed<Channels> {
  const why = misfit(
    value,
    { max: num, builtin: strList, channels: Array.isArray, progressBatch: opt(num) },
    "channels",
  );
  if (why) return bad(why);
  // as Channels: misfit checked each field; the channel list is checked entry by entry below
  const d = value as Channels;
  const channels = keepGood(d.channels, "a channel", parseChannel);
  return ok(channels.length === d.channels.length ? d : { ...d, channels });
}

/** One channel's setup progress (GET /api/dev/progress, server/developer.ts /dev/progress). */
export type Progress = {
  source?: string;
  overlays: number;
  duelModuleOff?: boolean;
  duelCommands?: boolean;
  rejectedAt: number;
  lastCommandAt: number;
  lastChatAt: number;
  commandsWorking: number;
  commands: number;
};
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
/** { progress } by login; a channel whose progress doesn't read is left out, as if its room didn't answer. */
export function parseProgress(value: unknown): Parsed<{ progress: Record<string, Progress> }> {
  if (!isObject(value) || !isObject(value.progress)) return bad("progress is not an object");
  const all = value.progress;
  if (Object.values(all).every(isProgress)) return ok({ progress: all as Record<string, Progress> }); // as: each value checked just above
  warnOnce("a channel's setup progress", "a progress field has the wrong type");
  // as: only the entries that passed are kept
  return ok({
    progress: Object.fromEntries(Object.entries(all).filter(([, p]) => isProgress(p))) as Record<string, Progress>,
  });
}

/** A log row (GET /api/dev/logs). */
export type LogRow = { at: number; source: string; message: string; context?: unknown };
const parseLogRow = shape<LogRow>({ at: num, source: str, message: str }, "log row");
export function parseLogs(value: unknown): Parsed<LogRow[]> {
  return Array.isArray(value) ? ok(keepGood(value, "a log row", parseLogRow)) : bad("logs is not a list");
}

/** One UTC day of a room's counters (GET /api/dev/stats), newest day first. */
export type StatsDay = { day: string; counts: Record<string, number> };
const parseStatsDay = shape<StatsDay>({ day: str, counts: numMap }, "stats day");
export function parseStats(value: unknown): Parsed<StatsDay[]> {
  if (!isObject(value) || !Array.isArray(value.days)) return bad("stats.days is not a list");
  return ok(keepGood(value.days, "a stats day", parseStatsDay));
}
