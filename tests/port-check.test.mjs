// scripts/port-check.ts against small git repos: each test commits a base on main, changes it on a branch, and checks
// the exact report and exit code. The tests run at once, since each spends about a second waiting on git and node.
// The repos live in the OS temp folder and are not removed (files are never deleted by script here; see AGENTS.md).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const SCRIPT = fileURLToPath(new URL("../scripts/port-check.ts", import.meta.url));

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

/** A repo with `files` committed on main and a port branch checked out. */
async function repo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "pixfray-port-check-"));
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

/** Runs port-check in `dir`. A non-zero exit rejects with an error that carries the same stdout and stderr. */
async function portCheck(dir) {
  const result = await run(process.execPath, [SCRIPT, "--base", "main"], { cwd: dir, env: ENV }).catch(
    (error) => error,
  );
  return { status: typeof result.code === "number" ? result.code : 0, stdout: result.stdout, stderr: result.stderr };
}

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

  test("an added typeof check is a runtime difference", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList("num.ts"),
      "num.js": "/** @param {unknown} v */\nexport const toInt = (v) => (Number.isInteger(v) ? v : 0);\n",
    });
    renameSync(path.join(dir, "num.js"), path.join(dir, "num.ts"));
    write(dir, {
      "num.ts":
        'export const toInt = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) ? v : 0);\n',
    });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: [
        "num.js -> num.ts differs at stripped line 1",
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

  test("a changed .ts file missing from tsconfig.strict.json fails even when identical", async () => {
    const dir = await repo({
      "tsconfig.strict.json": strictList("listed.ts"),
      "extra.js": "export const name = (user) => user.login;\n",
    });
    renameSync(path.join(dir, "extra.js"), path.join(dir, "extra.ts"));
    write(dir, { "extra.ts": "export const name = (user: { login: string }): string => user.login;\n" });
    assert.deepEqual(await portCheck(dir), {
      status: 1,
      stdout: "extra.ts is not in tsconfig.strict.json\n1 files compared, 0 different\n",
      stderr: "",
    });
  });
});
