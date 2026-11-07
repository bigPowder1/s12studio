import { ByteReader, ByteWriter, readCString } from '../util/bytes';
import { buildCwStringTable } from './write';
import { ELF_SYM_SIZE, STT_HIWARE_ALIAS, SHT_SYMTAB, type ElfFile, type ElfSection, type ElfSymbol } from './types';

export const symInfo = (bind: number, type: number): number => ((bind & 0xf) << 4) | (type & 0xf);

/** Parse an Elf32_Sym table; names resolved from `strtab` when given. */
export function parseSymbols(symtab: Uint8Array, strtab?: Uint8Array): ElfSymbol[] {
  const r = new ByteReader(symtab);
  const out: ElfSymbol[] = [];
  const n = Math.floor(symtab.length / ELF_SYM_SIZE);
  for (let i = 0; i < n; i++) {
    const nameOffset = r.u32();
    const value = r.u32();
    const size = r.u32();
    const info = r.u8();
    const other = r.u8();
    const shndx = r.u16();
    const name = strtab && nameOffset < strtab.length ? readCString(strtab, nameOffset) : '';
    out.push({ name, nameOffset, value, size, info, bind: info >> 4, type: info & 0xf, other, shndx });
  }
  return out;
}

/** Encode symbols (uses `info` if consistent with bind/type, otherwise recomputes it from bind/type). */
export function encodeSymbols(syms: readonly ElfSymbol[]): Uint8Array {
  const w = new ByteWriter(syms.length * ELF_SYM_SIZE);
  for (const s of syms) {
    const info = (s.info >> 4 === s.bind && (s.info & 0xf) === s.type) ? s.info : symInfo(s.bind, s.type);
    w.u32(s.nameOffset).u32(s.value).u32(s.size).u8(info).u8(s.other).u16(s.shndx);
  }
  return w.finish();
}

/**
 * Build .symtab + .strtab bytes for a symbol list the CodeWarrior way (strtab: NUL + every name from index 1, in
 * order, no de-duplication). Assigns each symbol's nameOffset (mutates).
 */
export function buildSymbolTables(syms: ElfSymbol[]): { symtab: Uint8Array; strtab: Uint8Array } {
  const { data, offsets } = buildCwStringTable(syms.slice(1).map((s) => s.name));
  if (syms.length) syms[0].nameOffset = 0;
  syms.slice(1).forEach((s, i) => (s.nameOffset = offsets[i]));
  return { symtab: encodeSymbols(syms), strtab: data };
}

export function findSymtab(elf: ElfFile): ElfSection | undefined {
  return elf.sections.find((s) => s.type === SHT_SYMTAB);
}

/** The symbols of the file's (single) SYMTAB section, names resolved via its sh_link string table. */
export function readSymbols(elf: ElfFile): ElfSymbol[] {
  const st = findSymtab(elf);
  if (!st) return [];
  return parseSymbols(st.data, elf.sections[st.link]?.data);
}

/** True for HIWARE type-13 alias symbols (st_shndx is a symbol index). */
export const isAliasSymbol = (s: ElfSymbol): boolean => s.type === STT_HIWARE_ALIAS;

/**
 * Follow a type-13 alias chain to the aliased symbol index (returns `index` itself for ordinary symbols).
 * Throws on a cycle or an out-of-range index.
 */
export function resolveAlias(syms: readonly ElfSymbol[], index: number): number {
  const seen = new Set<number>();
  let i = index;
  while (syms[i] && isAliasSymbol(syms[i])) {
    if (seen.has(i)) throw new Error(`alias cycle at symbol ${index}`);
    seen.add(i);
    i = syms[i].shndx;
  }
  if (!syms[i]) throw new RangeError(`alias of symbol ${index} points outside the table (${i})`);
  return i;
}
