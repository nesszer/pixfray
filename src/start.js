// /start: what PixFray is, the Twitch sign-in that turns it on for a streamer's channel, and the setup steps.
import { h, $ } from "./ui.js";
import { scrub, skyBackdrop } from "./scrub.js";
import site from "../site.config.js";

const params = new URLSearchParams(location.search);
// Sites with a PixFray chat bot (site.config.js bot) set chat up with it; the others keep the StreamElements steps.
const BOT = Boolean(site.bot?.[location.origin === site.origins.test ? "test" : "production"]);
for (const n of document.querySelectorAll("[data-chat]")) if (n.dataset.chat === (BOT ? "bot" : "se")) n.hidden = false; else n.remove();
const error = params.get("error") || "";

// The overlay lays fighters out in the pixels it gets. Narrow stages render it at least 640px wide (in the stage's own
// shape: 16:9 wide, 4:5 on phones) and scale it down, so the nameplates keep their room and stay readable.
const stage = $(".stage"), frame = stage.querySelector("iframe");
// the demo loads once the stage comes near the screen, capped at 6 fighters so it stays light on phones
const demoSrc = "/overlay.html?" + new URLSearchParams({ channel: site.defaultChannel, arena: "1", demo: "1", size: "64", cap: "6" });
function fitStage() {
  const w = stage.clientWidth, hgt = stage.clientHeight, v = Math.max(w, 640);
  Object.assign(frame.style, { width: v + "px", height: Math.round(v * hgt / w) + "px", transform: "scale(" + w / v + ")", transformOrigin: "0 0" });
}
new ResizeObserver(fitStage).observe(stage);
fitStage();
// the demo only draws while it's on screen
new IntersectionObserver(([en]) => {
  if (en.isIntersecting && !frame.src) frame.src = demoSrc;
  frame.contentWindow?.postMessage({ demoPaused: !en.isIntersecting }, location.origin);
}, { rootMargin: "200px 0px" }).observe(stage);
frame.addEventListener("load", () => { const r = stage.getBoundingClientRect(); frame.contentWindow?.postMessage({ demoPaused: r.bottom < 0 || r.top > innerHeight }, location.origin); });

const PROBLEMS = {
  full: "PixFray is full right now. Try again in a few days, or run your own copy from the code on GitHub.",
  denied: BOT ? "You cancelled the Twitch permissions. You can set up without them and allow them later from the Stream setup page. Until then only you can open your mod controls, and the bot stays out of your chat."
    : "You cancelled the Twitch permission. You can set up without it: only you can open your mod controls until you connect it from the Stream setup page.",
  failed: "Twitch sign-in didn't finish. Try again.",
  review: "Your channel is waiting for the site owner's approval. PixFray turns on at once for Twitch accounts at least 30 days old that have streamed before (a saved past broadcast, or Affiliate or Partner). Sign in here again later to check.",
  taken: "This channel name was set up by a different Twitch account (an earlier owner of the name). Open an issue on GitHub and the site owner can move it to you.",
};

function show(title, text, actions = [], problem = "") {
  $("#signup-title").textContent = title;
  $("#signup-text").textContent = text;
  $("#signup-actions").replaceChildren(...actions);
  // the closing band repeats the card's main link as a plain button, so the page ends on the next step with one primary action
  $("#ready-actions").replaceChildren(...actions.filter((n) => n.matches("a.btn-primary")).map((n) => n.cloneNode(true)));
  $("#ready").hidden = !$("#ready-actions").children.length;
  const box = $("#signup-problem");
  box.textContent = problem;
  box.hidden = !problem;
  box.className = "callout small" + (problem ? " warning" : "");
}
const signIn = (mods = true) => h("a", { class: mods ? "btn btn-primary" : "btn", href: "/auth/login?" + new URLSearchParams({ signup: "1", ...(mods ? {} : { mods: "0" }) }) }, mods ? "Sign in with Twitch" : BOT ? "Set up without these permissions" : "Set up without mod access");

// Anyone can sign up: the Twitch account that signs in gets PixFray on its own channel. The server sends people back
// here with ?error=<reason> when sign-up doesn't finish.
function init() {
  show("Sign in with the Twitch account you stream on",
    "PixFray turns on for that channel, then the Stream setup page opens. Twitch asks you to allow reading your moderator list" + (BOT ? " and the PixFray bot in your chat." : "."),
    error === "denied" ? [signIn(), signIn(false)] : [signIn()], PROBLEMS[error] || "");
  if (error) history.replaceState(null, "", location.pathname);
}
init();

// The setup steps scroll past a scene that shows each one: the overlay framed as an OBS source, a bot reply in chat,
// !challenge and !fight starting a duel, then the ranking pillars. The middle of the window picks the step.
const steps = [...document.querySelectorAll(".story .step-grid > li")], cap = $("#story-cap");
const CAPS = ["The overlay is one browser source, drawn over your game.", BOT ? "The PixFray bot answers duel commands in your chat." : "With the Duel module off, PixFray's bot is the only one that answers.",
  "!challenge and !fight start the duel on stream.", "Every win climbs the ranks your mods look after."];
const KEYS = [2, 7, 12, 17].map((f) => f / 19);   // 20 frames, 5 per step; each step settles on its middle frame
let active = -1;
const narrow = matchMedia("(max-width: 960px)");
function storyAt() {
  // phones pin the scene as a strip along the top, so the step that counts is the one mid-way down the rest of the screen
  const top = narrow.matches ? Math.max(0, $(".story-stage").getBoundingClientRect().bottom) : 0;
  const mid = (top + innerHeight) * 0.5, c = steps.map((li) => { const r = li.getBoundingClientRect(); return r.top + r.height / 2; });
  const n = c.length - 1, gap = (c[n] - c[0]) / n;
  let s = mid < c[0] ? (mid - c[0]) / gap : mid >= c[n] ? n + (mid - c[n]) / gap : 0;
  for (let i = 0; i < n; i++) if (mid >= c[i] && mid < c[i + 1]) { s = i + (mid - c[i]) / (c[i + 1] - c[i]); break; }
  s = Math.max(-1, Math.min(n + 1, s));
  const k = Math.max(0, Math.min(n, Math.round(s)));
  if (k !== active) { active = k; steps.forEach((li, i) => li.classList.toggle("is-active", i === k)); cap.textContent = CAPS[k]; }
  // each step's scene drifts through its own 5 frames; the cut to the next scene is a short dissolve half-way between steps
  const i = Math.floor(s), t = s - i, f = 5 * i + 2;
  const frame = s < 0 ? 2 + 2 * s : s >= n ? 5 * n + 2 + 2 * (s - n) : t < 0.4 ? f + 5 * t : t < 0.6 ? f + 2 + (t - 0.4) / 0.2 : f + 3 + 5 * (t - 0.6);
  return Math.max(0, Math.min(19, frame)) / 19;
}
skyBackdrop();
if (steps.length === 4) {
  document.documentElement.classList.add("has-story");
  scrub($("#story-scene"), { frames: Array.from({ length: 20 }, (_, i) => "/assets/scene/seq/start-" + String(i).padStart(2, "0") + ".webp"), progress: storyAt, keys: KEYS });
}
