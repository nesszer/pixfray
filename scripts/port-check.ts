// Proves a TypeScript port changes no runtime code, and that tsconfig.strict.json checks every TypeScript file.
//
// `--base <ref>` pairs every file at the merge base with `<ref>` against the working tree. Code files are stripped to
// JavaScript with oxc and compared. A file pairs with the same path; a code file gone at head pairs with a new code file
// of the same name (the path's base name without its code extension), first in the same folder, then anywhere in the
// repo. A name that more than one gone or new file shares fails instead of guessing. A gone file with no pair fails;
// a new code file with no pair passes only when it strips to no runtime code. Files under public/ are served as
// written, so they keep their paths, stay JavaScript and compare byte for byte. In tests, scripts and the two build
// configs (NON_SHIPPING), a string literal naming a moved code file's new path reads as the old path. Other changed
// files fail unless they don't ship (UNSHIPPED) or their only change names a moved code file's new path. Every relative
// import at head must name a file at head, and none may re-export only inline types.
//
// Then the build is the ground truth: when cloudflare.config.ts exists, the base and the working tree are each built
// with `bunx cf build` and every file under .cloudflare/output must match, JavaScript with comments removed and other
// files byte for byte. That covers what the file checks cannot see, such as a tsconfig that changes how Vite compiles
// TypeScript. `--strict-list` checks only the strict list.
// Usage: node scripts/port-check.ts --base origin/main | node scripts/port-check.ts --strict-list
import { isUtf8 } from "node:buffer";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";
import {
  PUBLIC,
  replaceSpans,
  scanModule,
  splitSpecifier,
  stringLiterals,
  type Span,
  type Specifier,
} from "./lib/port.ts";

const STRICT_CONFIG = "tsconfig.strict.json";

/** oxc's language for each code extension. */
const LANG = {
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
} as const; // keeps each value a literal ("ts", not string), the type transformWithOxc's lang option takes
type CodeExtension = keyof typeof LANG;

/** The extension a file's stripped output parses as. */
const STRIPPED: Record<CodeExtension, string> = {
  ".js": ".js",
  ".mjs": ".mjs",
  ".cjs": ".cjs",
  ".jsx": ".jsx",
  ".ts": ".js",
  ".mts": ".mjs",
  ".cts": ".cjs",
  ".tsx": ".jsx",
};

/** TypeScript files that tsconfig.strict.json leaves out, each with the program that checks it instead. */
const STRICT_EXCLUSIONS: Record<string, string> = {
  "cloudflare.config.ts": "tsconfig.node.json",
  "types/browser.d.ts": "tsconfig.web.json",
};

/** Changed files that don't ship to the Worker or the pages, each with the reason printed when one is allowed. */
const UNSHIPPED: [RegExp, string][] = [
  [/^(?!public\/).*\.md$/, "documentation"],
  [/^\.coderabbit\.yaml$/, "review config"],
];

/** A tsconfig the build reads. One under public/ is served as a file instead, so it compares like any shipped file. */
const TSCONFIG = /^(?!public\/)(?:.*\/)?tsconfig[^/]*\.json$/;

/** Code that never ships: tests, scripts and the build configs. Their string literals may name a moved file's new
 * path (a test reading `src/ui.ts`, the Worker entrypoint in cloudflare.config.ts). */
const NON_SHIPPING = /^(?:tests\/|scripts\/|cloudflare\.config\.ts$|vite\.config\.js$)/;

/** The build config: when the base or the head has it, both are built and their output compared. */
const BUILD_CONFIG = "cloudflare.config.ts";

/** What the build deploys. `.cloudflare/types` is left out: cf writes it once and never refreshes it, and it does
 * not deploy. */
const OUTPUT = ".cloudflare/output";

/** Files every finished build writes under OUTPUT; a build that exits 0 without writing them fresh failed. */
const OUTPUT_MARKERS = ["v0/config.json", "v0/workers/default/worker.config.json"];

/** Where the base is checked out and built, one folder per commit, git-ignored. port-check reuses a folder once it
 * proves the folder still holds the base commit (verifyBase), and never deletes one; recycle old ones by hand. */
const CACHE = ".port-check";

/** The scratch index inside each CACHE/<sha> folder: it checks the base out, then proves the folder still matches. */
const CACHE_INDEX = ".port-check-index";

/** The only names CACHE may hold: a base checkout, or one still being written (`.partial`). Anything else there sits
 * between a checkout and the repo, so the base build would read it first: bunx runs the nearest
 * `node_modules/.bin/cf` and Node resolves packages from the nearest `node_modules`. */
const CACHE_ENTRY = /^[0-9a-f]{40}(?:[0-9a-f]{24})?(?:\.partial)?$/;

/** What the build writes inside the base folder, so verifyBase leaves it out. */
const BUILD_WRITES = [".cloudflare", ".wrangler"];

/** Keeps the builds off the network: with a lockfile cf runs Bun's vite, without one npx, and either would try a
 * registry for a missing package instead of failing. */
const OFFLINE = {
  npm_config_offline: "true",
  NPM_CONFIG_REGISTRY: "http://127.0.0.1:9",
  BUN_CONFIG_REGISTRY: "http://127.0.0.1:9",
};

/** A content hash Rolldown adds to a client chunk name: `main-B9j2uYmk.js`. */
const CHUNK_HASH = /-[\w-]{8}(?=\.[^/.]+$)/;

/** A path in a non-code file that names a code file: `./x.js`, `../x.js`, `/x.js` or `dir/x.js`. */
const CODE_PATH = /(?<![\w.@/-])(?:\.{1,2}\/|\/)?(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[cm]?[jt]sx?(?![\w/-]|\.\w)/g;

/** Bundler annotations: comments a build reads, so they stay in the comparison. */
const ANNOTATION = /^(?:\/\/|\/\*)\s*(?:[#@]__[A-Z_]+__|@vite-ignore\b|webpack[A-Z]\w*\s*:|turbopackIgnore\s*:)/;

/** How a base file and a head file line up. Paths are repo-relative with `/`. */
type Unit =
  | { kind: "compare"; base: string; head: string }
  | { kind: "new"; head: string }
  | { kind: "gone"; base: string }
  | { kind: "ambiguous"; name: string; base: string[]; head: string[] };

/** A file stripped to the JavaScript it runs as, with the source line of each stripped line (0 where unknown). */
type Runtime = { lines: string[]; sourceLines: number[] };

/** git's output. Its stderr is captured, never passed through: a failure surfaces as the thrown error. */
function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...(env ? { env } : {}),
  });
}

/** NUL-separated git output (`-z`) as a list, without the empty tail. */
function nulList(out: string): string[] {
  return out.split("\0").filter((item) => item !== "");
}

/** The first three of `paths`, then how many more there are. */
function firstFew(paths: string[]): string {
  return paths.slice(0, 3).join(", ") + (paths.length > 3 ? ` and ${paths.length - 3} more` : "");
}

function codeExtension(file: string): CodeExtension | undefined {
  const ext = path.posix.extname(file);
  return ext in LANG ? (ext as CodeExtension) : undefined; // `in LANG` proves ext is one of its keys
}

/** The name files pair by: the base name without its code extension (`types/a.d.ts` is `a.d`). */
function stem(file: string): string {
  return path.posix.basename(file, path.posix.extname(file));
}

/** Files in the working tree, tracked or untracked but not ignored, without port-check's own CACHE in any letter case
 * (Windows and macOS read `.Port-Check` as the same folder): where .gitignore does not name it, the base copies there
 * would pair with the head's files. A committed CACHE fails on its own (cacheProblems). */
function headFiles(root: string): string[] {
  const listed = nulList(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root));
  return [...new Set(listed)].filter((file) => {
    // ASCII letters only, as cacheProblems' :(icase) folds them: toLowerCase() also folds the Kelvin sign (U+212A) to
    // "k", so a tracked `.port-chec\u212A/x.js`, a separate folder on NTFS, would drop out of every check.
    const lower = file.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    return lower !== CACHE && !lower.startsWith(`${CACHE}/`) && existsSync(path.join(root, file));
  });
}

/** The repo's own tsc (TypeScript's bin script, run with this Node), so the strict list reads a tsconfig exactly as
 * `bun run typecheck` does: `extends`, `include`, `exclude` and `files`. */
const TSC = path.join(path.dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))), "bin", "tsc");

/** Options tsconfig.strict.json must have on, after `extends`: a port's types are checked against them. */
const STRICT_ON = [
  "strict",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "verbatimModuleSyntax",
  "erasableSyntaxOnly",
];

/** `no*` options that turn checking off, so true is their loose value. Every other `no*` option, and every `strict*`
 * one, checks more when true, so false is theirs; so it is for the two strict options below that start with neither. */
const NO_TURNS_OFF = ["noCheck", "noLib", "noResolve", "noStrictGenericChecks"];
const STRICT_FAMILY = ["alwaysStrict", "useUnknownInCatchVariables"];

/** A declaration file name, as tsc reads one: `.d.ts`, `.d.mts`, `.d.cts` or `.d.<ext>.ts`. */
const DECLARATION = /\.d\.(?:[cm]?ts|[^./]+\.ts)$/;

/** tsc's exit code and everything it printed. */
function tsc(root: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [TSC, ...args],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, out: stdout + stderr });
      },
    );
  });
}

/** The repo files in tsc's program for `config` (`--listFilesOnly`: the files after include, exclude and files, and
 * what they import), relative with `/`, without node_modules; and one line per error tsc printed reading it. */
async function programFiles(root: string, config: string): Promise<{ files: Set<string>; errors: string[] }> {
  const { code, out } = await tsc(root, ["-p", path.join(root, config), "--listFilesOnly"]);
  const files = new Set<string>();
  const errors: string[] = [];
  let empty = false;
  for (const line of out.split(/\r?\n/)) {
    // An empty program (TS18002, TS18003) is no error here: each TypeScript file it misses is reported by name.
    if (/\berror TS1800[23]:/.test(line)) empty = true;
    else if (/\berror TS\d+:/.test(line)) errors.push(`tsc -p ${config}: ${line.trim()}`);
    if (!path.isAbsolute(line)) continue;
    const file = path.relative(root, line).split(path.sep).join("/");
    if (!file.startsWith("../") && !path.isAbsolute(file) && !file.split("/").includes("node_modules")) files.add(file);
  }
  if (code !== 0 && !empty && errors.length === 0) errors.push(`tsc -p ${config} --listFilesOnly exited ${code}`);
  return { files, errors };
}

/** One line per compilerOption tsconfig.strict.json ends up with, after `extends` (tsc --showConfig), that checks less
 * than STRICT_ON and the loose values above allow; and one per repo declaration file in the strict `program` while
 * skipLibCheck leaves it unchecked. Every PixFray program needs skipLibCheck: @types/node and
 * @cloudflare/workers-types declare the same globals. */
async function looseOptions(root: string, program: Promise<{ files: Set<string> }>): Promise<string[]> {
  const { out } = await tsc(root, ["-p", path.join(root, STRICT_CONFIG), "--showConfig"]);
  let shown: unknown;
  try {
    shown = JSON.parse(out);
  } catch {
    return [`tsc -p ${STRICT_CONFIG} --showConfig printed no config (${out.trim().split("\n")[0] ?? ""})`];
  }
  const set = typeof shown === "object" && shown !== null && "compilerOptions" in shown ? shown.compilerOptions : {};
  const options: Record<string, unknown> =
    typeof set === "object" && set !== null ? Object.fromEntries(Object.entries(set)) : {};
  const loose: string[] = [];
  for (const name of STRICT_ON) {
    if (options[name] !== true)
      loose.push(
        `${STRICT_CONFIG} must set ${name} to true (it is ${name in options ? String(options[name]) : "not set"})`,
      );
  }
  for (const [name, value] of Object.entries(options)) {
    const turnsOff = NO_TURNS_OFF.includes(name);
    const checks = !turnsOff && (/^(?:strict|no)[A-Z]/.test(name) || STRICT_FAMILY.includes(name));
    if ((turnsOff && value === true) || (checks && value === false && !STRICT_ON.includes(name))) {
      loose.push(`${STRICT_CONFIG} sets ${name} to ${String(value)}, which checks less`);
    }
  }
  if (options["skipLibCheck"] === true) {
    for (const file of [...(await program).files].filter((file) => DECLARATION.test(file)).sort()) {
      loose.push(`${file} is a declaration file, which skipLibCheck leaves unchecked in ${STRICT_CONFIG}; name it .ts`);
    }
  }
  return loose;
}

/** One line per TypeScript file in the working tree that no strict program checks, per error tsc prints reading the
 * strict list, and per option that loosens it (looseOptions). The tsc runs overlap. */
async function strictListProblems(root: string, files: readonly string[]): Promise<string[]> {
  const typescript = files.filter((file) => /\.(?:ts|mts|cts|tsx)$/.test(file)).sort();
  const programs = new Map<string, ReturnType<typeof programFiles>>();
  for (const file of typescript) {
    const program = STRICT_EXCLUSIONS[file];
    if (program !== undefined && !programs.has(program) && existsSync(path.join(root, program))) {
      programs.set(program, programFiles(root, program));
    }
  }
  const hasStrict = existsSync(path.join(root, STRICT_CONFIG));
  const strict = hasStrict
    ? programFiles(root, STRICT_CONFIG)
    : Promise.resolve({ files: new Set<string>(), errors: [] });
  const loose = hasStrict ? looseOptions(root, strict) : Promise.resolve([]);
  const { files: checked, errors } = await strict;
  const problems = [...errors, ...(await loose)];
  for (const file of typescript) {
    if (checked.has(file)) continue;
    const program = STRICT_EXCLUSIONS[file];
    const other = program === undefined ? undefined : programs.get(program);
    if (program === undefined) problems.push(`${file} is not in ${STRICT_CONFIG}`);
    else if (other === undefined || !(await other).files.has(file)) {
      problems.push(`${file} is left out of ${STRICT_CONFIG} for ${program}, which does not list it`);
    }
  }
  return problems;
}

/** Pairs the files that differ between the merge base and the working tree; only code files pair across paths. */
function pairFiles(baseFiles: readonly string[], head: readonly string[], changed: ReadonlySet<string>): Unit[] {
  const headSet = new Set(head);
  const baseSet = new Set(baseFiles);
  const units: Unit[] = [];
  for (const file of baseFiles)
    if (headSet.has(file) && changed.has(file)) units.push({ kind: "compare", base: file, head: file });
  let gone = baseFiles.filter((file) => !headSet.has(file) && codeExtension(file));
  let added = head.filter((file) => !baseSet.has(file) && codeExtension(file));
  for (const file of baseFiles)
    if (!headSet.has(file) && !codeExtension(file)) units.push({ kind: "gone", base: file });
  for (const file of head) if (!baseSet.has(file) && !codeExtension(file)) units.push({ kind: "new", head: file });
  for (const nameOf of [(file: string) => `${path.posix.dirname(file)}/${stem(file)}`, stem]) {
    const groups = new Map<string, { base: string[]; head: string[] }>();
    const group = (file: string) => {
      const name = nameOf(file);
      const found = groups.get(name) ?? { base: [], head: [] };
      groups.set(name, found);
      return found;
    };
    for (const file of gone) group(file).base.push(file);
    for (const file of added) group(file).head.push(file);
    const settled = new Set<string>();
    for (const [name, { base, head: next }] of groups) {
      const [onlyBase] = base;
      const [onlyHead] = next;
      if (onlyBase === undefined || onlyHead === undefined) continue;
      if (base.length === 1 && next.length === 1) units.push({ kind: "compare", base: onlyBase, head: onlyHead });
      else units.push({ kind: "ambiguous", name: path.posix.basename(name), base, head: next });
      for (const file of [...base, ...next]) settled.add(file);
    }
    gone = gone.filter((file) => !settled.has(file));
    added = added.filter((file) => !settled.has(file));
  }
  for (const file of gone) units.push({ kind: "gone", base: file });
  for (const file of added) units.push({ kind: "new", head: file });
  return units;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** For each generated line of a v3 source map, the 1-based source line of its first mapped segment, or 0. */
function mappedLines(mappings: string): number[] {
  const lines: number[] = [];
  let sourceLine = 0;
  for (const generated of mappings.split(";")) {
    let first = 0;
    for (const segment of generated.split(",")) {
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const ch of segment) {
        const digit = BASE64.indexOf(ch);
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
          continue;
        }
        fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0;
        shift = 0;
      }
      if (fields.length < 4) continue;
      sourceLine += fields[2] ?? 0;
      if (first === 0) first = sourceLine + 1;
    }
    lines.push(first);
  }
  return lines;
}

/** The JavaScript a file runs as. Comments are blanked, keeping their line breaks so lines keep their numbers, except
 * bundler annotations; types are stripped by oxc the way Vite and Node strip them. CRLF reads as LF, as it does in
 * template literals at runtime. `specifier` rewrites each relative import path in the stripped code; with `literals`,
 * also every other string literal it changes, keeping its quotes. */
async function runtimeCode(
  file: string,
  source: string,
  specifier: (value: string) => string,
  literals = false,
): Promise<Runtime> {
  const ext = codeExtension(file) ?? ".js";
  const code = source.replace(/\r\n/g, "\n");
  const { comments } = scanModule(file, code);
  const blanked = comments.filter(({ start, end }) => !ANNOTATION.test(code.slice(start, end)));
  const bare = replaceSpans(code, blanked, ({ start, end }) => ` ${code.slice(start, end).replace(/[^\n]/g, "")}`);
  const { code: stripped, map } = await transformWithOxc(bare, file, {
    lang: LANG[ext],
    jsx: "preserve",
    sourcemap: true,
    tsconfig: false,
    typescript: { onlyRemoveTypeImports: true },
  });
  const strippedName = file.slice(0, -ext.length) + STRIPPED[ext];
  const edits = new Map<number, Span & { text: string }>();
  for (const literal of literals ? stringLiterals(strippedName, stripped) : []) {
    const mapped = specifier(literal.value);
    const quote = stripped[literal.start] ?? '"';
    if (mapped !== literal.value) edits.set(literal.start, { ...literal, text: quote + mapped + quote });
  }
  for (const item of scanModule(strippedName, stripped).specifiers) {
    edits.set(item.start, { ...item, text: JSON.stringify(specifier(item.value)) });
  }
  const runtime = replaceSpans(stripped, [...edits.values()], ({ text }) => text);
  return { lines: runtime.split("\n"), sourceLines: mappedLines(map?.mappings ?? "") };
}

/** True when the stripped file runs nothing: oxc writes a type-only module as `export {};`. */
function isEmpty({ lines }: Runtime): boolean {
  return /^\s*(?:export\s*\{\s*\};?\s*)?$/.test(lines.join("\n"));
}

/** The source line behind stripped line `index`, from the nearest mapped line after it, else before it. Nothing maps
 * only when the file strips to no runtime code (oxc's `export {};` or nothing). */
function sourceLine({ lines, sourceLines }: Runtime, index: number): string {
  if (index >= lines.length) return "at end of file";
  for (let i = index; i < sourceLines.length; i++) if (sourceLines[i]) return `line ${sourceLines[i]}`;
  for (let i = index - 1; i >= 0; i--) if (sourceLines[i]) return `line ${sourceLines[i]}`;
  return "has no runtime code";
}

/** Prints a differing pair of lines, trimmed. A line over 160 characters prints 150 of them, from 60 before the first
 * column where the two differ, so the difference stays in view. */
function showDifference(base: string | undefined, head: string | undefined): void {
  const before = base?.trim() ?? "";
  const after = head?.trim() ?? "";
  let at = 0;
  while (at < before.length && before[at] === after[at]) at++;
  const from = Math.max(0, at - 60);
  const cut = (line: string | undefined, text: string) => {
    if (line === undefined) return "(end of file)";
    if (text.length <= 160) return text;
    return `${from > 0 ? "..." : ""}${text.slice(from, from + 150)}${from + 150 < text.length ? "..." : ""}`;
  };
  console.log(`  base: ${cut(base, before)}`);
  console.log(`  head: ${cut(head, after)}`);
}

/** True when a pair moves or renames a code file into, out of or within public/. */
function movesPublic(base: string, head: string): boolean {
  return base !== head && (base.startsWith(PUBLIC) || head.startsWith(PUBLIC));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** UTF-8 text with a leading BOM kept, so adding or dropping one is a difference. Valid UTF-8 decodes one way only;
 * invalid bytes all decode to U+FFFD, so callers check isUtf8 before treating equal text as equal bytes. */
function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
}

/** Compares a file byte for byte and prints its first differing line. `rewrite`, when given, maps each head line
 * first, and a file that matches only after it prints as allowed, if both sides are valid UTF-8: only then do equal
 * texts mean the renamed paths explain every changed byte. `why` is added to the difference line. Returns true when
 * the file differs. */
function compareBytes(
  label: string,
  base: Uint8Array,
  head: Uint8Array,
  rewrite?: (line: string) => string,
  why = "",
): boolean {
  if (sameBytes(base, head)) return false;
  if (base.includes(0) || head.includes(0)) {
    console.log(`${label} differs (binary${why})`);
    return true;
  }
  const baseLines = decode(base).split("\n");
  const headLines = decode(head).split("\n");
  const index = firstDifference(baseLines, rewrite ? headLines.map(rewrite) : headLines);
  if (index === -1 && rewrite && isUtf8(base) && isUtf8(head)) {
    console.log(`allowed: ${label} (only renamed paths changed)`);
    return false;
  }
  if (index === -1) console.log(`${label} differs (in bytes that decode the same${why})`);
  else {
    console.log(`${label} differs (line ${index + 1}${why})`);
    showDifference(baseLines[index], headLines[index]);
  }
  return true;
}

async function checkPort(root: string, baseRef: string, files: readonly string[]): Promise<number> {
  const mergeBase = git(["merge-base", baseRef, "HEAD"], root).trim();
  const baseFiles = nulList(git(["ls-tree", "-r", "-z", "--name-only", mergeBase], root));
  const changed = new Set(nulList(git(["diff", "--name-only", "--no-renames", "-z", mergeBase], root)));
  const units = pairFiles(baseFiles, files, changed);
  units.sort((a, b) => (key(a) < key(b) ? -1 : 1));
  // The builds run while the files are compared. `files` was listed first, so the build's output is not in it. A
  // committed CACHE would stand in for the base checkout, so the builds don't run at all.
  const cache = cacheProblems(root);
  // tsc reads the strict list while the files are compared, too.
  const strictList = strictListProblems(root, files);
  const building = baseFiles.includes(BUILD_CONFIG) || files.includes(BUILD_CONFIG);
  const builds =
    building && cache.length === 0
      ? buildBoth(root, mergeBase).catch((error: unknown) => ({
          base: "",
          failures: [`the builds could not start: ${error instanceof Error ? error.message : String(error)}`],
          started: false,
        }))
      : undefined;

  // A head path of a moved file maps to its base path, so a path that names it compares as one naming the base file.
  const movedFrom = new Map<string, string>();
  for (const unit of units) {
    if (unit.kind === "compare" && unit.base !== unit.head && !movesPublic(unit.base, unit.head))
      movedFrom.set(unit.head, unit.base);
  }
  /** `written`, a path in head file `file`, as base file `baseFile` would write it to reach the base version of the
   * same target. `./` and `../` paths resolve from the file's folder, other paths from the repo root (a leading `/`
   * kept). A query or hash stays as written. */
  const asBase = (file: string, baseFile: string) => (written: string) => {
    const { file: target, suffix } = splitSpecifier(written);
    if (target.startsWith("./") || target.startsWith("../")) {
      const full = path.posix.join(path.posix.dirname(file), target);
      const baseTarget = movedFrom.get(full) ?? full;
      if (baseTarget === full && path.posix.dirname(file) === path.posix.dirname(baseFile)) return written;
      const relative = path.posix.relative(path.posix.dirname(baseFile), baseTarget);
      return (relative.startsWith("../") ? relative : `./${relative}`) + suffix;
    }
    const lead = target.startsWith("/") ? "/" : "";
    const baseTarget = movedFrom.get(target.slice(lead.length));
    return baseTarget === undefined ? written : lead + baseTarget + suffix;
  };
  const readBase = (file: string) =>
    execFileSync("git", ["show", `${mergeBase}:${file}`], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const same = () => (value: string) => value;

  let compared = 0;
  let different = 0;
  let problems = 0;
  for (const unit of units) {
    const reason = UNSHIPPED.find(([pattern]) => pattern.test(key(unit)))?.[1];
    if (reason !== undefined) {
      console.log(`allowed: ${key(unit)} (${reason}, does not ship)`);
      continue;
    }
    if (TSCONFIG.test(key(unit))) {
      // The base build runs inside the repo, under CACHE, and Vite reads the nearest tsconfig.json above a file. With
      // none in the base, it would find the head's at the repo root, and both builds would compile alike.
      if (building && unit.kind === "new" && unit.head === "tsconfig.json") {
        compared++;
        different++;
        console.log(
          "tsconfig.json is new at the repo root, where the base build would read it too, so the build diff cannot see what it changes; add it in a change of its own",
        );
        continue;
      }
      const why = building ? "the build diff compares what the build makes with it" : "no build config reads it";
      console.log(`allowed: ${key(unit)} (${why})`);
      continue;
    }
    if (unit.kind === "compare" && movesPublic(unit.base, unit.head)) {
      console.log(`${unit.base} -> ${unit.head} changes a path under public/, which serves code as written`);
      problems++;
      continue;
    }
    if (unit.kind === "gone") {
      console.log(`${unit.base} is gone at head and no new file pairs with it`);
      problems++;
      continue;
    }
    if (unit.kind === "ambiguous") {
      console.log(`cannot pair by the name ${unit.name}: base ${unit.base.join(", ")}; head ${unit.head.join(", ")}`);
      problems++;
      continue;
    }
    compared++;
    const label = unit.kind === "new" || unit.base === unit.head ? unit.head : `${unit.base} -> ${unit.head}`;
    try {
      const shipsAsWritten = unit.head.startsWith(PUBLIC);
      if (codeExtension(unit.head) === undefined || shipsAsWritten) {
        if (unit.kind === "new") {
          different++;
          console.log(`${label} is new and ships`);
          continue;
        }
        const head = readFileSync(path.join(root, unit.head));
        const differs = shipsAsWritten
          ? compareBytes(label, readBase(unit.base), head, undefined, "; public/ is served as written")
          : compareBytes(label, readBase(unit.base), head, (line) =>
              line.replace(CODE_PATH, asBase(unit.head, unit.head)),
            );
        if (differs) different++;
        continue;
      }
      const headSource = readFileSync(path.join(root, unit.head), "utf8");
      if (unit.kind === "new") {
        const head = await runtimeCode(unit.head, headSource, same());
        if (isEmpty(head)) continue;
        different++;
        const first = head.lines.findIndex((line) => line.trim() !== "" && !/^export\s*\{\s*\};?$/.test(line.trim()));
        console.log(`${label} is new and has runtime code (head ${sourceLine(head, first)})`);
        continue;
      }
      const base = await runtimeCode(unit.base, decode(readBase(unit.base)), same());
      const head = await runtimeCode(unit.head, headSource, asBase(unit.head, unit.base), NON_SHIPPING.test(unit.head));
      const index = firstDifference(base.lines, head.lines);
      if (index === -1) continue;
      different++;
      console.log(`${label} differs (base ${sourceLine(base, index)}, head ${sourceLine(head, index)})`);
      showDifference(base.lines[index], head.lines[index]);
    } catch (error) {
      different++;
      console.log(`${label} could not be compared: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let buildSummary = "";
  let outputsDifferent = 0;
  const { base, failures, started } = (await builds) ?? { base: "", failures: [], started: false };
  for (const failure of failures) console.log(failure);
  problems += failures.length;
  if (started && failures.length === 0) {
    const outputs = compareOutputs(base, root);
    outputsDifferent = outputs.different;
    buildSummary = `; ${outputs.compared} build output files compared, ${outputs.different} different`;
  } else if (building) buildSummary = started ? "; the build failed" : "; the builds did not run";
  const publicTypeScript = files
    .filter((file) => file.startsWith(PUBLIC) && /\.(?:ts|mts|cts|tsx)$/.test(file))
    .sort()
    .map((file) => `${file} is TypeScript under public/, which serves code as written`);
  const lines = [...cache, ...publicTypeScript, ...importProblems(root, files), ...(await strictList)];
  for (const line of lines) {
    console.log(line);
    problems++;
  }
  const others = problems > 0 ? `, ${problems} other problems` : "";
  console.log(`${compared} files compared, ${different} different${buildSummary}${others}`);
  return different > 0 || outputsDifferent > 0 || problems > 0 ? 1 : 0;
}

/** One line when git tracks anything at CACHE, in any letter case: a file, a folder or a symlink. The file checks skip
 * it, and the base build would read it instead of a checkout of the base: on a disk that ignores case,
 * `.Port-Check/<sha>/x` lands inside `.port-check/<sha>/`. */
function cacheProblems(root: string): string[] {
  const committed = nulList(git(["ls-files", "-z", "--", `:(icase)${CACHE}`], root));
  if (committed.length === 0) return [];
  const count = committed.length === 1 ? "1 path" : `${committed.length} paths`;
  const more = committed.length === 1 ? "" : ` and ${committed.length - 1} more`;
  const them = committed.length === 1 ? "it" : "them";
  return [
    `${CACHE} (in any letter case) is where port-check checks out the base, and git tracks ${count} there that no check compares (${committed[0]}${more}); take ${them} out of git`,
  ];
}

/** The merge base checked out at CACHE/<sha> through a scratch index kept inside it, so the repo's own index stays as
 * it is. A folder already there is reused; a new one is written as <sha>.partial and renamed once complete. Either way
 * verifyBase proves it holds the base before it builds. Throws when CACHE holds anything but checkouts (CACHE_ENTRY). */
function checkoutBase(root: string, sha: string): string {
  const cache = path.join(root, CACHE);
  refuseLinks(cache, CACHE, false);
  const stray = existsSync(cache)
    ? readdirSync(cache, { withFileTypes: true })
        .filter((entry) => !entry.isDirectory() || !CACHE_ENTRY.test(entry.name))
        .map((entry) => entry.name)
        .sort()
    : [];
  if (stray.length > 0) {
    throw new Error(
      `${CACHE} holds ${firstFew(stray)}, which the base build would load from above its checkout; only base checkouts (<sha> folders) belong there, so move the rest out and rerun`,
    );
  }
  const dir = path.join(cache, sha);
  if (!existsSync(dir)) {
    const partial = `${dir}.partial`;
    mkdirSync(partial, { recursive: true });
    const env = { ...process.env, GIT_INDEX_FILE: path.join(partial, CACHE_INDEX) };
    git(["read-tree", sha], root, env);
    git(["checkout-index", "--all", "--force", `--prefix=${partial.split(path.sep).join("/")}/`], root, env);
    renameSync(partial, dir);
  }
  verifyBase(root, dir, sha);
  return dir;
}

/** Throws unless `dir` holds exactly the tree of commit `sha`, besides what the build writes there (BUILD_WRITES):
 * no file changed or missing and none extra. A reused folder could hold a hand edit, or a file committed in another
 * letter case. It refuses rather than rebuilds, since rebuilding would mean deleting the extra files. Reading the tree
 * into the scratch index and hashing every file costs about 0.3 s on PixFray's base. */
function verifyBase(root: string, dir: string, sha: string): void {
  // GIT_DIR is named, not found by walking up from `dir`: a `.git` left in the folder would point git elsewhere.
  const gitDir = git(["rev-parse", "--absolute-git-dir"], root).trim();
  const env = { ...process.env, GIT_DIR: gitDir, GIT_INDEX_FILE: path.join(dir, CACHE_INDEX), GIT_WORK_TREE: dir };
  git(["read-tree", sha], dir, env);
  git(["update-index", "-q", "--refresh"], dir, env);
  const changed = nulList(git(["diff-files", "--name-only", "-z"], dir, env));
  const skip = [...BUILD_WRITES, CACHE_INDEX].map((name) => `:!${name}`);
  const extra = nulList(git(["ls-files", "--others", "-z", "--", ".", ...skip], dir, env));
  if (changed.length === 0 && extra.length === 0) return;
  const found = [
    ...(changed.length > 0 ? [`changed or missing: ${firstFew(changed)}`] : []),
    ...(extra.length > 0 ? [`not in the base: ${firstFew(extra)}`] : []),
  ];
  throw new Error(
    `${CACHE}/${sha} does not hold the base commit (${found.join("; ")}); move that folder out of the repo and rerun`,
  );
}

/** Throws when `dir` is a link (a symlink, or a Windows junction, which Node reads as one), or when one of its
 * entries is, or with `deep` anything under it: a checkout or a build would write through it to wherever it points,
 * outside the repo. `label` names `dir` in the message. */
function refuseLinks(dir: string, label: string, deep: boolean): void {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (stat === undefined) return;
  const links = stat.isSymbolicLink()
    ? [label]
    : stat.isDirectory()
      ? readdirSync(dir, { recursive: deep, withFileTypes: true })
          .filter((entry) => entry.isSymbolicLink())
          .map(
            (entry) =>
              `${label}/${path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")}`,
          )
          .sort()
      : [];
  if (links.length === 0) return;
  throw new Error(
    `${firstFew(links)} ${links.length === 1 ? "is a link" : "are links"} (a symlink or junction), which port-check and the build would write through to wherever ${links.length === 1 ? "it points" : "they point"}; make ${links.length === 1 ? "it a plain folder" : "them plain folders"} or move ${links.length === 1 ? "it" : "them"} out, and rerun`,
  );
}

/** Builds the merge base (checked out under CACHE) and the working tree at once. Resolves to the base folder and one
 * report block per failed build. The base folder has no node_modules, so its build loads the repo's packages from
 * above it, and checkoutBase refuses anything else in CACHE that would come first. That is sound: a change to
 * package.json or bun.lock already fails the file checks, so both builds would install the same packages. */
async function buildBoth(
  root: string,
  mergeBase: string,
): Promise<{ base: string; failures: string[]; started: boolean }> {
  const base = checkoutBase(root, mergeBase);
  for (const name of BUILD_WRITES) {
    refuseLinks(path.join(base, name), `${CACHE}/${mergeBase}/${name}`, true);
    refuseLinks(path.join(root, name), name, true);
  }
  const [baseError, headError] = await Promise.all([runBuild(base), runBuild(root)]);
  const failures: string[] = [];
  if (baseError !== undefined) {
    failures.push(`the base build failed (bunx cf build in ${CACHE}/${mergeBase}):\n${baseError}`);
  }
  if (headError !== undefined) failures.push(`the head build failed (bunx cf build):\n${headError}`);
  return { base, failures, started: true };
}

/** Runs `bunx cf build` in `dir`, offline. Resolves to undefined when it built, else to the end of what it printed.
 * Its exit code alone is not trusted: the OUTPUT_MARKERS must also be there, written by this run. */
function runBuild(dir: string): Promise<string | undefined> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("bunx", ["cf", "build"], {
      cwd: dir,
      env: { ...process.env, ...OFFLINE },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (chunk: Uint8Array) => (log += decode(chunk)));
    child.stderr.on("data", (chunk: Uint8Array) => (log += decode(chunk)));
    child.on("error", (error) => resolve(`  ${error.message}`));
    child.on("close", (code) => {
      // The second of slack: some file systems keep mtimes in whole seconds, so a marker written just after `started`
      // can read up to a second older.
      const stale = OUTPUT_MARKERS.filter((marker) => {
        const file = path.join(dir, OUTPUT, marker);
        return !existsSync(file) || statSync(file).mtimeMs < started - 1000;
      });
      if (code === 0 && stale.length === 0) resolve(undefined);
      else if (code === 0) resolve(`  exited 0 without writing ${stale.map((file) => `${OUTPUT}/${file}`).join(", ")}`);
      else resolve(errorTail(log));
    });
  });
}

/** The end of a failed build's output, indented: the error, without colors, stack frames or bare braces. */
function errorTail(log: string): string {
  const lines = log
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !/^\s+at /.test(line))
    .filter((line) => !/^\s*(?:errors: \[Getter\/Setter\]|\})\s*$/.test(line));
  return lines
    .slice(-12)
    .map((line) => `  ${line.trimEnd()}`)
    .join("\n");
}

/** Files under a build's OUTPUT, as sorted paths relative to it with `/`. */
function outputFiles(dir: string): string[] {
  const out = path.join(dir, OUTPUT);
  return readdirSync(out, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(out, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

/** A build output file as the lines it compares by, each with its line number. JavaScript loses its comments, and
 * the spaces before each, except bundler annotations: the Worker bundle keeps `//#region <source path>` and JSDoc,
 * which name a moved file's old path. A line that held only comments is dropped. Other files keep every line. */
function outputLines(file: string, text: string): { lines: string[]; numbers: number[] } {
  let code = text;
  if (/\.m?js$/.test(file)) {
    try {
      const spans = scanModule(file, text)
        .comments.filter(({ start, end }) => !ANNOTATION.test(text.slice(start, end)))
        .map(({ start, end }) => {
          let from = start;
          while (from > 0 && (text[from - 1] === " " || text[from - 1] === "\t")) from--;
          return { start: from, end };
        });
      code = replaceSpans(text, spans, ({ start, end }) => text.slice(start, end).replace(/[^\n]/g, ""));
    } catch {
      // Output oxc cannot parse compares as written.
    }
  }
  const original = text.split("\n");
  const lines: string[] = [];
  const numbers: number[] = [];
  code.split("\n").forEach((line, index) => {
    if (line === "" && original[index] !== "") return;
    lines.push(line);
    numbers.push(index + 1);
  });
  return { lines, numbers };
}

/** Compares the base build's OUTPUT with the working tree's and prints each difference. A file pairs with the same
 * path, else with the one file on the other side whose name differs only in its content hash (a chunk whose content
 * changed), so the report shows what changed inside it. */
function compareOutputs(baseDir: string, headDir: string): { compared: number; different: number } {
  const baseList = outputFiles(baseDir);
  const headList = outputFiles(headDir);
  const inHead = new Set(headList);
  const inBase = new Set(baseList);
  const entries: { base?: string; head?: string }[] = baseList
    .filter((file) => inHead.has(file))
    .map((file) => ({ base: file, head: file }));
  let onlyBase = baseList.filter((file) => !inHead.has(file));
  let onlyHead = headList.filter((file) => !inBase.has(file));
  const unhashed = (file: string) => file.replace(CHUNK_HASH, "");
  for (const file of onlyBase) {
    const bases = onlyBase.filter((other) => unhashed(other) === unhashed(file));
    const [head, ...more] = onlyHead.filter((other) => unhashed(other) === unhashed(file));
    if (unhashed(file) === file || bases.length !== 1 || head === undefined || more.length > 0) continue;
    entries.push({ base: file, head });
    onlyBase = onlyBase.filter((other) => other !== file);
    onlyHead = onlyHead.filter((other) => other !== head);
  }
  for (const file of onlyBase) entries.push({ base: file });
  for (const file of onlyHead) entries.push({ head: file });
  const sortKey = (entry: { base?: string; head?: string }) => entry.base ?? entry.head ?? "";
  entries.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
  let different = 0;
  for (const { base, head } of entries) {
    if (head === undefined || base === undefined) {
      different++;
      console.log(`${OUTPUT}/${base ?? head} is only in the ${head === undefined ? "base" : "head"} build`);
      continue;
    }
    const before = readFileSync(path.join(baseDir, OUTPUT, base));
    const after = readFileSync(path.join(headDir, OUTPUT, head));
    if (sameBytes(before, after)) continue;
    const label = base === head ? `${OUTPUT}/${head}` : `${OUTPUT}/${base} -> ${path.posix.basename(head)}`;
    if (before.includes(0) || after.includes(0)) {
      different++;
      console.log(`${label} differs (binary)`);
      continue;
    }
    const was = outputLines(base, decode(before));
    const now = outputLines(head, decode(after));
    const index = firstDifference(was.lines, now.lines);
    if (index === -1 && isUtf8(before) && isUtf8(after)) continue;
    different++;
    if (index === -1) {
      console.log(`${label} differs (in bytes that decode the same)`);
      continue;
    }
    const at = ({ numbers }: { numbers: number[] }) => {
      const number = numbers[index];
      return number === undefined ? "end of file" : `line ${number}`;
    };
    console.log(`${label} differs (${at(was) === at(now) ? at(was) : `base ${at(was)}, head ${at(now)}`})`);
    showDifference(was.lines[index], now.lines[index]);
  }
  return { compared: entries.length, different };
}

/** The first index where two line lists differ, or -1 when they are equal. */
function firstDifference(base: readonly string[], head: readonly string[]): number {
  const length = Math.max(base.length, head.length);
  for (let index = 0; index < length; index++) if (base[index] !== head[index]) return index;
  return -1;
}

/** One line per relative import at head whose file is not at head, and per `export { type A } from`, which oxc strips
 * but Node runs as `export {} from`. Checks every code file, changed or not: an unchanged importer of a moved file
 * still builds where the bundler resolves `.js` to `.ts`, but fails under Node. */
function importProblems(root: string, files: readonly string[]): string[] {
  const atHead = new Set(files);
  const problems: string[] = [];
  for (const file of [...files].sort()) {
    if (codeExtension(file) === undefined) continue;
    const code = readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
    let specifiers: Specifier[];
    try {
      specifiers = scanModule(file, code).specifiers;
    } catch (error) {
      problems.push(`${file} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const { value, start, inlineTypes } of specifiers) {
      const line = code.slice(0, start).split("\n").length;
      const target = path.posix.join(path.posix.dirname(file), splitSpecifier(value).file);
      if (!atHead.has(target)) problems.push(`${file} line ${line} imports ${value}, which does not exist at head`);
      if (inlineTypes) {
        problems.push(
          `${file} line ${line} re-exports only inline types from ${value}, which Node still loads; write export type { ... }`,
        );
      }
    }
  }
  return problems;
}

/** The path a unit sorts by: its head file, or its first base file when it has none. */
function key(unit: Unit): string {
  if (unit.kind === "gone") return unit.base;
  if (unit.kind === "ambiguous") return unit.base[0] ?? unit.name;
  return unit.head;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const root = () => git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  if (args.length === 1 && args[0] === "--strict-list") {
    const top = root();
    const problems = await strictListProblems(top, headFiles(top));
    for (const line of problems) console.log(line);
    if (problems.length === 0) console.log(`${STRICT_CONFIG} covers every TypeScript file`);
    return problems.length > 0 ? 1 : 0;
  }
  const baseRef = args[0] === "--base" ? args[1] : undefined;
  if (!baseRef || args.length !== 2) {
    console.error("usage: node scripts/port-check.ts --base <ref> | --strict-list");
    return 2;
  }
  const top = root();
  try {
    git(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], top);
  } catch {
    console.error(`port-check: ${baseRef} is not a commit`);
    return 2;
  }
  return checkPort(top, baseRef, headFiles(top));
}

process.exitCode = await main();
