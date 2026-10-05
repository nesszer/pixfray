// /start: a streamer's invite link (/start/?invite=<token>). Shows who the invite is for and the Twitch sign-in that
// turns their channel on. The server sends people back here with ?error=<reason> when signup doesn't finish.
import { api, h, $ } from "./ui.js";
import { scrub, skyBackdrop } from "./scrub.js";

const params = new URLSearchParams(location.search);
const token = params.get("invite") || "";
const error = params.get("error") || "";

// The overlay lays fighters out in the pixels it gets. Narrow stages render it at least 640px wide (in the stage's own
// shape: 16:9 wide, 4:5 on phones) and scale it down, so the nameplates keep their room and stay readable.
const stage = $(".stage"), frame = stage.querySelector("iframe");
function fitStage() {
  const w = stage.clientWidth, hgt = stage.clientHeight, v = Math.max(w, 640);
  Object.assign(frame.style, { width: v + "px", height: Math.round(v * hgt / w) + "px", transform: "scale(" + w / v + ")", transformOrigin: "0 0" });
}
new ResizeObserver(fitStage).observe(stage);
fitStage();
// the demo only draws while it's on screen
new IntersectionObserver(([en]) => frame.contentWindow?.postMessage({ demoPaused: !en.isIntersecting }, location.origin)).observe(stage);
frame.addEventListener("load", () => { const r = stage.getBoundingClientRect(); frame.contentWindow?.postMessage({ demoPaused: r.bottom < 0 || r.top > innerHeight }, location.origin); });

const PROBLEMS = {
  invalid: () => "This invite link isn't valid. Check that you copied the whole link, or ask nesszerra for a new one.",
  expired: () => "This invite has expired. Invites work for 7 days; ask nesszerra for a new one.",
  used: (login) => "This invite was already used. If you set up PixFray with it, sign in to your mod controls instead.",
  wrong_account: (login) => "You signed in to Twitch with a different account. This invite is for " + login + ". Log out of twitch.tv, then sign in again as " + login + ".",
  full: () => "PixFray is full right now. Ask nesszerra for a spot.",
  denied: () => "You cancelled the Twitch permission. You can set up without it: only you can open your mod controls until you connect it from the Stream setup page.",
  failed: () => "Twitch sign-in didn't finish. Try again.",
};

function show(title, text, actions = [], problem = "") {
  // hyphenated words ("invite-only") stay on one line
  $("#invite-title").replaceChildren(...title.split(/(\S+-\S+)/).map((part, i) => i % 2 ? h("span", { class: "nowrap" }, part) : part));
  $("#invite-text").textContent = text;
  $("#invite-actions").replaceChildren(...actions);
  // the closing band repeats the card's main link as a plain button, so the page ends on the next step with one primary action
  $("#ready-actions").replaceChildren(...actions.filter((n) => n.matches("a.btn-primary")).map((n) => n.cloneNode(true)));
  $("#ready").hidden = !$("#ready-actions").children.length;
  const box = $("#invite-problem");
  box.textContent = problem;
  box.hidden = !problem;
  box.className = "callout small" + (problem ? " warning" : "");
}
const signIn = (login, mods = true) => h("a", { class: mods ? "btn btn-primary" : "btn", href: "/auth/login?" + new URLSearchParams({ invite: token, ...(mods ? {} : { mods: "0" }) }) }, mods ? "Sign in with Twitch as " + login : "Set up without mod access");

async function init() {
  if (!token) {
    show("PixFray is invite-only right now", "Ask nesszerra, who runs PixFray, for an invite link. It names your Twitch account and works for 7 days; open it here to sign in.",
      [h("a", { class: "btn btn-primary", href: "https://www.twitch.tv/nesszerra", rel: "noopener" }, "Ask for an invite on Twitch"), h("a", { class: "text-link", href: "/intro/" }, "See how a duel plays out")]);
    return;
  }
  const r = await api("/api/invite/" + encodeURIComponent(token));
  if (!r.ok || !r.data?.status) {
    show("Couldn't check your invite", "", [h("button", { class: "btn", type: "button", onclick: init }, "Try again")], "The server didn't answer. Try again in a moment.");
    return;
  }
  const { status, login = "" } = r.data;
  if (status === "used") {
    show("This invite was already used", "", [h("a", { class: "btn btn-primary", href: "/auth/login?" + new URLSearchParams({ channel: login, next: "/admin/" }) }, "Sign in to " + login + "'s mod controls")], PROBLEMS.used(login));
    return;
  }
  if (status !== "valid") { show("This invite doesn't work", "", [], PROBLEMS[status]?.(login) || PROBLEMS.invalid()); return; }
  const problem = PROBLEMS[error]?.(login) || "";
  show("Set up PixFray for " + login,
    "Sign in with the Twitch account " + login + ". Twitch asks you to allow reading your moderator list; then the Stream setup page opens.",
    error === "denied" ? [signIn(login), signIn(login, false)] : [signIn(login)], problem);
  if (error) history.replaceState(null, "", location.pathname + "?invite=" + encodeURIComponent(token));
}
init();

// The setup steps scroll past a scene that shows each one: the overlay framed as an OBS source, a bot reply in chat,
// !challenge and !fight starting a duel, then the ranking pillars. The middle of the window picks the step.
const steps = [...document.querySelectorAll(".story .step-grid > li")], cap = $("#story-cap");
const CAPS = ["The overlay is one browser source, drawn over your game.", "With the Duel module off, PixFray's bot is the only one that answers.",
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
