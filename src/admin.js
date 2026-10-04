// Mod controls ("/admin/"): broadcaster and moderators only (GET /api/access/:channel -> canManage).
// Uses GET/POST /api/admin/:channel (CONTRACTS.md section 2) and the read-only live socket for updates.
import { api, errorText, h, $, setStatus, renderWho, signOut, seconds, timeAgo, dateTime, formatBytes, CHANNEL, withChannel, loginHref, applyChannel } from "./ui.js";
applyChannel();
if (CHANNEL !== "nesszerra") document.querySelector(".page-header .subtitle").textContent = "For the " + CHANNEL + " broadcaster. Changes apply to every OBS overlay right away.";

const LIMITS = { maxCharacters: 24, maxFrames: 24, frameSize: 128, maxAtlasBytes: 1572864 };
// Editable config fields (CONTRACTS.md section 7). `ms` fields are edited in seconds and sent as integer ms.
const GROUPS = [
  { title: "Health and duels", fields: [
    { key: "maxHp", label: "Max health", unit: "HP", min: 1, max: 1000 },
    { key: "maxDuels", label: "Duels at the same time", unit: "duels", min: 1, max: 5 },
    { key: "challengeTimeoutMs", label: "Challenge expires after", unit: "s", ms: true, min: 5000, max: 300000 },
    { key: "inactivityMs", label: "Idle duel cancelled after", unit: "s", ms: true, min: 10000, max: 600000 },
    { key: "respawnMs", label: "Respawn after knockout", unit: "s", ms: true, min: 0, max: 60000 },
    { key: "rematchDelayMs", label: "Rematch wait", unit: "s", ms: true, min: 0, max: 600000 },
    { key: "streamDelayMs", label: "Stream delay", unit: "s", ms: true, min: 0, max: 60000 },
  ] },
  { title: "Ranking", fields: [
    { key: "initialElo", label: "Starting Elo", unit: "Elo", min: 0, max: 10000 },
    { key: "eloK", label: "Elo K-factor", unit: "K", min: 1, max: 100 },
  ] },
  // !checkin (server/channel.js checkin). Wins and check-in points together are capped at 20.
  { title: "Check-ins", fields: [
    { key: "checkinPoints", label: "Upgrade points per check-in", unit: "points", min: 0, max: 3 },
    { key: "streakBonus", label: "Streak bonus", bool: true, hint: "+1 point at a streak of 3, 7, 14 and 30 streams" },
  ] },
  // Mini Chat dollars (server/channel.js payDuels and give). Mods gift dollars from the Players tab.
  { title: "Dollars", fields: [
    { key: "winDollars", label: "Dollars for a win", unit: "$", min: 0, max: 100 },
    { key: "lossDollars", label: "Dollars for a loss", unit: "$", min: 0, max: 100 },
    { key: "giveEnabled", label: "Viewers can give dollars", bool: true, hint: "!pay @name amount, only while the stream is live" },
    { key: "giveMaxPerStream", label: "Most one viewer gives per stream", unit: "$", min: 0, max: 10000 },
    { key: "giveMinDuels", label: "Finished duels before giving", unit: "duels", min: 0, max: 1000 },
  ] },
  // The shop (server/pets.js): pet prices by tier, and locked hats cost this much per win they need (0 = not for sale).
  { title: "Shop", fields: [
    { key: "petPriceCommon", label: "Common pet", unit: "$", min: 1, max: 100000 },
    { key: "petPriceUncommon", label: "Uncommon pet", unit: "$", min: 1, max: 100000 },
    { key: "petPriceRare", label: "Rare pet", unit: "$", min: 1, max: 100000 },
    { key: "petPriceEpic", label: "Epic pet", unit: "$", min: 1, max: 100000 },
    { key: "petPriceLegendary", label: "Legendary pet", unit: "$", min: 1, max: 100000 },
    { key: "hatPricePerWin", label: "Hat price per win it needs", unit: "$", min: 0, max: 1000 },
  ] },
  // Only used when config.quickDuel is false, and no screen turns that off, so the group stays hidden (but in the form, so saving keeps its values).
  { title: "HP fight abilities", visible: (c) => c.quickDuel === false, fields: [
    { key: "abilities.strike.damage", label: "Strike damage", unit: "HP", min: 1, max: 1000 },
    { key: "abilities.strike.cooldownMs", label: "Strike cooldown", unit: "s", ms: true, min: 250, max: 600000 },
    { key: "abilities.heavy.damage", label: "Heavy strike damage", unit: "HP", min: 1, max: 1000 },
    { key: "abilities.heavy.cooldownMs", label: "Heavy strike cooldown", unit: "s", ms: true, min: 250, max: 600000 },
    { key: "abilities.heal.amount", label: "Heal amount", unit: "HP", min: 1, max: 1000 },
    { key: "abilities.heal.cooldownMs", label: "Heal cooldown", unit: "s", ms: true, min: 250, max: 600000 },
    { key: "sharedCooldownMs", label: "Delay between any two actions", unit: "s", ms: true, min: 250, max: 60000 },
  ] },
];
const FIELDS = GROUPS.flatMap((g) => g.fields);
const LABELS = Object.fromEntries([...FIELDS.map((f) => [f.key, f]), ["enabled", { label: "Duels enabled" }]]);
const get = (obj, key) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const flatten = (config) => Object.fromEntries([...FIELDS.map((f) => [f.key, get(config, f.key)]), ["enabled", config?.enabled]]);
const show = (key, v) => v === undefined ? "—" : key === "enabled" || LABELS[key]?.bool ? (v ? "on" : "off") : LABELS[key]?.ms ? seconds(v) : v + (LABELS[key]?.unit && LABELS[key].unit !== "s" ? " " + LABELS[key].unit : "");

const S = { session: null, access: null, admin: null, leaderboard: [], names: new Map(), socket: null, retry: 0 };
const actionStatus = $("#action-status"), configStatus = $("#config-status");
const OPEN = new Set(["pending", "active"]);

// ---------- tabs ----------
// One panel at a time; the URL hash (#players, #rules, ...) keeps the tab across reloads and links.
const TABS = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab, focus = false) {
  for (const t of TABS) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
  }
  if (focus) tab.focus();
  const hash = "#" + tab.id.slice(4);
  if (location.hash !== hash) history.replaceState(null, "", hash === "#live" ? location.pathname + location.search : hash);
}
for (const t of TABS) {
  t.addEventListener("click", () => selectTab(t));
  t.addEventListener("keydown", (e) => {
    const i = TABS.indexOf(t), next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    selectTab(TABS[(next + TABS.length) % TABS.length], true);
  });
}
selectTab(document.getElementById("tab-" + location.hash.slice(1)) || TABS[0]);

// ---------- loading and access ----------
function gate(text, actions = []) {
  $("#gate").hidden = false; $("#app").hidden = true;
  $("#gate-text").textContent = text;
  $("#gate-actions").replaceChildren(...actions);
}
async function init() {
  const session = await api("/api/session");
  S.session = session.ok ? session.data : null;
  renderWho($("#who"), S.session, signOut);
  if (!S.session) return gate("The server can't check sign-in right now: " + errorText(session) + ". Try again in a minute.", [h("button", { class: "btn", type: "button", onclick: () => location.reload() }, "Reload")]);
  if (!S.session.user) {
    if (S.session.configured === false) return gate("Twitch sign-in isn't set up on this server yet, so mod controls are unavailable.");
    return gate(CHANNEL === "nesszerra" ? "Sign in with the nesszerra account or a nesszerra moderator account to open mod controls." : "Sign in with the " + CHANNEL + " Twitch account to open mod controls.", [h("a", { class: "btn btn-primary", href: loginHref("/admin/") }, "Sign in with Twitch")]);
  }
  const access = await api("/api/access/" + CHANNEL);
  S.access = access.ok ? access.data : null;
  if (!S.access?.canManage) {
    const why = S.access?.reason ? " (" + S.access.reason + ")" : access.ok ? "" : " (" + errorText(access) + ")";
    return gate((CHANNEL === "nesszerra" ? "Only nesszerra and current channel moderators can use mod controls" : "Only the " + CHANNEL + " account can use mod controls for " + CHANNEL) + why + ".", [h("a", { class: "btn", href: withChannel("/") }, "Back to your fighter")]);
  }
  $("#gate").hidden = true; $("#app").hidden = false;
  $("#dev-link").hidden = $("#dev-section").hidden = !S.access.owner;
  $("#owner-chat").hidden = !S.access.owner || CHANNEL !== "nesszerra";
  $("#chat-box").hidden = CHANNEL !== "nesszerra";   // other channels get chat through StreamElements only
  await Promise.all([load(), loadLeaderboard(), loadCustom(), loadPets()]);
  if (S.admin?.channelState !== "paused") connectLive();
  // Back from "Connect mod access" (/auth/login?connect=mods)
  const mods = new URLSearchParams(location.search).get("mods");
  const MODS = { connected: "Mod access is connected. Your Twitch moderators can sign in to this page now.", denied: "The Twitch permission was cancelled, so mod access isn't connected.", wrong_account: "Mod access has to be connected while signed in to Twitch as " + CHANNEL + "." };
  if (MODS[mods]) {
    setStatus($("#check-status"), MODS[mods], mods === "connected" ? "ok" : "error");
    const url = new URL(location.href); url.searchParams.delete("mods"); history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  mountUploads();
}
async function load() {
  const r = await api("/api/admin/" + CHANNEL);
  if (r.status === 401 || r.status === 403) return gate("Your access changed: " + errorText(r) + ". Reload to check again.", [h("button", { class: "btn", type: "button", onclick: () => location.reload() }, "Reload")]);
  if (!r.ok) { setStatus(actionStatus, "Couldn't load the arena: " + errorText(r), "error"); return false; }
  S.admin = r.data;
  renderAll();
  return true;
}
async function loadLeaderboard() {
  const r = await api("/api/leaderboard/" + CHANNEL);
  S.leaderboard = r.ok && Array.isArray(r.data) ? r.data : [];
  if (S.admin) { renderRanks(); renderHistory(); }
}

// ---------- names ----------
function nameOf(id) {
  if (!id) return "—";
  if (id === "system") return "System";
  if (S.session?.user?.id === id) return S.session.user.displayName + " (you)";
  return S.names.get(id) || "Twitch user " + id;
}
function collectNames() {
  for (const h of S.admin?.history || []) if (h.actorName) S.names.set(h.actorId, h.actorName);
  for (const p of [...S.leaderboard, ...(S.admin?.players || [])]) S.names.set(p.userId, p.displayName || p.username);
}

// ---------- actions ----------
async function act(action, payload, { confirmText, button, done } = {}) {
  if (confirmText && !confirm(confirmText)) return null;
  if (button) button.disabled = true;
  setStatus(actionStatus, "Working…");
  const r = await api("/api/admin/" + CHANNEL, { method: "POST", body: payload === undefined ? { action } : { action, payload } });
  if (button) button.disabled = false;
  if (!r.ok) { setStatus(actionStatus, "That didn't work: " + errorText(r), "error"); return r; }
  setStatus(actionStatus, done || "Done.", "ok");
  await load(); await loadLeaderboard();
  return r;
}
$("#toggle-duels").addEventListener("click", (e) => {
  const enabled = !S.admin.config.enabled;
  const open = S.admin.duels.filter((d) => OPEN.has(d.status)).length;
  act("config", { patch: { enabled }, baseVersion: S.admin.configVersion, note: enabled ? "duels enabled" : "duels paused" },
    { button: e.currentTarget, confirmText: !enabled && open ? "Pause duels? The " + open + " open duel" + (open === 1 ? "" : "s") + " will be cancelled without scoring." : undefined, done: enabled ? "Duels are on." : "Duels are paused. Open duels were cancelled without scoring." });
});
// Duel announcements live in the channel config: every open overlay picks the change up from its next snapshot.
$("#announce").addEventListener("change", async (e) => {
  const select = e.currentTarget, status = $("#announce-status");
  select.disabled = true;
  setStatus(status, "Saving…");
  const r = await api("/api/admin/" + CHANNEL, { method: "POST", body: { action: "config", payload: { patch: { announce: select.value }, baseVersion: S.admin.configVersion, note: "announcements " + select.value } } });
  select.disabled = false;
  if (!r.ok) { setStatus(status, "Couldn't save: " + errorText(r) + ".", "error"); select.value = S.admin.config.announce || "off"; return; }
  setStatus(status, select.value === "off" ? "Announcements hidden on every overlay." : "Saved. Overlays show announcements within seconds.", "ok");
  await load();
});
// The on-screen limit is channel config too, so open overlays apply it from their next snapshot.
$("#cap").addEventListener("change", async (e) => {
  const input = e.currentTarget, status = $("#cap-status"), value = Number(input.value);
  if (!Number.isInteger(value) || value < 15 || value > 100) { setStatus(status, "Pick a whole number from 15 to 100.", "error"); input.value = S.admin.config.maxOnStream || 50; return; }
  input.disabled = true;
  setStatus(status, "Saving…");
  const r = await api("/api/admin/" + CHANNEL, { method: "POST", body: { action: "config", payload: { patch: { maxOnStream: value }, baseVersion: S.admin.configVersion, note: "up to " + value + " on stream" } } });
  input.disabled = false;
  if (!r.ok) { setStatus(status, "Couldn't save: " + errorText(r) + ".", "error"); input.value = S.admin.config.maxOnStream || 50; return; }
  setStatus(status, "Saved. Overlays show up to " + value + " characters within seconds.", "ok");
  await load();
});
$("#open-chat-setup").addEventListener("click", () => selectTab($("#tab-chat"), true));
$("#reset-health").addEventListener("click", (e) => act("resetHealth", undefined, { button: e.currentTarget, confirmText: "Put every viewer in the arena back to full health?", done: "Everyone in the arena is back to full health." }));
$("#reset-round").addEventListener("click", (e) => act("resetRound", undefined, { button: e.currentTarget, confirmText: "Cancel every open duel without scoring and restart rounds at 1?", done: "Open duels cancelled; rounds restart at 1." }));
// Mod gift: dollars to one saved fighter (server/channel.js giftDollars). Negative takes them back.
$("#gift-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("#gift-status"), username = $("#gift-user").value.trim().replace(/^@/, ""), amount = Number($("#gift-amount").value);
  if (!/^[a-z0-9_]{1,25}$/i.test(username)) return setStatus(status, "Type the viewer's Twitch name.", "error");
  if (!Number.isInteger(amount) || !amount || Math.abs(amount) > 10000) return setStatus(status, "Pick a whole number from -10000 to 10000, not 0.", "error");
  const button = $("#gift-send");
  button.disabled = true;
  setStatus(status, "Saving…");
  const r = await api("/api/admin/" + CHANNEL, { method: "POST", body: { action: "giftDollars", payload: { username, amount } } });
  button.disabled = false;
  if (!r.ok) return setStatus(status, r.status === 404 ? username + " has no saved fighter on " + CHANNEL + "." : "Couldn't gift: " + errorText(r) + ".", "error");
  setStatus(status, (amount > 0 ? "Gave $" + amount + " to " : "Took $" + -amount + " from ") + (r.data.displayName || r.data.username) + ". They have $" + r.data.dollars + " now.", "ok");
  $("#gift-amount").value = "";
  await loadLeaderboard();
});
$("#reset-all-ranks").addEventListener("click", (e) => act("resetAllRanks", undefined, { button: e.currentTarget, confirmText: "Reset Elo, wins and losses for every saved profile on " + CHANNEL + "? This can't be undone.", done: "All ranks reset." }));
$("#reset-all").addEventListener("click", (e) => act("resetAll", undefined, { button: e.currentTarget, confirmText: "Remove every character from the arena and cancel all duels? Saved profiles and ranks stay.", done: "Arena cleared." }));

// ---------- rendering ----------
function renderAll() {
  collectNames();
  const a = S.admin, c = a.config, open = a.duels.filter((d) => OPEN.has(d.status));
  const chat = a.chatStatus || a.chat || {}, health = chatHealth();
  $("#meta").textContent = "Signed in as " + (S.access.owner && CHANNEL === "nesszerra" || S.access.broadcaster ? "the broadcaster" : S.access.owner ? "the site owner" : "a moderator") + ".";
  const waiting = c.enabled && !health.ok;
  $("#summary-title").textContent = !c.enabled ? "Duels are paused by a moderator" : waiting ? health.title : "Duels are live";
  $("#summary-text").textContent = !c.enabled ? "Chat commands are ignored until duels are turned back on." :
    waiting ? health.text + (chat.lastRevocationReason ? " Twitch revoked access: " + chat.lastRevocationReason + "." : "") :
    open.length + " of " + c.maxDuels + " duel slots in use, " + a.players.length + " viewers in the arena.";
  const toggle = $("#toggle-duels");
  toggle.textContent = c.enabled ? "Pause duels" : "Turn duels on";
  // while chat is offline the fix is on the Stream setup tab, so that becomes the main action
  $("#open-chat-setup").hidden = !waiting;
  toggle.classList.toggle("btn-primary", !waiting);
  $("#stats").replaceChildren(
    stat("Duels", !c.enabled ? "Paused" : waiting ? "Waiting" : "On", !c.enabled ? "down" : waiting ? "" : "up", !c.enabled ? "commands ignored" : waiting ? "for chat" : "accepting commands"),
    stat(health.label, health.value, health.ok ? "up" : "down", health.note),
    stat("Open duels", open.length + " / " + c.maxDuels),
    stat("In the arena", a.players.length));
  if (document.activeElement !== $("#announce")) $("#announce").value = a.config.announce || "off";
  if (document.activeElement !== $("#cap")) $("#cap").value = a.config.maxOnStream || 50;
  renderDuels(); renderPlayers(); renderRanks(); renderConfig(); renderHistory(); renderUsage(); renderChat(); renderSe(); renderChecklist(); renderPower();
}
// Where chat comes from and whether it works. StreamElements counts as working only once a command has
// arrived with this site's key; choosing it as the source isn't enough. The Stream setup tab uses the same rules.
function chatHealth() {
  const a = S.admin, c = a.chatStatus || a.chat || {}, se = a.streamelements;
  const fix = " Finish step 3, Add the chat commands to StreamElements, on the Stream setup tab.";
  if (!c.connected) return { ok: false, label: "Chat", value: "Not connected", note: "no chat source", title: "Waiting for chat",
    text: CHANNEL === "nesszerra" ? "Duels start when chat is connected. Connect Twitch chat or set up StreamElements on the Stream setup tab." : "Duels start when chat commands reach Mini Chat." + fix };
  if (c.source === "streamelements") {
    if (se && se.rejectedAt > (se.lastCommandAt || 0)) return { ok: false, label: "StreamElements", value: "Old key", note: "a command was refused " + timeAgo(se.rejectedAt),
      title: "StreamElements is sending an old key", text: "A command arrived " + timeAgo(se.rejectedAt) + " with a key that no longer works, so it was refused. Copy every response again from the Stream setup tab and paste it into StreamElements." };
    if (!se?.lastCommandAt) return { ok: false, label: "StreamElements", value: "No commands yet", note: "none has reached Mini Chat", title: "Waiting for the first chat command",
      text: "StreamElements is the chat source, but no command has reached Mini Chat yet." + fix };
    return { ok: true, label: "StreamElements", value: "Working", note: "last command " + timeAgo(se.lastCommandAt) };
  }
  const last = c.lastNotificationAt ?? c.lastSeen;
  return { ok: true, label: "Twitch chat", value: "Connected", note: last ? "last message " + timeAgo(last) : "no messages yet" };
}
function stat(label, value, cls, delta) {
  return h("div", { class: "stat" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), delta ? h("div", { class: "delta " + (cls || "") }, delta) : null);
}
function hp(value, max, who) {
  const pct = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  return h("span", { class: "hp" }, h("span", { class: "track", "aria-hidden": "true" }, h("i", { style: { "--v": pct + "%" } })), h("span", { class: "num" }, (who ? who + " " : "") + value + " / " + max));
}
// Snapshots rebuild the tables; put keyboard focus back on the same row's button afterwards.
function keepFocus(tbody, render) {
  const key = tbody.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  render();
  if (key) tbody.querySelector('[data-key="' + CSS.escape(key) + '"]')?.focus();
}
const empty = (cols, text) => h("tr", {}, h("td", { colspan: cols, class: "muted" }, text));
function renderDuels() { keepFocus($("#duels tbody"), drawDuels); }
function drawDuels() {
  const tbody = $("#duels tbody"), now = Date.now();
  const open = S.admin.duels.filter((d) => OPEN.has(d.status));
  if (!open.length) return tbody.replaceChildren(empty(6, "No open duels. Viewers start one with !challenge @viewer."));
  tbody.replaceChildren(...open.map((d) => {
    const max = d.rules?.maxHp || S.admin.config.maxHp;
    const left = d.status === "pending" ? Math.max(0, d.expiresAt - now) : Math.max(0, (d.lastActionAt || d.startedAt) + S.admin.config.inactivityMs - now);
    return h("tr", {},
      h("td", {}, nameOf(d.a), " vs ", nameOf(d.b)),
      h("td", {}, h("span", { class: "badge" + (d.status === "active" ? " positive" : "") }, d.status === "active" ? "Fighting" : "Waiting for accept")),
      h("td", {}, d.status === "active" ? h("div", {}, h("div", {}, hp(d.hp?.[d.a] ?? max, max, nameOf(d.a))), h("div", {}, hp(d.hp?.[d.b] ?? max, max, nameOf(d.b)))) : "—"),
      h("td", { class: "num" }, d.round || "—"),
      h("td", {}, (d.status === "pending" ? "expires in " : "idle cancel in ") + seconds(Math.round(left / 1000) * 1000)),
      h("td", {}, h("button", { class: "btn btn-small", type: "button", "data-key": "cancel:" + d.id, "aria-label": "Cancel duel " + nameOf(d.a) + " vs " + nameOf(d.b),
        onclick: (e) => act("cancelDuel", { duelId: d.id }, { button: e.currentTarget, confirmText: "Cancel " + nameOf(d.a) + " vs " + nameOf(d.b) + " without scoring?", done: "Duel cancelled without scoring." }) }, "Cancel duel")));
  }));
}
function renderPlayers() { keepFocus($("#players tbody"), drawPlayers); }
function drawPlayers() {
  const tbody = $("#players tbody"), now = Date.now(), max = S.admin.config.maxHp;
  if (!S.admin.players.length) return tbody.replaceChildren(empty(7, "Nobody is in the arena. Characters appear after a viewer's first chat message."));
  tbody.replaceChildren(...S.admin.players.map((p) => h("tr", {},
    h("td", {}, h("span", { style: { color: p.color }, "aria-hidden": "true" }, "■ "), p.displayName || p.username, p.registered ? null : h("span", { class: "muted" }, " (no profile)")),
    h("td", {}, p.respawnAt > now ? h("span", { class: "badge negative" }, "Knocked out") : hp(p.hp, max)),
    h("td", { class: "num" }, p.elo), h("td", { class: "num" }, p.wins), h("td", { class: "num" }, p.losses),
    h("td", {}, timeAgo(p.lastSeen)),
    h("td", {}, h("button", { class: "btn btn-small btn-danger", type: "button", "data-key": "remove:" + p.userId, "aria-label": "Remove " + (p.displayName || p.username), onclick: (e) => removePlayer(p, e.currentTarget) }, "Remove")))));
}
const removePlayer = (p, button) => act("removePlayer", { userId: p.userId }, { button, confirmText: "Remove " + (p.displayName || p.username) + " from the arena and delete their saved profile?", done: "Viewer removed." });
function renderRanks() { keepFocus($("#ranks tbody"), drawRanks); }
function drawRanks() {
  const tbody = $("#ranks tbody");
  if (!S.leaderboard.length) return tbody.replaceChildren(empty(7, "No saved profiles yet."));
  tbody.replaceChildren(...S.leaderboard.map((p, i) => h("tr", {},
    h("td", { class: "num" }, i + 1), h("td", {}, p.displayName || p.username),
    h("td", { class: "num" }, p.elo), h("td", { class: "num" }, p.wins), h("td", { class: "num" }, p.losses), h("td", { class: "num" }, p.dollars ?? 0),
    h("td", {}, h("div", { class: "toolbar" },
      h("button", { class: "btn btn-small", type: "button", "data-key": "rank:" + p.userId, "aria-label": "Reset rank for " + (p.displayName || p.username), onclick: (e) => act("resetRank", { userId: p.userId }, { button: e.currentTarget, confirmText: "Reset " + (p.displayName || p.username) + "'s Elo, wins and losses?", done: "Rank reset." }) }, "Reset rank"),
      h("button", { class: "btn btn-small btn-danger", type: "button", "data-key": "rank-remove:" + p.userId, "aria-label": "Remove " + (p.displayName || p.username), onclick: (e) => removePlayer(p, e.currentTarget) }, "Remove"))))));
}

// ---------- config editor ----------
// The form remembers the version it was built from. Unsaved edits survive live updates; if someone else saves in
// the meantime, the save is sent with the old baseVersion and the server answers 409 (handled below).
let editedBase = 0, editedConfig = null;
function renderConfig() {
  const box = $("#config-fields"), config = S.admin.config;
  if (box.childElementCount && formDirty()) {
    if (editedBase !== S.admin.configVersion) setStatus(configStatus, "Version " + S.admin.configVersion + " was saved by someone else while you were editing. Discard your changes to load it.", "error");
    return;
  }
  editedBase = S.admin.configVersion; editedConfig = config;
  box.replaceChildren(...GROUPS.map((g) => h("fieldset", { class: "config-group", hidden: g.visible ? !g.visible(config) : false }, h("legend", {}, g.title),
    h("div", { class: "config-grid" }, g.fields.map((f) => {
      const id = "cfg-" + f.key.replace(/\./g, "-"), value = get(config, f.key);
      if (f.bool) return h("div", {}, h("label", { class: "check", for: id }, h("input", { id, type: "checkbox", "data-key": f.key, checked: Boolean(value) }), " " + f.label), h("p", { class: "hint" }, f.hint));
      const input = h("input", { id, type: "number", inputmode: "decimal", required: true, "data-key": f.key,
        min: f.ms ? f.min / 1000 : f.min, max: f.ms ? f.max / 1000 : f.max, step: f.ms ? 0.25 : 1, value: String(f.ms ? value / 1000 : value) });
      return h("div", {}, h("label", { for: id }, f.label + " (" + f.unit + ")"), input,
        h("p", { class: "hint" }, (f.ms ? seconds(f.min) + " to " + seconds(f.max) : f.min + " to " + f.max)));
    })))));
  syncConfigButtons();
}
function readField(input) {
  const f = LABELS[input.dataset.key], raw = input.value.trim(), n = Number(raw);
  if (f.bool) return { value: input.checked };
  if (raw === "" || !Number.isFinite(n)) return { error: f.label + " needs a number." };
  const value = f.ms ? Math.round(n * 1000) : n;
  if (!Number.isInteger(value)) return { error: f.label + " must be a whole number." };
  if (value < f.min || value > f.max) return { error: f.label + " must be between " + show(f.key, f.min) + " and " + show(f.key, f.max) + "." };
  return { value };
}
function buildPatch() {
  const patch = {}, errors = [];
  for (const input of document.querySelectorAll("#config-fields input[data-key]")) {
    const key = input.dataset.key, r = readField(input);
    input.setCustomValidity(r.error || "");
    if (r.error) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
    input.parentElement.classList.toggle("changed", !r.error && r.value !== get(editedConfig, key));
    if (r.error) { errors.push(r.error); continue; }
    if (r.value === get(editedConfig, key)) continue;
    const path = key.split(".");
    let node = patch;
    for (const part of path.slice(0, -1)) node = node[part] ||= {};
    node[path.at(-1)] = r.value;
  }
  return { patch, errors };
}
const formDirty = () => Object.keys(buildPatch().patch).length > 0;
addEventListener("beforeunload", (e) => { if (S.admin && formDirty()) e.preventDefault(); });   // unsaved rule edits
function syncConfigButtons() {
  const { patch, errors } = buildPatch(), changed = Object.keys(patch).length > 0;
  $("#config-save").disabled = !changed || errors.length > 0;
  $("#config-save").className = "btn" + (changed && !errors.length ? " btn-primary" : "");
  $("#config-discard").disabled = !changed;
  const bar = $("#config-bar");
  bar.classList.toggle("dirty", changed);
  if (errors.length) setStatus(configStatus, errors[0], "error");
  else if (editedBase === S.admin.configVersion) setStatus(configStatus, changed ? "Unsaved changes. Saving creates version " + (S.admin.configVersion + 1) + "." : "");
  // The bar appears with the first edit; if it lands on the field being typed in, scroll that field above it.
  const field = document.activeElement;
  if (changed && field && $("#config-fields").contains(field)) {
    const overlap = field.getBoundingClientRect().bottom + 12 - bar.getBoundingClientRect().top;
    if (overlap > 0) scrollBy(0, overlap);
  }
}
$("#config-form").addEventListener("input", syncConfigButtons);
$("#config-discard").addEventListener("click", () => { $("#config-fields").replaceChildren(); renderConfig(); });
const mergeConfig = (base, patch) => ({ ...base, ...patch, abilities: Object.fromEntries(Object.entries(base.abilities || {}).map(([k, v]) => [k, { ...v, ...(patch.abilities?.[k] || {}) }])) });
$("#config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const { patch, errors } = buildPatch();
  if (errors.length || !Object.keys(patch).length) return;
  const save = $("#config-save"); save.disabled = true;
  setStatus(configStatus, "Saving…");
  const r = await api("/api/admin/" + CHANNEL, { method: "POST", body: { action: "config", payload: { patch, baseVersion: editedBase, note: $("#config-note").value.trim() } } });
  if (r.status === 409) {
    const mine = diff(editedConfig, mergeConfig(editedConfig, patch));
    $("#config-fields").replaceChildren(); await load();
    setStatus(configStatus, "Not saved: someone else saved version " + S.admin.configVersion + " first. The form now shows the current values. Your change was: " + mine + ".", "error");
    return;
  }
  if (!r.ok) { save.disabled = false; setStatus(configStatus, "Not saved: " + errorText(r), "error"); return; }
  $("#config-note").value = ""; $("#config-fields").replaceChildren();
  await load();
  setStatus(configStatus, "Saved as version " + S.admin.configVersion + ".", "ok");
});
function diff(prev, next) {
  if (!prev) return "Starting values";
  const a = flatten(prev), b = flatten(next);
  const changes = Object.keys(b).filter((k) => a[k] !== b[k]).map((k) => (LABELS[k]?.label || k) + " " + show(k, a[k]) + " → " + show(k, b[k]));
  return changes.length ? changes.join("; ") : "No value changes";
}
function renderHistory() {
  const tbody = $("#history tbody"), rows = S.admin.history || [];
  $("#history-title").textContent = "Version history (" + rows.length + (rows.length === 1 ? " version)" : " versions)");
  if (!rows.length) return tbody.replaceChildren(empty(6, "No saved versions yet. The first save is recorded here."));
  tbody.replaceChildren(...rows.map((row, i) => {
    const current = row.version === S.admin.configVersion;
    return h("tr", {},
      h("td", { class: "num" }, "v" + row.version),
      h("td", {}, dateTime(row.at)),
      h("td", {}, nameOf(row.actorId)),
      h("td", {}, diff(rows[i + 1]?.config, row.config)),
      h("td", {}, row.note || ""),
      h("td", {}, current ? h("span", { class: "badge positive" }, "Current") :
        h("button", { class: "btn btn-small", type: "button", onclick: (e) => act("rollbackConfig", { version: row.version }, { button: e.currentTarget, done: "Restored v" + row.version + " as a new version." }) }, "Revert to v" + row.version)));
  }));
}

// ---------- custom characters ----------
let customItems = null, customLimits = null;
function renderUsage() {
  const u = S.admin.customUsage || { count: 0, limit: LIMITS.maxCharacters, bytes: 0 };
  const limit = u.limit || LIMITS.maxCharacters, budget = limit * LIMITS.maxAtlasBytes;
  $("#usage-title").textContent = u.count + " of " + limit + " custom character slots used";
  const bar = (label, value, max, text, key) => [h("div", { class: "bar-label" }, label),
    h("div", { class: "bar" + (key ? " is-key" : ""), style: { "--v": Math.min(100, (value / max) * 100) + "%" } }, h("span"), h("b", {}, text))];
  $("#usage-bars").replaceChildren(...bar("Characters", u.count, limit, u.count + " / " + limit, true),
    ...bar("Atlas storage", u.bytes, budget, formatBytes(u.bytes) + " / " + formatBytes(budget)));
}
async function loadCustom() {
  const r = await api("/api/assets/" + CHANNEL);
  const box = $("#custom-list");
  if (!r.ok) { box.replaceChildren(h("p", {}, "Couldn't list custom characters: " + errorText(r))); return; }
  customItems = r.data.items || []; customLimits = r.data.limits || null;
  if (!customItems.length) { box.replaceChildren(h("p", {}, "No custom characters yet. The slots are shared by the broadcaster and all moderators.")); return; }
  box.replaceChildren(h("div", { class: "table-wrap" }, h("table", { class: "data" },
    h("thead", {}, h("tr", {}, h("th", {}, "Character"), h("th", { class: "num" }, "Frames"), h("th", { class: "num" }, "Size"), h("th", {}, "Added"))),
    h("tbody", {}, customItems.map((x) => h("tr", {}, h("td", {}, x.label || x.id), h("td", { class: "num" }, (x.frames || []).length + Object.values(x.animations || {}).reduce((n, f) => n + f.length, 0)),
      h("td", { class: "num" }, formatBytes(x.bytes || 0)), h("td", {}, dateTime(x.createdAt))))))));
}
// ---------- custom pets ----------
// Uploaded pets join the shop at their tier's price (server/pets.js). Built-in pets are drawn in code and can't be removed.
const TIER_LABELS = { common: "Common", uncommon: "Uncommon", rare: "Rare", epic: "Epic", legendary: "Legendary" };
const boostLabel = (b) => b?.power && b.power === b.guard && b.power === b.luck ? "+" + b.power + " to all stats" : ["power", "guard", "luck"].filter((k) => b?.[k]).map((k) => "+" + b[k] + " " + k).join(", ");
async function loadPets() {
  const r = await api("/api/pets/" + CHANNEL), box = $("#pet-custom-list");
  if (!r.ok) { box.replaceChildren(h("p", { class: "muted small" }, "Couldn't list pets: " + errorText(r))); return; }
  const custom = (r.data.pets || []).filter((p) => p.custom), max = r.data.limits?.maxPets || 24;
  $("#pet-count").textContent = "(" + custom.length + " of " + max + ")";
  if (!custom.length) { box.replaceChildren(h("p", { class: "muted small" }, "No custom pets yet. Viewers can buy the 14 built-in pets.")); return; }
  box.replaceChildren(h("div", { class: "table-wrap" }, h("table", { class: "data" },
    h("thead", {}, h("tr", {}, h("th", {}, "Pet"), h("th", {}, "Tier"), h("th", {}, "Boost"), h("th", { class: "num" }, "Price ($)"), h("th", {}, h("span", { class: "sr-only" }, "Actions")))),
    h("tbody", {}, custom.map((p) => h("tr", {},
      h("td", {}, h("img", { class: "pet-thumb", src: p.url, alt: "", width: 32, height: 32 }), " " + p.label),
      h("td", {}, TIER_LABELS[p.tier] || p.tier), h("td", {}, boostLabel(p.boost)), h("td", { class: "num" }, p.price),
      h("td", {}, h("button", { type: "button", class: "btn btn-small btn-danger", onclick: (e) => deletePet(p, e.currentTarget) }, "Delete"))))))));
}
async function deletePet(p, button) {
  if (!confirm("Delete " + p.label + "? Fighters who bought it lose it, and no dollars are refunded.")) return;
  button.disabled = true;
  const r = await api("/api/pets/" + CHANNEL + "/" + p.id, { method: "DELETE" });
  button.disabled = false;
  setStatus($("#pet-upload-status"), r.ok ? p.label + " deleted." : "Couldn't delete: " + errorText(r) + ".", r.ok ? "ok" : "error");
  if (r.ok) loadPets();
}
function syncPetStats() {
  const tier = $("#pet-tier").value;
  $("#pet-stat-wrap").hidden = tier === "legendary";
  $("#pet-stat2-wrap").hidden = tier !== "epic";
}
$("#pet-tier").addEventListener("change", syncPetStats);
$("#pet-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("#pet-upload-status"), file = $("#pet-file").files[0], label = $("#pet-label").value.trim(), tier = $("#pet-tier").value;
  const stat = $("#pet-stat").value, stat2 = $("#pet-stat2").value;
  if (!file) return setStatus(status, "Choose a PNG image.", "error");
  if (file.type !== "image/png") return setStatus(status, "The image must be a PNG.", "error");
  if (file.size > 65536) return setStatus(status, "The image is larger than 64 KB.", "error");
  if (!label) return setStatus(status, "Name the pet.", "error");
  if (tier === "epic" && stat === stat2) return setStatus(status, "Epic pets boost two different stats.", "error");
  const image = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = reject; fr.readAsDataURL(file); });
  const button = $("#pet-upload");
  button.disabled = true;
  setStatus(status, "Uploading…");
  const r = await api("/api/pets/" + CHANNEL, { method: "POST", body: { label, tier, stat, stat2, image } });
  button.disabled = false;
  if (!r.ok) return setStatus(status, "Not uploaded: " + errorText(r) + ".", "error");
  setStatus(status, label + " is in the shop now.", "ok");
  $("#pet-form").reset(); syncPetStats();
  loadPets();
});

// Lane D hook: public/upload.js may export mountUpload(root, ctx). Probe first so a missing file stays quiet.
async function mountUploads() {
  const root = $("#upload-root");
  try {
    const probe = await fetch("/upload.js", { method: "HEAD" });
    if (!probe.ok || !/javascript/.test(probe.headers.get("Content-Type") || "")) return;
    const url = new URL("/upload.js", location.origin).href;   // absolute, so Vite dev doesn't rewrite it to /upload.js?import
    const mod = await import(/* @vite-ignore */ url);
    if (typeof mod.mountUpload !== "function") return;
    root.replaceChildren(); root.classList.remove("mount");   // the uploader brings its own frame
    await mod.mountUpload(root, { channel: CHANNEL, usage: S.admin.customUsage, limits: customLimits || LIMITS, items: customItems || [],
      refresh: async () => { await Promise.all([load(), loadCustom()]); } });
  } catch (error) {
    root.replaceChildren(h("p", { class: "status error" }, "The upload tool failed to load: " + (error?.message || error)));
  }
}

// ---------- chat connection ----------
const CHAT_STATUS = { enabled: "connected", webhook_callback_verification_pending: "waiting for Twitch to verify the webhook", pending: "waiting for Twitch to verify the webhook",
  disconnected: "not connected", authorization_revoked: "Twitch permission was revoked", user_removed: "the Twitch account was removed",
  notification_failures_exceeded: "Twitch stopped after repeated delivery failures", version_removed: "Twitch retired this subscription version", subscription_missing: "the subscription no longer exists on Twitch" };
let verifying = false;   // "Twitch is verifying" note shown after Connect chat; replaced once the webhook is verified
function renderChat() {
  const c = S.admin.chatStatus || {};
  if (verifying && c.connected) { verifying = false; setStatus($("#chat-status"), "Chat connected. Duels are live.", "ok"); }
  const parts = ["Status: " + (CHAT_STATUS[c.status] || c.status || "not connected") + "."];
  if (c.lastNotificationAt) parts.push("Last chat message " + timeAgo(c.lastNotificationAt) + ".");
  if (c.lastRevocationReason) parts.push("Last revocation: " + (CHAT_STATUS[c.lastRevocationReason] || c.lastRevocationReason) + ".");
  if (S.admin.seOnly) parts.push("This site takes chat from StreamElements only; the first StreamElements command connects it.");
  else if (!c.connected) parts.push("Duels stay paused until chat is connected.");
  $("#chat-actions").hidden = !!S.admin.seOnly;
  if (S.admin.seOnly) $("#owner-chat").hidden = true;
  $("#chat-text").textContent = parts.join(" ");
  $("#connect-chat").textContent = c.connected ? "Reconnect chat" : "Connect chat";
  $("#disconnect-chat").disabled = !c.subscriptionId && !c.connected;
}
async function chatAct(action, button, takeover = false) {
  if (action === "disconnectChat" && !confirm("Disconnect Twitch chat? Duels pause and open duels are cancelled without scoring.")) return;
  button.disabled = true;
  setStatus($("#chat-status"), action === "connectChat" ? "Asking Twitch for a chat subscription…" : "Disconnecting…");
  const r = await api("/api/admin/" + CHANNEL, { method: "POST", body: takeover ? { action, takeover: true } : { action } });
  button.disabled = false;
  // One Twitch app serves both sites, and Twitch allows one chat subscription per channel: offer to move it here.
  if (r.status === 409 && r.data?.connectedElsewhere && !takeover
    && confirm("Chat is connected to " + r.data.connectedElsewhere + ". Only one site can receive chat at a time. Move chat to this site? The other site pauses.")) return chatAct(action, button, true);
  if (!r.ok) {
    const fix = r.data?.reconnect ? (S.access.owner ? " Use Reconnect Twitch below." : " Ask nesszerra to reconnect Twitch.") : "";
    return setStatus($("#chat-status"), "That didn't work: " + errorText(r) + fix, "error");
  }
  verifying = action === "connectChat" && !r.data?.chatStatus?.connected;
  setStatus($("#chat-status"), action === "disconnectChat" ? "Chat disconnected. Duels are paused." : verifying ? "Subscription created. Twitch is checking the connection; this updates when it's done." : "Chat connected. Duels are live.", "ok");
  await load();
}
$("#connect-chat").addEventListener("click", (e) => chatAct("connectChat", e.currentTarget));
$("#disconnect-chat").addEventListener("click", (e) => chatAct("disconnectChat", e.currentTarget));

// ---------- StreamElements ----------
const SE_LABELS = { challenge: "Challenge @viewer", accept: "Accept a challenge", decline: "Decline a challenge", rematch: "Rematch the last rival", top: "Top 5 by Elo", elo: "Own Elo, or @viewer's", help: "How to play", pet: "Own pet, or @viewer's", checkin: "Daily check-in", wallet: "Wallet", give: "Give dollars", attack: "Default ability", strike: "Strike", heavy: "Heavy strike", heal: "Heal" };
function renderSe() {
  const se = S.admin.streamelements, c = S.admin.chatStatus || {};
  const using = c.connected && c.source === "streamelements", twitch = c.connected && c.source === "twitch";
  $("#use-se").textContent = using ? "StreamElements is the chat source" : "Use StreamElements";
  $("#use-se").disabled = using || !se;
  $("#copy-timer").disabled = !se;
  // Test and production each have their own key, so commands copied from the other site never arrive here.
  const health = $("#se-health"), host = se?.origin ? new URL(se.origin).host : location.host;
  let warn = "", note = "";
  if (se && !twitch && !se.lastCommandAt && !using) note = "No StreamElements command has reached " + host + " yet. Add the commands from the table below, then type " + (se.names?.decline || "!decline") + " in chat to test.";
  else if (se && using && !se.lastCommandAt) warn = "No StreamElements command has reached " + host + " with this key yet. If the replies in StreamElements were copied from another site, such as the test site, copy every reply again from the table below (they point at " + host + "), paste them into StreamElements, then type " + (se.names?.decline || "!decline") + " in chat to test.";
  else if (se && se.rejectedAt > se.lastCommandAt) warn = "A StreamElements command arrived " + timeAgo(se.rejectedAt) + " with an old key and was refused. Copy every reply again from the table below and paste it into StreamElements.";
  else if (se?.lastCommandAt) note = "Last StreamElements command reached " + host + " " + timeAgo(se.lastCommandAt) + ".";
  health.hidden = !(warn || note);
  health.className = warn ? "callout warning small" : "small muted";
  health.textContent = warn || note;
  $("#se-setup").hidden = !se;   // no key on this site: an empty table and dead buttons only confuse
  if (!se) return;
  const tbody = $("#se-table tbody");
  if (tbody.dataset.key !== se.key || !tbody.children.length) drawSeTable(se, tbody);   // otherwise keep unsaved name edits
  for (const cell of tbody.querySelectorAll("[data-seen]")) {
    const at = se.seen?.[cell.dataset.seen];
    cell.replaceChildren(h("span", { class: at ? "badge positive" : "badge" }, at ? "Working · " + timeAgo(at) : "Not used yet"));
  }
}
function drawSeTable(se, tbody) {
  tbody.dataset.key = se.key;
  tbody.replaceChildren(...se.commands.map((cmd) => {
    const tr = document.createElement("tr");
    const label = document.createElement("td"); label.textContent = SE_LABELS[cmd.action] || cmd.action;
    const nameCell = document.createElement("td"), input = document.createElement("input");
    Object.assign(input, { value: cmd.name, name: "se-" + cmd.action, maxLength: 25, spellcheck: false });
    input.setAttribute("aria-label", "Command name for " + (SE_LABELS[cmd.action] || cmd.action));
    input.dataset.action = cmd.action; nameCell.append(input);
    // The cell shows where the command points but not the key, so the page is safe to show on stream; Copy reply copies the whole line.
    const reply = document.createElement("td"), code = document.createElement("code"), copy = document.createElement("button");
    code.textContent = cmd.response.replace(/https?:\/\/[^/]+/, "").replace(/\?k=.*$/, "?k=…)");
    code.className = "reply-preview";
    Object.assign(copy, { type: "button", className: "btn btn-small", textContent: "Copy reply" });
    copy.setAttribute("aria-label", "Copy reply for " + cmd.name);
    copy.addEventListener("click", async () => { await navigator.clipboard.writeText(cmd.response); setStatus($("#se-status"), "Copied the reply for " + input.value + ". Paste it as the response of that StreamElements command.", "ok"); });
    reply.append(copy, " ", code);
    const seen = document.createElement("td"); seen.dataset.seen = cmd.action;
    tr.append(label, nameCell, seen, reply);
    return tr;
  }));
}
async function seAct(body, button, done) {
  button.disabled = true;
  const r = await api("/api/admin/" + CHANNEL, { method: "POST", body });
  button.disabled = false;
  if (!r.ok) return setStatus($("#se-status"), "That didn't work: " + errorText(r), "error");
  setStatus($("#se-status"), done, "ok");
  $("#se-table tbody").dataset.key = "";
  await load();
}
$("#use-se").addEventListener("click", (e) => {
  const c = S.admin.chatStatus || {};
  if (c.connected && c.source === "twitch" && !confirm("Switch from Twitch chat to StreamElements? Open duels are not affected, but chat messages without a command stop reaching the arena.")) return;
  seAct({ action: "useStreamElements" }, e.currentTarget, "StreamElements is now the chat source. Duels are live.");
});
$("#save-se-names").addEventListener("click", (e) => {
  const names = Object.fromEntries([...document.querySelectorAll("#se-table input")].map((i) => [i.dataset.action, i.value.trim()]));
  seAct({ action: "setSeNames", names }, e.currentTarget, "Names saved. Update the command names in StreamElements to match.");
});
$("#copy-timer").addEventListener("click", async () => {
  const text = S.admin?.streamelements?.timerText;
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus($("#se-status"), "Copied the timer message. Paste it as the message of a StreamElements timer.", "ok");
});
$("#rotate-se").addEventListener("click", (e) => {
  if (!confirm("Make a new key? Every StreamElements command stops working until you paste the new replies.")) return;
  seAct({ action: "rotateSeKey" }, e.currentTarget, "New key made. Copy every reply again into StreamElements.");
});

// ---------- setup checklist ----------
// Each step has a live state from /api/admin; the Live tab points at the first unfinished one.
const DUEL_ACTIONS = ["challenge", "accept", "decline"];
function setupSteps() {
  const a = S.admin, se = a.streamelements, seen = se?.seen || {}, c = a.chatStatus || {};
  const twitch = c.connected && c.source === "twitch";   // Twitch chat directly: the StreamElements steps don't apply
  return [
    { id: "check-overlay", done: a.overlays > 0, next: "open the overlay in OBS" },
    { id: "check-duel", done: twitch || !!se?.duelModuleOff, next: "turn off the StreamElements Duel module" },
    { id: "check-commands", done: twitch || (!!se && DUEL_ACTIONS.every((x) => seen[x])), next: "test the commands in chat" },
    { id: "check-mods", done: !!a.modsReady && !a.modsLapsed, optional: true },
  ];
}
function renderChecklist() {
  const a = S.admin, se = a.streamelements, c = a.chatStatus || {}, twitch = c.connected && c.source === "twitch";
  const steps = setupSteps(), required = steps.filter((s) => !s.optional), done = required.filter((s) => s.done).length;
  for (const s of steps) {
    const li = $("#" + s.id), badge = li.querySelector("[data-badge]");
    badge.textContent = s.done ? "Done" : s.optional ? "Optional" : "To do";
    badge.className = "badge" + (s.done ? " positive" : s.optional ? "" : " warning");
  }
  const detail = (id, text) => { $("#" + id + " [data-detail]").textContent = text; };
  const n = a.overlays || 0;
  detail("check-overlay", n ? n + " overlay" + (n === 1 ? " is" : "s are") + " connected right now." : "No overlay is open right now. It turns Done while OBS shows the overlay.");
  const box = $("#duel-module-off");
  if (document.activeElement !== box) box.checked = !!se?.duelModuleOff;
  box.disabled = !se;
  if (twitch) detail("check-commands", "Twitch chat is connected directly, so StreamElements commands aren't needed.");
  else if (!se) detail("check-commands", "StreamElements isn't available for this channel.");
  else {
    const missing = se.commands.filter((x) => !se.seen?.[x.action]);
    detail("check-commands", (se.commands.length - missing.length) + " of " + se.commands.length + " commands have reached Mini Chat." +
      (missing.length ? " Not used yet: " + missing.map((x) => x.name).join(", ") + ". Type each one in your chat; any reply from the bot counts." : ""));
  }
  $("#check-mods [data-detail]").replaceChildren(...modsDetail());
  if (a.modsLapsed && !a.modsReady) { const b = $("#check-mods [data-badge]"); b.textContent = "Expired"; b.className = "badge warning"; }
  $("#check-title").textContent = done === required.length ? "Stream setup is done" : "Stream setup: " + done + " of " + required.length + " steps done";
  const next = required.find((s) => !s.done), pointer = $("#setup-next");
  pointer.hidden = !next;
  if (next) pointer.replaceChildren("Stream setup: " + done + " of " + required.length + " steps done. Next: ", h("a", { href: "#chat", onclick: (e) => { e.preventDefault(); goToStep(next.id); } }, next.next), ".");
}
// Step 4 reads differently for the broadcaster (who can connect), the site owner looking at another channel, and a moderator.
function modsDetail() {
  const a = S.admin, ready = !!a.modsReady && !a.modsLapsed, lapsed = !!a.modsLapsed;
  if (ready) return ["Twitch moderators of " + CHANNEL + " can sign in and use this page."];
  const broadcaster = !!S.access?.broadcaster || (!!S.access?.owner && CHANNEL === "nesszerra");
  if (broadcaster) {
    const link = h("a", { href: "/auth/login?" + new URLSearchParams({ channel: CHANNEL, connect: "mods" }) }, lapsed ? "Reconnect mod access" : "Connect mod access");
    return [lapsed ? "Mod access expired, so your Twitch moderators can't sign in until you reconnect it. " : "Your Twitch moderators can't sign in yet. Mini Chat needs permission to read your moderator list. ", link];
  }
  const state = lapsed ? "Mod access expired" : "Mod access isn't connected";
  return [state + ". " + (S.access?.owner ? CHANNEL + " has to " + (lapsed ? "reconnect" : "connect") + " it from their own Stream setup page." : "Ask " + CHANNEL + " to " + (lapsed ? "reconnect" : "connect") + " it.")];
}
function goToStep(id) {
  selectTab($("#tab-chat"));
  const li = $("#" + id);
  li.scrollIntoView({ block: "center" });
  li.focus({ preventScroll: true });
}
$("#duel-module-off").addEventListener("change", async (e) => {
  const box = e.currentTarget;
  box.disabled = true;
  const r = await api("/api/admin/" + CHANNEL, { method: "POST", body: { action: "setDuelModuleOff", value: box.checked } });
  box.disabled = false;
  if (!r.ok) { box.checked = !box.checked; return setStatus($("#check-status"), "Couldn't save: " + errorText(r) + ".", "error"); }
  setStatus($("#check-status"), box.checked ? "Saved: the Duel module is off." : "Saved: the Duel module step is open again.", "ok");
  await load();
});
// ---------- turning Mini Chat off (invited channels; the broadcaster or the owner) ----------
const mayPower = () => !!(S.access?.broadcaster || S.access?.owner) && ["on", "paused"].includes(S.admin?.channelState);
function renderPower() {
  const paused = S.admin.channelState === "paused", toggle = $("#power-toggle");
  $("#channel-power").hidden = !mayPower();
  $("#power-title").textContent = paused ? "Mini Chat is off on " + CHANNEL : "Turn Mini Chat off";
  $("#power-text").textContent = paused
    ? "The overlay, the chat commands and the viewer page are stopped. Fighters and ranks are kept, so turning it back on picks up where it left off."
    : "Stops the overlay, the chat commands and the viewer page on " + CHANNEL + ". Fighters and ranks are kept, and you can turn it back on here at any time.";
  toggle.textContent = paused ? "Turn Mini Chat back on" : "Turn Mini Chat off";
  toggle.className = paused ? "btn btn-primary" : "btn btn-danger";
  const note = $("#paused-note");
  note.hidden = !paused;
  if (paused) note.replaceChildren("Mini Chat is off on " + CHANNEL + ": the overlay, the commands and the viewer page are stopped. ",
    mayPower() ? h("a", { href: "#chat", onclick: (e) => { e.preventDefault(); selectTab($("#tab-chat")); $("#channel-power").scrollIntoView({ block: "center" }); toggle.focus({ preventScroll: true }); } }, "Turn it back on") : CHANNEL + " can turn it back on.");
}
$("#power-toggle").addEventListener("click", async (e) => {
  const button = e.currentTarget, pause = S.admin.channelState !== "paused";
  if (pause && !confirm("Turn Mini Chat off on " + CHANNEL + "? The overlay, the commands and the viewer page stop until you turn it back on. Fighters and ranks are kept.")) return;
  button.disabled = true;
  const r = await api("/api/admin/" + CHANNEL, { method: "POST", body: { action: pause ? "pauseChannel" : "resumeChannel" } });
  button.disabled = false;
  if (!r.ok) return setStatus($("#power-status"), "Couldn't change it: " + errorText(r) + ".", "error");
  setStatus($("#power-status"), pause ? "Mini Chat is off. Overlays and chat commands stop within a minute." : "Mini Chat is back on. Refresh the OBS source if the overlay stays empty.", "ok");
  await load();
  if (!pause && !S.socket) connectLive();
});

// While setup is unfinished and on screen, refetch every 10 s so a new overlay or command turns its row to Done.
setInterval(() => { if (S.admin && !document.hidden && !$("#panel-chat").hidden && setupSteps().some((s) => !s.done && !s.optional)) load(); }, 10000);

// ---------- live updates ----------
function connectLive() {
  let ws;
  try { ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/live/" + CHANNEL); } catch { return; }
  S.socket = ws;
  ws.onopen = () => { S.retry = 0; };
  ws.onmessage = (event) => {
    let snap; try { snap = JSON.parse(event.data); } catch { return; }
    if (snap?.type !== "snapshot" || !S.admin || snap.revision <= S.admin.revision) return;
    const versionChanged = snap.configVersion !== S.admin.configVersion;
    Object.assign(S.admin, { revision: snap.revision, paused: snap.paused, chat: snap.chat, config: snap.config, configVersion: snap.configVersion, round: snap.round, players: snap.players, duels: snap.duels, events: snap.events });
    if (versionChanged || Boolean(snap.chat?.connected) !== Boolean(S.admin.chatStatus?.connected)) load(); else renderAll();
  };
  ws.onclose = () => { S.socket = null; const wait = Math.min(30000, 1000 * 2 ** S.retry++); setTimeout(connectLive, wait); };
}
// Countdown text in the duels table ages; refresh it every few seconds without refetching.
setInterval(() => { if (S.admin && !document.hidden) renderDuels(); }, 5000);

init();
