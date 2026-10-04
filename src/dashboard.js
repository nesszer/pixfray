// Viewer dashboard ("/"): sign-in state, character picker with live preview, nameplate color,
// profile save and a compact leaderboard. Talks only to the routes in CONTRACTS.md section 2.
import { api, errorText, h, $, setStatus, renderWho, signOut, addSprite, addPet, seconds, CHANNEL, CHANNEL_PICKED, DEFAULT_COLOR, applyChannel } from "./ui.js";
import { upgradeRules, effectiveStats, STAT_STEP } from "../server/upgrades.js";
applyChannel();

const SWATCHES = ["#a78bfa", "#60a5fa", "#34d399", "#fbbf24", "#f87171", "#f472b6", "#e5e7eb", "#22d3ee"];
const form = $("#profile-form"), saveBtn = $("#save"), saveSignin = $("#save-signin"), status = $("#save-status");
const colorInput = $("#color"), nameplate = $("#nameplate");
const state = { session: null, catalog: [], profile: null, saved: null, leaderboard: [], config: null, stats: { power: 0, guard: 0, luck: 0 }, hat: "", pet: "",
  shop: null, owned: { pets: [], hats: [] } };   // shop = GET /api/pets: { pets, hatPricePerWin }
const preview = addSprite($("#preview"), null, { anim: "walk" });
const pct = (n) => Math.round(n * STAT_STEP * 100) + "%";
const STAT_TEXT = {
  power: { label: "Power", effect: (n) => "+" + pct(n) + " damage dealt" },
  guard: { label: "Guard", effect: (n) => "−" + pct(n) + " damage taken" },
  luck: { label: "Luck", effect: (n) => pct(n) + " of misses still hit" },
};
const REASONS = { in_duel: "finish your open challenge or duel before moving upgrade points.", invalid_upgrades: "those upgrades need more wins.", hat_locked: "that hat needs more wins.",
  pet_locked: "buy that pet first.", not_enough: "you don't have enough dollars.", owned: "you already own it.", no_fighter: "save your fighter first.",
  already_unlocked: "your wins already unlock it.", hats_not_for_sale: "hats aren't for sale on this channel.", unknown_item: "that item isn't in the shop anymore." };

const current = () => ({
  avatar: form.querySelector("input[name=character]:checked")?.value || state.catalog[0]?.id || "",
  color: colorInput.value.toLowerCase(),
  defaultAbility: state.profile?.defaultAbility || "strike",   // only used by the HP fight; quick duels ignore it
  stats: { ...state.stats },
  hat: state.hat,
  pet: state.pet,
});
const sameStats = (a, b) => ["power", "guard", "luck"].every((k) => (a?.[k] || 0) === (b?.[k] || 0));
const dirty = () => { const c = current(), s = state.saved; return !s || c.avatar !== s.avatar || c.color !== s.color || c.hat !== s.hat || c.pet !== s.pet || !sameStats(c.stats, s.stats); };
const rules = () => upgradeRules(state.profile?.wins || 0, state.profile?.bonus || 0);
const savedOf = (p) => ({ avatar: p.avatar, color: p.color.toLowerCase(), defaultAbility: p.defaultAbility, hat: p.hat || "", pet: p.pet || "", stats: { ...p.stats } });
const petById = (id) => state.shop?.pets.find((x) => x.id === id) || null;
const STATS = ["power", "guard", "luck"];
const boostText = (b) => b?.power && b.power === b.guard && b.power === b.luck ? "+" + b.power + " to all stats" : STATS.filter((k) => b?.[k]).map((k) => "+" + b[k] + " " + k).join(", ");
const TIER_NAMES = { common: "Common", uncommon: "Uncommon", rare: "Rare", epic: "Epic", legendary: "Legendary" };
const canShop = () => Boolean(state.session?.user && state.profile);

// Shop: the first click on a Buy button asks to confirm, the second spends the dollars. Bought items are picked
// right away; Save brings them on stream.
async function buy(kind, item, label, price, btn, out) {
  if (btn.dataset.confirm !== "1") {
    btn.dataset.confirm = "1";
    btn.textContent = "Confirm: spend $" + price;
    setTimeout(() => { if (btn.isConnected && btn.dataset.confirm === "1") { btn.dataset.confirm = ""; btn.textContent = "Buy for $" + price; } }, 6000);
    return;
  }
  btn.disabled = true;
  setStatus(out, "Buying…");
  const r = await api("/api/shop/" + CHANNEL, { method: "POST", body: { kind, id: item } });
  if (!r.ok) { btn.disabled = false; btn.dataset.confirm = ""; btn.textContent = "Buy for $" + price; setStatus(out, "Not bought: " + (REASONS[r.data?.error] || errorText(r)), "error"); return; }
  state.profile = { ...state.profile, dollars: r.data.dollars };
  state.owned = r.data.owned || state.owned;
  if (kind === "pet") { state.pet = item; preview.pet(petById(item)); } else { state.hat = item; preview.hat(item); }
  renderSignedIn(); renderPets(); renderHats(); renderUpgrades(); update();
  setStatus(out, "Bought " + label + " for $" + price + ". Save your fighter to bring it on stream.", "ok");
}
const buyButton = (kind, item, label, price, out) => {
  const short = canShop() && (state.profile.dollars || 0) < price;
  return h("button", { type: "button", class: "btn btn-small buy", disabled: !canShop() || short, title: short ? "You have $" + (state.profile.dollars || 0) : null,
    "aria-label": "Buy " + label + " for $" + price, onclick: (e) => buy(kind, item, label, price, e.currentTarget, out) }, "Buy for $" + price);
};

// Pets: the ones a fighter owns can be picked; the rest show their tier, boost and price.
function renderPets() {
  const box = $("#pet-list"), out = $("#pet-status");
  if (!state.shop) { box.replaceChildren(h("p", { class: "muted small" }, "Pets couldn't load. Reload to try again.")); return; }
  const owned = new Set(state.owned.pets);
  const option = (pet) => {
    const id = "pet-" + (pet?.id || "none"), have = !pet || owned.has(pet.id);
    const input = h("input", { type: "radio", name: "pet", id, value: pet?.id || "", disabled: !canShop() || (!have && pet.id !== state.pet) });
    input.checked = (pet?.id || "") === state.pet;
    input.addEventListener("change", () => { state.pet = pet?.id || ""; preview.pet(pet); renderUpgrades(); update(); });
    const canvas = h("canvas", { class: "sprite", width: 48, height: 48, "aria-hidden": "true" });
    if (pet) addPet(canvas, pet);
    return h("div", { class: "char-option" }, input,
      h("label", { for: id }, canvas, h("span", {}, pet ? pet.label : "No pet"),
        pet ? h("span", { class: "tag" }, TIER_NAMES[pet.tier] + ", " + boostText(pet.boost)) : null),
      pet && !have ? buyButton("pet", pet.id, pet.label, pet.price, out) : null);
  };
  box.replaceChildren(option(null), ...state.shop.pets.map(option));
  $("#pet-note").textContent = canShop() ? "(you own " + owned.size + ", you have $" + (state.profile.dollars || 0) + ")" : "";
}

// Hats: one option per hat, drawn on the selected character. Locked hats show the wins they need.
const hatSprites = [];
function renderHats() {
  const r = rules(), box = $("#hats"), entry = state.catalog.find((x) => x.id === current().avatar) || null;
  hatSprites.length = 0;
  hatSprites.entry = entry;
  box.replaceChildren(...r.hats.map((hat) => {
    const id = "hat-" + (hat.id || "none");
    const have = hat.unlocked || state.owned.hats.includes(hat.id), price = (state.shop?.hatPricePerWin || 0) * hat.wins;
    const input = h("input", { type: "radio", name: "hat", id, value: hat.id, disabled: !have && hat.id !== state.hat });
    input.checked = hat.id === state.hat;
    input.addEventListener("change", () => { state.hat = hat.id; preview.hat(hat.id); update(); });
    const canvas = h("canvas", { class: "sprite", width: 48, height: 48, "aria-hidden": "true" });
    hatSprites.push(addSprite(canvas, entry, { hat: hat.id, active: () => false }));
    return h("div", { class: "char-option" }, input,
      h("label", { for: id }, canvas, h("span", {}, hat.label), have ? null : h("span", { class: "tag" }, "Unlocks at " + hat.wins + (hat.wins === 1 ? " win" : " wins"))),
      !have && price > 0 ? buyButton("hat", hat.id, hat.label + " hat", price, $("#hat-status")) : null);
  }));
  const locked = r.hats.filter((x) => !x.unlocked && !state.owned.hats.includes(x.id)).length;
  $("#hat-note").textContent = locked ? "(" + locked + (state.shop?.hatPricePerWin ? " unlock with wins or dollars)" : " unlock with wins)") : "";
}

// Upgrades: + and − per stat. Points come from saved wins; the server checks the same rules on save.
function renderUpgrades() {
  const r = rules(), list = $("#upgrade-list"), canEdit = Boolean(state.session?.user && state.profile);
  const used = r.stats.reduce((sum, k) => sum + state.stats[k], 0), left = r.points - used;
  $("#points-note").textContent = canEdit ? "(" + left + " of " + r.points + " points free)" : "";
  // Where the points come from, so a viewer sees what !checkin adds.
  const from = r.fromCheckins ? " You have " + r.fromWins + " from wins and " + r.fromCheckins + " from check-ins." : "";
  $("#upgrades-help").textContent = canEdit
    ? "Each win and each stream check-in (!checkin in chat) gives a point, up to " + r.maxPoints + "." + from + " Move points between stats whenever you're not in a duel."
    : "Save your fighter, then each win and each stream check-in (!checkin in chat) gives an upgrade point, up to " + r.maxPoints + ".";
  const shown = canEdit ? state.stats : { power: 0, guard: 0, luck: 0 };
  // The fighter card points at unspent points; the section is below the character list.
  const link = $("#points-link");
  link.hidden = !canEdit || left <= 0;
  link.textContent = left + (left === 1 ? " upgrade point" : " upgrade points") + " to spend";
  list.replaceChildren(...r.stats.map((k) => {
    const t = STAT_TEXT[k], n = shown[k];
    const step = (d) => () => { state.stats[k] += d; renderUpgrades(); update(); };
    const extra = petById(state.pet)?.boost?.[k] || 0;
    return h("div", { class: "upgrade" },
      h("div", { class: "upgrade-name" }, h("strong", {}, t.label), h("span", { class: "muted small" }, n ? t.effect(n) : t.effect(1) + " per point")),
      h("button", { type: "button", class: "btn btn-small", "aria-label": "Take a point out of " + t.label, disabled: !canEdit || n <= 0, onclick: step(-1) }, "−"),
      h("span", { class: "upgrade-value num", title: extra ? "+" + extra + " from your pet" : null }, n + " / " + r.maxPerStat + (extra ? " +" + extra : "")),
      h("button", { type: "button", class: "btn btn-small", "aria-label": "Put a point into " + t.label, disabled: !canEdit || left <= 0 || n >= r.maxPerStat, onclick: step(1) }, "+"));
  }));
}

function renderCharacters() {
  const box = $("#characters");
  if (!state.catalog.length) { box.replaceChildren(h("p", { class: "muted small" }, "No characters are available right now. Reload to try again.")); return; }
  $("#char-count").textContent = "(" + state.catalog.length + " available)";
  $("#more-chars").hidden = state.catalog.length <= 12;
  showAllChars(false);
  box.replaceChildren(...state.catalog.map((entry) => {
    const id = "char-" + entry.id;
    const input = h("input", { type: "radio", name: "character", id, value: entry.id });
    const canvas = h("canvas", { class: "sprite", width: 64, height: 64, "aria-hidden": "true" });
    const option = h("div", { class: "char-option" }, input,
      h("label", { for: id }, canvas, h("span", {}, entry.label || entry.id), entry.custom ? h("span", { class: "tag" }, "Channel original") : null));
    let hover = false;
    option.addEventListener("pointerenter", () => { hover = true; });
    option.addEventListener("pointerleave", () => { hover = false; });
    addSprite(canvas, entry, { anim: "walk", active: () => hover || input.checked || document.activeElement === input });
    return option;
  }));
}

// The list starts with 12 characters (plus the picked one); this button shows the rest.
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
      onclick: () => { colorInput.value = color; update(); } }), box.querySelector(".custom-color"));
  }
}

function update() {
  const c = current(), entry = state.catalog.find((x) => x.id === c.avatar);
  preview.set(entry || null);
  if (hatSprites.entry !== entry) { hatSprites.entry = entry; for (const s of hatSprites) s.set(entry || null); }
  nameplate.textContent = state.session?.user?.displayName || "you";
  nameplate.style.color = c.color;
  nameplate.style.borderColor = c.color;
  $("#preview-caption").textContent = entry ? entry.label || entry.id : "";
  for (const s of document.querySelectorAll(".swatch")) s.setAttribute("aria-pressed", String(s.dataset.color === c.color));
  // A fighter with no duels yet gets the next step instead of the plain saved line.
  if (state.session?.user && state.saved) setStatus(status, dirty() ? "You have unsaved changes." : fresh() ? "" : "Saved. Your fighter shows up on stream with these settings.", dirty() ? "" : "ok");
  renderNextStep();
}

function applyProfile(p) {
  const avatar = state.catalog.some((x) => x.id === p?.avatar) ? p.avatar : state.catalog[0]?.id;
  const radio = avatar && document.getElementById("char-" + avatar);
  if (radio) radio.checked = true;
  colorInput.value = /^#[0-9a-f]{6}$/i.test(p?.color || "") ? p.color.toLowerCase() : DEFAULT_COLOR;
  state.hat = typeof p?.hat === "string" ? p.hat : "";
  state.pet = typeof p?.pet === "string" ? p.pet : "";
  state.owned = { pets: p?.owned?.pets || [], hats: p?.owned?.hats || [] };
  state.stats = effectiveStats(p?.stats, p?.wins || 0, p?.bonus || 0);
  preview.hat(state.hat);
  preview.pet(petById(state.pet));
  renderHats(); renderPets(); renderUpgrades();
}

function renderCommands() {
  if (state.config) {
    $("#cmd-timeout").textContent = seconds(state.config.challengeTimeoutMs);
    $("#cmd-rematch").textContent = seconds(state.config.rematchDelayMs);
    const pts = state.config.checkinPoints ?? 1;
    $("#cmd-checkin").textContent = pts ? "+" + pts + (pts === 1 ? " upgrade point" : " upgrade points") : "A check-in";
    const c = state.config, usd = (n) => "$" + n, win = c.winDollars ?? 5, loss = c.lossDollars ?? 3;
    $("#cmd-dollars").textContent = win || loss ? usd(win) + " for a win and " + usd(loss) + " for a loss" : "nothing on this channel right now";
    $("#cmd-give").textContent = c.giveEnabled === false ? "Giving dollars is off on this channel." : "Gives dollars to another fighter while the stream is live: up to " + usd(c.giveMaxPerStream ?? 100) + " per stream, after your first " + (c.giveMinDuels ?? 5) + " duels.";
    $("#lb-note").textContent = "Ranked duels need a saved profile. Everyone starts at " + state.config.initialElo + " Elo.";
    $("#hp-mode-note").hidden = state.config.quickDuel !== false;
  }
}

const fresh = () => Boolean(state.profile) && !(state.profile.wins + state.profile.losses);
// Until the first duel: what to type in chat now that the fighter is saved.
function renderNextStep() {
  const next = $("#next-step"), show = Boolean(state.session?.user && state.saved && !dirty() && fresh());
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
  const s = state.session, signedIn = !!s?.user, note = $("#signin-note");
  renderWho($("#who"), s, signOut);
  saveBtn.hidden = !signedIn;
  saveSignin.hidden = signedIn || s?.configured === false;
  if (!saveSignin.hidden) $("#who").replaceChildren();   // one sign-in button: the fighter card's, next to what it saves
  note.hidden = signedIn;
  if (!s) note.textContent = "Sign-in is unavailable right now, so profiles can't be saved. You can still browse characters and the leaderboard.";
  else if (s.configured === false) note.textContent = "Twitch sign-in isn't set up on this server yet, so profiles can't be saved. You can still browse characters and the leaderboard.";
  else note.textContent = "Sign in with Twitch to save your fighter. It shares only your public Twitch name, and ranked duels need a saved profile.";
  const stats = $("#my-stats");
  stats.hidden = !state.profile;
  if (state.profile) {
    $("#stat-elo").textContent = state.profile.elo;
    $("#stat-wl").textContent = state.profile.wins + " / " + state.profile.losses;
    $("#stat-dollars").textContent = "$" + (state.profile.dollars || 0);
    $("#stat-streak").textContent = state.profile.streak || 0;
  }
}

function renderLeaderboard() {
  const tbody = $("#leaderboard tbody"), me = state.session?.user?.id, rows = state.leaderboard;
  if (!rows.length) {
    tbody.replaceChildren(h("tr", { class: "empty" }, h("td", { colspan: 6 },
      h("strong", {}, "No ranked duels yet, so the top spot is open."), " To get on the board: ",
      state.session?.user ? "save your fighter above" : "sign in and save your fighter above",
      ", then type ", h("code", {}, "!challenge @viewer"), " in chat while the stream is live.")));
    return;
  }
  const entryOf = (id) => state.catalog.find((x) => x.id === id);
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

form.addEventListener("change", update);
addEventListener("beforeunload", (e) => { if (state.session?.user && state.saved && dirty()) e.preventDefault(); });
colorInput.addEventListener("input", update);
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.session?.user) return;
  const body = current();
  if (!body.avatar) { setStatus(status, "Pick a character first.", "error"); return; }
  saveBtn.disabled = true;
  setStatus(status, "Saving…");
  const r = await api("/api/profile/" + CHANNEL, { method: "POST", body });
  saveBtn.disabled = false;
  if (r.status === 401) { state.session = { ...state.session, user: null }; renderSignedIn(); setStatus(status, "Your session expired. Sign in again to save.", "error"); return; }
  if (!r.ok) { setStatus(status, "Not saved: " + (REASONS[r.data?.error] || errorText(r)), "error"); return; }
  state.profile = r.data.profile; state.saved = savedOf(body);
  if (r.data.owned) state.owned = r.data.owned;
  renderSignedIn(); renderHats(); renderPets(); renderUpgrades(); update(); loadLeaderboard();
});

// The channel is turned off (paused) or was never set up (server/channels.js).
function showOff(off) {
  const note = $("#off-note");
  note.hidden = false;
  if (off === "paused") { note.textContent = "Mini Chat is off on " + CHANNEL + "'s channel right now. Saved fighters and ranks are kept for when it's back."; return; }
  note.replaceChildren("Mini Chat isn't set up on " + CHANNEL + "'s channel. ", h("a", { href: "/" }, "Pick another channel"), ".");
  $("#profile-form").hidden = true;
  $(".fighter-card").hidden = true;
}

async function init() {
  renderSwatches();
  const [session, catalog, live, shop] = await Promise.all([api("/api/session"), api("/api/catalog/" + CHANNEL), api("/api/state/" + CHANNEL), api("/api/pets/" + CHANNEL)]);
  state.shop = shop.ok && Array.isArray(shop.data?.pets) ? shop.data : null;
  state.session = session.ok ? session.data : null;
  state.catalog = catalog.ok && Array.isArray(catalog.data) ? catalog.data : [];
  if (!state.catalog.length) {
    const fallback = await api("/assets/characters.json");   // the static list still works if the API is down
    if (fallback.ok && Array.isArray(fallback.data)) state.catalog = fallback.data;
  }
  state.config = live.ok ? live.data?.config : null;
  if (live.status === 403 && live.data?.off) showOff(live.data.off);
  renderCharacters(); renderCommands();
  if (state.session?.user) {
    const [profile, access] = await Promise.all([api("/api/profile/" + CHANNEL), api("/api/access/" + CHANNEL)]);
    state.profile = profile.ok ? profile.data : null;
    $("#admin-link").hidden = !(access.ok && access.data?.canManage);
    const p = state.profile || {};
    applyProfile(p);
    state.saved = state.profile ? savedOf({ ...state.profile, stats: state.stats, hat: state.hat, pet: state.pet }) : null;
    if (!state.profile) setStatus(status, "You don't have a saved profile yet. Pick your fighter and save.");
  } else applyProfile(null);
  renderSignedIn(); update(); welcome();
  loadLeaderboard();
}
// The bare site (no ?channel=) asks which stream the viewer watches, so nobody saves a fighter on the wrong channel.
async function pickChannel() {
  document.title = "Mini Chat: pick your stream";
  for (const el of [$("#fighter"), $("main.page:not(#pick)"), $(".topbar nav")]) if (el) el.hidden = true;
  $("#pick").hidden = false;
  const [session, list] = await Promise.all([api("/api/session"), api("/api/channels")]);
  // Signing in happens on a channel's page, so the picker shows only who is already signed in.
  if (session.ok && session.data?.user) renderWho($("#who"), session.data, signOut); else $("#who").replaceChildren();
  const channels = list.ok && Array.isArray(list.data?.channels) ? list.data.channels : ["nesszerra", "miolafff"];
  $("#channel-list").replaceChildren(...channels.map((c) => h("li", {}, h("a", { class: "btn", href: "/?channel=" + encodeURIComponent(c) }, c))));
}
if (CHANNEL_PICKED) init(); else pickChannel();
