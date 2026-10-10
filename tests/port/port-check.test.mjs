// scripts/port-check.ts and scripts/port-rename.ts against small git repos: each test commits a base on main, changes
// it on a branch, and checks the exact report and exit code. The tests run at once, since each spends about a second
// waiting on git and node, and the build tests about ten. Every repo lives in the OS temp folder and is not removed
// (files are never deleted by script here; see AGENTS.md), so a test that needs a file gone moves it out of the repo.
// `bun run test:port` runs this file; `bun run check` leaves it out to stay fast.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts", "port-check.ts");
const RENAME = path.join(ROOT, "scripts", "port-rename.ts");
const OXLINT = path.join(ROOT, "node_modules", "oxlint", "bin", "oxlint");

// The pre-commit hook runs these tests with GIT_DIR and GIT_INDEX_FILE pointing at the PixFray repo. Passed on, they
// would make `git init` in a temp folder re-initialize that repo as bare and commit the fixtures into it.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

async function git(dir, ...args) {
  const { stdout } = await run("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
    cwd: dir,
    env: ENV,
  });
  return stdout;
}

function write(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
}

/** Moves `file` out of the repo, next to it, so the working tree no longer has it. */
function moveOut(dir, file) {
  renameSync(path.join(dir, file), `${dir}-${file.replaceAll("/", "-")}`);
}

/** A repo with `files` committed on main and a port branch checked out, in a new temp folder or in `dir`. */
async function repo(files, dir) {
  if (dir === undefined) {
    dir = mkdtempSync(path.join(tmpdir(), "pixfray-port-check-"));
    const outside = await git(dir, "rev-parse", "--show-toplevel").then(
      (top) => `inside ${top.trim()}`,
      (error) => (/not a git repository/.test(error.stderr) ? "outside" : error.stderr),
    );
    assert.equal(outside, "outside", "the temp folder is inside a git repo");
  }
  await git(dir, "init", "-q", "-b", "main");
  assert.equal(
    realpathSync((await git(dir, "rev-parse", "--show-toplevel")).trim()),
    realpathSync(dir),
    "fixture repo escaped",
  );
  await git(dir, "config", "core.autocrlf", "false");
  write(dir, files);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "base");
  await git(dir, "switch", "-q", "-c", "port/test");
  return dir;
}

function strictList(...files) {
  return `// Fixture: JSONC with a comment and a trailing comma.\n{ "files": [${files.map((f) => `"${f}"`).join(", ")},] }\n`;
}

/** The Cloudflare Vite plugin, imported by its full URL: a build fixture has no node_modules of its own. */
const PLUGIN = import.meta.resolve("@cloudflare/vite-plugin");
const PAGE = '<!doctype html><title>x</title><script type="module" src="/src/main.js"></script>\n';

/** A build fixture's cloudflare.config.ts, with its Worker at `entry`. */
function cloudflareConfig(entry = "./server/worker.js") {
  return `export default {\n  worker: { name: "fixture", compatibilityDate: "2026-09-25", entrypoint: "${entry}", assets: { notFoundHandling: "404-page" } },\n};\n`;
}

/** A repo that `bunx cf build` builds with its own minimal configs: a page, a Worker at the entrypoint
 * cloudflare.config.ts names and a public/ overlay, then `files` (a null entry leaves a file out). cf reads the empty
 * bun.lock to pick bunx, and the package.json to check the plugin and Vite are declared; both load from this repo's
 * node_modules (see BUILD_ENV). */
async function buildRepo(files) {
  const all = {
    "package.json": `${JSON.stringify({ private: true, type: "module", devDependencies: { "@cloudflare/vite-plugin": "beta", vite: "8.3.0" } })}\n`,
    "bun.lock": "",
    "vite.config.js": `import { cloudflare } from "${PLUGIN}";\nexport default { plugins: [cloudflare()] };\n`,
    "cloudflare.config.ts": cloudflareConfig(),
    ".gitignore": "node_modules/\n.cloudflare/\n.wrangler/\n.port-check/\n",
    "tsconfig.strict.json": strictList(),
    "tsconfig.node.json": '{ "include": ["vite.config.js", "cloudflare.config.ts"] }\n',
    "index.html": PAGE,
    "src/main.js": 'console.log("page");\n',
    "server/worker.js": 'export default { fetch() { return new Response("ok"); } };\n',
    "public/overlay.html": '<script type="module" src="./overlay.js"></script>\n',
    "public/overlay.js": "// The overlay.\nexport const overlay = 1;\n",
    ...files,
  };
  return repo(Object.fromEntries(Object.entries(all).filter(([, text]) => text !== null)));
}

/** A folder holding a `cf` that builds for real in the base checkout (under .port-check/) and, at head, exits 0
 * having written nothing: `cf` for Linux, `cf.cmd` for Windows. */
function fakeCf() {
  const dir = mkdtempSync(path.join(tmpdir(), "pixfray-fake-cf-"));
  const real = path.join(ROOT, "node_modules", "cf", "bin", "cf");
  write(dir, {
    cf: [
      "#!/usr/bin/env node",
      'const { spawnSync } = require("node:child_process");',
      'if (!process.cwd().includes(".port-check")) process.exit(0);',
      `const result = spawnSync(process.execPath, [${JSON.stringify(real)}, ...process.argv.slice(2)], { stdio: "inherit" });`,
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
    "cf.cmd": '@node "%~dp0cf" %*\r\n',
  });
  chmodSync(path.join(dir, "cf"), 0o755);
  return dir;
}

/** `env` with `dirs` put first on its PATH, whatever case Windows gave the key. */
function withPath(env, ...dirs) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  return { ...env, [key]: [...dirs, env[key]].join(path.delimiter) };
}

/** bunx finds cf and Vite on PATH once a fixture's own node_modules/.bin has nothing: this repo's, by path. */
const BUILD_ENV = withPath(ENV, path.join(ROOT, "node_modules", ".bin"));

/** Runs a script in `dir`. A non-zero exit rejects with an error that carries the same stdout and stderr. */
async function node(dir, ...args) {
  return nodeWith(ENV, dir, ...args);
}

async function nodeWith(env, dir, ...args) {
  const result = await run(process.execPath, args, { cwd: dir, env }).catch((error) => error);
  return { status: typeof result.code === "number" ? result.code : 0, stdout: result.stdout, stderr: result.stderr };
}

const portCheck = (dir, env = BUILD_ENV) => nodeWith(env, dir, SCRIPT, "--base", "main");

describe("port-check", { concurrency: true }, () => {
  test("annotations, comments and type-only code strip to the same JavaScript", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList("pair.ts", "sum.ts"),
      "pair.ts": "export type Pair = [number, number];\n",
      "sum.ts": "// Adds two numbers.\nconst ZERO = 0;\nexport function sum(a, b) {\n  return a + b + ZERO;\n}\n",
    });
    write(dir, {
      "sum.ts": [
        'import type { Pair } from "./pair.ts";',
        "",
        "/** Adds two numbers that are already checked. */",
        "const ZERO = 0 as number;",
        "export function sum(a: number, b: number): number {",
        "  return a + b + ZERO; // plain addition",
        "}",
        "export type Sum = (pair: Pair) => number;",
        "",
      ].join("\n"),
    });
    assert.deepEqual(await portCheck(dir), { status: 0, stdout: "1 files compared, 0 different\n", stderr: "" });
  });

  test("an added typeof check is a runtime difference, reported at its source lines", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList("num.ts"),
      "num.js": "/**\n * @param {unknown} v\n */\nexport const toInt = (v) => (Number.isInteger(v) ? v : 0);\n",
    });
    renameSync(path.join(dir, "num.js"), path.join(dir, "num.ts"));
    write(dir, {
      "num.ts":
        'export const toInt = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) ? v : 0);\n',
    });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "num.js -> num.ts differs (base line 4, head line 1)",
        "  base: export const toInt = (v) => Number.isInteger(v) ? v : 0;",
        '  head: export const toInt = (v) => typeof v === "number" && Number.isInteger(v) ? v : 0;',
        "1 files compared, 1 different",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("a renamed file whose importers switch from .js to .ts specifiers is identical", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList("lib/util.ts", "main.ts"),
      "lib/util.js": "export function double(n) {\n  return n * 2;\n}\n",
      "main.js": 'import { double } from "./lib/util.js";\nexport const four = double(2);\n',
    });
    await git(dir, "mv", "lib/util.js", "lib/util.ts");
    await git(dir, "mv", "main.js", "main.ts");
    write(dir, {
      "lib/util.ts": "export function double(n: number): number {\n  return n * 2;\n}\n",
      "main.ts": 'import { double } from "./lib/util.ts";\nexport const four: number = double(2);\n',
    });
    await git(dir, "commit", "-q", "-am", "port");
    assert.deepEqual(await portCheck(dir), { status: 0, stdout: "2 files compared, 0 different\n", stderr: "" });
  });

  test("files moved to another folder pair by name, with their importers' paths followed", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList("src/served/overlay.ts"),
      "web/chat.js": "export const say = (text) => text.trim();\n",
      "web/overlay.js":
        'import { say } from "./chat.js";\nimport { clamp } from "../server/game.js";\nexport const hello = say(" hi ") + clamp(1);\n',
      "server/game.js": "export const clamp = (n) => Math.max(0, n);\n",
      "tests/overlay.test.mjs": 'import { hello } from "../web/overlay.js";\nconsole.log(hello);\n',
    });
    mkdirSync(path.join(dir, "src/served"), { recursive: true });
    await git(dir, "mv", "web/chat.js", "src/served/chat.js");
    await git(dir, "mv", "web/overlay.js", "src/served/overlay.ts");
    write(dir, {
      "src/served/overlay.ts":
        'import { say } from "./chat.js";\nimport { clamp } from "../../server/game.js";\nexport const hello: string = say(" hi ") + clamp(1);\n',
      "tests/overlay.test.mjs": 'import { hello } from "../src/served/overlay.ts";\nconsole.log(hello);\n',
    });
    await git(dir, "commit", "-q", "-am", "move");
    assert.deepEqual(await portCheck(dir), { status: 0, stdout: "3 files compared, 0 different\n", stderr: "" });
  });

  test("a moved file that git sees as a deletion plus an addition is still compared", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList("lib/rank.ts"),
      "server/rank.js": "export const START = 1000;\nexport const next = (elo) => elo + 16;\n",
    });
    moveOut(dir, "server/rank.js");
    write(dir, {
      "lib/rank.ts": [
        "/** Every fighter starts here. */",
        "export const START: number = 1000;",
        "/** One win, as a rating step. */",
        "export const next = (elo: number): number => elo + 32;",
        "",
      ].join("\n"),
    });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "server/rank.js -> lib/rank.ts differs (base line 2, head line 4)",
        "  base: export const next = (elo) => elo + 16;",
        "  head: export const next = (elo) => elo + 32;",
        "1 files compared, 1 different",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("a code file gone at head with nothing to pair fails, naming it", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList(),
      "gone.js": "export const gone = true;\n",
      "kept.js": "export const kept = true;\n",
    });
    moveOut(dir, "gone.js");
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout:
        "gone.js is gone at head and no new file pairs with it\n0 files compared, 0 different, 1 other problems\n",
      stderr: "",
    });
  });

  test("a new file passes only when it strips to no runtime code", async () => {
    const dir = await repo({ "tsconfig.strict.json": strictList("server/model.ts", "server/extra.ts") });
    write(dir, {
      "server/model.ts": "export type Fighter = { id: string; elo: number };\n",
      "server/extra.ts": "export type Id = string;\nexport const id = (value: string): Id => value;\n",
    });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: "server/extra.ts is new and has runtime code (head line 2)\n2 files compared, 1 different\n",
      stderr: "",
    });
  });

  test("two files that could pair by the same name fail instead of guessing", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList("c/x.ts"),
      "a/x.js": "export const x = 1;\n",
      "b/x.js": "export const x = 2;\n",
    });
    mkdirSync(path.join(dir, "c"));
    await git(dir, "mv", "a/x.js", "c/x.ts");
    moveOut(dir, "b/x.js");
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout:
        "cannot pair by the name x: base a/x.js, b/x.js; head c/x.ts\n0 files compared, 0 different, 1 other problems\n",
      stderr: "",
    });
  });

  test("edited .js, .mjs and .cjs files are compared", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList(),
      "app.js": 'import { LIMIT } from "./config.js";\nexport const cap = LIMIT * 2;\n',
      "config.js": "export const LIMIT = 10;\n",
      "legacy.cjs": "module.exports = { retries: 3 };\n",
      "tests/app.test.mjs": 'import { cap } from "../app.js";\nif (cap !== 20) throw new Error("cap");\n',
    });
    write(dir, {
      "app.js": 'import { LIMIT } from "./config.js";\nexport const cap = LIMIT * 3;\n',
      "legacy.cjs": "module.exports = { retries: 4 };\n",
      "tests/app.test.mjs": 'import { cap } from "../app.js";\nif (cap !== 30) throw new Error("cap");\n',
    });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "app.js differs (base line 2, head line 2)",
        "  base: export const cap = LIMIT * 2;",
        "  head: export const cap = LIMIT * 3;",
        "legacy.cjs differs (base line 1, head line 1)",
        "  base: module.exports = { retries: 3 };",
        "  head: module.exports = { retries: 4 };",
        "tests/app.test.mjs differs (base line 2, head line 2)",
        '  base: if (cap !== 20) throw new Error("cap");',
        '  head: if (cap !== 30) throw new Error("cap");',
        "3 files compared, 3 different",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test(".mts, .cts and .tsx ports are compared and must be in the strict list", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList("util.mts", "old.cts"),
      "util.mjs": "export const half = (n) => n / 2;\n",
      "old.cjs": "const x = 1;\nmodule.exports = { x };\n",
      "view.jsx": "export const View = () => <b>hi</b>;\n",
    });
    await git(dir, "mv", "util.mjs", "util.mts");
    await git(dir, "mv", "old.cjs", "old.cts");
    await git(dir, "mv", "view.jsx", "view.tsx");
    write(dir, {
      "util.mts": "export const half = (n: number): number => n / 2;\n",
      "old.cts": "const x: number = 1;\nmodule.exports = { x };\n",
      "view.tsx": "export const View = (): unknown => <b>hi</b>;\n",
    });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: "view.tsx is not in tsconfig.strict.json\n3 files compared, 0 different, 1 other problems\n",
      stderr: "",
    });
  });

  test("an import switched from .mjs to a different .js module is a difference", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList("main.ts"),
      "b.mjs": "export const b = 1;\n",
      "b.js": "export const b = 2;\n",
      "main.js": 'import { b } from "./b.mjs";\nexport const value = b;\n',
    });
    await git(dir, "mv", "main.js", "main.ts");
    write(dir, { "main.ts": 'import { b } from "./b.js";\nexport const value: number = b;\n' });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "main.js -> main.ts differs (base line 1, head line 1)",
        '  base: import { b } from "./b.mjs";',
        '  head: import { b } from "./b.js";',
        "1 files compared, 1 different",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("bundler annotation comments are compared, not stripped", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList("pure.ts", "lazy.ts"),
      "pure.js": "export const store = /*#__PURE__*/ makeStore();\n",
      "lazy.js": "export const mod = (url) => import(/* @vite-ignore */ url);\n",
    });
    await git(dir, "mv", "pure.js", "pure.ts");
    await git(dir, "mv", "lazy.js", "lazy.ts");
    write(dir, {
      "pure.ts": "export const store: unknown = makeStore();\n",
      "lazy.ts": "export const mod = (url: string): Promise<unknown> => import(url);\n",
    });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "lazy.js -> lazy.ts differs (base line 1, head line 1)",
        "  base: export const mod = (url) => import(",
        "  head: export const mod = (url) => import(url);",
        "pure.js -> pure.ts differs (base line 1, head line 1)",
        "  base: export const store = /*#__PURE__*/ makeStore();",
        "  head: export const store = makeStore();",
        "2 files compared, 2 different",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("a relative import of a file that is not at head fails, naming the importer, line and path", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList("u.ts", "n.ts"),
      "u.js": "export const half = (n) => n / 2;\n",
      "m.js":
        'import { half } from "./u.js";\nexport const one = half(2);\nexport const lazy = () => import(`./u.js`);\n',
      "n.js": 'export const two = 2;\nexport { half } from "./u.js";\nexport const load = () => import("./u.js");\n',
    });
    await git(dir, "mv", "u.js", "u.ts");
    await git(dir, "mv", "n.js", "n.ts");
    write(dir, {
      "u.ts": "export const half = (n: number): number => n / 2;\n",
      "n.ts":
        'export const two: number = 2;\nexport { half } from "./u.js";\nexport const load = (): Promise<unknown> => import("./u.js");\n',
    });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "m.js line 1 imports ./u.js, which does not exist at head",
        "m.js line 3 imports ./u.js, which does not exist at head",
        "n.ts line 2 imports ./u.js, which does not exist at head",
        "n.ts line 3 imports ./u.js, which does not exist at head",
        "2 files compared, 0 different, 4 other problems",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("changed, new and gone files that ship fail, naming each", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList(),
      "index.html": '<body>\n<script type="module" src="/src/main.js"></script>\n</body>\n',
      "src/main.js": "export const main = 1;\n",
      "data.json": '{ "cap": 50 }\n',
      "old.css": "b { color: red; }\n",
    });
    write(dir, {
      "index.html":
        '<body>\n<script type="module" src="/src/main.js"></script>\n<script type="module" src="/src/extra.js"></script>\n</body>\n',
      "data.json": '{ "cap": 60 }\n',
      "new.css": "i { color: blue; }\n",
    });
    moveOut(dir, "old.css");
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "data.json differs (line 1)",
        '  base: { "cap": 50 }',
        '  head: { "cap": 60 }',
        "index.html differs (line 3)",
        "  base: </body>",
        '  head: <script type="module" src="/src/extra.js"></script>',
        "new.css is new and ships",
        "old.css is gone at head and no new file pairs with it",
        "3 files compared, 3 different, 1 other problems",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("files that don't ship are allowed, and shipped text whose only change is a renamed path passes", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList("src/main.ts", "web/overlay.ts"),
      "src/main.js": "export const main = 1;\n",
      "web/overlay.js": "export const overlay = 1;\n",
      "index.html": '<body>\n<script type="module" src="/src/main.js"></script>\n</body>\n',
      "web/overlay.html": '<script type="module" src="./overlay.js"></script>\n',
      "package.json": '{ "scripts": { "main": "node src/main.js" } }\n',
      "docs/notes.md": "Start in src/main.js.\n",
      ".coderabbit.yaml": "reviews: {}\n",
    });
    await git(dir, "mv", "src/main.js", "src/main.ts");
    await git(dir, "mv", "web/overlay.js", "web/overlay.ts");
    write(dir, {
      "index.html": '<body>\n<script type="module" src="/src/main.ts"></script>\n</body>\n',
      "web/overlay.html": '<script type="module" src="./overlay.ts"></script>\n',
      "package.json": '{ "scripts": { "main": "node src/main.ts" } }\n',
      "docs/notes.md": "Start in src/main.ts, the entry point.\n",
      ".coderabbit.yaml": "reviews: { profile: chill }\n",
      "tsconfig.strict.json": strictList("src/main.ts", "web/overlay.ts", "types/extra.d.ts"),
      "types/extra.d.ts": "export type Extra = string;\n",
    });
    assert.deepEqual(await portCheck(dir), {
      status: 0,
      stdout: [
        "allowed: .coderabbit.yaml (review config, does not ship)",
        "allowed: docs/notes.md (documentation, does not ship)",
        "allowed: index.html (only renamed paths changed)",
        "allowed: package.json (only renamed paths changed)",
        "allowed: tsconfig.strict.json (no build config reads it)",
        "allowed: web/overlay.html (only renamed paths changed)",
        "6 files compared, 0 different",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("a re-export of inline types only fails, and oxlint fails the import form", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList("x.ts", "m.ts"),
      "x.js": "export const X = 1;\n",
      "m.js": "export const m = 1;\n",
    });
    await git(dir, "mv", "x.js", "x.ts");
    await git(dir, "mv", "m.js", "m.ts");
    write(dir, {
      "x.ts": "export type Y = number;\nexport const X: Y = 1;\n",
      "m.ts": 'export { type Y } from "./x.ts";\nexport const m: number = 1;\n',
    });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "m.ts line 1 re-exports only inline types from ./x.ts, which Node still loads; write export type { ... }",
        "2 files compared, 0 different, 1 other problems",
        "",
      ].join("\n"),
      stderr: "",
    });
    const probe = path.join(mkdtempSync(path.join(tmpdir(), "pixfray-lint-probe-")), "probe.ts");
    writeFileSync(probe, 'import { type Y } from "./x.ts";\nexport const p: Y = 1;\n');
    // An explicit format: oxlint switches to GitHub annotations when it runs in Actions.
    const lint = await node(ROOT, OXLINT, "-f", "unix", "-c", path.join(ROOT, ".oxlintrc.json"), probe);
    assert.equal(lint.status, 1);
    assert.equal(
      lint.stdout.split("\n")[0],
      `${probe.replaceAll("\\", "/")}:1:1: TypeScript will only remove the inline type specifiers which will leave behind a side effect import at runtime. [Error/typescript(no-import-type-side-effects)]`,
    );
  });

  test("a port left with types only says the head has no runtime code", async () => {
    const dir = await repo({ "tsconfig.strict.json": strictList("k.ts"), "k.js": "export const K = 1;\n" });
    await git(dir, "mv", "k.js", "k.ts");
    write(dir, { "k.ts": "export type K = number;\n" });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "k.js -> k.ts differs (base line 1, head has no runtime code)",
        "  base: export const K = 1;",
        "  head: export {};",
        "1 files compared, 1 different",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("without a build config, a tsconfig change is allowed, and a tsconfig under public/ compares byte for byte", async () => {
    const dir = await repo({
      "tsconfig.base.json": '{ "compilerOptions": { "target": "esnext", "verbatimModuleSyntax": true } }\n',
      "tsconfig.strict.json":
        '// Strict.\n{ "extends": "./tsconfig.base.json", "compilerOptions": { "strict": true }, "files": [] }\n',
      "tsconfig.web.json": '{ "extends": "./tsconfig.base.json", "include": ["src/**/*.js"] }\n',
      "public/tsconfig.json": '{ "compilerOptions": {} }\n',
    });
    write(dir, {
      "tsconfig.json": '{ "files": [], "references": [{ "path": "./tsconfig.web.json" }] }\n',
      "tsconfig.strict.json":
        '{\n  "extends": "./tsconfig.base.json",\n  "compilerOptions": { "strict": true, "useDefineForClassFields": false },\n  "files": [],\n}\n',
      "tsconfig.web.json":
        '// Browser code.\n{ "extends": "./tsconfig.base.json", "include": ["src/**/*.js", "public/*.js"], "exclude": ["dist"] }\n',
      "public/tsconfig.json": '{ "compilerOptions": { "strict": true } }\n',
    });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "public/tsconfig.json differs (line 1; public/ is served as written)",
        '  base: { "compilerOptions": {} }',
        '  head: { "compilerOptions": { "strict": true } }',
        "allowed: tsconfig.json (no build config reads it)",
        "allowed: tsconfig.strict.json (no build config reads it)",
        "allowed: tsconfig.web.json (no build config reads it)",
        "1 files compared, 1 different",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("with a build config, a changed tsconfig is left to the build diff, and a new root tsconfig.json fails", async () => {
    const dir = await buildRepo({ "tsconfig.web.json": '{ "include": ["src/**/*.js"] }\n' });
    write(dir, {
      "tsconfig.json": '{ "files": [], "references": [{ "path": "./tsconfig.web.json" }] }\n',
      "tsconfig.web.json": '// Browser code.\n{ "include": ["src/**/*.js"] }\n',
    });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "tsconfig.json is new at the repo root, where the base build would read it too, so the build diff cannot see what it changes; add it in a change of its own",
        "allowed: tsconfig.web.json (the build diff compares what the build makes with it)",
        "1 files compared, 1 different; 8 build output files compared, 0 different",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("a nested tsconfig that changes how the build compiles a port fails at the build diff", async () => {
    const dir = await buildRepo({
      "server/side.js": "globalThis.sideLoaded = true;\nexport class Shape {}\n",
      "server/thing.js": [
        'import { Shape } from "./side.js";',
        "",
        "export class Thing {",
        "  /** @type {number} */",
        "  size;",
        "  /** @type {Shape} */",
        "  shape;",
        "  /** @param {Shape} shape */",
        "  constructor(shape) {",
        "    this.shape = shape;",
        "  }",
        "}",
        "",
      ].join("\n"),
      "server/worker.js":
        'import { Thing } from "./thing.js";\nexport default { fetch() { return new Response(String(new Thing(1).size)); } };\n',
    });
    await git(dir, "mv", "server/thing.js", "server/thing.ts");
    write(dir, {
      "server/thing.ts": [
        'import { Shape } from "./side.js";',
        "",
        "export class Thing {",
        "  size: number;",
        "  shape: Shape;",
        "  constructor(shape: Shape) {",
        "    this.shape = shape;",
        "  }",
        "}",
        "",
      ].join("\n"),
      "server/worker.js":
        'import { Thing } from "./thing.ts";\nexport default { fetch() { return new Response(String(new Thing(1).size)); } };\n',
      "server/tsconfig.json": '{ "include": ["*.ts"] }\n',
      "tsconfig.strict.json": strictList("server/thing.ts"),
    });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "allowed: server/tsconfig.json (the build diff compares what the build makes with it)",
        "allowed: tsconfig.strict.json (the build diff compares what the build makes with it)",
        ".cloudflare/output/v0/workers/default/bundle/index.js differs (line 2)",
        "  base: globalThis.sideLoaded = true;",
        "  head: var Thing = class {",
        "2 files compared, 0 different; 8 build output files compared, 1 different",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("porting the Worker entry passes once cloudflare.config.ts names the new path", async () => {
    const dir = await buildRepo({});
    await git(dir, "mv", "server/worker.js", "server/worker.ts");
    write(dir, {
      "server/worker.ts": 'export default { fetch(): Response { return new Response("ok"); } };\n',
      "cloudflare.config.ts": cloudflareConfig("./server/worker.ts"),
      "tsconfig.strict.json": strictList("server/worker.ts"),
    });
    assert.deepEqual(await portCheck(dir), {
      status: 0,
      stdout: [
        "allowed: tsconfig.strict.json (the build diff compares what the build makes with it)",
        "2 files compared, 0 different; 8 build output files compared, 0 different",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("a build that fails fails the check with the end of its output", async () => {
    const dir = await buildRepo({});
    await git(dir, "mv", "server/worker.js", "server/worker.ts");
    write(dir, {
      "server/worker.ts": 'export default { fetch(): Response { return new Response("ok"); } };\n',
      "server/tsconfig.json": '{ "extends": "./missing.json" }\n',
      "tsconfig.strict.json": strictList("server/worker.ts"),
    });
    const { status, stdout, stderr } = await portCheck(dir);
    const lines = stdout.split("\n");
    // The tail holds the build's timing and this machine's paths, so its last error line is matched, not pinned.
    assert.deepEqual(
      { status, stderr, first: lines.slice(0, 3), last: lines.slice(-2) },
      {
        status: 1,
        stderr: "",
        first: [
          "allowed: server/tsconfig.json (the build diff compares what the build makes with it)",
          "allowed: tsconfig.strict.json (the build diff compares what the build makes with it)",
          "the head build failed (bunx cf build):",
        ],
        last: ["1 files compared, 0 different; the build failed, 1 other problems", ""],
      },
    );
    assert.match(lines.at(-3) ?? "", /^ {2}\s*Tsconfig not found .*missing\.json$/);
    const tail = lines.slice(3, -2);
    assert.ok(tail.length <= 12, `the tail has ${tail.length} lines`);
    assert.deepEqual(
      tail.filter((line) => !line.startsWith("  ") || /^\s+at |\x1b\[/.test(line)),
      [],
      "the tail is indented, without stack frames or colors",
    );
  });

  test("a build that exits 0 without writing its output markers fresh fails, naming each", async () => {
    const dir = await buildRepo({});
    // A marker left by an earlier build, older than this run, and a missing one.
    write(dir, { ".cloudflare/output/v0/config.json": "{}\n" });
    utimesSync(path.join(dir, ".cloudflare/output/v0/config.json"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    assert.deepEqual(await portCheck(dir, withPath(BUILD_ENV, fakeCf())), {
      status: 1,
      stdout: [
        "the head build failed (bunx cf build):",
        "  exited 0 without writing .cloudflare/output/v0/config.json, .cloudflare/output/v0/workers/default/worker.config.json",
        "0 files compared, 0 different; the build failed, 1 other problems",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("a base that does not build fails the check, naming its checkout", async () => {
    const dir = await buildRepo({
      "server/worker.js": null,
      "server/worker.ts": 'export default { fetch(): Response { return new Response("ok"); } };\n',
      "server/tsconfig.json": '{ "extends": "./missing.json" }\n',
      "cloudflare.config.ts": cloudflareConfig("./server/worker.ts"),
      "tsconfig.strict.json": strictList("server/worker.ts"),
    });
    write(dir, { "server/tsconfig.json": "{}\n" });
    const sha = (await git(dir, "rev-parse", "main")).trim();
    const { status, stdout, stderr } = await portCheck(dir);
    const lines = stdout.split("\n");
    assert.deepEqual(
      { status, stderr, first: lines.slice(0, 2), last: lines.slice(-2) },
      {
        status: 1,
        stderr: "",
        first: [
          "allowed: server/tsconfig.json (the build diff compares what the build makes with it)",
          `the base build failed (bunx cf build in .port-check/${sha}):`,
        ],
        last: ["0 files compared, 0 different; the build failed, 1 other problems", ""],
      },
    );
    assert.match(lines.at(-3) ?? "", /^ {2}\s*Tsconfig not found .*missing\.json$/);
  });

  test("a committed .port-check/ fails, since no check compares what is in it", async () => {
    const dir = await repo({ "tsconfig.strict.json": strictList() });
    write(dir, { ".port-check/0123abc/server/worker.js": "export default {};\n" });
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "cache");
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        ".port-check/ has 1 committed files, which no check compares; take .port-check/ out of git",
        "0 files compared, 0 different, 1 other problems",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("a file under public/ compares byte for byte: a comment edit, a new comment-only module and a renamed path fail", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList(),
      "src/main.js": "export const main = 1;\n",
      "public/overlay.js": "// The overlay.\nexport const overlay = 1;\n",
      "public/_headers": "# Mirrors src/main.js.\n/*\n  X-Frame-Options: DENY\n",
    });
    await git(dir, "mv", "src/main.js", "src/main.ts");
    write(dir, {
      "src/main.ts": "export const main: number = 1;\n",
      "public/overlay.js": "// The OBS overlay.\nexport const overlay = 1;\n",
      "public/x.js": "// Reserved for the next duel effect.\n",
      "public/_headers": "# Mirrors src/main.ts.\n/*\n  X-Frame-Options: DENY\n",
      "tsconfig.strict.json": strictList("src/main.ts"),
    });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "public/_headers differs (line 1; public/ is served as written)",
        "  base: # Mirrors src/main.js.",
        "  head: # Mirrors src/main.ts.",
        "public/overlay.js differs (line 1; public/ is served as written)",
        "  base: // The overlay.",
        "  head: // The OBS overlay.",
        "public/x.js is new and ships",
        "allowed: tsconfig.strict.json (no build config reads it)",
        "4 files compared, 3 different",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("a test or script may update a string naming a ported file, and any other string change fails", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList(),
      "src/ui.js": "export const ui = 1;\n",
      "src/files.js": 'export const FILES = ["src/ui.js"];\n',
      "tests/ui.test.mjs":
        'import { readFileSync } from "node:fs";\nconst text = readFileSync("src/ui.js", "utf8");\nif (!text.includes("ui")) throw new Error("ui");\n',
    });
    await git(dir, "mv", "src/ui.js", "src/ui.ts");
    write(dir, {
      "src/ui.ts": "export const ui: number = 1;\n",
      "tests/ui.test.mjs":
        'import { readFileSync } from "node:fs";\nconst text = readFileSync("src/ui.ts", "utf8");\nif (!text.includes("ui")) throw new Error("ui");\n',
      "tsconfig.strict.json": strictList("src/ui.ts"),
    });
    assert.deepEqual(await portCheck(dir), {
      status: 0,
      stdout: "allowed: tsconfig.strict.json (no build config reads it)\n2 files compared, 0 different\n",
      stderr: "",
    });
    write(dir, {
      "src/files.js": 'export const FILES = ["src/ui.ts"];\n',
      "tests/ui.test.mjs":
        'import { readFileSync } from "node:fs";\nconst text = readFileSync("src/ui.ts", "latin1");\nif (!text.includes("ui")) throw new Error("ui");\n',
    });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "src/files.js differs (base line 1, head line 1)",
        '  base: export const FILES = ["src/ui.js"];',
        '  head: export const FILES = ["src/ui.ts"];',
        "tests/ui.test.mjs differs (base line 2, head line 2)",
        '  base: const text = readFileSync("src/ui.js", "utf8");',
        '  head: const text = readFileSync("src/ui.js", "latin1");',
        "allowed: tsconfig.strict.json (no build config reads it)",
        "3 files compared, 2 different",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("a code file under public/ fails when renamed, moved in or out, or turned into TypeScript", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList(),
      "public/hats.js": "export const HATS = [];\n",
      "public/fx.js": "export const fx = 1;\n",
      "public/overlay.js":
        'import { HATS } from "./hats.js";\nimport { fx } from "./fx.js";\nexport const n = HATS.length + fx;\n',
      "src/glow.js": "export const glow = 1;\n",
    });
    await git(dir, "mv", "public/hats.js", "public/hats.ts");
    mkdirSync(path.join(dir, "src/served"), { recursive: true });
    await git(dir, "mv", "public/fx.js", "src/served/fx.js");
    await git(dir, "mv", "src/glow.js", "public/glow.js");
    write(dir, {
      "public/hats.ts": "export const HATS: string[] = [];\n",
      "public/overlay.js":
        'import { HATS } from "./hats.ts";\nimport { fx } from "../src/served/fx.js";\nexport const n = HATS.length + fx;\n',
      "tsconfig.strict.json": strictList("public/hats.ts"),
    });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "src/glow.js -> public/glow.js changes a path under public/, which serves code as written",
        "public/hats.js -> public/hats.ts changes a path under public/, which serves code as written",
        "public/overlay.js differs (line 1; public/ is served as written)",
        '  base: import { HATS } from "./hats.js";',
        '  head: import { HATS } from "./hats.ts";',
        "public/fx.js -> src/served/fx.js changes a path under public/, which serves code as written",
        "allowed: tsconfig.strict.json (no build config reads it)",
        "public/hats.ts is TypeScript under public/, which serves code as written",
        "1 files compared, 1 different, 4 other problems",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("a --base that names no commit is bad usage, reported in one line", async () => {
    const dir = await repo({ "tsconfig.strict.json": strictList() });
    assert.deepEqual(await node(dir, SCRIPT, "--base", "no-such-ref"), {
      status: 2,
      stdout: "",
      stderr: "port-check: no-such-ref is not a commit\n",
    });
    // A tree resolves but is not a commit: git's own complaint about it must not reach the terminal.
    assert.deepEqual(await node(dir, SCRIPT, "--base", "HEAD^{tree}"), {
      status: 2,
      stdout: "",
      stderr: "port-check: HEAD^{tree} is not a commit\n",
    });
  });

  test("a long line that differs late is shown around its first difference", async () => {
    const csp = (src) =>
      `  Content-Security-Policy: default-src 'self'; ${"img-src 'self' data: https://static-cdn.jtvnw.net; ".repeat(3)}connect-src 'self' ${src}\n`;
    const dir = await repo({
      "tsconfig.strict.json": strictList(),
      "public/_headers": `/*\n${csp("wss://a.example")}`,
    });
    write(dir, { "public/_headers": `/*\n${csp("wss://b.example")}` });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "public/_headers differs (line 2; public/ is served as written)",
        "  base: ...ata: https://static-cdn.jtvnw.net; connect-src 'self' wss://a.example",
        "  head: ...ata: https://static-cdn.jtvnw.net; connect-src 'self' wss://b.example",
        "1 files compared, 1 different",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("--strict-list fails each TypeScript file no program checks", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList("a.ts"),
      "tsconfig.node.json": '{ "include": ["vite.config.js"] }\n',
      "a.ts": "export const a = 1;\n",
      "cloudflare.config.ts": "export default {};\n",
      "lib/x.mts": "export const x = 1;\n",
    });
    write(dir, { "server/foo.ts": "export const foo = 1;\n" });
    assert.deepEqual(await node(dir, SCRIPT, "--strict-list"), {
      status: 1,
      stdout: [
        "cloudflare.config.ts is left out of tsconfig.strict.json for tsconfig.node.json, which does not list it",
        "lib/x.mts is not in tsconfig.strict.json",
        "server/foo.ts is not in tsconfig.strict.json",
        "",
      ].join("\n"),
      stderr: "",
    });
  });
});

describe("port-rename", () => {
  test("renames the file, points its importers and docs at .ts, and prints the port-check command", async () => {
    const dir = await repo({
      "server/rank.js": "export const START = 1000;\n",
      "server/main.js": 'import { START } from "./rank.js";\nexport const start = START;\n',
      "docs/notes.md": "Ratings live in server/rank.js.\n",
    });
    assert.deepEqual(await node(dir, RENAME, "server/rank.js"), {
      status: 0,
      stdout: [
        "server/rank.js -> server/rank.ts",
        "updated docs/notes.md",
        "updated server/main.js (1 import)",
        'Next: annotate the .ts files, add them to tsconfig.strict.json "files", run node scripts/port-check.ts --base origin/main',
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("rewrites importers of every code extension, declaration files included", async () => {
    const dir = await repo({
      "server/rank.js": "export const START = 1000;\n",
      "server/a.mts": 'import { START } from "./rank.js";\nexport const a = START;\n',
      "server/b.cjs": 'module.exports = () => import("./rank.js");\n',
      "server/c.jsx": 'import { START } from "./rank.js";\nexport const C = () => <b>{START}</b>;\n',
      "server/d.tsx": 'import { START } from "./rank.js";\nexport const D = () => <i>{START}</i>;\n',
      "server/e.cts": 'module.exports = () => import("./rank.js");\n',
      "types/rank.d.ts": 'export type { START } from "../server/rank.js";\n',
    });
    assert.deepEqual(await node(dir, RENAME, "server/rank.js"), {
      status: 0,
      stdout: [
        "server/rank.js -> server/rank.ts",
        "updated server/a.mts (1 import)",
        "updated server/b.cjs (1 import)",
        "updated server/c.jsx (1 import)",
        "updated server/d.tsx (1 import)",
        "updated server/e.cts (1 import)",
        "updated types/rank.d.ts (1 import)",
        'Next: annotate the .ts files, add them to tsconfig.strict.json "files", run node scripts/port-check.ts --base origin/main',
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("follows template-literal and query-string imports, and port-check reads them back as the base paths", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList("u.ts"),
      "u.js": "export const u = 1;\n",
      "m.js":
        'export const a = () => import(`./u.js`);\nexport const b = () => import("./u.js?v=1#top");\nexport const c = (x) => import(`./${x}.js`);\n',
    });
    assert.deepEqual(await node(dir, RENAME, "u.js"), {
      status: 0,
      stdout: [
        "u.js -> u.ts",
        "updated m.js (2 imports)",
        'Next: annotate the .ts files, add them to tsconfig.strict.json "files", run node scripts/port-check.ts --base origin/main',
        "",
      ].join("\n"),
      stderr: "",
    });
    assert.equal(
      readFileSync(path.join(dir, "m.js"), "utf8"),
      'export const a = () => import(`./u.ts`);\nexport const b = () => import("./u.ts?v=1#top");\nexport const c = (x) => import(`./${x}.js`);\n',
    );
    assert.deepEqual(await portCheck(dir), { status: 0, stdout: "2 files compared, 0 different\n", stderr: "" });
  });

  test("refuses a file under public/, which is served as written", async () => {
    const dir = await repo({ "public/hats.js": "export const HATS = [];\n" });
    assert.deepEqual(await node(dir, RENAME, "public/hats.js"), {
      status: 2,
      stdout: "",
      stderr: "public/hats.js: files under public/ are served as written, so they stay JavaScript\n",
    });
    assert.equal(readFileSync(path.join(dir, "public/hats.js"), "utf8"), "export const HATS = [];\n");
  });

  test("leaves every byte under public/ as it is and lists each mention there as file:line", async () => {
    const overlay = '// Same shape as src/ui.js.\nexport const SOURCE = "src/ui.js";\nexport const n = 1;\n';
    const page = "<!-- Mirrors src/ui.js. -->\r\n<p>overlay</p>\r\n";
    const dir = await repo({
      "src/ui.js": "export const ui = 1;\n",
      "public/overlay.js": overlay,
      "public/overlay.html": page,
      "docs/notes.md": "The picker is src/ui.js.\n",
    });
    assert.deepEqual(await node(dir, RENAME, "src/ui.js"), {
      status: 0,
      stdout: [
        "src/ui.js -> src/ui.ts",
        "updated docs/notes.md",
        "note: public/overlay.html:1 names a renamed file; left as is, since public/ is served as written",
        "note: public/overlay.js:1 names a renamed file; left as is, since public/ is served as written",
        "note: public/overlay.js:2 names a renamed file; left as is, since public/ is served as written",
        'Next: annotate the .ts files, add them to tsconfig.strict.json "files", run node scripts/port-check.ts --base origin/main',
        "",
      ].join("\n"),
      stderr: "",
    });
    assert.equal(readFileSync(path.join(dir, "public/overlay.js"), "utf8"), overlay);
    assert.equal(readFileSync(path.join(dir, "public/overlay.html"), "utf8"), page);
  });
});
