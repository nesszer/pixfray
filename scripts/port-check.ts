// Proves a TypeScript port changes no runtime code. For every changed .ts file whose base version exists (the git
// rename source, the same path, or the same path as .js or .mjs), both versions are stripped to JavaScript with oxc,
// comments removed and relative import extensions normalized, then compared. Also fails a changed .ts file that is
// missing from the tsconfig.strict.json `files` list. Usage: node scripts/port-check.ts --base origin/main
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { transformWithOxc } from "vite";
import { replaceSpans, scanModule } from "./lib/port.ts";

const STRICT_CONFIG = "tsconfig.strict.json";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** NUL-separated git output (`-z`) as a list, without the empty tail. */
function nulList(out: string): string[] {
  return out.split("\0").filter((item) => item !== "");
}

/** `.ts` files that differ between `mergeBase` and the working tree (committed, staged, unstaged or untracked), each
 * with the path git saw it renamed from. Deleted files and `.d.ts` files (no runtime code) are left out. */
function changedTsFiles(root: string, mergeBase: string): Map<string, string | undefined> {
  const changed = new Map<string, string | undefined>();
  const fields = nulList(git(["diff", "--name-status", "-M", "-z", mergeBase], root));
  for (let i = 0; i < fields.length;) {
    const status = fields[i++] ?? "";
    const renamed = status.startsWith("R") || status.startsWith("C");
    const from = renamed ? fields[i++] : undefined;
    const file = fields[i++] ?? "";
    if (!status.startsWith("D")) changed.set(file, from);
  }
  const untracked = nulList(git(["ls-files", "--others", "--exclude-standard", "-z"], root));
  for (const file of untracked) changed.set(file, undefined);
  // Deleting the current entry while iterating a Map is safe.
  for (const file of changed.keys()) {
    if (!file.endsWith(".ts") || file.endsWith(".d.ts")) changed.delete(file);
  }
  return changed;
}

/** The `files` list of tsconfig.strict.json as repo-relative paths. The file is JSONC: comments and trailing commas are
 * dropped outside strings before parsing. */
function strictFiles(root: string): Set<string> {
  const text = readFileSync(path.join(root, STRICT_CONFIG), "utf8");
  let json = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const close = /^"(?:[^"\\]|\\.)*"/.exec(text.slice(i));
      const literal = close ? close[0] : text.slice(i);
      json += literal;
      i += literal.length - 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? text.length : newline - 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 1;
    } else {
      json += ch;
    }
  }
  const config: unknown = JSON.parse(json.replace(/,(\s*[}\]])/g, "$1"));
  const files = typeof config === "object" && config !== null && "files" in config ? config.files : undefined;
  if (!Array.isArray(files)) throw new Error(`${STRICT_CONFIG} has no "files" list`);
  return new Set(files.map((file) => path.posix.normalize(String(file))));
}

/** The JavaScript a file runs as: comments blanked (a block comment holding a line break keeps one, so automatic
 * semicolons stay put), types stripped by oxc the way Vite and Node strip them, and every relative import extension
 * (.js, .mjs, .ts) written as `.js`, so a .js to .ts rename of an imported file is not a difference. CRLF reads as LF,
 * as it does in template literals at runtime. */
async function runtimeCode(filename: string, source: string): Promise<string> {
  const code = source.replace(/\r\n/g, "\n");
  const lang = filename.endsWith(".ts") ? "ts" : "js";
  const { comments } = scanModule(filename, code);
  const bare = replaceSpans(code, comments, ({ start, end }) => (/[\n\r]/.test(code.slice(start, end)) ? "\n" : " "));
  const { code: stripped } = await transformWithOxc(bare, filename, {
    lang,
    sourcemap: false,
    tsconfig: false,
    typescript: { onlyRemoveTypeImports: true },
  });
  const { specifiers } = scanModule(filename.replace(/\.ts$/, ".js"), stripped);
  return replaceSpans(stripped, specifiers, ({ value }) => JSON.stringify(value.replace(/\.(?:m?js|ts)$/, ".js")));
}

/** 1-based number of the first line that differs, or 0 when the texts are equal. */
function firstDifferentLine(base: string[], head: string[]): number {
  const length = Math.max(base.length, head.length);
  for (let i = 0; i < length; i++) if (base[i] !== head[i]) return i + 1;
  return 0;
}

function show(line: string | undefined): string {
  if (line === undefined) return "(end of file)";
  const trimmed = line.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf("--base");
  const baseRef = baseIndex === -1 ? undefined : args[baseIndex + 1];
  if (!baseRef || args.length !== 2) {
    console.error("usage: node scripts/port-check.ts --base <ref>");
    return 2;
  }
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const mergeBase = git(["merge-base", baseRef, "HEAD"], root).trim();
  const basePaths = new Set(nulList(git(["ls-tree", "-r", "-z", "--name-only", mergeBase], root)));
  const listed = existsSync(path.join(root, STRICT_CONFIG)) ? strictFiles(root) : new Set<string>();
  const changed = changedTsFiles(root, mergeBase);

  let compared = 0;
  let different = 0;
  let unlisted = 0;
  for (const file of [...changed.keys()].sort()) {
    if (!listed.has(file)) {
      console.log(`${file} is not in ${STRICT_CONFIG}`);
      unlisted++;
    }
    const stem = file.slice(0, -".ts".length);
    const candidates = [changed.get(file), file, `${stem}.js`, `${stem}.mjs`];
    const basePath = candidates.find((candidate) => candidate !== undefined && basePaths.has(candidate));
    if (basePath === undefined) continue;
    compared++;
    const label = basePath === file ? file : `${basePath} -> ${file}`;
    try {
      const base = await runtimeCode(basePath, git(["show", `${mergeBase}:${basePath}`], root));
      const head = await runtimeCode(file, readFileSync(path.join(root, file), "utf8"));
      const baseLines = base.split("\n");
      const headLines = head.split("\n");
      const line = firstDifferentLine(baseLines, headLines);
      if (line === 0) continue;
      different++;
      console.log(`${label} differs at stripped line ${line}`);
      console.log(`  base: ${show(baseLines[line - 1])}`);
      console.log(`  head: ${show(headLines[line - 1])}`);
    } catch (error) {
      different++;
      console.log(`${label} could not be compared: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`${compared} files compared, ${different} different`);
  return different > 0 || unlisted > 0 ? 1 : 0;
}

process.exitCode = await main();
