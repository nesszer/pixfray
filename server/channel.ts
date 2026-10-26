import { DurableObject } from "cloudflare:workers";
import site from "../site.config.js";
import { createInitialState, hiddenResults, normalizeGameState, reduceGame, shownProfile } from "./game.ts";
import { ensureUploadSchema } from "./uploads.ts";
import { ensureRankLogSchema } from "./ranklog.ts";
import { ensureDeveloperSchema, logRoomError, logRoomEvent } from "./developer.ts";
import { count, ensureTrackerSchema, noteAlarm, settleCounts, trace } from "./tracker.ts";
import { botDropText, checkChatSubscription, sendChatMessage } from "./eventsub.ts";
import { accountCreatedAt } from "./accounts.ts";
import { claimMessage, EVENTSUB_DEDUPE_MS, releaseMessage } from "./dedupe.ts";
import { STATS } from "./upgrades.ts";
import { ensurePointsSchema } from "./points.ts";
import { ensurePetSchema } from "./pets.ts";
import { ensureSpriteSchema } from "./sprites.ts";
import { botNames, DEFAULT_SE_NAMES, SE_ACTIONS, SE_SUBSCRIPTION_ID, seReminderText } from "./streamelements.ts";
import type { SeNames } from "./streamelements.ts";
import type { Config, GameEvent, GameState, ReduceOutput, Snapshot } from "./model.ts";
import type { Env } from "./env.ts";
import {
  BOT_REPLIES_PER_30S,
  CHANNEL_HEADER,
  chatCheckDue,
  INTERNAL_HEADER,
  json,
  MAX_EVENTSUB_IDS,
  MAX_LIVE_SOCKETS,
  MAX_SOCKETS_PER_CLIENT,
  normalizeChannel,
  normalizeProfileRow,
  normalizeUsername,
  PROFILE_COLUMNS,
  errorText,
  randomHex,
  RESULT_RETRY_MS,
  RESULT_WINDOW_MS,
  safeJsonParse,
  savedLook,
  timingSafeEqual,
  upsertProfile,
} from "./room-shared.ts";
import type {
  BotMessage,
  BotStatusRow,
  ChatOutcome,
  DueDuel,
  JsonObject,
  LiveMessage,
  Look,
  ProfileRow,
  ProfileTable,
  ReadJson,
  RoomEvent,
} from "./room-shared.ts";
import { route } from "./room-routes.ts";
import { botCommand, checkAccountAge, noteBotSent, postExpired, postResults, processChatMessage } from "./room-bot.ts";
import { currentStream, payDuels, streamNews, syncPetBoosts } from "./room-economy.ts";

/** The parsed se_settings row (seSettings). */
export type SeSettings = {
  secret: string;
  names: SeNames;
  lastCommandAt: number;
  rejectedAt: number;
  /** When each command (action) last arrived with the right key. */
  seen: { [action: string]: number };
  duelModuleOff: boolean;
};

export class ChannelRoom extends DurableObject<Env> {
  // public, so the room helpers in pets, sprites, uploads and developer can take the room
  declare ctx: DurableObjectState<{}>; // DurableObject's own Props default
  declare env: Env;
  /** Last time each held-duel reason was logged. */
  declare heldLogged: Record<string, number> | undefined;
  /** Text command cooldowns (customReply). */
  declare commandCooldowns: Map<string, number> | undefined;
  /** EventSub Message-Id -> receivedAt. */
  declare seenMessages: Map<string, number>;
  /** Logins whose saved look changed or went away since the last "looks" push (flushLooks). */
  declare dirtyLooks: Set<string> | undefined;
  declare goneLooks: Set<string> | undefined;
  /** Every saved look changed (a restore): overlays drop what they cached. */
  declare looksReset: boolean;
  /** The pending setTimeout handle (a number in Workers, a Timeout under Node types), 0 once flushed. */
  declare lookFlush: unknown;
  /** When the bot's recent chat replies went out (botReplyRoom). */
  declare botReplies: number[] | undefined;
  declare liveCache: { at: number; stream: { id: string; startedAt: number } | null } | undefined;
  /** Duel ids whose expired-challenge line went out. */
  declare expiredSaid: Set<string> | undefined;
  declare postingResults: Promise<void> | null | undefined;
  /** The alarm this instance last set (null: none), undefined until it sets or clears one. */
  declare alarmAt: number | null | undefined;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    // last time each held-duel reason was logged
    this.heldLogged = undefined;
    // text command cooldowns (customReply)
    this.commandCooldowns = undefined;
    // Overlays send "ping" every 20 s to catch a half-open socket. The runtime answers "pong" itself, without waking this
    // object from hibernation or billing its time (src/served/arena-client.ts).
    if (typeof WebSocketRequestResponsePair === "function")
      ctx.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair("ping", "pong"));
    const sql = this.ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS game_state (id INTEGER PRIMARY KEY CHECK (id = 1), channel TEXT NOT NULL, document TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL, avatar TEXT NOT NULL, color TEXT NOT NULL, default_ability TEXT NOT NULL, elo INTEGER NOT NULL, wins INTEGER NOT NULL, losses INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0)",
    );
    // v2.5: upgrade points spent from wins (server/upgrades.ts) and the chosen hat.
    const profileColumns = sql
      .exec<{ name: string }>("PRAGMA table_info(profiles)")
      .toArray()
      .map((c) => c.name);
    // v2.10: crit, dodge and counter join the upgrade stats; v2.11: vitality.
    for (const column of STATS)
      if (!profileColumns.includes(column))
        sql.exec(`ALTER TABLE profiles ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    if (!profileColumns.includes("hat")) sql.exec("ALTER TABLE profiles ADD COLUMN hat TEXT NOT NULL DEFAULT ''");
    if (!profileColumns.includes("last_opponent"))
      sql.exec("ALTER TABLE profiles ADD COLUMN last_opponent TEXT NOT NULL DEFAULT ''"); // !rematch
    // v2.6: !checkin. Check-in points live apart from wins, so a rank reset keeps them; upsertProfile never writes them.
    for (const column of ["bonus_points", "checkins", "streak", "last_stream_seq", "free_miss_at"])
      if (!profileColumns.includes(column))
        sql.exec(`ALTER TABLE profiles ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    if (!profileColumns.includes("last_stream"))
      sql.exec("ALTER TABLE profiles ADD COLUMN last_stream TEXT NOT NULL DEFAULT ''");
    // v2.7: PixFray dollars, and what each viewer gave away in which stream (!give). upsertProfile never writes them either.
    for (const column of ["dollars", "given_in_stream"])
      if (!profileColumns.includes(column))
        sql.exec(`ALTER TABLE profiles ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    if (!profileColumns.includes("give_stream"))
      sql.exec("ALTER TABLE profiles ADD COLUMN give_stream TEXT NOT NULL DEFAULT ''");
    // 0.12.0: style dollars from channel point rewards (server/points.ts). They buy looks and build slots, never pets,
    // and !give never moves them, so channel points can't buy duel strength.
    if (!profileColumns.includes("style_dollars"))
      sql.exec("ALTER TABLE profiles ADD COLUMN style_dollars INTEGER NOT NULL DEFAULT 0");
    // v2.8: the active pet, plus bought items and uploaded pets (server/pets.ts). PROFILE_COLUMNS reads custom_pets.
    if (!profileColumns.includes("pet")) sql.exec("ALTER TABLE profiles ADD COLUMN pet TEXT NOT NULL DEFAULT ''");
    const rolled = ensurePetSchema(sql);
    // v3.1: sprites viewers made from their own images, waiting for a mod or approved (server/sprites.ts).
    ensureSpriteSchema(sql);
    // v2.9: cosmetics worn (server/cosmetics.ts) and the active build slot. Each slot's loadout is a JSON row in builds;
    // the profile columns always hold the active one. Bought build slots are owned_items rows of kind "slot".
    for (const column of ["recolor", "pet_color", "accessory", "trail", "win_effect", "taunt", "title"])
      if (!profileColumns.includes(column))
        sql.exec(`ALTER TABLE profiles ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
    if (!profileColumns.includes("build")) sql.exec("ALTER TABLE profiles ADD COLUMN build INTEGER NOT NULL DEFAULT 0");
    // v3.0: when the fighter's Twitch account was made (0 = not known yet) and when the room last asked Twitch.
    for (const column of ["account_created_at", "account_checked_at"])
      if (!profileColumns.includes(column))
        sql.exec(`ALTER TABLE profiles ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    sql.exec(
      "CREATE TABLE IF NOT EXISTS builds (user_id TEXT NOT NULL, slot INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (user_id, slot))",
    );
    // Streams with at least one check-in, numbered in order: a streak counts these, so a gap of one seq is one missed stream.
    sql.exec(
      "CREATE TABLE IF NOT EXISTS streams (seq INTEGER PRIMARY KEY, stream_id TEXT NOT NULL UNIQUE, started_at INTEGER NOT NULL)",
    );
    // Test site only (DEV_TOOLS_TOKEN): a pretend live stream for !checkin. stream_id '' = pretend offline.
    sql.exec(
      "CREATE TABLE IF NOT EXISTS dev_live (id INTEGER PRIMARY KEY CHECK (id = 1), stream_id TEXT NOT NULL, started_at INTEGER NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS checkin_test (id INTEGER PRIMARY KEY CHECK (id = 1), until INTEGER NOT NULL, by_name TEXT NOT NULL)",
    );
    // The bot's !fray reminder (config.reminderMin): who to post as and where, learned from the bot's last command, and when it's next due.
    sql.exec(
      "CREATE TABLE IF NOT EXISTS bot_reminder (id INTEGER PRIMARY KEY CHECK (id = 1), broadcaster_id TEXT NOT NULL, bot_id TEXT NOT NULL, origin TEXT NOT NULL, next_at INTEGER NOT NULL DEFAULT 0)",
    );
    // results_through: the latest duel revealAt the bot has announced, so a result line goes out once.
    if (
      !sql
        .exec<{ name: string }>("PRAGMA table_info(bot_reminder)")
        .toArray()
        .some((c) => c.name === "results_through")
    )
      sql.exec("ALTER TABLE bot_reminder ADD COLUMN results_through INTEGER NOT NULL DEFAULT 0");
    // The bot's own text commands (admin page, Chat commands) and the counters their replies use (server/botcommands.ts).
    sql.exec(
      "CREATE TABLE IF NOT EXISTS bot_commands (name TEXT PRIMARY KEY, reply TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL DEFAULT '')",
    );
    sql.exec("CREATE TABLE IF NOT EXISTS bot_counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0)");
    // The bot's health, for the admin page and "!fray debug": the last command heard, reply sent, reply Twitch dropped
    // (with its reason) and reply the room held back (reply cap, cooldown, old subscription). Totals count since creation.
    sql.exec(
      "CREATE TABLE IF NOT EXISTS bot_status (id INTEGER PRIMARY KEY CHECK (id = 1), heard_at INTEGER NOT NULL DEFAULT 0, heard TEXT NOT NULL DEFAULT '', sent_at INTEGER NOT NULL DEFAULT 0, sent_total INTEGER NOT NULL DEFAULT 0, failed_at INTEGER NOT NULL DEFAULT 0, failed_total INTEGER NOT NULL DEFAULT 0, failed_reason TEXT NOT NULL DEFAULT '', held_at INTEGER NOT NULL DEFAULT 0, held_reason TEXT NOT NULL DEFAULT '')",
    );
    sql.exec("INSERT OR IGNORE INTO bot_status (id) VALUES (1)");
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_ci ON profiles(username COLLATE NOCASE)");
    // v3.2: rank history, written by triggers on profiles (server/ranklog.ts).
    ensureRankLogSchema(sql, Date.now());
    sql.exec(
      "CREATE TABLE IF NOT EXISTS config_history (version INTEGER PRIMARY KEY, config TEXT NOT NULL, actor_id TEXT NOT NULL, at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '')",
    );
    // v2.1: keep the actor's display name so history reads well for mods without a profile.
    if (
      !sql
        .exec<{ name: string }>("PRAGMA table_info(config_history)")
        .toArray()
        .some((c) => c.name === "actor_name")
    )
      sql.exec("ALTER TABLE config_history ADD COLUMN actor_name TEXT NOT NULL DEFAULT ''");
    ensureUploadSchema(sql);
    ensureDeveloperSchema(sql);
    ensureTrackerSchema(sql);
    ensurePointsSchema(sql);
    sql.exec(
      "CREATE TABLE IF NOT EXISTS se_settings (id INTEGER PRIMARY KEY CHECK (id = 1), secret TEXT NOT NULL, names TEXT NOT NULL)",
    );
    // v2.4: when a StreamElements command last reached this room with the right key, and with a wrong one, so the admin
    // page can tell when the bot's commands were copied from another site (test vs production) or an old key.
    const seColumns = sql
      .exec<{ name: string }>("PRAGMA table_info(se_settings)")
      .toArray()
      .map((c) => c.name);
    for (const column of ["last_command_at", "rejected_at"])
      if (!seColumns.includes(column))
        sql.exec(`ALTER TABLE se_settings ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    // v2.5: when each command (action) last arrived with the right key, for the setup checklist.
    if (!seColumns.includes("seen_json"))
      sql.exec("ALTER TABLE se_settings ADD COLUMN seen_json TEXT NOT NULL DEFAULT '{}'");
    // and the broadcaster's "StreamElements Duel module is off" tick (nothing can check it for them)
    if (!seColumns.includes("duel_module_off"))
      sql.exec("ALTER TABLE se_settings ADD COLUMN duel_module_off INTEGER NOT NULL DEFAULT 0");
    this.seenMessages = new Map(); // EventSub Message-Id -> receivedAt; commands are also deduped durably by message_id
    // Legendary pets ensurePetSchema just rolled: fighters on stage take their rolled boost.
    const stored = rolled.length ? this.readStoredState() : null;
    if (typeof stored?.channel === "string") {
      const state = this.readState(stored.channel);
      if (syncPetBoosts(this, state, rolled)) {
        state.revision += 1;
        this.writeState(state);
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.authorized(request)) return json({ error: "internal authorization required" }, 403);
    count(this, "requests");
    try {
      return await route(this, request);
    } catch (error) {
      logRoomError(this, error, { path: new URL(request.url).pathname, method: request.method });
      return json({ error: "room error" }, 500);
    } finally {
      settleCounts(this);
    }
  }

  authorized(request: Request): boolean {
    const expected = this.env.INTERNAL_SECRET;
    const received = request.headers.get(INTERNAL_HEADER);
    if (typeof expected !== "string" || expected.length < 16) return false;
    return timingSafeEqual(received, expected);
  }

  requestChannel(request: Request): string {
    return normalizeChannel(request.headers.get(CHANNEL_HEADER) || this.env.CHANNEL_NAME || site.defaultChannel);
  }

  readStoredState() {
    const row = this.ctx.storage.sql
      .exec<{ channel: string; document: string }>("SELECT channel, document FROM game_state WHERE id = 1")
      .toArray()[0];
    if (!row) return null;
    return safeJsonParse<{ channel?: unknown; [field: string]: unknown }, null>(row.document, null);
  }

  readState(channel: string): GameState {
    const stored = this.readStoredState();
    if (!stored) return createInitialState(channel);
    return normalizeGameState({ ...createInitialState(channel), ...stored, channel });
  }

  writeState(state: GameState): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO game_state (id, channel, document) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET channel = excluded.channel, document = excluded.document",
      state.channel,
      JSON.stringify(state),
    );
  }

  advance(channel: string, event: RoomEvent, now: number): ReduceOutput {
    let since = 0;
    const out = this.ctx.storage.transactionSync(() => {
      const state = this.readState(channel);
      since = state.revision;
      if (event.type === "admin" && event.action === "config") this.seedConfigHistory(state);
      const result = reduceGame(state, event, now);
      for (const userId of result.dirtyProfileIds) {
        const profile = result.state.players.find((item) => item.userId === userId);
        if (profile?.registered) upsertProfile(this, profile);
      }
      if (payDuels(this, result.state) || result.changed) this.writeState(result.state);
      if (result.resetAllRanks) this.resetAllRanks(result.state.config.initialElo);
      for (const userId of result.rankResetIds || []) {
        this.ctx.storage.sql.exec(
          "UPDATE profiles SET elo = ?, wins = 0, losses = 0 WHERE user_id = ?",
          result.state.config.initialElo,
          userId,
        );
        this.lookChanged(userId);
      }
      const set = result.result?.rankSet;
      if (set) {
        this.ctx.storage.sql.exec(
          "UPDATE profiles SET elo = ?, wins = ?, losses = ? WHERE user_id = ?",
          set.elo,
          set.wins,
          set.losses,
          set.userId,
        );
        this.lookChanged(set.userId);
        logRoomEvent(
          this,
          "command",
          // the /admin route sets both as strings
          `${(event.actorName || event.actorId) as string} restored rank ${set.elo}/${set.wins}/${set.losses} -> ${set.userId}`,
          {
            channel,
            action: "restoreRank",
            ...set,
          },
        );
      }
      for (const userId of result.deletedProfileIds || []) this.deleteProfile(userId);
      if (result.result?.reason === "config_updated") {
        this.recordConfigVersion(
          result.state.configVersion,
          result.state.config,
          event.actorId,
          event.note || "",
          now,
          event.actorName,
        );
      }
      return result;
    });
    // after the commit, so a rolled-back reduce logs nothing it didn't do (its error is logged by fetch or alarm)
    this.traceEvents(channel, out.state, since);
    return out;
  }

  // Each new game event: counted, printed to Workers Logs, and duel and chat events kept in the room log (server/tracker.ts).
  traceEvents(channel: string, state: GameState, since: number): void {
    for (const e of state.events) {
      if (Number(e.id) <= since) continue;
      count(this, "event_" + e.type);
      const source = /^(challenge|duel|rank|pair)_/.test(e.type)
        ? "duel"
        : e.type.startsWith("chat_")
          ? "chat"
          : "event";
      trace(this, source, e.type, { channel, ...e }, source !== "event");
    }
  }

  // Config history keeps every version so mods can review and roll back (see docs/CONTRACTS.md).
  seedConfigHistory(state: GameState): void {
    // COUNT(*) always returns one row
    const [{ n }] = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM config_history").toArray() as [
      { n: number },
    ];
    if (!n) this.recordConfigVersion(state.configVersion, state.config, "system", "initial", Date.now());
  }

  recordConfigVersion(
    version: number,
    config: Config,
    actorId: unknown,
    note: unknown,
    now: number,
    actorName: unknown = "",
  ): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "INSERT OR REPLACE INTO config_history (version, config, actor_id, actor_name, at, note) VALUES (?, ?, ?, ?, ?, ?)",
      version,
      JSON.stringify(config),
      String(actorId || "system"),
      String(actorName || ""),
      now,
      note,
    );
    sql.exec("DELETE FROM config_history WHERE version <= ?", version - 200);
  }

  async readJson(request: Request): Promise<ReadJson> {
    const length = Number(request.headers.get("content-length") || 0);
    if (length > 16 * 1024) return { ok: false, error: "request body too large" };
    try {
      const value = await request.json<JsonObject | null>(); // any JSON: only an object gets past the check below
      if (!value || typeof value !== "object" || Array.isArray(value))
        return { ok: false, error: "JSON object required" };
      return { ok: true, value };
    } catch {
      return { ok: false, error: "invalid JSON" };
    }
  }

  deleteProfile(userId: string): void {
    const login = this.ctx.storage.sql
      .exec<{ username: string }>("SELECT username FROM profiles WHERE user_id = ?", userId)
      .toArray()[0]?.username;
    if (login) this.lookGone(login);
    this.ctx.storage.sql.exec("DELETE FROM profiles WHERE user_id = ?", userId);
    this.ctx.storage.sql.exec("DELETE FROM owned_items WHERE user_id = ?", userId);
    this.ctx.storage.sql.exec("DELETE FROM builds WHERE user_id = ?", userId);
  }

  resetAllRanks(initialElo: number): void {
    this.ctx.storage.sql.exec("UPDATE profiles SET elo = ?, wins = 0, losses = 0", initialElo);
    this.looksReset = true;
    this.flushLooksSoon();
  }

  // ---------- look sync ----------
  // Every write to a saved fighter (website save, duel result, approved or removed sprite, rank reset, delete) is pushed
  // to open overlays as one {type:"looks"} message per turn of the event loop. It carries only viewers the active list
  // doesn't: snapshots already carry those, and a pushed look (masked while a duel result is hidden) must not overwrite
  // them. looks maps login -> look, or null for a deleted fighter; reset: every saved look is stale (all ranks reset).
  lookChanged(userId: unknown): void {
    (this.dirtyLooks ||= new Set()).add(String(userId));
    this.flushLooksSoon();
  }
  lookGone(login: string): void {
    (this.goneLooks ||= new Set()).add(String(login).toLowerCase());
    this.flushLooksSoon();
  }
  flushLooksSoon(): void {
    if (!this.lookFlush)
      this.lookFlush = setTimeout(() => {
        this.lookFlush = 0;
        this.flushLooks();
      }, 0);
  }
  flushLooks(): void {
    const ids = [...(this.dirtyLooks || [])],
      gone = [...(this.goneLooks || [])],
      reset = this.looksReset === true;
    this.dirtyLooks = new Set();
    this.goneLooks = new Set();
    this.looksReset = false;
    if (!ids.length && !gone.length && !reset) return;
    const sockets = this.ctx.getWebSockets("live");
    const channel = sockets
      .map((ws) => {
        try {
          // upgrade() attaches {kind, channel} to every socket
          return (ws.deserializeAttachment() as { channel?: string } | null)?.channel;
        } catch {
          return "";
        }
      })
      .find(Boolean);
    if (!channel) return;
    const state = this.readState(channel),
      hidden = hiddenResults(state, Date.now()),
      looks: { [login: string]: Look | null } = {};
    const listed = new Set(state.players.map((p) => p.userId)),
      wanted = ids.filter((id) => !listed.has(id));
    for (const login of gone) looks[login] = null;
    for (let i = 0; i < wanted.length; i += 50) {
      const part = wanted.slice(i, i + 50);
      const rows = this.ctx.storage.sql
        .exec<ProfileRow>(
          `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE user_id IN (${part.map(() => "?").join(",")})`,
          ...part,
        )
        .toArray();
      for (const row of rows) {
        const p = shownProfile(normalizeProfileRow(row, state.config), hidden);
        if (p) looks[p.username.toLowerCase()] = savedLook(p);
      }
    }
    if (!reset && !Object.keys(looks).length) return;
    const message = JSON.stringify({ type: "looks", looks, ...(reset ? { reset: true } : {}) } satisfies LiveMessage);
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(message);
      } catch {}
    }
  }

  publicState(state: GameState): Snapshot & { build: string } {
    return {
      type: "snapshot",
      channel: state.channel,
      revision: state.revision,
      paused: !state.chat.connected || !state.config.enabled,
      chat: {
        connected: Boolean(state.chat.connected),
        lastSeen: Number(state.chat.lastSeen) || 0,
        status: String(state.chat.status || "disconnected"),
        bot: this.botSource(state),
      },
      config: state.config,
      configVersion: state.configVersion,
      round: state.round,
      players: state.players.map((profile) => ({ ...profile })),
      duels: state.duels.map((duel) => ({ ...duel })),
      events: state.events.slice(-50).map((event) => ({ ...event })),
      build: String(this.env?.CF_VERSION_METADATA?.id || ""), // overlays reload themselves when a new deploy lands
      serverNow: Date.now(), // lets overlays on a PC with a wrong clock convert event times (arena-client.js)
    };
  }

  async upgrade(request: Request, kind: string, channel: string, overlay = false): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return json({ error: "websocket upgrade required" }, 426);
    const ip = request.headers.get("X-Mini-Client-Ip"),
      clientTag = ip ? "ip:" + ip.slice(0, 64) : null;
    if (clientTag && this.ctx.getWebSockets(clientTag).length >= MAX_SOCKETS_PER_CLIENT) {
      return json({ error: "too many overlay connections from this network" }, 429);
    }
    const live = this.ctx.getWebSockets("live");
    if (live.length >= MAX_LIVE_SOCKETS) {
      // Full: drop the oldest viewer-page socket for the new one. Overlay sockets (the streamer's OBS source) are never
      // dropped; when only overlays are left, the new socket is refused instead.
      const overlays = new Set(this.ctx.getWebSockets("overlay"));
      const spare = live.find((ws) => !overlays.has(ws));
      if (!spare) return json({ error: "room full" }, 503);
      try {
        spare.close(1013, "room full");
      } catch {}
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [kind, ...(clientTag ? [clientTag] : []), ...(overlay ? ["overlay"] : [])]); // "overlay": OBS browser sources, counted for /admin
    server.serializeAttachment({ kind, channel });
    const result = this.advance(channel, { type: "tick" }, Date.now());
    server.send(JSON.stringify(this.publicState(result.state)));
    if (result.changed) this.broadcast(result.state);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket): Promise<void> {
    // Overlay sockets are read-only snapshots. "ping" never reaches here: the auto-response in the constructor answers it.
    count(this, "ws_messages");
    try {
      ws.close(1008, "Read-only socket");
    } catch {}
  }

  async eventsub(channel: string, msg: BotMessage, origin = ""): Promise<Response> {
    const now = Date.now();
    const id = String(msg.messageId || "").slice(0, 100);
    if (!id) return json({ error: "messageId required" }, 400);
    for (const [key, at] of this.seenMessages) {
      // insertion order is arrival order
      if (now - at <= EVENTSUB_DEDUPE_MS && this.seenMessages.size <= MAX_EVENTSUB_IDS) break;
      this.seenMessages.delete(key);
    }
    const kind = String(msg.messageType || "");
    // Commands (and every bot message, which the Worker only sends for commands) are deduped durably in SQLite, so a
    // redelivery after a restart or to another isolate is ignored too; other lines only in memory (server/dedupe.ts).
    const durable =
      kind === "notification" && (msg.bot === true || /^\s*!/.test(String(msg.event?.message?.text || "")));
    if (kind !== "webhook_callback_verification") {
      if (durable ? !claimMessage(this.ctx.storage.sql, id, now) : this.seenMessages.has(id))
        return json({ ok: true, duplicate: true });
      this.seenMessages.set(id, now);
    }
    try {
      return await this.handleEventsub(channel, msg, origin, kind, now);
    } catch (error) {
      if (durable) releaseMessage(this.ctx.storage.sql, id);
      throw error;
    } // a failed message may be redelivered
  }

  async handleEventsub(channel: string, msg: BotMessage, origin: string, kind: string, now: number): Promise<Response> {
    const subscriptionId = String(msg.subscription?.id || "");
    count(this, msg.bot === true ? "eventsub_bot" : "eventsub_" + (kind || "unknown"));
    if (kind !== "notification")
      trace(this, "chat", "eventsub " + (kind || "unknown"), {
        channel,
        subscriptionId: subscriptionId.slice(0, 64),
        status: String(msg.subscription?.status || ""),
      });
    else {
      // every chat line, to Workers Logs only: the first word (a command name) and who, never the whole line
      const text = String(msg.event?.message?.text || "");
      trace(
        this,
        "chat",
        "heard",
        {
          channel,
          via: msg.bot === true ? "bot" : origin || "eventsub",
          user: normalizeUsername(msg.event?.chatter_user_login) || "?",
          first: text.trim().startsWith("!") ? text.trim().split(/\s+/)[0]!.slice(0, 32) : "", // split always has one item
          length: text.length,
        },
        false,
      );
    }
    let result: ChatOutcome;
    if (kind === "webhook_callback_verification")
      result = this.advance(channel, { type: "chat_verified", subscriptionId }, now);
    else if (kind === "revocation") {
      if (!subscriptionId || subscriptionId !== this.readState(channel).chat.subscriptionId)
        return json({ ok: true, ignored: true });
      result = this.advance(
        channel,
        { type: "chat_disconnected", reason: String(msg.subscription?.status || "revoked") },
        now,
      );
    } else if (kind === "notification" && msg.bot === true) return botCommand(this, channel, msg, origin);
    else if (kind === "notification") {
      await checkAccountAge(this, msg.event?.chatter_user_id);
      result = processChatMessage(
        this,
        channel,
        msg,
        now,
        await streamNews(this, channel, msg.event?.message?.text, now),
      );
    } else return json({ ok: true, ignored: true });
    if (result.visible) this.broadcast(result.state);
    if (result.changed) await this.scheduleAlarm(result.state);
    return json({ ok: Boolean(result.result?.ok), reason: String(result.result?.reason || "") });
  }

  seSettings(): SeSettings {
    const row = this.ctx.storage.sql
      .exec<{
        secret: string;
        names: string;
        last_command_at: number;
        rejected_at: number;
        seen_json: string;
        duel_module_off: number;
      }>("SELECT secret, names, last_command_at, rejected_at, seen_json, duel_module_off FROM se_settings WHERE id = 1")
      .toArray()[0];
    if (row) {
      const names: SeNames = { ...DEFAULT_SE_NAMES, ...safeJsonParse<SeNames>(row.names, {}) };
      if (names.accept === "!accept") names.accept = DEFAULT_SE_NAMES.accept; // StreamElements' Duel module owns !accept
      if (names.top === "!top") names.top = DEFAULT_SE_NAMES.top; // and its built-in !top can't be replaced
      if (names.give === "!give") names.give = DEFAULT_SE_NAMES.give; // nor its !givepoints alias !give
      if (names.help === "!minichat") names.help = DEFAULT_SE_NAMES.help; // the old name, from before the rename to PixFray
      const stored = safeJsonParse<{ [action: string]: unknown }>(row.seen_json, {}),
        seen: { [action: string]: number } = {};
      for (const action of SE_ACTIONS) if (Number(stored?.[action]) > 0) seen[action] = Number(stored[action]);
      return {
        secret: row.secret,
        names,
        lastCommandAt: Number(row.last_command_at) || 0,
        rejectedAt: Number(row.rejected_at) || 0,
        seen,
        duelModuleOff: row.duel_module_off === 1,
      };
    }
    const secret = randomHex();
    this.writeSeSettings(secret, DEFAULT_SE_NAMES);
    return { secret, names: { ...DEFAULT_SE_NAMES }, lastCommandAt: 0, rejectedAt: 0, seen: {}, duelModuleOff: false };
  }

  writeSeSettings(secret: string, names: SeNames): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO se_settings (id, secret, names) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET secret = excluded.secret, names = excluded.names",
      secret,
      JSON.stringify(names),
    );
  }

  // A connected PixFray chat bot (test site, CHAT_BOT=1): an EventSub subscription that reads chat as the bot account.
  botSource(state: GameState): boolean {
    const id = state.chat.subscriptionId;
    return (
      this.env?.CHAT_BOT === "1" &&
      state.chat.connected &&
      Boolean(id) &&
      id !== SE_SUBSCRIPTION_ID &&
      !id.startsWith("local-")
    );
  }

  // The bot's health row (bot_status), as the admin page reads it.
  botStatus() {
    const r =
      this.ctx.storage.sql.exec<BotStatusRow>("SELECT * FROM bot_status WHERE id = 1").toArray()[0] ||
      ({} as Partial<BotStatusRow>); // no row: every field falls back below
    return {
      heardAt: r.heard_at || 0,
      heard: r.heard || "",
      sentAt: r.sent_at || 0,
      sent: r.sent_total || 0,
      failedAt: r.failed_at || 0,
      failed: r.failed_total || 0,
      failedReason: r.failed_reason || "",
      failedText: r.failed_reason ? botDropText(r.failed_reason) : "",
      heldAt: r.held_at || 0,
      heldReason: r.held_reason || "",
      recent: (this.botReplies || []).filter((at) => Date.now() - at < 30000).length,
      cap: BOT_REPLIES_PER_30S,
    };
  }

  lookupAccount(userId: string): Promise<number> {
    return accountCreatedAt(this.env, userId);
  }

  // After a finished duel the stored profiles must match the game state, or the next command undoes the result.
  checkSavedProfiles(state: GameState, duelId: string | undefined): void {
    const duel = state.duels.find((d) => d.id === duelId);
    for (const id of duel ? [duel.a, duel.b] : []) {
      const p = state.players.find((x) => x.userId === id);
      if (!p?.registered) continue;
      const row = this.ctx.storage.sql
        .exec<Pick<ProfileTable, "elo" | "wins" | "losses">>(
          "SELECT elo, wins, losses FROM profiles WHERE user_id = ?",
          id,
        )
        .toArray()[0];
      if (!row || row.elo !== p.elo || row.wins !== p.wins || row.losses !== p.losses) {
        logRoomEvent(this, "warn", `profile for ${p.username} not saved after ${duelId}`, {
          channel: state.channel,
          userId: id,
          game: { elo: p.elo, wins: p.wins, losses: p.losses },
          saved: row || null,
        });
      }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "Socket error");
    } catch {}
  }

  broadcast(state: GameState): void {
    const message = JSON.stringify(this.publicState(state) satisfies LiveMessage);
    for (const ws of this.ctx.getWebSockets("live")) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(message);
      } catch {}
    }
  }

  // Every time the room has work to do, with why. scheduleAlarm sets the earliest; alarm() names the ones it ran for.
  alarmDue(state: GameState, now: number): { at: number; why: string }[] {
    const due: { at: number; why: string }[] = [];
    const chatDue = chatCheckDue(state);
    if (chatDue !== null) due.push({ at: chatDue, why: "chat_check" });
    for (const duel of state.duels) {
      if (duel.status === "pending") due.push({ at: duel.expiresAt + 1, why: "challenge_expiry" });
      else if (duel.status === "active")
        due.push({
          at: duel.lastActionAt! + (duel.rules?.inactivityMs || state.config.inactivityMs) + 1, // set when a duel starts
          why: "duel_inactivity",
        });
    }
    for (const profile of state.players) if (profile.respawnAt > 0) due.push({ at: profile.respawnAt, why: "respawn" });
    for (const lock of state.rematchLocks) due.push({ at: lock.until, why: "rematch_lock" });
    // a bot channel announces each duel's result once the stream has played it
    if (this.botSource(state) && state.config.botEnabled !== false)
      for (const duel of state.duels)
        // revealAt! : set when a duel completes
        if (duel.status === "completed" && duel.revealAt! > now)
          due.push({ at: duel.revealAt! + 1, why: "result_reveal" });
    if (this.dueResults(state, now).length) due.push({ at: now + RESULT_RETRY_MS, why: "result_retry" }); // one that couldn't go out yet
    const reminder = this.reminderDue(state);
    if (reminder) due.push({ at: reminder, why: "reminder" });
    return due;
  }

  async scheduleAlarm(state: GameState): Promise<void> {
    const now = Date.now(),
      due = this.alarmDue(state, now);
    if (!due.length) {
      if (this.alarmAt !== null) trace(this, "alarm", "cleared", { channel: state.channel });
      this.alarmAt = null;
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const next = due.reduce((a, b) => (b.at < a.at ? b : a)),
      at = Math.max(now + 1, next.at);
    // traced only when the target moves; the same alarm set again by every command would flood the log
    if (at !== this.alarmAt)
      trace(this, "alarm", "set " + next.why, { channel: state.channel, inMs: at - now, due: due.length });
    this.alarmAt = at;
    await this.ctx.storage.setAlarm(at);
  }

  // Errors are logged (owner diagnostics) and the next alarm is always set, so one failure can't stall result lines.
  async alarm(): Promise<void> {
    const row = this.readStoredState();
    if (!row) return;
    const channel = normalizeChannel(row.channel);
    if (!channel) return;
    // why it ran, from the state itself: a woken room has none of the reasons scheduleAlarm saw
    const now = Date.now(),
      ran = this.alarmDue(this.readState(channel), now).filter((d) => d.at <= now);
    this.alarmAt = undefined;
    noteAlarm(
      this,
      [...new Set(ran.map((d) => d.why))],
      ran.length ? now - Math.min(...ran.map((d) => d.at)) : null,
      channel,
    );
    try {
      await this.alarmTasks(channel);
    } catch (error) {
      logRoomError(this, error, { path: "alarm", method: "ALARM" });
    }
    await this.scheduleAlarm(this.readState(channel));
    settleCounts(this, true);
  }

  async alarmTasks(channel: string): Promise<void> {
    const since = this.readState(channel).revision;
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
        const event: GameEvent =
          !status || status === "webhook_callback_verification_pending"
            ? { type: "chat_checked" }
            : status === "enabled"
              ? state.chat.connected
                ? { type: "chat_checked" }
                : { type: "chat_verified", subscriptionId }
              : { type: "chat_disconnected", reason: status === "missing" ? "subscription_missing" : status };
        result = this.advance(channel, event, Date.now());
        let visible = result.visible;
        if (event.type === "chat_verified") {
          result = this.advance(channel, { type: "chat_checked" }, Date.now());
          visible ||= result.visible;
        }
        if (visible) this.broadcast(result.state);
      }
    }
    await postExpired(this, channel, since);
    await postResults(this, channel, Date.now());
    await this.postReminder(channel, Date.now());
  }

  dueResults(state: GameState, now: number): DueDuel[] {
    if (!this.botSource(state)) return [];
    const sql = this.ctx.storage.sql,
      row = sql.exec<{ results_through: number }>("SELECT results_through FROM bot_reminder WHERE id = 1").toArray()[0];
    if (!row) return [];
    // With the bot off, results are skipped for good, so turning it back on doesn't post a backlog.
    if (state.config.botEnabled === false) {
      if (row.results_through < now) sql.exec("UPDATE bot_reminder SET results_through = ? WHERE id = 1", now);
      return [];
    }
    // read as due: the filter drops a duel without ratings, and one without revealAt compares false
    return (state.duels as DueDuel[])
      .filter(
        (d) =>
          d.status === "completed" &&
          d.ratings &&
          d.revealAt > row.results_through &&
          d.revealAt <= now &&
          now - d.revealAt < RESULT_WINDOW_MS,
      )
      .sort((x, y) => x.revealAt - y.revealAt);
  }

  // When the next !fray reminder is due, or 0: only with the bot connected, a known bot account, the bot on and config.reminderMin > 0.
  // The first one comes a full interval after the reminder is turned on (or the room first sees the bot).
  reminderDue(state: GameState, now = Date.now()): number {
    const every = Number(state.config.reminderMin) || 0,
      sql = this.ctx.storage.sql;
    const row = sql.exec<{ next_at: number }>("SELECT next_at FROM bot_reminder WHERE id = 1").toArray()[0];
    if (!row) return 0;
    if (!every || !this.botSource(state) || state.config.botEnabled === false) {
      if (row.next_at) sql.exec("UPDATE bot_reminder SET next_at = 0 WHERE id = 1");
      return 0;
    }
    const latest = now + every * 60000;
    if (!row.next_at || row.next_at > latest) {
      sql.exec("UPDATE bot_reminder SET next_at = ? WHERE id = 1", latest);
      return latest;
    }
    return row.next_at;
  }

  // Posts the reminder as the bot when it's due and Twitch says the channel is live. Offline, it just waits another interval.
  async postReminder(channel: string, now: number): Promise<void> {
    const state = this.readState(channel),
      due = this.reminderDue(state, now);
    if (!due || now < due) return;
    const sql = this.ctx.storage.sql,
      row = sql
        .exec<{ broadcaster_id: string; bot_id: string; origin: string }>(
          "SELECT broadcaster_id, bot_id, origin FROM bot_reminder WHERE id = 1",
        )
        .toArray()[0]!; // reminderDue answers 0 without the row
    sql.exec("UPDATE bot_reminder SET next_at = ? WHERE id = 1", now + state.config.reminderMin * 60000);
    try {
      if (!(await currentStream(this, channel, now))) return;
      const out = await sendChatMessage(this.env, {
        broadcasterId: row.broadcaster_id,
        senderId: row.bot_id,
        message: seReminderText({ names: botNames(this.seSettings().names), origin: row.origin, channel }),
      });
      if (out.sent) logRoomEvent(this, "command", "bot reminder sent", { channel, via: "reminder" });
      noteBotSent(this, channel, [out], "reminder");
    } catch (error) {
      noteBotSent(this, channel, [{ sent: false, reason: errorText(error) }], "reminder");
    }
  }
}
