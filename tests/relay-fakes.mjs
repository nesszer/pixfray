// Local fakes for relay tests: Twitch OAuth/Helix (HTTP), EventSub (WebSocket) and the Worker
// relay socket (WebSocket). Everything listens on 127.0.0.1 only.
import http from 'node:http';
import { WebSocketServer } from 'ws';

export const CREDENTIAL = 'c'.repeat(64);
export const BROADCASTER = '1001';
export const PAIR_CODE = 'a'.repeat(64);

export function waitFor(check, label, timeoutMs = 4_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try { value = check(); } catch (error) { return reject(error); }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('Timed out waiting for ' + label));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

export async function startFakes({ heartbeatMs = 100 } = {}) {
  const twitch = { subscriptions: [], refreshes: 0, validates: 0, accessToken: 'access-1', subscribeStatus: 202 };
  const httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.url === '/oauth2/validate') {
        twitch.validates++;
        if (twitch.failValidates > 0) { twitch.failValidates--; return send(503, { message: 'unavailable' }); }
        if (req.headers.authorization !== 'OAuth ' + twitch.accessToken) return send(401, { status: 401, message: 'invalid access token' });
        return send(200, { client_id: 'client123', login: 'nesszerra', user_id: BROADCASTER, scopes: ['user:read:chat'], expires_in: 14_000 });
      }
      if (req.url === '/oauth2/device' && req.method === 'POST') {
        const form = new URLSearchParams(body);
        if (form.get('client_id') !== 'client123' || form.get('scopes') !== 'user:read:chat') return send(400, { message: 'bad request' });
        twitch.devicePolls = 0;
        return send(200, { device_code: 'device-1', user_code: 'ABCD-EFGH', verification_uri: 'https://www.twitch.tv/activate?device-code=ABCD-EFGH', expires_in: 60, interval: 1 });
      }
      if (req.url === '/oauth2/token' && new URLSearchParams(body).get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        const form = new URLSearchParams(body);
        if (form.get('device_code') !== 'device-1') return send(400, { status: 400, message: 'invalid device code' });
        if (++twitch.devicePolls < 2) return send(400, { status: 400, message: 'authorization_pending' });
        return send(200, { access_token: twitch.accessToken, refresh_token: 'refresh-1', expires_in: 14_000, scope: ['user:read:chat'], token_type: 'bearer' });
      }
      if (req.url === '/oauth2/token') {
        const form = new URLSearchParams(body);
        if (form.get('grant_type') !== 'refresh_token' || form.get('client_id') !== 'client123') return send(400, { message: 'bad request' });
        twitch.refreshes++;
        twitch.accessToken = 'access-' + (twitch.refreshes + 1);
        return send(200, { access_token: twitch.accessToken, refresh_token: 'refresh-' + (twitch.refreshes + 1), expires_in: 14_000, scope: ['user:read:chat'] });
      }
      if (req.url === '/helix/eventsub/subscriptions' && req.method === 'POST') {
        if (req.headers.authorization !== 'Bearer ' + twitch.accessToken || req.headers['client-id'] !== 'client123') return send(401, { message: 'unauthorized' });
        twitch.subscriptions.push(JSON.parse(body));
        return send(twitch.subscribeStatus, { data: [] });
      }
      send(404, { message: 'not found' });
    });
  });
  const httpPort = await listen(httpServer);

  // Fake EventSub: /ws is the normal entry, /reconnect is the session_reconnect target.
  const eventsub = { sockets: [], sessionCounter: 0 };
  const eventsubHttp = http.createServer();
  const eventsubWss = new WebSocketServer({ server: eventsubHttp });
  eventsubWss.on('connection', (ws, req) => {
    const entry = { ws, path: req.url, closedByClient: false, messages: [] };
    ws.on('close', () => { entry.closed = true; });
    eventsub.sockets.push(entry);
  });
  const eventsubPort = await listen(eventsubHttp);
  eventsub.welcome = (entry) => {
    const id = 'session-' + (++eventsub.sessionCounter);
    entry.ws.send(JSON.stringify({ metadata: { message_id: 'w' + id, message_type: 'session_welcome', message_timestamp: new Date().toISOString() }, payload: { session: { id, status: 'connected', keepalive_timeout_seconds: 10 } } }));
    return id;
  };
  let chatCounter = 0;
  eventsub.chat = (entry, text, { userId = '2002', login = 'viewer_one', eventId } = {}) => {
    const n = ++chatCounter;
    entry.ws.send(JSON.stringify({
      metadata: { message_id: eventId || 'evt-' + n, message_type: 'notification', message_timestamp: new Date().toISOString(), subscription_type: 'channel.chat.message' },
      payload: {
        subscription: { type: 'channel.chat.message', version: '1', status: 'enabled' },
        event: { broadcaster_user_id: BROADCASTER, chatter_user_id: userId, chatter_user_login: login, chatter_user_name: login, message_id: 'chat-' + n, message: { text } },
      },
    }));
    return 'chat-' + n;
  };

  // Fake Worker relay socket.
  const worker = { connections: [], authFailures: 0, pairCodes: new Set([PAIR_CODE]) };
  const workerHttp = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.method !== 'POST' || req.url !== '/api/relay/pair') return send(404, { error: 'not found' });
      let code = '';
      try { code = JSON.parse(body).code; } catch { return send(400, { error: 'Invalid JSON' }); }
      if (!/^[0-9a-f]{64}$/.test(code || '')) return send(400, { error: 'Invalid pairing code' });
      if (!worker.pairCodes.delete(code)) return send(403, { error: 'Pairing code expired or used' });
      send(200, { credential: CREDENTIAL, channel: 'nesszerra', expiresIn: 7_776_000 });
    });
  });
  const workerWss = new WebSocketServer({
    server: workerHttp,
    verifyClient: (info, done) => {
      if (info.req.url !== '/api/relay/nesszerra' || info.req.headers.authorization !== 'Bearer ' + CREDENTIAL) { worker.authFailures++; return done(false, 403); }
      done(true);
    },
  });
  workerWss.on('connection', (ws) => {
    const conn = { ws, messages: [], closed: false };
    worker.connections.push(conn);
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      conn.messages.push(msg);
      if (msg.type === 'command') ws.send(JSON.stringify({ type: 'ack', messageId: msg.messageId, ok: true, reason: 'ok' }));
      if (msg.type === 'heartbeat' && msg.twitchConnected !== true) ws.close(1012, 'Twitch disconnected');
      if (msg.type === 'offline') ws.close(1000, 'Relay offline');
    });
    ws.on('close', () => { conn.closed = true; });
    ws.send(JSON.stringify({ type: 'hello', sessionId: 'relay-' + worker.connections.length, channel: 'nesszerra', heartbeatMs, leaseMs: 30_000 }));
  });
  const workerPort = await listen(workerHttp);

  const close = async () => {
    for (const s of [...eventsubWss.clients, ...workerWss.clients]) s.terminate();
    await Promise.all([httpServer, eventsubHttp, workerHttp].map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
  };
  return { twitch, eventsub, worker, httpPort, eventsubPort, workerPort, close };
}

