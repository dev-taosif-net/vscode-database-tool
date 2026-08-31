import { DbKind, DbSession, QueryOutcome } from './types';

/**
 * Schema catalog: tables, columns and foreign keys of the connected database.
 * Loaded once after connect (in the background, off the critical path) through
 * the session's plain run() — no extra driver surface needed. Lookups are all
 * in-memory maps, so completion stays O(1)-ish per keystroke.
 */

export interface CatalogColumn {
  name: string;
  dataType: string;
  nullable?: boolean;
  /** default expression, verbatim from the server */
  dflt?: string;
  identity?: boolean;
}

export interface CatalogTable {
  schema: string;
  name: string;
  isView: boolean;
  columns: CatalogColumn[];
  /** primary key column names, in key order */
  pk?: string[];
}

export interface CatalogFk {
  fromSchema: string;
  fromTable: string;
  fromColumns: string[];
  toSchema: string;
  toTable: string;
  toColumns: string[];
}

export interface CatalogParam {
  name: string;
  dataType: string;
  output?: boolean;
}

export interface CatalogRoutine {
  schema: string;
  name: string;
  kind: 'procedure' | 'function';
  params: CatalogParam[];
  /** raw signature text (postgres identity arguments), when available */
  signature?: string;
}

/** A table reachable from `t` via one foreign key (either direction). */
export interface RelatedTable {
  table: CatalogTable;
  /** columns on `t` */
  myColumns: string[];
  /** matching columns on `table` */
  otherColumns: string[];
}

const norm = (s: string): string => s.replace(/[[\]"`]/g, '').toLowerCase();

export class Catalog {
  private readonly byName = new Map<string, CatalogTable[]>();
  private readonly schemaSet = new Set<string>();
  private readonly fksByTable = new Map<CatalogTable, CatalogFk[]>();
  private readonly fkEnds = new Map<CatalogFk, { from?: CatalogTable; to?: CatalogTable }>();
  private readonly routineByName = new Map<string, CatalogRoutine[]>();

  constructor(
    readonly kind: DbKind,
    readonly tables: CatalogTable[],
    readonly fks: CatalogFk[],
    readonly routines: CatalogRoutine[] = []
  ) {
    for (const r of routines) {
      const key = r.name.toLowerCase();
      const list = this.routineByName.get(key);
      if (list) list.push(r);
      else this.routineByName.set(key, [r]);
      this.schemaSet.add(r.schema.toLowerCase());
    }
    for (const t of tables) {
      const key = norm(t.name);
      const list = this.byName.get(key);
      if (list) list.push(t);
      else this.byName.set(key, [t]);
      this.schemaSet.add(norm(t.schema));
    }
    for (const fk of fks) {
      const from = this.resolve(`${fk.fromSchema}.${fk.fromTable}`);
      const to = this.resolve(`${fk.toSchema}.${fk.toTable}`);
      this.fkEnds.set(fk, { from, to });
      for (const t of new Set([from, to])) {
        if (!t) continue;
        const list = this.fksByTable.get(t);
        if (list) list.push(fk);
        else this.fksByTable.set(t, [fk]);
      }
    }
  }

  get defaultSchema(): string {
    return this.kind === 'postgres' ? 'public' : 'dbo';
  }

  isSchema(name: string): boolean {
    return this.schemaSet.has(norm(name));
  }

  tablesInSchema(schema: string): CatalogTable[] {
    const s = norm(schema);
    return this.tables.filter((t) => norm(t.schema) === s);
  }

  /** Resolve "table" / "schema.table" / "db.schema.table" — case-insensitive, quotes/brackets stripped. */
  resolve(ref: string): CatalogTable | undefined {
    const parts = ref.split('.').map(norm).filter(Boolean);
    if (parts.length === 0) return undefined;
    const name = parts[parts.length - 1];
    const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;
    const candidates = this.byName.get(name);
    if (!candidates?.length) return undefined;
    if (schema) return candidates.find((t) => norm(t.schema) === schema);
    return candidates.find((t) => norm(t.schema) === this.defaultSchema) ?? candidates[0];
  }

  /** Tables joinable to `t` via a foreign key, with the matching column pairs. */
  related(t: CatalogTable): RelatedTable[] {
    const out: RelatedTable[] = [];
    for (const fk of this.fksByTable.get(t) ?? []) {
      const ends = this.fkEnds.get(fk)!;
      if (ends.from === t && ends.to) {
        out.push({ table: ends.to, myColumns: fk.fromColumns, otherColumns: fk.toColumns });
      }
      if (ends.to === t && ends.from) {
        out.push({ table: ends.from, myColumns: fk.toColumns, otherColumns: fk.fromColumns });
      }
    }
    return out;
  }

  /** Column pairs joining `a` to `b` (either FK direction): aColumns[i] = bColumns[i]. */
  joins(a: CatalogTable, b: CatalogTable): { aColumns: string[]; bColumns: string[] }[] {
    const out: { aColumns: string[]; bColumns: string[] }[] = [];
    for (const fk of this.fksByTable.get(a) ?? []) {
      const ends = this.fkEnds.get(fk)!;
      if (ends.from === a && ends.to === b) {
        out.push({ aColumns: fk.fromColumns, bColumns: fk.toColumns });
      }
      if (ends.to === a && ends.from === b) {
        out.push({ aColumns: fk.toColumns, bColumns: fk.fromColumns });
      }
    }
    return out;
  }

  isRoutine(name: string): boolean {
    return this.routineByName.has(norm(name));
  }

  toJSON(): SerializedCatalog {
    return { v: 3, kind: this.kind, tables: this.tables, fks: this.fks, routines: this.routines };
  }

  static fromJSON(data: unknown): Catalog | undefined {
    const d = data as SerializedCatalog | undefined;
    if (!d || d.v !== 3 || !Array.isArray(d.tables) || !Array.isArray(d.fks)) return undefined;
    return new Catalog(d.kind, d.tables, d.fks, Array.isArray(d.routines) ? d.routines : []);
  }
}

export interface SerializedCatalog {
  v: 3;
  kind: DbKind;
  tables: CatalogTable[];
  fks: CatalogFk[];
  routines: CatalogRoutine[];
}

// ------------------------------------------------------------- introspection

/** Modern pg_catalog query: exact types (with lengths), nullability, defaults, identity. PG 10+. */
const PG_COLUMNS = `
SELECT ns.nspname, cl.relname, a.attname, format_type(a.atttypid, a.atttypmod),
       CASE WHEN cl.relkind IN ('v', 'm') THEN 'VIEW' ELSE 'TABLE' END,
       NOT a.attnotnull,
       pg_get_expr(d.adbin, d.adrelid),
       a.attidentity <> ''
FROM pg_attribute a
JOIN pg_class cl ON cl.oid = a.attrelid
JOIN pg_namespace ns ON ns.oid = cl.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attnum > 0 AND NOT a.attisdropped
  AND cl.relkind IN ('r', 'v', 'm', 'p')
  AND ns.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY ns.nspname, cl.relname, a.attnum`;

/** Fallback for very old servers — names and generic types only. */
const PG_COLUMNS_FALLBACK = `
SELECT c.table_schema, c.table_name, c.column_name, c.data_type, t.table_type
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY c.table_schema, c.table_name, c.ordinal_position`;

const PG_PKS = `
SELECT ns.nspname, cl.relname, a.attname
FROM pg_constraint con
CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
JOIN pg_class cl ON cl.oid = con.conrelid
JOIN pg_namespace ns ON ns.oid = cl.relnamespace
JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
WHERE con.contype = 'p'
ORDER BY con.oid, k.ord`;

const PG_FKS = `
SELECT sns.nspname, scl.relname, sa.attname, tns.nspname, tcl.relname, ta.attname, con.oid::text
FROM pg_constraint con
CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(fromnum, tonum, ord)
JOIN pg_class scl ON scl.oid = con.conrelid
JOIN pg_namespace sns ON sns.oid = scl.relnamespace
JOIN pg_class tcl ON tcl.oid = con.confrelid
JOIN pg_namespace tns ON tns.oid = tcl.relnamespace
JOIN pg_attribute sa ON sa.attrelid = con.conrelid AND sa.attnum = k.fromnum
JOIN pg_attribute ta ON ta.attrelid = con.confrelid AND ta.attnum = k.tonum
WHERE con.contype = 'f'
ORDER BY con.oid, k.ord`;

const MSSQL_COLUMNS = `
SELECT s.name, o.name, c.name, ty.name, CASE WHEN o.type = 'V' THEN 'VIEW' ELSE 'TABLE' END,
       c.is_nullable, dc.definition, c.is_identity, c.max_length, c.precision, c.scale
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.columns c ON c.object_id = o.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
WHERE o.type IN ('U', 'V')
ORDER BY s.name, o.name, c.column_id`;

const MSSQL_PKS = `
SELECT s.name, o.name, c.name
FROM sys.indexes i
JOIN sys.objects o ON o.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE i.is_primary_key = 1
ORDER BY s.name, o.name, ic.key_ordinal`;

const MSSQL_FKS = `
SELECT ps.name, pt.name, pc.name, rs.name, rt.name, rc.name, CAST(fk.object_id AS varchar(20))
FROM sys.foreign_key_columns fkc
JOIN sys.foreign_keys fk ON fk.object_id = fkc.constraint_object_id
JOIN sys.objects pt ON pt.object_id = fkc.parent_object_id
JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.objects rt ON rt.object_id = fkc.referenced_object_id
JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
ORDER BY fk.object_id, fkc.constraint_column_id`;

const PG_ROUTINES = `
SELECT n.nspname, p.proname,
       CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END,
       pg_get_function_identity_arguments(p.oid)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind IN ('f', 'p')
ORDER BY n.nspname, p.proname`;

const MSSQL_ROUTINES = `
SELECT s.name, o.name,
       CASE o.type WHEN 'P' THEN 'procedure' ELSE 'function' END,
       p.name, TYPE_NAME(p.user_type_id), p.is_output, p.parameter_id
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
LEFT JOIN sys.parameters p ON p.object_id = o.object_id
WHERE o.type IN ('P', 'FN', 'IF', 'TF')
ORDER BY s.name, o.name, p.parameter_id`;

function firstSet(outcome: QueryOutcome): unknown[][] {
  return outcome.sets.find((s) => s.columns.length > 0)?.rows ?? [];
}

/** Best-effort parse of pg_get_function_identity_arguments output. */
function parsePgArgs(signature: string): CatalogParam[] {
  if (!signature.trim()) return [];
  // Split on top-level commas only (numeric(10,2) etc. contain nested commas).
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of signature) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => {
    let s = p.trim().replace(/\s+DEFAULT\s+.*$/i, '');
    let output = false;
    const mode = /^(IN|OUT|INOUT|VARIADIC)\s+/i.exec(s);
    if (mode) {
      output = /^(OUT|INOUT)$/i.test(mode[1]);
      s = s.slice(mode[0].length);
    }
    const tokens = s.split(/\s+/);
    if (tokens.length >= 2) {
      return { name: tokens[0], dataType: tokens.slice(1).join(' '), output };
    }
    return { name: '', dataType: tokens[0] ?? '', output };
  });
}

/** Format a SQL Server type with its length/precision/scale. */
function mssqlType(name: string, maxLen: number, precision: number, scale: number): string {
  const n = name.toLowerCase();
  if (n === 'varchar' || n === 'char' || n === 'varbinary' || n === 'binary') {
    return `${name}(${maxLen < 0 ? 'MAX' : maxLen})`;
  }
  if (n === 'nvarchar' || n === 'nchar') {
    return `${name}(${maxLen < 0 ? 'MAX' : maxLen / 2})`;
  }
  if (n === 'decimal' || n === 'numeric') return `${name}(${precision},${scale})`;
  if (n === 'datetime2' || n === 'time' || n === 'datetimeoffset') return `${name}(${scale})`;
  return name;
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === 't' || v === 'true' || v === '1';
}

export async function loadCatalog(session: DbSession): Promise<Catalog> {
  const kind = session.meta.kind;
  let colRows: unknown[][];
  let pgRich = kind === 'postgres';
  if (kind === 'postgres') {
    try {
      colRows = firstSet(await session.run(PG_COLUMNS));
    } catch {
      pgRich = false;
      colRows = firstSet(await session.run(PG_COLUMNS_FALLBACK));
    }
  } else {
    colRows = firstSet(await session.run(MSSQL_COLUMNS));
  }
  // Foreign keys, primary keys and routines are nice-to-haves (JOIN generation,
  // scripting, SP tooling); permission errors must not break basic completion.
  let fkRows: unknown[][] = [];
  try {
    fkRows = firstSet(await session.run(kind === 'postgres' ? PG_FKS : MSSQL_FKS));
  } catch {
    /* completion degrades gracefully without FKs */
  }
  let pkRows: unknown[][] = [];
  try {
    pkRows = firstSet(await session.run(kind === 'postgres' ? PG_PKS : MSSQL_PKS));
  } catch {
    /* scripting degrades gracefully without PKs */
  }
  let routineRows: unknown[][] = [];
  try {
    routineRows = firstSet(await session.run(kind === 'postgres' ? PG_ROUTINES : MSSQL_ROUTINES));
  } catch {
    /* older servers (pre-11 postgres) or missing permissions */
  }

  const tables: CatalogTable[] = [];
  const tableIndex = new Map<string, CatalogTable>();
  for (const r of colRows) {
    const schema = String(r[0]);
    const table = String(r[1]);
    const column = String(r[2]);
    const type = String(r[4]);
    const key = `${schema}\0${table}`;
    let t = tableIndex.get(key);
    if (!t) {
      t = { schema, name: table, isView: type.toUpperCase().includes('VIEW'), columns: [] };
      tableIndex.set(key, t);
      tables.push(t);
    }
    const col: CatalogColumn = { name: column, dataType: String(r[3]) };
    if (kind === 'mssql') {
      col.dataType = mssqlType(String(r[3]), Number(r[8]), Number(r[9]), Number(r[10]));
      col.nullable = truthy(r[5]);
      if (r[6] != null) col.dflt = String(r[6]);
      col.identity = truthy(r[7]);
    } else if (pgRich) {
      col.nullable = truthy(r[5]);
      if (r[6] != null) col.dflt = String(r[6]);
      col.identity = truthy(r[7]);
    }
    t.columns.push(col);
  }

  for (const r of pkRows) {
    const t = tableIndex.get(`${String(r[0])}\0${String(r[1])}`);
    if (t) (t.pk ??= []).push(String(r[2]));
  }

  const fks: CatalogFk[] = [];
  const fkIndex = new Map<string, CatalogFk>();
  for (const r of fkRows) {
    const [fs, ft, fc, ts, tt, tc, id] = r.map(String);
    let fk = fkIndex.get(id);
    if (!fk) {
      fk = { fromSchema: fs, fromTable: ft, fromColumns: [], toSchema: ts, toTable: tt, toColumns: [] };
      fkIndex.set(id, fk);
      fks.push(fk);
    }
    fk.fromColumns.push(fc);
    fk.toColumns.push(tc);
  }

  const routines: CatalogRoutine[] = [];
  if (kind === 'postgres') {
    for (const r of routineRows) {
      const [schema, name, rkind, signature] = r.map(String);
      routines.push({
        schema,
        name,
        kind: rkind === 'procedure' ? 'procedure' : 'function',
        params: parsePgArgs(signature),
        signature,
      });
    }
  } else {
    const rIndex = new Map<string, CatalogRoutine>();
    for (const r of routineRows) {
      const [schema, name, rkind, pName, pType, pOutput] = r as unknown[];
      const key = `${schema}\0${name}`;
      let routine = rIndex.get(key);
      if (!routine) {
        routine = {
          schema: String(schema),
          name: String(name),
          kind: rkind === 'procedure' ? 'procedure' : 'function',
          params: [],
        };
        rIndex.set(key, routine);
        routines.push(routine);
      }
      // parameter_id 0 is a function's return value (empty name) — skip it.
      if (pName != null && String(pName)) {
        routine.params.push({
          name: String(pName),
          dataType: String(pType ?? ''),
          output: pOutput === true || pOutput === 1,
        });
      }
    }
  }

  return new Catalog(kind, tables, fks, routines);
}

// ------------------------------------------------------------- SQL builders

function escapeString(s: string): string {
  return s.replace(/'/g, "''");
}

export function quoteName(name: string, kind: DbKind): string {
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) return name;
  return kind === 'mssql' ? `[${name.replace(/]/g, ']]')}]` : `"${name.replace(/"/g, '""')}"`;
}

export function qualifiedName(schema: string, name: string, kind: DbKind): string {
  return `${quoteName(schema, kind)}.${quoteName(name, kind)}`;
}

/** Qualified name for display/queries — the default schema (public/dbo) is omitted. */
export function refName(schema: string, name: string, kind: DbKind): string {
  const def = kind === 'postgres' ? 'public' : 'dbo';
  return schema.toLowerCase() === def ? quoteName(name, kind) : qualifiedName(schema, name, kind);
}

/** SELECT of the first `limit` rows of a table. */
export function peekSql(t: CatalogTable, kind: DbKind, limit: number): string {
  const q = refName(t.schema, t.name, kind);
  return kind === 'mssql' ? `SELECT TOP ${limit} * FROM ${q}` : `SELECT * FROM ${q} LIMIT ${limit}`;
}

/** Query returning the source of a stored procedure / function (one column). */
export function definitionSql(r: CatalogRoutine, kind: DbKind): string {
  if (kind === 'postgres') {
    return `SELECT pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = '${escapeString(r.schema)}' AND p.proname = '${escapeString(r.name)}'
ORDER BY p.oid`;
  }
  const q = qualifiedName(r.schema, r.name, 'mssql');
  return `SELECT OBJECT_DEFINITION(OBJECT_ID(N'${escapeString(q)}')) AS definition`;
}

/** Editable EXEC / CALL template for a routine, with named parameters. */
export function execTemplate(r: CatalogRoutine, kind: DbKind): string {
  const q = refName(r.schema, r.name, kind);
  const inputs = r.params.filter((p) => !p.output);
  if (kind === 'mssql') {
    if (r.kind === 'function') {
      const args = inputs.map((p) => `/* ${p.name} ${p.dataType} */`).join(', ');
      return `SELECT * FROM ${q}(${args})`;
    }
    const args = r.params
      .map((p) => {
        const name = p.name.startsWith('@') ? p.name : '@' + p.name;
        return `    ${name} = /* ${p.dataType} */${p.output ? ' OUTPUT' : ''}`;
      })
      .join(',\n');
    return args ? `EXEC ${q}\n${args}` : `EXEC ${q}`;
  }
  const args = inputs.map((p) => `/* ${p.name || p.dataType} */`).join(', ');
  return r.kind === 'procedure' ? `CALL ${q}(${args})` : `SELECT * FROM ${q}(${args})`;
}
