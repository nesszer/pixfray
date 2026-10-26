// Cosmetic ids shared by the Worker (server/cosmetics.ts) and the overlay drawings (src/served/cosmetics.ts). Its own
// file because it imports both a Worker module and a DOM module (tsconfig.node-all.json).
import test from "node:test";
import assert from "node:assert/strict";

test("cosmetic ids: the overlay drawings (src/served/cosmetics.ts) match the server lists", async () => {
  const server = await import("../server/cosmetics.ts");
  const client = await import("../src/served/cosmetics.ts");
  for (const kind of server.COSMETIC_KINDS) {
    const ids = server.COSMETICS[kind].map((x) => x.id);
    assert.deepEqual(client.COSMETIC_IDS[kind], ids, kind);
  }
  const taunts = server.COSMETICS.taunt.map((x) => x.id);
  const titles = server.COSMETICS.title.map((x) => x.label);
  assert.deepEqual(Object.keys(client.TAUNTS), taunts);
  assert.deepEqual(Object.values(client.TITLES), titles);
});
