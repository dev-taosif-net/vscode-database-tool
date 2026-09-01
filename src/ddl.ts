import { DbKind } from './types';
import { CatalogColumn, CatalogFk, CatalogRoutine, CatalogTable, quoteName, refName } from './catalog';

/**
 * Object scripting: "Script table as …", CREATE templates for new objects, and
 * the destructive statements (DROP / TRUNCATE / DELETE).
 *
 * Safety rules for anything destructive:
 *  - identifiers are ALWAYS quoted and ALWAYS schema-qualified (immune to
 *    search_path/user-default-schema surprises and to hostile names);
 *  - exactly one statement, no CASCADE, nothing implicit.
 * The confirmation UX lives in extension.ts (modal + type-the-name).
 */

/** Always-quoted, always schema-qualified — used for every destructive statement. */
export function strictQualified(schema: string, name: string, kind: DbKind): string {
  const q = (s: string): string =>
    kind === 'mssql' ? `[${s.replace(/]/g, ']]')}]` : `"${s.replace(/"/g, '""')}"`;
  return `${q(schema)}.${q(name)}`;
}

// ------------------------------------------------------------- destructive

export function dropTableSql(t: CatalogTable, kind: DbKind): string {
  return `DROP ${t.isView ? 'VIEW' : 'TABLE'} ${strictQualified(t.schema, t.name, kind)};`;
}

export function truncateSql(t: CatalogTable, kind: DbKind): string {
  return `TRUNCATE TABLE ${strictQualified(t.schema, t.name, kind)};`;
}

export function deleteAllSql(t: CatalogTable, kind: DbKind): string {
  return `DELETE FROM ${strictQualified(t.schema, t.name, kind)};`;
}

export function dropRoutineSql(r: CatalogRoutine, kind: DbKind): string {
  const keyword = r.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
  const q = strictQualified(r.schema, r.name, kind);
  // Postgres requires the argument signature to disambiguate overloads.
  if (kind === 'postgres') return `DROP ${keyword} ${q}(${r.signature ?? ''});`;
  return `DROP ${keyword} ${q};`;
}

export function countRowsSql(t: CatalogTable, kind: DbKind): string {
  return `SELECT COUNT(*) FROM ${strictQualified(t.schema, t.name, kind)}`;
}

// ---------------------------------------------------------- script table as …

function placeholder(c: CatalogColumn): string {
  return `/* ${c.name} ${c.dataType} */`;
}

/** WHERE clause on the primary key (or first column as a fallback). */
function keyWhere(t: CatalogTable, kind: DbKind): string {
  const keys = t.pk?.length ? t.pk : t.columns.slice(0, 1).map((c) => c.name);
  return keys
    .map((k) => {
      const col = t.columns.find((c) => c.name === k);
      return `${quoteName(k, kind)} = ${col ? placeholder(col) : '/* value */'}`;
    })
    .join('\n  AND ');
}

export function scriptSelect(t: CatalogTable, kind: DbKind): string {
  const cols = t.columns.map((c) => '    ' + quoteName(c.name, kind)).join(',\n');
  const top = kind === 'mssql' ? 'TOP 1000 ' : '';
  const limit = kind === 'mssql' ? '' : '\nLIMIT 1000';
  return `SELECT ${top}\n${cols}\nFROM ${refName(t.schema, t.name, kind)}${limit};\n`;
}

export function scriptInsert(t: CatalogTable, kind: DbKind): string {
  const cols = t.columns.filter((c) => !c.identity);
  return `INSERT INTO ${refName(t.schema, t.name, kind)} (${cols.map((c) => quoteName(c.name, kind)).join(', ')})
VALUES (${cols.map(placeholder).join(', ')});\n`;
}

export function scriptUpdate(t: CatalogTable, kind: DbKind): string {
  const keys = new Set(t.pk ?? []);
  const setCols = t.columns.filter((c) => !keys.has(c.name) && !c.identity);
  const sets = setCols.map((c) => `    ${quoteName(c.name, kind)} = ${placeholder(c)}`).join(',\n');
  return `UPDATE ${refName(t.schema, t.name, kind)}
SET\n${sets}
WHERE ${keyWhere(t, kind)};\n`;
}

export function scriptDelete(t: CatalogTable, kind: DbKind): string {
  return `DELETE FROM ${refName(t.schema, t.name, kind)}
WHERE ${keyWhere(t, kind)};\n`;
}

/** CREATE TABLE DDL reconstructed from catalog metadata. */
export function createTableDdl(t: CatalogTable, kind: DbKind, fks: CatalogFk[]): string {
  const lines: string[] = t.columns.map((c) => {
    const parts = [`    ${quoteName(c.name, kind)} ${c.dataType}`];
    if (c.identity) parts.push(kind === 'mssql' ? 'IDENTITY(1,1)' : 'GENERATED ALWAYS AS IDENTITY');
    if (c.nullable === false) parts.push('NOT NULL');
    // Identity columns cannot carry a DEFAULT; pg serials keep their nextval() default.
    if (c.dflt && !c.identity) parts.push(`DEFAULT ${c.dflt}`);
    return parts.join(' ');
  });
  if (t.pk?.length) {
    lines.push(`    PRIMARY KEY (${t.pk.map((k) => quoteName(k, kind)).join(', ')})`);
  }
  for (const fk of fks) {
    if (
      fk.fromSchema.toLowerCase() !== t.schema.toLowerCase() ||
      fk.fromTable.toLowerCase() !== t.name.toLowerCase()
    ) {
      continue;
    }
    lines.push(
      `    FOREIGN KEY (${fk.fromColumns.map((c) => quoteName(c, kind)).join(', ')}) ` +
      `REFERENCES ${refName(fk.toSchema, fk.toTable, kind)} (${fk.toColumns.map((c) => quoteName(c, kind)).join(', ')})`
    );
  }
  return `CREATE TABLE ${refName(t.schema, t.name, kind)} (
${lines.join(',\n')}
);
-- Scripted by DB Lite from catalog metadata.
-- Verify identity seeds, exact defaults, indexes, and constraints before use.
`;
}

// ------------------------------------------------------- new-object templates

export function newTableTemplate(kind: DbKind): string {
  if (kind === 'mssql') {
    return `CREATE TABLE dbo.MyTable (
    Id         bigint IDENTITY(1,1) NOT NULL,
    Name       nvarchar(200) NOT NULL,
    Amount     decimal(12,2) NOT NULL CONSTRAINT DF_MyTable_Amount DEFAULT (0),
    CreatedAt  datetime2 NOT NULL CONSTRAINT DF_MyTable_CreatedAt DEFAULT (sysutcdatetime()),
    CONSTRAINT PK_MyTable PRIMARY KEY (Id)
    -- , CustomerId bigint NOT NULL CONSTRAINT FK_MyTable_Customers REFERENCES dbo.Customers (Id)
);
`;
  }
  return `CREATE TABLE public.my_table (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text NOT NULL,
    amount      numeric(12,2) NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now()
    -- , customer_id bigint NOT NULL REFERENCES public.customers (id)
);
`;
}

export function newViewTemplate(kind: DbKind): string {
  if (kind === 'mssql') {
    return `CREATE OR ALTER VIEW dbo.MyView
AS
SELECT
    t.Id,
    t.Name
FROM dbo.MyTable t;
`;
  }
  return `CREATE OR REPLACE VIEW public.my_view AS
SELECT
    t.id,
    t.name
FROM public.my_table t;
`;
}

export function newProcedureTemplate(kind: DbKind): string {
  if (kind === 'mssql') {
    return `CREATE OR ALTER PROCEDURE dbo.usp_MyProcedure
    @Id   bigint,
    @From date = NULL
AS
BEGIN
    SET NOCOUNT ON;

    SELECT @Id AS Id, @From AS FromDate;
END;
GO

-- EXEC dbo.usp_MyProcedure @Id = 1;
`;
  }
  return `CREATE OR REPLACE PROCEDURE public.my_procedure(IN p_id bigint)
LANGUAGE plpgsql
AS $$
BEGIN
    -- statements
    RAISE NOTICE 'id = %', p_id;
END;
$$;

-- CALL public.my_procedure(1);
`;
}

export function newFunctionTemplate(kind: DbKind): string {
  if (kind === 'mssql') {
    return `CREATE OR ALTER FUNCTION dbo.fn_MyFunction (@Id bigint)
RETURNS TABLE
AS
RETURN
(
    SELECT t.Id, t.Name
    FROM dbo.MyTable t
    WHERE t.Id = @Id
);
GO

-- SELECT * FROM dbo.fn_MyFunction(1);
`;
  }
  return `CREATE OR REPLACE FUNCTION public.my_function(p_id bigint)
RETURNS TABLE (id bigint, name text)
LANGUAGE sql
AS $$
    SELECT t.id, t.name
    FROM public.my_table t
    WHERE t.id = p_id;
$$;

-- SELECT * FROM public.my_function(1);
`;
}

export function newIndexTemplate(kind: DbKind): string {
  if (kind === 'mssql') {
    return `CREATE NONCLUSTERED INDEX IX_MyTable_Name
ON dbo.MyTable (Name)
INCLUDE (Amount);
`;
  }
  return `CREATE INDEX ix_my_table_name
ON public.my_table (name);

-- CREATE INDEX CONCURRENTLY … to avoid locking writes on a busy table.
`;
}

export function newSchemaTemplate(kind: DbKind): string {
  return kind === 'mssql' ? 'CREATE SCHEMA MySchema;\n' : 'CREATE SCHEMA my_schema;\n';
}

export function createDatabaseSql(name: string, kind: DbKind): string {
  return kind === 'mssql'
    ? `CREATE DATABASE [${name.replace(/]/g, ']]')}]`
    : `CREATE DATABASE "${name.replace(/"/g, '""')}"`;
}

/** List of databases on the server (name in first column). */
export function listDatabasesSql(kind: DbKind): string {
  return kind === 'mssql'
    ? 'SELECT name FROM sys.databases WHERE state = 0 ORDER BY name'
    : 'SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn ORDER BY datname';
}

/** Name of the database the session is currently attached to (one scalar). */
export function currentDatabaseSql(kind: DbKind): string {
  return kind === 'mssql' ? 'SELECT DB_NAME()' : 'SELECT current_database()';
}

/** View source: postgres needs the body wrapped; mssql returns full DDL. */
export function viewDefinitionSql(t: CatalogTable, kind: DbKind): string {
  if (kind === 'postgres') {
    const lit = strictQualified(t.schema, t.name, 'postgres').replace(/'/g, "''");
    return `SELECT pg_get_viewdef('${lit}'::regclass, true)`;
  }
  const lit = strictQualified(t.schema, t.name, 'mssql').replace(/'/g, "''");
  return `SELECT OBJECT_DEFINITION(OBJECT_ID(N'${lit}'))`;
}
