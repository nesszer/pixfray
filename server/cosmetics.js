// Cosmetics and builds (docs/PROGRESSION_PLAN.md, Stage 4). Everything here is looks only: no stat changes.
// Bought with Mini Chat dollars in the website shop (channel.js buy), owned forever (owned_items, kind = the kind
// below), and worn per build. Taunts and titles are preset lines, so no viewer-typed text ever reaches the stream.
// The overlay and the dashboard preview draw them with public/cosmetics.js; its ids must match these.

// kind -> the profile field that wears it, and the config key with its price (every item of a kind costs the same).
export const COSMETIC_KINDS = ["recolor", "petcolor", "accessory", "trail", "effect", "taunt", "title"];
export const COSMETIC_FIELDS = { recolor: "recolor", petcolor: "petColor", accessory: "accessory", trail: "trail", effect: "winEffect", taunt: "taunt", title: "title" };
export const COSMETIC_PRICE_KEYS = { recolor: "recolorPrice", petcolor: "petColorPrice", accessory: "accessoryPrice", trail: "trailPrice", effect: "effectPrice", taunt: "tauntPrice", title: "titlePrice" };
export const COSMETIC_LABELS = { recolor: "Recolor", petcolor: "Pet color", accessory: "Accessory", trail: "Trail", effect: "Win effect", taunt: "Win taunt", title: "Title" };

// A recolor tints the whole character (or pet, for petcolor); the same palette serves both.
const COLORS = [
  { id: "crimson", label: "Crimson" },
  { id: "ocean", label: "Ocean" },
  { id: "forest", label: "Forest" },
  { id: "violet", label: "Violet" },
  { id: "gold", label: "Gold" },
  { id: "ghost", label: "Ghost" },
  { id: "shadow", label: "Shadow" },
  { id: "negative", label: "Negative" },
];

export const COSMETICS = {
  recolor: COLORS,
  petcolor: COLORS,
  accessory: [
    { id: "glasses", label: "Glasses" },
    { id: "shades", label: "Shades" },
    { id: "monocle", label: "Monocle" },
    { id: "bowtie", label: "Bow tie" },
    { id: "scarf", label: "Scarf" },
    { id: "cape", label: "Cape" },
  ],
  trail: [
    { id: "sparkles", label: "Sparkles" },
    { id: "hearts", label: "Hearts" },
    { id: "flames", label: "Flames" },
    { id: "bubbles", label: "Bubbles" },
    { id: "stars", label: "Stars" },
    { id: "notes", label: "Music notes" },
  ],
  effect: [
    { id: "confetti", label: "Confetti" },
    { id: "fireworks", label: "Fireworks" },
    { id: "banner", label: "Victory banner" },
  ],
  taunt: [
    { id: "gg", label: "GG!" },
    { id: "next", label: "Who's next?" },
    { id: "easy", label: "Too easy." },
    { id: "rematch", label: "Rematch? Any time." },
    { id: "bow", label: "Take a bow." },
    { id: "nap", label: "That was my warm-up." },
    { id: "luck", label: "Better luck next time!" },
    { id: "chat", label: "Chat, did you see that?" },
  ],
  title: [
    { id: "rookie", label: "Rookie" },
    { id: "brawler", label: "Brawler" },
    { id: "lucky", label: "Lucky Star" },
    { id: "wall", label: "Iron Wall" },
    { id: "cannon", label: "Glass Cannon" },
    { id: "owl", label: "Night Owl" },
    { id: "menace", label: "Chat Menace" },
    { id: "champion", label: "Champion" },
    { id: "legend", label: "Legend" },
  ],
};
const BY_KIND = Object.fromEntries(COSMETIC_KINDS.map((k) => [k, new Map(COSMETICS[k].map((x) => [x.id, x]))]));

export const cosmeticItem = (kind, id) => BY_KIND[kind]?.get(id) || null;
export const knownCosmetic = (kind, id) => id === "" || Boolean(cosmeticItem(kind, id));
export const cosmeticPrice = (kind, config) => config?.[COSMETIC_PRICE_KEYS[kind]] ?? null;
// The text a taunt or title shows: only from the lists above.
export const tauntText = (id) => cosmeticItem("taunt", id)?.label || "";
export const titleText = (id) => cosmeticItem("title", id)?.label || "";

// The worn cosmetics of a profile, unknown ids as "" (none).
export function cleanCosmetics(input) {
  const out = {};
  for (const kind of COSMETIC_KINDS) {
    const field = COSMETIC_FIELDS[kind], id = typeof input?.[field] === "string" ? input[field] : "";
    out[field] = knownCosmetic(kind, id) ? id : "";
  }
  return out;
}

// Builds: slot 0 is free; the 2nd costs buildSlotPrice and each one after buildSlotPriceMore, up to MAX_BUILDS.
export const MAX_BUILDS = 5;
export const slotPrice = (slots, config) => (slots >= MAX_BUILDS ? null : slots <= 1 ? config?.buildSlotPrice ?? null : config?.buildSlotPriceMore ?? null);
// What a build keeps (each slot spends the full point pool on its own stats).
export const BUILD_FIELDS = ["avatar", "color", "defaultAbility", "stats", "hat", "pet", ...COSMETIC_KINDS.map((k) => COSMETIC_FIELDS[k])];
export const buildOf = (profile) => Object.fromEntries(BUILD_FIELDS.map((f) => [f, f === "stats" ? { ...(profile?.stats || {}) } : profile?.[f] ?? ""]));

// The public shop list with this channel's prices (GET /api/shop).
export function cosmeticCatalog(config) {
  return Object.fromEntries(COSMETIC_KINDS.map((kind) => [kind, COSMETICS[kind].map((x) => ({ ...x, price: cosmeticPrice(kind, config) }))]));
}
