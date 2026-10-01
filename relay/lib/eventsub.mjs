import { EventEmitter } from 'node:events';
import { EVENTSUB_URL, USER_AGENT, backoffDelay, classifyEventSubFrame } from './core.mjs';

// One Twitch EventSub WebSocket session with keepalive watchdog, session_reconnect migration,
// notification de-duplication and reconnect with exponential backoff + jitter.
// Events: session {sessionId, migrated}, notification frame, revocation info, down {code, reason}.
export class EventSubClient extends EventEmitter {
  constructor({ url = EVENTSUB_URL, WebSocket, random = Math.random, baseMs = 1_000, maxMs = 60_000, keepaliveGraceMs = 5_000 } = {}) {
    super();
    if (!WebSocket) throw new Error('EventSubClient needs a WebSocket implementation');
    Object.assign(this, { url, WebSocket, random, baseMs, maxMs, keepaliveGraceMs });
    this.active = null;     // {ws, sessionId, keepaliveMs}
    this.pending = null;    // socket opened for session_reconnect, waiting for its welcome
    this.attempt = 0;
    this.stopped = true;
    this.retryTimer = null;
    this.watchdog = null;
    this.seen = new Set();
  }

  get connected() { return Boolean(this.active?.sessionId); }
  get sessionId() { return this.active?.sessionId || ''; }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.open(this.url, false);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.watchdog);
    for (const item of [this.active?.ws, this.pending]) this.retire(item, 1000);
    this.active = null;
    this.pending = null;
  }

  // Drops the current session and reconnects with backoff (used after a failed subscription).
  restart(reason = 'restart') {
    const ws = this.active?.ws;
    if (ws) { try { ws.terminate(); } catch {} } else this.scheduleReconnect(reason);
  }

  retire(ws, code) {
    if (!ws) return;
    ws.retired = true;
    try { ws.readyState === 1 ? ws.close(code) : ws.terminate(); } catch {}
  }

  open(url, migrating) {
    let ws;
    try {
      ws = new this.WebSocket(url, { headers: { 'User-Agent': USER_AGENT }, handshakeTimeout: 15_000 });
    } catch {
      if (!migrating) this.scheduleReconnect('open_failed');
      return;
    }
    ws.migration = migrating;
    if (migrating) { this.retire(this.pending, 1000); this.pending = ws; }
    else { this.active = { ws, sessionId: '', keepaliveMs: 15_000 }; this.armWatchdog(); }
    ws.on('message', (data) => this.onMessage(ws, data));
    ws.on('error', () => {});
    ws.on('close', (code) => this.onClose(ws, code));
    return ws;
  }

  armWatchdog() {
    clearTimeout(this.watchdog);
    if (!this.active) return;
    const ws = this.active.ws;
    this.watchdog = setTimeout(() => {
      if (this.active?.ws === ws) { try { ws.terminate(); } catch {} }
    }, this.active.keepaliveMs + this.keepaliveGraceMs);
    this.watchdog.unref?.();
  }

  onMessage(ws, data) {
    if (ws.retired || this.stopped) return;
    const info = classifyEventSubFrame(data);
    if (info.kind === 'welcome') {
      if (ws === this.pending) {
        const old = this.active?.ws;
        this.pending = null;
        if (old !== ws) this.retire(old, 1000);
      } else if (this.active?.ws !== ws) return;
      const migrated = Boolean(ws.migration);
      this.active = { ws, sessionId: info.sessionId, keepaliveMs: info.keepaliveSeconds * 1000 };
      this.attempt = 0;
      this.armWatchdog();
      this.emit('session', { sessionId: info.sessionId, migrated });
      return;
    }
    if (this.active?.ws !== ws) return; // only the active session delivers events
    this.armWatchdog();
    if (info.kind === 'notification') {
      if (info.messageId) {
        if (this.seen.has(info.messageId)) return;
        this.seen.add(info.messageId);
        if (this.seen.size > 1_000) this.seen.delete(this.seen.values().next().value);
      }
      this.emit('notification', info.frame);
    } else if (info.kind === 'reconnect') {
      this.open(info.reconnectUrl, true);
    } else if (info.kind === 'revocation') {
      this.emit('revocation', { subscriptionType: info.subscriptionType, status: info.status });
    }
  }

  onClose(ws, code) {
    if (ws.retired) return;
    if (ws === this.pending) {
      // Migration failed before its welcome; the old session (if still open) keeps running.
      this.pending = null;
      return;
    }
    if (this.active && this.active.ws !== ws) return;
    const hadSession = Boolean(this.active?.sessionId);
    this.active = null;
    clearTimeout(this.watchdog);
    if (this.stopped) return;
    if (this.pending) {
      // The old socket closed during migration; let the pending socket become the session.
      const pending = this.pending;
      this.pending = null;
      this.active = { ws: pending, sessionId: '', keepaliveMs: 30_000 };
      this.armWatchdog();
      this.emit('down', { code, reason: 'migrating' });
      return;
    }
    this.emit('down', { code, reason: hadSession ? 'closed' : 'connect_failed' });
    this.scheduleReconnect('closed');
  }

  scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    const delay = backoffDelay(this.attempt++, { baseMs: this.baseMs, maxMs: this.maxMs, random: this.random });
    this.emit('retry', { delay, attempt: this.attempt });
    this.retryTimer = setTimeout(() => { if (!this.stopped && !this.active) this.open(this.url, false); }, delay);
  }
}
