// Mod controls ("/admin/"): broadcaster and moderators only (GET /api/access/:channel -> canManage).
// Uses GET/POST /api/admin/:channel (docs/CONTRACTS.md section 2) and the read-only live socket for updates.
// Each tab lives in src/admin/; this entry checks access, then loads and draws them in page order.
import { api, h, $, setStatus, renderWho, signOut, CHANNEL, withChannel, loginHref, applyChannel } from "./ui.ts";
import { skyBackdrop } from "./scrub.ts";
import site from "../site.config.js";
import { parseAccess, parseAnswer, parseSession } from "./parse.ts";
import { S, BARE, RENDER, gate, load, loadLeaderboard, connectLive } from "./admin/state.ts";
import { renderSummary, renderDuels, renderPlayers, renderRanks } from "./admin/arena.ts";
import { renderConfig, renderHistory } from "./admin/rules.ts";
import { renderUsage, loadCustom, loadPets, loadSprites, mountUploads } from "./admin/characters.ts";
import { renderChat, renderSe, renderChecklist, renderCheckinTest, chatAct } from "./admin/stream.ts";
import { renderBotCommands, renderPoints, renderPower } from "./admin/channel.ts";

RENDER.all = [
  renderSummary,
  renderDuels,
  renderPlayers,
  renderRanks,
  renderConfig,
  renderHistory,
  renderUsage,
  renderChat,
  renderSe,
  renderChecklist,
  renderCheckinTest,
  renderBotCommands,
  renderPoints,
  renderPower,
];
RENDER.ranks = [renderRanks, renderHistory];

skyBackdrop();
applyChannel();
const title = (h1: string | null, subtitle: string) => {
  if (h1) $(".page-header h1").textContent = h1;
  $(".page-header .subtitle").textContent = subtitle;
};
if (CHANNEL !== site.defaultChannel)
  title(null, "For the " + CHANNEL + " broadcaster. Changes reach every OBS overlay right away.");
if (BARE)
  title("PixFray mod controls", "For streamers and their moderators. Changes reach every OBS overlay right away.");
const startLink = (primary?: boolean) =>
  h("a", { class: primary ? "btn btn-primary" : "btn", href: "/start/" }, "Set up PixFray for your channel");
const signIn = () => h("a", { class: "btn btn-primary", href: loginHref(), "data-login": "" }, "Sign in with Twitch");
const retry = (text: string) =>
  gate(text, [
    h("button", { class: "btn btn-primary", type: "button", onclick: () => location.reload() }, "Try again"),
  ]);

// Why the access check said no (server/auth.ts access), in words for the person at the gate.
const GATE_REASONS: Record<string, (() => string) | undefined> = {
  "Sign in with Twitch": () => "You're not signed in.",
  "Current Twitch moderator role required": () => "Your Twitch account isn't a moderator of " + CHANNEL + ".",
  "Broadcaster must connect moderator authorization": () =>
    CHANNEL +
    " hasn't connected mod access yet, so moderators can't sign in until they do it on their Stream setup page.",
};
// Back from a Twitch permission: "Connect mod access" (?mods=) or "Allow channel point rewards" (?points=).
const RETURNS: Record<string, { status: string; texts: Record<string, string | undefined> }> = {
  mods: {
    status: "#check-status",
    texts: {
      connected: "Mod access is connected. Your Twitch moderators can sign in to this page now.",
      denied: "The Twitch permission was cancelled, so mod access isn't connected.",
      wrong_account: "Mod access has to be connected while signed in to Twitch as " + CHANNEL + ".",
    },
  },
  points: {
    status: "#points-status",
    texts: {
      connected: "Channel point rewards are allowed. Add a reward below.",
      denied: "The Twitch permission was cancelled, so PixFray can't make channel point rewards.",
    },
  },
};
const dropParam = (name: string) => {
  const url = new URL(location.href);
  url.searchParams.delete(name);
  history.replaceState(null, "", url.pathname + url.search + url.hash);
};

async function init() {
  // a slow or rate-limited check shouldn't leave the gate blank: offer sign-in while it finishes
  const slow = setTimeout(
    () => gate("Still checking your access. If you aren't signed in yet, sign in with Twitch.", [signIn()]),
    1500,
  );
  const session = parseAnswer(await api("/api/session"), parseSession, "the session");
  clearTimeout(slow);
  S.session = session.ok ? session.data : null;
  renderWho($("#who"), S.session, signOut);
  if (!S.session) return retry("We can't check sign-in right now. Try again in a minute.");
  if (!S.session.user) {
    if (S.session.configured === false)
      return gate("Twitch sign-in isn't set up on this server yet, so mod controls are unavailable.");
    $("#who").replaceChildren(); // one sign-in button: the gate's
    // a word joiner keeps "?channel=" on one line on phones
    if (BARE)
      return gate(
        "Sign in with Twitch to open mod controls. Streamers land on their own channel. Moderators: open the mod link your streamer shares; it ends in ?\u2060channel= and their name.",
        [signIn(), startLink()],
      );
    return gate(
      CHANNEL === site.defaultChannel
        ? "Sign in with the " +
            site.owner.login +
            " account or a " +
            site.owner.login +
            " moderator account to open mod controls."
        : "Sign in with the " + CHANNEL + " Twitch account to open mod controls.",
      [signIn()],
    );
  }
  // A signed-in streamer never sees the bare page: the Worker sends them to their own channel's controls (worker.ts ownAdmin).
  const login = S.session.user.login;
  const access = parseAnswer(await api("/api/access/" + CHANNEL), parseAccess, "the access check");
  S.access = access.ok ? access.data : null;
  if (!S.access?.canManage && BARE)
    return gate(
      "PixFray isn't on for " +
        login +
        " yet. Set it up on /start. Moderators: open the mod link your streamer shares.",
      [startLink(true), h("a", { class: "btn", href: "/play/" }, "Pick a channel")],
    );
  if (access.data?.off === "not_enabled")
    return gate(
      "PixFray isn't set up on " + CHANNEL + " yet. The " + CHANNEL + " account can turn it on in about 10 minutes.",
      [
        h("a", { class: "btn btn-primary", href: "/start/" }, "Set up PixFray"),
        h("a", { class: "btn", href: "/play/" }, "Pick a channel"),
      ],
    );
  if (!S.access?.canManage) {
    const why = !access.ok
      ? "Twitch couldn't confirm moderators right now. Try again in a minute."
      : // a missing reason looks up "undefined", which isn't a key, as before
        GATE_REASONS[S.access?.reason as string]?.() || "";
    return gate(
      (CHANNEL === site.defaultChannel
        ? "Only " + site.owner.login + " and current channel moderators can use mod controls"
        : "Only the " + CHANNEL + " account can use mod controls for " + CHANNEL) +
        "." +
        (why ? " " + why : ""),
      [h("a", { class: "btn", href: withChannel("/") }, "Back to your fighter")],
    );
  }
  if (BARE)
    title(
      "Duel controls for " + CHANNEL,
      "For the broadcaster and moderators. Changes reach every OBS overlay right away.",
    );
  $("#gate").hidden = true;
  $("#app").hidden = false;
  $("#dev-link").hidden = $("#dev-section").hidden = !S.access.owner;
  $("#owner-chat").hidden = !S.access.owner || CHANNEL !== site.defaultChannel;
  const [loaded] = await Promise.all([load(), loadLeaderboard(), loadCustom(), loadPets(), loadSprites()]);
  // every control reads S.admin, so without the arena the gate stays up (load already gated a 401 or 403)
  if (!S.admin)
    return loaded === false ? retry("Couldn't load the arena right now. Try again in a minute.") : undefined;
  if (S.admin.channelState !== "paused") connectLive();
  const params = new URLSearchParams(location.search);
  for (const [name, { status, texts }] of Object.entries(RETURNS)) {
    const value = params.get(name),
      // without the parameter this looks up "null", which isn't a key
      text = texts[value as string];
    if (!text) continue;
    setStatus($(status), text, value === "connected" ? "ok" : "error");
    dropParam(name);
  }
  // Back from "Add the PixFray bot" (/auth/login?connect=bot) or sign-up with channel:bot: connect chat through the bot now.
  if (params.get("bot") === "allowed") {
    dropParam("bot");
    const c = S.admin.chatStatus || {};
    if (S.admin.chatBot?.login && !(c.connected && c.source === "twitch"))
      await chatAct("connectChat", $<HTMLButtonElement>("#connect-chat"), false, $("#bot-status"));
  }
  mountUploads();
}
init();
