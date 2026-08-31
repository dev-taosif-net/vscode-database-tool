export type DbKind = 'postgres' | 'mssql';

/** Non-secret connection metadata. Secrets (password / connection string) live in VS Code SecretStorage. */
export interface ConnectionMeta {
  id: string;
  name: string;
  kind: DbKind;
  /** 'string' = connect via full connection string (stored as secret); 'fields' = host/port/db/user (+ password secret). */
  mode: 'string' | 'fields';
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  /** postgres only */
  ssl?: 'disable' | 'verify' | 'no-verify';
  /** mssql only */
  encrypt?: boolean;
  trustCert?: boolean;
  /** Environment color (hex), e.g. #d13438 for production. */
  color?: string;
  /** Connection timeout in seconds (default 10). */
  timeoutSec?: number;
}

export interface ResultSet {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  /** Optional note, e.g. the command tag for statements without a result grid. */
  note?: string;
}

export interface QueryOutcome {
  sets: ResultSet[];
  durationMs: number;
}

export interface DbSession {
  readonly meta: ConnectionMeta;
  run(sql: string): Promise<QueryOutcome>;
  dispose(): Promise<void>;
}
