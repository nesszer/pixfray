// Shared by scripts/port-check.ts and scripts/port-rename.ts: where a module's relative import paths and comments are.
import { parseSync } from "vite";

/** A span of source text: `start` and `end` are UTF-16 offsets, the same as String#slice. */
export type Span = { start: number; end: number };

/** A relative import or export source. The span covers the string literal including its quotes. */
export type Specifier = Span & { value: string };

/** Relative specifiers (`./`, `../`) of every static import, export-from and string-literal dynamic import, in order,
 * plus every comment. Throws on a syntax error, because a file that does not parse cannot be compared or rewritten. */
export function scanModule(filename: string, code: string): { specifiers: Specifier[]; comments: Span[] } {
  const parsed = parseSync(filename, code);
  const firstError = parsed.errors[0];
  if (firstError) throw new Error(`${filename}: ${firstError.message}`);
  const spans: Span[] = [];
  for (const entry of parsed.module.staticImports) spans.push(entry.moduleRequest);
  for (const entry of parsed.module.staticExports) {
    for (const item of entry.entries) if (item.moduleRequest) spans.push(item.moduleRequest);
  }
  for (const entry of parsed.module.dynamicImports) spans.push(entry.moduleRequest);
  const byStart = new Map<number, Specifier>();
  for (const { start, end } of spans) {
    const raw = code.slice(start, end);
    const quote = raw[0];
    if ((quote !== '"' && quote !== "'") || raw.at(-1) !== quote || raw.length < 2) continue;
    const value = raw.slice(1, -1);
    if (value.startsWith("./") || value.startsWith("../")) byStart.set(start, { value, start, end });
  }
  const specifiers = [...byStart.values()].sort((a, b) => a.start - b.start);
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
