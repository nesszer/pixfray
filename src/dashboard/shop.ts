// Shop and Pets tabs: picker tiles that try items on, Buy buttons that confirm first, and the free legendary reroll.
import { api, errorText, h, $, setStatus, addSprite, addPet, addCosmeticSample, composeLook, CHANNEL } from "../ui.ts";
import { acceptedUnreadable, parseAnswer, parseBought, parseShop } from "../parse.ts";
import type { Profile, ShopItem, ShopPet } from "../parse.ts";
import type { Look } from "../fighter3d.ts";
import {
  state,
  KINDS,
  REASONS,
  emptyOwned,
  copy,
  owns,
  itemLabel,
  canShop,
  signedIn,
  money,
  rules,
  petById,
  entryOf,
  petTag,
  boostText,
  petBoost,
  vox,
  voxCanvas,
  peekOn,
} from "./state.ts";
import type { BuyKind, CatalogEntry, ItemKind, Kind, KindKey } from "./state.ts";
import { renderAll } from "../dashboard.ts";
import { renderSave, expired } from "./save.ts";
import { switchBuild, renderPreview, renderUpgrades, playWin } from "./fighter.ts";

// The first click asks to confirm; after 6 s unconfirmed the button says `text` again.
function confirmFirst(btn: HTMLButtonElement, ask: string, text: string) {
  if (btn.dataset.confirm === "1") return false;
  btn.dataset.confirm = "1";
  btn.textContent = ask;
  setTimeout(() => {
    if (btn.isConnected && btn.dataset.confirm === "1") unconfirm(btn, text);
  }, 6000);
  return true;
}
function unconfirm(btn: HTMLButtonElement, text: string) {
  btn.dataset.confirm = "";
  btn.textContent = text;
}
function retry(btn: HTMLButtonElement, text: string) {
  btn.disabled = false;
  unconfirm(btn, text);
}
const REROLL = "Reroll stats (free, once)";
// A legendary pet's one free reroll: the server rolls 4 different stats.
async function reroll(pet: ShopPet, btn: HTMLButtonElement, out: Element) {
  if (confirmFirst(btn, "Confirm: reroll stats", REROLL)) return;
  btn.disabled = true;
  setStatus(out, "Rerolling…");
  const r = parseAnswer(
    await api("/api/shop/" + CHANNEL, { method: "POST", body: { kind: "reroll", id: pet.id } }),
    parseBought,
    "a reroll",
  );
  if (!r.ok) {
    retry(btn, REROLL);
    if (r.status === 401) expired();
    setStatus(
      out,
      "Not rerolled: " +
        (r.status === 401 ? "your session expired. Sign in again." : REASONS[r.data?.error] || errorText(r)),
      "error",
    );
    return;
  }
  state.owned = { ...emptyOwned(), ...(r.data.owned || state.owned) };
  renderAll();
  setStatus(out, "Rerolled " + pet.label + ": " + boostText(petBoost(pet)) + ".", "ok");
}
// A bought item is worn right away; Save brings it on stream. A bought build slot opens as a copy of this build.
async function buy(
  kind: BuyKind,
  item: string,
  label: string,
  price: number,
  btn: HTMLButtonElement,
  out: Element,
  text: string,
) {
  if (confirmFirst(btn, "Confirm: spend $" + price, text)) return;
  btn.disabled = true;
  setStatus(out, "Buying…");
  const r = parseAnswer(
    await api("/api/shop/" + CHANNEL, { method: "POST", body: { kind, id: item, price } }),
    parseBought,
    "a purchase",
  );
  if (r.data?.error === "price_changed") {
    // A mod changed the price after this page loaded: show the new prices and let the viewer decide again.
    const shop = parseAnswer(await api("/api/shop/" + CHANNEL), parseShop, "the shop");
    if (shop.ok) state.shop = shop.data;
    renderAll();
    setStatus(out, "Not bought: the price changed to $" + r.data.price + ". Check it and buy again.", "error");
    return;
  }
  if (r.status === 401) {
    retry(btn, text);
    expired();
    setStatus(out, "Not bought: your session expired. Sign in again to buy.", "error");
    return;
  }
  if (acceptedUnreadable(r)) {
    // The dollars may be spent already, so the button stays off: a second click could buy it twice.
    setStatus(
      out,
      "Your purchase may have gone through, but this page couldn't read the answer. Reload the page to check.",
      "error",
    );
    return;
  }
  if (!r.ok) {
    retry(btn, text);
    setStatus(out, "Not bought: " + (REASONS[r.data?.error] || errorText(r)), "error");
    return;
  }
  // as Profile: only a fighter with a profile can buy (canShop), so the spread copies one
  state.profile = {
    ...state.profile,
    dollars: r.data.dollars,
    styleDollars: r.data.styleDollars ?? state.profile?.styleDollars,
  } as Profile;
  state.owned = { ...emptyOwned(), ...(r.data.owned || state.owned) };
  if (kind === "slot") switchBuild(state.owned.slots - 1, copy(state.d));
  else if (kind === "pet") state.d.pet = item;
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
export const buyButton = (
  kind: BuyKind,
  item: string,
  label: string,
  price: number,
  out: Element,
  text = "Buy for $" + price,
) => {
  // A pet takes duel dollars only; anything else spends style dollars (channel point rewards) first.
  const have = (state.profile?.dollars || 0) + (kind === "pet" ? 0 : state.profile?.styleDollars || 0),
    short = canShop() && have < price;
  // Out of reach: say how far, so the affordable items are the only gold buttons
  return h(
    "button",
    {
      type: "button",
      class: "btn btn-small buy" + (short ? " short" : ""),
      disabled: !canShop() || short,
      title: short
        ? "Costs $" +
          price +
          "; you have $" +
          have +
          (kind === "pet" && state.profile?.styleDollars ? " duel dollars" : "")
        : null,
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
  price?: number | null | undefined; // null: not for sale (server/cosmetics.ts cosmeticPrice)
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
  // as number: a free item has no price, and undefined > 0 is false
  const forSale = !have && (price as number) > 0;
  // Signed out, nothing can be bought yet, so the price is a quiet line instead of a row of disabled Buy buttons.
  const quiet = forSale && !signedIn(),
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
    // as number: forSale checked the price is above 0
    forSale && !quiet ? buyButton(kind, id, buyLabel || label, price as number, out) : null,
  );
  const look = kind === "hat" || kind === "pet" ? null : KINDS[kind].look;
  if (kind === "hat" || kind === "pet") peekOn(option, kind, id);
  else if (look === "char" || look === "pet") peekOn(option, KINDS[kind].field, id);
  return option;
}
function tryOnNote(kind: ItemKind, id: string, out: Element) {
  if (owns(kind, id)) return setStatus(out, "");
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
export const checkPicked = (box: Element, value: string) => {
  const r = box.querySelector<HTMLInputElement>("input[value='" + CSS.escape(value) + "']");
  if (r) r.checked = true;
  else
    box.querySelectorAll("input").forEach((x) => {
      x.checked = false;
    });
};

// Thumbnails of the picked character wearing an item; they follow the character as it changes.
export const lookSprites: ReturnType<typeof addSprite>[] & { entry?: CatalogEntry | null } = [];
export const lookVox: [HTMLCanvasElement, () => Look | null][] = [];
const spriteCanvas = () => h("canvas", { class: "sprite", width: 48, height: 48, "aria-hidden": "true" });
// a pet on its own, as voxels, beside its flat sprite
const petThumb = (pet: ShopPet, color: string) => {
  const canvas = spriteCanvas(),
    v = voxCanvas();
  addPet(canvas, pet, { color });
  vox(v, () => {
    const l = composeLook(entryOf(state.d.avatar), { pet, looks: { petColor: color } });
    // as Look: voxThumb draws only key, body and frameH, so the pet picture needs no pet of its own
    return l?.pet ? ({ key: "pet:" + l.key, body: l.pet, frameH: l.petH } as Look) : null;
  });
  return h("span", { class: "thumb" }, v, canvas);
};
const charThumb = (opts: { hat?: string; looks?: Record<string, string> }) => {
  const canvas = spriteCanvas(),
    v = voxCanvas();
  lookSprites.push(addSprite(canvas, entryOf(state.d.avatar), { active: () => false, ...opts }));
  const make = () => composeLook(entryOf(state.d.avatar), opts);
  lookVox.push([v, make]);
  vox(v, make);
  return h("span", { class: "thumb" }, v, canvas);
};
const loadingNote = (box: Element, loading: string, failed: string) =>
  box.replaceChildren(h("p", { class: "muted small" }, state.loading ? loading : failed));

export function renderHats() {
  const r = rules(),
    box = $<HTMLDivElement>("#hats"),
    out = $<HTMLParagraphElement>("#hat-status");
  box.replaceChildren(
    ...r.hats.map((hat) =>
      tile({
        kind: "hat",
        id: hat.id,
        label: hat.label,
        visual: charThumb({ hat: hat.id }),
        price: (state.shop?.hatPricePerWin || 0) * hat.wins,
        buyLabel: hat.label + " hat",
        out,
        tag: owns("hat", hat.id) ? null : "Free at " + hat.wins + (hat.wins === 1 ? " win" : " wins"),
        onPick: (id) => {
          state.d.hat = id;
        },
      }),
    ),
  );
  checkPicked(box, state.d.hat);
  const locked = r.hats.filter((x) => !owns("hat", x.id)).length;
  $("#hat-note").textContent = locked
    ? "(" + locked + (state.shop?.hatPricePerWin ? " unlock with wins or dollars)" : " unlock with wins)")
    : "";
}

export function renderItems(kind: KindKey) {
  const k: Kind = KINDS[kind],
    box = $<HTMLDivElement>("#items-" + kind),
    out = $<HTMLParagraphElement>("#status-" + kind),
    list = state.shop?.items?.[kind];
  if (!list) return loadingNote(box, "Loading the shop…", "The shop couldn't load. Reload to try again.");
  const pet = petById(state.d.pet) || state.shop!.pets[0]; // state.shop!: list came from it
  const visual = (id: string) => {
    if (k.look === "char") return charThumb({ looks: { [k.field]: id } });
    if (k.look === "pet") return pet ? petThumb(pet, id) : spriteCanvas();
    if (k.look !== "sample") return null;
    const c = h("canvas", { class: "sprite sample", width: 64, height: 48, "aria-hidden": "true" });
    if (id) addCosmeticSample(c, kind, id);
    return c;
  };
  const text = (item: ShopItem) => (kind === "taunt" ? "“" + item.label + "”" : item.label);
  const onPick = (id: string) => {
    state.d[k.field] = id;
    if (kind === "petcolor") renderPets();
    if ((kind === "effect" || kind === "taunt") && id) playWin();
  };
  box.replaceChildren(
    tile({ kind, id: "", label: k.none, visual: visual(""), out, onPick }),
    ...list.map((item) =>
      tile({
        kind,
        id: item.id,
        label: text(item),
        visual: visual(item.id),
        price: item.price,
        buyLabel: item.label + (kind === "accessory" || kind === "trail" || kind === "effect" ? "" : " " + k.noun),
        out,
        onPick,
      }),
    ),
  );
  if (kind === "title")
    box.querySelectorAll(".char-option label > span:first-of-type").forEach((s) => s.classList.add("title-text"));
  checkPicked(box, state.d[k.field]);
  const have = state.owned[kind]?.length || 0;
  $("#note-" + kind).textContent = list[0]?.price
    ? "(" + money(list[0].price) + " each" + (canShop() ? ", you own " + have : "") + ")"
    : "";
}

// Pets: tier, boost and price; a bought pet adds to the stats on top of the upgrade limit.
export function renderPets() {
  const box = $<HTMLDivElement>("#pet-list"),
    out = $<HTMLParagraphElement>("#pet-status");
  if (!state.shop) return loadingNote(box, "Loading pets…", "Pets couldn't load. Reload to try again.");
  const option = (pet: ShopPet | null) =>
    tile({
      kind: "pet",
      id: pet?.id || "",
      label: pet ? pet.label : "No pet",
      visual: pet ? petThumb(pet, state.d.petColor) : h("span", { class: "thumb empty-slot", "aria-hidden": "true" }),
      price: pet?.price,
      out,
      tag: pet ? petTag(pet) : null,
      tier: pet?.tier,
      onPick: (id) => {
        state.d.pet = id;
        renderUpgrades();
        renderItems("petcolor");
      },
    });
  // An owned legendary keeps its free reroll button until it's used.
  const withReroll = (pet: ShopPet) => {
    const el = option(pet);
    if (pet.tier === "legendary" && canShop() && owns("pet", pet.id) && !state.owned.rerolled?.includes(pet.id))
      el.append(
        h(
          "button",
          {
            type: "button",
            class: "btn btn-small reroll",
            "aria-label": "Reroll " + pet.label + "'s stats, free, once",
            // as: the handler sits on this button
            onclick: (e: MouseEvent) => reroll(pet, e.currentTarget as HTMLButtonElement, out),
          },
          REROLL,
        ),
      );
    return el;
  };
  box.replaceChildren(option(null), ...state.shop.pets.map(withReroll));
  checkPicked(box, state.d.pet);
  $("#pet-note").textContent = canShop()
    ? "(you own " +
      state.owned.pets.length +
      ", you have " +
      money(state.profile!.dollars) + // profile!: canShop() needs one
      (state.profile!.styleDollars ? " in duel dollars; style dollars don't buy pets" : "") + // as above
      ")"
    : "";
  $("#petcolor-help").textContent = petById(state.d.pet)
    ? "Tints your pet on stream."
    : "Tints your pet on stream. The samples show a " + (state.shop.pets[0]?.label || "pet") + " until you pick one.";
}
