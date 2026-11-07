/**
 * `.lst` writer, exact CodeWarrior "HC12-Assembler" V-5.0.30 layout (docs/research/r2/critique.md G1, verified
 * byte-for-byte against fixtures/Lab3/bin/main.lst and fixtures/blank_project/bin/main.lst).
 *
 * - CRLF line ends; every page = 6 header lines + 64 body lines; page 2+ start with a line holding "\f" (the
 *   form feed replaces the first, empty header line).
 * - Body line: `%5d` Abs, `%5s` Rel (+ 'i'/'m' suffix), 2 blanks, 'a' (absolute section) or blank, `%06X` Loc,
 *   blank, object field (11 chars: `HHHH HHHH`, unresolved nibbles as 'x'), marker ('+' for macro expansion,
 *   else blank), source text.
 * - More than 4 object bytes continue on lines of 13 blanks + Loc + blank + object field (31 chars, no source); the
 *   13 blanks are the Abs./Rel./location-type columns, so they shrink with -Lasmc, and Loc follows -Lasms.
 * - EQU/SET/IF lines show the 32-bit value (`0000 00F1`) in the object field and no Loc.
 */
import type { Stmt } from './types.js';

export interface ListingOptions {
  /** -Lasmc flags: columns not written (s r m l k i c a). */
  lasmc?: string;
  /** -Lasms{1..4}: digits of the Loc column = 2*n (default 3 → 6). */
  lasms?: 1 | 2 | 3 | 4;
}

const HEADER = ['', 'Freescale HC12-Assembler ', '(c) Copyright Freescale 1987-2010', '', '', ''];

/**
 * Listing columns, in order, with their header texts. With the default options this reproduces the golden header
 * ` Abs. Rel.   Loc    Obj. code   Source line` / ` ---- ----   ------ ---------   -----------` exactly.
 * -Lasmc=<flags> drops columns: a = Abs., r = Rel., i = include/macro mark ('i'/'m' after Rel.), k = location type
 * ('a' flag), l = Loc, c = object code, m = macro mark ('+'), s = source.
 * UNCERTAIN: the manual (Listing 5.32, `-Lasmc=ramki`) only shows that the dropped columns disappear; its extracted text
 * lost the blanks, so the exact spacing of reduced listings and the Loc column with -Lasms1 (kept 3 wide for the
 * "Loc" header) are guesses: every column keeps its default width and the column separators belong to the column before
 * them (the 2 blanks after Rel. are dropped with Abs./Rel./mark; the blank after Loc with Loc).
 */
interface Columns {
  abs: boolean;
  rel: boolean;
  incl: boolean;
  kind: boolean;
  loc: boolean;
  obj: boolean;
  mark: boolean;
  src: boolean;
  digits: number;
  /** Width of the Loc column: the digits, but at least the 3 characters of the "Loc" header. */
  locWidth: number;
}

function columns(opts: ListingOptions): Columns {
  const f = (opts.lasmc ?? '').toLowerCase();
  return {
    abs: !f.includes('a'),
    rel: !f.includes('r'),
    incl: !f.includes('i'),
    kind: !f.includes('k'),
    loc: !f.includes('l'),
    obj: !f.includes('c'),
    mark: !f.includes('m'),
    src: !f.includes('s'),
    digits: 2 * (opts.lasms ?? 3),
    // UNCERTAIN: manual Listings 5.23/5.24 show the same "Loc" header with -Lasms1; the 2 address digits are
    // assumed left-aligned in a 3-wide column.
    locWidth: Math.max(3, 2 * (opts.lasms ?? 3)),
  };
}

/** Width of the Abs./Rel./mark group (including its 2 trailing blanks) and of the location-type column. */
function leadWidth(c: Columns): number {
  const relW = c.rel ? 5 : c.incl ? 1 : 0;
  const group = (c.abs ? 5 : 0) + relW;
  return (group > 0 ? group + 2 : 0) + (c.kind ? 1 : 0);
}

function headerLines(c: Columns): [string, string] {
  let h = '';
  let d = '';
  const add = (text: string, dash: string) => {
    h += text;
    d += dash;
  };
  if (c.abs) add(' Abs.', ' ----');
  if (c.rel) add(' Rel.', ' ----');
  else if (c.incl) add(' ', ' ');
  if (c.abs || c.rel || c.incl) add('  ', '  ');
  if (c.kind) add(' ', ' ');
  if (c.loc) add('Loc'.padEnd(c.locWidth) + ' ', '-'.repeat(c.locWidth) + ' ');
  if (c.obj) add('Obj. code  ', '---------  ');
  if (c.mark) add(' ', ' ');
  if (c.src) add('Source line', '-----------');
  return [h, d];
}

/** UNCERTAIN: PLEN n gives n-1 body lines (the default PLEN 65 of the manual yields the observed 64). */
const DEFAULT_BODY_LINES = 64;

/** Address in `digits` hex digits (keeping the low digits). */
const hexLoc = (a: number, digits: number): string => (a >>> 0).toString(16).toUpperCase().padStart(digits, '0').slice(-digits);

const hex2 = (b: number): string => b.toString(16).toUpperCase().padStart(2, '0');

/** Object field: pairs of bytes separated by a blank; unresolved bytes as 'xx'. */
export function formatObject(bytes: number[], xmask: boolean[] | undefined, start: number, count: number): string {
  let s = '';
  for (let i = 0; i < count; i++) {
    const k = start + i;
    if (i === 2) s += ' ';
    s += xmask?.[k] ? 'xx' : hex2(bytes[k]);
  }
  return s;
}

const value32 = (v: number): string => {
  const u = v >>> 0;
  return `${(u >>> 16).toString(16).toUpperCase().padStart(4, '0')} ${(u & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
};

function expandTabs(s: string, tabs: number): string {
  if (!s.includes('\t') || tabs <= 0) return tabs <= 0 ? s.replace(/\t/g, '') : s;
  let out = '';
  for (const c of s) {
    if (c === '\t') {
      const n = tabs - (out.length % tabs);
      out += ' '.repeat(n);
    } else out += c;
  }
  return out;
}

/** Render the listing from the assembled statements. */
export function writeListing(stmts: readonly Stmt[], opts: ListingOptions = {}): string {
  const out: string[] = [];
  const col = columns(opts);
  const digits = col.digits;
  const locW = col.locWidth;
  const [hdr, dashes] = headerLines(col);
  const lead = ' '.repeat(leadWidth(col));
  let body = DEFAULT_BODY_LINES;
  let tabs = 8; // UNCERTAIN: TAB expansion in the source column (TABS default 8)
  let llen: number | undefined;
  let title = '';
  let paging = true;
  let onPage = -1; // -1 = no page started yet
  let forceBreak = false;
  const header = (first: boolean) => {
    const h = [...HEADER];
    h[0] = title;
    h[4] = hdr;
    h[5] = dashes;
    if (!first) h[0] = '\f' + h[0];
    out.push(...h);
  };
  const emit = (line: string) => {
    if (onPage < 0) {
      header(true);
      onPage = 0;
    } else if (paging && (onPage >= body || forceBreak)) {
      header(false);
      onPage = 0;
    }
    forceBreak = false;
    out.push(line);
    onPage++;
  };

  for (const st of stmts) {
    const ctl = st.listCtl;
    if (ctl) {
      if (ctl.plen !== undefined) body = Math.max(1, ctl.plen - 1);
      if (ctl.llen !== undefined) llen = ctl.llen;
      if (ctl.tabs !== undefined) tabs = ctl.tabs;
      if (ctl.title !== undefined) title = ctl.title;
      if (ctl.nopage) paging = false;
      if (ctl.page && onPage > 0) forceBreak = true;
      if (ctl.spc) for (let i = 0; i < ctl.spc; i++) emit('');
    }
    if (!st.listed) continue;
    let locField = ' '.repeat(locW + 1);
    let obj = '';
    const bytes = st.bytes ?? [];
    const showBytes = !st.skipped && bytes.length > 0;
    if (!st.skipped && st.showLoc && st.section) {
      const isAbs = st.section.kind === 'org';
      locField = (isAbs ? 'a' : ' ') + hexLoc(st.loc, digits).padEnd(locW);
    }
    if (!st.skipped && st.listValue !== undefined) obj = value32(st.listValue);
    if (showBytes) obj = formatObject(bytes, st.xmask, 0, Math.min(4, bytes.length));
    let src = expandTabs(st.text, tabs);
    if (llen !== undefined) src = src.slice(0, llen);
    let line = '';
    if (col.abs) line += String(st.absLine).padStart(5);
    if (col.rel) line += (String(st.line) + (col.incl ? st.suffix : '')).padStart(5);
    else if (col.incl) line += st.suffix || ' ';
    if (col.abs || col.rel || col.incl) line += '  ';
    if (col.kind) line += locField[0];
    if (col.loc) line += locField.slice(1) + ' ';
    if (col.obj) line += obj.padEnd(11);
    if (col.mark) line += st.macroExp ? '+' : ' ';
    if (col.src) line += src;
    emit(line);
    // UNCERTAIN: with the object-code column switched off (-Lasmc=c) the continuation lines are not written.
    if (showBytes && col.obj) {
      for (let k = 4; k < bytes.length; k += 4) {
        const loc = col.loc ? hexLoc(st.loc + k, digits).padEnd(locW) + ' ' : '';
        const o = formatObject(bytes, st.xmask, k, Math.min(4, bytes.length - k));
        emit(`${lead}${loc}${o.padEnd(11)}`);
      }
    }
  }
  if (onPage < 0) header(true);
  return out.join('\r\n') + '\r\n';
}

/** Render the .dbg file: every line with an Abs. number, CRLF terminated. */
export function writeDbg(stmts: readonly Stmt[]): string {
  const lines: string[] = [];
  for (const st of stmts) if (st.absLine) lines.push(st.text);
  return lines.length ? lines.join('\r\n') + '\r\n' : '';
}
