/**
 * Shared types for device descriptions (register file, vectors, memory map).
 * One description drives the generated `.inc`, the simulator register file and the debugger's register views.
 */

/**
 * Register access class.
 * - `rw`      read/write
 * - `r`       read-only (writes ignored)
 * - `w`       write-only (reads return 0 unless noted)
 * - `w1c`     register holding write-1-to-clear flags; when `w1cMask` is present only those bits are W1C and the
 *             other bits behave as ordinary read/write (or read-only status) bits. Use `w1cMaskOf()`.
 * - `rw-once` writable once in normal modes, anytime in special modes
 * - `test`    factory test / reserved-for-test register (writes ignored in normal modes)
 */
export type Access = 'rw' | 'r' | 'w' | 'w1c' | 'rw-once' | 'test';

/** A single bit (width 1) or a multi-bit field (width > 1). `bit` is the least significant bit position. */
export interface BitField {
  name: string;
  bit: number;
  width: number;
}

export interface RegisterDef {
  /** CodeWarrior spelling (e.g. `PTP`, `SPI0CR1`, `IIC0_IBCR`). */
  name: string;
  /** Local (= global) address in the 2 KB register block. */
  address: number;
  size: 1 | 2;
  /** Owning module (e.g. `CRG`, `ECT`, `PIM`, `SCI0`). */
  module: string;
  /** Reset value (normal single-chip mode unless noted). */
  reset: number;
  access: Access;
  /** Short human description used in the `.inc` comments and debugger tooltips. */
  description: string;
  /** Bits and fields, MSB first. Undefined for "names only" registers (CAN, XGATE). */
  bits?: BitField[];
  /** For 16-bit registers: names of the high and low byte halves. */
  halves?: [string, string];
  /**
   * Write-1-to-clear bit mask. Present on every register that mixes W1C flags with other bits (CRGFLG, CRGINT.ILAF,
   * VREGCTRL.LVIF, PWMSDN.PWMIF, ...); such registers always have `access: 'w1c'`. Absent on a `w1c` register = all bits.
   */
  w1cMask?: number;
  /** Set when an aspect of this entry (address, reset value, bit names) is not verified against the datasheet. */
  uncertain?: string;
}

/**
 * An alternate name for an address that already belongs to a canonical register:
 * 16-bit composites of two 8-bit registers (PWMDTY01 = PWMDTY0:PWMDTY1) or banked alternates (SCI AMAP=1 registers).
 */
export interface RegisterAlias extends RegisterDef {
  /** Canonical register names this alias overlays (high byte first for composites). */
  aliasOf: string[];
  /** true = 16-bit concatenation of canonical 8-bit registers; false = alternate register at the same address. */
  composite: boolean;
  /** Set on 1-byte views of a 16-bit register (SCI0BDL, TCNTHi, PARTIDH, ...): which byte this is. */
  half?: 'high' | 'low';
}

export type VectorKind = 'reset' | 'non-maskable' | 'xirq' | 'maskable' | 'reserved' | 'spurious';

export interface VectorDef {
  /** CodeWarrior spelling (`Vreset`, `Vportj`, ...). */
  name: string;
  /** Other accepted names (e.g. `Vspurious` for `Vsi`). */
  aliases?: string[];
  /** Offset from the vector base (IVBR:00). $10..$FE. */
  offset: number;
  /** Absolute address with the reset IVBR ($FF): $FF00 + offset. */
  address: number;
  /** CodeWarrior / PRM `VECTOR n` number: (0xFE - offset) / 2. */
  number: number;
  source: string;
  kind: VectorKind;
  /** true for $FFFA-$FFFE: these do not move with IVBR. */
  fixed: boolean;
  /** CCR mask that gates the request: 'I', 'X' or none. */
  mask: 'I' | 'X' | null;
  /**
   * Fixed hardware priority rank among simultaneously pending requests, 0 = highest.
   * For I-maskable requests this applies only between requests at the same PRIOLVL (higher vector address wins).
   */
  priorityRank: number;
  /** Reset interrupt level (INT_CFDATAn.PRIOLVL) for configurable sources; null for non-configurable ones. */
  defaultLevel: number | null;
  /** XGATE channel id for sources routable to XGATE (RQST=1), else null. */
  xgateChannel: number | null;
  /** Peripheral flag(s) that request this vector, as `REG.BIT` strings (BIT is a bit or field of REG). */
  flags: string[];
  /** Local enable bit(s), as `REG.BIT` strings (BIT is a bit or field of REG). */
  enables: string[];
  uncertain?: string;
}

export interface MemoryRegion {
  name: string;
  kind: 'registers' | 'ram' | 'eeprom' | 'flash';
  globalStart: number;
  globalEnd: number;
  size: number;
}

/** A 16-bit local address range and how it maps to global addresses. */
export interface WindowDef {
  name: string;
  localStart: number;
  localEnd: number;
  /** Page register that selects the page, or null for a fixed mapping. */
  pageRegister: 'RPAGE' | 'EPAGE' | 'PPAGE' | null;
  /**
   * For fixed windows: the page the window is hard-wired to. Every fixed window spans exactly one page, so
   * global = page base + (local - localStart).
   */
  fixedPage?: number;
  target: MemoryRegion['kind'];
}

/** A named address range for the `.inc` memory-map equates and the linker's default segments. */
export interface MemorySegment {
  name: string;
  /** CodeWarrior 'logical' address: local 16-bit for non-paged, 0xPPAAAA for paged segments. */
  start: number;
  end: number;
}

export interface DeviceDescription {
  name: string;
  /** Header line used in generated include files. */
  title: string;
  registers: readonly RegisterDef[];
  aliases: readonly RegisterAlias[];
  vectors: readonly VectorDef[];
  regions: readonly MemoryRegion[];
  windows: readonly WindowDef[];
  segments: readonly MemorySegment[];
}
