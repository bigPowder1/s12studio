/**
 * Every instruction form of @s12/isa (CPU12X), every allowed indexed class: the simulator's cycle count
 * for one execution must equal the isa access-string count reported by the disassembler.
 */
import { describe, expect, it } from 'vitest';
import {
  IDX_CLASSES,
  OPCODE_FORMS,
  decode,
  encodeLoop,
  encodeTfrExg,
  formOnCpu,
  idxAllowed,
  idxSetFor,
  type IdxClass,
  type OpForm,
} from '@s12/isa';
import { CODE, mk, put, putW } from './helpers';

const RAMX = 0x2100;
const RAMY = 0x2180;
const IDX_BYTES: Record<IdxClass, number[]> = {
  IDX: [0x00], // 0,X
  IDX1: [0xe0, 0x10], // 16,X
  IDX2: [0xe2, 0x00, 0x10], // 16,X (16-bit)
  '[D,IDX]': [0xe7], // [D,X]
  '[IDX2]': [0xe3, 0x00, 0x10], // [16,X]
};

const DATA_DEPENDENT = new Set(['REV', 'REVW', 'WAV', 'WAVR']);

function operandBytes(f: OpForm, cls: IdxClass, cls2: IdxClass): number[] {
  const imm = f.size === 16 ? [0x00, 0x12] : [0x12];
  const x = IDX_BYTES[cls];
  switch (f.mode) {
    case 'INH':
    case 'TRAP':
      return [];
    case 'IMM8':
      return [0x12];
    case 'IMM16':
      return [0x00, 0x12];
    case 'DIR':
      return [0x40];
    case 'EXT':
      return [0x21, 0x40];
    case 'IDX':
      return x;
    case 'REL8':
      return [0x02];
    case 'REL16':
      return [0x00, 0x02];
    case 'LOOP':
      return encodeLoop(f.mnemonic, 'X', 2);
    case 'BIT_DIR':
      return [0x40, 0x01];
    case 'BIT_EXT':
      return [0x21, 0x40, 0x01];
    case 'BIT_IDX':
      return [...x, 0x01];
    case 'BRBIT_DIR':
      return [0x40, 0x01, 0x02];
    case 'BRBIT_EXT':
      return [0x21, 0x40, 0x01, 0x02];
    case 'BRBIT_IDX':
      return [...x, 0x01, 0x02];
    case 'MOV_IMM_IDX':
      return [...x, ...imm];
    case 'MOV_EXT_IDX':
      return [...x, 0x21, 0x40];
    case 'MOV_IDX_IDX':
      return [...x, ...IDX_BYTES[cls2]];
    case 'MOV_IMM_EXT':
      return [...imm, 0x21, 0x40];
    case 'MOV_EXT_EXT':
      return [0x21, 0x40, 0x21, 0x50];
    case 'MOV_IDX_EXT':
      return [...x, 0x21, 0x40];
    case 'TFR_EXG':
      return [f.mnemonic === 'SEX' ? 0x04 : encodeTfrExg(f.mnemonic, 'A', 'B')!];
    case 'CALL_EXT':
      return [0x80, 0x00, 0xe0];
    case 'CALL_IDX':
      return cls === '[D,IDX]' || cls === '[IDX2]' ? x : [...x, 0xe0];
  }
}

interface Case {
  name: string;
  bytes: number[];
}

function cases(): Case[] {
  const out: Case[] = [];
  for (const f of OPCODE_FORMS) {
    if (!formOnCpu(f, 's12x') || DATA_DEPENDENT.has(f.mnemonic)) continue;
    const head = f.prefix ? [0x18, f.opcode] : [f.opcode];
    const set = idxSetFor(f, 's12x');
    const idxMode = f.mode.includes('IDX');
    const classes = idxMode ? IDX_CLASSES.filter((c) => idxAllowed(set, c)) : (['IDX'] as IdxClass[]);
    for (const c of classes) {
      const dsts = f.mode === 'MOV_IDX_IDX' ? IDX_CLASSES.filter((d) => idxAllowed(set, d)) : (['IDX'] as IdxClass[]);
      for (const d of dsts) {
        const bytes = [...head, ...operandBytes(f, c, d)];
        out.push({ name: `${f.mnemonic} ${f.mode}${idxMode ? ` ${c}${f.mode === 'MOV_IDX_IDX' ? '->' + d : ''}` : ''} ${f.mode === 'TRAP' ? f.opcode.toString(16) : ''}`, bytes });
      }
    }
  }
  return out;
}

describe('cycle counts match @s12/isa access strings for every form', () => {
  const all = cases();
  it('covers a large number of forms', () => {
    expect(all.length).toBeGreaterThan(900);
  });
  it.each(all.map((c) => [c.name, c.bytes] as const))('%s', (_name, bytes) => {
    const s = mk();
    s.poke(0x11, 0x21); // DIRECT = $21: direct operands hit RAM at $21xx
    s.poke(0x10, 0x7f); // GPAGE = $7F: G-instruction operands hit flash
    put(s, CODE, bytes);
    putW(s, RAMX, 0x2200);
    putW(s, RAMX + 0x10, 0x2200);
    s.setRegisters({ x: RAMX, y: RAMY, d: 0, sp: 0x3f00, pc: CODE, ccr: 0, ipl: 0 });
    // RTI/PULCW frames: a harmless CCRW of 0 with the X bit clear.
    const insn = decode((a) => s.peek(a), CODE, { cpu: 's12x' });
    const c0 = s.cycles;
    const reason = s.step();
    expect(['step', 'bgnd']).toContain(reason);
    const got = s.cycles - c0;
    if (insn.cyclesNotTaken !== undefined) expect([insn.cycles, insn.cyclesNotTaken]).toContain(got);
    else expect(got).toBe(insn.cycles);
  });
});

describe('branch timing', () => {
  it('Bcc taken 3 / not taken 1, LBcc 4 / 3', () => {
    const t = (bytes: number[], ccr: number) => {
      const s = mk();
      put(s, CODE, bytes);
      s.setRegisters({ ccr });
      const c0 = s.cycles;
      s.step();
      return [s.cycles - c0, s.registers.pc];
    };
    expect(t([0x27, 0x10], 0x04)).toEqual([3, CODE + 0x12]); // BEQ taken
    expect(t([0x27, 0x10], 0x00)).toEqual([1, CODE + 2]);
    expect(t([0x18, 0x27, 0x01, 0x00], 0x04)).toEqual([4, CODE + 0x104]);
    expect(t([0x18, 0x27, 0x01, 0x00], 0x00)).toEqual([3, CODE + 4]);
    expect(t([0x21, 0x10], 0x00)).toEqual([1, CODE + 2]); // BRN
    expect(t([0x18, 0x21, 0x01, 0x00], 0x00)).toEqual([3, CODE + 4]); // LBRN
  });
});
