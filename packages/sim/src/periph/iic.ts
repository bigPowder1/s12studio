/**
 * IIC0/IIC1 (S12IICV2) of the MC9S12XDP512: register file stub with IBSR basics.
 *
 * UNCERTAIN: there is no I2C bus model (the ME305 board uses no I2C device). A master byte transfer completes
 * after 9 SCL periods (SCL divider from IBFD) with TCF/IBIF set and RXAK=1 (nobody acknowledges); a master
 * receive returns $FF (bus pulled high). Arbitration, slave addressing (IAAS) and SRW are not modelled. The
 * first enable of the module logs a warning. SDA/SCL (IIC0: PJ7/PJ6) are not claimed on the PinNet when IBEN=1,
 * so the PIM keeps them as GPIO. Writes to RSTA (repeated START) are accepted but have no effect.
 *
 * Registers (offsets from base): 0 IBAD, 1 IBFD, 2 IBCR, 3 IBSR, 4 IBDR; 5..7 reserved (read 0).
 */
import { addr as regAddr, mask, vectorByName } from '@s12/devices';
import type { BoardNets } from '../pins.js';
import type { Peripheral, PeripheralContext, RegisterRange, ResetCause } from '../types.js';

export type IicIndex = 0 | 1;

/** Register-block base of IIC0/IIC1 (from @s12/devices: $00E0, $00B0). */
export const IIC_BASES: readonly [number, number] = [regAddr('IIC0_IBAD'), regAddr('IIC1_IBAD')];
export const IIC_RANGES: readonly [RegisterRange, RegisterRange] = [
  [IIC_BASES[0], IIC_BASES[0] + 7],
  [IIC_BASES[1], IIC_BASES[1] + 7],
];
/** IVBR-relative vector offsets (Viic0 $C0, Viic1 $82). */
export const IIC_VECTORS: readonly [number, number] = [vectorByName('Viic0')!.offset, vectorByName('Viic1')!.offset];

export const IIC_BITS = {
  IBEN: mask('IIC0_IBCR', 'IBEN'),
  IBIE: mask('IIC0_IBCR', 'IBIE'),
  MS_SL: mask('IIC0_IBCR', 'MS_SL'),
  TX_RX: mask('IIC0_IBCR', 'TX_RX'),
  TXAK: mask('IIC0_IBCR', 'TXAK'),
  RSTA: mask('IIC0_IBCR', 'RSTA'),
  IBSWAI: mask('IIC0_IBCR', 'IBSWAI'),
  TCF: mask('IIC0_IBSR', 'TCF'),
  IAAS: mask('IIC0_IBSR', 'IAAS'),
  IBB: mask('IIC0_IBSR', 'IBB'),
  IBAL: mask('IIC0_IBSR', 'IBAL'),
  SRW: mask('IIC0_IBSR', 'SRW'),
  IBIF: mask('IIC0_IBSR', 'IBIF'),
  RXAK: mask('IIC0_IBSR', 'RXAK'),
} as const;
const B = IIC_BITS;
const IBCR_RW = B.IBEN | B.IBIE | B.MS_SL | B.TX_RX | B.TXAK | B.IBSWAI; // RSTA is write-only (reads 0)
const IBSR_W1C = B.IBAL | B.IBIF;

/** SCL, tap and tap-to-tap tables of the IIC prescaler (S12IICV2 "IIC Divider and Hold Values"). */
const SCL_TAP = [5, 6, 7, 8, 9, 10, 12, 15];
const TAP2TAP = [1, 2, 4, 8, 16, 32, 64, 128];
const SCL2TAP = [4, 4, 6, 6, 14, 30, 62, 126];
const MUL = [1, 2, 4, 1];

/**
 * SCL divider (bus cycles per SCL period) for an IBFD value:
 * MUL * 2 * (scl2tap + (SCL_Tap - 1) * tap2tap + 2).
 * Tables checked against the S12IICV2 Block Guide V02.08 Table 3-2 (e.g. IBFD $18 -> 80, $1F -> 240, $3F -> 3840).
 * UNCERTAIN: IBC7:6=%11 is reserved (MUL=1 here).
 */
export function iicSclDivider(ibfd: number): number {
  const mul = MUL[(ibfd >> 6) & 3];
  const hi = (ibfd >> 3) & 7;
  const lo = ibfd & 7;
  return mul * 2 * (SCL2TAP[hi] + (SCL_TAP[lo] - 1) * TAP2TAP[hi] + 2);
}

export interface IicOptions {
  index?: IicIndex;
}

interface IicState {
  t: number;
  ibad: number;
  ibfd: number;
  ibcr: number;
  ibsr: number;
  ibdr: number;
  rxLatch: number;
  busyUntil: number;
  warned: boolean;
}

export class IicModule implements Peripheral {
  readonly name: string;
  readonly index: IicIndex;
  readonly base: number;
  readonly vector: number;
  private ctx: PeripheralContext | null = null;
  private s: IicState = IicModule.initial();

  constructor(_nets: BoardNets | null = null, opts: IicOptions = {}) {
    this.index = opts.index ?? 0;
    this.name = `IIC${this.index}`;
    this.base = IIC_BASES[this.index];
    this.vector = IIC_VECTORS[this.index];
  }

  private static initial(): IicState {
    return { t: 0, ibad: 0, ibfd: 0, ibcr: 0, ibsr: B.TCF, ibdr: 0, rxLatch: 0xff, busyUntil: Infinity, warned: false };
  }

  attach(ctx: PeripheralContext): void {
    this.ctx = ctx;
  }

  private get now(): number {
    const n = this.ctx ? this.ctx.now : 0;
    return n > this.s.t ? n : this.s.t;
  }

  reset(_cause?: ResetCause): void {
    const warned = this.s.warned;
    this.s = IicModule.initial();
    this.s.warned = warned;
    this.s.t = this.ctx ? this.ctx.now : 0;
    this.updateIrq();
  }

  /** Bus cycles of one byte (8 data bits + acknowledge). */
  get byteCycles(): number {
    return 9 * iicSclDivider(this.s.ibfd);
  }

  private advance(t: number): void {
    const s = this.s;
    if (s.busyUntil <= t) {
      s.busyUntil = Infinity;
      s.ibsr |= B.TCF | B.IBIF;
      // Nobody acknowledges: RXAK=1 after a transmitted byte.
      if (s.ibcr & B.TX_RX) s.ibsr |= B.RXAK;
      else s.ibdr = 0xff;
      this.updateIrq();
    }
    if (t > s.t) s.t = t;
  }

  tick(_n: number): void {
    this.advance(this.ctx ? this.ctx.now : this.s.t);
  }

  nextEventCycles(): number {
    return this.s.busyUntil === Infinity ? Infinity : Math.max(0, this.s.busyUntil - this.s.t);
  }

  private updateIrq(): void {
    this.ctx?.setInterrupt(this.vector, (this.s.ibcr & B.IBIE) !== 0 && (this.s.ibsr & B.IBIF) !== 0);
  }

  private startByte(t: number): void {
    const s = this.s;
    s.ibsr &= ~(B.TCF | B.RXAK);
    s.busyUntil = t + this.byteCycles;
  }

  read(a: number): number {
    const t = this.now;
    this.advance(t);
    const s = this.s;
    if (a - this.base === 4) {
      const v = s.ibdr;
      // Master receive: reading IBDR starts the next byte.
      if (s.ibcr & B.IBEN && s.ibcr & B.MS_SL && !(s.ibcr & B.TX_RX)) this.startByte(t);
      return v;
    }
    return this.peek(a);
  }

  peek(a: number): number {
    const s = this.s;
    switch (a - this.base) {
      case 0:
        return s.ibad & 0xfe;
      case 1:
        return s.ibfd;
      case 2:
        return s.ibcr & IBCR_RW;
      case 3:
        return s.ibsr;
      case 4:
        return s.ibdr;
      default:
        return 0;
    }
  }

  write(a: number, v: number): void {
    const t = this.now;
    this.advance(t);
    const s = this.s;
    v &= 0xff;
    switch (a - this.base) {
      case 0:
        s.ibad = v & 0xfe;
        break;
      case 1:
        s.ibfd = v;
        break;
      case 2: {
        const old = s.ibcr;
        s.ibcr = v & IBCR_RW;
        if (!(v & B.IBEN)) {
          // Module disabled: status back to reset, transfer aborted.
          s.ibsr = B.TCF;
          s.busyUntil = Infinity;
          break;
        }
        if (!s.warned) {
          s.warned = true;
          this.ctx?.warn(`${this.name}: IIC bus not modelled - no device will acknowledge`, { register: `${this.name}_IBCR`, value: v });
        }
        if (!(old & B.MS_SL) && v & B.MS_SL) s.ibsr |= B.IBB; // START
        else if (old & B.MS_SL && !(v & B.MS_SL)) {
          s.ibsr &= ~B.IBB; // STOP
          s.busyUntil = Infinity;
        }
        break;
      }
      case 3:
        s.ibsr &= ~(v & IBSR_W1C);
        break;
      case 4:
        s.ibdr = v;
        if (s.ibcr & B.IBEN && s.ibcr & B.MS_SL && s.ibcr & B.TX_RX) this.startByte(t);
        break;
      default:
        return;
    }
    this.updateIrq();
  }

  snapshot(): unknown {
    return { ...this.s };
  }

  restore(state: unknown): void {
    const st = state as IicState;
    // Infinity survives a structured clone but becomes null through JSON.
    this.s = { ...st, busyUntil: st.busyUntil ?? Infinity };
    this.updateIrq();
  }
}
