// The last step of `bun run typecheck`: every TypeScript file in the working tree (tracked, or new and not ignored) is
// in one of the strict programs, no program loosens a check, and no file in them turns checking off. A declaration
// file fails because skipLibCheck leaves it unchecked; a lint directive fails because it could turn off ban-ts-comment.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIGS = ["worker", "web", "node", "node-dom", "node-all"].map((name) => `tsconfig.${name}.json`);
const STRICT_ON = [
  "strict",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "verbatimModuleSyntax",
  "erasableSyntaxOnly",
];
const TURNS_OFF = ["noCheck", "noLib", "noResolve", "noStrictGenericChecks"];
const OFF_SWITCH = /@ts-no[c]heck|\b(?:eslint|oxlint)-disable/i; // [c] keeps this line from matching itself
const tscBin = path.join(path.dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))), "bin", "tsc");
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26 });
const tsc = (...args: string[]) => run(process.execPath, [tscBin, ...args]);
const root = process.cwd().split(path.sep).join("/") + "/";

const problems: string[] = [];
const checked = new Set<string>();
for (const config of CONFIGS) {
  // as: tsc --showConfig prints the resolved config as JSON
  const options = (JSON.parse(tsc("-p", config, "--showConfig")) as { compilerOptions: Record<string, unknown> })
    .compilerOptions;
  for (const name of STRICT_ON) if (options[name] !== true) problems.push(`${config} must set ${name} to true`);
  for (const [name, value] of Object.entries(options)) {
    const loose = TURNS_OFF.includes(name) ? value === true : /^(?:strict|no)[A-Z]|^alwaysStrict$/.test(name) && !value;
    if (loose) problems.push(`${config} sets ${name} to ${String(value)}, which checks less`);
  }
  for (const line of tsc("-p", config, "--listFilesOnly").split(/\r?\n/)) {
    const file = line.trim().replace(/\\/g, "/");
    if (file.toLowerCase().startsWith(root.toLowerCase()) && !file.includes("/node_modules/"))
      checked.add(file.slice(root.length));
  }
}
const files = run("git", ["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n");
for (const file of files.filter((f) => /\.[cm]?tsx?$/.test(f) && existsSync(f)))
  if (!checked.has(file)) problems.push(`${file} is not in any of ${CONFIGS.join(", ")}`);
for (const file of [...checked].sort()) {
  if (/\.d\.[^/]*ts$/.test(file)) problems.push(`${file} is a declaration file, which skipLibCheck skips; name it .ts`);
  const hit = OFF_SWITCH.exec(readFileSync(file, "utf8"));
  if (hit) problems.push(`${file} has ${hit[0]}, which turns a check off`);
}
for (const problem of problems) console.error(problem);
process.exit(problems.length ? 1 : 0);
