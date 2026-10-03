import { DurableObject } from "cloudflare:workers";
import {
  applyProfile,
  chatStatus,
  createInitialState,
  defaultConfig,
  hiddenResults,
  normalizeGameState,
  parseGameCommand,
  reduceGame,
  shownProfile,
} from "./game.js";
import { handleRoomAssets, ensureUploadSchema, customUsage } from "./uploads.js";
import { handleRoomDeveloper, ensureDeveloperSchema, logRoomError, logRoomEvent } from "./developer.js";
import { checkChatSubscription } from "./eventsub.js";
import { cleanStats, knownHat, validStats, hatUnlocked, upgradeRules } from "./upgrades.js";
import { SE_ACTIONS, SE_READ_ACTIONS, DEFAULT_SE_NAMES, SE_SUBSCRIPTION_ID, seCommandText, seReplyText, seTopText, seEloText, seHelpText } from "./streamelements.js";

const INTERNAL_HEADER = "X-Mini-Internal";
const CHANNEL_HEADER = "X-Mini-Channel";
const USER_HEADER = "X-Mini-User-Id";
const MAX_PROFILE_ID_LENGTH = 64;
const MAX_LIVE_SOCKETS = 200;
const MAX_SOCKETS_PER_CLIENT = 16;      // one network can't fill the room and lock OBS out
const REJECTED_WRITE_MS = 60_000;          // a wrong StreamElements key is recorded at most once a minute
const MAX_CONFIG_HISTORY = 50;
const SEEN_WRITE_MS = 60_000;             // each command's "last seen" time is written at most once a minute
const MAX_LOOKS = 20;                  // logins per /looks call
const EVENTSUB_DEDUPE_MS = 10 * 60_000;     // Twitch retries a message with the same Message-Id
const MAX_EVENTSUB_IDS = 5_000;
// Chat bots never walk into the arena or duel.
const CHAT_BOTS = new Set(["streamelements", "nightbot", "moobot", "fossabot", "streamlabs", "wizebot", "sery_bot", "soundalerts", "kofistreambot", "botrixoficial"]);
const PRESENCE_REFRESH_MS = 30_000;        // chat-only viewers refresh their arena presence at most this often
const LAST_SEEN_WRITE_MS = 60_000;         // chat.lastSeen alone is persisted at most once a minute
const CHAT_CHECK_MS = 60 * 60_000;         // the alarm re-checks the Helix subscription at most hourly
const CHAT_PENDING_CHECK_MS = 3 * 60_000;  // a subscription still awaiting webhook verification is re-checked sooner

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

// Leaderboard order, as in the SQL: Elo, then wins, then name.
function boardOrder(a, b) {
  const x = a.username.toLowerCase(), y = b.username.toLowerCase();
  return b.elo - a.elo || b.wins - a.wins || (x < y ? -1 : x > y ? 1 : 0);
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
    stats: cleanStats({ power: row.power, guard: row.guard, luck: row.luck }),
    hat: knownHat(row.hat) ? row.hat : "",
    ...(row.last_opponent ? { lastOpponentId: String(row.last_opponent) } : {}),   // only getProfile reads it
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

function randomHex() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (x) => x.toString(16).padStart(2, "0")).join("");
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
    // v2.5: upgrade points spent from wins (server/upgrades.js) and the chosen hat.
    const profileColumns = sql.exec("PRAGMA table_info(profiles)").toArray().map((c) => c.name);
    for (const column of ["power", "guard", "luck"]) if (!profileColumns.includes(column)) sql.exec(`ALTER TABLE profiles ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    if (!profileColumns.includes("hat")) sql.exec("ALTER TABLE profiles ADD COLUMN hat TEXT NOT NULL DEFAULT ''");
    if (!profileColumns.includes("last_opponent")) sql.exec("ALTER TABLE profiles ADD COLUMN last_opponent TEXT NOT NULL DEFAULT ''");   // !rematch
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_ci ON profiles(username COLLATE NOCASE)");
    sql.exec("CREATE TABLE IF NOT EXISTS config_history (version INTEGER PRIMARY KEY, config TEXT NOT NULL, actor_id TEXT NOT NULL, at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '')");
    // v2.1: keep the actor's display name so history reads well for mods without a profile.
    if (!sql.exec("PRAGMA table_info(config_history)").toArray().some((c) => c.name === "actor_name")) sql.exec("ALTER TABLE config_history ADD COLUMN actor_name TEXT NOT NULL DEFAULT ''");
    ensureUploadSchema(sql);
    ensureDeveloperSchema(sql);
    sql.exec("CREATE TABLE IF NOT EXISTS se_settings (id INTEGER PRIMARY KEY CHECK (id = 1), secret TEXT NOT NULL, names TEXT NOT NULL)");
    // v2.4: when a StreamElements command last reached this room with the right key, and with a wrong one, so the admin
    // page can tell when the bot's commands were copied from another site (test vs production) or an old key.
    const seColumns = sql.exec("PRAGMA table_info(se_settings)").toArray().map((c) => c.name);
    for (const column of ["last_command_at", "rejected_at"]) if (!seColumns.includes(column)) sql.exec(`ALTER TABLE se_settings ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    // v2.5: when each command (action) last arrived with the right key, for the setup checklist.
    if (!seColumns.includes("seen_json")) sql.exec("ALTER TABLE se_settings ADD COLUMN seen_json TEXT NOT NULL DEFAULT '{}'");
    // and the broadcaster's "StreamElements Duel module is off" tick (nothing can check it for them)
    if (!seColumns.includes("duel_module_off")) sql.exec("ALTER TABLE se_settings ADD COLUMN duel_module_off INTEGER NOT NULL DEFAULT 0");
    this.seenMessages = new Map();   // EventSub Message-Id -> receivedAt; commands are also deduped durably by message_id
  }

  async fetch(request) {
    if (!this.authorized(request)) return json({ error: "internal authorization required" }, 403);
    try {
      return await this.route(request);
    } catch (error) {
      logRoomError(this, error, { path: new URL(request.url).pathname, method: request.method });
      return json({ error: "room error" }, 500);
    }
  }

  async route(request) {

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

    if (path === "/catalog" || path === "/asset" || path.startsWith("/asset/")) return handleRoomAssets(this, request, { path, channel, url });
    if (path.startsWith("/dev/")) return handleRoomDeveloper(this, request, { path, channel, url });

    if (path === "/admin" && request.method === "GET") {
      const state = this.readState(channel);
      this.seedConfigHistory(state);
      const history = this.ctx.storage.sql.exec("SELECT version, config, actor_id, actor_name, at, note FROM config_history ORDER BY version DESC LIMIT ?", MAX_CONFIG_HISTORY).toArray()
        .map((row) => ({ version: row.version, config: safeJsonParse(row.config, {}), actorId: row.actor_id, actorName: row.actor_name, at: row.at, note: row.note }));
      return json({ ...this.publicState(state), chatStatus: chatStatus(state), history, customUsage: customUsage(this), streamelements: this.seSettings(), overlays: this.ctx.getWebSockets("overlay").length });
    }

    if (path === "/leaderboard" && request.method === "GET") {
      return json(this.leaderboard(channel));
    }

    // Saved looks by login for the overlay (?u=a,b,c, at most 20): only viewers with a saved fighter are listed.
    if (path === "/looks" && request.method === "GET") {
      const logins = [...new Set(String(url.searchParams.get("u") || "").split(",").map(normalizeUsername).filter((u) => /^[a-z0-9_]+$/.test(u)))].slice(0, MAX_LOOKS);
      if (!logins.length) return json({});
      const state = this.readState(channel), config = state.config, hidden = hiddenResults(state, Date.now()), out = {};
      const rows = this.ctx.storage.sql.exec(`SELECT user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen, power, guard, luck, hat FROM profiles WHERE lower(username) IN (${logins.map(() => "?").join(",")})`, ...logins).toArray();
      for (const row of rows) {
        const p = shownProfile(normalizeProfileRow(row, config), hidden);
        out[p.username.toLowerCase()] = { avatar: p.avatar, color: p.color, hat: p.hat || "", displayName: p.displayName, elo: p.elo };
      }
      return json(out);
    }

    if (path === "/profile" && request.method === "GET") {
      const userId = validUserId(url.searchParams.get("userId"));
      if (!userId) return json({ error: "valid userId required" }, 400);
      const state = this.readState(channel);
      const hidden = hiddenResults(state, Date.now());
      const profile = shownProfile(this.getProfile(userId, state.config), hidden);
      if (!profile) return json(null);
      // A knocked-out fighter (hp 0, respawnAt) would give away a result the stream hasn't shown yet.
      const active = !hidden.has(userId) && state.players.find((item) => item.userId === userId);
      return json({ ...profile, ...(active ? { hp: active.hp, lastSeen: active.lastSeen, respawnAt: active.respawnAt } : {}), upgrades: upgradeRules(profile.wins) });
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
      const shown = shownProfile(result.profile, hiddenResults(result.state, Date.now()));
      return json({ profile: { ...shown, upgrades: upgradeRules(shown.wins) }, revision: result.state.revision });
    }

    if (path === "/admin" && request.method === "POST") {
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      const actorId = validUserId(body.value.actorId);
      if (!actorId) return json({ error: "authorized actor required" }, 403);
      const action = String(body.value.action || "");
      let payload = body.value.payload && typeof body.value.payload === "object" && !Array.isArray(body.value.payload) ? body.value.payload : body.value;
      let note = "";
      if (action === "rollbackConfig") {
        const version = Number(payload.version);
        const row = Number.isInteger(version) ? this.ctx.storage.sql.exec("SELECT config FROM config_history WHERE version = ?", version).toArray()[0] : null;
        if (!row) return json({ ok: false, reason: "config_version_not_found", error: "config_version_not_found" }, 404);
        payload = { patch: safeJsonParse(row.config, {}) };
        note = "rollback to v" + version;
      }
      const targetId = validUserId(payload.userId);
      const targetProfile = targetId ? this.getProfile(targetId, this.readState(channel).config) : null;
      const actorName = String(body.value.actorName || "").slice(0, 48);
      const event = { type: "admin", actorId, actorName, action: action === "rollbackConfig" ? "config" : action, payload, targetProfile, note: note || String(payload.note || "").slice(0, 200) };
      const result = this.advance(channel, event, Date.now());
      if (!result.result.ok) return json({ ...result.result, error: result.result.reason }, result.result.reason === "unauthorized" ? 403 : result.result.reason === "config_version_conflict" ? 409 : 400);
      this.broadcast(result.state);
      await this.scheduleAlarm(result.state);
      return json({ ...result.result, revision: result.state.revision });
    }

    if (path === "/live" && request.method === "GET") return this.upgrade(request, "live", channel, url.searchParams.get("role") === "overlay");

    // Worker-only routes (never reachable from /api/admin): verified EventSub messages and subscription bookkeeping.
    if (path === "/eventsub" && request.method === "POST") {
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      return this.eventsub(channel, body.value);
    }
    // StreamElements custom commands, forwarded by the Worker from GET /api/se/<channel>/<action>.
    if (path === "/se" && request.method === "POST") {
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      return this.streamElements(channel, body.value, url.searchParams.get("origin") || "");
    }
    if (path === "/se-admin" && request.method === "POST") {
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      const current = this.seSettings();
      if (body.value.action === "rotateSeKey") {
        this.writeSeSettings(randomHex(), current.names);
        this.ctx.storage.sql.exec("UPDATE se_settings SET last_command_at = 0, rejected_at = 0, seen_json = '{}' WHERE id = 1");   // a new key starts unheard
      }
      else if (body.value.action === "setSeNames") {
        const input = body.value.names && typeof body.value.names === "object" ? body.value.names : {};
        const names = {};
        for (const action of SE_ACTIONS) {
          const name = String(input[action] ?? current.names[action] ?? DEFAULT_SE_NAMES[action]).trim();
          if (!/^!?[a-z0-9_]{1,24}$/i.test(name)) return json({ error: `Invalid command name for ${action}` }, 400);
          names[action] = (name.startsWith("!") ? name : "!" + name).toLowerCase();
        }
        if (new Set(Object.values(names)).size !== SE_ACTIONS.length) return json({ error: "Each action needs its own command name" }, 400);
        this.writeSeSettings(current.secret, names);
      } else if (body.value.action === "setDuelModuleOff") {
        this.ctx.storage.sql.exec("UPDATE se_settings SET duel_module_off = ? WHERE id = 1", body.value.value === true ? 1 : 0);
      } else return json({ error: "unknown StreamElements action" }, 400);
      return json({ ok: true, streamelements: this.seSettings() });
    }
    // Test site only (worker dev token): one chat line as if Twitch had delivered it on the current subscription.
    if (path === "/dev-chat" && request.method === "POST") {
      if (!this.env?.DEV_TOOLS_TOKEN) return text("Not found", 404);
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      const { userId, username, displayName, text: line } = body.value;
      const now = Date.now(), messageId = "dev:" + randomHex().slice(0, 24);
      const msg = { messageId, timestamp: now, subscription: { id: this.readState(channel).chat.subscriptionId || "" }, event: { chatter_user_id: userId, chatter_user_login: username, chatter_user_name: displayName, message_id: messageId, message: { text: String(line || "") } } };
      const result = this.processChatMessage(channel, msg, now);
      if (result.visible) this.broadcast(result.state);
      if (result.changed) await this.scheduleAlarm(result.state);
      const r = result.result || {};
      if (r.reason === "quick_duel" || r.reason === "duel_completed") this.checkSavedProfiles(result.state, r.duelId);
      const parsed = parseGameCommand(String(line || ""));   // the reply is the line a StreamElements bot would post
      const action = parsed ? ({ duel: "challenge" }[parsed.action] || parsed.action) : "";
      return json({ ...r, revision: result.state.revision, reply: parsed ? seReplyText({ result: r, state: result.state, actorId: userId, action, target: parsed.target, names: this.seSettings().names, origin: "", now }) : "" });
    }
    if (path === "/chat" && request.method === "GET") return json(chatStatus(this.readState(channel)));
    if (path === "/chat" && request.method === "POST") {
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      const event = body.value.action === "connected"
        ? { type: "chat_subscription", subscriptionId: body.value.subscriptionId, status: body.value.status, createdAt: body.value.createdAt }
        : body.value.action === "disconnected" ? { type: "chat_disconnected", reason: body.value.reason } : null;
      if (!event) return json({ error: "unknown chat action" }, 400);
      const result = this.advance(channel, event, Date.now());
      if (result.visible) this.broadcast(result.state);
      await this.scheduleAlarm(result.state);
      return json({ ...result.result, revision: result.state.revision, chatStatus: chatStatus(result.state) });
    }

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
    return normalizeGameState({ ...createInitialState(channel), ...stored, channel });
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
      if (event.type === "admin" && event.action === "config") this.seedConfigHistory(state);
      const result = reduceGame(state, event, now);
      if (result.changed) this.writeState(result.state);
      for (const userId of result.dirtyProfileIds) {
        const profile = result.state.players.find((item) => item.userId === userId);
        if (profile?.registered) this.upsertProfile(profile);
      }
      if (result.resetAllRanks) this.resetAllRanks(result.state.config.initialElo);
      for (const userId of result.rankResetIds || []) {
        this.ctx.storage.sql.exec("UPDATE profiles SET elo = ?, wins = 0, losses = 0 WHERE user_id = ?", result.state.config.initialElo, userId);
      }
      for (const userId of result.deletedProfileIds || []) this.deleteProfile(userId);
      if (result.result?.reason === "config_updated") {
        this.recordConfigVersion(result.state.configVersion, result.state.config, event.actorId, event.note || "", now, event.actorName);
      }
      return result;
    });
  }

  // Config history keeps every version so mods can review and roll back (see CONTRACTS.md).
  seedConfigHistory(state) {
    const [{ n }] = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM config_history").toArray();
    if (!n) this.recordConfigVersion(state.configVersion, state.config, "system", "initial", Date.now());
  }

  recordConfigVersion(version, config, actorId, note, now, actorName = "") {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT OR REPLACE INTO config_history (version, config, actor_id, actor_name, at, note) VALUES (?, ?, ?, ?, ?, ?)", version, JSON.stringify(config), String(actorId || "system"), String(actorName || ""), now, note);
    sql.exec("DELETE FROM config_history WHERE version <= ?", version - 200);
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
      // Upgrades and hat: optional in the request (left out = keep the saved ones), checked against the saved wins.
      const wins = existing?.wins || 0;
      const stats = input.stats === undefined ? existing?.stats : validStats(input.stats, wins);
      if (stats === null) return { ok: false, reason: "invalid_upgrades" };
      const hat = input.hat === undefined ? existing?.hat || "" : input.hat;
      if (hat !== (existing?.hat || "") && !hatUnlocked(hat, wins)) return { ok: false, reason: knownHat(hat) ? "hat_locked" : "invalid_profile" };
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
        stats: stats || cleanStats(),
        hat,
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
      "SELECT user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen, power, guard, luck, hat, last_opponent FROM profiles WHERE user_id = ?",
      userId,
    ).toArray()[0];
    return normalizeProfileRow(row, config);
  }

  getProfileByUsername(username, config) {
    const name = normalizeUsername(username);
    if (!name) return null;
    const row = this.ctx.storage.sql.exec(
      "SELECT user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen, power, guard, luck, hat FROM profiles WHERE username = ? COLLATE NOCASE",
      name,
    ).toArray()[0];
    return normalizeProfileRow(row, config);
  }

  upsertProfile(profile) {
    // Twitch logins can be renamed and later reused; free the login if a stale row still holds it.
    this.ctx.storage.sql.exec(
      "UPDATE profiles SET username = '~' || user_id WHERE username = ? COLLATE NOCASE AND user_id <> ?",
      profile.username,
      profile.userId,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO profiles (user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen, power, guard, luck, hat, last_opponent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name, avatar = excluded.avatar, color = excluded.color, default_ability = excluded.default_ability, elo = excluded.elo, wins = excluded.wins, losses = excluded.losses, last_seen = excluded.last_seen, " +
      "power = excluded.power, guard = excluded.guard, luck = excluded.luck, hat = excluded.hat, " +
      // A website save carries no opponent; keep the stored one.
      "last_opponent = CASE WHEN excluded.last_opponent <> '' THEN excluded.last_opponent ELSE profiles.last_opponent END",
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
      ...(({ power, guard, luck }) => [power, guard, luck])(cleanStats(profile.stats)),
      knownHat(profile.hat) ? profile.hat : "",
      String(profile.lastOpponentId || "").slice(0, 32),
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
      "SELECT user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen, power, guard, luck, hat FROM profiles ORDER BY elo DESC, wins DESC, username COLLATE NOCASE ASC LIMIT 100",
    ).toArray();
    const hidden = hiddenResults(state, Date.now());
    const out = rows.map((row) => {
      const profile = shownProfile(normalizeProfileRow(row, state.config), hidden);
      const active = !hidden.has(profile.userId) && state.players.find((item) => item.userId === profile.userId);
      return active ? { ...profile, hp: active.hp, lastSeen: active.lastSeen, respawnAt: active.respawnAt } : profile;
    });
    return hidden.size ? out.sort(boardOrder) : out;   // same order as the SQL, on the numbers shown
  }

  // One saved profile with its leaderboard place (same order as leaderboard()), or null.
  eloLookup(channel, { userId, username }) {
    const sql = this.ctx.storage.sql;
    const row = (userId
      ? sql.exec("SELECT user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen, power, guard, luck, hat FROM profiles WHERE user_id = ?", userId)
      : sql.exec("SELECT user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen, power, guard, luck, hat FROM profiles WHERE username = ? COLLATE NOCASE", username)).toArray()[0];
    if (!row) return null;
    const state = this.readState(channel), hidden = hiddenResults(state, Date.now());
    const profile = shownProfile(normalizeProfileRow(row, state.config), hidden);
    let ahead = Number(sql.exec(
      "SELECT COUNT(*) AS n FROM profiles WHERE user_id != ? AND (elo > ? OR (elo = ? AND wins > ?) OR (elo = ? AND wins = ? AND username COLLATE NOCASE < ?))",
      profile.userId, profile.elo, profile.elo, profile.wins, profile.elo, profile.wins, row.username,
    ).toArray()[0].n);
    // The count used everyone's saved numbers; swap in the shown ones for fighters whose result is still hidden.
    for (const id of hidden.keys()) {
      if (id === profile.userId) continue;
      const other = sql.exec("SELECT user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen, power, guard, luck, hat FROM profiles WHERE user_id = ?", id).toArray()[0];
      if (!other) continue;
      const saved = normalizeProfileRow(other, state.config);
      ahead += (boardOrder(shownProfile(saved, hidden), profile) < 0) - (boardOrder(saved, profile) < 0);
    }
    const total = sql.exec("SELECT COUNT(*) AS n FROM profiles").toArray()[0].n;
    return { profile, rank: ahead + 1, total: Number(total) };
  }

  publicState(state) {
    return {
      type: "snapshot",
      channel: state.channel,
      revision: state.revision,
      paused: !state.chat.connected || !state.config.enabled,
      chat: { connected: Boolean(state.chat.connected), lastSeen: Number(state.chat.lastSeen) || 0, status: String(state.chat.status || "disconnected") },
      config: state.config,
      configVersion: state.configVersion,
      round: state.round,
      players: state.players.map((profile) => ({ ...profile })),
      duels: state.duels.map((duel) => ({ ...duel })),
      events: state.events.slice(-50).map((event) => ({ ...event })),
      build: String(this.env?.CF_VERSION_METADATA?.id || ""),   // overlays reload themselves when a new deploy lands
      serverNow: Date.now(),   // lets overlays on a PC with a wrong clock convert event times (arena-client.js)
    };
  }

  async upgrade(request, kind, channel, overlay = false) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "websocket upgrade required" }, 426);
    const ip = request.headers.get("X-Mini-Client-Ip"), clientTag = ip ? "ip:" + ip.slice(0, 64) : null;
    if (clientTag && this.ctx.getWebSockets(clientTag).length >= MAX_SOCKETS_PER_CLIENT) {
      return json({ error: "too many overlay connections from this network" }, 429);
    }
    const live = this.ctx.getWebSockets("live");
    if (live.length >= MAX_LIVE_SOCKETS) {   // full: drop an existing socket rather than refuse the new one
      try { live[0].close(1013, "room full"); } catch {}
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [kind, ...(clientTag ? [clientTag] : []), ...(overlay ? ["overlay"] : [])]);   // "overlay": OBS browser sources, counted for /admin
    server.serializeAttachment({ kind, channel });
    const result = this.advance(channel, { type: "tick" }, Date.now());
    server.send(JSON.stringify(this.publicState(result.state)));
    if (result.changed) this.broadcast(result.state);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws) {
    // Overlay sockets are read-only snapshots.
    try { ws.close(1008, "Read-only socket"); } catch {}
  }

  async eventsub(channel, msg) {
    const now = Date.now();
    const id = String(msg.messageId || "").slice(0, 100);
    if (!id) return json({ error: "messageId required" }, 400);
    for (const [key, at] of this.seenMessages) {   // insertion order is arrival order
      if (now - at <= EVENTSUB_DEDUPE_MS && this.seenMessages.size <= MAX_EVENTSUB_IDS) break;
      this.seenMessages.delete(key);
    }
    const kind = String(msg.messageType || "");
    if (kind !== "webhook_callback_verification") {
      if (this.seenMessages.has(id)) return json({ ok: true, duplicate: true });
      this.seenMessages.set(id, now);
    }
    const subscriptionId = String(msg.subscription?.id || "");
    let result;
    if (kind === "webhook_callback_verification") result = this.advance(channel, { type: "chat_verified", subscriptionId }, now);
    else if (kind === "revocation") {
      if (!subscriptionId || subscriptionId !== this.readState(channel).chat.subscriptionId) return json({ ok: true, ignored: true });
      result = this.advance(channel, { type: "chat_disconnected", reason: String(msg.subscription?.status || "revoked") }, now);
    } else if (kind === "notification") result = this.processChatMessage(channel, msg, now);
    else return json({ ok: true, ignored: true });
    if (result.visible) this.broadcast(result.state);
    if (result.changed) await this.scheduleAlarm(result.state);
    return json({ ok: Boolean(result.result?.ok), reason: String(result.result?.reason || "") });
  }

  seSettings() {
    const row = this.ctx.storage.sql.exec("SELECT secret, names, last_command_at, rejected_at, seen_json, duel_module_off FROM se_settings WHERE id = 1").toArray()[0];
    if (row) {
      const names = { ...DEFAULT_SE_NAMES, ...safeJsonParse(row.names, {}) };
      if (names.accept === "!accept") names.accept = DEFAULT_SE_NAMES.accept;   // StreamElements' Duel module owns !accept
      if (names.top === "!top") names.top = DEFAULT_SE_NAMES.top;   // and its built-in !top can't be replaced
      const stored = safeJsonParse(row.seen_json, {}), seen = {};
      for (const action of SE_ACTIONS) if (Number(stored?.[action]) > 0) seen[action] = Number(stored[action]);
      return { secret: row.secret, names, lastCommandAt: Number(row.last_command_at) || 0, rejectedAt: Number(row.rejected_at) || 0, seen, duelModuleOff: row.duel_module_off === 1 };
    }
    const secret = randomHex();
    this.writeSeSettings(secret, DEFAULT_SE_NAMES);
    return { secret, names: { ...DEFAULT_SE_NAMES }, lastCommandAt: 0, rejectedAt: 0, seen: {}, duelModuleOff: false };
  }

  writeSeSettings(secret, names) {
    this.ctx.storage.sql.exec("INSERT INTO se_settings (id, secret, names) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET secret = excluded.secret, names = excluded.names", secret, JSON.stringify(names));
  }

  // One StreamElements command. It goes through the same path as a Twitch chat message, then gets a one-line reply.
  async streamElements(channel, input, origin) {
    const settings = this.seSettings();
    if (!timingSafeEqual(String(input.key || ""), settings.secret)) {
      if (Date.now() - settings.rejectedAt > REJECTED_WRITE_MS) this.ctx.storage.sql.exec("UPDATE se_settings SET rejected_at = ? WHERE id = 1", Date.now());
      return json({ reply: "Mini Chat: wrong key. Copy the commands again from the admin page." }, 403);
    }
    const action = SE_ACTIONS.includes(input.action) ? input.action : "";
    if (action && Date.now() - (settings.seen[action] || 0) > SEEN_WRITE_MS) {
      this.ctx.storage.sql.exec("UPDATE se_settings SET last_command_at = ?, seen_json = ? WHERE id = 1", Date.now(), JSON.stringify({ ...settings.seen, [action]: Date.now() }));
    } else this.ctx.storage.sql.exec("UPDATE se_settings SET last_command_at = ? WHERE id = 1", Date.now());
    const userId = validUserId(input.userId);
    const username = normalizeUsername(input.username);
    const target = normalizeUsername(input.target);
    const now = Date.now();
    const names = settings.names;
    let state0 = this.readState(channel);
    // The first command with the right key makes StreamElements the chat source, unless a mod turned chat off on
    // purpose (Disconnect chat; "Use StreamElements" turns it back on). SE_ONLY (test site) always switches.
    let switchedFrom = "";
    const turnedOff = state0.chat.status === "disconnected" && state0.chat.createdAt > 0;
    if (state0.chat.subscriptionId !== SE_SUBSCRIPTION_ID && (this.env?.SE_ONLY === "1" || !turnedOff)) {
      switchedFrom = state0.chat.subscriptionId || "";   // a Twitch EventSub subscription the Worker deletes
      const switched = this.advance(channel, { type: "chat_subscription", subscriptionId: SE_SUBSCRIPTION_ID, status: "enabled", createdAt: now }, now);
      if (switched.visible) this.broadcast(switched.state);
      await this.scheduleAlarm(switched.state);
      state0 = switched.state;
    }
    // Every command is logged with what came in, what the game decided and what the bot said.
    const done = (reply, reason, extra = {}) => {
      logRoomEvent(this, "command", `${username || "?"} ${input.action || "?"}${target ? " @" + target : ""} -> ${reason}`, { channel, user: username, userId, action: input.action, t: String(input.targetRaw || "").slice(0, 80), target, reason, reply, ...extra });
      return json(switchedFrom ? { reply, switchedFrom } : { reply });
    };
    if (!action) return done(`Lost in the arena? Type ${names.help}`, "unknown_action");
    if (!userId || !username) return done("Mini Chat: this command is missing sender details. Copy it again from the admin page.", "missing_sender");
    if (SE_READ_ACTIONS.includes(action)) {
      if (action === "help") return done(seHelpText({ names, origin, channel }), "help");
      if (action === "top") return done(seTopText(this.leaderboard(channel).slice(0, 5), { origin, channel }), "top");
      const found = this.eloLookup(channel, target ? { username: target } : { userId });
      return done(seEloText(found, { self: !target, askerName: input.displayName || username, target, origin, channel }), found ? "elo" : "elo_not_found");
    }
    if (!state0.chat.connected || state0.chat.subscriptionId !== SE_SUBSCRIPTION_ID) return done(seReplyText({ result: { ok: false, reason: "chat_offline" }, state: state0, actorId: userId, action, target, names, origin, now }), "chat_offline");
    if (action === "challenge" && !target) return done(seReplyText({ result: { ok: false, reason: "target_required" }, state: state0, actorId: userId, action, target, names, origin, now }), "target_required");
    const messageId = "se:" + (String(input.messageId || "").slice(0, 60) || randomHex().slice(0, 24));
    const msg = { messageId, timestamp: now, subscription: { id: SE_SUBSCRIPTION_ID }, event: { chatter_user_id: userId, chatter_user_login: username, chatter_user_name: String(input.displayName || username).slice(0, 48), message_id: messageId, message: { text: seCommandText(action, target) } } };
    const result = this.processChatMessage(channel, msg, now);
    if (result.visible) this.broadcast(result.state);
    if (result.changed) await this.scheduleAlarm(result.state);
    const r = result.result || {};
    if (r.reason === "quick_duel" || r.reason === "duel_completed") this.checkSavedProfiles(result.state, r.duelId);
    const actorRegistered = r.reason !== "ranked_sign_in_required" || this.ctx.storage.sql.exec("SELECT 1 FROM profiles WHERE user_id = ?", userId).toArray().length > 0;
    return done(seReplyText({ result: r, state: result.state, actorId: userId, action, target, names, origin, now, actorRegistered }), r.reason || (r.ok ? action : "error"), r.swings ? { duelId: r.duelId, swings: r.swings.map((s) => s.die + ({ crit: "x" }[s.outcome] || s.outcome[0])).join(" ") } : {});
  }

  // After a finished duel the stored profiles must match the game state, or the next command undoes the result.
  checkSavedProfiles(state, duelId) {
    const duel = state.duels.find((d) => d.id === duelId);
    for (const id of duel ? [duel.a, duel.b] : []) {
      const p = state.players.find((x) => x.userId === id);
      if (!p?.registered) continue;
      const row = this.ctx.storage.sql.exec("SELECT elo, wins, losses FROM profiles WHERE user_id = ?", id).toArray()[0];
      if (!row || row.elo !== p.elo || row.wins !== p.wins || row.losses !== p.losses) {
        logRoomEvent(this, "warn", `profile for ${p.username} not saved after ${duelId}`, { channel: state.channel, userId: id, game: { elo: p.elo, wins: p.wins, losses: p.losses }, saved: row || null });
      }
    }
  }

  // One channel.chat.message: a presence update, plus a game command when the text parses as one.
  // No chat replies; rejected commands are logged to the room event list.
  processChatMessage(channel, msg, now) {
    const ev = msg.event && typeof msg.event === "object" ? msg.event : {};
    const userId = validUserId(ev.chatter_user_id);
    const username = normalizeUsername(ev.chatter_user_login);
    const displayName = String(ev.chatter_user_name || username).trim().slice(0, 48);
    const textValue = String(ev.message?.text || "").slice(0, 512);
    const color = /^#[0-9a-f]{6}$/i.test(ev.color || "") ? ev.color.toUpperCase() : "";
    const subscriptionId = String(msg.subscription?.id || "");
    return this.ctx.storage.transactionSync(() => {
      let state = this.readState(channel);
      const none = (reason) => ({ state, result: { ok: false, reason }, changed: false, visible: false });
      if (!subscriptionId || subscriptionId !== state.chat.subscriptionId) return none("unknown_subscription");
      const steps = [];
      const step = (event) => { const r = reduceGame(state, event, now); state = r.state; steps.push(r); return r; };
      // Twitch only notifies enabled subscriptions, so a notification also confirms a pending one.
      if (!state.chat.connected) step({ type: "chat_verified", subscriptionId });
      let main = null;
      if (!userId || !/^[a-z0-9_]{1,25}$/.test(username) || !displayName) main = { result: { ok: false, reason: "invalid_event" } };
      else if (CHAT_BOTS.has(username)) main = { result: { ok: false, reason: "chat_bot" } };
      else {
        const userProfile = this.getProfile(userId, state.config);
        // Registered players keep their saved look; other chatters take their Twitch name color.
        const profile = userProfile ? { ...userProfile, username, displayName } : { userId, username, displayName, ...(color ? { color } : {}) };
        const parsed = parseGameCommand(textValue);
        if (parsed) {
          const lastId = parsed.action === "rematch" ? state.players.find((p) => p.userId === userId)?.lastOpponentId || userProfile?.lastOpponentId : "";
          const targetProfile = parsed.target ? this.getProfileByUsername(parsed.target, state.config) : lastId ? this.getProfile(lastId, state.config) : null;
          main = step({ type: "command", messageId: String(ev.message_id || msg.messageId).slice(0, 64), userId, username, displayName, text: textValue, timestamp: Number(msg.timestamp), profile, targetProfile, quick: subscriptionId === SE_SUBSCRIPTION_ID, rolls: Array.from({ length: 48 }, () => Math.random()) });
          if (!main.result.ok && main.result.reason !== "duplicate") step({ type: "command_rejected", userId, command: parsed.action, reason: main.result.reason, retryAt: main.result.retryAt });
        } else {
          const active = state.players.find((item) => item.userId === userId);
          const fresh = active && now - active.lastSeen < PRESENCE_REFRESH_MS && active.displayName === displayName && (userProfile || !color || active.color === color);
          if (!fresh) main = step({ type: "presence", userId, username, displayName, profile });
        }
        const updated = state.players.find((item) => item.userId === userId);
        if (updated?.registered && userProfile && (updated.username !== userProfile.username || updated.displayName !== userProfile.displayName)) this.upsertProfile(updated);
        if (main?.result?.reason === "duel_completed" || main?.result?.reason === "quick_duel") {   // save Elo, wins and losses
          const duel = state.duels.find((item) => item.id === main.result.duelId);
          for (const id of duel ? [duel.a, duel.b] : []) {
            const participant = state.players.find((item) => item.userId === id);
            if (participant?.registered) this.upsertProfile(participant);
          }
        }
      }
      let changed = steps.some((r) => r.changed);
      if (changed || now - (Number(state.chat.lastSeen) || 0) >= LAST_SEEN_WRITE_MS) {
        state.chat.lastSeen = now;
        this.writeState(state);
        changed = true;
      }
      return { state, result: main?.result || { ok: true, reason: "presence_fresh" }, changed, visible: steps.some((r) => r.visible) };
    });
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
    const chatDue = chatCheckDue(state);
    if (chatDue !== null) due.push(chatDue);
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
    let result = this.advance(channel, { type: "tick" }, Date.now());
    if (result.changed) this.broadcast(result.state);
    const state = result.state;
    const chatDue = chatCheckDue(state);
    if (chatDue !== null && Date.now() >= chatDue) {
      // Only a definite answer disconnects (missing, failed or revoked); a failed Helix call just waits for the next check.
      // A subscription still pending verification stays pending; one that failed verification is recorded as such.
      const status = await checkChatSubscription(this.env, state.chat.subscriptionId);
      if (this.readState(channel).chat.subscriptionId === state.chat.subscriptionId) {
        const subscriptionId = state.chat.subscriptionId;
        const event = !status || status === "webhook_callback_verification_pending" ? { type: "chat_checked" }
          : status === "enabled" ? (state.chat.connected ? { type: "chat_checked" } : { type: "chat_verified", subscriptionId })
          : { type: "chat_disconnected", reason: status === "missing" ? "subscription_missing" : status };
        result = this.advance(channel, event, Date.now());
        let visible = result.visible;
        if (event.type === "chat_verified") { result = this.advance(channel, { type: "chat_checked" }, Date.now()); visible ||= result.visible; }
        if (visible) this.broadcast(result.state);
      }
    }
    await this.scheduleAlarm(result.state);
  }
}

// Next Helix check time, or null: hourly while connected, every few minutes while a subscription awaits verification.
function chatCheckDue(state) {
  const id = state.chat?.subscriptionId;
  if (!id || id.startsWith("local-") || id === SE_SUBSCRIPTION_ID) return null;
  return (Number(state.chat.checkedAt) || 0) + (state.chat.connected ? CHAT_CHECK_MS : CHAT_PENDING_CHECK_MS);
}
