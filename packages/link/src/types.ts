// Public types of @s12/link (SmartLinker V-5.0.40 + Burner clone).
import type { ElfFile } from '@s12/formats';

export type LinkSeverity = 'information' | 'warning' | 'error' | 'fatal';

/** A SmartLinker message (`L1822`-style code, CodeWarrior severity, message text). */
export interface LinkMessage {
  code: string;
  severity: LinkSeverity;
  text: string;
  /** file the message is about (object, library member or PRM), when known */
  file?: string;
  /** 1-based line in the PRM file (PRM messages only) */
  line?: number;
}

export interface LinkInputFile {
  /** file name as CodeWarrior shows it, e.g. "main.asm.o" or "ME305LibV4.0.lib" */
  name: string;
  bytes: Uint8Array;
  /** absolute path (used in messages and the default linker command line); defaults to `name` */
  path?: string;
}

export interface LinkInputEntry extends LinkInputFile {
  kind: 'object' | 'library';
}

/** Values of the linker `.note` that cannot be derived from the inputs (user, time stamp, command line). */
export interface NoteMeta {
  /** note type 5: user name */
  user: string;
  /** note type 7: ctime() string INCLUDING the trailing "\n", e.g. "Mon Oct 19 10:30:47 2026\n" */
  created: string;
  /** note type 9: the linker command line (CodeWarrior truncates it to 1024 bytes) */
  commandLine: string;
}

export interface LinkOptions {
  /** write the .map text (default true; a PRM `MAPFILE NONE` also disables it) */
  mapFile?: boolean;
  /** clock used for the default note time stamp (default: now) */
  now?: Date;
  /**
   * SmartLinker `-Alloc` strategy for a section list spread over several segments (default 'next', like CW):
   * - 'next': take the next segment as soon as a section does not fit; gaps left behind are never used again
   *   (keeps PLACEMENT order);
   * - 'first': every section goes to the first segment of the list with enough room;
   * - 'change': stay in the current segment while sections fit, otherwise the first segment with enough room.
   */
  alloc?: 'next' | 'first' | 'change';
}

export interface LinkInput {
  /** object files (in link order) */
  objects?: LinkInputFile[];
  /** libraries (in link order) */
  libraries?: LinkInputFile[];
  /**
   * Explicit link order mixing objects and libraries (CodeWarrior `mtlo` order). When given, `objects` and
   * `libraries` are appended after it. When absent the order is: libraries first, then objects — the order of
   * every CodeWarrior ME305 project (the .lib precedes main.asm in the link order). UNCERTAIN as a general default.
   */
  inputs?: LinkInputEntry[];
  prmText: string;
  /** path of the PRM (messages, INCLUDE resolution base) */
  prmPath?: string;
  /** resolves `INCLUDE file` inside the PRM */
  prmInclude?: (file: string) => string | undefined;
  /** absolute path of the .abs, e.g. "C:\\...\\bin\\Project.abs" (written into the map's PROGRAM line) */
  outputPath: string;
  options?: LinkOptions;
  noteMeta?: Partial<NoteMeta>;
}

export type OutSectionKind = 'placed' | 'org' | 'stack' | 'vector';

export interface LayoutPiece {
  /** module (object / library member) name, e.g. "Lib_LCD.asm.o" */
  module: string;
  library?: string;
  /** input section name in the module */
  section: string;
  /** offset of the piece inside the output section */
  offset: number;
  address: number;
  size: number;
}

export interface LayoutSection {
  /** output (ELF) name: ".init", ".data", "MyCode", "main.asm__ORG00001", ".vectSeg0_vect" ... */
  name: string;
  kind: OutSectionKind;
  /** segment name (PRM segment, or `.absSegN` / `.vectSegN`) */
  segment: string;
  address: number;
  size: number;
  /** ELF section type / flags */
  type: number;
  flags: number;
  /** map Type column */
  access: 'R' | 'R/W' | 'N/I';
  pieces: LayoutPiece[];
}

export type LayoutSymbolKind = 'procedure' | 'variable' | 'label';

export interface LayoutSymbol {
  name: string;
  address: number;
  size: number;
  kind: LayoutSymbolKind;
  binding: 'local' | 'global' | 'linker';
  module: string;
  library?: string;
  /** output section name (".text" for ORG data, "" for linker labels) */
  section: string;
  /** number of relocations referencing this object (map Ref column) */
  refs: number;
}

export interface LinkLayout {
  /** every output section, in allocation (map) order */
  sections: LayoutSection[];
  /** every object the map lists (procedures, variables, labels) */
  symbols: LayoutSymbol[];
  /** linked modules in link order (map FILE SECTION order) */
  modules: { name: string; library?: string }[];
  entry?: { name: string; address: number };
}

export interface LinkResult {
  ok: boolean;
  /** the .abs bytes (only when ok) */
  absBytes?: Uint8Array;
  abs?: ElfFile;
  /** the .map text with CRLF line endings (only when ok and enabled) */
  mapText?: string;
  messages: LinkMessage[];
  layout: LinkLayout;
}
