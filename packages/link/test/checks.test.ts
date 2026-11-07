// Regression tests for placement order, overlap detection, stack rules and PRM diagnostics (review round 1).
import { describe, expect, it } from 'vitest';
import { readElf } from '@s12/formats';
import { burn, link, type LinkInput } from '@s12/link';
import { SIMPLE_PRM, makeObject, prm, studentObject, fixtureText, itFx } from './helpers';

const base = (over: Partial<LinkInput>): LinkInput => ({
  prmText: SIMPLE_PRM,
  outputPath: 'C:\\p\\bin\\Project.abs',
  noteMeta: { user: 'me', created: 'Thu Jan  1 00:00:00 2026\n' },
  ...over,
});
const codes = (r: { messages: { code: string }[] }) => r.messages.map((m) => m.code);
const section = (r: ReturnType<typeof link>, name: string) => r.layout.sections.find((s) => s.name === name);
const symbol = (r: ReturnType<typeof link>, name: string) => r.layout.symbols.find((s) => s.name === name);
const student = (bytes: Uint8Array) => [{ name: 'main.asm.o', bytes }];
/** student object plus one extra ORG section `_ORG00002` at `addr` holding VAR00002 */
const withOrg = (addr: number, size = 2) =>
  studentObject({
    sections: [{ name: '_ORG00002', kind: 'org', addr, bytes: new Array(size).fill(0xaa) }],
    symbols: [{ name: 'VAR00002', section: 'ABS', value: addr, size, type: 'object' }],
  });

describe('overlap detection', () => {
  it('L1104: ORG data on top of the placed stack (ORG $2000 + SSTACK INTO RAM)', () => {
    const r = link(base({ objects: student(withOrg(0x2000)) }));
    expect(section(r, '.stack')!.address).toBe(0x2000);
    expect(r.ok).toBe(false);
    expect(r.messages).toEqual([{ code: 'L1104', severity: 'error', text: 'Absolute object VAR00002 overlaps with segment RAM' }]);
  });

  it('L1104: ORG data inside .init', () => {
    const r = link(base({ objects: student(withOrg(0xc002)) }));
    expect(r.messages).toEqual([{ code: 'L1104', severity: 'error', text: 'Absolute object VAR00002 overlaps with segment ROM_C000' }]);
  });

  it('L1104: two overlapping ORG sections', () => {
    const r = link(base({ objects: student(withOrg(0xfffd)) })); // 0xFFFD..0xFFFE vs _ORG00001 0xFFFE..0xFFFF
    expect(r.messages).toEqual([{ code: 'L1104', severity: 'error', text: 'Absolute object VAR00002 overlaps with segment .absSeg0' }]);
  });

  it('ORG data in an unused part of a segment is accepted (ranges are not reserved; UNCERTAIN)', () => {
    const r = link(base({ objects: student(withOrg(0x3000)) }));
    expect(r.messages).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('L1100: overlapping segments; two PAGED segments may overlap', () => {
    const r = link(base({ objects: student(studentObject()), prmText: SIMPLE_PRM.replace('ROM_4000 = READ_ONLY 0x4000', 'ROM_4000 = READ_ONLY 0x3000') }));
    expect(r.messages).toEqual([{ code: 'L1100', severity: 'error', text: 'Segments RAM and ROM_4000 overlap' }]);
    const paged = SIMPLE_PRM.replace('ROM_C000 =', 'P1 = PAGED 0x1000 TO 0x10FF;\nP2 = PAGED 0x1080 TO 0x11FF;\nROM_C000 =');
    expect(link(base({ objects: student(studentObject()), prmText: paged })).messages).toEqual([]);
  });

  it('L1119: a VECTOR inside a placed section and two VECTORs at the same address', () => {
    const r = link(base({
      objects: student(studentObject()),
      prmText: SIMPLE_PRM.replace('INIT Entry', 'INIT Entry\nVECTOR ADDRESS 0xC002 Entry\nVECTOR 5 Entry\nVECTOR ADDRESS 0xFFF4 Entry'),
    }));
    expect(r.messages).toEqual([
      { code: 'L1119', severity: 'error', text: 'Vector allocated at absolute address 0xC002 overlaps with sections placed in segment ROM_C000' },
      { code: 'L1119', severity: 'error', text: 'Vector allocated at absolute address 0xFFF4 overlaps with sections placed in segment .vectSeg1' },
    ]);
  });
});

describe('unplaced sections (BTU "Allocating User-Defined Sections (ELF)")', () => {
  const obj = makeObject('main.asm.o', {
    sections: [
      { name: 'Zed', kind: 'code', bytes: [1, 2] }, // user code, not in PLACEMENT
      { name: '.rodata', kind: 'code', bytes: [3] },
      { name: 'DEFAULT_ROM', kind: 'code', bytes: [4, 5, 6] },
      { name: 'Boot', kind: 'code', bytes: [0x20, 0xfe] }, // holds INIT -> .init, _PRESTART not in PLACEMENT
      { name: 'UData', kind: 'data', size: 4 },
      { name: '.bss', kind: 'data', size: 2 },
      { name: 'DEFAULT_RAM', kind: 'data', size: 1 },
    ],
    symbols: [{ name: 'Entry', section: 'Boot', size: 2, global: true }],
  });
  const r = link(base({
    objects: student(obj),
    prmText: prm({
      segments: 'RAM = READ_WRITE 0x2000 TO 0x3FFF;\nROM = READ_ONLY 0xC000 TO 0xFEFF;',
      placement: 'DEFAULT_ROM INTO ROM;\nDEFAULT_RAM INTO RAM;',
      extra: 'STACKSIZE 0x10\nENTRIES * END\nINIT Entry',
    }),
  }));

  it('code side: .init .text .rodata <user code>, so the entry section stays first', () => {
    expect(r.messages).toEqual([]);
    expect(['.init', '.text', '.rodata', 'Zed'].map((n) => section(r, n)!.address)).toEqual([0xc000, 0xc002, 0xc005, 0xc006]);
    expect(readElf(r.absBytes!).header.entry).toBe(0xc000);
  });

  it('data side: .data .bss <user data> .stack', () => {
    expect(['.data', '.bss', 'UData', '.stack'].map((n) => section(r, n)!.address)).toEqual([0x2000, 0x2001, 0x2003, 0x2007]);
  });
});

describe('stack rules', () => {
  const lds = studentObject({
    code: [0x79, 0x00, 0x00, 0xcf, 0x00, 0x00, 0x20, 0xfe],
    symbols: [{ name: '__SEG_END_SSTACK', section: 'UND' }],
    relocs: [{ section: 'MyCode', offset: 4, sym: '__SEG_END_SSTACK' }],
  });
  const ldsValue = (r: ReturnType<typeof link>) => {
    const d = readElf(r.absBytes!).sections.find((s) => s.name === '.init')!.data;
    return (d[4] << 8) | d[5];
  };

  it('STACKTOP with SSTACK placed: the stack runs from the segment start up to STACKTOP (SP init = STACKTOP)', () => {
    const r = link(base({ objects: student(lds), prmText: SIMPLE_PRM.replace('STACKSIZE 0x100', 'STACKTOP 0x2100') }));
    expect(r.messages).toEqual([]);
    expect(section(r, '.stack')).toMatchObject({ address: 0x2000, size: 0x100, segment: 'RAM' });
    expect(section(r, '.data')!.address).toBe(0x2100); // not inside the stack any more
    expect(ldsValue(r)).toBe(0x2100);
  });

  it('STACKTOP alone: no section, a PC-sized stack ending at STACKTOP, no L1823/L1201', () => {
    const r = link(base({
      objects: student(lds),
      prmText: SIMPLE_PRM.replace('STACKSIZE 0x100', 'STACKTOP 0x3F00').replace('SSTACK, DEFAULT_RAM', 'DEFAULT_RAM'),
    }));
    expect(r.messages).toEqual([]);
    expect(section(r, '.stack')).toBeUndefined();
    expect(section(r, '.data')!.address).toBe(0x2000);
    expect(ldsValue(r)).toBe(0x3f00);
  });

  it('L1103: a STACKSIZE stack with neither SSTACK nor DEFAULT_RAM in PLACEMENT (no silent LDS #0, no L1823)', () => {
    const r = link(base({
      objects: student(lds),
      prmText: SIMPLE_PRM.replace('SSTACK, DEFAULT_RAM INTO RAM;', 'Vars INTO RAM;'),
    }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('L1103');
    expect(r.messages).toContainEqual({ code: 'L1103', severity: 'error', text: '.stack not specified in the PLACEMENT block' });
    expect(codes(r)).not.toContain('L1823');
  });
});

describe('PLACEMENT diagnostics and unsupported PRM features', () => {
  const obj = () => student(studentObject());

  it('L1122: COPY must be the last section of its list', () => {
    const r = link(base({ objects: obj(), prmText: SIMPLE_PRM.replace('_PRESTART, STARTUP INTO', '_PRESTART, COPY, STARTUP INTO') }));
    expect(r.messages).toContainEqual(expect.objectContaining({ code: 'L1122', text: 'Section .copy must be the last section in the section list' }));
    expect(r.ok).toBe(false);
  });

  it('L1110: a section in two statements, a segment twice in one list', () => {
    const r = link(base({ objects: obj(), prmText: SIMPLE_PRM.replace('MyCode INTO ROM_4000;', 'MyCode INTO ROM_4000, ROM_4000;\nDEFAULT_ROM INTO ROM_C000;') }));
    const l1110 = r.messages.filter((m) => m.code === 'L1110').map((m) => m.text);
    expect(l1110).toEqual(['ROM_4000 appears twice in PLACEMENT block', '.text appears twice in PLACEMENT block']);
  });

  itFx('the golden Lab3 PRM (EEPROM in seven statements) gives no L1110', () => {
    const r = link(base({ objects: obj(), prmText: fixtureText('Lab3', 'prm', 'Project.prm') }));
    expect(codes(r)).not.toContain('L1110');
  });

  it('warns about every PRM feature that is accepted but not implemented', () => {
    const text = `${SIMPLE_PRM.replace('NAMES END', 'NAMES main.asm.o other.o END')
      .replace('ROM_4000 = READ_ONLY 0x4000 TO 0x7FFF;', 'ROM_4000 = READ_ONLY 0x4000 TO 0x7FFF FILL 0xFF;')}\nHEXFILE x.s19\nMAPFILE SEC_ALLOC\n`;
    const r = link(base({ objects: obj(), prmText: text }));
    expect(r.ok).toBe(true);
    expect(r.messages.map((m) => [m.code, m.severity, m.text])).toEqual([
      ['S12-UNSUPPORTED', 'warning', 'NAMES file other.o is not linked (pass it as a link input)'],
      ['S12-UNSUPPORTED', 'warning', 'FILL of segment ROM_4000 is ignored'],
      ['S12-UNSUPPORTED', 'warning', 'HEXFILE x.s19 is ignored'],
      ['S12-UNSUPPORTED', 'warning', 'MAPFILE SEC_ALLOC: section selection is not supported; the complete map is written'],
    ]);
  });

  it('L1302: an INCLUDE the caller cannot resolve', () => {
    const r = link(base({ objects: obj(), prmText: `INCLUDE more.prm\n${SIMPLE_PRM}`, prmPath: 'p.prm' }));
    expect(r.ok).toBe(false);
    expect(r.messages).toEqual([{ code: 'L1302', severity: 'error', text: 'File more.prm not found', file: 'p.prm' }]);
  });

  it('warns about variables placed into a READ_ONLY segment', () => {
    const r = link(base({ objects: obj(), prmText: SIMPLE_PRM.replace('SSTACK, DEFAULT_RAM INTO RAM;', 'SSTACK INTO RAM;\nDEFAULT_RAM INTO ROM_4000;') }));
    expect(r.messages).toEqual([
      { code: 'S12-PLACEMENT', severity: 'warning', text: 'Variables section .data placed in READ_ONLY segment ROM_4000', file: '.data' },
    ]);
  });
});

describe('INIT section rule', () => {
  it('only the input piece holding INIT moves to .init; the same-named section of another object stays put (UNCERTAIN)', () => {
    const other = makeObject('other.asm.o', {
      sections: [{ name: 'MyCode', kind: 'code', bytes: [0x3d] }],
      symbols: [{ name: 'Helper', section: 'MyCode', size: 1, global: true }],
    });
    const main = studentObject({
      code: [0x16, 0x00, 0x00, 0x20, 0xfb],
      symbols: [{ name: 'Helper', section: 'UND' }],
      relocs: [{ section: 'MyCode', offset: 1, sym: 'Helper' }],
    });
    const r = link(base({ objects: [{ name: 'main.asm.o', bytes: main }, { name: 'other.asm.o', bytes: other }] }));
    expect(r.messages).toEqual([]);
    expect(section(r, '.init')).toMatchObject({ address: 0xc000, size: 5 });
    expect(section(r, 'MyCode')).toMatchObject({ address: 0x4000, size: 1, segment: 'ROM_4000' });
    expect(symbol(r, 'Helper')!.address).toBe(0x4000);
  });
});

describe('burn()', () => {
  itFx('refuses to run without the .abs path (output names and S0 header come from it)', () => {
    const r = link(base({ objects: student(studentObject()) }));
    const b = burn({ absBytes: r.absBytes!, bblText: fixtureText('Lab3', 'prm', 'burner.bbl') });
    expect(b.ok).toBe(false);
    expect(b.outputs).toEqual([]);
    expect(b.messages).toEqual(['no .abs path given (absPath or env.ABS_FILE)']);
  });
});
