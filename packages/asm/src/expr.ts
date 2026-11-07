/**
 * CodeWarrior assembler expressions: constants, operators, precedence (ANSI C, manual Table 7.3), HIGH/LOW/PAGE,
 * force-size operators and the absolute / simple-relocatable / external / complex value classes
 * (manual Tables 7.4/7.5).
 *
 * Precedence, highest first: () ; unary ~ + - ! ; * / % ; + - ; << >> ; < <= > >= ; = == != <> ; & ; ^ ; |.
 * UNCERTAIN: unary `!` is placed with the other unary operators (the manual table omits it).
 * Arithmetic is 32-bit (manual: `~$C` = `$FFFFFFF3`); `>>` is arithmetic on the signed 32-bit value
 * (UNCERTAIN, no example with a negative left operand).
 */

export type Expr =
  | { t: 'num'; v: number; pos: number; /** More than 32 significant bits (A1057). */ ovf?: boolean }
  | { t: 'chr'; v: number; text: string; pos: number; /** Contains a character code above 0xFF (A9005). */ wide?: boolean }
  | { t: 'sym'; name: string; pos: number }
  | { t: 'pc'; pos: number }
  | { t: 'un'; op: '-' | '+' | '~' | '!'; e: Expr; pos: number }
  | { t: 'bin'; op: BinOp; l: Expr; r: Expr; pos: number }
  | { t: 'fn'; fn: 'HIGH' | 'LOW' | 'PAGE'; e: Expr; pos: number }
  | { t: 'force'; size: 8 | 16; e: Expr; pos: number };

export type BinOp = '*' | '/' | '%' | '+' | '-' | '<<' | '>>' | '<' | '<=' | '>' | '>=' | '==' | '!=' | '&' | '^' | '|';

export class ExprError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly pos: number,
  ) {
    super(message);
  }
}

export interface ParseOptions {
  /** Default number base (BASE directive), 2/8/10/16. */
  base: number;
}

const ID_START = /[A-Za-z_.]/;
const ID_CHAR = /[A-Za-z0-9_.]/;

/** Parse a numeric literal starting at a digit (default base and MASM suffixes h/d/o/q/b). */
export function parseDigitNumber(tok: string, base: number): number | undefined {
  return parseDigitNumberEx(tok, base)?.v;
}

/** As parseDigitNumber, also telling whether the literal needed more than 32 bits (A1057). */
export function parseDigitNumberEx(tok: string, base: number): { v: number; ovf: boolean } | undefined {
  const tryBase = (s: string, b: number): { v: number; ovf: boolean } | undefined => {
    if (!s) return undefined;
    const re = b === 16 ? /^[0-9A-Fa-f]+$/ : b === 10 ? /^[0-9]+$/ : b === 8 ? /^[0-7]+$/ : /^[01]+$/;
    if (!re.test(s)) return undefined;
    return { v: parseBig(s, b), ovf: overflows32(s, b) };
  };
  const last = tok[tok.length - 1].toLowerCase();
  const body = tok.slice(0, -1);
  // Suffix forms (manual Appendix C): 200h, 512d, 17o/17q, 101b. In base 16, a trailing D or B selects the
  // suffix meaning (manual: "constant 45D is interpreted as decimal 45").
  if (last === 'h') return tryBase(body, 16);
  if (last === 'o' || last === 'q') return tryBase(body, 8);
  if (last === 'd') {
    const v = tryBase(body, 10);
    if (v !== undefined) return v;
  }
  if (last === 'b') {
    const v = tryBase(body, 2);
    if (v !== undefined) return v;
  }
  return tryBase(tok, base);
}

/** Parse digits in base b, wrapping to 32 bits (overflow is flagged on the AST node and warned as A1057). */
function parseBig(s: string, b: number): number {
  let v = 0;
  for (const c of s) v = (v * b + parseInt(c, 16)) % 0x100000000;
  return v | 0;
}

/** True when the value needs more than 32 bits. */
export function overflows32(s: string, b: number): boolean {
  let v = 0;
  for (const c of s) {
    v = v * b + parseInt(c, 16);
    if (v > 0xffffffff) return true;
  }
  return false;
}

/**
 * Expression size limits. The recursive-descent parser and evaluator would otherwise exhaust the JS stack on
 * pathological input (hundreds of nested parentheses / unary operators, thousands of chained terms) and crash the
 * whole build. Exceeding a limit reports A9002 at that expression.
 * UNCERTAIN: CodeWarrior's own limits are unknown; real programs nest a handful of levels.
 */
export const MAX_EXPR_NESTING = 100;
export const MAX_EXPR_NODES = 2000;

class Parser {
  i = 0;
  private depth = 0;
  private nodes = 0;
  constructor(
    readonly s: string,
    readonly opts: ParseOptions,
    readonly offset: number,
  ) {}

  err(code: string, msg: string): never {
    throw new ExprError(code, msg, this.offset + this.i);
  }
  ws(): void {
    while (this.i < this.s.length && (this.s[this.i] === ' ' || this.s[this.i] === '\t')) this.i++;
  }
  peek(n = 0): string {
    return this.s[this.i + n] ?? '';
  }
  pos(): number {
    return this.offset + this.i;
  }

  parse(): Expr {
    return this.or();
  }
  /** Enter one nesting level (parenthesis, function call, unary/force operator). */
  private enter(): void {
    if (++this.depth > MAX_EXPR_NESTING) this.tooComplex();
  }
  /** Count one AST node (bounds the evaluator's recursion on long operator chains). */
  private node(): void {
    if (++this.nodes > MAX_EXPR_NODES) this.tooComplex();
  }
  private tooComplex(): never {
    throw new ExprError('A9002', 'expression too complex', this.offset + this.i);
  }
  private bin(next: () => Expr, ops: string[]): Expr {
    let l = next();
    for (;;) {
      this.ws();
      const op = ops.find((o) => this.s.startsWith(o, this.i) && !this.isLongerOp(o));
      if (!op) return l;
      const p = this.pos();
      this.i += op.length;
      const r = next();
      this.node();
      l = { t: 'bin', op: normOp(op), l, r, pos: p };
    }
  }
  /** Avoid taking '<' when the text is '<<' or '<=' etc. (handled by longer ops listed first). */
  private isLongerOp(o: string): boolean {
    const n = this.s[this.i + o.length] ?? '';
    if (o === '<' && (n === '<' || n === '=' || n === '>')) return true;
    if (o === '>' && (n === '>' || n === '=')) return true;
    if (o === '=' && n === '=') return true;
    if (o === '&' && n === '&') return true;
    if (o === '|' && n === '|') return true;
    return false;
  }
  or(): Expr {
    return this.bin(() => this.xor(), ['|']);
  }
  xor(): Expr {
    return this.bin(() => this.and(), ['^']);
  }
  and(): Expr {
    return this.bin(() => this.eq(), ['&']);
  }
  eq(): Expr {
    return this.bin(() => this.rel(), ['==', '!=', '<>', '=']);
  }
  rel(): Expr {
    return this.bin(() => this.shift(), ['<=', '>=', '<', '>']);
  }
  shift(): Expr {
    return this.bin(() => this.add(), ['<<', '>>']);
  }
  add(): Expr {
    return this.bin(() => this.mul(), ['+', '-']);
  }
  mul(): Expr {
    return this.bin(() => this.unary(), ['*', '/', '%']);
  }
  unary(): Expr {
    this.ws();
    const c = this.peek();
    const p = this.pos();
    if (c === '-' || c === '+' || c === '~' || (c === '!' && this.peek(1) !== '=')) {
      this.i++;
      this.enter();
      this.node();
      const e = this.unary();
      this.depth--;
      return { t: 'un', op: c as '-' | '+' | '~' | '!', e, pos: p };
    }
    if (c === '<' || c === '>') {
      this.i++;
      this.enter();
      this.node();
      const e = this.unary();
      this.depth--;
      return { t: 'force', size: c === '<' ? 8 : 16, e, pos: p };
    }
    this.node();
    return this.primary();
  }
  primary(): Expr {
    this.ws();
    const c = this.peek();
    const p = this.pos();
    if (c === '(') {
      this.i++;
      this.enter();
      const e = this.parse();
      this.depth--;
      this.ws();
      if (this.peek() !== ')') this.err('A1052', 'Right parenthesis expected');
      this.i++;
      return e;
    }
    if (c === '*') {
      this.i++;
      return { t: 'pc', pos: p };
    }
    if (c === '$') return this.radix(16, /[0-9A-Fa-f]/);
    if (c === '%') return this.radix(2, /[01]/);
    if (c === '@') return this.radix(8, /[0-7]/);
    if (c === "'" || c === '"') {
      const q = c;
      let j = this.i + 1;
      while (j < this.s.length && this.s[j] !== q) j++;
      if (j >= this.s.length) this.err('A1055', 'Error in expression');
      const text = this.s.slice(this.i + 1, j);
      this.i = j + 1;
      let v = 0;
      for (const ch of text) v = ((v << 8) | (ch.charCodeAt(0) & 0xff)) | 0;
      return /[^\x00-\xff]/.test(text) ? { t: 'chr', v, text, pos: p, wide: true } : { t: 'chr', v, text, pos: p };
    }
    if (/[0-9]/.test(c)) {
      let j = this.i;
      while (j < this.s.length && /[0-9A-Za-z]/.test(this.s[j])) j++;
      const tok = this.s.slice(this.i, j);
      const n = parseDigitNumberEx(tok, this.opts.base);
      if (n === undefined) this.err('A1055', 'Error in expression');
      this.i = j;
      return n.ovf ? { t: 'num', v: n.v, pos: p, ovf: true } : { t: 'num', v: n.v, pos: p };
    }
    if (ID_START.test(c)) {
      let j = this.i;
      while (j < this.s.length && ID_CHAR.test(this.s[j])) j++;
      let name = this.s.slice(this.i, j);
      this.i = j;
      const up = name.toUpperCase();
      if (up === 'HIGH' || up === 'LOW' || up === 'PAGE') {
        this.ws();
        if (this.peek() === '(') {
          this.i++;
          this.enter();
          const e = this.parse();
          this.depth--;
          this.ws();
          if (this.peek() !== ')') this.err('A1052', 'Right parenthesis expected');
          this.i++;
          return { t: 'fn', fn: up, e, pos: p };
        }
      }
      // `label.B` / `label.W` force operators (manual "Force operator").
      const m = name.match(/^(.+)\.([BbWw])$/);
      if (m) {
        name = m[1];
        return { t: 'force', size: m[2].toUpperCase() === 'B' ? 8 : 16, e: { t: 'sym', name, pos: p }, pos: p };
      }
      return { t: 'sym', name, pos: p };
    }
    this.err('A1055', 'Error in expression');
  }
  radix(b: number, re: RegExp): Expr {
    const p = this.pos();
    this.i++;
    let j = this.i;
    while (j < this.s.length && re.test(this.s[j])) j++;
    if (j === this.i) this.err('A1055', 'Error in expression');
    const digits = this.s.slice(this.i, j);
    const v = parseBig(digits, b);
    this.i = j;
    return overflows32(digits, b) ? { t: 'num', v, pos: p, ovf: true } : { t: 'num', v, pos: p };
  }
}

function normOp(o: string): BinOp {
  if (o === '=') return '==';
  if (o === '<>') return '!=';
  return o as BinOp;
}

/**
 * Parse an expression from `text`. Returns the AST and the index just past it (the caller checks for trailing
 * garbage). `offset` is added to error positions (for column reporting). Throws ExprError.
 */
export function parseExpression(text: string, opts: ParseOptions, offset = 0): { expr: Expr; end: number } {
  const p = new Parser(text, opts, offset);
  const expr = p.parse();
  p.ws();
  return { expr, end: p.i };
}

/** Parse an expression that must consume all of `text` (trailing blanks allowed). */
export function parseFullExpression(text: string, opts: ParseOptions, offset = 0): Expr {
  const { expr, end } = parseExpression(text, opts, offset);
  if (end < text.length) throw new ExprError('A1055', 'Error in expression', offset + end);
  return expr;
}

/** Names referenced by an expression (in order of appearance). */
export function exprSymbols(e: Expr, out: string[] = []): string[] {
  switch (e.t) {
    case 'sym':
      out.push(e.name);
      break;
    case 'un':
    case 'fn':
    case 'force':
      exprSymbols(e.e, out);
      break;
    case 'bin':
      exprSymbols(e.l, out);
      exprSymbols(e.r, out);
      break;
    default:
      break;
  }
  return out;
}

/** True when the expression uses `*` (location counter). */
export function exprUsesPc(e: Expr): boolean {
  switch (e.t) {
    case 'pc':
      return true;
    case 'un':
    case 'fn':
    case 'force':
      return exprUsesPc(e.e);
    case 'bin':
      return exprUsesPc(e.l) || exprUsesPc(e.r);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Values

/** Opaque handles used by the evaluator (defined by the assembler). */
export interface SymHandle {
  readonly name: string;
}
export interface SecHandle {
  readonly name: string;
}

/**
 * Result of evaluating an expression.
 * - abs: an absolute number.
 * - rel: offset `v` in relocatable section `sec`; `sym` is the label it is based on (undefined for `*`).
 * - ext: external (XREF) symbol `sym` plus addend `v`.
 * - undef: refers to a symbol not (yet) defined — pass 1 forward reference, or an error in pass 2.
 */
export interface Value {
  kind: 'abs' | 'rel' | 'ext' | 'undef';
  v: number;
  sym?: SymHandle;
  sec?: SecHandle;
  /** HIGH/LOW/PAGE applied to a relocatable value (needs a special relocation). */
  fn?: 'HIGH' | 'LOW' | 'PAGE';
  /** Force-size operator applied (< / .B = 8, > / .W = 16). */
  force?: 8 | 16;
  /** Absolute value that is the address of a label in an absolute (ORG) section. */
  absLabel?: boolean;
  /** Absolute value obtained from an EQU/SET symbol. */
  equ?: boolean;
}

export interface EvalContext {
  /** Look up a symbol. Return undefined when not (yet) defined. */
  lookup(name: string, pos: number): Value | undefined;
  /** The location counter value (start of the current statement). */
  pc(): Value;
  /** Report a warning (A1051 zero division etc.). */
  warn(code: string, text: string, pos: number): void;
}

export const absV = (v: number): Value => ({ kind: 'abs', v: v | 0 });

function complex(pos: number): never {
  throw new ExprError('A2401', 'Complex relocatable expression not supported', pos);
}

/** Evaluate an expression. Throws ExprError for complex relocatable expressions. */
export function evaluate(e: Expr, ctx: EvalContext): Value {
  switch (e.t) {
    case 'num':
      // Manual: A1057 "Cutting constant because of overflow" - the constant is truncated to 32 bits.
      if (e.ovf) ctx.warn('A1057', 'Cutting constant because of overflow', e.pos);
      return absV(e.v);
    case 'chr':
      if (e.wide) ctx.warn('A9005', 'character constant', e.pos);
      return absV(e.v);
    case 'pc':
      return { ...ctx.pc() };
    case 'sym': {
      const v = ctx.lookup(e.name, e.pos);
      return v ? { ...v } : { kind: 'undef', v: 0 };
    }
    case 'force': {
      const v = evaluate(e.e, ctx);
      return { ...v, force: e.size };
    }
    case 'fn': {
      const v = evaluate(e.e, ctx);
      if (v.kind === 'undef') return { kind: 'undef', v: 0, fn: e.fn };
      if (v.kind === 'abs') {
        const x = e.fn === 'HIGH' ? (v.v >> 8) & 0xff : e.fn === 'LOW' ? v.v & 0xff : (v.v >> 16) & 0xff;
        return absV(x);
      }
      if (v.fn) complex(e.pos);
      return { ...v, fn: e.fn };
    }
    case 'un': {
      const v = evaluate(e.e, ctx);
      if (v.kind === 'undef') return { kind: 'undef', v: 0 };
      if (e.op === '+') return v;
      if (v.kind !== 'abs') complex(e.pos);
      const x = e.op === '-' ? -v.v : e.op === '~' ? ~v.v : v.v === 0 ? 1 : 0;
      return absV(x);
    }
    case 'bin': {
      const l = evaluate(e.l, ctx);
      const r = evaluate(e.r, ctx);
      if (l.kind === 'undef' || r.kind === 'undef') {
        // Keep the "kind" information when possible for pass-1 decisions.
        return { kind: 'undef', v: 0 };
      }
      if (l.fn || r.fn) {
        if (l.kind === 'abs' && !l.fn) {
          if (e.op === '+') return { ...r, v: (r.v + l.v) | 0 };
        }
        if (r.kind === 'abs' && !r.fn && (e.op === '+' || e.op === '-')) {
          return { ...l, v: (e.op === '+' ? l.v + r.v : l.v - r.v) | 0 };
        }
        complex(e.pos);
      }
      if (l.kind === 'abs' && r.kind === 'abs') {
        const v = binAbs(e.op, l.v, r.v, ctx, e.pos);
        return absV(v);
      }
      // relocatable / external arithmetic (Table 7.5)
      if (e.op === '+') {
        if (l.kind !== 'abs' && r.kind === 'abs') return { ...l, v: (l.v + r.v) | 0, force: l.force };
        if (l.kind === 'abs' && r.kind !== 'abs') return { ...r, v: (l.v + r.v) | 0, force: l.force ?? r.force };
        complex(e.pos);
      }
      if (e.op === '-') {
        if (l.kind !== 'abs' && r.kind === 'abs') return { ...l, v: (l.v - r.v) | 0 };
        if (l.kind === 'rel' && r.kind === 'rel' && l.sec === r.sec) return absV(l.v - r.v);
        if (l.kind === 'ext' && r.kind === 'ext' && l.sym === r.sym) return absV(l.v - r.v);
        complex(e.pos);
      }
      complex(e.pos);
    }
  }
}

function binAbs(op: BinOp, a: number, b: number, ctx: EvalContext, pos: number): number {
  switch (op) {
    case '*':
      return Math.imul(a, b);
    case '/':
      if (b === 0) {
        ctx.warn('A1051', 'Zero Division in expression', pos);
        return 0;
      }
      return (a / b) | 0;
    case '%':
      if (b === 0) {
        ctx.warn('A1051', 'Zero Division in expression', pos);
        return 0;
      }
      return a % b | 0;
    case '+':
      return (a + b) | 0;
    case '-':
      return (a - b) | 0;
    case '<<':
      return b >= 32 ? 0 : a << b;
    case '>>':
      return b >= 32 ? (a < 0 ? -1 : 0) : a >> b;
    case '<':
      return a < b ? 1 : 0;
    case '<=':
      return a <= b ? 1 : 0;
    case '>':
      return a > b ? 1 : 0;
    case '>=':
      return a >= b ? 1 : 0;
    case '==':
      return a === b ? 1 : 0;
    case '!=':
      return a !== b ? 1 : 0;
    case '&':
      return a & b;
    case '^':
      return a ^ b;
    case '|':
      return a | b;
  }
}
