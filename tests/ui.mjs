// Lane B UI test: viewer dashboard ("/") and mod controls ("/admin/") at 1280px and 390px.
// Signed-out runs against the real local server (`npx cf dev` / vite); signed-in states stub /api/* with page.route.
// Usage: MINI_BASE_URL=http://127.0.0.1:5193 node tests/ui.mjs
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const base = process.env.MINI_BASE_URL || 'http://127.0.0.1:5173';
const shots = 'D:/code/2026-10-01/i-ne/outputs/mini-chat/screenshots';
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const errors = [];
const sizes = [{ name: '1280', width: 1280, height: 900 }, { name: '390', width: 390, height: 844 }];
const now = Date.now();
const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
const user = { id: '1001', login: 'viewer_one', displayName: 'Viewer_One' };
const mod = { id: '2002', login: 'mod_two', displayName: 'Mod_Two' };
const config = { enabled: true, maxHp: 100, maxDuels: 5, challengeTimeoutMs: 30000, inactivityMs: 45000, respawnMs: 3000, rematchDelayMs: 30000, sharedCooldownMs: 1000, initialElo: 1000, eloK: 24,
  abilities: { strike: { damage: 20, cooldownMs: 2000 }, heavy: { damage: 35, cooldownMs: 5000 }, heal: { amount: 15, cooldownMs: 12000 } } };
const board = [
  { userId: '3003', username: 'top_dog', displayName: 'top_dog', avatar: 'soldier', color: '#34d399', defaultAbility: 'heavy', elo: 1048, wins: 4, losses: 1 },
  { userId: '1001', username: 'viewer_one', displayName: 'Viewer_One', avatar: 'zombie', color: '#f472b6', defaultAbility: 'heal', elo: 1012, wins: 2, losses: 1 },
  { userId: '4004', username: 'newbie', displayName: 'newbie', avatar: 'female', color: '#60a5fa', defaultAbility: 'strike', elo: 976, wins: 0, losses: 2 },
];
async function noOverflow(page, label) {
  const { sw, cw, wide } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    wide: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !e.parentElement.closest('.table-wrap'))
      .slice(0, 5).map((e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className ? '.' + String(e.className).replace(/ /g, '.') : '')) }));
  assert.ok(sw <= cw + 1, label + ': horizontal overflow ' + sw + ' > ' + cw + ' from ' + wide.join(', '));
}
async function newPage(viewport) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => {   // no real live socket in stubbed runs
    window.__sockets = [];
    window.WebSocket = class { constructor(u) { this.url = u; window.__sockets.push(this); } send() {} close() {} };
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return { context, page };
}
try {
  // 1. Signed out, real server (no Twitch credentials locally).
  for (const s of sizes) {
    const { context, page } = await newPage(s);
    await page.goto(base + '/');
    assert.match(await page.title(), /Mini Chat/);
    await page.waitForSelector('#characters input[name=character]');
    const count = await page.locator('#characters input[name=character]').count();
    assert.ok(count >= 5, 'expected at least 5 characters, got ' + count);
    assert.equal(await page.locator('#save').isHidden(), true);
    await page.waitForFunction(() => !document.querySelector('#leaderboard tbody').textContent.includes('Loading'));
    await page.waitForFunction(() => { const c = document.querySelector('#preview'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; });
    const session = await page.evaluate(() => fetch('/api/session').then((r) => r.json()));
    if (session.configured === false) assert.match(await page.locator('#signin-note').textContent(), /isn't set up/);
    else assert.equal(await page.locator('#save-signin').isVisible(), true);
    assert.equal(await page.locator('#who a[href="/auth/login"]').count(), 0, 'one sign-in button: the fighter card has it');
    assert.equal(await page.locator('#obs-setup').count(), 0, 'the OBS link lives in mod controls, not on the viewer page');
    if (await page.locator('#leaderboard tr.empty').count()) assert.match(await page.locator('#leaderboard tr.empty').textContent(), /To get on the board: sign in and save your fighter.*!challenge @viewer/);
    await page.locator('#char-soldier').check({ force: true });
    assert.match(await page.locator('#preview-caption').textContent(), /Soldier/);
    await noOverflow(page, 'viewer signed-out ' + s.name);
    await page.screenshot({ path: shots + '/viewer-signed-out-real-' + s.name + '.png', fullPage: true });
    await page.goto(base + '/admin/');
    await page.waitForFunction(() => !document.querySelector('#gate-text').textContent.includes('Checking'));
    assert.equal(await page.locator('#app').isHidden(), true);
    assert.match(await page.locator('#gate-text').textContent(), /Sign in|isn't set up/);
    await noOverflow(page, 'admin signed-out ' + s.name);
    await page.screenshot({ path: shots + '/admin-signed-out-real-' + s.name + '.png', fullPage: true });
    await context.close();
  }

  // 2. Signed out with Twitch configured (stubbed session): sign-in buttons show.
  {
    const { context, page } = await newPage(sizes[0]);
    await page.route('**/api/session', (r) => json(r, { user: null, owner: false, configured: true, channels: ['nesszerra'], productionEnabled: false }));
    await page.goto(base + '/');
    await page.waitForSelector('#save-signin:visible');
    assert.equal(await page.locator('#who a[href="/auth/login"]').count(), 0, 'no second sign-in button in the top bar');
    await page.screenshot({ path: shots + '/viewer-signed-out-configured-1280.png', fullPage: false });
    await context.close();
  }

  // 3. Signed-in viewer (stubbed session/profile/leaderboard; catalog and state are real).
  for (const s of sizes) {
    const { context, page } = await newPage(s);
    let posted = null;
    await page.route('**/api/session', (r) => json(r, { user, owner: false, configured: true, channels: ['nesszerra'], productionEnabled: false }));
    await page.route('**/api/access/nesszerra', (r) => json(r, { owner: false, moderator: false, canManage: false }));
    await page.route('**/api/leaderboard/nesszerra', (r) => json(r, board));
    await page.route('**/api/profile/nesszerra', async (r) => {
      if (r.request().method() === 'POST') { posted = r.request().postDataJSON(); return json(r, { profile: { ...board[1], ...posted }, revision: 9 }); }
      return json(r, { ...board[1], hp: 100, registered: true, respawnAt: 0, lastSeen: now });
    });
    await page.goto(base + '/');
    await page.waitForSelector('#save:not([hidden])');
    assert.equal(await page.locator('#char-zombie').isChecked(), true);
    assert.equal(await page.locator('#color').inputValue(), '#f472b6');
    assert.equal(await page.locator('#swatches > :last-child').getAttribute('class'), 'custom-color', 'Custom comes after the preset colors');
    assert.equal(await page.locator('input[name=ability]').count(), 0, 'no ability picker with quick duels');
    assert.equal(await page.locator('#admin-link').isHidden(), true);
    assert.match(await page.locator('#stat-elo').textContent(), /1012/);
    await page.waitForSelector('#leaderboard tr.me');
    await page.locator('label[for=char-adventurer]').click();
    await page.locator('.swatch[data-color="#34d399"]').click();
    // Hats and upgrades: 2 wins = 2 points; the crown needs 20 wins.
    assert.equal(await page.locator('#hat-crown').isDisabled(), true);
    await page.locator('label[for=hat-cap]').click();
    assert.match(await page.locator('#points-note').textContent(), /2 of 2 points/);
    await page.getByRole('button', { name: 'Put a point into Power' }).click();
    await page.getByRole('button', { name: 'Put a point into Luck' }).click();
    assert.equal(await page.getByRole('button', { name: 'Put a point into Guard' }).isDisabled(), true, 'no points left');
    assert.match(await page.locator('#save-status').textContent(), /unsaved/i);
    if (s.name === '1280') await page.screenshot({ path: shots + '/viewer-signed-in-editing-1280.png', fullPage: true });
    await page.locator('#save').click();
    await page.waitForFunction(() => document.querySelector('#save-status').textContent.startsWith('Saved'));
    assert.deepEqual(posted, { avatar: 'adventurer', color: '#34d399', defaultAbility: 'heal', stats: { power: 1, guard: 0, luck: 1 }, hat: 'cap' });   // the saved ability is kept as is
    await noOverflow(page, 'viewer signed-in ' + s.name);
    if (s.name !== '1280') {
      // phones: explanation tables wrap instead of scrolling sideways, and the fighter bar stays at the bottom while picking
      for (const w of await page.locator('.table-wrap:has(.prose-table)').all()) assert.ok(await w.evaluate((n) => n.scrollWidth <= n.clientWidth + 1), 'duel table fits at ' + s.name);
      const lb = page.locator('#leaderboard');
      assert.equal(await lb.locator('th.col-char').isVisible(), false, 'no Character column on phones');
      assert.ok(await lb.evaluate((t) => t.parentElement.scrollWidth <= t.parentElement.clientWidth + 1), 'leaderboard fits without sideways scrolling at ' + s.name);
      await page.locator('#swatches').scrollIntoViewIfNeeded();
      const bar = await page.locator('.hero-card').boundingBox(), vh = page.viewportSize().height;
      assert.ok(bar.y + bar.height <= vh + 1 && bar.y > vh / 2, 'fighter bar sits at the bottom of the screen at ' + s.name);
      await page.screenshot({ path: shots + '/viewer-signed-in-picking-' + s.name + '.png' });
    }
    await page.screenshot({ path: shots + '/viewer-signed-in-' + s.name + '.png', fullPage: true });
    await context.close();
  }

  // 3b. First run: back from Twitch sign-in with no fighter, save one, then the next step until the first duel.
  for (const s of sizes) {
    const { context, page } = await newPage(s);
    let saved = null;
    await page.route('**/api/session', (r) => json(r, { user, owner: false, configured: true, channels: ['nesszerra'], productionEnabled: false }));
    await page.route('**/api/access/nesszerra', (r) => json(r, { owner: false, moderator: false, canManage: false }));
    await page.route('**/api/leaderboard/nesszerra', (r) => json(r, board.filter((p) => p.userId !== user.id)));
    await page.route('**/api/profile/nesszerra', async (r) => {
      if (r.request().method() === 'POST') { saved = { ...user, username: user.login, ...r.request().postDataJSON(), elo: 1000, wins: 0, losses: 0 }; return json(r, { profile: saved, revision: 3 }); }
      return json(r, saved);
    });
    await page.goto(base + '/?signed_in=1');
    await page.waitForFunction(() => document.querySelector('#save-status').textContent.startsWith('Signed in'));
    assert.equal(await page.locator('#save-status').textContent(), 'Signed in as Viewer_One. Pick a fighter and save.');
    assert.equal(new URL(page.url()).search, '', 'the signed_in flag is gone from the address');
    assert.equal(await page.locator('#next-step').isHidden(), true);
    await page.locator('label[for=char-adventurer]').click();
    await page.locator('#save').click();
    await page.waitForSelector('#next-step:not([hidden])');
    assert.equal(await page.locator('#next-step').textContent(), "Saved. Next: in nesszerra's chat, type !challenge @friend. They answer !fight.");
    assert.equal(await page.locator('#save-status').textContent(), '', 'the next step replaces the plain saved line');
    if (s.name !== '1280') {
      const bar = await page.locator('.hero-card').boundingBox(), vh = page.viewportSize().height;
      assert.ok(bar.y + bar.height <= vh + 1 && bar.height < vh / 2, 'fighter bar with the next step still fits at ' + s.name);
    }
    await noOverflow(page, 'viewer first run ' + s.name);
    await page.screenshot({ path: shots + '/viewer-first-run-' + s.name + '.png' });
    await context.close();
  }

  // 4. Signed in but not a moderator -> admin gate.
  {
    const { context, page } = await newPage(sizes[1]);
    await page.route('**/api/session', (r) => json(r, { user, owner: false, configured: true, channels: ['nesszerra'], productionEnabled: false }));
    await page.route('**/api/access/nesszerra', (r) => json(r, { owner: false, moderator: false, canManage: false, reason: 'Moderator role required' }));
    await page.goto(base + '/admin/');
    await page.waitForFunction(() => document.querySelector('#gate-text').textContent.includes('Only nesszerra'));
    assert.equal(await page.locator('#app').isHidden(), true);
    await page.screenshot({ path: shots + '/admin-not-mod-390.png', fullPage: true });
    await context.close();
  }

  // 5. Moderator admin (fully stubbed). Covers toggle, cancel, resets, config save, 409 conflict and revert.
  for (const s of sizes) for (const role of ['mod', 'owner']) {
    if (role === 'owner' && s.name === '390') continue;
    const { context, page } = await newPage(s);
    page.on('dialog', (d) => d.accept());
    const posts = [];
    let version = 3, conflictNext = false, reconnectNext = true, quickOff = false;   // quickOff: the HP-fight abilities only matter when config.quickDuel is false
    let chatStatus = { connected: true, status: 'enabled', subscriptionId: 'sub-1', createdAt: now - 86400000, lastNotificationAt: now - 4000, lastRevocationReason: '', checkedAt: now - 600000 };
    const history = () => [
      { version: 3, config: { ...config, abilities: { ...config.abilities, heavy: { damage: 35, cooldownMs: 5000 } } }, actorId: mod.id, at: now - 600000, note: 'back to preset' },
      { version: 2, config: { ...config, abilities: { ...config.abilities, heavy: { damage: 30, cooldownMs: 5000 } } }, actorId: '3003', at: now - 3600000, note: 'heavier heavy' },
      { version: 1, config, actorId: 'system', at: now - 86400000, note: '' },
    ];
    const snapshot = () => ({ type: 'snapshot', channel: 'nesszerra', revision: 40 + posts.length, paused: false, chat: { connected: true, lastSeen: now - 4000, status: 'enabled' }, config: quickOff ? { ...config, quickDuel: false } : config, configVersion: version, round: 7,
      players: [
        { ...board[0], hp: 62, lastSeen: now - 20000, registered: true, respawnAt: 0 },
        { ...board[1], hp: 85, lastSeen: now - 5000, registered: true, respawnAt: 0 },
        { ...board[2], hp: 0, lastSeen: now - 9000, registered: true, respawnAt: now + 60000 },
        { userId: '5005', username: 'lurker', displayName: 'lurker', avatar: 'player', color: '#a78bfa', defaultAbility: 'strike', hp: 100, elo: 1000, wins: 0, losses: 0, lastSeen: now - 120000, registered: false, respawnAt: 0 },
      ],
      duels: [
        { id: 'd1', a: '3003', b: '1001', status: 'active', createdAt: now - 20000, expiresAt: now + 10000, startedAt: now - 15000, lastActionAt: now - 3000, hp: { 3003: 62, 1001: 85 }, rules: { maxHp: 100 }, round: 7 },
        { id: 'd2', a: '5005', b: '4004', status: 'pending', createdAt: now - 5000, expiresAt: now + 25000, round: 0 },
      ], events: [] });
    await page.route('**/api/session', (r) => json(r, { user: role === 'owner' ? { id: '9009', login: 'nesszerra', displayName: 'nesszerra' } : mod, owner: role === 'owner', configured: true, channels: ['nesszerra'], productionEnabled: false }));
    await page.route('**/api/access/nesszerra', (r) => json(r, { owner: role === 'owner', moderator: role === 'mod', canManage: true }));
    await page.route('**/api/leaderboard/nesszerra', (r) => json(r, board));
    await page.route('**/api/assets/nesszerra', (r) => json(r, { items: [{ id: 'c-mascot', label: 'Mascot', frames: [{ x: 0, y: 0, w: 128, h: 128 }, { x: 128, y: 0, w: 128, h: 128 }], animations: { attack: [{ x: 256, y: 0, w: 128, h: 128 }] }, bytes: 48213, createdBy: mod.id, createdAt: now - 7200000 }], usage: { count: 1, limit: 24, bytes: 48213 }, limits: { maxFrames: 24, frameSize: 128, maxAtlasBytes: 1572864, maxCharacters: 24 } }));
    await page.route('**/api/admin/nesszerra', async (r) => {
      if (r.request().method() === 'GET') return json(r, { ...snapshot(), chatStatus, history: history(), customUsage: { count: 1, limit: 24, bytes: 48213 }, access: { owner: role === 'owner', moderator: role === 'mod', canManage: true } });
      const body = r.request().postDataJSON(); posts.push(body);
      if (conflictNext) { conflictNext = false; version = 4; return json(r, { ok: false, reason: 'config_version_conflict', error: 'config_version_conflict' }, 409); }
      if (body.action === 'config' || body.action === 'rollbackConfig') version += 1;
      if (body.action === 'connectChat') {
        if (reconnectNext) { reconnectNext = false; return json(r, { error: 'Twitch rejected the chat subscription: missing authorization. Reconnect Twitch at /auth/login?connect=1, then click Connect chat.', reconnect: '/auth/login?connect=1' }, 403); }
        chatStatus = { ...chatStatus, connected: true, status: 'enabled', subscriptionId: 'sub-2' };
        return json(r, { ok: true, reason: 'chat_connected', revision: 51, chatStatus });
      }
      if (body.action === 'disconnectChat') { chatStatus = { ...chatStatus, connected: false, status: 'disconnected', subscriptionId: '' }; return json(r, { ok: true, reason: 'chat_disconnected', revision: 52, chatStatus }); }
      return json(r, { ok: true, reason: 'ok', revision: 50 });
    });
    await page.goto(base + '/admin/');
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#summary-title').textContent === 'Duels are live');
    assert.equal(await page.locator('#open-chat-setup').isHidden(), true, 'no chat-setup shortcut while chat is live');
    assert.equal(await page.locator('#duels tbody tr').count(), 2);
    assert.equal(await page.locator('#players tbody tr').count(), 4);
    assert.equal(await page.locator('#ranks tbody tr').count(), 3);
    assert.equal(await page.locator('#history tbody tr').count(), 3);
    assert.match(await page.locator('#history tbody tr').nth(1).textContent(), /Heavy strike damage 35 HP → 30 HP/);
    assert.match(await page.locator('#usage-title').textContent(), /1 of 24/);
    assert.equal(await page.locator('#dev-open').isVisible(), role === 'owner');   // on the Live tab, shown first
    assert.equal(await page.locator('#dev-link').textContent(), 'Owner');
    const liveText = await page.locator('#panel-live').textContent(), headline = await page.locator('#stats, #summary-text, #meta').allTextContents();
    for (const jargon of ['state revision', 'Rules version', 'Live-fix']) assert.ok(!liveText.includes(jargon), 'no "' + jargon + '" on the Live tab');
    assert.ok(!/round/i.test(headline.join(' ')), 'no global round number in the summary');
    assert.match(await page.locator('#stats').textContent(), /Twitch chat\s*Connected/);
    assert.match(await page.locator('#stats').textContent(), /Duels\s*On\s*accepting commands/);
    // the summary holds at most the one primary action; the moderation buttons sit in their own section below the stats
    assert.equal(await page.locator('.summary #toggle-duels, .summary #reset-health, .summary #reset-round').count(), 0, 'moderation buttons are not in the summary');
    assert.equal(await page.locator('.summary .btn-primary:visible').count(), 0, 'no primary action while chat works');
    assert.deepEqual(await page.locator('#panel-live .moderation button').evaluateAll((b) => b.map((x) => x.id)), ['toggle-duels', 'reset-health', 'reset-round']);
    assert.equal(await page.locator('#moderation-title').textContent(), 'Moderation');
    assert.ok(await page.locator('.moderation').evaluate((n) => n.getBoundingClientRect().top > document.querySelector('#stats').getBoundingClientRect().bottom), 'Moderation comes after the stats');
    assert.match(await page.locator('#meta').textContent(), /^Signed in as (the broadcaster|a moderator)\.$/);
    assert.equal(await page.locator('#panel-chat').isHidden(), true, 'only the Live tab shows at first');
    await page.click('#tab-chat');
    assert.equal(new URL(page.url()).hash, '#chat');
    // the OBS Browser Source link moved here from the viewer page
    assert.match(await page.locator('#obs-url').inputValue(), /\/overlay\.html\?channel=nesszerra&size=64&arena=1$/);
    assert.match(await page.locator('#demo').getAttribute('href'), /arena=1&demo=1$/);
    assert.equal(await page.locator('#se-health').isHidden(), true, 'no StreamElements note before any command');
    assert.equal(await page.locator('#owner-chat').isVisible(), role === 'owner');
    assert.match(await page.locator('#chat-text').textContent(), /Last chat message/);
    assert.equal(await page.locator('#connect-chat').textContent(), 'Reconnect chat');
    if (s.name === '1280') {
      // first try: Twitch says the broadcaster authorization is missing, so the page points at the reconnect link
      await page.click('#connect-chat');
      await page.waitForFunction(() => /Reconnect Twitch/.test(document.querySelector('#chat-status').textContent));
      assert.equal(await page.locator('#chat-status a[href="/auth/login?connect=1"]').count() + await page.locator('#owner-chat a[href="/auth/login?connect=1"]').count() >= 1, true);
      await page.click('#connect-chat');
      await page.waitForFunction(() => /Chat connected/.test(document.querySelector('#chat-status').textContent));
      assert.deepEqual(posts.filter((p) => p.action === 'connectChat').length, 2);
      await page.click('#disconnect-chat');   // dialog auto-accepted
      await page.waitForFunction(() => /Chat disconnected/.test(document.querySelector('#chat-status').textContent));
      assert.equal(posts.at(-1).action, 'disconnectChat');
      // chat offline: the Live tab points at the fix instead of offering to pause
      await page.click('#tab-live');
      await page.waitForFunction(() => document.querySelector('#summary-title').textContent === 'Waiting for chat');
      assert.equal(await page.locator('#open-chat-setup').isVisible(), true);
      assert.equal(await page.locator('#toggle-duels.btn-primary').count(), 0, 'one primary action');
      assert.equal(await page.locator('.summary .btn-primary:visible').count(), 1, 'the summary holds just the primary action');
      assert.match(await page.locator('#stats').textContent(), /Duels\s*Waiting\s*for chat/, 'Duels are not "On" while chat is down');
      await page.click('#open-chat-setup');
      assert.equal(await page.locator('#tab-chat').getAttribute('aria-selected'), 'true');
    }
    assert.ok(await page.evaluate(() => window.__sockets.some((w) => w.url.endsWith('/api/live/nesszerra'))), 'live socket opened');
    if ((await page.request.head(base + '/upload.js')).ok()) {   // Lane D's uploader is mounted into the admin page
      await page.waitForFunction(() => !document.querySelector('#upload-root').textContent.includes("isn't available"));
      assert.equal(await page.locator('#upload-root .status.error').count(), 0, await page.locator('#upload-root').textContent());
    }
    for (const tab of ['live', 'players', 'rules', 'characters', 'chat']) {
      await page.click('#tab-' + tab);
      assert.equal(await page.locator('#panel-' + tab).isVisible(), true, tab + ' panel shows');
      assert.equal(await page.locator('[role=tabpanel]:visible').count(), 1, 'one panel at a time');
      if (tab === 'characters') {
        const text = await page.locator('#panel-characters').innerText(), count = (re) => (text.match(re) || []).length;
        assert.equal(count(/custom character slots used/g), 1, 'slot usage appears once on the Characters tab');
        assert.ok(count(/PNG only/g) <= 1 && count(/characters per channel/g) <= 1, 'upload limits appear once');
        assert.ok(count(/1.5 MB|1.50 MB/g) <= 1, 'the atlas size limit appears once');
      }
      if (tab === 'rules') {
        assert.equal(await page.locator('#config-fields .config-group:visible').count(), 2, 'only the groups that apply show');
        assert.equal(await page.locator('#cfg-abilities-strike-damage').count(), 1, 'the HP fight inputs stay in the form');
        assert.equal(await page.locator('#cfg-abilities-strike-damage').isVisible(), false, 'HP fight abilities are hidden unless quick duels are off');
        assert.ok(!/ability values apply/.test(await page.locator('#panel-rules').innerText()));
      }
      await noOverflow(page, 'admin ' + role + ' ' + s.name + ' ' + tab);
      await page.screenshot({ path: shots + '/admin-' + role + '-' + s.name + (tab === 'live' ? '' : '-' + tab) + '.png', fullPage: true });
    }
    // arrow keys move between tabs
    await page.focus('#tab-chat');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#tab-live').getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-live');
    if (s.name === '390') {
      // phones: with unsaved rule changes the Save bar stays at the bottom of the screen
      await page.click('#tab-rules');
      await page.locator('#cfg-maxHp').fill('120');
      const field = await page.locator('#cfg-maxHp').boundingBox(), bar = await page.locator('#config-bar').boundingBox(), vh = page.viewportSize().height;
      assert.ok(bar.y + bar.height <= vh + 1 && bar.y > vh / 2, 'Rules save bar sits at the bottom of the screen at 390');
      assert.ok(field.y + field.height <= bar.y, 'the field being edited is not hidden behind the bar');
      assert.equal(await page.locator('#config-save').isEnabled(), true);
      await page.screenshot({ path: shots + '/admin-' + role + '-390-rules-editing.png' });
    }
    if (s.name !== '1280' || role !== 'mod') { await context.close(); continue; }

    await page.locator('#toggle-duels').click();
    await page.waitForFunction(() => document.querySelector('#action-status').classList.contains('ok'));
    assert.deepEqual(posts.at(-1), { action: 'config', payload: { patch: { enabled: false }, baseVersion: 3, note: 'duels paused' } });
    await page.locator('#duels tbody tr').first().getByRole('button', { name: 'Cancel duel' }).click();
    await page.waitForFunction((n) => document.querySelector('#action-status').textContent.includes('cancelled'), posts.length);
    assert.deepEqual(posts.at(-1), { action: 'cancelDuel', payload: { duelId: 'd1' } });
    await page.locator('#reset-health').click(); await page.waitForTimeout(150);
    assert.deepEqual(posts.at(-1), { action: 'resetHealth' });
    await page.locator('#reset-round').click(); await page.waitForTimeout(150);
    assert.deepEqual(posts.at(-1), { action: 'resetRound' });
    await page.click('#tab-players');
    await page.locator('#ranks tbody tr').first().getByRole('button', { name: 'Reset rank' }).click(); await page.waitForTimeout(150);
    assert.deepEqual(posts.at(-1), { action: 'resetRank', payload: { userId: '3003' } });
    await page.locator('#reset-all-ranks').click(); await page.waitForTimeout(150);
    assert.deepEqual(posts.at(-1), { action: 'resetAllRanks' });
    // config: invalid value blocks save, valid value saves only the changed field
    await page.click('#tab-rules');
    assert.equal(await page.locator('#history').isVisible(), false, 'version history starts collapsed');
    // hidden HP-fight inputs still round trip: saving another field sends only that field
    await page.locator('#cfg-maxHp').fill('120');
    await page.locator('#config-save').click();
    await page.waitForFunction(() => document.querySelector('#config-status').textContent.startsWith('Saved as version'));
    assert.deepEqual(posts.at(-1).payload.patch, { maxHp: 120 });
    // with quick duels off the HP-fight group shows
    quickOff = true;
    await page.reload();
    await page.waitForSelector('#app:not([hidden])');
    await page.click('#tab-rules');
    assert.equal(await page.locator('#config-fields .config-group:visible').count(), 3);
    assert.match(await page.locator('#config-fields .config-group:visible').last().locator('legend').textContent(), /HP fight abilities/);
    const strike = page.locator('#cfg-abilities-strike-damage');
    await strike.fill('5000');
    assert.equal(await page.locator('#config-save').isDisabled(), true);
    assert.match(await page.locator('#config-status').textContent(), /between 1 HP and 1000 HP/);
    await strike.fill('12');
    await page.locator('#cfg-abilities-strike-cooldownMs').fill('2.5');
    await page.locator('#config-note').fill('faster strikes');
    const base0 = version;
    await page.locator('#config-save').click();
    await page.waitForFunction(() => document.querySelector('#config-status').textContent.startsWith('Saved as version'));
    assert.deepEqual(posts.at(-1), { action: 'config', payload: { patch: { abilities: { strike: { damage: 12, cooldownMs: 2500 } } }, baseVersion: base0, note: 'faster strikes' } });
    // 409: reload and explain
    conflictNext = true;
    await page.locator('#cfg-maxHp').fill('150');
    await page.locator('#config-save').click();
    await page.waitForFunction(() => document.querySelector('#config-status').textContent.includes('someone else saved'));
    assert.match(await page.locator('#config-status').textContent(), /Max health 100 HP → 150 HP/);
    await page.locator('#config-form').screenshot({ path: shots + '/admin-config-conflict-1280.png' });
    await page.click('#history-title');
    await page.locator('#history tbody tr').nth(1).getByRole('button', { name: /Revert to v2/ }).click();
    await page.waitForTimeout(200);
    assert.deepEqual(posts.at(-1), { action: 'rollbackConfig', payload: { version: 2 } });
    if (s.name === '1280') {
      await page.click('#tab-chat');
      // Duel announcements save to the channel config (live overlays follow it); the link stays the same.
      await page.click('#obs-setup details > summary');   // overlay options start folded
      assert.equal(await page.locator('#announce').inputValue(), 'off');
      await page.selectOption('#announce', 'top');
      await page.waitForFunction(() => /within seconds/.test(document.querySelector('#announce-status').textContent) && !document.querySelector('#announce').disabled);
      assert.deepEqual(posts.at(-1).payload.patch, { announce: 'top' });
      assert.match(await page.locator('#obs-url').inputValue(), /size=\d+&arena=1$/, 'the settings are not in the link');
      // The on-stream limit is a channel setting too; out-of-range values are refused before posting.
      await page.fill('#cap', '9'); await page.locator('#cap').dispatchEvent('change');
      assert.match(await page.locator('#cap-status').textContent(), /15 to 100/);
      await page.fill('#cap', '30'); await page.locator('#cap').dispatchEvent('change');
      await page.waitForFunction(() => /up to 30/.test(document.querySelector('#cap-status').textContent) && !document.querySelector('#cap').disabled);
      assert.deepEqual(posts.at(-1).payload.patch, { maxOnStream: 30 });
    }
    await context.close();
  }
  // 6. StreamElements is the chat source but no command has reached this site: the Stream setup tab warns.
  for (const se of [{ lastCommandAt: 0, rejectedAt: 0, expect: /No StreamElements command has reached \S+ with this key yet.*test site.*!no/, warn: true, live: 'Waiting for the first chat command', stat: 'No commands yet' },
    { lastCommandAt: now - 120000, rejectedAt: 0, expect: /Last StreamElements command reached \S+ 2 min ago/, warn: false, live: 'Duels are live', stat: 'Working' },
    { lastCommandAt: now - 120000, rejectedAt: now - 30000, expect: /old key and was refused/, warn: true, live: 'StreamElements is sending an old key', stat: 'Old key' }]) {
    const { context, page } = await newPage(sizes[0]);
    const chatStatus = { connected: true, source: 'streamelements', status: 'enabled', subscriptionId: 'se-streamelements', createdAt: now - 86400000, lastNotificationAt: se.lastCommandAt, lastRevocationReason: '', checkedAt: 0 };
    const streamelements = { key: 'k'.repeat(48), names: { challenge: '!challenge', accept: '!fight', decline: '!no' }, origin: base, lastCommandAt: se.lastCommandAt, rejectedAt: se.rejectedAt,
      commands: ['challenge', 'accept', 'decline'].map((action) => ({ action, name: '!' + action, response: '$(customapi ' + base + '/api/se/nesszerra/' + action + '?k=' + 'k'.repeat(48) + ')' })) };
    await page.route('**/api/session', (r) => json(r, { user: mod, owner: false, configured: true, channels: ['nesszerra'], productionEnabled: false }));
    await page.route('**/api/access/nesszerra', (r) => json(r, { owner: false, moderator: true, canManage: true }));
    await page.route('**/api/leaderboard/nesszerra', (r) => json(r, board));
    await page.route('**/api/assets/nesszerra', (r) => json(r, { items: [], usage: { count: 0, limit: 8, bytes: 0 }, limits: { maxFrames: 24, frameSize: 128, maxAtlasBytes: 1572864, maxCharacters: 8 } }));
    await page.route('**/api/admin/nesszerra', (r) => json(r, { type: 'snapshot', channel: 'nesszerra', revision: 5, paused: false, chat: { connected: true, lastSeen: se.lastCommandAt, status: 'enabled' }, config, configVersion: 1, round: 1, players: [], duels: [], events: [],
      chatStatus, history: [{ version: 1, config, actorId: 'system', at: now - 86400000, note: '' }], customUsage: { count: 0, limit: 8, bytes: 0 }, streamelements, access: { owner: false, moderator: true, canManage: true } }));
    await page.goto(base + '/admin/#chat');
    await page.waitForSelector('#se-health:not([hidden])');
    assert.match(await page.locator('#se-health').textContent(), se.expect);
    assert.equal(await page.locator('#se-health').evaluate((n) => n.classList.contains('warning')), se.warn);
    // the Live tab tells the same story as Stream setup
    assert.equal(await page.locator('#summary-title').textContent(), se.live);
    assert.match(await page.locator('#stats').textContent(), new RegExp('StreamElements\\s*' + se.stat));
    // the reply column never shows the key; Copy reply still copies the whole line
    const previews = await page.locator('#se-table code.reply-preview').allTextContents();
    assert.equal(previews.length, 3);
    for (const p of previews) { assert.match(p, /^\$\(customapi \/api\/se\/nesszerra\/\w+\?k=…\)$/); assert.ok(!p.includes('kkkk')); }
    if (se.warn && !se.rejectedAt) { await page.locator('#se-health').scrollIntoViewIfNeeded(); await page.screenshot({ path: shots + '/admin-se-warning-1280.png' }); }
    await context.close();
  }
  // 7. Setup checklist: live states from /api/admin, the Live tab points at the first unfinished step, the Duel-module tick saves.
  for (const s of sizes) {
    const { context, page } = await newPage(s);
    const actions = ['challenge', 'accept', 'decline', 'top', 'elo', 'help'];
    let overlays = 0, duelModuleOff = false, seen = { challenge: now - 120000, decline: now - 120000 };
    const posts = [];
    const chatStatus = { connected: true, source: 'streamelements', status: 'enabled', subscriptionId: 'se-streamelements', createdAt: now - 86400000, lastNotificationAt: now - 120000, lastRevocationReason: '', checkedAt: 0 };
    const streamelements = () => ({ key: 'k'.repeat(48), names: {}, origin: base, lastCommandAt: now - 120000, rejectedAt: 0, seen, duelModuleOff, timerText: 'x',
      commands: actions.map((action) => ({ action, name: '!' + action, response: '$(customapi ' + base + '/api/se/nesszerra/' + action + '?k=' + 'k'.repeat(48) + ')' })) });
    await page.route('**/api/session', (r) => json(r, { user: mod, owner: false, configured: true, channels: ['nesszerra'], productionEnabled: false }));
    await page.route('**/api/access/nesszerra', (r) => json(r, { owner: false, moderator: true, canManage: true }));
    await page.route('**/api/leaderboard/nesszerra', (r) => json(r, board));
    await page.route('**/api/assets/nesszerra', (r) => json(r, { items: [], usage: { count: 0, limit: 8, bytes: 0 }, limits: { maxFrames: 24, frameSize: 128, maxAtlasBytes: 1572864, maxCharacters: 8 } }));
    await page.route('**/api/admin/nesszerra', (r) => {
      if (r.request().method() === 'POST') { const body = r.request().postDataJSON(); posts.push(body); if (body.action === 'setDuelModuleOff') duelModuleOff = body.value; return json(r, { ok: true }); }
      return json(r, { type: 'snapshot', channel: 'nesszerra', revision: 5, paused: false, chat: { connected: true, lastSeen: now, status: 'enabled' }, config, configVersion: 1, round: 1, players: [], duels: [], events: [],
        chatStatus, history: [{ version: 1, config, actorId: 'system', at: now - 86400000, note: '' }], customUsage: { count: 0, limit: 8, bytes: 0 }, streamelements: streamelements(), overlays, modsReady: true, access: { owner: false, moderator: true, canManage: true } });
    });
    await page.goto(base + '/admin/');
    await page.waitForSelector('#setup-next:not([hidden])');
    assert.equal(await page.locator('#setup-next').textContent(), 'Stream setup: 0 of 3 steps done. Next: open the overlay in OBS.');
    await page.click('#setup-next a');
    assert.equal(await page.locator('#panel-chat').isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'check-overlay');
    assert.equal(await page.locator('#check-title').textContent(), 'Stream setup: 0 of 3 steps done');
    assert.match(await page.locator('#check-overlay').textContent(), /To do.*No overlay is open/s);
    assert.match(await page.locator('#check-commands').textContent(), /2 of 6 commands have reached Mini Chat\. Not used yet: !accept, !top, !elo, !help\./);
    assert.match(await page.locator('#check-mods').textContent(), /Done.*moderators of nesszerra can sign in/s);
    assert.deepEqual(await page.locator('#se-table [data-seen]').allTextContents(), ['Working · 2 min ago', 'Not used yet', 'Working · 2 min ago', 'Not used yet', 'Not used yet', 'Not used yet']);
    // the command table uses the full step width: badges stay on one line, nothing is cut off, narrow screens scroll inside the wrap
    const wrap = page.locator('#se-table').locator('xpath=..'), wrapBox = await wrap.boundingBox();
    for (const b of await page.locator('#se-table [data-seen] .badge').all()) assert.ok((await b.boundingBox()).height < 28, 'status badge on one line at ' + s.name);
    const lastCell = await page.locator('#se-table tbody tr').first().locator('td').last().boundingBox();
    if (s.name === '1280') {
      assert.ok(wrapBox.width > 800, 'table is wider than the reading column, got ' + wrapBox.width);
      assert.ok(await wrap.evaluate((n) => n.scrollWidth <= n.clientWidth + 1), 'table is not clipped at 1280');
      assert.ok(lastCell.x + lastCell.width <= wrapBox.x + wrapBox.width + 1, 'Response to paste column fits');
      const prose = await page.locator('#se-setup > ol').boundingBox();
      assert.ok(prose.width <= 720, 'step prose stays at reading width, got ' + prose.width);
    } else {
      assert.ok(await wrap.evaluate((n) => n.scrollWidth > n.clientWidth), 'table scrolls inside its wrap at 390');
    }
    await noOverflow(page, 'setup checklist ' + s.name);
    await page.locator('#setup-check').screenshot({ path: shots + '/admin-checklist-' + s.name + '.png' });
    // tick the Duel module box; then an overlay connects and !fight arrives, and the next refresh finishes setup
    await page.check('#duel-module-off');
    await page.waitForFunction(() => /Duel module is off/.test(document.querySelector('#check-status').textContent));
    assert.deepEqual(posts.at(-1), { action: 'setDuelModuleOff', value: true });
    await page.waitForFunction(() => /^\s*Done/.test(document.querySelector('#check-duel').textContent));   // after the reload
    overlays = 1; seen = { ...seen, accept: now };
    await page.waitForFunction(() => document.querySelector('#check-title').textContent === 'Stream setup is done', null, { timeout: 15000 });
    assert.match(await page.locator('#check-overlay').textContent(), /1 overlay is connected right now/);
    assert.equal(await page.locator('#setup-next').isHidden(), true);
    await context.close();
  }
  // 7b. Step 4 "Let your moderators help" reads differently for the broadcaster, the site owner on another channel, and a moderator.
  {
    const owner = { id: '9009', login: 'nesszerra', displayName: 'nesszerra' }, newstreamer = { id: '5505', login: 'newstreamer', displayName: 'NewStreamer' };
    const ownerAccess = { owner: true, moderator: false, canManage: true }, broadcasterAccess = { owner: false, broadcaster: true, moderator: false, canManage: true };
    const reconnect = '/auth/login?channel=newstreamer&connect=mods';
    const cases = [
      { name: 'owner, not connected', channel: 'miolafff', session: owner, owner: true, access: ownerAccess, extra: { modsReady: false },
        text: /^Mod access isn't connected\. miolafff has to connect it from their own Stream setup page\.$/, badge: 'Optional', link: null },
      { name: 'owner, connected', channel: 'miolafff', session: owner, owner: true, access: ownerAccess, extra: { modsReady: true },
        text: /^Twitch moderators of miolafff can sign in and use this page\.$/, badge: 'Done', link: null },
      { name: 'owner, expired', channel: 'miolafff', session: owner, owner: true, access: ownerAccess, extra: { modsReady: false, modsLapsed: true },
        text: /^Mod access expired\. miolafff has to reconnect it from their own Stream setup page\.$/, badge: 'Expired', link: null },
      { name: 'broadcaster, not connected', channel: 'newstreamer', session: newstreamer, owner: false, access: broadcasterAccess, extra: { modsReady: false },
        text: /^Your Twitch moderators can't sign in yet\. Mini Chat needs permission to read your moderator list\. Connect mod access$/, badge: 'Optional', link: ['Connect mod access', reconnect] },
      { name: 'broadcaster, expired', channel: 'newstreamer', session: newstreamer, owner: false, access: broadcasterAccess, extra: { modsReady: false, modsLapsed: true },
        text: /^Mod access expired, so your Twitch moderators can't sign in until you reconnect it\. Reconnect mod access$/, badge: 'Expired', link: ['Reconnect mod access', reconnect] },
      { name: 'moderator, not connected, duels paused', channel: 'miolafff', session: mod, owner: false, access: { owner: false, moderator: true, canManage: true }, extra: { modsReady: false }, paused: true,
        text: /^Mod access isn't connected\. Ask miolafff to connect it\.$/, badge: 'Optional', link: null },
    ];
    for (const c of cases) for (const s of sizes) {
      const { context, page } = await newPage(s);
      const ch = c.channel;
      await page.route('**/api/session', (r) => json(r, { user: c.session, owner: c.owner, configured: true, channels: ['nesszerra'], productionEnabled: false }));
      await page.route('**/api/access/' + ch, (r) => json(r, c.access));
      await page.route('**/api/leaderboard/' + ch, (r) => json(r, []));
      await page.route('**/api/assets/' + ch, (r) => json(r, { items: [], usage: { count: 0, limit: 8, bytes: 0 }, limits: { maxFrames: 24, frameSize: 128, maxAtlasBytes: 1572864, maxCharacters: 8 } }));
      await page.route('**/api/admin/' + ch, (r) => json(r, { type: 'snapshot', channel: ch, revision: 1, paused: false, chat: { connected: false, lastSeen: 0, status: 'disconnected' }, config: { ...config, enabled: !c.paused }, configVersion: 1, round: 1, players: [], duels: [], events: [],
        chatStatus: { connected: false, status: 'disconnected', subscriptionId: '', createdAt: 0 }, history: [{ version: 1, config, actorId: 'system', at: now, note: '' }], customUsage: { count: 0, limit: 8, bytes: 0 },
        streamelements: null, overlays: 0, channelState: 'on', ...c.extra, access: c.access }));
      await page.goto(base + '/admin/?channel=' + ch + '#chat');
      await page.waitForSelector('#app:not([hidden])');
      await page.waitForFunction(() => document.querySelector('#check-mods [data-detail]').textContent.length > 0);
      const detail = (await page.locator('#check-mods [data-detail]').textContent()).trim();
      assert.match(detail, c.text, c.name + ' ' + s.name);
      assert.ok(!/Only \w+ can open this page/.test(detail), c.name + ': the old wording is gone');
      assert.equal(await page.locator('#check-mods [data-badge]').textContent(), c.badge, c.name + ' badge');
      if (c.link) {
        assert.equal(await page.locator('#check-mods a').textContent(), c.link[0]);
        assert.equal(await page.locator('#check-mods a').getAttribute('href'), c.link[1]);
      } else assert.equal(await page.locator('#check-mods a').count(), 0, c.name + ': no connect link for this viewer');
      if (c.paused) { await page.click('#tab-live'); assert.match(await page.locator('#stats').textContent(), /Duels\s*Paused\s*commands ignored/); }
      if (s.name === '1280' && /owner, not/.test(c.name)) await page.locator('#check-mods').screenshot({ path: shots + '/admin-step4-owner-1280.png' });
      await context.close();
    }
  }
  // 8. /start: an invite link in each state (stubbed /api/invite), at 1280/390.
  const tok = 'ab'.repeat(16);
  for (const s of sizes) {
    const { context, page } = await newPage(s);
    let invite = { status: 'valid', login: 'newstreamer' };
    await page.route('**/api/invite/*', (r) => json(r, invite));
    await page.goto(base + '/start/');
    await page.waitForFunction(() => !document.querySelector('#invite-title').textContent.includes('Checking'));
    assert.equal(await page.locator('#invite-title').textContent(), 'Mini Chat is invite-only right now');
    await page.goto(base + '/start/?invite=' + tok);
    await page.waitForFunction(() => !document.querySelector('#invite-title').textContent.includes('Checking'));
    assert.equal(await page.locator('#invite-title').textContent(), 'Set up Mini Chat for newstreamer');
    assert.equal(await page.locator('#invite-actions a.btn-primary').getAttribute('href'), '/auth/login?invite=' + tok);
    assert.equal(await page.locator('#invite-actions a').count(), 1);
    assert.equal(await page.locator('#invite-problem').isHidden(), true);
    const stage = await page.locator('.stage').boundingBox(), frame = await page.locator('.stage iframe').boundingBox();
    assert.ok(Math.abs(stage.width / stage.height - 16 / 9) < 0.03, 'demo stage is 16:9, got ' + stage.width + 'x' + stage.height);
    if (s.name === '1280') assert.ok(stage.width > 900, 'demo stage spans the page at 1280, got ' + stage.width);
    assert.ok(Math.abs(frame.width - stage.width) < 4 && Math.abs(frame.height - stage.height) < 4, 'overlay frame fills the stage');
    assert.ok(await page.locator('.stage iframe').evaluate((f) => f.offsetWidth >= 640), 'overlay lays out at 640px or wider');
    await page.waitForTimeout(5000);   // let the demo fighters walk in before the screenshot
    await noOverflow(page, 'start valid ' + s.name);
    await page.screenshot({ path: shots + '/start-valid-' + s.name + '.png', fullPage: true });
    // back from Twitch after cancelling the permission: offer setup without mod access, and drop ?error from the URL
    await page.goto(base + '/start/?invite=' + tok + '&error=denied');
    await page.waitForSelector('#invite-problem:not([hidden])');
    assert.match(await page.locator('#invite-problem').textContent(), /cancelled the Twitch permission/);
    assert.deepEqual(await page.locator('#invite-actions a').evaluateAll((a) => a.map((x) => x.getAttribute('href'))), ['/auth/login?invite=' + tok, '/auth/login?invite=' + tok + '&mods=0']);
    assert.equal(new URL(page.url()).search, '?invite=' + tok);
    if (s.name === '390') await page.locator('#invite').screenshot({ path: shots + '/start-denied-390.png' });
    await page.goto(base + '/start/?invite=' + tok + '&error=wrong_account');
    await page.waitForSelector('#invite-problem:not([hidden])');
    assert.match(await page.locator('#invite-problem').textContent(), /This invite is for newstreamer\. Log out of twitch\.tv, then sign in again as newstreamer\./);
    invite = { status: 'used', login: 'newstreamer' };
    await page.goto(base + '/start/?invite=' + tok);
    await page.waitForSelector('#invite-problem:not([hidden])');
    assert.equal(await page.locator('#invite-actions a').getAttribute('href'), '/auth/login?channel=newstreamer&next=%2Fadmin%2F');
    invite = { status: 'expired', login: 'newstreamer' };
    await page.goto(base + '/start/?invite=' + tok);
    await page.waitForSelector('#invite-problem:not([hidden])');
    assert.match(await page.locator('#invite-problem').textContent(), /has expired/);
    assert.equal(await page.locator('#invite-actions a').count(), 0);
    await context.close();
  }

  // 9. An invited channel's own admin page: connect mod access later, turn Mini Chat off and back on.
  for (const s of sizes) {
    const { context, page } = await newPage(s);
    const me = { id: '5505', login: 'newstreamer', displayName: 'NewStreamer' };
    let channelState = 'on';
    const posts = [];
    await page.route('**/api/session', (r) => json(r, { user: me, owner: false, configured: true, channels: ['nesszerra'], productionEnabled: false }));
    await page.route('**/api/access/newstreamer', (r) => json(r, { owner: false, broadcaster: true, moderator: false, canManage: true }));
    await page.route('**/api/leaderboard/newstreamer', (r) => json(r, []));
    await page.route('**/api/assets/newstreamer', (r) => json(r, { items: [], usage: { count: 0, limit: 8, bytes: 0 }, limits: { maxFrames: 24, frameSize: 128, maxAtlasBytes: 1572864, maxCharacters: 8 } }));
    await page.route('**/api/admin/newstreamer', (r) => {
      if (r.request().method() === 'POST') { const body = r.request().postDataJSON(); posts.push(body); channelState = body.action === 'pauseChannel' ? 'paused' : 'on'; return json(r, { ok: true, channelState }); }
      return json(r, { type: 'snapshot', channel: 'newstreamer', revision: 1, paused: false, chat: { connected: false, lastSeen: 0, status: 'disconnected' }, config, configVersion: 1, round: 1, players: [], duels: [], events: [],
        chatStatus: { connected: false, status: 'disconnected', subscriptionId: '', createdAt: 0 }, history: [{ version: 1, config, actorId: 'system', at: now, note: '' }], customUsage: { count: 0, limit: 8, bytes: 0 },
        streamelements: null, overlays: 0, modsReady: false, channelState, access: { owner: false, broadcaster: true, moderator: false, canManage: true } });
    });
    page.on('dialog', (d) => d.accept());
    await page.goto(base + '/admin/?channel=newstreamer&mods=denied#chat');
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForFunction(() => /permission was cancelled/.test(document.querySelector('#check-status').textContent));
    assert.equal(new URL(page.url()).search, '?channel=newstreamer', 'the mods flag is dropped from the URL');
    assert.equal(await page.locator('#check-mods a').getAttribute('href'), '/auth/login?channel=newstreamer&connect=mods');
    assert.equal(await page.locator('#chat-box').isHidden(), true, 'Twitch chat connection is for nesszerra only');
    assert.equal(await page.locator('#troubleshoot').isVisible(), true);
    assert.deepEqual(await page.locator('#checklist > li h3').allTextContents(), ['Add the overlay to OBS', 'Turn off the StreamElements Duel module', 'Add the chat commands to StreamElements', 'Let your moderators help']);
    assert.equal(await page.locator('#summary-title').textContent(), 'Waiting for chat');
    assert.match(await page.locator('#stats').textContent(), /Duels\s*Waiting\s*for chat/);
    assert.equal(await page.locator('#channel-power').isVisible(), true);
    assert.equal(await page.locator('#paused-note').isHidden(), true);
    await page.click('#power-toggle');
    await page.waitForSelector('#paused-note:not([hidden])');
    assert.deepEqual(posts.at(-1), { action: 'pauseChannel' });
    assert.equal(await page.locator('#power-title').textContent(), 'Mini Chat is off on newstreamer');
    assert.equal(await page.locator('#power-toggle').textContent(), 'Turn Mini Chat back on');
    await noOverflow(page, 'admin paused ' + s.name);
    await page.screenshot({ path: shots + '/admin-paused-' + s.name + '.png' });
    await page.locator('#channel-power').screenshot({ path: shots + '/admin-power-' + s.name + '.png' });
    await page.click('#power-toggle');
    await page.waitForSelector('#paused-note', { state: 'hidden' });
    assert.deepEqual(posts.at(-1), { action: 'resumeChannel' });
    await context.close();
  }

  // 10. The viewer page of a channel that is off, or was never set up.
  {
    const { context, page } = await newPage(sizes[1]);
    let off = 'paused';
    await page.route('**/api/state/*', (r) => json(r, { error: 'off', off }, 403));
    await page.goto(base + '/?channel=newstreamer');
    await page.waitForSelector('#off-note:not([hidden])');
    assert.match(await page.locator('#off-note').textContent(), /Mini Chat is off on newstreamer's channel right now/);
    assert.equal(await page.locator('.fighter-card').isVisible(), true);
    off = 'not_enabled';
    await page.goto(base + '/?channel=nobodyhere');
    await page.waitForSelector('#off-note:not([hidden])');
    assert.match(await page.locator('#off-note').textContent(), /isn't set up on nobodyhere's channel/);
    assert.equal(await page.locator('.fighter-card').isHidden(), true);
    await noOverflow(page, 'viewer not set up 390');
    await page.screenshot({ path: shots + '/viewer-not-set-up-390.png' });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS: viewer + admin UI at 1280/390, signed-out (real server), signed-in viewer save, mod gate, admin actions, config save/409/revert; no page errors.');
} finally { await browser.close(); }
