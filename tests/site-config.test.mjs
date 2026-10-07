import assert from 'node:assert/strict';
import test from 'node:test';
import site from '../site.config.js';
import { CHANNELS } from '../server/auth.js';

test('site config keeps the deployment defaults and built-in channel identity', () => {
  assert.deepEqual(site, {
    owner: { login: 'nesszerra', twitchId: '445610108' },
    builtinChannels: ['nesszerra', 'miolafff'],
    defaultChannel: 'nesszerra',
    workers: { production: 'nesszerra-mini-chat', test: 'nesszerra-mini-chat-test' },
    origins: { production: 'https://pixfray.xyz', test: 'https://staging.pixfray.xyz' },
    channelDomains: { production: {}, test: {} },
    bot: { production: 'pixfray', test: 'pixfray' },
  });
  assert.strictEqual(CHANNELS, site.builtinChannels);
});

// A copy of PixFray changes only site.config.js: pages and browser scripts name the site through %SITE_*% tokens
// (vite.config.js) or read it at run time, never the original owner, channels or domains.
test('pages and browser scripts carry no hard-coded owner, channel or domain', async () => {
  const { readFileSync } = await import('node:fs');
  const files = ['index.html', 'admin/index.html', 'admin/dev/index.html', 'start/index.html', 'intro/index.html', 'public/overlay.html',
    'public/overlay.js', 'public/upload.js', 'public/dev.js', 'src/ui.js', 'src/admin.js', 'src/dashboard.js', 'src/setup.js', 'src/start.js', 'src/intro/main.js'];
  const words = [site.owner.login, site.owner.twitchId, ...site.builtinChannels, ...Object.values(site.origins).map((o) => new URL(o).host)];
  for (const file of files) {
    const text = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    for (const word of words) assert.ok(!text.includes(word), `${file} names ${word}`);
  }
});
