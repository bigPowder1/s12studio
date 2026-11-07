// Burner (.bbl) command-file parser and execute planner. Spec: docs/research/r1/asm.md §10, wizard burner.bbl §7.
// Statements: OPENFILE "f" | OPENCOM n | name (= | :=) value | SENDBYTE n "file" | SENDWORD n "file" | CLOSE |
//             ECHO "text" | PAUSE "text" | IF cond THEN ... [ELSE ...] END | FOR i = a TO b DO ... END
// Comments: /* */, (* *), and // (UNCERTAIN: // is not in the manual but harmless). Keywords are case-insensitive.
// Macros `%NAME%` (e.g. %ABS_FILE%) are expanded only by the planner.

import type { SRecordWriteOptions } from '../srec/srec';

export interface BblPos {
  line: number;
  col: number;
}

export type BblValue = number | string;

export type BblCommand =
  | ({ kind: 'openfile'; file: string } & BblPos)
  | ({ kind: 'opencom'; port: BblValue } & BblPos)
  /** parameter assignment; `name` is as written, `key` lower-cased */
  | ({ kind: 'set'; name: string; key: string; value: BblValue; raw: string } & BblPos)
  | ({ kind: 'send'; width: 'byte' | 'word'; lane: number; file: string } & BblPos)
  | ({ kind: 'close' } & BblPos)
  | ({ kind: 'echo'; text: string } & BblPos)
  | ({ kind: 'pause'; text: string } & BblPos)
  | ({ kind: 'if'; condition: string; then: BblCommand[]; else: BblCommand[] } & BblPos)
  | ({ kind: 'for'; variable: string; from: number; to: number; body: BblCommand[] } & BblPos);

export interface BblError extends BblPos {
  message: string;
}

export interface BblFile {
  commands: BblCommand[];
  errors: BblError[];
}

// ------------------------------------------------------------------ lexer
interface Tok extends BblPos {
  kind: 'word' | 'string' | 'punct' | 'nl';
  text: string;
}

function lex(src: string, errors: BblError[]): Tok[] {
  const out: Tok[] = [];
  let i = 0, line = 1, ls = 0;
  const pos = (at: number): BblPos => ({ line, col: at - ls + 1 });
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      out.push({ kind: 'nl', text: '\n', ...pos(i) });
      line++;
      ls = i + 1;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ((c === '/' && src[i + 1] === '*') || (c === '(' && src[i + 1] === '*')) {
      const close = c === '/' ? '*/' : '*)';
      const p = pos(i);
      const end = src.indexOf(close, i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (let k = i; k < stop; k++)
        if (src[k] === '\n') {
          line++;
          ls = k + 1;
        }
      if (end < 0) errors.push({ ...p, message: 'unterminated comment' });
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
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
    if (c === ':' && src[i + 1] === '=') {
      out.push({ kind: 'punct', text: ':=', ...pos(i) });
      i += 2;
      continue;
    }
    if (c === '=' || c === ';' || c === ',') {
      out.push({ kind: 'punct', text: c, ...pos(i) });
      i++;
      continue;
    }
    const p = pos(i);
    let j = i;
    while (j < src.length && !/[\s="';,]/.test(src[j]) && !(src[j] === ':' && src[j + 1] === '=') && !(j > i && ((src[j] === '/' && src[j + 1] === '*') || (src[j] === '(' && src[j + 1] === '*')))) j++;
    if (j === i) j++;
    out.push({ kind: 'word', text: src.slice(i, j), ...p });
    i = j;
  }
  return out;
}

export function parseBblNumber(text: string): number | undefined {
  let m: RegExpExecArray | null;
  if ((m = /^0[xX]([0-9A-Fa-f]+)$/.exec(text))) return parseInt(m[1], 16);
  if ((m = /^\$([0-9A-Fa-f]+)$/.exec(text))) return parseInt(m[1], 16);
  if ((m = /^([0-9A-Fa-f]+)[hH]$/.exec(text)) && /^[0-9]/.test(text)) return parseInt(m[1], 16);
  if (/^[0-9]+$/.test(text)) return parseInt(text, 10);
  return undefined;
}

// ------------------------------------------------------------------ parser
const BLOCK_END = new Set(['END', 'ELSE']);

class Parser {
  i = 0;
  constructor(readonly t: Tok[], readonly errors: BblError[]) {}
  peek(): Tok | undefined {
    while (this.t[this.i]?.kind === 'nl') this.i++;
    return this.t[this.i];
  }
  next(): Tok | undefined {
    const t = this.peek();
    if (t) this.i++;
    return t;
  }
  /** next token on the same line (no newline skipping) */
  sameLine(): Tok | undefined {
    const t = this.t[this.i];
    return t && t.kind !== 'nl' ? t : undefined;
  }
  err(at: BblPos, message: string) {
    this.errors.push({ line: at.line, col: at.col, message });
  }
  skipLine() {
    while (this.t[this.i] && this.t[this.i].kind !== 'nl') this.i++;
  }
  value(at: Tok): { value: BblValue; raw: string } | undefined {
    const v = this.sameLine();
    if (!v || v.kind === 'punct') {
      this.err(at, `missing value for ${at.text}`);
      return undefined;
    }
    this.i++;
    if (v.kind === 'string') return { value: v.text, raw: `"${v.text}"` };
    const n = parseBblNumber(v.text);
    return { value: n ?? v.text, raw: v.text };
  }

  block(stops: Set<string>): BblCommand[] {
    const out: BblCommand[] = [];
    for (;;) {
      const tok = this.peek();
      if (!tok) return out;
      const k = tok.kind === 'word' ? tok.text.toUpperCase() : '';
      if (stops.has(k)) return out;
      this.i++;
      if (tok.kind === 'punct') {
        if (tok.text !== ';') this.err(tok, `unexpected '${tok.text}'`);
        continue;
      }
      if (tok.kind === 'string') {
        this.err(tok, 'unexpected string');
        continue;
      }
      const pos = { line: tok.line, col: tok.col };
      switch (k) {
        case 'OPENFILE': {
          const f = this.sameLine();
          if (!f || f.kind === 'punct') {
            this.err(tok, 'OPENFILE expects a file name');
            break;
          }
          this.i++;
          out.push({ kind: 'openfile', file: f.text, ...pos });
          break;
        }
        case 'OPENCOM': {
          const v = this.value(tok);
          if (v) out.push({ kind: 'opencom', port: v.value, ...pos });
          break;
        }
        case 'SENDBYTE':
        case 'SENDWORD': {
          const n = this.sameLine();
          const lane = n && n.kind === 'word' ? parseBblNumber(n.text) : undefined;
          if (lane === undefined) {
            this.err(tok, `${k} expects a lane number`);
            this.skipLine();
            break;
          }
          this.i++;
          const f = this.sameLine();
          if (!f || f.kind === 'punct') {
            this.err(tok, `${k} expects a file name`);
            break;
          }
          this.i++;
          out.push({ kind: 'send', width: k === 'SENDBYTE' ? 'byte' : 'word', lane, file: f.text, ...pos });
          break;
        }
        case 'CLOSE':
          out.push({ kind: 'close', ...pos });
          break;
        case 'ECHO':
        case 'PAUSE': {
          const s = this.sameLine();
          let text = '';
          if (s && s.kind === 'string') {
            this.i++;
            text = s.text;
          }
          out.push({ kind: k === 'ECHO' ? 'echo' : 'pause', text, ...pos });
          break;
        }
        case 'IF': {
          const cond: string[] = [];
          for (;;) {
            const c = this.next();
            if (!c) {
              this.err(tok, 'IF without THEN');
              return out;
            }
            if (c.kind === 'word' && c.text.toUpperCase() === 'THEN') break;
            cond.push(c.kind === 'string' ? `"${c.text}"` : c.text);
          }
          const thenB = this.block(BLOCK_END);
          let elseB: BblCommand[] = [];
          if (this.peek()?.text.toUpperCase() === 'ELSE') {
            this.next();
            elseB = this.block(new Set(['END']));
          }
          if (this.peek()?.text.toUpperCase() === 'END') this.next();
          else this.err(tok, 'missing END for IF');
          out.push({ kind: 'if', condition: cond.join(' '), then: thenB, else: elseB, ...pos });
          break;
        }
        case 'FOR': {
          const v = this.next();
          const eq = this.next();
          const a = this.next();
          const to = this.next();
          const b = this.next();
          const d = this.next();
          const from = a ? parseBblNumber(a.text) : undefined;
          const upto = b ? parseBblNumber(b.text) : undefined;
          if (!v || !eq || (eq.text !== '=' && eq.text !== ':=') || from === undefined || to?.text.toUpperCase() !== 'TO' || upto === undefined || d?.text.toUpperCase() !== 'DO') {
            this.err(tok, 'malformed FOR (expected FOR i = a TO b DO)');
            this.skipLine();
            break;
          }
          // UNCERTAIN: the manual says the loop variable must be `i`
          if (v.text !== 'i') this.err(v, "FOR loop variable must be 'i'");
          const body = this.block(new Set(['END']));
          if (this.peek()?.text.toUpperCase() === 'END') this.next();
          else this.err(tok, 'missing END for FOR');
          out.push({ kind: 'for', variable: v.text, from, to: upto, body, ...pos });
          break;
        }
        default: {
          // parameter assignment: name = value | name := value | name value (UNCERTAIN: bare form)
          const nx = this.sameLine();
          if (!nx) {
            this.err(tok, `unknown command ${JSON.stringify(tok.text)}`);
            break;
          }
          if (nx.kind === 'punct' && (nx.text === '=' || nx.text === ':=')) this.i++;
          const v = this.value(tok);
          if (v) out.push({ kind: 'set', name: tok.text, key: tok.text.toLowerCase(), value: v.value, raw: v.raw, ...pos });
          else this.skipLine();
        }
      }
    }
  }
}

export function parseBbl(text: string): BblFile {
  const errors: BblError[] = [];
  const toks = lex(text, errors);
  const p = new Parser(toks, errors);
  const commands = p.block(new Set());
  return { commands, errors: errors.sort((a, b) => a.line - b.line || a.col - b.col) };
}

// ------------------------------------------------------------------ execute plan
export interface BblTransfer extends BblPos {
  /** input file with macros expanded */
  input: string;
  width: 'byte' | 'word';
  lane: number;
  /** source window [origin, origin+len) in the input's address space */
  origin: number;
  len: number;
  /** destination of `origin` in the output */
  destination: number;
  busWidth: number;
}

export interface BblOutput extends BblPos {
  /** output file with macros expanded; for OPENCOM, "COM<n>" */
  file: string;
  isCom: boolean;
  /** "motorola"/"freescale" → 'srecord', "intel", "binary" */
  format: string;
  /** SRECORD setting: 'Sx' | 'S1' | 'S2' | 'S3' */
  srecord: string;
  sLineLen: number;
  undefByte: number;
  swapByte: boolean;
  transfers: BblTransfer[];
}

export interface BblPlan {
  outputs: BblOutput[];
  messages: string[];
  warnings: string[];
}

export interface BblPlanOptions {
  /** macro values, e.g. { ABS_FILE: 'C:\\...\\bin\\Project.abs' } */
  env?: Record<string, string>;
}

/**
 * Burner defaults (asm.md §10): len 0x10000, undefByte 0xFF, SLINELEN 32, busWidth 1. UNCERTAIN: origin/destination 0.
 * Keys are lower-case: `set` commands store parameters under their lower-cased name and the planner looks them up that way.
 */
const DEFAULTS: Record<string, BblValue> = { format: 'motorola', buswidth: 1, origin: 0, len: 0x10000, destination: 0, srecord: 'Sx', slinelen: 32, undefbyte: 0xff, swapbyte: 0 };

export function expandBblMacros(s: string, env: Record<string, string>, warnings?: string[]): string {
  return s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => {
    if (name in env) return env[name];
    warnings?.push(`undefined macro ${m}`);
    return m;
  });
}

function evalCondition(cond: string, vars: Record<string, number>): boolean | undefined {
  const m = /^\s*([A-Za-z_]\w*|\d+|0x[0-9a-f]+)\s*(=|==|<>|!=|<=|>=|<|>)\s*([A-Za-z_]\w*|\d+|0x[0-9a-f]+)\s*$/i.exec(cond);
  if (!m) return undefined;
  const val = (s: string) => (s in vars ? vars[s] : parseBblNumber(s));
  const a = val(m[1]), b = val(m[3]);
  if (a === undefined || b === undefined) return undefined;
  switch (m[2]) {
    case '=': case '==': return a === b;
    case '<>': case '!=': return a !== b;
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    default: return a >= b;
  }
}

/** Execute the command list symbolically: which output files get which address windows of which inputs. */
export function planBbl(file: BblFile | BblCommand[], opts: BblPlanOptions = {}): BblPlan {
  const env = opts.env ?? {};
  const plan: BblPlan = { outputs: [], messages: [], warnings: [] };
  const state: Record<string, BblValue> = { ...DEFAULTS };
  let cur: BblOutput | undefined;
  const num = (k: string): number => {
    const v = state[k];
    if (typeof v === 'number') return v;
    plan.warnings.push(`parameter ${k} is not numeric (${v}); using 0`);
    return 0;
  };
  const str = (s: string, vars: Record<string, number>) => {
    let r = expandBblMacros(s, env, plan.warnings);
    if ('i' in vars) r = r.replace(/#/g, String(vars.i));
    return r;
  };
  const open = (c: BblPos, file: string, isCom: boolean) => {
    if (cur) plan.warnings.push(`line ${c.line}: output opened while ${cur.file} still open; closing it`);
    const fmt = String(state.format).toLowerCase();
    cur = {
      file,
      isCom,
      format: fmt === 'motorola' || fmt === 'freescale' ? 'srecord' : fmt,
      srecord: String(state.srecord),
      sLineLen: num('slinelen'),
      undefByte: num('undefbyte'),
      swapByte: !!state.swapbyte && String(state.swapbyte).toLowerCase() !== 'off',
      transfers: [],
      line: c.line,
      col: c.col,
    };
    plan.outputs.push(cur);
  };
  const run = (cmds: BblCommand[], vars: Record<string, number>) => {
    for (const c of cmds) {
      switch (c.kind) {
        case 'openfile':
          open(c, str(c.file, vars), false);
          break;
        case 'opencom':
          open(c, `COM${c.port}`, true);
          break;
        case 'set': {
          const v = typeof c.value === 'string' && c.value in vars ? vars[c.value] : c.value;
          state[c.key] = v;
          // UNCERTAIN: output-format parameters set after OPENFILE still apply to the open file (the Lab3 .bbl sets them after OPENFILE)
          if (cur) {
            if (c.key === 'format') {
              const f = String(v).toLowerCase();
              cur.format = f === 'motorola' || f === 'freescale' ? 'srecord' : f;
            } else if (c.key === 'srecord') cur.srecord = String(v);
            else if (c.key === 'slinelen' && typeof v === 'number') cur.sLineLen = v;
            else if (c.key === 'undefbyte' && typeof v === 'number') cur.undefByte = v;
            else if (c.key === 'swapbyte') cur.swapByte = !!v && String(v).toLowerCase() !== 'off';
          }
          break;
        }
        case 'send':
          if (!cur) {
            plan.warnings.push(`line ${c.line}: SEND without an open output`);
            break;
          }
          cur.transfers.push({
            input: str(c.file, vars),
            width: c.width,
            lane: c.lane,
            origin: num('origin'),
            len: num('len'),
            destination: num('destination'),
            busWidth: num('buswidth'),
            line: c.line,
            col: c.col,
          });
          break;
        case 'close':
          if (!cur) plan.warnings.push(`line ${c.line}: CLOSE without an open output`);
          cur = undefined;
          break;
        case 'echo':
        case 'pause':
          plan.messages.push(str(c.text, vars));
          break;
        case 'if': {
          const r = evalCondition(c.condition, vars);
          if (r === undefined) plan.warnings.push(`line ${c.line}: cannot evaluate IF condition "${c.condition}"; taking THEN branch`);
          run(r === false ? c.else : c.then, vars);
          break;
        }
        case 'for':
          for (let i = c.from; i <= c.to; i++) run(c.body, { ...vars, [c.variable]: i });
          break;
      }
    }
  };
  run(Array.isArray(file) ? file : file.commands, {});
  if (cur) plan.warnings.push(`output ${(cur as BblOutput).file} not closed`);
  return plan;
}

/**
 * S-record writer options for one planned output: maps `SRECORD` -> recordType, `SLINELEN` -> bytesPerRecord.
 * `header` should be the absolute path of the input .abs (CodeWarrior writes the .abs path into S0, not the output path).
 */
export function bblOutputWriteOptions(output: BblOutput, header?: string): SRecordWriteOptions {
  const sr = output.srecord.toUpperCase();
  const recordType: SRecordWriteOptions['recordType'] = sr === 'S1' || sr === 'S2' || sr === 'S3' ? sr : 'auto';
  return { header, recordType, bytesPerRecord: output.sLineLen > 0 ? output.sLineLen : 32 };
}

export interface BblBlock {
  address: number;
  data: Uint8Array;
}

/**
 * Apply one output's byte transfers (busWidth 1, SENDBYTE 1) to an input memory image.
 * Returns address-sorted, coalesced blocks at destination addresses.
 * UNCERTAIN: overlapping transfers — later transfers overwrite earlier ones; adjacent ranges are merged.
 */
export function applyBblTransfers(input: BblBlock[], transfers: BblTransfer[], warnings: string[] = []): BblBlock[] {
  const mem = new Map<number, number>();
  for (const t of transfers) {
    if (t.width !== 'byte' || t.busWidth !== 1 || t.lane !== 1) {
      warnings.push(`line ${t.line}: only busWidth 1 / SENDBYTE 1 transfers are supported`);
      continue;
    }
    const lo = t.origin, hi = t.origin + t.len;
    for (const b of input) {
      const s = Math.max(lo, b.address), e = Math.min(hi, b.address + b.data.length);
      for (let a = s; a < e; a++) mem.set(a - t.origin + t.destination, b.data[a - b.address]);
    }
  }
  const addrs = [...mem.keys()].sort((a, b) => a - b);
  const out: BblBlock[] = [];
  let k = 0;
  while (k < addrs.length) {
    let j = k;
    while (j + 1 < addrs.length && addrs[j + 1] === addrs[j] + 1) j++;
    const data = new Uint8Array(j - k + 1);
    for (let x = k; x <= j; x++) data[x - k] = mem.get(addrs[x])!;
    out.push({ address: addrs[k], data });
    k = j + 1;
  }
  return out;
}
