// Live end-to-end check through real Twitch chat and the StreamElements bot, against the deployed site.
// Two headed Chromes with remote debugging, each signed in to Twitch (and to PixFray with a saved fighter):
//   A = the broadcaster (LIVE_A_CDP, default :9333), B = a second account (LIVE_B_CDP, default :9334).
// Both accounts type every command in the channel's popout chat; each bot reply must show in both tabs.
// It refuses to run while the channel is live. The test duels change both accounts' Elo, wins and losses.
// Duel replies must not give the result away: the leaderboard may change only after the overlay announced the winner.
// Run: npm run test:live   (env: LIVE_CHANNEL, LIVE_ORIGIN, LIVE_A_CDP, LIVE_B_CDP, LIVE_SECRETS, LIVE_OUT)
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import site from '../site.config.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHANNEL = (process.env.LIVE_CHANNEL || site.defaultChannel).toLowerCase();
const ORIGIN = process.env.LIVE_ORIGIN || site.origins.production;
const A_CDP = process.env.LIVE_A_CDP || 'http://127.0.0.1:9333';
const B_CDP = process.env.LIVE_B_CDP || 'http://127.0.0.1:9334';
const SECRETS = process.env.LIVE_SECRETS || path.join(root, '..', '..', 'work', 'mini-chat-secrets-prod.json');
const OUT = process.env.LIVE_OUT || path.join(root, '..', '..', 'work', 'live-e2e');
const NOBODY = 'nobody_e2e_404';   // a login with no fighter in any channel
const REPLY_MS = 20_000;
const DUPLICATE_MS = 31_000;   // Twitch drops a repeat of the same text from the same account within 30 s

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
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

// Chat lines as "name: text", without the timestamps some accounts turn on.
async function lines(page, freshOnly = false) {
  return page.$$eval(freshOnly ? '.chat-line__message:not([data-e2e-seen])' : '.chat-line__message', (ns) => ns.map((n) => n.innerText.replace(/\s+/g, ' ').trim().replace(/^\d{1,2}:\d{2}(\s*[AP]M)?\s*/i, '')));
}
const markSeen = (page) => page.$$eval('.chat-line__message', (ns) => ns.forEach((n) => n.setAttribute('data-e2e-seen', '')));

// The popout chat tab is reused between runs and left open, so you can watch it.
async function openChat(cdp) {
  const browser = await chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0];
  const login = (await ctx.cookies('https://www.twitch.tv')).find((c) => c.name === 'login')?.value;
  if (!login) throw new Error('not signed in to Twitch in the Chrome at ' + cdp);
  const url = `https://www.twitch.tv/popout/${CHANNEL}/chat`;
  let page = ctx.pages().find((p) => p.url().startsWith(url)) || await ctx.newPage();
  if (!(await page.goto(url).then(() => true, () => false))) { page = await ctx.newPage(); await page.goto(url); }   // Twitch sometimes refuses to reload an old tab
  await page.bringToFront();
  await page.locator('[data-a-target="chat-input"]').waitFor({ timeout: 30_000 });
  for (let n = -1, i = 0; i < 10; i++) { await sleep(1000); const m = (await lines(page)).length; if (m === n) break; n = m; }   // let recent history load
  return { browser, ctx, page, login, sent: new Map() };
}

let A, B;
const other = (who) => (who === A ? B : A);

// Wait until `page` shows a new line equal to `line` (case-insensitive).
async function waitLine(page, line, ms = 10_000) {
  const want = line.toLowerCase(), end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await lines(page, true)).some((l) => l.toLowerCase() === want)) return true;
    await sleep(500);
  }
  return false;
}

// Post a message as `who` and confirm both tabs show it. Display names here equal logins.
async function post(who, text) {
  const last = who.sent.get(text) || 0;
  if (Date.now() - last < DUPLICATE_MS) await sleep(DUPLICATE_MS - (Date.now() - last));
  await markSeen(A.page); await markSeen(B.page);
  const input = who.page.locator('[data-a-target="chat-input"]');
  await input.click();
  const rules = who.page.locator('button:has-text("Okay, Got It"), button:has-text("I Agree")').first();   // the channel's chat rules, shown once per account
  if (await rules.isVisible({ timeout: 1000 }).catch(() => false)) { await rules.click(); await input.click(); }
  await who.page.keyboard.press('Control+A'); await who.page.keyboard.press('Backspace');
  await who.page.keyboard.insertText(text);
  await who.page.keyboard.press('Enter');
  who.sent.set(text, Date.now());
  const mine = `${who.login}: ${text}`;
  check(await waitLine(who.page, mine, REPLY_MS), `${who.login} "${text}" never appeared in their own chat`);
  check(await waitLine(other(who).page, mine), `${who.login} "${text}" never appeared in ${other(who).login}'s chat`);
}

// Post a command, wait for the StreamElements reply matching `expect` after it, and confirm both tabs show it.
async function say(who, text, expect) {
  await post(who, text);
  const mine = `${who.login}: ${text}`.toLowerCase();
  const end = Date.now() + REPLY_MS;
  let hit = '';
  while (!hit && Date.now() < end) {
    await sleep(700);
    const fresh = await lines(who.page, true);
    const at = fresh.findIndex((l) => l.toLowerCase() === mine);
    hit = fresh.slice(at + 1).filter((l) => /^StreamElements:/i.test(l)).map((l) => l.replace(/^StreamElements:\s*/i, '')).find((l) => expect.test(l)) || '';
  }
  if (!hit) {
    const fresh = await lines(who.page, true);
    throw new Error(`no reply matching ${expect} to ${who.login} "${text}" within ${REPLY_MS / 1000} s; new lines: ${fresh.join(' || ').slice(0, 300) || 'none'}`);
  }
  check(await waitLine(other(who).page, 'StreamElements: ' + hit), `reply "${hit}" never appeared in ${other(who).login}'s chat`);
  return hit;
}

// Open a challenge from `from` to `to`, waiting out a rematch lock, a knocked-out fighter or a stale challenge.
// `texts` are spellings of the same challenge, so a retry never repeats the text Twitch just saw.
async function openChallenge(from, to, texts) {
  const want = new RegExp(`(challenges|wants a rematch with) @${esc(to.login)}!|Rematch in (\\d+) s|still seeing stars|still playing on stream|already fighting`, 'i');
  for (const text of texts) {
    const reply = await say(from, text, want);
    if (/challenges @|wants a rematch with @/i.test(reply)) return reply;
    const wait = /Rematch in (\d+) s/i.exec(reply);
    if (wait) { note(`  waiting ${wait[1]} s for the rematch lock`); await sleep((+wait[1] + 2) * 1000); }
    else if (/seeing stars|still playing on stream/i.test(reply)) await sleep(6000);
    else { await say(to, '!decline', /backs out|nobody has challenged/); await say(from, '!decline', /backs out|nobody has challenged/); }   // clear an old challenge
  }
  throw new Error(`could not open a challenge from ${from.login} to ${to.login}`);
}

const board = async () => (await (await fetch(`${ORIGIN}/api/leaderboard/${CHANNEL}`)).json());
const row = (rows, name) => rows.find((r) => r.username === name.toLowerCase() || r.displayName === name);

// The duel reply names both fighters, challenger first, and never the winner: the stream shows that first.
const FIGHT_ON = /^Fight on: (\S+) vs (\S+)! Watch the stream for the winner\.$/;
const nums = (rows, name) => { const r = row(rows, name); return r ? [r.elo, r.wins, r.losses].join('/') : 'missing'; };

function checkFightOn(result, pre, challenger, accepter) {
  const m = FIGHT_ON.exec(result);
  check(m, 'not a no-spoiler duel reply: ' + result);
  check(m[1].toLowerCase() === challenger.login && m[2].toLowerCase() === accepter.login, `expected ${challenger.login} vs ${accepter.login}: ${result}`);
}

// Right after the reply the board must still show the numbers from before the fight.
async function checkHidden(pre, a, b) {
  const now = await board();
  for (const who of [a, b]) check(nums(now, who.login) === nums(pre, who.login), `${who.login} moved before the stream showed the fight: ${nums(pre, who.login)} → ${nums(now, who.login)}`);
  return `board still ${a.login} ${nums(now, a.login)}, ${b.login} ${nums(now, b.login)}`;
}

// Then it must move once the stream has played the duel: winner up Elo and a win, loser down Elo and a loss,
// and only after the overlay announced the winner.
async function checkReveal(pre, a, b, banners, since) {
  let post, shownAt = 0;
  for (let i = 0; i < 120 && !shownAt; i++) {
    await sleep(500);
    post = await board();
    if (nums(post, a.login) !== nums(pre, a.login)) shownAt = Date.now();
  }
  check(shownAt, 'the leaderboard did not change within 60 s');
  const [w, l] = row(post, a.login).wins > row(pre, a.login).wins ? [a, b] : [b, a];
  const w0 = row(pre, w.login), l0 = row(pre, l.login), w1 = row(post, w.login), l1 = row(post, l.login);
  check(w1.elo > w0.elo && l1.elo < l0.elo, `Elo did not move: winner ${w0.elo}→${w1.elo}, loser ${l0.elo}→${l1.elo}`);
  check(w1.wins === w0.wins + 1 && w1.losses === w0.losses && l1.losses === l0.losses + 1 && l1.wins === l0.wins, 'wins/losses not counted once');
  const banner = (await banners()).find((x) => x.t >= since && x.text.toLowerCase().includes(w.login) && / wins/.test(x.text));
  check(banner, `the overlay never announced ${w.login} as the winner`);
  check(banner.t <= shownAt, `the board showed the result ${banner.t - shownAt} ms before the overlay did`);
  return `overlay "${banner.text}" ${((shownAt - banner.t) / 1000).toFixed(1)} s before the board: ${w.login} ${w0.elo}→${w1.elo}, ${l.login} ${l0.elo}→${l1.elo}`;
}

let local;
try {
  note(`live chat e2e ${stamp} — channel ${CHANNEL}, site ${ORIGIN}`);
  if (await isLive()) { note(`STOP ${CHANNEL} is live; this test only posts while the channel is offline.`); process.exit(2); }
  note(`ok ${CHANNEL} is offline`);
  A = await openChat(A_CDP); B = await openChat(B_CDP);
  check(A.login !== B.login, 'both Chromes are signed in as ' + A.login);
  note(`ok A=${A.login} (${A_CDP}), B=${B.login} (${B_CDP})`);
  const start = await board();
  for (const who of [A, B]) check(row(start, who.login)?.registered, `${who.login} has no saved fighter; sign in at ${ORIGIN}/?channel=${CHANNEL} and save one`);
  note('ok both accounts have a saved fighter');

  // A headless overlay with its debug hook, to see who walks in and which duels it plays.
  local = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const overlay = await local.newPage({ viewport: { width: 1280, height: 720 } });
  const overlayErrors = [];
  overlay.on('pageerror', (e) => overlayErrors.push(e.message));
  // The overlay reads chat over anonymous Twitch IRC; watch its frames to tell a slow join from a missed message.
  const irc = { joined: false, lines: [] };
  overlay.on('websocket', (ws) => {
    if (!/irc-ws\.chat\.twitch\.tv/.test(ws.url())) return;
    ws.on('framereceived', (f) => { const s = String(f.payload); if (/ JOIN #/.test(s)) irc.joined = true; if (/ PRIVMSG #/.test(s)) irc.lines.push(s); });
  });
  await overlay.goto(`${ORIGIN}/overlay.html?channel=${CHANNEL}&arena=1&debug=1`);
  await overlay.waitForFunction(() => typeof window.__arenaDebug === 'function', null, { timeout: 20_000 });
  const arena = () => overlay.evaluate(() => window.__arenaDebug());
  // Replays leave the debug list once played, so note every duel id the overlay starts.
  // Winner banners also last only seconds, so keep each one with the time it first showed.
  await overlay.evaluate(() => {
    window.__e2eReplays = new Set(); window.__e2eBanners = [];
    setInterval(() => {
      const d = window.__arenaDebug();
      d.replays.forEach((r) => window.__e2eReplays.add(r.id));
      for (const text of d.banners) if (!window.__e2eBanners.some((b) => b.text === text && Date.now() - b.t < 5000)) window.__e2eBanners.push({ text, t: Date.now() });
    }, 100);
  });
  const banners = () => overlay.evaluate(() => window.__e2eBanners);
  const { config } = await (await fetch(`${ORIGIN}/api/state/${CHANNEL}`)).json();

  // Chatting brings the fighter onto the overlay, in the saved look.
  await step(`${B.login} chats and walks onto the overlay in their saved look`, async () => {
    for (let i = 0; i < 40 && !irc.joined; i++) await sleep(500);
    check(irc.joined, 'the overlay did not join Twitch chat within 20 s');
    await post(B, `e2e check ${stamp.slice(11, 19)}`);
    const saved = row(start, B.login);
    let p;
    for (let i = 0; i < 30 && !p; i++) { await sleep(500); p = (await arena()).players.find((x) => x.label?.toLowerCase().includes(B.login)); }
    const heard = irc.lines.some((s) => s.includes(`:${B.login}!`));
    check(p, `not on the overlay after 15 s (the overlay ${heard ? 'got' : 'never got'} the chat line; on screen: ${(await arena()).players.map((x) => x.label).join(', ') || 'nobody'})`);
    // A viewer the arena doesn't list yet walks in random, then the batched /api/looks answer (~1 s) dresses them.
    const dressed = (x) => x?.avatar === saved.avatar && x.color?.toLowerCase() === saved.color.toLowerCase();
    for (let i = 0; i < 12 && !dressed(p); i++) { await sleep(500); p = (await arena()).players.find((x) => x.label?.toLowerCase().includes(B.login)) || p; }
    check(dressed(p), `shows ${p.avatar} ${p.color} after 6 s, saved ${saved.avatar} ${saved.color}`);
    return `${p.avatar} ${p.color}`;
  });

  // Every read command from both accounts.
  for (const who of [A, B]) {
    await step(`${who.login}: !fray`, () => say(who, '!fray', /^PixFray duels: gear up at \S+, then name your rival with !challenge @name\. They answer !fight\. Again\? !rematch$/));
    await step(`${who.login}: !elo`, () => say(who, '!elo', new RegExp(`^${esc(who.login)}: \\d+ Elo, rank \\d+ of \\d+`, 'i')));
    await step(`${who.login}: !elo @${other(who).login}`, () => say(who, `!elo @${other(who).login}`, new RegExp(`^${esc(other(who).login)}: \\d+ Elo, rank`, 'i')));
    await step(`${who.login}: !ranks lists both accounts`, async () => {
      const r = await say(who, '!ranks', /^Top \d+:/);
      check(r.toLowerCase().includes(A.login) && r.toLowerCase().includes(B.login), 'both accounts not in: ' + r);
      return r;
    });
  }
  await step(`${B.login}: !elo for a viewer with no fighter`, () => say(B, `!elo ${NOBODY}`, new RegExp(`^@${NOBODY} has no fighter in the arena yet! Send them to`)));

  // Refusals.
  await step(`${B.login}: !challenge with no name`, () => say(B, '!challenge', /^Challenge who\? Name your rival: !challenge @name$/));
  await step(`${A.login}: !challenge themselves`, () => say(A, `!challenge @${A.login}`, /can't fight your own shadow/));
  await step(`${A.login}: !challenge a viewer with no fighter`, () => say(A, `!challenge @${NOBODY}`, new RegExp(`^@${NOBODY} has no fighter in the arena yet!`)));
  await step(`${A.login}: !fight with nothing pending`, () => say(A, '!fight', new RegExp(`^${esc(A.login)}, nobody has challenged you yet`, 'i')));
  await step(`${B.login}: !decline with nothing pending`, () => say(B, '!decline', new RegExp(`^${esc(B.login)}, nobody has challenged you yet`, 'i')));

  // A challenge that is refused every wrong way, then declined.
  await step(`${A.login} challenges twice (busy), ${B.login} names the wrong challenger, then declines`, async () => {
    await openChallenge(A, B, [`!challenge @${B.login}`, `!challenge ${B.login}`, `!challenge @${B.login.toUpperCase()}`]);
    await say(A, `!challenge ${B.login.toUpperCase()}`, /^One of you is already fighting!/);
    await say(B, `!fight @${NOBODY}`, new RegExp(`^${esc(B.login)}, nobody has challenged you yet`, 'i'));
    return say(B, `!decline @${A.login}`, new RegExp(`^${esc(B.login)} backs out of the duel\\.$`, 'i'));
  });

  // Duel 1: B challenges, A accepts by naming the challenger. Chat gets no result until the stream has shown it.
  let duels = 0, pre1, since1;
  await step(`${B.login} challenges, ${A.login} answers !fight @${B.login}, and chat gets no result`, async () => {
    pre1 = await board(); since1 = Date.now();
    await openChallenge(B, A, [`!challenge @${A.login}`, `!challenge ${A.login}`, `!challenge @${A.login.toUpperCase()}`]);
    const result = await say(A, `!fight @${B.login}`, FIGHT_ON);
    duels++;
    checkFightOn(result, pre1, B, A);
    return `${result} — ${await checkHidden(pre1, A, B)}`;
  });
  await step(`${B.login}: !elo before the stream shows the fight gives the old Elo`, () =>
    say(B, '!elo', new RegExp(`^${esc(B.login)}: ${row(pre1, B.login).elo} Elo, rank \\d+ of \\d+, ${row(pre1, B.login).wins} wins? and ${row(pre1, B.login).losses} loss(es)?\\.$`, 'i')));
  // Right after the duel the loser may still be knocked out (respawnMs); naming them would give the result away.
  await step('an instant re-challenge names nobody as knocked out', () =>
    say(A, `!challenge ${B.login}`, /^That fight is still playing on stream\. Give it a few seconds!$|^Rematch in \d+ s/));
  await step('a rematch inside the lock is held back', async () => {
    await sleep(config.respawnMs + 1000);
    return say(A, `!challenge @${B.login}`, /^Rematch in \d+ s! Catch your breath first\.$/);
  });
  await step('duel 1: the board shows the result only after the overlay announced it', () => checkReveal(pre1, A, B, banners, since1));

  // Duel 2: both name each other, which starts the duel without !fight.
  await step(`${A.login} and ${B.login} challenge each other, and chat gets no result`, async () => {
    const pre = await board(), since = Date.now();
    await openChallenge(A, B, [`!challenge @${B.login.toUpperCase()}`, `!challenge ${B.login.toUpperCase()}`, `!challenge @${B.login}`]);
    const result = await say(B, `!challenge @${A.login}`, FIGHT_ON);
    duels++;
    checkFightOn(result, pre, A, B);
    const hidden = await checkHidden(pre, A, B);
    return `${result} — ${hidden}; ${await checkReveal(pre, A, B, banners, since)}`;
  });

  // Duel 3: !rematch names nobody; it finds the last opponent, and a !rematch back starts the duel.
  await step(`${B.login} and ${A.login} both type !rematch, and chat gets no result`, async () => {
    const pre = await board(), since = Date.now();
    await openChallenge(B, A, ['!rematch', '!rematch now', `!rematch @${A.login}`]);
    const result = await say(A, '!rematch', FIGHT_ON);
    duels++;
    checkFightOn(result, pre, B, A);
    const hidden = await checkHidden(pre, A, B);
    return `${result} — ${hidden}; ${await checkReveal(pre, A, B, banners, since)}`;
  });

  await step('the overlay played every duel without page errors', async () => {
    await overlay.screenshot({ path: path.join(OUT, `${stamp}-overlay.png`) });
    const shown = await overlay.evaluate(() => window.__e2eReplays.size);
    check(shown >= duels, `${shown} replays for ${duels} duels`);
    check(!overlayErrors.length, overlayErrors.join('; '));
    return `${shown} replays`;
  });

  // A challenge left unanswered expires after the timeout.
  await step('an unanswered challenge expires', async () => {
    await openChallenge(A, B, [`!challenge @${B.login}`, `!challenge ${B.login}`, `!challenge @${B.login.toUpperCase()}`]);
    note(`  waiting ${config.challengeTimeoutMs / 1000 + 3} s for the challenge to expire`);
    await sleep(config.challengeTimeoutMs + 3000);
    return say(B, '!fight', new RegExp(`^${esc(B.login)}, nobody has challenged you yet`, 'i'));
  });

  await step('a malformed key is refused before the room', async () => {
    const t = await (await fetch(`${ORIGIN}/api/se/${CHANNEL}/elo?k=bad&u=x`)).text();
    check(/wrong key/.test(t), t);
  });

  await step('Stream setup shows every command working', async () => {
    // Same-origin fetch from a PixFray page in Chrome A, which holds the broadcaster's session.
    const admin = await A.ctx.newPage();
    try {
      await admin.goto(`${ORIGIN}/admin/?channel=${CHANNEL}`);
      const snap = await admin.evaluate((u) => fetch(u).then((r) => (r.ok ? r.json() : { status: r.status })), `/api/admin/${CHANNEL}`);
      check(snap.streamelements, `admin answered ${snap.status || 'without streamelements'} (is Chrome A signed in to PixFray?)`);
      const seen = snap.streamelements.seen || {};
      const stale = ['challenge', 'accept', 'decline', 'rematch', 'top', 'elo', 'help'].filter((a) => !(Date.now() - (seen[a] || 0) < 3600_000));
      check(!stale.length, 'not seen in the last hour: ' + stale.join(', '));
      return 'all 7 seen';
    } finally { await admin.close(); }
  });
} catch (e) {
  failed++; note('FAIL setup — ' + e.message);
} finally {
  for (const who of [A, B].filter(Boolean)) await who.page.screenshot({ path: path.join(OUT, `${stamp}-chat-${who.login}.png`) }).catch(() => {});
  await local?.close().catch(() => {});
  fs.writeFileSync(path.join(OUT, `${stamp}.log`), log.join('\n') + '\n');
  note(`${failed ? 'FAILED' : 'PASSED'} — log ${path.join(OUT, stamp + '.log')}`);
  process.exit(failed ? 1 : 0);
}
