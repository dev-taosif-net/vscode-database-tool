import * as vscode from 'vscode';
import { DbKind } from './types';
import { COMMON_KEYWORDS, FnDoc, MSSQL_FUNCTIONS, MSSQL_KEYWORDS, PG_FUNCTIONS, PG_KEYWORDS } from './sqlData';

/**
 * Built-in function + keyword completions for SQL files.
 * Static items are built once per dialect and cached — providing them is a
 * plain array return. Alias suggestions are a single regex on the current line.
 */
export function registerCompletions(
  ctx: vscode.ExtensionContext,
  activeKind: () => DbKind | undefined
): void {
  const cache = new Map<string, vscode.CompletionItem[]>();

  const provider: vscode.CompletionItemProvider = {
    provideCompletionItems(document, position, _token, context) {
      const aliasItems = aliasSuggestions(document, position);
      // Space is a registered trigger char purely for alias suggestions after
      // "FROM table " — on a plain space with no alias context, stay quiet.
      if (
        context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter &&
        context.triggerCharacter === ' '
      ) {
        return aliasItems;
      }
      const kind = activeKind();
      const key = kind ?? 'both';
      let items = cache.get(key);
      if (!items) {
        items = build(kind);
        cache.set(key, items);
      }
      return aliasItems.length ? [...aliasItems, ...items] : items;
    },
  };

  ctx.subscriptions.push(
    vscode.languages.registerCompletionItemProvider([{ language: 'sql' }], provider, ' ')
  );
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
    item.sortText = '0' + i;
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

// --------------------------------------------------------------- static items

function build(kind: DbKind | undefined): vscode.CompletionItem[] {
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
