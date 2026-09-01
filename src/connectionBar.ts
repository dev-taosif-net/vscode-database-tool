import * as vscode from 'vscode';
import { contrastFg, safeColor } from './theme';

/**
 * Per-tab connection UI for SQL editors:
 *  - a CodeLens pinned above line 1 showing the tab's connection
 *    (name · user · database), clickable to switch,
 *  - a whole-line tint + left border on the first line in the connection's
 *    environment color,
 *  - a footer bar on the last line of the script — same label on a chip filled
 *    with the environment color, over a tinted line with a top rule,
 * so tabs on different databases are told apart at a glance, top and bottom.
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

/** `name · user · database` — the label shared by the top bar and the footer. */
function connLabel(info: TabConnInfo): string {
  return [info.name, info.user, info.database].filter(Boolean).join('  ·  ');
}

export function registerConnectionBar(
  ctx: vscode.ExtensionContext,
  getInfo: (doc: vscode.TextDocument) => TabConnInfo | undefined
): ConnectionBarApi {
  const changed = new vscode.EventEmitter<void>();
  /** One decoration type per environment color, reused across editors. */
  const decoTypes = new Map<string, vscode.TextEditorDecorationType>();
  /** Same, for the footer line (tint + top rule instead of a left border). */
  const footerTints = new Map<string, vscode.TextEditorDecorationType>();
  /** The footer chip itself: one type, its text/colors set per decoration. */
  const footerChip = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  ctx.subscriptions.push(footerChip);

  const provider: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: changed.event,
    provideCodeLenses(doc) {
      const info = getInfo(doc);
      const title = info
        ? `$(database) ${connLabel(info)}` + (info.bound ? '' : '  —  not bound yet')
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

  function footerTint(color: string): vscode.TextEditorDecorationType {
    let t = footerTints.get(color);
    if (!t) {
      const bg = /^#[0-9a-fA-F]{6}$/.test(color) ? color + '1a' : color;
      t = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: bg,
        borderColor: color,
        borderStyle: 'solid',
        borderWidth: '1px 0 0 0',
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
      });
      footerTints.set(color, t);
      ctx.subscriptions.push(t);
    }
    return t;
  }

  /** The chip drawn at the end of the last line, filled with the env color. */
  function footerOption(
    doc: vscode.TextDocument,
    line: number,
    info: TabConnInfo | undefined,
    color: string | undefined
  ): vscode.DecorationOptions {
    const end = doc.lineAt(line).range.end;
    const text = info
      ? `  ${connLabel(info)}${info.bound ? '' : '  —  not bound yet'}  `
      : '  Not connected — click to pick a connection  ';
    // Names are user-supplied: keep them inside a code span so a trusted
    // markdown hover can never grow a command link out of one.
    const md = new vscode.MarkdownString(
      info
        ? `Running on \`${info.name.replace(/`/g, "'")}\`` +
          (info.database ? ` · \`${info.database.replace(/`/g, "'")}\`` : '') +
          ' — [use another connection for this tab](command:dbtool.tabConnection)'
        : '[Pick a connection for this tab](command:dbtool.tabConnection)'
    );
    md.isTrusted = true;
    return {
      range: new vscode.Range(end, end),
      hoverMessage: md,
      renderOptions: {
        after: {
          contentText: text,
          backgroundColor: color ?? new vscode.ThemeColor('badge.background'),
          color: color ? contrastFg(color) : new vscode.ThemeColor('badge.foreground'),
          margin: '0 0 0 1.5em',
          fontWeight: '600',
        },
      },
    };
  }

  function apply(): void {
    const showFooter = vscode.workspace.getConfiguration('dbtool').get('connectionFooter', true);
    for (const editor of vscode.window.visibleTextEditors) {
      const doc = editor.document;
      if (doc.languageId !== 'sql') continue;
      const info = getInfo(doc);
      const color = safeColor(info?.color);
      if (color) decoType(color); // ensure the type exists before the sweep below
      const range = [doc.lineAt(0).range];
      for (const [c, t] of decoTypes) editor.setDecorations(t, c === color ? range : []);

      // Footer: only once the script has a line of its own to sit on, so a
      // fresh one-line query is not decorated twice.
      const last = doc.lineCount - 1;
      const footer = showFooter && last > 0;
      const footColor = footer ? color : undefined;
      if (footColor) footerTint(footColor);
      const footRange = footColor ? [doc.lineAt(last).range] : [];
      for (const [c, t] of footerTints) editor.setDecorations(t, c === footColor ? footRange : []);
      editor.setDecorations(footerChip, footer ? [footerOption(doc, last, info, color)] : []);
    }
  }

  ctx.subscriptions.push(
    changed,
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, provider),
    vscode.window.onDidChangeVisibleTextEditors(() => apply()),
    vscode.workspace.onDidOpenTextDocument(() => apply()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dbtool.connectionFooter')) apply();
    }),
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
