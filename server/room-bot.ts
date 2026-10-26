import { hiddenResults, NEW_ACCOUNT_MS, parseGameCommand, reduceGame, shownProfile } from "./game.ts";
import { logRoomEvent } from "./developer.ts";
import { count, trace } from "./tracker.ts";
import { botDropText, sendChatMessage } from "./eventsub.ts";
import {
  COMMAND_COOLDOWN_MS,
  COMMAND_USER_COOLDOWN_MS,
  commandName,
  commandReplyText,
  counterName,
  fitChatLine,
  MAX_BOT_COMMANDS,
  MAX_CHAT_LINE,
  MAX_COMMAND_REPLY,
  MAX_COUNTER,
  renderCommandReply,
  replyCounters,
  replyWorstCase,
} from "./botcommands.ts";
import {
  botNames,
  DEFAULT_SE_NAMES,
  SE_ACTIONS,
  SE_SUBSCRIPTION_ID,
  seAmount,
  seChangelogText,
  seCheckinText,
  seCommandText,
  seEloText,
  seExpiredText,
  seGiveText,
  seHelpText,
  seLookText,
  sePetText,
  seReplyText,
  seResultText,
  seStatsText,
  seTarget,
  seTopText,
  seWalletText,
} from "./streamelements.ts";
import type { SeNames } from "./streamelements.ts";
import type { ChatEvent, GameEvent, GameResult, GameState, ReduceOutput, SendResult } from "./model.ts";
import {
  boardOrder,
  BOT_REPLIES_PER_30S,
  getProfile,
  getProfileByUsername,
  normalizeProfileRow,
  normalizeUsername,
  PROFILE_COLUMNS,
  errorText,
  randomHex,
  timingSafeEqual,
  upsertProfile,
  validUserId,
} from "./room-shared.ts";
import { json } from "./http.ts";
import type { BotMessage, ChatOutcome, JsonObject, Profile, ProfileRow, ProfileTable } from "./room-shared.ts";
import { leaderboard } from "./room-routes.ts";
import { checkin, give, payDuels, petInfo, resetPair, statsInfo, streamNews, wallet } from "./room-economy.ts";
import type { ChannelRoom, SeSettings } from "./channel.ts";

/** How a bot command reached the room, for its replies and the command log. */
type BotCtx = { origin: string; settings: SeSettings; subscriptionId: string };
/** A command as runCommand takes it: from StreamElements (/se), the bot (botCommand) or the test site. */
type CommandInput = {
  action?: unknown;
  userId?: unknown;
  username?: unknown;
  displayName?: unknown;
  target?: unknown;
  targetRaw?: unknown;
  amount?: unknown;
  messageId?: unknown;
  key?: unknown;
  [field: string]: unknown;
};
/** runCommand's answer (the /se body). */
type CommandReply = { reply: string; reason: string; switchedFrom?: string };

const REJECTED_WRITE_MS = 60_000; // a wrong StreamElements key is recorded at most once a minute
const SEEN_WRITE_MS = 60_000; // each command's "last seen" time is written at most once a minute
const BOT_RESERVED_LINES = 4; // of those, kept for the bot's own result and expired-challenge lines
// Hidden bot-channel aliases for words new viewers guess: !accept and !duel, and !top (StreamElements owns it on SE channels).
const BOT_ALIASES: { [word: string]: string } = { "!accept": "accept", "!duel": "challenge", "!top": "top" };
// Commands that refuse the bot account as their target, with the reply (outside the BOT_DEBUG test site).
const BOT_TARGET_ACTIONS: { [action: string]: (names: SeNames) => string } = {
  challenge: (names) => `The bot doesn't fight (yet)! Name a rival: ${names.challenge || "!challenge"} @name`,
  give: () => "The bot doesn't take dollars. Give them to a rival!",
};
// !fray e2e (BOT_DEBUG): [who, action, target, expected reasons, gate]. B is the bot account, O the opponent. A gate step
// starts or answers a duel the next steps need, so the run stops when it fails.
const E2E_STEPS: [who: "B" | "O", action: string, target: "" | "O", want: string[], gate?: boolean][] = [
  ["B", "help", "", ["help"]],
  ["B", "look", "", ["look"]],
  ["B", "changelog", "", ["changelog"]],
  ["B", "top", "", ["top"]],
  ["B", "elo", "", ["elo"]],
  ["B", "elo", "O", ["elo"]],
  ["B", "wallet", "", ["wallet"]],
  ["B", "pet", "", ["pet", "no_pet"]],
  ["B", "stats", "", ["stats"]],
  ["B", "checkin", "", ["checked_in", "already_checked_in", "not_live"]],
  ["B", "challenge", "", ["target_required"]],
  ["B", "challenge", "O", ["challenge"], true],
  ["O", "decline", "", ["challenge_declined"], true],
  ["B", "challenge", "O", ["challenge"], true],
  ["O", "accept", "", ["quick_duel"], true],
  ["B", "rematch", "", ["challenge", "rematch_cooldown", "respawning", "result_hidden"]],
  ["B", "give", "O", ["given", "not_live", "too_few_duels", "not_enough", "give_off", "give_cap", "over_cap"]],
  ["B", "decline", "", ["challenge_not_found"]],
  ["B", "accept", "", ["challenge_not_found"]],
];
const MAX_E2E_LINE = 470; // under the bot's 480-character chat line
// Joins parts into as few lines as fit max characters each.
function chatLines(parts: string[], sep: string, max: number): string[] {
  const out: string[] = [];
  for (const part of parts) {
    const last = out.length ? (out[out.length - 1] as string) : null; // out has that many lines
    if (last !== null && last.length + sep.length + part.length <= max) out[out.length - 1] = last + sep + part;
    else out.push(part.slice(0, max));
  }
  return out;
}
// Chat bots never walk into the arena or duel.
const CHAT_BOTS = new Set([
  "streamelements",
  "nightbot",
  "moobot",
  "fossabot",
  "streamlabs",
  "wizebot",
  "sery_bot",
  "soundalerts",
  "kofistreambot",
  "botrixoficial",
  "pixfray",
]);
const PRESENCE_REFRESH_MS = 30_000; // chat-only viewers refresh their arena presence at most this often
const LAST_SEEN_WRITE_MS = 60_000; // chat.lastSeen alone is persisted at most once a minute
const ACCOUNT_RETRY_MS = 3_600_000; // a failed Twitch account-age lookup is retried after an hour
// "45 s", "12 min", "3 h", "2 d": how long ago (or until) for the bot's one-line status.
function agoText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90
    ? s + " s"
    : s < 5400
      ? Math.round(s / 60) + " min"
      : s < 172800
        ? Math.round(s / 3600) + " h"
        : Math.round(s / 86400) + " d";
}

/** A read or wallet command's asker, as runCommand and the test site's /dev-chat hand it to QUICK_COMMANDS. */
type QuickAsk = {
  channel: string;
  userId: string;
  username: string;
  who: string; // the sender's name as sent
  target: string;
  amount: unknown;
  origin: string;
  names: SeNames;
  now: number;
};
/** A quick command's bot line, its log reason and the fields /dev-chat answers with. */
type QuickAnswer = { reply: string; reason: string; extra?: JsonObject; data?: JsonObject };
// Commands answered without the game reducer, so they work while duels are paused.
export const QUICK_COMMANDS: {
  [action: string]: (room: ChannelRoom, ask: QuickAsk) => QuickAnswer | Promise<QuickAnswer>;
} = {
  async checkin(room, { channel, userId, who, origin, now }) {
    const checked = await checkin(room, channel, { userId }, now);
    return {
      reply: seCheckinText(checked, { who, origin, channel }),
      reason: checked.reason,
      extra: checked.reason === "checked_in" ? { streak: checked.streak, points: checked.points } : {},
      data: checked,
    };
  },
  wallet(room, { channel, userId, who, origin }) {
    const w = wallet(room, channel, userId);
    return {
      reply: seWalletText(w, { who, origin, channel }),
      reason: w ? "wallet" : "no_fighter",
      data: { wallet: w },
    };
  },
  pet(room, { channel, userId, username, who, target, origin }) {
    const self = !target || target === username,
      info = petInfo(room, channel, self ? { userId } : { username: target });
    return {
      reply: sePetText(info, { who, target: self ? "" : target, origin, channel }),
      reason: info ? (info.pet ? "pet" : "no_pet") : "no_fighter",
      data: { pet: info },
    };
  },
  stats(room, { channel, userId, username, who, target, origin }) {
    const self = !target || target === username,
      info = statsInfo(room, channel, self ? { userId } : { username: target, asker: userId });
    return {
      reply: seStatsText(info, { who, target: self ? "" : target, origin, channel }),
      reason: info ? "stats" : "no_fighter",
    };
  },
  async give(room, { channel, userId, who, target, amount, origin, names, now }) {
    const given = await give(room, channel, { userId, target, amount: seAmount(amount) }, now);
    return {
      reply: seGiveText(given, { who, target, origin, channel, names }),
      reason: given.reason,
      extra: given.reason === "given" ? { amount: given.amount } : {},
      data: given,
    };
  },
  help: (_room, { names, origin, channel }) => ({ reply: seHelpText({ names, origin, channel }), reason: "help" }),
  changelog: (_room, { origin }) => ({ reply: seChangelogText({ origin }), reason: "changelog" }),
  look(room, { channel, userId, who, origin }) {
    const hasFighter = Boolean(getProfile(room, userId, room.readState(channel).config));
    return { reply: seLookText({ who, hasFighter, origin, channel }), reason: "look" };
  },
  top: (room, { channel, origin }) => ({
    reply: seTopText(leaderboard(room, channel).slice(0, 5), { origin, channel }),
    reason: "top",
  }),
  elo(room, { channel, userId, who, target, origin }) {
    const found = eloLookup(room, channel, target ? { username: target } : { userId });
    return {
      reply: seEloText(found, { self: !target, askerName: who, target, origin, channel }),
      reason: found ? "elo" : "elo_not_found",
    };
  },
};

// One saved profile with its leaderboard place (same order as leaderboard()), or null.
function eloLookup(
  room: ChannelRoom,
  channel: string,
  { userId = "", username = "" }: { userId?: string; username?: string },
) {
  const sql = room.ctx.storage.sql;
  const row = (
    userId
      ? sql.exec<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE user_id = ?`, userId)
      : sql.exec<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE username = ? COLLATE NOCASE`, username)
  ).toArray()[0];
  if (!row) return null;
  const state = room.readState(channel),
    hidden = hiddenResults(state, Date.now());
  const profile = shownProfile(normalizeProfileRow(row, state.config), hidden);
  let ahead = Number(
    sql
      .exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM profiles WHERE user_id != ? AND (elo > ? OR (elo = ? AND wins > ?) OR (elo = ? AND wins = ? AND username COLLATE NOCASE < ?))",
        profile.userId,
        profile.elo,
        profile.elo,
        profile.wins,
        profile.elo,
        profile.wins,
        row.username,
      )
      .toArray()[0]!.n, // COUNT(*) always returns one row
  );
  // The count used everyone's saved numbers; swap in the shown ones for fighters whose result is still hidden.
  for (const id of hidden.keys()) {
    if (id === profile.userId) continue;
    const other = sql.exec<ProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE user_id = ?`, id).toArray()[0];
    if (!other) continue;
    const saved = normalizeProfileRow(other, state.config);
    ahead += Number(boardOrder(shownProfile(saved, hidden), profile) < 0) - Number(boardOrder(saved, profile) < 0);
  }
  const total = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM profiles").toArray()[0]!.n; // one row, as above
  return { profile, rank: ahead + 1, total: Number(total) };
}

// One StreamElements command. It goes through the same path as a Twitch chat message, then gets a one-line reply.
export async function streamElements(
  room: ChannelRoom,
  channel: string,
  input: CommandInput,
  origin: string,
): Promise<Response> {
  const settings = room.seSettings();
  if (!timingSafeEqual(String(input.key || ""), settings.secret)) {
    if (Date.now() - settings.rejectedAt > REJECTED_WRITE_MS)
      room.ctx.storage.sql.exec("UPDATE se_settings SET rejected_at = ? WHERE id = 1", Date.now());
    return json({ reply: "PixFray: wrong key. Copy the commands again from the admin page." }, 403);
  }
  // The bot answers every command itself, so StreamElements posts nothing (no double replies) and keeps the chat source.
  if (room.botSource(room.readState(channel))) return json({ reply: "" });
  // includes() is true only for one of those strings
  const action = SE_ACTIONS.includes(input.action as string) ? (input.action as string) : "";
  if (action && Date.now() - (settings.seen[action] || 0) > SEEN_WRITE_MS) {
    room.ctx.storage.sql.exec(
      "UPDATE se_settings SET last_command_at = ?, seen_json = ? WHERE id = 1",
      Date.now(),
      JSON.stringify({ ...settings.seen, [action]: Date.now() }),
    );
  } else room.ctx.storage.sql.exec("UPDATE se_settings SET last_command_at = ? WHERE id = 1", Date.now());
  return runCommand(room, channel, input, origin, settings, { kind: "se", subscriptionId: SE_SUBSCRIPTION_ID });
}

// A chat line read by the PixFray bot: only the channel's command names get a reply, capped per 30 s.
export async function botCommand(
  room: ChannelRoom,
  channel: string,
  msg: BotMessage,
  origin: string,
): Promise<Response> {
  const ev: Partial<ChatEvent> = msg.event && typeof msg.event === "object" ? msg.event : {};
  const words = String(ev.message?.text || "")
    .trim()
    .split(/\s+/);
  const se = room.seSettings(),
    settings = { ...se, names: botNames(se.names) };
  const first = (words[0] || "").toLowerCase();
  // "!pay" stays an alias of !give, the name it had while StreamElements' !give (!givepoints) was in the way.
  let action =
    SE_ACTIONS.find((a) => String(settings.names[a] || "").toLowerCase() === first) || (first === "!pay" ? "give" : "");
  const custom =
    action || !first.startsWith("!")
      ? null
      : room.ctx.storage.sql
          .exec<{ name: string; reply: string }>("SELECT name, reply FROM bot_commands WHERE name = ?", first)
          .toArray()[0];
  // Words new viewers guess (!accept, !duel, !top) work as hidden aliases, unless the channel made them its own commands.
  if (
    !action &&
    !custom &&
    BOT_ALIASES[first] &&
    !Object.values(settings.names).some((n) => String(n).toLowerCase() === first)
  )
    action = BOT_ALIASES[first];
  // !resetpair @a @b (broadcaster or a mod) has a fixed name, like !fray debug.
  const pairReset = first === "!resetpair" && !action && !custom;
  if (!action && !custom && !pairReset) return json({ ok: true, reason: "not_command", reply: "" });
  const subscriptionId = String(msg.subscription?.id || "");
  const state = room.readState(channel);
  if (!subscriptionId || subscriptionId !== state.chat.subscriptionId) {
    noteBotHeld(room, channel, "unknown_subscription", { subscriptionId: subscriptionId.slice(0, 64) });
    return json({ ok: true, reason: "unknown_subscription", reply: "" });
  }
  const before = room.botStatus();
  noteBotHeard(room, `${normalizeUsername(ev.chatter_user_login) || "?"} ${first}`);
  rememberReminder(room, String(ev.broadcaster_user_id || ""), validUserId(msg.botId), origin);
  if (!state.chat.connected) {
    // Twitch only notifies enabled subscriptions, so this confirms a pending one
    const verified = room.advance(channel, { type: "chat_verified", subscriptionId }, Date.now());
    if (verified.visible) room.broadcast(verified.state);
    await room.scheduleAlarm(verified.state);
  }
  // "!fray off" / "!fray on" (broadcaster or a mod): while off, every other command gets no reply.
  const chatterId = validUserId(ev.chatter_user_id),
    boss = chatterId === validUserId(ev.broadcaster_user_id) || ev.mod === true;
  const say = (line: string) => sendBotLines(room, [line], channel);
  const sub = action === "help" ? String(words[1] || "").toLowerCase() : "",
    toggle = boss ? sub : "";
  const off = state.config.botEnabled === false;
  if (toggle === "on" || toggle === "off") {
    if (off !== (toggle === "off")) {
      const set = room.advance(
        channel,
        {
          type: "admin",
          actorId: chatterId,
          actorName: String(ev.chatter_user_login || "").slice(0, 48),
          action: "config",
          payload: { patch: { botEnabled: toggle === "on" } },
          note: "bot " + toggle + " (chat)",
        },
        Date.now(),
      );
      if (!set.result.ok) return json({ ok: false, reason: set.result.reason, reply: "" });
      room.broadcast(set.state);
      await room.scheduleAlarm(set.state);
    }
    return say(
      toggle === "on"
        ? `PixFray bot is on. Type ${settings.names.help} to play.`
        : `PixFray bot is off: it ignores commands until the broadcaster or a mod types ${settings.names.help} on.`,
    );
  }
  if (off) return json({ ok: true, reason: "bot_off", reply: "" });
  // The alarm posts each result at its reveal time; any result it missed goes out now, before this reply.
  await postResults(room, channel, Date.now());
  if (custom) {
    // A reply the cap would drop doesn't start the cooldown or add to its counters.
    if (!botReplyRoom(room, Date.now())) return say(custom.name);
    const line = customReply(room, custom, ev, words, Date.now());
    if (!line) noteBotHeld(room, channel, "cooldown", { command: custom.name }, false);
    return say(line);
  }
  if (pairReset) {
    const actor = String(ev.chatter_user_login || "").slice(0, 48);
    if (!boss) return say("Only the broadcaster or a mod can use !resetpair.");
    if (!words[1] || !words[2]) return say("Type !resetpair @name @name to reset a pair's ranked duels.");
    const out = resetPair(room, channel, words[1], words[2], chatterId, actor);
    return say(
      out.ok
        ? `Ranked duels reset for ${out.a} and ${out.b}: ${typeof out.left === "number" ? out.left + " left this stream" : "no limit on this channel"}.`
        : out.reason === "profile_not_found"
          ? `@${normalizeUsername(String(out.missing || "").replace(/^@/, ""))} has no saved fighter on this channel.`
          : "Pick two different fighters: !resetpair @name @name",
    );
  }
  // "!fray debug" (broadcaster, mods or the bot account): the bot's health in one line, as the admin page shows it.
  if (sub === "debug")
    return say(
      boss || chatterId === validUserId(msg.botId)
        ? botStatusLine(room, state, before, Date.now())
        : "PixFray debug: only the broadcaster or a mod can use !fray debug.",
    );
  const input = {
    action,
    userId: ev.chatter_user_id,
    username: ev.chatter_user_login,
    displayName: ev.chatter_user_name,
    target: seTarget(words[1]),
    targetRaw: words[1] || "",
    ...(action === "give" ? { amount: String(words[2] || "").slice(0, 16) } : {}),
    messageId: String(ev.message_id || msg.messageId || ""),
  };
  // BOT_DEBUG (test site): the bot account also plays. "!fray spar" and "!fray e2e" replace the help reply.
  const botId = room.env?.BOT_DEBUG === "1" ? validUserId(msg.botId) : "";
  const mode = botId ? sub : "";
  let lines: string[];
  if (mode === "spar" || mode === "e2e")
    lines = await botDebug(room, channel, mode, { ev, words, botId, origin, settings, subscriptionId });
  else if (
    !botId &&
    BOT_TARGET_ACTIONS[action] &&
    input.target &&
    getProfileByUsername(room, input.target, state.config)?.userId === validUserId(msg.botId)
  ) {
    // The bot account isn't a fighter or wallet (yet: maybe a co-op boss); the test site's sparring bot still plays.
    lines = [BOT_TARGET_ACTIONS[action]!(settings.names)]; // checked in the condition above
  } else {
    const since = room.readState(channel).revision;
    const out = await (
      await runCommand(room, channel, input, origin, settings, { kind: "bot", subscriptionId })
    ).json<CommandReply>(); // runCommand's answer
    const expired = expiredLines(room, room.readState(channel), since);
    lines = [
      ...expired,
      out.reply,
      ...(botId && validUserId(input.userId) !== botId
        ? await botAnswer(room, channel, input, out, { botId, origin, settings, subscriptionId })
        : []),
    ];
    return sendBotLines(room, lines, channel, { system: expired.length });
  }
  return sendBotLines(room, lines, channel);
}

// How many more command replies fit under the cap right now.
export function botReplyRoom(room: ChannelRoom, now: number): number {
  return Math.max(
    0,
    BOT_REPLIES_PER_30S - BOT_RESERVED_LINES - (room.botReplies || []).filter((at) => now - at < 30000).length,
  );
}

// The bot's reply lines that fit under BOT_REPLIES_PER_30S, as the Worker expects them: { reply, replies }.
// Replies to commands stop BOT_RESERVED_LINES short of the cap; the bot's own lines (results, expired challenges;
// the first `system` lines) may use the rest, so a chatter spamming commands can't crowd out who won.
function sendBotLines(
  room: ChannelRoom,
  lines: string[],
  channel = "",
  { system = 0 }: { system?: number } = {},
): Response {
  const now = Date.now(),
    sent: string[] = [];
  room.botReplies = (room.botReplies || []).filter((at) => now - at < 30000);
  for (const [i, line] of lines.entries()) {
    if (!line) continue;
    if (room.botReplies.length >= BOT_REPLIES_PER_30S - (i < system ? 0 : BOT_RESERVED_LINES)) {
      if (i < system) continue;
      break;
    }
    room.botReplies.push(now);
    sent.push(line);
  }
  const cut = lines.filter(Boolean).length - sent.length;
  if (cut) noteBotHeld(room, channel, "reply_limit", { cut });
  if (!sent.length)
    return json({ ok: true, reason: lines.some(Boolean) ? "reply_limit" : "no_reply", reply: "", replies: [] });
  return json({ ok: true, reply: sent[0], replies: sent });
}

// One command played by the bot account (BOT_DEBUG), through the same path as a chat line. Returns { reply, reason }.
export async function botPlays(
  room: ChannelRoom,
  channel: string,
  bot: Profile,
  action: string,
  target: string,
  { origin, settings, subscriptionId, kind = "bot", amount }: BotCtx & { kind?: string; amount?: unknown },
): Promise<CommandReply> {
  const input = {
    action,
    userId: bot.userId,
    username: bot.username,
    displayName: bot.displayName || bot.username,
    target,
    targetRaw: target ? "@" + target : "",
    ...(amount !== undefined ? { amount: String(amount) } : {}),
  };
  return (
    await runCommand(room, channel, input, origin, settings, { kind, subscriptionId, botPlays: true })
  ).json<CommandReply>(); // runCommand's answer
}

// Sparring partner (BOT_DEBUG): a challenge or rematch aimed at the bot is accepted, and dollars paid to it are paid back.
async function botAnswer(
  room: ChannelRoom,
  channel: string,
  input: CommandInput,
  out: CommandReply,
  ctx: BotCtx & { botId: string },
): Promise<string[]> {
  const config = room.readState(channel).config,
    bot = getProfile(room, ctx.botId, config);
  if (!bot) return [];
  const userId = validUserId(input.userId);
  if (room.readState(channel).duels.some((d) => d.status === "pending" && d.a === userId && d.b === ctx.botId))
    return [(await botPlays(room, channel, bot, "accept", "", ctx)).reply];
  if (input.action === "give" && out.reason === "given" && normalizeUsername(input.target) === bot.username) {
    return [
      (await botPlays(room, channel, bot, "give", normalizeUsername(input.username), { ...ctx, amount: input.amount }))
        .reply,
    ];
  }
  return [];
}

// "!fray spar": the bot challenges whoever asked. "!fray e2e [@name]" (broadcaster, mods or the bot account): the bot
// plays every chat command once against @name (default: whoever asked) and posts which steps passed.
async function botDebug(
  room: ChannelRoom,
  channel: string,
  mode: string,
  {
    ev,
    words,
    botId,
    origin,
    settings,
    subscriptionId,
  }: BotCtx & { ev: Partial<ChatEvent>; words: string[]; botId: string },
): Promise<string[]> {
  const config = room.readState(channel).config,
    bot = getProfile(room, botId, config);
  const userId = validUserId(ev.chatter_user_id),
    username = normalizeUsername(ev.chatter_user_login);
  if (!bot)
    return [
      `PixFray debug: the bot account has no saved fighter here yet. Sign in as the bot at ${origin}/?channel=${channel} and save one.`,
    ];
  const ctx = { origin, settings, subscriptionId };
  if (mode === "spar") {
    if (userId === botId)
      return ["PixFray debug: the bot can't spar with itself. Type !fray spar from another account."];
    return [(await botPlays(room, channel, bot, "challenge", username, ctx)).reply];
  }
  const allowed = userId === botId || userId === validUserId(ev.broadcaster_user_id) || ev.mod === true;
  if (!allowed) return ["PixFray debug: only the broadcaster or a mod can run !fray e2e."];
  const named = seTarget(words[2]);
  const opponent = named
    ? getProfileByUsername(room, named, config)
    : userId === botId
      ? null
      : getProfile(room, userId, config);
  if (!opponent)
    return [
      named
        ? `PixFray debug: @${named} has no saved fighter here.`
        : userId === botId
          ? "PixFray debug: name the opponent: !fray e2e @name"
          : `PixFray debug: @${username} has no saved fighter here. Save one at ${origin}/?channel=${channel}`,
    ];
  if (opponent.userId === botId) return ["PixFray debug: the opponent can't be the bot itself."];
  return botE2e(room, channel, bot, opponent, { ...ctx, kind: "e2e" });
}

async function botE2e(
  room: ChannelRoom,
  channel: string,
  bot: Profile,
  opponent: Profile,
  ctx: BotCtx & { kind: string },
): Promise<string[]> {
  const names = ctx.settings.names,
    results: { label: string; action: string; ok: boolean; reason: string; want: string[] }[] = [];
  const player = { B: bot, O: opponent };
  for (const [who, action, target, want, gate] of E2E_STEPS) {
    const actor = player[who],
      aimed = target ? player[target].username : "";
    const out = await botPlays(room, channel, actor, action, aimed, {
      ...ctx,
      amount: action === "give" ? 1 : undefined,
    });
    const ok = Boolean(out.reply) && want.includes(out.reason);
    const label =
      String(names[action] || action).replace(/^!/, "") +
      (aimed ? " @" + aimed : "") +
      (who === "O" ? " by " + opponent.username : "");
    results.push({ label, action, ok, reason: out.reason, want });
    // A rematch the game allowed leaves a challenge open; the opponent declines it so the run ends clean.
    if (action === "rematch" && out.reason === "challenge") await botPlays(room, channel, opponent, "decline", "", ctx);
    if (!ok && gate) break; // the steps after this one need its duel
  }
  const passed = results.filter((r) => r.ok).length,
    stopped = results.length < E2E_STEPS.length;
  const head =
    `PixFray e2e, ${bot.username} vs ${opponent.username}: ${passed} of ${E2E_STEPS.length} steps passed` +
    (stopped ? `, stopped early (a duel or cooldown between them is still running; try again in 30 s).` : ".");
  const parts = results.map((r) =>
    r.ok
      ? `${r.label} ok${r.reason !== r.action ? " (" + r.reason + ")" : ""}`
      : `FAIL ${r.label}: got ${r.reason || "no reply"}, want ${r.want.join("|")}`,
  );
  logRoomEvent(room, "command", `e2e ${bot.username} vs ${opponent.username}: ${passed}/${E2E_STEPS.length}`, {
    channel,
    via: "e2e",
    passed,
    steps: E2E_STEPS.length,
    results,
  });
  return [head, ...chatLines(parts, " · ", MAX_E2E_LINE)];
}

// The command itself, shared by StreamElements and the bot. source: { kind: "se" | "bot", subscriptionId }.
export async function runCommand(
  room: ChannelRoom,
  channel: string,
  input: CommandInput,
  origin: string,
  settings: SeSettings,
  source: { kind: string; subscriptionId: string; botPlays?: boolean },
): Promise<Response> {
  // includes() is true only for one of those strings
  const action = SE_ACTIONS.includes(input.action as string) ? (input.action as string) : "";
  const userId = validUserId(input.userId);
  const username = normalizeUsername(input.username);
  const target = normalizeUsername(input.target);
  const now = Date.now();
  const names = settings.names;
  let state0 = room.readState(channel);
  // The first command with the right key makes StreamElements the chat source, unless a mod turned chat off on
  // purpose (Disconnect chat; "Use StreamElements" turns it back on). SE_ONLY (test site) always switches.
  let switchedFrom = "";
  const turnedOff = state0.chat.status === "disconnected" && state0.chat.createdAt > 0;
  if (
    source.kind === "se" &&
    state0.chat.subscriptionId !== SE_SUBSCRIPTION_ID &&
    (room.env?.SE_ONLY === "1" || !turnedOff)
  ) {
    switchedFrom = state0.chat.subscriptionId || ""; // a Twitch EventSub subscription the Worker deletes
    const switched = room.advance(
      channel,
      { type: "chat_subscription", subscriptionId: SE_SUBSCRIPTION_ID, status: "enabled", createdAt: now },
      now,
    );
    if (switched.visible) room.broadcast(switched.state);
    await room.scheduleAlarm(switched.state);
    state0 = switched.state;
  }
  // Every command is logged with what came in, what the game decided and what the bot said.
  const done = (reply: string, reason: string, extra: JsonObject = {}) => {
    logRoomEvent(
      room,
      "command",
      // the action as sent, whatever its type, reads as text in the log
      `${username || "?"} ${(input.action as string) || "?"}${target ? " @" + target : ""} -> ${reason}`,
      {
        channel,
        via: source.kind,
        user: username,
        userId,
        action: input.action,
        t: String(input.targetRaw || "").slice(0, 80),
        target,
        reason,
        reply,
        ...extra,
      },
    );
    return json({ reply, ...(source.kind === "se" ? {} : { reason }), ...(switchedFrom ? { switchedFrom } : {}) }); // the bot reads reason
  };
  if (!action) return done(`Lost in the arena? Type ${names.help}`, "unknown_action");
  if (!userId || !username)
    return done(
      "PixFray: this command is missing sender details. Copy it again from the admin page.",
      "missing_sender",
    );
  const quick = QUICK_COMMANDS[action];
  if (quick) {
    // the sender's name as sent; short() reads it through String()
    const who = (input.displayName as string) || username;
    const out = await quick(room, { channel, userId, username, who, target, amount: input.amount, origin, names, now });
    return done(out.reply, out.reason, out.extra);
  }
  if (!state0.chat.connected || state0.chat.subscriptionId !== source.subscriptionId)
    return done(
      seReplyText({
        result: { ok: false, reason: "chat_offline" },
        state: state0,
        actorId: userId,
        action,
        target,
        names,
        origin,
        now,
      }),
      "chat_offline",
    );
  if (action === "challenge" && !target)
    return done(
      seReplyText({
        result: { ok: false, reason: "target_required" },
        state: state0,
        actorId: userId,
        action,
        target,
        names,
        origin,
        now,
      }),
      "target_required",
    );
  const messageId = source.kind + ":" + (String(input.messageId || "").slice(0, 60) || randomHex().slice(0, 24));
  const msg: BotMessage = {
    messageId,
    timestamp: now,
    quick: true,
    // The test site's bot account plays its own commands although its login is a known chat bot.
    ...(room.env?.BOT_DEBUG === "1" && source.botPlays ? { botPlays: true } : {}),
    subscription: { id: source.subscriptionId },
    event: {
      chatter_user_id: userId,
      chatter_user_login: username,
      chatter_user_name: String(input.displayName || username).slice(0, 48),
      message_id: messageId,
      message: { text: seCommandText(action, target) },
    },
  };
  await checkAccountAge(room, userId);
  const result = processChatMessage(
    room,
    channel,
    msg,
    Date.now(),
    await streamNews(room, channel, msg.event?.message?.text, now),
  );
  if (result.visible) room.broadcast(result.state);
  if (result.changed) await room.scheduleAlarm(result.state);
  const r = result.result || ({} as GameResult); // processChatMessage always has a result; {} only guards against none
  if (r.reason === "quick_duel" || r.reason === "duel_completed") room.checkSavedProfiles(result.state, r.duelId);
  const actorRegistered =
    r.reason !== "ranked_sign_in_required" ||
    room.ctx.storage.sql.exec("SELECT 1 FROM profiles WHERE user_id = ?", userId).toArray().length > 0;
  return done(
    seReplyText({
      result: r,
      state: result.state,
      actorId: userId,
      action,
      target,
      names,
      origin,
      now,
      actorRegistered,
    }),
    r.reason || (r.ok ? action : "error"),
    r.swings
      ? {
          duelId: r.duelId,
          // other outcomes use their first letter (each outcome is a non-empty word)
          swings: r.swings
            .map(
              (s) => s.die + (({ crit: "x" } as { [outcome: string]: string | undefined })[s.outcome] || s.outcome[0]!),
            )
            .join(" "),
        }
      : {},
  );
}

function noteBotHeard(room: ChannelRoom, what: string): void {
  room.ctx.storage.sql.exec(
    "UPDATE bot_status SET heard_at = ?, heard = ? WHERE id = 1",
    Date.now(),
    String(what).slice(0, 80),
  );
}

// A reply the room didn't send. Logged as a warning at most once a minute per reason (cooldowns aren't logged).
function noteBotHeld(room: ChannelRoom, channel: string, reason: string, context: JsonObject = {}, log = true): void {
  const now = Date.now(),
    last = (room.heldLogged ||= {});
  room.ctx.storage.sql.exec("UPDATE bot_status SET held_at = ?, held_reason = ? WHERE id = 1", now, reason);
  count(room, "bot_held");
  count(room, "bot_held_" + reason);
  trace(room, "chat", "bot held: " + reason, { channel, reason, ...context }, false);
  if (!log || now - (last[reason] || 0) < 60_000) return;
  last[reason] = now;
  logRoomEvent(room, "warn", "bot reply held back: " + reason, { channel, via: "bot", reason, ...context });
}

// What Twitch said about the bot's lines ({sent, reason} each, from sendChatMessage). A dropped or failed line is
// logged as a warning with Twitch's reason; sent lines only update the status.
export function noteBotSent(
  room: ChannelRoom,
  channel: string,
  results: (Partial<SendResult> | null | undefined)[],
  via = "reply",
): void {
  const sql = room.ctx.storage.sql,
    now = Date.now();
  // an empty list of results to add these to
  for (const r of ([] as (Partial<SendResult> | null | undefined)[]).concat(results || [])) {
    if (r?.sent === true) {
      sql.exec("UPDATE bot_status SET sent_at = ?, sent_total = sent_total + 1 WHERE id = 1", now);
      count(room, "bot_sent");
      trace(room, "chat", "bot " + via + " sent", { channel, via });
      continue;
    }
    count(room, "bot_failed");
    const reason = String(r?.reason || "unknown").slice(0, 200);
    sql.exec(
      "UPDATE bot_status SET failed_at = ?, failed_total = failed_total + 1, failed_reason = ? WHERE id = 1",
      now,
      reason,
    );
    logRoomEvent(room, "warn", "bot " + via + " dropped: " + botDropText(reason), { channel, via: "bot", reason });
  }
}

// "!fray debug": the health line, from the status before this command was heard.
function botStatusLine(
  room: ChannelRoom,
  state: GameState,
  s: ReturnType<ChannelRoom["botStatus"]>,
  now: number,
): string {
  const ago = (at: number) => (at ? agoText(now - at) : "never");
  const every = Number(state.config.reminderMin) || 0,
    due = every
      ? room.ctx.storage.sql.exec<{ next_at: number }>("SELECT next_at FROM bot_reminder WHERE id = 1").toArray()[0]
          ?.next_at
      : 0;
  return [
    "PixFray debug: chat " + (state.chat.connected ? "connected" : "not connected"),
    "last command " + (s.heard ? s.heard + " " + ago(s.heardAt) : "never"),
    `replies ${s.sent} sent, ${s.failed} dropped` +
      (s.failedAt ? ` (last drop ${ago(s.failedAt)}: ${botDropText(s.failedReason)})` : ""),
    `${s.recent}/${s.cap} replies in 30 s`,
    s.heldAt ? `last held back ${ago(s.heldAt)}: ${s.heldReason}` : "",
    "reminder " + (every ? `every ${every} min` + (due ? `, next in ${agoText(Math.max(0, due - now))}` : "") : "off"),
  ]
    .filter(Boolean)
    .join(" · ");
}

// The bot's text commands and counters, for the admin page.
export function botCommands(room: ChannelRoom) {
  const sql = room.ctx.storage.sql;
  return {
    commands: sql
      .exec<{ name: string; reply: string }>("SELECT name, reply FROM bot_commands ORDER BY name")
      .toArray()
      .map((r) => ({ name: r.name, reply: r.reply })),
    counters: sql
      .exec<{ name: string; value: number }>("SELECT name, value FROM bot_counters ORDER BY name")
      .toArray()
      .map((r) => ({ name: r.name, value: r.value })),
    max: MAX_BOT_COMMANDS,
  };
}

// Admin page: saveCommand {name, reply, oldName?}, deleteCommand {name}, setCounter {name, value}. A name can't be a
// PixFray command's (the channel's names, their defaults and !pay). A counter first used in a reply starts at 0.
export function editBotCommands(
  room: ChannelRoom,
  channel: string,
  action: string,
  payload: JsonObject,
  actorName: string,
) {
  const sql = room.ctx.storage.sql;
  if (action === "setCounter") {
    const name = counterName(payload.name),
      value = Number(payload.value);
    if (!name) return { ok: false, reason: "invalid_counter_name" };
    if (!Number.isInteger(value) || value < 0 || value > MAX_COUNTER)
      return { ok: false, reason: "invalid_counter_value" };
    sql.exec(
      "INSERT INTO bot_counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      name,
      value,
    );
    logRoomEvent(room, "command", `${actorName} counter ${name} = ${value}`, { channel, action });
    return { ok: true, reason: "counter_saved" };
  }
  const name = commandName(payload.name);
  if (!name) return { ok: false, reason: "invalid_command_name" };
  if (action === "deleteCommand") {
    sql.exec("DELETE FROM bot_commands WHERE name = ?", name);
    logRoomEvent(room, "command", `${actorName} deleted ${name}`, { channel, action });
    return { ok: true, reason: "command_deleted" };
  }
  const reply = commandReplyText(payload.reply);
  if (!reply) return { ok: false, reason: "empty_command_reply" };
  if (reply.length > MAX_COMMAND_REPLY) return { ok: false, reason: "command_reply_too_long" };
  const taken = new Set(
    ["!pay", ...Object.values(botNames(room.seSettings().names)), ...Object.values(DEFAULT_SE_NAMES)].map((n) =>
      String(n).toLowerCase(),
    ),
  );
  if (taken.has(name)) return { ok: false, reason: "command_name_taken" };
  const oldName = commandName(payload.oldName);
  const exists = sql.exec("SELECT 1 FROM bot_commands WHERE name = ?", name).toArray().length > 0;
  if (exists && oldName !== name) return { ok: false, reason: "command_exists" };
  const total = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM bot_commands").toArray()[0]!.n; // COUNT(*) always returns one row
  if (!exists && !oldName && total >= MAX_BOT_COMMANDS) return { ok: false, reason: "too_many_commands" };
  if (oldName && oldName !== name) sql.exec("DELETE FROM bot_commands WHERE name = ?", oldName);
  sql.exec(
    "INSERT INTO bot_commands (name, reply, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET reply = excluded.reply, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
    name,
    reply,
    Date.now(),
    actorName,
  );
  for (const counter of replyCounters(reply))
    sql.exec("INSERT OR IGNORE INTO bot_counters (name, value) VALUES (?, 0)", counter);
  logRoomEvent(room, "command", `${actorName} saved ${name}`, { channel, action });
  const longest = replyWorstCase(reply);
  return {
    ok: true,
    reason: "command_saved",
    name,
    ...(longest > MAX_CHAT_LINE ? { warning: "reply_may_be_cut", longest, max: MAX_CHAT_LINE } : {}),
  };
}

// A text command's reply, or "" during its cooldown (COMMAND_COOLDOWN_MS for everyone, COMMAND_USER_COOLDOWN_MS per
// chatter). Counters change only when the reply is sent.
export function customReply(
  room: ChannelRoom,
  row: { name: string; reply: string },
  ev: Partial<ChatEvent>,
  words: string[],
  now: number,
): string {
  const user = String(ev.chatter_user_id || ""),
    cool = (room.commandCooldowns ||= new Map());
  if (now < (cool.get(row.name) || 0) || now < (cool.get(row.name + " " + user) || 0)) return "";
  if (cool.size > 500) for (const [key, until] of cool) if (until <= now) cool.delete(key);
  cool.set(row.name, now + COMMAND_COOLDOWN_MS);
  cool.set(row.name + " " + user, now + COMMAND_USER_COOLDOWN_MS);
  const sql = room.ctx.storage.sql;
  return fitChatLine(
    renderCommandReply(row.reply, {
      user: String(ev.chatter_user_name || ev.chatter_user_login || ""),
      toUser: words[1] || "",
      count: (name, add) =>
        add
          ? sql
              .exec<{ value: number }>(
                "INSERT INTO bot_counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = MIN(value + 1, ?) RETURNING value",
                name,
                MAX_COUNTER,
              )
              .toArray()[0]!.value // RETURNING gives the upserted row
          : (sql.exec<{ value: number }>("SELECT value FROM bot_counters WHERE name = ?", name).toArray()[0]?.value ??
            0),
    }),
  );
}

// A saved fighter's Twitch account age, asked once (again after ACCOUNT_RETRY_MS while Twitch doesn't answer).
export async function checkAccountAge(room: ChannelRoom, userId: unknown): Promise<void> {
  const id = validUserId(userId),
    sql = room.ctx.storage.sql,
    now = Date.now();
  if (!id || !room.env?.TWITCH_CLIENT_ID) return;
  const row = sql
    .exec<Pick<ProfileTable, "account_created_at" | "account_checked_at">>(
      "SELECT account_created_at, account_checked_at FROM profiles WHERE user_id = ?",
      id,
    )
    .toArray()[0];
  if (!row || row.account_created_at > 0 || now - row.account_checked_at < ACCOUNT_RETRY_MS) return;
  sql.exec("UPDATE profiles SET account_checked_at = ? WHERE user_id = ?", now, id);
  try {
    const at = await room.lookupAccount(id);
    if (at > 0) sql.exec("UPDATE profiles SET account_created_at = ? WHERE user_id = ?", at, id);
  } catch (error) {
    // anything can be thrown
    logRoomEvent(room, "warn", `account age lookup failed: ${errorText(error, 80)}`, {
      userId: id,
    });
  }
}

// Of these user ids, the ones whose Twitch account is younger than NEW_ACCOUNT_MS. Unknown ages count as old.
export function newAccounts(room: ChannelRoom, ids: unknown[], now: number): string[] {
  const list = [...new Set(ids.map(validUserId).filter(Boolean))];
  if (!list.length) return [];
  return room.ctx.storage.sql
    .exec<{ user_id: string }>(
      `SELECT user_id FROM profiles WHERE account_created_at > ? AND user_id IN (${list.map(() => "?").join(", ")})`,
      now - NEW_ACCOUNT_MS,
      ...list,
    )
    .toArray()
    .map((r) => r.user_id);
}

// One channel.chat.message: a presence update, plus a game command when it parses as one (no replies; rejects logged).
export function processChatMessage(
  room: ChannelRoom,
  channel: string,
  msg: BotMessage,
  now: number,
  stream?: { id: string; startedAt: number } | null,
): ChatOutcome {
  const ev: Partial<ChatEvent> = msg.event && typeof msg.event === "object" ? msg.event : {};
  const userId = validUserId(ev.chatter_user_id);
  const username = normalizeUsername(ev.chatter_user_login);
  const displayName = String(ev.chatter_user_name || username)
    .trim()
    .slice(0, 48);
  const textValue = String(ev.message?.text || "").slice(0, 512);
  const color = /^#[0-9a-f]{6}$/i.test(ev.color || "") ? ev.color!.toUpperCase() : ""; // test() passed, so it is set
  const subscriptionId = String(msg.subscription?.id || "");
  let since = 0;
  const outcome = room.ctx.storage.transactionSync((): ChatOutcome => {
    let state = room.readState(channel);
    since = state.revision;
    const none = (reason: string): ChatOutcome => ({
      state,
      result: { ok: false, reason },
      changed: false,
      visible: false,
    });
    if (!subscriptionId || subscriptionId !== state.chat.subscriptionId) return none("unknown_subscription");
    const steps: ReduceOutput[] = [];
    const step = (event: GameEvent) => {
      const r = reduceGame(state, event, now);
      state = r.state;
      steps.push(r);
      return r;
    };
    // Twitch only notifies enabled subscriptions, so a notification also confirms a pending one.
    if (!state.chat.connected) step({ type: "chat_verified", subscriptionId });
    let main: { result: GameResult } | null = null;
    if (!userId || !/^[a-z0-9_]{1,25}$/.test(username) || !displayName)
      main = { result: { ok: false, reason: "invalid_event" } };
    else if (CHAT_BOTS.has(username) && msg.botPlays !== true) main = { result: { ok: false, reason: "chat_bot" } };
    else {
      const userProfile = getProfile(room, userId, state.config);
      // Registered players keep their saved look; other chatters take their Twitch name color.
      const profile = userProfile
        ? { ...userProfile, username, displayName }
        : { userId, username, displayName, ...(color ? { color } : {}) };
      const parsed = parseGameCommand(textValue);
      if (parsed) {
        const lastId =
          parsed.action === "rematch"
            ? state.players.find((p) => p.userId === userId)?.lastOpponentId || userProfile?.lastOpponentId
            : "";
        const targetProfile = parsed.target
          ? getProfileByUsername(room, parsed.target, state.config)
          : lastId
            ? getProfile(room, lastId, state.config)
            : null;
        const challengers = state.duels.filter((d) => d.status === "pending" && d.b === userId).map((d) => d.a);
        const young = newAccounts(room, [userId, targetProfile?.userId, lastId, ...challengers], now);
        main = step({
          type: "command",
          messageId: String(ev.message_id || msg.messageId).slice(0, 64),
          userId,
          username,
          displayName,
          text: textValue,
          timestamp: Number(msg.timestamp),
          profile,
          targetProfile,
          newAccounts: young,
          quick: subscriptionId === SE_SUBSCRIPTION_ID || msg.quick === true,
          rolls: Array.from({ length: 120 }, () => Math.random()), // 5 slots of 24 (settleQuickDuel)
          ...(stream !== undefined ? { stream } : {}),
        });
        if (!main.result.ok && main.result.reason !== "duplicate")
          step({
            type: "command_rejected",
            userId,
            command: parsed.action,
            reason: main.result.reason,
            retryAt: main.result.retryAt,
          });
      } else {
        const active = state.players.find((item) => item.userId === userId);
        const fresh =
          active &&
          now - active.lastSeen < PRESENCE_REFRESH_MS &&
          active.displayName === displayName &&
          (userProfile || !color || active.color === color);
        if (!fresh) main = step({ type: "presence", userId, username, displayName, profile });
      }
      const updated = state.players.find((item) => item.userId === userId);
      if (
        updated?.registered &&
        userProfile &&
        (updated.username !== userProfile.username || updated.displayName !== userProfile.displayName)
      )
        upsertProfile(room, updated);
      if (main?.result?.reason === "duel_completed" || main?.result?.reason === "quick_duel") {
        // save Elo, wins and losses
        const duel = state.duels.find((item) => item.id === main!.result.duelId); // checked in the condition above
        for (const id of duel ? [duel.a, duel.b] : []) {
          const participant = state.players.find((item) => item.userId === id);
          if (participant?.registered) upsertProfile(room, participant);
        }
      }
    }
    let changed = payDuels(room, state) || steps.some((r) => r.changed);
    if (changed || now - (Number(state.chat.lastSeen) || 0) >= LAST_SEEN_WRITE_MS) {
      state.chat.lastSeen = now;
      room.writeState(state);
      changed = true;
    }
    return {
      state,
      result: main?.result || { ok: true, reason: "presence_fresh" },
      changed,
      visible: steps.some((r) => r.visible),
    };
  });
  if (outcome.changed) room.traceEvents(channel, outcome.state, since);
  return outcome;
}

// "Challenge expired" lines for challenges that ran out after revision `since`, on a channel the bot reads. Each is said
// once: the alarm and a later command can both notice the same one.
function expiredLines(room: ChannelRoom, state: GameState, since: number): string[] {
  if (!room.botSource(state)) return [];
  room.expiredSaid ||= new Set();
  const names = botNames(room.seSettings().names),
    lines: string[] = [];
  const name = (id: string) => fighterName(room, state, id);
  for (const e of state.events) {
    if (e.type !== "challenge_expired" || Number(e.id) <= since || room.expiredSaid.has(e.id)) continue;
    room.expiredSaid.add(e.id);
    // a challenge_expired event names both fighters' ids
    lines.push(
      seExpiredText({
        a: name(e.a as string),
        b: name(e.b as string),
        timeoutMs: state.config.challengeTimeoutMs,
        names,
      }),
    );
  }
  if (room.expiredSaid.size > 200) room.expiredSaid = new Set([...room.expiredSaid].slice(-100));
  return lines;
}

// Posts the expired-challenge lines from the alarm as the bot (there is no chat line to answer), under the reply cap.
export async function postExpired(room: ChannelRoom, channel: string, since: number): Promise<void> {
  await postBotLines(room, channel, expiredLines(room, room.readState(channel), since));
}

// The result of each duel the stream has now played (revealAt in the last 2 minutes), once, so chat never spoils the
// replay. A line held back or refused stays due (the alarm wakes every RESULT_RETRY_MS) until it is 2 minutes old;
// a bot command also posts due results first, in case the alarm missed one.
export async function postResults(room: ChannelRoom, channel: string, now: number): Promise<void> {
  if (room.postingResults) return room.postingResults; // the alarm and a command at once: post each line once
  room.postingResults = postResultsOnce(room, channel, now).finally(() => {
    room.postingResults = null;
  });
  return room.postingResults;
}

async function postResultsOnce(room: ChannelRoom, channel: string, now: number): Promise<void> {
  const state = room.readState(channel),
    due = room.dueResults(state, now);
  if (!due.length) return;
  const sender = botSender(room);
  if (!sender) return;
  const name = (id: string) => fighterName(room, state, id);
  for (const d of due) {
    // in reveal order; one that can't go out now stops the rest, so chat keeps the order
    const loser = d.winnerId === d.a ? d.b : d.a;
    const line = seResultText({
      winner: name(d.winnerId as string), // a completed duel has a winner
      loser: name(loser),
      w: d.ratings[d.winnerId as string], // as above
      l: d.ratings[loser],
      decision: d.decision,
      flawless: d.flawless,
      unrated: d.unrated,
      lastRanked: d.lastRanked,
    });
    const { replies } = await sendBotLines(room, [line], channel, { system: 1 }).json<{ replies: string[] }>(); // sendBotLines's answer
    if (!replies.length) return;
    // A failed call (network, Twitch 5xx or 429 after its retries) is tried again; a line Twitch read and dropped
    // (AutoMod, chat settings) would be dropped again, so it counts as done.
    const { out, failed } = await sendAsBot(room, sender, replies[0]!); // checked non-empty above
    noteBotSent(room, channel, [out]);
    if (failed) return;
    room.ctx.storage.sql.exec(
      "UPDATE bot_reminder SET results_through = MAX(results_through, ?) WHERE id = 1",
      d.revealAt,
    );
  }
}

// Lines the bot posts on its own (no chat line to answer), under the reply cap.
async function postBotLines(room: ChannelRoom, channel: string, lines: string[]): Promise<void> {
  if (!lines.length || room.readState(channel).config.botEnabled === false) return;
  const sender = botSender(room);
  if (!sender) return;
  const { replies } = await sendBotLines(room, lines, channel, { system: lines.length }).json<{ replies: string[] }>(); // sendBotLines's answer
  for (const message of replies) noteBotSent(room, channel, [(await sendAsBot(room, sender, message)).out]);
}

type BotSender = { broadcaster_id: string; bot_id: string };
// Who the bot posts as and in which channel, saved from a bot command (bot_reminder); null before one.
function botSender(room: ChannelRoom): BotSender | null {
  const row = room.ctx.storage.sql
    .exec<BotSender>("SELECT broadcaster_id, bot_id FROM bot_reminder WHERE id = 1")
    .toArray()[0];
  return row?.broadcaster_id && row.bot_id ? row : null;
}
// One line posted as the bot. A call that throws (network, Twitch 5xx or 429 after its retries) comes back `failed`.
async function sendAsBot(
  room: ChannelRoom,
  to: BotSender,
  message: string,
): Promise<{ out: SendResult; failed: boolean }> {
  try {
    const out = await sendChatMessage(room.env, { broadcasterId: to.broadcaster_id, senderId: to.bot_id, message });
    return { out, failed: false };
  } catch (error) {
    return { out: { sent: false, reason: errorText(error) }, failed: true };
  }
}
// A fighter's shown name, from the arena or the saved profiles.
function fighterName(room: ChannelRoom, state: GameState, id: string): string {
  const p = state.players.find((x) => x.userId === id) || getProfile(room, id, state.config);
  return p?.displayName || p?.username || "someone";
}

// Saves who the reminder posts as (the bot) and in which channel, from a bot command. Writes only when something changed.
function rememberReminder(room: ChannelRoom, broadcasterId: unknown, botId: string, origin: unknown): void {
  broadcasterId = validUserId(broadcasterId);
  if (!broadcasterId || !botId) return;
  origin = String(origin || "").slice(0, 200);
  const sql = room.ctx.storage.sql,
    row = sql
      .exec<{ broadcaster_id: string; bot_id: string; origin: string }>(
        "SELECT broadcaster_id, bot_id, origin FROM bot_reminder WHERE id = 1",
      )
      .toArray()[0];
  if (row && row.broadcaster_id === broadcasterId && row.bot_id === botId && row.origin === origin) return;
  sql.exec(
    "INSERT INTO bot_reminder (id, broadcaster_id, bot_id, origin) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET broadcaster_id = excluded.broadcaster_id, bot_id = excluded.bot_id, origin = excluded.origin",
    broadcasterId,
    botId,
    origin,
  );
}
