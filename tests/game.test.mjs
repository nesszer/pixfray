import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceGame, createInitialState, parseGameCommand, defaultConfig } from '../server/game.js';

const T0 = 1_800_000_000_000;
let seq = 0;

// Small harness: keeps state and clock, applies events through the pure reducer.
// HP-fight tests turn quick duels off; quick-duel tests pass { quick: true }.
function arena({ chat = true, viewers = ['alice', 'bob', 'cara', 'dan'], quick = false } = {}) {
  const w = { state: createInitialState('nesszerra'), now: T0, last: null };
  w.state.config.quickDuel = quick;
  w.apply = (event) => { const r = reduceGame(w.state, event, w.now); w.state = r.state; w.last = r; return r.result; };
  w.tick = (ms) => { w.now += ms; return w.apply({ type: 'tick' }); };
  // Advance the clock in 10 s ticks (alarms fire at least that often while duels are open).
  w.advance = (ms) => { const end = w.now + ms; while (w.now < end) { w.now = Math.min(end, w.now + 10_000); w.apply({ type: 'tick' }); } };
  w.say = (login, text) => w.apply({ type: 'command', messageId: 'm' + (++seq), userId: 'id-' + login, username: login, displayName: login, text, timestamp: w.now });
  w.register = (login, extra = {}) => w.apply({ type: 'profile_saved', profile: { userId: 'id-' + login, username: login, displayName: login, avatar: 'player', color: '#112233', defaultAbility: 'strike', ...extra } });
  w.player = (login) => w.state.players.find((p) => p.username === login);
  w.duel = (id) => w.state.duels.find((d) => d.id === id);
  w.fight = (a, b) => { const c = w.say(a, '!challenge @' + b); assert.equal(c.ok, true, c.reason); const r = w.say(b, '!accept'); assert.equal(r.ok, true, r.reason); return c.duelId; };
  if (chat) w.apply({ type: 'chat_subscription', subscriptionId: 'sub-1', status: 'enabled', createdAt: T0 });
  for (const v of viewers) w.register(v);
  return w;
}

test('balance preset matches the approved defaults', () => {
  const c = defaultConfig();
  assert.equal(c.maxHp, 100);
  assert.deepEqual(c.abilities, { strike: { damage: 20, cooldownMs: 2000 }, heavy: { damage: 35, cooldownMs: 5000 }, heal: { amount: 15, cooldownMs: 12000 } });
  assert.equal(c.sharedCooldownMs, 1000);
  assert.equal(c.maxDuels, 5);
  assert.equal(c.challengeTimeoutMs, 30000);
  assert.equal(c.inactivityMs, 45000);
  assert.equal(c.rematchDelayMs, 30000);
  assert.equal(c.initialElo, 1000);
  assert.equal(c.eloK, 24);
});

test('command parser accepts the spec commands and rejects junk', () => {
  assert.deepEqual(parseGameCommand('!challenge @Bob'), { action: 'duel', target: 'bob' });
  assert.deepEqual(parseGameCommand('!duel bob'), { action: 'duel', target: 'bob' });
  assert.equal(parseGameCommand('!challenge'), null);
  assert.deepEqual(parseGameCommand('!accept'), { action: 'accept', target: '' });
  assert.deepEqual(parseGameCommand('!accept @alice'), { action: 'accept', target: 'alice' });
  assert.deepEqual(parseGameCommand('!decline'), { action: 'decline', target: '' });
  assert.deepEqual(parseGameCommand('!attack @bob'), { action: 'attack', target: 'bob' });
  for (const a of ['strike', 'heavy', 'heal']) assert.deepEqual(parseGameCommand('!' + a), { action: a, target: '' });
  assert.deepEqual(parseGameCommand('!HEAVY @Bob'), { action: 'heavy', target: 'bob' });
  assert.equal(parseGameCommand('hello !strike'), null);
  assert.equal(parseGameCommand('!strike @bob extra'), null);
  assert.equal(parseGameCommand('!nuke'), null);
  assert.equal(parseGameCommand(42), null);
});

test('duels are opt-in: a challenge stays pending until the target accepts', () => {
  const w = arena();
  const c = w.say('alice', '!challenge @bob');
  assert.equal(c.ok, true);
  assert.equal(w.duel(c.duelId).status, 'pending');
  assert.equal(w.say('alice', '!strike').reason, 'not_in_active_duel');
  assert.equal(w.say('cara', '!accept').reason, 'challenge_not_found');
  assert.equal(w.say('alice', '!accept').reason, 'challenge_not_found', 'challenger cannot accept their own challenge');
  assert.equal(w.say('bob', '!accept').ok, true);
  assert.equal(w.duel(c.duelId).status, 'active');
});

test('the target can decline a challenge', () => {
  const w = arena();
  const c = w.say('alice', '!challenge @bob');
  assert.equal(w.say('bob', '!decline').reason, 'challenge_declined');
  assert.equal(w.duel(c.duelId).status, 'declined');
  assert.equal(w.say('alice', '!challenge @bob').ok, true, 'declining frees both viewers');
});

test('challenges expire after 30 s', () => {
  const w = arena();
  const c = w.say('alice', '!challenge @bob');
  w.now += 29_999; w.tick(0);
  assert.equal(w.duel(c.duelId).status, 'pending');
  w.now += 1; w.tick(0);
  assert.equal(w.duel(c.duelId).status, 'expired');
  assert.equal(w.say('bob', '!accept').reason, 'challenge_not_found');
  assert.ok(w.state.events.some((e) => e.type === 'challenge_expired'));
});

test('self-challenges and unknown targets are rejected', () => {
  const w = arena();
  assert.equal(w.say('alice', '!challenge @alice').reason, 'self_duel');
  assert.equal(w.say('alice', '!challenge @nobody').reason, 'target_not_found');
});

test('strike, heavy and heal by command apply the preset amounts', () => {
  const w = arena();
  const id = w.fight('alice', 'bob');
  assert.equal(w.say('alice', '!strike').amount, 20);
  assert.equal(w.duel(id).hp['id-bob'], 80);
  w.now += 1000;
  assert.equal(w.say('alice', '!heavy').amount, 35);
  assert.equal(w.duel(id).hp['id-bob'], 45);
  const heal = w.say('bob', '!heal');
  assert.equal(heal.ability, 'heal');
  assert.equal(heal.amount, 15);
  assert.equal(w.duel(id).hp['id-bob'], 60);
  assert.equal(w.player('bob').hp, 60, 'player hp mirrors duel hp');
});

test('heal never exceeds max HP', () => {
  const w = arena();
  const id = w.fight('alice', 'bob');
  assert.equal(w.say('bob', '!heal').amount, 0, 'healing at full HP adds nothing');
  assert.equal(w.duel(id).hp['id-bob'], 100);
});

test('!attack uses the default ability chosen on the website', () => {
  const w = arena();
  w.register('alice', { defaultAbility: 'heavy' });
  w.fight('alice', 'bob');
  const r = w.say('alice', '!attack @bob');
  assert.equal(r.ability, 'heavy');
  assert.equal(r.amount, 35);
  w.register('bob', { defaultAbility: 'heal' });
  assert.equal(w.say('bob', '!attack').ability, 'heal');
});

test('targeting the wrong opponent is rejected', () => {
  const w = arena();
  w.fight('alice', 'bob');
  assert.equal(w.say('alice', '!strike @cara').reason, 'wrong_opponent');
  assert.equal(w.say('alice', '!strike @bob').ok, true);
});

test('per-ability cooldowns run in real time, plus a 1 s shared delay', () => {
  const w = arena();
  w.fight('alice', 'bob');
  assert.equal(w.say('alice', '!strike').ok, true);
  let r = w.say('alice', '!heavy');
  assert.equal(r.reason, 'cooldown');
  assert.equal(r.retryAt, w.now + 1000, 'shared delay blocks every ability for 1 s');
  w.now += 999;
  assert.equal(w.say('alice', '!heavy').reason, 'cooldown');
  w.now += 1;
  assert.equal(w.say('alice', '!heavy').ok, true, 'other abilities are free after the shared delay');
  // strike was used at T0; its own 2 s cooldown ends at T0+2000.
  w.now = T0 + 1999;
  r = w.say('alice', '!strike');
  assert.equal(r.reason, 'cooldown');
  assert.equal(r.retryAt, T0 + 2000);
  w.now = T0 + 2000;
  assert.equal(w.say('alice', '!strike').ok, true);
  // heavy used at T0+1000 -> available at T0+6000.
  w.now = T0 + 5999;
  assert.equal(w.say('alice', '!heavy').reason, 'cooldown');
  w.now = T0 + 6000;
  assert.equal(w.say('alice', '!heavy').ok, true);
});

test('heal has a 12 s cooldown and cooldowns are per fighter', () => {
  const w = arena();
  w.fight('alice', 'bob');
  w.say('alice', '!strike');
  assert.equal(w.say('bob', '!heal').ok, true, 'alice using an ability does not block bob');
  w.now += 11_999;
  assert.equal(w.say('bob', '!heal').reason, 'cooldown');
  w.now += 1;
  assert.equal(w.say('bob', '!heal').ok, true);
});

test('at most 5 simultaneous duels per channel (pending challenges count)', () => {
  const names = Array.from({ length: 12 }, (_, i) => 'v' + i);
  const w = arena({ viewers: names });
  for (let i = 0; i < 4; i++) w.fight(names[i * 2], names[i * 2 + 1]);
  assert.equal(w.say('v8', '!challenge @v9').ok, true, 'fifth slot used by a pending challenge');
  assert.equal(w.say('v10', '!challenge @v11').reason, 'channel_full');
});

test('a viewer can be in only one duel at a time', () => {
  const w = arena();
  w.fight('alice', 'bob');
  assert.equal(w.say('cara', '!challenge @alice').reason, 'player_busy');
  assert.equal(w.say('alice', '!challenge @cara').reason, 'player_busy');
  w.say('cara', '!challenge @dan');
  assert.equal(w.say('alice', '!challenge @dan').reason, 'player_busy', 'pending challenges also count');
});

test('each accepted duel counts as one round', () => {
  const w = arena();
  const first = w.fight('alice', 'bob');
  const second = w.fight('cara', 'dan');
  assert.equal(w.duel(first).round, 1);
  assert.equal(w.duel(second).round, 2);
  assert.equal(w.state.round, 2);
  w.say('alice', '!challenge @cara');
  assert.equal(w.state.round, 2, 'pending challenges are not rounds');
  w.apply({ type: 'admin', actorId: 'mod', action: 'resetRound' });
  assert.equal(w.state.round, 0);
});

function knockOut(w, attacker) {
  for (let i = 0; i < 10; i++) {
    const r = w.say(attacker, '!strike');
    if (r.reason === 'duel_completed') return r;
    assert.equal(r.ok, true, r.reason);
    w.advance(3000);
  }
  throw new Error('no KO');
}

test('KO completes the duel; the loser respawns at full health after respawnMs', () => {
  const w = arena();
  const id = w.fight('alice', 'bob');
  const r = knockOut(w, 'alice');
  assert.equal(r.winnerId, 'id-alice');
  const duel = w.duel(id);
  assert.equal(duel.status, 'completed');
  assert.equal(duel.hp['id-bob'], 0);
  assert.equal(w.player('bob').hp, 0);
  assert.ok(w.player('bob').respawnAt > w.now);
  assert.equal(w.player('alice').hp, 100);
  assert.equal(w.say('bob', '!challenge @cara').reason, 'respawning');
  w.tick(defaultConfig().respawnMs);
  assert.equal(w.player('bob').hp, 100);
  assert.equal(w.player('bob').respawnAt, 0);
  assert.equal(w.say('bob', '!challenge @cara').ok, true);
});

test('a chat message from a knocked-out viewer does not skip their respawn', () => {
  const w = arena();
  w.fight('alice', 'bob');
  knockOut(w, 'alice');
  // The channel passes the stored profile (hp=max, respawnAt=0) with every chat message.
  w.apply({ type: 'presence', userId: 'id-bob', username: 'bob', profile: { userId: 'id-bob', username: 'bob', registered: true, hp: 100, respawnAt: 0, elo: 988 } });
  assert.equal(w.player('bob').hp, 0);
  assert.ok(w.player('bob').respawnAt > w.now);
});

test('completed duels update wins, losses and Elo (start 1000, K=24)', () => {
  const w = arena();
  const id = w.fight('alice', 'bob');
  knockOut(w, 'alice');
  assert.equal(w.player('alice').elo, 1012);
  assert.equal(w.player('bob').elo, 988);
  assert.equal(w.player('alice').wins, 1);
  assert.equal(w.player('bob').losses, 1);
  assert.deepEqual(w.duel(id).ratings['id-alice'], { before: 1000, after: 1012, delta: 12 });
  assert.deepEqual(w.last.dirtyProfileIds.length, 0, 'channel persists participants on duel_completed');
  // Upset: lower-rated bob beats alice and gains more than 12.
  w.advance(30_000);
  const id2 = w.fight('bob', 'alice');
  knockOut(w, 'bob');
  const exp = 1 / (1 + 10 ** ((1012 - 988) / 400));
  assert.equal(w.duel(id2).ratings['id-bob'].after, Math.round(988 + 24 * (1 - exp)));
  assert.ok(w.duel(id2).ratings['id-bob'].delta > 12);
});

test('rematches between the same pair wait 30 s', () => {
  const w = arena();
  w.fight('alice', 'bob');
  knockOut(w, 'alice');
  const doneAt = w.now;
  w.advance(5000);
  const r = w.say('alice', '!challenge @bob');
  assert.equal(r.reason, 'rematch_cooldown');
  assert.equal(r.retryAt, doneAt + 30_000);
  assert.equal(w.say('alice', '!challenge @cara').ok, true, 'other opponents are allowed');
  w.say('cara', '!decline');
  w.advance(doneAt + 30_000 - w.now);
  assert.equal(w.say('bob', '!challenge @alice').ok, true);
});

test('45 s of inactivity cancels a duel without scoring', () => {
  const w = arena();
  const id = w.fight('alice', 'bob');
  w.say('alice', '!heavy');
  w.advance(44_999);
  assert.equal(w.duel(id).status, 'active');
  w.advance(1);
  const duel = w.duel(id);
  assert.equal(duel.status, 'cancelled');
  assert.equal(duel.cancelReason, 'inactivity');
  assert.equal(duel.winnerId, null);
  for (const n of ['alice', 'bob']) {
    assert.equal(w.player(n).elo, 1000);
    assert.equal(w.player(n).wins + w.player(n).losses, 0);
    assert.equal(w.player(n).hp, 100);
    assert.equal(w.player(n).respawnAt, 0);
  }
  assert.equal(w.say('alice', '!challenge @bob').ok, true, 'no rematch lock after a cancelled duel');
});

test('each action resets the inactivity timer', () => {
  const w = arena();
  const id = w.fight('alice', 'bob');
  w.advance(40_000); w.say('alice', '!strike');
  w.advance(40_000);
  assert.equal(w.duel(id).status, 'active');
});

test('ranked duels require a signed-in profile', () => {
  const w = arena({ viewers: ['alice'] });
  // guest chats but never signed in on the website
  w.apply({ type: 'presence', userId: 'id-guest', username: 'guest' });
  assert.equal(w.say('guest', '!challenge @alice').reason, 'ranked_sign_in_required');
  assert.equal(w.say('alice', '!challenge @guest').reason, 'ranked_sign_in_required');
  // a chat message cannot forge registration: only profile_saved / stored profiles set it
  w.apply({ type: 'presence', userId: 'id-guest', username: 'guest', profile: { userId: 'id-guest', username: 'guest' } });
  assert.equal(w.player('guest').registered, false);
});

test('chat disconnect pauses combat and cancels unfinished duels unscored', () => {
  const w = arena();
  const active = w.fight('alice', 'bob');
  w.say('alice', '!heavy');
  const pending = w.say('cara', '!challenge @dan').duelId;
  assert.equal(w.apply({ type: 'chat_disconnected', reason: 'disconnected' }).reason, 'chat_disconnected');
  assert.equal(w.duel(active).status, 'cancelled');
  assert.equal(w.duel(active).cancelReason, 'chat_disconnected');
  assert.equal(w.duel(pending).status, 'cancelled');
  assert.equal(w.player('alice').elo, 1000);
  assert.equal(w.player('bob').hp, 100);
  assert.deepEqual([w.state.chat.connected, w.state.chat.status, w.state.chat.subscriptionId], [false, 'disconnected', '']);
  assert.equal(w.state.events.at(-1).type, 'chat_disconnected');
  assert.equal(w.say('alice', '!challenge @bob').reason, 'chat_offline', 'commands are rejected while paused');
  w.apply({ type: 'chat_subscription', subscriptionId: 'sub-2', status: 'webhook_callback_verification_pending', createdAt: w.now });
  assert.equal(w.say('alice', '!challenge @bob').reason, 'chat_offline', 'paused until Twitch verifies the webhook');
  assert.equal(w.apply({ type: 'chat_verified', subscriptionId: 'sub-2' }).reason, 'chat_connected');
  assert.equal(w.state.events.at(-1).type, 'chat_connected');
  assert.equal(w.say('alice', '!challenge @bob').ok, true);
});

test('quiet chat never pauses combat (no heartbeat lease)', () => {
  const w = arena();
  w.tick(6 * 3_600_000);
  assert.equal(w.state.chat.connected, true);
  w.register('alice'); w.register('bob');   // idle viewers left the arena meanwhile
  assert.equal(w.say('alice', '!challenge @bob').ok, true);
});

test('webhook verification may arrive before the subscription is recorded', () => {
  const w = arena({ chat: false });
  assert.equal(w.apply({ type: 'chat_verified', subscriptionId: 'sub-9' }).reason, 'chat_verified_early');
  assert.equal(w.state.chat.connected, false);
  assert.equal(w.apply({ type: 'chat_subscription', subscriptionId: 'sub-9', status: 'webhook_callback_verification_pending', createdAt: w.now }).reason, 'chat_connected');
  assert.deepEqual([w.state.chat.connected, w.state.chat.status, w.state.chat.verifiedId], [true, 'enabled', '']);
  // a verification for some other subscription never connects the current one
  const v = arena({ chat: false });
  v.apply({ type: 'chat_subscription', subscriptionId: 'sub-1', status: 'webhook_callback_verification_pending' });
  v.apply({ type: 'chat_verified', subscriptionId: 'sub-other' });
  assert.equal(v.state.chat.connected, false);
});

test('a revocation records the reason and keeps duels paused', () => {
  const w = arena();
  const id = w.fight('alice', 'bob');
  w.apply({ type: 'chat_disconnected', reason: 'authorization_revoked' });
  assert.equal(w.duel(id).cancelReason, 'chat_disconnected');
  assert.deepEqual([w.state.chat.connected, w.state.chat.status, w.state.chat.revokedReason], [false, 'authorization_revoked', 'authorization_revoked']);
  assert.equal(w.state.events.at(-1).reason, 'authorization_revoked');
});

test('rejected chat commands can be logged to the event list', () => {
  const w = arena();
  const r = w.apply({ type: 'command_rejected', userId: 'id-alice', command: 'strike', reason: 'not_in_active_duel' });
  assert.equal(r.ok, true);
  assert.deepEqual(w.state.events.at(-1), { id: String(w.state.revision), type: 'command_rejected', at: w.now, userId: 'id-alice', command: 'strike', reason: 'not_in_active_duel' });
});

test('stored relay state and relayLeaseMs are dropped; old configs still roll back', () => {
  const legacy = { ...createInitialState('nesszerra'), relay: { connected: true, lastSeen: T0 }, config: { ...defaultConfig(), relayLeaseMs: 30000 } };
  const r = reduceGame(legacy, { type: 'tick' }, T0);
  assert.equal(r.state.relay, undefined);
  assert.equal(r.state.config.relayLeaseMs, undefined);
  assert.equal(r.state.chat.connected, false);
  const rolled = reduceGame(r.state, { type: 'admin', actorId: 'mod', action: 'config', payload: { patch: { ...defaultConfig(), relayLeaseMs: 30000, maxHp: 120 } } }, T0);
  assert.equal(rolled.result.ok, true, rolled.result.reason);
  assert.equal(rolled.state.config.maxHp, 120);
  assert.equal(rolled.state.config.relayLeaseMs, undefined);
});

test('duplicate and stale chat commands are ignored', () => {
  const w = arena();
  w.say('alice', '!challenge @bob');
  const msg = { type: 'command', messageId: 'dup-1', userId: 'id-bob', username: 'bob', text: '!accept', timestamp: w.now };
  assert.equal(w.apply(msg).ok, true);
  assert.equal(w.apply(msg).reason, 'duplicate');
  assert.equal(w.apply({ ...msg, messageId: 'old', timestamp: w.now - 61_000 }).reason, 'stale_command');
});

test('mods can cancel duels (unscored) and disabling duels cancels all of them', () => {
  const w = arena();
  const id = w.fight('alice', 'bob');
  const id2 = w.fight('cara', 'dan');
  assert.equal(w.apply({ type: 'admin', actorId: 'mod', action: 'cancelDuel', payload: { duelId: id } }).ok, true);
  assert.equal(w.duel(id).cancelReason, 'moderator_cancelled');
  const r = w.apply({ type: 'admin', actorId: 'mod', action: 'config', payload: { patch: { enabled: false } } });
  assert.equal(r.ok, true);
  assert.equal(w.duel(id2).cancelReason, 'duels_disabled');
  assert.equal(w.say('alice', '!challenge @bob').reason, 'duels_disabled');
});

test('config edits are validated, versioned, and only affect new duels', () => {
  const w = arena();
  const id = w.fight('alice', 'bob');
  assert.equal(w.state.configVersion, 1);
  assert.equal(w.apply({ type: 'admin', actorId: 'mod', action: 'config', payload: { patch: { maxDuels: 9 } } }).reason, 'invalid_config_maxDuels');
  assert.equal(w.apply({ type: 'admin', actorId: 'mod', action: 'config', payload: { patch: { bogus: 1 } } }).reason, 'unknown_config_field');
  assert.equal(w.apply({ type: 'admin', actorId: 'mod', action: 'config', payload: { patch: { abilities: { strike: { amount: 5 } } } } }).reason, 'invalid_config_ability_field');
  const ok = w.apply({ type: 'admin', actorId: 'mod', action: 'config', payload: { baseVersion: 1, patch: { abilities: { strike: { damage: 40 } } } } });
  assert.equal(ok.ok, true);
  assert.equal(ok.configVersion, 2);
  assert.equal(w.state.config.abilities.strike.damage, 40);
  assert.equal(w.state.config.abilities.strike.cooldownMs, 2000, 'partial ability patch keeps other fields');
  assert.equal(w.apply({ type: 'admin', actorId: 'mod', action: 'config', payload: { baseVersion: 1, patch: { maxHp: 120 } } }).reason, 'config_version_conflict');
  assert.equal(w.say('alice', '!strike').amount, 20, 'running duel keeps the rules it started with');
  w.apply({ type: 'admin', actorId: 'mod', action: 'cancelDuel', payload: { duelId: id } });
  w.fight('alice', 'bob');
  assert.equal(w.say('alice', '!strike').amount, 40);
});

test('rank resets reach offline profiles and report ids to persist', () => {
  const w = arena();
  w.fight('alice', 'bob');
  knockOut(w, 'alice');
  const r = w.apply({ type: 'admin', actorId: 'mod', action: 'resetRank', payload: { userId: 'id-alice' } });
  assert.equal(r.ok, true);
  assert.deepEqual(w.last.rankResetIds, ['id-alice']);
  assert.equal(w.player('alice').elo, 1000);
  const off = w.apply({ type: 'admin', actorId: 'mod', action: 'resetRank', payload: { userId: 'id-zed' }, targetProfile: { userId: 'id-zed', registered: true } });
  assert.equal(off.ok, true);
  assert.equal(w.apply({ type: 'admin', actorId: 'mod', action: 'resetRank', payload: { userId: 'id-none' } }).reason, 'profile_not_found');
  const rm = w.apply({ type: 'admin', actorId: 'mod', action: 'removePlayer', payload: { userId: 'id-bob' } });
  assert.equal(rm.ok, true);
  assert.deepEqual(w.last.deletedProfileIds, ['id-bob']);
});

test('admin events without an actor are refused', () => {
  const w = arena();
  assert.equal(w.apply({ type: 'admin', action: 'resetAll' }).reason, 'unauthorized');
});

test('the reducer does not mutate its input state', () => {
  const w = arena();
  const before = JSON.stringify(w.state);
  const frozen = JSON.parse(before);
  reduceGame(frozen, { type: 'command', messageId: 'x1', userId: 'id-alice', username: 'alice', text: '!challenge @bob', timestamp: w.now }, w.now);
  assert.equal(JSON.stringify(frozen), before);
});

test('duel history stays bounded, including declined challenges', () => {
  const w = arena();
  for (let i = 0; i < 40; i++) { w.say('alice', '!challenge @bob'); w.say('bob', '!decline'); }
  w.tick(1);
  assert.ok(w.state.duels.length <= 25);
});

test('overlay events: final blow emits duel_action before duel_completed, respawn emits player_respawned', () => {
  const w = arena();
  w.fight('alice', 'bob');
  knockOut(w, 'alice');
  const types = w.state.events.map((e) => e.type);
  const done = types.lastIndexOf('duel_completed');
  assert.equal(types[done - 1], 'duel_action');
  assert.equal(w.state.events[done - 1].hp['id-bob'], 0);
  w.tick(defaultConfig().respawnMs);
  assert.deepEqual(w.state.events.at(-1), { id: String(w.state.revision), type: 'player_respawned', at: w.now, userId: 'id-bob' });
});

test('the hourly subscription check persists without adding events', () => {
  const w = arena();
  const rev = w.state.revision;
  w.now += 5000;
  const r = reduceGame(w.state, { type: 'chat_checked' }, w.now);
  assert.equal(r.result.reason, 'chat_checked');
  assert.equal(r.state.revision, rev);
  assert.equal(r.changed, true, 'checkedAt must be persisted');
  assert.equal(r.visible, false, 'no overlay broadcast needed');
  assert.equal(r.state.chat.checkedAt, w.now);
});

test('resetAll clears arena players, open duels and rematch locks but keeps profiles', () => {
  const w = arena();
  w.register('alice'); w.register('bob');
  const id = w.fight('alice', 'bob');
  w.state.rematchLocks.push({ pair: 'id-alice:id-bob', until: w.now + 30_000 });
  const r = w.apply({ type: 'admin', actorId: 'mod', action: 'resetAll' });
  assert.equal(r.ok, true);
  assert.equal(w.state.players.length, 0);
  assert.equal(w.state.rematchLocks.length, 0);
  assert.equal(w.duel(id).status, 'cancelled');
  assert.equal(w.last.deletedProfileIds.length, 0);
});

test('an untouched first-preset config moves to the faster preset; edited configs stay', () => {
  const old = { strike: { damage: 10, cooldownMs: 3000 }, heavy: { damage: 25, cooldownMs: 8000 }, heal: { amount: 15, cooldownMs: 10000 } };
  const legacy = { ...createInitialState('x'), config: { ...defaultConfig(), inactivityMs: 60000, abilities: old }, configVersion: 1 };
  assert.deepEqual(reduceGame(legacy, { type: 'tick' }, T0).state.config, defaultConfig());
  const edited = { ...legacy, configVersion: 2 };
  assert.deepEqual(reduceGame(edited, { type: 'tick' }, T0).state.config.abilities, old);
});

test('a duel ends in a handful of hits', () => {
  const w = arena();
  const id = w.fight('alice', 'bob');
  let hits = 0;
  while (w.duel(id).status === 'active' && hits < 20) { w.advance(5_000); w.say('alice', hits % 2 ? '!strike' : '!heavy'); hits++; }
  assert.ok(hits <= 4, `took ${hits} hits`);
});

test('challenging your challenger accepts the duel', () => {
  const w = arena();
  const c = w.say('alice', '!challenge @bob');
  const r = w.say('bob', '!challenge @alice');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.reason, 'duel_started');
  assert.equal(r.duelId, c.duelId);
  assert.equal(w.duel(c.duelId).status, 'active');
  assert.equal(w.state.duels.length, 1);
});

test('StreamElements: a bare command sends t=- and reaches the room with no target', async () => {
  const { handleStreamElements, seCommandLines } = await import('../server/streamelements.js');
  assert.match(seCommandLines('https://x', 'nesszerra', 'k1')[1].response, /t=\$\(queryescape \$\(1\|-\)\)/);
  let sent;
  const url = new URL('https://x/api/se/nesszerra/accept?k=k1&id=2&u=bob&d=bob&t=-&m=1');
  await handleStreamElements(new Request(url), {}, { url, origin: 'https://x', channels: ['nesszerra'], roomFetch: async (c, p, init) => { sent = JSON.parse(init.body); return Response.json({ reply: 'ok' }); } });
  assert.equal(sent.target, '');
});

test('StreamElements: an empty room reply (repeated message id) posts nothing; a missing one says something went wrong', async () => {
  const { handleStreamElements } = await import('../server/streamelements.js');
  const url = new URL('https://x/api/se/nesszerra/accept?k=k1&id=2&u=bob&d=bob&t=-&m=1');
  const call = (body) => handleStreamElements(new Request(url), {}, { url, origin: 'https://x', channels: ['nesszerra'], roomFetch: async () => Response.json(body) }).then((r) => r.text());
  assert.equal(await call({ reply: '' }), '');
  assert.equal(await call({}), "That move didn't land. Try again in a moment!");
});

test('StreamElements: when the room switches over from a Twitch subscription, the Worker is asked to delete it', async () => {
  const { handleStreamElements } = await import('../server/streamelements.js');
  const url = new URL('https://x/api/se/nesszerra/decline?k=k1&id=2&u=bob&d=bob&t=-&m=1');
  const dropped = [];
  const call = (body) => handleStreamElements(new Request(url), {}, { url, origin: 'https://x', channels: ['nesszerra'], roomFetch: async () => Response.json(body), dropSubscription: (id) => dropped.push(id) }).then((r) => r.text());
  assert.equal(await call({ reply: 'hi', switchedFrom: 'sub-1' }), 'hi');
  await call({ reply: 'hi' });
  assert.deepEqual(dropped, ['sub-1']);
});

// roll r gives die 1 + floor(r * 6): 0.9 -> 6 (crit 50), 0.75 -> 5 (hit 34), 0.5 -> 4 (miss), 0.1 -> 1 (counter 34)
function quick(rolls) {
  const w = arena({ quick: true });
  const ch = w.say('alice', '!challenge @bob');
  const r = w.apply({ type: 'command', messageId: 'q' + rolls.join(), userId: 'id-bob', username: 'bob', displayName: 'bob', text: '!accept', timestamp: w.now, rolls });
  return { w, r, duel: w.duel(ch.duelId), actions: w.state.events.filter((e) => e.type === 'duel_action') };
}

test('quick duels: turns alternate, 6 crits for 50, 5 hits for 34, 1-2 counter for 34, 3-4 miss', () => {
  const cases = [
    { rolls: [0.9, 0.5, 0.9], winner: 'alice', dice: [6, 4, 6], outcomes: ['crit', 'miss', 'crit'], hp: 100, flawless: true },
    { rolls: [0.75, 0.75, 0.75, 0.75, 0.75], winner: 'alice', dice: [5, 5, 5, 5, 5], outcomes: ['hit', 'hit', 'hit', 'hit', 'hit'], hp: 32, flawless: false },
    { rolls: [0.1, 0.1, 0.1, 0.1, 0.1], winner: 'bob', dice: [1, 1, 1, 1, 1], outcomes: ['counter', 'counter', 'counter', 'counter', 'counter'], hp: 32, flawless: false },
  ];
  for (const c of cases) {
    const { w, r, duel, actions } = quick(c.rolls);
    const loser = c.winner === 'alice' ? 'bob' : 'alice';
    assert.equal(r.reason, 'quick_duel');
    assert.equal(r.winnerId, 'id-' + c.winner, JSON.stringify(c));
    assert.deepEqual(r.swings.map((x) => x.die), c.dice);
    assert.deepEqual(r.swings.map((x) => x.outcome), c.outcomes);
    assert.equal(r.winnerHp, c.hp); assert.equal(r.flawless, c.flawless); assert.equal(r.decision, 'ko');
    assert.equal(duel.status, 'completed');
    assert.equal(duel.hp['id-' + loser], 0);
    assert.equal(w.player(c.winner).wins, 1);
    assert.equal(w.player(loser).losses, 1);
    assert.ok(w.player(loser).respawnAt > w.now);
    assert.equal(actions.length, c.dice.length);
    assert.equal(actions.filter((e) => e.miss).length, c.outcomes.filter((o) => o === 'miss').length);
    assert.equal(actions.filter((e) => e.crit).length, c.outcomes.filter((o) => o === 'crit').length);
    assert.equal(actions.at(-1).finisher, true);
    assert.equal(actions.filter((e) => e.finisher).length, 1);
    assert.equal(w.player(c.winner).elo, c.flawless ? 1015 : 1012, 'flawless wins add 3 Elo');
    assert.equal(w.player(loser).elo, 988);
  }
});

test('quick duels: after 12 rolls more HP wins; equal HP goes to sudden death', () => {
  const onHp = quick([0.75, ...Array(11).fill(0.5)]);
  assert.equal(onHp.r.decision, 'hp'); assert.equal(onHp.r.swings.length, 12); assert.equal(onHp.r.winnerId, 'id-alice');
  assert.equal(onHp.duel.decision, 'hp');
  assert.equal(onHp.w.state.events.find((e) => e.type === 'duel_completed').decision, 'hp');
  const sudden = quick([...Array(12).fill(0.5), 0.5, 0.75]);
  assert.equal(sudden.r.decision, 'sudden_death'); assert.equal(sudden.r.swings.length, 14);
  assert.equal(sudden.r.winnerId, 'id-bob', 'roll 14 is the swing of bob');
  assert.equal(sudden.actions.at(-1).amount, 100, 'a sudden-death blow knocks out');
  assert.equal(sudden.duel.hp['id-alice'], 0);
});

test('quick duels are the default and work through a mutual challenge too', () => {
  assert.equal(defaultConfig().quickDuel, true);
  const w = arena({ quick: true });
  w.say('alice', '!challenge @bob');
  assert.equal(w.say('bob', '!challenge @alice').reason, 'quick_duel');
  assert.equal(w.apply({ type: 'admin', actorId: 'mod', action: 'config', payload: { patch: { quickDuel: 'yes' } } }).reason, 'invalid_config_quickDuel');
  assert.equal(w.state.config.announce, 'off', 'the duel banner is hidden until a mod turns it on');
  assert.equal(w.apply({ type: 'admin', actorId: 'mod', action: 'config', payload: { patch: { announce: 'left' } } }).reason, 'invalid_config_announce');
  assert.equal(w.apply({ type: 'admin', actorId: 'mod', action: 'config', payload: { patch: { announce: 'top' } } }).ok, true);
  assert.equal(w.state.config.announce, 'top');
  assert.equal(w.state.config.maxOnStream, 50, 'up to 50 characters on stream by default');
  for (const bad of [14, 101, 30.5, '30']) assert.equal(w.apply({ type: 'admin', actorId: 'mod', action: 'config', payload: { patch: { maxOnStream: bad } } }).reason, 'invalid_config_maxOnStream');
  assert.equal(w.apply({ type: 'admin', actorId: 'mod', action: 'config', payload: { patch: { maxOnStream: 15 } } }).ok, true);
  assert.equal(w.state.config.maxOnStream, 15);
  assert.equal(w.apply({ type: 'admin', actorId: 'mod', action: 'config', payload: { patch: { quickDuel: false } } }).ok, true);
});

test('a command marked quick (StreamElements, no attack commands) settles at once even with quick duels off', () => {
  const w = arena({ viewers: ['alice', 'bob', 'cara', 'dan', 'eve', 'fin'] });
  const quickSay = (login, text) => w.apply({ type: 'command', messageId: 'm' + (++seq), userId: 'id-' + login, username: login, displayName: login, text, timestamp: w.now, quick: true });
  quickSay('alice', '!challenge @bob');
  assert.equal(quickSay('bob', '!fight').reason, 'quick_duel');
  quickSay('cara', '!challenge @dan');
  assert.equal(quickSay('dan', '!challenge @cara').reason, 'quick_duel', 'a mutual challenge settles too');
  assert.equal(w.state.duels.filter((d) => d.status === 'active').length, 0);
  // Plain chat still gets the HP fight.
  const hp = w.say('eve', '!challenge @fin');
  assert.equal(w.say('fin', '!accept').ok, true);
  assert.equal(w.duel(hp.duelId).status, 'active');
});

test('invisible characters that chat clients append to repeated messages are ignored', async () => {
  assert.deepEqual(parseGameCommand('!fight \u{E0000}'), { action: 'accept', target: '' });
  assert.deepEqual(parseGameCommand('!challenge @bob \u034F'), { action: 'duel', target: 'bob' });
  const { seTarget } = await import('../server/streamelements.js');
  assert.equal(seTarget('\u{E0000}'), '');
  assert.equal(seTarget('-'), '');
  assert.equal(seTarget('@Bob\u{E0000}'), 'bob');
  assert.equal(seTarget('bad name!'), '');
});

test('StreamElements sign-up link names the channel, except for nesszerra', async () => {
  const { seReplyText } = await import('../server/streamelements.js');
  const reply = (channel) => seReplyText({ result: { ok: false, reason: 'target_not_found' }, state: createInitialState(channel), actorId: 'u1', action: 'challenge', target: 'bob', origin: 'https://chat.example' });
  assert.equal(reply('miolafff'), '@bob has no fighter in the arena yet! Send them to https://chat.example/?channel=miolafff');
  assert.equal(reply('nesszerra'), '@bob has no fighter in the arena yet! Send them to https://chat.example/');
});

// ---------- upgrades (server/upgrades.js) ----------
test('upgrade points: one per win up to 10, at most 5 per stat; a rank reset trims luck, then guard, then power', async () => {
  const u = await import('../server/upgrades.js');
  assert.deepEqual([0, 3, 10, 40].map(u.pointsFor), [0, 3, 10, 10]);
  assert.deepEqual(u.validStats({ power: 2, guard: 1 }, 3), { power: 2, guard: 1, luck: 0 });
  assert.equal(u.validStats({ power: 2, guard: 2 }, 3), null, 'more points than wins');
  assert.equal(u.validStats({ power: 6 }, 10), null, 'over the per-stat cap');
  assert.equal(u.validStats({ power: 1.5 }, 10), null);
  assert.deepEqual(u.effectiveStats({ power: 3, guard: 3, luck: 3 }, 5), { power: 3, guard: 2, luck: 0 });
  assert.equal(u.hatUnlocked('crown', 19), false);
  assert.equal(u.hatUnlocked('crown', 20), true);
  assert.equal(u.hatUnlocked('cap', 0), true);
  assert.equal(u.hatUnlocked('sombrero', 99), false);
});

function upgraded(stats) {
  const w = arena({ quick: true });
  for (const [login, s] of Object.entries(stats)) { w.register(login, { stats: s }); w.state.players.find((p) => p.username === login).wins = 10; }
  return w;
}
function quickWith(w, rolls) {
  w.say('alice', '!challenge @bob');
  return w.apply({ type: 'command', messageId: 'q' + (++seq), userId: 'id-bob', username: 'bob', displayName: 'bob', text: '!accept', timestamp: w.now, rolls });
}

test('quick duels: power adds 4% damage per point and guard takes 4% off per point', () => {
  const hit = [0.75, 0.5, 0.75, 0.5, 0.75, 0.5, 0.75];
  assert.deepEqual(quickWith(upgraded({ alice: { power: 5 } }), hit).swings.map((s) => s.damage), [41, 0, 41, 0, 18]);
  assert.deepEqual(quickWith(upgraded({ bob: { guard: 5 } }), hit).swings.map((s) => s.damage), [27, 0, 27, 0, 27, 0, 19]);
  // Points the wins no longer cover don't count: 5 power with 0 wins hits for the base 34.
  const w = arena({ quick: true });
  w.register('alice', { stats: { power: 5 } });
  assert.equal(quickWith(w, hit).swings[0].damage, 34);
});

test('quick duels: luck turns a miss into a hit with 4% per point, from a second roll', () => {
  const rolls = Array(48).fill(0.9);
  rolls[0] = 0.5;     // alice rolls a 4: a miss
  rolls[24] = 0.1;    // her luck roll: 0.1 < 5 x 4% -> the miss lands as a hit
  const r = quickWith(upgraded({ alice: { luck: 5 } }), rolls);
  assert.equal(r.swings[0].outcome, 'hit');
  assert.equal(r.swings[0].lucky, true);
  assert.equal(r.swings[0].damage, 34);
  rolls[24] = 0.25;   // above 20%: stays a miss
  assert.equal(quickWith(upgraded({ alice: { luck: 5 } }), rolls).swings[0].outcome, 'miss');
});

test('upgrades and hat come from the saved profile; no respec while a challenge is open', () => {
  const w = upgraded({ alice: { power: 2 } });
  assert.deepEqual(w.player('alice').stats, { power: 2, guard: 0, luck: 0 });
  // A chat command carrying the stored profile keeps them.
  w.apply({ type: 'command', messageId: 'p1', userId: 'id-alice', username: 'alice', displayName: 'alice', text: 'hi', timestamp: w.now, profile: { userId: 'id-alice', username: 'alice', registered: true, wins: 10, stats: { power: 4 }, hat: 'crown' } });
  assert.equal(w.player('alice').stats.power, 4);
  assert.equal(w.player('alice').hat, 'crown');
  w.say('alice', '!challenge @bob');
  assert.equal(w.register('alice', { stats: { guard: 4 } }).reason, 'in_duel');
  assert.equal(w.register('alice', { stats: { power: 4 }, hat: 'cap' }).ok, true, 'same build, new hat is fine');
});
