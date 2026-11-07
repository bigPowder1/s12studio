import { describe, it, expect } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  alignUp,
  signExtend,
  relocKind,
  requireRelocKind,
  findUnknownRelocations,
  relocFromKind,
  relocValue,
  applyRelocation,
  inPlaceAddend,
  UnknownRelocationError,
  parseHiwareNotes,
  buildHiwareNotes,
  hiwareNote,
  stringDesc,
  u32Desc,
  noteDescString,
  buildCwStringTable,
  readElf,
  writeElf,
  CW_ELF_IDENT,
  ET_REL,
  EM_68HC12,
  SHT_PROGBITS,
  SHT_STRTAB,
  SHF_ALLOC,
  SHF_EXECINSTR,
  type ElfFile,
  type ElfRela,
} from '../src/index';

describe('ByteReader / ByteWriter', () => {
  it('big-endian integers round-trip and grow past the initial capacity', () => {
    const w = new ByteWriter(1);
    for (let i = 0; i < 100; i++) w.u8(i).u16(0x1234).u32(0xdeadbeef).i8(-2).i16(-300).i32(-70000);
    const r = new ByteReader(w.finish());
    for (let i = 0; i < 100; i++) {
      expect([r.u8(), r.u16(), r.u32(), r.i8(), r.i16(), r.i32()]).toEqual([i, 0x1234, 0xdeadbeef, -2, -300, -70000]);
    }
    expect(r.eof).toBe(true);
  });

  it('LEB128 matches the DWARF spec examples', () => {
    const cases: [number, number[]][] = [
      [2, [2]],
      [127, [127]],
      [128, [0x80, 1]],
      [129, [0x81, 1]],
      [12857, [0xb9, 0x64]],
    ];
    for (const [v, b] of cases) {
      expect(Array.from(new ByteWriter().uleb128(v).finish())).toEqual(b);
      expect(new ByteReader(Uint8Array.from(b)).uleb128()).toBe(v);
    }
    const s: [number, number[]][] = [
      [2, [2]],
      [-2, [0x7e]],
      [127, [0xff, 0]],
      [-127, [0x81, 0x7f]],
      [128, [0x80, 1]],
      [-128, [0x80, 0x7f]],
      [129, [0x81, 1]],
      [-129, [0xff, 0x7e]],
    ];
    for (const [v, b] of s) {
      expect(Array.from(new ByteWriter().sleb128(v).finish())).toEqual(b);
      expect(new ByteReader(Uint8Array.from(b)).sleb128()).toBe(v);
    }
  });

  it('cstr, align, bounds', () => {
    const w = new ByteWriter().cstr('ab').align(4).cstr('');
    expect(Array.from(w.finish())).toEqual([0x61, 0x62, 0, 0, 0]);
    const r = new ByteReader(w.finish());
    expect(r.cstr()).toBe('ab');
    r.align(4);
    expect(r.cstr()).toBe('');
    expect(() => r.u8()).toThrow(RangeError);
    expect(alignUp(0x2337, 4)).toBe(0x2338);
    expect(signExtend(0xfffe, 16)).toBe(-2);
  });
});

describe('HIWARE relocations', () => {
  const r = (type: number, width: number, offset = 0): ElfRela => ({ offset, sym: 1, type, rawAddend: width - 1 });

  it('classifies the four known (type, width) pairs', () => {
    expect(relocKind(r(1, 16))).toBe('ABS16');
    expect(relocKind(r(1, 32))).toBe('ABS32');
    expect(relocKind(r(3, 16))).toBe('PCREL16');
    expect(relocKind(r(5, 8))).toBe('PAGE8');
  });

  it('reports unknown pairs instead of accepting them', () => {
    const bad = [r(1, 8), r(3, 8), r(5, 16), r(2, 16), r(7, 16)];
    expect(findUnknownRelocations([r(1, 16), ...bad])).toEqual(bad);
    for (const b of bad) {
      expect(relocKind(b)).toBeUndefined();
      expect(() => requireRelocKind(b)).toThrow(UnknownRelocationError);
      expect(() => relocValue(b, 0, 0, 0)).toThrow(UnknownRelocationError);
    }
  });

  it('relocFromKind encodes width-1 in r_addend', () => {
    expect(relocFromKind('ABS16', 5, 9)).toEqual({ offset: 5, sym: 9, type: 1, rawAddend: 0x0f });
    expect(relocFromKind('ABS32', 6, 2)).toEqual({ offset: 6, sym: 2, type: 1, rawAddend: 0x1f });
    expect(relocFromKind('PCREL16', 0, 1).type).toBe(3);
    expect(relocFromKind('PAGE8', 0, 1)).toMatchObject({ type: 5, rawAddend: 7 });
  });

  it('applies ABS16 (S+A), PCREL16 (S+A−P) and PAGE8 ((S+A)>>16)', () => {
    // ldy #<sym>+1 : CD 00 01 → S = 0x2003
    const abs = Uint8Array.from([0xcd, 0x00, 0x01]);
    applyRelocation(abs, r(1, 16, 1), 0x2003, 0);
    expect(Array.from(abs)).toEqual([0xcd, 0x20, 0x04]);
    // LBRA <sym>: 18 20 FF FE with the field at 0xC102, S = 0x4000
    const pc = Uint8Array.from([0x18, 0x20, 0xff, 0xfe]);
    expect(inPlaceAddend(pc, r(3, 16, 2))).toBe(-2);
    applyRelocation(pc, r(3, 16, 2), 0x4000, 0xc102);
    expect((pc[2] << 8) | pc[3]).toBe((0x4000 - 2 - 0xc102) & 0xffff);
    const page = Uint8Array.from([0, 0, 0x12, 0x34]);
    applyRelocation(page, r(5, 8, 1), 0x7f4000, 0);
    expect(page[1]).toBe(0x7f);
  });
});

describe('HIWARE notes (unit)', () => {
  it('packs records without alignment', () => {
    const notes = [hiwareNote(1, stringDesc('X')), hiwareNote(2, u32Desc(5040))];
    const bytes = buildHiwareNotes(notes);
    // 12-byte header + 10-byte name + 2-byte desc, then the next record immediately (offset 24, unaligned)
    expect(bytes.length).toBe(12 + 10 + 2 + 12 + 10 + 4);
    const back = parseHiwareNotes(bytes);
    expect(back.notes.map((n) => [n.type, n.name])).toEqual([
      [1, 'HIWARE AG'],
      [2, 'HIWARE AG'],
    ]);
    expect(noteDescString(back.notes[0].desc)).toBe('X');
  });
});

describe('ELF writer from scratch', () => {
  it('lays out a minimal REL object the CW way and reads it back', () => {
    const names = ['.text_like', '.shstrtab'];
    const { data: shstr, offsets } = buildCwStringTable(names);
    const body = Uint8Array.from([1, 2, 3]);
    const elf: ElfFile = {
      header: {
        ident: CW_ELF_IDENT,
        type: ET_REL,
        machine: EM_68HC12,
        version: 1,
        entry: 0,
        phoff: 0,
        shoff: 0,
        flags: 0,
        ehsize: 52,
        phentsize: 0,
        phnum: 0,
        shentsize: 40,
        shnum: 0,
        shstrndx: 2,
      },
      sections: [
        { name: '', nameOffset: 0, type: 0, flags: 0, addr: 0, offset: 0, size: 0, link: 0, info: 0, addralign: 0, entsize: 0, data: new Uint8Array(0) },
        { name: names[0], nameOffset: offsets[0], type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_EXECINSTR, addr: 0, offset: 0, size: 0, link: 0, info: 0, addralign: 1, entsize: 0, data: body },
        { name: names[1], nameOffset: offsets[1], type: SHT_STRTAB, flags: 0, addr: 0, offset: 0, size: 0, link: 0, info: 0, addralign: 1, entsize: 0, data: shstr },
      ],
      programHeaders: [],
    };
    const bytes = writeElf(elf);
    const back = readElf(bytes);
    expect(back.sections.map((s) => s.name)).toEqual(['', '.text_like', '.shstrtab']);
    expect(back.sections[1].offset).toBe(52);
    expect(back.sections[2].offset).toBe(56); // 52+3 → aligned to 4
    expect(back.header.shoff).toBe(56 + shstr.length); // shdrs follow unaligned
    expect(back.header.phoff).toBe(bytes.length);
    expect(Array.from(back.sections[1].data)).toEqual([1, 2, 3]);
  });
});
