/**
 * CPU12 (HCS12) + CPU12X (HCS12X / S12XCPU, MC9S12XDP512) instruction-form table.
 *
 * One row per (mnemonic, addressing mode) form. Rows that share a (prefix, opcode) pair are allowed
 * only where a postbyte picks the form (loop primitives at $04, TFR/EXG/SEX at $B7); every other
 * (prefix, opcode) is unique per CPU. Indexed forms (IDX/IDX1/IDX2/[D,IDX]/[IDX2]) are one row: the
 * postbyte selects the variant, and `access` holds one access-detail string per variant.
 *
 * Sources: CPU12RM Rev 4.0 Appendix A / glossary (HCS12 column), docs/research/r1/isa.md,
 * docs/research/r2/s12x-isa.md (CPU12X deltas), libasm table_mc68hc12.cpp (Apache-2.0) for S12X
 * encodings. Access strings: one letter = one bus cycle; `(...)` is a microcode loop.
 *
 * `cpu: 'cpu12'` means the form exists on both CPU12 and CPU12X; `cpu: 's12x'` means CPU12X only.
 * `cpu12Only` marks the page-2 TRAP codes that became real instructions on the CPU12X.
 */
import type { IdxClass } from './postbyte.js';

export type Cpu = 'cpu12' | 's12x';

export type AddrMode =
  | 'INH'
  | 'IMM8'
  | 'IMM16'
  | 'DIR'
  | 'EXT'
  | 'IDX' // IDX / IDX1 / IDX2 / [D,IDX] / [IDX2], selected by the postbyte
  | 'REL8'
  | 'REL16'
  | 'LOOP' // DBEQ..IBNE: 04 lb rr
  | 'BIT_DIR' // BSET/BCLR/BTAS dd mm
  | 'BIT_EXT' // hh ll mm
  | 'BIT_IDX' // xb [ff|ee ff] mm
  | 'BRBIT_DIR' // BRSET/BRCLR dd mm rr
  | 'BRBIT_EXT' // hh ll mm rr
  | 'BRBIT_IDX' // xb [ff|ee ff] mm rr
  | 'MOV_IMM_IDX'
  | 'MOV_EXT_IDX'
  | 'MOV_IDX_IDX'
  | 'MOV_IMM_EXT'
  | 'MOV_EXT_EXT'
  | 'MOV_IDX_EXT'
  | 'TFR_EXG' // B7 eb (TFR, EXG, SEX)
  | 'TRAP' // 18 tn
  | 'CALL_EXT' // 4A hh ll pg
  | 'CALL_IDX'; // 4B xb [ff|ee ff] pg, or 4B xb [ee ff] for the indirect forms (no page byte)

/** Which indexed variants a form accepts. */
export type IdxSet =
  | 'all'
  | 'noIndirect' // IDX, IDX1, IDX2
  | 'short'; // single-postbyte forms only (5-bit, auto inc/dec, A/B/D,r) - CPU12 MOVB/MOVW, TBL/ETBL

/**
 * Access-detail strings. `base` for non-indexed forms (or the taken path of a branch).
 * `alt`: alternative path (RTI with another interrupt pending, STOP with S=1, WAI wake-up, or the
 * per-iteration loop of REV/REVW/WAV). `altWeighted`: REVW per-separator loop when C=1 (weighted).
 */
export type AccessKey = 'base' | 'notTaken' | 'alt' | 'altWeighted' | IdxClass;
export type Access = Partial<Record<AccessKey, string>>;

/**
 * Where `access` came from.
 * - HCS12: CPU12RM Rev 4.0 HCS12 column (used for CPU12X too unless a CPU12X string is known).
 * - HCS12X: S12XCPU RM access detail quoted in docs/research/r2/s12x-isa.md.
 * - HCS12X-derived: CPU12X string derived as "O" (prebyte) + the equivalent page-1 HCS12 string
 *   (the pattern the known HCS12X strings follow). UNCERTAIN.
 */
export type AccessSource = 'HCS12' | 'HCS12X' | 'HCS12X-derived';

export interface OpForm {
  /** Canonical CodeWarrior mnemonic (uppercase). */
  mnemonic: string;
  mode: AddrMode;
  prefix: 0 | 0x18;
  opcode: number;
  /** Operand byte layout after the opcode, CPU12RM notation (ii jj kk dd hh ll xb ff ee rr qq lb eb mm pg tn). */
  layout: string;
  cpu: Cpu;
  /** Page-2 TRAP code that is a real instruction on the CPU12X (only a TRAP on CPU12). */
  cpu12Only?: boolean;
  /** Shares its (prefix, opcode) with sibling forms; the postbyte decides which one. */
  postbyteSelects?: boolean;
  /** Indexed variants allowed on CPU12 (and on CPU12X unless `idxS12x` overrides). */
  idx?: IdxSet;
  idxS12x?: IdxSet;
  /** Data size in bits (immediate width / memory access width). */
  size?: 8 | 16 | 32;
  /** Access detail (HCS12 column unless `accessSource` says otherwise; used for CPU12X too unless `accessS12x`). */
  access: Access;
  accessSource: AccessSource;
  /** CPU12X-specific access detail, when it differs from `access` (exception entry/return...). */
  accessS12x?: Access;
  accessS12xSource?: AccessSource;
  /**
   * CCR effect, 8 characters in S X H I N Z V C order:
   *  '-' unchanged, '0' cleared, '1' set, 'D' set/cleared by the result, '?' undefined,
   *  'v' may be cleared (never set), '^' may be set (never cleared), 'W' written from a source operand.
   */
  ccr: string;
  note?: string;
}

// ---------------------------------------------------------------------------------------------
// Access-detail patterns (HCS12 column, CPU12RM Rev 4.0)

type IdxAccess = Record<IdxClass, string>;

const idxAcc = (a: string, b: string, c: string, d: string, e: string): IdxAccess => ({
  IDX: a,
  IDX1: b,
  IDX2: c,
  '[D,IDX]': d,
  '[IDX2]': e,
});

/** 8-bit read / ALU (LDAA, ADDA, CMPA, ...). */
const R8 = { IMM: 'P', DIR: 'rPf', EXT: 'rPO', IDX: idxAcc('rPf', 'rPO', 'frPP', 'fIfrPf', 'fIPrPf') };
/** 16-bit read / ALU (LDD, ADDD, CPX, ...). */
const R16 = { IMM: 'PO', DIR: 'RPf', EXT: 'RPO', IDX: idxAcc('RPf', 'RPO', 'fRPP', 'fIfRPf', 'fIPRPf') };
const ST8 = { DIR: 'Pw', EXT: 'PwO', IDX: idxAcc('Pw', 'PwO', 'PwP', 'PIfw', 'PIPw') };
const ST16 = { DIR: 'PW', EXT: 'PWO', IDX: idxAcc('PW', 'PWO', 'PWP', 'PIfW', 'PIPW') };
const RMW8 = { EXT: 'rPwO', IDX: idxAcc('rPw', 'rPwO', 'frPwP', 'fIfrPw', 'fIPrPw') };
const RMW16 = { EXT: 'RPWO', IDX: idxAcc('RPW', 'RPWO', 'fRPWP', 'fIfRPW', 'fIPRPW') };
const TST8 = { EXT: 'rPO', IDX: idxAcc('rPf', 'rPO', 'frPP', 'fIfrPf', 'fIPrPf') };
const TST16 = { EXT: 'RPO', IDX: idxAcc('RPf', 'RPO', 'fRPP', 'fIfRPf', 'fIPRPf') };
const JMP_A = { EXT: 'PPP', IDX: idxAcc('PPP', 'PPP', 'fPPP', 'fIfPPP', 'fIfPPP') };
const JSR_A = { DIR: 'SPPP', EXT: 'SPPP', IDX: idxAcc('PPPS', 'PPPS', 'fPPPS', 'fIfPPPS', 'fIfPPPS') };
const LEA_A = { IDX: idxAcc('Pf', 'PO', 'PP', '', '') };
const BIT_A = { DIR: 'rPwO', EXT: 'rPwP', IDX: idxAcc('rPwO', 'rPwP', 'frPwPO', '', '') };
const BRBIT_A = { DIR: 'rPPP', EXT: 'rfPPP', IDX: idxAcc('rPPP', 'rfPPP', 'PrfPPP', '', '') };
const CALL_A = { EXT: 'gnSsPPP', IDX: idxAcc('gnSsPPP', 'gnSsPPP', 'fgnSsPPP', 'fIignSsPPP', 'fIignSsPPP') };

/** Prepend the page-2 prebyte cycle to every string of an indexed access map. */
const pre = (s: string): string => (s ? 'O' + s : s);
const preIdx = (a: IdxAccess): IdxAccess => idxAcc(pre(a.IDX), pre(a.IDX1), pre(a.IDX2), pre(a['[D,IDX]']), pre(a['[IDX2]']));
const idxOnly = (a: IdxAccess, set: IdxSet): Access => {
  const out: Access = { IDX: a.IDX };
  if (set !== 'short') {
    out.IDX1 = a.IDX1;
    out.IDX2 = a.IDX2;
  }
  if (set === 'all') {
    out['[D,IDX]'] = a['[D,IDX]'];
    out['[IDX2]'] = a['[IDX2]'];
  }
  return out;
};

// ---------------------------------------------------------------------------------------------
// CCR effects

const CCR_NONE = '--------';
const CCR_NZV0 = '----DD0-'; // loads, stores, logic, BSET/BCLR
const CCR_NZVC = '----DDDD'; // subtract/compare/16-bit add, NEG, shifts
const CCR_HNZVC = '--D-DDDD'; // 8-bit add
const CCR_TST = '----DD00';
const CCR_CLR = '----0100';
const CCR_COM = '----DD01';
const CCR_INCDEC = '----DDD-';
const CCR_Z = '-----D--';
const CCR_WRITE = 'WvWWWWWW'; // CCR written from data (X can only be cleared)
const CCR_SETI = '---1----';

// ---------------------------------------------------------------------------------------------
// Table construction

const FORMS: OpForm[] = [];

interface AddOpts {
  cpu?: Cpu;
  idx?: IdxSet;
  idxS12x?: IdxSet;
  size?: 8 | 16 | 32;
  src?: AccessSource;
  note?: string;
  postbyteSelects?: boolean;
  cpu12Only?: boolean;
  /** CPU12X-specific access detail (see OpForm.accessS12x). */
  x?: Access;
  xsrc?: AccessSource;
}

function add(
  mnemonic: string,
  mode: AddrMode,
  prefix: 0 | 0x18,
  opcode: number,
  layout: string,
  access: Access,
  ccr: string,
  o: AddOpts = {},
): void {
  const f: OpForm = {
    mnemonic,
    mode,
    prefix,
    opcode,
    layout,
    cpu: o.cpu ?? 'cpu12',
    access,
    accessSource: o.src ?? (o.cpu === 's12x' ? 'HCS12X-derived' : 'HCS12'),
    ccr,
  };
  if (o.idx) f.idx = o.idx;
  if (o.idxS12x) f.idxS12x = o.idxS12x;
  if (o.size) f.size = o.size;
  if (o.note) f.note = o.note;
  if (o.postbyteSelects) f.postbyteSelects = true;
  if (o.cpu12Only) f.cpu12Only = true;
  if (o.x) {
    f.accessS12x = o.x;
    f.accessS12xSource = o.xsrc ?? 'HCS12X-derived';
  }
  FORMS.push(f);
}

const IDX_LAYOUT = 'xb [ff|ee ff]';

/** Add an indexed form with the access map restricted to the allowed variants. */
function addIdx(
  mnemonic: string,
  prefix: 0 | 0x18,
  opcode: number,
  acc: IdxAccess,
  ccr: string,
  o: AddOpts = {},
): void {
  const set = o.idx ?? 'all';
  add(mnemonic, 'IDX', prefix, opcode, IDX_LAYOUT, idxOnly(acc, set), ccr, { ...o, idx: set });
}

// ----- Page 1 -------------------------------------------------------------------------------

add('BGND', 'INH', 0, 0x00, '', { base: 'VfPPP' }, CCR_NONE, { note: 'enters BDM if enabled, else NOP' });
add('MEM', 'INH', 0, 0x01, '', { base: 'RRfOw' }, '--?-????', { note: 'fuzzy membership' });
add('INY', 'INH', 0, 0x02, '', { base: 'O' }, CCR_Z);
add('DEY', 'INH', 0, 0x03, '', { base: 'O' }, CCR_Z);
for (const [i, op] of ['DBEQ', 'DBNE', 'TBEQ', 'TBNE', 'IBEQ', 'IBNE'].entries()) {
  add(op, 'LOOP', 0, 0x04, 'lb rr', { base: 'PPP', notTaken: 'PPO' }, CCR_NONE, {
    postbyteSelects: true,
    note: `lb bits 7:5 = ${i.toString(2).padStart(3, '0')}`,
  });
}
addIdx('JMP', 0, 0x05, JMP_A.IDX, CCR_NONE);
add('JMP', 'EXT', 0, 0x06, 'hh ll', { base: JMP_A.EXT }, CCR_NONE);
add('BSR', 'REL8', 0, 0x07, 'rr', { base: 'SPPP' }, CCR_NONE);
add('INX', 'INH', 0, 0x08, '', { base: 'O' }, CCR_Z);
add('DEX', 'INH', 0, 0x09, '', { base: 'O' }, CCR_Z);
add('RTC', 'INH', 0, 0x0a, '', { base: 'uUnfPPP' }, CCR_NONE);
// HCS12: CPU12RM Rev 4.0 RTI glossary (uUUUUPPP; with another interrupt pending uUUUUfVfPPP = 11).
// CPU12X: base UUUUUPPP from s12x-isa.md section 6; the pending-interrupt string is UNCERTAIN.
add('RTI', 'INH', 0, 0x0b, '', { base: 'uUUUUPPP', alt: 'uUUUUfVfPPP' }, CCR_WRITE, {
  x: { base: 'UUUUUPPP', alt: 'UUUUUVfPPP' },
  xsrc: 'HCS12X',
  note: 'CPU12X pulls CCRW (2 bytes). alt = another interrupt pending (CPU12X alt UNCERTAIN)',
});
add('BSET', 'BIT_IDX', 0, 0x0c, 'xb [ff|ee ff] mm', idxOnly(BIT_A.IDX, 'noIndirect'), CCR_NZV0, { idx: 'noIndirect' });
add('BCLR', 'BIT_IDX', 0, 0x0d, 'xb [ff|ee ff] mm', idxOnly(BIT_A.IDX, 'noIndirect'), CCR_NZV0, { idx: 'noIndirect' });
add('BRSET', 'BRBIT_IDX', 0, 0x0e, 'xb [ff|ee ff] mm rr', idxOnly(BRBIT_A.IDX, 'noIndirect'), CCR_NONE, {
  idx: 'noIndirect',
});
add('BRCLR', 'BRBIT_IDX', 0, 0x0f, 'xb [ff|ee ff] mm rr', idxOnly(BRBIT_A.IDX, 'noIndirect'), CCR_NONE, {
  idx: 'noIndirect',
});

add('ANDCC', 'IMM8', 0, 0x10, 'ii', { base: 'P' }, 'vvvvvvvv', { size: 8 });
add('EDIV', 'INH', 0, 0x11, '', { base: 'ffffffffffO' }, CCR_NZVC);
add('MUL', 'INH', 0, 0x12, '', { base: 'O' }, '-------D');
add('EMUL', 'INH', 0, 0x13, '', { base: 'ffO' }, '----DD-D');
add('ORCC', 'IMM8', 0, 0x14, 'ii', { base: 'P' }, '^-^^^^^^', { size: 8 });
addIdx('JSR', 0, 0x15, JSR_A.IDX, CCR_NONE);
add('JSR', 'EXT', 0, 0x16, 'hh ll', { base: JSR_A.EXT }, CCR_NONE);
add('JSR', 'DIR', 0, 0x17, 'dd', { base: JSR_A.DIR }, CCR_NONE);
addIdx('LEAY', 0, 0x19, LEA_A.IDX, CCR_NONE, { idx: 'noIndirect' });
addIdx('LEAX', 0, 0x1a, LEA_A.IDX, CCR_NONE, { idx: 'noIndirect' });
addIdx('LEAS', 0, 0x1b, LEA_A.IDX, CCR_NONE, { idx: 'noIndirect' });
add('BSET', 'BIT_EXT', 0, 0x1c, 'hh ll mm', { base: BIT_A.EXT }, CCR_NZV0);
add('BCLR', 'BIT_EXT', 0, 0x1d, 'hh ll mm', { base: BIT_A.EXT }, CCR_NZV0);
add('BRSET', 'BRBIT_EXT', 0, 0x1e, 'hh ll mm rr', { base: BRBIT_A.EXT }, CCR_NONE);
add('BRCLR', 'BRBIT_EXT', 0, 0x1f, 'hh ll mm rr', { base: BRBIT_A.EXT }, CCR_NONE);

export const BRANCH_NAMES = [
  'BRA', 'BRN', 'BHI', 'BLS', 'BCC', 'BCS', 'BNE', 'BEQ',
  'BVC', 'BVS', 'BPL', 'BMI', 'BGE', 'BLT', 'BGT', 'BLE',
] as const;
for (const [i, b] of BRANCH_NAMES.entries()) {
  const access: Access = b === 'BRA' ? { base: 'PPP' } : b === 'BRN' ? { base: 'P' } : { base: 'PPP', notTaken: 'P' };
  add(b, 'REL8', 0, 0x20 + i, 'rr', access, CCR_NONE);
}

const STACK_OPS: Array<[string, number, string, string]> = [
  ['PULX', 0x30, 'UfO', CCR_NONE],
  ['PULY', 0x31, 'UfO', CCR_NONE],
  ['PULA', 0x32, 'ufO', CCR_NONE],
  ['PULB', 0x33, 'ufO', CCR_NONE],
  ['PSHX', 0x34, 'OS', CCR_NONE],
  ['PSHY', 0x35, 'OS', CCR_NONE],
  ['PSHA', 0x36, 'Os', CCR_NONE],
  ['PSHB', 0x37, 'Os', CCR_NONE],
  ['PULC', 0x38, 'ufO', CCR_WRITE],
  ['PSHC', 0x39, 'Os', CCR_NONE],
  ['PULD', 0x3a, 'UfO', CCR_NONE],
  ['PSHD', 0x3b, 'OS', CCR_NONE],
];
for (const [m, op, acc, ccr] of STACK_OPS) add(m, 'INH', 0, op, '', { base: acc }, ccr);
// UNCERTAIN: WAVR access detail (re-entry pulls the WAV temporaries, then resumes the loop).
add('WAVR', 'INH', 0, 0x3c, '', { base: 'UUUrr', alt: 'ffff(frr,ffff)O' }, '--?-?1??', {
  note: 'WAV resume after interrupt; base = re-entry, alt = loop (UNCERTAIN)',
});
add('RTS', 'INH', 0, 0x3d, '', { base: 'UfPPP' }, CCR_NONE);
// UNCERTAIN: CPU12X WAI stacks CCRW (word) instead of CCR (byte): 'OSSSSsf' -> 'OSSSSSf' (derived).
add('WAI', 'INH', 0, 0x3e, '', { base: 'OSSSSsf', alt: 'fVfPPP' }, CCR_NONE, {
  x: { base: 'OSSSSSf', alt: 'fVfPPP' },
  note: 'base = stacking, alt = exit on interrupt',
});
// UNCERTAIN: CPU12X SWI access string (10-byte frame, CCRW stacked as a word) derived, not transcribed.
add('SWI', 'INH', 0, 0x3f, '', { base: 'VSPSSPSsP' }, CCR_SETI, {
  x: { base: 'VSPSSPSSP' },
  note: 'CPU12X 10-byte frame',
});

const RMW_NAMES = ['NEG', 'COM', 'INC', 'DEC', 'LSR', 'ROL', 'ROR', 'ASR', 'ASL'] as const;
const RMW_CCR: Record<string, string> = {
  NEG: CCR_NZVC,
  COM: CCR_COM,
  INC: CCR_INCDEC,
  DEC: CCR_INCDEC,
  LSR: '----0DDD',
  ROL: CCR_NZVC,
  ROR: CCR_NZVC,
  ASR: CCR_NZVC,
  ASL: CCR_NZVC,
};
for (const [i, n] of RMW_NAMES.entries()) {
  add(n + 'A', 'INH', 0, 0x40 + i, '', { base: 'O' }, RMW_CCR[n]);
  add(n + 'B', 'INH', 0, 0x50 + i, '', { base: 'O' }, RMW_CCR[n]);
  addIdx(n, 0, 0x60 + i, RMW8.IDX, RMW_CCR[n], { size: 8 });
  add(n, 'EXT', 0, 0x70 + i, 'hh ll', { base: RMW8.EXT }, RMW_CCR[n], { size: 8 });
}
add('LSRD', 'INH', 0, 0x49, '', { base: 'O' }, '----0DDD');
add('CALL', 'CALL_EXT', 0, 0x4a, 'hh ll pg', { base: CALL_A.EXT }, CCR_NONE);
add('CALL', 'CALL_IDX', 0, 0x4b, 'xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg)', { ...CALL_A.IDX }, CCR_NONE, {
  idx: 'all',
});
add('BSET', 'BIT_DIR', 0, 0x4c, 'dd mm', { base: BIT_A.DIR }, CCR_NZV0);
add('BCLR', 'BIT_DIR', 0, 0x4d, 'dd mm', { base: BIT_A.DIR }, CCR_NZV0);
add('BRSET', 'BRBIT_DIR', 0, 0x4e, 'dd mm rr', { base: BRBIT_A.DIR }, CCR_NONE);
add('BRCLR', 'BRBIT_DIR', 0, 0x4f, 'dd mm rr', { base: BRBIT_A.DIR }, CCR_NONE);
add('ASLD', 'INH', 0, 0x59, '', { base: 'O' }, CCR_NZVC);

const STORES: Array<[string, number, 8 | 16]> = [
  ['STAA', 0xa, 8],
  ['STAB', 0xb, 8],
  ['STD', 0xc, 16],
  ['STY', 0xd, 16],
  ['STX', 0xe, 16],
  ['STS', 0xf, 16],
];
for (const [n, lo, size] of STORES) {
  const a = size === 8 ? ST8 : ST16;
  add(n, 'DIR', 0, 0x50 + lo, 'dd', { base: a.DIR }, CCR_NZV0, { size });
  addIdx(n, 0, 0x60 + lo, a.IDX, CCR_NZV0, { size });
  add(n, 'EXT', 0, 0x70 + lo, 'hh ll', { base: a.EXT }, CCR_NZV0, { size });
}
addIdx('CLR', 0, 0x69, ST8.IDX, CCR_CLR, { size: 8 });
add('CLR', 'EXT', 0, 0x79, 'hh ll', { base: ST8.EXT }, CCR_CLR, { size: 8 });

const ALU_CCR = (n: string): string => {
  if (/^(ADD|ADC)[AB]$/.test(n)) return CCR_HNZVC;
  if (/^(AND|BIT|LD|EOR|OR)/.test(n)) return CCR_NZV0;
  return CCR_NZVC;
};
const A_SIDE = ['SUBA', 'CMPA', 'SBCA', 'SUBD', 'ANDA', 'BITA', 'LDAA', '', 'EORA', 'ADCA', 'ORAA', 'ADDA', 'CPD', 'CPY', 'CPX', 'CPS'];
const B_SIDE = ['SUBB', 'CMPB', 'SBCB', 'ADDD', 'ANDB', 'BITB', 'LDAB', '', 'EORB', 'ADCB', 'ORAB', 'ADDB', 'LDD', 'LDY', 'LDX', 'LDS'];
const WIDE = new Set(['SUBD', 'ADDD', 'CPD', 'CPY', 'CPX', 'CPS', 'LDD', 'LDY', 'LDX', 'LDS']);

/** Generic IMM/DIR/IDX/EXT row group starting at `base` (IMM), +$10 DIR, +$20 IDX, +$30 EXT. */
function aluGroup(n: string, prefix: 0 | 0x18, base: number, wide: boolean, ccr: string, o: AddOpts = {}): void {
  const a = wide ? R16 : R8;
  const p = prefix === 0x18 ? pre : (s: string) => s;
  const size = wide ? 16 : 8;
  add(n, wide ? 'IMM16' : 'IMM8', prefix, base, wide ? 'jj kk' : 'ii', { base: p(a.IMM) }, ccr, { ...o, size });
  add(n, 'DIR', prefix, base + 0x10, 'dd', { base: p(a.DIR) }, ccr, { ...o, size });
  addIdx(n, prefix, base + 0x20, prefix === 0x18 ? preIdx(a.IDX) : a.IDX, ccr, { ...o, size });
  add(n, 'EXT', prefix, base + 0x30, 'hh ll', { base: p(a.EXT) }, ccr, { ...o, size });
}
for (const [side, base] of [
  [A_SIDE, 0x80],
  [B_SIDE, 0xc0],
] as const) {
  for (const [i, n] of side.entries()) if (n) aluGroup(n, 0, base + i, WIDE.has(n), ALU_CCR(n));
}
add('CLRA', 'INH', 0, 0x87, '', { base: 'O' }, CCR_CLR);
add('TSTA', 'INH', 0, 0x97, '', { base: 'O' }, CCR_TST);
add('NOP', 'INH', 0, 0xa7, '', { base: 'O' }, CCR_NONE);
for (const m of ['TFR', 'EXG', 'SEX']) {
  add(m, 'TFR_EXG', 0, 0xb7, 'eb', { base: 'P' }, CCR_NONE, {
    postbyteSelects: true,
    note: 'CCR changes only when the destination is CCR/CCRH/CCRW (X can only be cleared)',
  });
}
add('CLRB', 'INH', 0, 0xc7, '', { base: 'O' }, CCR_CLR);
add('TSTB', 'INH', 0, 0xd7, '', { base: 'O' }, CCR_TST);
addIdx('TST', 0, 0xe7, TST8.IDX, CCR_TST, { size: 8 });
add('TST', 'EXT', 0, 0xf7, 'hh ll', { base: TST8.EXT }, CCR_TST, { size: 8 });

// ----- Page 2 ($18 xx), CPU12 -----------------------------------------------------------------

const MOVES: Array<[number, AddrMode, string, string]> = [
  // [opcode low, mode, layout, HCS12 access]
  [0x0, 'MOV_IMM_IDX', 'xb jj kk', 'OPPW'],
  [0x1, 'MOV_EXT_IDX', 'xb hh ll', 'OPRPW'],
  [0x2, 'MOV_IDX_IDX', 'xb xb', 'ORPWO'],
  [0x3, 'MOV_IMM_EXT', 'jj kk hh ll', 'OPWPO'],
  [0x4, 'MOV_EXT_EXT', 'hh ll hh ll', 'ORPWPO'],
  [0x5, 'MOV_IDX_EXT', 'xb hh ll', 'ORPWP'],
];
const MOVB_ACC = ['OPwO', 'OPrPw', 'OrPwO', 'OPwP', 'OrPwPO', 'OrPwP'];
for (const [lo, mode, layout, accW] of MOVES) {
  const hasIdx = mode.includes('IDX');
  const o: AddOpts = hasIdx ? { idx: 'short', idxS12x: 'all' } : {};
  const note = hasIdx
    ? 'CPU12X: indexed operands may use IDX1/IDX2/[D,IDX]/[IDX2] (extension bytes follow their postbyte). Destination postbyte precedes an IMM/EXT source.'
    : undefined;
  add('MOVW', mode, 0x18, lo, layout, { base: accW }, CCR_NONE, { ...o, size: 16, note });
  add('MOVB', mode, 0x18, lo + 8, layout.replace('jj kk', 'ii'), { base: MOVB_ACC[lo] }, CCR_NONE, {
    ...o,
    size: 8,
    note,
  });
}
add('ABA', 'INH', 0x18, 0x06, '', { base: 'OO' }, CCR_HNZVC);
add('DAA', 'INH', 0x18, 0x07, '', { base: 'OfO' }, '----DD?D');
add('TAB', 'INH', 0x18, 0x0e, '', { base: 'OO' }, CCR_NZV0);
add('TBA', 'INH', 0x18, 0x0f, '', { base: 'OO' }, CCR_NZV0);
add('IDIV', 'INH', 0x18, 0x10, '', { base: 'OffffffffffO' }, '-----D0D');
add('FDIV', 'INH', 0x18, 0x11, '', { base: 'OffffffffffO' }, '-----DDD');
add('EMACS', 'EXT', 0x18, 0x12, 'hh ll', { base: 'ORROfffRRfWWP' }, CCR_NZVC, { size: 32 });
add('EMULS', 'INH', 0x18, 0x13, '', { base: 'OfO' }, '----DD-D');
add('EDIVS', 'INH', 0x18, 0x14, '', { base: 'OffffffffffO' }, CCR_NZVC);
add('IDIVS', 'INH', 0x18, 0x15, '', { base: 'OffffffffffO' }, CCR_NZVC);
add('SBA', 'INH', 0x18, 0x16, '', { base: 'OO' }, CCR_NZVC);
add('CBA', 'INH', 0x18, 0x17, '', { base: 'OO' }, CCR_NZVC);
const MINMAX: Array<[string, IdxAccess, number]> = [
  ['MAXA', preIdx(R8.IDX), 8],
  ['MINA', preIdx(R8.IDX), 8],
  ['EMAXD', preIdx(R16.IDX), 16],
  ['EMIND', preIdx(R16.IDX), 16],
  ['MAXM', preIdx(RMW8.IDX), 8],
  ['MINM', preIdx(RMW8.IDX), 8],
  ['EMAXM', preIdx(RMW16.IDX), 16],
  ['EMINM', preIdx(RMW16.IDX), 16],
];
for (const [i, [n, acc, size]] of MINMAX.entries()) {
  addIdx(n, 0x18, 0x18 + i, acc, CCR_NZVC, { size: size as 8 | 16 });
}
for (const [i, b] of BRANCH_NAMES.entries()) {
  const n = 'L' + b;
  const access: Access =
    b === 'BRA' ? { base: 'OPPP' } : b === 'BRN' ? { base: 'OPO' } : { base: 'OPPP', notTaken: 'OPO' };
  add(n, 'REL16', 0x18, 0x20 + i, 'qq rr', access, CCR_NONE);
}
add('REV', 'INH', 0x18, 0x3a, '', { base: 'OrfO', alt: '(t,tx)' }, '--?-??1?', {
  note: 'base = fixed part, alt = per-element loop (Orf(t,tx)O)',
});
// CPU12RM Rev 4.0 REVW: 'ORf(t,Tx)O' plus '(r,RfRf)' (loop to read weight if enabled); footnote:
// "The 3-cycle loop in parentheses expands to five cycles for separators when weighting is enabled."
add('REVW', 'INH', 0x18, 0x3b, '', { base: 'ORfO', alt: '(t,Tx)', altWeighted: '(r,RfRf)' }, '--?-??1D', {
  note: 'base = fixed part, alt = per-element loop (ORf(t,Tx)O); altWeighted = per-separator loop when C=1',
});
add('WAV', 'INH', 0x18, 0x3c, '', { base: 'OfO', alt: '(frr,ffff)' }, '--?-?1??', {
  note: 'base = fixed part, alt = per-iteration loop (B times): Of(frr,ffff)O',
});
addIdx('TBL', 0x18, 0x3d, idxAcc('ORfffP', '', '', '', ''), '----DD-D', { idx: 'short', size: 8 });
// UNCERTAIN: CPU12X STOP stacks CCRW as a word: 'OOSSSSsf' -> 'OOSSSSSf' (derived).
add('STOP', 'INH', 0x18, 0x3e, '', { base: 'OOSSSSsf', alt: 'OO' }, CCR_NONE, {
  x: { base: 'OOSSSSSf', alt: 'OO' },
  note: 'alt = STOP disabled (S=1) acts as a 2-cycle NOP; exit fVfPPP',
});
addIdx('ETBL', 0x18, 0x3f, idxAcc('ORRffffffP', '', '', '', ''), '----DD-D', { idx: 'short', size: 16 });

// ----- Page 2, CPU12X additions -----------------------------------------------------------------

const X: AddOpts = { cpu: 's12x' };
const XK: AddOpts = { cpu: 's12x', src: 'HCS12X' };

// UNCERTAIN: every CPU12X-only access string below is 'O' + the page-1 HCS12 equivalent
// (accessSource 'HCS12X-derived') except ADDX, DECW and GLDAA, which s12x-isa.md quotes from the RM.
add('BTAS', 'BIT_DIR', 0x18, 0x35, 'dd mm', { base: pre(BIT_A.DIR) }, CCR_NZV0, {
  ...X,
  note: 'atomic bit test and set; CCR effect UNCERTAIN',
});
add('BTAS', 'BIT_EXT', 0x18, 0x36, 'hh ll mm', { base: pre(BIT_A.EXT) }, CCR_NZV0, X);
add('BTAS', 'BIT_IDX', 0x18, 0x37, 'xb [ff|ee ff] mm', idxOnly(preIdx(BIT_A.IDX), 'noIndirect'), CCR_NZV0, {
  ...X,
  idx: 'noIndirect',
});
add('PULCW', 'INH', 0x18, 0x38, '', { base: 'OUfO' }, CCR_WRITE, { ...X, note: 'pulls CCRW incl. IPL' });
add('PSHCW', 'INH', 0x18, 0x39, '', { base: 'OOS' }, CCR_NONE, X);
for (const [i, n] of RMW_NAMES.entries()) {
  const ccr = RMW_CCR[n];
  add(n + 'X', 'INH', 0x18, 0x40 + i, '', { base: 'OO' }, ccr, X);
  add(n + 'Y', 'INH', 0x18, 0x50 + i, '', { base: 'OO' }, ccr, X);
  const k = n === 'DEC' ? XK : X;
  addIdx(n + 'W', 0x18, 0x60 + i, preIdx(RMW16.IDX), ccr, { ...k, size: 16 });
  add(n + 'W', 'EXT', 0x18, 0x70 + i, 'hh ll', { base: pre(RMW16.EXT) }, ccr, { ...k, size: 16 });
}
addIdx('CLRW', 0x18, 0x69, preIdx(ST16.IDX), CCR_CLR, { ...X, size: 16 });
add('CLRW', 'EXT', 0x18, 0x79, 'hh ll', { base: pre(ST16.EXT) }, CCR_CLR, { ...X, size: 16 });
add('CLRX', 'INH', 0x18, 0x87, '', { base: 'OO' }, CCR_CLR, X);
add('CLRY', 'INH', 0x18, 0xc7, '', { base: 'OO' }, CCR_CLR, X);
add('TSTX', 'INH', 0x18, 0x97, '', { base: 'OO' }, CCR_TST, X);
add('TSTY', 'INH', 0x18, 0xd7, '', { base: 'OO' }, CCR_TST, X);
addIdx('TSTW', 0x18, 0xe7, preIdx(TST16.IDX), CCR_TST, { ...X, size: 16 });
add('TSTW', 'EXT', 0x18, 0xf7, 'hh ll', { base: pre(TST16.EXT) }, CCR_TST, { ...X, size: 16 });
// UNCERTAIN: SYS vector (IVBR:$12) and cycle count.
add('SYS', 'INH', 0x18, 0xa7, '', { base: 'OVSPSSPSSP' }, CCR_SETI, {
  ...X,
  note: 'vectors through IVBR:$12 (UNCERTAIN); access assumed equal to TRAP',
});

// 16-bit X/Y/D arithmetic (all IMM16/DIR/IDX/EXT groups)
const X_ALU: Array<[string, number, string]> = [
  ['SUBX', 0x80, CCR_NZVC],
  ['SBEX', 0x82, CCR_NZVC],
  ['SBED', 0x83, CCR_NZVC],
  ['ANDX', 0x84, CCR_NZV0],
  ['BITX', 0x85, CCR_NZV0],
  ['EORX', 0x88, CCR_NZV0],
  ['ADEX', 0x89, CCR_NZVC],
  ['ORX', 0x8a, CCR_NZV0],
  ['ADDX', 0x8b, CCR_NZVC],
  ['CPED', 0x8c, CCR_NZVC],
  ['CPEY', 0x8d, CCR_NZVC],
  ['CPEX', 0x8e, CCR_NZVC],
  ['CPES', 0x8f, CCR_NZVC],
  ['SUBY', 0xc0, CCR_NZVC],
  ['SBEY', 0xc2, CCR_NZVC],
  ['ADED', 0xc3, CCR_NZVC],
  ['ANDY', 0xc4, CCR_NZV0],
  ['BITY', 0xc5, CCR_NZV0],
  ['EORY', 0xc8, CCR_NZV0],
  ['ADEY', 0xc9, CCR_NZVC],
  ['ORY', 0xca, CCR_NZV0],
  ['ADDY', 0xcb, CCR_NZVC],
];
for (const [n, op, ccr] of X_ALU) {
  aluGroup(n, 0x18, op, true, ccr, n === 'ADDX' ? XK : X);
}

// Global (GPAGE) loads and stores: DIR/IDX/EXT only
const GLOADS: Array<[string, number, boolean]> = [
  ['GLDAA', 0x96, false],
  ['GLDAB', 0xd6, false],
  ['GLDD', 0xdc, true],
  ['GLDY', 0xdd, true],
  ['GLDX', 0xde, true],
  ['GLDS', 0xdf, true],
];
for (const [n, op, wide] of GLOADS) {
  const a = wide ? R16 : R8;
  const o = n === 'GLDAA' ? XK : X;
  const size = wide ? 16 : 8;
  add(n, 'DIR', 0x18, op, 'dd', { base: pre(a.DIR) }, CCR_NZV0, { ...o, size });
  addIdx(n, 0x18, op + 0x10, preIdx(a.IDX), CCR_NZV0, { ...o, size });
  add(n, 'EXT', 0x18, op + 0x20, 'hh ll', { base: pre(a.EXT) }, CCR_NZV0, { ...o, size });
}
const GSTORES: Array<[string, number, boolean]> = [
  ['GSTAA', 0x5a, false],
  ['GSTAB', 0x5b, false],
  ['GSTD', 0x5c, true],
  ['GSTY', 0x5d, true],
  ['GSTX', 0x5e, true],
  ['GSTS', 0x5f, true],
];
for (const [n, op, wide] of GSTORES) {
  const a = wide ? ST16 : ST8;
  const size = wide ? 16 : 8;
  add(n, 'DIR', 0x18, op, 'dd', { base: pre(a.DIR) }, CCR_NZV0, { ...X, size });
  addIdx(n, 0x18, op + 0x10, preIdx(a.IDX), CCR_NZV0, { ...X, size });
  add(n, 'EXT', 0x18, op + 0x20, 'hh ll', { base: pre(a.EXT) }, CCR_NZV0, {
    ...X,
    size,
    note: n === 'GSTS' ? 'binutils wrongly lists GSTS ext as $6F; correct is $18 $7F' : undefined,
  });
}

// ----- TRAP codes ---------------------------------------------------------------------------------

// UNCERTAIN: the CPU12X trap set is the complement of the defined page-2 opcodes (matches libasm and
// s12x-isa.md); not yet checked against the S12XCPU RM opcode map.
const s12xPage2 = new Set(FORMS.filter((f) => f.prefix === 0x18 && f.cpu === 's12x').map((f) => f.opcode));
for (let op = 0x30; op <= 0xff; op++) {
  if (op >= 0x3a && op <= 0x3f) continue;
  add('TRAP', 'TRAP', 0x18, op, '', { base: 'OVSPSSPSsP' }, CCR_SETI, {
    x: { base: 'OVSPSSPSSP' },
    xsrc: 'HCS12X',
    cpu12Only: s12xPage2.has(op),
    note: 'unimplemented-opcode trap via vector $FFF8 (CPU12X: IVBR:$F8)',
  });
}

// Make the `note: undefined` artefacts disappear so rows compare cleanly.
for (const f of FORMS) if (f.note === undefined) delete f.note;

/** Every instruction form, both CPUs. Read-only. */
export const OPCODE_FORMS: readonly OpForm[] = FORMS;

// ---------------------------------------------------------------------------------------------
// Lookup

/**
 * The access-detail map that applies to `form` on `cpu`: the CPU12X-specific map when one exists
 * and `cpu` is 's12x', else `form.access`.
 */
export function accessFor(form: OpForm, cpu: Cpu = 's12x'): Access {
  return cpu === 's12x' && form.accessS12x ? form.accessS12x : form.access;
}

/** Source tag of `accessFor(form, cpu)`. */
export function accessSourceFor(form: OpForm, cpu: Cpu = 's12x'): AccessSource {
  return cpu === 's12x' && form.accessS12x ? (form.accessS12xSource ?? 'HCS12X-derived') : form.accessSource;
}

/** True when `form` exists on `cpu`. */
export function formOnCpu(form: OpForm, cpu: Cpu): boolean {
  if (cpu === 'cpu12') return form.cpu === 'cpu12';
  return !form.cpu12Only;
}

function buildPage(cpu: Cpu, prefix: 0 | 0x18): OpForm[][] {
  const page: OpForm[][] = Array.from({ length: 256 }, () => []);
  for (const f of FORMS) if (f.prefix === prefix && formOnCpu(f, cpu)) page[f.opcode].push(f);
  return page;
}

const PAGES: Record<Cpu, Record<0 | 0x18, OpForm[][]>> = {
  cpu12: { 0: buildPage('cpu12', 0), 0x18: buildPage('cpu12', 0x18) },
  s12x: { 0: buildPage('s12x', 0), 0x18: buildPage('s12x', 0x18) },
};

/** The page-2 prebyte. */
export const PAGE2_PREFIX = 0x18;

/**
 * All forms at (prefix, opcode) on `cpu`. More than one only for postbyte-selected rows
 * ($04 loop primitives, $B7 TFR/EXG/SEX). Empty for page-1 $18 (the prebyte itself).
 */
export function formsAt(cpu: Cpu, prefix: 0 | 0x18, opcode: number): readonly OpForm[] {
  return PAGES[cpu][prefix][opcode & 0xff];
}

/** All forms of a mnemonic (canonical name, case-insensitive) on `cpu`. Aliases are not resolved. */
export function formsByMnemonic(mnemonic: string, cpu: Cpu = 's12x'): OpForm[] {
  const m = mnemonic.toUpperCase();
  return FORMS.filter((f) => f.mnemonic === m && formOnCpu(f, cpu));
}

/** Indexed variants allowed for a form on `cpu`. */
export function idxSetFor(form: OpForm, cpu: Cpu): IdxSet | undefined {
  return cpu === 's12x' ? (form.idxS12x ?? form.idx) : form.idx;
}

/** Whether an indexed class is allowed by an IdxSet. */
export function idxAllowed(set: IdxSet | undefined, cls: IdxClass): boolean {
  if (!set) return false;
  if (set === 'all') return true;
  if (set === 'noIndirect') return cls === 'IDX' || cls === 'IDX1' || cls === 'IDX2';
  return cls === 'IDX';
}

// ---------------------------------------------------------------------------------------------
// CCR effect helpers

export type CcrFlag = 'S' | 'X' | 'H' | 'I' | 'N' | 'Z' | 'V' | 'C';
export type CcrAction = 'unchanged' | 'cleared' | 'set' | 'changed' | 'undefined' | 'clearOnly' | 'setOnly' | 'written';
const CCR_FLAGS: CcrFlag[] = ['S', 'X', 'H', 'I', 'N', 'Z', 'V', 'C'];
const CCR_ACTIONS: Record<string, CcrAction> = {
  '-': 'unchanged',
  '0': 'cleared',
  '1': 'set',
  D: 'changed',
  '?': 'undefined',
  v: 'clearOnly',
  '^': 'setOnly',
  W: 'written',
};

/** Expand a form's 8-character CCR string into per-flag actions. */
export function ccrEffect(form: Pick<OpForm, 'ccr'>): Record<CcrFlag, CcrAction> {
  const out = {} as Record<CcrFlag, CcrAction>;
  CCR_FLAGS.forEach((f, i) => {
    out[f] = CCR_ACTIONS[form.ccr[i]] ?? 'undefined';
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Aliases

export interface Alias {
  /** Alternate mnemonic the assembler accepts. */
  alias: string;
  /** Canonical mnemonic the disassembler prints. */
  canonical: string;
  /** Fixed operand text of the canonical form, if the alias has no operands of its own. */
  operands?: string;
  /** Fixed encoding, for aliases without operands. */
  bytes?: number[];
  cpu: Cpu;
}

const A = (alias: string, canonical: string, operands?: string, bytes?: number[], cpu: Cpu = 'cpu12'): Alias => {
  const a: Alias = { alias, canonical, cpu };
  if (operands !== undefined) a.operands = operands;
  if (bytes) a.bytes = bytes;
  return a;
};

/** Assembler aliases. The disassembler prints `canonical` (CodeWarrior-style canonical names). */
// UNCERTAIN: whether hiwave prints the alias (CLI, TSX, INS, ...) or the canonical form for these
// encodings; decode() prints the canonical form unless DecodeOptions.aliases is set.
export const ALIASES: readonly Alias[] = [
  A('LSL', 'ASL'),
  A('LSLA', 'ASLA', undefined, [0x48]),
  A('LSLB', 'ASLB', undefined, [0x58]),
  A('LSLD', 'ASLD', undefined, [0x59]),
  A('LSLW', 'ASLW', undefined, undefined, 's12x'),
  A('LSLX', 'ASLX', undefined, [0x18, 0x48], 's12x'),
  A('LSLY', 'ASLY', undefined, [0x18, 0x58], 's12x'),
  A('BHS', 'BCC'),
  A('BLO', 'BCS'),
  A('LBHS', 'LBCC'),
  A('LBLO', 'LBCS'),
  A('CLC', 'ANDCC', '#$FE', [0x10, 0xfe]),
  A('CLI', 'ANDCC', '#$EF', [0x10, 0xef]),
  A('CLV', 'ANDCC', '#$FD', [0x10, 0xfd]),
  A('SEC', 'ORCC', '#$01', [0x14, 0x01]),
  A('SEI', 'ORCC', '#$10', [0x14, 0x10]),
  A('SEV', 'ORCC', '#$02', [0x14, 0x02]),
  A('TAP', 'TFR', 'A,CCR', [0xb7, 0x02]),
  A('TPA', 'TFR', 'CCR,A', [0xb7, 0x20]),
  A('TSX', 'TFR', 'SP,X', [0xb7, 0x75]),
  A('TSY', 'TFR', 'SP,Y', [0xb7, 0x76]),
  A('TXS', 'TFR', 'X,SP', [0xb7, 0x57]),
  A('TYS', 'TFR', 'Y,SP', [0xb7, 0x67]),
  A('XGDX', 'EXG', 'D,X', [0xb7, 0xc5]),
  A('XGDY', 'EXG', 'D,Y', [0xb7, 0xc6]),
  A('INS', 'LEAS', '1,SP', [0x1b, 0x81]),
  A('DES', 'LEAS', '-1,SP', [0x1b, 0x9f]),
  A('ABX', 'LEAX', 'B,X', [0x1a, 0xe5]),
  A('ABY', 'LEAY', 'B,Y', [0x19, 0xed]),
];

const ALIAS_MAP = new Map(ALIASES.map((a) => [a.alias, a]));

/** Resolve an alias mnemonic (case-insensitive). Returns undefined for non-aliases. */
export function resolveAlias(mnemonic: string): Alias | undefined {
  return ALIAS_MAP.get(mnemonic.toUpperCase());
}

/** Canonical mnemonic for a (possibly alias) mnemonic, uppercase. */
export function canonicalMnemonic(mnemonic: string): string {
  const m = mnemonic.toUpperCase();
  return ALIAS_MAP.get(m)?.canonical ?? m;
}

/** Fixed-encoding alias matching exactly these bytes (e.g. 10 EF -> CLI), if any. */
export function aliasForBytes(bytes: readonly number[]): Alias | undefined {
  return ALIASES.find((a) => a.bytes && a.bytes.length === bytes.length && a.bytes.every((b, i) => b === bytes[i]));
}
