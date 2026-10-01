const DEFAULT_CONFIG = {
  enabled: true,
  maxHp: 100,
  maxDuels: 5,
  challengeTimeoutMs: 30_000,
  inactivityMs: 60_000,
  respawnMs: 3_000,
  rematchDelayMs: 30_000,
  sharedCooldownMs: 1_000,
  relayLeaseMs: 30_000,
  initialElo: 1_000,
  eloK: 24,
  abilities: {
    strike: { damage: 10, cooldownMs: 3_000 },
    heavy: { damage: 25, cooldownMs: 8_000 },
    heal: { amount: 15, cooldownMs: 10_000 },
  },
};

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
    else if (!Number.isInteger(merged[key])) merged[key] = value;
  }
  for (const [name, defaults] of Object.entries(DEFAULT_CONFIG.abilities)) {
    const candidate = merged.abilities[name] ?? {};
    merged.abilities[name] = {};
    for (const [key, value] of Object.entries(defaults)) {
      merged.abilities[name][key] = Number.isInteger(candidate[key]) ? candidate[key] : value;
    }
  }
  return merged;
}

export function createInitialState(channel = "nesszerra") {
  return {
    channel: safeString(channel, 25).toLowerCase() || "nesszerra",
    revision: 0,
    relay: { connected: false, socketConnected: false, lastSeen: 0, sessionId: "" },
    config: clone(DEFAULT_CONFIG),
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
  if (Number.isInteger(profile.hp) && profile.registered) merged.hp = Math.min(state.config.maxHp, Math.max(0, profile.hp));
  if (Number.isInteger(profile.respawnAt)) merged.respawnAt = profile.respawnAt;
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

function cancelDuel(state, duel, now, reason) {
  if (duel.status !== "pending" && duel.status !== "active") return false;
  duel.status = "cancelled";
  duel.endedAt = now;
  duel.cancelReason = reason;
  duel.winnerId = null;
  if (duel.status === "active" || duel.hp) {
    for (const userId of [duel.a, duel.b]) {
      const p = player(state, userId);
      if (p) {
        p.hp = 0;
        p.respawnAt = now + state.config.respawnMs;
      }
    }
  }
  addEvent(state, "duel_cancelled", now, { duelId: duel.id, reason });
  return true;
}

function expireState(state, now) {
  let changed = false;
  state.config = normalizeConfig(state.config);

  if (state.relay.connected && now - state.relay.lastSeen > state.config.relayLeaseMs) {
    state.relay.connected = false;
    state.relay.socketConnected = false;
    addEvent(state, "relay_stale", now);
    for (const duel of openDuels(state)) cancelDuel(state, duel, now, "relay_disconnected");
    changed = true;
  }

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
      changed = true;
    }
  }

  state.rematchLocks = state.rematchLocks.filter((lock) => lock.until > now);
  const inDuel = new Set(openDuels(state).flatMap((duel) => [duel.a, duel.b]));
  const before = state.players.length;
  state.players = state.players.filter((p) => inDuel.has(p.userId) || p.respawnAt > now || now - p.lastSeen <= ACTIVE_TTL_MS);
  if (state.players.length !== before) changed = true;

  const terminal = state.duels.filter((duel) => duel.status === "completed" || duel.status === "cancelled" || duel.status === "expired");
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
  if (actor.respawnAt > now || target.respawnAt > now) return { ok: false, reason: "respawning" };
  if (openDuels(state).length >= state.config.maxDuels) return { ok: false, reason: "channel_full" };
  const lock = state.rematchLocks.find((item) => item.pair === pairKey(actor.userId, target.userId) && item.until > now);
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
  addEvent(state, "duel_started", now, { duelId: duel.id, a: duel.a, b: duel.b, hp: clone(duel.hp) });
  return { ok: true, duelId: duel.id };
}

function finishDuel(state, duel, winnerId, now) {
  const a = player(state, duel.a);
  const b = player(state, duel.b);
  if (!a || !b) return;
  const ratingA = a.elo;
  const ratingB = b.elo;
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const scoreA = winnerId === duel.a ? 1 : 0;
  const nextA = Math.round(ratingA + state.config.eloK * (scoreA - expectedA));
  const nextB = Math.round(ratingB + state.config.eloK * ((1 - scoreA) - (1 - expectedA)));
  a.elo = nextA;
  b.elo = nextB;
  if (winnerId === duel.a) {
    a.wins += 1;
    b.losses += 1;
  } else {
    b.wins += 1;
    a.losses += 1;
  }
  a.hp = duel.hp[duel.a];
  b.hp = duel.hp[duel.b];
  a.respawnAt = now + duel.rules.respawnMs;
  b.respawnAt = now + duel.rules.respawnMs;
  duel.status = "completed";
  duel.winnerId = winnerId;
  duel.endedAt = now;
  duel.ratings = {
    [duel.a]: { before: ratingA, after: nextA, delta: nextA - ratingA },
    [duel.b]: { before: ratingB, after: nextB, delta: nextB - ratingB },
  };
  state.rematchLocks.push({
    pair: pairKey(duel.a, duel.b),
    until: now + duel.rules.rematchDelayMs,
  });
  addEvent(state, "duel_completed", now, {
    duelId: duel.id,
    winnerId,
    loserId: winnerId === duel.a ? duel.b : duel.a,
    ratings: clone(duel.ratings),
  });
}

function applyAbility(state, duel, actor, abilityName, now) {
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
    duel.hp[targetId] = Math.max(0, before - ability.damage);
    amount = before - duel.hp[targetId];
  }
  cooldown.sharedUntil = now + duel.rules.sharedCooldownMs;
  cooldown[abilityUntilKey] = now + ability.cooldownMs;
  duel.lastActionAt = now;
  actor.lastSeen = now;
  actor.hp = duel.hp[actor.userId];
  const target = player(state, targetId);
  if (target) target.hp = duel.hp[targetId];

  if (duel.hp[targetId] <= 0) {
    finishDuel(state, duel, actor.userId, now);
    return { ok: true, reason: "duel_completed", duelId: duel.id, ability: abilityName, amount, winnerId: actor.userId };
  }
  addEvent(state, "duel_action", now, { duelId: duel.id, userId: actor.userId, targetId: abilityName === "heal" ? actor.userId : targetId, ability: abilityName, amount, hp: clone(duel.hp) });
  return { ok: true, reason: "action_applied", duelId: duel.id, ability: abilityName, amount };
}

function applyCommand(state, event, now) {
  const parsed = parseGameCommand(event.text);
  if (!parsed) return { ok: false, reason: "not_game_command" };
  const userId = normalizeUserId(event.userId);
  const actor = registeredPlayer(state, userId, event, now);
  if (!actor) return { ok: false, reason: "ranked_sign_in_required" };

  if (parsed.action === "duel") {
    const username = normalizeUsername(parsed.target);
    if (!username) return { ok: false, reason: "target_required" };
    const target = findTargetProfile(state, event, username, now);
    if (!target) return { ok: false, reason: "target_not_found" };
    if (!target.registered) return { ok: false, reason: "ranked_sign_in_required" };
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
    return beginDuel(state, duel, now);
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
    sharedCooldownMs: [250, 60_000],
    relayLeaseMs: [10_000, 120_000],
    initialElo: [0, 10_000],
    eloK: [1, 100],
  };
  for (const key of Object.keys(patch)) {
    if (key === "enabled") {
      if (typeof patch.enabled !== "boolean") return { ok: false, reason: "invalid_config_enabled" };
      out.enabled = patch.enabled;
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
    const patchResult = validateConfigPatch(payload.patch || payload.config || payload);
    if (!patchResult.ok) return patchResult;
    const config = { ...state.config };
    for (const [key, value] of Object.entries(patchResult.patch)) {
      if (key === "abilities") {
        config.abilities = { ...config.abilities };
        for (const [name, spec] of Object.entries(value)) config.abilities[name] = { ...config.abilities[name], ...spec };
      } else config[key] = value;
    }
    state.config = normalizeConfig(config);
    if (!state.config.enabled) {
      for (const duel of openDuels(state)) cancelDuel(state, duel, now, "duels_disabled");
    }
    addEvent(state, "config_updated", now, { actorId, config: clone(state.config) });
    return { ok: true, reason: "config_updated", config: clone(state.config), dirtyProfileIds, deletedProfileIds };
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
    if (!userId || !p?.registered) return { ok: false, reason: "profile_not_found" };
    p.elo = state.config.initialElo;
    p.wins = 0;
    p.losses = 0;
    dirtyProfileIds.push(userId);
    addEvent(state, "rank_reset", now, { actorId, userId });
    return { ok: true, reason: "rank_reset", dirtyProfileIds, deletedProfileIds };
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
    for (const duel of openDuels(state)) cancelDuel(state, duel, now, "moderator_reset");
    for (const p of state.players) {
      p.hp = state.config.maxHp;
      p.respawnAt = 0;
    }
    addEvent(state, "game_reset", now, { actorId });
    return { ok: true, reason: "game_reset", dirtyProfileIds, resetAllRanks: false, deletedProfileIds };
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

export function parseGameCommand(text) {
  if (typeof text !== "string") return null;
  const match = /^!(duel|challenge|accept|decline|attack|strike|heavy|heal)(?:\s+(@?[a-z0-9_]{1,25}))?\s*$/i.exec(text.trim());
  if (!match) return null;
  let action = match[1].toLowerCase();
  if (action === "challenge") action = "duel";
  const target = match[2] ? normalizeUsername(match[2]) : "";
  if (action === "duel" && !target) return null;
  if (["strike", "heavy", "heal", "accept", "decline"].includes(action) && target) {
    return { action, target };
  }
  if (["strike", "heavy", "heal"].includes(action) && target) return null;
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
    registered: true,
  };
  if (!normalized.userId || !normalized.username) return { ok: false, reason: "invalid_profile" };
  const existing = player(state, normalized.userId);
  const p = existing || defaultProfile(normalized.userId, state.config, now);
  Object.assign(p, {
    username: normalized.username,
    displayName: normalized.displayName,
    avatar: normalized.avatar,
    color: normalized.color,
    defaultAbility: normalized.defaultAbility,
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
  let resetAllRanks = false;
  let result;
  const beforeRevision = state.revision;
  const didExpire = expireState(state, now);

  if (event?.type === "relay_connected") {
    const sessionId = safeString(event.sessionId, 100);
    state.relay.socketConnected = true;
    state.relay.connected = false;
    state.relay.sessionId = sessionId;
    addEvent(state, "relay_connected", now);
    result = { ok: true, reason: "relay_connected" };
  } else if (event?.type === "relay_heartbeat") {
    if (event.sessionId && state.relay.sessionId && event.sessionId !== state.relay.sessionId) {
      result = { ok: false, reason: "stale_relay_session" };
    } else if (event.twitchConnected !== true) {
      state.relay.connected = false;
      state.relay.lastSeen = now;
      for (const duel of openDuels(state)) cancelDuel(state, duel, now, "twitch_disconnected");
      addEvent(state, "twitch_disconnected", now);
      result = { ok: true, reason: "twitch_disconnected" };
    } else {
      const wasConnected = state.relay.connected;
      state.relay.connected = true;
      state.relay.socketConnected = true;
      state.relay.lastSeen = now;
      if (!wasConnected) addEvent(state, "twitch_connected", now);
      else addEvent(state, "relay_heartbeat", now);
      result = { ok: true, reason: "heartbeat" };
    }
  } else if (event?.type === "relay_offline") {
    if (event.sessionId && state.relay.sessionId && event.sessionId !== state.relay.sessionId) {
      result = { ok: false, reason: "stale_relay_session" };
    } else {
      state.relay.connected = false;
      state.relay.socketConnected = false;
      state.relay.lastSeen = now;
      for (const duel of openDuels(state)) cancelDuel(state, duel, now, "relay_disconnected");
      addEvent(state, "relay_disconnected", now);
      result = { ok: true, reason: "relay_disconnected" };
    }
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
    else if (!state.relay.connected || now - state.relay.lastSeen > state.config.relayLeaseMs) result = { ok: false, reason: "relay_offline" };
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
    resetAllRanks = Boolean(result?.resetAllRanks);
  } else if (event?.type === "tick") {
    result = { ok: true, reason: didExpire ? "state_advanced" : "no_change" };
  } else {
    result = { ok: false, reason: "unknown_event" };
  }

  const changed = state.revision !== beforeRevision || didExpire;
  return { state, result, changed, dirtyProfileIds: [...new Set(dirtyProfileIds)], resetAllRanks };
}

function normalizeState(input) {
  const initial = createInitialState(input?.channel || "nesszerra");
  const state = { ...initial, ...(input && typeof input === "object" ? input : {}) };
  state.channel = safeString(state.channel, 25).toLowerCase() || "nesszerra";
  state.revision = Number.isInteger(state.revision) && state.revision >= 0 ? state.revision : 0;
  state.relay = { ...initial.relay, ...(state.relay && typeof state.relay === "object" ? state.relay : {}) };
  state.config = normalizeConfig(state.config);
  state.players = Array.isArray(state.players) ? state.players.filter((p) => p && typeof p.userId === "string").slice(-MAX_ACTIVE_PLAYERS) : [];
  state.duels = Array.isArray(state.duels) ? state.duels : [];
  state.rematchLocks = Array.isArray(state.rematchLocks) ? state.rematchLocks : [];
  state.events = Array.isArray(state.events) ? state.events.slice(-MAX_RECENT_EVENTS) : [];
  state.appliedMessageIds = Array.isArray(state.appliedMessageIds) ? state.appliedMessageIds.slice(-MAX_APPLIED_MESSAGE_IDS) : [];
  state.nextDuelId = Number.isInteger(state.nextDuelId) && state.nextDuelId > 0 ? state.nextDuelId : 1;
  return state;
}

export function defaultConfig() {
  return clone(DEFAULT_CONFIG);
}
