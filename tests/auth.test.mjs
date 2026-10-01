import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/worker.js';
import { digest, seal, unseal, CONNECT_SCOPES } from '../server/auth.js';

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
    ROOMS: { idFromName: x => x, get: channel => ({ async fetch(url, options) {
      forwarded.push({ channel, url, options });
      if (new URL(url).pathname === '/catalog') return Response.json([]);
      return Response.json(options.body ? JSON.parse(options.body) : { channel });
    } }) },
    ASSETS: { fetch: async () => Response.json([{ id: 'player' }]) }
  };
  return { env, entries, forwarded };
}
async function signedIn(fixture, owner = false) {
  const cookie = '1'.repeat(64), user = { id: owner ? '1' : '2', login: owner ? 'nesszerra' : 'viewer', displayName: 'Viewer' };
  fixture.entries.set('owner:nesszerra', { id: '1' });
  fixture.entries.set('session:' + await digest(cookie), { user });
  return 'mini_session=' + cookie;
}
function req(path, method = 'GET', data, cookie, origin = 'https://chat.miolaf.xyz') {
  return new Request('https://chat.miolaf.xyz' + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: origin, 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
}

test('cross-origin writes and unsigned profile writes are rejected', async () => {
  const f = environment();
  assert.equal((await worker.fetch(req('/api/profile/nesszerra', 'POST', { avatar: 'player' }, undefined, 'https://evil.example'), f.env)).status, 403);
  assert.equal((await worker.fetch(req('/api/profile/nesszerra', 'POST', { avatar: 'player' }), f.env)).status, 401);
  assert.equal(f.forwarded.length, 0);
});
test('profile identity is derived from session, ignoring forged user IDs', async () => {
  const f = environment(), cookie = await signedIn(f);
  const r = await worker.fetch(req('/api/profile/nesszerra', 'POST', { userId: '1', username: 'nesszerra', avatar: 'player', color: '#ffffff', defaultAbility: 'heal' }, cookie), f.env);
  assert.equal(r.status, 200);
  const saved = await r.json(); assert.equal(saved.userId, '2'); assert.equal(saved.username, 'viewer');
  assert.equal(f.forwarded.at(-1).options.headers.get('X-Mini-Internal'), f.env.INTERNAL_SECRET);
});
test('production is inaccessible before broadcaster onboarding', async () => {
  const f = environment(), cookie = await signedIn(f, true);
  const r = await worker.fetch(req('/api/state/miolafff', 'GET', undefined, cookie), f.env);
  assert.equal(r.status, 403); assert.equal(f.forwarded.length, 0);
});
test('a viewer cannot grant themselves mod or developer permissions', async () => {
  const f = environment(), cookie = await signedIn(f);
  assert.equal((await worker.fetch(req('/api/admin/nesszerra', 'POST', { actorId: '1', owner: true, action: 'resetAllRanks' }, cookie), f.env)).status, 403);
  assert.equal((await worker.fetch(req('/api/admin/nesszerra', 'POST', { action: 'connectChat' }, cookie), f.env)).status, 403);
  assert.equal((await worker.fetch(req('/api/dev/save', 'POST', { owner: true }, cookie), f.env)).status, 403);
});
test('connect=1 asks for the chat scopes the EventSub webhook needs', async () => {
  const f = environment();
  const r = await worker.fetch(req('/auth/login?connect=1'), f.env);
  assert.equal(r.status, 302);
  assert.deepEqual(new URL(r.headers.get('Location')).searchParams.get('scope').split(' '), CONNECT_SCOPES);
  assert.deepEqual(CONNECT_SCOPES, ['moderation:read', 'user:read:chat', 'user:bot', 'channel:bot']);
  assert.equal(new URL((await worker.fetch(req('/auth/login'), f.env)).headers.get('Location')).searchParams.get('scope'), '', 'plain sign-in asks for nothing');
});
test('a connect=1 callback without every chat scope is refused with a restart hint', async (t) => {
  const f = environment();
  const login = await worker.fetch(req('/auth/login?connect=1'), f.env);
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    if (u.endsWith('/oauth2/token')) return Response.json({ access_token: 'user-token', refresh_token: 'r' });
    if (u.endsWith('/oauth2/validate')) return Response.json({ client_id: 'test-app', user_id: '1', scopes: ['moderation:read', 'user:read:chat'] });
    return Response.json({ data: [{ id: '1', login: 'nesszerra', display_name: 'nesszerra' }] });
  });
  const r = await worker.fetch(new Request('https://chat.miolaf.xyz/auth/callback?code=c&state=' + state, { headers: { Cookie: 'mini_oauth=' + state } }), f.env);
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /user:bot, channel:bot\. Restart at \/auth\/login\?connect=1/);
  assert.equal(f.entries.has('broadcaster:nesszerra'), false);
});
test('OAuth state mismatch is rejected without a token exchange', async () => {
  const f = environment();
  const r = await worker.fetch(req('/auth/callback?state=wrong&code=forged'), f.env);
  assert.equal(r.status, 400);
});
test('stored Twitch tokens are authenticated ciphertext', async () => {
  const f = environment(), secret = { access_token: 'private-value', refresh_token: 'refresh-value' };
  const encrypted = await seal(f.env, secret);
  assert.equal(JSON.stringify(encrypted).includes('private-value'), false);
  assert.deepEqual(await unseal(f.env, encrypted), secret);
  const corrupted = { ...encrypted, data: encrypted.data.slice(0, 8) + 'AAAA' + encrypted.data.slice(12) };
  await assert.rejects(unseal(f.env, corrupted));
});
