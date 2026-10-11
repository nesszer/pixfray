// Seeds test-only Twitch sessions into a LOCAL AuthStore (Miniflare sqlite), so local runs can act as the owner and viewers
// without Twitch. Run it only while no dev server holds that state folder. Never point it at real data.
// Usage: node tests/seed-local.ts [stateDir]   (default .cloudflare/e2e-state). Prints the test cookies as JSON.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
export const users = {
  owner: { id: "900001", login: "nesszerra", displayName: "nesszerra" },
  alice: { id: "900101", login: "alice_e2e", displayName: "Alice_E2E" },
  bob: { id: "900102", login: "bob_e2e", displayName: "Bob_E2E" },
  carol: { id: "900103", login: "carol_e2e", displayName: "Carol_E2E" },
};
// as Record: the entries are built from the keys of users, so there is one cookie for each user
export const cookies = Object.fromEntries(
  Object.keys(users).map((k) => [k, sha("mini-chat-local-test-session:" + k)]),
) as Record<keyof typeof users, string>; // as Record: one cookie per user
export function seed(stateDir = ".cloudflare/e2e-state") {
  const dir = path.join(stateDir, "v3", "do", "nesszerra-mini-chat-AuthStore");
  const file = fs.existsSync(dir) && fs.readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (!file)
    throw new Error(
      "No local AuthStore yet in " +
        dir +
        ": start the dev server once and request /api/session with any mini_session cookie",
    );
  const db = new DatabaseSync(path.join(dir, file));
  db.exec("CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)");
  const put = db.prepare(
    "INSERT INTO entries(key,value,expires) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires=excluded.expires",
  );
  const expires = Date.now() + 6 * 3600000;
  for (const [k, user] of Object.entries(users))
    // as keyof: k comes from Object.entries(users), so it is one of its keys
    put.run(
      "session:" + sha(cookies[k as keyof typeof users]), // as keyof: k is a key of users
      JSON.stringify({ user, createdAt: Date.now() }),
      expires,
    );
  put.run("owner:nesszerra", JSON.stringify({ id: users.owner.id }), expires);
  db.close();
  return cookies;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"))
)
  console.log(JSON.stringify(seed(process.argv[2])));
