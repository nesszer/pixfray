import { COSMETIC_KINDS, COSMETIC_FIELDS, MAX_BUILDS } from "./cosmetics.ts";
import type { AbilityName, ChatEvent, SendResult } from "./model.ts";
import type { HelixUser } from "./auth.ts";
import type { ChannelRecord, ChannelRow } from "./channels.ts";
import type { BackupExport } from "./backups.ts";

// Inbound request bodies, checked once at the edge (the Worker route or the room route that reads them), so the code
// behind takes typed values. Each parser answers { ok: true, value } or { ok: false, error } like validateConfigPatch
// in server/game.ts, and checks only the fields its route reads: other fields pass through untouched, and values that
// already get a named refusal further in (an unknown item, a locked hat) still reach that check. The error is the code
// the route answers with (docs/CONTRACTS.md §2 and §4).
//
// The same style covers what comes from outside the request: Twitch, GitHub and Cloudflare answers, the channel
// registry, and stored data (CHANNEL_ORIGINS, upload meta, daily backups). Those parsers are at the end of this file.

/** A JSON object request body, as bodyJson (Worker) and readJson (room) parse it. */
export type JsonObject = { [field: string]: unknown };
/** A parser's answer. Each side names the other's field as optional, so the loose worker program narrows it too. */
export type Parsed<T> = { ok: true; value: T; error?: undefined } | { ok: false; error: string; value?: undefined };

export const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
const bad = (error: string): { ok: false; error: string; value?: undefined } => ({ ok: false, error });
const optString = (v: unknown): v is string | undefined => v === undefined || typeof v === "string";
const optBoolean = (v: unknown): v is boolean | undefined => v === undefined || typeof v === "boolean";
const optObject = (v: unknown): v is JsonObject | undefined => v === undefined || isObject(v);
// null counts as absent for these two
const optBooleanOrNull = (v: unknown): v is boolean | null | undefined => v == null || typeof v === "boolean";
const optObjectOrNull = (v: unknown): v is JsonObject | null | undefined => v == null || isObject(v);
const isPrice = (v: unknown): v is number | undefined =>
  v === undefined || (Number.isInteger(v) && v >= 0 && v <= 1000000);
const ABILITIES: readonly AbilityName[] = ["strike", "heavy", "heal"];
const isAbility = (v: unknown): v is AbilityName => ABILITIES.some((a) => a === v);

/** The code every request-body refusal without a more specific one answers with. */
export const INVALID_BODY = "invalid_body";

// ---------- POST /api/admin/<channel> (Worker) and the room's /admin ----------

/** An admin request: the action, the payload the action reads, and the fields the Worker reads for its own actions. */
export type AdminBody = {
  action: string;
  /** body.payload when it is an object, else the body itself (older pages send the fields at the top level). */
  payload: JsonObject;
  takeover: boolean;
  /** setDuelModuleOff and checkinTest: the switch. */
  value: boolean;
  /** setSeNames: the command names (the room checks each one). */
  names: JsonObject;
  /** Every field as sent: the Worker forwards them to the room. */
  fields: JsonObject;
};
// action: a non-empty string; payload: an object when sent; takeover: a boolean when sent; value: a boolean for the
// two switch actions; names: an object for setSeNames; payload.note: a string when sent. Any other field is the
// action's own (the room checks it: invalid_amount, invalid_command_name, invalid_config ...).
export function parseAdminBody(body: JsonObject): Parsed<AdminBody> {
  const { action, payload: rawPayload, takeover, value, names } = body;
  if (typeof action !== "string" || !action) return bad(INVALID_BODY);
  if (!optObject(rawPayload) || !optBoolean(takeover)) return bad(INVALID_BODY);
  const switched = action === "setDuelModuleOff" || action === "checkinTest";
  if (switched && typeof value !== "boolean") return bad(INVALID_BODY);
  if (action === "setSeNames" && !isObject(names)) return bad(INVALID_BODY);
  const payload = rawPayload || body;
  if (!optString(payload.note)) return bad(INVALID_BODY);
  return ok({
    action,
    payload,
    takeover: takeover === true,
    value: value === true,
    names: isObject(names) ? names : {},
    fields: body,
  });
}
/** The room's /admin: the Worker's checks plus the actor name it adds. */
export function parseRoomAdminBody(body: JsonObject): Parsed<AdminBody & { actorName: string }> {
  const parsed = parseAdminBody(body);
  if (!parsed.ok) return bad(parsed.error);
  const { actorName } = body;
  if (!optString(actorName)) return bad(INVALID_BODY);
  return ok({ ...parsed.value, actorName: actorName || "" });
}

// ---------- Profile saves ----------

/** What the room's /profile reads: the base look as strings, the rest left to saveProfile's own checks. */
export type ProfileInput = JsonObject & {
  username: string;
  color: string;
  defaultAbility: string;
  displayName?: string | undefined;
  avatar?: string | undefined;
  hat?: string | undefined;
  pet?: string | undefined;
};
// The room's /profile (the Worker, the dev tools and a worn sprite call it): username, color and defaultAbility are
// strings, displayName, avatar, hat and pet strings when sent. stats, the cosmetics and build keep their own codes
// (invalid_upgrades, invalid_profile, invalid_build). Refused as invalid_profile, the code saveProfile already uses.
export function parseProfileInput(body: JsonObject): Parsed<ProfileInput> {
  const { username, color, defaultAbility, displayName, avatar, hat, pet } = body;
  if (typeof username !== "string" || typeof color !== "string" || typeof defaultAbility !== "string")
    return bad("invalid_profile");
  if (!optString(displayName) || !optString(avatar) || !optString(hat) || !optString(pet))
    return bad("invalid_profile");
  return ok({ ...body, username, color, defaultAbility, displayName, avatar, hat, pet });
}

/** A viewer's profile save as the Worker forwards it to the room. */
export type ProfileSave = {
  avatar: string;
  color: string;
  defaultAbility: AbilityName;
  /** The room checks the points against the saved wins (server/upgrades.ts). */
  stats: JsonObject | undefined;
  hat: string | undefined;
  pet: string | undefined;
  /** The cosmetics and build slot sent: each cosmetic a string up to 32, build a slot index. */
  loadout: JsonObject;
};
// POST /api/profile/<channel>: avatar a character id, color #rrggbb, defaultAbility one of the three; stats an object,
// hat a string and pet a string up to 64 when sent; the cosmetics strings up to 32 and build an integer slot when sent.
export function parseProfileSave(body: JsonObject): Parsed<ProfileSave> {
  const { avatar, color, defaultAbility, stats, hat, pet } = body;
  if (typeof avatar !== "string" || !/^[a-z0-9_-]{1,64}$/.test(avatar)) return bad("invalid_fields");
  if (typeof color !== "string" || !/^#[a-f0-9]{6}$/i.test(color) || !isAbility(defaultAbility))
    return bad("invalid_fields");
  const loadout: JsonObject = {};
  for (const kind of COSMETIC_KINDS) {
    const field = COSMETIC_FIELDS[kind],
      v = body[field];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length > 32) return bad("invalid_fields");
    loadout[field] = v;
  }
  const { build } = body;
  if (build !== undefined) {
    if (!Number.isInteger(build) || build < 0 || build >= MAX_BUILDS) return bad("invalid_fields");
    loadout.build = build;
  }
  if (!optObject(stats) || !optString(hat) || !optString(pet) || (pet !== undefined && pet.length > 64))
    return bad("invalid_fields");
  return ok({ avatar, color, defaultAbility, stats, hat, pet, loadout });
}

// ---------- Shop ----------

/** Shop kinds: pets, hats, build slots and the cosmetics of server/cosmetics.ts (the room checks the ids and prices). */
export const SHOP_KINDS: readonly string[] = ["pet", "hat", "slot", ...COSMETIC_KINDS];
/** A purchase as the Worker forwards it. */
export type ShopBuy = { kind: string; id: string; price: number | undefined };
// POST /api/shop/<channel>: a known kind, an id up to 64 ("" for a slot), and optionally the price the buyer saw
// (an integer 0..1000000; the room answers 409 price_changed when it differs).
export function parseShopBuy(body: JsonObject): Parsed<ShopBuy> {
  const { kind, id = "", price } = body;
  if (typeof kind !== "string" || !SHOP_KINDS.includes(kind)) return bad("invalid_item");
  if (typeof id !== "string" || id.length > 64) return bad("invalid_item");
  if (!isPrice(price)) return bad("invalid_item");
  return ok({ kind, id, price });
}

// ---------- Dev-token tools (POST /api/devtools/<channel>/<action>, test site only) ----------

/** A pretend stream: live true or false, or null/absent to ask Twitch again; streamId optional. */
export type DevLive = { live: boolean | null; streamId: string };
export function parseDevLive(body: JsonObject): Parsed<DevLive> {
  const { live, streamId } = body;
  if (!optBooleanOrNull(live)) return bad(INVALID_BODY);
  if (!optString(streamId)) return bad(INVALID_BODY);
  return ok({ live: live ?? null, streamId: streamId || "" });
}
/** The account a dev-tool call acts as, before the Worker checks the patterns. */
export type DevAccount = { userId: string; username: string; displayName: string; text: string };
// userId, username, displayName and text: strings when sent (missing ones are refused by the route's own checks).
export function parseDevAccount(body: JsonObject): Parsed<DevAccount> {
  const { userId = "", username = "", displayName = "", text = "" } = body;
  if (typeof userId !== "string" || typeof username !== "string") return bad(INVALID_BODY);
  if (typeof displayName !== "string" || typeof text !== "string") return bad(INVALID_BODY);
  return ok({ userId, username, displayName, text });
}

// ---------- Room routes the Worker calls ----------

// /se-admin: the action decides; setSeNames needs a names object, setDuelModuleOff a boolean value.
export function parseSeAdmin(body: JsonObject): Parsed<{ action: unknown; names: JsonObject; value: boolean }> {
  const { action, names, value } = body;
  if (action === "setSeNames" && !isObject(names)) return bad(INVALID_BODY);
  if (action === "setDuelModuleOff" && typeof value !== "boolean") return bad(INVALID_BODY);
  return ok({ action, names: isObject(names) ? names : {}, value: value === true });
}
// /checkin-test: on a boolean, by a string when sent.
export function parseCheckinTest(body: JsonObject): Parsed<{ on: boolean; by: string }> {
  const { on, by = "" } = body;
  if (typeof on !== "boolean" || typeof by !== "string") return bad(INVALID_BODY);
  return ok({ on, by });
}
// /bot-sent: results an array. An entry that is not an object counts as a send that failed for an unknown reason, as
// noteBotSent has always read it.
export function parseBotSent(body: JsonObject): Parsed<{ results: (SendResult | null)[] }> {
  const { results } = body;
  if (!Array.isArray(results)) return bad(INVALID_BODY);
  return ok({
    results: results.map((r) =>
      isObject(r) ? { sent: r.sent === true, reason: r.reason ? String(r.reason) : "" } : null,
    ),
  });
}
/** A chat event as the room reads it: each field Twitch sent, of its own type. */
export type RoomChatEvent = Partial<ChatEvent>;
const CHAT_TEXT_FIELDS = [
  "broadcaster_user_id",
  "broadcaster_user_login",
  "chatter_user_id",
  "chatter_user_login",
  "chatter_user_name",
  "color",
  "message_id",
] as const; // const: each field a literal key of ChatEvent
// event: absent or null (no event), or an object whose sent fields have ChatEvent's types (slimEvent sends them so).
export function parseChatEvent(event: unknown): Parsed<RoomChatEvent | undefined> {
  if (event === undefined || event === null) return ok(undefined);
  if (!isObject(event)) return bad(INVALID_BODY);
  const out: RoomChatEvent = {};
  for (const field of CHAT_TEXT_FIELDS) {
    const v = event[field];
    if (!optString(v)) return bad(INVALID_BODY);
    if (v !== undefined) out[field] = v;
  }
  const { message, mod } = event;
  if (message !== undefined) {
    if (!isObject(message) || typeof message.text !== "string") return bad(INVALID_BODY);
    out.message = { text: message.text };
  }
  if (!optBoolean(mod)) return bad(INVALID_BODY);
  if (mod !== undefined) out.mod = mod;
  return ok(out);
}
/** An EventSub message as the Worker forwards it to the room's /eventsub. */
export type RoomEventsub = JsonObject & {
  subscription: { id?: unknown; status?: unknown; [field: string]: unknown } | undefined;
  event: RoomChatEvent | undefined;
};
// /eventsub: subscription an object when sent, event as parseChatEvent; the ids and flags are read where they are used.
export function parseRoomEventsub(body: JsonObject): Parsed<RoomEventsub> {
  const { subscription } = body;
  if (!optObject(subscription)) return bad(INVALID_BODY);
  const event = parseChatEvent(body.event);
  if (!event.ok) return bad(event.error);
  return ok({ ...body, subscription, event: event.value });
}
/** A test-site chat line (/dev-chat). */
export function parseDevChat(body: JsonObject): Parsed<DevAccount> {
  const { userId, username, displayName = "", text = "" } = body;
  if (typeof userId !== "string" || typeof username !== "string") return bad(INVALID_BODY);
  if (typeof displayName !== "string" || typeof text !== "string") return bad(INVALID_BODY);
  return ok({ userId, username, displayName, text });
}
/** A pretend stream as the room stores it (/dev-live): live a boolean, or null to ask Twitch again. */
export function parseRoomDevLive(body: JsonObject): Parsed<DevLive> {
  return parseDevLive(body);
}

// ---------- EventSub (POST /api/eventsub), after the signature check ----------

/** The fields handleEventsub reads from a verified EventSub body. */
export type EventsubEnvelope = {
  /** The subscription object as sent ({} when absent). */
  subscription: JsonObject;
  /** subscription.condition as sent ({} when absent). */
  condition: JsonObject;
  /** The chat event as sent, or null; slimEvent picks its fields. */
  event: JsonObject | null;
  challenge: unknown;
};
// subscription, subscription.condition and event: objects when sent (null counts as absent). Chat fields are not
// required: verifications and revocations carry none, and slimEvent reads each one by type.
export function parseEventsubEnvelope(body: unknown): Parsed<EventsubEnvelope> {
  if (!isObject(body)) return bad("Invalid JSON");
  const { subscription, event, challenge } = body;
  if (!optObjectOrNull(subscription)) return bad(INVALID_BODY);
  const condition = subscription?.condition;
  if (!optObjectOrNull(condition) || !optObjectOrNull(event)) return bad(INVALID_BODY);
  return ok({ subscription: subscription || {}, condition: condition || {}, event: event || null, challenge });
}

// ---------- Owner routes (POST /api/dev/*) and the room's restore steps ----------

// POST /api/dev/channels: login a string when sent (the action is checked by the route: unknown_action).
export function parseChannelsAction(body: JsonObject): Parsed<{ action: unknown; login: string }> {
  const { action, login = "" } = body;
  return typeof login === "string" ? ok({ action, login }) : bad(INVALID_BODY);
}
// POST /api/dev/restore: channel a string, undo a boolean when sent. at goes through Number() as before, so the
// route's window check answers invalid_restore_time for anything that isn't a time.
export function parseRestore(body: JsonObject): Parsed<{ channel: string; at: number; undo: boolean }> {
  const { channel = "", at, undo } = body;
  if (typeof channel !== "string" || !optBoolean(undo)) return bad(INVALID_BODY);
  return ok({ channel, at: Number(at), undo: undo === true });
}
// POST /api/dev/backups: channel a string when sent ("" backs up every channel).
export function parseBackupsRun(body: JsonObject): Parsed<{ channel: string }> {
  const { channel = "" } = body;
  return typeof channel === "string" ? ok({ channel }) : bad(INVALID_BODY);
}
// POST /api/dev/settings: takeover a boolean when sent (action and payload keep their own codes).
export function parseSettings(body: JsonObject): Parsed<{ action: unknown; payload: unknown; takeover: boolean }> {
  const { action, payload, takeover } = body;
  return optBoolean(takeover) ? ok({ action, payload, takeover: takeover === true }) : bad(INVALID_BODY);
}
// POST /api/dev/code/pr: title and body strings when sent (branch keeps its own check).
export function parseCodePr(body: JsonObject): Parsed<{ branch: unknown; title: string; text: string }> {
  const { branch, title = "", body: text = "" } = body;
  if (typeof title !== "string" || typeof text !== "string") return bad(INVALID_BODY);
  return ok({ branch, title, text });
}
// The room's /dev/restore: a JSON object with bookmark a string; at goes through Number() as before.
export function parseRoomRestore(body: unknown): Parsed<{ bookmark: string; at: number }> {
  if (!isObject(body)) return bad(INVALID_BODY);
  const { bookmark = "", at } = body;
  return typeof bookmark === "string" ? ok({ bookmark, at: Number(at) }) : bad(INVALID_BODY);
}
// The room's /dev/restored: a JSON object with revision a number when sent.
export function parseRoomRestored(body: unknown): Parsed<{ revision: number }> {
  if (!isObject(body)) return bad(INVALID_BODY);
  const { revision = 0 } = body;
  return typeof revision === "number" ? ok({ revision }) : bad(INVALID_BODY);
}

// ---------- Viewer sprites (server/sprites.ts) ----------

/** A sprite upload before validateSprite decodes it. */
export type SpriteSubmit = { label: string; image: string; ai: boolean };
// POST /api/sprite/<channel>: label and image strings, ai a boolean when sent. Each refusal keeps the reason the
// route already uses for that field.
export function parseSpriteSubmit(body: JsonObject): Parsed<SpriteSubmit> {
  const { label = "", image = "", ai } = body;
  if (typeof label !== "string") return bad("invalid_label");
  if (typeof image !== "string") return bad("invalid_image");
  if (!optBoolean(ai)) return bad("invalid_upload");
  return ok({ label, image, ai: ai === true });
}
// POST /api/sprite/<channel>/redraw: image a string.
export function parseRedraw(body: JsonObject): Parsed<{ image: string }> {
  const { image = "" } = body;
  return typeof image === "string" ? ok({ image }) : bad("invalid_image");
}
/** A review action. */
export type SpriteAction = "approve" | "reject" | "remove";
const SPRITE_ACTIONS: readonly SpriteAction[] = ["approve", "reject", "remove"];
// POST /api/sprites/<channel>/<id>: action one of the three.
export function parseSpriteReview(body: JsonObject): Parsed<{ action: SpriteAction }> {
  const action = SPRITE_ACTIONS.find((a) => a === body.action);
  return action ? ok({ action }) : bad("invalid_action");
}
// The room's /sprites: the upload plus the viewer the Worker adds (userId and username strings, displayName when sent).
export function parseRoomSpriteSubmit(
  body: JsonObject,
): Parsed<SpriteSubmit & { userId: string; username: string; displayName: string }> {
  const submit = parseSpriteSubmit(body);
  if (!submit.ok) return bad(submit.error);
  const { userId = "", username = "", displayName = "" } = body;
  if (typeof userId !== "string" || typeof username !== "string" || typeof displayName !== "string")
    return bad("invalid_upload");
  return ok({ ...submit.value, userId, username, displayName });
}
// The room's /sprites/ai: userId a string, op a string when sent.
export function parseRoomSpriteAi(body: unknown): Parsed<{ userId: string; op: string }> {
  if (!isObject(body)) return bad("invalid_request");
  const { userId = "", op = "" } = body;
  if (typeof userId !== "string" || typeof op !== "string") return bad("invalid_request");
  return ok({ userId, op });
}
// The room's /sprites/review: id a string, action one of the three, actorName and actorId strings when sent.
export function parseRoomSpriteReview(
  body: unknown,
): Parsed<{ id: string; action: SpriteAction; actorName: string; actorId: string }> {
  if (!isObject(body)) return bad(INVALID_BODY);
  const { id = "", actorName = "", actorId = "" } = body;
  if (typeof id !== "string" || typeof actorName !== "string" || typeof actorId !== "string") return bad(INVALID_BODY);
  const review = parseSpriteReview(body);
  if (!review.ok) return bad(review.error);
  return ok({ id, action: review.value.action, actorName, actorId });
}

// ---------- Outside answers: Twitch, the registry, GitHub, Cloudflare and stored data ----------
// Each parser takes the JSON as read (undefined when the body was not JSON) or the stored text, checks the fields its
// caller reads, and answers with the same objects when they pass, so a valid answer behaves exactly as before. The
// caller turns a refusal into the error that route already gives for that upstream (docs/CONTRACTS.md §1).

const TWITCH = "invalid_twitch_answer";
const REGISTRY = "invalid_registry";
const GITHUB = "invalid_github_answer";
const CLOUDFLARE = "invalid_cloudflare_answer";
const optNumber = (v: unknown): v is number | undefined => v === undefined || typeof v === "number";
const optStringOrNull = (v: unknown): v is string | null | undefined => v == null || typeof v === "string";
const optNumberOrNull = (v: unknown): v is number | null | undefined => v == null || typeof v === "number";
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isObjects = (v: unknown): v is JsonObject[] => Array.isArray(v) && v.every(isObject);
/** JSON.parse of stored text, or undefined when it is not JSON. */
const parseText = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Twitch's OAuth token answer, kept as sent: it is sealed whole into broadcaster:<login>. */
export type TwitchTokens = JsonObject & { access_token: string; refresh_token: string };
const isTokens = (v: unknown): v is TwitchTokens =>
  isObject(v) && typeof v.access_token === "string" && typeof v.refresh_token === "string";
// POST /oauth2/token (sign-in and refresh): access_token and refresh_token strings.
export function parseTwitchTokens(v: unknown): Parsed<TwitchTokens> {
  return isTokens(v) ? ok(v) : bad(TWITCH);
}
/** Twitch's /oauth2/validate answer. An app token has no user_id; null scopes are none. */
export type TwitchValidation = { client_id: string; user_id: string | undefined; scopes: string[] | null | undefined };
// GET /oauth2/validate: client_id a string, user_id a string when sent, scopes an array of strings or null when sent.
export function parseTwitchValidation(v: unknown): Parsed<TwitchValidation> {
  if (!isObject(v)) return bad(TWITCH);
  const { client_id, user_id, scopes } = v;
  if (typeof client_id !== "string" || !optString(user_id)) return bad(TWITCH);
  if (scopes === undefined) return ok({ client_id, user_id, scopes: undefined });
  if (scopes === null) return ok({ client_id, user_id, scopes: null });
  return isStrings(scopes) ? ok({ client_id, user_id, scopes }) : bad(TWITCH);
}
// GET /helix/users: data an array of users, each with id, login and display_name strings, and created_at and
// broadcaster_type strings when sent.
export function parseHelixUsers(v: unknown): Parsed<HelixUser[]> {
  if (!isObject(v) || !Array.isArray(v.data)) return bad(TWITCH);
  const users: HelixUser[] = [];
  for (const row of v.data) {
    if (!isObject(row)) return bad(TWITCH);
    const { id, login, display_name, created_at, broadcaster_type } = row;
    if (typeof id !== "string" || typeof login !== "string" || typeof display_name !== "string") return bad(TWITCH);
    if (!optString(created_at) || !optString(broadcaster_type)) return bad(TWITCH);
    users.push({ id, login, display_name, created_at, broadcaster_type });
  }
  return ok(users);
}
// Any Helix list (the sign-up's past-broadcast lookup): data an array.
export function parseHelixPage(v: unknown): Parsed<{ data: unknown[] }> {
  return isObject(v) && Array.isArray(v.data) ? ok({ data: v.data }) : bad(TWITCH);
}
// GET /helix/moderation/moderators: data an array of rows, user_id a string when sent. Answers the user ids; a row
// without one names nobody, so it is skipped (as the old some() never matched it).
export function parseModerators(v: unknown): Parsed<string[]> {
  if (!isObject(v) || !Array.isArray(v.data)) return bad(TWITCH);
  const ids: string[] = [];
  for (const row of v.data) {
    if (!isObject(row) || !optString(row.user_id)) return bad(TWITCH);
    if (row.user_id !== undefined) ids.push(row.user_id);
  }
  return ok(ids);
}

const isChannelRecord = (v: unknown): v is ChannelRecord => {
  if (!isObject(v)) return false;
  const { id, login, enabledAt, pausedAt, pausedBy, review } = v;
  if (typeof id !== "string" || typeof login !== "string" || typeof enabledAt !== "number") return false;
  if (!optNumber(pausedAt) || (pausedBy !== undefined && pausedBy !== "owner" && pausedBy !== "broadcaster"))
    return false;
  return review === undefined || (isObject(review) && isStrings(review.reasons) && typeof review.at === "number");
};
const isChannelRow = (v: unknown): v is ChannelRow =>
  isObject(v) && typeof v.key === "string" && isChannelRecord(v.value);
// AuthStore's /list (listRecords): an array of { key, value } rows, each value a channel record: id and login
// strings, enabledAt a number, pausedAt a number, pausedBy 'owner' or 'broadcaster' and review { reasons, at } when
// set. Every writer since the registry began (signUp, setPaused) writes these types.
export function parseChannelRows(v: unknown): Parsed<ChannelRow[]> {
  return Array.isArray(v) && v.every(isChannelRow) ? ok(v) : bad(REGISTRY);
}

const originOf = (url: unknown): string | null => {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};
// CHANNEL_ORIGINS: a JSON object of channel to URL. Answers each URL's origin.
export function parseChannelOrigins(text: string): Parsed<Record<string, string>> {
  const all = parseText(text);
  if (!isObject(all)) return bad("invalid_channel_origins");
  const out: Record<string, string> = {};
  for (const [channel, url] of Object.entries(all)) {
    const origin = originOf(url);
    if (origin === null) return bad("invalid_channel_origins");
    out[channel] = origin;
  }
  return ok(out);
}
// custom_characters.meta: a JSON object (validateUpload wrote it; the catalog spreads it).
export function parseUploadMeta(text: string): Parsed<JsonObject> {
  const meta = parseText(text);
  return isObject(meta) ? ok(meta) : bad("invalid_upload_meta");
}
const isUserRows = (v: unknown): v is { userId: string }[] =>
  isObjects(v) && v.every((x) => typeof x.userId === "string");
const isBackupExport = (v: unknown): v is BackupExport =>
  isObject(v) &&
  typeof v.exportedAt === "string" &&
  isUserRows(v.purchases) &&
  isUserRows(v.builds) &&
  isObjects(v.profiles) &&
  v.profiles.every((x) => typeof x.userId === "string" && typeof x.username === "string");
// A daily backup's JSON (readBackup): exportedAt a string; profiles, purchases and builds arrays of rows with a
// userId string, profiles with a username string too. The rest of the export is kept as stored.
export function parseBackupExport(text: string): Parsed<BackupExport> {
  const data = parseText(text);
  return isBackupExport(data) ? ok(data) : bad("invalid_backup");
}

/** The fields of a Cloudflare API envelope that cf() checks. GraphQL answers have no success field. */
export type CfEnvelope = { success: boolean | undefined; errors: unknown[] | null | undefined };
// Any Cloudflare API answer: success a boolean when sent, errors an array or null when sent.
export function parseCfEnvelope(v: unknown): Parsed<CfEnvelope> {
  if (!isObject(v)) return bad(CLOUDFLARE);
  const { success, errors } = v;
  if (!optBoolean(success)) return bad(CLOUDFLARE);
  if (errors === undefined) return ok({ success, errors: undefined });
  if (errors === null) return ok({ success, errors: null });
  return Array.isArray(errors) ? ok({ success, errors }) : bad(CLOUDFLARE);
}
/** One workersInvocationsAdaptive row of the GraphQL Analytics answer. */
export type AnalyticsRow = JsonObject & {
  sum?: (JsonObject & { requests?: number | null; errors?: number | null; subrequests?: number | null }) | null;
  dimensions?: (JsonObject & { scriptName?: string | null }) | null;
};
const isAnalyticsRow = (v: unknown): v is AnalyticsRow => {
  if (!isObject(v)) return false;
  const { sum, dimensions } = v;
  if (!optObjectOrNull(sum) || !optObjectOrNull(dimensions)) return false;
  if (sum && !(optNumberOrNull(sum.requests) && optNumberOrNull(sum.errors) && optNumberOrNull(sum.subrequests)))
    return false;
  return !dimensions || optStringOrNull(dimensions.scriptName);
};
// POST /graphql (usage): data.viewer.accounts[0].workersInvocationsAdaptive an array of rows; each row's sum and
// dimensions objects or null, the counts numbers or null and scriptName a string or null.
export function parseAnalytics(v: unknown): Parsed<AnalyticsRow[]> {
  const viewer = isObject(v) && isObject(v.data) ? v.data.viewer : undefined;
  const accounts = isObject(viewer) ? viewer.accounts : undefined;
  const account: unknown = Array.isArray(accounts) ? accounts[0] : undefined;
  const rows = isObject(account) ? account.workersInvocationsAdaptive : undefined;
  return Array.isArray(rows) && rows.every(isAnalyticsRow) ? ok(rows) : bad(CLOUDFLARE);
}
/** One Worker deployment, as versions() reads it. */
export type CfDeployment = JsonObject & {
  annotations?: JsonObject | null;
  versions?: (JsonObject & { version_id?: string; percentage?: number })[];
};
const isDeployment = (v: unknown): v is CfDeployment => {
  if (!isObject(v) || !optObjectOrNull(v.annotations)) return false;
  const { versions } = v;
  if (versions === undefined) return true;
  return isObjects(versions) && versions.every((x) => optString(x.version_id) && optNumber(x.percentage));
};
// GET .../deployments: result an object or null when sent; result.deployments an array when sent, each deployment an
// object with annotations an object or null when sent and versions an array of { version_id string, percentage
// number } when sent.
export function parseCfDeployments(v: unknown): Parsed<CfDeployment[]> {
  if (!isObject(v) || !optObjectOrNull(v.result)) return bad(CLOUDFLARE);
  const deployments = v.result?.deployments;
  if (deployments === undefined) return ok([]);
  return Array.isArray(deployments) && deployments.every(isDeployment) ? ok(deployments) : bad(CLOUDFLARE);
}
/** One Worker version, as versions() reads it. */
export type CfVersion = JsonObject & { metadata?: JsonObject | null; annotations?: JsonObject | null };
const isVersion = (v: unknown): v is CfVersion =>
  isObject(v) && optObjectOrNull(v.metadata) && optObjectOrNull(v.annotations);
// GET .../versions: result an object or null when sent; result.items an array when sent, each item an object with
// metadata and annotations objects or null when sent.
export function parseCfVersions(v: unknown): Parsed<CfVersion[]> {
  if (!isObject(v) || !optObjectOrNull(v.result)) return bad(CLOUDFLARE);
  const items = v.result?.items;
  if (items === undefined) return ok([]);
  return Array.isArray(items) && items.every(isVersion) ? ok(items) : bad(CLOUDFLARE);
}

// GET /git/trees/<ref>: tree an array of objects when sent (each entry's type, path and size are checked by codeTree).
export function parseGhTree(v: unknown): Parsed<{ tree: JsonObject[]; truncated: unknown }> {
  if (!isObject(v)) return bad(GITHUB);
  const { tree = [], truncated } = v;
  return isObjects(tree) ? ok({ tree, truncated }) : bad(GITHUB);
}
/** A file from GitHub's contents API. */
export type GhFile = {
  size: number;
  encoding: string | undefined;
  content: string | undefined;
  sha: string | undefined;
};
// GET /contents/<path>: a directory (an array) or anything but a file answers null; a file has size a number and
// encoding, content and sha strings when sent.
export function parseGhContent(v: unknown): Parsed<GhFile | null> {
  if (Array.isArray(v)) return ok(null);
  if (!isObject(v)) return bad(GITHUB);
  if (v.type !== "file") return ok(null);
  const { size, encoding, content, sha } = v;
  if (typeof size !== "number" || !optString(encoding) || !optString(content) || !optString(sha)) return bad(GITHUB);
  return ok({ size, encoding, content, sha });
}
// GET /git/ref/heads/<branch>: object.sha a string.
export function parseGhRef(v: unknown): Parsed<{ sha: string }> {
  const object = isObject(v) ? v.object : undefined;
  return isObject(object) && typeof object.sha === "string" ? ok({ sha: object.sha }) : bad(GITHUB);
}
/** GitHub's answer to a file save: the new blob and commit, each passed on as sent. */
export type GhSaved = { content: JsonObject | null | undefined; commit: JsonObject | null | undefined };
// PUT /contents/<path>: content and commit objects or null when sent.
export function parseGhSaved(v: unknown): Parsed<GhSaved> {
  if (!isObject(v)) return bad(GITHUB);
  const { content, commit } = v;
  return optObjectOrNull(content) && optObjectOrNull(commit) ? ok({ content, commit }) : bad(GITHUB);
}
/** A pull request as openPr reads it. */
export type GhPr = { number: number; html_url: string };
const prOf = (v: unknown): GhPr | null =>
  isObject(v) && typeof v.number === "number" && typeof v.html_url === "string"
    ? { number: v.number, html_url: v.html_url }
    : null;
// GET /pulls?state=open: an array of pull requests, each with number a number and html_url a string.
export function parseGhPulls(v: unknown): Parsed<GhPr[]> {
  if (!Array.isArray(v)) return bad(GITHUB);
  const prs: GhPr[] = [];
  for (const row of v) {
    const pr = prOf(row);
    if (!pr) return bad(GITHUB);
    prs.push(pr);
  }
  return ok(prs);
}
// POST /pulls: number a number and html_url a string.
export function parseGhPr(v: unknown): Parsed<GhPr> {
  const pr = prOf(v);
  return pr ? ok(pr) : bad(GITHUB);
}
// GET /actions/workflows/<file>/runs: workflow_runs an array of objects when sent.
export function parseGhRuns(v: unknown): Parsed<JsonObject[]> {
  if (!isObject(v)) return bad(GITHUB);
  const { workflow_runs = [] } = v;
  return isObjects(workflow_runs) ? ok(workflow_runs) : bad(GITHUB);
}
/** A pull request as promote reads it. */
export type GhPull = JsonObject & {
  base?: JsonObject;
  head: JsonObject & { ref?: string; sha: string };
  merged?: boolean;
  merge_commit_sha?: string | null;
  state?: string;
};
const isPull = (v: unknown): v is GhPull => {
  if (!isObject(v) || !isObject(v.head)) return false;
  const { head, base, merged, merge_commit_sha, state } = v;
  if (typeof head.sha !== "string" || !optString(head.ref) || !optObject(base)) return false;
  return optBoolean(merged) && optStringOrNull(merge_commit_sha) && optString(state);
};
// GET /pulls/<number>: head an object with sha a string and ref a string when sent; base an object, merged a
// boolean, merge_commit_sha a string or null and state a string when sent.
export function parseGhPull(v: unknown): Parsed<GhPull> {
  return isPull(v) ? ok(v) : bad(GITHUB);
}
// PUT /pulls/<number>/merge: sha a string (the commit production deploys).
export function parseGhMerge(v: unknown): Parsed<{ sha: string }> {
  return isObject(v) && typeof v.sha === "string" ? ok({ sha: v.sha }) : bad(GITHUB);
}
/** For calls that read only the status (dispatch, the branch checks). */
export function ignoreAnswer(): Parsed<null> {
  return ok(null);
}
