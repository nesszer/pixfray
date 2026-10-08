/**
 * Read-only Twitch IRC transport. No login secrets and no chat-send API.
 * Chat identity comes exclusively from Twitch tags, never command arguments.
 */
const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
const tagEscapes = { s: " ", ":": ";", r: "\r", n: "\n", "\\": "\\" };

export function parseIRCLine(line) {
  if (typeof line !== "string" || !line.trim()) return null;
  let rest = line.replace(/[\r\n]+$/, "");
  const tags = {};
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

function commandFromText(text) {
  const match = /^!(jump|avatar|color)(?:\s+([^\s]+))?\s*$/i.exec(text);
  if (!match) return null;
  const type = match[1].toLowerCase();
  const value = match[2] ?? "";
  if (type === "jump" && !value) return { type };
  if (type === "avatar" && /^\d{1,2}$/.test(value)) return { type, value: Number(value) };
  if (type === "color" && /^#[0-9a-f]{6}$/i.test(value)) return { type, value: value.toUpperCase() };
  return null;
}

export function connectChat(channel, { onMessage = () => {}, onModeration = () => {}, onStatus = () => {} } = {}) {
  channel = String(channel ?? "")
    .replace(/^#/, "")
    .toLowerCase();
  if (!/^[a-z0-9_]{1,25}$/.test(channel)) throw new Error("Invalid Twitch channel name");
  let socket;
  let retryTimer;
  let watchdogTimer;
  let stopped = false;
  let attempts = 0;
  let lastReceivedAt = Date.now();
  let joined = false;
  const seen = new Set();

  function status(state, message, retryInMs) {
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
  function handle(line, activeSocket) {
    const item = parseIRCLine(line);
    if (!item) return;
    if (item.command === "PING") {
      activeSocket.send("PONG :" + (item.trailing ?? item.params.join(" ")) + "\r\n");
      return;
    }
    if (item.command === "RECONNECT") {
      activeSocket.close();
      return;
    }
    if (item.command === "001") {
      activeSocket.send("JOIN #" + channel + "\r\n");
    }
    if (
      (item.command === "JOIN" && item.params[0] === "#" + channel) ||
      (item.command === "ROOMSTATE" && item.params[0] === "#" + channel) ||
      (item.command === "366" && item.params.includes("#" + channel))
    ) {
      if (!joined) {
        joined = true;
        attempts = 0;
        status("connected", "Listening to #" + channel);
      }
    }
    if (item.command === "NOTICE") {
      status("error", item.trailing ?? "Twitch sent a notice");
    }
    if (item.params[0] !== "#" + channel) return;
    const { tags } = item;
    if (item.command === "PRIVMSG") {
      const username = item.prefix.split("!")[0];
      if (!username || item.trailing === null) return;
      if (tags.id && seen.has(tags.id)) return;
      if (tags.id) {
        seen.add(tags.id);
        if (seen.size > 1000) seen.delete(seen.values().next().value);
      }
      onMessage({
        id: tags.id || undefined,
        userId: tags["user-id"] || username,
        username,
        displayName: tags["display-name"] || username,
        color: /^#[0-9a-f]{6}$/i.test(tags.color ?? "") ? tags.color : null,
        badges: (tags.badges || "").split(",").filter(Boolean),
        text: item.trailing.slice(0, 1000),
        timestamp: Number(tags["tmi-sent-ts"]) || Date.now(),
        command: commandFromText(item.trailing),
      });
    } else if (item.command === "CLEARCHAT") {
      const duration = Number(tags["ban-duration"]);
      onModeration({
        type: !item.trailing ? "clear" : tags["ban-duration"] ? "timeout" : "ban",
        userId: tags["target-user-id"] || undefined,
        username: item.trailing || undefined,
        duration: Number.isFinite(duration) ? duration : undefined,
      });
    } else if (item.command === "CLEARMSG") {
      onModeration({ type: "delete", username: tags.login, messageId: tags["target-msg-id"] });
    }
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
