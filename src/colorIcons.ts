import * as vscode from 'vscode';
import { safeColor } from './theme';

const written = new Set<string>();

/**
 * VS Code cannot recolor editor tabs, so connection colors are surfaced as
 * generated SVG icons (tree item + panel tab icon), the status bar text color,
 * and a colored banner in the results panel. Icons are tiny SVGs written once
 * to globalStorage and cached.
 */
export async function connectionIcon(
  ctx: vscode.ExtensionContext,
  color: string | undefined,
  shape: 'db' | 'dot'
): Promise<vscode.Uri | vscode.ThemeIcon> {
  const hex = safeColor(color);
  if (!hex) return new vscode.ThemeIcon('database');
  const name = `${shape}-${hex.slice(1)}.svg`;
  const dir = vscode.Uri.joinPath(ctx.globalStorageUri, 'icons');
  const file = vscode.Uri.joinPath(dir, name);
  if (!written.has(name)) {
    const svg =
      shape === 'dot'
        ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="${hex}"/></svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${hex}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/></svg>`;
    try {
      await vscode.workspace.fs.createDirectory(dir);
      await vscode.workspace.fs.writeFile(file, Buffer.from(svg, 'utf8'));
      written.add(name);
    } catch {
      return new vscode.ThemeIcon('database');
    }
  }
  return file;
}

/** Removes all generated icons (used by Clear All Data). */
export async function clearIcons(ctx: vscode.ExtensionContext): Promise<void> {
  written.clear();
  const dir = vscode.Uri.joinPath(ctx.globalStorageUri, 'icons');
  await vscode.workspace.fs.delete(dir, { recursive: true }).then(undefined, () => undefined);
}
