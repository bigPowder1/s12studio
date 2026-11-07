/**
 * Cycle-counting S12X (CPU12X) core: every CPU12 + CPU12X instruction of @s12/isa with exact CCR rules,
 * cycle counts taken from the isa access-detail strings (precomputed in tables.ts), the CPU12X exception
 * model (CCRW/IPL, 10-byte frames, IVBR, SYS/TRAP/spurious), WAI/STOP/BGND, and the run loop with
 * breakpoints, watchpoints and event-driven peripheral scheduling.
 *
 * Hot path design: one `exec()` switch per page, register fields on `this`, memory through Int32Array
 * block maps into one Uint8Array (no allocation per step, no generic decoder).
 */
import { decodeTfrExg, type XferReg } from '@s12/isa';
import { ILLEGAL_ACCESS, hex, type Bus, type BusClient } from './bus.js';
import {
  InterruptController,
  VEC_CLKMON,
  VEC_COP,
  VEC_RESET,
  VEC_SPURIOUS,
  VEC_SWI,
  VEC_SYS,
  VEC_TRAP,
  VEC_XIRQ,
} from './interrupts.js';
import * as T from './tables.js';
import type { HaltReason, ResetCause, WatchHit } from './types.js';

// CCR bits
const C = 0x01;
const V = 0x02;
const Z = 0x04;
const N = 0x08;
const I = 0x10;
const H = 0x20;
const XB = 0x40;
const S = 0x80;

/** CPU run states. */
export const CPU_RUN = 0;
export const CPU_WAIT = 1;
export const CPU_STOP = 2;

// stop codes (halt after the current instruction)
const SC_NONE = 0;
const SC_BGND = 1;
const SC_WATCH = 2;
const SC_UNINIT_VECTOR = 3;
const SC_HALT = 4;

// TFR/EXG register codes
const R_A = 0;
const R_B = 1;
const R_CCR = 2;
const R_TMP3 = 3;
const R_D = 4;
const R_X = 5;
const R_Y = 6;
const R_SP = 7;
const R_CCRH = 8;
const R_CCRW = 9;
const R_XH = 10;
const R_XL = 11;
const R_YH = 12;
const R_YL = 13;
const R_SPH = 14;
const R_SPL = 15;
const R_TMP2 = 16;
const REG_CODE: Record<XferReg, number> = {
  A: R_A, B: R_B, CCR: R_CCR, TMP3: R_TMP3, TMP2: R_TMP2, D: R_D, X: R_X, Y: R_Y, SP: R_SP,
  CCRH: R_CCRH, CCRW: R_CCRW, XH: R_XH, XL: R_XL, YH: R_YH, YL: R_YL, SPH: R_SPH, SPL: R_SPL,
};
const WIDE = new Uint8Array(17);
for (const r of [R_TMP3, R_D, R_X, R_Y, R_SP, R_CCRW, R_TMP2]) WIDE[r] = 1;
/** Per postbyte: 0 TFR, 1 EXG, 2 SEX; source and destination register codes. */
const XK = new Uint8Array(256);
const XS = new Uint8Array(256);
const XD = new Uint8Array(256);
for (let eb = 0; eb < 256; eb++) {
  const d = decodeTfrExg(eb, 's12x');
  XK[eb] = d.op === 'TFR' ? 0 : d.op === 'EXG' ? 1 : 2;
  XS[eb] = REG_CODE[d.src];
  XD[eb] = REG_CODE[d.dst];
}

/** UNCERTAIN: ADED/ADEX/ADEY set Z from the result alone; SBEx/CPEx chain Z (Z = Zold & result==0). */
const ADE_CHAINS_Z = false;
const SBE_CHAINS_Z = true;

const s8 = (v: number): number => ((v & 0xff) ^ 0x80) - 0x80;
const s16 = (v: number): number => ((v & 0xffff) ^ 0x8000) - 0x8000;

export interface CpuOptions {
  /** BGND halts the simulation ('bgnd') as with a BDM debugger attached (default true); false = NOP. */
  bdm: boolean;
  /** Halt with 'illegal-access' instead of performing the illegal-address reset (default false). */
  breakOnIllegalAccess: boolean;
  /** Halt with 'uninitialized-vector' when an interrupt/reset vector reads $FFFF (default false: warn only). */
  haltOnUninitializedVector: boolean;
  /** In WAI with no scheduled peripheral event, return 'wait-idle' instead of letting time pass (default false). */
  haltWhenIdle: boolean;
}

export interface CpuState {
  a: number;
  b: number;
  x: number;
  y: number;
  sp: number;
  pc: number;
  ccr: number;
  ipl: number;
  tmp1: number;
  tmp2: number;
  tmp3: number;
  cycles: number;
  state: number;
  iClr: boolean;
}

export class Cpu implements BusClient {
  // architectural registers
  a = 0;
  b = 0;
  x = 0;
  y = 0;
  sp = 0;
  pc = 0;
  /** CCRL: S X H I N Z V C. */
  ccr = 0xd0;
  /** CCRH IPL[2:0]. */
  ipl = 0;
  tmp1 = 0;
  tmp2 = 0;
  tmp3 = 0;

  /** Total bus cycles (exact integer up to 2^53). */
  cycles = 0;
  state = CPU_RUN;
  /** Start address of the current instruction. */
  ipc = 0;
  /** Table key of the current instruction (page << 8 | opcode). */
  private key = 0;
  /** Indexed class (0..4) of the last indexed operand. */
  private cls = 0;
  /** Pointer address of the last indirect indexed operand. */
  private indPtr = 0;
  direct = 0;

  /** Something needs attention before the next instruction (interrupt lines, WAI/STOP, CLI delay, reset). */
  private attn = true;
  /** An instruction just cleared I: the next instruction executes before interrupts are recognised. */
  private iClr = false;
  private resetPending: ResetCause | null = null;
  private stopCode = SC_NONE;
  /**
   * PC of the breakpoint the last run() halted at, skipped once by the next run() so a resume does not
   * re-hit it; -1 once any instruction/exception has executed or PC was changed (reset, restore, setRegisters).
   */
  bpSkipPc = -1;
  /** Run-loop deadline: min(next peripheral event, end of run). */
  private limit = 0;
  private runEnd = 0;

  lastWatchHit: WatchHit | null = null;
  /** Vector of the last taken exception (for the debugger / tests). */
  lastVector = -1;

  private readonly mem: Uint8Array;
  private readonly init: Uint8Array;
  private readonly rmap: Int32Array;
  private readonly wmap: Int32Array;
  private readonly fmap: Int32Array;
  readonly bus: Bus;
  readonly xint: InterruptController;

  /** Execution breakpoints: bitmap over the 64 KB local space; 2 = global-qualified entries exist. */
  readonly bpMap = new Uint8Array(0x10000);
  private bpGlobal = new Map<number, Set<number>>();

  opts: CpuOptions;
  /** Performs a full system reset (wired by S12XSystem). */
  systemReset: (cause: ResetCause) => void = (cause) => this.reset(cause);

  constructor(bus: Bus, opts: Partial<CpuOptions> = {}) {
    this.bus = bus;
    this.xint = bus.xint;
    this.mem = bus.memory.mem;
    this.init = bus.memory.init;
    this.rmap = bus.rmap;
    this.wmap = bus.wmap;
    this.fmap = bus.fmap;
    this.opts = {
      bdm: opts.bdm ?? true,
      breakOnIllegalAccess: opts.breakOnIllegalAccess ?? false,
      haltOnUninitializedVector: opts.haltOnUninitializedVector ?? false,
      haltWhenIdle: opts.haltWhenIdle ?? false,
    };
    bus.client = this;
    this.xint.onAssert = () => {
      this.attn = true;
    };
  }

  // ================================================================= BusClient

  scheduleChanged(): void {
    const n = this.bus.nextEvent;
    this.limit = n < this.runEnd ? n : this.runEnd;
  }

  wake(): void {
    this.attn = true;
  }

  watchHit(hit: WatchHit): void {
    // The first matching access of the instruction is reported.
    if (this.stopCode === SC_NONE) {
      this.lastWatchHit = hit;
      this.stopCode = SC_WATCH;
    }
  }

  requestReset(cause: ResetCause): void {
    this.resetPending = cause;
    this.attn = true;
  }

  /** Ask the run loop to stop after the current instruction ('halt'). */
  requestHalt(): void {
    if (this.stopCode === SC_NONE) this.stopCode = SC_HALT;
  }

  // ================================================================= registers

  get d(): number {
    return (this.a << 8) | this.b;
  }
  set d(v: number) {
    this.a = (v >> 8) & 0xff;
    this.b = v & 0xff;
  }
  get ccrw(): number {
    return (this.ipl << 8) | this.ccr;
  }
  set ccrw(v: number) {
    this.ipl = (v >> 8) & 7;
    this.ccr = v & 0xff;
  }

  /** CPU-internal reset sequence (MMC/peripherals are reset by the system first). */
  reset(cause: ResetCause = 'external'): void {
    this.ccr = 0xd0;
    this.ipl = 0;
    this.state = CPU_RUN;
    this.iClr = false;
    this.resetPending = null;
    this.attn = true;
    this.bpSkipPc = -1;
    const vec = cause === 'cop' ? VEC_COP : cause === 'clock-monitor' ? VEC_CLKMON : VEC_RESET;
    this.lastVector = vec;
    this.ipc = 0xff00 | vec;
    this.pc = this.readVector(0xff00 | vec);
  }

  // ================================================================= memory

  private fetch8(): number {
    const pc = this.pc;
    this.pc = (pc + 1) & 0xffff;
    const o = this.fmap[pc >>> 10];
    return o >= 0 ? this.mem[o + (pc & 0x3ff)] : this.bus.fetch(pc);
  }

  private fetch16(): number {
    const h = this.fetch8();
    return (h << 8) | this.fetch8();
  }

  rd8(a: number): number {
    const o = this.rmap[a >>> 10];
    return o >= 0 ? this.mem[o + (a & 0x3ff)] : this.bus.read(a, this.cycles + T.RDOFF[this.key * 5 + this.cls]);
  }

  rd16(a: number): number {
    if ((a & 0x3ff) === 0x3ff) this.bus.misalignedWord(a, -1, 'read');
    return (this.rd8(a) << 8) | this.rd8((a + 1) & 0xffff);
  }

  wr8(a: number, v: number): void {
    const o = this.wmap[a >>> 10];
    if (o >= 0) {
      const i = o + (a & 0x3ff);
      this.mem[i] = v;
      this.init[i] = 1;
    } else this.bus.write(a, v & 0xff, this.cycles + T.WROFF[this.key * 5 + this.cls]);
  }

  wr16(a: number, v: number): void {
    if ((a & 0x3ff) === 0x3ff) this.bus.misalignedWord(a, -1, 'write');
    this.wr8(a, (v >> 8) & 0xff);
    this.wr8((a + 1) & 0xffff, v & 0xff);
  }

  private gaddr(ea: number): number {
    return ((this.bus.gpage & 0x7f) << 16) | (ea & 0xffff);
  }
  private grd8(ea: number): number {
    return this.bus.readG(this.gaddr(ea), ea & 0xffff, this.cycles + T.RDOFF[this.key * 5 + this.cls]);
  }
  private grd16(ea: number): number {
    // UNCERTAIN: the second byte is GPAGE:(EA+1) with the 16-bit part wrapping.
    if ((ea & 0x3ff) === 0x3ff) this.bus.misalignedWord(ea & 0xffff, this.gaddr(ea), 'read');
    return (this.grd8(ea) << 8) | this.grd8((ea + 1) & 0xffff);
  }
  private gwr8(ea: number, v: number): void {
    this.bus.writeG(this.gaddr(ea), ea & 0xffff, v & 0xff, this.cycles + T.WROFF[this.key * 5 + this.cls]);
  }
  private gwr16(ea: number, v: number): void {
    if ((ea & 0x3ff) === 0x3ff) this.bus.misalignedWord(ea & 0xffff, this.gaddr(ea), 'write');
    this.gwr8(ea, v >> 8);
    this.gwr8((ea + 1) & 0xffff, v);
  }

  private push8(v: number): void {
    this.sp = (this.sp - 1) & 0xffff;
    this.wr8(this.sp, v & 0xff);
  }
  private push16(v: number): void {
    this.sp = (this.sp - 2) & 0xffff;
    if ((this.sp & 0x3ff) === 0x3ff) this.bus.misalignedWord(this.sp, -1, 'write');
    this.wr8(this.sp, (v >> 8) & 0xff);
    this.wr8((this.sp + 1) & 0xffff, v & 0xff);
  }
  private pull8(): number {
    const v = this.rd8(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return v;
  }
  private pull16(): number {
    const v = this.rd16(this.sp);
    this.sp = (this.sp + 2) & 0xffff;
    return v;
  }

  // ================================================================= effective addresses

  private eaDir(): number {
    return (this.direct << 8) | this.fetch8();
  }

  private ireg(r: number, trail: number): number {
    return r === 0 ? this.x : r === 1 ? this.y : r === 2 ? this.sp : (this.pc + trail) & 0xffff;
  }

  /**
   * Indexed effective address. `trail` = operand bytes that follow the indexed operand (PC-relative base
   * is the address of the next instruction); `trailInd` = the same for the indirect variants (CALL has no
   * page byte after an indirect operand).
   */
  private eaIdx(trail: number, trailInd: number): number {
    const xb = this.fetch8();
    if ((xb & 0x20) === 0) {
      this.cls = 0;
      return (this.ireg(xb >> 6, trail) + (((xb & 0x1f) ^ 0x10) - 0x10)) & 0xffff;
    }
    if ((xb & 0xe0) !== 0xe0) {
      this.cls = 0;
      const rr = xb >> 6;
      const n = xb & 0x0f;
      const d = n < 8 ? n + 1 : n - 16;
      let r = rr === 0 ? this.x : rr === 1 ? this.y : this.sp;
      let ea: number;
      if (xb & 0x10) {
        ea = r;
        r = (r + d) & 0xffff;
      } else {
        r = (r + d) & 0xffff;
        ea = r;
      }
      if (rr === 0) this.x = r;
      else if (rr === 1) this.y = r;
      else this.sp = r;
      return ea;
    }
    const rr = (xb >> 3) & 3;
    switch (xb & 7) {
      case 0: {
        const e = this.fetch8();
        this.cls = 1;
        return (this.ireg(rr, trail) + e) & 0xffff;
      }
      case 1: {
        const e = this.fetch8();
        this.cls = 1;
        return (this.ireg(rr, trail) + e - 256) & 0xffff;
      }
      case 2: {
        const e = this.fetch16();
        this.cls = 2;
        return (this.ireg(rr, trail) + e) & 0xffff;
      }
      case 3: {
        const e = this.fetch16();
        this.cls = 4;
        const p = (this.ireg(rr, trailInd) + e) & 0xffff;
        this.indPtr = p;
        return this.rd16(p);
      }
      case 4:
        this.cls = 0;
        return (this.ireg(rr, trail) + this.a) & 0xffff;
      case 5:
        this.cls = 0;
        return (this.ireg(rr, trail) + this.b) & 0xffff;
      case 6:
        this.cls = 0;
        return (this.ireg(rr, trail) + ((this.a << 8) | this.b)) & 0xffff;
      default: {
        this.cls = 3;
        const p = (this.ireg(rr, trailInd) + ((this.a << 8) | this.b)) & 0xffff;
        this.indPtr = p;
        return this.rd16(p);
      }
    }
  }

  // ================================================================= flags / ALU

  private nzv8(r: number): void {
    this.ccr = (this.ccr & 0xf1) | (r & 0x80 ? N : 0) | (r === 0 ? Z : 0);
  }
  private nzv16(r: number): void {
    this.ccr = (this.ccr & 0xf1) | (r & 0x8000 ? N : 0) | (r === 0 ? Z : 0);
  }
  private tst8(r: number): void {
    this.ccr = (this.ccr & 0xf0) | (r & 0x80 ? N : 0) | (r === 0 ? Z : 0);
  }
  private tst16(r: number): void {
    this.ccr = (this.ccr & 0xf0) | (r & 0x8000 ? N : 0) | (r === 0 ? Z : 0);
  }

  private add8(a: number, m: number, cin: number): number {
    const r = a + m + cin;
    const rr = r & 0xff;
    this.ccr =
      (this.ccr & 0xd0) |
      ((a ^ m ^ r) & 0x10 ? H : 0) |
      (rr & 0x80 ? N : 0) |
      (rr === 0 ? Z : 0) |
      ((a ^ r) & (m ^ r) & 0x80 ? V : 0) |
      (r > 0xff ? C : 0);
    return rr;
  }

  private sub8(a: number, m: number, bin: number): number {
    const r = a - m - bin;
    const rr = r & 0xff;
    this.ccr =
      (this.ccr & 0xf0) | (rr & 0x80 ? N : 0) | (rr === 0 ? Z : 0) | ((a ^ m) & (a ^ rr) & 0x80 ? V : 0) | (r < 0 ? C : 0);
    return rr;
  }

  private add16(a: number, m: number, cin: number, chainZ = false): number {
    const r = a + m + cin;
    const rr = r & 0xffff;
    const z = rr === 0 && (!chainZ || (this.ccr & Z) !== 0);
    this.ccr =
      (this.ccr & 0xf0) |
      (rr & 0x8000 ? N : 0) |
      (z ? Z : 0) |
      ((a ^ r) & (m ^ r) & 0x8000 ? V : 0) |
      (r > 0xffff ? C : 0);
    return rr;
  }

  private sub16(a: number, m: number, bin: number, chainZ = false): number {
    const r = a - m - bin;
    const rr = r & 0xffff;
    const z = rr === 0 && (!chainZ || (this.ccr & Z) !== 0);
    this.ccr =
      (this.ccr & 0xf0) | (rr & 0x8000 ? N : 0) | (z ? Z : 0) | ((a ^ m) & (a ^ rr) & 0x8000 ? V : 0) | (r < 0 ? C : 0);
    return rr;
  }

  /** 8-bit read-modify-write ops in opcode order: NEG COM INC DEC LSR ROL ROR ASR ASL. */
  private rmw8(k: number, v: number): number {
    const c0 = this.ccr;
    let r: number;
    let f: number;
    switch (k) {
      case 0:
        r = -v & 0xff;
        f = (c0 & 0xf0) | (r === 0x80 ? V : 0) | (r !== 0 ? C : 0);
        break;
      case 1:
        r = ~v & 0xff;
        f = (c0 & 0xf0) | C;
        break;
      case 2:
        r = (v + 1) & 0xff;
        f = (c0 & 0xf1) | (r === 0x80 ? V : 0);
        break;
      case 3:
        r = (v - 1) & 0xff;
        f = (c0 & 0xf1) | (r === 0x7f ? V : 0);
        break;
      case 4: {
        const co = v & 1;
        r = v >> 1;
        f = (c0 & 0xf0) | (co ? C | V : 0); // N = 0, so V = C
        break;
      }
      case 5: {
        const co = v >> 7;
        r = ((v << 1) | (c0 & 1)) & 0xff;
        f = (c0 & 0xf0) | co | ((r >> 7) ^ co ? V : 0);
        break;
      }
      case 6: {
        const co = v & 1;
        r = (v >> 1) | ((c0 & 1) << 7);
        f = (c0 & 0xf0) | co | ((r >> 7) ^ co ? V : 0);
        break;
      }
      case 7: {
        const co = v & 1;
        r = (v >> 1) | (v & 0x80);
        f = (c0 & 0xf0) | co | ((r >> 7) ^ co ? V : 0);
        break;
      }
      default: {
        const co = v >> 7;
        r = (v << 1) & 0xff;
        f = (c0 & 0xf0) | co | ((r >> 7) ^ co ? V : 0);
        break;
      }
    }
    this.ccr = f | (r & 0x80 ? N : 0) | (r === 0 ? Z : 0);
    return r;
  }

  /** 16-bit versions (CPU12X NEGW..ASLW, NEGX.., NEGY..; ASLD/LSRD). */
  private rmw16(k: number, v: number): number {
    const c0 = this.ccr;
    let r: number;
    let f: number;
    switch (k) {
      case 0:
        r = -v & 0xffff;
        f = (c0 & 0xf0) | (r === 0x8000 ? V : 0) | (r !== 0 ? C : 0);
        break;
      case 1:
        r = ~v & 0xffff;
        f = (c0 & 0xf0) | C;
        break;
      case 2:
        r = (v + 1) & 0xffff;
        f = (c0 & 0xf1) | (r === 0x8000 ? V : 0);
        break;
      case 3:
        r = (v - 1) & 0xffff;
        f = (c0 & 0xf1) | (r === 0x7fff ? V : 0);
        break;
      case 4: {
        const co = v & 1;
        r = v >> 1;
        f = (c0 & 0xf0) | (co ? C | V : 0);
        break;
      }
      case 5: {
        const co = v >> 15;
        r = ((v << 1) | (c0 & 1)) & 0xffff;
        f = (c0 & 0xf0) | co | ((r >> 15) ^ co ? V : 0);
        break;
      }
      case 6: {
        const co = v & 1;
        r = (v >> 1) | ((c0 & 1) << 15);
        f = (c0 & 0xf0) | co | ((r >> 15) ^ co ? V : 0);
        break;
      }
      case 7: {
        const co = v & 1;
        r = (v >> 1) | (v & 0x8000);
        f = (c0 & 0xf0) | co | ((r >> 15) ^ co ? V : 0);
        break;
      }
      default: {
        const co = v >> 15;
        r = (v << 1) & 0xffff;
        f = (c0 & 0xf0) | co | ((r >> 15) ^ co ? V : 0);
        break;
      }
    }
    this.ccr = f | (r & 0x8000 ? N : 0) | (r === 0 ? Z : 0);
    return r;
  }

  /** Write CCRL from an instruction: X can only be cleared; clearing I delays interrupts by one instruction. */
  private setCcr(v: number): void {
    const old = this.ccr;
    v = v & 0xff & (old | ~XB);
    this.ccr = v;
    if (old & I && !(v & I)) {
      this.iClr = true;
      this.attn = true;
    }
  }
  private setCcrw(v: number): void {
    this.ipl = (v >> 8) & 7;
    this.setCcr(v & 0xff);
  }

  private cond(cc: number): boolean {
    const c = this.ccr;
    switch (cc) {
      case 0:
        return true;
      case 1:
        return false;
      case 2:
        return (c & (C | Z)) === 0;
      case 3:
        return (c & (C | Z)) !== 0;
      case 4:
        return (c & C) === 0;
      case 5:
        return (c & C) !== 0;
      case 6:
        return (c & Z) === 0;
      case 7:
        return (c & Z) !== 0;
      case 8:
        return (c & V) === 0;
      case 9:
        return (c & V) !== 0;
      case 10:
        return (c & N) === 0;
      case 11:
        return (c & N) !== 0;
      case 12:
        return (((c >> 3) ^ (c >> 1)) & 1) === 0;
      case 13:
        return (((c >> 3) ^ (c >> 1)) & 1) !== 0;
      case 14:
        return (c & Z) === 0 && (((c >> 3) ^ (c >> 1)) & 1) === 0;
      default:
        return (c & Z) !== 0 || (((c >> 3) ^ (c >> 1)) & 1) !== 0;
    }
  }

  // ================================================================= exceptions

  /** CPU12X 10-byte frame: RTN, Y, X, A, B, CCRW (CCRH at the lowest address). */
  private pushFrame(ret: number): void {
    this.push16(ret);
    this.push16(this.y);
    this.push16(this.x);
    this.push8(this.a);
    this.push8(this.b);
    this.push16((this.ipl << 8) | this.ccr);
  }

  private readVector(addr: number): number {
    const v = this.rd16(addr);
    if (v === 0xffff) {
      this.bus.emit({
        kind: 'uninitialized-vector',
        message: `vector at 0x${hex(addr, 4)} is not initialized ($FFFF)`,
        address: addr,
      });
      if (this.opts.haltOnUninitializedVector && this.stopCode === SC_NONE) this.stopCode = SC_UNINIT_VECTOR;
    }
    return v;
  }

  /**
   * Mask updates and vector fetch for an exception at IVBR-relative `off` (frame already stacked).
   * Maskable: I=1, IPL=level. XIRQ: X=I=1, IPL unchanged. SWI/TRAP/SYS/spurious: I=1, IPL unchanged (C6).
   */
  private vectorTo(off: number, level: number): void {
    if (off === VEC_XIRQ) this.ccr |= XB | I;
    else {
      this.ccr |= I;
      if (level > 0) this.ipl = level & 7;
    }
    this.iClr = false;
    this.lastVector = off;
    this.pc = this.readVector(this.xint.vectorAddress(off));
    if (this.xint.onVectorTaken) this.xint.onVectorTaken(off);
  }

  /** Take a hardware interrupt from the run state: stack, re-arbitrate (spurious), vector. */
  private interrupt(): number {
    this.pushFrame(this.pc);
    // The request may have been withdrawn (or a higher one arrived) while stacking.
    let o = this.xint.select(this.ccr, this.ipl);
    if (o < 0) o = VEC_SPURIOUS;
    this.vectorTo(o, o === VEC_XIRQ || o === VEC_SPURIOUS ? 0 : this.xint.selectedLevel);
    return T.CYC_IRQ_ENTRY;
  }

  private swi(off: number, cycles: number): number {
    this.pushFrame(this.pc);
    this.vectorTo(off, 0);
    return cycles;
  }

  /**
   * Interrupts, resets, WAI/STOP and the CLI delay, at an instruction boundary.
   * Returns 0 = execute the next instruction, -1 = state changed (loop again), >0 = halt reason code.
   */
  private attention(): number {
    if (this.resetPending !== null) {
      const cause = this.resetPending;
      this.resetPending = null;
      this.systemReset(cause);
      return -1;
    }
    if (this.iClr) {
      // The instruction after CLI/ANDCC/TAP... always executes.
      this.iClr = false;
      if (this.state === CPU_RUN) return 0;
    }
    const xs = this.xint;
    if (xs.pending.length !== 0) {
      const off = xs.select(this.ccr, this.ipl);
      if (off >= 0) {
        if (this.state === CPU_RUN) {
          this.cycles += this.interrupt();
        } else {
          // WAI/STOP: the frame is already stacked; vector fetch + queue refill only.
          this.state = CPU_RUN;
          this.vectorTo(off, off === VEC_XIRQ ? 0 : xs.selectedLevel);
          this.cycles += T.CYC_WAKE;
        }
        return -1;
      }
      if (this.state === CPU_STOP && xs.line[VEC_XIRQ >> 1] && this.ccr & XB) {
        // UNCERTAIN: XIRQ with X=1 wakes STOP and resumes after the STOP instruction (frame discarded).
        this.state = CPU_RUN;
        this.sp = (this.sp + 10) & 0xffff;
        this.cycles += T.CYC_STOP_DISABLED;
        return -1;
      }
    }
    if (this.state === CPU_RUN) {
      this.attn = xs.pending.length !== 0;
      return 0;
    }
    if (this.state === CPU_STOP) return 6; // 'stop'
    // WAIT: let time pass until the next peripheral event (or the end of the run).
    const next = this.bus.nextEvent;
    if (next === Infinity && this.opts.haltWhenIdle) return 7; // 'wait-idle'
    const t = next < this.runEnd ? next : this.runEnd;
    if (t === Infinity) return 7;
    if (t > this.cycles) this.cycles = t;
    return -1;
  }

  // ================================================================= run loop

  /** Execute until `maxCycles` bus cycles have elapsed or a halt condition. */
  run(maxCycles: number): HaltReason {
    this.runEnd = this.cycles + maxCycles;
    this.limit = Math.min(this.bus.nextEvent, this.runEnd);
    // A requestHalt() issued between runs (e.g. a UI "stop" between run slices) stops this run at once.
    if (this.stopCode === SC_HALT) {
      this.stopCode = SC_NONE;
      return 'halt';
    }
    this.stopCode = SC_NONE;
    // Only the breakpoint this CPU last halted at is skipped, and only before anything executes.
    let skipPc = this.bpSkipPc;
    const bp = this.bpMap;
    for (;;) {
      try {
        for (;;) {
          if (this.cycles >= this.limit) {
            if (this.cycles >= this.bus.nextEvent) this.bus.service(this.cycles);
            this.limit = Math.min(this.bus.nextEvent, this.runEnd);
            if (this.cycles >= this.runEnd) return 'limit';
          }
          if (this.attn) {
            const r = this.attention();
            if (r !== 0) {
              if (r > 0) return REASONS[r];
              skipPc = this.bpSkipPc = -1;
              if (this.stopCode !== SC_NONE) return this.finishStop();
              continue;
            }
          }
          if (bp[this.pc] !== 0 && this.pc !== skipPc && this.isBreak(this.pc)) {
            this.bpSkipPc = this.pc;
            return 'breakpoint';
          }
          if (skipPc >= 0) skipPc = this.bpSkipPc = -1;
          this.cycles += this.exec();
          if (this.stopCode !== SC_NONE) return this.finishStop();
        }
      } catch (e) {
        if (e !== ILLEGAL_ACCESS) throw e;
        skipPc = this.bpSkipPc = -1;
        const r = this.onIllegal();
        if (r) return r;
      }
    }
  }

  /**
   * Execute exactly one instruction (taking a pending interrupt first, as the hardware would; with
   * `stopAfterException` the step ends right after the exception is stacked and vectored). Breakpoints
   * are not checked; a pending requestHalt() is discarded. In WAIT, time advances event by event until an
   * interrupt wakes the CPU ('wait-idle' if no peripheral event is scheduled).
   */
  step(opts: { stopAfterException?: boolean } = {}): HaltReason {
    this.stopCode = SC_NONE;
    this.bpSkipPc = -1;
    // No run deadline: attention() returns 'wait-idle' when WAIT has no event to wait for.
    this.runEnd = Infinity;
    this.limit = Math.min(this.bus.nextEvent, this.runEnd);
    try {
      for (let guard = 0; guard < 1_000_000; guard++) {
        if (this.cycles >= this.bus.nextEvent) this.bus.service(this.cycles);
        if (this.attn) {
          const r = this.attention();
          if (r > 0) return REASONS[r];
          if (r < 0) {
            if (this.stopCode !== SC_NONE) return this.finishStop();
            // An exception (interrupt, reset) was entered: with stopAfterException the step ends at the vector
            // target, before the handler's first instruction (debugger single-step; a WAIT time-advance keeps
            // the CPU in WAIT and loops). UNCERTAIN: S12X BDM TRACE1 with a pending interrupt.
            if (opts.stopAfterException && this.state === CPU_RUN) return 'step';
            continue;
          }
        }
        this.cycles += this.exec();
        if (this.stopCode !== SC_NONE) return this.finishStop();
        return 'step';
      }
      return 'wait-idle';
    } catch (e) {
      if (e !== ILLEGAL_ACCESS) throw e;
      return this.onIllegal() ?? 'step';
    }
  }

  private finishStop(): HaltReason {
    const c = this.stopCode;
    this.stopCode = SC_NONE;
    return c === SC_BGND ? 'bgnd' : c === SC_WATCH ? 'watchpoint' : c === SC_UNINIT_VECTOR ? 'uninitialized-vector' : 'halt';
  }

  private onIllegal(): HaltReason | null {
    if (this.opts.breakOnIllegalAccess) {
      this.pc = this.ipc;
      return 'illegal-access';
    }
    this.systemReset('illegal-address');
    return null;
  }

  // ================================================================= breakpoints

  /** Add an execution breakpoint at a local address; with `global`, only when it maps to that global address. */
  addBreakpoint(local: number, global?: number): void {
    const a = local & 0xffff;
    if (global === undefined) this.bpMap[a] |= 1;
    else {
      this.bpMap[a] |= 2;
      let s = this.bpGlobal.get(a);
      if (!s) this.bpGlobal.set(a, (s = new Set()));
      s.add(global);
    }
  }

  removeBreakpoint(local: number, global?: number): void {
    const a = local & 0xffff;
    if (global === undefined) this.bpMap[a] &= ~1;
    else {
      const s = this.bpGlobal.get(a);
      s?.delete(global);
      if (!s || s.size === 0) {
        this.bpGlobal.delete(a);
        this.bpMap[a] &= ~2;
      }
    }
  }

  clearBreakpoints(): void {
    this.bpMap.fill(0);
    this.bpGlobal.clear();
  }

  private isBreak(pc: number): boolean {
    const m = this.bpMap[pc];
    if (m & 1) return true;
    const s = this.bpGlobal.get(pc);
    return s !== undefined && s.has(this.bus.toGlobal(pc));
  }

  // ================================================================= snapshot

  snapshot(): CpuState {
    return {
      a: this.a,
      b: this.b,
      x: this.x,
      y: this.y,
      sp: this.sp,
      pc: this.pc,
      ccr: this.ccr,
      ipl: this.ipl,
      tmp1: this.tmp1,
      tmp2: this.tmp2,
      tmp3: this.tmp3,
      cycles: this.cycles,
      state: this.state,
      iClr: this.iClr,
    };
  }

  restore(s: CpuState): void {
    this.a = s.a;
    this.b = s.b;
    this.x = s.x;
    this.y = s.y;
    this.sp = s.sp;
    this.pc = s.pc;
    this.ccr = s.ccr;
    this.ipl = s.ipl;
    this.tmp1 = s.tmp1;
    this.tmp2 = s.tmp2;
    this.tmp3 = s.tmp3;
    this.cycles = s.cycles;
    this.state = s.state;
    this.iClr = s.iClr;
    this.direct = this.bus.direct;
    this.attn = true;
    this.stopCode = SC_NONE;
    this.bpSkipPc = -1;
  }

  // ================================================================= TFR / EXG

  private xget(r: number): number {
    switch (r) {
      case R_A:
        return this.a;
      case R_B:
        return this.b;
      case R_CCR:
        return this.ccr;
      case R_TMP3:
        return this.tmp3;
      case R_D:
        return (this.a << 8) | this.b;
      case R_X:
        return this.x;
      case R_Y:
        return this.y;
      case R_SP:
        return this.sp;
      case R_CCRH:
        return this.ipl;
      case R_CCRW:
        return (this.ipl << 8) | this.ccr;
      case R_XH:
        return this.x >> 8;
      case R_XL:
        return this.x & 0xff;
      case R_YH:
        return this.y >> 8;
      case R_YL:
        return this.y & 0xff;
      case R_SPH:
        return this.sp >> 8;
      case R_SPL:
        return this.sp & 0xff;
      default:
        return this.tmp2;
    }
  }

  private xset(r: number, v: number): void {
    switch (r) {
      case R_A:
        this.a = v & 0xff;
        break;
      case R_B:
        this.b = v & 0xff;
        break;
      case R_CCR:
        this.setCcr(v & 0xff);
        break;
      case R_TMP3:
        this.tmp3 = v & 0xffff;
        break;
      case R_D:
        this.a = (v >> 8) & 0xff;
        this.b = v & 0xff;
        break;
      case R_X:
        this.x = v & 0xffff;
        break;
      case R_Y:
        this.y = v & 0xffff;
        break;
      case R_SP:
        this.sp = v & 0xffff;
        break;
      case R_CCRH:
        this.ipl = v & 7;
        break;
      case R_CCRW:
        this.setCcrw(v & 0xffff);
        break;
      case R_XH:
        this.x = ((v & 0xff) << 8) | (this.x & 0xff);
        break;
      case R_XL:
        this.x = (this.x & 0xff00) | (v & 0xff);
        break;
      case R_YH:
        this.y = ((v & 0xff) << 8) | (this.y & 0xff);
        break;
      case R_YL:
        this.y = (this.y & 0xff00) | (v & 0xff);
        break;
      case R_SPH:
        this.sp = ((v & 0xff) << 8) | (this.sp & 0xff);
        break;
      case R_SPL:
        this.sp = (this.sp & 0xff00) | (v & 0xff);
        break;
      default:
        this.tmp2 = v & 0xffff;
    }
  }

  private xfer(eb: number): void {
    const s = XS[eb];
    const d = XD[eb];
    const k = XK[eb];
    if (k !== 1) {
      let v = this.xget(s);
      const sw = WIDE[s];
      const dw = WIDE[d];
      if (sw && !dw) v &= 0xff;
      else if (!sw && dw) v = v & 0x80 ? v | 0xff00 : v; // 8 -> 16 sign-extends (SEX)
      else if (k === 2 && sw) v = v & 0x8000 ? 0xffff : 0; // CPU12X SEX D,X / SEX D,Y / SEX D,SP
      this.xset(d, v);
      return;
    }
    const vs = this.xget(s);
    const vd = this.xget(d);
    if (WIDE[s] === WIDE[d]) {
      this.xset(s, vd);
      this.xset(d, vs);
    } else if (!WIDE[s]) {
      // 8-bit first: r2 <- $00:r1, r1 <- r2 low.
      // UNCERTAIN: write order for EXG A/B,D (CPU12RM calls these ambiguous): r1 first, then r2.
      this.xset(s, vd & 0xff);
      this.xset(d, vs & 0xff);
    } else {
      // 16-bit first, 8-bit second: r2 <- r1 low, r1 <- fill:r2 ($FF fill for B and CCR, $00 for A).
      const fill = d === R_B || d === R_CCR ? 0xff00 : 0;
      this.xset(d, vs & 0xff);
      this.xset(s, fill | (vd & 0xff));
    }
  }

  // ================================================================= loop primitives

  private loopReg(r: number): number {
    switch (r) {
      case 0:
        return this.a;
      case 1:
        return this.b;
      case 4:
        return (this.a << 8) | this.b;
      case 5:
        return this.x;
      case 6:
        return this.y;
      default:
        return this.sp;
    }
  }

  private setLoopReg(r: number, v: number): void {
    switch (r) {
      case 0:
        this.a = v;
        break;
      case 1:
        this.b = v;
        break;
      case 4:
        this.a = v >> 8;
        this.b = v & 0xff;
        break;
      case 5:
        this.x = v;
        break;
      case 6:
        this.y = v;
        break;
      default:
        this.sp = v;
    }
  }

  private loopPrim(): number {
    const lb = this.fetch8();
    const rr = this.fetch8();
    const kind = lb >> 5;
    const r = lb & 7;
    if (kind > 5 || r === 2 || r === 3) {
      // UNCERTAIN: undefined loop-primitive encodings; executed as a 3-cycle NOP with a warning.
      this.bus.emit({
        kind: 'illegal-opcode',
        message: `undefined loop primitive postbyte 0x${hex(lb, 2)} at 0x${hex(this.ipc, 4)} executed as NOP`,
        address: this.ipc,
      });
      return T.CYC[4];
    }
    let v = this.loopReg(r);
    const mask = r >= 4 ? 0xffff : 0xff;
    if (kind < 2) {
      v = (v - 1) & mask;
      this.setLoopReg(r, v);
    } else if (kind >= 4) {
      v = (v + 1) & mask;
      this.setLoopReg(r, v);
    }
    if ((v === 0) !== ((kind & 1) === 1)) {
      this.pc = (this.pc + (lb & 0x10 ? rr - 256 : rr)) & 0xffff;
      return T.CYC[4];
    }
    return T.CYCN[4];
  }

  // ================================================================= page 1

  /** Execute one instruction; returns its bus cycles. */
  exec(): number {
    this.ipc = this.pc;
    const op = this.fetch8();
    this.key = op;
    switch (op) {
      case 0x00: // BGND
        if (this.opts.bdm) {
          this.tmp2 = this.pc;
          this.stopCode = SC_BGND;
        }
        return T.CYC[0];
      case 0x01:
        return this.mem_();
      case 0x02:
        this.y = (this.y + 1) & 0xffff;
        this.ccr = (this.ccr & ~Z) | (this.y === 0 ? Z : 0);
        return 1;
      case 0x03:
        this.y = (this.y - 1) & 0xffff;
        this.ccr = (this.ccr & ~Z) | (this.y === 0 ? Z : 0);
        return 1;
      case 0x04:
        return this.loopPrim();
      case 0x05:
        this.pc = this.eaIdx(0, 0);
        return T.CYCI[0x05 * 5 + this.cls];
      case 0x06:
        this.pc = this.fetch16();
        return T.CYC[0x06];
      case 0x07: {
        const r = s8(this.fetch8());
        this.push16(this.pc);
        this.pc = (this.pc + r) & 0xffff;
        return T.CYC[0x07];
      }
      case 0x08:
        this.x = (this.x + 1) & 0xffff;
        this.ccr = (this.ccr & ~Z) | (this.x === 0 ? Z : 0);
        return 1;
      case 0x09:
        this.x = (this.x - 1) & 0xffff;
        this.ccr = (this.ccr & ~Z) | (this.x === 0 ? Z : 0);
        return 1;
      case 0x0a: // RTC
        this.bus.setPpage(this.pull8());
        this.pc = this.pull16();
        return T.CYC[0x0a];
      case 0x0b:
        return this.rti();
      case 0x0c:
      case 0x0d: {
        const ea = this.eaIdx(1, 1);
        const m = this.fetch8();
        const v = op === 0x0c ? this.rd8(ea) | m : this.rd8(ea) & ~m & 0xff;
        this.wr8(ea, v);
        this.nzv8(v);
        return T.CYCI[op * 5 + this.cls];
      }
      case 0x0e:
      case 0x0f: {
        const ea = this.eaIdx(2, 2);
        const m = this.fetch8();
        const rel = s8(this.fetch8());
        const v = this.rd8(ea);
        if (op === 0x0e ? (~v & m) === 0 : (v & m) === 0) this.pc = (this.pc + rel) & 0xffff;
        return T.CYCI[op * 5 + this.cls];
      }
      case 0x10:
        this.setCcr(this.ccr & this.fetch8());
        return 1;
      case 0x11:
        return this.ediv();
      case 0x12: {
        const r = this.a * this.b;
        this.a = r >> 8;
        this.b = r & 0xff;
        this.ccr = (this.ccr & ~C) | (r & 0x80 ? C : 0);
        return T.CYC[0x12];
      }
      case 0x13: {
        const r = ((this.a << 8) | this.b) * this.y; // < 2^32, exact
        this.y = Math.floor(r / 65536);
        this.a = (r >> 8) & 0xff;
        this.b = r & 0xff;
        this.ccr = (this.ccr & 0xf2) | (this.y & 0x8000 ? N : 0) | (r === 0 ? Z : 0) | (r & 0x8000 ? C : 0);
        return T.CYC[0x13];
      }
      case 0x14: {
        // ORCC cannot set X.
        const v = this.fetch8();
        this.setCcr(this.ccr | v);
        return 1;
      }
      case 0x15: {
        const t = this.eaIdx(0, 0);
        this.push16(this.pc);
        this.pc = t;
        return T.CYCI[0x15 * 5 + this.cls];
      }
      case 0x16: {
        const t = this.fetch16();
        this.push16(this.pc);
        this.pc = t;
        return T.CYC[0x16];
      }
      case 0x17: {
        const t = this.eaDir();
        this.push16(this.pc);
        this.pc = t;
        return T.CYC[0x17];
      }
      case 0x18:
        return this.exec2();
      case 0x19:
        this.y = this.eaIdx(0, 0);
        return T.CYCI[0x19 * 5 + this.cls];
      case 0x1a:
        this.x = this.eaIdx(0, 0);
        return T.CYCI[0x1a * 5 + this.cls];
      case 0x1b:
        this.sp = this.eaIdx(0, 0);
        return T.CYCI[0x1b * 5 + this.cls];
      case 0x1c:
      case 0x1d:
      case 0x4c:
      case 0x4d: {
        const ea = op < 0x40 ? this.fetch16() : this.eaDir();
        const m = this.fetch8();
        const v = (op & 1) === 0 ? this.rd8(ea) | m : this.rd8(ea) & ~m & 0xff;
        this.wr8(ea, v);
        this.nzv8(v);
        return T.CYC[op];
      }
      case 0x1e:
      case 0x1f:
      case 0x4e:
      case 0x4f: {
        const ea = op < 0x40 ? this.fetch16() : this.eaDir();
        const m = this.fetch8();
        const rel = s8(this.fetch8());
        const v = this.rd8(ea);
        if ((op & 1) === 0 ? (~v & m) === 0 : (v & m) === 0) this.pc = (this.pc + rel) & 0xffff;
        return T.CYC[op];
      }
      case 0x20:
      case 0x21:
      case 0x22:
      case 0x23:
      case 0x24:
      case 0x25:
      case 0x26:
      case 0x27:
      case 0x28:
      case 0x29:
      case 0x2a:
      case 0x2b:
      case 0x2c:
      case 0x2d:
      case 0x2e:
      case 0x2f: {
        const r = this.fetch8();
        if (this.cond(op & 15)) {
          this.pc = (this.pc + ((r ^ 0x80) - 0x80)) & 0xffff;
          return T.CYC[op];
        }
        return T.CYCN[op];
      }
      case 0x30:
        this.x = this.pull16();
        return 3;
      case 0x31:
        this.y = this.pull16();
        return 3;
      case 0x32:
        this.a = this.pull8();
        return 3;
      case 0x33:
        this.b = this.pull8();
        return 3;
      case 0x34:
        this.push16(this.x);
        return 2;
      case 0x35:
        this.push16(this.y);
        return 2;
      case 0x36:
        this.push8(this.a);
        return 2;
      case 0x37:
        this.push8(this.b);
        return 2;
      case 0x38:
        this.setCcr(this.pull8());
        return 3;
      case 0x39:
        this.push8(this.ccr);
        return 2;
      case 0x3a: {
        const v = this.pull16();
        this.a = v >> 8;
        this.b = v & 0xff;
        return 3;
      }
      case 0x3b:
        this.push16((this.a << 8) | this.b);
        return 2;
      case 0x3c:
        return this.wavr();
      case 0x3d:
        this.pc = this.pull16();
        return T.CYC[0x3d];
      case 0x3e: // WAI
        this.pushFrame(this.pc);
        this.state = CPU_WAIT;
        this.attn = true;
        return T.CYC[0x3e];
      case 0x3f:
        return this.swi(VEC_SWI, T.CYC[0x3f]);
      case 0x40:
      case 0x41:
      case 0x42:
      case 0x43:
      case 0x44:
      case 0x45:
      case 0x46:
      case 0x47:
      case 0x48:
        this.a = this.rmw8(op - 0x40, this.a);
        return 1;
      case 0x49: {
        const r = this.rmw16(4, (this.a << 8) | this.b);
        this.a = r >> 8;
        this.b = r & 0xff;
        return 1;
      }
      case 0x4a: {
        const t = this.fetch16();
        const pg = this.fetch8();
        this.push16(this.pc);
        this.push8(this.bus.ppage);
        this.bus.setPpage(pg);
        this.pc = t;
        return T.CYC[0x4a];
      }
      case 0x4b: {
        const t = this.eaIdx(1, 0);
        const pg = this.cls >= 3 ? this.rd8((this.indPtr + 2) & 0xffff) : this.fetch8();
        this.push16(this.pc);
        this.push8(this.bus.ppage);
        this.bus.setPpage(pg);
        this.pc = t;
        return T.CYCI[0x4b * 5 + this.cls];
      }
      case 0x50:
      case 0x51:
      case 0x52:
      case 0x53:
      case 0x54:
      case 0x55:
      case 0x56:
      case 0x57:
      case 0x58:
        this.b = this.rmw8(op - 0x50, this.b);
        return 1;
      case 0x59: {
        const r = this.rmw16(8, (this.a << 8) | this.b);
        this.a = r >> 8;
        this.b = r & 0xff;
        return 1;
      }
      case 0x5a:
      case 0x5b:
      case 0x5c:
      case 0x5d:
      case 0x5e:
      case 0x5f:
        this.store(op, this.eaDir());
        return T.CYC[op];
      case 0x60:
      case 0x61:
      case 0x62:
      case 0x63:
      case 0x64:
      case 0x65:
      case 0x66:
      case 0x67:
      case 0x68: {
        const ea = this.eaIdx(0, 0);
        this.wr8(ea, this.rmw8(op - 0x60, this.rd8(ea)));
        return T.CYCI[op * 5 + this.cls];
      }
      case 0x69: {
        const ea = this.eaIdx(0, 0);
        this.wr8(ea, 0);
        this.ccr = (this.ccr & 0xf0) | Z;
        return T.CYCI[0x69 * 5 + this.cls];
      }
      case 0x6a:
      case 0x6b:
      case 0x6c:
      case 0x6d:
      case 0x6e:
      case 0x6f:
        this.store(op, this.eaIdx(0, 0));
        return T.CYCI[op * 5 + this.cls];
      case 0x70:
      case 0x71:
      case 0x72:
      case 0x73:
      case 0x74:
      case 0x75:
      case 0x76:
      case 0x77:
      case 0x78: {
        const ea = this.fetch16();
        this.wr8(ea, this.rmw8(op - 0x70, this.rd8(ea)));
        return T.CYC[op];
      }
      case 0x79: {
        const ea = this.fetch16();
        this.wr8(ea, 0);
        this.ccr = (this.ccr & 0xf0) | Z;
        return T.CYC[0x79];
      }
      case 0x7a:
      case 0x7b:
      case 0x7c:
      case 0x7d:
      case 0x7e:
      case 0x7f:
        this.store(op, this.fetch16());
        return T.CYC[op];
      default:
        return this.alu1(op);
    }
  }

  /** STAA/STAB/STD/STY/STX/STS by opcode low nibble. */
  private store(op: number, ea: number): void {
    switch (op & 15) {
      case 0xa:
        this.wr8(ea, this.a);
        this.nzv8(this.a);
        break;
      case 0xb:
        this.wr8(ea, this.b);
        this.nzv8(this.b);
        break;
      case 0xc: {
        const d = (this.a << 8) | this.b;
        this.wr16(ea, d);
        this.nzv16(d);
        break;
      }
      case 0xd:
        this.wr16(ea, this.y);
        this.nzv16(this.y);
        break;
      case 0xe:
        this.wr16(ea, this.x);
        this.nzv16(this.x);
        break;
      default:
        this.wr16(ea, this.sp);
        this.nzv16(this.sp);
    }
  }

  /** Page 1 $80-$FF: accumulator/index ALU groups (IMM/DIR/IDX/EXT by bits 5:4). */
  private alu1(op: number): number {
    const lo = op & 15;
    const mode = (op >> 4) & 3;
    if (lo === 7) {
      switch (op) {
        case 0x87:
          this.a = 0;
          this.ccr = (this.ccr & 0xf0) | Z;
          return 1;
        case 0x97:
          this.tst8(this.a);
          return 1;
        case 0xa7:
          return 1;
        case 0xb7:
          this.xfer(this.fetch8());
          return 1;
        case 0xc7:
          this.b = 0;
          this.ccr = (this.ccr & 0xf0) | Z;
          return 1;
        case 0xd7:
          this.tst8(this.b);
          return 1;
        case 0xe7:
          this.tst8(this.rd8(this.eaIdx(0, 0)));
          return T.CYCI[0xe7 * 5 + this.cls];
        default:
          this.tst8(this.rd8(this.fetch16()));
          return T.CYC[0xf7];
      }
    }
    const wide = lo === 3 || lo >= 0xc;
    let v: number;
    if (mode === 0) v = wide ? this.fetch16() : this.fetch8();
    else {
      const ea = mode === 1 ? this.eaDir() : mode === 2 ? this.eaIdx(0, 0) : this.fetch16();
      v = wide ? this.rd16(ea) : this.rd8(ea);
    }
    if (op < 0xc0) {
      switch (lo) {
        case 0:
          this.a = this.sub8(this.a, v, 0);
          break;
        case 1:
          this.sub8(this.a, v, 0);
          break;
        case 2:
          this.a = this.sub8(this.a, v, this.ccr & C);
          break;
        case 3: {
          const r = this.sub16((this.a << 8) | this.b, v, 0);
          this.a = r >> 8;
          this.b = r & 0xff;
          break;
        }
        case 4:
          this.a &= v;
          this.nzv8(this.a);
          break;
        case 5:
          this.nzv8(this.a & v);
          break;
        case 6:
          this.a = v;
          this.nzv8(v);
          break;
        case 8:
          this.a ^= v;
          this.nzv8(this.a);
          break;
        case 9:
          this.a = this.add8(this.a, v, this.ccr & C);
          break;
        case 0xa:
          this.a |= v;
          this.nzv8(this.a);
          break;
        case 0xb:
          this.a = this.add8(this.a, v, 0);
          break;
        case 0xc:
          this.sub16((this.a << 8) | this.b, v, 0);
          break;
        case 0xd:
          this.sub16(this.y, v, 0);
          break;
        case 0xe:
          this.sub16(this.x, v, 0);
          break;
        default:
          this.sub16(this.sp, v, 0);
      }
    } else {
      switch (lo) {
        case 0:
          this.b = this.sub8(this.b, v, 0);
          break;
        case 1:
          this.sub8(this.b, v, 0);
          break;
        case 2:
          this.b = this.sub8(this.b, v, this.ccr & C);
          break;
        case 3: {
          const r = this.add16((this.a << 8) | this.b, v, 0);
          this.a = r >> 8;
          this.b = r & 0xff;
          break;
        }
        case 4:
          this.b &= v;
          this.nzv8(this.b);
          break;
        case 5:
          this.nzv8(this.b & v);
          break;
        case 6:
          this.b = v;
          this.nzv8(v);
          break;
        case 8:
          this.b ^= v;
          this.nzv8(this.b);
          break;
        case 9:
          this.b = this.add8(this.b, v, this.ccr & C);
          break;
        case 0xa:
          this.b |= v;
          this.nzv8(this.b);
          break;
        case 0xb:
          this.b = this.add8(this.b, v, 0);
          break;
        case 0xc:
          this.a = v >> 8;
          this.b = v & 0xff;
          this.nzv16(v);
          break;
        case 0xd:
          this.y = v;
          this.nzv16(v);
          break;
        case 0xe:
          this.x = v;
          this.nzv16(v);
          break;
        default:
          this.sp = v;
          this.nzv16(v);
      }
    }
    return mode === 2 ? T.CYCI[op * 5 + this.cls] : T.CYC[op];
  }

  // ================================================================= page 2

  private exec2(): number {
    const op = this.fetch8();
    const key = 0x100 | op;
    this.key = key;
    if (T.TRAP2[op] !== 0) return this.swi(VEC_TRAP, T.CYC[key]);
    switch (op) {
      case 0x00:
      case 0x01:
      case 0x02:
      case 0x03:
      case 0x04:
      case 0x05:
      case 0x08:
      case 0x09:
      case 0x0a:
      case 0x0b:
      case 0x0c:
      case 0x0d:
        return this.move(op);
      case 0x06:
        this.a = this.add8(this.a, this.b, 0);
        return 2;
      case 0x07:
        return this.daa();
      case 0x0e:
        this.b = this.a;
        this.nzv8(this.a);
        return 2;
      case 0x0f:
        this.a = this.b;
        this.nzv8(this.b);
        return 2;
      case 0x10:
        return this.idiv();
      case 0x11:
        return this.fdiv();
      case 0x12:
        return this.emacs();
      case 0x13: {
        const r = s16((this.a << 8) | this.b) * s16(this.y); // fits in int32
        const u = r >>> 0;
        this.y = u >>> 16;
        this.a = (u >> 8) & 0xff;
        this.b = u & 0xff;
        this.ccr = (this.ccr & 0xf2) | (r < 0 ? N : 0) | (r === 0 ? Z : 0) | (u & 0x8000 ? C : 0);
        return T.CYC[key];
      }
      case 0x14:
        return this.edivs();
      case 0x15:
        return this.idivs();
      case 0x16:
        this.a = this.sub8(this.a, this.b, 0);
        return 2;
      case 0x17:
        this.sub8(this.a, this.b, 0);
        return 2;
      case 0x18:
      case 0x19:
      case 0x1a:
      case 0x1b:
      case 0x1c:
      case 0x1d:
      case 0x1e:
      case 0x1f:
        return this.minmax(op);
      case 0x20:
      case 0x21:
      case 0x22:
      case 0x23:
      case 0x24:
      case 0x25:
      case 0x26:
      case 0x27:
      case 0x28:
      case 0x29:
      case 0x2a:
      case 0x2b:
      case 0x2c:
      case 0x2d:
      case 0x2e:
      case 0x2f: {
        const r = this.fetch16();
        if (this.cond(op & 15)) {
          this.pc = (this.pc + r) & 0xffff;
          return T.CYC[key];
        }
        return T.CYCN[key];
      }
      case 0x35:
      case 0x36:
      case 0x37: {
        // BTAS: UNCERTAIN CCR effect - N/Z from (M & mask), V = 0; then M |= mask (atomic).
        const ea = op === 0x35 ? this.eaDir() : op === 0x36 ? this.fetch16() : this.eaIdx(1, 1);
        const m = this.fetch8();
        const v = this.rd8(ea);
        this.nzv8(v & m);
        this.wr8(ea, v | m);
        return op === 0x37 ? T.CYCI[key * 5 + this.cls] : T.CYC[key];
      }
      case 0x38:
        this.setCcrw(this.pull16());
        return T.CYC[key];
      case 0x39:
        this.push16((this.ipl << 8) | this.ccr);
        return T.CYC[key];
      case 0x3a:
        return this.rev();
      case 0x3b:
        return this.revw();
      case 0x3c:
        return this.wav();
      case 0x3d:
      case 0x3f:
        return this.tbl(op === 0x3f);
      case 0x3e: // STOP
        if (this.ccr & S) return T.CYC_STOP_DISABLED;
        this.pushFrame(this.pc);
        this.state = CPU_STOP;
        this.attn = true;
        return T.CYC[key];
      case 0x40:
      case 0x41:
      case 0x42:
      case 0x43:
      case 0x44:
      case 0x45:
      case 0x46:
      case 0x47:
      case 0x48:
        this.x = this.rmw16(op - 0x40, this.x);
        return 2;
      case 0x50:
      case 0x51:
      case 0x52:
      case 0x53:
      case 0x54:
      case 0x55:
      case 0x56:
      case 0x57:
      case 0x58:
        this.y = this.rmw16(op - 0x50, this.y);
        return 2;
      case 0x60:
      case 0x61:
      case 0x62:
      case 0x63:
      case 0x64:
      case 0x65:
      case 0x66:
      case 0x67:
      case 0x68: {
        const ea = this.eaIdx(0, 0);
        this.wr16(ea, this.rmw16(op - 0x60, this.rd16(ea)));
        return T.CYCI[key * 5 + this.cls];
      }
      case 0x70:
      case 0x71:
      case 0x72:
      case 0x73:
      case 0x74:
      case 0x75:
      case 0x76:
      case 0x77:
      case 0x78: {
        const ea = this.fetch16();
        this.wr16(ea, this.rmw16(op - 0x70, this.rd16(ea)));
        return T.CYC[key];
      }
      case 0x69:
      case 0x79: {
        const ea = op === 0x69 ? this.eaIdx(0, 0) : this.fetch16();
        this.wr16(ea, 0);
        this.ccr = (this.ccr & 0xf0) | Z;
        return op === 0x69 ? T.CYCI[key * 5 + this.cls] : T.CYC[key];
      }
      case 0x5a:
      case 0x5b:
      case 0x5c:
      case 0x5d:
      case 0x5e:
      case 0x5f:
      case 0x6a:
      case 0x6b:
      case 0x6c:
      case 0x6d:
      case 0x6e:
      case 0x6f:
      case 0x7a:
      case 0x7b:
      case 0x7c:
      case 0x7d:
      case 0x7e:
      case 0x7f: {
        const mode = op >> 4;
        const ea = mode === 5 ? this.eaDir() : mode === 6 ? this.eaIdx(0, 0) : this.fetch16();
        switch (op & 15) {
          case 0xa:
            this.gwr8(ea, this.a);
            this.nzv8(this.a);
            break;
          case 0xb:
            this.gwr8(ea, this.b);
            this.nzv8(this.b);
            break;
          case 0xc: {
            const d = (this.a << 8) | this.b;
            this.gwr16(ea, d);
            this.nzv16(d);
            break;
          }
          case 0xd:
            this.gwr16(ea, this.y);
            this.nzv16(this.y);
            break;
          case 0xe:
            this.gwr16(ea, this.x);
            this.nzv16(this.x);
            break;
          default:
            this.gwr16(ea, this.sp);
            this.nzv16(this.sp);
        }
        return mode === 6 ? T.CYCI[key * 5 + this.cls] : T.CYC[key];
      }
      default:
        if (op >= 0x80) return this.alu2(op);
        throw new Error(`sim: page-2 opcode $${hex(op, 2)} not implemented`);
    }
  }

  /** Page 2 $80-$FF: CPU12X X/Y/D arithmetic, G-loads, CLRX/TSTX/SYS... */
  private alu2(op: number): number {
    const key = 0x100 | op;
    const lo = op & 15;
    const mode = (op >> 4) & 3;
    const ySide = op >= 0xc0;
    if (lo === 7) {
      switch (op) {
        case 0x87:
          this.x = 0;
          this.ccr = (this.ccr & 0xf0) | Z;
          return 2;
        case 0x97:
          this.tst16(this.x);
          return 2;
        case 0xa7:
          return this.swi(VEC_SYS, T.CYC[key]);
        case 0xc7:
          this.y = 0;
          this.ccr = (this.ccr & 0xf0) | Z;
          return 2;
        case 0xd7:
          this.tst16(this.y);
          return 2;
        case 0xe7:
          this.tst16(this.rd16(this.eaIdx(0, 0)));
          return T.CYCI[key * 5 + this.cls];
        default:
          this.tst16(this.rd16(this.fetch16()));
          return T.CYC[key];
      }
    }
    const ea = mode === 0 ? -1 : mode === 1 ? this.eaDir() : mode === 2 ? this.eaIdx(0, 0) : this.fetch16();
    const cyc = mode === 2 ? T.CYCI[key * 5 + this.cls] : T.CYC[key];
    if (lo === 6 || (ySide && lo >= 0xc)) {
      // Global loads: GLDAA/GLDAB (8-bit), GLDD/GLDY/GLDX/GLDS (16-bit).
      if (lo === 6) {
        const v = this.grd8(ea);
        if (ySide) this.b = v;
        else this.a = v;
        this.nzv8(v);
      } else {
        const v = this.grd16(ea);
        if (lo === 0xc) {
          this.a = v >> 8;
          this.b = v & 0xff;
        } else if (lo === 0xd) this.y = v;
        else if (lo === 0xe) this.x = v;
        else this.sp = v;
        this.nzv16(v);
      }
      return cyc;
    }
    const v = mode === 0 ? this.fetch16() : this.rd16(ea);
    const c = this.ccr & C;
    if (!ySide) {
      switch (lo) {
        case 0:
          this.x = this.sub16(this.x, v, 0);
          break;
        case 2:
          this.x = this.sub16(this.x, v, c, SBE_CHAINS_Z);
          break;
        case 3: {
          const r = this.sub16((this.a << 8) | this.b, v, c, SBE_CHAINS_Z);
          this.a = r >> 8;
          this.b = r & 0xff;
          break;
        }
        case 4:
          this.x &= v;
          this.nzv16(this.x);
          break;
        case 5:
          this.nzv16(this.x & v);
          break;
        case 8:
          this.x ^= v;
          this.nzv16(this.x);
          break;
        case 9:
          this.x = this.add16(this.x, v, c, ADE_CHAINS_Z);
          break;
        case 0xa:
          this.x |= v;
          this.nzv16(this.x);
          break;
        case 0xb:
          this.x = this.add16(this.x, v, 0);
          break;
        case 0xc:
          this.sub16((this.a << 8) | this.b, v, c, SBE_CHAINS_Z);
          break;
        case 0xd:
          this.sub16(this.y, v, c, SBE_CHAINS_Z);
          break;
        case 0xe:
          this.sub16(this.x, v, c, SBE_CHAINS_Z);
          break;
        default:
          this.sub16(this.sp, v, c, SBE_CHAINS_Z);
      }
    } else {
      switch (lo) {
        case 0:
          this.y = this.sub16(this.y, v, 0);
          break;
        case 2:
          this.y = this.sub16(this.y, v, c, SBE_CHAINS_Z);
          break;
        case 3: {
          const r = this.add16((this.a << 8) | this.b, v, c, ADE_CHAINS_Z);
          this.a = r >> 8;
          this.b = r & 0xff;
          break;
        }
        case 4:
          this.y &= v;
          this.nzv16(this.y);
          break;
        case 5:
          this.nzv16(this.y & v);
          break;
        case 8:
          this.y ^= v;
          this.nzv16(this.y);
          break;
        case 9:
          this.y = this.add16(this.y, v, c, ADE_CHAINS_Z);
          break;
        case 0xa:
          this.y |= v;
          this.nzv16(this.y);
          break;
        default:
          this.y = this.add16(this.y, v, 0);
      }
    }
    return cyc;
  }

  /** MOVB/MOVW, all CPU12 + CPU12X forms. */
  private move(op: number): number {
    const word = op < 8;
    const f = op & 7;
    let src: number;
    let dst: number;
    let sc = 0;
    let dc = 0;
    let v = 0;
    switch (f) {
      case 0: // #imm -> idx: xb [ext] imm
        dst = this.eaIdx(word ? 2 : 1, word ? 2 : 1);
        sc = this.cls;
        v = word ? this.fetch16() : this.fetch8();
        break;
      case 1: // ext -> idx: xb [ext] hh ll
        dst = this.eaIdx(2, 2);
        sc = this.cls;
        src = this.fetch16();
        v = word ? this.rd16(src) : this.rd8(src);
        break;
      case 2: // idx -> idx: xb_src [ext] xb_dst [ext]
        src = this.eaIdx(1, 1);
        sc = this.cls;
        dst = this.eaIdx(0, 0);
        dc = this.cls;
        v = word ? this.rd16(src) : this.rd8(src);
        break;
      case 3: // #imm -> ext
        v = word ? this.fetch16() : this.fetch8();
        dst = this.fetch16();
        break;
      case 4: // ext -> ext
        src = this.fetch16();
        dst = this.fetch16();
        v = word ? this.rd16(src) : this.rd8(src);
        break;
      default: // idx -> ext: xb [ext] hh ll
        src = this.eaIdx(2, 2);
        sc = this.cls;
        dst = this.fetch16();
        v = word ? this.rd16(src) : this.rd8(src);
    }
    if (word) this.wr16(dst, v);
    else this.wr8(dst, v);
    return T.CYCM[op * 25 + sc * 5 + dc];
  }

  // ================================================================= complex instructions

  private rti(): number {
    const w = this.pull16();
    // CCRW is restored, except that X can never go 0 -> 1 (CPU12RM RTI); no CLI-style delay.
    this.ipl = (w >> 8) & 7;
    this.ccr = w & 0xff & (this.ccr | ~XB);
    this.iClr = false;
    this.b = this.pull8();
    this.a = this.pull8();
    this.x = this.pull16();
    this.y = this.pull16();
    this.pc = this.pull16();
    if (this.xint.pending.length !== 0) {
      const off = this.xint.select(this.ccr, this.ipl);
      if (off >= 0) {
        // Another interrupt pending: re-vector without unstacking/re-stacking (frame contents identical).
        this.sp = (this.sp - 10) & 0xffff;
        this.vectorTo(off, off === VEC_XIRQ ? 0 : this.xint.selectedLevel);
        return T.CYC_RTI_PENDING;
      }
    }
    return T.CYC[0x0b];
  }

  private daa(): number {
    const a = this.a;
    const c = this.ccr & C;
    const h = this.ccr & H;
    const lo = a & 0x0f;
    const hi = a >> 4;
    let corr = 0;
    let carry = c;
    if (h || lo > 9) corr |= 0x06;
    if (c || hi > 9 || (hi >= 9 && lo > 9)) {
      corr |= 0x60;
      carry = 1;
    }
    const r = (a + corr) & 0xff;
    this.a = r;
    // V is undefined after DAA (left unchanged here). UNCERTAIN.
    this.ccr = (this.ccr & 0xf2) | (r & 0x80 ? N : 0) | (r === 0 ? Z : 0) | carry;
    return T.CYC[0x107];
  }

  private ediv(): number {
    const x = this.x;
    if (x === 0) {
      // Divide by zero: Y, D unchanged; C = 1; N, Z, V undefined (unchanged). UNCERTAIN.
      this.ccr |= C;
      return T.CYC[0x11];
    }
    const dividend = this.y * 65536 + ((this.a << 8) | this.b);
    const q = Math.floor(dividend / x);
    const r = dividend - q * x;
    if (q > 0xffff) {
      // Overflow: V = 1, registers unchanged (UNCERTAIN), N/Z undefined.
      this.ccr = (this.ccr & 0xfc) | V;
      return T.CYC[0x11];
    }
    this.y = q;
    this.a = r >> 8;
    this.b = r & 0xff;
    this.ccr = (this.ccr & 0xf0) | (q & 0x8000 ? N : 0) | (q === 0 ? Z : 0);
    return T.CYC[0x11];
  }

  private edivs(): number {
    const x = s16(this.x);
    if (x === 0) {
      this.ccr |= C;
      return T.CYC[0x114];
    }
    const dividend = ((this.y << 16) | (this.a << 8) | this.b) | 0;
    const q = Math.trunc(dividend / x);
    const r = dividend - q * x;
    if (q > 0x7fff || q < -0x8000) {
      this.ccr = (this.ccr & 0xfc) | V;
      return T.CYC[0x114];
    }
    this.y = q & 0xffff;
    this.a = (r >> 8) & 0xff;
    this.b = r & 0xff;
    this.ccr = (this.ccr & 0xf0) | (q < 0 ? N : 0) | (q === 0 ? Z : 0);
    return T.CYC[0x114];
  }

  private idiv(): number {
    const x = this.x;
    const d = (this.a << 8) | this.b;
    if (x === 0) {
      // X = $FFFF, D indeterminate (unchanged), C = 1, V = 0, Z from quotient ($FFFF -> 0).
      this.x = 0xffff;
      this.ccr = (this.ccr & 0xf8) | C;
      return T.CYC[0x110];
    }
    const q = Math.floor(d / x);
    const r = d - q * x;
    this.x = q;
    this.a = r >> 8;
    this.b = r & 0xff;
    this.ccr = (this.ccr & 0xf8) | (q === 0 ? Z : 0);
    return T.CYC[0x110];
  }

  private idivs(): number {
    const x = s16(this.x);
    const d = s16((this.a << 8) | this.b);
    if (x === 0) {
      this.ccr |= C;
      return T.CYC[0x115];
    }
    const q = Math.trunc(d / x);
    if (q > 0x7fff) {
      // Only $8000 / $FFFF overflows. UNCERTAIN: registers left unchanged.
      this.ccr = (this.ccr & 0xfc) | V;
      return T.CYC[0x115];
    }
    const r = d - q * x;
    this.x = q & 0xffff;
    this.a = (r >> 8) & 0xff;
    this.b = r & 0xff;
    this.ccr = (this.ccr & 0xf0) | (q < 0 ? N : 0) | (q === 0 ? Z : 0);
    return T.CYC[0x115];
  }

  private fdiv(): number {
    const x = this.x;
    const d = (this.a << 8) | this.b;
    if (x === 0 || x <= d) {
      // Divide by zero or overflow: X = $FFFF, D indeterminate (unchanged). V = (X <= D), C = (X == 0).
      this.x = 0xffff;
      this.ccr = (this.ccr & 0xf8) | V | (x === 0 ? C : 0);
      return T.CYC[0x111];
    }
    const n = d * 65536;
    const q = Math.floor(n / x);
    const r = n - q * x;
    this.x = q;
    this.a = r >> 8;
    this.b = r & 0xff;
    this.ccr = (this.ccr & 0xf8) | (q === 0 ? Z : 0);
    return T.CYC[0x111];
  }

  private emacs(): number {
    const ea = this.fetch16();
    const m1 = s16(this.rd16(this.x));
    const m2 = s16(this.rd16(this.y));
    const acc = ((this.rd16(ea) << 16) | this.rd16((ea + 2) & 0xffff)) | 0;
    const p = m1 * m2; // |p| <= 2^30
    const r = (acc + p) | 0;
    const v = ((acc ^ r) & (p ^ r)) < 0;
    const c = (acc & 0xffff) + (p & 0xffff) > 0xffff;
    this.wr16(ea, (r >>> 16) & 0xffff);
    this.wr16((ea + 2) & 0xffff, r & 0xffff);
    this.ccr = (this.ccr & 0xf0) | (r < 0 ? N : 0) | (r === 0 ? Z : 0) | (v ? V : 0) | (c ? C : 0);
    return T.CYC[0x112];
  }

  private minmax(op: number): number {
    const key = 0x100 | op;
    const ea = this.eaIdx(0, 0);
    const cyc = T.CYCI[key * 5 + this.cls];
    if (op === 0x18 || op === 0x19 || op === 0x1c || op === 0x1d) {
      const m = this.rd8(ea);
      const a = this.a;
      this.sub8(a, m, 0);
      const borrow = (this.ccr & C) !== 0; // M > A
      switch (op) {
        case 0x18: // MAXA
          if (borrow) this.a = m;
          break;
        case 0x19: // MINA
          if (!borrow) this.a = m;
          break;
        case 0x1c: // MAXM
          this.wr8(ea, borrow ? m : a);
          break;
        default: // MINM
          this.wr8(ea, borrow ? a : m);
      }
    } else {
      const m = this.rd16(ea);
      const d = (this.a << 8) | this.b;
      this.sub16(d, m, 0);
      const borrow = (this.ccr & C) !== 0;
      switch (op) {
        case 0x1a: // EMAXD
          if (borrow) {
            this.a = m >> 8;
            this.b = m & 0xff;
          }
          break;
        case 0x1b: // EMIND
          if (!borrow) {
            this.a = m >> 8;
            this.b = m & 0xff;
          }
          break;
        case 0x1e: // EMAXM
          this.wr16(ea, borrow ? m : d);
          break;
        default: // EMINM
          this.wr16(ea, borrow ? d : m);
      }
    }
    return cyc;
  }

  /** TBL / ETBL: linear interpolation, B = fraction (0.B); C = MSB of the discarded fraction. */
  private tbl(wide: boolean): number {
    const key = wide ? 0x13f : 0x13d;
    const ea = this.eaIdx(0, 0);
    if (!wide) {
      const y1 = this.rd8(ea);
      const y2 = this.rd8((ea + 1) & 0xffff);
      const t = y1 * 256 + (y2 - y1) * this.b; // >= 0
      const r = (t >> 8) & 0xff;
      this.a = r;
      this.ccr = (this.ccr & 0xf2) | (r & 0x80 ? N : 0) | (r === 0 ? Z : 0) | (t & 0x80 ? C : 0);
    } else {
      const y1 = this.rd16(ea);
      const y2 = this.rd16((ea + 2) & 0xffff);
      const t = y1 * 256 + (y2 - y1) * this.b;
      const r = Math.floor(t / 256) & 0xffff;
      this.a = r >> 8;
      this.b = r & 0xff;
      this.ccr = (this.ccr & 0xf2) | (r & 0x8000 ? N : 0) | (r === 0 ? Z : 0) | (t & 0x80 ? C : 0);
    }
    return T.CYCI[key * 5 + this.cls];
  }

  /** MEM: fuzzy membership grade of A for the trapezoid at X (P1 P2 S1 S2) -> (Y); X += 4, Y += 1. */
  private mem_(): number {
    const x = this.x;
    const p1 = this.rd8(x);
    const p2 = this.rd8((x + 1) & 0xffff);
    const s1 = this.rd8((x + 2) & 0xffff);
    const s2 = this.rd8((x + 3) & 0xffff);
    const a = this.a;
    // CPU12RM Fig 9-5, literally (this also gives the documented results for abnormal functions §9.4.2).
    const d12n = a < p1 || a > p2; // step 2c: Delta_1 or Delta_2 negative
    const g1 = d12n ? 0 : (a - p1) * s1; // 3a
    const g2 = d12n ? 0 : (p2 - a) * s2; // 3b
    let g = (s2 === 0 || g2 > 0xff) && !d12n ? 0xff : g2; // 4a
    if (!((s1 === 0 || g1 > 0xff) && !d12n)) g = g1; // 4b
    this.wr8(this.y, g);
    this.y = (this.y + 1) & 0xffff;
    this.x = (x + 4) & 0xffff;
    return T.CYC[0x01];
  }

  /**
   * REV: unweighted MIN-MAX rule evaluation. X -> rule list of 8-bit offsets from Y ($FE separator,
   * $FF end), A = $FF / V = 0 on entry. UNCERTAIN: executed atomically (the hardware can be interrupted
   * between elements); H/N/Z/C are left unchanged. Cycles (Fig 9-9): 'Orf' + 'O' plus the 3-cycle loop
   * once per rule-list byte, including the $FE separators and the $FF end marker.
   */
  private rev(): number {
    let x = this.x;
    let a = this.a;
    let v = (this.ccr & V) !== 0;
    const y = this.y;
    let n = 0;
    for (let guard = 0; guard < 0x10000; guard++) {
      const e = this.rd8(x);
      x = (x + 1) & 0xffff;
      n++;
      if (e === 0xff) break;
      if (e === 0xfe) {
        if (v) a = 0xff;
        v = !v;
      } else {
        const p = (y + e) & 0xffff;
        const m = this.rd8(p);
        if (!v) {
          if (m < a) a = m;
        } else if (m < a) this.wr8(p, a);
      }
    }
    this.x = x;
    this.a = a;
    this.ccr = (this.ccr & ~V) | (v ? V : 0);
    return T.CYC_REV_FIXED + T.CYC_REV_PER * n;
  }

  /**
   * REVW: 16-bit pointers ($FFFE separator, $FFFF end); C = 1 enables weights at Y. UNCERTAIN: atomic.
   * Cycles (Fig 9-10 / §9.5.2.3): 'ORf' + 'O' plus 3 per rule-list word including $FFFF; the pass for an
   * antecedent->consequent $FFFE (V was 0) takes 5 instead when weighting is enabled (C = 1).
   */
  private revw(): number {
    let x = this.x;
    let y = this.y;
    let a = this.a;
    let v = (this.ccr & V) !== 0;
    const weighted = (this.ccr & C) !== 0;
    let n = 0;
    let seps = 0;
    for (let guard = 0; guard < 0x8000; guard++) {
      const p = this.rd16(x);
      x = (x + 2) & 0xffff;
      n++;
      if (p === 0xffff) break;
      if (p === 0xfffe) {
        if (!v) {
          if (weighted) seps++;
          if (weighted) {
            const w = this.rd8(y);
            y = (y + 1) & 0xffff;
            a = (a * (w + 1)) >> 8;
          }
          v = true;
        } else {
          a = 0xff;
          v = false;
        }
      } else {
        const m = this.rd8(p);
        if (!v) {
          if (m < a) a = m;
        } else if (m < a) this.wr8(p, a);
      }
    }
    this.x = x;
    this.y = y;
    this.a = a;
    this.ccr = (this.ccr & ~V) | (v ? V : 0);
    return T.CYC_REVW_FIXED + T.CYC_REVW_PER * n + (T.CYC_REVW_PER_WEIGHTED - T.CYC_REVW_PER) * seps;
  }

  /**
   * WAV main loop (Fig 9-11 cycles 3.0-9.0) shared with WAVR: B is decremented at the top of the loop and
   * tested for zero at the bottom, so B = 0 runs 256 iterations. With `resume` (WAVR) the interrupted
   * iteration is completed first: its operands are re-read at X-1 / Y-1 and the flow rejoins at cycle 6.0
   * before the bottom-of-loop test. Returns the number of full loop iterations executed.
   */
  private wavLoop(sop: number, sow: number, resume: boolean): number {
    let x = this.x;
    let y = this.y;
    let b = this.b;
    let n = 0;
    if (resume) {
      const fi = this.rd8((y - 1) & 0xffff);
      sop += this.rd8((x - 1) & 0xffff) * fi;
      sow += fi;
    }
    if (!resume || b !== 0) {
      do {
        b = (b - 1) & 0xff;
        const si = this.rd8(x);
        const fi = this.rd8(y);
        sop += si * fi;
        sow += fi;
        x = (x + 1) & 0xffff;
        y = (y + 1) & 0xffff;
        n++;
      } while (b !== 0);
    }
    sop &= 0xffffff;
    this.y = sop >>> 16; // Y:D = SOP (24-bit)
    this.a = (sop >> 8) & 0xff;
    this.b = sop & 0xff;
    this.x = sow & 0xffff;
    this.ccr |= Z; // Z = 1; H, N, V, C undefined (unchanged)
    return n;
  }

  /** WAV: weighted average sums over B elements (X -> Si, Y -> Fi; B = 0 -> 256). UNCERTAIN: atomic. */
  private wav(): number {
    const n = this.wavLoop(0, 0, false);
    return T.CYC_WAV_FIXED + T.CYC_WAV_PER * n;
  }

  /**
   * WAVR ($3C): resume an interrupted WAV, pulling SOP[23:16], SOP[15:0], SOW from the stack, finishing the
   * interrupted iteration (operands at X-1/Y-1) and then the remaining B iterations. Only reachable from a
   * hand-built frame while WAV itself is atomic. UNCERTAIN: cycle cost (see tables.CYC_WAVR_FIXED).
   */
  private wavr(): number {
    const soph = this.pull16() & 0xff;
    const sopl = this.pull16();
    const sow = this.pull16();
    const n = this.wavLoop(soph * 65536 + sopl, sow, true);
    return T.CYC_WAVR_FIXED + T.CYC_WAVR_PER * n;
  }
}

const REASONS: HaltReason[] = ['step', 'step', 'step', 'step', 'step', 'step', 'stop', 'wait-idle'];
