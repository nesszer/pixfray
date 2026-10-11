// The modules served at fixed URLs (/overlay.js, /hats.js, /upload.js, ...): their source is src/served/<name>.js or
// .ts, and vite.config.ts serves each as plain JavaScript under /<name>.js. OBS keeps running cached code after a
// reload, so the build adds ?v=<hash of the served code> to every reference between them and in public/*.html, and
// the overlay compares that hash with the page's to reload itself (src/served/overlay.ts). Kept under scripts/, so
// the owner editor can read it but never save it (server/developer.ts BUILD_FILE).
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { transformWithOxc } from "vite";

export const SERVED_DIR = "src/served";

/** Each served module's name (the URL without `/` and `.js`) and its source file, sorted by name. Throws when a name
 * has both a .js and a .ts source, since only one of them could be served. */
export function servedSources(dir: string = SERVED_DIR): { name: string; file: string }[] {
  const found = new Map<string, string>();
  for (const entry of readdirSync(dir).sort()) {
    const name = /^([\w-]+)\.(?:js|ts)$/.exec(entry)?.[1];
    if (name === undefined) continue;
    const other = found.get(name);
    if (other !== undefined) throw new Error(`${dir}: ${other} and ${entry} would both be served as /${name}.js`);
    found.set(name, entry);
  }
  return [...found].map(([name, entry]) => ({ name, file: path.join(dir, entry) }));
}

/** The JavaScript a source serves as: types stripped and the code reprinted by oxc, comments kept, the same
 * transform for .js and .ts, so a rename to .ts that only adds types and leaves comments alone serves the same code. */
export async function stripServed(file: string, source: string): Promise<string> {
  const { code } = await transformWithOxc(source, file, {
    lang: file.endsWith(".ts") ? "ts" : "js",
    tsconfig: false,
    typescript: { onlyRemoveTypeImports: true },
  });
  return code;
}

/** Points every quoted `./<name>.ts` or `./<name>.js` of a served module at `./<name>.js?v=<version>`, or at
 * `./<name>.js` when `version` is empty (the dev server). Other paths stay as they are. */
export function linkServed(text: string, names: readonly string[], version: string): string {
  const suffix = version ? `?v=${version}` : "";
  return text.replace(/(["'])\.\/([\w-]+)\.(?:ts|js)\1/g, (whole, quote: string, name: string) =>
    names.includes(name) ? `${quote}./${name}.js${suffix}${quote}` : whole,
  );
}

/** One version for all served modules: the first 10 lowercase hex digits of a SHA-256 over each module's URL name
 * and served code with its imports linked unversioned, in name order, so `./x.ts` and `./x.js` hash alike. It
 * changes when served code or a served comment does; the overlay's check reads 6 to 64 hex digits (src/served/overlay.ts
 * overlayVersionFromUrl). */
export function servedVersion(modules: readonly { name: string; code: string }[]): string {
  const hash = createHash("sha256"),
    names = modules.map((m) => m.name);
  for (const { name, code } of [...modules].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))
    hash.update(`${name}.js`).update(linkServed(code, names, ""));
  return hash.digest("hex").slice(0, 10);
}
