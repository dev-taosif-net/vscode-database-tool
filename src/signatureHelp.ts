import * as vscode from 'vscode';
import { DbKind } from './types';
import { Catalog, CatalogRoutine } from './catalog';
import { FnDoc, MSSQL_FUNCTIONS, PG_FUNCTIONS } from './sqlData';

/**
 * Parameter hints while typing inside a call: `round(12.345, |` pops the
 * signature with the active parameter highlighted, the short doc, and the
 * return type. Covers the ~250 built-ins (dialect-aware) and every stored
 * procedure / user function from the connected database's catalog.
 */

const PG_BY_NAME = new Map(PG_FUNCTIONS.map((f) => [f[0].toLowerCase(), f]));
const MSSQL_BY_NAME = new Map(MSSQL_FUNCTIONS.map((f) => [f[0].toLowerCase(), f]));

export function registerSignatureHelp(
  ctx: vscode.ExtensionContext,
  activeKind: () => DbKind | undefined,
  activeCatalog: () => Catalog | undefined
): void {
  const provider: vscode.SignatureHelpProvider = {
    provideSignatureHelp(document, position) {
      const start = new vscode.Position(Math.max(0, position.line - 30), 0);
      const text = document.getText(new vscode.Range(start, position));
      const call = findOpenCall(text);
      if (!call) return undefined;

      const kind = activeKind();
      const fn = lookupBuiltin(call.name, kind);
      if (fn) return builtinHelp(fn, call.argIndex);

      const cat = activeCatalog();
      const routine = cat?.routines.find((r) => r.name.toLowerCase() === call.name.toLowerCase());
      if (routine) return routineHelp(routine, call.argIndex);
      return undefined;
    },
  };
  ctx.subscriptions.push(
    vscode.languages.registerSignatureHelpProvider({ language: 'sql' }, provider, '(', ',')
  );
}

// --------------------------------------------------------------- call finder

interface OpenCall {
  name: string;
  argIndex: number;
}

/**
 * Innermost function call still open at the end of `text` and which argument
 * the cursor sits in — one forward scan with a call stack; strings and
 * comments are skipped so commas inside literals don't count.
 */
export function findOpenCall(text: string): OpenCall | undefined {
  const stack: OpenCall[] = [];
  let lastWord = '';
  let i = 0;
  const n = text.length;
  const WORD = /[A-Za-z_][\w$]*/y;
  while (i < n) {
    const ch = text[i];
    if (ch === "'") {
      i++;
      while (i < n && (text[i] !== "'" || text[i + 1] === "'")) i += text[i] === "'" ? 2 : 1;
      i++;
      lastWord = '';
    } else if (ch === '-' && text[i + 1] === '-') {
      while (i < n && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else if (/[A-Za-z_]/.test(ch)) {
      WORD.lastIndex = i;
      lastWord = WORD.exec(text)![0];
      i += lastWord.length;
    } else if (ch === '(') {
      stack.push({ name: lastWord, argIndex: 0 });
      lastWord = '';
      i++;
    } else if (ch === ')') {
      stack.pop();
      lastWord = '';
      i++;
    } else if (ch === ',') {
      if (stack.length) stack[stack.length - 1].argIndex++;
      lastWord = '';
      i++;
    } else if (/\s/.test(ch) || ch === '.') {
      // whitespace between name and paren is fine; a dot resets so that in
      // schema.fn( the captured name is fn, not schema.
      i++;
    } else {
      lastWord = '';
      i++;
    }
  }
  // Deepest frame that belongs to a named call (skip plain grouping parens).
  for (let s = stack.length - 1; s >= 0; s--) {
    if (stack[s].name) return stack[s];
  }
  return undefined;
}

// ------------------------------------------------------------- help builders

function lookupBuiltin(name: string, kind: DbKind | undefined): FnDoc | undefined {
  const key = name.toLowerCase();
  if (kind === 'mssql') return MSSQL_BY_NAME.get(key) ?? PG_BY_NAME.get(key);
  return PG_BY_NAME.get(key) ?? MSSQL_BY_NAME.get(key);
}

/** Split the parenthesized part of a signature into [start,end) label ranges. */
function paramRanges(label: string): [number, number][] {
  const open = label.indexOf('(');
  const close = label.lastIndexOf(')');
  if (open < 0 || close <= open + 1) return [];
  const ranges: [number, number][] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const ch = label[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      ranges.push(trimRange(label, start, i));
      start = i + 1;
    }
  }
  ranges.push(trimRange(label, start, close));
  return ranges;
}

function trimRange(label: string, start: number, end: number): [number, number] {
  while (start < end && label[start] === ' ') start++;
  while (end > start && label[end - 1] === ' ') end--;
  return [start, end];
}

function makeHelp(
  label: string,
  doc: vscode.MarkdownString,
  argIndex: number
): vscode.SignatureHelp {
  const sig = new vscode.SignatureInformation(label, doc);
  const ranges = paramRanges(label);
  sig.parameters = ranges.map(([s, e]) => new vscode.ParameterInformation([s, e]));
  const help = new vscode.SignatureHelp();
  help.signatures = [sig];
  help.activeSignature = 0;
  // Variadic signatures (`...`) keep highlighting their last parameter.
  help.activeParameter = ranges.length ? Math.min(argIndex, ranges.length - 1) : 0;
  return help;
}

function builtinHelp(fn: FnDoc, argIndex: number): vscode.SignatureHelp {
  const [, signature, doc, returns] = fn;
  const md = new vscode.MarkdownString(`${doc}\n\n**Returns:** \`${returns}\``);
  return makeHelp(signature, md, argIndex);
}

function routineHelp(r: CatalogRoutine, argIndex: number): vscode.SignatureHelp {
  const sig = r.signature
    ?? r.params.map((p) => `${p.name} ${p.dataType}${p.output ? ' OUTPUT' : ''}`).join(', ');
  const label = `${r.name}(${sig})`;
  const md = new vscode.MarkdownString(
    `${r.kind === 'procedure' ? 'Stored procedure' : 'User-defined function'} in \`${r.schema}\`.` +
    (r.returns ? `\n\n**Returns:** \`${r.returns}\`` : '')
  );
  return makeHelp(label, md, argIndex);
}
