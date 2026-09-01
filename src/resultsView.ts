import * as vscode from 'vscode';
import { ConnectionMeta, QueryOutcome } from './types';
import { renderErrorHtml, renderResultsHtml } from './resultsPanel';

/**
 * SSMS-style results in the bottom panel (next to Terminal): a webview view
 * rendering the same grid as the editor-tab panel — sticky headers, yellow
 * NULL cells, aggregates footer, and its own horizontal/vertical scrollbars.
 */
export class ResultsView {
  private static view: vscode.WebviewView | undefined;
  /** Content produced before the view resolved (first reveal is async). */
  private static pendingHtml: string | undefined;
  private static pendingTitle: string | undefined;

  static register(ctx: vscode.ExtensionContext): void {
    ctx.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        'dbtool.resultsView',
        {
          resolveWebviewView: (view) => {
            this.view = view;
            view.webview.options = { enableScripts: true };
            view.onDidDispose(() => {
              if (this.view === view) this.view = undefined;
            });
            if (this.pendingHtml) {
              view.title = this.pendingTitle;
              view.webview.html = this.pendingHtml;
              this.pendingHtml = this.pendingTitle = undefined;
            }
          },
        },
        { webviewOptions: { retainContextWhenHidden: false } }
      )
    );
  }

  static showResults(meta: ConnectionMeta, outcome: QueryOutcome, maxRows: number): void {
    void this.show(`Results — ${meta.name}`, renderResultsHtml(meta, outcome, maxRows));
  }

  static showError(meta: ConnectionMeta, error: unknown): void {
    void this.show(`Error — ${meta.name}`, renderErrorHtml(meta, error));
  }

  private static async show(title: string, html: string): Promise<void> {
    if (this.view) {
      this.view.show(true);
      this.view.title = title;
      this.view.webview.html = html;
      return;
    }
    // First use: reveal the panel view, which resolves it and applies the pending content.
    this.pendingHtml = html;
    this.pendingTitle = title;
    await vscode.commands.executeCommand('dbtool.resultsView.focus');
    if (this.view && this.pendingHtml) {
      const v = this.view as vscode.WebviewView;
      v.title = this.pendingTitle;
      v.webview.html = this.pendingHtml;
      this.pendingHtml = this.pendingTitle = undefined;
    }
  }
}
