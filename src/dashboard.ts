// Viewer dashboard ("/"): an on-stream preview above four tabs. Fighter (builds, character, colors, upgrades),
// Shop (hats and cosmetics), Pets (pets and pet colors) and Ranks (leaderboard and duel rules).
// Talks only to the routes in docs/CONTRACTS.md section 2.
import {
  api,
  errorText,
  h,
  $,
  setStatus,
  renderWho,
  signOut,
  addSprite,
  addPet,
  addStage,
  addCosmeticSample,
  composeLook,
  onLooksReady,
  whenImage,
  seconds,
  CHANNEL,
  CHANNEL_PICKED,
  DEFAULT_COLOR,
  applyChannel,
} from "./ui.ts";
import { upgradeRules, effectiveStats, STAT_STEP } from "../server/upgrades.ts";
import { CHARACTER_GROUPS } from "./character-groups.ts";
import { skyBackdrop } from "./scrub.ts";
import { initSpriteMaker } from "./sprite-maker.ts";
import site from "../site.config.js";
import type { Fighter3D, Look } from "./fighter3d.ts";
import type { voxThumb as voxThumbFn, voxAll as voxAllFn } from "./voxthumb.ts";
import type { Stat, Stats } from "../server/upgrades.ts";
skyBackdrop();
applyChannel();

// ---------- types ----------
// The shapes this page reads from the API (docs/CONTRACTS.md section 2), with only the fields it uses.
/** A catalog character (ui.ts's sprite entry) plus the words and owner the picker shows. */
type CatalogEntry = NonNullable<Parameters<typeof addSprite>[1]> & { label?: string; custom?: boolean; owner?: string };
/** A shop pet: ui.ts's pet plus its price, tier and stat boost. */
type ShopPet = NonNullable<NonNullable<Parameters<typeof addSprite>[2]>["pet"]> & {
  id: string;
  label: string;
  price?: number;
  tier: string;
  boost?: Partial<Stats>;
};
type ShopItem = { id: string; label: string; price?: number };
type Shop = {
  pets: ShopPet[];
  items?: Partial<Record<KindKey, ShopItem[]>>;
  hatPricePerWin?: number;
  slots?: { prices?: number[]; max?: number };
};
/** The profile field each cosmetic kind wears. */
type LookField = "recolor" | "petColor" | "accessory" | "trail" | "winEffect" | "taunt" | "title";
type KindKey = keyof typeof KINDS;
type Kind = (typeof KINDS)[KindKey];
/** What a picker tile or a Buy button is for: a cosmetic kind, a hat or a pet (and a build slot for Buy). */
type ItemKind = KindKey | "hat" | "pet";
type BuyKind = ItemKind | "slot";
/** A saved build or profile, from the API or a stored draft. loadoutOf reads hat, pet, stats and the look fields
 * through str() and effectiveStats(), so they stay unknown; avatar, color and defaultAbility are strings when set. */
type Build = { avatar?: string; color?: string; defaultAbility?: string; [field: string]: unknown };
type Owned = { pets: string[]; hats: string[]; slots: number } & Record<KindKey, string[]>;
type Profile = Build & {
  wins: number;
  losses: number;
  bonus?: number;
  elo: number;
  dollars: number;
  streak?: number;
  build?: number;
  builds?: (Build | null)[];
  owned?: Partial<Owned>;
};
/** The loadout being edited (loadoutOf). */
type Loadout = {
  avatar: string;
  color: string;
  defaultAbility: string;
  stats: Stats;
  hat: string;
  pet: string;
} & Record<LookField, string>;
type Session = { user?: { id: string; login: string; displayName?: string } | null; configured?: boolean };
type Config = {
  initialElo: number;
  challengeTimeoutMs: number;
  rematchDelayMs: number;
  checkinPoints?: number;
  winDollars?: number;
  lossDollars?: number;
  giveEnabled?: boolean;
  giveMaxPerStream?: number;
  giveMinDuels?: number;
  quickDuel?: boolean;
};
type LeaderRow = {
  userId: string;
  username: string;
  displayName?: string;
  color: string;
  avatar: string;
  elo: number;
  wins: number;
  losses: number;
};
/** A channel's top fighter on the /play/ picker (server/worker.ts PickerData). */
type TopRow = { username: string; displayName?: string; elo: number; avatar: string };
type PickerChannel = { login: string; top: TopRow[]; catalog?: CatalogEntry[] };
/** The viewer's base look on another channel; useOther still checks color and ability as the server stores them. */
type Other = { channel: string; avatar: string; color: string; defaultAbility: string };
type State = {
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
};
type SpriteHandle = ReturnType<typeof addSprite>;

const SWATCHES = ["#a78bfa", "#60a5fa", "#34d399", "#fbbf24", "#f87171", "#f472b6", "#e5e7eb", "#22d3ee"];
// as: element types from the page HTML (index.html), here and at every lookup below
const form = $("#profile-form") as HTMLFormElement,
  saveBtn = $("#save") as HTMLButtonElement, // element type from the page HTML
  saveSignin = $("#save-signin") as HTMLAnchorElement, // element type from the page HTML
  status = $("#save-status") as HTMLParagraphElement; // element type from the page HTML
const colorInput = $("#color") as HTMLInputElement; // element type from the page HTML
// Cosmetic kinds (server/cosmetics.ts): the profile field that wears each, how its tiles look, and its words.
const KINDS = {
  recolor: { field: "recolor", look: "char", none: "Original colors", noun: "recolor" },
  petcolor: { field: "petColor", look: "pet", none: "Original colors", noun: "pet color" },
  accessory: { field: "accessory", look: "char", none: "No accessory", noun: "accessory" },
  trail: { field: "trail", look: "sample", none: "No trail", noun: "trail" },
  effect: { field: "winEffect", look: "sample", none: "No win effect", noun: "win effect" },
  taunt: { field: "taunt", look: "text", none: "No taunt", noun: "taunt" },
  title: { field: "title", look: "text", none: "No title", noun: "title" },
} satisfies Record<string, { field: LookField; look: "char" | "pet" | "sample" | "text"; none: string; noun: string }>;
const LOOK_FIELDS = Object.values(KINDS).map((k) => k.field);
// as unknown as Owned: Object.fromEntries types its keys as string; they are the KINDS keys
const emptyOwned = () =>
  ({
    pets: [],
    hats: [],
    ...Object.fromEntries(Object.keys(KINDS).map((k) => [k, []])),
    slots: 1,
  }) as unknown as Owned; // the spread's keys are the KINDS keys (see above)
const state: State = {
  session: null,
  catalog: [],
  profile: null,
  leaderboard: [],
  config: null,
  shop: null,
  owned: emptyOwned(),
  // null!: null until applyProfile runs; render3d can run first and checks `!d` itself, so keep that check
  d: null!, // the loadout being edited: { avatar, color, defaultAbility, stats, hat, pet, ...LOOK_FIELDS }
  slot: 0, // the build slot being edited; the profile's own build is the one on stream
  builds: [], // saved loadouts per slot (GET /api/profile builds), null for a slot never saved
  drafts: [], // unsaved edits per slot, kept while switching between builds
  filter: { q: "", group: "all" },
  others: [], // the viewer's fighters on other channels, offered when they have none here
  loading: true,
}; // until the first /api answers arrive
const stage = addStage($("#preview") as HTMLCanvasElement); // element type from the page HTML
// The 3D fighter above the on-stream preview loads after the page works; without WebGL the card keeps the 2D stage.
let fighter3d: Fighter3D | null = null;
if (CHANNEL_PICKED && !navigator.connection?.saveData) {
  import("./fighter3d.ts")
    .then(({ createFighter3D }) => {
      ($("#showcase") as HTMLElement).hidden = false; // element type from the page HTML (a figure)
      try {
        fighter3d = createFighter3D($("#preview3d") as HTMLCanvasElement, { zoom: 1.2 }); // element type from the page HTML
      } catch {
        ($("#showcase") as HTMLElement).hidden = true; // element type from the page HTML (a figure)
        return;
      }
      ($(".fighter-card") as HTMLElement).classList.add("has-3d"); // element type from the page HTML (an aside)
      render3d();
    })
    .catch(() => {});
}
function render3d(d: Loadout = state.d) {
  if (!fighter3d || !d) return;
  const entry = entryOf(d.avatar),
    pet = petById(d.pet);
  const look = composeLook(entry, { hat: d.hat, pet, looks: looks(d) });
  if (look) {
    fighter3d.set(look);
    readout(entry!); // entry!: composeLook returns a look only for an entry
  } else if (entry) whenImage(entry.url, () => render3d());
  if (pet?.url) whenImage(pet.url, () => render3d());
}
onLooksReady($("#preview3d") as HTMLCanvasElement, () => render3d()); // element type from the page HTML
// the intro's lock-on readout: name, then cubes and place in the roster
function readout(entry: CatalogEntry) {
  const i = pickable().indexOf(entry);
  ($("#readout-name") as HTMLElement).textContent = entry.label || entry.id; // element type from the page HTML (a b)
  ($("#readout-sub") as HTMLSpanElement).textContent = // element type from the page HTML
    i >= 0 ? "Character " + (i + 1) + " of " + pickable().length : "";
}
// Picker tiles get voxel thumbnails too (src/voxthumb.ts); until it loads, or without WebGL, they show flat sprites.
const voxJobs = new Map<HTMLCanvasElement, () => Look | null>();
let voxThumb: typeof voxThumbFn | null = null,
  voxAll: typeof voxAllFn | null = null;
function vox(canvas: HTMLCanvasElement, make: () => Look | null) {
  if (voxJobs.size > 400) for (const c of voxJobs.keys()) if (!c.isConnected) voxJobs.delete(c);
  voxJobs.set(canvas, make);
  voxThumb?.(canvas, make);
}
// a hat, pet or accessory drawing module arriving changes how the tiles' looks draw
onLooksReady($("#preview3d") as HTMLCanvasElement, () => {
  // element type from the page HTML
  for (const [c, make] of voxJobs) if (c.isConnected) voxThumb?.(c, make);
});
if (!navigator.connection?.saveData) {
  import("./voxthumb.ts")
    .then((m) => {
      voxThumb = m.voxThumb;
      voxAll = m.voxAll;
      for (const [c, make] of voxJobs) if (c.isConnected) voxThumb(c, make);
    })
    .catch(() => {});
}
const voxCanvas = () => h("canvas", { class: "vox", width: 128, height: 128, "aria-hidden": "true" });
// Hovering a tile tries it on the 3D fighter for a moment; leaving puts the picked look back.
let peekTimer = 0;
function peekOn(el: HTMLElement, field: keyof Loadout, value: string) {
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
const pct = (n: number) => Math.round(n * STAT_STEP * 100) + "%";
const STAT_TEXT = {
  power: { label: "Power", effect: (n: number) => "+" + pct(n) + " damage dealt" },
  guard: { label: "Guard", effect: (n: number) => "−" + pct(n) + " damage taken" },
  luck: { label: "Luck", effect: (n: number) => pct(n) + " of misses still hit" },
};
const REASONS: Record<string, string> = {
  in_duel: "finish your open challenge or duel before moving upgrade points.",
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

const STATS: Stat[] = ["power", "guard", "luck"];
const str = (v: unknown) => (typeof v === "string" ? v : "");
const rules = () => upgradeRules(state.profile?.wins || 0, state.profile?.bonus || 0);
// A saved build (or profile) as an editable loadout, with only ids this page knows.
function loadoutOf(b: Build | null | undefined): Loadout {
  const p = state.profile;
  return {
    // b!.avatar!: some() matched a catalog id to b?.avatar, so b and its avatar are set
    avatar: state.catalog.some((x) => x.id === b?.avatar) ? b!.avatar! : state.catalog[0]?.id || "",
    // b!.color!: the test matched b?.color, so b and its color are set
    color: /^#[0-9a-f]{6}$/i.test(b?.color || "") ? b!.color!.toLowerCase() : DEFAULT_COLOR,
    defaultAbility: str(b?.defaultAbility) || p?.defaultAbility || "strike", // only used by the HP fight
    stats: effectiveStats(b?.stats, p?.wins || 0, p?.bonus || 0),
    hat: str(b?.hat),
    pet: str(b?.pet),
    // as: Object.fromEntries types its keys as string; they are LOOK_FIELDS
    ...(Object.fromEntries(LOOK_FIELDS.map((f) => [f, str(b?.[f])])) as Record<LookField, string>),
  };
}
const copy = (d: Loadout) => ({ ...d, stats: { ...d.stats } });
const same = (a: Loadout | null, b: Loadout | null) =>
  Boolean(a && b) &&
  (["avatar", "color", "hat", "pet", ...LOOK_FIELDS] satisfies (keyof Loadout)[]).every((f) => a![f] === b![f]) && // a!, b!: Boolean(a && b) above
  STATS.every((k) => (a!.stats?.[k] || 0) === (b!.stats?.[k] || 0)); // a!, b!: Boolean(a && b) above
const current = () => ({ ...copy(state.d), build: state.slot });
const activeBuild = () => state.profile?.build || 0;
const savedSlot = () => (state.builds[state.slot] ? loadoutOf(state.builds[state.slot]) : null);
const dirty = () => Boolean(state.profile) && (state.slot !== activeBuild() || !same(state.d, savedSlot()));
// Edits that leaving the page would lose, in any build. Only looking at another saved build loses nothing.
const unsavedIn = (d: Loadout, slot: number) => !same(d, state.builds[slot] ? loadoutOf(state.builds[slot]) : null);
const edited = () =>
  Boolean(state.profile) &&
  (unsavedIn(state.d, state.slot) || state.drafts.some((d, i) => d && i !== state.slot && unsavedIn(d, i)));
const petById = (id: string) => state.shop?.pets.find((x) => x.id === id) || null;
const entryOf = (id: string | undefined) => state.catalog.find((x) => x.id === id) || null;
const looks = (d = state.d) => Object.fromEntries(LOOK_FIELDS.map((f) => [f, d[f]]));
const boostText = (b: Partial<Stats> | undefined) =>
  b?.power && b.power === b.guard && b.power === b.luck
    ? "+" + b.power + " to all stats"
    : STATS.filter((k) => b?.[k])
        .map((k) => "+" + b![k] + " " + k) // b!: filter() kept only stats b has
        .join(", ");
const TIER_NAMES: Record<string, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};
const canShop = () => Boolean(state.session?.user && state.profile) && !state.off;
const signedIn = () => Boolean(state.session?.user);
const money = (n: number | undefined) => "$" + (n || 0);

// What the fighter owns: hats unlocked by wins count as owned, and "none" always is.
function owns(kind: ItemKind, id: string) {
  if (!id) return true;
  if (kind === "hat") return rules().hats.some((x) => x.id === id && x.unlocked) || state.owned.hats.includes(id);
  if (kind === "pet") return state.owned.pets.includes(id);
  return (state.owned[kind] || []).includes(id);
}
const itemLabel = (kind: ItemKind, id: string) =>
  kind === "hat"
    ? (rules().hats.find((x) => x.id === id)?.label || id) + " hat"
    : kind === "pet"
      ? petById(id)?.label || id
      : state.shop?.items?.[kind]?.find((x) => x.id === id)?.label || id;
// Worn items the fighter doesn't own yet (tried on): saving needs them bought first.
function lockedWorn() {
  const out: [ItemKind, string][] = [];
  if (!owns("hat", state.d.hat)) out.push(["hat", state.d.hat]);
  if (!owns("pet", state.d.pet)) out.push(["pet", state.d.pet]);
  // as: Object.entries types its keys as string; they are the KINDS keys
  for (const [kind, k] of Object.entries(KINDS) as [KindKey, Kind][])
    if (!owns(kind, state.d[k.field])) out.push([kind, state.d[k.field]]);
  return out;
}

// ---------- tabs ----------
const TABS = ["fighter", "shop", "pets", "ranks", "rules"];
const HASH_TAB: Record<string, string> = {
  fighter: "fighter",
  upgrades: "fighter",
  builds: "fighter",
  shop: "shop",
  hats: "shop",
  "hat-picker": "shop",
  pets: "pets",
  "pet-color": "pets",
  ranks: "ranks",
  leaderboard: "ranks",
  rules: "rules",
  duels: "rules",
};
const tabOf = (hash: string) =>
  HASH_TAB[hash] || document.getElementById(hash)?.closest("[role=tabpanel]")?.id.replace("panel-", "") || null;
function showTab(
  name: string,
  // hash may be undefined: the default then applies, as in the .js
  { focus = false, hash = name, scroll = true }: { focus?: boolean; hash?: string | undefined; scroll?: boolean } = {},
) {
  document.documentElement.dataset.tab = name;
  tuckSaveBar();
  for (const t of TABS) {
    const tab = $("#tab-" + t) as HTMLButtonElement, // element type from the page HTML
      on = t === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    ($("#panel-" + t) as HTMLDivElement).hidden = !on; // element type from the page HTML
  }
  if (focus) ($("#tab-" + name) as HTMLButtonElement).focus(); // element type from the page HTML
  const part = name === "shop" && showShopPart(hash);
  requestAnimationFrame(() => {
    voxAll?.();
    document.dispatchEvent(new Event("pixfray:tab"));
  });
  if (location.hash.slice(1) !== hash) history.replaceState(null, "", location.pathname + location.search + "#" + hash);
  if (!scroll) return;
  // A section link scrolls to its section; a plain tab switch keeps the tabs in view (under the sticky stage on phones).
  const target = hash !== name && !part && document.getElementById(hash);
  const el = target && target.closest("[role=tabpanel]") ? target : ($(".hero-pick .tabs") as HTMLDivElement); // element type from the page HTML
  if (el.getBoundingClientRect().top < stickyHeight() || target) el.scrollIntoView({ block: "start" });
}
const stickyHeight = () =>
  // element types from the page HTML (an aside)
  getComputedStyle($(".hero-card") as HTMLElement).position === "sticky" && matchMedia("(max-width: 900px)").matches
    ? ($(".hero-card") as HTMLElement).offsetHeight // element type from the page HTML (an aside)
    : 0;
// element type from the page HTML
($(".hero-pick .tabs") as HTMLDivElement).addEventListener("click", (e) => {
  // as Element: a click's target is an element
  const t = (e.target as Element).closest("[role=tab]");
  if (t) showTab(t.id.replace("tab-", ""));
});
// element type from the page HTML
($(".hero-pick .tabs") as HTMLDivElement).addEventListener("keydown", (e) => {
  // as string: indexOf finds no undefined, as in the .js
  const i = TABS.indexOf(document.activeElement?.id?.replace("tab-", "") as string);
  if (i < 0) return;
  // as: the key may be any name; the others read as undefined, as in the .js
  const next = (
    { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 } as Record<string, number | undefined>
  )[e.key];
  if (next === undefined) return;
  e.preventDefault();
  showTab(TABS[(next + TABS.length) % TABS.length]!, { focus: true }); // !: the index is taken modulo TABS.length
});
// In-page links (#duels, #upgrades, …) open their tab first.
document.addEventListener("click", (e) => {
  const a = (e.target as Element).closest("a[href^='#']"); // as Element: a click's target is an element
  const hash = a?.getAttribute("href")!.slice(1), // !: the selector matched a[href^='#'], so it has an href
    tab = hash && tabOf(hash);
  if (!tab || ($("#fighter") as HTMLElement).hidden) return; // element type from the page HTML (a main)
  e.preventDefault();
  showTab(tab, { hash });
});
addEventListener("hashchange", () => {
  const hash = location.hash.slice(1),
    tab = tabOf(hash);
  if (tab) showTab(tab, { hash });
});
// On phones the stage sticks to the top, so focused fields and section jumps scroll clear of it.
// ...and when the preview is compact the tabs stick under it, so the padding covers both.
new ResizeObserver(() => {
  const root = document.documentElement,
    card = stickyHeight(),
    // element type from the page HTML
    tabs = root.classList.contains("compact") && card ? ($(".hero-pick .tabs") as HTMLDivElement).offsetHeight : 0;
  root.style.setProperty("--stuck-h", card + "px");
  root.style.scrollPaddingTop = card + tabs + 16 + "px";
}).observe($(".hero-card") as HTMLElement); // element type from the page HTML (an aside)

// The shop shows one section at a time: its section links act as sub-tabs, so the panel stays one screen long.
const shopLinks = [...document.querySelectorAll<HTMLAnchorElement>(".jump a")],
  // !: every .jump link in the page HTML has an href
  shopParts = shopLinks.map((a) => document.getElementById(a.getAttribute("href")!.slice(1)));
function showShopPart(id: string | null) {
  const target = id && document.getElementById(id),
    i = shopParts.findIndex((el) => el && target && el.contains(target));
  if (i < 0 && id) return false; // a plain tab switch keeps the section picked earlier
  shopParts.forEach((el, j) => {
    el!.hidden = j !== Math.max(0, i); // el!: each .jump link names a section in the page HTML (a missing one throws, as in the .js)
  });
  shopLinks.forEach((a, j) => a.toggleAttribute("aria-current", j === Math.max(0, i)));
  return i >= 0;
}
showShopPart(null);

// ---------- shop ----------
// The first click on a Buy button asks to confirm, the second spends the dollars. A bought item is worn right away;
// Save brings it on stream. A bought build slot opens as a copy of the build being edited.
async function buy(
  kind: BuyKind,
  item: string,
  label: string,
  price: number,
  btn: HTMLButtonElement,
  out: Element,
  text = "Buy for $" + price,
) {
  if (btn.dataset.confirm !== "1") {
    btn.dataset.confirm = "1";
    btn.textContent = "Confirm: spend $" + price;
    setTimeout(() => {
      if (btn.isConnected && btn.dataset.confirm === "1") {
        btn.dataset.confirm = "";
        btn.textContent = text;
      }
    }, 6000);
    return;
  }
  btn.disabled = true;
  setStatus(out, "Buying…");
  const r = await api("/api/shop/" + CHANNEL, { method: "POST", body: { kind, id: item, price } });
  if (r.data?.error === "price_changed") {
    // A mod changed the price after this page loaded: show the new prices and let the viewer decide again.
    const shop = await api("/api/shop/" + CHANNEL);
    if (shop.ok && Array.isArray(shop.data?.pets)) state.shop = shop.data;
    renderAll();
    setStatus(out, "Not bought: the price changed to $" + r.data.price + ". Check it and buy again.", "error");
    return;
  }
  if (r.status === 401) {
    btn.disabled = false;
    btn.dataset.confirm = "";
    btn.textContent = text;
    state.session = { ...state.session, user: null };
    renderSignedIn();
    setStatus(out, "Not bought: your session expired. Sign in again to buy.", "error");
    return;
  }
  if (!r.ok) {
    btn.disabled = false;
    btn.dataset.confirm = "";
    btn.textContent = text;
    setStatus(out, "Not bought: " + (REASONS[r.data?.error] || errorText(r)), "error");
    return;
  }
  // as Profile: only a fighter with a profile can buy (canShop), so the spread copies one
  state.profile = { ...state.profile, dollars: r.data.dollars } as Profile;
  state.owned = { ...emptyOwned(), ...(r.data.owned || state.owned) };
  if (kind === "slot") {
    switchBuild(state.owned.slots - 1, copy(state.d));
  } else if (kind === "pet") state.d.pet = item;
  else if (kind === "hat") state.d.hat = item;
  else state.d[KINDS[kind].field] = item;
  renderAll();
  setStatus(
    out,
    kind === "slot"
      ? "Bought build " +
          state.owned.slots +
          " for $" +
          price +
          ". It starts as a copy; change it and save to put it on stream."
      : "Bought " + label + " for $" + price + ". Save your fighter to bring it on stream.",
    "ok",
  );
}
const buyButton = (
  kind: BuyKind,
  item: string,
  label: string,
  price: number,
  out: Element,
  text = "Buy for $" + price,
) => {
  const have = state.profile?.dollars || 0,
    short = canShop() && have < price;
  // Out of reach: say how far, so the affordable items are the only gold buttons
  return h(
    "button",
    {
      type: "button",
      class: "btn btn-small buy" + (short ? " short" : ""),
      disabled: !canShop() || short,
      title: short ? "Costs $" + price + "; you have $" + have : null,
      "aria-label": "Buy " + label + " for $" + price + (short ? ", you need $" + (price - have) + " more" : ""),
      // as: the handler sits on this button
      onclick: (e: MouseEvent) => buy(kind, item, label, price, e.currentTarget as HTMLButtonElement, out, text),
    },
    short
      ? (kind === "slot" ? "Build " + label.split(" ").pop() + ": need $" : "Need $") + (price - have) + " more"
      : text,
  );
};
// One picker tile: a radio (name = kind) with its picture and words, plus a Buy button while it isn't owned.
// Anything can be picked to try it on in the preview; Save asks for the unowned ones to be bought first.
function tile({
  kind,
  id,
  label,
  visual,
  tag,
  tier,
  price,
  buyLabel,
  out,
  onPick,
}: {
  kind: ItemKind;
  id: string;
  label: string;
  visual: Node | null;
  tag?: string | null;
  tier?: string | undefined;
  price?: number | undefined;
  buyLabel?: string;
  out: Element;
  onPick: (id: string) => void;
}) {
  const inputId = kind + "-" + (id || "none"),
    have = owns(kind, id);
  const input = h("input", { type: "radio", name: kind, id: inputId, value: id });
  input.addEventListener("change", () => {
    onPick(id);
    tryOnNote(kind, id, out);
    renderPreview();
    renderSave();
  });
  // Signed out, nothing can be bought yet, so the price is a quiet line instead of a row of disabled Buy buttons.
  // as number: a free item has no price, and undefined > 0 is false, as in the .js
  const quiet = !have && (price as number) > 0 && !signedIn(),
    note =
      tag || quiet
        ? [tag, quiet ? h("b", { class: "price" }, (tag && kind === "hat" ? "or " : "") + money(price)) : ""].filter(
            Boolean,
          )
        : null;
  const option = h(
    "div",
    { class: "char-option" + (have ? "" : " locked") + (tier ? " tier-" + tier : "") },
    input,
    h(
      "label",
      { for: inputId },
      visual,
      h("span", {}, label),
      note
        ? h("span", { class: "tag" }, ...note)
        : id && have
          ? h("span", { class: "tag" }, signedIn() && (price as number) > 0 ? "Owned" : "Free") // as: undefined > 0 is false
          : null,
    ),
    // as number: undefined > 0 is false, so buyButton gets a price
    !have && (price as number) > 0 && !quiet ? buyButton(kind, id, buyLabel || label, price as number, out) : null,
  );
  const field =
    kind === "hat" || kind === "pet"
      ? kind
      : KINDS[kind]?.look === "char" || KINDS[kind]?.look === "pet"
        ? KINDS[kind].field
        : null;
  if (field) peekOn(option, field, id);
  return option;
}
function tryOnNote(kind: ItemKind, id: string, out: Element) {
  if (owns(kind, id)) {
    setStatus(out, "");
    return;
  }
  setStatus(
    out,
    "Trying on " +
      itemLabel(kind, id) +
      " in the preview. " +
      (canShop()
        ? "Buy it to wear it on stream."
        : signedIn()
          ? "Save your fighter, then buy it to wear it."
          : "Sign in to buy it."),
  );
}
const checkPicked = (box: Element, kind: string, value: string) => {
  const r = box.querySelector<HTMLInputElement>("input[value='" + CSS.escape(value) + "']");
  if (r) r.checked = true;
  else
    box.querySelectorAll("input").forEach((x) => {
      x.checked = false;
    });
};

// Thumbnails that show the picked character wearing an item; they follow the character as it changes.
const lookSprites: SpriteHandle[] & { entry?: CatalogEntry | null } = [];
const lookVox: [HTMLCanvasElement, () => Look | null][] = [];
// a pet on its own, as voxels, beside its flat sprite
const petThumb = (canvas: HTMLCanvasElement, pet: ShopPet, color: string) => {
  const v = voxCanvas();
  vox(v, () => {
    const l = composeLook(entryOf(state.d.avatar), { pet, looks: { petColor: color } });
    // as Look: voxThumb draws only key, body and frameH, so the pet picture needs no pet of its own
    return l?.pet ? ({ key: "pet:" + l.key, body: l.pet, frameH: l.petH } as Look) : null;
  });
  return h("span", { class: "thumb" }, v, canvas);
};
const charThumb = (opts: { hat?: string; looks?: Record<string, string> }) => {
  const canvas = h("canvas", { class: "sprite", width: 48, height: 48, "aria-hidden": "true" }),
    v = voxCanvas();
  const s = addSprite(canvas, entryOf(state.d.avatar), { active: () => false, ...opts });
  lookSprites.push(s);
  const make = () => composeLook(entryOf(state.d.avatar), opts);
  lookVox.push([v, make]);
  vox(v, make);
  return h("span", { class: "thumb" }, v, canvas);
};

function renderHats() {
  const r = rules(),
    box = $("#hats") as HTMLDivElement, // element type from the page HTML
    out = $("#hat-status") as HTMLParagraphElement; // element type from the page HTML
  box.replaceChildren(
    ...r.hats.map((hat) => {
      const price = (state.shop?.hatPricePerWin || 0) * hat.wins,
        have = owns("hat", hat.id);
      return tile({
        kind: "hat",
        id: hat.id,
        label: hat.label,
        visual: charThumb({ hat: hat.id }),
        price,
        buyLabel: hat.label + " hat",
        out,
        tag: have ? null : "Free at " + hat.wins + (hat.wins === 1 ? " win" : " wins"),
        onPick: (id) => {
          state.d.hat = id;
        },
      });
    }),
  );
  checkPicked(box, "hat", state.d.hat);
  const locked = r.hats.filter((x) => !owns("hat", x.id)).length;
  ($("#hat-note") as HTMLSpanElement).textContent = locked // element type from the page HTML
    ? "(" + locked + (state.shop?.hatPricePerWin ? " unlock with wins or dollars)" : " unlock with wins)")
    : "";
}

function renderItems(kind: KindKey) {
  const k: Kind = KINDS[kind],
    box = $("#items-" + kind) as HTMLDivElement, // element type from the page HTML
    out = $("#status-" + kind) as HTMLParagraphElement, // element type from the page HTML
    list = state.shop?.items?.[kind];
  if (!list) {
    box.replaceChildren(
      h(
        "p",
        { class: "muted small" },
        state.loading ? "Loading the shop…" : "The shop couldn't load. Reload to try again.",
      ),
    );
    return;
  }
  const pet = petById(state.d.pet) || state.shop!.pets[0]; // state.shop!: list came from it
  const visual = (id: string) => {
    if (k.look === "char") return charThumb({ looks: { [k.field]: id } });
    if (k.look === "pet") {
      const c = h("canvas", { class: "sprite", width: 48, height: 48, "aria-hidden": "true" });
      if (pet) addPet(c, pet, { color: id });
      return pet ? petThumb(c, pet, id) : c;
    }
    if (k.look === "sample") {
      const c = h("canvas", { class: "sprite sample", width: 64, height: 48, "aria-hidden": "true" });
      if (id) addCosmeticSample(c, kind, id);
      return c;
    }
    return null;
  };
  const text = (item: ShopItem) => (kind === "taunt" ? "“" + item.label + "”" : item.label);
  box.replaceChildren(
    tile({
      kind,
      id: "",
      label: k.none,
      visual: visual(""),
      out,
      onPick: (id) => {
        state.d[k.field] = id;
      },
    }),
    ...list.map((item) =>
      tile({
        kind,
        id: item.id,
        label: text(item),
        visual: visual(item.id),
        price: item.price,
        buyLabel: item.label + (kind === "accessory" || kind === "trail" || kind === "effect" ? "" : " " + k.noun),
        out,
        onPick: (id) => {
          state.d[k.field] = id;
          if (kind === "petcolor") renderPets();
          if ((kind === "effect" || kind === "taunt") && id) playWin();
        },
      }),
    ),
  );
  if (kind === "title")
    box.querySelectorAll(".char-option label > span:first-of-type").forEach((s) => s.classList.add("title-text"));
  checkPicked(box, kind, state.d[k.field]);
  const have = state.owned[kind]?.length || 0;
  ($("#note-" + kind) as HTMLSpanElement).textContent = list[0]?.price // element type from the page HTML
    ? "(" + money(list[0].price) + " each" + (canShop() ? ", you own " + have : "") + ")"
    : "";
}

// Pets: tier, boost and price; a bought pet adds to the stats on top of the upgrade limit.
function renderPets() {
  const box = $("#pet-list") as HTMLDivElement, // element type from the page HTML
    out = $("#pet-status") as HTMLParagraphElement; // element type from the page HTML
  if (!state.shop) {
    box.replaceChildren(
      h("p", { class: "muted small" }, state.loading ? "Loading pets…" : "Pets couldn't load. Reload to try again."),
    );
    return;
  }
  const option = (pet: ShopPet | null) => {
    const canvas = h("canvas", { class: "sprite", width: 48, height: 48, "aria-hidden": "true" });
    if (pet) addPet(canvas, pet, { color: state.d.petColor });
    return tile({
      kind: "pet",
      id: pet?.id || "",
      label: pet ? pet.label : "No pet",
      visual: pet
        ? petThumb(canvas, pet, state.d.petColor)
        : h("span", { class: "thumb empty-slot", "aria-hidden": "true" }),
      price: pet?.price,
      out,
      tag: pet ? TIER_NAMES[pet.tier] + ", " + boostText(pet.boost) : null,
      tier: pet?.tier,
      onPick: (id) => {
        state.d.pet = id;
        renderUpgrades();
        renderItems("petcolor");
      },
    });
  };
  box.replaceChildren(option(null), ...state.shop.pets.map(option));
  checkPicked(box, "pet", state.d.pet);
  ($("#pet-note") as HTMLSpanElement).textContent = canShop() // element type from the page HTML
    ? "(you own " + state.owned.pets.length + ", you have " + money(state.profile!.dollars) + ")" // profile!: canShop() needs one
    : "";
  // element type from the page HTML
  ($("#petcolor-help") as HTMLParagraphElement).textContent = petById(state.d.pet)
    ? "Tints your pet on stream."
    : "Tints your pet on stream. The samples show a " + (state.shop.pets[0]?.label || "pet") + " until you pick one.";
}

// ---------- fighter tab ----------
// Builds: one free slot, more for dollars. Each keeps its own loadout; saving one puts it on stream.
function switchBuild(slot: number, start: Loadout | null = null) {
  state.drafts[state.slot] = copy(state.d);
  state.slot = slot;
  state.d = state.drafts[slot] || start || (state.builds[slot] ? loadoutOf(state.builds[slot]) : copy(state.d));
  if (start) state.drafts[slot] = state.d;
}
function renderBuilds() {
  const box = $("#builds") as HTMLFieldSetElement, // element type from the page HTML
    list = $("#build-list") as HTMLDivElement, // element type from the page HTML
    slots = state.owned.slots || 1,
    prices = state.shop?.slots?.prices || [];
  box.hidden = !canShop();
  if (box.hidden) return;
  const price = slots < (state.shop?.slots?.max || 5) ? prices[slots - 1] : null;
  list.replaceChildren(
    ...Array.from({ length: slots }, (_, i) => {
      const b = state.builds[i],
        entry = entryOf(b?.avatar),
        on = i === activeBuild();
      return h(
        "button",
        {
          type: "button",
          class: "build",
          "aria-pressed": String(i === state.slot),
          onclick: () => {
            if (i !== state.slot) {
              switchBuild(i);
              renderAll();
            }
          },
        },
        h("strong", {}, "Build " + (i + 1)),
        h("span", { class: "muted small" }, on ? "On stream" : b ? entry?.label || b.avatar : "Not saved yet"),
      );
    }),
    ...(price
      ? [
          buyButton(
            "slot",
            "",
            "build slot " + (slots + 1),
            price,
            $("#status-slot") as HTMLParagraphElement, // element type from the page HTML
            "Add build " + (slots + 1) + " for $" + price,
          ),
        ]
      : []),
  );
  // element type from the page HTML
  ($("#build-note") as HTMLSpanElement).textContent = "(" + slots + " of " + (state.shop?.slots?.max || 5) + ")";
}

function renderUpgrades() {
  const r = rules(),
    list = $("#upgrade-list") as HTMLDivElement, // element type from the page HTML
    canEdit = canShop();
  const used = r.stats.reduce((sum, k) => sum + state.d.stats[k], 0),
    left = r.points - used;
  // element type from the page HTML
  ($("#points-note") as HTMLSpanElement).textContent = canEdit ? "(" + left + " of " + r.points + " points free)" : "";
  const from = r.fromCheckins
    ? " You have " + r.fromWins + " from wins and " + r.fromCheckins + " from check-ins."
    : "";
  ($("#upgrades-help") as HTMLParagraphElement).textContent = canEdit // element type from the page HTML
    ? "Each win and each stream check-in (!checkin in chat) gives a point, up to " +
      r.maxPoints +
      "." +
      from +
      " Move points between stats whenever you're not in a duel."
    : "Save your fighter, then each win and each stream check-in (!checkin in chat) gives an upgrade point, up to " +
      r.maxPoints +
      ".";
  const shown = canEdit ? state.d.stats : { power: 0, guard: 0, luck: 0 };
  const link = $("#points-link") as HTMLAnchorElement; // element type from the page HTML
  link.hidden = !canEdit || left <= 0;
  link.textContent = left + (left === 1 ? " upgrade point" : " upgrade points") + " to spend";
  list.replaceChildren(
    ...r.stats.map((k) => {
      const t = STAT_TEXT[k],
        n = shown[k],
        extra = petById(state.d.pet)?.boost?.[k] || 0,
        total = n + extra;
      const step = (d: number) => () => {
        state.d.stats[k] += d;
        renderUpgrades();
        renderSave();
      };
      // The plain effect of everything the fighter has in this stat, pet included.
      const effect = total
        ? t.effect(total) + (extra ? " (" + extra + " from your pet)" : "")
        : t.effect(1) + " per point";
      return h(
        "div",
        { class: "upgrade" },
        h(
          "div",
          { class: "upgrade-name" },
          h("strong", {}, t.label),
          h("span", { class: "muted small" }, effect),
          // a segmented meter: one cell per point, the pet's bonus in a lighter tone after them
          h(
            "span",
            { class: "meter", "aria-hidden": "true" },
            ...Array.from({ length: Math.max(r.maxPerStat, total) }, (_, i) =>
              h("i", { class: i < n ? "on" : i < total ? "pet" : "" }),
            ),
          ),
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-small",
            "aria-label": "Take a point out of " + t.label,
            disabled: !canEdit || n <= 0,
            onclick: step(-1),
          },
          "−",
        ),
        h(
          "span",
          { class: "upgrade-value num", title: extra ? "+" + extra + " from your pet" : null },
          n + " / " + r.maxPerStat + (extra ? " +" + extra : ""),
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-small",
            "aria-label": "Put a point into " + t.label,
            disabled: !canEdit || left <= 0 || n >= r.maxPerStat,
            onclick: step(1),
          },
          "+",
        ),
      );
    }),
  );
}

// Characters: search by name, filter by group; unfiltered, the list starts with 12 (plus the picked one).
const groupsOf = (entry: CatalogEntry) =>
  entry.custom ? ["custom"] : CHARACTER_GROUPS.filter((g) => g.ids.includes(entry.id)).map((g) => g.id);
// A viewer's approved sprite (server/sprites.ts) is only for them; state.catalog keeps everyone's for the ranks.
const pickable = () => state.catalog.filter((e) => !e.owner || e.owner === state.session?.user?.id);
function renderCharacters() {
  const box = $("#characters") as HTMLDivElement, // element type from the page HTML
    list = pickable();
  if (!list.length) {
    box.replaceChildren(
      h("p", { class: "muted small" }, "No characters are available right now. Reload to try again."),
    );
    return;
  }
  ($("#char-count") as HTMLSpanElement).textContent = "(" + list.length + " available)"; // element type from the page HTML
  const groups = [
    { id: "all", label: "All" },
    ...CHARACTER_GROUPS.filter((g) => list.some((e) => groupsOf(e).includes(g.id))),
    ...(list.some((e) => e.custom) ? [{ id: "custom", label: "Channel originals" }] : []),
  ];
  // element type from the page HTML
  ($("#char-groups") as HTMLDivElement).replaceChildren(
    ...groups.map((g) =>
      h(
        "button",
        {
          type: "button",
          class: "btn btn-small",
          "data-group": g.id,
          "aria-pressed": String(g.id === state.filter.group),
          onclick: () => {
            state.filter.group = g.id;
            filterCharacters();
          },
        },
        g.label,
      ),
    ),
  );
  box.replaceChildren(
    ...list.map((entry) => {
      const id = "char-" + entry.id;
      const input = h("input", { type: "radio", name: "character", id, value: entry.id });
      input.addEventListener("change", () => {
        state.d.avatar = entry.id;
        renderPreview();
        renderSave();
      });
      const canvas = h("canvas", { class: "sprite", width: 64, height: 64, "aria-hidden": "true" }),
        v = voxCanvas();
      vox(v, () => composeLook(entry));
      const option = h(
        "div",
        {
          class: "char-option",
          "data-groups": groupsOf(entry).join(" "),
          "data-name": (entry.label || entry.id).toLowerCase() + " " + entry.id,
        },
        input,
        h(
          "label",
          { for: id },
          h("span", { class: "thumb" }, v, canvas),
          h("span", {}, entry.label || entry.id),
          entry.owner
            ? h("span", { class: "tag" }, "Your sprite")
            : entry.custom
              ? h("span", { class: "tag" }, "Channel original")
              : null,
        ),
      );
      let hover = false;
      option.addEventListener("pointerenter", () => {
        hover = true;
      });
      option.addEventListener("pointerleave", () => {
        hover = false;
      });
      peekOn(option, "avatar", entry.id);
      addSprite(canvas, entry, {
        anim: "walk",
        active: () => hover || input.checked || document.activeElement === input,
      });
      return option;
    }),
  );
  filterCharacters();
}
function filterCharacters() {
  const q = state.filter.q.trim().toLowerCase(),
    g = state.filter.group,
    filtered = Boolean(q) || g !== "all";
  let shown = 0;
  // element type from the page HTML; the grid's children are HTML elements (tiles, or the empty note)
  for (const option of ($("#characters") as HTMLDivElement).children as HTMLCollectionOf<HTMLElement>) {
    const match =
      (!q || option.dataset.name?.includes(q)) && (g === "all" || option.dataset.groups?.split(" ").includes(g));
    option.hidden = !match;
    if (match) shown++;
  }
  // element type from the page HTML; the group row holds only buttons
  for (const b of ($("#char-groups") as HTMLDivElement).children as HTMLCollectionOf<HTMLButtonElement>)
    b.setAttribute("aria-pressed", String(b.dataset.group === g));
  ($("#char-empty") as HTMLParagraphElement).hidden = shown > 0; // element type from the page HTML
  // element types from the page HTML
  ($("#more-chars") as HTMLButtonElement).hidden =
    filtered || ($("#characters") as HTMLDivElement).children.length <= 12; // element type from the page HTML
  if (filtered) ($("#characters") as HTMLDivElement).classList.remove("collapsed"); // element type from the page HTML
  else showAllChars(($("#more-chars") as HTMLButtonElement).getAttribute("aria-expanded") === "true"); // element type from the page HTML
}
// element type from the page HTML
($("#char-search") as HTMLInputElement).addEventListener("input", (e) => {
  // as: the input event's target is that input
  state.filter.q = (e.target as HTMLInputElement).value;
  filterCharacters();
});
function showAllChars(all: boolean) {
  const btn = $("#more-chars") as HTMLButtonElement; // element type from the page HTML
  ($("#characters") as HTMLDivElement).classList.toggle("collapsed", !all); // element type from the page HTML
  btn.setAttribute("aria-expanded", String(all));
  btn.textContent = all
    ? "Show fewer characters"
    : "Show all " + ($("#characters") as HTMLDivElement).children.length + " characters"; // element type from the page HTML
}
// element types from the page HTML
($("#more-chars") as HTMLButtonElement).addEventListener(
  "click",
  () => showAllChars(($("#characters") as HTMLDivElement).classList.contains("collapsed")), // element type from the page HTML
);

function renderSwatches() {
  const box = $("#swatches") as HTMLDivElement; // element type from the page HTML
  box.querySelectorAll(".swatch").forEach((n) => n.remove());
  for (const color of SWATCHES) {
    box.insertBefore(
      h("button", {
        type: "button",
        class: "swatch",
        style: { background: color },
        "aria-label": "Nameplate color " + color,
        "aria-pressed": "false",
        "data-color": color,
        onclick: () => {
          state.d.color = color;
          colorInput.value = color;
          renderPreview();
          renderSave();
        },
      }),
      box.querySelector(".custom-color"),
    );
  }
}
colorInput.addEventListener("input", () => {
  state.d.color = colorInput.value.toLowerCase();
  renderPreview();
  renderSave();
});

// ---------- preview and save ----------
function renderPreview() {
  const d = state.d,
    entry = entryOf(d.avatar),
    user = state.session?.user;
  stage.set({
    entry,
    hat: d.hat,
    pet: petById(d.pet),
    color: d.color,
    name: user?.displayName || user?.login || "you",
    elo: state.profile?.elo ?? state.config?.initialElo ?? 1000,
    looks: looks(d),
  });
  render3d();
  const plate = $("#showcase-plate") as HTMLSpanElement; // element type from the page HTML
  plate.textContent =
    (user?.displayName || user?.login || "you") + " · " + (state.profile?.elo ?? state.config?.initialElo ?? 1000);
  plate.style.setProperty("--plate", d.color);
  if (lookSprites.entry !== entry) {
    lookSprites.entry = entry;
    for (const s of lookSprites) s.set(entry);
    for (const [v, make] of lookVox) if (v.isConnected) vox(v, make);
  }
  for (const s of document.querySelectorAll<HTMLButtonElement>(".swatch"))
    s.setAttribute("aria-pressed", String(s.dataset.color === d.color));
  colorInput.value = d.color;
  const several = (state.owned.slots || 1) > 1;
  // element type from the page HTML
  ($("#preview-caption") as HTMLSpanElement).textContent =
    (entry ? entry.label || entry.id : "") + (several ? " · Build " + (state.slot + 1) : "");
  const words = [
    entry?.label,
    d.hat && itemLabel("hat", d.hat),
    d.accessory && itemLabel("accessory", d.accessory),
    d.recolor && itemLabel("recolor", d.recolor) + " colors",
    d.pet && "with " + itemLabel("pet", d.pet),
    d.trail && itemLabel("trail", d.trail) + " trail",
    d.title && "title " + itemLabel("title", d.title),
  ].filter(Boolean);
  // element type from the page HTML
  ($("#preview") as HTMLCanvasElement).setAttribute(
    "aria-label",
    "Preview of your fighter on stream: " + (words.join(", ") || "no character yet"),
  );
  ($("#play-win") as HTMLButtonElement).disabled = !d.winEffect && !d.taunt; // element type from the page HTML
  // element types from the page HTML
  ($("#play-win") as HTMLButtonElement).hidden = ($("#play-win") as HTMLButtonElement).disabled; // nothing to preview yet: point to the Shop instead
  ($("#win-link") as HTMLAnchorElement).hidden = !($("#play-win") as HTMLButtonElement).disabled; // element types from the page HTML
  renderLoadout();
}
// on phones the on-stream strip is tucked over the 3D stage and only shows while a win plays
let playing = 0;
function playWin() {
  stage.play();
  const fig = $(".hero-card .preview") as HTMLElement; // element type from the page HTML (a figure)
  fig.classList.add("is-playing");
  clearTimeout(playing);
  playing = setTimeout(() => fig.classList.remove("is-playing"), 4500);
}
($("#play-win") as HTMLButtonElement).addEventListener("click", playWin); // element type from the page HTML
// Desktop: what the fighter is wearing, under the preview. Items only tried on show their price; the total is what buying the look costs.
const priceOf = (kind: ItemKind, id: string) =>
  kind === "hat"
    ? (state.shop?.hatPricePerWin || 0) * (rules().hats.find((x) => x.id === id)?.wins || 0)
    : kind === "pet"
      ? petById(id)?.price || 0
      : state.shop?.items?.[kind]?.find((x) => x.id === id)?.price || 0;
const EMPTY_AT: Partial<Record<ItemKind, string>> = {
  hat: "hats",
  pet: "pets",
  accessory: "shop-accessory",
  trail: "shop-trail",
  effect: "win-effects",
  title: "shop-title",
};
const EMPTY_LABEL: Partial<Record<ItemKind, string>> = {
  hat: "Add a hat",
  accessory: "Add an accessory",
  pet: "Add a pet",
  trail: "Add a trail",
  effect: "Add a win effect",
  title: "Add a title",
};
function renderLoadout() {
  const box = $("#loadout") as HTMLDListElement | null; // element type from the page HTML, if the page has it
  if (!box) return;
  const d = state.d,
    entry = entryOf(d.avatar),
    name = (kind: ItemKind, id: string) =>
      kind === "hat" ? itemLabel("hat", id).replace(/ hat$/, "") : itemLabel(kind, id);
  const rows: [string, ItemKind | null, string][] = [
    ["Character", null, d.avatar],
    ["Colors", "recolor", d.recolor],
    ["Hat", "hat", d.hat],
    ["Accessory", "accessory", d.accessory],
    ["Pet", "pet", d.pet],
    ["Trail", "trail", d.trail],
    ["Win effect", "effect", d.winEffect],
    ["Title", "title", d.title],
  ];
  let total = 0;
  box.replaceChildren(
    ...rows.flatMap(([label, kind, id]) => {
      const value = !kind
        ? entry?.label || entry?.id || "None"
        : id
          ? name(kind, id)
          : kind === "recolor"
            ? "Original"
            : "None";
      const price = kind && id && !owns(kind, id) ? priceOf(kind, id) : 0;
      total += price;
      // an empty slot links to where it's filled, instead of reading "None"
      if (kind && kind !== "recolor" && !id)
        return [
          h("dt", {}, label),
          h("dd", {}, h("a", { class: "slot-empty", href: "#" + (EMPTY_AT[kind] || "shop") }, EMPTY_LABEL[kind])),
        ];
      return [
        h("dt", {}, label),
        h(
          "dd",
          { class: id ? null : "muted" },
          value,
          price ? h("span", { class: "badge" }, "Try-on " + money(price)) : "",
        ),
      ];
    }),
  );
  const t = $("#loadout-total") as HTMLParagraphElement; // element type from the page HTML
  t.hidden = !total;
  t.textContent = total ? "Buying this look costs " + money(total) + ". Duels earn PixFray dollars." : "";
}

function renderSave() {
  saveBtn.disabled = Boolean(state.off);
  if (signedIn() && state.off === "paused") {
    setStatus(
      status,
      state.profile
        ? "PixFray is off on this channel right now, so saving and buying are closed. Your fighter is kept."
        : "PixFray is off on this channel right now. You can save a fighter when it's back.",
    );
  } else if (signedIn() && state.profile) {
    const locked = lockedWorn();
    const msg = locked.length
      ? "Trying on " +
        locked.map(([k, id]) => itemLabel(k, id)).join(", ") +
        ". Buy " +
        (locked.length === 1 ? "it" : "them") +
        " to save this look."
      : state.slot !== activeBuild()
        ? "Build " + (state.slot + 1) + " isn't on stream. Save to switch to it."
        : dirty()
          ? "You have unsaved changes."
          : fresh()
            ? ""
            : "Saved. Your fighter shows up on stream with these settings.";
    setStatus(status, msg, locked.length || dirty() ? "" : "ok");
  } else if (signedIn()) {
    const locked = lockedWorn();
    if (!locked.length && state.others.length)
      setStatus(status, "You don't have a fighter on " + CHANNEL + "'s channel yet. Fighters are saved per channel.");
    else
      setStatus(
        status,
        locked.length
          ? "Trying on " + locked.map(([k, id]) => itemLabel(k, id)).join(", ") + ". Save a fighter first, then buy it."
          : "You don't have a saved profile yet. Pick your fighter and save.",
      );
  } else if (knownViewer() && !status.textContent && !state.loading) {
    setStatus(
      status,
      "You're signed out, so this is a starting fighter, not yours. Sign in to load the one you saved.",
    );
  }
  renderOthers();
  saveBtn.textContent = state.slot !== activeBuild() ? "Save and wear build " + (state.slot + 1) : "Save profile";
  renderNextStep();
}

function renderAll() {
  lookSprites.length = 0;
  lookVox.length = 0;
  lookSprites.entry = entryOf(state.d.avatar);
  checkPicked($("#characters") as HTMLDivElement, "character", state.d.avatar); // element type from the page HTML
  renderBuilds();
  renderUpgrades();
  renderHats();
  renderPets();
  for (const kind of Object.keys(KINDS) as KindKey[]) renderItems(kind); // as: Object.keys types its keys as string
  renderSignedIn();
  renderPreview();
  renderSave();
}

function applyProfile(p: Profile | null) {
  state.owned = { ...emptyOwned(), ...p?.owned };
  state.builds = Array.isArray(p?.builds) ? [...p.builds] : [];
  if (p && !state.builds[p.build || 0]) state.builds[p.build || 0] = p; // the active build is always the profile itself
  state.slot = p?.build || 0;
  state.drafts = [];
  state.d = loadoutOf(p);
}

function renderCommands() {
  if (state.config) {
    ($("#cmd-timeout") as HTMLSpanElement).textContent = seconds(state.config.challengeTimeoutMs); // element type from the page HTML
    ($("#cmd-rematch") as HTMLSpanElement).textContent = seconds(state.config.rematchDelayMs); // element type from the page HTML
    const pts = state.config.checkinPoints ?? 1;
    // element type from the page HTML
    ($("#cmd-checkin") as HTMLSpanElement).textContent = pts
      ? "+" + pts + (pts === 1 ? " upgrade point" : " upgrade points")
      : "A check-in";
    const c = state.config,
      win = c.winDollars ?? 5,
      loss = c.lossDollars ?? 3;
    // element type from the page HTML
    ($("#cmd-dollars") as HTMLSpanElement).textContent =
      win || loss ? money(win) + " for a win and " + money(loss) + " for a loss" : "nothing on this channel right now";
    // element type from the page HTML
    ($("#cmd-give") as HTMLTableCellElement).textContent =
      c.giveEnabled === false
        ? "Giving dollars is off on this channel."
        : "Gives dollars to another fighter while the stream is live: up to " +
          money(c.giveMaxPerStream ?? 100) +
          " per stream, after your first " +
          (c.giveMinDuels ?? 5) +
          " duels.";
    // element type from the page HTML
    ($("#lb-note") as HTMLParagraphElement).textContent =
      "Ranked duels need a saved profile. Everyone starts at " + state.config.initialElo + " Elo.";
    ($("#hp-mode-note") as HTMLParagraphElement).hidden = state.config.quickDuel !== false; // element type from the page HTML
  }
}

// profile!: Boolean(state.profile) first (TypeScript doesn't narrow through Boolean())
const fresh = () => Boolean(state.profile) && !(state.profile!.wins + state.profile!.losses);
// Until the first duel: what to type in chat now that the fighter is saved.
function renderNextStep() {
  const next = $("#next-step") as HTMLParagraphElement, // element type from the page HTML
    show = Boolean(signedIn() && state.profile && !state.off && !dirty() && !lockedWorn().length && fresh());
  next.hidden = !show;
  if (show)
    next.replaceChildren(
      h("strong", {}, "Saved. Next: "),
      "in " + CHANNEL + "'s chat, type ",
      h("code", {}, "!challenge @friend"),
      ". They answer ",
      h("code", {}, "!fight"),
      ".",
    );
}

// Back from Twitch sign-in (?signed_in=1): say who is signed in and what to do, then drop the flag from the address.
function welcome() {
  const params = new URLSearchParams(location.search),
    user = state.session?.user;
  if (!params.has("signed_in")) return;
  params.delete("signed_in");
  history.replaceState(null, "", location.pathname + (params.size ? "?" + params : "") + location.hash);
  if (!user) return;
  setStatus(
    status,
    "Signed in as " +
      (user.displayName || user.login) +
      ". " +
      (state.profile ? "Your fighter is loaded." : "Pick a fighter and save."),
    "ok",
  );
  if (!state.profile) ($("#fighter") as HTMLElement).scrollIntoView({ block: "start" }); // element type from the page HTML (a main)
}

// This browser signed in before: signed out, the page says the preview isn't their fighter (sign-in lasts 30 days).
const KNOWN_KEY = "pixfray:signed-in";
function knownViewer() {
  try {
    return localStorage.getItem(KNOWN_KEY) === "1";
  } catch {
    return false;
  }
}
// Edits made before signing in (signed out, or after the session ran out) come back after the Twitch round trip.
const DRAFT_KEY = "pixfray:draft:" + CHANNEL,
  DRAFT_MS = 30 * 60_000;
// b!: same() is false for a null b
const sameLook = (a: Loadout, b: Loadout | null) => same(a, b) && a.defaultAbility === b!.defaultAbility;
function stashDraft() {
  if (!state.d || state.loading) return;
  const base = state.profile ? savedSlot() : loadoutOf(null);
  if (sameLook(state.d, base) && state.slot === activeBuild()) return;
  try {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ d: current(), withProfile: Boolean(state.profile), at: Date.now() }),
    );
  } catch {}
}
function restoreDraft() {
  // A draft this page stored (stashDraft); the checks below still treat each field as untrusted.
  let saved: { d?: Build; withProfile?: boolean; at: number } | null = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null");
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {}
  if (!signedIn() || !saved?.d || typeof saved.d !== "object" || !(Date.now() - saved.at < DRAFT_MS)) return false;
  const d = loadoutOf(saved.d);
  // Upgrade points come from the saved fighter, unless the draft was made on it (an expired session).
  if (!(saved.withProfile && state.profile)) d.stats = copy(state.d).stats;
  else if (Number.isInteger(saved.d.build) && saved.d.build >= 0 && saved.d.build < Math.max(1, state.builds.length))
    state.slot = saved.d.build;
  if (sameLook(d, state.d) && state.slot === activeBuild()) return false;
  state.d = d;
  renderAll();
  setStatus(
    status,
    "Your changes from before you signed in are back, not saved yet. " +
      (state.profile ? "Save to keep them, or reload the page to see your saved fighter." : "Save to keep them."),
  );
  return true;
}
// Every "Sign in" link (the Save button's and the header's) carries data-login.
document.addEventListener("click", (e) => {
  if ((e.target as Element).closest?.("[data-login]")) stashDraft(); // as Element: a click's target is an element
});
// Fighters are saved per channel: on a channel where the viewer has none, offer the base look they use on another.
async function loadOthers() {
  if (!signedIn() || state.profile || state.off) return;
  const r = await api("/api/profile/" + CHANNEL + "/others");
  const pick = new Set(pickable().map((e) => e.id));
  state.others =
    r.ok && Array.isArray(r.data?.fighters)
      ? r.data.fighters.filter((f: Other) => pick.has(f.avatar) && f.channel !== CHANNEL).slice(0, 3)
      : [];
  if (state.others.length) renderSave();
}
function renderOthers() {
  const box = $("#others") as HTMLDivElement, // element type from the page HTML
    list = signedIn() && !state.profile && !state.off ? state.others : [];
  box.hidden = !list.length;
  if (!list.length) return box.replaceChildren();
  box.replaceChildren(
    h(
      "p",
      { class: "small" },
      "Start from the fighter you use on another channel. Gear and upgrades stay on their own channel.",
    ),
    h(
      "div",
      { class: "others-actions" },
      ...list.map((f) =>
        h(
          "button",
          { class: "btn btn-small", type: "button", onclick: () => useOther(f) },
          "Use my " + f.channel + " fighter",
        ),
      ),
    ),
  );
}
function useOther(f: Other) {
  Object.assign(state.d, {
    avatar: f.avatar,
    color: /^#[0-9a-f]{6}$/i.test(f.color || "") ? f.color.toLowerCase() : state.d.color,
    defaultAbility: ["strike", "heavy", "heal"].includes(f.defaultAbility) ? f.defaultAbility : state.d.defaultAbility,
  });
  renderCharacters();
  renderAll();
  setStatus(status, "Copied your " + f.channel + " fighter. Save to keep it on " + CHANNEL + "'s channel.");
}

function renderSignedIn() {
  const s = state.session,
    note = $("#signin-note") as HTMLParagraphElement; // element type from the page HTML
  renderWho($("#who") as HTMLDivElement, s, signOut); // element type from the page HTML
  saveBtn.hidden = !signedIn();
  saveSignin.hidden = signedIn() || s?.configured === false;
  saveSignin.textContent =
    knownViewer() || state.profile ? "Sign in to load your fighter" : "Sign in with Twitch to save";
  // one sign-in button: the preview card's, next to what it saves (element type from the page HTML)
  if (!saveSignin.hidden) ($("#who") as HTMLDivElement).replaceChildren();
  note.hidden = signedIn() || Boolean(s?.configured); // the usual signed-out case: the card's hint says what sign-in shares
  ($("#signin-hint") as HTMLParagraphElement).hidden = saveSignin.hidden; // element type from the page HTML
  if (!s)
    note.textContent =
      "Sign-in is unavailable right now, so profiles can't be saved. You can still browse characters and the leaderboard.";
  else if (s.configured === false)
    note.textContent =
      "Twitch sign-in isn't set up on this server yet, so profiles can't be saved. You can still browse characters and the leaderboard.";
  else
    note.textContent =
      "Sign in with Twitch to save your fighter. It shares only your public Twitch name, and ranked duels need a saved profile.";
  ($("#my-stats") as HTMLDivElement).hidden = !state.profile; // element type from the page HTML
  if (state.profile) {
    // element type from the page HTML; as unknown as string: textContent turns the number into text, as in the .js
    ($("#stat-elo") as HTMLDivElement).textContent = state.profile.elo as unknown as string;
    ($("#stat-wl") as HTMLDivElement).textContent = state.profile.wins + " / " + state.profile.losses; // element type from the page HTML
    ($("#stat-dollars") as HTMLDivElement).textContent = money(state.profile.dollars); // element type from the page HTML
    // element type from the page HTML; as unknown as string: textContent turns the number into text, as in the .js
    ($("#stat-streak") as HTMLDivElement).textContent = (state.profile.streak || 0) as unknown as string;
  }
  // element type from the page HTML; profile!: canShop() needs one
  ($("#shop-note") as HTMLParagraphElement).textContent =
    (canShop() ? "You have " + money(state.profile!.dollars) + ". " : "") + // profile!: canShop() needs one
    "Spend the PixFray dollars you earn in duels. Everything here changes looks only, not stats, and you can wear it in any build." +
    (signedIn() ? "" : " Try anything on now; sign in to buy.");
}

function renderLeaderboard() {
  const tbody = $("#leaderboard tbody") as HTMLTableSectionElement, // element type from the page HTML
    me = state.session?.user?.id,
    rows = state.leaderboard;
  if (!rows.length) {
    renderPodium(rows); // three open steps show what there is to take
    tbody.replaceChildren(
      h(
        "tr",
        { class: "empty" },
        h(
          "td",
          { colspan: 6 },
          h("strong", {}, "No ranked duels yet, so the top spot is open."),
          " To get on the board: ",
          signedIn() ? "save your fighter in the Fighter tab" : "sign in and save your fighter in the Fighter tab",
          ", then type ",
          h("code", {}, "!challenge @viewer"),
          " in chat while the stream is live.",
        ),
      ),
    );
    return;
  }
  const character = (id: string) => {
    // still thumbnail; it never animates in the table
    const entry = entryOf(id),
      canvas = h("canvas", { class: "sprite", width: 32, height: 32, "aria-hidden": "true" }),
      v = voxCanvas();
    if (entry) {
      addSprite(canvas, entry, { active: () => false });
      vox(v, () => composeLook(entry));
    }
    return [
      h(
        "span",
        { class: "lb-char", title: entry?.label || id },
        entry ? h("span", { class: "thumb" }, v, canvas) : null,
        h("span", {}, entry?.label || id),
      ),
    ];
  };
  const row = (p: LeaderRow, i: number) =>
    h(
      "tr",
      { class: [p.userId === me ? "me" : "", i < 3 ? "podium" : ""].filter(Boolean).join(" ") || null },
      h("td", { class: "num" }, i + 1),
      h(
        "td",
        {},
        h("span", { style: { color: p.color }, "aria-hidden": "true" }, "■ "),
        p.displayName || p.username,
        p.userId === me ? h("span", { class: "muted" }, " (you)") : null,
      ),
      h("td", { class: "col-char" }, ...character(p.avatar)),
      h("td", { class: "num" }, p.elo),
      h("td", { class: "num" }, p.wins),
      h("td", { class: "num" }, p.losses),
    );
  renderPodium(rows);
  const top = rows.slice(0, 10).map(row);
  const mine = rows.findIndex((p) => p.userId === me);
  if (mine >= 10) top.push(row(rows[mine]!, mine)); // !: findIndex found this row
  tbody.replaceChildren(...top);
}

// The top three stand on plinths in front of the intro's pillars still, as voxels like the 3D preview; an empty step says how to take it.
function renderPodium(rows: LeaderRow[]) {
  const box = $("#podium") as HTMLOListElement; // element type from the page HTML
  box.hidden = false;
  box.replaceChildren(
    ...[0, 1, 2].map((i) => {
      const p = rows[i],
        entry = p && entryOf(p.avatar);
      if (!p)
        return h(
          "li",
          { class: i === 0 ? "open first" : "open" },
          h("span", { class: "slot", "aria-hidden": "true" }),
          h(
            "span",
            { class: "plinth" },
            h("span", { class: "place" }, i + 1),
            h("strong", {}, "Open"),
            h("span", { class: "muted" }, "Win a ranked duel to take it"),
          ),
        );
      const canvas = h("canvas", { class: "sprite", width: 48, height: 48, "aria-hidden": "true" }),
        v = voxCanvas();
      if (entry) {
        addSprite(canvas, entry, { active: () => false });
        vox(v, () => composeLook(entry));
      }
      return h(
        "li",
        { class: i === 0 ? "first" : null },
        h("span", { class: "thumb" }, v, canvas),
        h(
          "span",
          { class: "plinth" },
          h("span", { class: "place" }, i + 1),
          h("strong", {}, p.displayName || p.username),
          h("span", { class: "muted" }, p.elo + " Elo · " + p.wins + "–" + p.losses),
        ),
      );
    }),
  );
}

async function loadLeaderboard() {
  const r = await api("/api/leaderboard/" + CHANNEL);
  if (r.ok && Array.isArray(r.data)) {
    state.leaderboard = r.data;
    renderLeaderboard();
  } else
    // element type from the page HTML
    ($("#leaderboard tbody") as HTMLTableSectionElement).replaceChildren(
      h(
        "tr",
        {},
        h(
          "td",
          { colspan: 6, class: "muted" },
          r.status === 403 && r.data?.off
            ? "No ranks yet: PixFray isn't on for " + CHANNEL + "."
            : "Couldn't load the leaderboard: " + errorText(r),
        ),
      ),
    );
}

addEventListener("beforeunload", (e) => {
  if (signedIn() && edited()) e.preventDefault();
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!signedIn()) return;
  const body = current();
  if (!body.avatar) {
    setStatus(status, "Pick a character first.", "error");
    return;
  }
  const locked = lockedWorn();
  if (locked.length) {
    setStatus(
      status,
      "Not saved: buy " + locked.map(([k, id]) => itemLabel(k, id)).join(", ") + " first, or pick something you own.",
      "error",
    );
    return;
  }
  saveBtn.disabled = true;
  setStatus(status, "Saving…");
  const r = await api("/api/profile/" + CHANNEL, { method: "POST", body });
  saveBtn.disabled = false;
  if (r.status === 401) {
    state.session = { ...state.session, user: null };
    renderSignedIn();
    setStatus(
      status,
      "Your session expired. Sign in again to save. Your changes come back after you sign in.",
      "error",
    );
    return;
  }
  if (!r.ok) {
    setStatus(status, "Not saved: " + (REASONS[r.data?.error] || errorText(r)), "error");
    return;
  }
  const drafts = state.drafts.map((d, i) => (i === body.build ? null : d));
  state.profile = { owned: state.owned, ...r.data.profile };
  applyProfile(state.profile);
  state.drafts = drafts; // unsaved edits in the other builds stay
  renderAll();
  loadLeaderboard();
});

// The channel is turned off (paused) or was never set up (server/channels.ts).
function showOff(off: string) {
  const note = $("#off-note") as HTMLParagraphElement; // element type from the page HTML
  note.hidden = false;
  if (off === "paused") {
    note.textContent =
      "PixFray is off on " + CHANNEL + "'s channel right now. Saved fighters and ranks are kept for when it's back.";
    return;
  }
  note.replaceChildren(
    "PixFray isn't set up on " +
      CHANNEL +
      "'s channel yet. Fights happen in their chat, so " +
      CHANNEL +
      " turns it on first, on ",
    h("a", { href: "/start/" }, "/start"),
    ". Until then, ",
    h("a", { href: "/play/" }, "pick another channel"),
    ".",
  );
  // element types from the page HTML (an aside and a div)
  for (const el of [form, $(".fighter-card") as HTMLElement, $(".hero-pick .tabs") as HTMLDivElement]) el.hidden = true;
  ($("#panel-ranks") as HTMLDivElement).hidden = false; // element type from the page HTML
}

async function init() {
  renderSwatches();
  const calls = Promise.all([
    api("/api/session"),
    api("/api/catalog/" + CHANNEL),
    api("/api/state/" + CHANNEL),
    api("/api/shop/" + CHANNEL),
  ]);
  // The static character list isn't rate-limited like /api, so the fighter and the grid draw before the channel data arrives.
  const early = await api("/assets/characters.json");
  if (early.ok && Array.isArray(early.data) && early.data.length) {
    state.catalog = early.data;
    applyProfile(null);
    renderCharacters();
    renderAll();
  }
  const [session, catalog, live, shop] = await calls;
  state.loading = false;
  let list = shop.ok && Array.isArray(shop.data?.pets) ? shop.data : null;
  if (!list) {
    const pets = await api("/api/pets/" + CHANNEL);
    list = pets.ok && Array.isArray(pets.data?.pets) ? pets.data : null;
  } // pets still work without the shop list
  state.shop = list;
  state.session = session.ok ? session.data : null;
  if (catalog.ok && Array.isArray(catalog.data) && catalog.data.length) state.catalog = catalog.data; // else the static list stays
  state.config = live.ok ? live.data?.config : null;
  // the intro's main button offers this channel next time (src/intro/back.ts)
  if (live.ok)
    try {
      localStorage.setItem("pixfray:channel", CHANNEL);
    } catch {}
  const hash = location.hash.slice(1);
  showTab(tabOf(hash) || "fighter", {
    hash: tabOf(hash) ? hash : "fighter",
    scroll: Boolean(tabOf(hash)) && hash !== "fighter",
  });
  if (live.status === 403 && live.data?.off) {
    state.off = live.data.off;
    showOff(live.data.off);
  }
  renderCharacters();
  renderCommands();
  if (signedIn()) {
    const [profile, access] = await Promise.all([api("/api/profile/" + CHANNEL), api("/api/access/" + CHANNEL)]);
    state.profile = profile.ok ? profile.data : null;
    ($("#admin-link") as HTMLAnchorElement).hidden = !(access.ok && access.data?.canManage); // element type from the page HTML
  }
  applyProfile(state.profile);
  if (signedIn())
    try {
      localStorage.setItem(KNOWN_KEY, "1");
    } catch {}
  renderAll();
  welcome();
  if (!restoreDraft()) loadOthers();
  loadLeaderboard();
  if (signedIn() && !state.off) initSpriteMaker({ onChange: reloadCharacters });
}
// The viewer removed their approved sprite: the server put fighters wearing it back on the default character.
async function reloadCharacters() {
  const [catalog, profile] = await Promise.all([api("/api/catalog/" + CHANNEL), api("/api/profile/" + CHANNEL)]);
  if (catalog.ok && Array.isArray(catalog.data) && catalog.data.length) state.catalog = catalog.data;
  if (profile.ok) state.profile = profile.data;
  applyProfile(state.profile);
  renderCharacters();
  renderAll();
}
// /play/ (the viewer page with no ?channel=) asks which stream the viewer watches, so nobody saves a fighter on the wrong channel.
async function pickChannel() {
  document.title = "PixFray: pick your stream";
  for (const a of document.querySelectorAll(".topbar .nav-cta, .topbar .brand"))
    a.setAttribute("href", a.classList.contains("brand") ? "/" : "/play/");
  // element types from the page HTML (a main and the page wrapper)
  for (const el of [$("#fighter") as HTMLElement | null, $("body > .page") as HTMLElement | null])
    if (el) el.hidden = true;
  ($("#pick") as HTMLElement).hidden = false; // element type from the page HTML
  const [session, list] = await Promise.all([api("/api/session"), api("/api/picker")]);
  // Signing in happens on a channel's page, so the picker shows only who is already signed in.
  if (session.ok && session.data?.user) renderWho($("#who") as HTMLDivElement, session.data, signOut); // element type from the page HTML
  else ($("#who") as HTMLDivElement).replaceChildren(); // element type from the page HTML
  // one request brings every channel's top fighters and the looks they wear (server/worker.ts picker())
  const picked: PickerChannel[] =
    list.ok && Array.isArray(list.data?.channels)
      ? list.data.channels
      : site.builtinChannels.map((login) => ({ login, top: [] }));
  const builtin: CatalogEntry[] = list.ok && Array.isArray(list.data?.catalog) ? list.data.catalog : [],
    channels = picked.map((c) => c.login);
  // element type from the page HTML
  ($("#channel-list") as HTMLUListElement).replaceChildren(
    ...picked.map(({ login: c, top, catalog = [] }) => {
      const crew = h("span", { class: "channel-crew", "aria-hidden": "true" }),
        meta = h("span", { class: "channel-meta" });
      const link = h(
        "a",
        { class: "channel", href: "/?channel=" + encodeURIComponent(c) },
        crew,
        h("span", { class: "channel-text" }, h("span", { class: "channel-name" }, c), meta),
        h("span", { class: "channel-go" }, "Fight in " + c),
      );
      channelRanks(
        c,
        link,
        crew,
        meta,
        top,
        new Map([...builtin, ...catalog].map((e): [string, CatalogEntry] => [e.id, e])),
      );
      return h("li", { "data-login": c }, link);
    }),
  );
  channelSearch(channels, list.ok && list.data?.full === true);
  liveLanding();
}
// A viewer's fighter belongs to the stream they watch, so the search only finds channels with PixFray on. Up to
// SHOWN rows show before typing; the rest are a search away. A name with no match gets an invite to this site (notHere).
const SHOWN = 8;
// A Twitch name that isn't on this site: the viewer can send its streamer this site's /start/ link (a forked copy invites
// to its own site, not ours). When this site is full it points at running their own copy instead. Other copies
// can't be seen from here, so the note says a streamer may already have PixFray on a site of their own.
function notHere(q: string, full: boolean) {
  const host = location.host,
    lead = h("strong", {}, q + " isn't on " + host + " yet.");
  const note = h(
    "span",
    { class: "invite-note" },
    "Streamers who run their own copy of PixFray have it on their own site.",
  );
  if (full)
    return [
      lead,
      " This site is full right now; they can ",
      h("a", { href: "/start/#source" }, "run their own copy"),
      ".",
      note,
    ];
  const link = location.origin + "/start/";
  const copy = h(
    "button",
    {
      type: "button",
      class: "btn btn-small",
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(link);
          copy.textContent = "Copied";
        } catch {
          copy.textContent = "Copy the link by hand";
        }
      },
    },
    "Copy invite link",
  );
  return [lead, " Send them this link to set it up: ", h("a", { href: "/start/" }, host + "/start"), " ", copy, note];
}
function channelSearch(listed: string[], full = false) {
  // element types from the page HTML; the list holds only the li rows pickChannel built
  const input = $("#channel-q") as HTMLInputElement,
    status = $("#channel-status") as HTMLParagraphElement, // element type from the page HTML
    // the list holds only the li rows pickChannel built
    rows = [...(($("#channel-list") as HTMLUListElement).children as HTMLCollectionOf<HTMLLIElement>)];
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/^@/, "")
      .replace(/^(https?:\/\/)?(www\.)?twitch\.tv\//, "")
      .replace(/[/?#].*$/, "");
  const filter = () => {
    const q = norm(input.value);
    let shown = 0;
    for (const li of rows) {
      const hit = q ? (li.dataset.login || "").includes(q) : shown < SHOWN;
      li.hidden = !hit;
      shown += hit ? 1 : 0;
    }
    if (!q)
      status.replaceChildren(
        listed.length > SHOWN ? "Type a name to find the other " + (listed.length - SHOWN) + " channels." : "",
      );
    else if (shown) status.replaceChildren();
    else
      status.replaceChildren(
        ...(/^[a-z0-9_]{3,25}$/.test(q) ? notHere(q, full) : ["No channel with PixFray matches that name."]),
      );
  };
  input.addEventListener("input", filter);
  filter();
  // Enter opens the exact match, or the only one left.
  ($("#channel-search") as HTMLFormElement).addEventListener("submit", (e) => {
    // element type from the page HTML
    e.preventDefault();
    const q = norm(input.value),
      visible = rows.filter((li) => !li.hidden);
    const go = visible.find((li) => li.dataset.login === q) || (visible.length === 1 ? visible[0] : null);
    if (go) location.href = go.querySelector("a")!.href; // !: every row pickChannel builds holds its link
  });
}
// On wide screens the picker's island is the intro's live arena, not a picture: each channel's top fighter
// stands on it, and hovering or focusing a row brings that channel's fighter on. Phones show it as a banner over the heading.
const landing: {
  arena: Fighter3D | null;
  show: ((entry: CatalogEntry, link?: HTMLAnchorElement) => void) | null;
  first: CatalogEntry | null;
  fallback: CatalogEntry | null;
  labels: Map<CatalogEntry, string>;
  links: Map<CatalogEntry, HTMLAnchorElement>;
} = { arena: null, show: null, first: null, fallback: null, labels: new Map(), links: new Map() };
function liveLanding() {
  if (navigator.connection?.saveData || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  import("./fighter3d.ts")
    .then(({ createFighter3D }) => {
      const canvas = h("canvas", { class: "landing-3d", "aria-hidden": "true" });
      ($("#pick") as HTMLElement).prepend(canvas); // element type from the page HTML
      try {
        landing.arena = createFighter3D(canvas, { zoom: 0.8 });
      } catch {
        canvas.remove();
        return;
      }
      const cap = h("p", { class: "landing-who", "aria-hidden": "true" });
      canvas.after(cap);
      ($("#pick") as HTMLElement).classList.add("is-live"); // element type from the page HTML
      // the caption names whose fighter stands on the island, so hovering a row visibly brings that channel's fighter on
      // the row whose fighter is on the island is marked too, so the scene and the list read as one
      landing.show = (entry: CatalogEntry, link = landing.links.get(entry)) => {
        cap.textContent = landing.labels.get(entry) || "";
        for (const a of landing.links.values()) a.classList.toggle("is-shown", a === link);
        const look = composeLook(entry);
        // arena! and show!: both are set above before show can run
        if (look) landing.arena!.set(look);
        else whenImage(entry.url, () => landing.show!(entry)); // show!: set just above
      };
      // fallback!: the check above found first or fallback
      if (landing.first || landing.fallback) landing.show(landing.first || landing.fallback!);
    })
    .catch(() => {});
}
// each channel row shows its top three fighters, walking while the row is hovered or focused
function channelRanks(
  channel: string,
  link: HTMLAnchorElement,
  crew: HTMLSpanElement,
  meta: HTMLSpanElement,
  rows: TopRow[],
  byId: Map<string, CatalogEntry>,
) {
  let lit = false;
  for (const ev of ["pointerenter", "focus"])
    link.addEventListener(ev, () => {
      lit = true;
    });
  for (const ev of ["pointerleave", "blur"])
    link.addEventListener(ev, () => {
      lit = false;
    });
  const add = (entry: CatalogEntry, cls: string) => {
    const canvas = h("canvas", { class: cls, width: 48, height: 48 }),
      v = voxCanvas();
    crew.append(h("span", { class: "thumb" + (cls.includes("is-open") ? " is-open" : "") }, v, canvas));
    addSprite(canvas, entry, { anim: "walk", active: () => lit });
    vox(v, () => composeLook(entry));
  };
  if (!rows.length) {
    meta.textContent = "No ranked duels yet. The top spot is open.";
    // the open spot: a character picked from the channel name, so each empty channel brings a different one on stage
    // [0]!: the first character group (people) is always there
    const people = new Set(CHARACTER_GROUPS[0]!.ids),
      all = [...byId.values()].filter((e) => people.has(e.id)),
      first =
        all[
          // as Iterable<string>: a Twitch login is ASCII, so spreading it by code point splits nothing
          [...(channel as Iterable<string>)].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7) %
            Math.max(1, all.length)
        ] || byId.values().next().value;
    if (first) {
      add(first, "sprite is-open");
      landing.labels.set(first, "The open spot in " + channel + "'s chat");
      landing.links.set(first, link);
    }
    if (first && !landing.fallback) {
      landing.fallback = first;
      if (!landing.first) landing.show?.(first);
    }
    if (first) for (const ev of ["pointerenter", "focus"]) link.addEventListener(ev, () => landing.show?.(first, link));
    return;
  }
  meta.replaceChildren(
    "Top fighter: " + (rows[0]!.displayName || rows[0]!.username) + " · ", // !: rows isn't empty (returned above)
    h("span", { class: "nowrap" }, rows[0]!.elo + " Elo"), // !: rows isn't empty
  );
  const top = byId.get(rows[0]!.avatar); // !: rows isn't empty
  if (top) {
    // !: rows isn't empty
    landing.labels.set(top, (rows[0]!.displayName || rows[0]!.username) + ", top of " + channel + "'s chat");
    landing.links.set(top, link);
    if (!landing.first) {
      landing.first = top;
      landing.show?.(top);
    }
    for (const ev of ["pointerenter", "focus"]) link.addEventListener(ev, () => landing.show?.(top, link));
  }
  for (const p of rows.slice(0, 3)) if (byId.get(p.avatar)) add(byId.get(p.avatar)!, "sprite"); // !: checked just before
}
// Phones: the fixed Save bar stays put while you pick; it steps aside only on Ranks and Rules,
// unless there is something to save or say.
function tuckSaveBar() {
  const root = document.documentElement,
    quiet = !status.textContent && !dirty();
  // ...and it steps aside at the footer too, so the page's last links aren't under it
  const foot = $(".site-foot"),
    atFoot = !!foot && foot.getBoundingClientRect().top < innerHeight;
  root.classList.toggle(
    "bar-away",
    (quiet && (root.dataset.tab === "ranks" || root.dataset.tab === "rules")) || atFoot,
  );
  root.classList.toggle("at-top", quiet && scrollY < 40);
}
function watchSaveBar() {
  addEventListener("scroll", tuckSaveBar, { passive: true });
  new MutationObserver(tuckSaveBar).observe(status, { childList: true, characterData: true, subtree: true });
  form.addEventListener("change", tuckSaveBar);
  tuckSaveBar();
}
// Phones: once the tabs scroll under the stuck preview, it shrinks to a short strip so the choices get the screen.
// Shrinking moves the page, so it switches back only after scrolling clearly above the tabs.
function compactPreview() {
  // element types from the page HTML (an aside and a div)
  const card = $(".hero-card") as HTMLElement,
    tabs = $(".tabs") as HTMLDivElement, // element type from the page HTML
    root = document.documentElement;
  const update = () => {
    if (innerWidth > 900 || !card.classList.contains("has-3d")) return root.classList.remove("compact");
    // where the tabs' bottom would be in the flow (they stick once compact, so measure from their section)
    // parentElement!: the tabs sit inside their section
    const y = tabs.parentElement!.getBoundingClientRect().top + tabs.offsetHeight,
      on = root.classList.contains("compact");
    if (!on && y < 0) root.classList.add("compact");
    else if (on && y > 120) root.classList.remove("compact");
  };
  addEventListener("scroll", update, { passive: true });
  addEventListener("resize", update);
}
if (CHANNEL_PICKED) {
  watchSaveBar();
  compactPreview();
  init();
} else pickChannel();
