// Worker routing, gates and validation, with in-memory AuthStore/ChannelRoom stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/worker.js';
import { createHmac } from 'node:crypto';
import { digest } from '../server/auth.js';
import { makePng } from './upload-helpers.mjs';
import { eventsubSecret, signEventsub, localTestMode, sendChatMessage, sendChatMessages, botDropText } from '../server/eventsub.js';

function environment() {
  const entries = new Map(), forwarded = [];
  const env = {
    AUTH_SECRET: 'test-only-auth-key', INTERNAL_SECRET: 'test-only-internal-key',
    TWITCH_CLIENT_ID: 'test-app', TWITCH_CLIENT_SECRET: 'test-secret',
    AUTH: { idFromName: x => x, get: () => ({ async fetch(url, options) {
      const u = new URL(url), key = u.searchParams.get('key'), method = options.method;
      if (u.pathname === '/list') return Response.json([...entries].filter(([k]) => k.startsWith(key)).map(([k, value]) => ({ key: k, value })));
      if (u.pathname === '/consume') { const value = entries.get(key) ?? null; entries.delete(key); return Response.json(value); }
      if (method === 'GET') return Response.json(entries.get(key) ?? null);
      if (method === 'DELETE') { entries.delete(key); return Response.json({ ok: true }); }
      entries.set(key, JSON.parse(options.body).value); return Response.json({ ok: true });
    } }) },
    ROOMS: { idFromName: x => x, get: channel => ({ async fetch(url, options = {}) {
      const path = new URL(url).pathname;
      forwarded.push({ channel, path, options, body: options.body ? JSON.parse(options.body) : undefined });
      if (path === '/catalog') return Response.json([{ id: 'c-robot' }]);
      if (path === '/admin' && (options.method || 'GET') === 'GET') return Response.json({ revision: 3, history: [] });
      return Response.json({ path });
    } }) },
    ASSETS: { fetch: async () => Response.json([{ id: 'player' }]) }
  };
  return { env, entries, forwarded };
}
async function signedIn(f, owner = false) {
  const cookie = (owner ? '1' : '2').repeat(64), user = { id: owner ? '1' : '2', login: owner ? 'nesszerra' : 'viewer', displayName: 'V' };
  f.entries.set('owner:nesszerra', { id: '1' });
  f.entries.set('session:' + await digest(cookie), { user });
  return 'mini_session=' + cookie;
}
const b64png = (w, h) => Buffer.from(makePng(w, h)).toString('base64');
function req(path, method = 'GET', data, cookie, extra = {}) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: 'https://chat.miolaf.xyz', 'Content-Type': 'application/json' } : {}), ...extra };
  return new Request('https://chat.miolaf.xyz' + path, { method, headers, ...(data !== undefined ? { body: typeof data === 'string' ? data : JSON.stringify(data) } : {}) });
}

test('admin dashboard data requires a mod or the owner', async () => {
  const f = environment();
  assert.equal((await worker.fetch(req('/api/admin/nesszerra'), f.env)).status, 401);
  assert.equal((await worker.fetch(req('/api/admin/nesszerra', 'GET', undefined, await signedIn(f)), f.env)).status, 403);
  const r = await worker.fetch(req('/api/admin/nesszerra', 'GET', undefined, await signedIn(f, true)), f.env);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.revision, 3);
  assert.equal(body.access.canManage, true);
});

test('admin actions carry the session user as actor, never a forged one', async () => {
  const f = environment(), cookie = await signedIn(f, true);
  const r = await worker.fetch(req('/api/admin/nesszerra', 'POST', { actorId: 'forged', action: 'resetRound' }, cookie), f.env);
  assert.equal(r.status, 200);
  assert.equal(f.forwarded.at(-1).body.actorId, '1');
});

test('custom character uploads are gated; atlas reads are public', async () => {
  const f = environment();
  assert.equal((await worker.fetch(req('/api/assets/nesszerra'), f.env)).status, 401);
  assert.equal((await worker.fetch(req('/api/assets/nesszerra', 'POST', {}, await signedIn(f)), f.env)).status, 403);
  const bad = await worker.fetch(req('/api/assets/nesszerra', 'POST', {}, await signedIn(f, true)), f.env);
  assert.equal(bad.status, 400, 'an empty upload is rejected in the Worker before reaching the room');
  assert.equal((await bad.json()).reason, 'invalid_label');
  const pub = await worker.fetch(req('/api/assets/nesszerra/c-robot'), f.env);
  assert.equal(pub.status, 200);
  assert.equal(f.forwarded.at(-1).path, '/asset/c-robot');
});

test('developer routes are owner-only', async () => {
  const f = environment();
  assert.equal((await worker.fetch(req('/api/dev/diagnostics'), f.env)).status, 401);
  assert.equal((await worker.fetch(req('/api/dev/diagnostics', 'GET', undefined, await signedIn(f)), f.env)).status, 403);
  const ok = await worker.fetch(req('/api/dev/diagnostics', 'GET', undefined, await signedIn(f, true)), f.env);
  assert.equal(ok.status, 200);
  assert.equal((await worker.fetch(req('/api/dev/deploy', 'POST', {}, await signedIn(f, true)), f.env)).status, 501);
});

test('catalog merges static and custom characters; profiles may pick either', async () => {
  const f = environment(), cookie = await signedIn(f);
  const cat = await (await worker.fetch(req('/api/catalog/nesszerra'), f.env)).json();
  assert.deepEqual(cat.map(x => x.id), ['player', 'c-robot']);
  const ok = await worker.fetch(req('/api/profile/nesszerra', 'POST', { avatar: 'c-robot', color: '#aabbcc', defaultAbility: 'heal' }, cookie), f.env);
  assert.equal(ok.status, 200);
  assert.equal((await worker.fetch(req('/api/profile/nesszerra', 'POST', { avatar: 'ghost', color: '#aabbcc', defaultAbility: 'heal' }, cookie), f.env)).status, 400);
  assert.equal((await worker.fetch(req('/api/profile/nesszerra', 'POST', { avatar: 'player', color: 'red', defaultAbility: 'heal' }, cookie), f.env)).status, 400);
});

test('malformed and oversized bodies are rejected before reaching a room', async () => {
  const f = environment(), cookie = await signedIn(f);
  assert.equal((await worker.fetch(req('/api/profile/nesszerra', 'POST', 'null', cookie), f.env)).status, 400);
  assert.equal((await worker.fetch(req('/api/profile/nesszerra', 'POST', '[1]', cookie), f.env)).status, 400);
  assert.equal((await worker.fetch(req('/api/profile/nesszerra', 'POST', '{bad', cookie), f.env)).status, 400);
  assert.equal((await worker.fetch(req('/api/profile/nesszerra', 'POST', JSON.stringify({ avatar: 'x'.repeat(5000) }), cookie), f.env)).status, 413);
  assert.equal(f.forwarded.length, 0);
});

test('live sockets require a WebSocket upgrade; the relay routes are gone', async () => {
  const f = environment(), owner = await signedIn(f, true);
  assert.equal((await worker.fetch(req('/api/live/nesszerra'), f.env)).status, 426);
  assert.equal((await worker.fetch(req('/api/relay/nesszerra', 'GET', undefined, undefined, { Upgrade: 'websocket' }), f.env)).status, 404);
  assert.equal((await worker.fetch(req('/api/relay/code', 'POST', {}, owner), f.env)).status, 404);
  assert.equal(f.forwarded.length, 0);
});

// ---------- Twitch EventSub webhook ----------
const NOW = Date.parse('2026-10-01T12:00:00Z');
async function eventsub(f, body, { type = 'notification', id = 'msg-' + Math.random().toString(16).slice(2), at = NOW, sign = true, signature, headers = {} } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body), timestamp = new Date(at).toISOString().replace('Z', '123456Z');
  const sig = signature ?? (sign ? await signEventsub(await eventsubSecret(f.env), id, timestamp, raw) : 'sha256=' + '0'.repeat(64));
  // no Origin and no cookie, like Twitch
  return worker.fetch(new Request('https://chat.miolaf.xyz/api/eventsub', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Twitch-Eventsub-Message-Id': id, 'Twitch-Eventsub-Message-Timestamp': timestamp, 'Twitch-Eventsub-Message-Signature': sig, 'Twitch-Eventsub-Message-Type': type, 'Twitch-Eventsub-Subscription-Type': 'channel.chat.message', 'Twitch-Eventsub-Subscription-Version': '1', ...headers }, body: raw }), f.env);
}
const chatBody = (channel = 'nesszerra') => ({ subscription: { id: 'sub-1', status: 'enabled', type: 'channel.chat.message' }, event: { broadcaster_user_login: channel, chatter_user_id: '7', chatter_user_login: 'viewer', chatter_user_name: 'Viewer', message_id: 'chat-1', message: { text: '!strike' }, color: '#FF0000' } });

test('eventsub: the secret is derived from AUTH_SECRET; signed notifications reach the room without Origin or session', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const f = environment();
  const expected = createHmac('sha256', f.env.AUTH_SECRET).update('mini-chat:eventsub:v1').digest('hex');
  assert.equal(await eventsubSecret(f.env), expected);
  const res = await eventsub(f, chatBody(), { id: 'n-1' });
  assert.equal(res.status, 204);
  const sent = f.forwarded.at(-1);
  assert.deepEqual([sent.channel, sent.path, sent.body.messageId, sent.body.messageType, sent.body.subscription.id, sent.body.timestamp], ['nesszerra', '/eventsub', 'n-1', 'notification', 'sub-1', NOW], 'nanosecond fractions are truncated to milliseconds');
  assert.equal(sent.body.event.message.text, '!strike');
  // a disabled channel is accepted (204) but never routed
  const before = f.forwarded.length;
  assert.equal((await eventsub(f, chatBody('somechannel'))).status, 204);
  assert.equal(f.forwarded.length, before);
});

test('eventsub: bad signatures, stale or future timestamps, missing headers and oversized bodies are refused', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const f = environment();
  assert.equal((await eventsub(f, chatBody(), { sign: false })).status, 403);
  assert.equal((await eventsub(f, chatBody(), { signature: 'nonsense' })).status, 403);
  // a valid signature for a different body
  const other = await signEventsub(await eventsubSecret(f.env), 'x', new Date(NOW).toISOString().replace('Z', '123456Z'), '{}');
  assert.equal((await eventsub(f, chatBody(), { id: 'x', signature: other })).status, 403);
  assert.equal((await eventsub(f, chatBody(), { at: NOW - 601_000 })).status, 403, 'older than 10 minutes');
  assert.equal((await eventsub(f, chatBody(), { at: NOW + 61_000 })).status, 403, 'more than 1 minute in the future');
  assert.equal((await eventsub(f, chatBody(), { at: NOW - 590_000 })).status, 204);
  assert.equal((await eventsub(f, chatBody(), { headers: { 'Twitch-Eventsub-Message-Id': '' } })).status, 400);
  assert.equal((await eventsub(f, 'x'.repeat(64 * 1024 + 1))).status, 413);
  assert.equal((await eventsub(f, '{not json')).status, 400);
  assert.equal(f.forwarded.length, 1);
  assert.equal((await worker.fetch(new Request('https://chat.miolaf.xyz/api/eventsub'), f.env)).status, 405);
});

test('eventsub: verification answers the challenge as text/plain; revocation is forwarded; unknown types are ignored', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const f = environment();
  const res = await eventsub(f, { challenge: 'pogchamp-kappa-360noscope', subscription: { id: 'sub-1', status: 'webhook_callback_verification_pending' } }, { type: 'webhook_callback_verification' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  assert.equal(await res.text(), 'pogchamp-kappa-360noscope');
  assert.equal(f.forwarded.at(-1).body.messageType, 'webhook_callback_verification');
  const revoked = await eventsub(f, { subscription: { id: 'sub-1', status: 'authorization_revoked' } }, { type: 'revocation' });
  assert.equal(revoked.status, 204);
  assert.deepEqual([f.forwarded.at(-1).body.messageType, f.forwarded.at(-1).body.subscription.status], ['revocation', 'authorization_revoked']);
  const n = f.forwarded.length;
  assert.equal((await eventsub(f, { subscription: {} }, { type: 'something_new' })).status, 204);
  assert.equal(f.forwarded.length, n);
});

test('eventsub: a room failure is not acknowledged, so Twitch retries', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const f = environment();
  f.env.ROOMS = { idFromName: x => x, get: () => ({ fetch: async () => new Response('boom', { status: 500 }) }) };
  assert.equal((await eventsub(f, chatBody())).status, 503);
});

test('eventsub: an emote-heavy message (~30 KB) is forwarded as a few hundred bytes; a room 4xx is acknowledged', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const f = environment();
  const body = chatBody();
  const emote = { type: 'emote', text: 'Kappa', cheermote: null, emote: { id: 'emotesv2_' + 'a'.repeat(32), emote_set_id: '0123456789', owner_id: '0123456789', format: ['static', 'animated'] }, mention: null };
  body.event.message = { text: '!strike ' + 'Kappa '.repeat(80), fragments: Array.from({ length: 120 }, (_, i) => i % 2 ? { type: 'text', text: ' ', cheermote: null, emote: null, mention: null } : emote) };
  body.event.badges = Array.from({ length: 20 }, () => ({ set_id: 'subscriber', id: '12', info: '12' }));
  body.event.reply = { parent_message_body: 'x'.repeat(500) };
  body.event.message.fragments.push(...Array.from({ length: 60 }, () => emote));
  const raw = JSON.stringify(body);
  assert.ok(raw.length > 28_000 && raw.length < 64 * 1024, 'body is ' + raw.length + ' bytes');
  assert.equal((await eventsub(f, body)).status, 204);
  const sent = f.forwarded.at(-1);
  assert.ok(sent.options.body.length < 1500, 'room payload is ' + sent.options.body.length + ' bytes');
  assert.equal(sent.body.event.message.text, body.event.message.text.slice(0, 512));
  assert.equal(sent.body.event.message.fragments, undefined);
  assert.deepEqual([sent.body.event.chatter_user_id, sent.body.event.chatter_user_login, sent.body.event.color, sent.body.event.message_id], ['7', 'viewer', '#FF0000', 'chat-1']);
  // a room refusing a validly signed message must not turn into a Twitch retry loop
  f.env.ROOMS = { idFromName: x => x, get: () => ({ fetch: async () => Response.json({ error: 'request body too large' }, { status: 400 }) }) };
  assert.equal((await eventsub(f, chatBody())).status, 204);
});

// ---------- Connect chat (Helix lifecycle) ----------
function helixMock(t, { subscriptions = [], create = 202 } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const u = new URL(String(url)), method = init.method || 'GET';
    calls.push({ method, url: u, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined, auth: init.headers?.Authorization });
    if (u.host === 'id.twitch.tv') return Response.json({ access_token: 'app-token-1', expires_in: 5000 });
    if (method === 'GET') return Response.json({ data: subscriptions, pagination: {} });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (create !== 202) return Response.json({ message: 'missing authorization' }, { status: create });
    return Response.json({ data: [{ id: 'sub-new', status: 'webhook_callback_verification_pending', created_at: '2026-10-01T12:00:00Z' }] }, { status: 202 });
  });
  return calls;
}
const callback = 'https://chat.miolaf.xyz/api/eventsub';
const sub = (id, extra = {}) => ({ id, status: 'enabled', type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: '1', user_id: '1' }, transport: { method: 'webhook', callback }, created_at: '2026-09-30T00:00:00Z', ...extra });

test('connectChat creates exactly one webhook with the broadcaster condition and deletes stale ones', async (t) => {
  const f = environment(), owner = await signedIn(f, true);
  const calls = helixMock(t, { subscriptions: [sub('old-revoked', { status: 'authorization_revoked' }), sub('wrong-user', { condition: { broadcaster_user_id: '1', user_id: '9' } }), sub('other-channel', { condition: { broadcaster_user_id: '5', user_id: '5' }, transport: { method: 'webhook', callback: 'https://other.example/api/eventsub' } })] });
  const res = await worker.fetch(req('/api/admin/nesszerra', 'POST', { action: 'connectChat' }, owner), f.env);
  assert.equal(res.status, 200);
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.searchParams.get('id')), ['old-revoked', 'wrong-user']);
  const created = calls.find((c) => c.method === 'POST' && c.url.host === 'api.twitch.tv');
  assert.deepEqual(created.body.condition, { broadcaster_user_id: '1', user_id: '1' });
  assert.deepEqual([created.body.type, created.body.version, created.body.transport.method, created.body.transport.callback], ['channel.chat.message', '1', 'webhook', callback]);
  assert.equal(created.body.transport.secret, await eventsubSecret(f.env));
  assert.equal(created.auth, 'Bearer app-token-1');
  assert.deepEqual(f.forwarded.at(-1).body, { action: 'connected', subscriptionId: 'sub-new', status: 'webhook_callback_verification_pending', createdAt: Date.parse('2026-10-01T12:00:00Z') });
  // the app token is cached sealed, never stored in plain text
  assert.ok(f.entries.has('app-token:twitch'));
  assert.equal(JSON.stringify(f.entries.get('app-token:twitch')).includes('app-token-1'), false);
});

test('connectChat keeps an existing matching webhook instead of creating another', async (t) => {
  const f = environment(), owner = await signedIn(f, true);
  const calls = helixMock(t, { subscriptions: [sub('keep-me'), sub('dupe-pending', { status: 'webhook_callback_verification_pending' })] });
  assert.equal((await worker.fetch(req('/api/admin/nesszerra', 'POST', { action: 'connectChat' }, owner), f.env)).status, 200);
  assert.deepEqual(calls.filter((c) => c.method !== 'GET' && c.url.host === 'api.twitch.tv').map((c) => c.method + ' ' + (c.url.searchParams.get('id') || '')), ['DELETE dupe-pending']);
  assert.equal(f.forwarded.at(-1).body.subscriptionId, 'keep-me');
});

test('connectChat: a live subscription for the same channel on the other site is a clear 409 unless taken over', async (t) => {
  const f = environment(), owner = await signedIn(f, true);
  const other = { method: 'webhook', callback: 'https://test.chat.miolaf.xyz/api/eventsub' };
  const calls = helixMock(t, { subscriptions: [sub('on-test-site', { transport: other }), sub('dead-elsewhere', { status: 'webhook_callback_verification_failed', transport: { method: 'webhook', callback: 'https://old.example/api/eventsub' } })] });
  const res = await worker.fetch(req('/api/admin/nesszerra', 'POST', { action: 'connectChat' }, owner), f.env);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.connectedElsewhere, 'https://test.chat.miolaf.xyz');
  assert.match(body.error, /Chat is connected to https:\/\/test\.chat\.miolaf\.xyz\. Only one site can receive chat at a time/);
  assert.equal(calls.some((c) => c.method !== 'GET' && c.url.host === 'api.twitch.tv'), false, 'nothing is deleted or created without takeover');
  assert.equal(f.forwarded.some((x) => x.path === '/chat' && x.body), false);
  // takeover deletes the other site's subscription (and dead ones for this channel), then creates ours
  const taken = await worker.fetch(req('/api/admin/nesszerra', 'POST', { action: 'connectChat', takeover: true }, owner), f.env);
  assert.equal(taken.status, 200);
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.searchParams.get('id')), ['on-test-site', 'dead-elsewhere']);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.host === 'api.twitch.tv').length, 1);
  assert.equal(f.forwarded.at(-1).body.subscriptionId, 'sub-new');
  // the owner dev settings route takes the same option
  const dev = await worker.fetch(req('/api/dev/settings', 'POST', { action: 'connectChat' }, owner), f.env);
  assert.deepEqual([dev.status, (await dev.json()).connectedElsewhere], [409, 'https://test.chat.miolaf.xyz']);
});

test('connectChat: a Helix 409 on create (raced by another site) is the same clear conflict', async (t) => {
  const f = environment(), owner = await signedIn(f, true);
  helixMock(t, { create: 409 });
  const res = await worker.fetch(req('/api/admin/nesszerra', 'POST', { action: 'connectChat' }, owner), f.env);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.connectedElsewhere, 'another site');
  assert.match(body.error, /Only one site can receive chat at a time/);
});

test('connectChat: a Twitch authorization error tells the owner to reconnect Twitch', async (t) => {
  const f = environment(), owner = await signedIn(f, true);
  helixMock(t, { create: 403 });
  const res = await worker.fetch(req('/api/admin/nesszerra', 'POST', { action: 'connectChat' }, owner), f.env);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.reconnect, '/auth/login?connect=1');
  assert.match(body.error, /Reconnect Twitch at \/auth\/login\?connect=1/);
  assert.equal(f.forwarded.some((x) => x.path === '/chat' && x.body), false, 'the room is not told anything');
});

test('disconnectChat deletes the subscription and pauses the room; viewers cannot manage chat', async (t) => {
  const f = environment(), owner = await signedIn(f, true);
  const rooms = f.env.ROOMS;
  f.env.ROOMS = { idFromName: x => x, get: (c) => ({ fetch: async (url, o = {}) => new URL(url).pathname === '/chat' && !o.body ? Response.json({ connected: true, subscriptionId: 'sub-9' }) : rooms.get(c).fetch(url, o) }) };
  const calls = helixMock(t);
  assert.equal((await worker.fetch(req('/api/admin/nesszerra', 'POST', { action: 'disconnectChat' }, owner), f.env)).status, 200);
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.searchParams.get('id')), ['sub-9']);
  assert.deepEqual(f.forwarded.at(-1).body, { action: 'disconnected', reason: 'disconnected' });
  const viewer = await signedIn(f);
  assert.equal((await worker.fetch(req('/api/admin/nesszerra', 'POST', { action: 'connectChat' }, viewer), f.env)).status, 403);
});

test('local test mode marks chat connected without Twitch only for a loopback cf dev', async (t) => {
  const calls = helixMock(t);
  const f = environment(), owner = await signedIn(f, true);
  Object.assign(f.env, { MINI_LOCAL_TEST: '1', PUBLIC_ORIGIN: 'http://127.0.0.1:5199' });
  const local = (path, data) => new Request('http://127.0.0.1:5199' + path, { method: 'POST', headers: { Origin: 'http://127.0.0.1:5199', Cookie: owner, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await worker.fetch(local('/api/admin/nesszerra', { action: 'connectChat' }), f.env)).status, 200);
  assert.match(f.forwarded.at(-1).body.subscriptionId, /^local-[a-f0-9]{16}$/);
  assert.equal(calls.length, 0, 'no Twitch calls in local test mode');
  // the same flag on a public origin does nothing: production must talk to Twitch
  assert.equal(localTestMode({ MINI_LOCAL_TEST: '1', PUBLIC_ORIGIN: 'https://chat.miolaf.xyz' }, new URL('https://chat.miolaf.xyz/')), false);
  assert.equal(localTestMode({ MINI_LOCAL_TEST: '1', PUBLIC_ORIGIN: 'http://127.0.0.1:5199' }, new URL('https://chat.miolaf.xyz/')), false);
  assert.equal(localTestMode({ MINI_LOCAL_TEST: 'true', PUBLIC_ORIGIN: 'http://127.0.0.1:5199' }, new URL('http://127.0.0.1:5199/')), false);
  // an http origin without local test mode is refused before calling Twitch
  delete f.env.MINI_LOCAL_TEST;
  assert.equal((await worker.fetch(local('/api/admin/nesszerra', { action: 'connectChat' }), f.env)).status, 400);
});

test('unknown routes and channels that are not enabled', async () => {
  const f = environment();
  assert.equal((await worker.fetch(req('/api/nope'), f.env)).status, 404);
  assert.equal((await worker.fetch(req('/api/leaderboard/somechannel'), f.env)).status, 403);
  assert.equal((await worker.fetch(req('/api/state/nesszerra', 'DELETE'), f.env)).status, 405);
});

const DEV = 'dev-token-for-tests-0123456789abcdefghij';
function devReq(path, data, token = DEV, extra = {}) {
  return new Request('https://test.chat.miolaf.xyz' + path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...extra }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
}

test('dev token (test site only): a missing binding, a wrong token or no token is refused', async () => {
  const f = environment();
  f.entries.set('owner:nesszerra', { id: '1' });
  // production: no DEV_TOOLS_TOKEN binding, so even a well-formed token is refused and devtools do not exist
  assert.equal((await worker.fetch(devReq('/api/dev/diagnostics'), f.env)).status, 401);
  assert.equal((await worker.fetch(devReq('/api/devtools/nesszerra/chat', { userId: 't1', username: 'testbot_a', text: '!fight' }), f.env)).status, 401);
  assert.equal((await worker.fetch(req('/api/devtools/nesszerra/chat', 'POST', { userId: 't1', username: 'testbot_a', text: 'hi' }, await signedIn(f, true)), f.env)).status, 404, 'an owner session alone does not open devtools');
  f.env.DEV_TOOLS_TOKEN = DEV;
  assert.equal((await worker.fetch(devReq('/api/dev/diagnostics', undefined, DEV.slice(0, -1) + 'x'), f.env)).status, 401);
  assert.equal((await worker.fetch(devReq('/api/dev/diagnostics', undefined, 'short'), f.env)).status, 401);
  assert.equal((await worker.fetch(req('/api/admin/nesszerra'), f.env)).status, 401);
  // a token shorter than 32 characters in the binding never matches
  f.env.DEV_TOOLS_TOKEN = 'x'.repeat(31);
  assert.equal((await worker.fetch(devReq('/api/dev/diagnostics', undefined, 'x'.repeat(31)), f.env)).status, 401);
  assert.equal(f.forwarded.length, 0, 'nothing reached a room');
});

test('channel export (dev token only): room tables plus mod access, for a site of its own', async () => {
  const f = environment();
  assert.equal((await worker.fetch(req('/api/devtools/miolafff/export', 'GET', undefined, await signedIn(f, true)), f.env)).status, 404, 'an owner session alone cannot export');
  f.env.DEV_TOOLS_TOKEN = DEV;
  f.entries.set('broadcaster:miolafff', { sealed: 'x' });
  f.entries.set('modsconnected:miolafff', { at: 5 });
  const res = await worker.fetch(devReq('/api/devtools/miolafff/export'), f.env);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual({ channel: out.channel, tables: out.tables, auth: out.auth }, { channel: 'miolafff', tables: { path: '/export' }, auth: { broadcaster: { sealed: 'x' }, modsconnected: { at: 5 } } });
  assert.deepEqual({ channel: f.forwarded.at(-1).channel, method: f.forwarded.at(-1).options.method }, { channel: 'miolafff', method: undefined });
  assert.equal((await worker.fetch(devReq('/api/devtools/miolafff/export', {}), f.env)).status, 405);
});

test('dev token (test site only): the right token acts as the owner and can seed profiles and chat lines', async () => {
  const f = environment();
  f.entries.set('owner:nesszerra', { id: '1' });
  f.env.DEV_TOOLS_TOKEN = DEV;
  assert.equal((await worker.fetch(devReq('/api/dev/diagnostics'), f.env)).status, 200);
  const admin = await worker.fetch(devReq('/api/admin/nesszerra', { action: 'removePlayer', userId: 'testbot:a' }), f.env);
  assert.equal(admin.status, 200, 'no Origin header needed with a token');
  assert.equal(f.forwarded.at(-1).body.actorId, '1');
  const settings = await worker.fetch(devReq('/api/dev/settings', { action: 'config', payload: { patch: { quickDuel: false } } }), f.env);
  assert.notEqual(settings.status, 403, 'dev routes skip the Origin check with a token too');
  const p =await worker.fetch(devReq('/api/devtools/nesszerra/profile', { userId: 'testbot:a', username: 'TestBot_A', avatar: 'player', color: '#22aa44', defaultAbility: 'heavy' }), f.env);
  assert.equal(p.status, 200);
  assert.equal(f.forwarded.at(-1).path, '/profile');
  assert.equal(f.forwarded.at(-1).options.headers['X-Mini-User-Id'] ?? new Headers(f.forwarded.at(-1).options.headers).get('X-Mini-User-Id'), 'testbot:a');
  assert.equal(f.forwarded.at(-1).body.username, 'testbot_a');
  const c = await worker.fetch(devReq('/api/devtools/miolafff/chat', { userId: 'testbot:a', username: 'testbot_a', text: '!fight' }), f.env);
  assert.equal(c.status, 200);
  assert.deepEqual({ channel: f.forwarded.at(-1).channel, path: f.forwarded.at(-1).path, text: f.forwarded.at(-1).body.text }, { channel: 'miolafff', path: '/dev-chat', text: '!fight' });
  assert.equal((await worker.fetch(devReq('/api/devtools/nesszerra/profile', { userId: 'bad id!', username: 'x' }), f.env)).status, 400);
  assert.equal((await worker.fetch(devReq('/api/devtools/nesszerra/profile', { userId: 't', username: 'x', color: 'red' }), f.env)).status, 400);
  assert.equal((await worker.fetch(devReq('/api/devtools/somechannel/chat', { userId: 't', username: 'x', text: 'hi' }), f.env)).status, 403);
  assert.equal((await worker.fetch(devReq('/api/devtools/nesszerra/nope', {}), f.env)).status, 404);
  // Bots buy and bring pets through the same room calls as signed-in viewers.
  assert.equal((await worker.fetch(devReq('/api/devtools/nesszerra/shop', { userId: 'testbot:a', username: 'testbot_a', kind: 'pet', id: 'fox' }), f.env)).status, 200);
  assert.deepEqual({ path: f.forwarded.at(-1).path, body: f.forwarded.at(-1).body }, { path: '/shop', body: { userId: 'testbot:a', kind: 'pet', id: 'fox' } });
  assert.equal((await worker.fetch(devReq('/api/devtools/nesszerra/shop', { userId: 'testbot:a', username: 'testbot_a', kind: 'car', id: 'fox' }), f.env)).status, 400);
  await worker.fetch(devReq('/api/devtools/nesszerra/profile', { userId: 'testbot:a', username: 'testbot_a', pet: 'fox' }), f.env);
  assert.equal(f.forwarded.at(-1).body.pet, 'fox');
  assert.equal((await worker.fetch(devReq('/api/devtools/nesszerra/profile', { userId: 'testbot:a', username: 'testbot_a', pet: 7 }), f.env)).status, 400);
});

test('dev token binding: declared for the test deploy only, never for production', async () => {
  const { default: config } = await import('../cloudflare.config.ts');
  const env = (mode) => config({ mode }).worker.env;
  assert.ok('DEV_TOOLS_TOKEN' in env('test'));
  assert.ok(!('DEV_TOOLS_TOKEN' in env(undefined)));
  assert.ok(!('DEV_TOOLS_TOKEN' in env('production')));
});

test('pets: the catalog and images are public; uploads and deletes need a mod; the shop needs sign-in', async () => {
  const f = environment();
  assert.equal((await worker.fetch(req('/api/pets/nesszerra'), f.env)).status, 200);
  assert.equal(f.forwarded.at(-1).path, '/pets');
  await worker.fetch(req('/api/pets/nesszerra/p-blob-abc123'), f.env);
  assert.equal(f.forwarded.at(-1).path, '/pets/p-blob-abc123');
  assert.equal((await worker.fetch(req('/api/pets/nesszerra', 'POST', {}), f.env)).status, 401);
  assert.equal((await worker.fetch(req('/api/pets/nesszerra', 'POST', {}, await signedIn(f)), f.env)).status, 403);
  const owner = await signedIn(f, true), sent = f.forwarded.length;
  const bad = await worker.fetch(req('/api/pets/nesszerra', 'POST', { label: 'Blob', tier: 'mythic' }, owner), f.env);
  assert.equal((await bad.json()).reason, 'invalid_tier');
  assert.equal((await worker.fetch(req('/api/pets/nesszerra/fox', 'DELETE', undefined, owner), f.env)).status, 404, 'built-in pets cannot be deleted');
  assert.equal(f.forwarded.length, sent, 'rejected uploads and deletes never reach the room');
  assert.equal((await worker.fetch(req('/api/pets/nesszerra/p-blob-abc123', 'DELETE', undefined, owner), f.env)).status, 200);
  assert.equal(f.forwarded.at(-1).path, '/pets/p-blob-abc123');

  assert.equal((await worker.fetch(req('/api/shop/nesszerra', 'POST', { kind: 'pet', id: 'fox' }), f.env)).status, 401);
  const viewer = await signedIn(f);
  assert.equal((await worker.fetch(req('/api/shop/nesszerra', 'POST', { kind: 'car', id: 'fox' }, viewer), f.env)).status, 400);
  assert.equal((await worker.fetch(req('/api/shop/nesszerra', 'POST', { kind: 'pet', id: 'x'.repeat(65) }, viewer), f.env)).status, 400);
  for (const price of ['30', -1, 1.5, null]) assert.equal((await worker.fetch(req('/api/shop/nesszerra', 'POST', { kind: 'pet', id: 'fox', price }, viewer), f.env)).status, 400, 'price ' + price);
  assert.equal((await worker.fetch(req('/api/shop/nesszerra', 'GET'), f.env)).status, 200, 'the shop list is public');
  assert.equal(f.forwarded.at(-1).path, '/shop');
  assert.equal((await worker.fetch(req('/api/shop/nesszerra/x', 'GET'), f.env)).status, 405);
  assert.equal((await worker.fetch(req('/api/shop/nesszerra', 'POST', { kind: 'trail', id: 'flames' }, viewer), f.env)).status, 200);
  assert.equal((await worker.fetch(req('/api/shop/nesszerra', 'POST', { kind: 'slot' }, viewer), f.env)).status, 200);
  assert.deepEqual(f.forwarded.at(-1).body, { userId: '2', kind: 'slot', id: '' });
  assert.equal((await worker.fetch(req('/api/shop/nesszerra', 'POST', { kind: 'pet', id: 'fox', userId: 'forged' }, viewer), f.env)).status, 200);
  assert.deepEqual(f.forwarded.at(-1).body, { userId: '2', kind: 'pet', id: 'fox' });
  assert.equal(f.forwarded.at(-1).path, '/shop');
  assert.equal((await worker.fetch(req('/api/profile/nesszerra', 'POST', { avatar: 'player', color: '#aabbcc', defaultAbility: 'heal', pet: 7 }, viewer), f.env)).status, 400);
  assert.equal((await worker.fetch(req('/api/profile/nesszerra', 'POST', { avatar: 'player', color: '#aabbcc', defaultAbility: 'heal', pet: 'fox' }, viewer), f.env)).status, 200);
  assert.equal(f.forwarded.at(-1).body.pet, 'fox');
  // Cosmetics and the build slot ride along; the room checks ownership.
  for (const bad of [{ title: 7 }, { trail: 'x'.repeat(33) }, { build: 5 }, { build: 1.5 }, { build: '1' }]) assert.equal((await worker.fetch(req('/api/profile/nesszerra', 'POST', { avatar: 'player', color: '#aabbcc', defaultAbility: 'heal', ...bad }, viewer), f.env)).status, 400, JSON.stringify(bad));
  assert.equal((await worker.fetch(req('/api/profile/nesszerra', 'POST', { avatar: 'player', color: '#aabbcc', defaultAbility: 'heal', title: 'legend', winEffect: '', build: 2 }, viewer), f.env)).status, 200);
  assert.deepEqual((({ title, winEffect, build, trail }) => [title, winEffect, build, trail])(f.forwarded.at(-1).body), ['legend', '', 2, undefined]);
});

// ---------- PixFray chat bot (CHAT_BOT) ----------
const botBody = (text) => ({ subscription: { id: 'sub-bot', status: 'enabled', type: 'channel.chat.message', condition: { broadcaster_user_id: '1', user_id: '99' } }, event: { broadcaster_user_id: '1', broadcaster_user_login: 'nesszerra', chatter_user_id: '7', chatter_user_login: 'viewer', chatter_user_name: 'Viewer', message_id: 'chat-9', message: { text } } });

test('chat bot: only commands reach the room; its reply is sent as the bot, threaded, never as a command', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const f = environment(), waits = [];
  f.env.ROOMS = { idFromName: x => x, get: channel => ({ async fetch(url, options = {}) {
    f.forwarded.push({ channel, url, body: JSON.parse(options.body) });
    return Response.json({ ok: true, reply: '!ranks are at pixfray' });
  } }) };
  const ctx = { waitUntil: (p) => waits.push(p) };
  const post = async (body) => {
    const raw = JSON.stringify(body), timestamp = new Date(NOW).toISOString(), id = 'm-' + Math.random();
    return worker.fetch(new Request('https://staging.pixfray.xyz/api/eventsub', { method: 'POST', headers: { 'Twitch-Eventsub-Message-Id': id, 'Twitch-Eventsub-Message-Timestamp': timestamp, 'Twitch-Eventsub-Message-Signature': await signEventsub(await eventsubSecret(f.env), id, timestamp, raw), 'Twitch-Eventsub-Message-Type': 'notification', 'Twitch-Eventsub-Subscription-Type': 'channel.chat.message' }, body: raw }), f.env, ctx);
  };
  const helix = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).startsWith('https://id.twitch.tv')) return Response.json({ access_token: 'app-token-1', expires_in: 5000 });
    helix.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({ data: [{ message_id: 'r1', is_sent: true }] });
  });
  assert.equal((await post(botBody('hello chat'))).status, 204);
  assert.equal(f.forwarded.length, 0, 'plain chat costs no room request');
  assert.equal((await post(botBody('  !ranks'))).status, 204);
  assert.equal(f.forwarded.length, 1);
  assert.equal(f.forwarded[0].body.bot, true);
  assert.equal(f.forwarded[0].body.botId, '99');
  assert.match(f.forwarded[0].url, /\/eventsub\?origin=https%3A%2F%2F/);
  await Promise.all(waits);
  assert.equal(helix.length, 1);
  assert.equal(helix[0].url, 'https://api.twitch.tv/helix/chat/messages');
  assert.deepEqual(helix[0].body, { broadcaster_id: '1', sender_id: '99', message: 'PixFray: !ranks are at pixfray', reply_parent_message_id: 'chat-9' });
  // what Twitch said goes back to the room, for the bot status and the owner log
  await Promise.all(waits);
  assert.equal(f.forwarded.length, 2);
  assert.match(f.forwarded[1].url, /\/bot-sent$/);
  assert.deepEqual(f.forwarded[1].body, { results: [{ sent: true, reason: '' }] });
});

test('chat bot: drop reasons read as words', () => {
  assert.equal(botDropText('msg_duplicate'), 'the same line twice within 30 s (msg_duplicate)');
  assert.match(botDropText('Twitch send chat message failed (403)'), /may not chat here \(403\)/);
  assert.equal(botDropText('Twitch send chat message failed (500)'), 'Twitch send chat message failed (500)');
  assert.equal(botDropText(''), 'unknown');
});

test('chat bot: a signed-up channel gets its verification, and the bot answers on its own channel', async (t) => {
  t.mock.method(Date, 'now', () => NOW);
  const f = environment(), waits = [];
  f.env.CHAT_BOT = '1';
  f.entries.set('channel:solo', { id: '42', login: 'solo', enabledAt: NOW });
  f.entries.set('bot:twitch', { id: '42', login: 'solo' });
  f.env.ROOMS = { idFromName: x => x, get: channel => ({ async fetch(url, options = {}) {
    f.forwarded.push({ channel, url, body: JSON.parse(options.body) });
    return Response.json({ ok: true, reply: 'solo has 1000 elo' });
  } }) };
  const post = async (body, type = 'notification') => {
    const raw = JSON.stringify(body), timestamp = new Date(NOW).toISOString(), id = 'm-' + Math.random();
    return worker.fetch(new Request('https://staging.pixfray.xyz/api/eventsub', { method: 'POST', headers: { 'Twitch-Eventsub-Message-Id': id, 'Twitch-Eventsub-Message-Timestamp': timestamp, 'Twitch-Eventsub-Message-Signature': await signEventsub(await eventsubSecret(f.env), id, timestamp, raw), 'Twitch-Eventsub-Message-Type': type, 'Twitch-Eventsub-Subscription-Type': 'channel.chat.message' }, body: raw }), f.env, { waitUntil: (p) => waits.push(p) });
  };
  const helix = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).startsWith('https://id.twitch.tv')) return Response.json({ access_token: 'app-token-1', expires_in: 5000 });
    helix.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({ data: [{ message_id: 'r1', is_sent: true }] });
  });
  const condition = { broadcaster_user_id: '42', user_id: '42' };
  const verify = await post({ subscription: { id: 'sub-solo', status: 'webhook_callback_verification_pending', type: 'channel.chat.message', condition }, challenge: 'abc' }, 'webhook_callback_verification');
  assert.equal(await verify.text(), 'abc');
  assert.deepEqual(f.forwarded.map((x) => x.channel), ['nesszerra', 'miolafff', 'solo'], 'the signed-up room hears its verification');
  f.forwarded.length = 0;
  const line = (login, text) => ({ subscription: { id: 'sub-solo', status: 'enabled', type: 'channel.chat.message', condition }, event: { broadcaster_user_id: '42', broadcaster_user_login: login, chatter_user_id: '42', chatter_user_login: 'solo', chatter_user_name: 'solo', message_id: 'chat-42', message: { text } } });
  assert.equal((await post(line('stranger', '!elo'))).status, 204);
  assert.equal(f.forwarded.length, 0, 'a channel that never signed up is ignored');
  assert.equal((await post(line('solo', '!elo'))).status, 204);
  assert.equal(f.forwarded.length, 1);
  assert.equal(f.forwarded[0].channel, 'solo');
  assert.equal(f.forwarded[0].body.bot, true, 'the bot is also the broadcaster here');
  assert.equal(f.forwarded[0].body.botId, '42');
  await Promise.all(waits);
  assert.deepEqual(helix.map((x) => x.body.sender_id), ['42']);
});

test('chat bot: Connect chat subscribes as the signed-in bot account, and asks for it first', async (t) => {
  const f = environment(), owner = await signedIn(f, true);
  Object.assign(f.env, { CHAT_BOT: '1', BOT_LOGIN: 'pixbot', OWNER_TWITCH_ID: '1' });
  const calls = helixMock(t, { subscriptions: [sub('broadcaster-self'), sub('other-channel', { condition: { broadcaster_user_id: '5', user_id: '99' } })] });
  const first = await worker.fetch(req('/api/admin/nesszerra', 'POST', { action: 'connectChat' }, owner), f.env);
  assert.equal(first.status, 409);
  assert.match((await first.json()).error, /\/auth\/login\?bot=1/);
  f.entries.set('bot:twitch', { id: '99', login: 'pixbot' });
  assert.equal((await worker.fetch(req('/api/admin/nesszerra', 'POST', { action: 'connectChat' }, owner), f.env)).status, 200);
  const created = calls.find((c) => c.method === 'POST' && c.url.host === 'api.twitch.tv');
  assert.deepEqual(created.body.condition, { broadcaster_user_id: '1', user_id: '99' });
  assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.searchParams.get('id')), ['broadcaster-self'], "the channel's old self-read subscription goes; another channel's bot subscription stays");
  const view = await (await worker.fetch(req('/api/admin/nesszerra', 'GET', undefined, owner), f.env)).json();
  assert.deepEqual(view.chatBot, { login: 'pixbot', debug: false });
});

test('chat bot: bot sign-in needs CHAT_BOT and asks for the chat scopes', async () => {
  const f = environment();
  assert.equal((await worker.fetch(req('/auth/login?bot=1'), f.env)).status, 403);
  Object.assign(f.env, { CHAT_BOT: '1', BOT_LOGIN: 'pixbot' });
  const res = await worker.fetch(req('/auth/login?bot=1'), f.env);
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get('Location')).searchParams.get('scope'), 'user:read:chat user:write:chat user:bot');
  const allow = await worker.fetch(req('/auth/login?channel=nesszerra&connect=bot'), f.env);
  assert.equal(new URL(allow.headers.get('Location')).searchParams.get('scope'), 'moderation:read channel:bot');
});

test('chat bot: a rate-limited reply (429) is retried after a short wait, then gives up', async (t) => {
  const f = environment(), waits = [];
  let statuses = [429, 200];
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).startsWith('https://id.twitch.tv')) return Response.json({ access_token: 'app-token-1', expires_in: 5000 });
    const status = statuses.shift();
    return status === 200 ? Response.json({ data: [{ message_id: 'r1', is_sent: true }] }) : new Response('{}', { status });
  });
  const send = () => sendChatMessage(f.env, { broadcasterId: '1', senderId: '99', message: 'hi', replyTo: 'm1', sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(await send(), { sent: true, reason: '' });
  assert.deepEqual(waits, [1100]);
  statuses = [429, 429, 429];
  await assert.rejects(send(), /\(429\)/);
  assert.deepEqual(waits, [1100, 1100, 2200]);
});

test('chat bot: a line Twitch drops as a duplicate is resent with an invisible tag character, at most twice', async (t) => {
  const f = environment(), sent = [];
  let dupes = 1;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).startsWith('https://id.twitch.tv')) return Response.json({ access_token: 'app-token-1', expires_in: 5000 });
    sent.push(JSON.parse(init.body).message);
    return Response.json({ data: [dupes-- > 0 ? { message_id: '', is_sent: false, drop_reason: { code: 'msg_duplicate' } } : { message_id: 'r1', is_sent: true }] });
  });
  const send = () => sendChatMessage(f.env, { broadcasterId: '1', senderId: '99', message: 'PixFray help', replyTo: 'm1' });
  assert.deepEqual(await send(), { sent: true, reason: '' });
  assert.deepEqual(sent, ['PixFray help', 'PixFray help \u{E0000}']);
  sent.length = 0; dupes = 9;
  assert.deepEqual(await send(), { sent: false, reason: 'msg_duplicate' });
  assert.deepEqual(sent, ['PixFray help', 'PixFray help \u{E0000}', 'PixFray help \u{E0000}\u{E0000}']);
});

test('chat bot: several reply lines go out in order, about a second apart, and one failure does not stop the rest', async (t) => {
  const f = environment(), waits = [], sent = [];
  let first = true;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url).startsWith('https://id.twitch.tv')) return Response.json({ access_token: 'app-token-1', expires_in: 5000 });
    sent.push(JSON.parse(init.body).message);
    if (first) { first = false; return new Response('{}', { status: 500 }); }
    return Response.json({ data: [{ message_id: 'r', is_sent: true }] });
  });
  const out = await sendChatMessages(f.env, { broadcasterId: '1', senderId: '99', replyTo: 'm1', messages: ['one', 'two', 'three'], sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(sent, ['one', 'two', 'three']);
  assert.deepEqual(waits, [1100, 1100]);
  assert.deepEqual(out.map((r) => r.sent), [false, true, true]);
});

test('check-in test mode: a mod or the owner turns it on through /api/admin; viewers cannot', async () => {
  const f = environment();
  assert.equal((await worker.fetch(req('/api/admin/nesszerra', 'POST', { action: 'checkinTest', value: true }, await signedIn(f)), f.env)).status, 403);
  assert.equal(f.forwarded.some((x) => x.path === '/checkin-test'), false);
  const res = await worker.fetch(req('/api/admin/nesszerra', 'POST', { action: 'checkinTest', value: true }, await signedIn(f, true)), f.env);
  assert.equal(res.status, 200);
  assert.deepEqual(f.forwarded.find((x) => x.path === '/checkin-test').body, { on: true, by: 'V' });
});

test('check-in test mode: only on the site channel', async () => {
  const f = environment();
  const res = await worker.fetch(req('/api/admin/miolafff', 'POST', { action: 'checkinTest', value: true }, await signedIn(f, true)), f.env);
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /only for nesszerra's channel/);
  assert.equal(f.forwarded.some((x) => x.path === '/checkin-test'), false);
});

test('viewer sprites: only the owner may wear one; sends need sign-in, reviews need a mod, AI redraw refunds on failure', async () => {
  const f = environment(), cookie = await signedIn(f);
  const rooms = f.env.ROOMS.get;
  f.env.ROOMS = { idFromName: x => x, get: channel => ({ async fetch(url, options = {}) {
    const path = new URL(url).pathname;
    if (path === '/catalog') return Response.json([{ id: 'v-mine-aaaaaa', owner: '2' }, { id: 'v-theirs-bbbbbb', owner: '9' }]);
    if (path === '/sprites/ai') { f.forwarded.push({ path, body: JSON.parse(options.body) }); return Response.json({ ok: true, left: 2 }); }
    return rooms(channel).fetch(url, options);
  } }) };
  const save = (avatar) => worker.fetch(req('/api/profile/nesszerra', 'POST', { avatar, color: '#aabbcc', defaultAbility: 'heal' }, cookie), f.env);
  assert.equal((await save('v-mine-aaaaaa')).status, 200);
  const theirs = await save('v-theirs-bbbbbb');
  assert.deepEqual([theirs.status, (await theirs.json()).error], [403, 'That sprite belongs to another viewer']);

  assert.equal((await worker.fetch(req('/api/sprite/nesszerra'), f.env)).status, 401);
  const status = await (await worker.fetch(req('/api/sprite/nesszerra', 'GET', undefined, cookie), f.env)).json();
  assert.deepEqual(status.ai, { available: false, left: 0 });
  // The room gets the session's identity, never one from the body.
  const png = 'data:image/png;base64,' + Buffer.from(makePng(32, 48)).toString('base64');
  const sent = await worker.fetch(req('/api/sprite/nesszerra', 'POST', { label: 'Cat', image: png, userId: '1' }, cookie), f.env);
  assert.equal(sent.status, 200);
  assert.deepEqual((({ userId, username, label }) => ({ userId, username, label }))(f.forwarded.at(-1).body), { userId: '2', username: 'viewer', label: 'Cat' });
  assert.equal((await worker.fetch(req('/api/sprite/nesszerra', 'POST', { label: 'Cat', image: b64png(200, 20) }, cookie), f.env)).status, 400);
  // Mods only: the review list and actions.
  assert.equal((await worker.fetch(req('/api/sprites/nesszerra', 'GET', undefined, cookie), f.env)).status, 403);
  assert.equal((await worker.fetch(req('/api/sprites/nesszerra/v-mine-aaaaaa', 'POST', { action: 'approve' }, cookie), f.env)).status, 403);

  // AI redraw: off without the binding; with it, a failed model call gives the redraw back.
  assert.equal((await worker.fetch(req('/api/sprite/nesszerra/redraw', 'POST', { image: b64png(64, 64) }, cookie), f.env)).status, 503);
  let input = null;
  f.env.AI = { async run(model, { multipart }) { input = { model, type: multipart.contentType }; return { image: 'QUJD' }; } };
  const drawn = await worker.fetch(req('/api/sprite/nesszerra/redraw', 'POST', { image: b64png(64, 64) }, cookie), f.env);
  assert.deepEqual(await drawn.json(), { ok: true, image: 'QUJD', left: 2 });
  assert.equal(input.model, '@cf/black-forest-labs/flux-2-klein-4b');
  assert.match(input.type, /^multipart\/form-data/);
  assert.equal((await worker.fetch(req('/api/sprite/nesszerra/redraw', 'POST', { image: b64png(512, 64) }, cookie), f.env)).status, 400);
  f.env.AI = { async run() { throw new Error('capacity'); } };
  const failed = await worker.fetch(req('/api/sprite/nesszerra/redraw', 'POST', { image: b64png(64, 64) }, cookie), f.env);
  assert.equal(failed.status, 502);
  assert.deepEqual(f.forwarded.filter(x => x.path === '/sprites/ai').map(x => x.body.op), ['take', 'take', 'refund']);
});
