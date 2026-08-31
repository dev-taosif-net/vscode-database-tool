import * as vscode from 'vscode';
import { Catalog } from './catalog';
import { parseTableRefs, splitStatements, SQL_KEYWORDS } from './sqlParse';
import { MSSQL_FUNCTIONS, PG_FUNCTIONS } from './sqlData';

/**
 * Schema-aware SQL coloring via semantic tokens: table names, columns,
 * aliases, schemas and function/procedure names each get their own token type
 * (colored by the user's theme). Keywords/strings/comments are left to the
 * regular TextMate grammar. One linear scan of the document, map lookups only.
 */

const LEGEND = new vscode.SemanticTokensLegend([
  'namespace', // schemas
  'class',     // tables / views
  'property',  // columns
  'variable',  // table aliases
  'function',  // built-in functions, procedures, UDFs
]);
const T_NAMESPACE = 0;
const T_CLASS = 1;
const T_PROPERTY = 2;
const T_VARIABLE = 3;
const T_FUNCTION = 4;

const BUILTIN_FUNCTIONS = new Set<string>(
  [...PG_FUNCTIONS, ...MSSQL_FUNCTIONS].map(([name]) => name.toLowerCase())
);

const MAX_CHARS = 200_000;

/** strings · line comments · block comments · quoted identifiers · words */
const SCAN_RE = /('(?:[^']|'')*'?)|(--[^\n]*)|(\/\*[\s\S]*?\*\/)|(\[[^\]]*\]|"[^"]*")|([A-Za-z_][\w$#]*)/g;

interface StmtInfo {
  start: number;
  end: number;
  aliases: Set<string>;
  columns: Set<string>;
}

export interface SemanticApi {
  /** Re-color all open SQL editors (call after the catalog loads/refreshes). */
  refresh(): void;
}

export function registerSemanticTokens(
  ctx: vscode.ExtensionContext,
  activeCatalog: () => Catalog | undefined
): SemanticApi {
  const changed = new vscode.EventEmitter<void>();

  const provider: vscode.DocumentSemanticTokensProvider = {
    onDidChangeSemanticTokens: changed.event,
    provideDocumentSemanticTokens(document) {
      const builder = new vscode.SemanticTokensBuilder(LEGEND);
      const cat = activeCatalog();
      if (!cat) return builder.build();
      if (!vscode.workspace.getConfiguration('dbtool').get('semanticHighlighting', true)) {
        return builder.build();
      }
      const text = document.getText();
      if (text.length > MAX_CHARS) return builder.build();

      // Per-statement alias + referenced-column sets.
      const stmts: StmtInfo[] = splitStatements(text).map((s) => {
        const aliases = new Set<string>();
        const columns = new Set<string>();
        for (const ref of parseTableRefs(s.text)) {
          if (ref.alias) aliases.add(ref.alias.toLowerCase());
          const t = cat.resolve(ref.text);
          if (t) for (const c of t.columns) columns.add(c.name.toLowerCase());
        }
        return { start: s.start, end: s.end, aliases, columns };
      });

      let stmtIdx = 0;
      let m: RegExpExecArray | null;
      SCAN_RE.lastIndex = 0;
      while ((m = SCAN_RE.exec(text))) {
        const word = m[4] ?? m[5];
        if (!word) continue; // string or comment — skipped
        const offset = m.index;
        while (stmtIdx < stmts.length - 1 && offset > stmts[stmtIdx].end) stmtIdx++;
        const stmt = stmts[stmtIdx];

        const bare = word.replace(/[[\]"]/g, '');
        const lower = bare.toLowerCase();
        if (SQL_KEYWORDS.has(bare.toUpperCase())) continue;

        const prev = prevNonSpace(text, offset);
        const next = nextNonSpace(text, offset + word.length);

        let type = -1;
        if (next === '(' && (BUILTIN_FUNCTIONS.has(lower) || cat.isRoutine(lower))) {
          type = T_FUNCTION;
        } else if (stmt?.aliases.has(lower)) {
          type = T_VARIABLE;
        } else if (prev === '.') {
          // after a dot: column beats table beats anything else
          if (stmt?.columns.has(lower)) type = T_PROPERTY;
          else if (cat.resolve(lower)) type = T_CLASS;
        } else if (next === '.' && cat.isSchema(lower) && !cat.resolve(lower)) {
          type = T_NAMESPACE;
        } else if (cat.resolve(lower)) {
          type = T_CLASS;
        } else if (stmt?.columns.has(lower)) {
          type = T_PROPERTY;
        } else if (cat.isRoutine(lower)) {
          type = T_FUNCTION;
        }
        if (type < 0) continue;

        const pos = document.positionAt(offset);
        builder.push(pos.line, pos.character, word.length, type);
      }
      return builder.build();
    },
  };

  ctx.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider({ language: 'sql' }, provider, LEGEND),
    changed
  );

  return { refresh: () => changed.fire() };
}

function prevNonSpace(text: string, offset: number): string {
  let i = offset - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--;
  return i >= 0 ? text[i] : '';
}

function nextNonSpace(text: string, offset: number): string {
  let i = offset;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  return i < text.length ? text[i] : '';
}
