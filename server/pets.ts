// Pets: bought with PixFray dollars, one active per fighter, a small stat boost by tier. Built-in ones are drawn in
// src/served/pets.ts (same ids); uploads are custom_pets ("p-..."). A legendary boosts LEGENDARY_ROLL stats rolled per
// owner on purchase (owned_items.roll), with one free reroll. Routes /api/pets: docs/CONTRACTS.md §2.
import { cleanStats, emptyStats, STATS } from "./upgrades.ts";
import { readPng } from "./uploads.ts";
import type { Stat, Stats } from "./upgrades.ts";
import type { Config } from "./model.ts";
import type { Env } from "./env.ts";
import { bodyOr, fromBase64, json, png, postJson, refuse } from "./http.ts";

type BuiltinPet = { id: string; label: string; tier: string; stat: Stat; stat2?: Stat };
/** validatePetUpload's refusal: the HTTP status and the reason the page shows. */
type UploadRefusal = {
  status: number;
  reason:
    | "invalid_label"
    | "invalid_tier"
    | "invalid_stat"
    | "invalid_image"
    | "image_too_large"
    | "not_png"
    | "image_dimensions";
  error: string;
};
type PetUpload = {
  label: string;
  tier: string;
  stat: string;
  stat2: string;
  bytes: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
};
/** A result T or a refusal R: `if (x.reason)` narrows, since T's side types reason "" (falsy). */
export type OrRefusal<T, R extends { status: number; reason: string; error: string }> =
  | (T & { status?: undefined; reason?: ""; error?: undefined })
  | (R & { [K in Exclude<keyof T, keyof R>]?: undefined });
/** A custom_pets row as petCatalog selects it. */
type CustomPetRow = Omit<PetUpload, "bytes"> & { id: string };
/** The Worker's request context for /api/pets (server/worker.ts). */
export type PetsContext = {
  user: { id: string } | null | undefined;
  id: string;
  access(): Promise<{ canManage: boolean; reason?: string }>;
  roomFetch(path: string, init?: RequestInit): Promise<Response>;
  /** Throws (with status 400 or 413) unless the body is a JSON object. */
  bodyJson(request: Request, limit: number): Promise<{ [field: string]: unknown }>;
};

export const TIERS: readonly string[] = ["common", "uncommon", "rare", "epic", "legendary"];
const PRICE_KEYS = {
  common: "petPriceCommon",
  uncommon: "petPriceUncommon",
  rare: "petPriceRare",
  epic: "petPriceEpic",
  legendary: "petPriceLegendary",
} as const; // const: each value a literal, so PetPriceConfig names them
/** The config keys pet and hat prices come from (a missing one means not for sale). */
type PetPriceConfig = Partial<Pick<Config, (typeof PRICE_KEYS)[keyof typeof PRICE_KEYS] | "hatPricePerWin">>;
// Common to epic pets boost power, guard or luck; a legendary's rolled stats can be any of STATS.
const PET_STATS: readonly unknown[] = ["power", "guard", "luck"] satisfies readonly Stat[];
const isPetStat = (stat: unknown): stat is Stat => PET_STATS.includes(stat);
const MAX_BOOST = 2; // per stat, on top of the upgrade points (it may go past the channel's maxStatLevel)
const CUSTOM_PET_ID = /^p-[a-z0-9-]{1,40}$/;
const PET_LIMITS = Object.freeze({ maxPets: 24, maxBytes: 65_536, maxSide: 64, maxLabel: 24 });
const BODY_LIMIT = Math.ceil(PET_LIMITS.maxBytes / 3) * 4 + 4_000;

const LEGENDARY_ROLL = 4;
// Built-in pets: the stat (and second stat for epic) the tier boost goes to. A legendary's stat is unused (rolled).
export const PETS: BuiltinPet[] = [
  { id: "mouse", label: "Mouse", tier: "common", stat: "power" },
  { id: "chick", label: "Chick", tier: "common", stat: "luck" },
  { id: "slime", label: "Slime", tier: "common", stat: "guard" },
  { id: "frog", label: "Frog", tier: "uncommon", stat: "power" },
  { id: "cat", label: "Cat", tier: "uncommon", stat: "luck" },
  { id: "pup", label: "Pup", tier: "uncommon", stat: "guard" },
  { id: "fox", label: "Fox", tier: "rare", stat: "power" },
  { id: "bunny", label: "Bunny", tier: "rare", stat: "luck" },
  { id: "turtle", label: "Turtle", tier: "rare", stat: "guard" },
  { id: "wolf", label: "Wolf", tier: "epic", stat: "power", stat2: "luck" },
  { id: "owl", label: "Owl", tier: "epic", stat: "luck", stat2: "guard" },
  { id: "bear", label: "Bear", tier: "epic", stat: "guard", stat2: "power" },
  { id: "dragon", label: "Dragon", tier: "legendary", stat: "power" },
  { id: "phoenix", label: "Phoenix", tier: "legendary", stat: "luck" },
];
const BUILTIN = new Map(PETS.map((p) => [p.id, p]));

// common/uncommon +1 to one stat, rare +2, epic +2 and +1 to a second, legendary +1 to each rolled stat. Uncommon
// matches common on purpose: boosts stay small so a pet never decides a duel on its own.
export function tierBoost(tier: string, stat: string | undefined, stat2?: string, roll: readonly Stat[] = []): Stats {
  const out = emptyStats();
  if (tier === "legendary") {
    for (const key of roll) out[key] = 1;
    return out;
  }
  if (!isPetStat(stat)) return out;
  out[stat] = tier === "rare" || tier === "epic" ? 2 : TIERS.includes(tier) ? 1 : 0;
  if (tier === "epic" && isPetStat(stat2) && stat2 !== stat) out[stat2] = 1;
  return out;
}

export const cleanBoost = (input?: unknown): Stats => cleanStats(input, MAX_BOOST);

// A legendary roll: LEGENDARY_ROLL different stats in STATS order. A reroll never gives back the same set.
export function rollLegendary(random: () => number = Math.random, not: readonly Stat[] = []): Stat[] {
  for (;;) {
    const pool: Stat[] = [...STATS],
      picked = new Set<Stat>();
    // pool keeps STATS.length - picked.size entries, so the index is always inside it
    while (picked.size < LEGENDARY_ROLL) picked.add(pool.splice(Math.floor(random() * pool.length), 1)[0]!);
    const roll = STATS.filter((s) => picked.has(s));
    if (roll.join() !== not.join()) return roll;
  }
}
// owned_items.roll ("crit,dodge,luck,vitality") -> the stats, or [] when it isn't a whole roll.
export function parseRoll(text: unknown): Stat[] {
  const words = String(text || "").split(",");
  const roll = STATS.filter((s) => words.includes(s));
  return roll.length === LEGENDARY_ROLL && words.length === LEGENDARY_ROLL ? roll : [];
}

// The pet a profile row points at: a built-in id, or a custom one with "tier:stat:stat2" read from custom_pets, with
// the owner's roll for a legendary. null when there's no pet or it no longer exists.
export function petOf(id: string, custom: unknown = "", roll: unknown = "") {
  if (!id) return null;
  const pet = BUILTIN.get(id);
  if (pet) return { id, tier: pet.tier, boost: tierBoost(pet.tier, pet.stat, pet.stat2, parseRoll(roll)) };
  if (!CUSTOM_PET_ID.test(id) || !custom) return null;
  const [tier = "", stat, stat2] = String(custom).split(":");
  return TIERS.includes(tier) ? { id, tier, boost: tierBoost(tier, stat, stat2, parseRoll(roll)) } : null;
}

// "+2 power" / "+2 power, +1 guard" / "+1 power, guard and luck" / "+1 guard, crit, dodge and vitality" (same wording
// as the viewer page). Three or more stats with the same boost share one number.
export function boostText(boost: Stats): string {
  const keys = STATS.filter((k) => boost?.[k] > 0);
  const first = keys[0];
  if (first && keys.length >= 3 && keys.every((k) => boost[k] === boost[first]))
    return `+${boost[first]} ${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}`;
  return keys.map((k) => `+${boost[k]} ${k}`).join(", ");
}

const petPrice = (tier: string, config: PetPriceConfig | null | undefined): number | null =>
  // An unknown tier reads PRICE_KEYS as undefined, and config[undefined] as undefined, so ?? gives null
  config?.[PRICE_KEYS[tier as keyof typeof PRICE_KEYS]] ?? null;
// Hats can be bought before the wins unlock them: wins needed x hatPricePerWin. null = not for sale (0 turns it off).
export const hatPrice = (
  hat: { wins: number } | null | undefined,
  config: Pick<Config, "hatPricePerWin">,
): number | null => (hat && hat.wins > 0 && config?.hatPricePerWin > 0 ? hat.wins * config.hatPricePerWin : null);

// Schema: called from ChannelRoom's constructor (before any profile query, which reads custom_pets).
export function ensurePetSchema(sql: SqlStorage): string[] {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS custom_pets (id TEXT PRIMARY KEY, label TEXT NOT NULL, tier TEXT NOT NULL, stat TEXT NOT NULL, stat2 TEXT NOT NULL DEFAULT '', png BLOB NOT NULL, bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)",
  );
  // What each fighter bought: kind "pet" or "hat". Kept on a rank reset; deleted with the profile.
  sql.exec(
    "CREATE TABLE IF NOT EXISTS owned_items (user_id TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL, price INTEGER NOT NULL, bought_at INTEGER NOT NULL, PRIMARY KEY (user_id, kind, item_id))",
  );
  // A legendary pet's rolled stats and whether its free reroll is used. Legendaries bought before roll here.
  const columns = sql
    .exec<{ name: string }>("PRAGMA table_info(owned_items)")
    .toArray()
    .map((c) => c.name);
  if (!columns.includes("roll")) sql.exec("ALTER TABLE owned_items ADD COLUMN roll TEXT NOT NULL DEFAULT ''");
  if (!columns.includes("rerolled")) sql.exec("ALTER TABLE owned_items ADD COLUMN rerolled INTEGER NOT NULL DEFAULT 0");
  const legendary = PETS.filter((p) => p.tier === "legendary").map((p) => p.id);
  const rolled = sql
    .exec<{ user_id: string; item_id: string }>(
      `SELECT user_id, item_id FROM owned_items WHERE kind = 'pet' AND roll = '' AND (item_id IN (${legendary.map(() => "?").join(", ")}) OR item_id IN (SELECT id FROM custom_pets WHERE tier = 'legendary'))`,
      ...legendary,
    )
    .toArray();
  for (const r of rolled)
    sql.exec(
      "UPDATE owned_items SET roll = ? WHERE user_id = ? AND kind = 'pet' AND item_id = ?",
      rollLegendary().join(","),
      r.user_id,
      r.item_id,
    );
  return rolled.map((r) => r.user_id);
}

// The channel's pet catalog (GET /api/pets/:channel): built-ins first, then uploads in upload order.
export function petCatalog(sql: SqlStorage, channel: string, config: PetPriceConfig | null | undefined) {
  const entry = (p: BuiltinPet | CustomPetRow, custom: boolean) => ({
    id: p.id,
    label: p.label,
    tier: p.tier,
    boost: tierBoost(p.tier, p.stat, p.stat2),
    price: petPrice(p.tier, config),
    custom,
  });
  const custom = sql
    .exec<CustomPetRow>("SELECT id, label, tier, stat, stat2, width, height FROM custom_pets ORDER BY created_at, id")
    .toArray()
    .map((r) => ({ ...entry(r, true), url: `/api/pets/${channel}/${r.id}`, width: r.width, height: r.height }));
  return [...PETS.map((p) => entry(p, false)), ...custom];
}

// Any request body: ?. and String() read missing fields as ""
function validatePetUpload(body: { [field: string]: unknown } | null | undefined): OrRefusal<PetUpload, UploadRefusal> {
  const label = String(body?.label || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!label || label.length > PET_LIMITS.maxLabel)
    return { status: 400, reason: "invalid_label", error: `Name the pet (1-${PET_LIMITS.maxLabel} characters)` };
  const tier = String(body?.tier || "");
  if (!TIERS.includes(tier)) return { status: 400, reason: "invalid_tier", error: "Pick a tier" };
  const stat = tier === "legendary" ? "" : String(body?.stat || "");
  if (tier !== "legendary" && !isPetStat(stat))
    return { status: 400, reason: "invalid_stat", error: "Pick the stat it boosts" };
  const stat2 = tier === "epic" ? String(body?.stat2 || "") : "";
  if (tier === "epic" && (!isPetStat(stat2) || stat2 === stat))
    return { status: 400, reason: "invalid_stat", error: "Epic pets boost two different stats" };
  const b64 = String(body?.image || "").replace(/^data:[^,]*;base64,/, "");
  if (!b64) return { status: 400, reason: "invalid_image", error: "Choose a PNG image" };
  if (b64.length > Math.ceil(PET_LIMITS.maxBytes / 3) * 4)
    return { status: 413, reason: "image_too_large", error: "The image is larger than 64 KB" };
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(b64);
  } catch {
    return { status: 400, reason: "invalid_image", error: "The image is not valid base64" };
  }
  let size: { width: number; height: number };
  try {
    size = readPng(bytes);
  } catch (error) {
    // readPng throws only UploadError (an Error)
    return { status: 415, reason: "not_png", error: (error as Error).message };
  }
  const side = PET_LIMITS.maxSide;
  if (size.width > side || size.height > side)
    return { status: 400, reason: "image_dimensions", error: `Pets are at most ${side}x${side} pixels` };
  return { label, tier, stat, stat2, bytes, width: size.width, height: size.height };
}

// Worker side of /api/pets.
export async function handlePets(request: Request, env: Env, c: PetsContext): Promise<Response> {
  if (request.method === "GET") return c.roomFetch(c.id ? "/pets/" + c.id : "/pets");
  const roles = await c.access();
  if (!roles.canManage) return json({ error: roles.reason || "Moderator role required" }, c.user ? 403 : 401);
  if (request.method === "POST" && !c.id) {
    const body = await bodyOr(c.bodyJson(request, BODY_LIMIT), ["image_too_large", "The image is larger than 64 KB"]);
    if (body instanceof Response) return body;
    const checked = validatePetUpload(body);
    if (checked.reason) return refuse(checked.status, checked.reason, checked.error);
    // canManage (checked above) is only true for a signed-in user
    return c.roomFetch("/pets", postJson({ ...body, createdBy: c.user!.id }));
  }
  if (request.method === "DELETE" && c.id) {
    if (!CUSTOM_PET_ID.test(c.id)) return refuse(404, "not_found", "Custom pet not found");
    return c.roomFetch("/pets/" + c.id, { method: "DELETE" });
  }
  return json({ error: "Method not allowed" }, 405);
}

function petId(label: string): string {
  const slug =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30)
      .replace(/-+$/, "") || "pet";
  const rand = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return "p-" + slug + "-" + rand;
}

type RoomPetsOptions = { path: string; channel: string; config: PetPriceConfig; onDelete?: (id: string) => void };

// Durable Object side: /pets and /pets/<id>. onDelete(id) clears the pet from fighters (channel.ts).
export async function handleRoomPets(
  room: { ctx: DurableObjectState },
  request: Request,
  { path, channel, config, onDelete }: RoomPetsOptions,
): Promise<Response> {
  const sql = room.ctx.storage.sql;
  const id = path.startsWith("/pets/") ? path.slice(6) : "";
  if (!id && request.method === "GET")
    return json({ pets: petCatalog(sql, channel, config), hatPricePerWin: config.hatPricePerWin, limits: PET_LIMITS });
  if (!id && request.method === "POST") {
    // Any JSON (never undefined): validatePetUpload refuses anything but an object and checks every field it reads
    const body = await request.json<{ [field: string]: unknown }>().catch(() => undefined);
    if (body === undefined) return refuse(400, "invalid_upload", "Invalid JSON");
    const pet = validatePetUpload(body);
    if (pet.reason) return refuse(pet.status, pet.reason, pet.error);
    const newId = petId(pet.label),
      createdBy = String(body.createdBy || "unknown").slice(0, 64);
    const inserted = room.ctx.storage.transactionSync(() => {
      // COUNT(*) always returns one row
      if (sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM custom_pets").toArray()[0]!.n >= PET_LIMITS.maxPets)
        return false;
      sql.exec(
        "INSERT INTO custom_pets (id, label, tier, stat, stat2, png, bytes, width, height, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        newId,
        pet.label,
        pet.tier,
        pet.stat,
        pet.stat2,
        pet.bytes,
        pet.bytes.byteLength,
        pet.width,
        pet.height,
        createdBy,
        Date.now(),
      );
      return true;
    });
    const full = `This channel already has ${PET_LIMITS.maxPets} custom pets; delete one first`;
    if (!inserted) return refuse(409, "pet_limit_reached", full);
    return json({ ok: true, item: petCatalog(sql, channel, config).find((p) => p.id === newId) }, 201);
  }
  if (id && request.method === "GET") {
    const row =
      CUSTOM_PET_ID.test(id) &&
      sql.exec<{ png: ArrayBuffer }>("SELECT png FROM custom_pets WHERE id = ?", id).toArray()[0];
    return row ? png(row.png, "public, max-age=300") : json({ error: "Not found" }, 404);
  }
  if (id && request.method === "DELETE") {
    if (!CUSTOM_PET_ID.test(id) || !sql.exec("SELECT 1 FROM custom_pets WHERE id = ?", id).toArray().length)
      return refuse(404, "not_found", "Custom pet not found");
    room.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM custom_pets WHERE id = ?", id);
      sql.exec("DELETE FROM owned_items WHERE kind = 'pet' AND item_id = ?", id);
      sql.exec("UPDATE profiles SET pet = '' WHERE pet = ?", id);
      onDelete?.(id);
    });
    return json({ ok: true, id });
  }
  return json({ error: "Method not allowed" }, 405);
}
