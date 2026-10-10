// Starts a TypeScript port: renames each given .js or .mjs file to .ts and updates every tracked file that names it.
// Relative imports and exports that resolve to a renamed file get the .ts extension; repo paths in docs, configs and
// code comments are rewritten, and in a code comment next to the file its bare name too. Rewritten files are saved
// with LF line endings. Mentions left in code strings are listed, not changed: they are runtime values for the porter
// to decide on. Usage: node scripts/port-rename.ts <file.js> [more files]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { replaceSpans, scanModule, type Span } from "./lib/port.ts";

const CODE = /\.(?:m?js|ts)$/;
const SKIP =
  /^(?:bun\.lock|public\/assets\/.*)$|\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|glb|bin|zip|mp3|ogg|wav|pdf)$/i;

type Rename = { from: string; to: string; mention: RegExp; name: RegExp; dir: string };

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Rewrites repo-path mentions of renamed files in `text`; with `dir`, also bare names of renamed files in `dir`. */
function rewriteMentions(text: string, renames: readonly Rename[], dir?: string): string {
  let out = text;
  for (const rename of renames) out = out.replace(rename.mention, rename.to);
  if (dir === undefined) return out;
  for (const rename of renames) {
    if (rename.dir === dir) out = out.replace(rename.name, path.posix.basename(rename.to));
  }
  return out;
}

/** The code file with renamed imports and comment mentions rewritten, plus the import count and the line numbers that
 * still name a renamed file's repo path outside a comment. */
function rewriteCode(file: string, parseAs: string, code: string, renames: readonly Rename[]) {
  const dir = path.posix.dirname(file);
  const byPath = new Map(renames.map((rename) => [rename.from, rename]));
  const { specifiers, comments } = scanModule(parseAs, code);
  const edits: (Span & { text: string })[] = [];
  let imports = 0;
  for (const specifier of specifiers) {
    if (!byPath.has(path.posix.join(dir, specifier.value))) continue;
    const quote = code[specifier.start] ?? '"';
    edits.push({ ...specifier, text: `${quote}${specifier.value.replace(/\.m?js$/, ".ts")}${quote}` });
    imports++;
  }
  for (const comment of comments) {
    const text = code.slice(comment.start, comment.end);
    const rewritten = rewriteMentions(text, renames, dir);
    if (rewritten !== text) edits.push({ ...comment, text: rewritten });
  }
  const next = replaceSpans(code, edits, (edit) => edit.text);
  const blank = ({ start, end }: Span) => code.slice(start, end).replace(/[^\n]/g, " ");
  const bare = replaceSpans(code, [...comments, ...specifiers], blank);
  const stillNamed: number[] = [];
  bare.split("\n").forEach((line, index) => {
    if (renames.some((rename) => line.search(rename.mention) !== -1)) stillNamed.push(index + 1);
  });
  return { code: next, imports, stillNamed };
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: node scripts/port-rename.ts <file.js> [more files]");
    return 2;
  }
  const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
  const tracked = new Set(git(["ls-files", "-z"], root).split("\0").filter(Boolean));
  const renames: Rename[] = [];
  for (const arg of args) {
    const from = path.relative(root, path.resolve(arg)).split(path.sep).join("/");
    const to = from.replace(/\.m?js$/, ".ts");
    if (to === from || !tracked.has(from)) {
      console.error(`${arg}: not a tracked .js or .mjs file`);
      return 2;
    }
    if (existsSync(path.join(root, to))) {
      console.error(`${to} already exists`);
      return 2;
    }
    const mention = new RegExp(`(?<![\\w-])${escape(from)}(?!\\w)`, "g");
    const name = new RegExp(`(?<![\\w-])${escape(path.posix.basename(from))}(?!\\w)`, "g");
    renames.push({ from, to, mention, name, dir: path.posix.dirname(from) });
  }

  for (const rename of renames) {
    renameSync(path.join(root, rename.from), path.join(root, rename.to));
    console.log(`${rename.from} -> ${rename.to}`);
  }
  const renamedTo = new Map(renames.map((rename) => [rename.from, rename.to]));
  for (const original of [...tracked].sort()) {
    const file = renamedTo.get(original) ?? original;
    if (SKIP.test(file) || file.endsWith(".d.ts")) continue;
    const full = path.join(root, file);
    if (!existsSync(full)) continue;
    const raw = readFileSync(full, "utf8");
    if (raw.includes("\0")) continue;
    const text = raw.replace(/\r\n/g, "\n");
    let next = text;
    let imports = 0;
    if (CODE.test(file)) {
      const result = rewriteCode(file, original, text, renames);
      next = result.code;
      imports = result.imports;
      for (const line of result.stillNamed) console.log(`note: ${file}:${line} names a renamed file in code; check it`);
    } else {
      next = rewriteMentions(text, renames);
    }
    if (next === text && !(renamedTo.has(original) && raw !== text)) continue;
    writeFileSync(full, next);
    console.log(`updated ${file}${imports > 0 ? ` (${imports} import${imports === 1 ? "" : "s"})` : ""}`);
  }
  console.log(
    `Next: annotate the .ts files, add them to tsconfig.strict.json "files", run node scripts/port-check.ts --base origin/main`,
  );
  return 0;
}

process.exitCode = main();
