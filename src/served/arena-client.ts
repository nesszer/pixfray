/** A value parsed from the server's JSON: unchecked until TS20 adds parsing, so every field is narrowed where it is read. */
export type Json = { [key: string]: Json } | Json[] | string | number | boolean | null | undefined;
export type JsonRecord = { [key: string]: Json };
export type SnapshotMeta = { revision: number | null; source: string };
export type ArenaStatus = {
  state: string;
  message?: string | undefined;
  revision?: number | null;
  retryInMs?: number;
  transport?: string;
  chat?: Json;
  lastSeen?: Json;
};
type ArenaClientOptions = {
  channel: string;
  role?: string;
  onSnapshot?: (snapshot: JsonRecord, meta: SnapshotMeta) => void;
  onEvent?: (event: Json) => void;
  onLooks?: (message: JsonRecord) => void;
  onStatus?: (status: ArenaStatus) => void;
  pingMs?: number;
  watchdogMs?: number;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: new (url: string) => WebSocket;
};

const MAX_SEEN_EVENTS = 2000;
const MAX_RETRY_MS = 30_000;

function snapshotFrom(value: Json) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value.snapshot ?? value.state ?? value;
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  return state;
}

function revisionOf(value: Json) {
  // a JSON value: ?. covers null and undefined, other kinds give undefined
  const revision = Number((value as JsonRecord | null | undefined)?.revision);
  return Number.isFinite(revision) && revision >= 0 ? revision : null;
}

/**
 * Read-only client for the channel arena stream. The backend owns every player
 * profile, duel health value, event and rating. This client only renders them.
 */
export function createArenaClient({
  channel,
  role = "", // 'overlay' lets the admin page count open OBS overlays
  onSnapshot = () => {},
  onEvent = () => {},
  onLooks = () => {}, // {type:'looks'} pushes: saved fighters changed for viewers the snapshot doesn't list
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
  const normalizedChannel = String(channel ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 25);
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
  const local = (value: Json) => (Number(value) > 0 ? Number(value) - clockOffset : value);
  function localEvent(event: Json) {
    if (!clockOffset || !event || typeof event !== "object") return event;
    const out = { ...(event as JsonRecord) }; // as: an array spreads to index keys, none of them at or respawnAt
    if (Number.isFinite(out.at)) out.at = local(out.at);
    if (out.respawnAt) out.respawnAt = local(out.respawnAt);
    return out;
  }
  function localSnapshot(snapshot: JsonRecord): JsonRecord {
    if (Number.isFinite(snapshot.serverNow)) clockOffset = snapshot.serverNow - Date.now();
    if (!clockOffset) return snapshot;
    return {
      ...snapshot,
      // as: the server sends chat as an object or null; on any other value the spread and the read give nothing
      chat: snapshot.chat && {
        ...(snapshot.chat as JsonRecord),
        lastSeen: local((snapshot.chat as JsonRecord).lastSeen),
      },
      players: Array.isArray(snapshot.players)
        ? // as: players are objects; on any other value the read gives undefined and p passes through
          snapshot.players.map((p) =>
            p && (p as JsonRecord).respawnAt
              ? { ...(p as JsonRecord), respawnAt: local((p as JsonRecord).respawnAt) }
              : p,
          )
        : snapshot.players,
      events: Array.isArray(snapshot.events) ? snapshot.events.map(localEvent) : snapshot.events,
    };
  }

  function status(state: string, detail: Omit<ArenaStatus, "state"> = {}) {
    if (!stopped) onStatus({ state, ...detail });
  }

  function rememberEvent(event: Json) {
    if (!event || typeof event !== "object") return false;
    const id = (event as JsonRecord).id ?? (event as JsonRecord).eventId; // as: an array has neither key, as at runtime
    if (id === undefined || id === null || id === "") return true;
    const key = String(id);
    if (seenEventIds.has(key)) return false;
    seenEventIds.add(key);
    if (seenEventIds.size > MAX_SEEN_EVENTS) {
      const oldest = seenEventIds.values().next().value;
      seenEventIds.delete(oldest!); // over MAX_SEEN_EVENTS entries, so a first one exists
    }
    return true;
  }

  function dispatchEvents(events: Json) {
    if (!Array.isArray(events)) return;
    for (const event of events) {
      if (rememberEvent(event)) onEvent(event);
    }
  }

  function receiveSnapshot(input: Json, source: string) {
    const raw = snapshotFrom(input);
    if (!raw) return false;
    const snapshot = localSnapshot(raw);
    const incomingRevision = revisionOf(snapshot);
    if (incomingRevision !== null && revision !== null && incomingRevision < revision) return false;
    if (incomingRevision !== null) revision = incomingRevision;
    onSnapshot(snapshot, { revision, source });
    dispatchEvents(snapshot.events);
    return true;
  }

  async function fetchSnapshot(reason: string) {
    const controller = new AbortController();
    const activeGeneration = generation;
    try {
      const response = await fetchImpl("/api/state/" + encodeURIComponent(normalizedChannel), {
        method: "GET",
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Arena state HTTP " + response.status);
      const payload: Json = await response.json();
      if (!stopped && activeGeneration === generation) receiveSnapshot(payload, "http:" + reason);
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
    let payload: Json;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;

    if (payload.type === "looks") {
      // not a snapshot or an event: it carries no revision
      if (payload.looks && typeof payload.looks === "object") onLooks(payload);
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
      const event = payload.event && typeof payload.event === "object" ? payload.event : payload;
      const eventRevision = revisionOf(payload) ?? revisionOf(event);
      if (eventRevision !== null && revision !== null && eventRevision < revision) return;
      if (eventRevision !== null) revision = Math.max(revision ?? 0, eventRevision);
      if (rememberEvent(event)) onEvent(localEvent(event));
      status("connected", {
        revision,
        // as: the server sends chat as an object or null; on any other value the spread and the read give nothing
        chat: payload.chat && {
          ...(payload.chat as JsonRecord),
          lastSeen: local((payload.chat as JsonRecord).lastSeen),
        },
      });
      return;
    }

    receiveSnapshot(payload, "websocket");
    const raw = snapshotFrom(payload);
    const snapshot = raw && localSnapshot(raw);
    // as: the server sends chat as an object or null; on any other value ?. reads give undefined
    if (snapshot)
      status((snapshot.chat as JsonRecord | null | undefined)?.connected === false ? "degraded" : "connected", {
        revision,
        chat: snapshot.chat,
        lastSeen: (snapshot.chat as JsonRecord | null | undefined)?.lastSeen,
      });
  }

  function connect() {
    if (stopped) return;
    const activeGeneration = ++generation;
    socket = null;
    status("connecting", { revision });
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url =
      protocol +
      "//" +
      location.host +
      "/api/live/" +
      encodeURIComponent(normalizedChannel) +
      (role === "overlay" ? "?role=overlay" : "");
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
