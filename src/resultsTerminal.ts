import * as vscode from 'vscode';
import { ConnectionMeta, QueryOutcome, ResultSet } from './types';
import { displayText } from './resultsPanel';
import { safeColor } from './theme';

/**
 * Text-mode results: a single reused pseudoterminal in the terminal panel
 * (dbtool.resultsLocation = "terminal"). Each run clears the screen and
 * renders result sets as box-drawn ANSI tables — NULLs highlighted in bold
 * yellow, numbers right-aligned, errors in red. Columns are shrunk to fit
 * the terminal width when possible.
 */

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
/** The NULL highlight. */
const NULL_STYLE = '\x1b[1;33m';
const CLEAR = '\x1b[2J\x1b[3J\x1b[H';

const MIN_COL = 6;
const MAX_COL = 80;

export class ResultsTerminal {
  private static terminal: vscode.Terminal | undefined;
  private static readonly writeEmitter = new vscode.EventEmitter<string>();
  private static opened = false;
  private static cols = 120;
  /** Output produced before the pty's open() fired (writes before it are dropped). */
  private static pending: string[] = [];

  private static ensure(): void {
    if (this.terminal) return;
    this.opened = false;
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.writeEmitter.event,
      open: (dims) => {
        if (dims) this.cols = dims.columns;
        this.opened = true;
        for (const chunk of this.pending) this.writeEmitter.fire(chunk);
        this.pending = [];
      },
      close: () => {
        this.terminal = undefined;
        this.opened = false;
        this.pending = [];
      },
      setDimensions: (dims) => {
        this.cols = dims.columns;
      },
    };
    this.terminal = vscode.window.createTerminal({
      name: 'Query Results',
      pty,
      iconPath: new vscode.ThemeIcon('table'),
    });
  }

  private static show(text: string): void {
    this.ensure();
    this.terminal!.show(true);
    if (this.opened) this.writeEmitter.fire(text);
    else this.pending.push(text);
  }

  static showResults(meta: ConnectionMeta, outcome: QueryOutcome, maxRows: number): void {
    this.ensure();
    const lines: string[] = [banner(meta, outcome), ''];
    for (const set of outcome.sets) lines.push(...renderSet(set, maxRows, this.cols), '');
    this.show(CLEAR + lines.join('\r\n'));
  }

  static showError(meta: ConnectionMeta, error: unknown): void {
    const e = error as { message?: string; lineNumber?: number; position?: string; code?: string };
    const detail = [
      e?.code ? `Code: ${e.code}` : '',
      e?.lineNumber ? `Line: ${e.lineNumber}` : '',
      e?.position ? `Position: ${e.position}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const lines = [
      envDot(meta) + BOLD + meta.name + RESET,
      '',
      `${RED}${BOLD}Query failed${RESET}`,
      ...String(e?.message ?? error).split(/\r?\n/).map((l) => RED + l + RESET),
    ];
    if (detail) lines.push(DIM + detail + RESET);
    lines.push('');
    this.show(CLEAR + lines.join('\r\n'));
  }
}

/** Truecolor dot in the connection's environment color, when one is set. */
function envDot(meta: ConnectionMeta): string {
  const color = safeColor(meta.color);
  const m = color && /^#([0-9a-fA-F]{6})/.exec(color);
  if (!m) return '';
  const n = parseInt(m[1], 16);
  return `\x1b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m●${RESET} `;
}

function banner(meta: ConnectionMeta, outcome: QueryOutcome): string {
  const totalRows = outcome.sets.reduce((a, s) => a + s.rowCount, 0);
  return (
    envDot(meta) + BOLD + meta.name + RESET + DIM +
    ` · ${outcome.sets.length} result set${outcome.sets.length === 1 ? '' : 's'}` +
    ` · ${totalRows} row${totalRows === 1 ? '' : 's'}` +
    ` · ${outcome.durationMs.toFixed(1)} ms` + RESET
  );
}

/** Cell text with control characters flattened so rows stay on one line. */
function cellText(v: unknown): string {
  return displayText(v).replace(/[\r\n\t]+/g, ' ');
}

function isNum(v: unknown): boolean {
  return typeof v === 'number' || typeof v === 'bigint';
}

function truncate(s: string, width: number): string {
  return s.length > width ? s.slice(0, Math.max(0, width - 1)) + '…' : s;
}

/** Pad `text` to `width`, coloring only the text so alignment ignores ANSI codes. */
function pad(text: string, width: number, right: boolean, style?: string): string {
  const t = truncate(text, width);
  const fill = ' '.repeat(width - t.length);
  const colored = style ? style + t + RESET : t;
  return right ? fill + colored : colored + fill;
}

function renderSet(set: ResultSet, maxRows: number, termCols: number): string[] {
  if (set.columns.length === 0) {
    return [`${DIM}${set.rowCount} row${set.rowCount === 1 ? '' : 's'} ${set.note ?? 'affected'}${RESET}`];
  }
  const shown = set.rows.slice(0, maxRows);
  const texts = shown.map((row) => row.map(cellText));
  const numW = Math.max(1, String(shown.length).length);

  // Natural widths (capped), then shrink the widest columns until the table
  // fits the terminal — down to a floor, after which lines just wrap.
  const widths = set.columns.map((c, i) =>
    Math.min(MAX_COL, Math.max(c.length, ...texts.map((r) => r[i]?.length ?? 0)))
  );
  const overhead = numW + 3 + widths.length * 3 + 1;
  let total = widths.reduce((a, b) => a + b, 0) + overhead;
  while (total > termCols) {
    const widest = Math.max(...widths);
    if (widest <= MIN_COL) break;
    widths[widths.indexOf(widest)]--;
    total--;
  }

  const rule = (l: string, m: string, r: string): string =>
    DIM + l + '─'.repeat(numW + 2) + m + widths.map((w) => '─'.repeat(w + 2)).join(m) + r + RESET;
  const bar = DIM + '│' + RESET;
  const line = (cells: string[]): string => `${bar} ${cells.join(` ${bar} `)} ${bar}`;

  const out: string[] = [];
  if (set.note && set.rowCount === 0 && set.rows.length === 0) {
    out.push(`${DIM}${set.note} — 0 rows${RESET}`);
  }
  out.push(rule('┌', '┬', '┐'));
  out.push(line([pad('#', numW, true, DIM), ...set.columns.map((c, i) => pad(c, widths[i], false, BOLD))]));
  out.push(rule('├', '┼', '┤'));
  shown.forEach((row, r) => {
    const cells = set.columns.map((_, i) => {
      const v = row[i];
      if (v === null || v === undefined) return pad('NULL', widths[i], false, NULL_STYLE);
      return pad(texts[r][i], widths[i], isNum(v));
    });
    out.push(line([pad(String(r + 1), numW, true, DIM), ...cells]));
  });
  out.push(rule('└', '┴', '┘'));
  if (set.rows.length > maxRows) {
    out.push(`${DIM}Showing first ${maxRows} of ${set.rows.length} rows (dbtool.maxRenderRows).${RESET}`);
  }
  return out;
}
