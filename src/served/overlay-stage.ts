// The overlay's link options, its canvas and the roster: who stands on stage, and the duels they are in.
import { parseCap, sanitizeColor } from "./text.ts";
import { parseCosmeticSettings, warnOnce } from "./parse.ts";
import type { ArenaChat, ArenaConfig, ArenaDuel, ArenaProfile, CosmeticField, CosmeticSettings } from "./parse.ts";
import { ids, sprites } from "./overlay-sprites.ts";

const params = new URLSearchParams(location.search);
export const demo = params.get("demo") === "1";
export const arenaEnabled = params.get("arena") === "1";
export const arenaDemo = arenaEnabled && demo;
export const debug = params.get("debug") === "1";
export const size = Math.max(24, Math.min(96, Number(params.get("size")) || 60));
export const sound = params.get("sound") === "1"; // quiet duel sounds, off unless asked for
export const bubblesOn = params.get("bubbles") !== "0"; // bubbles=0 hides chat messages and win taunts
export const fxOn = params.get("fx") !== "off"; // fx=off: no hit glow, sparks or knockout push-in
export const urlCap = parseCap(params.get("cap"));
// includes() is handed the raw values (null or undefined when unset) and lets only these three strings through
export const ANNOUNCE: (string | null | undefined)[] = ["off", "top", "bottom"];
export const status = document.querySelector<HTMLElement>("#status");
export const stage = document.querySelector<HTMLCanvasElement>("#stage")?.getContext("2d") ?? null;
// !: the entry (overlay.ts) stops before anything draws when there is no stage
export const ctx = stage!;

export const OPEN = new Set(["pending", "active"]);
export const KO_HOLD_MS = 2500; // how long the loser stays down after a replayed knockout
export const DUEL_GROW = 1.5; // fighters stand this much bigger while they duel
export const FLOOR = 32; // room under the feet for the nameplate

/** The arena as the snapshots and connections report it; overlay-sync.ts writes it. */
export const arena: {
  chat: ArenaChat | null;
  transport: string;
  /** This overlay's own chat connection. */
  connection: string;
  config: ArenaConfig;
  revision: number | null;
  duels: ArenaDuel[];
  paused: boolean;
  /** Most characters on screen: the lower of ?cap= and the channel setting. */
  cap: number;
  /** The duel banner (off, top or bottom): the channel setting wins; ?announce= covers the demo and the first moment. */
  announce: string | null | undefined;
} = {
  chat: null,
  transport: arenaDemo ? "demo" : "connecting",
  connection: demo ? "demo" : "connecting",
  config: { maxHp: 100 },
  revision: null,
  duels: [],
  paused: false,
  cap: urlCap,
  announce: ANNOUNCE.includes(params.get("announce")) ? params.get("announce") : "off",
};

export type Span = { start: number; until: number };
type Anim = Span & { kind: string; heavy?: boolean };
export type WinFx = { id: string; start: number; seed: number };
/** A character on stage. spawn builds it; applyArenaProfile fills the profile fields right after; the rest start unset. */
export type Player = Record<CosmeticField, string> & {
  key: string;
  userId: string;
  label: string;
  chatLabel: string;
  x: number;
  speed: number;
  direction: number;
  lane: number;
  y: number;
  vy: number;
  avatar: string;
  color: string;
  chatColor: string | null;
  lastJump: number;
  phase: number;
  lastSeen: number;
  anim: Anim | null;
  fromArena?: boolean;
  arenaProfile?: ArenaProfile | null;
  renderAvatar: string;
  defaultAbility: string;
  hat: string;
  pet: string;
  petTier: string;
  // Timers: unset (undefined) until first set, which every comparison reads as not running.
  koUntil: number;
  koHoldUntil: number;
  bigUntil: number;
  holdUntil: number;
  stopStart: number;
  stopUntil?: number;
  bubbleUntil: number;
  koStart?: number;
  turnedAt?: number;
  lastReaction?: number;
  die?: Span & { value: number };
  fx?: Span & { look: string };
  parry?: Span;
  whoosh?: Span;
  shake?: Span & { mag: number };
  floatText?: { text: string; color: string; life: number; until: number };
  winFx?: WinFx | null;
  grow?: number;
  labelWidth?: number;
  text?: string | undefined;
  messageId?: string;
  shortFor?: string;
  /** The bubble text cut to fit, set from `text` before it is read. */
  short: string;
};
export type Meet = { x: number; gap: number; aLeft: boolean; speed?: number; walkMs?: number };

export let width = 1;
export let height = 1;
export function resize() {
  width = Math.max(1, innerWidth);
  height = Math.max(1, innerHeight);
  const ratio = Math.min(devicePixelRatio || 1, 2);
  ctx.canvas.width = Math.round(width * ratio);
  ctx.canvas.height = Math.round(height * ratio);
  ctx.canvas.style.width = width + "px";
  ctx.canvas.style.height = height + "px";
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.imageSmoothingEnabled = false;
  for (const p of players.values()) p.x = Math.max(size / 2, Math.min(width - size / 2, p.x));
}

export let channel = "";
let storageKey = "";
// as: Object.create(null) has no prototype, so a login like "__proto__" is a plain key
export let settings = Object.create(null) as CosmeticSettings;
// Without ?channel= (OBS links always have it) the overlay shows the site's default channel, which /api/channels
// names. The demo makes no API calls.
export async function configure() {
  channel =
    (params.get("channel") || "")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "")
      .slice(0, 25) ||
    (demo
      ? ""
      : await fetch("/api/channels")
          .then((r) => r.json())
          .then((j) => String(j.defaultChannel || ""))
          .catch(() => "")) ||
    "demo";
  storageKey = "mini-chat:cosmetics:" + channel;
  try {
    const saved = parseCosmeticSettings(localStorage.getItem(storageKey));
    if (saved.ok) settings = saved.value;
    else warnOnce("the saved chat looks", saved.error);
  } catch {
    /* OBS may disable local storage. */
  }
}
export function persist() {
  // Bound storage so chat activity cannot grow an unlimited local profile file.
  const keys = Object.keys(settings);
  for (const key of keys.slice(0, Math.max(0, keys.length - 1000))) delete settings[key];
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings));
  } catch {
    /* Storage is optional. */
  }
}

export const players = new Map<string, Player>();
export const profilesById = new Map<string, ArenaProfile>();
export const meetPoints = new Map<string, Meet>();
// A quick duel is over on the server before the overlay sees it, so the overlay replays it from its events:
// duel id -> an active duel whose hp follows the duel_action events until duel_completed.
export const replays = new Map<string, ArenaDuel>();
export const openDuels = () => [
  ...replays.values(),
  ...arena.duels.filter((duel) => OPEN.has(duel?.status) && !replays.has(duel.id)),
];
export const inReplay = (p: Player) =>
  [...replays.values()].some((d) => String(d.a) === p.userId || String(d.b) === p.userId);
// The state already holds the new Elo; during a replay the nameplate shows the Elo from before the duel.
export const replayRatings = (id: string) => {
  for (const d of replays.values()) if (!d.ratings) d.ratings = arena.duels.find((x) => x.id === d.id)?.ratings || null;
  for (const d of replays.values()) if (d.ratings?.[id]) return d.ratings[id];
  return null;
};
export function findPlayer(userId: unknown) {
  if (userId === null || userId === undefined || userId === "") return null;
  for (const p of players.values()) if (p.userId === String(userId)) return p;
  return null;
}
export function duelFor(p: Player) {
  if (!arenaEnabled || !p.userId) return null;
  return openDuels().find((duel) => String(duel.a) === p.userId || String(duel.b) === p.userId) || null;
}
// Over the cap the stage keeps the most recent chatters and never touches a fighter (open duel or replay). A profile
// sent off stage is remembered with its server lastSeen, so the next snapshot doesn't bring it straight back.
export const isFighter = (p: Player) => inReplay(p) || duelFor(p) !== null;
export const droppedAt = new Map<string, number>(); // userId -> the profile's server lastSeen when it left the stage
export function dropPlayer(p: Player) {
  players.delete(p.key);
  if (p.userId) droppedAt.set(p.userId, Number(profilesById.get(p.userId)?.lastSeen) || 0);
  if (droppedAt.size > 2000) droppedAt.delete(droppedAt.keys().next().value!); // over 2000 entries, so a first one exists
}
// A real chat join sends off the least recently active non-fighter; false if everyone on stage is fighting.
function makeRoom() {
  if (players.size < arena.cap) return true;
  let oldest: Player | null = null;
  for (const q of players.values()) if (!isFighter(q) && (!oldest || q.lastSeen < oldest.lastSeen)) oldest = q;
  if (!oldest) return false;
  dropPlayer(oldest);
  return true;
}
export function spawn(key: string, init: Partial<Player>) {
  if (!makeRoom()) return null;
  const saved = settings[key] && typeof settings[key] === "object" ? settings[key] : {};
  // as: applyArenaProfile fills the profile fields right after every spawn; the timers stay undefined until set
  const p = {
    key,
    userId: "",
    label: key,
    chatLabel: key,
    x: size / 2 + Math.random() * Math.max(0, width - size),
    speed: 14 + Math.random() * 20,
    direction: Math.random() < 0.5 ? -1 : 1,
    lane: Math.random() * 28,
    y: 0,
    vy: 0,
    avatar: saved.avatar && sprites.has(saved.avatar) ? saved.avatar : ids[Math.floor(Math.random() * ids.length)],
    color: sanitizeColor(saved.color) || "#a78bfa",
    chatColor: null,
    lastJump: 0,
    phase: Math.random() * 1000,
    lastSeen: Date.now(),
    anim: null,
    ...init,
  } as Player;
  players.set(key, p);
  return p;
}
