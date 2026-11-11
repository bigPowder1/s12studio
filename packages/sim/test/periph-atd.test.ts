import { describe, expect, it } from 'vitest';
import { Assembler, resolveOptions } from '@s12/asm';
import { S12XSystem, createBoardNets, type BoardNets } from '@s12/sim';
import { addr, mask, registerByName } from '@s12/devices';
import { ATD_BASES, ATD_RANGES, ATD_VECTORS, AtdModule, atdDefaultPins, type AtdOptions } from '../src/periph/atd';

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
  atd: AtdModule;
  base: number;
}

function rig(opts: AtdOptions = {}): Rig {
  const s = new S12XSystem({ ramInit: 'zero' });
  const nets = createBoardNets();
  const atd = new AtdModule(nets, opts);
  s.addPeripheral(atd, [ATD_RANGES[opts.index ?? 1]]);
  s.reset();
  s.setRegisters({ sp: 0x3f00, ccr: 0, ipl: 0 });
  return { s, nets, atd, base: ATD_BASES[opts.index ?? 1] };
}

/** Register access at an explicit bus cycle (the module is brought forward to `t`). */
const rd = (s: S12XSystem, a: number, t: number) => s.bus.regRead(a, t);
const wr = (s: S12XSystem, a: number, v: number, t: number) => s.bus.regWrite(a, v, t);
const rdw = (s: S12XSystem, a: number, t: number) => (rd(s, a, t) << 8) | rd(s, a + 1, t);

// ATD1 offsets
const CTL2 = 2;
const CTL3 = 3;
const CTL4 = 4;
const CTL5 = 5;
const STAT0 = 6;
const STAT1 = 0x0b;
const DR = (n: number) => 0x10 + 2 * n;

describe('ATD register map', () => {
  it('bases, ranges, vectors and pins come from @s12/devices / the ME3305 wiring', () => {
    expect(ATD_BASES).toEqual([addr('ATD0CTL0'), addr('ATD1CTL0')]);
    expect(ATD_BASES).toEqual([0x2c0, 0x80]);
    expect(ATD_RANGES).toEqual([
      [0x2c0, 0x2df],
      [0x80, 0xaf],
    ]);
    expect(ATD_VECTORS).toEqual([0xd2, 0xd0]);
    expect(addr('ATD1DR15')).toBe(0xae);
    expect(addr('ATD0DIEN')).toBe(0x2cd);
    expect(addr('ATD1STAT2')).toBe(0x8a);
    expect(mask('ATD1CTL2', 'AFFC')).toBe(0x40);
    expect(atdDefaultPins(0)).toEqual(['PAD00', 'PAD01', 'PAD02', 'PAD03', 'PAD04', 'PAD05', 'PAD06', 'PAD07']);
    expect(atdDefaultPins(1)[0]).toBe('PAD08');
    expect(atdDefaultPins(1)[15]).toBe('PAD23');
  });

  it('reset values match the device table', () => {
    for (const index of [0, 1] as const) {
      const { s, base } = rig({ index });
      const p = `ATD${index}`;
      for (const n of ['CTL0', 'CTL1', 'CTL2', 'CTL3', 'CTL4', 'CTL5', 'STAT0', 'STAT1']) {
        const r = registerByName(p + n)!;
        expect(s.peek(r.address), p + n).toBe(r.reset);
      }
      expect(s.peek(base + 0x0f)).toBe(0xff); // PTAD: digital inputs disabled read 1
      expect(s.peek(base + 0x10)).toBe(0);
    }
  });
});

describe('ATD conversions', () => {
  it('timing: (2 + 2^(SMP+1) + bits) ATD clocks, ATD clock = bus / (2(PRS+1)); SCF at the exact cycle', () => {
    const { s, atd, base } = rig();
    wr(s, base + CTL2, 0x80, 100); // ADPU
    wr(s, base + CTL3, 0x40, 100); // S8C: 8 conversions
    wr(s, base + CTL4, 0x05, 100); // 10-bit, SMP=0, PRS=5 -> /12
    expect(atd.atdClockDivisor).toBe(12);
    expect(atd.conversionCycles).toBe(14 * 12);
    wr(s, base + CTL5, 0x00, 1000);
    expect(atd.busy).toBe(true);
    expect(rd(s, base + STAT0, 1000 + 8 * 168 - 1) & 0x80).toBe(0);
    expect(rd(s, base + STAT1, 1000 + 8 * 168 - 1)).toBe(0x7f);
    expect(rd(s, base + STAT0, 1000 + 8 * 168) & 0x80).toBe(0x80);
    expect(atd.busy).toBe(false);
    // 8-bit, SMP=3 (16 clocks), PRS=0 (/2): (2+16+8)*2 = 52
    wr(s, base + CTL4, 0xe0, 5000);
    expect(atd.conversionCycles).toBe(52);
  });

  it('conversion counter CC follows the result register being converted', () => {
    const { s, base } = rig();
    wr(s, base + CTL2, 0x80, 0);
    wr(s, base + CTL3, 0x20, 0); // 4 conversions
    wr(s, base + CTL5, 0x00, 0);
    expect(rd(s, base + STAT0, 1) & 0x0f).toBe(0);
    expect(rd(s, base + STAT0, 168) & 0x0f).toBe(1);
    expect(rd(s, base + STAT0, 3 * 168) & 0x0f).toBe(3);
    expect(rd(s, base + STAT0, 4 * 168)).toBe(0x80); // non-FIFO: back to 0 at the end
  });

  it('result formats: left/right justified, signed, 8/10-bit', () => {
    const { s, nets, base } = rig();
    nets.analog.set('PAD08', 2.5);
    wr(s, base + CTL2, 0x80, 0);
    wr(s, base + CTL3, 0x08, 0); // 1 conversion
    const conv = (ctl4: number, ctl5: number, t: number) => {
      wr(s, base + CTL4, ctl4, t);
      wr(s, base + CTL5, ctl5, t);
      return rdw(s, base + DR(0), t + 2000);
    };
    expect(conv(0x05, 0x80, 0)).toBe(512); // 10-bit right
    expect(conv(0x05, 0x00, 10_000)).toBe(512 << 6); // 10-bit left
    expect(conv(0x05, 0x40, 20_000)).toBe(0); // 10-bit left signed: mid-scale = 0
    expect(conv(0x85, 0x80, 30_000)).toBe(128); // 8-bit right
    expect(conv(0x85, 0x00, 40_000)).toBe(0x8000); // 8-bit left
    expect(conv(0x85, 0xc0, 50_000)).toBe(128); // DSGN ignored when right justified
    nets.analog.set('PAD08', 5.2);
    expect(conv(0x05, 0x80, 60_000)).toBe(1023); // clamped
    expect(conv(0x05, 0x40, 70_000)).toBe(0x7fc0); // signed full scale
    nets.analog.set('PAD08', -1);
    expect(conv(0x05, 0x40, 80_000)).toBe(0x8000);
    expect(AtdModule.code(5.1, 0, 5.12, 10)).toBe(1020); // block guide Table 3-8
    expect(AtdModule.code(0.02, 0, 5.12, 10)).toBe(4);
  });

  it('MULT walks channels from CC..CA and wraps after WRAP; single-channel repeats', () => {
    const { s, nets, base } = rig();
    for (let i = 0; i < 16; i++) nets.analog.set(`PAD${String(8 + i).padStart(2, '0')}`, (i * 5) / 16);
    const exp = (ch: number) => ch * 64;
    wr(s, base + CTL2, 0x80, 0);
    wr(s, base + CTL3, 0x20, 0); // 4 conversions
    wr(s, base + 0, 0x0e, 0); // WRAP = AN14
    wr(s, base + CTL5, 0x90 | 13, 0); // right, MULT, start at AN13
    const t = 4 * 168;
    expect([0, 1, 2, 3].map((n) => rdw(s, base + DR(n), t))).toEqual([exp(13), exp(14), exp(0), exp(1)]);
    wr(s, base + CTL5, 0x80 | 5, 10_000); // single channel AN5 x4
    const v5 = exp(5);
    expect([0, 1, 2, 3].map((n) => rdw(s, base + DR(n), 20_000))).toEqual([v5, v5, v5, v5]);
  });

  it('samples the input at the end of each sample phase', () => {
    const { s, nets, base } = rig();
    const seen: number[] = [];
    nets.analog.set('PAD08', (c) => {
      seen.push(c);
      return 1;
    });
    wr(s, base + CTL2, 0x80, 0);
    wr(s, base + CTL3, 0x10, 0); // 2 conversions
    wr(s, base + CTL5, 0x80, 1000);
    rd(s, base + STAT0, 5000);
    // sample phase = 4 ATD clocks = 48 bus cycles after each conversion start
    expect(seen).toEqual([1000 + 48, 1000 + 168 + 48]);
  });

  it('ADPU=0: no conversion; writes to CTL0-4 abort; CTL5 restarts', () => {
    const { s, atd, base } = rig();
    wr(s, base + CTL5, 0x80, 0);
    expect(atd.busy).toBe(false);
    wr(s, base + CTL2, 0x80, 10);
    wr(s, base + CTL5, 0x80, 10);
    expect(atd.busy).toBe(true);
    wr(s, base + CTL4, 0x05, 50);
    expect(atd.busy).toBe(false);
    expect(rd(s, base + STAT0, 10_000)).toBe(0);
  });

  it('ATD0 sequence length coding: 0000 and 1xxx = 8; ATD1: 0000 = 16, 1001 = 9', () => {
    const a0 = rig({ index: 0 });
    a0.s.bus.regWrite(a0.base + CTL3, 0x00, 0);
    expect(a0.atd.sequenceLength).toBe(8);
    a0.s.bus.regWrite(a0.base + CTL3, 0x48, 0);
    expect(a0.atd.sequenceLength).toBe(8);
    a0.s.bus.regWrite(a0.base + CTL3, 0x18, 0);
    expect(a0.atd.sequenceLength).toBe(3);
    const a1 = rig({ index: 1 });
    a1.s.bus.regWrite(a1.base + CTL3, 0x00, 0);
    expect(a1.atd.sequenceLength).toBe(16);
    a1.s.bus.regWrite(a1.base + CTL3, 0x48, 0);
    expect(a1.atd.sequenceLength).toBe(9);
    expect(rig({ index: 1, zeroLength: 8 }).atd.sequenceLength).toBe(4); // reset S4C
  });
});

describe('ATD flags', () => {
  function seq(r: Rig, ctl2: number, n = 4) {
    wr(r.s, r.base + CTL2, ctl2, 0);
    wr(r.s, r.base + CTL3, n << 3, 0);
    wr(r.s, r.base + CTL5, 0x80, 0);
  }

  it('AFFC=0: CCFn cleared by reading STAT1 then DRn; SCF only by writing 1 or CTL5', () => {
    const r = rig();
    seq(r, 0x80);
    const t = 10_000;
    expect(rd(r.s, r.base + STAT1, t)).toBe(0x0f);
    rd(r.s, r.base + DR(0), t);
    rd(r.s, r.base + DR(1) + 1, t); // low byte also counts as a result register read
    expect(r.s.peek(r.base + STAT1)).toBe(0x0c);
    rd(r.s, r.base + DR(2), t); // not armed again? it was armed by the same STAT1 read
    expect(r.s.peek(r.base + STAT1)).toBe(0x08);
    // DR read without a preceding STAT1 read does not clear
    wr(r.s, r.base + CTL5, 0x80, t);
    rd(r.s, r.base + DR(0), t + 5000);
    expect(r.s.peek(r.base + STAT1)).toBe(0x0f);
    expect(r.s.peek(r.base + STAT0) & 0x80).toBe(0x80);
    wr(r.s, r.base + STAT0, 0x80, t + 5000);
    expect(r.s.peek(r.base + STAT0) & 0x80).toBe(0);
  });

  it('AFFC=1: any result read clears its CCF and SCF', () => {
    const r = rig();
    seq(r, 0xc0);
    const t = 10_000;
    expect(rd(r.s, r.base + STAT0, t) & 0x80).toBe(0x80);
    rd(r.s, r.base + DR(3), t);
    expect(r.s.peek(r.base + STAT0) & 0x80).toBe(0);
    expect(r.s.peek(r.base + STAT1)).toBe(0x07);
  });

  it('FIFOR on overwrite of an unread result; FIFO mode keeps the counter running and wraps', () => {
    const r = rig();
    wr(r.s, r.base + CTL2, 0x80, 0);
    wr(r.s, r.base + CTL3, (4 << 3) | 0x04, 0); // 4 conversions, FIFO
    wr(r.s, r.base + CTL5, 0xa0, 0); // right, SCAN
    expect(rd(r.s, r.base + STAT0, 4 * 168) & 0x1f).toBe(0x04); // SCF, CC=4
    expect(rd(r.s, r.base + STAT0, 4 * 168) & 0x80).toBe(0x80);
    expect(rd(r.s, r.base + STAT1, 4 * 168)).toBe(0x0f);
    // after 16 conversions CC wrapped to 0 and nothing was overwritten yet; 17th overwrites DR0
    expect(rd(r.s, r.base + STAT0, 16 * 168) & 0x1f).toBe(0);
    expect(rd(r.s, r.base + 0x0a, 16 * 168)).toBe(0xff);
    expect(rd(r.s, r.base + STAT0, 17 * 168) & 0x10).toBe(0x10);
    wr(r.s, r.base + STAT0, 0x10, 17 * 168);
    expect(r.s.peek(r.base + STAT0) & 0x10).toBe(0);
  });

  it('long SCAN runs skip ahead consistently (same state as stepping through)', () => {
    const a = rig();
    const b = rig();
    for (const r of [a, b]) {
      r.nets.analog.set('PAD08', (c) => (c % 1000) / 200);
      wr(r.s, r.base + CTL2, 0x80, 0);
      wr(r.s, r.base + CTL3, 3 << 3, 0);
      wr(r.s, r.base + CTL5, 0xa0, 0);
    }
    for (let t = 500; t <= 1_000_000; t += 500) rd(b.s, b.base + STAT0, t);
    rd(a.s, a.base + STAT0, 1_000_000);
    const pa = a.atd.snapshot();
    const pb = b.atd.snapshot();
    expect(pa.dr).toEqual(pb.dr);
    expect(pa.ccf).toBe(pb.ccf);
    expect(pa.fifor).toBe(pb.fifor);
    expect(pa.nextDone).toBe(pb.nextDone);
    expect(pa.convIdx).toBe(pb.convIdx);
  });

  it('ASCIF mirrors SCF when ASCIE=1 and requests Vatd1; ISR clears it', () => {
    const { s, nets, base } = rig();
    nets.analog.set('PAD08', 1);
    const sym = load(
      s,
      `
ATD1CTL2 EQU $82
ATD1CTL3 EQU $83
ATD1CTL5 EQU $85
ATD1STAT0 EQU $86
ATD1DR0 EQU $90
 ORG $4000
start: MOVB #$C2,ATD1CTL2   ; ADPU AFFC ASCIE
 MOVB #$08,ATD1CTL3         ; 1 conversion
 MOVB #$80,ATD1CTL5
 CLI
loop: BRA loop
isr: LDD ATD1DR0            ; AFFC: clears SCF -> request drops
 STD $2000
 INC $2002
 MOVB #$80,ATD1CTL5         ; next conversion
 RTI
 ORG $FFD0
 DC.W isr
`,
    );
    s.setRegisters({ pc: sym.get('start')!, ccr: 0x00 });
    s.run(20_000);
    expect(s.peek(0x2000) * 256 + s.peek(0x2001)).toBe(205); // round(1/5 * 1024)
    // 20000 cycles / (168 + ISR overhead) conversions
    expect(s.peek(0x2002)).toBeGreaterThan(80);
    expect(s.peek(0x2002)).toBeLessThan(120);
    expect(base).toBe(0x80);
  });
});

describe('ATD1 polled 8-conversion sequence (the ME3305 motor current input)', () => {
  it('sums 8 right-justified samples of AN0 (PAD08) after polling SCF', () => {
    const { s, nets } = rig();
    nets.analog.set('PAD08', 0.75);
    const sym = load(
      s,
      `
ATD1CTL2 EQU $82
ATD1CTL3 EQU $83
ATD1CTL4 EQU $84
ATD1CTL5 EQU $85
ATD1STAT0 EQU $86
 ORG $4000
start: MOVB #$C0,ATD1CTL2   ; ADPU, AFFC (result reads clear the flags)
 CLR ATD1CTL3                ; 8 conversions per sequence
 MOVB #$03,ATD1CTL4          ; 10-bit, prescaler 3
 MOVB #$80,ATD1CTL5          ; right justified, single sequence on AN0
wt: BRCLR ATD1STAT0,#$80,wt
 CLRA
 CLRB
 LDX #$90
sum: ADDD 2,X+
 CPX #$A0
 BNE sum
 STD $2000
 LDAA ATD1STAT0
 STAA $2002
done: BRA done
`,
    );
    s.setRegisters({ pc: sym.get('start')! });
    s.run(20_000);
    expect(s.peek(0x2000) * 256 + s.peek(0x2001)).toBe(8 * 154); // round(0.75/5*1024) = 154
    expect(s.peek(0x2002) & 0x80).toBe(0); // SCF cleared by the AFFC reads
  });
});

describe('ATD digital inputs, external trigger, wait, snapshot', () => {
  it('PTAD reads the pin when IEN=1, else 1', () => {
    const { s, nets, base } = rig();
    nets.pins.drive('PAD08', 0);
    nets.analog.set('PAD09', 4.0);
    nets.analog.set('PAD10', 1.0);
    expect(s.peek(base + 0x0f)).toBe(0xff);
    wr(s, base + 0x0d, 0x07, 0);
    expect(s.peek(base + 0x0f)).toBe(0xfa); // AN0 driven low, AN1 4 V high, AN2 1 V low
    const r0 = rig({ index: 0 });
    r0.s.bus.regWrite(addr('ATD0DIEN'), 0x01, 0);
    r0.nets.pins.drive('PAD00', 0);
    expect(r0.s.peek(addr('ATD0PTAD0'))).toBe(0xfe);
    expect(r0.atd.digitalInputEnabled(0)).toBe(true);
    expect(r0.atd.pinDigitalLevel(0)).toBe(0);
  });

  it('edge trigger on AN channel pin starts one sequence; extra edge sets ETORF', () => {
    const { s, nets, atd, base } = rig();
    nets.pins.drive('PAD15', 0);
    wr(s, base + 1, 0x07, 0); // ETRIGSEL=0, ETRIGCH=AN7 (PAD15)
    wr(s, base + CTL3, 0x20, 0);
    wr(s, base + CTL2, 0x80 | 0x08 | 0x04, 0); // ADPU, rising edge, ETRIGE
    wr(s, base + CTL5, 0x80, 0);
    expect(atd.busy).toBe(false);
    nets.pins.externalChange([['PAD15', 1]]);
    expect(atd.busy).toBe(true);
    nets.pins.externalChange([['PAD15', 0]]);
    nets.pins.externalChange([['PAD15', 1]]);
    expect(s.peek(base + STAT0) & 0x20).toBe(0x20);
  });

  it('AWAI: conversions halt while waiting', () => {
    const { s, atd, base } = rig();
    wr(s, base + CTL2, 0xa0, 0);
    wr(s, base + CTL3, 0x08, 0);
    wr(s, base + CTL5, 0x80, 0);
    atd.setWaitMode(true);
    // time passes during WAIT (system clock moves on; module ticks without converting)
    rd(s, base + STAT0, 1000);
    atd.setWaitMode(false);
    expect(rd(s, base + STAT0, 1167) & 0x80).toBe(0);
  });

  it('snapshot/restore', () => {
    const { s, nets, atd, base } = rig();
    nets.analog.set('PAD08', 3);
    wr(s, base + CTL2, 0x80, 0);
    wr(s, base + CTL5, 0x80, 0);
    rd(s, base + STAT0, 200);
    const snap = atd.snapshot();
    rd(s, base + STAT0, 2000);
    const done = atd.snapshot();
    atd.restore(snap);
    expect(atd.busy).toBe(true);
    atd.restore(done);
    expect(atd.result(0)).toBe(AtdModule.code(3, 0, 5, 10));
  });
});
