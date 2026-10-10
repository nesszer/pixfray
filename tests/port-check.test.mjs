// scripts/port-check.ts and scripts/port-rename.ts against small git repos: each test commits a base on main, changes
// it on a branch, and checks the exact report and exit code. The tests run at once, since each spends about a second
// waiting on git and node. The repos live in the OS temp folder and are not removed (files are never deleted by script
// here; see AGENTS.md), so a test that needs a file gone moves it out of the repo.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts", "port-check.ts");
const RENAME = path.join(ROOT, "scripts", "port-rename.ts");

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

/** A repo with `files` committed on main and a port branch checked out. */
async function repo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "pixfray-port-check-"));
  const outside = await git(dir, "rev-parse", "--show-toplevel").then(
    (top) => `inside ${top.trim()}`,
    (error) => (/not a git repository/.test(error.stderr) ? "outside" : error.stderr),
  );
  assert.equal(outside, "outside", "the temp folder is inside a git repo");
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

/** Runs a script in `dir`. A non-zero exit rejects with an error that carries the same stdout and stderr. */
async function node(dir, ...args) {
  const result = await run(process.execPath, args, { cwd: dir, env: ENV }).catch((error) => error);
  return { status: typeof result.code === "number" ? result.code : 0, stdout: result.stdout, stderr: result.stderr };
}

const portCheck = (dir) => node(dir, SCRIPT, "--base", "main");

describe("port-check", { concurrency: true }, () => {
  test("annotations, comments and type-only code strip to the same JavaScript", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList("sum.ts"),
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
      "public/chat.js": "export const say = (text) => text.trim();\n",
      "public/overlay.js":
        'import { say } from "./chat.js";\nimport { clamp } from "../server/game.js";\nexport const hello = say(" hi ") + clamp(1);\n',
      "server/game.js": "export const clamp = (n) => Math.max(0, n);\n",
      "tests/overlay.test.mjs": 'import { hello } from "../public/overlay.js";\nconsole.log(hello);\n',
    });
    mkdirSync(path.join(dir, "src/served"), { recursive: true });
    await git(dir, "mv", "public/chat.js", "src/served/chat.js");
    await git(dir, "mv", "public/overlay.js", "src/served/overlay.ts");
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

  test("--strict-list fails each TypeScript file no program checks, and passes on this repo", async () => {
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
    assert.deepEqual(await node(ROOT, SCRIPT, "--strict-list"), {
      status: 0,
      stdout: "tsconfig.strict.json covers every TypeScript file\n",
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
});
