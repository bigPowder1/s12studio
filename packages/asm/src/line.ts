/**
 * Source-line field splitting for the CodeWarrior HC12 assembler:
 *   [label[:]] [operation[.size]] [operands] [;comment]
 *
 * - An identifier starting in column 1 is a label, with or without ':' (manual: "for compatibility ... an
 *   identifier starting on column 1 is considered to be a label, even when it is not terminated by a colon").
 * - A label followed by ':' may be indented.
 * - '*' or ';' in column 1 starts a comment line; ';' anywhere outside a string starts a comment.
 * - Any other character in column 1 → A1604.
 * - Operands may contain blanks (manual: without -Compat=c, `DC.B 1 + 1 , 1` is 2,1,2,1); the operand field
 *   extends to the comment or the end of the line.
 */

export interface ParsedLine {
  label?: { name: string; col: number; colon: boolean };
  /** Operation name as written (without size suffix). */
  /** `size` is the upper-cased size suffix, `sizeRaw` the suffix as written (macro `\0`). */
  op?: { name: string; upper: string; size?: string; sizeRaw?: string; col: number };
  /** Operand text (right-trimmed), possibly empty. */
  operands: string;
  /** 0-based column of the operand text. */
  operandsCol: number;
  /** True for blank / comment-only lines. */
  empty: boolean;
  error?: { code: string; args: string[]; col: number };
}

const ID_START = /[A-Za-z_.]/;
const ID_CHAR = /[A-Za-z0-9_.]/;

/** Index of the ';' that starts the comment, or -1 (quotes are honoured). */
export function commentStart(s: string, from = 0): number {
  let q = '';
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = '';
    } else if (c === "'" || c === '"') q = c;
    else if (c === ';') return i;
  }
  return -1;
}

const isWs = (c: string | undefined): boolean => c === ' ' || c === '\t';

export function parseLine(s: string): ParsedLine {
  const out: ParsedLine = { operands: '', operandsCol: s.length, empty: false };
  if (s.trim() === '' || s[0] === '*' || s[0] === ';') {
    out.empty = true;
    return out;
  }
  let i = 0;
  if (!isWs(s[0])) {
    if (!ID_START.test(s[0])) {
      out.error = { code: 'A1604', args: [s[0]], col: 0 };
      return out;
    }
    let j = 1;
    while (j < s.length && ID_CHAR.test(s[j])) j++;
    const name = s.slice(0, j);
    let colon = false;
    if (s[j] === ':') {
      colon = true;
      j++;
    } else if (j < s.length && !isWs(s[j]) && s[j] !== ';') {
      out.error = { code: 'A1602', args: [name], col: j };
      return out;
    }
    out.label = { name, col: 0, colon };
    i = j;
  } else {
    // Indented label with a colon.
    let j = 0;
    while (isWs(s[j])) j++;
    if (ID_START.test(s[j] ?? '')) {
      let k = j + 1;
      while (k < s.length && ID_CHAR.test(s[k])) k++;
      if (s[k] === ':') {
        out.label = { name: s.slice(j, k), col: j, colon: true };
        i = k + 1;
      }
    }
  }
  while (isWs(s[i])) i++;
  if (i >= s.length || s[i] === ';') return out;
  // Operation field.
  if (!ID_START.test(s[i])) {
    // e.g. a stray character; report as "directive, instruction or macro name expected".
    const end = s.slice(i).search(/[\s;]/);
    const tok = end < 0 ? s.slice(i) : s.slice(i, i + end);
    out.error = { code: 'A1603', args: [tok], col: i };
    return out;
  }
  let j = i + 1;
  while (j < s.length && ID_CHAR.test(s[j])) j++;
  const full = s.slice(i, j);
  let name = full;
  let size: string | undefined;
  let sizeRaw: string | undefined;
  const m = full.match(/^(.+)\.([A-Za-z])$/);
  if (m) {
    name = m[1];
    sizeRaw = m[2];
    size = sizeRaw.toUpperCase();
  }
  out.op = { name, upper: name.toUpperCase(), size, col: i };
  if (sizeRaw !== undefined) out.op.sizeRaw = sizeRaw;
  let k = j;
  while (isWs(s[k])) k++;
  const c = commentStart(s, k);
  const end = c < 0 ? s.length : c;
  out.operands = s.slice(k, end).replace(/[ \t]+$/, '');
  out.operandsCol = k;
  return out;
}

/**
 * Split an operand field at top-level commas (outside quotes, parentheses and brackets). Returns the items
 * with their 0-based start column relative to the field and with surrounding blanks removed.
 */
export function splitOperands(s: string): Array<{ text: string; col: number }> {
  const out: Array<{ text: string; col: number }> = [];
  if (s.trim() === '') return out;
  let depth = 0;
  let q = '';
  let start = 0;
  const push = (end: number) => {
    const raw = s.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    out.push({ text: raw.trim(), col: start + lead });
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = '';
      continue;
    }
    if (c === "'" || c === '"') q = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth <= 0) {
      push(i);
      start = i + 1;
    }
  }
  push(s.length);
  return out;
}
