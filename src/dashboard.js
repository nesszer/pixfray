// Viewer dashboard ("/"): an on-stream preview above four tabs. Fighter (builds, character, colors, upgrades),
// Shop (hats and cosmetics), Pets (pets and pet colors) and Ranks (leaderboard and duel rules).
// Talks only to the routes in CONTRACTS.md section 2.
import { api, errorText, h, $, setStatus, renderWho, signOut, addSprite, addPet, addStage, addCosmeticSample, composeLook, onLooksReady, whenImage, seconds, CHANNEL, CHANNEL_PICKED, DEFAULT_COLOR, applyChannel } from "./ui.js";
import { upgradeRules, effectiveStats, STAT_STEP } from "../server/upgrades.js";
import { CHARACTER_GROUPS } from "./character-groups.js";
applyChannel();

const SWATCHES = ["#a78bfa", "#60a5fa", "#34d399", "#fbbf24", "#f87171", "#f472b6", "#e5e7eb", "#22d3ee"];
const form = $("#profile-form"), saveBtn = $("#save"), saveSignin = $("#save-signin"), status = $("#save-status");
const colorInput = $("#color");
// Cosmetic kinds (server/cosmetics.js): the profile field that wears each, how its tiles look, and its words.
const KINDS = {
  recolor: { field: "recolor", look: "char", none: "Original colors", noun: "recolor" },
  petcolor: { field: "petColor", look: "pet", none: "Original colors", noun: "pet color" },
  accessory: { field: "accessory", look: "char", none: "No accessory", noun: "accessory" },
  trail: { field: "trail", look: "sample", none: "No trail", noun: "trail" },
  effect: { field: "winEffect", look: "sample", none: "No win effect", noun: "win effect" },
  taunt: { field: "taunt", look: "text", none: "No taunt", noun: "taunt" },
  title: { field: "title", look: "text", none: "No title", noun: "title" },
};
const LOOK_FIELDS = Object.values(KINDS).map((k) => k.field);
const emptyOwned = () => ({ pets: [], hats: [], ...Object.fromEntries(Object.keys(KINDS).map((k) => [k, []])), slots: 1 });
const state = { session: null, catalog: [], profile: null, leaderboard: [], config: null, shop: null, owned: emptyOwned(),
  d: null,          // the loadout being edited: { avatar, color, defaultAbility, stats, hat, pet, ...LOOK_FIELDS }
  slot: 0,          // the build slot being edited; the profile's own build is the one on stream
  builds: [],       // saved loadouts per slot (GET /api/profile builds), null for a slot never saved
  drafts: [],       // unsaved edits per slot, kept while switching between builds
  filter: { q: "", group: "all" } };
const stage = addStage($("#preview"));
// The 3D fighter above the on-stream preview loads after the page works; without WebGL the card keeps the 2D stage.
let fighter3d = null;
if (!navigator.connection?.saveData) {
  import("./fighter3d.js").then(({ createFighter3D }) => {
    $("#showcase").hidden = false;
    try { fighter3d = createFighter3D($("#preview3d")); } catch { $("#showcase").hidden = true; return; }
    $(".fighter-card").classList.add("has-3d");
    render3d();
  }).catch(() => {});
}
function render3d() {
  if (!fighter3d || !state.d) return;
  const d = state.d, entry = entryOf(d.avatar), pet = petById(d.pet);
  const look = composeLook(entry, { hat: d.hat, pet, looks: looks(d) });
  if (look) fighter3d.set(look); else if (entry) whenImage(entry.url, render3d);
  if (pet?.url) whenImage(pet.url, render3d);
}
onLooksReady($("#preview3d"), render3d);
const pct = (n) => Math.round(n * STAT_STEP * 100) + "%";
const STAT_TEXT = {
  power: { label: "Power", effect: (n) => "+" + pct(n) + " damage dealt" },
  guard: { label: "Guard", effect: (n) => "−" + pct(n) + " damage taken" },
  luck: { label: "Luck", effect: (n) => pct(n) + " of misses still hit" },
};
const REASONS = { in_duel: "finish your open challenge or duel before moving upgrade points.", invalid_upgrades: "those upgrades need more wins.", hat_locked: "that hat needs more wins.",
  pet_locked: "buy that pet first.", not_enough: "you don't have enough dollars.", owned: "you already own it.", no_fighter: "save your fighter first.",
  already_unlocked: "your wins already unlock it.", hats_not_for_sale: "hats aren't for sale on this channel.", unknown_item: "that item isn't in the shop anymore.",
  item_locked: "buy that item first.", invalid_build: "that build slot isn't yours yet.", max_slots: "you already have the most builds (5)." };

const STATS = ["power", "guard", "luck"];
const str = (v) => (typeof v === "string" ? v : "");
const rules = () => upgradeRules(state.profile?.wins || 0, state.profile?.bonus || 0);
// A saved build (or profile) as an editable loadout, with only ids this page knows.
function loadoutOf(b) {
  const p = state.profile;
  return {
    avatar: state.catalog.some((x) => x.id === b?.avatar) ? b.avatar : state.catalog[0]?.id || "",
    color: /^#[0-9a-f]{6}$/i.test(b?.color || "") ? b.color.toLowerCase() : DEFAULT_COLOR,
    defaultAbility: str(b?.defaultAbility) || p?.defaultAbility || "strike",   // only used by the HP fight
    stats: effectiveStats(b?.stats, p?.wins || 0, p?.bonus || 0),
    hat: str(b?.hat), pet: str(b?.pet),
    ...Object.fromEntries(LOOK_FIELDS.map((f) => [f, str(b?.[f])])),
  };
}
const copy = (d) => ({ ...d, stats: { ...d.stats } });
const same = (a, b) => Boolean(a && b) && ["avatar", "color", "hat", "pet", ...LOOK_FIELDS].every((f) => a[f] === b[f]) && STATS.every((k) => (a.stats?.[k] || 0) === (b.stats?.[k] || 0));
const current = () => ({ ...copy(state.d), build: state.slot });
const activeBuild = () => state.profile?.build || 0;
const savedSlot = () => state.builds[state.slot] ? loadoutOf(state.builds[state.slot]) : null;
const dirty = () => Boolean(state.profile) && (state.slot !== activeBuild() || !same(state.d, savedSlot()));
// Edits that leaving the page would lose, in any build. Only looking at another saved build loses nothing.
const unsavedIn = (d, slot) => !same(d, state.builds[slot] ? loadoutOf(state.builds[slot]) : null);
const edited = () => Boolean(state.profile) && (unsavedIn(state.d, state.slot) || state.drafts.some((d, i) => d && i !== state.slot && unsavedIn(d, i)));
const petById = (id) => state.shop?.pets.find((x) => x.id === id) || null;
const entryOf = (id) => state.catalog.find((x) => x.id === id) || null;
const looks = (d = state.d) => Object.fromEntries(LOOK_FIELDS.map((f) => [f, d[f]]));
const boostText = (b) => b?.power && b.power === b.guard && b.power === b.luck ? "+" + b.power + " to all stats" : STATS.filter((k) => b?.[k]).map((k) => "+" + b[k] + " " + k).join(", ");
const TIER_NAMES = { common: "Common", uncommon: "Uncommon", rare: "Rare", epic: "Epic", legendary: "Legendary" };
const canShop = () => Boolean(state.session?.user && state.profile) && !state.off;
const signedIn = () => Boolean(state.session?.user);
const money = (n) => "$" + (n || 0);

// What the fighter owns: hats unlocked by wins count as owned, and "none" always is.
function owns(kind, id) {
  if (!id) return true;
  if (kind === "hat") return rules().hats.some((x) => x.id === id && x.unlocked) || state.owned.hats.includes(id);
  if (kind === "pet") return state.owned.pets.includes(id);
  return (state.owned[kind] || []).includes(id);
}
const itemLabel = (kind, id) => kind === "hat" ? (rules().hats.find((x) => x.id === id)?.label || id) + " hat" : kind === "pet" ? petById(id)?.label || id
  : state.shop?.items?.[kind]?.find((x) => x.id === id)?.label || id;
// Worn items the fighter doesn't own yet (tried on): saving needs them bought first.
function lockedWorn() {
  const out = [];
  if (!owns("hat", state.d.hat)) out.push(["hat", state.d.hat]);
  if (!owns("pet", state.d.pet)) out.push(["pet", state.d.pet]);
  for (const [kind, k] of Object.entries(KINDS)) if (!owns(kind, state.d[k.field])) out.push([kind, state.d[k.field]]);
  return out;
}

// ---------- tabs ----------
const TABS = ["fighter", "shop", "pets", "ranks"];
const HASH_TAB = { fighter: "fighter", upgrades: "fighter", builds: "fighter", shop: "shop", hats: "shop", "hat-picker": "shop", pets: "pets", "pet-color": "pets", ranks: "ranks", duels: "ranks", leaderboard: "ranks" };
const tabOf = (hash) => HASH_TAB[hash] || (document.getElementById(hash)?.closest("[role=tabpanel]")?.id.replace("panel-", "")) || null;
function showTab(name, { focus = false, hash = name, scroll = true } = {}) {
  for (const t of TABS) {
    const tab = $("#tab-" + t), on = t === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $("#panel-" + t).hidden = !on;
  }
  if (focus) $("#tab-" + name).focus();
  if (location.hash.slice(1) !== hash) history.replaceState(null, "", location.pathname + location.search + "#" + hash);
  if (!scroll) return;
  // A section link scrolls to its section; a plain tab switch keeps the tabs in view (under the sticky stage on phones).
  const target = hash !== name && document.getElementById(hash);
  const el = target && target.closest("[role=tabpanel]") ? target : $(".hero-pick .tabs");
  if (el.getBoundingClientRect().top < stickyHeight() || target) el.scrollIntoView({ block: "start" });
}
const stickyHeight = () => getComputedStyle($(".hero-card")).position === "sticky" && matchMedia("(max-width: 900px)").matches ? $(".hero-card").offsetHeight : 0;
$(".hero-pick .tabs").addEventListener("click", (e) => { const t = e.target.closest("[role=tab]"); if (t) showTab(t.id.replace("tab-", "")); });
$(".hero-pick .tabs").addEventListener("keydown", (e) => {
  const i = TABS.indexOf(document.activeElement?.id?.replace("tab-", ""));
  if (i < 0) return;
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  showTab(TABS[(next + TABS.length) % TABS.length], { focus: true });
});
// In-page links (#duels, #upgrades, …) open their tab first.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href^='#']");
  const hash = a?.getAttribute("href").slice(1), tab = hash && tabOf(hash);
  if (!tab || $("#fighter").hidden) return;
  e.preventDefault();
  showTab(tab, { hash });
});
addEventListener("hashchange", () => { const hash = location.hash.slice(1), tab = tabOf(hash); if (tab) showTab(tab, { hash }); });
// On phones the stage sticks to the top, so focused fields and section jumps scroll clear of it.
new ResizeObserver(() => { document.documentElement.style.scrollPaddingTop = (stickyHeight() + 16) + "px"; }).observe($(".hero-card"));

// ---------- shop ----------
// The first click on a Buy button asks to confirm, the second spends the dollars. A bought item is worn right away;
// Save brings it on stream. A bought build slot opens as a copy of the build being edited.
async function buy(kind, item, label, price, btn, out, text = "Buy for $" + price) {
  if (btn.dataset.confirm !== "1") {
    btn.dataset.confirm = "1";
    btn.textContent = "Confirm: spend $" + price;
    setTimeout(() => { if (btn.isConnected && btn.dataset.confirm === "1") { btn.dataset.confirm = ""; btn.textContent = text; } }, 6000);
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
  if (!r.ok) { btn.disabled = false; btn.dataset.confirm = ""; btn.textContent = text; setStatus(out, "Not bought: " + (REASONS[r.data?.error] || errorText(r)), "error"); return; }
  state.profile = { ...state.profile, dollars: r.data.dollars };
  state.owned = { ...emptyOwned(), ...(r.data.owned || state.owned) };
  if (kind === "slot") { switchBuild(state.owned.slots - 1, copy(state.d)); }
  else if (kind === "pet") state.d.pet = item;
  else if (kind === "hat") state.d.hat = item;
  else state.d[KINDS[kind].field] = item;
  renderAll();
  setStatus(out, kind === "slot" ? "Bought build " + state.owned.slots + " for $" + price + ". It starts as a copy; change it and save to put it on stream."
    : "Bought " + label + " for $" + price + ". Save your fighter to bring it on stream.", "ok");
}
const buyButton = (kind, item, label, price, out, text = "Buy for $" + price) => {
  const short = canShop() && (state.profile.dollars || 0) < price;
  return h("button", { type: "button", class: "btn btn-small buy", disabled: !canShop() || short, title: short ? "You have $" + (state.profile.dollars || 0) : null,
    "aria-label": "Buy " + label + " for $" + price, onclick: (e) => buy(kind, item, label, price, e.currentTarget, out, text) }, text);
};
// One picker tile: a radio (name = kind) with its picture and words, plus a Buy button while it isn't owned.
// Anything can be picked to try it on in the preview; Save asks for the unowned ones to be bought first.
function tile({ kind, id, label, visual, tag, price, buyLabel, out, onPick }) {
  const inputId = kind + "-" + (id || "none"), have = owns(kind, id);
  const input = h("input", { type: "radio", name: kind, id: inputId, value: id });
  input.addEventListener("change", () => { onPick(id); tryOnNote(kind, id, out); renderPreview(); renderSave(); });
  return h("div", { class: "char-option" + (have ? "" : " locked") }, input,
    h("label", { for: inputId }, visual, h("span", {}, label), tag ? h("span", { class: "tag" }, tag) : null),
    !have && price > 0 ? buyButton(kind, id, buyLabel || label, price, out) : null);
}
function tryOnNote(kind, id, out) {
  if (owns(kind, id)) { setStatus(out, ""); return; }
  setStatus(out, "Trying on " + itemLabel(kind, id) + " in the preview. " + (canShop() ? "Buy it to wear it on stream." : signedIn() ? "Save your fighter, then buy it to wear it." : "Sign in to buy it."));
}
const checkPicked = (box, kind, value) => { const r = box.querySelector("input[value='" + CSS.escape(value) + "']"); if (r) r.checked = true; else box.querySelectorAll("input").forEach((x) => { x.checked = false; }); };

// Thumbnails that show the picked character wearing an item; they follow the character as it changes.
const lookSprites = [];
const charThumb = (opts) => {
  const canvas = h("canvas", { class: "sprite", width: 48, height: 48, "aria-hidden": "true" });
  const s = addSprite(canvas, entryOf(state.d.avatar), { active: () => false, ...opts });
  lookSprites.push(s);
  return canvas;
};

function renderHats() {
  const r = rules(), box = $("#hats"), out = $("#hat-status");
  box.replaceChildren(...r.hats.map((hat) => {
    const price = (state.shop?.hatPricePerWin || 0) * hat.wins, have = owns("hat", hat.id);
    return tile({ kind: "hat", id: hat.id, label: hat.label, visual: charThumb({ hat: hat.id }), price, buyLabel: hat.label + " hat", out,
      tag: have ? null : "Unlocks at " + hat.wins + (hat.wins === 1 ? " win" : " wins"), onPick: (id) => { state.d.hat = id; } });
  }));
  checkPicked(box, "hat", state.d.hat);
  const locked = r.hats.filter((x) => !owns("hat", x.id)).length;
  $("#hat-note").textContent = locked ? "(" + locked + (state.shop?.hatPricePerWin ? " unlock with wins or dollars)" : " unlock with wins)") : "";
}

function renderItems(kind) {
  const k = KINDS[kind], box = $("#items-" + kind), out = $("#status-" + kind), list = state.shop?.items?.[kind];
  if (!list) { box.replaceChildren(h("p", { class: "muted small" }, "The shop couldn't load. Reload to try again.")); return; }
  const pet = petById(state.d.pet) || state.shop.pets[0];
  const visual = (id) => {
    if (k.look === "char") return charThumb({ looks: { [k.field]: id } });
    if (k.look === "pet") { const c = h("canvas", { class: "sprite", width: 48, height: 48, "aria-hidden": "true" }); if (pet) addPet(c, pet, { color: id }); return c; }
    if (k.look === "sample") { const c = h("canvas", { class: "sprite sample", width: 64, height: 48, "aria-hidden": "true" }); if (id) addCosmeticSample(c, kind, id); return c; }
    return null;
  };
  const text = (item) => kind === "taunt" ? "“" + item.label + "”" : item.label;
  box.replaceChildren(
    tile({ kind, id: "", label: k.none, visual: visual(""), out, onPick: (id) => { state.d[k.field] = id; } }),
    ...list.map((item) => tile({ kind, id: item.id, label: text(item), visual: visual(item.id), price: item.price, buyLabel: item.label + (kind === "accessory" || kind === "trail" || kind === "effect" ? "" : " " + k.noun), out,
      onPick: (id) => { state.d[k.field] = id; if (kind === "petcolor") renderPets(); if ((kind === "effect" || kind === "taunt") && id) stage.play(); } })));
  if (kind === "title") box.querySelectorAll(".char-option label > span:first-of-type").forEach((s) => s.classList.add("title-text"));
  checkPicked(box, kind, state.d[k.field]);
  const have = state.owned[kind]?.length || 0;
  $("#note-" + kind).textContent = list[0]?.price ? "(" + money(list[0].price) + " each" + (canShop() ? ", you own " + have : "") + ")" : "";
}

// Pets: tier, boost and price; a bought pet adds to the stats on top of the upgrade limit.
function renderPets() {
  const box = $("#pet-list"), out = $("#pet-status");
  if (!state.shop) { box.replaceChildren(h("p", { class: "muted small" }, "Pets couldn't load. Reload to try again.")); return; }
  const option = (pet) => {
    const canvas = h("canvas", { class: "sprite", width: 48, height: 48, "aria-hidden": "true" });
    if (pet) addPet(canvas, pet, { color: state.d.petColor });
    return tile({ kind: "pet", id: pet?.id || "", label: pet ? pet.label : "No pet", visual: canvas, price: pet?.price, out,
      tag: pet ? TIER_NAMES[pet.tier] + ", " + boostText(pet.boost) : null, onPick: (id) => { state.d.pet = id; renderUpgrades(); renderItems("petcolor"); } });
  };
  box.replaceChildren(option(null), ...state.shop.pets.map(option));
  checkPicked(box, "pet", state.d.pet);
  $("#pet-note").textContent = canShop() ? "(you own " + state.owned.pets.length + ", you have " + money(state.profile.dollars) + ")" : "";
  $("#petcolor-help").textContent = petById(state.d.pet) ? "Tints your pet on stream." : "Tints your pet on stream. The samples show a " + (state.shop.pets[0]?.label || "pet") + " until you pick one.";
}

// ---------- fighter tab ----------
// Builds: one free slot, more for dollars. Each keeps its own loadout; saving one puts it on stream.
function switchBuild(slot, start = null) {
  state.drafts[state.slot] = copy(state.d);
  state.slot = slot;
  state.d = state.drafts[slot] || start || (state.builds[slot] ? loadoutOf(state.builds[slot]) : copy(state.d));
  if (start) state.drafts[slot] = state.d;
}
function renderBuilds() {
  const box = $("#builds"), list = $("#build-list"), slots = state.owned.slots || 1, prices = state.shop?.slots?.prices || [];
  box.hidden = !canShop();
  if (box.hidden) return;
  const price = slots < (state.shop?.slots?.max || 5) ? prices[slots - 1] : null;
  list.replaceChildren(...Array.from({ length: slots }, (_, i) => {
    const b = state.builds[i], entry = entryOf(b?.avatar), on = i === activeBuild();
    return h("button", { type: "button", class: "build", "aria-pressed": String(i === state.slot), onclick: () => { if (i !== state.slot) { switchBuild(i); renderAll(); } } },
      h("strong", {}, "Build " + (i + 1)), h("span", { class: "muted small" }, on ? "On stream" : b ? entry?.label || b.avatar : "Not saved yet"));
  }), price ? buyButton("slot", "", "build slot " + (slots + 1), price, $("#status-slot"), "Add build " + (slots + 1) + " for $" + price) : null);
  $("#build-note").textContent = "(" + slots + " of " + (state.shop?.slots?.max || 5) + ")";
}

function renderUpgrades() {
  const r = rules(), list = $("#upgrade-list"), canEdit = canShop();
  const used = r.stats.reduce((sum, k) => sum + state.d.stats[k], 0), left = r.points - used;
  $("#points-note").textContent = canEdit ? "(" + left + " of " + r.points + " points free)" : "";
  const from = r.fromCheckins ? " You have " + r.fromWins + " from wins and " + r.fromCheckins + " from check-ins." : "";
  $("#upgrades-help").textContent = canEdit
    ? "Each win and each stream check-in (!checkin in chat) gives a point, up to " + r.maxPoints + "." + from + " Move points between stats whenever you're not in a duel."
    : "Save your fighter, then each win and each stream check-in (!checkin in chat) gives an upgrade point, up to " + r.maxPoints + ".";
  const shown = canEdit ? state.d.stats : { power: 0, guard: 0, luck: 0 };
  const link = $("#points-link");
  link.hidden = !canEdit || left <= 0;
  link.textContent = left + (left === 1 ? " upgrade point" : " upgrade points") + " to spend";
  list.replaceChildren(...r.stats.map((k) => {
    const t = STAT_TEXT[k], n = shown[k], extra = petById(state.d.pet)?.boost?.[k] || 0, total = n + extra;
    const step = (d) => () => { state.d.stats[k] += d; renderUpgrades(); renderSave(); };
    // The plain effect of everything the fighter has in this stat, pet included.
    const effect = total ? t.effect(total) + (extra ? " (" + extra + " from your pet)" : "") : t.effect(1) + " per point";
    return h("div", { class: "upgrade" },
      h("div", { class: "upgrade-name" }, h("strong", {}, t.label), h("span", { class: "muted small" }, effect)),
      h("button", { type: "button", class: "btn btn-small", "aria-label": "Take a point out of " + t.label, disabled: !canEdit || n <= 0, onclick: step(-1) }, "−"),
      h("span", { class: "upgrade-value num", title: extra ? "+" + extra + " from your pet" : null }, n + " / " + r.maxPerStat + (extra ? " +" + extra : "")),
      h("button", { type: "button", class: "btn btn-small", "aria-label": "Put a point into " + t.label, disabled: !canEdit || left <= 0 || n >= r.maxPerStat, onclick: step(1) }, "+"));
  }));
}

// Characters: search by name, filter by group; unfiltered, the list starts with 12 (plus the picked one).
const groupsOf = (entry) => entry.custom ? ["custom"] : CHARACTER_GROUPS.filter((g) => g.ids.includes(entry.id)).map((g) => g.id);
function renderCharacters() {
  const box = $("#characters");
  if (!state.catalog.length) { box.replaceChildren(h("p", { class: "muted small" }, "No characters are available right now. Reload to try again.")); return; }
  $("#char-count").textContent = "(" + state.catalog.length + " available)";
  const groups = [{ id: "all", label: "All" }, ...CHARACTER_GROUPS.filter((g) => state.catalog.some((e) => groupsOf(e).includes(g.id))),
    ...(state.catalog.some((e) => e.custom) ? [{ id: "custom", label: "Channel originals" }] : [])];
  $("#char-groups").replaceChildren(...groups.map((g) => h("button", { type: "button", class: "btn btn-small", "data-group": g.id, "aria-pressed": String(g.id === state.filter.group),
    onclick: () => { state.filter.group = g.id; filterCharacters(); } }, g.label)));
  box.replaceChildren(...state.catalog.map((entry) => {
    const id = "char-" + entry.id;
    const input = h("input", { type: "radio", name: "character", id, value: entry.id });
    input.addEventListener("change", () => { state.d.avatar = entry.id; renderPreview(); renderSave(); });
    const canvas = h("canvas", { class: "sprite", width: 64, height: 64, "aria-hidden": "true" });
    const option = h("div", { class: "char-option", "data-groups": groupsOf(entry).join(" "), "data-name": (entry.label || entry.id).toLowerCase() + " " + entry.id }, input,
      h("label", { for: id }, canvas, h("span", {}, entry.label || entry.id), entry.custom ? h("span", { class: "tag" }, "Channel original") : null));
    let hover = false;
    option.addEventListener("pointerenter", () => { hover = true; });
    option.addEventListener("pointerleave", () => { hover = false; });
    addSprite(canvas, entry, { anim: "walk", active: () => hover || input.checked || document.activeElement === input });
    return option;
  }));
  filterCharacters();
}
function filterCharacters() {
  const q = state.filter.q.trim().toLowerCase(), g = state.filter.group, filtered = Boolean(q) || g !== "all";
  let shown = 0;
  for (const option of $("#characters").children) {
    const match = (!q || option.dataset.name?.includes(q)) && (g === "all" || option.dataset.groups?.split(" ").includes(g));
    option.hidden = !match;
    if (match) shown++;
  }
  for (const b of $("#char-groups").children) b.setAttribute("aria-pressed", String(b.dataset.group === g));
  $("#char-empty").hidden = shown > 0;
  $("#more-chars").hidden = filtered || state.catalog.length <= 12;
  if (filtered) $("#characters").classList.remove("collapsed"); else showAllChars($("#more-chars").getAttribute("aria-expanded") === "true");
}
$("#char-search").addEventListener("input", (e) => { state.filter.q = e.target.value; filterCharacters(); });
function showAllChars(all) {
  const btn = $("#more-chars");
  $("#characters").classList.toggle("collapsed", !all);
  btn.setAttribute("aria-expanded", String(all));
  btn.textContent = all ? "Show fewer characters" : "Show all " + state.catalog.length + " characters";
}
$("#more-chars").addEventListener("click", () => showAllChars($("#characters").classList.contains("collapsed")));

function renderSwatches() {
  const box = $("#swatches");
  box.querySelectorAll(".swatch").forEach((n) => n.remove());
  for (const color of SWATCHES) {
    box.insertBefore(h("button", { type: "button", class: "swatch", style: { background: color }, "aria-label": "Nameplate color " + color, "aria-pressed": "false", "data-color": color,
      onclick: () => { state.d.color = color; colorInput.value = color; renderPreview(); renderSave(); } }), box.querySelector(".custom-color"));
  }
}
colorInput.addEventListener("input", () => { state.d.color = colorInput.value.toLowerCase(); renderPreview(); renderSave(); });

// ---------- preview and save ----------
function renderPreview() {
  const d = state.d, entry = entryOf(d.avatar), user = state.session?.user;
  stage.set({ entry, hat: d.hat, pet: petById(d.pet), color: d.color, name: user?.displayName || user?.login || "you",
    elo: state.profile?.elo ?? state.config?.initialElo ?? 1000, looks: looks(d) });
  render3d();
  const plate = $("#showcase-plate");
  plate.textContent = (user?.displayName || user?.login || "you") + " · " + (state.profile?.elo ?? state.config?.initialElo ?? 1000);
  plate.style.setProperty("--plate", d.color);
  if (lookSprites.entry !== entry) { lookSprites.entry = entry; for (const s of lookSprites) s.set(entry); }
  for (const s of document.querySelectorAll(".swatch")) s.setAttribute("aria-pressed", String(s.dataset.color === d.color));
  colorInput.value = d.color;
  const several = (state.owned.slots || 1) > 1;
  $("#preview-caption").textContent = (entry ? entry.label || entry.id : "") + (several ? " · Build " + (state.slot + 1) : "");
  const words = [entry?.label, d.hat && itemLabel("hat", d.hat), d.accessory && itemLabel("accessory", d.accessory), d.recolor && itemLabel("recolor", d.recolor) + " colors",
    d.pet && "with " + itemLabel("pet", d.pet), d.trail && itemLabel("trail", d.trail) + " trail", d.title && "title " + itemLabel("title", d.title)].filter(Boolean);
  $("#preview").setAttribute("aria-label", "Preview of your fighter on stream: " + (words.join(", ") || "no character yet"));
  $("#play-win").disabled = !d.winEffect && !d.taunt;
  $("#play-win").title = $("#play-win").disabled ? "Pick a win effect or taunt in the Shop to preview it" : "";
}
$("#play-win").addEventListener("click", () => stage.play());

function renderSave() {
  saveBtn.disabled = Boolean(state.off);
  if (signedIn() && state.off === "paused") {
    setStatus(status, state.profile ? "PixFray is off on this channel right now, so saving and buying are closed. Your fighter is kept." : "PixFray is off on this channel right now. You can save a fighter when it's back.");
  } else if (signedIn() && state.profile) {
    const locked = lockedWorn();
    const msg = locked.length ? "Trying on " + locked.map(([k, id]) => itemLabel(k, id)).join(", ") + ". Buy " + (locked.length === 1 ? "it" : "them") + " to save this look."
      : state.slot !== activeBuild() ? "Build " + (state.slot + 1) + " isn't on stream. Save to switch to it."
      : dirty() ? "You have unsaved changes." : fresh() ? "" : "Saved. Your fighter shows up on stream with these settings.";
    setStatus(status, msg, locked.length || dirty() ? "" : "ok");
  } else if (signedIn()) {
    const locked = lockedWorn();
    setStatus(status, locked.length ? "Trying on " + locked.map(([k, id]) => itemLabel(k, id)).join(", ") + ". Save a fighter first, then buy it." : "You don't have a saved profile yet. Pick your fighter and save.");
  }
  saveBtn.textContent = state.slot !== activeBuild() ? "Save and wear build " + (state.slot + 1) : "Save profile";
  renderNextStep();
}

function renderAll() {
  lookSprites.length = 0;
  lookSprites.entry = entryOf(state.d.avatar);
  checkPicked($("#characters"), "character", state.d.avatar);
  renderBuilds(); renderUpgrades(); renderHats(); renderPets();
  for (const kind of Object.keys(KINDS)) renderItems(kind);
  renderSignedIn(); renderPreview(); renderSave();
}

function applyProfile(p) {
  state.owned = { ...emptyOwned(), ...(p?.owned || {}) };
  state.builds = Array.isArray(p?.builds) ? [...p.builds] : [];
  if (p && !state.builds[p.build || 0]) state.builds[p.build || 0] = p;   // the active build is always the profile itself
  state.slot = p?.build || 0;
  state.drafts = [];
  state.d = loadoutOf(p);
}

function renderCommands() {
  if (state.config) {
    $("#cmd-timeout").textContent = seconds(state.config.challengeTimeoutMs);
    $("#cmd-rematch").textContent = seconds(state.config.rematchDelayMs);
    const pts = state.config.checkinPoints ?? 1;
    $("#cmd-checkin").textContent = pts ? "+" + pts + (pts === 1 ? " upgrade point" : " upgrade points") : "A check-in";
    const c = state.config, win = c.winDollars ?? 5, loss = c.lossDollars ?? 3;
    $("#cmd-dollars").textContent = win || loss ? money(win) + " for a win and " + money(loss) + " for a loss" : "nothing on this channel right now";
    $("#cmd-give").textContent = c.giveEnabled === false ? "Giving dollars is off on this channel." : "Gives dollars to another fighter while the stream is live: up to " + money(c.giveMaxPerStream ?? 100) + " per stream, after your first " + (c.giveMinDuels ?? 5) + " duels.";
    $("#lb-note").textContent = "Ranked duels need a saved profile. Everyone starts at " + state.config.initialElo + " Elo.";
    $("#hp-mode-note").hidden = state.config.quickDuel !== false;
  }
}

const fresh = () => Boolean(state.profile) && !(state.profile.wins + state.profile.losses);
// Until the first duel: what to type in chat now that the fighter is saved.
function renderNextStep() {
  const next = $("#next-step"), show = Boolean(signedIn() && state.profile && !state.off && !dirty() && !lockedWorn().length && fresh());
  next.hidden = !show;
  if (show) next.replaceChildren(h("strong", {}, "Saved. Next: "), "in " + CHANNEL + "'s chat, type ", h("code", {}, "!challenge @friend"), ". They answer ", h("code", {}, "!fight"), ".");
}

// Back from Twitch sign-in (?signed_in=1): say who is signed in and what to do, then drop the flag from the address.
function welcome() {
  const params = new URLSearchParams(location.search), user = state.session?.user;
  if (!params.has("signed_in")) return;
  params.delete("signed_in");
  history.replaceState(null, "", location.pathname + (params.size ? "?" + params : "") + location.hash);
  if (!user) return;
  setStatus(status, "Signed in as " + (user.displayName || user.login) + ". " + (state.profile ? "Your fighter is loaded." : "Pick a fighter and save."), "ok");
  if (!state.profile) $("#fighter").scrollIntoView({ block: "start" });
}

function renderSignedIn() {
  const s = state.session, note = $("#signin-note");
  renderWho($("#who"), s, signOut);
  saveBtn.hidden = !signedIn();
  saveSignin.hidden = signedIn() || s?.configured === false;
  if (!saveSignin.hidden) $("#who").replaceChildren();   // one sign-in button: the preview card's, next to what it saves
  note.hidden = signedIn();
  if (!s) note.textContent = "Sign-in is unavailable right now, so profiles can't be saved. You can still browse characters and the leaderboard.";
  else if (s.configured === false) note.textContent = "Twitch sign-in isn't set up on this server yet, so profiles can't be saved. You can still browse characters and the leaderboard.";
  else note.textContent = "Sign in with Twitch to save your fighter. It shares only your public Twitch name, and ranked duels need a saved profile.";
  $("#my-stats").hidden = !state.profile;
  if (state.profile) {
    $("#stat-elo").textContent = state.profile.elo;
    $("#stat-wl").textContent = state.profile.wins + " / " + state.profile.losses;
    $("#stat-dollars").textContent = money(state.profile.dollars);
    $("#stat-streak").textContent = state.profile.streak || 0;
  }
  $("#shop-note").textContent = (canShop() ? "You have " + money(state.profile.dollars) + ". " : "") + "Spend the PixFray dollars you earn in duels. Everything here changes looks only, not stats, and you can wear it in any build.";
}

function renderLeaderboard() {
  const tbody = $("#leaderboard tbody"), me = state.session?.user?.id, rows = state.leaderboard;
  if (!rows.length) {
    tbody.replaceChildren(h("tr", { class: "empty" }, h("td", { colspan: 6 },
      h("strong", {}, "No ranked duels yet, so the top spot is open."), " To get on the board: ",
      signedIn() ? "save your fighter in the Fighter tab" : "sign in and save your fighter in the Fighter tab",
      ", then type ", h("code", {}, "!challenge @viewer"), " in chat while the stream is live.")));
    return;
  }
  const character = (id) => {   // still thumbnail; it never animates in the table
    const entry = entryOf(id), canvas = h("canvas", { class: "sprite", width: 32, height: 32, "aria-hidden": "true" });
    if (entry) addSprite(canvas, entry, { active: () => false });
    return [entry ? canvas : null, entry?.label || id];
  };
  const row = (p, i) => h("tr", { class: [p.userId === me ? "me" : "", i < 3 ? "podium" : ""].filter(Boolean).join(" ") || null },
    h("td", { class: "num" }, i + 1), h("td", {}, h("span", { style: { color: p.color }, "aria-hidden": "true" }, "■ "), p.displayName || p.username, p.userId === me ? h("span", { class: "muted" }, " (you)") : null),
    h("td", { class: "col-char" }, ...character(p.avatar)), h("td", { class: "num" }, p.elo), h("td", { class: "num" }, p.wins), h("td", { class: "num" }, p.losses));
  const top = rows.slice(0, 10).map(row);
  const mine = rows.findIndex((p) => p.userId === me);
  if (mine >= 10) top.push(row(rows[mine], mine));
  tbody.replaceChildren(...top);
}

async function loadLeaderboard() {
  const r = await api("/api/leaderboard/" + CHANNEL);
  if (r.ok && Array.isArray(r.data)) { state.leaderboard = r.data; renderLeaderboard(); }
  else $("#leaderboard tbody").replaceChildren(h("tr", {}, h("td", { colspan: 6, class: "muted" }, "Couldn't load the leaderboard: " + errorText(r))));
}

addEventListener("beforeunload", (e) => { if (signedIn() && edited()) e.preventDefault(); });
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!signedIn()) return;
  const body = current();
  if (!body.avatar) { setStatus(status, "Pick a character first.", "error"); return; }
  const locked = lockedWorn();
  if (locked.length) { setStatus(status, "Not saved: buy " + locked.map(([k, id]) => itemLabel(k, id)).join(", ") + " first, or pick something you own.", "error"); return; }
  saveBtn.disabled = true;
  setStatus(status, "Saving…");
  const r = await api("/api/profile/" + CHANNEL, { method: "POST", body });
  saveBtn.disabled = false;
  if (r.status === 401) { state.session = { ...state.session, user: null }; renderSignedIn(); setStatus(status, "Your session expired. Sign in again to save.", "error"); return; }
  if (!r.ok) { setStatus(status, "Not saved: " + (REASONS[r.data?.error] || errorText(r)), "error"); return; }
  const drafts = state.drafts.map((d, i) => (i === body.build ? null : d));
  state.profile = { owned: state.owned, ...r.data.profile };
  applyProfile(state.profile);
  state.drafts = drafts;   // unsaved edits in the other builds stay
  renderAll(); loadLeaderboard();
});

// The channel is turned off (paused) or was never set up (server/channels.js).
function showOff(off) {
  const note = $("#off-note");
  note.hidden = false;
  if (off === "paused") { note.textContent = "PixFray is off on " + CHANNEL + "'s channel right now. Saved fighters and ranks are kept for when it's back."; return; }
  note.replaceChildren("PixFray isn't set up on " + CHANNEL + "'s channel. ", h("a", { href: "/" }, "Pick another channel"), ".");
  for (const el of [form, $(".fighter-card"), $(".hero-pick .tabs")]) el.hidden = true;
  $("#panel-ranks").hidden = false;
}

async function init() {
  renderSwatches();
  const [session, catalog, live, shop] = await Promise.all([api("/api/session"), api("/api/catalog/" + CHANNEL), api("/api/state/" + CHANNEL), api("/api/shop/" + CHANNEL)]);
  let list = shop.ok && Array.isArray(shop.data?.pets) ? shop.data : null;
  if (!list) { const pets = await api("/api/pets/" + CHANNEL); list = pets.ok && Array.isArray(pets.data?.pets) ? pets.data : null; }   // pets still work without the shop list
  state.shop = list;
  state.session = session.ok ? session.data : null;
  state.catalog = catalog.ok && Array.isArray(catalog.data) ? catalog.data : [];
  if (!state.catalog.length) {
    const fallback = await api("/assets/characters.json");   // the static list still works if the API is down
    if (fallback.ok && Array.isArray(fallback.data)) state.catalog = fallback.data;
  }
  state.config = live.ok ? live.data?.config : null;
  const hash = location.hash.slice(1);
  showTab(tabOf(hash) || "fighter", { hash: tabOf(hash) ? hash : "fighter", scroll: Boolean(tabOf(hash)) && hash !== "fighter" });
  if (live.status === 403 && live.data?.off) { state.off = live.data.off; showOff(live.data.off); }
  renderCharacters(); renderCommands();
  if (signedIn()) {
    const [profile, access] = await Promise.all([api("/api/profile/" + CHANNEL), api("/api/access/" + CHANNEL)]);
    state.profile = profile.ok ? profile.data : null;
    $("#admin-link").hidden = !(access.ok && access.data?.canManage);
  }
  applyProfile(state.profile);
  renderAll(); welcome();
  loadLeaderboard();
}
// The bare site (no ?channel=) asks which stream the viewer watches, so nobody saves a fighter on the wrong channel.
async function pickChannel() {
  document.title = "PixFray: pick your stream";
  for (const el of [$("#fighter"), $("main.page:not(#pick)"), $(".topbar nav")]) if (el) el.hidden = true;
  $("#pick").hidden = false;
  const [session, list] = await Promise.all([api("/api/session"), api("/api/channels")]);
  // Signing in happens on a channel's page, so the picker shows only who is already signed in.
  if (session.ok && session.data?.user) renderWho($("#who"), session.data, signOut); else $("#who").replaceChildren();
  const channels = list.ok && Array.isArray(list.data?.channels) ? list.data.channels : ["nesszerra", "miolafff"];
  $("#channel-list").replaceChildren(...channels.map((c) => h("li", {}, h("a", { class: "channel", href: "/?channel=" + encodeURIComponent(c) },
    h("span", { class: "channel-name" }, c), h("span", { class: "channel-go" }, "Pick your fighter")))));
}
if (CHANNEL_PICKED) init(); else pickChannel();
