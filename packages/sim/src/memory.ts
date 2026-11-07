/**
 * Global (23-bit) memory: one flat backing buffer for RAM, EEPROM and flash, a 1 KB-granular global block
 * map, and an "initialized" shadow (for the debugger's `uu` display / uninitialized-read detection).
 *
 * Global block map entries (`gmap[g >>> 10]`):
 *   >= 0       offset of the block in `mem`
 *   G_REGS     register block ($00_0000-$00_07FF)
 *   G_NONE     unimplemented (illegal access in single-chip mode)
 */
import type { DeviceDescription, MemoryRegion } from '@s12/devices';
import type { RamInit } from './types.js';

export const G_REGS = -2;
export const G_NONE = -1;
export const GLOBAL_SIZE = 0x800000;
export const BLOCK = 1024;

export interface RegionInfo {
  region: MemoryRegion;
  /** Offset of the region in `mem`. */
  offset: number;
}

export class Memory {
  /** RAM + EEPROM + flash, in device region order (registers excluded). */
  readonly mem: Uint8Array;
  /** 1 = written since power-on (or by the loader); always 1 for EEPROM/flash. */
  readonly init: Uint8Array;
  /** Global 1 KB block map, see file comment. */
  readonly gmap = new Int32Array(GLOBAL_SIZE / BLOCK).fill(G_NONE);
  /** Offset in `mem` where read-only (EEPROM/flash) storage starts; RAM is below. */
  readonly romStart: number;
  readonly regions: RegionInfo[] = [];
  ramInit: RamInit;
  private seed: number;

  constructor(device: DeviceDescription, ramInit: RamInit = 'uninitialized', seed = 0x5eed1234) {
    this.ramInit = ramInit;
    this.seed = seed >>> 0 || 1;
    const rw = device.regions.filter((r) => r.kind === 'ram');
    const ro = device.regions.filter((r) => r.kind === 'eeprom' || r.kind === 'flash');
    let size = 0;
    for (const r of [...rw, ...ro]) {
      if (r.globalStart % BLOCK || r.size % BLOCK) throw new Error(`region ${r.name} is not 1 KB aligned`);
      this.regions.push({ region: r, offset: size });
      for (let b = 0; b < r.size / BLOCK; b++) this.gmap[r.globalStart / BLOCK + b] = size + b * BLOCK;
      size += r.size;
    }
    this.romStart = rw.reduce((n, r) => n + r.size, 0);
    for (const r of device.regions.filter((x) => x.kind === 'registers')) {
      for (let g = r.globalStart; g <= r.globalEnd; g += BLOCK) this.gmap[g / BLOCK] = G_REGS;
    }
    this.mem = new Uint8Array(size);
    this.init = new Uint8Array(size);
    this.eraseNonVolatile();
    this.powerOnRam();
  }

  /** Offset of a global address in `mem`, or G_REGS / G_NONE. */
  offsetOf(g: number): number {
    const b = this.gmap[(g >>> 10) & 0x1fff];
    return b >= 0 ? b + (g & 0x3ff) : b;
  }

  regionOf(g: number): RegionInfo | undefined {
    return this.regions.find((r) => g >= r.region.globalStart && g <= r.region.globalEnd);
  }

  /** Erase EEPROM and flash to $FF. */
  eraseNonVolatile(): void {
    this.mem.fill(0xff, this.romStart);
    this.init.fill(1, this.romStart);
  }

  /** Power-on RAM content (ramInit) and clear the RAM "initialized" shadow. */
  powerOnRam(): void {
    const n = this.romStart;
    if (this.ramInit === 'random') {
      let s = this.seed;
      for (let i = 0; i < n; i++) {
        // xorshift32
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        this.mem[i] = s & 0xff;
      }
      this.seed = s >>> 0;
    } else {
      this.mem.fill(0, 0, n);
    }
    // 'zero' is RAM that reads 0 and is considered initialized (no `uu`).
    this.init.fill(this.ramInit === 'zero' ? 1 : 0, 0, n);
  }

  /** Loader/debugger write: any implemented global address including flash/EEPROM. Returns false if unmapped. */
  load(g: number, v: number): boolean {
    const o = this.offsetOf(g);
    if (o < 0) return false;
    this.mem[o] = v & 0xff;
    this.init[o] = 1;
    return true;
  }

  isInitialized(g: number): boolean {
    const o = this.offsetOf(g);
    return o >= 0 ? this.init[o] === 1 : true;
  }
}
