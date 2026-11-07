/**
 * Spot checks against libasm (Tadashi Takaoka, Apache-2.0) disassembler test vectors,
 * test/test_dis_mc68hc12.cpp (68HCS12X configuration unless noted). Operands are compared after
 * normalising numbers to decimal. libasm prints PC-relative operands as the absolute target
 * (`$1004,PC`), which we compare against Operand.address.
 */
import { describe, expect, it } from 'vitest';
import { decode, formatIndexed, type Cpu, type DecodedInstruction, type Operand } from '../src/index.js';
import { normOperands } from './helpers.js';

type Vec = [mnemonic: string, operands: string, bytes: number[], addr?: number, cpu?: Cpu];

const V: Vec[] = [
  // loads / stores
  ['LDAA', '#$87', [0x86, 0x87]],
  ['LDAA', '$97', [0x96, 0x97]],
  ['LDAA', '8,+SP', [0xa6, 0xa7]],
  ['LDAA', '$B7B8', [0xb6, 0xb7, 0xb8]],
  ['LDAB', '[D,X]', [0xe6, 0xe7]],
  ['LDD', '#$CDCE', [0xcc, 0xcd, 0xce]],
  ['LDD', 'B,Y', [0xec, 0xed]],
  ['LDS', '$F1,SP', [0xef, 0xf0, 0xf1]],
  ['LDS', '>$0001', [0xff, 0x00, 0x01]],
  ['LDX', '[D,Y]', [0xee, 0xef]],
  ['LDY', 'D,Y', [0xed, 0xee]],
  ['LEAS', '-4,X', [0x1b, 0x1c]],
  ['STAA', '5,-Y', [0x6a, 0x6b]],
  ['STS', '1,Y+', [0x6f, 0x70]],
  ['STY', '$7E7F', [0x7d, 0x7e, 0x7f]],
  // transfers
  ['TFR', 'A, CCR', [0xb7, 0x02]],
  ['SEX', 'B, X', [0xb7, 0x15]],
  ['TFR', 'SP, Y', [0xb7, 0x76]],
  ['EXG', 'D, X', [0xb7, 0xc5]],
  ['EXG', 'CCR, SP', [0xb7, 0xa7]],
  ['TFR', 'A, CCRH', [0xb7, 0x0a]],
  ['SEX', 'A, D', [0xb7, 0x0c]],
  ['TFR', 'A, XH', [0xb7, 0x0d]],
  ['TFR', 'B, CCR', [0xb7, 0x1a]],
  ['EXG', 'XL, B', [0xb7, 0xd9]],
  ['EXG', 'X, CCRW', [0xb7, 0xda]],
  ['EXG', 'X, D', [0xb7, 0xdc]],
  ['EXG', 'SPH, A', [0xb7, 0xf8]],
  ['TAB', '', [0x18, 0x0e]],
  // moves (CPU12 forms)
  ['MOVW', '#$0203, 1,X', [0x18, 0x00, 0x01, 0x02, 0x03]],
  ['MOVW', '$0304, 2,X', [0x18, 0x01, 0x02, 0x03, 0x04]],
  ['MOVW', '3,X, 4,X', [0x18, 0x02, 0x03, 0x04]],
  ['MOVW', '#$0405, $0607', [0x18, 0x03, 0x04, 0x05, 0x06, 0x07]],
  ['MOVW', '$0506, $0708', [0x18, 0x04, 0x05, 0x06, 0x07, 0x08]],
  ['MOVW', '6,X, $0708', [0x18, 0x05, 0x06, 0x07, 0x08]],
  ['MOVB', '#10, 9,X', [0x18, 0x08, 0x09, 0x0a]],
  ['MOVB', '$0B0C, 10,X', [0x18, 0x09, 0x0a, 0x0b, 0x0c]],
  ['MOVB', '11,X, 12,X', [0x18, 0x0a, 0x0b, 0x0c]],
  ['MOVB', '#12, $0D0E', [0x18, 0x0b, 0x0c, 0x0d, 0x0e]],
  ['MOVB', '$0D0E, $0F10', [0x18, 0x0c, 0x0d, 0x0e, 0x0f, 0x10]],
  ['MOVB', '14,X, $0F10', [0x18, 0x0d, 0x0e, 0x0f, 0x10]],
  // moves (S12X extended indexed forms)
  ['MOVW', '#$1234, $C8,X', [0x18, 0x00, 0xe0, 0xc8, 0x12, 0x34]],
  ['MOVW', '$5678, $C8,X', [0x18, 0x01, 0xe0, 0xc8, 0x56, 0x78]],
  ['MOVW', '-$064,Y, $C8,X', [0x18, 0x02, 0xe9, 0x9c, 0xe0, 0xc8]],
  ['MOVW', '$1234,SP, $C8,X', [0x18, 0x02, 0xf2, 0x12, 0x34, 0xe0, 0xc8]],
  ['MOVW', '[$1234,Y], [$4321,X]', [0x18, 0x02, 0xeb, 0x12, 0x34, 0xe3, 0x43, 0x21]],
  ['MOVW', '-$064,Y, $9ABC', [0x18, 0x05, 0xe9, 0x9c, 0x9a, 0xbc]],
  ['MOVW', '2,X+, $C8,X', [0x18, 0x02, 0x31, 0xe0, 0xc8]],
  ['MOVB', '#18, $C8,X', [0x18, 0x08, 0xe0, 0xc8, 0x12]],
  ['MOVB', '3,-Y, $C8,X', [0x18, 0x0a, 0x6d, 0xe0, 0xc8]],
  ['MOVB', '-$064,Y, [D,Y]', [0x18, 0x0a, 0xe9, 0x9c, 0xef]],
  ['MOVB', '-$064,Y, 4,SP-', [0x18, 0x0a, 0xe9, 0x9c, 0xbc]],
  ['MOVB', 'B,SP, $C8,X', [0x18, 0x0a, 0xf5, 0xe0, 0xc8]],
  // PC-relative
  ['MOVB', '#$34, $1004,PC', [0x18, 0x08, 0xc0, 0x34], 0x1000],
  ['MOVW', '#$1234, $1005,PC', [0x18, 0x00, 0xc0, 0x12, 0x34], 0x1000],
  ['MOVB', '$1004,PC, $64,X', [0x18, 0x0a, 0xc0, 0xe0, 0x64], 0x1000],
  ['MOVB', '$1004,PC, $1234,X', [0x18, 0x0a, 0xc0, 0xe2, 0x12, 0x34], 0x1000],
  ['MOVB', '$1100,PC, $1200,PC', [0x18, 0x0a, 0xf8, 0xfb, 0xfa, 0x01, 0xf9], 0x1000],
  ['MOVW', '$1100,PC, $1234,Y', [0x18, 0x02, 0xf8, 0xfb, 0xea, 0x12, 0x34], 0x1000],
  ['MOVB', '1,X, $1100,PC', [0x18, 0x0a, 0x01, 0xf8, 0xfb], 0x1000],
  ['MOVB', '$1005,PC, $1234', [0x18, 0x0d, 0xc0, 0x12, 0x34], 0x1000],
  ['MOVB', '$1004,PC, $1004,PC', [0x18, 0x0a, 0xc0, 0xc0], 0x1000, 'cpu12'],
  ['BCLR', '$1003,PC, #$C1', [0x0d, 0xc0, 0xc1], 0x1000],
  ['BCLR', '$1103,PC, #$F9', [0x0d, 0xf8, 0xff, 0xf9], 0x1000],
  ['BRCLR', '$1013,PC, #$D0, $1083', [0x0f, 0xcf, 0xd0, 0x7f], 0x1000],
  ['BRSET', '$9005,PC, #$FB, $1006', [0x0e, 0xfa, 0x7f, 0xff, 0xfb, 0x00], 0x1000],
  ['CALL', '$1003,PC, $4D', [0x4b, 0xc0, 0x4d], 0x1000],
  ['CALL', '[$1004,PC]', [0x4b, 0xfb, 0x00, 0x00], 0x1000],
  ['ETBL', '$0010,PC', [0x18, 0x3f, 0xcd], 0x0000],
  // arithmetic / logic
  ['ADCB', '$EBEC,Y', [0xe9, 0xea, 0xeb, 0xec]],
  ['ADDB', 'A,Y', [0xeb, 0xec]],
  ['SBCB', '[$E4E5,X]', [0xe2, 0xe3, 0xe4, 0xe5]],
  ['SUBB', '-30,X', [0xe0, 0xe1, 0xe2]],
  ['SUBD', '5,+SP', [0xa3, 0xa4]],
  ['DAA', '', [0x18, 0x07]],
  ['CPS', '1,SP+', [0xaf, 0xb0]],
  ['TST', '$E9,Y', [0xe7, 0xe8, 0xe9]],
  ['ANDCC', '#17', [0x10, 0x11]],
  ['ORAB', '[$ECED,Y]', [0xea, 0xeb, 0xec, 0xed]],
  ['CLR', '6,-Y', [0x69, 0x6a]],
  ['EDIVS', '', [0x18, 0x14]],
  ['FDIV', '', [0x18, 0x11]],
  ['EMULS', '', [0x18, 0x13]],
  ['BCLR', '$E1,X, #$E2', [0x0d, 0xe0, 0xe1, 0xe2]],
  ['BCLR', '$F3F4,SP, #$F5', [0x0d, 0xf2, 0xf3, 0xf4, 0xf5]],
  ['BSET', '$1D1E, #31', [0x1c, 0x1d, 0x1e, 0x1f]],
  ['BSET', '$4D, #$4E', [0x4c, 0x4d, 0x4e]],
  ['ASL', '7,-Y', [0x68, 0x69]],
  ['ROR', '$7778', [0x76, 0x77, 0x78]],
  ['REV', '', [0x18, 0x3a]],
  ['REVW', '', [0x18, 0x3b]],
  ['WAV', '', [0x18, 0x3c]],
  ['MEM', '', [0x01]],
  ['EMIND', '-4,X', [0x18, 0x1b, 0x1c]],
  ['EMAXM', '-1,X', [0x18, 0x1e, 0x1f]],
  ['MAXA', '-7,X', [0x18, 0x18, 0x19]],
  ['EMACS', '$1314', [0x18, 0x12, 0x13, 0x14]],
  ['ETBL', '0,Y', [0x18, 0x3f, 0x40]],
  ['ETBL', 'D,X', [0x18, 0x3f, 0xe6]],
  ['TBL', '2,X-', [0x18, 0x3d, 0x3e]],
  ['STOP', '', [0x18, 0x3e]],
  // branches / loops / jumps
  ['BRN', '$1081', [0x21, 0x7f], 0x1000],
  ['BHI', '$1004', [0x22, 0x02], 0x1000],
  ['LBLE', '$1004', [0x18, 0x2f, 0x00, 0x00], 0x1000],
  ['BRCLR', '-16,X, #17, $1016', [0x0f, 0x10, 0x11, 0x12], 0x1000],
  ['BRCLR', '$2021, #$22, $1028', [0x1f, 0x20, 0x21, 0x22, 0x23], 0x1000],
  ['BRSET', '$4F, #$50, $1055', [0x4e, 0x4f, 0x50, 0x51], 0x1000],
  ['DBEQ', 'A, $1004', [0x04, 0x00, 0x01], 0x1000],
  ['DBNE', 'X, $0F39', [0x04, 0x35, 0x36], 0x1000],
  ['TBNE', 'SP, $106B', [0x04, 0x67, 0x68], 0x1000],
  ['IBNE', 'D, $0FB8', [0x04, 0xb4, 0xb5], 0x1000],
  ['IBEQ', 'Y, $108A', [0x04, 0x86, 0x87], 0x1000],
  ['BSR', '$100A', [0x07, 0x08], 0x1000],
  ['CALL', '$4B4C, $4D', [0x4a, 0x4b, 0x4c, 0x4d]],
  ['CALL', '12,Y, $4D', [0x4b, 0x4c, 0x4d]],
  ['CALL', '$EBEC,Y, $ED', [0x4b, 0xea, 0xeb, 0xec, 0xed]],
  ['CALL', '[$ECED,Y]', [0x4b, 0xeb, 0xec, 0xed]],
  ['CALL', '[D,X]', [0x4b, 0xe7]],
  ['JMP', '6,X', [0x05, 0x06]],
  ['JSR', '$18', [0x17, 0x18]],
  ['JSR', '-10,X', [0x15, 0x16]],
  ['RTC', '', [0x0a]],
  // traps
  ['TRAP', '$30', [0x18, 0x30]],
  ['TRAP', '$4D', [0x18, 0x4d]],
  ['TRAP', '$B7', [0x18, 0xb7]],
  ['TRAP', '$C6', [0x18, 0xc6]],
  ['TRAP', '$F1', [0x18, 0xf1]],
  ['TRAP', '$96', [0x18, 0x96], 0, 'cpu12'],
  ['TRAP', '$5F', [0x18, 0x5f], 0, 'cpu12'],
  ['TRAP', '$38', [0x18, 0x38], 0, 'cpu12'],
  ['TRAP', '$73', [0x18, 0x73], 0, 'cpu12'],
  ['TRAP', '$FF', [0x18, 0xff], 0, 'cpu12'],
  // S12X global, ALU, word, inherent, bit
  ['GLDAA', '$12', [0x18, 0x96, 0x12]],
  ['GLDAA', '[D,Y]', [0x18, 0xa6, 0xef]],
  ['GLDAB', '$1234', [0x18, 0xf6, 0x12, 0x34]],
  ['GLDS', '5,X', [0x18, 0xef, 0x05]],
  ['GLDD', '$12', [0x18, 0xdc, 0x12]],
  ['GSTS', '$1234', [0x18, 0x7f, 0x12, 0x34]],
  ['GSTY', '$12', [0x18, 0x5d, 0x12]],
  ['GSTAA', '[D,Y]', [0x18, 0x6a, 0xef]],
  ['SUBX', '#$1234', [0x18, 0x80, 0x12, 0x34]],
  ['ADDX', '$1234,Y', [0x18, 0xab, 0xea, 0x12, 0x34]],
  ['CPES', '[D,SP]', [0x18, 0xaf, 0xf7]],
  ['ADED', '$12', [0x18, 0xd3, 0x12]],
  ['ORY', '$1234', [0x18, 0xfa, 0x12, 0x34]],
  ['SBEY', '5,X', [0x18, 0xe2, 0x05]],
  ['NEGW', '-$064,Y', [0x18, 0x60, 0xe9, 0x9c]],
  ['COMW', '[$1234,SP]', [0x18, 0x61, 0xf3, 0x12, 0x34]],
  ['INCW', '$1234', [0x18, 0x72, 0x12, 0x34]],
  ['DECW', '$1234', [0x18, 0x73, 0x12, 0x34]],
  ['DECW', '5,X', [0x18, 0x63, 0x05]],
  ['CLRW', '$1234', [0x18, 0x79, 0x12, 0x34]],
  ['TSTW', '-$064,Y', [0x18, 0xe7, 0xe9, 0x9c]],
  ['ASLW', '$1234', [0x18, 0x78, 0x12, 0x34]],
  ['NEGX', '', [0x18, 0x40]],
  ['ASLY', '', [0x18, 0x58]],
  ['CLRX', '', [0x18, 0x87]],
  ['TSTY', '', [0x18, 0xd7]],
  ['PULCW', '', [0x18, 0x38]],
  ['PSHCW', '', [0x18, 0x39]],
  ['SYS', '', [0x18, 0xa7]],
  ['BTAS', '$12, #$34', [0x18, 0x35, 0x12, 0x34]],
  ['BTAS', '$1234, #$34', [0x18, 0x36, 0x12, 0x34, 0x34]],
  ['BTAS', '$64,Y, #$34', [0x18, 0x37, 0xe8, 0x64, 0x34]],
];

/** Re-render operands libasm-style: PC-relative indexed as absolute target, branches absolute. */
function libasmStyle(insn: DecodedInstruction): string {
  const one = (o: Operand): string => {
    switch (o.kind) {
      case 'idx':
        if (o.idx.reg === 'PC' && o.address !== undefined)
          return o.idx.indirect ? `[$${o.address.toString(16)},PC]` : `$${o.address.toString(16)},PC`;
        return formatIndexed(o.idx, { hex: '$' });
      case 'rel':
        return `$${o.target.toString(16)}`;
      default:
        return '';
    }
  };
  if (!insn.operands.some((o) => (o.kind === 'idx' && o.idx.reg === 'PC') || o.kind === 'rel')) return insn.operandsText;
  // Mixed: use operandsText pieces for non-special operands by re-decoding with '$' + absolute branches.
  const parts: string[] = [];
  for (const o of insn.operands) {
    const special = one(o);
    if (special) parts.push(special);
    else if (o.kind === 'imm' || o.kind === 'mask') parts.push(`#$${o.value.toString(16)}`);
    else if (o.kind === 'dir' || o.kind === 'ext') parts.push(`$${o.address.toString(16)}`);
    else if (o.kind === 'page') parts.push(`$${o.value.toString(16)}`);
    else if (o.kind === 'reg') parts.push(String(o.name));
  }
  return parts.join(',');
}

describe('libasm disassembler test vectors', () => {
  it(`has at least 60 vectors (${V.length})`, () => {
    expect(V.length).toBeGreaterThanOrEqual(60);
  });

  for (const [m, ops, bytes, addr = 0, cpu = 's12x'] of V) {
    it(`${cpu} ${m} ${ops} <- ${bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`, () => {
      const insn = decode((a) => bytes[(a - addr) & 0xffff] ?? 0, addr, { cpu, hex: '$', branchStyle: 'absolute' });
      expect(insn.mnemonic).toBe(m);
      expect(insn.length).toBe(bytes.length);
      expect(insn.illegal ?? false).toBe(false);
      expect(insn.invalidOperand ?? false).toBe(false);
      expect(normOperands(libasmStyle(insn))).toBe(normOperands(ops));
    });
  }

  it('CPU12 rejects S12X-only indexed move operands (flags invalidOperand)', () => {
    const bytes = [0x18, 0x08, 0xe1, 0x09];
    const insn = decode((a) => bytes[a] ?? 0, 0, { cpu: 'cpu12' });
    expect(insn.invalidOperand).toBe(true);
    const lea = [0x19, 0xe7];
    expect(decode((a) => lea[a] ?? 0, 0).invalidOperand).toBe(true); // LEAY [D,X]
    const tbl = [0x18, 0x3d, 0xe0, 0x00];
    expect(decode((a) => tbl[a] ?? 0, 0).invalidOperand).toBe(true); // TBL ,X (IDX1)
  });

  it('undefined loop-primitive operation codes decode as illegal', () => {
    const b = [0x04, 0xc0, 0x00];
    const insn = decode((a) => b[a] ?? 0, 0);
    expect(insn).toMatchObject({ mnemonic: '???', illegal: true, length: 3 });
    const r = [0x04, 0x02, 0x00]; // register code 010
    expect(decode((a) => r[a] ?? 0, 0).illegal).toBe(true);
  });

  it('reserved TMP2/TMP3 TFR/EXG/SEX postbytes flag invalidOperand (review finding 2; libasm ILLEGAL_REGISTER)', () => {
    const dec = (b: number[], cpu: Cpu = 's12x') => decode((a) => b[a] ?? 0, 0, { cpu, hex: '$' });
    for (const cpu of ['cpu12', 's12x'] as const) {
      for (let eb = 0; eb < 256; eb++) {
        const insn = dec([0xb7, eb], cpu);
        const s12xExt = cpu === 's12x' && eb & 0x08 && insn.operandsText.match(/CCRH|CCRW|XH|XL|YH|YL|SPH|SPL/);
        const reserved = !s12xExt && (((eb & 0x70) === 0x30) || (eb & 7) === 3);
        expect(insn.invalidOperand ?? false, `${cpu} ${eb.toString(16)} ${insn.mnemonic} ${insn.operandsText}`).toBe(reserved);
        expect(insn.length).toBe(2);
      }
    }
    expect(dec([0xb7, 0x03])).toMatchObject({ mnemonic: 'SEX', operandsText: 'A,TMP2', invalidOperand: true });
    expect(dec([0xb7, 0x30])).toMatchObject({ mnemonic: 'TFR', operandsText: 'TMP3,A', invalidOperand: true });
    expect(dec([0xb7, 0x83])).toMatchObject({ mnemonic: 'EXG', operandsText: 'A,TMP2', invalidOperand: true });
    expect(dec([0xb7, 0x01]).invalidOperand).toBeUndefined();
  });

  it('decoded instruction carries the TFR/EXG CCR override (review finding 3)', () => {
    const dec = (b: number[]) => decode((a) => b[a] ?? 0, 0, { hex: '$' });
    expect(dec([0xb7, 0x02]).ccr).toBe('WvWWWWWW'); // TAP
    expect(dec([0xb7, 0x20]).ccr).toBe('--------'); // TPA
    expect(dec([0xb7, 0xd2]).ccr).toBe('WvWWWWWW'); // EXG X,CCR
    expect(dec([0xb7, 0x4a]).ccr).toBe('WvWWWWWW'); // TFR D,CCRW
    expect(dec([0x86, 0x01]).ccr).toBe('----DD0-'); // LDAA: form.ccr
  });

  it("don't-care postbyte bits decode but are flagged nonCanonical (review finding 5)", () => {
    const dec = (b: number[], cpu: Cpu = 's12x') => decode((a) => b[a - 0x1000] ?? 0, 0x1000, { cpu, hex: '$', branchStyle: 'absolute' });
    expect(dec([0x04, 0x3d, 0xfd])).toMatchObject({ mnemonic: 'DBNE', operandsText: 'X,$1000', nonCanonical: true });
    expect(dec([0x04, 0x3d, 0xfd]).illegal).toBeUndefined();
    expect(dec([0x04, 0x35, 0xfd]).nonCanonical).toBeUndefined();
    expect(dec([0xb7, 0xdc])).toMatchObject({ mnemonic: 'EXG', operandsText: 'X,D', nonCanonical: true });
    expect(dec([0xb7, 0x4d]).nonCanonical).toBeUndefined(); // S12X SEX D,X
    expect(dec([0xb7, 0x4d], 'cpu12')).toMatchObject({ mnemonic: 'TFR', operandsText: 'D,X', nonCanonical: true });
  });
});
