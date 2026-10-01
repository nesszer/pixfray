import { EventEmitter } from 'node:events';
import { MAX_RELAY_FRAME_BYTES, USER_AGENT, backendCloseAction, backoffDelay, parseServerFrame } from './core.mjs';

const QUEUE_LIMIT = 100;
const QUEUE_MAX_AGE_MS = 45_000;
const HELLO_TIMEOUT_MS = 10_000;

// The single relay WebSocket to the Worker (CONTRACTS.md section 4).
// Events: ready {sessionId}, ack {messageId, ok, reason}, down {code, action}, retry {delay}, fatal {reason}.
export class BackendClient extends EventEmitter {
  constructor({ url, credential, WebSocket, twitchConnected = () => true, random = Math.random, baseMs = 1_000, maxMs = 60_000 } = {}) {
    super();
    if (!WebSocket || !url || !credential) throw new Error('BackendClient needs url, credential and WebSocket');
    Object.assign(this, { url, credential, WebSocket, twitchConnected, random, baseMs, maxMs });
    this.ws = null;
    this.session = null;
    this.queue = [];
    this.attempt = 0;
    this.stopped = true;
    this.waitingForTwitch = false;
    this.timers = { retry: null, heartbeat: null, hello: null };
  }

  get ready() { return Boolean(this.session && this.ws?.readyState === 1); }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.stopped || this.ws) return;
    this.waitingForTwitch = false;
    const ws = new this.WebSocket(this.url, {
      headers: { Authorization: 'Bearer ' + this.credential, 'User-Agent': USER_AGENT },
      handshakeTimeout: 15_000,
      maxPayload: 64 * 1024,
    });
    this.ws = ws;
    ws.on('unexpected-response', (request, response) => {
      const status = response.statusCode;
      response.resume?.();
      ws.rejected = status;
      try { ws.terminate(); } catch {}
    });
    ws.on('open', () => {
      clearTimeout(this.timers.hello);
      this.timers.hello = setTimeout(() => { try { ws.terminate(); } catch {} }, HELLO_TIMEOUT_MS);
    });
    ws.on('message', (data) => this.onMessage(ws, data));
    ws.on('error', () => {});
    ws.on('close', (code) => this.onClose(ws, code));
  }

  onMessage(ws, data) {
    if (ws !== this.ws) return;
    const frame = parseServerFrame(data);
    if (!frame) return;
    if (frame.type === 'hello') {
      clearTimeout(this.timers.hello);
      this.session = frame;
      this.attempt = 0;
      // The server only marks the relay connected after a heartbeat, so send one right away.
      this.heartbeat();
      clearInterval(this.timers.heartbeat);
      this.timers.heartbeat = setInterval(() => this.heartbeat(), frame.heartbeatMs);
      this.emit('ready', { sessionId: frame.sessionId });
      this.flush();
    } else if (frame.type === 'ack') {
      this.emit('ack', frame);
    }
  }

  heartbeat() {
    this.raw({ type: 'heartbeat', twitchConnected: this.twitchConnected() === true });
  }

  raw(message) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(message)); return true; } catch { return false; }
  }

  // Sends a presence or command event, or queues it briefly while reconnecting.
  send(event) {
    const frame = fitFrame(event);
    if (!frame) return false;
    if (this.ready && this.raw(frame)) return true;
    this.queue.push({ frame, at: Date.now() });
    if (this.queue.length > QUEUE_LIMIT) this.queue.shift();
    return false;
  }

  flush() {
    const now = Date.now();
    const items = this.queue.splice(0).filter((item) => now - item.at <= QUEUE_MAX_AGE_MS);
    for (const item of items) this.raw(item.frame);
  }

  // Called by the relay when the Twitch side comes back after a 1012 close.
  notifyTwitch(connected) {
    if (connected && this.waitingForTwitch && !this.stopped) {
      this.attempt = 0;
      this.connect();
    }
  }

  clearSession() {
    clearInterval(this.timers.heartbeat);
    clearTimeout(this.timers.hello);
    this.session = null;
  }

  onClose(ws, code) {
    if (ws !== this.ws) return;
    this.ws = null;
    this.clearSession();
    if (this.stopped) return;
    if (ws.rejected === 401 || ws.rejected === 403) {
      this.stopped = true;
      this.emit('fatal', { reason: 'credential_rejected', status: ws.rejected });
      return;
    }
    const action = backendCloseAction(code);
    this.emit('down', { code, action });
    if (action === 'repair' || action === 'replaced') {
      this.stopped = true;
      this.emit('fatal', { reason: action === 'repair' ? 'credential_revoked' : 'replaced_by_other_relay', code });
    } else if (action === 'wait_twitch' && !this.twitchConnected()) {
      this.waitingForTwitch = true;
    } else {
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    clearTimeout(this.timers.retry);
    const delay = backoffDelay(this.attempt++, { baseMs: this.baseMs, maxMs: this.maxMs, random: this.random });
    this.emit('retry', { delay, attempt: this.attempt });
    this.timers.retry = setTimeout(() => this.connect(), delay);
  }

  // Clean shutdown: tell the server we are going offline, then close.
  async stop({ offline = true, timeoutMs = 2_000 } = {}) {
    this.stopped = true;
    clearTimeout(this.timers.retry);
    const ws = this.ws;
    this.clearSession();
    if (!ws) return;
    await new Promise((resolve) => {
      const done = setTimeout(() => { try { ws.terminate(); } catch {} resolve(); }, timeoutMs);
      ws.once('close', () => { clearTimeout(done); resolve(); });
      if (offline && ws.readyState === 1) {
        try { ws.send(JSON.stringify({ type: 'offline' })); } catch {}
        // The server closes with 1000 after offline; close ourselves if it does not.
        setTimeout(() => { try { ws.close(1000); } catch {} }, Math.min(500, timeoutMs / 2)).unref?.();
      } else {
        try { ws.readyState === 1 ? ws.close(1000) : ws.terminate(); } catch {}
      }
    });
    this.ws = null;
  }
}

// Keeps each frame within the server's 4 KB limit by trimming the chat text if needed.
export function fitFrame(event) {
  let frame = { ...event };
  for (let i = 0; i < 6; i++) {
    if (Buffer.byteLength(JSON.stringify(frame)) <= MAX_RELAY_FRAME_BYTES) return frame;
    frame = { ...frame, text: String(frame.text || '').slice(0, Math.floor(String(frame.text || '').length / 2)) };
  }
  return null;
}
