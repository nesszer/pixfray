// Lane D: the static character catalog, its atlases, licenses and the reserve list.
// Run with: node --import ./tests/register.mjs --test tests/content.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { readPng } from '../server/uploads.js';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root));
const catalog = JSON.parse(read('public/assets/characters.json').toString('utf8'));
const licenses = read('docs/ASSET_LICENSES.md').toString('utf8');
const rect = (f) => f && [f.x, f.y, f.w, f.h].every(Number.isInteger) && f.w > 0 && f.h > 0 && f.x >= 0 && f.y >= 0;

test('the roster has 15 launch characters plus the v3 additions, with unique ids', () => {
  assert.ok(Array.isArray(catalog));
  assert.ok(catalog.length >= 15 && catalog.length <= 60, 'got ' + catalog.length);
  const labels = catalog.map((c) => c.label.toLowerCase());
  assert.equal(new Set(labels).size, labels.length, 'labels are unique');
  const ids = catalog.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z0-9-]{1,40}$/);
  for (const id of ids) assert.doesNotMatch(id, /^c-/, 'c- ids are reserved for custom uploads');
});

test('every entry has the CatalogEntry shape', () => {
  for (const c of catalog) {
    assert.equal(typeof c.label, 'string', c.id);
    assert.ok(c.label.length > 0 && c.label.length <= 32, c.id);
    assert.match(c.url, /^\/assets\/[a-z0-9-]+\.png$/, c.id);
    assert.ok(Array.isArray(c.frames) && c.frames.length, c.id + ' frames');
    assert.ok(Number.isInteger(c.fps) && c.fps >= 1 && c.fps <= 30, c.id + ' fps');
    assert.deepEqual(c.anchor, { x: 0.5, y: 1 }, c.id);
    assert.equal(c.license, 'CC0-1.0', c.id);
    assert.match(c.source, /^https:\/\//, c.id);
    for (const name of Object.keys(c.animations || {})) assert.ok(['idle', 'walk', 'attack', 'ko', 'jump', 'cheer'].includes(name), c.id + ' animation ' + name);
    if (!c.animations?.attack) assert.equal(c.combatFallback, 'effects', c.id + ' has no attack frames, so it must be flagged for effects');
  }
});

test('every frame rectangle sits inside its atlas image', () => {
  for (const c of catalog) {
    const file = new URL('public' + c.url, root);
    assert.ok(existsSync(file), c.url + ' exists');
    const { width, height } = readPng(new Uint8Array(readFileSync(file)));   // also proves the file is a real PNG
    const all = [['frames', c.frames], ...Object.entries(c.animations || {})];
    for (const [name, list] of all) {
      assert.ok(Array.isArray(list) && list.length, c.id + ' ' + name + ' is a non-empty list');
      for (const f of list) {
        assert.ok(rect(f), c.id + ' ' + name + ' frame ' + JSON.stringify(f));
        assert.ok(f.x + f.w <= width && f.y + f.h <= height, c.id + ' ' + name + ' frame ' + JSON.stringify(f) + ' outside ' + width + 'x' + height);
      }
    }
  }
});

test('combat-ready characters exist and every character is licensed in ASSET_LICENSES.md', () => {
  assert.ok(catalog.filter((c) => c.animations?.attack && c.animations?.ko).length >= 5, 'at least five characters have drawn attack and ko frames');
  for (const c of catalog) {
    assert.ok(licenses.includes('`' + c.id + '`'), c.id + ' is listed in ASSET_LICENSES.md');
    assert.ok(licenses.includes(c.url.split('/').pop()), c.url + ' file is listed in ASSET_LICENSES.md');
    assert.ok(licenses.includes(c.source), c.source + ' is listed in ASSET_LICENSES.md');
  }
  for (const notice of ['KENNEY_LICENSE.txt', 'KENNEY_TOON_LICENSE.txt', 'KENNEY_PLATFORMER_ART_LICENSE.txt', 'KENNEY_NEW_PLATFORMER_LICENSE.txt', 'KENNEY_PIXEL_PLATFORMER_LICENSE.txt', 'KENNEY_ABSTRACT_PLATFORMER_LICENSE.txt', 'OGA_PZUH_LICENSE.txt', 'OGA_SOGOMN_LICENSE.txt', 'KENNEY_JUMPER_LICENSE.txt']) {
    const text = read('public/assets/' + notice).toString('utf8');
    assert.match(text, /CC0/, notice + ' states CC0');
    assert.ok(licenses.includes(notice), notice + ' is referenced');
  }
});

test('the reserve lists at least 25 characters, each with a source and license', () => {
  const doc = read('docs/CHARACTER_RESERVE.md').toString('utf8');
  const rows = doc.split('\n').filter((l) => /^\| \d+ \|/.test(l));
  assert.ok(rows.length >= 25, 'got ' + rows.length);
  const packs = doc.split('\n').filter((l) => /^\| .+ \| https:\/\/kenney\.nl\/assets\//.test(l));
  assert.ok(packs.length >= 1);
  for (const p of packs) assert.match(p, /CC0/);
  const packNames = packs.map((p) => p.split('|')[1].trim().replace(/ \(.*\)$/, ''));
  for (const r of rows) assert.ok(packNames.some((n) => r.includes('| ' + n + ' |')), 'reserve row has a vetted pack: ' + r.slice(0, 60));
  const launched = new Set(catalog.map((c) => c.label.toLowerCase()));
  for (const r of rows) assert.ok(!launched.has(r.split('|')[2].trim().toLowerCase()), 'reserve does not repeat a launch character');
});
