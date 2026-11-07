// ELF32 big-endian model for the CodeWarrior/HIWARE HC12 dialect (spec: docs/research/r2/elf-lib-formats.md §2, §4).

export const EM_68HC12 = 0x35;

export const ET_NONE = 0;
export const ET_REL = 1;
export const ET_EXEC = 2;

export const SHT_NULL = 0;
export const SHT_PROGBITS = 1;
export const SHT_SYMTAB = 2;
export const SHT_STRTAB = 3;
export const SHT_RELA = 4;
export const SHT_NOTE = 7;
export const SHT_NOBITS = 8;

export const SHF_WRITE = 0x1;
export const SHF_ALLOC = 0x2;
export const SHF_EXECINSTR = 0x4;

export const SHN_UNDEF = 0;
export const SHN_ABS = 0xfff1;
export const SHN_COMMON = 0xfff2;

export const STB_LOCAL = 0;
export const STB_GLOBAL = 1;
export const STB_WEAK = 2;

export const STT_NOTYPE = 0;
export const STT_OBJECT = 1;
export const STT_FUNC = 2;
export const STT_SECTION = 3;
export const STT_FILE = 4;
/**
 * HIWARE processor-specific alias symbol (deprecated-name EQUs from mc9s12xdp512.inc). Its st_shndx holds the
 * *symbol index* of the aliased symbol, not a section index.
 */
export const STT_HIWARE_ALIAS = 13;

export const PT_NULL = 0;
export const PT_LOAD = 1;
export const PT_NOTE = 4;

export const PF_X = 1;
export const PF_W = 2;
export const PF_R = 4;

export const ELF_HEADER_SIZE = 52;
export const ELF_SHDR_SIZE = 40;
export const ELF_PHDR_SIZE = 32;
export const ELF_SYM_SIZE = 16;
export const ELF_RELA_SIZE = 12;

export interface ElfHeader {
  /** e_ident (16 bytes) verbatim. */
  ident: Uint8Array;
  type: number;
  machine: number;
  version: number;
  entry: number;
  /** As read. The writer recomputes it (CW: always shoff + shnum*shentsize, i.e. end of the shdr table). */
  phoff: number;
  /** As read. The writer recomputes it. */
  shoff: number;
  flags: number;
  ehsize: number;
  /** 0 in CW relocatable objects (no phdrs), 32 in executables. */
  phentsize: number;
  /** As read. The writer uses programHeaders.length. */
  phnum: number;
  shentsize: number;
  /** As read. The writer uses sections.length. */
  shnum: number;
  shstrndx: number;
}

export interface ElfSection {
  /** Resolved name (from .shstrtab). */
  name: string;
  /** sh_name offset into .shstrtab. */
  nameOffset: number;
  type: number;
  flags: number;
  addr: number;
  /** File offset as read. The writer recomputes it (CW layout: each body 4-aligned, in section order). */
  offset: number;
  /** sh_size. For non-NOBITS sections the writer uses data.length. */
  size: number;
  link: number;
  info: number;
  addralign: number;
  entsize: number;
  /** Section body (empty for NOBITS). */
  data: Uint8Array;
}

export interface ElfProgramHeader {
  type: number;
  /** As read. When `sectionIndex` is set, the writer replaces it with that section's new file offset. */
  offset: number;
  vaddr: number;
  paddr: number;
  filesz: number;
  memsz: number;
  flags: number;
  align: number;
  /**
   * Index of the first section this segment covers (derived by the reader). The writer relocates `offset` to
   * that section's new file offset and, when filesz/memsz equal the section's recorded `size`, makes them follow
   * its current `data.length` (see programHeaderPlacement). Otherwise filesz/memsz are the caller's.
   */
  sectionIndex?: number;
}

export interface ElfFile {
  header: ElfHeader;
  /** All sections including the index-0 NULL section. */
  sections: ElfSection[];
  programHeaders: ElfProgramHeader[];
}

export interface ElfSymbol {
  name: string;
  nameOffset: number;
  value: number;
  size: number;
  /** Raw st_info. */
  info: number;
  bind: number;
  type: number;
  other: number;
  /** Raw st_shndx. For STT_HIWARE_ALIAS (13) this is a symbol index. */
  shndx: number;
}

/** Elf32_Rela as stored by CodeWarrior. */
export interface ElfRela {
  offset: number;
  sym: number;
  type: number;
  /** Raw r_addend: for HIWARE this is (field width in bits − 1), NOT an addend. */
  rawAddend: number;
}
