import * as vscode from 'vscode';
import { UPPERCASE_TOKENS } from './sqlData';

const TOKENS = new Set(UPPERCASE_TOKENS);

/**
 * Auto-UPPERCASE SQL keywords as you type: `select ` becomes `SELECT `.
 * Fires only on single delimiter keystrokes (space, newline, comma, parens,
 * semicolon) in SQL documents — never on paste, undo/redo, or bulk edits —
 * so the per-keystroke cost is one regex on the current line.
 */
export function registerKeywordUppercase(ctx: vscode.ExtensionContext): void {
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId !== 'sql' || e.contentChanges.length === 0) return;
      if (
        e.reason === vscode.TextDocumentChangeReason.Undo ||
        e.reason === vscode.TextDocumentChangeReason.Redo
      ) {
        return;
      }
      if (!vscode.workspace.getConfiguration('dbtool').get('autoUppercaseKeywords', true)) return;
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document !== e.document) return;

      const edits: { range: vscode.Range; text: string }[] = [];
      for (const change of e.contentChanges) {
        // A single delimiter char, or Enter (possibly with auto-indent whitespace).
        if (!/^[ ,();]$/.test(change.text) && !/^\r?\n[ \t]*$/.test(change.text)) continue;
        const pos = change.range.start;
        const upto = e.document.lineAt(pos.line).text.slice(0, pos.character);
        if (inStringOrComment(upto)) continue;
        const m = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(upto);
        if (!m) continue;
        const word = m[1];
        const upper = word.toUpperCase();
        if (word === upper || !TOKENS.has(upper)) continue;
        // Don't touch qualified/quoted/variable identifiers like t.select, [select], @select.
        const before = upto.slice(0, upto.length - word.length);
        if (/[.\["'`@:$]$/.test(before)) continue;
        edits.push({
          range: new vscode.Range(pos.line, pos.character - word.length, pos.line, pos.character),
          text: upper,
        });
      }
      if (edits.length) {
        editor.edit((b) => edits.forEach((ed) => b.replace(ed.range, ed.text)), {
          undoStopBefore: false,
          undoStopAfter: false,
        });
      }
    })
  );
}

/** Line-local heuristic: skip when the cursor sits inside 'string', "quoted id", or after --. */
function inStringOrComment(upto: string): boolean {
  const stripped = upto.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
  return (
    stripped.includes("'") ||
    stripped.includes('"') ||
    stripped.includes('--') ||
    (stripped.includes('/*') && !stripped.includes('*/'))
  );
}
