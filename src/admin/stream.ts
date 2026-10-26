// The Stream setup tab: the chat connection, the PixFray bot's health, StreamElements commands, the setup checklist
// and check-in test mode.
import { errorText, h, $, setStatus, timeAgo, on, busy, button, CHANNEL } from "../ui.ts";
import type { BotStatus, ChatStatus, Se } from "../parse.ts";
import site from "../../site.config.js";
import { S, admin, access, mayBroadcast, broadcasterHere, post, load, selectTab } from "./state.ts";

// The chat source as the admin read saw it.
const chatOf = (): ChatStatus => admin().chatStatus || {};
const twitchChat = (c: ChatStatus) => c.connected && c.source === "twitch";

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
export function renderChat() {
  const a = admin(),
    c = chatOf();
  if (verifying && c.connected) {
    verifying = false;
    setStatus($("#chat-status"), "Chat connected. Duels are live.", "ok");
  }
  // a missing status looks up "undefined", which isn't a key, as before
  const parts = ["Status: " + (CHAT_STATUS[c.status as string] || c.status || "not connected") + "."];
  if (c.lastNotificationAt) parts.push("Last chat message " + timeAgo(c.lastNotificationAt) + ".");
  if (c.lastRevocationReason)
    parts.push("Last revocation: " + (CHAT_STATUS[c.lastRevocationReason] || c.lastRevocationReason) + ".");
  const bot = a.chatBot;
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
  if (a.seOnly)
    parts.push("This site takes chat from StreamElements only; the first StreamElements command connects it.");
  else if (!c.connected) parts.push("Duels stay paused until chat is connected.");
  $("#chat-actions").hidden = !!a.seOnly;
  if (a.seOnly) $("#owner-chat").hidden = true;
  $("#chat-text").textContent = parts.join(" ");
  renderBotHealth(bot && c.source === "twitch" ? a.botStatus : null);
  $("#connect-chat").textContent = c.connected ? "Reconnect chat" : "Connect chat";
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
  const box = $("#bot-health");
  box.hidden = !b;
  if (!b) return;
  const failing = b.failedAt > b.sentAt;
  const parts = [
    b.heardAt
      ? `Bot: last command ${timeAgo(b.heardAt)} (${b.heard}), last reply sent ${timeAgo(b.sentAt)}. ${b.sent} sent, ${b.failed} dropped.`
      : "Bot: no commands heard yet.",
  ];
  const dropped = failing ? "The last reply was dropped" : "Last dropped reply";
  if (b.failedAt) parts.push(`${dropped} ${timeAgo(b.failedAt)}: ${b.failedText}.`);
  if (b.heldAt) parts.push(`Last held back ${timeAgo(b.heldAt)}: ${HELD_TEXT[b.heldReason] || b.heldReason}.`);
  parts.push("Type !fray debug in chat for the same check.");
  box.textContent = parts.join(" ");
  box.className = "small" + (failing ? " callout warning" : "");
}
export async function chatAct(action: string, b: HTMLButtonElement, takeover = false, status = $("#chat-status")) {
  if (
    action === "disconnectChat" &&
    !confirm("Disconnect Twitch chat? Duels pause and open duels are cancelled without scoring.")
  )
    return;
  setStatus(status, action === "connectChat" ? "Asking Twitch for a chat subscription…" : "Disconnecting…");
  const r = await busy(b, () => post(takeover ? { action, takeover: true } : { action }));
  // One Twitch app serves both sites, and Twitch allows one chat subscription per channel: offer to move it here.
  const move = `Chat is connected to ${r.data?.connectedElsewhere}. Only one site can receive chat at a time.`;
  if (
    r.status === 409 &&
    r.data?.connectedElsewhere &&
    !takeover &&
    mayBroadcast() &&
    confirm(move + " Move chat to this site? The other site pauses.")
  )
    return chatAct(action, b, true, status);
  if (!r.ok) {
    const fix = r.data?.reconnect
      ? access().owner
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
on("#connect-chat", (b) => chatAct("connectChat", b));
on("#summary-connect", (b) => chatAct("connectChat", b, false, $("#summary-status")));
on("#disconnect-chat", (b) => chatAct("disconnectChat", b));

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
const seStatus = $("#se-status");
export function renderSe() {
  const se = admin().streamelements,
    c = chatOf();
  const using = c.connected && c.source === "streamelements";
  const use = $<HTMLButtonElement>("#use-se");
  use.textContent = using ? "StreamElements is the chat source" : "Use StreamElements";
  use.disabled = using || !se;
  $<HTMLButtonElement>("#copy-timer").disabled = !se;
  $("#se-setup").hidden = !se; // no key on this site: an empty table and dead buttons only confuse
  // Test and production each have their own key, so commands copied from the other site never arrive here.
  const health = $("#se-health");
  health.hidden = !se;
  if (!se) return;
  const host = se.origin ? new URL(se.origin).host : location.host,
    test = " in chat to test.",
    decline = se.names?.decline || "!decline";
  const reached = `No StreamElements command has reached ${host}`;
  let warn = "",
    note = "";
  if (!twitchChat(c) && !se.lastCommandAt && !using)
    note = `${reached} yet. Add the commands from the table below, then type ${decline}${test}`;
  else if (using && !se.lastCommandAt)
    warn =
      `${reached} with this key yet. If the replies in StreamElements were copied from another site, such as the ` +
      `test site, copy every reply again from the table below (they point at ${host}), paste them into ` +
      `StreamElements, then type ${decline}${test}`;
  else if (se.rejectedAt > se.lastCommandAt)
    warn =
      `A StreamElements command arrived ${timeAgo(se.rejectedAt)} with an old key and was refused. ` +
      "Copy every reply again from the table below and paste it into StreamElements.";
  else if (se.lastCommandAt) note = `Last StreamElements command reached ${host} ${timeAgo(se.lastCommandAt)}.`;
  health.hidden = !(warn || note);
  health.className = warn
    ? "callout warning small" + (se.rejectedAt > se.lastCommandAt ? " negative" : "")
    : "small muted";
  health.textContent = warn || note;
  const tbody = $("#se-table tbody");
  if (tbody.dataset.key !== se.key || !tbody.children.length) drawSeTable(se, tbody); // otherwise keep unsaved name edits
  for (const cell of tbody.querySelectorAll<HTMLElement>("[data-seen]")) {
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
      const label = SE_LABELS[cmd.action] || cmd.action;
      const input = h("input", {
        value: cmd.name,
        name: "se-" + cmd.action,
        maxLength: 25,
        spellcheck: "false",
        "aria-label": "Command name for " + label,
        "data-action": cmd.action,
      });
      // The cell shows where the command points but not the key, so the page is safe to show on stream; Copy reply copies the whole line.
      const msg = () => `Copied the reply for ${input.value}. Paste it as the response of that StreamElements command.`;
      const copy = button("Copy reply", () => copyText(cmd.response, seStatus, msg()), {
        "aria-label": "Copy reply for " + cmd.name,
      });
      const preview = cmd.response.replace(/https?:\/\/[^/]+/, "").replace(/\?k=.*$/, "?k=…)");
      return h(
        "tr",
        {},
        h("td", {}, label),
        h("td", {}, input),
        h("td", { "data-seen": cmd.action }),
        h("td", {}, copy, " ", h("code", { class: "reply-preview" }, preview)),
      );
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
async function seAct(body: Record<string, unknown>, b: HTMLButtonElement, done: string) {
  const r = await busy(b, () => post(body));
  if (!r.ok) return setStatus(seStatus, "That didn't work: " + errorText(r), "error");
  setStatus(seStatus, done, "ok");
  $("#se-table tbody").dataset.key = "";
  await load();
}
on("#use-se", (b) => {
  if (
    twitchChat(chatOf()) &&
    !confirm(
      "Switch from Twitch chat to StreamElements? Open duels are not affected, but chat messages without a command stop reaching the arena.",
    )
  )
    return;
  seAct({ action: "useStreamElements" }, b, "StreamElements is now the chat source. Duels are live.");
});
on("#save-se-names", (b) => {
  const names = Object.fromEntries(
    [...document.querySelectorAll<HTMLInputElement>("#se-table input")].map((i) => [i.dataset.action, i.value.trim()]),
  );
  seAct({ action: "setSeNames", names }, b, "Names saved. Update the command names in StreamElements to match.");
});
on("#copy-timer", async () => {
  const text = S.admin?.streamelements?.timerText;
  if (text)
    await copyText(text, seStatus, "Copied the timer message. Paste it as the message of a StreamElements timer.");
});
on("#rotate-se", (b) => {
  if (!confirm("Make a new key? Every StreamElements command stops working until you paste the new replies.")) return;
  seAct({ action: "rotateSeKey" }, b, "New key made. Copy every reply again into StreamElements.");
});

// ---------- setup checklist ----------
// Each step has a live state from /api/admin; the Live tab points at the first unfinished one.
// Sites with the PixFray bot (chatBot) ask for the bot instead of the StreamElements steps; a channel that still takes
// chat from StreamElements keeps those steps and gets the bot as an optional switch.
const DUEL_ACTIONS = ["challenge", "accept", "decline"];
function setupSteps(): { id: string; done: boolean | undefined; optional?: boolean | undefined; next?: string }[] {
  const a = admin(),
    se = a.streamelements,
    seen: Record<string, number> = se?.seen || {},
    c = chatOf();
  const twitch = twitchChat(c); // Twitch chat directly: the StreamElements steps don't apply
  const viaSe = c.connected && c.source === "streamelements";
  return [
    { id: "check-overlay", done: (a.overlays || 0) > 0, next: "open the overlay in OBS" },
    ...(a.chatBot
      ? [{ id: "check-bot", done: twitch, optional: viaSe, next: "add the PixFray bot to your chat" }]
      : []),
    ...(!a.chatBot || viaSe
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
const detail = (id: string, ...text: (string | Node)[]) => $("#" + id + " [data-detail]").replaceChildren(...text);
// The bot step: the broadcaster allows the bot on Twitch (connect=bot) and comes back connected; a mod or the site owner
// can connect it only once the broadcaster allowed it or made the bot a moderator.
function renderBotStep(done: boolean | undefined) {
  const a = admin(),
    login = a.chatBot?.login || "",
    actions = $("#bot-actions");
  if (!login) {
    const ask = S.access?.owner ? "Sign it in, then come back and add it." : `Ask ${site.owner.login} to sign it in.`;
    detail("check-bot", "The PixFray bot account isn't signed in on this site yet. " + ask);
    return actions.replaceChildren(
      ...(S.access?.owner ? [h("a", { class: "btn", href: "/auth/login?bot=1" }, "Sign in the bot account")] : []),
    );
  }
  const heard = a.botStatus?.heardAt
    ? " It last answered a command " + timeAgo(a.botStatus.heardAt) + "."
    : " Type !fray in your chat to test it.";
  if (done) {
    detail(
      "check-bot",
      a.config?.botEnabled === false
        ? `The PixFray bot (${login}) is turned off: it ignores every command and posts nothing. Type !fray on in ` +
            "your chat, or turn on Bot answers commands under Rules, Chat bot."
        : `The PixFray bot (${login}) reads your chat and answers the duel commands.${heard} Type /mod ${login} in ` +
            "your chat so it can answer more than one command a second.",
    );
    return actions.replaceChildren();
  }
  const se =
    chatOf().connected && chatOf().source === "streamelements"
      ? " Your chat comes through StreamElements now; the bot takes over and StreamElements stops answering PixFray commands."
      : "";
  if (broadcasterHere()) {
    detail(
      "check-bot",
      `The bot (${login}) reads your chat and answers !challenge, !fight and the other commands. ` +
        `Twitch asks you to allow it, then chat connects here.${se}`,
    );
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
    detail(
      "check-bot",
      `Ask ${CHANNEL} to open this page and click Add the PixFray bot, or to type /mod ${login} in their chat. ` +
        `Then Connect chat works for you too.${se}`,
    );
    actions.replaceChildren(
      button("Connect chat", (b) => chatAct("connectChat", b, false, $("#bot-status")), {
        class: "btn",
        "data-step-action": "",
      }),
    );
  }
}
export function renderChecklist() {
  const a = admin(),
    se = a.streamelements,
    twitch = twitchChat(chatOf());
  const steps = setupSteps(),
    required = steps.filter((s) => !s.optional),
    done = required.filter((s) => s.done).length;
  for (const li of document.querySelectorAll<HTMLLIElement>("#checklist > li"))
    li.hidden = !steps.some((s) => s.id === li.id);
  for (const s of steps) {
    const badge = $("#" + s.id + " [data-badge]");
    badge.textContent = s.done ? "Done" : s.optional ? "Optional" : "To do";
    badge.className = "badge" + (s.done ? " positive" : s.optional ? "" : " warning");
  }
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
    const missing = se.commands.filter((x) => !se.seen?.[x.action]).map((x) => x.name),
      total = se.commands.length;
    const left = missing.length
      ? ` Not used yet: ${missing.join(", ")}. Type each one in your chat; any reply from the bot counts.`
      : "";
    detail("check-commands", `${total - missing.length} of ${total} commands have reached PixFray.${left}`);
  }
  if (a.chatBot) renderBotStep(twitch);
  detail("check-mods", ...modsDetail());
  if (a.modsLapsed && !a.modsReady) {
    const b = $("#check-mods [data-badge]");
    b.textContent = "Expired";
    b.className = "badge warning";
  }
  const progress = `Stream setup: ${done} of ${required.length} steps done`;
  $("#check-title").textContent = done === required.length ? "Stream setup is done" : progress;
  const next = required.find((s) => !s.done),
    pointer = $("#setup-next");
  // one primary button: the bot step's while it's the next step, otherwise Copy link
  const stepAction = $<HTMLElement | null>("#bot-actions [data-step-action]"),
    botNext = !!stepAction && next?.id === "check-bot";
  stepAction?.classList.toggle("btn-primary", botNext);
  $("#copy").classList.toggle("btn-primary", !botNext);
  pointer.hidden = !next;
  if (next)
    pointer.replaceChildren(
      progress + ". Next: ",
      h(
        "a",
        {
          href: "#chat",
          onclick: (e: Event) => {
            e.preventDefault();
            selectTab($("#tab-chat"));
            const li = $("#" + next.id);
            li.scrollIntoView({ block: "center" });
            li.focus({ preventScroll: true });
          },
        },
        next.next,
      ),
      ".",
    );
}
// Step 4 reads differently for the broadcaster (who can connect), the site owner looking at another channel, and a moderator.
function modsDetail() {
  const a = admin(),
    lapsed = !!a.modsLapsed;
  if (a.modsReady && !lapsed) return ["Twitch moderators of " + CHANNEL + " can sign in and use this page."];
  if (broadcasterHere())
    return [
      lapsed
        ? "Mod access expired, so your Twitch moderators can't sign in until you reconnect it. "
        : "Your Twitch moderators can't sign in yet. PixFray needs permission to read your moderator list. ",
      h(
        "a",
        { href: "/auth/login?" + new URLSearchParams({ channel: CHANNEL, connect: "mods" }) },
        lapsed ? "Reconnect mod access" : "Connect mod access",
      ),
    ];
  const verb = lapsed ? "reconnect" : "connect",
    fix = S.access?.owner
      ? `${CHANNEL} has to ${verb} it from their own Stream setup page.`
      : `Ask ${CHANNEL} to ${verb} it.`;
  return [`${lapsed ? "Mod access expired" : "Mod access isn't connected"}. ${fix}`];
}
on<HTMLInputElement>(
  "#duel-module-off",
  async (box) => {
    const status = $("#check-status");
    const r = await busy(box, () => post({ action: "setDuelModuleOff", value: box.checked }));
    if (!r.ok) {
      box.checked = !box.checked;
      return setStatus(status, "Couldn't save: " + errorText(r) + ".", "error");
    }
    setStatus(
      status,
      box.checked ? "Saved: the Duel module is off." : "Saved: the Duel module step is open again.",
      "ok",
    );
    await load();
  },
  "change",
);
// While setup is unfinished and on screen, refetch every 10 s so a new overlay or command turns its row to Done.
setInterval(() => {
  if (S.admin && !document.hidden && !$("#panel-chat").hidden && setupSteps().some((s) => !s.done && !s.optional))
    load();
}, 10000);

// ---------- check-in test mode: !checkin answers while offline for 15 minutes, saving nothing ----------
const testOn = () => {
  const t = admin().checkinTest;
  return t && t.until > Date.now() ? t : null;
};
export function renderCheckinTest() {
  $("#checkin-test").hidden = !admin().checkinTestAllowed;
  const t = testOn(),
    until = t && new Date(t.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  $("#checkin-test-title").textContent = t ? "!checkin test mode is on" : "Test !checkin while offline";
  $("#checkin-test-text").replaceChildren(
    t ? `Until ${until}${t.by ? ` (turned on by ${t.by})` : ""}, ` : "For 15 minutes, ",
    h("code", {}, "!checkin"),
    t
      ? " answers while the stream is offline with a reply that starts [Test, not saved]. Nothing is saved: no points, no streak. While the stream is live, check-ins count as usual."
      : " answers while the stream is offline and shows what a viewer would get. Nothing is saved: no points, no streak.",
  );
  $("#checkin-test-toggle").textContent = t ? "Turn test mode off" : "Turn on test mode for 15 minutes";
}
on("#checkin-test-toggle", async (b) => {
  const value = !testOn(),
    status = $("#checkin-test-status");
  const r = await busy(b, () => post({ action: "checkinTest", value }));
  if (!r.ok) return setStatus(status, "Couldn't change it: " + errorText(r) + ".", "error");
  admin().checkinTest = r.data.checkinTest;
  renderCheckinTest();
  setStatus(status, value ? "Test mode is on. Type !checkin in chat to try it." : "Test mode is off.", "ok");
});
