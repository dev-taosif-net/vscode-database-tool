import * as vscode from 'vscode';
import { safeColor } from './theme';

/**
 * Per-tab connection bar for SQL editors: a CodeLens pinned above line 1
 * showing the tab's connection (name · user · database), clickable to switch,
 * plus a whole-line tint + left border on the first line in the connection's
 * environment color, so tabs on different databases are told apart at a glance.
 */

export interface TabConnInfo {
  name: string;
  user?: string;
  database?: string;
  /** Environment color (hex) of the connection. */
  color?: string;
  /** false = tab has no explicit binding yet and is showing the shared active connection. */
  bound: boolean;
}

export interface ConnectionBarApi {
  /** Re-render bars in all SQL editors (call after connect/bind/db-switch). */
  refresh(): void;
}

export function registerConnectionBar(
  ctx: vscode.ExtensionContext,
  getInfo: (doc: vscode.TextDocument) => TabConnInfo | undefined
): ConnectionBarApi {
  const changed = new vscode.EventEmitter<void>();
  /** One decoration type per environment color, reused across editors. */
  const decoTypes = new Map<string, vscode.TextEditorDecorationType>();

  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changed.event,
    provideCodeLenses(doc) {
      const info = getInfo(doc);
      const title = info
        ? `$(database) ${[info.name, info.user, info.database].filter(Boolean).join('  ·  ')}` +
          (info.bound ? '' : '  —  not bound yet')
        : '$(plug) Not connected — pick a connection for this tab';
      const tooltip = info
        ? `This tab runs on "${info.name}"${info.database ? ` (${info.database})` : ''}.` +
          (info.bound ? '' : ' It will bind to the current connection on first run.') +
          ' Click to use a different connection for this tab.'
        : 'Click to connect this tab to a database.';
      return [
        new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
          title,
          tooltip,
          command: 'dbtool.tabConnection',
          arguments: [doc.uri],
        }),
      ];
    },
  };

  function decoType(color: string): vscode.TextEditorDecorationType {
    let t = decoTypes.get(color);
    if (!t) {
      // 8-digit hex = ~10% alpha tint; colors with their own alpha pass through.
      const bg = /^#[0-9a-fA-F]{6}$/.test(color) ? color + '1a' : color;
      t = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: bg,
        borderColor: color,
        borderStyle: 'solid',
        borderWidth: '0 0 0 3px',
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
      });
      decoTypes.set(color, t);
      ctx.subscriptions.push(t);
    }
    return t;
  }

  function apply(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.languageId !== 'sql') continue;
      const color = safeColor(getInfo(editor.document)?.color);
      if (color) decoType(color); // ensure the type exists before the sweep below
      const range = [editor.document.lineAt(0).range];
      for (const [c, t] of decoTypes) editor.setDecorations(t, c === color ? range : []);
    }
  }

  ctx.subscriptions.push(
    changed,
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, provider),
    vscode.window.onDidChangeVisibleTextEditors(() => apply()),
    vscode.workspace.onDidOpenTextDocument(() => apply()),
    // Edits can push the decorated range off line 1 — re-pin it.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId === 'sql') apply();
    })
  );
  apply();

  return {
    refresh(): void {
      changed.fire();
      apply();
    },
  };
}
