// Lane D end-to-end check on the real Workers runtime (workerd via Miniflare), using the built bundle.
// It exercises worker.js -> uploads.js -> ChannelRoom SQLite storage with test-only secrets (never .dev.vars).
// Run after `bunx cf build`:  node tests/upload-workerd.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { makePng, b64 } from "./upload-helpers.mjs";

const root = new URL("../", import.meta.url);
const ORIGIN = "http://localhost",
  DEV = "test-only-dev-token-".padEnd(40, "x");
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: new URL(".cloudflare/output/v0/workers/default/bundle/index.js", root).pathname.replace(
      /^\/([A-Za-z]:)/,
      "$1",
    ),
    compatibilityDate: "2026-09-25",
    durableObjects: {
      ROOMS: { className: "ChannelRoom", useSQLite: true },
      AUTH: { className: "AuthStore", useSQLite: true },
    },
    bindings: {
      AUTH_SECRET: "test-only-auth-secret-not-real",
      INTERNAL_SECRET: "test-only-internal-secret-not-real",
      DEV_TOOLS_TOKEN: DEV,
      PUBLIC_ORIGIN: ORIGIN,
    },
    serviceBindings: {
      ASSETS: async (req) => {
        const path = new URL(req.url).pathname;
        try {
          return new Response(await readFile(new URL("public" + path, root)), {
            headers: { "Content-Type": path.endsWith(".json") ? "application/json" : "application/octet-stream" },
          });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      },
    },
  }),
);

let passed = 0;
const check = (name, fn) =>
  fn().then(() => {
    passed++;
    console.log("ok - " + name);
  });
try {
  // Seed an owner session straight into AuthStore (the same records /auth/callback writes).
  const auth = await mf.getDurableObjectNamespace("AUTH");
  const stub = auth.get(auth.idFromName("auth"));
  const cookieValue = "a".repeat(64),
    expires = Date.now() + 3600000;
  const put = (key, value) =>
    stub.fetch("https://auth/entry?key=" + encodeURIComponent(key), {
      method: "POST",
      headers: { "X-Mini-Internal": "test-only-internal-secret-not-real", "Content-Type": "application/json" },
      body: JSON.stringify({ value, expires }),
    });
  assert.equal((await put("owner:nesszerra", { id: "1" })).status, 200);
  assert.equal(
    (
      await put("session:" + createHash("sha256").update(cookieValue).digest("hex"), {
        user: { id: "1", login: "nesszerra", displayName: "nesszerra" },
      })
    ).status,
    200,
  );
  const cookie = "mini_session=" + cookieValue;
  const call = (path, method = "GET", data, extra = {}) =>
    mf.dispatchFetch(ORIGIN + path, {
      method,
      headers: {
        Cookie: cookie,
        ...(method !== "GET" ? { Origin: ORIGIN, "Content-Type": "application/json" } : {}),
        ...extra,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  const strip = (n) => Array.from({ length: n }, (_, i) => ({ x: i * 64, y: 0, w: 64, h: 64 }));
  const upload = (label, atlas = b64(makePng(256, 64)), extra = {}) =>
    call(
      "/api/assets/nesszerra",
      "POST",
      { label, mode: "frames", fps: 8, atlas, frames: strip(4), animations: { walk: strip(4), attack: strip(1) } },
      extra,
    );
  const bulk = { Authorization: "Bearer " + DEV }; // dev-token calls aren't counted by the 30-writes-a-minute limit, so the 25-character test can upload in bulk

  let firstId;
  await check("a valid PNG upload is stored and served back byte-for-byte", async () => {
    const png = makePng(256, 64);
    const r = await upload("Night Knight", b64(png));
    const body = await r.json();
    assert.equal(r.status, 201, JSON.stringify(body));
    firstId = body.item.id;
    const got = await mf.dispatchFetch(ORIGIN + "/api/assets/nesszerra/" + firstId); // public, no cookie
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);
  });
  await check("the merged catalog lists the custom character and profiles can pick it", async () => {
    const cat = await (await call("/api/catalog/nesszerra")).json();
    assert.ok(
      cat.some((c) => c.id === "toon-ranger"),
      "static roster present",
    );
    assert.ok(
      cat.some((c) => c.id === firstId && c.custom),
      "custom entry present",
    );
    const saved = await call("/api/profile/nesszerra", "POST", {
      avatar: firstId,
      color: "#336699",
      defaultAbility: "heavy",
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    const stat = await call("/api/profile/nesszerra", "POST", {
      avatar: "toon-ranger",
      color: "#336699",
      defaultAbility: "heavy",
    });
    assert.equal(stat.status, 200, "a new launch character is a valid avatar");
  });
  await check("non-PNG, oversize and too-many-frames uploads are refused", async () => {
    const gif = await upload("Gif", b64(Buffer.from("GIF89a" + "x".repeat(100))));
    assert.equal(gif.status, 415);
    const big = await upload("Big", b64(makePng(256, 64, { extra: [["tEXt", Buffer.alloc(1_572_864, 0x41)]] })));
    assert.equal(big.status, 413);
    const many = await call("/api/assets/nesszerra", "POST", {
      label: "Many",
      atlas: b64(makePng(1024, 384)),
      frames: Array.from({ length: 24 }, (_, i) => ({ x: (i % 8) * 128, y: Math.floor(i / 8) * 128, w: 128, h: 128 })),
      animations: { attack: [{ x: 0, y: 0, w: 10, h: 10 }] },
    });
    assert.equal(many.status, 400);
    assert.equal((await many.json()).reason, "too_many_frames");
  });
  await check("the 25th character is refused, a delete frees a slot", async () => {
    for (let i = 2; i <= 24; i++) assert.equal((await upload("Knight " + i, undefined, bulk)).status, 201);
    const extra = await upload("Knight 25", undefined, bulk);
    assert.equal(extra.status, 409);
    assert.equal((await extra.json()).reason, "custom_limit_reached");
    const admin = await (await call("/api/admin/nesszerra")).json();
    assert.equal(admin.customUsage.count, 24);
    const del = await call("/api/assets/nesszerra/" + firstId, "DELETE", undefined, bulk);
    assert.equal(del.status, 200);
    assert.equal((await del.json()).usage.count, 23);
    assert.equal((await upload("Knight 25", undefined, bulk)).status, 201);
  });
  await check("the 31st write in a minute is refused with 429 and Retry-After, reads still work", async () => {
    // 6 session writes so far (1 upload, 2 profile saves, 3 refused uploads); the dev-token ones above were not counted
    for (let i = 7; i <= 30; i++)
      assert.equal(
        (
          await call("/api/profile/nesszerra", "POST", {
            avatar: "toon-ranger",
            color: "#336699",
            defaultAbility: "heavy",
          })
        ).status,
        200,
        "write " + i,
      );
    const refused = await call("/api/profile/nesszerra", "POST", {
      avatar: "toon-ranger",
      color: "#336699",
      defaultAbility: "heavy",
    });
    assert.equal(refused.status, 429);
    const body = await refused.json();
    assert.equal(body.reason, "rate_limited");
    assert.equal(refused.headers.get("retry-after"), String(body.retryAfter));
    assert.equal((await call("/api/profile/nesszerra")).status, 200, "a read is not counted");
    assert.equal((await call("/api/catalog/nesszerra")).status, 200);
  });
  await check("signed-out and cross-origin uploads are refused", async () => {
    const anon = await mf.dispatchFetch(ORIGIN + "/api/assets/nesszerra", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(anon.status, 401);
    const cross = await call("/api/assets/nesszerra", "POST", {}, { Origin: "https://evil.example" });
    assert.equal(cross.status, 403);
  });
  console.log("# pass " + passed);
} finally {
  await mf.dispose();
}
