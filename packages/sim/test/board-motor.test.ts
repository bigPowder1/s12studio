import { describe, it, expect } from 'vitest';
import { createBoardNets, type BoardNets } from '@s12/sim';
import { DcMotor, Leds, expm, makeBoardClock, DEFAULT_MOTOR_PARAMS } from '../src/board/index.js';
import { PortBench } from './board-helpers';

const HZ = 10e6;

function setup(params = {}) {
  const nets: BoardNets = createBoardNets();
  const bench = new PortBench(nets);
  for (let i = 0; i < 8; i++) {
    nets.pins.setPull(`PA${i}`, 'up');
    nets.pins.setPull(`PP${i}`, 'down');
  }
  const motor = new DcMotor(nets, { params, clock: makeBoardClock(nets.pins, { busHz: HZ }) });
  const pwm = (duty: number) => nets.pwm.publish({ pin: 'PP1', enabled: true, dutyHigh: duty, periodSeconds: 65e-6 }, bench.t);
  /** Motor wiring: PA4 = direction, PA6 = enable (both outputs); the drive is the PWM duty on PP1. */
  const startup = () => {
    bench.bclr('A', 0x10);
    bench.bset('A', 0x40);
    bench.setDdr('A', 0x50);
  };
  const update = (d: number) => {
    pwm(Math.min(1, Math.abs(d) / 650)); // full duty at |d| = 650 (PWM period 650 counts)
    if (d >= 0) bench.bset('A', 0x10);
    else bench.bclr('A', 0x10);
  };
  return { nets, bench, motor, pwm, startup, update };
}

describe('matrix exponential', () => {
  it('matches the scalar exponential and a rotation', () => {
    expect(expm(new Float64Array([-3]), 1)[0]).toBeCloseTo(Math.exp(-3), 12);
    const r = expm(new Float64Array([0, -Math.PI / 2, Math.PI / 2, 0]), 2);
    expect(r[0]).toBeCloseTo(0, 10);
    expect(r[2]).toBeCloseTo(1, 10);
  });
});

describe('DC motor + driver', () => {
  it('fault inputs PA5/PA7 driven high (no fault); current sense on PAD08', () => {
    const { nets, motor } = setup();
    expect(nets.pins.read('PA5')).toBe(1);
    expect(nets.pins.read('PA7')).toBe(1);
    motor.setFault('PA5', true);
    expect(nets.pins.read('PA5')).toBe(0);
    expect(nets.analog.volts('PAD08', 0)).toBe(0);
  });

  it('spin-up to the analytic steady speed; encoder edges grow; current decays to the no-load value', () => {
    const { bench, motor, startup, update } = setup();
    startup();
    update(650);
    const s0 = motor.state();
    expect(s0.volts).toBeCloseTo(12, 9);
    expect(s0.enabled).toBe(true);
    bench.wait(HZ * 0.002);
    const early = motor.state();
    expect(early.current).toBeGreaterThan(1); // inrush
    bench.wait(HZ * 0.3);
    const s = motor.state();
    const wss = motor.steadyOmega(12);
    expect(s.omega).toBeCloseTo(wss, 1);
    const P = DEFAULT_MOTOR_PARAMS;
    expect(s.current).toBeCloseTo((P.viscousNmPerRadPerSec * wss) / P.ktNmPerAmp, 3);
    const e1 = motor.encoderEdges();
    bench.wait(HZ * 0.01);
    const e2 = motor.encoderEdges();
    const expected = (wss * 0.01 * P.encoderCpr * 4) / (2 * Math.PI);
    expect(e2 - e1).toBeGreaterThan(expected * 0.99);
    expect(e2 - e1).toBeLessThan(expected * 1.01);
  });

  it('lazy integration is independent of query granularity', () => {
    const a = setup();
    const b = setup();
    for (const x of [a, b]) {
      x.startup();
      x.update(400);
    }
    for (let k = 0; k < 1000; k++) {
      a.bench.wait(100);
      a.motor.state();
    }
    b.bench.wait(100_000);
    expect(a.motor.state().angle).toBeCloseTo(b.motor.state().angle, 9);
    expect(a.motor.state().current).toBeCloseTo(b.motor.state().current, 9);
  });

  it('direction PA4=0 reverses; DISABLE (PA6=0) coasts with zero current', () => {
    const { bench, motor, startup, update } = setup();
    startup();
    update(-650);
    bench.wait(HZ * 0.1);
    expect(motor.state().omega).toBeLessThan(-100);
    expect(motor.encoderEdges()).toBeLessThan(0);
    bench.bclr('A', 0x40);
    expect(motor.state().current).toBe(0);
    const w0 = motor.state().omega;
    bench.wait(HZ * 0.05);
    const w1 = motor.state().omega;
    expect(Math.abs(w1)).toBeLessThan(Math.abs(w0));
    expect(motor.state().senseVolts).toBe(0);
  });

  it('current sense |i| x 0.15 V/A, clamped to VRH; load torque and coulomb friction', () => {
    const { bench, motor, nets, startup, update } = setup({ coulombNm: 0.002 });
    startup();
    update(650);
    bench.wait(HZ * 0.001);
    const i = motor.state().current;
    expect(nets.analog.volts('PAD08', bench.t)).toBeCloseTo(Math.min(5, Math.abs(i) * 0.15), 6);
    bench.wait(HZ * 0.3);
    const wf = motor.state().omega;
    expect(wf).toBeLessThan(motor.steadyOmega(12));
    expect(wf).toBeGreaterThan(0);
    // stiction: tiny drive does not start the motor
    update(0);
    bench.wait(HZ * 0.5);
    expect(motor.state().omega).toBe(0);
    update(1); // 12 V / 650 -> 0.0185 V -> 7.4 mA -> 0.15 mN m < 2 mN m
    bench.wait(HZ * 0.05);
    expect(motor.state().omega).toBe(0);
    motor.setLoadTorque(0.001); // below the breakaway torque: still held
    bench.wait(HZ * 0.05);
    expect(motor.state().omega).toBe(0);
    motor.setLoadTorque(-0.01); // a negative load above breakaway drives the shaft forward
    bench.wait(HZ * 0.05);
    expect(motor.state().omega).toBeGreaterThan(0);
  });

  it('PWM disabled: the static PP1 level is the duty; snapshot/restore', () => {
    const { nets, bench, motor, startup } = setup();
    startup();
    bench.bset('A', 0x10);
    nets.pwm.publish({ pin: 'PP1', enabled: false, dutyHigh: 0, periodSeconds: 0 }, bench.t);
    expect(motor.state().volts).toBe(0);
    bench.setDdr('P', 0x02);
    bench.bset('P', 0x02);
    expect(motor.state().volts).toBe(12);
    bench.wait(HZ * 0.05);
    const snap = JSON.parse(JSON.stringify(motor.snapshot()));
    const ang = motor.state().angle;
    bench.wait(HZ * 0.05);
    expect(motor.state().angle).toBeGreaterThan(ang);
    motor.restore(snap);
    expect(motor.state(snap.lastCycle).angle).toBeCloseTo(ang, 9);
  });
});

describe('LEDs PP4..PP7', () => {
  it('records on/off edges with cycle and seconds; period and duty', () => {
    const nets = createBoardNets();
    const bench = new PortBench(nets);
    for (let i = 0; i < 8; i++) nets.pins.setPull(`PP${i}`, 'down');
    const leds = new Leds(nets, { clock: makeBoardClock(nets.pins, { busHz: HZ }) });
    expect(leds.states().map((l) => [l.pin, l.color, l.pair, l.on])).toEqual([
      ['PP4', 'green', 2, false],
      ['PP5', 'red', 2, false],
      ['PP6', 'green', 1, false],
      ['PP7', 'red', 1, false],
    ]);
    bench.setDdr('P', 0xf0);
    // blink PP7 at 2 Hz (250 ms on / 250 ms off), PP4 at 25 % duty 100 ms period
    for (let k = 0; k < 4; k++) {
      bench.t = k * 5_000_000;
      bench.bset('P', 0x80, 0);
      bench.t = k * 5_000_000 + 2_500_000;
      bench.bclr('P', 0x80, 0);
    }
    for (let k = 0; k < 10; k++) {
      bench.t = 20_000_000 + k * 1_000_000;
      bench.bset('P', 0x10, 0);
      bench.t += 250_000;
      bench.bclr('P', 0x10, 0);
    }
    expect(leds.period('PP7')).toBeCloseTo(0.5, 9);
    expect(leds.dutyCycle('PP7')).toBeCloseTo(1.0 / 1.75, 9); // 4 x 250 ms on between the first and last edge
    expect(leds.period('PP4')).toBeCloseTo(0.1, 9);
    const e = leds.edges('PP4');
    expect(e).toHaveLength(20);
    expect(e[0]).toEqual({ pin: 'PP4', on: true, cycle: 20_000_000, seconds: 2 });
    expect(leds.isOn('PP5')).toBe(false);
    bench.bset('P', 0x20);
    expect(leds.isOn('PP5')).toBe(true);
    // DDR off -> pull-down -> LED off
    bench.setDdr('P', 0x00);
    expect(leds.isOn('PP5')).toBe(false);
  });
});
