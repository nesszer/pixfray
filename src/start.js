// /start: a streamer's invite link (/start/?invite=<token>). Shows who the invite is for and the Twitch sign-in that
// turns their channel on. The server sends people back here with ?error=<reason> when signup doesn't finish.
import { api, h, $ } from "./ui.js";

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
    show("PixFray is invite-only right now", "Ask nesszerra for an invite link. It names your Twitch account and works for 7 days. Already have one? Open it, and this card shows your sign-in.",
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
