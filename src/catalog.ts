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
}

export interface CatalogTable {
  schema: string;
  name: string;
  isView: boolean;
  columns: CatalogColumn[];
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
    return { v: 2, kind: this.kind, tables: this.tables, fks: this.fks, routines: this.routines };
  }

  static fromJSON(data: unknown): Catalog | undefined {
    const d = data as SerializedCatalog | undefined;
    if (!d || d.v !== 2 || !Array.isArray(d.tables) || !Array.isArray(d.fks)) return undefined;
    return new Catalog(d.kind, d.tables, d.fks, Array.isArray(d.routines) ? d.routines : []);
  }
}

export interface SerializedCatalog {
  v: 2;
  kind: DbKind;
  tables: CatalogTable[];
  fks: CatalogFk[];
  routines: CatalogRoutine[];
}

// ------------------------------------------------------------- introspection

const PG_COLUMNS = `
SELECT c.table_schema, c.table_name, c.column_name, c.data_type, t.table_type
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY c.table_schema, c.table_name, c.ordinal_position`;

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
SELECT s.name, o.name, c.name, ty.name, CASE WHEN o.type = 'V' THEN 'VIEW' ELSE 'TABLE' END
FROM sys.objects o
JOIN sys.schemas s ON s.schema_id = o.schema_id
JOIN sys.columns c ON c.object_id = o.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
WHERE o.type IN ('U', 'V')
ORDER BY s.name, o.name, c.column_id`;

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

export async function loadCatalog(session: DbSession): Promise<Catalog> {
  const kind = session.meta.kind;
  const colRows = firstSet(await session.run(kind === 'postgres' ? PG_COLUMNS : MSSQL_COLUMNS));
  // Foreign keys and routines are nice-to-haves (JOIN generation, SP tooling);
  // permission errors here must not break table/column completion.
  let fkRows: unknown[][] = [];
  try {
    fkRows = firstSet(await session.run(kind === 'postgres' ? PG_FKS : MSSQL_FKS));
  } catch {
    /* completion degrades gracefully without FKs */
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
    const [schema, table, column, dataType, type] = r.map(String);
    const key = `${schema}\0${table}`;
    let t = tableIndex.get(key);
    if (!t) {
      t = { schema, name: table, isView: type.toUpperCase().includes('VIEW'), columns: [] };
      tableIndex.set(key, t);
      tables.push(t);
    }
    t.columns.push({ name: column, dataType });
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
