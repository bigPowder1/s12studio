// Unit tests of SmartLinker semantics on synthetic CodeWarrior-dialect objects.
import { describe, expect, it } from 'vitest';
import { readElf, readSymbols, readSRecords, SHN_ABS } from '@s12/formats';
import { burnFull, link, linkerCommandLine, ctime, formatLinkMessage, type LinkInput } from '@s12/link';
import { LIB, SIMPLE_PRM, makeObject, prm, studentObject, fixtureText, itFx } from './helpers';

const base = (over: Partial<LinkInput>): LinkInput => ({
  prmText: SIMPLE_PRM,
  outputPath: 'C:\\p\\bin\\Project.abs',
  noteMeta: { user: 'me', created: 'Thu Jan  1 00:00:00 2026\n' },
  ...over,
});
const codes = (r: { messages: { code: string }[] }) => r.messages.map((m) => m.code);
const section = (r: ReturnType<typeof link>, name: string) => r.layout.sections.find((s) => s.name === name);
const symbol = (r: ReturnType<typeof link>, name: string) => r.layout.symbols.find((s) => s.name === name);

describe('basic linking', () => {
  const r = link(base({ objects: [{ name: 'main.asm.o', bytes: studentObject() }] }));

  it('links, applies relocations and places the INIT section in .init', () => {
    expect(r.messages).toEqual([]);
    expect(r.ok).toBe(true);
    // Entry's section (MyCode) holds INIT -> renamed .init and placed with _PRESTART in ROM_C000
    expect(section(r, '.init')).toMatchObject({ address: 0xc000, size: 5, segment: 'ROM_C000' });
    expect(section(r, 'MyCode')).toBeUndefined();
    expect(section(r, '.stack')).toMatchObject({ address: 0x2000, size: 0x100, access: 'R/W' });
    expect(section(r, '.data')).toMatchObject({ address: 0x2100, size: 2 });
    expect(section(r, 'main.asm__ORG00001')).toMatchObject({ address: 0xfffe, segment: '.absSeg0', kind: 'org' });
    const elf = readElf(r.absBytes!);
    expect(elf.header.entry).toBe(0xc000);
    const init = elf.sections.find((s) => s.name === '.init')!;
    expect([...init.data]).toEqual([0x79, 0x21, 0x00, 0x20, 0xfb]); // clr counter -> $2100
    expect([...elf.sections.find((s) => s.name === 'main.asm__ORG00001')!.data]).toEqual([0xc0, 0x00]);
  });

  it('writes the symbol table CW-style (ABS ORG data in a shndx-0 group, globals last)', () => {
    const elf = readElf(r.absBytes!);
    const syms = readSymbols(elf);
    const names = syms.map((s) => s.name);
    expect(names).toContain('main.dbg');
    const v = syms.find((s) => s.name === 'VAR00001')!;
    expect(v.shndx).toBe(SHN_ABS);
    const symtab = elf.sections.find((s) => s.name === '.symtab')!;
    expect(syms.slice(symtab.info).map((s) => s.name)).toEqual(['Entry']);
  });

  it('linked-in modules and objects appear in the layout', () => {
    expect(r.layout.modules).toEqual([{ name: 'main.asm.o', library: undefined }]);
    expect(symbol(r, 'counter')).toMatchObject({ address: 0x2100, kind: 'variable', refs: 1, section: '.data' });
    expect(symbol(r, 'Entry')).toMatchObject({ address: 0xc000, kind: 'procedure', refs: 1, section: '.init' });
    expect(symbol(r, 'VAR00001')).toMatchObject({ address: 0xfffe, section: '.text' });
  });

  it('the map lists the sections, objects and statistic', () => {
    const map = r.mapText!;
    expect(map.startsWith('\r\nPROGRAM "C:\\p\\bin\\Project.abs"\r\n')).toBe(true);
    expect(map).toContain('\r\n.init                              5     R     0xC000     0xC004   ROM_C000\r\n');
    expect(map).toContain('Entry point: 0xC000 (Entry)');
    expect(map).toContain('Number of blocks to be downloaded: 2\r\n');
    expect(map).toContain('Total size of all blocks to be downloaded: 7\r\n');
    expect(map.endsWith('\r\n\r\n')).toBe(true);
  });
});

describe('symbol resolution diagnostics', () => {
  it('L1822: a relocation to an undefined symbol is an error; a bare XREF is not', () => {
    const obj = studentObject({
      code: [0x16, 0x00, 0x00, 0x20, 0xfb],
      symbols: [{ name: 'MISSING', section: 'UND' }, { name: 'UNUSED_XREF', section: 'UND' }],
      relocs: [{ section: 'MyCode', offset: 1, sym: 'MISSING' }],
    });
    const r = link(base({ objects: [{ name: 'main.asm.o', bytes: obj }] }));
    expect(r.ok).toBe(false);
    expect(r.absBytes).toBeUndefined();
    expect(r.messages).toEqual([
      { code: 'L1822', severity: 'error', text: 'Symbol MISSING in file main.asm.o is undefined', file: 'main.asm.o' },
    ]);
    expect(formatLinkMessage(r.messages[0])).toBe('Link Error : L1822: Symbol MISSING in file main.asm.o is undefined');
  });

  it('L1818: duplicate global definitions', () => {
    const other = makeObject('other.asm.o', {
      sections: [{ name: 'OtherCode', kind: 'code', bytes: [0x3d] }],
      symbols: [{ name: 'Entry', section: 'OtherCode', size: 1, global: true }],
    });
    const r = link(base({ objects: [{ name: 'main.asm.o', bytes: studentObject() }, { name: 'other.asm.o', bytes: other }] }));
    expect(r.ok).toBe(false);
    expect(r.messages).toContainEqual({
      // "Symbol <n> - <name> duplicated in <first> and <second>"; n = Entry's symbol index in other.asm.o
      code: 'L1818', severity: 'error', text: 'Symbol 3 - Entry duplicated in main.asm.o and other.asm.o', file: 'other.asm.o',
    });
  });

  itFx('an object definition wins over a library member (the member is not linked)', () => {
    const obj = studentObject({
      code: [0x16, 0x00, 0x00, 0x20, 0xfb],
      sections: [{ name: 'Mine', kind: 'code', bytes: [0x3d] }],
      symbols: [{ name: 'DELAY_MILLI', section: 'Mine', size: 1, global: true }],
      relocs: [{ section: 'MyCode', offset: 1, sym: 'DELAY_MILLI' }],
    });
    const r = link(base({
      objects: [{ name: 'main.asm.o', bytes: obj }],
      libraries: [{ name: 'ME305LibV4.0.lib', bytes: LIB() }],
      prmText: SIMPLE_PRM.replace('MyCode INTO ROM_4000;', 'MyCode, Mine INTO ROM_4000;'),
    }));
    expect(r.messages).toEqual([]);
    expect(r.layout.modules.map((m) => m.name)).toEqual(['main.asm.o']);
    expect(symbol(r, 'DELAY_MILLI')).toMatchObject({ address: 0x4000, refs: 1 });
  });

  it('INIT object missing', () => {
    const r = link(base({ objects: [{ name: 'main.asm.o', bytes: studentObject() }], prmText: SIMPLE_PRM.replace('INIT Entry', 'INIT Nowhere') }));
    expect(codes(r)).toContain('L1106');
  });

  it('L1303: input that is not ELF', () => {
    const r = link(base({ objects: [{ name: 'bad.o', bytes: Uint8Array.of(1, 2, 3) }] }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['L1303']);
  });

  it('L1907: unknown relocation (type, width) pairs are rejected', () => {
    const obj = studentObject({ relocs: [{ section: 'MyCode', offset: 3, sym: 'Entry', raw: { type: 2, rawAddend: 7 } }] });
    const r = link(base({ objects: [{ name: 'main.asm.o', bytes: obj }] }));
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['L1907']);
  });

  it('L1907: 16-bit fixup overflow against a 24-bit (paged) address', () => {
    const obj = studentObject({
      code: [0x16, 0x00, 0x00, 0x20, 0xfb],
      sections: [{ name: 'Far', kind: 'code', bytes: [0x3d] }],
      symbols: [{ name: 'FarSub', section: 'Far', size: 1, global: true }],
      relocs: [{ section: 'MyCode', offset: 1, sym: 'FarSub' }],
    });
    const r = link(base({
      objects: [{ name: 'main.asm.o', bytes: obj }],
      prmText: prm({
        segments: 'RAM = READ_WRITE 0x2000 TO 0x3FFF;\nROM_C000 = READ_ONLY 0xC000 TO 0xFEFF;\nPAGE_FE = READ_ONLY 0xFE8000 TO 0xFEBFFF;',
        placement: '_PRESTART INTO ROM_C000;\nSSTACK, DEFAULT_RAM INTO RAM;\nFar INTO PAGE_FE;',
        extra: 'STACKSIZE 0x100\nINIT Entry',
      }),
    }));
    expect(section(r, 'Far')!.address).toBe(0xfe8000);
    // SmartLinker form "Fixup overflow in <object holding the fixup>, to <target> type <ELF type>, at offset <off>"
    expect(r.messages).toEqual([
      { code: 'L1907', severity: 'error', text: 'Fixup overflow in Entry, to FarSub type 1, at offset 0x1', file: 'main.asm.o' },
    ]);
  });
});

describe('placement', () => {
  const three = makeObject('m.asm.o', {
    sections: [
      { name: 'A', kind: 'code', bytes: new Array(0x30).fill(1) },
      { name: 'B', kind: 'code', bytes: new Array(0x20).fill(2) },
      { name: 'C', kind: 'code', bytes: new Array(0x10).fill(3) },
      { name: 'Boot', kind: 'code', bytes: [0x3d] },
      { name: 'DEFAULT_RAM', kind: 'data', size: 4 },
    ],
    symbols: [
      { name: 'Entry', section: 'Boot', size: 1, global: true },
      { name: 'a', section: 'A', global: true }, { name: 'b', section: 'B', global: true }, { name: 'c', section: 'C', global: true },
      { name: 'v', section: 'DEFAULT_RAM', size: 4, type: 'object' },
    ],
  });
  const segments = 'S1 = READ_ONLY 0x4000 TO 0x403F;\nS2 = READ_ONLY 0x5000 TO 0x5FFF;\nRAM = READ_WRITE 0x2000 TO 0x2FFF;\nROM_C000 = READ_ONLY 0xC000 TO 0xFEFF;';

  it('sections are allocated in PLACEMENT order; -AllocNext never goes back to a gap (C goes to S2, not S1)', () => {
    const r = link(base({
      objects: [{ name: 'm.asm.o', bytes: three }],
      prmText: prm({ segments, placement: '_PRESTART INTO ROM_C000;\nA, B, C INTO S1, S2;\nDEFAULT_RAM INTO RAM;', extra: 'ENTRIES * END\nINIT Entry' }),
    }));
    expect(r.messages).toEqual([{ code: 'L1201', severity: 'warning', text: 'No stack defined' }]);
    expect(r.ok).toBe(true);
    // BTU -Alloc: "the linker always takes the next segment as soon as the current segment is full. Gaps resulting
    // from this process are not used later."
    expect([section(r, 'A')!.address, section(r, 'B')!.address, section(r, 'C')!.address]).toEqual([0x4000, 0x5000, 0x5020]);
    expect(r.layout.sections.map((s) => s.name)).toEqual(['.init', 'A', 'B', 'C', '.data']);
    // the map's SECTION-ALLOCATION follows the allocation order
    const lines = r.mapText!.split('\r\n');
    const i = lines.indexOf('SECTION-ALLOCATION SECTION');
    expect(lines.slice(i + 3, i + 8).map((l) => l.split(/\s+/)[0])).toEqual(['.init', 'A', 'B', 'C', '.data']);
  });

  it('reordering the PLACEMENT changes the allocation', () => {
    const r = link(base({
      objects: [{ name: 'm.asm.o', bytes: three }],
      prmText: prm({ segments, placement: '_PRESTART INTO ROM_C000;\nC, B, A INTO S1, S2;\nDEFAULT_RAM INTO RAM;', extra: 'ENTRIES * END\nINIT Entry' }),
    }));
    expect([section(r, 'C')!.address, section(r, 'B')!.address, section(r, 'A')!.address]).toEqual([0x4000, 0x4010, 0x5000]);
  });

  it('DISTRIBUTE_INTO allocates like INTO (whole sections, -AllocNext)', () => {
    const r = link(base({
      objects: [{ name: 'm.asm.o', bytes: three }],
      prmText: prm({ segments, placement: '_PRESTART INTO ROM_C000;\nA, B, C DISTRIBUTE_INTO S1, S2;\nDEFAULT_RAM INTO RAM;', extra: 'ENTRIES * END\nINIT Entry' }),
    }));
    expect([section(r, 'A')!.address, section(r, 'B')!.address, section(r, 'C')!.address]).toEqual([0x4000, 0x5000, 0x5020]);
  });

  it('options.alloc next / change / first reproduce the BTU -Alloc example', () => {
    // BTU -Alloc page: objects AAAA BB CCC D EEE FFFFF into segments of 3, 7 and 12 bytes:
    //   AllocNext:   --- AAAABB- CCCDEEEFFFFF
    //   AllocChange: CCC AAAABBD EEEFFFFF----
    //   AllocFirst:  BBD AAAACCC EEEFFFFF----
    const sizes: Record<string, number> = { A: 4, B: 2, C: 3, D: 1, E: 3, F: 5 };
    const obj = makeObject('m.asm.o', {
      sections: [{ name: 'Boot', kind: 'code', bytes: [0x3d] }, ...Object.entries(sizes).map(([name, n]) => ({ name, kind: 'code' as const, bytes: new Array(n).fill(0) }))],
      symbols: [{ name: 'Entry', section: 'Boot', size: 1, global: true }],
    });
    const segs = 'G1 = READ_ONLY 0x4000 TO 0x4002;\nG2 = READ_ONLY 0x5000 TO 0x5006;\nG3 = READ_ONLY 0x6000 TO 0x600B;\nROM_C000 = READ_ONLY 0xC000 TO 0xFEFF;';
    const picture = (alloc: 'next' | 'change' | 'first') => {
      const r = link(base({
        objects: [{ name: 'm.asm.o', bytes: obj }],
        prmText: prm({ segments: segs, placement: '_PRESTART INTO ROM_C000;\nA, B, C, D, E, F INTO G1, G2, G3;', extra: 'ENTRIES * END\nINIT Entry' }),
        options: { alloc },
      }));
      expect(r.messages.filter((m) => m.severity === 'error')).toEqual([]);
      const cells = [new Array(3).fill('-'), new Array(7).fill('-'), new Array(12).fill('-')];
      for (const name of Object.keys(sizes)) {
        const s = section(r, name)!;
        const g = [0x4000, 0x5000, 0x6000].indexOf(s.address & 0xf000);
        for (let k = 0; k < s.size; k++) cells[g][(s.address & 0xfff) + k] = name;
      }
      return cells.map((c) => c.join('')).join(' ');
    };
    expect(picture('next')).toBe('--- AAAABB- CCCDEEEFFFFF');
    expect(picture('change')).toBe('CCC AAAABBD EEEFFFFF----');
    expect(picture('first')).toBe('BBD AAAACCC EEEFFFFF----');
  });

  it('the -AllocNext cursor is per placement statement', () => {
    const r = link(base({
      objects: [{ name: 'm.asm.o', bytes: three }],
      prmText: prm({ segments, placement: '_PRESTART INTO ROM_C000;\nA, B INTO S1, S2;\nC INTO S1, S2;\nDEFAULT_RAM INTO RAM;', extra: 'ENTRIES * END\nINIT Entry' }),
    }));
    expect([section(r, 'A')!.address, section(r, 'B')!.address, section(r, 'C')!.address]).toEqual([0x4000, 0x5000, 0x4030]);
  });

  it('L1102: segment overflow', () => {
    const r = link(base({
      objects: [{ name: 'm.asm.o', bytes: three }],
      prmText: prm({ segments, placement: '_PRESTART INTO ROM_C000;\nA, B, C INTO S1;\nDEFAULT_RAM INTO RAM;', extra: 'ENTRIES * END\nINIT Entry' }),
    }));
    expect(r.ok).toBe(false);
    // B (0x20) does not fit after A; the failure does not move the cursor, so C (0x10) still fits at 0x4030
    expect(r.messages.filter((m) => m.code === 'L1102')).toEqual([
      { code: 'L1102', severity: 'error', text: 'Out of allocation space in segment S1 at address 0x4030', file: 'B' },
    ]);
    expect(section(r, 'C')!.address).toBe(0x4030);
  });

  it('L1009: unknown segment in PLACEMENT', () => {
    const r = link(base({
      objects: [{ name: 'm.asm.o', bytes: three }],
      prmText: prm({ segments, placement: '_PRESTART INTO ROM_C000;\nA, B, C INTO NOPE, S2;\nDEFAULT_RAM INTO RAM;', extra: 'ENTRIES * END\nINIT Entry' }),
    }));
    expect(codes(r)).toEqual(expect.arrayContaining(['L1009']));
    expect(section(r, 'A')!.address).toBe(0x5000);
  });

  it('STACKSIZE without SSTACK in PLACEMENT puts the stack after .data; __SEG_END_SSTACK resolves', () => {
    const obj = studentObject({
      code: [0x79, 0x00, 0x00, 0xcf, 0x00, 0x00, 0x20, 0xfb],
      symbols: [{ name: '__SEG_END_SSTACK', section: 'UND' }],
      relocs: [{ section: 'MyCode', offset: 4, sym: '__SEG_END_SSTACK' }],
    });
    const r = link(base({ objects: [{ name: 'main.asm.o', bytes: obj }], prmText: SIMPLE_PRM.replace('SSTACK, DEFAULT_RAM', 'DEFAULT_RAM') }));
    expect(r.messages).toEqual([]);
    expect(section(r, '.data')!.address).toBe(0x2000);
    expect(section(r, '.stack')).toMatchObject({ address: 0x2002, size: 0x100 });
    expect(symbol(r, '__SEG_END_SSTACK')).toMatchObject({ address: 0x2102, kind: 'label', binding: 'linker', section: '' });
    expect([...readElf(r.absBytes!).sections.find((s) => s.name === '.init')!.data.subarray(3, 6)]).toEqual([0xcf, 0x21, 0x02]);
    expect(r.mapText).toContain('- LABELS:\r\n     __SEG_END_SSTACK                          2102       0       0       1               \r\n');
  });

  it('L1823: an unknown __SEG_ symbol is created with value 0', () => {
    const obj = studentObject({
      code: [0xcf, 0x00, 0x00, 0x20, 0xfb],
      symbols: [{ name: '__SEG_START_NOWHERE', section: 'UND' }],
      relocs: [{ section: 'MyCode', offset: 1, sym: '__SEG_START_NOWHERE' }],
    });
    const r = link(base({ objects: [{ name: 'main.asm.o', bytes: obj }] }));
    expect(r.ok).toBe(true);
    expect(codes(r)).toEqual(['L1823']);
  });

  it('L1200: both STACKSIZE and STACKTOP', () => {
    const r = link(base({ objects: [{ name: 'main.asm.o', bytes: studentObject() }], prmText: `${SIMPLE_PRM}\nSTACKTOP 0x3FFF\n` }));
    expect(codes(r)).toContain('L1200');
  });
});

describe('smart linking', () => {
  it('unreferenced sections of objects are dropped unless listed in ENTRIES', () => {
    const obj = studentObject({ sections: [{ name: 'Unused', kind: 'code', bytes: [1, 2, 3] }], symbols: [{ name: 'dead', section: 'Unused', size: 3 }] });
    const prmText = SIMPLE_PRM.replace('MyCode INTO ROM_4000;', 'MyCode, Unused INTO ROM_4000;');
    const dropped = link(base({ objects: [{ name: 'main.asm.o', bytes: obj }], prmText }));
    expect(section(dropped, 'Unused')).toBeUndefined();
    expect(symbol(dropped, 'dead')).toBeUndefined();
    const kept = link(base({ objects: [{ name: 'main.asm.o', bytes: obj }], prmText: `${prmText}\nENTRIES main.asm.o:dead END\n` }));
    expect(section(kept, 'Unused')).toMatchObject({ address: 0x4000, size: 3 });
  });

});

describe('VECTOR command', () => {
  const obj = makeObject('main.asm.o', {
    sections: [{ name: 'MyCode', kind: 'code', bytes: [0x20, 0xfe, 0x0b] }],
    symbols: [{ name: 'Entry', section: 'MyCode', size: 2, global: true }, { name: 'ISR', section: 'MyCode', value: 2, size: 1, global: true }],
  });
  const prmText = SIMPLE_PRM.replace('INIT Entry', 'INIT Entry\nVECTOR 0 Entry\nVECTOR ADDRESS 0xFFCE ISR\nVECTOR 1 0x1234');
  const r = link(base({ objects: [{ name: 'main.asm.o', bytes: obj }], prmText }));

  it('creates initialised vector entries (VECTOR n -> 0xFFFE - 2n)', () => {
    expect(r.messages).toEqual([]);
    expect(r.layout.sections.filter((s) => s.kind === 'vector').map((s) => [s.name, s.address, s.segment])).toEqual([
      ['.vectSeg0_vect', 0xfffe, '.vectSeg0'],
      ['.vectSeg1_vect', 0xffce, '.vectSeg1'],
      ['.vectSeg2_vect', 0xfffc, '.vectSeg2'],
    ]);
    const s19 = readSRecords(burnFull(r.absBytes!).text);
    const at = (a: number) => s19.blocks.find((b) => a >= b.address && a < b.address + b.data.length)!;
    const word = (a: number) => (at(a).data[a - at(a).address] << 8) | at(a).data[a - at(a).address + 1];
    expect(word(0xfffe)).toBe(0xc000);
    expect(word(0xffce)).toBe(0xc002);
    expect(word(0xfffc)).toBe(0x1234);
  });

  it('the map lists them in VECTOR-ALLOCATION', () => {
    expect(r.mapText).toContain('    Address     InitValue   InitFunction\r\n' + '-'.repeat(93) + '\r\n     0xFFFE        0xC000   Entry\r\n     0xFFCE        0xC002   ISR\r\n     0xFFFC        0x1234   \r\n');
  });

  it('L1119: a VECTOR overlapping an ORG section', () => {
    const r2 = link(base({ objects: [{ name: 'main.asm.o', bytes: studentObject() }], prmText: SIMPLE_PRM.replace('INIT Entry', 'INIT Entry\nVECTOR 0 Entry') }));
    expect(r2.messages).toContainEqual({
      code: 'L1119', severity: 'error', text: 'Vector allocated at absolute address 0xFFFE overlaps with sections placed in segment .absSeg0',
    });
  });
});

describe('note and command line helpers', () => {
  it('linkerCommandLine matches the IDE format', () => {
    expect(linkerCommandLine(['C:\\a.lib', 'C:\\m.o'], 'C:\\p.abs', [['GENPATH', 'C:\\x']])).toBe(
      '-add("C:\\a.lib"  "C:\\m.o" ) -o"C:\\p.abs" -env"GENPATH=C:\\x" ',
    );
  });
  it('ctime pads the day with a space', () => {
    expect(ctime(new Date(2026, 8, 4, 7, 5, 3))).toBe('Fri Sep  4 07:05:03 2026');
  });
  it('the command-line note is truncated to 1024 bytes', () => {
    const r = link(base({ objects: [{ name: 'main.asm.o', bytes: studentObject() }], noteMeta: { user: 'u', created: 'x\n', commandLine: 'y'.repeat(3000) } }));
    expect(r.ok).toBe(true);
    const note = readElf(r.absBytes!).sections.find((s) => s.name === '.note')!;
    expect(Buffer.from(note.data).toString('latin1')).toContain(`${'y'.repeat(1024)}\0`);
    expect(Buffer.from(note.data).toString('latin1')).not.toContain('y'.repeat(1025));
  });
});
