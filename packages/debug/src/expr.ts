/**
 * Debugger expression language (command window, Data window, breakpoint conditions). A C-like subset:
 *
 *   numbers     $FF  0xFF  0377 (octal)  %1010 (binary, in operand position)  255  'c' (char code)
 *   names       symbols (labels -> address; DWARF/ELF data objects -> their value, read from memory),
 *               `module.dbg:name` qualified symbols, command-file DEFINE variables,
 *               registers A B D X Y SP PC CCR (also IX IY IPL CCRW PPAGE RPAGE EPAGE GPAGE DIRECT, any case)
 *               and `$PC`-style register references (as in hiwave breakpoint conditions)
 *   unary       - + ~ !  &name (address of)  *addr (byte at addr)  (type)expr  *(type*)addr
 *               types: byte char word short int long, optionally signed/unsigned (int is 16-bit on HC12)
 *   memory      [addr] (byte), [addr, size] (size 1/2/4, big-endian)
 *   binary      * / %   + -   << >>   < <= > >=   == !=   &   ^   |   &&   || (C precedence, left-assoc)
 *
 * Arithmetic is on JS integers (division truncates); bitwise operators work on 32 bits (unsigned result).
 * Name lookup order is the environment's business (see CommandInterpreter): DEFINE variables, symbols
 * (exact case), registers, symbols (any case).
 *
 * The parser stops at the first token that cannot continue the expression and reports where (`end`), so
 * command arguments like `bs &main t`, `wb 0x100 CLKDIV`, `DB 0x4000..0x400F` and `T 0x4000,5` work.
 * Evaluation is written once as a generator that yields memory/register reads, driven synchronously
 * (simulator conditions) or asynchronously (any Target).
 */
import { canonicalRegister, type IdentValue, type RegisterName } from './target';

export class ExprError extends Error {
  constructor(
    message: string,
    readonly pos = -1,
  ) {
    super(message);
  }
}

export type Expr =
  | { k: 'num'; v: number }
  | { k: 'id'; name: string; pos: number }
  | { k: 'reg'; name: RegisterName }
  | { k: 'un'; op: '-' | '+' | '~' | '!'; e: Expr }
  | { k: 'bin'; op: string; a: Expr; b: Expr }
  | { k: 'addr'; e: Expr; pos: number }
  | { k: 'deref'; e: Expr }
  | { k: 'mem'; addr: Expr; size: number }
  | { k: 'cast'; size: number; signed: boolean; ptr: boolean; e: Expr };

type Tok =
  | { t: 'num'; v: number; pos: number; end: number }
  | { t: 'id'; v: string; pos: number; end: number }
  | { t: 'reg'; v: RegisterName; pos: number; end: number }
  | { t: 'op'; v: string; pos: number; end: number }
  | { t: 'bad'; v: string; pos: number; end: number }
  | { t: 'eof'; v: ''; pos: number; end: number };

export interface ParseOptions {
  /** Treat `$A`, `$B`, `$D` as registers instead of hex numbers (breakpoint conditions). */
  dollarRegisters?: boolean;
}

const OPS3: string[] = [];
const OPS2 = ['..', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>'];
const OPS1 = '+-*/%~!&|^<>()[],:=?;{}';
const ESC: Record<string, number> = { n: 10, t: 9, r: 13, '0': 0, '\\': 92, "'": 39, '"': 34, a: 7, b: 8, f: 12, v: 11 };

const isIdStart = (c: string | undefined) => !!c && /[A-Za-z_]/.test(c);
const isIdChar = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);

function lex(src: string, start: number, opts: ParseOptions): Tok[] {
  const out: Tok[] = [];
  let i = start;
  const operandBefore = () => {
    const p = out[out.length - 1];
    return !!p && (p.t === 'num' || p.t === 'id' || p.t === 'reg' || (p.t === 'op' && (p.v === ')' || p.v === ']')));
  };
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    const pos = i;
    // numbers
    if (/[0-9]/.test(c)) {
      let m: RegExpExecArray | null;
      const rest = src.slice(i);
      let v: number | undefined;
      let len = 0;
      if ((m = /^0[xX]([0-9A-Fa-f]+)/.exec(rest))) [v, len] = [parseInt(m[1], 16), m[0].length];
      else if ((m = /^0([0-7]+)(?![0-9])/.exec(rest))) [v, len] = [parseInt(m[1], 8), m[0].length];
      else if ((m = /^[0-9]+/.exec(rest))) [v, len] = [parseInt(m[0], 10), m[0].length];
      if (v === undefined || isIdChar(src[i + len])) {
        let j = i;
        while (j < src.length && isIdChar(src[j])) j++;
        out.push({ t: 'bad', v: src.slice(i, j), pos, end: j });
        break;
      }
      out.push({ t: 'num', v, pos, end: i + len });
      i += len;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < src.length && isIdChar(src[j])) j++;
      const w = src.slice(i + 1, j);
      const reg = canonicalRegister(w);
      if (reg && (opts.dollarRegisters || !/^[0-9A-Fa-f]+$/.test(w))) out.push({ t: 'reg', v: reg, pos, end: j });
      else if (/^[0-9A-Fa-f]+$/.test(w)) out.push({ t: 'num', v: parseInt(w, 16), pos, end: j });
      else {
        out.push({ t: 'bad', v: src.slice(i, j), pos, end: j });
        break;
      }
      i = j;
      continue;
    }
    if (c === '%' && !operandBefore() && /[01]/.test(src[i + 1] ?? '')) {
      let j = i + 1;
      while (j < src.length && /[01]/.test(src[j])) j++;
      if (isIdChar(src[j])) {
        out.push({ t: 'bad', v: src.slice(i, j + 1), pos, end: j + 1 });
        break;
      }
      out.push({ t: 'num', v: parseInt(src.slice(i + 1, j), 2), pos, end: j });
      i = j;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let v: number;
      if (src[j] === '\\') {
        const e = src[j + 1];
        if (e === 'x' && /^[0-9A-Fa-f]{1,2}/.test(src.slice(j + 2))) {
          const m = /^[0-9A-Fa-f]{1,2}/.exec(src.slice(j + 2))!;
          v = parseInt(m[0], 16);
          j += 2 + m[0].length;
        } else {
          v = ESC[e] ?? e.charCodeAt(0);
          j += 2;
        }
      } else {
        v = src.charCodeAt(j);
        j++;
      }
      if (src[j] !== "'" || Number.isNaN(v)) {
        out.push({ t: 'bad', v: src.slice(i, j), pos, end: j });
        break;
      }
      out.push({ t: 'num', v, pos, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      // '.' inside a name when followed by a name char (main.dbg, fibo.c) but never '..'
      while (j < src.length && (isIdChar(src[j]) || (src[j] === '.' && isIdChar(src[j + 1])))) j++;
      out.push({ t: 'id', v: src.slice(i, j), pos, end: j });
      i = j;
      continue;
    }
    if (c === '"') {
      out.push({ t: 'bad', v: '"', pos, end: i + 1 });
      break;
    }
    const three = src.slice(i, i + 3);
    if (OPS3.includes(three)) {
      out.push({ t: 'op', v: three, pos, end: i + 3 });
      i += 3;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) {
      out.push({ t: 'op', v: two, pos, end: i + 2 });
      i += 2;
      continue;
    }
    if (OPS1.includes(c)) {
      out.push({ t: 'op', v: c, pos, end: i + 1 });
      i++;
      continue;
    }
    out.push({ t: 'bad', v: c, pos, end: i + 1 });
    break;
  }
  out.push({ t: 'eof', v: '', pos: i, end: i });
  return out;
}

const BIN_PREC: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '<': 7,
  '<=': 7,
  '>': 7,
  '>=': 7,
  '<<': 8,
  '>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10,
};

const TYPE_WORDS = new Set(['byte', 'char', 'word', 'short', 'int', 'long', 'unsigned', 'signed']);

class Parser {
  i = 0;
  constructor(
    readonly toks: Tok[],
    readonly src: string,
  ) {}
  peek(o = 0): Tok {
    return this.toks[Math.min(this.i + o, this.toks.length - 1)];
  }
  next(): Tok {
    return this.toks[this.i++];
  }
  isOp(v: string, o = 0): boolean {
    const t = this.peek(o);
    return t.t === 'op' && t.v === v;
  }
  expect(v: string): void {
    if (!this.isOp(v)) throw new ExprError(`'${v}' expected`, this.peek().pos);
    this.i++;
  }
  /** End offset of the last consumed token. */
  get end(): number {
    return this.i === 0 ? this.toks[0].pos : this.toks[this.i - 1].end;
  }

  expr(minPrec = 1): Expr {
    let a = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op') break;
      const p = BIN_PREC[t.v];
      if (p === undefined || p < minPrec) break;
      this.i++;
      const b = this.expr(p + 1);
      a = { k: 'bin', op: t.v, a, b };
    }
    return a;
  }

  /** `(type [*])` at the current position: returns the cast spec and consumes it, or undefined. */
  tryCast(): { size: number; signed: boolean; ptr: boolean } | undefined {
    if (!this.isOp('(')) return undefined;
    let j = 1;
    const words: string[] = [];
    while (this.peek(j).t === 'id' && TYPE_WORDS.has(String(this.peek(j).v).toLowerCase())) {
      words.push(String(this.peek(j).v).toLowerCase());
      j++;
    }
    if (!words.length) return undefined;
    let ptr = false;
    if (this.peek(j).t === 'op' && this.peek(j).v === '*') {
      ptr = true;
      j++;
    }
    if (!(this.peek(j).t === 'op' && this.peek(j).v === ')')) return undefined;
    this.i += j + 1;
    const base = words.filter((w) => w !== 'unsigned' && w !== 'signed');
    if (base.length > 1) throw new ExprError(`bad type '${words.join(' ')}'`, this.peek().pos);
    const b = base[0] ?? 'int';
    const size = b === 'byte' || b === 'char' ? 1 : b === 'long' ? 4 : 2;
    const signed = words.includes('signed') || (!words.includes('unsigned') && (b === 'char' || b === 'short' || b === 'int' || b === 'long'));
    return { size, signed, ptr };
  }

  unary(): Expr {
    const t = this.peek();
    if (t.t === 'op') {
      if (t.v === '-' || t.v === '+' || t.v === '~' || t.v === '!') {
        this.i++;
        return { k: 'un', op: t.v, e: this.unary() };
      }
      if (t.v === '&') {
        this.i++;
        return { k: 'addr', e: this.unary(), pos: t.pos };
      }
      if (t.v === '*') {
        this.i++;
        return { k: 'deref', e: this.unary() };
      }
      if (t.v === '(') {
        const cast = this.tryCast();
        if (cast) return { k: 'cast', ...cast, e: this.unary() };
      }
    }
    return this.primary();
  }

  primary(): Expr {
    const t = this.next();
    switch (t.t) {
      case 'num':
        return { k: 'num', v: t.v };
      case 'reg':
        return { k: 'reg', name: t.v };
      case 'id': {
        let name = t.v;
        // module-qualified symbol: main.dbg:main, fibo.c:main
        if (name.includes('.') && this.isOp(':') && this.peek(1).t === 'id' && this.peek(1).pos === this.peek().end) {
          this.i++;
          name += ':' + String(this.next().v);
        }
        return { k: 'id', name, pos: t.pos };
      }
      case 'op':
        if (t.v === '(') {
          const e = this.expr();
          this.expect(')');
          return e;
        }
        if (t.v === '[') {
          const addr = this.expr();
          let size = 1;
          if (this.isOp(',')) {
            this.i++;
            const s = this.next();
            if (s.t !== 'num' || ![1, 2, 4].includes(s.v)) throw new ExprError('memory access size must be 1, 2 or 4', s.pos);
            size = s.v;
          }
          this.expect(']');
          return { k: 'mem', addr, size };
        }
        throw new ExprError(`unexpected '${t.v}'`, t.pos);
      case 'bad':
        throw new ExprError(`invalid token '${t.v}'`, t.pos);
      case 'eof':
        throw new ExprError('expression expected', t.pos);
    }
  }
}

export interface ParsedExpr {
  ast: Expr;
  /** Source offset just past the expression. */
  end: number;
}

/** Parse the longest expression starting at `start` (leading blanks skipped). */
export function parseExpr(src: string, start = 0, opts: ParseOptions = {}): ParsedExpr {
  const p = new Parser(lex(src, start, opts), src);
  const ast = p.expr();
  return { ast, end: p.end };
}

/** Parse a whole string as one expression (trailing text is an error). */
export function parseExprFull(src: string, opts: ParseOptions = {}): Expr {
  const r = parseExpr(src, 0, opts);
  const rest = src.slice(r.end).trim();
  if (rest) throw new ExprError(`unexpected '${rest}' after expression`, r.end);
  return r.ast;
}

// ------------------------------------------------------------------------------------------- evaluation

export type ReadRequest = { op: 'mem'; address: number; size: number; signed: boolean } | { op: 'reg'; name: RegisterName };

export interface ExprEnvBase {
  /** Resolve a name (DEFINE variable, symbol, register...). */
  lookup(name: string): IdentValue | undefined;
}

export interface SyncExprEnv extends ExprEnvBase {
  readMemory(address: number, size: number): number;
  readRegister(name: RegisterName): number;
}

export interface AsyncExprEnv extends ExprEnvBase {
  readMemory(address: number, size: number): Promise<number> | number;
  readRegister(name: RegisterName): Promise<number> | number;
}

export interface EvalOptions {
  /**
   * Address arguments (DB state, DB state+1, DB state..state+3, WB state+1 v, BS label): a data-object
   * name denotes its address, also inside arithmetic (+ - * / % << >> & | ^, unary + -). Under a memory access
   * (`*`, `[ ]`), a cast, a comparison or a logical operator, names denote their values again.
   */
  addressContext?: boolean;
}

/** Operators through which "a data name denotes its address" propagates in an address argument. */
const ADDRESS_ARITH = new Set(['+', '-', '*', '/', '%', '<<', '>>', '&', '|', '^']);

const signExtend = (v: number, size: number): number => {
  const bits = size * 8;
  if (bits >= 32) return v | 0;
  const m = 1 << (bits - 1);
  return ((v & ((1 << bits) - 1)) ^ m) - m;
};
const truncate = (v: number, size: number): number => (size >= 4 ? v >>> 0 : v & ((1 << (size * 8)) - 1));

type Gen = Generator<ReadRequest, number, number>;

/** `addr`: a data-object name here denotes its address (see EvalOptions.addressContext). */
function* evalGen(e: Expr, env: ExprEnvBase, opts: EvalOptions, addr: boolean): Gen {
  switch (e.k) {
    case 'num':
      return e.v;
    case 'reg':
      return yield { op: 'reg', name: e.name };
    case 'id': {
      const v = env.lookup(e.name);
      if (!v) throw new ExprError(`Undefined symbol: ${e.name}`, e.pos);
      switch (v.kind) {
        case 'const':
          return v.value;
        case 'label':
          return v.address;
        case 'register':
          return yield { op: 'reg', name: v.name };
        case 'var':
          if (v.array || addr) return v.address;
          return yield { op: 'mem', address: v.address, size: v.size, signed: !!v.signed };
      }
      return 0;
    }
    case 'addr': {
      const inner = e.e;
      if (inner.k === 'id') {
        const v = env.lookup(inner.name);
        if (!v) throw new ExprError(`Undefined symbol: ${inner.name}`, inner.pos);
        if (v.kind === 'var' || v.kind === 'label') return v.address;
        throw new ExprError(`Cannot take the address of ${inner.name}`, e.pos);
      }
      if (inner.k === 'deref') return yield* evalPointer(inner.e, env, opts).address;
      if (inner.k === 'mem') return yield* evalGen(inner.addr, env, opts, false);
      throw new ExprError('Address operator needs a symbol', e.pos);
    }
    case 'deref': {
      const p = evalPointer(e.e, env, opts);
      const address = yield* p.address;
      return yield { op: 'mem', address: address & 0xffffff, size: p.size, signed: p.signed };
    }
    case 'mem': {
      const address = yield* evalGen(e.addr, env, opts, false);
      return yield { op: 'mem', address: address & 0xffffff, size: e.size, signed: false };
    }
    case 'cast': {
      const v = yield* evalGen(e.e, env, opts, false);
      if (e.ptr) return v;
      return e.signed ? signExtend(v, e.size) : truncate(v, e.size);
    }
    case 'un': {
      const v = yield* evalGen(e.e, env, opts, addr && (e.op === '-' || e.op === '+'));
      switch (e.op) {
        case '-':
          return -v;
        case '+':
          return v;
        case '~':
          return ~v >>> 0;
        case '!':
          return v ? 0 : 1;
      }
      return 0;
    }
    case 'bin': {
      const sub = addr && ADDRESS_ARITH.has(e.op);
      const a = yield* evalGen(e.a, env, opts, sub);
      if (e.op === '&&') return a ? ((yield* evalGen(e.b, env, opts, false)) ? 1 : 0) : 0;
      if (e.op === '||') return a ? 1 : (yield* evalGen(e.b, env, opts, false)) ? 1 : 0;
      const b = yield* evalGen(e.b, env, opts, sub);
      switch (e.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          if (b === 0) throw new ExprError('Division by zero');
          return Math.trunc(a / b);
        case '%':
          if (b === 0) throw new ExprError('Division by zero');
          return a % b;
        case '<<':
          return (a << b) >>> 0;
        case '>>':
          return a >>> b;
        case '&':
          return (a & b) >>> 0;
        case '|':
          return (a | b) >>> 0;
        case '^':
          return (a ^ b) >>> 0;
        case '==':
          return a === b ? 1 : 0;
        case '!=':
          return a !== b ? 1 : 0;
        case '<':
          return a < b ? 1 : 0;
        case '<=':
          return a <= b ? 1 : 0;
        case '>':
          return a > b ? 1 : 0;
        case '>=':
          return a >= b ? 1 : 0;
      }
      throw new ExprError(`unknown operator ${e.op}`);
    }
  }
}

/** Pointer operand of `*`: `(type*)expr` gives the access size; anything else reads a byte. */
function evalPointer(e: Expr, env: ExprEnvBase, opts: EvalOptions): { address: Gen; size: number; signed: boolean } {
  if (e.k === 'cast' && e.ptr) return { address: evalGen(e.e, env, opts, false), size: e.size, signed: e.signed };
  // `*sym` with sym a data object: the object's value is the pointer (C semantics)
  return { address: evalGen(e, env, opts, false), size: 1, signed: false };
}

function finishRead(req: ReadRequest, raw: number): number {
  return req.op === 'mem' && req.signed ? signExtend(raw, req.size) : raw;
}

/** Evaluate synchronously (simulator breakpoint conditions). */
export function evaluateSync(e: Expr | string, env: SyncExprEnv, opts: EvalOptions & ParseOptions = {}): number {
  const ast = typeof e === 'string' ? parseExprFull(e, opts) : e;
  const g = evalGen(ast, env, opts, !!opts.addressContext);
  let r = g.next();
  while (!r.done) {
    const req = r.value;
    const raw = req.op === 'mem' ? env.readMemory(req.address, req.size) : env.readRegister(req.name);
    r = g.next(finishRead(req, raw));
  }
  return r.value;
}

/** Evaluate against any (async) target. */
export async function evaluateAsync(e: Expr | string, env: AsyncExprEnv, opts: EvalOptions & ParseOptions = {}): Promise<number> {
  const ast = typeof e === 'string' ? parseExprFull(e, opts) : e;
  const g = evalGen(ast, env, opts, !!opts.addressContext);
  let r = g.next();
  while (!r.done) {
    const req = r.value;
    const raw = await (req.op === 'mem' ? env.readMemory(req.address, req.size) : env.readRegister(req.name));
    r = g.next(finishRead(req, raw));
  }
  return r.value;
}

/** Names referenced by an expression (for diagnostics / UI). */
export function exprNames(e: Expr): string[] {
  const out: string[] = [];
  const walk = (x: Expr): void => {
    switch (x.k) {
      case 'id':
        out.push(x.name);
        return;
      case 'un':
      case 'addr':
      case 'deref':
      case 'cast':
        walk(x.e);
        return;
      case 'mem':
        walk(x.addr);
        return;
      case 'bin':
        walk(x.a);
        walk(x.b);
        return;
    }
  };
  walk(e);
  return out;
}

/** Big-endian value of `size` bytes. */
export function beValue(bytes: ArrayLike<number>, offset = 0, size = bytes.length): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + (bytes[offset + i] & 0xff);
  return v;
}
