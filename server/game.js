import { cleanStats, effectiveStats, emptyStats, knownHat, scaledDamage, STAT_STEP } from "./upgrades.js";

const DEFAULT_CONFIG = {
  enabled: true,
  // Quick duels: accepting settles the duel at once with a d6 exchange (hit, counter or miss).
  // Off = the HP fight with !attack/!strike/!heavy/!heal. StreamElements has no attack commands, so its duels
  // always settle quickly (commands marked quick: true).
  quickDuel: true,
  // Overlay duel banner: "off", "top" or "bottom". Live overlays read it from the snapshot, so mods change it without a new OBS link.
  announce: "off",
  // Most characters walking on the overlay at once (the longest-quiet chatter leaves first). Overlays read it from the snapshot too.
  maxOnStream: 50,
  maxHp: 100,
  maxDuels: 5,
  challengeTimeoutMs: 30_000,
  inactivityMs: 45_000,
  respawnMs: 3_000,
  rematchDelayMs: 30_000,
  // How far the stream runs behind chat. Chat keeps a quick duel's result hidden this long after the overlay shows it.
  streamDelayMs: 6_000,
  sharedCooldownMs: 1_000,
  initialElo: 1_000,
  eloK: 24,
  // !checkin: upgrade points per stream check-in, and +1 more at a streak of 3, 7, 14 and 30 streams.
  checkinPoints: 1,
  streakBonus: true,
  abilities: {
    strike: { damage: 20, cooldownMs: 2_000 },
    heavy: { damage: 35, cooldownMs: 5_000 },
    heal: { amount: 15, cooldownMs: 12_000 },
  },
};

// The first preset (10/25 damage) made duels drag on for 10+ hits. Channels that never edited it move to the current one.
const LEGACY_CONFIG = { ...DEFAULT_CONFIG, inactivityMs: 60_000, abilities: { strike: { damage: 10, cooldownMs: 3_000 }, heavy: { damage: 25, cooldownMs: 8_000 }, heal: { amount: 15, cooldownMs: 10_000 } } };

const ANNOUNCE = ["off", "top", "bottom"];
const ON_STREAM = [15, 100];
const MAX_ACTIVE_PLAYERS = 100;
const MAX_RECENT_EVENTS = 100;
const MAX_APPLIED_MESSAGE_IDS = 1_000;
const MAX_DUEL_HISTORY = 25;
const ACTIVE_TTL_MS = 10 * 60_000;
const ABILITIES = new Set(["strike", "heavy", "heal"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeString(value, maxLength = 64) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeUsername(value) {
  return safeString(value, 25).replace(/^@/, "").toLowerCase();
}

function normalizeUserId(value) {
  return safeString(String(value ?? ""), 64);
}

function defaultProfile(userId, config, now) {
  return {
    userId,
    username: "",
    displayName: "",
    avatar: "player",
    color: "#A78BFA",
    defaultAbility: "strike",
    hp: config.maxHp,
    elo: config.initialElo,
    wins: 0,
    losses: 0,
    lastSeen: now,
    registered: false,
    respawnAt: 0,
    stats: emptyStats(),
    hat: "",
    bonus: 0,   // check-in points (server/channel.js checkin), added to the wins for upgrades
  };
}

function boundedInt(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function normalizeConfig(config) {
  const merged = {
    ...clone(DEFAULT_CONFIG),
    ...(config && typeof config === "object" ? config : {}),
    abilities: {
      ...clone(DEFAULT_CONFIG.abilities),
      ...(config?.abilities && typeof config.abilities === "object" ? config.abilities : {}),
    },
  };
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (key === "abilities") continue;
    if (typeof value === "boolean") merged[key] = Boolean(merged[key]);
    else if (key === "announce") merged[key] = ANNOUNCE.includes(merged[key]) ? merged[key] : value;
    else if (key === "maxOnStream") merged[key] = Number.isInteger(merged[key]) ? Math.max(ON_STREAM[0], Math.min(ON_STREAM[1], merged[key])) : value;
    else if (!Number.isInteger(merged[key])) merged[key] = value;
  }
  for (const [name, defaults] of Object.entries(DEFAULT_CONFIG.abilities)) {
    const candidate = merged.abilities[name] ?? {};
    merged.abilities[name] = {};
    for (const [key, value] of Object.entries(defaults)) {
      merged.abilities[name][key] = Number.isInteger(candidate[key]) ? candidate[key] : value;
    }
  }
  delete merged.relayLeaseMs;
  return merged;
}

export function createInitialState(channel = "nesszerra") {
  return {
    channel: safeString(channel, 25).toLowerCase() || "nesszerra",
    revision: 0,
    // Chat source: one Twitch EventSub webhook subscription (channel.chat.message). lastSeen = last notification.
    chat: { connected: false, lastSeen: 0, subscriptionId: "", status: "disconnected", createdAt: 0, revokedReason: "", checkedAt: 0, verifiedId: "" },
    config: clone(DEFAULT_CONFIG),
    configVersion: 1,
    round: 0,
    players: [],
    duels: [],
    rematchLocks: [],
    events: [],
    appliedMessageIds: [],
    nextDuelId: 1,
  };
}

function addEvent(state, type, now, details = {}) {
  state.revision += 1;
  state.events.push({ id: String(state.revision), type, at: now, ...details });
  if (state.events.length > MAX_RECENT_EVENTS) {
    state.events.splice(0, state.events.length - MAX_RECENT_EVENTS);
  }
}

function openDuels(state) {
  return state.duels.filter((duel) => duel.status === "pending" || duel.status === "active");
}

function player(state, userId) {
  return state.players.find((item) => item.userId === userId);
}

function duelHasUser(duel, userId) {
  return duel.a === userId || duel.b === userId;
}

function hasOpenDuel(state, userId) {
  return openDuels(state).some((duel) => duelHasUser(duel, userId));
}

function pairKey(a, b) {
  return [a, b].sort().join(":");
}

function recentProfile(state, profile, now) {
  if (!profile || !profile.userId) return null;
  const userId = normalizeUserId(profile.userId);
  if (!userId) return null;
  const existing = player(state, userId);
  const base = existing ? { ...existing } : defaultProfile(userId, state.config, now);
  const username = normalizeUsername(profile.username);
  const displayName = safeString(profile.displayName || username || base.displayName, 48);
  const avatar = safeString(profile.avatar || base.avatar || "player", 64);
  const color = /^#[0-9a-f]{6}$/i.test(profile.color || "") ? profile.color.toUpperCase() : (base.color || "#A78BFA");
  const defaultAbility = ABILITIES.has(profile.defaultAbility) ? profile.defaultAbility : (base.defaultAbility || "strike");
  const merged = {
    ...base,
    username: username || base.username,
    displayName: displayName || username || base.displayName || userId,
    avatar,
    color,
    defaultAbility,
    registered: Boolean(base.registered || profile.registered),
    lastSeen: now,
  };
  if (Number.isInteger(profile.elo) && profile.registered) merged.elo = profile.elo;
  if (Number.isInteger(profile.wins) && profile.registered) merged.wins = profile.wins;
  if (Number.isInteger(profile.losses) && profile.registered) merged.losses = profile.losses;
  // Upgrades and hat come from the saved profile only (the dashboard sets them; chat can't).
  if (profile.registered && profile.stats) merged.stats = cleanStats(profile.stats);
  if (profile.registered && typeof profile.hat === "string") merged.hat = knownHat(profile.hat) ? profile.hat : "";
  if (profile.registered && Number.isInteger(profile.bonus)) merged.bonus = Math.max(0, profile.bonus);
  // hp/respawnAt only seed a new player, so a later chat message can never undo a KO.
  if (!existing && Number.isInteger(profile.hp) && profile.registered) merged.hp = Math.min(state.config.maxHp, Math.max(0, profile.hp));
  if (!existing && Number.isInteger(profile.respawnAt)) merged.respawnAt = profile.respawnAt;
  // !rematch: the last finished duel's opponent. The game's own value is newer than a saved one.
  if (profile.registered && !merged.lastOpponentId && normalizeUserId(profile.lastOpponentId)) merged.lastOpponentId = normalizeUserId(profile.lastOpponentId);
  if (existing) Object.assign(existing, merged);
  else {
    if (state.players.length >= MAX_ACTIVE_PLAYERS) {
      const candidates = state.players
        .filter((item) => !hasOpenDuel(state, item.userId))
        .sort((a, b) => a.lastSeen - b.lastSeen);
      if (!candidates.length) return null;
      state.players.splice(state.players.indexOf(candidates[0]), 1);
    }
    state.players.push(merged);
  }
  return player(state, userId);
}

// Cancelled duels are unscored: no Elo, no wins/losses, no KO. Fighters are restored to full health.
function cancelDuel(state, duel, now, reason) {
  if (duel.status !== "pending" && duel.status !== "active") return false;
  const wasActive = duel.status === "active";
  duel.status = "cancelled";
  duel.endedAt = now;
  duel.cancelReason = reason;
  duel.winnerId = null;
  if (wasActive) {
    for (const userId of [duel.a, duel.b]) {
      const p = player(state, userId);
      if (p) {
        p.hp = state.config.maxHp;
        p.respawnAt = 0;
      }
    }
  }
  addEvent(state, "duel_cancelled", now, { duelId: duel.id, a: duel.a, b: duel.b, reason, wasActive });
  return true;
}

function isTerminal(duel) {
  return duel.status === "completed" || duel.status === "cancelled" || duel.status === "expired" || duel.status === "declined";
}

function expireState(state, now) {
  let changed = false;
  state.config = normalizeConfig(state.config);

  for (const duel of state.duels) {
    if (duel.status === "pending" && now >= duel.expiresAt) {
      duel.status = "expired";
      duel.endedAt = now;
      addEvent(state, "challenge_expired", now, { duelId: duel.id, a: duel.a, b: duel.b });
      changed = true;
    } else if (duel.status === "active" && now - duel.lastActionAt >= state.config.inactivityMs) {
      cancelDuel(state, duel, now, "inactivity");
      changed = true;
    }
  }

  for (const p of state.players) {
    if (p.respawnAt && now >= p.respawnAt) {
      p.hp = state.config.maxHp;
      p.respawnAt = 0;
      addEvent(state, "player_respawned", now, { userId: p.userId });
      changed = true;
    }
  }

  state.rematchLocks = state.rematchLocks.filter((lock) => lock.until > now);
  const inDuel = new Set(openDuels(state).flatMap((duel) => [duel.a, duel.b]));
  const before = state.players.length;
  state.players = state.players.filter((p) => inDuel.has(p.userId) || p.respawnAt > now || now - p.lastSeen <= ACTIVE_TTL_MS);
  if (state.players.length !== before) changed = true;

  const terminal = state.duels.filter(isTerminal);
  if (terminal.length > MAX_DUEL_HISTORY) {
    const keep = new Set(terminal.slice(-MAX_DUEL_HISTORY).map((duel) => duel.id));
    state.duels = state.duels.filter((duel) => duel.status === "pending" || duel.status === "active" || keep.has(duel.id));
    changed = true;
  }
  return changed;
}

function addRecent(state, event, now) {
  const id = normalizeUserId(event.messageId || event.id);
  if (!id) return { ok: false, reason: "missing_message_id" };
  if (state.appliedMessageIds.includes(id)) return { ok: false, reason: "duplicate" };
  state.appliedMessageIds.push(id);
  if (state.appliedMessageIds.length > MAX_APPLIED_MESSAGE_IDS) {
    state.appliedMessageIds.splice(0, state.appliedMessageIds.length - MAX_APPLIED_MESSAGE_IDS);
  }
  return { ok: true, id };
}

function findTargetProfile(state, event, targetUsername, now) {
  const existing = state.players.find((item) => item.username === targetUsername);
  if (existing) return existing;
  if (event.targetProfile && normalizeUsername(event.targetProfile.username) === targetUsername) {
    return recentProfile(state, event.targetProfile, now);
  }
  return null;
}

function registeredPlayer(state, userId, event, now) {
  const p = recentProfile(state, event.profile, now) || player(state, userId);
  if (!p) return null;
  return p.userId === userId && p.registered ? p : null;
}

function createChallenge(state, actor, target, now) {
  if (!state.config.enabled) return { ok: false, reason: "duels_disabled" };
  if (!actor.registered || !target.registered) return { ok: false, reason: "ranked_sign_in_required" };
  if (actor.userId === target.userId) return { ok: false, reason: "self_duel" };
  if (hasOpenDuel(state, actor.userId) || hasOpenDuel(state, target.userId)) {
    return { ok: false, reason: "player_busy" };
  }
  const lock = state.rematchLocks.find((item) => item.pair === pairKey(actor.userId, target.userId) && item.until > now);
  // Until the stream has shown a fight, both fighters get the same answer, so a challenge can't tell who lost.
  const hidden = hiddenResults(state, now);
  if (!lock && (hidden.has(actor.userId) || hidden.has(target.userId))) return { ok: false, reason: "result_hidden" };
  const down = actor.respawnAt > now ? actor : target.respawnAt > now ? target : null;
  if (down) return { ok: false, reason: "respawning", userId: down.userId, retryAt: down.respawnAt };   // name who is knocked out, not who asked
  if (openDuels(state).length >= state.config.maxDuels) return { ok: false, reason: "channel_full" };
  if (lock) return { ok: false, reason: "rematch_cooldown", retryAt: lock.until };
  const duel = {
    id: "duel-" + state.nextDuelId++,
    a: actor.userId,
    b: target.userId,
    status: "pending",
    createdAt: now,
    expiresAt: now + state.config.challengeTimeoutMs,
    hp: {},
    winnerId: null,
  };
  state.duels.push(duel);
  addEvent(state, "challenge_created", now, { duelId: duel.id, a: actor.userId, b: target.userId, expiresAt: duel.expiresAt });
  return { ok: true, duelId: duel.id };
}

function beginDuel(state, duel, now) {
  const a = player(state, duel.a);
  const b = player(state, duel.b);
  if (!a?.registered || !b?.registered) return { ok: false, reason: "ranked_sign_in_required" };
  state.round += 1;
  duel.round = state.round;
  duel.status = "active";
  duel.startedAt = now;
  duel.lastActionAt = now;
  duel.hp = { [duel.a]: state.config.maxHp, [duel.b]: state.config.maxHp };
  duel.rules = {
    maxHp: state.config.maxHp,
    inactivityMs: state.config.inactivityMs,
    respawnMs: state.config.respawnMs,
    rematchDelayMs: state.config.rematchDelayMs,
    sharedCooldownMs: state.config.sharedCooldownMs,
    abilities: clone(state.config.abilities),
  };
  duel.cooldowns = {
    [duel.a]: { sharedUntil: 0, strikeUntil: 0, heavyUntil: 0, healUntil: 0 },
    [duel.b]: { sharedUntil: 0, strikeUntil: 0, heavyUntil: 0, healUntil: 0 },
  };
  a.hp = state.config.maxHp;
  b.hp = state.config.maxHp;
  a.respawnAt = 0;
  b.respawnAt = 0;
  addEvent(state, "duel_started", now, { duelId: duel.id, a: duel.a, b: duel.b, round: duel.round, hp: clone(duel.hp) });
  return { ok: true, duelId: duel.id };
}

// Quick duel: a d6 exchange settled at once. Fighters take turns swinging, the challenger first:
// 6 is a crit (50% of max HP), 5 a hit (34%), 3-4 a miss, 1-2 the other fighter counters (34%).
// First to 0 HP loses. After QUICK_MAX_ROLLS rolls the fighter with more HP wins; equal HP goes to
// sudden death, where the next hit or counter knocks out. A winner who took no damage is flawless (+3 Elo).
// Upgrades (server/upgrades.js): power and guard scale each blow; luck can turn a miss into a hit, using a
// second roll at LUCK_ROLLS + i.
// rolls are numbers in [0, 1) from the room; missing ones come from a hash so the reducer stays pure.
const QUICK_MAX_ROLLS = 12;
// A quick duel is settled at once, but the overlay plays it out over seconds and viewers see the stream a few
// seconds behind chat (config.streamDelayMs). Until revealAt, chat replies, !elo, !ranks and the leaderboard keep the pre-fight
// numbers (hiddenResults), so the stream shows the winner first. Pacing mirrors public/overlay.js: a walk-in
// of up to 2.2 s, then about 1.8 s per roll before the result banner.
const REPLAY_WALK_MS = 2200, REPLAY_ROLL_MS = 1800;
export const replayMs = (rolls) => REPLAY_WALK_MS + REPLAY_ROLL_MS * Math.max(1, rolls);
const QUICK_FLAWLESS_BONUS = 3;
const LUCK_ROLLS = 24;
function settleQuickDuel(state, duel, rolls, now) {
  const list = Array.isArray(rolls) ? rolls : [];
  const rollAt = (i) => (Number.isFinite(list[i]) && list[i] >= 0 && list[i] < 1 ? list[i] : hashRoll(duel.id + ":" + now + ":" + i));
  const maxHp = duel.rules.maxHp;
  const blow = { hit: Math.round(maxHp * 0.34), crit: Math.round(maxHp * 0.5), counter: Math.round(maxHp * 0.34) };
  const look = (id) => player(state, id)?.defaultAbility || "strike";   // cosmetic: picks the attack effect on the overlay
  const stats = Object.fromEntries([duel.a, duel.b].map((id) => [id, effectiveStats(player(state, id)?.stats, player(state, id)?.wins, player(state, id)?.bonus)]));
  const swings = [];
  let attacker = duel.a, defender = duel.b, winnerId = "", loserId = "", decision = "ko";
  for (let i = 0; !winnerId && i < 200; i++) {
    const suddenDeath = i >= QUICK_MAX_ROLLS;
    if (i === QUICK_MAX_ROLLS) {
      if (duel.hp[duel.a] !== duel.hp[duel.b]) {
        decision = "hp";
        winnerId = duel.hp[duel.a] > duel.hp[duel.b] ? duel.a : duel.b;
        loserId = winnerId === duel.a ? duel.b : duel.a;
        break;
      }
      decision = "sudden_death";
    }
    const die = 1 + Math.floor(rollAt(i) * 6);
    let outcome = die === 6 ? "crit" : die === 5 ? "hit" : die <= 2 ? "counter" : "miss";
    const lucky = outcome === "miss" && rollAt(LUCK_ROLLS + i) < STAT_STEP * stats[attacker].luck;
    if (lucky) outcome = "hit";
    const swing = { attackerId: attacker, defenderId: defender, die, outcome, damage: 0, ...(lucky ? { lucky: true } : {}) };
    swings.push(swing);
    if (outcome === "miss") {
      addEvent(state, "duel_action", now, { duelId: duel.id, userId: attacker, targetId: defender, ability: look(attacker), amount: 0, hp: clone(duel.hp), miss: true, die });
    } else {
      const dealer = outcome === "counter" ? defender : attacker, target = outcome === "counter" ? attacker : defender;
      const amount = suddenDeath ? duel.hp[target] : Math.min(duel.hp[target], scaledDamage(blow[outcome], stats[dealer], stats[target]));
      duel.hp[target] -= amount;
      swing.damage = amount;
      const finisher = duel.hp[target] <= 0;
      addEvent(state, "duel_action", now, { duelId: duel.id, userId: dealer, targetId: target, ability: look(dealer), amount, hp: clone(duel.hp), die,
        ...(outcome === "counter" ? { counter: true } : {}), ...(outcome === "crit" ? { crit: true } : {}), ...(lucky ? { lucky: true } : {}), ...(finisher ? { finisher: true } : {}) });
      if (finisher) { winnerId = dealer; loserId = target; }
    }
    [attacker, defender] = [defender, attacker];
  }
  const flawless = duel.hp[winnerId] === maxHp;
  finishDuel(state, duel, winnerId, now, { decision, bonus: flawless ? QUICK_FLAWLESS_BONUS : 0 });
  duel.revealAt = now + replayMs(swings.length) + state.config.streamDelayMs;
  return { ok: true, reason: "quick_duel", duelId: duel.id, winnerId, loserId, swings, winnerHp: duel.hp[winnerId], flawless, decision };
}

function hashRoll(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

function finishDuel(state, duel, winnerId, now, { decision = "ko", bonus = 0 } = {}) {
  const a = player(state, duel.a);
  const b = player(state, duel.b);
  if (!a || !b) return;
  const ratingA = a.elo;
  const ratingB = b.elo;
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const scoreA = winnerId === duel.a ? 1 : 0;
  const nextA = Math.round(ratingA + state.config.eloK * (scoreA - expectedA)) + (scoreA === 1 ? bonus : 0);
  const nextB = Math.round(ratingB + state.config.eloK * ((1 - scoreA) - (1 - expectedA))) + (scoreA === 0 ? bonus : 0);
  a.elo = nextA;
  b.elo = nextB;
  if (winnerId === duel.a) {
    a.wins += 1;
    b.losses += 1;
  } else {
    b.wins += 1;
    a.losses += 1;
  }
  // The loser is knocked out (hp 0) and respawns at full health after respawnMs; the winner is healed at once.
  const winner = winnerId === duel.a ? a : b;
  const loser = winnerId === duel.a ? b : a;
  winner.hp = state.config.maxHp;
  winner.respawnAt = 0;
  loser.hp = 0;
  loser.respawnAt = now + duel.rules.respawnMs;
  a.lastOpponentId = b.userId;
  b.lastOpponentId = a.userId;
  duel.status = "completed";
  duel.winnerId = winnerId;
  duel.endedAt = now;
  duel.ratings = {
    [duel.a]: { before: ratingA, after: nextA, delta: nextA - ratingA },
    [duel.b]: { before: ratingB, after: nextB, delta: nextB - ratingB },
  };
  if (bonus) { duel.ratings[winnerId].bonus = bonus; duel.flawless = true; }
  if (decision !== "ko") duel.decision = decision;
  state.rematchLocks.push({
    pair: pairKey(duel.a, duel.b),
    until: now + duel.rules.rematchDelayMs,
  });
  addEvent(state, "duel_completed", now, {
    duelId: duel.id,
    winnerId,
    loserId: loser.userId,
    round: duel.round,
    respawnAt: loser.respawnAt,
    hp: clone(duel.hp),
    ratings: clone(duel.ratings),
    ...(bonus ? { flawless: true } : {}),
    ...(decision !== "ko" ? { decision } : {}),
  });
}

function applyAbility(state, duel, actor, abilityName, now) {
  if (!ABILITIES.has(abilityName)) return { ok: false, reason: "invalid_ability" };
  const ability = duel.rules.abilities[abilityName];
  if (!ability) return { ok: false, reason: "invalid_ability" };
  const cooldown = duel.cooldowns[actor.userId];
  if (!cooldown) return { ok: false, reason: "not_in_duel" };
  const abilityUntilKey = abilityName + "Until";
  const availableAt = Math.max(cooldown.sharedUntil, cooldown[abilityUntilKey] || 0);
  if (now < availableAt) return { ok: false, reason: "cooldown", retryAt: availableAt };
  if (duel.hp[actor.userId] <= 0) return { ok: false, reason: "respawning" };

  const targetId = actor.userId === duel.a ? duel.b : duel.a;
  let amount = 0;
  if (abilityName === "heal") {
    const before = duel.hp[actor.userId];
    duel.hp[actor.userId] = Math.min(duel.rules.maxHp, before + ability.amount);
    amount = duel.hp[actor.userId] - before;
  } else {
    const before = duel.hp[targetId];
    const foe = player(state, targetId);
    const damage = scaledDamage(ability.damage, effectiveStats(actor.stats, actor.wins, actor.bonus), effectiveStats(foe?.stats, foe?.wins, foe?.bonus));
    duel.hp[targetId] = Math.max(0, before - damage);
    amount = before - duel.hp[targetId];
  }
  cooldown.sharedUntil = now + duel.rules.sharedCooldownMs;
  cooldown[abilityUntilKey] = now + ability.cooldownMs;
  duel.lastActionAt = now;
  actor.lastSeen = now;
  actor.hp = duel.hp[actor.userId];
  const target = player(state, targetId);
  if (target) target.hp = duel.hp[targetId];

  addEvent(state, "duel_action", now, { duelId: duel.id, userId: actor.userId, targetId: abilityName === "heal" ? actor.userId : targetId, ability: abilityName, amount, hp: clone(duel.hp) });
  if (duel.hp[targetId] <= 0) {
    finishDuel(state, duel, actor.userId, now);
    return { ok: true, reason: "duel_completed", duelId: duel.id, ability: abilityName, amount, winnerId: actor.userId };
  }
  return { ok: true, reason: "action_applied", duelId: duel.id, ability: abilityName, amount };
}

function applyCommand(state, event, now) {
  const parsed = parseGameCommand(event.text);
  if (!parsed) return { ok: false, reason: "not_game_command" };
  const userId = normalizeUserId(event.userId);
  const actor = registeredPlayer(state, userId, event, now);
  if (!actor) return { ok: false, reason: "ranked_sign_in_required" };
  const quick = state.config.quickDuel || event.quick === true;

  if (parsed.action === "duel" || parsed.action === "rematch") {
    let target;
    if (parsed.action === "rematch") {
      // Answer a waiting challenge, or challenge the last opponent of a finished duel (the room passes their saved
      // profile as targetProfile). A player has at most one open duel, so there is at most one waiting challenge.
      const incoming = openDuels(state).find((item) => item.status === "pending" && item.b === actor.userId);
      const lastId = incoming ? incoming.a : actor.lastOpponentId;
      target = lastId && (player(state, lastId) || (normalizeUserId(event.targetProfile?.userId) === lastId ? recentProfile(state, event.targetProfile, now) : null));
      if (!target) return { ok: false, reason: "no_previous_opponent" };
    } else {
      const username = normalizeUsername(parsed.target);
      if (!username) return { ok: false, reason: "target_required" };
      target = findTargetProfile(state, event, username, now);
      if (!target) return { ok: false, reason: "target_not_found" };
    }
    if (!target.registered) return { ok: false, reason: "ranked_sign_in_required" };
    // Challenging someone who already challenged you accepts their challenge.
    const mutual = openDuels(state).find((item) => item.status === "pending" && item.a === target.userId && item.b === actor.userId);
    if (mutual) {
      const started = beginDuel(state, mutual, now);
      if (started.ok && quick) return settleQuickDuel(state, mutual, event.rolls, now);
      return started.ok ? { ...started, reason: "duel_started" } : started;
    }
    return createChallenge(state, actor, target, now);
  }

  if (parsed.action === "accept" || parsed.action === "decline") {
    const challenger = normalizeUsername(parsed.target);
    const duel = openDuels(state).find((item) => {
      if (item.status !== "pending" || item.b !== actor.userId) return false;
      if (!challenger) return true;
      const a = player(state, item.a);
      return a?.username === challenger;
    });
    if (!duel) return { ok: false, reason: "challenge_not_found" };
    if (parsed.action === "decline") {
      duel.status = "declined";
      duel.endedAt = now;
      addEvent(state, "challenge_declined", now, { duelId: duel.id, declinedBy: actor.userId });
      return { ok: true, reason: "challenge_declined", duelId: duel.id };
    }
    const started = beginDuel(state, duel, now);
    if (started.ok && quick) return settleQuickDuel(state, duel, event.rolls, now);
    return started;
  }

  const abilityName = parsed.action === "attack" ? actor.defaultAbility : parsed.action;
  const duel = openDuels(state).find((item) => item.status === "active" && duelHasUser(item, actor.userId));
  if (!duel) return { ok: false, reason: "not_in_active_duel" };
  if (parsed.target) {
    const targetName = normalizeUsername(parsed.target);
    const opponentId = duel.a === actor.userId ? duel.b : duel.a;
    if (player(state, opponentId)?.username !== targetName) return { ok: false, reason: "wrong_opponent" };
  }
  return applyAbility(state, duel, actor, abilityName, now);
}

function validateConfigPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, reason: "invalid_config" };
  const out = {};
  const ranges = {
    maxHp: [1, 1_000],
    maxDuels: [1, 5],
    challengeTimeoutMs: [5_000, 300_000],
    inactivityMs: [10_000, 600_000],
    respawnMs: [0, 60_000],
    rematchDelayMs: [0, 600_000],
    streamDelayMs: [0, 60_000],
    sharedCooldownMs: [250, 60_000],
    initialElo: [0, 10_000],
    eloK: [1, 100],
    maxOnStream: ON_STREAM,
    checkinPoints: [0, 3],
  };
  for (const key of Object.keys(patch)) {
    if (key === "enabled" || key === "quickDuel" || key === "streakBonus") {
      if (typeof patch[key] !== "boolean") return { ok: false, reason: "invalid_config_" + key };
      out[key] = patch[key];
    } else if (key === "announce") {
      if (!ANNOUNCE.includes(patch[key])) return { ok: false, reason: "invalid_config_announce" };
      out[key] = patch[key];
    } else if (key === "relayLeaseMs") {
      continue;   // removed with the relay; old history versions may still carry it, so rollbacks skip it
    } else if (ranges[key]) {
      const value = boundedInt(patch[key], ranges[key][0], ranges[key][1]);
      if (value === null) return { ok: false, reason: "invalid_config_" + key };
      out[key] = value;
    } else if (key === "abilities") {
      if (!patch.abilities || typeof patch.abilities !== "object" || Array.isArray(patch.abilities)) return { ok: false, reason: "invalid_config_abilities" };
      const abilities = {};
      for (const [name, spec] of Object.entries(patch.abilities)) {
        if (!ABILITIES.has(name) || !spec || typeof spec !== "object" || Array.isArray(spec)) return { ok: false, reason: "invalid_config_ability" };
        const allowed = name === "heal" ? ["amount", "cooldownMs"] : ["damage", "cooldownMs"];
        abilities[name] = {};
        for (const [field, value] of Object.entries(spec)) {
          if (!allowed.includes(field)) return { ok: false, reason: "invalid_config_ability_field" };
          const [min, max] = field === "cooldownMs" ? [250, 600_000] : [1, 1_000];
          const valid = boundedInt(value, min, max);
          if (valid === null) return { ok: false, reason: "invalid_config_ability_value" };
          abilities[name][field] = valid;
        }
      }
      out.abilities = abilities;
    } else return { ok: false, reason: "unknown_config_field" };
  }
  return { ok: true, patch: out };
}

function applyAdmin(state, event, now) {
  const actorId = normalizeUserId(event.actorId);
  if (!actorId) return { ok: false, reason: "unauthorized" };
  const action = safeString(event.action, 32);
  const payload = event.payload && typeof event.payload === "object" ? event.payload : event;
  const dirtyProfileIds = [];
  const deletedProfileIds = [];

  if (action === "config") {
    if (payload.baseVersion !== undefined && payload.baseVersion !== state.configVersion) {
      return { ok: false, reason: "config_version_conflict", configVersion: state.configVersion };
    }
    const patchResult = validateConfigPatch(payload.patch || payload.config);
    if (!patchResult.ok) return patchResult;
    const config = { ...state.config };
    for (const [key, value] of Object.entries(patchResult.patch)) {
      if (key === "abilities") {
        config.abilities = { ...config.abilities };
        for (const [name, spec] of Object.entries(value)) config.abilities[name] = { ...config.abilities[name], ...spec };
      } else config[key] = value;
    }
    state.config = normalizeConfig(config);
    state.configVersion += 1;
    if (!state.config.enabled) {
      for (const duel of openDuels(state)) cancelDuel(state, duel, now, "duels_disabled");
    }
    addEvent(state, "config_updated", now, { actorId, configVersion: state.configVersion, config: clone(state.config) });
    return { ok: true, reason: "config_updated", config: clone(state.config), configVersion: state.configVersion, dirtyProfileIds, deletedProfileIds };
  }

  if (action === "cancelDuel") {
    const duelId = safeString(payload.duelId, 64);
    const duel = state.duels.find((item) => item.id === duelId && (item.status === "pending" || item.status === "active"));
    if (!duel) return { ok: false, reason: "duel_not_found" };
    cancelDuel(state, duel, now, "moderator_cancelled");
    return { ok: true, reason: "duel_cancelled", duelId, dirtyProfileIds, deletedProfileIds };
  }

  if (action === "resetHealth") {
    for (const duel of state.duels) {
      if (duel.status !== "active") continue;
      for (const userId of [duel.a, duel.b]) {
        duel.hp[userId] = duel.rules.maxHp;
        const p = player(state, userId);
        if (p) {
          p.hp = duel.rules.maxHp;
          p.respawnAt = 0;
        }
      }
      duel.lastActionAt = now;
      duel.cooldowns = {
        [duel.a]: { sharedUntil: 0, strikeUntil: 0, heavyUntil: 0, healUntil: 0 },
        [duel.b]: { sharedUntil: 0, strikeUntil: 0, heavyUntil: 0, healUntil: 0 },
      };
    }
    for (const p of state.players) if (!hasOpenDuel(state, p.userId)) { p.hp = state.config.maxHp; p.respawnAt = 0; }
    addEvent(state, "health_reset", now, { actorId });
    return { ok: true, reason: "health_reset", dirtyProfileIds, deletedProfileIds };
  }

  if (action === "resetRank") {
    const userId = normalizeUserId(payload.userId);
    const p = player(state, userId);
    const stored = event.targetProfile?.userId === userId && event.targetProfile?.registered;
    if (!userId || (!p?.registered && !stored)) return { ok: false, reason: "profile_not_found" };
    if (p) {
      p.elo = state.config.initialElo;
      p.wins = 0;
      p.losses = 0;
    }
    addEvent(state, "rank_reset", now, { actorId, userId });
    return { ok: true, reason: "rank_reset", dirtyProfileIds, deletedProfileIds, rankResetIds: [userId] };
  }

  if (action === "resetAllRanks") {
    for (const p of state.players) {
      if (!p.registered) continue;
      p.elo = state.config.initialElo;
      p.wins = 0;
      p.losses = 0;
      dirtyProfileIds.push(p.userId);
    }
    addEvent(state, "all_ranks_reset", now, { actorId });
    return { ok: true, reason: "all_ranks_reset", dirtyProfileIds, resetAllRanks: true, deletedProfileIds };
  }

  if (action === "resetAll") {
    // CONTRACTS.md: clears players, duels and rematch locks; stored profiles and ranks stay.
    for (const duel of openDuels(state)) cancelDuel(state, duel, now, "moderator_reset");
    state.players = [];
    state.rematchLocks = [];
    addEvent(state, "game_reset", now, { actorId });
    return { ok: true, reason: "game_reset", dirtyProfileIds, resetAllRanks: false, deletedProfileIds };
  }

  if (action === "resetRound") {
    state.round = 0;
    addEvent(state, "round_reset", now, { actorId });
    return { ok: true, reason: "round_reset", round: 0, dirtyProfileIds, deletedProfileIds };
  }

  if (action === "removePlayer") {
    const userId = normalizeUserId(payload.userId);
    if (!userId) return { ok: false, reason: "profile_not_found" };
    for (const duel of openDuels(state).filter((item) => duelHasUser(item, userId))) cancelDuel(state, duel, now, "player_removed");
    state.players = state.players.filter((p) => p.userId !== userId);
    deletedProfileIds.push(userId);
    addEvent(state, "player_removed", now, { actorId, userId });
    return { ok: true, reason: "player_removed", dirtyProfileIds, deletedProfileIds };
  }

  return { ok: false, reason: "unknown_admin_action" };
}

// Results the stream hasn't shown yet: userId -> { elo before the first hidden duel, hidden wins, hidden losses }.
export function hiddenResults(state, now) {
  const out = new Map();
  for (const duel of state.duels) {
    if (duel.status !== "completed" || !(duel.revealAt > now) || !duel.ratings) continue;
    for (const id of [duel.a, duel.b]) {
      const h = out.get(id) || { elo: duel.ratings[id]?.before, wins: 0, losses: 0 };   // duels are in order, so the first is the pre-fight Elo
      if (duel.winnerId === id) h.wins += 1; else h.losses += 1;
      out.set(id, h);
    }
  }
  return out;
}

// A profile as the stream has shown it so far.
export function shownProfile(profile, hidden) {
  const h = profile && hidden.get(profile.userId);
  if (!h || !Number.isInteger(h.elo)) return profile;
  return { ...profile, elo: h.elo, wins: Math.max(0, profile.wins - h.wins), losses: Math.max(0, profile.losses - h.losses) };
}

export function parseGameCommand(text) {
  if (typeof text !== "string") return null;
  // Chat clients append invisible characters (U+E0000 tag chars, U+034F, zero-width spaces) to repeated messages.
  const clean = text.replace(/[\u{E0000}-\u{E007F}\u034F\u180E\u200B-\u200D\u2060\uFEFF]/gu, "").trim();
  const match = /^!(duel|challenge|rematch|accept|fight|decline|attack|strike|heavy|heal)(?:\s+(@?[a-z0-9_]{1,25}))?\s*$/i.exec(clean);
  if (!match) return null;
  let action = match[1].toLowerCase();
  if (action === "challenge") action = "duel";
  if (action === "fight") action = "accept";
  const target = match[2] && action !== "rematch" ? normalizeUsername(match[2]) : "";   // !rematch always means the last opponent
  if (action === "duel" && !target) return null;
  return { action, target };
}

export function applyProfile(state, profile, now) {
  const normalized = {
    ...profile,
    userId: normalizeUserId(profile?.userId),
    username: normalizeUsername(profile?.username),
    displayName: safeString(profile?.displayName || profile?.username, 48),
    avatar: safeString(profile?.avatar || "player", 64),
    color: /^#[0-9a-f]{6}$/i.test(profile?.color || "") ? profile.color.toUpperCase() : "#A78BFA",
    defaultAbility: ABILITIES.has(profile?.defaultAbility) ? profile.defaultAbility : "strike",
    stats: cleanStats(profile?.stats),
    hat: knownHat(profile?.hat) ? profile.hat : "",
    registered: true,
  };
  if (!normalized.userId || !normalized.username) return { ok: false, reason: "invalid_profile" };
  const existing = player(state, normalized.userId);
  const p = existing || defaultProfile(normalized.userId, state.config, now);
  // No respec while a challenge or duel is open: the build counts from when the duel starts to its end.
  if (existing && hasOpenDuel(state, p.userId) && JSON.stringify(cleanStats(p.stats)) !== JSON.stringify(normalized.stats)) return { ok: false, reason: "in_duel" };
  Object.assign(p, {
    username: normalized.username,
    displayName: normalized.displayName,
    avatar: normalized.avatar,
    color: normalized.color,
    defaultAbility: normalized.defaultAbility,
    stats: normalized.stats,
    hat: normalized.hat,
    ...(Number.isInteger(profile?.bonus) ? { bonus: Math.max(0, profile.bonus) } : {}),
    registered: true,
    lastSeen: now,
  });
  if (existing) return { ok: true, profile: p };
  if (state.players.length >= MAX_ACTIVE_PLAYERS) {
    const candidates = state.players.filter((item) => !hasOpenDuel(state, item.userId)).sort((a, b) => a.lastSeen - b.lastSeen);
    if (!candidates.length) return { ok: false, reason: "active_player_cap" };
    state.players.splice(state.players.indexOf(candidates[0]), 1);
  }
  state.players.push(p);
  return { ok: true, profile: p };
}

export function reduceGame(inputState, event, now = Date.now()) {
  const state = normalizeState(inputState);
  const dirtyProfileIds = [];
  const deletedProfileIds = [];
  const rankResetIds = [];
  let resetAllRanks = false;
  let touched = false;
  let result;
  const beforeRevision = state.revision;
  const didExpire = expireState(state, now);

  if (event?.type === "chat_subscription") {
    // A subscription was created or found. Chat counts as connected once Twitch reports it enabled
    // (or once its webhook verification has already arrived; the two can race).
    const subscriptionId = safeString(event.subscriptionId, 100);
    const wasConnected = state.chat.connected;
    let status = safeString(event.status, 64) || "pending";
    if (subscriptionId && subscriptionId === state.chat.verifiedId) status = "enabled";
    state.chat = { ...state.chat, subscriptionId, status, connected: status === "enabled", createdAt: Number.isFinite(event.createdAt) ? event.createdAt : now, revokedReason: "", checkedAt: now, verifiedId: "" };
    if (state.chat.connected && !wasConnected) addEvent(state, "chat_connected", now);
    else touched = true;
    result = { ok: true, reason: state.chat.connected ? "chat_connected" : "chat_pending", status };
  } else if (event?.type === "chat_verified") {
    const subscriptionId = safeString(event.subscriptionId, 100);
    if (!subscriptionId) result = { ok: false, reason: "invalid_event" };
    else if (subscriptionId !== state.chat.subscriptionId) {
      state.chat.verifiedId = subscriptionId;   // verification beat the create response
      touched = true;
      result = { ok: true, reason: "chat_verified_early" };
    } else if (!state.chat.connected) {
      state.chat = { ...state.chat, status: "enabled", connected: true, revokedReason: "" };
      addEvent(state, "chat_connected", now);
      result = { ok: true, reason: "chat_connected" };
    } else result = { ok: true, reason: "no_change" };
  } else if (event?.type === "chat_checked") {
    state.chat.checkedAt = now;
    touched = true;
    result = { ok: true, reason: "chat_checked" };
  } else if (event?.type === "chat_disconnected") {
    const reason = safeString(event.reason, 64) || "disconnected";
    for (const duel of openDuels(state)) cancelDuel(state, duel, now, "chat_disconnected");
    state.chat = { ...state.chat, connected: false, status: reason === "disconnected" ? "disconnected" : reason, subscriptionId: "", revokedReason: reason === "disconnected" ? "" : reason, checkedAt: now, verifiedId: "" };
    addEvent(state, "chat_disconnected", now, { reason });
    result = { ok: true, reason: "chat_disconnected" };
  } else if (event?.type === "command_rejected") {
    addEvent(state, "command_rejected", now, { userId: normalizeUserId(event.userId), command: safeString(event.command, 16) || "other", reason: safeString(event.reason, 64), ...(Number(event.retryAt) > 0 ? { retryAt: Number(event.retryAt) } : {}) });
    result = { ok: true, reason: "logged" };
  } else if (event?.type === "presence") {
    const userId = normalizeUserId(event.userId);
    const p = recentProfile(state, event.profile ? { ...event.profile, userId, username: event.username || event.profile.username, displayName: event.displayName || event.profile.displayName } : {
      userId, username: event.username, displayName: event.displayName,
    }, now);
    if (p) {
      result = { ok: true, reason: "presence_updated", userId };
      addEvent(state, "player_seen", now, { userId });
    } else result = { ok: false, reason: "active_player_cap" };
  } else if (event?.type === "command") {
    const dedupe = addRecent(state, event, now);
    if (!dedupe.ok) result = { ok: false, reason: dedupe.reason };
    else if (!state.chat.connected) result = { ok: false, reason: "chat_offline" };
    else if (!Number.isFinite(event.timestamp) || now - event.timestamp > 60_000 || event.timestamp - now > 10_000) result = { ok: false, reason: "stale_command" };
    else {
      const userId = normalizeUserId(event.userId);
      const parsed = parseGameCommand(event.text);
      const actor = recentProfile(state, event.profile ? { ...event.profile, userId, username: event.username || event.profile.username, displayName: event.displayName || event.profile.displayName } : {
        userId, username: event.username, displayName: event.displayName,
      }, now);
      let targetProfile = event.targetProfile;
      if (parsed?.target && targetProfile) targetProfile = { ...targetProfile, username: normalizeUsername(targetProfile.username) };
      result = actor ? applyCommand(state, { ...event, userId, profile: actor, targetProfile }, now) : { ok: false, reason: "active_player_cap" };
      if (actor) {
        actor.lastSeen = now;
        addEvent(state, "command_seen", now, { userId, command: parsed?.action || "other" });
      }
    }
  } else if (event?.type === "profile_saved") {
    const applied = applyProfile(state, event.profile || {}, now);
    result = applied;
    if (applied.ok) {
      dirtyProfileIds.push(applied.profile.userId);
      addEvent(state, "profile_saved", now, { userId: applied.profile.userId });
    }
  } else if (event?.type === "admin") {
    result = applyAdmin(state, event, now);
    if (result?.dirtyProfileIds) dirtyProfileIds.push(...result.dirtyProfileIds);
    if (result?.deletedProfileIds) deletedProfileIds.push(...result.deletedProfileIds);
    if (result?.rankResetIds) rankResetIds.push(...result.rankResetIds);
    resetAllRanks = Boolean(result?.resetAllRanks);
  } else if (event?.type === "tick") {
    result = { ok: true, reason: didExpire ? "state_advanced" : "no_change" };
  } else {
    result = { ok: false, reason: "unknown_event" };
  }

  // changed: state must be persisted. visible: overlays should receive a new snapshot.
  const visible = state.revision !== beforeRevision || didExpire;
  const changed = visible || touched;
  return { state, result, changed, visible, dirtyProfileIds: [...new Set(dirtyProfileIds)], deletedProfileIds: [...new Set(deletedProfileIds)], rankResetIds: [...new Set(rankResetIds)], resetAllRanks };
}

function normalizeState(input) {
  const initial = createInitialState(input?.channel || "nesszerra");
  // Deep copy so the reducer never mutates its input.
  const state = { ...initial, ...(input && typeof input === "object" ? clone(input) : {}) };
  state.channel = safeString(state.channel, 25).toLowerCase() || "nesszerra";
  state.revision = Number.isInteger(state.revision) && state.revision >= 0 ? state.revision : 0;
  state.chat = { ...initial.chat, ...(state.chat && typeof state.chat === "object" ? state.chat : {}) };
  delete state.relay;
  state.config = normalizeConfig(state.config);
  if (state.configVersion === 1 && JSON.stringify(state.config) === JSON.stringify(normalizeConfig(LEGACY_CONFIG))) state.config = clone(DEFAULT_CONFIG);
  state.players = Array.isArray(state.players) ? state.players.filter((p) => p && typeof p.userId === "string").slice(-MAX_ACTIVE_PLAYERS) : [];
  state.duels = Array.isArray(state.duels) ? state.duels : [];
  state.rematchLocks = Array.isArray(state.rematchLocks) ? state.rematchLocks : [];
  state.events = Array.isArray(state.events) ? state.events.slice(-MAX_RECENT_EVENTS) : [];
  state.appliedMessageIds = Array.isArray(state.appliedMessageIds) ? state.appliedMessageIds.slice(-MAX_APPLIED_MESSAGE_IDS) : [];
  state.nextDuelId = Number.isInteger(state.nextDuelId) && state.nextDuelId > 0 ? state.nextDuelId : 1;
  state.configVersion = Number.isInteger(state.configVersion) && state.configVersion > 0 ? state.configVersion : 1;
  state.round = Number.isInteger(state.round) && state.round >= 0 ? state.round : 0;
  return state;
}

// Stored state as the reducer sees it (defaults filled in, old presets migrated), for read-only views.
export function normalizeGameState(input) {
  return normalizeState(input);
}

export function defaultConfig() {
  return clone(DEFAULT_CONFIG);
}

// Admin and diagnostics view of the chat source (see CONTRACTS.md, chatStatus).
export function chatStatus(state) {
  const chat = state.chat || {};
  return {
    connected: Boolean(chat.connected),
    source: String(chat.subscriptionId || "").startsWith("se-") ? "streamelements" : chat.subscriptionId ? "twitch" : "",
    status: String(chat.status || "disconnected"),
    subscriptionId: String(chat.subscriptionId || ""),
    createdAt: Number(chat.createdAt) || 0,
    lastNotificationAt: Number(chat.lastSeen) || 0,
    lastRevocationReason: String(chat.revokedReason || ""),
    checkedAt: Number(chat.checkedAt) || 0,
  };
}
