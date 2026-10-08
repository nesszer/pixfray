// Per-user write limit: 30 writes per minute for profile saves, shop buys, uploads and admin changes.
// The counter lives in AuthStore (one global Durable Object, so the count follows the user across isolates and channels):
// the Worker makes one extra DO request per write (POST /hit), and AuthStore updates the count in a single synchronous
// step, so two requests at once can't both read the same count. Counts are rows in AuthStore's `entries` table with a
// short expiry, so its hourly alarm removes them with everything else that has expired.
export const WRITE_LIMIT = 30,
  WINDOW_MS = 60000;

// Inside AuthStore (POST /hit?key=<user>): a sliding window made of two fixed windows. The previous window counts for
// the share of it that still lies inside the last windowMs, so a burst split across a minute boundary can't double up.
// A refused request is not counted, so waiting retryAfter seconds is enough. Returns { limited, retryAfter }.
export async function hit(ctx, key, limit = WRITE_LIMIT, windowMs = WINDOW_MS, now = Date.now()) {
  limit = Math.min(Math.max(Math.floor(limit) || WRITE_LIMIT, 1), 10000);
  windowMs = Math.min(Math.max(Math.floor(windowMs) || WINDOW_MS, 1000), 3600000);
  const sql = ctx.storage.sql,
    w = Math.floor(now / windowMs),
    frac = (now % windowMs) / windowMs;
  const slot = (n) => "rl:" + key + ":" + n;
  const read = (n) =>
    Number(sql.exec("SELECT value FROM entries WHERE key=? AND expires>?", slot(n), now).toArray()[0]?.value) || 0;
  const cur = read(w),
    prev = read(w - 1);
  if (cur + prev * (1 - frac) + 1 > limit) {
    // When room opens up: this window if it still has space for one more (only the previous window's share must fade),
    // otherwise the next window, where this one becomes the previous.
    const [fixed, before, at] = cur + 1 <= limit ? [cur, prev, w] : [0, cur, w + 1],
      need = limit - 1 - fixed;
    const f = before > 0 && need < before ? 1 - need / before : 0;
    return { limited: true, retryAfter: Math.max(1, Math.ceil(((at + f) * windowMs - now) / 1000)) };
  }
  sql.exec(
    "INSERT INTO entries(key,value,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=excluded.expires",
    slot(w),
    String(cur + 1),
    (w + 2) * windowMs,
  );
  if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(now + 3600000);
  return { limited: false, retryAfter: 0 };
}

// In the Worker: null when the user may write, else the 429 to return. Dev-token requests never get here (worker.js).
// If AuthStore can't be reached the write goes through: the same outage already stops sign-in and every other call.
export async function writeLimit(env, userId, { limit = WRITE_LIMIT, windowMs = WINDOW_MS } = {}) {
  let result = null;
  try {
    const res = await env.AUTH.get(env.AUTH.idFromName("auth")).fetch(
      "https://auth/hit?key=" + encodeURIComponent("w:" + userId),
      {
        method: "POST",
        headers: { "X-Mini-Internal": env.INTERNAL_SECRET, "Content-Type": "application/json" },
        body: JSON.stringify({ limit, windowMs }),
      },
    );
    if (res.ok) result = await res.json();
  } catch (error) {
    console.warn("write limit check failed", error?.message);
  }
  if (!result?.limited) return null;
  const retryAfter = Number(result.retryAfter) || 1;
  return Response.json(
    { error: "Too many changes in a minute. Try again in " + retryAfter + " s.", reason: "rate_limited", retryAfter },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    },
  );
}
