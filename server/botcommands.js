// The PixFray bot's own text commands, set on the admin page (Chat commands): a name like !sens and the line the bot
// answers with. A reply may use ${user} (who typed it), ${touser} (the @name after the command, else ${user}),
// ${count name} (adds 1 to counter "name" and shows it) and ${getcount name} (shows it). $(...) works the same, as in
// StreamElements.

export const MAX_BOT_COMMANDS = 50;
export const MAX_COMMAND_REPLY = 400;
export const MAX_COUNTER = 1_000_000_000;
export const COMMAND_COOLDOWN_MS = 5_000; // per command, for everyone
export const COMMAND_USER_COOLDOWN_MS = 15_000; // per command, per chatter
export const MAX_CHAT_LINE = 480; // a filled-in reply is cut here (Twitch drops lines over 500)

// "!Sens", "sens" -> "!sens"; "" when it isn't 1 to 24 letters, digits or underscores.
export function commandName(raw) {
  const name = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^!/, "");
  return /^[a-z0-9_]{1,24}$/.test(name) ? "!" + name : "";
}

export function counterName(raw) {
  const name = String(raw ?? "")
    .trim()
    .toLowerCase();
  return /^[a-z0-9_]{1,24}$/.test(name) ? name : "";
}

export function commandReplyText(raw) {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

const VARIABLE = /\$[({]\s*(user|sender|touser|count|getcount)(?:\s+([a-z0-9_]{1,24}))?\s*[)}]/gi;

// The counters a reply adds to (${count name}), lowercased, without duplicates.
export function replyCounters(reply) {
  const names = new Set();
  for (const m of String(reply).matchAll(VARIABLE))
    if (m[1].toLowerCase() === "count" && m[2]) names.add(m[2].toLowerCase());
  return [...names];
}

// Fills in a reply. count(name, add) returns the counter's value after adding (add is 1 or 0).
export function renderCommandReply(reply, { user = "", toUser = "", count = () => 0 } = {}) {
  const target =
    String(toUser || "")
      .replace(/^@/, "")
      .match(/^[a-z0-9_]{1,25}/i)?.[0] || user;
  return String(reply).replace(VARIABLE, (whole, kind, name) => {
    kind = kind.toLowerCase();
    if (kind === "user" || kind === "sender") return user;
    if (kind === "touser") return target;
    return name ? String(count(name.toLowerCase(), kind === "count" ? 1 : 0)) : whole;
  });
}

// The longest a reply can get once filled in: a name is up to 25 characters, a counter up to 10 digits.
export function replyWorstCase(reply) {
  return String(reply).replace(VARIABLE, (whole, kind, name) => {
    kind = kind.toLowerCase();
    if (kind === "count" || kind === "getcount") return name ? "0".repeat(String(MAX_COUNTER).length) : whole;
    return "x".repeat(25);
  }).length;
}

// A line cut to MAX_CHAT_LINE characters at a word break, with "…" when cut.
export function fitChatLine(line, max = MAX_CHAT_LINE) {
  line = String(line);
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1),
    space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).trimEnd() + "…";
}
