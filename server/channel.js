import { DurableObject } from "cloudflare:workers";
import {
  applyProfile,
  createInitialState,
  defaultConfig,
  parseGameCommand,
  reduceGame,
} from "./game.js";

const INTERNAL_HEADER = "X-Mini-Internal";
const CHANNEL_HEADER = "X-Mini-Channel";
const USER_HEADER = "X-Mini-User-Id";
const MAX_RELAY_MESSAGE_BYTES = 4 * 1024;
const MAX_PROFILE_ID_LENGTH = 64;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function text(value, status = 200) {
  return new Response(value, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function normalizeChannel(value) {
  const channel = String(value || "").trim().toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(channel) ? channel : "";
}

function validUserId(value) {
  const id = String(value ?? "").trim();
  return id.length > 0 && id.length <= MAX_PROFILE_ID_LENGTH && /^[a-zA-Z0-9_:-]+$/.test(id) ? id : "";
}

function normalizeUsername(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase().slice(0, 25);
}

function normalizeProfileRow(row, config) {
  if (!row) return null;
  return {
    userId: String(row.user_id),
    username: String(row.username || ""),
    displayName: String(row.display_name || row.username || ""),
    avatar: String(row.avatar || "player"),
    color: String(row.color || "#A78BFA"),
    defaultAbility: String(row.default_ability || "strike"),
    hp: config.maxHp,
    elo: Number.isInteger(row.elo) ? row.elo : config.initialElo,
    wins: Number.isInteger(row.wins) ? row.wins : 0,
    losses: Number.isInteger(row.losses) ? row.losses : 0,
    lastSeen: Number.isInteger(row.last_seen) ? row.last_seen : 0,
    registered: true,
    respawnAt: 0,
  };
}

function safeJsonParse(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export class ChannelRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS game_state (id INTEGER PRIMARY KEY CHECK (id = 1), channel TEXT NOT NULL, document TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL, avatar TEXT NOT NULL, color TEXT NOT NULL, default_ability TEXT NOT NULL, elo INTEGER NOT NULL, wins INTEGER NOT NULL, losses INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0)");
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_ci ON profiles(username COLLATE NOCASE)");
  }

  async fetch(request) {
    if (!this.authorized(request)) return json({ error: "internal authorization required" }, 403);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const channel = this.requestChannel(request);
    if (!channel) return json({ error: "invalid or missing channel" }, 400);
    const stored = this.readStoredState();
    if (stored && stored.channel !== channel) return json({ error: "channel binding mismatch" }, 409);

    if (path === "/state" && request.method === "GET") {
      const changed = this.advance(channel, { type: "tick" }, Date.now());
      if (changed.changed) {
        this.broadcast(changed.state);
        await this.scheduleAlarm(changed.state);
      }
      return json(this.publicState(changed.state));
    }

    if (path === "/leaderboard" && request.method === "GET") {
      return json(this.leaderboard(channel));
    }

    if (path === "/profile" && request.method === "GET") {
      const userId = validUserId(url.searchParams.get("userId"));
      if (!userId) return json({ error: "valid userId required" }, 400);
      const state = this.readState(channel);
      const profile = this.getProfile(userId, state.config);
      if (!profile) return json(null);
      const active = state.players.find((item) => item.userId === userId);
      return json(active ? { ...profile, hp: active.hp, lastSeen: active.lastSeen, respawnAt: active.respawnAt } : profile);
    }

    if (path === "/profile" && request.method === "POST") {
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      const actorId = validUserId(request.headers.get(USER_HEADER));
      const requestedId = validUserId(body.value.userId);
      if (!actorId || !requestedId || actorId !== requestedId) return json({ error: "profile identity mismatch" }, 403);
      const result = this.saveProfile(channel, actorId, body.value);
      if (!result.ok) return json({ error: result.reason }, result.status || 400);
      this.broadcast(result.state);
      await this.scheduleAlarm(result.state);
      return json({ profile: result.profile, revision: result.state.revision });
    }

    if (path === "/admin" && request.method === "POST") {
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      const actorId = validUserId(body.value.actorId);
      if (!actorId) return json({ error: "authorized actor required" }, 403);
      const payload = body.value.payload && typeof body.value.payload === "object" ? body.value.payload : body.value;
      const targetId = validUserId(payload.userId);
      const targetProfile = targetId ? this.getProfile(targetId, this.readState(channel).config) : null;
      const event = { type: "admin", actorId, action: body.value.action, payload, targetProfile };
      const result = this.advance(channel, event, Date.now());
      if (!result.result.ok) return json(result.result, result.result.reason === "unauthorized" ? 403 : 400);
      if (result.result.resetAllRanks) this.resetAllRanks(result.state.config.initialElo);
      for (const userId of result.dirtyProfileIds) {
        const profile = result.state.players.find((item) => item.userId === userId);
        if (profile?.registered) this.upsertProfile(profile);
      }
      for (const userId of result.deletedProfileIds) this.deleteProfile(userId);
      this.broadcast(result.state);
      await this.scheduleAlarm(result.state);
      return json({ ...result.result, revision: result.state.revision });
    }

    if (path === "/catalog" && request.method === "GET") return json([]);

    if (path === "/live" && request.method === "GET") return this.upgrade(request, "live", channel);
    if (path === "/relay" && request.method === "GET") return this.upgrade(request, "relay", channel);

    return text("Not found", 404);
  }

  authorized(request) {
    const expected = this.env.INTERNAL_SECRET;
    const received = request.headers.get(INTERNAL_HEADER);
    if (typeof expected !== "string" || expected.length < 16) return false;
    return timingSafeEqual(received, expected);
  }

  requestChannel(request) {
    return normalizeChannel(request.headers.get(CHANNEL_HEADER) || this.env.CHANNEL_NAME || "nesszerra");
  }

  readStoredState() {
    const row = this.ctx.storage.sql.exec("SELECT channel, document FROM game_state WHERE id = 1").toArray()[0];
    if (!row) return null;
    return safeJsonParse(row.document, null);
  }

  readState(channel) {
    const stored = this.readStoredState();
    if (!stored) return createInitialState(channel);
    return { ...createInitialState(channel), ...stored, channel };
  }

  writeState(state) {
    this.ctx.storage.sql.exec(
      "INSERT INTO game_state (id, channel, document) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET channel = excluded.channel, document = excluded.document",
      state.channel,
      JSON.stringify(state),
    );
  }

  advance(channel, event, now) {
    return this.ctx.storage.transactionSync(() => {
      const state = this.readState(channel);
      const result = reduceGame(state, event, now);
      if (result.changed) this.writeState(result.state);
      for (const userId of result.dirtyProfileIds) {
        const profile = result.state.players.find((item) => item.userId === userId);
        if (profile?.registered) this.upsertProfile(profile);
      }
      if (result.resetAllRanks) this.resetAllRanks(result.state.config.initialElo);
      return result;
    });
  }

  async readJson(request) {
    const length = Number(request.headers.get("content-length") || 0);
    if (length > 16 * 1024) return { ok: false, error: "request body too large" };
    try {
      const value = await request.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "JSON object required" };
      return { ok: true, value };
    } catch {
      return { ok: false, error: "invalid JSON" };
    }
  }

  saveProfile(channel, userId, input) {
    const username = normalizeUsername(input.username);
    const displayName = String(input.displayName || username).trim().slice(0, 48);
    const avatar = String(input.avatar || "player").trim().slice(0, 64);
    const color = /^#[0-9a-f]{6}$/i.test(input.color || "") ? input.color.toUpperCase() : "";
    const defaultAbility = ["strike", "heavy", "heal"].includes(input.defaultAbility) ? input.defaultAbility : "";
    if (!username || !/^[a-z0-9_]{1,25}$/.test(username) || !displayName || !avatar || !color || !defaultAbility) {
      return { ok: false, reason: "invalid_profile" };
    }

    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      const state = this.readState(channel);
      const existing = this.getProfile(userId, state.config);
      const profile = {
        ...(existing || {
          userId,
          username,
          displayName,
          avatar,
          color,
          defaultAbility,
          hp: state.config.maxHp,
          elo: state.config.initialElo,
          wins: 0,
          losses: 0,
          lastSeen: 0,
          registered: true,
          respawnAt: 0,
        }),
        userId,
        username,
        displayName,
        avatar,
        color,
        defaultAbility,
        registered: true,
      };
      const result = reduceGame(state, { type: "profile_saved", profile }, now);
      if (!result.result.ok) return { ok: false, reason: result.result.reason, status: 400 };
      this.writeState(result.state);
      const active = result.state.players.find((item) => item.userId === userId);
      this.upsertProfile(active || profile);
      return { ok: true, profile: active || profile, state: result.state };
    });
  }

  getProfile(userId, config) {
    const row = this.ctx.storage.sql.exec(
      "SELECT user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen FROM profiles WHERE user_id = ?",
      userId,
    ).toArray()[0];
    return normalizeProfileRow(row, config);
  }

  getProfileByUsername(username, config) {
    const name = normalizeUsername(username);
    if (!name) return null;
    const row = this.ctx.storage.sql.exec(
      "SELECT user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen FROM profiles WHERE username = ? COLLATE NOCASE",
      name,
    ).toArray()[0];
    return normalizeProfileRow(row, config);
  }

  upsertProfile(profile) {
    this.ctx.storage.sql.exec(
      "INSERT INTO profiles (user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name, avatar = excluded.avatar, color = excluded.color, default_ability = excluded.default_ability, elo = excluded.elo, wins = excluded.wins, losses = excluded.losses, last_seen = excluded.last_seen",
      profile.userId,
      profile.username,
      profile.displayName,
      profile.avatar,
      profile.color,
      profile.defaultAbility,
      profile.elo,
      profile.wins,
      profile.losses,
      Number.isInteger(profile.lastSeen) ? profile.lastSeen : 0,
    );
  }

  deleteProfile(userId) {
    this.ctx.storage.sql.exec("DELETE FROM profiles WHERE user_id = ?", userId);
  }

  resetAllRanks(initialElo) {
    this.ctx.storage.sql.exec("UPDATE profiles SET elo = ?, wins = 0, losses = 0", initialElo);
  }

  leaderboard(channel) {
    const state = this.readState(channel);
    const rows = this.ctx.storage.sql.exec(
      "SELECT user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen FROM profiles ORDER BY elo DESC, wins DESC, username COLLATE NOCASE ASC LIMIT 100",
    ).toArray();
    return rows.map((row) => {
      const profile = normalizeProfileRow(row, state.config);
      const active = state.players.find((item) => item.userId === profile.userId);
      return active ? { ...profile, hp: active.hp, lastSeen: active.lastSeen, respawnAt: active.respawnAt } : profile;
    });
  }

  publicState(state) {
    return {
      channel: state.channel,
      revision: state.revision,
      relay: { connected: Boolean(state.relay.connected), lastSeen: Number(state.relay.lastSeen) || 0 },
      config: state.config,
      players: state.players.map((profile) => ({ ...profile })),
      duels: state.duels.map((duel) => ({ ...duel })),
      events: state.events.slice(-50).map((event) => ({ ...event })),
    };
  }

  async upgrade(request, kind, channel) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "websocket upgrade required" }, 426);
    if (kind === "relay") {
      for (const ws of this.ctx.getWebSockets("relay")) {
        try { ws.close(4001, "Relay replaced"); } catch {}
      }
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const sessionId = kind === "relay" ? crypto.randomUUID() : "";
    this.ctx.acceptWebSocket(server, [kind]);
    server.serializeAttachment({ kind, sessionId, channel });
    if (kind === "relay") {
      const result = this.advance(channel, { type: "relay_connected", sessionId }, Date.now());
      this.broadcast(result.state);
      await this.scheduleAlarm(result.state);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment() || {};
    if (attachment.kind === "live") {
      try { ws.close(1008, "Read-only socket"); } catch {}
      return;
    }
    if (attachment.kind !== "relay") {
      try { ws.close(1008, "Unknown socket"); } catch {}
      return;
    }
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (new TextEncoder().encode(raw).byteLength > MAX_RELAY_MESSAGE_BYTES) {
      try { ws.close(1009, "Message too large"); } catch {}
      return;
    }
    let payload;
    try { payload = JSON.parse(raw); } catch {
      try { ws.close(1007, "Invalid JSON"); } catch {}
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      try { ws.close(1007, "Invalid message"); } catch {}
      return;
    }

    const channel = normalizeChannel(attachment.channel);
    const sessionId = String(attachment.sessionId || "");
    if (!channel || !sessionId) {
      try { ws.close(1008, "Invalid relay session"); } catch {}
      return;
    }

    let result;
    if (payload.type === "heartbeat") {
      result = this.advance(channel, {
        type: "relay_heartbeat",
        sessionId,
        twitchConnected: payload.twitchConnected === true,
      }, Date.now());
      if (payload.twitchConnected !== true) {
        try { ws.close(1012, "Twitch disconnected"); } catch {}
      }
    } else if (payload.type === "offline") {
      result = this.advance(channel, { type: "relay_offline", sessionId }, Date.now());
      try { ws.close(1000, "Relay offline"); } catch {}
    } else if (payload.type === "presence" || payload.type === "command") {
      result = this.processRelayEvent(channel, sessionId, payload);
    } else {
      try { ws.close(1008, "Unknown relay message"); } catch {}
      return;
    }

    if (result?.changed) this.broadcast(result.state);
    if (result?.changed || payload.type === "heartbeat" || payload.type === "offline") {
      await this.scheduleAlarm(result.state);
    }
  }

  processRelayEvent(channel, sessionId, payload) {
    const userId = validUserId(payload.userId);
    const username = normalizeUsername(payload.username);
    const displayName = String(payload.displayName || username).trim().slice(0, 48);
    const timestamp = Number(payload.timestamp);
    if (!userId || !username || !Number.isFinite(timestamp) || !displayName) {
      return this.advance(channel, { type: "tick" }, Date.now());
    }

    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      const state = this.readState(channel);
      if (!state.relay.connected || state.relay.sessionId !== sessionId || now - state.relay.lastSeen > state.config.relayLeaseMs) {
        const ticked = reduceGame(state, { type: "tick" }, now);
        if (ticked.changed) this.writeState(ticked.state);
        return { ...ticked, result: { ok: false, reason: "relay_offline" } };
      }

      const userProfile = this.getProfile(userId, state.config);
      const profile = userProfile ? { ...userProfile, username, displayName } : null;
      let targetProfile = null;
      if (payload.type === "command") {
        const parsed = parseGameCommand(payload.text);
        if (parsed?.target) targetProfile = this.getProfileByUsername(parsed.target, state.config);
      }

      const event = {
        type: payload.type,
        messageId: payload.messageId,
        userId,
        username,
        displayName,
        text: String(payload.text || "").slice(0, 512),
        timestamp,
        profile,
        targetProfile,
      };
      const result = reduceGame(state, event, now);
      if (result.changed) this.writeState(result.state);

      const updated = result.state.players.find((item) => item.userId === userId);
      if (updated?.registered && userProfile && (updated.username !== userProfile.username || updated.displayName !== userProfile.displayName)) {
        this.upsertProfile(updated);
      }
      if (result.result?.reason === "duel_completed") {
        const duel = result.state.duels.find((item) => item.id === result.result.duelId);
        if (duel) {
          for (const id of [duel.a, duel.b]) {
            const participant = result.state.players.find((item) => item.userId === id);
            if (participant?.registered) this.upsertProfile(participant);
          }
        }
      }
      return result;
    });
  }

  async webSocketClose(ws) {
    const attachment = ws.deserializeAttachment() || {};
    if (attachment.kind !== "relay") return;
    const channel = normalizeChannel(attachment.channel);
    const sessionId = String(attachment.sessionId || "");
    if (!channel || !sessionId) return;
    const result = this.advance(channel, { type: "relay_offline", sessionId }, Date.now());
    if (result.changed) this.broadcast(result.state);
    await this.scheduleAlarm(result.state);
  }

  async webSocketError(ws) {
    try { ws.close(1011, "Socket error"); } catch {}
  }

  broadcast(state) {
    const message = JSON.stringify(this.publicState(state));
    for (const ws of this.ctx.getWebSockets("live")) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try { ws.send(message); } catch {}
    }
  }

  async scheduleAlarm(state) {
    const due = [];
    if (state.relay.connected) due.push(state.relay.lastSeen + state.config.relayLeaseMs + 1);
    for (const duel of state.duels) {
      if (duel.status === "pending") due.push(duel.expiresAt + 1);
      else if (duel.status === "active") due.push(duel.lastActionAt + (duel.rules?.inactivityMs || state.config.inactivityMs) + 1);
    }
    for (const profile of state.players) if (profile.respawnAt > 0) due.push(profile.respawnAt);
    for (const lock of state.rematchLocks) due.push(lock.until);
    if (due.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...due)));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const row = this.readStoredState();
    if (!row) return;
    const channel = normalizeChannel(row.channel);
    if (!channel) return;
    const result = this.advance(channel, { type: "tick" }, Date.now());
    if (result.changed) this.broadcast(result.state);
    await this.scheduleAlarm(result.state);
  }
}
