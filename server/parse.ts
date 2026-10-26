import { COSMETIC_KINDS, COSMETIC_FIELDS, MAX_BUILDS } from "./cosmetics.ts";
import type { AbilityName, BackupExport, ChatEvent, SendResult } from "./model.ts";
import type { HelixUser } from "./auth.ts";
import type { ChannelRecord, ChannelRow } from "./channels.ts";

// Request bodies and outside answers, checked once where they arrive (docs/CONTRACTS.md §1). Each parser checks only
// the fields its caller reads and lets the rest through, so a value with a named refusal further in still reaches it.
// The error is the code the route answers with.

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

const INVALID_BODY = "invalid_body";

// ---------- POST /api/admin/<channel> (Worker) and the room's /admin ----------

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
// Any other field is the action's own, checked by the room (invalid_amount, invalid_command_name, invalid_config ...).
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

/** The room's /profile: the base look as strings; stats, cosmetics and build keep saveProfile's own codes. */
export type ProfileInput = JsonObject & {
  username: string;
  color: string;
  defaultAbility: string;
  displayName?: string | undefined;
  avatar?: string | undefined;
  hat?: string | undefined;
  pet?: string | undefined;
};
export function parseProfileInput(body: JsonObject): Parsed<ProfileInput> {
  const { username, color, defaultAbility, displayName, avatar, hat, pet } = body;
  if (typeof username !== "string" || typeof color !== "string" || typeof defaultAbility !== "string")
    return bad("invalid_profile");
  if (!optString(displayName) || !optString(avatar) || !optString(hat) || !optString(pet))
    return bad("invalid_profile");
  return ok({ ...body, username, color, defaultAbility, displayName, avatar, hat, pet });
}

/** POST /api/profile/<channel>, as the Worker forwards it; the room checks stats against the saved wins. */
type ProfileSave = {
  avatar: string;
  color: string;
  defaultAbility: AbilityName;
  stats: JsonObject | undefined;
  hat: string | undefined;
  pet: string | undefined;
  /** The cosmetics and build slot sent. */
  loadout: JsonObject;
};
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

// ---------- POST /api/shop/<channel> ----------

/** "reroll" is a legendary pet's free reroll (id = the pet); the room checks the ids and prices. */
const SHOP_KINDS: readonly string[] = ["pet", "hat", "slot", ...COSMETIC_KINDS, "reroll"];
// price is the one the buyer saw; the room answers 409 price_changed when it differs.
export function parseShopBuy(body: JsonObject): Parsed<{ kind: string; id: string; price: number | undefined }> {
  const { kind, id = "", price } = body;
  if (typeof kind !== "string" || !SHOP_KINDS.includes(kind)) return bad("invalid_item");
  if (typeof id !== "string" || id.length > 64) return bad("invalid_item");
  if (!isPrice(price)) return bad("invalid_item");
  return ok({ kind, id, price });
}

// ---------- Dev-token tools (test site only) ----------

/** A pretend stream: live true or false, or null to ask Twitch again. */
export function parseDevLive(body: JsonObject): Parsed<{ live: boolean | null; streamId: string }> {
  const { live, streamId } = body;
  if (!optBooleanOrNull(live)) return bad(INVALID_BODY);
  if (!optString(streamId)) return bad(INVALID_BODY);
  return ok({ live: live ?? null, streamId: streamId || "" });
}
/** The account a dev-tool call acts as; the route refuses missing ones itself. */
export type DevAccount = { userId: string; username: string; displayName: string; text: string };
export function parseDevAccount(body: JsonObject): Parsed<DevAccount> {
  const { userId = "", username = "", displayName = "", text = "" } = body;
  if (typeof userId !== "string" || typeof username !== "string") return bad(INVALID_BODY);
  if (typeof displayName !== "string" || typeof text !== "string") return bad(INVALID_BODY);
  return ok({ userId, username, displayName, text });
}

// ---------- Room routes the Worker calls ----------

export function parseSeAdmin(body: JsonObject): Parsed<{ action: unknown; names: JsonObject; value: boolean }> {
  const { action, names, value } = body;
  if (action === "setSeNames" && !isObject(names)) return bad(INVALID_BODY);
  if (action === "setDuelModuleOff" && typeof value !== "boolean") return bad(INVALID_BODY);
  return ok({ action, names: isObject(names) ? names : {}, value: value === true });
}
export function parseCheckinTest(body: JsonObject): Parsed<{ on: boolean; by: string }> {
  const { on, by = "" } = body;
  if (typeof on !== "boolean" || typeof by !== "string") return bad(INVALID_BODY);
  return ok({ on, by });
}
// An entry that is not an object counts as a send that failed for an unknown reason, as noteBotSent always read it.
export function parseBotSent(body: JsonObject): Parsed<{ results: (SendResult | null)[] }> {
  const { results } = body;
  if (!Array.isArray(results)) return bad(INVALID_BODY);
  return ok({
    results: results.map((r) =>
      isObject(r) ? { sent: r.sent === true, reason: r.reason ? String(r.reason) : "" } : null,
    ),
  });
}
type RoomChatEvent = Partial<ChatEvent>;
const CHAT_TEXT_FIELDS = [
  "broadcaster_user_id",
  "broadcaster_user_login",
  "chatter_user_id",
  "chatter_user_login",
  "chatter_user_name",
  "color",
  "message_id",
] as const; // const: each field a literal key of ChatEvent
// Absent or null is no event; otherwise each sent field must have ChatEvent's type (slimEvent sends them so).
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
type RoomEventsub = JsonObject & {
  subscription: { id?: unknown; status?: unknown; [field: string]: unknown } | undefined;
  event: RoomChatEvent | undefined;
};
export function parseRoomEventsub(body: JsonObject): Parsed<RoomEventsub> {
  const { subscription } = body;
  if (!optObject(subscription)) return bad(INVALID_BODY);
  const event = parseChatEvent(body.event);
  if (!event.ok) return bad(event.error);
  return ok({ ...body, subscription, event: event.value });
}
/** A test-site chat line (/dev-chat): parseDevAccount with userId and username required. */
export function parseDevChat(body: JsonObject): Parsed<DevAccount> {
  if (typeof body.userId !== "string" || typeof body.username !== "string") return bad(INVALID_BODY);
  return parseDevAccount(body);
}
export const parseRoomDevLive = parseDevLive;

// ---------- POST /api/eventsub, after the signature check ----------

/** subscription and condition are {} when absent; slimEvent picks the event's fields. */
type EventsubEnvelope = {
  subscription: JsonObject;
  condition: JsonObject;
  event: JsonObject | null;
  challenge: unknown;
};
// Verifications and revocations carry no chat fields, so none is required here.
export function parseEventsubEnvelope(body: unknown): Parsed<EventsubEnvelope> {
  if (!isObject(body)) return bad("Invalid JSON");
  const { subscription, event, challenge } = body;
  if (!optObjectOrNull(subscription)) return bad(INVALID_BODY);
  const condition = subscription?.condition;
  if (!optObjectOrNull(condition) || !optObjectOrNull(event)) return bad(INVALID_BODY);
  return ok({ subscription: subscription || {}, condition: condition || {}, event: event || null, challenge });
}

// ---------- Owner routes (POST /api/dev/*) and the room's restore steps ----------

// The route checks the action itself (unknown_action).
export function parseChannelsAction(body: JsonObject): Parsed<{ action: unknown; login: string }> {
  const { action, login = "" } = body;
  return typeof login === "string" ? ok({ action, login }) : bad(INVALID_BODY);
}
// at goes through Number(), so the route's window check answers invalid_restore_time for anything that isn't a time.
export function parseRestore(body: JsonObject): Parsed<{ channel: string; at: number; undo: boolean }> {
  const { channel = "", at, undo } = body;
  if (typeof channel !== "string" || !optBoolean(undo)) return bad(INVALID_BODY);
  return ok({ channel, at: Number(at), undo: undo === true });
}
// channel "" backs up every channel.
export function parseBackupsRun(body: JsonObject): Parsed<{ channel: string }> {
  const { channel = "" } = body;
  return typeof channel === "string" ? ok({ channel }) : bad(INVALID_BODY);
}
export function parseSettings(body: JsonObject): Parsed<{ action: unknown; payload: unknown; takeover: boolean }> {
  const { action, payload, takeover } = body;
  return optBoolean(takeover) ? ok({ action, payload, takeover: takeover === true }) : bad(INVALID_BODY);
}
export function parseCodePr(body: JsonObject): Parsed<{ branch: unknown; title: string; text: string }> {
  const { branch, title = "", body: text = "" } = body;
  if (typeof title !== "string" || typeof text !== "string") return bad(INVALID_BODY);
  return ok({ branch, title, text });
}
export function parseRoomRestore(body: unknown): Parsed<{ bookmark: string; at: number }> {
  if (!isObject(body)) return bad(INVALID_BODY);
  const { bookmark = "", at } = body;
  return typeof bookmark === "string" ? ok({ bookmark, at: Number(at) }) : bad(INVALID_BODY);
}
export function parseRoomRestored(body: unknown): Parsed<{ revision: number }> {
  if (!isObject(body)) return bad(INVALID_BODY);
  const { revision = 0 } = body;
  return typeof revision === "number" ? ok({ revision }) : bad(INVALID_BODY);
}

// ---------- Viewer sprites (server/sprites.ts); each refusal keeps the code the route used for that field ----------

export type SpriteSubmit = { label: string; image: string; ai: boolean };
export function parseSpriteSubmit(body: JsonObject): Parsed<SpriteSubmit> {
  const { label = "", image = "", ai } = body;
  if (typeof label !== "string") return bad("invalid_label");
  if (typeof image !== "string") return bad("invalid_image");
  if (!optBoolean(ai)) return bad("invalid_upload");
  return ok({ label, image, ai: ai === true });
}
export function parseRedraw(body: JsonObject): Parsed<{ image: string }> {
  const { image = "" } = body;
  return typeof image === "string" ? ok({ image }) : bad("invalid_image");
}
type SpriteAction = "approve" | "reject" | "remove";
const SPRITE_ACTIONS: readonly SpriteAction[] = ["approve", "reject", "remove"];
export function parseSpriteReview(body: JsonObject): Parsed<{ action: SpriteAction }> {
  const action = SPRITE_ACTIONS.find((a) => a === body.action);
  return action ? ok({ action }) : bad("invalid_action");
}
/** The room's /sprites: the upload plus the viewer the Worker adds. */
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
export function parseRoomSpriteAi(body: unknown): Parsed<{ userId: string; op: string }> {
  if (!isObject(body)) return bad("invalid_request");
  const { userId = "", op = "" } = body;
  if (typeof userId !== "string" || typeof op !== "string") return bad("invalid_request");
  return ok({ userId, op });
}
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
// Each takes the JSON as read (undefined when it was not JSON) or the stored text, and answers with the same objects
// when they pass; the caller turns a refusal into the error that route already gives for that upstream.

const TWITCH = "invalid_twitch_answer";
const GITHUB = "invalid_github_answer";
const CLOUDFLARE = "invalid_cloudflare_answer";
const optNumber = (v: unknown): v is number | undefined => v === undefined || typeof v === "number";
const optStringOrNull = (v: unknown): v is string | null | undefined => v == null || typeof v === "string";
const optNumberOrNull = (v: unknown): v is number | null | undefined => v == null || typeof v === "number";
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isObjects = (v: unknown): v is JsonObject[] => Array.isArray(v) && v.every(isObject);
const parseText = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Kept as sent, key order too: it is sealed whole into broadcaster:<login>. */
export type TwitchTokens = JsonObject & { access_token: string; refresh_token: string };
const isTokens = (v: unknown): v is TwitchTokens =>
  isObject(v) && typeof v.access_token === "string" && typeof v.refresh_token === "string";
export function parseTwitchTokens(v: unknown): Parsed<TwitchTokens> {
  return isTokens(v) ? ok(v) : bad(TWITCH);
}
/** An app token has no user_id; null scopes are none. */
type TwitchValidation = { client_id: string; user_id: string | undefined; scopes: string[] | null | undefined };
export function parseTwitchValidation(v: unknown): Parsed<TwitchValidation> {
  if (!isObject(v)) return bad(TWITCH);
  const { client_id, user_id, scopes } = v;
  if (typeof client_id !== "string" || !optString(user_id)) return bad(TWITCH);
  if (scopes === undefined) return ok({ client_id, user_id, scopes: undefined });
  if (scopes === null) return ok({ client_id, user_id, scopes: null });
  return isStrings(scopes) ? ok({ client_id, user_id, scopes }) : bad(TWITCH);
}
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
// Any Helix list (the sign-up's past-broadcast lookup).
export function parseHelixPage(v: unknown): Parsed<{ data: unknown[] }> {
  return isObject(v) && Array.isArray(v.data) ? ok({ data: v.data }) : bad(TWITCH);
}
// Answers the moderators' user ids; a row without one names nobody, so it is skipped.
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
// AuthStore's /list (listRecords). A row of another shape is skipped and named by its key (or index), so one bad
// record can't take every other channel down.
export function parseChannelRows(v: unknown): Parsed<{ rows: ChannelRow[]; skipped: string[] }> {
  if (!Array.isArray(v)) return bad("invalid_registry");
  const rows: ChannelRow[] = [],
    skipped: string[] = [];
  v.forEach((row: unknown, i) => {
    if (isChannelRow(row)) rows.push(row);
    else skipped.push(isObject(row) && typeof row.key === "string" ? row.key : String(i));
  });
  return ok({ rows, skipped });
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
// custom_characters.meta (validateUpload wrote it; the catalog spreads it).
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
// A daily backup (readBackup); the rest of the export is kept as stored.
export function parseBackupExport(text: string): Parsed<BackupExport> {
  const data = parseText(text);
  return isBackupExport(data) ? ok(data) : bad("invalid_backup");
}

/** GraphQL answers have no success field. */
type CfEnvelope = { success: boolean | undefined; errors: unknown[] | null | undefined };
export function parseCfEnvelope(v: unknown): Parsed<CfEnvelope> {
  if (!isObject(v)) return bad(CLOUDFLARE);
  const { success, errors } = v;
  if (!optBoolean(success)) return bad(CLOUDFLARE);
  if (errors === undefined) return ok({ success, errors: undefined });
  if (errors === null) return ok({ success, errors: null });
  return Array.isArray(errors) ? ok({ success, errors }) : bad(CLOUDFLARE);
}
/** One workersInvocationsAdaptive row of the GraphQL Analytics answer. */
type AnalyticsRow = JsonObject & {
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
// POST /graphql: data.viewer.accounts[0].workersInvocationsAdaptive.
export function parseAnalytics(v: unknown): Parsed<AnalyticsRow[]> {
  const viewer = isObject(v) && isObject(v.data) ? v.data.viewer : undefined;
  const accounts = isObject(viewer) ? viewer.accounts : undefined;
  const account: unknown = Array.isArray(accounts) ? accounts[0] : undefined;
  const rows = isObject(account) ? account.workersInvocationsAdaptive : undefined;
  return Array.isArray(rows) && rows.every(isAnalyticsRow) ? ok(rows) : bad(CLOUDFLARE);
}
type CfDeployment = JsonObject & {
  annotations?: JsonObject | null;
  versions?: (JsonObject & { version_id?: string; percentage?: number })[];
};
const isDeployment = (v: unknown): v is CfDeployment => {
  if (!isObject(v) || !optObjectOrNull(v.annotations)) return false;
  const { versions } = v;
  if (versions === undefined) return true;
  return isObjects(versions) && versions.every((x) => optString(x.version_id) && optNumber(x.percentage));
};
export function parseCfDeployments(v: unknown): Parsed<CfDeployment[]> {
  if (!isObject(v) || !optObjectOrNull(v.result)) return bad(CLOUDFLARE);
  const deployments = v.result?.deployments;
  if (deployments === undefined) return ok([]);
  return Array.isArray(deployments) && deployments.every(isDeployment) ? ok(deployments) : bad(CLOUDFLARE);
}
type CfVersion = JsonObject & { metadata?: JsonObject | null; annotations?: JsonObject | null };
const isVersion = (v: unknown): v is CfVersion =>
  isObject(v) && optObjectOrNull(v.metadata) && optObjectOrNull(v.annotations);
export function parseCfVersions(v: unknown): Parsed<CfVersion[]> {
  if (!isObject(v) || !optObjectOrNull(v.result)) return bad(CLOUDFLARE);
  const items = v.result?.items;
  if (items === undefined) return ok([]);
  return Array.isArray(items) && items.every(isVersion) ? ok(items) : bad(CLOUDFLARE);
}

// codeTree checks each entry's type, path and size.
export function parseGhTree(v: unknown): Parsed<{ tree: JsonObject[]; truncated: unknown }> {
  if (!isObject(v)) return bad(GITHUB);
  const { tree = [], truncated } = v;
  return isObjects(tree) ? ok({ tree, truncated }) : bad(GITHUB);
}
type GhFile = { size: number; encoding: string | undefined; content: string | undefined; sha: string | undefined };
// A directory (an array) or anything but a file answers null.
export function parseGhContent(v: unknown): Parsed<GhFile | null> {
  if (Array.isArray(v)) return ok(null);
  if (!isObject(v)) return bad(GITHUB);
  if (v.type !== "file") return ok(null);
  const { size, encoding, content, sha } = v;
  if (typeof size !== "number" || !optString(encoding) || !optString(content) || !optString(sha)) return bad(GITHUB);
  return ok({ size, encoding, content, sha });
}
export function parseGhRef(v: unknown): Parsed<{ sha: string }> {
  const object = isObject(v) ? v.object : undefined;
  return isObject(object) && typeof object.sha === "string" ? ok({ sha: object.sha }) : bad(GITHUB);
}
type GhSaved = { content: JsonObject | null | undefined; commit: JsonObject | null | undefined };
export function parseGhSaved(v: unknown): Parsed<GhSaved> {
  if (!isObject(v)) return bad(GITHUB);
  const { content, commit } = v;
  return optObjectOrNull(content) && optObjectOrNull(commit) ? ok({ content, commit }) : bad(GITHUB);
}
type GhPr = { number: number; html_url: string };
const prOf = (v: unknown): GhPr | null =>
  isObject(v) && typeof v.number === "number" && typeof v.html_url === "string"
    ? { number: v.number, html_url: v.html_url }
    : null;
export function parseGhPulls(v: unknown): Parsed<GhPr[]> {
  if (!Array.isArray(v)) return bad(GITHUB);
  const prs = v.map(prOf);
  return prs.every((pr) => pr !== null) ? ok(prs) : bad(GITHUB);
}
export function parseGhPr(v: unknown): Parsed<GhPr> {
  const pr = prOf(v);
  return pr ? ok(pr) : bad(GITHUB);
}
export function parseGhRuns(v: unknown): Parsed<JsonObject[]> {
  if (!isObject(v)) return bad(GITHUB);
  const { workflow_runs = [] } = v;
  return isObjects(workflow_runs) ? ok(workflow_runs) : bad(GITHUB);
}
/** A pull request as promote reads it. */
type GhPull = JsonObject & {
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
export function parseGhPull(v: unknown): Parsed<GhPull> {
  return isPull(v) ? ok(v) : bad(GITHUB);
}
// PUT /pulls/<number>/merge: sha is the commit production deploys.
export function parseGhMerge(v: unknown): Parsed<{ sha: string }> {
  return isObject(v) && typeof v.sha === "string" ? ok({ sha: v.sha }) : bad(GITHUB);
}
/** For calls that read only the status (dispatch, the branch checks). */
export function ignoreAnswer(): Parsed<null> {
  return ok(null);
}
