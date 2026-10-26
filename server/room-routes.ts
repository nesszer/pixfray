import { chatStatus, defaultConfig, hiddenResults, parseGameCommand, reduceGame, shownProfile } from "./game.ts";
import { customUsage, handleRoomAssets } from "./uploads.ts";
import type { CatalogEntry } from "./uploads.ts";
import { rankBefore } from "./ranklog.ts";
import { handleRoomDeveloper, logRoomEvent } from "./developer.ts";
import { cleanStats, emptyStats, hatUnlocked, knownHat, upgradeRules, validStats } from "./upgrades.ts";
import { handleRoomPoints, pointsView } from "./points.ts";
import { handleRoomPets, petCatalog, petOf } from "./pets.ts";
import { handleRoomSprites, spriteCatalog } from "./sprites.ts";
import type { SpriteRow } from "./sprites.ts";
import {
  buildOf,
  COSMETIC_FIELDS,
  COSMETIC_KINDS,
  cosmeticCatalog,
  cosmeticItem,
  MAX_BUILDS,
  slotPrice,
} from "./cosmetics.ts";
import { DEFAULT_SE_NAMES, SE_ACTIONS, seKeyHash, seReplyText } from "./streamelements.ts";
import type { SeNames } from "./streamelements.ts";
import {
  parseBotSent,
  parseCheckinTest,
  parseDevChat,
  parseProfileInput,
  parseRoomAdminBody,
  parseRoomDevLive,
  parseRoomEventsub,
  parseSeAdmin,
} from "./parse.ts";
import type { DevAccount, Parsed, ProfileInput } from "./parse.ts";
import type { AdminEvent, Cosmetics, GameEvent, GameResult, GameState } from "./model.ts";
import {
  boardOrder,
  getProfile,
  json,
  MAX_DOLLARS,
  normalizeProfileRow,
  normalizeUsername,
  own,
  PROFILE_COLUMNS,
  randomHex,
  safeJsonParse,
  savedLook,
  text,
  upsertProfile,
  validUserId,
} from "./room-shared.ts";
import type { BotMessage, JsonObject, Look, Profile, ProfileRow, SavedProfile } from "./room-shared.ts";
import {
  botCommands,
  checkAccountAge,
  editBotCommands,
  noteBotSent,
  processChatMessage,
  QUICK_COMMANDS,
  streamElements,
} from "./room-bot.ts";
import {
  builds,
  buildSlots,
  buy,
  checkinTest,
  giftDollars,
  owned,
  reroll,
  resetPair,
  streamNews,
} from "./room-economy.ts";
import type { ChannelRoom } from "./channel.ts";

/** A config_history row. */
type ConfigHistoryRow = {
  version: number;
  config: string;
  actor_id: string;
  actor_name: string;
  at: number;
  note: string;
};
/** saveProfile's answer. */
type SaveResult =
  | { ok: false; reason: string | undefined; status?: number; profile?: undefined; state?: undefined }
  | { ok: true; profile: SavedProfile; state: GameState; reason?: undefined; status?: undefined };
/** What every room route gets: the request, its URL, the path without trailing slashes and the checked channel. */
type Ctx = { request: Request; url: URL; path: string; channel: string };
type Handler = (room: ChannelRoom, ctx: Ctx) => Response | Promise<Response>;
type BodyHandler<T> = (room: ChannelRoom, ctx: Ctx, body: T) => Response | Promise<Response>;
/** A POST /admin request after its checks. */
type AdminAsk = { channel: string; action: string; actorId: string; actorName: string; payload: JsonObject };
const USER_HEADER = "X-Mini-User-Id";
const MAX_CONFIG_HISTORY = 50;
const CHECKIN_TEST_MS = 15 * 60_000; // check-in test mode switches itself off after this
const MAX_LOOKS = 20; // logins per /looks call
const EXPORT_TABLES = [
  "game_state",
  "profiles",
  "config_history",
  "se_settings",
  "custom_characters",
  "builds",
  "streams",
  "custom_pets",
  "owned_items",
  "viewer_sprites",
];
const SHOP_STATUS = {
  no_fighter: 404,
  ...Object.fromEntries(
    ["not_enough", "owned", "max_slots", "price_changed", "rerolled", "in_duel"].map((r) => [r, 409]),
  ),
};
const PROFILE_STATUS = { profile_not_found: 404 };

// A route that needs a JSON object body.
function withBody(handler: BodyHandler<JsonObject>): Handler {
  return async (room, ctx) => {
    const body = await room.readJson(ctx.request);
    return body.ok ? handler(room, ctx, body.value) : json({ error: body.error }, 400);
  };
}
// withBody plus a server/parse.ts check of its fields.
function parsed<T>(parse: (body: JsonObject) => Parsed<T>, handler: BodyHandler<T>): Handler {
  return withBody((room, ctx, body) => {
    const out = parse(body);
    return out.ok ? handler(room, ctx, out.value) : json({ error: out.error }, 400);
  });
}
// Test site only (worker dev token): elsewhere the route doesn't exist, whatever the body.
function devOnly(handler: Handler): Handler {
  return (room, ctx) => (room.env?.DEV_TOOLS_TOKEN ? handler(room, ctx) : text("Not found", 404));
}
// A failed result also carries its reason as `error`, with the status mapped for that reason (else 400).
function answer(out: { ok: boolean; reason?: string }, status: { [reason: string]: number } = {}): Response {
  return json(out.ok ? out : { ...out, error: out.reason }, out.ok ? 200 : (own(status, out.reason || "") ?? 400));
}

export async function route(room: ChannelRoom, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const channel = room.requestChannel(request);
  if (!channel) return json({ error: "invalid or missing channel" }, 400);
  const stored = room.readStoredState();
  if (stored && stored.channel !== channel) return json({ error: "channel binding mismatch" }, 409);
  // every key holds a space, so no Object.prototype name can match
  const handler = ROUTES[`${request.method} ${path}`] ?? PREFIXES.find(([prefix]) => prefix.test(path))?.[1];
  return handler ? handler(room, { request, url, path, channel }) : text("Not found", 404);
}

const ROUTES: { [route: string]: Handler } = {
  // Owner dev token only (server/worker.ts /api/devtools/:channel/export): every row of the tables a copy needs. BLOBs as {$b64}.
  "GET /export": (room) => {
    const bytes = (v: ArrayBuffer | ArrayBufferView) =>
      v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    const b64 = (v: unknown) =>
      v instanceof ArrayBuffer || ArrayBuffer.isView(v)
        ? { $b64: btoa(Array.from(bytes(v), (c) => String.fromCharCode(c)).join("")) }
        : v;
    const out: { [table: string]: unknown } = {};
    for (const table of EXPORT_TABLES)
      out[table] = room.ctx.storage.sql
        .exec(`SELECT * FROM ${table}`)
        .toArray()
        .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, b64(v)])));
    return json(out);
  },
  "GET /state": async (room, { channel }) => {
    const changed = room.advance(channel, { type: "tick" }, Date.now());
    if (changed.changed) {
      room.broadcast(changed.state);
      await room.scheduleAlarm(changed.state);
    }
    return json(room.publicState(changed.state));
  },
  // The catalog is the mods' uploads plus approved viewer sprites (each with the `owner` who alone may wear it).
  "GET /catalog": async (room, { request, path, channel }) => {
    const custom = await (await handleRoomAssets(room, request, { path, channel })).json<CatalogEntry[]>(); // the /catalog list
    return json([...custom, ...spriteCatalog(room.ctx.storage.sql, channel)]);
  },
  // The shop list with this channel's prices (public): pets, hat price per win, cosmetics and build slot prices.
  "GET /shop": (room, { channel }) => {
    const config = room.readState(channel).config;
    return json({
      pets: petCatalog(room.ctx.storage.sql, channel, config),
      hatPricePerWin: config.hatPricePerWin,
      items: cosmeticCatalog(config),
      slots: { max: MAX_BUILDS, prices: Array.from({ length: MAX_BUILDS - 1 }, (_, i) => slotPrice(i + 1, config)) },
    });
  },
  // Buy a pet, a hat, a cosmetic or a build slot with PixFray dollars (signed-in viewer; the Worker sets the user header).
  "POST /shop": withBody((room, { request, channel }, body) => {
    const userId = validUserId(request.headers.get(USER_HEADER));
    if (!userId || userId !== validUserId(body.userId)) return json({ error: "profile identity mismatch" }, 403);
    // the Worker's parseShopBuy passed only a string id; a reroll looks it up and finds nothing else
    const bought =
      body.kind === "reroll" ? reroll(room, channel, userId, String(body.id)) : buy(room, channel, userId, body);
    if (bought.ok && "state" in bought && bought.state) room.broadcast(bought.state);
    return answer(bought, SHOP_STATUS);
  }),
  "GET /admin": (room, { channel }) => {
    const state = room.readState(channel);
    room.seedConfigHistory(state);
    const history = room.ctx.storage.sql
      .exec<ConfigHistoryRow>(
        "SELECT version, config, actor_id, actor_name, at, note FROM config_history ORDER BY version DESC LIMIT ?",
        MAX_CONFIG_HISTORY,
      )
      .toArray()
      .map((row) => ({
        version: row.version,
        config: safeJsonParse(row.config, {}),
        actorId: row.actor_id,
        actorName: row.actor_name,
        at: row.at,
        note: row.note,
      }));
    return json({
      ...room.publicState(state),
      chatStatus: chatStatus(state),
      history,
      customUsage: customUsage(room),
      streamelements: room.seSettings(),
      overlays: room.ctx.getWebSockets("overlay").length,
      checkinTest: checkinTest(room),
      botCommands: botCommands(room),
      botStatus: room.botStatus(),
      points: pointsView(room),
    });
  },
  // Dollars and style dollars are private: the Worker asks for them (?private=1) only for mods and the owner.
  "GET /leaderboard": (room, { url, channel }) => {
    const board = leaderboard(room, channel);
    return json(url.searchParams.get("private") === "1" ? board : board.map(({ dollars, styleDollars, ...p }) => p));
  },
  // Saved looks by login for the overlay (?u=a,b,c, at most 20): only viewers with a saved fighter are listed.
  "GET /looks": (room, { url, channel }) => {
    const logins = [
      ...new Set(
        String(url.searchParams.get("u") || "")
          .split(",")
          .map(normalizeUsername)
          .filter((u) => /^[a-z0-9_]+$/.test(u)),
      ),
    ].slice(0, MAX_LOOKS);
    if (!logins.length) return json({});
    const state = room.readState(channel),
      hidden = hiddenResults(state, Date.now()),
      out: { [login: string]: Look } = {};
    const rows = room.ctx.storage.sql
      .exec<ProfileRow>(
        `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE lower(username) IN (${logins.map(() => "?").join(",")})`,
        ...logins,
      )
      .toArray();
    for (const row of rows) {
      const p = shownProfile(normalizeProfileRow(row, state.config), hidden);
      out[p.username.toLowerCase()] = savedLook(p);
    }
    return json(out);
  },
  "GET /profile": (room, { url, channel }) => {
    const userId = validUserId(url.searchParams.get("userId"));
    if (!userId) return json({ error: "valid userId required" }, 400);
    const state = room.readState(channel);
    const hidden = hiddenResults(state, Date.now());
    // shownProfile hands a null profile back unchanged, as the check below expects
    const profile = shownProfile(getProfile(room, userId, state.config) as Profile, hidden);
    if (!profile) return json(null);
    // A knocked-out fighter (hp 0, respawnAt) would give away a result the stream hasn't shown yet.
    const active = !hidden.has(userId) && state.players.find((item) => item.userId === userId);
    return json({
      ...profile,
      ...(active ? { hp: active.hp, lastSeen: active.lastSeen, respawnAt: active.respawnAt } : {}),
      upgrades: upgradeRules(profile, state.config.maxStatLevel),
      owned: owned(room, userId),
      builds: builds(room, profile),
    });
  },
  "POST /profile": withBody(async (room, { request, channel }, body) => {
    const actorId = validUserId(request.headers.get(USER_HEADER));
    const requestedId = validUserId(body.userId);
    const login = normalizeUsername(body.username) || actorId || "?";
    const logCtx = { channel, action: "save", userId: actorId, user: login };
    const input = parseProfileInput(body);
    const result: SaveResult =
      !actorId || !requestedId || actorId !== requestedId
        ? { ok: false, reason: "identity_mismatch", status: 403 }
        : input.ok
          ? saveProfile(room, channel, actorId, input.value)
          : { ok: false, reason: input.error };
    if (!result.ok) {
      logRoomEvent(room, "warn", `${login} profile not saved: ${result.reason}`, { ...logCtx, reason: result.reason });
      const error = result.reason === "identity_mismatch" ? "profile identity mismatch" : result.reason;
      return json({ error }, result.status || 400);
    }
    logRoomEvent(room, "command", `${login} saved profile`, { ...logCtx, reason: "saved" });
    room.broadcast(result.state);
    await room.scheduleAlarm(result.state);
    const shown = shownProfile(result.profile, hiddenResults(result.state, Date.now()));
    return json({
      profile: {
        ...shown,
        upgrades: upgradeRules(shown, result.state.config.maxStatLevel),
        owned: owned(room, actorId),
        builds: builds(room, shown),
      },
      revision: result.state.revision,
    });
  }),
  "POST /admin": withBody(async (room, { channel }, body) => {
    const actorId = validUserId(body.actorId);
    if (!actorId) return json({ error: "authorized actor required" }, 403);
    const admin = parseRoomAdminBody(body);
    if (!admin.ok) return json({ ok: false, reason: admin.error, error: admin.error }, 400);
    const { action } = admin.value,
      ask = { channel, action, actorId, actorName: admin.value.actorName.slice(0, 48), payload: admin.value.payload };
    const special = own(ADMIN_ACTIONS, action);
    if (special) return special(room, ask);
    const rewritten = own(ADMIN_PAYLOADS, action)?.(room, ask.payload) ?? { payload: ask.payload };
    if (rewritten instanceof Response) return rewritten;
    const { payload, note } = rewritten;
    const targetId = validUserId(payload.userId);
    const event: AdminEvent = {
      type: "admin",
      actorId,
      actorName: ask.actorName,
      action: action === "rollbackConfig" ? "config" : action,
      payload,
      targetProfile: targetId ? getProfile(room, targetId, room.readState(channel).config) : null,
      // parseAdminBody checked the note is a string when sent; a rolled-back version's patch has none
      note: note || (typeof payload.note === "string" ? payload.note : "").slice(0, 200),
    };
    const result = room.advance(channel, event, Date.now());
    if (!result.result.ok) return answer(result.result, { unauthorized: 403, config_version_conflict: 409 });
    room.broadcast(result.state);
    await room.scheduleAlarm(result.state);
    return json({ ...result.result, revision: result.state.revision });
  }),
  "GET /live": (room, { request, url, channel }) =>
    room.upgrade(request, "live", channel, url.searchParams.get("role") === "overlay"),
  // Worker-only routes (never reachable from /api/admin): verified EventSub messages and subscription bookkeeping.
  // What Twitch said about the bot's replies to one command, posted by the Worker after sending them.
  "POST /bot-sent": parsed(parseBotSent, (room, { channel }, sent) => {
    noteBotSent(room, channel, sent.results.slice(0, 10));
    return json({ ok: true });
  }),
  // the Worker forwards a verified EventSub body, its event cut down by slimEvent
  "POST /eventsub": parsed(parseRoomEventsub, (room, { url, channel }, msg) =>
    room.eventsub(channel, msg, url.searchParams.get("origin") || ""),
  ),
  // StreamElements custom commands, forwarded by the Worker from GET /api/se/<channel>/<action>.
  "POST /se": withBody(async (room, { url, channel }, body) => {
    const res = await streamElements(room, channel, body, url.searchParams.get("origin") || "");
    // The Worker keeps the current key's hash for a minute, so random keys are refused there without waking this room.
    const secret = room.seSettings()?.secret;
    if (secret) res.headers.set("X-Se-Key", await seKeyHash(secret));
    return res;
  }),
  "POST /se-admin": parsed(parseSeAdmin, (room, _ctx, body) => {
    const current = room.seSettings();
    if (body.action === "rotateSeKey") {
      room.writeSeSettings(randomHex(), current.names);
      room.ctx.storage.sql.exec(
        "UPDATE se_settings SET last_command_at = 0, rejected_at = 0, seen_json = '{}' WHERE id = 1",
      ); // a new key starts unheard
    } else if (body.action === "setSeNames") {
      const names: SeNames = {};
      for (const action of SE_ACTIONS) {
        const name = String(
          // SE_ACTIONS are DEFAULT_SE_NAMES's keys
          body.names[action] ?? current.names[action] ?? DEFAULT_SE_NAMES[action as keyof typeof DEFAULT_SE_NAMES],
        ).trim();
        if (!/^!?[a-z0-9_]{1,24}$/i.test(name)) return json({ error: `Invalid command name for ${action}` }, 400);
        names[action] = (name.startsWith("!") ? name : "!" + name).toLowerCase();
      }
      if (new Set(Object.values(names)).size !== SE_ACTIONS.length)
        return json({ error: "Each action needs its own command name" }, 400);
      room.writeSeSettings(current.secret, names);
    } else if (body.action === "setDuelModuleOff") {
      room.ctx.storage.sql.exec("UPDATE se_settings SET duel_module_off = ? WHERE id = 1", body.value ? 1 : 0);
    } else return json({ error: "unknown StreamElements action" }, 400);
    return json({ ok: true, streamelements: room.seSettings() });
  }),
  // Check-in test mode (mods, via /api/admin action checkinTest): {on:true} for CHECKIN_TEST_MS, {on:false} ends it.
  "POST /checkin-test": parsed(parseCheckinTest, (room, _ctx, body) => {
    if (body.on)
      room.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO checkin_test (id, until, by_name) VALUES (1, ?, ?)",
        Date.now() + CHECKIN_TEST_MS,
        body.by.slice(0, 48),
      );
    else room.ctx.storage.sql.exec("DELETE FROM checkin_test");
    return json({ ok: true, checkinTest: checkinTest(room) });
  }),
  // One chat line as if Twitch had delivered it on the current subscription.
  "POST /dev-chat": devOnly(parsed(parseDevChat, devChat)),
  // Add style dollars to a saved fighter (or take them back), as a channel point redemption would.
  "POST /dev-style": devOnly(
    withBody((room, _ctx, { userId, amount }) => {
      const sql = room.ctx.storage.sql;
      if (typeof userId !== "string" || typeof amount !== "number" || !Number.isInteger(amount))
        return json({ error: "userId and amount required" }, 400);
      const row = sql
        .exec<{ style_dollars: number }>("SELECT style_dollars FROM profiles WHERE user_id = ?", userId)
        .toArray()[0];
      if (!row) return json({ error: "no_fighter" }, 404);
      const styleDollars = Math.max(0, Math.min(MAX_DOLLARS, row.style_dollars + amount));
      sql.exec("UPDATE profiles SET style_dollars = ? WHERE user_id = ?", styleDollars, userId);
      return json({ ok: true, userId, styleDollars });
    }),
  ),
  // Pretend the channel is live ({live:true}, a new stream id unless streamId is given), offline ({live:false}), or
  // ask Twitch again ({live:null}).
  "POST /dev-live": devOnly(
    parsed(parseRoomDevLive, (room, _ctx, { live, streamId }) => {
      const sql = room.ctx.storage.sql;
      if (typeof live !== "boolean") sql.exec("DELETE FROM dev_live");
      else
        sql.exec(
          "INSERT OR REPLACE INTO dev_live (id, stream_id, started_at) VALUES (1, ?, ?)",
          live ? "dev-" + (/^[a-z0-9_-]{1,36}$/i.test(streamId) ? streamId : randomHex().slice(0, 12)) : "",
          Date.now(),
        );
      const row = sql.exec<{ stream_id: string }>("SELECT stream_id FROM dev_live WHERE id = 1").toArray()[0];
      return json({ ok: true, live: row ? Boolean(row.stream_id) : null, streamId: row?.stream_id || "" });
    }),
  ),
  "GET /chat": (room, { channel }) => json(chatStatus(room.readState(channel))),
  "POST /chat": withBody(async (room, { channel }, body) => {
    const event: GameEvent | null =
      body.action === "connected"
        ? {
            type: "chat_subscription",
            subscriptionId: body.subscriptionId,
            status: body.status,
            createdAt: body.createdAt,
          }
        : body.action === "disconnected"
          ? { type: "chat_disconnected", reason: body.reason }
          : null;
    if (!event) return json({ error: "unknown chat action" }, 400);
    const result = room.advance(channel, event, Date.now());
    if (result.visible) room.broadcast(result.state);
    await room.scheduleAlarm(result.state);
    return json({ ...result.result, revision: result.state.revision, chatStatus: chatStatus(result.state) });
  }),
};

// Path families that own their methods and subpaths, tried in this order after the exact routes.
const PREFIXES: [RegExp, Handler][] = [
  [
    /^\/(sprites(\/|$)|asset\/v-)/,
    async (room, { request, url, path, channel }) => {
      let changed: GameState | null = null;
      const response = await handleRoomSprites(room, request, {
        path,
        url,
        channel,
        hooks: {
          approved: (row, previous) => {
            changed = wearSprite(room, channel, row, previous) || changed;
          },
          removed: (id) => {
            changed = dropSprite(room, channel, id) || changed;
          },
        },
      });
      if (changed) room.broadcast(changed);
      return response;
    },
  ],
  [
    /^\/(catalog$|asset(\/|$))/,
    (room, { request, path, channel }) => handleRoomAssets(room, request, { path, channel }),
  ],
  [/^\/dev\//, (room, { request, url, path, channel }) => handleRoomDeveloper(room, request, { path, channel, url })],
  [
    /^\/points(\/|$)/,
    (room, { request, path, channel }) => handleRoomPoints(room, request, { path, channel, maxDollars: MAX_DOLLARS }),
  ],
  [
    /^\/pets(\/|$)/,
    async (room, { request, path, channel }) => {
      // A deleted upload leaves the fighters using it with no pet; the stored profiles are cleared by handleRoomPets.
      let cleared: GameState | null = null;
      const response = await handleRoomPets(room, request, {
        path,
        channel,
        config: room.readState(channel).config,
        onDelete: (id) => {
          const state = room.readState(channel);
          let hit = false;
          for (const p of state.players)
            if (p.pet === id) {
              Object.assign(p, { pet: "", petTier: "", petBoost: emptyStats() });
              hit = true;
            }
          if (hit) {
            state.revision += 1;
            room.writeState(state);
            cleared = state;
          }
        },
      });
      if (cleared) room.broadcast(cleared);
      return response;
    },
  ],
];

// Admin actions the room answers itself instead of the game reducer.
const ADMIN_ACTIONS: { [action: string]: (room: ChannelRoom, ask: AdminAsk) => Response } = {
  giftDollars: (room, { channel, payload, actorId, actorName }) =>
    answer(giftDollars(room, channel, payload, actorId, actorName), PROFILE_STATUS),
  resetPair: (room, { channel, payload, actorId, actorName }) =>
    answer(resetPair(room, channel, payload.a, payload.b, actorId, actorName), PROFILE_STATUS),
  saveCommand: editCommands,
  deleteCommand: editCommands,
  setCounter: editCommands,
};
function editCommands(room: ChannelRoom, { channel, action, payload, actorId, actorName }: AdminAsk): Response {
  const out = editBotCommands(room, channel, action, payload, actorName || actorId);
  return out.ok ? json({ ...out, botCommands: botCommands(room) }) : answer(out);
}
// Admin actions whose payload is rewritten before the reducer sees it; a Response ends the request there.
const ADMIN_PAYLOADS: {
  [action: string]: (room: ChannelRoom, payload: JsonObject) => { payload: JsonObject; note?: string } | Response;
} = {
  rollbackConfig(room, payload) {
    const version = Number(payload.version);
    const row = Number.isInteger(version)
      ? room.ctx.storage.sql
          .exec<Pick<ConfigHistoryRow, "config">>("SELECT config FROM config_history WHERE version = ?", version)
          .toArray()[0]
      : null;
    if (!row) return json({ ok: false, reason: "config_version_not_found", error: "config_version_not_found" }, 404);
    // A version saved before a setting existed has no value for it; it goes back to its default, not the current value.
    return {
      payload: { patch: { ...defaultConfig(), ...safeJsonParse(row.config, {}) } },
      note: "rollback to v" + version,
    };
  },
  // restoreRank {userId, before}: the fighter's last recorded rank before that time (server/ranklog.ts).
  restoreRank(room, payload) {
    if (!Number.isInteger(payload.before)) return { payload };
    const rank = rankBefore(room.ctx.storage.sql, validUserId(payload.userId) || "", payload.before);
    if (!rank) return json({ ok: false, reason: "no_rank_history", error: "no_rank_history" }, 404);
    return { payload: { userId: payload.userId, ...rank } };
  },
};

// Test site: the reply is the line a StreamElements bot would post.
async function devChat(room: ChannelRoom, { channel }: Ctx, body: DevAccount): Promise<Response> {
  const { userId, username, displayName, text: line } = body;
  const now = Date.now(),
    messageId = "dev:" + randomHex().slice(0, 24);
  const msg: BotMessage = {
    messageId,
    timestamp: now,
    subscription: { id: room.readState(channel).chat.subscriptionId || "" },
    event: {
      chatter_user_id: userId,
      chatter_user_login: username,
      chatter_user_name: displayName,
      message_id: messageId,
      message: { text: line },
    },
  };
  await checkAccountAge(room, userId);
  const result = processChatMessage(room, channel, msg, now, await streamNews(room, channel, line, now));
  if (result.visible) room.broadcast(result.state);
  if (result.changed) await room.scheduleAlarm(result.state);
  const r = result.result || ({} as GameResult); // processChatMessage always has a result; {} only guards against none
  if (r.reason === "quick_duel" || r.reason === "duel_completed") room.checkSavedProfiles(result.state, r.duelId);
  const quick =
    /^!(wallet|give|pay|pet)(?:\s+(\S+))?(?:\s+(\S+))?\s*$/i.exec(line.trim()) ??
    /^!(checkin)(?:\s|$)/i.exec(line.trim());
  if (quick) {
    const action = String(quick[1]).toLowerCase();
    const out = await QUICK_COMMANDS[action === "pay" ? "give" : action]?.(room, {
      channel,
      userId: validUserId(userId),
      username: normalizeUsername(username),
      who: displayName || username,
      target: normalizeUsername(String(quick[2] || "").replace(/^@/, "")),
      amount: quick[3],
      origin: "",
      // seSettings() adds the settings row, so only the commands that name other commands read it
      get names() {
        return room.seSettings().names;
      },
      now,
    });
    if (out) return json({ ...out.data, reply: out.reply });
  }
  const parsed = parseGameCommand(line);
  // other actions keep their own name
  const action = parsed
    ? ({ duel: "challenge" } as { [action: string]: string | undefined })[parsed.action] || parsed.action
    : "";
  return json({
    ...r,
    revision: result.state.revision,
    reply: parsed
      ? seReplyText({
          result: r,
          state: result.state,
          actorId: userId,
          action,
          target: parsed.target,
          names: room.seSettings().names,
          origin: "",
          now,
        })
      : "",
  });
}

export function saveProfile(room: ChannelRoom, channel: string, userId: string, input: ProfileInput): SaveResult {
  const username = normalizeUsername(input.username);
  const displayName = (input.displayName || username).trim().slice(0, 48);
  const avatar = (input.avatar || "player").trim().slice(0, 64);
  const color = /^#[0-9a-f]{6}$/i.test(input.color) ? input.color.toUpperCase() : "";
  const defaultAbility = ["strike", "heavy", "heal"].includes(input.defaultAbility) ? input.defaultAbility : "";
  if (!username || !/^[a-z0-9_]{1,25}$/.test(username) || !displayName || !avatar || !color || !defaultAbility) {
    return { ok: false, reason: "invalid_profile" };
  }

  const now = Date.now();
  let since = 0;
  const out = room.ctx.storage.transactionSync((): SaveResult => {
    const state = room.readState(channel);
    since = state.revision;
    const existing = getProfile(room, userId, state.config);
    // Upgrades and hat: optional in the request (left out = keep the saved ones), checked against the wins the stream
    // has shown, so a save can't reveal a duel result the overlay hasn't played yet.
    const hidden = hiddenResults(state, now).get(userId);
    const wins = Math.max(0, (existing?.wins || 0) - (hidden?.wins || 0)),
      losses = Math.max(0, (existing?.losses || 0) - (hidden?.losses || 0));
    const stats =
      input.stats === undefined ? existing?.stats : validStats(input.stats, { wins, bonus: existing?.bonus, losses });
    if (stats === null) return { ok: false, reason: "invalid_upgrades" };
    const hat = input.hat === undefined ? existing?.hat || "" : input.hat;
    const owns = (kind: string, id: string) =>
      room.ctx.storage.sql
        .exec("SELECT 1 FROM owned_items WHERE user_id = ? AND kind = ? AND item_id = ?", userId, kind, id)
        .toArray().length > 0;
    if (hat !== (existing?.hat || "") && !hatUnlocked(hat, wins) && !(knownHat(hat) && owns("hat", hat)))
      return { ok: false, reason: knownHat(hat) ? "hat_locked" : "invalid_profile" };
    // Pet: "" (none) or one the fighter bought that still exists.
    const petId = input.pet === undefined ? existing?.pet || "" : input.pet;
    const custom = petId
      ? room.ctx.storage.sql
          .exec<{ c: string | null }>(
            "SELECT tier || ':' || stat || ':' || stat2 AS c FROM custom_pets WHERE id = ?",
            petId,
          )
          .toArray()[0]?.c
      : "";
    const roll = petId
      ? room.ctx.storage.sql
          .exec<{ roll: string }>(
            "SELECT roll FROM owned_items WHERE user_id = ? AND kind = 'pet' AND item_id = ?",
            userId,
            petId,
          )
          .toArray()[0]?.roll
      : "";
    const pet = petId ? petOf(petId, custom, roll) : null;
    if (petId && (!pet || !owns("pet", petId))) return { ok: false, reason: "pet_locked" };
    // Cosmetics: "" (none) or one the fighter bought. Left out = keep the saved one.
    const cosmetics: Partial<Cosmetics> = {};
    for (const kind of COSMETIC_KINDS) {
      const field = COSMETIC_FIELDS[kind],
        id = input[field] === undefined ? existing?.[field] || "" : input[field];
      if (typeof id !== "string" || (id && !cosmeticItem(kind, id))) return { ok: false, reason: "invalid_profile" };
      if (id && id !== (existing?.[field] || "") && !owns(kind, id)) return { ok: false, reason: "item_locked" };
      cosmetics[field] = id;
    }
    // Build slot: the one this loadout is saved to, which becomes the active one. Left out = the active slot.
    const build = input.build === undefined ? existing?.build || 0 : input.build;
    if (!Number.isInteger(build) || build < 0 || build >= buildSlots(room, userId))
      return { ok: false, reason: "invalid_build" };
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
      pet: pet ? pet.id : "",
      petTier: pet ? pet.tier : "",
      petBoost: pet ? pet.boost : emptyStats(),
      ...cosmetics,
      build,
      registered: true,
    };
    const result = reduceGame(state, { type: "profile_saved", profile }, now);
    if (!result.result.ok) return { ok: false, reason: result.result.reason, status: 400 };
    room.writeState(result.state);
    const active = result.state.players.find((item) => item.userId === userId);
    upsertProfile(room, active || profile);
    room.ctx.storage.sql.exec("UPDATE profiles SET build = ? WHERE user_id = ?", build, userId);
    room.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO builds (user_id, slot, data) VALUES (?, ?, ?)",
      userId,
      build,
      JSON.stringify(buildOf(profile)),
    );
    // The state player has no streak, check-in count or dollars; they live only in the profiles table.
    const saved = {
      ...(active || profile),
      build,
      bonus: existing?.bonus || 0,
      checkins: existing?.checkins || 0,
      streak: existing?.streak || 0,
      dollars: existing?.dollars || 0,
      styleDollars: existing?.styleDollars || 0,
    };
    return { ok: true, profile: saved, state: result.state };
  });
  if (out.ok) room.traceEvents(channel, out.state, since);
  return out;
}

// An approved viewer sprite goes on its uploader's saved fighter, and replaces their previous sprite in every build
// slot. Returns the new game state when the overlay needs it, else null.
function wearSprite(room: ChannelRoom, channel: string, row: SpriteRow, previous: string): GameState | null {
  const sql = room.ctx.storage.sql;
  if (previous)
    sql.exec(
      "UPDATE builds SET data = json_set(data, '$.avatar', ?) WHERE user_id = ? AND json_extract(data, '$.avatar') = ?",
      row.id,
      row.userId,
      previous,
    );
  const existing = getProfile(room, row.userId, room.readState(channel).config);
  if (!existing) return null;
  const saved = saveProfile(room, channel, row.userId, {
    username: existing.username,
    displayName: existing.displayName,
    color: existing.color,
    defaultAbility: existing.defaultAbility,
    avatar: row.id,
  });
  return saved.ok ? saved.state : null;
}

// A removed viewer sprite: fighters wearing it, saved or on stage, go back to the default character.
function dropSprite(room: ChannelRoom, channel: string, id: string): GameState | null {
  const sql = room.ctx.storage.sql;
  for (const row of sql.exec<{ user_id: string }>("SELECT user_id FROM profiles WHERE avatar = ?", id).toArray())
    room.lookChanged(row.user_id);
  sql.exec("UPDATE profiles SET avatar = 'player' WHERE avatar = ?", id);
  sql.exec(
    "UPDATE builds SET data = json_set(data, '$.avatar', 'player') WHERE json_extract(data, '$.avatar') = ?",
    id,
  );
  const state = room.readState(channel);
  let hit = false;
  for (const p of state.players)
    if (p.avatar === id) {
      p.avatar = "player";
      hit = true;
    }
  if (!hit) return null;
  state.revision += 1;
  room.writeState(state);
  return state;
}

export function leaderboard(room: ChannelRoom, channel: string) {
  const state = room.readState(channel);
  const rows = room.ctx.storage.sql
    .exec<ProfileRow>(
      `SELECT ${PROFILE_COLUMNS} FROM profiles ORDER BY elo DESC, wins DESC, username COLLATE NOCASE ASC LIMIT 100`,
    )
    .toArray();
  const hidden = hiddenResults(state, Date.now());
  const out = rows.map((row) => {
    const profile = shownProfile(normalizeProfileRow(row, state.config), hidden);
    const active = !hidden.has(profile.userId) && state.players.find((item) => item.userId === profile.userId);
    return active ? { ...profile, hp: active.hp, lastSeen: active.lastSeen, respawnAt: active.respawnAt } : profile;
  });
  return hidden.size ? out.sort(boardOrder) : out; // same order as the SQL, on the numbers shown
}
