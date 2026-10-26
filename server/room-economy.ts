import { hasOpenDuel, hiddenResults, pairRankedLeft, parseGameCommand, shownProfile } from "./game.ts";
import { logRoomEvent } from "./developer.ts";
import { liveStream } from "./eventsub.ts";
import { effectiveStats, HATS, hatUnlocked, pointsFor, spentOn } from "./upgrades.ts";
import type { Stat } from "./upgrades.ts";
import { hatPrice, parseRoll, petCatalog, rollLegendary } from "./pets.ts";
import { buildOf, COSMETIC_KINDS, cosmeticItem, cosmeticPrice, MAX_BUILDS, slotPrice } from "./cosmetics.ts";
import type { CosmeticKind } from "./cosmetics.ts";
import type { CheckinReply, GiveReply } from "./streamelements.ts";
import type { Duel, GameState } from "./model.ts";
import {
  errorText,
  getProfile,
  getProfileByUsername,
  MAX_DOLLARS,
  normalizeUsername,
  safeJsonParse,
} from "./room-shared.ts";
import type { JsonObject, Profile, ProfileTable } from "./room-shared.ts";
import type { ChannelRoom } from "./channel.ts";

/** What a fighter bought (owned): ids per pet, hat and cosmetic kind, plus build slots. */
type Owned = { pets: string[]; hats: string[]; slots: number; rolls: { [pet: string]: Stat[] }; rerolled: string[] } & {
  [kind in CosmeticKind]: string[];
};
const LIVE_CACHE_MS = 60_000; // !checkin asks Twitch whether the channel is live at most once a minute
const FREE_MISS_MS = 7 * 24 * 60 * 60_000; // a streak survives one missed stream per week
// Extra points when the streak reaches one of these streams (config.streakBonus).
const STREAK_MILESTONES = new Map([
  [3, 1],
  [7, 1],
  [14, 1],
  [30, 1],
  [60, 2],
  [100, 3],
  [200, 5],
  [365, 10],
]);
const MAX_BONUS = 1_000_000; // stored check-in points; a sanity bound, far past any real streak
const MAX_GIFT = 10_000; // the most a mod can add or take back in one gift

// !checkin: once per stream, only while Twitch says the channel is live. Gives config.checkinPoints, plus the
// STREAK_MILESTONES extra when the streak reaches a milestone. A streak counts this channel's streams with
// check-ins (the streams table) in a row; one missed stream a week is forgiven. Points are stored apart from wins (bonus_points), so a rank reset keeps them.
export async function checkin(
  room: ChannelRoom,
  channel: string,
  { userId }: { userId: string },
  now = Date.now(),
): Promise<CheckinReply> {
  if (!userId || !getProfile(room, userId, room.readState(channel).config)) return { reason: "no_fighter" };
  const stream = await liveOrError(room, channel, now);
  if (stream === "error") return { reason: "twitch_error" };
  // Test mode while offline: the check-in a next stream would give, worked out the same way but never saved.
  const test = !stream && Boolean(checkinTest(room, now));
  if (!stream && !test) return { reason: "not_live" };
  return room.ctx.storage.transactionSync((): CheckinReply => {
    const sql = room.ctx.storage.sql,
      state = room.readState(channel),
      config = state.config;
    const row = sql
      .exec<
        Pick<
          ProfileTable,
          | "wins"
          | "losses"
          | "bonus_points"
          | "streak"
          | "last_stream"
          | "last_stream_seq"
          | "free_miss_at"
          | "power"
          | "guard"
          | "luck"
          | "crit"
          | "dodge"
          | "counter"
          | "vitality"
        >
      >(
        "SELECT wins, losses, bonus_points, streak, last_stream, last_stream_seq, free_miss_at, power, guard, luck, crit, dodge, counter, vitality FROM profiles WHERE user_id = ?",
        userId,
      )
      .toArray()[0];
    if (!row) return { reason: "no_fighter" };
    // stream! : without a stream, test is true (checked above)
    if (!test && row.last_stream === stream!.id) return { reason: "already_checked_in", streak: row.streak };
    if (!test)
      sql.exec(
        "INSERT OR IGNORE INTO streams (stream_id, started_at) VALUES (?, ?)",
        stream!.id, // not a test, so there is a stream
        stream!.startedAt || now, // as above
      );
    const seq = test
      ? (sql.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM streams").toArray()[0]?.seq || 0) + 1
      : // not a test, so there is a stream, and its row was inserted just above
        sql.exec<{ seq: number }>("SELECT seq FROM streams WHERE stream_id = ?", stream!.id).toArray()[0]!.seq;
    const missed = row.last_stream_seq > 0 ? seq - row.last_stream_seq - 1 : -1;
    const freeMiss = missed === 1 && now - row.free_miss_at >= FREE_MISS_MS;
    const streak = missed === 0 || freeMiss ? row.streak + 1 : 1;
    const extra = config.streakBonus ? STREAK_MILESTONES.get(streak) || 0 : 0;
    const milestone = extra > 0;
    const points = config.checkinPoints + extra;
    const bonus = Math.min(MAX_BONUS, row.bonus_points + points);
    // The total counts only wins the stream has shown, like !wallet: a quick duel still playing doesn't give it away.
    const hidden = hiddenResults(state, now).get(userId);
    const earned = { wins: row.wins - (hidden?.wins || 0), bonus, losses: row.losses - (hidden?.losses || 0) };
    const total = pointsFor(earned),
      unspent = Math.max(0, total - spentOn(effectiveStats(row, earned)));
    if (test) return { reason: "checked_in", test: true, streak, points, milestone, freeMiss, total, unspent };
    sql.exec(
      "UPDATE profiles SET bonus_points = ?, checkins = checkins + 1, streak = ?, last_stream = ?, last_stream_seq = ?, free_miss_at = ? WHERE user_id = ?",
      bonus,
      streak,
      stream!.id, // not a test, so there is a stream
      seq,
      freeMiss ? now : row.free_miss_at,
      userId,
    );
    const active = state.players.find((p) => p.userId === userId);
    if (active) {
      active.bonus = bonus;
      room.writeState(state);
    } // the next duel counts the new points
    return { reason: "checked_in", streak, points, milestone, freeMiss, total, unspent };
  });
}

// !wallet: dollars, upgrade points and streak as the stream has shown them (a quick duel's payout stays hidden too).
export function wallet(room: ChannelRoom, channel: string, userId: string) {
  const state = room.readState(channel);
  // shownProfile passes null (no fighter) through
  const profile =
    userId && shownProfile(getProfile(room, userId, state.config) as Profile, hiddenResults(state, Date.now()));
  return profile
    ? { dollars: profile.dollars, style: profile.styleDollars, points: pointsFor(profile), streak: profile.streak }
    : null;
}

// !give @name amount: dollars from one saved fighter to another, only while the channel is live. Limits (config):
// giveEnabled, giveMinDuels finished duels first, and at most giveMaxPerStream given per stream.
export async function give(
  room: ChannelRoom,
  channel: string,
  { userId, target, amount }: { userId: string; target: string; amount: number | null },
  now = Date.now(),
): Promise<GiveReply> {
  const config = room.readState(channel).config;
  if (!config.giveEnabled) return { reason: "give_off" };
  const giver = userId && getProfile(room, userId, config);
  if (!giver) return { reason: "no_fighter" };
  if (!target || !Number.isInteger(amount) || amount < 1) return { reason: "give_usage" };
  const to = getProfileByUsername(room, target, config);
  if (!to) return { reason: "target_not_found" };
  if (to.userId === giver.userId) return { reason: "self_give" };
  const stream = await liveOrError(room, channel, now);
  if (stream === "error") return { reason: "twitch_error" };
  if (!stream) return { reason: "not_live" };
  return room.ctx.storage.transactionSync((): GiveReply => {
    const sql = room.ctx.storage.sql,
      state = room.readState(channel),
      cfg = state.config;
    const row = sql
      .exec<Pick<ProfileTable, "wins" | "losses" | "dollars" | "give_stream" | "given_in_stream">>(
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
    const space =
      MAX_DOLLARS -
      (sql.exec<{ dollars: number }>("SELECT dollars FROM profiles WHERE user_id = ?", to.userId).toArray()[0]
        ?.dollars || 0);
    if (amount > space) return { reason: "target_full", to: to.displayName || to.username, room: Math.max(0, space) };
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
export function owned(room: ChannelRoom, userId: string): Owned {
  const out: Owned = {
    pets: [],
    hats: [],
    // one empty list per cosmetic kind
    ...(Object.fromEntries(COSMETIC_KINDS.map((k): [CosmeticKind, string[]] => [k, []])) as {
      [kind in CosmeticKind]: string[];
    }),
    slots: 1,
    rolls: {},
    rerolled: [],
  };
  for (const r of room.ctx.storage.sql
    .exec<{ kind: string; item_id: string; roll: string; rerolled: number }>(
      "SELECT kind, item_id, roll, rerolled FROM owned_items WHERE user_id = ? ORDER BY bought_at",
      userId,
    )
    .toArray()) {
    if (r.kind === "pet") {
      out.pets.push(r.item_id);
      if (r.roll) out.rolls[r.item_id] = parseRoll(r.roll);
      if (r.rerolled) out.rerolled.push(r.item_id);
    } else if (r.kind === "hat") out.hats.push(r.item_id);
    else if (r.kind === "slot") out.slots += 1;
    // a cosmetic kind; any other reads undefined and is skipped
    else if (out[r.kind as CosmeticKind]) out[r.kind as CosmeticKind].push(r.item_id);
  }
  return out;
}

export function buildSlots(room: ChannelRoom, userId: string): number {
  return (
    1 +
    room.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM owned_items WHERE user_id = ? AND kind = 'slot'", userId)
      .toArray()[0]!.n // COUNT(*) always returns one row
  );
}

// Every build slot's loadout, in slot order; null for a bought slot that was never saved. The active slot is
// always the profile itself (a fighter saved before builds has no row yet).
export function builds(
  room: ChannelRoom,
  profile: { readonly [field: string]: unknown; userId: string; build?: number | undefined },
) {
  const out = Array.from({ length: buildSlots(room, profile.userId) }, (): JsonObject | null => null);
  const pets = new Set(owned(room, profile.userId).pets);
  for (const r of room.ctx.storage.sql
    .exec<{ slot: number; data: string }>("SELECT slot, data FROM builds WHERE user_id = ?", profile.userId)
    .toArray()) {
    if (r.slot >= out.length) continue;
    const build = safeJsonParse<{ pet?: unknown; [field: string]: unknown }, null>(r.data, null);
    // a pet id that isn't a string is never owned
    if (build?.pet && !pets.has(build.pet as string)) build.pet = ""; // an uploaded pet a mod deleted since this build was saved
    out[r.slot] = build;
  }
  if ((profile.build || 0) < out.length) out[profile.build || 0] = buildOf(profile);
  return out;
}

// Shop: a pet (price by tier, config) or a hat before its wins unlock it (hatPrice). Pays with the dollars the
// stream has shown, like give(). A pet takes duel dollars only; anything else spends style dollars (channel point
// rewards) first, then dollars. Buying doesn't equip; the dashboard selects it and the viewer saves.
export function buy(
  room: ChannelRoom,
  channel: string,
  userId: string,
  { kind, id, price: expected }: { kind?: unknown; id?: unknown; price?: unknown },
) {
  return room.ctx.storage.transactionSync(() => {
    const sql = room.ctx.storage.sql,
      state = room.readState(channel),
      config = state.config,
      now = Date.now();
    const row = sql
      .exec<Pick<ProfileTable, "wins" | "dollars" | "style_dollars">>(
        "SELECT wins, dollars, style_dollars FROM profiles WHERE user_id = ?",
        userId,
      )
      .toArray()[0];
    if (!row) return { ok: false, reason: "no_fighter" };
    const h = hiddenResults(state, now).get(userId) || { wins: 0, dollars: 0 };
    let price: number | null = null;
    const pet = kind === "pet" ? petCatalog(sql, channel, config).find((p) => p.id === id) : undefined;
    if (kind === "pet") price = pet?.price ?? null;
    else if (kind === "hat") {
      const hat = HATS.find((x) => x.id && x.id === id);
      if (hat && hatUnlocked(hat.id, row.wins - h.wins)) return { ok: false, reason: "already_unlocked" };
      if (hat && hatPrice(hat, config) === null) return { ok: false, reason: "hats_not_for_sale" };
      price = hat ? hatPrice(hat, config) : null;
    } else if (kind === "slot") {
      const slots = buildSlots(room, userId);
      if (slots >= MAX_BUILDS) return { ok: false, reason: "max_slots" };
      price = slotPrice(slots, config);
      id = String(slots + 1); // the slot number it adds, so each bought slot is its own owned_items row
      // includes() is true only for a cosmetic kind; cosmeticItem finds no item for an id that isn't a string
    } else if (COSMETIC_KINDS.includes(kind as CosmeticKind))
      price = cosmeticItem(kind as CosmeticKind, id as string) ? cosmeticPrice(kind as CosmeticKind, config) : null;
    if (price === null) return { ok: false, reason: "unknown_item" };
    if (
      sql.exec("SELECT 1 FROM owned_items WHERE user_id = ? AND kind = ? AND item_id = ?", userId, kind, id).toArray()
        .length
    )
      return { ok: false, reason: "owned" };
    // The page sends the price it showed; a mod may have changed it since, and the viewer should see the new one first.
    if (expected !== undefined && expected !== price) return { ok: false, reason: "price_changed", price };
    const dollars = Math.max(0, row.dollars - h.dollars),
      fromStyle = kind === "pet" ? 0 : Math.min(row.style_dollars, price),
      fromDollars = price - fromStyle;
    if (fromDollars > dollars)
      return { ok: false, reason: "not_enough", price, dollars, styleDollars: row.style_dollars };
    sql.exec(
      "UPDATE profiles SET dollars = dollars - ?, style_dollars = style_dollars - ? WHERE user_id = ?",
      fromDollars,
      fromStyle,
      userId,
    );
    sql.exec(
      "INSERT INTO owned_items (user_id, kind, item_id, price, bought_at, roll) VALUES (?, ?, ?, ?, ?, ?)",
      userId,
      kind,
      id,
      price,
      now,
      pet?.tier === "legendary" ? rollLegendary().join(",") : "",
    );
    logRoomEvent(room, "command", userId + " bought " + kind + " " + id + " for " + price, {
      channel,
      action: "buy",
      userId,
      kind,
      id,
      price,
      fromStyle,
    });
    return {
      ok: true,
      reason: "bought",
      kind,
      id,
      price,
      dollars: dollars - fromDollars,
      styleDollars: row.style_dollars - fromStyle,
      owned: owned(room, userId),
    };
  });
}

// A legendary pet's one free reroll (shop kind "reroll"): new rolled stats, never the same set. Refused while that pet
// is in an open duel, like a build change. state is the stage to broadcast when the pet is out.
export function reroll(room: ChannelRoom, channel: string, userId: string, id: string) {
  return room.ctx.storage.transactionSync(() => {
    const sql = room.ctx.storage.sql,
      state = room.readState(channel);
    const fighter = sql
      .exec<Pick<ProfileTable, "dollars" | "style_dollars">>(
        "SELECT dollars, style_dollars FROM profiles WHERE user_id = ?",
        userId,
      )
      .toArray()[0];
    if (!fighter) return { ok: false, reason: "no_fighter" };
    const pet = petCatalog(sql, channel, state.config).find((p) => p.id === id);
    const row =
      pet?.tier === "legendary"
        ? sql
            .exec<{ roll: string; rerolled: number }>(
              "SELECT roll, rerolled FROM owned_items WHERE user_id = ? AND kind = 'pet' AND item_id = ?",
              userId,
              id,
            )
            .toArray()[0]
        : undefined;
    if (!row) return { ok: false, reason: "unknown_item" };
    if (row.rerolled) return { ok: false, reason: "rerolled" };
    const out = state.players.some((p) => p.userId === userId && p.pet === id);
    if (out && hasOpenDuel(state, userId)) return { ok: false, reason: "in_duel" };
    const roll = rollLegendary(Math.random, parseRoll(row.roll));
    sql.exec(
      "UPDATE owned_items SET roll = ?, rerolled = 1 WHERE user_id = ? AND kind = 'pet' AND item_id = ?",
      roll.join(","),
      userId,
      id,
    );
    logRoomEvent(room, "command", userId + " rerolled pet " + id + " to " + roll.join(","), {
      channel,
      action: "reroll",
      userId,
      id,
    });
    const changed = out && syncPetBoosts(room, state, [userId]);
    if (changed) {
      state.revision += 1;
      room.writeState(state);
    }
    const dollars = Math.max(0, fighter.dollars - (hiddenResults(state, Date.now()).get(userId)?.dollars || 0));
    return {
      ok: true,
      reason: "rerolled",
      kind: "reroll",
      id,
      dollars,
      styleDollars: fighter.style_dollars,
      owned: owned(room, userId),
      state: changed ? state : null,
    };
  });
}

// Fighters on stage whose active pet's stored roll differs from their boost take the stored one; true when any did.
export function syncPetBoosts(room: ChannelRoom, state: GameState, userIds: readonly string[]): boolean {
  let changed = false;
  for (const p of state.players) {
    if (!p.pet || !userIds.includes(p.userId)) continue;
    const saved = getProfile(room, p.userId, state.config);
    if (saved?.pet !== p.pet || JSON.stringify(saved.petBoost) === JSON.stringify(p.petBoost)) continue;
    p.petBoost = saved.petBoost;
    changed = true;
  }
  return changed;
}

// !pet [@name]: a saved fighter's active pet as the catalog names it, or null when there's no such fighter.
// !stats [@name]: the upgrade levels that count in duels, unspent points and the pet's boost, as the stream has shown
// them (a quick duel still playing doesn't give its win away, like !wallet).
export function statsInfo(
  room: ChannelRoom,
  channel: string,
  { userId = "", username = "", asker = "" }: { userId?: string; username?: string; asker?: string },
) {
  const state = room.readState(channel);
  const found = userId ? getProfile(room, userId, state.config) : getProfileByUsername(room, username, state.config);
  if (!found) return null;
  const profile = shownProfile(found, hiddenResults(state, Date.now()));
  const own = effectiveStats(profile.stats, profile);
  return {
    name: profile.displayName || profile.username,
    stats: effectiveStats(own, profile, null, state.config.maxStatLevel),
    unspent: Math.max(0, pointsFor(profile) - spentOn(own)),
    petBoost: profile.petBoost,
    rankedLeft: asker && asker !== profile.userId ? pairRankedLeft(state, asker, profile.userId) : null,
  };
}

export function petInfo(
  room: ChannelRoom,
  channel: string,
  { userId = "", username = "" }: { userId?: string; username?: string },
) {
  const config = room.readState(channel).config;
  const profile = userId ? getProfile(room, userId, config) : getProfileByUsername(room, username, config);
  if (!profile) return null;
  const item = profile.pet ? petCatalog(room.ctx.storage.sql, channel, config).find((p) => p.id === profile.pet) : null;
  return {
    name: profile.displayName || profile.username,
    pet: item ? { label: item.label, tier: item.tier, boost: profile.petBoost } : null, // a legendary's own roll
  };
}

// Mod gift from the admin page: adds dollars to a saved fighter, or takes them back with a negative amount (never below 0).
export function giftDollars(
  room: ChannelRoom,
  channel: string,
  payload: JsonObject,
  actorId: string,
  actorName: string,
) {
  const amount = Number(payload.amount);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_GIFT)
    return { ok: false, reason: "invalid_amount" };
  const name = normalizeUsername(String(payload.username || "").replace(/^@/, ""));
  const sql = room.ctx.storage.sql;
  const row = name
    ? sql
        .exec<{ user_id: string; username: string; display_name: string; dollars: number }>(
          "SELECT user_id, username, display_name, dollars FROM profiles WHERE username = ? COLLATE NOCASE",
          name,
        )
        .toArray()[0]
    : null;
  if (!row) return { ok: false, reason: "profile_not_found" };
  const dollars = Math.max(0, Math.min(MAX_DOLLARS, row.dollars + amount));
  sql.exec("UPDATE profiles SET dollars = ? WHERE user_id = ?", dollars, row.user_id);
  logRoomEvent(room, "command", `${actorName || actorId} gift ${amount} -> ${row.username}`, {
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

// Mods start one pair's ranked count for this stream over (game.ts resetPair), by Twitch login, from the mod page or
// !resetpair @a @b in chat.
export function resetPair(
  room: ChannelRoom,
  channel: string,
  a: unknown,
  b: unknown,
  actorId: string,
  actorName: string,
) {
  const config = room.readState(channel).config,
    find = (name: unknown) =>
      getProfileByUsername(room, normalizeUsername(String(name || "").replace(/^@/, "")), config);
  const one = find(a),
    two = find(b);
  if (!one || !two) return { ok: false, reason: "profile_not_found", missing: one ? String(b || "") : String(a || "") };
  const out = room.advance(
    channel,
    { type: "admin", actorId, actorName, action: "resetPair", payload: { a: one.userId, b: two.userId } },
    Date.now(),
  );
  if (!out.result.ok) return { ok: false, reason: out.result.reason || "invalid_pair" };
  logRoomEvent(room, "command", `${actorName || actorId} reset pair ${one.username} ${two.username}`, {
    channel,
    action: "resetPair",
    actorId,
    actorName,
    a: one.username,
    b: two.username,
    amount: out.result.amount,
  });
  return {
    ok: true,
    reason: "pair_reset",
    a: one.displayName || one.username,
    b: two.displayName || two.username,
    left: pairRankedLeft(out.state, one.userId, two.userId),
  };
}

// Dollars for finished duels: game.ts finishDuel sets duel.payout, and this adds it to the saved profiles once
// (duel.paid). Called inside the transaction that wrote the result; returns true when the state needs writing.
export function payDuels(room: ChannelRoom, state: GameState): boolean {
  let paid = false;
  // paid is the room's own mark, kept on the duel but not part of the game's Duel type
  for (const duel of state.duels as (Duel & { paid?: boolean })[]) {
    if (!duel.payout || duel.paid) continue;
    for (const [id, amount] of Object.entries(duel.payout))
      room.ctx.storage.sql.exec(
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

// Check-in test mode: {until, by} while on, else null. An expired row reads as off.
export function checkinTest(room: ChannelRoom, now = Date.now()) {
  const row = room.ctx.storage.sql
    .exec<{ until: number; by_name: string }>("SELECT until, by_name FROM checkin_test WHERE id = 1")
    .toArray()[0];
  return row && row.until > now ? { until: row.until, by: row.by_name } : null;
}

// The channel's live stream {id, startedAt} or null. Twitch's answer is kept for a minute; a failed lookup throws.
export async function currentStream(
  room: ChannelRoom,
  channel: string,
  now: number,
): Promise<{ id: string; startedAt: number } | null> {
  if (room.env?.DEV_TOOLS_TOKEN) {
    const dev = room.ctx.storage.sql
      .exec<{ stream_id: string; started_at: number }>("SELECT stream_id, started_at FROM dev_live WHERE id = 1")
      .toArray()[0];
    if (dev) return dev.stream_id ? { id: dev.stream_id, startedAt: dev.started_at } : null;
  }
  if (room.liveCache && now - room.liveCache.at < LIVE_CACHE_MS) return room.liveCache.stream;
  const stream = await liveStream(room.env, channel);
  room.liveCache = { at: now, stream };
  return stream;
}

// currentStream for a command that needs the channel live; a failed lookup is logged and answers "error".
async function liveOrError(room: ChannelRoom, channel: string, now: number) {
  try {
    return await currentStream(room, channel, now);
  } catch (error) {
    logRoomEvent(room, "warn", "twitch stream lookup failed", { channel, error: errorText(error, 200) });
    return "error";
  }
}

// The live check for a chat line that can start a duel (game.ts noteStream): {id, startedAt}, null offline, or
// undefined (another command, no Twitch app, or Twitch didn't answer) so the room keeps its last answer.
export async function streamNews(
  room: ChannelRoom,
  channel: string,
  text: unknown,
  now: number,
): Promise<{ id: string; startedAt: number } | null | undefined> {
  const action = parseGameCommand(text)?.action;
  if (action !== "duel" && action !== "accept" && action !== "rematch") return undefined;
  const dev =
    Boolean(room.env?.DEV_TOOLS_TOKEN) &&
    room.ctx.storage.sql.exec("SELECT 1 FROM dev_live WHERE id = 1").toArray().length > 0;
  if (!dev && !room.env?.TWITCH_CLIENT_ID) return undefined;
  try {
    return await currentStream(room, channel, now);
  } catch (error) {
    logRoomEvent(room, "warn", `live check failed: ${errorText(error, 80)}`, { channel });
    return undefined;
  }
}
