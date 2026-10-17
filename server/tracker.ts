// Debug traces and per-room daily counters (docs/CONTRACTS.md §2, owner logs and stats).
// Every trace prints one JSON line to Workers Logs (free, 3 days). SQLite rows are the scarce budget (100k writes a
// day for the whole account), so the room keeps only a capped tail of the busy sources and one counter row per day.
import type { JsonObject } from "./parse.ts";

type Room = { ctx: DurableObjectState };

/** Every source the room log stores; the owner page filters by these. */
export const LOG_SOURCES = ["room", "worker", "command", "warn", "alarm", "duel", "chat"];
/** Rows kept per source in error_log. Busy trace sources keep a shorter tail. */
export const KEEP_ROWS: { [source: string]: number } = { alarm: 200, duel: 200, chat: 200 };
const KEEP_DEFAULT = 500;
/** Busy sources store at most this many rows a day; the rest go to Workers Logs only. */
export const DAILY_STORE_CAP = 300;
const TRIM_EVERY = 25;
/** Counters reach SQLite at least this often while a room is busy. */
export const FLUSH_MS = 30_000;
/** A request flushes dirty counters once this long has passed since the last write; an alarm always does. */
export const SETTLE_MS = 10_000;
const KEEP_DAYS = 14;
/** A run of this many alarms each under BURST_GAP_MS apart logs a warning (at most every BURST_ALERT_MS). */
export const BURST_RUN = 20;
const BURST_GAP_MS = 1000;
const BURST_ALERT_MS = 10 * 60_000;
/** Requests plus alarms in one room and day that log a warning, once each (the Free plan allows 100k a day). */
export const DAILY_ALERTS = [25_000, 50_000];

type Counts = { [name: string]: number };
type Tracker = {
  day: string;
  counts: Counts;
  dirty: boolean;
  flushedAt: number;
  sinceTrim: Counts;
  lastAlarmAt: number;
  alarmRun: number;
  burstAlertAt: number;
};

const trackers = new WeakMap<DurableObjectState, Tracker>();

export function ensureTrackerSchema(sql: SqlStorage): void {
  sql.exec("CREATE TABLE IF NOT EXISTS daily_stats (day TEXT PRIMARY KEY, data TEXT NOT NULL)");
}

const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

function tracker(room: Room, now: number): Tracker {
  let t = trackers.get(room.ctx);
  const day = utcDay(now);
  if (t && t.day === day) return t;
  if (t) flush(room, t);
  const sql = room.ctx.storage.sql;
  // a restarted room keeps counting where the last flush left today
  const row = sql.exec<{ data: string }>("SELECT data FROM daily_stats WHERE day = ?", day).toArray()[0];
  let counts: Counts = {};
  try {
    if (row) counts = JSON.parse(row.data);
  } catch {}
  if (!t) sql.exec("DELETE FROM daily_stats WHERE day < ?", utcDay(now - KEEP_DAYS * 86_400_000));
  t = {
    day,
    counts,
    dirty: false,
    // 0, so the first request or alarm after a wake writes what it counted before the room can sleep again
    flushedAt: 0,
    sinceTrim: t?.sinceTrim || {},
    lastAlarmAt: t?.lastAlarmAt || 0,
    alarmRun: t?.alarmRun || 0,
    burstAlertAt: t?.burstAlertAt || 0,
  };
  trackers.set(room.ctx, t);
  return t;
}

function flush(room: Room, t: Tracker): void {
  if (!t.dirty) return;
  t.dirty = false;
  t.flushedAt = Date.now();
  t.counts.rows_written = (t.counts.rows_written || 0) + 1;
  room.ctx.storage.sql.exec(
    "INSERT INTO daily_stats (day, data) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET data = excluded.data",
    t.day,
    JSON.stringify(t.counts),
  );
}

/** Adds to today's counter. Counts reach SQLite at most every FLUSH_MS and at the end of each request and alarm (settleCounts). Never throws. */
export function count(room: Room, name: string, n = 1): void {
  try {
    const now = Date.now(),
      t = tracker(room, now);
    t.counts[name] = (t.counts[name] || 0) + n;
    t.dirty = true;
    if (name === "requests" || name === "alarms") {
      const load = (t.counts.requests || 0) + (t.counts.alarms || 0);
      for (const at of DAILY_ALERTS)
        if (load >= at && !t.counts["alert_" + at]) {
          t.counts["alert_" + at] = 1;
          trace(room, "warn", `room load passed ${at} requests and alarms today`, {
            requests: t.counts.requests || 0,
            alarms: t.counts.alarms || 0,
          });
        }
    }
    if (now - t.flushedAt >= FLUSH_MS) flush(room, t);
  } catch {}
}

/**
 * Called at the end of every request (`always` false) and alarm (`always` true): a room idle for seconds hibernates and
 * drops what is only in memory. An alarm already writes state, so its counters go with it; a request writes them once
 * SETTLE_MS has passed, which bounds the rows a chatty channel adds. Never throws.
 */
export function settleCounts(room: Room, always = false): void {
  try {
    const t = tracker(room, Date.now());
    if (always || Date.now() - t.flushedAt >= SETTLE_MS) flush(room, t);
  } catch {}
}

/** Writes today's counters now (the stats route and tests read them straight after). Never throws. */
export function flushCounts(room: Room): void {
  try {
    flush(room, tracker(room, Date.now()));
  } catch {}
}

/** The last `days` days of counters, newest first. */
export function readCounts(room: Room, days = 7): { day: string; counts: Counts }[] {
  flushCounts(room);
  return room.ctx.storage.sql
    .exec<{ day: string; data: string }>("SELECT day, data FROM daily_stats ORDER BY day DESC LIMIT ?", days)
    .toArray()
    .map((r) => {
      let counts: Counts = {};
      try {
        counts = JSON.parse(r.data);
      } catch {}
      return { day: r.day, counts };
    });
}

/**
 * One debug line. Always printed to Workers Logs as JSON ({log, message, ...context}). Stored in the room's log
 * unless `store` is false; the busy sources (KEEP_ROWS) store at most DAILY_STORE_CAP rows a day. Never throws.
 */
export function trace(room: Room, source: string, message: string, context: JsonObject = {}, store = true): void {
  try {
    const line = JSON.stringify({ log: source, message, ...context });
    if (source === "room" || source === "worker") console.error(line);
    else if (source === "warn") console.warn(line);
    else console.log(line);
  } catch {}
  try {
    count(room, "log_" + source);
    const t = tracker(room, Date.now());
    if (!store || (source in KEEP_ROWS && (t.counts["log_" + source] || 0) > DAILY_STORE_CAP)) return;
    storeLog(room, t, source, message, context);
  } catch {}
}

function storeLog(room: Room, t: Tracker, source: string, message: string, context: JsonObject): void {
  const sql = room.ctx.storage.sql;
  let ctx = JSON.stringify(context ?? {}) || "{}";
  if (ctx.length > 2000) ctx = JSON.stringify({ truncated: ctx.slice(0, 1900) });
  sql.exec(
    "INSERT INTO error_log (at, source, message, context) VALUES (?, ?, ?, ?)",
    Date.now(),
    source,
    String(message || "unknown").slice(0, 500),
    ctx,
  );
  t.counts.rows_written = (t.counts.rows_written || 0) + 1;
  // Trimming scans the table, so it runs every TRIM_EVERY rows per source: each source keeps its own tail, and a burst
  // of traces never pushes the errors out.
  t.sinceTrim[source] = (t.sinceTrim[source] || 0) + 1;
  if (t.sinceTrim[source] < TRIM_EVERY) return;
  t.sinceTrim[source] = 0;
  const cut = sql.exec(
    "DELETE FROM error_log WHERE source = ? AND id <= (SELECT id FROM error_log WHERE source = ? ORDER BY id DESC LIMIT 1 OFFSET ?)",
    source,
    source,
    KEEP_ROWS[source] ?? KEEP_DEFAULT,
  );
  t.counts.rows_written += cut.rowsWritten ?? 0;
}

/**
 * Counts one alarm run, traces why it ran and how late, and warns on a burst: BURST_RUN alarms in a row, each under a
 * second after the last, is the loop that once spent the request budget. Never throws.
 */
export function noteAlarm(room: Room, reasons: string[], lateMs: number | null, channel: string): void {
  try {
    const now = Date.now(),
      t = tracker(room, now);
    t.alarmRun = now - t.lastAlarmAt < BURST_GAP_MS ? t.alarmRun + 1 : 1;
    t.lastAlarmAt = now;
    count(room, "alarms");
    if (!reasons.length) count(room, "alarms_idle");
    trace(room, "alarm", "ran " + (reasons.join(",") || "nothing due"), { channel, reasons, lateMs, run: t.alarmRun });
    if (t.alarmRun >= BURST_RUN && now - t.burstAlertAt >= BURST_ALERT_MS) {
      t.burstAlertAt = now;
      trace(room, "warn", `alarm burst: ${t.alarmRun} alarms under a second apart`, { channel, reasons });
    }
  } catch {}
}
