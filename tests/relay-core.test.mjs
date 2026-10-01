import assert from 'node:assert/strict';
import test from 'node:test';
import { fitFrame } from '../relay/lib/backend.mjs';
import {
  backendCloseAction, backendSocketUrl, backoffDelay, classifyEventSubFrame, createChatSubscription,
  makeRelayEvent, parseEventSubMessage, parseGameCommand, parseServerFrame, routeChatMessage, shouldEmitPresence,
} from '../relay/lib/core.mjs';
import { parseGameCommand as serverParse } from '../server/game.js';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');

function chatFrame({ text = '!strike', userId = '2002', login = 'viewer_one', name = 'Viewer_One', broadcaster = '1001', at = NOW, messageId = 'msg-1', eventId = 'evt-1' } = {}) {
  return {
    metadata: { message_id: eventId, message_type: 'notification', message_timestamp: new Date(at).toISOString(), subscription_type: 'channel.chat.message' },
    payload: {
      subscription: { id: 'sub', type: 'channel.chat.message', version: '1', status: 'enabled' },
      event: {
        broadcaster_user_id: broadcaster, broadcaster_user_login: 'nesszerra', broadcaster_user_name: 'nesszerra',
        chatter_user_id: userId, chatter_user_login: login, chatter_user_name: name,
        message_id: messageId, message: { text, fragments: [{ type: 'text', text }] }, message_type: 'text',
      },
    },
  };
}

test('classifyEventSubFrame recognises every EventSub message type', () => {
  const welcome = classifyEventSubFrame(JSON.stringify({ metadata: { message_id: 'a', message_type: 'session_welcome', message_timestamp: '2026-10-01T12:00:00Z' }, payload: { session: { id: 'S1', keepalive_timeout_seconds: 30 } } }));
  assert.equal(welcome.kind, 'welcome');
  assert.equal(welcome.sessionId, 'S1');
  assert.equal(welcome.keepaliveSeconds, 30);
  assert.equal(classifyEventSubFrame({ metadata: { message_type: 'session_keepalive' }, payload: {} }).kind, 'keepalive');
  const reconnect = classifyEventSubFrame({ metadata: { message_type: 'session_reconnect' }, payload: { session: { id: 'S1', reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?x=1' } } });
  assert.equal(reconnect.kind, 'reconnect');
  assert.equal(reconnect.reconnectUrl, 'wss://eventsub.wss.twitch.tv/ws?x=1');
  assert.equal(classifyEventSubFrame({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: 'http://evil.example/' } } }).kind, 'invalid');
  const revoked = classifyEventSubFrame({ metadata: { message_type: 'revocation' }, payload: { subscription: { type: 'channel.chat.message', status: 'authorization_revoked' } } });
  assert.deepEqual([revoked.kind, revoked.status], ['revocation', 'authorization_revoked']);
  assert.equal(classifyEventSubFrame(chatFrame()).kind, 'notification');
  assert.equal(classifyEventSubFrame('not json').kind, 'invalid');
  assert.equal(classifyEventSubFrame({ metadata: { message_type: 'something_new' } }).kind, 'unknown');
});

test('parseEventSubMessage extracts chat and uses the metadata timestamp', () => {
  const message = parseEventSubMessage(JSON.stringify(chatFrame({ text: '  !duel @Bob  ' })), { now: NOW + 500, broadcasterUserId: '1001' });
  assert.deepEqual(message, { messageId: 'msg-1', userId: '2002', username: 'viewer_one', displayName: 'Viewer_One', text: '!duel @Bob', timestamp: NOW });
  assert.equal(parseEventSubMessage(chatFrame({ broadcaster: '9999' }), { now: NOW, broadcasterUserId: '1001' }), null, 'other channel');
  assert.equal(parseEventSubMessage(chatFrame({ at: NOW - 61_000 }), { now: NOW, broadcasterUserId: '1001' }), null, 'too old');
  assert.equal(parseEventSubMessage(chatFrame({ at: NOW + 11_000 }), { now: NOW, broadcasterUserId: '1001' }), null, 'from the future');
  assert.equal(parseEventSubMessage(chatFrame({ userId: 'abc' }), { now: NOW, broadcasterUserId: '1001' }), null, 'bad user id');
  assert.equal(parseEventSubMessage(chatFrame({ messageId: 'x'.repeat(65) }), { now: NOW, broadcasterUserId: '1001' }), null, 'message id over 64');
  assert.equal(parseEventSubMessage(chatFrame({ text: '\u0000\u0001' }), { now: NOW, broadcasterUserId: '1001' }), null, 'empty after cleaning');
  assert.equal(parseEventSubMessage({ metadata: { message_type: 'session_keepalive' } }, { now: NOW, broadcasterUserId: '1001' }), null);
  assert.equal(parseEventSubMessage(chatFrame({ name: '' }), { now: NOW, broadcasterUserId: '1001' }).displayName, 'viewer_one');
});

test('parseGameCommand follows the contract regex and matches the server parser', () => {
  const cases = [
    '!duel @Bob', '!challenge bob', '!duel', '!challenge', '!accept', '!accept @bob', '!decline', '!attack @x_1',
    '!strike', '!heavy @someone', '!heal', '!HEAL', '  !strike  ', '!strike now please', '!dance', 'hello !strike',
    '!duel @this_name_is_way_too_long_x', '!duel @bad-name', '', '!',
  ];
  for (const text of cases) assert.deepEqual(parseGameCommand(text), serverParse(text), text);
  assert.deepEqual(parseGameCommand('!Challenge @Bob'), { action: 'duel', target: 'bob' });
  assert.deepEqual(parseGameCommand('!attack'), { action: 'attack', target: '' });
  assert.equal(parseGameCommand('!duel'), null, 'duel needs a target');
  assert.equal(parseGameCommand(42), null);
});

test('routeChatMessage forwards commands and throttles presence per viewer', () => {
  const last = new Map();
  const base = { userId: '2002', username: 'a', displayName: 'A', timestamp: NOW };
  assert.equal(routeChatMessage({ ...base, messageId: '1', text: 'hi' }, last, NOW).type, 'presence');
  assert.equal(routeChatMessage({ ...base, messageId: '2', text: 'hi again' }, last, NOW + 1_000), null);
  assert.equal(routeChatMessage({ ...base, messageId: '3', text: '!heal' }, last, NOW + 2_000).type, 'command');
  assert.equal(routeChatMessage({ ...base, messageId: '4', text: 'later' }, last, NOW + 31_000), null, 'command refreshed the presence window');
  assert.equal(routeChatMessage({ ...base, messageId: '5', text: 'later' }, last, NOW + 33_000).type, 'presence');
  assert.equal(routeChatMessage(null, last, NOW), null);
  const m = new Map();
  for (let i = 0; i < 2_100; i++) shouldEmitPresence(m, String(i), NOW);
  assert.equal(m.size, 2_000);
});

test('makeRelayEvent and fitFrame produce contract-shaped frames under 4 KB', () => {
  const event = makeRelayEvent('command', { messageId: 'id', userId: '1', username: 'u', displayName: 'U', text: '!strike', timestamp: NOW, extra: 'drop' });
  assert.deepEqual(Object.keys(event), ['type', 'messageId', 'userId', 'username', 'displayName', 'text', 'timestamp']);
  assert.throws(() => makeRelayEvent('heartbeat', {}));
  const big = fitFrame({ ...event, type: 'presence', text: '\u{1F600}'.repeat(2_000) });
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= 4_096);
});

test('backoffDelay grows exponentially, caps, and applies jitter', () => {
  const opts = { baseMs: 1_000, maxMs: 30_000 };
  assert.equal(backoffDelay(0, { ...opts, random: () => 0 }), 500);
  assert.equal(backoffDelay(0, { ...opts, random: () => 1 }), 1_000);
  assert.equal(backoffDelay(3, { ...opts, random: () => 1 }), 8_000);
  assert.equal(backoffDelay(20, { ...opts, random: () => 1 }), 30_000);
  assert.equal(backoffDelay(20, { ...opts, random: () => 0 }), 500);
  const samples = new Set(Array.from({ length: 50 }, () => backoffDelay(4, opts)));
  assert.ok(samples.size > 10, 'jitter spreads retries');
  for (const s of samples) assert.ok(s >= 500 && s <= 16_000);
  assert.equal(backoffDelay(-5, { ...opts, random: () => 1 }), 1_000);
});

test('backend helpers: socket URL, server frames and close codes', () => {
  assert.equal(backendSocketUrl('https://chat.miolaf.xyz'), 'wss://chat.miolaf.xyz/api/relay/nesszerra');
  assert.equal(backendSocketUrl('http://127.0.0.1:5173', 'nesszerra'), 'ws://127.0.0.1:5173/api/relay/nesszerra');
  assert.throws(() => backendSocketUrl('http://chat.miolaf.xyz'));
  assert.throws(() => backendSocketUrl('https://user:pw@chat.miolaf.xyz'));
  assert.throws(() => backendSocketUrl('https://chat.miolaf.xyz/path'));
  assert.deepEqual(parseServerFrame('{"type":"hello","sessionId":"s","channel":"nesszerra","heartbeatMs":10000,"leaseMs":30000}'), { type: 'hello', sessionId: 's', channel: 'nesszerra', heartbeatMs: 10_000, leaseMs: 30_000 });
  assert.deepEqual(parseServerFrame({ type: 'ack', messageId: 'm', ok: false, reason: 'cooldown' }), { type: 'ack', messageId: 'm', ok: false, reason: 'cooldown' });
  assert.equal(parseServerFrame('{"type":"snapshot"}'), null);
  assert.deepEqual([4003, 4001, 1012, 1000, 1006, 1011].map(backendCloseAction), ['repair', 'replaced', 'wait_twitch', 'reconnect', 'reconnect', 'reconnect']);
  const sub = createChatSubscription('sess', '1001');
  assert.deepEqual(sub.condition, { broadcaster_user_id: '1001', user_id: '1001' });
  assert.deepEqual(sub.transport, { method: 'websocket', session_id: 'sess' });
});
