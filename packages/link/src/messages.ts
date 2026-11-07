// SmartLinker message codes and texts (docs/research/r1/asm.md §11, titles from the HC12 Build Tools manual).
// UNCERTAIN: the manual gives message *titles*; the exact runtime wording and default severities were not observed
// in a real CodeWarrior session. Every text lives here so it is easy to correct.
import type { LinkMessage, LinkSeverity } from './types';

const hex = (v: number) => `0x${v.toString(16).toUpperCase()}`;

export const LinkMessages = {
  /** L1009: Segment Name <segment name> unknown */
  segmentUnknown: (seg: string) => msg('L1009', 'error', `Segment Name ${seg} unknown`),
  /** L1100: Segments <s1> and <s2> overlap (not reported when both are PAGED). UNCERTAIN: severity. */
  segmentsOverlap: (a: string, b: string) => msg('L1100', 'error', `Segments ${a} and ${b} overlap`),
  /**
   * L1102: Out of allocation space in segment <segment name> at address <first address free>. `file` names the
   * section that did not fit; identical messages (several sections overflowing the same segment) are reported once.
   */
  outOfSpace: (seg: string, free: number, section: string) =>
    msg('L1102', 'error', `Out of allocation space in segment ${seg} at address ${hex(free)}`, section),
  /** L1103: <section name> not specified in the PLACEMENT block */
  notPlaced: (section: string) => msg('L1103', 'error', `${section} not specified in the PLACEMENT block`),
  /**
   * L1104: Absolute object <Object name> overlaps with segment <segment name>. Used for an ORG section overlapping
   * a placed section (segment = its PRM segment) or another ORG section (segment = `.absSegN`).
   * UNCERTAIN: CodeWarrior may check absolute objects against the whole segment range, not only the placed bytes.
   */
  absOverlap: (object: string, seg: string) => msg('L1104', 'error', `Absolute object ${object} overlaps with segment ${seg}`),
  /** L1106: <Object name> not found (INIT / MAIN / ENTRIES / VECTOR objects). UNCERTAIN L1106 vs L1107. */
  objectNotFound: (name: string) => msg('L1106', 'error', `${name} not found`),
  /** L1119: Vector allocated at absolute address <Address> overlaps with sections placed in segment <seg> */
  vectorOverlap: (addr: number, seg: string) =>
    msg('L1119', 'error', `Vector allocated at absolute address ${hex(addr)} overlaps with sections placed in segment ${seg}`),
  /**
   * L1110: <name> appears twice in PLACEMENT block (manual example: a segment). Also used for a section listed in
   * two placement statements. UNCERTAIN: which repetitions CodeWarrior reports (Lab3 lists EEPROM in seven statements
   * without error, so only a repetition inside one statement's segment list is reported for segments).
   */
  twiceInPlacement: (name: string, line?: number) => ({ ...msg('L1110', 'error', `${name} appears twice in PLACEMENT block`), ...(line ? { line } : {}) }),
  /** L1122: Section .copy must be the last section in the section list */
  copyNotLast: (line?: number) => ({ ...msg('L1122', 'error', 'Section .copy must be the last section in the section list'), ...(line ? { line } : {}) }),
  /** L1200: Both STACKTOP and STACKSIZE defined */
  bothStack: () => msg('L1200', 'error', 'Both STACKTOP and STACKSIZE defined'),
  /** L1201: No stack defined. UNCERTAIN severity (assembly applications do not need a linker stack). */
  noStack: () => msg('L1201', 'warning', 'No stack defined'),
  /** L1302: File <File name> not found (an INCLUDE in the PRM that `prmInclude` cannot resolve) */
  fileNotFound: (file: string, prm?: string) => msg('L1302', 'error', `File ${file} not found`, prm),
  /** L1303: <File name> is not a valid ELF file */
  notElf: (file: string, why: string) => msg('L1303', 'fatal', `${file} is not a valid ELF file (${why})`, file),
  /**
   * L1818: Symbol <n> - <name> duplicated in <file> and <file> (real message: "L1818: Symbol 241 - PORTA duplicated
   * in OS_FLAG.C.o and OS_CORE.C.o"). UNCERTAIN: <n> is taken as the symbol-table index of the duplicate definition
   * (second file); the order of the two files is first definition, then duplicate.
   */
  duplicate: (symIdx: number, name: string, a: string, b: string) =>
    msg('L1818', 'error', `Symbol ${symIdx} - ${name} duplicated in ${a} and ${b}`, b),
  /** L1822: Symbol <Symbol name> in file <File name> is undefined */
  undefinedSymbol: (name: string, file: string) => msg('L1822', 'error', `Symbol ${name} in file ${file} is undefined`, file),
  /** L1823: External object <Symbol name> in <File name> created by default (unknown __SEG_ symbol, value 0) */
  createdByDefault: (name: string, file: string) =>
    msg('L1823', 'warning', `External object ${name} in ${file} created by default`, file),
  /** L1903: Unexpected Symbol in Linkparameter file (used for every PRM syntax error). UNCERTAIN mapping. */
  prmSyntax: (text: string, file: string | undefined, line: number) => ({ ...msg('L1903', 'error', text, file), line }),
  /**
   * L1907: Fixup overflow in <object containing the fixup>, to <target> type <ELF type>, at offset <offset> (real
   * message: "L1907: Fixup overflow in handleCancel, to putAbort type 3, at offset 0x27"). Also used for relocation
   * (type, width) pairs never seen in CodeWarrior output. UNCERTAIN: the offset is taken relative to the containing
   * object; the code CW uses for unknown fixup types.
   */
  fixup: (object: string, target: string, type: number, offset: number, file?: string) =>
    msg('L1907', 'error', `Fixup overflow in ${object}, to ${target} type ${type}, at offset ${hex(offset)}`, file),
  unknownFixup: (text: string, file: string) => msg('L1907', 'error', text, file),
  /**
   * NOT a SmartLinker message: a PRM command / attribute this clone accepts but does not implement (NAMES files,
   * FILL, ALIGN, RELOCATE_TO, HEXFILE, CHECKSUM, MAPFILE section selection, ...). Reported so it is never silent.
   */
  unsupported: (text: string, line?: number) => ({ ...msg(CLONE_UNSUPPORTED, 'warning', text), ...(line ? { line } : {}) }),
  /** NOT a SmartLinker message: suspicious placement (uninitialised data in a READ_ONLY segment). */
  suspicious: (text: string, section: string) => msg(CLONE_SUSPICIOUS, 'warning', text, section),
} as const;

/** Codes of clone-specific diagnostics (SmartLinker has no equivalent; never L-numbers). */
export const CLONE_UNSUPPORTED = 'S12-UNSUPPORTED';
export const CLONE_SUSPICIOUS = 'S12-PLACEMENT';

function msg(code: string, severity: LinkSeverity, text: string, file?: string): LinkMessage {
  return file === undefined ? { code, severity, text } : { code, severity, text, file };
}

export const isError = (m: LinkMessage): boolean => m.severity === 'error' || m.severity === 'fatal';

/** CodeWarrior IDE style one-line rendering: "Link Error   : L1822: Symbol X in file Y is undefined". UNCERTAIN. */
export function formatLinkMessage(m: LinkMessage): string {
  const kind = m.severity === 'information' ? 'Information' : m.severity === 'warning' ? 'Warning' : 'Error';
  return `Link ${kind} : ${m.code}: ${m.text}`;
}
