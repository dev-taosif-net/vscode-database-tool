# DB Lite — fast, lightweight SQL for VS Code

A minimal database client for **PostgreSQL** and **Microsoft SQL Server**. Write SQL with built-in function suggestions, hit `Ctrl+Enter`, see results. Nothing else.

## Golden rule: super fast, super lightweight

- The extension bundles to a **single ~36 KB minified file**. Activation does almost nothing.
- Database drivers (`pg`, `mssql`) are **loaded lazily** — their code isn't even parsed until the moment you first connect.
- Results render in a script-free webview (plain HTML/CSS), with row rendering capped (`dbtool.maxRenderRows`, default 1000) so huge result sets never freeze the UI.
- Completion items are built once per dialect and cached — zero per-keystroke work.

## Features

- **Connect to PostgreSQL and SQL Server** — via host/port/user/password *or* a full connection string.
- **Connection editor tab** — Add/Edit Connection opens a proper form in an editor tab (not quick-input popups), with a **Test Connection** button.
- **Environment colors** — give each connection a color (red = production, green = dev, …). The color appears on the connection's tree icon, the results/editor **tab icon**, the **status bar**, and as a banner in the results panel. (VS Code doesn't let extensions recolor the tab itself.)
- **Per-connection timeout** — configurable connect timeout in seconds (default 10).
- **Secure storage** — passwords and connection strings go into VS Code SecretStorage (your OS keychain: libsecret / macOS Keychain / Windows Credential Manager). Only non-secret metadata (host, port, names) is kept in extension state. Secrets are never sent into the form webview.
- **SQL editing with IntelliSense** — ~250 curated built-in functions with signatures and one-line docs (aggregates, string, math, date/time, JSON, window functions, system) plus SQL keywords. Suggestions adapt to the dialect of the active connection.
- **Auto-UPPERCASE keywords** — type `select ` and it becomes `SELECT ` (toggle: `dbtool.autoUppercaseKeywords`).
- **Auto table aliases** — after `FROM order_details ` DB Lite suggests `od` (toggle: `dbtool.autoAlias`).
- **Run queries** — `Ctrl+Enter` (or `Cmd+Enter`) runs the selection, or the whole file if nothing is selected. Multiple statements and multiple result sets are supported; T-SQL `GO` batch separators work.
- **Results panel** — row counts, execution time, sticky headers, NULL styling, error details.
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
| `DB Lite: Clear All Data` | Delete every connection + credential (confirmation required) |

## Building from source

```bash
npm install
npm run build          # bundle to dist/extension.js
npm run typecheck      # tsc --noEmit
npx @vscode/vsce package --allow-missing-repository   # produce .vsix
```

Install the generated `.vsix` via *Extensions → ⋯ → Install from VSIX*, or press `F5` in VS Code to launch an Extension Development Host.

## Roadmap ideas

- Schema-aware completion (table/column names)
- Query cancellation
- Export results to CSV/JSON
- More engines (MySQL, SQLite)
