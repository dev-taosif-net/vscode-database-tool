import * as vscode from 'vscode';
import { ConnectionMeta, QueryOutcome, ResultSet } from './types';
import { paletteCss, safeColor } from './theme';
import { connectionIcon } from './colorIcons';

/**
 * Results are rendered into a single reused webview panel with scripts
 * disabled — plain HTML + CSS only, so rendering is fast and the panel
 * costs nothing when hidden (no retained context).
 */
export class ResultsPanel {
  private static panel: vscode.WebviewPanel | undefined;
  private static ctx: vscode.ExtensionContext;

  static init(ctx: vscode.ExtensionContext): void {
    this.ctx = ctx;
  }

  private static ensure(meta: ConnectionMeta): vscode.WebviewPanel {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'dbtool.results',
        'Query Results',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: false, retainContextWhenHidden: false }
      );
      this.panel.onDidDispose(() => (this.panel = undefined));
    } else {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside, true);
    }
    // Tab icon carries the connection's environment color (tabs themselves
    // can't be recolored by extensions).
    connectionIcon(this.ctx, meta.color, 'dot').then((icon) => {
      if (this.panel && !(icon instanceof vscode.ThemeIcon)) this.panel.iconPath = icon;
    });
    return this.panel;
  }

  static showResults(meta: ConnectionMeta, outcome: QueryOutcome, maxRows: number): void {
    const p = this.ensure(meta);
    p.title = `Results — ${meta.name}`;
    p.webview.html = page(renderOutcome(meta, outcome, maxRows), meta);
  }

  static showError(meta: ConnectionMeta, error: unknown): void {
    const p = this.ensure(meta);
    p.title = `Error — ${meta.name}`;
    const e = error as { message?: string; lineNumber?: number; position?: string; code?: string };
    const detail = [
      e?.code ? `Code: ${e.code}` : '',
      e?.lineNumber ? `Line: ${e.lineNumber}` : '',
      e?.position ? `Position: ${e.position}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    p.webview.html = page(
      `${banner(meta)}<div class="error"><div class="error-title">Query failed</div><pre>${esc(
        String(e?.message ?? error)
      )}</pre>${detail ? `<div class="dim">${esc(detail)}</div>` : ''}</div>`,
      meta
    );
  }
}

function banner(meta: ConnectionMeta): string {
  const color = safeColor(meta.color);
  const dot = color ? `<span class="envdot" style="background:${color}"></span>` : '';
  return `<div class="conn">${dot}<b>${esc(meta.name)}</b></div>`;
}

function renderOutcome(meta: ConnectionMeta, outcome: QueryOutcome, maxRows: number): string {
  const totalRows = outcome.sets.reduce((a, s) => a + s.rowCount, 0);
  const parts: string[] = [
    `<div class="summary">${banner(meta)}<span class="dim">${outcome.sets.length} result set${
      outcome.sets.length === 1 ? '' : 's'
    } · ${totalRows} row${totalRows === 1 ? '' : 's'} · ${outcome.durationMs.toFixed(1)} ms</span></div>`,
  ];
  for (const set of outcome.sets) parts.push(renderSet(set, maxRows));
  return parts.join('\n');
}

function renderSet(set: ResultSet, maxRows: number): string {
  if (set.columns.length === 0) {
    return `<div class="tag">${set.rowCount} row${set.rowCount === 1 ? '' : 's'} ${esc(
      set.note ?? 'affected'
    )}</div>`;
  }
  const shown = set.rows.slice(0, maxRows);
  const head = set.columns.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = shown
    .map(
      (row, i) =>
        `<tr><td class="n">${i + 1}</td>${row.map((v) => cell(v)).join('')}</tr>`
    )
    .join('');
  const truncated =
    set.rows.length > maxRows
      ? `<div class="dim">Showing first ${maxRows} of ${set.rows.length} rows (dbtool.maxRenderRows).</div>`
      : '';
  const note = set.note && set.rowCount === 0 && set.rows.length === 0
    ? `<div class="tag">${esc(set.note)} — 0 rows</div>`
    : '';
  return `${note}<div class="scroll"><table><thead><tr><th class="n">#</th>${head}</tr></thead><tbody>${body}</tbody></table></div>${truncated}`;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '<td class="null">NULL</td>';
  let text: string;
  if (v instanceof Date) {
    text = isNaN(v.getTime()) ? 'invalid date' : v.toISOString().replace('T', ' ').replace('.000Z', '').replace('Z', '');
  } else if (Buffer.isBuffer(v)) {
    const hex = v.toString('hex');
    text = '0x' + (hex.length > 64 ? hex.slice(0, 64) + '…' : hex);
  } else if (typeof v === 'object') {
    try {
      text = JSON.stringify(v);
    } catch {
      text = String(v);
    }
  } else {
    text = String(v);
  }
  if (text.length > 2000) text = text.slice(0, 2000) + '…';
  const cls = typeof v === 'number' || typeof v === 'bigint' ? ' class="num"' : '';
  return `<td${cls} title="${esc(text)}">${esc(text)}</td>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(body: string, meta: ConnectionMeta): string {
  const color = safeColor(meta.color);
  const accentBar = color ? `body{border-top:3px solid ${color};}` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  ${paletteCss()}
  ${accentBar}
  body { font-family: var(--vscode-font-family); font-size: 12px; padding: 6px 10px 20px; }
  .conn { display: inline-flex; align-items: center; gap: 6px; margin-right: 10px; }
  .envdot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .summary { margin: 4px 0 10px; }
  .tag { margin: 8px 0; padding: 4px 8px; display: inline-block; background: var(--badge-bg); color: var(--badge-fg); border-radius: 3px; }
  .scroll { overflow: auto; max-height: 82vh; margin-bottom: 14px; border: 1px solid var(--border); }
  table { border-collapse: collapse; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; width: max-content; min-width: 100%; }
  th, td { border-bottom: 1px solid var(--border); border-right: 1px solid var(--border); padding: 3px 8px; text-align: left; max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  th { position: sticky; top: 0; background: var(--head-bg); font-weight: 600; z-index: 1; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.n, th.n { opacity: .45; text-align: right; user-select: none; }
  tr:hover td { background: var(--hover); }
  .null { opacity: .5; font-style: italic; }
  .dim { opacity: .6; }
  .error { border-left: 3px solid var(--error); padding: 6px 10px; margin-top: 10px; }
  .error-title { color: var(--error); font-weight: 600; margin-bottom: 6px; }
  pre { white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); margin: 0 0 6px; }
  </style></head><body>${body}</body></html>`;
}
