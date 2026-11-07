import { describe, expect, it } from 'vitest';
import {
  ALIASES,
  OPCODE_FORMS,
  accessCycles,
  accessFor,
  accessSourceFor,
  aliasForBytes,
  canonicalMnemonic,
  ccrEffect,
  decode,
  formOnCpu,
  formsAt,
  formsByMnemonic,
  parseAccess,
  resolveAlias,
  type Cpu,
} from '../src/index.js';

const CPUS: Cpu[] = ['cpu12', 's12x'];

describe('opcode table sanity', () => {
  it('no duplicate (prefix, opcode) on a CPU except postbyte-selected rows', () => {
    for (const cpu of CPUS) {
      for (const prefix of [0, 0x18] as const) {
        for (let op = 0; op < 256; op++) {
          const forms = formsAt(cpu, prefix, op);
          if (forms.length <= 1) continue;
          expect(forms.every((f) => f.postbyteSelects), `${cpu} ${prefix}:${op.toString(16)}`).toBe(true);
          expect(new Set(forms.map((f) => f.mnemonic)).size).toBe(forms.length);
        }
      }
    }
    const shared = OPCODE_FORMS.filter((f) => f.postbyteSelects);
    expect(new Set(shared.map((f) => `${f.prefix}:${f.opcode}`))).toEqual(new Set(['0:4', '0:183']));
  });

  it('every page-1 opcode is defined, except the $18 prebyte', () => {
    for (const cpu of CPUS) {
      for (let op = 0; op < 256; op++) {
        const n = formsAt(cpu, 0, op).length;
        if (op === 0x18) expect(n).toBe(0);
        else expect(n, `${cpu} page1 ${op.toString(16)}`).toBeGreaterThan(0);
      }
    }
  });

  it('every page-2 opcode is an instruction or a TRAP; 54 CPU12 instructions', () => {
    for (const cpu of CPUS) {
      for (let op = 0; op < 256; op++) {
        expect(formsAt(cpu, 0x18, op).length, `${cpu} page2 ${op.toString(16)}`).toBe(1);
      }
    }
    const cpu12NonTrap = [...Array(256).keys()].filter((op) => formsAt('cpu12', 0x18, op)[0].mnemonic !== 'TRAP');
    expect(cpu12NonTrap.length).toBe(54);
    const cpu12Traps = [...Array(256).keys()].filter((op) => formsAt('cpu12', 0x18, op)[0].mnemonic === 'TRAP');
    expect(cpu12Traps).toEqual([...Array(10).keys()].map((i) => 0x30 + i).concat([...Array(192).keys()].map((i) => 0x40 + i)));
  });

  it('CPU12X page-2 trap set matches s12x-isa.md / libasm', () => {
    const traps = [...Array(256).keys()].filter((op) => formsAt('s12x', 0x18, op)[0].mnemonic === 'TRAP');
    const expected = [0x30, 0x31, 0x32, 0x33, 0x34, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f, 0x59, 0x81, 0x86, 0x91,
      0xa1, 0xb1, 0xb7, 0xc1, 0xc6, 0xcc, 0xcd, 0xce, 0xcf, 0xd1, 0xe1, 0xf1];
    expect(traps).toEqual(expected);
  });

  it('spot-check encodings and CPU membership', () => {
    const one = (cpu: Cpu, p: 0 | 0x18, op: number) => formsAt(cpu, p, op)[0];
    expect(one('s12x', 0x18, 0x73)).toMatchObject({ mnemonic: 'DECW', mode: 'EXT', cpu: 's12x' });
    expect(one('s12x', 0x18, 0x72)).toMatchObject({ mnemonic: 'INCW', mode: 'EXT' });
    expect(one('cpu12', 0x18, 0x73)).toMatchObject({ mnemonic: 'TRAP', cpu12Only: true });
    expect(one('s12x', 0x18, 0x7f)).toMatchObject({ mnemonic: 'GSTS', mode: 'EXT' }); // binutils says 6F
    expect(one('s12x', 0x18, 0x6f)).toMatchObject({ mnemonic: 'GSTS', mode: 'IDX' });
    expect(one('s12x', 0x18, 0x0d)).toMatchObject({ mnemonic: 'MOVB', mode: 'MOV_IDX_EXT', idx: 'short', idxS12x: 'all' });
    expect(one('s12x', 0, 0x4b)).toMatchObject({ mnemonic: 'CALL', mode: 'CALL_IDX' });
    expect(one('s12x', 0, 0x3c)).toMatchObject({ mnemonic: 'WAVR' });
    expect(formsByMnemonic('LDAA').map((f) => f.mode).sort()).toEqual(['DIR', 'EXT', 'IDX', 'IMM8']);
    expect(formsByMnemonic('ADDX', 'cpu12')).toEqual([]);
    expect(formsByMnemonic('ADDX', 's12x').map((f) => f.opcode)).toEqual([0x8b, 0x9b, 0xab, 0xbb]);
    for (const f of OPCODE_FORMS) {
      expect(f.mnemonic).toBe(f.mnemonic.toUpperCase());
      expect(f.ccr, f.mnemonic).toMatch(/^[-01D?v^W]{8}$/);
      if (f.cpu === 's12x') expect(formOnCpu(f, 'cpu12')).toBe(false);
    }
  });

  it('every form has an access string with at least one cycle for each allowed variant', () => {
    for (const f of OPCODE_FORMS) {
      for (const acc of [f.access, f.accessS12x ?? {}]) {
        const keys = Object.keys(acc);
        if (acc === f.access) expect(keys.length, `${f.mnemonic} ${f.mode}`).toBeGreaterThan(0);
        for (const k of keys) {
          const s = acc[k as keyof typeof acc]!;
          if (k === 'alt' || k === 'altWeighted') expect(parseAccess(s).loopCycles ?? parseAccess(s).cycles).toBeGreaterThan(0);
          else expect(accessCycles(s), `${f.mnemonic} ${f.mode} ${k}`).toBeGreaterThan(0);
        }
      }
      if (f.accessS12x) {
        expect(f.cpu, f.mnemonic).toBe('cpu12'); // only shared rows need a second map
        expect(Object.keys(f.accessS12x).sort()).toEqual(Object.keys(f.access).sort());
        expect(f.accessS12xSource).toBeDefined();
      }
      if (f.mode === 'IDX' || f.mode.endsWith('_IDX') && !f.mode.startsWith('MOV')) {
        expect(f.access.IDX, `${f.mnemonic} ${f.mode}`).toBeDefined();
      }
    }
  });

  it('CCR effects', () => {
    const ldaa = formsByMnemonic('LDAA')[0];
    expect(ccrEffect(ldaa)).toEqual({
      S: 'unchanged', X: 'unchanged', H: 'unchanged', I: 'unchanged',
      N: 'changed', Z: 'changed', V: 'cleared', C: 'unchanged',
    });
    expect(formsByMnemonic('ADDA')[0].ccr).toBe('--D-DDDD');
    expect(formsByMnemonic('DAA')[0].ccr).toBe('----DD?D');
    expect(formsByMnemonic('INCW', 's12x')[0].ccr).toBe('----DDD-');
    expect(formsByMnemonic('INX')[0].ccr).toBe('-----D--');
    expect(formsByMnemonic('LEAX')[0].ccr).toBe('--------');
    expect(ccrEffect(formsByMnemonic('PULC')[0]).X).toBe('clearOnly');
  });

  it('per-CPU access maps for exception entry/return (review finding 1)', () => {
    const rti = formsByMnemonic('RTI')[0];
    expect(accessFor(rti, 'cpu12')).toEqual({ base: 'uUUUUPPP', alt: 'uUUUUfVfPPP' });
    expect(accessSourceFor(rti, 'cpu12')).toBe('HCS12');
    expect(accessFor(rti, 's12x')).toEqual({ base: 'UUUUUPPP', alt: 'UUUUUVfPPP' });
    expect(accessSourceFor(rti, 's12x')).toBe('HCS12X');
    expect(accessFor(formsByMnemonic('SWI')[0], 'cpu12').base).toBe('VSPSSPSsP');
    expect(accessFor(formsAt('cpu12', 0x18, 0x30)[0], 'cpu12').base).toBe('OVSPSSPSsP');
    expect(accessFor(formsAt('s12x', 0x18, 0x30)[0], 's12x').base).toBe('OVSPSSPSSP');
    // a row without a CPU12X map falls back to `access`
    const ldaa = formsByMnemonic('LDAA')[0];
    expect(accessFor(ldaa, 's12x')).toBe(ldaa.access);
    expect(accessSourceFor(ldaa, 's12x')).toBe('HCS12');
  });
});

describe('aliases', () => {
  it('fixed-encoding aliases decode to their canonical mnemonic', () => {
    for (const a of ALIASES) {
      if (!a.bytes) continue;
      const insn = decode((i) => a.bytes![i] ?? 0, 0, { cpu: a.cpu, hex: '$' });
      expect(insn.mnemonic, a.alias).toBe(a.canonical);
      expect(insn.length).toBe(a.bytes.length);
      if (a.operands !== undefined) {
        expect(insn.operandsText.replace(/\$0*(?=[0-9A-F])/g, '$')).toBe(a.operands.replace(/\$0*(?=[0-9A-F])/g, '$'));
        const withAlias = decode((i) => a.bytes![i] ?? 0, 0, { aliases: true });
        expect(withAlias.mnemonic).toBe(a.alias);
        expect(withAlias.operandsText).toBe('');
      }
    }
  });

  it('alias helpers', () => {
    expect(canonicalMnemonic('lsla')).toBe('ASLA');
    expect(canonicalMnemonic('bhs')).toBe('BCC');
    expect(canonicalMnemonic('LBLO')).toBe('LBCS');
    expect(canonicalMnemonic('ldaa')).toBe('LDAA');
    expect(resolveAlias('cli')).toMatchObject({ canonical: 'ANDCC', operands: '#$EF' });
    expect(aliasForBytes([0x1b, 0x9f])?.alias).toBe('DES');
    expect(aliasForBytes([0xb7, 0x01])).toBeUndefined();
  });
});
