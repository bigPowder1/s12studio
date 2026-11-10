/**
 * Two-pass driver of the CodeWarrior HC12 assembler clone.
 *
 * Pass 1 reads the source (INCLUDE, macros and conditional assembly are expanded here), defines symbols, sizes
 * every statement and records the encoder's addressing-mode decisions. Pass 2 re-encodes instructions and data
 * with all symbols known (replaying the pass-1 decisions so that no location moves), produces section contents
 * and fixups, and allocates the object-file symbol order (see object.ts).
 */
import type { Cpu } from '@s12/isa';
import { evaluate, ExprError, parseFullExpression, type EvalContext, type Value } from './expr.js';
import { InstructionEncoder, isInstruction, isAnyInstruction } from './encoder.js';
import { parseLine, splitOperands, type ParsedLine } from './line.js';
import { applyPolicy, defaultSeverity, messageText, type AsmMessage } from './messages.js';
import type { AsmOptions } from './options.js';
import { dirName, joinPath } from './paths.js';
import type { Section, Stmt, Sym } from './types.js';

/**
 * UNCERTAIN: with -Li, lines of included files are left out of the .dbg file and of the Abs. line numbering
 * (not only of the listing). Evidence: every ME305 library member was assembled with -Li, includes the
 * derivative .inc (its symbol table carries the .inc's deprecated-name aliases), yet its first instruction is at
 * Abs. line 45..135. The manual's -Li example still counts the included lines; flip this to follow the manual.
 */
export const LI_EXCLUDES_INCLUDES_FROM_DBG = true;

/** Safety limit on the number of processed lines (macro expansions included). */
const MAX_STATEMENTS = 1_000_000;

const RESERVED = new Set(['A', 'B', 'CCR', 'D', 'X', 'Y', 'SP', 'PC', 'PCR', 'TEMP1', 'TEMP2', 'HIGH', 'LOW', 'PAGE']);

const DIRECTIVES = new Set([
  'ORG', 'SECTION', 'OFFSET', 'END', 'EQU', 'SET', 'XDEF', 'GLOBAL', 'PUBLIC', 'XREF', 'EXTERNAL', 'XREFB',
  'ABSENTRY', 'INCLUDE', 'DC', 'DCB', 'DS', 'FCB', 'FDB', 'FQB', 'DCW', 'DCL', 'FCC', 'RMB', 'RMD', 'RMQ', 'RAD50',
  'ALIGN', 'EVEN', 'LONGEVEN', 'BASE', 'IF', 'IFEQ', 'IFNE', 'IFLT', 'IFLE', 'IFGT', 'IFGE', 'IFC', 'IFNC', 'IFDEF',
  'IFNDEF', 'ELSE', 'ELSEC', 'ENDIF', 'ENDC', 'MACRO', 'ENDM', 'MEXIT', 'LIST', 'NOLIST', 'NOL', 'CLIST', 'MLIST',
  'PLEN', 'LLEN', 'TABS', 'SPC', 'PAGE', 'NOPAGE', 'TITLE', 'TTL', 'FAIL',
]);
const DATA_DIRECTIVES = new Set(['DC', 'DCB', 'DS', 'FCB', 'FDB', 'FQB', 'DCW', 'DCL', 'FCC', 'RMB', 'RMD', 'RMQ', 'RAD50']);
const COND_DIRECTIVES = new Set(['IF', 'IFEQ', 'IFNE', 'IFLT', 'IFLE', 'IFGT', 'IFGE', 'IFC', 'IFNC', 'IFDEF', 'IFNDEF']);
/** Listing-control directives: never listed themselves. */
const LIST_DIRECTIVES = new Set(['LIST', 'NOLIST', 'NOL', 'CLIST', 'MLIST', 'PLEN', 'LLEN', 'TABS', 'SPC', 'PAGE', 'NOPAGE', 'TITLE', 'TTL']);

export interface SourceFile {
  path: string;
  lines: string[];
  /** Character offset of each line start. */
  starts: number[];
}

/** Split text into lines: LF, CRLF or CR; a final line terminator does not start a new line. */
export function splitLines(text: string): { lines: string[]; starts: number[] } {
  const lines: string[] = [];
  const starts: number[] = [];
  let i = 0;
  let start = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\r' || c === '\n') {
      lines.push(text.slice(start, i));
      starts.push(start);
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++;
      start = i;
      continue;
    }
    i++;
  }
  if (start < text.length) {
    lines.push(text.slice(start));
    starts.push(start);
  }
  return { lines, starts };
}

export function decodeText(data: string | Uint8Array): string {
  if (typeof data === 'string') return data;
  let s = '';
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return s;
}

interface MacroDef {
  name: string;
  file: string;
  /** Body lines (between MACRO and ENDM) with their line numbers and line-start offsets. */
  body: Array<{ text: string; line: number; start: number }>;
}

interface Frame {
  kind: 'file' | 'macro';
  file: string;
  lines: string[];
  rels: number[];
  starts: number[];
  idx: number;
  suffix: '' | 'i' | 'm';
  inDbg: boolean;
  /** Conditional-stack depth when the frame was entered. */
  condBase: number;
  mexit?: boolean;
  /** Listing: expansion lines listed (MLIST state at the call, -Le). */
  listLines: boolean;
  includeDepth: number;
  macroDepth: number;
  callText?: string;
  /** Outermost macro call site (file/line of the statement in a real source file). */
  callFile?: string;
  callLine?: number;
}

interface Cond {
  parentActive: boolean;
  active: boolean;
  taken: boolean;
  elseSeen: boolean;
}

export interface AssemblerInput {
  sourcePath: string;
  readFile: (path: string) => string | Uint8Array | undefined;
  options: AsmOptions;
  env: Record<string, string>;
  /** Working directory for INCLUDE (default: directory of the main source). */
  cwd?: string;
  /**
   * Subdirectories of `dir` (full paths), used for recursive GENPATH entries (`path*`). Without it a recursive
   * entry only searches the folder itself.
   */
  listSubdirs?: (dir: string) => string[] | undefined;
  /** Override of LI_EXCLUDES_INCLUDES_FROM_DBG (for applying the lab-PC result without a code change). */
  liExcludesIncludesFromDbg?: boolean;
}

export class Assembler {
  readonly messages: AsmMessage[] = [];
  readonly stmts: Stmt[] = [];
  readonly sections: Section[] = [];
  /** Symbols by lookup key (name, or upper-case name with -Ci). */
  readonly symbols = new Map<string, Sym>();
  readonly symList: Sym[] = [];
  readonly macros = new Map<string, MacroDef>();
  readonly cpu: Cpu;
  absEntry?: string;
  includedFiles: string[] = [];

  private cur!: Section;
  private offsetPrev?: Section;
  private frames: Frame[] = [];
  private conds: Cond[] = [];
  private base = 10;
  private absLine = 0;
  private orgCount = 0;
  private varCount = 0;
  private macroCounter = 0;
  private allocCounter = 0;
  private defCounter = 0;
  private pass: 1 | 2 = 1;
  private stmt!: Stmt;
  private ended = false;
  /** Macro definition being collected. */
  private macroDef?: MacroDef & { depth: number };
  // listing state (pass 1)
  private listOn = true;
  private clistOn = true;
  private mlistOn = true;
  /** labels by section/offset (for VAR generation). */
  private labelsAt = new Map<Section, Map<number, Sym[]>>();

  constructor(private readonly input: AssemblerInput) {
    this.cpu = input.options.cpu === 'HCS12X' ? 's12x' : 'cpu12';
  }

  // ----- messages --------------------------------------------------------------------------------------------

  report(code: string, col: number, ...args: Array<string | number>): void {
    const sev = applyPolicy(code, defaultSeverity(code), this.input.options.messages);
    if (!sev) return;
    const s = this.stmt;
    const m: AsmMessage = {
      code,
      severity: sev,
      file: s?.file ?? this.input.sourcePath,
      line: s?.line ?? 0,
      column: col + 1,
      text: messageText(code, ...args),
    };
    if (s) {
      m.pos = s.lineStart + col;
      m.sourceLine = s.text;
      if (s.absLine) m.absLine = s.absLine;
      m.stmt = s.idx;
      if (s.macroContext) m.macroContext = s.macroContext;
      if (s.macroCall) {
        m.callFile = s.macroCall.file;
        m.callLine = s.macroCall.line;
      }
      if (sev === 'ERROR' || sev === 'FATAL') s.hasError = true;
    }
    // Avoid reporting the same message twice for one statement (pass 1 + pass 2).
    if (this.messages.some((x) => x.code === m.code && x.stmt === m.stmt && x.file === m.file && x.line === m.line && x.column === m.column && x.text === m.text)) return;
    this.messages.push(m);
  }

  private get liExcl(): boolean {
    return this.input.liExcludesIncludesFromDbg ?? LI_EXCLUDES_INCLUDES_FROM_DBG;
  }

  /** Statement being processed (undefined before the first and after pass 2). */
  get currentStmt(): Stmt | undefined {
    return this.stmt;
  }

  get hasErrors(): boolean {
    return this.messages.some((m) => m.severity === 'ERROR' || m.severity === 'FATAL');
  }

  // ----- symbols ---------------------------------------------------------------------------------------------

  private key(name: string): string {
    return this.input.options.caseInsensitive ? name.toUpperCase() : name;
  }

  getSym(name: string): Sym | undefined {
    return this.symbols.get(this.key(name));
  }

  private newSym(name: string): Sym {
    const s: Sym = { name, kind: 'none', value: 0, defined: false, xdef: false, isData: false };
    this.symbols.set(this.key(name), s);
    this.symList.push(s);
    return s;
  }

  private symFor(name: string): Sym {
    return this.getSym(name) ?? this.newSym(name);
  }

  /** Object symbol-table allocation (see object.ts for the ordering rules). */
  allocate(s: Sym): void {
    if (s.alloc === undefined) s.alloc = this.allocCounter++;
  }

  private labelValue(s: Sym): Value {
    if (s.aliasOf) return this.labelValue(s.aliasOf);
    const sec = s.section!;
    if (sec.kind === 'org' || sec.kind === 'offset') {
      const v: Value = { kind: 'abs', v: s.value, absLabel: sec.kind === 'org' };
      if (sec.kind === 'org') v.sym = s;
      return v;
    }
    return { kind: 'rel', v: s.value, sym: s, sec };
  }

  /** Value of a symbol for expression evaluation; undefined when not defined yet. */
  symValue(s: Sym): Value | undefined {
    if (!s.defined) return undefined;
    switch (s.kind) {
      case 'label':
        return this.labelValue(s);
      case 'equ':
        if (s.equValue) return { ...s.equValue };
        return { kind: 'abs', v: s.value, equ: true };
      case 'set':
        return { kind: 'abs', v: s.value, equ: true };
      case 'xref':
        return { kind: 'ext', v: 0, sym: s };
      default:
        return undefined;
    }
  }

  private evalCtx(stmt: Stmt, allowUndefinedPass2 = false): EvalContext {
    return {
      lookup: (name: string, pos: number) => {
        const up = name.toUpperCase();
        if (RESERVED.has(up) && up !== 'HIGH' && up !== 'LOW' && up !== 'PAGE') {
          throw new ExprError('A1055', 'Error in expression', pos);
        }
        const s = this.getSym(name);
        const v = s ? this.symValue(s) : undefined;
        if (!v) {
          if (this.pass === 2 && !allowUndefinedPass2) throw new ExprError('A1104', name, pos);
          return undefined;
        }
        if (this.pass === 2 && v.sym) this.allocate(v.sym as Sym);
        return v;
      },
      pc: () => this.pcValue(stmt),
      warn: (code: string, t: string, pos: number) => this.report(code, pos, t),
    };
  }

  private pcValue(stmt: Stmt): Value {
    const sec = stmt.section ?? this.cur;
    if (sec.kind === 'org' || sec.kind === 'offset') return { kind: 'abs', v: stmt.loc };
    return { kind: 'rel', v: stmt.loc, sec };
  }

  /** Parse + evaluate. Reports errors; returns undefined on error. */
  evalText(text: string, col: number, opts: { pass2Undefined?: boolean } = {}): Value | undefined {
    try {
      const e = parseFullExpression(text, { base: this.base }, col);
      return evaluate(e, this.evalCtx(this.stmt, opts.pass2Undefined));
    } catch (err) {
      if (err instanceof ExprError) {
        if (err.code === 'A1104' || err.code === 'A9002') this.report(err.code, err.pos, err.message);
        else this.report(err.code, err.pos);
        return undefined;
      }
      throw err;
    }
  }

  /** Evaluate an absolute, already-defined expression (directive operands). */
  private evalAbs(text: string, col: number, noForward = true): number | undefined {
    const v = this.evalText(text, col);
    if (!v) return undefined;
    if (v.kind === 'undef') {
      this.report(noForward ? 'A2333' : 'A1104', col, text);
      return undefined;
    }
    if (v.kind !== 'abs') {
      this.report('A2314', col);
      return undefined;
    }
    return v.v;
  }

  // ----- sections --------------------------------------------------------------------------------------------

  private newSection(name: string, kind: Section['kind'], base = 0): Section {
    const s: Section = {
      id: this.sections.length,
      name,
      kind,
      short: false,
      base,
      pc: base,
      size: 0,
      hasCode: false,
      hasConst: false,
      hasDs: false,
      data: [],
      fixups: [],
    };
    this.sections.push(s);
    return s;
  }

  private advance(n: number): void {
    const s = this.cur;
    s.pc += n;
    const off = s.pc - s.base;
    if (off > s.size) s.size = off;
  }

  /** Leave an OFFSET section when a location-affecting statement other than DS/ALIGN/EVEN appears. */
  private endOffset(): void {
    if (this.cur.kind === 'offset' && this.offsetPrev) {
      this.cur = this.offsetPrev;
      this.offsetPrev = undefined;
    }
  }

  // ----- pass 1 ----------------------------------------------------------------------------------------------

  run(): void {
    const opts = this.input.options;
    this.cur = this.newSection('_SEC000000', 'default');
    // -D<name>[=value] behaves like `<name>: EQU <value>` at the start of the main file.
    for (const d of opts.defines) {
      const s = this.symFor(d.name);
      s.kind = 'equ';
      s.value = d.value;
      s.defined = true;
    }
    const main = this.load(this.input.sourcePath);
    if (!main) {
      this.messages.push({
        code: 'A50',
        severity: 'FATAL',
        file: this.input.sourcePath,
        line: 0,
        column: 0,
        text: messageText('A50', this.input.sourcePath),
      });
      return;
    }
    this.pushFile(main, '', true, 0);
    this.pass1();
    if (!(this.hasErrors && this.stmts.length === 0)) this.pass2();
    // Report in source order (pass-2 diagnostics are interleaved with pass-1 ones).
    const order = (m: AsmMessage) => m.stmt ?? -1;
    const sorted = this.messages.map((m, i) => ({ m, i })).sort((a, b) => order(a.m) - order(b.m) || a.i - b.i);
    this.messages.splice(0, this.messages.length, ...sorted.map((x) => x.m));
  }

  private load(path: string): SourceFile | undefined {
    const raw = this.input.readFile(path);
    if (raw === undefined) return undefined;
    const { lines, starts } = splitLines(decodeText(raw));
    return { path, lines, starts };
  }

  private pushFile(f: SourceFile, suffix: '' | 'i', inDbg: boolean, depth: number): void {
    this.frames.push({
      kind: 'file',
      file: f.path,
      lines: f.lines,
      rels: f.lines.map((_, i) => i + 1),
      starts: f.starts,
      idx: 0,
      suffix,
      inDbg,
      condBase: this.conds.length,
      listLines: suffix === '' || !this.input.options.noIncludes,
      includeDepth: depth,
      macroDepth: this.frames.length ? this.frames[this.frames.length - 1].macroDepth : 0,
    });
  }

  private get active(): boolean {
    return this.conds.length === 0 || this.conds[this.conds.length - 1].active;
  }

  private pass1(): void {
    while (this.frames.length) {
      const f = this.frames[this.frames.length - 1];
      if (f.idx >= f.lines.length) {
        this.frames.pop();
        if (f.kind === 'macro' && this.conds.length > f.condBase) {
          this.report('A1000', 0);
          this.conds.length = f.condBase;
        }
        continue;
      }
      if (this.stmts.length >= MAX_STATEMENTS) {
        // Runaway macro recursion: stop instead of exhausting memory.
        this.report('A1004', 0);
        break;
      }
      const i = f.idx++;
      const text = f.lines[i];
      const st: Stmt = {
        idx: this.stmts.length,
        file: f.file,
        line: f.rels[i],
        suffix: f.suffix,
        text,
        absLine: f.inDbg ? ++this.absLine : 0,
        listed: false,
        macroExp: f.kind === 'macro',
        skipped: false,
        type: 'none',
        loc: 0,
        size: 0,
        showLoc: false,
        lineStart: f.starts[i] ?? 0,
      };
      if (f.kind === 'macro') {
        st.macroContext = f.callText;
        if (f.callFile !== undefined) st.macroCall = { file: f.callFile, line: f.callLine ?? 0 };
      }
      this.stmts.push(st);
      this.stmt = st;
      this.processLine(st, f);
      if (this.ended) break;
    }
    if (this.macroDef) {
      this.report('A2306', 0);
      this.macroDef = undefined;
    }
    if (this.conds.length) this.report('A1000', 0);
    // XDEF of undefined symbols.
    for (const s of this.symList) {
      if (s.xdef && !s.defined) {
        this.stmt = s.defStmt ?? this.stmt;
        this.report('A1104', 0, s.name);
      }
    }
  }

  /** Listing visibility of a statement given the frame and kind of line. */
  private listable(st: Stmt, f: Frame, kind: 'normal' | 'macroDef' | 'macroCall' | 'skipped' | 'listDirective'): boolean {
    const o = this.input.options;
    if (!st.absLine && !(f.suffix === 'i' && !this.liExcl)) return false;
    if (f.suffix === 'i' && o.noIncludes) return false;
    if (kind === 'listDirective') return false;
    if (!this.listOn) return false;
    if (f.kind === 'macro' && !f.listLines) return false;
    if (kind === 'macroDef') return !o.noMacroDefs;
    if (kind === 'macroCall') return !o.noMacroCalls;
    if (kind === 'skipped') return this.clistOn;
    return true;
  }

  private processLine(st: Stmt, f: Frame): void {
    // Macro definition body collection.
    if (this.macroDef) {
      const p = parseLine(st.text);
      st.parsed = p;
      st.skipped = true;
      const op = p.op?.upper;
      if (op === 'ENDM') {
        if (this.macroDef.depth > 0) this.macroDef.depth--;
        else {
          if (this.macroDef.name !== '\0unnamed') this.macros.set(this.key(this.macroDef.name), this.macroDef);
          this.macroDef = undefined;
          st.listed = this.listable(st, f, 'macroDef');
          return;
        }
      } else if (op === 'MACRO') {
        this.report('A2304', p.op!.col);
      }
      this.macroDef?.body.push({ text: st.text, line: st.line, start: st.lineStart });
      st.listed = this.listable(st, f, 'macroDef');
      return;
    }
    // After MEXIT the remaining macro lines are listed (with '+') but not assembled (manual Listing 8.41).
    if (f.kind === 'macro' && f.mexit) {
      st.skipped = true;
      st.listed = this.listable(st, f, 'normal');
      return;
    }
    const p = parseLine(st.text);
    st.parsed = p;
    const op = p.op?.upper;
    if (!this.active) {
      st.skipped = true;
      if (op && COND_DIRECTIVES.has(op)) {
        this.conds.push({ parentActive: false, active: false, taken: true, elseSeen: false });
        st.listed = this.listable(st, f, 'normal');
        return;
      }
      if (op === 'ELSE' || op === 'ELSEC' || op === 'ENDIF' || op === 'ENDC') {
        this.condDirective(op, st, p);
        st.listed = this.listable(st, f, 'normal');
        return;
      }
      st.listed = this.listable(st, f, 'skipped');
      return;
    }
    if (p.error) {
      this.report(p.error.code, p.error.col, ...p.error.args);
      st.listed = this.listable(st, f, 'normal');
      return;
    }
    if (p.empty || (!p.op && !p.label)) {
      st.listed = this.listable(st, f, 'normal');
      return;
    }
    let kind: 'normal' | 'macroCall' | 'listDirective' | 'macroDef' = 'normal';
    if (op && LIST_DIRECTIVES.has(op)) kind = 'listDirective';
    try {
      kind = this.processStatement(st, f, p) ?? kind;
    } catch (e) {
      if (e instanceof ExprError) {
        if (e.code === 'A9002') this.report(e.code, e.pos, e.message);
        else this.report(e.code, e.pos);
      } else if (e instanceof RangeError) this.report('A9002', p.op?.col ?? 0, 'statement too complex');
      else throw e;
    }
    st.listed = this.listable(st, f, kind);
  }

  private condDirective(op: string, st: Stmt, p: ParsedLine): void {
    st.type = 'cond';
    if (op === 'ELSE' || op === 'ELSEC') {
      const c = this.conds[this.conds.length - 1];
      const f = this.frames[this.frames.length - 1];
      if (!c || c.elseSeen || this.conds.length <= (f?.kind === 'macro' ? f.condBase : 0)) {
        this.report('A1001', p.op!.col);
        return;
      }
      c.elseSeen = true;
      c.active = c.parentActive && !c.taken;
      if (c.active) c.taken = true;
      return;
    }
    // ENDIF
    const f = this.frames[this.frames.length - 1];
    if (!this.conds.length || this.conds.length <= (f?.kind === 'macro' ? f.condBase : 0)) {
      this.report('A1001', p.op!.col);
      return;
    }
    this.conds.pop();
  }

  /** Define a location label at the current location. */
  private defineLabel(name: string, col: number, st: Stmt, isData: boolean): Sym | undefined {
    if (RESERVED.has(name.toUpperCase())) {
      this.report('A1101', col);
      return undefined;
    }
    const existing = this.getSym(name);
    if (existing && existing.defined) {
      this.report(existing.kind === 'xref' ? 'A2326' : 'A1103', col, name);
      return undefined;
    }
    if (existing && existing.kind === 'xref') {
      this.report('A4003', col, name);
    }
    const s = existing ?? this.newSym(name);
    s.kind = 'label';
    s.section = this.cur;
    s.value = this.cur.pc;
    s.defined = true;
    s.isData = isData;
    s.defStmt = st;
    s.defOrder = this.defCounter++;
    if (s.xrefSize !== undefined) delete s.xrefSize;
    if (this.cur.kind === 'offset') {
      // Labels in an OFFSET section are absolute constants (not object symbols).
      s.kind = 'equ';
      return s;
    }
    if (isData) this.allocate(s);
    let m = this.labelsAt.get(this.cur);
    if (!m) this.labelsAt.set(this.cur, (m = new Map()));
    const off = this.cur.pc;
    m.set(off, [...(m.get(off) ?? []), s]);
    return s;
  }

  /** Record data-directive info on labels at the current location and create VARnnnnn for unlabelled data. */
  private dataAt(st: Stmt, elem: 1 | 2 | 4, count: number, initialized: boolean): void {
    if (this.cur.kind === 'offset') return;
    const labels = this.labelsAt.get(this.cur)?.get(this.cur.pc) ?? [];
    // Labels alone on an earlier line at this address (`tbl:` then `DC.B 2` on the next line). For initialised data
    // CW does not treat them as labelling the data: the line gets a VARnnnnn and the bare labels become aliases of it
    // (observed in a CW 5.1 object: `LDX #tbl` relocates against VAR00001 and tbl is not in the symbol table).
    // UNCERTAIN: a bare label followed by DS, or by a data line with its own label, keeps the old behaviour (unseen).
    const own = labels.filter((s) => s.defStmt === st);
    const bare = labels.filter((s) => s.defStmt !== st && s.dataElem === undefined && !s.aliasOf);
    const aliasBare = initialized && !own.length && bare.length > 0 && bare.length === labels.length;
    if (!aliasBare) {
      for (const s of labels) {
        if (s.dataElem === undefined) {
          s.dataElem = elem;
          s.dataCount = count;
        }
      }
    }
    if ((!labels.length || aliasBare) && initialized) {
      // UNCERTAIN: every unlabelled initialised-data line (DC/DCB/FCC/RAD50) gets its own VARnnnnn symbol
      // (e.g. a vector table: consecutive DC.W lines -> VAR00001, VAR00002, ...).
      const name = `VAR${String(++this.varCount).padStart(5, '0')}`;
      const s = this.defineLabel(name, 0, st, true);
      if (s) {
        s.isVar = true;
        s.dataElem = elem;
        s.dataCount = count;
        if (aliasBare) for (const b of bare) b.aliasOf = s;
      }
    }
  }

  /** Main statement dispatcher (pass 1). Returns the listing kind. */
  private processStatement(st: Stmt, f: Frame, p: ParsedLine): 'normal' | 'macroCall' | 'macroDef' | 'listDirective' | undefined {
    const op = p.op?.upper;
    const size = p.op?.size;
    const label = p.label;
    st.section = this.cur;
    st.loc = this.cur.pc;

    if (!op) {
      if (label) this.defineLabel(label.name, label.col, st, false);
      return;
    }
    // Conditional assembly.
    if (COND_DIRECTIVES.has(op)) {
      if (label) this.defineLabel(label.name, label.col, st, false);
      this.condIf(op, st, p);
      return;
    }
    if (op === 'ELSE' || op === 'ELSEC' || op === 'ENDIF' || op === 'ENDC') {
      this.condDirective(op, st, p);
      return;
    }
    if (op === 'MACRO') {
      if (!label) {
        this.report('A2302', p.op!.col);
        // Swallow the body up to ENDM without defining anything.
        this.macroDef = { name: '\0unnamed', file: f.file, body: [], depth: 0 };
        st.skipped = true;
        return 'macroDef';
      }
      if (DIRECTIVES.has(label.name.toUpperCase()) || isAnyInstruction(label.name)) this.report('A2305', label.col);
      if (this.macros.has(this.key(label.name))) this.report('A2307', label.col);
      this.macroDef = { name: label.name, file: f.file, body: [], depth: 0 };
      st.skipped = true;
      return 'macroDef';
    }
    if (op === 'ENDM') {
      this.report('A2303', p.op!.col);
      return;
    }
    if (op === 'MEXIT') {
      if (f.kind !== 'macro') this.report('A2350', p.op!.col);
      else {
        f.mexit = true;
        this.conds.length = f.condBase;
      }
      return;
    }
    // Macro call?
    const mac = this.macros.get(this.key(p.op!.name)) ?? (p.op!.size ? this.macros.get(this.key(p.op!.name)) : undefined);
    if (mac && !DIRECTIVES.has(op)) {
      if (label) this.defineLabel(label.name, label.col, st, false);
      this.expandMacro(mac, st, f, p);
      return 'macroCall';
    }
    if (DIRECTIVES.has(op)) return this.directive(op, size, st, f, p);
    // Instruction.
    if (isInstruction(op, this.cpu)) {
      this.endOffset();
      st.section = this.cur;
      st.loc = this.cur.pc;
      if (label) this.defineLabel(label.name, label.col, st, false);
      const r = this.encode(st, p, 1);
      st.type = 'instr';
      st.size = r.bytes.length;
      st.choices = r.choices;
      st.showLoc = true;
      this.cur.hasCode = true;
      this.advance(st.size);
      return;
    }
    if (label) this.defineLabel(label.name, label.col, st, false);
    this.report('A12202', p.op!.col);
    return;
  }

  private encode(st: Stmt, p: ParsedLine, pass: 1 | 2) {
    const sec = st.section!;
    const enc = new InstructionEncoder({
      cpu: this.cpu,
      cpuName: this.input.options.cpu,
      pass,
      pc: st.loc,
      absSection: sec.kind === 'org' || sec.kind === 'offset',
      section: sec,
      cpDirect: this.input.options.cpDirect,
      evaluate: (text, col) => this.evalText(text, col),
      isShortSection: (s) => !!(s as Section | undefined)?.short,
      xrefSize: (s) => (s as Sym | undefined)?.xrefSize,
      report: (code, col, ...args) => this.report(code, col, ...args),
      replay: pass === 2 ? st.choices : undefined,
    });
    const r = enc.encode(p.op!.name, p.op!.size, p.operands, p.operandsCol, p.op!.col);
    if (!r) throw new Error('not an instruction');
    return r;
  }

  private condIf(op: string, st: Stmt, p: ParsedLine): void {
    st.type = 'cond';
    const parentActive = this.active;
    let cond = false;
    let value: number | undefined;
    const ops = p.operands;
    const col = p.operandsCol;
    if (op === 'IFDEF' || op === 'IFNDEF') {
      const name = ops.trim();
      if (!/^[A-Za-z_.][A-Za-z0-9_.]*$/.test(name)) this.report('A2311', col);
      const s = this.getSym(name);
      const def = !!s && (s.defined || s.kind === 'xref') ? true : this.macros.has(this.key(name));
      cond = op === 'IFDEF' ? def : !def;
      value = cond ? 1 : 0; // UNCERTAIN: listing value of IFDEF/IFNDEF
    } else if (op === 'IFC' || op === 'IFNC') {
      const parts = splitOperands(ops);
      if (parts.length !== 2) this.report('A2402', col);
      const unq = (s: string | undefined) => {
        const t = (s ?? '').trim();
        return (t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')) ? t.slice(1, -1) : t;
      };
      const eq = unq(parts[0]?.text) === unq(parts[1]?.text);
      cond = op === 'IFC' ? eq : !eq;
      value = cond ? 1 : 0;
    } else {
      const v = this.evalAbs(ops, col);
      value = v ?? 0;
      const x = value;
      cond =
        op === 'IF' ? x !== 0 : op === 'IFEQ' ? x === 0 : op === 'IFNE' ? x !== 0 : op === 'IFLT' ? x < 0 : op === 'IFLE' ? x <= 0 : op === 'IFGT' ? x > 0 : x >= 0;
    }
    st.listValue = value;
    this.conds.push({ parentActive, active: parentActive && cond, taken: cond, elseSeen: false });
  }

  private expandMacro(mac: MacroDef, st: Stmt, f: Frame, p: ParsedLine): void {
    if (f.macroDepth + 1 > this.input.options.macroNest) {
      this.report('A1004', p.op!.col);
      return;
    }
    st.type = 'other';
    const args = this.macroArgs(p.operands);
    const n = ++this.macroCounter;
    const unique = `_${String(n).padStart(5, '0')}`;
    const sub = (text: string): string =>
      text.replace(/\\([0-9A-Za-z@])/g, (m, c: string) => {
        if (c === '@') return unique;
        // UNCERTAIN: \0 is replaced by the size suffix exactly as written at the call (`rep.w` -> `w`); the manual
        // only shows upper-case examples. The size is not case-folded because the expansion text is listed verbatim.
        if (c === '0') return p.op!.sizeRaw ?? '';
        const idx = /[1-9]/.test(c) ? Number(c) : /[A-Z]/.test(c) ? 10 + c.charCodeAt(0) - 65 : -1;
        if (idx < 0) return m;
        return args[idx - 1] ?? '';
      });
    const o = this.input.options;
    this.frames.push({
      kind: 'macro',
      file: mac.file,
      lines: mac.body.map((b) => sub(b.text)),
      rels: mac.body.map((b) => b.line),
      starts: mac.body.map((b) => b.start),
      idx: 0,
      suffix: 'm',
      inDbg: f.inDbg,
      condBase: this.conds.length,
      listLines: f.listLines && this.mlistOn && !o.noMacroExpansions,
      includeDepth: f.includeDepth,
      macroDepth: f.macroDepth + 1,
      callText: st.text.trim(),
      callFile: f.kind === 'macro' ? f.callFile : st.file,
      callLine: f.kind === 'macro' ? f.callLine : st.line,
    });
  }

  /** Split macro call arguments: commas separate, `[? ... ?]` groups (with \ escapes), `<...>` groups. */
  private macroArgs(text: string): string[] {
    const out: string[] = [];
    let cur = '';
    let i = 0;
    const o = this.input.options;
    while (i < text.length) {
      if (o.macroBrackets && text.startsWith('[?', i)) {
        let depth = 1;
        i += 2;
        while (i < text.length && depth > 0) {
          if (text[i] === '\\' && '[]?\\'.includes(text[i + 1] ?? '')) {
            cur += text[i + 1];
            i += 2;
            continue;
          }
          if (text.startsWith('[?', i)) {
            depth++;
            cur += '[?';
            i += 2;
            continue;
          }
          if (text.startsWith('?]', i)) {
            depth--;
            if (depth > 0) cur += '?]';
            i += 2;
            continue;
          }
          cur += text[i++];
        }
        continue;
      }
      const c = text[i];
      if (c === "'" || c === '"') {
        const j = text.indexOf(c, i + 1);
        const end = j < 0 ? text.length : j + 1;
        cur += text.slice(i, end);
        i = end;
        continue;
      }
      if (c === ',') {
        out.push(cur.trim());
        cur = '';
        i++;
        continue;
      }
      cur += c;
      i++;
    }
    if (out.length || cur.trim() !== '') out.push(cur.trim());
    return out;
  }

  // ----- directives ------------------------------------------------------------------------------------------

  private directive(op: string, size: string | undefined, st: Stmt, f: Frame, p: ParsedLine): 'normal' | 'listDirective' | undefined {
    const label = p.label;
    const ops = p.operands;
    const col = p.operandsCol;
    const sizeOf = (def: 1 | 2 | 4): 1 | 2 | 4 | undefined => {
      if (!size) return def;
      if (size === 'B') return 1;
      if (size === 'W') return 2;
      if (size === 'L') return 4;
      this.report('A2310', p.op!.col);
      return undefined;
    };
    switch (op) {
      case 'EQU':
      case 'SET': {
        if (!label) {
          this.report('A2301', p.op!.col);
          return;
        }
        st.type = op === 'EQU' ? 'equ' : 'set';
        const v = this.evalText(ops, col);
        if (!v) return;
        if (v.kind === 'undef') {
          this.report('A2333', col);
          return;
        }
        if (RESERVED.has(label.name.toUpperCase())) {
          this.report('A1101', label.col);
          return;
        }
        const ex = this.getSym(label.name);
        if (op === 'EQU') {
          if (ex && ex.defined) {
            this.report('A2326', label.col, label.name);
            return;
          }
          const s = ex ?? this.newSym(label.name);
          s.kind = 'equ';
          s.defined = true;
          s.defStmt = st;
          s.value = v.v;
          if (v.kind !== 'abs') {
            s.equValue = v;
            // EQU of an external symbol is an object-file alias (STT 13, see object.ts): allocated here.
            if (v.kind === 'ext' && v.v === 0 && !v.fn) this.allocate(s);
          }
          st.listValue = v.v;
        } else {
          if (v.kind !== 'abs') {
            this.report('A2314', col);
            return;
          }
          if (ex && ex.defined && ex.kind !== 'set') {
            this.report('A2326', label.col, label.name);
            return;
          }
          const s = ex ?? this.newSym(label.name);
          if (s.xdef) this.report('A2335', label.col);
          s.kind = 'set';
          s.defined = true;
          s.defStmt = s.defStmt ?? st;
          s.value = v.v;
          st.setSym = s;
          st.setValue = v.v;
          st.listValue = v.v;
        }
        return;
      }
      case 'ORG': {
        const v = this.evalAbs(ops, col);
        if (v === undefined) return;
        if (this.cur.kind === 'offset') this.endOffset();
        const sec = this.newSection(`_ORG${String(++this.orgCount).padStart(5, '0')}`, 'org', v & 0xffffff);
        this.cur = sec;
        st.type = 'org';
        st.section = sec;
        st.loc = sec.pc;
        if (label) this.defineLabel(label.name, label.col, st, false);
        return;
      }
      case 'SECTION': {
        if (!label) {
          this.report('A2301', p.op!.col);
          return;
        }
        if (this.input.options.format === 'FA2' || this.input.options.format === 'FA2o') {
          // Manual (-FA2, A2341): only ORG sections are allowed when an absolute file is generated directly.
          this.report('A2341', p.op!.col);
          return;
        }
        this.endOffset();
        const words = ops.split(/[\s,]+/).filter(Boolean);
        const short = words.some((w) => w.toUpperCase() === 'SHORT');
        let sec = this.sections.find((s) => (s.kind === 'reloc' || s.kind === 'default') && this.key(s.name) === this.key(label.name));
        if (!sec) {
          const clash = this.getSym(label.name);
          if (clash && (clash.defined || clash.xdef)) this.report('A2317', label.col);
          sec = this.newSection(label.name, 'reloc');
        }
        if (short) sec.short = true;
        this.cur = sec;
        st.type = 'section';
        st.section = sec;
        st.loc = sec.pc;
        return;
      }
      case 'OFFSET': {
        const v = this.evalAbs(ops, col);
        if (v === undefined) return;
        if (this.cur.kind !== 'offset') this.offsetPrev = this.cur;
        const sec: Section = {
          id: -1,
          name: 'OFFSET',
          kind: 'offset',
          short: false,
          base: v,
          pc: v,
          size: 0,
          hasCode: false,
          hasConst: false,
          hasDs: false,
          data: [],
          fixups: [],
        };
        this.cur = sec;
        st.type = 'org';
        if (label) this.defineLabel(label.name, label.col, st, false);
        return;
      }
      case 'END':
        if (label) this.defineLabel(label.name, label.col, st, false);
        // END ends the current file (an included file only ends that file).
        while (this.frames.length) {
          const fr = this.frames.pop()!;
          if (fr.kind === 'file') break;
        }
        if (!this.frames.length) this.ended = true;
        return 'listDirective';
      case 'XDEF':
      case 'GLOBAL':
      case 'PUBLIC':
      case 'XREF':
      case 'EXTERNAL':
      case 'XREFB': {
        if (label) this.report('A2323', label.col);
        const isRef = op === 'XREF' || op === 'EXTERNAL' || op === 'XREFB';
        const items = splitOperands(ops);
        if (!items.length) this.report('A2311', col);
        for (const it of items) {
          const name = it.text;
          if (!/^[A-Za-z_.][A-Za-z0-9_.]*$/.test(name)) {
            this.report(/\s/.test(name) ? 'A2325' : 'A2311', col + it.col);
            continue;
          }
          if (RESERVED.has(name.toUpperCase())) {
            this.report('A1101', col + it.col);
            continue;
          }
          const s = this.symFor(name);
          if (!s.defStmt) s.defStmt = st;
          if (isRef) {
            if (s.defined && s.kind !== 'xref') {
              this.report('A4003', col + it.col, name);
              continue;
            }
            s.kind = 'xref';
            s.defined = true;
            s.xrefSize = op === 'XREFB' ? 'B' : size ?? '';
          } else {
            if (this.cur.kind === 'offset' && s.defined && s.kind === 'equ') this.report('A2342', col + it.col);
            s.xdef = true;
          }
          this.allocate(s);
        }
        return;
      }
      case 'ABSENTRY':
        this.absEntry = ops.trim();
        return;
      case 'INCLUDE': {
        if (label) this.defineLabel(label.name, label.col, st, false);
        const m = ops.match(/^\s*(["'])(.*?)\1/) ?? ops.match(/^\s*(\S+)/);
        if (!m) {
          this.report('A2308', col);
          return;
        }
        const name = m[2] ?? m[1];
        if (f.includeDepth + 1 > 50) {
          this.report('A2313', col);
          return;
        }
        const file = this.findInclude(name, f.file);
        if (!file) {
          this.report('A2309', col, name);
          return;
        }
        this.includedFiles.push(file.path);
        const inDbg = f.inDbg && !(this.input.options.noIncludes && this.liExcl);
        this.pushFile(file, 'i', inDbg, f.includeDepth + 1);
        return;
      }
      case 'DS':
      case 'RMB':
      case 'RMD':
      case 'RMQ': {
        const elem = op === 'RMB' ? 1 : op === 'RMD' ? 2 : op === 'RMQ' ? 4 : sizeOf(1);
        if (!elem) return;
        const n = this.evalAbs(ops, col);
        if (label) this.defineLabel(label.name, label.col, st, true);
        if (n === undefined) return;
        let cnt = n;
        if (n < 0) {
          this.report('A2320', col);
          cnt = 0;
        } else if (n > 4096) {
          this.report('A2321', col); // UNCERTAIN: manual "may range from 1 to 4096"
          cnt = 0;
        }
        const bytes = cnt * elem;
        st.type = 'ds';
        st.size = bytes;
        st.showLoc = true;
        this.dataAt(st, elem, cnt, false);
        if (this.cur.kind !== 'offset') this.cur.hasDs = true;
        this.advance(bytes);
        return;
      }
      case 'DC':
      case 'FCB':
      case 'FDB':
      case 'FQB':
      case 'DCW':
      case 'DCL':
      case 'FCC': {
        const elem: 1 | 2 | 4 | undefined =
          op === 'FDB' || op === 'DCW' ? 2 : op === 'FQB' || op === 'DCL' ? 4 : op === 'FCB' || op === 'FCC' ? 1 : sizeOf(1);
        if (!elem) return;
        this.endOffset();
        st.section = this.cur;
        st.loc = this.cur.pc;
        if (label) this.defineLabel(label.name, label.col, st, true);
        const n = this.dcSize(ops, col, elem);
        if (n === 0) this.report('A4001', col);
        st.type = 'dc';
        st.data = { elem, kind: op === 'FCC' ? 'fcc' : 'dc' };
        st.size = n;
        st.showLoc = true;
        this.dataAt(st, elem, Math.floor(n / elem), true);
        this.cur.hasConst = true;
        this.advance(n);
        return;
      }
      case 'DCB': {
        const elem = sizeOf(1);
        if (!elem) return;
        this.endOffset();
        st.section = this.cur;
        st.loc = this.cur.pc;
        if (label) this.defineLabel(label.name, label.col, st, true);
        const items = splitOperands(ops);
        if (items.length !== 2) {
          this.report('A2402', col);
          return;
        }
        const n = this.evalAbs(items[0].text, col + items[0].col);
        if (n === undefined) return;
        let cnt = n;
        if (n < 1) {
          this.report('A2320', col);
          cnt = 0;
        } else if (n > 4096) {
          this.report('A2321', col);
          cnt = 0;
        }
        st.type = 'dc';
        st.data = { elem, kind: 'dcb' };
        st.size = cnt * elem;
        st.showLoc = true;
        this.dataAt(st, elem, cnt, true);
        this.cur.hasConst = true;
        this.advance(st.size);
        return;
      }
      case 'RAD50': {
        this.endOffset();
        st.section = this.cur;
        st.loc = this.cur.pc;
        if (label) this.defineLabel(label.name, label.col, st, true);
        const r = this.rad50(ops, col);
        st.type = 'dc';
        st.data = { elem: 2, kind: 'rad50' };
        st.size = r ? r.length : 0;
        st.showLoc = true;
        this.dataAt(st, 2, st.size / 2, true);
        this.cur.hasConst = true;
        this.advance(st.size);
        return;
      }
      case 'ALIGN':
      case 'EVEN':
      case 'LONGEVEN': {
        let n = op === 'EVEN' ? 2 : op === 'LONGEVEN' ? 4 : this.evalAbs(ops, col);
        if (n === undefined) return;
        if (n < 1) {
          this.report('A2320', col);
          n = 1;
        } else if (n > 32767) {
          this.report('A2321', col);
          n = 1;
        }
        const off = this.cur.pc - this.cur.base;
        const pad = (n - (off % n)) % n;
        st.type = 'align';
        st.size = pad;
        st.showLoc = pad > 0;
        this.advance(pad);
        if (label) this.defineLabel(label.name, label.col, st, false);
        return;
      }
      case 'BASE': {
        // The operand is read in the current base unless it carries a prefix.
        const v = this.evalAbs(ops, col);
        if (v === undefined) return;
        if (![2, 8, 10, 16].includes(v)) this.report('A2324', col);
        else this.base = v;
        return;
      }
      case 'LIST':
        this.listOn = true;
        return 'listDirective';
      case 'NOLIST':
      case 'NOL':
        this.listOn = false;
        return 'listDirective';
      case 'CLIST':
      case 'MLIST': {
        const w = ops.trim().toUpperCase();
        const on = w === '' || w === 'ON' ? true : w === 'OFF' ? false : undefined;
        if (on === undefined) this.report('A2327', col);
        else if (op === 'CLIST') this.clistOn = on;
        else this.mlistOn = on;
        return 'listDirective';
      }
      case 'PLEN':
      case 'LLEN':
      case 'TABS':
      case 'SPC': {
        const v = this.evalAbs(ops, col);
        if (v === undefined) return 'listDirective';
        const lim: Record<string, [number, number]> = { PLEN: [10, 10000], LLEN: [0, 132], TABS: [0, 128], SPC: [0, 65] };
        const [lo, hi] = lim[op];
        const x = Math.min(hi, Math.max(lo, v));
        if (v < lo) this.report('A2320', col);
        if (v > hi) this.report('A2321', col);
        st.listCtl = op === 'PLEN' ? { plen: x } : op === 'LLEN' ? { llen: x } : op === 'TABS' ? { tabs: x } : { spc: x };
        return 'listDirective';
      }
      case 'PAGE':
        st.listCtl = { page: true };
        return 'listDirective';
      case 'NOPAGE':
        st.listCtl = { nopage: true };
        return 'listDirective';
      case 'TITLE':
      case 'TTL': {
        const m = ops.match(/^\s*(["'])(.*)\1\s*$/);
        st.listCtl = { title: m ? m[2] : ops.trim() };
        return 'listDirective';
      }
      case 'FAIL': {
        const t = ops.trim();
        const m = t.match(/^(["'])(.*)\1$/);
        if (m) this.report('A2338', col, m[2]);
        else {
          const v = this.evalAbs(t, col);
          if (v !== undefined) {
            if (v >>> 0 < 500) this.report('A2329', col);
            else this.report('A2332', col);
          }
        }
        return;
      }
      default:
        return;
    }
  }

  /** `root` and its subfolders (depth-first, bounded) via the host's listSubdirs. */
  private walkDirs(root: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (d: string, depth: number) => {
      const key = d.toLowerCase();
      if (seen.has(key) || out.length >= 1000) return;
      seen.add(key);
      out.push(d);
      if (depth >= 16) return;
      for (const sub of this.input.listSubdirs?.(d) ?? []) visit(sub, depth + 1);
    };
    visit(root, 0);
    return out;
  }

  private findInclude(name: string, fromFile: string): SourceFile | undefined {
    const o = this.input.options;
    const cwd = this.input.cwd ?? dirName(this.input.sourcePath);
    const genpath: string[] = [];
    for (const raw of (this.input.env.GENPATH ?? '').split(';').map((x) => x.trim()).filter(Boolean)) {
      // A trailing '*' means "this folder and all its subfolders" (CW environment path lists).
      // UNCERTAIN: search order of the subfolders (taken here depth-first, in the order the host lists them).
      if (raw.endsWith('*')) {
        const root = raw.slice(0, -1).replace(/[\\/]$/, '') || raw.slice(0, -1);
        if (root) genpath.push(...this.walkDirs(root));
      } else genpath.push(raw);
    }
    const dirs = [cwd, ...o.includePaths, ...genpath, dirName(fromFile)];
    const tried = new Set<string>();
    // File names are not case-sensitive (manual INCLUDE): the host's readFile should match case-insensitively;
    // as a fallback the lower- and upper-case spellings are tried too.
    for (const n of [name, name.toLowerCase(), name.toUpperCase()]) {
      for (const d of dirs) {
        const path = joinPath(d, n);
        if (tried.has(path)) continue;
        tried.add(path);
        const f = this.load(path);
        if (f) return f;
      }
    }
    return undefined;
  }

  /** Byte size of a DC operand list (pass 1). Strings are right-aligned in DC.W / DC.L units. */
  private dcSize(ops: string, col: number, elem: 1 | 2 | 4): number {
    let n = 0;
    for (const it of splitOperands(ops)) {
      const str = quotedString(it.text);
      if (str !== undefined) n += Math.ceil(str.length / elem) * elem;
      else {
        if (it.text === '') this.report('A1055', col + it.col);
        n += elem;
      }
    }
    return n;
  }

  private rad50(ops: string, col: number): number[] | undefined {
    const items = splitOperands(ops);
    const str = items[0] ? quotedString(items[0].text) : undefined;
    if (str === undefined) {
      this.report('A2312', col);
      return undefined;
    }
    let cnt: number | undefined;
    if (items[1]) cnt = this.evalAbs(items[1].text, col + items[1].col);
    const tbl = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ$.?0123456789';
    if (cnt !== undefined && (cnt < 0 || cnt > 4096)) {
      this.report(cnt < 0 ? 'A2320' : 'A2321', col);
      cnt = undefined;
    }
    const words = cnt ?? Math.ceil(str.length / 3);
    const out: number[] = [];
    for (let w = 0; w < words; w++) {
      let v = 0;
      for (let k = 0; k < 3; k++) {
        const ch = str[w * 3 + k] ?? ' ';
        let idx = tbl.indexOf(ch.toUpperCase());
        if (idx < 0) {
          this.report('A2356', col);
          idx = 0;
        }
        v = v * 40 + idx;
      }
      out.push((v >> 8) & 0xff, v & 0xff);
    }
    return out;
  }

  // ----- pass 2 ----------------------------------------------------------------------------------------------

  private pass2(): void {
    this.pass = 2;
    this.base = 10;
    for (const s of this.symList) if (s.kind === 'set') s.defined = false;
    for (const sec of this.sections) {
      sec.data = new Array(sec.size).fill(0);
      sec.fixups = [];
    }
    for (const st of this.stmts) {
      this.stmt = st;
      const p = st.parsed;
      if (st.skipped || !p || !p.op) continue;
      const op = p.op.upper;
      if (op === 'BASE') {
        try {
          const e = parseFullExpression(p.operands, { base: this.base }, p.operandsCol);
          const v = evaluate(e, this.evalCtx(st, true));
          if (v.kind === 'abs' && [2, 8, 10, 16].includes(v.v)) this.base = v.v;
        } catch {
          /* reported in pass 1 */
        }
        continue;
      }
      if (st.type === 'set' && st.setSym) {
        st.setSym.value = st.setValue!;
        st.setSym.defined = true;
        continue;
      }
      try {
        if (st.type === 'instr') this.pass2Instr(st, p);
        else if (st.type === 'dc') this.pass2Data(st, p);
        else if (st.type === 'align') this.pass2Align(st);
      } catch (e) {
        // Stack exhaustion on a pathological statement must not crash the build (same backstop as pass 1).
        if (e instanceof RangeError) this.report('A9002', p.op.col, 'statement too complex');
        else throw e;
      }
    }
    this.stmt = undefined as unknown as Stmt;
    // Labels never referenced: allocated after everything else, in definition order.
    const rest = this.symList.filter((s) => s.alloc === undefined && s.kind === 'label' && s.defined).sort((a, b) => (a.defOrder ?? 0) - (b.defOrder ?? 0));
    for (const s of rest) this.allocate(s);
  }

  private place(st: Stmt, bytes: number[], fixups: Array<import('./encoder.js').Fixup>): void {
    const sec = st.section!;
    const off = st.loc - sec.base;
    const xmask = new Array(bytes.length).fill(false);
    for (const fx of fixups) {
      for (let i = 0; i < fx.width; i++) xmask[fx.at + i] = true;
      if (!['ABS16', 'ABS32', 'PCREL16', 'PAGE8'].includes(fx.kind)) {
        this.report('A9001', fx.col, describeFixup(fx.kind, fx.width));
      }
      sec.fixups.push({ ...fx, at: off + fx.at, stmt: st });
    }
    for (let i = 0; i < bytes.length; i++) sec.data[off + i] = bytes[i];
    st.bytes = bytes;
    st.xmask = xmask;
  }

  private pass2Instr(st: Stmt, p: ParsedLine): void {
    const r = this.encode(st, p, 2);
    if (!r.ok) {
      // Errors were reported; keep the pass-1 size so later locations stay put.
      r.bytes = r.bytes.slice(0, st.size);
      while (r.bytes.length < st.size) r.bytes.push(0);
      r.fixups = r.fixups.filter((f) => f.at + f.width <= st.size);
    }
    if (r.bytes.length !== st.size) {
      this.report('A9002', p.op!.col, `phase error (${st.size} -> ${r.bytes.length} bytes)`);
      r.bytes.length = st.size;
    }
    this.place(st, r.bytes, r.fixups);
  }

  private pass2Data(st: Stmt, p: ParsedLine): void {
    const d = st.data!;
    const bytes: number[] = [];
    const fixups: Array<import('./encoder.js').Fixup> = [];
    const ops = p.operands;
    const col0 = p.operandsCol;
    const put = (v: number, n: number) => {
      for (let k = n - 1; k >= 0; k--) bytes.push((v >>> (8 * k)) & 0xff);
    };
    const valueInto = (text: string, col: number, elem: 1 | 2 | 4) => {
      const v = this.evalText(text, col);
      if (!v || v.kind === 'undef') {
        put(0, elem);
        return;
      }
      if (v.kind === 'abs') {
        const lim = elem === 1 ? [-128, 255] : elem === 2 ? [-32768, 65535] : [-0x80000000, 0xffffffff];
        if (v.v < lim[0] || v.v > lim[1]) this.report('A2328', col);
        put(v.v, elem);
        return;
      }
      const kind = v.fn === 'PAGE' && elem === 1 ? 'PAGE8' : v.fn ? 'ABS8' : elem === 2 ? 'ABS16' : elem === 4 ? 'ABS32' : 'ABS8';
      fixups.push({ at: bytes.length, width: elem, kind, value: v, col });
      put(0, elem);
    };
    if (d.kind === 'dcb') {
      const items = splitOperands(ops);
      const n = st.size / d.elem;
      // An out-of-range count (A2320/A2321) allocated nothing in pass 1: emit nothing (no phase error).
      if (n === 0) return;
      const start = bytes.length;
      valueInto(items[1].text, col0 + items[1].col, d.elem);
      const one = bytes.slice(start);
      const fx = fixups.slice();
      for (let i = 1; i < n; i++) {
        for (const f of fx) fixups.push({ ...f, at: f.at + i * d.elem });
        bytes.push(...one);
      }
    } else if (d.kind === 'rad50') {
      bytes.push(...(this.rad50(ops, col0) ?? []));
    } else {
      for (const it of splitOperands(ops)) {
        const str = quotedString(it.text);
        if (str !== undefined) {
          const n = Math.ceil(str.length / d.elem) * d.elem;
          for (let k = 0; k < n - str.length; k++) bytes.push(0);
          for (const ch of str) bytes.push(ch.charCodeAt(0) & 0xff);
          if (/[^\x00-\xff]/.test(str)) this.report('A9005', col0 + it.col, 'string');
          continue;
        }
        valueInto(it.text, col0 + it.col, d.elem);
      }
    }
    if (bytes.length !== st.size) {
      this.report('A9002', p.op!.col, `phase error (${st.size} -> ${bytes.length} bytes)`);
      bytes.length = st.size;
    }
    this.place(st, bytes, fixups);
  }

  private pass2Align(st: Stmt): void {
    if (!st.size) return;
    const sec = st.section!;
    if (sec.hasCode || sec.hasConst) this.place(st, new Array(st.size).fill(0), []);
  }
}

/** A DC operand that is a quoted string ('…' or "…"), or undefined. */
export function quotedString(t: string): string | undefined {
  if (t.length >= 2 && (t[0] === "'" || t[0] === '"') && t[t.length - 1] === t[0] && t.indexOf(t[0], 1) === t.length - 1) {
    return t.slice(1, -1);
  }
  return undefined;
}

function describeFixup(kind: string, width: number): string {
  if (kind === 'ABS8') return `${width * 8}-bit absolute fixup (direct page / byte / HIGH / LOW of a relocatable symbol)`;
  if (kind === 'PCREL8') return '8-bit PC-relative fixup';
  return kind;
}

