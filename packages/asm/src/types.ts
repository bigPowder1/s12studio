/** Internal data model shared by the assembler passes, the listing writer and the object writer. */
import type { Fixup } from './encoder.js';
import type { ParsedLine } from './line.js';
import type { Value } from './expr.js';

export type SectionKind = 'default' | 'reloc' | 'org' | 'offset';

export interface Section {
  /** Creation order (0 = the default section `_SEC000000`). */
  id: number;
  name: string;
  kind: SectionKind;
  /** `SECTION SHORT`: labels may be accessed with direct addressing. */
  short: boolean;
  /** ORG / OFFSET start address (0 for relocatable sections). */
  base: number;
  /** Location counter: section offset for relocatable sections, absolute address for ORG / OFFSET. */
  pc: number;
  /** Extent in bytes (max offset reached). */
  size: number;
  hasCode: boolean;
  hasConst: boolean;
  hasDs: boolean;
  /** Section contents (pass 2), indexed by offset. */
  data: number[];
  /** Relocations (pass 2), `at` = section offset. */
  fixups: Array<Fixup & { stmt: Stmt }>;
  /** ELF section index (set by the object writer). */
  elfIndex?: number;
  /** Index of the STT_SECTION symbol (set by the object writer). */
  secSym?: number;
}

export type SymKind = 'label' | 'equ' | 'set' | 'xref' | 'none';

export interface Sym {
  /** Name as first written. */
  name: string;
  kind: SymKind;
  /** Labels: their section. */
  section?: Section;
  /** Labels: section offset (relocatable) or absolute address (ORG/OFFSET); EQU/SET: numeric value. */
  value: number;
  /** EQU whose value is relocatable / external. */
  equValue?: Value;
  defined: boolean;
  xdef: boolean;
  /** XREF size suffix ('' for plain XREF, 'B' for XREF.B / XREFB). */
  xrefSize?: string;
  /** Label on a data directive line (DC/DS/DCB/...): allocated in the object symbol table at definition. */
  isData: boolean;
  /** Element size / count of the data directive at the label (DWARF variable type). */
  dataElem?: 1 | 2 | 4;
  dataCount?: number;
  /** Assembler-generated VARnnnnn symbol for unlabelled data. */
  isVar?: boolean;
  /** Statement defining the symbol. */
  defStmt?: Stmt;
  /** Object symbol allocation order (see object.ts). */
  alloc?: number;
  /** Definition order (for symbols never allocated otherwise). */
  defOrder?: number;
  /** Object file: computed size / symbol index. */
  size?: number;
  elfIndex?: number;
}

export type StmtType =
  | 'none'
  | 'instr'
  | 'dc'
  | 'ds'
  | 'align'
  | 'equ'
  | 'set'
  | 'cond'
  | 'org'
  | 'section'
  | 'other';

export interface ListCtl {
  /** Insert a page break before the next listed line. */
  page?: boolean;
  /** Insert n blank lines. */
  spc?: number;
  llen?: number;
  plen?: number;
  tabs?: number;
  nopage?: boolean;
  title?: string;
}

export interface Stmt {
  idx: number;
  /** File the line comes from (macro expansion: the file the macro body is in). */
  file: string;
  /** Line number in `file` (Rel. column). */
  line: number;
  /** '' / 'i' (included file) / 'm' (macro expansion). */
  suffix: '' | 'i' | 'm';
  /** Text as written in the listing/.dbg (macro expansion: after parameter substitution). */
  text: string;
  /** Line number in the .dbg (Abs. column); 0 when the line is not part of the .dbg. */
  absLine: number;
  /** Listed in the .lst. */
  listed: boolean;
  /** Macro-expansion line ('+' marker). */
  macroExp: boolean;
  /** Line is part of a macro definition (MACRO .. ENDM) or a skipped conditional block. */
  skipped: boolean;
  parsed?: ParsedLine;
  type: StmtType;
  section?: Section;
  /** Location at the start (section offset or absolute address, as the listing shows it). */
  loc: number;
  size: number;
  /** Show the location column (code, data, DS, padding). */
  showLoc: boolean;
  /** Value shown in the object column for EQU/SET/IF lines (32-bit). */
  listValue?: number;
  /** Pass-2 bytes and the per-byte "unresolved" (x) flags. */
  bytes?: number[];
  xmask?: boolean[];
  /** Pass-1 encoder decisions. */
  choices?: string[];
  /** SET value computed in pass 1. */
  setSym?: Sym;
  setValue?: number;
  /** Data directive info (pass 2 re-encodes from these). */
  data?: { elem: 1 | 2 | 4; kind: 'dc' | 'dcb' | 'fcc' | 'rad50' };
  /** Padding bytes are data (PROGBITS) for ALIGN in initialised sections. */
  listCtl?: ListCtl;
  /** Macro call context (CW "Macro Call :" line). */
  macroContext?: string;
  /** Outermost macro call site, for lines of a macro expansion. */
  macroCall?: { file: string; line: number };
  /** Character offset of the line start in its file. */
  lineStart: number;
  /** Error reported on this statement. */
  hasError?: boolean;
}
