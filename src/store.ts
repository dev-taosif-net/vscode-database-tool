import * as vscode from 'vscode';
import { ConnectionMeta } from './types';

const LIST_KEY = 'dbtool.connections';
const secretKey = (id: string) => `dbtool.secret.${id}`;

/**
 * Connection metadata lives in globalState (non-secret only).
 * Passwords and connection strings live in SecretStorage, which VS Code
 * backs with the OS keychain (libsecret / Keychain / Credential Manager).
 */
export class ConnectionStore {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  list(): ConnectionMeta[] {
    return this.ctx.globalState.get<ConnectionMeta[]>(LIST_KEY, []);
  }

  get(id: string): ConnectionMeta | undefined {
    return this.list().find((c) => c.id === id);
  }

  async save(meta: ConnectionMeta, secret: string | undefined): Promise<void> {
    const rest = this.list().filter((c) => c.id !== meta.id);
    await this.ctx.globalState.update(LIST_KEY, [...rest, meta]);
    if (secret !== undefined) {
      await this.ctx.secrets.store(secretKey(meta.id), secret);
    }
  }

  async remove(id: string): Promise<void> {
    await this.ctx.globalState.update(LIST_KEY, this.list().filter((c) => c.id !== id));
    await this.ctx.secrets.delete(secretKey(id));
  }

  secret(id: string): Thenable<string | undefined> {
    return this.ctx.secrets.get(secretKey(id));
  }

  /** Deletes every connection and every stored credential. */
  async clearAll(): Promise<void> {
    for (const c of this.list()) {
      await this.ctx.secrets.delete(secretKey(c.id));
    }
    await this.ctx.globalState.update(LIST_KEY, []);
  }
}
