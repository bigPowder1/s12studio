/**
 * PWM (PWM_8B8C, $0300-$0327) of the MC9S12XDP512: 8 channels on PP0..PP7, concatenation into 16-bit channels
 * (CON01/23/45/67), left/center alignment, clocks A/B/SA/SB, double-buffered period/duty, emergency shutdown.
 *
 * Model: per-channel counters are evaluated lazily from clock-tick counts, so a PWMCNTx read returns the exact
 * counter value at the access cycle, and new period/duty values are latched exactly at the end of the effective
 * period (left aligned: counter reaches PWMPER and resets; center aligned: counter counts back down to 0), when
 * PWMCNTx is written, or when the channel is disabled (writes to a disabled channel go straight to the latches).
 * Block guide: S12PWM8B8CV1 V01.17 §3.3 / §4.2.
 *
 * Board interface: the averaged output of every PP pin is published on `nets.pwm` (`PwmBus`): enabled, dutyHigh
 * (polarity applied), periodSeconds. Enabled outputs are claimed on the PinNet 'periph' layer: driven to the static
 * level for 0 % / 100 % duty; for other duties the pin level is not toggled per edge (it keeps the level the output
 * had when the state last changed - board models must use the PwmBus). `outputLevel(ch)` gives the exact
 * instantaneous level when needed.
 *
 * Clock phases (UNCERTAIN, not specified beyond "synchronised"): the prescaler restarts when the first channel is
 * enabled (all PWMEx=0 stops it) and whenever PWMPRCLK is written; clock SA/SB restart when PWMSCLA/B is written.
 */
import { addr as regAddr, mask, vectorByName } from '@s12/devices';
import type { BoardNets, Level, PwmOutputState } from '../pins.js';
import type { Peripheral, PeripheralContext, RegisterRange, ResetCause } from '../types.js';

export const PWM_BASE = regAddr('PWME');
/** Register range for `S12XSystem.addPeripheral` ($0300-$0327; $0325-$0327 reserved, read 0). */
export const PWM_RANGE: RegisterRange = [PWM_BASE, PWM_BASE + 0x27];
/** Emergency shutdown vector (Vpwmesdn $8C). */
export const PWM_VECTOR = vectorByName('Vpwmesdn')!.offset;

export const PWM_REGS = {
  PWME: regAddr('PWME') - PWM_BASE,
  PWMPOL: regAddr('PWMPOL') - PWM_BASE,
  PWMCLK: regAddr('PWMCLK') - PWM_BASE,
  PWMPRCLK: regAddr('PWMPRCLK') - PWM_BASE,
  PWMCAE: regAddr('PWMCAE') - PWM_BASE,
  PWMCTL: regAddr('PWMCTL') - PWM_BASE,
  PWMSCLA: regAddr('PWMSCLA') - PWM_BASE,
  PWMSCLB: regAddr('PWMSCLB') - PWM_BASE,
  PWMCNT0: regAddr('PWMCNT0') - PWM_BASE,
  PWMPER0: regAddr('PWMPER0') - PWM_BASE,
  PWMDTY0: regAddr('PWMDTY0') - PWM_BASE,
  PWMSDN: regAddr('PWMSDN') - PWM_BASE,
} as const;
const R = PWM_REGS;

export const PWM_BITS = {
  CON67: mask('PWMCTL', 'CON67'),
  CON45: mask('PWMCTL', 'CON45'),
  CON23: mask('PWMCTL', 'CON23'),
  CON01: mask('PWMCTL', 'CON01'),
  PSWAI: mask('PWMCTL', 'PSWAI'),
  PFRZ: mask('PWMCTL', 'PFRZ'),
  PWMIF: mask('PWMSDN', 'PWMIF'),
  PWMIE: mask('PWMSDN', 'PWMIE'),
  PWMRSTRT: mask('PWMSDN', 'PWMRSTRT'),
  PWMLVL: mask('PWMSDN', 'PWMLVL'),
  PWM7IN: mask('PWMSDN', 'PWM7IN'),
  PWM7INL: mask('PWMSDN', 'PWM7INL'),
  PWM7ENA: mask('PWMSDN', 'PWM7ENA'),
} as const;
const B = PWM_BITS;
/** CONxy bit for channel pair p (0: CON01 .. 3: CON67). */
const CON = [B.CON01, B.CON23, B.CON45, B.CON67];

/** A logical PWM channel: an 8-bit channel, or a 16-bit pair (hi = even channel, ctl = odd channel). */
export interface PwmChannelInfo {
  /** Channel whose PWME/PPOL/PCLK/CAE bits and pin control the output. */
  ctl: number;
  /** High-order channel of a concatenated pair, or -1. */
  hi: number;
  bits: 8 | 16;
  pin: string;
}

export interface PwmOptions {
  /** Output pin per channel (default PP0..PP7). */
  pins?: readonly string[];
  /** Notified when the set of pins claimed by the module changes (the PIM must not drive claimed pins). */
  onPinsChanged?: () => void;
}

export interface PwmSnapshot {
  pwme: number;
  pol: number;
  clk: number;
  prclk: number;
  cae: number;
  ctl: number;
  scla: number;
  sclb: number;
  sdn: number;
  shutdown: boolean;
  perBuf: number[];
  dtyBuf: number[];
  perLat: number[];
  dtyLat: number[];
  cnt: number[];
  down: boolean[];
  preOrigin: number;
  saOrigin: number;
  sbOrigin: number;
  t: number;
  waiting: boolean;
}

export class PwmModule implements Peripheral {
  readonly name = 'PWM';
  readonly base = PWM_BASE;
  readonly vector = PWM_VECTOR;
  readonly pins: readonly string[];
  private ctx: PeripheralContext | null = null;
  private readonly nets: BoardNets;
  private readonly onPinsChanged?: () => void;
  private s: PwmSnapshot;
  private claimed = new Map<string, Level>();
  private published = new Map<string, string>();
  private lastBusHz = 0;
  private pp7Unsub: (() => void) | null = null;

  constructor(nets: BoardNets, opts: PwmOptions = {}) {
    this.nets = nets;
    this.pins = opts.pins ?? Array.from({ length: 8 }, (_, i) => `PP${i}`);
    this.onPinsChanged = opts.onPinsChanged;
    this.s = PwmModule.initial(0);
  }

  private static initial(t: number): PwmSnapshot {
    return {
      pwme: 0,
      pol: 0,
      clk: 0,
      prclk: 0,
      cae: 0,
      ctl: 0,
      scla: 0,
      sclb: 0,
      sdn: 0,
      shutdown: false,
      perBuf: new Array<number>(8).fill(0xff),
      dtyBuf: new Array<number>(8).fill(0xff),
      perLat: new Array<number>(8).fill(0xff),
      dtyLat: new Array<number>(8).fill(0xff),
      cnt: new Array<number>(8).fill(0),
      down: new Array<boolean>(8).fill(false),
      preOrigin: t,
      saOrigin: t,
      sbOrigin: t,
      t,
      waiting: false,
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
    this.s = PwmModule.initial(this.ctx ? this.ctx.now : 0);
    this.watchPp7();
    this.applyOutputs(this.s.t);
    this.updateIrq();
  }

  // ------------------------------------------------------------------ channel topology and clocks

  /** Logical channels for the current PWMCTL concatenation bits. */
  channels(): PwmChannelInfo[] {
    const out: PwmChannelInfo[] = [];
    for (let p = 0; p < 4; p++) {
      const e = 2 * p;
      const o = e + 1;
      if (this.s.ctl & CON[p]) out.push({ ctl: o, hi: e, bits: 16, pin: this.pins[o] });
      else {
        out.push({ ctl: e, hi: -1, bits: 8, pin: this.pins[e] });
        out.push({ ctl: o, hi: -1, bits: 8, pin: this.pins[o] });
      }
    }
    return out;
  }

  /** Logical channel containing physical channel `ch`. */
  channelOf(ch: number): PwmChannelInfo {
    return this.channels().find((c) => c.ctl === ch || c.hi === ch)!;
  }

  /** Bus cycles per tick of the clock feeding channel `ch` (A/SA for 0,1,4,5; B/SB for 2,3,6,7). */
  clockPeriod(ch: number): number {
    const useB = (ch & 2) !== 0;
    const pck = useB ? (this.s.prclk >> 4) & 7 : this.s.prclk & 7;
    const base = 1 << pck;
    if (!((this.s.clk >> ch) & 1)) return base;
    const scl = (useB ? this.s.sclb : this.s.scla) || 256;
    return base * 2 * scl;
  }

  private clockOrigin(ch: number): number {
    if (!((this.s.clk >> ch) & 1)) return this.s.preOrigin;
    return (ch & 2) !== 0 ? this.s.sbOrigin : this.s.saOrigin;
  }

  private static ticks(origin: number, period: number, t1: number, t2: number): number {
    if (t2 <= t1) return 0;
    return Math.floor((t2 - origin) / period) - Math.floor((t1 - origin) / period);
  }

  private enabled(c: PwmChannelInfo): boolean {
    return ((this.s.pwme >> c.ctl) & 1) === 1;
  }

  private val(arr: number[], c: PwmChannelInfo): number {
    return c.hi >= 0 ? (arr[c.hi] << 8) | arr[c.ctl] : arr[c.ctl];
  }

  private set(arr: number[], c: PwmChannelInfo, v: number): void {
    if (c.hi >= 0) {
      arr[c.hi] = (v >> 8) & 0xff;
      arr[c.ctl] = v & 0xff;
    } else arr[c.ctl] = v & 0xff;
  }

  private latch(c: PwmChannelInfo): void {
    const s = this.s;
    s.perLat[c.ctl] = s.perBuf[c.ctl];
    s.dtyLat[c.ctl] = s.dtyBuf[c.ctl];
    if (c.hi >= 0) {
      s.perLat[c.hi] = s.perBuf[c.hi];
      s.dtyLat[c.hi] = s.dtyBuf[c.hi];
    }
  }

  private pending(c: PwmChannelInfo): boolean {
    return this.val(this.s.perBuf, c) !== this.val(this.s.perLat, c) || this.val(this.s.dtyBuf, c) !== this.val(this.s.dtyLat, c);
  }

  private center(c: PwmChannelInfo): boolean {
    return ((this.s.cae >> c.ctl) & 1) === 1;
  }

  /** Clock ticks from the current counter state to the end of the effective period (the buffer load). */
  private ticksToPeriodEnd(c: PwmChannelInfo): number {
    const s = this.s;
    const per = this.val(s.perLat, c);
    const cnt = this.val(s.cnt, c);
    const mod = c.bits === 16 ? 0x10000 : 0x100;
    if (per === 0) return 1; // counter held at 0; every clock is a period end
    if (!this.center(c)) return cnt < per ? per - cnt : mod - cnt + per;
    if (s.down[c.ctl]) return cnt === 0 ? 2 * per : cnt;
    const up = cnt < per ? per - cnt : cnt === per ? 0 : mod - cnt + per;
    return up + per;
  }

  /** Advance a logical channel by `n` clock ticks. */
  private advanceChannel(c: PwmChannelInfo, n: number): void {
    if (n <= 0) return;
    const s = this.s;
    const mod = c.bits === 16 ? 0x10000 : 0x100;
    const k = this.ticksToPeriodEnd(c);
    if (n < k) {
      const per = this.val(s.perLat, c);
      let cnt = this.val(s.cnt, c);
      if (!this.center(c)) cnt = (cnt + n) % mod;
      else if (s.down[c.ctl]) cnt -= n;
      else {
        const up = cnt <= per ? per - cnt : mod - cnt + per;
        if (n < up) cnt = (cnt + n) % mod;
        else {
          cnt = per - (n - up);
          s.down[c.ctl] = true;
        }
      }
      this.set(s.cnt, c, cnt);
      return;
    }
    // Period end: counter to 0, up, buffers loaded; then whole periods with the new values.
    this.latch(c);
    const m = n - k;
    const per = this.val(s.perLat, c);
    if (per === 0) {
      this.set(s.cnt, c, 0);
      s.down[c.ctl] = false;
      return;
    }
    if (!this.center(c)) {
      this.set(s.cnt, c, m % per);
      s.down[c.ctl] = false;
    } else {
      const ph = m % (2 * per);
      this.set(s.cnt, c, ph <= per ? ph : 2 * per - ph);
      s.down[c.ctl] = ph >= per;
    }
  }

  private clocksRunning(): boolean {
    const s = this.s;
    return s.pwme !== 0 && !(s.waiting && s.ctl & B.PSWAI);
  }

  private advance(t: number): void {
    const s = this.s;
    if (t <= s.t) return;
    if (this.clocksRunning()) {
      for (const c of this.channels()) {
        if (!this.enabled(c)) continue;
        const n = PwmModule.ticks(this.clockOrigin(c.ctl), this.clockPeriod(c.ctl), s.t, t);
        this.advanceChannel(c, n);
      }
    }
    s.t = t;
    // A CRG bus-clock change alters every periodSeconds: re-publish on the first access/event after it.
    if (this.ctx && this.ctx.busHz !== this.lastBusHz) this.applyOutputs(t);
  }

  private restartPrescaler(t: number): void {
    this.s.preOrigin = this.s.saOrigin = this.s.sbOrigin = t;
  }

  tick(_n: number): void {
    const t = this.ctx ? this.ctx.now : this.s.t;
    this.advance(t);
    this.applyOutputs(t);
  }

  nextEventCycles(): number {
    const s = this.s;
    let best = Infinity;
    if (!this.clocksRunning()) return best;
    for (const c of this.channels()) {
      if (!this.enabled(c) || !this.pending(c)) continue;
      const k = this.ticksToPeriodEnd(c);
      const o = this.clockOrigin(c.ctl);
      const p = this.clockPeriod(c.ctl);
      const at = o + p * (Math.floor((s.t - o) / p) + k);
      if (at - s.t < best) best = at - s.t;
    }
    return best;
  }

  // ------------------------------------------------------------------ outputs

  /** Exact instantaneous level of logical channel `c`'s output (polarity, alignment, boundary cases). */
  private level(c: PwmChannelInfo): Level {
    const s = this.s;
    if (s.shutdown) return s.sdn & B.PWMLVL ? 1 : 0;
    const pol = (s.pol >> c.ctl) & 1;
    const per = this.val(s.perLat, c);
    if (per === 0) return pol as Level;
    const dty = this.val(s.dtyLat, c);
    const cnt = this.val(s.cnt, c);
    const first = this.center(c) && s.down[c.ctl] ? cnt <= dty : cnt < dty;
    return (first ? pol : pol ^ 1) as Level;
  }

  /** Instantaneous output level of physical channel `ch` (null when the output is not driven by the PWM). */
  outputLevel(ch: number): Level | null {
    this.ctx?.sync();
    const c = this.channelOf(ch);
    if (c.ctl !== ch || !this.enabled(c) || this.pp7Input(ch)) return null;
    return this.level(c);
  }

  /** Fraction of the period the output is high (polarity applied, boundary cases per Table 4-3). */
  private dutyHigh(c: PwmChannelInfo): number {
    const s = this.s;
    if (s.shutdown) return s.sdn & B.PWMLVL ? 1 : 0;
    const pol = (s.pol >> c.ctl) & 1;
    const per = this.val(s.perLat, c);
    if (per === 0) return pol;
    const f = Math.min(this.val(s.dtyLat, c), per) / per;
    return pol ? f : 1 - f;
  }

  /** Output period in bus cycles (0 when PWMPER = 0). */
  periodCycles(ch: number): number {
    const c = this.channelOf(ch);
    const per = this.val(this.s.perLat, c);
    return per * this.clockPeriod(c.ctl) * (this.center(c) ? 2 : 1);
  }

  private pp7Input(ch: number): boolean {
    return ch === 7 && (this.s.sdn & B.PWM7ENA) !== 0;
  }

  /** Current published state of a pin (convenience for tests / UI). */
  state(pin: string): PwmOutputState | undefined {
    return this.nets.pwm.get(pin);
  }

  /** Pins currently driven by the PWM ('periph' layer). */
  claimedPins(): string[] {
    return [...this.claimed.keys()];
  }

  isPinClaimed(pin: string): boolean {
    return this.claimed.has(pin);
  }

  /** Publish PwmBus states and update pin claims (cycle = time of the change). */
  private applyOutputs(cycle: number): void {
    const busHz = this.ctx ? this.ctx.busHz : 0;
    const want = new Map<string, Level>();
    const states: PwmOutputState[] = [];
    for (const c of this.channels()) {
      if (c.hi >= 0) states.push({ pin: this.pins[c.hi], enabled: false, dutyHigh: 0, periodSeconds: 0 });
      const on = this.enabled(c) && !this.pp7Input(c.ctl);
      if (!on) {
        states.push({ pin: c.pin, enabled: false, dutyHigh: 0, periodSeconds: 0 });
        continue;
      }
      const duty = this.dutyHigh(c);
      const cyc = this.periodCycles(c.ctl);
      states.push({ pin: c.pin, enabled: true, dutyHigh: duty, periodSeconds: busHz > 0 && cyc > 0 ? cyc / busHz : 0 });
      const prev = this.claimed.get(c.pin);
      // Static level at 0 % / 100 %; otherwise keep the last level (or the exact level when first claimed).
      want.set(c.pin, duty === 0 ? 0 : duty === 1 ? 1 : (prev ?? this.level(c)));
    }
    let changed = false;
    for (const pin of this.claimed.keys()) {
      if (!want.has(pin)) {
        this.nets.pins.setMcuOutput(pin, null, 'periph');
        changed = true;
      }
    }
    for (const [pin, lvl] of want) {
      if (!this.claimed.has(pin)) changed = true;
      this.nets.pins.setMcuOutput(pin, lvl, 'periph');
    }
    this.claimed = want;
    for (const st of states) {
      const key = `${st.enabled}|${st.dutyHigh}|${st.periodSeconds}`;
      if (this.published.get(st.pin) !== key) {
        this.published.set(st.pin, key);
        this.nets.pwm.publish(st, cycle);
      }
    }
    this.lastBusHz = busHz;
    if (changed) this.onPinsChanged?.();
  }

  // ------------------------------------------------------------------ emergency shutdown

  private watchPp7(): void {
    const want = (this.s.sdn & B.PWM7ENA) !== 0;
    if (want && !this.pp7Unsub) this.pp7Unsub = this.nets.pins.on(this.pins[7], () => this.onPp7());
    else if (!want && this.pp7Unsub) {
      this.pp7Unsub();
      this.pp7Unsub = null;
    }
  }

  private pp7Level(): Level {
    return this.nets.pins.read(this.pins[7]);
  }

  private pp7Active(): boolean {
    return this.pp7Level() === (this.s.sdn & B.PWM7INL ? 1 : 0);
  }

  private lastPp7Active = false;

  private onPp7(): void {
    if (!(this.s.sdn & B.PWM7ENA)) return;
    const active = this.pp7Active();
    if (active === this.lastPp7Active) return;
    this.ctx?.sync();
    this.lastPp7Active = active;
    this.s.sdn |= B.PWMIF;
    if (active) this.s.shutdown = true;
    this.applyOutputs(this.now);
    this.updateIrq();
    this.ctx?.reschedule();
  }

  private updateIrq(): void {
    if (!this.ctx) return;
    const s = this.s;
    this.ctx.setInterrupt(this.vector, (s.sdn & B.PWMIF) !== 0 && (s.sdn & B.PWMIE) !== 0);
  }

  private sdnValue(): number {
    const s = this.s;
    // PWM7IN reflects the current PP7 pin level whether or not the emergency shutdown input is enabled.
    // UNCERTAIN: a floating PP7 (nothing driving it, no pull device, PWM7ENA=0) reads 0, the documented reset value,
    // rather than the PinNet's floating convention of 1.
    const st = this.nets.pins.state(this.pins[7]);
    const floating = st.mcu === null && st.ext === null && st.pull === null;
    const in7 = (!floating || s.sdn & B.PWM7ENA) && this.pp7Level() ? B.PWM7IN : 0;
    return (s.sdn & (B.PWMIF | B.PWMIE | B.PWMLVL | B.PWM7INL | B.PWM7ENA)) | in7;
  }

  // ------------------------------------------------------------------ registers

  private regValue(off: number): number {
    const s = this.s;
    switch (off) {
      case R.PWME:
        return s.pwme;
      case R.PWMPOL:
        return s.pol;
      case R.PWMCLK:
        return s.clk;
      case R.PWMPRCLK:
        return s.prclk & 0x77;
      case R.PWMCAE:
        return s.cae;
      case R.PWMCTL:
        return s.ctl & 0xfc;
      case R.PWMSCLA:
        return s.scla;
      case R.PWMSCLB:
        return s.sclb;
      case R.PWMSDN:
        return this.sdnValue();
    }
    if (off >= R.PWMCNT0 && off < R.PWMCNT0 + 8) return s.cnt[off - R.PWMCNT0];
    if (off >= R.PWMPER0 && off < R.PWMPER0 + 8) return s.perBuf[off - R.PWMPER0];
    if (off >= R.PWMDTY0 && off < R.PWMDTY0 + 8) return s.dtyBuf[off - R.PWMDTY0];
    return 0; // PWMTST, PWMPRSC, PWMSCNTA/B (normal modes), reserved
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
    const off = a - this.base;
    switch (off) {
      case R.PWME: {
        const old = s.pwme;
        if (old === 0 && v !== 0) this.restartPrescaler(t);
        s.pwme = v;
        // A disabled channel takes buffered values at once.
        for (const c of this.channels()) if (!this.enabled(c)) this.latch(c);
        break;
      }
      case R.PWMPOL:
        s.pol = v;
        break;
      case R.PWMCLK:
        s.clk = v;
        break;
      case R.PWMPRCLK:
        s.prclk = v & 0x77;
        this.restartPrescaler(t);
        break;
      case R.PWMCAE:
        s.cae = v;
        break;
      case R.PWMCTL:
        s.ctl = v & 0xfc;
        for (const c of this.channels()) if (!this.enabled(c)) this.latch(c);
        break;
      case R.PWMSCLA:
        s.scla = v;
        s.saOrigin = t;
        break;
      case R.PWMSCLB:
        s.sclb = v;
        s.sbOrigin = t;
        break;
      case R.PWMSDN: {
        const oldEna = s.sdn & B.PWM7ENA;
        if (v & B.PWMIF) s.sdn &= ~B.PWMIF;
        s.sdn = (s.sdn & B.PWMIF) | (v & (B.PWMIE | B.PWMLVL | B.PWM7INL | B.PWM7ENA));
        this.watchPp7();
        if (s.sdn & B.PWM7ENA) {
          const active = this.pp7Active();
          if (!oldEna && active) {
            s.sdn |= B.PWMIF;
            s.shutdown = true;
          }
          this.lastPp7Active = active;
          // UNCERTAIN: restart takes effect at once instead of after the next "counter == 0".
          if (v & B.PWMRSTRT && !active) s.shutdown = false;
        } else {
          s.shutdown = false;
          this.lastPp7Active = false;
        }
        break;
      }
      default:
        if (off >= R.PWMCNT0 && off < R.PWMCNT0 + 8) {
          // Any write resets the (16-bit) counter, sets up-count and loads the buffers.
          const c = this.channelOf(off - R.PWMCNT0);
          this.set(s.cnt, c, 0);
          s.down[c.ctl] = false;
          this.latch(c);
        } else if (off >= R.PWMPER0 && off < R.PWMPER0 + 8) {
          const ch = off - R.PWMPER0;
          s.perBuf[ch] = v;
          if (!this.enabled(this.channelOf(ch))) s.perLat[ch] = v;
        } else if (off >= R.PWMDTY0 && off < R.PWMDTY0 + 8) {
          const ch = off - R.PWMDTY0;
          s.dtyBuf[ch] = v;
          if (!this.enabled(this.channelOf(ch))) s.dtyLat[ch] = v;
        } else return;
    }
    this.applyOutputs(t);
    this.updateIrq();
  }

  // ------------------------------------------------------------------ integration hooks

  /** CPU entered/left WAIT mode: with PSWAI=1 the prescaler clock stops while waiting. */
  setWaitMode(waiting: boolean): void {
    this.ctx?.sync();
    const t = this.now;
    this.advance(t);
    if (this.s.waiting && !waiting && this.s.ctl & B.PSWAI) this.restartPrescaler(t);
    this.s.waiting = waiting;
    this.ctx?.reschedule();
  }

  /** Re-publish period seconds after a bus clock change (also done automatically on the next access/event). */
  busClockChanged(): void {
    this.ctx?.sync();
    this.applyOutputs(this.now);
  }

  /** 16-bit (or 8-bit) counter value of the logical channel containing `ch` at the current cycle. */
  counter(ch: number): number {
    this.ctx?.sync();
    return this.val(this.s.cnt, this.channelOf(ch));
  }

  // ------------------------------------------------------------------ snapshot

  snapshot(): PwmSnapshot {
    const s = this.s;
    return {
      ...s,
      perBuf: [...s.perBuf],
      dtyBuf: [...s.dtyBuf],
      perLat: [...s.perLat],
      dtyLat: [...s.dtyLat],
      cnt: [...s.cnt],
      down: [...s.down],
    };
  }

  restore(state: unknown): void {
    const st = state as PwmSnapshot;
    this.s = {
      ...st,
      perBuf: [...st.perBuf],
      dtyBuf: [...st.dtyBuf],
      perLat: [...st.perLat],
      dtyLat: [...st.dtyLat],
      cnt: [...st.cnt],
      down: [...st.down],
    };
    this.watchPp7();
    this.lastPp7Active = (this.s.sdn & B.PWM7ENA) !== 0 && this.pp7Active();
    this.applyOutputs(this.s.t);
    this.updateIrq();
  }
}
