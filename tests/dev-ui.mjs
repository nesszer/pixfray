// Lane E UI check: owner page (/admin/dev/) at 1280px and 390px.
// Signed-out runs against the real local server; owner states stub /api/session and /api/dev/* with page.route,
// unless MINI_OWNER_COOKIE (a local test session id) is set, which adds one unstubbed owner run.
// Usage: MINI_BASE_URL=http://127.0.0.1:5195 node tests/dev-ui.mjs   (screenshots go to the OS temp dir)
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const base = process.env.MINI_BASE_URL || 'http://127.0.0.1:5173';
const shots = path.join(os.tmpdir(), 'mini-chat-dev-shots');
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const sizes = [{ name: '1280', width: 1280, height: 900 }, { name: '390', width: 390, height: 844 }];
const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
const owner = { id: '900001', login: 'nesszerra', displayName: 'nesszerra' };
const now = Date.now(), errors = [];
const config = { enabled: true, maxHp: 100, maxDuels: 5, challengeTimeoutMs: 30000, inactivityMs: 45000, respawnMs: 3000, rematchDelayMs: 30000, sharedCooldownMs: 1000, initialElo: 1000, eloK: 24,
  abilities: { strike: { damage: 20, cooldownMs: 2000 }, heavy: { damage: 35, cooldownMs: 5000 }, heal: { amount: 15, cooldownMs: 12000 } } };
const diag = (configured) => ({
  worker: { version: '0.2.0', twitchConfigured: true, productionEnabled: false, deployedVersion: configured ? { id: '5d1c9a3e-0000-4000-8000-000000000001', tag: 'gh-1a2b3c4-1234', timestamp: '' } : null },
  room: { channel: 'nesszerra', revision: 42, chat: { connected: configured, lastSeen: now - 4000, status: configured ? 'enabled' : 'disconnected' }, chatStatus: { connected: configured, status: configured ? 'enabled' : 'disconnected', subscriptionId: configured ? 'sub-1' : '', createdAt: now - 86400000, lastNotificationAt: now - 4000, lastRevocationReason: '', checkedAt: now - 600000 }, paused: !configured, configVersion: 3, players: 6, openDuels: 1, sockets: { live: 2 }, errors: 2, errorsBySource: { room: 1, worker: 1 }, lastError: { at: now - 600000, source: 'room', message: 'room error' } },
  integrations: { github: configured ? { configured: true, missing: [], repo: 'Finesssee/mini-chat', base: 'main', workflow: 'deploy.yml' } : { configured: false, missing: ['GITHUB_TOKEN', 'GITHUB_REPO'], repo: '', base: 'main', workflow: 'deploy.yml' },
    cloudflare: { configured, missing: configured ? [] : ['CF_API_TOKEN', 'CF_ACCOUNT_ID'], versionMetadata: configured } },
  usage: configured ? { configured: true, limit: 100000, requests: 18234, percent: 18.2, resetsAt: new Date(Date.UTC(2026, 9, 2)).toISOString() } : { configured: false, limit: 100000, error: 'Set CF_API_TOKEN and CF_ACCOUNT_ID to read request usage' },
});
const progress = (p) => ({ overlays: 0, source: 'streamelements', commandsWorking: 0, commands: 6, duelCommands: false, duelModuleOff: false, lastCommandAt: 0, rejectedAt: 0, lastChatAt: 0, players: 0, ...p });
async function stub(page, { configured }) {
  const tok = 'cd'.repeat(16);
  const reg = { builtin: ['nesszerra', 'miolafff'], max: 200, channels: [{ login: 'oldstreamer', enabledAt: now - 86400000 }],
    invites: [{ token: 'ef'.repeat(16), login: 'latecomer', createdAt: now - 9 * 86400000, status: 'expired' }] };
  const setup = { nesszerra: progress({ overlays: 1, source: 'twitch', lastChatAt: now - 60000 }),
    miolafff: progress({ commandsWorking: 4, duelCommands: true, duelModuleOff: true, lastCommandAt: now - 120000 }),
    oldstreamer: progress({ source: '', rejectedAt: now - 60000 }) };
  await page.route('**/api/session', (r) => json(r, { user: owner, owner: true, configured: true, channels: ['nesszerra'], productionEnabled: false }));
  await page.route('**/api/dev/**', (r) => {
    const u = new URL(r.request().url()), op = u.pathname.slice('/api/dev/'.length), method = r.request().method();
    if (op === 'diagnostics') return json(r, diag(configured));
    if (op === 'settings' && method === 'GET') return json(r, { config, configVersion: 3, history: [{ version: 3, actorId: '900001', at: now - 3600000, note: 'Lower heavy to 25' }, { version: 2, actorId: '900001', at: now - 7200000, note: '' }, { version: 1, actorId: 'system', at: now - 86400000, note: 'initial' }] });
    if (op === 'settings') return json(r, { ok: true });
    if (op === 'logs') return json(r, [{ id: 2, at: now - 600000, source: 'room', message: 'room error', context: { path: '/eventsub', method: 'POST' } }, { id: 1, at: now - 900000, source: 'worker', message: 'Unexpected token in JSON at position 0', context: { path: '/api/profile/nesszerra' } }]);
    if (op === 'channels' && method === 'POST') {
      const b = JSON.parse(r.request().postData());
      if (b.action === 'invite') { reg.invites.unshift({ token: tok, login: b.login.toLowerCase(), createdAt: Date.now(), status: 'valid' }); return json(r, { ok: true, token: tok, link: base + '/start/?invite=' + tok, ...reg }); }
      if (b.action === 'pause' || b.action === 'resume') { const c = reg.channels.find((x) => x.login === b.login); if (b.action === 'pause') c.pausedAt = Date.now(); else delete c.pausedAt; return json(r, { ok: true, ...reg }); }
      if (b.action === 'revoke') { reg.invites = reg.invites.filter((i) => i.token !== b.token); return json(r, { ok: true, ...reg }); }
    }
    if (op === 'channels') return json(r, { ...reg, progress: setup });
    if (!configured) return json(r, { error: 'GitHub is not configured: set the GITHUB_TOKEN secret and GITHUB_REPO (see docs/LIVE_FIX.md)', reason: 'github_not_configured' }, 501);
    if (op === 'runs') return json(r, [{ id: 1, title: 'deploy test live-fix/overlay-text r1a2b3c4d5e', status: 'completed', conclusion: 'success', branch: 'live-fix/overlay-text', createdAt: new Date(now - 1200000).toISOString(), url: 'https://github.com/' }, { id: 2, title: 'deploy production main r9f8e7d6c5b', status: 'in_progress', conclusion: null, branch: 'main', createdAt: new Date(now - 60000).toISOString(), url: 'https://github.com/' }]);
    if (op === 'versions') return json(r, { production: { script: 'nesszerra-mini-chat', deployments: [{ id: 'd', createdOn: new Date(now - 60000).toISOString(), message: 'promote #7', versions: [{ versionId: '5d1c9a3e-0000-4000-8000-000000000001', percentage: 90 }, { versionId: '4c0b8a2d-0000-4000-8000-000000000000', percentage: 10 }] }], versions: [{ id: '4c0b8a2d-0000-4000-8000-000000000000', number: 11, tag: 'gh-0a1b2c3-1200', createdOn: new Date(now - 86400000).toISOString() }] }, test: { script: 'nesszerra-mini-chat-test', deployments: [], versions: [], error: 'Cloudflare API error 404' } });
    if (op === 'code/file') return json(r, { path: 'public/overlay.js', ref: 'main', sha: 'a'.repeat(40), size: 120, content: "// overlay\nconst size = 60;\nexport function draw(ctx) {\n  ctx.fillText('hello', 10, 10);\n}\n" });
    if (op === 'code/save') return json(r, { ok: true, path: 'public/overlay.js', branch: 'live-fix/overlay-text', branchCreated: true, sha: 'b'.repeat(40), commit: 'c'.repeat(40) });
    if (op === 'deploy') return json(r, { ok: true, requestId: 'r0123456789' }, 202);
    return json(r, { error: 'unexpected ' + op }, 500);
  });
}
async function open(size, setup) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height } });
  if (setup?.cookie) await ctx.addCookies([{ name: 'mini_session', value: setup.cookie, url: base }]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(size.name + ': ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(size.name + ': ' + m.text()); });
  if (setup?.stub) await stub(page, setup.stub);
  await page.goto(base + '/admin/dev/', { waitUntil: 'networkidle' });
  return { ctx, page };
}
async function noOverflow(page, label) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(wide <= 1, `${label}: page scrolls sideways by ${wide}px`);
}

for (const size of sizes) {
  // 1. Real server, signed out: the gate offers Twitch sign-in and hides the app.
  let { ctx, page } = await open(size);
  assert.match(await page.textContent('#gate-text'), /Sign in with the nesszerra Twitch account/);
  assert.equal(await page.getAttribute('#gate-actions a', 'href'), '/auth/login?next=%2Fadmin%2Fdev%2F', 'signing in comes back to the owner page');
  assert.equal(await page.isVisible('#app'), false);
  await page.screenshot({ path: path.join(shots, `dev-signed-out-${size.name}.png`), fullPage: true });
  await ctx.close();

  // 2. Owner, integrations not configured: actions are disabled and the page says why.
  ({ ctx, page } = await open(size, { stub: { configured: false } }));
  assert.equal(await page.isVisible('#app'), true);
  assert.match(await page.textContent('#summary-title'), /chat offline/);
  assert.match(await page.textContent('#github-missing'), /GITHUB_TOKEN, GITHUB_REPO/);
  assert.equal(await page.isDisabled('#deploy-test'), true);
  assert.equal(await page.isDisabled('#save-file'), true);
  assert.match(await page.textContent('#s-requests-note'), /not configured/);
  assert.equal(await page.$eval('#dev-tools', (d) => d.open), false, 'developer tools start folded');
  assert.equal(await page.locator('#sec-codex, #codex-toggle').count(), 0);
  await noOverflow(page, 'unconfigured ' + size.name);
  await page.screenshot({ path: path.join(shots, `dev-unconfigured-${size.name}.png`), fullPage: true });
  await ctx.close();

  // 3. Owner, everything configured: channel progress, then load, save and deploy in the developer tools.
  ({ ctx, page } = await open(size, { stub: { configured: true } }));
  await page.waitForFunction(() => /channels are on/.test(document.querySelector('#channels-title').textContent));
  assert.equal(await page.textContent('#channels-title'), '3 channels are on, 1 with setup done right now');
  assert.match(await page.textContent('#channels'), /nesszerra.*Built in.*Done.*1 open.*Twitch chat.*1 min ago/s);
  assert.match(await page.textContent('#channels'), /miolafff.*2 of 3 steps.*Not open.*4 of 6 commands working.*2 min ago/s);
  assert.match(await page.textContent('#channels'), /oldstreamer.*On.*0 of 3 steps.*Old key: copy replies again.*never/s);
  assert.equal(await page.getAttribute('#channels a >> nth=2', 'href'), '/admin/?channel=oldstreamer#chat');
  await page.click('a[href="#dev-tools"]');
  assert.equal(await page.$eval('#dev-tools', (d) => d.open), true);
  assert.match(await page.textContent('#s-requests'), /18,234/);
  assert.match(await page.textContent('#runs'), /deploy test live-fix\/overlay-text/);
  assert.match(await page.textContent('#deployments'), /promote #7/);
  await page.fill('#branch', 'live-fix/overlay-text');
  await page.fill('#path', 'public/overlay.js');
  await page.click('#load-file');
  await page.waitForFunction(() => document.querySelector('#editor').value.includes('overlay'));
  await page.click('#save-file');
  await page.waitForFunction(() => /Saved to live-fix\/overlay-text/.test(document.querySelector('#code-status').textContent));
  await page.click('#deploy-test');
  await page.waitForFunction(() => /Test deploy of live-fix\/overlay-text started/.test(document.querySelector('#release-status').textContent));
  page.on('dialog', (d) => d.accept());
  // Channels: invite a streamer, turn an invited channel off, remove an expired invite.
  assert.match(await page.textContent('#channels'), /miolafff.*Built in/s);
  assert.deepEqual(await page.$$eval('#log-channel option', (o) => o.map((x) => x.value)), ['nesszerra', 'miolafff', 'oldstreamer']);
  await page.fill('#invite-login', 'NewStreamer');
  await page.click('#invite-form button[type=submit]');
  await page.waitForSelector('#invite-link-box:not([hidden])');
  assert.match(await page.inputValue('#invite-link'), /\/start\/\?invite=(cd){16}$/);
  assert.match(await page.textContent('#invite-status'), /Send this link to newstreamer/);
  assert.match(await page.textContent('#invites'), /newstreamer.*Waiting/s);
  await page.click('#channels button:has-text("Turn off")');
  await page.waitForFunction(() => /oldstreamer is off/.test(document.querySelector('#invite-status').textContent));
  assert.match(await page.textContent('#channels'), /oldstreamer.*Off.*Turn on/s);
  await page.click('#invites button:has-text("Remove")');
  await page.waitForFunction(() => !/latecomer/.test(document.querySelector('#invites').textContent));
  assert.equal(await page.isVisible('#invite-link-box'), true, 'removing another invite keeps the new link on screen');
  await page.locator('#sec-channels').screenshot({ path: path.join(shots, `dev-channels-${size.name}.png`) });
  await noOverflow(page, 'configured ' + size.name);
  await page.screenshot({ path: path.join(shots, `dev-configured-${size.name}.png`), fullPage: true });
  await ctx.close();
}

if (process.env.MINI_OWNER_COOKIE) {
  // 4. Unstubbed owner session against the local Worker (real Durable Object storage).
  const { ctx, page } = await open(sizes[0], { cookie: process.env.MINI_OWNER_COOKIE });
  assert.equal(await page.isVisible('#app'), true);
  assert.match(await page.textContent('#github-missing'), /GITHUB_TOKEN/);
  assert.match(await page.textContent('#config-version'), /version \d+/);
  assert.match(await page.textContent('#channels'), /nesszerra.*Built in/s);
  await page.screenshot({ path: path.join(shots, 'dev-real-owner-1280.png'), fullPage: true });
  await ctx.close();
}
await browser.close();
assert.deepEqual(errors, [], 'browser errors:\n' + errors.join('\n'));
console.log('dev UI checks passed; screenshots in ' + shots);
