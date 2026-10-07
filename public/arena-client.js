const MAX_SEEN_EVENTS = 2000;
const MAX_RETRY_MS = 30_000;

function snapshotFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value.snapshot ?? value.state ?? value;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  return state;
}

function revisionOf(value) {
  const revision = Number(value?.revision);
  return Number.isFinite(revision) && revision >= 0 ? revision : null;
}

/**
 * Read-only client for the channel arena stream. The backend owns every player
 * profile, duel health value, event and rating. This client only renders them.
 */
export function createArenaClient({
  channel,
  role = '',   // 'overlay' lets the admin page count open OBS overlays
  onSnapshot = () => {},
  onEvent = () => {},
  onLooks = () => {},   // {type:'looks'} pushes: saved fighters changed for viewers the snapshot doesn't list
  onStatus = () => {},
  // A socket that goes silent (no message for this long) may be half open: the network dropped but no close event came,
  // so the overlay would freeze on its last picture. The server sends no pings, so the client asks /api/state instead and
  // reconnects if the arena moved on without telling it. 0 turns the watchdog off.
  watchdogMs = 45_000,
  fetchImpl = (...args) => fetch(...args),
  // Called with `new`, so this must be a plain function (an arrow function throws "is not a constructor").
  WebSocketImpl = function (...args) { return new WebSocket(...args); },
}) {
  const normalizedChannel = String(channel ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 25);
  if (!normalizedChannel) throw new Error('Invalid arena channel');

  let stopped = false;
  let socket = null;
  let retryTimer = null;
  let retryAttempt = 0;
  let revision = null;
  let generation = 0;
  const seenEventIds = new Set();
  // Server clock minus local clock, from the latest snapshot. Server times are shifted into local time on arrival,
  // because the overlay compares them with Date.now() and a PC clock can be off by many seconds.
  let clockOffset = 0;
  const local = (value) => (Number(value) > 0 ? Number(value) - clockOffset : value);
  function localEvent(event) {
    if (!clockOffset || !event || typeof event !== 'object') return event;
    const out = { ...event };
    if (Number.isFinite(out.at)) out.at = local(out.at);
    if (out.respawnAt) out.respawnAt = local(out.respawnAt);
    return out;
  }
  function localSnapshot(snapshot) {
    if (Number.isFinite(snapshot.serverNow)) clockOffset = snapshot.serverNow - Date.now();
    if (!clockOffset) return snapshot;
    return {
      ...snapshot,
      chat: snapshot.chat && { ...snapshot.chat, lastSeen: local(snapshot.chat.lastSeen) },
      players: Array.isArray(snapshot.players) ? snapshot.players.map(p => (p && p.respawnAt ? { ...p, respawnAt: local(p.respawnAt) } : p)) : snapshot.players,
      events: Array.isArray(snapshot.events) ? snapshot.events.map(localEvent) : snapshot.events,
    };
  }

  function status(state, detail = {}) {
    if (!stopped) onStatus({ state, ...detail });
  }

  function rememberEvent(event) {
    if (!event || typeof event !== 'object') return false;
    const id = event.id ?? event.eventId;
    if (id === undefined || id === null || id === '') return true;
    const key = String(id);
    if (seenEventIds.has(key)) return false;
    seenEventIds.add(key);
    if (seenEventIds.size > MAX_SEEN_EVENTS) {
      const oldest = seenEventIds.values().next().value;
      seenEventIds.delete(oldest);
    }
    return true;
  }

  function dispatchEvents(events) {
    if (!Array.isArray(events)) return;
    for (const event of events) {
      if (rememberEvent(event)) onEvent(event);
    }
  }

  function receiveSnapshot(input, source) {
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

  async function fetchSnapshot(reason) {
    const controller = new AbortController();
    const activeGeneration = generation;
    try {
      const response = await fetchImpl('/api/state/' + encodeURIComponent(normalizedChannel), {
        method: 'GET',
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Arena state HTTP ' + response.status);
      const payload = await response.json();
      if (!stopped && activeGeneration === generation) receiveSnapshot(payload, 'http:' + reason);
    } catch (error) {
      if (stopped || activeGeneration !== generation || error?.name === 'AbortError') return;
      status('offline', { message: error?.message || 'Arena state unavailable', revision });
    }
  }

  function scheduleReconnect(activeSocket, detail = {}) {
    if (stopped || socket !== activeSocket || retryTimer) return;
    const base = Math.min(MAX_RETRY_MS, 500 * (2 ** Math.min(retryAttempt++, 6)));
    const retryInMs = Math.min(MAX_RETRY_MS, base + Math.floor(Math.random() * Math.min(500, base / 3)));
    status('reconnecting', { retryInMs, revision, ...detail });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryInMs);
  }

  let watchdog = null;
  function armWatchdog() {
    clearTimeout(watchdog);
    watchdog = stopped || !(watchdogMs > 0) ? null : setTimeout(watchdogTick, watchdogMs);
  }
  // Drop the current socket without waiting for its close event and open a fresh one now.
  function reconnectNow() {
    const old = socket;
    socket = null;   // its late close event is then ignored
    clearTimeout(retryTimer);
    retryTimer = null;
    retryAttempt = 0;
    try { old?.close(); } catch { /* already gone */ }
    connect();
  }
  async function watchdogTick() {
    watchdog = null;
    if (stopped) return;
    if (retryTimer) return armWatchdog();   // already reconnecting
    const activeSocket = socket, activeGeneration = generation;
    if (activeSocket && activeSocket.readyState === 0) { reconnectNow(); return; }   // never finished connecting
    try {
      const response = await fetchImpl('/api/state/' + encodeURIComponent(normalizedChannel), { method: 'GET', cache: 'no-store', headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('Arena state HTTP ' + response.status);
      const payload = await response.json();
      if (stopped || activeGeneration !== generation) return;   // the socket changed meanwhile and re-armed the watchdog itself
      const fresh = revisionOf(snapshotFrom(payload));
      if (fresh !== null && (revision === null || fresh > revision)) {
        receiveSnapshot(payload, 'watchdog');
        status('reconnecting', { message: 'Arena stream was silent; reconnecting', revision });
        reconnectNow();
        return;
      }
    } catch (error) {
      if (stopped || activeGeneration !== generation) return;
    }
    armWatchdog();
  }

  function handleMessage(data, activeSocket) {
    if (stopped || socket !== activeSocket) return;
    armWatchdog();   // any message shows the stream is alive
    if (typeof data !== 'string') return;
    let payload;
    try { payload = JSON.parse(data); } catch { return; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;

    if (payload.type === 'looks') {   // not a snapshot or an event: it carries no revision
      if (payload.looks && typeof payload.looks === 'object') onLooks(payload);
      return;
    }
    const hasSnapshotFields = ['players', 'duels', 'chat', 'config', 'events', 'snapshot', 'state']
      .some(key => Object.prototype.hasOwnProperty.call(payload, key));
    if (payload.type === 'event' || payload.event || (!hasSnapshotFields && payload.type && payload.type !== 'snapshot')) {
      const event = payload.event && typeof payload.event === 'object' ? payload.event : payload;
      const eventRevision = revisionOf(payload) ?? revisionOf(event);
      if (eventRevision !== null && revision !== null && eventRevision < revision) return;
      if (eventRevision !== null) revision = Math.max(revision ?? 0, eventRevision);
      if (rememberEvent(event)) onEvent(localEvent(event));
      status('connected', { revision, chat: payload.chat && { ...payload.chat, lastSeen: local(payload.chat.lastSeen) } });
      return;
    }

    receiveSnapshot(payload, 'websocket');
    const raw = snapshotFrom(payload);
    const snapshot = raw && localSnapshot(raw);
    if (snapshot) status(snapshot.chat?.connected === false ? 'degraded' : 'connected', {
      revision,
      chat: snapshot.chat,
      lastSeen: snapshot.chat?.lastSeen,
    });
  }

  function connect() {
    if (stopped) return;
    const activeGeneration = ++generation;
    socket = null;
    status('connecting', { revision });
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = protocol + '//' + location.host + '/api/live/' + encodeURIComponent(normalizedChannel) + (role === 'overlay' ? '?role=overlay' : '');
    let activeSocket;
    try {
      activeSocket = new WebSocketImpl(url);
    } catch (error) {
      status('offline', { message: error?.message || 'Arena websocket unavailable', revision });
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
      status('connected', { revision, transport: 'websocket' });
      void fetchSnapshot('connect');
    };
    activeSocket.onmessage = ({ data }) => handleMessage(data, activeSocket);
    activeSocket.onerror = () => {
      if (!stopped && socket === activeSocket) status('degraded', { message: 'Arena stream interrupted', revision });
    };
    activeSocket.onclose = () => {
      if (stopped || socket !== activeSocket) return;
      scheduleReconnect(activeSocket);
    };
  }

  connect();
  void fetchSnapshot('initial');

  return {
    get revision() { return revision; },
    disconnect() {
      if (stopped) return;
      stopped = true;
      generation++;
      clearTimeout(retryTimer);
      retryTimer = null;
      clearTimeout(watchdog);
      watchdog = null;
      const activeSocket = socket;
      socket = null;
      activeSocket?.close();
      onStatus({ state: 'offline', message: 'Arena disconnected', revision });
    },
  };
}
