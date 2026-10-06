// Local end-to-end check against a running dev server with seeded test sessions (tests/seed-local.mjs).
// Real Worker + Durable Objects, chat delivered as signed Twitch EventSub webhook POSTs to /api/eventsub,
// and the real overlay/dashboard/admin/dev pages in installed Chrome. Nothing here talks to Twitch or a deployed site:
// the dev server runs with MINI_LOCAL_TEST=1, so Connect chat records a local subscription without calling Helix.
// Usage: MINI_BASE_URL=http://127.0.0.1:5199 MINI_AUTH_SECRET=<the dev server's AUTH_SECRET> node tests/e2e-local.mjs
// (normally run by scripts/test-all.mjs, which reads AUTH_SECRET from .dev.vars and never prints it)
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cookies, users } from './seed-local.mjs';
const base = process.env.MINI_BASE_URL || 'http://127.0.0.1:5173';
const ch = 'nesszerra';
const shots = fileURLToPath(new URL('../screenshots', import.meta.url));
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

// Twitch EventSub stand-in: signs exactly like Twitch (HMAC-SHA256 over id + timestamp + body) with the secret
// the Worker derives from AUTH_SECRET. The secret only lives in this process's memory.
if (!process.env.MINI_AUTH_SECRET) throw new Error('MINI_AUTH_SECRET is required (scripts/test-all.mjs passes it from .dev.vars)');
const eventsubSecret = createHmac('sha256', process.env.MINI_AUTH_SECRET).update('mini-chat:eventsub:v1').digest('hex');
let seq = 0, subscriptionId = '';
async function eventsubPost(type, body, { id = 'e2e-' + Date.now() + '-' + (++seq), timestamp = new Date().toISOString(), secret = eventsubSecret } = {}) {
  const raw = JSON.stringify(body);
  const signature = 'sha256=' + createHmac('sha256', secret).update(id + timestamp + raw).digest('hex');
  // like Twitch: no Origin, no cookie
  const res = await fetch(base + '/api/eventsub', { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'Twitch-Eventsub-Message-Id': id, 'Twitch-Eventsub-Message-Timestamp': timestamp,
    'Twitch-Eventsub-Message-Signature': signature, 'Twitch-Eventsub-Message-Type': type, 'Twitch-Eventsub-Subscription-Type': 'channel.chat.message', 'Twitch-Eventsub-Subscription-Version': '1' } });
  return { status: res.status, text: await res.text(), id };
}
const subscription = (status = 'enabled') => ({ id: subscriptionId, status, type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: '1', user_id: '1' }, transport: { method: 'webhook', callback: base + '/api/eventsub' }, created_at: new Date().toISOString() });
const chatMessage = (user, text, messageId = 'chat-' + Date.now() + '-' + (++seq)) => ({ subscription: subscription(), event: { broadcaster_user_id: '1', broadcaster_user_login: ch, broadcaster_user_name: ch,
  chatter_user_id: user.id, chatter_user_login: user.login, chatter_user_name: user.displayName, message_id: messageId, message: { text, fragments: [{ type: 'text', text }] }, message_type: 'text', color: '' } });
async function say(user, text, options) {
  const r = await eventsubPost('notification', chatMessage(user, text), options);
  assert.equal(r.status, 204, 'eventsub notification: ' + r.status + ' ' + r.text);
  return r;
}
// Twitch gets no reply, so a command's outcome is read back from the room event list (rejections are logged there).
async function command(user, text) {
  const before = (await state()).revision;
  await say(user, text);
  const added = (await state()).events.filter((e) => Number(e.id) > before);
  const rejected = added.find((e) => e.type === 'command_rejected' && e.userId === user.id);
  if (rejected) return { ok: false, reason: rejected.reason, retryAt: rejected.retryAt };
  if (!added.length) return { ok: false, reason: 'no_effect' };
  return { ok: true, reason: added.some((e) => e.type === 'duel_completed') ? 'duel_completed' : added.at(-1).type };
}
const presence = (user, text = 'hi') => say(user, text);

const errors = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] /* WebGL on the GPU, not software, with no window */ });
try {
  // 0. Seeded sessions: owner and three viewers.
  const sess = await api('/api/session', { cookie: cookies.owner });
  assert.equal(sess.data.owner, true, 'seeded owner session must be the owner (run tests/seed-local.mjs first)');
  for (const action of ['disconnectChat', 'resetAll', 'resetAllRanks']) {   // reruns start offline, from a clean arena and 1000 Elo
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
  const patch = await api('/api/admin/' + ch, { cookie: cookies.owner, method: 'POST', body: { action: 'config', patch: { maxHp: 60, inactivityMs: 10000, quickDuel: false }, baseVersion, note: 'e2e: short HP duels' } });
  assert.equal(patch.status, 200, JSON.stringify(patch.data));
  const stale = await api('/api/admin/' + ch, { cookie: cookies.owner, method: 'POST', body: { action: 'config', patch: { maxHp: 70 }, baseVersion, note: 'stale' } });
  assert.equal(stale.status, 409);
  const viewerAdmin = await api('/api/admin/' + ch, { cookie: cookies.alice });
  assert.equal(viewerAdmin.status, 403, 'a viewer without a mod role cannot open admin');
  const hist = (await api('/api/admin/' + ch, { cookie: cookies.owner })).data.history;
  assert.equal(hist[0].note, 'e2e: short HP duels'); assert.equal(hist[0].actorName, 'nesszerra');
  log('config v' + (baseVersion + 1) + ' saved (maxHp 60, inactivity 10 s); stale save 409; viewer 403');

  // 3. Overlay in Chrome, connected to the real live socket.
  const overlayCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const overlay = await overlayCtx.newPage();
  overlay.on('pageerror', (e) => errors.push('overlay: ' + e.message));
  await overlay.goto(base + '/overlay.html?channel=' + ch + '&arena=1&debug=1&size=64');
  await overlay.waitForFunction(() => window.__arenaDebug?.().revision > 0);
  const dbg = () => overlay.evaluate(() => window.__arenaDebug());
  assert.equal((await dbg()).paused, true, 'chat not connected yet: overlay sees a paused game');
  const plain = await overlayCtx.newPage();   // without debug the overlay shows no status text on stream
  await plain.goto(base + '/overlay.html?channel=' + ch + '&arena=1&size=64');
  await plain.waitForFunction(() => window.__arenaDebug === undefined && document.readyState === 'complete');
  await plain.waitForTimeout(1500);
  assert.equal(await plain.locator('#status').isHidden(), true, 'paused status stays off stream');

  // 4. Connect chat (owner or mod), then the webhook checks: challenge, bad signature, stale timestamp.
  const viewerConnect = await api('/api/admin/' + ch, { cookie: cookies.alice, method: 'POST', body: { action: 'connectChat' } });
  assert.equal(viewerConnect.status, 403, 'a viewer cannot connect chat');
  const connected = await api('/api/admin/' + ch, { cookie: cookies.owner, method: 'POST', body: { action: 'connectChat' } });
  assert.equal(connected.status, 200, JSON.stringify(connected.data));
  subscriptionId = connected.data.chatStatus.subscriptionId;
  assert.match(subscriptionId, /^local-[a-f0-9]{16}$/, 'local test mode: no Twitch call');
  await until(async () => (await state()).chat.connected && !(await state()).paused, 'chat connected');
  const nonce = 'e2e-challenge-' + Date.now();
  const challenge = await eventsubPost('webhook_callback_verification', { challenge: nonce, subscription: subscription('webhook_callback_verification_pending') });
  assert.deepEqual([challenge.status, challenge.text], [200, nonce]);
  const rev0 = (await state()).revision;
  assert.equal((await eventsubPost('notification', chatMessage(users.alice, 'forged'), { secret: 'not-the-secret' })).status, 403, 'bad signature is refused');
  assert.equal((await eventsubPost('notification', chatMessage(users.alice, 'old'), { timestamp: new Date(Date.now() - 11 * 60000).toISOString() })).status, 403, 'stale timestamp is refused');
  assert.equal((await state()).revision, rev0, 'refused messages change nothing');
  log('chat connected (' + subscriptionId + ', viewer 403); challenge echoed; bad signature 403; stale timestamp 403');

  // 5. Two viewers chat: two characters appear on the overlay with their saved looks.
  await presence(users.alice); await presence(users.bob);
  await until(async () => (await state()).players.length === 2, 'two players in state');
  await overlay.waitForFunction(() => window.__arenaDebug().players.length === 2, null, { timeout: 8000 });
  let d = await dbg();
  const pa = d.players.find((p) => p.userId === users.alice.id), pb = d.players.find((p) => p.userId === users.bob.id);
  assert.equal(pa.avatar, 'toon-ranger'); assert.equal(pa.color, '#22cc88'); assert.equal(pb.avatar, 'alien-blue');
  assert.equal(d.paused, false);
  log('overlay shows 2 characters:', d.players.map((p) => p.label + '/' + p.avatar).join(', '));

  // 6. Challenge, accept, attacks with cooldowns, KO.
  const challengeId = 'chat-challenge-' + Date.now(), challengeBody = chatMessage(users.alice, '!challenge @bob_e2e', challengeId);
  let r0 = (await state()).revision;
  const first = await eventsubPost('notification', challengeBody);
  assert.equal(first.status, 204);
  let s = await state();
  let ack = s.events.some((e) => Number(e.id) > r0 && e.type === 'challenge_created') ? { ok: true } : { ok: false, events: s.events.slice(-3) };
  assert.equal(ack.ok, true, JSON.stringify(ack));
  // Twitch retries: the same Message-Id is ignored, and a new Message-Id for the same chat message is too.
  r0 = s.revision;
  assert.equal((await eventsubPost('notification', challengeBody, { id: first.id })).status, 204);
  assert.equal((await eventsubPost('notification', challengeBody)).status, 204);
  s = await state();
  assert.equal(s.revision, r0, 'replayed message changed nothing');
  assert.equal(s.duels.filter((x) => x.status === 'pending').length, 1, 'still exactly one challenge');
  log('replayed EventSub message ignored (same Message-Id and same chat message_id)');
  await overlay.waitForFunction(() => /challenge/i.test(window.__arenaDebug().announcement || ''), null, { timeout: 5000 });
  ack = await command(users.bob, '!accept');
  assert.equal(ack.ok, true, JSON.stringify(ack));
  s = await state();
  const duel1 = s.duels.find((x) => x.status === 'active');
  assert.ok(duel1); assert.equal(duel1.rules.maxHp, 60);
  await overlay.waitForFunction(() => window.__arenaDebug().duels.filter((x) => x.status === 'active').length === 1, null, { timeout: 5000 });
  ack = await command(users.alice, '!heavy');
  assert.equal(ack.ok, true);
  ack = await command(users.alice, '!strike');
  assert.equal(ack.ok, false); assert.equal(ack.reason, 'cooldown'); assert.ok(ack.retryAt > Date.now() - 1000, 'cooldown ack carries retryAt');
  const bobHit = await command(users.bob, '!heavy');
  assert.equal(bobHit.ok, true, 'bob can act while alice is on cooldown');
  await overlay.screenshot({ path: shots + '/e2e-overlay-duel-1280.png' });
  await sleep(1100);
  ack = await command(users.alice, '!strike'); assert.equal(ack.ok, true, JSON.stringify(ack));   // bob 60-25-10 = 25
  ack = await command(users.alice, '!strike'); assert.equal(ack.reason, 'cooldown');              // strike 3 s cooldown
  for (const wait of [3100, 3100]) { await sleep(wait); ack = await command(users.alice, '!attack'); assert.equal(ack.ok, true, JSON.stringify(ack)); } // 15, 5
  await sleep(Math.max(0, duel1.startedAt + 8200 - Date.now()));
  let tries = 0;
  do { ack = await command(users.alice, '!heavy'); if (!ack.ok) await sleep(400); } while (!ack.ok && ++tries < 10);
  assert.equal(ack.ok, true, JSON.stringify(ack)); assert.equal(ack.reason, 'duel_completed');
  s = await state();
  const done = s.events.find((e) => e.type === 'duel_completed' && e.duelId === duel1.id);
  assert.ok(done, 'duel_completed event'); assert.equal(done.winnerId, users.alice.id);
  await overlay.waitForFunction(() => window.__arenaDebug().banners.some((b) => /wins/.test(b)), null, { timeout: 5000 });
  d = await dbg();
  assert.equal(d.players.find((p) => p.userId === users.bob.id).ko, true, 'loser shows KO');
  await overlay.screenshot({ path: shots + '/e2e-overlay-ko-1280.png' });
  log('duel KO: alice beat bob; banner "' + d.banners.join(' | ') + '"');

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
  ack = await command(users.alice, '!duel @bob_e2e'); assert.equal(ack.reason, 'rematch_cooldown'); assert.ok(ack.retryAt);
  await presence(dave);
  ack = await command(dave, '!duel @alice_e2e'); assert.equal(ack.reason, 'ranked_sign_in_required');
  await saveProfile('carol'); await presence(users.carol);
  ack = await command(users.alice, '!duel @carol_e2e'); assert.equal(ack.ok, true);
  ack = await command(users.bob, '!duel @carol_e2e'); assert.equal(ack.reason, 'player_busy');
  ack = await command(users.carol, '!accept'); assert.equal(ack.ok, true);
  const duel2 = (await state()).duels.find((x) => x.status === 'active');
  log('rematch_cooldown, ranked_sign_in_required, player_busy confirmed; waiting for inactivity cancel');
  const cancelled = await until(async () => (await state()).events.find((e) => e.type === 'duel_cancelled' && e.duelId === duel2.id), 'inactivity cancel', 16000);
  assert.equal(cancelled.reason, 'inactivity');
  log('inactive duel cancelled after 10 s, unscored');

  // 9. Chat disconnected mid-duel: game pauses, duel cancelled unscored, ranks unchanged.
  const ranks = async () => (await api('/api/leaderboard/' + ch)).data.map((r) => [r.userId, r.elo, r.wins, r.losses]);
  const before = await ranks();
  ack = await command(users.alice, '!duel @carol_e2e'); assert.equal(ack.ok, true, JSON.stringify(ack));
  ack = await command(users.carol, '!accept'); assert.equal(ack.ok, true);
  ack = await command(users.alice, '!strike'); assert.equal(ack.ok, true);
  const duel3 = (await state()).duels.find((x) => x.status === 'active');
  const off = await api('/api/admin/' + ch, { cookie: cookies.owner, method: 'POST', body: { action: 'disconnectChat' } });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  const gone = await until(async () => (await state()).events.find((e) => e.type === 'duel_cancelled' && e.duelId === duel3.id), 'chat-disconnect cancel', 8000);
  assert.equal(gone.reason, 'chat_disconnected');
  s = await state();
  assert.equal(s.paused, true); assert.equal(s.chat.connected, false);
  assert.equal(s.duels.filter((x) => x.status === 'active' || x.status === 'pending').length, 0);
  assert.deepEqual(await ranks(), before, 'ranks unchanged by the cancelled duel');
  await overlay.waitForFunction(() => window.__arenaDebug().paused === true && !window.__arenaDebug().duels.some((x) => x.status === 'active' || x.status === 'pending'), null, { timeout: 5000 });
  assert.equal(await plain.locator('#status').isHidden(), true, 'chat offline status stays off stream');
  const status = 'hidden';
  const stray = await command(users.alice, '!duel @carol_e2e');
  assert.equal(stray.ok, false, 'messages for a disconnected subscription are ignored');
  log('chat disconnected: paused, duel cancelled (chat_disconnected), ranks unchanged; overlay status "' + status.trim() + '"');

  // 9b. Reconnect, then Twitch revokes the subscription: paused again and the reason is shown to admins.
  subscriptionId = (await api('/api/admin/' + ch, { cookie: cookies.owner, method: 'POST', body: { action: 'connectChat' } })).data.chatStatus.subscriptionId;
  await until(async () => !(await state()).paused, 'chat reconnected');
  assert.equal((await eventsubPost('revocation', { subscription: subscription('authorization_revoked') })).status, 204);
  await until(async () => (await state()).paused, 'revocation pauses');
  const chatStatus = (await api('/api/admin/' + ch, { cookie: cookies.owner })).data.chatStatus;
  assert.deepEqual([chatStatus.connected, chatStatus.lastRevocationReason], [false, 'authorization_revoked']);
  log('revocation: paused, reason authorization_revoked recorded');
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
    await page.goto(base + '/?channel=nesszerra');
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
  await api('/api/admin/' + ch, { cookie: cookies.owner, method: 'POST', body: { action: 'config', patch: { maxHp: 100, inactivityMs: 45000, quickDuel: true }, baseVersion: v, note: 'e2e: restore defaults' } });
  assert.deepEqual(errors, []);
  console.log('E2E PASS');
} finally {
  await browser.close();
}
