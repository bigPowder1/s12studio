// Regression tests for review round 2: far (PAGE8 + ABS16) address pairs, paged VECTOR targets, L1102 cursor,
// input order, DISTRIBUTE_INTO warning.
import { describe, expect, it } from 'vitest';
import { readElf } from '@s12/formats';
import { CLONE_UNSUPPORTED, link, orderLinkInputs, type LinkInput } from '@s12/link';
import { LIB, fixtureText, makeObject, prm, readFixture, studentObject, itFx } from './helpers';

const base = (over: Partial<LinkInput>): LinkInput => ({
  outputPath: 'C:\\p\\bin\\Project.abs',
  noteMeta: { user: 'me', created: 'Thu Jan  1 00:00:00 2026\n' },
  prmText: '',
  ...over,
});
const section = (r: ReturnType<typeof link>, name: string) => r.layout.sections.find((s) => s.name === name);
const PAGED_SEGS = 'RAM = READ_WRITE 0x2000 TO 0x3FFF;\nROM_C000 = READ_ONLY 0xC000 TO 0xFEFF;\nPAGE_FE = READ_ONLY 0xFE8000 TO 0xFEBFFF;';

/** Entry in MyCode = `CALL farfn; BRA *`, farfn at Far+1; relocs: ABS16 at 1 to farfn, PAGE8 at 3 to `pageSym` */
const callObject = (pageSym: string) =>
  makeObject('main.asm.o', {
    sections: [{ name: 'MyCode', kind: 'code', bytes: [0x4a, 0x00, 0x00, 0x00, 0x20, 0xfe] }, { name: 'Far', kind: 'code', bytes: [0x00, 0x0a] }],
    symbols: [{ name: 'Entry', section: 'MyCode', size: 6, global: true }, { name: 'farfn', section: 'Far', value: 1, size: 1, global: true }],
    relocs: [
      { section: 'MyCode', offset: 1, sym: 'farfn', kind: 'ABS16' },
      { section: 'MyCode', offset: 3, sym: pageSym, kind: 'PAGE8' },
    ],
  });

/** golden project relinked with `MyCode INTO PAGE_FE` (the stock PRM's DEFAULT_ROM target) */
function relinkPaged(proj: string, data: string) {
  return link(base({
    objects: [{ name: 'main.asm.o', bytes: readFixture(proj, data, 'Standard', 'ObjectCode', 'main.asm.o') }],
    libraries: [{ name: 'ME305LibV4.0.lib', bytes: LIB() }],
    prmText: fixtureText(proj, 'prm', 'Project.prm').replace(/MyCode\s+INTO\s+ROM_4000;/, 'MyCode INTO PAGE_FE;'),
  }));
}
const has = (hay: Uint8Array, needle: number[]) => Buffer.from(hay).indexOf(Buffer.from(needle)) >= 0;

describe('far addresses: PAGE8 + ABS16 pairs never give L1907', () => {
  itFx('blank_project with MyCode in PAGE_FE links cleanly; debug info gets the 24-bit address (pg hi lo)', () => {
    const r = relinkPaged('blank_project', 'blank_project_Data');
    expect(r.messages).toEqual([]);
    expect(r.ok).toBe(true);
    expect(section(r, 'MyCode')!.address).toBe(0xfe8000);
    const line = readElf(r.absBytes!).sections.find((s) => s.name === '.debug_line')!;
    // DW_LNE_set_address of MyCode: the golden object encodes it as PAGE8 (offset o-1) + ABS16 (offset o)
    expect(has(line.data, [0xfe, 0x80, 0x00])).toBe(true);
  });

  itFx('Lab3 with MyCode in PAGE_FE: L1907 only for unpaired 16-bit code fixups (JSR/JMP/DC.W), none from debug sections', () => {
    const r = relinkPaged('Lab3', 'Lab3_Data');
    expect(r.ok).toBe(false);
    expect(r.messages.length).toBeGreaterThan(0);
    for (const m of r.messages) {
      expect(m.code).toBe('L1907');
      expect(m.file).toBe('main.asm.o');
      expect(m.text).not.toMatch(/\.debug/);
    }
    expect(r.messages[0].text).toMatch(/^Fixup overflow in \w+, to \w+ type 1, at offset 0x1$/);
  });

  it('CALL farfn (4A hi lo pg: ABS16 at +1, PAGE8 at +3) links and is patched', () => {
    const obj = callObject('farfn');
    const r = link(base({
      objects: [{ name: 'main.asm.o', bytes: obj }],
      prmText: prm({ segments: PAGED_SEGS, placement: '_PRESTART INTO ROM_C000;\nSSTACK, DEFAULT_RAM INTO RAM;\nFar INTO PAGE_FE;', extra: 'STACKSIZE 0x100\nINIT Entry' }),
    }));
    expect(r.messages).toEqual([]);
    const init = readElf(r.absBytes!).sections.find((s) => s.name === '.init')!;
    expect([...init.data.slice(0, 4)]).toEqual([0x4a, 0x80, 0x01, 0xfe]);
  });

  it('a PAGE8 to a different symbol does not excuse an overflowing ABS16', () => {
    const obj = callObject('Entry');
    const r = link(base({
      objects: [{ name: 'main.asm.o', bytes: obj }],
      prmText: prm({ segments: PAGED_SEGS, placement: '_PRESTART INTO ROM_C000;\nSSTACK, DEFAULT_RAM INTO RAM;\nFar INTO PAGE_FE;', extra: 'STACKSIZE 0x100\nINIT Entry' }),
    }));
    expect(r.messages.map((m) => m.text)).toEqual(['Fixup overflow in Entry, to farfn type 1, at offset 0x1']);
  });
});

describe('VECTOR to a banked target', () => {
  it('gives L1907 instead of silently truncating to 16 bits', () => {
    const obj = makeObject('main.asm.o', {
      sections: [{ name: 'MyCode', kind: 'code', bytes: [0x20, 0xfe] }, { name: 'Far', kind: 'code', bytes: [0x0b] }],
      symbols: [{ name: 'Entry', section: 'MyCode', size: 2, global: true }, { name: 'isr', section: 'Far', size: 1, global: true }],
    });
    const r = link(base({
      objects: [{ name: 'main.asm.o', bytes: obj }],
      prmPath: 'Project.prm',
      prmText: prm({
        segments: PAGED_SEGS,
        placement: '_PRESTART INTO ROM_C000;\nSSTACK, DEFAULT_RAM INTO RAM;\nFar INTO PAGE_FE;',
        extra: 'STACKSIZE 0x100\nINIT Entry\nENTRIES * END\nVECTOR ADDRESS 0xFFF0 isr',
      }),
    }));
    expect(section(r, 'Far')!.address).toBe(0xfe8000);
    expect(r.ok).toBe(false);
    expect(r.messages).toEqual([
      { code: 'L1907', severity: 'error', text: 'Fixup overflow in .vectSeg0_vect, to isr type 1, at offset 0x0', file: 'Project.prm' },
    ]);
  });
});

describe('L1102 does not cascade', () => {
  const obj = makeObject('m.asm.o', {
    sections: [
      { name: 'Boot', kind: 'code', bytes: [0x3d] },
      { name: 'Big1', kind: 'code', bytes: new Array(0x30).fill(1) },
      { name: 'Big2', kind: 'code', bytes: new Array(0x30).fill(2) },
      { name: 'Small', kind: 'code', bytes: new Array(0x10).fill(3) },
    ],
    symbols: [{ name: 'Entry', section: 'Boot', size: 1, global: true }],
  });
  const segments = 'S1 = READ_ONLY 0x4000 TO 0x401F;\nROM_C000 = READ_ONLY 0xC000 TO 0xFEFF;';

  it('a failed section does not move the cursor: the next section that fits is still placed', () => {
    const r = link(base({
      objects: [{ name: 'm.asm.o', bytes: obj }],
      prmText: prm({ segments, placement: '_PRESTART INTO ROM_C000;\nBig1, Small INTO S1;', extra: 'ENTRIES * END\nINIT Entry' }),
    }));
    expect(r.messages.filter((m) => m.code === 'L1102')).toEqual([
      { code: 'L1102', severity: 'error', text: 'Out of allocation space in segment S1 at address 0x4000', file: 'Big1' },
    ]);
    expect(section(r, 'Small')!.address).toBe(0x4000);
  });

  it('several sections failing at the same place give one message listing all of them', () => {
    const r = link(base({
      objects: [{ name: 'm.asm.o', bytes: obj }],
      prmText: prm({ segments, placement: '_PRESTART INTO ROM_C000;\nBig1, Big2 INTO S1;', extra: 'ENTRIES * END\nINIT Entry' }),
    }));
    expect(r.messages.filter((m) => m.code === 'L1102')).toEqual([
      { code: 'L1102', severity: 'error', text: 'Out of allocation space in segment S1 at address 0x4000', file: 'Big1, Big2' },
    ]);
  });

  it('an oversized STACKSIZE no longer hides DEFAULT_RAM', () => {
    const r = link(base({
      objects: [{ name: 'main.asm.o', bytes: studentObject() }],
      prmText: prm({
        segments: 'RAM = READ_WRITE 0x2000 TO 0x3FFF;\nROM_C000 = READ_ONLY 0xC000 TO 0xFEFF;',
        placement: '_PRESTART INTO ROM_C000;\nSSTACK, DEFAULT_RAM INTO RAM;',
        extra: 'STACKSIZE 0x2100\nINIT Entry',
      }),
    }));
    expect(r.messages.filter((m) => m.code === 'L1102')).toEqual([
      { code: 'L1102', severity: 'error', text: 'Out of allocation space in segment RAM at address 0x2000', file: '.stack' },
    ]);
    expect(section(r, '.data')).toMatchObject({ address: 0x2000, size: 2 });
  });
});

describe('input order and PRM warnings', () => {
  it('orderLinkInputs: explicit inputs, then libraries, then objects', () => {
    const f = (name: string) => ({ name, bytes: new Uint8Array(0) });
    const order = orderLinkInputs({
      inputs: [{ kind: 'object', ...f('first.o') }],
      objects: [f('obj.o')],
      libraries: [f('lib.lib')],
    });
    expect(order.map((e) => e.name)).toEqual(['first.o', 'lib.lib', 'obj.o']);
    expect(orderLinkInputs({ objects: [f('obj.o')], libraries: [f('lib.lib')] }).map((e) => e.name)).toEqual(['lib.lib', 'obj.o']);
  });

  it('DISTRIBUTE_INTO that places something warns (allocated like INTO); empty statements stay silent', () => {
    const obj = makeObject('m.asm.o', {
      sections: [{ name: 'Boot', kind: 'code', bytes: [0x3d] }, { name: 'A', kind: 'code', bytes: [1, 2] }],
      symbols: [{ name: 'Entry', section: 'Boot', size: 1, global: true }],
    });
    const r = link(base({
      objects: [{ name: 'm.asm.o', bytes: obj }],
      prmText: prm({
        segments: 'S1 = READ_ONLY 0x4000 TO 0x4FFF;\nROM_C000 = READ_ONLY 0xC000 TO 0xFEFF;',
        placement: '_PRESTART INTO ROM_C000;\nA DISTRIBUTE_INTO S1;\nEMPTY DISTRIBUTE_INTO S1;',
        extra: 'ENTRIES * END\nINIT Entry\nSTACKTOP 0x3FFF',
      }),
    }));
    expect(r.ok).toBe(true);
    const w = r.messages.filter((m) => m.code === CLONE_UNSUPPORTED);
    expect(w.map((m) => m.text)).toEqual(['DISTRIBUTE_INTO is allocated like INTO (no object distribution): A']);
    expect(section(r, 'A')!.address).toBe(0x4000);
  });

  it('PRM LINK is overridden by outputPath (SmartLinker -O) without a message', () => {
    const r = link(base({
      objects: [{ name: 'main.asm.o', bytes: studentObject() }],
      prmText: `LINK other.abs\n${prm({ segments: 'RAM = READ_WRITE 0x2000 TO 0x3FFF;\nROM_C000 = READ_ONLY 0xC000 TO 0xFEFF;', placement: '_PRESTART INTO ROM_C000;\nSSTACK, DEFAULT_RAM INTO RAM;', extra: 'STACKSIZE 0x100\nINIT Entry' })}`,
    }));
    expect(r.messages).toEqual([]);
    expect(r.mapText).toContain('C:\\p\\bin\\Project.abs');
  });
});
