// Mod controls ("/admin/"): broadcaster and moderators only (GET /api/access/:channel -> canManage).
// Uses GET/POST /api/admin/:channel (CONTRACTS.md section 2) and the read-only live socket for updates.
import { api, errorText, h, $, setStatus, renderWho, signOut, seconds, timeAgo, dateTime, formatBytes, CHANNEL, withChannel, loginHref, applyChannel } from "./ui.js";
applyChannel();
if (CHANNEL !== "nesszerra") document.querySelector(".page-header .subtitle").textContent = "For the " + CHANNEL + " broadcaster. Changes apply to every OBS overlay right away.";

const LIMITS = { maxCharacters: 8, maxFrames: 24, frameSize: 128, maxAtlasBytes: 1572864 };
// Editable config fields (CONTRACTS.md section 7). `ms` fields are edited in seconds and sent as integer ms.
const GROUPS = [
  { title: "Health and duels", fields: [
    { key: "maxHp", label: "Max health", unit: "HP", min: 1, max: 1000 },
    { key: "maxDuels", label: "Duels at the same time", unit: "duels", min: 1, max: 5 },
    { key: "challengeTimeoutMs", label: "Challenge expires after", unit: "s", ms: true, min: 5000, max: 300000 },
    { key: "inactivityMs", label: "Idle duel cancelled after", unit: "s", ms: true, min: 10000, max: 600000 },
    { key: "respawnMs", label: "Respawn after knockout", unit: "s", ms: true, min: 0, max: 60000 },
    { key: "rematchDelayMs", label: "Rematch wait", unit: "s", ms: true, min: 0, max: 600000 },
  ] },
  { title: "Ranking", fields: [
    { key: "initialElo", label: "Starting Elo", unit: "Elo", min: 0, max: 10000 },
    { key: "eloK", label: "Elo K-factor", unit: "K", min: 1, max: 100 },
  ] },
  { title: "HP fight abilities (used when quick duels are off)", fields: [
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
const show = (key, v) => v === undefined ? "—" : key === "enabled" ? (v ? "on" : "off") : LABELS[key]?.ms ? seconds(v) : v + (LABELS[key]?.unit && LABELS[key].unit !== "s" ? " " + LABELS[key].unit : "");

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
  $("#dev-link").hidden = $("#dev-open").hidden = !S.access.owner;
  $("#owner-chat").hidden = !S.access.owner || CHANNEL !== "nesszerra";
  $("#connect-chat").hidden = CHANNEL !== "nesszerra";   // other channels get chat through StreamElements only
  await Promise.all([load(), loadLeaderboard(), loadCustom()]);
  connectLive();
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
$("#open-chat-setup").addEventListener("click", () => selectTab($("#tab-chat"), true));
$("#reset-health").addEventListener("click", (e) => act("resetHealth", undefined, { button: e.currentTarget, confirmText: "Put every viewer in the arena back to full health?", done: "Everyone in the arena is back to full health." }));
$("#reset-round").addEventListener("click", (e) => act("resetRound", undefined, { button: e.currentTarget, confirmText: "Cancel every open duel without scoring and restart rounds at 1?", done: "Open duels cancelled; rounds restart at 1." }));
$("#reset-all-ranks").addEventListener("click", (e) => act("resetAllRanks", undefined, { button: e.currentTarget, confirmText: "Reset Elo, wins and losses for every saved profile on " + CHANNEL + "? This can't be undone.", done: "All ranks reset." }));
$("#reset-all").addEventListener("click", (e) => act("resetAll", undefined, { button: e.currentTarget, confirmText: "Remove every character from the arena and cancel all duels? Saved profiles and ranks stay.", done: "Arena cleared." }));

// ---------- rendering ----------
function renderAll() {
  collectNames();
  const a = S.admin, c = a.config, open = a.duels.filter((d) => OPEN.has(d.status));
  const chat = a.chatStatus || a.chat || {}, live = !!chat.connected;
  $("#meta").textContent = "Rules version " + a.configVersion + " · state revision " + a.revision + " · signed in as " + (S.access.owner ? "broadcaster" : "moderator");
  const waiting = c.enabled && !live;
  $("#summary-title").textContent = !c.enabled ? "Duels are paused by a moderator" : waiting ? "Waiting for Twitch chat" : "Duels are live";
  $("#summary-text").textContent = !c.enabled ? "Chat commands are ignored until duels are turned back on." :
    waiting ? "Duels start when chat is connected" + (chat.lastRevocationReason ? " (Twitch revoked access: " + chat.lastRevocationReason + ")" : "") + ". Connect Twitch chat or StreamElements on the Stream setup tab." :
    open.length + " of " + c.maxDuels + " duel slots in use, " + a.players.length + " viewers in the arena, round " + a.round + ".";
  const toggle = $("#toggle-duels");
  toggle.textContent = c.enabled ? "Pause duels" : "Turn duels on";
  // while chat is offline the fix is on the Stream setup tab, so that becomes the main action
  $("#open-chat-setup").hidden = !waiting;
  toggle.classList.toggle("btn-primary", !waiting);
  $("#stats").replaceChildren(
    stat("Duels", c.enabled ? "On" : "Paused", waiting ? "" : c.enabled ? "up" : "down", waiting ? "waiting for chat" : c.enabled ? "accepting commands" : "commands ignored"),
    stat(chat.source === "streamelements" ? "StreamElements" : "Twitch chat", live ? "Connected" : "Offline", live ? "up" : "down", (chat.lastNotificationAt ?? chat.lastSeen) ? "last message " + timeAgo(chat.lastNotificationAt ?? chat.lastSeen) : "no messages yet"),
    stat("Open duels", open.length + " / " + c.maxDuels),
    stat("Round", a.round),
    stat("In the arena", a.players.length),
    stat("Rules version", "v" + a.configVersion));
  renderDuels(); renderPlayers(); renderRanks(); renderConfig(); renderHistory(); renderUsage(); renderChat(); renderSe();
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
  if (!S.leaderboard.length) return tbody.replaceChildren(empty(6, "No saved profiles yet."));
  tbody.replaceChildren(...S.leaderboard.map((p, i) => h("tr", {},
    h("td", { class: "num" }, i + 1), h("td", {}, p.displayName || p.username),
    h("td", { class: "num" }, p.elo), h("td", { class: "num" }, p.wins), h("td", { class: "num" }, p.losses),
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
  box.replaceChildren(...GROUPS.map((g) => h("fieldset", { class: "config-group" }, h("legend", {}, g.title),
    h("div", { class: "config-grid" }, g.fields.map((f) => {
      const id = "cfg-" + f.key.replace(/\./g, "-"), value = get(config, f.key);
      const input = h("input", { id, type: "number", inputmode: "decimal", required: true, "data-key": f.key,
        min: f.ms ? f.min / 1000 : f.min, max: f.ms ? f.max / 1000 : f.max, step: f.ms ? 0.25 : 1, value: String(f.ms ? value / 1000 : value) });
      return h("div", {}, h("label", { for: id }, f.label + " (" + f.unit + ")"), input,
        h("p", { class: "hint" }, (f.ms ? seconds(f.min) + " to " + seconds(f.max) : f.min + " to " + f.max)));
    })))));
  syncConfigButtons();
}
function readField(input) {
  const f = LABELS[input.dataset.key], raw = input.value.trim(), n = Number(raw);
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
    ...bar("Atlas storage (max " + limit + " × 1.5 MB)", u.bytes, budget, formatBytes(u.bytes) + " / " + formatBytes(budget)));
}
async function loadCustom() {
  const r = await api("/api/assets/" + CHANNEL);
  const box = $("#custom-list");
  if (!r.ok) { box.replaceChildren(h("p", {}, "Couldn't list custom characters: " + errorText(r))); return; }
  customItems = r.data.items || []; customLimits = r.data.limits || null;
  if (!customItems.length) { box.replaceChildren(h("p", {}, "No custom characters yet. The 8 slots are shared by the broadcaster and all moderators.")); return; }
  box.replaceChildren(h("div", { class: "table-wrap" }, h("table", { class: "data" },
    h("thead", {}, h("tr", {}, h("th", {}, "Character"), h("th", { class: "num" }, "Frames"), h("th", { class: "num" }, "Size"), h("th", {}, "Added"))),
    h("tbody", {}, customItems.map((x) => h("tr", {}, h("td", {}, x.label || x.id), h("td", { class: "num" }, (x.frames || []).length + Object.values(x.animations || {}).reduce((n, f) => n + f.length, 0)),
      h("td", { class: "num" }, formatBytes(x.bytes || 0)), h("td", {}, dateTime(x.createdAt))))))));
}
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
const SE_LABELS = { challenge: "Challenge @viewer", accept: "Accept a challenge", decline: "Decline a challenge", attack: "Default ability", strike: "Strike", heavy: "Heavy strike", heal: "Heal" };
function renderSe() {
  const se = S.admin.streamelements, c = S.admin.chatStatus || {};
  const using = c.connected && c.source === "streamelements";
  $("#use-se").textContent = using ? "StreamElements is the chat source" : "Use StreamElements";
  $("#use-se").disabled = using || !se;
  // Test and production each have their own key, so commands copied from the other site never arrive here.
  const health = $("#se-health"), host = se?.origin ? new URL(se.origin).host : location.host;
  let warn = "", note = "";
  if (se && using && !se.lastCommandAt) warn = "No StreamElements command has reached " + host + " with this key yet. If the replies in StreamElements were copied from another site, such as the test site, copy every reply again from the table below (they point at " + host + "), paste them into StreamElements, then type " + (se.names?.decline || "!decline") + " in chat to test.";
  else if (se && se.rejectedAt > se.lastCommandAt) warn = "A StreamElements command arrived " + timeAgo(se.rejectedAt) + " with an old key and was refused. Copy every reply again from the table below and paste it into StreamElements.";
  else if (se?.lastCommandAt) note = "Last StreamElements command reached " + host + " " + timeAgo(se.lastCommandAt) + ".";
  health.hidden = !(warn || note);
  health.className = warn ? "callout warning small" : "small muted";
  health.textContent = warn || note;
  if (!se) return;
  const tbody = $("#se-table tbody");
  if (tbody.dataset.key === se.key && tbody.children.length) return;   // keep unsaved name edits
  tbody.dataset.key = se.key;
  tbody.replaceChildren(...se.commands.map((cmd) => {
    const tr = document.createElement("tr");
    const label = document.createElement("td"); label.textContent = SE_LABELS[cmd.action] || cmd.action;
    const nameCell = document.createElement("td"), input = document.createElement("input");
    Object.assign(input, { value: cmd.name, name: "se-" + cmd.action, maxLength: 25, spellcheck: false });
    input.setAttribute("aria-label", "Command name for " + (SE_LABELS[cmd.action] || cmd.action));
    input.dataset.action = cmd.action; nameCell.append(input);
    const reply = document.createElement("td"), code = document.createElement("code"); code.textContent = cmd.response; code.className = "wrap-anywhere"; reply.append(code);
    const copyCell = document.createElement("td"), copy = document.createElement("button");
    Object.assign(copy, { type: "button", className: "btn", textContent: "Copy reply" });
    copy.addEventListener("click", async () => { await navigator.clipboard.writeText(cmd.response); setStatus($("#se-status"), "Copied the reply for " + input.value + ". Paste it as the response of that StreamElements command.", "ok"); });
    copyCell.append(copy);
    tr.append(label, nameCell, reply, copyCell);
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
$("#rotate-se").addEventListener("click", (e) => {
  if (!confirm("Make a new key? Every StreamElements command stops working until you paste the new replies.")) return;
  seAct({ action: "rotateSeKey" }, e.currentTarget, "New key made. Copy every reply again into StreamElements.");
});

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
