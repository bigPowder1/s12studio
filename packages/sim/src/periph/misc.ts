/**
 * Small MC9S12XDP512 modules:
 * - `VregModule` (VREG_3V3, $02F0-$02F7): low-voltage interrupt (LVDS/LVIE/LVIF, driven from outside with
 *   `setLowVoltage`) and the Autonomous Periodic Interrupt (API: APICLK/APIFE/APIE/APIF, APITR, APIR) with Vapi.
 * - `DbgModule` (S12XDBG, $0020-$002F): the register file (DBGC1/SR/TCR/C2/TB/CNT/SCRX|MFR and the comparator
 *   window selected by DBGC1.COMRV), exposing the comparator settings for a later mapping onto simulator
 *   breakpoints. Arming does nothing yet (warns once).
 * - `XgateStub` ($0380-$03BF) and `CanStub` (MSCAN0-4, 64 bytes each): register files with device reset values,
 *   write-1-to-clear and masked-write semantics, that warn once that the module is not simulated.
 */
import { addr as regAddr, registerByAddress, vectorByName, w1cMaskOf, type RegisterDef } from '@s12/devices';
import type { Peripheral, PeripheralContext, RegisterRange, ResetCause } from '../types.js';

// ==================================================================== VREG

export const VREG_BASE = regAddr('VREGHTCL');
export const VREG_RANGE: RegisterRange = [VREG_BASE, VREG_BASE + 7];
/** Vlvi $80, Vapi $7E. */
export const VREG_VECTORS = { lvi: vectorByName('Vlvi')!.offset, api: vectorByName('Vapi')!.offset } as const;

export interface VregOptions {
  /**
   * Autonomous clock ACLK (Hz) used by the API when APICLK=0. UNCERTAIN: nominal ~10 kHz (untrimmed RC oscillator,
   * APITR trimming is stored but not modelled).
   */
  aclkHz?: number;
}

export interface VregSnapshot {
  ctrl: number;
  apicl: number;
  apitr: number;
  apir: number;
  lowVoltage: boolean;
  /** Bus cycle of the next API period end (when running). */
  apiNext: number;
  t: number;
}

export class VregModule implements Peripheral {
  readonly name = 'VREG';
  readonly base = VREG_BASE;
  readonly aclkHz: number;
  private ctx: PeripheralContext | null = null;
  private s: VregSnapshot = VregModule.initial(0);

  constructor(opts: VregOptions = {}) {
    this.aclkHz = opts.aclkHz ?? 10_000;
  }

  private static initial(t: number): VregSnapshot {
    return { ctrl: 0, apicl: 0, apitr: 0, apir: 0, lowVoltage: false, apiNext: Infinity, t };
  }

  attach(ctx: PeripheralContext): void {
    this.ctx = ctx;
  }

  private get now(): number {
    const n = this.ctx ? this.ctx.now : 0;
    return n > this.s.t ? n : this.s.t;
  }

  reset(_cause?: ResetCause): void {
    const low = this.s.lowVoltage;
    this.s = VregModule.initial(this.ctx ? this.ctx.now : 0);
    this.s.lowVoltage = low;
    this.updateIrq();
  }

  /** API period in bus cycles: 2 * (APIR + 1) periods of the selected clock (bus when APICLK=1, else ACLK). */
  get apiPeriodCycles(): number {
    const n = 2 * ((this.s.apir & 0x0fff) + 1);
    if (this.s.apicl & 0x80) return n;
    const bus = this.ctx ? this.ctx.busHz : 8e6;
    return Math.max(1, Math.round((n * bus) / this.aclkHz));
  }

  private advance(t: number): void {
    const s = this.s;
    if (s.apicl & 0x04 && s.apiNext <= t) {
      const p = this.apiPeriodCycles;
      const k = Math.floor((t - s.apiNext) / p) + 1;
      s.apiNext += k * p;
      s.apicl |= 0x01; // APIF
    }
    if (t > s.t) s.t = t;
    this.updateIrq();
  }

  tick(_n: number): void {
    this.advance(this.ctx ? this.ctx.now : this.s.t);
  }

  nextEventCycles(): number {
    const s = this.s;
    if (!(s.apicl & 0x04) || s.apicl & 0x01) return Infinity; // nothing observable until APIF is cleared
    return Math.max(0, s.apiNext - s.t);
  }

  private updateIrq(): void {
    if (!this.ctx) return;
    const s = this.s;
    this.ctx.setInterrupt(VREG_VECTORS.api, (s.apicl & 0x03) === 0x03);
    this.ctx.setInterrupt(VREG_VECTORS.lvi, (s.ctrl & 0x03) === 0x03);
  }

  private regValue(off: number): number {
    const s = this.s;
    switch (off) {
      case 1:
        return (s.lowVoltage ? 0x04 : 0) | (s.ctrl & 0x03);
      case 2:
        return s.apicl & 0x87;
      case 3:
        return s.apitr & 0xfc;
      case 4:
        return (s.apir >> 8) & 0x0f;
      case 5:
        return s.apir & 0xff;
      default:
        return 0; // VREGHTCL (test), reserved
    }
  }

  read(a: number): number {
    this.advance(this.now);
    return this.regValue(a - this.base);
  }

  peek(a: number): number {
    return this.regValue(a - this.base);
  }

  write(a: number, v: number): void {
    const t = this.now;
    this.advance(t);
    const s = this.s;
    v &= 0xff;
    switch (a - this.base) {
      case 1:
        s.ctrl = (s.ctrl & 0x01 & ~v) | (v & 0x02);
        break;
      case 2: {
        const wasOn = (s.apicl & 0x04) !== 0;
        // APICLK can only be changed while the API is disabled.
        const clk = wasOn ? s.apicl & 0x80 : v & 0x80;
        s.apicl = clk | (v & 0x06) | (s.apicl & 0x01 & ~v);
        const on = (v & 0x04) !== 0;
        if (on && !wasOn) s.apiNext = t + this.apiPeriodCycles;
        if (!on) s.apiNext = Infinity;
        break;
      }
      case 3:
        s.apitr = v & 0xfc;
        break;
      case 4:
        s.apir = (s.apir & 0x00ff) | ((v & 0x0f) << 8);
        break;
      case 5:
        s.apir = (s.apir & 0x0f00) | v;
        break;
      default:
        return;
    }
    this.updateIrq();
  }

  /** Supply below/above the low-voltage threshold (board/UI stimulus): LVDS follows, LVIF flags every change. */
  setLowVoltage(low: boolean): void {
    this.ctx?.sync();
    if (low !== this.s.lowVoltage) {
      this.s.lowVoltage = low;
      this.s.ctrl |= 0x01;
    }
    this.updateIrq();
    this.ctx?.reschedule();
  }

  snapshot(): VregSnapshot {
    return { ...this.s };
  }

  restore(state: unknown): void {
    this.s = { ...(state as VregSnapshot) };
    this.updateIrq();
  }
}

// ==================================================================== DBG

export const DBG_BASE = regAddr('DBGC1');
export const DBG_RANGE: RegisterRange = [DBG_BASE, DBG_BASE + 0x0f];

/** One S12XDBG comparator as programmed (COMRV window). */
export interface DbgComparator {
  index: number;
  name: 'A' | 'B' | 'C' | 'D';
  /** DBGXCTL. */
  ctl: number;
  /** COMPE: comparator enabled. */
  enabled: boolean;
  /** BRK: immediate break on match. */
  brk: boolean;
  /** RWE/RW: 'any' | 'read' | 'write'. */
  access: 'any' | 'read' | 'write';
  /** SRC: 0 = CPU12X bus, 1 = XGATE bus. */
  source: 'cpu' | 'xgate';
  /** 23-bit global address. */
  address: number;
  /** Data and data mask (comparators A and C only; 0 for B/D). */
  data: number;
  dataMask: number;
}

export interface DbgOptions {
  /** Called whenever DBG registers change (for mapping comparators onto simulator breakpoints later). */
  onChange?: (dbg: DbgModule) => void;
}

export interface DbgSnapshot {
  c1: number;
  tcr: number;
  c2: number;
  scrx: number;
  cmp: Array<{ ctl: number; ah: number; am: number; al: number; dh: number; dl: number; dhm: number; dlm: number }>;
}

/**
 * S12XDBG register file. UNCERTAIN: comparators B and D have no data/mask registers (read 0); while armed only
 * DBGC1 is writable; $0027 reads DBGMFR (no matches: 0) while armed.
 */
export class DbgModule implements Peripheral {
  readonly name = 'DBG';
  readonly base = DBG_BASE;
  private ctx: PeripheralContext | null = null;
  private readonly onChange?: (dbg: DbgModule) => void;
  private s: DbgSnapshot = DbgModule.initial();
  private warned = false;

  constructor(opts: DbgOptions = {}) {
    this.onChange = opts.onChange;
  }

  private static initial(): DbgSnapshot {
    return {
      c1: 0,
      tcr: 0,
      c2: 0,
      scrx: 0,
      cmp: Array.from({ length: 4 }, () => ({ ctl: 0, ah: 0, am: 0, al: 0, dh: 0, dl: 0, dhm: 0, dlm: 0 })),
    };
  }

  attach(ctx: PeripheralContext): void {
    this.ctx = ctx;
  }

  reset(_cause?: ResetCause): void {
    this.s = DbgModule.initial();
  }

  get armed(): boolean {
    return (this.s.c1 & 0x80) !== 0;
  }

  /** DBGC1.COMRV: comparator visible in the $0028-$002F window. */
  get comrv(): number {
    return this.s.c1 & 0x03;
  }

  comparators(): DbgComparator[] {
    return this.s.cmp.map((c, i) => ({
      index: i,
      name: (['A', 'B', 'C', 'D'] as const)[i],
      ctl: c.ctl,
      enabled: (c.ctl & 0x01) !== 0,
      brk: (c.ctl & 0x10) !== 0,
      access: c.ctl & 0x04 ? (c.ctl & 0x08 ? 'read' : 'write') : 'any',
      source: c.ctl & 0x02 ? 'xgate' : 'cpu',
      address: ((c.ah & 0x7f) << 16) | (c.am << 8) | c.al,
      data: (c.dh << 8) | c.dl,
      dataMask: (c.dhm << 8) | c.dlm,
    }));
  }

  private hasData(i: number): boolean {
    return i === 0 || i === 2;
  }

  private regValue(off: number): number {
    const s = this.s;
    const c = s.cmp[this.comrv];
    switch (off) {
      case 0:
        return s.c1 & 0xbf; // TRIG reads 0
      case 1:
        return this.armed ? 0x01 : 0; // SSF: state 1 while armed; trace buffer empty
      case 2:
        return s.tcr;
      case 3:
        return s.c2 & 0x0f;
      case 4:
      case 5:
      case 6:
        return 0; // DBGTB, DBGCNT: no trace
      case 7:
        return this.armed ? 0 : s.scrx & 0x0f; // DBGMFR while armed
      case 8:
        return c.ctl;
      case 9:
        return c.ah & 0x7f;
      case 0x0a:
        return c.am;
      case 0x0b:
        return c.al;
      default: {
        if (!this.hasData(this.comrv)) return 0;
        return [c.dh, c.dl, c.dhm, c.dlm][off - 0x0c];
      }
    }
  }

  read(a: number): number {
    return this.regValue(a - this.base);
  }

  peek(a: number): number {
    return this.regValue(a - this.base);
  }

  write(a: number, v: number): void {
    const s = this.s;
    v &= 0xff;
    const off = a - this.base;
    if (off === 0) {
      const wasArmed = this.armed;
      s.c1 = v & 0xbf;
      if ((v & 0x80 && !wasArmed) || v & 0x40) {
        if (!this.warned) {
          this.warned = true;
          this.ctx?.warn('DBG: S12XDBG comparators/trace are not simulated; arming (ARM/TRIG) has no effect', { value: v });
        }
      }
    } else {
      if (this.armed) return; // UNCERTAIN: other DBG registers are locked while armed
      const c = s.cmp[this.comrv];
      switch (off) {
        case 2:
          s.tcr = v;
          break;
        case 3:
          s.c2 = v & 0x0f;
          break;
        case 7:
          s.scrx = v & 0x0f;
          break;
        case 8:
          c.ctl = v;
          break;
        case 9:
          c.ah = v & 0x7f;
          break;
        case 0x0a:
          c.am = v;
          break;
        case 0x0b:
          c.al = v;
          break;
        case 0x0c:
        case 0x0d:
        case 0x0e:
        case 0x0f:
          if (!this.hasData(this.comrv)) return;
          if (off === 0x0c) c.dh = v;
          else if (off === 0x0d) c.dl = v;
          else if (off === 0x0e) c.dhm = v;
          else c.dlm = v;
          break;
        default:
          return; // DBGSR, DBGTB, DBGCNT read-only
      }
    }
    this.onChange?.(this);
  }

  snapshot(): DbgSnapshot {
    return { ...this.s, cmp: this.s.cmp.map((c) => ({ ...c })) };
  }

  restore(state: unknown): void {
    const st = state as DbgSnapshot;
    this.s = { ...st, cmp: st.cmp.map((c) => ({ ...c })) };
  }
}

// ==================================================================== register-file stubs (XGATE, MSCAN)

export interface StubOptions {
  /** Addresses (register-block) whose high byte is a write-enable mask for the low byte (XGATE XGMCTL/XGSWT/XGSEM). */
  maskedWords?: readonly number[];
  /** Hook after every write (address, value). */
  afterWrite?: (stub: RegisterFileStub, addr: number, value: number) => void;
}

interface StubState {
  regs: number[];
  maskLatch: { addr: number; mask: number; at: number } | null;
}

/**
 * A memory-mapped module that is not simulated: registers keep their values (device reset values, read-only and
 * write-1-to-clear bits honoured) and the first write warns once.
 */
export class RegisterFileStub implements Peripheral {
  readonly start: number;
  readonly end: number;
  protected ctx: PeripheralContext | null = null;
  private readonly defs: Array<RegisterDef | undefined>;
  private readonly masked: Set<number>;
  private readonly afterWrite?: (stub: RegisterFileStub, addr: number, value: number) => void;
  protected s: StubState;
  private warned = false;

  constructor(
    readonly name: string,
    range: RegisterRange,
    opts: StubOptions = {},
  ) {
    [this.start, this.end] = range;
    this.defs = [];
    for (let a = this.start; a <= this.end; a++) this.defs.push(registerByAddress(a));
    this.masked = new Set(opts.maskedWords ?? []);
    this.afterWrite = opts.afterWrite;
    this.s = { regs: this.resetValues(), maskLatch: null };
  }

  get range(): RegisterRange {
    return [this.start, this.end];
  }

  private resetValues(): number[] {
    return this.defs.map((r, i) => {
      if (!r) return 0;
      const byte = this.start + i - r.address;
      return (r.reset >> (8 * (r.size - 1 - byte))) & 0xff;
    });
  }

  private byteInfo(a: number): { def: RegisterDef | undefined; w1c: number; readOnly: boolean } {
    const r = this.defs[a - this.start];
    if (!r) return { def: undefined, w1c: 0, readOnly: true };
    const byte = a - r.address;
    const w1c = (w1cMaskOf(r) >> (8 * (r.size - 1 - byte))) & 0xff;
    return { def: r, w1c, readOnly: r.access === 'r' };
  }

  attach(ctx: PeripheralContext): void {
    this.ctx = ctx;
  }

  reset(_cause?: ResetCause): void {
    this.s = { regs: this.resetValues(), maskLatch: null };
  }

  /** Raw register byte. */
  reg(a: number): number {
    return this.s.regs[a - this.start];
  }

  /** Set a register byte from the model side (no write semantics). */
  setReg(a: number, v: number): void {
    this.s.regs[a - this.start] = v & 0xff;
  }

  read(a: number): number {
    if (this.masked.has(a)) return 0; // mask bytes read 0
    return this.s.regs[a - this.start];
  }

  peek(a: number): number {
    return this.read(a);
  }

  write(a: number, v: number): void {
    v &= 0xff;
    if (!this.warned) {
      this.warned = true;
      this.ctx?.warn(`${this.name} is not simulated: register writes are stored but have no effect`, { address: a, value: v });
    }
    const now = this.ctx ? this.ctx.now : 0;
    if (this.masked.has(a)) {
      // High byte of a masked word: remember it for the low byte of the same (16-bit) access.
      this.s.maskLatch = { addr: a, mask: v, at: now };
      this.afterWrite?.(this, a, v);
      return;
    }
    const i = a - this.start;
    const ml = this.s.maskLatch;
    if (this.masked.has(a - 1)) {
      // Low byte of a masked word: bits change only where the mask (written in the same access) is 1.
      const m = ml && ml.addr === a - 1 && ml.at === now ? ml.mask : 0;
      this.s.maskLatch = null;
      this.s.regs[i] = (this.s.regs[i] & ~m) | (v & m);
      this.afterWrite?.(this, a, v);
      return;
    }
    const { def, w1c, readOnly } = this.byteInfo(a);
    if (!def || readOnly) return;
    // Plain bits take the written value; write-1-to-clear bits are cleared where a 1 is written.
    this.s.regs[i] = ((v & ~w1c) | (this.s.regs[i] & w1c & ~v)) & 0xff;
    this.afterWrite?.(this, a, v);
  }

  snapshot(): StubState {
    return { regs: [...this.s.regs], maskLatch: this.s.maskLatch && { ...this.s.maskLatch } };
  }

  restore(state: unknown): void {
    const st = state as StubState;
    this.s = { regs: [...st.regs], maskLatch: st.maskLatch && { ...st.maskLatch } };
  }
}

export const XGATE_BASE = regAddr('XGMCTL');
export const XGATE_RANGE: RegisterRange = [XGATE_BASE, XGATE_BASE + 0x3f];

/** XGATE register file ($0380-$03BF): XGMCTL/XGSWT/XGSEM masked writes, XGIF write-1-to-clear. No XGATE core. */
export class XgateStub extends RegisterFileStub {
  private xgeWarned = false;

  constructor() {
    super('XGATE', XGATE_RANGE, { maskedWords: [regAddr('XGMCTL'), regAddr('XGSWT'), regAddr('XGSEM')] });
  }

  /** XGMCTL.XGE (XGATE module enable). */
  get enabled(): boolean {
    return (this.reg(XGATE_BASE + 1) & 0x80) !== 0;
  }

  override write(a: number, v: number): void {
    super.write(a, v);
    if (this.enabled && !this.xgeWarned) {
      this.xgeWarned = true;
      this.ctx?.warn('XGATE enabled (XGMCTL.XGE=1) but the XGATE coprocessor is not simulated');
    }
  }
}

/** MSCAN module bases: CAN0 $0140, CAN1 $0180, CAN2 $01C0, CAN3 $0200, CAN4 $0280. */
export const CAN_BASES: readonly number[] = [0, 1, 2, 3, 4].map((n) => regAddr(`CAN${n}CTL0`));
export const CAN_RANGES: readonly RegisterRange[] = CAN_BASES.map((b) => [b, b + 0x3f] as const);

/**
 * MSCAN register file. INITAK/SLPAK (CTL1 bits 0/1) follow INITRQ/SLPRQ (CTL0 bits 0/1) at once, so the usual
 * "request init mode, wait for INITAK" loops terminate. No frames are sent or received.
 */
export class CanStub extends RegisterFileStub {
  constructor(readonly index: number) {
    super(`CAN${index}`, CAN_RANGES[index], {
      afterWrite: (stub, a) => {
        const base = CAN_BASES[index];
        if (a === base) stub.setReg(base + 1, (stub.reg(base + 1) & ~0x03) | (stub.reg(base) & 0x03));
      },
    });
  }
}
