import { ConnectionMeta, DbSession, QueryOutcome, ResultSet } from './types';

/**
 * Drivers are require()d lazily inside these functions so the extension
 * activates instantly — pg/mssql module code is only loaded and parsed
 * the first time the user actually connects.
 */
export async function openSession(meta: ConnectionMeta, secret: string): Promise<DbSession> {
  return meta.kind === 'postgres' ? openPostgres(meta, secret) : openMssql(meta, secret);
}

// ---------------------------------------------------------------- PostgreSQL

async function openPostgres(meta: ConnectionMeta, secret: string): Promise<DbSession> {
  const { Client } = require('pg') as typeof import('pg');

  const config: import('pg').ClientConfig =
    meta.mode === 'string'
      ? { connectionString: secret }
      : {
          host: meta.host,
          port: meta.port,
          database: meta.database,
          user: meta.user,
          password: secret,
          ...(meta.ssl === 'verify'
            ? { ssl: true }
            : meta.ssl === 'no-verify'
              ? { ssl: { rejectUnauthorized: false } }
              : {}),
        };
  config.connectionTimeoutMillis = (meta.timeoutSec ?? 10) * 1000;

  const client = new Client(config);
  await client.connect();
  client.on('error', () => {
    /* dropped connection — surfaced on next query */
  });

  return {
    meta,
    async run(sql: string): Promise<QueryOutcome> {
      const t0 = performance.now();
      // rowMode: 'array' is faster than object rows and preserves duplicate column names.
      const res = await client.query({ text: sql, rowMode: 'array' } as import('pg').QueryConfig);
      const durationMs = performance.now() - t0;
      // node-postgres returns an array of results for multi-statement text.
      const list: any[] = Array.isArray(res) ? res : [res];
      const sets: ResultSet[] = list.map((r) => ({
        columns: (r.fields ?? []).map((f: { name: string }) => f.name),
        rows: r.rows ?? [],
        rowCount: r.rowCount ?? r.rows?.length ?? 0,
        note: r.command,
      }));
      return { sets, durationMs };
    },
    async dispose() {
      await client.end().catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------- SQL Server

async function openMssql(meta: ConnectionMeta, secret: string): Promise<DbSession> {
  const mssql = require('mssql') as typeof import('mssql');

  const timeoutMs = (meta.timeoutSec ?? 10) * 1000;
  // For ADO-style connection strings, append the timeout (a later duplicate
  // key wins in the parser); mssql:// URIs are left untouched.
  const connString =
    meta.timeoutSec && !/^mssql:\/\//i.test(secret)
      ? `${secret.replace(/;\s*$/, '')};Connection Timeout=${meta.timeoutSec}`
      : secret;
  const pool =
    meta.mode === 'string'
      ? new mssql.ConnectionPool(connString)
      : new mssql.ConnectionPool({
          server: meta.host ?? 'localhost',
          port: meta.port,
          database: meta.database,
          user: meta.user,
          password: secret,
          connectionTimeout: timeoutMs,
          requestTimeout: 0, // no cap on long-running queries
          pool: { max: 1, min: 0 },
          options: {
            encrypt: meta.encrypt !== false,
            trustServerCertificate: meta.trustCert === true,
          },
        });

  await pool.connect();
  pool.on('error', () => {
    /* dropped connection — surfaced on next query */
  });

  return {
    meta,
    async run(sql: string): Promise<QueryOutcome> {
      const t0 = performance.now();
      const sets: ResultSet[] = [];
      // Support classic T-SQL scripts: split on GO batch separators.
      const batches = sql.split(/^\s*GO\s*;?\s*$/gim).map((b) => b.trim()).filter(Boolean);
      for (const batch of batches.length ? batches : [sql]) {
        const request = pool.request();
        // Array rows preserve duplicate column names (keyed objects collapse
        // them into one entry) — the catalog queries select several columns
        // all literally named "name". Same reason pg uses rowMode: 'array'.
        request.arrayRowMode = true;
        const res = await request.query(batch);
        const recordsets = res.recordsets as unknown as unknown[][][];
        const columnMeta = (res as unknown as { columns?: { name: string }[][] }).columns ?? [];
        if (recordsets.length > 0) {
          recordsets.forEach((rows, i) => {
            sets.push({
              columns: (columnMeta[i] ?? []).map((c) => c.name),
              rows,
              rowCount: rows.length,
            });
          });
        } else {
          const affected = (res.rowsAffected ?? []).reduce((a, b) => a + b, 0);
          sets.push({ columns: [], rows: [], rowCount: affected, note: 'rows affected' });
        }
      }
      return { sets, durationMs: performance.now() - t0 };
    },
    async dispose() {
      await pool.close().catch(() => undefined);
    },
  };
}
