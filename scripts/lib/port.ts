// Shared by scripts/port-check.ts and scripts/port-rename.ts: the public/ folder, and where a module's relative import
// paths, comments and string literals are.
import { parseSync } from "vite";

/** Served as written: Vite copies public/ to the build unchanged, and the build's `?v=` hash covers its .js bytes. */
export const PUBLIC = "public/";

/** A span of source text: `start` and `end` are UTF-16 offsets, the same as String#slice. */
export type Span = { start: number; end: number };

/** A relative import or export source. The span covers the string literal including its quotes. `inlineTypes` marks
 * `export { type A } from`, which oxc strips but Node keeps as `export {} from`, loading the module. */
export type Specifier = Span & { value: string; inlineTypes: boolean };

/** Relative specifiers (`./`, `../`) of every static import, export-from and dynamic import of a string literal or a
 * template literal without `${}`, in order, plus every comment. Throws on a syntax error, because a file that does
 * not parse cannot be compared or rewritten. */
export function scanModule(filename: string, code: string): { specifiers: Specifier[]; comments: Span[] } {
  const parsed = parseSync(filename, code);
  const firstError = parsed.errors[0];
  if (firstError) throw new Error(`${filename}: ${firstError.message}`);
  const sources: (Span & { inlineTypes: boolean })[] = [];
  for (const node of parsed.program.body) {
    if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration") {
      sources.push({ ...node.source, inlineTypes: false });
    } else if (node.type === "ExportNamedDeclaration" && node.source) {
      const { exportKind, specifiers } = node;
      const inlineTypes =
        exportKind === "value" && specifiers.length > 0 && specifiers.every((item) => item.exportKind === "type");
      sources.push({ ...node.source, inlineTypes });
    }
  }
  for (const entry of parsed.module.dynamicImports) sources.push({ ...entry.moduleRequest, inlineTypes: false });
  const specifiers: Specifier[] = [];
  for (const { start, end, inlineTypes } of sources) {
    const raw = code.slice(start, end);
    const quote = raw[0];
    if ((quote !== '"' && quote !== "'" && quote !== "`") || raw.at(-1) !== quote || raw.length < 2) continue;
    const value = raw.slice(1, -1);
    if (quote === "`" && value.includes("${")) continue;
    if (value.startsWith("./") || value.startsWith("../")) specifiers.push({ value, start, end, inlineTypes });
  }
  specifiers.sort((a, b) => a.start - b.start);
  const comments = parsed.comments.map(({ start, end }) => ({ start, end }));
  return { specifiers, comments };
}

/** Every string literal and template literal without `${}` in a module, with its value. A template literal with a
 * backslash is left out: its raw text is not its value. Throws on a syntax error, like scanModule. */
export function stringLiterals(filename: string, code: string): (Span & { value: string })[] {
  const parsed = parseSync(filename, code);
  const firstError = parsed.errors[0];
  if (firstError) throw new Error(`${filename}: ${firstError.message}`);
  const found: (Span & { value: string })[] = [];
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if ("type" in node && "start" in node && "end" in node) {
      const { type, start, end } = node;
      if (typeof start === "number" && typeof end === "number") {
        if (type === "Literal" && "value" in node && typeof node.value === "string") {
          found.push({ start, end, value: node.value });
        } else if (type === "TemplateLiteral" && "expressions" in node && Array.isArray(node.expressions)) {
          const raw = code.slice(start + 1, end - 1);
          if (node.expressions.length === 0 && !raw.includes("\\")) found.push({ start, end, value: raw });
        }
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(parsed.program);
  return found.sort((a, b) => a.start - b.start);
}

/** A specifier split into the file path and the query or hash after it (`./u.js?v=1` is `./u.js` and `?v=1`). */
export function splitSpecifier(value: string): { file: string; suffix: string } {
  const at = value.search(/[?#]/);
  return at === -1 ? { file: value, suffix: "" } : { file: value.slice(0, at), suffix: value.slice(at) };
}

/** Replaces each span with the text `replace` returns for it; spans must not overlap. */
export function replaceSpans<T extends Span>(code: string, spans: readonly T[], replace: (span: T) => string): string {
  let out = "";
  let at = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    out += code.slice(at, span.start) + replace(span);
    at = span.end;
  }
  return out + code.slice(at);
}
