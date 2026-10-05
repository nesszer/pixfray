// Overlay arena client against stubbed sockets: contract-shaped snapshots and events (CONTRACTS.md section 3),
// event dedupe, stale revisions, reconnect, transparent drawing and the local-only demo duel.
// Usage: MINI_BASE_URL=http://127.0.0.1:5199 node tests/arena-browser.mjs
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const base = process.env.MINI_BASE_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] /* WebGL on the GPU, not software, with no window */,
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
    paused: false,
    chat: { connected: true, lastSeen: Date.now(), status: 'enabled' },
    config: { maxHp: 100 },
    players: [
      { userId: '101', username: 'aria', displayName: 'Aria Prime', avatar: 'neon', color: '#22cc88', defaultAbility: 'strike', hp: 100, elo: 1720, wins: 8, losses: 2, registered: true },
      { userId: '202', username: 'bex', displayName: 'Bex Prime', avatar: 'soldier', color: '#cc88ff', defaultAbility: 'heavy', hp: 100, elo: 1690, wins: 7, losses: 3, registered: true },
    ],
    duels: [{ id: 'duel-1', a: '101', b: '202', hp: { '101': 80, '202': 100 }, status: 'active', round: 1, rules: { maxHp: 100 } }],
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
    paused: false,
    build: 'build-1',
    chat: { connected: true, lastSeen: Date.now(), status: 'enabled' },
    config: { maxHp: 100, announce: 'top', maxOnStream: 15 },
    players: [
      { userId: '101', username: 'aria', displayName: 'Aria Prime', avatar: 'neon', color: '#22cc88', defaultAbility: 'strike', hp: 100, elo: 1720, wins: 8, losses: 2, registered: true },
      { userId: '202', username: 'bex', displayName: 'Bex Prime', avatar: 'soldier', color: '#cc88ff', defaultAbility: 'heavy', hp: 100, elo: 1690, wins: 7, losses: 3, registered: true },
    ],
    duels: [{ id: 'duel-1', a: '101', b: '202', hp: { '101': 65, '202': 100 }, status: 'active', round: 1, rules: { maxHp: 100 } }],
    events: [
      { id: 'evt-1', type: 'duel_action', at: Date.now(), duelId: 'duel-1', userId: '202', targetId: '101', ability: 'heavy', amount: 15, hp: { '101': 65, '202': 100 } },
    ],
  }));
  await page.waitForFunction(() => window.__arenaDebug?.().revision === 3);
  const live = await page.evaluate(() => window.__arenaDebug());
  assert.equal(live.announce, 'top', 'the channel setting in the snapshot turns the banner on without a new link');
  assert.equal(live.build, 'build-1');
  assert.equal(live.cap, 15, 'the channel setting for the on-stream limit replaces ?cap= from the link');
  assert.equal(live.staleBuild, false, 'the first build seen is the one this page runs');

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
  assert.equal(await page.evaluate(() => localStorage.getItem('mini-chat:cosmetics:nesszerra')), null,
    'arena-ranked cosmetics are not persisted locally');

  const completed = { id: 'evt-2', type: 'duel_completed', duelId: 'duel-1', winnerId: '101', loserId: '202', flawless: true, ratings: { '101': { before: 1720, after: 1731, delta: 11, bonus: 3 }, '202': { before: 1690, after: 1679, delta: -11 } } };
  await page.evaluate((event) => window.__sendArena(0, { type: 'event', revision: 4, event: { ...event, at: Date.now() } }), completed);
  await page.waitForFunction(() => window.__arenaDebug().banners.includes('Aria Prime wins, FLAWLESS! +11 Elo'));
  // The same event id again (here with a different winner) must not be replayed.
  await page.evaluate((event) => window.__sendArena(0, { type: 'event', revision: 4, event: { ...event, winnerId: '202', loserId: '101', at: Date.now() } }), completed);
  assert.deepEqual((await page.evaluate(() => window.__arenaDebug())).banners, ['Aria Prime wins, FLAWLESS! +11 Elo'], 'duplicate event IDs are not replayed');
  // Events older than 10 s (for example replayed after a reconnect) are not announced.
  await page.evaluate(() => window.__sendArena(0, { type: 'event', revision: 4, event: { id: 'evt-old', type: 'challenge_created', a: '202', b: '101', at: Date.now() - 60000 } }));
  assert.doesNotMatch((await page.evaluate(() => window.__arenaDebug())).announcement, /challenges/, 'stale events are not announced');
  await page.evaluate(() => window.__sendArena(0, {
    type: 'snapshot',
    channel: 'nesszerra',
    revision: 2,
    chat: { connected: true, lastSeen: 0, status: 'enabled' },
    players: [{ userId: '101', displayName: 'Stale Name', avatar: 'player', color: '#000000', elo: 1 }],
    duels: [{ id: 'duel-1', a: '101', b: '202', hp: { '101': 1, '202': 1 }, status: 'active', rules: { maxHp: 100 } }],
  }));
  ranked = await page.evaluate(() => window.__arenaDebug());
  assert.ok(ranked.revision >= 3, 'older snapshots are ignored');
  assert.equal(ranked.players.find((p) => p.userId === '101').label, 'Aria Prime');
  assert.notEqual(ranked.duels[0]?.hp?.['101'], 1, 'stale snapshot health is not applied');

  // Sprites load and frames render asynchronously: wait for paint instead of sampling once.
  await page.waitForFunction(() => {
    const c = document.querySelector('#stage'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0 && ++painted > 500) return true;
    return false;
  }, null, { timeout: 6000 }).catch(() => {});
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
  await page.waitForFunction(() => window.__arenaSockets.length === 2, null, { timeout: 6000 });
  await page.evaluate(() => window.__sendArena(1, {
    type: 'snapshot',
    channel: 'nesszerra',
    revision: 9,
    paused: false,
    chat: { connected: true, lastSeen: Date.now(), status: 'enabled' },
    config: { maxHp: 100 },
    players: [
      { userId: '101', username: 'aria', displayName: 'Aria Prime', avatar: 'neon', color: '#22cc88', defaultAbility: 'strike', elo: 1731, registered: true },
      { userId: '202', username: 'bex', displayName: 'Bex Prime', avatar: 'soldier', color: '#cc88ff', defaultAbility: 'heavy', elo: 1679, registered: true },
    ],
    duels: [{ id: 'duel-2', a: '101', b: '202', hp: { '101': 41, '202': 100 }, status: 'active', round: 2, rules: { maxHp: 100 } }],
    events: [],
  }));
  await page.waitForFunction(() => window.__arenaDebug?.().revision === 9);
  assert.equal((await page.evaluate(() => window.__arenaDebug())).duels.find((x) => x.id === 'duel-2').hp['101'], 41);
  assert.ok(apiReads.some(item => item.path === '/api/state/nesszerra' && item.method === 'GET'));
  assert.ok(apiReads.some(item => item.path === '/api/catalog/nesszerra' && item.method === 'GET'));
  assert.deepEqual(errors, []);
  await page.close();

  // A quick duel is finished on the server before the overlay hears of it: the overlay replays it with HP bars
  // and knocks the loser out only after the finisher.
  const quick = await context.newPage();
  quick.on('pageerror', error => errors.push(error.message));
  await quick.route('**/api/state/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...initial, duels: [] }) }));
  await quick.route('**/api/catalog/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await quick.goto(base + '/overlay.html?arena=1&debug=1&cap=8&size=64');
  await quick.waitForFunction(() => window.__arenaSockets.length === 1 && window.__arenaDebug?.().profiles === 2);
  await quick.waitForFunction(() => window.__arenaDebug().players.length === 2);
  await quick.evaluate(() => { window.__arenaMove('101', 1200); window.__arenaMove('202', 60); });   // opposite edges, as in OBS
  await quick.evaluate(() => {
    const now = Date.now(), full = { '101': 100, '202': 100 };
    window.__sendArena(0, {
      type: 'snapshot', channel: 'nesszerra', revision: 5, paused: false,
      chat: { connected: true, lastSeen: now, status: 'enabled' }, config: { maxHp: 100 },
      players: [
        { userId: '101', username: 'aria', displayName: 'Aria Prime', avatar: 'neon', color: '#22cc88', hp: 0, respawnAt: now + 3000, elo: 1708, wins: 8, losses: 3, registered: true },
        { userId: '202', username: 'bex', displayName: 'Bex Prime', avatar: 'soldier', color: '#cc88ff', hp: 100, respawnAt: 0, elo: 1702, wins: 8, losses: 3, registered: true },
      ],
      duels: [{ id: 'duel-9', a: '101', b: '202', hp: { '101': 0, '202': 100 }, status: 'completed', winnerId: '202', round: 1, rules: { maxHp: 100 }, ratings: { '101': { before: 1720, after: 1708, delta: -12 }, '202': { before: 1690, after: 1702, delta: 12 } } }],
      events: [
        { id: 'q1', type: 'duel_started', at: now, duelId: 'duel-9', a: '101', b: '202', round: 1, hp: full },
        { id: 'q2', type: 'duel_action', at: now, duelId: 'duel-9', userId: '101', targetId: '202', ability: 'strike', amount: 0, hp: full, miss: true, die: 3 },
        { id: 'q3', type: 'duel_action', at: now, duelId: 'duel-9', userId: '202', targetId: '101', ability: 'heavy', amount: 50, hp: { '101': 50, '202': 100 }, crit: true, die: 6 },
        { id: 'q3b', type: 'duel_action', at: now, duelId: 'duel-9', userId: '202', targetId: '101', ability: 'heavy', amount: 34, hp: { '101': 16, '202': 100 }, counter: true, die: 2 },
        { id: 'q3c', type: 'duel_action', at: now, duelId: 'duel-9', userId: '202', targetId: '101', ability: 'heavy', amount: 16, hp: { '101': 0, '202': 100 }, finisher: true, die: 5 },
        { id: 'q4', type: 'duel_completed', at: now, duelId: 'duel-9', winnerId: '202', loserId: '101', round: 1, respawnAt: now + 3000, ratings: { '202': { delta: 12 }, '101': { delta: -12 } } },
      ],
    });
  });
  let q = await quick.evaluate(() => window.__arenaDebug());
  assert.equal(q.replays[0]?.hp['101'], 100, 'replay starts at full health');
  assert.equal(q.players.find(p => p.userId === '101').ko, false, 'loser stands until the finisher');
  assert.equal(q.players.find(p => p.userId === '101').shownElo, 1720, 'nameplate keeps the pre-duel Elo during the replay');
  // Each roll shows its die above the fighter who rolled: aria's miss (3), then bex's crit (6).
  await quick.waitForFunction(() => window.__arenaDebug().players.find(p => p.userId === '101').die === 3, null, { timeout: 5000 });
  await quick.waitForFunction(() => window.__arenaDebug().players.find(p => p.userId === '202').float === 'MISS', null, { timeout: 2000 });
  q = await quick.evaluate(() => window.__arenaDebug());
  assert.ok(q.players.filter(p => p.userId === '101' || p.userId === '202').every(p => p.grow > 1.3), 'fighters grow during the duel');
  await quick.waitForFunction(() => window.__arenaDebug().players.find(p => p.userId === '202').die === 6, null, { timeout: 3000 });
  await quick.waitForFunction(() => window.__arenaDebug().players.find(p => p.userId === '101').float === 'CRIT! -50', null, { timeout: 2000 });
  await quick.screenshot({ path: 'screenshots/overlay-quick-duel-1280.png' });
  // A counter: aria rolls 2, so the die is hers and bex answers.
  await quick.waitForFunction(() => window.__arenaDebug().players.find(p => p.userId === '101').die === 2, null, { timeout: 3000 });
  await quick.waitForFunction(() => window.__arenaDebug().players.find(p => p.userId === '202').float === 'COUNTER', null, { timeout: 2000 });
  await quick.waitForFunction(() => window.__arenaDebug().replays[0]?.hp['101'] === 0, null, { timeout: 5000 });
  const xs = (await quick.evaluate(() => window.__arenaDebug())).players.filter(p => p.userId === '101' || p.userId === '202').map(p => p.x);
  assert.ok(Math.abs(xs[0] - xs[1]) < 230, 'fighters have met before the deciding roll (' + xs.join(' vs ') + ')');
  // The finishing blow knocks aria down before the result arrives.
  await quick.waitForFunction(() => window.__arenaDebug().players.find(p => p.userId === '101').ko, null, { timeout: 2000 });
  await quick.waitForFunction(() => window.__arenaDebug().replays.length === 0, null, { timeout: 3000 });
  q = await quick.evaluate(() => window.__arenaDebug());
  assert.deepEqual(q.banners, ['Bex Prime wins! +12 Elo'], 'winner banner');
  assert.equal(q.players.find(p => p.userId === '202').float, '+12 Elo', 'Elo change floats above the winner');
  assert.equal(q.players.find(p => p.userId === '101').float, '−12 Elo', 'Elo change floats above the loser');
  await quick.screenshot({ path: 'screenshots/overlay-quick-ko-1280.png' });
  await quick.waitForTimeout(1500);
  assert.equal((await quick.evaluate(() => window.__arenaDebug())).players.find(p => p.userId === '101').ko, true, 'KO is held after the replay');
  assert.equal((await quick.evaluate(() => window.__arenaDebug())).players.find(p => p.userId === '101').shownElo, 1708, 'new Elo after the knockout');
  await quick.close();

  // Two duels at once: each keeps its own line in the top banner, and a bystander standing on the meeting
  // point walks clear of the fighters so nameplates don't run together.
  const crowd = await context.newPage();
  crowd.on('pageerror', error => errors.push(error.message));
  const cast = [...initial.players,
    { userId: '303', username: 'cy', displayName: 'Cy', avatar: 'player', color: '#ffaa22', elo: 1000, registered: true },
    { userId: '404', username: 'dot', displayName: 'Dot', avatar: 'player', color: '#22aaff', elo: 1000, registered: true }];
  await crowd.route('**/api/state/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...initial, players: cast, duels: [] }) }));
  await crowd.route('**/api/catalog/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await crowd.goto(base + '/overlay.html?arena=1&debug=1&cap=8&size=64');
  await crowd.waitForFunction(() => window.__arenaSockets.length === 1 && window.__arenaDebug?.().players.length === 4);
  await crowd.evaluate(() => { window.__arenaMove('101', 500); window.__arenaMove('202', 700); window.__arenaMove('303', 600); window.__arenaMove('404', 1100); });
  await crowd.evaluate(() => {
    const now = Date.now();
    window.__sendArena(0, { type: 'event', revision: 20, event: { id: 'c1', type: 'challenge_created', at: now, duelId: 'duel-21', a: '101', b: '202' } });
    window.__sendArena(0, { type: 'event', revision: 21, event: { id: 'c2', type: 'challenge_created', at: now, duelId: 'duel-22', a: '404', b: '303' } });
  });
  const two = (await crowd.evaluate(() => window.__arenaDebug())).announcement;
  assert.match(two, /Aria Prime challenges Bex Prime/, 'first duel keeps its line');
  assert.match(two, /Dot challenges Cy/, 'second duel gets its own line');
  await crowd.evaluate(() => window.__sendArena(0, { type: 'event', revision: 22, event: { id: 's1', type: 'duel_started', at: Date.now(), duelId: 'duel-21', a: '101', b: '202', round: 4, hp: { '101': 100, '202': 100 } } }));
  await crowd.waitForFunction(() => /Round 4: Aria Prime vs Bex Prime/.test(window.__arenaDebug().announcement));
  assert.doesNotMatch((await crowd.evaluate(() => window.__arenaDebug())).announcement, /Aria Prime challenges/, 'the round line replaces that duel\'s challenge line');
  await crowd.evaluate(() => window.__arenaMove('303', 600));   // put the bystander back on the meeting point
  await crowd.waitForTimeout(3000);
  const c = await crowd.evaluate(() => window.__arenaDebug());
  const cy = c.players.find(p => p.userId === '303').x, meet = c.meets[0];
  // fighters stand 95 px either side of the meeting point; nameplates are 20px bold text, so 'Aria Prime · 1720'
  // and 'Cy · 1000' need well over 64 px between their centers
  assert.ok(Math.abs(cy - meet) > 95 + 120, `bystander walked clear of the duel and its nameplates (cy ${cy}, meet ${meet})`);
  await crowd.screenshot({ path: 'screenshots/overlay-two-duels-1280.png' });
  await crowd.close();

  // A chat-only viewer with a saved fighter (a StreamElements channel hears of them only through commands) gets the
  // saved look from /api/looks instead of a random one; lookups are batched and cached, misses included. A failed lookup
  // (the edge rate limit's 429) is retried, not cached as "no saved fighter".
  const looksPage = await context.newPage();
  looksPage.on('pageerror', error => errors.push(error.message));
  const lookReads = [];
  await looksPage.route('**/api/state/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...initial, players: [], duels: [] }) }));
  await looksPage.route('**/api/catalog/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'neon', label: 'Neon', url: '/assets/player.png', frames: [{ x: 0, y: 0, w: 80, h: 110 }], fps: 8 }]) }));
  await looksPage.route('**/api/looks/**', route => {
    lookReads.push(new URL(route.request().url()).searchParams.get('u'));
    if (lookReads.length === 1) return route.fulfill({ status: 429, contentType: 'text/plain', body: 'rate limited' });
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ cleo: { avatar: 'neon', color: '#11aa55', hat: '', displayName: 'Cleo Saved', elo: 1033 } }) });
  });
  await looksPage.goto(base + '/overlay.html?arena=1&debug=1&cap=8&size=64');
  await looksPage.waitForFunction(() => window.__arenaSockets.length === 1 && window.__chatSockets.length === 1);
  const irc = (login, id, text) => `@id=${login}-${text.length};user-id=${id};display-name=${login};color=#ff0000 :${login}!${login}@${login}.tmi.twitch.tv PRIVMSG #nesszerra :${text}
`;
  await looksPage.evaluate(lines => lines.forEach(line => window.__sendIrc(line)), [irc('cleo', '701', 'hi'), irc('dan', '702', 'hello')]);
  await looksPage.waitForFunction(() => window.__arenaDebug().players.some(p => p.label === 'Cleo Saved'), null, { timeout: 20_000 });
  let looks = await looksPage.evaluate(() => window.__arenaDebug().players);
  const cleo = looks.find(p => p.userId === '701'), dan = looks.find(p => p.userId === '702');
  assert.deepEqual([cleo.avatar, cleo.color, cleo.elo], ['neon', '#11aa55', 1033], 'the saved look replaces the random pick');
  assert.deepEqual([dan.label, dan.elo], ['dan', undefined], 'a viewer with no saved fighter keeps the chat look');
  await looksPage.evaluate(lines => lines.forEach(line => window.__sendIrc(line)), [irc('cleo', '701', 'again'), irc('dan', '702', 'again!')]);
  await looksPage.waitForTimeout(2500);
  assert.deepEqual(lookReads, ['cleo,dan', 'cleo,dan'], 'a 429 is retried once as a batch; then hits and misses are cached');
  await looksPage.close();

  const demoPage = await context.newPage();
  demoPage.on('pageerror', error => errors.push(error.message));
  const demoApiReads = [];
  await demoPage.route('**/api/**', async route => {
    demoApiReads.push(route.request().method() + ' ' + new URL(route.request().url()).pathname);
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
  });
  await demoPage.goto(base + '/overlay.html?arena=1&demo=1&debug=1');
  await demoPage.waitForFunction(() => document.querySelector('#arena-mode')?.textContent.includes('not saved'));
  await demoPage.waitForFunction(() => window.__arenaDebug?.().duels.some((duel) => Object.values(duel.hp || {}).some((hp) => hp < 100)));
  // The demo plays quick duels like the channel: dice above the fighters, then the result once the replay ends.
  await demoPage.waitForFunction(() => window.__arenaDebug?.().players.some(p => p.die >= 1 && p.die <= 6), null, { timeout: 10000 });
  const demoDuel = await demoPage.evaluate(() => window.__arenaDebug().duels[0]);
  assert.equal(demoDuel.status, 'completed', 'a demo duel arrives settled, like a real !fight');
  assert.ok(Object.values(demoDuel.ratings).every(r => r.after - r.before === r.delta), 'demo ratings carry before, after and delta');
  await demoPage.waitForFunction(() => window.__arenaDebug?.().banners.some(b => /wins/.test(b)), null, { timeout: 45000 });
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