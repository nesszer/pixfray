import { isArenaChat, isObject, parseArenaEvent, parseArenaSnapshot, parseLooksMessage, warnOnce } from "./parse.ts";
import type { ArenaChat, ArenaEvent, ArenaSnapshot, LooksMessage } from "./parse.ts";
import { channelName } from "./text.ts";

type SnapshotMeta = { revision: number | null; source: string };
type ArenaStatus = {
  state: string;
  message?: string | undefined;
  revision?: number | null;
  retryInMs?: number;
  transport?: string;
  chat?: ArenaChat | null | undefined;
  lastSeen?: number | undefined;
};
type ArenaClientOptions = {
  channel: string;
  role?: string;
  onSnapshot?: (snapshot: ArenaSnapshot, meta: SnapshotMeta) => void;
  onEvent?: (event: ArenaEvent) => void;
  onLooks?: (message: LooksMessage) => void;
  onDrop?: () => void;
  onStatus?: (status: ArenaStatus) => void;
  pingMs?: number;
  watchdogMs?: number;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: new (url: string) => WebSocket;
};

const MAX_SEEN_EVENTS = 2000;
const MAX_RETRY_MS = 30_000;

function revisionOf(value: unknown) {
  const revision = Number(isObject(value) ? value.revision : undefined);
  return Number.isFinite(revision) && revision >= 0 ? revision : null;
}

/** Read-only client for the channel arena stream: the backend owns every profile, health value, event and rating. */
export function createArenaClient({
  channel,
  role = "", // 'overlay' lets the admin page count open OBS overlays
  onSnapshot = () => {},
  onEvent = () => {},
  onLooks = () => {}, // {type:'looks'} pushes: saved fighters changed for viewers the snapshot doesn't list
  // A dropped snapshot may come from a newer server than this client reads; the overlay then asks for its page again.
  onDrop = () => {},
  onStatus = () => {},
  // A socket can go half open: the network dropped but no close event came, so the overlay would freeze on its last
  // picture. The client sends "ping" every pingMs and the room's auto-response answers "pong" without waking it, so a
  // socket with no message at all for watchdogMs is dead and gets replaced. 0 turns either off.
  pingMs = 20_000,
  watchdogMs = 45_000,
  fetchImpl = (...args: Parameters<typeof fetch>) => fetch(...args),
  // Called with `new`, so this must be a plain function (an arrow function throws "is not a constructor").
  // as: a plain function that returns an object works with `new`, which TypeScript only allows for a construct signature
  WebSocketImpl = function (url: string) {
    return new WebSocket(url);
  } as unknown as new (url: string) => WebSocket,
}: ArenaClientOptions) {
  const normalizedChannel = channelName(channel);
  if (!normalizedChannel) throw new Error("Invalid arena channel");

  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  let revision: number | null = null;
  let generation = 0;
  const seenEventIds = new Set<string>();
  // Server clock minus local clock, from the latest snapshot. Server times are shifted into local time on arrival,
  // because the overlay compares them with Date.now() and a PC clock can be off by many seconds.
  let clockOffset = 0;
  const local = (value: number) => (value > 0 ? value - clockOffset : value);
  function localEvent(event: ArenaEvent): ArenaEvent {
    if (!clockOffset) return event;
    const out = { ...event };
    if (out.at !== undefined) out.at = local(out.at);
    if (out.respawnAt) out.respawnAt = local(out.respawnAt);
    return out;
  }
  function localChat(chat: ArenaChat | null | undefined) {
    return chat && { ...chat, lastSeen: chat.lastSeen === undefined ? undefined : local(chat.lastSeen) };
  }
  function localSnapshot(snapshot: ArenaSnapshot): ArenaSnapshot {
    if (snapshot.serverNow !== undefined) clockOffset = snapshot.serverNow - Date.now();
    if (!clockOffset) return snapshot;
    return {
      ...snapshot,
      chat: localChat(snapshot.chat),
      players: snapshot.players?.map((p) => (p.respawnAt ? { ...p, respawnAt: local(p.respawnAt) } : p)),
      events: snapshot.events?.map(localEvent),
    };
  }

  function status(state: string, detail: Omit<ArenaStatus, "state"> = {}) {
    if (!stopped) onStatus({ state, ...detail });
  }

  function rememberEvent(event: ArenaEvent) {
    const id = event.id;
    if (id === undefined || id === "") return true;
    if (seenEventIds.has(id)) return false;
    seenEventIds.add(id);
    if (seenEventIds.size > MAX_SEEN_EVENTS) {
      const oldest = seenEventIds.values().next().value;
      seenEventIds.delete(oldest!); // over MAX_SEEN_EVENTS entries, so a first one exists
    }
    return true;
  }

  /** The snapshot in a frame or an /api/state answer ({ snapshot }, { state } or the object itself), parsed;
   * undefined (after one warning) when it is dropped. */
  function parsedSnapshot(input: unknown) {
    const parsed = parseArenaSnapshot(isObject(input) ? (input.snapshot ?? input.state ?? input) : input);
    if (parsed.ok) return parsed.value;
    warnOnce("an arena snapshot", parsed.error);
    onDrop();
    return undefined;
  }

  /** Hands a newer snapshot to onSnapshot and its new events to onEvent; null when it is older than the last one. */
  function receiveSnapshot(raw: ArenaSnapshot, source: string) {
    const snapshot = localSnapshot(raw);
    const incomingRevision = revisionOf(snapshot);
    if (incomingRevision !== null && revision !== null && incomingRevision < revision) return null;
    if (incomingRevision !== null) revision = incomingRevision;
    onSnapshot(snapshot, { revision, source });
    for (const event of snapshot.events ?? []) if (rememberEvent(event)) onEvent(event);
    return snapshot;
  }

  async function fetchSnapshot(reason: string) {
    const controller = new AbortController();
    const activeGeneration = generation;
    try {
      const response = await fetchImpl(`/api/state/${encodeURIComponent(normalizedChannel)}`, {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Arena state HTTP ${response.status}`);
      const payload: unknown = await response.json();
      if (stopped || activeGeneration !== generation) return;
      const snapshot = parsedSnapshot(payload);
      if (snapshot) receiveSnapshot(snapshot, `http:${reason}`);
    } catch (error: any) {
      // any: whatever was thrown; ?. reads its name and message when it has them
      if (stopped || activeGeneration !== generation || error?.name === "AbortError") return;
      status("offline", { message: error?.message || "Arena state unavailable", revision });
    }
  }

  function scheduleReconnect(activeSocket: WebSocket | null, detail: Omit<ArenaStatus, "state"> = {}) {
    if (stopped || socket !== activeSocket || retryTimer) return;
    const base = Math.min(MAX_RETRY_MS, 500 * 2 ** Math.min(retryAttempt++, 6));
    const retryInMs = Math.min(MAX_RETRY_MS, base + Math.floor(Math.random() * Math.min(500, base / 3)));
    status("reconnecting", { retryInMs, revision, ...detail });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryInMs);
  }

  let watchdog: ReturnType<typeof setTimeout> | null = null;
  function armWatchdog() {
    clearTimeout(watchdog!); // clearTimeout(null) does nothing
    watchdog = stopped || !(watchdogMs > 0) ? null : setTimeout(watchdogTick, watchdogMs);
  }
  // Drop the current socket without waiting for its close event and open a fresh one now.
  function reconnectNow() {
    const old = socket;
    socket = null; // its late close event is then ignored
    clearTimeout(retryTimer!); // clearTimeout(null) does nothing
    retryTimer = null;
    retryAttempt = 0;
    try {
      old?.close();
    } catch {
      /* already gone */
    }
    connect();
  }
  function watchdogTick() {
    watchdog = null;
    if (stopped) return;
    if (retryTimer) return armWatchdog(); // already reconnecting
    status("reconnecting", { message: "Arena stream went silent; reconnecting", revision });
    reconnectNow();
  }
  let pinger: ReturnType<typeof setInterval> | null = null;
  function startPing(activeSocket: WebSocket) {
    clearInterval(pinger!); // clearInterval(null) does nothing
    pinger =
      stopped || !(pingMs > 0)
        ? null
        : setInterval(() => {
            if (socket !== activeSocket || activeSocket.readyState !== 1) return;
            try {
              activeSocket.send("ping");
            } catch {
              /* the watchdog notices */
            }
          }, pingMs);
  }

  function handleMessage(data: unknown, activeSocket: WebSocket) {
    if (stopped || socket !== activeSocket) return;
    armWatchdog(); // any message shows the stream is alive
    if (typeof data !== "string" || data === "pong") return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      warnOnce("an arena frame", "not JSON");
      return;
    }
    if (!isObject(payload)) {
      warnOnce("an arena frame", "not a JSON object");
      return;
    }

    if (payload.type === "looks") {
      // not a snapshot or an event: it carries no revision
      const looks = parseLooksMessage(payload);
      if (looks.ok) onLooks(looks.value);
      else warnOnce("a looks push", looks.error);
      return;
    }
    const hasSnapshotFields = ["players", "duels", "chat", "config", "events", "snapshot", "state"].some((key) =>
      Object.prototype.hasOwnProperty.call(payload, key),
    );
    if (
      payload.type === "event" ||
      payload.event ||
      (!hasSnapshotFields && payload.type && payload.type !== "snapshot")
    ) {
      const parsed = parseArenaEvent(isObject(payload.event) ? payload.event : payload);
      const chat = payload.chat;
      if (!parsed.ok || !isArenaChat(chat)) {
        warnOnce("an arena event", parsed.error || "chat has the wrong type");
        return;
      }
      const event = parsed.value;
      const eventRevision = revisionOf(payload) ?? revisionOf(event);
      if (eventRevision !== null && revision !== null && eventRevision < revision) return;
      if (eventRevision !== null) revision = Math.max(revision ?? 0, eventRevision);
      if (rememberEvent(event)) onEvent(localEvent(event));
      status("connected", { revision, chat: localChat(chat) });
      return;
    }

    const parsed = parsedSnapshot(payload);
    if (!parsed) return;
    // an older snapshot isn't shown, but its chat state still sets the status, as before
    const snapshot = receiveSnapshot(parsed, "websocket") ?? localSnapshot(parsed);
    status(snapshot.chat?.connected === false ? "degraded" : "connected", {
      revision,
      chat: snapshot.chat,
      lastSeen: snapshot.chat?.lastSeen,
    });
  }

  function connect() {
    if (stopped) return;
    const activeGeneration = ++generation;
    socket = null;
    status("connecting", { revision });
    const protocol = location.protocol === "https:" ? "wss:" : "ws:",
      query = role === "overlay" ? "?role=overlay" : "";
    const url = `${protocol}//${location.host}/api/live/${encodeURIComponent(normalizedChannel)}${query}`;
    let activeSocket: WebSocket;
    try {
      activeSocket = new WebSocketImpl(url);
    } catch (error: any) {
      // any: whatever was thrown; ?. reads its message when it has one
      status("offline", { message: error?.message || "Arena websocket unavailable", revision });
      scheduleReconnect(null, { message: error?.message });
      return;
    }
    socket = activeSocket;
    armWatchdog();

    activeSocket.onopen = () => {
      if (stopped || socket !== activeSocket || generation !== activeGeneration) {
        activeSocket.close();
        return;
      }
      retryAttempt = 0;
      startPing(activeSocket);
      status("connected", { revision, transport: "websocket" });
      void fetchSnapshot("connect");
    };
    activeSocket.onmessage = ({ data }) => handleMessage(data, activeSocket);
    activeSocket.onerror = () => {
      if (!stopped && socket === activeSocket) status("degraded", { message: "Arena stream interrupted", revision });
    };
    activeSocket.onclose = () => {
      if (stopped || socket !== activeSocket) return;
      scheduleReconnect(activeSocket);
    };
  }

  connect();
  void fetchSnapshot("initial");

  return {
    get revision() {
      return revision;
    },
    disconnect() {
      if (stopped) return;
      stopped = true;
      generation++;
      // clearTimeout(null) and clearInterval(null) do nothing
      clearTimeout(retryTimer!);
      retryTimer = null;
      clearTimeout(watchdog!);
      watchdog = null;
      clearInterval(pinger!);
      pinger = null;
      const activeSocket = socket;
      socket = null;
      activeSocket?.close();
      onStatus({ state: "offline", message: "Arena disconnected", revision });
    },
  };
}
