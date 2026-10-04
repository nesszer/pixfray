import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/worker.js';
import { hostChannel, siteOrigin, authOrigin, channelPageRedirect } from '../server/hosts.js';

const MAIN = 'https://pixfray.xyz', MIOLAF = 'https://chat.miolaf.xyz';
function environment() {
  const entries = new Map();
  return {
    AUTH_SECRET: 'test-only-auth-key', INTERNAL_SECRET: 'test-only-internal-key',
    TWITCH_CLIENT_ID: 'test-app', TWITCH_CLIENT_SECRET: 'test-secret',
    PUBLIC_ORIGIN: MAIN, CHANNEL_ORIGINS: JSON.stringify({ miolafff: MIOLAF }),
    AUTH: { idFromName: (x) => x, get: () => ({ async fetch(url, options) {
      const key = new URL(url).searchParams.get('key');
      if (options.method === 'GET') return Response.json(entries.get(key) ?? null);
      entries.set(key, JSON.parse(options.body).value); return Response.json({ ok: true });
    } }) },
    ROOMS: { idFromName: (x) => x, get: () => ({ fetch: async () => Response.json({}) }) },
    ASSETS: { fetch: async (request) => new Response('asset ' + new URL(request.url).pathname) }
  };
}
const get = (url, env = environment()) => worker.fetch(new Request(url), env);
const moved = async (url) => { const r = await get(url); return r.status === 302 ? r.headers.get('Location') : 'served ' + r.status; };

test('a channel domain belongs to its channel; links for a channel use its domain', () => {
  const env = environment();
  assert.equal(hostChannel(env, new URL(MIOLAF + '/x')), 'miolafff');
  assert.equal(hostChannel(env, new URL(MAIN + '/x')), '');
  assert.equal(siteOrigin(env, new URL(MAIN), 'miolafff'), MIOLAF);
  assert.equal(siteOrigin(env, new URL(MIOLAF), 'nesszerra'), MAIN);
  assert.equal(authOrigin(env, new URL(MIOLAF + '/auth/login')), MIOLAF, 'sign-in stays on the domain it started on');
  assert.equal(authOrigin(env, new URL('https://evil.example/auth/login')), MAIN, 'an unknown host signs in on the main site');
  assert.equal(siteOrigin({ CHANNEL_ORIGINS: 'not json', PUBLIC_ORIGIN: MAIN }, new URL(MAIN), 'miolafff'), MAIN, 'bad config falls back');
  assert.equal(channelPageRedirect({}, new URL(MIOLAF + '/')), null, 'no channel domains configured: nothing moves');
});

test("chat.miolaf.xyz opens miolafff's pages and sends every other page to pixfray.xyz", async () => {
  assert.equal(await moved(MIOLAF + '/'), MIOLAF + '/?channel=miolafff');
  assert.equal(await moved(MIOLAF + '/?signed_in=1'), MIOLAF + '/?signed_in=1&channel=miolafff');
  assert.equal(await moved(MIOLAF + '/admin/'), MIOLAF + '/admin/?channel=miolafff');
  assert.equal(await moved(MIOLAF + '/?channel=miolafff'), 'served 200');
  assert.equal(await moved(MIOLAF + '/?channel=MioLafff'), 'served 200');
  assert.equal(await moved(MIOLAF + '/admin/?channel=miolafff#chat'), 'served 200');
  assert.equal(await moved(MIOLAF + '/?channel=nesszerra'), MAIN + '/?channel=nesszerra');
  assert.equal(await moved(MIOLAF + '/admin/?channel=nesszerra'), MAIN + '/admin/?channel=nesszerra');
  assert.equal(await moved(MIOLAF + '/start/?invite=abc'), MAIN + '/start/?invite=abc');
  assert.equal(await moved(MIOLAF + '/admin/dev/'), MAIN + '/admin/dev/');
  // Older OBS overlay links and assets keep working for every channel.
  assert.equal(await moved(MIOLAF + '/overlay.html?channel=nesszerra&size=64'), 'served 200');
  assert.equal(await moved(MIOLAF + '/assets/characters.json'), 'served 200');
  // The main site moves nothing.
  assert.equal(await moved(MAIN + '/'), 'served 200');
  assert.equal(await moved(MAIN + '/?channel=miolafff'), 'served 200');
});

test('pages keep their no-framing headers when they pass through the Worker', async () => {
  for (const url of [MAIN + '/', MIOLAF + '/admin/?channel=miolafff', MAIN + '/start/']) {
    const r = await get(url);
    assert.equal(r.headers.get('X-Frame-Options'), 'DENY', url);
    assert.equal(r.headers.get('Content-Security-Policy'), "frame-ancestors 'none'", url);
    assert.equal(r.headers.get('X-Robots-Tag'), null, url);
  }
  assert.equal((await get('https://test.pixfray.xyz/')).headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.equal((await get(MAIN + '/overlay.html')).headers.get('X-Frame-Options'), null, 'OBS can still frame the overlay');
});

test('sign-in returns to the domain it started on', async () => {
  for (const origin of [MAIN, MIOLAF]) {
    const r = await get(origin + '/auth/login?channel=miolafff');
    assert.equal(r.status, 302);
    assert.equal(new URL(r.headers.get('Location')).searchParams.get('redirect_uri'), origin + '/auth/callback');
  }
});
