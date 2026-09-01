import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ConnectionMeta, QueryOutcome, ResultSet } from './types';
import { paletteCss, safeColor } from './theme';
import { connectionIcon } from './colorIcons';

/**
 * Results are rendered into a single reused webview panel. The page is plain
 * HTML + CSS plus one small inline script (nonce-locked CSP) that powers grid
 * cell selection with a live aggregates footer (count / distinct / sum / avg /
 * min / max) and copy-as-TSV. No retained context when hidden.
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
        { enableScripts: true, retainContextWhenHidden: false }
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
    p.webview.html = renderResultsHtml(meta, outcome, maxRows);
  }

  /** Execution plan view: plan tree(s) + any data result sets underneath. */
  static showPlan(
    meta: ConnectionMeta,
    planHtml: string,
    outcome: QueryOutcome | undefined,
    maxRows: number
  ): void {
    const p = this.ensure(meta);
    p.title = `Plan — ${meta.name}`;
    const parts = [banner(meta), planHtml];
    if (outcome && outcome.sets.length) {
      parts.push('<div class="plan-head" style="margin-top:14px"><b>Results</b></div>');
      for (const set of outcome.sets) parts.push(renderSet(set, maxRows));
    }
    p.webview.html = page(parts.join('\n'), meta);
  }

  static showError(meta: ConnectionMeta, error: unknown): void {
    const p = this.ensure(meta);
    p.title = `Error — ${meta.name}`;
    p.webview.html = renderErrorHtml(meta, error);
  }
}

/** Full results page (summary + grids) — shared by the editor tab and the bottom panel view. */
export function renderResultsHtml(meta: ConnectionMeta, outcome: QueryOutcome, maxRows: number): string {
  return page(renderOutcome(meta, outcome, maxRows), meta);
}

export function renderErrorHtml(meta: ConnectionMeta, error: unknown): string {
  const e = error as { message?: string; lineNumber?: number; position?: string; code?: string };
  const detail = [
    e?.code ? `Code: ${e.code}` : '',
    e?.lineNumber ? `Line: ${e.lineNumber}` : '',
    e?.position ? `Position: ${e.position}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return page(
    `${banner(meta)}<div class="error"><div class="error-title">Query failed</div><pre>${esc(
      String(e?.message ?? error)
    )}</pre>${detail ? `<div class="dim">${esc(detail)}</div>` : ''}</div>`,
    meta
  );
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

/** Plain-text form of a cell value (dates, buffers, JSON …), truncated for display. */
export function displayText(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
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
  return text.length > 2000 ? text.slice(0, 2000) + '…' : text;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '<td class="null">NULL</td>';
  const text = displayText(v);
  const cls = typeof v === 'number' || typeof v === 'bigint' ? ' class="num"' : '';
  return `<td${cls} title="${esc(text)}">${esc(text)}</td>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(body: string, meta: ConnectionMeta): string {
  const color = safeColor(meta.color);
  const accentBar = color ? `body{border-top:3px solid ${color};}` : '';
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
  ${paletteCss()}
  ${accentBar}
  body { font-family: var(--vscode-font-family); font-size: 12px; padding: 6px 10px 34px; }
  .conn { display: inline-flex; align-items: center; gap: 6px; margin-right: 10px; }
  .envdot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .summary { margin: 4px 0 10px; }
  .tag { margin: 8px 0; padding: 4px 8px; display: inline-block; background: var(--badge-bg); color: var(--badge-fg); border-radius: 3px; }
  .scroll { overflow: auto; max-height: 82vh; margin-bottom: 14px; border: 1px solid var(--border); user-select: none; }
  table { border-collapse: collapse; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; width: max-content; min-width: 100%; }
  th, td { border-bottom: 1px solid var(--border); border-right: 1px solid var(--border); padding: 3px 8px; text-align: left; max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  th { position: sticky; top: 0; background: var(--head-bg); font-weight: 600; z-index: 1; cursor: pointer; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.n, th.n { opacity: .45; text-align: right; user-select: none; cursor: pointer; }
  tr:hover td { background: var(--hover); }
  td.sel { background: var(--accent) !important; color: var(--accent-fg) !important; }
  td.null { background: var(--null-bg); color: var(--null-fg); font-style: italic; }
  .dim { opacity: .6; }
  .error { border-left: 3px solid var(--error); padding: 6px 10px; margin-top: 10px; }
  .error-title { color: var(--error); font-weight: 600; margin-bottom: 6px; }
  pre { white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); margin: 0 0 6px; }
  #agg { position: fixed; bottom: 0; left: 0; right: 0; z-index: 2; padding: 5px 10px;
         background: var(--head-bg); border-top: 1px solid var(--border);
         font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #agg b { font-weight: 600; }
  .plan { margin: 8px 0 4px; font-family: var(--vscode-editor-font-family, monospace); }
  .plan-head { margin: 6px 0; font-family: var(--vscode-font-family); }
  .pn { margin-left: 0; }
  .pn-kids { margin-left: 18px; border-left: 1px solid var(--border); padding-left: 8px; }
  .pn summary { list-style: none; cursor: pointer; }
  .pn summary::before { content: '▾ '; opacity: .55; }
  .pn:not([open]) > summary::before { content: '▸ '; }
  .pn-leaf { padding-left: 13px; }
  .pn-row { display: flex; justify-content: space-between; gap: 16px; padding: 2px 6px; border-radius: 3px;
            background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 22%, transparent) var(--pct), transparent var(--pct)); }
  .pn-row.warm { background: linear-gradient(90deg, rgba(214,143,0,.30) var(--pct), transparent var(--pct)); }
  .pn-row.hot { background: linear-gradient(90deg, rgba(220,54,54,.35) var(--pct), transparent var(--pct)); }
  .pn-metrics { opacity: .8; white-space: nowrap; }
  .pn-detail { padding: 0 6px 2px 20px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mis { color: var(--error); font-size: 11px; }
  </style></head><body>${body}
  <div id="agg" hidden></div>
  <script nonce="${nonce}">${GRID_JS}</script>
  </body></html>`;
}

/**
 * Grid interaction: click/drag to select cells, click a header for the whole
 * column, click a row number for the row, Ctrl/Cmd-click toggles, Shift-click
 * extends, Escape clears, Ctrl/Cmd+C copies the selection as TSV. A footer
 * shows aggregates over the selection (numeric stats parse the cell text, so
 * DECIMAL values arriving as strings still count).
 */
const GRID_JS = String.raw`
(function () {
  var agg = document.getElementById('agg');
  var sel = new Set();
  var anchor = null;
  var dragging = false;
  var NUM = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
  var fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format;

  function clearSel() { sel.forEach(function (td) { td.classList.remove('sel'); }); sel.clear(); }
  function add(td) { if (!sel.has(td)) { sel.add(td); td.classList.add('sel'); } }
  function toggle(td) { if (sel.has(td)) { sel.delete(td); td.classList.remove('sel'); } else { add(td); } }
  function isData(td) { return td && td.tagName === 'TD' && !td.classList.contains('n'); }
  function pos(td) { return { table: td.closest('table'), r: td.parentElement.sectionRowIndex, c: td.cellIndex }; }

  function selectRect(a, b) {
    clearSel();
    var rows = a.table.tBodies[0].rows;
    var r1 = Math.min(a.r, b.r), r2 = Math.max(a.r, b.r);
    var c1 = Math.max(1, Math.min(a.c, b.c)), c2 = Math.max(a.c, b.c);
    for (var r = r1; r <= r2; r++) {
      var cells = rows[r].cells;
      for (var c = c1; c <= Math.min(c2, cells.length - 1); c++) add(cells[c]);
    }
  }

  function update() {
    if (sel.size < 2) { agg.hidden = true; return; }
    var count = sel.size, nulls = 0, numCount = 0;
    var sum = 0, min = Infinity, max = -Infinity;
    var distinct = new Set();
    sel.forEach(function (td) {
      if (td.classList.contains('null')) { nulls++; distinct.add(' '); return; }
      var t = td.textContent;
      distinct.add(t);
      if (NUM.test(t.trim())) {
        var v = parseFloat(t);
        numCount++; sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    });
    var parts = ['<b>Count</b> ' + fmt(count), '<b>Distinct</b> ' + fmt(distinct.size)];
    if (numCount) {
      parts.push('<b>Sum</b> ' + fmt(sum), '<b>Avg</b> ' + fmt(sum / numCount),
                 '<b>Min</b> ' + fmt(min), '<b>Max</b> ' + fmt(max));
      if (numCount < count) parts.push('<span class="dim">' + fmt(numCount) + ' numeric</span>');
    }
    if (nulls) parts.push('<span class="dim">' + fmt(nulls) + ' NULL</span>');
    agg.innerHTML = parts.join(' &nbsp;·&nbsp; ');
    agg.hidden = false;
  }

  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    var cell = e.target.closest('td, th');
    if (!cell) { if (!e.target.closest('#agg')) { clearSel(); update(); } return; }
    var table = cell.closest('table');
    if (!table) return;
    e.preventDefault();
    if (cell.tagName === 'TH') {
      if (cell.cellIndex === 0) return;
      clearSel();
      var rows = table.tBodies[0].rows;
      for (var i = 0; i < rows.length; i++) add(rows[i].cells[cell.cellIndex]);
      update(); return;
    }
    if (cell.classList.contains('n')) {
      clearSel();
      var tr = cell.parentElement;
      for (var j = 1; j < tr.cells.length; j++) add(tr.cells[j]);
      update(); return;
    }
    if (e.ctrlKey || e.metaKey) { toggle(cell); anchor = pos(cell); update(); return; }
    if (e.shiftKey && anchor && anchor.table === table) { selectRect(anchor, pos(cell)); update(); return; }
    dragging = true;
    anchor = pos(cell);
    clearSel(); add(cell); update();
  });

  document.addEventListener('mouseover', function (e) {
    if (!dragging) return;
    var td = e.target.closest('td');
    if (!isData(td)) return;
    var p = pos(td);
    if (p.table !== anchor.table) return;
    selectRect(anchor, p); update();
  });

  document.addEventListener('mouseup', function () { dragging = false; });

  function selectionTsv() {
    var byRow = new Map();
    document.querySelectorAll('td.sel').forEach(function (td) {
      var row = byRow.get(td.parentElement);
      if (!row) { row = []; byRow.set(td.parentElement, row); }
      row.push(td.classList.contains('null') ? '' : td.textContent);
    });
    var out = [];
    byRow.forEach(function (cells) { out.push(cells.join('\t')); });
    return out.join('\n');
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { clearSel(); update(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && sel.size) {
      navigator.clipboard.writeText(selectionTsv());
      e.preventDefault();
    }
  });

  // Also cover the native copy path (e.g. Edit → Copy).
  document.addEventListener('copy', function (e) {
    if (!sel.size) return;
    e.clipboardData.setData('text/plain', selectionTsv());
    e.preventDefault();
  });
})();`;
