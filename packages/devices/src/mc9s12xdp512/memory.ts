/**
 * MC9S12XDP512 memory map and S12X MMC local -> global translation (single-chip mode, ROMHM = 0).
 * docs/research/r2/xdp512-device.md §2; RPAGE/EPAGE/PPAGE formulas from datasheet figs 17-12/13/15.
 */
import type { MemoryRegion, MemorySegment, WindowDef } from '../types.js';

export const REGS_GLOBAL = { start: 0x000000, end: 0x0007ff } as const;
export const RAM_GLOBAL = { start: 0x0f8000, end: 0x0fffff } as const;
export const EEPROM_GLOBAL = { start: 0x13f000, end: 0x13ffff } as const;
export const FLASH_GLOBAL = { start: 0x780000, end: 0x7fffff } as const;

export const REGIONS: readonly MemoryRegion[] = [
  { name: 'Registers', kind: 'registers', globalStart: REGS_GLOBAL.start, globalEnd: REGS_GLOBAL.end, size: 0x800 },
  { name: 'RAM', kind: 'ram', globalStart: RAM_GLOBAL.start, globalEnd: RAM_GLOBAL.end, size: 32 * 1024 },
  { name: 'EEPROM', kind: 'eeprom', globalStart: EEPROM_GLOBAL.start, globalEnd: EEPROM_GLOBAL.end, size: 4 * 1024 },
  { name: 'Flash', kind: 'flash', globalStart: FLASH_GLOBAL.start, globalEnd: FLASH_GLOBAL.end, size: 512 * 1024 },
];

/** Implemented page-register ranges on this device (single-chip). Pages outside them are unimplemented. */
export const PAGE_RANGES = {
  RPAGE: { first: 0xf8, last: 0xff },
  EPAGE: { first: 0xfc, last: 0xff },
  PPAGE: { first: 0xe0, last: 0xff },
} as const;

/** Local 64 KB map. */
export const WINDOWS: readonly WindowDef[] = [
  { name: 'Registers', localStart: 0x0000, localEnd: 0x07ff, pageRegister: null, target: 'registers' },
  { name: 'EEPROM window', localStart: 0x0800, localEnd: 0x0bff, pageRegister: 'EPAGE', target: 'eeprom' },
  { name: 'EEPROM fixed $0C00', localStart: 0x0c00, localEnd: 0x0fff, pageRegister: null, fixedPage: 0xff, target: 'eeprom' },
  { name: 'RAM window', localStart: 0x1000, localEnd: 0x1fff, pageRegister: 'RPAGE', target: 'ram' },
  { name: 'RAM fixed $2000', localStart: 0x2000, localEnd: 0x2fff, pageRegister: null, fixedPage: 0xfe, target: 'ram' },
  { name: 'RAM fixed $3000', localStart: 0x3000, localEnd: 0x3fff, pageRegister: null, fixedPage: 0xff, target: 'ram' },
  { name: 'Flash fixed $4000', localStart: 0x4000, localEnd: 0x7fff, pageRegister: null, fixedPage: 0xfd, target: 'flash' },
  { name: 'Flash window', localStart: 0x8000, localEnd: 0xbfff, pageRegister: 'PPAGE', target: 'flash' },
  { name: 'Flash fixed $C000', localStart: 0xc000, localEnd: 0xffff, pageRegister: null, fixedPage: 0xff, target: 'flash' },
];

/** Global base address of page `page` in a paged resource (RAM 4K pages, EEPROM 1K pages, flash 16K pages). */
export function pageBase(target: WindowDef['target'], page: number): number {
  const p = page & 0xff;
  switch (target) {
    case 'ram': return p << 12;
    case 'eeprom': return 0x100000 | (p << 10);
    case 'flash': return 0x400000 | (p << 14);
    case 'registers': return 0;
  }
}

/** Global address of `local` through window `w`; paged windows use `page` (default: the page register's reset value). */
export function windowToGlobal(w: WindowDef, local: number, page?: number): number {
  const a = local & 0xffff;
  if (a < w.localStart || a > w.localEnd) throw new Error(`0x${a.toString(16)} is outside window ${w.name}`);
  if (w.target === 'registers') return a;
  const resetPage = w.pageRegister === 'RPAGE' ? MMC_RESET.rpage : w.pageRegister === 'EPAGE' ? MMC_RESET.epage : MMC_RESET.ppage;
  const pg = w.pageRegister ? (page ?? resetPage) : (w.fixedPage as number);
  return pageBase(w.target, pg) + (a - w.localStart);
}

export interface MmcState {
  rpage: number;
  epage: number;
  ppage: number;
  gpage: number;
  direct: number;
}

/** MMC register reset values. */
export const MMC_RESET: Readonly<MmcState> = Object.freeze({ rpage: 0xfd, epage: 0xfe, ppage: 0xfe, gpage: 0x00, direct: 0x00 });

/** Translate a 16-bit CPU (local) address to a 23-bit global address. Missing page registers take reset values. */
export function localToGlobal(local: number, s: Partial<MmcState> = {}): number {
  const a = local & 0xffff;
  const rpage = (s.rpage ?? MMC_RESET.rpage) & 0xff;
  const epage = (s.epage ?? MMC_RESET.epage) & 0xff;
  const ppage = (s.ppage ?? MMC_RESET.ppage) & 0xff;
  if (a < 0x0800) return a; // registers
  if (a < 0x0c00) return 0x100000 | (epage << 10) | (a & 0x3ff);
  if (a < 0x1000) return 0x13fc00 | (a & 0x3ff);
  if (a < 0x2000) return (rpage << 12) | (a & 0xfff);
  if (a < 0x4000) return 0x0fc000 + a; // RAM pages $FE,$FF
  if (a < 0x8000) return 0x7f4000 + (a - 0x4000); // flash page $FD
  if (a < 0xc000) return 0x400000 | (ppage << 14) | (a & 0x3fff);
  return 0x7fc000 + (a - 0xc000); // flash page $FF
  // UNCERTAIN: ROMHM=1 (flash $4000-$7FFF to external space) and EROMON/ROMON=0 are not modelled.
}

/** Global address used by the G-instructions (GLDAA, GSTAA, ...): GPAGE:addr16. */
export const globalInstrAddress = (addr16: number, gpage: number): number => ((gpage & 0x7f) << 16) | (addr16 & 0xffff);

/** Effective address of a direct-mode operand (16-bit local): DIRECT:opr8. */
export const directAddress = (opr8: number, direct = 0): number => ((direct & 0xff) << 8) | (opr8 & 0xff);

/** Which resource a global address hits, or null if unimplemented (illegal access in single-chip mode). */
export function regionOfGlobal(g: number): MemoryRegion | null {
  for (const r of REGIONS) if (g >= r.globalStart && g <= r.globalEnd) return r;
  return null;
}

export type PageRegister = 'RPAGE' | 'EPAGE' | 'PPAGE';

/** The paging window a local address falls in, or null for non-paged addresses. */
export function pageRegisterForLocal(local: number): PageRegister | null {
  const a = local & 0xffff;
  if (a >= 0x0800 && a < 0x0c00) return 'EPAGE';
  if (a >= 0x1000 && a < 0x2000) return 'RPAGE';
  if (a >= 0x8000 && a < 0xc000) return 'PPAGE';
  return null;
}

// ---------------------------------------------------------------- CodeWarrior 'logical' addresses
// Project.prm uses 16-bit local addresses for non-paged segments and 0xPPAAAA (page:local) for paged ones,
// e.g. PAGE_E0 = 0xE08000..0xE0BFFF, EEPROM_FC = 0xFC0800..0xFC0BFF, RAM_F8 = 0xF81000..0xF81FFF.

export interface LogicalAddress {
  page: number | null;
  local: number;
}

export const makeLogical = (page: number, local: number): number => ((page & 0xff) << 16) | (local & 0xffff);

export function splitLogical(logical: number): LogicalAddress {
  if (logical <= 0xffff) return { page: null, local: logical };
  return { page: (logical >>> 16) & 0xff, local: logical & 0xffff };
}

/** CW logical address -> global. Non-paged logical addresses map with reset page registers. */
export function logicalToGlobal(logical: number): number {
  const { page, local } = splitLogical(logical);
  if (page === null) return localToGlobal(local);
  const reg = pageRegisterForLocal(local);
  if (reg === 'EPAGE') return localToGlobal(local, { epage: page });
  if (reg === 'RPAGE') return localToGlobal(local, { rpage: page });
  if (reg === 'PPAGE') return localToGlobal(local, { ppage: page });
  throw new Error(`logical address 0x${logical.toString(16)} is paged but local 0x${local.toString(16)} is not in a paging window`);
}

/** Global -> CW paged logical address (always in 0xPPAAAA form, through the paging window), or null if unmapped. */
export function globalToLogical(g: number): number | null {
  if (g >= RAM_GLOBAL.start && g <= RAM_GLOBAL.end) return makeLogical(g >>> 12, 0x1000 | (g & 0xfff));
  if (g >= EEPROM_GLOBAL.start && g <= EEPROM_GLOBAL.end) return makeLogical((g >>> 10) & 0xff, 0x0800 | (g & 0x3ff));
  if (g >= FLASH_GLOBAL.start && g <= FLASH_GLOBAL.end) return makeLogical((g >>> 14) & 0xff, 0x8000 | (g & 0x3fff));
  return null;
}

/** Global -> the non-paged local alias (fixed window) if one exists, e.g. 0x7FC000 -> 0xC000. */
export function globalToFixedLocal(g: number): number | null {
  if (g <= REGS_GLOBAL.end) return g;
  if (g >= 0x13fc00 && g <= 0x13ffff) return 0x0c00 + (g - 0x13fc00);
  if (g >= 0x0fe000 && g <= 0x0fffff) return 0x2000 + (g - 0x0fe000);
  if (g >= 0x7f4000 && g <= 0x7f7fff) return 0x4000 + (g - 0x7f4000);
  if (g >= 0x7fc000 && g <= 0x7fffff) return 0xc000 + (g - 0x7fc000);
  return null;
}

// ---------------------------------------------------------------- default segments (.inc memory-map equates)
const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

function buildSegments(): MemorySegment[] {
  // UNCERTAIN: exact set/extent of the stock .inc memory-map equates; these mirror the CW wizard Project.prm.
  const s: MemorySegment[] = [
    { name: 'RAM', start: 0x2000, end: 0x3fff },
    { name: 'EEPROM', start: 0x0c00, end: 0x0fff },
    { name: 'ROM_4000', start: 0x4000, end: 0x7fff },
    { name: 'ROM_C000', start: 0xc000, end: 0xffff },
  ];
  for (let p = PAGE_RANGES.RPAGE.first; p <= PAGE_RANGES.RPAGE.last; p++)
    s.push({ name: `RAM_${hex2(p)}`, start: makeLogical(p, 0x1000), end: makeLogical(p, 0x1fff) });
  for (let p = PAGE_RANGES.EPAGE.first; p <= PAGE_RANGES.EPAGE.last; p++)
    s.push({ name: `EEPROM_${hex2(p)}`, start: makeLogical(p, 0x0800), end: makeLogical(p, 0x0bff) });
  for (let p = PAGE_RANGES.PPAGE.first; p <= PAGE_RANGES.PPAGE.last; p++)
    s.push({ name: `PAGE_${hex2(p)}`, start: makeLogical(p, 0x8000), end: makeLogical(p, 0xbfff) });
  return s;
}

export const SEGMENTS: readonly MemorySegment[] = buildSegments();

/** Flash configuration field (global $7FFF00-$7FFF0F, local $FF00-$FF0F). */
export const FLASH_CONFIG = {
  backdoorKey: { local: 0xff00, global: 0x7fff00, size: 8 },
  fprot: { local: 0xff0d, global: 0x7fff0d },
  /** Loaded into FCTL at reset; CR[2:0] = ~NV[2:0], WCOP = ~NV[3] (critique C7). */
  copNv: { local: 0xff0e, global: 0x7fff0e },
  fsec: { local: 0xff0f, global: 0x7fff0f },
} as const;

/** EEPROM protection byte loaded into EPROT at reset. UNCERTAIN: $0FFD per research note §2.3. */
export const EEPROM_CONFIG = { eprot: { local: 0x0ffd, global: 0x13fffd } } as const;

/** COPCTL reset fields derived from the FCTL NV byte (critique C7). */
export function copResetFromNv(nv: number): { cr: number; wcop: boolean } {
  return { cr: ~nv & 0x07, wcop: (nv & 0x08) === 0 };
}
