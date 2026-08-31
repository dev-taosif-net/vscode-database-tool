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

  constructor(
    readonly kind: DbKind,
    readonly tables: CatalogTable[],
    readonly fks: CatalogFk[]
  ) {
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

function firstSet(outcome: QueryOutcome): unknown[][] {
  return outcome.sets.find((s) => s.columns.length > 0)?.rows ?? [];
}

export async function loadCatalog(session: DbSession): Promise<Catalog> {
  const kind = session.meta.kind;
  const colRows = firstSet(await session.run(kind === 'postgres' ? PG_COLUMNS : MSSQL_COLUMNS));
  // Foreign keys are a nice-to-have (JOIN generation); permission errors here
  // must not break table/column completion.
  let fkRows: unknown[][] = [];
  try {
    fkRows = firstSet(await session.run(kind === 'postgres' ? PG_FKS : MSSQL_FKS));
  } catch {
    /* completion degrades gracefully without FKs */
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

  return new Catalog(kind, tables, fks);
}
