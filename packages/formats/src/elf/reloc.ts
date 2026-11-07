// HIWARE relocations (spec §2.4). Entries are standard Elf32_Rela (r_info = sym<<8 | type), but r_addend holds the
// field width minus one; the real addend is the big-endian value already stored at r_offset.
import { ByteReader, ByteWriter, readBE, signExtend, writeBE } from '../util/bytes';
import { ELF_RELA_SIZE, SHT_RELA, type ElfFile, type ElfRela, type ElfSection } from './types';

/** HIWARE relocation type numbers (NOT the GNU m68hc11 numbering readelf prints). */
export const HiwareRelocType = {
  /** field = S + A (16-bit address, or 32-bit section offset in debug sections). */
  ABS: 1,
  /** field = S + A − P, P = address of the field (LBRA/LBcc to another section). */
  PCREL16: 3,
  /** field = (S + A) >> 16 (page byte; only seen in DWARF, always 0). UNCERTAIN for paged code. */
  PAGE8: 5,
} as const;
export const R_HIWARE_ABS = 1;
export const R_HIWARE_PCREL16 = 3;
export const R_HIWARE_PAGE8 = 5;

/** Semantic kinds for the (type, width) pairs observed in CodeWarrior output. */
export type RelocKind = 'ABS16' | 'ABS32' | 'PCREL16' | 'PAGE8';

interface KindDef {
  type: number;
  width: number;
  kind: RelocKind;
  pcrel: boolean;
}

/** Table of known (type, width) combinations. Anything else must be reported, never silently accepted. */
export const KNOWN_RELOCS: readonly KindDef[] = [
  { type: R_HIWARE_ABS, width: 16, kind: 'ABS16', pcrel: false },
  { type: R_HIWARE_ABS, width: 32, kind: 'ABS32', pcrel: false },
  { type: R_HIWARE_PCREL16, width: 16, kind: 'PCREL16', pcrel: true },
  { type: R_HIWARE_PAGE8, width: 8, kind: 'PAGE8', pcrel: false },
];

export const relocWidthBits = (r: Pick<ElfRela, 'rawAddend'>): number => r.rawAddend + 1;

export class UnknownRelocationError extends Error {
  constructor(
    readonly reloc: ElfRela,
    where = '',
  ) {
    super(
      `unknown HIWARE relocation type ${reloc.type} width ${relocWidthBits(reloc)} at 0x${reloc.offset.toString(16)}${where ? ` in ${where}` : ''}`,
    );
  }
}

function lookup(r: Pick<ElfRela, 'type' | 'rawAddend'>): KindDef | undefined {
  const width = relocWidthBits(r);
  return KNOWN_RELOCS.find((k) => k.type === r.type && k.width === width);
}

/** The semantic kind, or undefined for an unknown (type, width) pair. */
export function relocKind(r: Pick<ElfRela, 'type' | 'rawAddend'>): RelocKind | undefined {
  return lookup(r)?.kind;
}

/** The semantic kind; throws UnknownRelocationError for an unknown pair. */
export function requireRelocKind(r: ElfRela, where?: string): RelocKind {
  const k = lookup(r);
  if (!k) throw new UnknownRelocationError(r, where);
  return k.kind;
}

/** All relocations whose (type, width) pair is not in KNOWN_RELOCS. */
export function findUnknownRelocations(relocs: readonly ElfRela[]): ElfRela[] {
  return relocs.filter((r) => !lookup(r));
}

/** Raw `rawAddend` (width − 1) and type for a semantic kind. */
export function relocFromKind(kind: RelocKind, offset: number, sym: number): ElfRela {
  const def = KNOWN_RELOCS.find((k) => k.kind === kind)!;
  return { offset, sym, type: def.type, rawAddend: def.width - 1 };
}

/**
 * The real (in-place) addend: the big-endian field of width (rawAddend+1) bits at r_offset in the target section.
 * Signed for PC-relative relocations (LBRA main = 18 20 FF FE → −2), unsigned otherwise.
 * Throws UnknownRelocationError for a (type, width) pair not in KNOWN_RELOCS.
 */
export function inPlaceAddend(target: Uint8Array, r: ElfRela): number {
  // Unknown (type, width) pairs are rejected: their signedness (and even their field layout) is unknown, so
  // guessing would silently produce wrong addends (e.g. a future PCREL8 read as unsigned).
  const k = lookup(r);
  if (!k) throw new UnknownRelocationError(r);
  const bytes = k.width / 8;
  if (r.offset + bytes > target.length)
    throw new RangeError(`relocation field [0x${r.offset.toString(16)}+${bytes}] past end of target (${target.length} bytes)`);
  const v = readBE(target, r.offset, bytes);
  return k.pcrel ? signExtend(v, k.width) : v;
}

/**
 * Compute the field value for a relocation given S (symbol address), A (in-place addend) and P (field address).
 * Returns the value truncated to the field width. Throws for unknown pairs.
 */
export function relocValue(r: ElfRela, S: number, A: number, P: number): number {
  const kind = requireRelocKind(r);
  const width = relocWidthBits(r);
  let v: number;
  switch (kind) {
    case 'ABS16':
    case 'ABS32':
      v = S + A;
      break;
    case 'PCREL16':
      v = S + A - P;
      break;
    case 'PAGE8':
      // UNCERTAIN: (S+A)>>16 is the observed rule; every sample value is 0 (non-paged addresses).
      v = Math.floor((S + A) / 0x10000);
      break;
  }
  const m = 2 ** width;
  return ((v % m) + m) % m;
}

/** Apply a relocation in place: field := relocValue(r, S, inPlaceAddend, P). */
export function applyRelocation(target: Uint8Array, r: ElfRela, S: number, P: number): void {
  const A = inPlaceAddend(target, r);
  writeBE(target, r.offset, relocWidthBits(r) / 8, relocValue(r, S, A, P));
}

export function parseRelocations(data: Uint8Array): ElfRela[] {
  const r = new ByteReader(data);
  const out: ElfRela[] = [];
  const n = Math.floor(data.length / ELF_RELA_SIZE);
  for (let i = 0; i < n; i++) {
    const offset = r.u32();
    const info = r.u32();
    const rawAddend = r.i32();
    out.push({ offset, sym: info >>> 8, type: info & 0xff, rawAddend });
  }
  return out;
}

export function encodeRelocations(relocs: readonly ElfRela[]): Uint8Array {
  const w = new ByteWriter(relocs.length * ELF_RELA_SIZE);
  for (const r of relocs) w.u32(r.offset).u32(((r.sym << 8) | (r.type & 0xff)) >>> 0).i32(r.rawAddend);
  return w.finish();
}

export interface RelocationSection {
  /** Index of the .rela.* section. */
  index: number;
  section: ElfSection;
  /** sh_info: index of the section the relocations apply to. */
  target: number;
  /** sh_link: index of the symbol table. */
  symtab: number;
  relocs: ElfRela[];
}

/** All SHT_RELA sections of a file, parsed. */
export function readRelocationSections(elf: ElfFile): RelocationSection[] {
  const out: RelocationSection[] = [];
  elf.sections.forEach((s, index) => {
    if (s.type !== SHT_RELA) return;
    out.push({ index, section: s, target: s.info, symtab: s.link, relocs: parseRelocations(s.data) });
  });
  return out;
}

/** Relocations applying to the named section (empty if none). */
export function relocationsFor(elf: ElfFile, sectionName: string): ElfRela[] {
  const idx = elf.sections.findIndex((s) => s.name === sectionName);
  if (idx < 0) return [];
  return readRelocationSections(elf)
    .filter((r) => r.target === idx)
    .flatMap((r) => r.relocs);
}
