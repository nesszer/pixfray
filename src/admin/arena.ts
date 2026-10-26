// The Live and Players tabs: the summary and stats, open duels, who is in the arena, ranks and the arena actions.
import { errorText, h, $, setStatus, seconds, timeAgo, on, onSubmit, busy, button, row, CHANNEL } from "../ui.ts";
import type { AdminPlayer, LeaderRow } from "../parse.ts";
import site from "../../site.config.js";
import {
  S,
  admin,
  access,
  liveChat,
  OPEN,
  mayBroadcast,
  broadcasterHere,
  nameOf,
  act,
  post,
  load,
  loadLeaderboard,
  selectTab,
  fillTable,
} from "./state.ts";

export function renderSummary() {
  const a = admin(),
    c = a.config,
    open = a.duels.filter((d) => OPEN.has(d.status));
  const chat = liveChat(a),
    health = chatHealth();
  // resetting all ranks, a new StreamElements key and moving chat from another site are the broadcaster's (server/worker.ts)
  for (const id of ["#reset-all-ranks", "#rotate-se"]) $(id).hidden = !mayBroadcast();
  const role = broadcasterHere() ? "the broadcaster" : access().owner ? "the site owner" : "a moderator";
  $("#meta").textContent = `Signed in as ${role}.`;
  const waiting = c.enabled && !health.ok;
  $("#summary-title").textContent = !c.enabled
    ? "Duels are paused by a moderator"
    : waiting
      ? health.title
      : "Duels are live";
  $("#summary-text").textContent = !c.enabled
    ? "Chat commands are ignored until duels are turned back on."
    : waiting
      ? health.text + (chat.lastRevocationReason ? " Twitch revoked access: " + chat.lastRevocationReason + "." : "")
      : `${open.length} of ${c.maxDuels} duel slots in use, ${a.players.length} viewers in the arena.`;
  const toggle = $("#toggle-duels");
  toggle.textContent = c.enabled ? "Pause duels" : "Turn duels on";
  // while chat is offline the fix is the main action: Connect chat right here where Twitch chat applies, else the Stream setup tab
  const connectHere = waiting && !chat.connected && !$("#chat-box").hidden && !a.seOnly;
  $("#summary-connect").hidden = !connectHere;
  $("#open-chat-setup").hidden = !waiting;
  $("#open-chat-setup").className = "btn" + (connectHere ? "" : " btn-primary");
  toggle.classList.toggle("btn-primary", !waiting);
  $("#stats").replaceChildren(
    stat(
      "Duels",
      !c.enabled ? "Paused" : waiting ? "Waiting" : "On",
      !c.enabled ? "down" : waiting ? "" : "up",
      !c.enabled ? "commands ignored" : waiting ? "for chat" : "accepting commands",
    ),
    stat(health.label, health.value, health.ok ? "up" : "down", health.note),
    stat("Open duels", open.length + " / " + c.maxDuels),
    stat("In the arena", a.players.length),
  );
  const announce = $<HTMLSelectElement>("#announce"),
    cap = $<HTMLInputElement>("#cap");
  if (document.activeElement !== announce) announce.value = c.announce || "off";
  if (document.activeElement !== cap) cap.value = String(c.maxOnStream || 50);
}
// Where chat comes from and whether it works. StreamElements counts as working only once a command has
// arrived with this site's key; choosing it as the source isn't enough. The Stream setup tab uses the same rules.
function chatHealth():
  | { ok: false; label: string; value: string; note: string; title: string; text: string }
  | { ok: true; label: string; value: string; note: string } {
  const a = admin(),
    c = liveChat(a),
    se = a.streamelements;
  const fix = " Finish step 3, Add the chat commands to StreamElements, on the Stream setup tab.";
  if (!c.connected)
    return {
      ok: false,
      label: "Chat",
      value: "Not connected",
      note: "no chat source",
      title: "Waiting for chat",
      text:
        CHANNEL === site.defaultChannel
          ? "Duels start when chat is connected. Connect Twitch chat or set up StreamElements on the Stream setup tab."
          : "Duels start when chat commands reach PixFray." + fix,
    };
  if (c.source === "streamelements") {
    if (se && se.rejectedAt > (se.lastCommandAt || 0))
      return {
        ok: false,
        label: "StreamElements",
        value: "Old key",
        note: "a command was refused " + timeAgo(se.rejectedAt),
        title: "StreamElements is sending an old key",
        text:
          "A command arrived " +
          timeAgo(se.rejectedAt) +
          " with a key that no longer works, so it was refused. Copy every response again from the Stream setup tab and paste it into StreamElements.",
      };
    if (!se?.lastCommandAt)
      return {
        ok: false,
        label: "StreamElements",
        value: "No commands yet",
        note: "none has reached PixFray",
        title: "Waiting for the first chat command",
        text: "StreamElements is the chat source, but no command has reached PixFray yet." + fix,
      };
    return { ok: true, label: "StreamElements", value: "Working", note: "last command " + timeAgo(se.lastCommandAt) };
  }
  const last = c.lastNotificationAt ?? c.lastSeen;
  return {
    ok: true,
    label: "Twitch chat",
    value: "Connected",
    note: last ? "last message " + timeAgo(last) : "no messages yet",
  };
}
function stat(label: string, value: string | number, cls = "", delta?: string) {
  const word = typeof value === "string" && !/\d/.test(value); // "Not connected" reads smaller than a number, on one line
  return h(
    "div",
    { class: "stat" },
    h("div", { class: "label" }, label),
    h("div", { class: "value" + (word ? " word" : "") }, value),
    delta ? h("div", { class: "delta " + cls }, delta) : null,
  );
}
function hp(value: number, max: number, who?: string) {
  const pct = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  return h(
    "span",
    { class: "hp" },
    h("span", { class: "track", "aria-hidden": "true" }, h("i", { style: { "--v": pct + "%" } })),
    h("span", { class: "num" }, (who ? who + " " : "") + value + " / " + max),
  );
}
const who = (p: AdminPlayer | LeaderRow) => p.displayName || p.username;

export function renderDuels() {
  const now = Date.now(),
    a = admin();
  const rows = a.duels
    .filter((d) => OPEN.has(d.status))
    .map((d) => {
      const max = (id: string) => d.maxHp?.[id] || d.rules?.maxHp || a.config.maxHp;
      const fighting = d.status === "active",
        names = nameOf(d.a) + " vs " + nameOf(d.b);
      const left = fighting
        ? Math.max(0, (d.lastActionAt || d.startedAt || 0) + a.config.inactivityMs - now)
        : Math.max(0, d.expiresAt - now);
      return row(
        [
          names,
          h("span", { class: "badge" + (fighting ? " positive" : "") }, fighting ? "Fighting" : "Waiting for accept"),
          fighting
            ? h(
                "div",
                {},
                h("div", {}, hp(d.hp?.[d.a] ?? max(d.a), max(d.a), nameOf(d.a))),
                h("div", {}, hp(d.hp?.[d.b] ?? max(d.b), max(d.b), nameOf(d.b))),
              )
            : "—",
          d.round || "—",
          (fighting ? "idle cancel in " : "expires in ") + seconds(Math.round(left / 1000) * 1000),
          button(
            "Cancel duel",
            (b) =>
              act(
                "cancelDuel",
                { duelId: d.id },
                {
                  button: b,
                  confirmText: "Cancel " + names + " without scoring?",
                  done: "Duel cancelled without scoring.",
                },
              ),
            { "data-key": "cancel:" + d.id, "aria-label": "Cancel duel " + names },
          ),
        ],
        [3],
      );
    });
  fillTable("duels", rows, 6, "No open duels. Viewers start one with !challenge @viewer.");
}
export function renderPlayers() {
  const now = Date.now(),
    a = admin(),
    // A fighter in a duel has its vitality max HP there.
    max = (userId: string) =>
      a.duels.find((d) => OPEN.has(d.status) && d.maxHp?.[userId])?.maxHp?.[userId] || a.config.maxHp;
  const rows = a.players.map((p) =>
    row(
      [
        [
          h("span", { style: { color: p.color }, "aria-hidden": "true" }, "■ "),
          who(p),
          p.registered ? null : h("span", { class: "muted" }, " (no profile)"),
        ],
        p.respawnAt > now ? h("span", { class: "badge negative" }, "Knocked out") : hp(p.hp, max(p.userId)),
        p.elo,
        p.wins,
        p.losses,
        timeAgo(p.lastSeen),
        removeButton(p, "remove:"),
      ],
      [2, 3, 4],
    ),
  );
  fillTable("players", rows, 7, "Nobody is in the arena. Characters appear after a viewer's first chat message.");
}
const removeButton = (p: AdminPlayer | LeaderRow, key: string) =>
  button(
    "Remove",
    (b) =>
      act(
        "removePlayer",
        { userId: p.userId },
        {
          button: b,
          confirmText: "Remove " + who(p) + " from the arena and delete their saved profile?",
          done: "Viewer removed.",
        },
      ),
    { class: "btn btn-small btn-danger", "data-key": key + p.userId, "aria-label": "Remove " + who(p) },
  );
export function renderRanks() {
  const rows = S.leaderboard.map((p, i) =>
    row(
      [
        i + 1,
        who(p),
        p.elo,
        p.wins,
        p.losses,
        p.dollars ?? 0,
        h(
          "div",
          { class: "toolbar" },
          button(
            "Reset rank",
            (b) =>
              act(
                "resetRank",
                { userId: p.userId },
                { button: b, confirmText: "Reset " + who(p) + "'s Elo, wins and losses?", done: "Rank reset." },
              ),
            { "data-key": "rank:" + p.userId, "aria-label": "Reset rank for " + who(p) },
          ),
          removeButton(p, "rank-remove:"),
        ),
      ],
      [0, 2, 3, 4, 5],
    ),
  );
  fillTable("ranks", rows, 7, "No saved profiles yet.");
}
// ---------- actions ----------
on("#toggle-duels", (b) => {
  const a = admin(),
    enabled = !a.config.enabled,
    open = a.duels.filter((d) => OPEN.has(d.status)).length;
  act(
    "config",
    { patch: { enabled }, baseVersion: a.configVersion, note: enabled ? "duels enabled" : "duels paused" },
    {
      button: b,
      confirmText:
        !enabled && open
          ? `Pause duels? The ${open} open duel${open === 1 ? "" : "s"} will be cancelled without scoring.`
          : undefined,
      done: enabled ? "Duels are on." : "Duels are paused. Open duels were cancelled without scoring.",
    },
  );
});
// Announcements and the on-screen limit live in the channel config: every open overlay picks a change up from its
// next snapshot. A failed save puts the control back to the saved value.
async function saveSetting(
  control: HTMLInputElement | HTMLSelectElement,
  patch: Record<string, unknown>,
  note: string,
  done: string,
  saved: () => string,
) {
  const status = $("#" + control.id + "-status");
  setStatus(status, "Saving…");
  const r = await busy(control, () =>
    post({ action: "config", payload: { patch, baseVersion: admin().configVersion, note } }),
  );
  if (!r.ok) {
    setStatus(status, "Couldn't save: " + errorText(r) + ".", "error");
    control.value = saved();
    return;
  }
  setStatus(status, done, "ok");
  await load();
}
on<HTMLSelectElement>(
  "#announce",
  (select) =>
    saveSetting(
      select,
      { announce: select.value },
      "announcements " + select.value,
      select.value === "off"
        ? "Announcements hidden on every overlay."
        : "Saved. Overlays show announcements within seconds.",
      () => admin().config.announce || "off",
    ),
  "change",
);
on<HTMLInputElement>(
  "#cap",
  (input) => {
    const value = Number(input.value),
      saved = () => String(admin().config.maxOnStream || 50);
    if (Number.isInteger(value) && value >= 15 && value <= 100)
      return saveSetting(
        input,
        { maxOnStream: value },
        "up to " + value + " on stream",
        "Saved. Overlays show up to " + value + " characters within seconds.",
        saved,
      );
    setStatus($("#cap-status"), "Pick a whole number from 15 to 100.", "error");
    input.value = saved();
  },
  "change",
);
on("#open-chat-setup", () => selectTab($("#tab-chat"), true));
// [button, action, confirm text, done text]: the arena-wide resets.
const RESETS = [
  [
    "#reset-health",
    "resetHealth",
    "Put every viewer in the arena back to full health?",
    "Everyone in the arena is back to full health.",
  ],
  [
    "#reset-round",
    "resetRound",
    "Cancel every open duel without scoring and restart rounds at 1?",
    "Open duels cancelled; rounds restart at 1.",
  ],
  [
    "#reset-all-ranks",
    "resetAllRanks",
    "Reset Elo, wins and losses for every saved profile on " + CHANNEL + "? This can't be undone.",
    "All ranks reset.",
  ],
  [
    "#reset-all",
    "resetAll",
    "Remove every character from the arena and cancel all duels? Saved profiles and ranks stay.",
    "Arena cleared.",
  ],
] as const;
for (const [id, action, confirmText, done] of RESETS)
  on(id, (b) => act(action, undefined, { button: b, confirmText, done }));
const NAME = /^[a-z0-9_]{1,25}$/i;
const nameIn = (id: string) => $<HTMLInputElement>(id).value.trim().replace(/^@/, "");
// Mod gift: dollars to one saved fighter (server/channel.ts giftDollars). Negative takes them back.
onSubmit("#gift-form", async () => {
  const status = $("#gift-status"),
    username = nameIn("#gift-user"),
    amount = Number($<HTMLInputElement>("#gift-amount").value);
  if (!NAME.test(username)) return setStatus(status, "Type the viewer's Twitch name.", "error");
  if (!Number.isInteger(amount) || !amount || Math.abs(amount) > 10000)
    return setStatus(status, "Pick a whole number from -10000 to 10000, not 0.", "error");
  setStatus(status, "Saving…");
  const r = await busy($<HTMLButtonElement>("#gift-send"), () =>
    post({ action: "giftDollars", payload: { username, amount } }),
  );
  if (!r.ok) {
    const why =
      r.status === 404 ? `${username} has no saved fighter on ${CHANNEL}.` : `Couldn't gift: ${errorText(r)}.`;
    return setStatus(status, why, "error");
  }
  const gave = amount > 0 ? `Gave $${amount} to` : `Took $${-amount} from`;
  setStatus(status, `${gave} ${r.data.displayName || r.data.username}. They have $${r.data.dollars} now.`, "ok");
  $<HTMLInputElement>("#gift-amount").value = "";
  await loadLeaderboard();
});
// Pair reset: one pair's ranked duels this stream start over (server/channel.ts resetPair), like !resetpair in chat.
onSubmit("#pair-form", async () => {
  const status = $("#pair-status"),
    a = nameIn("#pair-a"),
    b = nameIn("#pair-b");
  if (!NAME.test(a) || !NAME.test(b)) return setStatus(status, "Type both viewers' Twitch names.", "error");
  if (a.toLowerCase() === b.toLowerCase()) return setStatus(status, "Pick two different viewers.", "error");
  setStatus(status, "Saving…");
  const r = await busy($<HTMLButtonElement>("#pair-send"), () => post({ action: "resetPair", payload: { a, b } }));
  if (!r.ok) {
    const missing = r.data?.missing || `${a} or ${b}`;
    const why =
      r.status === 404 ? `${missing} has no saved fighter on ${CHANNEL}.` : `Couldn't reset: ${errorText(r)}.`;
    return setStatus(status, why, "error");
  }
  const left =
    typeof r.data.left === "number" ? `${r.data.left} ranked duels left this stream.` : "no limit on this channel.";
  setStatus(status, `Reset ${r.data.a} and ${r.data.b}: ${left}`, "ok");
});
// Countdown text in the duels table ages; refresh it every few seconds without refetching.
setInterval(() => {
  if (S.admin && !document.hidden) renderDuels();
}, 5000);
