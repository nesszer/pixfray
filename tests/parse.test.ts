// Parsing at the boundary (server/parse.ts): each parser on its own, then the routes whose answer changed when a body
// of the wrong shape began to get a 400 at the edge instead of a crash or a silent default (docs/CONTRACTS.md §2, §4),
// and the routes whose answer changed when an outside answer (Twitch, AuthStore's registry, GitHub, Cloudflare, a
// stored backup, upload meta or CHANNEL_ORIGINS) of the wrong shape began to get that route's upstream error.
import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import * as p from "../server/parse.ts";
import worker from "../server/worker.ts";
import { access, seal } from "../server/auth.ts";
import { readBackup } from "../server/backups.ts";
import { ChannelRoom } from "../server/channel.ts";
import { listRecords } from "../server/channels.ts";
import { usage } from "../server/developer.ts";
import { eventsubSecret, signEventsub } from "../server/eventsub.ts";
import { channelOrigins } from "../server/hosts.ts";
import { ensureUploadSchema, handleRoomAssets } from "../server/uploads.ts";
import { asEnv, fakeCtx, fakeSql, type Loose } from "./fakes.ts";
import { INTERNAL, SECRETS, call, memoryAuth, namespace, realRooms, req, roomCall, signedIn } from "./worker-fakes.ts";

const DEV = "dev-token-for-tests-0123456789abcdefghij";
/** A 1x1 PNG. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// ---------- Parsers ----------

const yes = (value: unknown) => ({ ok: true, value });
const no = (error: string) => ({ ok: false, error });
/** Each input parses to its value. */
function accepts<T>(parse: (input: T) => unknown, cases: [input: T, value: unknown, note?: string][]) {
  for (const [input, value, note] of cases) assert.deepEqual(parse(input), yes(value), note ?? JSON.stringify(input));
}
/** Each input is refused with `error`. */
function refuses<T>(parse: (input: T) => unknown, error: string, inputs: T[]) {
  for (const input of inputs) assert.deepEqual(parse(input), no(error), JSON.stringify(input));
}
/** Each input parses to itself. */
function keeps<T>(parse: (input: T) => unknown, inputs: T[]) {
  accepts(
    parse,
    inputs.map((input): [T, unknown] => [input, input]),
  );
}

test("admin parsers: action a string, payload an object, switches booleans, the actor name a string", () => {
  const body = { action: "resetRound", payload: { note: "fresh round" } };
  // Older pages send the action's fields at the top level: the body is the payload, extra fields ride along.
  const flat = { action: "giftDollars", userId: "7", amount: 5 };
  const parsed = { takeover: false, value: false, names: {} };
  accepts(p.parseAdminBody, [
    [body, { action: "resetRound", payload: { note: "fresh round" }, ...parsed, fields: body }],
    [flat, { action: "giftDollars", payload: flat, ...parsed, fields: flat }, "fields at the top level"],
  ]);
  refuses(p.parseAdminBody, "invalid_body", [
    { action: 5 },
    { action: "resetRound", payload: [] },
    { action: "connectChat", takeover: "yes" },
    { action: "resetRound", payload: { note: 5 } },
    {},
    { action: "setDuelModuleOff" },
    { action: "setSeNames", names: "x" },
  ]);

  const room = { actorId: "1", actorName: "Mod", action: "setDuelModuleOff", value: true };
  const extra = { action: "resetRound", extra: [1] };
  accepts(p.parseRoomAdminBody, [
    [room, { action: "setDuelModuleOff", payload: room, ...parsed, value: true, fields: room, actorName: "Mod" }],
    [extra, { action: "resetRound", payload: extra, ...parsed, fields: extra, actorName: "" }, "extra field kept"],
  ]);
  refuses(p.parseRoomAdminBody, "invalid_body", [{ action: "resetRound", actorName: 5 }, { actorName: "Mod" }]);
});

test("profile parsers: the room's base look strings, the Worker's look checks", () => {
  const base = { username: "alice", color: "#123456", defaultAbility: "strike" };
  const unset = { displayName: undefined, avatar: undefined, hat: undefined, pet: undefined };
  accepts(p.parseProfileInput, [
    [
      { ...base, hat: "crown" },
      { ...base, ...unset, hat: "crown" },
    ],
    [{ ...base, stats: { power: 1 } }, { ...base, ...unset, stats: { power: 1 } }, "stats checked in saveProfile"],
  ]);
  refuses(p.parseProfileInput, "invalid_profile", [
    { ...base, color: ["#AABBCC"] },
    { ...base, hat: [] },
    { ...base, displayName: 5 },
    { color: "#123456", defaultAbility: "strike" },
  ]);

  const look = { avatar: "player", color: "#aabbcc", defaultAbility: "heal" };
  const plain = { ...look, stats: undefined, hat: undefined, pet: undefined, loadout: {} };
  accepts(p.parseProfileSave, [
    [look, plain],
    [
      { ...look, build: 0 },
      { ...plain, loadout: { build: 0 } },
    ],
    [{ ...look, sparkle: true }, plain, "extra field ignored"],
  ]);
  refuses(p.parseProfileSave, "invalid_fields", [
    { ...look, hat: 5 },
    { ...look, defaultAbility: "kick" },
    { avatar: "player", defaultAbility: "heal" },
  ]);
});

test("shop and dev-tool parsers", () => {
  keeps(p.parseShopBuy, [{ kind: "hat", id: "crown", price: 5 }]);
  accepts(p.parseShopBuy, [
    [
      { kind: "slot", note: "x" },
      { kind: "slot", id: "", price: undefined },
    ],
    [
      { kind: "reroll", id: "dragon" },
      { kind: "reroll", id: "dragon", price: undefined },
    ],
  ]);
  refuses(p.parseShopBuy, "invalid_item", [
    { kind: "hat", id: "crown", price: "5" },
    { kind: "hat", id: 5 },
    { id: "crown" },
  ]);

  for (const parse of [p.parseDevLive, p.parseRoomDevLive]) {
    keeps(parse, [{ live: true, streamId: "s1" }]);
    accepts(parse, [
      [{ live: false }, { live: false, streamId: "" }],
      [{}, { live: null, streamId: "" }],
      [
        { live: null, x: 1 },
        { live: null, streamId: "" },
      ],
    ]);
    refuses(parse, "invalid_body", [{ live: 5 }, { live: "yes" }, { live: false, streamId: 5 }]);
  }

  const account = { userId: "t1", username: "testbot_a", displayName: "Bot A", text: "!fight" };
  keeps(p.parseDevAccount, [account]);
  accepts(p.parseDevAccount, [
    [{}, { userId: "", username: "", displayName: "", text: "" }, "the ids default to blank"],
    [{ ...account, pet: "fox" }, account],
  ]);
  refuses(p.parseDevAccount, "invalid_body", [
    { ...account, text: 5 },
    { ...account, userId: 7 },
  ]);
});

test("room route parsers: se-admin, check-in test, bot-sent, dev chat", () => {
  accepts(p.parseSeAdmin, [
    [
      { action: "setSeNames", names: { fight: "!f" } },
      { action: "setSeNames", names: { fight: "!f" }, value: false },
    ],
    [
      { action: "rotateSeKey", x: 1 },
      { action: "rotateSeKey", names: {}, value: false },
    ],
  ]);
  refuses(p.parseSeAdmin, "invalid_body", [{ action: "setSeNames", names: 5 }, { action: "setDuelModuleOff" }]);

  keeps(p.parseCheckinTest, [{ on: true, by: "Mod" }]);
  accepts(p.parseCheckinTest, [
    [
      { on: false, x: 1 },
      { on: false, by: "" },
    ],
  ]);
  refuses(p.parseCheckinTest, "invalid_body", [{ on: "yes" }, { on: true, by: 5 }, {}]);

  accepts(p.parseBotSent, [
    [
      { results: [{ sent: true }, { sent: false, reason: "msg_duplicate" }, "x"] },
      { results: [{ sent: true, reason: "" }, { sent: false, reason: "msg_duplicate" }, null] },
    ],
    [{ results: [], x: 1 }, { results: [] }],
  ]);
  refuses(p.parseBotSent, "invalid_body", [{ results: {} }, {}]);

  const line = { userId: "7", username: "bob", displayName: "Bob", text: "!fight" };
  keeps(p.parseDevChat, [line]);
  accepts(p.parseDevChat, [
    [
      { userId: "7", username: "bob", x: 1 },
      { ...line, displayName: "", text: "" },
    ],
  ]);
  refuses(p.parseDevChat, "invalid_body", [
    { ...line, text: 5 },
    { username: "bob", text: "hi" },
    { userId: "7", text: "hi" },
    {},
  ]);
});

test("EventSub parsers: the Worker's envelope, the room's message and its chat event", () => {
  const envelope = { subscription: { id: "s", condition: { user_id: "9" } }, event: { message_id: "m" } };
  const parsed = { ...envelope, condition: { user_id: "9" }, challenge: undefined };
  accepts(p.parseEventsubEnvelope, [
    [envelope, parsed],
    [{ ...envelope, extra: 1 }, parsed, "extra field ignored"],
    [
      { challenge: "abc", subscription: null },
      { subscription: {}, condition: {}, event: null, challenge: "abc" },
      "missing and null fields count as absent",
    ],
  ]);
  refuses(p.parseEventsubEnvelope, "invalid_body", [
    { subscription: 5 },
    { subscription: { condition: [] } },
    { event: "x" },
  ]);
  refuses(p.parseEventsubEnvelope, "Invalid JSON", [[1]]);

  const event = { chatter_user_id: "7", message: { text: "!fight" }, mod: true };
  keeps(p.parseChatEvent, [event, undefined]);
  accepts(p.parseChatEvent, [
    [null, undefined],
    [{ chatter_user_id: "7", badges: [] }, { chatter_user_id: "7" }],
  ]);
  refuses(p.parseChatEvent, "invalid_body", [{ message: { text: 5 } }, { chatter_user_id: 7 }, { mod: "yes" }]);

  const message = {
    messageId: "m1",
    timestamp: 1,
    messageType: "notification",
    subscription: { id: "s" },
    event: null,
  };
  accepts(p.parseRoomEventsub, [
    [message, { ...message, event: undefined }],
    [{}, { subscription: undefined, event: undefined }],
    [{ timestamp: 1 }, { timestamp: 1, subscription: undefined, event: undefined }],
  ]);
  refuses(p.parseRoomEventsub, "invalid_body", [{ subscription: 5 }, { event: 5 }]);
});

test("owner route parsers: channels, restore, backups, settings, code PR and the room's restore steps", () => {
  keeps(p.parseChannelsAction, [{ action: "pause", login: "x" }]);
  accepts(p.parseChannelsAction, [
    [{ action: "pause" }, { action: "pause", login: "" }],
    [
      { action: "x", y: 1 },
      { action: "x", login: "" },
    ],
  ]);
  refuses(p.parseChannelsAction, "invalid_body", [{ action: "pause", login: 5 }]);

  accepts(p.parseRestore, [
    [
      { channel: "a", at: 5 },
      { channel: "a", at: 5, undo: false },
    ],
    [{ undo: true }, { channel: "", at: Number.NaN, undo: true }],
    [
      { channel: "a", at: "1700000000000" },
      { channel: "a", at: 1700000000000, undo: false },
      "at goes through Number()",
    ],
    [
      { channel: "a", at: "yesterday", x: 1 },
      { channel: "a", at: Number.NaN, undo: false },
      "a time that is not a number reaches the window check",
    ],
  ]);
  refuses(p.parseRestore, "invalid_body", [
    { channel: 5, at: 5 },
    { channel: "a", undo: "yes" },
  ]);

  keeps(p.parseBackupsRun, [{ channel: "a" }]);
  accepts(p.parseBackupsRun, [[{ x: 1 }, { channel: "" }]]);
  refuses(p.parseBackupsRun, "invalid_body", [{ channel: 5 }]);

  accepts(p.parseSettings, [
    [
      { action: "connectChat", takeover: true },
      { action: "connectChat", payload: undefined, takeover: true },
    ],
    [{ x: 1 }, { action: undefined, payload: undefined, takeover: false }],
  ]);
  refuses(p.parseSettings, "invalid_body", [{ action: "connectChat", takeover: 1 }]);

  accepts(p.parseCodePr, [
    [
      { branch: "live-fix/a", title: "T", body: "B" },
      { branch: "live-fix/a", title: "T", text: "B" },
    ],
    [{ x: 1 }, { branch: undefined, title: "", text: "" }],
  ]);
  refuses(p.parseCodePr, "invalid_body", [
    { branch: "live-fix/a", title: 5 },
    { branch: "live-fix/a", body: [] },
  ]);

  accepts(p.parseRoomRestore, [
    [{ bookmark: "b" }, { bookmark: "b", at: Number.NaN }],
    [{ at: 5 }, { bookmark: "", at: 5 }],
    [{ at: "5" }, { bookmark: "", at: 5 }, "at goes through Number() as on main"],
    [
      { at: 5, x: 1 },
      { bookmark: "", at: 5 },
    ],
  ]);
  refuses(p.parseRoomRestore, "invalid_body", [{ bookmark: 5 }, null]);

  keeps(p.parseRoomRestored, [{ revision: 4 }]);
  accepts(p.parseRoomRestored, [[{ x: 1 }, { revision: 0 }, "revision defaults to 0"]]);
  refuses(p.parseRoomRestored, "invalid_body", [{ revision: "4" }, []]);
});

test("sprite parsers: uploads, redraws, reviews and the room's sprite routes", () => {
  keeps(p.parseSpriteSubmit, [{ label: "Cat", image: "AAAA", ai: true }]);
  accepts(p.parseSpriteSubmit, [
    [{}, { label: "", image: "", ai: false }, "validateSprite refuses the blanks"],
    [
      { label: "Cat", image: "AAAA", userId: "1" },
      { label: "Cat", image: "AAAA", ai: false },
    ],
  ]);
  refuses(p.parseSpriteSubmit, "invalid_label", [{ label: 5, image: "AAAA" }]);
  refuses(p.parseSpriteSubmit, "invalid_image", [{ label: "Cat", image: {} }]);
  refuses(p.parseSpriteSubmit, "invalid_upload", [{ label: "Cat", ai: "yes" }]);

  keeps(p.parseRedraw, [{ image: "AAAA" }]);
  accepts(p.parseRedraw, [[{ x: 1 }, { image: "" }]]);
  refuses(p.parseRedraw, "invalid_image", [{ image: 5 }]);

  keeps(p.parseSpriteReview, [{ action: "approve" }]);
  accepts(p.parseSpriteReview, [[{ action: "remove", x: 1 }, { action: "remove" }]]);
  refuses(p.parseSpriteReview, "invalid_action", [{ action: 5 }, {}]);

  const upload = { userId: "u1", username: "alice", label: "Cat", image: "AAAA" };
  const viewer = { label: "Cat", image: "AAAA", ai: false, userId: "u1", username: "alice", displayName: "" };
  accepts(p.parseRoomSpriteSubmit, [
    [upload, viewer],
    [{ label: "Cat" }, { ...viewer, image: "", userId: "", username: "" }],
    [{ ...upload, x: 1 }, viewer],
  ]);
  refuses(p.parseRoomSpriteSubmit, "invalid_upload", [{ ...upload, username: 5 }]);
  refuses(p.parseRoomSpriteSubmit, "invalid_label", [{ ...upload, label: true }]);

  keeps(p.parseRoomSpriteAi, [{ userId: "u1", op: "take" }]);
  accepts(p.parseRoomSpriteAi, [
    [
      { userId: "u1", x: 1 },
      { userId: "u1", op: "" },
    ],
  ]);
  refuses(p.parseRoomSpriteAi, "invalid_request", [{ userId: "u1", op: 5 }, null]);

  const review = { id: "v-x", action: "approve", actorId: "1", actorName: "Mod" };
  keeps(p.parseRoomSpriteReview, [review]);
  accepts(p.parseRoomSpriteReview, [[{ ...review, x: 1 }, review]]);
  refuses(p.parseRoomSpriteReview, "invalid_body", [{ ...review, id: 5 }]);
  refuses(p.parseRoomSpriteReview, "invalid_action", [{ ...review, action: 5 }, { id: "v-x" }]);
});

// ---------- Outside answers ----------

test("Twitch answer parsers: tokens, validation, users, a Helix page, moderators", () => {
  const TWITCH = "invalid_twitch_answer";
  const tokens = { access_token: "a1", refresh_token: "r1", expires_in: 3600, scope: ["moderation:read"] };
  keeps(p.parseTwitchTokens, [tokens]);
  assert.deepEqual(
    Object.keys(p.parseTwitchTokens({ refresh_token: "r1", token_type: "bearer", access_token: "a1" }).value || {}),
    ["refresh_token", "token_type", "access_token"],
    "the answer is kept as sent, key order too (it is sealed as is)",
  );
  refuses(p.parseTwitchTokens, TWITCH, [{ access_token: 5, refresh_token: "r1" }, { access_token: "a1" }, undefined]);

  accepts(p.parseTwitchValidation, [
    [
      { client_id: "test-app", login: "viewer", user_id: "2", scopes: ["user:read:chat"] },
      { client_id: "test-app", user_id: "2", scopes: ["user:read:chat"] },
    ],
    [
      { client_id: "test-app", scopes: null },
      { client_id: "test-app", user_id: undefined, scopes: null },
      "an app token has no user_id; the mismatch check refuses it as before",
    ],
  ]);
  refuses(p.parseTwitchValidation, TWITCH, [
    { client_id: "test-app", user_id: 2, scopes: [] },
    { client_id: "test-app", user_id: "2", scopes: "chat:read" },
    { client_id: "test-app", user_id: "2", scopes: [5] },
    { user_id: "2", scopes: [] },
  ]);

  const user = {
    id: "55",
    login: "newstreamer",
    display_name: "NewStreamer",
    created_at: "2020-01-01T00:00:00Z",
    broadcaster_type: "",
  };
  const bare = { id: "1", login: "nesszerra", display_name: "nesszerra" };
  accepts(p.parseHelixUsers, [
    [{ data: [{ ...user, type: "" }], pagination: {} }, [user]],
    [{ data: [bare] }, [{ ...bare, created_at: undefined, broadcaster_type: undefined }]],
    [{ data: [] }, []],
  ]);
  refuses(p.parseHelixUsers, TWITCH, [
    { data: [{ ...user, id: 55 }] },
    { data: [{ ...user, created_at: 0 }] },
    { data: [5] },
    { data: {} },
    {},
    { data: [{ id: "55", login: "newstreamer" }] },
  ]);

  accepts(p.parseHelixPage, [[{ data: [{ id: "v1" }], pagination: {} }, { data: [{ id: "v1" }] }]]);
  refuses(p.parseHelixPage, TWITCH, [{ data: "v1" }, { pagination: {} }]);

  accepts(p.parseModerators, [
    [{ data: [{ user_id: "2", user_login: "viewer" }], pagination: {} }, ["2"]],
    [{ data: [] }, []],
    [{ data: [{ user_login: "viewer" }] }, [], "a row without user_id names nobody"],
  ]);
  refuses(p.parseModerators, TWITCH, [{ data: [{ user_id: 2 }] }, { data: ["viewer"] }, {}]);
});

test("registry rows: id and login strings, enabledAt a number, the pause and review fields typed when sent; a bad row is skipped by key", () => {
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
  accepts(p.parseChannelRows, [
    [rows, { rows, skipped: [] }],
    [[], { rows: [], skipped: [] }],
    [[{ value: record }, good], { rows: [good], skipped: ["0"] }, "missing key"],
  ]);
  const one = (value: unknown) => p.parseChannelRows([{ key: "channel:paused_one", value }, good]);
  for (const value of [
    { ...record, enabledAt: "1" },
    { ...record, id: 9 },
    { ...record, pausedAt: null },
    { ...record, pausedBy: "mod" },
    { ...record, review: { reasons: "young", at: 3 } },
    { ...record, review: { reasons: ["young"] } },
    { id: "9", enabledAt: 1 },
    null,
  ])
    assert.deepEqual(one(value), yes({ rows: [good], skipped: ["channel:paused_one"] }), JSON.stringify(value));
  const { pausedBy: _, ...pausedNoBy } = record;
  for (const value of [{ ...record, pausedBy: "broadcaster" }, pausedNoBy, { ...record, note: "kept" }])
    assert.deepEqual(one(value), yes({ rows: [{ key: "channel:paused_one", value }, good], skipped: [] }));
  refuses(p.parseChannelRows, "invalid_registry", [{ rows }, undefined]);
});

test("CHANNEL_ORIGINS, upload meta and backup exports: JSON of the right values, else refused", () => {
  accepts(p.parseChannelOrigins, [
    ['{"miolafff":"https://chat.miolaf.xyz/play/"}', { miolafff: "https://chat.miolaf.xyz" }],
    ["{}", {}],
  ]);
  refuses(p.parseChannelOrigins, "invalid_channel_origins", [
    '["https://chat.miolaf.xyz"]',
    '{"miolafff":5}',
    '{"miolafff":["https://chat.miolaf.xyz"]}',
    '{"miolafff":"chat.miolaf.xyz"}',
    "null",
    "",
  ]);

  accepts(p.parseUploadMeta, [['{"label":"Cat","width":32}', { label: "Cat", width: 32 }]]);
  refuses(p.parseUploadMeta, "invalid_upload_meta", ['["a"]', "5", "null", "{", ""]);

  const data = {
    format: "mini-chat-export",
    exportedAt: "2026-10-09T09:00:00.000Z",
    profiles: [{ userId: "11", username: "fighter1", elo: 1234 }],
    purchases: [{ userId: "11", itemId: "legend" }],
    builds: [{ userId: "11", slot: 0, data: { title: "legend" } }],
  };
  const text = (patch: object) => JSON.stringify({ ...data, ...patch });
  accepts(p.parseBackupExport, [[JSON.stringify(data), data]]);
  refuses(p.parseBackupExport, "invalid_backup", [
    text({ profiles: [{ userId: 11, username: "fighter1" }] }),
    text({ profiles: [{ userId: "11", username: null }] }),
    text({ purchases: [{ userId: "11" }, 5] }),
    text({ builds: {} }),
    text({ exportedAt: 5 }),
    text({ builds: undefined }),
    "[]",
    "",
  ]);
});

test("Cloudflare answer parsers: the envelope, Analytics rows, deployments, versions", () => {
  const CF = "invalid_cloudflare_answer";
  accepts(p.parseCfEnvelope, [
    [
      { success: true, errors: [], result: {} },
      { success: true, errors: [] },
    ],
    [
      { data: {}, errors: null },
      { success: undefined, errors: null },
    ],
  ]);
  refuses(p.parseCfEnvelope, CF, [{ success: "yes" }, { errors: "no access" }, undefined]);

  const row = {
    sum: { requests: 1200, errors: 3, subrequests: 10 },
    dimensions: { scriptName: "nesszerra-mini-chat" },
  };
  const empty = { sum: null, dimensions: null };
  const analytics = (rows: unknown) => ({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } } });
  accepts(p.parseAnalytics, [[analytics([row, empty]), [row, empty]]]);
  refuses(p.parseAnalytics, CF, [
    analytics([{ sum: { requests: "1200" } }]),
    analytics([{ dimensions: { scriptName: 5 } }]),
    analytics([null]),
    analytics(undefined),
    { data: { viewer: { accounts: [] } } },
    { data: null, errors: [{ message: "no access" }] },
  ]);

  const deployment = {
    id: "d1",
    created_on: "2026-10-01",
    source: "api",
    versions: [{ version_id: "v2", percentage: 100 }],
    annotations: { "workers/message": "promote #7" },
  };
  accepts(p.parseCfDeployments, [
    [{ success: true, result: { deployments: [deployment] } }, [deployment]],
    [{ success: true, result: null }, [], "missing result"],
  ]);
  refuses(p.parseCfDeployments, CF, [
    { result: { deployments: [{ ...deployment, versions: "v2" }] } },
    { result: { deployments: [{ ...deployment, annotations: 5 }] } },
    { result: { deployments: {} } },
    [],
  ]);

  const item = { id: "v2", number: 2, metadata: { created_on: "2026-10-01" }, annotations: { "workers/tag": "t" } };
  accepts(p.parseCfVersions, [
    [{ success: true, result: { items: [item] } }, [item]],
    [{ success: true }, [], "missing result"],
  ]);
  refuses(p.parseCfVersions, CF, [
    { result: { items: [{ ...item, metadata: "2026" }] } },
    { result: { items: [5] } },
    { result: 5 },
  ]);
});

test("GitHub answer parsers: tree, contents, refs, saves, pull requests, runs, merges", () => {
  const GH = "invalid_github_answer";
  const tree = [{ type: "blob", path: "src/admin.js", size: 1 }];
  accepts(p.parseGhTree, [
    [
      { sha: "t", tree, truncated: false },
      { tree, truncated: false },
    ],
    [{ sha: "t" }, { tree: [], truncated: undefined }, "missing tree"],
  ]);
  refuses(p.parseGhTree, GH, [{ tree: {} }, { tree: [5] }, undefined]);

  const sha = "b".repeat(40);
  const file = { type: "file", size: 5, encoding: "base64", content: "aGVsbG8=", sha, name: "a.ts" };
  accepts(p.parseGhContent, [
    [file, { size: 5, encoding: "base64", content: "aGVsbG8=", sha }],
    [[{ type: "file", name: "a.ts" }], null, "a directory"],
    [{ type: "symlink", target: "a.ts" }, null],
  ]);
  refuses(p.parseGhContent, GH, [
    { ...file, size: "5" },
    { ...file, content: 5 },
    { type: "file", encoding: "base64" },
    undefined,
  ]);

  accepts(p.parseGhRef, [[{ ref: "refs/heads/main", object: { sha, type: "commit" } }, { sha }]]);
  refuses(p.parseGhRef, GH, [{ object: { sha: 5 } }, { ref: "refs/heads/main" }]);

  const saved = { content: { sha: "s1", path: "a.ts" }, commit: { sha: "c1" } };
  keeps(p.parseGhSaved, [saved]);
  accepts(p.parseGhSaved, [[{}, { content: undefined, commit: undefined }, "missing content and commit"]]);
  refuses(p.parseGhSaved, GH, [{ content: "s1" }, undefined]);

  const pr = { number: 7, html_url: "https://github.com/Finesssee/pixfray/pull/7" };
  accepts(p.parseGhPulls, [
    [[{ ...pr, state: "open" }], [pr]],
    [[], []],
  ]);
  refuses(p.parseGhPulls, GH, [[{ ...pr, number: "7" }], [{ number: 7 }], {}]);
  accepts(p.parseGhPr, [[{ ...pr, state: "open" }, pr]]);
  refuses(p.parseGhPr, GH, [{ ...pr, html_url: 5 }, { html_url: pr.html_url }]);

  const run = { id: 5, status: "completed", conclusion: null, head_branch: "live-fix/a" };
  accepts(p.parseGhRuns, [
    [{ total_count: 1, workflow_runs: [run] }, [run]],
    [{ total_count: 0 }, [], "missing workflow_runs"],
  ]);
  refuses(p.parseGhRuns, GH, [{ workflow_runs: "x" }, { workflow_runs: [5] }]);

  const pull = { number: 7, state: "open", merged: false, base: { ref: "main" }, head: { ref: "live-fix/a", sha } };
  keeps(p.parseGhPull, [pull]);
  refuses(p.parseGhPull, GH, [
    { ...pull, head: { ref: 5, sha } },
    { ...pull, base: "main" },
    { number: 7, state: "open" },
    [],
  ]);

  accepts(p.parseGhMerge, [[{ sha, merged: true, message: "Pull Request successfully merged" }, { sha }]]);
  refuses(p.parseGhMerge, GH, [{ sha: 5, merged: true }, { merged: true }]);

  assert.deepEqual(p.ignoreAnswer(), yes(null), "dispatch and the branch checks read only the status");
});

// ---------- Harnesses: real ChannelRooms on node:sqlite, the Worker in front of them ----------

const roomEnv = asEnv({ INTERNAL_SECRET: INTERNAL, DEV_TOOLS_TOKEN: DEV });

/** One room, called the way the Worker calls it. */
function room() {
  const r = new ChannelRoom(fakeCtx(), roomEnv);
  return (path: string, body: unknown, userId?: string) =>
    roomCall(r, path, { method: "POST", body, ...(userId ? { userId } : {}) });
}

/** The Worker with an in-memory AuthStore and real rooms. */
function environment(extra: Record<string, unknown> = {}) {
  const entries = new Map<string, Loose>(),
    ROOMS = namespace(realRooms({ DEV_TOOLS_TOKEN: DEV }).fetch);
  const env = asEnv({
    ...SECRETS,
    AUTH: memoryAuth(entries),
    ROOMS,
    ASSETS: { fetch: async () => Response.json([{ id: "player" }]) },
    ...extra,
  });
  return { env, entries };
}

const REAL_FETCH = globalThis.fetch;
/** [method, URL pattern, status, body] for one outside endpoint; a string body is sent as is, null as none. */
type Stub = [method: string, url: RegExp, status: number, body: unknown];
/**
 * fetch answers the first stub that matches and 599 to anything else, so no test reaches GitHub, Twitch or
 * Cloudflare; the list it returns names every request.
 */
function upstream(t: { after: (fn: () => void) => void }, stubs: Stub[] = []): string[] {
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input),
      method = init?.method || "GET";
    calls.push(method + " " + url);
    const hit = stubs.find(([m, pattern]) => m === method && pattern.test(url));
    if (!hit) return Response.json({ error: "offline: " + url }, { status: 599 });
    const body = hit[3];
    return new Response(typeof body === "string" || body === null ? body : JSON.stringify(body), { status: hit[2] });
  };
  t.after(() => {
    globalThis.fetch = REAL_FETCH; // not the fetch it replaced: a test may stub fetch more than once
  });
  return calls;
}

// ---------- Body shapes at the routes ----------

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

/** A refusal that names its reason next to the message. */
const refused = (reason: string, error = reason) => ({ ok: false, reason, error });
const BARE = { error: "invalid_body" };
const SEND_UPLOAD = refused("invalid_upload", "Send {label, image, ai?}");
const RESTORE = { error: "Send {bookmark} or {at}", reason: "invalid_body" },
  RESTORED = { error: "Send {revision}", reason: "invalid_body" };
const upload = { userId: "u1", username: "alice", label: "Cat", image: PNG };
const review = { id: "v-x", action: "approve", actorId: "1" };
const message = { messageId: "m1", timestamp: 1, messageType: "notification", subscription: { id: "s" }, event: null };

test("room routes the Worker calls refuse a body of the wrong shape, each with its own answer", async () => {
  const cases: [path: string, body: unknown, answer: object][] = [
    ["/admin", { actorId: "1", action: 5 }, refused("invalid_body")],
    ["/admin", { actorId: "1", action: "resetRound", payload: [] }, refused("invalid_body")],
    ["/admin", { actorId: "1", action: "resetRound", actorName: 5 }, refused("invalid_body")],
    ["/admin", { actorId: "1", action: "resetRound", payload: { note: 5 } }, refused("invalid_body")],
    ["/admin", { actorId: "1", action: "giftDollars", payload: 5 }, refused("invalid_body")],
    ["/se-admin", { action: "setSeNames", names: 5 }, BARE],
    ["/se-admin", { action: "setDuelModuleOff", value: "yes" }, BARE],
    ["/checkin-test", { on: 5 }, BARE],
    ["/checkin-test", { on: true, by: 5 }, BARE],
    ["/dev-chat", { userId: "7", username: "bob", text: 5 }, BARE],
    ["/dev-live", { live: 5 }, BARE],
    ["/dev-live", { live: true, streamId: 5 }, BARE],
    ["/bot-sent", { results: {} }, BARE],
    ["/eventsub", { ...message, subscription: 5 }, BARE],
    ["/eventsub", { ...message, event: 5 }, BARE],
    // a body that is not an object is refused before any restore step
    ...[null, [], 5].flatMap((body): [string, unknown, object][] => [
      ["/dev/restore", body, RESTORE],
      ["/dev/restored", body, RESTORED],
    ]),
    ["/sprites", { ...upload, label: 5 }, refused("invalid_label", "Name your sprite (1-24 characters)")],
    ["/sprites", { ...upload, image: true }, refused("invalid_image", "Choose an image")],
    ["/sprites", { ...upload, ai: 5 }, SEND_UPLOAD],
    ["/sprites", { ...upload, username: 5 }, SEND_UPLOAD],
    ["/sprites/ai", { userId: "u1", op: 5 }, refused("invalid_request", "Send {userId, op}")],
    ["/sprites/ai", { userId: 5 }, refused("invalid_request", "Send {userId, op}")],
    ["/sprites/review", { ...review, id: 5 }, refused("invalid_body", "Send {id, action}")],
    ["/sprites/review", { ...review, action: 5 }, refused("invalid_action", "Send {id, action}")],
  ];
  for (const [path, body, answer] of cases)
    assert.deepEqual(await room()(path, body), { status: 400, body: answer }, path + " " + JSON.stringify(body));
});

test("Worker routes refuse a wrong-typed body at the edge, after the role check", async (t) => {
  upstream(t);
  const f = environment({ BACKUPS: {}, AI: {}, GITHUB_TOKEN: "test-only-gh-token", GITHUB_REPO: "Finesssee/pixfray" });
  const owner = await signedIn(f, true),
    viewer = await signedIn(f);
  const ownerRefused = (error: string) => ({ error, reason: "invalid_body" });
  const restore = ownerRefused("Send {channel, at} or {channel, undo: true}");
  const cases: [cookie: string, path: string, body: unknown, answer: object][] = [
    [owner, "/api/admin/nesszerra", { action: 5 }, refused("invalid_body")],
    [owner, "/api/admin/nesszerra", {}, refused("invalid_body")],
    [owner, "/api/admin/nesszerra", { action: "connectChat", takeover: "yes" }, refused("invalid_body")],
    [owner, "/api/admin/nesszerra", { action: "setDuelModuleOff", value: 1 }, refused("invalid_body")],
    [owner, "/api/admin/nesszerra", { action: "setSeNames", names: [] }, refused("invalid_body")],
    [owner, "/api/dev/restore", { channel: 5, at: Date.now() - 3600000 }, restore],
    [owner, "/api/dev/restore", { channel: "nesszerra", undo: "yes" }, restore],
    [owner, "/api/dev/backups", { channel: 5 }, ownerRefused("channel must be a login")],
    [owner, "/api/dev/channels", { action: "pause", login: 5 }, ownerRefused("login must be a channel login")],
    [
      owner,
      "/api/dev/settings",
      { action: "connectChat", takeover: "yes" },
      ownerRefused("takeover must be true or false"),
    ],
    [owner, "/api/dev/code/pr", { branch: "live-fix/a", title: 5 }, ownerRefused("title and body must be text")],
    [
      viewer,
      "/api/sprite/nesszerra",
      { label: 5, image: PNG },
      refused("invalid_label", "Name your sprite (1-24 characters)"),
    ],
    [viewer, "/api/sprite/nesszerra", { label: "Cat", image: 5 }, refused("invalid_image", "Choose an image")],
    [viewer, "/api/sprite/nesszerra", { label: "Cat", image: PNG, ai: "yes" }, SEND_UPLOAD],
    [viewer, "/api/sprite/nesszerra/redraw", { image: 5 }, refused("invalid_image", "Choose an image")],
  ];
  for (const [cookie, path, body, answer] of cases)
    assert.deepEqual(
      await call(f.env, path, "POST", body, cookie),
      { status: 400, body: answer },
      path + " " + JSON.stringify(body),
    );
  // the role check still answers first
  assert.equal((await call(f.env, "/api/admin/nesszerra", "POST", { action: 5 }, viewer)).status, 403);
});

test("POST /api/devtools: a wrong-typed account or stream field is invalid_body", async (t) => {
  upstream(t);
  const f = environment({ DEV_TOOLS_TOKEN: DEV });
  f.entries.set("owner:nesszerra", { id: "1" });
  for (const [action, data] of [
    ["chat", { userId: "t1", username: "testbot_a", text: 5 }],
    ["chat", { userId: 7, username: "testbot_a", text: "!fight" }],
    ["profile", { userId: "t1", username: "testbot_a", displayName: [] }],
    ["live", { live: 5 }],
    ["live", { live: true, streamId: 5 }],
  ] as const) {
    // as const: each action stays a literal path segment
    const r = await worker.fetch(
      new Request("https://test.chat.miolaf.xyz/api/devtools/nesszerra/" + action, {
        method: "POST",
        headers: { Authorization: "Bearer " + DEV, "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
      f.env,
    );
    assert.deepEqual({ status: r.status, body: await r.json<unknown>() }, { status: 400, body: BARE }, action);
  }
});

test("POST /api/eventsub: a signed body whose subscription or event is not an object is invalid_body", async (t) => {
  upstream(t);
  const f = environment();
  const event = { broadcaster_user_login: "nesszerra", chatter_user_id: "7", message: { text: "!fight" } };
  for (const body of [
    { subscription: 5, event },
    { subscription: { id: "s", condition: [] }, event },
    { subscription: { id: "s" }, event: "hi" },
  ]) {
    const raw = JSON.stringify(body),
      id = "msg-" + Math.random().toString(16).slice(2),
      timestamp = new Date().toISOString().replace("Z", "123456Z");
    const r = await worker.fetch(
      req("/api/eventsub", "POST", raw, undefined, {
        "Twitch-Eventsub-Message-Id": id,
        "Twitch-Eventsub-Message-Timestamp": timestamp,
        "Twitch-Eventsub-Message-Signature": await signEventsub(await eventsubSecret(f.env), id, timestamp, raw),
        "Twitch-Eventsub-Message-Type": "notification",
        "Twitch-Eventsub-Subscription-Type": "channel.chat.message",
        "Twitch-Eventsub-Subscription-Version": "1",
      }),
      f.env,
    );
    assert.deepEqual({ status: r.status, body: await r.text() }, { status: 400, body: "invalid_body" }, raw);
  }
});

// ---------- Outside answers at the routes ----------

/** Twitch for a sign-in: the viewer's tokens, validation and user, the owner lookup and the past-broadcast list. */
const twitch = (
  patch: { token?: unknown; validate?: unknown; users?: unknown; owner?: unknown; videos?: unknown } = {},
): Stub[] => [
  ["POST", /oauth2\/token$/, 200, patch.token ?? { access_token: "user-token", refresh_token: "r" }],
  ["GET", /oauth2\/validate$/, 200, patch.validate ?? { client_id: "test-app", user_id: "2", scopes: [] }],
  [
    "GET",
    /helix\/users\?login=/,
    200,
    patch.owner ?? { data: [{ id: "1", login: "nesszerra", display_name: "nesszerra" }] },
  ],
  ["GET", /helix\/users$/, 200, patch.users ?? { data: [{ id: "2", login: "viewer", display_name: "Viewer" }] }],
  ["GET", /helix\/videos/, 200, patch.videos ?? { data: [] }],
];
/** /auth/login, then Twitch's redirect back to /auth/callback with a code. */
async function oauth(f: ReturnType<typeof environment>, query = "") {
  const login = await worker.fetch(req("/auth/login" + query), f.env);
  const state = new URL(login.headers.get("Location") || "").searchParams.get("state") || "";
  const r = await worker.fetch(
    req("/auth/callback?code=c&state=" + encodeURIComponent(state), "GET", undefined, "mini_oauth=" + state),
    f.env,
  );
  return {
    status: r.status,
    body: await r.json<unknown>().catch(() => null),
    location: r.headers.get("Location") || "",
  };
}

test("sign-in: a Twitch answer of the wrong shape gets the existing upstream error", async (t) => {
  const f = environment();
  const run = (patch: Parameters<typeof twitch>[0]) => (upstream(t, twitch(patch)), oauth(f));
  assert.equal((await run({})).status, 303, "the stubs sign a viewer in");
  const failed = (error: string) => ({ status: 502, body: { error }, location: "" });
  const TOKEN = failed("Twitch token exchange failed"),
    IDENTITY = failed("Twitch identity validation failed");
  for (const [patch, answer] of [
    [{ users: {} }, IDENTITY],
    [{ token: "<html>" }, TOKEN],
    [{ token: { refresh_token: "r" } }, TOKEN],
    [{ validate: "<html>" }, IDENTITY],
    [{ validate: { client_id: "test-app", user_id: 2, scopes: [] } }, IDENTITY],
  ] as const)
    // as const: each patch keeps its one key
    assert.deepEqual(await run(patch), answer, JSON.stringify(patch));
  // The owner lookup only feeds the stored owner id; an unreadable one signs the viewer in like a failed one.
  const owner = await run({ owner: "<html>" });
  assert.deepEqual([owner.status, owner.location], [303, "/?channel=nesszerra&signed_in=1"]);
});

test("sign-up: an unreadable past-broadcast list makes the streamer check say unchecked", async (t) => {
  const f = environment();
  const user = {
    id: "55",
    login: "newstreamer",
    display_name: "NewStreamer",
    created_at: "2020-01-01T00:00:00Z",
    broadcaster_type: "",
  };
  upstream(
    t,
    twitch({
      validate: { client_id: "test-app", user_id: "55", scopes: ["moderation:read"] },
      users: { data: [user] },
      videos: {},
    }),
  );
  assert.equal((await oauth(f, "?signup=1")).location, "/start/?error=review");
  assert.deepEqual(f.entries.get("channel:newstreamer")?.review?.reasons, ["unchecked"]);
});

test("moderator check: a Twitch answer of the wrong shape refuses with access()'s existing errors", async (t) => {
  const MOD = { id: "2", login: "viewer", displayName: "V" };
  const check = async (validatedAt: number, stubs: Stub[], message: string) => {
    const f = environment();
    f.entries.set("owner:nesszerra", { id: "1" });
    f.entries.set(
      "broadcaster:nesszerra",
      await seal(f.env, { access_token: "a1", refresh_token: "r1", userId: "1", validatedAt }),
    );
    upstream(t, stubs);
    await assert.rejects(access(f.env, MOD, "nesszerra"), { message });
    assert.equal(f.entries.has("mod:nesszerra:2"), false, "nothing is cached");
  };
  await check(
    Date.now(),
    [["GET", /moderation\/moderators/, 200, { pagination: {} }]],
    "Current moderator role cannot be verified",
  );
  await check(
    0,
    [
      ["GET", /oauth2\/validate$/, 401, { status: 401 }],
      ["POST", /oauth2\/token$/, 200, { access_token: "a2" }],
    ],
    "Broadcaster must reconnect Twitch",
  );
  await check(
    0,
    [
      ["GET", /oauth2\/validate$/, 200, { client_id: "test-app", user_id: "1", scopes: "moderation:read" }],
      ["GET", /moderation\/moderators/, 200, { data: [{ user_id: "2" }] }],
    ],
    "Twitch authorization unavailable",
  );
});

test("registry: a channel record of the wrong shape is left out and logged, and the other channels still list", async (t) => {
  upstream(t);
  const warn = t.mock.method(console, "warn", () => {});
  const f = environment(),
    owner = await signedIn(f, true);
  f.entries.set("channel:streamer_a", { id: "100", login: "streamer_a", enabledAt: "1000" });
  f.entries.set("channel:streamer_b", { id: "200", login: "streamer_b", enabledAt: 2000 });
  assert.deepEqual(await listRecords(f.env, "channel:"), [
    { key: "channel:streamer_b", value: { id: "200", login: "streamer_b", enabledAt: 2000 } },
  ]);
  assert.deepEqual(warn.mock.calls.at(-1)?.arguments, ["registry records skipped", "channel:streamer_a"]);
  const list = await call(f.env, "/api/dev/channels", "GET", undefined, owner);
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.body.channels.map((c: { login: string }) => c.login),
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
  const sql = fakeSql();
  ensureUploadSchema(sql);
  const insert =
    "INSERT INTO custom_characters (id, meta, atlas, bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)";
  sql.exec(insert, "c-a", '["a"]', new Uint8Array([1]), 1, "1", 1);
  sql.exec(insert, "c-b", '{"label":"Cat"}', new Uint8Array([1]), 1, "1", 2);
  const r = await handleRoomAssets({ ctx: fakeCtx({ sql }) }, new Request("https://room/catalog"), {
    path: "/catalog",
    channel: "nesszerra",
  });
  assert.deepEqual(await r.json(), [
    { id: "c-a", url: "/api/assets/nesszerra/c-a", custom: true },
    { label: "Cat", id: "c-b", url: "/api/assets/nesszerra/c-b", custom: true },
  ]);
});

test("daily backups: a stored export of the wrong shape is unreadable, and the backups route's upstream error", async (t) => {
  upstream(t);
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
  for (const [row, result] of [
    [packed(good), yes(good)],
    [packed(bad), no("invalid_backup")],
    [{ data: [1, 2, 3] }, no("invalid_backup")],
    [null, null],
  ])
    assert.deepEqual(await readBackup(fakeD1(row), "nesszerra", "2026-10-09"), result);

  const f = environment({ BACKUPS: fakeD1(packed(bad)) }),
    owner = await signedIn(f, true);
  assert.deepEqual(await call(f.env, "/api/dev/backups?channel=nesszerra&day=2026-10-09", "GET", undefined, owner), {
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
  for (const [url, path, what] of [
    [/\/runs\?per_page=10$/, "runs", "List workflow runs"],
    [/\/git\/trees\/main\?recursive=1$/, "code/tree", "Read tree"],
    [/\/contents\/src\/admin\.js\?ref=main$/, "code/file?path=src/admin.js", "Read file"],
  ] as const) {
    // as const: each row keeps its pattern, path and label types
    upstream(t, [["GET", url, 200, "<html>"]]);
    assert.deepEqual(await call(f.env, "/api/dev/" + path, "GET", undefined, owner), unreadable(what));
  }

  // A hotfix whose pull request answer is unreadable is still deployed, and says to open the pull request by hand.
  upstream(t, [
    ["POST", /\/dispatches$/, 204, null],
    ["GET", /\/pulls\?state=open/, 200, []],
    ["POST", /\/pulls$/, 201, "<html>"],
  ]);
  const hot = await call(f.env, "/api/dev/hotfix", "POST", { branch: "hotfix/a" }, owner);
  assert.equal(hot.status, 202);
  assert.deepEqual([hot.body.pr, hot.body.prError], [null, "Pull request not opened; open it manually"]);

  // A merge answer without the merged sha stops before production is deployed.
  const pull = {
    number: 7,
    state: "open",
    merged: false,
    base: { ref: "main" },
    head: { ref: "live-fix/a", sha: "b".repeat(40) },
  };
  const calls = upstream(t, [
    ["GET", /\/pulls\/7$/, 200, pull],
    ["PUT", /\/pulls\/7\/merge$/, 200, { merged: true, message: "Pull Request successfully merged" }],
    ["POST", /\/dispatches$/, 204, null],
  ]);
  assert.deepEqual(
    await call(f.env, "/api/dev/promote", "POST", { number: 7 }, owner),
    unreadable("Merge pull request (it may have merged; check GitHub)"),
  );
  assert.equal(calls.filter((x) => x.endsWith("/dispatches")).length, 0, "nothing dispatched");
});

test("Cloudflare: an unreadable deployments answer is that script's API error", async (t) => {
  const f = environment({ CF_API_TOKEN: "test-only-cf", CF_ACCOUNT_ID: "a".repeat(32) }),
    owner = await signedIn(f, true);
  upstream(t, [
    ["GET", /\/deployments$/, 200, "<html>"],
    ["GET", /\/versions$/, 200, { success: true, errors: [], result: { items: [] } }],
  ]);
  const failed = (script: string) => ({ script, deployments: [], versions: [], error: "Cloudflare API error 200" });
  assert.deepEqual(await call(f.env, "/api/dev/versions", "GET", undefined, owner), {
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
      { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [null] }] } }, errors: null },
    ],
  ]);
  assert.deepEqual(
    await usage(asEnv({ CF_API_TOKEN: "x", CF_ACCOUNT_ID: "a".repeat(32) }), Date.parse("2026-10-01T15:30:00Z")),
    {
      limit: 100000,
      since: "2026-10-01T00:00:00.000Z",
      resetsAt: "2026-10-02T00:00:00.000Z",
      configured: true,
      error: "Analytics query failed",
      status: 200,
    },
  );
});
