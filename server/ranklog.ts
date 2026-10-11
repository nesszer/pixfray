// Rank history: one rank_log row each time a stored profile's elo, wins or losses changes, written by SQLite triggers
// on profiles, so every path that changes a rank (duels, resets, restores, a buggy save) is recorded without remembering
// to call anything. Rows older than RANK_LOG_DAYS are pruned when the room starts. Owner reads: GET /api/dev/ranks;
// restoreRank {userId, before} puts a fighter back to its last row before a time (docs/CONTRACTS.md).

export const RANK_LOG_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const ROW = `INSERT INTO rank_log (at, user_id, username, elo, wins, losses)
  VALUES (${NOW_MS}, NEW.user_id, NEW.username, NEW.elo, NEW.wins, NEW.losses)`;

/** One rank_log row as rankHistory returns it (GET /api/dev/ranks). */
export type RankRow = { at: number; userId: string; username: string; elo: number; wins: number; losses: number };
/** A fighter's rank: what rankBefore returns and restoreRank puts back. */
export type Rank = { elo: number; wins: number; losses: number };

/** Called from ChannelRoom's constructor, after the profiles table exists. */
export function ensureRankLogSchema(sql: SqlStorage, now: number): void {
  const fresh = !sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rank_log'").toArray().length;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS rank_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user_id TEXT NOT NULL, username TEXT NOT NULL, elo INTEGER NOT NULL, wins INTEGER NOT NULL, losses INTEGER NOT NULL)",
  );
  sql.exec("CREATE INDEX IF NOT EXISTS rank_log_user ON rank_log(user_id, at)");
  sql.exec("CREATE INDEX IF NOT EXISTS rank_log_at ON rank_log(at)");
  sql.exec(`CREATE TRIGGER IF NOT EXISTS rank_log_insert AFTER INSERT ON profiles BEGIN ${ROW}; END`);
  sql.exec(
    `CREATE TRIGGER IF NOT EXISTS rank_log_update AFTER UPDATE OF elo, wins, losses ON profiles
     WHEN NEW.elo IS NOT OLD.elo OR NEW.wins IS NOT OLD.wins OR NEW.losses IS NOT OLD.losses BEGIN ${ROW}; END`,
  );
  // A room that had fighters before rank_log existed starts its history from their current ranks.
  if (fresh)
    sql.exec(
      "INSERT INTO rank_log (at, user_id, username, elo, wins, losses) SELECT ?, user_id, username, elo, wins, losses FROM profiles",
      now,
    );
  sql.exec("DELETE FROM rank_log WHERE at < ?", now - RANK_LOG_DAYS * DAY_MS);
}

/** Newest first. `user` is a login or a user id. */
export function rankHistory(sql: SqlStorage, user: string, limit: number): RankRow[] {
  return sql
    .exec<RankRow>(
      "SELECT at, user_id AS userId, username, elo, wins, losses FROM rank_log WHERE user_id = ? OR username = ? COLLATE NOCASE ORDER BY at DESC, id DESC LIMIT ?",
      user,
      user,
      limit,
    )
    .toArray();
}

/** The fighter's last recorded rank strictly before `at`, or null. */
export function rankBefore(sql: SqlStorage, userId: string, at: number): Rank | null {
  const row = sql
    .exec<Rank>(
      "SELECT elo, wins, losses FROM rank_log WHERE user_id = ? AND at < ? ORDER BY at DESC, id DESC LIMIT 1",
      userId,
      at,
    )
    .toArray()[0];
  return row ? { elo: Number(row.elo), wins: Number(row.wins), losses: Number(row.losses) } : null;
}
