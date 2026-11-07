/**
 * SCI0..SCI5 (S12SCIV5) of the MC9S12XDP512, with a host-side byte interface for the debugger Terminal window.
 *
 * Frame-level model: a character occupies `frameBits * bitCycles` bus cycles (1 start + 8/9 data incl. parity
 * + 1 stop; bitCycles = 16 * SBR, or 16 * (SBR & ~1) with IREN=1), the transmitter calls `onTransmit` listeners
 * at the end of each frame's stop bit, and bytes injected with `receive()` arrive back-to-back with the same frame
 * timing (RDRF at the end of the stop bit). TXD/RXD are claimed on the PinNet but not toggled bit by bit.
 *
 * Registers (offsets from base): 0 SCIBDH | SCIASR1, 1 SCIBDL | SCIACR1, 2 SCICR1 | SCIACR2 (alternative map
 * when SCISR2.AMAP=1), 3 SCICR2, 4 SCISR1, 5 SCISR2, 6 SCIDRH, 7 SCIDRL.
 *
 * Flag clearing: TDRE/TC - read SCISR1 with the flag set, then write SCIDRL. RDRF, IDLE, OR, NF, FE, PF - read
 * SCISR1 with the flag set, then read SCIDRL (only flags seen set by that SCISR1 read are cleared).
 */
import { addr as regAddr, mask, vectorByName } from '@s12/devices';
import type { BoardNets, Level } from '../pins.js';
import type { Peripheral, PeripheralContext, RegisterRange, ResetCause } from '../types.js';

export type SciIndex = 0 | 1 | 2 | 3 | 4 | 5;

/** Register-block base of SCI0..5 (from @s12/devices: $C8, $D0, $B8, $C0, $130, $138). */
export const SCI_BASES: readonly number[] = [0, 1, 2, 3, 4, 5].map((n) => regAddr(`SCI${n}BDH`));
/** Register ranges to pass to `S12XSystem.addPeripheral` (8 bytes each). */
export const SCI_RANGES: readonly RegisterRange[] = SCI_BASES.map((b): RegisterRange => [b, b + 7]);
/** IVBR-relative vector offsets (Vsci0 $D6, Vsci1 $D4, Vsci2 $8A, Vsci3 $88, Vsci4 $86, Vsci5 $84). */
export const SCI_VECTORS: readonly number[] = [0, 1, 2, 3, 4, 5].map((n) => vectorByName(`Vsci${n}`)!.offset);

/** Bit masks (from the device table). */
export const SCI_BITS = {
  // SCIBDH
  IREN: mask('SCI0BDH', 'IREN'),
  // SCICR1
  LOOPS: mask('SCI0CR1', 'LOOPS'),
  SCISWAI: mask('SCI0CR1', 'SCISWAI'),
  RSRC: mask('SCI0CR1', 'RSRC'),
  M: mask('SCI0CR1', 'M'),
  WAKE: mask('SCI0CR1', 'WAKE'),
  ILT: mask('SCI0CR1', 'ILT'),
  PE: mask('SCI0CR1', 'PE'),
  PT: mask('SCI0CR1', 'PT'),
  // SCICR2
  TIE: mask('SCI0CR2', 'TIE'),
  TCIE: mask('SCI0CR2', 'TCIE'),
  RIE: mask('SCI0CR2', 'RIE'),
  ILIE: mask('SCI0CR2', 'ILIE'),
  TE: mask('SCI0CR2', 'TE'),
  RE: mask('SCI0CR2', 'RE'),
  RWU: mask('SCI0CR2', 'RWU'),
  SBK: mask('SCI0CR2', 'SBK'),
  // SCISR1
  TDRE: mask('SCI0SR1', 'TDRE'),
  TC: mask('SCI0SR1', 'TC'),
  RDRF: mask('SCI0SR1', 'RDRF'),
  IDLE: mask('SCI0SR1', 'IDLE'),
  OR: mask('SCI0SR1', 'OR'),
  NF: mask('SCI0SR1', 'NF'),
  FE: mask('SCI0SR1', 'FE'),
  PF: mask('SCI0SR1', 'PF'),
  // SCISR2
  AMAP: mask('SCI0SR2', 'AMAP'),
  TXPOL: mask('SCI0SR2', 'TXPOL'),
  RXPOL: mask('SCI0SR2', 'RXPOL'),
  BRK13: mask('SCI0SR2', 'BRK13'),
  TXDIR: mask('SCI0SR2', 'TXDIR'),
  RAF: mask('SCI0SR2', 'RAF'),
  // SCIDRH
  R8: mask('SCI0DRH', 'R8'),
  T8: mask('SCI0DRH', 'T8'),
  // alternative map
  RXEDGIF: mask('SCI0ASR1', 'RXEDGIF'),
  BERRV: mask('SCI0ASR1', 'BERRV'),
  BERRIF: mask('SCI0ASR1', 'BERRIF'),
  BKDIF: mask('SCI0ASR1', 'BKDIF'),
  RXEDGIE: mask('SCI0ACR1', 'RXEDGIE'),
  BERRIE: mask('SCI0ACR1', 'BERRIE'),
  BKDIE: mask('SCI0ACR1', 'BKDIE'),
} as const;
const B = SCI_BITS;
const RX_FLAGS = B.RDRF | B.IDLE | B.OR | B.NF | B.FE | B.PF;
const SR2_RW = B.AMAP | B.TXPOL | B.RXPOL | B.BRK13 | B.TXDIR; // $9E
const ASR1_W1C = B.RXEDGIF | B.BERRIF | B.BKDIF; // $83
const ACR1_MASK = B.RXEDGIE | B.BERRIE | B.BKDIE; // $83
const ACR2_MASK = 0x07;

/**
 * RXD/TXD pins. SCI0/1 on port S are certain; UNCERTAIN: SCI2 on PJ0/PJ1, SCI3 on PM6/PM7, SCI4 on PH4/PH5 and
 * SCI5 on PH6/PH7 are from the S12XD family pinout from memory (not cross-checked against the XDP512 RM).
 */
export const SCI_PINS: readonly { rxd: string; txd: string }[] = [
  { rxd: 'PS0', txd: 'PS1' },
  { rxd: 'PS2', txd: 'PS3' },
  { rxd: 'PJ0', txd: 'PJ1' },
  { rxd: 'PM6', txd: 'PM7' },
  { rxd: 'PH4', txd: 'PH5' },
  { rxd: 'PH6', txd: 'PH7' },
];

export interface SciOptions {
  /** Module number (default 0). */
  index?: SciIndex;
  /**
   * false (default): every SCIDRL write loads the transmit buffer; a write that was not preceded by a SCISR1 read
   * with TDRE=1 still logs a warning. true: such a write is ignored (TDRE stays set, nothing is sent).
   * UNCERTAIN: the S12SCIV5 RM only documents the TDRE clearing sequence; unlike the SPI RM it does not say a bare
   * write is ignored, so the lenient behaviour is the default. Expose this in the board settings.
   */
  strictTdreSequence?: boolean;
  /** Notified when the set of pins claimed by the module changes. */
  onPinsChanged?: () => void;
}

/** Extra information for a transmitted character. */
export interface SciTxInfo {
  /** Data bits on the wire: 7 (M=0, PE=1), 8, or 9 (M=1, PE=0: `bit8` = T8). */
  dataBits: 7 | 8 | 9;
  /** Ninth data bit (M=1, PE=0). */
  bit8?: 0 | 1;
  /** Parity bit actually sent (PE=1). */
  parity?: 0 | 1;
  /** Raw data bits after the start bit, LSB first (8 or 9 bits, parity included). */
  raw: number;
}

export type SciTxListener = (byte: number, cycle: number, info: SciTxInfo) => void;
export type SciBreakListener = (cycle: number, bits: number) => void;

export interface SciReceiveOptions {
  /** Ninth data bit (M=1, PE=0). Default 0. */
  bit8?: 0 | 1;
  /** Send the frame with a wrong parity bit (PF). */
  parityError?: boolean;
  /** Send the frame with a 0 stop bit (FE). */
  framingError?: boolean;
  /** Flag noise on the frame (NF). */
  noise?: boolean;
}

interface RxFrame {
  /** Raw data bits (8 or 9, parity included) or -1 for a break character. */
  raw: number;
  fe: boolean;
  nf: boolean;
  /** Send a wrong parity bit. */
  pfWanted: boolean;
  bit8: number;
  value: number;
  isBreak: boolean;
}

interface SciState {
  t: number;
  bdh: number;
  bdl: number;
  /** Latched SBR/IREN/TNP (BDH:BDL, committed by the SCIBDL write). */
  bd: number;
  cr1: number;
  cr2: number;
  sr2: number;
  t8: number;
  r8: number;
  drl: number;
  flags: number; // RDRF IDLE OR NF FE PF bits of SCISR1
  armRx: number;
  armTx: boolean;
  asr1: number;
  acr1: number;
  acr2: number;
  // transmitter
  txBuf: number;
  txFull: boolean;
  txKind: 0 | 1 | 2 | 3; // none, data, preamble, break
  txRaw: number;
  txEnd: number;
  txBits: number;
  preamblePending: boolean;
  // receiver (host line)
  rxQueue: RxFrame[];
  rxCur: RxFrame | null;
  rxStart: number;
  rxEnd: number;
  rxBitCycles: number;
  idleAt: number;
  idleArmed: boolean;
}

const TX_NONE = 0;
const TX_DATA = 1;
const TX_PREAMBLE = 2;
const TX_BREAK = 3;

function parityOf(v: number): number {
  let p = 0;
  for (let x = v; x; x >>= 1) p ^= x & 1;
  return p;
}

export class SciModule implements Peripheral {
  readonly name: string;
  readonly index: SciIndex;
  readonly base: number;
  readonly vector: number;
  readonly strictTdreSequence: boolean;
  private ctx: PeripheralContext | null = null;
  private readonly nets: BoardNets;
  private readonly onPinsChanged?: () => void;
  private s: SciState = SciModule.initial();
  private txListeners: SciTxListener[] = [];
  private breakListeners: SciBreakListener[] = [];
  private claims: { pin: string; dir: 'in' | 'out'; role: 'rxd' | 'txd' }[] = [];

  constructor(nets: BoardNets, opts: SciOptions = {}) {
    this.index = opts.index ?? 0;
    this.name = `SCI${this.index}`;
    this.nets = nets;
    this.base = SCI_BASES[this.index];
    this.vector = SCI_VECTORS[this.index];
    this.strictTdreSequence = opts.strictTdreSequence ?? false;
    this.onPinsChanged = opts.onPinsChanged;
  }

  private static initial(): SciState {
    return {
      t: 0,
      bdh: 0,
      bdl: 0x04,
      bd: 0x0004,
      cr1: 0,
      cr2: 0,
      sr2: 0,
      t8: 0,
      r8: 0,
      drl: 0,
      flags: 0,
      armRx: 0,
      armTx: false,
      asr1: 0,
      acr1: 0,
      acr2: 0,
      txBuf: 0,
      txFull: false,
      txKind: TX_NONE,
      txRaw: 0,
      txEnd: 0,
      txBits: 0,
      preamblePending: false,
      rxQueue: [],
      rxCur: null,
      rxStart: 0,
      rxEnd: 0,
      rxBitCycles: 0,
      idleAt: Infinity,
      idleArmed: false,
    };
  }

  attach(ctx: PeripheralContext): void {
    this.ctx = ctx;
  }

  private get now(): number {
    const n = this.ctx ? this.ctx.now : 0;
    return n > this.s.t ? n : this.s.t;
  }

  reset(_cause?: ResetCause): void {
    const t = this.ctx ? this.ctx.now : 0;
    this.s = SciModule.initial();
    this.s.t = t;
    this.applyPins();
    this.updateIrq();
  }

  // ------------------------------------------------------------------ host interface (Terminal window)

  /** Subscribe to transmitted characters (called at the end of each frame's stop bit). Returns an unsubscribe function. */
  onTransmit(cb: SciTxListener): () => void {
    this.txListeners.push(cb);
    return () => {
      const i = this.txListeners.indexOf(cb);
      if (i >= 0) this.txListeners.splice(i, 1);
    };
  }

  /** Subscribe to transmitted break characters (SBK). */
  onBreak(cb: SciBreakListener): () => void {
    this.breakListeners.push(cb);
    return () => {
      const i = this.breakListeners.indexOf(cb);
      if (i >= 0) this.breakListeners.splice(i, 1);
    };
  }

  /**
   * Inject characters on RXD from the host (Terminal input). Frames are sent back-to-back at the SCI's current
   * baud rate, starting now (or after frames already queued). A string is sent as its char codes (low 8 bits).
   * Call from outside the run loop or from a callback; the module syncs itself to the current bus cycle.
   */
  receive(data: number | readonly number[] | string, opts: SciReceiveOptions = {}): void {
    const bytes = typeof data === 'number' ? [data] : typeof data === 'string' ? [...data].map((c) => c.charCodeAt(0)) : data;
    this.syncForHost();
    for (const b of bytes) {
      this.s.rxQueue.push({
        raw: 0,
        value: b & 0xff,
        bit8: opts.bit8 ?? 0,
        fe: !!opts.framingError,
        nf: !!opts.noise,
        pfWanted: !!opts.parityError,
        isBreak: false,
      });
    }
    this.afterHost();
  }

  /** Inject a break character (all zeros, FE set) from the host. */
  receiveBreak(): void {
    this.syncForHost();
    this.s.rxQueue.push({ raw: 0, value: 0, bit8: 0, fe: true, nf: false, pfWanted: false, isBreak: true });
    this.afterHost();
  }

  /** True while events are being processed (a listener calling `receive` re-enters). */
  private advancing = false;

  private syncForHost(): void {
    if (this.advancing) return; // called from a listener: the current event time is the module time
    this.ctx?.sync();
    this.advance(this.now);
  }

  private afterHost(): void {
    if (this.advancing) return; // the running event loop starts the queued frame
    this.advance(this.now);
    this.ctx?.reschedule();
  }

  /** Characters injected but not yet fully received (including the one on the line). */
  get rxPending(): number {
    return this.s.rxQueue.length + (this.s.rxCur ? 1 : 0);
  }

  /** Drop host characters not yet on the line. */
  clearReceiveQueue(): void {
    this.s.rxQueue.length = 0;
  }

  // ------------------------------------------------------------------ derived values

  /** SBR[12:0] as latched by the last SCIBDL write. */
  get sbr(): number {
    return this.s.bd & 0x1fff;
  }

  /** Bus cycles per bit (0 = baud-rate generator off, SBR=0). */
  get bitCycles(): number {
    const sbr = this.sbr;
    // IREN=1: baud = bus / (32 * SBR[12:1]).
    return this.s.bd & (B.IREN << 8) ? 32 * (sbr >> 1) : 16 * sbr;
  }

  /** Baud rate (bit/s) at the current bus clock (0 when the generator is off). */
  get baud(): number {
    const bc = this.bitCycles;
    return bc ? (this.ctx ? this.ctx.busHz : 0) / bc : 0;
  }

  /** Bits per frame: start + 8 or 9 data (parity included) + stop. */
  get frameBits(): number {
    return this.s.cr1 & B.M ? 11 : 10;
  }

  /** Bus cycles per character frame. */
  get frameCycles(): number {
    return this.frameBits * this.bitCycles;
  }

  private get te(): boolean {
    return (this.s.cr2 & B.TE) !== 0;
  }

  private get re(): boolean {
    return (this.s.cr2 & B.RE) !== 0;
  }

  private get tdre(): boolean {
    return !this.s.txFull;
  }

  private get tc(): boolean {
    const s = this.s;
    return !s.txFull && s.txKind === TX_NONE && !s.preamblePending && !(this.te && s.cr2 & B.SBK);
  }

  private get loopInternal(): boolean {
    return (this.s.cr1 & (B.LOOPS | B.RSRC)) === B.LOOPS;
  }

  private get singleWire(): boolean {
    return (this.s.cr1 & (B.LOOPS | B.RSRC)) === (B.LOOPS | B.RSRC);
  }

  private sr1(): number {
    return (this.tdre ? B.TDRE : 0) | (this.tc ? B.TC : 0) | this.s.flags;
  }

  private sr2(): number {
    const s = this.s;
    const raf = this.re && s.rxCur !== null && !s.rxCur.isBreak && s.t >= s.rxStart && s.t < s.rxEnd;
    return (s.sr2 & SR2_RW) | (raf ? B.RAF : 0);
  }

  // ------------------------------------------------------------------ time

  private advance(t: number): void {
    if (this.advancing) return;
    this.advancing = true;
    try {
      this.advanceLoop(t);
    } finally {
      this.advancing = false;
    }
  }

  private advanceLoop(t: number): void {
    const s = this.s;
    for (let guard = 0; guard < 1_000_000; guard++) {
      // Earliest pending event <= t.
      let e = Infinity;
      let which = 0;
      if (s.txKind !== TX_NONE && s.txEnd < e) {
        e = s.txEnd;
        which = 1;
      }
      if (s.rxCur && s.rxEnd < e) {
        e = s.rxEnd;
        which = 2;
      }
      if (s.idleAt < e) {
        e = s.idleAt;
        which = 3;
      }
      if (!s.rxCur && s.rxQueue.length && s.t < e) {
        // A queued host character starts at the module's current time (line idle).
        e = s.t;
        which = 4;
      }
      if (e > t || which === 0) break;
      if (e > s.t) s.t = e;
      if (which === 1) this.txComplete(e);
      else if (which === 2) this.rxComplete(e);
      else if (which === 3) this.idleDetected(e);
      else this.rxBegin(e);
    }
    if (t > s.t) s.t = t;
  }

  tick(_n: number): void {
    this.advance(this.ctx ? this.ctx.now : this.s.t);
  }

  nextEventCycles(): number {
    const s = this.s;
    let e = Infinity;
    if (s.txKind !== TX_NONE) e = Math.min(e, s.txEnd);
    if (s.rxCur) e = Math.min(e, s.rxEnd);
    e = Math.min(e, s.idleAt);
    if (!s.rxCur && s.rxQueue.length) e = Math.min(e, s.t);
    return e === Infinity ? Infinity : Math.max(0, e - s.t);
  }

  // ------------------------------------------------------------------ transmitter

  /** Load the transmit shift register if it is idle (preamble, break, then buffered data). */
  private txKick(t: number): void {
    const s = this.s;
    if (s.txKind !== TX_NONE) return;
    const bc = this.bitCycles;
    if (!this.te || bc === 0) {
      // UNCERTAIN: with SBR=0 the baud-rate generator is off and nothing is shifted.
      this.applyPins();
      return;
    }
    if (s.preamblePending) {
      s.preamblePending = false;
      s.txKind = TX_PREAMBLE;
      s.txBits = this.frameBits;
    } else if (s.cr2 & B.SBK) {
      s.txKind = TX_BREAK;
      s.txBits = (s.sr2 & B.BRK13 ? 13 : 10) + (s.cr1 & B.M ? 1 : 0);
    } else if (s.txFull) {
      s.txFull = false;
      s.txKind = TX_DATA;
      s.txRaw = this.encode(s.txBuf, (s.t8 & B.T8) !== 0 ? 1 : 0);
      s.txBits = this.frameBits;
    } else {
      this.applyPins();
      return;
    }
    s.txEnd = t + s.txBits * bc;
    this.applyPins();
  }

  /** Raw data bits of a character with the current M/PE/PT. */
  private encode(byte: number, bit8: number): number {
    const m = (this.s.cr1 & B.M) !== 0;
    const pe = (this.s.cr1 & B.PE) !== 0;
    const odd = (this.s.cr1 & B.PT) !== 0 ? 1 : 0;
    if (!m) {
      if (!pe) return byte & 0xff;
      const d = byte & 0x7f;
      return d | ((parityOf(d) ^ odd) << 7);
    }
    if (!pe) return (byte & 0xff) | ((bit8 & 1) << 8);
    const d = byte & 0xff;
    return d | ((parityOf(d) ^ odd) << 8);
  }

  private txComplete(e: number): void {
    const s = this.s;
    const kind = s.txKind;
    s.txKind = TX_NONE;
    if (kind === TX_DATA) {
      const m = (s.cr1 & B.M) !== 0;
      const pe = (s.cr1 & B.PE) !== 0;
      const info: SciTxInfo = { dataBits: m ? (pe ? 8 : 9) : pe ? 7 : 8, raw: s.txRaw };
      if (m && !pe) info.bit8 = ((s.txRaw >> 8) & 1) as 0 | 1;
      if (pe) info.parity = ((s.txRaw >> (m ? 8 : 7)) & 1) as 0 | 1;
      const byte = s.txRaw & (m || !pe ? 0xff : 0x7f);
      // Where the frame goes: internal loop -> own receiver only; single-wire -> TXD pin (host + own receiver)
      // when TXDIR=1; normal -> host.
      // UNCERTAIN: in internal loop mode (LOOPS=1, RSRC=0) the TXD pin is assumed not to carry the frame.
      if (this.loopInternal) {
        this.latch(s.txRaw, false, false, e, false);
      } else if (this.singleWire) {
        if (s.sr2 & B.TXDIR) {
          for (const l of [...this.txListeners]) l(byte, e, info);
          this.latch(s.txRaw, false, false, e, false);
        }
      } else {
        for (const l of [...this.txListeners]) l(byte, e, info);
      }
    } else if (kind === TX_BREAK) {
      if (!this.loopInternal && (!this.singleWire || s.sr2 & B.TXDIR)) for (const l of [...this.breakListeners]) l(e, s.txBits);
      if (this.loopInternal || (this.singleWire && s.sr2 & B.TXDIR)) this.latch(0, true, false, e, true);
    }
    this.txKick(e);
    this.updateIrq();
  }

  // ------------------------------------------------------------------ receiver

  private rxBegin(t: number): void {
    const s = this.s;
    const f = s.rxQueue.shift()!;
    const bc = this.bitCycles;
    if (bc === 0) {
      this.ctx?.warn(`${this.name}: received character dropped (baud-rate generator off, SBR=0)`, { value: f.value });
      return;
    }
    // Encode with the receiver's current format (the host follows the SCI's settings).
    if (!f.isBreak) {
      f.raw = this.encode(f.value, f.bit8);
      if (f.pfWanted && s.cr1 & B.PE) f.raw ^= 1 << (s.cr1 & B.M ? 8 : 7);
    }
    s.rxCur = f;
    s.rxStart = t;
    s.rxBitCycles = bc;
    const bits = f.isBreak ? (s.sr2 & B.BRK13 ? 13 : 10) + (s.cr1 & B.M ? 1 : 0) : this.frameBits;
    s.rxEnd = t + bits * bc;
    // A new start bit cancels a pending idle detection.
    s.idleAt = Infinity;
    // Falling edge of the start bit on RXD. UNCERTAIN: set whatever RE is (the edge detector is described as
    // independent of the receiver), but not when RXD is disconnected (internal loop mode).
    if (!this.loopInternal) s.asr1 |= B.RXEDGIF;
    this.updateIrq();
  }

  private rxComplete(e: number): void {
    const s = this.s;
    const f = s.rxCur!;
    s.rxCur = null;
    // Host frames reach the receiver unless RXD is disconnected (internal loop) or the single-wire pin is an output.
    const connected = !this.loopInternal && !(this.singleWire && s.sr2 & B.TXDIR);
    if (connected) this.latch(f.raw, f.isBreak || f.fe, f.nf, e, f.isBreak);
    this.updateIrq();
  }

  /** A complete character arrived at the receiver at time `e`. */
  private latch(raw: number, fe: boolean, nf: boolean, e: number, isBreak: boolean): void {
    const s = this.s;
    if (!this.re) return;
    const bc = this.bitCycles;
    const m = (s.cr1 & B.M) !== 0;
    const pe = (s.cr1 & B.PE) !== 0;
    const msb = m ? 8 : 7;
    // Idle detection: ILT=1 counts from the end of the stop bit; ILT=0 counts the ones after the start bit,
    // so the trailing ones of the frame (stop bit and high data bits) count toward the idle character.
    let trailing = 0;
    if (!fe) {
      trailing = 1;
      for (let b = msb; b >= 0 && (raw >> b) & 1; b--) trailing++;
    }
    const idleBits = s.cr1 & B.ILT ? this.frameBits : Math.max(0, this.frameBits - trailing);
    s.idleAt = bc ? e + idleBits * bc : Infinity;
    if (isBreak) s.idleAt = bc ? e + this.frameBits * bc : Infinity;

    if (s.cr2 & B.RWU) {
      // Receiver in standby. Address-mark wakeup (WAKE=1): a frame with its MSB set wakes the receiver and is
      // received. Idle-line wakeup (WAKE=0) is handled by idleDetected().
      if (!(s.cr1 & B.WAKE) || fe || !((raw >> msb) & 1)) return;
      s.cr2 &= ~B.RWU;
    }
    if (s.flags & B.RDRF) {
      s.flags |= B.OR; // the new character is lost; SCIDR keeps the old one
      return;
    }
    s.drl = raw & 0xff;
    s.r8 = m ? (raw >> 8) & 1 : 0;
    let flags = B.RDRF;
    if (fe) flags |= B.FE;
    if (nf) flags |= B.NF;
    if (pe) {
      const odd = s.cr1 & B.PT ? 1 : 0;
      const data = raw & ((1 << msb) - 1);
      const p = (raw >> msb) & 1;
      if ((parityOf(data) ^ odd) !== p && !fe) flags |= B.PF;
    }
    s.flags = (s.flags & ~(B.NF | B.FE | B.PF)) | flags;
    s.idleArmed = true;
  }

  private idleDetected(_e: number): void {
    const s = this.s;
    s.idleAt = Infinity;
    if (!this.re) return;
    if (s.cr2 & B.RWU) {
      if (!(s.cr1 & B.WAKE)) s.cr2 &= ~B.RWU; // idle-line wakeup
      return;
    }
    if (s.idleArmed) {
      s.flags |= B.IDLE;
      s.idleArmed = false;
    }
    this.updateIrq();
  }

  // ------------------------------------------------------------------ interrupts

  private updateIrq(): void {
    if (!this.ctx) return;
    const s = this.s;
    const cr2 = s.cr2;
    const on =
      ((cr2 & B.TIE) !== 0 && this.tdre) ||
      ((cr2 & B.TCIE) !== 0 && this.tc) ||
      ((cr2 & B.RIE) !== 0 && (s.flags & (B.RDRF | B.OR)) !== 0) ||
      ((cr2 & B.ILIE) !== 0 && (s.flags & B.IDLE) !== 0) ||
      (s.acr1 & s.asr1 & ASR1_W1C) !== 0;
    this.ctx.setInterrupt(this.vector, on);
  }

  // ------------------------------------------------------------------ registers

  private get amap(): boolean {
    return (this.s.sr2 & B.AMAP) !== 0;
  }

  read(a: number): number {
    this.advance(this.now);
    const s = this.s;
    switch (a - this.base) {
      case 4: {
        const v = this.sr1();
        s.armRx = v & RX_FLAGS;
        s.armTx = (v & (B.TDRE | B.TC)) !== 0;
        return v;
      }
      case 7: {
        const v = s.drl;
        if (s.armRx) {
          s.flags &= ~s.armRx;
          s.armRx = 0;
          this.updateIrq();
        }
        return v;
      }
      default:
        return this.peek(a);
    }
  }

  peek(a: number): number {
    const s = this.s;
    switch (a - this.base) {
      case 0:
        // UNCERTAIN: SCIBDH reads back the last value written (held until SCIBDL commits it).
        return this.amap ? s.asr1 & (ASR1_W1C | B.BERRV) : s.bdh;
      case 1:
        return this.amap ? s.acr1 : s.bdl;
      case 2:
        return this.amap ? s.acr2 : s.cr1;
      case 3:
        return s.cr2;
      case 4:
        return this.sr1();
      case 5:
        return this.sr2();
      case 6:
        return (s.r8 ? B.R8 : 0) | (s.t8 & B.T8);
      case 7:
        return s.drl;
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
        if (this.amap) s.asr1 &= ~(v & ASR1_W1C);
        else s.bdh = v; // held until SCIBDL is written
        break;
      case 1:
        if (this.amap) s.acr1 = v & ACR1_MASK;
        else {
          s.bdl = v;
          s.bd = (s.bdh << 8) | v; // UNCERTAIN: a baud change only affects frames started afterwards
          // A valid SBR (re)starts the baud-rate generator: anything waiting with TE=1 (preamble, data) goes out now.
          this.txKick(t);
        }
        break;
      case 2:
        if (this.amap) s.acr2 = v & ACR2_MASK;
        else s.cr1 = v;
        break;
      case 3: {
        const old = s.cr2;
        s.cr2 = v;
        if (!(old & B.TE) && v & B.TE) s.preamblePending = true; // TE 0->1 queues an idle preamble
        if (!(old & B.RWU) && v & B.RWU && !(s.cr1 & B.WAKE) && !s.rxCur && this.bitCycles) {
          // UNCERTAIN: idle-line wakeup needs a full idle character after RWU is set.
          s.idleAt = t + this.frameBits * this.bitCycles;
        }
        if (old & B.RE && !(v & B.RE)) s.idleAt = Infinity;
        // UNCERTAIN: clearing TE lets the frame in the shifter finish; buffered data waits for TE=1 again.
        this.txKick(t);
        break;
      }
      case 4:
        return; // read-only
      case 5:
        s.sr2 = v & SR2_RW;
        break;
      case 6:
        s.t8 = v & B.T8;
        break;
      case 7:
        if (!s.armTx) {
          const what = this.strictTdreSequence ? 'ignored' : 'accepted';
          this.ctx?.warn(`${this.name}: write to ${this.name}DRL ${what} without reading TDRE=1 in ${this.name}SR1 first`, {
            register: `${this.name}DRL`,
            value: v,
          });
        }
        if (s.armTx || !this.strictTdreSequence) {
          s.armTx = false;
          if (!s.txFull || !this.strictTdreSequence) {
            s.txBuf = v;
            s.txFull = true;
            this.txKick(t);
          }
        }
        break;
      default:
        return;
    }
    this.applyPins();
    this.updateIrq();
  }

  // ------------------------------------------------------------------ pins

  get pins(): { rxd: string; txd: string } {
    return SCI_PINS[this.index];
  }

  claimedPins(): readonly { pin: string; dir: 'in' | 'out'; role: 'rxd' | 'txd' }[] {
    return this.claims;
  }

  isPinClaimed(pin: string): boolean {
    return this.claims.some((c) => c.pin === pin);
  }

  private applyPins(): void {
    const s = this.s;
    const p = this.pins;
    const next: { pin: string; dir: 'in' | 'out'; role: 'rxd' | 'txd' }[] = [];
    const txActive = this.te || s.txKind !== TX_NONE;
    if (this.singleWire) {
      if (s.sr2 & B.TXDIR) {
        if (txActive) next.push({ pin: p.txd, dir: 'out', role: 'txd' });
      } else if (this.re || txActive) next.push({ pin: p.txd, dir: 'in', role: 'txd' });
    } else {
      if (txActive) next.push({ pin: p.txd, dir: 'out', role: 'txd' });
      if (this.re && !this.loopInternal) next.push({ pin: p.rxd, dir: 'in', role: 'rxd' });
    }
    const prev = this.claims;
    this.claims = next;
    for (const c of prev) if (c.dir === 'out' && !next.some((n) => n.pin === c.pin && n.dir === 'out')) this.nets.pins.setMcuOutput(c.pin, null, 'periph');
    const idle: Level = s.sr2 & B.TXPOL ? 0 : 1;
    for (const c of next) {
      if (c.dir !== 'out') continue;
      // The TXD pin shows the idle level (or the space level during a break); data bits are not toggled.
      this.nets.pins.setMcuOutput(c.pin, s.txKind === TX_BREAK ? ((1 - idle) as Level) : idle, 'periph');
    }
    const same = prev.length === next.length && prev.every((c, i) => c.pin === next[i].pin && c.dir === next[i].dir);
    if (!same) this.onPinsChanged?.();
  }

  // ------------------------------------------------------------------ snapshot

  snapshot(): unknown {
    const s = this.s;
    return { ...s, rxQueue: s.rxQueue.map((f) => ({ ...f })), rxCur: s.rxCur ? { ...s.rxCur } : null };
  }

  restore(state: unknown): void {
    const st = state as SciState;
    // Infinity survives a structured clone but becomes null through JSON.
    this.s = { ...st, idleAt: st.idleAt ?? Infinity, rxQueue: st.rxQueue.map((f) => ({ ...f })), rxCur: st.rxCur ? { ...st.rxCur } : null };
    this.applyPins();
    this.updateIrq();
  }
}
