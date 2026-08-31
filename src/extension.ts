import * as vscode from 'vscode';
import { ConnectionStore } from './store';
import { ConnectionMeta, DbKind, DbSession } from './types';
import { registerCompletions } from './completion';
import { registerKeywordUppercase } from './keywordCase';
import { ResultsPanel } from './resultsPanel';
import { ConnectionFormPanel } from './connectionForm';
import { connectionIcon, clearIcons } from './colorIcons';
import { safeColor } from './theme';

let ctx: vscode.ExtensionContext;
let store: ConnectionStore;
let active: DbSession | undefined;
let statusItem: vscode.StatusBarItem;
const treeChanged = new vscode.EventEmitter<void>();

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
    vscode.commands.registerCommand('dbtool.clearAllData', () => clearAllData())
  );

  registerCompletions(context, () => active?.meta.kind);
  registerKeywordUppercase(context);
}

export async function deactivate(): Promise<void> {
  await active?.dispose().catch(() => undefined);
}

// ------------------------------------------------------------------ tree view

type TreeArg = string | { id?: string } | undefined;

const treeProvider: vscode.TreeDataProvider<ConnectionMeta> = {
  onDidChangeTreeData: treeChanged.event,
  getChildren: (el) =>
    el ? [] : store.list().sort((a, b) => a.name.localeCompare(b.name)),
  getTreeItem: async (c) => {
    const isActive = active?.meta.id === c.id;
    const item = new vscode.TreeItem(c.name);
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
    item.command = { command: 'dbtool.connect', title: 'Connect', arguments: [c.id] };
    return item;
  },
};

function kindLabel(kind: DbKind): string {
  return kind === 'postgres' ? 'PostgreSQL' : 'SQL Server';
}

function updateStatus(): void {
  if (active) {
    statusItem.text = `$(database) ${active.meta.name}`;
    statusItem.tooltip = `DB Lite — connected to ${active.meta.name} (${kindLabel(active.meta.kind)}). Click to switch.`;
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

// ------------------------------------------------------------ connect / picks

function argId(arg: TreeArg): string | undefined {
  return typeof arg === 'string' ? arg : arg?.id;
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
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Connecting to ${meta.name}…` },
      async () => {
        // Lazy driver load happens inside openSession — first connect pays it, activation never does.
        const { openSession } = await import('./drivers');
        const next = await openSession(meta, secret);
        await active?.dispose().catch(() => undefined);
        active = next;
      }
    );
    refreshUi();
    vscode.window.setStatusBarMessage(`$(check) Connected to ${meta.name}`, 3000);
  } catch (e) {
    vscode.window.showErrorMessage(
      `DB Lite: failed to connect to "${meta.name}" — ${(e as Error)?.message ?? e}`
    );
  }
}

async function disconnect(): Promise<void> {
  if (!active) return;
  const name = active.meta.name;
  await active.dispose().catch(() => undefined);
  active = undefined;
  refreshUi();
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

async function runQuery(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('DB Lite: open a SQL file to run a query.');
    return;
  }
  const sel = editor.selection;
  const sql = (sel.isEmpty ? editor.document.getText() : editor.document.getText(sel)).trim();
  if (!sql) {
    vscode.window.showWarningMessage('DB Lite: nothing to run — the file/selection is empty.');
    return;
  }
  if (!active) {
    await connect();
    if (!active) return;
  }
  const session: DbSession = active;
  const maxRows = vscode.workspace.getConfiguration('dbtool').get<number>('maxRenderRows', 1000);
  try {
    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Running on ${session.meta.name}…` },
      () => session.run(sql)
    );
    ResultsPanel.showResults(session.meta, outcome, maxRows);
  } catch (e) {
    ResultsPanel.showError(session.meta, e);
  }
}
