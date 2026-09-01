# DB Lite — fast, lightweight SQL for VS Code

A minimal database client for **PostgreSQL** and **Microsoft SQL Server**. Write SQL with built-in function suggestions, hit `Ctrl+Enter`, see results. Nothing else.

## Golden rule: super fast, super lightweight

- The extension bundles to a **single ~110 KB minified file**. Activation does almost nothing.
- Database drivers (`pg`, `mssql`) are **loaded lazily** — their code isn't even parsed until the moment you first connect.
- Results render as plain HTML/CSS plus one tiny inline script (cell selection + aggregates), with row rendering capped (`dbtool.maxRenderRows`, default 1000) so huge result sets never freeze the UI.
- **Zero-lag completion**: the schema catalog is cached on disk per connection, so table/column/procedure suggestions are available the instant you connect (a fresh catalog loads in the background and swaps in). All completion items are prebuilt off the keystroke path — a keystroke costs a couple of regexes and map lookups.

## Features

- **Connect to PostgreSQL and SQL Server** — via host/port/user/password *or* a full connection string.
- **Connection editor tab** — Add/Edit Connection opens a proper form in an editor tab (not quick-input popups), with a **Test Connection** button. Mandatory fields (Name, Host, Port — or the connection string) are marked with a red `*` and highlighted in red if left empty on Save/Test.
- **Environment colors** — give each connection a color (red = production, green = dev, …). The color appears on the connection's tree icon, the results/editor **tab icon**, the **status bar**, the **connection bar and footer** of every SQL script, and as a banner in the results panel. (VS Code doesn't let extensions recolor the tab itself.)
- **Per-connection timeout** — configurable connect timeout in seconds (default 10).
- **Secure storage** — passwords and connection strings go into VS Code SecretStorage (your OS keychain: libsecret / macOS Keychain / Windows Credential Manager). Only non-secret metadata (host, port, names) is kept in extension state. Secrets are never sent into the form webview.
- **SQL editing with IntelliSense** — ~250 curated built-in functions, each with its **signature, parameters, return type, and a one-line explanation** (`count(expression) → bigint`), plus SQL keywords. Stored procedures/functions show their parameter list and return type too. Suggestions adapt to the dialect of the active connection.
- **Parameter hints (signature help)** — inside any call, `(` or `,` pops the signature with the **current parameter highlighted**, the return type, and the short doc — for built-ins and your own procedures/functions. Commas inside strings and nested calls are handled correctly.
- **Context-aware completion** — after connecting, DB Lite loads the schema in the background: table names after `FROM` / `JOIN` / `INSERT INTO` / `UPDATE`, column names after `alias.` / `table.` / `schema.`, and columns of the tables referenced in the current statement (toggle: `dbtool.schemaCompletion`; refresh with `DB Lite: Refresh Schema`).
- **JOIN auto-generation** — foreign keys drive JOIN suggestions: after `JOIN ` you get complete clauses like `customers c ON c.id = o.customer_id` for every FK-related table; after `JOIN x ` or `… ON ` the matching condition is suggested (toggle: `dbtool.smartJoins`).
- **Visual Query Builder** — `DB Lite: Open Query Builder` (`Ctrl+Alt+Q`): drag tables onto a canvas, joins are auto-wired from foreign keys (type editable), tick columns and aggregates, add WHERE filters and sorting — the SQL preview updates live and can be run or inserted into the editor.
- **Execution plans** — `Ctrl+Alt+Enter` runs the statement with the **actual** plan (`EXPLAIN ANALYZE` on PostgreSQL, `SET STATISTICS XML` on SQL Server) and renders it as a collapsible tree: per-node time bars highlight the hot path, actual vs estimated rows are compared and big misestimates flagged. A live elapsed timer ticks in the status bar while any query runs.
- **Schema browser** — the connected server expands in the sidebar: tables → columns (with exact types, nullability, defaults, identity), views, stored procedures and functions (with parameters). Right-click a table for its first 100 rows; right-click a procedure to view its definition or generate an EXEC/CALL template.
- **Object management** — `DB Lite: Create New Object` opens review-ready CREATE scripts (table, view, stored procedure, function, index, schema — correct syntax per engine) and can create a **database** after a confirmation. Right-click a table to **Script as SELECT / INSERT / UPDATE / DELETE / CREATE** (INSERT skips identity columns, UPDATE/DELETE are keyed on the primary key, CREATE is reconstructed from real metadata incl. PKs and FKs; views script their live server definition), or to **Count Rows**.
- **Destructive operations, guarded** — **Drop Table/View**, **Truncate Table**, **Delete All Rows**, and **Drop Procedure/Function** live in a separate danger section of the context menu. Each one shows the affected row count where relevant, requires a modal confirmation **plus typing the exact object name**, always runs a single fully schema-qualified, fully quoted statement (never CASCADE), is logged, and refreshes the schema afterwards.
- **All databases in the tree** — every open connection expands into **all** databases on its server; the attached one is marked `✓ current` and wears the connection's environment-color icon (green when it has none), and any other database you also have a session on is flagged too. `DB Lite: Switch Database`, or a click on a database, reconnects a host/user connection against it.
- **Stored-procedure tooling** — typing `EXEC ` / `CALL ` completes procedure names into ready-to-fill templates with named parameters; procedures and functions also appear in normal completion, the object search, and the schema tree.
- **Fast object search** — `Ctrl+Alt+T` fuzzy-searches every table, view, procedure and function; pick a table to preview its rows, a routine to open its source.
- **Semantic SQL coloring** — known tables, columns, aliases, schemas, and functions/procedures are colored by your theme via semantic tokens (toggle: `dbtool.semanticHighlighting`).
- **Statement snippets** — typing `select` offers `SELECT * FROM ` (uppercase, cursor placed after FROM), plus INSERT/UPDATE/DELETE/COUNT starters.
- **Auto-UPPERCASE keywords** — type `select ` and it becomes `SELECT ` (toggle: `dbtool.autoUppercaseKeywords`).
- **Auto table aliases** — after `FROM order_details ` DB Lite suggests `od` (toggle: `dbtool.autoAlias`).
- **Aliases in scope, first in the list** — the aliases declared in the statement you are writing are offered everywhere inside it (`WHERE `, `ON `, `AND `, the SELECT list, `GROUP BY` / `ORDER BY`, after a comma or an operator) and sorted **above every other suggestion**; each one documents the table it stands for and its columns spelled `alias.column`.
- **Run queries** — `Ctrl+Enter` (or `Cmd+Enter`) runs the selection (multi-cursor selections run in order), or the whole file if nothing is selected. Multiple statements and multiple result sets are supported; T-SQL `GO` batch separators work.
- **Results panel** — row counts, execution time, sticky headers, NULL styling, error details.
- **Grid aggregates** — click/drag cells in the results grid (headers select a column, row numbers a row; Ctrl/Cmd-click toggles, Shift-click extends) and a footer shows **Count · Distinct · Sum · Avg · Min · Max** over the selection. `Ctrl+C` copies selected cells as TSV; `Escape` clears.
- **Debug logging** — `DB Lite: Show Logs` opens an output channel with connection, query, and schema-load timings and failures.
- **Panel theme** — `dbtool.theme`: follow VS Code (`default`), or force `dark`/`light` for DB Lite panels.
- **Connections view** — a DB Lite icon in the activity bar lists saved connections; click to connect, right-click to edit/remove.
- **Connection bar and footer** — every SQL script is topped with a clickable bar naming the connection its queries run on, and closed with a matching **footer** at the end of the script; both are filled with the connection's environment color, so the tab you are typing in is never in doubt (toggle: `dbtool.connectionFooter`).
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
| `dbtool.semanticHighlighting` | `true` | Theme-color known tables/columns/aliases/functions in SQL |
| `dbtool.connectionFooter` | `true` | Show the connection footer bar at the end of SQL scripts |
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
| `DB Lite: Run with Execution Plan` | Run + visualize the actual plan (`Ctrl+Alt+Enter`) |
| `DB Lite: Open Query Builder` | Visual drag-and-drop query construction (`Ctrl+Alt+Q`) |
| `DB Lite: Search Tables & Procedures` | Fuzzy search all schema objects (`Ctrl+Alt+T`) |
| `DB Lite: Create New Object` | CREATE scripts for table/view/SP/function/index/schema + Create Database |
| `DB Lite: Switch Database` | Reconnect the current connection against another database |
| `DB Lite: Count Rows` / `Script as …` | Table utilities (also in the tree context menu) |
| `DB Lite: Drop / Truncate / Delete All Rows` | Guarded destructive operations (modal + type-the-name confirmation) |
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
