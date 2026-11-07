// Internal linker model: modules (objects / library members), their allocatable input sections, output sections.
import {
  readSymbols,
  readRelocationSections,
  resolveAlias,
  SHF_ALLOC,
  SHF_WRITE,
  SHN_ABS,
  SHN_UNDEF,
  STB_LOCAL,
  STT_FILE,
  STT_SECTION,
  STT_HIWARE_ALIAS,
  type ElfFile,
  type ElfRela,
  type ElfSymbol,
  type PrmQualifier,
} from '@s12/formats';
import type { OutSectionKind } from './types';

export interface InSection {
  mod: Module;
  /** ELF section index in the module */
  index: number;
  name: string;
  type: number;
  flags: number;
  size: number;
  data: Uint8Array;
  /** absolute (ORG) section: placed at `orgAddress`, never by PLACEMENT */
  isOrg: boolean;
  orgAddress: number;
  relocs: ElfRela[];
  /** kept by smart linking */
  kept: boolean;
  out?: OutSection;
  /** offset inside `out` */
  offset: number;
}

export interface Module {
  /** position in the link order (library members get consecutive positions at the library's place) */
  order: number;
  /** "main.asm.o" / "Lib_LCD.asm.o" */
  name: string;
  /** library file name for library members ("ME305LibV4.0.lib") */
  library?: string;
  /** path for messages */
  path: string;
  elf: ElfFile;
  syms: ElfSymbol[];
  /** allocatable sections by ELF index */
  secs: Map<number, InSection>;
  /** relocation lists by target section index (all targets, debug included) */
  relocsByTarget: Map<number, ElfRela[]>;
  /** library members are loaded on demand; objects are always loaded */
  loaded: boolean;
  /** name of the module's FILE symbol ("main.dbg") */
  fileSym: string;
}

export interface OutSection {
  name: string;
  kind: OutSectionKind;
  segment: string;
  qualifier?: PrmQualifier;
  type: number;
  flags: number;
  address: number;
  size: number;
  pieces: InSection[];
  placed: boolean;
  /** synthesized contents (vector entries) */
  data?: Uint8Array;
  /** for vectors: what the entry points to */
  vector?: { address: number; value: number; target?: string };
}

/** Display name used by the map ("Lib_X.asm.o (ME305LibV4.0.lib)" or "main.asm.o"). */
export const moduleDisplayName = (m: Pick<Module, 'name' | 'library'>): string =>
  m.library ? `${m.name} (${m.library})` : m.name;

/** "main.asm.o" -> "main.asm" (prefix of ORG output section names). */
export const moduleBase = (name: string): string => name.replace(/\.o$/i, '');

const ORG_NAME = /^_ORG\d+$/;

export function buildModule(elf: ElfFile, name: string, order: number, path: string, library?: string): Module {
  const syms = readSymbols(elf);
  const relocsByTarget = new Map<number, ElfRela[]>();
  for (const r of readRelocationSections(elf)) {
    const list = relocsByTarget.get(r.target) ?? [];
    list.push(...r.relocs);
    relocsByTarget.set(r.target, list);
  }
  const mod: Module = {
    order,
    name,
    library,
    path,
    elf,
    syms,
    secs: new Map(),
    relocsByTarget,
    loaded: !library,
    fileSym: syms.find((s) => s.type === STT_FILE)?.name || `${name.replace(/\.asm\.o$|\.o$/i, '')}.dbg`,
  };
  elf.sections.forEach((s, index) => {
    if (index === 0 || !(s.flags & SHF_ALLOC)) return;
    // UNCERTAIN: an ORG section is recognised by its CW name `_ORGnnnnn` or a non-zero sh_addr (relocatable
    // sections always have sh_addr 0 in CW objects). An ORG at address 0 with another name would be missed.
    const isOrg = ORG_NAME.test(s.name) || s.addr !== 0;
    mod.secs.set(index, {
      mod,
      index,
      name: s.name,
      type: s.type,
      flags: s.flags,
      size: s.size,
      data: s.data,
      isOrg,
      orgAddress: s.addr,
      relocs: relocsByTarget.get(index) ?? [],
      kept: false,
      offset: 0,
    });
  });
  return mod;
}

/** Map "Type" column of an output section: from the segment qualifier, else from the section flags. */
export function sectionAccess(o: Pick<OutSection, 'qualifier' | 'flags'>): 'R' | 'R/W' | 'N/I' {
  if (o.qualifier === 'NO_INIT') return 'N/I';
  if (o.qualifier === 'READ_WRITE') return 'R/W';
  if (o.qualifier) return 'R'; // UNCERTAIN: PAGED / CODE segments shown as R
  return o.flags & SHF_WRITE ? 'R/W' : 'R';
}

/** Is symbol `s` a real object (not a SECTION/FILE/alias/undefined entry)? */
export const isObjectSymbol = (s: ElfSymbol): boolean =>
  s.type !== STT_SECTION && s.type !== STT_FILE && s.type !== STT_HIWARE_ALIAS && s.shndx !== SHN_UNDEF && !!s.name;

export const isGlobalDef = (s: ElfSymbol): boolean => s.bind !== STB_LOCAL && isObjectSymbol(s);

/** Follow HIWARE type-13 alias symbols. */
export const realSymbolIndex = (mod: Module, idx: number): number => resolveAlias(mod.syms, idx);

export const isAbsSymbol = (s: ElfSymbol): boolean => s.shndx === SHN_ABS;
