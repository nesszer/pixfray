// Daily backups. Once a day (the cron trigger in cloudflare.config.ts) every channel room writes its export, the same
// JSON as the owner page's download, gzipped into the BACKUPS D1 database: one row per channel per day, kept
// BACKUP_DAYS. That outlives the rooms' 30-day point-in-time restore, and one fighter can be read back from any day
// without rolling a whole channel back. Each room writes its own row, so the cron run itself only makes one call per
// channel and stays inside the Free plan's per-invocation limits. Owner routes: /api/dev/backups (docs/CONTRACTS.md).

import { CHANNELS } from "./auth.ts";
import { listRecords } from "./channels.ts";
import { parseBackupExport } from "./parse.ts";
import type { Env } from "./env.ts";
import type { Parsed } from "./parse.ts";

/** One channel's outcome in a backup run. */
export type BackupResult =
  | { channel: string; ok: true; bytes: number | undefined }
  | { channel: string; ok: false; reason: string };
/** A stored day, newest first in listBackups. */
export type BackupRow = { day: string; at: number; bytes: number };
/**
 * A channel room's export, as stored (the owner page's download). Only the fields developer.ts reads are named;
 * the room's export code is the full shape. exportedAt is the ISO time of exportHead in developer.ts.
 */
export type BackupExport = {
  exportedAt: string;
  profiles: { userId: string; username: string }[];
  purchases: { userId: string }[];
  builds: { userId: string }[];
  [key: string]: unknown;
};
/** What a room answers to POST /dev/backup. */
type BackupReply = { bytes?: number; reason?: string; error?: string };

export const BACKUP_DAYS = 90;
const DAY_MS = 86400000;
const SCHEMA =
  "CREATE TABLE IF NOT EXISTS backups (channel TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (channel, day))";
export const backupDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

const through = (stream: ReadableStream<Uint8Array>, codec: CompressionStream | DecompressionStream): Response =>
  new Response(stream.pipeThrough(codec));

/** Called by the channel room. Returns the stored (gzipped) size in bytes. */
export async function writeBackup(db: D1Database, channel: string, at: number, data: unknown): Promise<number> {
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
 * BACKUP_DAYS. A room that fails is reported and the rest still run. Callers check env.BACKUPS first.
 */
export async function backupChannels(
  env: Env,
  at: number,
  roomFetch: (channel: string, path: string, init: RequestInit) => Promise<Response>,
  only = "",
): Promise<BackupResult[]> {
  const records = await listRecords(env, "channel:");
  const status = new Map<string, "builtin" | "paused" | "on">(CHANNELS.map((login) => [login, "builtin"]));
  for (const { value } of records)
    if (value?.login && !status.has(value.login)) status.set(value.login, value.pausedAt ? "paused" : "on");
  const results: BackupResult[] = [];
  for (const [channel, state] of status) {
    if (only && channel !== only) continue;
    try {
      const r = await roomFetch(channel, "/dev/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ at, status: state }),
      });
      const body = await r.json<BackupReply>().catch((): BackupReply => ({}));
      results.push(
        r.ok
          ? { channel, ok: true, bytes: body.bytes }
          : { channel, ok: false, reason: body.reason || body.error || "HTTP " + r.status },
      );
    } catch (e) {
      results.push({ channel, ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  const db = env.BACKUPS!; // !: worker.ts scheduled() and developer.ts backupsRun check env.BACKUPS first
  await db.batch([
    db.prepare(SCHEMA),
    db.prepare("DELETE FROM backups WHERE day < ?").bind(backupDay(at - BACKUP_DAYS * DAY_MS)),
  ]);
  return results;
}

/** Newest first. */
export async function listBackups(db: D1Database, channel: string): Promise<BackupRow[]> {
  await db.prepare(SCHEMA).run();
  const { results } = await db
    .prepare("SELECT day, at, bytes FROM backups WHERE channel = ? ORDER BY day DESC")
    .bind(channel)
    .all<BackupRow>();
  return results;
}

/** The stored export for that day, refused as invalid_backup when it does not unpack to one (parseBackupExport), or null. */
export async function readBackup(db: D1Database, channel: string, day: string): Promise<Parsed<BackupExport> | null> {
  await db.prepare(SCHEMA).run();
  const row = await db
    .prepare("SELECT data FROM backups WHERE channel = ? AND day = ?")
    .bind(channel, day)
    .first<{ data: number[] }>();
  if (!row) return null;
  let text = "";
  try {
    // D1 returns a BLOB as an array of numbers.
    const bytes = new Uint8Array(row.data);
    text = await through(new Blob([bytes]).stream(), new DecompressionStream("gzip")).text();
  } catch {
    // not gzip: the empty text is refused below like any other unreadable backup
  }
  return parseBackupExport(text);
}
