// Parsing at the boundary (server/parse.ts): each parser on its own, then the routes whose answer changed when a body
// of the wrong shape began to get a 400 at the edge instead of a crash or a silent default (docs/CONTRACTS.md §2, §4),
// and the routes whose answer changed when an outside answer (Twitch, AuthStore's registry, GitHub, Cloudflare, a
// stored backup, upload meta or CHANNEL_ORIGINS) of the wrong shape began to get that route's upstream error.
// The parser tests load parse.ts with import() so the route tests also run against code that predates it.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { gzipSync } from "node:zlib";
import worker from "../server/worker.ts";
import { access, digest, seal } from "../server/auth.ts";
import { readBackup } from "../server/backups.ts";
import { ChannelRoom } from "../server/channel.ts";
import { listRecords } from "../server/channels.ts";
import { usage } from "../server/developer.ts";
import { eventsubSecret, signEventsub } from "../server/eventsub.ts";
import { channelOrigins } from "../server/hosts.ts";
import { ensureUploadSchema, handleRoomAssets } from "../server/uploads.ts";
import type { Env } from "../server/env.ts";

const ORIGIN = "https://chat.miolaf.xyz";
const SECRET = "test-only-internal-secret-0123456789";
const DEV = "dev-token-for-tests-0123456789abcdefghij";
/** A 1x1 PNG. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// ---------- Parsers ----------

const yes = (value: unknown) => ({ ok: true, value });
const no = (error: string) => ({ ok: false, error });

test("admin parsers: action a string, payload an object, switches booleans, the actor name a string", async () => {
  const p = await import("../server/parse.ts");
  const body = { action: "resetRound", payload: { note: "fresh round" } };
  assert.deepEqual(
    p.parseAdminBody(body),
    yes({
      action: "resetRound",
      payload: { note: "fresh round" },
      takeover: false,
      value: false,
      names: {},
      fields: body,
    }),
  );
  assert.deepEqual(p.parseAdminBody({ action: 5 }), no("invalid_body"));
  assert.deepEqual(p.parseAdminBody({ action: "resetRound", payload: [] }), no("invalid_body"));
  assert.deepEqual(p.parseAdminBody({ action: "connectChat", takeover: "yes" }), no("invalid_body"));
  assert.deepEqual(p.parseAdminBody({ action: "resetRound", payload: { note: 5 } }), no("invalid_body"));
  assert.deepEqual(p.parseAdminBody({}), no("invalid_body"), "missing action");
  assert.deepEqual(p.parseAdminBody({ action: "setDuelModuleOff" }), no("invalid_body"), "missing value");
  assert.deepEqual(p.parseAdminBody({ action: "setSeNames", names: "x" }), no("invalid_body"));
  // Older pages send the action's fields at the top level: the body is the payload, extra fields ride along.
  const flat = { action: "giftDollars", userId: "7", amount: 5 };
  assert.deepEqual(
    p.parseAdminBody(flat),
    yes({ action: "giftDollars", payload: flat, takeover: false, value: false, names: {}, fields: flat }),
  );

  const room = { actorId: "1", actorName: "Mod", action: "setDuelModuleOff", value: true };
  assert.deepEqual(
    p.parseRoomAdminBody(room),
    yes({
      action: "setDuelModuleOff",
      payload: room,
      takeover: false,
      value: true,
      names: {},
      fields: room,
      actorName: "Mod",
    }),
  );
  assert.deepEqual(p.parseRoomAdminBody({ action: "resetRound", actorName: 5 }), no("invalid_body"));
  assert.deepEqual(p.parseRoomAdminBody({ actorName: "Mod" }), no("invalid_body"), "missing action");
  assert.equal(p.parseRoomAdminBody({ action: "resetRound", extra: [1] }).value?.actorName, "", "extra field kept");
});

test("profile parsers: the room's base look strings, the Worker's look checks", async () => {
  const p = await import("../server/parse.ts");
  const base = { username: "alice", color: "#123456", defaultAbility: "strike" };
  const unset = { displayName: undefined, avatar: undefined, hat: undefined, pet: undefined };
  assert.deepEqual(p.parseProfileInput({ ...base, hat: "crown" }), yes({ ...base, ...unset, hat: "crown" }));
  assert.deepEqual(p.parseProfileInput({ ...base, color: ["#AABBCC"] }), no("invalid_profile"));
  assert.deepEqual(p.parseProfileInput({ ...base, hat: [] }), no("invalid_profile"));
  assert.deepEqual(p.parseProfileInput({ ...base, displayName: 5 }), no("invalid_profile"));
  assert.deepEqual(p.parseProfileInput({ color: "#123456", defaultAbility: "strike" }), no("invalid_profile"));
  assert.deepEqual(
    p.parseProfileInput({ ...base, stats: { power: 1 } }),
    yes({ ...base, ...unset, stats: { power: 1 } }),
    "stats keep their own check in saveProfile",
  );

  const look = { avatar: "player", color: "#aabbcc", defaultAbility: "heal" };
  const plain = { ...look, stats: undefined, hat: undefined, pet: undefined, loadout: {} };
  assert.deepEqual(p.parseProfileSave(look), yes(plain));
  assert.deepEqual(p.parseProfileSave({ ...look, build: 0 }), yes({ ...plain, loadout: { build: 0 } }));
  assert.deepEqual(p.parseProfileSave({ ...look, hat: 5 }), no("invalid_fields"));
  assert.deepEqual(p.parseProfileSave({ ...look, defaultAbility: "kick" }), no("invalid_fields"));
  assert.deepEqual(p.parseProfileSave({ avatar: "player", defaultAbility: "heal" }), no("invalid_fields"));
  assert.deepEqual(p.parseProfileSave({ ...look, sparkle: true }), yes(plain), "extra field ignored");
});

test("shop and dev-tool parsers", async () => {
  const p = await import("../server/parse.ts");
  assert.deepEqual(p.parseShopBuy({ kind: "hat", id: "crown", price: 5 }), yes({ kind: "hat", id: "crown", price: 5 }));
  assert.deepEqual(p.parseShopBuy({ kind: "hat", id: "crown", price: "5" }), no("invalid_item"));
  assert.deepEqual(p.parseShopBuy({ kind: "hat", id: 5 }), no("invalid_item"));
  assert.deepEqual(p.parseShopBuy({ id: "crown" }), no("invalid_item"));
  assert.deepEqual(p.parseShopBuy({ kind: "slot", note: "x" }), yes({ kind: "slot", id: "", price: undefined }));

  assert.deepEqual(p.parseDevLive({ live: true, streamId: "s1" }), yes({ live: true, streamId: "s1" }));
  assert.deepEqual(p.parseDevLive({ live: 5 }), no("invalid_body"));
  assert.deepEqual(p.parseDevLive({ live: false, streamId: 5 }), no("invalid_body"));
  assert.deepEqual(p.parseDevLive({}), yes({ live: null, streamId: "" }));
  assert.deepEqual(p.parseDevLive({ live: null, x: 1 }), yes({ live: null, streamId: "" }));
  assert.deepEqual(p.parseRoomDevLive({ live: false }), yes({ live: false, streamId: "" }));
  assert.deepEqual(p.parseRoomDevLive({ live: "yes" }), no("invalid_body"));

  const account = { userId: "t1", username: "testbot_a", displayName: "Bot A", text: "!fight" };
  assert.deepEqual(p.parseDevAccount(account), yes(account));
  assert.deepEqual(p.parseDevAccount({ ...account, text: 5 }), no("invalid_body"));
  assert.deepEqual(p.parseDevAccount({ ...account, userId: 7 }), no("invalid_body"));
  assert.deepEqual(p.parseDevAccount({}), yes({ userId: "", username: "", displayName: "", text: "" }));
  assert.deepEqual(p.parseDevAccount({ ...account, pet: "fox" }), yes(account));
});

test("room route parsers: se-admin, check-in test, bot-sent, dev chat", async () => {
  const p = await import("../server/parse.ts");
  assert.deepEqual(
    p.parseSeAdmin({ action: "setSeNames", names: { fight: "!f" } }),
    yes({ action: "setSeNames", names: { fight: "!f" }, value: false }),
  );
  assert.deepEqual(p.parseSeAdmin({ action: "setSeNames", names: 5 }), no("invalid_body"));
  assert.deepEqual(p.parseSeAdmin({ action: "setDuelModuleOff" }), no("invalid_body"), "missing value");
  assert.deepEqual(
    p.parseSeAdmin({ action: "rotateSeKey", x: 1 }),
    yes({ action: "rotateSeKey", names: {}, value: false }),
  );

  assert.deepEqual(p.parseCheckinTest({ on: true, by: "Mod" }), yes({ on: true, by: "Mod" }));
  assert.deepEqual(p.parseCheckinTest({ on: "yes" }), no("invalid_body"));
  assert.deepEqual(p.parseCheckinTest({ on: true, by: 5 }), no("invalid_body"));
  assert.deepEqual(p.parseCheckinTest({}), no("invalid_body"), "missing on");
  assert.deepEqual(p.parseCheckinTest({ on: false, x: 1 }), yes({ on: false, by: "" }));

  assert.deepEqual(
    p.parseBotSent({ results: [{ sent: true }, { sent: false, reason: "msg_duplicate" }, "x"] }),
    yes({ results: [{ sent: true, reason: "" }, { sent: false, reason: "msg_duplicate" }, null] }),
  );
  assert.deepEqual(p.parseBotSent({ results: {} }), no("invalid_body"));
  assert.deepEqual(p.parseBotSent({}), no("invalid_body"), "missing results");
  assert.deepEqual(p.parseBotSent({ results: [], x: 1 }), yes({ results: [] }));

  const line = { userId: "7", username: "bob", displayName: "Bob", text: "!fight" };
  assert.deepEqual(p.parseDevChat(line), yes(line));
  assert.deepEqual(p.parseDevChat({ ...line, text: 5 }), no("invalid_body"));
  assert.deepEqual(p.parseDevChat({ username: "bob", text: "hi" }), no("invalid_body"), "missing userId");
  assert.deepEqual(p.parseDevChat({ userId: "7", username: "bob", x: 1 }), yes({ ...line, displayName: "", text: "" }));
});

test("EventSub parsers: the Worker's envelope, the room's message and its chat event", async () => {
  const p = await import("../server/parse.ts");
  const envelope = { subscription: { id: "s", condition: { user_id: "9" } }, event: { message_id: "m" } };
  assert.deepEqual(
    p.parseEventsubEnvelope(envelope),
    yes({ ...envelope, condition: { user_id: "9" }, challenge: undefined }),
  );
  assert.deepEqual(p.parseEventsubEnvelope({ subscription: 5 }), no("invalid_body"));
  assert.deepEqual(p.parseEventsubEnvelope({ subscription: { condition: [] } }), no("invalid_body"));
  assert.deepEqual(p.parseEventsubEnvelope({ event: "x" }), no("invalid_body"));
  assert.deepEqual(p.parseEventsubEnvelope([1]), no("Invalid JSON"));
  assert.deepEqual(
    p.parseEventsubEnvelope({ challenge: "abc", subscription: null }),
    yes({ subscription: {}, condition: {}, event: null, challenge: "abc" }),
    "missing and null fields count as absent",
  );
  assert.deepEqual(
    p.parseEventsubEnvelope({ ...envelope, extra: 1 }).value?.subscription,
    envelope.subscription,
    "extra field ignored",
  );

  const event = { chatter_user_id: "7", message: { text: "!fight" }, mod: true };
  assert.deepEqual(p.parseChatEvent(event), yes(event));
  assert.deepEqual(p.parseChatEvent({ message: { text: 5 } }), no("invalid_body"));
  assert.deepEqual(p.parseChatEvent({ chatter_user_id: 7 }), no("invalid_body"));
  assert.deepEqual(p.parseChatEvent({ mod: "yes" }), no("invalid_body"));
  assert.deepEqual(p.parseChatEvent(undefined), yes(undefined));
  assert.deepEqual(p.parseChatEvent(null), yes(undefined));
  assert.deepEqual(p.parseChatEvent({ chatter_user_id: "7", badges: [] }), yes({ chatter_user_id: "7" }));

  const message = {
    messageId: "m1",
    timestamp: 1,
    messageType: "notification",
    subscription: { id: "s" },
    event: null,
  };
  assert.deepEqual(p.parseRoomEventsub(message), yes({ ...message, event: undefined }));
  assert.deepEqual(p.parseRoomEventsub({ subscription: 5 }), no("invalid_body"));
  assert.deepEqual(p.parseRoomEventsub({ event: 5 }), no("invalid_body"));
  assert.deepEqual(p.parseRoomEventsub({}), yes({ subscription: undefined, event: undefined }));
  assert.deepEqual(
    p.parseRoomEventsub({ timestamp: 1 }),
    yes({ timestamp: 1, subscription: undefined, event: undefined }),
  );
});

test("owner route parsers: channels, restore, backups, settings, code PR and the room's restore steps", async () => {
  const p = await import("../server/parse.ts");
  assert.deepEqual(p.parseChannelsAction({ action: "pause", login: "x" }), yes({ action: "pause", login: "x" }));
  assert.deepEqual(p.parseChannelsAction({ action: "pause", login: 5 }), no("invalid_body"));
  assert.deepEqual(p.parseChannelsAction({ action: "pause" }), yes({ action: "pause", login: "" }));
  assert.deepEqual(p.parseChannelsAction({ action: "x", y: 1 }), yes({ action: "x", login: "" }));

  assert.deepEqual(p.parseRestore({ channel: "a", at: 5 }), yes({ channel: "a", at: 5, undo: false }));
  assert.deepEqual(p.parseRestore({ channel: 5, at: 5 }), no("invalid_body"));
  assert.deepEqual(p.parseRestore({ channel: "a", undo: "yes" }), no("invalid_body"));
  assert.deepEqual(p.parseRestore({ undo: true }), yes({ channel: "", at: Number.NaN, undo: true }));
  assert.deepEqual(
    p.parseRestore({ channel: "a", at: "1700000000000" }),
    yes({ channel: "a", at: 1700000000000, undo: false }),
  );
  assert.deepEqual(
    p.parseRestore({ channel: "a", at: "yesterday", x: 1 }),
    yes({ channel: "a", at: Number.NaN, undo: false }),
    "a time that is not a number reaches the window check",
  );

  assert.deepEqual(p.parseBackupsRun({ channel: "a" }), yes({ channel: "a" }));
  assert.deepEqual(p.parseBackupsRun({ channel: 5 }), no("invalid_body"));
  assert.deepEqual(p.parseBackupsRun({ x: 1 }), yes({ channel: "" }));

  assert.deepEqual(
    p.parseSettings({ action: "connectChat", takeover: true }),
    yes({ action: "connectChat", payload: undefined, takeover: true }),
  );
  assert.deepEqual(p.parseSettings({ action: "connectChat", takeover: 1 }), no("invalid_body"));
  assert.deepEqual(p.parseSettings({ x: 1 }), yes({ action: undefined, payload: undefined, takeover: false }));

  assert.deepEqual(
    p.parseCodePr({ branch: "live-fix/a", title: "T", body: "B" }),
    yes({ branch: "live-fix/a", title: "T", text: "B" }),
  );
  assert.deepEqual(p.parseCodePr({ branch: "live-fix/a", title: 5 }), no("invalid_body"));
  assert.deepEqual(p.parseCodePr({ branch: "live-fix/a", body: [] }), no("invalid_body"));
  assert.deepEqual(p.parseCodePr({ x: 1 }), yes({ branch: undefined, title: "", text: "" }));

  assert.deepEqual(p.parseRoomRestore({ bookmark: "b" }), yes({ bookmark: "b", at: Number.NaN }));
  assert.deepEqual(p.parseRoomRestore({ at: 5 }), yes({ bookmark: "", at: 5 }));
  assert.deepEqual(p.parseRoomRestore({ bookmark: 5 }), no("invalid_body"));
  assert.deepEqual(
    p.parseRoomRestore({ at: "5" }),
    yes({ bookmark: "", at: 5 }),
    "at goes through Number() as on main",
  );
  assert.deepEqual(p.parseRoomRestore(null), no("invalid_body"));
  assert.deepEqual(p.parseRoomRestore({ at: 5, x: 1 }), yes({ bookmark: "", at: 5 }));

  assert.deepEqual(p.parseRoomRestored({ revision: 4 }), yes({ revision: 4 }));
  assert.deepEqual(p.parseRoomRestored({ revision: "4" }), no("invalid_body"));
  assert.deepEqual(p.parseRoomRestored([]), no("invalid_body"));
  assert.deepEqual(p.parseRoomRestored({ x: 1 }), yes({ revision: 0 }));
});

test("sprite parsers: uploads, redraws, reviews and the room's sprite routes", async () => {
  const p = await import("../server/parse.ts");
  assert.deepEqual(
    p.parseSpriteSubmit({ label: "Cat", image: "AAAA", ai: true }),
    yes({ label: "Cat", image: "AAAA", ai: true }),
  );
  assert.deepEqual(p.parseSpriteSubmit({ label: 5, image: "AAAA" }), no("invalid_label"));
  assert.deepEqual(p.parseSpriteSubmit({ label: "Cat", image: {} }), no("invalid_image"));
  assert.deepEqual(p.parseSpriteSubmit({ label: "Cat", ai: "yes" }), no("invalid_upload"));
  assert.deepEqual(
    p.parseSpriteSubmit({}),
    yes({ label: "", image: "", ai: false }),
    "validateSprite refuses the blanks",
  );
  assert.deepEqual(
    p.parseSpriteSubmit({ label: "Cat", image: "AAAA", userId: "1" }),
    yes({ label: "Cat", image: "AAAA", ai: false }),
  );

  assert.deepEqual(p.parseRedraw({ image: "AAAA" }), yes({ image: "AAAA" }));
  assert.deepEqual(p.parseRedraw({ image: 5 }), no("invalid_image"));
  assert.deepEqual(p.parseRedraw({ x: 1 }), yes({ image: "" }));

  assert.deepEqual(p.parseSpriteReview({ action: "approve" }), yes({ action: "approve" }));
  assert.deepEqual(p.parseSpriteReview({ action: 5 }), no("invalid_action"));
  assert.deepEqual(p.parseSpriteReview({}), no("invalid_action"));
  assert.deepEqual(p.parseSpriteReview({ action: "remove", x: 1 }), yes({ action: "remove" }));

  const upload = { userId: "u1", username: "alice", label: "Cat", image: "AAAA" };
  const viewer = { label: "Cat", image: "AAAA", ai: false, userId: "u1", username: "alice", displayName: "" };
  assert.deepEqual(p.parseRoomSpriteSubmit(upload), yes(viewer));
  assert.deepEqual(p.parseRoomSpriteSubmit({ ...upload, username: 5 }), no("invalid_upload"));
  assert.deepEqual(p.parseRoomSpriteSubmit({ ...upload, label: true }), no("invalid_label"));
  assert.deepEqual(p.parseRoomSpriteSubmit({ label: "Cat" }), yes({ ...viewer, image: "", userId: "", username: "" }));
  assert.deepEqual(p.parseRoomSpriteSubmit({ ...upload, x: 1 }), yes(viewer));

  assert.deepEqual(p.parseRoomSpriteAi({ userId: "u1", op: "take" }), yes({ userId: "u1", op: "take" }));
  assert.deepEqual(p.parseRoomSpriteAi({ userId: "u1", op: 5 }), no("invalid_request"));
  assert.deepEqual(p.parseRoomSpriteAi(null), no("invalid_request"));
  assert.deepEqual(p.parseRoomSpriteAi({ userId: "u1", x: 1 }), yes({ userId: "u1", op: "" }));

  const review = { id: "v-x", action: "approve", actorId: "1", actorName: "Mod" };
  assert.deepEqual(p.parseRoomSpriteReview(review), yes(review));
  assert.deepEqual(p.parseRoomSpriteReview({ ...review, id: 5 }), no("invalid_body"));
  assert.deepEqual(p.parseRoomSpriteReview({ ...review, action: 5 }), no("invalid_action"));
  assert.deepEqual(p.parseRoomSpriteReview({ id: "v-x" }), no("invalid_action"), "missing action");
  assert.deepEqual(p.parseRoomSpriteReview({ ...review, x: 1 }), yes(review));
});

// ---------- Outside answers ----------

test("Twitch answer parsers: tokens, validation, users, a Helix page, moderators", async () => {
  const p = await import("../server/parse.ts");
  const TWITCH = no("invalid_twitch_answer");
  const tokens = { access_token: "a1", refresh_token: "r1", expires_in: 3600, scope: ["moderation:read"] };
  assert.deepEqual(p.parseTwitchTokens(tokens), yes(tokens));
  assert.deepEqual(
    Object.keys(p.parseTwitchTokens({ refresh_token: "r1", token_type: "bearer", access_token: "a1" }).value || {}),
    ["refresh_token", "token_type", "access_token"],
    "the answer is kept as sent, key order too (it is sealed as is)",
  );
  assert.deepEqual(p.parseTwitchTokens({ access_token: 5, refresh_token: "r1" }), TWITCH);
  assert.deepEqual(p.parseTwitchTokens({ access_token: "a1" }), TWITCH, "missing refresh_token");
  assert.deepEqual(p.parseTwitchTokens(undefined), TWITCH, "not JSON");

  assert.deepEqual(
    p.parseTwitchValidation({ client_id: "test-app", login: "viewer", user_id: "2", scopes: ["user:read:chat"] }),
    yes({ client_id: "test-app", user_id: "2", scopes: ["user:read:chat"] }),
  );
  assert.deepEqual(
    p.parseTwitchValidation({ client_id: "test-app", scopes: null }),
    yes({ client_id: "test-app", user_id: undefined, scopes: null }),
    "an app token has no user_id; the mismatch check refuses it as before",
  );
  assert.deepEqual(p.parseTwitchValidation({ client_id: "test-app", user_id: 2, scopes: [] }), TWITCH);
  assert.deepEqual(p.parseTwitchValidation({ client_id: "test-app", user_id: "2", scopes: "chat:read" }), TWITCH);
  assert.deepEqual(p.parseTwitchValidation({ client_id: "test-app", user_id: "2", scopes: [5] }), TWITCH);
  assert.deepEqual(p.parseTwitchValidation({ user_id: "2", scopes: [] }), TWITCH, "missing client_id");

  const user = {
    id: "55",
    login: "newstreamer",
    display_name: "NewStreamer",
    created_at: "2020-01-01T00:00:00Z",
    broadcaster_type: "",
  };
  assert.deepEqual(p.parseHelixUsers({ data: [{ ...user, type: "" }], pagination: {} }), yes([user]));
  assert.deepEqual(
    p.parseHelixUsers({ data: [{ id: "1", login: "nesszerra", display_name: "nesszerra" }] }),
    yes([
      { id: "1", login: "nesszerra", display_name: "nesszerra", created_at: undefined, broadcaster_type: undefined },
    ]),
  );
  assert.deepEqual(p.parseHelixUsers({ data: [] }), yes([]));
  assert.deepEqual(p.parseHelixUsers({ data: [{ ...user, id: 55 }] }), TWITCH);
  assert.deepEqual(p.parseHelixUsers({ data: [{ ...user, created_at: 0 }] }), TWITCH);
  assert.deepEqual(p.parseHelixUsers({ data: [5] }), TWITCH);
  assert.deepEqual(p.parseHelixUsers({ data: {} }), TWITCH);
  assert.deepEqual(p.parseHelixUsers({}), TWITCH, "missing data");
  assert.deepEqual(p.parseHelixUsers({ data: [{ id: "55", login: "newstreamer" }] }), TWITCH, "missing display_name");

  assert.deepEqual(p.parseHelixPage({ data: [{ id: "v1" }], pagination: {} }), yes({ data: [{ id: "v1" }] }));
  assert.deepEqual(p.parseHelixPage({ data: "v1" }), TWITCH);
  assert.deepEqual(p.parseHelixPage({ pagination: {} }), TWITCH, "missing data");

  assert.deepEqual(p.parseModerators({ data: [{ user_id: "2", user_login: "viewer" }], pagination: {} }), yes(["2"]));
  assert.deepEqual(p.parseModerators({ data: [] }), yes([]));
  assert.deepEqual(p.parseModerators({ data: [{ user_id: 2 }] }), TWITCH);
  assert.deepEqual(
    p.parseModerators({ data: [{ user_login: "viewer" }] }),
    yes([]),
    "a row without user_id names nobody",
  );
  assert.deepEqual(p.parseModerators({ data: ["viewer"] }), TWITCH, "a row that is not an object");
  assert.deepEqual(p.parseModerators({}), TWITCH, "missing data");
});

test("registry rows: id and login strings, enabledAt a number, the pause and review fields typed when sent; a bad row is skipped by key", async () => {
  const p = await import("../server/parse.ts");
  const REGISTRY = no("invalid_registry");
  const record = {
    id: "9",
    login: "paused_one",
    enabledAt: 1,
    pausedAt: 2,
    pausedBy: "owner",
    review: { reasons: ["young"], at: 3 },
  };
  const good = { key: "channel:streamer_a", value: { id: "100", login: "streamer_a", enabledAt: 1000 } };
  const rows = [{ key: "channel:paused_one", value: record }, good];
  assert.deepEqual(p.parseChannelRows(rows), yes({ rows, skipped: [] }));
  assert.deepEqual(p.parseChannelRows([]), yes({ rows: [], skipped: [] }));
  const one = (value: unknown) => p.parseChannelRows([{ key: "channel:paused_one", value }, good]);
  const skipped = yes({ rows: [good], skipped: ["channel:paused_one"] });
  assert.deepEqual(one({ ...record, enabledAt: "1" }), skipped);
  assert.deepEqual(one({ ...record, id: 9 }), skipped);
  assert.deepEqual(one({ ...record, pausedAt: null }), skipped);
  assert.deepEqual(one({ ...record, pausedBy: "mod" }), skipped);
  assert.deepEqual(one({ ...record, review: { reasons: "young", at: 3 } }), skipped);
  assert.deepEqual(one({ ...record, review: { reasons: ["young"] } }), skipped, "missing review.at");
  assert.deepEqual(one({ id: "9", enabledAt: 1 }), skipped, "missing login");
  assert.deepEqual(one(null), skipped);
  const kept = (value: object) => yes({ rows: [{ key: "channel:paused_one", value }, good], skipped: [] });
  const byBroadcaster = { ...record, pausedBy: "broadcaster" };
  assert.deepEqual(one(byBroadcaster), kept(byBroadcaster));
  const { pausedBy: _, ...pausedNoBy } = record;
  assert.deepEqual(one(pausedNoBy), kept(pausedNoBy), "pausedAt without pausedBy");
  const extra = { ...record, note: "kept" };
  assert.deepEqual(one(extra), kept(extra), "an extra field passes through");
  assert.deepEqual(p.parseChannelRows([{ value: record }, good]), yes({ rows: [good], skipped: ["0"] }), "missing key");
  assert.deepEqual(p.parseChannelRows({ rows }), REGISTRY);
  assert.deepEqual(p.parseChannelRows(undefined), REGISTRY);
});

test("CHANNEL_ORIGINS and upload meta: JSON objects of the right values, else refused", async () => {
  const p = await import("../server/parse.ts");
  const ORIGINS = no("invalid_channel_origins");
  assert.deepEqual(
    p.parseChannelOrigins('{"miolafff":"https://chat.miolaf.xyz/play/"}'),
    yes({ miolafff: "https://chat.miolaf.xyz" }),
  );
  assert.deepEqual(p.parseChannelOrigins("{}"), yes({}));
  assert.deepEqual(p.parseChannelOrigins('["https://chat.miolaf.xyz"]'), ORIGINS);
  assert.deepEqual(p.parseChannelOrigins('{"miolafff":5}'), ORIGINS);
  assert.deepEqual(p.parseChannelOrigins('{"miolafff":["https://chat.miolaf.xyz"]}'), ORIGINS);
  assert.deepEqual(p.parseChannelOrigins('{"miolafff":"chat.miolaf.xyz"}'), ORIGINS, "not a URL");
  assert.deepEqual(p.parseChannelOrigins("null"), ORIGINS);
  assert.deepEqual(p.parseChannelOrigins(""), ORIGINS, "missing");

  const META = no("invalid_upload_meta");
  assert.deepEqual(p.parseUploadMeta('{"label":"Cat","width":32}'), yes({ label: "Cat", width: 32 }));
  assert.deepEqual(p.parseUploadMeta('["a"]'), META);
  assert.deepEqual(p.parseUploadMeta("5"), META);
  assert.deepEqual(p.parseUploadMeta("null"), META);
  assert.deepEqual(p.parseUploadMeta("{"), META);
  assert.deepEqual(p.parseUploadMeta(""), META, "missing");
});

test("backup exports: profiles, purchases and builds as the routes read them", async () => {
  const p = await import("../server/parse.ts");
  const BACKUP = no("invalid_backup");
  const data = {
    format: "mini-chat-export",
    exportedAt: "2026-10-09T09:00:00.000Z",
    profiles: [{ userId: "11", username: "fighter1", elo: 1234 }],
    purchases: [{ userId: "11", itemId: "legend" }],
    builds: [{ userId: "11", slot: 0, data: { title: "legend" } }],
  };
  assert.deepEqual(p.parseBackupExport(JSON.stringify(data)), yes(data));
  const text = (patch: object) => JSON.stringify({ ...data, ...patch });
  assert.deepEqual(p.parseBackupExport(text({ profiles: [{ userId: 11, username: "fighter1" }] })), BACKUP);
  assert.deepEqual(p.parseBackupExport(text({ profiles: [{ userId: "11", username: null }] })), BACKUP);
  assert.deepEqual(p.parseBackupExport(text({ purchases: [{ userId: "11" }, 5] })), BACKUP);
  assert.deepEqual(p.parseBackupExport(text({ builds: {} })), BACKUP);
  assert.deepEqual(p.parseBackupExport(text({ exportedAt: 5 })), BACKUP);
  assert.deepEqual(p.parseBackupExport(text({ builds: undefined })), BACKUP, "missing builds");
  assert.deepEqual(p.parseBackupExport("[]"), BACKUP);
  assert.deepEqual(p.parseBackupExport(""), BACKUP, "not JSON");
});

test("Cloudflare answer parsers: the envelope, Analytics rows, deployments, versions", async () => {
  const p = await import("../server/parse.ts");
  const CF = no("invalid_cloudflare_answer");
  assert.deepEqual(p.parseCfEnvelope({ success: true, errors: [], result: {} }), yes({ success: true, errors: [] }));
  assert.deepEqual(p.parseCfEnvelope({ data: {}, errors: null }), yes({ success: undefined, errors: null }));
  assert.deepEqual(p.parseCfEnvelope({ success: "yes" }), CF);
  assert.deepEqual(p.parseCfEnvelope({ errors: "no access" }), CF);
  assert.deepEqual(p.parseCfEnvelope(undefined), CF, "not JSON");

  const row = {
    sum: { requests: 1200, errors: 3, subrequests: 10 },
    dimensions: { scriptName: "nesszerra-mini-chat" },
  };
  const empty = { sum: null, dimensions: null };
  const analytics = (rows: unknown) => ({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } } });
  assert.deepEqual(p.parseAnalytics(analytics([row, empty])), yes([row, empty]));
  assert.deepEqual(p.parseAnalytics(analytics([{ sum: { requests: "1200" } }])), CF);
  assert.deepEqual(p.parseAnalytics(analytics([{ dimensions: { scriptName: 5 } }])), CF);
  assert.deepEqual(p.parseAnalytics(analytics([null])), CF);
  assert.deepEqual(p.parseAnalytics(analytics(undefined)), CF, "missing rows");
  assert.deepEqual(p.parseAnalytics({ data: { viewer: { accounts: [] } } }), CF, "missing account");
  assert.deepEqual(p.parseAnalytics({ data: null, errors: [{ message: "no access" }] }), CF);

  const deployment = {
    id: "d1",
    created_on: "2026-10-01",
    source: "api",
    versions: [{ version_id: "v2", percentage: 100 }],
    annotations: { "workers/message": "promote #7" },
  };
  assert.deepEqual(p.parseCfDeployments({ success: true, result: { deployments: [deployment] } }), yes([deployment]));
  assert.deepEqual(p.parseCfDeployments({ success: true, result: null }), yes([]), "missing result");
  assert.deepEqual(p.parseCfDeployments({ result: { deployments: [{ ...deployment, versions: "v2" }] } }), CF);
  assert.deepEqual(p.parseCfDeployments({ result: { deployments: [{ ...deployment, annotations: 5 }] } }), CF);
  assert.deepEqual(p.parseCfDeployments({ result: { deployments: {} } }), CF);
  assert.deepEqual(p.parseCfDeployments([]), CF);

  const item = { id: "v2", number: 2, metadata: { created_on: "2026-10-01" }, annotations: { "workers/tag": "t" } };
  assert.deepEqual(p.parseCfVersions({ success: true, result: { items: [item] } }), yes([item]));
  assert.deepEqual(p.parseCfVersions({ success: true }), yes([]), "missing result");
  assert.deepEqual(p.parseCfVersions({ result: { items: [{ ...item, metadata: "2026" }] } }), CF);
  assert.deepEqual(p.parseCfVersions({ result: { items: [5] } }), CF);
  assert.deepEqual(p.parseCfVersions({ result: 5 }), CF);
});

test("GitHub answer parsers: tree, contents, refs, saves, pull requests, runs, merges", async () => {
  const p = await import("../server/parse.ts");
  const GH = no("invalid_github_answer");
  const tree = [{ type: "blob", path: "src/admin.js", size: 1 }];
  assert.deepEqual(p.parseGhTree({ sha: "t", tree, truncated: false }), yes({ tree, truncated: false }));
  assert.deepEqual(p.parseGhTree({ sha: "t" }), yes({ tree: [], truncated: undefined }), "missing tree");
  assert.deepEqual(p.parseGhTree({ tree: {} }), GH);
  assert.deepEqual(p.parseGhTree({ tree: [5] }), GH);
  assert.deepEqual(p.parseGhTree(undefined), GH, "not JSON");

  const sha = "b".repeat(40);
  const file = { type: "file", size: 5, encoding: "base64", content: "aGVsbG8=", sha, name: "a.ts" };
  assert.deepEqual(p.parseGhContent(file), yes({ size: 5, encoding: "base64", content: "aGVsbG8=", sha }));
  assert.deepEqual(p.parseGhContent([{ type: "file", name: "a.ts" }]), yes(null), "a directory");
  assert.deepEqual(p.parseGhContent({ type: "symlink", target: "a.ts" }), yes(null));
  assert.deepEqual(p.parseGhContent({ ...file, size: "5" }), GH);
  assert.deepEqual(p.parseGhContent({ ...file, content: 5 }), GH);
  assert.deepEqual(p.parseGhContent({ type: "file", encoding: "base64" }), GH, "missing size");
  assert.deepEqual(p.parseGhContent(undefined), GH, "not JSON");

  assert.deepEqual(p.parseGhRef({ ref: "refs/heads/main", object: { sha, type: "commit" } }), yes({ sha }));
  assert.deepEqual(p.parseGhRef({ object: { sha: 5 } }), GH);
  assert.deepEqual(p.parseGhRef({ ref: "refs/heads/main" }), GH, "missing object");

  const saved = { content: { sha: "s1", path: "a.ts" }, commit: { sha: "c1" } };
  assert.deepEqual(p.parseGhSaved(saved), yes(saved));
  assert.deepEqual(p.parseGhSaved({}), yes({ content: undefined, commit: undefined }), "missing content and commit");
  assert.deepEqual(p.parseGhSaved({ content: "s1" }), GH);
  assert.deepEqual(p.parseGhSaved(undefined), GH, "not JSON");

  const pr = { number: 7, html_url: "https://github.com/Finesssee/pixfray/pull/7" };
  assert.deepEqual(p.parseGhPulls([{ ...pr, state: "open" }]), yes([pr]));
  assert.deepEqual(p.parseGhPulls([]), yes([]));
  assert.deepEqual(p.parseGhPulls([{ ...pr, number: "7" }]), GH);
  assert.deepEqual(p.parseGhPulls([{ number: 7 }]), GH, "missing html_url");
  assert.deepEqual(p.parseGhPulls({}), GH);
  assert.deepEqual(p.parseGhPr({ ...pr, state: "open" }), yes(pr));
  assert.deepEqual(p.parseGhPr({ ...pr, html_url: 5 }), GH);
  assert.deepEqual(p.parseGhPr({ html_url: pr.html_url }), GH, "missing number");

  const run = { id: 5, status: "completed", conclusion: null, head_branch: "live-fix/a" };
  assert.deepEqual(p.parseGhRuns({ total_count: 1, workflow_runs: [run] }), yes([run]));
  assert.deepEqual(p.parseGhRuns({ total_count: 0 }), yes([]), "missing workflow_runs");
  assert.deepEqual(p.parseGhRuns({ workflow_runs: "x" }), GH);
  assert.deepEqual(p.parseGhRuns({ workflow_runs: [5] }), GH);

  const pull = { number: 7, state: "open", merged: false, base: { ref: "main" }, head: { ref: "live-fix/a", sha } };
  assert.deepEqual(p.parseGhPull(pull), yes(pull));
  assert.deepEqual(p.parseGhPull({ ...pull, head: { ref: 5, sha } }), GH);
  assert.deepEqual(p.parseGhPull({ ...pull, base: "main" }), GH);
  assert.deepEqual(p.parseGhPull({ number: 7, state: "open" }), GH, "missing head");
  assert.deepEqual(p.parseGhPull([]), GH);

  assert.deepEqual(p.parseGhMerge({ sha, merged: true, message: "Pull Request successfully merged" }), yes({ sha }));
  assert.deepEqual(p.parseGhMerge({ sha: 5, merged: true }), GH);
  assert.deepEqual(p.parseGhMerge({ merged: true }), GH, "missing sha");

  assert.deepEqual(p.ignoreAnswer(), yes(null), "dispatch and the branch checks read only the status");
});

// ---------- Harnesses: a real ChannelRoom on node:sqlite, the Worker in front of it ----------

type Answer = { status: number; body: unknown };
const answer = async (r: Response): Promise<Answer> => {
  const raw = await r.text();
  let body: unknown = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    // a text answer (EventSub) stays text
  }
  return { status: r.status, body };
};

function fakeCtx(): DurableObjectState<{}> {
  const db = new DatabaseSync(":memory:");
  const ctx = {
    storage: {
      sql: {
        exec(query: string, ...params: SQLInputValue[]) {
          const rows = db
            .prepare(query)
            .all(...params)
            .map((r) => ({ ...r }));
          return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
        },
      },
      transactionSync<T>(fn: () => T): T {
        return fn();
      },
      async setAlarm() {},
      async getAlarm() {
        return null;
      },
      async deleteAlarm() {},
    },
    acceptWebSocket() {},
    getWebSockets: () => [],
  };
  return ctx as unknown as DurableObjectState<{}>; // the parts of the state ChannelRoom uses, on node:sqlite
}
const roomEnv = { INTERNAL_SECRET: SECRET, DEV_TOOLS_TOKEN: DEV } as unknown as Env; // the bindings a room reads

/** One room, called the way the Worker calls it. */
function room() {
  const r = new ChannelRoom(fakeCtx(), roomEnv);
  return async (path: string, body: unknown, userId?: string): Promise<Answer> => {
    const headers: Record<string, string> = {
      "X-Mini-Internal": SECRET,
      "X-Mini-Channel": "nesszerra",
      "Content-Type": "application/json",
    };
    if (userId) headers["X-Mini-User-Id"] = userId;
    const request = new Request("https://room" + path, { method: "POST", headers, body: JSON.stringify(body) });
    return answer(await r.fetch(request));
  };
}

/** The Worker with an in-memory AuthStore and real rooms. */
function environment(extra: Record<string, unknown> = {}) {
  const entries = new Map<string, unknown>(),
    rooms = new Map<string, ChannelRoom>();
  const env = {
    AUTH_SECRET: "test-only-auth-key",
    INTERNAL_SECRET: SECRET,
    TWITCH_CLIENT_ID: "test-app",
    TWITCH_CLIENT_SECRET: "test-secret",
    AUTH: {
      idFromName: (x: string) => x,
      get: () => ({
        async fetch(url: string, options: RequestInit) {
          const u = new URL(url),
            key = u.searchParams.get("key") || "";
          if (u.pathname === "/list")
            return Response.json(
              [...entries].filter(([k]) => k.startsWith(key)).map(([k, value]) => ({ key: k, value })),
            );
          if (u.pathname === "/consume") {
            const v = entries.get(key) ?? null;
            entries.delete(key);
            return Response.json(v);
          }
          if (options.method === "GET") return Response.json(entries.get(key) ?? null);
          if (options.method === "DELETE") {
            entries.delete(key);
            return Response.json({ ok: true });
          }
          entries.set(key, JSON.parse(String(options.body)).value);
          return Response.json({ ok: true });
        },
      }),
    },
    ROOMS: {
      idFromName: (x: string) => x,
      get: (name: string) => {
        const r = rooms.get(name) ?? new ChannelRoom(fakeCtx(), roomEnv);
        rooms.set(name, r);
        return { fetch: (url: string, init?: RequestInit) => r.fetch(new Request(url, init)) };
      },
    },
    ASSETS: { fetch: async () => Response.json([{ id: "player" }]) },
    ...extra,
  };
  return { env: env as unknown as Env, entries }; // the bindings the Worker reads, stubbed above
}
type Harness = ReturnType<typeof environment>;

async function signedIn(f: Harness, owner: boolean): Promise<string> {
  const cookie = (owner ? "a" : "b").repeat(64),
    user = owner
      ? { id: "1", login: "nesszerra", displayName: "nesszerra" }
      : { id: "2", login: "viewer", displayName: "Viewer" };
  f.entries.set("owner:nesszerra", { id: "1" });
  f.entries.set("session:" + (await digest(cookie)), { user });
  return "mini_session=" + cookie;
}
async function call(f: Harness, path: string, data: unknown, cookie: string): Promise<Answer> {
  const request = new Request(ORIGIN + path, {
    method: "POST",
    headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return answer(await worker.fetch(request, f.env));
}
async function devtool(f: Harness, action: string, data: unknown): Promise<Answer> {
  const request = new Request("https://test.chat.miolaf.xyz/api/devtools/nesszerra/" + action, {
    method: "POST",
    headers: { Authorization: "Bearer " + DEV, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return answer(await worker.fetch(request, f.env));
}

// No test here may reach GitHub, Twitch or Cloudflare: a request that gets past the parser fails loudly instead.
function offline(t: { after: (fn: () => void) => void }): void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) =>
    Response.json({ error: "offline: " + String(input) }, { status: 599 });
  t.after(() => {
    globalThis.fetch = original;
  });
}

// ---------- Room routes ----------

test("room /profile: a base look field of the wrong type is invalid_profile, not a crash or a coerced save", async () => {
  const base = {
    userId: "u1",
    username: "alice",
    displayName: "alice",
    avatar: "player",
    color: "#123456",
    defaultAbility: "strike",
  };
  for (const [field, value] of [
    ["color", ["#AABBCC"]],
    ["hat", []],
    ["hat", 5],
    ["username", 5],
    ["displayName", {}],
    ["avatar", null],
  ] as const) {
    // as const: keeps each field name a literal key of the profile body
    const send = room();
    assert.equal((await send("/profile", base, "u1")).status, 200);
    assert.deepEqual(
      await send("/profile", { ...base, [field]: value }, "u1"),
      { status: 400, body: { error: "invalid_profile" } },
      field + " " + JSON.stringify(value),
    );
  }
});

test("room /admin: an action, payload, actor name or note of the wrong type is invalid_body", async () => {
  const refused = { status: 400, body: { ok: false, reason: "invalid_body", error: "invalid_body" } };
  for (const body of [
    { actorId: "1", action: 5 },
    { actorId: "1", action: "resetRound", payload: [] },
    { actorId: "1", action: "resetRound", actorName: 5 },
    { actorId: "1", action: "resetRound", payload: { note: 5 } },
    { actorId: "1", action: "giftDollars", payload: 5 },
  ])
    assert.deepEqual(await room()("/admin", body), refused, JSON.stringify(body));
});

test("room routes the Worker calls refuse a body of the wrong shape with invalid_body", async () => {
  const refused = { status: 400, body: { error: "invalid_body" } };
  const cases: [string, unknown][] = [
    ["/se-admin", { action: "setSeNames", names: 5 }],
    ["/se-admin", { action: "setDuelModuleOff", value: "yes" }],
    ["/checkin-test", { on: 5 }],
    ["/checkin-test", { on: true, by: 5 }],
    ["/dev-chat", { userId: "7", username: "bob", text: 5 }],
    ["/dev-live", { live: 5 }],
    ["/dev-live", { live: true, streamId: 5 }],
    ["/bot-sent", { results: {} }],
    ["/eventsub", { messageId: "m1", timestamp: 1, messageType: "notification", subscription: 5, event: null }],
    ["/eventsub", { messageId: "m1", timestamp: 1, messageType: "notification", subscription: { id: "s" }, event: 5 }],
  ];
  for (const [path, body] of cases)
    assert.deepEqual(await room()(path, body), refused, path + " " + JSON.stringify(body));
});

test("room /dev/restore and /dev/restored: a body that is not an object is refused before any restore step", async () => {
  for (const body of [null, [], 5]) {
    assert.deepEqual(await room()("/dev/restore", body), {
      status: 400,
      body: { error: "Send {bookmark} or {at}", reason: "invalid_body" },
    });
    assert.deepEqual(await room()("/dev/restored", body), {
      status: 400,
      body: { error: "Send {revision}", reason: "invalid_body" },
    });
  }
});

test("room sprite routes: each field of the wrong type keeps its own reason", async () => {
  const upload = { userId: "u1", username: "alice", label: "Cat", image: PNG };
  const refused = (reason: string, error: string) => ({ status: 400, body: { ok: false, reason, error } });
  assert.deepEqual(
    await room()("/sprites", { ...upload, label: 5 }),
    refused("invalid_label", "Name your sprite (1-24 characters)"),
  );
  assert.deepEqual(await room()("/sprites", { ...upload, image: true }), refused("invalid_image", "Choose an image"));
  assert.deepEqual(
    await room()("/sprites", { ...upload, ai: 5 }),
    refused("invalid_upload", "Send {label, image, ai?}"),
  );
  assert.deepEqual(
    await room()("/sprites", { ...upload, username: 5 }),
    refused("invalid_upload", "Send {label, image, ai?}"),
  );
  assert.deepEqual(
    await room()("/sprites/ai", { userId: "u1", op: 5 }),
    refused("invalid_request", "Send {userId, op}"),
  );
  assert.deepEqual(await room()("/sprites/ai", { userId: 5 }), refused("invalid_request", "Send {userId, op}"));
  const review = { id: "v-x", action: "approve", actorId: "1" };
  assert.deepEqual(await room()("/sprites/review", { ...review, id: 5 }), refused("invalid_body", "Send {id, action}"));
  assert.deepEqual(
    await room()("/sprites/review", { ...review, action: 5 }),
    refused("invalid_action", "Send {id, action}"),
  );
});

// ---------- Worker routes ----------

test("POST /api/admin: an action that is not a non-empty string is invalid_body at the Worker", async (t) => {
  offline(t);
  const f = environment(),
    owner = await signedIn(f, true);
  const refused = { status: 400, body: { ok: false, reason: "invalid_body", error: "invalid_body" } };
  assert.deepEqual(await call(f, "/api/admin/nesszerra", { action: 5 }, owner), refused);
  assert.deepEqual(await call(f, "/api/admin/nesszerra", {}, owner), refused);
  assert.deepEqual(await call(f, "/api/admin/nesszerra", { action: "connectChat", takeover: "yes" }, owner), refused);
  assert.deepEqual(await call(f, "/api/admin/nesszerra", { action: "setDuelModuleOff", value: 1 }, owner), refused);
  assert.deepEqual(await call(f, "/api/admin/nesszerra", { action: "setSeNames", names: [] }, owner), refused);
  // the role check still answers first
  const viewer = await signedIn(f, false);
  assert.equal((await call(f, "/api/admin/nesszerra", { action: 5 }, viewer)).status, 403);
});

test("POST /api/eventsub: a signed body whose subscription or event is not an object is invalid_body", async (t) => {
  offline(t);
  const f = environment();
  const send = async (body: unknown): Promise<Answer> => {
    const raw = JSON.stringify(body),
      id = "msg-" + Math.random().toString(16).slice(2),
      timestamp = new Date().toISOString().replace("Z", "123456Z");
    const request = new Request(ORIGIN + "/api/eventsub", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Twitch-Eventsub-Message-Id": id,
        "Twitch-Eventsub-Message-Timestamp": timestamp,
        "Twitch-Eventsub-Message-Signature": await signEventsub(await eventsubSecret(f.env), id, timestamp, raw),
        "Twitch-Eventsub-Message-Type": "notification",
        "Twitch-Eventsub-Subscription-Type": "channel.chat.message",
        "Twitch-Eventsub-Subscription-Version": "1",
      },
      body: raw,
    });
    return answer(await worker.fetch(request, f.env));
  };
  const event = { broadcaster_user_login: "nesszerra", chatter_user_id: "7", message: { text: "!fight" } };
  assert.deepEqual(await send({ subscription: 5, event }), { status: 400, body: "invalid_body" });
  assert.deepEqual(await send({ subscription: { id: "s", condition: [] }, event }), {
    status: 400,
    body: "invalid_body",
  });
  assert.deepEqual(await send({ subscription: { id: "s" }, event: "hi" }), { status: 400, body: "invalid_body" });
});

test("POST /api/devtools: a wrong-typed account or stream field is invalid_body", async (t) => {
  offline(t);
  const f = environment({ DEV_TOOLS_TOKEN: DEV });
  f.entries.set("owner:nesszerra", { id: "1" });
  const refused = { status: 400, body: { error: "invalid_body" } };
  assert.deepEqual(await devtool(f, "chat", { userId: "t1", username: "testbot_a", text: 5 }), refused);
  assert.deepEqual(await devtool(f, "chat", { userId: 7, username: "testbot_a", text: "!fight" }), refused);
  assert.deepEqual(await devtool(f, "profile", { userId: "t1", username: "testbot_a", displayName: [] }), refused);
  assert.deepEqual(await devtool(f, "live", { live: 5 }), refused);
  assert.deepEqual(await devtool(f, "live", { live: true, streamId: 5 }), refused);
});

test("owner routes: a wrong-typed channel, login, takeover, undo, title or body is invalid_body", async (t) => {
  offline(t);
  const f = environment({ BACKUPS: {}, GITHUB_TOKEN: "test-only-gh-token", GITHUB_REPO: "Finesssee/pixfray" }),
    owner = await signedIn(f, true);
  const refused = (error: string) => ({ status: 400, body: { error, reason: "invalid_body" } });
  const restore = refused("Send {channel, at} or {channel, undo: true}");
  assert.deepEqual(await call(f, "/api/dev/restore", { channel: 5, at: Date.now() - 3600000 }, owner), restore);
  assert.deepEqual(await call(f, "/api/dev/restore", { channel: "nesszerra", undo: "yes" }, owner), restore);
  assert.deepEqual(await call(f, "/api/dev/backups", { channel: 5 }, owner), refused("channel must be a login"));
  assert.deepEqual(
    await call(f, "/api/dev/channels", { action: "pause", login: 5 }, owner),
    refused("login must be a channel login"),
  );
  assert.deepEqual(
    await call(f, "/api/dev/settings", { action: "connectChat", takeover: "yes" }, owner),
    refused("takeover must be true or false"),
  );
  assert.deepEqual(
    await call(f, "/api/dev/code/pr", { branch: "live-fix/a", title: 5 }, owner),
    refused("title and body must be text"),
  );
});

test("sprite uploads: a label, image or ai flag of the wrong type is refused with that field's reason", async (t) => {
  offline(t);
  const f = environment({ AI: {} }),
    viewer = await signedIn(f, false);
  const refused = (reason: string, error: string) => ({ status: 400, body: { ok: false, reason, error } });
  assert.deepEqual(
    await call(f, "/api/sprite/nesszerra", { label: 5, image: PNG }, viewer),
    refused("invalid_label", "Name your sprite (1-24 characters)"),
  );
  assert.deepEqual(
    await call(f, "/api/sprite/nesszerra", { label: "Cat", image: 5 }, viewer),
    refused("invalid_image", "Choose an image"),
  );
  assert.deepEqual(
    await call(f, "/api/sprite/nesszerra", { label: "Cat", image: PNG, ai: "yes" }, viewer),
    refused("invalid_upload", "Send {label, image, ai?}"),
  );
  assert.deepEqual(
    await call(f, "/api/sprite/nesszerra/redraw", { image: 5 }, viewer),
    refused("invalid_image", "Choose an image"),
  );
});

// ---------- Outside answers at the routes ----------

const REAL_FETCH = globalThis.fetch;
/** [method, URL pattern, status, body text] for one outside endpoint. */
type Stub = [method: string, url: RegExp, status: number, text: string | null];
/** fetch answers the first stub that matches and 599 to anything else; the list it returns names every request. */
function upstream(t: { after: (fn: () => void) => void }, stubs: Stub[]): string[] {
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input),
      method = init?.method || "GET";
    calls.push(method + " " + url);
    const hit = stubs.find(([m, pattern]) => m === method && pattern.test(url));
    return hit
      ? new Response(hit[3], { status: hit[2] })
      : Response.json({ error: "offline: " + url }, { status: 599 });
  };
  t.after(() => {
    globalThis.fetch = REAL_FETCH; // not the fetch it replaced: a test may stub fetch more than once
  });
  return calls;
}
const text = (v: unknown) => JSON.stringify(v);
async function getAs(f: Harness, path: string, cookie: string): Promise<Answer> {
  return answer(await worker.fetch(new Request(ORIGIN + path, { headers: { Cookie: cookie } }), f.env));
}

/** Twitch for a sign-in: the viewer's tokens, validation and user, the owner lookup and the past-broadcast list. */
const twitch = (
  patch: { token?: string; validate?: string; users?: string; owner?: string; videos?: string } = {},
): Stub[] => [
  ["POST", /oauth2\/token$/, 200, patch.token ?? text({ access_token: "user-token", refresh_token: "r" })],
  ["GET", /oauth2\/validate$/, 200, patch.validate ?? text({ client_id: "test-app", user_id: "2", scopes: [] })],
  [
    "GET",
    /helix\/users\?login=/,
    200,
    patch.owner ?? text({ data: [{ id: "1", login: "nesszerra", display_name: "nesszerra" }] }),
  ],
  ["GET", /helix\/users$/, 200, patch.users ?? text({ data: [{ id: "2", login: "viewer", display_name: "Viewer" }] })],
  ["GET", /helix\/videos/, 200, patch.videos ?? text({ data: [] })],
];
/** /auth/login, then Twitch's redirect back to /auth/callback with a code. */
async function signIn(f: Harness, query = ""): Promise<Answer & { location: string }> {
  const login = await worker.fetch(new Request(ORIGIN + "/auth/login" + query), f.env);
  const state = new URL(login.headers.get("Location") || "").searchParams.get("state") || "";
  const back = new Request(ORIGIN + "/auth/callback?code=c&state=" + encodeURIComponent(state), {
    headers: { Cookie: "mini_oauth=" + state },
  });
  const r = await worker.fetch(back, f.env);
  return { ...(await answer(r)), location: r.headers.get("Location") || "" };
}

test("sign-in: a Twitch answer of the wrong shape gets the existing upstream error", async (t) => {
  const f = environment();
  const failed = (error: string) => ({ status: 502, body: { error }, location: "" });
  const run = async (patch: Parameters<typeof twitch>[0]) => {
    const calls = upstream(t, twitch(patch));
    const r = await signIn(f);
    return { r, calls };
  };
  assert.equal((await run({})).r.status, 303, "the stubs sign a viewer in");
  // Helix /users without data
  assert.deepEqual((await run({ users: text({}) })).r, failed("Twitch identity validation failed"));
  assert.deepEqual((await run({ token: "<html>" })).r, failed("Twitch token exchange failed"));
  assert.deepEqual(
    (await run({ token: text({ refresh_token: "r" }) })).r,
    failed("Twitch token exchange failed"),
    "missing access_token",
  );
  assert.deepEqual((await run({ validate: "<html>" })).r, failed("Twitch identity validation failed"));
  assert.deepEqual(
    (await run({ validate: text({ client_id: "test-app", user_id: 2, scopes: [] }) })).r,
    failed("Twitch identity validation failed"),
  );
  // The owner lookup only feeds the stored owner id; an unreadable one signs the viewer in like a failed one.
  const owner = await run({ owner: "<html>" });
  assert.equal(owner.r.status, 303);
  assert.equal(owner.r.location, "/?channel=nesszerra&signed_in=1");
});

test("sign-up: an unreadable past-broadcast list makes the streamer check say unchecked", async (t) => {
  const f = environment();
  upstream(
    t,
    twitch({
      validate: text({ client_id: "test-app", user_id: "55", scopes: ["moderation:read"] }),
      users: text({
        data: [
          {
            id: "55",
            login: "newstreamer",
            display_name: "NewStreamer",
            created_at: "2020-01-01T00:00:00Z",
            broadcaster_type: "",
          },
        ],
      }),
      videos: text({}),
    }),
  );
  const r = await signIn(f, "?signup=1");
  assert.equal(r.location, "/start/?error=review");
  const saved = f.entries.get("channel:newstreamer");
  assert.ok(typeof saved === "object" && saved !== null && "review" in saved);
  assert.ok(typeof saved.review === "object" && saved.review !== null && "reasons" in saved.review);
  assert.deepEqual(saved.review.reasons, ["unchecked"]);
});

test("moderator check: a Twitch answer of the wrong shape refuses with access()'s existing errors", async (t) => {
  const MOD = { id: "2", login: "viewer", displayName: "V" };
  const setup = async (validatedAt: number) => {
    const f = environment();
    f.entries.set("owner:nesszerra", { id: "1" });
    f.entries.set(
      "broadcaster:nesszerra",
      await seal(f.env, { access_token: "a1", refresh_token: "r1", userId: "1", validatedAt }),
    );
    return f;
  };
  let f = await setup(Date.now());
  upstream(t, [["GET", /moderation\/moderators/, 200, text({ pagination: {} })]]);
  await assert.rejects(access(f.env, MOD, "nesszerra"), { message: "Current moderator role cannot be verified" });
  assert.equal(f.entries.has("mod:nesszerra:2"), false, "nothing is cached");

  f = await setup(0);
  upstream(t, [
    ["GET", /oauth2\/validate$/, 401, text({ status: 401 })],
    ["POST", /oauth2\/token$/, 200, text({ access_token: "a2" })],
  ]);
  await assert.rejects(access(f.env, MOD, "nesszerra"), { message: "Broadcaster must reconnect Twitch" });

  f = await setup(0);
  upstream(t, [
    ["GET", /oauth2\/validate$/, 200, text({ client_id: "test-app", user_id: "1", scopes: "moderation:read" })],
    ["GET", /moderation\/moderators/, 200, text({ data: [{ user_id: "2" }] })],
  ]);
  await assert.rejects(access(f.env, MOD, "nesszerra"), { message: "Twitch authorization unavailable" });
});

test("registry: a channel record of the wrong shape is left out and logged, and the other channels still list", async (t) => {
  offline(t);
  const warn = t.mock.method(console, "warn", () => {});
  const f = environment(),
    owner = await signedIn(f, true);
  f.entries.set("channel:streamer_a", { id: "100", login: "streamer_a", enabledAt: "1000" });
  f.entries.set("channel:streamer_b", { id: "200", login: "streamer_b", enabledAt: 2000 });
  assert.deepEqual(await listRecords(f.env, "channel:"), [
    { key: "channel:streamer_b", value: { id: "200", login: "streamer_b", enabledAt: 2000 } },
  ]);
  assert.deepEqual(warn.mock.calls.at(-1)?.arguments, ["registry records skipped", "channel:streamer_a"]);
  const list = await getAs(f, "/api/dev/channels", owner);
  assert.equal(list.status, 200);
  assert.deepEqual(
    (list.body as { channels: { login: string }[] }).channels.map((c) => c.login),
    ["streamer_b"],
  );
});

test("CHANNEL_ORIGINS: anything but an object of URLs is no channel domains", () => {
  assert.deepEqual(channelOrigins({ CHANNEL_ORIGINS: '["https://chat.miolaf.xyz"]' }), {});
  assert.deepEqual(channelOrigins({ CHANNEL_ORIGINS: '{"miolafff":"https://chat.miolaf.xyz/play/"}' }), {
    miolafff: "https://chat.miolaf.xyz",
  });
});

test("custom character catalog: stored meta that is not an object adds no fields", async () => {
  const ctx = fakeCtx(),
    sql = ctx.storage.sql;
  ensureUploadSchema(sql);
  const insert =
    "INSERT INTO custom_characters (id, meta, atlas, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)";
  sql.exec(insert, "c-a", '["a"]', new Uint8Array([1]), 1, "1", 1);
  sql.exec(insert, "c-b", '{"label":"Cat"}', new Uint8Array([1]), 1, "1", 2);
  const r = await handleRoomAssets({ ctx }, new Request("https://room/catalog"), {
    path: "/catalog",
    channel: "nesszerra",
  });
  assert.deepEqual(await r.json(), [
    { id: "c-a", url: "/api/assets/nesszerra/c-a", custom: true },
    { label: "Cat", id: "c-b", url: "/api/assets/nesszerra/c-b", custom: true },
  ]);
});

test("daily backups: a stored export of the wrong shape is unreadable, and the backups route's upstream error", async (t) => {
  offline(t);
  const fakeD1 = (row: unknown) =>
    // the two calls readBackup makes on D1, answering one stored row
    ({ prepare: () => ({ run: async () => ({}), bind: () => ({ first: async () => row }) }) }) as unknown as D1Database;
  const packed = (v: unknown) => ({ data: [...gzipSync(JSON.stringify(v))] });
  const good = {
    format: "mini-chat-export",
    exportedAt: "2026-10-09T09:00:00.000Z",
    profiles: [{ userId: "11", username: "fighter1" }],
    purchases: [],
    builds: [],
  };
  const bad = { ...good, profiles: [{ userId: 11, username: "fighter1" }] };
  assert.deepEqual(await readBackup(fakeD1(packed(good)), "nesszerra", "2026-10-09"), yes(good));
  assert.deepEqual(await readBackup(fakeD1(packed(bad)), "nesszerra", "2026-10-09"), no("invalid_backup"));
  assert.deepEqual(await readBackup(fakeD1({ data: [1, 2, 3] }), "nesszerra", "2026-10-09"), no("invalid_backup"));
  assert.equal(await readBackup(fakeD1(null), "nesszerra", "2026-10-09"), null);

  const f = environment({ BACKUPS: fakeD1(packed(bad)) }),
    owner = await signedIn(f, true);
  assert.deepEqual(await getAs(f, "/api/dev/backups?channel=nesszerra&day=2026-10-09", owner), {
    status: 503,
    body: { error: "Service unavailable; check owner diagnostics", reason: "upstream_error" },
  });
});

test("GitHub: an ok answer of the wrong shape gets the route's GitHub error", async (t) => {
  const f = environment({ GITHUB_TOKEN: "test-only-gh-token", GITHUB_REPO: "Finesssee/pixfray" }),
    owner = await signedIn(f, true);
  const unreadable = (what: string) => ({
    status: 502,
    body: { error: what + ": GitHub 200 unreadable answer", reason: "github_error", githubStatus: 200 },
  });
  upstream(t, [["GET", /\/runs\?per_page=10$/, 200, "<html>"]]);
  assert.deepEqual(await getAs(f, "/api/dev/runs", owner), unreadable("List workflow runs"));
  upstream(t, [["GET", /\/git\/trees\/main\?recursive=1$/, 200, "<html>"]]);
  assert.deepEqual(await getAs(f, "/api/dev/code/tree", owner), unreadable("Read tree"));
  upstream(t, [["GET", /\/contents\/src\/admin\.js\?ref=main$/, 200, "<html>"]]);
  assert.deepEqual(await getAs(f, "/api/dev/code/file?path=src/admin.js", owner), unreadable("Read file"));

  // A hotfix whose pull request answer is unreadable is still deployed, and says to open the pull request by hand.
  upstream(t, [
    ["POST", /\/dispatches$/, 204, null],
    ["GET", /\/pulls\?state=open/, 200, "[]"],
    ["POST", /\/pulls$/, 201, "<html>"],
  ]);
  const hot = await call(f, "/api/dev/hotfix", { branch: "hotfix/a" }, owner);
  assert.equal(hot.status, 202);
  assert.ok(typeof hot.body === "object" && hot.body !== null && "pr" in hot.body && "prError" in hot.body);
  assert.equal(hot.body.pr, null);
  assert.equal(hot.body.prError, "Pull request not opened; open it manually");

  // A merge answer without the merged sha stops before production is deployed.
  const calls = upstream(t, [
    [
      "GET",
      /\/pulls\/7$/,
      200,
      text({
        number: 7,
        state: "open",
        merged: false,
        base: { ref: "main" },
        head: { ref: "live-fix/a", sha: "b".repeat(40) },
      }),
    ],
    ["PUT", /\/pulls\/7\/merge$/, 200, text({ merged: true, message: "Pull Request successfully merged" })],
    ["POST", /\/dispatches$/, 204, null],
  ]);
  assert.deepEqual(
    await call(f, "/api/dev/promote", { number: 7 }, owner),
    unreadable("Merge pull request (it may have merged; check GitHub)"),
  );
  assert.equal(calls.filter((x) => x.endsWith("/dispatches")).length, 0, "nothing dispatched");
});

test("Cloudflare: an unreadable deployments answer is that script's API error", async (t) => {
  const f = environment({ CF_API_TOKEN: "test-only-cf", CF_ACCOUNT_ID: "a".repeat(32) }),
    owner = await signedIn(f, true);
  upstream(t, [
    ["GET", /\/deployments$/, 200, "<html>"],
    ["GET", /\/versions$/, 200, text({ success: true, errors: [], result: { items: [] } })],
  ]);
  const failed = (script: string) => ({ script, deployments: [], versions: [], error: "Cloudflare API error 200" });
  assert.deepEqual(await getAs(f, "/api/dev/versions", owner), {
    status: 200,
    body: { production: failed("nesszerra-mini-chat"), test: failed("nesszerra-mini-chat-test") },
  });
});

test("request usage: an Analytics row of the wrong shape is a failed query", async (t) => {
  upstream(t, [
    [
      "POST",
      /\/graphql$/,
      200,
      text({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [null] }] } }, errors: null }),
    ],
  ]);
  const env = { CF_API_TOKEN: "x", CF_ACCOUNT_ID: "a".repeat(32) } as unknown as Env; // the two keys usage() reads
  assert.deepEqual(await usage(env, Date.parse("2026-10-01T15:30:00Z")), {
    limit: 100000,
    since: "2026-10-01T00:00:00.000Z",
    resetsAt: "2026-10-02T00:00:00.000Z",
    configured: true,
    error: "Analytics query failed",
    status: 200,
  });
});
