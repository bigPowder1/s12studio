/** Arithmetic, logic, shifts, loads/stores and their exact CCR effects (CPU12RM / r1/isa.md §4). */
import { describe, expect, it } from 'vitest';
import { CCR, CODE, exec1, getW, putW } from './helpers';

const { C, V, Z, N, H, X, I, S } = CCR;
const flags = (ccr: number) => ccr & 0x2f; // H N Z V C

describe('loads and stores', () => {
  it('LDAA imm sets N/Z, clears V, keeps C', () => {
    expect(flags(exec1([0x86, 0x80], { ccr: V | C }).r.ccr)).toBe(N | C);
    expect(flags(exec1([0x86, 0x00]).r.ccr)).toBe(Z);
  });
  it('LDD/LDX/LDY/LDS ext and dir', () => {
    const r = exec1([0xfc, 0x21, 0x00], {}, (s) => putW(s, 0x2100, 0x8001)).r;
    expect(r.d).toBe(0x8001);
    expect(flags(r.ccr)).toBe(N);
    expect(exec1([0xfe, 0x21, 0x00], {}, (s) => putW(s, 0x2100, 0x1234)).r.x).toBe(0x1234);
    expect(exec1([0xfd, 0x21, 0x00], {}, (s) => putW(s, 0x2100, 0x1234)).r.y).toBe(0x1234);
    expect(exec1([0xff, 0x21, 0x00], {}, (s) => putW(s, 0x2100, 0x1234)).r.sp).toBe(0x1234);
    // direct page uses DIRECT:dd
    const d = exec1([0xdc, 0x00], {}, (s) => {
      s.poke(0x11, 0x21);
      putW(s, 0x2100, 0xbeef);
    });
    expect(d.r.d).toBe(0xbeef);
  });
  it('stores write memory and set flags (V cleared)', () => {
    const e = exec1([0x7a, 0x21, 0x00], { a: 0x00, ccr: V | C });
    expect(e.s.peek(0x2100)).toBe(0);
    expect(flags(e.r.ccr)).toBe(Z | C);
    const e2 = exec1([0x7c, 0x21, 0x00], { d: 0x8123 });
    expect(getW(e2.s, 0x2100)).toBe(0x8123);
    expect(flags(e2.r.ccr)).toBe(N);
    expect(getW(exec1([0x7e, 0x21, 0x00], { x: 0x55aa }).s, 0x2100)).toBe(0x55aa);
    expect(getW(exec1([0x7d, 0x21, 0x00], { y: 0x55aa }).s, 0x2100)).toBe(0x55aa);
    expect(getW(exec1([0x7f, 0x21, 0x00], { sp: 0x55aa }).s, 0x2100)).toBe(0x55aa);
    expect(exec1([0x5b, 0x40], { b: 0x77 }, (s) => s.poke(0x11, 0x21)).s.peek(0x2140)).toBe(0x77);
  });
});

describe('indexed addressing modes', () => {
  const ld = (xb: number[], regs: object, setup?: Parameters<typeof exec1>[2]) => exec1([0xa6, ...xb], regs, setup);
  const mem = (s: Parameters<NonNullable<Parameters<typeof exec1>[2]>>[0]) => {
    for (let i = 0; i < 0x40; i++) s.poke(0x2100 + i, i);
  };
  it('5-bit constant offsets (positive / negative) on X, Y, SP, PC', () => {
    expect(ld([0x05], { x: 0x2100 }, mem).r.a).toBe(5);
    expect(ld([0x1f], { x: 0x2110 }, mem).r.a).toBe(0x0f); // -1,X
    expect(ld([0x43], { y: 0x2100 }, mem).r.a).toBe(3); // 3,Y
    expect(ld([0x82], { sp: 0x2100 }, mem).r.a).toBe(2); // 2,SP
    // 1,PC: base = next instruction (CODE + 2)
    expect(ld([0xc1], {}, (s) => s.poke(CODE + 3, 0x99)).r.a).toBe(0x99);
  });
  it('auto pre/post increment/decrement', () => {
    let e = ld([0x30], { x: 0x2104 }, mem); // 1,X+
    expect([e.r.a, e.r.x]).toEqual([4, 0x2105]);
    e = ld([0x20], { x: 0x2104 }, mem); // 1,+X
    expect([e.r.a, e.r.x]).toEqual([5, 0x2105]);
    e = ld([0x3f], { x: 0x2104 }, mem); // 1,X-
    expect([e.r.a, e.r.x]).toEqual([4, 0x2103]);
    e = ld([0x2f], { x: 0x2104 }, mem); // 1,-X
    expect([e.r.a, e.r.x]).toEqual([3, 0x2103]);
    e = ld([0x77], { y: 0x2100 }, mem); // 8,Y+
    expect([e.r.a, e.r.y]).toEqual([0, 0x2108]);
    e = ld([0xb8], { sp: 0x2110 }, mem); // 8,SP- (post-decrement by 8)
    expect([e.r.a, e.r.sp]).toEqual([0x10, 0x2108]);
  });
  it('accumulator offsets (A/B unsigned, D 16-bit)', () => {
    expect(ld([0xe4], { x: 0x2100, a: 0x0a }, mem).r.a).toBe(0x0a); // A,X
    expect(ld([0xe5], { x: 0x2100, b: 0x0b }, mem).r.a).toBe(0x0b); // B,X
    expect(ld([0xe6], { x: 0x2000, d: 0x0107 }, mem).r.a).toBe(0x07); // D,X
    expect(ld([0xe5], { x: 0x2080, b: 0x82 }, mem).r.a).toBe(0x02); // B unsigned: $2080+$82
  });
  it('9-bit and 16-bit offsets', () => {
    expect(ld([0xe0, 0x20], { x: 0x2100 }, mem).r.a).toBe(0x20); // 32,X
    expect(ld([0xe1, 0xe0], { x: 0x2120 }, mem).r.a).toBe(0x00); // -32,X
    expect(ld([0xe9, 0xff], { y: 0x2121 }, mem).r.a).toBe(0x20); // -1,Y (9-bit form)
    expect(ld([0xe2, 0x01, 0x05], { x: 0x2000 }, mem).r.a).toBe(0x05); // $0105,X
    expect(ld([0xe2, 0xff, 0xff], { x: 0x2106 }, mem).r.a).toBe(0x05); // 16-bit wraps (-1)
  });
  it('indirect [n16,r] and [D,r]', () => {
    const setup = (s: Parameters<NonNullable<Parameters<typeof exec1>[2]>>[0]) => {
      mem(s);
      putW(s, 0x2200, 0x2107);
      putW(s, 0x2210, 0x2109);
    };
    expect(ld([0xe3, 0x02, 0x00], { x: 0x2000 }, setup).r.a).toBe(0x07); // [$0200,X]
    expect(ld([0xe7], { x: 0x2200, d: 0x0010 }, setup).r.a).toBe(0x09); // [D,X]
  });
});

describe('8-bit add/subtract flags (H, V, C edge cases)', () => {
  it('ADDA: $7F + 1 -> V, N, H', () => {
    const r = exec1([0x8b, 0x01], { a: 0x7f }).r;
    expect(r.a).toBe(0x80);
    expect(flags(r.ccr)).toBe(H | N | V);
  });
  it('ADDA: $FF + 1 -> C, Z, H', () => {
    const r = exec1([0x8b, 0x01], { a: 0xff }).r;
    expect(r.a).toBe(0);
    expect(flags(r.ccr)).toBe(H | Z | C);
  });
  it('ADDA: $80 + $80 -> V, C, Z (no H)', () => {
    expect(flags(exec1([0x8b, 0x80], { a: 0x80 }).r.ccr)).toBe(Z | V | C);
  });
  it('ADCA/ADCB add the carry; ADDB', () => {
    expect(exec1([0x89, 0x01], { a: 0x01, ccr: C }).r.a).toBe(3);
    expect(exec1([0xc9, 0x0f], { b: 0x00, ccr: C }).r.ccr & H).toBe(H);
    expect(exec1([0xcb, 0x10], { b: 0x05 }).r.b).toBe(0x15);
  });
  it('SUBA: $80 - 1 -> V; 0 - 1 -> C, N', () => {
    let r = exec1([0x80, 0x01], { a: 0x80 }).r;
    expect([r.a, flags(r.ccr)]).toEqual([0x7f, V]);
    r = exec1([0x80, 0x01], { a: 0x00 }).r;
    expect([r.a, flags(r.ccr)]).toEqual([0xff, N | C]);
  });
  it('SBCA / SBCB subtract the borrow; SUBB', () => {
    expect(exec1([0x82, 0x01], { a: 0x05, ccr: C }).r.a).toBe(3);
    expect(exec1([0xc2, 0x00], { b: 0x00, ccr: C }).r.b).toBe(0xff);
    expect(exec1([0xc0, 0x05], { b: 0x07 }).r.b).toBe(2);
  });
  it('CMPA / CMPB / CBA leave the accumulators unchanged', () => {
    const r = exec1([0x81, 0x10], { a: 0x10 }).r;
    expect([r.a, flags(r.ccr)]).toEqual([0x10, Z]);
    expect(flags(exec1([0xc1, 0x20], { b: 0x10 }).r.ccr)).toBe(N | C);
    expect(flags(exec1([0x18, 0x17], { a: 0x10, b: 0x10 }).r.ccr)).toBe(Z);
  });
  it('ABA (H/C) and SBA', () => {
    let r = exec1([0x18, 0x06], { a: 0x0f, b: 0x01 }).r;
    expect([r.a, flags(r.ccr)]).toEqual([0x10, H]);
    r = exec1([0x18, 0x16], { a: 0x10, b: 0x11 }).r;
    expect([r.a, flags(r.ccr)]).toEqual([0xff, N | C]);
  });
});

describe('16-bit arithmetic', () => {
  it('ADDD / SUBD with V and C', () => {
    let r = exec1([0xc3, 0x00, 0x01], { d: 0x7fff }).r;
    expect([r.d, flags(r.ccr)]).toEqual([0x8000, N | V]);
    r = exec1([0xc3, 0x00, 0x01], { d: 0xffff }).r;
    expect([r.d, flags(r.ccr)]).toEqual([0, Z | C]);
    r = exec1([0x83, 0x00, 0x01], { d: 0x8000 }).r;
    expect([r.d, flags(r.ccr)]).toEqual([0x7fff, V]);
  });
  it('CPD/CPX/CPY/CPS use the borrow formula', () => {
    expect(flags(exec1([0x8c, 0x12, 0x34], { d: 0x1234 }).r.ccr)).toBe(Z);
    expect(flags(exec1([0x8e, 0x80, 0x00], { x: 0x0001 }).r.ccr)).toBe(N | V | C);
    expect(flags(exec1([0x8d, 0x00, 0x01], { y: 0x0000 }).r.ccr)).toBe(N | C);
    expect(flags(exec1([0x8f, 0x00, 0x01], { sp: 0x0002 }).r.ccr)).toBe(0);
  });
});

describe('logic', () => {
  it('AND/OR/EOR/BIT on A and B (V cleared, C kept)', () => {
    expect(exec1([0x84, 0x0f], { a: 0x3c, ccr: C | V }).r).toMatchObject({ a: 0x0c, ccr: C });
    expect(exec1([0xc4, 0xf0], { b: 0x3c }).r.b).toBe(0x30);
    expect(exec1([0x8a, 0x80], { a: 0x01 }).r).toMatchObject({ a: 0x81, ccr: N });
    expect(exec1([0xca, 0x01], { b: 0x02 }).r.b).toBe(0x03);
    expect(exec1([0x88, 0xff], { a: 0xff }).r).toMatchObject({ a: 0, ccr: Z });
    expect(exec1([0xc8, 0x0f], { b: 0xff }).r.b).toBe(0xf0);
    expect(exec1([0x85, 0x80], { a: 0x7f }).r).toMatchObject({ a: 0x7f, ccr: Z });
    expect(exec1([0xc5, 0x80], { b: 0x80 }).r.ccr).toBe(N);
  });
  it('ANDCC clears; ORCC sets but never sets X; ANDCC can clear X', () => {
    expect(exec1([0x10, 0xfe], { ccr: 0xff }).r.ccr).toBe(0xfe);
    expect(exec1([0x14, 0xff], { ccr: 0x00 }).r.ccr).toBe(0xbf); // X stays 0
    expect(exec1([0x14, 0x40], { ccr: 0x40 }).r.ccr).toBe(0x40);
    expect(exec1([0x10, 0xbf], { ccr: 0xd0 }).r.ccr).toBe(0x90);
  });
});

describe('read-modify-write and shifts', () => {
  it('NEG: $80 stays $80 with V; C = result != 0', () => {
    expect(exec1([0x40], { a: 0x80 }).r).toMatchObject({ a: 0x80, ccr: N | V | C });
    expect(exec1([0x50], { b: 0x00 }).r).toMatchObject({ b: 0, ccr: Z });
    expect(exec1([0x40], { a: 0x01 }).r).toMatchObject({ a: 0xff, ccr: N | C });
  });
  it('COM: C=1, V=0', () => {
    expect(exec1([0x41], { a: 0x0f, ccr: V }).r).toMatchObject({ a: 0xf0, ccr: N | C });
  });
  it('INC/DEC: V on $7F->$80 / $80->$7F, C unchanged', () => {
    expect(exec1([0x42], { a: 0x7f, ccr: C }).r).toMatchObject({ a: 0x80, ccr: N | V | C });
    expect(exec1([0x53], { b: 0x80 }).r).toMatchObject({ b: 0x7f, ccr: V });
    expect(exec1([0x43], { a: 0x01 }).r).toMatchObject({ a: 0, ccr: Z });
  });
  it('LSR / ASR / ASL / ROL / ROR: C out, V = N ^ C', () => {
    expect(exec1([0x44], { a: 0x81 }).r).toMatchObject({ a: 0x40, ccr: C | V }); // LSRA
    expect(exec1([0x47], { a: 0x81 }).r).toMatchObject({ a: 0xc0, ccr: N | C }); // ASRA
    expect(exec1([0x48], { a: 0xc0 }).r).toMatchObject({ a: 0x80, ccr: N | C }); // ASLA
    expect(exec1([0x48], { a: 0x40 }).r).toMatchObject({ a: 0x80, ccr: N | V }); // ASLA overflow
    expect(exec1([0x45], { a: 0x80, ccr: C }).r).toMatchObject({ a: 0x01, ccr: C | V }); // ROLA
    expect(exec1([0x46], { a: 0x01, ccr: C }).r).toMatchObject({ a: 0x80, ccr: N | C }); // RORA: N=1,C=1 -> V=0
    expect(exec1([0x58], { b: 0x01 }).r.b).toBe(0x02); // ASLB
  });
  it('LSRD / ASLD', () => {
    expect(exec1([0x49], { d: 0x8001 }).r).toMatchObject({ d: 0x4000, ccr: C | V });
    expect(exec1([0x59], { d: 0x8001 }).r).toMatchObject({ d: 0x0002, ccr: C | V });
  });
  it('memory RMW (ext and idx), CLR, TST', () => {
    const e = exec1([0x72, 0x21, 0x00], {}, (s) => s.poke(0x2100, 0xff)); // INC ext
    expect([e.s.peek(0x2100), e.r.ccr]).toEqual([0, Z]);
    const e2 = exec1([0x60, 0x00], { x: 0x2100 }, (s) => s.poke(0x2100, 0x05)); // NEG 0,X
    expect(e2.s.peek(0x2100)).toBe(0xfb);
    const e3 = exec1([0x79, 0x21, 0x00], { ccr: N | V | C }, (s) => s.poke(0x2100, 0x55)); // CLR ext
    expect([e3.s.peek(0x2100), e3.r.ccr]).toEqual([0, Z]);
    expect(exec1([0x87], { a: 5, ccr: 0x0f }).r).toMatchObject({ a: 0, ccr: Z }); // CLRA
    expect(exec1([0xc7], { b: 5 }).r.b).toBe(0); // CLRB
    expect(exec1([0x97], { a: 0x80, ccr: V | C }).r.ccr).toBe(N); // TSTA
    expect(exec1([0xd7], { b: 0x00 }).r.ccr).toBe(Z); // TSTB
    expect(exec1([0xf7, 0x21, 0x00], {}, (s) => s.poke(0x2100, 0x80)).r.ccr).toBe(N); // TST ext
    expect(exec1([0xe7, 0x00], { x: 0x2100 }).r.ccr).toBe(Z); // TST 0,X
  });
  it('INX/DEX/INY/DEY affect only Z; LEAX/LEAY/LEAS no flags', () => {
    expect(exec1([0x08], { x: 0xffff, ccr: N | C }).r).toMatchObject({ x: 0, ccr: N | Z | C });
    expect(exec1([0x09], { x: 0x0001 }).r).toMatchObject({ x: 0, ccr: Z });
    expect(exec1([0x02], { y: 0x0001, ccr: Z }).r).toMatchObject({ y: 2, ccr: 0 });
    expect(exec1([0x03], { y: 0x0000 }).r.y).toBe(0xffff);
    expect(exec1([0x1a, 0xe5], { x: 0x1000, b: 0xff, ccr: 0x0f }).r).toMatchObject({ x: 0x10ff, ccr: 0x0f }); // ABX
    expect(exec1([0x19, 0xed], { y: 0x1000, b: 0x01 }).r.y).toBe(0x1001); // ABY
    expect(exec1([0x1b, 0x9f], { sp: 0x3f00 }).r.sp).toBe(0x3eff); // DES
    // LEAS 4,Y+ : SP = old Y, Y += 4 (CPU12RM LEAS)
    expect(exec1([0x1b, 0x73], { y: 0x2000 }).r).toMatchObject({ sp: 0x2000, y: 0x2004 });
  });
  it('TAB / TBA (N Z, V=0) and NOP', () => {
    expect(exec1([0x18, 0x0e], { a: 0x80, ccr: V }).r).toMatchObject({ b: 0x80, ccr: N });
    expect(exec1([0x18, 0x0f], { b: 0x00 }).r).toMatchObject({ a: 0, ccr: Z });
    expect(exec1([0xa7], { ccr: 0xc5 }).r).toMatchObject({ pc: CODE + 1, ccr: 0xc5 });
  });
});

describe('S12X 16-bit X/Y/D arithmetic', () => {
  it('ADDX / ADDY / SUBX / SUBY', () => {
    expect(exec1([0x18, 0x8b, 0x00, 0x01], { x: 0x7fff }).r).toMatchObject({ x: 0x8000, ccr: N | V });
    expect(exec1([0x18, 0xcb, 0x00, 0x01], { y: 0xffff }).r).toMatchObject({ y: 0, ccr: Z | C });
    expect(exec1([0x18, 0x80, 0x00, 0x02], { x: 0x0001 }).r).toMatchObject({ x: 0xffff, ccr: N | C });
    expect(exec1([0x18, 0xc0, 0x00, 0x01], { y: 0x8000 }).r).toMatchObject({ y: 0x7fff, ccr: V });
  });
  it('ADED / ADEX / ADEY add with carry', () => {
    expect(exec1([0x18, 0xc3, 0x00, 0x01], { d: 0x0001, ccr: C }).r.d).toBe(3);
    expect(exec1([0x18, 0x89, 0xff, 0xff], { x: 0x0001, ccr: C }).r).toMatchObject({ x: 1, ccr: C });
    expect(exec1([0x18, 0xc9, 0x00, 0x00], { y: 0x7fff, ccr: C }).r).toMatchObject({ y: 0x8000, ccr: N | V });
  });
  it('SBED / SBEX / SBEY / CPED / CPES / CPEX / CPEY subtract with borrow and chain Z', () => {
    expect(exec1([0x18, 0x83, 0x00, 0x01], { d: 0x0003, ccr: C }).r.d).toBe(1);
    expect(exec1([0x18, 0x82, 0x00, 0x00], { x: 0x0000, ccr: C }).r).toMatchObject({ x: 0xffff, ccr: N | C });
    expect(exec1([0x18, 0xc2, 0x00, 0x01], { y: 0x0002 }).r.y).toBe(1);
    // Multi-precision compare: Z stays set only if the low word compared equal (Z was 1) too.
    expect(exec1([0x18, 0x8c, 0x12, 0x34], { d: 0x1234, ccr: Z }).r.ccr).toBe(Z);
    expect(exec1([0x18, 0x8c, 0x12, 0x34], { d: 0x1234, ccr: 0 }).r.ccr).toBe(0);
    expect(exec1([0x18, 0x8e, 0x00, 0x01], { x: 0x0001, ccr: C | Z }).r.ccr).toBe(N | C); // CPEX: 1-1-1
    expect(exec1([0x18, 0x8d, 0x00, 0x05], { y: 0x0005, ccr: Z }).r.ccr).toBe(Z); // CPEY
    expect(exec1([0x18, 0x8f, 0x00, 0x05], { sp: 0x0006 }).r.ccr).toBe(0); // CPES
  });
  it('ANDX/ANDY/ORX/ORY/EORX/EORY/BITX/BITY', () => {
    expect(exec1([0x18, 0x84, 0x0f, 0xf0], { x: 0xffff, ccr: V }).r).toMatchObject({ x: 0x0ff0, ccr: 0 });
    expect(exec1([0x18, 0xc4, 0x00, 0x00], { y: 0xffff }).r).toMatchObject({ y: 0, ccr: Z });
    expect(exec1([0x18, 0x8a, 0x80, 0x00], { x: 0x0001 }).r).toMatchObject({ x: 0x8001, ccr: N });
    expect(exec1([0x18, 0xca, 0x00, 0x10], { y: 0x0001 }).r.y).toBe(0x0011);
    expect(exec1([0x18, 0x88, 0xff, 0xff], { x: 0x00ff }).r.x).toBe(0xff00);
    expect(exec1([0x18, 0xc8, 0x00, 0xff], { y: 0x00ff }).r).toMatchObject({ y: 0, ccr: Z });
    expect(exec1([0x18, 0x85, 0x80, 0x00], { x: 0x8001 }).r).toMatchObject({ x: 0x8001, ccr: N });
    expect(exec1([0x18, 0xc5, 0x00, 0x01], { y: 0x8000 }).r.ccr).toBe(Z);
  });
  it('X/Y operands in DIR/IDX/EXT', () => {
    expect(exec1([0x18, 0xbb, 0x21, 0x00], { x: 1 }, (s) => putW(s, 0x2100, 0x0100)).r.x).toBe(0x101); // ADDX ext
    expect(exec1([0x18, 0xeb, 0x00], { x: 0x2100, y: 2 }, (s) => putW(s, 0x2100, 0x0100)).r.y).toBe(0x102); // ADDY 0,X
    expect(exec1([0x18, 0x9b, 0x00], { x: 3 }, (s) => {
      s.poke(0x11, 0x21);
      putW(s, 0x2100, 0x0100);
    }).r.x).toBe(0x103); // ADDX dir
  });
  it('NEGW..ASLW (ext/idx), NEGX..ASLX, NEGY..ASLY, CLRW/CLRX/CLRY, TSTW/TSTX/TSTY', () => {
    const w = (op: number, v: number, ccr = 0) => {
      const e = exec1([0x18, op, 0x21, 0x00], { ccr }, (s) => putW(s, 0x2100, v));
      return [getW(e.s, 0x2100), e.r.ccr & 0x0f];
    };
    expect(w(0x70, 0x8000)).toEqual([0x8000, N | V | C]); // NEGW
    expect(w(0x71, 0x00ff)).toEqual([0xff00, N | C]); // COMW
    expect(w(0x72, 0x7fff, C)).toEqual([0x8000, N | V | C]); // INCW (C kept)
    expect(w(0x73, 0x8000)).toEqual([0x7fff, V]); // DECW
    expect(w(0x74, 0x0001)).toEqual([0x0000, Z | V | C]); // LSRW
    expect(w(0x75, 0x8000, C)).toEqual([0x0001, V | C]); // ROLW
    expect(w(0x76, 0x0001)).toEqual([0x0000, Z | V | C]); // RORW
    expect(w(0x77, 0x8001)).toEqual([0xc000, N | C]); // ASRW
    expect(w(0x78, 0x4000)).toEqual([0x8000, N | V]); // ASLW
    expect(w(0x79, 0x1234, N | C)).toEqual([0, Z]); // CLRW
    expect(w(0xf7, 0x8000, V | C)).toEqual([0x8000, N]); // TSTW ext
    const idx = exec1([0x18, 0x62, 0x02], { x: 0x2100 }, (s) => putW(s, 0x2102, 0x00ff)); // INCW 2,X
    expect(getW(idx.s, 0x2102)).toBe(0x0100);
    expect(exec1([0x18, 0x69, 0x00], { x: 0x2100 }, (s) => putW(s, 0x2100, 5)).s.peek(0x2101)).toBe(0); // CLRW 0,X
    expect(exec1([0x18, 0xe7, 0x00], { x: 0x2100 }).r.ccr).toBe(Z); // TSTW 0,X
    expect(exec1([0x18, 0x40], { x: 0x0001 }).r.x).toBe(0xffff); // NEGX
    expect(exec1([0x18, 0x41], { x: 0x0000 }).r.x).toBe(0xffff); // COMX
    expect(exec1([0x18, 0x42], { x: 0xffff }).r).toMatchObject({ x: 0, ccr: Z }); // INCX
    expect(exec1([0x18, 0x43], { x: 0x0000 }).r.x).toBe(0xffff); // DECX
    expect(exec1([0x18, 0x44], { x: 0x0002 }).r.x).toBe(1); // LSRX
    expect(exec1([0x18, 0x45], { x: 0x0001, ccr: C }).r.x).toBe(3); // ROLX
    expect(exec1([0x18, 0x46], { x: 0x0002, ccr: C }).r.x).toBe(0x8001); // RORX
    expect(exec1([0x18, 0x47], { x: 0x8000 }).r.x).toBe(0xc000); // ASRX
    expect(exec1([0x18, 0x48], { x: 0x0001 }).r.x).toBe(2); // ASLX
    expect(exec1([0x18, 0x50], { y: 0x0002 }).r.y).toBe(0xfffe); // NEGY
    expect(exec1([0x18, 0x51], { y: 0xffff }).r.y).toBe(0); // COMY
    expect(exec1([0x18, 0x52], { y: 1 }).r.y).toBe(2); // INCY
    expect(exec1([0x18, 0x53], { y: 1 }).r).toMatchObject({ y: 0, ccr: Z }); // DECY
    expect(exec1([0x18, 0x54], { y: 0x8000 }).r.y).toBe(0x4000); // LSRY
    expect(exec1([0x18, 0x55], { y: 0x8000 }).r).toMatchObject({ y: 0, ccr: Z | V | C }); // ROLY
    expect(exec1([0x18, 0x56], { y: 0x0001 }).r.y).toBe(0); // RORY
    expect(exec1([0x18, 0x57], { y: 0x0004 }).r.y).toBe(2); // ASRY
    expect(exec1([0x18, 0x58], { y: 0x8000 }).r.y).toBe(0); // ASLY
    expect(exec1([0x18, 0x87], { x: 5, ccr: 0x0f }).r).toMatchObject({ x: 0, ccr: Z }); // CLRX
    expect(exec1([0x18, 0xc7], { y: 5 }).r.y).toBe(0); // CLRY
    expect(exec1([0x18, 0x97], { x: 0x8000, ccr: C }).r.ccr).toBe(N); // TSTX
    expect(exec1([0x18, 0xd7], { y: 0 }).r.ccr).toBe(Z); // TSTY
  });
});

describe('multiply / divide', () => {
  it('MUL: D = A*B, C = bit 7 of B', () => {
    expect(exec1([0x12], { a: 0x10, b: 0x18 }).r).toMatchObject({ d: 0x0180, ccr: C });
    expect(exec1([0x12], { a: 0xff, b: 0xff }).r).toMatchObject({ d: 0xfe01, ccr: 0 });
  });
  it('EMUL / EMULS: Y:D = D * Y', () => {
    let r = exec1([0x13], { d: 0xffff, y: 0xffff }).r;
    expect([r.y, r.d, r.ccr]).toEqual([0xfffe, 0x0001, N]);
    r = exec1([0x13], { d: 0x0100, y: 0x0080 }).r;
    expect([r.y, r.d, r.ccr]).toEqual([0x0000, 0x8000, C]);
    r = exec1([0x18, 0x13], { d: 0xffff, y: 0x0002 }).r; // -1 * 2
    expect([r.y, r.d, r.ccr]).toEqual([0xffff, 0xfffe, N | C]);
    r = exec1([0x18, 0x13], { d: 0x0000, y: 0x1234 }).r;
    expect([r.y, r.d, r.ccr]).toEqual([0, 0, Z]);
  });
  it('EDIV: unsigned 32/16, overflow and divide by zero', () => {
    let r = exec1([0x11], { y: 0x0001, d: 0x0003, x: 0x0002 }).r; // 0x10003 / 2
    expect([r.y, r.d, r.ccr & 0x0f]).toEqual([0x8001, 0x0001, N]);
    r = exec1([0x11], { y: 0x0002, d: 0x0000, x: 0x0002 }).r; // quotient 0x10000 overflows
    expect([r.y, r.d, r.ccr & (V | C)]).toEqual([0x0002, 0x0000, V]);
    r = exec1([0x11], { y: 0x1234, d: 0x5678, x: 0 }).r;
    expect([r.y, r.d, r.ccr & C]).toEqual([0x1234, 0x5678, C]);
  });
  it('EDIVS: signed, overflow and divide by zero', () => {
    let r = exec1([0x18, 0x14], { y: 0xffff, d: 0xfff9, x: 0x0002 }).r; // -7 / 2 = -3 r -1
    expect([r.y, r.d, r.ccr & 0x0f]).toEqual([0xfffd, 0xffff, N]);
    r = exec1([0x18, 0x14], { y: 0x0001, d: 0x0000, x: 0x0001 }).r; // 65536 overflows
    expect(r.ccr & (V | C)).toBe(V);
    r = exec1([0x18, 0x14], { y: 0, d: 5, x: 0 }).r;
    expect([r.y, r.d, r.ccr & C]).toEqual([0, 5, C]);
  });
  it('IDIV: D/X -> X, remainder D; divide by zero -> X=$FFFF, C=1', () => {
    let r = exec1([0x18, 0x10], { d: 100, x: 7 }).r;
    expect([r.x, r.d, r.ccr & 0x07]).toEqual([14, 2, 0]);
    r = exec1([0x18, 0x10], { d: 5, x: 7 }).r;
    expect([r.x, r.ccr & Z]).toEqual([0, Z]);
    r = exec1([0x18, 0x10], { d: 100, x: 0 }).r;
    expect([r.x, r.d, r.ccr & 0x07]).toEqual([0xffff, 100, C]);
  });
  it('IDIVS: signed; $8000/$FFFF overflow; divide by zero leaves registers', () => {
    let r = exec1([0x18, 0x15], { d: 0xff9c, x: 7 }).r; // -100 / 7 = -14 r -2
    expect([r.x, r.d, r.ccr & 0x0f]).toEqual([0xfff2, 0xfffe, N]);
    r = exec1([0x18, 0x15], { d: 0x8000, x: 0xffff }).r;
    expect(r.ccr & V).toBe(V);
    r = exec1([0x18, 0x15], { d: 0x1234, x: 0 }).r;
    expect([r.x, r.d, r.ccr & C]).toEqual([0, 0x1234, C]);
  });
  it('FDIV: (D*65536)/X; overflow when X <= D; divide by zero', () => {
    let r = exec1([0x18, 0x11], { d: 0x0001, x: 0x0003 }).r; // 65536/3 = 21845 r 1
    expect([r.x, r.d, r.ccr & 0x07]).toEqual([0x5555, 0x0001, 0]);
    r = exec1([0x18, 0x11], { d: 0x0005, x: 0x0005 }).r;
    expect([r.x, r.ccr & 0x07]).toEqual([0xffff, V]);
    r = exec1([0x18, 0x11], { d: 0x0005, x: 0 }).r;
    expect([r.x, r.ccr & 0x07]).toEqual([0xffff, V | C]);
  });
  it('EMACS: signed (X)*(Y) accumulated into a 32-bit memory word', () => {
    const e = exec1([0x18, 0x12, 0x21, 0x40], { x: 0x2100, y: 0x2102 }, (s) => {
      putW(s, 0x2100, 0xfffe); // -2
      putW(s, 0x2102, 0x0003); // 3
      putW(s, 0x2140, 0x0000);
      putW(s, 0x2142, 0x0010); // 16
    });
    expect([getW(e.s, 0x2140), getW(e.s, 0x2142)]).toEqual([0x0000, 0x000a]); // 16 - 6 = 10
    expect(e.r.ccr & 0x0f).toBe(C); // carry out of bit 15 of the add ($0010 + $FFFA)
    expect(e.r.x).toBe(0x2100);
    const o = exec1([0x18, 0x12, 0x21, 0x40], { x: 0x2100, y: 0x2100 }, (s) => {
      putW(s, 0x2100, 0x8000); // (-32768)^2 = 2^30
      putW(s, 0x2140, 0x7fff);
      putW(s, 0x2142, 0xffff);
    });
    expect(o.r.ccr & (N | V)).toBe(N | V);
  });
});

describe('DAA', () => {
  it('BCD add corrections', () => {
    const daa = (a: number, m: number) => {
      const e = exec1([0x8b, m, 0x18, 0x07], { a });
      e.s.step();
      return [e.s.registers.a, e.s.registers.ccr & C];
    };
    expect(daa(0x19, 0x28)).toEqual([0x47, 0]);
    expect(daa(0x99, 0x01)).toEqual([0x00, 1]);
    expect(daa(0x45, 0x45)).toEqual([0x90, 0]);
    expect(daa(0x50, 0x60)).toEqual([0x10, 1]);
    expect(daa(0x09, 0x09)).toEqual([0x18, 0]); // H set
  });
});

describe('min / max', () => {
  const setup = (v: number, w = false) => (s: Parameters<NonNullable<Parameters<typeof exec1>[2]>>[0]) =>
    w ? putW(s, 0x2100, v) : s.poke(0x2100, v);
  it('MAXA / MINA', () => {
    expect(exec1([0x18, 0x18, 0x00], { a: 0x10, x: 0x2100 }, setup(0x20)).r.a).toBe(0x20);
    expect(exec1([0x18, 0x18, 0x00], { a: 0x30, x: 0x2100 }, setup(0x20)).r.a).toBe(0x30);
    expect(exec1([0x18, 0x19, 0x00], { a: 0x10, x: 0x2100 }, setup(0x20)).r.a).toBe(0x10);
    const r = exec1([0x18, 0x19, 0x00], { a: 0x30, x: 0x2100 }, setup(0x20)).r;
    expect([r.a, r.ccr & 0x0f]).toEqual([0x20, 0]); // flags from A - M ($30 - $20)
  });
  it('MAXM / MINM', () => {
    expect(exec1([0x18, 0x1c, 0x00], { a: 0x30, x: 0x2100 }, setup(0x20)).s.peek(0x2100)).toBe(0x30);
    expect(exec1([0x18, 0x1c, 0x00], { a: 0x10, x: 0x2100 }, setup(0x20)).s.peek(0x2100)).toBe(0x20);
    expect(exec1([0x18, 0x1d, 0x00], { a: 0x10, x: 0x2100 }, setup(0x20)).s.peek(0x2100)).toBe(0x10);
    expect(exec1([0x18, 0x1d, 0x00], { a: 0x30, x: 0x2100 }, setup(0x20)).s.peek(0x2100)).toBe(0x20);
  });
  it('EMAXD / EMIND / EMAXM / EMINM', () => {
    expect(exec1([0x18, 0x1a, 0x00], { d: 0x1000, x: 0x2100 }, setup(0x2000, true)).r.d).toBe(0x2000);
    expect(exec1([0x18, 0x1b, 0x00], { d: 0x1000, x: 0x2100 }, setup(0x2000, true)).r.d).toBe(0x1000);
    expect(getW(exec1([0x18, 0x1e, 0x00], { d: 0x3000, x: 0x2100 }, setup(0x2000, true)).s, 0x2100)).toBe(0x3000);
    expect(getW(exec1([0x18, 0x1f, 0x00], { d: 0x1000, x: 0x2100 }, setup(0x2000, true)).s, 0x2100)).toBe(0x1000);
    expect(exec1([0x18, 0x1a, 0x00], { d: 0x1000, x: 0x2100 }, setup(0x2000, true)).r.ccr & 0x0f).toBe(N | C);
  });
});

describe('table lookup and interpolate', () => {
  it('TBL: A = Y1 + B*(Y2-Y1), C = fraction MSB', () => {
    const t = (y1: number, y2: number, b: number) => {
      const e = exec1([0x18, 0x3d, 0x00], { x: 0x2100, b }, (s) => {
        s.poke(0x2100, y1);
        s.poke(0x2101, y2);
      });
      return [e.r.a, e.r.ccr & (N | Z | C)];
    };
    expect(t(0x10, 0x20, 0x80)).toEqual([0x18, 0]); // halfway
    expect(t(0x10, 0x20, 0x00)).toEqual([0x10, 0]);
    expect(t(0x00, 0x03, 0x80)).toEqual([0x01, C]); // 1.5 -> 1, can round up
    expect(t(0x20, 0x10, 0x40)).toEqual([0x1c, 0]); // negative slope: 32 - 4
    expect(t(0x03, 0x00, 0x80)).toEqual([0x01, C]); // 3 - 1.5 = 1.5
    expect(t(0x80, 0xff, 0xff)).toEqual([0xfe, N | C]);
  });
  it('ETBL: 16-bit entries', () => {
    const e = exec1([0x18, 0x3f, 0x00], { x: 0x2100, b: 0x40 }, (s) => {
      putW(s, 0x2100, 0x1000);
      putW(s, 0x2102, 0x2000);
    });
    expect(e.r.d).toBe(0x1400);
    const n = exec1([0x18, 0x3f, 0x00], { x: 0x2100, b: 0x80 }, (s) => {
      putW(s, 0x2100, 0x8000);
      putW(s, 0x2102, 0x0000);
    });
    expect(n.r.d).toBe(0x4000);
  });
});

describe('CCR helpers', () => {
  it('flag constants', () => {
    expect([C, V, Z, N, I, H, X, S]).toEqual([1, 2, 4, 8, 16, 32, 64, 128]);
  });
});
