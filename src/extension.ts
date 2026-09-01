import * as vscode from 'vscode';
import { ConnectionStore } from './store';
import { ConnectionMeta, DbKind, DbSession, QueryOutcome } from './types';
import { registerCompletions, CompletionApi } from './completion';
import { registerKeywordUppercase } from './keywordCase';
import { registerSemanticTokens, SemanticApi } from './semanticTokens';
import { registerSignatureHelp } from './signatureHelp';
import { ResultsPanel } from './resultsPanel';
import { ResultsTerminal } from './resultsTerminal';
import { ResultsView } from './resultsView';
import { ConnectionBarApi, registerConnectionBar } from './connectionBar';
import { ConnectionFormPanel } from './connectionForm';
import { QueryBuilderPanel } from './queryBuilder';
import { connectionIcon, clearIcons } from './colorIcons';
import { safeColor } from './theme';
import {
  Catalog, CatalogColumn, CatalogRoutine, CatalogTable,
  definitionSql, execTemplate, loadCatalog, peekSql,
} from './catalog';
import {
  countRowsSql, createDatabaseSql, createTableDdl, currentDatabaseSql, deleteAllSql, dropRoutineSql,
  dropTableSql, listDatabasesSql, newFunctionTemplate, newIndexTemplate, newProcedureTemplate,
  newSchemaTemplate, newTableTemplate, newViewTemplate, scriptDelete, scriptInsert, scriptSelect,
  scriptUpdate, truncateSql, viewDefinitionSql,
} from './ddl';
import {
  catalogCacheKey, clearAllCatalogCaches, deleteCatalogCache, loadCachedCatalog, saveCatalogCache,
} from './catalogCache';
import { planFromMssqlXml, planFromPgJson, PlanTree, renderPlanHtml } from './plan';
import { disposeLogs, log, showLogs, sqlPreview } from './log';

/**
 * One open connection: a live session plus everything loaded around it.
 * Several can be open at once — each SQL tab can be bound to its own (tabConns),
 * while `active` drives the explorer tree and is the default for new tabs.
 */
interface Conn {
  /** Pool key: connection id + attached database. */
  key: string;
  session: DbSession;
  catalog?: Catalog;
  /** All databases on the server, and the one we're attached to. */
  databases: string[];
  currentDb?: string;
}

let ctx: vscode.ExtensionContext;
let store: ConnectionStore;
let active: Conn | undefined;
/** Open sessions by pool key — connecting to another server/database keeps existing ones alive. */
const conns = new Map<string, Conn>();
/** SQL editor tab (document uri) → the connection its queries run on. */
const tabConns = new Map<string, Conn>();
let completionApi: CompletionApi;
let semanticApi: SemanticApi;
let connectionBar: ConnectionBarApi;
const treeChanged = new vscode.EventEmitter<TreeNode | undefined | void>();

function connKey(meta: ConnectionMeta): string {
  return `${meta.id}\0${meta.database ?? ''}`;
}

/** An open session for this connection id — the active one when it matches, else any. */
function connFor(id: string): Conn | undefined {
  if (active?.session.meta.id === id) return active;
  for (const c of conns.values()) if (c.session.meta.id === id) return c;
  return undefined;
}

/** The connection the active editor's tab is bound to, falling back to the shared active one. */
function editorConn(): Conn | undefined {
  const doc = vscode.window.activeTextEditor?.document;
  return (doc && tabConns.get(doc.uri.toString())) ?? active;
}

export function activate(context: vscode.ExtensionContext): void {
  ctx = context;
  store = new ConnectionStore(context);
  ResultsPanel.init(context);
  ResultsView.register(context);

  context.subscriptions.push(treeChanged);

  // Per-tab connection bar (CodeLens + env-color line tint) in every SQL editor.
  connectionBar = registerConnectionBar(context, (doc) => {
    const conn = tabConns.get(doc.uri.toString());
    const c = conn ?? active;
    if (!c) return undefined;
    const meta = c.session.meta;
    return {
      name: meta.name,
      user: meta.user,
      database: c.currentDb ?? meta.database,
      color: meta.color,
      bound: !!conn,
    };
  });
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => tabConns.delete(doc.uri.toString()))
  );

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('dbtool.connections', treeProvider),
    vscode.commands.registerCommand('dbtool.addConnection', () => openForm(undefined)),
    vscode.commands.registerCommand('dbtool.editConnection', (item?: TreeArg) => editConnection(item)),
    vscode.commands.registerCommand('dbtool.connect', (item?: TreeArg) => connect(item)),
    vscode.commands.registerCommand('dbtool.disconnect', () => disconnect()),
    vscode.commands.registerCommand('dbtool.removeConnection', (item?: TreeArg) => removeConnection(item)),
    vscode.commands.registerCommand('dbtool.newQuery', (item?: TreeArg) => newQuery(item)),
    vscode.commands.registerCommand('dbtool.tabConnection', (uri?: vscode.Uri) => pickTabConnection(uri)),
    vscode.commands.registerCommand('dbtool.runQuery', () => runQuery()),
    vscode.commands.registerCommand('dbtool.explainQuery', () => explainQuery()),
    vscode.commands.registerCommand('dbtool.queryBuilder', () => openQueryBuilder()),
    vscode.commands.registerCommand('dbtool.searchObjects', () => searchObjects()),
    vscode.commands.registerCommand('dbtool.peekTable', (n?: TreeNode) => peekTable(n)),
    vscode.commands.registerCommand('dbtool.viewRoutine', (n?: TreeNode) => viewRoutine(n)),
    vscode.commands.registerCommand('dbtool.execRoutine', (n?: TreeNode) => execRoutine(n)),
    vscode.commands.registerCommand('dbtool.createObject', () => createObject()),
    vscode.commands.registerCommand('dbtool.switchDatabase', (n?: TreeNode) => switchDatabase(n)),
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

  // Language features follow the active editor's tab connection.
  completionApi = registerCompletions(
    context,
    () => editorConn()?.session.meta.kind,
    () => editorConn()?.catalog,
    () => {
      const c = editorConn();
      return { names: c?.databases ?? [], current: c?.currentDb ?? c?.session.meta.database };
    }
  );
  semanticApi = registerSemanticTokens(context, () => editorConn()?.catalog);
  registerSignatureHelp(context, () => editorConn()?.session.meta.kind, () => editorConn()?.catalog);
  registerKeywordUppercase(context);
  // Switching tabs may switch catalogs — re-color and refresh the bar.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      semanticApi.refresh();
      connectionBar.refresh();
    })
  );
}

export async function deactivate(): Promise<void> {
  await Promise.all([...conns.values()].map((c) => c.session.dispose().catch(() => undefined)));
}

// ------------------------------------------------------------------ tree view

type TreeArg = string | { id?: string } | TreeNode | undefined;

type TreeNode =
  | { t: 'conn'; meta: ConnectionMeta }
  | { t: 'db'; name: string; current: boolean; conn: Conn }
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
      // connection → databases → tables / views / procedures / functions.
      // Every open connection lists its server's databases, catalog or not.
      const conn = connFor(el.meta.id);
      if (!conn) return [];
      const cur = conn.currentDb ?? conn.session.meta.database ?? '';
      const names = conn.databases.length ? conn.databases : [cur];
      return names.map((name): TreeNode => ({ t: 'db', name, current: name === cur, conn }));
    }
    if (el.t === 'db') {
      return el.current && el.conn.catalog ? schemaGroups(el.conn.catalog) : [];
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
      case 'db': {
        const meta = n.conn.session.meta;
        const item = new vscode.TreeItem(
          n.name || '(default database)',
          n.current ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
        );
        // The attached database wears the connection's environment color (a plain
        // green cylinder when it has none); databases with their own open session
        // are marked too, so a glance tells you where the queries are going.
        const openHere = !n.current && [...conns.values()].some(
          (c) => c.session.meta.id === meta.id && (c.currentDb ?? c.session.meta.database) === n.name
        );
        item.iconPath = n.current
          ? safeColor(meta.color)
            ? await connectionIcon(ctx, meta.color, 'db')
            : new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.green'))
          : openHere
            ? new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.blue'))
            : new vscode.ThemeIcon('database');
        item.description = n.current ? '✓ current' : openHere ? 'open' : undefined;
        item.contextValue = n.current ? 'databaseCurrent' : 'database';
        // Only host/user connections can re-attach; a connection string is fixed.
        const switchable = !n.current && meta.mode === 'fields';
        item.tooltip = n.current
          ? `${n.name} — connected database on "${meta.name}"`
          : switchable
            ? `${n.name} — click to switch to this database`
            : `${n.name} — on "${meta.name}"; switching needs a host/user connection`;
        if (switchable) {
          item.command = { command: 'dbtool.switchDatabase', title: 'Switch Database', arguments: [n] };
        }
        return item;
      }
      case 'grp': {
        const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon(n.icon);
        item.description = String(n.children.length);
        return item;
      }
      case 'table': {
        // SSMS-style schema-qualified label: approval.ApprovalApplicationHistory
        const item = new vscode.TreeItem(
          `${n.table.schema}.${n.table.name}`,
          vscode.TreeItemCollapsibleState.Collapsed
        );
        item.iconPath = new vscode.ThemeIcon(n.table.isView ? 'window' : 'table');
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
        const item = new vscode.TreeItem(`${r.schema}.${r.name}`, vscode.TreeItemCollapsibleState.None);
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
  const isActive = active?.session.meta.id === c.id;
  const isOpen = !!connFor(c.id);
  const item = new vscode.TreeItem(
    c.name,
    // Open connections expand into their databases; the current one starts open.
    isActive
      ? vscode.TreeItemCollapsibleState.Expanded
      : isOpen
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
  );
  item.id = c.id;
  item.description = kindLabel(c.kind) + (isActive ? ' • current' : isOpen ? ' • connected' : '');
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

function refreshUi(): void {
  treeChanged.fire();
  connectionBar.refresh();
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
  const connected = new Set([...conns.values()].map((c) => c.session.meta.id));
  const items: Item[] = list.map((c) => ({
    label: `$(database) ${c.name}`,
    description: kindLabel(c.kind) + (connected.has(c.id) ? ' • connected' : ''),
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

/** Open (or reuse) a pooled session for `meta`, kicking off catalog + database loads. */
async function openConn(meta: ConnectionMeta): Promise<Conn> {
  const key = connKey(meta);
  const existing = conns.get(key);
  if (existing) return existing;
  const secret = (await store.secret(meta.id)) ?? '';
  const t0 = performance.now();
  // Lazy driver load happens inside openSession — first connect pays it, activation never does.
  const { openSession } = await import('./drivers');
  const session = await openSession(meta, secret);
  const conn: Conn = { key, session, databases: [] };
  conns.set(key, conn);
  log(`Connected to ${meta.name} (${kindLabel(meta.kind)}) in ${(performance.now() - t0).toFixed(0)} ms`);
  // Instant completions from the disk cache, fresh catalog in the background.
  void loadCachedCatalog(ctx, catalogCacheKey(meta.id, meta.database)).then((cached) => {
    if (cached && conns.get(key) === conn && !conn.catalog) {
      conn.catalog = cached;
      log(`Schema cache hit for ${meta.name}: ${cached.tables.length} tables/views (refreshing in background)`);
      catalogUpdated(conn);
    }
  });
  void refreshCatalog(conn);
  void loadDatabases(conn);
  return conn;
}

async function connect(arg?: TreeArg): Promise<void> {
  const id = argId(arg);
  const meta = id ? store.get(id) : await pickConnection('Connect to…');
  if (!meta) return;
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Connecting to ${meta.name}…` },
      async () => {
        active = await openConn(meta);
      }
    );
    refreshUi();
    vscode.window.setStatusBarMessage(`$(check) Connected to ${meta.name}`, 3000);
  } catch (e) {
    log(`Connect failed for ${meta.name}: ${(e as Error)?.message ?? e}`);
    vscode.window.showErrorMessage(
      `DB Lite: failed to connect to "${meta.name}" — ${(e as Error)?.message ?? e}`
    );
  }
}

/** Everything that consumes the catalog gets notified about a new one. */
function catalogUpdated(conn: Conn): void {
  const cat = conn.catalog;
  if (cat) {
    // Prebuild completion items off the keystroke path.
    setTimeout(() => completionApi.prewarm(cat), 0);
  }
  semanticApi.refresh();
  treeChanged.fire();
  if (conn === active) QueryBuilderPanel.postCatalog(conn.catalog, conn.session.meta);
}

/**
 * Populate the database level of the tree: the database we're attached to plus
 * every other database on the server (fields-mode connections can switch to them).
 * Best-effort — missing permissions leave just the current database.
 */
async function loadDatabases(conn: Conn): Promise<void> {
  const session = conn.session;
  try {
    const cur = await scalar(session, currentDatabaseSql(session.meta.kind));
    conn.currentDb = cur != null ? String(cur) : session.meta.database;
  } catch {
    conn.currentDb = session.meta.database;
  }
  if (conns.get(conn.key) !== conn) return; // disconnected while loading
  // Every server database is listed (a connection string can only *show* them —
  // re-attaching still needs host/user fields), so the tree is the whole picture.
  try {
    const res = await session.run(listDatabasesSql(session.meta.kind));
    conn.databases = (res.sets.find((s) => s.rows.length)?.rows ?? []).map((r) => String(r[0]));
  } catch {
    conn.databases = [];
  }
  if (!conn.databases.length) conn.databases = conn.currentDb ? [conn.currentDb] : [];
  log(`Databases on ${session.meta.name}: ${conn.databases.length || 1} (current: ${conn.currentDb ?? '?'})`);
  refreshUi();
}

async function refreshCatalog(conn: Conn): Promise<void> {
  if (!vscode.workspace.getConfiguration('dbtool').get('schemaCompletion', true)) return;
  const t0 = performance.now();
  const session = conn.session;
  try {
    const cat = await loadCatalog(session);
    if (conns.get(conn.key) !== conn) return; // disconnected while loading
    conn.catalog = cat;
    log(
      `Schema loaded for ${session.meta.name}: ${cat.tables.length} tables/views, ` +
      `${cat.fks.length} foreign keys, ${cat.routines.length} routines in ${(performance.now() - t0).toFixed(0)} ms`
    );
    catalogUpdated(conn);
    void saveCatalogCache(ctx, catalogCacheKey(session.meta.id, session.meta.database), cat);
  } catch (e) {
    log(`Schema load failed for ${session.meta.name}: ${(e as Error)?.message ?? e}`);
  }
}

async function refreshSchema(): Promise<void> {
  const conn = active;
  if (!conn) {
    vscode.window.showWarningMessage('DB Lite: connect to a database first.');
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Refreshing schema of ${conn.session.meta.name}…` },
    () => refreshCatalog(conn)
  );
  if (conn.catalog && active === conn) {
    vscode.window.setStatusBarMessage(
      `$(check) Schema refreshed — ${conn.catalog.tables.length} tables/views`,
      3000
    );
  }
}

/** Close every open session (all connections, all tabs). */
async function disconnect(): Promise<void> {
  if (conns.size === 0) return;
  const names = [...new Set([...conns.values()].map((c) => c.session.meta.name))].join(', ');
  const open = [...conns.values()];
  conns.clear();
  tabConns.clear();
  active = undefined;
  await Promise.all(open.map((c) => c.session.dispose().catch(() => undefined)));
  log(`Disconnected from ${names}`);
  refreshUi();
  QueryBuilderPanel.postCatalog(undefined, undefined);
  vscode.window.setStatusBarMessage(`Disconnected from ${names}`, 3000);
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
  for (const [key, conn] of [...conns]) {
    if (conn.session.meta.id !== meta.id) continue;
    conns.delete(key);
    for (const [uri, c] of [...tabConns]) if (c === conn) tabConns.delete(uri);
    if (active === conn) active = undefined;
    void conn.session.dispose().catch(() => undefined);
  }
  await store.remove(meta.id);
  await deleteCatalogCache(ctx, meta.id);
  refreshUi();
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

/** New SQL tab. From a connection's context menu it is bound to that connection right away. */
async function newQuery(arg?: TreeArg): Promise<void> {
  const id = argId(arg);
  let conn = active;
  const meta = id ? store.get(id) : undefined;
  if (meta && meta.id !== active?.session.meta.id) {
    try {
      conn = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Connecting to ${meta.name}…` },
        () => openConn(meta)
      );
    } catch (e) {
      vscode.window.showErrorMessage(`DB Lite: failed to connect to "${meta.name}" — ${(e as Error)?.message ?? e}`);
      return;
    }
  }
  const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: '' });
  if (conn) tabConns.set(doc.uri.toString(), conn);
  await vscode.window.showTextDocument(doc);
  connectionBar.refresh();
}

/** Bar click / command: bind the current SQL tab to a (possibly different) connection. */
async function pickTabConnection(uri?: vscode.Uri): Promise<void> {
  const doc =
    (uri && vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())) ??
    vscode.window.activeTextEditor?.document;
  if (!doc) return;
  const meta = await pickConnection('Use connection for this tab…');
  if (!meta) return;
  try {
    const conn = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Connecting to ${meta.name}…` },
      () => openConn(meta)
    );
    tabConns.set(doc.uri.toString(), conn);
    active ??= conn; // first connection also becomes the explorer's current one
    log(`Tab ${doc.uri.toString()} bound to ${meta.name}`);
    refreshUi();
  } catch (e) {
    vscode.window.showErrorMessage(`DB Lite: failed to connect to "${meta.name}" — ${(e as Error)?.message ?? e}`);
  }
}

async function ensureActive(): Promise<Conn | undefined> {
  if (!active) {
    await connect();
  }
  return active;
}

/** The connection a query in `doc` should run on — binds unbound tabs to the active one. */
async function connForDoc(doc: vscode.TextDocument): Promise<Conn | undefined> {
  const key = doc.uri.toString();
  const bound = tabConns.get(key);
  if (bound) return bound;
  const conn = await ensureActive();
  if (conn) {
    tabConns.set(key, conn);
    connectionBar.refresh();
  }
  return conn;
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
  const editor = vscode.window.activeTextEditor;
  const sql = editorSql();
  if (!sql || !editor) return;
  const conn = await connForDoc(editor.document);
  if (!conn) return;
  await runSqlText(sql, conn);
}

/** Where results render: SSMS-style grid in the bottom panel, terminal text, or an editor tab. */
function resultsLocation(): 'panel' | 'terminal' | 'grid' {
  const v = vscode.workspace.getConfiguration('dbtool').get<string>('resultsLocation', 'panel');
  return v === 'terminal' || v === 'grid' ? v : 'panel';
}

function showResults(meta: ConnectionMeta, outcome: QueryOutcome, maxRows: number): void {
  const loc = resultsLocation();
  if (loc === 'terminal') ResultsTerminal.showResults(meta, outcome, maxRows);
  else if (loc === 'grid') ResultsPanel.showResults(meta, outcome, maxRows);
  else ResultsView.showResults(meta, outcome, maxRows);
}

function showResultsError(meta: ConnectionMeta, error: unknown): void {
  const loc = resultsLocation();
  if (loc === 'terminal') ResultsTerminal.showError(meta, error);
  else if (loc === 'grid') ResultsPanel.showError(meta, error);
  else ResultsView.showError(meta, error);
}

async function runSqlText(sql: string, conn?: Conn): Promise<void> {
  const session = (conn ?? (await ensureActive()))?.session;
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
    showResults(session.meta, outcome, maxRows);
  } catch (e) {
    log(`Query on ${session.meta.name} FAILED: ${(e as Error)?.message ?? e} — ${sqlPreview(sql)}`);
    showResultsError(session.meta, e);
  } finally {
    stop();
  }
}

/** Run with actual execution plan: EXPLAIN ANALYZE (pg) / STATISTICS XML (mssql). */
async function explainQuery(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const sql = editorSql();
  if (!sql || !editor) return;
  const session = (await connForDoc(editor.document))?.session;
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
  const conn = active;
  if (!t || !conn) return;
  await runSqlText(peekSql(t, conn.session.meta.kind, 100), conn);
}

async function viewRoutine(n?: TreeNode, routine?: CatalogRoutine): Promise<void> {
  const r = routine ?? nodeRoutine(n);
  const session = active?.session;
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
    await openSqlEditor(content);
  } catch (e) {
    vscode.window.showErrorMessage(`DB Lite: failed to load definition — ${(e as Error)?.message ?? e}`);
  } finally {
    stop();
  }
}

async function execRoutine(n?: TreeNode, routine?: CatalogRoutine): Promise<void> {
  const r = routine ?? nodeRoutine(n);
  const session = active?.session;
  if (!r || !session) return;
  await openSqlEditor(execTemplate(r, session.meta.kind) + '\n');
}

/** Fuzzy quick-pick over every table / view / procedure / function. */
async function searchObjects(): Promise<void> {
  const cat = active?.catalog;
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
  QueryBuilderPanel.open(ctx, () => active?.catalog, () => active?.session.meta, (sql) => void runSqlText(sql));
}

// ------------------------------------------------------- object management

/** Open a generated SQL script in a new tab, bound to the active connection. */
async function openSqlEditor(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ language: 'sql', content });
  if (active) tabConns.set(doc.uri.toString(), active);
  await vscode.window.showTextDocument(doc);
  connectionBar.refresh();
}

/** Resolve a table from a tree node, or let the user pick one. */
async function resolveTable(n?: TreeNode): Promise<CatalogTable | undefined> {
  const fromNode = nodeTable(n);
  if (fromNode) return fromNode;
  const cat = active?.catalog;
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
  const cat = active?.catalog;
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
    const conn = [...conns.values()].find((c) => c.session === session);
    if (conn) void refreshCatalog(conn);
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
  const session = active?.session;
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
  const session = active?.session;
  const cat = active?.catalog;
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
  const session = active?.session;
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
  const session = active?.session;
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
  const session = active?.session;
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
  const session = active?.session;
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
  const kind = active?.session.meta.kind ?? 'postgres';
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
  const session = (await ensureActive())?.session;
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

/** Attach the explorer to another database of the current fields-mode connection. */
async function switchDatabase(n?: TreeNode): Promise<void> {
  // Clicked straight on a database node — switch on that node's connection,
  // which is not necessarily the explorer's current one.
  const node = n && typeof n === 'object' && 't' in n && n.t === 'db' ? n : undefined;
  const conn = node?.conn ?? (await ensureActive());
  const session = conn?.session;
  if (!conn || !session) return;
  if (session.meta.mode === 'string') {
    vscode.window.showWarningMessage(
      'DB Lite: switching databases is only supported for host/user connections — edit the connection string instead.'
    );
    return;
  }
  const attached = conn.currentDb ?? session.meta.database;
  // A tree node already names the target — no picker needed.
  let target = node?.name;
  if (!target) {
    let names: string[];
    try {
      const res = await session.run(listDatabasesSql(session.meta.kind));
      names = (res.sets.find((s) => s.rows.length)?.rows ?? []).map((r) => String(r[0]));
    } catch (e) {
      vscode.window.showErrorMessage(`DB Lite: could not list databases — ${(e as Error)?.message ?? e}`);
      return;
    }
    const picked = await vscode.window.showQuickPick(
      names.map((name) => ({
        label: `$(database) ${name}`,
        description: name === attached ? 'current' : undefined,
        name,
      })),
      { placeHolder: `Switch database on ${session.meta.name}…` }
    );
    target = picked?.name;
  }
  if (!target || target === attached) return;
  const meta: ConnectionMeta = { ...session.meta, database: target };
  try {
    // A separate pooled session per database — tabs bound to the old one keep working.
    active = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Switching to ${target}…` },
      () => openConn(meta)
    );
    log(`Switched to database ${target} on ${meta.name}`);
    refreshUi();
  } catch (e) {
    vscode.window.showErrorMessage(`DB Lite: failed to switch database — ${(e as Error)?.message ?? e}`);
  }
}
