export const CHANNEL_LOGIN = 'nesszerra';
export const REQUIRED_CHAT_SCOPE = 'user:read:chat';
export const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';
export const PRESENCE_INTERVAL_MS = 30_000;
export const EVENT_MAX_AGE_MS = 30_000;
export const EVENT_FUTURE_SKEW_MS = 5_000;
export const MAX_RELAY_FRAME_BYTES = 4_096;

const USER_ID_RE = /^[0-9]{1,32}$/;
const LOGIN_RE = /^[a-z0-9_]{1,25}$/;

function cleanString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, maxLength);
}

export function isFreshTimestamp(timestamp, now, maxAgeMs = EVENT_MAX_AGE_MS, futureSkewMs = EVENT_FUTURE_SKEW_MS) {
  return Number.isFinite(timestamp) &&
    timestamp <= now + futureSkewMs &&
    now - timestamp <= maxAgeMs;
}

export function parseEventSubMessage(raw, {
  now = Date.now(),
  broadcasterUserId,
  maxAgeMs = EVENT_MAX_AGE_MS,
  futureSkewMs = EVENT_FUTURE_SKEW_MS,
} = {}) {
  let frame;
  try {
    frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    return null;
  }

  if (frame?.metadata?.message_type !== 'notification') return null;
  if (frame?.payload?.subscription?.type !== 'channel.chat.message') return null;

  const event = frame?.payload?.event;
  if (!event || String(event.broadcaster_user_id ?? '') !== String(broadcasterUserId ?? '')) return null;

  const messageId = cleanString(event.message_id, 128);
  const userId = String(event.chatter_user_id ?? '');
  const username = String(event.chatter_user_login ?? '').toLowerCase();
  const displayName = cleanString(event.chatter_user_name, 50);
  const text = cleanString(event.message?.text, 1_000);
  const timestamp = Date.parse(event.sent_at);

  if (!messageId || !USER_ID_RE.test(userId) || !LOGIN_RE.test(username) || !displayName || !text) return null;
  if (!isFreshTimestamp(timestamp, now, maxAgeMs, futureSkewMs)) return null;

  return { messageId, userId, username, displayName, text, timestamp };
}

export function parseGameCommand(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (/^!duel(?:\s+@?[a-z0-9_]{1,25})?$/i.test(value)) return value.toLowerCase();
  if (/^!(?:accept|decline|attack|strike|heavy|heal)$/i.test(value)) return value.toLowerCase();
  return null;
}

export function shouldEmitPresence(lastSentByUser, userId, now, intervalMs = PRESENCE_INTERVAL_MS) {
  const key = String(userId ?? '');
  if (!key) return false;

  const previous = lastSentByUser.get(key);
  if (Number.isFinite(previous) && now - previous < intervalMs) return false;

  lastSentByUser.set(key, now);
  while (lastSentByUser.size > 2_000) {
    lastSentByUser.delete(lastSentByUser.keys().next().value);
  }
  return true;
}

export function backendSocketUrl(origin, channel = CHANNEL_LOGIN) {
  const url = new URL(origin);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Backend address must be an origin without credentials, query, or fragment');
  }

  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Backend address must use HTTPS (or HTTP on loopback for local development)');
  }
  if (!LOGIN_RE.test(channel)) throw new Error('Invalid relay channel');

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/relay/' + channel;
  return url.href;
}

export function makeRelayEvent(type, message) {
  if (type !== 'presence' && type !== 'command') throw new Error('Invalid relay event type');
  return {
    type,
    messageId: message.messageId,
    userId: message.userId,
    username: message.username,
    displayName: message.displayName,
    text: message.text,
    timestamp: message.timestamp,
  };
}

export function createChatSubscription(sessionId, broadcasterUserId) {
  return {
    type: 'channel.chat.message',
    version: '1',
    condition: {
      broadcaster_user_id: String(broadcasterUserId),
      user_id: String(broadcasterUserId),
    },
    transport: {
      method: 'websocket',
      session_id: sessionId,
    },
  };
}
