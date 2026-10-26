// Local end-to-end check against a running dev server with seeded test sessions (tests/seed-local.ts): real Worker and
// Durable Objects, chat as signed Twitch EventSub webhook POSTs to /api/eventsub, and the real overlay, dashboard, admin
// and dev pages in installed Chrome. Nothing here talks to Twitch or a deployed site: the dev server runs with
// MINI_LOCAL_TEST=1, so Connect chat records a local subscription without calling Helix.
// Usage: MINI_BASE_URL=http://127.0.0.1:5199 MINI_AUTH_SECRET=<the dev server's AUTH_SECRET> node tests/e2e-local.ts
// (normally run by scripts/test-all.ts, which reads AUTH_SECRET from .dev.vars and never prints it)
import { launchChrome } from "./chrome.ts";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { cookies, users } from "./seed-local.ts";
import { enforceCsp } from "./csp-helper.ts";
import { defaultConfig } from "../server/game.ts";
import type { Loose } from "./fakes.ts";

type User = { id: string; login: string; displayName: string };
type ApiOptions = { cookie?: string; method?: string; body?: unknown };
type PostOptions = { id?: string; timestamp?: string; secret?: string };
// A command's outcome, read back from the room events.
type Ack = { ok: boolean; reason?: string; retryAt?: number };
// Loose: events, duels and players are the room's JSON records; each step reads the fields of its own event or duel
type RoomState = {
  revision: number;
  paused: boolean;
  chat: { connected: boolean };
  events: Loose[];
  duels: Loose[];
  players: Loose[];
};
// The overlay's ?debug=1 snapshot (window.__arenaDebug in src/served/overlay.ts), the fields this test reads.
// Loose: players, duels and results are the overlay's own records, read by field and asserted on
type ArenaDebug = {
  revision: number;
  paused: boolean;
  chat: { bot?: boolean } | null;
  players: Loose[];
  duels: Loose[];
  announcement: string;
  results: Loose[];
  banners: string[];
};
// Page callbacks run in the overlay, where the debug hook is set; types/dom.ts declares it optional, returning unknown.
declare const window: { __arenaDebug: () => ArenaDebug };

// The duel script below counts hits for the first preset (strike 10 every 3 s, heavy 25 every 8 s, heal 15 every 10 s).
// The config patch pins it: with the shipped defaults (strike 20, heavy 35) the first !attack ends the duel.
const DUEL_BALANCE = {
  strike: { damage: 10, cooldownMs: 3000 },
  heavy: { damage: 25, cooldownMs: 8000 },
  heal: { amount: 15, cooldownMs: 10000 },
};

const base = process.env.MINI_BASE_URL || "http://127.0.0.1:5173";
const ch = "nesszerra";
const arenaUrl = base + "/overlay.html?channel=" + ch + "&arena=1&size=64";
const shots = fileURLToPath(new URL("../screenshots", import.meta.url));
fs.mkdirSync(shots, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log("[e2e]", ...a);
async function api(path: string, { cookie, method = "GET", body }: ApiOptions = {}) {
  const headers: Record<string, string> = { Origin: base };
  if (cookie) headers.Cookie = "mini_session=" + cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: body === undefined ? null : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}
const state = async (): Promise<RoomState> => (await api("/api/state/" + ch)).data;
// Loose: leaderboard rows from the JSON reply, read by field
const leaderboard = async (): Promise<Loose[]> => (await api("/api/leaderboard/" + ch)).data;
const activeDuel = async () => (await state()).duels.find((x) => x.status === "active");
/** The mod page's answer for `cookie`, or with a body, that admin action. */
const adminApi = (cookie: string, body?: unknown) =>
  api("/api/admin/" + ch, body === undefined ? { cookie } : { cookie, method: "POST", body });
async function until<T>(fn: () => Promise<T>, label: string, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  throw new Error("timed out waiting for " + label);
}
const cancelled = (duelId: string, label: string, ms: number) =>
  until(async () => (await state()).events.find((e) => e.type === "duel_cancelled" && e.duelId === duelId), label, ms);

// Twitch EventSub stand-in: signs exactly like Twitch (HMAC-SHA256 over id + timestamp + body) with the secret
// the Worker derives from AUTH_SECRET. The secret only lives in this process's memory.
if (!process.env.MINI_AUTH_SECRET)
  throw new Error("MINI_AUTH_SECRET is required (scripts/test-all.ts passes it from .dev.vars)");
const eventsubSecret = createHmac("sha256", process.env.MINI_AUTH_SECRET).update("mini-chat:eventsub:v1").digest("hex");
let seq = 0,
  subscriptionId = "";
async function eventsubPost(
  type: string,
  body: unknown,
  {
    id = "e2e-" + Date.now() + "-" + ++seq,
    timestamp = new Date().toISOString(),
    secret = eventsubSecret,
  }: PostOptions = {},
) {
  const raw = JSON.stringify(body);
  const signature =
    "sha256=" +
    createHmac("sha256", secret)
      .update(id + timestamp + raw)
      .digest("hex");
  // like Twitch: no Origin, no cookie
  const res = await fetch(base + "/api/eventsub", {
    method: "POST",
    body: raw,
    headers: {
      "Content-Type": "application/json",
      "Twitch-Eventsub-Message-Id": id,
      "Twitch-Eventsub-Message-Timestamp": timestamp,
      "Twitch-Eventsub-Message-Signature": signature,
      "Twitch-Eventsub-Message-Type": type,
      "Twitch-Eventsub-Subscription-Type": "channel.chat.message",
      "Twitch-Eventsub-Subscription-Version": "1",
    },
  });
  return { status: res.status, text: await res.text(), id };
}
const subscription = (status = "enabled") => ({
  id: subscriptionId,
  status,
  type: "channel.chat.message",
  version: "1",
  condition: { broadcaster_user_id: "1", user_id: "1" },
  transport: { method: "webhook", callback: base + "/api/eventsub" },
  created_at: new Date().toISOString(),
});
const chatMessage = (user: User, text: string, messageId = "chat-" + Date.now() + "-" + ++seq) => ({
  subscription: subscription(),
  event: {
    broadcaster_user_id: "1",
    broadcaster_user_login: ch,
    broadcaster_user_name: ch,
    chatter_user_id: user.id,
    chatter_user_login: user.login,
    chatter_user_name: user.displayName,
    message_id: messageId,
    message: { text, fragments: [{ type: "text", text }] },
    message_type: "text",
    color: "",
  },
});
async function say(user: User, text: string) {
  const r = await eventsubPost("notification", chatMessage(user, text));
  assert.equal(r.status, 204, "eventsub notification: " + r.status + " " + r.text);
}
// Twitch gets no reply, so a command's outcome is read back from the room event list (rejections are logged there).
async function command(user: User, text: string): Promise<Ack> {
  const before = (await state()).revision;
  await say(user, text);
  const added = (await state()).events.filter((e) => Number(e.id) > before);
  const rejected = added.find((e) => e.type === "command_rejected" && e.userId === user.id);
  if (rejected) return { ok: false, reason: rejected.reason, retryAt: rejected.retryAt };
  if (!added.length) return { ok: false, reason: "no_effect" };
  return { ok: true, reason: added.some((e) => e.type === "duel_completed") ? "duel_completed" : added.at(-1).type };
}
async function expectOk(user: User, text: string) {
  const ack = await command(user, text);
  assert.equal(ack.ok, true, text + ": " + JSON.stringify(ack));
}
async function expectRejected(user: User, text: string, reason: string) {
  const ack = await command(user, text);
  assert.deepEqual([ack.ok, ack.reason], [false, reason], text + ": " + JSON.stringify(ack));
  return ack;
}

const errors: string[] = [];
// enforceCsp (csp-helper.ts) serves the overlay through a Playwright route, which Chrome treats as a public page, so its
// Local Network Access check would block the socket to 127.0.0.1. The deployed overlay is same-origin and never hits it.
const browser = await launchChrome(["--disable-features=LocalNetworkAccessChecks"]);
try {
  const sess = await api("/api/session", { cookie: cookies.owner });
  assert.equal(sess.data.owner, true, "seeded owner session must be the owner (run tests/seed-local.ts first)");
  // reruns start offline, from a clean arena and 1000 Elo
  for (const action of ["disconnectChat", "resetAll", "resetAllRanks"]) {
    const r = await adminApi(cookies.owner, { action });
    assert.equal(r.status, 200, action + ": " + JSON.stringify(r.data));
  }
  const dave = { id: "900199", login: "dave_e2e", displayName: "Dave_E2E" }; // never signs in

  const saves = {
    alice: ["toon-ranger", "#22cc88", "strike"],
    bob: ["alien-blue", "#3b82f6", "heavy"],
    carol: ["toon-robot", "#f59e0b", "heal"],
  };
  // saving a profile through the dashboard API also puts the viewer in the arena
  const saveProfile = async (k: keyof typeof saves) => {
    const [avatar, color, defaultAbility] = saves[k];
    const r = await api("/api/profile/" + ch, {
      cookie: cookies[k],
      method: "POST",
      body: { avatar, color, defaultAbility },
    });
    assert.equal(r.status, 200, k + " profile save: " + JSON.stringify(r.data));
  };
  await saveProfile("alice");
  await saveProfile("bob");
  const noOrigin = await fetch(base + "/api/profile/" + ch, {
    method: "POST",
    headers: { Cookie: "mini_session=" + cookies.alice, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(noOrigin.status, 403, "mutation without Origin is refused");
  log("profiles saved for alice and bob; cross-origin POST refused");

  const admin = await adminApi(cookies.owner);
  assert.equal(admin.status, 200);
  const baseVersion = admin.data.configVersion;
  const patch = await adminApi(cookies.owner, {
    action: "config",
    patch: { maxHp: 60, inactivityMs: 10000, quickDuel: false, abilities: DUEL_BALANCE },
    baseVersion,
    note: "e2e: short HP duels",
  });
  assert.equal(patch.status, 200, JSON.stringify(patch.data));
  const stale = await adminApi(cookies.owner, { action: "config", patch: { maxHp: 70 }, baseVersion, note: "stale" });
  assert.equal(stale.status, 409);
  const viewerAdmin = await adminApi(cookies.alice);
  assert.equal(viewerAdmin.status, 403, "a viewer without a mod role cannot open admin");
  const hist = (await adminApi(cookies.owner)).data.history;
  assert.equal(hist[0].note, "e2e: short HP duels");
  assert.equal(hist[0].actorName, "nesszerra");
  log("config v" + (baseVersion + 1) + " saved (maxHp 60, inactivity 10 s); stale save 409; viewer 403");

  const overlayCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await enforceCsp(overlayCtx);
  const overlay = await overlayCtx.newPage();
  overlay.on("pageerror", (e) => errors.push("overlay: " + e.message));
  overlay.on("console", (m) => {
    if (/Content Security Policy|Refused to (load|execute|apply|connect|create)/.test(m.text()))
      errors.push("overlay CSP: " + m.text());
  });
  await overlay.goto(arenaUrl + "&debug=1");
  await overlay.waitForFunction(() => window.__arenaDebug?.().revision > 0);
  const dbg = () => overlay.evaluate(() => window.__arenaDebug());
  // waits until the overlay passes `fn`, which runs in the page and gets `id`
  const seen = (fn: (id: string) => boolean, id = "") => overlay.waitForFunction(fn, id, { timeout: 8000 });
  assert.equal((await dbg()).paused, true, "chat not connected yet: overlay sees a paused game");
  const plain = await overlayCtx.newPage(); // without debug the overlay shows no status text on stream
  await plain.goto(arenaUrl);
  await plain.waitForFunction(() => window.__arenaDebug === undefined && document.readyState === "complete");
  await plain.waitForTimeout(1500);
  assert.equal(await plain.locator("#status").isHidden(), true, "paused status stays off stream");

  const viewerConnect = await adminApi(cookies.alice, { action: "connectChat" });
  assert.equal(viewerConnect.status, 403, "a viewer cannot connect chat");
  const connected = await adminApi(cookies.owner, { action: "connectChat" });
  assert.equal(connected.status, 200, JSON.stringify(connected.data));
  subscriptionId = connected.data.chatStatus.subscriptionId;
  assert.match(subscriptionId, /^local-[a-f0-9]{16}$/, "local test mode: no Twitch call");
  await until(async () => (await state()).chat.connected && !(await state()).paused, "chat connected");
  const nonce = "e2e-challenge-" + Date.now();
  const challenge = await eventsubPost("webhook_callback_verification", {
    challenge: nonce,
    subscription: subscription("webhook_callback_verification_pending"),
  });
  assert.deepEqual([challenge.status, challenge.text], [200, nonce]);
  const rev0 = (await state()).revision;
  for (const [label, options] of [
    ["bad signature", { secret: "not-the-secret" }],
    ["stale timestamp", { timestamp: new Date(Date.now() - 11 * 60000).toISOString() }],
  ] as const) {
    const r = await eventsubPost("notification", chatMessage(users.alice, label), options);
    assert.equal(r.status, 403, label + " is refused");
  }
  assert.equal((await state()).revision, rev0, "refused messages change nothing");
  log("chat connected (" + subscriptionId + ", viewer 403); challenge echoed; bad signature 403; stale timestamp 403");

  await say(users.alice, "hi");
  await say(users.bob, "hi");
  await until(async () => (await state()).players.length === 2, "two players in state");
  await seen(() => window.__arenaDebug().players.length === 2);
  let d = await dbg();
  const look = (id: string) => d.players.find((p) => p.userId === id);
  assert.deepEqual(
    [look(users.alice.id).avatar, look(users.alice.id).color, look(users.bob.id).avatar, d.paused],
    ["toon-ranger", "#22cc88", "alien-blue", false],
    "the overlay shows both saved looks",
  );
  log("overlay shows 2 characters:", d.players.map((p) => p.label + "/" + p.avatar).join(", "));

  const challengeBody = chatMessage(users.alice, "!challenge @bob_e2e", "chat-challenge-" + Date.now());
  let r0 = (await state()).revision;
  const first = await eventsubPost("notification", challengeBody);
  assert.equal(first.status, 204);
  let s = await state();
  assert.ok(
    s.events.some((e) => Number(e.id) > r0 && e.type === "challenge_created"),
    JSON.stringify(s.events.slice(-3)),
  );
  // Twitch retries: the same Message-Id is ignored, and a new Message-Id for the same chat message is too.
  r0 = s.revision;
  assert.equal((await eventsubPost("notification", challengeBody, { id: first.id })).status, 204);
  assert.equal((await eventsubPost("notification", challengeBody)).status, 204);
  s = await state();
  assert.equal(s.revision, r0, "replayed message changed nothing");
  assert.equal(s.duels.filter((x) => x.status === "pending").length, 1, "still exactly one challenge");
  log("replayed EventSub message ignored (same Message-Id and same chat message_id)");
  await seen(() => /challenge/i.test(window.__arenaDebug().announcement || ""));
  await expectOk(users.bob, "!accept");
  const duel1 = await activeDuel();
  assert.ok(duel1);
  assert.equal(duel1.rules.maxHp, 60);
  assert.deepEqual(duel1.rules.abilities, DUEL_BALANCE, "duel 1 runs on the pinned balance");
  await seen(() => window.__arenaDebug().duels.filter((x) => x.status === "active").length === 1);
  await expectOk(users.alice, "!heavy");
  const onCooldown = await expectRejected(users.alice, "!strike", "cooldown");
  assert.ok((onCooldown.retryAt ?? 0) > Date.now() - 1000, "cooldown ack carries retryAt");
  await expectOk(users.bob, "!heavy"); // bob can act while alice is on cooldown
  await overlay.screenshot({ path: shots + "/e2e-overlay-duel-1280.png" });
  await sleep(1100);
  await expectOk(users.alice, "!strike"); // bob 60-25-10 = 25
  await expectRejected(users.alice, "!strike", "cooldown"); // strike 3 s cooldown
  for (const wait of [3100, 3100]) {
    await sleep(wait);
    await expectOk(users.alice, "!attack");
  } // 15, 5
  await sleep(Math.max(0, duel1.startedAt + 8200 - Date.now()));
  let ack: Ack,
    tries = 0;
  do {
    ack = await command(users.alice, "!heavy");
    if (!ack.ok) await sleep(400);
  } while (!ack.ok && ++tries < 10);
  assert.equal(ack.ok, true, JSON.stringify(ack));
  assert.equal(ack.reason, "duel_completed");
  s = await state();
  const done = s.events.find((e) => e.type === "duel_completed" && e.duelId === duel1.id);
  assert.ok(done, "duel_completed event");
  assert.equal(done.winnerId, users.alice.id);
  await seen(() => window.__arenaDebug().results.some((r) => /wins/.test(r.text)));
  d = await dbg();
  assert.equal(look(users.bob.id).ko, true, "loser shows KO");
  assert.equal(d.chat?.bot, false, "a local subscription is not the PixFray bot");
  assert.equal(d.results.filter((r) => r.duelId === duel1.id).length, 1, "the overlay showed the winner once");
  assert.ok(!d.banners.some((b) => /wins/.test(b)), "no winner banner");
  await overlay.screenshot({ path: shots + "/e2e-overlay-ko-1280.png" });
  log('duel KO: alice beat bob; overlay "' + d.results.at(-1).text + '", no banner');

  const rows = await leaderboard();
  const la = rows.find((r) => r.userId === users.alice.id),
    lbob = rows.find((r) => r.userId === users.bob.id);
  assert.deepEqual([la.elo, la.wins, la.losses], [1012, 1, 0]);
  assert.deepEqual([lbob.elo, lbob.wins, lbob.losses], [988, 0, 1]);
  assert.equal(rows[0].userId, users.alice.id, "winner tops the leaderboard");
  await seen((id) => window.__arenaDebug().players.find((p) => p.userId === id)?.elo === 1012, users.alice.id);
  log("Elo: alice 1012 (1-0), bob 988 (0-1); leaderboard and overlay updated");

  await sleep(3200); // respawn
  const rematch = await expectRejected(users.alice, "!duel @bob_e2e", "rematch_cooldown");
  assert.ok(rematch.retryAt);
  await say(dave, "hi");
  await expectRejected(dave, "!duel @alice_e2e", "ranked_sign_in_required");
  await saveProfile("carol");
  await say(users.carol, "hi");
  await expectOk(users.alice, "!duel @carol_e2e");
  await expectRejected(users.bob, "!duel @carol_e2e", "player_busy");
  await expectOk(users.carol, "!accept");
  const duel2 = await activeDuel();
  log("rematch_cooldown, ranked_sign_in_required, player_busy confirmed; waiting for inactivity cancel");
  assert.equal((await cancelled(duel2.id, "inactivity cancel", 16000)).reason, "inactivity");
  log("inactive duel cancelled after 10 s, unscored");

  // Chat disconnected mid-duel: the game pauses, the duel is cancelled unscored, ranks stay.
  const ranks = async () => (await leaderboard()).map((r) => [r.userId, r.elo, r.wins, r.losses]);
  const before = await ranks();
  await expectOk(users.alice, "!duel @carol_e2e");
  await expectOk(users.carol, "!accept");
  await expectOk(users.alice, "!strike");
  const duel3 = await activeDuel();
  const off = await adminApi(cookies.owner, { action: "disconnectChat" });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal((await cancelled(duel3.id, "chat-disconnect cancel", 8000)).reason, "chat_disconnected");
  s = await state();
  assert.equal(s.paused, true);
  assert.equal(s.chat.connected, false);
  assert.equal(s.duels.filter((x) => x.status === "active" || x.status === "pending").length, 0);
  assert.deepEqual(await ranks(), before, "ranks unchanged by the cancelled duel");
  await seen(
    () =>
      window.__arenaDebug().paused === true &&
      !window.__arenaDebug().duels.some((x) => x.status === "active" || x.status === "pending"),
  );
  assert.equal(await plain.locator("#status").isHidden(), true, "chat offline status stays off stream");
  const stray = await command(users.alice, "!duel @carol_e2e");
  assert.equal(stray.ok, false, "messages for a disconnected subscription are ignored");
  log("chat disconnected: paused, duel cancelled (chat_disconnected), ranks unchanged; overlay status hidden");

  // Reconnect, then Twitch revokes the subscription: paused again and the reason is shown to admins.
  subscriptionId = (await adminApi(cookies.owner, { action: "connectChat" })).data.chatStatus.subscriptionId;
  await until(async () => !(await state()).paused, "chat reconnected");
  assert.equal((await eventsubPost("revocation", { subscription: subscription("authorization_revoked") })).status, 204);
  await until(async () => (await state()).paused, "revocation pauses");
  const chatStatus = (await adminApi(cookies.owner)).data.chatStatus;
  assert.deepEqual([chatStatus.connected, chatStatus.lastRevocationReason], [false, "authorization_revoked"]);
  log("revocation: paused, reason authorization_revoked recorded");

  for (const [width, height] of [
    [1280, 900],
    [390, 844],
  ] as const) {
    const size = width + "";
    const ctx = await browser.newContext({ viewport: { width, height } });
    await enforceCsp(ctx);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(size + " page: " + e.message));
    await page.goto(arenaUrl + "&debug=1");
    await page.waitForFunction(() => window.__arenaDebug?.().revision > 0);
    await page.waitForTimeout(800);
    await page.screenshot({ path: shots + "/e2e-overlay-" + size + ".png" });
    await ctx.addCookies([{ name: "mini_session", value: cookies.alice, url: base }]);
    await page.goto(base + "/?channel=" + ch);
    await page.waitForFunction(() => !document.querySelector("#leaderboard tbody")?.textContent?.includes("Loading"));
    await page.waitForTimeout(500);
    assert.match((await page.locator("#leaderboard").textContent()) ?? "", /Alice_E2E|alice_e2e/);
    await page.screenshot({ path: shots + "/e2e-dashboard-" + size + ".png", fullPage: true });
    await ctx.clearCookies();
    await ctx.addCookies([{ name: "mini_session", value: cookies.owner, url: base }]);
    for (const [name, path] of [
      ["admin", "/admin/"],
      ["dev", "/admin/dev/"],
    ]) {
      await page.goto(base + path);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: shots + "/e2e-" + name + "-" + size + ".png", fullPage: true });
    }
    await ctx.close();
  }
  log("screenshots written to " + shots + "/e2e-*.png");

  // Restore the default balance so reruns start from the same rules.
  const { maxHp, inactivityMs, quickDuel, abilities } = defaultConfig();
  await adminApi(cookies.owner, {
    action: "config",
    patch: { maxHp, inactivityMs, quickDuel, abilities },
    baseVersion: (await adminApi(cookies.owner)).data.configVersion,
    note: "e2e: restore defaults",
  });
  assert.deepEqual(errors, []);
  console.log("E2E PASS");
} finally {
  await browser.close();
}
