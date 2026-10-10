// Proves a TypeScript port changes no runtime code, and that tsconfig.strict.json checks every TypeScript file.
//
// `--base <ref>` pairs every file at the merge base with `<ref>` against the working tree. Code files are stripped to
// JavaScript with oxc and compared. A file pairs with the same path; a code file gone at head pairs with a new code file
// of the same name (the path's base name without its code extension), first in the same folder, then anywhere in the
// repo. A name that more than one gone or new file shares fails instead of guessing. A gone file with no pair fails;
// a new code file with no pair passes only when it strips to no runtime code. Other changed files fail unless they
// don't ship (UNSHIPPED) or their only change names a moved code file's new path. Every relative import at head must
// name a file at head, and none may re-export only inline types. `--strict-list` checks only the strict list.
// Usage: node scripts/port-check.ts --base origin/main | node scripts/port-check.ts --strict-list
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { transformWithOxc } from "vite";
import { replaceSpans, scanModule, type Specifier } from "./lib/port.ts";

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
  [/(?:^|\/)tsconfig[^/]*\.json$/, "type-check config"],
  [/^\.coderabbit\.yaml$/, "review config"],
];

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

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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

/** Files in the working tree, tracked or untracked but not ignored. */
function headFiles(root: string): string[] {
  const listed = nulList(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root));
  return [...new Set(listed)].filter((file) => existsSync(path.join(root, file)));
}

/** The `include` and `files` entries of a tsconfig, as written. The file is JSONC: comments and trailing commas are
 * dropped outside strings before parsing. */
function tsconfigEntries(root: string, config: string): Set<string> {
  const text = readFileSync(path.join(root, config), "utf8");
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
  const parsed: unknown = JSON.parse(json.replace(/,(\s*[}\]])/g, "$1"));
  const entries = new Set<string>();
  if (typeof parsed !== "object" || parsed === null) return entries;
  for (const key of ["include", "files"]) {
    const list: unknown = key in parsed ? (parsed as Record<string, unknown>)[key] : undefined; // `key in parsed` holds
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
 * template literals at runtime. `specifier` rewrites each relative import path in the stripped code. */
async function runtimeCode(file: string, source: string, specifier: (value: string) => string): Promise<Runtime> {
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
  const { specifiers } = scanModule(strippedName, stripped);
  const runtime = replaceSpans(stripped, specifiers, ({ value }) => JSON.stringify(specifier(value)));
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

function show(line: string | undefined): string {
  if (line === undefined) return "(end of file)";
  const trimmed = line.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

async function checkPort(root: string, baseRef: string, files: readonly string[]): Promise<number> {
  const mergeBase = git(["merge-base", baseRef, "HEAD"], root).trim();
  const baseFiles = nulList(git(["ls-tree", "-r", "-z", "--name-only", mergeBase], root));
  const changed = new Set(nulList(git(["diff", "--name-only", "--no-renames", "-z", mergeBase], root)));
  const units = pairFiles(baseFiles, files, changed);
  units.sort((a, b) => (key(a) < key(b) ? -1 : 1));

  // A head path of a moved file maps to its base path, so a path that names it compares as one naming the base file.
  const movedFrom = new Map<string, string>();
  for (const unit of units) if (unit.kind === "compare" && unit.base !== unit.head) movedFrom.set(unit.head, unit.base);
  /** `written`, a path in head file `file`, as base file `baseFile` would write it to reach the base version of the
   * same target. `./` and `../` paths resolve from the file's folder, `/` paths from the repo root or public/ (Vite
   * serves both at `/`), and other paths from the repo root. */
  const asBase = (file: string, baseFile: string) => (written: string) => {
    if (written.startsWith("./") || written.startsWith("../")) {
      const target = path.posix.join(path.posix.dirname(file), written);
      const baseTarget = movedFrom.get(target) ?? target;
      if (baseTarget === target && path.posix.dirname(file) === path.posix.dirname(baseFile)) return written;
      const relative = path.posix.relative(path.posix.dirname(baseFile), baseTarget);
      return relative.startsWith("../") ? relative : `./${relative}`;
    }
    const lead = written.startsWith("/") ? "/" : "";
    for (const served of lead ? ["", "public/"] : [""]) {
      const baseTarget = movedFrom.get(served + written.slice(lead.length));
      if (baseTarget?.startsWith(served)) return lead + baseTarget.slice(served.length);
    }
    return written;
  };
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
      if (codeExtension(unit.head) === undefined) {
        if (unit.kind === "new") {
          different++;
          console.log(`${label} is new and ships`);
          continue;
        }
        const base = execFileSync("git", ["show", `${mergeBase}:${unit.base}`], {
          cwd: root,
          maxBuffer: 64 * 1024 * 1024,
        });
        const head = readFileSync(path.join(root, unit.head));
        if (base.length === head.length && base.every((byte, index) => byte === head[index])) continue;
        if (base.includes(0) || head.includes(0)) {
          different++;
          console.log(`${label} differs (binary)`);
          continue;
        }
        const baseLines = new TextDecoder().decode(base).split("\n");
        const headLines = new TextDecoder().decode(head).split("\n");
        const rewritten = headLines.map((line) => line.replace(CODE_PATH, asBase(unit.head, unit.head)));
        const index = firstDifference(baseLines, rewritten);
        if (index === -1) {
          console.log(`allowed: ${label} (only renamed paths changed)`);
          continue;
        }
        different++;
        console.log(`${label} differs (line ${index + 1})`);
        console.log(`  base: ${show(baseLines[index])}`);
        console.log(`  head: ${show(headLines[index])}`);
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
      const base = await runtimeCode(unit.base, git(["show", `${mergeBase}:${unit.base}`], root), same());
      const head = await runtimeCode(unit.head, headSource, asBase(unit.head, unit.base));
      const index = firstDifference(base.lines, head.lines);
      if (index === -1) continue;
      different++;
      console.log(`${label} differs (base ${sourceLine(base, index)}, head ${sourceLine(head, index)})`);
      console.log(`  base: ${show(base.lines[index])}`);
      console.log(`  head: ${show(head.lines[index])}`);
    } catch (error) {
      different++;
      console.log(`${label} could not be compared: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const line of [...importProblems(root, files), ...strictListProblems(root, files)]) {
    console.log(line);
    problems++;
  }
  console.log(
    `${compared} files compared, ${different} different${problems > 0 ? `, ${problems} other problems` : ""}`,
  );
  return different > 0 || problems > 0 ? 1 : 0;
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
      const target = path.posix.join(path.posix.dirname(file), value.replace(/[?#].*$/s, ""));
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
  return checkPort(top, baseRef, headFiles(top));
}

process.exitCode = await main();
