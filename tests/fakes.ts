// Shared test doubles: a Durable Object context on real SQLite (node:sqlite), and the casts that hand partial fakes to
// code typed for the Workers runtime. Each cast lives here once, with its reason.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { Env } from "../server/env.ts";
import { emptyStats } from "../server/upgrades.ts";
import type { Stats } from "../server/upgrades.ts";

// any: data a test reads by property and asserts on (JSON bodies, SQL rows, stub call records); the assertions check
// the values, so a declared shape would only repeat them.
export type Loose = any;

/** A cursor like SqlStorageCursor: the rows of one statement, read whole or iterated. */
export type FakeCursor = { toArray(): Loose[]; [Symbol.iterator](): Iterator<Loose>; rowsWritten?: number };
export type FakeSql = { exec(query: string, ...params: SQLInputValue[]): FakeCursor };

/** `ctx.storage.sql` over an in-memory SQLite database. Rows come back as plain objects, as SqlStorage returns them. */
export function fakeSql(): FakeSql & SqlStorage {
  const db = new DatabaseSync(":memory:");
  const sql: FakeSql = {
    exec(query, ...params) {
      const rows = db
        .prepare(query)
        .all(...params)
        .map((r) => ({ ...r }));
      // like SqlStorageCursor.rowsWritten, without the index entries Cloudflare also counts
      const rowsWritten = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(query)
        ? Number(db.prepare("SELECT changes() AS n").get()?.n)
        : 0;
      return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator](), rowsWritten };
    },
  };
  return sql as FakeSql & SqlStorage; // the fake has only exec, the one SqlStorage call the server makes
}

/** A WebSocket as the fake context files it: the tags it was accepted with, and whether it is open (1). */
export type FakeSocketLike = { tags: string[]; readyState: number };

export type FakeStorage = {
  sql: FakeSql;
  transactionSync<T>(fn: () => T): T;
  /** The time the last setAlarm asked for, or null. */
  alarm: number | null;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

export type FakeContext = {
  storage: FakeStorage;
  acceptWebSocket(ws: FakeSocketLike, tags: string[]): void;
  getWebSockets(tag: string): FakeSocketLike[];
  /** Every socket accepted, open or closed, in order. */
  sockets: FakeSocketLike[];
};

/** The fake, typed as the DurableObjectState the rooms take, with its own fields still readable. */
export type FakeState = FakeContext & DurableObjectState<{}>;

/**
 * A Durable Object context on real SQLite. transactionSync commits, or rolls back when `fn` throws, and a nested call
 * joins the outer transaction. The alarm is recorded in `storage.alarm`. Accepted sockets are tagged and listed;
 * getWebSockets returns the open ones with a tag. Pass `sql` to share one database between contexts (a restart).
 */
export function fakeCtx({ sql = fakeSql() }: { sql?: FakeSql } = {}): FakeState {
  const sockets: FakeSocketLike[] = [];
  let depth = 0;
  const storage: FakeStorage = {
    sql,
    transactionSync(fn) {
      if (depth) return fn();
      depth++;
      sql.exec("BEGIN");
      try {
        const v = fn();
        sql.exec("COMMIT");
        return v;
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
    alarm: null,
    async setAlarm(t) {
      this.alarm = t;
    },
    async getAlarm() {
      return this.alarm ?? null;
    },
    async deleteAlarm() {
      this.alarm = null;
    },
  };
  const ctx: FakeContext = {
    storage,
    acceptWebSocket(ws, tags) {
      ws.tags = tags;
      sockets.push(ws);
    },
    getWebSockets(tag) {
      return sockets.filter((s) => s.tags.includes(tag) && s.readyState === 1);
    },
    sockets,
  };
  return ctx as FakeState; // the fake implements only the storage and socket calls the rooms make
}

/** Bindings for a Worker or room under test: each test passes only what the code it runs reads. */
export const asEnv = (env: object): Env => env as Env; // a partial Env on purpose, see above

/** An ExecutionContext with only the calls the Worker makes (waitUntil). */
export const asExecutionContext = (ctx: Partial<ExecutionContext>): ExecutionContext => ctx as ExecutionContext; // partial on purpose

/** `value`, after asserting it is there; for reads the test expects to find (Map.get, find, an index). */
export function must<T>(value: T | null | undefined, message?: string): T {
  assert.ok(value !== undefined && value !== null, message ?? "expected a value");
  return value;
}

/** A whole build from the stats a test names; the rest are 0. */
export const fullStats = (stats: Partial<Stats>): Stats => ({ ...emptyStats(), ...stats });
