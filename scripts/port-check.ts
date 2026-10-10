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
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
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
} as const;
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

/** Where the base is checked out and built, one folder per commit, git-ignored. port-check reuses a folder and never
 * deletes one; recycle old ones by hand. */
const CACHE = ".port-check";

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

function codeExtension(file: string): CodeExtension | undefined {
  const ext = path.posix.extname(file);
  return ext in LANG ? (ext as CodeExtension) : undefined; // `in LANG` proves ext is one of its keys
}

/** The name files pair by: the base name without its code extension (`types/a.d.ts` is `a.d`). */
function stem(file: string): string {
  return path.posix.basename(file, path.posix.extname(file));
}

/** Files in the working tree, tracked or untracked but not ignored, without port-check's own CACHE (a branch from
 * before .gitignore named it would otherwise list every base copy). */
function headFiles(root: string): string[] {
  const listed = nulList(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root));
  return [...new Set(listed)].filter((file) => !file.startsWith(`${CACHE}/`) && existsSync(path.join(root, file)));
}

/** A JSONC file (a tsconfig) as an object: comments and trailing commas are dropped outside strings before parsing. A
 * file that is not an object reads as `{}`. */
function parseJsonc(text: string): Record<string, unknown> {
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
  return asObject(JSON.parse(json.replace(/,(\s*[}\]])/g, "$1")));
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
}

/** The `include` and `files` entries of a tsconfig, as written. */
function tsconfigEntries(root: string, config: string): Set<string> {
  const parsed = parseJsonc(readFileSync(path.join(root, config), "utf8"));
  const entries = new Set<string>();
  for (const list of [parsed["include"], parsed["files"]]) {
    if (Array.isArray(list)) for (const entry of list) entries.add(path.posix.normalize(String(entry)));
  }
  return entries;
}

/** One line per TypeScript file in the working tree that no strict program checks. */
function strictListProblems(root: string, files: readonly string[]): string[] {
  const listed = existsSync(path.join(root, STRICT_CONFIG)) ? tsconfigEntries(root, STRICT_CONFIG) : new Set();
  const problems: string[] = [];
  for (const file of [...files].sort()) {
    if (!/\.(?:ts|mts|cts|tsx)$/.test(file) || listed.has(file)) continue;
    const program = STRICT_EXCLUSIONS[file];
    if (program === undefined) problems.push(`${file} is not in ${STRICT_CONFIG}`);
    else if (!existsSync(path.join(root, program)) || !tsconfigEntries(root, program).has(file)) {
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

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Compares a file byte for byte and prints its first differing line. `rewrite`, when given, maps each head line
 * first, and a file that matches only after it prints as allowed. `why` is added to the difference line. Returns true
 * when the file differs. */
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
  if (index === -1 && rewrite) {
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
  // The builds run while the files are compared. `files` was listed first, so the build's output is not in it.
  const building = baseFiles.includes(BUILD_CONFIG) || files.includes(BUILD_CONFIG);
  const builds = building
    ? buildBoth(root, mergeBase).catch((error: unknown) => ({
        base: "",
        failures: [`the builds could not start: ${error instanceof Error ? error.message : String(error)}`],
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
  if (builds) {
    const { base, failures } = await builds;
    for (const failure of failures) console.log(failure);
    problems += failures.length;
    if (failures.length > 0) buildSummary = "; the build failed";
    else {
      const outputs = compareOutputs(base, root);
      outputsDifferent = outputs.different;
      buildSummary = `; ${outputs.compared} build output files compared, ${outputs.different} different`;
    }
  }
  const publicTypeScript = files
    .filter((file) => file.startsWith(PUBLIC) && /\.(?:ts|mts|cts|tsx)$/.test(file))
    .sort()
    .map((file) => `${file} is TypeScript under public/, which serves code as written`);
  for (const line of [...publicTypeScript, ...importProblems(root, files), ...strictListProblems(root, files)]) {
    console.log(line);
    problems++;
  }
  const others = problems > 0 ? `, ${problems} other problems` : "";
  console.log(`${compared} files compared, ${different} different${buildSummary}${others}`);
  return different > 0 || outputsDifferent > 0 || problems > 0 ? 1 : 0;
}

/** The merge base checked out at CACHE/<sha> through a scratch index, so the repo's own index stays as it is. A folder
 * already there is reused; a new one is written as <sha>.partial and renamed once complete. */
function checkoutBase(root: string, sha: string): string {
  const dir = path.join(root, CACHE, sha);
  if (existsSync(dir)) return dir;
  const partial = `${dir}.partial`;
  mkdirSync(partial, { recursive: true });
  const env = { ...process.env, GIT_INDEX_FILE: `${dir}.index` };
  git(["read-tree", sha], root, env);
  git(["checkout-index", "--all", "--force", `--prefix=${partial.split(path.sep).join("/")}/`], root, env);
  renameSync(partial, dir);
  return dir;
}

/** Builds the merge base (checked out under CACHE) and the working tree at once. Resolves to the base folder and one
 * report block per failed build. The base folder has no node_modules, so its build loads the repo's packages from
 * above it. That is sound: a change to package.json or bun.lock already fails the file checks, so both builds would
 * install the same packages. */
async function buildBoth(root: string, mergeBase: string): Promise<{ base: string; failures: string[] }> {
  const base = checkoutBase(root, mergeBase);
  const [baseError, headError] = await Promise.all([runBuild(base), runBuild(root)]);
  const failures: string[] = [];
  if (baseError !== undefined) {
    failures.push(`the base build failed (bunx cf build in ${CACHE}/${mergeBase}):\n${baseError}`);
  }
  if (headError !== undefined) failures.push(`the head build failed (bunx cf build):\n${headError}`);
  return { base, failures };
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
    if (index === -1) continue;
    different++;
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
    const problems = strictListProblems(top, headFiles(top));
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
