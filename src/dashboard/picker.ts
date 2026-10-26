// /play/ (no ?channel=) asks which stream the viewer watches, so nobody saves a fighter on the wrong channel.
import { api, button, h, $, renderWho, signOut, composeLook, whenImage } from "../ui.ts";
import { parseAnswer, parseSession } from "../parse.ts";
import { CHARACTER_GROUPS } from "../character-groups.ts";
import site from "../../site.config.js";
import type { Fighter3D } from "../fighter3d.ts";
import { thumb } from "./state.ts";
import type { CatalogEntry } from "./state.ts";

/** A channel's top fighter on the /play/ picker (server/worker.ts PickerData). */
type TopRow = { username: string; displayName?: string; elo: number; avatar: string };
type PickerChannel = { login: string; top: TopRow[]; catalog?: CatalogEntry[] };

export async function pickChannel() {
  document.title = "PixFray: pick your stream";
  for (const a of document.querySelectorAll(".topbar .nav-cta, .topbar .brand"))
    a.setAttribute("href", a.classList.contains("brand") ? "/" : "/play/");
  for (const el of [$<HTMLElement | null>("#fighter"), $<HTMLElement | null>("body > .page")]) if (el) el.hidden = true;
  $("#pick").hidden = false;
  const [session, list] = await Promise.all([
    api("/api/session").then((r) => parseAnswer(r, parseSession, "the session")),
    api("/api/picker"),
  ]);
  // Signing in happens on a channel's page, so the picker shows only who is already signed in.
  if (session.ok && session.data.user) renderWho($<HTMLDivElement>("#who"), session.data, signOut);
  else $("#who").replaceChildren();
  // one request brings every channel's top fighters and the looks they wear (server/worker.ts picker())
  const picked: PickerChannel[] =
    list.ok && Array.isArray(list.data?.channels)
      ? list.data.channels
      : site.builtinChannels.map((login) => ({ login, top: [] }));
  const builtin: CatalogEntry[] = list.ok && Array.isArray(list.data?.catalog) ? list.data.catalog : [];
  const rows = picked.map(({ login: c, top, catalog = [] }) => {
    const crew = h("span", { class: "channel-crew", "aria-hidden": "true" }),
      meta = h("span", { class: "channel-meta" });
    const link = h(
      "a",
      { class: "channel", href: "/?channel=" + encodeURIComponent(c) },
      crew,
      h("span", { class: "channel-text" }, h("span", { class: "channel-name" }, c), meta),
      h("span", { class: "channel-go" }, "Fight in " + c),
    );
    const byId = new Map([...builtin, ...catalog].map((e): [string, CatalogEntry] => [e.id, e]));
    channelRanks(c, link, crew, meta, top, byId);
    return h("li", { "data-login": c }, link);
  });
  $("#channel-list").replaceChildren(...rows);
  const input = $<HTMLInputElement>("#channel-q"),
    status = $("#channel-status"),
    full = list.ok && list.data?.full === true;
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/^@/, "")
      .replace(/^(https?:\/\/)?(www\.)?twitch\.tv\//, "")
      .replace(/[/?#].*$/, "");
  const filter = () => {
    const q = norm(input.value);
    let shown = 0;
    for (const li of rows) {
      const hit = q ? (li.dataset.login || "").includes(q) : shown < SHOWN;
      li.hidden = !hit;
      shown += hit ? 1 : 0;
    }
    if (!q)
      status.replaceChildren(
        rows.length > SHOWN ? "Type a name to find the other " + (rows.length - SHOWN) + " channels." : "",
      );
    else if (shown) status.replaceChildren();
    else
      status.replaceChildren(
        ...(/^[a-z0-9_]{3,25}$/.test(q) ? notHere(q, full) : ["No channel with PixFray matches that name."]),
      );
  };
  input.addEventListener("input", filter);
  filter();
  // Enter opens the exact match, or the only one left.
  $("#channel-search").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = norm(input.value),
      visible = rows.filter((li) => !li.hidden);
    const go = visible.find((li) => li.dataset.login === q) || (visible.length === 1 ? visible[0] : null);
    if (go) location.href = go.querySelector("a")!.href; // !: every row pickChannel builds holds its link
  });
  if (navigator.connection?.saveData || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  import("../fighter3d.ts")
    .then(({ createFighter3D }) => {
      const canvas = h("canvas", { class: "landing-3d", "aria-hidden": "true" });
      $("#pick").prepend(canvas);
      try {
        landing.arena = createFighter3D(canvas, { zoom: 0.8 });
      } catch {
        canvas.remove();
        return;
      }
      const cap = h("p", { class: "landing-who", "aria-hidden": "true" });
      canvas.after(cap);
      $("#pick").classList.add("is-live");
      // the caption and the marked row name the island's fighter, so the scene and the list read as one
      landing.show = (entry: CatalogEntry, link = landing.links.get(entry)) => {
        cap.textContent = landing.labels.get(entry) || "";
        for (const a of landing.links.values()) a.classList.toggle("is-shown", a === link);
        const look = composeLook(entry);
        // arena! and show!: both are set above before show can run
        if (look) landing.arena!.set(look);
        else whenImage(entry.url, () => landing.show!(entry)); // show!: set just above
      };
      // fallback!: the check above found first or fallback
      if (landing.first || landing.fallback) landing.show(landing.first || landing.fallback!);
    })
    .catch(() => {});
}
// The search finds only channels with PixFray on; SHOWN rows show before typing, the rest are a search away.
const SHOWN = 8;
// A name not on this site gets this site's /start/ link (a fork invites to its own), or, when full, a run-your-own
// link. Other copies can't be seen from here, so the note says a streamer may already have one.
function notHere(q: string, full: boolean) {
  const host = location.host,
    lead = h("strong", {}, q + " isn't on " + host + " yet.");
  const note = h(
    "span",
    { class: "invite-note" },
    "Streamers who run their own copy of PixFray have it on their own site.",
  );
  if (full)
    return [
      lead,
      " This site is full right now; they can ",
      h("a", { href: "/start/#source" }, "run their own copy"),
      ".",
      note,
    ];
  const link = location.origin + "/start/";
  const copy = button("Copy invite link", async (b) => {
    try {
      await navigator.clipboard.writeText(link);
      b.textContent = "Copied";
    } catch {
      b.textContent = "Copy the link by hand";
    }
  });
  return [lead, " Send them this link to set it up: ", h("a", { href: "/start/" }, host + "/start"), " ", copy, note];
}
// The picker's island is the intro's live arena (a banner on phones); a row's hover or focus brings its fighter on.
const landing: {
  arena: Fighter3D | null;
  show: ((entry: CatalogEntry, link?: HTMLAnchorElement) => void) | null;
  first: CatalogEntry | null;
  fallback: CatalogEntry | null;
  labels: Map<CatalogEntry, string>;
  links: Map<CatalogEntry, HTMLAnchorElement>;
} = { arena: null, show: null, first: null, fallback: null, labels: new Map(), links: new Map() };
// A row shows its top three fighters, walking while hovered or focused; the island's fighter follows the row.
function channelRanks(
  channel: string,
  link: HTMLAnchorElement,
  crew: HTMLSpanElement,
  meta: HTMLSpanElement,
  rows: TopRow[],
  byId: Map<string, CatalogEntry>,
) {
  let lit = false;
  const hover = (fn: () => void, events = ["pointerenter", "focus"]) => {
    for (const ev of events) link.addEventListener(ev, fn);
  };
  hover(() => (lit = true));
  hover(() => (lit = false), ["pointerleave", "blur"]);
  const add = (entry: CatalogEntry, open = "") =>
    crew.append(thumb(entry, 48, { anim: "walk", active: () => lit }, open));
  // the fighter on the island: the first channel's sets it, and hovering a row brings that row's on
  const stand = (entry: CatalogEntry, label: string, key: "first" | "fallback") => {
    landing.labels.set(entry, label);
    landing.links.set(entry, link);
    if (!landing[key]) {
      if (!landing.first) landing.show?.(entry);
      landing[key] = entry;
    }
    hover(() => landing.show?.(entry, link));
  };
  const top = rows[0];
  if (!top) {
    meta.textContent = "No ranked duels yet. The top spot is open.";
    // the open spot: a character picked from the channel name, so each empty channel brings a different one on stage
    // as Iterable<string>: a Twitch login is ASCII, so spreading it by code point splits nothing
    const seed = [...(channel as Iterable<string>)].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);
    // [0]!: the first character group (people) is always there
    const people = new Set(CHARACTER_GROUPS[0]!.ids),
      all = [...byId.values()].filter((e) => people.has(e.id)),
      first = all[seed % Math.max(1, all.length)] || byId.values().next().value;
    if (!first) return;
    add(first, " is-open");
    return stand(first, "The open spot in " + channel + "'s chat", "fallback");
  }
  const name = top.displayName || top.username;
  meta.replaceChildren("Top fighter: " + name + " · ", h("span", { class: "nowrap" }, top.elo + " Elo"));
  const entry = byId.get(top.avatar);
  if (entry) stand(entry, name + ", top of " + channel + "'s chat", "first");
  for (const p of rows.slice(0, 3)) {
    const e = byId.get(p.avatar);
    if (e) add(e);
  }
}
