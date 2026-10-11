// Durable EventSub dedupe (server/dedupe.ts, ChannelRoom.eventsub): a message id that Twitch delivers twice plays once,
// even when the second delivery lands on a fresh room instance (a new isolate sharing the same Durable Object storage).
import test from "node:test";
import assert from "node:assert/strict";
import { ChannelRoom } from "../server/channel.ts";
import { claimMessage, releaseMessage, EVENTSUB_DEDUPE_MS } from "../server/dedupe.ts";
import { fakeCtx, fakeSql } from "./fakes.ts";
import type { FakeState, Loose } from "./fakes.ts";
import type { Env } from "../server/env.ts";

const SECRET = "test-only-internal-secret-0123456789";
// A room over `ctx`; calling again with the same ctx is a restart / another isolate on the same storage.
type CallOptions = { method?: string; body?: unknown; userId?: string };
// Loose: the body is the room's JSON (or text) reply, which each test reads by property and asserts on
type CallResult = { status: number; body: Loose };
type DeliverOptions = { id?: string; login?: string; bot?: boolean; timestamp?: number };
/** A ChannelRoom with the request helpers roomOn() attaches. */
type TestRoom = ChannelRoom & {
  call(path: string, options?: CallOptions): Promise<CallResult>;
  deliver(messageId: string, text: string, options?: DeliverOptions): Promise<CallResult>;
};

function roomOn(ctx: FakeState, env: Partial<Env> = {}): TestRoom {
  // TestRoom: roomOn() attaches call and deliver below before returning; Env: a partial Env on purpose
  const r = new ChannelRoom(ctx, { INTERNAL_SECRET: SECRET, CHAT_BOT: "1", ...env } as Env) as TestRoom;
  r.call = async (path, { method = "GET", body, userId } = {}) => {
    const headers = {
      "X-Mini-Internal": SECRET,
      "X-Mini-Channel": "nesszerra",
      ...(userId ? { "X-Mini-User-Id": userId } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    };
    const res = await r.fetch(
      new Request("https://room" + path, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    return {
      status: res.status,
      // Loose: the JSON reply body, which the tests read by property
      body: (res.headers.get("content-type") || "").includes("json") ? await res.json<Loose>() : await res.text(),
    };
  };
  r.deliver = (messageId, text, { id = "u1", login = "alice", bot = true, timestamp = Date.now() } = {}) =>
    r.call("/eventsub?origin=" + encodeURIComponent("https://staging.example"), {
      method: "POST",
      body: {
        messageId,
        messageType: "notification",
        bot,
        timestamp,
        subscription: { id: "sub-bot", status: "enabled" },
        event: {
          broadcaster_user_login: "nesszerra",
          chatter_user_id: id,
          chatter_user_login: login,
          chatter_user_name: login,
          message_id: "tm-" + messageId,
          message: { text },
        },
      },
    });
  return r;
}
const connect = (r: TestRoom) =>
  r.call("/chat", {
    method: "POST",
    body: { action: "connected", subscriptionId: "sub-bot", status: "enabled", createdAt: Date.now() },
  });
const rows = (ctx: FakeState) =>
  ctx.storage.sql
    .exec("SELECT id FROM eventsub_seen ORDER BY id")
    .toArray()
    .map((r) => r.id);

test("claimMessage(): new ids are claimed once, expire after 10 minutes, and can be released", () => {
  const sql = fakeSql(),
    T = 1_000_000;
  assert.equal(claimMessage(sql, "a", T), true);
  assert.equal(claimMessage(sql, "a", T + 1), false, "a redelivery");
  assert.equal(claimMessage(sql, "b", T + 1), true, "another message");
  assert.equal(claimMessage(sql, "a", T + EVENTSUB_DEDUPE_MS - 1), false, "still inside the window");
  assert.equal(
    claimMessage(sql, "a", T + EVENTSUB_DEDUPE_MS),
    true,
    "forgotten after the window (the Worker refuses such an old message by its timestamp anyway)",
  );
  releaseMessage(sql, "b");
  assert.equal(claimMessage(sql, "b", T + 2), true, "a released id may be claimed again");
});

test("claimMessage(): expired rows are swept so the table stays small", () => {
  const sql = fakeSql(),
    T = 5_000_000;
  for (let i = 0; i < 20; i++) claimMessage(sql, "old" + i, T);
  claimMessage(sql, "new", T + EVENTSUB_DEDUPE_MS + 120_000);
  assert.deepEqual(
    sql
      .exec("SELECT id FROM eventsub_seen")
      .toArray()
      .map((r) => r.id),
    ["new"],
  );
});

test("a command delivered twice, the second time to a fresh room instance, runs once", async () => {
  const ctx = fakeCtx(),
    first = roomOn(ctx);
  await first.call("/profile", {
    method: "POST",
    userId: "u1",
    body: {
      userId: "u1",
      username: "alice",
      displayName: "alice",
      avatar: "player",
      color: "#123456",
      defaultAbility: "strike",
    },
  });
  await connect(first);
  const one = await first.deliver("msg-1", "!ranks");
  assert.equal(one.status, 200);
  assert.ok(one.body.reply, "the bot answers the first delivery");
  assert.notEqual(one.body.duplicate, true);
  const again = await first.deliver("msg-1", "!ranks");
  assert.deepEqual(again.body, { ok: true, duplicate: true }, "same instance");
  const fresh = roomOn(ctx); // a restarted room: its in-memory Map is empty
  const second = await fresh.deliver("msg-1", "!ranks");
  assert.deepEqual(second.body, { ok: true, duplicate: true }, "fresh instance on the same storage");
  // Loose: the deepEqual above narrowed body to its expected shape; reply is the field this line proves absent
  assert.equal((second.body as Loose).reply, undefined, "no second bot reply");
  const other = await fresh.deliver("msg-2", "!ranks");
  assert.ok(other.body.reply, "a different message id still plays");
  assert.deepEqual(rows(ctx), ["msg-1", "msg-2"]);
});

test("a duel command redelivered after a restart does not challenge twice", async () => {
  const ctx = fakeCtx(),
    first = roomOn(ctx);
  for (const [id, name] of [
    ["u1", "alice"],
    ["u2", "bob"],
  ] satisfies [string, string][])
    await first.call("/profile", {
      method: "POST",
      userId: id,
      body: {
        userId: id,
        username: name,
        displayName: name,
        avatar: "player",
        color: "#123456",
        defaultAbility: "strike",
      },
    });
  await connect(first);
  await first.deliver("j1", "!fray");
  await first.deliver("j2", "!fray", { id: "u2", login: "bob" });
  assert.match((await first.deliver("c1", "!challenge @bob")).body.reply, /bob/);
  const state = () =>
    ctx.storage.sql
      .exec("SELECT document FROM game_state")
      .toArray()
      .map((r) => r.document)
      .join();
  const before = state();
  const replay = await roomOn(ctx).deliver("c1", "!challenge @bob");
  assert.deepEqual(replay.body, { ok: true, duplicate: true });
  assert.equal(state(), before, "the game did not change");
});

test("plain chat lines are not written to storage; only commands are", async () => {
  const ctx = fakeCtx(),
    r = roomOn(ctx);
  await connect(r);
  for (let i = 0; i < 5; i++)
    assert.equal((await r.deliver("chat-" + i, "hello everyone", { bot: false })).status, 200);
  assert.deepEqual(
    ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='eventsub_seen'").toArray(),
    [],
    "no table, no writes",
  );
  assert.deepEqual(
    (await r.deliver("chat-0", "hello everyone", { bot: false })).body,
    { ok: true, duplicate: true },
    "still deduped in memory",
  );
  await r.deliver("cmd-1", "!ranks");
  assert.deepEqual(rows(ctx), ["cmd-1"]);
});

test("a message that failed before it was handled is not taken for a duplicate when Twitch retries it", async () => {
  const ctx = fakeCtx(),
    r = roomOn(ctx);
  await connect(r);
  const real = r.handleEventsub;
  let fail = true;
  r.handleEventsub = async function (...args) {
    if (fail) throw new Error("storage hiccup");
    return real.apply(this, args);
  };
  const failed = await r.deliver("retry-1", "!ranks").catch((error) => ({ status: 500, error }));
  assert.ok(failed.status >= 500, "the Worker sees a failure and Twitch retries: " + failed.status);
  assert.deepEqual(rows(ctx), [], "the claim was released");
  fail = false;
  const retry = await roomOn(ctx).deliver("retry-1", "!ranks");
  assert.ok(retry.body.reply, "the retry plays");
  assert.notEqual(retry.body.duplicate, true);
});
