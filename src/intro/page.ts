// PixFray intro page chrome without the 3D: shared helpers, the loader, the example ladder, the sound toggle and the
// scroll-to-chapter mapping. It also runs alone when WebGL2 is missing.
import { createSound } from "./sound.ts";

export const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T; // element type from the page HTML
export const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
export const small = matchMedia("(max-width: 760px)").matches;
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const ease = (t: number) => t * t * (3 - 2 * t);
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const range = (x: number, a: number, b: number) => clamp01((x - a) / (b - a));
// the regex matches only the four keys
export const esc = (s: unknown) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c as "&" | "<" | ">" | '"'],
  );
if (reduced) document.body.classList.add("no-motion");

for (const h of document.querySelectorAll("[data-type]")) {
  const text = h.textContent.trim();
  h.setAttribute("aria-label", text);
  h.innerHTML = text
    .split(" ")
    .map((w, i) => `<span class="w" aria-hidden="true" style="--i:${i}">${esc(w)}</span>`)
    .join(" ");
}

export const loader = $("#loader"),
  grid = $("#loader .loader-grid"),
  pct = $("#loader-pct");
const cells = Array.from({ length: 100 }, () => grid.appendChild(document.createElement("i")));
const order = cells.map((_, i) => i).sort((a, b) => Math.sin(a * 91.7) - Math.sin(b * 91.7));
let shown = 0;
export function setProgress(f: number) {
  const n = Math.round(clamp01(f) * 100);
  // in range: shown < n <= 100, the length of cells and order
  for (; shown < n; shown++) cells[order[shown]!]!.className = "on";
  cells.forEach((c) => c.classList.remove("hot"));
  if (shown > 0 && shown < 100) cells[order[shown - 1]!]!.classList.add("hot"); // in range: 0 < shown < 100
  pct.textContent = n + "%";
}
export function finishLoading(lifted = () => {}) {
  setProgress(1);
  setTimeout(
    () => {
      lifted();
      loader.classList.add("is-done");
      document.body.classList.remove("is-loading");
    },
    reduced ? 0 : 350,
  );
}

// Made-up fighters, so the page never shows a real channel's players.
const EXAMPLE_LADDER = [
  { username: "emberfox", avatar: "adventurer", color: "#ff8a3d", elo: 1086, wins: 14, losses: 5 },
  { username: "tinyrook", avatar: "pixel-bot", color: "#6cc4ff", elo: 1052, wins: 11, losses: 6 },
  { username: "dusk_rider", avatar: "cowgirl", color: "#e0b04a", elo: 1031, wins: 9, losses: 7 },
  { username: "bitbunny", avatar: "bunny-brown", color: "#f07aa8", elo: 1008, wins: 7, losses: 7 },
  { username: "voxelvale", avatar: "cute-girl", color: "#8fd47a", elo: 994, wins: 5, losses: 8 },
];
export function loadBoard() {
  $("#board").innerHTML = EXAMPLE_LADDER.map(
    (x) => `<li><span>${esc(x.username)}<span class="rec">${x.wins}–${x.losses}</span></span><b>${x.elo}</b></li>`,
  ).join("");
  $("#board-source").innerHTML = "Example ladder: Elo with wins–losses.";
  return Promise.resolve(EXAMPLE_LADDER);
}

export const sound = createSound();
const soundBtn = $("#sound");
export function setSound(on: boolean) {
  sound.setOn(on);
  soundBtn.setAttribute("aria-pressed", String(on));
  $("#sound .sound-label").textContent = on ? "Sound on" : "Sound off";
  try {
    localStorage.setItem("pixfray-intro-sound", on ? "1" : "0");
  } catch {
    /* private mode */
  }
}
soundBtn.addEventListener("click", () => setSound(!sound.on));

export const sections = [...document.querySelectorAll<HTMLElement>(".chapter")];
const railLinks = [...document.querySelectorAll<HTMLAnchorElement>("#rail li > a")];
let bounds: { top: number; h: number }[] = [];
export function measure() {
  bounds = sections.map((s) => ({ top: s.offsetTop, h: s.offsetHeight }));
}
export function scrollC() {
  const y = scrollY + innerHeight * 0.5;
  if (scrollY <= 2) return 0;
  for (const [i, b] of bounds.entries()) {
    if (y < b.top + b.h) return Math.max(0, Math.min(5, i + (y - b.top) / b.h - 0.5));
  }
  return 5;
}
let activeChapter = -1,
  activeCopy = -1;
// a chapter's scene is framed when the middle of its section is mid-screen; a plain #link would stop at the section's top,
// a fifth of a chapter short. The camera eases there on its own, so the page itself jumps.
export function centerChapter(sec: HTMLElement) {
  const b = bounds[sections.indexOf(sec)];
  if (b) scrollTo({ top: sec === sections[0] ? 0 : b.top + b.h / 2 - innerHeight / 2, behavior: "instant" });
}
for (const a of railLinks)
  a.addEventListener("click", (e) => {
    const sec = document.querySelector<HTMLElement>(a.hash);
    if (!sec || document.body.classList.contains("no-motion")) return;
    e.preventDefault();
    history.pushState(null, "", a.hash);
    centerChapter(sec);
  });
addEventListener("scroll", () => document.body.classList.toggle("scrolled", scrollY > 40), { passive: true });
// Back and Forward between chapters: the browser scrolls to the section's top, so centre it again once it has
addEventListener("popstate", () => {
  const sec = sections.find((s) => location.hash === "#" + s.id);
  if (sec && !document.body.classList.contains("no-motion")) requestAnimationFrame(() => centerChapter(sec));
});
// the copy is fixed in place while its chapter is on, so a keyboard user tabbing into another chapter's link scrolls that chapter in
document.addEventListener("focusin", (e) => {
  // the target is an element, or the document, which has no closest(); chapters are HTML elements
  const sec = (e.target as { closest?: (selector: string) => HTMLElement | null }).closest?.(".chapter");
  if (sec && !sec.classList.contains("is-on") && !document.body.classList.contains("no-motion")) centerChapter(sec);
});
// the rail follows the nearest chapter; the copy shows only near a chapter's centre, so text never sits on a scene change
export function setChapter(c: number) {
  const i = Math.round(c),
    copy = reduced || Math.abs(c - i) < (innerWidth < innerHeight ? 0.4 : 0.45) ? i : -1; // phones: the copy sits under the scene, so it can stay on longer
  if (copy !== activeCopy) {
    activeCopy = copy;
    sections.forEach((s, k) => s.classList.toggle("is-on", k === copy));
  }
  if (i === activeChapter) return;
  activeChapter = i;
  railLinks.forEach((a, k) => {
    a.parentElement?.classList.toggle("is-on", k === i);
    a.toggleAttribute("aria-current", k === i);
  });
  if (i > 0) sound.chapter(i);
}
