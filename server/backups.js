// Daily backups. Once a day (the cron trigger in cloudflare.config.ts) every channel room writes its export, the same
// JSON as the owner page's download, gzipped into the BACKUPS D1 database: one row per channel per day, kept
// BACKUP_DAYS. That outlives the rooms' 30-day point-in-time restore, and one fighter can be read back from any day
// without rolling a whole channel back. Each room writes its own row, so the cron run itself only makes one call per
// channel and stays inside the Free plan's per-invocation limits. Owner routes: /api/dev/backups (docs/CONTRACTS.md).

import { CHANNELS } from "./auth.js";
import { listRecords } from "./channels.js";

export const BACKUP_DAYS = 90;
const DAY_MS = 86400000;
const SCHEMA =
  "CREATE TABLE IF NOT EXISTS backups (channel TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (channel, day))";
export const backupDay = (/** @type {number} */ at) => new Date(at).toISOString().slice(0, 10);

/** @param {ReadableStream} stream @param {CompressionStream | DecompressionStream} codec */
const through = (stream, codec) => new Response(stream.pipeThrough(codec));

/**
 * Called by the channel room. Returns the stored (gzipped) size in bytes.
 * @param {D1Database} db
 * @param {string} channel
 * @param {number} at
 * @param {object} data
 */
export async function writeBackup(db, channel, at, data) {
  const packed = await through(new Blob([JSON.stringify(data)]).stream(), new CompressionStream("gzip")).arrayBuffer();
  await db.batch([
    db.prepare(SCHEMA),
    db
      .prepare("INSERT OR REPLACE INTO backups (channel, day, at, bytes, data) VALUES (?, ?, ?, ?, ?)")
      .bind(channel, backupDay(at), at, packed.byteLength, packed),
  ]);
  return packed.byteLength;
}

/**
 * Backs up every channel (built-in and signed up, paused ones too), or only `only`, then drops rows older than
 * BACKUP_DAYS. A room that fails is reported and the rest still run.
 * @param {any} env
 * @param {number} at
 * @param {(channel: string, path: string, init: RequestInit) => Promise<Response>} roomFetch
 * @param {string} [only]
 */
export async function backupChannels(env, at, roomFetch, only = "") {
  const records = await listRecords(env, "channel:");
  const status = new Map(CHANNELS.map((login) => [login, "builtin"]));
  for (const { value } of records)
    if (value?.login && !status.has(value.login)) status.set(value.login, value.pausedAt ? "paused" : "on");
  const results = [];
  for (const [channel, state] of status) {
    if (only && channel !== only) continue;
    try {
      const r = await roomFetch(channel, "/dev/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ at, status: state }),
      });
      const body = await r.json().catch(() => ({}));
      results.push(
        r.ok
          ? { channel, ok: true, bytes: body.bytes }
          : { channel, ok: false, reason: body.reason || body.error || "HTTP " + r.status },
      );
    } catch (e) {
      results.push({ channel, ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  const db = env.BACKUPS;
  await db.batch([
    db.prepare(SCHEMA),
    db.prepare("DELETE FROM backups WHERE day < ?").bind(backupDay(at - BACKUP_DAYS * DAY_MS)),
  ]);
  return results;
}

/**
 * Newest first.
 * @param {D1Database} db
 * @param {string} channel
 */
export async function listBackups(db, channel) {
  await db.prepare(SCHEMA).run();
  const { results } = await db
    .prepare("SELECT day, at, bytes FROM backups WHERE channel = ? ORDER BY day DESC")
    .bind(channel)
    .all();
  return results;
}

/**
 * The stored export for that day, or null.
 * @param {D1Database} db
 * @param {string} channel
 * @param {string} day
 */
export async function readBackup(db, channel, day) {
  await db.prepare(SCHEMA).run();
  const row = await db.prepare("SELECT data FROM backups WHERE channel = ? AND day = ?").bind(channel, day).first();
  if (!row) return null;
  // D1 returns a BLOB as an array of numbers.
  const bytes = new Uint8Array(/** @type {ArrayLike<number>} */ (row.data));
  return JSON.parse(await through(new Blob([bytes]).stream(), new DecompressionStream("gzip")).text());
}
