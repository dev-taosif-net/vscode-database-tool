# DB Lite — fast, lightweight SQL for VS Code

A minimal database client for **PostgreSQL** and **Microsoft SQL Server**. Write SQL with built-in function suggestions, hit `Ctrl+Enter`, see results. Nothing else.

## Golden rule: super fast, super lightweight

- The extension bundles to a **single ~65 KB minified file**. Activation does almost nothing.
- Database drivers (`pg`, `mssql`) are **loaded lazily** — their code isn't even parsed until the moment you first connect.
- Results render as plain HTML/CSS plus one tiny inline script (cell selection + aggregates), with row rendering capped (`dbtool.maxRenderRows`, default 1000) so huge result sets never freeze the UI.
- Completion items are built once per dialect and cached; schema metadata loads once in the background after connect — per-keystroke work is a couple of regexes and map lookups.

## Features

- **Connect to PostgreSQL and SQL Server** — via host/port/user/password *or* a full connection string.
- **Connection editor tab** — Add/Edit Connection opens a proper form in an editor tab (not quick-input popups), with a **Test Connection** button.
- **Environment colors** — give each connection a color (red = production, green = dev, …). The color appears on the connection's tree icon, the results/editor **tab icon**, the **status bar**, and as a banner in the results panel. (VS Code doesn't let extensions recolor the tab itself.)
- **Per-connection timeout** — configurable connect timeout in seconds (default 10).
- **Secure storage** — passwords and connection strings go into VS Code SecretStorage (your OS keychain: libsecret / macOS Keychain / Windows Credential Manager). Only non-secret metadata (host, port, names) is kept in extension state. Secrets are never sent into the form webview.
- **SQL editing with IntelliSense** — ~250 curated built-in functions with signatures and one-line docs (aggregates, string, math, date/time, JSON, window functions, system) plus SQL keywords. Suggestions adapt to the dialect of the active connection.
- **Context-aware completion** — after connecting, DB Lite loads the schema in the background: table names after `FROM` / `JOIN` / `INSERT INTO` / `UPDATE`, column names after `alias.` / `table.` / `schema.`, and columns of the tables referenced in the current statement (toggle: `dbtool.schemaCompletion`; refresh with `DB Lite: Refresh Schema`).
- **JOIN auto-generation** — foreign keys drive JOIN suggestions: after `JOIN ` you get complete clauses like `customers c ON c.id = o.customer_id` for every FK-related table; after `JOIN x ` or `… ON ` the matching condition is suggested (toggle: `dbtool.smartJoins`).
- **Auto-UPPERCASE keywords** — type `select ` and it becomes `SELECT ` (toggle: `dbtool.autoUppercaseKeywords`).
- **Auto table aliases** — after `FROM order_details ` DB Lite suggests `od` (toggle: `dbtool.autoAlias`).
- **Run queries** — `Ctrl+Enter` (or `Cmd+Enter`) runs the selection (multi-cursor selections run in order), or the whole file if nothing is selected. Multiple statements and multiple result sets are supported; T-SQL `GO` batch separators work.
- **Results panel** — row counts, execution time, sticky headers, NULL styling, error details.
- **Grid aggregates** — click/drag cells in the results grid (headers select a column, row numbers a row; Ctrl/Cmd-click toggles, Shift-click extends) and a footer shows **Count · Distinct · Sum · Avg · Min · Max** over the selection. `Ctrl+C` copies selected cells as TSV; `Escape` clears.
- **Debug logging** — `DB Lite: Show Logs` opens an output channel with connection, query, and schema-load timings and failures.
- **Panel theme** — `dbtool.theme`: follow VS Code (`default`), or force `dark`/`light` for DB Lite panels.
- **Connections view** — a DB Lite icon in the activity bar lists saved connections; click to connect, right-click to edit/remove.
- **Clear all data** — `DB Lite: Clear All Data` command wipes every connection and stored credential (with confirmation).
- **SSL/encryption options** — Postgres `disable`/`verify`/`no-verify`, SQL Server encrypt + trust-server-certificate for local dev or Azure.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `dbtool.theme` | `default` | Theme for DB Lite panels: follow VS Code, or force dark/light |
| `dbtool.autoUppercaseKeywords` | `true` | UPPERCASE keywords as you type |
| `dbtool.autoAlias` | `true` | Suggest table aliases after FROM/JOIN |
| `dbtool.schemaCompletion` | `true` | Load schema metadata after connect for context-aware completion |
| `dbtool.smartJoins` | `true` | Generate JOIN/ON clauses from foreign keys |
| `dbtool.maxRenderRows` | `1000` | Rows rendered per result set |

## Getting started

1. Click the **DB Lite** database icon in the activity bar → **Add Connection** (or run `DB Lite: Add Connection` from the command palette).
2. Pick PostgreSQL or SQL Server, then either paste a connection string or enter host/credentials.
   - Postgres string example: `postgres://user:password@host:5432/dbname?sslmode=require`
   - SQL Server string example: `Server=host,1433;Database=db;User Id=sa;Password=...;Encrypt=true;TrustServerCertificate=true`
3. **Connect now**, open a `.sql` file (or `DB Lite: New SQL Query`, `Ctrl+Alt+N`), write SQL, press **`Ctrl+Enter`**.

The status bar shows the active connection; click it to switch.

## Commands

| Command | What it does |
| --- | --- |
| `DB Lite: Add Connection` | Wizard to save a new connection |
| `DB Lite: Connect` | Pick a saved connection and connect |
| `DB Lite: Disconnect` | Close the active connection |
| `DB Lite: New SQL Query` | Open an untitled SQL editor (`Ctrl+Alt+N`) |
| `DB Lite: Run Query` | Run selection / whole file (`Ctrl+Enter`) |
| `DB Lite: Edit / Remove Connection` | Manage saved connections |
| `DB Lite: Refresh Schema` | Re-load table/column/FK metadata for completions |
| `DB Lite: Show Logs` | Open the DB Lite output channel (connection/query/schema timings) |
| `DB Lite: Clear All Data` | Delete every connection + credential (confirmation required) |

## Building from source

```bash
npm install
npm run build          # bundle to dist/extension.js (minified)
npm run build:dev      # unminified + inline sourcemaps (for debugging)
npm run watch          # rebuild on change
npm run typecheck      # tsc --noEmit
npx @vscode/vsce package --allow-missing-repository   # produce .vsix
```

Install the generated `.vsix` via *Extensions → ⋯ → Install from VSIX*.

### Debugging the extension

Press `F5` (the **Run Extension** launch config) — it builds a dev bundle with sourcemaps and starts an Extension Development Host where breakpoints in `src/*.ts` work. At runtime, `DB Lite: Show Logs` shows what the extension is doing (connections, query timings, schema loads, failures).

## Roadmap ideas

- Query cancellation
- Export results to CSV/JSON
- More engines (MySQL, SQLite)
