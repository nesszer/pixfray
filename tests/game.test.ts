import test from "node:test";
import assert from "node:assert/strict";
import {
  reduceGame,
  createInitialState,
  parseGameCommand,
  defaultConfig,
  hiddenResults,
  shownProfile,
  replayMs,
  normalizeGameState,
  pairRankedLeft,
} from "../server/game.ts";
import type {
  AdminPayload,
  CommandEvent,
  Config,
  Duel,
  GameEvent,
  GameResult,
  GameState,
  Player,
  ProfileInput,
  ReduceOutput,
  Swing,
} from "../server/model.ts";
import {
  handleStreamElements,
  seAmount,
  seCommandLines,
  seHelpText,
  seLookText,
  seReplyText,
  seResultText,
  seTarget,
} from "../server/streamelements.ts";
import * as u from "../server/upgrades.ts";
import type { Stats } from "../server/upgrades.ts";
import { asEnv, fullStats, must } from "./fakes.ts";
import type { Loose } from "./fakes.ts";

const T0 = 1_800_000_000_000;
let seq = 0;

/** A profile field the harness fills in; stats may be partial (the reducer cleans them). */
type ProfileExtra = Omit<ProfileInput, "stats"> & { stats?: Partial<Stats> };
/** An accepted quick duel's result: it always carries the swings. */
type QuickResult = GameResult & { swings: Swing[] };
/** A config as stored before relayLeaseMs was dropped. */
type LegacyConfig = Config & { relayLeaseMs?: unknown };
/** seReplyText's options; some tests leave out origin. */
type SeReplyArgs = Parameters<typeof seReplyText>[0];
/** A partial expectation: the fields `like` compares. */
type Want<T> = { [K in keyof T]?: T[K] | undefined };

/**
 * Keeps state and clock and applies events through the pure reducer.
 * HP-fight tests turn quick duels off; quick-duel tests pass { quick: true }.
 */
class Arena {
  state = createInitialState("nesszerra");
  now = T0;
  last!: ReduceOutput; // the last reduceGame output: every test applies an event before reading it
  /** The room's live check sent with each command (CommandEvent.stream); undefined sends none. */
  stream: { id: string; startedAt: number } | null | undefined;

  constructor({ chat = true, viewers = ["alice", "bob", "cara", "dan"], quick = false } = {}) {
    this.state.config.quickDuel = quick;
    if (chat) this.apply({ type: "chat_subscription", subscriptionId: "sub-1", status: "enabled", createdAt: T0 });
    for (const v of viewers) this.register(v);
  }
  apply(event: GameEvent) {
    this.last = reduceGame(this.state, event, this.now);
    this.state = this.last.state;
    return this.last.result;
  }
  tick(ms: number) {
    this.now += ms;
    return this.apply({ type: "tick" });
  }
  /** Advances the clock in 10 s ticks (alarms fire at least that often while duels are open). */
  advance(ms: number) {
    const end = this.now + ms;
    while (this.now < end) {
      this.now = Math.min(end, this.now + 10_000);
      this.apply({ type: "tick" });
    }
  }
  /** A chat command from login; extra fields (rolls, profile, quick...) go on the event. */
  say(login: string, text: string, extra: Partial<CommandEvent> = {}) {
    return this.apply({
      type: "command",
      messageId: "m" + ++seq,
      userId: "id-" + login,
      username: login,
      displayName: login,
      text,
      timestamp: this.now,
      ...(this.stream !== undefined ? { stream: this.stream } : {}),
      ...extra,
    });
  }
  /** An admin action by a mod; targetProfile is the stored profile of a fighter who isn't in the arena. */
  admin(action: string, payload?: AdminPayload, targetProfile?: ProfileInput) {
    return this.apply({
      type: "admin",
      actorId: "mod",
      action,
      ...(payload && { payload }),
      ...(targetProfile && { targetProfile }),
    });
  }
  config(patch: AdminPayload["patch"], baseVersion?: number) {
    return this.admin("config", { patch, ...(baseVersion ? { baseVersion } : {}) });
  }
  register(login: string, extra: ProfileExtra = {}) {
    const profile = { userId: "id-" + login, username: login, displayName: login, avatar: "player", color: "#112233" };
    return this.apply({
      type: "profile_saved",
      // stats may be partial: the reducer cleans them (cleanStats)
      profile: { ...profile, defaultAbility: "strike", ...extra } as ProfileInput,
    });
  }
  player(login: string) {
    // tests only ask for fighters they created; a miss fails the next assertion
    return this.state.players.find((p) => p.username === login) as Player;
  }
  duel(id: string | undefined) {
    // tests only ask for duels they created; a miss fails the next assertion
    return this.state.duels.find((d) => d.id === id) as Duel;
  }
  fight(a: string, b: string) {
    const c = this.say(a, "!challenge @" + b);
    assert.equal(c.ok, true, c.reason);
    const r = this.say(b, "!accept");
    assert.equal(r.ok, true, r.reason);
    return c.duelId;
  }
}

/** Asserts the fields named in `want` (and only those) deepEqual the same fields of `actual`. */
function like<T extends object>(actual: T | undefined, want: Want<T>, msg?: string) {
  const got = Object.fromEntries(Object.keys(want).map((k) => [k, actual?.[k as keyof T]])); // want's keys are T's keys
  assert.deepEqual(got, want, msg);
}

test("default config: the approved balance preset, with quick duels on", () => {
  const c = defaultConfig();
  like(c, { maxHp: 100, sharedCooldownMs: 1000, maxDuels: 5, challengeTimeoutMs: 30000, inactivityMs: 45000 });
  like(c, { rematchDelayMs: 30000, initialElo: 1000, eloK: 24, quickDuel: true });
  assert.deepEqual(c.abilities, {
    strike: { damage: 20, cooldownMs: 2000 },
    heavy: { damage: 35, cooldownMs: 5000 },
    heal: { amount: 15, cooldownMs: 12000 },
  });
});

test("command parser accepts the spec commands, ignores invisible trailing characters, and rejects junk", () => {
  assert.deepEqual(parseGameCommand("!challenge @Bob"), { action: "duel", target: "bob" });
  assert.deepEqual(parseGameCommand("!duel bob"), { action: "duel", target: "bob" });
  assert.deepEqual(parseGameCommand("!accept"), { action: "accept", target: "" });
  assert.deepEqual(parseGameCommand("!accept @alice"), { action: "accept", target: "alice" });
  assert.deepEqual(parseGameCommand("!decline"), { action: "decline", target: "" });
  assert.deepEqual(parseGameCommand("!attack @bob"), { action: "attack", target: "bob" });
  for (const a of ["strike", "heavy", "heal"]) assert.deepEqual(parseGameCommand("!" + a), { action: a, target: "" });
  assert.deepEqual(parseGameCommand("!HEAVY @Bob"), { action: "heavy", target: "bob" });
  assert.deepEqual(parseGameCommand("!rematch"), { action: "rematch", target: "" });
  assert.deepEqual(parseGameCommand("!REMATCH @cara"), { action: "rematch", target: "" }, "a name after it is ignored");
  assert.deepEqual(parseGameCommand("!fight \u{E0000}"), { action: "accept", target: "" });
  assert.deepEqual(parseGameCommand("!challenge @bob \u034F"), { action: "duel", target: "bob" });
  for (const junk of ["!challenge", "hello !strike", "!strike @bob extra", "!nuke", 42])
    assert.equal(parseGameCommand(junk), null, String(junk));
});

test("a challenge stays pending until the target accepts, declines or 30 s pass; self and unknown targets are refused", () => {
  const w = new Arena();
  assert.equal(w.say("alice", "!challenge @alice").reason, "self_duel");
  assert.equal(w.say("alice", "!challenge @nobody").reason, "target_not_found");
  const c = w.say("alice", "!challenge @bob");
  assert.equal(c.ok, true);
  assert.equal(w.duel(c.duelId).status, "pending");
  assert.equal(w.say("alice", "!strike").reason, "not_in_active_duel");
  assert.equal(w.say("cara", "!accept").reason, "challenge_not_found");
  assert.equal(w.say("alice", "!accept").reason, "challenge_not_found", "challenger cannot accept their own challenge");
  assert.equal(w.say("bob", "!accept").ok, true);
  assert.equal(w.duel(c.duelId).status, "active");
  const d = w.say("cara", "!challenge @dan");
  assert.equal(w.say("dan", "!decline").reason, "challenge_declined");
  assert.equal(w.duel(d.duelId).status, "declined");
  const e = w.say("cara", "!challenge @dan");
  assert.equal(e.ok, true, "declining frees both viewers");
  w.tick(29_999);
  assert.equal(w.duel(e.duelId).status, "pending");
  w.tick(1);
  assert.equal(w.duel(e.duelId).status, "expired");
  assert.equal(w.say("dan", "!accept").reason, "challenge_not_found");
  assert.ok(w.state.events.some((ev) => ev.type === "challenge_expired"));
});

test("challenging your challenger accepts the duel", () => {
  const w = new Arena();
  const c = w.say("alice", "!challenge @bob");
  like(w.say("bob", "!challenge @alice"), { ok: true, reason: "duel_started", duelId: c.duelId });
  assert.equal(w.duel(c.duelId).status, "active");
  assert.equal(w.state.duels.length, 1);
});

test("a viewer can be in only one duel at a time, and each accepted duel counts as one round", () => {
  const w = new Arena();
  const first = w.fight("alice", "bob");
  assert.equal(w.duel(first).round, 1);
  assert.equal(w.say("cara", "!challenge @alice").reason, "player_busy");
  assert.equal(w.say("alice", "!challenge @cara").reason, "player_busy");
  const second = w.say("cara", "!challenge @dan").duelId;
  assert.equal(w.say("alice", "!challenge @dan").reason, "player_busy", "pending challenges also count");
  assert.equal(w.state.round, 1, "pending challenges are not rounds");
  w.say("dan", "!accept");
  assert.equal(w.duel(second).round, 2);
  assert.equal(w.state.round, 2);
  w.admin("resetRound");
  assert.equal(w.state.round, 0);
});

test("at most 5 simultaneous duels per channel (pending challenges count)", () => {
  const names = Array.from({ length: 12 }, (_, i) => "v" + i);
  const w = new Arena({ viewers: names });
  for (let i = 0; i < 4; i++) w.fight(must(names[i * 2]), must(names[i * 2 + 1]));
  assert.equal(w.say("v8", "!challenge @v9").ok, true, "fifth slot used by a pending challenge");
  assert.equal(w.say("v10", "!challenge @v11").reason, "channel_full");
});

test("strike, heavy and heal by command apply the preset amounts; heal never exceeds max HP", () => {
  const w = new Arena();
  const id = w.fight("alice", "bob");
  assert.equal(w.say("alice", "!strike").amount, 20);
  assert.equal(w.duel(id).hp["id-bob"], 80);
  w.now += 1000;
  assert.equal(w.say("alice", "!heavy").amount, 35);
  assert.equal(w.duel(id).hp["id-bob"], 45);
  like(w.say("bob", "!heal"), { ability: "heal", amount: 15 });
  assert.equal(w.duel(id).hp["id-bob"], 60);
  assert.equal(w.player("bob").hp, 60, "player hp mirrors duel hp");
  w.now += 1000;
  assert.equal(w.say("alice", "!heal").amount, 0, "healing at full HP adds nothing");
  assert.equal(w.duel(id).hp["id-alice"], 100);
});

test("!attack uses the default ability chosen on the website; targeting the wrong opponent is rejected", () => {
  const w = new Arena();
  w.register("alice", { defaultAbility: "heavy" });
  w.fight("alice", "bob");
  assert.equal(w.say("alice", "!strike @cara").reason, "wrong_opponent");
  like(w.say("alice", "!attack @bob"), { ok: true, ability: "heavy", amount: 35 });
  w.register("bob", { defaultAbility: "heal" });
  assert.equal(w.say("bob", "!attack").ability, "heal");
  w.now += 5000;
  assert.equal(w.say("alice", "!strike @bob").ok, true);
});

test("per-ability cooldowns run in real time per fighter, plus a 1 s shared delay", () => {
  const w = new Arena();
  w.fight("alice", "bob");
  assert.equal(w.say("alice", "!strike").ok, true);
  assert.equal(w.say("bob", "!heal").ok, true, "alice using an ability does not block bob");
  let r = w.say("alice", "!heavy");
  assert.equal(r.reason, "cooldown");
  assert.equal(r.retryAt, w.now + 1000, "shared delay blocks every ability for 1 s");
  w.now += 999;
  assert.equal(w.say("alice", "!heavy").reason, "cooldown");
  w.now += 1;
  assert.equal(w.say("alice", "!heavy").ok, true, "other abilities are free after the shared delay");
  // strike was used at T0; its own 2 s cooldown ends at T0+2000.
  w.now = T0 + 1999;
  r = w.say("alice", "!strike");
  assert.equal(r.reason, "cooldown");
  assert.equal(r.retryAt, T0 + 2000);
  w.now = T0 + 2000;
  assert.equal(w.say("alice", "!strike").ok, true);
  // heavy used at T0+1000 -> available at T0+6000.
  w.now = T0 + 5999;
  assert.equal(w.say("alice", "!heavy").reason, "cooldown");
  w.now = T0 + 6000;
  assert.equal(w.say("alice", "!heavy").ok, true);
  // bob healed at T0: heal's 12 s cooldown ends at T0+12000.
  w.now = T0 + 11_999;
  assert.equal(w.say("bob", "!heal").reason, "cooldown");
  w.now = T0 + 12_000;
  assert.equal(w.say("bob", "!heal").ok, true);
});

/** A chat subscription Twitch hasn't verified yet. */
const verifying = (w: Arena, subscriptionId: string) =>
  w.apply({ type: "chat_subscription", subscriptionId, status: "webhook_callback_verification_pending" });

function knockOut(w: Arena, attacker: string) {
  for (let i = 0; i < 10; i++) {
    const r = w.say(attacker, "!strike");
    if (r.reason === "duel_completed") return r;
    assert.equal(r.ok, true, r.reason);
    w.advance(3000);
  }
  throw new Error("no KO");
}

test("KO completes the duel; the loser respawns at full health after respawnMs, even if they chat meanwhile", () => {
  const w = new Arena();
  const id = w.fight("alice", "bob");
  assert.equal(knockOut(w, "alice").winnerId, "id-alice");
  assert.equal(w.duel(id).status, "completed");
  assert.equal(w.duel(id).hp["id-bob"], 0);
  // Overlay events: the final blow's duel_action comes right before duel_completed.
  const types = w.state.events.map((e) => e.type);
  const done = types.lastIndexOf("duel_completed");
  assert.equal(types[done - 1], "duel_action");
  // a duel_action event carries the duel's hp map (userId -> hp)
  assert.equal((must(w.state.events[done - 1]).hp as Record<string, number>)["id-bob"], 0);
  // The channel passes the stored profile (hp=max, respawnAt=0) with every chat message; it must not skip the respawn.
  const stored = { userId: "id-bob", username: "bob", registered: true, hp: 100, respawnAt: 0, elo: 988 };
  w.apply({ type: "presence", userId: "id-bob", username: "bob", profile: stored });
  assert.equal(w.player("bob").hp, 0);
  assert.ok(w.player("bob").respawnAt > w.now);
  assert.equal(w.player("alice").hp, 100);
  assert.equal(w.say("bob", "!challenge @cara").reason, "respawning");
  like(w.say("alice", "!challenge @bob"), { reason: "respawning", userId: "id-bob" });
  w.tick(defaultConfig().respawnMs);
  assert.deepEqual(w.state.events.at(-1), {
    id: String(w.state.revision),
    type: "player_respawned",
    at: w.now,
    userId: "id-bob",
  });
  like(w.player("bob"), { hp: 100, respawnAt: 0 });
  assert.equal(w.say("bob", "!challenge @cara").ok, true);
});

test("completed duels rate Elo (start 1000, K=24); an upset gains more", () => {
  const w = new Arena();
  const id = w.fight("alice", "bob");
  knockOut(w, "alice");
  assert.deepEqual(must(w.duel(id).ratings)["id-alice"], { before: 1000, after: 1012, delta: 12 });
  assert.deepEqual(w.last.dirtyProfileIds.length, 0, "channel persists participants on duel_completed");
  // Upset: lower-rated bob beats alice and gains more than 12.
  w.advance(30_000);
  const id2 = w.fight("bob", "alice");
  knockOut(w, "bob");
  const exp = 1 / (1 + 10 ** ((1012 - 988) / 400));
  assert.equal(must(must(w.duel(id2).ratings)["id-bob"]).after, Math.round(988 + 24 * (1 - exp)));
  assert.ok(must(must(w.duel(id2).ratings)["id-bob"]).delta > 12);
});

test("rematches between the same pair wait 30 s", () => {
  const w = new Arena();
  w.fight("alice", "bob");
  knockOut(w, "alice");
  const doneAt = w.now;
  w.advance(5000);
  like(w.say("alice", "!challenge @bob"), { reason: "rematch_cooldown", retryAt: doneAt + 30_000 });
  assert.equal(w.say("alice", "!challenge @cara").ok, true, "other opponents are allowed");
  w.say("cara", "!decline");
  w.advance(doneAt + 30_000 - w.now);
  assert.equal(w.say("bob", "!challenge @alice").ok, true);
});

test("45 s of inactivity cancels a duel without scoring; each action resets the timer", () => {
  const w = new Arena();
  const id = w.fight("alice", "bob");
  w.say("alice", "!heavy");
  w.advance(44_999);
  assert.equal(w.duel(id).status, "active");
  w.advance(1);
  like(w.duel(id), { status: "cancelled", cancelReason: "inactivity", winnerId: null });
  for (const n of ["alice", "bob"]) like(w.player(n), { elo: 1000, wins: 0, losses: 0, hp: 100, respawnAt: 0 }, n);
  assert.equal(w.say("alice", "!challenge @bob").ok, true, "no rematch lock after a cancelled duel");
  const v = new Arena();
  const vid = v.fight("alice", "bob");
  v.advance(40_000);
  v.say("alice", "!strike");
  v.advance(40_000);
  assert.equal(v.duel(vid).status, "active");
});

test("ranked duels require a signed-in profile", () => {
  const w = new Arena({ viewers: ["alice"] });
  // guest chats but never signed in on the website
  w.apply({ type: "presence", userId: "id-guest", username: "guest" });
  assert.equal(w.say("alice", "!challenge @guest").reason, "ranked_sign_in_required");
  // a chat message cannot forge registration: only profile_saved / stored profiles set it
  w.apply({
    type: "presence",
    userId: "id-guest",
    username: "guest",
    profile: { userId: "id-guest", username: "guest" },
  });
  assert.equal(w.player("guest").registered, false);
});

test("chat disconnect pauses combat and cancels unfinished duels unscored; a revocation records the reason", () => {
  const w = new Arena();
  w.fight("alice", "bob");
  w.say("alice", "!heavy");
  const pending = w.say("cara", "!challenge @dan").duelId;
  assert.equal(w.apply({ type: "chat_disconnected", reason: "disconnected" }).reason, "chat_disconnected");
  assert.equal(w.duel(pending).status, "cancelled");
  assert.equal(w.player("alice").elo, 1000);
  assert.equal(w.player("bob").hp, 100);
  like(w.state.chat, { connected: false, status: "disconnected", subscriptionId: "" });
  assert.equal(w.say("alice", "!challenge @bob").reason, "chat_offline", "commands are rejected while paused");
  verifying(w, "sub-2");
  assert.equal(w.say("alice", "!challenge @bob").reason, "chat_offline", "paused until Twitch verifies the webhook");
  assert.equal(w.apply({ type: "chat_verified", subscriptionId: "sub-2" }).reason, "chat_connected");
  assert.equal(must(w.state.events.at(-1)).type, "chat_connected");
  assert.equal(w.say("alice", "!challenge @bob").ok, true);
  const v = new Arena();
  v.fight("alice", "bob");
  v.apply({ type: "chat_disconnected", reason: "authorization_revoked" });
  like(v.state.chat, { connected: false, status: "authorization_revoked", revokedReason: "authorization_revoked" });
  assert.equal(must(v.state.events.at(-1)).reason, "authorization_revoked");
});

test("quiet chat never pauses combat (no heartbeat lease)", () => {
  const w = new Arena();
  w.tick(6 * 3_600_000);
  assert.equal(w.state.chat.connected, true);
  w.register("alice");
  w.register("bob"); // idle viewers left the arena meanwhile
  assert.equal(w.say("alice", "!challenge @bob").ok, true);
});

test("webhook verification may arrive before the subscription is recorded", () => {
  const w = new Arena({ chat: false });
  assert.equal(w.apply({ type: "chat_verified", subscriptionId: "sub-9" }).reason, "chat_verified_early");
  assert.equal(w.state.chat.connected, false);
  assert.equal(verifying(w, "sub-9").reason, "chat_connected");
  like(w.state.chat, { connected: true, status: "enabled", verifiedId: "" });
  // a verification for some other subscription never connects the current one
  const v = new Arena({ chat: false });
  verifying(v, "sub-1");
  v.apply({ type: "chat_verified", subscriptionId: "sub-other" });
  assert.equal(v.state.chat.connected, false);
});

test("rejected commands are logged to the event list; the hourly subscription check persists without adding events", () => {
  const w = new Arena();
  const e: GameEvent = {
    type: "command_rejected",
    userId: "id-alice",
    command: "strike",
    reason: "not_in_active_duel",
  };
  assert.equal(w.apply(e).ok, true);
  assert.deepEqual(w.state.events.at(-1), { id: String(w.state.revision), at: w.now, ...e });
  const rev = w.state.revision;
  w.now += 5000;
  const r = reduceGame(w.state, { type: "chat_checked" }, w.now);
  assert.equal(r.result.reason, "chat_checked");
  assert.equal(r.state.revision, rev);
  assert.equal(r.changed, true, "checkedAt must be persisted");
  assert.equal(r.visible, false, "no overlay broadcast needed");
  assert.equal(r.state.chat.checkedAt, w.now);
});

test("duplicate and stale chat commands are ignored", () => {
  const w = new Arena();
  w.say("alice", "!challenge @bob");
  assert.equal(w.say("bob", "!accept", { messageId: "dup-1" }).ok, true);
  assert.equal(w.say("bob", "!accept", { messageId: "dup-1" }).reason, "duplicate");
  assert.equal(w.say("bob", "!accept", { messageId: "old", timestamp: w.now - 61_000 }).reason, "stale_command");
});

test("the reducer does not mutate its input state, and duel history stays bounded (declined challenges too)", () => {
  const w = new Arena();
  const input = w.state;
  const before = JSON.stringify(input);
  w.say("alice", "!challenge @bob");
  assert.equal(JSON.stringify(input), before);
  for (let i = 0; i < 40; i++) {
    w.say("alice", "!challenge @bob");
    w.say("bob", "!decline");
  }
  w.tick(1);
  assert.ok(w.state.duels.length <= 25);
});

test("stored state from older versions: relay state and relayLeaseMs are dropped, presets and prices migrate", () => {
  const w = new Arena({ chat: false, viewers: [] });
  const legacy = {
    ...createInitialState("nesszerra"),
    relay: { connected: true, lastSeen: T0 },
    config: { ...defaultConfig(), relayLeaseMs: 30000 },
  };
  w.state = legacy;
  w.tick(0);
  assert.equal(w.state.relay, undefined);
  assert.equal((w.state.config as LegacyConfig).relayLeaseMs, undefined); // the test checks the legacy field is gone
  assert.equal(w.state.chat.connected, false);
  const rolled = w.config({ ...defaultConfig(), relayLeaseMs: 30000, maxHp: 120 });
  assert.equal(rolled.ok, true, "an old config with relayLeaseMs still rolls back: " + rolled.reason);
  assert.equal(w.state.config.maxHp, 120);
  assert.equal((w.state.config as LegacyConfig).relayLeaseMs, undefined); // as above
  // An untouched first-preset config moves to the faster preset; an edited one stays.
  const old = {
    strike: { damage: 10, cooldownMs: 3000 },
    heavy: { damage: 25, cooldownMs: 8000 },
    heal: { amount: 15, cooldownMs: 10000 },
  };
  const v1 = { ...createInitialState("x"), config: { ...defaultConfig(), inactivityMs: 60000, abilities: old } };
  assert.deepEqual(reduceGame({ ...v1, configVersion: 1 }, { type: "tick" }, T0).state.config, defaultConfig());
  assert.deepEqual(reduceGame({ ...v1, configVersion: 2 }, { type: "tick" }, T0).state.config.abilities, old);
  // The 2026-10-06 price cut moves prices still at the old defaults and keeps prices a mod changed.
  const prices = {
    petPriceCommon: 30,
    recolorPrice: 60,
    buildSlotPrice: 200,
    petPriceLegendary: 777,
    hatPricePerWin: 10,
  };
  const config = { ...defaultConfig(), ...prices };
  const state = normalizeGameState({ ...createInitialState("nesszerra"), config, configVersion: 4 });
  like(state.config, { petPriceCommon: 10, recolorPrice: 20, buildSlotPrice: 60, hatPricePerWin: 3 });
  assert.equal(state.config.petPriceLegendary, 777, "a custom price stays");
  assert.equal(state.priceSchema, 2);
  // once migrated, a mod may set an old default on purpose
  const later = normalizeGameState({ ...state, config: { ...state.config, petPriceCommon: 30 } });
  assert.equal(later.config.petPriceCommon, 30);
});

test("mods can cancel duels (unscored) and disabling duels cancels all of them", () => {
  const w = new Arena();
  const id = w.fight("alice", "bob");
  const id2 = w.fight("cara", "dan");
  assert.equal(w.admin("cancelDuel", { duelId: id }).ok, true);
  assert.equal(w.duel(id).cancelReason, "moderator_cancelled");
  assert.equal(w.config({ enabled: false }).ok, true);
  assert.equal(w.duel(id2).cancelReason, "duels_disabled");
  assert.equal(w.say("alice", "!challenge @bob").reason, "duels_disabled");
});

test("config edits are validated, versioned, and only affect new duels", () => {
  const w = new Arena();
  const id = w.fight("alice", "bob");
  assert.equal(w.state.configVersion, 1);
  const ok = w.config({ abilities: { strike: { damage: 40 } } }, 1);
  assert.equal(ok.ok, true);
  assert.equal(ok.configVersion, 2);
  assert.equal(w.state.config.abilities.strike.damage, 40);
  assert.equal(w.state.config.abilities.strike.cooldownMs, 2000, "partial ability patch keeps other fields");
  assert.equal(w.config({ maxHp: 120 }, 1).reason, "config_version_conflict");
  assert.equal(w.say("alice", "!strike").amount, 20, "running duel keeps the rules it started with");
  w.admin("cancelDuel", { duelId: id });
  w.fight("alice", "bob");
  assert.equal(w.say("alice", "!strike").amount, 40);
});

test("config patches out of range are refused without bumping the version", () => {
  const w = new Arena();
  type Row = [AdminPayload["patch"], string];
  const cases: Row[] = [
    [{ maxDuels: 9 }, "invalid_config_maxDuels"],
    [{ pairRankedPerStream: 51 }, "invalid_config_pairRankedPerStream"], // the ranked limit per pair is 0 (none) to 50
    [{ reminderMin: 5 }, "invalid_config_reminderMin"], // the bot reminder is off (0) or 10 to 240 minutes
    [{ bogus: 1 }, "unknown_config_field"],
    [{ abilities: { strike: { amount: 5 } } }, "invalid_config_ability_field"],
    [{ quickDuel: "yes" }, "invalid_config_quickDuel"],
    [{ announce: "left" }, "invalid_config_announce"],
    ...[14, 101, 30.5, "30"].map((v): Row => [{ maxOnStream: v }, "invalid_config_maxOnStream"]),
    ...[-1, 60_001, 1.5, "9000"].map((v): Row => [{ streamDelayMs: v }, "invalid_config_streamDelayMs"]),
  ];
  for (const [patch, reason] of cases) assert.equal(w.config(patch).reason, reason, JSON.stringify(patch));
  assert.equal(w.state.configVersion, 1);
});

test("rank resets reach offline profiles and report ids to persist; admin events need an actor", () => {
  const w = new Arena();
  w.fight("alice", "bob");
  knockOut(w, "alice");
  assert.equal(w.admin("resetRank", { userId: "id-alice" }).ok, true);
  assert.deepEqual(w.last.rankResetIds, ["id-alice"]);
  assert.equal(w.player("alice").elo, 1000);
  assert.equal(w.admin("resetRank", { userId: "id-zed" }, { userId: "id-zed", registered: true }).ok, true);
  assert.equal(w.admin("resetRank", { userId: "id-none" }).reason, "profile_not_found");
  assert.equal(w.admin("removePlayer", { userId: "id-bob" }).ok, true);
  assert.deepEqual(w.last.deletedProfileIds, ["id-bob"]);
  assert.equal(w.apply({ type: "admin", action: "resetAll" }).reason, "unauthorized");
});

test("resetAll clears arena players, open duels and rematch locks but keeps profiles", () => {
  const w = new Arena();
  w.register("alice");
  w.register("bob");
  const id = w.fight("alice", "bob");
  w.state.rematchLocks.push({ pair: "id-alice:id-bob", until: w.now + 30_000 });
  assert.equal(w.admin("resetAll").ok, true);
  assert.equal(w.state.players.length, 0);
  assert.equal(w.state.rematchLocks.length, 0);
  assert.equal(w.duel(id).status, "cancelled");
  assert.equal(w.last.deletedProfileIds.length, 0);
});

test("a duel ends in a handful of hits", () => {
  const w = new Arena();
  const id = w.fight("alice", "bob");
  let hits = 0;
  while (w.duel(id).status === "active" && hits < 20) {
    w.advance(5_000);
    w.say("alice", hits % 2 ? "!strike" : "!heavy");
    hits++;
  }
  assert.ok(hits <= 4, `took ${hits} hits`);
});

/** One StreamElements command from bob through handleStreamElements; the room answers with `reply`. */
async function seCall(
  action: string,
  query: string,
  reply: unknown,
  extra: Partial<Parameters<typeof handleStreamElements>[2]> = {},
) {
  let sent: Loose; // the JSON body the handler sent; the test reads fields off it
  const url = new URL(`https://x/api/se/nesszerra/${action}?k=${"b2".repeat(24)}&id=2&u=bob&d=bob&${query}&m=1`);
  const res = await handleStreamElements(new Request(url), asEnv({}), {
    url,
    origin: "https://x",
    channels: ["nesszerra"],
    roomFetch: async (c, p, init) => {
      sent = JSON.parse(init.body as string); // the handler posts a JSON string body
      return Response.json(reply);
    },
    ...extra,
  });
  return { text: await res.text(), sent };
}

/** seReplyText for u1 challenging bob, unless `extra` says otherwise. */
function seReply(state: GameState, result: GameResult, extra: Partial<SeReplyArgs> = {}) {
  const args = { result, state, actorId: "u1", action: "challenge", target: "bob", ...extra };
  return seReplyText(args as SeReplyArgs); // no origin unless extra has one: those replies carry no link
}

test("StreamElements command lines: a bare command sends t=-, !give sends a=; seAmount and seTarget clean the input", () => {
  const lines = seCommandLines("https://x", "nesszerra", "k1");
  assert.match(must(lines[1]).response, /t=\$\(queryescape \$\(1\|-\)\)/);
  assert.match(must(lines.find((l) => l.action === "give")).response, /&a=\$\(queryescape \$\(2\|-\)\)\)$/);
  assert.ok(!must(lines.find((l) => l.action === "wallet")).response.includes("&a="));
  const amounts = ["20", "$20", " 7 ", "-", "", "2.5", "-3", "12345678", "ten"];
  assert.deepEqual(amounts.map(seAmount), [20, 20, 7, null, null, null, null, null, null], "20 or $20 only");
  for (const raw of ["\u{E0000}", "-", "bad-name"]) assert.equal(seTarget(raw), "", raw);
  for (const raw of ["@Bob\u{E0000}", "@bob,", "@@bob", "bob!", "@Bob?", "bob."])
    assert.equal(seTarget(raw), "bob", raw);
});

test("StreamElements handler: what reaches the room, empty and missing replies, and a switch from a subscription", async () => {
  assert.equal((await seCall("accept", "t=-", { reply: "ok" })).sent.target, "", "a bare command has no target");
  const { sent } = await seCall("give", "t=%40cara&a=%2415", { reply: "ok" });
  assert.deepEqual([sent.action, sent.target, sent.amount], ["give", "cara", "$15"]);
  assert.equal((await seCall("accept", "t=-", { reply: "" })).text, "", "a repeated message id posts nothing");
  assert.equal((await seCall("accept", "t=-", {})).text, "That move didn't land. Try again in a moment!");
  // when the room switches over from a Twitch subscription, the Worker is asked to delete it
  const dropped: string[] = [];
  const dropSubscription = (id: string) => void dropped.push(id);
  const { text } = await seCall("decline", "t=-", { reply: "hi", switchedFrom: "sub-1" }, { dropSubscription });
  assert.equal(text, "hi");
  await seCall("decline", "t=-", { reply: "hi" }, { dropSubscription });
  assert.deepEqual(dropped, ["sub-1"]);
});

test("StreamElements replies: the sign-up link names the channel; help and look texts", () => {
  const origin = "https://chat.example";
  for (const channel of ["miolafff", "nesszerra"]) {
    const reply = seReply(createInitialState(channel), { ok: false, reason: "target_not_found" }, { origin });
    assert.equal(reply, `@bob has no fighter in the arena yet! Send them to https://chat.example/?channel=${channel}`);
  }
  const again = / Again\? !again\. More: !checkin !wallet !ranks !look\. Gear up on the PixFray site$/;
  assert.match(seHelpText({ names: { rematch: "!again" } }), again);
  assert.equal(seLookText({ who: "Alice", hasFighter: true }), "@Alice, change your look on the PixFray site");
});

test('StreamElements "seeing stars" names the knocked-out fighter, not the one who asked', () => {
  const state = createInitialState("nesszerra");
  state.players.push(
    // partial players on purpose: the reply reads only the names
    { userId: "u1", username: "alice", displayName: "Alice" } as Player,
    { userId: "u2", username: "bob", displayName: "Bob" } as Player, // as above
  );
  const reply = (result: Partial<GameResult>) => seReply(state, { ok: false, reason: "respawning", ...result });
  assert.equal(reply({ userId: "u2" }), "Bob is still seeing stars. Give it a few seconds!");
  assert.equal(reply({}), "Alice is still seeing stars. Give it a few seconds!");
  // Right after a quick duel the knocked-out fighter is the loser, and the stream hasn't shown that yet.
  const ratings = { u1: { before: 1000, after: 1012 }, u2: { before: 1000, after: 988 } };
  const revealAt = Date.now() + 10_000;
  const duel = { id: "d1", status: "completed", a: "u1", b: "u2", winnerId: "u1", revealAt, ratings };
  state.duels.push(duel as unknown as Duel); // a partial duel (ratings without delta) on purpose: the reply reads only these fields
  assert.equal(reply({ userId: "u2" }), "That fight is still playing on stream. Give it a few seconds!");
});

test("the bot result line says how the duel was won", () => {
  const base = { winner: "Bean", loser: "Aria", w: { after: 1014, delta: 14 }, l: { after: 989, delta: -11 } };
  const elo = "Bean 1014 Elo (+14), Aria 989 Elo (-11).";
  const cases: [Partial<Parameters<typeof seResultText>[0]>, string][] = [
    [{}, `Bean beat Aria! ${elo}`],
    [{ flawless: true }, `Bean beat Aria, flawless! ${elo}`],
    [{ decision: "hp" }, `Bean beat Aria on HP! ${elo}`],
    [{ decision: "sudden_death" }, `Bean beat Aria in sudden death! ${elo}`],
    [
      { unrated: "pair_cap" },
      "Bean beat Aria! Just for fun (ranked limit for this pair reached): no Elo, pays half, ranked again next stream.",
    ],
    [{ unrated: "offline" }, "Bean beat Aria! Just for fun (stream offline): no rank or dollars."],
    [{ lastRanked: true }, `Bean beat Aria! ${elo} Last ranked duel between them this stream.`],
    [
      { unrated: "new_account" },
      "Bean beat Aria! Just for fun (a Twitch account under 7 days old): no Elo or dollars.",
    ],
  ];
  for (const [extra, text] of cases) assert.equal(seResultText({ ...base, ...extra }), text);
});

function quickWith(w: Arena, rolls: number[]): QuickResult {
  w.say("alice", "!challenge @bob");
  return w.say("bob", "!accept", { rolls }) as QuickResult; // an accepted quick duel always returns its swings
}
// roll r gives die 1 + floor(r * 6): 0.9 -> 6 (crit 50), 0.75 -> 5 (hit 34), 0.5 -> 4 (miss), 0.1 -> 1 (counter 34)
function quick(rolls: number[]) {
  const w = new Arena({ quick: true });
  const r = quickWith(w, rolls);
  return { w, r, duel: must(w.state.duels.at(-1)), actions: w.state.events.filter((e) => e.type === "duel_action") };
}
const pluck = <K extends keyof Swing>(r: QuickResult, key: K) => r.swings.map((s) => s[key]);

test("quick duels: turns alternate, 6 crits for 50, 5 hits for 34, 1-2 counter for 34, 3-4 miss", () => {
  const cases = [
    { rolls: [0.9, 0.5, 0.9], winner: "alice", dice: [6, 4, 6], outcomes: ["crit", "miss", "crit"], hp: 100 },
    { rolls: Array(5).fill(0.75), winner: "alice", dice: Array(5).fill(5), outcomes: Array(5).fill("hit"), hp: 32 },
    { rolls: Array(5).fill(0.1), winner: "bob", dice: Array(5).fill(1), outcomes: Array(5).fill("counter"), hp: 32 },
  ];
  for (const c of cases) {
    const { w, r, duel, actions } = quick(c.rolls);
    const name = String(c.rolls);
    const loser = c.winner === "alice" ? "bob" : "alice";
    const flawless = c.hp === 100;
    like(r, { reason: "quick_duel", winnerId: "id-" + c.winner, winnerHp: c.hp, flawless, decision: "ko" }, name);
    assert.deepEqual(pluck(r, "die"), c.dice, name);
    assert.deepEqual(pluck(r, "outcome"), c.outcomes, name);
    assert.equal(duel.status, "completed", name);
    assert.equal(duel.hp["id-" + loser], 0, name);
    like(w.player(c.winner), { wins: 1, elo: flawless ? 1015 : 1012 }, "flawless wins add 3 Elo: " + name);
    like(w.player(loser), { losses: 1, elo: 988 }, name);
    assert.ok(w.player(loser).respawnAt > w.now, name);
    assert.equal(actions.length, c.dice.length, name);
    assert.equal(actions.filter((e) => e.miss).length, c.outcomes.filter((o) => o === "miss").length, name);
    assert.equal(actions.filter((e) => e.crit).length, c.outcomes.filter((o) => o === "crit").length, name);
    assert.equal(must(actions.at(-1)).finisher, true, name);
    assert.equal(actions.filter((e) => e.finisher).length, 1, name);
  }
});

test("quick duels: after 12 rolls more HP wins; equal HP goes to sudden death", () => {
  const onHp = quick([0.75, ...Array(11).fill(0.5)]);
  like(onHp.r, { decision: "hp", winnerId: "id-alice" });
  assert.equal(onHp.r.swings.length, 12);
  assert.equal(onHp.duel.decision, "hp");
  assert.equal(must(onHp.w.state.events.find((e) => e.type === "duel_completed")).decision, "hp");
  const sudden = quick([...Array(12).fill(0.5), 0.5, 0.75]);
  assert.equal(sudden.r.decision, "sudden_death");
  assert.equal(sudden.r.swings.length, 14);
  assert.equal(sudden.r.winnerId, "id-bob", "roll 14 is the swing of bob");
  assert.equal(must(sudden.actions.at(-1)).amount, 100, "a sudden-death blow knocks out");
  assert.equal(sudden.duel.hp["id-alice"], 0);
});

test("quick duels work through a mutual challenge; the banner, stream cap and stream delay (0 to 60 s) are channel settings", () => {
  const w = new Arena({ quick: true });
  w.say("alice", "!challenge @bob");
  assert.equal(w.say("bob", "!challenge @alice").reason, "quick_duel");
  assert.equal(w.config({ announce: "top" }).ok, true);
  assert.equal(w.state.config.announce, "top");
  assert.equal(w.state.config.maxOnStream, 50, "up to 50 characters on stream by default");
  assert.equal(w.config({ maxOnStream: 15 }).ok, true);
  assert.equal(w.state.config.maxOnStream, 15);
  assert.equal(w.state.config.streamDelayMs, 6000);
  assert.equal(w.config({ streamDelayMs: 20_000 }).ok, true);
  const duel = w.duel(w.fight("cara", "dan"));
  assert.equal(duel.revealAt, w.now + replayMs(must(w.last.result.swings).length) + 20_000, "the delay moves revealAt");
  assert.equal(w.config({ quickDuel: false }).ok, true);
});

test("quick duels hide the result until the stream has played it out (revealAt)", () => {
  const w = new Arena({ quick: true });
  const duel = w.duel(w.fight("alice", "bob"));
  const rolls = must(w.last.result.swings).length;
  assert.equal(duel.status, "completed");
  assert.equal(duel.revealAt, w.now + replayMs(rolls) + w.state.config.streamDelayMs);
  assert.equal(replayMs(0), replayMs(1), "at least one roll is replayed");
  const hidden = hiddenResults(w.state, w.now);
  const winner = must(duel.winnerId);
  const loser = winner === "id-alice" ? "id-bob" : "id-alice";
  assert.deepEqual(hidden.get(winner), { elo: 1000, wins: 1, losses: 0, dollars: 5 });
  assert.deepEqual(hidden.get(loser), { elo: 1000, wins: 0, losses: 1, dollars: 3 });
  const saved = { userId: winner, elo: must(must(duel.ratings)[winner]).after, wins: 1, losses: 0 };
  assert.deepEqual(shownProfile(saved, hidden), { userId: winner, elo: 1000, wins: 0, losses: 0 });
  assert.equal(shownProfile({ ...saved, dollars: 12 }, hidden).dollars, 7, "a hidden payout stays out of !wallet");
  assert.equal(shownProfile<Loose>(null, hidden), null); // null on purpose: the test checks it passes through
  const cara = { userId: "id-cara", elo: 1000, wins: 0, losses: 0 };
  assert.equal(shownProfile(cara, hidden), cara, "fighters with nothing hidden are unchanged");
  assert.equal(hiddenResults(w.state, duel.revealAt).size, 0, "shown once the stream has played it");
  // Until then a challenge touching either fighter gets one answer, so it can't tell the winner from the loser.
  w.advance(3_500);
  assert.ok(w.now < duel.revealAt);
  assert.equal(w.say("alice", "!challenge @cara").reason, "result_hidden");
  assert.equal(w.say("bob", "!challenge @cara").reason, "result_hidden");
  assert.equal(w.say("alice", "!challenge @bob").reason, "rematch_cooldown", "the same pair hears the rematch wait");
  w.now = duel.revealAt;
  assert.equal(w.say("cara", "!challenge @" + winner.slice(3)).ok, true, "open again once the stream has shown it");
});

test("!rematch challenges the last finished duel's opponent, with the rematch lock", () => {
  const w = new Arena({ quick: true });
  assert.equal(w.say("alice", "!rematch").reason, "no_previous_opponent");
  w.fight("alice", "bob");
  assert.equal(w.player("alice").lastOpponentId, "id-bob");
  assert.equal(w.player("bob").lastOpponentId, "id-alice");
  assert.match(must(w.say("bob", "!rematch").reason), /^(respawning|rematch_cooldown)$/);
  w.advance(31_000);
  const c = w.say("bob", "!rematch @cara");
  assert.equal(c.ok, true, c.reason);
  like(w.duel(c.duelId), { a: "id-bob", b: "id-alice", status: "pending" }, "a name after !rematch is ignored");
  assert.equal(w.say("alice", "!rematch").reason, "quick_duel", "answering !rematch with !rematch starts the duel");
  // !rematch answers a waiting challenge even when the answerer's own last opponent is someone else.
  w.advance(31_000);
  w.fight("alice", "cara");
  w.advance(31_000);
  assert.equal(w.say("bob", "!rematch").ok, true, "bob rematches alice");
  assert.equal(w.player("alice").lastOpponentId, "id-cara");
  assert.equal(w.say("alice", "!rematch").reason, "quick_duel", "alice answers bob, not cara");
  assert.equal(w.player("alice").lastOpponentId, "id-bob");
  // A cancelled or declined duel doesn't count as a fight: the last opponent stays the same.
  w.advance(31_000);
  w.say("alice", "!challenge @cara");
  w.say("cara", "!decline");
  assert.equal(w.player("alice").lastOpponentId, "id-bob");
  // A fighter who left the arena still has the saved opponent; the room passes it as targetProfile.
  const v = new Arena({ quick: true, viewers: ["alice"] });
  const r = v.say("alice", "!rematch", {
    profile: { userId: "id-alice", username: "alice", registered: true, lastOpponentId: "id-dan" },
    targetProfile: { userId: "id-dan", username: "dan", displayName: "dan", registered: true },
  });
  assert.equal(r.ok, true, r.reason);
});

test("!rematch works in the HP fight too", () => {
  const w = new Arena();
  w.fight("alice", "bob");
  for (let i = 0; i < 20 && must(w.state.duels.at(-1)).status === "active"; i++) {
    w.now += 13_000;
    w.say("alice", "!heavy");
  }
  assert.equal(must(w.state.duels.at(-1)).status, "completed");
  w.advance(31_000);
  assert.equal(w.say("alice", "!rematch").ok, true);
  assert.equal(w.say("bob", "!accept").reason, undefined, "a plain accept starts it");
  assert.equal(must(w.state.duels.at(-1)).status, "active");
});

test("a command marked quick (StreamElements, no attack commands) settles at once even with quick duels off", () => {
  const w = new Arena({ viewers: ["alice", "bob", "cara", "dan", "eve", "fin"] });
  w.say("alice", "!challenge @bob", { quick: true });
  assert.equal(w.say("bob", "!fight", { quick: true }).reason, "quick_duel");
  w.say("cara", "!challenge @dan", { quick: true });
  assert.equal(w.say("dan", "!challenge @cara", { quick: true }).reason, "quick_duel", "a mutual challenge too");
  assert.equal(w.state.duels.filter((d) => d.status === "active").length, 0);
  // Plain chat still gets the HP fight.
  const hp = w.say("eve", "!challenge @fin");
  assert.equal(w.say("fin", "!accept").ok, true);
  assert.equal(w.duel(hp.duelId).status, "active");
});

// ---------- upgrades (server/upgrades.ts) ----------
const pts = (wins: number, bonus = 0) => u.pointsFor({ wins, bonus });

test("upgrade points: one per win, one per third loss, plus check-in points with no cap; a rank reset trims the last stats first", () => {
  assert.deepEqual([pts(0), pts(3), pts(20), pts(400)], [0, 3, 20, 400]);
  assert.deepEqual([pts(3, 2), pts(15, 9), pts(0, 25), pts(-1, 4), pts(2, 1.5)], [5, 24, 25, 4, 2]);
  assert.deepEqual(u.validStats({ power: 2, guard: 1 }, { wins: 3 }), fullStats({ power: 2, guard: 1 }));
  assert.equal(u.validStats({ power: 2, guard: 2 }, { wins: 3 }), null, "more points than wins");
  const fourth = u.validStats({ power: 2, guard: 2 }, { wins: 3, bonus: 1 });
  assert.deepEqual(fourth, fullStats({ power: 2, guard: 2 }), "a check-in point covers the fourth");
  assert.deepEqual(u.validStats({ power: 8 }, { wins: 8 }), fullStats({ power: 8 }));
  assert.equal(u.validStats({ power: 9 }, { wins: 9 }), null, "level 9 costs 2 points");
  assert.deepEqual(u.validStats({ power: 9 }, { wins: 10 }), fullStats({ power: 9 }));
  assert.equal(u.validStats({ power: 201 }, { wins: 1e12 }), null, "past the level limit");
  assert.equal(u.validStats({ power: 1.5 }, { wins: 10 }), null);
  const trims: [Partial<Stats>, u.Earned, Partial<Stats>, string][] = [
    [{ power: 1, dodge: 1, counter: 2 }, { wins: 2 }, { power: 1, dodge: 1 }, "counter comes off before dodge"],
    [{ power: 3, guard: 3, luck: 3 }, { wins: 5 }, { power: 3, guard: 2 }, "luck comes off before guard"],
    [{ power: 3, guard: 3, luck: 3 }, { wins: 0, bonus: 7 }, { power: 3, guard: 3, luck: 1 }, "check-ins survive"],
    [{ power: 10 }, { wins: 11 }, { power: 9 }, "trimming refunds level 10 at 2 points"],
  ];
  for (const [stats, earned, want, msg] of trims)
    assert.deepEqual(u.effectiveStats(stats, earned), fullStats(want), msg);
  const r = u.upgradeRules({ wins: 4, bonus: 3 }, 16);
  assert.deepEqual([r.points, r.fromWins, r.fromCheckins, r.maxLevel], [7, 4, 3, 16]);
  assert.equal(u.hatUnlocked("crown", 19), false);
  assert.equal(u.hatUnlocked("crown", 20), true);
  assert.equal(u.hatUnlocked("cap", 0), true);
  assert.equal(u.hatUnlocked("sombrero", 99), false);
  const withLosses = (losses: number) => u.pointsFor({ wins: 2, losses });
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(withLosses), [2, 2, 2, 3, 3, 3, 4, 4]);
  const lr = u.upgradeRules({ wins: 4, bonus: 3, losses: 7 }, 16);
  assert.deepEqual([lr.points, lr.fromWins, lr.fromCheckins, lr.fromLosses, lr.lossesPerPoint], [9, 4, 3, 2, 3]);
  assert.deepEqual(u.validStats({ power: 3 }, { wins: 0, losses: 9 }), fullStats({ power: 3 }));
  assert.equal(u.validStats({ power: 3 }, { wins: 0, losses: 8 }), null, "8 losses are 2 points");
});

test("level sync: the stronger build drops levels from its highest stat until it costs at most 10 points more", () => {
  const strong = fullStats({ power: 8, guard: 8, luck: 4 });
  assert.deepEqual(u.syncPair(strong, u.emptyStats()), [fullStats({ power: 4, guard: 3, luck: 3 }), u.emptyStats()]);
  const weakFirst = u.syncPair(fullStats({ luck: 2 }), strong);
  assert.deepEqual(weakFirst, [fullStats({ luck: 2 }), fullStats({ power: 4, guard: 4, luck: 4 })]);
  // Levels past 8 cost 2: 6 points against power 16 (24 points) leaves power 12 (16 points).
  assert.deepEqual(u.syncPair(fullStats({ power: 6 }), fullStats({ power: 16 }))[1], fullStats({ power: 12 }));
  const near = fullStats({ power: 6, guard: 4 });
  assert.deepEqual(u.syncPair(near, u.emptyStats()), [near, u.emptyStats()], "10 points apart stays as is");
  assert.deepEqual(strong, fullStats({ power: 8, guard: 8, luck: 4 }), "syncPair copies, never changes its input");
});

test("upgrade levels: cost doubles every 8 levels, the effect closes in on each stat's ceiling, a channel cap and pets apply", () => {
  assert.deepEqual([1, 8, 9, 16, 17, 24, 25].map(u.levelCost), [1, 1, 2, 2, 4, 4, 8]);
  assert.deepEqual([0, 5, 8, 9, 16, 24, 32].map(u.levelSpend), [0, 5, 8, 10, 24, 56, 120]);
  assert.equal(u.spentOn(fullStats({ power: 16, guard: 8, luck: 1 })), 33);
  const power = (level: number) => u.statValue("power", level);
  assert.deepEqual([0, 1, 8].map(power), [0, 0.04, 0.32], "levels 1 to 8 keep 4% each");
  const p9 = power(9);
  const p200 = power(200);
  assert.ok(p9 > 0.32 && p9 < 0.34, "level 9 adds about half a step: " + p9);
  assert.equal(Math.round(power(16) * 1000) / 10, 44.2);
  assert.equal(Math.round(power(10) * 1000) / 10, 35.7, "a pet taking power 8 to 10");
  assert.ok(p200 < 0.6 && p200 > 0.59, "power stays under its 60% ceiling: " + p200);
  assert.ok(u.statValue("luck", 200) < 0.5, "luck stays under 50%");
  assert.equal(u.scaledDamage(100, { power: 8 }, { guard: 8 }), 90, "1.32 * 0.68 of 100");
  // a channel's maxStatLevel caps what counts, and a pet's boost goes on top
  const capped = u.effectiveStats({ power: 20, guard: 2 }, { wins: 1000 }, null, 16);
  assert.deepEqual(capped, fullStats({ power: 16, guard: 2 }));
  const boosted = u.effectiveStats({ power: 20 }, { wins: 1000 }, { power: 2, luck: 1 }, 16);
  assert.deepEqual(boosted, fullStats({ power: 18, luck: 1 }), "the boost lands after the cap");
  assert.deepEqual(u.effectiveStats({ power: 20 }, { wins: 1000 }), fullStats({ power: 20 }), "no cap given");
});

test("upgrade presets spread the points by weight within the channel's level cap", () => {
  const preset = (id: string) => u.PRESETS.find((p) => p.id === id)!; // each id is in PRESETS
  assert.equal(u.PRESETS.length, 12);
  const ready = u.PRESETS.filter(u.presetReady).map((p) => p.id);
  const all =
    "balanced brawler lucky-striker iron-wall glass-cannon tank counter-puncher duelist gambler ghost bruiser sharpshooter";
  assert.equal(ready.join(" "), all, "every preset is ready once vitality exists");
  assert.deepEqual(u.presetStats(preset("glass-cannon"), 6), fullStats({ power: 3, crit: 2, luck: 1 }));
  assert.deepEqual(u.presetStats(preset("balanced"), 6), fullStats({ power: 2, guard: 2, luck: 2 }));
  assert.deepEqual(u.presetStats(preset("balanced"), 7), fullStats({ power: 3, guard: 2, luck: 2 }));
  assert.deepEqual(u.presetStats(preset("iron-wall"), 8), fullStats({ power: 2, guard: 6 }));
  assert.deepEqual(u.presetStats(preset("brawler"), 1000, 16), fullStats({ power: 16, guard: 16 }), "stops at the cap");
  assert.deepEqual(u.presetStats(preset("brawler"), 0), u.emptyStats());
  const built = u.presetStats(preset("balanced"), 100, 32);
  assert.ok(u.spentOn(built) <= 100 && u.validStats(built, { wins: 100 }) !== null);
});

/** An arena where each named fighter has saved these stats and 10 wins to pay for them. */
function upgraded(stats: Record<string, Partial<Stats>>, quick = true) {
  const w = new Arena({ quick });
  for (const [login, s] of Object.entries(stats)) {
    w.register(login, { stats: s });
    w.player(login).wins = 10;
  }
  return w;
}

test("quick duels: power adds 4% damage per point and guard takes 4% off per point", () => {
  const hit = [0.75, 0.5, 0.75, 0.5, 0.75, 0.5, 0.75];
  assert.deepEqual(pluck(quickWith(upgraded({ alice: { power: 5 } }), hit), "damage"), [41, 0, 41, 0, 18]);
  assert.deepEqual(pluck(quickWith(upgraded({ bob: { guard: 5 } }), hit), "damage"), [27, 0, 27, 0, 27, 0, 19]);
  // Points the wins no longer cover don't count: 5 power with 0 wins hits for the base 34.
  const w = new Arena({ quick: true });
  w.register("alice", { stats: { power: 5 } });
  assert.equal(must(quickWith(w, hit).swings[0]).damage, 34);
});

test("quick duels: level sync plays the stronger build at most 10 points above the weaker one, and saves nothing", () => {
  const w = upgraded({ alice: { power: 8, guard: 8, luck: 4 } });
  w.player("alice").wins = 20;
  // 20 points against 0: alice fights as power 4, guard 3, luck 3, so her hit is 34 x 1.16 and bob's is 34 x 0.88.
  assert.deepEqual(pluck(quickWith(w, [0.75, 0.75]), "damage").slice(0, 2), [39, 30]);
  assert.deepEqual(w.player("alice").stats, fullStats({ power: 8, guard: 8, luck: 4 }), "the saved build is untouched");
  // Within 10 points nothing changes: 5 power against 0 still hits for 41.
  assert.equal(must(quickWith(upgraded({ alice: { power: 5 } }), [0.75]).swings[0]).damage, 41);
});

// Each check reads its own slot of 24 rolls: die 0, luck 24, crit 48, dodge 72, counter 96 (plus the swing index).
const slots = (set: Record<number, number>) => Object.assign(Array<number>(120).fill(0.9), set);

test("quick duels: luck, crit and dodge work at 4% per level and counter at 2%, each from its own roll slot", () => {
  const cases: [Record<string, Partial<Stats>>, Record<number, number>, Want<Swing>][] = [
    // luck turns alice's 4 (a miss) into a hit when its roll is under 5 x 4%
    [{ alice: { luck: 5 } }, { 0: 0.5, 24: 0.1 }, { outcome: "hit", lucky: true, damage: 34 }],
    [{ alice: { luck: 5 } }, { 0: 0.5, 24: 0.25 }, { outcome: "miss", lucky: undefined }],
    // crit turns alice's 5 (a hit) into a crit
    [{ alice: { crit: 5 } }, { 0: 0.75, 48: 0.1 }, { outcome: "crit", luckyCrit: true, damage: 50 }],
    [{ alice: { crit: 5 } }, { 0: 0.75, 48: 0.25 }, { outcome: "hit", luckyCrit: undefined, damage: 34 }],
    // luck then crit turn a miss into a crit
    [
      { alice: { luck: 5, crit: 5 } },
      { 0: 0.5, 24: 0.1, 48: 0.1 },
      { outcome: "crit", lucky: true, luckyCrit: true, damage: 50 },
    ],
    // dodge turns a hit or a crit (0.9 rolls a 6) on bob into a miss
    [{ bob: { dodge: 5 } }, { 0: 0.75, 72: 0.1 }, { outcome: "miss", dodged: true, damage: 0 }],
    [{ bob: { dodge: 5 } }, { 72: 0.1 }, { outcome: "miss", dodged: true }],
    [{ bob: { dodge: 5 } }, { 0: 0.75, 72: 0.25 }, { outcome: "hit", dodged: undefined, damage: 34 }],
    // counter adds 2% per level to bob's counter on alice's 1, and turns her miss into a counter at 2% per level
    [{ bob: { counter: 5 } }, { 0: 0.1 }, { damage: 37 }],
    [{}, { 0: 0.1 }, { damage: 34 }],
    [{ bob: { counter: 5 } }, { 0: 0.5, 96: 0.05 }, { outcome: "counter", attackerId: "id-alice", damage: 37 }],
    [{ bob: { counter: 5 } }, { 0: 0.5, 96: 0.15 }, { outcome: "miss" }],
    // a dodged hit can then become bob's counter
    [
      { bob: { dodge: 5, counter: 5 } },
      { 0: 0.75, 72: 0.1, 96: 0.05 },
      { outcome: "counter", dodged: true, damage: 37 },
    ],
  ];
  for (const [stats, set, want] of cases)
    like(quickWith(upgraded(stats), slots(set)).swings[0], want, JSON.stringify([stats, set]));
  // the new stats stay pure: the same rolls give the same swings
  const rolls = Array.from({ length: 120 }, (_, i) => ((i * 37) % 100) / 100);
  const run = () => quickWith(upgraded({ alice: { crit: 4, luck: 2 }, bob: { dodge: 3, counter: 3 } }), rolls).swings;
  assert.deepEqual(run(), run());
});

test("HP fights: crit makes a strike or heavy deal 50% more, from the command's first roll", () => {
  const w = upgraded({ alice: { crit: 5 } }, false);
  w.fight("alice", "bob");
  const lastHit = () => w.state.events.findLast((e) => e.type === "duel_action");
  assert.equal(w.say("alice", "!strike", { rolls: [0.1] }).amount, 30);
  assert.equal(lastHit()?.crit, true);
  w.now += 2000;
  assert.equal(w.say("alice", "!strike", { rolls: [0.5] }).amount, 20);
  assert.equal(lastHit()?.crit, undefined);
});

test("upgrades and hat come from the saved profile; no respec while a challenge is open", () => {
  const w = upgraded({ alice: { power: 2 } });
  assert.deepEqual(w.player("alice").stats, fullStats({ power: 2 }));
  // A chat command carrying the stored profile keeps them; partial stats on purpose: the reducer fills the rest.
  const stats = { power: 4 } as Stats;
  const profile = { userId: "id-alice", username: "alice", registered: true, wins: 10, stats, hat: "crown" };
  w.say("alice", "hi", { profile });
  like(w.player("alice"), { hat: "crown" });
  assert.equal(w.player("alice").stats.power, 4);
  w.say("alice", "!challenge @bob");
  assert.equal(w.register("alice", { stats: { guard: 4 } }).reason, "in_duel");
  assert.equal(w.register("alice", { stats: { power: 4 }, hat: "cap" }).ok, true, "same build, new hat is fine");
});

/** A finished quick duel between a and b, with the clock moved past the rematch wait. */
function settle(w: Arena, a = "alice", b = "bob") {
  const d = w.duel(w.fight(a, b));
  w.advance(120_000);
  return d;
}

/** A quick-duel arena where a pair gets 5 ranked duels per stream. */
function pairCapped() {
  const w = new Arena({ quick: true });
  w.state.config.pairRankedPerStream = 5;
  return w;
}

test("pairs have no ranked limit by default (pairRankedPerStream 0)", () => {
  const w = new Arena({ quick: true });
  w.stream = { id: "s1", startedAt: T0 };
  assert.equal(w.state.config.pairRankedPerStream, 0);
  for (let i = 0; i < 7; i += 1) {
    const d = settle(w);
    assert.deepEqual([d.unrated, d.lastRanked], [undefined, undefined], `duel ${i + 1} is ranked`);
  }
  assert.equal(w.state.pairPlays.length, 0, "nothing to count");
  assert.equal(pairRankedLeft(w.state, "id-alice", "id-bob"), null);
});

test("with a limit of 5 a pair gets 5 ranked duels per stream; later ones are unrated, pay half, and count again next stream", () => {
  const w = pairCapped();
  w.stream = { id: "s1", startedAt: T0 };
  const paid = (d: Duel, win: number, loss: number) => ({
    [must(d.winnerId)]: win,
    [d.winnerId === "id-alice" ? "id-bob" : "id-alice"]: loss,
  });
  for (let i = 0; i < 4; i += 1) {
    const d = settle(w);
    assert.deepEqual([d.unrated, d.lastRanked], [undefined, undefined], `duel ${i + 1} is ranked`);
    assert.deepEqual(d.payout, paid(d, 5, 3));
  }
  assert.equal(pairRankedLeft(w.state, "id-bob", "id-alice"), 1);
  const fifth = settle(w);
  assert.deepEqual([fifth.unrated, fifth.lastRanked], [undefined, true], "the fifth is the last ranked one");
  const before = ["alice", "bob"].map((login) => ({ ...w.player(login) }));
  const sixth = settle(w);
  assert.equal(sixth.unrated, "pair_cap");
  assert.deepEqual(sixth.payout, paid(sixth, 2, 1), "half of $5 and $3, rounded down");
  for (const was of before)
    like(w.player(was.username), { elo: was.elo, wins: was.wins, losses: was.losses }, was.username);
  assert.equal(must(w.state.events.findLast((e) => e.type === "duel_completed")).unrated, "pair_cap");
  assert.equal(w.state.pairPlays.length, 5, "unrated duels are not counted");
  assert.equal(pairRankedLeft(w.state, "id-alice", "id-bob"), 0);
  const reset = reduceGame(structuredClone(w.state), { type: "admin", actorId: "mod", action: "resetAllRanks" }, w.now);
  assert.equal(reset.state.pairPlays.length, 0, "reset all ranks starts the pair counts over");
  w.register("cara");
  assert.equal(settle(w, "alice", "cara").unrated, undefined, "other pairs are still ranked");
  w.tick(86_400_000);
  assert.equal(w.state.pairPlays.length, 6, "a day passing doesn't reset the count");
  w.register("alice");
  w.register("bob");
  assert.equal(settle(w).unrated, "pair_cap", "still the same stream");
  w.stream = { id: "s2", startedAt: w.now };
  assert.equal(settle(w).unrated, undefined, "ranked again next stream");
  const streams = w.state.pairPlays.map((p) => p.stream);
  assert.deepEqual(streams, ["s2"], "the old stream's plays are dropped");
});

test("offline duels are unrated and pay nothing; a failed live check keeps the last answer", () => {
  const w = pairCapped();
  w.stream = null;
  const d = settle(w);
  assert.equal(d.unrated, "offline");
  assert.equal(d.payout, undefined, "no dollars offline");
  assert.deepEqual([w.player("alice").wins + w.player("bob").wins, w.state.pairPlays.length], [0, 0]);
  w.stream = undefined; // the room sends no stream when Twitch didn't answer
  assert.equal(w.duel(w.fight("alice", "cara")).unrated, "offline", "still offline as last seen");
});

test("before any live answer duels are ranked; plays from before stream ids count toward the stream they fall in", () => {
  const w = pairCapped();
  assert.equal(settle(w).unrated, undefined, "never checked counts as live");
  w.state.pairPlays = [
    { pair: "id-alice:id-bob", at: T0 - 60_000 },
    { pair: "id-alice:id-bob", at: T0 + 1_000 },
    { pair: "id-alice:id-bob", at: T0 + 2_000 },
  ];
  w.stream = { id: "s1", startedAt: T0 };
  w.say("cara", "!challenge @dan");
  assert.equal(pairRankedLeft(w.state, "id-alice", "id-bob"), 3, "two plays since the stream started count");
  assert.equal(w.state.pairPlays.length, 2, "the play from before the stream is dropped");
});

test("mods reset one pair's ranked count", () => {
  const w = pairCapped();
  w.state.pairPlays = [
    { pair: "id-alice:id-bob", at: T0, stream: "" },
    { pair: "id-alice:id-bob", at: T0, stream: "" },
    { pair: "id-alice:id-cara", at: T0, stream: "" },
  ];
  assert.deepEqual(w.admin("resetPair", { a: "id-bob", b: "id-alice" }), { ok: true, reason: "pair_reset", amount: 2 });
  const left = w.state.pairPlays.map((p) => p.pair);
  assert.deepEqual(left, ["id-alice:id-cara"]);
  assert.equal(w.admin("resetPair", { a: "id-bob", b: "id-bob" }).reason, "invalid_pair");
  assert.equal(w.admin("resetPair", { a: "id-bob" }).reason, "invalid_pair");
});

test("duels with an account younger than 7 days are unrated", () => {
  const w = new Arena({ quick: true });
  w.say("alice", "!challenge @bob");
  w.say("bob", "!accept", { newAccounts: ["id-bob"] });
  like(w.state.duels.at(-1), { status: "completed", unrated: "new_account", payout: undefined });
  like(w.player("alice"), { elo: 1000, wins: 0, losses: 0 });
  const hidden = hiddenResults(w.state, w.now);
  assert.deepEqual(hidden.get("id-alice"), { elo: 1000, wins: 0, losses: 0, dollars: 0 }, "nothing hidden to undo");
});

test("vitality: +4 max HP per level, set when the duel starts; heal stops at the fighter's own max, a health reset refills to it", () => {
  const w = upgraded({ alice: { vitality: 5 } }, false);
  const id = w.fight("alice", "bob");
  const full = { "id-alice": 120, "id-bob": 100 };
  like(w.duel(id), { maxHp: full, hp: full });
  assert.equal(w.player("alice").hp, 120);
  const started = w.state.events.findLast((e) => e.type === "duel_started");
  like(started, { maxHp: full, hp: full }, "sent with duel_started");
  assert.equal(w.say("bob", "!strike").amount, 20);
  assert.equal(w.duel(id).hp["id-alice"], 100);
  assert.equal(w.say("alice", "!heal").amount, 15, "a heal above the channel's 100 still counts");
  assert.equal(w.duel(id).hp["id-alice"], 115);
  w.now += 20_000;
  assert.equal(w.say("alice", "!heal").amount, 5, "capped at 120");
  assert.equal(w.duel(id).hp["id-alice"], 120);
  w.now += 1000;
  w.say("bob", "!strike");
  assert.equal(w.duel(id).hp["id-alice"], 100);
  assert.equal(w.admin("resetHealth").ok, true);
  assert.deepEqual(w.duel(id).hp, full);
  assert.equal(w.player("alice").hp, 120);
});

test("vitality: a quick-duel winner at their own full HP is flawless; base blows stay the same size", () => {
  const r = quickWith(upgraded({ alice: { vitality: 5 } }), [0.9, 0.5, 0.9]);
  assert.deepEqual(pluck(r, "damage"), [50, 0, 50]);
  like(r, { winnerHp: 120, flawless: true });
  // bob with 120 HP survives two crits and loses the flawless to one hit
  const tough = quickWith(upgraded({ bob: { vitality: 5 } }), [0.9, 0.75, 0.9, 0.5, 0.9]);
  like(tough, { winnerId: "id-alice", winnerHp: 66, flawless: false });
});
