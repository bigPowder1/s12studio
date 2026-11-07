import { describe, expect, it } from 'vitest';
import {
  STT_FUNC,
  STT_HIWARE_ALIAS,
  STT_OBJECT,
  SHN_ABS,
  decodeCwCompileUnit,
  parseHiwareNotes,
  noteDescString,
  readElf,
  readRelocationSections,
  readSymbols,
  relocKind,
  type ElfFile,
} from '@s12/formats';
import { buildAssemblerNotes, ctime } from '../src/index.js';
import { asmSource, hex, sectionBytes } from './helpers.js';

function info(elf: ElfFile) {
  const g = (n: string) => elf.sections.find((s) => s.name === n)!.data;
  const rel = (n: string) => readRelocationSections(elf).find((r) => elf.sections[r.target].name === n)?.relocs ?? [];
  return decodeCwCompileUnit({ info: g('.debug_info'), abbrev: g('.debug_abbrev'), line: g('.debug_line'), infoRelocs: rel('.debug_info'), lineRelocs: rel('.debug_line') });
}
const relocs = (elf: ElfFile, sec: string) => readRelocationSections(elf).find((r) => elf.sections[r.target].name === sec)?.relocs ?? [];

describe('object file', () => {
  it('section table, types and flags (code AX, constant A, data NOBITS WA, ORG with address)', () => {
    const r = asmSource('D: SECTION\nv: DS.B 2\nK: SECTION\nt: DC.B 1\nC: SECTION\n NOP\n ORG $C000\n DC.W 1\n ORG $80\nz: DS.B 1');
    const elf = readElf(r.objectBytes!);
    expect(elf.sections.map((s) => s.name)).toEqual([
      '', '.symtab', '.strtab', '.debug_info', '.debug_abbrev', '.debug_loc', '.debug_line', '.debug_frame',
      '_SEC000000', 'D', 'K', 'C', '_ORG00001', '_ORG00002', '.rela.debug_info', '.rela.debug_line', '.note', '.shstrtab',
    ]);
    const s = (n: string) => elf.sections.find((x) => x.name === n)!;
    expect([s('D').type, s('D').flags, s('D').size]).toEqual([8, 3, 2]);
    expect([s('K').type, s('K').flags]).toEqual([1, 2]);
    expect([s('C').type, s('C').flags]).toEqual([1, 6]);
    expect([s('_ORG00001').type, s('_ORG00001').flags, s('_ORG00001').addr]).toEqual([1, 2, 0xc000]);
    expect([s('_ORG00002').type, s('_ORG00002').addr, s('_ORG00002').size]).toEqual([8, 0x80, 1]);
    expect(elf.header.shstrndx).toBe(elf.sections.length - 1);
  });

  it('symbol order: data labels at definition, code labels by first reference, XDEF/XREF at declaration', () => {
    const src = [
      '        XDEF  main',
      '        XREF  ext2, ext1',
      'D:      SECTION',
      'v1:     DS.B  1',
      'v2:     DS.W  1',
      'C:      SECTION',
      'main:   JSR   sub2',
      'top:    JSR   sub1',
      '        BRA   top',
      'sub1:   LDAA  str',
      'sub2:   RTS',
      'unused: RTS',
      'str:    DC.B  "x",0',
      '        DC.B  1',
      '        ORG   $FFFE',
      '        DC.W  main',
    ].join('\n');
    const elf = readElf(asmSource(src).objectBytes!);
    const syms = readSymbols(elf);
    expect(syms.slice(1, 10).every((s) => s.type === 3)).toBe(true);
    expect(syms.slice(10).map((s) => s.name)).toEqual(['t.dbg', 'v1', 'v2', 'str', 'VAR00001', 'VAR00002', 'sub2', 'sub1', 'top', 'unused', 'main', 'ext2', 'ext1']);
    const symtab = elf.sections.find((s) => s.name === '.symtab')!;
    expect(symtab.info).toBe(syms.findIndex((s) => s.name === 'main'));
    const by = (n: string) => syms.find((s) => s.name === n)!;
    expect(by('main')).toMatchObject({ bind: 1, type: STT_FUNC, value: 0, size: 3 });
    expect(by('v2')).toMatchObject({ bind: 0, type: STT_OBJECT, value: 1, size: 2 });
    expect(by('str')).toMatchObject({ type: STT_FUNC, size: 2 });
    expect(by('VAR00002')).toMatchObject({ type: STT_OBJECT, shndx: SHN_ABS, value: 0xfffe, size: 2 });
    expect(by('ext1')).toMatchObject({ bind: 1, type: 0, shndx: 0 });
    // DWARF: defined globals first, then locals in symbol-table order; data typed from the directive.
    const cu = info(elf);
    expect(cu.entries.map((e) => e.name)).toEqual(['main', 'v1', 'v2', 'str', 'VAR00001', 'VAR00002', 'sub2', 'sub1', 'top', 'unused']);
    expect(cu.entries.find((e) => e.name === 'v2')).toMatchObject({ kind: 'variable', type: 1 });
    expect(cu.name).toBe('t.dbg');
    expect(cu.lineFile).toBe('C:\\proj\\bin\\t.dbg');
    expect(cu.compDir).toBe('C:\\proj\\bin');
  });

  it('labels sharing an address: the first allocated gets the size', () => {
    const elf = readElf(asmSource(' XDEF main\nC: SECTION\nmain:\nspin: BRA spin').objectBytes!);
    const syms = readSymbols(elf);
    expect(syms.filter((s) => s.name === 'main' || s.name === 'spin').map((s) => [s.name, s.size])).toEqual([
      ['spin', 0],
      ['main', 2],
    ]);
  });

  it('relocations: ABS16 with in-place addend, PCREL16 for long branches out of the section, ABS32, section symbol for *', () => {
    const r = asmSource(' XREF e\nD: SECTION\nbuf: DS.B 8\nC: SECTION\n LDY #buf+1\n CLR buf+4\n LBRA e\n LBEQ other\n DC.L e+2\n DC.W *\nO: SECTION\nother: NOP');
    expect(r.ok).toBe(true);
    const elf = readElf(r.objectBytes!);
    const syms = readSymbols(elf);
    const rs = relocs(elf, 'C');
    expect(rs.map((x) => [x.offset, syms[x.sym].name || `sec${syms[x.sym].shndx}`, relocKind(x)])).toEqual([
      [1, 'buf', 'ABS16'],
      [4, 'buf', 'ABS16'],
      [8, 'e', 'PCREL16'],
      [12, 'other', 'PCREL16'],
      [14, 'e', 'ABS32'],
      [18, 'sec10', 'ABS16'],
    ]);
    expect(hex(sectionBytes(r, 'C'))).toBe('CD 00 01 79 00 04 18 20 FF FE 18 27 FF FE 00 00 00 02 00 12');
    expect(r.listing!.text).toContain('000006 1820 xxxx');
  });

  it('CALL page via PAGE() gives a PAGE8 relocation', () => {
    const r = asmSource('F: SECTION\nfar: RTC\nC: SECTION\n CALL far,PAGE(far)\n LDAB #PAGE(far)');
    expect(r.ok).toBe(true);
    const elf = readElf(r.objectBytes!);
    expect(relocs(elf, 'C').map((x) => [x.offset, relocKind(x)])).toEqual([
      [1, 'ABS16'],
      [3, 'PAGE8'],
      [5, 'PAGE8'],
    ]);
  });

  it('EQU of an external symbol becomes a HIWARE alias symbol (type 13)', () => {
    const r = asmSource(' XREF depr\nalias1: EQU depr\nC: SECTION\n JSR alias1');
    const elf = readElf(r.objectBytes!);
    const syms = readSymbols(elf);
    const a = syms.find((s) => s.name === 'alias1')!;
    expect(a.type).toBe(STT_HIWARE_ALIAS);
    expect(syms[a.shndx].name).toBe('depr');
    expect(syms[relocs(elf, 'C')[0].sym].name).toBe('depr');
  });

  it('an XDEF\'d EQU constant is exported as an absolute global (UNCERTAIN)', () => {
    const elf = readElf(asmSource(' XDEF K\nK: EQU $1234\n NOP').objectBytes!);
    expect(readSymbols(elf).find((s) => s.name === 'K')).toMatchObject({ bind: 1, type: 0, shndx: SHN_ABS, value: 0x1234 });
  });

  it('line table: one sequence per code section, first row duplicated, rows at .dbg lines', () => {
    const r = asmSource('; c\nC: SECTION\naa: NOP\n LDAA #1\nm: MACRO\n NOP\n ENDM\n m\n DC.B 1,2');
    const cu = info(readElf(r.objectBytes!));
    expect(cu.sequences).toHaveLength(1);
    expect(cu.sequences[0].rows).toEqual([
      { address: 0, line: 3 },
      { address: 0, line: 3 },
      { address: 1, line: 4 },
      { address: 3, line: 9 },
      { address: 4, line: 10 },
    ]);
    expect(cu.sequences[0].end).toBe(4);
  });

  it('notes: producer, version, user, ctime, tool, command line (truncated to 1024)', () => {
    const r = asmSource(' NOP', '-CpuHCS12X', {}, { noteMeta: { user: 'student', time: 'Mon Oct 19 10:30:46 2026', commandLine: 'x'.repeat(2000) } });
    const elf = readElf(r.objectBytes!);
    const notes = parseHiwareNotes(elf.sections.find((s) => s.name === '.note')!.data).notes;
    expect(notes.map((n) => n.type)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(noteDescString(notes[0].desc)).toBe('Assembler for HC12 V-5.0.30 Build 10203, Jul 23 2010');
    expect(noteDescString(notes[4].desc)).toBe('student');
    expect(noteDescString(notes[6].desc)).toBe('Mon Oct 19 10:30:46 2026\n');
    expect(notes[7].desc).toEqual(Uint8Array.of(0x41));
    expect(notes[8].desc.length).toBe(1025);
    expect(buildAssemblerNotes({}, '-L')[8].desc).toEqual(Uint8Array.of(0x2d, 0x4c, 0));
  });

  it('ctime() formats like C', () => {
    expect(ctime(new Date(2026, 9, 5, 7, 8, 9))).toBe('Mon Oct  5 07:08:09 2026');
  });
});

describe('addressing-mode selection policy (critique G2)', () => {
  const bytes = (src: string, opts = '-CpuHCS12X') => {
    const r = asmSource('C: SECTION\n' + src, opts);
    expect(r.messages.filter((m) => m.severity === 'ERROR')).toEqual([]);
    return hex(sectionBytes(r, 'C'));
  };
  it('absolute <= $FF direct, larger extended; XREF and relocatable labels extended', () => {
    expect(bytes(' LDAA $40\n LDAA $100\n LDD $FF')).toBe('96 40 B6 01 00 DC FF');
    expect(bytes(' XREF e\n LDAA e\nl: LDAA l')).toBe('B6 00 00 B6 00 00');
  });
  it('labels in absolute sections are absolute (direct in page 0)', () => {
    const r = asmSource(' ORG $50\ndata: DS.B 1\nC: SECTION\n STAA data\n STAA $1150', '-CpuHCS12X');
    expect(hex(sectionBytes(r, 'C'))).toBe('5A 50 7A 11 50');
  });
  it('-CpDirect moves the direct window (HCS12X)', () => {
    const r = asmSource(' ORG $1150\ndd: DS.B 1\nC: SECTION\n STAA dd\n STAA $50', '-CpuHCS12X -CpDirect0x1100');
    expect(hex(sectionBytes(r, 'C'))).toBe('5A 50 7A 00 50');
  });
  it('force operators < > and .B .W', () => {
    expect(bytes(' LDAA >$40\n LDAA <$1240\nk: EQU $40\n LDAA k.W\n LDAA k.B\n LDAA 4,X\n LDAA >4,X\n LDAA <4,X')).toBe('B6 00 40 96 40 B6 00 40 96 40 A6 04 A6 E2 00 04 A6 E0 04');
  });
  it('UNCERTAIN: forward-referenced absolute operands are extended / 16-bit offsets', () => {
    expect(bytes(' LDAA fwd\n LDAA fwd,X\nfwd: EQU $40')).toBe('B6 00 40 A6 E2 00 40');
  });
  it('indexed offsets: 5, 9 and 16 bits; PCR picks the smallest fitting form', () => {
    expect(bytes(' LDAA 15,X\n LDAA 16,X\n LDAA -256,Y\n LDAA 256,SP\n LDAA $FFFF,X')).toBe('A6 0F A6 E0 10 A6 E9 00 A6 F2 01 00 A6 E2 FF FF');
    expect(bytes('l: LDAA l,PCR\n LDAA [l,PCR]')).toBe('A6 DE A6 FB FF FA');
  });
  it('MOVB/MOVW operand order: destination postbyte before an immediate/extended source', () => {
    expect(bytes(' MOVB #$12,5,X\n MOVW $1234,2,Y\n MOVB 1,X+,$2000\n MOVW #$1234,$2000\n MOVB $1000,$2000')).toBe(
      '18 08 05 12 18 01 42 12 34 18 0D 30 20 00 18 03 12 34 20 00 18 0C 10 00 20 00',
    );
  });
  it('MOVB PCR offset: HCS12/HCS12X not adapted, CPU12 adapted by -2 (manual -Cpu example)', () => {
    const src = ' ORG $3000\nOne: DC 1\nCopyOne: MOVB One,PCR,$1000';
    const b = (o: string) => hex(sectionBytes(asmSource(src, o), '_ORG00001'));
    expect(b('-CpuHCS12')).toBe('01 18 0D DA 10 00');
    expect(b('-CpuHCS12X')).toBe('01 18 0D DA 10 00');
    expect(b('-CpuCPU12')).toBe('01 18 0D DC 10 00');
  });
  it('branches are resolved inside a section and never relaxed', () => {
    expect(bytes('top: NOP\n BRA top\n LBRA top\n DBNE X,top\n BRSET 0,X,#1,top')).toBe('A7 20 FD 18 20 FF F9 04 35 F6 0E 00 01 F2');
  });
  it('aliases: LSL/BHS/CLI/TSX/... and S12X TFR spellings', () => {
    expect(bytes(' LSLA\n BHS *\n CLI\n SEI\n TSX\n INS\n DES\n XGDX\n TFR XL,A\n SEX A,D')).toBe('48 24 FE 10 EF 14 10 B7 75 1B 81 1B 9F B7 C5 B7 50 B7 04');
  });
});
