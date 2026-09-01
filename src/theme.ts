import * as vscode from 'vscode';

/**
 * DB Lite panels (results + connection editor) honor the `dbtool.theme`
 * setting: 'default' follows the current VS Code color theme via CSS vars,
 * 'dark'/'light' force a fixed palette regardless of the editor theme.
 */
export function paletteCss(): string {
  const theme = vscode.workspace.getConfiguration('dbtool').get<string>('theme', 'default');
  if (theme === 'dark') {
    return `:root{
      --bg:#1e1e1e; --fg:#d4d4d4; --dim:#9d9d9d; --border:#3c3c3c; --hover:#2a2d2e;
      --accent:#0e639c; --accent-fg:#ffffff; --error:#f48771;
      --badge-bg:#4d4d4d; --badge-fg:#ffffff; --input-bg:#3c3c3c; --input-fg:#cccccc; --input-border:#3c3c3c;
      --head-bg:#252526; --null-bg:#4a4520; --null-fg:#e8de82; color-scheme: dark;}
      body{background:var(--bg);color:var(--fg);}`;
  }
  if (theme === 'light') {
    return `:root{
      --bg:#ffffff; --fg:#333333; --dim:#717171; --border:#d4d4d4; --hover:#f0f0f0;
      --accent:#007acc; --accent-fg:#ffffff; --error:#c72e0f;
      --badge-bg:#c4c4c4; --badge-fg:#333333; --input-bg:#ffffff; --input-fg:#333333; --input-border:#cecece;
      --head-bg:#f3f3f3; --null-bg:#ffffca; --null-fg:#6b5900; color-scheme: light;}
      body{background:var(--bg);color:var(--fg);}`;
  }
  // SSMS-style yellow NULL cells; the default theme resolves light/dark from the webview body class.
  return `:root{
    --bg:var(--vscode-editor-background); --fg:var(--vscode-foreground);
    --dim:var(--vscode-descriptionForeground); --border:var(--vscode-editorWidget-border, rgba(128,128,128,.35));
    --hover:var(--vscode-list-hoverBackground);
    --accent:var(--vscode-button-background); --accent-fg:var(--vscode-button-foreground);
    --error:var(--vscode-errorForeground, #f48771);
    --badge-bg:var(--vscode-badge-background); --badge-fg:var(--vscode-badge-foreground);
    --input-bg:var(--vscode-input-background); --input-fg:var(--vscode-input-foreground);
    --input-border:var(--vscode-input-border, transparent);
    --head-bg:var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    --null-bg:#ffffca; --null-fg:#6b5900;}
    body.vscode-dark, body.vscode-high-contrast:not(.vscode-high-contrast-light)
      {--null-bg:#4a4520; --null-fg:#e8de82;}
    body{color:var(--fg);}`;
}

/** Validates a stored color so it can be safely embedded in SVG/HTML. */
export function safeColor(color: string | undefined): string | undefined {
  return color && /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : undefined;
}
