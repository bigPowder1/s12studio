/**
 * Brushed DC motor + H-bridge driver (ME305: PWM magnitude on PP1, direction PA4, enable PA6, fault inputs PA5/PA7,
 * current sense on ATD1 AN0 = PAD08, shaft encoder into the LS7366R).
 *
 * Averaged sign-magnitude drive (LMD18200-style, UNCERTAIN part): V = Vsupply * duty * (PA4 ? +1 : -1) when PA6 = 1.
 * With PA6 = 0 the bridge is off and the motor coasts (current forced to 0, UNCERTAIN).
 *   L di/dt = V - R i - Ke w
 *   J dw/dt = Kt i - b w - tau_load - tau_coulomb sign(w)
 *   d(theta)/dt = w
 * Integrated lazily (to the queried bus cycle) with the exact matrix exponential of the linear system for
 * piecewise-constant inputs (unconditionally stable), in sub-steps when Coulomb friction is non-zero.
 * Every parameter is UNCERTAIN (no board documentation) and user-tunable via `configure()`.
 */
import { ME305 } from '@s12/devices';
import type { BoardNets, Level, PinNet, PwmOutputState } from '../pins.js';
import { Emitter, drivenLevel, makeBoardClock, watchDriven, type BoardClock } from './clock.js';

export interface MotorParams {
  /** Bridge supply (V). UNCERTAIN. */
  supplyVolts: number;
  /** Armature resistance (ohm). */
  resistanceOhms: number;
  /** Armature inductance (H). */
  inductanceHenries: number;
  /** Back-EMF constant (V per rad/s). */
  keVoltsPerRadPerSec: number;
  /** Torque constant (N m per A). */
  ktNmPerAmp: number;
  /** Rotor + load inertia (kg m^2). */
  inertiaKgM2: number;
  /** Viscous friction (N m per rad/s). */
  viscousNmPerRadPerSec: number;
  /** Coulomb (dry) friction magnitude (N m). */
  coulombNm: number;
  /** Constant external load torque (N m, opposing positive rotation when positive). */
  loadTorqueNm: number;
  /** Encoder lines per revolution (quadrature edges = 4 x CPR). UNCERTAIN: 500. */
  encoderCpr: number;
  /** Swap the encoder direction relative to the positive motor direction. */
  encoderInvert: boolean;
  /** Current-sense transfer (V per A). UNCERTAIN: 0.15 V/A matches the course code's current scaling. */
  senseVoltsPerAmp: number;
  /** Maximum integration sub-step (s) when Coulomb friction is non-zero. */
  maxStepSeconds: number;
}

export const DEFAULT_MOTOR_PARAMS: MotorParams = {
  supplyVolts: 12,
  resistanceOhms: 2.5,
  inductanceHenries: 1e-3,
  keVoltsPerRadPerSec: 0.02,
  ktNmPerAmp: 0.02,
  inertiaKgM2: 2e-6,
  viscousNmPerRadPerSec: 1e-6,
  coulombNm: 0,
  loadTorqueNm: 0,
  encoderCpr: 500,
  encoderInvert: false,
  senseVoltsPerAmp: 0.15,
  maxStepSeconds: 50e-6,
};

export interface MotorPins {
  pwm: string;
  dir: string;
  enable: string;
  faults: string[];
  /** ATD input carrying the current-sense voltage. */
  sense: string;
}

export interface MotorOptions {
  params: Partial<MotorParams>;
  pins: MotorPins;
  /** Level the board drives on the fault inputs (1 = no fault, UNCERTAIN); null = leave undriven. */
  faultIdleLevel: Level | null;
  /**
   * Level the driver sees on PP1/PA4/PA6 when neither the MCU nor the board drives the pin and no MCU pull device
   * is on (e.g. after reset, before the start-up pull configuration). Default 0 = bridge off (UNCERTAIN: driver input pull-downs assumed;
   * PinNet's FLOATING_LEVEL of 1 would otherwise spin the motor at full speed with nothing driving it).
   */
  undrivenLevel: Level;
  clock: BoardClock;
}

export interface MotorState {
  cycle: number;
  seconds: number;
  /** Armature current (A). */
  current: number;
  /** Shaft speed (rad/s). */
  omega: number;
  rpm: number;
  /** Shaft angle (rad, unbounded). */
  angle: number;
  /** Applied (average) terminal voltage. */
  volts: number;
  duty: number;
  direction: 1 | -1;
  enabled: boolean;
  /** Quadrature edges seen by the encoder. */
  encoderEdges: number;
  /** Current-sense voltage. */
  senseVolts: number;
}

export interface MotorSnapshot {
  i: number;
  w: number;
  th: number;
  lastSec: number;
  lastCycle: number;
  params: MotorParams;
}

// ---------------------------------------------------------------- small dense matrix helpers

type Mat = Float64Array; // row-major n x n

function matMul(a: Mat, b: Mat, n: number): Mat {
  const r = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let k = 0; k < n; k++) {
      const v = a[i * n + k];
      if (v === 0) continue;
      for (let j = 0; j < n; j++) r[i * n + j] += v * b[k * n + j];
    }
  return r;
}

/** exp(A) by scaling and squaring with a degree-14 Taylor series. */
export function expm(a: Mat, n: number): Mat {
  let norm = 0;
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.abs(a[i * n + j]);
    norm = Math.max(norm, s);
  }
  const sq = norm > 0.5 ? Math.ceil(Math.log2(norm / 0.5)) : 0;
  const scale = 2 ** -sq;
  const x = a.map((v) => v * scale) as Mat;
  const r = new Float64Array(n * n);
  let term = new Float64Array(n * n);
  for (let i = 0; i < n; i++) r[i * n + i] = term[i * n + i] = 1;
  for (let k = 1; k <= 14; k++) {
    term = matMul(term, x, n).map((v) => v / k) as Float64Array;
    for (let i = 0; i < n * n; i++) r[i] += term[i];
  }
  let out: Mat = r;
  for (let s = 0; s < sq; s++) out = matMul(out, out, n);
  return out;
}

const TWO_PI = 2 * Math.PI;

export class DcMotor {
  readonly opts: MotorOptions;
  params: MotorParams;
  /** Fired after any input (PWM, DIR, EN) change, with the state at that cycle. */
  readonly inputs = new Emitter<MotorState>();
  private readonly pins: PinNet;
  private readonly nets: BoardNets;
  private i = 0;
  private w = 0;
  private th = 0;
  private lastSec = 0;
  private lastCycle = 0;
  private v = 0;
  private en = false;
  private duty = 0;
  private dir: 1 | -1 = 1;
  private cache: { h: number; en: boolean; phi: Mat } | null = null;
  private readonly unsub: Array<() => void> = [];

  constructor(nets: BoardNets, opts: Partial<MotorOptions> = {}) {
    this.nets = nets;
    this.pins = nets.pins;
    const m = ME305.motor;
    this.opts = {
      params: opts.params ?? {},
      pins: opts.pins ?? { pwm: m.pwm, dir: m.dir, enable: m.enable, faults: m.faultInputs, sense: m.current.pin },
      faultIdleLevel: opts.faultIdleLevel === undefined ? 1 : opts.faultIdleLevel,
      undrivenLevel: opts.undrivenLevel ?? 0,
      clock: opts.clock ?? makeBoardClock(nets.pins),
    };
    this.params = { ...DEFAULT_MOTOR_PARAMS, ...this.opts.params };
    const p = this.opts.pins;
    const c = this.opts.clock;
    this.lastCycle = c.now();
    this.lastSec = c.seconds(this.lastCycle);
    const onInput = (cycle: number) => this.inputChanged(cycle);
    const u = this.opts.undrivenLevel;
    this.unsub.push(watchDriven(this.pins, p.dir, u, (_l, cyc) => onInput(cyc)));
    this.unsub.push(watchDriven(this.pins, p.enable, u, (_l, cyc) => onInput(cyc)));
    // Pin edges matter only while the PWM channel is off (GPIO level = duty); with PWM on, the PwmBus state is
    // the input (a PWM model that also toggles the pin must not cost an ODE step per edge).
    this.unsub.push(watchDriven(this.pins, p.pwm, u, (_l, cyc) => !this.pwmState()?.enabled && onInput(cyc)));
    this.unsub.push(nets.pwm.on((s, cyc) => s.pin === p.pwm && onInput(cyc)));
    nets.analog.set(p.sense, (cycle) => this.senseVolts(cycle));
    this.unsub.push(() => nets.analog.clear(p.sense));
    if (this.opts.faultIdleLevel !== null) for (const f of p.faults) this.pins.drive(f, this.opts.faultIdleLevel);
    this.readInputs();
  }

  dispose(): void {
    for (const u of this.unsub.splice(0)) u();
    if (this.opts.faultIdleLevel !== null) for (const f of this.opts.pins.faults) this.pins.drive(f, null);
  }

  /** Change parameters (integrates up to now with the old ones first). */
  configure(p: Partial<MotorParams>, cycle = this.opts.clock.now()): void {
    this.advance(cycle);
    this.params = { ...this.params, ...p };
    this.cache = null;
    this.readInputs();
  }

  setLoadTorque(nm: number, cycle = this.opts.clock.now()): void {
    this.configure({ loadTorqueNm: nm }, cycle);
  }

  /** Assert / clear a driver fault line (active low, UNCERTAIN), from outside the simulation loop. */
  setFault(pin: string, active: boolean): void {
    this.pins.externalChange([[pin, active ? 0 : 1]]);
  }

  /** Zero the mechanical/electrical state (e.g. a "board power cycle"). */
  powerOn(cycle = this.opts.clock.now()): void {
    this.i = this.w = this.th = 0;
    this.lastCycle = cycle;
    this.lastSec = this.opts.clock.seconds(cycle);
    this.readInputs();
  }

  private pwmState(): PwmOutputState | undefined {
    return this.nets.pwm.get(this.opts.pins.pwm);
  }

  /** Driver-side input level (undriven pins read `undrivenLevel`, not PinNet's floating 1). */
  private level(pin: string): Level {
    return drivenLevel(this.pins.state(pin), this.opts.undrivenLevel);
  }

  private readInputs(): void {
    const p = this.opts.pins;
    const s = this.pwmState();
    // With the PWM channel disabled the pin is plain GPIO: its static level is the duty (0 or 100 %).
    this.duty = s && s.enabled ? Math.min(1, Math.max(0, s.dutyHigh)) : this.level(p.pwm);
    this.dir = this.level(p.dir) ? 1 : -1;
    this.en = this.level(p.enable) === 1;
    this.v = this.en ? this.params.supplyVolts * this.duty * this.dir : 0;
  }

  private inputChanged(cycle: number): void {
    this.advance(cycle);
    const before = this.v;
    const enBefore = this.en;
    this.readInputs();
    if (!this.en) this.i = 0;
    if ((before !== this.v || enBefore !== this.en) && this.inputs.size) this.inputs.emit(this.state(cycle));
  }

  private matrices(h: number, en: boolean): Mat {
    const c = this.cache;
    if (c && c.h === h && c.en === en) return c.phi;
    const P = this.params;
    const n = 5;
    const m = new Float64Array(n * n);
    // x = [i, w, theta], u = [V, tau]
    if (en) {
      m[0] = -P.resistanceOhms / P.inductanceHenries;
      m[1] = -P.keVoltsPerRadPerSec / P.inductanceHenries;
      m[3] = 1 / P.inductanceHenries;
      m[5] = P.ktNmPerAmp / P.inertiaKgM2;
    }
    m[6] = -P.viscousNmPerRadPerSec / P.inertiaKgM2;
    m[9] = -1 / P.inertiaKgM2;
    m[11] = 1;
    const phi = expm(m.map((v) => v * h) as Mat, n);
    this.cache = { h, en, phi };
    return phi;
  }

  /** Integrate the ODE up to bus cycle `cycle` (no-op for past cycles). */
  advance(cycle: number): void {
    if (cycle <= this.lastCycle) return;
    const sec = this.opts.clock.seconds(cycle);
    const dt = sec - this.lastSec;
    this.lastCycle = cycle;
    this.lastSec = sec;
    if (!(dt > 0)) return;
    const P = this.params;
    const resting = this.i === 0 && this.w === 0 && this.v === 0 && P.loadTorqueNm === 0;
    if (resting) return;
    const steps = P.coulombNm > 0 ? Math.ceil(dt / P.maxStepSeconds) : 1;
    const h = dt / steps;
    for (let k = 0; k < steps; k++) this.substep(h);
  }

  private substep(h: number): void {
    const P = this.params;
    let tau = P.loadTorqueNm;
    let held = false;
    if (P.coulombNm > 0) {
      const drive = P.ktNmPerAmp * this.i - P.loadTorqueNm;
      if (this.w !== 0) tau += P.coulombNm * Math.sign(this.w);
      else if (Math.abs(drive) <= P.coulombNm) {
        // Stiction holds the shaft: friction cancels the net drive torque.
        tau += drive;
        held = true;
      } else tau += P.coulombNm * Math.sign(drive);
    }
    const phi = this.matrices(h, this.en);
    const x = [this.en ? this.i : 0, this.w, this.th, this.v, tau];
    const nx = [0, 0, 0];
    for (let r = 0; r < 3; r++) {
      let s = 0;
      for (let c = 0; c < 5; c++) s += phi[r * 5 + c] * x[c];
      nx[r] = s;
    }
    const w0 = this.w;
    this.i = this.en ? nx[0] : 0;
    this.w = nx[1];
    this.th = nx[2];
    // Dry friction cannot reverse the motion inside a step: stop at zero speed.
    if (held) {
      this.w = 0;
      this.th = x[2];
    }
    if (P.coulombNm > 0 && w0 !== 0 && Math.sign(this.w) !== Math.sign(w0)) this.w = 0;
    if (Math.abs(this.w) < 1e-12) this.w = 0;
    if (Math.abs(this.i) < 1e-15) this.i = 0;
  }

  /** Quadrature edges (4 per line) at `cycle`, for the LS7366R `positionSource`. */
  encoderEdges(cycle = this.opts.clock.now()): number {
    this.advance(cycle);
    const P = this.params;
    const e = Math.floor((this.th / TWO_PI) * P.encoderCpr * 4);
    return P.encoderInvert ? -e : e;
  }

  /** Current-sense voltage at `cycle` (|i| x scale, clamped to the ATD reference range). */
  senseVolts(cycle = this.opts.clock.now()): number {
    this.advance(cycle);
    const v = Math.abs(this.i) * this.params.senseVoltsPerAmp;
    return Math.min(this.nets.analog.vrh, Math.max(this.nets.analog.vrl, v));
  }

  state(cycle = this.opts.clock.now()): MotorState {
    this.advance(cycle);
    return {
      cycle,
      seconds: this.lastSec,
      current: this.i,
      omega: this.w,
      rpm: (this.w * 60) / TWO_PI,
      angle: this.th,
      volts: this.v,
      duty: this.duty,
      direction: this.dir,
      enabled: this.en,
      encoderEdges: this.encoderEdges(cycle),
      senseVolts: this.senseVolts(cycle),
    };
  }

  /** Steady-state no-load speed for a given terminal voltage (rad/s), for tests/UI scaling. */
  steadyOmega(volts: number): number {
    const P = this.params;
    return (P.ktNmPerAmp * volts - P.resistanceOhms * P.loadTorqueNm) /
      (P.ktNmPerAmp * P.keVoltsPerRadPerSec + P.resistanceOhms * P.viscousNmPerRadPerSec);
  }

  snapshot(cycle = this.opts.clock.now()): MotorSnapshot {
    this.advance(cycle);
    return { i: this.i, w: this.w, th: this.th, lastSec: this.lastSec, lastCycle: this.lastCycle, params: { ...this.params } };
  }

  restore(s: MotorSnapshot): void {
    this.i = s.i;
    this.w = s.w;
    this.th = s.th;
    this.lastSec = s.lastSec;
    this.lastCycle = s.lastCycle;
    this.params = { ...s.params };
    this.cache = null;
    this.readInputs();
  }
}
