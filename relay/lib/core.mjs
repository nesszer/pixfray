export const CHANNEL_LOGIN = 'nesszerra';
export const DEFAULT_ORIGIN = 'https://chat.miolaf.xyz';
export const REQUIRED_CHAT_SCOPE = 'user:read:chat';
export const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';
export const USER_AGENT = 'MiniChatRelay/2.0 (+https://chat.miolaf.xyz)';
export const PRESENCE_INTERVAL_MS = 30_000;
// Match the server window (game.js rejects commands older than 60 s or more than 10 s ahead).
export const EVENT_MAX_AGE_MS = 60_000;
export const EVENT_FUTURE_SKEW_MS = 10_000;
export const MAX_RELAY_FRAME_BYTES = 4_096;
export const MAX_MESSAGE_ID = 64;
// CONTRACTS.md section 4: the relay uses this exact regex.
export const COMMAND_RE = /^!(duel|challenge|accept|decline|attack|strike|heavy|heal)(?:\s+(@?[a-z0-9_]{1,25}))?\s*$/i;

const USER_ID_RE = /^[0-9]{1,32}$/;
const LOGIN_RE = /^[a-z0-9_]{1,25}$/;

function cleanString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, maxLength);
}

export function isFreshTimestamp(timestamp, now, maxAgeMs = EVENT_MAX_AGE_MS, futureSkewMs = EVENT_FUTURE_SKEW_MS) {
  return Number.isFinite(timestamp) && timestamp <= now + futureSkewMs && now - timestamp <= maxAgeMs;
}

function parseFrame(raw) {
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw) && !(raw instanceof ArrayBuffer) && !Array.isArray(raw)) return raw;
  try {
    return JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
  } catch {
    return null;
  }
}

// Classifies one EventSub WebSocket frame. Returns {kind, ...} or {kind:'invalid'}.
export function classifyEventSubFrame(raw) {
  const frame = parseFrame(raw);
  const metadata = frame?.metadata;
  if (!metadata || typeof metadata.message_type !== 'string') return { kind: 'invalid' };
  const base = { messageId: String(metadata.message_id ?? ''), timestamp: Date.parse(metadata.message_timestamp), frame };
  const session = frame.payload?.session;
  switch (metadata.message_type) {
    case 'session_welcome':
      if (typeof session?.id !== 'string' || !session.id) return { kind: 'invalid' };
      return { ...base, kind: 'welcome', sessionId: session.id, keepaliveSeconds: Number(session.keepalive_timeout_seconds) || 10 };
    case 'session_keepalive':
      return { ...base, kind: 'keepalive' };
    case 'session_reconnect':
      if (typeof session?.reconnect_url !== 'string' || !/^wss:\/\//i.test(session.reconnect_url) && !/^ws:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(session.reconnect_url)) return { kind: 'invalid' };
      return { ...base, kind: 'reconnect', reconnectUrl: session.reconnect_url };
    case 'notification':
      return { ...base, kind: 'notification', subscriptionType: String(frame.payload?.subscription?.type ?? '') };
    case 'revocation':
      return { ...base, kind: 'revocation', subscriptionType: String(frame.payload?.subscription?.type ?? ''), status: String(frame.payload?.subscription?.status ?? '') };
    default:
      return { ...base, kind: 'unknown' };
  }
}

// Extracts a chat message from a channel.chat.message notification, or returns null.
export function parseEventSubMessage(raw, {
  now = Date.now(),
  broadcasterUserId,
  maxAgeMs = EVENT_MAX_AGE_MS,
  futureSkewMs = EVENT_FUTURE_SKEW_MS,
} = {}) {
  const frame = parseFrame(raw);
  if (frame?.metadata?.message_type !== 'notification') return null;
  if (frame?.payload?.subscription?.type !== 'channel.chat.message') return null;

  const event = frame.payload.event;
  if (!event || String(event.broadcaster_user_id ?? '') !== String(broadcasterUserId ?? '')) return null;

  const messageId = cleanString(event.message_id, 128);
  const userId = String(event.chatter_user_id ?? '');
  const username = String(event.chatter_user_login ?? '').toLowerCase();
  const displayName = cleanString(event.chatter_user_name, 48) || username;
  const text = cleanString(event.message?.text, 500);
  // channel.chat.message has no sent_at; the metadata timestamp is when Twitch sent it.
  const timestamp = Date.parse(frame.metadata.message_timestamp);

  if (!messageId || messageId.length > MAX_MESSAGE_ID || !USER_ID_RE.test(userId) || !LOGIN_RE.test(username) || !text) return null;
  if (!isFreshTimestamp(timestamp, now, maxAgeMs, futureSkewMs)) return null;
  return { messageId, userId, username, displayName, text, timestamp };
}

// Mirrors server/game.js parseGameCommand. Returns {action, target} or null.
export function parseGameCommand(text) {
  if (typeof text !== 'string') return null;
  const match = COMMAND_RE.exec(text.trim());
  if (!match) return null;
  let action = match[1].toLowerCase();
  if (action === 'challenge') action = 'duel';
  const target = match[2] ? match[2].replace(/^@/, '').toLowerCase() : '';
  if (action === 'duel' && !target) return null;
  return { action, target };
}

export function shouldEmitPresence(lastSentByUser, userId, now, intervalMs = PRESENCE_INTERVAL_MS) {
  const key = String(userId ?? '');
  if (!key) return false;
  const previous = lastSentByUser.get(key);
  if (Number.isFinite(previous) && now - previous < intervalMs) return false;
  lastSentByUser.delete(key);
  lastSentByUser.set(key, now);
  while (lastSentByUser.size > 2_000) lastSentByUser.delete(lastSentByUser.keys().next().value);
  return true;
}

// Decides what to forward for one chat message: a command, a throttled presence, or nothing.
export function routeChatMessage(message, lastPresence, now = Date.now()) {
  if (!message) return null;
  if (parseGameCommand(message.text)) {
    lastPresence.delete(message.userId);
    lastPresence.set(message.userId, now);
    return makeRelayEvent('command', message);
  }
  return shouldEmitPresence(lastPresence, message.userId, now) ? makeRelayEvent('presence', message) : null;
}

// Exponential backoff with full jitter: random in [base/2, min(max, base*2^attempt)].
export function backoffDelay(attempt, { baseMs = 1_000, maxMs = 60_000, random = Math.random } = {}) {
  const n = Math.max(0, Math.min(30, Math.floor(Number(attempt) || 0)));
  const ceiling = Math.min(maxMs, baseMs * 2 ** n);
  const floor = Math.min(ceiling, baseMs / 2);
  return Math.round(floor + (ceiling - floor) * random());
}

export function normalizeOrigin(origin) {
  const url = new URL(origin);
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error('Backend address must be an origin without credentials, path, query, or fragment');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Backend address must use HTTPS (or HTTP on loopback for local development)');
  }
  return url.origin;
}

export function backendSocketUrl(origin, channel = CHANNEL_LOGIN) {
  const url = new URL(normalizeOrigin(origin));
  if (!LOGIN_RE.test(channel)) throw new Error('Invalid relay channel');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/relay/' + channel;
  return url.href;
}

export function makeRelayEvent(type, message) {
  if (type !== 'presence' && type !== 'command') throw new Error('Invalid relay event type');
  return {
    type,
    messageId: String(message.messageId).slice(0, MAX_MESSAGE_ID),
    userId: message.userId,
    username: message.username,
    displayName: message.displayName,
    text: message.text,
    timestamp: message.timestamp,
  };
}

export function createChatSubscription(sessionId, broadcasterUserId, readerUserId = broadcasterUserId) {
  return {
    type: 'channel.chat.message',
    version: '1',
    condition: { broadcaster_user_id: String(broadcasterUserId), user_id: String(readerUserId) },
    transport: { method: 'websocket', session_id: sessionId },
  };
}

// Server-to-relay frames (hello, ack). Returns null for anything else.
export function parseServerFrame(raw) {
  const frame = parseFrame(raw);
  if (frame?.type === 'hello' && typeof frame.sessionId === 'string') {
    return {
      type: 'hello',
      sessionId: frame.sessionId,
      channel: String(frame.channel ?? ''),
      heartbeatMs: Math.min(60_000, Math.max(1_000, Number(frame.heartbeatMs) || 10_000)),
      leaseMs: Number(frame.leaseMs) || 30_000,
    };
  }
  if (frame?.type === 'ack') return { type: 'ack', messageId: String(frame.messageId ?? ''), ok: frame.ok === true, reason: String(frame.reason ?? '') };
  return null;
}

// What to do after the Worker closes the relay socket (CONTRACTS.md section 4).
export function backendCloseAction(code) {
  if (code === 4003) return 'repair';
  if (code === 4001) return 'replaced';
  if (code === 1012) return 'wait_twitch';
  return 'reconnect';
}
