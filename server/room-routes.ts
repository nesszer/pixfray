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
import {
  DEFAULT_SE_NAMES,
  SE_ACTIONS,
  seAmount,
  seCheckinText,
  seGiveText,
  seKeyHash,
  sePetText,
  seReplyText,
  seWalletText,
} from "./streamelements.ts";
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
import type { ProfileInput } from "./parse.ts";
import type { AdminEvent, Cosmetics, GameEvent, GameResult, GameState } from "./model.ts";
import {
  boardOrder,
  getProfile,
  json,
  MAX_DOLLARS,
  normalizeProfileRow,
  normalizeUsername,
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
  streamElements,
} from "./room-bot.ts";
import {
  builds,
  buildSlots,
  buy,
  checkin,
  checkinTest,
  giftDollars,
  give,
  owned,
  petInfo,
  reroll,
  resetPair,
  streamNews,
  wallet,
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
const USER_HEADER = "X-Mini-User-Id";
const MAX_CONFIG_HISTORY = 50;
const CHECKIN_TEST_MS = 15 * 60_000; // check-in test mode switches itself off after this
const MAX_LOOKS = 20; // logins per /looks call

export async function route(room: ChannelRoom, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const channel = room.requestChannel(request);
  if (!channel) return json({ error: "invalid or missing channel" }, 400);
  const stored = room.readStoredState();
  if (stored && stored.channel !== channel) return json({ error: "channel binding mismatch" }, 409);

  // Owner dev token only (server/worker.ts /api/devtools/:channel/export): every row of the tables a copy needs. BLOBs as {$b64}.
  if (path === "/export" && request.method === "GET") {
    const bytes = (v: ArrayBuffer | ArrayBufferView) =>
      v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    const b64 = (v: unknown) =>
      v instanceof ArrayBuffer || ArrayBuffer.isView(v)
        ? {
            $b64: btoa(Array.from(bytes(v), (c) => String.fromCharCode(c)).join("")),
          }
        : v;
    const out: { [table: string]: unknown } = {};
    for (const table of [
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
    ])
      out[table] = room.ctx.storage.sql
        .exec(`SELECT * FROM ${table}`)
        .toArray()
        .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, b64(v)])));
    return json(out);
  }
  if (path === "/state" && request.method === "GET") {
    const changed = room.advance(channel, { type: "tick" }, Date.now());
    if (changed.changed) {
      room.broadcast(changed.state);
      await room.scheduleAlarm(changed.state);
    }
    return json(room.publicState(changed.state));
  }

  // The catalog is the mods' uploads plus approved viewer sprites (each with the `owner` who alone may wear it).
  if (path === "/catalog" && request.method === "GET") {
    const custom = await (await handleRoomAssets(room, request, { path, channel })).json<CatalogEntry[]>(); // the /catalog list
    return json([...custom, ...spriteCatalog(room.ctx.storage.sql, channel)]);
  }
  if (path === "/sprites" || path.startsWith("/sprites/") || path.startsWith("/asset/v-")) {
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
  }
  if (path === "/catalog" || path === "/asset" || path.startsWith("/asset/"))
    return handleRoomAssets(room, request, { path, channel });
  if (path.startsWith("/dev/")) return handleRoomDeveloper(room, request, { path, channel, url });
  if (path === "/points" || path.startsWith("/points/"))
    return handleRoomPoints(room, request, { path, channel, maxDollars: MAX_DOLLARS });
  if (path === "/pets" || path.startsWith("/pets/")) {
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
  }
  // The shop list with this channel's prices (public): pets, hat price per win, cosmetics and build slot prices.
  if (path === "/shop" && request.method === "GET") {
    const config = room.readState(channel).config;
    return json({
      pets: petCatalog(room.ctx.storage.sql, channel, config),
      hatPricePerWin: config.hatPricePerWin,
      items: cosmeticCatalog(config),
      slots: { max: MAX_BUILDS, prices: Array.from({ length: MAX_BUILDS - 1 }, (_, i) => slotPrice(i + 1, config)) },
    });
  }
  // Buy a pet, a hat, a cosmetic or a build slot with PixFray dollars (signed-in viewer; the Worker sets the user header).
  if (path === "/shop" && request.method === "POST") {
    const body = await room.readJson(request);
    if (!body.ok) return json({ error: body.error }, 400);
    const userId = validUserId(request.headers.get(USER_HEADER));
    if (!userId || userId !== validUserId(body.value.userId)) return json({ error: "profile identity mismatch" }, 403);
    // the Worker's parseShopBuy passed only a string id; a reroll looks it up and finds nothing else
    const bought =
      body.value.kind === "reroll"
        ? reroll(room, channel, userId, String(body.value.id))
        : buy(room, channel, userId, body.value);
    if (bought.ok && "state" in bought && bought.state) room.broadcast(bought.state);
    return json(
      bought.ok ? bought : { ...bought, error: bought.reason },
      bought.ok
        ? 200
        : bought.reason === "no_fighter"
          ? 404
          : ["not_enough", "owned", "max_slots", "price_changed", "rerolled", "in_duel"].includes(bought.reason)
            ? 409
            : 400,
    );
  }

  if (path === "/admin" && request.method === "GET") {
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
  }

  // Dollars and style dollars are private: the Worker asks for them (?private=1) only for mods and the owner.
  if (path === "/leaderboard" && request.method === "GET") {
    const board = leaderboard(room, channel);
    return json(url.searchParams.get("private") === "1" ? board : board.map(({ dollars, styleDollars, ...p }) => p));
  }

  // Saved looks by login for the overlay (?u=a,b,c, at most 20): only viewers with a saved fighter are listed.
  if (path === "/looks" && request.method === "GET") {
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
      config = state.config,
      hidden = hiddenResults(state, Date.now()),
      out: { [login: string]: Look } = {};
    const rows = room.ctx.storage.sql
      .exec<ProfileRow>(
        `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE lower(username) IN (${logins.map(() => "?").join(",")})`,
        ...logins,
      )
      .toArray();
    for (const row of rows) {
      const p = shownProfile(normalizeProfileRow(row, config), hidden);
      out[p.username.toLowerCase()] = savedLook(p);
    }
    return json(out);
  }

  if (path === "/profile" && request.method === "GET") {
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
  }

  if (path === "/profile" && request.method === "POST") {
    const body = await room.readJson(request);
    if (!body.ok) return json({ error: body.error }, 400);
    const actorId = validUserId(request.headers.get(USER_HEADER));
    const requestedId = validUserId(body.value.userId);
    const login = normalizeUsername(body.value.username) || actorId || "?";
    const logCtx = { channel, action: "save", userId: actorId, user: login };
    if (!actorId || !requestedId || actorId !== requestedId) {
      logRoomEvent(room, "warn", `${login} profile not saved: identity_mismatch`, {
        ...logCtx,
        reason: "identity_mismatch",
      });
      return json({ error: "profile identity mismatch" }, 403);
    }
    const input = parseProfileInput(body.value);
    const result: SaveResult = input.ok
      ? saveProfile(room, channel, actorId, input.value)
      : { ok: false, reason: input.error };
    if (!result.ok) {
      logRoomEvent(room, "warn", `${login} profile not saved: ${result.reason}`, {
        ...logCtx,
        reason: result.reason,
      });
      return json({ error: result.reason }, result.status || 400);
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
  }

  if (path === "/admin" && request.method === "POST") {
    const body = await room.readJson(request);
    if (!body.ok) return json({ error: body.error }, 400);
    const actorId = validUserId(body.value.actorId);
    if (!actorId) return json({ error: "authorized actor required" }, 403);
    const admin = parseRoomAdminBody(body.value);
    if (!admin.ok) return json({ ok: false, reason: admin.error, error: admin.error }, 400);
    const { action } = admin.value,
      actorName = admin.value.actorName.slice(0, 48);
    let payload: JsonObject = admin.value.payload;
    let note = "";
    if (action === "giftDollars") {
      const gift = giftDollars(room, channel, payload, actorId, actorName);
      return json(
        gift.ok ? gift : { ...gift, error: gift.reason },
        gift.ok ? 200 : gift.reason === "profile_not_found" ? 404 : 400,
      );
    }
    if (action === "resetPair") {
      const out = resetPair(room, channel, payload.a, payload.b, actorId, actorName);
      return json(
        out.ok ? out : { ...out, error: out.reason },
        out.ok ? 200 : out.reason === "profile_not_found" ? 404 : 400,
      );
    }
    if (action === "saveCommand" || action === "deleteCommand" || action === "setCounter") {
      const out = editBotCommands(room, channel, action, payload, actorName || actorId);
      return json(
        out.ok ? { ...out, botCommands: botCommands(room) } : { ...out, error: out.reason },
        out.ok ? 200 : 400,
      );
    }
    if (action === "rollbackConfig") {
      const version = Number(payload.version);
      const row = Number.isInteger(version)
        ? room.ctx.storage.sql
            .exec<Pick<ConfigHistoryRow, "config">>("SELECT config FROM config_history WHERE version = ?", version)
            .toArray()[0]
        : null;
      if (!row) return json({ ok: false, reason: "config_version_not_found", error: "config_version_not_found" }, 404);
      // A version saved before a setting existed has no value for it; it goes back to its default, not the current value.
      payload = { patch: { ...defaultConfig(), ...safeJsonParse(row.config, {}) } };
      note = "rollback to v" + version;
    }
    // restoreRank {userId, before}: the fighter's last recorded rank before that time (server/ranklog.ts).
    if (action === "restoreRank" && Number.isInteger(payload.before)) {
      const rank = rankBefore(room.ctx.storage.sql, validUserId(payload.userId) || "", payload.before);
      if (!rank) return json({ ok: false, reason: "no_rank_history", error: "no_rank_history" }, 404);
      payload = { userId: payload.userId, ...rank };
    }
    const targetId = validUserId(payload.userId);
    const targetProfile = targetId ? getProfile(room, targetId, room.readState(channel).config) : null;
    const event: AdminEvent = {
      type: "admin",
      actorId,
      actorName,
      action: action === "rollbackConfig" ? "config" : action,
      payload,
      targetProfile,
      // parseAdminBody checked the note is a string when sent; a rolled-back version's patch has none
      note: note || (typeof payload.note === "string" ? payload.note : "").slice(0, 200),
    };
    const result = room.advance(channel, event, Date.now());
    if (!result.result.ok)
      return json(
        { ...result.result, error: result.result.reason },
        result.result.reason === "unauthorized" ? 403 : result.result.reason === "config_version_conflict" ? 409 : 400,
      );
    room.broadcast(result.state);
    await room.scheduleAlarm(result.state);
    return json({ ...result.result, revision: result.state.revision });
  }

  if (path === "/live" && request.method === "GET")
    return room.upgrade(request, "live", channel, url.searchParams.get("role") === "overlay");

  // Worker-only routes (never reachable from /api/admin): verified EventSub messages and subscription bookkeeping.
  // What Twitch said about the bot's replies to one command, posted by the Worker after sending them.
  if (path === "/bot-sent" && request.method === "POST") {
    const body = await room.readJson(request);
    if (!body.ok) return json({ error: body.error }, 400);
    const sent = parseBotSent(body.value);
    if (!sent.ok) return json({ error: sent.error }, 400);
    noteBotSent(room, channel, sent.value.results.slice(0, 10));
    return json({ ok: true });
  }
  if (path === "/eventsub" && request.method === "POST") {
    const body = await room.readJson(request);
    if (!body.ok) return json({ error: body.error }, 400);
    // the Worker forwards a verified EventSub body, its event cut down by slimEvent
    const msg = parseRoomEventsub(body.value);
    if (!msg.ok) return json({ error: msg.error }, 400);
    return room.eventsub(channel, msg.value, url.searchParams.get("origin") || "");
  }
  // StreamElements custom commands, forwarded by the Worker from GET /api/se/<channel>/<action>.
  if (path === "/se" && request.method === "POST") {
    const body = await room.readJson(request);
    if (!body.ok) return json({ error: body.error }, 400);
    const res = await streamElements(room, channel, body.value, url.searchParams.get("origin") || "");
    // The Worker keeps the current key's hash for a minute, so random keys are refused there without waking this room.
    const secret = room.seSettings()?.secret;
    if (secret) res.headers.set("X-Se-Key", await seKeyHash(secret));
    return res;
  }
  if (path === "/se-admin" && request.method === "POST") {
    const read = await room.readJson(request);
    if (!read.ok) return json({ error: read.error }, 400);
    const body = parseSeAdmin(read.value);
    if (!body.ok) return json({ error: body.error }, 400);
    const current = room.seSettings();
    if (body.value.action === "rotateSeKey") {
      room.writeSeSettings(randomHex(), current.names);
      room.ctx.storage.sql.exec(
        "UPDATE se_settings SET last_command_at = 0, rejected_at = 0, seen_json = '{}' WHERE id = 1",
      ); // a new key starts unheard
    } else if (body.value.action === "setSeNames") {
      const input = body.value.names;
      const names: SeNames = {};
      for (const action of SE_ACTIONS) {
        const name = String(
          // SE_ACTIONS are DEFAULT_SE_NAMES's keys
          input[action] ?? current.names[action] ?? DEFAULT_SE_NAMES[action as keyof typeof DEFAULT_SE_NAMES],
        ).trim();
        if (!/^!?[a-z0-9_]{1,24}$/i.test(name)) return json({ error: `Invalid command name for ${action}` }, 400);
        names[action] = (name.startsWith("!") ? name : "!" + name).toLowerCase();
      }
      if (new Set(Object.values(names)).size !== SE_ACTIONS.length)
        return json({ error: "Each action needs its own command name" }, 400);
      room.writeSeSettings(current.secret, names);
    } else if (body.value.action === "setDuelModuleOff") {
      room.ctx.storage.sql.exec("UPDATE se_settings SET duel_module_off = ? WHERE id = 1", body.value.value ? 1 : 0);
    } else return json({ error: "unknown StreamElements action" }, 400);
    return json({ ok: true, streamelements: room.seSettings() });
  }
  // Check-in test mode (mods, via /api/admin action checkinTest): {on:true} for CHECKIN_TEST_MS, {on:false} ends it.
  if (path === "/checkin-test" && request.method === "POST") {
    const read = await room.readJson(request);
    if (!read.ok) return json({ error: read.error }, 400);
    const body = parseCheckinTest(read.value);
    if (!body.ok) return json({ error: body.error }, 400);
    if (body.value.on)
      room.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO checkin_test (id, until, by_name) VALUES (1, ?, ?)",
        Date.now() + CHECKIN_TEST_MS,
        body.value.by.slice(0, 48),
      );
    else room.ctx.storage.sql.exec("DELETE FROM checkin_test");
    return json({ ok: true, checkinTest: checkinTest(room) });
  }
  // Test site only (worker dev token): one chat line as if Twitch had delivered it on the current subscription.
  if (path === "/dev-chat" && request.method === "POST") {
    if (!room.env?.DEV_TOOLS_TOKEN) return text("Not found", 404);
    const read = await room.readJson(request);
    if (!read.ok) return json({ error: read.error }, 400);
    const body = parseDevChat(read.value);
    if (!body.ok) return json({ error: body.error }, 400);
    const { userId, username, displayName, text: line } = body.value;
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
    const devGive = /^!(wallet|give|pay|pet)(?:\s+(\S+))?(?:\s+(\S+))?\s*$/i.exec(line.trim()) as
      | (RegExpExecArray & [string, string])
      | null; // group 1 is required, so a match has it
    if (devGive) {
      // the reply is the line a StreamElements bot would post
      const who = displayName || username,
        uid = validUserId(userId),
        devTarget = normalizeUsername(String(devGive[2] || "").replace(/^@/, ""));
      if (devGive[1].toLowerCase() === "pet") {
        const self = !devTarget || devTarget === normalizeUsername(username),
          info = petInfo(room, channel, self ? { userId: uid } : { username: devTarget });
        return json({
          pet: info,
          reply: sePetText(info, { who, target: self ? "" : devTarget, origin: "", channel }),
        });
      }
      if (devGive[1].toLowerCase() === "wallet") {
        const w = wallet(room, channel, uid);
        return json({ wallet: w, reply: seWalletText(w, { who, origin: "", channel }) });
      }
      const given = await give(room, channel, { userId: uid, target: devTarget, amount: seAmount(devGive[3]) }, now);
      return json({
        ...given,
        reply: seGiveText(given, { who, target: devTarget, origin: "", channel, names: room.seSettings().names }),
      });
    }
    if (/^!checkin(?:\s|$)/i.test(line.trim())) {
      const checked = await checkin(room, channel, { userId: validUserId(userId) }, now);
      return json({
        ...checked,
        reply: seCheckinText(checked, { who: displayName || username, origin: "", channel }),
      });
    }
    const parsed = parseGameCommand(line); // the reply is the line a StreamElements bot would post
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
  // Test site only: add style dollars to a saved fighter (or take them back), as a channel point redemption would.
  if (path === "/dev-style" && request.method === "POST") {
    if (!room.env?.DEV_TOOLS_TOKEN) return text("Not found", 404);
    const read = await room.readJson(request);
    if (!read.ok) return json({ error: read.error }, 400);
    const { userId, amount } = read.value,
      sql = room.ctx.storage.sql;
    if (typeof userId !== "string" || typeof amount !== "number" || !Number.isInteger(amount))
      return json({ error: "userId and amount required" }, 400);
    const row = sql
      .exec<{ style_dollars: number }>("SELECT style_dollars FROM profiles WHERE user_id = ?", userId)
      .toArray()[0];
    if (!row) return json({ error: "no_fighter" }, 404);
    const styleDollars = Math.max(0, Math.min(MAX_DOLLARS, row.style_dollars + amount));
    sql.exec("UPDATE profiles SET style_dollars = ? WHERE user_id = ?", styleDollars, userId);
    return json({ ok: true, userId, styleDollars });
  }
  // Test site only: pretend the channel is live ({live:true}, a new stream id unless streamId is given), offline
  // ({live:false}), or ask Twitch again ({live:null}).
  if (path === "/dev-live" && request.method === "POST") {
    if (!room.env?.DEV_TOOLS_TOKEN) return text("Not found", 404);
    const read = await room.readJson(request);
    if (!read.ok) return json({ error: read.error }, 400);
    const body = parseRoomDevLive(read.value);
    if (!body.ok) return json({ error: body.error }, 400);
    const { live, streamId } = body.value,
      sql = room.ctx.storage.sql;
    if (typeof live !== "boolean") sql.exec("DELETE FROM dev_live");
    else
      sql.exec(
        "INSERT OR REPLACE INTO dev_live (id, stream_id, started_at) VALUES (1, ?, ?)",
        live ? "dev-" + (/^[a-z0-9_-]{1,36}$/i.test(streamId) ? streamId : randomHex().slice(0, 12)) : "",
        Date.now(),
      );
    const row = sql.exec<{ stream_id: string }>("SELECT stream_id FROM dev_live WHERE id = 1").toArray()[0];
    return json({ ok: true, live: row ? Boolean(row.stream_id) : null, streamId: row?.stream_id || "" });
  }
  if (path === "/chat" && request.method === "GET") return json(chatStatus(room.readState(channel)));
  if (path === "/chat" && request.method === "POST") {
    const body = await room.readJson(request);
    if (!body.ok) return json({ error: body.error }, 400);
    const event: GameEvent | null =
      body.value.action === "connected"
        ? {
            type: "chat_subscription",
            subscriptionId: body.value.subscriptionId,
            status: body.value.status,
            createdAt: body.value.createdAt,
          }
        : body.value.action === "disconnected"
          ? { type: "chat_disconnected", reason: body.value.reason }
          : null;
    if (!event) return json({ error: "unknown chat action" }, 400);
    const result = room.advance(channel, event, Date.now());
    if (result.visible) room.broadcast(result.state);
    await room.scheduleAlarm(result.state);
    return json({ ...result.result, revision: result.state.revision, chatStatus: chatStatus(result.state) });
  }

  return text("Not found", 404);
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
export function wearSprite(room: ChannelRoom, channel: string, row: SpriteRow, previous: string): GameState | null {
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
export function dropSprite(room: ChannelRoom, channel: string, id: string): GameState | null {
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
