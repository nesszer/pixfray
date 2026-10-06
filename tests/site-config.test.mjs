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
    bot: { production: 'pixfray', test: 'nesszers' },
  });
  assert.strictEqual(CHANNELS, site.builtinChannels);
});
