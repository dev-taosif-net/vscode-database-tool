import * as vscode from 'vscode';
import { ConnectionStore } from './store';
import { ConnectionMeta, DbKind, DbSession, QueryOutcome } from './types';
import { registerCompletions, CompletionApi } from './completion';
import { registerKeywordUppercase } from './keywordCase';
import { registerSemanticTokens, SemanticApi } from './semanticTokens';
import { ResultsPanel } from './resultsPanel';
import { ConnectionFormPanel } from './connectionForm';
import { QueryBuilderPanel } from './queryBuilder';
import { connectionIcon, clearIcons } from './colorIcons';
import { safeColor } from './theme';
import {
  Catalog, CatalogColumn, CatalogRoutine, CatalogTable,
  definitionSql, execTemplate, loadCatalog, peekSql,
} from './catalog';
import {
  countRowsSql, createDatabaseSql, createTableDdl, deleteAllSql, dropRoutineSql, dropTableSql,
  listDatabasesSql, newFunctionTemplate, newIndexTemplate, newProcedureTemplate, newSchemaTemplate,
  newTableTemplate, newViewTemplate, scriptDelete, scriptInsert, scriptSelect, scriptUpdate,
  truncateSql, viewDefinitionSql,
} from './ddl';
import {
  catalogCacheKey, clearAllCatalogCaches, deleteCatalogCache, loadCachedCatalog, saveCatalogCache,
} from './catalogCache';
import { planFromMssqlXml, planFromPgJson, PlanTree, renderPlanHtml } from './plan';
import { disposeLogs, log, showLogs, sqlPreview } from './log';

let ctx: vscode.ExtensionContext;
let store: ConnectionStore;
let active: DbSession | undefined;
let activeCatalog: Catalog | undefined;
let statusItem: vscode.StatusBarItem;
let completionApi: CompletionApi;
let semanticApi: SemanticApi;
const treeChanged = new vscode.EventEmitter<TreeNode | undefined | void>();

export function activate(context: vscode.ExtensionContext): void {
  ctx = context;
  store = new ConnectionStore(context);
  ResultsPanel.init(context);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusItem.command = 'dbtool.connect';
  updateStatus();
  statusItem.show();
  context.subscriptions.push(statusItem, treeChanged);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dbtool.connections', treeProvider),
    vscode.commands.registerCommand('dbtool.addConnection', () => openForm(undefined)),
    vscode.commands.registerCommand('dbtool.editConnection', (item?: TreeArg) => editConnection(item)),
    vscode.commands.registerCommand('dbtool.connect', (item?: TreeArg) => connect(item)),
    vscode.commands.registerCommand('dbtool.disconnect', () => disconnect()),
    vscode.commands.registerCommand('dbtool.removeConnection', (item?: TreeArg) => removeConnection(item)),
    vscode.commands.registerCommand('dbtool.newQuery', () => newQuery()),
    vscode.commands.registerCommand('dbtool.runQuery', () => runQuery()),
    vscode.commands.registerCommand('dbtool.explainQuery', () => explainQuery()),
    vscode.commands.registerCommand('dbtool.queryBuilder', () => openQueryBuilder()),
    vscode.commands.registerCommand('dbtool.searchObjects', () => searchObjects()),
    vscode.commands.registerCommand('dbtool.peekTable', (n?: TreeNode) => peekTable(n)),
    vscode.commands.registerCommand('dbtool.viewRoutine', (n?: TreeNode) => viewRoutine(n)),
    vscode.commands.registerCommand('dbtool.execRoutine', (n?: TreeNode) => execRoutine(n)),
    vscode.commands.registerCommand('dbtool.createObject', () => createObject()),
    vscode.commands.registerCommand('dbtool.switchDatabase', () => switchDatabase()),
    vscode.commands.registerCommand('dbtool.countRows', (n?: TreeNode) => countRows(n)),
    vscode.commands.registerCommand('dbtool.scriptSelect', (n?: TreeNode) => scriptTable(n, 'select')),
    vscode.commands.registerCommand('dbtool.scriptInsert', (n?: TreeNode) => scriptTable(n, 'insert')),
    vscode.commands.registerCommand('dbtool.scriptUpdate', (n?: TreeNode) => scriptTable(n, 'update')),
    vscode.commands.registerCommand('dbtool.scriptDelete', (n?: TreeNode) => scriptTable(n, 'delete')),
    vscode.commands.registerCommand('dbtool.scriptCreate', (n?: TreeNode) => scriptTable(n, 'create')),
    vscode.commands.registerCommand('dbtool.truncateTable', (n?: TreeNode) => truncateTable(n)),
    vscode.commands.registerCommand('dbtool.deleteRows', (n?: TreeNode) => deleteAllRows(n)),
    vscode.commands.registerCommand('dbtool.dropObject', (n?: TreeNode) => dropObject(n)),
    vscode.commands.registerCommand('dbtool.dropRoutine', (n?: TreeNode) => dropRoutine(n)),
    vscode.commands.registerCommand('dbtool.clearAllData', () => clearAllData()),
    vscode.commands.registerCommand('dbtool.refreshSchema', () => refreshSchema()),
    vscode.commands.registerCommand('dbtool.showLogs', () => showLogs()),
    { dispose: disposeLogs }
  );

  completionApi = registerCompletions(context, () => active?.meta.kind, () => activeCatalog);
  semanticApi = registerSemanticTokens(context, () => activeCatalog);
  registerKeywordUppercase(context);
}

export async function deactivate(): Promise<void> {
  await active?.dispose().catch(() => undefined);
}

// ------------------------------------------------------------------ tree view

type TreeArg = string | { id?: string } | TreeNode | undefined;

type TreeNode =
  | { t: 'conn'; meta: ConnectionMeta }
  | { t: 'grp'; label: string; icon: string; children: TreeNode[] }
  | { t: 'table'; table: CatalogTable }
  | { t: 'col'; table: CatalogTable; col: CatalogColumn }
  | { t: 'routine'; routine: CatalogRoutine };

const treeProvider: vscode.TreeDataProvider<TreeNode> = {
  onDidChangeTreeData: treeChanged.event,
  getChildren: (el) => {
    if (!el) {
      return store
        .list()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((meta): TreeNode => ({ t: 'conn', meta }));
    }
    if (el.t === 'conn') {
      if (active?.meta.id !== el.meta.id || !activeCatalog) return [];
      return schemaGroups(activeCatalog);
    }
    if (el.t === 'grp') return el.children;
    if (el.t === 'table') {
      return el.table.columns.map((col): TreeNode => ({ t: 'col', table: el.table, col }));
    }
    return [];
  },
  getTreeItem: async (n) => {
    switch (n.t) {
      case 'conn':
        return connTreeItem(n.meta);
      case 'grp': {
        const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon(n.icon);
        item.description = String(n.children.length);
        return item;
      }
      case 'table': {
        const item = new vscode.TreeItem(n.table.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon(n.table.isView ? 'window' : 'table');
        const cat = activeCatalog;
        if (cat && n.table.schema.toLowerCase() !== cat.defaultSchema) item.description = n.table.schema;
        item.contextValue = 'table';
        item.tooltip = `${n.table.schema}.${n.table.name} — ${n.table.columns.length} columns`;
        return item;
      }
      case 'col': {
        const item = new vscode.TreeItem(n.col.name, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('symbol-field');
        item.description = n.col.dataType;
        return item;
      }
      case 'routine': {
        const r = n.routine;
        const item = new vscode.TreeItem(r.name, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(r.kind === 'procedure' ? 'symbol-method' : 'symbol-function');
        item.description =
          r.signature ?? r.params.map((p) => p.name || p.dataType).join(', ');
        item.contextValue = 'routine';
        item.tooltip = `${r.schema}.${r.name} (${r.kind})`;
        item.command = { command: 'dbtool.viewRoutine', title: 'View Definition', arguments: [n] };
        return item;
      }
    }
  },
};

function schemaGroups(cat: Catalog): TreeNode[] {
  const tables = cat.tables.filter((t) => !t.isView);
  const views = cat.tables.filter((t) => t.isView);
  const procs = cat.routines.filter((r) => r.kind === 'procedure');
  const funcs = cat.routines.filter((r) => r.kind === 'function');
  const groups: TreeNode[] = [];
  const tNode = (table: CatalogTable): TreeNode => ({ t: 'table', table });
  const rNode = (routine: CatalogRoutine): TreeNode => ({ t: 'routine', routine });
  if (tables.length) groups.push({ t: 'grp', label: 'Tables', icon: 'table', children: tables.map(tNode) });
  if (views.length) groups.push({ t: 'grp', label: 'Views', icon: 'window', children: views.map(tNode) });
  if (procs.length) groups.push({ t: 'grp', label: 'Procedures', icon: 'symbol-method', children: procs.map(rNode) });
  if (funcs.length) groups.push({ t: 'grp', label: 'Functions', icon: 'symbol-function', children: funcs.map(rNode) });
  return groups;
}

async function connTreeItem(c: ConnectionMeta): Promise<vscode.TreeItem> {
  const isActive = active?.meta.id === c.id;
  const item = new vscode.TreeItem(
    c.name,
    isActive && activeCatalog
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None
  );
  item.id = c.id;
  item.description = kindLabel(c.kind) + (isActive ? ' • connected' : '');
  item.tooltip = c.mode === 'string'
    ? `${c.name} (${kindLabel(c.kind)}, connection string)`
    : `${c.name} — ${c.user ?? ''}@${c.host ?? ''}:${c.port ?? ''}/${c.database ?? ''}`;
  if (safeColor(c.color)) {
    item.iconPath = await connectionIcon(ctx, c.color, 'db');
  } else {
    item.iconPath = isActive
      ? new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('database');
  }
  item.contextValue = isActive ? 'connectionActive' : 'connection';
  if (!isActive) {
    item.command = { command: 'dbtool.connect', title: 'Connect', arguments: [c.id] };
  }
  return item;
}

function kindLabel(kind: DbKind): string {
  return kind === 'postgres' ? 'PostgreSQL' : 'SQL Server';
}

function updateStatus(): void {
  if (active) {
    const db = active.meta.database ? ` · ${active.meta.database}` : '';
    statusItem.text = `$(database) ${active.meta.name}${db}`;
    statusItem.tooltip = `DB Lite — connected to ${active.meta.name} (${kindLabel(active.meta.kind)}${db}). Click to switch.`;
    statusItem.color = safeColor(active.meta.color);
  } else {
    statusItem.text = '$(database) No DB';
    statusItem.tooltip = 'DB Lite — click to connect to a database';
    statusItem.color = undefined;
  }
}

function refreshUi(): void {
  updateStatus();
  treeChanged.fire();
}

/** Live elapsed-time ticker in the status bar while a query runs. */
function startTimer(label: string): () => void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
  const t0 = performance.now();
  item.text = `$(loading~spin) 0.0s — ${label}`;
  item.show();
  const iv = setInterval(() => {
    item.text = `$(loading~spin) ${((performance.now() - t0) / 1000).toFixed(1)}s — ${label}`;
  }, 100);
  return () => {
    clearInterval(iv);
    item.dispose();
  };
}

// ------------------------------------------------------------ connect / picks

function argId(arg: TreeArg): string | undefined {
  if (typeof arg === 'string') return arg;
  const a = arg as { id?: string; meta?: { id?: string } } | undefined;
  return a?.meta?.id ?? a?.id;
}

function openForm(existing: ConnectionMeta | undefined): void {
  void ConnectionFormPanel.open(ctx, store, existing, () => treeChanged.fire());
}

async function pickConnection(placeHolder: string): Promise<ConnectionMeta | undefined> {
  const list = store.list().sort((a, b) => a.name.localeCompare(b.name));
  if (list.length === 0) {
    openForm(undefined);
    return undefined;
  }
  type Item = vscode.QuickPickItem & { meta?: ConnectionMeta; add?: boolean };
  const items: Item[] = list.map((c) => ({
    label: `$(database) ${c.name}`,
    description: kindLabel(c.kind) + (active?.meta.id === c.id ? ' • connected' : ''),
    detail: c.mode === 'string' ? 'connection string' : `${c.user ?? ''}@${c.host ?? ''}/${c.database ?? ''}`,
    meta: c,
  }));
  items.push({ label: '$(add) Add new connection…', add: true });
  const picked = await vscode.window.showQuickPick(items, { placeHolder });
  if (!picked) return undefined;
  if (picked.add) {
    openForm(undefined);
    return undefined;
  }
  return picked.meta;
}

async function connect(arg?: TreeArg): Promise<void> {
  const id = argId(arg);
  const meta = id ? store.get(id) : await pickConnection('Connect to…');
  if (!meta) return;
  const secret = (await store.secret(meta.id)) ?? '';
  try {
    const t0 = performance.now();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Connecting to ${meta.name}…` },
      async () => {
        // Lazy driver load happens inside openSession — first connect pays it, activation never does.
        const { openSession } = await import('./drivers');
        const next = await openSession(meta, secret);
        await active?.dispose().catch(() => undefined);
        active = next;
        activeCatalog = undefined;
      }
    );
    log(`Connected to ${meta.name} (${kindLabel(meta.kind)}) in ${(performance.now() - t0).toFixed(0)} ms`);
    refreshUi();
    vscode.window.setStatusBarMessage(`$(check) Connected to ${meta.name}`, 3000);
    const session = active;
    if (session) {
      // Instant completions from the disk cache, fresh catalog in the background.
      void loadCachedCatalog(ctx, catalogCacheKey(meta.id, meta.database)).then((cached) => {
        if (cached && active === session && !activeCatalog) {
          activeCatalog = cached;
          log(`Schema cache hit for ${meta.name}: ${cached.tables.length} tables/views (refreshing in background)`);
          catalogUpdated();
        }
      });
      void refreshCatalog(session);
    }
  } catch (e) {
    log(`Connect failed for ${meta.name}: ${(e as Error)?.message ?? e}`);
    vscode.window.showErrorMessage(
      `DB Lite: failed to connect to "${meta.name}" — ${(e as Error)?.message ?? e}`
    );
  }
}

/** Everything that consumes the catalog gets notified about a new one. */
function catalogUpdated(): void {
  const cat = activeCatalog;
  if (cat) {
    // Prebuild completion items off the keystroke path.
    setTimeout(() => completionApi.prewarm(cat), 0);
  }
  semanticApi.refresh();
  treeChanged.fire();
  QueryBuilderPanel.postCatalog(activeCatalog, active?.meta);
}

async function refreshCatalog(session: DbSession): Promise<void> {
  if (!vscode.workspace.getConfiguration('dbtool').get('schemaCompletion', true)) return;
  const t0 = performance.now();
  try {
    const cat = await loadCatalog(session);
    if (active !== session) return; // switched away while loading
    activeCatalog = cat;
    log(
      `Schema loaded for ${session.meta.name}: ${cat.tables.length} tables/views, ` +
      `${cat.fks.length} foreign keys, ${cat.routines.length} routines in ${(performance.now() - t0).toFixed(0)} ms`
    );
    catalogUpdated();
    void saveCatalogCache(ctx, catalogCacheKey(session.meta.id, session.meta.database), cat);
  } catch (e) {
    log(`Schema load failed for ${session.meta.name}: ${(e as Error)?.message ?? e}`);
  }
}

async function refreshSchema(): Promise<void> {
  if (!active) {
    vscode.window.showWarningMessage('DB Lite: connect to a database first.');
    return;
  }
  const session = active;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Refreshing schema of ${session.meta.name}…` },
    () => refreshCatalog(session)
  );
  if (activeCatalog && active === session) {
    vscode.window.setStatusBarMessage(
      `$(check) Schema refreshed — ${activeCatalog.tables.length} tables/views`,
      3000
    );
  }
}

async function disconnect(): Promise<void> {
  if (!active) return;
  const name = active.meta.name;
  await active.dispose().catch(() => undefined);
  active = undefined;
  activeCatalog = undefined;
  log(`Disconnected from ${name}`);
  refreshUi();
  QueryBuilderPanel.postCatalog(undefined, undefined);
  vscode.window.setStatusBarMessage(`Disconnected from ${name}`, 3000);
}

async function editConnection(arg?: TreeArg): Promise<void> {
  const id = argId(arg);
  const meta = id ? store.get(id) : await pickConnection('Edit which connection?');
  if (!meta) return;
  openForm(meta);
}

async function removeConnection(arg?: TreeArg): Promise<void> {
  const id = argId(arg);
  const meta = id ? store.get(id) : await pickConnection('Remove which connection?');
  if (!meta) return;
  const ok = await vscode.window.showWarningMessage(
    `Delete connection "${meta.name}"? Its saved credentials will also be removed.`,
    { modal: true },
    'Delete'
  );
  if (ok !== 'Delete') return;
  if (active?.meta.id === meta.id) await disconnect();
  await store.remove(meta.id);
  await deleteCatalogCache(ctx, meta.id);
  treeChanged.fire();
}

async function clearAllData(): Promise<void> {
  const count = store.list().length;
  const ok = await vscode.window.showWarningMessage(
    `Delete ALL DB Lite data? This removes ${count} connection${count === 1 ? '' : 's'} and every stored credential from your OS keychain. This cannot be undone.`,
    { modal: true },
    'Delete Everything'
  );
  if (ok !== 'Delete Everything') return;
  await disconnect();
  await store.clearAll();
  await clearIcons(ctx);
  await clearAllCatalogCaches(ctx);
  treeChanged.fire();
  vscode.window.showInformationMessage('DB Lite: all connections and credentials deleted.');
}

// -------------------------------------------------------------------- queries

async function newQuery(): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    language: 'sql',
    content: '',
  });
  await vscode.window.showTextDocument(doc);
}

async function ensureSession(): Promise<DbSession | undefined> {
  if (!active) {
    await connect();
  }
  return active;
}

function editorSql(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('DB Lite: open a SQL file to run a query.');
    return undefined;
  }
  // Selection wins over the whole file; multiple selections run in order.
  const selectedText = editor.selections
    .filter((s) => !s.isEmpty)
    .sort((a, b) => a.start.compareTo(b.start))
    .map((s) => editor.document.getText(s))
    .join('\n');
  const sql = (selectedText || editor.document.getText()).trim();
  if (!sql) {
    vscode.window.showWarningMessage('DB Lite: nothing to run — the file/selection is empty.');
    return undefined;
  }
  return sql;
}

async function runQuery(): Promise<void> {
  const sql = editorSql();
  if (!sql) return;
  await runSqlText(sql);
}

async function runSqlText(sql: string): Promise<void> {
  const session = await ensureSession();
  if (!session) return;
  const maxRows = vscode.workspace.getConfiguration('dbtool').get<number>('maxRenderRows', 1000);
  const stop = startTimer(`running on ${session.meta.name}`);
  try {
    const outcome = await session.run(sql);
    const rows = outcome.sets.reduce((a, s) => a + s.rowCount, 0);
    log(
      `Query on ${session.meta.name} ok in ${outcome.durationMs.toFixed(1)} ms — ` +
      `${outcome.sets.length} set(s), ${rows} row(s): ${sqlPreview(sql)}`
    );
    ResultsPanel.showResults(session.meta, outcome, maxRows);
  } catch (e) {
    log(`Query on ${session.meta.name} FAILED: ${(e as Error)?.message ?? e} — ${sqlPreview(sql)}`);
    ResultsPanel.showError(session.meta, e);
  } finally {
    stop();
  }
}

/** Run with actual execution plan: EXPLAIN ANALYZE (pg) / STATISTICS XML (mssql). */
async function explainQuery(): Promise<void> {
  const sql = editorSql();
  if (!sql) return;
  const session = await ensureSession();
  if (!session) return;
  const maxRows = vscode.workspace.getConfiguration('dbtool').get<number>('maxRenderRows', 1000);
  const stop = startTimer(`plan on ${session.meta.name}`);
  try {
    let trees: PlanTree[] = [];
    let outcome: QueryOutcome | undefined;
    if (session.meta.kind === 'postgres') {
      const res = await session.run(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)\n${sql}`);
      for (const set of res.sets) {
        for (const row of set.rows) trees.push(...planFromPgJson(row[0]));
      }
    } else {
      const res = await session.run(`SET STATISTICS XML ON;\n${sql}`);
      const planSets = res.sets.filter(
        (s) => s.columns.length === 1 && /showplan/i.test(s.columns[0])
      );
      outcome = { sets: res.sets.filter((s) => !planSets.includes(s)), durationMs: res.durationMs };
      for (const s of planSets) {
        for (const row of s.rows) trees.push(...planFromMssqlXml(String(row[0])));
      }
    }
    log(`Plan on ${session.meta.name}: ${trees.length} statement(s) — ${sqlPreview(sql)}`);
    const planHtml = trees.length
      ? renderPlanHtml(trees)
      : '<div class="dim">The server returned no execution plan for this statement.</div>';
    ResultsPanel.showPlan(session.meta, planHtml, outcome, maxRows);
  } catch (e) {
    log(`Plan on ${session.meta.name} FAILED: ${(e as Error)?.message ?? e}`);
    ResultsPanel.showError(session.meta, e);
  } finally {
    stop();
  }
}

// ----------------------------------------------------- schema object actions

function nodeTable(n?: TreeNode): CatalogTable | undefined {
  return n && typeof n === 'object' && 't' in n && n.t === 'table' ? n.table : undefined;
}

function nodeRoutine(n?: TreeNode): CatalogRoutine | undefined {
  return n && typeof n === 'object' && 't' in n && n.t === 'routine' ? n.routine : undefined;
}

async function peekTable(n?: TreeNode, table?: CatalogTable): Promise<void> {
  const t = table ?? nodeTable(n);
  const session = active;
  if (!t || !session) return;
  await runSqlText(peekSql(t, session.meta.kind, 100));
}

async function viewRoutine(n?: TreeNode, routine?: CatalogRoutine): Promise<void> {
  const r = routine ?? nodeRoutine(n);
  const session = active;
  if (!r || !session) return;
  const stop = startTimer(`loading ${r.name}`);
  try {
    const res = await session.run(definitionSql(r, session.meta.kind));
    const defs = res.sets
      .flatMap((s) => s.rows)
      .map((row) => String(row[0] ?? ''))
      .filter(Boolean);
    const content = defs.length
      ? defs.join('\n\nGO\n\n')
      : `-- No definition available for ${r.schema}.${r.name} (missing permissions?)`;
    const doc = await vscode.workspace.openTextDocument({ language: 'sql', content });
    await vscode.window.showTextDocument(doc);
  } catch (e) {
    vscode.window.showErrorMessage(`DB Lite: failed to load definition — ${(e as Error)?.message ?? e}`);
  } finally {
    stop();
  }
}

async function execRoutine(n?: TreeNode, routine?: CatalogRoutine): Promise<void> {
  const r = routine ?? nodeRoutine(n);
  const session = active;
  if (!r || !session) return;
  const doc = await vscode.workspace.openTextDocument({
    language: 'sql',
    content: execTemplate(r, session.meta.kind) + '\n',
  });
  await vscode.window.showTextDocument(doc);
}

/** Fuzzy quick-pick over every table / view / procedure / function. */
async function searchObjects(): Promise<void> {
  const cat = activeCatalog;
  if (!cat) {
    vscode.window.showWarningMessage('DB Lite: connect first — the schema loads right after connecting.');
    return;
  }
  type Item = vscode.QuickPickItem & { table?: CatalogTable; routine?: CatalogRoutine };
  const items: Item[] = [
    ...cat.tables.map((t): Item => ({
      label: `$(${t.isView ? 'window' : 'table'}) ${t.name}`,
      description: [t.schema, t.isView ? 'view' : 'table'].join(' · '),
      detail: t.columns.slice(0, 8).map((c) => c.name).join(', ') + (t.columns.length > 8 ? ', …' : ''),
      table: t,
    })),
    ...cat.routines.map((r): Item => ({
      label: `$(${r.kind === 'procedure' ? 'symbol-method' : 'symbol-function'}) ${r.name}`,
      description: [r.schema, r.kind].join(' · '),
      detail: r.signature ?? r.params.map((p) => p.name || p.dataType).join(', '),
      routine: r,
    })),
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Search ${cat.tables.length} tables/views and ${cat.routines.length} routines…`,
    matchOnDescription: true,
  });
  if (!picked) return;
  if (picked.table) await peekTable(undefined, picked.table);
  else if (picked.routine) await viewRoutine(undefined, picked.routine);
}

function openQueryBuilder(): void {
  QueryBuilderPanel.open(ctx, () => activeCatalog, () => active?.meta, (sql) => void runSqlText(sql));
}

// ------------------------------------------------------- object management

async function openSqlEditor(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ language: 'sql', content });
  await vscode.window.showTextDocument(doc);
}

/** Resolve a table from a tree node, or let the user pick one. */
async function resolveTable(n?: TreeNode): Promise<CatalogTable | undefined> {
  const fromNode = nodeTable(n);
  if (fromNode) return fromNode;
  const cat = activeCatalog;
  if (!cat) {
    vscode.window.showWarningMessage('DB Lite: connect first — the schema loads right after connecting.');
    return undefined;
  }
  type Item = vscode.QuickPickItem & { table: CatalogTable };
  const picked = await vscode.window.showQuickPick<Item>(
    cat.tables.map((t) => ({
      label: `$(${t.isView ? 'window' : 'table'}) ${t.name}`,
      description: t.schema,
      table: t,
    })),
    { placeHolder: 'Which table?' }
  );
  return picked?.table;
}

async function resolveRoutine(n?: TreeNode): Promise<CatalogRoutine | undefined> {
  const fromNode = nodeRoutine(n);
  if (fromNode) return fromNode;
  const cat = activeCatalog;
  if (!cat) return undefined;
  type Item = vscode.QuickPickItem & { routine: CatalogRoutine };
  const picked = await vscode.window.showQuickPick<Item>(
    cat.routines.map((r) => ({ label: r.name, description: `${r.schema} · ${r.kind}`, routine: r })),
    { placeHolder: 'Which procedure/function?' }
  );
  return picked?.routine;
}

/**
 * Two-step guard for destructive statements: a modal warning, then the exact
 * object name has to be typed back. Returns true only on a perfect match.
 */
async function confirmDestructive(title: string, detail: string, confirmName: string): Promise<boolean> {
  const go = await vscode.window.showWarningMessage(title, { modal: true, detail }, 'Continue');
  if (go !== 'Continue') return false;
  const typed = await vscode.window.showInputBox({
    prompt: `Type the name "${confirmName}" to confirm`,
    placeHolder: confirmName,
    validateInput: (v) => (v === confirmName ? undefined : `Type "${confirmName}" exactly to confirm`),
  });
  return typed === confirmName;
}

/** Execute a DDL/destructive statement, then refresh the schema everywhere. */
async function runDdl(session: DbSession, sql: string, successMsg: string): Promise<boolean> {
  const stop = startTimer('executing');
  try {
    await session.run(sql);
    log(`DDL on ${session.meta.name}: ${sqlPreview(sql)}`);
    vscode.window.setStatusBarMessage(`$(check) ${successMsg}`, 5000);
    if (active === session) void refreshCatalog(session);
    return true;
  } catch (e) {
    log(`DDL on ${session.meta.name} FAILED: ${(e as Error)?.message ?? e} — ${sqlPreview(sql)}`);
    vscode.window.showErrorMessage(`DB Lite: ${(e as Error)?.message ?? e}`);
    return false;
  } finally {
    stop();
  }
}

async function scalar(session: DbSession, sql: string): Promise<unknown> {
  const res = await session.run(sql);
  return res.sets.find((s) => s.rows.length)?.rows[0]?.[0];
}

async function countRows(n?: TreeNode): Promise<void> {
  const t = await resolveTable(n);
  const session = active;
  if (!t || !session) return;
  const stop = startTimer(`counting ${t.name}`);
  try {
    const count = Number(await scalar(session, countRowsSql(t, session.meta.kind)));
    vscode.window.showInformationMessage(`${t.schema}.${t.name}: ${count.toLocaleString('en-US')} rows`);
    log(`Count ${t.schema}.${t.name}: ${count}`);
  } catch (e) {
    vscode.window.showErrorMessage(`DB Lite: ${(e as Error)?.message ?? e}`);
  } finally {
    stop();
  }
}

async function scriptTable(
  n: TreeNode | undefined,
  mode: 'select' | 'insert' | 'update' | 'delete' | 'create'
): Promise<void> {
  const t = await resolveTable(n);
  const session = active;
  const cat = activeCatalog;
  if (!t || !session || !cat) return;
  const kind = session.meta.kind;
  if (mode === 'create' && t.isView) {
    // Views get their real definition from the server.
    try {
      const def = String((await scalar(session, viewDefinitionSql(t, kind))) ?? '');
      if (!def) throw new Error('no definition returned (missing permissions?)');
      const content =
        kind === 'postgres'
          ? `CREATE OR REPLACE VIEW ${t.schema}.${t.name} AS\n${def}`
          : def;
      await openSqlEditor(content);
    } catch (e) {
      vscode.window.showErrorMessage(`DB Lite: failed to script view — ${(e as Error)?.message ?? e}`);
    }
    return;
  }
  const script =
    mode === 'select' ? scriptSelect(t, kind)
    : mode === 'insert' ? scriptInsert(t, kind)
    : mode === 'update' ? scriptUpdate(t, kind)
    : mode === 'delete' ? scriptDelete(t, kind)
    : createTableDdl(t, kind, cat.fks);
  await openSqlEditor(script);
}

async function truncateTable(n?: TreeNode): Promise<void> {
  const t = await resolveTable(n);
  const session = active;
  if (!t || !session) return;
  if (t.isView) {
    vscode.window.showWarningMessage('DB Lite: views cannot be truncated.');
    return;
  }
  const count = await rowCountSafe(session, t);
  const ok = await confirmDestructive(
    `Truncate table ${t.schema}.${t.name}?`,
    `This PERMANENTLY deletes ${count ?? 'all'} row(s) on "${session.meta.name}". It cannot be undone.`,
    t.name
  );
  if (!ok) return;
  if (await runDdl(session, truncateSql(t, session.meta.kind), `Truncated ${t.schema}.${t.name}`)) {
    log(`TRUNCATE confirmed and executed: ${t.schema}.${t.name} (${count ?? '?'} rows)`);
  }
}

async function deleteAllRows(n?: TreeNode): Promise<void> {
  const t = await resolveTable(n);
  const session = active;
  if (!t || !session) return;
  const count = await rowCountSafe(session, t);
  const ok = await confirmDestructive(
    `Delete ALL rows from ${t.schema}.${t.name}?`,
    `This deletes ${count ?? 'all'} row(s) on "${session.meta.name}" with a single DELETE statement. It cannot be undone.`,
    t.name
  );
  if (!ok) return;
  await runDdl(session, deleteAllSql(t, session.meta.kind), `Deleted all rows from ${t.schema}.${t.name}`);
}

async function dropObject(n?: TreeNode): Promise<void> {
  const t = await resolveTable(n);
  const session = active;
  if (!t || !session) return;
  const label = t.isView ? 'view' : 'table';
  const ok = await confirmDestructive(
    `Drop ${label} ${t.schema}.${t.name}?`,
    `This PERMANENTLY removes the ${label}${t.isView ? '' : ' and ALL of its data'} on "${session.meta.name}". It cannot be undone.`,
    t.name
  );
  if (!ok) return;
  await runDdl(session, dropTableSql(t, session.meta.kind), `Dropped ${label} ${t.schema}.${t.name}`);
}

async function dropRoutine(n?: TreeNode): Promise<void> {
  const r = await resolveRoutine(n);
  const session = active;
  if (!r || !session) return;
  const ok = await confirmDestructive(
    `Drop ${r.kind} ${r.schema}.${r.name}?`,
    `This PERMANENTLY removes the ${r.kind} on "${session.meta.name}". It cannot be undone.`,
    r.name
  );
  if (!ok) return;
  await runDdl(session, dropRoutineSql(r, session.meta.kind), `Dropped ${r.kind} ${r.schema}.${r.name}`);
}

async function rowCountSafe(session: DbSession, t: CatalogTable): Promise<string | undefined> {
  try {
    const c = Number(await scalar(session, countRowsSql(t, session.meta.kind)));
    return Number.isFinite(c) ? c.toLocaleString('en-US') : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------- create / databases

async function createObject(): Promise<void> {
  const kind = active?.meta.kind ?? 'postgres';
  type Item = vscode.QuickPickItem & { make?: (k: DbKind) => string; db?: boolean };
  const items: Item[] = [
    { label: '$(table) Table', description: 'CREATE TABLE script', make: newTableTemplate },
    { label: '$(window) View', description: 'CREATE VIEW script', make: newViewTemplate },
    { label: '$(symbol-method) Stored Procedure', description: kind === 'mssql' ? 'CREATE OR ALTER PROCEDURE script' : 'CREATE PROCEDURE script', make: newProcedureTemplate },
    { label: '$(symbol-function) Function', description: 'CREATE FUNCTION script', make: newFunctionTemplate },
    { label: '$(list-tree) Index', description: 'CREATE INDEX script', make: newIndexTemplate },
    { label: '$(symbol-namespace) Schema', description: 'CREATE SCHEMA script', make: newSchemaTemplate },
    { label: '$(database) Database…', description: 'prompts for a name, then creates it', db: true },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Create new object (${kindLabel(kind)} syntax)…`,
  });
  if (!picked) return;
  if (picked.db) {
    await createDatabase();
    return;
  }
  // Scripts open in an editor for review — nothing is executed automatically.
  await openSqlEditor(picked.make!(kind));
}

async function createDatabase(): Promise<void> {
  const session = await ensureSession();
  if (!session) return;
  const name = await vscode.window.showInputBox({
    prompt: `New database name on "${session.meta.name}" (${kindLabel(session.meta.kind)})`,
    validateInput: (v) => {
      if (!v.trim()) return 'Name is required';
      if (v.length > 128) return 'Name is too long';
      // Strict quoting makes any printable name safe; still block control chars.
      if (/[\x00-\x1f\x7f]/.test(v)) return 'Name contains control characters';
      return undefined;
    },
  });
  if (!name) return;
  const ok = await vscode.window.showWarningMessage(
    `Create database "${name}" on "${session.meta.name}"?`,
    { modal: true },
    'Create'
  );
  if (ok !== 'Create') return;
  await runDdl(session, createDatabaseSql(name, session.meta.kind), `Created database ${name}`);
}

/** Reconnect the current fields-mode connection against another database. */
async function switchDatabase(): Promise<void> {
  const session = await ensureSession();
  if (!session) return;
  if (session.meta.mode === 'string') {
    vscode.window.showWarningMessage(
      'DB Lite: switching databases is only supported for host/user connections — edit the connection string instead.'
    );
    return;
  }
  let names: string[];
  try {
    const res = await session.run(listDatabasesSql(session.meta.kind));
    names = (res.sets.find((s) => s.rows.length)?.rows ?? []).map((r) => String(r[0]));
  } catch (e) {
    vscode.window.showErrorMessage(`DB Lite: could not list databases — ${(e as Error)?.message ?? e}`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    names.map((n) => ({
      label: `$(database) ${n}`,
      description: n === session.meta.database ? 'current' : undefined,
      name: n,
    })),
    { placeHolder: `Switch database on ${session.meta.name}…` }
  );
  if (!picked || picked.name === session.meta.database) return;
  const secret = (await store.secret(session.meta.id)) ?? '';
  const meta: ConnectionMeta = { ...session.meta, database: picked.name };
  try {
    const { openSession } = await import('./drivers');
    const next = await openSession(meta, secret);
    await active?.dispose().catch(() => undefined);
    active = next;
    activeCatalog = undefined;
    log(`Switched to database ${picked.name} on ${meta.name}`);
    refreshUi();
    void refreshCatalog(next);
  } catch (e) {
    vscode.window.showErrorMessage(`DB Lite: failed to switch database — ${(e as Error)?.message ?? e}`);
  }
}
