// The Ranks and Rules tabs: the leaderboard, its podium, and the duel rules filled in from the channel config.
import { api, emptyRow, errorText, h, $, seconds, CHANNEL } from "../ui.ts";
import { parseAnswer, parseLeaderboard } from "../parse.ts";
import type { LeaderRow } from "../parse.ts";
import { state, thumb, entryOf, signedIn, money } from "./state.ts";

export function renderCommands() {
  const c = state.config;
  if (!c) return;
  $("#cmd-timeout").textContent = seconds(c.challengeTimeoutMs);
  $("#cmd-rematch").textContent = seconds(c.rematchDelayMs);
  const pts = c.checkinPoints ?? 1,
    win = c.winDollars ?? 5,
    loss = c.lossDollars ?? 3;
  $("#cmd-checkin").textContent = pts ? "+" + pts + (pts === 1 ? " upgrade point" : " upgrade points") : "A check-in";
  $("#cmd-dollars").textContent =
    win || loss ? money(win) + " for a win and " + money(loss) + " for a loss" : "nothing on this channel right now";
  $("#cmd-give").textContent =
    c.giveEnabled === false
      ? "Giving dollars is off on this channel."
      : "Gives dollars to another fighter while the stream is live: " +
        `up to ${money(c.giveMaxPerStream ?? 100)} per stream, after your first ${c.giveMinDuels ?? 5} duels.`;
  $("#lb-note").textContent = "Ranked duels need a saved profile. Everyone starts at " + c.initialElo + " Elo.";
  $("#hp-mode-note").hidden = c.quickDuel !== false;
}

export async function loadLeaderboard() {
  const r = parseAnswer(await api("/api/leaderboard/" + CHANNEL), parseLeaderboard, "the leaderboard");
  const tbody = $("#leaderboard tbody");
  if (!r.ok) {
    const why =
      r.status === 403 && r.data?.off
        ? "No ranks yet: PixFray isn't on for " + CHANNEL + "."
        : "Couldn't load the leaderboard: " + errorText(r);
    return tbody.replaceChildren(emptyRow(6, why));
  }
  state.leaderboard = r.data;
  const me = state.session?.user?.id,
    rows = state.leaderboard;
  // The top three stand on plinths as voxels, like the 3D preview; with no rows, three open steps show what to take.
  const box = $("#podium");
  box.hidden = false;
  box.replaceChildren(
    ...[0, 1, 2].map((i) => {
      const p = rows[i];
      return h(
        "li",
        { class: [p ? "" : "open", i === 0 ? "first" : ""].filter(Boolean).join(" ") || null },
        p ? thumb(entryOf(p.avatar), 48) : h("span", { class: "slot", "aria-hidden": "true" }),
        h(
          "span",
          { class: "plinth" },
          h("span", { class: "place" }, i + 1),
          h("strong", {}, p ? p.displayName || p.username : "Open"),
          h(
            "span",
            { class: "muted" },
            p ? p.elo + " Elo · " + p.wins + "–" + p.losses : "Win a ranked duel to take it",
          ),
        ),
      );
    }),
  );
  if (!rows.length) {
    const cell = h(
      "td",
      { colspan: 6 },
      h("strong", {}, "No ranked duels yet, so the top spot is open."),
      " To get on the board: ",
      signedIn() ? "save your fighter in the Fighter tab" : "sign in and save your fighter in the Fighter tab",
      ", then type ",
      h("code", {}, "!challenge @viewer"),
      " in chat while the stream is live.",
    );
    return tbody.replaceChildren(h("tr", { class: "empty" }, cell));
  }
  // a still thumbnail; it never animates in the table
  const character = (id: string) => {
    const entry = entryOf(id);
    return h(
      "span",
      { class: "lb-char", title: entry?.label || id },
      entry ? thumb(entry, 32) : null,
      h("span", {}, entry?.label || id),
    );
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
      h("td", { class: "col-char" }, character(p.avatar)),
      h("td", { class: "num" }, p.elo),
      h("td", { class: "num" }, p.wins),
      h("td", { class: "num" }, p.losses),
    );
  const top = rows.slice(0, 10).map(row);
  const mine = rows.findIndex((p) => p.userId === me);
  if (mine >= 10) top.push(row(rows[mine]!, mine)); // !: findIndex found this row
  tbody.replaceChildren(...top);
}
