import * as vscode from 'vscode';
import { ConnectionStore } from './store';
import { ConnectionMeta, DbKind } from './types';
import { paletteCss, safeColor } from './theme';
import { connectionIcon } from './colorIcons';

interface FormData {
  name: string;
  kind: DbKind;
  mode: 'fields' | 'string';
  host: string;
  port: string;
  database: string;
  user: string;
  ssl: 'disable' | 'verify' | 'no-verify';
  enc: 'trust' | 'verify' | 'none';
  color: string;
  timeoutSec: string;
  secret: string;
}

/**
 * Every supported engine in one data-driven list: the searchable type dropdown,
 * default ports, logos and connection-string examples all render from here —
 * adding a new database type in the future is one new entry.
 */
interface DbTypeDef {
  kind: DbKind;
  label: string;
  port: number;
  /** inline SVG badge shown beside the name (CSP allows no external images) */
  logo: string;
  csExample: string;
}

const logoBadge = (bg: string, text: string, size: number): string =>
  `<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">` +
  `<rect width="20" height="20" rx="4" fill="${bg}"/>` +
  `<text x="10" y="${size >= 9 ? 14 : 13.5}" text-anchor="middle" font-family="sans-serif" ` +
  `font-size="${size}" font-weight="700" fill="#fff">${text}</text></svg>`;

const DB_TYPES: DbTypeDef[] = [
  {
    kind: 'postgres',
    label: 'PostgreSQL',
    port: 5432,
    logo: logoBadge('#336791', 'Pg', 9),
    csExample: 'postgres://user:password@host:5432/dbname?sslmode=require',
  },
  {
    kind: 'mssql',
    label: 'Microsoft SQL Server',
    port: 1433,
    logo: logoBadge('#CC2927', 'SQL', 7),
    csExample: 'Server=host,1433;Database=db;User Id=sa;Password=...;Encrypt=true;TrustServerCertificate=true',
  },
];

/**
 * Add/Edit Connection opens as a proper editor tab (webview form) instead of
 * a chain of quick inputs. Saved secrets are NEVER sent into the webview —
 * an empty password field on edit means "keep the stored one".
 */
export class ConnectionFormPanel {
  private static panel: vscode.WebviewPanel | undefined;
  private static existing: ConnectionMeta | undefined;
  private static store: ConnectionStore;

  static async open(
    ctx: vscode.ExtensionContext,
    store: ConnectionStore,
    existing: ConnectionMeta | undefined,
    onSaved: (meta: ConnectionMeta) => void
  ): Promise<void> {
    this.existing = existing;
    this.store = store;
    const title = existing ? `Edit — ${existing.name}` : 'New Connection';
    const hasSecret = existing ? (await store.secret(existing.id)) !== undefined : false;

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'dbtool.connectionForm',
        title,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.onDidDispose(() => (this.panel = undefined));
      this.panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg?.type === 'cancel') {
          this.panel?.dispose();
          return;
        }
        if (msg?.type === 'save' || msg?.type === 'test') {
          const d = msg.data as FormData;
          const meta = this.buildMeta(d);
          if (!meta) return; // buildMeta posted the validation error
          const secret = await this.resolveSecret(store, d.secret);
          if (msg.type === 'test') {
            await this.testConnection(meta, secret ?? '');
          } else {
            await store.save(meta, secret);
            onSaved(meta);
            this.panel?.dispose();
            const action = await vscode.window.showInformationMessage(
              `Connection "${meta.name}" saved.`,
              'Connect now'
            );
            if (action === 'Connect now') {
              vscode.commands.executeCommand('dbtool.connect', meta.id);
            }
          }
        }
      });
    } else {
      this.panel.title = title;
      this.panel.reveal(vscode.ViewColumn.Active);
    }

    const icon = await connectionIcon(ctx, existing?.color, 'dot');
    this.panel.iconPath = icon instanceof vscode.ThemeIcon ? undefined : icon;
    this.panel.webview.html = html(this.panel.webview, existing, hasSecret);
  }

  private static buildMeta(d: FormData): ConnectionMeta | undefined {
    const fail = (message: string, field?: string) => {
      this.panel?.webview.postMessage({ type: 'status', ok: false, message, field });
      return undefined;
    };
    if (!d.name?.trim()) return fail('Name is required.', 'name');
    const timeoutSec = Math.min(600, Math.max(1, parseInt(d.timeoutSec, 10) || 10));
    const meta: ConnectionMeta = {
      id: this.existing?.id ?? (require('crypto').randomUUID() as string),
      name: d.name.trim(),
      kind: DB_TYPES.some((t) => t.kind === d.kind) ? d.kind : 'postgres',
      mode: d.mode === 'string' ? 'string' : 'fields',
      color: safeColor(d.color),
      timeoutSec,
    };
    if (meta.mode === 'fields') {
      if (!d.host?.trim()) return fail('Host is required.', 'host');
      const port = parseInt(d.port, 10);
      if (!port) return fail('Port must be a number.', 'port');
      meta.host = d.host.trim();
      meta.port = port;
      meta.database = d.database?.trim() || undefined;
      meta.user = d.user?.trim() || undefined;
      if (meta.kind === 'postgres') {
        meta.ssl = d.ssl;
      } else {
        meta.encrypt = d.enc !== 'none';
        meta.trustCert = d.enc === 'trust';
      }
    } else if (!d.secret && !this.existing) {
      return fail('Connection string is required.', 'connString');
    }
    return meta;
  }

  /** Empty input while editing = keep the stored secret (return undefined = don't overwrite). */
  private static async resolveSecret(
    store: ConnectionStore,
    typed: string
  ): Promise<string | undefined> {
    if (typed) return typed;
    if (this.existing) return undefined;
    return '';
  }

  private static async testConnection(meta: ConnectionMeta, secret: string): Promise<void> {
    const post = (ok: boolean, message: string) =>
      this.panel?.webview.postMessage({ type: 'status', ok, message });
    post(true, 'Connecting…');
    try {
      // On test, an empty secret while editing means "use the stored one".
      let effective = secret;
      if (!secret && this.existing) {
        effective = (await this.store.secret(this.existing.id)) ?? '';
      }
      const t0 = performance.now();
      const { openSession } = await import('./drivers');
      const session = await openSession(meta, effective);
      await session.dispose();
      post(true, `✓ Connected in ${(performance.now() - t0).toFixed(0)} ms`);
    } catch (e) {
      post(false, `✗ ${(e as Error)?.message ?? e}`);
    }
  }
}

// ------------------------------------------------------------------- template

const SWATCHES: [string, string][] = [
  ['#d13438', 'Production'],
  ['#ca5010', 'Staging'],
  ['#c19c00', 'QA'],
  ['#107c10', 'Development'],
  ['#0078d4', 'Local'],
  ['#881798', 'Other'],
];

function html(
  webview: vscode.Webview,
  existing: ConnectionMeta | undefined,
  hasSecret: boolean
): string {
  const nonce = require('crypto').randomBytes(16).toString('hex');
  const init = {
    name: existing?.name ?? '',
    kind: existing?.kind ?? 'postgres',
    mode: existing?.mode ?? 'fields',
    host: existing?.host ?? 'localhost',
    port: existing?.port ?? (existing?.kind === 'mssql' ? 1433 : 5432),
    database: existing?.database ?? '',
    user: existing?.user ?? '',
    ssl: existing?.ssl ?? 'disable',
    enc: existing?.encrypt === false ? 'none' : existing?.trustCert ? 'trust' : existing ? 'verify' : 'trust',
    color: existing?.color ?? '',
    timeoutSec: existing?.timeoutSec ?? 10,
    hasSecret,
    editing: !!existing,
  };
  const initJson = JSON.stringify(init).replace(/</g, '\\u003c');
  const typesJson = JSON.stringify(DB_TYPES).replace(/</g, '\\u003c');
  const swatches = SWATCHES.map(
    ([hex, label]) =>
      `<button type="button" class="swatch" data-color="${hex}" title="${label}" style="background:${hex}"></button>`
  ).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
${paletteCss()}
body { font-family: var(--vscode-font-family, sans-serif); font-size: 13px; max-width: 560px; margin: 0 auto; padding: 16px 20px 40px; }
h1 { font-size: 16px; font-weight: 600; margin: 6px 0 16px; }
label { display: block; margin: 12px 0 4px; opacity: .9; }
input[type=text], input[type=password], input[type=number], select {
  width: 100%; box-sizing: border-box; padding: 5px 8px; font-size: 13px;
  background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 2px; }
input:focus, select:focus { outline: 1px solid var(--accent); }
.row { display: flex; gap: 10px; } .row > div { flex: 1; }
.radios { display: flex; gap: 14px; margin: 4px 0; }
.radios label { display: inline-flex; align-items: center; gap: 5px; margin: 0; cursor: pointer; }
.swatch { width: 26px; height: 26px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
.swatch.selected { border-color: var(--fg); box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--fg); }
.swatch-row { display: flex; gap: 10px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
.swatch-row .none { width: auto; height: 26px; border-radius: 13px; background: transparent; border: 1px solid var(--border); color: var(--fg); padding: 0 10px; cursor: pointer; }
.swatch-row .none.selected { border-color: var(--fg); }
input[type=color] { width: 34px; height: 28px; padding: 0 2px; background: var(--input-bg); border: 1px solid var(--border); border-radius: 2px; cursor: pointer; }
.hint { opacity: .6; font-size: 12px; margin-top: 4px; }
.req { color: var(--error); font-weight: 700; margin-left: 2px; }
input.invalid, select.invalid { border-color: var(--error) !important; outline: 1px solid var(--error) !important; }
label.invalid-label { color: var(--error); opacity: 1; }
.actions { display: flex; gap: 10px; margin-top: 22px; align-items: center; }
button.primary, button.secondary { padding: 6px 16px; font-size: 13px; border: none; border-radius: 2px; cursor: pointer; }
button.primary { background: var(--accent); color: var(--accent-fg, #fff); }
button.secondary { background: var(--badge-bg); color: var(--badge-fg); }
#status { font-size: 12px; }
#status.err { color: var(--error); }
#status.ok { color: var(--fg); opacity: .8; }
fieldset { border: 1px solid var(--border); border-radius: 3px; margin: 14px 0 0; padding: 8px 12px 12px; }
legend { padding: 0 4px; opacity: .8; font-size: 12px; }
.hidden { display: none; }
/* -------- searchable database-type dropdown -------- */
.dd { position: relative; }
.dd-btn { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box;
  padding: 5px 8px; font-size: 13px; text-align: left; cursor: pointer;
  background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 2px; }
.dd-btn:focus { outline: 1px solid var(--accent); }
.dd-caret { margin-left: auto; opacity: .7; font-size: 10px; }
.dd-logo { display: inline-flex; width: 18px; height: 18px; flex: none; }
.dd-logo svg { width: 18px; height: 18px; }
.dd-panel { position: absolute; top: calc(100% + 2px); left: 0; right: 0; z-index: 10;
  background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 2px;
  box-shadow: 0 4px 12px rgba(0,0,0,.3); }
.dd-panel input { border: none; border-bottom: 1px solid var(--input-border); border-radius: 0; }
.dd-panel input:focus { outline: none; }
.dd-list { max-height: 220px; overflow-y: auto; }
.dd-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; cursor: pointer; }
.dd-item:hover, .dd-item.active { background: var(--accent); color: var(--accent-fg, #fff); }
.dd-item.selected::after { content: '✓'; margin-left: auto; opacity: .9; }
.dd-empty { padding: 8px; opacity: .6; font-size: 12px; }
</style></head><body>
<h1 id="title"></h1>
<div class="hint">Fields marked <span class="req">*</span> are required.</div>

<label for="name">Name<span class="req" title="Required">*</span></label>
<input type="text" id="name" placeholder="e.g. prod-postgres, local-mssql">

<label>Database type</label>
<div class="dd" id="kindDd">
  <button type="button" class="dd-btn" id="kindBtn" aria-haspopup="listbox" aria-expanded="false">
    <span class="dd-logo" id="kindLogo"></span><span id="kindLabel"></span><span class="dd-caret">▾</span>
  </button>
  <div class="dd-panel hidden" id="kindPanel">
    <input type="text" id="kindSearch" placeholder="Search database type…" autocomplete="off">
    <div class="dd-list" id="kindList" role="listbox"></div>
  </div>
</div>

<label>Environment color <span class="hint">(shown on the connection icon, tab icon & status bar — e.g. red = production)</span></label>
<div class="swatch-row">
  ${swatches}
  <input type="color" id="customColor" title="Custom color" value="#888888">
  <button type="button" class="none" id="noColor">None</button>
</div>

<div class="row">
  <div>
    <label>Connection timeout (seconds)</label>
    <input type="number" id="timeoutSec" min="1" max="600">
  </div>
</div>

<label>Connect using</label>
<div class="radios">
  <label><input type="radio" name="mode" value="fields"> Host &amp; credentials</label>
  <label><input type="radio" name="mode" value="string"> Connection string</label>
</div>

<fieldset id="fieldsSection"><legend>Server</legend>
  <div class="row">
    <div><label for="host">Host<span class="req" title="Required">*</span></label><input type="text" id="host"></div>
    <div style="max-width:110px"><label for="port">Port<span class="req" title="Required">*</span></label><input type="number" id="port"></div>
  </div>
  <label>Database</label><input type="text" id="database">
  <label>User</label><input type="text" id="user">
  <label>Password</label><input type="password" id="password" autocomplete="off">
  <div class="hint" id="pwHint">Stored in your OS keychain, never in settings files.</div>
  <div id="pgOptions">
    <label>SSL</label>
    <select id="ssl">
      <option value="disable">No SSL (local databases)</option>
      <option value="verify">SSL — verify certificate</option>
      <option value="no-verify">SSL — no verify (self-signed certs)</option>
    </select>
  </div>
  <div id="msOptions">
    <label>Encryption</label>
    <select id="enc">
      <option value="trust">Encrypt, trust server certificate (local / dev)</option>
      <option value="verify">Encrypt, verify certificate (Azure / production)</option>
      <option value="none">No encryption (legacy servers)</option>
    </select>
  </div>
</fieldset>

<fieldset id="stringSection"><legend>Connection string<span class="req" id="csReq" title="Required">*</span></legend>
  <input type="password" id="connString" autocomplete="off">
  <div class="hint" id="csHint"></div>
  <label style="margin-top:8px"><input type="checkbox" id="showCs"> Show connection string</label>
</fieldset>

<div class="actions">
  <button class="primary" id="save">Save</button>
  <button class="secondary" id="test">Test Connection</button>
  <button class="secondary" id="cancel">Cancel</button>
  <span id="status"></span>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const init = ${initJson};
const DB_TYPES = ${typesJson};
const $ = (id) => document.getElementById(id);

$('title').textContent = init.editing ? 'Edit Connection — ' + init.name : 'New Connection';
$('name').value = init.name;
$('host').value = init.host;
$('port').value = init.port;
$('database').value = init.database;
$('user').value = init.user;
$('ssl').value = init.ssl;
$('enc').value = init.enc;
$('timeoutSec').value = init.timeoutSec;
document.querySelector('input[name=mode][value=' + init.mode + ']').checked = true;
if (init.hasSecret) {
  $('password').placeholder = 'leave empty to keep the saved password';
  $('connString').placeholder = 'leave empty to keep the saved connection string';
}

// ------------------------------------------- searchable database-type dropdown
let selectedKind = DB_TYPES.some((t) => t.kind === init.kind) ? init.kind : DB_TYPES[0].kind;
const typeOf = (k) => DB_TYPES.find((t) => t.kind === k) || DB_TYPES[0];
let activeIdx = -1;

function paintKindButton() {
  const t = typeOf(selectedKind);
  $('kindLogo').innerHTML = t.logo;
  $('kindLabel').textContent = t.label;
}
function visibleTypes() {
  const q = $('kindSearch').value.trim().toLowerCase();
  return DB_TYPES.filter((t) => !q || t.label.toLowerCase().includes(q) || t.kind.includes(q));
}
function renderKindList() {
  const list = $('kindList');
  list.innerHTML = '';
  const types = visibleTypes();
  activeIdx = Math.min(activeIdx, types.length - 1);
  types.forEach((t, i) => {
    const el = document.createElement('div');
    el.className = 'dd-item' + (t.kind === selectedKind ? ' selected' : '') + (i === activeIdx ? ' active' : '');
    el.setAttribute('role', 'option');
    const logo = document.createElement('span');
    logo.className = 'dd-logo';
    logo.innerHTML = t.logo;
    const label = document.createElement('span');
    label.textContent = t.label;
    el.append(logo, label);
    el.addEventListener('click', () => chooseKind(t.kind));
    list.appendChild(el);
  });
  if (!types.length) {
    const el = document.createElement('div');
    el.className = 'dd-empty';
    el.textContent = 'No matching database type';
    list.appendChild(el);
  }
}
function openKindDd() {
  $('kindPanel').classList.remove('hidden');
  $('kindBtn').setAttribute('aria-expanded', 'true');
  $('kindSearch').value = '';
  activeIdx = -1;
  renderKindList();
  $('kindSearch').focus();
}
function closeKindDd() {
  $('kindPanel').classList.add('hidden');
  $('kindBtn').setAttribute('aria-expanded', 'false');
}
function chooseKind(k) {
  selectedKind = k;
  paintKindButton();
  closeKindDd();
  $('kindBtn').focus();
  refresh();
}
$('kindBtn').addEventListener('click', () => {
  $('kindPanel').classList.contains('hidden') ? openKindDd() : closeKindDd();
});
$('kindSearch').addEventListener('input', () => { activeIdx = -1; renderKindList(); });
$('kindSearch').addEventListener('keydown', (e) => {
  const types = visibleTypes();
  if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, types.length - 1); renderKindList(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); renderKindList(); }
  else if (e.key === 'Enter') { e.preventDefault(); const t = types[activeIdx] || types[0]; if (t) chooseKind(t.kind); }
  else if (e.key === 'Escape') { closeKindDd(); $('kindBtn').focus(); }
});
document.addEventListener('mousedown', (e) => {
  if (!$('kindDd').contains(e.target)) closeKindDd();
});
paintKindButton();

let color = init.color || '';
function paintSwatches() {
  document.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('selected', b.dataset.color === color));
  $('noColor').classList.toggle('selected', !color);
  if (color) $('customColor').value = color;
}
document.querySelectorAll('.swatch').forEach((b) =>
  b.addEventListener('click', () => { color = b.dataset.color; paintSwatches(); }));
$('customColor').addEventListener('input', () => { color = $('customColor').value; paintSwatches(); });
$('noColor').addEventListener('click', () => { color = ''; paintSwatches(); });
paintSwatches();

function kind() { return selectedKind; }
function mode() { return document.querySelector('input[name=mode]:checked').value; }
function refresh() {
  const k = kind(), m = mode(), t = typeOf(k);
  $('fieldsSection').classList.toggle('hidden', m !== 'fields');
  $('stringSection').classList.toggle('hidden', m !== 'string');
  $('pgOptions').classList.toggle('hidden', k !== 'postgres');
  $('msOptions').classList.toggle('hidden', k !== 'mssql');
  $('connString').placeholder = init.hasSecret ? $('connString').placeholder : t.csExample;
  $('csHint').textContent = 'Example: ' + t.csExample + ' — stored in your OS keychain.';
  // Untouched port (empty or another type's default) follows the selected type.
  const cur = Number($('port').value);
  const defaults = DB_TYPES.map((d) => d.port);
  if (!cur || (defaults.includes(cur) && cur !== t.port)) $('port').value = t.port;
}
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', refresh));
refresh();

$('showCs').addEventListener('change', () => { $('connString').type = $('showCs').checked ? 'text' : 'password'; });

function collect() {
  return {
    name: $('name').value, kind: kind(), mode: mode(),
    host: $('host').value, port: $('port').value, database: $('database').value, user: $('user').value,
    ssl: $('ssl').value, enc: $('enc').value, color, timeoutSec: $('timeoutSec').value,
    secret: mode() === 'string' ? $('connString').value.trim() : $('password').value,
  };
}
// ---------------------------------------------------- required-field checks
function markInvalid(id, bad) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle('invalid', bad);
  const label = document.querySelector('label[for=' + id + ']');
  if (label) label.classList.toggle('invalid-label', bad);
}
function requiredFields() {
  const req = ['name'];
  if (mode() === 'fields') req.push('host', 'port');
  else if (!init.hasSecret) req.push('connString');
  return req;
}
function validate() {
  let firstBad = null;
  for (const id of requiredFields()) {
    const bad = !$(id).value.trim();
    markInvalid(id, bad);
    if (bad && !firstBad) firstBad = $(id);
  }
  if (firstBad) {
    const s = $('status');
    s.textContent = 'Please fill in the required fields (*).';
    s.className = 'err';
    firstBad.focus();
    return false;
  }
  return true;
}
['name', 'host', 'port', 'connString'].forEach((id) =>
  $(id).addEventListener('input', () => { markInvalid(id, false); }));
$('csReq').style.display = init.hasSecret ? 'none' : '';

$('save').addEventListener('click', () => { if (validate()) vscode.postMessage({ type: 'save', data: collect() }); });
$('test').addEventListener('click', () => { if (validate()) vscode.postMessage({ type: 'test', data: collect() }); });
$('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'status') {
    const s = $('status');
    s.textContent = e.data.message;
    s.className = e.data.ok ? 'ok' : 'err';
    if (e.data.field) { markInvalid(e.data.field, true); $(e.data.field).focus(); }
  }
});
</script></body></html>`;
}
