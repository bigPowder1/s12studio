/** Branches, jumps, calls, stack, loop primitives, transfers, moves, bit ops, G-instructions, fuzzy. */
import { describe, expect, it } from 'vitest';
import { encodeLoop, encodeTfrExg } from '@s12/isa';
import { CCR, CODE, STACK, exec1, getW, mk, put, putW } from './helpers';

const { C, V, Z, N, I, X } = CCR;

describe('conditional branches (all 16 conditions)', () => {
  const taken = (op: number, ccr: number) => exec1([op, 0x10], { ccr }).r.pc === CODE + 0x12;
  it.each([
    [0x20, 0, true],
    [0x21, 0xff, false],
    [0x22, 0, true], // BHI
    [0x22, C, false],
    [0x23, Z, true], // BLS
    [0x23, 0, false],
    [0x24, 0, true], // BCC
    [0x25, C, true], // BCS
    [0x26, 0, true], // BNE
    [0x27, Z, true], // BEQ
    [0x28, 0, true], // BVC
    [0x29, V, true], // BVS
    [0x2a, 0, true], // BPL
    [0x2b, N, true], // BMI
    [0x2c, N | V, true], // BGE
    [0x2c, N, false],
    [0x2d, V, true], // BLT
    [0x2d, N | V, false],
    [0x2e, 0, true], // BGT
    [0x2e, Z, false],
    [0x2f, Z, true], // BLE
    [0x2f, N, true],
    [0x2f, 0, false],
  ])('op %s ccr %s taken=%s', (op, ccr, t) => {
    expect(taken(op, ccr)).toBe(t);
  });
  it('backward branch and long branch', () => {
    expect(exec1([0x20, 0xfe]).r.pc).toBe(CODE); // BRA *
    expect(exec1([0x18, 0x20, 0xff, 0xfc]).r.pc).toBe(CODE); // LBRA *
    expect(exec1([0x18, 0x2b, 0x10, 0x00], { ccr: N }).r.pc).toBe(CODE + 0x1004); // LBMI
  });
});

describe('jumps, subroutines, calls', () => {
  it('JMP ext / idx; JSR ext / dir / idx; BSR; RTS', () => {
    expect(exec1([0x06, 0x12, 0x34]).r.pc).toBe(0x1234);
    expect(exec1([0x05, 0x02], { x: 0x5000 }).r.pc).toBe(0x5002);
    expect(exec1([0x05, 0xe3, 0x00, 0x00], { x: 0x2100 }, (s) => putW(s, 0x2100, 0x4567)).r.pc).toBe(0x4567); // JMP [0,X]
    let e = exec1([0x16, 0x50, 0x00]);
    expect([e.r.pc, e.r.sp, getW(e.s, STACK - 2)]).toEqual([0x5000, STACK - 2, CODE + 3]);
    e = exec1([0x17, 0x80]);
    expect(e.r.pc).toBe(0x0080);
    e = exec1([0x15, 0x05], { x: 0x5000 });
    expect([e.r.pc, getW(e.s, STACK - 2)]).toEqual([0x5005, CODE + 2]);
    e = exec1([0x07, 0x10]);
    expect([e.r.pc, getW(e.s, STACK - 2)]).toEqual([CODE + 0x12, CODE + 2]);
    e = exec1([0x3d], { sp: 0x2100 }, (s) => putW(s, 0x2100, 0x4321));
    expect([e.r.pc, e.r.sp]).toEqual([0x4321, 0x2102]);
  });
  it('CALL ext pushes return + PPAGE, switches PPAGE; RTC restores both', () => {
    const s = mk();
    put(s, CODE, [0x4a, 0x80, 0x00, 0xe0]); // CALL $8000,$E0
    s.pokeGlobal(0x400000 | (0xe0 << 14), 0x0a); // RTC at $E0:8000
    s.setRegisters({ pc: CODE });
    s.step();
    expect([s.registers.pc, s.bus.ppage, s.registers.sp]).toEqual([0x8000, 0xe0, STACK - 3]);
    expect([s.peek(STACK - 3), getW(s, STACK - 2)]).toEqual([0xfe, CODE + 4]);
    expect(s.toGlobal(0x8000)).toBe(0x780000);
    s.step();
    expect([s.registers.pc, s.bus.ppage, s.registers.sp]).toEqual([CODE + 4, 0xfe, STACK]);
  });
  it('CALL indexed and indirect (3-byte pointer: address, page)', () => {
    let e = exec1([0x4b, 0x02, 0xe1], { x: 0x8000 });
    expect([e.r.pc, e.s.bus.ppage, getW(e.s, STACK - 2)]).toEqual([0x8002, 0xe1, CODE + 3]);
    e = exec1([0x4b, 0xe3, 0x00, 0x00], { x: 0x2100 }, (s) => put(s, 0x2100, [0x81, 0x23, 0xe5]));
    expect([e.r.pc, e.s.bus.ppage, getW(e.s, STACK - 2)]).toEqual([0x8123, 0xe5, CODE + 4]);
    e = exec1([0x4b, 0xe7], { x: 0x2100, d: 0x0000 }, (s) => put(s, 0x2100, [0x81, 0x00, 0xe6]));
    expect([e.r.pc, e.s.bus.ppage]).toEqual([0x8100, 0xe6]);
  });
});

describe('bit manipulation', () => {
  it('BSET/BCLR (dir/ext/idx) set N Z, V=0', () => {
    let e = exec1([0x1c, 0x21, 0x00, 0x81], { ccr: V }, (s) => s.poke(0x2100, 0x01));
    expect([e.s.peek(0x2100), e.r.ccr]).toEqual([0x81, N]);
    e = exec1([0x1d, 0x21, 0x00, 0xff], {}, (s) => s.poke(0x2100, 0x0f));
    expect([e.s.peek(0x2100), e.r.ccr]).toEqual([0x00, Z]);
    e = exec1([0x0c, 0x01, 0x10], { x: 0x2100 });
    expect(e.s.peek(0x2101)).toBe(0x10);
    e = exec1([0x4d, 0x00, 0x01], {}, (s) => {
      s.poke(0x11, 0x21);
      s.poke(0x2100, 0x03);
    });
    expect(e.s.peek(0x2100)).toBe(0x02);
  });
  it('BRSET / BRCLR', () => {
    expect(exec1([0x1e, 0x21, 0x00, 0x03, 0x10], {}, (s) => s.poke(0x2100, 0x07)).r.pc).toBe(CODE + 5 + 0x10);
    expect(exec1([0x1e, 0x21, 0x00, 0x03, 0x10], {}, (s) => s.poke(0x2100, 0x05)).r.pc).toBe(CODE + 5);
    expect(exec1([0x1f, 0x21, 0x00, 0x03, 0x10], {}, (s) => s.poke(0x2100, 0x04)).r.pc).toBe(CODE + 5 + 0x10);
    expect(exec1([0x0f, 0x00, 0x80, 0xfc], { x: 0x2100 }).r.pc).toBe(CODE); // BRCLR 0,X,#$80,* (spins)
    expect(exec1([0x4e, 0x00, 0x01, 0x02], {}, (s) => {
      s.poke(0x11, 0x21);
      s.poke(0x2100, 0x01);
    }).r.pc).toBe(CODE + 6);
  });
  it('BTAS: test-and-set (N/Z from M & mask, V = 0)', () => {
    let e = exec1([0x18, 0x36, 0x21, 0x00, 0x80], {}, (s) => s.poke(0x2100, 0x01));
    expect([e.s.peek(0x2100), e.r.ccr & (N | Z | V)]).toEqual([0x81, Z]);
    e = exec1([0x18, 0x36, 0x21, 0x00, 0x80], {}, (s) => s.poke(0x2100, 0x80));
    expect([e.s.peek(0x2100), e.r.ccr & (N | Z | V)]).toEqual([0x80, N]);
    e = exec1([0x18, 0x37, 0x01, 0x02], { x: 0x2100 });
    expect(e.s.peek(0x2101)).toBe(0x02);
    e = exec1([0x18, 0x35, 0x00, 0x04], {}, (s) => s.poke(0x11, 0x21));
    expect(e.s.peek(0x2100)).toBe(0x04);
  });
});

describe('stack', () => {
  it('PSH/PUL A B D X Y C round trip', () => {
    const s = mk();
    put(s, CODE, [0x36, 0x37, 0x3b, 0x34, 0x35, 0x39, 0x38, 0x31, 0x30, 0x3a, 0x33, 0x32]);
    s.setRegisters({ a: 0x11, b: 0x22, x: 0x3344, y: 0x5566, ccr: 0x0d });
    for (let i = 0; i < 6; i++) s.step();
    expect(s.registers.sp).toBe(STACK - 9);
    expect(s.readBlock(STACK - 9, 9)).toEqual([0x0d, 0x55, 0x66, 0x33, 0x44, 0x11, 0x22, 0x22, 0x11]);
    s.setRegisters({ a: 0, b: 0, x: 0, y: 0, ccr: 0 });
    for (let i = 0; i < 6; i++) s.step();
    // PULC, PULY, PULX, PULD, PULB, PULA (popping in reverse push order)
    expect(s.registers).toMatchObject({ ccr: 0x0d, y: 0x5566, x: 0x3344, a: 0x11, b: 0x22, sp: STACK });
  });
  it('PSHCW / PULCW include the IPL; PULC/PULCW cannot set X', () => {
    const s = mk();
    put(s, CODE, [0x18, 0x39, 0x18, 0x38]);
    s.setRegisters({ ccr: 0x05, ipl: 5 });
    s.step();
    expect([getW(s, STACK - 2), s.registers.sp]).toEqual([0x0505, STACK - 2]);
    putW(s, STACK - 2, 0x07ff);
    s.step();
    expect([s.registers.ipl, s.registers.ccr]).toEqual([7, 0xbf]);
  });
});

describe('loop primitives', () => {
  const loop = (op: string, reg: string, regs: object) => exec1([0x04, ...encodeLoop(op, reg, -3)], regs);
  it('DBNE / DBEQ / IBNE / IBEQ / TBNE / TBEQ on A B D X Y SP', () => {
    expect(loop('DBNE', 'X', { x: 2 }).r).toMatchObject({ x: 1, pc: CODE });
    expect(loop('DBNE', 'X', { x: 1 }).r).toMatchObject({ x: 0, pc: CODE + 3 });
    expect(loop('DBEQ', 'A', { a: 1 }).r).toMatchObject({ a: 0, pc: CODE });
    expect(loop('DBNE', 'A', { a: 0 }).r).toMatchObject({ a: 0xff, pc: CODE }); // wraps
    expect(loop('IBNE', 'B', { b: 0xff }).r).toMatchObject({ b: 0, pc: CODE + 3 });
    expect(loop('IBEQ', 'D', { d: 0xffff }).r).toMatchObject({ d: 0, pc: CODE });
    expect(loop('TBEQ', 'Y', { y: 0 }).r).toMatchObject({ y: 0, pc: CODE });
    expect(loop('TBNE', 'SP', { sp: 0x100 }).r).toMatchObject({ sp: 0x100, pc: CODE });
    expect(loop('DBNE', 'D', { d: 0x0100 }).r).toMatchObject({ d: 0x00ff, pc: CODE });
    expect(loop('IBNE', 'Y', { y: 0 }).r.y).toBe(1);
    expect(loop('DBEQ', 'SP', { sp: 1 }).r).toMatchObject({ sp: 0, pc: CODE });
    // no CCR change
    expect(loop('DBNE', 'X', { x: 1, ccr: 0x0f }).r.ccr).toBe(0x0f);
  });
  it('positive 9-bit offsets', () => {
    expect(exec1([0x04, ...encodeLoop('DBNE', 'X', 0x80)], { x: 5 }).r.pc).toBe(CODE + 3 + 0x80);
  });
});

describe('TFR / EXG / SEX', () => {
  const tfr = (op: string, src: string, dst: string, regs: object) =>
    exec1([0xb7, encodeTfrExg(op, src, dst, 's12x')!], regs).r;
  it('8->8, 16->16, 16->8 (low byte), 8->16 sign-extends', () => {
    expect(tfr('TFR', 'A', 'B', { a: 0x12 }).b).toBe(0x12);
    expect(tfr('TFR', 'X', 'Y', { x: 0x1234 }).y).toBe(0x1234);
    expect(tfr('TFR', 'D', 'A', { d: 0x1234 }).a).toBe(0x34);
    expect(tfr('TFR', 'X', 'B', { x: 0x1234 }).b).toBe(0x34);
    expect(tfr('TFR', 'A', 'X', { a: 0x80 }).x).toBe(0xff80);
    expect(tfr('SEX', 'B', 'D', { b: 0x7f }).d).toBe(0x007f);
    expect(tfr('SEX', 'B', 'Y', { b: 0xff }).y).toBe(0xffff);
    expect(tfr('TFR', 'CCR', 'A', { ccr: 0xc5 }).a).toBe(0xc5);
  });
  it('TFR to CCR obeys the X rule and copies other bits', () => {
    expect(tfr('TFR', 'A', 'CCR', { a: 0xff, ccr: 0x00 }).ccr).toBe(0xbf);
    expect(tfr('TFR', 'A', 'CCR', { a: 0x00, ccr: 0xd0 }).ccr).toBe(0x00);
  });
  it('EXG: equal widths swap; 8,16 zero-fills; 16,B/CCR fills $FF', () => {
    expect(tfr('EXG', 'A', 'B', { a: 1, b: 2 })).toMatchObject({ a: 2, b: 1 });
    expect(tfr('EXG', 'X', 'Y', { x: 1, y: 2 })).toMatchObject({ x: 2, y: 1 });
    expect(tfr('EXG', 'A', 'X', { a: 0x12, x: 0x3456 })).toMatchObject({ a: 0x56, x: 0x0012 });
    expect(tfr('EXG', 'X', 'A', { a: 0x12, x: 0x3456 })).toMatchObject({ a: 0x56, x: 0x0012 });
    expect(tfr('EXG', 'X', 'B', { b: 0x12, x: 0x3456 })).toMatchObject({ b: 0x56, x: 0xff12 });
    expect(tfr('EXG', 'Y', 'CCR', { ccr: 0x05, y: 0x34c3 })).toMatchObject({ ccr: 0x83, y: 0xff05 });
    expect(tfr('EXG', 'D', 'X', { d: 0x1111, x: 0x2222 })).toMatchObject({ d: 0x2222, x: 0x1111 });
  });
  it('CPU12X: CCRW, CCRH, XH/XL, YH/YL, SPH/SPL, SEX D,X', () => {
    expect(tfr('TFR', 'CCRW', 'D', { ccr: 0x15, ipl: 3 }).d).toBe(0x0315);
    const w = tfr('TFR', 'D', 'CCRW', { d: 0x07ff, ccr: 0 });
    expect([w.ipl, w.ccr]).toEqual([7, 0xbf]);
    expect(tfr('TFR', 'CCRH', 'A', { ipl: 6 }).a).toBe(6);
    expect(tfr('TFR', 'A', 'CCRH', { a: 0xfd }).ipl).toBe(5);
    expect(tfr('TFR', 'A', 'XH', { a: 0xab, x: 0x1234 }).x).toBe(0xab34);
    expect(tfr('TFR', 'B', 'XL', { b: 0xcd, x: 0x1234 }).x).toBe(0x12cd);
    expect(tfr('TFR', 'XH', 'A', { x: 0xab12 }).a).toBe(0xab);
    expect(tfr('TFR', 'A', 'YH', { a: 0x99, y: 0 }).y).toBe(0x9900);
    expect(tfr('TFR', 'B', 'SPL', { b: 0x77, sp: 0x1200 }).sp).toBe(0x1277);
    expect(tfr('EXG', 'XL', 'B', { b: 0x11, x: 0x2233 })).toMatchObject({ b: 0x33, x: 0x2211 });
    expect(tfr('EXG', 'X', 'CCRW', { x: 0x0201, ccr: 0x08, ipl: 4 })).toMatchObject({ x: 0x0408, ccr: 0x01, ipl: 2 });
    expect(tfr('SEX', 'D', 'X', { d: 0x8000 }).x).toBe(0xffff);
    expect(tfr('SEX', 'D', 'Y', { d: 0x7fff }).y).toBe(0x0000);
    expect(tfr('TFR', 'CCRW', 'X', { ccr: 0x01, ipl: 1 }).x).toBe(0x0101);
  });
  it('TMP2 / TMP3 are internal registers', () => {
    const e = exec1([0xb7, 0x43], { d: 0x1234 }); // TFR D,TMP2
    expect(e.s.cpu.tmp2).toBe(0x1234);
  });
});

describe('MOVB / MOVW (all CPU12 and CPU12X forms)', () => {
  it('#imm -> ext / ext -> ext / idx -> ext / #imm -> idx / ext -> idx / idx -> idx', () => {
    let e = exec1([0x18, 0x0b, 0x5a, 0x21, 0x00]);
    expect(e.s.peek(0x2100)).toBe(0x5a);
    e = exec1([0x18, 0x03, 0x12, 0x34, 0x21, 0x00]);
    expect(getW(e.s, 0x2100)).toBe(0x1234);
    e = exec1([0x18, 0x0c, 0x21, 0x00, 0x21, 0x10], {}, (s) => s.poke(0x2100, 0x77));
    expect(e.s.peek(0x2110)).toBe(0x77);
    e = exec1([0x18, 0x04, 0x21, 0x00, 0x21, 0x10], {}, (s) => putW(s, 0x2100, 0xbeef));
    expect(getW(e.s, 0x2110)).toBe(0xbeef);
    e = exec1([0x18, 0x0d, 0x30, 0x21, 0x10], { x: 0x2100 }, (s) => s.poke(0x2100, 0x42)); // MOVB 1,X+,$2110
    expect([e.s.peek(0x2110), e.r.x]).toEqual([0x42, 0x2101]);
    e = exec1([0x18, 0x08, 0x40, 0x99], { y: 0x2100 }); // MOVB #$99,0,Y (postbyte first)
    expect(e.s.peek(0x2100)).toBe(0x99);
    e = exec1([0x18, 0x00, 0x42, 0x12, 0x34], { y: 0x2100 }); // MOVW #$1234,2,Y
    expect(getW(e.s, 0x2102)).toBe(0x1234);
    e = exec1([0x18, 0x09, 0x41, 0x21, 0x00], { y: 0x2100 }, (s) => s.poke(0x2100, 0x55)); // MOVB $2100,1,Y
    expect(e.s.peek(0x2101)).toBe(0x55);
    e = exec1([0x18, 0x02, 0x31, 0x71], { x: 0x2100, y: 0x2200 }, (s) => putW(s, 0x2100, 0xcafe)); // MOVW 2,X+,2,Y+
    expect([getW(e.s, 0x2200), e.r.x, e.r.y]).toEqual([0xcafe, 0x2102, 0x2202]);
    e = exec1([0x18, 0x0a, 0x00, 0x40], { x: 0x2100, y: 0x2200 }, (s) => s.poke(0x2100, 0x31)); // MOVB 0,X,0,Y
    expect(e.s.peek(0x2200)).toBe(0x31);
  });
  it('CPU12X extended indexed operands (IDX1, IDX2, [D,r], [n,r]) on both sides', () => {
    // MOVB 300,X , $2110 : idx2 source then ext
    let e = exec1([0x18, 0x0d, 0xe2, 0x01, 0x2c, 0x21, 0x10], { x: 0x2000 }, (s) => s.poke(0x212c, 0x66));
    expect(e.s.peek(0x2110)).toBe(0x66);
    // MOVW #$ABCD, 100,Y (IDX1 destination; immediate follows the extension byte)
    e = exec1([0x18, 0x00, 0xe8, 0x64, 0xab, 0xcd], { y: 0x2100 });
    expect(getW(e.s, 0x2164)).toBe(0xabcd);
    // MOVB [D,X], [16,Y]
    e = exec1([0x18, 0x0a, 0xe7, 0xeb, 0x00, 0x10], { x: 0x2100, y: 0x2100, d: 0 }, (s) => {
      putW(s, 0x2100, 0x2180); // [D,X] -> $2180
      putW(s, 0x2110, 0x2190); // [16,Y] -> $2190
      s.poke(0x2180, 0x5d);
    });
    expect(e.s.peek(0x2190)).toBe(0x5d);
    // MOVW $2100, -20,X (9-bit negative destination)
    e = exec1([0x18, 0x01, 0xe1, 0xec, 0x21, 0x00], { x: 0x2120 }, (s) => putW(s, 0x2100, 0x1357));
    expect(getW(e.s, 0x210c)).toBe(0x1357);
  });
  it('PC-relative source of MOVB idx->idx uses the address after the destination postbyte', () => {
    // MOVB 2,PC , 0,X : pcBase = CODE + 4 (after 18 0A C2 00) -> source CODE + 6
    const e = exec1([0x18, 0x0a, 0xc2, 0x00, 0xa7, 0xa7, 0x3e], { x: 0x2100 });
    expect(e.s.peek(0x2100)).toBe(0x3e);
  });
});

describe('CPU12X global (GPAGE) loads and stores', () => {
  it('GLDAA/GSTAA ext/dir/idx through GPAGE:addr16', () => {
    // GPAGE $0F, addr $D000 -> global $0FD000 = RAM local $1000 (RPAGE $FD)
    let e = exec1([0x18, 0xb6, 0xd0, 0x00], {}, (s) => {
      s.poke(0x10, 0x0f);
      s.poke(0x1000, 0xa5);
    });
    expect(e.r.a).toBe(0xa5);
    expect(e.r.ccr & N).toBe(N);
    e = exec1([0x18, 0x7a, 0xe0, 0x05], { a: 0x3c }, (s) => s.poke(0x10, 0x0f)); // GSTAA $E005
    expect(e.s.peekGlobal(0x0fe005)).toBe(0x3c);
    expect(e.s.peek(0x2005)).toBe(0x3c);
    e = exec1([0x18, 0x5b, 0x10], { b: 0x77 }, (s) => {
      s.poke(0x10, 0x0f);
      s.poke(0x11, 0xe1);
    }); // GSTAB dir: GPAGE:DIRECT:dd = $0FE110
    expect(e.s.peekGlobal(0x0fe110)).toBe(0x77);
    e = exec1([0x18, 0xe6, 0x02], { x: 0xe000 }, (s) => {
      s.poke(0x10, 0x0f);
      s.pokeGlobal(0x0fe002, 0x19);
    }); // GLDAB 2,X
    expect(e.r.b).toBe(0x19);
  });
  it('16-bit G loads/stores (GLDD/GLDX/GLDY/GLDS, GSTD/GSTX/GSTY/GSTS) reach flash and EEPROM', () => {
    const g = (bytes: number[], regs: object) =>
      exec1(bytes, regs, (s) => {
        s.poke(0x10, 0x7f);
        s.pokeGlobal(0x7fc000, 0x12);
        s.pokeGlobal(0x7fc001, 0x34);
      }).r;
    expect(g([0x18, 0xfc, 0xc0, 0x00], {}).d).toBe(0x1234);
    expect(g([0x18, 0xfe, 0xc0, 0x00], {}).x).toBe(0x1234);
    expect(g([0x18, 0xfd, 0xc0, 0x00], {}).y).toBe(0x1234);
    expect(g([0x18, 0xff, 0xc0, 0x00], {}).sp).toBe(0x1234);
    const st = (op: number, regs: object) => {
      const e = exec1([0x18, op, 0xf0, 0x00], regs, (s) => s.poke(0x10, 0x0f));
      return (e.s.peekGlobal(0x0ff000) << 8) | e.s.peekGlobal(0x0ff001);
    };
    expect(st(0x7c, { d: 0x1111 })).toBe(0x1111);
    expect(st(0x7e, { x: 0x2222 })).toBe(0x2222);
    expect(st(0x7d, { y: 0x3333 })).toBe(0x3333);
    expect(st(0x7f, { sp: 0x4444 })).toBe(0x4444);
    // EEPROM through GPAGE $13
    const ee = exec1([0x18, 0xb6, 0xf8, 0x00], {}, (s) => {
      s.poke(0x10, 0x13);
      s.pokeGlobal(0x13f800, 0x5e);
    });
    expect(ee.r.a).toBe(0x5e);
  });
});

describe('fuzzy logic (MEM, REV, REVW, WAV, WAVR)', () => {
  it('MEM: trapezoid grade, slope 0 = infinite, outside = 0', () => {
    const mem = (a: number, pts: number[]) => {
      const e = exec1([0x01], { a, x: 0x2100, y: 0x2200 }, (s) => put(s, 0x2100, pts));
      return [e.s.peek(0x2200), e.r.x, e.r.y];
    };
    // P1=$40 P2=$D0 S1=$08 S2=$04
    expect(mem(0x50, [0x40, 0xd0, 0x08, 0x04])).toEqual([0x80, 0x2104, 0x2201]);
    expect(mem(0x80, [0x40, 0xd0, 0x08, 0x04])).toEqual([0xff, 0x2104, 0x2201]); // saturated
    expect(mem(0xc8, [0x40, 0xd0, 0x08, 0x04])).toEqual([0x20, 0x2104, 0x2201]); // (D0-C8)*4
    expect(mem(0x30, [0x40, 0xd0, 0x08, 0x04])).toEqual([0x00, 0x2104, 0x2201]);
    expect(mem(0x40, [0x40, 0xd0, 0x00, 0x04])).toEqual([0xff, 0x2104, 0x2201]); // infinite left slope
  });
  it('MEM: CPU12RM Fig 9-4 normal function and the §9.4.2 abnormal cases follow the Fig 9-5 algorithm', () => {
    const mem = (a: number, pts: number[]) => {
      const e = exec1([0x01], { a, x: 0x2100, y: 0x2200 }, (s) => put(s, 0x2100, pts));
      expect(e.cycles).toBe(5); // RRfOw
      return e.s.peek(0x2200);
    };
    // Fig 9-4: point_1 $40, point_2 $D0, slope_1 $08, slope_2 $04.
    const fig94 = [0x40, 0xd0, 0x08, 0x04];
    expect([0x3f, 0x40, 0x50, 0x5f, 0x60, 0xa0, 0xc0, 0xd0, 0xd1].map((a) => mem(a, fig94))).toEqual([
      0x00, 0x00, 0x80, 0xf8, 0xff, 0xc0, 0x40, 0x00, 0x00,
    ]);
    // Case 1 ($60,$80,$04,$04): follows the LEFT side from point_1 to point_2 (4b overrides 4a).
    const c1 = [0x60, 0x80, 0x04, 0x04];
    expect([0x5f, 0x60, 0x70, 0x78, 0x80, 0x81].map((a) => mem(a, c1))).toEqual([0x00, 0x00, 0x40, 0x60, 0x80, 0x00]);
    // Case 2 ($60,$C0,$04,$04): left side until it passes $FF, then the right side.
    const c2 = [0x60, 0xc0, 0x04, 0x04];
    expect([0x70, 0x9f, 0xa0, 0xb0, 0xc0].map((a) => mem(a, c2))).toEqual([0x40, 0xfc, 0x80, 0x40, 0x00]);
    // Case 3 ($60,$80,$00,$04): slope_1 = 0 so 4b never overrides: grade = right side (grade_2).
    const c3 = [0x60, 0x80, 0x00, 0x04];
    expect([0x60, 0x70, 0x7c, 0x80].map((a) => mem(a, c3))).toEqual([0x80, 0x40, 0x10, 0x00]);
  });
  it('REV: MIN of antecedents, MAX into consequents (CPU12RM ch.9 style example)', () => {
    // Fuzzy inputs at Y+0..3, outputs at Y+4..5 (cleared). Rules:
    //  R1: IF in0 AND in1 THEN out4    (min($80,$40) = $40)
    //  R2: IF in2 AND in3 THEN out4    (min($20,$C0) = $20 -> MAX keeps $40)
    //  R3: IF in1 THEN out5            ($40)
    const rules = [0, 1, 0xfe, 4, 0xfe, 2, 3, 0xfe, 4, 0xfe, 1, 0xfe, 5, 0xff];
    const s = mk();
    put(s, CODE, [0x18, 0x3a]);
    put(s, 0x2100, rules);
    put(s, 0x2200, [0x80, 0x40, 0x20, 0xc0, 0x00, 0x00]);
    s.setRegisters({ pc: CODE, x: 0x2100, y: 0x2200, a: 0xff, ccr: 0 });
    const c0 = s.cycles;
    s.step();
    expect(s.readBlock(0x2204, 2)).toEqual([0x40, 0x40]);
    expect(s.registers.x).toBe(0x2100 + rules.length);
    expect(s.registers.ccr & V).toBe(V);
    // Fig 9-9: fixed 'Orf..O' + the 3-cycle loop once per rule byte INCLUDING the $FF end marker (§9.5.1.3)
    expect(s.cycles - c0).toBe(4 + 3 * rules.length);
  });
  it('REVW: 16-bit pointers, weighted when C = 1', () => {
    const s = mk();
    put(s, CODE, [0x18, 0x3b]);
    // in0 at $2200=$80, in1 $2201=$FF, out at $2210. Rule: IF in0 AND in1 THEN out (weight $7F -> *128/256)
    const list = [0x2200, 0x2201, 0xfffe, 0x2210, 0xfffe, 0xffff];
    list.forEach((w, i) => putW(s, 0x2100 + 2 * i, w));
    put(s, 0x2200, [0x80, 0xff]);
    s.poke(0x2300, 0x7f);
    s.setRegisters({ pc: CODE, x: 0x2100, y: 0x2300, a: 0xff, ccr: C });
    let c0 = s.cycles;
    s.step();
    expect(s.peek(0x2210)).toBe(0x40); // $80 * ($7F+1) / 256
    expect([s.registers.x, s.registers.y]).toEqual([0x2100 + 12, 0x2301]);
    // Fig 9-10: 'ORf..O' + 3 per word incl. $FFFF; only the antecedent->consequent $FFFE pass (V=0, C=1)
    // takes 5 cycles (§9.5.2.3); the consequent->antecedent $FFFE stays at 3.
    expect(s.cycles - c0).toBe(4 + 3 * list.length + 2);
    // unweighted
    const u = mk();
    put(u, CODE, [0x18, 0x3b]);
    list.forEach((w, i) => putW(u, 0x2100 + 2 * i, w));
    put(u, 0x2200, [0x80, 0xff]);
    u.setRegisters({ pc: CODE, x: 0x2100, y: 0x2300, a: 0xff, ccr: 0 });
    c0 = u.cycles;
    u.step();
    expect(u.peek(0x2210)).toBe(0x80);
    expect(u.cycles - c0).toBe(4 + 3 * list.length);
  });
  it('WAV + EDIV: weighted average (defuzzification)', () => {
    const s = mk();
    put(s, CODE, [0x18, 0x3c, 0x11]); // WAV ; EDIV
    put(s, 0x2100, [0x10, 0x80, 0xf0]); // singletons Si
    put(s, 0x2200, [0x40, 0x80, 0x40]); // weights Fi
    s.setRegisters({ pc: CODE, x: 0x2100, y: 0x2200, b: 3 });
    const c0 = s.cycles;
    s.step();
    // SOP = 16*64 + 128*128 + 240*64 = 32768, SOW = 256
    expect([s.registers.y, s.registers.d, s.registers.x]).toEqual([0x0000, 0x8000, 0x0100]);
    expect(s.registers.ccr & Z).toBe(Z);
    expect(s.cycles - c0).toBe(3 + 7 * 3); // Of(frr,ffff)O
    s.step(); // EDIV: Y:D / X
    expect(s.registers.y).toBe(0x80);
  });
  it('WAV with B = 0 runs 256 iterations (B decremented at the top, tested at the bottom, §9.6.3)', () => {
    const s = mk();
    put(s, CODE, [0x18, 0x3c]);
    for (let i = 0; i < 256; i++) {
      s.poke(0x2100 + i, 1);
      s.poke(0x2400 + i, 2);
    }
    s.setRegisters({ pc: CODE, x: 0x2100, y: 0x2400, b: 0 });
    const c0 = s.cycles;
    s.step();
    // SOP = 256 * 1 * 2 = $200, SOW = 512
    expect([s.registers.y, s.registers.d, s.registers.x]).toEqual([0x0000, 0x0200, 0x0200]);
    expect(s.cycles - c0).toBe(3 + 7 * 256);
  });
  it('WAVR resumes WAV: finishes the interrupted iteration (operands at X-1/Y-1), then B more', () => {
    const run = (b: number) => {
      const s = mk();
      put(s, CODE, [0x3c]);
      put(s, 0x2100, [0x02, 0x05]);
      put(s, 0x2200, [0x03, 0x04]);
      // Interrupted after fetching element 0: X/Y already advanced. Stack: $00:SOP[23:16], SOP[15:0], SOW.
      s.setRegisters({ pc: CODE, x: 0x2101, y: 0x2201, b, sp: 0x2300 });
      putW(s, 0x2300, 0x0001);
      putW(s, 0x2302, 0x0000);
      putW(s, 0x2304, 0x0010);
      const c0 = s.cycles;
      s.step();
      return { r: [s.registers.y, s.registers.d, s.registers.x, s.registers.sp], cyc: s.cycles - c0 };
    };
    // B = 0: only the interrupted iteration (2*3): SOP = $10006, SOW = $13.
    expect(run(0).r).toEqual([0x0001, 0x0006, 0x0013, 0x2306]);
    expect(run(0).cyc).toBe(10); // UUUrr + ffff + O
    // B = 1: one more iteration (5*4): SOP = $1001A, SOW = $17.
    expect(run(1).r).toEqual([0x0001, 0x001a, 0x0017, 0x2306]);
    expect(run(1).cyc).toBe(10 + 7);
  });
});

describe('I flag via SEI/CLI aliases', () => {
  it('ORCC #$10 sets I; ANDCC #$EF clears it', () => {
    expect(exec1([0x14, 0x10]).r.ccr & I).toBe(I);
    expect(exec1([0x10, 0xef], { ccr: I | X }).r.ccr).toBe(X);
  });
});
