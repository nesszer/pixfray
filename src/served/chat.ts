// Read-only Twitch IRC transport: no login secrets and no chat-send API. Identity comes only from Twitch tags.
import { warnOnce } from "./parse.ts";

const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
const tagEscapes: Record<string, string> = { s: " ", ":": ";", r: "\r", n: "\n", "\\": "\\" };

function parseIRCLine(line: string) {
  let rest = line.replace(/[\r\n]+$/, "");
  const tags: Record<string, string> = {};
  let prefix = "";
  if (rest.startsWith("@")) {
    const end = rest.indexOf(" ");
    if (end < 0) return null;
    for (const item of rest.slice(1, end).split(";")) {
      const at = item.indexOf("=");
      const key = at < 0 ? item : item.slice(0, at);
      const value = at < 0 ? "" : item.slice(at + 1);
      tags[key] = value.replace(/\\(.)/g, (_, character) => tagEscapes[character] ?? character);
    }
    rest = rest.slice(end + 1).trimStart();
  }
  if (rest.startsWith(":")) {
    const end = rest.indexOf(" ");
    if (end < 0) return null;
    prefix = rest.slice(1, end);
    rest = rest.slice(end + 1).trimStart();
  }
  const trailingIndex = rest.indexOf(" :");
  const trailing = trailingIndex < 0 ? null : rest.slice(trailingIndex + 2);
  const pieces = (trailingIndex < 0 ? rest : rest.slice(0, trailingIndex)).split(/ +/);
  const command = pieces.shift();
  if (!command) return null;
  return { tags, prefix, command: command.toUpperCase(), params: pieces, trailing };
}
type IrcLine = NonNullable<ReturnType<typeof parseIRCLine>>;

export type ChatMessage = {
  id: string | undefined;
  userId: string;
  username: string;
  displayName: string;
  color: string | null | undefined;
  badges: string[];
  text: string;
  timestamp: number;
};
export type ModerationEvent = {
  type: "clear" | "timeout" | "ban" | "delete";
  userId?: string | undefined;
  username?: string | undefined;
  duration?: number | undefined;
  messageId?: string | undefined;
};
export type ChatStatus = { state: string; channel: string; message: string; retryInMs?: number };
type ChatHandlers = {
  onMessage?: (message: ChatMessage) => void;
  onModeration?: (event: ModerationEvent) => void;
  onStatus?: (status: ChatStatus) => void;
};

export function connectChat(
  channel: string,
  { onMessage = () => {}, onModeration = () => {}, onStatus = () => {} }: ChatHandlers = {},
) {
  channel = String(channel ?? "")
    .replace(/^#/, "")
    .toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(channel)) throw new Error("Invalid Twitch channel name");
  const room = "#" + channel;
  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdogTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let attempts = 0;
  let lastReceivedAt = Date.now();
  let joined = false;
  const seen = new Set<string>();

  function status(state: string, message: string, retryInMs?: number) {
    onStatus({ state, channel, message, ...(retryInMs ? { retryInMs } : {}) });
  }
  function scheduleReconnect() {
    if (stopped || retryTimer) return;
    const retryInMs = Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)) + Math.floor(Math.random() * 500);
    status("reconnecting", "Twitch disconnected; retrying automatically", retryInMs);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      open();
    }, retryInMs);
  }
  function markJoined(here: boolean) {
    if (!here || joined) return;
    joined = true;
    attempts = 0;
    status("connected", "Listening to " + room);
  }
  function message({ tags, prefix, trailing }: IrcLine) {
    const username = prefix.split("!")[0];
    if (!username || trailing === null) return;
    if (tags.id && seen.has(tags.id)) return;
    if (tags.id) {
      seen.add(tags.id);
      if (seen.size > 1000) seen.delete(seen.values().next().value!); // over 1000 entries, so a first one exists
    }
    onMessage({
      id: tags.id || undefined,
      userId: tags["user-id"] || username,
      username,
      displayName: tags["display-name"] || username,
      color: /^#[0-9a-f]{6}$/i.test(tags.color ?? "") ? tags.color : null,
      badges: (tags.badges || "").split(",").filter(Boolean),
      text: trailing.slice(0, 1000),
      timestamp: Number(tags["tmi-sent-ts"]) || Date.now(),
    });
  }
  // the IRC commands this transport acts on; any other command is ignored
  const ON: Record<string, (item: IrcLine, active: WebSocket) => void> = {
    PING: (item, active) => active.send("PONG :" + (item.trailing ?? item.params.join(" ")) + "\r\n"),
    RECONNECT: (_, active) => active.close(),
    "001": (_, active) => active.send("JOIN " + room + "\r\n"),
    JOIN: (item) => markJoined(item.params[0] === room),
    ROOMSTATE: (item) => markJoined(item.params[0] === room),
    "366": (item) => markJoined(item.params.includes(room)),
    NOTICE: (item) => status("error", item.trailing ?? "Twitch sent a notice"),
    PRIVMSG: (item) => {
      if (item.params[0] === room) message(item);
    },
    CLEARCHAT: ({ params, tags, trailing }) => {
      if (params[0] !== room) return;
      const duration = Number(tags["ban-duration"]);
      onModeration({
        type: !trailing ? "clear" : tags["ban-duration"] ? "timeout" : "ban",
        userId: tags["target-user-id"] || undefined,
        username: trailing || undefined,
        duration: Number.isFinite(duration) ? duration : undefined,
      });
    },
    CLEARMSG: ({ params, tags }) => {
      if (params[0] === room) onModeration({ type: "delete", username: tags.login, messageId: tags["target-msg-id"] });
    },
  };
  function handle(line: string, active: WebSocket) {
    const item = parseIRCLine(line);
    if (item) ON[item.command]?.(item, active);
    // a line that isn't IRC at all; an IRC command this file doesn't handle is no reason to warn
    else if (line.trim()) warnOnce("a Twitch chat line", "not an IRC message");
  }
  function open() {
    if (stopped) return;
    clearInterval(watchdogTimer);
    joined = false;
    status("connecting", "Connecting to Twitch chat");
    const activeSocket = new WebSocket(IRC_URL);
    socket = activeSocket;
    lastReceivedAt = Date.now();
    activeSocket.onopen = () => {
      if (stopped || socket !== activeSocket) {
        activeSocket.close();
        return;
      }
      activeSocket.send("CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership\r\n");
      activeSocket.send("PASS SCHMOOPIIE\r\n");
      activeSocket.send("NICK justinfan" + Math.floor(10000 + Math.random() * 900000) + "\r\n");
    };
    activeSocket.onmessage = ({ data }) => {
      if (stopped || socket !== activeSocket || typeof data !== "string") return;
      lastReceivedAt = Date.now();
      for (const line of data.split("\r\n")) if (line) handle(line, activeSocket);
    };
    activeSocket.onerror = () => {
      if (!stopped && socket === activeSocket) status("error", "Twitch connection error");
    };
    activeSocket.onclose = () => {
      if (socket !== activeSocket) return;
      clearInterval(watchdogTimer);
      scheduleReconnect();
    };
    watchdogTimer = setInterval(() => {
      if (Date.now() - lastReceivedAt > 300000 || (!joined && Date.now() - lastReceivedAt > 30000)) {
        activeSocket.close();
      }
    }, 5000);
  }
  open();
  return {
    disconnect() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(watchdogTimer);
      socket?.close();
      status("offline", "Chat disconnected");
    },
  };
}
