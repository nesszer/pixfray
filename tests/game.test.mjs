import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceGame, createInitialState, parseGameCommand, defaultConfig } from '../server/game.js';

const T0 = 1_800_000_000_000;
let seq = 0;

// Small harness: keeps state and clock, applies events through the pure reducer.
function arena({ relay = true, viewers = ['alice', 'bob', 'cara', 'dan'] } = {}) {
  const w = { state: createInitialState('nesszerra'), now: T0, last: null };
  w.apply = (event) => { const r = reduceGame(w.state, event, w.now); w.state = r.state; w.last = r; return r.result; };
  w.tick = (ms) => { w.now += ms; return w.apply({ type: 'tick' }); };
  w.heartbeat = () => w.apply({ type: 'relay_heartbeat', sessionId: w.state.relay.sessionId, twitchConnected: true });
  // Advance the clock while the relay keeps heartbeating every 10 s (the relay lease is 30 s).
  w.advance = (ms) => { const end = w.now + ms; while (w.now < end) { w.now = Math.min(end, w.now + 10_000); w.heartbeat(); } };
  w.say = (login, text) => w.apply({ type: 'command', messageId: 'm' + (++seq), userId: 'id-' + login, username: login, displayName: login, text, timestamp: w.now });
  w.register = (login, extra = {}) => w.apply({ type: 'profile_saved', profile: { userId: 'id-' + login, username: login, displayName: login, avatar: 'player', color: '#112233', defaultAbility: 'strike', ...extra } });
  w.player = (login) => w.state.players.find((p) => p.username === login);
  w.duel = (id) => w.state.duels.find((d) => d.id === id);
  w.fight = (a, b) => { const c = w.say(a, '!challenge @' + b); assert.equal(c.ok, true, c.reason); const r = w.say(b, '!accept'); assert.equal(r.ok, true, r.reason); return c.duelId; };
  if (relay) { w.apply({ type: 'relay_connected', sessionId: 's1' }); w.heartbeat(); }
  for (const v of viewers) w.register(v);
  return w;
}

test('balance preset matches the approved defaults', () => {
  const c = defaultConfig();
  assert.equal(c.maxHp, 100);
  assert.deepEqual(c.abilities, { strike: { damage: 10, cooldownMs: 3000 }, heavy: { damage: 25, cooldownMs: 8000 }, heal: { amount: 15, cooldownMs: 10000 } });
  assert.equal(c.sharedCooldownMs, 1000);
  assert.equal(c.maxDuels, 5);
  assert.equal(c.challengeTimeoutMs, 30000);
  assert.equal(c.inactivityMs, 60000);
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
  w.now += 29_999; w.heartbeat();
  assert.equal(w.duel(c.duelId).status, 'pending');
  w.now += 1; w.heartbeat();
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
  assert.equal(w.say('alice', '!strike').amount, 10);
  assert.equal(w.duel(id).hp['id-bob'], 90);
  w.now += 1000;
  assert.equal(w.say('alice', '!heavy').amount, 25);
  assert.equal(w.duel(id).hp['id-bob'], 65);
  const heal = w.say('bob', '!heal');
  assert.equal(heal.ability, 'heal');
  assert.equal(heal.amount, 15);
  assert.equal(w.duel(id).hp['id-bob'], 80);
  assert.equal(w.player('bob').hp, 80, 'player hp mirrors duel hp');
});

test('heal never exceeds max HP', () => {
  const w = arena();
  const id = w.fight('alice', 'bob');
  w.say('alice', '!strike');
  assert.equal(w.say('bob', '!heal').amount, 10);
  assert.equal(w.duel(id).hp['id-bob'], 100);
});

test('!attack uses the default ability chosen on the website', () => {
  const w = arena();
  w.register('alice', { defaultAbility: 'heavy' });
  w.fight('alice', 'bob');
  const r = w.say('alice', '!attack @bob');
  assert.equal(r.ability, 'heavy');
  assert.equal(r.amount, 25);
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
  // strike was used at T0; its own 3 s cooldown ends at T0+3000.
  w.now = T0 + 2999;
  r = w.say('alice', '!strike');
  assert.equal(r.reason, 'cooldown');
  assert.equal(r.retryAt, T0 + 3000);
  w.now = T0 + 3000;
  assert.equal(w.say('alice', '!strike').ok, true);
  // heavy used at T0+1000 -> available at T0+9000.
  w.now = T0 + 8999;
  assert.equal(w.say('alice', '!heavy').reason, 'cooldown');
  w.now = T0 + 9000;
  assert.equal(w.say('alice', '!heavy').ok, true);
});

test('heal has a 10 s cooldown and cooldowns are per fighter', () => {
  const w = arena();
  w.fight('alice', 'bob');
  w.say('alice', '!strike');
  assert.equal(w.say('bob', '!heal').ok, true, 'alice using an ability does not block bob');
  w.now += 9_999;
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
  // The channel passes the stored profile (hp=max, respawnAt=0) with every relay event.
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

test('60 s of inactivity cancels a duel without scoring', () => {
  const w = arena();
  const id = w.fight('alice', 'bob');
  w.say('alice', '!heavy');
  w.advance(59_999);
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
  w.advance(50_000); w.say('alice', '!strike');
  w.advance(50_000);
  assert.equal(w.duel(id).status, 'active');
});

test('ranked duels require a signed-in profile', () => {
  const w = arena({ viewers: ['alice'] });
  // guest chats but never signed in on the website
  w.apply({ type: 'presence', userId: 'id-guest', username: 'guest' });
  assert.equal(w.say('guest', '!challenge @alice').reason, 'ranked_sign_in_required');
  assert.equal(w.say('alice', '!challenge @guest').reason, 'ranked_sign_in_required');
  // a relay cannot forge registration: only profile_saved / stored profiles set it
  w.apply({ type: 'presence', userId: 'id-guest', username: 'guest', profile: { userId: 'id-guest', username: 'guest' } });
  assert.equal(w.player('guest').registered, false);
});

test('relay drop pauses combat and cancels unfinished duels unscored', () => {
  const w = arena();
  const active = w.fight('alice', 'bob');
  w.say('alice', '!heavy');
  const pending = w.say('cara', '!challenge @dan').duelId;
  w.apply({ type: 'relay_offline', sessionId: 's1' });
  assert.equal(w.duel(active).status, 'cancelled');
  assert.equal(w.duel(active).cancelReason, 'relay_disconnected');
  assert.equal(w.duel(pending).status, 'cancelled');
  assert.equal(w.player('alice').elo, 1000);
  assert.equal(w.player('bob').hp, 100);
  assert.equal(w.say('alice', '!challenge @bob').reason, 'relay_offline', 'commands are rejected while paused');
  w.apply({ type: 'relay_connected', sessionId: 's2' });
  assert.equal(w.say('alice', '!challenge @bob').reason, 'relay_offline', 'paused until Twitch heartbeat');
  w.heartbeat();
  assert.equal(w.say('alice', '!challenge @bob').ok, true);
});

test('a silent relay is treated as dropped after the lease expires', () => {
  const w = arena();
  const id = w.fight('alice', 'bob');
  w.say('alice', '!strike');
  w.tick(defaultConfig().relayLeaseMs + 1);
  assert.equal(w.state.relay.connected, false);
  assert.equal(w.duel(id).status, 'cancelled');
});

test('relay heartbeat reporting Twitch down also cancels duels', () => {
  const w = arena();
  const id = w.fight('alice', 'bob');
  w.apply({ type: 'relay_heartbeat', sessionId: 's1', twitchConnected: false });
  assert.equal(w.duel(id).status, 'cancelled');
  assert.equal(w.state.relay.connected, false);
});

test('a replacement relay cancels open duels and stale sessions are ignored', () => {
  const w = arena();
  const id = w.fight('alice', 'bob');
  w.apply({ type: 'relay_connected', sessionId: 's2' });
  assert.equal(w.duel(id).status, 'cancelled');
  w.heartbeat();
  const id2 = w.fight('alice', 'bob');
  assert.equal(w.apply({ type: 'relay_offline', sessionId: 's1' }).reason, 'stale_relay_session');
  assert.equal(w.duel(id2).status, 'active');
});

test('duplicate and stale relay messages are ignored', () => {
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
  assert.equal(w.state.config.abilities.strike.cooldownMs, 3000, 'partial ability patch keeps other fields');
  assert.equal(w.apply({ type: 'admin', actorId: 'mod', action: 'config', payload: { baseVersion: 1, patch: { maxHp: 120 } } }).reason, 'config_version_conflict');
  assert.equal(w.say('alice', '!strike').amount, 10, 'running duel keeps the rules it started with');
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

test('routine relay heartbeats refresh the lease without adding events', () => {
  const w = arena();
  const rev = w.state.revision;
  w.now += 5000;
  const r = reduceGame(w.state, { type: 'relay_heartbeat', sessionId: 's1', twitchConnected: true }, w.now);
  assert.equal(r.result.reason, 'heartbeat');
  assert.equal(r.state.revision, rev);
  assert.equal(r.changed, true, 'lastSeen must be persisted');
  assert.equal(r.visible, false, 'no overlay broadcast needed');
  assert.equal(r.state.relay.lastSeen, w.now);
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
