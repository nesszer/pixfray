// Proves a TypeScript port changes no runtime code, and that tsconfig.strict.json checks every TypeScript file.
//
// `--base <ref>` pairs every code file at the merge base with `<ref>` against the working tree, strips both versions
// to JavaScript with oxc, and compares them. A file pairs with the same path; a file gone at head pairs with a new file
// of the same name (the path's base name without its code extension), first in the same folder, then anywhere in the
// repo. A name that more than one gone or new file shares fails instead of guessing. A gone file with no pair fails;
// a new file with no pair passes only when it strips to no runtime code. `--strict-list` checks only the strict list.
// Usage: node scripts/port-check.ts --base origin/main | node scripts/port-check.ts --strict-list
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { transformWithOxc } from "vite";
import { replaceSpans, scanModule } from "./lib/port.ts";

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

/** Pairs the code files that differ between the merge base and the working tree. */
function pairFiles(baseFiles: readonly string[], head: readonly string[], changed: ReadonlySet<string>): Unit[] {
  const headSet = new Set(head);
  const baseSet = new Set(baseFiles);
  const units: Unit[] = [];
  for (const file of baseFiles)
    if (headSet.has(file) && changed.has(file)) units.push({ kind: "compare", base: file, head: file });
  let gone = baseFiles.filter((file) => !headSet.has(file));
  let added = head.filter((file) => !baseSet.has(file));
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

/** The source line behind stripped line `index`, from the nearest mapped line after it, else before it. */
function sourceLine({ lines, sourceLines }: Runtime, index: number): string {
  if (index >= lines.length) return "at end of file";
  for (let i = index; i < sourceLines.length; i++) if (sourceLines[i]) return `line ${sourceLines[i]}`;
  for (let i = index - 1; i >= 0; i--) if (sourceLines[i]) return `line ${sourceLines[i]}`;
  return "line ?";
}

function show(line: string | undefined): string {
  if (line === undefined) return "(end of file)";
  const trimmed = line.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

async function checkPort(root: string, baseRef: string, files: readonly string[]): Promise<number> {
  const mergeBase = git(["merge-base", baseRef, "HEAD"], root).trim();
  const baseFiles = nulList(git(["ls-tree", "-r", "-z", "--name-only", mergeBase], root)).filter(codeExtension);
  const changed = new Set(nulList(git(["diff", "--name-only", "--no-renames", "-z", mergeBase], root)));
  const units = pairFiles(baseFiles, files.filter(codeExtension), changed);
  units.sort((a, b) => (key(a) < key(b) ? -1 : 1));

  // A head path of a moved file maps to its base path, so an import of it compares as the import of the base file.
  const movedFrom = new Map<string, string>();
  for (const unit of units) if (unit.kind === "compare" && unit.base !== unit.head) movedFrom.set(unit.head, unit.base);
  /** The import path the base version of `importer` would write to reach the base version of `value`'s target. */
  const asBase = (importer: string, baseImporter: string) => (value: string) => {
    const target = path.posix.join(path.posix.dirname(importer), value);
    const baseTarget = movedFrom.get(target) ?? target;
    if (baseTarget === target && path.posix.dirname(importer) === path.posix.dirname(baseImporter)) return value;
    const relative = path.posix.relative(path.posix.dirname(baseImporter), baseTarget);
    return relative.startsWith("../") ? relative : `./${relative}`;
  };
  const same = () => (value: string) => value;

  let compared = 0;
  let different = 0;
  let problems = 0;
  for (const unit of units) {
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
      const length = Math.max(base.lines.length, head.lines.length);
      let index = 0;
      while (index < length && base.lines[index] === head.lines[index]) index++;
      if (index === length) continue;
      different++;
      console.log(`${label} differs (base ${sourceLine(base, index)}, head ${sourceLine(head, index)})`);
      console.log(`  base: ${show(base.lines[index])}`);
      console.log(`  head: ${show(head.lines[index])}`);
    } catch (error) {
      different++;
      console.log(`${label} could not be compared: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const line of strictListProblems(root, files)) {
    console.log(line);
    problems++;
  }
  console.log(
    `${compared} files compared, ${different} different${problems > 0 ? `, ${problems} other problems` : ""}`,
  );
  return different > 0 || problems > 0 ? 1 : 0;
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
