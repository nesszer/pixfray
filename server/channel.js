import { DurableObject } from "cloudflare:workers";
import site from "../site.config.js";
import {
  chatStatus,
  createInitialState,
  defaultConfig,
  hiddenResults,
  NEW_ACCOUNT_MS,
  normalizeGameState,
  parseGameCommand,
  reduceGame,
  shownProfile,
} from "./game.js";
import { handleRoomAssets, ensureUploadSchema, customUsage } from "./uploads.js";
import { handleRoomDeveloper, ensureDeveloperSchema, logRoomError, logRoomEvent } from "./developer.js";
import { checkChatSubscription, liveStream, sendChatMessage, botDropText } from "./eventsub.js";
import { accountCreatedAt } from "./accounts.js";
import { EVENTSUB_DEDUPE_MS, claimMessage, releaseMessage } from "./dedupe.js";
import {
  cleanStats,
  emptyStats,
  knownHat,
  validStats,
  hatUnlocked,
  upgradeRules,
  pointsFor,
  MAX_POINTS,
  HATS,
} from "./upgrades.js";
import { ensurePetSchema, handleRoomPets, petCatalog, petOf, hatPrice } from "./pets.js";
import { ensureSpriteSchema, handleRoomSprites, spriteCatalog } from "./sprites.js";
import {
  COSMETIC_KINDS,
  COSMETIC_FIELDS,
  cleanCosmetics,
  cosmeticItem,
  cosmeticPrice,
  cosmeticCatalog,
  slotPrice,
  buildOf,
  MAX_BUILDS,
} from "./cosmetics.js";
import {
  MAX_BOT_COMMANDS,
  MAX_COMMAND_REPLY,
  MAX_COUNTER,
  COMMAND_COOLDOWN_MS,
  COMMAND_USER_COOLDOWN_MS,
  commandName,
  counterName,
  commandReplyText,
  replyCounters,
  renderCommandReply,
  replyWorstCase,
  fitChatLine,
  MAX_CHAT_LINE,
} from "./botcommands.js";
import {
  SE_ACTIONS,
  SE_READ_ACTIONS,
  DEFAULT_SE_NAMES,
  SE_SUBSCRIPTION_ID,
  seCommandText,
  seReplyText,
  seTopText,
  seEloText,
  seHelpText,
  seLookText,
  seCheckinText,
  seWalletText,
  seGiveText,
  sePetText,
  seAmount,
  seTarget,
  seReminderText,
  seExpiredText,
  seResultText,
  seKeyHash,
  botNames,
} from "./streamelements.js";

const INTERNAL_HEADER = "X-Mini-Internal";
const CHANNEL_HEADER = "X-Mini-Channel";
const USER_HEADER = "X-Mini-User-Id";
const MAX_PROFILE_ID_LENGTH = 64;
const MAX_LIVE_SOCKETS = 200;
const MAX_SOCKETS_PER_CLIENT = 16; // one network can't fill the room and lock OBS out
const REJECTED_WRITE_MS = 60_000; // a wrong StreamElements key is recorded at most once a minute
const MAX_CONFIG_HISTORY = 50;
const CHECKIN_TEST_MS = 15 * 60_000; // check-in test mode switches itself off after this
const SEEN_WRITE_MS = 60_000; // each command's "last seen" time is written at most once a minute
const BOT_REPLIES_PER_30S = 18; // the bot's chat replies per channel; Twitch allows 20 per 30 s unless it is a mod
const BOT_RESERVED_LINES = 4; // of those, kept for the bot's own result and expired-challenge lines
const RESULT_WINDOW_MS = 120000; // a result line not sent within 2 minutes of its reveal is given up
const RESULT_RETRY_MS = 5000; // how often the alarm retries a due result line that couldn't go out
// Hidden bot-channel aliases for words new viewers guess: !accept and !duel, and !top (StreamElements owns it on SE channels).
const BOT_ALIASES = { "!accept": "accept", "!duel": "challenge", "!top": "top" };
// Commands that refuse the bot account as their target, with the reply (outside the BOT_DEBUG test site).
const BOT_TARGET_ACTIONS = {
  challenge: (names) => `The bot doesn't fight (yet)! Name a rival: ${names.challenge || "!challenge"} @name`,
  give: () => "The bot doesn't take dollars. Give them to a rival!",
};
// !fray e2e (BOT_DEBUG): [who, action, target, expected reasons, gate]. B is the bot account, O the opponent. A gate step
// starts or answers a duel the next steps need, so the run stops when it fails.
/** @type {[who: string, action: string, target: string, want: string[], gate?: boolean][]} */
const E2E_STEPS = [
  ["B", "help", "", ["help"]],
  ["B", "look", "", ["look"]],
  ["B", "top", "", ["top"]],
  ["B", "elo", "", ["elo"]],
  ["B", "elo", "O", ["elo"]],
  ["B", "wallet", "", ["wallet"]],
  ["B", "pet", "", ["pet", "no_pet"]],
  ["B", "checkin", "", ["checked_in", "already_checked_in", "not_live"]],
  ["B", "challenge", "", ["target_required"]],
  ["B", "challenge", "O", ["challenge"], true],
  ["O", "decline", "", ["challenge_declined"], true],
  ["B", "challenge", "O", ["challenge"], true],
  ["O", "accept", "", ["quick_duel"], true],
  ["B", "rematch", "", ["challenge", "rematch_cooldown", "respawning", "result_hidden"]],
  ["B", "give", "O", ["given", "not_live", "too_few_duels", "not_enough", "give_off", "give_cap", "over_cap"]],
  ["B", "decline", "", ["challenge_not_found"]],
  ["B", "accept", "", ["challenge_not_found"]],
];
const MAX_E2E_LINE = 470; // under the bot's 480-character chat line
// Joins parts into as few lines as fit max characters each.
function chatLines(parts, sep, max) {
  const out = [];
  for (const part of parts) {
    const last = out.length ? out[out.length - 1] : null;
    if (last !== null && last.length + sep.length + part.length <= max) out[out.length - 1] = last + sep + part;
    else out.push(part.slice(0, max));
  }
  return out;
}
const MAX_LOOKS = 20; // logins per /looks call
const MAX_EVENTSUB_IDS = 5_000;
// Chat bots never walk into the arena or duel.
const CHAT_BOTS = new Set([
  "streamelements",
  "nightbot",
  "moobot",
  "fossabot",
  "streamlabs",
  "wizebot",
  "sery_bot",
  "soundalerts",
  "kofistreambot",
  "botrixoficial",
  "pixfray",
]);
const PRESENCE_REFRESH_MS = 30_000; // chat-only viewers refresh their arena presence at most this often
const LAST_SEEN_WRITE_MS = 60_000; // chat.lastSeen alone is persisted at most once a minute
const CHAT_CHECK_MS = 60 * 60_000; // the alarm re-checks the Helix subscription at most hourly
const CHAT_PENDING_CHECK_MS = 3 * 60_000; // a subscription still awaiting webhook verification is re-checked sooner
const ACCOUNT_RETRY_MS = 3_600_000; // a failed Twitch account-age lookup is retried after an hour
const LIVE_CACHE_MS = 60_000; // !checkin asks Twitch whether the channel is live at most once a minute
const FREE_MISS_MS = 7 * 24 * 60 * 60_000; // a streak survives one missed stream per week
const STREAK_MILESTONES = [3, 7, 14, 30]; // +1 point when the streak reaches one of these (config.streakBonus)
const MAX_BONUS = 1_000; // stored check-in points; only MAX_POINTS of wins + bonus ever count
const MAX_DOLLARS = 1_000_000; // a wallet never holds more
const MAX_GIFT = 10_000; // the most a mod can add or take back in one gift
// Every query that builds a profile with normalizeProfileRow reads these columns.
const PROFILE_COLUMNS =
  "user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen, power, guard, luck, hat, bonus_points, checkins, streak, dollars, pet, recolor, pet_color, accessory, trail, win_effect, taunt, title, build, (SELECT tier || ':' || stat || ':' || stat2 FROM custom_pets WHERE custom_pets.id = profiles.pet) AS pet_custom";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function text(value, status = 200) {
  return new Response(value, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function normalizeChannel(value) {
  const channel = String(value || "")
    .trim()
    .toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(channel) ? channel : "";
}

function validUserId(value) {
  const id = String(value ?? "").trim();
  return id.length > 0 && id.length <= MAX_PROFILE_ID_LENGTH && /^[a-zA-Z0-9_:-]+$/.test(id) ? id : "";
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase()
    .slice(0, 25);
}

// Stage 4 cosmetics: profile field -> profiles column (server/cosmetics.js).
const COSMETIC_COLUMNS = {
  recolor: "recolor",
  petColor: "pet_color",
  accessory: "accessory",
  trail: "trail",
  winEffect: "win_effect",
  taunt: "taunt",
  title: "title",
};

// Leaderboard order, as in the SQL: Elo, then wins, then name.
function boardOrder(a, b) {
  const x = a.username.toLowerCase(),
    y = b.username.toLowerCase();
  return b.elo - a.elo || b.wins - a.wins || (x < y ? -1 : x > y ? 1 : 0);
}

// What an overlay draws for a viewer with a saved fighter: /looks and the "looks" push send the same fields.
function savedLook(p) {
  return {
    avatar: p.avatar,
    color: p.color,
    hat: p.hat || "",
    pet: p.pet || "",
    petTier: p.petTier || "",
    ...cleanCosmetics(p),
    displayName: p.displayName,
    elo: p.elo,
  };
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
    bonus: Number.isInteger(row.bonus_points) ? row.bonus_points : 0, // check-in points (checkin below)
    checkins: Number.isInteger(row.checkins) ? row.checkins : 0,
    streak: Number.isInteger(row.streak) ? row.streak : 0,
    dollars: Number.isInteger(row.dollars) ? row.dollars : 0, // PixFray dollars (payDuels, give, giftDollars)
    ...petFieldsOf(row),
    ...cleanCosmetics(
      Object.fromEntries(Object.entries(COSMETIC_COLUMNS).map(([field, column]) => [field, row[column]])),
    ),
    build: Number.isInteger(row.build) ? row.build : 0, // the active build slot (builds table)
    ...(row.last_opponent ? { lastOpponentId: String(row.last_opponent) } : {}), // only getProfile reads it
  };
}

// The active pet (server/pets.js): its id, tier and boost; none when it's gone (a deleted upload).
function petFieldsOf(row) {
  const pet = petOf(row.pet, row.pet_custom);
  return { pet: pet ? pet.id : "", petTier: pet ? pet.tier : "", petBoost: pet ? pet.boost : emptyStats() };
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
    /** @type {Record<string, number> | undefined} last time each held-duel reason was logged */
    this.heldLogged = undefined;
    /** @type {Map<string, number> | undefined} text command cooldowns (customReply) */
    this.commandCooldowns = undefined;
    // Overlays send "ping" every 20 s to catch a half-open socket. The runtime answers "pong" itself, without waking this
    // object from hibernation or billing its time (public/arena-client.js).
    if (typeof WebSocketRequestResponsePair === "function")
      ctx.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair("ping", "pong"));
    const sql = this.ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS game_state (id INTEGER PRIMARY KEY CHECK (id = 1), channel TEXT NOT NULL, document TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL, avatar TEXT NOT NULL, color TEXT NOT NULL, default_ability TEXT NOT NULL, elo INTEGER NOT NULL, wins INTEGER NOT NULL, losses INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0)",
    );
    // v2.5: upgrade points spent from wins (server/upgrades.js) and the chosen hat.
    const profileColumns = sql
      .exec("PRAGMA table_info(profiles)")
      .toArray()
      .map((c) => c.name);
    for (const column of ["power", "guard", "luck"])
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
    // v2.8: the active pet, plus bought items and uploaded pets (server/pets.js). PROFILE_COLUMNS reads custom_pets.
    if (!profileColumns.includes("pet")) sql.exec("ALTER TABLE profiles ADD COLUMN pet TEXT NOT NULL DEFAULT ''");
    ensurePetSchema(sql);
    // v3.1: sprites viewers made from their own images, waiting for a mod or approved (server/sprites.js).
    ensureSpriteSchema(sql);
    // v2.9: cosmetics worn (server/cosmetics.js) and the active build slot. Each slot's loadout is a JSON row in builds;
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
        .exec("PRAGMA table_info(bot_reminder)")
        .toArray()
        .some((c) => c.name === "results_through")
    )
      sql.exec("ALTER TABLE bot_reminder ADD COLUMN results_through INTEGER NOT NULL DEFAULT 0");
    // The bot's own text commands (admin page, Chat commands) and the counters their replies use (server/botcommands.js).
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
    sql.exec(
      "CREATE TABLE IF NOT EXISTS config_history (version INTEGER PRIMARY KEY, config TEXT NOT NULL, actor_id TEXT NOT NULL, at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '')",
    );
    // v2.1: keep the actor's display name so history reads well for mods without a profile.
    if (
      !sql
        .exec("PRAGMA table_info(config_history)")
        .toArray()
        .some((c) => c.name === "actor_name")
    )
      sql.exec("ALTER TABLE config_history ADD COLUMN actor_name TEXT NOT NULL DEFAULT ''");
    ensureUploadSchema(sql);
    ensureDeveloperSchema(sql);
    sql.exec(
      "CREATE TABLE IF NOT EXISTS se_settings (id INTEGER PRIMARY KEY CHECK (id = 1), secret TEXT NOT NULL, names TEXT NOT NULL)",
    );
    // v2.4: when a StreamElements command last reached this room with the right key, and with a wrong one, so the admin
    // page can tell when the bot's commands were copied from another site (test vs production) or an old key.
    const seColumns = sql
      .exec("PRAGMA table_info(se_settings)")
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

    // Owner dev token only (server/worker.js /api/devtools/:channel/export): every row of the tables a copy needs. BLOBs as {$b64}.
    if (path === "/export" && request.method === "GET") {
      const bytes = (v) =>
        v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      const b64 = (v) =>
        v instanceof ArrayBuffer || ArrayBuffer.isView(v)
          ? {
              $b64: btoa(Array.from(bytes(v), (c) => String.fromCharCode(c)).join("")),
            }
          : v;
      const out = {};
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
        out[table] = this.ctx.storage.sql
          .exec(`SELECT * FROM ${table}`)
          .toArray()
          .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, b64(v)])));
      return json(out);
    }
    if (path === "/state" && request.method === "GET") {
      const changed = this.advance(channel, { type: "tick" }, Date.now());
      if (changed.changed) {
        this.broadcast(changed.state);
        await this.scheduleAlarm(changed.state);
      }
      return json(this.publicState(changed.state));
    }

    // The catalog is the mods' uploads plus approved viewer sprites (each with the `owner` who alone may wear it).
    if (path === "/catalog" && request.method === "GET") {
      const custom = await (await handleRoomAssets(this, request, { path, channel })).json();
      return json([...custom, ...spriteCatalog(this.ctx.storage.sql, channel)]);
    }
    if (path === "/sprites" || path.startsWith("/sprites/") || path.startsWith("/asset/v-")) {
      let changed = null;
      const response = await handleRoomSprites(this, request, {
        path,
        url,
        channel,
        hooks: {
          approved: (row, previous) => {
            changed = this.wearSprite(channel, row, previous) || changed;
          },
          removed: (id) => {
            changed = this.dropSprite(channel, id) || changed;
          },
        },
      });
      if (changed) this.broadcast(changed);
      return response;
    }
    if (path === "/catalog" || path === "/asset" || path.startsWith("/asset/"))
      return handleRoomAssets(this, request, { path, channel });
    if (path.startsWith("/dev/")) return handleRoomDeveloper(this, request, { path, channel, url });
    if (path === "/pets" || path.startsWith("/pets/")) {
      // A deleted upload leaves the fighters using it with no pet; the stored profiles are cleared by handleRoomPets.
      let cleared = null;
      const response = await handleRoomPets(this, request, {
        path,
        channel,
        config: this.readState(channel).config,
        onDelete: (id) => {
          const state = this.readState(channel);
          let hit = false;
          for (const p of state.players)
            if (p.pet === id) {
              Object.assign(p, { pet: "", petTier: "", petBoost: emptyStats() });
              hit = true;
            }
          if (hit) {
            state.revision += 1;
            this.writeState(state);
            cleared = state;
          }
        },
      });
      if (cleared) this.broadcast(cleared);
      return response;
    }
    // The shop list with this channel's prices (public): pets, hat price per win, cosmetics and build slot prices.
    if (path === "/shop" && request.method === "GET") {
      const config = this.readState(channel).config;
      return json({
        pets: petCatalog(this.ctx.storage.sql, channel, config),
        hatPricePerWin: config.hatPricePerWin,
        items: cosmeticCatalog(config),
        slots: { max: MAX_BUILDS, prices: Array.from({ length: MAX_BUILDS - 1 }, (_, i) => slotPrice(i + 1, config)) },
      });
    }
    // Buy a pet, a hat, a cosmetic or a build slot with PixFray dollars (signed-in viewer; the Worker sets the user header).
    if (path === "/shop" && request.method === "POST") {
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      const userId = validUserId(request.headers.get(USER_HEADER));
      if (!userId || userId !== validUserId(body.value.userId))
        return json({ error: "profile identity mismatch" }, 403);
      const bought = this.buy(channel, userId, body.value);
      return json(
        bought.ok ? bought : { ...bought, error: bought.reason },
        bought.ok
          ? 200
          : bought.reason === "no_fighter"
            ? 404
            : ["not_enough", "owned", "max_slots", "price_changed"].includes(bought.reason)
              ? 409
              : 400,
      );
    }

    if (path === "/admin" && request.method === "GET") {
      const state = this.readState(channel);
      this.seedConfigHistory(state);
      const history = this.ctx.storage.sql
        .exec(
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
        ...this.publicState(state),
        chatStatus: chatStatus(state),
        history,
        customUsage: customUsage(this),
        streamelements: this.seSettings(),
        overlays: this.ctx.getWebSockets("overlay").length,
        checkinTest: this.checkinTest(),
        botCommands: this.botCommands(),
        botStatus: this.botStatus(),
      });
    }

    // Dollars are private: the Worker asks for them (?private=1) only for mods and the owner.
    if (path === "/leaderboard" && request.method === "GET") {
      const board = this.leaderboard(channel);
      return json(url.searchParams.get("private") === "1" ? board : board.map(({ dollars, ...p }) => p));
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
      const state = this.readState(channel),
        config = state.config,
        hidden = hiddenResults(state, Date.now()),
        out = {};
      const rows = this.ctx.storage.sql
        .exec(
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
      const state = this.readState(channel);
      const hidden = hiddenResults(state, Date.now());
      const profile = shownProfile(this.getProfile(userId, state.config), hidden);
      if (!profile) return json(null);
      // A knocked-out fighter (hp 0, respawnAt) would give away a result the stream hasn't shown yet.
      const active = !hidden.has(userId) && state.players.find((item) => item.userId === userId);
      return json({
        ...profile,
        ...(active ? { hp: active.hp, lastSeen: active.lastSeen, respawnAt: active.respawnAt } : {}),
        upgrades: upgradeRules(profile.wins, profile.bonus),
        owned: this.owned(userId),
        builds: this.builds(profile),
      });
    }

    if (path === "/profile" && request.method === "POST") {
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      const actorId = validUserId(request.headers.get(USER_HEADER));
      const requestedId = validUserId(body.value.userId);
      const login = normalizeUsername(body.value.username) || actorId || "?";
      const logCtx = { channel, action: "save", userId: actorId, user: login };
      if (!actorId || !requestedId || actorId !== requestedId) {
        logRoomEvent(this, "warn", `${login} profile not saved: identity_mismatch`, {
          ...logCtx,
          reason: "identity_mismatch",
        });
        return json({ error: "profile identity mismatch" }, 403);
      }
      const result = this.saveProfile(channel, actorId, body.value);
      if (!result.ok) {
        logRoomEvent(this, "warn", `${login} profile not saved: ${result.reason}`, {
          ...logCtx,
          reason: result.reason,
        });
        return json({ error: result.reason }, result.status || 400);
      }
      logRoomEvent(this, "command", `${login} saved profile`, { ...logCtx, reason: "saved" });
      this.broadcast(result.state);
      await this.scheduleAlarm(result.state);
      const shown = shownProfile(result.profile, hiddenResults(result.state, Date.now()));
      return json({
        profile: {
          ...shown,
          upgrades: upgradeRules(shown.wins, shown.bonus),
          owned: this.owned(actorId),
          builds: this.builds(shown),
        },
        revision: result.state.revision,
      });
    }

    if (path === "/admin" && request.method === "POST") {
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      const actorId = validUserId(body.value.actorId);
      if (!actorId) return json({ error: "authorized actor required" }, 403);
      const action = String(body.value.action || "");
      let payload =
        body.value.payload && typeof body.value.payload === "object" && !Array.isArray(body.value.payload)
          ? body.value.payload
          : body.value;
      let note = "";
      if (action === "giftDollars") {
        const gift = this.giftDollars(channel, payload, actorId, String(body.value.actorName || "").slice(0, 48));
        return json(
          gift.ok ? gift : { ...gift, error: gift.reason },
          gift.ok ? 200 : gift.reason === "profile_not_found" ? 404 : 400,
        );
      }
      if (action === "saveCommand" || action === "deleteCommand" || action === "setCounter") {
        const out = this.editBotCommands(
          channel,
          action,
          payload,
          String(body.value.actorName || actorId).slice(0, 48),
        );
        return json(
          out.ok ? { ...out, botCommands: this.botCommands() } : { ...out, error: out.reason },
          out.ok ? 200 : 400,
        );
      }
      if (action === "rollbackConfig") {
        const version = Number(payload.version);
        const row = Number.isInteger(version)
          ? this.ctx.storage.sql.exec("SELECT config FROM config_history WHERE version = ?", version).toArray()[0]
          : null;
        if (!row)
          return json({ ok: false, reason: "config_version_not_found", error: "config_version_not_found" }, 404);
        // A version saved before a setting existed has no value for it; it goes back to its default, not the current value.
        payload = { patch: { ...defaultConfig(), ...safeJsonParse(row.config, {}) } };
        note = "rollback to v" + version;
      }
      const targetId = validUserId(payload.userId);
      const targetProfile = targetId ? this.getProfile(targetId, this.readState(channel).config) : null;
      const actorName = String(body.value.actorName || "").slice(0, 48);
      const event = {
        type: "admin",
        actorId,
        actorName,
        action: action === "rollbackConfig" ? "config" : action,
        payload,
        targetProfile,
        note: note || String(payload.note || "").slice(0, 200),
      };
      const result = this.advance(channel, event, Date.now());
      if (!result.result.ok)
        return json(
          { ...result.result, error: result.result.reason },
          result.result.reason === "unauthorized"
            ? 403
            : result.result.reason === "config_version_conflict"
              ? 409
              : 400,
        );
      this.broadcast(result.state);
      await this.scheduleAlarm(result.state);
      return json({ ...result.result, revision: result.state.revision });
    }

    if (path === "/live" && request.method === "GET")
      return this.upgrade(request, "live", channel, url.searchParams.get("role") === "overlay");

    // Worker-only routes (never reachable from /api/admin): verified EventSub messages and subscription bookkeeping.
    // What Twitch said about the bot's replies to one command, posted by the Worker after sending them.
    if (path === "/bot-sent" && request.method === "POST") {
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      this.noteBotSent(channel, Array.isArray(body.value.results) ? body.value.results.slice(0, 10) : []);
      return json({ ok: true });
    }
    if (path === "/eventsub" && request.method === "POST") {
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      return this.eventsub(channel, body.value, url.searchParams.get("origin") || "");
    }
    // StreamElements custom commands, forwarded by the Worker from GET /api/se/<channel>/<action>.
    if (path === "/se" && request.method === "POST") {
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      const res = await this.streamElements(channel, body.value, url.searchParams.get("origin") || "");
      // The Worker keeps the current key's hash for a minute, so random keys are refused there without waking this room.
      const secret = this.seSettings()?.secret;
      if (secret) res.headers.set("X-Se-Key", await seKeyHash(secret));
      return res;
    }
    if (path === "/se-admin" && request.method === "POST") {
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      const current = this.seSettings();
      if (body.value.action === "rotateSeKey") {
        this.writeSeSettings(randomHex(), current.names);
        this.ctx.storage.sql.exec(
          "UPDATE se_settings SET last_command_at = 0, rejected_at = 0, seen_json = '{}' WHERE id = 1",
        ); // a new key starts unheard
      } else if (body.value.action === "setSeNames") {
        const input = body.value.names && typeof body.value.names === "object" ? body.value.names : {};
        const names = {};
        for (const action of SE_ACTIONS) {
          const name = String(input[action] ?? current.names[action] ?? DEFAULT_SE_NAMES[action]).trim();
          if (!/^!?[a-z0-9_]{1,24}$/i.test(name)) return json({ error: `Invalid command name for ${action}` }, 400);
          names[action] = (name.startsWith("!") ? name : "!" + name).toLowerCase();
        }
        if (new Set(Object.values(names)).size !== SE_ACTIONS.length)
          return json({ error: "Each action needs its own command name" }, 400);
        this.writeSeSettings(current.secret, names);
      } else if (body.value.action === "setDuelModuleOff") {
        this.ctx.storage.sql.exec(
          "UPDATE se_settings SET duel_module_off = ? WHERE id = 1",
          body.value.value === true ? 1 : 0,
        );
      } else return json({ error: "unknown StreamElements action" }, 400);
      return json({ ok: true, streamelements: this.seSettings() });
    }
    // Check-in test mode (mods, via /api/admin action checkinTest): {on:true} for CHECKIN_TEST_MS, {on:false} ends it.
    if (path === "/checkin-test" && request.method === "POST") {
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      if (body.value.on === true)
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO checkin_test (id, until, by_name) VALUES (1, ?, ?)",
          Date.now() + CHECKIN_TEST_MS,
          String(body.value.by || "").slice(0, 48),
        );
      else this.ctx.storage.sql.exec("DELETE FROM checkin_test");
      return json({ ok: true, checkinTest: this.checkinTest() });
    }
    // Test site only (worker dev token): one chat line as if Twitch had delivered it on the current subscription.
    if (path === "/dev-chat" && request.method === "POST") {
      if (!this.env?.DEV_TOOLS_TOKEN) return text("Not found", 404);
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      const { userId, username, displayName, text: line } = body.value;
      const now = Date.now(),
        messageId = "dev:" + randomHex().slice(0, 24);
      const msg = {
        messageId,
        timestamp: now,
        subscription: { id: this.readState(channel).chat.subscriptionId || "" },
        event: {
          chatter_user_id: userId,
          chatter_user_login: username,
          chatter_user_name: displayName,
          message_id: messageId,
          message: { text: String(line || "") },
        },
      };
      await this.checkAccountAge(userId);
      const result = this.processChatMessage(channel, msg, now);
      if (result.visible) this.broadcast(result.state);
      if (result.changed) await this.scheduleAlarm(result.state);
      const r = result.result || {};
      if (r.reason === "quick_duel" || r.reason === "duel_completed") this.checkSavedProfiles(result.state, r.duelId);
      const devGive = /^!(wallet|give|pay|pet)(?:\s+(\S+))?(?:\s+(\S+))?\s*$/i.exec(String(line || "").trim());
      if (devGive) {
        // the reply is the line a StreamElements bot would post
        const who = displayName || username,
          uid = validUserId(userId),
          devTarget = normalizeUsername(String(devGive[2] || "").replace(/^@/, ""));
        if (devGive[1].toLowerCase() === "pet") {
          const self = !devTarget || devTarget === normalizeUsername(username),
            info = this.petInfo(channel, self ? { userId: uid } : { username: devTarget });
          return json({
            pet: info,
            reply: sePetText(info, { who, target: self ? "" : devTarget, origin: "", channel }),
          });
        }
        if (devGive[1].toLowerCase() === "wallet") {
          const wallet = this.wallet(channel, uid);
          return json({ wallet, reply: seWalletText(wallet, { who, origin: "", channel, maxPoints: MAX_POINTS }) });
        }
        const given = await this.give(channel, { userId: uid, target: devTarget, amount: seAmount(devGive[3]) }, now);
        return json({
          ...given,
          reply: seGiveText(given, { who, target: devTarget, origin: "", channel, names: this.seSettings().names }),
        });
      }
      if (/^!checkin(?:\s|$)/i.test(String(line || "").trim())) {
        const checked = await this.checkin(channel, { userId: validUserId(userId) }, now);
        return json({
          ...checked,
          reply: seCheckinText(checked, { who: displayName || username, origin: "", channel, maxPoints: MAX_POINTS }),
        });
      }
      const parsed = parseGameCommand(String(line || "")); // the reply is the line a StreamElements bot would post
      const action = parsed ? { duel: "challenge" }[parsed.action] || parsed.action : "";
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
              names: this.seSettings().names,
              origin: "",
              now,
            })
          : "",
      });
    }
    // Test site only: pretend the channel is live ({live:true}, a new stream id unless streamId is given), offline
    // ({live:false}), or ask Twitch again ({live:null}).
    if (path === "/dev-live" && request.method === "POST") {
      if (!this.env?.DEV_TOOLS_TOKEN) return text("Not found", 404);
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      const { live, streamId } = body.value,
        sql = this.ctx.storage.sql;
      if (typeof live !== "boolean") sql.exec("DELETE FROM dev_live");
      else
        sql.exec(
          "INSERT OR REPLACE INTO dev_live (id, stream_id, started_at) VALUES (1, ?, ?)",
          live ? "dev-" + (/^[a-z0-9_-]{1,36}$/i.test(streamId || "") ? streamId : randomHex().slice(0, 12)) : "",
          Date.now(),
        );
      const row = sql.exec("SELECT stream_id FROM dev_live WHERE id = 1").toArray()[0];
      return json({ ok: true, live: row ? Boolean(row.stream_id) : null, streamId: row?.stream_id || "" });
    }
    if (path === "/chat" && request.method === "GET") return json(chatStatus(this.readState(channel)));
    if (path === "/chat" && request.method === "POST") {
      const body = await this.readJson(request);
      if (!body.ok) return json({ error: body.error }, 400);
      const event =
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
    return normalizeChannel(request.headers.get(CHANNEL_HEADER) || this.env.CHANNEL_NAME || site.defaultChannel);
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
      for (const userId of result.dirtyProfileIds) {
        const profile = result.state.players.find((item) => item.userId === userId);
        if (profile?.registered) this.upsertProfile(profile);
      }
      if (this.payDuels(result.state) || result.changed) this.writeState(result.state);
      if (result.resetAllRanks) this.resetAllRanks(result.state.config.initialElo);
      for (const userId of result.rankResetIds || []) {
        this.ctx.storage.sql.exec(
          "UPDATE profiles SET elo = ?, wins = 0, losses = 0 WHERE user_id = ?",
          result.state.config.initialElo,
          userId,
        );
        this.lookChanged(userId);
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
  }

  // Config history keeps every version so mods can review and roll back (see docs/CONTRACTS.md).
  seedConfigHistory(state) {
    const [{ n }] = this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM config_history").toArray();
    if (!n) this.recordConfigVersion(state.configVersion, state.config, "system", "initial", Date.now());
  }

  recordConfigVersion(version, config, actorId, note, now, actorName = "") {
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

  async readJson(request) {
    const length = Number(request.headers.get("content-length") || 0);
    if (length > 16 * 1024) return { ok: false, error: "request body too large" };
    try {
      const value = await request.json();
      if (!value || typeof value !== "object" || Array.isArray(value))
        return { ok: false, error: "JSON object required" };
      return { ok: true, value };
    } catch {
      return { ok: false, error: "invalid JSON" };
    }
  }

  saveProfile(channel, userId, input) {
    const username = normalizeUsername(input.username);
    const displayName = String(input.displayName || username)
      .trim()
      .slice(0, 48);
    const avatar = String(input.avatar || "player")
      .trim()
      .slice(0, 64);
    const color = /^#[0-9a-f]{6}$/i.test(input.color || "") ? input.color.toUpperCase() : "";
    const defaultAbility = ["strike", "heavy", "heal"].includes(input.defaultAbility) ? input.defaultAbility : "";
    if (!username || !/^[a-z0-9_]{1,25}$/.test(username) || !displayName || !avatar || !color || !defaultAbility) {
      return { ok: false, reason: "invalid_profile" };
    }

    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      const state = this.readState(channel);
      const existing = this.getProfile(userId, state.config);
      // Upgrades and hat: optional in the request (left out = keep the saved ones), checked against the wins the stream
      // has shown, so a save can't reveal a duel result the overlay hasn't played yet.
      const wins = Math.max(0, (existing?.wins || 0) - (hiddenResults(state, now).get(userId)?.wins || 0));
      const stats = input.stats === undefined ? existing?.stats : validStats(input.stats, wins, existing?.bonus || 0);
      if (stats === null) return { ok: false, reason: "invalid_upgrades" };
      const hat = input.hat === undefined ? existing?.hat || "" : input.hat;
      const owns = (kind, id) =>
        this.ctx.storage.sql
          .exec("SELECT 1 FROM owned_items WHERE user_id = ? AND kind = ? AND item_id = ?", userId, kind, id)
          .toArray().length > 0;
      if (hat !== (existing?.hat || "") && !hatUnlocked(hat, wins) && !(knownHat(hat) && owns("hat", hat)))
        return { ok: false, reason: knownHat(hat) ? "hat_locked" : "invalid_profile" };
      // Pet: "" (none) or one the fighter bought that still exists.
      const petId = input.pet === undefined ? existing?.pet || "" : typeof input.pet === "string" ? input.pet : null;
      if (petId === null) return { ok: false, reason: "invalid_profile" };
      const custom = petId
        ? this.ctx.storage.sql
            .exec("SELECT tier || ':' || stat || ':' || stat2 AS c FROM custom_pets WHERE id = ?", petId)
            .toArray()[0]?.c
        : "";
      const pet = petId ? petOf(petId, custom) : null;
      if (petId && (!pet || !owns("pet", petId))) return { ok: false, reason: "pet_locked" };
      // Cosmetics: "" (none) or one the fighter bought. Left out = keep the saved one.
      const cosmetics = {};
      for (const kind of COSMETIC_KINDS) {
        const field = COSMETIC_FIELDS[kind],
          id = input[field] === undefined ? existing?.[field] || "" : input[field];
        if (typeof id !== "string" || (id && !cosmeticItem(kind, id))) return { ok: false, reason: "invalid_profile" };
        if (id && id !== (existing?.[field] || "") && !owns(kind, id)) return { ok: false, reason: "item_locked" };
        cosmetics[field] = id;
      }
      // Build slot: the one this loadout is saved to, which becomes the active one. Left out = the active slot.
      const build = input.build === undefined ? existing?.build || 0 : input.build;
      if (!Number.isInteger(build) || build < 0 || build >= this.buildSlots(userId))
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
      this.writeState(result.state);
      const active = result.state.players.find((item) => item.userId === userId);
      this.upsertProfile(active || profile);
      this.ctx.storage.sql.exec("UPDATE profiles SET build = ? WHERE user_id = ?", build, userId);
      this.ctx.storage.sql.exec(
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
      };
      return { ok: true, profile: saved, state: result.state };
    });
  }

  // An approved viewer sprite goes on its uploader's saved fighter, and replaces their previous sprite in every build
  // slot. Returns the new game state when the overlay needs it, else null.
  wearSprite(channel, row, previous) {
    const sql = this.ctx.storage.sql;
    if (previous)
      sql.exec(
        "UPDATE builds SET data = json_set(data, '$.avatar', ?) WHERE user_id = ? AND json_extract(data, '$.avatar') = ?",
        row.id,
        row.userId,
        previous,
      );
    const existing = this.getProfile(row.userId, this.readState(channel).config);
    if (!existing) return null;
    const saved = this.saveProfile(channel, row.userId, {
      username: existing.username,
      displayName: existing.displayName,
      color: existing.color,
      defaultAbility: existing.defaultAbility,
      avatar: row.id,
    });
    return saved.ok ? saved.state : null;
  }

  // A removed viewer sprite: fighters wearing it, saved or on stage, go back to the default character.
  dropSprite(channel, id) {
    const sql = this.ctx.storage.sql;
    for (const row of sql.exec("SELECT user_id FROM profiles WHERE avatar = ?", id).toArray())
      this.lookChanged(row.user_id);
    sql.exec("UPDATE profiles SET avatar = 'player' WHERE avatar = ?", id);
    sql.exec(
      "UPDATE builds SET data = json_set(data, '$.avatar', 'player') WHERE json_extract(data, '$.avatar') = ?",
      id,
    );
    const state = this.readState(channel);
    let hit = false;
    for (const p of state.players)
      if (p.avatar === id) {
        p.avatar = "player";
        hit = true;
      }
    if (!hit) return null;
    state.revision += 1;
    this.writeState(state);
    return state;
  }

  getProfile(userId, config) {
    const row = this.ctx.storage.sql
      .exec(`SELECT ${PROFILE_COLUMNS}, last_opponent FROM profiles WHERE user_id = ?`, userId)
      .toArray()[0];
    return normalizeProfileRow(row, config);
  }

  getProfileByUsername(username, config) {
    const name = normalizeUsername(username);
    if (!name) return null;
    const row = this.ctx.storage.sql
      .exec(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE username = ? COLLATE NOCASE`, name)
      .toArray()[0];
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
      "INSERT INTO profiles (user_id, username, display_name, avatar, color, default_ability, elo, wins, losses, last_seen, power, guard, luck, hat, last_opponent, pet) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, '')) " +
        "ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name, avatar = excluded.avatar, color = excluded.color, default_ability = excluded.default_ability, elo = excluded.elo, wins = excluded.wins, losses = excluded.losses, last_seen = excluded.last_seen, " +
        "power = excluded.power, guard = excluded.guard, luck = excluded.luck, hat = excluded.hat, " +
        // A game state player from before pets has no pet field; keep the stored one then.
        "pet = CASE WHEN ? IS NULL THEN profiles.pet ELSE excluded.pet END, " +
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
      typeof profile.pet === "string" ? profile.pet : null,
      typeof profile.pet === "string" ? profile.pet : null,
    );
    // A game state player from before cosmetics has none of the fields; keep the stored ones then.
    if (typeof profile.recolor === "string") {
      const worn = cleanCosmetics(profile);
      this.ctx.storage.sql.exec(
        `UPDATE profiles SET ${Object.values(COSMETIC_COLUMNS)
          .map((c) => c + " = ?")
          .join(", ")} WHERE user_id = ?`,
        ...Object.keys(COSMETIC_COLUMNS).map((f) => worn[f]),
        profile.userId,
      );
    }
    this.lookChanged(profile.userId);
  }

  deleteProfile(userId) {
    const login = this.ctx.storage.sql
      .exec("SELECT username FROM profiles WHERE user_id = ?", userId)
      .toArray()[0]?.username;
    if (login) this.lookGone(login);
    this.ctx.storage.sql.exec("DELETE FROM profiles WHERE user_id = ?", userId);
    this.ctx.storage.sql.exec("DELETE FROM owned_items WHERE user_id = ?", userId);
    this.ctx.storage.sql.exec("DELETE FROM builds WHERE user_id = ?", userId);
  }

  resetAllRanks(initialElo) {
    this.ctx.storage.sql.exec("UPDATE profiles SET elo = ?, wins = 0, losses = 0", initialElo);
    this.looksReset = true;
    this.flushLooksSoon();
  }

  // ---------- look sync ----------
  // Every write to a saved fighter (website save, duel result, approved or removed sprite, rank reset, delete) is pushed
  // to open overlays as one {type:"looks"} message per turn of the event loop. It carries only viewers the active list
  // doesn't: snapshots already carry those, and a pushed look (masked while a duel result is hidden) must not overwrite
  // them. looks maps login -> look, or null for a deleted fighter; reset: every saved look is stale (all ranks reset).
  lookChanged(userId) {
    (this.dirtyLooks ||= new Set()).add(String(userId));
    this.flushLooksSoon();
  }
  lookGone(login) {
    (this.goneLooks ||= new Set()).add(String(login).toLowerCase());
    this.flushLooksSoon();
  }
  flushLooksSoon() {
    if (!this.lookFlush)
      this.lookFlush = setTimeout(() => {
        this.lookFlush = 0;
        this.flushLooks();
      }, 0);
  }
  flushLooks() {
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
          return ws.deserializeAttachment()?.channel;
        } catch {
          return "";
        }
      })
      .find(Boolean);
    if (!channel) return;
    const state = this.readState(channel),
      hidden = hiddenResults(state, Date.now()),
      looks = {};
    const listed = new Set(state.players.map((p) => p.userId)),
      wanted = ids.filter((id) => !listed.has(id));
    for (const login of gone) looks[login] = null;
    for (let i = 0; i < wanted.length; i += 50) {
      const part = wanted.slice(i, i + 50);
      const rows = this.ctx.storage.sql
        .exec(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE user_id IN (${part.map(() => "?").join(",")})`, ...part)
        .toArray();
      for (const row of rows) {
        const p = shownProfile(normalizeProfileRow(row, state.config), hidden);
        if (p) looks[p.username.toLowerCase()] = savedLook(p);
      }
    }
    if (!reset && !Object.keys(looks).length) return;
    const message = JSON.stringify({ type: "looks", looks, ...(reset ? { reset: true } : {}) });
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(message);
      } catch {}
    }
  }

  leaderboard(channel) {
    const state = this.readState(channel);
    const rows = this.ctx.storage.sql
      .exec(
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

  // One saved profile with its leaderboard place (same order as leaderboard()), or null.
  eloLookup(channel, { userId = "", username = "" }) {
    const sql = this.ctx.storage.sql;
    const row = (
      userId
        ? sql.exec(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE user_id = ?`, userId)
        : sql.exec(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE username = ? COLLATE NOCASE`, username)
    ).toArray()[0];
    if (!row) return null;
    const state = this.readState(channel),
      hidden = hiddenResults(state, Date.now());
    const profile = shownProfile(normalizeProfileRow(row, state.config), hidden);
    let ahead = Number(
      sql
        .exec(
          "SELECT COUNT(*) AS n FROM profiles WHERE user_id != ? AND (elo > ? OR (elo = ? AND wins > ?) OR (elo = ? AND wins = ? AND username COLLATE NOCASE < ?))",
          profile.userId,
          profile.elo,
          profile.elo,
          profile.wins,
          profile.elo,
          profile.wins,
          row.username,
        )
        .toArray()[0].n,
    );
    // The count used everyone's saved numbers; swap in the shown ones for fighters whose result is still hidden.
    for (const id of hidden.keys()) {
      if (id === profile.userId) continue;
      const other = sql.exec(`SELECT ${PROFILE_COLUMNS} FROM profiles WHERE user_id = ?`, id).toArray()[0];
      if (!other) continue;
      const saved = normalizeProfileRow(other, state.config);
      ahead += Number(boardOrder(shownProfile(saved, hidden), profile) < 0) - Number(boardOrder(saved, profile) < 0);
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

  async upgrade(request, kind, channel, overlay = false) {
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

  async webSocketMessage(ws) {
    // Overlay sockets are read-only snapshots. "ping" never reaches here: the auto-response in the constructor answers it.
    try {
      ws.close(1008, "Read-only socket");
    } catch {}
  }

  async eventsub(channel, msg, origin = "") {
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
    // redelivery after a restart or to another isolate is ignored too; other lines only in memory (server/dedupe.js).
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

  async handleEventsub(channel, msg, origin, kind, now) {
    const subscriptionId = String(msg.subscription?.id || "");
    let result;
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
    } else if (kind === "notification" && msg.bot === true) return this.botCommand(channel, msg, origin);
    else if (kind === "notification") {
      await this.checkAccountAge(msg.event?.chatter_user_id);
      result = this.processChatMessage(channel, msg, now);
    } else return json({ ok: true, ignored: true });
    if (result.visible) this.broadcast(result.state);
    if (result.changed) await this.scheduleAlarm(result.state);
    return json({ ok: Boolean(result.result?.ok), reason: String(result.result?.reason || "") });
  }

  seSettings() {
    const row = this.ctx.storage.sql
      .exec(
        "SELECT secret, names, last_command_at, rejected_at, seen_json, duel_module_off FROM se_settings WHERE id = 1",
      )
      .toArray()[0];
    if (row) {
      const names = { ...DEFAULT_SE_NAMES, ...safeJsonParse(row.names, {}) };
      if (names.accept === "!accept") names.accept = DEFAULT_SE_NAMES.accept; // StreamElements' Duel module owns !accept
      if (names.top === "!top") names.top = DEFAULT_SE_NAMES.top; // and its built-in !top can't be replaced
      if (names.give === "!give") names.give = DEFAULT_SE_NAMES.give; // nor its !givepoints alias !give
      if (names.help === "!minichat") names.help = DEFAULT_SE_NAMES.help; // the old name, from before the rename to PixFray
      const stored = safeJsonParse(row.seen_json, {}),
        seen = {};
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

  writeSeSettings(secret, names) {
    this.ctx.storage.sql.exec(
      "INSERT INTO se_settings (id, secret, names) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET secret = excluded.secret, names = excluded.names",
      secret,
      JSON.stringify(names),
    );
  }

  // A connected PixFray chat bot (test site, CHAT_BOT=1): an EventSub subscription that reads chat as the bot account.
  botSource(state) {
    const id = state.chat.subscriptionId;
    return (
      this.env?.CHAT_BOT === "1" &&
      state.chat.connected &&
      Boolean(id) &&
      id !== SE_SUBSCRIPTION_ID &&
      !id.startsWith("local-")
    );
  }

  // One StreamElements command. It goes through the same path as a Twitch chat message, then gets a one-line reply.
  async streamElements(channel, input, origin) {
    const settings = this.seSettings();
    if (!timingSafeEqual(String(input.key || ""), settings.secret)) {
      if (Date.now() - settings.rejectedAt > REJECTED_WRITE_MS)
        this.ctx.storage.sql.exec("UPDATE se_settings SET rejected_at = ? WHERE id = 1", Date.now());
      return json({ reply: "PixFray: wrong key. Copy the commands again from the admin page." }, 403);
    }
    // The bot answers every command itself, so StreamElements posts nothing (no double replies) and keeps the chat source.
    if (this.botSource(this.readState(channel))) return json({ reply: "" });
    const action = SE_ACTIONS.includes(input.action) ? input.action : "";
    if (action && Date.now() - (settings.seen[action] || 0) > SEEN_WRITE_MS) {
      this.ctx.storage.sql.exec(
        "UPDATE se_settings SET last_command_at = ?, seen_json = ? WHERE id = 1",
        Date.now(),
        JSON.stringify({ ...settings.seen, [action]: Date.now() }),
      );
    } else this.ctx.storage.sql.exec("UPDATE se_settings SET last_command_at = ? WHERE id = 1", Date.now());
    return this.runCommand(channel, input, origin, settings, { kind: "se", subscriptionId: SE_SUBSCRIPTION_ID });
  }

  // A chat line read by the PixFray bot. Its first word is matched against the channel's command names (the same names
  // StreamElements uses); anything else, like another bot's command, gets no reply. Replies are capped per 30 s.
  async botCommand(channel, msg, origin) {
    const ev = msg.event && typeof msg.event === "object" ? msg.event : {};
    const words = String(ev.message?.text || "")
      .trim()
      .split(/\s+/);
    const se = this.seSettings(),
      settings = { ...se, names: botNames(se.names) };
    const first = (words[0] || "").toLowerCase();
    // "!pay" stays an alias of !give, the name it had while StreamElements' !give (!givepoints) was in the way.
    let action =
      SE_ACTIONS.find((a) => String(settings.names[a] || "").toLowerCase() === first) ||
      (first === "!pay" ? "give" : "");
    const custom =
      action || !first.startsWith("!")
        ? null
        : this.ctx.storage.sql.exec("SELECT name, reply FROM bot_commands WHERE name = ?", first).toArray()[0];
    // Words new viewers guess (!accept, !duel, !top) work as hidden aliases, unless the channel made them its own commands.
    if (
      !action &&
      !custom &&
      BOT_ALIASES[first] &&
      !Object.values(settings.names).some((n) => String(n).toLowerCase() === first)
    )
      action = BOT_ALIASES[first];
    if (!action && !custom) return json({ ok: true, reason: "not_command", reply: "" });
    const subscriptionId = String(msg.subscription?.id || "");
    const state = this.readState(channel);
    if (!subscriptionId || subscriptionId !== state.chat.subscriptionId) {
      this.noteBotHeld(channel, "unknown_subscription", { subscriptionId: subscriptionId.slice(0, 64) });
      return json({ ok: true, reason: "unknown_subscription", reply: "" });
    }
    const before = this.botStatus();
    this.noteBotHeard(`${normalizeUsername(ev.chatter_user_login) || "?"} ${first}`);
    this.rememberReminder(String(ev.broadcaster_user_id || ""), validUserId(msg.botId), origin);
    if (!state.chat.connected) {
      // Twitch only notifies enabled subscriptions, so this confirms a pending one
      const verified = this.advance(channel, { type: "chat_verified", subscriptionId }, Date.now());
      if (verified.visible) this.broadcast(verified.state);
      await this.scheduleAlarm(verified.state);
    }
    // "!fray off" / "!fray on" (broadcaster or a mod) turns the whole bot off or on in this channel; while it's off,
    // every other command gets no reply.
    const chatterId = validUserId(ev.chatter_user_id),
      boss = chatterId === validUserId(ev.broadcaster_user_id) || ev.mod === true;
    const toggle = action === "help" && boss ? String(words[1] || "").toLowerCase() : "";
    const off = state.config.botEnabled === false;
    if (toggle === "on" || toggle === "off") {
      if (off !== (toggle === "off")) {
        const set = this.advance(
          channel,
          {
            type: "admin",
            actorId: chatterId,
            actorName: String(ev.chatter_user_login || "").slice(0, 48),
            action: "config",
            payload: { patch: { botEnabled: toggle === "on" } },
            note: "bot " + toggle + " (chat)",
          },
          Date.now(),
        );
        if (!set.result.ok) return json({ ok: false, reason: set.result.reason, reply: "" });
        this.broadcast(set.state);
        await this.scheduleAlarm(set.state);
      }
      return this.sendBotLines(
        [
          toggle === "on"
            ? `PixFray bot is on. Type ${settings.names.help} to play.`
            : `PixFray bot is off: it ignores commands until the broadcaster or a mod types ${settings.names.help} on.`,
        ],
        channel,
      );
    }
    if (off) return json({ ok: true, reason: "bot_off", reply: "" });
    // The alarm posts each result at its reveal time; any result it missed goes out now, before this reply.
    await this.postResults(channel, Date.now());
    if (custom) {
      // A reply the cap would drop doesn't start the cooldown or add to its counters.
      if (!this.botReplyRoom(Date.now())) return this.sendBotLines([custom.name], channel);
      const line = this.customReply(custom, ev, words, Date.now());
      if (!line) this.noteBotHeld(channel, "cooldown", { command: custom.name }, false);
      return this.sendBotLines([line], channel);
    }
    // "!fray debug" (broadcaster, mods or the bot account): the bot's health in one line, as the admin page shows it.
    if (action === "help" && String(words[1] || "").toLowerCase() === "debug") {
      const userId = validUserId(ev.chatter_user_id),
        allowed =
          userId === validUserId(msg.botId) || userId === validUserId(ev.broadcaster_user_id) || ev.mod === true;
      return this.sendBotLines(
        [
          allowed
            ? this.botStatusLine(state, before, Date.now())
            : "PixFray debug: only the broadcaster or a mod can use !fray debug.",
        ],
        channel,
      );
    }
    const input = {
      action,
      userId: ev.chatter_user_id,
      username: ev.chatter_user_login,
      displayName: ev.chatter_user_name,
      target: seTarget(words[1]),
      targetRaw: words[1] || "",
      ...(action === "give" ? { amount: String(words[2] || "").slice(0, 16) } : {}),
      messageId: String(ev.message_id || msg.messageId || ""),
    };
    // BOT_DEBUG (test site): the bot account also plays. "!fray spar" and "!fray e2e" replace the help reply.
    const botId = this.env?.BOT_DEBUG === "1" ? validUserId(msg.botId) : "";
    const mode = botId && action === "help" ? String(words[1] || "").toLowerCase() : "";
    let lines;
    if (mode === "spar" || mode === "e2e")
      lines = await this.botDebug(channel, mode, { ev, words, botId, origin, settings, subscriptionId });
    else if (
      !botId &&
      BOT_TARGET_ACTIONS[action] &&
      input.target &&
      this.getProfileByUsername(input.target, state.config)?.userId === validUserId(msg.botId)
    ) {
      // The bot account isn't a fighter or a wallet (yet; it may become a boss viewers fight together). The test site's
      // sparring bot (BOT_DEBUG) still plays.
      lines = [BOT_TARGET_ACTIONS[action](settings.names)];
    } else {
      const since = this.readState(channel).revision;
      const out = await (
        await this.runCommand(channel, input, origin, settings, { kind: "bot", subscriptionId })
      ).json();
      const expired = this.expiredLines(this.readState(channel), since);
      lines = [
        ...expired,
        out.reply,
        ...(botId && validUserId(input.userId) !== botId
          ? await this.botAnswer(channel, input, out, { botId, origin, settings, subscriptionId })
          : []),
      ];
      return this.sendBotLines(lines, channel, { system: expired.length });
    }
    return this.sendBotLines(lines, channel);
  }

  // The bot's reply lines that fit under BOT_REPLIES_PER_30S, as the Worker expects them: { reply, replies }.
  // Replies to commands stop BOT_RESERVED_LINES short of the cap; the bot's own lines (results, expired challenges;
  // the first `system` lines) may use the rest, so a chatter spamming commands can't crowd out who won.
  // How many more command replies fit under the cap right now.
  botReplyRoom(now) {
    return Math.max(
      0,
      BOT_REPLIES_PER_30S - BOT_RESERVED_LINES - (this.botReplies || []).filter((at) => now - at < 30000).length,
    );
  }

  sendBotLines(lines, channel = "", { system = 0 } = {}) {
    const now = Date.now(),
      sent = [];
    this.botReplies = (this.botReplies || []).filter((at) => now - at < 30000);
    for (const [i, line] of lines.entries()) {
      if (!line) continue;
      if (this.botReplies.length >= BOT_REPLIES_PER_30S - (i < system ? 0 : BOT_RESERVED_LINES)) {
        if (i < system) continue;
        break;
      }
      this.botReplies.push(now);
      sent.push(line);
    }
    const cut = lines.filter(Boolean).length - sent.length;
    if (cut) this.noteBotHeld(channel, "reply_limit", { cut });
    if (!sent.length)
      return json({ ok: true, reason: lines.some(Boolean) ? "reply_limit" : "no_reply", reply: "", replies: [] });
    return json({ ok: true, reply: sent[0], replies: sent });
  }

  // One command played by the bot account (BOT_DEBUG), through the same path as a chat line. Returns { reply, reason }.
  /**
   * @param {string} channel
   * @param {any} bot
   * @param {string} action
   * @param {string} target
   * @param {{ origin: string, settings: any, subscriptionId: string, kind?: string, amount?: number }} ctx
   */
  async botPlays(channel, bot, action, target, { origin, settings, subscriptionId, kind = "bot", amount }) {
    const input = {
      action,
      userId: bot.userId,
      username: bot.username,
      displayName: bot.displayName || bot.username,
      target,
      targetRaw: target ? "@" + target : "",
      ...(amount !== undefined ? { amount: String(amount) } : {}),
    };
    return (await this.runCommand(channel, input, origin, settings, { kind, subscriptionId })).json();
  }

  // Sparring partner (BOT_DEBUG): a challenge or rematch aimed at the bot is accepted, and dollars paid to it are paid back.
  async botAnswer(channel, input, out, ctx) {
    const config = this.readState(channel).config,
      bot = this.getProfile(ctx.botId, config);
    if (!bot) return [];
    const userId = validUserId(input.userId);
    if (this.readState(channel).duels.some((d) => d.status === "pending" && d.a === userId && d.b === ctx.botId))
      return [(await this.botPlays(channel, bot, "accept", "", ctx)).reply];
    if (input.action === "give" && out.reason === "given" && normalizeUsername(input.target) === bot.username) {
      return [
        (await this.botPlays(channel, bot, "give", normalizeUsername(input.username), { ...ctx, amount: input.amount }))
          .reply,
      ];
    }
    return [];
  }

  // "!fray spar": the bot challenges whoever asked. "!fray e2e [@name]" (broadcaster, mods or the bot account): the bot
  // plays every chat command once against @name (default: whoever asked) and posts which steps passed.
  async botDebug(channel, mode, { ev, words, botId, origin, settings, subscriptionId }) {
    const config = this.readState(channel).config,
      bot = this.getProfile(botId, config);
    const userId = validUserId(ev.chatter_user_id),
      username = normalizeUsername(ev.chatter_user_login);
    if (!bot)
      return [
        `PixFray debug: the bot account has no saved fighter here yet. Sign in as the bot at ${origin}/?channel=${channel} and save one.`,
      ];
    const ctx = { origin, settings, subscriptionId };
    if (mode === "spar") {
      if (userId === botId)
        return ["PixFray debug: the bot can't spar with itself. Type !fray spar from another account."];
      return [(await this.botPlays(channel, bot, "challenge", username, ctx)).reply];
    }
    const allowed = userId === botId || userId === validUserId(ev.broadcaster_user_id) || ev.mod === true;
    if (!allowed) return ["PixFray debug: only the broadcaster or a mod can run !fray e2e."];
    const named = seTarget(words[2]);
    const opponent = named
      ? this.getProfileByUsername(named, config)
      : userId === botId
        ? null
        : this.getProfile(userId, config);
    if (!opponent)
      return [
        named
          ? `PixFray debug: @${named} has no saved fighter here.`
          : userId === botId
            ? "PixFray debug: name the opponent: !fray e2e @name"
            : `PixFray debug: @${username} has no saved fighter here. Save one at ${origin}/?channel=${channel}`,
      ];
    if (opponent.userId === botId) return ["PixFray debug: the opponent can't be the bot itself."];
    return this.botE2e(channel, bot, opponent, { ...ctx, kind: "e2e" });
  }

  async botE2e(channel, bot, opponent, ctx) {
    const names = ctx.settings.names,
      results = [];
    const player = { B: bot, O: opponent };
    for (const [who, action, target, want, gate] of E2E_STEPS) {
      const actor = player[who],
        aimed = target ? player[target].username : "";
      const out = await this.botPlays(channel, actor, action, aimed, {
        ...ctx,
        amount: action === "give" ? 1 : undefined,
      });
      const ok = Boolean(out.reply) && want.includes(out.reason);
      const label =
        String(names[action] || action).replace(/^!/, "") +
        (aimed ? " @" + aimed : "") +
        (who === "O" ? " by " + opponent.username : "");
      results.push({ label, action, ok, reason: out.reason, want });
      // A rematch the game allowed leaves a challenge open; the opponent declines it so the run ends clean.
      if (action === "rematch" && out.reason === "challenge")
        await this.botPlays(channel, opponent, "decline", "", ctx);
      if (!ok && gate) break; // the steps after this one need its duel
    }
    const passed = results.filter((r) => r.ok).length,
      stopped = results.length < E2E_STEPS.length;
    const head =
      `PixFray e2e, ${bot.username} vs ${opponent.username}: ${passed} of ${E2E_STEPS.length} steps passed` +
      (stopped ? `, stopped early (a duel or cooldown between them is still running; try again in 30 s).` : ".");
    const parts = results.map((r) =>
      r.ok
        ? `${r.label} ok${r.reason !== r.action ? " (" + r.reason + ")" : ""}`
        : `FAIL ${r.label}: got ${r.reason || "no reply"}, want ${r.want.join("|")}`,
    );
    logRoomEvent(this, "command", `e2e ${bot.username} vs ${opponent.username}: ${passed}/${E2E_STEPS.length}`, {
      channel,
      via: "e2e",
      passed,
      steps: E2E_STEPS.length,
      results,
    });
    return [head, ...chatLines(parts, " · ", MAX_E2E_LINE)];
  }

  // The command itself, shared by StreamElements and the bot. source: { kind: "se" | "bot", subscriptionId }.
  async runCommand(channel, input, origin, settings, source) {
    const action = SE_ACTIONS.includes(input.action) ? input.action : "";
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
    if (
      source.kind === "se" &&
      state0.chat.subscriptionId !== SE_SUBSCRIPTION_ID &&
      (this.env?.SE_ONLY === "1" || !turnedOff)
    ) {
      switchedFrom = state0.chat.subscriptionId || ""; // a Twitch EventSub subscription the Worker deletes
      const switched = this.advance(
        channel,
        { type: "chat_subscription", subscriptionId: SE_SUBSCRIPTION_ID, status: "enabled", createdAt: now },
        now,
      );
      if (switched.visible) this.broadcast(switched.state);
      await this.scheduleAlarm(switched.state);
      state0 = switched.state;
    }
    // Every command is logged with what came in, what the game decided and what the bot said.
    const done = (reply, reason, extra = {}) => {
      logRoomEvent(
        this,
        "command",
        `${username || "?"} ${input.action || "?"}${target ? " @" + target : ""} -> ${reason}`,
        {
          channel,
          via: source.kind,
          user: username,
          userId,
          action: input.action,
          t: String(input.targetRaw || "").slice(0, 80),
          target,
          reason,
          reply,
          ...extra,
        },
      );
      return json({ reply, ...(source.kind === "se" ? {} : { reason }), ...(switchedFrom ? { switchedFrom } : {}) }); // the bot reads reason
    };
    if (!action) return done(`Lost in the arena? Type ${names.help}`, "unknown_action");
    if (!userId || !username)
      return done(
        "PixFray: this command is missing sender details. Copy it again from the admin page.",
        "missing_sender",
      );
    if (action === "checkin") {
      // works while duels are paused: it only needs the stream to be live
      const checked = await this.checkin(channel, { userId }, now);
      return done(
        seCheckinText(checked, { who: input.displayName || username, origin, channel, maxPoints: MAX_POINTS }),
        checked.reason,
        checked.reason === "checked_in" ? { streak: checked.streak, points: checked.points } : {},
      );
    }
    if (action === "wallet") {
      // like !elo, it works while duels are paused
      const wallet = this.wallet(channel, userId);
      return done(
        seWalletText(wallet, { who: input.displayName || username, origin, channel, maxPoints: MAX_POINTS }),
        wallet ? "wallet" : "no_fighter",
      );
    }
    if (action === "pet") {
      // like !wallet, it works while duels are paused
      const self = !target || target === username,
        info = this.petInfo(channel, self ? { userId } : { username: target });
      return done(
        sePetText(info, { who: input.displayName || username, target: self ? "" : target, origin, channel }),
        info ? (info.pet ? "pet" : "no_pet") : "no_fighter",
      );
    }
    if (action === "give") {
      const given = await this.give(channel, { userId, target, amount: seAmount(input.amount) }, now);
      return done(
        seGiveText(given, { who: input.displayName || username, target, origin, channel, names }),
        given.reason,
        given.reason === "given" ? { amount: given.amount } : {},
      );
    }
    if (SE_READ_ACTIONS.includes(action)) {
      if (action === "help") return done(seHelpText({ names, origin, channel }), "help");
      if (action === "look")
        return done(
          seLookText({
            who: input.displayName || username,
            hasFighter: Boolean(this.getProfile(userId, state0.config)),
            origin,
            channel,
          }),
          "look",
        );
      if (action === "top") return done(seTopText(this.leaderboard(channel).slice(0, 5), { origin, channel }), "top");
      const found = this.eloLookup(channel, target ? { username: target } : { userId });
      return done(
        seEloText(found, { self: !target, askerName: input.displayName || username, target, origin, channel }),
        found ? "elo" : "elo_not_found",
      );
    }
    if (!state0.chat.connected || state0.chat.subscriptionId !== source.subscriptionId)
      return done(
        seReplyText({
          result: { ok: false, reason: "chat_offline" },
          state: state0,
          actorId: userId,
          action,
          target,
          names,
          origin,
          now,
        }),
        "chat_offline",
      );
    if (action === "challenge" && !target)
      return done(
        seReplyText({
          result: { ok: false, reason: "target_required" },
          state: state0,
          actorId: userId,
          action,
          target,
          names,
          origin,
          now,
        }),
        "target_required",
      );
    const messageId = source.kind + ":" + (String(input.messageId || "").slice(0, 60) || randomHex().slice(0, 24));
    const msg = {
      messageId,
      timestamp: now,
      quick: true,
      subscription: { id: source.subscriptionId },
      event: {
        chatter_user_id: userId,
        chatter_user_login: username,
        chatter_user_name: String(input.displayName || username).slice(0, 48),
        message_id: messageId,
        message: { text: seCommandText(action, target) },
      },
    };
    await this.checkAccountAge(userId);
    const result = this.processChatMessage(channel, msg, Date.now());
    if (result.visible) this.broadcast(result.state);
    if (result.changed) await this.scheduleAlarm(result.state);
    const r = result.result || {};
    if (r.reason === "quick_duel" || r.reason === "duel_completed") this.checkSavedProfiles(result.state, r.duelId);
    const actorRegistered =
      r.reason !== "ranked_sign_in_required" ||
      this.ctx.storage.sql.exec("SELECT 1 FROM profiles WHERE user_id = ?", userId).toArray().length > 0;
    return done(
      seReplyText({
        result: r,
        state: result.state,
        actorId: userId,
        action,
        target,
        names,
        origin,
        now,
        actorRegistered,
      }),
      r.reason || (r.ok ? action : "error"),
      r.swings
        ? {
            duelId: r.duelId,
            swings: r.swings.map((s) => s.die + ({ crit: "x" }[s.outcome] || s.outcome[0])).join(" "),
          }
        : {},
    );
  }

  // !checkin: once per stream, only while Twitch says the channel is live. Gives config.checkinPoints, plus 1 when the
  // streak reaches a milestone. A streak counts this channel's streams with check-ins (the streams table) in a row;
  // one missed stream a week is forgiven. Points are stored apart from wins (bonus_points), so a rank reset keeps them.
  async checkin(channel, { userId }, now = Date.now()) {
    if (!userId || !this.getProfile(userId, this.readState(channel).config)) return { reason: "no_fighter" };
    let stream;
    try {
      stream = await this.currentStream(channel, now);
    } catch (error) {
      logRoomEvent(this, "warn", "twitch stream lookup failed", {
        channel,
        error: String(error?.message || error).slice(0, 200),
      });
      return { reason: "twitch_error" };
    }
    // Test mode while offline: the check-in a next stream would give, worked out the same way but never saved.
    const test = !stream && Boolean(this.checkinTest(now));
    if (!stream && !test) return { reason: "not_live" };
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql,
        state = this.readState(channel),
        config = state.config;
      const row = sql
        .exec(
          "SELECT wins, bonus_points, streak, last_stream, last_stream_seq, free_miss_at FROM profiles WHERE user_id = ?",
          userId,
        )
        .toArray()[0];
      if (!row) return { reason: "no_fighter" };
      if (!test && row.last_stream === stream.id) return { reason: "already_checked_in", streak: row.streak };
      if (!test)
        sql.exec(
          "INSERT OR IGNORE INTO streams (stream_id, started_at) VALUES (?, ?)",
          stream.id,
          stream.startedAt || now,
        );
      const seq = test
        ? (sql.exec("SELECT MAX(seq) AS seq FROM streams").toArray()[0]?.seq || 0) + 1
        : sql.exec("SELECT seq FROM streams WHERE stream_id = ?", stream.id).toArray()[0].seq;
      const missed = row.last_stream_seq > 0 ? seq - row.last_stream_seq - 1 : -1;
      const freeMiss = missed === 1 && now - row.free_miss_at >= FREE_MISS_MS;
      const streak = missed === 0 || freeMiss ? row.streak + 1 : 1;
      const milestone = Boolean(config.streakBonus) && STREAK_MILESTONES.includes(streak);
      const points = config.checkinPoints + (milestone ? 1 : 0);
      const bonus = Math.min(MAX_BONUS, row.bonus_points + points);
      // The total counts only wins the stream has shown, like !wallet: a quick duel still playing doesn't give it away.
      const wins = row.wins - (hiddenResults(state, now).get(userId)?.wins || 0);
      if (test)
        return { reason: "checked_in", test: true, streak, points, milestone, freeMiss, total: pointsFor(wins, bonus) };
      sql.exec(
        "UPDATE profiles SET bonus_points = ?, checkins = checkins + 1, streak = ?, last_stream = ?, last_stream_seq = ?, free_miss_at = ? WHERE user_id = ?",
        bonus,
        streak,
        stream.id,
        seq,
        freeMiss ? now : row.free_miss_at,
        userId,
      );
      const active = state.players.find((p) => p.userId === userId);
      if (active) {
        active.bonus = bonus;
        this.writeState(state);
      } // the next duel counts the new points
      return { reason: "checked_in", streak, points, milestone, freeMiss, total: pointsFor(wins, bonus) };
    });
  }

  // !wallet: dollars, upgrade points and streak as the stream has shown them (a quick duel's payout stays hidden too).
  wallet(channel, userId) {
    const state = this.readState(channel);
    const profile = userId && shownProfile(this.getProfile(userId, state.config), hiddenResults(state, Date.now()));
    return profile
      ? { dollars: profile.dollars, points: pointsFor(profile.wins, profile.bonus), streak: profile.streak }
      : null;
  }

  // !give @name amount: dollars from one saved fighter to another, only while the channel is live. Limits (config):
  // giveEnabled, giveMinDuels finished duels first, and at most giveMaxPerStream given per stream.
  async give(channel, { userId, target, amount }, now = Date.now()) {
    const config = this.readState(channel).config;
    if (!config.giveEnabled) return { reason: "give_off" };
    const giver = userId && this.getProfile(userId, config);
    if (!giver) return { reason: "no_fighter" };
    if (!target || !Number.isInteger(amount) || amount < 1) return { reason: "give_usage" };
    const to = this.getProfileByUsername(target, config);
    if (!to) return { reason: "target_not_found" };
    if (to.userId === giver.userId) return { reason: "self_give" };
    let stream;
    try {
      stream = await this.currentStream(channel, now);
    } catch (error) {
      logRoomEvent(this, "warn", "twitch stream lookup failed", {
        channel,
        error: String(error?.message || error).slice(0, 200),
      });
      return { reason: "twitch_error" };
    }
    if (!stream) return { reason: "not_live" };
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql,
        state = this.readState(channel),
        cfg = state.config;
      const row = sql
        .exec(
          "SELECT wins, losses, dollars, give_stream, given_in_stream FROM profiles WHERE user_id = ?",
          giver.userId,
        )
        .toArray()[0];
      if (!row) return { reason: "no_fighter" };
      // Spend only what the stream has shown: a quick duel's payout or result still hidden doesn't count yet.
      const h = hiddenResults(state, now).get(giver.userId) || { wins: 0, losses: 0, dollars: 0 };
      const duels = row.wins + row.losses - h.wins - h.losses,
        dollars = Math.max(0, row.dollars - h.dollars);
      if (duels < cfg.giveMinDuels) return { reason: "too_few_duels", duels, need: cfg.giveMinDuels };
      const given = row.give_stream === stream.id ? row.given_in_stream : 0,
        left = Math.max(0, cfg.giveMaxPerStream - given);
      if (!left) return { reason: "give_cap", max: cfg.giveMaxPerStream };
      if (amount > left) return { reason: "over_cap", left, max: cfg.giveMaxPerStream };
      if (amount > dollars) return { reason: "not_enough", dollars };
      // A wallet holds at most MAX_DOLLARS; a gift that wouldn't fit is refused rather than losing the rest.
      const room =
        MAX_DOLLARS -
        (sql.exec("SELECT dollars FROM profiles WHERE user_id = ?", to.userId).toArray()[0]?.dollars || 0);
      if (amount > room) return { reason: "target_full", to: to.displayName || to.username, room: Math.max(0, room) };
      sql.exec(
        "UPDATE profiles SET dollars = dollars - ?, give_stream = ?, given_in_stream = ? WHERE user_id = ?",
        amount,
        stream.id,
        given + amount,
        giver.userId,
      );
      sql.exec("UPDATE profiles SET dollars = dollars + ? WHERE user_id = ?", amount, to.userId);
      return {
        reason: "given",
        amount,
        to: to.displayName || to.username,
        dollars: dollars - amount,
        left: left - amount,
      };
    });
  }

  // What a fighter bought: { pets: [ids], hats: [ids], <cosmetic kind>: [ids], slots: build slots (1 free + bought) }.
  owned(userId) {
    const out = { pets: [], hats: [], ...Object.fromEntries(COSMETIC_KINDS.map((k) => [k, []])), slots: 1 };
    for (const r of this.ctx.storage.sql
      .exec("SELECT kind, item_id FROM owned_items WHERE user_id = ? ORDER BY bought_at", userId)
      .toArray()) {
      if (r.kind === "pet") out.pets.push(r.item_id);
      else if (r.kind === "hat") out.hats.push(r.item_id);
      else if (r.kind === "slot") out.slots += 1;
      else if (out[r.kind]) out[r.kind].push(r.item_id);
    }
    return out;
  }

  buildSlots(userId) {
    return (
      1 +
      this.ctx.storage.sql
        .exec("SELECT COUNT(*) AS n FROM owned_items WHERE user_id = ? AND kind = 'slot'", userId)
        .toArray()[0].n
    );
  }

  // Every build slot's loadout, in slot order; null for a bought slot that was never saved. The active slot is
  // always the profile itself (a fighter saved before builds has no row yet).
  builds(profile) {
    const out = Array.from({ length: this.buildSlots(profile.userId) }, () => null);
    const pets = new Set(this.owned(profile.userId).pets);
    for (const r of this.ctx.storage.sql
      .exec("SELECT slot, data FROM builds WHERE user_id = ?", profile.userId)
      .toArray()) {
      if (r.slot >= out.length) continue;
      const build = safeJsonParse(r.data, null);
      if (build?.pet && !pets.has(build.pet)) build.pet = ""; // an uploaded pet a mod deleted since this build was saved
      out[r.slot] = build;
    }
    if ((profile.build || 0) < out.length) out[profile.build || 0] = buildOf(profile);
    return out;
  }

  // Shop: a pet (price by tier, config) or a hat before its wins unlock it (hatPrice). Pays with the dollars the
  // stream has shown, like give(). Buying doesn't equip; the dashboard selects it and the viewer saves.
  buy(channel, userId, { kind, id, price: expected }) {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql,
        state = this.readState(channel),
        config = state.config,
        now = Date.now();
      const row = sql.exec("SELECT wins, dollars FROM profiles WHERE user_id = ?", userId).toArray()[0];
      if (!row) return { ok: false, reason: "no_fighter" };
      const h = hiddenResults(state, now).get(userId) || { wins: 0, dollars: 0 };
      let price = null;
      if (kind === "pet") price = petCatalog(sql, channel, config).find((p) => p.id === id)?.price ?? null;
      else if (kind === "hat") {
        const hat = HATS.find((x) => x.id && x.id === id);
        if (hat && hatUnlocked(hat.id, row.wins - h.wins)) return { ok: false, reason: "already_unlocked" };
        if (hat && hatPrice(hat, config) === null) return { ok: false, reason: "hats_not_for_sale" };
        price = hat ? hatPrice(hat, config) : null;
      } else if (kind === "slot") {
        const slots = this.buildSlots(userId);
        if (slots >= MAX_BUILDS) return { ok: false, reason: "max_slots" };
        price = slotPrice(slots, config);
        id = String(slots + 1); // the slot number it adds, so each bought slot is its own owned_items row
      } else if (COSMETIC_KINDS.includes(kind)) price = cosmeticItem(kind, id) ? cosmeticPrice(kind, config) : null;
      if (price === null) return { ok: false, reason: "unknown_item" };
      if (
        sql.exec("SELECT 1 FROM owned_items WHERE user_id = ? AND kind = ? AND item_id = ?", userId, kind, id).toArray()
          .length
      )
        return { ok: false, reason: "owned" };
      // The page sends the price it showed; a mod may have changed it since, and the viewer should see the new one first.
      if (expected !== undefined && expected !== price) return { ok: false, reason: "price_changed", price };
      const dollars = Math.max(0, row.dollars - h.dollars);
      if (price > dollars) return { ok: false, reason: "not_enough", price, dollars };
      sql.exec("UPDATE profiles SET dollars = dollars - ? WHERE user_id = ?", price, userId);
      sql.exec(
        "INSERT INTO owned_items (user_id, kind, item_id, price, bought_at) VALUES (?, ?, ?, ?, ?)",
        userId,
        kind,
        id,
        price,
        now,
      );
      logRoomEvent(this, "command", userId + " bought " + kind + " " + id + " for " + price, {
        channel,
        action: "buy",
        userId,
        kind,
        id,
        price,
      });
      return { ok: true, reason: "bought", kind, id, price, dollars: dollars - price, owned: this.owned(userId) };
    });
  }

  // !pet [@name]: a saved fighter's active pet as the catalog names it, or null when there's no such fighter.
  petInfo(channel, { userId = "", username = "" }) {
    const config = this.readState(channel).config;
    const profile = userId ? this.getProfile(userId, config) : this.getProfileByUsername(username, config);
    if (!profile) return null;
    const item = profile.pet
      ? petCatalog(this.ctx.storage.sql, channel, config).find((p) => p.id === profile.pet)
      : null;
    return {
      name: profile.displayName || profile.username,
      pet: item ? { label: item.label, tier: item.tier, boost: item.boost } : null,
    };
  }

  // Mod gift from the admin page: adds dollars to a saved fighter, or takes them back with a negative amount (never below 0).
  giftDollars(channel, payload, actorId, actorName) {
    const amount = Number(payload.amount);
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_GIFT)
      return { ok: false, reason: "invalid_amount" };
    const name = normalizeUsername(String(payload.username || "").replace(/^@/, ""));
    const sql = this.ctx.storage.sql;
    const row = name
      ? sql
          .exec("SELECT user_id, username, display_name, dollars FROM profiles WHERE username = ? COLLATE NOCASE", name)
          .toArray()[0]
      : null;
    if (!row) return { ok: false, reason: "profile_not_found" };
    const dollars = Math.max(0, Math.min(MAX_DOLLARS, row.dollars + amount));
    sql.exec("UPDATE profiles SET dollars = ? WHERE user_id = ?", dollars, row.user_id);
    logRoomEvent(this, "command", `${actorName || actorId} gift ${amount} -> ${row.username}`, {
      channel,
      action: "giftDollars",
      actorId,
      actorName,
      userId: row.user_id,
      user: row.username,
      amount,
      dollars,
    });
    return {
      ok: true,
      reason: "dollars_gifted",
      username: row.username,
      displayName: row.display_name,
      amount,
      dollars,
    };
  }

  // Dollars for finished duels: game.js finishDuel sets duel.payout, and this adds it to the saved profiles once
  // (duel.paid). Called inside the transaction that wrote the result; returns true when the state needs writing.
  payDuels(state) {
    let paid = false;
    for (const duel of state.duels) {
      if (!duel.payout || duel.paid) continue;
      for (const [id, amount] of Object.entries(duel.payout))
        this.ctx.storage.sql.exec(
          "UPDATE profiles SET dollars = MIN(?, dollars + ?) WHERE user_id = ?",
          MAX_DOLLARS,
          amount,
          id,
        );
      duel.paid = true;
      paid = true;
    }
    return paid;
  }

  // The bot's health row (bot_status), as the admin page reads it.
  botStatus() {
    const r = this.ctx.storage.sql.exec("SELECT * FROM bot_status WHERE id = 1").toArray()[0] || {};
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

  noteBotHeard(what) {
    this.ctx.storage.sql.exec(
      "UPDATE bot_status SET heard_at = ?, heard = ? WHERE id = 1",
      Date.now(),
      String(what).slice(0, 80),
    );
  }

  // A reply the room didn't send. Logged as a warning at most once a minute per reason (cooldowns aren't logged).
  noteBotHeld(channel, reason, context = {}, log = true) {
    const now = Date.now(),
      last = (this.heldLogged ||= {});
    this.ctx.storage.sql.exec("UPDATE bot_status SET held_at = ?, held_reason = ? WHERE id = 1", now, reason);
    if (!log || now - (last[reason] || 0) < 60_000) return;
    last[reason] = now;
    logRoomEvent(this, "warn", "bot reply held back: " + reason, { channel, via: "bot", reason, ...context });
  }

  // What Twitch said about the bot's lines ({sent, reason} each, from sendChatMessage). A dropped or failed line is
  // logged as a warning with Twitch's reason; sent lines only update the status.
  noteBotSent(channel, results, via = "reply") {
    const sql = this.ctx.storage.sql,
      now = Date.now();
    for (const r of [].concat(results || [])) {
      if (r?.sent === true) {
        sql.exec("UPDATE bot_status SET sent_at = ?, sent_total = sent_total + 1 WHERE id = 1", now);
        continue;
      }
      const reason = String(r?.reason || "unknown").slice(0, 200);
      sql.exec(
        "UPDATE bot_status SET failed_at = ?, failed_total = failed_total + 1, failed_reason = ? WHERE id = 1",
        now,
        reason,
      );
      logRoomEvent(this, "warn", "bot " + via + " dropped: " + botDropText(reason), { channel, via: "bot", reason });
    }
  }

  // "!fray debug": the health line, from the status before this command was heard.
  botStatusLine(state, s, now) {
    const ago = (at) => (at ? agoText(now - at) : "never");
    const every = Number(state.config.reminderMin) || 0,
      due = every
        ? this.ctx.storage.sql.exec("SELECT next_at FROM bot_reminder WHERE id = 1").toArray()[0]?.next_at
        : 0;
    return [
      "PixFray debug: chat " + (state.chat.connected ? "connected" : "not connected"),
      "last command " + (s.heard ? s.heard + " " + ago(s.heardAt) : "never"),
      `replies ${s.sent} sent, ${s.failed} dropped` +
        (s.failedAt ? ` (last drop ${ago(s.failedAt)}: ${botDropText(s.failedReason)})` : ""),
      `${s.recent}/${s.cap} replies in 30 s`,
      s.heldAt ? `last held back ${ago(s.heldAt)}: ${s.heldReason}` : "",
      "reminder " +
        (every ? `every ${every} min` + (due ? `, next in ${agoText(Math.max(0, due - now))}` : "") : "off"),
    ]
      .filter(Boolean)
      .join(" · ");
  }

  // The bot's text commands and counters, for the admin page.
  botCommands() {
    const sql = this.ctx.storage.sql;
    return {
      commands: sql
        .exec("SELECT name, reply FROM bot_commands ORDER BY name")
        .toArray()
        .map((r) => ({ name: r.name, reply: r.reply })),
      counters: sql
        .exec("SELECT name, value FROM bot_counters ORDER BY name")
        .toArray()
        .map((r) => ({ name: r.name, value: r.value })),
      max: MAX_BOT_COMMANDS,
    };
  }

  // Admin page: saveCommand {name, reply, oldName?}, deleteCommand {name}, setCounter {name, value}. A name can't be a
  // PixFray command's (the channel's names, their defaults and !pay). A counter first used in a reply starts at 0.
  editBotCommands(channel, action, payload, actorName) {
    const sql = this.ctx.storage.sql;
    if (action === "setCounter") {
      const name = counterName(payload.name),
        value = Number(payload.value);
      if (!name) return { ok: false, reason: "invalid_counter_name" };
      if (!Number.isInteger(value) || value < 0 || value > MAX_COUNTER)
        return { ok: false, reason: "invalid_counter_value" };
      sql.exec(
        "INSERT INTO bot_counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
        name,
        value,
      );
      logRoomEvent(this, "command", `${actorName} counter ${name} = ${value}`, { channel, action });
      return { ok: true, reason: "counter_saved" };
    }
    const name = commandName(payload.name);
    if (!name) return { ok: false, reason: "invalid_command_name" };
    if (action === "deleteCommand") {
      sql.exec("DELETE FROM bot_commands WHERE name = ?", name);
      logRoomEvent(this, "command", `${actorName} deleted ${name}`, { channel, action });
      return { ok: true, reason: "command_deleted" };
    }
    const reply = commandReplyText(payload.reply);
    if (!reply) return { ok: false, reason: "empty_command_reply" };
    if (reply.length > MAX_COMMAND_REPLY) return { ok: false, reason: "command_reply_too_long" };
    const taken = new Set(
      ["!pay", ...Object.values(botNames(this.seSettings().names)), ...Object.values(DEFAULT_SE_NAMES)].map((n) =>
        String(n).toLowerCase(),
      ),
    );
    if (taken.has(name)) return { ok: false, reason: "command_name_taken" };
    const oldName = commandName(payload.oldName);
    const exists = sql.exec("SELECT 1 FROM bot_commands WHERE name = ?", name).toArray().length > 0;
    if (exists && oldName !== name) return { ok: false, reason: "command_exists" };
    const total = sql.exec("SELECT COUNT(*) AS n FROM bot_commands").toArray()[0].n;
    if (!exists && !oldName && total >= MAX_BOT_COMMANDS) return { ok: false, reason: "too_many_commands" };
    if (oldName && oldName !== name) sql.exec("DELETE FROM bot_commands WHERE name = ?", oldName);
    sql.exec(
      "INSERT INTO bot_commands (name, reply, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET reply = excluded.reply, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
      name,
      reply,
      Date.now(),
      actorName,
    );
    for (const counter of replyCounters(reply))
      sql.exec("INSERT OR IGNORE INTO bot_counters (name, value) VALUES (?, 0)", counter);
    logRoomEvent(this, "command", `${actorName} saved ${name}`, { channel, action });
    const longest = replyWorstCase(reply);
    return {
      ok: true,
      reason: "command_saved",
      name,
      ...(longest > MAX_CHAT_LINE ? { warning: "reply_may_be_cut", longest, max: MAX_CHAT_LINE } : {}),
    };
  }

  // A text command's reply, or "" during its cooldown (COMMAND_COOLDOWN_MS for everyone, COMMAND_USER_COOLDOWN_MS per
  // chatter). Counters change only when the reply is sent.
  customReply(row, ev, words, now) {
    const user = String(ev.chatter_user_id || ""),
      cool = (this.commandCooldowns ||= new Map());
    if (now < (cool.get(row.name) || 0) || now < (cool.get(row.name + " " + user) || 0)) return "";
    if (cool.size > 500) for (const [key, until] of cool) if (until <= now) cool.delete(key);
    cool.set(row.name, now + COMMAND_COOLDOWN_MS);
    cool.set(row.name + " " + user, now + COMMAND_USER_COOLDOWN_MS);
    const sql = this.ctx.storage.sql;
    return fitChatLine(
      renderCommandReply(row.reply, {
        user: String(ev.chatter_user_name || ev.chatter_user_login || ""),
        toUser: words[1] || "",
        count: (name, add) =>
          add
            ? sql
                .exec(
                  "INSERT INTO bot_counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = MIN(value + 1, ?) RETURNING value",
                  name,
                  MAX_COUNTER,
                )
                .toArray()[0].value
            : (sql.exec("SELECT value FROM bot_counters WHERE name = ?", name).toArray()[0]?.value ?? 0),
      }),
    );
  }

  // Check-in test mode: {until, by} while on, else null. An expired row reads as off.
  checkinTest(now = Date.now()) {
    const row = this.ctx.storage.sql.exec("SELECT until, by_name FROM checkin_test WHERE id = 1").toArray()[0];
    return row && row.until > now ? { until: row.until, by: row.by_name } : null;
  }

  // The channel's live stream {id, startedAt} or null. Twitch's answer is kept for a minute; a failed lookup throws.
  async currentStream(channel, now) {
    if (this.env?.DEV_TOOLS_TOKEN) {
      const dev = this.ctx.storage.sql.exec("SELECT stream_id, started_at FROM dev_live WHERE id = 1").toArray()[0];
      if (dev) return dev.stream_id ? { id: dev.stream_id, startedAt: dev.started_at } : null;
    }
    if (this.liveCache && now - this.liveCache.at < LIVE_CACHE_MS) return this.liveCache.stream;
    const stream = await liveStream(this.env, channel);
    this.liveCache = { at: now, stream };
    return stream;
  }

  // A saved fighter's Twitch account age, asked once (again after ACCOUNT_RETRY_MS while Twitch doesn't answer).
  async checkAccountAge(userId) {
    const id = validUserId(userId),
      sql = this.ctx.storage.sql,
      now = Date.now();
    if (!id || !this.env?.TWITCH_CLIENT_ID) return;
    const row = sql
      .exec("SELECT account_created_at, account_checked_at FROM profiles WHERE user_id = ?", id)
      .toArray()[0];
    if (!row || row.account_created_at > 0 || now - row.account_checked_at < ACCOUNT_RETRY_MS) return;
    sql.exec("UPDATE profiles SET account_checked_at = ? WHERE user_id = ?", now, id);
    try {
      const at = await this.lookupAccount(id);
      if (at > 0) sql.exec("UPDATE profiles SET account_created_at = ? WHERE user_id = ?", at, id);
    } catch (error) {
      logRoomEvent(this, "warn", `account age lookup failed: ${String(error?.message || error).slice(0, 80)}`, {
        userId: id,
      });
    }
  }

  lookupAccount(userId) {
    return accountCreatedAt(this.env, userId);
  }

  // Of these user ids, the ones whose Twitch account is younger than NEW_ACCOUNT_MS. Unknown ages count as old.
  newAccounts(ids, now) {
    const list = [...new Set(ids.map(validUserId).filter(Boolean))];
    if (!list.length) return [];
    return this.ctx.storage.sql
      .exec(
        `SELECT user_id FROM profiles WHERE account_created_at > ? AND user_id IN (${list.map(() => "?").join(", ")})`,
        now - NEW_ACCOUNT_MS,
        ...list,
      )
      .toArray()
      .map((r) => r.user_id);
  }

  // After a finished duel the stored profiles must match the game state, or the next command undoes the result.
  checkSavedProfiles(state, duelId) {
    const duel = state.duels.find((d) => d.id === duelId);
    for (const id of duel ? [duel.a, duel.b] : []) {
      const p = state.players.find((x) => x.userId === id);
      if (!p?.registered) continue;
      const row = this.ctx.storage.sql
        .exec("SELECT elo, wins, losses FROM profiles WHERE user_id = ?", id)
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

  // One channel.chat.message: a presence update, plus a game command when the text parses as one.
  // No chat replies; rejected commands are logged to the room event list.
  processChatMessage(channel, msg, now) {
    const ev = msg.event && typeof msg.event === "object" ? msg.event : {};
    const userId = validUserId(ev.chatter_user_id);
    const username = normalizeUsername(ev.chatter_user_login);
    const displayName = String(ev.chatter_user_name || username)
      .trim()
      .slice(0, 48);
    const textValue = String(ev.message?.text || "").slice(0, 512);
    const color = /^#[0-9a-f]{6}$/i.test(ev.color || "") ? ev.color.toUpperCase() : "";
    const subscriptionId = String(msg.subscription?.id || "");
    return this.ctx.storage.transactionSync(() => {
      let state = this.readState(channel);
      const none = (reason) => ({ state, result: { ok: false, reason }, changed: false, visible: false });
      if (!subscriptionId || subscriptionId !== state.chat.subscriptionId) return none("unknown_subscription");
      const steps = [];
      const step = (event) => {
        const r = reduceGame(state, event, now);
        state = r.state;
        steps.push(r);
        return r;
      };
      // Twitch only notifies enabled subscriptions, so a notification also confirms a pending one.
      if (!state.chat.connected) step({ type: "chat_verified", subscriptionId });
      let main = null;
      if (!userId || !/^[a-z0-9_]{1,25}$/.test(username) || !displayName)
        main = { result: { ok: false, reason: "invalid_event" } };
      else if (CHAT_BOTS.has(username)) main = { result: { ok: false, reason: "chat_bot" } };
      else {
        const userProfile = this.getProfile(userId, state.config);
        // Registered players keep their saved look; other chatters take their Twitch name color.
        const profile = userProfile
          ? { ...userProfile, username, displayName }
          : { userId, username, displayName, ...(color ? { color } : {}) };
        const parsed = parseGameCommand(textValue);
        if (parsed) {
          const lastId =
            parsed.action === "rematch"
              ? state.players.find((p) => p.userId === userId)?.lastOpponentId || userProfile?.lastOpponentId
              : "";
          const targetProfile = parsed.target
            ? this.getProfileByUsername(parsed.target, state.config)
            : lastId
              ? this.getProfile(lastId, state.config)
              : null;
          const challengers = state.duels.filter((d) => d.status === "pending" && d.b === userId).map((d) => d.a);
          const newAccounts = this.newAccounts([userId, targetProfile?.userId, lastId, ...challengers], now);
          main = step({
            type: "command",
            messageId: String(ev.message_id || msg.messageId).slice(0, 64),
            userId,
            username,
            displayName,
            text: textValue,
            timestamp: Number(msg.timestamp),
            profile,
            targetProfile,
            newAccounts,
            quick: subscriptionId === SE_SUBSCRIPTION_ID || msg.quick === true,
            rolls: Array.from({ length: 48 }, () => Math.random()),
          });
          if (!main.result.ok && main.result.reason !== "duplicate")
            step({
              type: "command_rejected",
              userId,
              command: parsed.action,
              reason: main.result.reason,
              retryAt: main.result.retryAt,
            });
        } else {
          const active = state.players.find((item) => item.userId === userId);
          const fresh =
            active &&
            now - active.lastSeen < PRESENCE_REFRESH_MS &&
            active.displayName === displayName &&
            (userProfile || !color || active.color === color);
          if (!fresh) main = step({ type: "presence", userId, username, displayName, profile });
        }
        const updated = state.players.find((item) => item.userId === userId);
        if (
          updated?.registered &&
          userProfile &&
          (updated.username !== userProfile.username || updated.displayName !== userProfile.displayName)
        )
          this.upsertProfile(updated);
        if (main?.result?.reason === "duel_completed" || main?.result?.reason === "quick_duel") {
          // save Elo, wins and losses
          const duel = state.duels.find((item) => item.id === main.result.duelId);
          for (const id of duel ? [duel.a, duel.b] : []) {
            const participant = state.players.find((item) => item.userId === id);
            if (participant?.registered) this.upsertProfile(participant);
          }
        }
      }
      let changed = this.payDuels(state) || steps.some((r) => r.changed);
      if (changed || now - (Number(state.chat.lastSeen) || 0) >= LAST_SEEN_WRITE_MS) {
        state.chat.lastSeen = now;
        this.writeState(state);
        changed = true;
      }
      return {
        state,
        result: main?.result || { ok: true, reason: "presence_fresh" },
        changed,
        visible: steps.some((r) => r.visible),
      };
    });
  }

  async webSocketError(ws) {
    try {
      ws.close(1011, "Socket error");
    } catch {}
  }

  broadcast(state) {
    const message = JSON.stringify(this.publicState(state));
    for (const ws of this.ctx.getWebSockets("live")) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(message);
      } catch {}
    }
  }

  async scheduleAlarm(state) {
    const due = [];
    const chatDue = chatCheckDue(state);
    if (chatDue !== null) due.push(chatDue);
    for (const duel of state.duels) {
      if (duel.status === "pending") due.push(duel.expiresAt + 1);
      else if (duel.status === "active")
        due.push(duel.lastActionAt + (duel.rules?.inactivityMs || state.config.inactivityMs) + 1);
    }
    for (const profile of state.players) if (profile.respawnAt > 0) due.push(profile.respawnAt);
    for (const lock of state.rematchLocks) due.push(lock.until);
    // a bot channel announces each duel's result once the stream has played it
    if (this.botSource(state) && state.config.botEnabled !== false)
      for (const duel of state.duels)
        if (duel.status === "completed" && duel.revealAt > Date.now()) due.push(duel.revealAt + 1);
    if (this.dueResults(state, Date.now()).length) due.push(Date.now() + RESULT_RETRY_MS); // one that couldn't go out yet
    const reminder = this.reminderDue(state);
    if (reminder) due.push(reminder);
    if (due.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...due)));
    else await this.ctx.storage.deleteAlarm();
  }

  // Errors are logged (owner diagnostics) and the next alarm is always set, so one failure can't stall result lines.
  async alarm() {
    const row = this.readStoredState();
    if (!row) return;
    const channel = normalizeChannel(row.channel);
    if (!channel) return;
    try {
      await this.alarmTasks(channel);
    } catch (error) {
      logRoomError(this, error, { path: "alarm", method: "ALARM" });
    }
    await this.scheduleAlarm(this.readState(channel));
  }

  async alarmTasks(channel) {
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
        const event =
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
    await this.postExpired(channel, since);
    await this.postResults(channel, Date.now());
    await this.postReminder(channel, Date.now());
  }

  // "Challenge expired" lines for challenges that ran out after revision `since`, on a channel the bot reads. Each is said
  // once: the alarm and a later command can both notice the same one.
  expiredLines(state, since) {
    if (!this.botSource(state)) return [];
    this.expiredSaid ||= new Set();
    const names = botNames(this.seSettings().names),
      lines = [];
    const name = (id) => {
      const p = state.players.find((x) => x.userId === id) || this.getProfile(id, state.config);
      return p?.displayName || p?.username || "someone";
    };
    for (const e of state.events) {
      if (e.type !== "challenge_expired" || Number(e.id) <= since || this.expiredSaid.has(e.id)) continue;
      this.expiredSaid.add(e.id);
      lines.push(seExpiredText({ a: name(e.a), b: name(e.b), timeoutMs: state.config.challengeTimeoutMs, names }));
    }
    if (this.expiredSaid.size > 200) this.expiredSaid = new Set([...this.expiredSaid].slice(-100));
    return lines;
  }

  // Posts the expired-challenge lines from the alarm as the bot (there is no chat line to answer), under the reply cap.
  async postExpired(channel, since) {
    await this.postBotLines(channel, this.expiredLines(this.readState(channel), since));
  }

  // The result of each duel the stream has now played (revealAt passed in the last 2 minutes), once, from the alarm.
  // The "Fight on" reply says to watch the stream; this line follows the replay, so chat never spoils it.
  // A line held back by the reply cap or refused by Twitch stays due and is tried again (the alarm wakes every
  // RESULT_RETRY_MS) until it is 2 minutes old. A bot command also posts due results first, in case the alarm missed one.
  async postResults(channel, now) {
    if (this.postingResults) return this.postingResults; // the alarm and a command at once: post each line once
    this.postingResults = this.postResultsOnce(channel, now).finally(() => {
      this.postingResults = null;
    });
    return this.postingResults;
  }

  dueResults(state, now) {
    if (!this.botSource(state)) return [];
    const sql = this.ctx.storage.sql,
      row = sql.exec("SELECT results_through FROM bot_reminder WHERE id = 1").toArray()[0];
    if (!row) return [];
    // With the bot off, results are skipped for good, so turning it back on doesn't post a backlog.
    if (state.config.botEnabled === false) {
      if (row.results_through < now) sql.exec("UPDATE bot_reminder SET results_through = ? WHERE id = 1", now);
      return [];
    }
    return state.duels
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

  async postResultsOnce(channel, now) {
    const state = this.readState(channel),
      due = this.dueResults(state, now);
    if (!due.length) return;
    const sql = this.ctx.storage.sql,
      row = sql.exec("SELECT broadcaster_id, bot_id FROM bot_reminder WHERE id = 1").toArray()[0];
    if (!row?.broadcaster_id || !row?.bot_id) return;
    const name = (id) => {
      const p = state.players.find((x) => x.userId === id) || this.getProfile(id, state.config);
      return p?.displayName || p?.username || "someone";
    };
    for (const d of due) {
      // in reveal order; one that can't go out now stops the rest, so chat keeps the order
      const loser = d.winnerId === d.a ? d.b : d.a;
      const line = seResultText({
        winner: name(d.winnerId),
        loser: name(loser),
        w: d.ratings[d.winnerId],
        l: d.ratings[loser],
        decision: d.decision,
        flawless: d.flawless,
        unrated: d.unrated,
      });
      const { replies } = await this.sendBotLines([line], channel, { system: 1 }).json();
      if (!replies.length) return;
      // A failed call (network, Twitch 5xx or 429 after its retries) is tried again; a line Twitch read and dropped
      // (AutoMod, chat settings) would be dropped again, so it counts as done.
      let out,
        failed = false;
      try {
        out = await sendChatMessage(this.env, {
          broadcasterId: row.broadcaster_id,
          senderId: row.bot_id,
          message: replies[0],
        });
      } catch (error) {
        out = { sent: false, reason: String(error?.message || error) };
        failed = true;
      }
      this.noteBotSent(channel, [out]);
      if (failed) return;
      sql.exec("UPDATE bot_reminder SET results_through = MAX(results_through, ?) WHERE id = 1", d.revealAt);
    }
  }

  // Lines the bot posts on its own (no chat line to answer), under the reply cap.
  async postBotLines(channel, lines) {
    if (!lines.length || this.readState(channel).config.botEnabled === false) return;
    const row = this.ctx.storage.sql.exec("SELECT broadcaster_id, bot_id FROM bot_reminder WHERE id = 1").toArray()[0];
    if (!row?.broadcaster_id || !row?.bot_id) return;
    const { replies } = await this.sendBotLines(lines, channel, { system: lines.length }).json();
    for (const message of replies) {
      try {
        this.noteBotSent(channel, [
          await sendChatMessage(this.env, { broadcasterId: row.broadcaster_id, senderId: row.bot_id, message }),
        ]);
      } catch (error) {
        this.noteBotSent(channel, [{ sent: false, reason: String(error?.message || error) }]);
      }
    }
  }

  // Saves who the reminder posts as (the bot) and in which channel, from a bot command. Writes only when something changed.
  rememberReminder(broadcasterId, botId, origin) {
    broadcasterId = validUserId(broadcasterId);
    if (!broadcasterId || !botId) return;
    origin = String(origin || "").slice(0, 200);
    const sql = this.ctx.storage.sql,
      row = sql.exec("SELECT broadcaster_id, bot_id, origin FROM bot_reminder WHERE id = 1").toArray()[0];
    if (row && row.broadcaster_id === broadcasterId && row.bot_id === botId && row.origin === origin) return;
    sql.exec(
      "INSERT INTO bot_reminder (id, broadcaster_id, bot_id, origin) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET broadcaster_id = excluded.broadcaster_id, bot_id = excluded.bot_id, origin = excluded.origin",
      broadcasterId,
      botId,
      origin,
    );
  }

  // When the next !fray reminder is due, or 0: only with the bot connected, a known bot account, the bot on and config.reminderMin > 0.
  // The first one comes a full interval after the reminder is turned on (or the room first sees the bot).
  reminderDue(state, now = Date.now()) {
    const every = Number(state.config.reminderMin) || 0,
      sql = this.ctx.storage.sql;
    const row = sql.exec("SELECT next_at FROM bot_reminder WHERE id = 1").toArray()[0];
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
  async postReminder(channel, now) {
    const state = this.readState(channel),
      due = this.reminderDue(state, now);
    if (!due || now < due) return;
    const sql = this.ctx.storage.sql,
      row = sql.exec("SELECT broadcaster_id, bot_id, origin FROM bot_reminder WHERE id = 1").toArray()[0];
    sql.exec("UPDATE bot_reminder SET next_at = ? WHERE id = 1", now + state.config.reminderMin * 60000);
    try {
      if (!(await this.currentStream(channel, now))) return;
      const out = await sendChatMessage(this.env, {
        broadcasterId: row.broadcaster_id,
        senderId: row.bot_id,
        message: seReminderText({ names: botNames(this.seSettings().names), origin: row.origin, channel }),
      });
      if (out.sent) logRoomEvent(this, "command", "bot reminder sent", { channel, via: "reminder" });
      this.noteBotSent(channel, [out], "reminder");
    } catch (error) {
      this.noteBotSent(channel, [{ sent: false, reason: String(error?.message || error) }], "reminder");
    }
  }
}

// Next Helix check time, or null: hourly while connected, every few minutes while a subscription awaits verification.
function chatCheckDue(state) {
  const id = state.chat?.subscriptionId;
  if (!id || id.startsWith("local-") || id === SE_SUBSCRIPTION_ID) return null;
  return (Number(state.chat.checkedAt) || 0) + (state.chat.connected ? CHAT_CHECK_MS : CHAT_PENDING_CHECK_MS);
}

// "45 s", "12 min", "3 h", "2 d": how long ago (or until) for the bot's one-line status.
function agoText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90
    ? s + " s"
    : s < 5400
      ? Math.round(s / 60) + " min"
      : s < 172800
        ? Math.round(s / 3600) + " h"
        : Math.round(s / 86400) + " d";
}
