// Shared by scripts/port-check.ts and scripts/port-rename.ts: where a module's relative import paths and comments are.
import { parseSync } from "vite";

/** A span of source text: `start` and `end` are UTF-16 offsets, the same as String#slice. */
export type Span = { start: number; end: number };

/** A relative import or export source. The span covers the string literal including its quotes. `inlineTypes` marks
 * `export { type A } from`, which oxc strips but Node keeps as `export {} from`, loading the module. */
export type Specifier = Span & { value: string; inlineTypes: boolean };

/** Relative specifiers (`./`, `../`) of every static import, export-from and string-literal dynamic import, in order,
 * plus every comment. Throws on a syntax error, because a file that does not parse cannot be compared or rewritten. */
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
    if ((quote !== '"' && quote !== "'") || raw.at(-1) !== quote || raw.length < 2) continue;
    const value = raw.slice(1, -1);
    if (value.startsWith("./") || value.startsWith("../")) specifiers.push({ value, start, end, inlineTypes });
  }
  specifiers.sort((a, b) => a.start - b.start);
  const comments = parsed.comments.map(({ start, end }) => ({ start, end }));
  return { specifiers, comments };
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
