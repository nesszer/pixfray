// Viewer dashboard ("/"): an on-stream preview above the Fighter, Shop, Pets, Ranks and Rules tabs, or the /play/
// channel picker without ?channel=. Talks only to the routes in docs/CONTRACTS.md section 2.
// Each part lives in src/dashboard/; this entry wires the tabs and loads the page.
import { api, $, tabKey, CHANNEL, CHANNEL_PICKED, applyChannel } from "./ui.ts";
import { skyBackdrop } from "./scrub.ts";
import { initSpriteMaker } from "./sprite-maker.ts";
import { parseAnswer, parseProfileOrNone, parseSession, parseShop, parseStateConfig, parseAccess } from "./parse.ts";
import type { Profile } from "./parse.ts";
import { state, KINDS, emptyOwned, voxAll, loadoutOf, entryOf, signedIn } from "./dashboard/state.ts";
import type { KindKey } from "./dashboard/state.ts";
import { renderHats, renderItems, renderPets, checkPicked, lookSprites, lookVox } from "./dashboard/shop.ts";
import { renderBuilds, renderUpgrades, renderCharacters, renderSwatches, renderPreview } from "./dashboard/fighter.ts";
import {
  renderSave,
  renderSignedIn,
  welcome,
  restoreDraft,
  loadOthers,
  showOff,
  tuckSaveBar,
  watchSaveBar,
  KNOWN_KEY,
} from "./dashboard/save.ts";
import { renderCommands, loadLeaderboard } from "./dashboard/ranks.ts";
import { pickChannel } from "./dashboard/picker.ts";
skyBackdrop();
applyChannel();

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
const tabs = $(".hero-pick .tabs"),
  card = $(".hero-card");
const tabOf = (hash: string) =>
  HASH_TAB[hash] || document.getElementById(hash)?.closest("[role=tabpanel]")?.id.replace("panel-", "") || null;
function showTab(
  name: string,
  // hash may be undefined: the default then applies
  { focus = false, hash = name, scroll = true }: { focus?: boolean; hash?: string | undefined; scroll?: boolean } = {},
) {
  document.documentElement.dataset.tab = name;
  tuckSaveBar();
  for (const t of TABS) {
    const tab = $("#tab-" + t),
      on = t === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $("#panel-" + t).hidden = !on;
  }
  if (focus) $("#tab-" + name).focus();
  const part = name === "shop" && showShopPart(hash);
  requestAnimationFrame(() => {
    voxAll?.();
    document.dispatchEvent(new Event("pixfray:tab"));
  });
  if (location.hash.slice(1) !== hash) history.replaceState(null, "", location.pathname + location.search + "#" + hash);
  if (!scroll) return;
  // A section link scrolls to its section; a plain tab switch keeps the tabs in view (under the sticky stage on phones).
  const target = hash !== name && !part && document.getElementById(hash);
  const el = target && target.closest("[role=tabpanel]") ? target : tabs;
  if (el.getBoundingClientRect().top < stickyHeight() || target) el.scrollIntoView({ block: "start" });
}
const stickyHeight = () =>
  getComputedStyle(card).position === "sticky" && matchMedia("(max-width: 900px)").matches ? card.offsetHeight : 0;
tabs.addEventListener("click", (e) => {
  const t = (e.target as Element).closest("[role=tab]"); // as Element: a click's target is an element
  if (t) showTab(t.id.replace("tab-", ""));
});
tabs.addEventListener("keydown", (e) => {
  // as string: indexOf finds no undefined
  const i = TABS.indexOf(document.activeElement?.id?.replace("tab-", "") as string),
    next = i < 0 ? undefined : tabKey(TABS, i, e.key);
  if (!next) return;
  e.preventDefault();
  showTab(next, { focus: true });
});
// In-page links (#duels, #upgrades, …) open their tab first.
document.addEventListener("click", (e) => {
  const a = (e.target as Element).closest("a[href^='#']"); // as Element: a click's target is an element
  const hash = a?.getAttribute("href")!.slice(1), // !: the selector matched a[href^='#'], so it has an href
    tab = hash && tabOf(hash);
  if (!tab || $("#fighter").hidden) return;
  e.preventDefault();
  showTab(tab, { hash });
});
addEventListener("hashchange", () => {
  const hash = location.hash.slice(1),
    tab = tabOf(hash);
  if (tab) showTab(tab, { hash });
});
// On phones the stage sticks to the top, so focused fields and section jumps scroll clear of it; when the preview
// is compact the tabs stick under it, so the padding covers both.
new ResizeObserver(() => {
  const root = document.documentElement,
    stuck = stickyHeight(),
    under = root.classList.contains("compact") && stuck ? tabs.offsetHeight : 0;
  root.style.setProperty("--stuck-h", stuck + "px");
  root.style.scrollPaddingTop = stuck + under + 16 + "px";
}).observe(card);

// The shop shows one section at a time: its section links act as sub-tabs, so the panel stays one screen long.
const shopLinks = [...document.querySelectorAll<HTMLAnchorElement>(".jump a")],
  // !: every .jump link in the page HTML has an href
  shopParts = shopLinks.map((a) => document.getElementById(a.getAttribute("href")!.slice(1)));
function showShopPart(id: string | null) {
  const target = id && document.getElementById(id),
    i = shopParts.findIndex((el) => el && target && el.contains(target));
  if (i < 0 && id) return false; // a plain tab switch keeps the section picked earlier
  shopParts.forEach((el, j) => {
    el!.hidden = j !== Math.max(0, i); // el!: each .jump link names a section in the page HTML (a missing one throws)
  });
  shopLinks.forEach((a, j) => a.toggleAttribute("aria-current", j === Math.max(0, i)));
  return i >= 0;
}
showShopPart(null);

export function renderAll() {
  lookSprites.length = 0;
  lookVox.length = 0;
  lookSprites.entry = entryOf(state.d.avatar);
  checkPicked($("#characters"), state.d.avatar);
  renderBuilds();
  renderUpgrades();
  renderHats();
  renderPets();
  for (const kind of Object.keys(KINDS) as KindKey[]) renderItems(kind); // as: Object.keys types its keys as string
  renderSignedIn();
  renderPreview();
  renderSave();
}

export function applyProfile(p: Profile | null) {
  state.owned = { ...emptyOwned(), ...p?.owned };
  state.builds = Array.isArray(p?.builds) ? [...p.builds] : [];
  if (p && !state.builds[p.build || 0]) state.builds[p.build || 0] = p; // the active build is always the profile itself
  state.slot = p?.build || 0;
  state.drafts = [];
  state.d = loadoutOf(p);
}

const loadProfile = () => api("/api/profile/" + CHANNEL).then((r) => parseAnswer(r, parseProfileOrNone, "the profile"));
async function init() {
  renderSwatches();
  const calls = Promise.all([
    api("/api/session").then((r) => parseAnswer(r, parseSession, "the session")),
    api("/api/catalog/" + CHANNEL),
    api("/api/state/" + CHANNEL).then((r) => parseAnswer(r, parseStateConfig, "the channel config")),
    api("/api/shop/" + CHANNEL).then((r) => parseAnswer(r, parseShop, "the shop")),
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
  let list = shop.ok ? shop.data : null;
  if (!list) {
    const pets = parseAnswer(await api("/api/pets/" + CHANNEL), parseShop, "the pet list");
    list = pets.ok ? pets.data : null;
  } // pets still work without the shop list
  state.shop = list;
  state.session = session.ok ? session.data : null;
  if (catalog.ok && Array.isArray(catalog.data) && catalog.data.length) state.catalog = catalog.data; // else the static list stays
  state.config = live.ok ? live.data : null;
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
    const [profile, access] = await Promise.all([
      loadProfile(),
      api("/api/access/" + CHANNEL).then((r) => parseAnswer(r, parseAccess, "the access check")),
    ]);
    state.profile = profile.ok ? profile.data : null;
    $("#admin-link").hidden = !(access.ok && access.data.canManage);
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
  const [catalog, profile] = await Promise.all([api("/api/catalog/" + CHANNEL), loadProfile()]);
  if (catalog.ok && Array.isArray(catalog.data) && catalog.data.length) state.catalog = catalog.data;
  if (profile.ok) state.profile = profile.data;
  applyProfile(state.profile);
  renderCharacters();
  renderAll();
}
// Phones: once the tabs scroll under the stuck preview, it shrinks to a short strip so the choices get the screen.
// Shrinking moves the page, so it switches back only after scrolling clearly above the tabs.
function compactPreview() {
  const root = document.documentElement;
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
