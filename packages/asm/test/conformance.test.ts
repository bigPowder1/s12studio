/**
 * Conformance: every instruction form of the @s12/isa table, in every indexed variant it allows, is assembled
 * and decoded back with the @s12/isa disassembler. The decoder must return the very same OpForm, the same length
 * and the operand values that were written. Also assembles the lab-PC probe files packages/asm/conformance/allmodes_{core,s12x,probes}.asm.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OPCODE_FORMS,
  bufferReader,
  decode,
  formOnCpu,
  idxAllowed,
  idxSetFor,
  type Cpu,
  type IdxClass,
  type OpForm,
} from '@s12/isa';
import { assemble } from '../src/index.js';

const IDX_SAMPLES: Array<[IdxClass, string]> = [
  ['IDX', '5,X'],
  ['IDX', '-3,Y'],
  ['IDX', '0,SP'],
  ['IDX', '7,PC'],
  ['IDX', 'A,X'],
  ['IDX', 'B,Y'],
  ['IDX', 'D,SP'],
  ['IDX', '2,X+'],
  ['IDX', '3,-Y'],
  ['IDX', '1,+SP'],
  ['IDX', '8,X-'],
  ['IDX1', '100,X'],
  ['IDX1', '-200,SP'],
  ['IDX2', '$1234,Y'],
  ['IDX2', '-1000,PC'],
  ['[IDX2]', '[$1234,X]'],
  ['[D,IDX]', '[D,Y]'],
];

function idxOperands(form: OpForm, cpu: Cpu): string[] {
  const set = idxSetFor(form, cpu);
  return IDX_SAMPLES.filter(([c]) => idxAllowed(set, c)).map(([, t]) => t);
}

/** Operand texts that must assemble to `form`. */
function operandsFor(form: OpForm, cpu: Cpu): string[] {
  const imm = form.size === 16 ? '#$1234' : '#$12';
  switch (form.mode) {
    case 'INH':
      return [''];
    case 'IMM8':
    case 'IMM16':
      return [imm];
    case 'DIR':
      return ['$12'];
    case 'EXT':
      return ['$1234'];
    case 'IDX':
      return idxOperands(form, cpu);
    case 'REL8':
    case 'REL16':
      return ['*', '*+$40'];
    case 'LOOP':
      return ['D,*', 'X,*+20', 'SP,*-100'];
    case 'BIT_DIR':
      return ['$12,#$34'];
    case 'BIT_EXT':
      return ['$1234,#$56'];
    case 'BIT_IDX':
      return idxOperands(form, cpu).map((o) => `${o},#$5A`);
    case 'BRBIT_DIR':
      return ['$12,#$34,*'];
    case 'BRBIT_EXT':
      return ['$1234,#$56,*'];
    case 'BRBIT_IDX':
      return idxOperands(form, cpu).map((o) => `${o},#$5A,*+10`);
    case 'MOV_IMM_IDX':
      return idxOperands(form, cpu).map((o) => `${imm},${o}`);
    case 'MOV_EXT_IDX':
      return idxOperands(form, cpu).map((o) => `$1234,${o}`);
    case 'MOV_IDX_IDX': {
      const ops = idxOperands(form, cpu);
      return ops.flatMap((s, i) => [`${s},${ops[(i + 3) % ops.length]}`]);
    }
    case 'MOV_IMM_EXT':
      return [`${imm},$4567`];
    case 'MOV_EXT_EXT':
      return ['$1234,$4567'];
    case 'MOV_IDX_EXT':
      return idxOperands(form, cpu).map((o) => `${o},$4567`);
    case 'TFR_EXG':
      return form.mnemonic === 'SEX' ? ['A,D', 'B,X'] : ['A,B', 'D,X', 'SP,Y'];
    case 'TRAP':
      return [`#$${form.opcode.toString(16)}`];
    case 'CALL_EXT':
      return ['$8000,$3E'];
    case 'CALL_IDX':
      return [...idxOperands(form, cpu).filter((o) => !o.startsWith('[')).map((o) => `${o},$3E`), '[D,X]', '[$1234,Y]'];
  }
}

describe.each([
  ['CPU12', 'cpu12'],
  ['HCS12X', 's12x'],
] as const)('every form assembles and decodes back (-Cpu%s)', (cpuName, cpu) => {
  const lines: Array<{ form: OpForm; text: string }> = [];
  for (const f of OPCODE_FORMS) {
    if (!formOnCpu(f, cpu)) continue;
    for (const o of operandsFor(f, cpu)) lines.push({ form: f, text: `${f.mnemonic.padEnd(8)}${o}` });
  }
  const src = ['        ORG $4000', ...lines.map((l) => `        ${l.text}`)].join('\n');
  const r = assemble({ sourcePath: 'all.asm', readFile: () => src, options: `-Cpu${cpuName}` });

  it('assembles without errors', () => {
    expect(r.messages.filter((m) => m.severity === 'ERROR')).toEqual([]);
    expect(lines.length).toBeGreaterThan(cpu === 's12x' ? 700 : 400);
  });

  it('each statement decodes to the same form, length and operands', () => {
    const sec = r.object!.sections.find((s) => s.name === '_ORG00001')!;
    const read = bufferReader(sec.data, 0x4000);
    expect(r.lines.length).toBe(lines.length);
    const bad: string[] = [];
    r.lines.forEach((ln, i) => {
      const d = decode(read, ln.address, { cpu, hex: '$' });
      const want = lines[i];
      if (d.form !== want.form || d.length !== ln.size || d.invalidOperand || d.illegal) {
        bad.push(`${want.text} -> ${d.mnemonic} ${d.operandsText} (${d.mode}, ${d.length} vs ${ln.size})`);
        return;
      }
      // Operand values written in the source.
      for (const op of d.operands) {
        if (op.kind === 'imm' && op.value !== (op.size === 16 ? 0x1234 : 0x12)) bad.push(`${want.text}: imm ${op.value}`);
        if (op.kind === 'dir' && op.address !== 0x12) bad.push(`${want.text}: dir ${op.address}`);
        if (op.kind === 'ext' && ![0x1234, 0x4567, 0x8000].includes(op.address)) bad.push(`${want.text}: ext ${op.address}`);
        if (op.kind === 'rel') {
          const m = want.text.match(/\*([+-][$0-9A-Fa-f]+)?$/);
          const delta = m && m[1] ? (m[1][0] === '-' ? -1 : 1) * parseInt(m[1].slice(1).replace('$', ''), m[1].includes('$') ? 16 : 10) : 0;
          if (op.target !== ln.address + delta) bad.push(`${want.text}: target ${op.target.toString(16)}`);
        }
      }
    });
    expect(bad).toEqual([]);
  });
});

describe('conformance/allmodes_*.asm (lab-PC probe files)', () => {
  const dir = fileURLToPath(new URL('../conformance/', import.meta.url));
  const read = (p: string) => {
    try {
      return readFileSync(dir + p, 'latin1');
    } catch {
      return undefined;
    }
  };
  const run = (file: string, opts: string) => assemble({ sourcePath: file, readFile: read, options: opts });
  const roundTrip = (r: ReturnType<typeof run>) => {
    const bad: string[] = [];
    for (const ln of r.lines) {
      const sec = r.object!.sections.find((s) => s.name === ln.section)!;
      const base = r.sections.find((s) => s.name === ln.section)!.address;
      if (!r.sections.find((s) => s.name === ln.section && s.type === 'code')) continue;
      const d = decode(bufferReader(sec.data, base), ln.address, { cpu: 's12x' });
      const stmtText = r.dbg.text.split('\r\n')[ln.absLine - 1];
      if (/\bD[CS]\.|\bDCB\b|\bFCB\b|\bFDB\b/i.test(stmtText)) continue;
      if (d.length !== ln.size || d.illegal) bad.push(`${stmtText.trim()} -> ${d.mnemonic} ${d.operandsText} len ${d.length}/${ln.size}`);
    }
    return bad;
  };
  for (const file of ['allmodes_core.asm', 'allmodes_s12x.asm', 'allmodes_probes.asm']) {
    for (const li of ['-Li', '']) {
      it(`${file} ${li || '(no -Li)'} assembles cleanly with -CpuHCS12X and decodes back`, () => {
        const r = run(file, `-CpuHCS12X -L=%n.lst ${li}`);
        expect(r.messages.filter((m) => m.severity !== 'INFORMATION')).toEqual([]);
        expect(r.ok).toBe(true);
        expect(r.listing!.text.length).toBeGreaterThan(1000);
        expect(roundTrip(r)).toEqual([]);
      });
    }
  }
  it('core forms are all plain CPU12/HCS12: allmodes_core.asm also assembles with -CpuHCS12', () => {
    const r = run('allmodes_core.asm', '-CpuHCS12 -L');
    expect(r.messages.filter((m) => m.severity !== 'INFORMATION')).toEqual([]);
  });
  it('every probe guard switches its probe off (-DNO_Pnn) and the 8-bit probe P21 is opt-in', () => {
    const text = read('allmodes_probes.asm')!;
    const guards = [...text.matchAll(/IFNDEF (NO_\w+)/g)].map((m) => m[1]);
    expect(guards.length).toBeGreaterThanOrEqual(7);
    const full = run('allmodes_probes.asm', '-CpuHCS12X');
    const none = run('allmodes_probes.asm', `-CpuHCS12X ${guards.map((g) => '-D' + g).join(' ')}`);
    expect(none.ok).toBe(true);
    expect(none.lines.length).toBeLessThan(full.lines.length);
    // P21 needs 8-bit relocations, which the clone rejects (A9001) - it must stay off by default.
    const p21 = run('allmodes_probes.asm', '-CpuHCS12X -DP21');
    expect(p21.messages.map((m) => m.code)).toContain('A9001');
    const s12x = run('allmodes_s12x.asm', '-CpuHCS12X -DNO_XREGS');
    expect(s12x.ok).toBe(true);
  });
});
