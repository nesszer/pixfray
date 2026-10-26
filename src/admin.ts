// Mod controls ("/admin/"): broadcaster and moderators only (GET /api/access/:channel -> canManage).
// Uses GET/POST /api/admin/:channel (docs/CONTRACTS.md section 2) and the read-only live socket for updates.
import {
  api,
  errorText,
  h,
  $,
  setStatus,
  renderWho,
  signOut,
  seconds,
  timeAgo,
  dateTime,
  formatBytes,
  CHANNEL,
  CHANNEL_PICKED,
  withChannel,
  loginHref,
  applyChannel,
} from "./ui.ts";
import { skyBackdrop } from "./scrub.ts";
import site from "../site.config.js";
import { parseAccess, parseAdmin, parseAdminSnapshot, parseAnswer, parseLeaderboard, parseSession } from "./parse.ts";
import type {
  Access,
  Admin,
  AdminConfig as Config,
  AdminPlayer as Player,
  BotCommands,
  BotStatus,
  ChatStatus,
  LeaderRow as Fighter,
  PointsPanel,
  Se,
  Session,
} from "./parse.ts";
import { isObject, warnOnce } from "./served/parse.ts";
// GET /api/admin/:channel (server/channel.ts "/admin", with worker.ts seView), the live snapshot, /api/session,
// /api/access and /api/leaderboard are parsed where they arrive (src/parse.ts). /api/assets, /api/pets and /api/sprites
// are read with the shapes below, and each place that keeps one of those bodies casts it once.
type CustomItem = {
  id: string;
  label?: string;
  frames?: unknown[];
  animations?: Record<string, unknown[]>;
  bytes?: number;
  createdAt: number;
};
type Pet = {
  id: string;
  label: string;
  custom?: boolean;
  url: string;
  tier: string;
  boost?: Record<string, number | undefined>;
  price: number;
};
type Sprite = {
  id: string;
  label: string;
  displayName?: string;
  username?: string;
  ai?: boolean;
  createdAt: number;
  reviewedBy?: string;
  reviewedAt?: number;
};
type NumberField = { key: string; label: string; unit: string; min: number; max: number; ms?: true; bool?: never };
type BoolField = { key: string; label: string; bool: true; hint: string; ms?: never; unit?: never };
type Field = NumberField | BoolField;
type KeyMoves = Record<string, number | undefined>;
type Label = { key?: string; label: string; unit?: string; min?: number; max?: number; ms?: true; bool?: true };
skyBackdrop();
applyChannel();
if (CHANNEL !== site.defaultChannel)
  $<HTMLParagraphElement>(".page-header .subtitle").textContent =
    "For the " + CHANNEL + " broadcaster. Changes reach every OBS overlay right away.";
// The bare /admin/ (no ?channel) is for anyone: it names no channel until sign-in shows whose controls these are.
const BARE = !CHANNEL_PICKED;
if (BARE) {
  $<HTMLHeadingElement>(".page-header h1").textContent = "PixFray mod controls";
  $<HTMLParagraphElement>(".page-header .subtitle").textContent =
    "For streamers and their moderators. Changes reach every OBS overlay right away.";
}
const named = () => {
  if (BARE) {
    $<HTMLHeadingElement>(".page-header h1").textContent = "Duel controls for " + CHANNEL;
    $<HTMLParagraphElement>(".page-header .subtitle").textContent =
      "For the broadcaster and moderators. Changes reach every OBS overlay right away.";
  }
};
const startLink = (primary?: boolean) =>
  h("a", { class: primary ? "btn btn-primary" : "btn", href: "/start/" }, "Set up PixFray for your channel");

const LIMITS = { maxCharacters: 24, maxFrames: 24, frameSize: 128, maxAtlasBytes: 1572864 };
// Editable config fields (docs/CONTRACTS.md section 7). `ms` fields are edited in seconds and sent as integer ms.
const GROUPS: { title: string; visible?: (config: Config, admin: Admin) => boolean; fields: Field[] }[] = [
  {
    title: "Health and duels",
    fields: [
      { key: "maxHp", label: "Max health", unit: "HP", min: 1, max: 1000 },
      { key: "maxDuels", label: "Duels at the same time", unit: "duels", min: 1, max: 5 },
      { key: "challengeTimeoutMs", label: "Challenge expires after", unit: "s", ms: true, min: 5000, max: 300000 },
      { key: "inactivityMs", label: "Idle duel cancelled after", unit: "s", ms: true, min: 10000, max: 600000 },
      { key: "respawnMs", label: "Respawn after knockout", unit: "s", ms: true, min: 0, max: 60000 },
      { key: "rematchDelayMs", label: "Rematch wait", unit: "s", ms: true, min: 0, max: 600000 },
      { key: "streamDelayMs", label: "Stream delay", unit: "s", ms: true, min: 0, max: 60000 },
    ],
  },
  {
    title: "Ranking",
    fields: [
      { key: "initialElo", label: "Starting Elo", unit: "Elo", min: 0, max: 10000 },
      { key: "eloK", label: "Elo K-factor", unit: "K", min: 1, max: 100 },
      {
        key: "pairRankedPerStream",
        label: "Ranked duels per pair each stream (0: no limit)",
        unit: "duels",
        min: 0,
        max: 50,
      },
    ],
  },
  // !checkin (server/channel.ts checkin) and how far upgrade levels count here (server/upgrades.ts effectiveStats).
  {
    title: "Check-ins",
    fields: [
      { key: "checkinPoints", label: "Upgrade points per check-in", unit: "points", min: 0, max: 3 },
      {
        key: "streakBonus",
        label: "Streak bonus",
        bool: true,
        hint: "+1 point at a streak of 3, 7, 14 and 30 streams, +2 at 60, +3 at 100, +5 at 200, +10 at 365",
      },
      { key: "maxStatLevel", label: "Highest stat level that counts", unit: "levels", min: 1, max: 200 },
    ],
  },
  // PixFray dollars (server/channel.ts payDuels and give). Mods gift dollars from the Players tab.
  {
    title: "Dollars",
    fields: [
      { key: "winDollars", label: "Dollars for a win", unit: "$", min: 0, max: 100 },
      { key: "lossDollars", label: "Dollars for a loss", unit: "$", min: 0, max: 100 },
      {
        key: "giveEnabled",
        label: "Viewers can give dollars",
        bool: true,
        hint: "!give @name amount (!pay with StreamElements), only while the stream is live",
      },
      { key: "giveMaxPerStream", label: "Most one viewer gives per stream", unit: "$", min: 0, max: 10000 },
      { key: "giveMinDuels", label: "Finished duels before giving", unit: "duels", min: 0, max: 1000 },
    ],
  },
  // The PixFray bot as a whole (server/channel.ts botCommand) and its timed !fray line (postReminder). Only channels the bot reads chat for.
  {
    title: "Chat bot",
    visible: (c, a) =>
      Boolean(a.chatBot) &&
      (a.chatStatus || a.chat || {}).connected === true &&
      (a.chatStatus || a.chat || {}).source !== "streamelements",
    fields: [
      {
        key: "botEnabled",
        label: "Bot answers commands",
        bool: true,
        hint: "Off: the bot ignores every command and posts nothing. The broadcaster or a mod can also type !fray off or !fray on in chat",
      },
      { key: "reminderMin", label: "!fray reminder every (0 = off)", unit: "min", min: 0, max: 240 },
    ],
  },
  // The shop (server/pets.ts): pet prices by tier, and locked hats cost this much per win they need (0 = not for sale).
  {
    title: "Shop",
    fields: [
      { key: "petPriceCommon", label: "Common pet", unit: "$", min: 1, max: 100000 },
      { key: "petPriceUncommon", label: "Uncommon pet", unit: "$", min: 1, max: 100000 },
      { key: "petPriceRare", label: "Rare pet", unit: "$", min: 1, max: 100000 },
      { key: "petPriceEpic", label: "Epic pet", unit: "$", min: 1, max: 100000 },
      { key: "petPriceLegendary", label: "Legendary pet", unit: "$", min: 1, max: 100000 },
      { key: "hatPricePerWin", label: "Hat price per win it needs", unit: "$", min: 0, max: 1000 },
      { key: "recolorPrice", label: "Character recolor", unit: "$", min: 1, max: 100000 },
      { key: "petColorPrice", label: "Pet color", unit: "$", min: 1, max: 100000 },
      { key: "accessoryPrice", label: "Accessory", unit: "$", min: 1, max: 100000 },
      { key: "trailPrice", label: "Walking trail", unit: "$", min: 1, max: 100000 },
      { key: "effectPrice", label: "Win effect", unit: "$", min: 1, max: 100000 },
      { key: "tauntPrice", label: "Win taunt", unit: "$", min: 1, max: 100000 },
      { key: "titlePrice", label: "Title", unit: "$", min: 1, max: 100000 },
      { key: "buildSlotPrice", label: "2nd build slot", unit: "$", min: 1, max: 100000 },
      { key: "buildSlotPriceMore", label: "Each build slot after that", unit: "$", min: 1, max: 100000 },
    ],
  },
  // Only used when config.quickDuel is false, and no screen turns that off, so the group stays hidden (but in the form, so saving keeps its values).
  {
    title: "HP fight abilities",
    visible: (c) => c.quickDuel === false,
    fields: [
      { key: "abilities.strike.damage", label: "Strike damage", unit: "HP", min: 1, max: 1000 },
      { key: "abilities.strike.cooldownMs", label: "Strike cooldown", unit: "s", ms: true, min: 250, max: 600000 },
      { key: "abilities.heavy.damage", label: "Heavy strike damage", unit: "HP", min: 1, max: 1000 },
      { key: "abilities.heavy.cooldownMs", label: "Heavy strike cooldown", unit: "s", ms: true, min: 250, max: 600000 },
      { key: "abilities.heal.amount", label: "Heal amount", unit: "HP", min: 1, max: 1000 },
      { key: "abilities.heal.cooldownMs", label: "Heal cooldown", unit: "s", ms: true, min: 250, max: 600000 },
      { key: "sharedCooldownMs", label: "Delay between any two actions", unit: "s", ms: true, min: 250, max: 60000 },
    ],
  },
];
const FIELDS = GROUPS.flatMap((g) => g.fields);
const LABELS = Object.fromEntries<Label>([
  ...FIELDS.map((f): [string, Label] => [f.key, f]),
  ["enabled", { label: "Duels enabled" }],
]);
const get = (obj: unknown, key: string) =>
  // each step reads one property of an object (or of anything else, which yields undefined as before)
  key.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
const flatten = (config: Config | null | undefined) =>
  Object.fromEntries([...FIELDS.map((f) => [f.key, get(config, f.key)]), ["enabled", config?.enabled]]);
const show = (key: string, v: unknown) =>
  v === undefined
    ? "—"
    : key === "enabled" || LABELS[key]?.bool
      ? v
        ? "on"
        : "off"
      : LABELS[key]?.ms
        ? // ms fields hold numbers
          seconds(v as number)
        : // a number, or text for a value the server sent as text
          (v as number) + (LABELS[key]?.unit && LABELS[key].unit !== "s" ? " " + LABELS[key].unit : "");

const S: {
  session: Session | null;
  access: Access | null;
  admin: Admin | null;
  leaderboard: Fighter[];
  names: Map<string, string>;
  socket: WebSocket | null;
  retry: number;
} = { session: null, access: null, admin: null, leaderboard: [], names: new Map(), socket: null, retry: 0 };
const actionStatus = $<HTMLParagraphElement>("#action-status"),
  configStatus = $<HTMLParagraphElement>("#config-status");
const OPEN = new Set(["pending", "active"]);

// ---------- tabs ----------
// One panel at a time; the URL hash (#players, #rules, ...) keeps the tab across reloads and links.
// every tab on the page is a button
const TABS = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
function selectTab(tab: HTMLElement, focus = false) {
  for (const t of TABS) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    // every tab's aria-controls names its panel on the page
    document.getElementById(t.getAttribute("aria-controls")!)!.hidden = !on;
  }
  if (focus) tab.focus();
  const hash = "#" + tab.id.slice(4);
  if (location.hash !== hash)
    history.replaceState(null, "", hash === "#live" ? location.pathname + location.search : hash);
}
for (const t of TABS) {
  t.addEventListener("click", () => selectTab(t));
  t.addEventListener("keydown", (e) => {
    const i = TABS.indexOf(t),
      // any other key finds no entry
      next = ({ ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 } as KeyMoves)[e.key];
    if (next === undefined) return;
    e.preventDefault();
    // TABS[...]!: the index wraps into the list
    selectTab(TABS[(next + TABS.length) % TABS.length]!, true);
  });
}
// TABS[0]!: the page has five tabs
selectTab(document.getElementById("tab-" + location.hash.slice(1)) || TABS[0]!);

// ---------- loading and access ----------
// Why the access check said no (server/auth.ts access), in words for the person at the gate.
const GATE_REASONS: Record<string, (() => string) | undefined> = {
  "Sign in with Twitch": () => "You're not signed in.",
  "Current Twitch moderator role required": () => "Your Twitch account isn't a moderator of " + CHANNEL + ".",
  "Broadcaster must connect moderator authorization": () =>
    CHANNEL +
    " hasn't connected mod access yet, so moderators can't sign in until they do it on their Stream setup page.",
};
function gate(text: string, actions: Node[] = []) {
  $("#gate").hidden = false;
  $<HTMLDivElement>("#app").hidden = true;
  $<HTMLParagraphElement>("#gate-text").textContent = text;
  $<HTMLDivElement>("#gate-actions").replaceChildren(...actions);
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
  if (lb.ok)
    parts.push(
      ranked.length
        ? ranked.length +
            " ranked fighter" +
            (ranked.length === 1 ? "" : "s") +
            ", " +
            // ranked[0]!: the list isn't empty here
            (ranked[0]!.displayName || ranked[0]!.username) +
            " leads at " +
            // as above
            ranked[0]!.elo +
            " Elo"
        : "no ranked duels yet",
    );
  const p = $<HTMLParagraphElement>("#gate-proof");
  p.textContent = "Right now in " + CHANNEL + "'s arena: " + parts.join("; ") + ".";
  p.hidden = false;
}
async function init() {
  // a slow or rate-limited check shouldn't leave the gate blank: offer sign-in while it finishes
  const slow = setTimeout(
    () =>
      gate("Still checking your access. If you aren't signed in yet, sign in with Twitch.", [
        h("a", { class: "btn btn-primary", href: loginHref(), "data-login": "" }, "Sign in with Twitch"),
      ]),
    1500,
  );
  const session = parseAnswer(await api("/api/session"), parseSession, "the session");
  clearTimeout(slow);
  S.session = session.ok ? session.data : null;
  renderWho($<HTMLDivElement>("#who"), S.session, signOut);
  if (!S.session)
    return gate("We can't check sign-in right now. Try again in a minute.", [
      h("button", { class: "btn btn-primary", type: "button", onclick: () => location.reload() }, "Try again"),
    ]);
  if (!S.session.user) {
    if (S.session.configured === false)
      return gate("Twitch sign-in isn't set up on this server yet, so mod controls are unavailable.");
    $<HTMLDivElement>("#who").replaceChildren(); // one sign-in button: the gate's
    // a word joiner keeps "?channel=" on one line on phones
    if (BARE)
      return gate(
        "Sign in with Twitch to open mod controls. Streamers land on their own channel. Moderators: open the mod link your streamer shares; it ends in ?\u2060channel= and their name.",
        [h("a", { class: "btn btn-primary", href: loginHref(), "data-login": "" }, "Sign in with Twitch"), startLink()],
      );
    return gate(
      CHANNEL === site.defaultChannel
        ? "Sign in with the " +
            site.owner.login +
            " account or a " +
            site.owner.login +
            " moderator account to open mod controls."
        : "Sign in with the " + CHANNEL + " Twitch account to open mod controls.",
      [h("a", { class: "btn btn-primary", href: loginHref(), "data-login": "" }, "Sign in with Twitch")],
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
  named();
  $("#gate").hidden = true;
  $<HTMLDivElement>("#app").hidden = false;
  $<HTMLAnchorElement>("#dev-link").hidden = $("#dev-section").hidden = !S.access.owner;
  $<HTMLDivElement>("#owner-chat").hidden = !S.access.owner || CHANNEL !== site.defaultChannel;
  const [loaded] = await Promise.all([load(), loadLeaderboard(), loadCustom(), loadPets(), loadSprites()]);
  // every control reads S.admin, so without the arena the gate stays up (load already gated a 401 or 403)
  if (!S.admin)
    return loaded === false
      ? gate("Couldn't load the arena right now. Try again in a minute.", [
          h("button", { class: "btn btn-primary", type: "button", onclick: () => location.reload() }, "Try again"),
        ])
      : undefined;
  if (S.admin.channelState !== "paused") connectLive();
  // Back from "Connect mod access" (/auth/login?connect=mods)
  const mods = new URLSearchParams(location.search).get("mods");
  const MODS: Record<string, string | undefined> = {
    connected: "Mod access is connected. Your Twitch moderators can sign in to this page now.",
    denied: "The Twitch permission was cancelled, so mod access isn't connected.",
    wrong_account: "Mod access has to be connected while signed in to Twitch as " + CHANNEL + ".",
  };
  // without ?mods= this looks up "null", which isn't a key, as before
  if (MODS[mods as string]) {
    // as above; element type from the page HTML
    setStatus($<HTMLParagraphElement>("#check-status"), MODS[mods as string], mods === "connected" ? "ok" : "error");
    const url = new URL(location.href);
    url.searchParams.delete("mods");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  // Back from "Allow channel point rewards" (/auth/login?channel=<login>&connect=points)
  const points = new URLSearchParams(location.search).get("points");
  const POINTS: Record<string, string | undefined> = {
    connected: "Channel point rewards are allowed. Add a reward below.",
    denied: "The Twitch permission was cancelled, so PixFray can't make channel point rewards.",
  };
  // without ?points= this looks up "null", which isn't a key
  if (POINTS[points as string]) {
    // as above; element type from the page HTML
    setStatus(
      $<HTMLParagraphElement>("#points-status"),
      POINTS[points as string],
      points === "connected" ? "ok" : "error",
    );
    const url = new URL(location.href);
    url.searchParams.delete("points");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  // Back from "Add the PixFray bot" (/auth/login?connect=bot) or sign-up with channel:bot: connect chat through the bot now.
  if (new URLSearchParams(location.search).get("bot") === "allowed") {
    const url = new URL(location.href);
    url.searchParams.delete("bot");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    const c: ChatStatus = S.admin?.chatStatus || {};
    if (S.admin?.chatBot?.login && !(c.connected && c.source === "twitch"))
      await chatAct(
        "connectChat",
        $<HTMLButtonElement>("#connect-chat"),
        false,
        $<HTMLParagraphElement>("#bot-status"),
      );
  }
  mountUploads();
}
async function load() {
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
async function loadLeaderboard() {
  const r = parseAnswer(await api("/api/leaderboard/" + CHANNEL + "?private=1"), parseLeaderboard, "the leaderboard");
  S.leaderboard = r.ok ? r.data : [];
  if (S.admin) {
    renderRanks();
    renderHistory();
  }
}

// ---------- names ----------
function nameOf(id: string | undefined) {
  if (!id) return "—";
  if (id === "system") return "System";
  if (S.session?.user?.id === id) return (S.session.user.displayName || S.session.user.login) + " (you)";
  return S.names.get(id) || "Twitch user " + id;
}
function collectNames() {
  for (const h of S.admin?.history || []) if (h.actorName) S.names.set(h.actorId, h.actorName);
  for (const p of [...S.leaderboard, ...(S.admin?.players || [])]) S.names.set(p.userId, p.displayName || p.username);
}

// ---------- actions ----------
async function act(
  action: string,
  payload?: unknown,
  { confirmText, button, done }: { confirmText?: string | undefined; button?: HTMLButtonElement; done?: string } = {},
) {
  if (confirmText && !confirm(confirmText)) return null;
  if (button) button.disabled = true;
  setStatus(actionStatus, "Working…");
  const r = await api("/api/admin/" + CHANNEL, {
    method: "POST",
    body: payload === undefined ? { action } : { action, payload },
  });
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
$<HTMLButtonElement>("#toggle-duels").addEventListener("click", (e) => {
  // S.admin!: init() keeps the gate up until load() fills S.admin, and a failed reload keeps the old value
  const enabled = !S.admin!.config.enabled;
  // as above
  const open = S.admin!.duels.filter((d) => OPEN.has(d.status)).length;
  act(
    "config",
    // as above
    { patch: { enabled }, baseVersion: S.admin!.configVersion, note: enabled ? "duels enabled" : "duels paused" },
    {
      // the listener sits on this button
      button: e.currentTarget as HTMLButtonElement,
      confirmText:
        !enabled && open
          ? "Pause duels? The " + open + " open duel" + (open === 1 ? "" : "s") + " will be cancelled without scoring."
          : undefined,
      done: enabled ? "Duels are on." : "Duels are paused. Open duels were cancelled without scoring.",
    },
  );
});
// Duel announcements live in the channel config: every open overlay picks the change up from its next snapshot.
$<HTMLSelectElement>("#announce").addEventListener("change", async (e) => {
  // the listener sits on this select
  const select = e.currentTarget as HTMLSelectElement,
    status = $<HTMLParagraphElement>("#announce-status");
  select.disabled = true;
  setStatus(status, "Saving…");
  const r = await api("/api/admin/" + CHANNEL, {
    method: "POST",
    body: {
      action: "config",
      payload: {
        patch: { announce: select.value },
        // S.admin!: init() keeps the gate up until load() fills S.admin, and a failed reload keeps the old value
        baseVersion: S.admin!.configVersion,
        note: "announcements " + select.value,
      },
    },
  });
  select.disabled = false;
  if (!r.ok) {
    setStatus(status, "Couldn't save: " + errorText(r) + ".", "error");
    // as above
    select.value = S.admin!.config.announce || "off";
    return;
  }
  setStatus(
    status,
    select.value === "off"
      ? "Announcements hidden on every overlay."
      : "Saved. Overlays show announcements within seconds.",
    "ok",
  );
  await load();
});
// The on-screen limit is channel config too, so open overlays apply it from their next snapshot.
$<HTMLInputElement>("#cap").addEventListener("change", async (e) => {
  // the listener sits on this input
  const input = e.currentTarget as HTMLInputElement,
    status = $<HTMLParagraphElement>("#cap-status"),
    value = Number(input.value);
  if (!Number.isInteger(value) || value < 15 || value > 100) {
    setStatus(status, "Pick a whole number from 15 to 100.", "error");
    // S.admin!: init() keeps the gate up until load() fills S.admin, and a failed reload keeps the old value; the DOM turns the number into text, as before
    input.value = (S.admin!.config.maxOnStream || 50) as unknown as string;
    return;
  }
  input.disabled = true;
  setStatus(status, "Saving…");
  const r = await api("/api/admin/" + CHANNEL, {
    method: "POST",
    body: {
      action: "config",
      payload: {
        patch: { maxOnStream: value },
        // S.admin!: as above
        baseVersion: S.admin!.configVersion,
        note: "up to " + value + " on stream",
      },
    },
  });
  input.disabled = false;
  if (!r.ok) {
    setStatus(status, "Couldn't save: " + errorText(r) + ".", "error");
    // as above
    input.value = (S.admin!.config.maxOnStream || 50) as unknown as string;
    return;
  }
  setStatus(status, "Saved. Overlays show up to " + value + " characters within seconds.", "ok");
  await load();
});
$<HTMLButtonElement>("#open-chat-setup").addEventListener("click", () =>
  selectTab($<HTMLButtonElement>("#tab-chat"), true),
);
$<HTMLButtonElement>("#reset-health").addEventListener("click", (e) =>
  act("resetHealth", undefined, {
    // the listener sits on this button
    button: e.currentTarget as HTMLButtonElement,
    confirmText: "Put every viewer in the arena back to full health?",
    done: "Everyone in the arena is back to full health.",
  }),
);
$<HTMLButtonElement>("#reset-round").addEventListener("click", (e) =>
  act("resetRound", undefined, {
    // the listener sits on this button
    button: e.currentTarget as HTMLButtonElement,
    confirmText: "Cancel every open duel without scoring and restart rounds at 1?",
    done: "Open duels cancelled; rounds restart at 1.",
  }),
);
// Mod gift: dollars to one saved fighter (server/channel.ts giftDollars). Negative takes them back.
$<HTMLFormElement>("#gift-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $<HTMLParagraphElement>("#gift-status"),
    username = $<HTMLInputElement>("#gift-user").value.trim().replace(/^@/, ""),
    amount = Number($<HTMLInputElement>("#gift-amount").value);
  if (!/^[a-z0-9_]{1,25}$/i.test(username)) return setStatus(status, "Type the viewer's Twitch name.", "error");
  if (!Number.isInteger(amount) || !amount || Math.abs(amount) > 10000)
    return setStatus(status, "Pick a whole number from -10000 to 10000, not 0.", "error");
  const button = $<HTMLButtonElement>("#gift-send");
  button.disabled = true;
  setStatus(status, "Saving…");
  const r = await api("/api/admin/" + CHANNEL, {
    method: "POST",
    body: { action: "giftDollars", payload: { username, amount } },
  });
  button.disabled = false;
  if (!r.ok)
    return setStatus(
      status,
      r.status === 404
        ? username + " has no saved fighter on " + CHANNEL + "."
        : "Couldn't gift: " + errorText(r) + ".",
      "error",
    );
  setStatus(
    status,
    (amount > 0 ? "Gave $" + amount + " to " : "Took $" + -amount + " from ") +
      (r.data.displayName || r.data.username) +
      ". They have $" +
      r.data.dollars +
      " now.",
    "ok",
  );
  $<HTMLInputElement>("#gift-amount").value = "";
  await loadLeaderboard();
});
// Pair reset: one pair's ranked duels this stream start over (server/channel.ts resetPair), like !resetpair in chat.
$<HTMLFormElement>("#pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $<HTMLParagraphElement>("#pair-status"),
    a = $<HTMLInputElement>("#pair-a").value.trim().replace(/^@/, ""),
    b = $<HTMLInputElement>("#pair-b").value.trim().replace(/^@/, "");
  if (![a, b].every((name) => /^[a-z0-9_]{1,25}$/i.test(name)))
    return setStatus(status, "Type both viewers' Twitch names.", "error");
  if (a.toLowerCase() === b.toLowerCase()) return setStatus(status, "Pick two different viewers.", "error");
  const button = $<HTMLButtonElement>("#pair-send");
  button.disabled = true;
  setStatus(status, "Saving…");
  const r = await api("/api/admin/" + CHANNEL, { method: "POST", body: { action: "resetPair", payload: { a, b } } });
  button.disabled = false;
  if (!r.ok)
    return setStatus(
      status,
      r.status === 404
        ? (r.data?.missing || a + " or " + b) + " has no saved fighter on " + CHANNEL + "."
        : "Couldn't reset: " + errorText(r) + ".",
      "error",
    );
  setStatus(
    status,
    "Reset " +
      r.data.a +
      " and " +
      r.data.b +
      ": " +
      (typeof r.data.left === "number" ? r.data.left + " ranked duels left this stream." : "no limit on this channel."),
    "ok",
  );
});
$<HTMLButtonElement>("#reset-all-ranks").addEventListener("click", (e) =>
  act("resetAllRanks", undefined, {
    // the listener sits on this button
    button: e.currentTarget as HTMLButtonElement,
    confirmText: "Reset Elo, wins and losses for every saved profile on " + CHANNEL + "? This can't be undone.",
    done: "All ranks reset.",
  }),
);
$<HTMLButtonElement>("#reset-all").addEventListener("click", (e) =>
  act("resetAll", undefined, {
    // the listener sits on this button
    button: e.currentTarget as HTMLButtonElement,
    confirmText: "Remove every character from the arena and cancel all duels? Saved profiles and ranks stay.",
    done: "Arena cleared.",
  }),
);

// ---------- rendering ----------
function renderAll() {
  collectNames();
  // S.admin!: renderAll runs only after load() or a snapshot filled it
  const a = S.admin!,
    c = a.config,
    open = a.duels.filter((d) => OPEN.has(d.status));
  const chat: ChatStatus = a.chatStatus || a.chat || {},
    health = chatHealth();
  // resetting all ranks, a new StreamElements key and moving chat from another site are the broadcaster's (server/worker.ts)
  // both ids are buttons in the page HTML
  for (const id of ["#reset-all-ranks", "#rotate-se"]) $<HTMLButtonElement>(id).hidden = !mayBroadcast();
  $<HTMLParagraphElement>("#meta").textContent =
    "Signed in as " +
    // S.access!: init() confirmed access before anything renders
    ((S.access!.owner && CHANNEL === site.defaultChannel) || S.access!.broadcaster
      ? "the broadcaster"
      : // as above
        S.access!.owner
        ? "the site owner"
        : "a moderator") +
    ".";
  const waiting = c.enabled && !health.ok;
  $<HTMLHeadingElement>("#summary-title").textContent = !c.enabled
    ? "Duels are paused by a moderator"
    : waiting
      ? health.title
      : "Duels are live";
  $<HTMLParagraphElement>("#summary-text").textContent = !c.enabled
    ? "Chat commands are ignored until duels are turned back on."
    : waiting
      ? health.text + (chat.lastRevocationReason ? " Twitch revoked access: " + chat.lastRevocationReason + "." : "")
      : open.length + " of " + c.maxDuels + " duel slots in use, " + a.players.length + " viewers in the arena.";
  const toggle = $<HTMLButtonElement>("#toggle-duels");
  toggle.textContent = c.enabled ? "Pause duels" : "Turn duels on";
  // while chat is offline the fix is the main action: Connect chat right here where Twitch chat applies, else the Stream setup tab
  const connectHere = waiting && !chat.connected && !$("#chat-box").hidden && !a.seOnly;
  $<HTMLButtonElement>("#summary-connect").hidden = !connectHere;
  $<HTMLButtonElement>("#open-chat-setup").hidden = !waiting;
  $<HTMLButtonElement>("#open-chat-setup").className = "btn" + (connectHere ? "" : " btn-primary");
  toggle.classList.toggle("btn-primary", !waiting);
  $<HTMLDivElement>("#stats").replaceChildren(
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
  if (document.activeElement !== $<HTMLSelectElement>("#announce"))
    $<HTMLSelectElement>("#announce").value = a.config.announce || "off";
  if (document.activeElement !== $<HTMLInputElement>("#cap"))
    // element type from the page HTML; the DOM turns the number into text, as before
    $<HTMLInputElement>("#cap").value = (a.config.maxOnStream || 50) as unknown as string;
  renderDuels();
  renderPlayers();
  renderRanks();
  renderConfig();
  renderHistory();
  renderUsage();
  renderChat();
  renderSe();
  renderChecklist();
  renderCheckinTest();
  renderBotCommands();
  renderPoints();
  renderPower();
}
// Where chat comes from and whether it works. StreamElements counts as working only once a command has
// arrived with this site's key; choosing it as the source isn't enough. The Stream setup tab uses the same rules.
function chatHealth():
  | { ok: false; label: string; value: string; note: string; title: string; text: string }
  | { ok: true; label: string; value: string; note: string } {
  // S.admin!: called from renderAll, as above
  const a = S.admin!,
    c: ChatStatus = a.chatStatus || a.chat || {},
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
function stat(label: string, value: string | number, cls?: string, delta?: string) {
  const word = typeof value === "string" && !/\d/.test(value); // "Not connected" reads smaller than a number, on one line
  return h(
    "div",
    { class: "stat" },
    h("div", { class: "label" }, label),
    h("div", { class: "value" + (word ? " word" : "") }, value),
    delta ? h("div", { class: "delta " + (cls || "") }, delta) : null,
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
// Snapshots rebuild the tables; put keyboard focus back on the same row's button afterwards.
function keepFocus(tbody: HTMLElement, render: () => void) {
  const key = tbody.contains(document.activeElement)
    ? // focus inside the table is on one of its elements
      (document.activeElement as HTMLElement).dataset.key
    : null;
  render();
  // the data-key carriers are buttons
  if (key) tbody.querySelector<HTMLButtonElement>('[data-key="' + CSS.escape(key) + '"]')?.focus();
}
const empty = (cols: number, text: string) => h("tr", {}, h("td", { colspan: cols, class: "muted" }, text));
function renderDuels() {
  keepFocus($<HTMLTableSectionElement>("#duels tbody"), drawDuels);
}
function drawDuels() {
  const tbody = $<HTMLTableSectionElement>("#duels tbody"),
    now = Date.now();
  // S.admin!: the table renders only after load() filled it, and the timer checks it
  const open = S.admin!.duels.filter((d) => OPEN.has(d.status));
  if (!open.length) return tbody.replaceChildren(empty(6, "No open duels. Viewers start one with !challenge @viewer."));
  tbody.replaceChildren(
    ...open.map((d) => {
      // S.admin!: as above
      const max = (id: string) => d.maxHp?.[id] || d.rules?.maxHp || S.admin!.config.maxHp;
      const left =
        d.status === "pending"
          ? Math.max(0, d.expiresAt - now)
          : // as above
            Math.max(0, (d.lastActionAt || d.startedAt || 0) + S.admin!.config.inactivityMs - now);
      return h(
        "tr",
        {},
        h("td", {}, nameOf(d.a), " vs ", nameOf(d.b)),
        h(
          "td",
          {},
          h(
            "span",
            { class: "badge" + (d.status === "active" ? " positive" : "") },
            d.status === "active" ? "Fighting" : "Waiting for accept",
          ),
        ),
        h(
          "td",
          {},
          d.status === "active"
            ? h(
                "div",
                {},
                h("div", {}, hp(d.hp?.[d.a] ?? max(d.a), max(d.a), nameOf(d.a))),
                h("div", {}, hp(d.hp?.[d.b] ?? max(d.b), max(d.b), nameOf(d.b))),
              )
            : "—",
        ),
        h("td", { class: "num" }, d.round || "—"),
        h(
          "td",
          {},
          (d.status === "pending" ? "expires in " : "idle cancel in ") + seconds(Math.round(left / 1000) * 1000),
        ),
        h(
          "td",
          {},
          h(
            "button",
            {
              class: "btn btn-small",
              type: "button",
              "data-key": "cancel:" + d.id,
              "aria-label": "Cancel duel " + nameOf(d.a) + " vs " + nameOf(d.b),
              onclick: (e: Event) =>
                act(
                  "cancelDuel",
                  { duelId: d.id },
                  {
                    // the handler sits on this button
                    button: e.currentTarget as HTMLButtonElement,
                    confirmText: "Cancel " + nameOf(d.a) + " vs " + nameOf(d.b) + " without scoring?",
                    done: "Duel cancelled without scoring.",
                  },
                ),
            },
            "Cancel duel",
          ),
        ),
      );
    }),
  );
}
function renderPlayers() {
  keepFocus($<HTMLTableSectionElement>("#players tbody"), drawPlayers);
}
function drawPlayers() {
  const tbody = $<HTMLTableSectionElement>("#players tbody"),
    now = Date.now(),
    // S.admin!: the table renders only after load() filled it. A fighter in a duel has its vitality max HP there.
    max = (userId: string) =>
      S.admin!.duels.find((d) => OPEN.has(d.status) && d.maxHp?.[userId])?.maxHp?.[userId] || S.admin!.config.maxHp;
  // as above
  if (!S.admin!.players.length)
    return tbody.replaceChildren(
      empty(7, "Nobody is in the arena. Characters appear after a viewer's first chat message."),
    );
  tbody.replaceChildren(
    // as above
    ...S.admin!.players.map((p) =>
      h(
        "tr",
        {},
        h(
          "td",
          {},
          h("span", { style: { color: p.color }, "aria-hidden": "true" }, "■ "),
          p.displayName || p.username,
          p.registered ? null : h("span", { class: "muted" }, " (no profile)"),
        ),
        h(
          "td",
          {},
          p.respawnAt > now ? h("span", { class: "badge negative" }, "Knocked out") : hp(p.hp, max(p.userId)),
        ),
        h("td", { class: "num" }, p.elo),
        h("td", { class: "num" }, p.wins),
        h("td", { class: "num" }, p.losses),
        h("td", {}, timeAgo(p.lastSeen)),
        h(
          "td",
          {},
          h(
            "button",
            {
              class: "btn btn-small btn-danger",
              type: "button",
              "data-key": "remove:" + p.userId,
              "aria-label": "Remove " + (p.displayName || p.username),
              // the handler sits on this button
              onclick: (e: Event) => removePlayer(p, e.currentTarget as HTMLButtonElement),
            },
            "Remove",
          ),
        ),
      ),
    ),
  );
}
const removePlayer = (p: Player | Fighter, button: HTMLButtonElement) =>
  act(
    "removePlayer",
    { userId: p.userId },
    {
      button,
      confirmText: "Remove " + (p.displayName || p.username) + " from the arena and delete their saved profile?",
      done: "Viewer removed.",
    },
  );
function renderRanks() {
  keepFocus($<HTMLTableSectionElement>("#ranks tbody"), drawRanks);
}
function drawRanks() {
  const tbody = $<HTMLTableSectionElement>("#ranks tbody");
  if (!S.leaderboard.length) return tbody.replaceChildren(empty(7, "No saved profiles yet."));
  tbody.replaceChildren(
    ...S.leaderboard.map((p, i) =>
      h(
        "tr",
        {},
        h("td", { class: "num" }, i + 1),
        h("td", {}, p.displayName || p.username),
        h("td", { class: "num" }, p.elo),
        h("td", { class: "num" }, p.wins),
        h("td", { class: "num" }, p.losses),
        h("td", { class: "num" }, p.dollars ?? 0),
        h(
          "td",
          {},
          h(
            "div",
            { class: "toolbar" },
            h(
              "button",
              {
                class: "btn btn-small",
                type: "button",
                "data-key": "rank:" + p.userId,
                "aria-label": "Reset rank for " + (p.displayName || p.username),
                onclick: (e: Event) =>
                  act(
                    "resetRank",
                    { userId: p.userId },
                    {
                      // the handler sits on this button
                      button: e.currentTarget as HTMLButtonElement,
                      confirmText: "Reset " + (p.displayName || p.username) + "'s Elo, wins and losses?",
                      done: "Rank reset.",
                    },
                  ),
              },
              "Reset rank",
            ),
            h(
              "button",
              {
                class: "btn btn-small btn-danger",
                type: "button",
                "data-key": "rank-remove:" + p.userId,
                "aria-label": "Remove " + (p.displayName || p.username),
                // the handler sits on this button
                onclick: (e: Event) => removePlayer(p, e.currentTarget as HTMLButtonElement),
              },
              "Remove",
            ),
          ),
        ),
      ),
    ),
  );
}

// ---------- config editor ----------
// The form remembers the version it was built from. Unsaved edits survive live updates; if someone else saves in
// the meantime, the save is sent with the old baseVersion and the server answers 409 (handled below).
let editedBase = 0,
  editedConfig: Config | null = null;
function renderConfig() {
  const box = $<HTMLDivElement>("#config-fields"),
    // S.admin!: called from renderAll and the Discard button, both after load() filled it
    config = S.admin!.config;
  if (box.childElementCount && formDirty()) {
    // as above
    if (editedBase !== S.admin!.configVersion)
      setStatus(
        configStatus,
        "Version " +
          // as above
          S.admin!.configVersion +
          " was saved by someone else while you were editing. Discard your changes to load it.",
        "error",
      );
    return;
  }
  // as above
  editedBase = S.admin!.configVersion;
  editedConfig = config;
  box.replaceChildren(
    ...GROUPS.map((g) =>
      h(
        "fieldset",
        // as above
        { class: "config-group", hidden: g.visible ? !g.visible(config, S.admin!) : false },
        h("legend", {}, g.title),
        h(
          "div",
          { class: "config-grid" },
          g.fields.map((f) => {
            const id = "cfg-" + f.key.replace(/\./g, "-"),
              value = get(config, f.key);
            if (f.bool)
              return h(
                "div",
                {},
                h(
                  "label",
                  { class: "check", for: id },
                  h("input", { id, type: "checkbox", "data-key": f.key, checked: Boolean(value) }),
                  " " + f.label,
                ),
                h("p", { class: "hint" }, f.hint),
              );
            const input = h("input", {
              id,
              type: "number",
              inputmode: "decimal",
              required: true,
              "data-key": f.key,
              min: f.ms ? f.min / 1000 : f.min,
              max: f.ms ? f.max / 1000 : f.max,
              step: f.ms ? 0.25 : 1,
              // ms fields hold numbers
              value: String(f.ms ? (value as number) / 1000 : value),
            });
            return h(
              "div",
              {},
              h("label", { for: id }, f.label + " (" + f.unit + ")"),
              input,
              h("p", { class: "hint" }, f.ms ? seconds(f.min) + " to " + seconds(f.max) : f.min + " to " + f.max),
            );
          }),
        ),
      ),
    ),
  );
  syncConfigButtons();
}
function readField(input: HTMLInputElement): { value?: unknown; error?: string } {
  // the inputs carry a FIELDS key in data-key (renderConfig), so the entry is a Field
  const f = LABELS[input.dataset.key!] as Field,
    raw = input.value.trim(),
    n = Number(raw);
  if (f.bool) return { value: input.checked };
  if (raw === "" || !Number.isFinite(n)) return { error: f.label + " needs a number." };
  const value = f.ms ? Math.round(n * 1000) : n;
  if (!Number.isInteger(value)) return { error: f.label + " must be a whole number." };
  if (value < f.min || value > f.max)
    return { error: f.label + " must be between " + show(f.key, f.min) + " and " + show(f.key, f.max) + "." };
  return { value };
}
function buildPatch() {
  const patch: Record<string, unknown> = {},
    errors: string[] = [];
  // the selector matches inputs, each with a data-key
  for (const input of document.querySelectorAll<HTMLInputElement>("#config-fields input[data-key]")) {
    // as above
    const key = input.dataset.key!,
      r = readField(input);
    input.setCustomValidity(r.error || "");
    if (r.error) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
    // each input sits in its field's div
    input.parentElement!.classList.toggle("changed", !r.error && r.value !== get(editedConfig, key));
    if (r.error) {
      errors.push(r.error);
      continue;
    }
    if (r.value === get(editedConfig, key)) continue;
    const path = key.split(".");
    let node = patch;
    // each level is an object this loop made
    for (const part of path.slice(0, -1)) node = (node[part] ||= {}) as Record<string, unknown>;
    // split() returns at least one part
    node[path.at(-1)!] = r.value;
  }
  return { patch, errors };
}
const formDirty = () => Object.keys(buildPatch().patch).length > 0;
addEventListener("beforeunload", (e) => {
  if (S.admin && formDirty()) e.preventDefault();
}); // unsaved rule edits
function syncConfigButtons() {
  const { patch, errors } = buildPatch(),
    changed = Object.keys(patch).length > 0;
  $<HTMLButtonElement>("#config-save").disabled = !changed || errors.length > 0;
  $<HTMLButtonElement>("#config-save").className = "btn" + (changed && !errors.length ? " btn-primary" : "");
  $<HTMLButtonElement>("#config-discard").disabled = !changed;
  const bar = $<HTMLDivElement>("#config-bar");
  bar.classList.toggle("dirty", changed);
  if (errors.length) setStatus(configStatus, errors[0], "error");
  // S.admin!: the form exists only after renderConfig, which needs it
  else if (editedBase === S.admin!.configVersion)
    setStatus(
      configStatus,
      // as above
      changed ? "Unsaved changes. Saving creates version " + (S.admin!.configVersion + 1) + "." : "",
    );
  // The bar appears with the first edit; if it lands on the field being typed in, scroll that field above it.
  const field = document.activeElement;
  if (changed && field && $<HTMLDivElement>("#config-fields").contains(field)) {
    const overlap = field.getBoundingClientRect().bottom + 12 - bar.getBoundingClientRect().top;
    if (overlap > 0) scrollBy(0, overlap);
  }
}
$<HTMLFormElement>("#config-form").addEventListener("input", syncConfigButtons);
$<HTMLButtonElement>("#config-discard").addEventListener("click", () => {
  $<HTMLDivElement>("#config-fields").replaceChildren();
  renderConfig();
});
const mergeConfig = (base: Config, patch: Partial<Config>) => ({
  ...base,
  ...patch,
  abilities: Object.fromEntries(
    Object.entries(base.abilities || {}).map(([k, v]) => [k, { ...v, ...patch.abilities?.[k] }]),
  ),
});
$<HTMLFormElement>("#config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const { patch, errors } = buildPatch();
  if (errors.length || !Object.keys(patch).length) return;
  const save = $<HTMLButtonElement>("#config-save");
  save.disabled = true;
  setStatus(configStatus, "Saving…");
  const r = await api("/api/admin/" + CHANNEL, {
    method: "POST",
    body: {
      action: "config",
      payload: { patch, baseVersion: editedBase, note: $<HTMLInputElement>("#config-note").value.trim() },
    },
  });
  if (r.status === 409) {
    // editedConfig!: the form was built from it; buildPatch nests dotted keys, so patch has Config's shape
    const mine = diff(editedConfig, mergeConfig(editedConfig!, patch as Partial<Config>));
    $<HTMLDivElement>("#config-fields").replaceChildren();
    await load();
    setStatus(
      configStatus,
      "Not saved: someone else saved version " +
        // S.admin!: init() keeps the gate up until load() fills S.admin, and a failed reload keeps the old value
        S.admin!.configVersion +
        " first. The form now shows the current values. Your change was: " +
        mine +
        ".",
      "error",
    );
    return;
  }
  if (!r.ok) {
    save.disabled = false;
    setStatus(configStatus, "Not saved: " + errorText(r), "error");
    return;
  }
  $<HTMLInputElement>("#config-note").value = "";
  $<HTMLDivElement>("#config-fields").replaceChildren();
  await load();
  // S.admin!: as above
  setStatus(configStatus, "Saved as version " + S.admin!.configVersion + ".", "ok");
});
function diff(prev: Config | null | undefined, next: Config) {
  if (!prev) return "Starting values";
  const a = flatten(prev),
    b = flatten(next);
  const changes = Object.keys(b)
    .filter((k) => a[k] !== b[k])
    .map((k) => (LABELS[k]?.label || k) + " " + show(k, a[k]) + " → " + show(k, b[k]));
  return changes.length ? changes.join("; ") : "No value changes";
}
function renderHistory() {
  const tbody = $<HTMLTableSectionElement>("#history tbody"),
    // S.admin!: called from renderAll and loadLeaderboard's S.admin check
    rows = S.admin!.history || [];
  $("#history-title").textContent =
    "Version history (" + rows.length + (rows.length === 1 ? " version)" : " versions)");
  if (!rows.length) return tbody.replaceChildren(empty(6, "No saved versions yet. The first save is recorded here."));
  tbody.replaceChildren(
    ...rows.map((row, i) => {
      // as above
      const current = row.version === S.admin!.configVersion;
      return h(
        "tr",
        {},
        h("td", { class: "num" }, "v" + row.version),
        h("td", {}, dateTime(row.at)),
        h("td", {}, nameOf(row.actorId)),
        h("td", {}, diff(rows[i + 1]?.config, row.config)),
        h("td", {}, row.note || ""),
        h(
          "td",
          {},
          current
            ? h("span", { class: "badge positive" }, "Current")
            : h(
                "button",
                {
                  class: "btn btn-small",
                  type: "button",
                  onclick: (e: Event) =>
                    act(
                      "rollbackConfig",
                      { version: row.version },
                      {
                        // the handler sits on this button
                        button: e.currentTarget as HTMLButtonElement,
                        done: "Restored v" + row.version + " as a new version.",
                      },
                    ),
                },
                "Revert to v" + row.version,
              ),
        ),
      );
    }),
  );
}

// ---------- custom characters ----------
let customItems: CustomItem[] | null = null,
  customLimits: unknown = null;
function renderUsage() {
  // S.admin!: called from renderAll
  const u = S.admin!.customUsage || { count: 0, limit: LIMITS.maxCharacters, bytes: 0 };
  const limit = u.limit || LIMITS.maxCharacters,
    budget = limit * LIMITS.maxAtlasBytes;
  $<HTMLDivElement>("#usage-title").textContent = u.count + " of " + limit + " custom character slots used";
  const bar = (label: string, value: number, max: number, text: string, key: boolean) => [
    h("div", { class: "bar-label" }, label),
    h(
      "div",
      { class: "bar" + (key ? " is-key" : ""), style: { "--v": Math.min(100, (value / max) * 100) + "%" } },
      h("span"),
      h("b", {}, text),
    ),
  ];
  $<HTMLDivElement>("#usage-bars").replaceChildren(
    ...bar("Atlas storage", u.bytes, budget, formatBytes(u.bytes) + " / " + formatBytes(budget), true),
  ); // the title already counts the slots
}
async function loadCustom() {
  const r = await api("/api/assets/" + CHANNEL);
  const box = $<HTMLDivElement>("#custom-list");
  if (!r.ok) {
    box.replaceChildren(h("p", {}, "Couldn't list custom characters: " + errorText(r)));
    return;
  }
  // /api/assets/:channel body
  customItems = (r.data.items || []) as CustomItem[];
  customLimits = r.data.limits || null;
  if (!customItems.length) {
    box.replaceChildren(
      h("p", {}, "No custom characters yet. The slots are shared by the broadcaster and all moderators."),
    );
    return;
  }
  box.replaceChildren(
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "data" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", {}, "Character"),
            h("th", { class: "num" }, "Frames"),
            h("th", { class: "num" }, "Size"),
            h("th", {}, "Added"),
          ),
        ),
        h(
          "tbody",
          {},
          customItems.map((x) =>
            h(
              "tr",
              {},
              h("td", {}, x.label || x.id),
              h(
                "td",
                { class: "num" },
                (x.frames || []).length + Object.values(x.animations || {}).reduce((n, f) => n + f.length, 0),
              ),
              h("td", { class: "num" }, formatBytes(x.bytes || 0)),
              h("td", {}, dateTime(x.createdAt)),
            ),
          ),
        ),
      ),
    ),
  );
}
// ---------- custom pets ----------
// Uploaded pets join the shop at their tier's price (server/pets.ts). Built-in pets are drawn in code and can't be removed.
const TIER_LABELS: Record<string, string | undefined> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  epic: "Epic",
  legendary: "Legendary",
};
// A custom pet's boost. A legendary rolls its stats for each owner, so the table says so instead of a number.
const boostLabel = (tier: string, b: Record<string, number | undefined> | undefined) =>
  tier === "legendary"
    ? "+1 to 4 random stats"
    : ["power", "guard", "luck"]
        .filter((k) => b?.[k])
        // b!: the filter kept only stats b has
        .map((k) => "+" + b![k] + " " + k)
        .join(", ");
// Viewer sprites (server/sprites.ts): approve or turn down what viewers sent; remove approved ones.
async function loadSprites() {
  const r = await api("/api/sprites/" + CHANNEL),
    pendingBox = $<HTMLDivElement>("#sprite-pending"),
    liveBox = $<HTMLDivElement>("#sprite-live");
  if (!r.ok) {
    pendingBox.replaceChildren(h("p", { class: "muted small" }, "Couldn't list viewer sprites: " + errorText(r)));
    liveBox.replaceChildren();
    return;
  }
  // /api/sprites/:channel body
  const { pending = [], live = [] } = r.data as { pending?: Sprite[]; live?: Sprite[] };
  $<HTMLSpanElement>("#sprite-count").textContent = "(" + pending.length + ")";
  $<HTMLButtonElement>("#tab-characters").textContent = pending.length
    ? "Characters (" + pending.length + ")"
    : "Characters";
  const thumb = (x: Sprite) =>
    h("img", {
      class: "sprite-thumb",
      src: "/api/sprites/" + CHANNEL + "/" + x.id,
      alt: x.label,
      width: 64,
      height: 64,
      loading: "lazy",
    });
  // the login only when it isn't just the display name in other letter case
  const who = (x: Sprite) =>
    h(
      "td",
      {},
      x.displayName || x.username,
      ...(x.displayName && x.username && x.displayName.toLowerCase() !== x.username.toLowerCase()
        ? [h("br"), h("span", { class: "muted small" }, x.username)]
        : []),
    );
  const act = (x: Sprite, action: "approve" | "reject" | "remove", text: string, cls = "btn btn-small") =>
    h(
      "button",
      {
        type: "button",
        class: cls,
        // the handler sits on this button
        onclick: (e: Event) => reviewSprite(x, action, e.currentTarget as HTMLButtonElement),
      },
      text,
    );
  pendingBox.replaceChildren(
    !pending.length
      ? h("p", { class: "muted small" }, "Nothing waiting.")
      : h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "data" },
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", {}, "Sprite"),
                h("th", {}, "Name"),
                h("th", {}, "Viewer"),
                h("th", {}, "Made with"),
                h("th", {}, "Sent"),
                h("th", {}, h("span", { class: "sr-only" }, "Actions")),
              ),
            ),
            h(
              "tbody",
              {},
              pending.map((x) =>
                h(
                  "tr",
                  {},
                  h("td", {}, thumb(x)),
                  h("td", {}, x.label),
                  who(x),
                  h("td", {}, x.ai ? "AI redraw" : "Pixel filter"),
                  h("td", {}, dateTime(x.createdAt)),
                  h(
                    "td",
                    {},
                    h(
                      "div",
                      { class: "toolbar" },
                      act(x, "approve", "Approve"),
                      act(x, "reject", "Turn down", "btn btn-small btn-danger"),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
  );
  liveBox.replaceChildren(
    !live.length
      ? h("p", { class: "muted small" }, "None yet.")
      : h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            { class: "data" },
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                h("th", {}, "Sprite"),
                h("th", {}, "Name"),
                h("th", {}, "Viewer"),
                h("th", {}, "Approved by"),
                h("th", {}, "Approved"),
                h("th", {}, h("span", { class: "sr-only" }, "Actions")),
              ),
            ),
            h(
              "tbody",
              {},
              live.map((x) =>
                h(
                  "tr",
                  {},
                  h("td", {}, thumb(x)),
                  h("td", {}, x.label),
                  who(x),
                  h("td", {}, x.reviewedBy),
                  h("td", {}, dateTime(x.reviewedAt)),
                  h("td", {}, act(x, "remove", "Remove", "btn btn-small btn-danger")),
                ),
              ),
            ),
          ),
        ),
  );
}
async function reviewSprite(x: Sprite, action: "approve" | "reject" | "remove", button: HTMLButtonElement) {
  if (
    action === "remove" &&
    !confirm("Remove " + x.label + "? " + x.displayName + " goes back to the default character if they wear it.")
  )
    return;
  button.disabled = true;
  const r = await api("/api/sprites/" + CHANNEL + "/" + x.id, { method: "POST", body: { action } });
  button.disabled = false;
  const done = {
    approve: x.label + " approved and put on " + x.displayName + "'s fighter.",
    reject: x.label + " turned down.",
    remove: x.label + " removed.",
  }[action];
  setStatus(
    $<HTMLParagraphElement>("#sprite-review-status"),
    r.ok ? done : "Couldn't " + (action === "reject" ? "turn it down" : action) + ": " + errorText(r) + ".",
    r.ok ? "ok" : "error",
  );
  loadSprites();
}
async function loadPets() {
  const r = await api("/api/pets/" + CHANNEL),
    box = $<HTMLDivElement>("#pet-custom-list");
  if (!r.ok) {
    box.replaceChildren(h("p", { class: "muted small" }, "Couldn't list pets: " + errorText(r)));
    return;
  }
  // /api/pets/:channel body
  const custom = ((r.data.pets || []) as Pet[]).filter((p) => p.custom),
    max = r.data.limits?.maxPets || 24;
  $<HTMLSpanElement>("#pet-count").textContent = "(" + custom.length + " of " + max + ")";
  if (!custom.length) {
    box.replaceChildren(h("p", { class: "muted small" }, "No custom pets yet. Viewers can buy the 14 built-in pets."));
    return;
  }
  box.replaceChildren(
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "data" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", {}, "Pet"),
            h("th", {}, "Tier"),
            h("th", {}, "Boost"),
            h("th", { class: "num" }, "Price ($)"),
            h("th", {}, h("span", { class: "sr-only" }, "Actions")),
          ),
        ),
        h(
          "tbody",
          {},
          custom.map((p) =>
            h(
              "tr",
              {},
              h("td", {}, h("img", { class: "pet-thumb", src: p.url, alt: "", width: 32, height: 32 }), " " + p.label),
              h("td", {}, TIER_LABELS[p.tier] || p.tier),
              h("td", {}, boostLabel(p.tier, p.boost)),
              h("td", { class: "num" }, p.price),
              h(
                "td",
                {},
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn btn-small btn-danger",
                    // the handler sits on this button
                    onclick: (e: Event) => deletePet(p, e.currentTarget as HTMLButtonElement),
                  },
                  "Delete",
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
async function deletePet(p: Pet, button: HTMLButtonElement) {
  if (!confirm("Delete " + p.label + "? Fighters who bought it lose it, and no dollars are refunded.")) return;
  button.disabled = true;
  const r = await api("/api/pets/" + CHANNEL + "/" + p.id, { method: "DELETE" });
  button.disabled = false;
  setStatus(
    $<HTMLParagraphElement>("#pet-upload-status"),
    r.ok ? p.label + " deleted." : "Couldn't delete: " + errorText(r) + ".",
    r.ok ? "ok" : "error",
  );
  if (r.ok) loadPets();
}
function syncPetStats() {
  const tier = $<HTMLSelectElement>("#pet-tier").value;
  $<HTMLDivElement>("#pet-stat-wrap").hidden = tier === "legendary";
  $<HTMLDivElement>("#pet-stat2-wrap").hidden = tier !== "epic";
}
$<HTMLSelectElement>("#pet-tier").addEventListener("change", syncPetStats);
$<HTMLFormElement>("#pet-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $<HTMLParagraphElement>("#pet-upload-status"),
    // a file input always has a FileList; element type from the page HTML
    file = $<HTMLInputElement>("#pet-file").files![0],
    label = $<HTMLInputElement>("#pet-label").value.trim(),
    tier = $<HTMLSelectElement>("#pet-tier").value;
  const stat = $<HTMLSelectElement>("#pet-stat").value,
    stat2 = $<HTMLSelectElement>("#pet-stat2").value;
  if (!file) return setStatus(status, "Choose a PNG image.", "error");
  if (file.type !== "image/png") return setStatus(status, "The image must be a PNG.", "error");
  if (file.size > 65536) return setStatus(status, "The image is larger than 64 KB.", "error");
  if (!label) return setStatus(status, "Name the pet.", "error");
  if (tier === "epic" && stat === stat2) return setStatus(status, "Epic pets boost two different stats.", "error");
  const image = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
  const button = $<HTMLButtonElement>("#pet-upload");
  button.disabled = true;
  setStatus(status, "Uploading…");
  const r = await api("/api/pets/" + CHANNEL, { method: "POST", body: { label, tier, stat, stat2, image } });
  button.disabled = false;
  if (!r.ok) return setStatus(status, "Not uploaded: " + errorText(r) + ".", "error");
  setStatus(status, label + " is in the shop now.", "ok");
  $<HTMLFormElement>("#pet-form").reset();
  syncPetStats();
  loadPets();
});

// Lane D hook: src/served/upload.ts may export mountUpload(root, ctx). Probe first so a missing file stays quiet.
async function mountUploads() {
  const root = $<HTMLDivElement>("#upload-root");
  try {
    const probe = await fetch("/upload.js", { method: "HEAD" });
    if (!probe.ok || !/javascript/.test(probe.headers.get("Content-Type") || "")) return;
    const url = new URL("/upload.js", location.origin).href; // absolute, so Vite dev doesn't rewrite it to /upload.js?import
    const mod = await import(/* @vite-ignore */ url);
    if (typeof mod.mountUpload !== "function") return;
    root.replaceChildren();
    root.classList.remove("mount"); // the uploader brings its own frame
    await mod.mountUpload(root, {
      channel: CHANNEL,
      // S.admin!: init() keeps the gate up until load() fills S.admin, and a failed reload keeps the old value
      usage: S.admin!.customUsage,
      limits: customLimits || LIMITS,
      items: customItems || [],
      refresh: async () => {
        await Promise.all([load(), loadCustom()]);
      },
    });
  } catch (error) {
    root.replaceChildren(
      h(
        "p",
        { class: "status error" },
        // anything can be thrown
        "The upload tool failed to load: " + ((error as { message?: unknown } | null | undefined)?.message || error),
      ),
    );
  }
}

// ---------- chat connection ----------
const CHAT_STATUS: Record<string, string | undefined> = {
  enabled: "connected",
  webhook_callback_verification_pending: "waiting for Twitch to verify the webhook",
  pending: "waiting for Twitch to verify the webhook",
  disconnected: "not connected",
  authorization_revoked: "Twitch permission was revoked",
  user_removed: "the Twitch account was removed",
  notification_failures_exceeded: "Twitch stopped after repeated delivery failures",
  version_removed: "Twitch retired this subscription version",
  subscription_missing: "the subscription no longer exists on Twitch",
};
let verifying = false; // "Twitch is verifying" note shown after Connect chat; replaced once the webhook is verified
function renderChat() {
  // S.admin!: called from renderAll
  const c: ChatStatus = S.admin!.chatStatus || {};
  if (verifying && c.connected) {
    verifying = false;
    setStatus($<HTMLParagraphElement>("#chat-status"), "Chat connected. Duels are live.", "ok");
  }
  // a missing status looks up "undefined", which isn't a key, as before
  const parts = ["Status: " + (CHAT_STATUS[c.status as string] || c.status || "not connected") + "."];
  if (c.lastNotificationAt) parts.push("Last chat message " + timeAgo(c.lastNotificationAt) + ".");
  if (c.lastRevocationReason)
    parts.push("Last revocation: " + (CHAT_STATUS[c.lastRevocationReason] || c.lastRevocationReason) + ".");
  // S.admin!: as above
  const bot = S.admin!.chatBot;
  $("#chat-box").hidden = CHANNEL !== site.defaultChannel && !bot; // without the bot, other channels get chat through StreamElements only
  if (bot)
    parts.push(
      bot.login
        ? `The PixFray bot (${bot.login}) reads chat and answers commands; StreamElements stays quiet while it's connected. Type /mod ${bot.login} in your chat so it can answer more than one command a second.`
        : "Sign in the PixFray bot account at /auth/login?bot=1, then click Connect chat.",
    );
  if (bot?.login && bot.debug)
    parts.push(
      `Debug: challenge @${bot.login} and it fights back, !fray spar makes it challenge you, and !fray e2e (you or a mod) plays every command once and posts which passed.`,
    );
  // as above
  if (S.admin!.seOnly)
    parts.push("This site takes chat from StreamElements only; the first StreamElements command connects it.");
  else if (!c.connected) parts.push("Duels stay paused until chat is connected.");
  // as above; element type from the page HTML
  $<HTMLDivElement>("#chat-actions").hidden = !!S.admin!.seOnly;
  // as above; element type from the page HTML
  if (S.admin!.seOnly) $<HTMLDivElement>("#owner-chat").hidden = true;
  $<HTMLParagraphElement>("#chat-text").textContent = parts.join(" ");
  // as above
  renderBotHealth(bot && c.source === "twitch" ? S.admin!.botStatus : null);
  $<HTMLButtonElement>("#connect-chat").textContent = c.connected ? "Reconnect chat" : "Connect chat";
  $<HTMLButtonElement>("#disconnect-chat").disabled = !c.subscriptionId && !c.connected;
}
// The PixFray bot's health (server/channel.ts botStatus): what it last heard and sent, and the last reply Twitch dropped
// or the room held back. A drop newer than the last sent reply is a warning: the bot may be failing right now.
const HELD_TEXT: Record<string, string | undefined> = {
  reply_limit: "the cap of 18 replies per 30 seconds",
  cooldown: "a command cooldown",
  unknown_subscription: "a line from an old chat subscription",
};
function renderBotHealth(b: BotStatus | null | undefined) {
  const box = $<HTMLParagraphElement>("#bot-health");
  box.hidden = !b;
  if (!b) return;
  const failing = b.failedAt > b.sentAt;
  const parts = [
    b.heardAt
      ? `Bot: last command ${timeAgo(b.heardAt)} (${b.heard}), last reply sent ${timeAgo(b.sentAt)}. ${b.sent} sent, ${b.failed} dropped.`
      : "Bot: no commands heard yet.",
  ];
  if (b.failedAt)
    parts.push(
      (failing ? "The last reply was dropped " : "Last dropped reply ") +
        timeAgo(b.failedAt) +
        ": " +
        b.failedText +
        ".",
    );
  if (b.heldAt)
    parts.push("Last held back " + timeAgo(b.heldAt) + ": " + (HELD_TEXT[b.heldReason] || b.heldReason) + ".");
  parts.push("Type !fray debug in chat for the same check.");
  box.textContent = parts.join(" ");
  box.className = "small" + (failing ? " callout warning" : "");
}
async function chatAct(
  action: string,
  button: HTMLButtonElement,
  takeover = false,
  status = $<HTMLParagraphElement>("#chat-status"),
) {
  if (
    action === "disconnectChat" &&
    !confirm("Disconnect Twitch chat? Duels pause and open duels are cancelled without scoring.")
  )
    return;
  button.disabled = true;
  setStatus(status, action === "connectChat" ? "Asking Twitch for a chat subscription…" : "Disconnecting…");
  const r = await api("/api/admin/" + CHANNEL, {
    method: "POST",
    body: takeover ? { action, takeover: true } : { action },
  });
  button.disabled = false;
  // One Twitch app serves both sites, and Twitch allows one chat subscription per channel: offer to move it here.
  if (
    r.status === 409 &&
    r.data?.connectedElsewhere &&
    !takeover &&
    mayBroadcast() &&
    confirm(
      "Chat is connected to " +
        r.data.connectedElsewhere +
        ". Only one site can receive chat at a time. Move chat to this site? The other site pauses.",
    )
  )
    return chatAct(action, button, true, status);
  if (!r.ok) {
    const fix = r.data?.reconnect
      ? // S.access!: init() confirmed access before any chat button shows
        S.access!.owner
        ? " Use Reconnect Twitch below."
        : " Ask " + site.owner.login + " to reconnect Twitch."
      : "";
    return setStatus(status, "That didn't work: " + errorText(r) + fix, "error");
  }
  verifying = action === "connectChat" && !r.data?.chatStatus?.connected;
  setStatus(
    status,
    action === "disconnectChat"
      ? "Chat disconnected. Duels are paused."
      : verifying
        ? "Subscription created. Twitch is checking the connection; this updates when it's done."
        : "Chat connected. Duels are live.",
    "ok",
  );
  await load();
}
$<HTMLButtonElement>("#connect-chat").addEventListener("click", (e) =>
  // the listener sits on this button
  chatAct("connectChat", e.currentTarget as HTMLButtonElement),
);
$<HTMLButtonElement>("#summary-connect").addEventListener("click", (e) =>
  // the listener sits on this button; element type from the page HTML
  chatAct("connectChat", e.currentTarget as HTMLButtonElement, false, $<HTMLParagraphElement>("#summary-status")),
);
$<HTMLButtonElement>("#disconnect-chat").addEventListener("click", (e) =>
  // the listener sits on this button
  chatAct("disconnectChat", e.currentTarget as HTMLButtonElement),
);

// ---------- StreamElements ----------
const SE_LABELS: Record<string, string | undefined> = {
  challenge: "Challenge @viewer",
  accept: "Accept a challenge",
  decline: "Decline a challenge",
  rematch: "Rematch the last rival",
  top: "Top 5 by Elo",
  elo: "Own Elo, or @viewer's",
  help: "How to play",
  look: "Link to change your look",
  pet: "Own pet, or @viewer's",
  stats: "Own stats, or @viewer's",
  changelog: "What changed in PixFray",
  checkin: "Daily check-in",
  wallet: "Wallet",
  give: "Give dollars",
  attack: "Default ability",
  strike: "Strike",
  heavy: "Heavy strike",
  heal: "Heal",
};
function renderSe() {
  // S.admin!: called from renderAll
  const se = S.admin!.streamelements,
    // as above
    c: ChatStatus = S.admin!.chatStatus || {};
  const using = c.connected && c.source === "streamelements",
    twitch = c.connected && c.source === "twitch";
  $<HTMLButtonElement>("#use-se").textContent = using ? "StreamElements is the chat source" : "Use StreamElements";
  $<HTMLButtonElement>("#use-se").disabled = using || !se;
  $<HTMLButtonElement>("#copy-timer").disabled = !se;
  // Test and production each have their own key, so commands copied from the other site never arrive here.
  const health = $<HTMLParagraphElement>("#se-health"),
    host = se?.origin ? new URL(se.origin).host : location.host;
  let warn = "",
    note = "";
  if (se && !twitch && !se.lastCommandAt && !using)
    note =
      "No StreamElements command has reached " +
      host +
      " yet. Add the commands from the table below, then type " +
      (se.names?.decline || "!decline") +
      " in chat to test.";
  else if (se && using && !se.lastCommandAt)
    warn =
      "No StreamElements command has reached " +
      host +
      " with this key yet. If the replies in StreamElements were copied from another site, such as the test site, copy every reply again from the table below (they point at " +
      host +
      "), paste them into StreamElements, then type " +
      (se.names?.decline || "!decline") +
      " in chat to test.";
  else if (se && se.rejectedAt > se.lastCommandAt)
    warn =
      "A StreamElements command arrived " +
      timeAgo(se.rejectedAt) +
      " with an old key and was refused. Copy every reply again from the table below and paste it into StreamElements.";
  else if (se?.lastCommandAt)
    note = "Last StreamElements command reached " + host + " " + timeAgo(se.lastCommandAt) + ".";
  health.hidden = !(warn || note);
  health.className = warn
    ? // se!: a warning is set only when se is
      "callout warning small" + (se!.rejectedAt > se!.lastCommandAt ? " negative" : "")
    : "small muted";
  health.textContent = warn || note;
  $<HTMLDivElement>("#se-setup").hidden = !se; // no key on this site: an empty table and dead buttons only confuse
  if (!se) return;
  const tbody = $<HTMLTableSectionElement>("#se-table tbody");
  if (tbody.dataset.key !== se.key || !tbody.children.length) drawSeTable(se, tbody); // otherwise keep unsaved name edits
  // the data-seen cells are tds
  for (const cell of tbody.querySelectorAll<HTMLTableCellElement>("[data-seen]")) {
    // the selector only matches cells with data-seen
    const at = se.seen?.[cell.dataset.seen!];
    cell.replaceChildren(
      h("span", { class: at ? "badge positive" : "badge" }, at ? "Working · " + timeAgo(at) : "Not used yet"),
    );
  }
}
function drawSeTable(se: Se, tbody: HTMLElement) {
  tbody.dataset.key = se.key;
  tbody.replaceChildren(
    ...se.commands.map((cmd) => {
      const tr = document.createElement("tr");
      const label = document.createElement("td");
      label.textContent = SE_LABELS[cmd.action] || cmd.action;
      const nameCell = document.createElement("td"),
        input = document.createElement("input");
      Object.assign(input, { value: cmd.name, name: "se-" + cmd.action, maxLength: 25, spellcheck: false });
      input.setAttribute("aria-label", "Command name for " + (SE_LABELS[cmd.action] || cmd.action));
      input.dataset.action = cmd.action;
      nameCell.append(input);
      // The cell shows where the command points but not the key, so the page is safe to show on stream; Copy reply copies the whole line.
      const reply = document.createElement("td"),
        code = document.createElement("code"),
        copy = document.createElement("button");
      code.textContent = cmd.response.replace(/https?:\/\/[^/]+/, "").replace(/\?k=.*$/, "?k=…)");
      code.className = "reply-preview";
      Object.assign(copy, { type: "button", className: "btn btn-small", textContent: "Copy reply" });
      copy.setAttribute("aria-label", "Copy reply for " + cmd.name);
      copy.addEventListener("click", () =>
        copyText(
          cmd.response,
          $<HTMLParagraphElement>("#se-status"),
          "Copied the reply for " + input.value + ". Paste it as the response of that StreamElements command.",
        ),
      );
      reply.append(copy, " ", code);
      const seen = document.createElement("td");
      seen.dataset.seen = cmd.action;
      tr.append(label, nameCell, seen, reply);
      return tr;
    }),
  );
}
// Copy to the clipboard; when the browser blocks it (no permission, or not focused), show the text in a box to copy by hand.
async function copyText(text: string, status: Element, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    return setStatus(status, done, "ok");
  } catch {
    prompt("Your browser blocked copying. Copy this with Ctrl+C:", text);
  }
  setStatus(status, "Your browser blocked copying, so the text opened in a box to copy by hand.", "warning");
}
async function seAct(body: Record<string, unknown>, button: HTMLButtonElement, done: string) {
  button.disabled = true;
  const r = await api("/api/admin/" + CHANNEL, { method: "POST", body });
  button.disabled = false;
  if (!r.ok) return setStatus($<HTMLParagraphElement>("#se-status"), "That didn't work: " + errorText(r), "error");
  setStatus($<HTMLParagraphElement>("#se-status"), done, "ok");
  $<HTMLTableSectionElement>("#se-table tbody").dataset.key = "";
  await load();
}
$<HTMLButtonElement>("#use-se").addEventListener("click", (e) => {
  // S.admin!: init() keeps the gate up until load() fills S.admin, and a failed reload keeps the old value
  const c: ChatStatus = S.admin!.chatStatus || {};
  if (
    c.connected &&
    c.source === "twitch" &&
    !confirm(
      "Switch from Twitch chat to StreamElements? Open duels are not affected, but chat messages without a command stop reaching the arena.",
    )
  )
    return;
  seAct(
    { action: "useStreamElements" },
    // the listener sits on this button
    e.currentTarget as HTMLButtonElement,
    "StreamElements is now the chat source. Duels are live.",
  );
});
$<HTMLButtonElement>("#save-se-names").addEventListener("click", (e) => {
  const names = Object.fromEntries(
    // the selector matches inputs
    [...document.querySelectorAll<HTMLInputElement>("#se-table input")].map((i) => [i.dataset.action, i.value.trim()]),
  );
  seAct(
    { action: "setSeNames", names },
    // the listener sits on this button
    e.currentTarget as HTMLButtonElement,
    "Names saved. Update the command names in StreamElements to match.",
  );
});
$<HTMLButtonElement>("#copy-timer").addEventListener("click", async () => {
  const text = S.admin?.streamelements?.timerText;
  if (!text) return;
  await copyText(
    text,
    $<HTMLParagraphElement>("#se-status"),
    "Copied the timer message. Paste it as the message of a StreamElements timer.",
  );
});
$<HTMLButtonElement>("#rotate-se").addEventListener("click", (e) => {
  if (!confirm("Make a new key? Every StreamElements command stops working until you paste the new replies.")) return;
  seAct(
    { action: "rotateSeKey" },
    // the listener sits on this button
    e.currentTarget as HTMLButtonElement,
    "New key made. Copy every reply again into StreamElements.",
  );
});

// ---------- setup checklist ----------
// Each step has a live state from /api/admin; the Live tab points at the first unfinished one.
// Sites with the PixFray bot (chatBot) ask for the bot instead of the StreamElements steps; a channel that still takes
// chat from StreamElements keeps those steps and gets the bot as an optional switch.
const DUEL_ACTIONS = ["challenge", "accept", "decline"];
function setupSteps(): { id: string; done: boolean | undefined; optional?: boolean | undefined; next?: string }[] {
  // S.admin!: called from renderChecklist and the timer's S.admin check
  const a = S.admin!,
    se = a.streamelements,
    seen: Record<string, number> = se?.seen || {},
    c: ChatStatus = a.chatStatus || {};
  const twitch = c.connected && c.source === "twitch"; // Twitch chat directly: the StreamElements steps don't apply
  const viaSe = c.connected && c.source === "streamelements",
    seSteps = !a.chatBot || viaSe;
  return [
    { id: "check-overlay", done: (a.overlays || 0) > 0, next: "open the overlay in OBS" },
    ...(a.chatBot
      ? [{ id: "check-bot", done: twitch, optional: viaSe, next: "add the PixFray bot to your chat" }]
      : []),
    ...(seSteps
      ? [
          { id: "check-duel", done: twitch || !!se?.duelModuleOff, next: "turn off the StreamElements Duel module" },
          {
            id: "check-commands",
            done: twitch || (!!se && DUEL_ACTIONS.every((x) => seen[x])),
            next: "test the commands in chat",
          },
        ]
      : []),
    { id: "check-mods", done: !!a.modsReady && !a.modsLapsed, optional: true },
  ];
}
const broadcasterHere = () => !!S.access?.broadcaster || (!!S.access?.owner && CHANNEL === site.defaultChannel);
// The bot step: the broadcaster allows the bot on Twitch (connect=bot) and comes back connected; a mod or the site owner
// can connect it only once the broadcaster allowed it or made the bot a moderator.
function renderBotStep(done: boolean | undefined) {
  // S.admin!: called from renderChecklist
  const a = S.admin!,
    bot = a.chatBot,
    c: ChatStatus = a.chatStatus || {},
    login = bot?.login || "";
  const detail = $<HTMLParagraphElement>("#check-bot [data-detail]"),
    actions = $<HTMLDivElement>("#bot-actions");
  if (!login) {
    detail.textContent =
      "The PixFray bot account isn't signed in on this site yet. " +
      (S.access?.owner ? "Sign it in, then come back and add it." : "Ask " + site.owner.login + " to sign it in.");
    actions.replaceChildren(
      ...(S.access?.owner ? [h("a", { class: "btn", href: "/auth/login?bot=1" }, "Sign in the bot account")] : []),
    );
    return;
  }
  const heard = a.botStatus?.heardAt
    ? " It last answered a command " + timeAgo(a.botStatus.heardAt) + "."
    : " Type !fray in your chat to test it.";
  if (done && a.config?.botEnabled === false) {
    detail.textContent =
      "The PixFray bot (" +
      login +
      ") is turned off: it ignores every command and posts nothing. Type !fray on in your chat, or turn on Bot answers commands under Rules, Chat bot.";
    actions.replaceChildren();
    return;
  }
  if (done) {
    detail.textContent =
      "The PixFray bot (" +
      login +
      ") reads your chat and answers the duel commands." +
      heard +
      " Type /mod " +
      login +
      " in your chat so it can answer more than one command a second.";
    actions.replaceChildren();
    return;
  }
  const se =
    c.connected && c.source === "streamelements"
      ? " Your chat comes through StreamElements now; the bot takes over and StreamElements stops answering PixFray commands."
      : "";
  if (broadcasterHere()) {
    detail.textContent =
      "The bot (" +
      login +
      ") reads your chat and answers !challenge, !fight and the other commands. Twitch asks you to allow it, then chat connects here." +
      se;
    actions.replaceChildren(
      h(
        "a",
        {
          class: "btn",
          "data-step-action": "",
          href: "/auth/login?" + new URLSearchParams({ channel: CHANNEL, connect: "bot" }),
        },
        "Add the PixFray bot",
      ),
    );
  } else {
    detail.textContent =
      "Ask " +
      CHANNEL +
      " to open this page and click Add the PixFray bot, or to type /mod " +
      login +
      " in their chat. Then Connect chat works for you too." +
      se;
    actions.replaceChildren(
      h(
        "button",
        {
          class: "btn",
          type: "button",
          "data-step-action": "",
          onclick: (e: Event) =>
            chatAct(
              "connectChat",
              // the handler sits on this button
              e.currentTarget as HTMLButtonElement,
              false,
              $<HTMLParagraphElement>("#bot-status"),
            ),
        },
        "Connect chat",
      ),
    );
  }
}
function renderChecklist() {
  // S.admin!: called from renderAll
  const a = S.admin!,
    se = a.streamelements,
    c: ChatStatus = a.chatStatus || {},
    twitch = c.connected && c.source === "twitch";
  const steps = setupSteps(),
    required = steps.filter((s) => !s.optional),
    done = required.filter((s) => s.done).length;
  // the selector matches list items
  for (const li of document.querySelectorAll<HTMLLIElement>("#checklist > li"))
    li.hidden = !steps.some((s) => s.id === li.id);
  for (const s of steps) {
    // each step id is an li on the page that holds a badge span
    const li = $<HTMLLIElement>("#" + s.id),
      badge = $<HTMLSpanElement>("[data-badge]", li);
    badge.textContent = s.done ? "Done" : s.optional ? "Optional" : "To do";
    badge.className = "badge" + (s.done ? " positive" : s.optional ? "" : " warning");
  }
  const detail = (id: string, text: string) => {
    // each step holds a detail paragraph
    $<HTMLParagraphElement>("#" + id + " [data-detail]").textContent = text;
  };
  const n = a.overlays || 0;
  detail(
    "check-overlay",
    n
      ? n + " overlay" + (n === 1 ? " is" : "s are") + " connected right now."
      : "No overlay is open right now. It turns Done while OBS shows the overlay.",
  );
  const box = $<HTMLInputElement>("#duel-module-off");
  if (document.activeElement !== box) box.checked = !!se?.duelModuleOff;
  box.disabled = !se;
  if (twitch) detail("check-commands", "Twitch chat is connected directly, so StreamElements commands aren't needed.");
  else if (!se) detail("check-commands", "StreamElements isn't available for this channel.");
  else {
    const missing = se.commands.filter((x) => !se.seen?.[x.action]);
    detail(
      "check-commands",
      se.commands.length -
        missing.length +
        " of " +
        se.commands.length +
        " commands have reached PixFray." +
        (missing.length
          ? " Not used yet: " +
            missing.map((x) => x.name).join(", ") +
            ". Type each one in your chat; any reply from the bot counts."
          : ""),
    );
  }
  if (a.chatBot) renderBotStep(twitch);
  $<HTMLParagraphElement>("#check-mods [data-detail]").replaceChildren(...modsDetail());
  if (a.modsLapsed && !a.modsReady) {
    const b = $<HTMLSpanElement>("#check-mods [data-badge]");
    b.textContent = "Expired";
    b.className = "badge warning";
  }
  $<HTMLHeadingElement>("#check-title").textContent =
    done === required.length
      ? "Stream setup is done"
      : "Stream setup: " + done + " of " + required.length + " steps done";
  const next = required.find((s) => !s.done),
    pointer = $<HTMLParagraphElement>("#setup-next");
  // one primary button: the bot step's while it's the next step, otherwise Copy link
  const stepAction = $("#bot-actions [data-step-action]"),
    botNext = !!stepAction && next?.id === "check-bot";
  stepAction?.classList.toggle("btn-primary", botNext);
  $<HTMLButtonElement>("#copy").classList.toggle("btn-primary", !botNext);
  pointer.hidden = !next;
  if (next)
    pointer.replaceChildren(
      "Stream setup: " + done + " of " + required.length + " steps done. Next: ",
      h(
        "a",
        {
          href: "#chat",
          onclick: (e: Event) => {
            e.preventDefault();
            goToStep(next.id);
          },
        },
        next.next,
      ),
      ".",
    );
}
// Step 4 reads differently for the broadcaster (who can connect), the site owner looking at another channel, and a moderator.
function modsDetail() {
  // S.admin!: called from renderChecklist
  const a = S.admin!,
    ready = !!a.modsReady && !a.modsLapsed,
    lapsed = !!a.modsLapsed;
  if (ready) return ["Twitch moderators of " + CHANNEL + " can sign in and use this page."];
  if (broadcasterHere()) {
    const link = h(
      "a",
      { href: "/auth/login?" + new URLSearchParams({ channel: CHANNEL, connect: "mods" }) },
      lapsed ? "Reconnect mod access" : "Connect mod access",
    );
    return [
      lapsed
        ? "Mod access expired, so your Twitch moderators can't sign in until you reconnect it. "
        : "Your Twitch moderators can't sign in yet. PixFray needs permission to read your moderator list. ",
      link,
    ];
  }
  const state = lapsed ? "Mod access expired" : "Mod access isn't connected";
  return [
    state +
      ". " +
      (S.access?.owner
        ? CHANNEL + " has to " + (lapsed ? "reconnect" : "connect") + " it from their own Stream setup page."
        : "Ask " + CHANNEL + " to " + (lapsed ? "reconnect" : "connect") + " it."),
  ];
}
function goToStep(id: string) {
  selectTab($<HTMLButtonElement>("#tab-chat"));
  // each step id is an li on the page
  const li = $<HTMLLIElement>("#" + id);
  li.scrollIntoView({ block: "center" });
  li.focus({ preventScroll: true });
}
$<HTMLInputElement>("#duel-module-off").addEventListener("change", async (e) => {
  // the listener sits on this checkbox
  const box = e.currentTarget as HTMLInputElement;
  box.disabled = true;
  const r = await api("/api/admin/" + CHANNEL, {
    method: "POST",
    body: { action: "setDuelModuleOff", value: box.checked },
  });
  box.disabled = false;
  if (!r.ok) {
    box.checked = !box.checked;
    return setStatus($<HTMLParagraphElement>("#check-status"), "Couldn't save: " + errorText(r) + ".", "error");
  }
  setStatus(
    $<HTMLParagraphElement>("#check-status"),
    box.checked ? "Saved: the Duel module is off." : "Saved: the Duel module step is open again.",
    "ok",
  );
  await load();
});
// ---------- check-in test mode: !checkin answers while offline for 15 minutes, saving nothing ----------
function renderCheckinTest() {
  // S.admin!: called from renderAll and the toggle below; element type from the page HTML
  $("#checkin-test").hidden = !S.admin!.checkinTestAllowed;
  // as above
  const t = S.admin!.checkinTest,
    on = !!t && t.until > Date.now();
  $<HTMLHeadingElement>("#checkin-test-title").textContent = on
    ? "!checkin test mode is on"
    : "Test !checkin while offline";
  $<HTMLParagraphElement>("#checkin-test-text").replaceChildren(
    on
      ? "Until " +
          new Date(t.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) +
          (t.by ? " (turned on by " + t.by + ")" : "") +
          ", "
      : "For 15 minutes, ",
    h("code", {}, "!checkin"),
    on
      ? " answers while the stream is offline with a reply that starts [Test, not saved]. Nothing is saved: no points, no streak. While the stream is live, check-ins count as usual."
      : " answers while the stream is offline and shows what a viewer would get. Nothing is saved: no points, no streak.",
  );
  $<HTMLButtonElement>("#checkin-test-toggle").textContent = on
    ? "Turn test mode off"
    : "Turn on test mode for 15 minutes";
}
$<HTMLButtonElement>("#checkin-test-toggle").addEventListener("click", async (e) => {
  // the listener sits on this button; S.admin!: init() keeps the gate up until load() fills S.admin, and a failed reload keeps the old value
  const button = e.currentTarget as HTMLButtonElement,
    // as above
    on = !(S.admin!.checkinTest && S.admin!.checkinTest.until > Date.now());
  button.disabled = true;
  const r = await api("/api/admin/" + CHANNEL, { method: "POST", body: { action: "checkinTest", value: on } });
  button.disabled = false;
  if (!r.ok)
    return setStatus(
      $<HTMLParagraphElement>("#checkin-test-status"),
      "Couldn't change it: " + errorText(r) + ".",
      "error",
    );
  // S.admin!: as above
  S.admin!.checkinTest = r.data.checkinTest;
  renderCheckinTest();
  setStatus(
    $<HTMLParagraphElement>("#checkin-test-status"),
    on ? "Test mode is on. Type !checkin in chat to try it." : "Test mode is off.",
    "ok",
  );
});

// ---------- the bot's own text commands (server/botcommands.ts), shown while the PixFray bot reads chat ----------
let editingCommand = "",
  shownCommands = "";
const COMMAND_ERRORS: Record<string, string | undefined> = {
  command_name_taken: "PixFray already uses that name",
  command_exists: "that command already exists; edit it in the table",
  invalid_command_name: "use 1 to 24 letters, digits or _",
  empty_command_reply: "type a reply",
  command_reply_too_long: "keep the reply under 400 characters",
  too_many_commands: "a channel can have 50 commands",
};
function renderBotCommands() {
  // S.admin!: called from renderAll and commandAction, after load()
  const a = S.admin!,
    chat: ChatStatus = a.chatStatus || a.chat || {},
    data: BotCommands = a.botCommands || { commands: [], counters: [] };
  $("#bot-commands").hidden = !(a.chatBot && chat.connected === true && chat.source !== "streamelements");
  const key = JSON.stringify(data);
  if (
    key === shownCommands ||
    ($("#bot-commands").contains(document.activeElement) &&
      // activeElement!: contains() just found it inside the section
      document.activeElement!.tagName === "INPUT" &&
      // as above
      document.activeElement!.closest("#bot-counters"))
  )
    return;
  shownCommands = key;
  $<HTMLTableSectionElement>("#bot-commands-table tbody").replaceChildren(
    ...(data.commands.length
      ? data.commands.map((c) =>
          h(
            "tr",
            {},
            h("td", {}, h("code", {}, c.name)),
            h("td", {}, c.reply),
            h(
              "td",
              {},
              h(
                "button",
                { class: "btn btn-small", type: "button", "data-edit": c.name, "aria-label": "Edit " + c.name },
                "Edit",
              ),
              " ",
              h(
                "button",
                {
                  class: "btn btn-small btn-danger",
                  type: "button",
                  "data-delete": c.name,
                  "aria-label": "Delete " + c.name,
                },
                "Delete",
              ),
            ),
          ),
        )
      : [h("tr", {}, h("td", { colspan: "3", class: "muted" }, "No commands yet. Add one below."))]),
  );
  $<HTMLDivElement>("#bot-counters").hidden = !data.counters.length;
  $<HTMLTableSectionElement>("#bot-counters-table tbody").replaceChildren(
    ...data.counters.map((c) =>
      h(
        "tr",
        {},
        h("td", {}, h("code", {}, c.name)),
        h(
          "td",
          { class: "num" },
          h("input", {
            type: "number",
            min: "0",
            max: "1000000000",
            step: "1",
            inputmode: "numeric",
            value: String(c.value),
            "aria-label": "Value of " + c.name,
            "data-counter": c.name,
          }),
        ),
        h(
          "td",
          {},
          h(
            "button",
            { class: "btn btn-small", type: "button", "data-save-counter": c.name, "aria-label": "Save " + c.name },
            "Save",
          ),
        ),
      ),
    ),
  );
}
function editCommand(name: string | undefined) {
  // S.admin!: the commands section shows only after renderBotCommands ran
  const c = (S.admin!.botCommands?.commands || []).find((x) => x.name === name);
  editingCommand = c ? c.name : "";
  $<HTMLInputElement>("#command-name").value = c ? c.name : "";
  $<HTMLInputElement>("#command-reply").value = c ? c.reply : "";
  $<HTMLButtonElement>("#command-save").textContent = c ? "Save changes" : "Add command";
  $<HTMLButtonElement>("#command-cancel").hidden = !c;
  if (c) $<HTMLInputElement>("#command-reply").focus();
}
async function commandAction(action: string, payload: Record<string, unknown>, status: Element) {
  const r = await api("/api/admin/" + CHANNEL, { method: "POST", body: { action, payload } });
  if (!r.ok) {
    setStatus(status, "Couldn't save: " + (COMMAND_ERRORS[r.data?.error] || errorText(r)) + ".", "error");
    return false;
  }
  // S.admin!: as in editCommand
  S.admin!.botCommands = r.data.botCommands;
  renderBotCommands();
  return r.data;
}
$<HTMLFormElement>("#command-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $<HTMLParagraphElement>("#command-status"),
    name = $<HTMLInputElement>("#command-name").value.trim().toLowerCase().replace(/^!?/, "!"),
    reply = $<HTMLInputElement>("#command-reply").value.trim();
  if (!/^![a-z0-9_]{1,24}$/.test(name))
    return setStatus(status, "Name the command with 1 to 24 letters, digits or _, like !sens.", "error");
  if (!reply) return setStatus(status, "Type the reply the bot should send.", "error");
  $<HTMLButtonElement>("#command-save").disabled = true;
  setStatus(status, "Saving…");
  const was = editingCommand,
    saved = await commandAction("saveCommand", { name, reply, ...(was ? { oldName: was } : {}) }, status);
  $<HTMLButtonElement>("#command-save").disabled = false;
  if (!saved) return;
  editCommand("");
  if (saved.warning === "reply_may_be_cut")
    setStatus(
      status,
      (was ? "Saved " : "Added ") +
        name +
        ". With long names or counters it can reach " +
        saved.longest +
        " characters, so the bot cuts it at " +
        saved.max +
        ".",
      "warning",
    );
  else setStatus(status, (was ? "Saved " : "Added ") + name + ". Type it in chat to try it.", "ok");
});
$<HTMLButtonElement>("#command-cancel").addEventListener("click", () => {
  editCommand("");
  setStatus($<HTMLParagraphElement>("#command-status"), "");
});
$<HTMLTableElement>("#bot-commands-table").addEventListener("click", async (e) => {
  // clicks come from elements in the table; the edit and delete carriers are buttons
  const edit = (e.target as Element).closest<HTMLButtonElement>("[data-edit]"),
    // as above
    del = (e.target as Element).closest<HTMLButtonElement>("[data-delete]");
  if (edit) return editCommand(edit.dataset.edit);
  if (!del || !confirm("Delete " + del.dataset.delete + "? Its counter stays.")) return;
  del.disabled = true;
  if (await commandAction("deleteCommand", { name: del.dataset.delete }, $<HTMLParagraphElement>("#command-status"))) {
    if (editingCommand === del.dataset.delete) editCommand("");
    setStatus($<HTMLParagraphElement>("#command-status"), "Deleted " + del.dataset.delete + ".", "ok");
  } else del.disabled = false;
});
$<HTMLTableElement>("#bot-counters-table").addEventListener("click", async (e) => {
  // clicks come from elements in the table; the save carriers are buttons
  const button = (e.target as Element).closest<HTMLButtonElement>("[data-save-counter]");
  if (!button) return;
  const name = button.dataset.saveCounter,
    // each counter's Save button has its input in the same row
    value = Number($<HTMLInputElement>(`[data-counter="${name}"]`).value),
    status = $<HTMLParagraphElement>("#counter-status");
  if (!Number.isInteger(value) || value < 0 || value > 1e9)
    return setStatus(status, "Pick a whole number from 0 to 1000000000.", "error");
  button.disabled = true;
  if (await commandAction("setCounter", { name, value }, status))
    setStatus(status, "Counter " + name + " is " + value + " now.", "ok");
  else button.disabled = false;
});

// ---------- channel point rewards (server/points.ts; the broadcaster or the owner adds and deletes, mods read) ----------
const POINT_OUTCOMES: Record<string, string | undefined> = {
  granted: "Style dollars added",
  refunded: "No saved fighter, points refunded",
  no_fighter: "No saved fighter, not refunded",
  ignored: "Not a PixFray reward",
};
const POINT_ERRORS: Record<string, string | undefined> = {
  invalid_title: "Name the reward with 1 to 45 characters",
  invalid_cost: "Pick a cost from 1 to 1000000 channel points",
  invalid_dollars: "Pick 1 to 10000 dollars",
  points_max_rewards: "A channel can have 5 PixFray rewards. Delete one first",
  points_not_connected: "Twitch needs the channel point permission again. Use Allow channel point rewards",
  reward_not_found: "That reward is already gone",
};
let shownPoints = "";
function renderPoints() {
  // S.admin!: called from renderAll and pointsAction, after load()
  const a = S.admin!,
    p: PointsPanel | undefined = a.points,
    section = $("#points");
  section.hidden = !p;
  if (!p) return;
  const rewards = Array.isArray(p.rewards) ? p.rewards : [],
    redemptions = Array.isArray(p.redemptions) ? p.redemptions : [],
    max = p.limits?.maxRewards || 5,
    owner = mayBroadcast(),
    ready = !!a.pointsReady;
  // only the broadcaster's own Twitch account can grant the permission, so the site owner elsewhere gets the note instead
  $<HTMLDivElement>("#points-connect").hidden = ready || !broadcasterHere();
  $<HTMLParagraphElement>("#points-connect-text").textContent = rewards.length
    ? "Twitch no longer lets PixFray manage these rewards. Allow it again so redemptions add dollars and refunds work."
    : "First let PixFray make rewards on your channel. Twitch asks for one more permission, then you come back here.";
  $<HTMLAnchorElement>("#points-login").href = a.pointsLogin || "#";
  $<HTMLFormElement>("#points-form").hidden = !(owner && ready);
  $<HTMLButtonElement>("#points-add").disabled = rewards.length >= max;
  $<HTMLParagraphElement>("#points-note").textContent = !owner
    ? "Only " + CHANNEL + " can add or delete rewards." + (ready ? "" : " Channel point rewards aren't allowed yet.")
    : !ready && !broadcasterHere()
      ? CHANNEL + " has to allow channel point rewards, signed in to Twitch as themself."
      : ready && rewards.length >= max
        ? max + " of " + max + " rewards. Delete one to add another."
        : "";
  const key = JSON.stringify([p, owner]);
  if (key === shownPoints) return;
  shownPoints = key;
  $<HTMLTableSectionElement>("#points-table tbody").replaceChildren(
    ...(rewards.length
      ? rewards.map((r) =>
          h(
            "tr",
            {},
            h("td", {}, r.title),
            h("td", { class: "num" }, r.cost.toLocaleString("en-US")),
            h("td", { class: "num" }, "$" + r.dollars.toLocaleString("en-US")),
            h(
              "td",
              {},
              owner
                ? h(
                    "button",
                    {
                      class: "btn btn-small btn-danger",
                      type: "button",
                      "data-reward": r.rewardId,
                      "data-title": r.title,
                      "aria-label": "Delete " + r.title,
                    },
                    "Delete",
                  )
                : "",
            ),
          ),
        )
      : [h("tr", {}, h("td", { colspan: "4", class: "muted" }, "No rewards yet."))]),
  );
  const titles = new Map(rewards.map((r) => [r.rewardId, r.title]));
  $<HTMLTableSectionElement>("#points-redemptions tbody").replaceChildren(
    ...(redemptions.length
      ? redemptions.map((x) => {
          // marked: 0 until Twitch answers, -1 when PixFray leaves it alone, else Twitch's HTTP status (1: no answer)
          const unmarked = x.marked > 0 && (x.marked < 200 || x.marked > 299);
          return h(
            "tr",
            {},
            h("td", {}, dateTime(x.at)),
            h("td", {}, x.user),
            h("td", {}, titles.get(x.rewardId) || "A deleted reward"),
            h(
              "td",
              {},
              (POINT_OUTCOMES[x.outcome] || x.outcome) +
                (unmarked ? ". Twitch's request queue wasn't updated, so check it there" : ""),
            ),
            h("td", { class: "num" }, x.dollars ? "$" + x.dollars.toLocaleString("en-US") : "0"),
          );
        })
      : [h("tr", {}, h("td", { colspan: "5", class: "muted" }, "No redemptions yet."))]),
  );
}
async function pointsAction(action: string, payload: Record<string, unknown>) {
  const status = $<HTMLParagraphElement>("#points-status");
  setStatus(status, "Working…");
  const r = await api("/api/admin/" + CHANNEL, { method: "POST", body: { action, payload } });
  if (!r.ok) {
    setStatus(status, "That didn't work: " + (POINT_ERRORS[r.data?.reason] || errorText(r)) + ".", "error");
    if (r.data?.reason === "points_not_connected") await load();
    return false;
  }
  // S.admin!: the section shows only after load()
  S.admin!.points = { rewards: r.data.rewards, redemptions: r.data.redemptions, limits: r.data.limits };
  renderPoints();
  return true;
}
$<HTMLFormElement>("#points-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $<HTMLParagraphElement>("#points-status"),
    title = $<HTMLInputElement>("#points-title-input").value.trim(),
    cost = Number($<HTMLInputElement>("#points-cost").value),
    dollars = Number($<HTMLInputElement>("#points-dollars").value),
    button = $<HTMLButtonElement>("#points-add");
  if (!title || title.length > 45) return setStatus(status, POINT_ERRORS.invalid_title + ".", "error");
  if (!Number.isInteger(cost) || cost < 1 || cost > 1e6)
    return setStatus(status, POINT_ERRORS.invalid_cost + ".", "error");
  if (!Number.isInteger(dollars) || dollars < 1 || dollars > 1e4)
    return setStatus(status, POINT_ERRORS.invalid_dollars + ".", "error");
  button.disabled = true;
  const ok = await pointsAction("createPointReward", { title, cost, dollars });
  button.disabled = false;
  renderPoints();
  if (!ok) return;
  $<HTMLFormElement>("#points-form").reset();
  setStatus(status, "Added " + title + ". It shows under channel points on Twitch now.", "ok");
});
$<HTMLTableElement>("#points-table").addEventListener("click", async (e) => {
  // clicks come from elements in the table; the delete carriers are buttons
  const del = (e.target as Element).closest<HTMLButtonElement>("[data-reward]");
  if (!del || !confirm("Delete " + del.dataset.title + "? It disappears from Twitch too. Dollars already added stay."))
    return;
  del.disabled = true;
  if (await pointsAction("deletePointReward", { rewardId: del.dataset.reward }))
    setStatus($<HTMLParagraphElement>("#points-status"), "Deleted " + del.dataset.title + ".", "ok");
  else del.disabled = false;
});

// ---------- turning PixFray off (signed-up channels; the broadcaster or the owner, and only the owner undoes the owner's off) ----------
const mayBroadcast = () => !!(S.access?.broadcaster || S.access?.owner);
const mayPower = () =>
  // undefined is simply not in the list, as before
  !!(S.access?.broadcaster || S.access?.owner) && ["on", "paused"].includes(S.admin?.channelState as string);
function renderPower() {
  // S.admin!: called from renderAll
  const paused = S.admin!.channelState === "paused",
    toggle = $<HTMLButtonElement>("#power-toggle");
  $("#channel-power").hidden = !mayPower();
  $<HTMLHeadingElement>("#power-title").textContent = paused ? "PixFray is off on " + CHANNEL : "Turn PixFray off";
  $<HTMLParagraphElement>("#power-text").textContent = paused
    ? "The overlay, the chat commands and the viewer page are stopped. Fighters and ranks are kept, so turning it back on picks up where it left off."
    : "Stops the overlay, the chat commands and the viewer page on " +
      CHANNEL +
      ". Fighters and ranks are kept, and you can turn it back on here at any time.";
  toggle.textContent = paused ? "Turn PixFray back on" : "Turn PixFray off";
  toggle.className = paused ? "btn btn-primary" : "btn btn-danger";
  const note = $<HTMLParagraphElement>("#paused-note");
  note.hidden = !paused;
  if (paused)
    note.replaceChildren(
      "PixFray is off on " + CHANNEL + ": the overlay, the commands and the viewer page are stopped. ",
      mayPower()
        ? h(
            "a",
            {
              href: "#chat",
              onclick: (e: Event) => {
                e.preventDefault();
                selectTab($<HTMLButtonElement>("#tab-chat"));
                $("#channel-power").scrollIntoView({ block: "center" });
                toggle.focus({ preventScroll: true });
              },
            },
            "Turn it back on",
          )
        : CHANNEL + " can turn it back on.",
    );
}
$<HTMLButtonElement>("#power-toggle").addEventListener("click", async (e) => {
  // the listener sits on this button; S.admin!: the section shows only once mayPower() saw S.admin
  const button = e.currentTarget as HTMLButtonElement,
    // as above
    pause = S.admin!.channelState !== "paused";
  if (
    pause &&
    !confirm(
      "Turn PixFray off on " +
        CHANNEL +
        "? The overlay, the commands and the viewer page stop until you turn it back on. Fighters and ranks are kept.",
    )
  )
    return;
  button.disabled = true;
  const r = await api("/api/admin/" + CHANNEL, {
    method: "POST",
    body: { action: pause ? "pauseChannel" : "resumeChannel" },
  });
  button.disabled = false;
  if (!r.ok)
    return setStatus($<HTMLParagraphElement>("#power-status"), "Couldn't change it: " + errorText(r) + ".", "error");
  setStatus(
    $<HTMLParagraphElement>("#power-status"),
    pause
      ? "PixFray is off. Overlays and chat commands stop within a minute."
      : "PixFray is back on. Refresh the OBS source if the overlay stays empty.",
    "ok",
  );
  await load();
  if (!pause && !S.socket) connectLive();
});

// While setup is unfinished and on screen, refetch every 10 s so a new overlay or command turns its row to Done.
setInterval(() => {
  if (
    S.admin &&
    !document.hidden &&
    !$<HTMLDivElement>("#panel-chat").hidden &&
    setupSteps().some((s) => !s.done && !s.optional)
  )
    load();
}, 10000);

// ---------- live updates ----------
function connectLive() {
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
// Countdown text in the duels table ages; refresh it every few seconds without refetching.
setInterval(() => {
  if (S.admin && !document.hidden) renderDuels();
}, 5000);

init();
