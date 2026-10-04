#!/usr/bin/env node
// Test-site tooling: bot fighters, scripted duels and an alt account in real Twitch chat. See docs/DEVTOOLS.md.
// Talks only to the test site (DEV_TOOLS_TOKEN exists only there) and posts to Twitch chat only while the channel is offline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRETS = path.join(ROOT, '.secrets.local.json');   // DEV_TOOLS_TOKEN, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET
const ALT_FILE = path.join(ROOT, '.devtools.local.json'); // alt account tokens from `login`; gitignored
const BASE = (process.env.MINI_DEVTOOLS_BASE || 'https://test.chat.miolaf.xyz').replace(/\/$/, '');
const BOT_LETTERS = 'abcd';

const argv = process.argv.slice(2);
const flags = {}, args = [];
for (let i = 0; i < argv.length; i++) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
  if (!m) args.push(argv[i]);
  else if (m[2] !== undefined) flags[m[1]] = m[2];
  else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[m[1]] = argv[++i];
  else flags[m[1]] = true;
}
const command = args.shift() || 'help';
const CHANNEL = String(flags.channel || 'nesszerra').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) { console.error('devtools: ' + message); process.exit(1); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function secrets() {
  const s = readJson(SECRETS) || {};
  return { ...s, DEV_TOOLS_TOKEN: process.env.DEV_TOOLS_TOKEN || s.DEV_TOOLS_TOKEN };
}
if (/^https:\/\/chat\.miolaf\.xyz$/.test(BASE)) fail('refusing to run against production; devtools are test-site only');

// ---- test site API (dev token) ----
async function site(pathname, { method = 'GET', body } = {}) {
  const token = secrets().DEV_TOOLS_TOKEN;
  if (!token) fail(`DEV_TOOLS_TOKEN not found in ${path.basename(SECRETS)} or the environment`);
  const res = await fetch(BASE + pathname, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) fail(`${method} ${pathname} -> ${res.status} ${typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data)}`);
  return data;
}
const bot = (letter) => ({ userId: 'testbot:' + letter, username: 'testbot_' + letter, displayName: 'testbot_' + letter });
function botByName(name) {
  const m = /^(?:@?testbot_)?([a-d])$/i.exec(String(name || ''));
  if (!m) fail(`unknown bot "${name}"; use testbot_a … testbot_d`);
  return bot(m[1].toLowerCase());
}
async function state() { return site(`/api/state/${CHANNEL}`); }

// One chat line as a bot. --via chat (default) runs it through the room like a Twitch message;
// --via se goes through the public StreamElements route, exactly as the StreamElements bot calls it.
async function say(who, line, via = flags.via || 'chat') {
  if (via === 'se') return seCall(who, line);
  const r = await site(`/api/devtools/${CHANNEL}/chat`, { method: 'POST', body: { ...who, text: line } });
  return r.reply || r.reason || '';
}
let seKey = null;
async function seCall(who, line) {
  const m = /^!(\w+)(?:\s+(\S+))?/.exec(line.trim());
  if (!m) fail(`not a command: ${line}`);
  if (!seKey) {
    const admin = await site(`/api/admin/${CHANNEL}`);
    seKey = admin.streamelements?.key;
    if (!seKey) fail('StreamElements is not set up on the test site for ' + CHANNEL + '; use --via chat');
  }
  const action = { duel: 'challenge', fight: 'accept' }[m[1].toLowerCase()] || m[1].toLowerCase();
  const q = new URLSearchParams({ k: seKey, id: who.userId, u: who.username, d: who.displayName, t: m[2] || '', m: 'devtools-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) });
  const res = await fetch(`${BASE}/api/se/${CHANNEL}/${action}?${q}`);
  return (await res.text()).trim();
}

async function seed() {
  const n = Math.max(2, Math.min(4, Number(flags.bots) || 2));
  const catalog = await site(`/api/catalog/${CHANNEL}`);
  const avatars = (Array.isArray(catalog) ? catalog : catalog.characters || []).map((c) => c.id);
  const colors = ['#4FA3FF', '#FF7A45', '#5AD17A', '#C77DFF'], abilities = ['strike', 'heavy', 'heal', 'strike'];
  for (let i = 0; i < n; i++) {
    const b = bot(BOT_LETTERS[i]);
    await site(`/api/devtools/${CHANNEL}/profile`, { method: 'POST', body: { ...b, avatar: avatars[(i * 3) % avatars.length] || 'player', color: colors[i], defaultAbility: abilities[i] } });
    await say(b, 'hi', 'chat'); // a plain line puts the bot in the arena so it can be challenged
    console.log(`seeded ${b.username} (${b.userId})`);
  }
}

async function clean() {
  const s = await state();
  const bots = s.players.filter((p) => String(p.userId).startsWith('testbot:')).map((p) => p.userId);
  const ids = new Set([...bots, ...BOT_LETTERS.split('').map((l) => bot(l).userId)]);
  for (const userId of ids) await site(`/api/admin/${CHANNEL}`, { method: 'POST', body: { action: 'removePlayer', userId } });
  console.log('removed test bots and their profiles from ' + CHANNEL);
}

async function duel() {
  const [a, b] = [botByName(args[0] || 'a'), botByName(args[1] || 'b')];
  console.log(`${a.username}: !challenge @${b.username}\n  -> ${await say(a, '!challenge @' + b.username)}`);
  await sleep(Number(flags.wait) || 1500);
  console.log(`${b.username}: !fight\n  -> ${await say(b, '!fight')}`);
}

// Pretend live state for !checkin: on (a new stream id each time unless --stream), off, or real (ask Twitch).
async function live() {
  const mode = args[0] || 'on';
  if (!['on', 'off', 'real'].includes(mode)) fail('usage: live on|off|real [--stream id]');
  const body = mode === 'real' ? { live: null } : { live: mode === 'on', ...(flags.stream ? { streamId: String(flags.stream) } : {}) };
  const r = await site(`/api/devtools/${CHANNEL}/live`, { method: 'POST', body });
  console.log(mode === 'real' ? `${CHANNEL}: live check goes to Twitch again` : `${CHANNEL}: ${r.live ? 'live, stream ' + r.streamId : 'offline'}`);
}

async function show() {
  const s = await state();
  console.log(`${CHANNEL} rev ${s.revision} | chat ${s.chat?.status} | paused ${s.paused} | quickDuel ${s.config?.quickDuel}`);
  for (const p of s.players) console.log(`  ${p.username.padEnd(25)} ${String(p.userId).padEnd(14)} hp ${p.hp} elo ${p.elo} (${p.wins}-${p.losses})`);
  for (const d of s.duels.filter((x) => !['cancelled', 'expired', 'completed'].includes(x.status))) console.log(`  duel ${d.id} ${d.status} ${d.a} vs ${d.b}`);
}

// ---- alt account: Twitch device code sign-in and chat ----
const TWITCH_SCOPES = 'user:write:chat';
async function twitchForm(url, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
function twitchApp() {
  const s = secrets();
  if (!s.TWITCH_CLIENT_ID) fail(`TWITCH_CLIENT_ID not found in ${path.basename(SECRETS)}`);
  return { id: s.TWITCH_CLIENT_ID, secret: s.TWITCH_CLIENT_SECRET };
}
async function helix(pathname, token, init = {}) {
  const res = await fetch('https://api.twitch.tv/helix' + pathname, { ...init, headers: { Authorization: 'Bearer ' + token, 'Client-Id': twitchApp().id, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
function saveAlt(alt) { fs.writeFileSync(ALT_FILE, JSON.stringify({ alt }, null, 2) + '\n'); }

async function login() {
  const app = twitchApp();
  const start = await twitchForm('https://id.twitch.tv/oauth2/device', { client_id: app.id, scopes: TWITCH_SCOPES });
  if (start.status !== 200) fail('device code request failed: ' + JSON.stringify(start.data));
  const { device_code, user_code, verification_uri, interval = 5, expires_in = 1800 } = start.data;
  console.log(`Sign in with the ALT account (not your main):\n  ${verification_uri}\n  code: ${user_code}\nWaiting…`);
  const until = Date.now() + expires_in * 1000;
  let withSecret = false;
  while (Date.now() < until) {
    await sleep(interval * 1000);
    const params = { client_id: app.id, scopes: TWITCH_SCOPES, device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', ...(withSecret ? { client_secret: app.secret } : {}) };
    const r = await twitchForm('https://id.twitch.tv/oauth2/token', params);
    if (r.status === 200) {
      const me = await helix('/users', r.data.access_token);
      const user = me.data.data?.[0];
      if (!user) fail('signed in, but could not read the account');
      saveAlt({ access_token: r.data.access_token, refresh_token: r.data.refresh_token, expires_at: Date.now() + r.data.expires_in * 1000, user_id: user.id, login: user.login });
      console.log(`Signed in as ${user.login} (${user.id}). Tokens saved to ${path.basename(ALT_FILE)}.`);
      return;
    }
    const msg = String(r.data.message || '');
    if (/authorization_pending|slow_down/i.test(msg)) continue;
    if (!withSecret && app.secret && /secret/i.test(msg)) { withSecret = true; continue; }
    fail('sign-in failed: ' + msg);
  }
  fail('the code expired; run login again');
}

async function altToken() {
  const file = readJson(ALT_FILE);
  if (!file?.alt) fail('no alt account yet; run `node scripts/devtools.mjs login` first');
  const alt = file.alt;
  if (alt.expires_at - Date.now() > 60_000) return alt;
  const app = twitchApp();
  const r = await twitchForm('https://id.twitch.tv/oauth2/token', { client_id: app.id, ...(app.secret ? { client_secret: app.secret } : {}), grant_type: 'refresh_token', refresh_token: alt.refresh_token });
  if (r.status !== 200) fail('refreshing the alt token failed (' + (r.data.message || r.status) + '); run login again');
  const next = { ...alt, access_token: r.data.access_token, refresh_token: r.data.refresh_token || alt.refresh_token, expires_at: Date.now() + r.data.expires_in * 1000 };
  saveAlt(next);
  return next;
}

// Refuses unless Twitch confirms the channel is offline; an unreadable answer counts as live.
async function ensureOffline(token) {
  const r = await helix('/streams?user_login=' + CHANNEL, token);
  if (r.status !== 200 || !Array.isArray(r.data.data)) fail(`could not confirm ${CHANNEL} is offline (${r.status}); not posting`);
  if (r.data.data.length) fail(`${CHANNEL} is live; devtools never post in chat during a stream`);
}

async function chat(line) {
  if (!line) fail('usage: chat <message>');
  const alt = await altToken();
  await ensureOffline(alt.access_token);
  const ch = await helix('/users?login=' + CHANNEL, alt.access_token);
  const broadcaster = ch.data.data?.[0]?.id;
  if (!broadcaster) fail('channel not found: ' + CHANNEL);
  const r = await helix('/chat/messages', alt.access_token, { method: 'POST', body: JSON.stringify({ broadcaster_id: broadcaster, sender_id: alt.user_id, message: line }) });
  const sent = r.data.data?.[0];
  if (r.status !== 200 || !sent?.is_sent) fail('message not sent: ' + JSON.stringify(sent?.drop_reason || r.data));
  console.log(`${alt.login}: ${line}`);
  return alt;
}

async function altProfile() {
  const alt = (readJson(ALT_FILE) || {}).alt;
  if (!alt) fail('no alt account yet; run login first');
  await site(`/api/devtools/${CHANNEL}/profile`, { method: 'POST', body: { userId: alt.user_id, username: alt.login, displayName: alt.login, avatar: flags.avatar || 'adventurer', color: flags.color || '#FFB020', defaultAbility: flags.ability || 'strike' } });
  console.log(`saved a fighter for ${alt.login} on the test site (${CHANNEL})`);
}

// Real chat end to end: the alt challenges a bot in Twitch chat, StreamElements calls the site,
// then the bot answers through the same StreamElements route (bots cannot type in Twitch chat).
async function realDuel() {
  const target = botByName(flags.bot || 'a');
  const alt = (readJson(ALT_FILE) || {}).alt;
  if (!alt) fail('no alt account yet; run login first');
  const before = await state();
  if (!before.players.some((p) => p.userId === target.userId)) await say(target, 'hi', 'chat');
  await chat('!challenge @' + target.username);
  let pending = null;
  for (let i = 0; i < 20 && !pending; i++) {
    await sleep(1000);
    const s = await state();
    pending = s.duels.find((d) => d.status === 'pending' && d.a === alt.user_id && d.b === target.userId);
  }
  if (!pending) fail(`no challenge reached ${BASE} within 20 s. Check that the StreamElements !challenge command points at this site and that ${alt.login} has a fighter (run alt-profile).`);
  console.log(`challenge arrived through StreamElements (${pending.id}); ${target.username} answers`);
  console.log(`${target.username}: !fight\n  -> ${await say(target, '!fight', 'se')}`);
}

const usage = `Usage: node scripts/devtools.mjs <command> [--channel nesszerra]   (site: ${BASE})

Bots on the test site
  seed [--bots 2..4]          save fighters for testbot_a… and put them in the arena
  duel [a] [b] [--via chat|se] testbot_a challenges testbot_b, testbot_b answers !fight
  say <bot> <line> [--via …]  one chat line as a bot, e.g. say a "!challenge @testbot_b"
  state                       players and open duels
  live on|off|real [--stream id]  pretend the channel is live for !checkin (real = ask Twitch)
  clean                       remove the bots and their profiles

Alt account in real Twitch chat (posts only while the channel is offline)
  login                       Twitch device code sign-in for the alt (scope user:write:chat)
  alt-profile [--avatar id]   save a fighter for the alt on the test site
  chat <message>              send one message as the alt
  real-duel [--bot a]         alt challenges a bot in chat; the bot answers via StreamElements`;

const commands = {
  seed, clean, duel, live, state: show,
  say: async () => { const who = botByName(args[0]); console.log(await say(who, args.slice(1).join(' '))); },
  login, 'alt-profile': altProfile, chat: () => chat(args.join(' ')), 'real-duel': realDuel,
  help: async () => console.log(usage),
};
if (!commands[command]) { console.log(usage); process.exit(1); }
await commands[command]();
