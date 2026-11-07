import { ByteWriter, alignUp, latin1BestFitBytes } from '../util/bytes';
import { ELF_HEADER_SIZE, ELF_PHDR_SIZE, ELF_SHDR_SIZE, SHT_NOBITS, type ElfFile, type ElfProgramHeader } from './types';

export interface ElfLayout {
  /** File offset of each section (index-aligned with `sections`). */
  sectionOffsets: number[];
  shoff: number;
  phoff: number;
  /** Total file size. */
  size: number;
}

/**
 * CodeWarrior file layout (verified on main.asm.o, all 8 library members, both Project.abs):
 * ELF header; section bodies in section-table order, each starting at a 4-aligned offset (NOBITS and empty
 * sections take the aligned position but occupy nothing); the section header table immediately after the last
 * body (NOT aligned); then the program header table (e_phoff = end of shdr table, which for REL objects with no
 * phdrs equals the file size). Gaps are zero.
 */
export function layoutElf(elf: ElfFile): ElfLayout {
  const sectionOffsets: number[] = [];
  let pos = ELF_HEADER_SIZE;
  elf.sections.forEach((s, i) => {
    if (i === 0) {
      sectionOffsets.push(0);
      return;
    }
    // UNCERTAIN: CW always uses 4 here (sh_addralign is 1 or 0 on all observed bodies); larger alignments unseen.
    const off = alignUp(pos, Math.max(4, s.addralign));
    sectionOffsets.push(off);
    pos = s.type === SHT_NOBITS ? off : off + s.data.length;
  });
  const shoff = pos;
  const phoff = shoff + elf.sections.length * ELF_SHDR_SIZE;
  const phentsize = elf.programHeaders.length ? elf.header.phentsize || ELF_PHDR_SIZE : elf.header.phentsize;
  return { sectionOffsets, shoff, phoff, size: phoff + elf.programHeaders.length * phentsize };
}

/** Serialize an ElfFile using the CodeWarrior layout (offsets in the model are ignored and recomputed). */
export function writeElf(elf: ElfFile): Uint8Array {
  const lay = layoutElf(elf);
  const out = new Uint8Array(lay.size);
  const w = new ByteWriter(ELF_HEADER_SIZE);
  const h = elf.header;
  const phnum = elf.programHeaders.length;
  const phentsize = phnum ? h.phentsize || ELF_PHDR_SIZE : h.phentsize;
  w.bytes(h.ident.length === 16 ? h.ident : defaultIdent())
    .u16(h.type)
    .u16(h.machine)
    .u32(h.version)
    .u32(h.entry)
    .u32(lay.phoff)
    .u32(lay.shoff)
    .u32(h.flags)
    .u16(h.ehsize || ELF_HEADER_SIZE)
    .u16(phentsize)
    .u16(phnum)
    .u16(h.shentsize || ELF_SHDR_SIZE)
    .u16(elf.sections.length)
    .u16(h.shstrndx);
  out.set(w.finish(), 0);

  const sh = new ByteWriter(elf.sections.length * ELF_SHDR_SIZE);
  elf.sections.forEach((s, i) => {
    const off = lay.sectionOffsets[i];
    if (s.type !== SHT_NOBITS && i > 0) out.set(s.data, off);
    sh.u32(s.nameOffset)
      .u32(s.type)
      .u32(s.flags)
      .u32(s.addr)
      .u32(off)
      .u32(s.type === SHT_NOBITS || i === 0 ? s.size : s.data.length)
      .u32(s.link)
      .u32(s.info)
      .u32(s.addralign)
      .u32(s.entsize);
  });
  out.set(sh.finish(), lay.shoff);

  const ph = new ByteWriter(phnum * ELF_PHDR_SIZE + 1);
  for (const p of elf.programHeaders) {
    const { offset, filesz, memsz } = programHeaderPlacement(elf, lay, p);
    ph.u32(p.type).u32(offset).u32(p.vaddr).u32(p.paddr).u32(filesz).u32(memsz).u32(p.flags).u32(p.align);
  }
  out.set(ph.finish(), lay.phoff);
  return out;
}

/**
 * The p_offset/p_filesz/p_memsz the writer emits for a program header.
 *
 * - `sectionIndex` unset: the fields are written exactly as given (caller owns them).
 * - `sectionIndex` set: p_offset := that section's new file offset. In every CW sample a PT_LOAD/PT_NOTE with
 *   file contents covers exactly ONE section (filesz == memsz == sh_size). So when the segment is recognisably
 *   "exactly this section's body" — the section is not NOBITS and p_filesz (resp. p_memsz) equals the section's
 *   sh_size as recorded in the model (`size`) — that field follows the body's current length (`data.length`).
 *   Any other filesz/memsz (multi-section segments such as Lab3's .stack segment, NOBITS segments, hand-built
 *   models whose `size` is stale) is written unchanged: the caller owns it.
 */
export function programHeaderPlacement(
  elf: ElfFile,
  lay: ElfLayout,
  p: ElfProgramHeader,
): { offset: number; filesz: number; memsz: number } {
  if (p.sectionIndex === undefined) return { offset: p.offset, filesz: p.filesz, memsz: p.memsz };
  const s = elf.sections[p.sectionIndex];
  const offset = lay.sectionOffsets[p.sectionIndex];
  if (!s || s.type === SHT_NOBITS) return { offset, filesz: p.filesz, memsz: p.memsz };
  return {
    offset,
    filesz: p.filesz === s.size ? s.data.length : p.filesz,
    memsz: p.memsz === s.size ? s.data.length : p.memsz,
  };
}

function defaultIdent(): Uint8Array {
  const id = new Uint8Array(16);
  id.set([0x7f, 0x45, 0x4c, 0x46, 1, 2, 1]);
  return id;
}

/** ELF identification bytes as CodeWarrior writes them: ELF32, big-endian, version 1, SysV ABI. */
export const CW_ELF_IDENT: Uint8Array = defaultIdent();

/**
 * Build a string table the CodeWarrior way: a leading NUL, then every name in order followed by NUL, with NO
 * de-duplication — empty names (section symbols) get their own NUL entry. Verified for .shstrtab (section order)
 * and .strtab (symbol order from index 1) on every fixture.
 * Returns the table and the offset of each name.
 */
export function buildCwStringTable(names: readonly string[]): { data: Uint8Array; offsets: number[] } {
  const w = new ByteWriter(256);
  w.u8(0);
  const offsets: number[] = [];
  for (const n of names) {
    offsets.push(w.length);
    w.bytes(latin1BestFitBytes(n)).u8(0);
  }
  return { data: w.finish(), offsets };
}

/**
 * Rebuild .shstrtab data and every section's nameOffset from section names (section order, index 0 = offset 0).
 * Mutates and returns `elf`.
 */
export function rebuildSectionNames(elf: ElfFile): ElfFile {
  const { data, offsets } = buildCwStringTable(elf.sections.slice(1).map((s) => s.name));
  elf.sections[0].nameOffset = 0;
  elf.sections.slice(1).forEach((s, i) => (s.nameOffset = offsets[i]));
  const shstr = elf.sections[elf.header.shstrndx];
  if (shstr) {
    shstr.data = data;
    shstr.size = data.length;
  }
  return elf;
}
