import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  BURST_RUN,
  DAILY_STORE_CAP,
  count,
  ensureTrackerSchema,
  noteAlarm,
  readCounts,
  settleCounts,
  trace,
} from "../server/tracker.ts";
import { ensureDeveloperSchema } from "../server/developer.ts";
import { fakeCtx, fakeSql } from "./fakes.ts";
import type { FakeSql } from "./fakes.ts";

function room(sql: FakeSql = fakeSql()) {
  const ctx = fakeCtx({ sql });
  ensureDeveloperSchema(ctx.storage.sql);
  ensureTrackerSchema(ctx.storage.sql);
  return { ctx };
}
const rows = (r: ReturnType<typeof room>, source: string) =>
  r.ctx.storage.sql
    .exec<{ message: string }>("SELECT message FROM error_log WHERE source = ? ORDER BY id", source)
    .toArray()
    .map((x) => x.message);
const quiet = (t: TestContext) => {
  const lines: string[] = [];
  for (const level of ["log", "warn", "error"] as const)
    t.mock.method(console, level, (line: string) => lines.push(line));
  return lines;
};

test("a trace prints one JSON line and stores a row; store=false prints only", (t) => {
  const lines = quiet(t),
    r = room();
  trace(r, "duel", "duel_started", { channel: "nesszers", duelId: "d1" });
  trace(r, "chat", "heard", { channel: "nesszers", user: "alice" }, false);
  assert.deepEqual(
    lines.map((l) => JSON.parse(l)),
    [
      { log: "duel", message: "duel_started", channel: "nesszers", duelId: "d1" },
      { log: "chat", message: "heard", channel: "nesszers", user: "alice" },
    ],
  );
  assert.deepEqual(rows(r, "duel"), ["duel_started"]);
  assert.deepEqual(rows(r, "chat"), []);
  assert.deepEqual(readCounts(r)[0]?.counts.log_chat, 1);
});

test("busy sources store at most the daily cap, and count every line", (t) => {
  quiet(t);
  const r = room();
  for (let i = 0; i < DAILY_STORE_CAP + 5; i++) trace(r, "alarm", "set x " + i);
  const kept = rows(r, "alarm");
  assert.ok(kept.length <= 225, "trimmed to its own tail of 200 (plus at most one trim batch)");
  assert.equal(kept.at(-1), "set x " + (DAILY_STORE_CAP - 1), "nothing past the cap is stored");
  assert.equal(readCounts(r)[0]?.counts.log_alarm, DAILY_STORE_CAP + 5);
});

test("each source trims its own tail, so traces never push errors out", (t) => {
  quiet(t);
  const r = room();
  trace(r, "room", "the one error");
  for (let i = 0; i < 260; i++) trace(r, "duel", "duel_action " + i);
  assert.deepEqual(rows(r, "room"), ["the one error"]);
  assert.ok(rows(r, "duel").length < 225);
});

test("counters survive a restart: a new instance keeps adding to today's row", (t) => {
  quiet(t);
  const sql = fakeSql(),
    a = room(sql);
  count(a, "requests", 3);
  readCounts(a); // flushes
  const b = room(sql);
  count(b, "requests", 2);
  const today = readCounts(b);
  assert.equal(today.length, 1);
  assert.equal(today[0]?.day, new Date().toISOString().slice(0, 10));
  assert.equal(today[0]?.counts.requests, 5);
});

test("a day's load past 25000 requests and alarms logs one warning", (t) => {
  quiet(t);
  const r = room();
  count(r, "requests", 24_999);
  assert.deepEqual(rows(r, "warn"), []);
  count(r, "alarms");
  count(r, "requests");
  assert.deepEqual(rows(r, "warn"), ["room load passed 25000 requests and alarms today"]);
});

test("an alarm burst logs one warning, and alarms trace why they ran", (t) => {
  quiet(t);
  const r = room();
  noteAlarm(r, ["rematch_lock"], 3, "nesszers");
  for (let i = 1; i < BURST_RUN * 2; i++) noteAlarm(r, [], null, "nesszers");
  assert.equal(rows(r, "alarm")[0], "ran rematch_lock");
  assert.equal(rows(r, "alarm")[1], "ran nothing due");
  assert.deepEqual(rows(r, "warn"), [`alarm burst: ${BURST_RUN} alarms under a second apart`]);
  const c = readCounts(r)[0]?.counts;
  assert.deepEqual([c?.alarms, c?.alarms_idle], [BURST_RUN * 2, BURST_RUN * 2 - 1]);
});

test("settleCounts writes what a woken room counted before it can hibernate", (t) => {
  quiet(t);
  const sql = fakeSql(),
    stored = () => {
      const row = sql.exec<{ data: string }>("SELECT data FROM daily_stats").toArray()[0];
      return row ? JSON.parse(row.data) : undefined;
    },
    a = room(sql);
  count(a, "requests");
  assert.equal(stored()?.requests, 1, "the first count after a wake writes");
  count(a, "requests");
  settleCounts(a);
  assert.equal(stored()?.requests, 1, "a request right after the last write waits");
  noteAlarm(a, ["respawn"], 0, "nesszers");
  settleCounts(a, true);
  assert.deepEqual([stored()?.requests, stored()?.alarms], [2, 1], "an alarm always writes");
});

test("alarms in a burst save counters at most every SETTLE_MS, not on every run", (t) => {
  quiet(t);
  const sql = fakeSql(),
    r = room(sql),
    storedAlarms = () =>
      JSON.parse(sql.exec<{ data: string }>("SELECT data FROM daily_stats").toArray()[0]?.data ?? "{}").alarms;
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const alarm = () => {
    noteAlarm(r, ["tick"], 0, "nesszers");
    settleCounts(r, true);
    t.mock.timers.tick(100);
    return storedAlarms();
  };
  const beforeBurst = Array.from({ length: BURST_RUN }, alarm);
  assert.deepEqual(beforeBurst.slice(-2), [BURST_RUN - 1, BURST_RUN - 1], "alarms save each run until the burst");
  const inBurst = new Set(Array.from({ length: 100 }, alarm));
  assert.deepEqual([...inBurst], [BURST_RUN - 1, 119], "100 burst alarms over 10 s save once, after SETTLE_MS");
});
