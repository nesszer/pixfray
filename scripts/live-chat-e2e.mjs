// Live end-to-end check through real Twitch chat and the StreamElements bot, against the deployed site.
// Two headed Chromes with remote debugging, each signed in to Twitch (and to Mini Chat with a saved fighter):
//   A = the broadcaster (LIVE_A_CDP, default :9333), B = a second account (LIVE_B_CDP, default :9334).
// It types commands in the channel's popout chat and reads the bot's replies, then checks the public leaderboard.
// It refuses to run while the channel is live. A test duel changes both accounts' Elo, wins and losses.
// Run: npm run test:live   (env: LIVE_CHANNEL, LIVE_ORIGIN, LIVE_A_CDP, LIVE_B_CDP, LIVE_SECRETS, LIVE_OUT)
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHANNEL = (process.env.LIVE_CHANNEL || 'nesszerra').toLowerCase();
const ORIGIN = process.env.LIVE_ORIGIN || 'https://chat.miolaf.xyz';
const A_CDP = process.env.LIVE_A_CDP || 'http://127.0.0.1:9333';
const B_CDP = process.env.LIVE_B_CDP || 'http://127.0.0.1:9334';
const SECRETS = process.env.LIVE_SECRETS || path.join(root, '..', '..', 'work', 'mini-chat-secrets-prod.json');
const OUT = process.env.LIVE_OUT || path.join(root, '..', '..', 'work', 'live-e2e');
const REPLY_MS = 20_000;

fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const log = [];
const note = (s) => { console.log(s); log.push(s); };
let failed = 0;
async function step(name, fn) {
  try { const detail = await fn(); note(`PASS ${name}${detail ? ' — ' + detail : ''}`); return true; }
  catch (e) { failed++; note(`FAIL ${name} — ${e.message}`); return false; }
}
const check = (ok, msg) => { if (!ok) throw new Error(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The channel must be offline: posts in a live chat would show on stream.
async function isLive() {
  const s = JSON.parse(fs.readFileSync(SECRETS, 'utf8'));
  const id = s.TWITCH_CLIENT_ID, secret = s.TWITCH_CLIENT_SECRET;
  if (!id || !secret) throw new Error('no Twitch client id/secret in ' + SECRETS);
  const tok = await (await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }) })).json();
  if (!tok.access_token) throw new Error('Twitch app token refused');
  const r = await (await fetch('https://api.twitch.tv/helix/streams?user_login=' + CHANNEL, { headers: { 'Client-Id': id, Authorization: 'Bearer ' + tok.access_token } })).json();
  if (!Array.isArray(r.data)) throw new Error('Twitch streams lookup failed');
  return r.data.length > 0;
}

async function openChat(cdp) {
  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0];
  const login = (await ctx.cookies('https://www.twitch.tv')).find((c) => c.name === 'login')?.value;
  if (!login) throw new Error('not signed in to Twitch in the Chrome at ' + cdp);
  const page = await ctx.newPage();
  await page.goto(`https://www.twitch.tv/popout/${CHANNEL}/chat`);
  await page.locator('[data-a-target="chat-input"]').waitFor({ timeout: 30_000 });
  for (let n = -1, i = 0; i < 10; i++) { await sleep(1000); const m = (await lines(page)).length; if (m === n) break; n = m; }   // let recent history load
  return { browser, page, login };
}

// Chat lines as "name: text", without the timestamps some accounts turn on.
async function lines(page, freshOnly = false) {
  return page.$$eval(freshOnly ? '.chat-line__message:not([data-e2e-seen])' : '.chat-line__message', (ns) => ns.map((n) => n.innerText.replace(/\s+/g, ' ').trim().replace(/^\d{1,2}:\d{2}(\s*[AP]M)?\s*/i, '')));
}

// Post a message as this account, then wait for a StreamElements line after it that matches `expect`.
// Lines already on screen are marked first, and replies count only after this account's new line.
async function say(who, text, expect) {
  const input = who.page.locator('[data-a-target="chat-input"]');
  await input.click();
  const rules = who.page.locator('button:has-text("Okay, Got It"), button:has-text("I Agree")').first();   // the channel's chat rules, shown once per account
  if (await rules.isVisible({ timeout: 1000 }).catch(() => false)) { await rules.click(); await input.click(); }
  await who.page.keyboard.press('Control+A'); await who.page.keyboard.press('Backspace');
  await who.page.$$eval('.chat-line__message', (ns) => ns.forEach((n) => n.setAttribute('data-e2e-seen', '')));
  await who.page.keyboard.insertText(text);
  await who.page.keyboard.press('Enter');
  const mine = `${who.login}: ${text}`.toLowerCase();
  const end = Date.now() + REPLY_MS;
  while (Date.now() < end) {
    await sleep(700);
    const fresh = await lines(who.page, true);
    const at = fresh.findIndex((l) => l.toLowerCase() === mine);
    if (at < 0) continue;
    const hit = fresh.slice(at + 1).filter((l) => /^StreamElements:/i.test(l)).map((l) => l.replace(/^StreamElements:\s*/i, '')).find((l) => expect.test(l));
    if (hit) return hit;
  }
  const fresh = await lines(who.page, true);
  const posted = fresh.some((l) => l.toLowerCase() === mine);
  throw new Error(`${posted ? 'no reply matching ' + expect : 'message never appeared in chat'} for ${who.login} "${text}" within ${REPLY_MS / 1000} s; new lines: ${fresh.join(' || ').slice(0, 300) || 'none'}`);
}

const board = async () => (await (await fetch(`${ORIGIN}/api/leaderboard/${CHANNEL}`)).json());

let A, B, overlay;
try {
  note(`live chat e2e ${stamp} — channel ${CHANNEL}, site ${ORIGIN}`);
  if (await isLive()) { note(`STOP ${CHANNEL} is live; this test only posts while the channel is offline.`); process.exit(2); }
  note(`ok ${CHANNEL} is offline`);
  A = await openChat(A_CDP); B = await openChat(B_CDP);
  check(A.login !== B.login, 'both Chromes are signed in as ' + A.login);
  note(`ok A=${A.login} (${A_CDP}), B=${B.login} (${B_CDP})`);

  // A headless overlay, so the duel is drawn and the KO frame is saved.
  const local = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  overlay = await local.newPage({ viewport: { width: 1280, height: 720 } });
  const overlayErrors = [];
  overlay.on('pageerror', (e) => overlayErrors.push(e.message));
  await overlay.goto(`${ORIGIN}/overlay.html?channel=${CHANNEL}&arena=1`);

  await step('!minichat explains how to play', () => say(A, '!minichat', /Mini Chat duels/));
  await step('!elo answers for B', () => say(B, '!elo', new RegExp(B.login + '[^:]*: \\d+ Elo', 'i')));
  await step('!ranks lists the top', () => say(A, '!ranks', /^Top \d+:/));
  await step('!challenge with no name asks who', () => say(A, '!challenge', /Challenge who\?/));
  await step('!fight with nothing pending', () => say(B, '!fight', /nobody has challenged you yet/));

  const pre = await board();
  const find = (rows, login) => rows.find((r) => r.username === login);
  await step('both accounts have a saved fighter', () => {
    check(find(pre, A.login)?.registered && find(pre, B.login)?.registered, `missing fighter: ${[A.login, B.login].filter((l) => !find(pre, l)?.registered).join(', ')} (sign in at ${ORIGIN}/?channel=${CHANNEL} and save)`);
  });

  await step('challenge, then decline', async () => {
    await say(A, `!challenge @${B.login}`, new RegExp(`challenges @${B.login}`, 'i'));
    return say(B, '!decline', /backs out of the duel/);
  });

  let result = '';
  const fought = await step('challenge, fight, result', async () => {
    let reply = await say(A, `!challenge ${B.login}`, new RegExp(`challenges @${B.login}|Rematch in (\\d+) s`, 'i'));
    const wait = /Rematch in (\d+) s/i.exec(reply);
    if (wait) { await sleep((+wait[1] + 2) * 1000); reply = await say(A, `!challenge @${B.login.toUpperCase()}`, new RegExp(`challenges @${B.login}`, 'i')); }
    result = await say(B, '!fight', /(beats|knocked out) .+ Elo: /);
    return result;
  });

  if (fought) {
    await sleep(6000);   // let the overlay play the rolls
    await overlay.screenshot({ path: path.join(OUT, `${stamp}-overlay.png`) });
    await step('leaderboard matches the result line', async () => {
      const m = /^(\S+) (?:beats|knocked out) (\S+) .*Elo: \S+ (\d+), \S+ (\d+)\./.exec(result);
      check(m, 'could not read the result line');
      const [, wn, ln, we, le] = m;
      const post = await board();
      const w = post.find((r) => r.displayName === wn || r.username === wn.toLowerCase()), l = post.find((r) => r.displayName === ln || r.username === ln.toLowerCase());
      const w0 = find(pre, w.username), l0 = find(pre, l.username);
      check(w.elo === +we && l.elo === +le, `Elo ${w.elo}/${l.elo} vs reply ${we}/${le}`);
      check(w.elo > w0.elo && l.elo < l0.elo, `Elo did not move: winner ${w0.elo}→${w.elo}, loser ${l0.elo}→${l.elo}`);
      check(w.wins === w0.wins + 1 && l.losses === l0.losses + 1, 'wins/losses not counted');
      return `${w.username} ${w0.elo}→${w.elo}, ${l.username} ${l0.elo}→${l.elo}`;
    });
    await step('overlay had no page errors', () => check(!overlayErrors.length, overlayErrors.join('; ')));
  }

  await step('malformed key is refused before the room', async () => {
    const t = await (await fetch(`${ORIGIN}/api/se/${CHANNEL}/elo?k=bad&u=x`)).text();
    check(/wrong key/.test(t), t);
  });

  await step('Stream setup shows every command working', async () => {
    // Same-origin fetch from a Mini Chat page in Chrome A, which holds the broadcaster's session.
    const admin = await A.page.context().newPage();
    try {
      await admin.goto(`${ORIGIN}/admin/?channel=${CHANNEL}`);
      const snap = await admin.evaluate((u) => fetch(u).then((r) => (r.ok ? r.json() : { status: r.status })), `/api/admin/${CHANNEL}`);
      check(snap.streamelements, `admin answered ${snap.status || 'without streamelements'} (is Chrome A signed in to Mini Chat?)`);
      const seen = snap.streamelements.seen || {};
      const stale = ['challenge', 'accept', 'decline', 'top', 'elo', 'help'].filter((a) => !(Date.now() - (seen[a] || 0) < 3600_000));
      check(!stale.length, 'not seen in the last hour: ' + stale.join(', '));
      return 'all 6 seen';
    } finally { await admin.close(); }
  });
  await local.close();
} catch (e) {
  failed++; note('FAIL setup — ' + e.message);
} finally {
  await A?.page.close().catch(() => {}); await B?.page.close().catch(() => {});
  fs.writeFileSync(path.join(OUT, `${stamp}.log`), log.join('\n') + '\n');
  note(`${failed ? 'FAILED' : 'PASSED'} — log ${path.join(OUT, stamp + '.log')}`);
  process.exit(failed ? 1 : 0);
}
