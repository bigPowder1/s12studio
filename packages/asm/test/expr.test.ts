import { describe, expect, it } from 'vitest';
import { evaluate, ExprError, parseDigitNumber, parseFullExpression, type EvalContext, type Value } from '../src/index.js';
import { asmSource, hex, sectionBytes } from './helpers.js';

const ctx = (syms: Record<string, Value> = {}): EvalContext => ({
  lookup: (n) => syms[n],
  pc: () => ({ kind: 'abs', v: 0x1000 }),
  warn: () => {},
});
const ev = (s: string, base = 10, syms: Record<string, Value> = {}) => evaluate(parseFullExpression(s, { base }), ctx(syms));
const num = (s: string, base = 10) => ev(s, base).v;

describe('constants', () => {
  it('prefix forms', () => {
    expect(num('512')).toBe(512);
    expect(num('$1F')).toBe(0x1f);
    expect(num('@17')).toBe(15);
    expect(num('%1010')).toBe(10);
  });
  it('MASM suffix forms (manual Appendix C)', () => {
    expect(num('512d')).toBe(512);
    expect(num('200h')).toBe(0x200);
    expect(num('0FFh')).toBe(255);
    expect(num('17o')).toBe(15);
    expect(num('17Q')).toBe(15);
    expect(num('101b')).toBe(5);
  });
  it('BASE changes the default radix; 45D stays decimal in base 16', () => {
    expect(num('10', 16)).toBe(16);
    expect(num('0a', 16)).toBe(10);
    expect(num('45D', 16)).toBe(45);
    expect(num('100', 2)).toBe(4);
    expect(num('100', 8)).toBe(64);
    expect(parseDigitNumber('19', 8)).toBeUndefined();
  });
  it('character constants', () => {
    expect(num("'A'")).toBe(0x41);
    expect(num('"AB"')).toBe(0x4142);
    expect(num("'9'-'0'")).toBe(9);
  });
  it('the location counter', () => {
    expect(num('*')).toBe(0x1000);
    expect(num('*-2')).toBe(0xffe);
    expect(num('2**')).toBe(0x2000);
  });
});

describe('operators and precedence (ANSI C, manual Table 7.3)', () => {
  const cases: Array<[string, number]> = [
    ['2+3*4', 14],
    ['(2+3)*4', 20],
    ['10-4-3', 3],
    ['100/10/5', 2],
    ['23 * 4', 92],
    ['23 / 4', 5],
    ['23 % 4', 3],
    ['$25 << 2', 0x94],
    ['$A5 >> 3', 0x14],
    ['1+1<<2', 8],
    ['1<<2+1', 8],
    ['$E & 3', 2],
    ['$E | 3', 0xf],
    ['$E ^ 3', 0xd],
    ['1|2^3&4', 1 | (2 ^ (3 & 4))],
    ['~$C', ~0xc],
    ['-$32', -0x32],
    ['+$32', 0x32],
    ['!(8<5)', 1],
    ['!0', 1],
    ['!7', 0],
    ['3 >= 4', 0],
    ['9 < $B', 1],
    ['4 = 4', 1],
    ['4 == 5', 0],
    ['4 != 5', 1],
    ['4 <> 4', 0],
    ['1 < 2 == 1', 1],
    ['2 & 3 == 3', 2 & 1],
    ['- 2 * 3', -6],
    ['~0 & $FF', 0xff],
  ];
  for (const [e, v] of cases) it(e, () => expect(num(e)).toBe(v | 0));
  it('32-bit arithmetic', () => {
    expect(num('$FFFFFFFF + 1')).toBe(0);
    expect(num('$7FFFFFFF + 1')).toBe(-0x80000000);
  });
  it('HIGH / LOW / PAGE', () => {
    expect(num('HIGH($1234)')).toBe(0x12);
    expect(num('LOW($1234)')).toBe(0x34);
    expect(num('PAGE($28050)')).toBe(2);
    expect(num('high($ABCD)+1')).toBe(0xac);
  });
  it('zero division warns and yields 0', () => {
    const warns: string[] = [];
    const v = evaluate(parseFullExpression('5/0', { base: 10 }), { ...ctx(), warn: (c) => warns.push(c) });
    expect(v.v).toBe(0);
    expect(warns).toEqual(['A1051']);
  });
  it('parse errors', () => {
    expect(() => parseFullExpression('(1+2', { base: 10 })).toThrowError(ExprError);
    expect(() => parseFullExpression('1+', { base: 10 })).toThrowError(ExprError);
    expect(() => parseFullExpression('1 2', { base: 10 })).toThrowError(ExprError);
  });
});

describe('relocatable expressions (manual Tables 7.4/7.5)', () => {
  const sec = { name: 'S' };
  const sec2 = { name: 'T' };
  const a = { name: 'a' };
  const b = { name: 'b' };
  const c = { name: 'c' };
  const x = { name: 'x' };
  const syms: Record<string, Value> = {
    a: { kind: 'rel', v: 10, sym: a, sec },
    b: { kind: 'rel', v: 4, sym: b, sec },
    c: { kind: 'rel', v: 4, sym: c, sec: sec2 },
    x: { kind: 'ext', v: 0, sym: x },
  };
  it('reloc ± abs is relocatable', () => {
    expect(ev('a+2', 10, syms)).toMatchObject({ kind: 'rel', v: 12, sym: a });
    expect(ev('2+a', 10, syms)).toMatchObject({ kind: 'rel', v: 12, sym: a });
    expect(ev('a-2', 10, syms)).toMatchObject({ kind: 'rel', v: 8, sym: a });
    expect(ev('x+6', 10, syms)).toMatchObject({ kind: 'ext', v: 6, sym: x });
  });
  it('reloc - reloc in one section is absolute', () => {
    expect(ev('a-b', 10, syms)).toMatchObject({ kind: 'abs', v: 6 });
    expect(ev('a-b+c', 10, syms)).toMatchObject({ kind: 'rel', v: 10, sym: c });
  });
  it('complex expressions are rejected (A2401)', () => {
    for (const e of ['a+b', 'a-c', '-a', '~a', 'a*2', 'a<<1', 'a|1', 'x-a', 'HIGH(a)+b']) {
      expect(() => ev(e, 10, syms), e).toThrowError(/Complex/);
    }
  });
  it('HIGH/LOW/PAGE of a relocatable value is kept as a function of the value', () => {
    expect(ev('PAGE(a)', 10, syms)).toMatchObject({ kind: 'rel', fn: 'PAGE' });
  });
  it('force operators', () => {
    expect(ev('<a', 10, syms).force).toBe(8);
    expect(ev('>$12', 10, syms).force).toBe(16);
    expect(ev('a.B', 10, syms)).toMatchObject({ force: 8, sym: a });
    expect(ev('a.W', 10, syms)).toMatchObject({ force: 16, sym: a });
  });
});

describe('expressions in context', () => {
  it('DC values use the expression grammar', () => {
    const r = asmSource('        ORG $1000\n        DC.B 2+3*4, (2+3)*4, 1<<3|1, -1, 7%3, $1F, %101, @17, 101b, 0FFh\n        DC.W *, *-2, HIGH(*), LOW($1234)\n');
    expect(r.ok).toBe(true);
    expect(hex(sectionBytes(r, '_ORG00001'))).toBe('0E 14 09 FF 01 1F 05 0F 05 FF 10 0A 10 08 00 10 00 34');
  });
  it('BASE directive', () => {
    const r = asmSource(' ORG 0\n base 10\n dc.b 100\n base 16\n dc.b 0a\n base 2\n dc.b 100\n dc.b %1001111\n base @12\n dc.b 100\n base $a\n dc.b 100\n base 8\n dc.b 100\n');
    expect(r.messages).toEqual([]);
    expect(hex(sectionBytes(r, '_ORG00001'))).toBe('64 0A 04 4F 64 64 40');
  });
});
