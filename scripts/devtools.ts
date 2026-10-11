#!/usr/bin/env node
// Test-site tooling: bot fighters, scripted duels and an alt account in real Twitch chat. See docs/DEVTOOLS.md.
// Talks only to the test site (DEV_TOOLS_TOKEN exists only there) and posts to Twitch chat only while the channel is offline.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import siteConfig from "../site.config.js";
import type { Duel, Snapshot } from "../server/model.ts";

/** A test bot or the alt, as the devtools routes take a chatter. */
type Who = { userId: string; username: string; displayName: string };
/** ~/.pixfray/secrets.test.json, as far as devtools reads it. */
type Secrets = { DEV_TOOLS_TOKEN?: string; TWITCH_CLIENT_ID?: string; TWITCH_CLIENT_SECRET?: string };
/** The alt account's tokens, saved by `login`. */
type Alt = { access_token: string; refresh_token: string; expires_at: number; user_id: string; login: string };
/** A Twitch OAuth token answer (a 200); a refused one carries only `message`. */
type TokenReply = { access_token: string; refresh_token: string; expires_in: number; message?: string };
/** Helix answers list their results under `data`. */
type HelixList<T> = { data?: T[] };

// Real secrets stay outside the repo folder, in ~/.pixfray/ (docs/SELF_HOSTING.md).
const SECRETS = process.env.MINI_SECRETS || path.join(os.homedir(), ".pixfray", "secrets.test.json"); // DEV_TOOLS_TOKEN, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET
const ALT_FILE = process.env.MINI_DEVTOOLS_FILE || path.join(os.homedir(), ".pixfray", "devtools.json"); // alt account tokens from `login`
const BASE = (process.env.MINI_DEVTOOLS_BASE || siteConfig.origins.test).replace(/\/$/, "");
const BOT_LETTERS = "abcd";

const argv = process.argv.slice(2);
const flags: Record<string, string | true> = {},
  args: string[] = [];
// The loop reads argv[i] for i < argv.length, argv[i + 1] after checking it, and the regex's first group, which
// always matches: each `!` in the loop marks one of those.
for (let i = 0; i < argv.length; i++) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]!); // !: i < argv.length
  if (!m) args.push(argv[i]!); // !: i < argv.length
  else if (m[2] !== undefined) flags[m[1]!] = m[2];
  // !: argv[i + 1] is checked first, and group 1 always matches
  else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) flags[m[1]!] = argv[++i]!;
  else flags[m[1]!] = true;
}
const command = args.shift() || "help";
const CHANNEL = String(flags.channel || siteConfig.defaultChannel).toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(message: string): never {
  console.error("devtools: " + message);
  process.exit(1);
}
// JSON.parse is typed any; T names the shape of the file the caller reads.
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function secrets() {
  const s = readJson<Secrets>(SECRETS) || {};
  return { ...s, DEV_TOOLS_TOKEN: process.env.DEV_TOOLS_TOKEN || s.DEV_TOOLS_TOKEN };
}
if (
  [
    siteConfig.origins.production,
    ...Object.keys(siteConfig.channelDomains.production || {}).map((host) => "https://" + host),
  ].includes(BASE.replace(/\/$/, ""))
)
  fail("refusing to run against production; devtools are test-site only");

// ---- test site API (dev token) ----
async function site<T = unknown>(
  pathname: string,
  { method = "GET", body }: { method?: string; body?: unknown } = {},
): Promise<T> {
  const token = secrets().DEV_TOOLS_TOKEN;
  if (!token) fail(`DEV_TOOLS_TOKEN not found in ${path.basename(SECRETS)} or the environment`);
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok)
    fail(
      `${method} ${pathname} -> ${res.status} ${typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data)}`,
    );
  return data as T; // the route's JSON answer; each caller names the fields it reads
}
const bot = (letter: string): Who => ({
  userId: "testbot:" + letter,
  username: "testbot_" + letter,
  displayName: "testbot_" + letter,
});
function botByName(name: string | true | undefined) {
  const m = /^(?:@?testbot_)?([a-d])$/i.exec(String(name || ""));
  if (!m) fail(`unknown bot "${name}"; use testbot_a … testbot_d`);
  return bot(m[1]!.toLowerCase()); // the group is not optional, so a match has it
}
async function state() {
  return site<Snapshot>(`/api/state/${CHANNEL}`);
}

// One chat line as a bot. --via chat (default) runs it through the room like a Twitch message;
// --via se goes through the public StreamElements route, exactly as the StreamElements bot calls it.
async function say(who: Who, line: string, via = flags.via || "chat") {
  if (via === "se") return seCall(who, line);
  const r = await site<{ reply?: string; reason?: string }>(`/api/devtools/${CHANNEL}/chat`, {
    method: "POST",
    body: { ...who, text: line },
  });
  return r.reply || r.reason || "";
}
let seKey: string | null | undefined = null;
async function seCall(who: Who, line: string) {
  const m = /^!(\w+)(?:\s+(\S+))?(?:\s+(\S+))?/.exec(line.trim());
  if (!m) fail(`not a command: ${line}`);
  if (!seKey) {
    const admin = await site<{ streamelements?: { key?: string } }>(`/api/admin/${CHANNEL}`);
    seKey = admin.streamelements?.key;
    if (!seKey) fail("StreamElements is not set up on the test site for " + CHANNEL + "; use --via chat");
  }
  // a lookup by any command name (unknown ones miss and fall back); the first group always matches (`!` twice)
  const action =
    // as Record: unknown names miss; !: group 1 always matches
    ({ duel: "challenge", fight: "accept", pay: "give" } as Record<string, string | undefined>)[m[1]!.toLowerCase()] ||
    m[1]!.toLowerCase(); // !: group 1 always matches
  const q = new URLSearchParams({
    k: seKey,
    id: who.userId,
    u: who.username,
    d: who.displayName,
    t: m[2] || "",
    ...(action === "give" ? { a: m[3] || "" } : {}),
    m: "devtools-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
  });
  // the template turns q into its query string; restrict-template-expressions flags this URLSearchParams (from the
  // Workers and Node types), so the cast names it a string
  const res = await fetch(`${BASE}/api/se/${CHANNEL}/${action}?${q as unknown as string}`);
  return (await res.text()).trim();
}

async function seed() {
  const n = Math.max(2, Math.min(4, Number(flags.bots) || 2));
  const catalog = await site<{ id: string }[] | { characters?: { id: string }[] }>(`/api/catalog/${CHANNEL}`);
  const avatars = (Array.isArray(catalog) ? catalog : catalog.characters || []).map((c) => c.id);
  const colors = ["#4FA3FF", "#FF7A45", "#5AD17A", "#C77DFF"],
    abilities = ["strike", "heavy", "heal", "strike"];
  for (let i = 0; i < n; i++) {
    const b = bot(BOT_LETTERS[i]!); // i < n <= 4, the length of BOT_LETTERS
    await site(`/api/devtools/${CHANNEL}/profile`, {
      method: "POST",
      body: {
        ...b,
        avatar: avatars[(i * 3) % avatars.length] || "player",
        color: colors[i],
        defaultAbility: abilities[i],
      },
    });
    await say(b, "hi", "chat"); // a plain line puts the bot in the arena so it can be challenged
    console.log(`seeded ${b.username} (${b.userId})`);
  }
}

async function clean() {
  const s = await state();
  const bots = s.players.filter((p) => String(p.userId).startsWith("testbot:")).map((p) => p.userId);
  const ids = new Set([...bots, ...BOT_LETTERS.split("").map((l) => bot(l).userId)]);
  for (const userId of ids)
    await site(`/api/admin/${CHANNEL}`, { method: "POST", body: { action: "removePlayer", userId } });
  console.log("removed test bots and their profiles from " + CHANNEL);
}

async function duel() {
  const [a, b] = [botByName(args[0] || "a"), botByName(args[1] || "b")];
  console.log(`${a.username}: !challenge @${b.username}\n  -> ${await say(a, "!challenge @" + b.username)}`);
  await sleep(Number(flags.wait) || 1500);
  console.log(`${b.username}: !fight\n  -> ${await say(b, "!fight")}`);
}

// Pretend live state for !checkin: on (a new stream id each time unless --stream), off, or real (ask Twitch).
async function live() {
  const mode = args[0] || "on";
  if (!["on", "off", "real"].includes(mode)) fail("usage: live on|off|real [--stream id]");
  const body =
    mode === "real"
      ? { live: null }
      : { live: mode === "on", ...(flags.stream ? { streamId: String(flags.stream) } : {}) };
  const r = await site<{ live: boolean; streamId?: string }>(`/api/devtools/${CHANNEL}/live`, { method: "POST", body });
  console.log(
    mode === "real"
      ? `${CHANNEL}: live check goes to Twitch again`
      : `${CHANNEL}: ${r.live ? "live, stream " + r.streamId : "offline"}`,
  );
}

async function show() {
  const s = await state();
  console.log(
    `${CHANNEL} rev ${s.revision} | chat ${s.chat?.status} | paused ${s.paused} | quickDuel ${s.config?.quickDuel}`,
  );
  for (const p of s.players)
    console.log(
      `  ${p.username.padEnd(25)} ${String(p.userId).padEnd(14)} hp ${p.hp} elo ${p.elo} (${p.wins}-${p.losses})`,
    );
  for (const d of s.duels.filter((x) => !["cancelled", "expired", "completed"].includes(x.status)))
    console.log(`  duel ${d.id} ${d.status} ${d.a} vs ${d.b}`);
}

// ---- alt account: Twitch device code sign-in and chat ----
const TWITCH_SCOPES = "user:write:chat";
async function twitchForm<T>(url: string, params: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  // T is the answer's shape on a 200; an answer that isn't JSON reads as {}, and callers check the status first
  return { status: res.status, data: await res.json<T>().catch(() => ({}) as T) };
}
function twitchApp() {
  const s = secrets();
  if (!s.TWITCH_CLIENT_ID) fail(`TWITCH_CLIENT_ID not found in ${path.basename(SECRETS)}`);
  return { id: s.TWITCH_CLIENT_ID, secret: s.TWITCH_CLIENT_SECRET };
}
async function helix<T>(pathname: string, token: string, init: { method?: string; body?: string } = {}) {
  const res = await fetch("https://api.twitch.tv/helix" + pathname, {
    ...init,
    headers: {
      Authorization: "Bearer " + token,
      "Client-Id": twitchApp().id,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  // T is the answer's shape on a 200; an answer that isn't JSON reads as {}, and callers check the status first
  return { status: res.status, data: await res.json<T>().catch(() => ({}) as T) };
}
function saveAlt(alt: Alt) {
  fs.writeFileSync(ALT_FILE, JSON.stringify({ alt }, null, 2) + "\n");
}

async function login() {
  const app = twitchApp();
  const start = await twitchForm<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval?: number;
    expires_in?: number;
  }>("https://id.twitch.tv/oauth2/device", { client_id: app.id, scopes: TWITCH_SCOPES });
  if (start.status !== 200) fail("device code request failed: " + JSON.stringify(start.data));
  const { device_code, user_code, verification_uri, interval = 5, expires_in = 1800 } = start.data;
  console.log(`Sign in with the ALT account (not your main):\n  ${verification_uri}\n  code: ${user_code}\nWaiting…`);
  const until = Date.now() + expires_in * 1000;
  let withSecret = false;
  while (Date.now() < until) {
    await sleep(interval * 1000);
    const params = {
      client_id: app.id,
      scopes: TWITCH_SCOPES,
      device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      // withSecret turns on only when app.secret is set (below)
      ...(withSecret ? { client_secret: app.secret! } : {}),
    };
    const r = await twitchForm<TokenReply>("https://id.twitch.tv/oauth2/token", params);
    if (r.status === 200) {
      const me = await helix<HelixList<{ id: string; login: string }>>("/users", r.data.access_token);
      const user = me.data.data?.[0];
      if (!user) fail("signed in, but could not read the account");
      saveAlt({
        access_token: r.data.access_token,
        refresh_token: r.data.refresh_token,
        expires_at: Date.now() + r.data.expires_in * 1000,
        user_id: user.id,
        login: user.login,
      });
      console.log(`Signed in as ${user.login} (${user.id}). Tokens saved to ${path.basename(ALT_FILE)}.`);
      return;
    }
    const msg = String(r.data.message || "");
    if (/authorization_pending|slow_down/i.test(msg)) continue;
    if (!withSecret && app.secret && /secret/i.test(msg)) {
      withSecret = true;
      continue;
    }
    fail("sign-in failed: " + msg);
  }
  fail("the code expired; run login again");
}

// This script's path for the messages that tell how to run it, as its own literal so a rename can follow it.
const SELF = "scripts/devtools.ts";

async function altToken() {
  const file = readJson<{ alt?: Alt }>(ALT_FILE);
  if (!file?.alt) fail("no alt account yet; run `node " + SELF + " login` first");
  const alt = file.alt;
  if (alt.expires_at - Date.now() > 60_000) return alt;
  const app = twitchApp();
  const r = await twitchForm<TokenReply>("https://id.twitch.tv/oauth2/token", {
    client_id: app.id,
    ...(app.secret ? { client_secret: app.secret } : {}),
    grant_type: "refresh_token",
    refresh_token: alt.refresh_token,
  });
  if (r.status !== 200) fail("refreshing the alt token failed (" + (r.data.message || r.status) + "); run login again");
  const next: Alt = {
    ...alt,
    access_token: r.data.access_token,
    refresh_token: r.data.refresh_token || alt.refresh_token,
    expires_at: Date.now() + r.data.expires_in * 1000,
  };
  saveAlt(next);
  return next;
}

// Refuses unless Twitch confirms the channel is offline; an unreadable answer counts as live.
async function ensureOffline(token: string) {
  const r = await helix<HelixList<unknown>>("/streams?user_login=" + CHANNEL, token);
  if (r.status !== 200 || !Array.isArray(r.data.data))
    fail(`could not confirm ${CHANNEL} is offline (${r.status}); not posting`);
  if (r.data.data.length) fail(`${CHANNEL} is live; devtools never post in chat during a stream`);
}

async function chat(line: string) {
  if (!line) fail("usage: chat <message>");
  const alt = await altToken();
  await ensureOffline(alt.access_token);
  const ch = await helix<HelixList<{ id: string }>>("/users?login=" + CHANNEL, alt.access_token);
  const broadcaster = ch.data.data?.[0]?.id;
  if (!broadcaster) fail("channel not found: " + CHANNEL);
  const r = await helix<HelixList<{ is_sent: boolean; drop_reason?: unknown }>>("/chat/messages", alt.access_token, {
    method: "POST",
    body: JSON.stringify({ broadcaster_id: broadcaster, sender_id: alt.user_id, message: line }),
  });
  const sent = r.data.data?.[0];
  if (r.status !== 200 || !sent?.is_sent) fail("message not sent: " + JSON.stringify(sent?.drop_reason || r.data));
  console.log(`${alt.login}: ${line}`);
  return alt;
}

async function altProfile() {
  const alt = (readJson<{ alt?: Alt }>(ALT_FILE) || {}).alt;
  if (!alt) fail("no alt account yet; run login first");
  await site(`/api/devtools/${CHANNEL}/profile`, {
    method: "POST",
    body: {
      userId: alt.user_id,
      username: alt.login,
      displayName: alt.login,
      avatar: flags.avatar || "adventurer",
      color: flags.color || "#FFB020",
      defaultAbility: flags.ability || "strike",
    },
  });
  console.log(`saved a fighter for ${alt.login} on the test site (${CHANNEL})`);
}

// Real chat end to end: the alt challenges a bot in Twitch chat, StreamElements calls the site,
// then the bot answers through the same StreamElements route (bots cannot type in Twitch chat).
async function realDuel() {
  const target = botByName(flags.bot || "a");
  const alt = (readJson<{ alt?: Alt }>(ALT_FILE) || {}).alt;
  if (!alt) fail("no alt account yet; run login first");
  const before = await state();
  if (!before.players.some((p) => p.userId === target.userId)) await say(target, "hi", "chat");
  await chat("!challenge @" + target.username);
  let pending: Duel | null | undefined = null;
  for (let i = 0; i < 20 && !pending; i++) {
    await sleep(1000);
    const s = await state();
    pending = s.duels.find((d) => d.status === "pending" && d.a === alt.user_id && d.b === target.userId);
  }
  if (!pending)
    fail(
      `no challenge reached ${BASE} within 20 s. Check that the StreamElements !challenge command points at this site and that ${alt.login} has a fighter (run alt-profile).`,
    );
  console.log(`challenge arrived through StreamElements (${pending.id}); ${target.username} answers`);
  console.log(`${target.username}: !fight\n  -> ${await say(target, "!fight", "se")}`);
}

const usage = `Usage: node ${SELF} <command> [--channel ${siteConfig.defaultChannel}]   (site: ${BASE})

Bots on the test site
  seed [--bots 2..4]          save fighters for testbot_a… and put them in the arena
  duel [a] [b] [--via chat|se] testbot_a challenges testbot_b, testbot_b answers !fight
  say <bot> <line> [--via …]  one chat line as a bot, e.g. say a "!challenge @testbot_b"
  state                       players and open duels
  live on|off|real [--stream id]  pretend the channel is live for !checkin and !pay (real = ask Twitch)
  buy <bot> <kind> [id]       the bot buys with its dollars: pet|hat|recolor|petcolor|accessory|trail|effect|taunt|title <id>, or slot
  equip <bot> <pet|none|-> [field=id ...]
                              the bot brings a pet it owns (- keeps it) and wears cosmetics it owns, e.g.
                              recolor=crimson petColor=gold accessory=cape trail=flames winEffect=confetti taunt=gg title=legend build=1
  gift <bot> <amount>         a mod gift of PixFray dollars (negative takes them back)
  clean                       remove the bots and their profiles

Alt account in real Twitch chat (posts only while the channel is offline)
  login                       Twitch device code sign-in for the alt (scope user:write:chat)
  alt-profile [--avatar id]   save a fighter for the alt on the test site
  chat <message>              send one message as the alt
  real-duel [--bot a]         alt challenges a bot in chat; the bot answers via StreamElements`;

const commands: Record<string, () => Promise<unknown>> = {
  seed,
  clean,
  duel,
  live,
  state: show,
  buy: async () => {
    const b = botByName(args[0]);
    const r = await site<{ reason: string; kind?: string; id?: string; dollars: number }>(
      `/api/devtools/${CHANNEL}/shop`,
      {
        method: "POST",
        body: { ...b, kind: args[1], id: args[2] || "" },
      },
    );
    console.log(`${b.username}: ${r.reason} ${r.kind || args[1]} ${r.id || args[2]} -> $${r.dollars}`);
  },
  equip: async () => {
    const b = botByName(args[0]),
      p = (await state()).players.find((x) => x.userId === b.userId);
    if (!p) fail(b.username + " is not in the arena; run seed first");
    const r = await site<{
      error?: string;
      profile?: { pet?: string; petTier?: string; build?: number; [field: string]: string | number | undefined };
    }>(`/api/devtools/${CHANNEL}/profile`, {
      method: "POST",
      body: {
        ...b,
        avatar: p.avatar,
        color: p.color,
        defaultAbility: p.defaultAbility || "strike",
        pet: args[1] === "none" ? "" : args[1] === "-" ? undefined : args[1],
        ...Object.fromEntries(
          args
            .slice(2)
            .map((a) => a.split("="))
            .map(([k, v]) => [k, k === "build" ? Number(v) : v === "none" ? "" : v || ""]),
        ),
      },
    });
    if (r.error) fail(b.username + ": " + r.error);
    console.log(
      `${b.username}: pet ${r.profile?.pet || "none"} (${r.profile?.petTier || "-"})` +
        ["recolor", "petColor", "accessory", "trail", "winEffect", "taunt", "title"]
          .filter((k) => r.profile?.[k])
          // the filter above kept only fields r.profile has, so it is set here
          .map((k) => ` ${k}=${r.profile![k]}`)
          .join("") +
        ` build=${r.profile?.build ?? 0}`,
    );
  },
  gift: async () => {
    const r = await site<{ username: string; amount: number; dollars: number }>(`/api/admin/${CHANNEL}`, {
      method: "POST",
      body: { action: "giftDollars", payload: { username: botByName(args[0]).username, amount: Number(args[1]) } },
    });
    console.log(`${r.username}: ${r.amount > 0 ? "+" : ""}${r.amount} -> $${r.dollars}`);
  },
  say: async () => {
    const who = botByName(args[0]);
    console.log(await say(who, args.slice(1).join(" ")));
  },
  login,
  "alt-profile": altProfile,
  chat: () => chat(args.join(" ")),
  "real-duel": realDuel,
  help: async () => console.log(usage),
};
if (!commands[command]) {
  console.log(usage);
  process.exit(1);
}
await commands[command]!(); // checked above: unknown commands exit
