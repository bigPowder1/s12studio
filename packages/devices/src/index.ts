import { fieldMask } from './bits.js';
import { MC9S12XDP512 } from './mc9s12xdp512/index.js';
import type { BitField, DeviceDescription, RegisterAlias, RegisterDef, VectorDef } from './types.js';

export * from './types.js';
export { parseBits, fieldMask } from './bits.js';
export * from './mc9s12xdp512/index.js';
export { generateIncFile, INC_LINE_PATTERNS, type IncOptions } from './inc.js';
export * from './me3305.js';

/** Default device for this project. */
export const DEFAULT_DEVICE: DeviceDescription = MC9S12XDP512;

interface Index {
  byName: Map<string, RegisterDef | RegisterAlias>;
  byAddr: Map<number, RegisterDef>;
  halves: RegisterAlias[];
  vecByOffset: Map<number, VectorDef>;
  vecByName: Map<string, VectorDef>;
}

/**
 * 1-byte views of a 16-bit register's byte halves (SCI0BDH/SCI0BDL, TCNTHi/TCNTLo, PARTIDH/PARTIDL, ...), with the
 * bits that fall entirely inside each byte renumbered 7..0. Empty for 8-bit registers or registers without halves.
 */
export function byteHalves(r: RegisterDef): RegisterAlias[] {
  if (r.size !== 2 || !r.halves) return [];
  return r.halves.map((name, i): RegisterAlias => {
    const high = i === 0;
    const lo = high ? 8 : 0;
    const shift = high ? 8 : 0;
    const v: RegisterAlias = {
      name,
      address: r.address + i,
      size: 1,
      module: r.module,
      reset: (r.reset >> shift) & 0xff,
      access: r.access,
      description: `${r.description} ${high ? 'High' : 'Low'} Byte`,
      aliasOf: [r.name],
      composite: false,
      half: high ? 'high' : 'low',
    };
    if (r.bits) {
      const bits = r.bits
        .filter((b) => b.bit >= lo && b.bit + b.width <= lo + 8)
        .map((b) => ({ name: b.name, bit: b.bit - lo, width: b.width }));
      if (bits.length) v.bits = bits;
    }
    if (r.w1cMask !== undefined) v.w1cMask = (r.w1cMask >> shift) & 0xff;
    if (r.uncertain) v.uncertain = r.uncertain;
    return v;
  });
}

/** Write-1-to-clear mask of a register (0 if it has no W1C bits). */
export function w1cMaskOf(r: RegisterDef): number {
  if (r.w1cMask !== undefined) return r.w1cMask;
  return r.access === 'w1c' ? (r.size === 2 ? 0xffff : 0xff) : 0;
}

const cache = new WeakMap<DeviceDescription, Index>();

function index(d: DeviceDescription): Index {
  let ix = cache.get(d);
  if (ix) return ix;
  const byName = new Map<string, RegisterDef | RegisterAlias>();
  const byAddr = new Map<number, RegisterDef>();
  for (const r of d.registers) {
    byName.set(r.name.toUpperCase(), r);
    for (let i = 0; i < r.size; i++) byAddr.set(r.address + i, r);
  }
  for (const a of d.aliases) if (!byName.has(a.name.toUpperCase())) byName.set(a.name.toUpperCase(), a);
  const halves = d.registers.flatMap(byteHalves);
  for (const h of halves) if (!byName.has(h.name.toUpperCase())) byName.set(h.name.toUpperCase(), h);
  const vecByOffset = new Map<number, VectorDef>();
  const vecByName = new Map<string, VectorDef>();
  for (const v of d.vectors) {
    vecByOffset.set(v.offset, v);
    vecByName.set(v.name.toLowerCase(), v);
    for (const a of v.aliases ?? []) vecByName.set(a.toLowerCase(), v);
  }
  ix = { byName, byAddr, halves, vecByOffset, vecByName };
  cache.set(d, ix);
  return ix;
}

/**
 * Register by name, case-insensitive: canonical registers first, then aliases (PWMDTY01, SCI0ASR1, DBGMFR), then
 * byte halves of 16-bit registers (SCI0BDL, TCNTHi, PARTIDH, ATD0DR0H, FADDRHI; see `byteHalves`).
 */
export function registerByName(name: string, device: DeviceDescription = DEFAULT_DEVICE): RegisterDef | RegisterAlias | undefined {
  return index(device).byName.get(name.toUpperCase());
}

/** Canonical register covering a local address in $0000-$07FF (either byte of a 16-bit register). */
export function registerByAddress(addr: number, device: DeviceDescription = DEFAULT_DEVICE): RegisterDef | undefined {
  return index(device).byAddr.get(addr);
}

/** All byte-half views of the device's 16-bit registers (see `byteHalves`). */
export function registerHalves(device: DeviceDescription = DEFAULT_DEVICE): readonly RegisterAlias[] {
  return index(device).halves;
}

/**
 * Vector whose slot is at a 16-bit address for the given IVBR (default $FF, the reset value), e.g. 0xFFCE -> Vportj.
 * $FFFA-$FFFE (reset, clock monitor, COP) are fixed and resolve regardless of IVBR; IVBR:$FA..$FE does not.
 * Inverse of `vectorAddress(v, ivbr)`.
 */
export function vectorByAddress(addr: number, ivbr = 0xff, device: DeviceDescription = DEFAULT_DEVICE): VectorDef | undefined {
  const a = addr & 0xffff;
  const off = a & 0xff;
  const vecs = index(device).vecByOffset;
  if ((a & 0xff00) === 0xff00 && off >= 0xfa) return vecs.get(off);
  if (a >> 8 !== (ivbr & 0xff)) return undefined;
  const v = vecs.get(off);
  return v && !v.fixed ? v : undefined;
}

/** Vector by IVBR-relative offset ($10..$FE). */
export function vectorByOffset(offset: number, device: DeviceDescription = DEFAULT_DEVICE): VectorDef | undefined {
  return index(device).vecByOffset.get(offset & 0xff);
}

/** Vector by name (case-insensitive; accepts aliases such as Vspurious). */
export function vectorByName(name: string, device: DeviceDescription = DEFAULT_DEVICE): VectorDef | undefined {
  return index(device).vecByName.get(name.toLowerCase());
}

/** A named bit or field of a register. */
export function bitField(reg: string, bit: string, device: DeviceDescription = DEFAULT_DEVICE): BitField | undefined {
  return registerByName(reg, device)?.bits?.find((b) => b.name.toUpperCase() === bit.toUpperCase());
}

/** Mask of a named bit/field, e.g. mask('TSCR1', 'TFFCA') === 0x10. Throws if unknown. */
export function mask(reg: string, bit: string, device: DeviceDescription = DEFAULT_DEVICE): number {
  const f = bitField(reg, bit, device);
  if (!f) throw new Error(`unknown bit ${reg}.${bit}`);
  return fieldMask(f);
}

/** Address of a register by name. Throws if unknown. */
export function addr(reg: string, device: DeviceDescription = DEFAULT_DEVICE): number {
  const r = registerByName(reg, device);
  if (!r) throw new Error(`unknown register ${reg}`);
  return r.address;
}

/** Register addresses and bit masks used by the ME3305 library and Lab3 (checked against the table by tests). */
export const ME3305_MASKS = {
  TSCR1_TEN: 0x80,
  TSCR1_TSFRZ: 0x20,
  TSCR1_TFFCA: 0x10,
  TIOS_IOS1: 0x02,
  TFLG1_C1F: 0x02,
  CLKSEL_PLLSEL: 0x80,
  PLLCTL_PLLON: 0x40,
  PLLCTL_AUTO: 0x20,
  CRGFLG_LOCK: 0x08,
  ECLKCTL_NECLK: 0x80,
  SPI0CR1_SPE: 0x40,
  SPI0CR1_MSTR: 0x10,
  SPI0CR2_SPC0: 0x01,
  SPI0SR_SPIF: 0x80,
  SPI0SR_SPTEF: 0x20,
  PIEJ_PIEJ7: 0x80,
  PIFJ_PIFJ7: 0x80,
  PTJ_PTJ7: 0x80,
  PWMCTL_CON01: 0x10,
  PWME_PWME1: 0x02,
  PWMPOL_PPOL1: 0x02,
  PWMCLK_PCLK1: 0x02,
  PWMCAE_CAE1: 0x02,
  ATD1CTL2_ADPU: 0x80,
  ATD1CTL2_AFFC: 0x40,
  ATD1CTL2_AWAI: 0x20,
  ATD1STAT0_SCF: 0x80,
  PUCR_PUPKE: 0x80,
  PUCR_PUPEE: 0x10,
  PUCR_PUPBE: 0x02,
  PUCR_PUPAE: 0x01,
} as const;
