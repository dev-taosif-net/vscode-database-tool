import * as vscode from 'vscode';
import { Catalog } from './catalog';

/**
 * Per-connection schema cache on disk (extension global storage). On connect
 * the cached catalog is loaded instantly — completions work with zero lag
 * while the fresh catalog is introspected in the background and swapped in.
 * Only non-secret metadata (object names/types) is stored.
 */

function cacheUri(ctx: vscode.ExtensionContext, connId: string): vscode.Uri {
  return vscode.Uri.joinPath(ctx.globalStorageUri, `schema-${connId}.json`);
}

export async function loadCachedCatalog(
  ctx: vscode.ExtensionContext,
  connId: string
): Promise<Catalog | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(cacheUri(ctx, connId));
    return Catalog.fromJSON(JSON.parse(Buffer.from(bytes).toString('utf8')));
  } catch {
    return undefined;
  }
}

export async function saveCatalogCache(
  ctx: vscode.ExtensionContext,
  connId: string,
  catalog: Catalog
): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(ctx.globalStorageUri);
    await vscode.workspace.fs.writeFile(
      cacheUri(ctx, connId),
      Buffer.from(JSON.stringify(catalog.toJSON()), 'utf8')
    );
  } catch {
    /* cache is best-effort */
  }
}

export async function deleteCatalogCache(ctx: vscode.ExtensionContext, connId: string): Promise<void> {
  try {
    await vscode.workspace.fs.delete(cacheUri(ctx, connId));
  } catch {
    /* may not exist */
  }
}

export async function clearAllCatalogCaches(ctx: vscode.ExtensionContext): Promise<void> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(ctx.globalStorageUri);
    for (const [name] of entries) {
      if (name.startsWith('schema-') && name.endsWith('.json')) {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(ctx.globalStorageUri, name));
      }
    }
  } catch {
    /* storage dir may not exist */
  }
}
