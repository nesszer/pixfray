import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const base = process.env.MINI_BASE_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const errors = [];
const apiReads = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => {
    window.__arenaSockets = [];
    window.__chatSockets = [];
    class FakeWebSocket {
      constructor(url) {
        this.url = String(url);
        this.readyState = 0;
        this.sent = [];
        (this.url.includes('/api/live/') ? window.__arenaSockets : window.__chatSockets).push(this);
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.();
        }, 0);
      }
      send(value) { this.sent.push(value); }
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.onclose?.();
      }
    }
    window.WebSocket = FakeWebSocket;
    window.__sendArena = (index, payload) => {
      const socket = window.__arenaSockets[index];
      socket?.onmessage?.({ data: JSON.stringify(payload) });
    };
    window.__sendIrc = (message) => {
      window.__chatSockets.at(-1)?.onmessage?.({ data: message });
    };
  });

  const initial = {
    channel: 'nesszerra',
    revision: 1,
    relay: { connected: true, lastSeen: new Date().toISOString() },
    config: { maxHp: 100 },
    players: [
      { userId: '101', username: 'aria', displayName: 'Aria Prime', avatar: 'neon', color: '#22cc88', defaultAbility: 'Pulse', hp: 100, elo: 1720, wins: 8, losses: 2 },
      { userId: '202', username: 'bex', displayName: 'Bex Prime', avatar: 'soldier', color: '#cc88ff', defaultAbility: 'Guard', hp: 100, elo: 1690, wins: 7, losses: 3 },
    ],
    duels: [{ id: 'match-1', a: '101', b: '202', hp: { '101': 80, '202': 100 }, status: 'active', config: { maxHp: 100 } }],
    events: [],
  };

  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/state/**', async route => {
    apiReads.push({ path: new URL(route.request().url()).pathname, method: route.request().method() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(initial) });
  });
  await page.route('**/api/catalog/**', async route => {
    apiReads.push({ path: new URL(route.request().url()).pathname, method: route.request().method() });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 'neon', label: 'Neon', url: '/assets/player.png', frames: [{ x: 0, y: 0, w: 80, h: 110 }], fps: 8 },
      ]),
    });
  });

  await page.goto(base + '/overlay.html?arena=1&debug=1&cap=8&size=64');
  await page.waitForFunction(() => window.__arenaSockets.length === 1 && window.__chatSockets.length === 1);
  await page.waitForFunction(() => window.__arenaDebug?.().profiles === 2);
  await page.evaluate(() => window.__sendArena(0, {
    type: 'snapshot',
    channel: 'nesszerra',
    revision: 3,
    relay: { connected: true, lastSeen: new Date().toISOString() },
    config: { maxHp: 100 },
    players: [
      { userId: '101', username: 'aria', displayName: 'Aria Prime', avatar: 'neon', color: '#22cc88', defaultAbility: 'Pulse', hp: 100, elo: 1720, wins: 8, losses: 2 },
      { userId: '202', username: 'bex', displayName: 'Bex Prime', avatar: 'soldier', color: '#cc88ff', defaultAbility: 'Guard', hp: 100, elo: 1690, wins: 7, losses: 3 },
    ],
    duels: [{ id: 'match-1', a: '101', b: '202', hp: { '101': 65, '202': 100 }, status: 'active', config: { maxHp: 100 } }],
    events: [
      { id: 'hit-1', type: 'hit', actorUserId: '202', targetUserId: '101', damage: 15 },
      { id: 'result-1', type: 'match_result', winnerId: '101', loserId: '202' },
    ],
  }));
  await page.waitForFunction(() => window.__arenaDebug?.().revision === 3);

  const ircMessage = '@id=test-1;user-id=101;display-name=Chat Override;color=#ff0000 :aria!aria@aria.tmi.twitch.tv PRIVMSG #nesszerra :!color #ff0000\r\n';
  await page.evaluate(message => window.__sendIrc(message), ircMessage);
  await page.waitForFunction(() => window.__arenaDebug?.().players.some(player => player.userId === '101'));
  let ranked = await page.evaluate(() => window.__arenaDebug());
  let aria = ranked.players.find(player => player.userId === '101');
  assert.equal(aria.label, 'Aria Prime', 'IRC display names do not replace ranked profiles');
  assert.equal(aria.color, '#22cc88', 'IRC color commands do not replace ranked profile color');
  assert.equal(aria.avatar, 'neon', 'arena catalog avatars are resolved from the server catalog');
  assert.equal(aria.elo, 1720);
  assert.equal(ranked.duels[0].hp['101'], 65);
  assert.match(ranked.announcement, /Aria Prime wins/);
  assert.equal(await page.evaluate(() => localStorage.getItem('mini-chat:cosmetics:nesszerra')), null,
    'arena-ranked cosmetics are not persisted locally');

  await page.evaluate(() => window.__sendArena(0, {
    type: 'event',
    revision: 3,
    event: { id: 'result-1', type: 'match_result', winnerId: '202', loserId: '101' },
  }));
  await page.evaluate(() => window.__sendArena(0, {
    type: 'snapshot',
    channel: 'nesszerra',
    revision: 2,
    relay: { connected: true },
    players: [{ userId: '101', displayName: 'Stale Name', avatar: 'player', color: '#000000', elo: 1 }],
    duels: [{ id: 'match-1', a: '101', b: '202', hp: { '101': 1, '202': 1 }, status: 'active', config: { maxHp: 100 } }],
  }));
  ranked = await page.evaluate(() => window.__arenaDebug());
  assert.equal(ranked.revision, 3, 'older snapshots are ignored');
  assert.equal(ranked.players[0].label, 'Aria Prime');
  assert.match(ranked.announcement, /Aria Prime wins/, 'duplicate event IDs are not replayed');

  const canvas = await page.evaluate(() => {
    const canvas = document.querySelector('#stage');
    const ctx = canvas.getContext('2d');
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) painted++;
    return {
      width: canvas.width,
      height: canvas.height,
      painted,
      background: getComputedStyle(document.body).backgroundColor,
    };
  });
  assert.equal(canvas.width, 1280);
  assert.equal(canvas.height, 720);
  assert.equal(canvas.background, 'rgba(0, 0, 0, 0)');
  assert.ok(canvas.painted > 500, 'ranked characters and arena bars render onto a transparent canvas');

  await page.evaluate(() => window.__arenaSockets[0].close());
  await page.waitForFunction(() => window.__arenaSockets.length === 2, { timeout: 6000 });
  await page.evaluate(() => window.__sendArena(1, {
    type: 'snapshot',
    channel: 'nesszerra',
    revision: 4,
    relay: { connected: true, lastSeen: new Date().toISOString() },
    config: { maxHp: 100 },
    players: [
      { userId: '101', username: 'aria', displayName: 'Aria Prime', avatar: 'neon', color: '#22cc88', defaultAbility: 'Pulse', elo: 1720 },
      { userId: '202', username: 'bex', displayName: 'Bex Prime', avatar: 'soldier', color: '#cc88ff', defaultAbility: 'Guard', elo: 1690 },
    ],
    duels: [{ id: 'match-1', a: '101', b: '202', hp: { '101': 41, '202': 100 }, status: 'active', config: { maxHp: 100 } }],
    events: [],
  }));
  await page.waitForFunction(() => window.__arenaDebug?.().revision === 4);
  assert.equal((await page.evaluate(() => window.__arenaDebug())).duels[0].hp['101'], 41);
  assert.ok(apiReads.some(item => item.path === '/api/state/nesszerra' && item.method === 'GET'));
  assert.ok(apiReads.some(item => item.path === '/api/catalog/nesszerra' && item.method === 'GET'));
  assert.deepEqual(errors, []);
  await page.close();

  const demoPage = await context.newPage();
  demoPage.on('pageerror', error => errors.push(error.message));
  const demoApiReads = [];
  await demoPage.route('**/api/**', async route => {
    demoApiReads.push(route.request().method() + ' ' + new URL(route.request().url()).pathname);
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
  });
  await demoPage.goto(base + '/overlay.html?arena=1&demo=1&debug=1');
  await demoPage.waitForFunction(() => document.querySelector('#arena-mode')?.textContent.includes('not saved'));
  await demoPage.waitForFunction(() => window.__arenaDebug?.().duels[0]?.hp['demo-1'] < 100);
  await demoPage.waitForFunction(() => /wins/.test(window.__arenaDebug?.().announcement || ''), { timeout: 12000 });
  assert.equal(await demoPage.evaluate(() => window.__arenaSockets.length + window.__chatSockets.length), 0,
    'arena demo uses no arena or Twitch websocket');
  assert.deepEqual(demoApiReads, [], 'arena demo does not write or read arena APIs');
  assert.equal(await demoPage.evaluate(() => localStorage.getItem('mini-chat:cosmetics:nesszerra')), null);
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS: authoritative profiles, health snapshots, event deduplication, stale revisions, reconnect, transparent drawing, and local-only demo duel.');
} finally {
  await browser.close();
}