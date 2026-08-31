import * as vscode from 'vscode';

/**
 * Debug/diagnostics logging into a "DB Lite" Output channel.
 * The channel is created lazily on first log line, so activation cost is zero;
 * output channels are free when not visible.
 */
let channel: vscode.OutputChannel | undefined;

function get(): vscode.OutputChannel {
  return (channel ??= vscode.window.createOutputChannel('DB Lite'));
}

export function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  get().appendLine(`[${ts}] ${message}`);
}

/** One-line preview of a SQL text for the log. */
export function sqlPreview(sql: string, max = 120): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

export function showLogs(): void {
  get().show(true);
}

export function disposeLogs(): void {
  channel?.dispose();
  channel = undefined;
}
