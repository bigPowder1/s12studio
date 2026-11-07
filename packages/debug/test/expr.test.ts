import { describe, expect, it } from 'vitest';
import { evaluateAsync, evaluateSync, ExprError, parseExpr, type IdentValue, type SyncExprEnv } from '@s12/debug';

const mem = new Map<number, number>([
  [0x2400, 0x12],
  [0x2401, 0x34],
  [0x2402, 0x56],
  [0x2403, 0x78],
  [0x3000, 0xff],
]);
const regs: Record<string, number> = { A: 0x11, B: 0x22, D: 0x1122, X: 0x2400, Y: 0, SP: 0x23fe, PC: 0x4000, CCR: 0xd0, IPL: 0, CCRW: 0xd0, PPAGE: 0xfe, RPAGE: 0xfd, EPAGE: 0xfe, GPAGE: 0, DIRECT: 0 };
const idents: Record<string, IdentValue> = {
  main: { kind: 'label', address: 0x4000 },
  mode1: { kind: 'var', address: 0x2400, size: 1 },
  COUNT_A: { kind: 'var', address: 0x2400, size: 2 },
  BUFFER: { kind: 'var', address: 0x2400, size: 1, array: true },
  sb: { kind: 'var', address: 0x3000, size: 1, signed: true },
  N: { kind: 'const', value: 7 },
  'main.dbg:t2': { kind: 'var', address: 0x2401, size: 1 },
};
const env: SyncExprEnv = {
  lookup: (n) => idents[n] ?? (regs[n.toUpperCase()] !== undefined ? { kind: 'register', name: n.toUpperCase() as 'A' } : undefined),
  readMemory: (a, size) => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + (mem.get(a + i) ?? 0);
    return v;
  },
  readRegister: (n) => regs[n],
};
const ev = (s: string, o = {}) => evaluateSync(s, env, o);

describe('expression evaluator', () => {
  it('number formats', () => {
    expect(ev('$FF')).toBe(255);
    expect(ev('0xff')).toBe(255);
    expect(ev('0377')).toBe(255);
    expect(ev('%1010')).toBe(10);
    expect(ev('255')).toBe(255);
    expect(ev("'A'")).toBe(65);
    expect(ev("'\\n'")).toBe(10);
    expect(ev('0')).toBe(0);
    expect(ev('08')).toBe(8);
  });
  it('C precedence and operators', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('10 - 2 - 3')).toBe(5);
    expect(ev('7 / 2')).toBe(3);
    expect(ev('-7 / 2')).toBe(-3);
    expect(ev('7 % 3')).toBe(1);
    expect(ev('1 << 4 | 1')).toBe(17);
    expect(ev('0xF0 >> 4')).toBe(15);
    expect(ev('0xF0 & 0x3C ^ 0x01')).toBe(0x31);
    expect(ev('~0 & 0xFF')).toBe(255);
    expect(ev('!0 && 2 > 1 || 0')).toBe(1);
    expect(ev('3 == 3 && 2 != 2')).toBe(0);
    expect(ev('5 >= 5 && 4 <= 3')).toBe(0);
    expect(ev('6 % %10')).toBe(0); // modulo followed by binary literal
  });
  it('symbols: labels are addresses, data objects read memory, &sym is the address', () => {
    expect(ev('main')).toBe(0x4000);
    expect(ev('&main + 3')).toBe(0x4003);
    expect(ev('mode1')).toBe(0x12);
    expect(ev('&mode1')).toBe(0x2400);
    expect(ev('COUNT_A')).toBe(0x1234);
    expect(ev('BUFFER')).toBe(0x2400); // arrays decay to their address
    expect(ev('sb')).toBe(-1);
    expect(ev('N * 2')).toBe(14);
    expect(ev('main.dbg:t2')).toBe(0x34);
    expect(ev('mode1', { addressContext: true })).toBe(0x2400);
    expect(ev('mode1 + 1')).toBe(0x13);
  });
  it('address context: data names are addresses through arithmetic, values under memory access/cast/compare', () => {
    const a = { addressContext: true };
    expect(ev('mode1 + 1', a)).toBe(0x2401); // review finding 1: was the value 0x12 + 1
    expect(ev('(mode1 + 4) - 1', a)).toBe(0x2403);
    expect(ev('COUNT_A + 2 * 2', a)).toBe(0x2404);
    expect(ev('mode1 | 0x8000', a)).toBe(0xa400);
    expect(ev('-(-mode1)', a)).toBe(0x2400);
    expect(ev('main + 3', a)).toBe(0x4003);
    expect(ev('N + mode1', a)).toBe(0x2407); // DEFINE constants stay values
    // memory access, casts, comparisons and logical operators read the value again
    expect(ev('[mode1]', a)).toBe(0); // byte at address 0x12 (the value), not at 0x2400
    expect(ev('*(byte*)mode1', a)).toBe(0);
    expect(ev('(word)mode1', a)).toBe(0x12);
    expect(ev('mode1 == 0x12', a)).toBe(1);
    expect(ev('~mode1 & 0xFF', a)).toBe(0xed);
    expect(ev('&mode1 + 1', a)).toBe(0x2401);
  });
  it('registers and $REG references', () => {
    expect(ev('PC')).toBe(0x4000);
    expect(ev('sp + 2')).toBe(0x2400);
    expect(ev('$PC')).toBe(0x4000);
    expect(ev('$A')).toBe(10); // hex number by default
    expect(ev('$A', { dollarRegisters: true })).toBe(0x11);
    expect(ev('$D == 0x1122', { dollarRegisters: true })).toBe(1);
  });
  it('memory access forms', () => {
    expect(ev('[0x2400]')).toBe(0x12);
    expect(ev('[0x2400, 2]')).toBe(0x1234);
    expect(ev('[X + 1]')).toBe(0x34);
    expect(ev('*(word*)0x2400')).toBe(0x1234);
    expect(ev('*(long *)0x2400')).toBe(0x12345678);
    expect(ev('*(unsigned char*)0x2402')).toBe(0x56);
    expect(ev('*(signed char*)0x3000')).toBe(-1);
    expect(ev('*0x2401')).toBe(0x34);
    expect(ev('&*(word*)0x2400')).toBe(0x2400);
    expect(ev('(byte)0x1234')).toBe(0x34);
    expect(ev('(char)0xFF')).toBe(-1);
  });
  it('stops at the first token that cannot continue (command arguments)', () => {
    const src = 'bs &main t';
    const r = parseExpr(src, 3);
    expect(src.slice(r.end)).toBe(' t');
    expect(parseExpr('0x4000..0x400F', 0).end).toBe(6);
    expect(parseExpr('0x100 CLKDIV', 0).end).toBe(5);
    expect(parseExpr('0x4000,5', 0).end).toBe(6);
    expect(parseExpr('&fibo.c:main+21 P E', 0).end).toBe(15);
  });
  it('errors', () => {
    expect(() => ev('nosuch')).toThrow(/Undefined symbol: nosuch/);
    expect(() => ev('1 +')).toThrow(ExprError);
    expect(() => ev('1 / 0')).toThrow(/Division by zero/);
    expect(() => ev('1 2')).toThrow(/unexpected/);
    expect(() => ev('&N')).toThrow(/address/);
  });
  it('async evaluation matches sync', async () => {
    const aenv = { ...env, readMemory: async (a: number, s: number) => env.readMemory(a, s), readRegister: async (n: 'A') => regs[n] };
    expect(await evaluateAsync('mode1 + *(word*)0x2402 + $B', aenv, { dollarRegisters: true })).toBe(0x12 + 0x5678 + 0x22);
  });
});
