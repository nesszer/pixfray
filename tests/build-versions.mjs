// After `cf build`: the served modules (src/served/, vite.config.js served-modules) are at the output root under their
// URL names and load each other, and overlay.html loads the overlay, with ?v=<one 10-hex hash>, so OBS's browser never
// keeps an old overlay module after a deploy. The overlay reloads itself when that hash changes (src/served/overlay.js).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { servedSources } from "../scripts/lib/served.ts";
const out = ".cloudflare/output/v0/workers/default/assets";
const names = servedSources().map((m) => m.name);
for (const name of ["overlay", "chat", "arena-client", "hats", "pets", "cosmetics", "atlas", "upload"])
  assert.ok(names.includes(name), `src/served/ holds ${name}`);
const files = [...names.map((name) => name + ".js"), ...fs.readdirSync("public").filter((f) => f.endsWith(".html"))];
const refs = [];
for (const f of files) {
  assert.ok(fs.existsSync(path.join(out, f)), `${f} is in the build output`);
  const text = fs.readFileSync(path.join(out, f), "utf8");
  assert.doesNotMatch(text, /["']\.\/[\w-]+\.ts["']/, `${f} names no .ts module`);
  for (const [, name, v] of text.matchAll(/["']\.\/([\w-]+)\.js(?:\?v=([^"']*))?["']/g))
    if (names.includes(name)) refs.push({ f, name, v });
}
assert.ok(
  refs.some((r) => r.f === "overlay.html" && r.name === "overlay"),
  "overlay.html loads overlay.js",
);
assert.ok(
  refs.some((r) => r.f === "overlay.js" && r.name === "cosmetics"),
  "overlay.js imports cosmetics.js",
);
assert.ok(
  refs.some((r) => r.f === "upload.js" && r.name === "atlas"),
  "upload.js imports atlas.js",
);
assert.deepEqual(
  refs.filter((r) => !/^[0-9a-f]{10}$/.test(r.v ?? "")),
  [],
  "every served module reference carries ?v=<10 lowercase hex>",
);
assert.equal(new Set(refs.map((r) => r.v)).size, 1, "one version for all modules, so each loads once");
console.log(`PASS: ${refs.length} served module references carry ${refs[0].v}.`);
