import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Catalog } from './catalog';
import { ConnectionMeta } from './types';
import { paletteCss } from './theme';

/**
 * Visual Query Builder: drag tables from the sidebar onto a canvas, joins are
 * auto-wired from foreign keys (editable), tick columns / aggregates, add
 * filters and sorting — the SQL preview updates live and can be run directly
 * or inserted into the editor. All state lives in the webview
 * (retainContextWhenHidden), the extension only supplies the catalog and
 * executes the produced SQL.
 */
export class QueryBuilderPanel {
  private static panel: vscode.WebviewPanel | undefined;

  static open(
    ctx: vscode.ExtensionContext,
    getCatalog: () => Catalog | undefined,
    getMeta: () => ConnectionMeta | undefined,
    runSql: (sql: string) => void
  ): void {
    if (this.panel) {
      this.panel.reveal();
      this.postCatalog(getCatalog(), getMeta());
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'dbtool.queryBuilder',
      'Query Builder',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel = panel;
    panel.onDidDispose(() => (this.panel = undefined), null, ctx.subscriptions);
    panel.webview.onDidReceiveMessage(
      async (msg: { type: string; sql?: string }) => {
        if (msg.type === 'run' && msg.sql) runSql(msg.sql);
        if (msg.type === 'insert' && msg.sql) await insertIntoEditor(msg.sql);
      },
      null,
      ctx.subscriptions
    );
    panel.webview.html = html();
    this.postCatalog(getCatalog(), getMeta());
  }

  /** Push a (re)loaded catalog into an open builder. */
  static postCatalog(cat: Catalog | undefined, meta: ConnectionMeta | undefined): void {
    if (!this.panel) return;
    void this.panel.webview.postMessage({
      type: 'catalog',
      connection: meta?.name ?? null,
      kind: cat?.kind ?? null,
      defaultSchema: cat?.defaultSchema ?? 'public',
      tables: cat?.tables.map((t) => ({
        schema: t.schema,
        name: t.name,
        isView: t.isView,
        columns: t.columns.map((c) => ({ name: c.name, type: c.dataType })),
      })) ?? [],
      fks: cat?.fks ?? [],
    });
  }
}

async function insertIntoEditor(sql: string): Promise<void> {
  let editor = vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'sql');
  if (!editor) {
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: '' });
    editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  } else {
    await vscode.window.showTextDocument(editor.document, editor.viewColumn);
  }
  const at = editor.selection.active;
  await editor.edit((b) => b.insert(at, sql + '\n'));
}

function html(): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
${paletteCss()}
* { box-sizing: border-box; }
body { font-family: var(--vscode-font-family); font-size: 12px; margin: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
#top { display: flex; flex: 1; min-height: 0; }
#side { width: 230px; border-right: 1px solid var(--border); display: flex; flex-direction: column; }
#side input { margin: 8px; padding: 4px 6px; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 3px; }
#tlist { overflow: auto; flex: 1; }
.titem { padding: 3px 10px; cursor: grab; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.titem:hover { background: var(--hover); }
.titem .sch { opacity: .5; }
#canvasWrap { flex: 1; position: relative; overflow: auto; }
#edges { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
#canvas { position: relative; min-width: 100%; min-height: 100%; }
#hint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; opacity: .45; pointer-events: none; text-align: center; }
.card { position: absolute; width: 190px; background: var(--bg, var(--vscode-editorWidget-background, var(--head-bg))); border: 1px solid var(--border); border-radius: 5px; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
.card h4 { margin: 0; padding: 5px 8px; background: var(--accent); color: var(--accent-fg); border-radius: 4px 4px 0 0; cursor: move; display: flex; justify-content: space-between; align-items: center; font-size: 12px; }
.card h4 .x { cursor: pointer; opacity: .8; padding: 0 2px; }
.card .cols { max-height: 180px; overflow: auto; padding: 4px 0; }
.crow { display: flex; align-items: center; gap: 4px; padding: 1px 8px; }
.crow:hover { background: var(--hover); }
.crow label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.crow select { width: 52px; font-size: 10px; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); }
#bottom { border-top: 1px solid var(--border); display: flex; max-height: 44%; min-height: 200px; }
#controls { flex: 1; overflow: auto; padding: 8px 10px; }
#sqlPane { width: 42%; border-left: 1px solid var(--border); display: flex; flex-direction: column; }
#sql { flex: 1; margin: 0; padding: 8px 10px; overflow: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: pre-wrap; }
#btns { padding: 8px; display: flex; gap: 8px; border-top: 1px solid var(--border); }
button { background: var(--accent); color: var(--accent-fg); border: none; padding: 5px 12px; border-radius: 3px; cursor: pointer; }
button.ghost { background: transparent; color: var(--fg); border: 1px solid var(--border); }
h5 { margin: 10px 0 4px; opacity: .75; text-transform: uppercase; font-size: 10px; letter-spacing: .05em; }
.row { display: flex; gap: 6px; margin: 3px 0; align-items: center; }
.row select, .row input[type=text], .row input[type=number] { background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 3px; padding: 3px 4px; font-size: 12px; }
.row .x { cursor: pointer; opacity: .6; }
.add { cursor: pointer; opacity: .7; margin: 2px 0; display: inline-block; }
.add:hover { opacity: 1; }
.jlabel { fill: var(--fg); font-size: 10px; }
#connName { padding: 6px 10px; opacity: .7; border-bottom: 1px solid var(--border); }
</style></head><body>
<div id="top">
  <div id="side">
    <div id="connName">No connection</div>
    <input id="search" type="text" placeholder="Search tables…">
    <div id="tlist"></div>
  </div>
  <div id="canvasWrap">
    <div id="canvas">
      <svg id="edges"></svg>
      <div id="hint">Drag tables here (or click them)<br>to build a query</div>
    </div>
  </div>
</div>
<div id="bottom">
  <div id="controls">
    <h5>Joins</h5><div id="joins"></div><span class="add" id="addJoin">+ add join</span>
    <h5>Filters (WHERE)</h5><div id="filters"></div><span class="add" id="addFilter">+ add filter</span>
    <h5>Order by</h5><div id="orders"></div><span class="add" id="addOrder">+ add sort</span>
    <h5>Options</h5>
    <div class="row">
      <label><input type="checkbox" id="distinct"> DISTINCT</label>
      <label>Limit <input type="number" id="limit" min="1" style="width:70px" placeholder="all"></label>
    </div>
  </div>
  <div id="sqlPane">
    <pre id="sql">-- add a table to begin</pre>
    <div id="btns">
      <button id="run">▶ Run</button>
      <button id="insert" class="ghost">Insert into editor</button>
      <button id="copy" class="ghost">Copy</button>
    </div>
  </div>
</div>
<script nonce="${nonce}">${SCRIPT}</script>
</body></html>`;
}

const SCRIPT = String.raw`
(function () {
  var vscode = acquireVsCodeApi();
  var cat = { kind: null, defaultSchema: 'public', tables: [], fks: [] };
  var state = { tables: [], joins: [], filters: [], orders: [], distinct: false, limit: '' };
  var nextPos = 0;

  var $ = function (id) { return document.getElementById(id); };
  var KEY = /^[A-Za-z_][A-Za-z0-9_$]*$/;

  function q(name) {
    if (KEY.test(name)) return name;
    return cat.kind === 'mssql' ? '[' + name.replace(/]/g, ']]') + ']' : '"' + name.replace(/"/g, '""') + '"';
  }
  function qualify(t) {
    return t.schema.toLowerCase() === cat.defaultSchema ? q(t.name) : q(t.schema) + '.' + q(t.name);
  }
  function aliasFor(name, used) {
    var base = name.replace(/[^\w]/g, '');
    var parts = base.split('_').filter(Boolean);
    var a = parts.length > 1 ? parts.map(function (p) { return p[0]; }).join('') : base[0] || 't';
    a = a.toLowerCase();
    var c = a, i = 2;
    while (used.indexOf(c) >= 0) c = a + (i++);
    return c;
  }

  // ------------------------------------------------------------ catalog + UI
  window.addEventListener('message', function (e) {
    if (e.data.type !== 'catalog') return;
    cat = e.data;
    $('connName').textContent = cat.connection ? 'Connected: ' + cat.connection : 'No connection — connect first';
    renderSidebar();
  });

  function renderSidebar() {
    var filter = $('search').value.toLowerCase();
    var list = $('tlist');
    list.innerHTML = '';
    cat.tables.forEach(function (t, i) {
      var full = (t.schema + '.' + t.name).toLowerCase();
      if (filter && full.indexOf(filter) < 0) return;
      var div = document.createElement('div');
      div.className = 'titem';
      div.draggable = true;
      var sch = t.schema.toLowerCase() !== cat.defaultSchema ? '<span class="sch">' + t.schema + '.</span>' : '';
      div.innerHTML = sch + t.name + (t.isView ? ' <span class="sch">(view)</span>' : '');
      div.addEventListener('click', function () { addTable(i, null); });
      div.addEventListener('dragstart', function (ev) { ev.dataTransfer.setData('text/plain', String(i)); });
      list.appendChild(div);
    });
  }
  $('search').addEventListener('input', renderSidebar);

  var wrap = $('canvasWrap');
  wrap.addEventListener('dragover', function (e) { e.preventDefault(); });
  wrap.addEventListener('drop', function (e) {
    e.preventDefault();
    var i = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (!isNaN(i)) {
      var r = wrap.getBoundingClientRect();
      addTable(i, { x: e.clientX - r.left + wrap.scrollLeft - 95, y: e.clientY - r.top + wrap.scrollTop - 14 });
    }
  });

  // ------------------------------------------------------------- add tables
  function addTable(catIdx, at) {
    var t = cat.tables[catIdx];
    if (!t) return;
    var used = state.tables.map(function (x) { return x.alias; });
    var entry = {
      schema: t.schema, name: t.name, alias: aliasFor(t.name, used),
      x: at ? Math.max(0, at.x) : 30 + (nextPos % 3) * 230,
      y: at ? Math.max(0, at.y) : 30 + Math.floor(nextPos / 3) * 190,
      cols: t.columns.map(function (c) { return { name: c.name, type: c.type, checked: false, agg: '' }; })
    };
    nextPos++;
    state.tables.push(entry);
    autoJoin(entry);
    render();
  }

  function findTable(schema, name) {
    for (var i = 0; i < state.tables.length; i++) {
      var t = state.tables[i];
      if (t.schema.toLowerCase() === schema.toLowerCase() && t.name.toLowerCase() === name.toLowerCase()) return t;
    }
    return null;
  }

  function autoJoin(entry) {
    for (var i = 0; i < cat.fks.length; i++) {
      var fk = cat.fks[i];
      var isFrom = fk.fromSchema.toLowerCase() === entry.schema.toLowerCase() && fk.fromTable.toLowerCase() === entry.name.toLowerCase();
      var isTo = fk.toSchema.toLowerCase() === entry.schema.toLowerCase() && fk.toTable.toLowerCase() === entry.name.toLowerCase();
      var other = isFrom ? findTable(fk.toSchema, fk.toTable) : isTo ? findTable(fk.fromSchema, fk.fromTable) : null;
      if (!other || other === entry) continue;
      for (var c = 0; c < fk.fromColumns.length; c++) {
        state.joins.push({
          type: 'INNER',
          la: entry.alias, lc: isFrom ? fk.fromColumns[c] : fk.toColumns[c],
          ra: other.alias, rc: isFrom ? fk.toColumns[c] : fk.fromColumns[c]
        });
      }
      return; // one FK relationship is enough as a default
    }
  }

  // ---------------------------------------------------------------- render
  function render() {
    var canvas = $('canvas');
    canvas.querySelectorAll('.card').forEach(function (c) { c.remove(); });
    $('hint').style.display = state.tables.length ? 'none' : 'flex';
    state.tables.forEach(function (t, ti) {
      var card = document.createElement('div');
      card.className = 'card';
      card.style.left = t.x + 'px';
      card.style.top = t.y + 'px';
      card.dataset.ti = ti;
      var h = document.createElement('h4');
      h.innerHTML = '<span>' + t.alias + ' · ' + t.name + '</span><span class="x" title="Remove">✕</span>';
      h.querySelector('.x').addEventListener('mousedown', function (e) { e.stopPropagation(); });
      h.querySelector('.x').addEventListener('click', function () { removeTable(ti); });
      h.addEventListener('mousedown', startDrag.bind(null, t, card));
      card.appendChild(h);
      var cols = document.createElement('div');
      cols.className = 'cols';
      t.cols.forEach(function (c) {
        var row = document.createElement('div');
        row.className = 'crow';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = c.checked;
        cb.addEventListener('change', function () { c.checked = cb.checked; gen(); });
        var lb = document.createElement('label');
        lb.textContent = c.name;
        lb.title = c.type;
        lb.addEventListener('click', function () { cb.checked = !cb.checked; c.checked = cb.checked; gen(); });
        var agg = document.createElement('select');
        ['', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX'].forEach(function (a) {
          var o = document.createElement('option');
          o.value = a; o.textContent = a || 'agg';
          agg.appendChild(o);
        });
        agg.value = c.agg;
        agg.addEventListener('change', function () {
          c.agg = agg.value;
          if (c.agg) { c.checked = true; cb.checked = true; }
          gen();
        });
        row.appendChild(cb); row.appendChild(lb); row.appendChild(agg);
        cols.appendChild(row);
      });
      card.appendChild(cols);
      canvas.appendChild(card);
    });
    renderJoins();
    renderFilters();
    renderOrders();
    drawEdges();
    gen();
  }

  function removeTable(ti) {
    var t = state.tables[ti];
    state.tables.splice(ti, 1);
    state.joins = state.joins.filter(function (j) { return j.la !== t.alias && j.ra !== t.alias; });
    state.filters = state.filters.filter(function (f) { return f.col.indexOf(t.alias + '.') !== 0; });
    state.orders = state.orders.filter(function (o) { return o.col.indexOf(t.alias + '.') !== 0; });
    render();
  }

  var drag = null;
  function startDrag(t, card, e) {
    drag = { t: t, card: card, dx: e.clientX - t.x, dy: e.clientY - t.y };
    e.preventDefault();
  }
  document.addEventListener('mousemove', function (e) {
    if (!drag) return;
    drag.t.x = Math.max(0, e.clientX - drag.dx);
    drag.t.y = Math.max(0, e.clientY - drag.dy);
    drag.card.style.left = drag.t.x + 'px';
    drag.card.style.top = drag.t.y + 'px';
    drawEdges();
  });
  document.addEventListener('mouseup', function () { drag = null; });

  function cardCenter(alias) {
    for (var i = 0; i < state.tables.length; i++) {
      if (state.tables[i].alias === alias) {
        return { x: state.tables[i].x + 95, y: state.tables[i].y + 60 };
      }
    }
    return null;
  }

  function drawEdges() {
    var svg = $('edges');
    var canvas = $('canvas');
    svg.setAttribute('width', canvas.scrollWidth);
    svg.setAttribute('height', canvas.scrollHeight);
    var parts = [];
    var seen = {};
    state.joins.forEach(function (j) {
      var key = j.la + '|' + j.ra;
      if (seen[key]) return;
      seen[key] = true;
      var a = cardCenter(j.la), b = cardCenter(j.ra);
      if (!a || !b) return;
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      parts.push('<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" stroke="var(--border)" stroke-width="2"/>');
      parts.push('<text class="jlabel" x="' + (mx + 4) + '" y="' + (my - 4) + '">' + j.type + '</text>');
    });
    svg.innerHTML = parts.join('');
  }

  // ------------------------------------------------------- joins UI
  function allColumnOptions() {
    var out = [];
    state.tables.forEach(function (t) {
      t.cols.forEach(function (c) { out.push(t.alias + '.' + c.name); });
    });
    return out;
  }

  function makeSelect(options, value, onchange, withEmpty) {
    var s = document.createElement('select');
    (withEmpty ? [''] : []).concat(options).forEach(function (o) {
      var op = document.createElement('option');
      op.value = o; op.textContent = o || '—';
      s.appendChild(op);
    });
    s.value = value || (withEmpty ? '' : options[0] || '');
    s.addEventListener('change', function () { onchange(s.value); });
    return s;
  }

  function renderJoins() {
    var box = $('joins');
    box.innerHTML = '';
    var cols = allColumnOptions();
    state.joins.forEach(function (j, i) {
      var row = document.createElement('div');
      row.className = 'row';
      row.appendChild(makeSelect(['INNER', 'LEFT', 'RIGHT', 'FULL'], j.type, function (v) { j.type = v; gen(); drawEdges(); }));
      row.appendChild(makeSelect(cols, j.la + '.' + j.lc, function (v) { var p = v.split('.'); j.la = p[0]; j.lc = p.slice(1).join('.'); gen(); drawEdges(); }));
      var eq = document.createElement('span'); eq.textContent = '=';
      row.appendChild(eq);
      row.appendChild(makeSelect(cols, j.ra + '.' + j.rc, function (v) { var p = v.split('.'); j.ra = p[0]; j.rc = p.slice(1).join('.'); gen(); drawEdges(); }));
      var x = document.createElement('span'); x.className = 'x'; x.textContent = '✕';
      x.addEventListener('click', function () { state.joins.splice(i, 1); render(); });
      row.appendChild(x);
      box.appendChild(row);
    });
  }
  $('addJoin').addEventListener('click', function () {
    var cols = allColumnOptions();
    if (cols.length < 2) return;
    var p1 = cols[0].split('.'), p2 = cols[1].split('.');
    state.joins.push({ type: 'INNER', la: p1[0], lc: p1.slice(1).join('.'), ra: p2[0], rc: p2.slice(1).join('.') });
    render();
  });

  // ------------------------------------------------------- filters UI
  var OPS = ['=', '<>', '>', '<', '>=', '<=', 'LIKE', 'IN', 'IS NULL', 'IS NOT NULL'];
  function renderFilters() {
    var box = $('filters');
    box.innerHTML = '';
    var cols = allColumnOptions();
    state.filters.forEach(function (f, i) {
      var row = document.createElement('div');
      row.className = 'row';
      row.appendChild(makeSelect(cols, f.col, function (v) { f.col = v; gen(); }));
      row.appendChild(makeSelect(OPS, f.op, function (v) { f.op = v; renderFilters(); gen(); }));
      if (f.op !== 'IS NULL' && f.op !== 'IS NOT NULL') {
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.placeholder = f.op === 'IN' ? 'a, b, c' : 'value';
        inp.value = f.val;
        inp.addEventListener('input', function () { f.val = inp.value; gen(); });
        row.appendChild(inp);
      }
      var x = document.createElement('span'); x.className = 'x'; x.textContent = '✕';
      x.addEventListener('click', function () { state.filters.splice(i, 1); renderFilters(); gen(); });
      row.appendChild(x);
      box.appendChild(row);
    });
  }
  $('addFilter').addEventListener('click', function () {
    var cols = allColumnOptions();
    if (!cols.length) return;
    state.filters.push({ col: cols[0], op: '=', val: '' });
    renderFilters(); gen();
  });

  // ------------------------------------------------------- order by UI
  function renderOrders() {
    var box = $('orders');
    box.innerHTML = '';
    var cols = allColumnOptions();
    state.orders.forEach(function (o, i) {
      var row = document.createElement('div');
      row.className = 'row';
      row.appendChild(makeSelect(cols, o.col, function (v) { o.col = v; gen(); }));
      row.appendChild(makeSelect(['ASC', 'DESC'], o.dir, function (v) { o.dir = v; gen(); }));
      var x = document.createElement('span'); x.className = 'x'; x.textContent = '✕';
      x.addEventListener('click', function () { state.orders.splice(i, 1); renderOrders(); gen(); });
      row.appendChild(x);
      box.appendChild(row);
    });
  }
  $('addOrder').addEventListener('click', function () {
    var cols = allColumnOptions();
    if (!cols.length) return;
    state.orders.push({ col: cols[0], dir: 'ASC' });
    renderOrders(); gen();
  });

  $('distinct').addEventListener('change', function (e) { state.distinct = e.target.checked; gen(); });
  $('limit').addEventListener('input', function (e) { state.limit = e.target.value; gen(); });

  // ------------------------------------------------------- SQL generation
  function qcol(ref) {
    var p = ref.split('.');
    return p[0] + '.' + q(p.slice(1).join('.'));
  }
  function sqlValue(op, raw) {
    if (op === 'IN') {
      return '(' + raw.split(',').map(function (v) { return literal(v.trim()); }).join(', ') + ')';
    }
    return literal(raw);
  }
  function literal(v) {
    if (/^-?(\d+\.?\d*|\.\d+)$/.test(v)) return v;
    return "'" + v.replace(/'/g, "''") + "'";
  }

  function gen() {
    if (!state.tables.length) {
      $('sql').textContent = '-- add a table to begin';
      return;
    }
    var lines = [];
    var selected = [];
    var groupBy = [];
    var hasAgg = state.tables.some(function (t) {
      return t.cols.some(function (c) { return c.checked && c.agg; });
    });
    state.tables.forEach(function (t) {
      t.cols.forEach(function (c) {
        if (!c.checked) return;
        var ref = t.alias + '.' + q(c.name);
        if (c.agg) {
          selected.push(c.agg + '(' + ref + ') AS ' + (c.agg + '_' + c.name).toLowerCase());
        } else {
          selected.push(ref);
          if (hasAgg) groupBy.push(ref);
        }
      });
    });
    var top = cat.kind === 'mssql' && state.limit ? 'TOP ' + parseInt(state.limit, 10) + ' ' : '';
    lines.push('SELECT ' + (state.distinct ? 'DISTINCT ' : '') + top + (selected.length ? selected.join(',\n       ') : '*'));

    var first = state.tables[0];
    lines.push('FROM ' + qualify(first) + ' ' + first.alias);
    for (var i = 1; i < state.tables.length; i++) {
      var t = state.tables[i];
      var conds = state.joins.filter(function (j) {
        return (j.la === t.alias && aliasIndex(j.ra) < i) || (j.ra === t.alias && aliasIndex(j.la) < i);
      });
      if (conds.length) {
        var type = conds[0].type;
        var on = conds.map(function (j) { return qcol(j.la + '.' + j.lc) + ' = ' + qcol(j.ra + '.' + j.rc); }).join(' AND ');
        lines.push(type + ' JOIN ' + qualify(t) + ' ' + t.alias + ' ON ' + on);
      } else {
        lines.push('CROSS JOIN ' + qualify(t) + ' ' + t.alias);
      }
    }

    var where = state.filters
      .filter(function (f) { return f.op === 'IS NULL' || f.op === 'IS NOT NULL' || f.val !== ''; })
      .map(function (f) {
        if (f.op === 'IS NULL' || f.op === 'IS NOT NULL') return qcol(f.col) + ' ' + f.op;
        return qcol(f.col) + ' ' + f.op + ' ' + sqlValue(f.op, f.val);
      });
    if (where.length) lines.push('WHERE ' + where.join('\n  AND '));
    if (groupBy.length) lines.push('GROUP BY ' + groupBy.join(', '));
    if (state.orders.length) {
      lines.push('ORDER BY ' + state.orders.map(function (o) { return qcol(o.col) + ' ' + o.dir; }).join(', '));
    }
    if (cat.kind !== 'mssql' && state.limit) lines.push('LIMIT ' + parseInt(state.limit, 10));
    $('sql').textContent = lines.join('\n') + ';';
  }

  function aliasIndex(alias) {
    for (var i = 0; i < state.tables.length; i++) if (state.tables[i].alias === alias) return i;
    return -1;
  }

  // ------------------------------------------------------------ actions
  function currentSql() { return $('sql').textContent; }
  $('run').addEventListener('click', function () {
    if (state.tables.length) vscode.postMessage({ type: 'run', sql: currentSql() });
  });
  $('insert').addEventListener('click', function () {
    if (state.tables.length) vscode.postMessage({ type: 'insert', sql: currentSql() });
  });
  $('copy').addEventListener('click', function () { navigator.clipboard.writeText(currentSql()); });
})();`;
