// The served modules step (scripts/lib/served.ts, vite.config.js): import rewriting, the one ?v= hash, and the
// .js / .ts sources in src/served/.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { linkServed, servedSources, servedVersion, stripServed } from "../scripts/lib/served.ts";
import { overlayVersionFromHtml, overlayVersionFromUrl } from "../src/served/overlay.js";

const NAMES = ["overlay", "hats", "arena-client"];

test("served imports: ./x.ts and ./x.js of a served module point at ./x.js?v=<hash>, keeping their quotes", () => {
  const v = "0123456789";
  assert.equal(
    linkServed(`import { drawHat } from "./hats.ts";\nimport { a } from './arena-client.js';`, NAMES, v),
    `import { drawHat } from "./hats.js?v=${v}";\nimport { a } from './arena-client.js?v=${v}';`,
  );
  assert.equal(
    linkServed('<script type="module" src="./overlay.js"></script>', NAMES, v),
    `<script type="module" src="./overlay.js?v=${v}"></script>`,
  );
});

test("served imports: other paths and unknown modules stay as written", () => {
  const text = [
    'fetch("./assets/characters.json");',
    'import x from "../hats.js";',
    'import y from "./three.js";',
    'import z from "./hats.mjs";',
    "const t = `./hats.js`;",
  ].join("\n");
  assert.equal(linkServed(text, NAMES, "0123456789"), text);
});

test("served imports: the dev server links without a version", () => {
  assert.equal(linkServed('import "./hats.ts";', NAMES, ""), 'import "./hats.js";');
  assert.equal(linkServed('import "./hats.js";', NAMES, ""), 'import "./hats.js";');
});

test("served code: types stripped, comments kept", async () => {
  assert.equal(
    await stripServed("pets.ts", '// Pets.\nexport const PETS: string[] = ["cat"];\n'),
    '// Pets.\nexport const PETS = ["cat"];\n',
  );
  assert.notEqual(
    await stripServed("pets.js", '// Pets!\nexport const PETS = ["cat"];\n'),
    await stripServed("pets.js", '// Pets.\nexport const PETS = ["cat"];\n'),
    "a changed comment changes the served code, so the version too",
  );
});

test("served version: 10 lowercase hex digits the overlay's own check reads, changing only with served code", async () => {
  const js = await stripServed("hats.js", "// Hats.\nexport const HATS = [1, 2];\n");
  const ts = await stripServed("hats.ts", "// Hats.\nexport const HATS: number[] = [1, 2];\n");
  assert.equal(ts, js, "a .ts source that only adds types serves the same code");
  const v = servedVersion([
    { name: "overlay", code: "export const o = 1;\n" },
    { name: "hats", code: js },
  ]);
  assert.match(v, /^[0-9a-f]{10}$/);
  assert.equal(
    servedVersion([
      { name: "hats", code: ts },
      { name: "overlay", code: "export const o = 1;\n" },
    ]),
    v,
    "the same code in any order or source language gives the same version",
  );
  assert.notEqual(
    servedVersion([
      { name: "overlay", code: "export const o = 2;\n" },
      { name: "hats", code: js },
    ]),
    v,
  );
  assert.notEqual(servedVersion([{ name: "hats", code: js }]), v, "a module added or removed changes it");
  assert.equal(
    servedVersion([
      { name: "overlay", code: 'import { HATS } from "./hats.ts";\n' },
      { name: "hats", code: js },
    ]),
    servedVersion([
      { name: "overlay", code: 'import { HATS } from "./hats.js";\n' },
      { name: "hats", code: js },
    ]),
    "a port that switches ./hats.js to ./hats.ts keeps the version",
  );
  const html = linkServed('<script type="module" src="./overlay.js"></script>', NAMES, v);
  assert.equal(overlayVersionFromHtml(html), v);
  assert.equal(overlayVersionFromUrl(`https://pixfray.xyz/overlay.js?v=${v}`), v);
});

test("served sources: .js and .ts in name order; one name with both is refused", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "served-"));
  for (const f of ["overlay.js", "hats.ts", "notes.md", "a.d.ts.map"]) writeFileSync(path.join(dir, f), "");
  assert.deepEqual(servedSources(dir), [
    { name: "hats", file: path.join(dir, "hats.ts") },
    { name: "overlay", file: path.join(dir, "overlay.js") },
  ]);
  writeFileSync(path.join(dir, "hats.js"), "");
  assert.throws(() => servedSources(dir), /hats\.js and hats\.ts would both be served as \/hats\.js/);
});

test("served sources: the repo serves the overlay modules from src/served/", () => {
  assert.deepEqual(
    servedSources().map((m) => m.name),
    ["arena-client", "atlas", "chat", "cosmetics", "hats", "overlay", "pets", "upload"],
  );
});
