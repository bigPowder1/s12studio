// Regression tests for the adversarial review of @s12/formats (elf/).
import { describe, it, expect } from 'vitest';
import { readFixture, itFx, describeFx, hasFixtures } from './fixtures';
import {
  readElf,
  writeElf,
  cloneElf,
  ElfFormatError,
  inPlaceAddend,
  applyRelocation,
  UnknownRelocationError,
  readRelocationSections,
  relocKind,
  readSymbols,
  readHiwareLib,
  bytesEqual,
  SHT_NOBITS,
  type ElfRela,
  type ElfFile,
} from '../src/index';

const u8 = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
// Private fixtures (empty when absent: the tests using them are itFx).
const fx = (...p: string[]) => (hasFixtures ? u8(readFixture(...p)) : new Uint8Array(0));
const MAIN_O = fx('Lab3', 'Lab3_Data', 'Standard', 'ObjectCode', 'main.asm.o');
const LAB3_ABS = fx('Lab3', 'bin', 'Project.abs');
const BLANK_ABS = fx('blank_project', 'bin', 'Project.abs');
const LIB = fx('Lab3', 'Sources', 'Libraries', 'ME305LibV4.0.lib');
const rel = (type: number, width: number, offset: number): ElfRela => ({ offset, sym: 1, type, rawAddend: width - 1 });

describe('inPlaceAddend rejects unknown (type, width) pairs', () => {
  it('a hypothetical PCREL8 (type 3, width 8) throws instead of reading 0xFE as +254', () => {
    expect(() => inPlaceAddend(Uint8Array.from([0x20, 0xfe]), rel(3, 8, 1))).toThrow(UnknownRelocationError);
  });
  it('unknown type with a byte-multiple width throws', () => {
    expect(() => inPlaceAddend(Uint8Array.from([0, 0]), rel(2, 16, 0))).toThrow(UnknownRelocationError);
    expect(() => inPlaceAddend(Uint8Array.from([0, 0, 0, 0]), rel(1, 24, 0))).toThrow(UnknownRelocationError);
    expect(() => inPlaceAddend(Uint8Array.from([0, 0]), rel(5, 16, 0))).toThrow(UnknownRelocationError);
  });
  it('applyRelocation also rejects unknown pairs and leaves the target untouched', () => {
    const t = Uint8Array.from([0x20, 0xfe]);
    expect(() => applyRelocation(t, rel(3, 8, 1), 0x4000, 0xc000)).toThrow(UnknownRelocationError);
    expect(Array.from(t)).toEqual([0x20, 0xfe]);
  });
  it('a field past the end of the target throws', () => {
    expect(() => inPlaceAddend(Uint8Array.from([0x12]), rel(1, 16, 0))).toThrow(RangeError);
  });
  it('known pairs still work (signed PCREL16, unsigned ABS16/ABS32/PAGE8)', () => {
    expect(inPlaceAddend(Uint8Array.from([0xff, 0xfe]), rel(3, 16, 0))).toBe(-2);
    expect(inPlaceAddend(Uint8Array.from([0xff, 0xfe]), rel(1, 16, 0))).toBe(0xfffe);
    expect(inPlaceAddend(Uint8Array.from([0xff, 0xff, 0xff, 0xfe]), rel(1, 32, 0))).toBe(0xfffffffe);
    expect(inPlaceAddend(Uint8Array.from([0xff]), rel(5, 8, 0))).toBe(0xff);
  });
  itFx('every relocation in every fixture object has a readable in-place addend', () => {
    const lib = readHiwareLib(LIB);
    for (const elf of [readElf(MAIN_O), ...lib.members.map((m) => m.elf!)])
      for (const rs of readRelocationSections(elf))
        for (const r of rs.relocs) expect(() => inPlaceAddend(elf.sections[rs.target].data, r)).not.toThrow();
  });
});

describeFx('readElf: corrupt/truncated input raises ElfFormatError', () => {
  itFx('truncated section header table', () => {
    for (const cut of [MAIN_O.length - 1, MAIN_O.length - 40, readElf(MAIN_O).header.shoff + 3])
      expect(() => readElf(MAIN_O.subarray(0, cut))).toThrow(ElfFormatError);
  });
  itFx('truncated program header table (phdrs are at the end of EXEC files)', () => {
    expect(() => readElf(LAB3_ABS.subarray(0, LAB3_ABS.length - 1))).toThrow(ElfFormatError);
  });
  itFx('e_shoff pointing past the end', () => {
    const b = MAIN_O.slice();
    new DataView(b.buffer).setUint32(0x20, b.length);
    expect(() => readElf(b)).toThrow(ElfFormatError);
  });
  itFx('e_shstrndx out of range', () => {
    const b = MAIN_O.slice();
    new DataView(b.buffer).setUint16(0x32, 0xfff0);
    expect(() => readElf(b)).toThrow(ElfFormatError);
  });
  itFx('a header-only buffer', () => {
    expect(() => readElf(MAIN_O.subarray(0, 52))).toThrow(ElfFormatError);
  });
});

describeFx('aliasing: readElf views vs copies', () => {
  it('default readElf: section data are views (documented), so edits reach the input', () => {
    const src = MAIN_O.slice();
    const elf = readElf(src);
    const s = elf.sections.find((x) => x.data.length > 0)!;
    s.data[0] ^= 0xff;
    expect(src[s.offset]).toBe(MAIN_O[s.offset] ^ 0xff);
  });
  it('{copy:true} and cloneElf isolate the input buffer', () => {
    const src = MAIN_O.slice();
    for (const elf of [readElf(src, { copy: true }), cloneElf(readElf(src))]) {
      for (const s of elf.sections) s.data.fill(0xaa);
      expect(bytesEqual(src, MAIN_O)).toBe(true);
      elf.header.ident[0] = 0;
      expect(src[0]).toBe(0x7f);
    }
  });
  it('relocating a cloned library member leaves the .lib buffer and member.bytes untouched', () => {
    const buf = LIB.slice();
    const lib = readHiwareLib(buf);
    const pcrel = (elf: ElfFile) =>
      readRelocationSections(elf).flatMap((rs) => rs.relocs.filter((r) => relocKind(r) === 'PCREL16').map((r) => ({ r, t: rs.target })));
    // any member with a PC-relative relocation (found, not named here)
    const m = lib.members.find((x) => pcrel(x.elf!).length > 0)!;
    const before = m.bytes.slice();
    const elf = cloneElf(m.elf!);
    const pc = pcrel(elf);
    expect(pc.length).toBeGreaterThan(0);
    applyRelocation(elf.sections[pc[0].t].data, pc[0].r, 0x4000, 0xc000 + pc[0].r.offset);
    expect(bytesEqual(m.bytes, before)).toBe(true);
    expect(bytesEqual(buf, LIB)).toBe(true);
  });
  it('readHiwareLib {copy:true} never touches the caller buffer', () => {
    const buf = LIB.slice();
    const lib = readHiwareLib(buf, { copy: true });
    for (const m of lib.members) m.bytes.fill(0);
    expect(bytesEqual(buf, LIB)).toBe(true);
  });
});

describeFx('writeElf: program header filesz/memsz follow a single-section body', () => {
  it('growing a PROGBITS section updates p_offset, p_filesz and p_memsz of its segment', () => {
    const elf = cloneElf(readElf(BLANK_ABS));
    const i = elf.sections.findIndex((s) => s.name === 'Lib_Keypad');
    const grown = new Uint8Array(elf.sections[i].data.length + 8);
    grown.set(elf.sections[i].data);
    elf.sections[i].data = grown;
    const re = readElf(writeElf(elf));
    const p = re.programHeaders.find((x) => x.sectionIndex === i)!;
    expect(p.filesz).toBe(grown.length);
    expect(p.memsz).toBe(grown.length);
    for (const ph of re.programHeaders) expect(ph.offset).toBe(re.sections[ph.sectionIndex!].offset);
    // Every other segment is unchanged apart from p_offset.
    const orig = readElf(BLANK_ABS);
    re.programHeaders.forEach((ph, k) => {
      if (ph.sectionIndex === i) return;
      expect([ph.filesz, ph.memsz, ph.vaddr]).toEqual([orig.programHeaders[k].filesz, orig.programHeaders[k].memsz, orig.programHeaders[k].vaddr]);
    });
  });
  it('shrinking the .note section updates its PT_NOTE segment', () => {
    const elf = cloneElf(readElf(LAB3_ABS));
    const i = elf.sections.findIndex((s) => s.name === '.note');
    elf.sections[i].data = elf.sections[i].data.slice(0, 100);
    const re = readElf(writeElf(elf));
    const p = re.programHeaders.find((x) => x.sectionIndex === i)!;
    expect([p.filesz, p.memsz]).toEqual([100, 100]);
  });
  it('multi-section and NOBITS segments keep the caller-owned sizes (Lab3 .stack segment: .stack + .data)', () => {
    const elf = cloneElf(readElf(LAB3_ABS));
    const stack = elf.programHeaders.find((p) => elf.sections[p.sectionIndex!].name === '.stack')!;
    expect(elf.sections[stack.sectionIndex!].type).toBe(SHT_NOBITS);
    const memsz = stack.memsz;
    expect(stack.filesz).toBe(0);
    expect(memsz).toBeGreaterThan(elf.sections[stack.sectionIndex!].size); // spans more than .stack
    const re = readElf(writeElf(elf));
    const p2 = re.programHeaders.find((p) => re.sections[p.sectionIndex!].name === '.stack')!;
    expect([p2.filesz, p2.memsz]).toEqual([0, memsz]);
  });
  it('round trip of both Project.abs files is still byte-identical', () => {
    for (const b of [LAB3_ABS, BLANK_ABS]) expect(bytesEqual(writeElf(readElf(b)), b)).toBe(true);
  });
});
