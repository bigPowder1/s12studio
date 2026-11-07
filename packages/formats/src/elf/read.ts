import { ByteReader, readCString } from '../util/bytes';
import {
  ELF_HEADER_SIZE,
  ELF_PHDR_SIZE,
  ELF_SHDR_SIZE,
  PT_LOAD,
  PT_NOTE,
  SHF_ALLOC,
  SHT_NOBITS,
  SHT_NOTE,
  type ElfFile,
  type ElfHeader,
  type ElfProgramHeader,
  type ElfSection,
} from './types';

export class ElfFormatError extends Error {}

/**
 * Parse an ELF32 big-endian file (CodeWarrior HC12 dialect).
 *
 * ALIASING: every section's `data` is a `subarray` VIEW into `bytes` (no copy), so mutating it — e.g.
 * `applyRelocation(section.data, …)` — also mutates `bytes` (and, for a library member, the whole `.lib`
 * buffer and `member.bytes`). Pass `{ copy: true }`, or use `cloneElf()`, before modifying section bodies.
 * Invalid/truncated input throws ElfFormatError.
 */
export function readElf(bytes: Uint8Array, opts: { copy?: boolean } = {}): ElfFile {
  if (opts.copy) bytes = bytes.slice();
  if (bytes.length < ELF_HEADER_SIZE || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46)
    throw new ElfFormatError('not an ELF file');
  if (bytes[4] !== 1) throw new ElfFormatError(`unsupported ELF class ${bytes[4]} (want ELF32)`);
  if (bytes[5] !== 2) throw new ElfFormatError(`unsupported ELF data encoding ${bytes[5]} (want big-endian)`);

  const r = new ByteReader(bytes);
  const header: ElfHeader = {
    ident: bytes.slice(0, 16),
    type: r.seek(16).u16(),
    machine: r.u16(),
    version: r.u32(),
    entry: r.u32(),
    phoff: r.u32(),
    shoff: r.u32(),
    flags: r.u32(),
    ehsize: r.u16(),
    phentsize: r.u16(),
    phnum: r.u16(),
    shentsize: r.u16(),
    shnum: r.u16(),
    shstrndx: r.u16(),
  };
  if (header.shnum && header.shentsize !== ELF_SHDR_SIZE)
    throw new ElfFormatError(`unexpected e_shentsize ${header.shentsize}`);
  if (header.phnum && header.phentsize !== ELF_PHDR_SIZE)
    throw new ElfFormatError(`unexpected e_phentsize ${header.phentsize}`);

  // Validate table extents up front so a truncated/corrupt file raises ElfFormatError, not a bare RangeError.
  if (header.shnum && header.shoff + header.shnum * ELF_SHDR_SIZE > bytes.length)
    throw new ElfFormatError(
      `section header table [0x${header.shoff.toString(16)}+${header.shnum}×${ELF_SHDR_SIZE}] past end of file (0x${bytes.length.toString(16)})`,
    );
  if (header.phnum && header.phoff + header.phnum * ELF_PHDR_SIZE > bytes.length)
    throw new ElfFormatError(
      `program header table [0x${header.phoff.toString(16)}+${header.phnum}×${ELF_PHDR_SIZE}] past end of file (0x${bytes.length.toString(16)})`,
    );
  if (header.shnum && header.shstrndx >= header.shnum)
    throw new ElfFormatError(`e_shstrndx ${header.shstrndx} out of range (e_shnum ${header.shnum})`);

  const sections: ElfSection[] = [];
  for (let i = 0; i < header.shnum; i++) {
    r.seek(header.shoff + i * ELF_SHDR_SIZE);
    const nameOffset = r.u32();
    const type = r.u32();
    const flags = r.u32();
    const addr = r.u32();
    const offset = r.u32();
    const size = r.u32();
    const link = r.u32();
    const info = r.u32();
    const addralign = r.u32();
    const entsize = r.u32();
    let data: Uint8Array;
    if (type === SHT_NOBITS || i === 0) data = new Uint8Array(0);
    else {
      if (offset + size > bytes.length)
        throw new ElfFormatError(`section ${i} [0x${offset.toString(16)}+0x${size.toString(16)}] past end of file`);
      data = bytes.subarray(offset, offset + size);
    }
    sections.push({ name: '', nameOffset, type, flags, addr, offset, size, link, info, addralign, entsize, data });
  }
  const shstr = sections[header.shstrndx];
  if (shstr) for (const s of sections) s.name = s.nameOffset < shstr.data.length ? readCString(shstr.data, s.nameOffset) : '';

  const programHeaders: ElfProgramHeader[] = [];
  for (let i = 0; i < header.phnum; i++) {
    r.seek(header.phoff + i * ELF_PHDR_SIZE);
    const ph: ElfProgramHeader = {
      type: r.u32(),
      offset: r.u32(),
      vaddr: r.u32(),
      paddr: r.u32(),
      filesz: r.u32(),
      memsz: r.u32(),
      flags: r.u32(),
      align: r.u32(),
    };
    const idx = sections.findIndex(
      (s, k) =>
        k > 0 &&
        s.offset === ph.offset &&
        (ph.type === PT_LOAD
          ? (s.flags & SHF_ALLOC) !== 0 && s.addr === ph.vaddr
          : ph.type === PT_NOTE
            ? s.type === SHT_NOTE
            : true),
    );
    if (idx > 0) ph.sectionIndex = idx;
    programHeaders.push(ph);
  }
  return { header, sections, programHeaders };
}

/** Deep copy of an ElfFile: section bodies and the ident are copied, so edits never reach the source buffer. */
export function cloneElf(elf: ElfFile): ElfFile {
  return {
    header: { ...elf.header, ident: elf.header.ident.slice() },
    sections: elf.sections.map((s) => ({ ...s, data: s.data.slice() })),
    programHeaders: elf.programHeaders.map((p) => ({ ...p })),
  };
}

/** Find a section by name (first match). */
export function findSection(elf: ElfFile, name: string): ElfSection | undefined {
  return elf.sections.find((s) => s.name === name);
}

export function sectionIndex(elf: ElfFile, name: string): number {
  return elf.sections.findIndex((s) => s.name === name);
}
