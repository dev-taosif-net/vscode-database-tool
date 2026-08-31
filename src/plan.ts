/**
 * Actual execution plan parsing + visualization.
 *  - PostgreSQL: EXPLAIN (ANALYZE, FORMAT JSON) → JSON tree.
 *  - SQL Server: SET STATISTICS XML ON → ShowPlan XML result set (parsed with
 *    a tiny attribute-oriented XML reader — ShowPlan is machine-generated and
 *    fully attribute-based, so no DOM library is needed).
 * Both normalize into PlanNode trees rendered as a collapsible HTML tree with
 * per-node time bars (share of total), row counts, and estimate-vs-actual
 * warnings — the hot path is visible at a glance.
 */

export interface PlanNode {
  label: string;
  detail?: string;
  /** inclusive actual time (ms) */
  inclMs?: number;
  /** exclusive actual time (ms) — inclusive minus children */
  selfMs?: number;
  rows?: number;
  estRows?: number;
  children: PlanNode[];
}

export interface PlanTree {
  title: string;
  root: PlanNode;
  planningMs?: number;
  executionMs?: number;
}

// ------------------------------------------------------------------ postgres

export function planFromPgJson(value: unknown): PlanTree[] {
  let data: unknown = value;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return [];
    }
  }
  const list = Array.isArray(data) ? data : [data];
  const out: PlanTree[] = [];
  for (const entry of list) {
    const e = entry as { Plan?: unknown; 'Planning Time'?: number; 'Execution Time'?: number };
    if (!e?.Plan) continue;
    const root = pgNode(e.Plan as Record<string, unknown>);
    computeSelf(root);
    out.push({
      title: out.length ? `Statement ${out.length + 1}` : 'Execution plan',
      root,
      planningMs: e['Planning Time'],
      executionMs: e['Execution Time'],
    });
  }
  return out;
}

function pgNode(p: Record<string, unknown>): PlanNode {
  const type = String(p['Node Type'] ?? 'Node');
  const join = p['Join Type'] && p['Join Type'] !== 'Inner' ? ` (${p['Join Type']})` : '';
  const rel = p['Relation Name'] ? ` on ${p['Relation Name']}` : '';
  const alias = p['Alias'] && p['Alias'] !== p['Relation Name'] ? ` ${p['Alias']}` : '';
  const index = p['Index Name'] ? ` using ${p['Index Name']}` : '';
  const detail =
    firstOf(p, ['Index Cond', 'Hash Cond', 'Merge Cond', 'Recheck Cond', 'Filter', 'Sort Key', 'Group Key']);
  const loops = num(p['Actual Loops']) ?? 1;
  const perLoop = num(p['Actual Total Time']);
  const children = Array.isArray(p['Plans'])
    ? (p['Plans'] as Record<string, unknown>[]).map(pgNode)
    : [];
  return {
    label: `${type}${join}${rel}${alias}${index}`,
    detail,
    inclMs: perLoop !== undefined ? perLoop * loops : undefined,
    rows: num(p['Actual Rows']) !== undefined ? num(p['Actual Rows'])! * loops : undefined,
    estRows: num(p['Plan Rows']),
    children,
  };
}

function firstOf(p: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = p[k];
    if (v !== undefined && v !== null) {
      const s = Array.isArray(v) ? v.join(', ') : String(v);
      return `${k}: ${s}`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- sql server

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

/** Minimal XML reader — elements + double-quoted attributes, no text nodes. */
export function parseXml(text: string): XmlNode | undefined {
  const TAG = /<([!?/]?)([\w:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const ATTR = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  const root: XmlNode = { tag: '#root', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(text))) {
    const [, lead, tag, attrText, selfClose] = m;
    if (lead === '!' || lead === '?') continue;
    if (lead === '/') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node: XmlNode = { tag, attrs: {}, children: [] };
    let a: RegExpExecArray | null;
    ATTR.lastIndex = 0;
    while ((a = ATTR.exec(attrText))) node.attrs[a[1]] = decodeEntities(a[2]);
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root.children[0];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function findAll(node: XmlNode, tag: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.tag === tag || c.tag.endsWith(':' + tag)) out.push(c);
    findAll(c, tag, out);
  }
  return out;
}

/** Direct RelOp descendants: stop descending once a RelOp is found. */
function childRelOps(node: XmlNode, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.tag === 'RelOp' || c.tag.endsWith(':RelOp')) out.push(c);
    else childRelOps(c, out);
  }
  return out;
}

export function planFromMssqlXml(xml: string): PlanTree[] {
  const doc = parseXml(xml);
  if (!doc) return [];
  const out: PlanTree[] = [];
  for (const stmt of findAll(doc, 'StmtSimple')) {
    const relOps = childRelOps(stmt);
    if (!relOps.length) continue;
    const root = mssqlNode(relOps[0]);
    computeSelf(root);
    const text = stmt.attrs['StatementText'];
    out.push({
      title: text ? truncate(text.trim(), 100) : 'Execution plan',
      root,
      executionMs: root.inclMs,
    });
  }
  return out;
}

function mssqlNode(relOp: XmlNode): PlanNode {
  const attrs = relOp.attrs;
  const op = attrs['PhysicalOp'] ?? 'Operator';
  const logical = attrs['LogicalOp'] && attrs['LogicalOp'] !== attrs['PhysicalOp']
    ? ` (${attrs['LogicalOp']})`
    : '';

  // Object being scanned/seeked, if any (first Object element not under a child RelOp).
  let objText = '';
  const objects = childObjects(relOp);
  if (objects.length) {
    const o = objects[0].attrs;
    const table = [o['Schema'], o['Table']].filter(Boolean).join('.').replace(/[[\]]/g, '');
    const index = o['Index'] ? ` using ${o['Index'].replace(/[[\]]/g, '')}` : '';
    if (table) objText = ` on ${table}${index}`;
  }

  // Actual counters: rows summed across threads, elapsed = max thread (ms).
  let rows: number | undefined;
  let elapsed: number | undefined;
  for (const rti of childRunTime(relOp)) {
    for (const t of rti.children) {
      const r = num(t.attrs['ActualRows']);
      if (r !== undefined) rows = (rows ?? 0) + r;
      const e = num(t.attrs['ActualElapsedms']);
      if (e !== undefined) elapsed = Math.max(elapsed ?? 0, e);
    }
  }

  return {
    label: `${op}${logical}${objText}`,
    detail: undefined,
    inclMs: elapsed,
    rows,
    estRows: num(attrs['EstimateRows']),
    children: childRelOps(relOp).map(mssqlNode),
  };
}

function childObjects(relOp: XmlNode, out: XmlNode[] = []): XmlNode[] {
  for (const c of relOp.children) {
    if (c.tag === 'RelOp' || c.tag.endsWith(':RelOp')) continue;
    if (c.tag === 'Object' || c.tag.endsWith(':Object')) out.push(c);
    else childObjects(c, out);
  }
  return out;
}

function childRunTime(relOp: XmlNode): XmlNode[] {
  return relOp.children.filter(
    (c) => c.tag === 'RunTimeInformation' || c.tag.endsWith(':RunTimeInformation')
  );
}

// ------------------------------------------------------------------- shared

function computeSelf(node: PlanNode): void {
  for (const c of node.children) computeSelf(c);
  if (node.inclMs !== undefined) {
    const childMs = node.children.reduce((a, c) => a + (c.inclMs ?? 0), 0);
    node.selfMs = Math.max(0, node.inclMs - childMs);
  }
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ----------------------------------------------------------------- rendering

export function renderPlanHtml(trees: PlanTree[]): string {
  return trees.map(renderTree).join('\n');
}

function renderTree(tree: PlanTree): string {
  const total = tree.root.inclMs ?? sumSelf(tree.root) ?? 0;
  const timing = [
    tree.planningMs !== undefined ? `planning ${fmtMs(tree.planningMs)}` : '',
    tree.executionMs !== undefined ? `execution ${fmtMs(tree.executionMs)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return `<div class="plan">
  <div class="plan-head"><b>${esc(tree.title)}</b>${timing ? ` <span class="dim">${esc(timing)}</span>` : ''}</div>
  ${nodeHtml(tree.root, total || 1)}
  </div>`;
}

function sumSelf(n: PlanNode): number {
  return (n.selfMs ?? 0) + n.children.reduce((a, c) => a + sumSelf(c), 0);
}

function nodeHtml(n: PlanNode, totalMs: number): string {
  const pct = n.selfMs !== undefined ? Math.min(100, (n.selfMs / totalMs) * 100) : 0;
  const hot = pct >= 33 ? ' hot' : pct >= 10 ? ' warm' : '';
  const misestimate =
    n.rows !== undefined && n.estRows !== undefined && n.estRows > 0 &&
    Math.max(n.rows, 1) / Math.max(n.estRows, 1) >= 10 &&
    Math.max(n.rows, n.estRows) >= 100;

  const metrics: string[] = [];
  if (n.selfMs !== undefined) metrics.push(`${fmtMs(n.selfMs)} self`);
  else if (n.inclMs !== undefined) metrics.push(fmtMs(n.inclMs));
  if (n.rows !== undefined) {
    metrics.push(
      `${fmtNum(n.rows)} rows` +
      (n.estRows !== undefined ? ` <span class="dim">(est ${fmtNum(n.estRows)})</span>` : '')
    );
  }
  const row = `<div class="pn-row${hot}" style="--pct:${pct.toFixed(1)}%">
    <span class="pn-label">${esc(n.label)}${misestimate ? ' <span class="mis">⚠ estimate off</span>' : ''}</span>
    <span class="pn-metrics">${metrics.join(' · ')}</span>
  </div>${n.detail ? `<div class="pn-detail dim">${esc(n.detail)}</div>` : ''}`;

  if (!n.children.length) return `<div class="pn-leaf">${row}</div>`;
  return `<details open class="pn"><summary>${row}</summary><div class="pn-kids">${n.children
    .map((c) => nodeHtml(c, totalMs))
    .join('')}</div></details>`;
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return (ms / 1000).toFixed(2) + ' s';
  return ms.toFixed(ms < 10 ? 2 : 1) + ' ms';
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
