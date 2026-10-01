// Worker routing, gates and validation, with in-memory AuthStore/ChannelRoom stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/worker.js';
import { createHmac } from 'node:crypto';
import { digest } from '../server/auth.js';
import { eventsubSecret, signEventsub, localTestMode } from '../server/eventsub.js';

function environment() {
  const entries = new Map(), forwarded = [];
  const env = {
    AUTH_SECRET: 'test-only-auth-key', INTERNAL_SECRET: 'test-only-internal-key',
    TWITCH_CLIENT_ID: 'test-app', TWITCH_CLIENT_SECRET: 'test-secret',
    AUTH: { idFromName: x => x, get: () => ({ async fetch(url, options) {
      const u = new URL(url), key = u.searchParams.get('key'), method = options.method;
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

test('dev token (test site only): the right token acts as the owner and can seed profiles and chat lines', async () => {
  const f = environment();
  f.entries.set('owner:nesszerra', { id: '1' });
  f.env.DEV_TOOLS_TOKEN = DEV;
  assert.equal((await worker.fetch(devReq('/api/dev/diagnostics'), f.env)).status, 200);
  const admin = await worker.fetch(devReq('/api/admin/nesszerra', { action: 'removePlayer', userId: 'testbot:a' }), f.env);
  assert.equal(admin.status, 200, 'no Origin header needed with a token');
  assert.equal(f.forwarded.at(-1).body.actorId, '1');
  const p = await worker.fetch(devReq('/api/devtools/nesszerra/profile', { userId: 'testbot:a', username: 'TestBot_A', avatar: 'player', color: '#22aa44', defaultAbility: 'heavy' }), f.env);
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
});

test('dev token binding: declared for the test deploy only, never for production', async () => {
  const { default: config } = await import('../cloudflare.config.ts');
  const env = (mode) => config({ mode }).worker.env;
  assert.ok('DEV_TOOLS_TOKEN' in env('test'));
  assert.ok(!('DEV_TOOLS_TOKEN' in env(undefined)));
  assert.ok(!('DEV_TOOLS_TOKEN' in env('production')));
});
