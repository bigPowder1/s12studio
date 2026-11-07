import type { DeviceDescription } from '../types.js';
import { REGIONS, SEGMENTS, WINDOWS } from './memory.js';
import { REGISTER_ALIASES, REGISTERS } from './registers.js';
import { VECTORS } from './vectors.js';

export * from './memory.js';
export { REGISTERS, REGISTER_ALIASES } from './registers.js';
export { VECTORS, vectorAddress } from './vectors.js';

export const MC9S12XDP512: DeviceDescription = {
  name: 'MC9S12XDP512',
  title: 'MC9S12XDP512 (S12XD family, 112-pin LQFP)',
  registers: REGISTERS,
  aliases: REGISTER_ALIASES,
  vectors: VECTORS,
  regions: REGIONS,
  windows: WINDOWS,
  segments: SEGMENTS,
};

/** CPU state after reset (critique C9): CCR = $D0 (S, X, I set; IPL = 0), PC fetched from the $FFFE vector. */
export const CPU_RESET = Object.freeze({
  ccr: 0xd0,
  ccrh: 0x00,
  resetVector: 0xfffe,
  /** Global address of the reset vector (local $FFFE through the fixed flash page $FF). */
  resetVectorGlobal: 0x7ffffe,
});

/**
 * Bus clock before the PLL is engaged = OSCCLK / 2. PLLCLK = 2 * OSCCLK * (SYNR + 1) / (REFDV + 1); BUSCLK = SYSCLK / 2.
 */
export function busClockHz(oscHz: number, opts: { pllsel: boolean; synr: number; refdv: number }): number {
  const sys = opts.pllsel ? (2 * oscHz * ((opts.synr & 0x3f) + 1)) / ((opts.refdv & 0x3f) + 1) : oscHz;
  return sys / 2;
}
