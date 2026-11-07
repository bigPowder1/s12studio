/**
 * Pure text helpers over HC12 assembly sources (no Monaco): label scan for the editor's Functions popup and the
 * debugger's Find Procedure, INCLUDE scan for the Interfaces popup, line comment toggling, text search.
 */
import { HC12_DIRECTIVES, HC12_MNEMONICS } from './hc12';

export type LabelKind = 'code' | 'data' | 'constant' | 'section' | 'macro' | 'label';

export interface AsmLabel {
  name: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  kind: LabelKind;
}

const DATA_OPS = new Set(['DC', 'DCB', 'DS', 'FCB', 'FDB', 'FQB', 'DCW', 'DCL', 'FCC', 'RMB', 'RMD', 'RMQ', 'RAD50']);
const MNEMONICS = new Set(HC12_MNEMONICS);
const DIRECTIVES = new Set(HC12_DIRECTIVES);

/** Strip a ';' comment (quotes honoured), like @s12/asm commentStart. */
export function stripComment(s: string): string {
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = '';
    } else if (c === "'" || c === '"') q = c;
    else if (c === ';') return s.slice(0, i);
  }
  return s;
}

const LABEL_COL1 = /^([A-Za-z_.][\w.]*)(:?)/;
const LABEL_INDENTED = /^([ \t]+)([A-Za-z_.][\w.]*):/;

/** Split a line into label / operation / operands the way the assembler does (enough for navigation). */
export function splitFields(line: string): { label?: { name: string; column: number }; op?: string; operands: string } {
  if (line === '' || line[0] === '*' || line[0] === ';') return { operands: '' };
  const s = stripComment(line);
  let rest = s;
  let label: { name: string; column: number } | undefined;
  let m = LABEL_COL1.exec(s);
  if (m) {
    label = { name: m[1], column: 1 };
    rest = s.slice(m[0].length);
  } else if ((m = LABEL_INDENTED.exec(s))) {
    label = { name: m[2], column: m[1].length + 1 };
    rest = s.slice(m[0].length);
  }
  const op = /^[ \t]*([A-Za-z_][\w]*)(?:\.[A-Za-z]+)?/.exec(rest);
  if (!op) return { label, operands: '' };
  return { label, op: op[1].toUpperCase(), operands: rest.slice(op[0].length).trim() };
}

function kindOf(op: string | undefined): LabelKind {
  if (!op) return 'code';
  if (op === 'EQU' || op === 'SET') return 'constant';
  if (op === 'SECTION' || op === 'ORG') return 'section';
  if (op === 'MACRO') return 'macro';
  if (DATA_OPS.has(op)) return 'data';
  if (MNEMONICS.has(op)) return 'code';
  if (DIRECTIVES.has(op)) return 'label';
  return 'code'; // macro call
}

/**
 * Labels defined in a source, in file order. A label alone on its line takes the kind of the next statement
 * (`state0:` followed by `clr RX_FLAG` is code).
 */
export function scanLabels(text: string): AsmLabel[] {
  const lines = text.split(/\r?\n/);
  const out: AsmLabel[] = [];
  let pendingAlone: AsmLabel[] = [];
  for (let i = 0; i < lines.length; i++) {
    const f = splitFields(lines[i]);
    if (f.label) {
      const l: AsmLabel = { name: f.label.name, line: i + 1, column: f.label.column, kind: kindOf(f.op) };
      out.push(l);
      if (!f.op) pendingAlone.push(l);
      else pendingAlone = [];
    } else if (f.op && pendingAlone.length) {
      for (const p of pendingAlone) p.kind = kindOf(f.op);
      pendingAlone = [];
    }
  }
  return out;
}

export interface AsmInclude {
  file: string;
  line: number;
}

/** INCLUDE directives (the editor's Interfaces popup). */
export function scanIncludes(text: string): AsmInclude[] {
  const out: AsmInclude[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const f = splitFields(lines[i]);
    if (f.op !== 'INCLUDE') continue;
    const m = /^(['"])(.*?)\1/.exec(f.operands) ?? /^(\S+)()/.exec(f.operands);
    if (m) out.push({ file: m[2] || m[1], line: i + 1 });
  }
  return out;
}

export type CommentMode = 'comment' | 'uncomment' | 'toggle';

/**
 * Line comments for assembly: comment = ';' inserted at column 1; uncomment = remove the first ';' when it is the
 * first non-blank character. 'toggle' uncomments when every non-blank line is commented, else comments.
 * Returns the new lines (same count).
 */
export function commentLines(lines: readonly string[], mode: CommentMode): string[] {
  const isCommented = (l: string) => /^[ \t]*;/.test(l);
  let m = mode;
  if (m === 'toggle') {
    const nonBlank = lines.filter((l) => l.trim() !== '');
    m = nonBlank.length > 0 && nonBlank.every(isCommented) ? 'uncomment' : 'comment';
  }
  if (m === 'comment') return lines.map((l) => (l.trim() === '' ? l : ';' + l));
  return lines.map((l) => (isCommented(l) ? l.replace(/^([ \t]*);/, '$1') : l));
}

export interface TextSearchOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export interface TextMatch {
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  length: number;
  /** Line text. */
  text: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Build the search regex (global). Throws on an invalid user regex. */
export function searchRegex(query: string, o: TextSearchOptions = {}): RegExp {
  let src = o.regex ? query : escapeRe(query);
  if (o.wholeWord) src = `(?<![\\w.])(?:${src})(?![\\w.])`;
  return new RegExp(src, o.matchCase ? 'g' : 'gi');
}

/** All matches of `query` in `text` (Find in Files). Empty query: no matches. */
export function findInText(text: string, query: string, o: TextSearchOptions = {}, limit = 10000): TextMatch[] {
  if (!query) return [];
  const re = searchRegex(query, o);
  const out: TextMatch[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lines[i])) && out.length < limit) {
      out.push({ line: i + 1, column: m.index + 1, length: m[0].length, text: lines[i] });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return out;
}

/** Simple glob for file masks ("*.asm;*.inc"). */
export function maskMatcher(mask: string): (name: string) => boolean {
  const parts = mask
    .split(/[;,]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return () => true;
  const res = parts.map((p) => new RegExp('^' + p.split('*').map((x) => x.split('?').map(escapeRe).join('.')).join('.*') + '$', 'i'));
  return (name) => res.some((r) => r.test(name));
}
