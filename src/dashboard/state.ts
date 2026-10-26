// The fighter page's state and the helpers every tab shares: the loadout being edited, what the fighter owns,
// the 3D preview and the voxel thumbnails.
import {
  h,
  $,
  addSprite,
  addStage,
  composeLook,
  onLooksReady,
  whenImage,
  CHANNEL_PICKED,
  DEFAULT_COLOR,
} from "../ui.ts";
import { upgradeRules, effectiveStats, STATS } from "../../server/upgrades.ts";
import type { Fighter3D, Look } from "../fighter3d.ts";
import type { voxThumb as voxThumbFn, voxAll as voxAllFn } from "../voxthumb.ts";
import type { Stats } from "../../server/upgrades.ts";
import type { CosmeticKind } from "../../server/cosmetics.ts";
import type { Build, LeaderRow, Owned, Profile, Session, Shop, ShopPet, StateConfig as Config } from "../parse.ts";

// The shapes this page reads from the API (docs/CONTRACTS.md section 2), with only the fields it uses.
/** A catalog character (ui.ts's sprite entry) plus the words and owner the picker shows. */
export type CatalogEntry = NonNullable<Parameters<typeof addSprite>[1]> & {
  label?: string;
  custom?: boolean;
  owner?: string;
};
/** The profile field each cosmetic kind wears. */
type LookField = "recolor" | "petColor" | "accessory" | "trail" | "winEffect" | "taunt" | "title";
export type KindKey = keyof typeof KINDS;
export type Kind = (typeof KINDS)[KindKey];
/** What a picker tile or a Buy button is for: a cosmetic kind, a hat or a pet (and a build slot for Buy). */
export type ItemKind = KindKey | "hat" | "pet";
export type BuyKind = ItemKind | "slot";
export type Loadout = {
  avatar: string;
  color: string;
  defaultAbility: string;
  stats: Stats;
  hat: string;
  pet: string;
} & Record<LookField, string>;
/** The viewer's base look on another channel; useOther still checks color and ability as the server stores them. */
export type Other = { channel: string; avatar: string; color: string; defaultAbility: string };
type SpriteOpts = NonNullable<Parameters<typeof addSprite>[2]>;

export const form = $<HTMLFormElement>("#profile-form"),
  saveBtn = $<HTMLButtonElement>("#save"),
  status = $<HTMLParagraphElement>("#save-status");
// Cosmetic kinds (server/cosmetics.ts): the profile field that wears each, how its tiles look, and its words.
export const KINDS = {
  recolor: { field: "recolor", look: "char", none: "Original colors", noun: "recolor" },
  petcolor: { field: "petColor", look: "pet", none: "Original colors", noun: "pet color" },
  accessory: { field: "accessory", look: "char", none: "No accessory", noun: "accessory" },
  trail: { field: "trail", look: "sample", none: "No trail", noun: "trail" },
  effect: { field: "winEffect", look: "sample", none: "No win effect", noun: "win effect" },
  taunt: { field: "taunt", look: "text", none: "No taunt", noun: "taunt" },
  title: { field: "title", look: "text", none: "No title", noun: "title" },
} satisfies Record<
  CosmeticKind,
  { field: LookField; look: "char" | "pet" | "sample" | "text"; none: string; noun: string }
>;
const LOOK_FIELDS = Object.values(KINDS).map((k) => k.field);
// as unknown as Owned: Object.fromEntries types its keys as string; they are the KINDS keys
export const emptyOwned = () =>
  ({
    pets: [],
    hats: [],
    ...Object.fromEntries(Object.keys(KINDS).map((k) => [k, []])),
    slots: 1,
    rolls: {},
    rerolled: [],
  }) as unknown as Owned; // the spread's keys are the KINDS keys (see above)
export const state: {
  session: Session | null;
  catalog: CatalogEntry[];
  profile: Profile | null;
  leaderboard: LeaderRow[];
  config: Config | null;
  shop: Shop | null;
  owned: Owned;
  d: Loadout;
  slot: number;
  builds: (Build | null | undefined)[];
  drafts: (Loadout | null | undefined)[];
  filter: { q: string; group: string };
  others: Other[];
  loading: boolean;
  off?: string;
} = {
  session: null,
  catalog: [],
  profile: null,
  leaderboard: [],
  config: null,
  shop: null,
  owned: emptyOwned(),
  // null!: null until applyProfile runs; render3d can run first and checks `!d` itself, so keep that check
  d: null!,
  slot: 0, // the build slot being edited; the profile's own build is the one on stream
  builds: [], // saved loadouts per slot, null for a slot never saved
  drafts: [], // unsaved edits per slot, kept while switching between builds
  filter: { q: "", group: "all" },
  others: [], // the viewer's fighters on other channels, offered when they have none here
  loading: true, // until the first /api answers arrive
};

export const stage = addStage($<HTMLCanvasElement>("#preview"));
// The 3D fighter loads after the page works; without WebGL the card keeps the 2D stage.
let fighter3d: Fighter3D | null = null;
if (CHANNEL_PICKED && !navigator.connection?.saveData) {
  import("../fighter3d.ts")
    .then(({ createFighter3D }) => {
      $("#showcase").hidden = false;
      try {
        fighter3d = createFighter3D($<HTMLCanvasElement>("#preview3d"), { zoom: 1.2 });
      } catch {
        $("#showcase").hidden = true;
        return;
      }
      $(".fighter-card").classList.add("has-3d");
      render3d();
    })
    .catch(() => {});
}
export function render3d(d: Loadout = state.d) {
  if (!fighter3d || !d) return;
  const entry = entryOf(d.avatar),
    pet = petById(d.pet);
  const look = composeLook(entry, { hat: d.hat, pet, looks: looks(d) });
  if (look) {
    fighter3d.set(look);
    // the intro's lock-on readout; entry!: composeLook returns a look only for an entry
    const i = pickable().indexOf(entry!);
    $("#readout-name").textContent = entry!.label || entry!.id; // entry!: as above
    $("#readout-sub").textContent = i >= 0 ? "Character " + (i + 1) + " of " + pickable().length : "";
  } else if (entry) whenImage(entry.url, () => render3d());
  if (pet?.url) whenImage(pet.url, () => render3d());
}
onLooksReady($<HTMLCanvasElement>("#preview3d"), () => render3d());
// Tiles get voxel thumbnails (src/voxthumb.ts); until it loads, or without WebGL, they show flat sprites.
const voxJobs = new Map<HTMLCanvasElement, () => Look | null>();
let voxThumb: typeof voxThumbFn | null = null;
export let voxAll: typeof voxAllFn | null = null;
export function vox(canvas: HTMLCanvasElement, make: () => Look | null) {
  if (voxJobs.size > 400) for (const c of voxJobs.keys()) if (!c.isConnected) voxJobs.delete(c);
  voxJobs.set(canvas, make);
  voxThumb?.(canvas, make);
}
// a hat, pet or accessory drawing module arriving changes how the tiles' looks draw
onLooksReady($<HTMLCanvasElement>("#preview3d"), () => {
  for (const [c, make] of voxJobs) if (c.isConnected) voxThumb?.(c, make);
});
if (!navigator.connection?.saveData) {
  import("../voxthumb.ts")
    .then((m) => {
      voxThumb = m.voxThumb;
      voxAll = m.voxAll;
      for (const [c, make] of voxJobs) if (c.isConnected) voxThumb(c, make);
    })
    .catch(() => {});
}
export const voxCanvas = () => h("canvas", { class: "vox", width: 128, height: 128, "aria-hidden": "true" });
// A character's picture: its voxels over the flat sprite. `open` marks the open spot on the picker.
export function thumb(entry: CatalogEntry | null, size: number, opts: SpriteOpts = { active: () => false }, open = "") {
  const canvas = h("canvas", { class: "sprite" + open, width: size, height: size, "aria-hidden": "true" }),
    v = voxCanvas();
  if (entry) {
    addSprite(canvas, entry, opts);
    vox(v, () => composeLook(entry));
  }
  return h("span", { class: "thumb" + open }, v, canvas);
}
// Hovering a tile tries it on the 3D fighter for a moment; leaving puts the picked look back.
let peekTimer = 0;
export function peekOn(el: HTMLElement, field: keyof Loadout, value: string) {
  el.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => render3d({ ...state.d, [field]: value }), 140);
  });
  el.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => render3d(), 80);
  });
}

// Shop and save error codes, as the end of "Not bought: ..." and "Not saved: ...".
export const REASONS: Record<string, string> = {
  in_duel: "finish your open challenge or duel first.",
  rerolled: "you already used this pet's free reroll.",
  invalid_upgrades: "those upgrades need more wins.",
  hat_locked: "that hat needs more wins.",
  pet_locked: "buy that pet first.",
  not_enough: "you don't have enough dollars.",
  owned: "you already own it.",
  no_fighter: "save your fighter first.",
  already_unlocked: "your wins already unlock it.",
  hats_not_for_sale: "hats aren't for sale on this channel.",
  unknown_item: "that item isn't in the shop anymore.",
  item_locked: "buy that item first.",
  invalid_build: "that build slot isn't yours yet.",
  max_slots: "you already have the most builds (5).",
};

const str = (v: unknown) => (typeof v === "string" ? v : "");
export const rules = () => upgradeRules(state.profile ?? {}, state.config?.maxStatLevel);
// A saved build (or profile) as an editable loadout, with only ids this page knows.
export function loadoutOf(b: Build | null | undefined): Loadout {
  const p = state.profile;
  return {
    // b!.avatar!: some() matched a catalog id to b?.avatar, so b and its avatar are set
    avatar: state.catalog.some((x) => x.id === b?.avatar) ? b!.avatar! : state.catalog[0]?.id || "",
    // b!.color!: the test matched b?.color, so b and its color are set
    color: /^#[0-9a-f]{6}$/i.test(b?.color || "") ? b!.color!.toLowerCase() : DEFAULT_COLOR,
    defaultAbility: str(b?.defaultAbility) || p?.defaultAbility || "strike", // only used by the HP fight
    stats: effectiveStats(b?.stats, p ?? {}),
    hat: str(b?.hat),
    pet: str(b?.pet),
    // as: Object.fromEntries types its keys as string; they are LOOK_FIELDS
    ...(Object.fromEntries(LOOK_FIELDS.map((f) => [f, str(b?.[f])])) as Record<LookField, string>),
  };
}
export const copy = (d: Loadout) => ({ ...d, stats: { ...d.stats } });
export const same = (a: Loadout | null, b: Loadout | null) =>
  Boolean(a && b) &&
  (["avatar", "color", "hat", "pet", ...LOOK_FIELDS] satisfies (keyof Loadout)[]).every((f) => a![f] === b![f]) && // a!, b!: Boolean(a && b) above
  STATS.every((k) => (a!.stats?.[k] || 0) === (b!.stats?.[k] || 0)); // a!, b!: Boolean(a && b) above
export const current = () => ({ ...copy(state.d), build: state.slot });
export const activeBuild = () => state.profile?.build || 0;
export const savedSlot = () => (state.builds[state.slot] ? loadoutOf(state.builds[state.slot]) : null);
export const dirty = () => Boolean(state.profile) && (state.slot !== activeBuild() || !same(state.d, savedSlot()));
// Edits that leaving the page would lose, in any build. Only looking at another saved build loses nothing.
const unsavedIn = (d: Loadout, slot: number) => !same(d, state.builds[slot] ? loadoutOf(state.builds[slot]) : null);
export const edited = () =>
  Boolean(state.profile) &&
  (unsavedIn(state.d, state.slot) || state.drafts.some((d, i) => d && i !== state.slot && unsavedIn(d, i)));
export const petById = (id: string) => state.shop?.pets.find((x) => x.id === id) || null;
export const entryOf = (id: string | undefined) => state.catalog.find((x) => x.id === id) || null;
// A viewer's approved sprite (server/sprites.ts) is only for them; state.catalog keeps everyone's for the ranks.
export const pickable = () => state.catalog.filter((e) => !e.owner || e.owner === state.session?.user?.id);
export const looks = (d = state.d) => Object.fromEntries(LOOK_FIELDS.map((f) => [f, d[f]]));
// "+2 power, +1 guard", or "+1 guard, crit, dodge and vitality" when three or more stats share one number (as
// server/pets.ts boostText).
export function boostText(b: Partial<Stats> | undefined) {
  const keys = STATS.filter((k) => b?.[k]);
  const first = keys[0];
  if (first && keys.length >= 3 && keys.every((k) => b![k] === b![first]))
    // b!: filter() kept only stats b has
    return "+" + b![first] + " " + keys.slice(0, -1).join(", ") + " and " + keys.at(-1); // b!: as above
  return keys.map((k) => "+" + b![k] + " " + k).join(", "); // b!: as above
}
// A pet's boost for this fighter: an owned legendary gives +1 to each stat it rolled, other pets their catalog boost.
export function petBoost(pet: ShopPet | null): Partial<Stats> | undefined {
  if (pet?.tier !== "legendary") return pet?.boost;
  const roll = state.owned.rolls?.[pet.id] || [];
  return Object.fromEntries(STATS.filter((k) => roll.includes(k)).map((k) => [k, 1]));
}
export const petTag = (pet: ShopPet) =>
  pet.tier.charAt(0).toUpperCase() +
  pet.tier.slice(1) +
  ", " +
  (pet.tier === "legendary" && !state.owned.rolls?.[pet.id]?.length
    ? "+1 to 4 random stats"
    : boostText(petBoost(pet)));
export const canShop = () => Boolean(state.session?.user && state.profile) && !state.off;
export const signedIn = () => Boolean(state.session?.user);
export const money = (n: number | null | undefined) => "$" + (n || 0);

// What the fighter owns: hats unlocked by wins count as owned, and "none" always is.
export function owns(kind: ItemKind, id: string) {
  if (!id) return true;
  if (kind === "hat") return rules().hats.some((x) => x.id === id && x.unlocked) || state.owned.hats.includes(id);
  if (kind === "pet") return state.owned.pets.includes(id);
  return (state.owned[kind] || []).includes(id);
}
export const itemLabel = (kind: ItemKind, id: string) =>
  kind === "hat"
    ? (rules().hats.find((x) => x.id === id)?.label || id) + " hat"
    : kind === "pet"
      ? petById(id)?.label || id
      : state.shop?.items?.[kind]?.find((x) => x.id === id)?.label || id;
// Worn items the fighter doesn't own yet (tried on): saving needs them bought first.
export function lockedWorn() {
  const out: [ItemKind, string][] = [];
  if (!owns("hat", state.d.hat)) out.push(["hat", state.d.hat]);
  if (!owns("pet", state.d.pet)) out.push(["pet", state.d.pet]);
  // as: Object.entries types its keys as string; they are the KINDS keys
  for (const [kind, k] of Object.entries(KINDS) as [KindKey, Kind][])
    if (!owns(kind, state.d[k.field])) out.push([kind, state.d[k.field]]);
  return out;
}
export const wornList = (locked: [ItemKind, string][]) => locked.map(([k, id]) => itemLabel(k, id)).join(", ");
