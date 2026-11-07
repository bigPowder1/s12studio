// SmartLinker parameter file (.prm) parser. Spec: docs/research/r1/asm.md §8 (BTU Ch. 6 EBNF).
// Produces an AST; it does not perform placement. Comments: /* */, //, (* *). Numbers: 0x hex, leading-0 octal, decimal.
// Keywords are matched case-insensitively (UNCERTAIN: SmartLinker may require upper case); names are case-sensitive.

export interface PrmPos {
  line: number;
  col: number;
  /** set on positions inside an INCLUDEd file (the name as written after INCLUDE); absent for the main file */
  file?: string;
}

export interface PrmError extends PrmPos {
  message: string;
}

export type PrmQualifier = 'READ_ONLY' | 'READ_WRITE' | 'NO_INIT' | 'PAGED' | 'CODE';

export interface PrmAlign {
  /** default alignment (number after ALIGN), if given */
  defaultAlignment?: number;
  /** raw `[range: alignment]` specs, e.g. "[1:1]" */
  rules: string[];
}

export interface PrmSegment extends PrmPos {
  name: string;
  /** first qualifier */
  qualifier: PrmQualifier;
  /** all qualifiers in order (normally one) */
  qualifiers: PrmQualifier[];
  dataModel?: 'DATA_NEAR' | 'DATA_FAR';
  ibcc?: 'IBCC_NEAR' | 'IBCC_FAR';
  start: number;
  /** inclusive end address */
  end: number;
  size: number;
  /** how the range was written */
  rangeForm: 'TO' | 'SIZE';
  relocateTo?: number;
  align?: PrmAlign;
  fill?: number[];
  overlapConsts?: { mode: 'DO_OVERLAP_CONSTS' | 'DO_NOT_OVERLAP_CONSTS'; target: string };
}

export interface PrmPlacement extends PrmPos {
  sections: string[];
  distribute: boolean;
  segments: string[];
  /** `sec INTO READ_ONLY 0x.. TO 0x..;` form */
  inlineSegment?: PrmSegment;
}

export interface PrmVector extends PrmPos {
  form: 'number' | 'address';
  /** vector number for `VECTOR n` */
  number?: number;
  /** vector table address: explicit, or 0xFFFE - 2n on HC12 */
  address: number;
  /** function name or numeric value */
  target: string | number;
  offset?: number;
}

export interface PrmDependency extends PrmPos {
  kind: 'ROOT' | 'USES' | 'ADDUSE' | 'DELUSE';
  object?: string;
  names: string[];
}

export interface PrmCommandRef extends PrmPos {
  keyword: string;
}

export interface PrmFile {
  link?: string;
  names: string[];
  segments: PrmSegment[];
  /** true when the old `SECTIONS` keyword was used instead of `SEGMENTS` */
  oldSectionsSyntax: boolean;
  placements: PrmPlacement[];
  entries: string[];
  stackSize?: number;
  stackTop?: number;
  init?: string;
  main?: string;
  vectors: PrmVector[];
  hexFile?: { file: string; offset?: number };
  objectFile?: string;
  mapFile: string[];
  dependencies: PrmDependency[];
  overlapGroups: string[][];
  includes: string[];
  /** commands without a dedicated field (CHECKSUM, HAS_BANKED_DATA, START, DATA, PRESTART, ...) with raw words */
  other: { keyword: string; words: string[]; line: number; col: number }[];
  /** every top-level command in file order */
  commands: PrmCommandRef[];
  errors: PrmError[];
}

export interface PrmParseOptions {
  /** resolve `INCLUDE file` to its text; if omitted, INCLUDE is recorded but not expanded */
  include?: (file: string) => string | undefined;
  /** HC12 vector-number base: address = vectorBase - 2n. Default 0xFFFE */
  vectorBase?: number;
}

export class PrmSyntaxError extends Error {
  constructor(readonly errors: PrmError[]) {
    super(errors.map((e) => `${e.file ? e.file + ':' : 'line '}${e.line}:${e.col}: ${e.message}`).join('\n'));
  }
}

// ------------------------------------------------------------------ lexer
interface Tok extends PrmPos {
  kind: 'word' | 'string' | 'punct';
  text: string;
}

const PUNCT = new Set(['=', ';', ',']);

function lex(src: string, errors: PrmError[], file?: string): Tok[] {
  const out: Tok[] = [];
  let i = 0, line = 1, lineStart = 0;
  const pos = (at: number): PrmPos => (file === undefined ? { line, col: at - lineStart + 1 } : { line, col: at - lineStart + 1, file });
  const nl = (at: number) => {
    line++;
    lineStart = at + 1;
  };
  const startsComment = (k: number) =>
    (src[k] === '/' && (src[k + 1] === '*' || src[k + 1] === '/')) || (src[k] === '(' && src[k + 1] === '*');
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      nl(i);
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if ((c === '/' && src[i + 1] === '*') || (c === '(' && src[i + 1] === '*')) {
      const close = c === '/' ? '*/' : '*)';
      const p = pos(i);
      const end = src.indexOf(close, i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (let k = i; k < stop; k++) if (src[k] === '\n') nl(k);
      if (end < 0) errors.push({ ...p, message: 'unterminated comment' });
      i = stop;
      continue;
    }
    if (c === '"') {
      const p = pos(i);
      let j = i + 1;
      while (j < src.length && src[j] !== '"' && src[j] !== '\n') j++;
      if (src[j] !== '"') errors.push({ ...p, message: 'unterminated string' });
      out.push({ kind: 'string', text: src.slice(i + 1, j), ...p });
      i = src[j] === '"' ? j + 1 : j;
      continue;
    }
    if (PUNCT.has(c)) {
      out.push({ kind: 'punct', text: c, ...pos(i) });
      i++;
      continue;
    }
    const p = pos(i);
    let j = i;
    while (j < src.length && !/\s/.test(src[j]) && !PUNCT.has(src[j]) && src[j] !== '"' && !(j > i && startsComment(j))) j++;
    if (j === i) j = i + 1;
    out.push({ kind: 'word', text: src.slice(i, j), ...p });
    i = j;
  }
  return out;
}

export function parsePrmNumber(text: string): number | undefined {
  const m = /^([+-]?)(0[xX][0-9A-Fa-f]+|0[0-7]*|[1-9][0-9]*)$/.exec(text);
  if (!m) return undefined;
  const body = m[2];
  const v = /^0[xX]/.test(body) ? parseInt(body.slice(2), 16) : body.length > 1 && body[0] === '0' ? parseInt(body.slice(1), 8) : parseInt(body, 10);
  return m[1] === '-' ? -v : v;
}

// ------------------------------------------------------------------ parser
const QUALIFIERS = new Set<PrmQualifier>(['READ_ONLY', 'READ_WRITE', 'NO_INIT', 'PAGED', 'CODE']);
const MAP_OPTIONS = new Set([
  'ALL', 'NONE', 'ON', 'OFF', 'TARGET', 'FILE', 'STARTUP', 'STARTUP_STRUCT', 'SEC_ALLOC', 'OBJ_ALLOC', 'SORTED_OBJECT_LIST',
  'OBJ_DEP', 'OBJ_UNUSED', 'COPYDOWN', 'OVERLAP_TREE', 'STATISTIC', 'MODULE_STATISTIC', 'DEPENDENCY_TREE',
]);
const SEG_OPTIONS = new Set(['RELOCATE_TO', 'ALIGN', 'FILL', 'DO_OVERLAP_CONSTS', 'DO_NOT_OVERLAP_CONSTS']);
const TOP_KEYWORDS = new Set([
  'LINK', 'NAMES', 'SEGMENTS', 'SECTIONS', 'PLACEMENT', 'ENTRIES', 'STACKSIZE', 'STACK', 'STACKTOP', 'INIT', 'MAIN', 'VECTOR',
  'HEXFILE', 'OBJECTFILE', 'MAPFILE', 'DEPENDENCY', 'OVERLAP_GROUP', 'CHECKSUM', 'INCLUDE', 'HAS_BANKED_DATA', 'START',
  'DATA', 'PRESTART', 'END',
]);

const MAX_INCLUDES = 64;

class Parser {
  i = 0;
  includeCount = 0;
  constructor(readonly t: Tok[], readonly ast: PrmFile, readonly opts: PrmParseOptions) {}

  peek(k = 0): Tok | undefined { return this.t[this.i + k]; }
  next(): Tok | undefined { return this.t[this.i++]; }
  kw(tok: Tok | undefined): string { return tok && tok.kind === 'word' ? tok.text.toUpperCase() : ''; }
  isKw(tok: Tok | undefined, k: string) { return this.kw(tok) === k; }
  isPunct(tok: Tok | undefined, p: string) { return !!tok && tok.kind === 'punct' && tok.text === p; }
  lastPos(): PrmPos {
    const t: PrmPos = this.t[Math.min(this.i, this.t.length - 1)] ?? { line: 1, col: 1 };
    return t.file === undefined ? { line: t.line, col: t.col } : { line: t.line, col: t.col, file: t.file };
  }
  err(at: PrmPos | undefined, message: string) {
    const p = at ?? this.lastPos();
    this.ast.errors.push(p.file === undefined ? { line: p.line, col: p.col, message } : { line: p.line, col: p.col, file: p.file, message });
  }
  /** skip to just after the next ';' (or before END) */
  recover() {
    while (this.i < this.t.length) {
      const tok = this.t[this.i];
      if (this.isPunct(tok, ';')) {
        this.i++;
        return;
      }
      if (this.isKw(tok, 'END')) return;
      this.i++;
    }
  }
  number(what: string): number | undefined {
    const tok = this.next();
    const v = tok && tok.kind === 'word' ? parsePrmNumber(tok.text) : undefined;
    if (v === undefined) this.err(tok, `expected ${what} (number), found ${tok ? JSON.stringify(tok.text) : 'end of file'}`);
    return v;
  }
  name(what: string): string | undefined {
    const tok = this.next();
    if (!tok || tok.kind === 'punct') {
      this.err(tok, `expected ${what}`);
      if (tok) this.i--;
      return undefined;
    }
    return tok.text;
  }
  /** words until END (consumed); commas are separators */
  wordsUntilEnd(block: string): Tok[] {
    const out: Tok[] = [];
    const start = this.lastPos();
    for (;;) {
      const tok = this.next();
      if (!tok) {
        this.err(start, `missing END for ${block}`);
        return out;
      }
      if (this.isKw(tok, 'END')) return out;
      if (tok.kind === 'punct') continue;
      out.push(tok);
    }
  }

  run() {
    while (this.i < this.t.length) {
      const tok = this.next()!;
      if (tok.kind === 'punct') {
        if (tok.text !== ';') this.err(tok, `unexpected '${tok.text}'`);
        continue;
      }
      const k = this.kw(tok);
      this.ast.commands.push({ keyword: k, line: tok.line, col: tok.col });
      switch (k) {
        case 'LINK': {
          const n = this.name('output file name');
          if (n !== undefined) this.ast.link = n;
          // optional `AS ROM_LIB`
          if (this.isKw(this.peek(), 'AS')) {
            this.next();
            this.next();
          }
          break;
        }
        case 'NAMES':
          for (const w of this.wordsUntilEnd('NAMES')) this.ast.names.push(w.text);
          break;
        case 'SEGMENTS':
          this.segments(false);
          break;
        case 'SECTIONS':
          this.ast.oldSectionsSyntax = true;
          this.segments(true);
          break;
        case 'PLACEMENT':
          this.placement();
          break;
        case 'ENTRIES':
          for (const w of this.wordsUntilEnd('ENTRIES')) this.ast.entries.push(w.text);
          break;
        case 'STACKSIZE':
        case 'STACK': {
          const v = this.number('stack size');
          if (v !== undefined) this.ast.stackSize = v;
          break;
        }
        case 'STACKTOP': {
          const v = this.number('stack top');
          if (v !== undefined) this.ast.stackTop = v;
          break;
        }
        case 'INIT': {
          const n = this.name('INIT function');
          if (n !== undefined) this.ast.init = n;
          break;
        }
        case 'MAIN': {
          const n = this.name('MAIN function');
          if (n !== undefined) this.ast.main = n;
          break;
        }
        case 'VECTOR':
          this.vector(tok);
          break;
        case 'HEXFILE': {
          const f = this.name('hex file name');
          if (f === undefined) break;
          let offset: number | undefined;
          if (this.isKw(this.peek(), 'OFFSET')) {
            this.next();
            offset = this.number('offset');
          }
          this.ast.hexFile = { file: f, offset };
          break;
        }
        case 'OBJECTFILE': {
          const f = this.name('object file name');
          if (f !== undefined) this.ast.objectFile = f;
          break;
        }
        case 'MAPFILE': {
          let n = 0;
          while (this.peek() && (MAP_OPTIONS.has(this.kw(this.peek())) || this.isPunct(this.peek(), ','))) {
            const w = this.next()!;
            if (w.kind === 'word') {
              this.ast.mapFile.push(w.text.toUpperCase());
              n++;
            }
          }
          if (n === 0) this.err(this.peek() ?? tok, 'MAPFILE expects at least one option');
          break;
        }
        case 'DEPENDENCY':
          this.dependency(tok);
          break;
        case 'OVERLAP_GROUP':
          this.ast.overlapGroups.push(this.wordsUntilEnd('OVERLAP_GROUP').map((w) => w.text));
          break;
        case 'CHECKSUM':
          this.ast.other.push({ keyword: k, words: this.balancedBlock('CHECKSUM', ['CHECKSUM_ENTRY']), line: tok.line, col: tok.col });
          break;
        case 'INCLUDE': {
          const f = this.name('include file');
          if (f === undefined) break;
          this.ast.includes.push(f);
          if (++this.includeCount > MAX_INCLUDES) {
            this.err(tok, `too many INCLUDEs (> ${MAX_INCLUDES}); recursive include of ${f}?`);
            break;
          }
          const text = this.opts.include?.(f);
          if (text !== undefined) {
            const sub = lex(text, this.ast.errors, f);
            this.t.splice(this.i, 0, ...sub);
          }
          break;
        }
        case 'HAS_BANKED_DATA':
          this.ast.other.push({ keyword: k, words: [], line: tok.line, col: tok.col });
          break;
        case 'START':
        case 'DATA':
        case 'PRESTART': {
          // old-style commands: take the remaining words on the same line. UNCERTAIN exact grammar.
          const words: string[] = [];
          while (this.peek() && this.peek()!.line === tok.line && !this.isPunct(this.peek(), ';')) words.push(this.next()!.text);
          this.ast.other.push({ keyword: k, words, line: tok.line, col: tok.col });
          break;
        }
        case 'END':
          this.err(tok, 'END without a matching block');
          break;
        default:
          this.err(tok, `unknown command ${JSON.stringify(tok.text)}`);
          this.ast.commands.pop();
          // skip the rest of the line
          while (this.peek() && this.peek()!.line === tok.line) this.next();
      }
    }
  }

  balancedBlock(name: string, openers: string[]): string[] {
    const words: string[] = [];
    let depth = 1;
    const start = this.lastPos();
    while (depth > 0) {
      const tok = this.next();
      if (!tok) {
        this.err(start, `missing END for ${name}`);
        break;
      }
      const k = this.kw(tok);
      if (openers.includes(k)) depth++;
      if (k === 'END') {
        depth--;
        if (depth === 0) break;
      }
      words.push(tok.text);
    }
    return words;
  }

  segments(old: boolean) {
    for (;;) {
      const tok = this.peek();
      if (!tok) {
        if (!old) this.err(this.lastPos(), 'missing END for SEGMENTS');
        return;
      }
      if (this.isKw(tok, 'END')) {
        this.next();
        return;
      }
      if (old && this.isKw(tok, 'PLACEMENT')) return;
      if (this.isPunct(tok, ';') || this.isPunct(tok, ',')) {
        this.next();
        continue;
      }
      const seg = this.segmentDef();
      if (seg) this.ast.segments.push(seg);
    }
  }

  /** `name = qualifiers... start TO end | SIZE n [options] ;` */
  segmentDef(): PrmSegment | undefined {
    const nameTok = this.next()!;
    if (nameTok.kind !== 'word') {
      this.err(nameTok, 'expected segment name');
      this.recover();
      return undefined;
    }
    if (!this.isPunct(this.peek(), '=')) {
      this.err(this.peek() ?? nameTok, `expected '=' after segment name ${nameTok.text}`);
      this.recover();
      return undefined;
    }
    this.next();
    const body = this.segmentBody(nameTok.text, nameTok);
    if (!body) {
      this.recover();
      return undefined;
    }
    if (this.isPunct(this.peek(), ';')) this.next();
    else if (!this.isKw(this.peek(), 'END')) {
      this.err(this.peek() ?? this.lastPos(), `expected ';' after segment ${nameTok.text}`);
      this.recover();
    }
    return body;
  }

  segmentBody(name: string, at: PrmPos): PrmSegment | undefined {
    const qualifiers: PrmQualifier[] = [];
    let dataModel: PrmSegment['dataModel'];
    let ibcc: PrmSegment['ibcc'];
    for (;;) {
      const k = this.kw(this.peek());
      if (QUALIFIERS.has(k as PrmQualifier)) qualifiers.push(k as PrmQualifier);
      else if (k === 'DATA_NEAR' || k === 'DATA_FAR') dataModel = k;
      else if (k === 'IBCC_NEAR' || k === 'IBCC_FAR') ibcc = k;
      else break;
      this.next();
    }
    if (qualifiers.length === 0) {
      this.err(this.peek() ?? at, `segment ${name}: expected READ_ONLY, READ_WRITE, NO_INIT, PAGED or CODE`);
      return undefined;
    }
    const start = this.number(`segment ${name} start address`);
    if (start === undefined) return undefined;
    const rk = this.kw(this.peek());
    let end: number | undefined;
    let size: number | undefined;
    let rangeForm: 'TO' | 'SIZE';
    if (rk === 'TO') {
      this.next();
      end = this.number(`segment ${name} end address`);
      if (end === undefined) return undefined;
      size = end - start + 1;
      rangeForm = 'TO';
      if (end < start) this.err(at, `segment ${name}: end 0x${end.toString(16)} below start 0x${start.toString(16)}`);
    } else if (rk === 'SIZE') {
      this.next();
      size = this.number(`segment ${name} size`);
      if (size === undefined) return undefined;
      end = start + size - 1;
      rangeForm = 'SIZE';
    } else {
      this.err(this.peek() ?? at, `segment ${name}: expected TO or SIZE`);
      return undefined;
    }
    const seg: PrmSegment = { name, qualifier: qualifiers[0], qualifiers, dataModel, ibcc, start, end, size, rangeForm, line: at.line, col: at.col };
    // options in any order
    for (;;) {
      const k = this.kw(this.peek());
      if (!SEG_OPTIONS.has(k)) break;
      const optTok = this.next()!;
      if (k === 'RELOCATE_TO') seg.relocateTo = this.number('RELOCATE_TO address');
      else if (k === 'ALIGN') {
        const align: PrmAlign = { rules: [] };
        const p = this.peek();
        if (p && p.kind === 'word' && parsePrmNumber(p.text) !== undefined) align.defaultAlignment = parsePrmNumber(this.next()!.text);
        // bracketed rules: words starting with '[' up to the one ending with ']'
        while (this.peek()?.kind === 'word' && this.peek()!.text.startsWith('[')) {
          let rule = '';
          for (;;) {
            const w = this.next();
            if (!w || w.kind !== 'word') {
              this.err(optTok, 'unterminated ALIGN rule');
              break;
            }
            rule += (rule ? ' ' : '') + w.text;
            if (w.text.endsWith(']')) break;
          }
          align.rules.push(rule);
        }
        seg.align = align;
      } else if (k === 'FILL') {
        const fill: number[] = [];
        while (this.peek()?.kind === 'word' && parsePrmNumber(this.peek()!.text) !== undefined) fill.push(parsePrmNumber(this.next()!.text)!);
        if (fill.length === 0) this.err(optTok, 'FILL expects at least one byte value');
        seg.fill = fill;
      } else {
        const target = this.name(`${k} target (CODE or DATA)`);
        if (target !== undefined) seg.overlapConsts = { mode: k as 'DO_OVERLAP_CONSTS', target: target.toUpperCase() };
      }
    }
    return seg;
  }

  /**
   * After INTO: is this an inline segment definition (`INTO READ_ONLY 0x4000 TO 0x7FFF`) rather than a segment list?
   * Only if qualifier / DATA_* / IBCC_* words are followed by a number; otherwise a segment may simply be named
   * CODE, PAGED, READ_ONLY, ... (keyword names are matched case-insensitively).
   */
  inlineSegmentAhead(): boolean {
    let k = 0;
    let quals = 0;
    for (;;) {
      const w = this.kw(this.peek(k));
      if (QUALIFIERS.has(w as PrmQualifier)) quals++;
      else if (!(w === 'DATA_NEAR' || w === 'DATA_FAR' || w === 'IBCC_NEAR' || w === 'IBCC_FAR')) break;
      k++;
    }
    const t = this.peek(k);
    return quals > 0 && !!t && t.kind === 'word' && parsePrmNumber(t.text) !== undefined;
  }

  placement() {
    for (;;) {
      const tok = this.peek();
      if (!tok) {
        this.err(this.lastPos(), 'missing END for PLACEMENT');
        return;
      }
      if (this.isKw(tok, 'END')) {
        this.next();
        return;
      }
      if (this.isPunct(tok, ';')) {
        this.next();
        continue;
      }
      const at = { line: tok.line, col: tok.col };
      const sections: string[] = [];
      let into = '';
      for (;;) {
        const t = this.next();
        if (!t) break;
        const k = this.kw(t);
        if (k === 'INTO' || k === 'DISTRIBUTE_INTO') {
          into = k;
          break;
        }
        if (k === 'END' || this.isPunct(t, ';')) {
          this.i--;
          break;
        }
        if (t.kind === 'punct') {
          if (t.text !== ',') this.err(t, `unexpected '${t.text}' in placement`);
          continue;
        }
        sections.push(t.text);
      }
      if (!into) {
        this.err(at, `placement of ${sections.join(', ') || '?'}: expected INTO or DISTRIBUTE_INTO`);
        this.recover();
        continue;
      }
      if (sections.length === 0) this.err(at, 'placement without section names');
      const pl: PrmPlacement = { sections, distribute: into === 'DISTRIBUTE_INTO', segments: [], line: at.line, col: at.col };
      if (this.inlineSegmentAhead()) {
        pl.inlineSegment = this.segmentBody('', at);
      } else {
        for (;;) {
          const t = this.next();
          if (!t) break;
          if (this.isPunct(t, ';')) {
            this.i--;
            break;
          }
          if (this.isKw(t, 'END')) {
            this.i--;
            break;
          }
          if (t.kind === 'punct') {
            if (t.text !== ',') this.err(t, `unexpected '${t.text}' in placement`);
            continue;
          }
          pl.segments.push(t.text);
        }
        if (pl.segments.length === 0) this.err(at, `placement of ${sections.join(', ')}: no target segments`);
      }
      if (this.isPunct(this.peek(), ';')) this.next();
      else this.err(this.peek() ?? this.lastPos(), "expected ';' after placement");
      this.ast.placements.push(pl);
    }
  }

  vector(at: Tok) {
    const base = this.opts.vectorBase ?? 0xfffe;
    let v: PrmVector;
    if (this.isKw(this.peek(), 'ADDRESS')) {
      this.next();
      const address = this.number('vector address');
      if (address === undefined) return;
      v = { form: 'address', address, target: '', line: at.line, col: at.col };
    } else {
      const n = this.number('vector number');
      if (n === undefined) return;
      v = { form: 'number', number: n, address: base - 2 * n, target: '', line: at.line, col: at.col };
    }
    const t = this.next();
    if (!t || t.kind === 'punct') {
      this.err(t ?? at, 'expected vector target');
      return;
    }
    const num = parsePrmNumber(t.text);
    v.target = num !== undefined ? num : t.text;
    if (this.isKw(this.peek(), 'OFFSET')) {
      this.next();
      v.offset = this.number('vector offset');
    }
    this.ast.vectors.push(v);
  }

  dependency(at: Tok) {
    for (;;) {
      const t = this.next();
      if (!t) {
        this.err(at, 'missing END for DEPENDENCY');
        return;
      }
      const k = this.kw(t);
      if (k === 'END') return;
      if (t.kind === 'punct') continue;
      if (k === 'ROOT') {
        this.ast.dependencies.push({ kind: 'ROOT', names: this.wordsUntilEnd('ROOT').map((w) => w.text), line: t.line, col: t.col });
        continue;
      }
      const rel = this.next();
      const rk = this.kw(rel);
      if (rk !== 'USES' && rk !== 'ADDUSE' && rk !== 'DELUSE') {
        this.err(rel ?? t, `DEPENDENCY: expected USES, ADDUSE or DELUSE after ${t.text}`);
        this.wordsUntilEnd('DEPENDENCY entry');
        continue;
      }
      this.ast.dependencies.push({ kind: rk, object: t.text, names: this.wordsUntilEnd(rk).map((w) => w.text), line: t.line, col: t.col });
    }
  }
}

/** Parse PRM text. Errors are collected in `errors` (with 1-based line/column); parsing continues after errors. */
export function parsePrm(text: string, opts: PrmParseOptions = {}): PrmFile {
  const ast: PrmFile = {
    names: [],
    segments: [],
    oldSectionsSyntax: false,
    placements: [],
    entries: [],
    vectors: [],
    mapFile: [],
    dependencies: [],
    overlapGroups: [],
    includes: [],
    other: [],
    commands: [],
    errors: [],
  };
  const toks = lex(text, ast.errors);
  new Parser(toks, ast, opts).run();
  if (ast.stackSize !== undefined && ast.stackTop !== undefined) {
    const c = ast.commands.find((x) => x.keyword === 'STACKTOP') ?? { line: 1, col: 1 };
    // L1200: both STACKSIZE and STACKTOP
    ast.errors.push({ line: c.line, col: c.col, message: 'STACKSIZE and STACKTOP must not both be specified' });
  }
  // main-file errors first (by position), then each included file's errors (by file, then position)
  ast.errors.sort((a, b) => (a.file ?? '').localeCompare(b.file ?? '') || a.line - b.line || a.col - b.col);
  return ast;
}

/** Like parsePrm but throws PrmSyntaxError if any error was found. */
export function parsePrmStrict(text: string, opts: PrmParseOptions = {}): PrmFile {
  const ast = parsePrm(text, opts);
  if (ast.errors.length) throw new PrmSyntaxError(ast.errors);
  return ast;
}

/** Look up a segment by (case-sensitive) name. */
export function prmSegment(ast: PrmFile, name: string): PrmSegment | undefined {
  return ast.segments.find((s) => s.name === name);
}

/** Find the placement statement that places `section`. */
export function prmPlacementOf(ast: PrmFile, section: string): PrmPlacement | undefined {
  return ast.placements.find((p) => p.sections.includes(section));
}

export { TOP_KEYWORDS as PRM_KEYWORDS };
