// Local end-to-end check against a running dev server with seeded test sessions (tests/seed-local.mjs).
// Real Worker + Durable Objects, a real relay WebSocket (paired through /api/relay/code + /api/relay/pair),
// and the real overlay/dashboard/admin/dev pages in installed Chrome. Nothing here talks to Twitch or a deployed site.
// Usage: MINI_BASE_URL=http://127.0.0.1:5199 node tests/e2e-local.mjs   (normally run by scripts/test-all.mjs)
import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cookies, users } from './seed-local.mjs';
const base = process.env.MINI_BASE_URL || 'http://127.0.0.1:5173';
const ch = 'nesszerra';
const shots = 'D:/code/2026-10-01/i-ne/outputs/mini-chat/screenshots';
fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[e2e]', ...a);
async function api(path, { cookie, method = 'GET', body } = {}) {
  const headers = { Origin: base };
  if (cookie) headers.Cookie = 'mini_session=' + cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const state = async () => (await api('/api/state/' + ch)).data;
async function until(fn, label, ms = 8000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(150); }
  throw new Error('timed out waiting for ' + label);
}

// Relay client: speaks the CONTRACTS.md section 4 protocol.
let seq = 0;
function relayClient(credential) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/relay/' + ch, { headers: { Authorization: 'Bearer ' + credential } });
  const acks = new Map(), waiters = new Map();
  let beat;
  const ready = new Promise((resolve, reject) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'hello') {
        const send = () => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'heartbeat', twitchConnected: true }));
        send(); beat = setInterval(send, m.heartbeatMs || 10000); resolve(m);
      } else if (m.type === 'ack') { acks.set(m.messageId, m); waiters.get(m.messageId)?.(m); }
    });
    ws.on('error', reject);
    ws.on('unexpected-response', (_q, res) => reject(new Error('relay upgrade refused: ' + res.statusCode)));
  });
  ws.on('close', () => clearInterval(beat));
  const frame = (type, user, text) => ({ type, messageId: 'e2e-' + Date.now() + '-' + (++seq), userId: user.id, username: user.login, displayName: user.displayName, text, timestamp: Date.now() });
  return {
    ws, ready,
    presence(user, text = 'hi') { ws.send(JSON.stringify(frame('presence', user, text))); },
    command(user, text) {
      const f = frame('command', user, text);
      const p = new Promise((resolve, reject) => { waiters.set(f.messageId, resolve); setTimeout(() => reject(new Error('no ack for ' + text)), 5000); });
      ws.send(JSON.stringify(f)); return p;
    },
    kill() { clearInterval(beat); ws.terminate(); },
  };
}

const errors = [];
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
let relay;
try {
  // 0. Seeded sessions: owner and three viewers.
  const sess = await api('/api/session', { cookie: cookies.owner });
  assert.equal(sess.data.owner, true, 'seeded owner session must be the owner (run tests/seed-local.mjs first)');
  for (const action of ['resetAll', 'resetAllRanks']) {   // reruns start from a clean arena and 1000 Elo
    const r = await api('/api/admin/' + ch, { cookie: cookies.owner, method: 'POST', body: { action } });
    assert.equal(r.status, 200, action + ': ' + JSON.stringify(r.data));
  }
  const dave = { id: '900199', login: 'dave_e2e', displayName: 'Dave_E2E' };   // never signs in

  // 1. Profiles through the real dashboard API.
  const saves = { alice: ['toon-ranger', '#22cc88', 'strike'], bob: ['alien-blue', '#3b82f6', 'heavy'], carol: ['toon-robot', '#f59e0b', 'heal'] };
  const saveProfile = async (k) => {   // saving a profile also puts the viewer in the arena
    const [avatar, color, defaultAbility] = saves[k];
    const r = await api('/api/profile/' + ch, { cookie: cookies[k], method: 'POST', body: { avatar, color, defaultAbility } });
    assert.equal(r.status, 200, k + ' profile save: ' + JSON.stringify(r.data));
  };
  await saveProfile('alice'); await saveProfile('bob');
  const noOrigin = await fetch(base + '/api/profile/' + ch, { method: 'POST', headers: { Cookie: 'mini_session=' + cookies.alice, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noOrigin.status, 403, 'mutation without Origin is refused');
  log('profiles saved for alice and bob; cross-origin POST refused');

  // 2. Admin config with optimistic version: maxHp 60, inactivity 10 s. A stale baseVersion gets 409.
  const admin = await api('/api/admin/' + ch, { cookie: cookies.owner });
  assert.equal(admin.status, 200);
  const baseVersion = admin.data.configVersion;
  const patch = await api('/api/admin/' + ch, { cookie: cookies.owner, method: 'POST', body: { action: 'config', patch: { maxHp: 60, inactivityMs: 10000 }, baseVersion, note: 'e2e: short duels' } });
  assert.equal(patch.status, 200, JSON.stringify(patch.data));
  const stale = await api('/api/admin/' + ch, { cookie: cookies.owner, method: 'POST', body: { action: 'config', patch: { maxHp: 70 }, baseVersion, note: 'stale' } });
  assert.equal(stale.status, 409);
  const viewerAdmin = await api('/api/admin/' + ch, { cookie: cookies.alice });
  assert.equal(viewerAdmin.status, 403, 'a viewer without a mod role cannot open admin');
  const hist = (await api('/api/admin/' + ch, { cookie: cookies.owner })).data.history;
  assert.equal(hist[0].note, 'e2e: short duels'); assert.equal(hist[0].actorName, 'nesszerra');
  log('config v' + (baseVersion + 1) + ' saved (maxHp 60, inactivity 10 s); stale save 409; viewer 403');

  // 3. Overlay in Chrome, connected to the real live socket.
  const overlayCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const overlay = await overlayCtx.newPage();
  overlay.on('pageerror', (e) => errors.push('overlay: ' + e.message));
  await overlay.goto(base + '/overlay.html?channel=' + ch + '&arena=1&debug=1&size=64');
  await overlay.waitForFunction(() => window.__arenaDebug?.().revision > 0);
  const dbg = () => overlay.evaluate(() => window.__arenaDebug());
  assert.equal((await dbg()).paused, true, 'no relay yet: overlay sees a paused game');
  const plain = await overlayCtx.newPage();   // without debug the overlay shows the viewer-facing paused text
  await plain.goto(base + '/overlay.html?channel=' + ch + '&arena=1&size=64');
  await plain.waitForFunction(() => /Duels paused/.test(document.querySelector('#status').textContent));

  // 4. Pair a relay with a code minted by the owner.
  const code = await api('/api/relay/code', { cookie: cookies.owner, method: 'POST', body: {} });
  assert.equal(code.status, 200); assert.match(code.data.code, /^[a-f0-9]{64}$/);
  const viewerCode = await api('/api/relay/code', { cookie: cookies.alice, method: 'POST', body: {} });
  assert.equal(viewerCode.status, 403);
  const pair = await api('/api/relay/pair', { method: 'POST', body: { code: code.data.code } });
  assert.equal(pair.status, 200);
  const reuse = await api('/api/relay/pair', { method: 'POST', body: { code: code.data.code } });
  assert.equal(reuse.status, 403, 'pairing code is single use');
  relay = relayClient(pair.data.credential);
  await relay.ready;
  await until(async () => (await state()).relay.connected && !(await state()).paused, 'relay connected');
  log('relay paired (code single-use, viewer cannot mint) and connected after heartbeat');

  // 5. Two viewers chat: two characters appear on the overlay with their saved looks.
  relay.presence(users.alice); relay.presence(users.bob);
  await until(async () => (await state()).players.length === 2, 'two players in state');
  await overlay.waitForFunction(() => window.__arenaDebug().players.length === 2, null, { timeout: 8000 });
  let d = await dbg();
  const pa = d.players.find((p) => p.userId === users.alice.id), pb = d.players.find((p) => p.userId === users.bob.id);
  assert.equal(pa.avatar, 'toon-ranger'); assert.equal(pa.color, '#22cc88'); assert.equal(pb.avatar, 'alien-blue');
  assert.equal(d.paused, false);
  log('overlay shows 2 characters:', d.players.map((p) => p.label + '/' + p.avatar).join(', '));

  // 6. Challenge, accept, attacks with cooldowns, KO.
  let ack = await relay.command(users.alice, '!challenge @bob_e2e');
  assert.equal(ack.ok, true, JSON.stringify(ack));
  await overlay.waitForFunction(() => /challenge/i.test(window.__arenaDebug().announcement || ''), null, { timeout: 5000 });
  ack = await relay.command(users.bob, '!accept');
  assert.equal(ack.ok, true, JSON.stringify(ack));
  let s = await state();
  const duel1 = s.duels.find((x) => x.status === 'active');
  assert.ok(duel1); assert.equal(duel1.rules.maxHp, 60);
  await overlay.waitForFunction(() => window.__arenaDebug().duels.filter((x) => x.status === 'active').length === 1, null, { timeout: 5000 });
  ack = await relay.command(users.alice, '!heavy');
  assert.equal(ack.ok, true);
  ack = await relay.command(users.alice, '!strike');
  assert.equal(ack.ok, false); assert.equal(ack.reason, 'cooldown'); assert.ok(ack.retryAt > Date.now() - 1000, 'cooldown ack carries retryAt');
  const bobHit = await relay.command(users.bob, '!heavy');
  assert.equal(bobHit.ok, true, 'bob can act while alice is on cooldown');
  await overlay.screenshot({ path: shots + '/e2e-overlay-duel-1280.png' });
  await sleep(1100);
  ack = await relay.command(users.alice, '!strike'); assert.equal(ack.ok, true, JSON.stringify(ack));   // bob 60-25-10 = 25
  ack = await relay.command(users.alice, '!strike'); assert.equal(ack.reason, 'cooldown');              // strike 3 s cooldown
  for (const wait of [3100, 3100]) { await sleep(wait); ack = await relay.command(users.alice, '!attack'); assert.equal(ack.ok, true, JSON.stringify(ack)); } // 15, 5
  await sleep(Math.max(0, duel1.startedAt + 8200 - Date.now()));
  let tries = 0;
  do { ack = await relay.command(users.alice, '!heavy'); if (!ack.ok) await sleep(400); } while (!ack.ok && ++tries < 10);
  assert.equal(ack.ok, true, JSON.stringify(ack)); assert.equal(ack.reason, 'duel_completed');
  s = await state();
  const done = s.events.find((e) => e.type === 'duel_completed' && e.duelId === duel1.id);
  assert.ok(done, 'duel_completed event'); assert.equal(done.winnerId, users.alice.id);
  await overlay.waitForFunction(() => /win|KO|defeat/i.test(window.__arenaDebug().announcement || ''), null, { timeout: 5000 });
  d = await dbg();
  assert.equal(d.players.find((p) => p.userId === users.bob.id).ko, true, 'loser shows KO');
  await overlay.screenshot({ path: shots + '/e2e-overlay-ko-1280.png' });
  log('duel KO: alice beat bob; announcement "' + d.announcement + '"');

  // 7. Elo and leaderboard.
  const lb = (await api('/api/leaderboard/' + ch)).data;
  const rows = Array.isArray(lb) ? lb : lb.leaderboard || lb.players;
  const la = rows.find((r) => r.userId === users.alice.id), lbob = rows.find((r) => r.userId === users.bob.id);
  assert.deepEqual([la.elo, la.wins, la.losses], [1012, 1, 0]);
  assert.deepEqual([lbob.elo, lbob.wins, lbob.losses], [988, 0, 1]);
  assert.equal(rows[0].userId, users.alice.id, 'winner tops the leaderboard');
  await overlay.waitForFunction((id) => window.__arenaDebug().players.find((p) => p.userId === id)?.elo === 1012, users.alice.id, { timeout: 5000 });
  log('Elo: alice 1012 (1-0), bob 988 (0-1); leaderboard and overlay updated');

  // 8. Rules: rematch delay, sign-in requirement, busy players, inactivity cancel.
  await sleep(3200);   // respawn
  ack = await relay.command(users.alice, '!duel @bob_e2e'); assert.equal(ack.reason, 'rematch_cooldown'); assert.ok(ack.retryAt);
  relay.presence(dave);
  ack = await relay.command(dave, '!duel @alice_e2e'); assert.equal(ack.reason, 'ranked_sign_in_required');
  await saveProfile('carol'); relay.presence(users.carol);
  ack = await relay.command(users.alice, '!duel @carol_e2e'); assert.equal(ack.ok, true);
  ack = await relay.command(users.bob, '!duel @carol_e2e'); assert.equal(ack.reason, 'player_busy');
  ack = await relay.command(users.carol, '!accept'); assert.equal(ack.ok, true);
  const duel2 = (await state()).duels.find((x) => x.status === 'active');
  log('rematch_cooldown, ranked_sign_in_required, player_busy confirmed; waiting for inactivity cancel');
  const cancelled = await until(async () => (await state()).events.find((e) => e.type === 'duel_cancelled' && e.duelId === duel2.id), 'inactivity cancel', 16000);
  assert.equal(cancelled.reason, 'inactivity');
  log('inactive duel cancelled after 10 s, unscored');

  // 9. Relay drop mid-duel: game pauses, duel cancelled unscored, ranks unchanged.
  const ranks = async () => (await api('/api/leaderboard/' + ch)).data.map((r) => [r.userId, r.elo, r.wins, r.losses]);
  const before = await ranks();
  ack = await relay.command(users.alice, '!duel @carol_e2e'); assert.equal(ack.ok, true, JSON.stringify(ack));
  ack = await relay.command(users.carol, '!accept'); assert.equal(ack.ok, true);
  ack = await relay.command(users.alice, '!strike'); assert.equal(ack.ok, true);
  const duel3 = (await state()).duels.find((x) => x.status === 'active');
  relay.kill();
  const gone = await until(async () => (await state()).events.find((e) => e.type === 'duel_cancelled' && e.duelId === duel3.id), 'relay-drop cancel', 8000);
  assert.equal(gone.reason, 'relay_disconnected');
  s = await state();
  assert.equal(s.paused, true); assert.equal(s.relay.connected, false);
  assert.equal(s.duels.filter((x) => x.status === 'active' || x.status === 'pending').length, 0);
  assert.deepEqual(await ranks(), before, 'ranks unchanged by the cancelled duel');
  await overlay.waitForFunction(() => window.__arenaDebug().paused === true && !window.__arenaDebug().duels.some((x) => x.status === 'active' || x.status === 'pending'), null, { timeout: 5000 });
  await plain.waitForFunction(() => /relay offline/.test(document.querySelector('#status').textContent), null, { timeout: 5000 });
  const status = await plain.locator('#status').textContent();
  log('relay dropped: paused, duel cancelled (relay_disconnected), ranks unchanged; overlay status "' + status.trim() + '"');
  ack = null;

  // 10. Screenshots of every page at 1280 and 390 (real server, seeded sessions).
  const sizes = [{ name: '1280', width: 1280, height: 900 }, { name: '390', width: 390, height: 844 }];
  for (const size of sizes) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(size.name + ' page: ' + e.message));
    await page.goto(base + '/overlay.html?channel=' + ch + '&arena=1&debug=1&size=64');
    await page.waitForFunction(() => window.__arenaDebug?.().revision > 0);
    await page.waitForTimeout(800);
    await page.screenshot({ path: shots + '/e2e-overlay-' + size.name + '.png' });
    await ctx.addCookies([{ name: 'mini_session', value: cookies.alice, url: base }]);
    await page.goto(base + '/');
    await page.waitForFunction(() => !document.querySelector('#leaderboard tbody')?.textContent.includes('Loading'));
    await page.waitForTimeout(500);
    assert.match(await page.locator('#leaderboard').textContent(), /Alice_E2E|alice_e2e/);
    await page.screenshot({ path: shots + '/e2e-dashboard-' + size.name + '.png', fullPage: true });
    await ctx.clearCookies();
    await ctx.addCookies([{ name: 'mini_session', value: cookies.owner, url: base }]);
    await page.goto(base + '/admin/');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: shots + '/e2e-admin-' + size.name + '.png', fullPage: true });
    await page.goto(base + '/admin/dev/');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: shots + '/e2e-dev-' + size.name + '.png', fullPage: true });
    await ctx.close();
  }
  log('screenshots written to ' + shots + '/e2e-*.png');

  // Restore the default balance so reruns start from the same rules.
  const v = (await api('/api/admin/' + ch, { cookie: cookies.owner })).data.configVersion;
  await api('/api/admin/' + ch, { cookie: cookies.owner, method: 'POST', body: { action: 'config', patch: { maxHp: 100, inactivityMs: 60000 }, baseVersion: v, note: 'e2e: restore defaults' } });
  assert.deepEqual(errors, []);
  console.log('E2E PASS');
} finally {
  relay?.kill();
  await browser.close();
}
