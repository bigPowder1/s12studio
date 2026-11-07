// "Objects" in the SmartLinker sense: every labelled procedure / variable / label the map lists, with its Ref count
// and USES list (derived from relocations).
import type { InSection, Module, OutSection } from './model';
import type { LayoutSymbolKind } from './types';

export interface LinkObject {
  name: string;
  address: number;
  size: number;
  kind: LayoutSymbolKind;
  binding: 'local' | 'global' | 'linker';
  mod: Module;
  /** symbol index in `mod` (-1 for linker-defined labels) */
  symIdx: number;
  /** ELF st_type / st_bind / st_size of the defining symbol */
  elfType: number;
  /** defining input section (for ORG absolute data: the ORG section containing it) */
  sec?: InSection;
  out?: OutSection;
  /** ABS symbol inside an ORG section (anonymous ORG data `VARnnnnn`): listed in section ".text" */
  isOrgAbs: boolean;
  /** map "Section" column */
  mapSection: string;
  /** base order (module link order, then symbol index): used for tie-breaking */
  rank: number;
  /** order key of the defining section inside its module (per-module map listing) */
  secOrder: number;
  refs: number;
  uses: LinkObject[];
}

/**
 * Sort "by address" the way SmartLinker does for the symbol table, OBJECT LIST SORTED BY ADDRESS and SECTION USE.
 * Equal addresses come out in REVERSE base order: golden maps list `Entry` before `_Startup` (module order
 * _Startup, Entry) and `main` before `spin` (module order spin, main).
 * UNCERTAIN: a case-sensitive alphabetical tie-break fits the same two samples.
 */
export function byAddress<T extends { address: number; rank: number }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.address - b.address || b.rank - a.rank);
}

/** Per-module listing order (map OBJECT-ALLOCATION): module section order, then address, then symbol order. */
export function byModuleSection(list: readonly LinkObject[]): LinkObject[] {
  return [...list].sort((a, b) => a.secOrder - b.secOrder || a.address - b.address || a.rank - b.rank);
}
