// scripts/strict-check.ts, run in a scratch git repo with the five strict programs: a TypeScript file that no program
// lists fails the check, and the check passes once every file is in one.
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const SCRIPT = path.resolve("scripts/strict-check.ts");
const STRICT = {
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  verbatimModuleSyntax: true,
  erasableSyntaxOnly: true,
  noEmit: true,
  types: [],
};

test("strict-check fails a TypeScript file outside the strict programs and passes a listed one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "strict-check-"));
  const write = (name: string, data: unknown) =>
    writeFileSync(path.join(dir, name), typeof data === "string" ? data : JSON.stringify(data));
  for (const name of ["worker", "web", "node", "node-dom", "node-all"])
    write(`tsconfig.${name}.json`, { compilerOptions: STRICT, files: ["listed.ts"] });
  write("listed.ts", "export const listed = 1;\n");
  write("stray.ts", "export const stray = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const check = () => spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });

  const failed = check();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /^stray\.ts is not in any of tsconfig\.worker\.json/m);
  assert.doesNotMatch(failed.stderr, /listed\.ts/);

  write("tsconfig.web.json", { compilerOptions: STRICT, files: ["listed.ts", "stray.ts"] });
  const passed = check();
  assert.deepEqual([passed.status, passed.stderr], [0, ""]);
});
