import { describe, expect, it } from 'vitest';
import { Assembler, resolveOptions } from '@s12/asm';
import { S12XSystem, createBoardNets, type BoardNets, type PwmOutputState } from '@s12/sim';
import { addr, registerByName } from '@s12/devices';
import { PWM_BASE, PWM_RANGE, PWM_REGS, PWM_VECTOR, PwmModule, type PwmOptions } from '../src/periph/pwm';

function load(s: S12XSystem, src: string): Map<string, number> {
  const a = new Assembler({
    sourcePath: 't.asm',
    readFile: (p: string) => (p === 't.asm' ? src : undefined),
    options: resolveOptions('-CPUHCS12X').options,
    env: {},
  });
  a.run();
  const errs = a.messages.filter((m) => m.severity === 'ERROR' || m.severity === 'FATAL');
  if (errs.length) throw new Error(errs.map((m) => m.text).join('\n'));
  for (const st of a.stmts) if (st.bytes && st.section?.kind === 'org') st.bytes.forEach((b, i) => s.poke(st.loc + i, b));
  return new Map(a.symList.filter((x) => x.defined).map((x) => [x.name, x.value]));
}

interface Rig {
  s: S12XSystem;
  nets: BoardNets;
  pwm: PwmModule;
  pubs: Array<{ st: PwmOutputState; cycle: number }>;
}

function rig(opts: PwmOptions = {}): Rig {
  const s = new S12XSystem({ ramInit: 'zero' });
  const nets = createBoardNets();
  const pwm = new PwmModule(nets, opts);
  s.addPeripheral(pwm, [PWM_RANGE]);
  s.reset();
  s.setRegisters({ sp: 0x3f00, ccr: 0, ipl: 0 });
  const pubs: Rig['pubs'] = [];
  nets.pwm.on((st, cycle) => pubs.push({ st: { ...st }, cycle }));
  load(s, ' ORG $4F00\nidle: BRA idle\n');
  return { s, nets, pwm, pubs };
}

const rd = (s: S12XSystem, a: number, t: number) => s.bus.regRead(a, t);
const wr = (s: S12XSystem, a: number, v: number, t: number) => s.bus.regWrite(a, v, t);
const A = (name: string) => addr(name);

describe('PWM register map', () => {
  it('addresses, range and vector from @s12/devices', () => {
    expect(PWM_BASE).toBe(0x300);
    expect(PWM_RANGE).toEqual([0x300, 0x327]);
    expect(PWM_VECTOR).toBe(0x8c);
    expect(PWM_REGS.PWMCNT0).toBe(0x0c);
    expect(PWM_REGS.PWMPER0).toBe(0x14);
    expect(PWM_REGS.PWMDTY0).toBe(0x1c);
    expect(PWM_REGS.PWMSDN).toBe(0x24);
    expect(A('PWMDTY01')).toBe(0x31c);
  });

  it('reset values match the device table; test registers read 0', () => {
    const { s } = rig();
    for (let a = 0x300; a <= 0x324; a++) {
      const r = registerByName(
        ['PWME', 'PWMPOL', 'PWMCLK', 'PWMPRCLK', 'PWMCAE', 'PWMCTL', 'PWMTST', 'PWMPRSC', 'PWMSCLA', 'PWMSCLB', 'PWMSCNTA', 'PWMSCNTB']
          .concat([0, 1, 2, 3, 4, 5, 6, 7].map((i) => `PWMCNT${i}`))
          .concat([0, 1, 2, 3, 4, 5, 6, 7].map((i) => `PWMPER${i}`))
          .concat([0, 1, 2, 3, 4, 5, 6, 7].map((i) => `PWMDTY${i}`))
          .concat(['PWMSDN'])[a - 0x300],
      )!;
      expect(s.peek(a), r.name).toBe(r.reset);
    }
    s.poke(0x306, 0xff);
    s.poke(0x305, 0xff);
    expect(s.peek(0x306)).toBe(0);
    expect(s.peek(0x305)).toBe(0xfc);
    expect(s.peek(0x325)).toBe(0);
  });
});

describe('PWM channel timing', () => {
  it('left aligned: counter 0..PER-1 at the clock rate; duty/period published', () => {
    const { s, pwm, pubs, nets } = rig();
    wr(s, A('PWMPER0'), 4, 0);
    wr(s, A('PWMDTY0'), 1, 0);
    wr(s, A('PWMCNT0'), 0, 0);
    wr(s, A('PWME'), 0x01, 100);
    const cnt = [100, 101, 102, 103, 104, 105, 107].map((t) => rd(s, A('PWMCNT0'), t));
    expect(cnt).toEqual([0, 1, 2, 3, 0, 1, 3]);
    const st = nets.pwm.get('PP0')!;
    expect(st.enabled).toBe(true);
    expect(st.dutyHigh).toBe(0.75); // PPOL=0: (PER-DTY)/PER
    expect(st.periodSeconds).toBeCloseTo(4 / s.busHz, 15);
    expect(pubs.at(-1)!.cycle).toBe(100);
    expect(pwm.periodCycles(0)).toBe(4);
    // PPOL=1: DTY/PER
    wr(s, A('PWMPOL'), 0x01, 200);
    expect(nets.pwm.get('PP0')!.dutyHigh).toBe(0.25);
  });

  it('exact output level (outputLevel) follows the counter', () => {
    const { s, pwm } = rig();
    wr(s, A('PWMPER2'), 4, 0);
    wr(s, A('PWMDTY2'), 1, 0);
    wr(s, A('PWMPOL'), 0x04, 0);
    wr(s, A('PWME'), 0x04, 0);
    const lv: Array<number | null> = [];
    for (let t = 0; t < 8; t++) {
      rd(s, A('PWMCNT2'), t);
      lv.push((pwm as unknown as { level(c: unknown): number }).level(pwm.channelOf(2)));
    }
    expect(lv).toEqual([1, 0, 0, 0, 1, 0, 0, 0]);
  });

  it('center aligned: counts up to PER and back down; period 2*PER', () => {
    const { s, pwm, nets } = rig();
    wr(s, A('PWMCAE'), 0x02, 0);
    wr(s, A('PWMPER1'), 4, 0);
    wr(s, A('PWMDTY1'), 1, 0);
    wr(s, A('PWME'), 0x02, 0);
    const cnt: number[] = [];
    for (let t = 0; t <= 10; t++) cnt.push(rd(s, A('PWMCNT1'), t));
    expect(cnt).toEqual([0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2]);
    expect(pwm.periodCycles(1)).toBe(8);
    expect(nets.pwm.get('PP1')!.dutyHigh).toBe(0.75);
    // big jump stays consistent with stepping
    expect(rd(s, A('PWMCNT1'), 8 * 1000 + 5)).toBe(3);
  });

  it('prescaler A and scaled clock SA: SA = A / (2*SCLA), SCLA=0 means 256', () => {
    const { s, pwm } = rig();
    wr(s, A('PWMPRCLK'), 0x01, 0); // A = bus/2
    wr(s, A('PWMSCLA'), 2, 0); // SA = A/4 = bus/8
    wr(s, A('PWMCLK'), 0x01, 0);
    expect(pwm.clockPeriod(0)).toBe(8);
    wr(s, A('PWMSCLA'), 0, 0);
    expect(pwm.clockPeriod(0)).toBe(2 * 2 * 256);
    wr(s, A('PWMPRCLK'), 0x71, 0); // B = bus/128, A = bus/2
    expect(pwm.clockPeriod(2)).toBe(128);
    wr(s, A('PWMSCLA'), 2, 0);
    wr(s, A('PWMPER0'), 10, 0);
    wr(s, A('PWME'), 0x01, 1000);
    expect(rd(s, A('PWMCNT0'), 1000 + 7)).toBe(0);
    expect(rd(s, A('PWMCNT0'), 1000 + 8)).toBe(1);
    expect(rd(s, A('PWMCNT0'), 1000 + 8 * 13)).toBe(3);
  });

  it('disabled channel stops counting and resumes from PWMCNT', () => {
    const { s } = rig();
    wr(s, A('PWMPER0'), 100, 0);
    wr(s, A('PWME'), 0x01, 0);
    wr(s, A('PWME'), 0x00, 10);
    expect(rd(s, A('PWMCNT0'), 500)).toBe(10);
    wr(s, A('PWME'), 0x01, 500);
    expect(rd(s, A('PWMCNT0'), 505)).toBe(15);
  });
});

describe('PWM double buffering', () => {
  it('new PER/DTY of an enabled channel take effect at the period end (exact cycle), reads return the buffer', () => {
    const { s, nets, pubs } = rig();
    wr(s, A('PWMPER0'), 10, 0);
    wr(s, A('PWMDTY0'), 5, 0);
    wr(s, A('PWMPOL'), 0x01, 0);
    wr(s, A('PWME'), 0x01, 0);
    s.setRegisters({ pc: 0x4f00 });
    s.run(23); // counter = 3 (approximately)
    const t = s.totalCycles;
    s.bus.regWrite(A('PWMDTY0'), 2, t);
    s.bus.regWrite(A('PWMPER0'), 20, t);
    expect(s.peek(A('PWMPER0'))).toBe(20);
    expect(nets.pwm.get('PP0')!.dutyHigh).toBe(0.5);
    const periodEnd = Math.ceil((t + 1) / 10) * 10;
    s.run(60);
    const p = pubs.find((x) => x.st.pin === 'PP0' && x.st.dutyHigh === 0.1)!;
    expect(p.cycle).toBe(periodEnd);
    expect(nets.pwm.get('PP0')!.periodSeconds).toBeCloseTo(20 / s.busHz, 15);
  });

  it('writing PWMCNT resets the counter and loads the buffers at once; disabled channels write through', () => {
    const { s, nets } = rig();
    wr(s, A('PWMPER3'), 10, 0);
    wr(s, A('PWMDTY3'), 10, 0);
    wr(s, A('PWME'), 0x08, 0);
    wr(s, A('PWMDTY3'), 0, 7);
    expect(rd(s, A('PWMCNT3'), 7)).toBe(7);
    wr(s, A('PWMCNT3'), 0x55, 7);
    expect(rd(s, A('PWMCNT3'), 7)).toBe(0);
    expect(nets.pwm.get('PP3')!.dutyHigh).toBe(1); // PPOL=0, DTY=0 -> always high
    wr(s, A('PWME'), 0x00, 9);
    wr(s, A('PWMPER3'), 40, 9);
    expect(rd(s, A('PWMCNT3'), 9)).toBe(2);
  });

  it('boundary cases (Table 4-3) give static pin levels', () => {
    const { s, nets } = rig();
    wr(s, A('PWMPOL'), 0x01, 0);
    wr(s, A('PWMPER0'), 50, 0);
    wr(s, A('PWMDTY0'), 0, 0);
    wr(s, A('PWME'), 0x01, 0);
    expect(nets.pins.state('PP0')).toMatchObject({ mcu: 0, mcuLayer: 'periph' });
    wr(s, A('PWME'), 0x00, 1);
    wr(s, A('PWMDTY0'), 60, 1);
    wr(s, A('PWME'), 0x01, 1);
    expect(nets.pins.state('PP0').mcu).toBe(1);
    wr(s, A('PWME'), 0x00, 2);
    wr(s, A('PWMPER0'), 0, 2);
    wr(s, A('PWMPOL'), 0x00, 2);
    wr(s, A('PWME'), 0x01, 2);
    expect(nets.pins.state('PP0').mcu).toBe(0);
    expect(nets.pwm.get('PP0')).toMatchObject({ enabled: true, dutyHigh: 0, periodSeconds: 0 });
    expect(rd(s, A('PWMCNT0'), 100)).toBe(0); // PER=0: counter held at 0
    wr(s, A('PWME'), 0x00, 101);
    expect(nets.pins.state('PP0').mcuLayer).toBe(null);
    expect(nets.pwm.get('PP0')!.enabled).toBe(false);
  });
});

describe('PWM concatenation (16-bit PWM01 on PP1, the ME305 motor drive pin)', () => {
  it('PWM01 on PP1: period 500 bus clocks, 16-bit duty, coherent 16-bit counter reads', () => {
    const { s, nets, pwm } = rig();
    const sym = load(
      s,
      `
PWME EQU $300
PWMPOL EQU $301
PWMCLK EQU $302
PWMPRCLK EQU $303
PWMCAE EQU $304
PWMCTL EQU $305
PWMCNT01 EQU $30C
PWMPER01 EQU $314
PWMDTY01 EQU $31C
 ORG $4000
start: MOVB #$10,PWMCTL     ; CON01: channels 0+1 as one 16-bit channel (output PP1)
 BCLR PWMPRCLK,#$07          ; clock A = bus clock
 BCLR PWMCLK,#$02            ; channel 1 from clock A
 BCLR PWMCAE,#$02            ; left aligned
 BSET PWMPOL,#$02            ; high at the start of the period
 CLRW PWMDTY01
 BSET PWME,#$02
 MOVW #500,PWMPER01
 LDD #250
 STD PWMDTY01
 LDX #$FFFF          ; the first period still uses the reset PWMPER01 = $FFFF
dl: DBNE X,dl
 LDY #$2000
loop: LDD PWMCNT01
 STD 2,Y+
 CPY #$2010
 BNE loop
done: BRA done
`,
    );
    s.setRegisters({ pc: sym.get('start')! });
    s.run(3000);
    expect(nets.pwm.get('PP1')!.dutyHigh).toBe(0); // CLRW PWMDTY01 latched while disabled
    s.run(250_000);
    const st = nets.pwm.get('PP1')!;
    expect(st.enabled).toBe(true);
    expect(st.dutyHigh).toBe(0.5);
    expect(st.periodSeconds).toBeCloseTo(500 / s.busHz, 12);
    expect(nets.pwm.get('PP0')!.enabled).toBe(false);
    expect(pwm.isPinClaimed('PP1')).toBe(true);
    expect(pwm.isPinClaimed('PP0')).toBe(false);
    const samples: number[] = [];
    for (let i = 0; i < 8; i++) samples.push(s.peek(0x2000 + 2 * i) * 256 + s.peek(0x2001 + 2 * i));
    for (const v of samples) expect(v).toBeLessThan(500);
    // successive reads are a fixed number of cycles apart: differences are constant modulo 500
    const d = samples.slice(1).map((v, i) => (v - samples[i] + 500) % 500);
    expect(new Set(d).size).toBe(1);
    expect(pwm.counter(0)).toBe(pwm.counter(1));
  });

  it('16-bit PER/DTY written while disabled go straight to the latches; PWME0 has no effect', () => {
    const { s, nets } = rig();
    wr(s, A('PWMCTL'), 0x10, 0);
    wr(s, A('PWMPER0'), 0x01, 0);
    wr(s, A('PWMPER1'), 0xf4, 0);
    wr(s, A('PWMDTY0'), 0x00, 0);
    wr(s, A('PWMDTY1'), 0xfa, 0);
    wr(s, A('PWMPOL'), 0x02, 0);
    wr(s, A('PWME'), 0x01, 0);
    expect(nets.pwm.get('PP1')?.enabled ?? false).toBe(false);
    wr(s, A('PWME'), 0x02, 0);
    expect(nets.pwm.get('PP1')!.dutyHigh).toBeCloseTo(0xfa / 0x1f4, 12);
    wr(s, A('PWMCNT0'), 0, 10);
    expect(rd(s, A('PWMCNT1'), 10 + 300)).toBe(300 & 0xff);
    expect(rd(s, A('PWMCNT0'), 10 + 300)).toBe(300 >> 8);
  });
});

describe('PWM emergency shutdown, wait, bus clock, snapshot', () => {
  it('PWM7ENA: PP7 input; active level forces outputs to PWMLVL, sets PWMIF (Vpwmesdn); restart', () => {
    const { s, nets, pwm } = rig();
    nets.pins.drive('PP7', 1);
    wr(s, A('PWMPER0'), 10, 0);
    wr(s, A('PWMDTY0'), 5, 0);
    wr(s, A('PWME'), 0x81, 0);
    expect(pwm.isPinClaimed('PP7')).toBe(true);
    wr(s, A('PWMSDN'), 0x41 | 0x10, 0); // PWMIE, PWM7ENA, PWMLVL=1, active low
    expect(pwm.isPinClaimed('PP7')).toBe(false);
    expect(s.peek(A('PWMSDN'))).toBe(0x55);
    nets.pins.externalChange([['PP7', 0]]);
    expect(s.peek(A('PWMSDN')) & 0x80).toBe(0x80);
    expect(s.bus.xint.pending).toContain(PWM_VECTOR);
    expect(nets.pwm.get('PP0')!.dutyHigh).toBe(1);
    expect(nets.pins.state('PP0').mcu).toBe(1);
    // restart refused while still active
    wr(s, A('PWMSDN'), 0x80 | 0x20 | 0x51, 1);
    expect(nets.pwm.get('PP0')!.dutyHigh).toBe(1);
    expect(s.peek(A('PWMSDN')) & 0x80).toBe(0);
    nets.pins.externalChange([['PP7', 1]]);
    expect(s.peek(A('PWMSDN')) & 0x80).toBe(0x80); // passive edge flagged too
    wr(s, A('PWMSDN'), 0x80 | 0x20 | 0x51, 2);
    expect(nets.pwm.get('PP0')!.dutyHigh).toBe(0.5);
  });

  it('shutdown interrupt is taken by the CPU', () => {
    const { s, nets } = rig();
    const sym = load(
      s,
      `
 ORG $4000
start: MOVB #$41,$324
 CLI
loop: BRA loop
isr: MOVB #$80,$324
 INC $2000
 RTI
 ORG $FF8C
 DC.W isr
`,
    );
    nets.pins.drive('PP7', 1);
    s.setRegisters({ pc: sym.get('start')! });
    s.run(100);
    nets.pins.externalChange([['PP7', 0]]);
    s.run(100);
    expect(s.peek(0x2000)).toBe(1);
  });

  it('PSWAI stops the clocks during WAIT; bus clock change republishes the period', () => {
    const { s, pwm, nets } = rig();
    wr(s, A('PWMCTL'), 0x08, 0);
    wr(s, A('PWMPER0'), 100, 0);
    wr(s, A('PWME'), 0x01, 0);
    s.setRegisters({ pc: 0x4f00 });
    s.run(10);
    const c0 = pwm.counter(0);
    pwm.setWaitMode(true);
    s.run(30);
    expect(pwm.counter(0)).toBe(c0);
    pwm.setWaitMode(false);
    const before = nets.pwm.get('PP0')!.periodSeconds;
    s.bus.setBusClockHz(s.busHz * 2);
    pwm.busClockChanged();
    expect(nets.pwm.get('PP0')!.periodSeconds).toBeCloseTo(before / 2, 15);
  });

  it('snapshot/restore round-trips counters and buffers', () => {
    const { s, pwm, nets } = rig();
    wr(s, A('PWMPER0'), 10, 0);
    wr(s, A('PWME'), 0x01, 0);
    wr(s, A('PWMDTY0'), 3, 4);
    const snap = pwm.snapshot();
    wr(s, A('PWME'), 0x00, 5);
    wr(s, A('PWMPER0'), 77, 5);
    pwm.restore(snap);
    expect(s.peek(A('PWMPER0'))).toBe(10);
    expect(s.peek(A('PWMCNT0'))).toBe(4);
    expect(nets.pwm.get('PP0')!.enabled).toBe(true);
  });
});
