import * as vscode from 'vscode';
import { DbKind } from './types';
import { Catalog, CatalogTable, CatalogRoutine, quoteName } from './catalog';
import { parseTableRefs, SQL_KEYWORDS, QUALIFIED } from './sqlParse';
import {
  COMMON_KEYWORDS, FnDoc, MSSQL_FUNCTIONS, MSSQL_KEYWORDS, PG_FUNCTIONS, PG_KEYWORDS,
} from './sqlData';

/**
 * SQL completions, four layers:
 *  1. Static keywords + built-in functions (built once per dialect, cached).
 *  2. Statement-start snippets: typing `select` offers `SELECT * FROM `, etc.
 *  3. Schema-aware items from the connected DB's catalog: tables after
 *     FROM/JOIN/INTO/UPDATE, columns after `alias.` / `table.` / `schema.`,
 *     procedures after EXEC/CALL, and columns of the tables referenced in the
 *     current statement.
 *  4. JOIN auto-generation from foreign keys: after `JOIN ` a complete
 *     `table alias ON alias.fk = other.pk` clause; after `JOIN t x ` or
 *     `... ON ` the matching FK condition.
 * Items are prebuilt right after the catalog loads (see prewarm), so the
 * per-keystroke path is regexes + map lookups only — no allocation storms.
 */

/** ... FROM | / JOIN | / INSERT INTO | / UPDATE |  → table names. */
const TABLE_KEYWORD_TAIL = /\b(from|join|into|update)\s+$/i;
/** ... JOIN tbl [AS alias] ON |  → generated FK condition. */
const ON_TAIL = new RegExp(String.raw`\bjoin\s+(${QUALIFIED})(?:\s+(?:as\s+)?([A-Za-z_]\w*))?\s+on\s+$`, 'i');
/** ... JOIN tbl [AS alias] |  → "ON a.col = b.col" suggestion. */
const JOINED_TABLE_TAIL = new RegExp(String.raw`\bjoin\s+(${QUALIFIED})(?:\s+(?:as\s+)?([A-Za-z_]\w*))?\s+$`, 'i');
/** identifier chain directly before a typed `.` */
const DOT_TAIL = new RegExp(`(${QUALIFIED})\\.$`);
/** EXEC / EXECUTE / CALL followed by a (partial) routine name → procedures. */
const EXEC_TAIL = /\b(exec(?:ute)?|call)\s+[\w$.[\]"]*$/i;
/** Only the statement's first word typed so far → statement snippets apply. */
const STMT_START = /^\s*[A-Za-z_]*$/;

export interface CompletionApi {
  /** Prebuild all catalog-derived items so the first keystroke has zero lag. */
  prewarm(cat: Catalog): void;
}

export function registerCompletions(
  ctx: vscode.ExtensionContext,
  activeKind: () => DbKind | undefined,
  activeCatalog: () => Catalog | undefined
): CompletionApi {
  const staticCache = new Map<string, vscode.CompletionItem[]>();
  const snippetCache = new Map<string, vscode.CompletionItem[]>();
  const tableItemCache = new WeakMap<Catalog, vscode.CompletionItem[]>();
  const columnItemCache = new WeakMap<CatalogTable, vscode.CompletionItem[]>();
  const routineItemCache = new WeakMap<Catalog, vscode.CompletionItem[]>();
  const execItemCache = new WeakMap<Catalog, vscode.CompletionItem[]>();

  const columnItems = (cat: Catalog, t: CatalogTable): vscode.CompletionItem[] => {
    let items = columnItemCache.get(t);
    if (!items) {
      items = t.columns.map((c, i) => {
        const item = new vscode.CompletionItem(
          { label: c.name, description: t.name },
          vscode.CompletionItemKind.Field
        );
        item.detail = c.dataType;
        item.insertText = quoteName(c.name, cat.kind);
        item.sortText = '03' + String(i).padStart(3, '0');
        return item;
      });
      columnItemCache.set(t, items);
    }
    return items;
  };

  const tableItems = (cat: Catalog, schema?: string): vscode.CompletionItem[] => {
    if (schema) return cat.tablesInSchema(schema).map((t) => tableItem(cat, t));
    let items = tableItemCache.get(cat);
    if (!items) {
      items = cat.tables.map((t) => tableItem(cat, t));
      tableItemCache.set(cat, items);
    }
    return items;
  };

  const routineItems = (cat: Catalog): vscode.CompletionItem[] => {
    let items = routineItemCache.get(cat);
    if (!items) {
      items = cat.routines.map((r) => routineItem(cat, r, false));
      routineItemCache.set(cat, items);
    }
    return items;
  };

  const execItems = (cat: Catalog): vscode.CompletionItem[] => {
    let items = execItemCache.get(cat);
    if (!items) {
      items = cat.routines.map((r) => routineItem(cat, r, true));
      execItemCache.set(cat, items);
    }
    return items;
  };

  const provider: vscode.CompletionItemProvider = {
    provideCompletionItems(document, position, _token, context) {
      const cat = activeCatalog();
      const stmt = statementAt(document, position);
      const byTrigger = context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter;

      // `alias.` / `table.` / `schema.` — only schema-aware items make sense.
      if (byTrigger && context.triggerCharacter === '.') {
        if (!cat) return [];
        return dotItems(stmt, cat, columnItems, tableItems);
      }

      // EXEC / CALL — stored procedures & functions, ready-to-fill templates.
      if (cat && EXEC_TAIL.test(stmt.before)) {
        return execItems(cat);
      }

      const refs = cat ? parseRefs(stmt.full, cat) : [];
      const ctxResult = cat
        ? contextItems(stmt.before, refs, cat, tableItems)
        : { exclusive: false, items: [] as vscode.CompletionItem[] };
      if (ctxResult.exclusive) return ctxResult.items;

      const aliasItems = aliasSuggestions(document, position);

      // Bare space: only high-signal contextual suggestions, never keyword spam.
      if (byTrigger && context.triggerCharacter === ' ') {
        return [...ctxResult.items, ...aliasItems];
      }

      const kind = activeKind();
      const key = kind ?? 'both';
      let statics = staticCache.get(key);
      if (!statics) {
        statics = buildStatic(kind);
        staticCache.set(key, statics);
      }
      let snippets = snippetCache.get(key);
      if (!snippets) {
        snippets = buildSnippets(kind);
        snippetCache.set(key, snippets);
      }

      const items: vscode.CompletionItem[] = [];
      if (STMT_START.test(stmt.before)) items.push(...snippets);
      items.push(...ctxResult.items, ...aliasItems);
      if (cat) {
        const seen = new Set<CatalogTable>();
        for (const ref of refs) {
          if (ref.table && !seen.has(ref.table)) {
            seen.add(ref.table);
            items.push(...columnItems(cat, ref.table));
          }
        }
        items.push(...tableItems(cat), ...routineItems(cat));
      }
      items.push(...statics);
      return items;
    },
  };

  ctx.subscriptions.push(
    vscode.languages.registerCompletionItemProvider([{ language: 'sql' }], provider, ' ', '.')
  );

  return {
    prewarm(cat: Catalog): void {
      tableItems(cat);
      routineItems(cat);
      execItems(cat);
      for (const t of cat.tables) columnItems(cat, t);
    },
  };
}

// ------------------------------------------------------- statement awareness

interface StmtCtx {
  /** Whole statement around the cursor (between semicolons). */
  full: string;
  /** Statement text from its start up to the cursor. */
  before: string;
}

function statementAt(document: vscode.TextDocument, position: vscode.Position): StmtCtx {
  // Bounded window so huge files never make a keystroke expensive.
  const startLine = Math.max(0, position.line - 300);
  const endLine = Math.min(document.lineCount - 1, position.line + 300);
  const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
  const text = document.getText(range);
  const cursor = document.offsetAt(position) - document.offsetAt(range.start);
  const start = text.lastIndexOf(';', cursor - 1) + 1;
  let end = text.indexOf(';', cursor);
  if (end < 0) end = text.length;
  return { full: text.slice(start, end), before: text.slice(start, cursor) };
}

interface TableRef {
  /** table reference exactly as typed (possibly schema-qualified/quoted) */
  text: string;
  alias?: string;
  table?: CatalogTable;
}

function parseRefs(stmt: string, cat: Catalog): TableRef[] {
  return parseTableRefs(stmt).map((r) => ({ ...r, table: cat.resolve(r.text) }));
}

/** How a table's columns are prefixed in generated conditions. */
function refPrefix(ref: TableRef): string {
  return ref.alias ?? ref.text;
}

// ------------------------------------------------------- contextual items

type TableItemsFn = (cat: Catalog, schema?: string) => vscode.CompletionItem[];
type ColumnItemsFn = (cat: Catalog, t: CatalogTable) => vscode.CompletionItem[];

function contextItems(
  before: string,
  refs: TableRef[],
  cat: Catalog,
  tableItems: TableItemsFn
): { exclusive: boolean; items: vscode.CompletionItem[] } {
  // `JOIN x [a] ON ` — offer the FK condition(s); checked first because the
  // looser JOINED_TABLE_TAIL would swallow the trailing ON as an alias.
  const onMatch = ON_TAIL.exec(before);
  if (onMatch) {
    const items = fkConditionItems(onMatch[1], onMatch[2], refs, cat, '');
    if (items.length) return { exclusive: true, items };
    return { exclusive: false, items: [] };
  }

  // `FROM ` / `JOIN ` / `INSERT INTO ` / `UPDATE ` — table names (plus, after
  // JOIN, complete FK-generated join clauses ranked first).
  const kw = TABLE_KEYWORD_TAIL.exec(before);
  if (kw) {
    const items: vscode.CompletionItem[] = [];
    if (kw[1].toLowerCase() === 'join') items.push(...smartJoinItems(refs, cat));
    items.push(...tableItems(cat));
    return { exclusive: true, items };
  }

  // `JOIN x ` / `JOIN x a ` — offer "ON a.col = b.col" alongside alias ideas.
  const joined = JOINED_TABLE_TAIL.exec(before);
  if (joined) {
    let alias: string | undefined = joined[2];
    if (alias && SQL_KEYWORDS.has(alias.toUpperCase())) alias = undefined;
    return { exclusive: false, items: fkConditionItems(joined[1], alias, refs, cat, 'ON ') };
  }

  return { exclusive: false, items: [] };
}

/**
 * FK conditions for the table just joined (`joinedText` [+ alias]) against
 * every other table referenced in the statement. `prefix` is '' after an
 * explicit ON, or 'ON ' when the clause still needs the keyword.
 */
function fkConditionItems(
  joinedText: string,
  alias: string | undefined,
  refs: TableRef[],
  cat: Catalog,
  prefix: string
): vscode.CompletionItem[] {
  const joined = cat.resolve(joinedText);
  if (!joined) return [];
  const myPrefix = alias ?? joinedText;
  const out: vscode.CompletionItem[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref.table) continue;
    // Skip the joined occurrence itself (but keep self-joins under other aliases).
    if (ref.table === joined && (ref.alias ?? '') === (alias ?? '')) continue;
    for (const j of cat.joins(joined, ref.table)) {
      const cond = j.aColumns
        .map((c, i) => `${myPrefix}.${quoteName(c, cat.kind)} = ${refPrefix(ref)}.${quoteName(j.bColumns[i], cat.kind)}`)
        .join(' AND ');
      const text = prefix + cond;
      if (seen.has(text)) continue;
      seen.add(text);
      const item = new vscode.CompletionItem(
        { label: text, description: 'foreign key' },
        vscode.CompletionItemKind.Snippet
      );
      item.insertText = text;
      item.detail = `${joined.name} ↔ ${ref.table.name}`;
      item.sortText = '00' + String(out.length).padStart(2, '0');
      item.preselect = out.length === 0;
      out.push(item);
    }
  }
  return out;
}

/** After `JOIN ` — complete `table alias ON alias.fk = other.pk` clauses from FKs. */
function smartJoinItems(refs: TableRef[], cat: Catalog): vscode.CompletionItem[] {
  if (!vscode.workspace.getConfiguration('dbtool').get('smartJoins', true)) return [];
  const used = new Set(refs.map((r) => (r.alias ?? r.text).toLowerCase()));
  const out: vscode.CompletionItem[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref.table) continue;
    for (const rel of cat.related(ref.table)) {
      const alias = pickAlias(rel.table.name, used);
      const cond = rel.otherColumns
        .map((c, i) => `${alias}.${quoteName(c, cat.kind)} = ${refPrefix(ref)}.${quoteName(rel.myColumns[i], cat.kind)}`)
        .join(' AND ');
      const text = `${qualify(rel.table, cat)} ${alias} ON ${cond}`;
      if (seen.has(text)) continue;
      seen.add(text);
      const item = new vscode.CompletionItem(
        { label: text, description: 'FK join' },
        vscode.CompletionItemKind.Snippet
      );
      item.insertText = text;
      item.detail = 'JOIN generated from foreign key';
      item.sortText = '00' + rel.table.name;
      out.push(item);
      if (out.length >= 30) return out;
    }
  }
  return out;
}

function dotItems(
  stmt: StmtCtx,
  cat: Catalog,
  columnItems: ColumnItemsFn,
  tableItems: TableItemsFn
): vscode.CompletionItem[] {
  const m = DOT_TAIL.exec(stmt.before);
  if (!m) return [];
  const chain = m[1];
  const bare = chain.replace(/[[\]"]/g, '');

  if (!chain.includes('.')) {
    // Alias from the current statement wins.
    const refs = parseRefs(stmt.full, cat);
    const byAlias = refs.find((r) => r.alias?.toLowerCase() === bare.toLowerCase());
    if (byAlias?.table) return columnItems(cat, byAlias.table);
  }
  const table = cat.resolve(chain);
  if (table) return columnItems(cat, table);
  const last = bare.split('.').pop()!;
  if (cat.isSchema(last)) return tableItems(cat, last);
  return [];
}

// ------------------------------------------------------------- item builders

function tableItem(cat: Catalog, t: CatalogTable): vscode.CompletionItem {
  const nonDefault = t.schema.toLowerCase() !== cat.defaultSchema;
  const item = new vscode.CompletionItem(
    {
      label: t.name,
      description: [nonDefault ? t.schema : '', t.isView ? 'view' : ''].filter(Boolean).join(' · ') || undefined,
    },
    t.isView ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Class
  );
  item.insertText = qualify(t, cat);
  item.detail = t.isView ? 'view' : 'table';
  item.sortText = '05' + t.name.toLowerCase();
  return item;
}

function routineItem(cat: Catalog, r: CatalogRoutine, forExec: boolean): vscode.CompletionItem {
  const nonDefault = r.schema.toLowerCase() !== cat.defaultSchema;
  const item = new vscode.CompletionItem(
    { label: r.name, description: [nonDefault ? r.schema : '', r.kind].filter(Boolean).join(' · ') },
    vscode.CompletionItemKind.Method
  );
  const q = qualify2(r.schema, r.name, cat);
  const inputs = r.params.filter((p) => !p.output);
  item.detail = r.signature
    ? `${r.kind}(${r.signature})`
    : `${r.kind}(${r.params.map((p) => `${p.name} ${p.dataType}${p.output ? ' OUTPUT' : ''}`).join(', ')})`;
  if (forExec) {
    // Ready-to-fill template: EXEC dbo.proc @a = ¦, @b = ¦  /  CALL fn(¦, ¦)
    if (cat.kind === 'mssql') {
      const args = r.params
        .map((p, i) => {
          const name = p.name.startsWith('@') ? p.name : '@' + p.name;
          return `${name} = $${i + 1}${p.output ? ' OUTPUT' : ''}`;
        })
        .join(', ');
      item.insertText = new vscode.SnippetString(args ? `${q} ${args}` : q);
    } else {
      const args = inputs.map((_, i) => `$${i + 1}`).join(', ');
      item.insertText = new vscode.SnippetString(`${q}(${args})`);
    }
    item.sortText = '01' + r.name.toLowerCase();
  } else {
    item.insertText =
      r.kind === 'function' ? new vscode.SnippetString(`${q}($0)`) : q;
    item.sortText = '08' + r.name.toLowerCase();
  }
  return item;
}

function qualify(t: CatalogTable, cat: Catalog): string {
  return qualify2(t.schema, t.name, cat);
}

function qualify2(schema: string, name: string, cat: Catalog): string {
  const n = quoteName(name, cat.kind);
  return schema.toLowerCase() === cat.defaultSchema ? n : `${quoteName(schema, cat.kind)}.${n}`;
}

// -------------------------------------------------------------------- aliases

const TABLE_REF =
  /\b(?:from|join)\s+((?:\[[^\]]+\]|"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:\[[^\]]+\]|"[^"]+"|[A-Za-z_][\w$]*))*)\s+(?:as\s+)?([A-Za-z_]\w*)?$/i;

function aliasSuggestions(
  document: vscode.TextDocument,
  position: vscode.Position
): vscode.CompletionItem[] {
  if (!vscode.workspace.getConfiguration('dbtool').get('autoAlias', true)) return [];
  const line = document.lineAt(position.line).text.slice(0, position.character);
  const m = TABLE_REF.exec(line);
  if (!m) return [];
  const table = m[1];
  return aliasFor(table).map((alias, i) => {
    const item = new vscode.CompletionItem(
      { label: alias, description: `alias for ${table}` },
      vscode.CompletionItemKind.Variable
    );
    item.detail = 'table alias';
    item.sortText = '01' + i;
    item.preselect = i === 0;
    return item;
  });
}

/** orders → o · order_details → od · OrderDetails → od · customers → c, cus */
function aliasFor(table: string): string[] {
  const base = table.split('.').pop()!.replace(/[\[\]"'`]/g, '');
  if (!base) return [];
  const parts = base.split(/[_\s-]+/).filter(Boolean);
  let initials: string;
  if (parts.length > 1) {
    initials = parts.map((p) => p[0]).join('');
  } else {
    const caps = base.match(/[A-Z]/g);
    initials = caps && caps.length > 1 ? caps.join('') : base[0];
  }
  initials = initials.toLowerCase();
  const out = [initials];
  if (base.length >= 3) {
    const three = base.slice(0, 3).toLowerCase();
    if (three !== initials) out.push(three);
  }
  return out;
}

/** First alias candidate not already taken in the statement. */
function pickAlias(table: string, used: Set<string>): string {
  const options = aliasFor(table);
  for (const o of options) if (!used.has(o)) return o;
  let i = 2;
  while (used.has(options[0] + i)) i++;
  return options[0] + i;
}

// ------------------------------------------------------- statement snippets

/** [filter word, label, snippet body] */
const SNIPPETS: readonly [string, string, string][] = [
  ['select', 'SELECT * FROM', 'SELECT * FROM $0'],
  ['select', 'SELECT COUNT(*) FROM', 'SELECT COUNT(*) FROM $0'],
  ['insert', 'INSERT INTO … VALUES', 'INSERT INTO ${1:table} (${2:columns})\nVALUES ($0)'],
  ['update', 'UPDATE … SET … WHERE', 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE $0'],
  ['delete', 'DELETE FROM … WHERE', 'DELETE FROM ${1:table}\nWHERE $0'],
];

function buildSnippets(kind: DbKind | undefined): vscode.CompletionItem[] {
  const rows: [string, string, string][] = [...SNIPPETS];
  rows.push(
    kind === 'mssql'
      ? ['select', 'SELECT TOP 100 * FROM', 'SELECT TOP 100 * FROM $0']
      : ['select', 'SELECT * FROM … LIMIT', 'SELECT * FROM ${1:table} LIMIT ${2:100}$0']
  );
  return rows.map(([word, label, body], i) => {
    const item = new vscode.CompletionItem(
      { label, description: 'statement' },
      vscode.CompletionItemKind.Snippet
    );
    item.filterText = word;
    item.insertText = new vscode.SnippetString(body);
    item.sortText = '000' + i;
    item.preselect = i === 0;
    return item;
  });
}

// --------------------------------------------------------------- static items

function buildStatic(kind: DbKind | undefined): vscode.CompletionItem[] {
  const items: vscode.CompletionItem[] = [];

  const keywords = new Set(COMMON_KEYWORDS);
  if (kind !== 'mssql') PG_KEYWORDS.forEach((k) => keywords.add(k));
  if (kind !== 'postgres') MSSQL_KEYWORDS.forEach((k) => keywords.add(k));
  for (const kw of keywords) {
    const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
    item.sortText = '2' + kw;
    items.push(item);
  }

  if (kind !== 'mssql') addFunctions(items, PG_FUNCTIONS, 'PostgreSQL');
  if (kind !== 'postgres') addFunctions(items, MSSQL_FUNCTIONS, 'SQL Server');
  return items;
}

function addFunctions(items: vscode.CompletionItem[], fns: FnDoc[], dialect: string): void {
  for (const [name, signature, doc] of fns) {
    const item = new vscode.CompletionItem(
      { label: name, description: dialect },
      vscode.CompletionItemKind.Function
    );
    item.detail = signature;
    item.documentation = new vscode.MarkdownString(doc);
    item.sortText = '1' + name.toLowerCase();
    if (signature.startsWith(name + '()')) {
      // Zero-argument function: place cursor after the closing paren.
      item.insertText = new vscode.SnippetString(name + '()$0');
    } else if (signature.includes('(')) {
      item.insertText = new vscode.SnippetString(name + '($0)');
    }
    // Signatures without parens (current_date, current_user, ...) insert as plain text.
    items.push(item);
  }
}
