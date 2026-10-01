// Viewer dashboard ("/"): sign-in state, character picker with live preview, nameplate color,
// profile save and a compact leaderboard. Talks only to the routes in CONTRACTS.md section 2.
import { api, errorText, h, $, setStatus, renderWho, signOut, addSprite, seconds, CHANNEL, DEFAULT_COLOR, applyChannel } from "./ui.js";
applyChannel();

const SWATCHES = ["#a78bfa", "#60a5fa", "#34d399", "#fbbf24", "#f87171", "#f472b6", "#e5e7eb", "#22d3ee"];
const form = $("#profile-form"), saveBtn = $("#save"), saveSignin = $("#save-signin"), status = $("#save-status");
const colorInput = $("#color"), nameplate = $("#nameplate");
const state = { session: null, catalog: [], profile: null, saved: null, leaderboard: [], config: null };
const preview = addSprite($("#preview"), null, { anim: "walk" });

const current = () => ({
  avatar: form.querySelector("input[name=character]:checked")?.value || state.catalog[0]?.id || "",
  color: colorInput.value.toLowerCase(),
  defaultAbility: state.profile?.defaultAbility || "strike",   // only used by the HP fight; quick duels ignore it
});
const dirty = () => { const c = current(), s = state.saved; return !s || c.avatar !== s.avatar || c.color !== s.color; };

function renderCharacters() {
  const box = $("#characters");
  if (!state.catalog.length) { box.replaceChildren(h("p", { class: "muted small" }, "No characters are available right now. Reload to try again.")); return; }
  $("#char-count").textContent = "(" + state.catalog.length + " available)";
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
  nameplate.textContent = state.session?.user?.displayName || "you";
  nameplate.style.color = c.color;
  nameplate.style.borderColor = c.color;
  $("#preview-caption").textContent = entry ? entry.label || entry.id : "";
  for (const s of document.querySelectorAll(".swatch")) s.setAttribute("aria-pressed", String(s.dataset.color === c.color));
  if (state.session?.user && state.saved) setStatus(status, dirty() ? "You have unsaved changes." : "Saved. Your fighter shows up on stream with these settings.", dirty() ? "" : "ok");
}

function applyProfile(p) {
  const avatar = state.catalog.some((x) => x.id === p?.avatar) ? p.avatar : state.catalog[0]?.id;
  const radio = avatar && document.getElementById("char-" + avatar);
  if (radio) radio.checked = true;
  colorInput.value = /^#[0-9a-f]{6}$/i.test(p?.color || "") ? p.color.toLowerCase() : DEFAULT_COLOR;
}

function renderCommands() {
  if (state.config) {
    $("#cmd-timeout").textContent = seconds(state.config.challengeTimeoutMs);
    $("#cmd-rematch").textContent = seconds(state.config.rematchDelayMs);
    $("#lb-note").textContent = "Ranked duels need a saved profile. Everyone starts at " + state.config.initialElo + " Elo.";
    $("#hp-mode-note").hidden = state.config.quickDuel !== false;
  }
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
  else note.textContent = "Browse freely. Sign in with Twitch to save your fighter; ranked duels need a saved profile.";
  const stats = $("#my-stats");
  stats.hidden = !state.profile;
  if (state.profile) {
    $("#stat-elo").textContent = state.profile.elo;
    $("#stat-wl").textContent = state.profile.wins + " / " + state.profile.losses;
  }
}

function renderLeaderboard() {
  const tbody = $("#leaderboard tbody"), me = state.session?.user?.id, rows = state.leaderboard;
  if (!rows.length) {
    tbody.replaceChildren(h("tr", { class: "empty" }, h("td", { colspan: 6 },
      h("strong", {}, "No ranked duels yet, so the top spot is open."), " To get on the board: ",
      state.session?.user ? "save your fighter above" : "sign in and save your fighter above",
      ", say something in chat while the stream is live so your character walks in, then type ", h("code", {}, "!challenge @viewer"), ".")));
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
  if (!r.ok) { setStatus(status, "Not saved: " + errorText(r), "error"); return; }
  state.profile = r.data.profile; state.saved = { avatar: body.avatar, color: body.color, defaultAbility: body.defaultAbility };
  renderSignedIn(); update(); loadLeaderboard();
});

async function init() {
  renderSwatches();
  const [session, catalog, live] = await Promise.all([api("/api/session"), api("/api/catalog/" + CHANNEL), api("/api/state/" + CHANNEL)]);
  state.session = session.ok ? session.data : null;
  state.catalog = catalog.ok && Array.isArray(catalog.data) ? catalog.data : [];
  if (!state.catalog.length) {
    const fallback = await api("/assets/characters.json");   // the static list still works if the API is down
    if (fallback.ok && Array.isArray(fallback.data)) state.catalog = fallback.data;
  }
  state.config = live.ok ? live.data?.config : null;
  renderCharacters(); renderCommands();
  if (state.session?.user) {
    const [profile, access] = await Promise.all([api("/api/profile/" + CHANNEL), api("/api/access/" + CHANNEL)]);
    state.profile = profile.ok ? profile.data : null;
    $("#admin-link").hidden = !(access.ok && access.data?.canManage);
    const p = state.profile || {};
    applyProfile(p);
    state.saved = state.profile ? { avatar: state.profile.avatar, color: state.profile.color.toLowerCase(), defaultAbility: state.profile.defaultAbility } : null;
    if (!state.profile) setStatus(status, "You don't have a saved profile yet. Pick your fighter and save.");
  } else applyProfile(null);
  renderSignedIn(); update();
  loadLeaderboard();
}
init();
