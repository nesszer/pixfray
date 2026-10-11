// Cosmetics and builds (docs/PROGRESSION_PLAN.md, Stage 4). Everything here is looks only: no stat changes.
// Bought with PixFray dollars in the website shop (channel.ts buy), owned forever (owned_items, kind = the kind
// below), and worn per build. Taunts and titles are preset lines, so no viewer-typed text ever reaches the stream.
// The overlay and the dashboard preview draw them with src/served/cosmetics.ts; its ids must match these.

import type { Cosmetics } from "./model.ts";

// kind -> the profile field that wears it, and the config key with its price (every item of a kind costs the same).
export const COSMETIC_KINDS = ["recolor", "petcolor", "accessory", "trail", "effect", "taunt", "title"] as const; // const: each kind a literal
export type CosmeticKind = (typeof COSMETIC_KINDS)[number];
/** One item of a kind: its id (stored on the profile) and the label the shop and chat show. */
export type CosmeticItem = { id: string; label: string };
/** Prices from the channel config (server/game.ts DEFAULT_CONFIG); a missing key means not for sale. */
export type CosmeticPriceConfig = {
  [key in (typeof COSMETIC_PRICE_KEYS)[CosmeticKind] | "buildSlotPrice" | "buildSlotPriceMore"]?: number;
};
export const COSMETIC_FIELDS: { [kind in CosmeticKind]: keyof Cosmetics } = {
  recolor: "recolor",
  petcolor: "petColor",
  accessory: "accessory",
  trail: "trail",
  effect: "winEffect",
  taunt: "taunt",
  title: "title",
};
export const COSMETIC_PRICE_KEYS = {
  recolor: "recolorPrice",
  petcolor: "petColorPrice",
  accessory: "accessoryPrice",
  trail: "trailPrice",
  effect: "effectPrice",
  taunt: "tauntPrice",
  title: "titlePrice",
} as const; // const: each key a literal, so CosmeticPriceConfig names them
export const COSMETIC_LABELS: Record<CosmeticKind, string> = {
  recolor: "Recolor",
  petcolor: "Pet color",
  accessory: "Accessory",
  trail: "Trail",
  effect: "Win effect",
  taunt: "Win taunt",
  title: "Title",
};

// A recolor tints the whole character (or pet, for petcolor); the same palette serves both.
const COLORS: CosmeticItem[] = [
  { id: "crimson", label: "Crimson" },
  { id: "ocean", label: "Ocean" },
  { id: "forest", label: "Forest" },
  { id: "violet", label: "Violet" },
  { id: "gold", label: "Gold" },
  { id: "ghost", label: "Ghost" },
  { id: "shadow", label: "Shadow" },
  { id: "negative", label: "Negative" },
];

export const COSMETICS: Record<CosmeticKind, CosmeticItem[]> = {
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

export const cosmeticItem = (kind: string, id: string): CosmeticItem | null => BY_KIND[kind]?.get(id) || null;
export const knownCosmetic = (kind: string, id: string): boolean => id === "" || Boolean(cosmeticItem(kind, id));
export const cosmeticPrice = (kind: CosmeticKind, config: CosmeticPriceConfig | null | undefined): number | null =>
  config?.[COSMETIC_PRICE_KEYS[kind]] ?? null;
// The text a taunt or title shows: only from the lists above.
export const tauntText = (id: string): string => cosmeticItem("taunt", id)?.label || "";
export const titleText = (id: string): string => cosmeticItem("title", id)?.label || "";

// The worn cosmetics of a profile, unknown ids as "" (none).
type LooseCosmetics = Partial<Record<keyof Cosmetics, unknown>> | null | undefined;
export function cleanCosmetics(input: unknown): Cosmetics {
  // Every field is set by the loop below, one per kind
  const out = {} as Cosmetics;
  for (const kind of COSMETIC_KINDS) {
    const field = COSMETIC_FIELDS[kind],
      // Any value read as a loose record (?. covers null and undefined); the typeof check makes the second read a string
      id = typeof (input as LooseCosmetics)?.[field] === "string" ? (input as Cosmetics)[field] : "";
    out[field] = knownCosmetic(kind, id) ? id : "";
  }
  return out;
}

// Builds: slot 0 is free; the 2nd costs buildSlotPrice and each one after buildSlotPriceMore, up to MAX_BUILDS.
export const MAX_BUILDS = 5;
export const slotPrice = (slots: number, config: CosmeticPriceConfig | null | undefined): number | null =>
  slots >= MAX_BUILDS ? null : slots <= 1 ? (config?.buildSlotPrice ?? null) : (config?.buildSlotPriceMore ?? null);
// What a build keeps (each slot spends the full point pool on its own stats).
export const BUILD_FIELDS: string[] = [
  "avatar",
  "color",
  "defaultAbility",
  "stats",
  "hat",
  "pet",
  ...COSMETIC_KINDS.map((k) => COSMETIC_FIELDS[k]),
];
// Any profile-shaped value: ?. reads undefined from a missing one. stats is cast for the spread: spreading any
// value copies its own enumerable fields, and undefined, null or a number copy nothing.
export const buildOf = (profile: { readonly [field: string]: unknown } | null | undefined): Record<string, unknown> =>
  Object.fromEntries(
    BUILD_FIELDS.map((f) => [f, f === "stats" ? { ...(profile?.stats as object | undefined) } : (profile?.[f] ?? "")]),
  );

// The public shop list with this channel's prices (GET /api/shop).
export function cosmeticCatalog(
  config: CosmeticPriceConfig | null | undefined,
): Record<string, (CosmeticItem & { price: number | null })[]> {
  return Object.fromEntries(
    COSMETIC_KINDS.map((kind) => [kind, COSMETICS[kind].map((x) => ({ ...x, price: cosmeticPrice(kind, config) }))]),
  );
}
