// Security headers, the trimmed public health check, and the per-user write limit (server/security.js, server/ratelimit.js).
// AuthStore runs for real on node:sqlite (the limit counts in it); rooms are a fake that echoes and records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../server/worker.js';
import { AuthStore, digest, record } from '../server/auth.js';
import { hit, WRITE_LIMIT } from '../server/ratelimit.js';
import { secure, PAGE_CSP, OVERLAY_CSP, API_CSP, HSTS } from '../server/security.js';
import { forgetChannel } from '../server/channels.js';

const ORIGIN = 'https://chat.miolaf.xyz', SECRET = 'test-only-internal-key', DEV_TOKEN = 'd'.repeat(40);
function sqlCtx() {
  const db = new DatabaseSync(':memory:');
  return { storage: { sql: { exec(q, ...p) { const rows = db.prepare(q).all(...p).map(r => ({ ...r })); return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } }, alarm: null, async getAlarm() { return this.alarm; }, async setAlarm(t) { this.alarm = t; } } };
}
function environment(extra = {}) {
  forgetChannel();
  const ctx = sqlCtx(), auth = new AuthStore(ctx, { INTERNAL_SECRET: SECRET }), rooms = [], hits = [];
  const env = {
    AUTH_SECRET: 'test-only-auth-key', INTERNAL_SECRET: SECRET, OWNER_TWITCH_ID: '1', TWITCH_CLIENT_ID: 'test-app', TWITCH_CLIENT_SECRET: 'test-secret',
    AUTH: { idFromName: x => x, get: () => ({ fetch: (url, init) => { if (new URL(url).pathname === '/hit') hits.push(1); return auth.fetch(new Request(url, init)); } }) },
    ROOMS: { idFromName: x => x, get: channel => ({ async fetch(url, init = {}) { const path = new URL(url).pathname; rooms.push({ channel, path }); return Response.json(path === '/catalog' ? [] : { ok: true, path }); } }) },
    ASSETS: { fetch: async (request) => new Response(new URL(request.url).pathname.startsWith('/assets/characters') ? '[{"id":"player"}]' : '<!doctype html><title>page</title>', { headers: { 'Content-Type': new URL(request.url).pathname.startsWith('/assets/') ? 'application/json' : 'text/html' } }) },
    ...extra
  };
  return { env, auth, ctx, rooms, hits };
}
async function signIn(env, user) {
  const cookie = String(user.id).padStart(64, 'c').slice(-64).replace(/[^a-f0-9]/g, 'c');
  await record(env, 'session:' + await digest(cookie), { user }, Date.now() + 3600000);
  return 'mini_session=' + cookie;
}
const OWNER = { id: '1', login: 'nesszerra', displayName: 'nesszerra' }, VIEWER = { id: '2', login: 'viewer', displayName: 'Viewer' }, OTHER = { id: '3', login: 'other', displayName: 'Other' };
function req(path, method = 'GET', data, cookie, extra = {}) {
  return new Request(ORIGIN + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}), ...extra }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
}
const profile = { avatar: 'player', color: '#123456', defaultAbility: 'strike' };

// ---------- headers ----------
test('script policy: scripts load from this origin only, with no hashes, inline allowance or eval', () => {
  for (const csp of [PAGE_CSP, OVERLAY_CSP]) {
    assert.match(csp, csp === PAGE_CSP ? /(^|; )script-src 'self' https:\/\/static\.cloudflareinsights\.com(;|$)/ : /(^|; )script-src 'self'(;|$)/);   // pages: Cloudflare Web Analytics
    assert.doesNotMatch(csp, /script-src[^;]*('unsafe-inline'|'unsafe-eval'|'wasm-unsafe-eval'|sha256-|nonce-)/);
    assert.match(csp, /(^|; )object-src 'none'/);
    assert.match(csp, /(^|; )base-uri 'self'/);
    assert.match(csp, /img-src 'self' data: blob:/);
  }
  assert.match(PAGE_CSP, /frame-ancestors 'none'/);
  assert.doesNotMatch(OVERLAY_CSP, /frame-ancestors/, 'the overlay stays frameable (the /start demo embeds it, OBS loads it directly)');
  assert.match(OVERLAY_CSP, /connect-src 'self' wss:\/\/irc-ws\.chat\.twitch\.tv/);
  assert.match(API_CSP, /default-src 'none'/);
});

test('no page runs inline script, so script-src needs no hashes', () => {
  for (const file of ['index.html', 'admin/index.html', 'admin/dev/index.html', 'start/index.html', 'intro/index.html', 'public/overlay.html', 'public/404.html']) {
    const html = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc=/.test(attrs)) assert.equal(body.trim(), '', file + ': a script with src has no inline body');
      else assert.match(attrs, /type="application\/ld\+json"/, file + ': inline script that is not data: ' + body.slice(0, 40));
    }
    assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, file + ': inline event handler');
    assert.doesNotMatch(html, /href=["']javascript:/i, file + ': javascript: URL');
  }
});

test('public/_headers repeats the Worker policies for pages assets serve without the Worker', () => {
  const rules = {};
  let at = '';
  for (const line of readFileSync(new URL('../public/_headers', import.meta.url), 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!/^\s/.test(line)) { at = line.trim(); rules[at] = {}; continue; }
    const i = line.indexOf(':'); rules[at][line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  for (const path of ['/', '/admin/*', '/start/*', '/play/*']) assert.equal(rules[path]['content-security-policy'], PAGE_CSP, path);
  assert.equal(rules['/overlay*']['content-security-policy'], OVERLAY_CSP);
  assert.match(rules['/overlay*']['cache-control'], /(^|, )no-transform(,|$)/, 'Cloudflare must not inject its analytics beacon into the overlay');
  assert.equal(rules['/assets/build/*']['cache-control'], 'public, max-age=31536000, immutable', 'hashed bundles are cached for a year');
  assert.equal(rules['/*']['strict-transport-security'], HSTS);
});

test('HSTS goes on every https response, a locked-down CSP on /api and /auth, the page CSP on pages', async () => {
  const f = environment();
  const page = await worker.fetch(req('/'), f.env);
  assert.equal(page.headers.get('Strict-Transport-Security'), 'max-age=31536000; includeSubDomains');
  assert.equal(page.headers.get('Content-Security-Policy'), PAGE_CSP);
  const api = await worker.fetch(req('/api/session'), f.env);
  assert.equal(api.status, 200);
  assert.equal(api.headers.get('Content-Security-Policy'), API_CSP);
  assert.equal(api.headers.get('Strict-Transport-Security'), HSTS);
  const error = await worker.fetch(req('/api/nope'), f.env);
  assert.equal(error.status, 404);
  assert.equal(error.headers.get('Content-Security-Policy'), API_CSP, 'errors too');
  const auth = await worker.fetch(req('/auth/login?channel=nesszerra'), f.env);
  assert.equal(auth.headers.get('Content-Security-Policy'), API_CSP, 'redirects too');
  assert.equal(auth.headers.get('Strict-Transport-Security'), HSTS);
  const robots = await worker.fetch(req('/robots.txt'), f.env);
  assert.equal(robots.headers.get('Strict-Transport-Security'), HSTS);
  // plain http (local dev) gets no HSTS
  const local = await worker.fetch(new Request('http://127.0.0.1:5173/api/session'), f.env);
  assert.equal(local.headers.get('Strict-Transport-Security'), null);
  assert.equal(local.headers.get('Content-Security-Policy'), API_CSP);
});

test('secure() leaves WebSocket upgrades alone and copes with immutable headers', () => {
  const upgrade = { status: 101, webSocket: {}, headers: new Headers() };
  assert.equal(secure(upgrade, new URL(ORIGIN + '/api/live/x'), API_CSP), upgrade);
  const redirect = secure(Response.redirect(ORIGIN + '/', 302), new URL(ORIGIN + '/'), API_CSP);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('Location'), ORIGIN + '/');
  assert.equal(redirect.headers.get('Strict-Transport-Security'), HSTS);
  const own = secure(new Response('x', { headers: { 'Content-Security-Policy': "default-src 'none'" } }), new URL(ORIGIN + '/'), PAGE_CSP);
  assert.equal(own.headers.get('Content-Security-Policy'), "default-src 'none'", 'a policy the handler set is kept');
});

// ---------- health ----------
test('public health check says only whether the server is up', async () => {
  const f = environment();
  const r = await worker.fetch(req('/api/health'), f.env);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const broken = await worker.fetch(req('/api/health'), { ...f.env, AUTH_SECRET: undefined });
  assert.equal(broken.status, 503);
  assert.deepEqual(await broken.json(), { ok: false });
  const noInternal = await worker.fetch(req('/api/health'), { ...f.env, INTERNAL_SECRET: '' });
  assert.deepEqual([noInternal.status, await noInternal.json()], [503, { ok: false }]);
});

// ---------- per-user write limit ----------
test('hit(): the 31st write in a minute is refused; the window slides instead of resetting all at once', async () => {
  const ctx = sqlCtx(), T = 10 * 60000;   // the start of a window
  new AuthStore(ctx, { INTERNAL_SECRET: SECRET });   // creates the entries table
  for (let i = 0; i < WRITE_LIMIT; i++) assert.equal((await hit(ctx, 'a', 30, 60000, T + i)).limited, false, 'write ' + (i + 1));
  const refused = await hit(ctx, 'a', 30, 60000, T + 30);
  assert.equal(refused.limited, true);
  assert.ok(refused.retryAfter >= 1 && refused.retryAfter <= 125, 'retryAfter ' + refused.retryAfter);
  assert.equal((await hit(ctx, 'b', 30, 60000, T + 30)).limited, false, 'another user is not affected');
  assert.equal((await hit(ctx, 'a', 30, 60000, T + 30)).limited, true, 'a refused write is not counted, but the count stays');
  // 30 writes at the end of one window, then the next window opens: not 30 more at once
  const late = 20 * 60000;
  for (let i = 0; i < 30; i++) assert.equal((await hit(ctx, 'c', 30, 60000, late - 1000 + i)).limited, false);
  assert.equal((await hit(ctx, 'c', 30, 60000, late + 1)).limited, true, 'still inside the last minute');
  // waiting what retryAfter says is enough, and it is not an overestimate by a whole window
  const wait = (await hit(ctx, 'c', 30, 60000, late + 1)).retryAfter;
  assert.equal((await hit(ctx, 'c', 30, 60000, late + wait * 1000 + 1)).limited, false, 'allowed after retryAfter');
  assert.ok(wait <= 125);
  // after a full quiet minute everything is open again
  assert.equal((await hit(ctx, 'a', 30, 60000, T + 3 * 60000)).limited, false);
  // counts expire with AuthStore's hourly sweep, and it is scheduled
  assert.ok(ctx.storage.alarm > 0);
  assert.ok(ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM entries WHERE key LIKE 'rl:%'").toArray()[0].n > 0);
});

test('profile saves: the 31st in a minute is 429 with Retry-After; reads are not counted; the limit is per user', async () => {
  const f = environment(), viewer = await signIn(f.env, VIEWER), other = await signIn(f.env, OTHER);
  const save = (cookie) => worker.fetch(req('/api/profile/nesszerra', 'POST', profile, cookie), f.env);
  for (let i = 0; i < 40; i++) assert.equal((await worker.fetch(req('/api/profile/nesszerra', 'GET', undefined, viewer), f.env)).status, 200, 'reads are free');
  assert.equal(f.hits.length, 0, 'reads never touch the counter');
  for (let i = 0; i < 30; i++) assert.equal((await save(viewer)).status, 200, 'save ' + (i + 1));
  const before = f.rooms.length;
  const refused = await save(viewer);
  assert.equal(refused.status, 429);
  const body = await refused.json();
  assert.equal(body.reason, 'rate_limited');
  assert.match(body.error, /Too many/);
  assert.ok(Number.isInteger(body.retryAfter) && body.retryAfter >= 1 && body.retryAfter <= 125);
  assert.equal(refused.headers.get('Retry-After'), String(body.retryAfter));
  assert.equal(refused.headers.get('Content-Security-Policy'), API_CSP);
  assert.equal(f.rooms.length, before, 'a refused write never reaches the room');
  assert.equal((await save(other)).status, 200, 'another user can still save');
  assert.equal((await worker.fetch(req('/api/profile/nesszerra', 'GET', undefined, viewer), f.env)).status, 200, 'the user can still read');
  assert.equal(f.hits.length, 32, 'one AuthStore call per write, none for reads');
});

test('shop buys, uploads and admin changes share the user\'s 30 writes a minute, across channels', async () => {
  const f = environment(), owner = await signIn(f.env, OWNER);
  const calls = [
    () => req('/api/shop/nesszerra', 'POST', { kind: 'pet', id: 'cat' }, owner),
    () => req('/api/assets/nesszerra', 'POST', {}, owner),
    () => req('/api/pets/nesszerra', 'POST', {}, owner),
    () => req('/api/admin/nesszerra', 'POST', { action: 'resetRound' }, owner),
    () => req('/api/profile/miolafff', 'POST', profile, owner)
  ];
  for (let i = 0; i < 30; i++) assert.notEqual((await worker.fetch(calls[i % calls.length](), f.env)).status, 429, 'write ' + (i + 1));
  for (const call of calls) assert.equal((await worker.fetch(call(), f.env)).status, 429, call().url);
  // GETs on the same routes still work
  assert.equal((await worker.fetch(req('/api/admin/nesszerra', 'GET', undefined, owner), f.env)).status, 200);
  assert.equal((await worker.fetch(req('/api/shop/nesszerra'), f.env)).status, 200);
});

test('dev-token requests and signed-out requests are not counted', async () => {
  const f = environment({ DEV_TOKEN_UNUSED: 1, DEV_TOOLS_TOKEN: DEV_TOKEN });
  for (let i = 0; i < 40; i++) {
    const r = await worker.fetch(req('/api/admin/nesszerra', 'POST', { action: 'resetRound' }, undefined, { Authorization: 'Bearer ' + DEV_TOKEN }), f.env);
    assert.equal(r.status, 200, 'dev write ' + (i + 1));
  }
  assert.equal(f.hits.length, 0);
  assert.equal((await worker.fetch(req('/api/profile/nesszerra', 'POST', profile), f.env)).status, 401);
  assert.equal(f.hits.length, 0, 'no session, nothing to count');
});

test('if AuthStore cannot count, the write goes through instead of failing', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const f = environment(), viewer = await signIn(f.env, VIEWER), real = f.env.AUTH;
  f.env.AUTH = { idFromName: real.idFromName, get: () => ({ fetch: (url, init) => { if (new URL(url).pathname === '/hit') throw new Error('down'); return real.get().fetch(url, init); } }) };
  assert.equal((await worker.fetch(req('/api/profile/nesszerra', 'POST', profile, viewer), f.env)).status, 200);
});
