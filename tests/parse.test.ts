// Inbound request parsing (server/parse.ts): each parser on its own, then the routes whose answer changed when a body
// of the wrong shape began to get a 400 at the edge instead of a crash or a silent default (docs/CONTRACTS.md §2, §4).
// The parser tests load parse.ts with import() so the route tests also run against code that predates it.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import worker from "../server/worker.ts";
import { digest } from "../server/auth.ts";
import { ChannelRoom } from "../server/channel.ts";
import { eventsubSecret, signEventsub } from "../server/eventsub.ts";
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
  assert.deepEqual(p.parseRoomRestore({ at: "5" }), no("invalid_body"));
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
