// ChannelRoom and AuthStore against real SQLite (node:sqlite) behind a minimal fake DO context.
// Run with: node --import ./tests/register.ts --test tests/channel.test.ts
import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import type { SQLInputValue } from "node:sqlite";
import { ChannelRoom } from "../server/channel.ts";
import { AuthStore } from "../server/auth.ts";
import { logRoomError } from "../server/developer.ts";
import { createInitialState, defaultConfig } from "../server/game.ts";
import { makePng, b64 } from "./upload-helpers.ts";
import { effectiveStats } from "../server/upgrades.ts";
import { LATEST_RELEASE } from "../server/release.ts";
import { tierBoost, petOf, PETS, boostText, cleanBoost, parseRoll, rollLegendary } from "../server/pets.ts";
import { asEnv, fakeCtx, fullStats, must } from "./fakes.ts";
import type { FakeSocketLike, FakeState, Loose } from "./fakes.ts";
import type { Duel, GameState } from "../server/model.ts";

const SECRET = "test-only-internal-secret-0123456789";
const SITE = "https://test.example/?channel=nesszerra";
const DEV = { DEV_TOOLS_TOKEN: "x".repeat(40) };
const noFighter = (who: string) => `@${who}, you have no fighter in the arena yet! Gear up at ${SITE}`;
const noRival = (who: string) => `@${who} has no fighter in the arena yet! Send them to ${SITE}`;

/** A hibernatable WebSocket stand-in: records what the room sends and how it closed it. */
type FakeSocket = FakeSocketLike & {
  // Loose: the frames are the room's JSON messages, which tests read by property
  sent: Loose[];
  closed: [number | undefined, string | undefined] | null;
  att: unknown;
  send(m: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(a: unknown): void;
  deserializeAttachment(): unknown;
};

function fakeSocket(attachment: unknown, tag: string): FakeSocket {
  return {
    tags: [tag],
    readyState: 1,
    sent: [],
    closed: null,
    att: attachment,
    send(m) {
      this.sent.push(JSON.parse(m));
    },
    close(code, reason) {
      this.closed = [code, reason];
      this.readyState = 3;
    },
    serializeAttachment(a) {
      this.att = a;
    },
    deserializeAttachment() {
      return this.att;
    },
  };
}

type CallOptions = { method?: string; body?: unknown; userId?: string | undefined; secret?: string };
type Extra = Record<string, unknown>;
type Actor = { actorId?: string; actorName?: string };
// Loose: a leaderboard or player row from a JSON reply; tests read whichever fields they assert on
type Ranked = Loose;
// Loose: a console.error or dev-log record; tests read message and context fields
type LogRow = Loose;
/** A StreamElements call: `key` overrides the room's key; false leaves the origin, messageId or displayName out. */
type SeOptions = { key?: string; origin?: false; messageId?: string | false; displayName?: false } & Extra;
/** SeOptions for a bare call: no origin, messageId or displayName. */
const BARE: SeOptions = { origin: false, messageId: false, displayName: false };
const OWNER: Actor = { actorId: "owner1", actorName: "nesszerra" };

// as: WebSocketPair and WebSocketRequestResponsePair are Workers globals declared outside globalThis's type; tests swap
// in fakes and restore them
const workerGlobals = globalThis as unknown as { WebSocketPair?: unknown; WebSocketRequestResponsePair?: unknown };

/** A completed duel, which always carries the time the stream reveals it (Duel types revealAt as optional). */
type Revealed = Duel & { revealAt: number };

const BOT = "u9"; // the bot account's id, under either login
const LOGIN_IDS: Record<string, string> = { alice: "u1", bob: "u2", cara: "u3", dan: "u4", pixbot: BOT, pixfray: BOT };
/** The chatter fields of an EventSub chat message. */
const chatter = (id: string, who: string) => ({ chatter_user_id: id, chatter_user_login: who, chatter_user_name: who });

/** A ChannelRoom with request helpers for the tests; its fake context stays readable. */
class TestRoom extends ChannelRoom {
  declare ctx: FakeState;
  #events = 0;
  #seCalls = 0;
  #seKey = "";

  call = async (path: string, { method = "GET", body, userId, secret = SECRET }: CallOptions = {}) => {
    const headers: Record<string, string> = { "X-Mini-Internal": secret, "X-Mini-Channel": "nesszerra" };
    if (userId) headers["X-Mini-User-Id"] = userId;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init = { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
    const res = await this.fetch(new Request("https://room" + path, init));
    const type = res.headers.get("content-type") || "";
    // Loose: the room's JSON (or text) reply, which each test reads by property and asserts on
    return { status: res.status, body: type.includes("json") ? await res.json<Loose>() : await res.text() };
  };
  post = (path: string, body: unknown, userId?: string) => this.call(path, { method: "POST", body, userId });
  save = (id: string, login: string, extra: Extra = {}) => {
    const look = { avatar: "player", color: "#123456", defaultAbility: "strike" };
    return this.post("/profile", { userId: id, username: login, displayName: login, ...look, ...extra }, id);
  };
  /** Saves each login in turn under its id in LOGIN_IDS. */
  saveAll = async (...logins: string[]) => {
    for (const login of logins) await this.save(must(LOGIN_IDS[login]), login);
  };
  shop = (userId: string, kind: string, id = "", extra: Extra = {}) =>
    this.post("/shop", { userId, kind, id, ...extra }, userId);
  // Chat arrives as verified EventSub messages that the Worker forwards to POST /eventsub.
  connectChat = (subscriptionId = "sub-1", status = "enabled") =>
    this.post("/chat", { action: "connected", subscriptionId, status, createdAt: Date.now() });
  disconnect = () => this.post("/chat", { action: "disconnected", reason: "disconnected" });
  notify = (messageType: string, extra: Extra = {}) => {
    const delivery = { messageId: "e" + ++this.#events, messageType, subscriptionType: "channel.chat.message" };
    const subscription = { id: "sub-1", status: "enabled" };
    return this.post("/eventsub", { ...delivery, timestamp: Date.now(), subscription, event: null, ...extra });
  };
  chat = (id: string, login: string, text: string, { color = "#FF4500", ...extra }: { color?: string } & Extra = {}) =>
    this.notify("notification", {
      event: {
        broadcaster_user_login: "nesszerra",
        ...chatter(id, login),
        message_id: "m" + (this.#events + 1),
        message: { text },
        color,
      },
      ...extra,
    });
  live = () => {
    const ws = fakeSocket({ kind: "live", channel: "nesszerra" }, "live");
    this.ctx.sockets.push(ws);
    return ws;
  };
  state = () => this.readState("nesszerra");
  edit = (change: (s: GameState) => void) => {
    const s = this.state();
    change(s);
    this.writeState(s);
  };
  player = (userId: string) => must(this.state().players.find((p) => p.userId === userId));
  // as: a completed duel always carries its reveal time; paid is the room's own field on top of Duel
  completed = () => must(this.state().duels.find((d) => d.status === "completed")) as Revealed & { paid?: boolean };
  /** Clears rematch locks and knockouts so the same fighters can duel again at once. */
  rested = () =>
    this.edit((s) => {
      s.rematchLocks = [];
      for (const p of s.players) p.respawnAt = 0;
    });
  // Loose: SQL rows, read by column
  sql = (query: string, ...params: SQLInputValue[]): Loose[] => this.ctx.storage.sql.exec(query, ...params).toArray();
  profile = async (userId: string) => (await this.call("/profile?userId=" + userId)).body;
  admin = (action: string, payload?: unknown, { actorId = "mod1", actorName }: Actor = {}) =>
    this.post("/admin", { actorId, actorName, action, payload });
  adminView = async () => (await this.call("/admin")).body;
  cfg = (patch: Extra) => this.admin("config", { patch });
  seAdmin = (body: Extra) => {
    if (body.action === "rotateSeKey") this.#seKey = "";
    return this.post("/se-admin", body);
  };
  se = async (id: string, login: string, action: string, target = "", options: SeOptions = {}) => {
    const { key, origin, messageId, displayName, ...extra } = options;
    this.#seKey ||= (await this.adminView()).streamelements.secret;
    return this.post(origin === false ? "/se" : "/se?origin=https%3A%2F%2Ftest.example", {
      key: key ?? this.#seKey,
      action,
      userId: id,
      username: login,
      target,
      ...(displayName === false ? {} : { displayName: login }),
      ...(messageId === false ? {} : { messageId: messageId ?? "se" + ++this.#seCalls }),
      ...extra,
    });
  };
  reply = async (id: string, login: string, action: string, target = "", options: SeOptions = {}): Promise<string> =>
    (await this.se(id, login, action, target, options)).body.reply;
  /** Runs a StreamElements duel: alice challenges bob and bob accepts (quick duels settle it at once). */
  seDuel = async (options: SeOptions = {}) => {
    await this.se("u1", "alice", "challenge", "bob", options);
    await this.se("u2", "bob", "accept", "", options);
  };
  logs = async (source?: string): Promise<LogRow[]> =>
    (await this.call(source ? "/dev/logs?source=" + source : "/dev/logs")).body;
  board = async (mods?: boolean): Promise<Ranked[]> =>
    (await this.call(mods ? "/leaderboard?private=1" : "/leaderboard")).body;
  devLive = (live: boolean, streamId?: string) => this.post("/dev-live", live ? { live, streamId } : { live });
  devChat = (id: string, login: string, text: string) =>
    this.post("/dev-chat", { userId: id, username: login, displayName: login, text });
}

// HP-fight tests run with quick duels off; pass { quick: true } for the one-hit mode.
function room(env: Extra = {}, { quick = false } = {}) {
  const r = new TestRoom(fakeCtx(), asEnv({ INTERNAL_SECRET: SECRET, ...env }));
  if (!quick) r.writeState({ ...createInitialState("nesszerra"), config: { ...defaultConfig(), quickDuel: false } });
  return r;
}
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
// Loose (Ranked): rows read by property
const ranks = (rows: Ranked[]) => rows.flatMap((p) => [p.elo, p.wins, p.losses]);

test("export: every table a copy needs, BLOBs as base64; a wrong internal secret is refused anywhere", async () => {
  const r = room();
  await r.save("u1", "alice");
  const insert =
    "INSERT INTO custom_characters (id, meta, atlas, bytes, created_by, created_at) VALUES ('c-1', '{}', ?, 3, 'u1', 1)";
  r.sql(insert, new Uint8Array([1, 2, 255]));
  const { status, body } = await r.call("/export");
  // Loose (Ranked): profile rows from the JSON reply
  const usernames = body.profiles.map((p: Ranked) => p.username);
  assert.deepEqual([status, body.game_state[0].channel, usernames], [200, "nesszerra", ["alice"]]);
  assert.deepEqual(body.custom_characters[0].atlas, { $b64: "AQL/" });
  const tables = ["config_history", "se_settings", "builds", "streams", "custom_pets", "owned_items", "viewer_sprites"];
  for (const t of tables) assert.ok(Array.isArray(body[t]), t);
  for (const path of ["/export", "/state"]) assert.equal((await r.call(path, { secret: "wrong" })).status, 403, path);
});

test("profiles are saved server-side, identity must match the session user, and a renamed login can be reused", async () => {
  const r = room();
  const body = { userId: "u2", username: "x", avatar: "player", color: "#123456", defaultAbility: "heal" };
  assert.equal((await r.post("/profile", body, "u1")).status, 403);
  const saved = await r.save("u1", "alice", { defaultAbility: "heavy" });
  assert.deepEqual([saved.status, saved.body.profile.defaultAbility], [200, "heavy"]);
  const got = await r.profile("u1");
  assert.deepEqual([got.username, got.elo], ["alice", 1000]);
  assert.equal(await r.profile("nobody"), null);
  // Another account may take over a login its old owner renamed away from.
  assert.equal((await r.save("u2", "alice")).status, 200);
  assert.equal((await r.profile("u2")).username, "alice");
});

test("chat commands run a full duel; Elo persists to the leaderboard; overlays get snapshots", async () => {
  const r = room();
  await r.saveAll("alice", "bob");
  const live = r.live();
  assert.equal((await r.connectChat()).body.chatStatus.connected, true);
  assert.equal((await r.chat("u1", "alice", "!challenge @bob")).body.ok, true);
  const accepted = await r.chat("u2", "bob", "!accept");
  assert.deepEqual([accepted.status, accepted.body.ok], [200, true]);
  for (let i = 0; i < 4; i++) {
    await r.chat("u1", "alice", "!heavy");
    // The first heavy succeeds; later ones hit the 5 s cooldown. Force the cooldown clear for the test.
    const s = r.state();
    const duel = s.duels.find((d) => d.status === "active");
    if (!duel) break;
    must(duel.cooldowns).u1 = { sharedUntil: 0, strikeUntil: 0, heavyUntil: 0, healUntil: 0 };
    r.writeState(s);
  }
  const state = (await r.call("/state")).body;
  const [duel] = state.duels;
  assert.deepEqual([duel.status, duel.winnerId, state.round, state.chat.connected], ["completed", "u1", 1, true]);
  assert.ok(state.chat.lastSeen > 0, "last notification time is recorded");
  const board = await r.board();
  const names = board.map((p) => p.username);
  assert.deepEqual(names, ["alice", "bob"]);
  assert.deepEqual(ranks(board), [1012, 1, 0, 988, 0, 1]);
  assert.ok(!board.some((p) => "dollars" in p), "dollars stay off the public leaderboard");
  const modsSee = (await r.board(true)).every((p) => Number.isInteger(p.dollars));
  assert.ok(modsSee, "mods see them");
  assert.ok(live.sent.length > 3);
  const last = live.sent.at(-1);
  assert.deepEqual([last.type, last.revision], ["snapshot", state.revision]);
  assert.equal("appliedMessageIds" in last, false, "internal bookkeeping is not broadcast");
  assert.equal("relay" in last, false);
});

test("chat bots like StreamElements never join the arena", async () => {
  const r = room();
  await r.connectChat();
  assert.equal((await r.chat("b1", "streamelements", "Thank you for following!")).body.reason, "chat_bot");
  assert.equal((await r.chat("b2", "nightbot", "!challenge @alice")).body.reason, "chat_bot");
  assert.equal((await r.chat("b3", "pixfray", "Fight on: alice vs bob!")).body.reason, "chat_bot");
  assert.equal(r.state().players.length, 0);
});

test("unregistered chatters appear in their Twitch color but cannot duel; rejections are logged", async () => {
  const r = room();
  await r.save("u1", "alice");
  await r.connectChat();
  assert.equal((await r.chat("g1", "guest", "hello chat", { color: "#1e90ff" })).body.reason, "presence_updated");
  assert.equal(r.player("g1").color, "#1E90FF");
  const rejected = await r.chat("g1", "guest", "!challenge @alice");
  assert.deepEqual([rejected.body.ok, rejected.body.reason], [false, "ranked_sign_in_required"]);
  const state = r.state();
  const last = must(state.events.at(-1));
  const event = { type: "command_rejected", userId: "g1", command: "duel", reason: "ranked_sign_in_required" };
  assert.deepEqual(last, { id: String(state.revision), ...event, at: last.at });
  // registered players keep their saved color, whatever Twitch says
  await r.chat("u1", "alice", "hi", { color: "#00FF00" });
  assert.equal(r.player("u1").color, "#123456");
});

test("plain chat refreshes presence at most every 30 s", async () => {
  const r = room();
  await r.connectChat();
  await r.chat("g1", "guest", "one");
  const rev = r.state().revision;
  assert.equal((await r.chat("g1", "guest", "two")).body.reason, "presence_fresh");
  assert.equal(r.state().revision, rev, "no event and no broadcast");
});

test("replayed EventSub messages are ignored; other subscriptions and offline chat are refused", async () => {
  const r = room();
  await r.saveAll("alice", "bob");
  const send = async (messageId: string, id = "sub-1") =>
    (await r.chat("u1", "alice", "!challenge @bob", { messageId, subscription: { id, status: "enabled" } })).body;
  assert.equal((await send("x0")).reason, "unknown_subscription", "nothing is processed before Connect chat");
  await r.connectChat();
  assert.equal((await send("x1")).ok, true);
  const rev = r.state().revision;
  assert.deepEqual(await send("x1"), { ok: true, duplicate: true });
  assert.deepEqual([r.state().revision, r.state().duels.length], [rev, 1]);
  assert.equal((await send("x2", "sub-stale")).reason, "unknown_subscription");
});

test("webhook verification connects chat in either order; revocation records the reason", async () => {
  const r = room();
  const pending = "webhook_callback_verification_pending";
  // verification first, then the create response
  await r.notify("webhook_callback_verification", { subscription: { id: "sub-1", status: pending } });
  assert.equal((await r.call("/state")).body.chat.connected, false);
  assert.equal((await r.connectChat("sub-1", pending)).body.chatStatus.connected, true);
  const other = await r.notify("revocation", { subscription: { id: "sub-old", status: "authorization_revoked" } });
  assert.equal(other.body.ignored, true, "a revocation for another subscription is ignored");
  await r.saveAll("alice", "bob");
  await r.chat("u1", "alice", "!challenge @bob");
  await r.chat("u2", "bob", "!accept");
  await r.notify("revocation", { subscription: { id: "sub-1", status: "authorization_revoked" } });
  const state = (await r.call("/state")).body;
  assert.deepEqual([state.paused, state.duels[0].cancelReason], [true, "chat_disconnected"]);
  const { chatStatus } = await r.adminView();
  assert.deepEqual([chatStatus.connected, chatStatus.lastRevocationReason], [false, "authorization_revoked"]);
  // create response first, then verification
  await r.connectChat("sub-2", pending);
  assert.equal((await r.call("/chat")).body.connected, false);
  await r.notify("webhook_callback_verification", { subscription: { id: "sub-2", status: pending } });
  assert.deepEqual([(await r.call("/chat")).body.connected, (await r.call("/chat")).body.status], [true, "enabled"]);
});

test("chat disconnect cancels open duels without scoring", async () => {
  const r = room();
  await r.saveAll("alice", "bob");
  await r.connectChat();
  await r.chat("u1", "alice", "!challenge @bob");
  await r.chat("u2", "bob", "!accept");
  await r.chat("u1", "alice", "!strike");
  assert.equal((await r.disconnect()).body.reason, "chat_disconnected");
  const state = (await r.call("/state")).body;
  assert.deepEqual([state.duels[0].status, state.duels[0].cancelReason], ["cancelled", "chat_disconnected"]);
  assert.deepEqual([state.paused, state.events.at(-1).type], [true, "chat_disconnected"]);
  assert.ok((await r.board()).every((p) => p.elo === 1000 && p.wins === 0 && p.losses === 0));
  assert.equal((await r.chat("u1", "alice", "!challenge @bob")).body.reason, "unknown_subscription");
});

/** A room wired to a real AuthStore, with Twitch's token and Helix endpoints faked; `helix` sets the Helix answer. */
function helixRoom(t: TestContext) {
  const store = new AuthStore(fakeCtx(), asEnv({ INTERNAL_SECRET: SECRET }));
  const fetch = (url: string, init?: RequestInit) => store.fetch(new Request(url, init));
  const app = { AUTH_SECRET: "a".repeat(64), TWITCH_CLIENT_ID: "client-id", TWITCH_CLIENT_SECRET: "client-secret" };
  const r = room({ AUTH: { idFromName: () => "auth", get: () => ({ fetch }) }, ...app });
  const calls: string[] = [];
  const fake = { r, calls, helix: (): Response => Response.json({ data: [], pagination: {} }) };
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    fake.calls.push(String(url));
    if (String(url).startsWith("https://id.twitch.tv/oauth2/token"))
      return Response.json({ access_token: "app-token", expires_in: 3600 });
    return fake.helix();
  });
  return fake;
}

test("the hourly alarm re-checks the Helix subscription and disconnects only on a definite answer", async (t) => {
  const fake = helixRoom(t);
  const { r, calls } = fake;
  fake.helix = () => Response.json({ data: [{ id: "sub-1", status: "enabled" }], pagination: {} });
  await r.connectChat();
  assert.ok(must(r.ctx.storage.alarm) <= Date.now() + 3_600_000 + 50, "the check is scheduled at most an hour out");
  await r.alarm();
  assert.equal(calls.length, 0, "not due yet: no Helix call");
  const age = () => r.edit((s) => (s.chat.checkedAt = Date.now() - 3_600_001));
  age();
  await r.alarm();
  assert.equal(calls.filter((u) => u.includes("/helix/eventsub/subscriptions")).length, 1);
  assert.equal((await r.call("/chat")).body.connected, true);
  fake.helix = () => new Response("down", { status: 503 });
  age();
  await r.alarm();
  assert.equal((await r.call("/chat")).body.connected, true, "a failed check changes nothing");
  fake.helix = () => Response.json({ data: [], pagination: {} });
  age();
  await r.alarm();
  const status = (await r.call("/chat")).body;
  assert.deepEqual([status.connected, status.lastRevocationReason], [false, "subscription_missing"]);
  const tokens = calls.filter((u) => u.startsWith("https://id.twitch.tv")).length;
  assert.equal(tokens, 1, "the app token is cached sealed in AuthStore");
});

test("a subscription stuck awaiting verification is re-checked within minutes and a failed verification is recorded", async (t) => {
  const fake = helixRoom(t);
  const { r } = fake;
  let status = "webhook_callback_verification_pending";
  fake.helix = () => Response.json({ data: [{ id: "sub-1", status }], pagination: {} });
  await r.connectChat("sub-1", status);
  const soon = must(r.ctx.storage.alarm) <= Date.now() + 5 * 60_000;
  assert.ok(soon, "a pending subscription is checked within minutes, not an hour");
  const age = () => r.edit((s) => (s.chat.checkedAt = Date.now() - 3 * 60_000 - 1));
  age();
  await r.alarm();
  let chat = (await r.call("/chat")).body;
  assert.deepEqual([chat.connected, chat.subscriptionId], [false, "sub-1"], "still pending: unchanged");
  assert.ok((r.ctx.storage.alarm ?? 0) > Date.now() + 60_000, "the next pending check waits another interval");
  status = "webhook_callback_verification_failed";
  age();
  await r.alarm();
  chat = (await r.call("/chat")).body;
  assert.deepEqual([chat.connected, chat.subscriptionId, chat.lastRevocationReason], [false, "", status]);
  assert.equal(r.ctx.storage.alarm, null, "no further checks once disconnected");
  // a pending subscription that Twitch reports enabled (verification message lost) becomes connected
  await r.connectChat("sub-1", "webhook_callback_verification_pending");
  status = "enabled";
  age();
  await r.alarm();
  assert.equal((await r.call("/chat")).body.connected, true);
});

test("an expired rematch lock is saved away, so the alarm doesn't re-arm for now", async () => {
  const r = room();
  await r.save("u1", "alice");
  r.edit((s) => (s.rematchLocks = [{ pair: "u1:u2", until: Date.now() - 1 }]));
  await r.alarm();
  assert.deepEqual(r.state().rematchLocks, [], "the expired lock is gone from storage");
  const next = r.ctx.storage.alarm;
  assert.ok(next === null || next > Date.now() + 1000, "no alarm due again right away");
});

test("the room log says why each alarm ran, and keeps duel events and chat counts", async (t) => {
  for (const level of ["log", "warn", "error"] as const) t.mock.method(console, level, () => {});
  const r = room();
  await r.saveAll("alice", "bob");
  await r.connectChat();
  await r.chat("u1", "alice", "!challenge @bob");
  r.edit((s) => (s.rematchLocks = [{ pair: "u1:u3", until: Date.now() - 1 }]));
  await r.alarm();
  const log = (source: string) =>
    r.sql("SELECT message FROM error_log WHERE source = ? ORDER BY id", source).map((x) => x.message);
  assert.ok(log("alarm").includes("ran rematch_lock"), log("alarm").join(" | "));
  assert.ok(log("alarm").some((m) => m.startsWith("set challenge_expiry")));
  assert.ok(log("duel").includes("challenge_created"));
  assert.ok(log("chat").includes("chat_connected"));
  const today = (await r.call("/dev/stats")).body.days[0].counts;
  const counts = [today.eventsub_notification, today.event_challenge_created, today.alarms];
  assert.deepEqual(counts, [1, 1, 1]);
  assert.ok(today.requests >= 5);
});

test("versioned config editor: history, optimistic version check, rollback", async () => {
  const r = room();
  const patch = { abilities: { heavy: { damage: 30 } } };
  const a = await r.admin("config", { baseVersion: 1, patch, note: "buff heavy" }, { actorName: "ModOne" });
  assert.deepEqual([a.status, a.body.configVersion], [200, 2]);
  assert.equal((await r.admin("config", { baseVersion: 1, patch: { maxHp: 150 } })).status, 409);
  assert.equal((await r.cfg({ maxHp: -1 })).status, 400);
  const view = await r.adminView();
  // Loose (Ranked): config history rows from the JSON reply
  const history = view.history.flatMap((h: Ranked) => [h.version, h.actorId, h.note]);
  assert.deepEqual(history, [2, "mod1", "buff heavy", 1, "system", "initial"]);
  assert.equal(view.history[0].config.abilities.heavy.damage, 30);
  assert.equal(view.history[0].actorName, "ModOne", "history keeps the actor display name");
  assert.deepEqual(view.customUsage, { count: 0, limit: 24, bytes: 0 });
  const rb = await r.admin("rollbackConfig", { version: 1 });
  assert.deepEqual([rb.status, rb.body.configVersion], [200, 3]);
  const after = await r.adminView();
  assert.deepEqual([after.config.abilities.heavy.damage, after.history[0].note], [35, "rollback to v1"]);
  assert.equal((await r.admin("rollbackConfig", { version: 99 })).status, 404);
  // A version saved before a setting existed (here: the Stage 4 prices) restores that setting's default.
  const old = JSON.parse(must(r.sql("SELECT config FROM config_history WHERE version = 1")[0]).config);
  delete old.trailPrice;
  delete old.buildSlotPrice;
  r.sql("UPDATE config_history SET config = ? WHERE version = 1", JSON.stringify(old));
  const cheap = await r.admin("config", { baseVersion: 3, patch: { trailPrice: 7, buildSlotPrice: 11 } });
  assert.equal(cheap.status, 200);
  assert.equal((await r.admin("rollbackConfig", { version: 1 })).status, 200);
  const { config } = await r.adminView();
  const prices = [config.trailPrice, config.buildSlotPrice];
  assert.deepEqual(prices, [40, 60], "a setting missing from the old version goes back to its default");
});

test("rank reset reaches stored profiles; removePlayer deletes the profile", async () => {
  const r = room();
  await r.save("u1", "alice");
  r.sql("UPDATE profiles SET elo = 1300, wins = 9 WHERE user_id = ?", "u1");
  await r.save("u2", "bob");
  assert.equal((await r.admin("resetRank", { userId: "u1" })).status, 200);
  assert.equal((await r.profile("u1")).elo, 1000);
  assert.equal((await r.admin("removePlayer", { userId: "u2" })).status, 200);
  assert.equal(await r.profile("u2"), null);
  assert.equal((await r.post("/admin", { action: "resetAll" })).status, 403);
});

test("restoreRank sets a fighter's stored rank, offline or active, and logs who did it", async () => {
  const r = room();
  await r.saveAll("alice", "bob");
  r.edit((s) => (s.players = s.players.filter((p) => p.userId !== "u1")));
  const restore = (payload: Extra) => r.admin("restoreRank", payload, { actorId: "1", actorName: "owner" });
  assert.equal((await restore({ userId: "u1", elo: 1016, wins: 3, losses: 3 })).status, 200);
  assert.equal((await restore({ userId: "u2", elo: 1042, wins: 5, losses: 1 })).status, 200);
  assert.deepEqual(ranks([await r.profile("u1"), await r.profile("u2")]), [1016, 3, 3, 1042, 5, 1]);
  assert.deepEqual(ranks([r.player("u2")]), [1042, 5, 1]);
  const bad = await restore({ userId: "u1", elo: 1016.5, wins: 3, losses: 3 });
  assert.deepEqual([bad.status, bad.body.reason], [400, "invalid_rank"]);
  assert.equal((await restore({ userId: "nobody", elo: 1000, wins: 0, losses: 0 })).body.reason, "profile_not_found");
  const logs = (await r.logs("command")).filter((x) => x.context?.action === "restoreRank").map((x) => x.message);
  assert.deepEqual(logs, ["owner restored rank 1042/5/1 -> u2", "owner restored rank 1016/3/3 -> u1"]);
});

test("rank history records every rank change, and restoreRank can go back to before a time", async () => {
  const r = room();
  await r.save("u1", "alice");
  r.sql("UPDATE profiles SET elo = 1106, wins = 14, losses = 9 WHERE user_id = ?", "u1");
  await sleep(5);
  const mark = Date.now();
  await sleep(5);
  await r.save("u1", "alice", { color: "#654321" });
  await r.admin("resetRank", { userId: "u1" });
  const history = async (user: string) => ranks((await r.call("/dev/ranks?user=" + user)).body);
  assert.deepEqual(await history("Alice"), [1000, 0, 0, 1106, 14, 9, 1000, 0, 0]);
  assert.deepEqual(await history("u1"), await history("alice"), "by login or by id");
  const restore = (payload: Extra) => r.admin("restoreRank", payload, { actorId: "1", actorName: "owner" });
  assert.equal((await restore({ userId: "u1", before: mark })).status, 200);
  const p = await r.profile("u1");
  assert.deepEqual([p.elo, p.wins, p.losses, p.color], [1106, 14, 9, "#654321"]);
  const none = await restore({ userId: "u1", before: 0 });
  assert.deepEqual([none.status, none.body.reason], [404, "no_rank_history"]);
  assert.equal((await r.call("/dev/ranks")).body.reason, "invalid_user");
});

test("rank history starts from the current ranks in a room that had fighters before it", async () => {
  const r = room();
  await r.save("u1", "alice");
  r.sql("UPDATE profiles SET elo = 1042, wins = 5, losses = 1 WHERE user_id = ?", "u1");
  for (const name of ["rank_log_insert", "rank_log_update"]) r.sql("DROP TRIGGER " + name);
  r.sql("DROP TABLE rank_log");
  const again = new ChannelRoom(r.ctx, asEnv({ INTERNAL_SECRET: SECRET }));
  const rows = again.ctx.storage.sql.exec("SELECT user_id, elo, wins, losses FROM rank_log").toArray();
  assert.deepEqual(rows, [{ user_id: "u1", elo: 1042, wins: 5, losses: 1 }]);
});

test("looks push: profile writes for viewers off the active list reach open overlays", async () => {
  const r = room();
  await r.saveAll("alice", "bob");
  r.sql("UPDATE profiles SET elo = 1300 WHERE user_id = ?", "u1");
  r.edit((s) => (s.players = s.players.filter((p) => p.userId !== "u1"))); // alice went quiet; bob is still listed
  const live = r.live();
  const looks = () => live.sent.filter((m) => m.type === "looks");
  await r.admin("resetRank", { userId: "u1" });
  await sleep(5);
  const pushed = looks().flatMap((m) => [Object.keys(m.looks), m.looks.alice.elo, m.looks.alice.color]);
  assert.deepEqual(pushed, [["alice"], 1000, "#123456"]);
  await r.admin("resetRank", { userId: "u2" });
  await sleep(5);
  assert.equal(looks().length, 1, "bob is on the active list, so the snapshot carries him");
  await r.admin("resetAllRanks");
  await sleep(5);
  assert.equal(looks().at(-1).reset, true);
  r.deleteProfile("u1");
  await sleep(5);
  assert.deepEqual(looks().at(-1).looks, { alice: null });
  const noRevision = live.sent.every((m) => m.type !== "looks" || !("revision" in m));
  assert.ok(noRevision, "a looks message is not a snapshot");
});

test("catalog, assets and dev routes answer inside the room; uploads validate", async () => {
  const r = room();
  assert.deepEqual((await r.call("/catalog")).body, []);
  assert.equal((await r.call("/asset/c-missing")).status, 404);
  assert.equal((await r.call("/asset")).body.usage.limit, 24);
  const bad = await r.post("/asset", {});
  assert.deepEqual([bad.status, bad.body.reason], [400, "invalid_label"]);
  const diag = (await r.call("/dev/diagnostics")).body;
  assert.deepEqual([diag.channel, diag.sockets], ["nesszerra", { live: 0 }]);
  const idle = { connected: false, source: "", status: "disconnected", subscriptionId: "", createdAt: 0 };
  assert.deepEqual(diag.chatStatus, { ...idle, lastNotificationAt: 0, lastRevocationReason: "", checkedAt: 0 });
  logRoomError(r, new Error("boom"), { path: "/x" });
  assert.equal((await r.logs())[0].message, "boom");
});

test("AuthStore consume returns a value exactly once", async () => {
  const store = new AuthStore(fakeCtx(), asEnv({ INTERNAL_SECRET: SECRET }));
  const call = async (path: string, method: string, body?: unknown) => {
    const headers = { "X-Mini-Internal": SECRET, "Content-Type": "application/json" };
    const init = { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) };
    return (await store.fetch(new Request("https://auth" + path, init))).json();
  };
  await call("/entry?key=pair:abc", "POST", { value: { channel: "nesszerra" }, expires: Date.now() + 60_000 });
  const results = await Promise.all([call("/consume?key=pair:abc", "POST"), call("/consume?key=pair:abc", "POST")]);
  assert.deepEqual(results.filter(Boolean), [{ channel: "nesszerra" }]);
  await call("/entry?key=pair:old", "POST", { value: { channel: "nesszerra" }, expires: Date.now() + 5 });
  await sleep(10);
  assert.equal(await call("/consume?key=pair:old", "POST"), null);
  assert.equal(await call("/entry?key=pair:old", "GET"), null, "expired code is gone after consume");
});

test("StreamElements commands run a duel with chat replies; the key and command names are enforced", async () => {
  const r = room();
  const se = (await r.adminView()).streamelements;
  assert.match(se.secret, /^[0-9a-f]{48}$/);
  assert.equal(se.names.accept, "!fight");
  const alice = (action: string, target = "") => r.reply("u1", "alice", action, target);
  assert.deepEqual([se.lastCommandAt, se.rejectedAt], [0, 0], "no command has reached the room yet");
  assert.equal((await r.se("u1", "alice", "challenge", "bob", { key: "wrong" })).status, 403);
  const rejected = (await r.adminView()).streamelements;
  assert.deepEqual([rejected.lastCommandAt, rejected.rejectedAt > 0], [0, true], "a wrong key is recorded");
  assert.equal(se.duelModuleOff, false);
  assert.deepEqual(se.seen, {});
  // The first command with the right key makes StreamElements the chat source. A sign-in refusal names who is missing a fighter.
  const first = (await r.se("u1", "alice", "challenge", "bob")).body;
  assert.deepEqual(first, { reply: noFighter("alice") }, "no Twitch subscription to drop");
  assert.equal((await r.adminView()).chatStatus.source, "streamelements");
  assert.ok((await r.adminView()).streamelements.lastCommandAt > 0, "a command with the right key is recorded");
  const seen = Object.keys((await r.adminView()).streamelements.seen);
  assert.deepEqual(seen, ["challenge"], "each command is marked as seen");
  await r.save("u1", "alice");
  assert.equal(await alice("challenge", "bob"), noRival("bob"));
  await r.save("u2", "bob");
  assert.equal(await alice("challenge"), "Challenge who? Name your rival: !challenge @name");
  const shadow = "alice, you can't fight your own shadow! Name a rival: !challenge @name";
  assert.equal(await alice("challenge", "alice"), shadow);
  const challenged = "alice challenges @bob! @bob, type !fight to fight or !decline to back out within 30 s.";
  assert.equal(await alice("challenge", "bob"), challenged);
  // Quick duels are off in this room, but StreamElements has no attack commands, so !fight settles the duel at once.
  assert.equal(await r.reply("u2", "bob", "accept"), "Fight on: alice vs bob! Watch the stream for the winner.");
  assert.equal(r.state().duels.filter((d) => d.status === "active").length, 0);
  assert.equal(await alice("heavy"), "Lost in the arena? Type !fray");
  // Renamed commands show up in replies; duplicates and bad names are refused.
  const renamed = await r.seAdmin({ action: "setSeNames", names: { accept: "!yes", decline: "no" } });
  assert.equal(renamed.body.streamelements.names.decline, "!no");
  for (const accept of ["!challenge", "bad name"])
    assert.equal((await r.seAdmin({ action: "setSeNames", names: { accept } })).status, 400, accept);
  const rotated = (await r.seAdmin({ action: "rotateSeKey" })).body.streamelements;
  assert.notEqual(rotated.secret, se.secret);
  assert.deepEqual([rotated.lastCommandAt, rotated.rejectedAt, rotated.seen], [0, 0, {}], "a new key starts unheard");
  assert.equal((await r.se("u1", "alice", "decline", "", { key: se.secret })).status, 403);
  // Disconnecting the StreamElements source never calls Twitch and pauses duels.
  await r.disconnect();
  assert.match(await alice("decline"), /arena is closed/);
});

test("the first StreamElements command moves a Twitch-chat channel over, but not one a mod turned off; seen times are throttled", async () => {
  const r = room({}, { quick: true });
  const cmd = (action: string) => r.se("u1", "alice", action);
  await r.connectChat("sub-1");
  await r.save("u1", "alice");
  const first = (await cmd("decline")).body;
  assert.equal(first.switchedFrom, "sub-1", "the Worker deletes the old EventSub subscription");
  assert.match(first.reply, /nobody has challenged you/);
  assert.equal((await r.adminView()).chatStatus.source, "streamelements");
  assert.equal((await cmd("decline")).body.switchedFrom, undefined, "only the switch reports it");
  const seenAt = (await r.adminView()).streamelements.seen.decline;
  await sleep(5);
  await cmd("decline");
  assert.equal((await r.adminView()).streamelements.seen.decline, seenAt, "written at most once a minute per command");
  await cmd("help");
  assert.deepEqual(Object.keys((await r.adminView()).streamelements.seen).sort(), ["decline", "help"]);
  // Disconnect chat on purpose: commands don't turn it back on; Use StreamElements does.
  await r.disconnect();
  assert.match((await cmd("decline")).body.reply, /arena is closed/);
  assert.equal((await r.adminView()).chatStatus.connected, false);
  // The Duel-module tick is saved and survives a new key.
  for (const [body, off] of [
    [{ action: "setDuelModuleOff", value: true }, true],
    [{ action: "rotateSeKey" }, true],
    [{ action: "setDuelModuleOff", value: false }, false],
  ] satisfies [Extra, boolean][])
    assert.equal((await r.seAdmin(body)).body.streamelements.duelModuleOff, off, String(body.action));
});

test("SE_ONLY: a StreamElements command with the right key makes StreamElements the chat source", async () => {
  const r = room({ SE_ONLY: "1" }, { quick: true });
  await r.connectChat("sub-1"); // a Twitch subscription from before the switch
  assert.equal((await r.se("u1", "alice", "decline", "", { key: "wrong" })).status, 403);
  assert.equal((await r.adminView()).chatStatus.source, "twitch", "a wrong key changes nothing");
  assert.doesNotMatch(await r.reply("u1", "alice", "decline"), /closed/);
  assert.equal((await r.adminView()).chatStatus.source, "streamelements");
});

test("StreamElements quick duel: !fight settles it at once, but chat sees the result only after the stream shows it", async (t) => {
  const r = room({}, { quick: true });
  await r.connectChat("se-streamelements");
  await r.saveAll("alice", "bob");
  await r.se("u1", "alice", "challenge", "bob");
  assert.equal(await r.reply("u2", "bob", "accept"), "Fight on: alice vs bob! Watch the stream for the winner.");
  assert.equal(await r.reply("u2", "bob", "accept"), "bob, nobody has challenged you yet. Start one: !challenge @name");
  // Until the overlay has played the duel (plus stream delay), every read shows the pre-fight numbers.
  const duel = r.completed();
  const wait = duel.revealAt - Date.now();
  assert.ok(wait > 6000 && wait < 40_000, "revealed after the replay and the stream delay");
  const before = await r.board();
  assert.deepEqual(ranks(before), [1000, 0, 0, 1000, 0, 0], "leaderboard holds the result back");
  assert.equal(await r.reply("u1", "alice", "elo"), "alice: 1000 Elo, rank 1 of 2, 0 wins and 0 losses.");
  assert.match(await r.reply("u2", "bob", "top"), /^Top 2: 1\. alice 1000 · 2\. bob 1000\./);
  assert.equal((await r.profile("u2")).wins, 0);
  assert.equal((await r.call("/looks?u=alice")).body.alice.elo, 1000);
  // The loser's knockout (hp 0, respawnAt) would name them, so public reads leave it out; so does a website save.
  const standing = before.every((p) => p.hp === 100 && !(p.respawnAt > Date.now()));
  assert.ok(standing, "leaderboard shows nobody knocked out");
  for (const id of ["u1", "u2"]) {
    const p = await r.profile(id);
    assert.ok(p.hp !== 0 && !(p.respawnAt > Date.now()), id);
  }
  const shown = ranks([(await r.save("u1", "alice")).body.profile]);
  assert.deepEqual(shown, [1000, 0, 0], "a save answers with the shown numbers");
  // A third viewer challenging either fighter hears the same thing, so the reply can't tell the winner from the loser.
  await r.save("u3", "cara");
  const busy = "That fight is still playing on stream. Give it a few seconds!";
  for (const target of ["alice", "bob"]) assert.equal(await r.reply("u3", "cara", "challenge", target), busy, target);
  const clock = t.mock.method(Date, "now", () => duel.revealAt + 1);
  const after = await r.board();
  const tally = [after[0].wins, after.at(-1).losses, after[0].elo > 1000, after.at(-1).elo < 1000];
  assert.deepEqual(tally, [1, 1, true, true], "shown once the stream has shown it");
  const rank = after.findIndex((p) => p.username === "alice");
  const elo = await r.reply("u1", "alice", "elo");
  assert.match(elo, new RegExp(`^alice: ${after[rank].elo} Elo, rank ${rank + 1} of 3`));
  clock.mock.restore();
  // The result is saved, so the next command (which reloads the stored profile) keeps it. A flawless win adds 3 Elo.
  const [a, b] = r.sql("SELECT elo, wins, losses FROM profiles WHERE user_id IN ('u1', 'u2') ORDER BY user_id");
  assert.deepEqual([a.wins + b.wins, a.losses + b.losses, [2000, 2003].includes(a.elo + b.elo)], [1, 1, true]);
  assert.notEqual(a.elo, 1000);
  // Every command lands in the dev log with what came in, the game's decision and the reply.
  const log = (await r.logs("command")).filter((x) => x.context.action !== "save");
  const trail = [
    "challenge",
    "quick_duel",
    "challenge_not_found",
    "elo",
    "top",
    "result_hidden",
    "result_hidden",
    "elo",
  ];
  assert.deepEqual(log.map((x) => x.context.reason).reverse(), trail);
  const quick = log.find((x) => x.context.reason === "quick_duel");
  assert.match(quick.context.swings, /^([1-6][hxcm] ?)+$/);
  assert.equal((await r.logs("warn")).length, 0);
  // A result that didn't reach the stored profile is flagged.
  const state = r.state();
  must(state.players.find((p) => p.userId === "u1")).wins += 5;
  r.checkSavedProfiles(state, quick.context.duelId);
  assert.match((await r.logs("warn"))[0].message, /profile for alice not saved/);
});

test("StreamElements !rematch challenges the last opponent, saved with the profile; two !rematch start the duel", async (t) => {
  const r = room({}, { quick: true });
  await r.connectChat("se-streamelements");
  await r.saveAll("alice", "bob", "cara");
  const nobody = "alice, you have nobody to rematch yet. Start one: !challenge @name";
  assert.equal(await r.reply("u1", "alice", "rematch"), nobody);
  await r.se("u1", "alice", "challenge", "bob");
  assert.match(await r.reply("u2", "bob", "accept"), /^Fight on: alice vs bob!/);
  const rows = r.sql("SELECT user_id, last_opponent FROM profiles ORDER BY user_id");
  const opponents = rows.flatMap((x) => [x.user_id, x.last_opponent]);
  assert.deepEqual(opponents, ["u1", "u2", "u2", "u1", "u3", ""]);
  const cooling = /^Rematch in \d+ s! Catch your breath first\.$|^That fight is still playing on stream/;
  assert.match(await r.reply("u2", "bob", "rematch"), cooling);
  // A website save carries no opponent and must not clear it; the game state forgetting the players must not either.
  await r.save("u2", "bob", { color: "#445566" });
  r.edit((s) => {
    s.players = [];
    s.rematchLocks = [];
  });
  const realNow = Date.now;
  const clock = t.mock.method(Date, "now", () => realNow() + 60_000); // past the respawn and the stream reveal
  const named =
    "bob wants a rematch with @alice! @alice, type !rematch or !fight to fight, or !decline to back out within 30 s.";
  assert.equal(await r.reply("u2", "bob", "rematch", "cara"), named, "a name after !rematch is ignored");
  const fighting = "One of you is already fighting! Wait for the bell, then try again.";
  assert.equal(await r.reply("u3", "cara", "challenge", "alice"), fighting);
  const started = "Fight on: bob vs alice! Watch the stream for the winner.";
  assert.equal(await r.reply("u1", "alice", "rematch"), started, "answering !rematch with !rematch starts it");
  clock.mock.restore();
  const logs = (await r.logs("command")).filter((x) => x.context.action !== "save");
  const reasons = logs.map((x) => x.context.reason).reverse();
  const want = ["no_previous_opponent", "challenge", "quick_duel", "rematch", "player_busy", "quick_duel"];
  assert.deepEqual(reasons.toSpliced(3, 1), want);
  assert.match(reasons[3], /^(rematch_cooldown|respawning)$/);
});

test("StreamElements !ranks, !elo, !fray and !look work even while duels are paused", async () => {
  const r = room();
  const names = async () => (await r.adminView()).streamelements.names;
  const se = await names();
  assert.deepEqual([se.top, se.elo, se.help, se.look], ["!ranks", "!elo", "!fray", "!look"]);
  const alice = (action: string, target = "") => r.reply("u1", "alice", action, target);
  const helpLine = `PixFray duels: name your rival with !challenge @name. They answer !fight. Again? !rematch. More: !checkin !wallet !ranks !look. Gear up at ${SITE}`;
  assert.equal(await alice("help"), helpLine);
  assert.equal(await alice("top"), `The arena has no champions yet! Gear up at ${SITE} and win a duel.`);
  assert.equal(await alice("elo"), noFighter("alice"));
  assert.equal(await alice("look"), `@alice, pick your fighter here: ${SITE}#fighter`);
  await r.saveAll("alice", "bob", "cara");
  assert.equal(await alice("look"), `@alice, change your look here: ${SITE}#fighter`);
  r.sql("UPDATE profiles SET elo = 1040, wins = 3, losses = 1 WHERE user_id = 'u2'");
  r.sql("UPDATE profiles SET elo = 990, wins = 0, losses = 1 WHERE user_id = 'u3'");
  assert.equal(await alice("top"), `Top 3: 1. bob 1040 · 2. alice 1000 · 3. cara 990. Full list: ${SITE}#ranks`);
  assert.equal(await alice("elo"), "alice: 1000 Elo, rank 2 of 3, 0 wins and 0 losses.");
  assert.equal(await alice("elo", "bob"), "bob: 1040 Elo, rank 1 of 3, 3 wins and 1 loss.");
  assert.equal(await alice("elo", "zed"), noRival("zed"));
  assert.equal((await r.logs("command"))[0].context.reason, "elo_not_found");
  // Stored names StreamElements' built-ins answer to are moved: its !top and !givepoints (!give) can't be replaced,
  // and !minichat was the name before PixFray.
  for (const [key, stored, now] of [
    ["top", "!top", "!ranks"],
    ["give", "!give", "!pay"],
    ["help", "!minichat", "!fray"],
  ] satisfies [string, string, string][]) {
    await r.seAdmin({ action: "setSeNames", names: { [key]: stored } });
    assert.equal((await names())[key], now, stored);
  }
  // Renamed commands show up in !fray.
  await r.seAdmin({ action: "setSeNames", names: { challenge: "!duel", accept: "!yes" } });
  assert.match(await alice("help"), /!duel @name\. They answer !yes\. Again\? !rematch\. More: /);
});

test("!checkin: once per stream while live, streaks with one free miss a week, milestone bonus; points survive a rank reset", async () => {
  const r = room(DEV, { quick: true });
  assert.equal((await r.adminView()).streamelements.names.checkin, "!checkin");
  const say = (id: string, login: string) => r.reply(id, login, "checkin");
  assert.equal(await say("u1", "alice"), noFighter("alice"));
  await r.saveAll("alice", "bob");
  assert.deepEqual((await r.devLive(false)).body, { ok: true, live: false, streamId: "" });
  assert.equal(await say("u1", "alice"), "Check-ins open while nesszerra is live. See you next stream!");
  await r.devLive(true, "s1");
  const first = `@alice checked in: +1 point (1-stream streak). 1 point, 1 unspent. Spend them at ${SITE}#upgrades`;
  assert.equal(await say("u1", "alice"), first);
  const again = "@alice, you already checked in this stream (1-stream streak). Come back next stream!";
  assert.equal(await say("u1", "alice"), again);
  // Alice misses s4: the free miss keeps her streak. Missing s6 too, within the week, starts it over.
  for (const [stream, who, want] of [
    ["s2", ["u1", "alice"], "+1 point (2-stream streak). 2 points, 2 unspent."],
    ["s3", ["u1", "alice"], "+2 points (3-stream streak, streak bonus). 4 points, 4 unspent."],
    ["s4", ["u2", "bob"], ""],
    ["s5", ["u1", "alice"], "+1 point (4-stream streak, free miss used). 5 points, 5 unspent."],
    ["s6", ["u2", "bob"], ""],
    ["s7", ["u1", "alice"], "+1 point (1-stream streak). 6 points, 6 unspent."],
  ] satisfies [string, [string, string], string][]) {
    await r.devLive(true, stream);
    const reply = await say(...who);
    assert.ok(reply.includes(want), stream + ": " + reply);
  }
  let p = await r.profile("u1");
  assert.deepEqual([p.bonus, p.checkins, p.streak, p.upgrades.points, p.upgrades.fromCheckins], [6, 5, 1, 6, 6]);
  assert.equal(r.player("u1").bonus, 6, "the next duel counts the new points");
  assert.equal((await r.logs("command"))[0].context.reason, "checked_in");
  // The points are spendable, and a rank reset keeps them.
  r.sql("UPDATE profiles SET wins = 3 WHERE user_id = 'u1'");
  const saved = (await r.save("u1", "alice", { stats: { power: 8, guard: 1 } })).body.profile;
  assert.deepEqual([saved.bonus, saved.checkins, saved.streak], [6, 5, 1], "the save answer keeps the streak");
  assert.equal((await r.save("u1", "alice", { stats: { power: 8, guard: 2 } })).body.error, "invalid_upgrades");
  await r.admin("resetRank", { userId: "u1" });
  p = await r.profile("u1");
  assert.deepEqual([p.wins, p.bonus, p.upgrades.points], [0, 6, 6]);
  // Mods tune it: no points per check-in and no streak bonus still count the streak. maxStatLevel takes 1 to 200.
  for (const patch of [{ checkinPoints: 4 }, { streakBonus: "yes" }, { maxStatLevel: 0 }, { maxStatLevel: 2.5 }]) {
    const key = Object.keys(patch)[0];
    assert.equal((await r.cfg(patch)).body.error, "invalid_config_" + key, key);
  }
  assert.equal((await r.cfg({ checkinPoints: 0, streakBonus: false })).status, 200);
  await r.devLive(true, "s8");
  assert.equal(await say("u1", "alice"), "@alice checked in: 2-stream streak. 6 points, all spent.");
  // Long streaks give more at each milestone: +2 at 60 and +3 at 100.
  assert.equal((await r.cfg({ streakBonus: true })).status, 200);
  r.sql("UPDATE profiles SET streak = 59 WHERE user_id = 'u1'");
  await r.devLive(true, "s9");
  const sixty = "@alice checked in: +2 points (60-stream streak, streak bonus). 8 points, all spent.";
  assert.equal(await say("u1", "alice"), sixty);
  r.sql("UPDATE profiles SET streak = 99 WHERE user_id = 'u1'");
  await r.devLive(true, "s10");
  const hundred = "@alice checked in: +3 points (100-stream streak, streak bonus). 11 points, 2 unspent.";
  assert.equal(await say("u1", "alice"), `${hundred} Spend them at ${SITE}#upgrades`);
  assert.equal((await r.cfg({ maxStatLevel: 24 })).status, 200);
  assert.equal((await r.profile("u1")).upgrades.maxLevel, 24);
  // A wrong key never reaches the check-in.
  assert.equal((await r.se("u1", "alice", "checkin", "", { ...BARE, key: "f".repeat(48) })).status, 403);
});

test("dollars: paid once per finished duel and hidden until the stream shows it; mod gifts; !wallet; !give and its limits", async (t) => {
  const r = room(DEV, { quick: true });
  const se = (await r.adminView()).streamelements;
  assert.deepEqual([se.names.wallet, se.names.give], ["!wallet", "!pay"]);
  await r.connectChat("se-streamelements");
  await r.saveAll("alice", "bob", "cara");
  const give = (target: string, amount?: string, [id, login] = ["u3", "cara"]) =>
    r.reply(id, login, "give", target, amount === undefined ? {} : { amount });
  const dollars = () =>
    Object.fromEntries(r.sql("SELECT username, dollars FROM profiles").map((x) => [x.username, x.dollars]));
  await r.seDuel();
  const duel = r.completed();
  const [win, lose] = duel.winnerId === "u1" ? ["alice", "bob"] : ["bob", "alice"];
  const winId = win === "alice" ? "u1" : "u2";
  const paid = dollars();
  assert.deepEqual([paid[win], paid[lose], duel.paid], [5, 3, true], "paid in the same transaction as the result");
  // Until the stream has shown the fight, !wallet and the website show the old balance.
  const wallet = await r.reply("u1", "alice", "wallet");
  assert.equal(wallet, "@alice: $0 PixFray dollars, 0 upgrade points, 0-stream streak.");
  assert.equal((await r.profile("u1")).dollars, 0);
  const point = { stats: { power: 1, guard: 0, luck: 0 } };
  const early = (await r.save(winId, win, point)).body.error;
  assert.equal(early, "invalid_upgrades", "a save cannot spend (or reveal) a win the stream has not shown");
  const clock = t.mock.method(Date, "now", () => duel.revealAt + 1);
  assert.equal((await r.save(winId, win, point)).body.profile.stats.power, 1, "the point is spendable once shown");
  assert.equal(await r.reply(winId, win, "wallet"), `@${win}: $5 PixFray dollars, 1 upgrade point, 0-stream streak.`);
  r.advance("nesszerra", { type: "tick" }, Date.now());
  assert.deepEqual([dollars()[win], dollars()[lose]], [5, 3], "never paid twice");
  clock.mock.restore();
  // A website save and a rank reset keep dollars.
  assert.equal((await r.save("u3", "cara")).body.profile.dollars, 0);
  const gift = (username: string, amount: number) => r.admin("giftDollars", { username, amount }, { actorName: "Mod" });
  const g = (await gift("@Cara", 50)).body;
  assert.deepEqual([g.ok, g.username, g.amount, g.dollars], [true, "cara", 50, 50]);
  for (const n of [0, 10_001]) assert.equal((await gift("cara", n)).body.error, "invalid_amount", `${n}`);
  assert.equal((await gift("nobody", 5)).status, 404);
  assert.equal((await gift("cara", -80)).body.dollars, 0, "taking back never goes below 0");
  await gift("cara", 50);
  assert.match((await r.logs("command"))[0].message, /^Mod gift 50 -> cara$/);
  await r.admin("resetRank", { userId: "u3" });
  assert.equal((await r.save("u3", "cara")).body.profile.dollars, 50, "a rank reset and a save keep dollars");
  // !give: usage, targets and the live check come first.
  assert.equal(await give("alice"), "Give who, and how much? Type !pay @name 10");
  assert.equal(await give("nobody", "5"), noRival("nobody"));
  assert.equal(await give("cara", "5"), "@cara, you can't give dollars to yourself!");
  assert.equal(await give("alice", "5", ["u9", "zed"]), noFighter("zed"));
  await r.devLive(false);
  assert.equal(await give("alice", "5"), "Giving opens while nesszerra is live. See you next stream!");
  await r.devLive(true, "s1");
  assert.equal(await give("alice", "5"), "@cara, finish 5 duels before giving dollars. You have 0 so far.");
  r.sql("UPDATE profiles SET wins = 3, losses = 2 WHERE user_id = 'u3'");
  assert.equal(await give("alice", "60"), "@cara, you only have $50.");
  const before = dollars().alice;
  assert.equal(await give("alice", "$30"), "@cara gave $30 to @alice. You have $20 left.");
  assert.deepEqual([dollars().cara, dollars().alice], [20, before + 30]);
  await gift("cara", 200);
  assert.equal(await give("alice", "80"), "@cara, you can give $70 more this stream.");
  assert.equal(await give("alice", "70"), "@cara gave $70 to @alice. You have $150 left.");
  assert.equal(await give("bob", "1"), "@cara, you gave the most for this stream ($100). Give more next stream!");
  await r.devLive(true, "s2");
  const fresh = await give("bob", "10");
  assert.equal(fresh, "@cara gave $10 to @bob. You have $140 left.", "a new stream starts a new limit");
  const log = await r.logs("command");
  assert.deepEqual([log[0].context.reason, log[0].context.amount], ["given", 10]);
  // The dev chat (test site) answers like the bot would.
  const dev = async (text: string) => (await r.devChat("u3", "cara", text)).body.reply;
  assert.equal(await dev("!wallet"), "@cara: $140 PixFray dollars, 3 upgrade points, 0-stream streak.");
  assert.equal(await dev("!pay @bob 5"), "@cara gave $5 to @bob. You have $135 left.");
  // A wallet at the $1,000,000 cap: a gift that wouldn't fit is refused, and nobody loses dollars.
  await r.devLive(true, "s3");
  r.sql("UPDATE profiles SET dollars = 999990 WHERE user_id = 'u2'");
  assert.equal(await dev("!pay @bob 20"), "@bob can hold only $10 more.");
  assert.deepEqual([dollars().cara, dollars().bob], [135, 999990]);
  assert.equal(await dev("!pay @bob 10"), "@cara gave $10 to @bob. You have $125 left.");
  assert.equal(await dev("!pay @bob 1"), "@bob already holds the most dollars a fighter can.");
  // Mods tune it or turn !give off; payouts follow the config.
  assert.equal((await r.cfg({ winDollars: 101 })).body.error, "invalid_config_winDollars");
  assert.equal((await r.cfg({ giveEnabled: "no" })).body.error, "invalid_config_giveEnabled");
  assert.equal((await r.cfg({ giveEnabled: false, winDollars: 0, lossDollars: 1 })).status, 200);
  assert.equal(await give("bob", "5"), "Giving dollars is off on this channel.");
  await r.save("u4", "dan"); // alice and bob's duel is still hidden from chat
  await r.se("u3", "cara", "challenge", "dan");
  await r.se("u4", "dan", "accept");
  const second = must(r.state().duels.findLast((d) => d.status === "completed"));
  assert.deepEqual(Object.values(must(second.payout)), [1], "no win payout at 0; the loser gets 1");
});

test("!checkin asks Twitch whether the channel is live, keeps the answer a minute, and says try again when Twitch fails", async (t) => {
  const fake = helixRoom(t);
  const { r, calls } = fake;
  fake.helix = () => new Response("down", { status: 503 });
  const say = (id: string, login: string) => r.reply(id, login, "checkin", "", { origin: false, messageId: false });
  await r.saveAll("alice", "bob");
  assert.equal(await say("u1", "alice"), "Couldn't reach Twitch to check the stream. Try again in a minute!");
  assert.equal((await r.profile("u1")).bonus, 0);
  assert.equal((await r.devLive(true)).status, 404, "no pretend streams without the dev token");
  fake.helix = () => Response.json({ data: [{ id: "4242", type: "live", started_at: "2026-10-04T10:00:00Z" }] });
  assert.ok((await say("u1", "alice")).includes("@alice checked in: +1 point"));
  assert.match(await say("u2", "bob"), /^@bob checked in/);
  const lookups = calls.filter((u) => u.includes("/helix/streams?user_login=nesszerra")).length;
  assert.equal(lookups, 2, "the failed lookup was not cached; the live answer is");
  assert.equal(must(r.sql("SELECT stream_id FROM streams")[0]).stream_id, "4242");
});

test("/looks returns saved looks by login for the overlay: saved profiles only, at most 20 logins", async () => {
  const r = room();
  await r.save("u1", "Alice", { avatar: "toon-ghoul", color: "#112233" });
  const looks = (await r.call("/looks?u=alice,nobody,bad%20name,ALICE")).body;
  const blank = { hat: "", pet: "", petTier: "", recolor: "", petColor: "", accessory: "", trail: "", winEffect: "" };
  const alice = { avatar: "toon-ghoul", color: "#112233", ...blank, taunt: "", title: "", displayName: "Alice" };
  assert.deepEqual(looks, { alice: { ...alice, elo: 1000 } });
  assert.deepEqual((await r.call("/looks")).body, {});
  for (let i = 0; i < 25; i++) await r.save("x" + i, "v" + i);
  const many = (await r.call("/looks?u=" + Array.from({ length: 25 }, (_, i) => "v" + i).join(","))).body;
  assert.equal(Object.keys(many).length, 20);
});

test("dev-chat (test site only): refused without DEV_TOOLS_TOKEN; with it, a line plays like real chat and returns the bot reply", async () => {
  const off = room({}, { quick: true });
  await off.connectChat();
  assert.equal((await off.devChat("b1", "testbot_a", "hi")).status, 404);
  const r = room(DEV, { quick: true });
  await r.connectChat();
  await r.save("b1", "testbot_a");
  await r.save("b2", "testbot_b");
  assert.equal((await r.devChat("b2", "testbot_b", "hello")).body.reply, "", "a plain line only refreshes presence");
  const ch = await r.devChat("b1", "testbot_a", "!challenge @testbot_b");
  assert.deepEqual([ch.status, ch.body.ok], [200, true]);
  const fight = (await r.devChat("b2", "testbot_b", "!fight")).body;
  const fightOn = "Fight on: testbot_a vs testbot_b! Watch the stream for the winner.";
  assert.deepEqual([fight.reason, fight.reply], ["quick_duel", fightOn]);
  const fought = r.sql("SELECT wins, losses FROM profiles").filter((p) => p.wins + p.losses === 1);
  assert.equal(fought.length, 2, "Elo and records are saved");
  await r.devLive(true, "s1");
  const checked = (await r.devChat("b1", "testbot_a", "!checkin")).body;
  assert.deepEqual([checked.reason, checked.reply.startsWith("@testbot_a checked in: +1 point")], ["checked_in", true]);
});

test("account age: looked up once per fighter; a duel with an account under 7 days old is just for fun", async () => {
  const r = room({ ...DEV, TWITCH_CLIENT_ID: "cid" }, { quick: true });
  const age: Record<string, number> = { b1: Date.now() - 400 * 86_400_000, b2: Date.now() - 2 * 86_400_000 };
  const looked: string[] = [];
  r.lookupAccount = async (id) => {
    looked.push(id);
    if (id === "b3") throw new Error("helix down");
    return age[id] ?? 0;
  };
  await r.connectChat();
  for (const n of ["1", "2", "3"]) await r.save("b" + n, "testbot_" + "abc"[Number(n) - 1]);
  await r.devChat("b1", "testbot_a", "!challenge @testbot_b");
  const fight = (await r.devChat("b2", "testbot_b", "!fight")).body;
  assert.equal(fight.reason, "quick_duel");
  assert.ok(fight.reply.endsWith("Just for fun (a Twitch account under 7 days old): no Elo or dollars."), fight.reply);
  const records = r.sql("SELECT wins, losses, dollars FROM profiles").map((p) => p.wins + p.losses + p.dollars);
  assert.deepEqual(records, [0, 0, 0]);
  await r.devChat("b1", "testbot_a", "hi");
  assert.deepEqual(looked, ["b1", "b2"], "a known age is not looked up again");
  assert.equal((await r.devChat("b3", "testbot_c", "hi")).status, 200, "a failed lookup does not block chat");
  await r.devChat("b3", "testbot_c", "hi again");
  assert.deepEqual(looked, ["b1", "b2", "b3"], "a failed lookup waits an hour before retrying");
});

/** Runs `open` with a fake WebSocketPair. Node's Response can't build a 101, so the upgrade's own throw is ignored. */
async function withFakePair(open: () => Promise<unknown>) {
  const saved = workerGlobals.WebSocketPair;
  workerGlobals.WebSocketPair = class {
    declare 0: unknown;
    declare 1: FakeSocket;
    constructor() {
      this[0] = {};
      this[1] = fakeSocket(null, "live");
    }
  };
  try {
    await open().catch(() => {});
  } finally {
    workerGlobals.WebSocketPair = saved;
  }
}

test("overlay sockets: one network is capped; a full room drops the oldest viewer socket, never an overlay", async () => {
  const upgrade = (target: TestRoom, ip: string) => {
    const headers = { Upgrade: "websocket", "X-Mini-Client-Ip": ip };
    return target.upgrade(new Request("https://room/live", { headers }), "live", "nesszerra");
  };
  const r = room();
  r.ctx.acceptWebSocket(fakeSocket(null, "live"), ["live", "ip:198.51.100.7", "overlay"]); // the streamer's OBS, first in
  for (let i = 1; i < 16; i++) r.ctx.acceptWebSocket(fakeSocket(null, "live"), ["live", "ip:198.51.100.7"]);
  assert.equal((await upgrade(r, "198.51.100.7")).status, 429);
  for (let i = 16; i < 200; i++) r.ctx.acceptWebSocket(fakeSocket(null, "live"), ["live", "ip:203.0.113." + i]);
  // as: every socket this room accepted is a fakeSocket, which records how it was closed
  const [obs, oldestViewer] = r.ctx.sockets as FakeSocket[];
  await withFakePair(() => upgrade(r, "192.0.2.1")); // the eviction happens before the 101
  assert.deepEqual([must(obs).closed, must(oldestViewer).closed], [null, [1013, "room full"]], "the overlay stays");
  assert.ok(must(r.ctx.sockets.at(-1)).tags.includes("ip:192.0.2.1"), "the new socket is tagged with its network");
  // A room holding only overlays refuses the newcomer rather than dropping one.
  const full = room();
  for (let i = 0; i < 200; i++)
    full.ctx.acceptWebSocket(fakeSocket(null, "live"), ["live", "ip:203.0.113." + (i % 100), "overlay"]);
  assert.equal((await upgrade(full, "192.0.2.9")).status, 503);
  // as: every socket this room accepted is a fakeSocket, which records how it was closed
  assert.ok((full.ctx.sockets as FakeSocket[]).every((ws) => ws.closed === null));
});

test("overlay sockets opened with role=overlay are counted for the admin setup checklist", async () => {
  const r = room();
  assert.equal((await r.adminView()).overlays, 0);
  const headers = { Upgrade: "websocket", "X-Mini-Internal": SECRET, "X-Mini-Channel": "nesszerra" };
  for (const path of ["/live?role=overlay", "/live"])
    await withFakePair(() => r.fetch(new Request("https://room" + path, { headers })));
  const overlayTags = r.ctx.sockets.map((s) => s.tags.includes("overlay"));
  assert.deepEqual(overlayTags, [true, false]);
  assert.equal((await r.adminView()).overlays, 1);
});

test("profiles save upgrades and hats within the points and unlocks the saved wins allow", async () => {
  const r = room();
  await r.save("u1", "alice");
  assert.equal((await r.save("u1", "alice", { stats: { power: 1 } })).body.error, "invalid_upgrades");
  assert.equal((await r.save("u1", "alice", { hat: "crown" })).body.error, "hat_locked");
  assert.equal((await r.save("u1", "alice", { hat: "sombrero" })).status, 400);
  // Six wins, in the database and in the live game state (duels keep the two in step).
  r.sql("UPDATE profiles SET wins = 6 WHERE user_id = 'u1'");
  r.edit((s) => (must(s.players.find((p) => p.userId === "u1")).wins = 6));
  const build = { power: 2, luck: 1, crit: 1, dodge: 1, counter: 1 }; // 6 points, every new stat stored
  const saved = await r.save("u1", "alice", { stats: build, hat: "tophat" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.profile.stats, fullStats(build));
  const got = await r.profile("u1");
  assert.deepEqual([got.hat, got.stats, got.upgrades.points], ["tophat", fullStats(build), 6]);
  const stored = r.sql("SELECT crit, dodge, counter FROM profiles WHERE user_id = 'u1'");
  assert.deepEqual(stored, [{ crit: 1, dodge: 1, counter: 1 }]);
  assert.equal(got.upgrades.hats.find((h: { id: string }) => h.id === "tophat").unlocked, true);
  // Leaving stats and hat out keeps them.
  assert.equal((await r.save("u1", "alice", { color: "#654321" })).body.profile.hat, "tophat");
  assert.equal((await r.profile("u1")).stats.counter, 1);
  // Overlays get the hat with the player.
  const state = (await r.call("/state")).body;
  assert.equal(state.players.find((p: { userId: string }) => p.userId === "u1")?.hat, "tophat");
});

test("snapshots carry the deploy build id and the announce setting so open overlays follow them", () => {
  const r = room({ CF_VERSION_METADATA: { id: "build-42" } });
  const snap = r.publicState(r.state());
  assert.deepEqual([snap.build, snap.config.announce], ["build-42", "off"]);
  assert.equal(room().publicState(createInitialState("nesszerra")).build, "");
});

test("pets: tier boosts, added after the upgrade cap", () => {
  const none = { power: 0, guard: 0, luck: 0 };
  for (const [tier, stat, stat2, want] of [
    ["common", "power", undefined, { ...none, power: 1 }],
    ["rare", "luck", undefined, { ...none, luck: 2 }],
    ["epic", "guard", "power", { power: 1, guard: 2, luck: 0 }],
    ["epic", "guard", "guard", { ...none, guard: 2 }], // an epic second stat must differ
    ["legendary", undefined, undefined, {}], // a legendary boosts what it rolled
    ["mythic", "power", undefined, none],
  ] satisfies [string, string | undefined, string | undefined, Parameters<typeof fullStats>[0]][])
    assert.deepEqual(tierBoost(tier, stat, stat2), fullStats(want), `${tier} ${stat} ${stat2}`);
  const rolled = tierBoost("legendary", undefined, undefined, ["crit", "dodge", "luck", "vitality"]);
  assert.deepEqual(rolled, fullStats({ luck: 1, crit: 1, dodge: 1, vitality: 1 }));
  assert.equal(PETS.length, 14);
  assert.equal(petOf("p-gone", ""), null, "a deleted upload is no pet");
  assert.deepEqual(must(petOf("p-blob-1a2b3c", "rare:power:")).boost, fullStats({ power: 2, guard: 0, luck: 0 }));
  // 8 power at 8 points stays 8 before the pet, then the fox's +2 goes past the per-stat cap.
  const boosted = effectiveStats({ power: 8 }, { wins: 8 }, tierBoost("rare", "power"));
  assert.deepEqual(boosted, fullStats({ power: 10, guard: 0, luck: 0 }));
  assert.deepEqual(effectiveStats({ power: 8 }, { wins: 3 }, null), fullStats({ power: 3, guard: 0, luck: 0 }));
});

test("shop: buy pets and hats with shown dollars, equip on save, !pet, custom pet uploads and deletes", async () => {
  const r = room(DEV, { quick: true });
  assert.equal((await r.adminView()).streamelements.names.pet, "!pet");
  await r.saveAll("alice", "bob");
  const gift = (username: string, amount: number) => r.admin("giftDollars", { username, amount });
  const pet = (id: string, login: string, target = "") => r.reply(id, login, "pet", target, { messageId: false });
  // The catalog: built-ins with the config prices, and the hat price per win.
  const catalog = (await r.call("/pets")).body;
  assert.equal(catalog.pets.length, 14);
  const fox = { id: "fox", label: "Fox", tier: "rare", boost: fullStats({ power: 2, guard: 0, luck: 0 }), price: 60 };
  const listed = catalog.pets.find((p: { id: string }) => p.id === "fox");
  assert.deepEqual(listed, { ...fox, custom: false });
  assert.equal(catalog.hatPricePerWin, 3);
  // Buying: identity, unknown items, money.
  assert.equal((await r.post("/shop", { userId: "u2", kind: "pet", id: "fox" }, "u1")).status, 403);
  assert.equal((await r.shop("u9", "pet", "fox")).body.error, "no_fighter");
  assert.equal((await r.shop("u1", "pet", "unicorn")).body.error, "unknown_item");
  const poor = await r.shop("u1", "pet", "fox");
  assert.deepEqual([poor.status, poor.body.error, poor.body.price, poor.body.dollars], [409, "not_enough", 60, 0]);
  await gift("alice", 250);
  const { ok, price, dollars, owned } = (await r.shop("u1", "pet", "fox")).body;
  assert.deepEqual([ok, price, dollars, owned.pets, owned.hats, owned.slots], [true, 60, 190, ["fox"], [], 1]);
  assert.equal((await r.shop("u1", "pet", "fox")).body.error, "owned");
  // Hats: free ones are already unlocked; locked ones cost wins x hatPricePerWin; 0 turns hat sales off.
  assert.equal((await r.shop("u1", "hat", "cap")).body.error, "already_unlocked");
  assert.equal((await r.shop("u1", "hat", "wizard")).body.price, 9);
  assert.equal((await r.save("u1", "alice", { hat: "tophat" })).body.error, "hat_locked");
  const hat = (await r.save("u1", "alice", { hat: "wizard" })).body.profile.hat;
  assert.equal(hat, "wizard", "a bought hat saves before its wins");
  assert.equal((await r.cfg({ petPriceRare: 0 })).body.error, "invalid_config_petPriceRare");
  assert.equal((await r.cfg({ hatPricePerWin: 0 })).status, 200);
  assert.equal((await r.shop("u1", "hat", "crown")).body.error, "hats_not_for_sale");
  // Equip: only owned pets; the profile, the game state and /looks carry it.
  assert.equal(await pet("u1", "alice"), `@alice, you have no pet yet. Buy one with PixFray dollars at ${SITE}#pets`);
  assert.equal((await r.save("u1", "alice", { pet: "wolf" })).body.error, "pet_locked");
  assert.equal((await r.save("u1", "alice", { pet: 7 })).body.error, "invalid_profile");
  const saved = (await r.save("u1", "alice", { pet: "fox" })).body.profile;
  assert.deepEqual([saved.pet, saved.petTier, saved.petBoost, saved.dollars], ["fox", "rare", fox.boost, 181]);
  const { pets, hats } = (await r.profile("u1")).owned;
  assert.deepEqual({ pets, hats }, { pets: ["fox"], hats: ["wizard"] });
  assert.equal(r.player("u1").petBoost.power, 2, "duels count the boost");
  const looks = (await r.call("/looks?u=alice")).body.alice;
  assert.deepEqual([looks.pet, looks.petTier], ["fox", "rare"]);
  const kept = (await r.save("u1", "alice", { avatar: "toon-ghoul" })).body.profile.pet;
  assert.equal(kept, "fox", "a save without pet keeps it");
  const foxLine = "@alice's pet: Fox (rare), +2 power.";
  assert.equal(await pet("u1", "alice"), foxLine);
  assert.equal(await pet("u2", "bob", "alice"), foxLine);
  assert.equal(await pet("u1", "alice", "bob"), "@bob has no pet yet.");
  assert.equal(await pet("u1", "alice", "nobody"), noRival("nobody"));
  assert.equal((await r.devChat("u2", "bob", "!pet @alice")).body.reply, foxLine);
  // A duel's result write keeps the pet (upsertProfile from the game state).
  await r.connectChat("se-streamelements");
  await r.seDuel({ origin: false, messageId: false });
  assert.ok(r.state().duels.some((d) => d.status === "completed"));
  assert.equal(must(r.sql("SELECT pet FROM profiles WHERE user_id = 'u1'")[0]).pet, "fox");
  // Custom pets: checked uploads, priced by tier; deleting one takes it off fighters and owners.
  const blob = { label: "Blob", tier: "epic", stat: "luck", stat2: "guard", createdBy: "mod1" };
  const upload = (body: Extra) => r.post("/pets", { ...blob, image: b64(makePng(32, 32)), ...body });
  const text = b64(Buffer.from("not a png at all, just some text that is long enough to read"));
  for (const [body, reason] of [
    [{ stat2: "luck" }, "invalid_stat"],
    [{ tier: "mythic" }, "invalid_tier"],
    [{ image: b64(makePng(65, 32)) }, "image_dimensions"],
    [{ image: text }, "not_png"],
  ] satisfies [Extra, string][])
    assert.equal((await upload(body)).body.reason, reason, reason);
  const item = (await upload({})).body.item;
  assert.match(item.id, /^p-blob-[0-9a-f]{6}$/);
  const [boost, url] = [fullStats({ power: 0, guard: 1, luck: 2 }), "/api/pets/nesszerra/" + item.id];
  assert.deepEqual([item.tier, item.boost, item.price, item.url], ["epic", boost, 140, url]);
  const headers = { "X-Mini-Internal": SECRET, "X-Mini-Channel": "nesszerra" };
  const png = await r.fetch(new Request("https://room/pets/" + item.id, { headers }));
  assert.equal(png.headers.get("content-type"), "image/png");
  await gift("bob", 500);
  assert.equal((await r.shop("u2", "pet", item.id)).body.price, 140);
  assert.equal((await r.save("u2", "bob", { pet: item.id })).body.profile.petTier, "epic");
  assert.equal(await pet("u2", "bob"), "@bob's pet: Blob (epic), +1 guard, +2 luck.");
  assert.equal((await r.call("/pets/" + item.id, { method: "DELETE" })).body.ok, true);
  const bob = await r.profile("u2");
  assert.deepEqual([bob.pet, bob.owned.pets], ["", []]);
  assert.equal(r.player("u2").pet, "");
  assert.equal((await r.call("/pets/" + item.id, { method: "DELETE" })).status, 404);
  // A deleted profile takes its purchases with it.
  await r.admin("removePlayer", { userId: "u1" });
  assert.equal(must(r.sql("SELECT COUNT(*) AS n FROM owned_items WHERE user_id = 'u1'")[0]).n, 0);
});

test("cosmetics and builds: the shop list, buying, wearing, build slots with their own loadout, duels keep them", async () => {
  const r = room({}, { quick: true });
  await r.saveAll("alice", "bob");
  const buy = (kind: string, id: string, price?: number) => r.shop("u1", kind, id, { price });
  // The public list: every kind with the config price, and the build slot prices.
  const shop = (await r.call("/shop")).body;
  assert.equal(shop.pets.length, 14);
  assert.deepEqual(Object.keys(shop.items), ["recolor", "petcolor", "accessory", "trail", "effect", "taunt", "title"]);
  const flames = shop.items.trail.find((x: { id: string }) => x.id === "flames");
  assert.deepEqual(flames, { id: "flames", label: "Flames", price: 40 });
  assert.deepEqual(shop.slots, { max: 5, prices: [60, 120, 120, 120] });
  // Buying: unknown ids, money, owned.
  assert.equal((await buy("accessory", "jetpack")).body.error, "unknown_item");
  assert.equal((await buy("trail", "flames")).body.error, "not_enough");
  await r.admin("giftDollars", { username: "alice", amount: 2000 });
  // The page sends the price it showed; after a mod's change the buy is refused with the new price.
  const stale = await buy("trail", "flames", 100);
  assert.deepEqual([stale.status, stale.body.error, stale.body.price], [409, "price_changed", 40]);
  assert.deepEqual((({ price, dollars }) => [price, dollars])((await buy("trail", "flames", 40)).body), [40, 1960]);
  assert.equal((await buy("trail", "flames")).status, 409);
  const items = { recolor: "crimson", petcolor: "gold", accessory: "cape", effect: "fireworks", taunt: "gg" };
  for (const [kind, id] of Object.entries({ ...items, title: "legend" }))
    assert.equal((await buy(kind, id)).body.ok, true, kind);
  // Wearing: only bought ones; "" takes one off; left out keeps it.
  assert.equal((await r.save("u1", "alice", { accessory: "glasses" })).body.error, "item_locked");
  assert.equal((await r.save("u1", "alice", { title: "Supreme Leader" })).body.error, "invalid_profile");
  const gear = { recolor: "crimson", petColor: "gold", accessory: "cape", trail: "flames" };
  const worn = { ...gear, winEffect: "fireworks", taunt: "gg", title: "legend" };
  let p = (await r.save("u1", "alice", worn)).body.profile;
  assert.deepEqual(Object.fromEntries(Object.keys(worn).map((k) => [k, p[k]])), worn);
  const kept = (await r.save("u1", "alice", { avatar: "toon-ghoul" })).body.profile.trail;
  assert.equal(kept, "flames", "a save without cosmetics keeps them");
  assert.equal((await r.save("u1", "alice", { title: "" })).body.profile.title, "");
  await r.save("u1", "alice", { title: "legend" });
  const looks = (await r.call("/looks?u=alice")).body.alice;
  const shown = ["crimson", "cape", "flames", "fireworks", "gg", "legend"];
  assert.deepEqual([looks.recolor, looks.accessory, looks.trail, looks.winEffect, looks.taunt, looks.title], shown);
  assert.equal(r.player("u1").trail, "flames", "the overlay state carries them");
  // Build slots: 1 free, the 2nd costs 60, then 120 each, up to 5.
  assert.equal((await r.save("u1", "alice", { build: 1 })).body.error, "invalid_build");
  const slot = (await buy("slot", "")).body;
  assert.deepEqual([slot.price, slot.owned.slots], [60, 2]);
  // Slot 1 keeps its own character, stats and cosmetics; slot 0 is untouched.
  const loadout = { build: 1, avatar: "soldier", stats: { power: 0, guard: 0, luck: 0 }, recolor: "", trail: "" };
  p = (await r.save("u1", "alice", { ...loadout, title: "legend" })).body.profile;
  assert.deepEqual([p.build, p.avatar, p.recolor, p.trail], [1, "soldier", "", ""]);
  let prof = await r.profile("u1");
  const [b0, b1] = prof.builds;
  const slots = [1, 2, "player", "flames", "soldier", ""];
  assert.deepEqual([prof.build, prof.builds.length, b0.avatar, b0.trail, b1.avatar, b1.trail], slots);
  // Switching back = saving slot 0's loadout to slot 0.
  p = (await r.save("u1", "alice", { ...b0, build: 0 })).body.profile;
  assert.deepEqual([p.build, p.avatar, p.trail], [0, "player", "flames"]);
  for (const price of [120, 120, 120]) assert.equal((await buy("slot", "")).body.price, price);
  assert.equal((await buy("slot", "")).body.error, "max_slots");
  prof = await r.profile("u1");
  assert.deepEqual([prof.owned.slots, prof.builds.length, prof.builds[2]], [5, 5, null]);
  // A build saved with an uploaded pet that was deleted since loads with no pet.
  const gone = JSON.stringify({ ...prof.builds[0], pet: "c-gone-abc123" });
  r.sql("INSERT INTO builds (user_id, slot, data) VALUES ('u1', 2, ?)", gone);
  prof = await r.profile("u1");
  assert.deepEqual([prof.builds[2].pet, prof.builds[2].trail], ["", "flames"]);
  // A duel's result write keeps the cosmetics; a removed fighter loses builds and purchases.
  await r.connectChat("se-streamelements");
  await r.seDuel({ origin: false, messageId: false });
  assert.ok(r.state().duels.some((d) => d.status === "completed"));
  const [row] = r.sql("SELECT trail, title, build FROM profiles WHERE user_id = 'u1'");
  assert.deepEqual(row, { trail: "flames", title: "legend", build: 0 });
  await r.admin("removePlayer", { userId: "u1" });
  assert.equal(must(r.sql("SELECT COUNT(*) AS n FROM builds WHERE user_id = 'u1'")[0]).n, 0);
});

test("a save after the fighter left the arena keeps its stored rank and record", async () => {
  const r = room();
  await r.save("u1", "alice");
  r.sql("UPDATE profiles SET elo = 1106, wins = 14, losses = 9 WHERE user_id = 'u1'");
  r.edit((s) => (s.players = s.players.filter((p) => p.userId !== "u1")));
  assert.equal((await r.save("u1", "alice", { color: "#654321" })).status, 200);
  const [row] = r.sql("SELECT elo, wins, losses, color FROM profiles WHERE user_id = 'u1'");
  assert.deepEqual(row, { elo: 1106, wins: 14, losses: 9, color: "#654321" });
  const fighter = r.player("u1");
  assert.deepEqual([fighter.elo, fighter.wins, fighter.losses], [1106, 14, 9]);
});

test("owner log: a save lands as a command row; a refusal, from the room or from the Worker, as a warn row", async () => {
  const r = room();
  await r.save("u1", "alice");
  const saved = (await r.logs("command"))[0];
  assert.deepEqual([saved.message, saved.context.reason], ["alice saved profile", "saved"]);
  assert.equal((await r.save("u1", "alice", { accessory: "glasses" })).body.error, "item_locked");
  const refused = (await r.logs("warn"))[0];
  assert.equal(refused.message, "alice profile not saved: item_locked");
  const who = { channel: "nesszerra", action: "save", userId: "u1", user: "alice" };
  assert.deepEqual(refused.context, { ...who, reason: "item_locked" });
  const message = "bob profile not saved: unknown_character";
  const context = { reason: "unknown_character" };
  await r.post("/dev/log", { source: "warn", message, context });
  const row = (await r.logs("warn"))[0];
  assert.deepEqual([row.source, row.message, row.context], ["warn", message, context]);
});

test('pet boost text: a rolled legendary reads "+1 luck, crit, dodge and vitality", like the viewer page', () => {
  const rolled = tierBoost("legendary", undefined, undefined, ["vitality", "crit", "dodge", "luck"]);
  for (const [stats, want] of [
    [rolled, "+1 luck, crit, dodge and vitality"],
    [fullStats({ power: 1, guard: 1, luck: 1 }), "+1 power, guard and luck"],
    [fullStats({ power: 2, guard: 1, luck: 0 }), "+2 power, +1 guard"],
    [fullStats({ power: 0, guard: 0, luck: 1 }), "+1 luck"],
  ] satisfies [ReturnType<typeof fullStats>, string][])
    assert.equal(boostText(stats), want);
});

// BOT_DEBUG: the bot account (u9 pixbot) plays back. The Worker forwards the subscription's bot id and a mod flag.
class BotRoom extends TestRoom {
  #lines = 0;
  /** Posts a chat line as the bot's EventSub delivery; resolves to the room's JSON reply (reply, replies, reason). */
  say = async (id: string, login: string, text: string, { mod = false, sub = "sub-bot" } = {}) => {
    const n = ++this.#lines;
    const delivery = { messageId: "d" + n, messageType: "notification", bot: true, botId: "u9", timestamp: Date.now() };
    const event = { broadcaster_user_id: "owner1", broadcaster_user_login: "nesszerra", ...chatter(id, login), mod };
    const subscription = { id: sub, status: "enabled" };
    const body = { ...delivery, subscription, event: { ...event, message_id: "dm" + n, message: { text } } };
    return (await this.post("/eventsub?origin=" + encodeURIComponent("https://staging.example"), body)).body;
  };
  /** The bot's reply text to one chat line. */
  line = async (id: string, login: string, text: string, opts: { mod?: boolean; sub?: string } = {}): Promise<string> =>
    (await this.say(id, login, text, opts)).reply;
}

const newBotRoom = (env: Extra = {}) =>
  new BotRoom(fakeCtx(), asEnv({ INTERNAL_SECRET: SECRET, CHAT_BOT: "1", ...env }));
/** A bot room with the dev tools on: saves the given fighters, then connects the bot's chat subscription. */
async function botRoom(env: Extra, ...logins: string[]) {
  const r = newBotRoom({ ...DEV, ...env });
  await r.saveAll(...logins);
  await r.connectChat("sub-bot");
  return r;
}

test("chat bot: commands by the channel names get a reply; chat, other commands and other subscriptions get none", async () => {
  const r = await botRoom({}, "alice", "bob");
  assert.match(await r.line("u1", "alice", "!fray"), /staging\.example\/\?channel=nesszerra/);
  assert.equal(await r.line("u1", "alice", "!discord"), "", "another bot's command");
  const old = await r.line("u1", "alice", "!fray", { sub: "sub-old" });
  assert.equal(old, "", "a subscription the room no longer uses");
  assert.match(await r.line("u1", "alice", "!challenge @bob"), /bob/);
  await r.say("u2", "bob", "!FIGHT");
  const settled = r.state().duels.some((d) => d.status === "completed");
  assert.ok(settled, "a quick duel through the bot");
  // StreamElements posts nothing while the bot is connected, and doesn't take the chat source back.
  assert.equal(await r.reply("u1", "alice", "help", "", BARE), "");
  assert.equal(r.state().chat.subscriptionId, "sub-bot");
  // At most 18 lines per 30 s (Twitch allows 20 for a bot that isn't a mod), and command replies stop 4 short of that
  // so the bot's own result lines still fit; 3 were sent above.
  const replies = [];
  for (let i = 0; i < 20; i++) replies.push(await r.line("u1", "alice", "!elo"));
  assert.equal(replies.filter(Boolean).length, 11);
});

test("chat bot: a notification confirms a pending subscription; without CHAT_BOT, StreamElements takes over as before", async () => {
  const r = room({ CHAT_BOT: "1" }, { quick: true });
  await r.connectChat("sub-bot", "webhook_callback_verification_pending");
  // A delivery without a bot id, subscription status or origin.
  const event = { ...chatter("u1", "alice"), message_id: "x1", message: { text: "!ranks" } };
  const delivery = { messageId: "p1", messageType: "notification", bot: true, timestamp: Date.now() };
  const reply = (await r.post("/eventsub", { ...delivery, subscription: { id: "sub-bot" }, event })).body.reply;
  assert.ok(reply);
  assert.equal(r.state().chat.connected, true);
  const plain = room({}, { quick: true });
  await plain.connectChat("sub-bot");
  assert.notEqual(await plain.reply("u1", "alice", "help", "", BARE), "");
  assert.equal(plain.state().chat.subscriptionId, "se-streamelements");
});

test("style dollars: buy hats, cosmetics and build slots before dollars, never pets; !give can't move them; private like dollars", async () => {
  const r = room(DEV, { quick: true });
  await r.connectChat("se-streamelements");
  await r.saveAll("alice", "bob");
  const style = (userId: string, amount: number) => r.post("/dev-style", { userId, amount });
  const buy = async (kind: string, id = "") => {
    const { status, body } = await r.shop("u1", kind, id);
    return [status, body.error || body.reason, body.price, body.dollars, body.styleDollars];
  };
  assert.equal((await style("u9", 100)).status, 404, "no fighter, no style dollars");
  assert.equal((await style("u1", 100)).body.styleDollars, 100);
  assert.deepEqual(await buy("pet", "fox"), [409, "not_enough", 60, 0, 100], "style dollars never buy a pet");
  assert.deepEqual(await buy("hat", "wizard"), [200, "bought", 9, 0, 91]);
  assert.deepEqual(await buy("trail", "flames"), [200, "bought", 40, 0, 51]);
  assert.deepEqual(await buy("slot"), [409, "not_enough", 60, 0, 51], "$51 style is $9 short of a slot");
  await r.admin("giftDollars", { username: "alice", amount: 20 });
  assert.deepEqual(await buy("slot"), [200, "bought", 60, 11, 0], "style dollars first, then $9 of dollars");
  assert.deepEqual(await buy("pet", "fox"), [409, "not_enough", 60, 11, 0]);
  assert.equal((await style("u1", 30)).body.styleDollars, 30);
  const profile = await r.profile("u1");
  assert.deepEqual([profile.dollars, profile.styleDollars], [11, 30]);
  const wallet = await r.reply("u1", "alice", "wallet");
  assert.equal(wallet, "@alice: $11 PixFray dollars, $30 style dollars, 0 upgrade points, 0-stream streak.");
  assert.equal(await r.reply("u2", "bob", "wallet"), "@bob: $0 PixFray dollars, 0 upgrade points, 0-stream streak.");
  const balances = (await r.board()).map((p) => ["dollars", "styleDollars"].filter((k) => k in p));
  assert.deepEqual(balances, [[], []], "the public board shows neither balance");
  assert.equal((await r.board(true)).find((p) => p.userId === "u1").styleDollars, 30);
  // !give (and !pay) move dollars only: $11 is all alice can give, and her style dollars stay.
  await r.devLive(true, "s1");
  r.sql("UPDATE profiles SET wins = 3, losses = 2 WHERE user_id = 'u1'");
  assert.equal(await r.reply("u1", "alice", "give", "bob", { amount: "20" }), "@alice, you only have $11.");
  const given = await r.reply("u1", "alice", "give", "bob", { amount: "11" });
  assert.equal(given, "@alice gave $11 to @bob. You have $0 left.");
  const rows = r.sql("SELECT username, dollars, style_dollars FROM profiles ORDER BY username");
  const settled = rows.flatMap((x) => [x.username, x.dollars, x.style_dollars]);
  assert.deepEqual(settled, ["alice", 0, 30, "bob", 11, 0]);
  assert.equal((await style("u1", -1000)).body.styleDollars, 0, "taking style dollars back stops at 0");
});

test("chat bot: !give gives dollars (and !pay still does); replies name !give", async () => {
  const r = await botRoom({}, "alice", "bob");
  assert.match(await r.line("u1", "alice", "!give"), /!give @name/);
  assert.match(await r.line("u1", "alice", "!pay"), /!give @name/, "!pay is an alias");
  assert.equal(await r.line("u1", "alice", "!givepoints"), "", "StreamElements' name isn't ours");
});

test("chat bot: text commands from the admin page answer in chat, with counters, cooldowns and protected names", async () => {
  const r = await botRoom({});
  const admin = (action: string, payload: Extra) => r.admin(action, payload, OWNER);
  const save = (name: string, reply: string) => admin("saveCommand", { name, reply });
  assert.equal((await save("sens", "0.14 3600dpi")).body.ok, true);
  const saved = await save("!NT", "Nesszerra has tried $(count nt) times!");
  assert.deepEqual(saved.body.botCommands.counters, [{ name: "nt", value: 0 }], "a new counter starts at 0");
  assert.equal((await admin("setCounter", { name: "nt", value: 1 })).body.ok, true);
  assert.equal(await r.line("u1", "alice", "!sens"), "0.14 3600dpi");
  assert.equal(await r.line("u1", "alice", "!nt"), "Nesszerra has tried 2 times!");
  assert.equal(await r.line("u2", "bob", "!nt"), "", "global cooldown");
  assert.equal(await r.line("u1", "alice", "sens"), "", "needs the !");
  must(r.commandCooldowns).clear();
  assert.equal(await r.line("u2", "bob", "!NT now"), "Nesszerra has tried 3 times!");
  await save("hug", "${user} hugs ${touser} (${getcount nt})");
  assert.equal(await r.line("u1", "alice", "!hug @bob"), "alice hugs bob (3)");
  assert.equal((await r.say("u1", "alice", "!unknown")).reason, "not_command");
  // Names PixFray uses, and bad input, are refused.
  const taken = ["fray", "!give", "pay", "fight", "challenge"];
  for (const [name, reply, error] of [
    ...taken.map((name): [string, string, string] => [name, "x", "command_name_taken"]),
    ["a b", "x", "invalid_command_name"],
    ["x", "  ", "empty_command_reply"],
    ["sens", "dup", "command_exists"],
  ] satisfies [string, string, string][])
    assert.equal((await save(name, reply)).body.error, error, name);
  assert.equal((await admin("setCounter", { name: "nt", value: -1 })).body.error, "invalid_counter_value");
  // Edit with a rename, then delete; the admin page sees the list.
  assert.equal((await admin("saveCommand", { name: "sensitivity", reply: "0.15", oldName: "!sens" })).body.ok, true);
  const names = (await r.adminView()).botCommands.commands.map((c: { name: string }) => c.name);
  assert.deepEqual(names, ["!hug", "!nt", "!sensitivity"]);
  must(r.commandCooldowns).clear();
  assert.equal(await r.line("u1", "alice", "!sens"), "");
  assert.equal((await admin("deleteCommand", { name: "hug" })).body.botCommands.commands.length, 2);
  // A reply the cap would drop doesn't count or start the cooldown.
  must(r.commandCooldowns).clear();
  r.botReplies = Array(14).fill(Date.now());
  assert.equal((await r.say("u1", "alice", "!nt")).reason, "reply_limit");
  r.botReplies = [];
  assert.equal(await r.line("u1", "alice", "!nt"), "Nesszerra has tried 4 times!");
  // A reply that can outgrow a chat line saves with a warning and is cut at a word break.
  assert.equal(saved.body.warning, undefined);
  const long = (await save("long", "${user} ".repeat(10) + "x".repeat(300))).body;
  assert.deepEqual([long.ok, long.warning, long.longest, long.max], [true, "reply_may_be_cut", 560, 480]);
  const cut = await r.line("u3", "abcdefghijklmnopqrstuvwxy", "!long");
  assert.ok(cut.length <= 480 && cut.endsWith("abcdefghijklmnopqrstuvwxy…"), cut);
});

test("chat bot status: heard, sent and dropped replies, held-back replies and !fray debug for mods", async () => {
  const r = await botRoom({}, "alice");
  const status = async () => (await r.adminView()).botStatus;
  assert.deepEqual((({ heardAt, sent, failed }) => [heardAt, sent, failed])(await status()), [0, 0, 0]);
  await r.say("u1", "alice", "!elo");
  await r.post("/bot-sent", { results: [{ sent: true, reason: "" }] });
  await r.post("/bot-sent", { results: [{ sent: false, reason: "msg_duplicate" }] });
  const s = await status();
  assert.equal(s.heard, "alice !elo");
  assert.ok(s.heardAt > 0 && s.sentAt > 0 && s.failedAt >= s.sentAt);
  const dup = "the same line twice within 30 s (msg_duplicate)";
  assert.deepEqual([s.sent, s.failed, s.failedReason, s.failedText], [1, 1, "msg_duplicate", dup]);
  assert.match((await r.logs("warn"))[0].message, /^bot reply dropped: the same line twice/);
  // !fray debug: broadcaster, mods and the bot get the status line; viewers get a no
  const line = await r.line("u2", "modmia", "!fray debug", { mod: true });
  const debug =
    /^PixFray debug: chat connected · last command alice !elo \d+ s · replies 1 sent, 1 dropped \(last drop \d+ s: the same line twice within 30 s \(msg_duplicate\)\) · \d+\/18 replies in 30 s · reminder off$/;
  assert.match(line, debug);
  assert.match(await r.line("u1", "alice", "!fray debug"), /only the broadcaster or a mod/);
  // An old subscription's line, and the reply cap, are held back, noted and logged.
  const event = { chatter_user_id: "u1", chatter_user_login: "alice", message_id: "o1", message: { text: "!elo" } };
  const old = { messageId: "old1", messageType: "notification", bot: true, botId: "u9", timestamp: Date.now() };
  await r.post("/eventsub", { ...old, subscription: { id: "sub-old" }, event });
  assert.equal((await status()).heldReason, "unknown_subscription");
  for (let i = 0; i < 20; i++) await r.say("u1", "alice", "!elo");
  assert.equal((await status()).heldReason, "reply_limit");
  const warns = (await r.logs("warn")).map((x) => x.message);
  const held = (reason: string) => warns.filter((m) => m === "bot reply held back: " + reason).length;
  assert.equal(held("unknown_subscription"), 1);
  assert.equal(held("reply_limit"), 1, "once a minute per reason");
});

test("chat bot: !fray off / !fray on (broadcaster or mod) silences the whole bot; the admin page toggles it too", async () => {
  const r = await botRoom({}, "alice", "bob");
  assert.match(await r.line("u1", "alice", "!fray off"), /^PixFray duels/, "a viewer gets the help line");
  assert.equal(r.state().config.botEnabled, true);
  assert.match(await r.line("u2", "modmia", "!fray off", { mod: true }), /^PixFray bot is off: .*!fray on\.$/);
  const s = r.state();
  assert.equal(s.config.botEnabled, false);
  assert.deepEqual(r.dueResults(s, Date.now()), [], "no result lines while off");
  for (const text of ["!fray", "!challenge @bob", "!elo", "!fray debug", "!fray on"])
    assert.equal(await r.line("u1", "alice", text), "", "silent for " + text);
  assert.equal(r.state().duels.length, s.duels.length, "no duel started");
  const now = r.state();
  assert.equal(r.reminderDue({ ...now, config: { ...now.config, reminderMin: 30 } }), 0, "no reminder while off");
  assert.match(await r.line("u2", "modmia", "!fray off", { mod: true }), /is off/, "off again just says so");
  const on = await r.line("owner1", "nesszerra", "!fray on");
  assert.match(on, /^PixFray bot is on\. Type !fray to play\.$/, "the broadcaster turns it back on");
  assert.match(await r.line("u1", "alice", "!challenge @bob"), /bob/);
  // the admin page's Rules switch is the same setting
  const cfg = (patch: Extra) => r.admin("config", { patch }, OWNER);
  assert.equal((await cfg({ botEnabled: false })).body.ok, true);
  assert.equal(await r.line("u2", "bob", "!fight"), "");
  assert.equal((await cfg({ botEnabled: "no" })).body.reason, "invalid_config_botEnabled");
  assert.equal((await cfg({ botEnabled: true })).body.ok, true);
  assert.notEqual(await r.line("u2", "bob", "!elo"), "");
});

// The bot posts through Helix. Twitch is faked: an app token, then every chat line is recorded.
// down: true makes every chat send fail (Twitch 503).
function fakeTwitch(t: TestContext) {
  // Loose: the Helix chat bodies the room sent; tests read message and reply fields
  const sent: Loose[] = [];
  const AUTH = { idFromName: () => "auth", get: () => ({ fetch: async () => Response.json(null) }) };
  const tw = { sent, down: false, env: { AUTH, AUTH_SECRET: "test-auth-secret", TWITCH_CLIENT_ID: "cid" } };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith("https://id.twitch.tv/oauth2/token"))
      return Response.json({ access_token: "app", expires_in: 3600 });
    if (url.endsWith("/helix/chat/messages")) {
      if (tw.down) return new Response("unavailable", { status: 503 });
      sent.push(JSON.parse(init.body as string)); // as: the room sends Helix chat as a JSON string body
      return Response.json({ data: [{ is_sent: true }] });
    }
    throw new Error("unexpected fetch " + url);
  });
  return tw;
}

test("chat bot reminder: off by default; on, it posts the !fray line as the bot each interval, only while live", async (t) => {
  const tw = fakeTwitch(t);
  const r = await botRoom(tw.env, "alice");
  await r.say("u1", "alice", "!elo"); // the room learns the bot (u9) and the channel (owner1)
  assert.equal(r.reminderDue(r.state()), 0, "off by default");
  r.edit((s) => (s.config.reminderMin = 30));
  const due = r.reminderDue(r.state());
  assert.ok(due > Date.now() + 29 * 60000 && due <= Date.now() + 30 * 60000, "first one a full interval out");
  await r.scheduleAlarm(r.state());
  assert.ok(must(r.ctx.storage.alarm) <= due);
  // Offline: nothing posted, and it waits another interval.
  await r.devLive(false);
  await r.postReminder("nesszerra", due);
  assert.equal(tw.sent.length, 0);
  assert.equal(r.reminderDue(r.state(), due), due + 30 * 60000);
  // Live: one line from the bot in the channel, with this channel's names and link.
  await r.devLive(true);
  await r.postReminder("nesszerra", due + 30 * 60000);
  assert.equal(tw.sent.length, 1);
  assert.deepEqual([tw.sent[0].broadcaster_id, tw.sent[0].sender_id], ["owner1", "u9"]);
  const reminder =
    /^PixFray duels: name your rival.*Again\? !rematch\. More: !checkin !wallet !ranks !look\. Gear up at https:\/\/staging\.example\/\?channel=nesszerra$/;
  assert.match(tw.sent[0].message, reminder);
  await r.postReminder("nesszerra", due + 30 * 60000 + 1000);
  assert.equal(tw.sent.length, 1, "not again until the next interval");
  // Turned off, or the bot disconnected: nothing due.
  r.edit((s) => (s.config.reminderMin = 0));
  assert.equal(r.reminderDue(r.state()), 0);
});

test('chat bot: an unanswered challenge gets a "challenge expired" line, from the alarm or the next command, once', async (t) => {
  const tw = fakeTwitch(t);
  const r = await botRoom(tw.env, "alice", "bob");
  const expire = () =>
    r.edit((s) => {
      for (const d of s.duels) if (d.status === "pending") d.expiresAt = Date.now() - 1;
    });
  // The alarm notices it: the bot posts the line itself, and it counts as a sent reply.
  assert.match(await r.line("u1", "alice", "!challenge @bob"), /alice challenges @bob/);
  expire();
  await r.alarm();
  const expired = "Challenge expired: @bob didn't answer alice within 30 s. alice, try again with !challenge @bob";
  const posted = tw.sent.map((m) => [m.sender_id, m.message]);
  assert.deepEqual(posted, [["u9", expired]]);
  assert.equal((await r.adminView()).botStatus.sent, 1);
  await r.alarm();
  assert.equal(tw.sent.length, 1, "said once");
  // A later command notices it first: the line comes before that command's reply, and the alarm doesn't repeat it.
  await r.say("u1", "alice", "!challenge @bob");
  expire();
  const late = await r.say("u2", "bob", "!fight");
  assert.match(late.replies[0], /^Challenge expired: @bob didn't answer alice/);
  assert.match(late.replies[1], /nobody has challenged you yet/);
  await r.alarm();
  assert.equal(tw.sent.length, 1);
});

test("chat bot: after the stream has played a duel, the bot says who won and the Elo change, once", async (t) => {
  const tw = fakeTwitch(t);
  const r = await botRoom(tw.env, "alice", "bob");
  await r.say("u1", "alice", "!challenge @bob");
  assert.match((await r.say("u2", "bob", "!fight")).replies.join(" "), /Watch the stream for the winner/);
  const duel = r.completed();
  assert.ok(duel.revealAt > Date.now());
  await r.scheduleAlarm(r.state());
  assert.ok(must(r.ctx.storage.alarm) <= duel.revealAt + 1, "the alarm wakes for the reveal");
  await r.alarm();
  assert.equal(tw.sent.length, 0, "nothing before the stream has shown it");
  r.edit((s) => (must(s.duels.find((d) => d.id === duel.id)).revealAt = Date.now() - 1));
  await r.alarm();
  const [w, l] = duel.winnerId === "u1" ? ["alice", "bob"] : ["bob", "alice"];
  assert.equal(tw.sent.length, 1);
  const elo = (who: string, sign: string) => `${who} \\d+ Elo \\(${sign}\\d+\\)`;
  const result = `^${w} beat ${l}(?: on HP| in sudden death)?(?:, flawless)?! ${elo(w, "\\+")}, ${elo(l, "-")}\\.$`;
  assert.match(tw.sent[0].message, new RegExp(result));
  await r.alarm();
  assert.equal(tw.sent.length, 1, "said once");
});

test("chat bot: a result line survives a full reply cap, a Twitch outage, a missed alarm and an alarm error", async (t) => {
  const tw = fakeTwitch(t);
  const r = await botRoom(tw.env, "alice", "bob", "cara");
  const reveal = () =>
    r.edit((s) => {
      for (const d of s.duels) if ((d.revealAt ?? 0) > Date.now()) d.revealAt = Date.now() - 1;
    });
  const duel = async ({ shown = true } = {}) => {
    await r.say("u1", "alice", "!challenge @bob");
    await r.say("u2", "bob", "!fight");
    r.rested();
    if (shown) reveal();
  };
  const results = () => tw.sent.filter((m) => / beat /.test(m.message)).length;
  // A viewer spamming commands fills only the command share of the cap; the result still goes out.
  await duel({ shown: false });
  for (let i = 0; i < 20; i++) await r.say("u3", "cara", "!elo");
  assert.equal(r.botStatus().heldReason, "reply_limit", "commands hit their share of the cap");
  reveal();
  await r.alarm();
  assert.equal(results(), 1, "the reserved lines carry the result");
  // Twitch down: the line stays due and the alarm comes back within seconds, then it goes out once.
  r.botReplies = [];
  tw.down = true;
  await duel();
  await r.alarm();
  assert.equal(results(), 1);
  assert.ok(must(r.ctx.storage.alarm) <= Date.now() + 5000, "retried soon");
  tw.down = false;
  await r.alarm();
  assert.equal(results(), 2);
  await r.alarm();
  assert.equal(results(), 2, "once");
  // The alarm never ran: the next command posts the result before its own reply.
  await duel();
  const before = tw.sent.length;
  await r.say("u3", "cara", "!look");
  assert.equal(results(), 3);
  assert.match(tw.sent[before].message, / beat /);
  // An error inside the alarm is logged and the next alarm is still set.
  const real = r.postReminder;
  r.postReminder = async () => {
    throw new Error("boom");
  };
  await duel();
  r.ctx.storage.alarm = null;
  await r.alarm();
  r.postReminder = real;
  assert.equal(results(), 4, "results go out before the failing step");
  assert.match((await r.logs("room"))[0].message, /^boom$/);
  assert.ok(r.ctx.storage.alarm, "the alarm is set again");
});

test("chat bot: !accept, !duel and !top are hidden aliases, unless the channel uses those names", async () => {
  const r = await botRoom({}, "alice", "bob");
  assert.match(await r.line("u1", "alice", "!duel @bob"), /^alice challenges @bob!/);
  assert.match(await r.line("u2", "bob", "!ACCEPT"), /^Fight on: alice vs bob!/);
  assert.match(await r.line("u1", "alice", "!top"), /^Top \d: /);
  // Trailing punctuation still names the viewer.
  assert.match(await r.line("u1", "alice", "!elo @bob,"), /^bob: /);
  // A custom !top command wins over the alias.
  const saved = await r.admin("saveCommand", { name: "!top", reply: "custom top" }, OWNER);
  assert.equal(saved.body.ok, true);
  assert.equal(await r.line("u1", "alice", "!top"), "custom top");
});

test("!checkin does not count a win the stream has not shown yet", async () => {
  const r = await botRoom(DEV, "alice", "bob");
  await r.devLive(true, "s1");
  await r.say("u1", "alice", "!challenge @bob");
  await r.say("u2", "bob", "!fight");
  const d = r.completed();
  assert.ok(d.revealAt > Date.now());
  const [id, login] = d.winnerId === "u1" ? ["u1", "alice"] : ["u2", "bob"];
  assert.match(await r.line(id, login, "!checkin"), / 1 point, 1 unspent\./, "the hidden win is not counted");
});

test("debug bot: a challenge aimed at the bot is fought back, !fray spar challenges you; off without BOT_DEBUG", async () => {
  const r = await botRoom({ BOT_DEBUG: "1" }, "alice", "pixbot");
  await r.devLive(false);
  const fought = await r.say("u1", "alice", "!challenge @pixbot");
  assert.equal(fought.replies.length, 2);
  assert.match(fought.replies[0], /alice challenges @pixbot/);
  assert.match(fought.replies[1], /Fight on: alice vs pixbot/);
  assert.ok(r.state().duels.some((d) => d.status === "completed" && d.a === "u1" && d.b === "u9"));
  await sleep(10);
  r.rested();
  r.edit((s) => s.duels.forEach((d) => (d.revealAt = 0)));
  const spar = await r.say("u1", "alice", "!fray spar");
  assert.deepEqual(spar.replies.length, 1);
  assert.match(spar.reply, /pixbot challenges @alice/);
  assert.ok(r.state().duels.some((d) => d.status === "pending" && d.a === "u9" && d.b === "u1"));
  assert.match(await r.line("u9", "pixbot", "!fray spar"), /can't spar with itself/);

  const plain = await botRoom({}, "alice", "pixbot");
  // Without BOT_DEBUG the bot account is refused as a rival or a wallet.
  const once = await plain.say("u1", "alice", "!challenge @pixbot");
  assert.deepEqual(once.replies, ["The bot doesn't fight (yet)! Name a rival: !challenge @name"]);
  assert.ok(!plain.state().duels.length, "no challenge opened");
  const give = await plain.line("u1", "alice", "!give @pixbot 5");
  assert.equal(give, "The bot doesn't take dollars. Give them to a rival!");
  assert.match(await plain.line("u1", "alice", "!fray spar"), /gear up/i, "spar is just the help reply");
});

test("debug bot: the real bot login (pixfray, a known chat bot) still plays every e2e step on the test site", async (t) => {
  const r = await botRoom({ BOT_DEBUG: "1" }, "alice", "bob", "pixfray");
  await r.devLive(false);
  const run = await r.say("u1", "alice", "!fray e2e", { mod: true });
  assert.match(run.replies[0], /^PixFray e2e, pixfray vs alice: 19 of 19 steps passed\.$/);
  // Outside the bot's own commands, a chat line from pixfray is still ignored.
  const open = () => r.state().duels.filter((d) => d.status === "pending").length;
  const before = open();
  const realNow = Date.now;
  t.mock.method(Date, "now", () => realNow() + 60_000); // past the reveal of the run's last fight
  await r.say("u9", "pixfray", "!challenge @bob");
  assert.equal(open(), before, "pixfray's own typed !challenge opens no duel");
});

test("debug bot: !fray e2e plays every command once against the asker and posts which steps passed", async () => {
  const r = await botRoom({ BOT_DEBUG: "1" }, "alice", "pixbot");
  await r.devLive(false);
  assert.match(await r.line("u1", "alice", "!fray e2e"), /only the broadcaster or a mod/);
  const run = await r.say("u1", "alice", "!fray e2e", { mod: true });
  assert.match(run.replies[0], /^PixFray e2e, pixbot vs alice: 19 of 19 steps passed\.$/);
  const detail = run.replies.slice(1).join(" · ");
  assert.doesNotMatch(detail, /FAIL/);
  assert.match(detail, /checkin ok \(not_live\)/);
  assert.match(detail, /fight by alice ok \(quick_duel\)/);
  assert.ok(run.replies.every((line: string) => line.length <= 480));
  const open = r.state().duels.filter((d) => d.status === "pending" || d.status === "active");
  assert.equal(open.length, 0, "the run leaves no open duel");
  // Right after, the pair is still in its cooldown: the run stops at the first challenge and says so.
  const again = await r.say("u1", "alice", "!fray e2e", { mod: true });
  assert.match(again.replies[0], /stopped early/);
  assert.match(again.replies.slice(1).join(" "), /FAIL challenge @alice/);
  // The bot account names an opponent; nobody needs a fighter it doesn't have.
  for (const [id, login, text, reply] of [
    ["u9", "pixbot", "!fray e2e", /name the opponent/],
    ["u9", "pixbot", "!fray e2e @nobody", /@nobody has no saved fighter/],
    ["owner1", "nesszerra", "!fray e2e", /@nesszerra has no saved fighter/],
  ] satisfies [string, string, string, RegExp][])
    assert.match(await r.line(id, login, text), reply, login + " " + text);
});

test("!checkin test mode: answers while offline with what a check-in would give, saves nothing, ends by itself, and steps aside when live", async (t) => {
  const r = room(DEV, { quick: true });
  const say = (id: string, login: string) => r.reply(id, login, "checkin");
  const test = (on: boolean) => r.post("/checkin-test", { on, by: "ModMia" });
  const checkinTest = async () => (await r.adminView()).checkinTest;
  await r.save("u1", "alice");
  await r.devLive(true, "s1");
  assert.match(await say("u1", "alice"), /^@alice checked in: \+1 point \(1-stream streak\)/);
  await r.devLive(false);
  assert.equal(await checkinTest(), null);
  const on = (await test(true)).body.checkinTest;
  assert.equal(on.by, "ModMia");
  assert.ok(on.until > Date.now() + 14 * 60_000 && on.until <= Date.now() + 15 * 60_000);
  assert.deepEqual(await checkinTest(), on);
  const before = await r.profile("u1");
  const reply = "[Test, not saved] @alice would check in: +1 point (2-stream streak). 2 points, 2 unspent.";
  assert.equal(await say("u1", "alice"), reply, "the next stream continues the streak");
  assert.equal(await say("u1", "alice"), reply, "repeatable: nothing was saved");
  const after = await r.profile("u1");
  assert.deepEqual([after.bonus, after.checkins, after.streak], [before.bonus, before.checkins, before.streak]);
  assert.equal(must(r.sql("SELECT COUNT(*) AS n FROM streams")[0]).n, 1, "no stream row for a test");
  assert.match(await say("u2", "bob"), /no fighter/, "a viewer without a fighter still hears how to get one");
  // live wins over test mode: a real check-in, saved
  await r.devLive(true, "s2");
  assert.match(await say("u1", "alice"), /^@alice checked in: \+1 point \(2-stream streak\)/);
  await r.devLive(false);
  assert.equal((await test(false)).body.checkinTest, null);
  const closed = "Check-ins open while nesszerra is live. See you next stream!";
  assert.equal(await say("u1", "alice"), closed);
  // it switches itself off after 15 minutes
  await test(true);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 15 * 60_000 + 1);
  assert.equal(await say("u1", "alice"), closed);
  assert.equal(await checkinTest(), null);
});

test("viewer sprites: send, mod approves, worn and in the catalog with its owner; reject, replace, remove, limits", async () => {
  const r = room();
  await r.save("u1", "alice");
  const send = (userId: string, label: string, extra: Extra = {}) => {
    const [username, displayName] = userId === "u1" ? ["alice", "Alice"] : ["bob", "Bob"];
    return r.post("/sprites", { userId, username, displayName, label, image: b64(makePng(64, 96)), ...extra });
  };
  const review = (id: string, action: string) =>
    r.post("/sprites/review", { id, action, actorId: "mod1", actorName: "Mod" });
  const headers = { "X-Mini-Internal": SECRET, "X-Mini-Channel": "nesszerra" };
  const raw = (path: string) => r.fetch(new Request("https://room" + path, { headers }));
  const catalog = async () => (await r.call("/catalog")).body;
  const mine = async () => (await r.call("/sprites/mine?userId=u1")).body;
  // What alice wears: on her stored profile, on stage, and in build slot 1 (null until that slot exists).
  const worn = async () => {
    const build = r.sql("SELECT data FROM builds WHERE user_id = 'u1' AND slot = 1")[0];
    return [(await r.profile("u1")).avatar, r.player("u1").avatar, build ? JSON.parse(build.data).avatar : null];
  };

  const first = await send("u1", "My Cat!", { ai: true });
  assert.equal(first.status, 201);
  const id1 = first.body.pending.id;
  assert.match(id1, /^v-my-cat-[0-9a-f]{6}$/);
  const { status, ai, width, height } = first.body.pending;
  assert.deepEqual([status, ai, width, height], ["pending", true, 64, 96]);
  const m = await mine();
  assert.deepEqual([m.pending.id, m.live, m.rejected, m.submitsLeft, m.aiLeft], [id1, null, null, 5, 3]);
  assert.equal((await raw("/sprites/png/pending?userId=u1")).headers.get("content-type"), "image/png");
  // Waiting sprites are not public.
  assert.deepEqual(await catalog(), []);
  assert.equal((await raw("/asset/" + id1)).status, 404);
  assert.equal((await r.call("/sprites/list")).body.pending.length, 1);
  assert.equal((await review(id1, "remove")).status, 409);

  // Approve: on the saved fighter and the overlay's player, in the catalog for its owner only, the PNG public.
  const ws = r.live();
  assert.deepEqual((await review(id1, "approve")).body, { ok: true, id: id1, status: "live" });
  assert.deepEqual(await worn(), [id1, id1, null]);
  assert.ok(ws.sent.length > 0);
  const entry = (await catalog())[0];
  const frames = [{ x: 0, y: 0, w: 64, h: 96 }];
  const listing = [id1, "u1", "single", "/api/assets/nesszerra/" + id1, frames, "Uploaded by Alice"];
  assert.deepEqual([entry.id, entry.owner, entry.mode, entry.url, entry.frames, entry.license], listing);
  const asset = await raw("/asset/" + id1);
  assert.deepEqual([asset.status, asset.headers.get("content-type")], [200, "image/png"]);
  assert.equal((await review(id1, "approve")).status, 409);

  // A second approved sprite replaces the first everywhere, build slots included.
  const slot1 = JSON.stringify({ avatar: id1, color: "#123456" });
  r.sql("INSERT INTO builds (user_id, slot, data) VALUES ('u1', 1, ?)", slot1);
  const id2 = (await send("u1", "Dog")).body.pending.id;
  await review(id2, "approve");
  const listed = (await catalog()).map((e: { id: string }) => e.id);
  assert.deepEqual(listed, [id2]);
  assert.equal((await raw("/asset/" + id1)).status, 404);
  assert.deepEqual(await worn(), [id2, id2, id2]);

  // Reject: the image is dropped and the viewer sees it; a new send clears the rejection.
  const id3 = (await send("u1", "Frog")).body.pending.id;
  assert.equal((await review(id3, "reject")).body.status, "rejected");
  assert.equal((await raw("/sprites/png/" + id3)).status, 404);
  const after = await mine();
  const liveUrl = "/api/assets/nesszerra/" + id2;
  assert.deepEqual([after.rejected.id, after.pending, after.live.id, after.live.url], [id3, null, id2, liveUrl]);
  // A viewer with no fighter yet: approval only adds it to the catalog.
  const idb = (await send("u2", "Bob Sprite")).body.pending.id;
  await review(idb, "approve");
  assert.equal(await r.profile("u2"), null);
  const owners = (await catalog()).flatMap((e: { id: string; owner: string }) => [e.id, e.owner]);
  assert.deepEqual(owners, [id2, "u1", idb, "u2"]);

  // Remove: fighters wearing it go back to the default character.
  assert.equal((await review(id2, "remove")).body.status, "removed");
  assert.deepEqual(await worn(), ["player", "player", "player"]);

  // Withdraw a waiting one; the daily send limit counts withdrawn and rejected sends too.
  await send("u1", "Owl");
  assert.equal((await r.call("/sprites/mine?kind=pending&userId=u1", { method: "DELETE" })).body.ok, true);
  assert.equal((await r.call("/sprites/mine?kind=pending&userId=u1", { method: "DELETE" })).status, 404);
  await send("u1", "Bat");
  await send("u1", "Elk");
  const over = await send("u1", "Rat");
  assert.deepEqual([over.status, over.body.reason], [429, "daily_limit"]);
  const jpeg = b64(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
  for (const [userId, label, extra, reason] of [
    ["u1", "x".repeat(25), {}, "invalid_label"],
    ["u2", "Big", { image: b64(makePng(129, 64)) }, "image_dimensions"],
    ["u2", "Jpeg", { image: jpeg }, "not_png"],
  ] satisfies [string, string, Extra, string][])
    assert.equal((await send(userId, label, extra)).body.reason, reason, label);
});

test("viewer sprites: AI redraws per viewer and per channel each day, refunded when the model fails", async () => {
  const r = room();
  const take = (userId: string) => r.post("/sprites/ai", { userId, op: "take" });
  assert.deepEqual((await take("u1")).body, { ok: true, left: 2 });
  await take("u1");
  await take("u1");
  const over = await take("u1");
  assert.deepEqual([over.status, over.body.reason], [429, "ai_daily_limit"]);
  await r.post("/sprites/ai", { userId: "u1", op: "refund" });
  assert.equal((await take("u1")).body.left, 0);
  // The channel cap: other viewers' redraws count toward it.
  r.sql("INSERT INTO sprite_usage (user_id, day, ai) VALUES ('many', ?, 57)", new Date().toISOString().slice(0, 10));
  assert.equal((await take("u2")).body.reason, "ai_channel_limit");
  assert.equal((await r.call("/sprites/mine?userId=u2")).body.aiLeft, 0);
});

test('rooms answer the overlay "ping" with "pong" through the WebSocket auto-response, without waking', () => {
  const had = "WebSocketRequestResponsePair" in globalThis,
    original = workerGlobals.WebSocketRequestResponsePair;
  workerGlobals.WebSocketRequestResponsePair = function (this: object, request: string, response: string) {
    Object.assign(this, { request, response });
  };
  try {
    const ctx = fakeCtx(),
      // Loose: the pairs the room registers, built by the fake class above; the test reads request and response
      pairs: Loose[] = [];
    ctx.setWebSocketAutoResponse = (pair) => pairs.push(pair);
    new ChannelRoom(ctx, asEnv({}));
    const registered = pairs.map((p) => [p.request, p.response]);
    assert.deepEqual(registered, [["ping", "pong"]]);
  } finally {
    if (had) workerGlobals.WebSocketRequestResponsePair = original;
    else delete workerGlobals.WebSocketRequestResponsePair;
  }
});

test("legendary pets: 4 stats rolled at purchase, one free reroll to a new set, refused mid-duel", async () => {
  const r = room({}, { quick: true });
  await r.connectChat("se-streamelements");
  await r.saveAll("alice", "bob");
  await r.admin("giftDollars", { username: "alice", amount: 2000 });
  const refused = async (userId: string, id: string) =>
    (({ status, body }) => [status, body.error])(await r.shop(userId, "reroll", id));
  const bought = (await r.shop("u1", "pet", "dragon")).body;
  const roll: string[] = bought.owned.rolls.dragon;
  assert.equal(roll.length, 4);
  assert.equal(new Set(roll).size, 4, "4 different stats");
  const ordered = ["power", "guard", "luck", "crit", "dodge", "counter", "vitality"].filter((s) => roll.includes(s));
  assert.deepEqual(roll, ordered, "in STATS order");
  assert.deepEqual(bought.owned.rerolled, []);
  const saved = (await r.save("u1", "alice", { pet: "dragon" })).body.profile;
  assert.deepEqual(saved.petBoost, fullStats(Object.fromEntries(roll.map((s) => [s, 1]))));
  // Not a legendary, or not owned: nothing to reroll.
  assert.deepEqual(await refused("u2", "dragon"), [400, "unknown_item"]);
  await r.shop("u1", "pet", "fox");
  assert.deepEqual(await refused("u1", "fox"), [400, "unknown_item"]);
  // An open challenge with the dragon out blocks the reroll.
  const challenge = await r.se("u1", "alice", "challenge", "bob", { ...BARE, messageId: "c1" });
  assert.equal(challenge.status, 200);
  assert.deepEqual(await refused("u1", "dragon"), [409, "in_duel"]);
  await r.admin("cancelDuel", { duelId: must(r.state().duels[0]).id });
  const again = (await r.shop("u1", "reroll", "dragon")).body;
  assert.equal(again.ok, true, again.error);
  assert.notDeepEqual(again.owned.rolls.dragon, roll, "a reroll never gives the same set");
  assert.deepEqual(again.owned.rerolled, ["dragon"]);
  const rerolled = fullStats(Object.fromEntries(again.owned.rolls.dragon.map((s: string) => [s, 1])));
  assert.deepEqual(r.player("u1").petBoost, rerolled, "the fighter on stage takes the new roll");
  assert.deepEqual(await refused("u1", "dragon"), [409, "rerolled"]);
});

test("legendary pets bought before rolls get one when the room starts", async () => {
  const r = room();
  await r.save("u1", "alice");
  const pets = "('u1', 'pet', 'phoenix', 900, 1), ('u1', 'pet', 'fox', 60, 2)";
  r.sql("INSERT INTO owned_items (user_id, kind, item_id, price, bought_at) VALUES " + pets);
  new ChannelRoom(r.ctx, asEnv({ INTERNAL_SECRET: SECRET }));
  const rows = Object.fromEntries(r.sql("SELECT item_id, roll FROM owned_items").map((x) => [x.item_id, x.roll]));
  assert.equal(rows.fox, "", "only legendaries roll");
  assert.equal(String(rows.phoenix).split(",").length, 4);
});

test("!stats: own levels that count, unspent points and the pet; @name for someone else", async () => {
  const r = room({}, { quick: true });
  assert.equal((await r.adminView()).streamelements.names.stats, "!stats");
  await r.saveAll("alice", "bob");
  // Ten wins, in the database and in the live game state (duels keep the two in step).
  r.sql("UPDATE profiles SET wins = 10 WHERE user_id = 'u1'");
  r.edit((s) => (must(s.players.find((p) => p.userId === "u1")).wins = 10));
  const saved = await r.save("u1", "alice", { stats: { power: 2, vitality: 3 } });
  assert.equal(saved.status, 200, saved.body.error);
  assert.equal(r.sql("SELECT vitality FROM profiles WHERE user_id = 'u1'")[0]?.vitality, 3);
  const stats = (target = "") => r.reply("u1", "alice", "stats", target);
  assert.equal(await stats(), "@alice: Power 2, Vitality 3. 5 points unspent.");
  assert.equal(await stats("bob"), "@bob: no upgrades yet. 0 points unspent.", "no limit by default");
  r.edit((s) => (s.config.pairRankedPerStream = 5));
  const capped = "@bob: no upgrades yet. 0 points unspent. 5 ranked duels left between you this stream.";
  assert.equal(await stats("bob"), capped);
  assert.match(await stats("nobody"), /nobody/);
});

test("!changelog: the newest release and the changelog link, from the bot and StreamElements, even while paused", async () => {
  const line = (origin: string) =>
    `PixFray ${LATEST_RELEASE.version}: ${LATEST_RELEASE.name}. Every change: ${origin}/changelog/`;
  const bot = await botRoom({});
  assert.equal(await bot.line("u1", "alice", "!changelog"), line("https://staging.example"));
  const r = room({}, { quick: true });
  assert.equal((await r.adminView()).streamelements.names.changelog, "!changelog");
  r.edit((s) => (s.config.enabled = false));
  const paused = "no fighter needed, and it works while duels are paused";
  assert.equal(await r.reply("u9", "nofighter", "changelog"), line("https://test.example"), paused);
});

test("!resetpair @a @b: mods start a pair's ranked count for this stream over; the mod page does the same", async () => {
  const r = await botRoom({}, "alice", "bob", "cara");
  const plays = (pair: string, n: number) => Array.from({ length: n }, (_, i) => ({ pair, at: 1 + i, stream: "" }));
  const seed = () =>
    r.edit((s) => {
      s.config.pairRankedPerStream = 5;
      s.pairPlays = [...plays("u1:u2", 5), ...plays("u1:u3", 2)];
    });
  const mod = (text: string) => r.line("u9", "modmia", text, { mod: true });
  seed();
  assert.match(await r.line("u1", "alice", "!resetpair @alice @bob"), /only the broadcaster or a mod/i);
  assert.equal(r.state().pairPlays.length, 7, "a viewer changes nothing");
  assert.equal(await mod("!resetpair @Alice @bob"), "Ranked duels reset for alice and bob: 5 left this stream.");
  const pairsLeft = r.state().pairPlays.map((p) => p.pair);
  assert.deepEqual(pairsLeft, ["u1:u3", "u1:u3"], "only that pair's count is cleared");
  assert.equal(await mod("!resetpair @alice @nobody"), "@nobody has no saved fighter on this channel.");
  assert.match(await mod("!resetpair @alice"), /!resetpair @name @name/);
  assert.match(await mod("!resetpair @bob @bob"), /two different fighters/);
  seed();
  const page = await r.admin("resetPair", { a: "@BOB", b: "alice" });
  assert.deepEqual([page.status, page.body.ok, page.body.left], [200, true, 5]);
  assert.equal(r.state().pairPlays.length, 2);
  const missing = await r.admin("resetPair", { a: "bob", b: "zed" });
  assert.deepEqual([missing.status, missing.body.error], [404, "profile_not_found"]);
});

test("legendary rolls: 4 different stats in STATS order, never the set it replaces; stored text parses back", () => {
  let i = 0;
  const seq = (values: number[]) => () => must(values[i++ % values.length]);
  // always the first stat left in the pool
  assert.deepEqual(rollLegendary(seq([0])), ["power", "guard", "luck", "crit"]);
  i = 0;
  // the same draw again is refused; the next draw (last stat each time) wins
  const last = rollLegendary(seq([0, 0, 0, 0, 0.99, 0.99, 0.99, 0.99]), ["power", "guard", "luck", "crit"]);
  assert.deepEqual(last, ["crit", "dodge", "counter", "vitality"]);
  for (let n = 0; n < 50; n++) {
    const roll = rollLegendary();
    assert.equal(new Set(roll).size, 4);
    assert.deepEqual(parseRoll(roll.join(",")), roll);
  }
  for (const [text, roll, why] of [
    ["vitality,crit,dodge,luck", ["luck", "crit", "dodge", "vitality"], "sorted into STATS order"],
    ["crit,dodge,luck", [], "3 stats is no roll"],
    ["crit,dodge,luck,speed", [], "an unknown stat is no roll"],
    ["", [], "empty"],
  ] satisfies [string, string[], string][])
    assert.deepEqual(parseRoll(text), roll, why);
  const rolled = petOf("dragon", "", "crit,dodge,luck,vitality")?.boost;
  assert.deepEqual(rolled, fullStats({ luck: 1, crit: 1, dodge: 1, vitality: 1 }));
  assert.deepEqual(petOf("dragon")?.boost, fullStats({}), "an unrolled legendary boosts nothing");
  assert.deepEqual(cleanBoost({ vitality: 1, counter: 5, crit: "x" }), fullStats({ vitality: 1, counter: 2 }));
});
