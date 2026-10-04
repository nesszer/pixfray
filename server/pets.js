// Pets (docs/PROGRESSION_PLAN.md, Stage 3): bought with PixFray dollars, one active per fighter, each with a small
// stat boost by tier. Built-in pets are drawn in code (public/pets.js, same ids); streamers can upload their own as
// PNGs (custom_pets, ids "p-..."), picking the tier and the boosted stat.
//
// GET    /api/pets/:channel        public: { pets:[{id,label,tier,boost,price,custom,url?}], hatPricePerWin }
// GET    /api/pets/:channel/:id    public: an uploaded pet's PNG
// POST   /api/pets/:channel        canManage: { label, tier, stat, stat2?, image:"<base64 PNG>" } -> 201 {ok, item}
// DELETE /api/pets/:channel/:id    canManage -> {ok, id}; owners lose it and fighters using it go back to no pet
import { STATS, emptyStats } from "./upgrades.js";
import { readPng } from "./uploads.js";

export const TIERS = ["common", "uncommon", "rare", "epic", "legendary"];
export const TIER_LABELS = { common: "Common", uncommon: "Uncommon", rare: "Rare", epic: "Epic", legendary: "Legendary" };
export const PRICE_KEYS = { common: "petPriceCommon", uncommon: "petPriceUncommon", rare: "petPriceRare", epic: "petPriceEpic", legendary: "petPriceLegendary" };
export const MAX_BOOST = 2;   // per stat, on top of the upgrade points (it may go past MAX_PER_STAT)
export const CUSTOM_PET_ID = /^p-[a-z0-9-]{1,40}$/;
export const PET_LIMITS = Object.freeze({ maxPets: 24, maxBytes: 65_536, maxSide: 64, maxLabel: 24 });
const BODY_LIMIT = Math.ceil(PET_LIMITS.maxBytes / 3) * 4 + 4_000;

// Built-in pets: the stat (and second stat for epic) the tier boost goes to. Legendary boosts every stat.
export const PETS = [
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

// common/uncommon +1 to one stat, rare +2, epic +2 and +1 to a second stat, legendary +1 to every stat.
// Uncommon is cheaper than rare and looks better than common; its boost matches common on purpose (the plan keeps
// boosts small so a pet never decides a duel on its own).
export function tierBoost(tier, stat, stat2) {
  const out = emptyStats();
  if (tier === "legendary") { for (const key of STATS) out[key] = 1; return out; }
  if (!STATS.includes(stat)) return out;
  out[stat] = tier === "rare" || tier === "epic" ? 2 : TIERS.includes(tier) ? 1 : 0;
  if (tier === "epic" && STATS.includes(stat2) && stat2 !== stat) out[stat2] = 1;
  return out;
}

export function cleanBoost(input) {
  const out = emptyStats();
  for (const key of STATS) {
    const v = Number(input?.[key]);
    out[key] = Number.isInteger(v) ? Math.max(0, Math.min(MAX_BOOST, v)) : 0;
  }
  return out;
}

export const builtinPet = (id) => BUILTIN.get(id) || null;

// The pet a profile row points at: a built-in id, or a custom one with "tier:stat:stat2" read from custom_pets.
// null when there's no pet or it no longer exists.
export function petOf(id, custom = "") {
  if (!id) return null;
  const pet = builtinPet(id);
  if (pet) return { id, tier: pet.tier, boost: tierBoost(pet.tier, pet.stat, pet.stat2) };
  if (!CUSTOM_PET_ID.test(id) || !custom) return null;
  const [tier, stat, stat2] = String(custom).split(":");
  return TIERS.includes(tier) ? { id, tier, boost: tierBoost(tier, stat, stat2) } : null;
}

// "+2 power" / "+2 power, +1 guard" / "+1 to all stats" (same wording as the viewer page)
export const boostText = (boost) => STATS.every((k) => boost?.[k] > 0 && boost[k] === boost.power) ? `+${boost.power} to all stats` : STATS.filter((k) => boost?.[k] > 0).map((k) => `+${boost[k]} ${k}`).join(", ");

export const petPrice = (tier, config) => config?.[PRICE_KEYS[tier]] ?? null;
// Hats can be bought before the wins unlock them: wins needed x hatPricePerWin. null = not for sale (0 turns it off).
export const hatPrice = (hat, config) => (hat && hat.wins > 0 && config?.hatPricePerWin > 0 ? hat.wins * config.hatPricePerWin : null);

// Schema: called from ChannelRoom's constructor (before any profile query, which reads custom_pets).
export function ensurePetSchema(sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS custom_pets (id TEXT PRIMARY KEY, label TEXT NOT NULL, tier TEXT NOT NULL, stat TEXT NOT NULL, stat2 TEXT NOT NULL DEFAULT '', png BLOB NOT NULL, bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)");
  // What each fighter bought: kind "pet" or "hat". Kept on a rank reset; deleted with the profile.
  sql.exec("CREATE TABLE IF NOT EXISTS owned_items (user_id TEXT NOT NULL, kind TEXT NOT NULL, item_id TEXT NOT NULL, price INTEGER NOT NULL, bought_at INTEGER NOT NULL, PRIMARY KEY (user_id, kind, item_id))");
}

// The channel's pet catalog with prices from its config: built-ins first, then uploads in upload order.
export function petCatalog(sql, channel, config) {
  const builtins = PETS.map((p) => ({ id: p.id, label: p.label, tier: p.tier, boost: tierBoost(p.tier, p.stat, p.stat2), price: petPrice(p.tier, config), custom: false }));
  const custom = sql.exec("SELECT id, label, tier, stat, stat2, width, height FROM custom_pets ORDER BY created_at, id").toArray()
    .map((r) => ({ id: r.id, label: r.label, tier: r.tier, boost: tierBoost(r.tier, r.stat, r.stat2), price: petPrice(r.tier, config), custom: true, url: `/api/pets/${channel}/${r.id}`, width: r.width, height: r.height }));
  return [...builtins, ...custom];
}

const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const fail = (status, reason, error) => json({ ok: false, reason, error }, status);

// Upload body -> { label, tier, stat, stat2, bytes, width, height } or { status, reason, error }.
export function validatePetUpload(body) {
  const label = String(body?.label || "").trim().replace(/\s+/g, " ");
  if (!label || label.length > PET_LIMITS.maxLabel) return { status: 400, reason: "invalid_label", error: `Name the pet (1-${PET_LIMITS.maxLabel} characters)` };
  const tier = String(body?.tier || "");
  if (!TIERS.includes(tier)) return { status: 400, reason: "invalid_tier", error: "Pick a tier" };
  const stat = tier === "legendary" ? "" : String(body?.stat || "");
  if (tier !== "legendary" && !STATS.includes(stat)) return { status: 400, reason: "invalid_stat", error: "Pick the stat it boosts" };
  const stat2 = tier === "epic" ? String(body?.stat2 || "") : "";
  if (tier === "epic" && (!STATS.includes(stat2) || stat2 === stat)) return { status: 400, reason: "invalid_stat", error: "Epic pets boost two different stats" };
  const b64 = String(body?.image || "").replace(/^data:[^,]*;base64,/, "");
  if (!b64) return { status: 400, reason: "invalid_image", error: "Choose a PNG image" };
  if (b64.length > Math.ceil(PET_LIMITS.maxBytes / 3) * 4) return { status: 413, reason: "image_too_large", error: "The image is larger than 64 KB" };
  let binary;
  try { binary = atob(b64); } catch { return { status: 400, reason: "invalid_image", error: "The image is not valid base64" }; }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  let size;
  try { size = readPng(bytes); } catch (error) { return { status: 415, reason: "not_png", error: error.message }; }
  if (size.width > PET_LIMITS.maxSide || size.height > PET_LIMITS.maxSide) return { status: 400, reason: "image_dimensions", error: `Pets are at most ${PET_LIMITS.maxSide}x${PET_LIMITS.maxSide} pixels` };
  return { label, tier, stat, stat2, bytes, width: size.width, height: size.height };
}

// Worker side. c = { user, id, access(), roomFetch(path, init?), bodyJson(request, limit) }
export async function handlePets(request, env, c) {
  if (request.method === "GET") return c.roomFetch(c.id ? "/pets/" + c.id : "/pets");
  const roles = await c.access();
  if (!roles.canManage) return json({ error: roles.reason || "Moderator role required" }, c.user ? 403 : 401);
  if (request.method === "POST" && !c.id) {
    let body;
    try { body = await c.bodyJson(request, BODY_LIMIT); }
    catch (error) { return error.status === 413 ? fail(413, "image_too_large", "The image is larger than 64 KB") : fail(error.status || 400, "invalid_upload", error.message || "Invalid JSON"); }
    const checked = validatePetUpload(body);
    if (checked.reason) return fail(checked.status, checked.reason, checked.error);
    return c.roomFetch("/pets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, createdBy: c.user.id }) });
  }
  if (request.method === "DELETE" && c.id) {
    if (!CUSTOM_PET_ID.test(c.id)) return fail(404, "not_found", "Custom pet not found");
    return c.roomFetch("/pets/" + c.id, { method: "DELETE" });
  }
  return json({ error: "Method not allowed" }, 405);
}

function petId(label) {
  const slug = label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "") || "pet";
  const rand = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return "p-" + slug + "-" + rand;
}

// Durable Object side: /pets and /pets/<id>. onDelete(id) clears the pet from fighters (channel.js).
export async function handleRoomPets(room, request, { path, channel, config, onDelete }) {
  const sql = room.ctx.storage.sql;
  const id = path.startsWith("/pets/") ? path.slice(6) : "";
  if (!id && request.method === "GET") return json({ pets: petCatalog(sql, channel, config), hatPricePerWin: config.hatPricePerWin, limits: PET_LIMITS });
  if (!id && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return fail(400, "invalid_upload", "Invalid JSON"); }
    const pet = validatePetUpload(body);
    if (pet.reason) return fail(pet.status, pet.reason, pet.error);
    const newId = petId(pet.label), now = Date.now(), createdBy = String(body.createdBy || "unknown").slice(0, 64);
    const inserted = room.ctx.storage.transactionSync(() => {
      if (sql.exec("SELECT COUNT(*) AS n FROM custom_pets").toArray()[0].n >= PET_LIMITS.maxPets) return false;
      sql.exec("INSERT INTO custom_pets (id, label, tier, stat, stat2, png, bytes, width, height, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        newId, pet.label, pet.tier, pet.stat, pet.stat2, pet.bytes, pet.bytes.byteLength, pet.width, pet.height, createdBy, now);
      return true;
    });
    if (!inserted) return fail(409, "pet_limit_reached", `This channel already has ${PET_LIMITS.maxPets} custom pets; delete one first`);
    const item = petCatalog(sql, channel, config).find((p) => p.id === newId);
    return json({ ok: true, item }, 201);
  }
  if (id && request.method === "GET") {
    const row = CUSTOM_PET_ID.test(id) && sql.exec("SELECT png FROM custom_pets WHERE id = ?", id).toArray()[0];
    if (!row) return json({ error: "Not found" }, 404);
    return new Response(row.png, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } });
  }
  if (id && request.method === "DELETE") {
    if (!CUSTOM_PET_ID.test(id) || !sql.exec("SELECT 1 FROM custom_pets WHERE id = ?", id).toArray().length) return fail(404, "not_found", "Custom pet not found");
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
