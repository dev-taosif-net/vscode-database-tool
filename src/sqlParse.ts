import { UPPERCASE_TOKENS } from './sqlData';

/**
 * Tiny shared SQL text helpers used by completion and semantic highlighting.
 * Everything here is regex-based and statement-scoped — fast enough to run on
 * a keystroke, never a full parser.
 */

export const SQL_KEYWORDS = new Set(UPPERCASE_TOKENS);

export const IDENT = String.raw`(?:\[[^\]]+\]|"[^"]+"|[A-Za-z_][\w$]*)`;
export const QUALIFIED = `${IDENT}(?:\\.${IDENT})*`;

/** Table references (FROM/JOIN/UPDATE/INTO) with optional alias, as typed. */
const REF_RE = new RegExp(
  String.raw`\b(?:from|join|update|into)\s+(${QUALIFIED})(?:\s+(?:as\s+)?([A-Za-z_]\w*))?`,
  'gi'
);

export interface RawTableRef {
  /** reference exactly as typed (possibly schema-qualified / quoted) */
  text: string;
  alias?: string;
}

export function parseTableRefs(stmt: string): RawTableRef[] {
  const out: RawTableRef[] = [];
  for (const m of stmt.matchAll(REF_RE)) {
    let alias: string | undefined = m[2];
    if (alias && SQL_KEYWORDS.has(alias.toUpperCase())) alias = undefined;
    out.push({ text: m[1], alias });
  }
  return out;
}

export interface StatementSpan {
  start: number;
  end: number;
  text: string;
}

/** Split text into statements on top-level semicolons (heuristic: quotes-aware). */
export function splitStatements(text: string): StatementSpan[] {
  const out: StatementSpan[] = [];
  let start = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "'") {
      i++;
      while (i < n && (text[i] !== "'" || text[i + 1] === "'")) i += text[i] === "'" ? 2 : 1;
      i++;
    } else if (ch === '-' && text[i + 1] === '-') {
      while (i < n && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else if (ch === ';') {
      out.push({ start, end: i, text: text.slice(start, i) });
      start = i + 1;
      i++;
    } else {
      i++;
    }
  }
  if (start < n) out.push({ start, end: n, text: text.slice(start) });
  return out;
}
