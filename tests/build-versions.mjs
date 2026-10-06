// After `cf build`: the copied public files load each other with ?v=<one hash>, so OBS's browser never keeps an old
// overlay module after a deploy (vite.config.js, versionPublicModules).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const out = '.cloudflare/output/v0/workers/default/assets';
const js = fs.readdirSync('public').filter((f) => f.endsWith('.js'));
const refs = [];
for (const f of fs.readdirSync('public').filter((f) => /\.(js|html)$/.test(f))) {
  const text = fs.readFileSync(path.join(out, f), 'utf8');
  for (const [, name, v] of text.matchAll(/["']\.\/([\w-]+\.js)(\?v=[0-9a-f]+)?["']/g)) if (js.includes(name)) refs.push({ f, name, v });
}
assert.ok(refs.some((r) => r.f === 'overlay.html' && r.name === 'overlay.js'), 'overlay.html loads overlay.js');
assert.ok(refs.some((r) => r.f === 'overlay.js' && r.name === 'cosmetics.js'), 'overlay.js imports cosmetics.js');
assert.deepEqual(refs.filter((r) => !r.v), [], 'every public module reference carries ?v=');
assert.equal(new Set(refs.map((r) => r.v)).size, 1, 'one version for all modules, so each loads once');
console.log(`PASS: ${refs.length} public module references carry ${refs[0].v}.`);
