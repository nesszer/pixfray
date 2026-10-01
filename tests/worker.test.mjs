// Worker routing, gates and validation, with in-memory AuthStore/ChannelRoom stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/worker.js';
import { digest } from '../server/auth.js';

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

test('live and relay sockets require a WebSocket upgrade; relay requires a valid credential', async () => {
  const f = environment();
  assert.equal((await worker.fetch(req('/api/live/nesszerra'), f.env)).status, 426);
  assert.equal((await worker.fetch(req('/api/relay/nesszerra', 'GET', undefined, undefined, { Upgrade: 'websocket' }), f.env)).status, 401);
  assert.equal((await worker.fetch(req('/api/relay/nesszerra', 'GET', undefined, undefined, { Upgrade: 'websocket', Authorization: 'Bearer ' + 'b'.repeat(64) }), f.env)).status, 403);
  assert.equal(f.forwarded.length, 0);
});

test('paired relay credential opens the relay socket; revoke invalidates it', async () => {
  const f = environment(), owner = await signedIn(f, true);
  const code = await (await worker.fetch(req('/api/relay/code', 'POST', {}, owner), f.env)).json();
  assert.match(code.code, /^[a-f0-9]{64}$/);
  const paired = await (await worker.fetch(new Request('https://chat.miolaf.xyz/api/relay/pair', { method: 'POST', body: JSON.stringify({ code: code.code }) }), f.env)).json();
  const open = () => worker.fetch(req('/api/relay/nesszerra', 'GET', undefined, undefined, { Upgrade: 'websocket', Authorization: 'Bearer ' + paired.credential }), f.env);
  assert.equal((await open()).status, 200);
  assert.equal(f.forwarded.at(-1).path, '/relay');
  assert.equal((await worker.fetch(req('/api/relay/revoke', 'POST', {}, owner), f.env)).status, 200);
  assert.equal(f.forwarded.at(-1).body.action, 'disconnectRelay');
  assert.equal((await open()).status, 403);
});

test('unknown routes and the disabled production channel', async () => {
  const f = environment();
  assert.equal((await worker.fetch(req('/api/nope'), f.env)).status, 404);
  assert.equal((await worker.fetch(req('/api/leaderboard/miolafff'), f.env)).status, 403);
  assert.equal((await worker.fetch(req('/api/state/nesszerra', 'DELETE'), f.env)).status, 405);
});
