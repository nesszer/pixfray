// Mod page state shared by every tab: the session, access, arena and leaderboard, loading them, and the actions
// that change them (POST /api/admin/:channel, docs/CONTRACTS.md section 2).
import { api, errorText, h, $, setStatus, tabKey, emptyRow, CHANNEL, CHANNEL_PICKED } from "../ui.ts";
import { parseAdmin, parseAdminSnapshot, parseAnswer, parseLeaderboard } from "../parse.ts";
import type { Access, Admin, ChatStatus, LeaderRow, Session } from "../parse.ts";
import { isObject, warnOnce } from "../served/parse.ts";
import site from "../../site.config.js";

export const S: {
  session: Session | null;
  access: Access | null;
  admin: Admin | null;
  leaderboard: LeaderRow[];
  names: Map<string, string>;
  socket: WebSocket | null;
  retry: number;
} = { session: null, access: null, admin: null, leaderboard: [], names: new Map(), socket: null, retry: 0 };
// Every control reads these: init() keeps the gate up until access is confirmed and load() fills S.admin, and a
// failed reload keeps the old value.
export const admin = () => S.admin as Admin; // as: see above
export const access = () => S.access as Access; // as: see above
// The chat source as the live snapshot last saw it, else as the admin read did.
export const liveChat = (a: Admin): ChatStatus => a.chatStatus || a.chat || {};
export const OPEN = new Set(["pending", "active"]);
export const mayBroadcast = () => !!(S.access?.broadcaster || S.access?.owner);
export const broadcasterHere = () => !!S.access?.broadcaster || (!!S.access?.owner && CHANNEL === site.defaultChannel);
// The bare /admin/ (no ?channel) is for anyone: it names no channel until sign-in shows whose controls these are.
export const BARE = !CHANNEL_PICKED;
const actionStatus = $<HTMLParagraphElement>("#action-status");

// ---------- tabs ----------
// One panel at a time; the URL hash (#players, #rules, ...) keeps the tab across reloads and links.
const TABS = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
export function selectTab(tab: HTMLElement, focus = false) {
  for (const t of TABS) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    $("#panel-" + t.id.slice(4)).hidden = !on;
  }
  if (focus) tab.focus();
  const hash = "#" + tab.id.slice(4);
  if (location.hash !== hash)
    history.replaceState(null, "", hash === "#live" ? location.pathname + location.search : hash);
}
for (const t of TABS) {
  t.addEventListener("click", () => selectTab(t));
  t.addEventListener("keydown", (e) => {
    const next = tabKey(TABS, TABS.indexOf(t), e.key);
    if (!next) return;
    e.preventDefault();
    selectTab(next, true);
  });
}
selectTab(document.getElementById("tab-" + location.hash.slice(1)) || $("#tab-live"));

// ---------- rendering ----------
// The entry lists every renderer in page order; the `ranks` ones also redraw when the leaderboard loads.
export const RENDER: { all: (() => void)[]; ranks: (() => void)[] } = { all: [], ranks: [] };
export function renderAll() {
  for (const p of S.admin?.history || []) if (p.actorName) S.names.set(p.actorId, p.actorName);
  for (const p of [...S.leaderboard, ...(S.admin?.players || [])]) S.names.set(p.userId, p.displayName || p.username);
  for (const draw of RENDER.all) draw();
}
// Snapshots rebuild the tables; put keyboard focus back on the same row's button afterwards, and show `none` when
// there are no rows.
export function fillTable(id: string, rows: HTMLElement[], cols: number, none: string) {
  const tbody = $("#" + id + " tbody"),
    focused = document.activeElement;
  const key = focused instanceof HTMLElement && tbody.contains(focused) ? focused.dataset.key : undefined;
  tbody.replaceChildren(...(rows.length ? rows : [emptyRow(cols, none)]));
  if (key) $<HTMLButtonElement | null>('[data-key="' + CSS.escape(key) + '"]', tbody)?.focus();
}
export function nameOf(id: string | undefined) {
  if (!id) return "—";
  if (id === "system") return "System";
  if (S.session?.user?.id === id) return (S.session.user.displayName || S.session.user.login) + " (you)";
  return S.names.get(id) || "Twitch user " + id;
}

// ---------- loading ----------
export function gate(text: string, actions: Node[] = []) {
  $("#gate").hidden = false;
  $("#app").hidden = true;
  $("#gate-text").textContent = text;
  $("#gate-actions").replaceChildren(...actions);
  gateProof();
}
// the gate shows the arena these controls run, live: whether duels are on and who leads (public data only)
let proofLoaded = false;
async function gateProof() {
  if (proofLoaded || BARE) return;
  proofLoaded = true;
  const [st, lb] = await Promise.all([
    api("/api/state/" + CHANNEL),
    api("/api/leaderboard/" + CHANNEL + "?private=1").then((r) => parseAnswer(r, parseLeaderboard, "the leaderboard")),
  ]);
  if (!st.ok && !lb.ok) return;
  const ranked = lb.ok ? lb.data.filter((p) => p.wins + p.losses > 0).sort((a, b) => b.elo - a.elo) : [];
  const parts = [];
  if (st.ok) parts.push(st.data.paused || st.data.config?.enabled === false ? "duels are paused" : "duels are running");
  const top = ranked[0],
    n = ranked.length;
  if (lb.ok)
    parts.push(
      top
        ? `${n} ranked fighter${n === 1 ? "" : "s"}, ${top.displayName || top.username} leads at ${top.elo} Elo`
        : "no ranked duels yet",
    );
  const p = $("#gate-proof");
  p.textContent = `Right now in ${CHANNEL}'s arena: ${parts.join("; ")}.`;
  p.hidden = false;
}
export async function load() {
  const r = parseAnswer(await api("/api/admin/" + CHANNEL), parseAdmin, "the arena state");
  if (r.status === 401 || r.status === 403)
    return gate("Your access changed: " + errorText(r) + ". Reload to check again.", [
      h("button", { class: "btn", type: "button", onclick: () => location.reload() }, "Reload"),
    ]);
  if (!r.ok) {
    setStatus(actionStatus, "Couldn't load the arena: " + errorText(r), "error");
    return false;
  }
  S.admin = r.data;
  renderAll();
  return true;
}
export async function loadLeaderboard() {
  const r = parseAnswer(await api("/api/leaderboard/" + CHANNEL + "?private=1"), parseLeaderboard, "the leaderboard");
  S.leaderboard = r.ok ? r.data : [];
  if (S.admin) for (const draw of RENDER.ranks) draw();
}

// ---------- actions ----------
export const post = (body: Record<string, unknown>) => api("/api/admin/" + CHANNEL, { method: "POST", body });
export async function act(
  action: string,
  payload?: unknown,
  { confirmText, button, done }: { confirmText?: string | undefined; button?: HTMLButtonElement; done?: string } = {},
) {
  if (confirmText && !confirm(confirmText)) return null;
  if (button) button.disabled = true;
  setStatus(actionStatus, "Working…");
  const r = await post(payload === undefined ? { action } : { action, payload });
  if (button) button.disabled = false;
  if (!r.ok) {
    setStatus(actionStatus, "That didn't work: " + errorText(r), "error");
    return r;
  }
  setStatus(actionStatus, done || "Done.", "ok");
  await load();
  await loadLeaderboard();
  return r;
}

// ---------- live updates ----------
export function connectLive() {
  let ws;
  try {
    ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/live/" + CHANNEL);
  } catch {
    return;
  }
  S.socket = ws;
  ws.onopen = () => {
    S.retry = 0;
  };
  ws.onmessage = (event) => {
    let frame: unknown;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return warnOnce("an arena frame", "not JSON");
    }
    // events and looks pushes also arrive here; this page reads only snapshots
    if (!isObject(frame) || frame.type !== "snapshot") return;
    const parsed = parseAdminSnapshot(frame);
    if (!parsed.ok) return warnOnce("an arena snapshot", parsed.error);
    const snap = parsed.value;
    if (!S.admin || snap.revision <= S.admin.revision) return;
    const versionChanged = snap.configVersion !== S.admin.configVersion;
    Object.assign(S.admin, {
      revision: snap.revision,
      paused: snap.paused,
      chat: snap.chat,
      config: snap.config,
      configVersion: snap.configVersion,
      round: snap.round,
      players: snap.players,
      duels: snap.duels,
      events: snap.events,
    });
    if (versionChanged || Boolean(snap.chat?.connected) !== Boolean(S.admin.chatStatus?.connected)) load();
    else renderAll();
  };
  ws.onclose = () => {
    S.socket = null;
    const wait = Math.min(30000, 1000 * 2 ** S.retry++);
    setTimeout(connectLive, wait);
  };
}
