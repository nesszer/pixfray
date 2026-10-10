// scripts/port-check.ts and scripts/port-rename.ts against small git repos: each test commits a base on main, changes
// it on a branch, and checks the exact report and exit code. The tests run at once, since each spends about a second
// waiting on git and node. The repos live in the OS temp folder and are not removed (files are never deleted by script
// here; see AGENTS.md), so a test that needs a file gone moves it out of the repo.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
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
      "public/_headers": "# Mirrors src/main.js and web/overlay.js.\n/*\n  X-Frame-Options: DENY\n",
      "package.json": '{ "scripts": { "main": "node src/main.js" } }\n',
      "docs/notes.md": "Start in src/main.js.\n",
      ".coderabbit.yaml": "reviews: {}\n",
    });
    await git(dir, "mv", "src/main.js", "src/main.ts");
    await git(dir, "mv", "web/overlay.js", "web/overlay.ts");
    write(dir, {
      "index.html": '<body>\n<script type="module" src="/src/main.ts"></script>\n</body>\n',
      "web/overlay.html": '<script type="module" src="./overlay.ts"></script>\n',
      "public/_headers": "# Mirrors src/main.ts and web/overlay.ts.\n/*\n  X-Frame-Options: DENY\n",
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
        "allowed: public/_headers (only renamed paths changed)",
        "allowed: tsconfig.strict.json (compiler options unchanged, does not ship)",
        "allowed: web/overlay.html (only renamed paths changed)",
        "7 files compared, 0 different",
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

  test("a tsconfig change fails when its compiler options change, and a tsconfig under public/ ships", async () => {
    const dir = await repo({
      "tsconfig.base.json": '{ "compilerOptions": { "target": "esnext", "verbatimModuleSyntax": true } }\n',
      "tsconfig.strict.json":
        '// Strict.\n{ "extends": "./tsconfig.base.json", "compilerOptions": { "strict": true }, "files": [] }\n',
      "tsconfig.web.json": '{ "extends": "./tsconfig.base.json", "include": ["src/**/*.js"] }\n',
      "public/tsconfig.json": '{ "compilerOptions": {} }\n',
    });
    write(dir, {
      "tsconfig.strict.json":
        '{\n  "extends": "./tsconfig.base.json",\n  "compilerOptions": { "strict": true, "verbatimModuleSyntax": false, "useDefineForClassFields": false },\n  "files": [],\n}\n',
      "tsconfig.web.json":
        '// Browser code.\n{ "extends": "./tsconfig.base.json", "include": ["src/**/*.js", "public/*.js"], "exclude": ["dist"] }\n',
      "public/tsconfig.json": '{ "compilerOptions": { "strict": true } }\n',
    });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "public/tsconfig.json differs (line 1)",
        '  base: { "compilerOptions": {} }',
        '  head: { "compilerOptions": { "strict": true } }',
        "tsconfig.strict.json changes compilerOptions.useDefineForClassFields, compilerOptions.verbatimModuleSyntax, which the build reads; only files, include and exclude may change",
        "allowed: tsconfig.web.json (compiler options unchanged, does not ship)",
        "2 files compared, 2 different",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("a compiler option changed in an extended tsconfig fails each changed tsconfig that inherits it", async () => {
    const dir = await repo({
      "tsconfig.base.json": '{ "compilerOptions": { "target": "esnext" } }\n',
      "tsconfig.strict.json": '{ "extends": "./tsconfig.base.json", "files": [] }\n',
    });
    write(dir, {
      "tsconfig.base.json": '{ "compilerOptions": { "target": "es2020" } }\n',
      "tsconfig.strict.json": '{ "extends": "./tsconfig.base.json", "files": ["a.ts"] }\n',
      "a.ts": "export type A = string;\n",
    });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "tsconfig.base.json changes compilerOptions.target, which the build reads; only files, include and exclude may change",
        "tsconfig.strict.json changes compilerOptions.target, which the build reads; only files, include and exclude may change",
        "3 files compared, 2 different",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  test("a code file under public/ fails when renamed, moved out or turned into TypeScript", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList(),
      "public/hats.js": "export const HATS = [];\n",
      "public/fx.js": "export const fx = 1;\n",
      "public/overlay.js":
        'import { HATS } from "./hats.js";\nimport { fx } from "./fx.js";\nexport const n = HATS.length + fx;\n',
    });
    await git(dir, "mv", "public/hats.js", "public/hats.ts");
    mkdirSync(path.join(dir, "src/served"), { recursive: true });
    await git(dir, "mv", "public/fx.js", "src/served/fx.js");
    write(dir, {
      "public/hats.ts": "export const HATS: string[] = [];\n",
      "public/overlay.js":
        'import { HATS } from "./hats.ts";\nimport { fx } from "../src/served/fx.js";\nexport const n = HATS.length + fx;\n',
      "tsconfig.strict.json": strictList("public/hats.ts"),
    });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "public/hats.js -> public/hats.ts changes a path under public/, which serves code as written",
        "public/overlay.js differs (base line 1, head line 1)",
        '  base: import { HATS } from "./hats.js";',
        '  head: import { HATS } from "./hats.ts";',
        "public/fx.js -> src/served/fx.js changes a path under public/, which serves code as written",
        "allowed: tsconfig.strict.json (compiler options unchanged, does not ship)",
        "public/hats.ts is TypeScript under public/, which serves code as written",
        "1 files compared, 1 different, 3 other problems",
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
        "public/_headers differs (line 2)",
        "  base: ...ata: https://static-cdn.jtvnw.net; connect-src 'self' wss://a.example",
        "  head: ...ata: https://static-cdn.jtvnw.net; connect-src 'self' wss://b.example",
        "1 files compared, 1 different",
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
});
