// The changelog page (changelog/index.html) against package.json: the newest release is the version that ships.
// Run with: node --import ./tests/register.ts --test tests/changelog.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";

const read = (file: string) => readFileSync(new NodeURL("../" + file, import.meta.url), "utf8");
// Comments are dropped so the format note at the top of the page isn't read as a release.
const html = read("changelog/index.html").replace(/<!--[\s\S]*?-->/g, "");
// as: package.json is ours and always has a version string
const { version } = JSON.parse(read("package.json")) as { version: string };

/** One release section as the page writes it: its anchor, the version in its heading and its date. */
type Release = { id: string; version: string; date: string; items: number };
const releases: Release[] = [...html.matchAll(/<section class="release" id="([^"]+)"[\s\S]*?<\/section>/g)].map(
  ([block, id]) => ({
    id: id ?? "",
    version: /<h2[^>]*><span class="num">([^<]+)<\/span>/.exec(block)?.[1] ?? "",
    date: /<time datetime="([^"]+)">/.exec(block)?.[1] ?? "",
    items: (block.match(/<li>/g) || []).length,
  }),
);
const semver = (v: string) => v.split(".").map(Number);
const newer = (a: string, b: string) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

test("the newest release on the changelog is package.json's version", () => {
  assert.ok(releases.length > 0, "the page lists releases");
  assert.equal(releases[0]?.version, version);
  assert.match(html, new RegExp('<span class="num" id="current-version">' + version.replace(/\./g, "\\.") + "</span>"));
});

test("every release has a semver version, its anchor, a real date and at least one change", () => {
  for (const r of releases) {
    assert.match(r.version, /^\d+\.\d+\.\d+$/, r.id);
    assert.equal(r.id, "v" + r.version);
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, r.id);
    assert.ok(!Number.isNaN(Date.parse(r.date)), r.id);
    assert.ok(r.items > 0, r.id + " lists a change");
    assert.match(html, new RegExp('<a href="#' + r.id.replace(/\./g, "\\.") + '">'), r.id + " is in the index");
  }
});

test("releases go newest first: versions strictly down, dates never up", () => {
  for (let i = 1; i < releases.length; i++) {
    const [a, b] = [releases[i - 1], releases[i]];
    assert.ok(a && b);
    assert.ok(newer(a.version, b.version), a.version + " comes before " + b.version);
    assert.ok(a.date >= b.date, a.version + " is not older than " + b.version);
  }
});
