// Durable EventSub dedupe. Twitch redelivers a message (same Twitch-Eventsub-Message-Id) when it didn't see a 2xx in time,
// possibly to another isolate or after the room restarted, so an in-memory Map alone can play a command twice or send the
// bot's reply twice. The room records the ids of command messages in its own SQLite (no extra Durable Object request),
// kept EVENTSUB_DEDUPE_MS: the same 10 minutes after which the Worker refuses a message by its Twitch timestamp
// (server/eventsub.js), so an id can't come back once it has been forgotten. Plain chat lines are not recorded (nothing
// but presence depends on them, and a row write each would add up in a busy chat).
export const EVENTSUB_DEDUPE_MS = 10 * 60_000;
const SWEEP_MS = 60_000;
const swept = new WeakMap();   // sql handle -> when it was last swept (the table exists once it has an entry)

// Records the id. True when it is new (play it), false when this room saw it within the last EVENTSUB_DEDUPE_MS.
export function claimMessage(sql, id, now) {
  if (!swept.has(sql)) { sql.exec("CREATE TABLE IF NOT EXISTS eventsub_seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL)"); swept.set(sql, 0); }
  // One statement, so it is atomic: a new id is inserted, a forgotten one (older than the window) is taken over, a live one returns nothing.
  const row = sql.exec("INSERT INTO eventsub_seen (id, at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at WHERE eventsub_seen.at <= ? RETURNING id", id, now, now - EVENTSUB_DEDUPE_MS).toArray()[0];
  if (now - swept.get(sql) > SWEEP_MS) { swept.set(sql, now); sql.exec("DELETE FROM eventsub_seen WHERE at <= ?", now - EVENTSUB_DEDUPE_MS); }
  return Boolean(row);
}
// A message that failed before it was handled can be redelivered: forget it so the retry is not taken for a duplicate.
export function releaseMessage(sql, id) { sql.exec("DELETE FROM eventsub_seen WHERE id = ?", id); }
