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
    let version = 3, conflictNext = false, reconnectNext = true;
    let chatStatus = { connected: true, status: 'enabled', subscriptionId: 'sub-1', createdAt: now - 86400000, lastNotificationAt: now - 4000, lastRevocationReason: '', checkedAt: now - 600000 };
    const history = () => [
      { version: 3, config: { ...config, abilities: { ...config.abilities, heavy: { damage: 35, cooldownMs: 5000 } } }, actorId: mod.id, at: now - 600000, note: 'back to preset' },
      { version: 2, config: { ...config, abilities: { ...config.abilities, heavy: { damage: 30, cooldownMs: 5000 } } }, actorId: '3003', at: now - 3600000, note: 'heavier heavy' },
      { version: 1, config, actorId: 'system', at: now - 86400000, note: '' },
    ];
    const snapshot = () => ({ type: 'snapshot', channel: 'nesszerra', revision: 40 + posts.length, paused: false, chat: { connected: true, lastSeen: now - 4000, status: 'enabled' }, config, configVersion: version, round: 7,
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
    await page.route('**/api/assets/nesszerra', (r) => json(r, { items: [{ id: 'c-mascot', label: 'Mascot', frames: [{ x: 0, y: 0, w: 128, h: 128 }, { x: 128, y: 0, w: 128, h: 128 }], animations: { attack: [{ x: 256, y: 0, w: 128, h: 128 }] }, bytes: 48213, createdBy: mod.id, createdAt: now - 7200000 }], usage: { count: 1, limit: 8, bytes: 48213 }, limits: { maxFrames: 24, frameSize: 128, maxAtlasBytes: 1572864, maxCharacters: 8 } }));
    await page.route('**/api/admin/nesszerra', async (r) => {
      if (r.request().method() === 'GET') return json(r, { ...snapshot(), chatStatus, history: history(), customUsage: { count: 1, limit: 8, bytes: 48213 }, access: { owner: role === 'owner', moderator: role === 'mod', canManage: true } });
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
    assert.match(await page.locator('#usage-title').textContent(), /1 of 8/);
    assert.equal(await page.locator('#dev-open').isVisible(), role === 'owner');   // on the Live tab, shown first
    assert.equal(await page.locator('#panel-chat').isHidden(), true, 'only the Live tab shows at first');
    await page.click('#tab-chat');
    assert.equal(new URL(page.url()).hash, '#chat');
    // the OBS Browser Source link moved here from the viewer page
    assert.match(await page.locator('#obs-url').inputValue(), /\/overlay\.html\?channel=nesszerra&size=64&cap=50&arena=1$/);
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
      await page.waitForFunction(() => document.querySelector('#summary-title').textContent === 'Waiting for Twitch chat');
      assert.equal(await page.locator('#open-chat-setup').isVisible(), true);
      assert.equal(await page.locator('#toggle-duels.btn-primary').count(), 0, 'one primary action');
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
      assert.equal(await page.locator('#announce').inputValue(), 'off');
      await page.selectOption('#announce', 'top');
      await page.waitForFunction(() => /within seconds/.test(document.querySelector('#announce-status').textContent) && !document.querySelector('#announce').disabled);
      assert.deepEqual(posts.at(-1).payload.patch, { announce: 'top' });
      assert.match(await page.locator('#obs-url').inputValue(), /cap=50&arena=1$/, 'the setting is not in the link');
    }
    await context.close();
  }
  // 6. StreamElements is the chat source but no command has reached this site: the Stream setup tab warns.
  for (const se of [{ lastCommandAt: 0, rejectedAt: 0, expect: /No StreamElements command has reached \S+ with this key yet.*test site.*!no/, warn: true },
    { lastCommandAt: now - 120000, rejectedAt: 0, expect: /Last StreamElements command reached \S+ 2 min ago/, warn: false },
    { lastCommandAt: now - 120000, rejectedAt: now - 30000, expect: /old key and was refused/, warn: true }]) {
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
    if (se.warn && !se.rejectedAt) { await page.locator('#se-health').scrollIntoViewIfNeeded(); await page.screenshot({ path: shots + '/admin-se-warning-1280.png' }); }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS: viewer + admin UI at 1280/390, signed-out (real server), signed-in viewer save, mod gate, admin actions, config save/409/revert; no page errors.');
} finally { await browser.close(); }
