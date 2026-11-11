import { describe, expect, it } from 'vitest';
import { fixture, itFx } from '../../formats/test/fixtures';
import { readFileSync } from 'node:fs';
import { Assembler, resolveOptions } from '@s12/asm';
import { S12XSystem } from '@s12/sim';
import { ME3305_MASKS, addr, vectorByName } from '@s12/devices';
import {
  CRG_BITS,
  CRG_RANGE,
  CRG_REGS,
  CRG_VECTORS,
  Crg,
  FCTL_FLASH_GLOBAL,
  copPeriodOsc,
  copctlFromFctl,
  rtiPeriodOsc,
  type CrgOptions,
} from '../src/periph/crg';
import { addLab3Fakes } from './fakes';

const R = CRG_REGS;
const B = CRG_BITS;

/** Assemble an absolute-mode (ORG) snippet and poke it into the system. */
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

const IDLE = 0x4f00;

function rig(opts: CrgOptions = {}, setup?: (s: S12XSystem) => void) {
  const s = new S12XSystem({ ramInit: 'zero' });
  const crg = new Crg(opts);
  s.addPeripheral(crg, [CRG_RANGE]);
  setup?.(s);
  s.reset('power-on');
  s.setRegisters({ sp: 0x3f00, ccr: 0, ipl: 0 });
  load(s, ` ORG $${IDLE.toString(16)}\nidle: BRA idle\n`);
  s.setRegisters({ pc: IDLE });
  return { s, crg };
}

const rdAt = (s: S12XSystem, a: number, t: number) => s.bus.regRead(a, t);
const rd = (s: S12XSystem, a: number) => s.bus.regRead(a, s.totalCycles);
const wr = (s: S12XSystem, a: number, v: number) => s.bus.regWrite(a, v, s.totalCycles);

/** Run the idle loop for at least n bus cycles. */
function idle(s: S12XSystem, n: number): void {
  s.setRegisters({ pc: IDLE });
  s.run(n);
}

/** Wait for LOCK from the idle loop and select the PLL. */
function lockAndSelect(s: S12XSystem): void {
  idle(s, 10_000);
  expect(rd(s, R.CRGFLG) & B.LOCK).toBe(B.LOCK);
  wr(s, R.CLKSEL, B.PLLSEL);
}

describe('CRG register map', () => {
  it('range, vectors and bits come from @s12/devices', () => {
    expect(CRG_RANGE).toEqual([0x34, 0x3f]);
    expect(R).toMatchObject({ SYNR: 0x34, REFDV: 0x35, CRGFLG: 0x37, CRGINT: 0x38, CLKSEL: 0x39, PLLCTL: 0x3a, RTICTL: 0x3b, COPCTL: 0x3c, ARMCOP: 0x3f });
    expect(CRG_VECTORS).toEqual({ rti: 0xf0, lock: 0xc6, scm: 0xc4 });
    expect(vectorByName('Vcop')!.offset).toBe(0xfa);
    expect(B.PLLSEL).toBe(ME3305_MASKS.CLKSEL_PLLSEL);
    expect(B.PLLON).toBe(ME3305_MASKS.PLLCTL_PLLON);
    expect(B.AUTO).toBe(ME3305_MASKS.PLLCTL_AUTO);
    expect(B.LOCK).toBe(ME3305_MASKS.CRGFLG_LOCK);
    expect([B.RTIF, B.PORF, B.LVRF, B.LOCKIF, B.TRACK, B.SCMIF, B.SCM]).toEqual([0x80, 0x40, 0x20, 0x10, 0x04, 0x02, 0x01]);
    expect([B.RTIE, B.ILAF, B.LOCKIE, B.SCMIE]).toEqual([0x80, 0x40, 0x10, 0x02]);
    expect([B.WCOP, B.RSBCK, B.WRTMASK, B.CR, B.RTDEC]).toEqual([0x80, 0x40, 0x20, 0x07, 0x80]);
  });

  it('power-on reset values (erased flash: COP off)', () => {
    const { s } = rig();
    const regs = [R.SYNR, R.REFDV, R.CTFLG, R.CRGFLG, R.CRGINT, R.CLKSEL, R.PLLCTL, R.RTICTL, R.COPCTL, R.FORBYP, R.CTCTL, R.ARMCOP];
    expect(regs.map((a) => s.peek(a))).toEqual([0, 0, 0, 0x40, 0, 0, 0xf1, 0, 0, 0, 0, 0]);
    expect(s.busHz).toBe(8_000_000);
  });

  it('SYNR/REFDV keep 6 bits; CLKSEL/CRGINT unimplemented bits read 0; test registers ignore writes', () => {
    const { s } = rig();
    wr(s, R.SYNR, 0xff);
    wr(s, R.REFDV, 0xff);
    wr(s, R.CRGINT, 0xff);
    wr(s, R.CLKSEL, 0x7f); // PLLSEL not written
    wr(s, R.CTFLG, 0xff);
    wr(s, R.FORBYP, 0xff);
    expect([R.SYNR, R.REFDV, R.CRGINT, R.CLKSEL, R.CTFLG, R.FORBYP].map((a) => s.peek(a))).toEqual([0x3f, 0x3f, 0x92, 0x4b, 0, 0]);
  });
});

describe('CRG PLL', () => {
  it('LOCK/TRACK and LOCKIF set exactly lockTime after reset (PLLON=1 out of reset)', () => {
    const { s } = rig({ lockTimeSeconds: 300e-6 });
    const t0 = s.totalCycles;
    // 300 us * 16 MHz = 4800 OSC cycles = 2400 bus cycles at OSCCLK/2.
    expect(rdAt(s, R.CRGFLG, t0 + 2399)).toBe(0x40);
    expect(rdAt(s, R.CRGFLG, t0 + 2400)).toBe(0x40 | B.LOCKIF | B.LOCK | B.TRACK);
  });

  it('PLL start-up (SYNR=4, REFDV=7, 16 MHz oscillator) gives PLLCLK 20 MHz and a 10 MHz bus', () => {
    const { s, crg } = rig();
    const sym = load(
      s,
      ` ORG $4000
start: BCLR $39,#$80          ; CLKSEL: PLLSEL=0 while the PLL is reprogrammed
       MOVB #$04,$34          ; SYNR
       MOVB #$07,$35          ; REFDV: PLLCLK = 2 x 16 MHz x 5 / 8 = 20 MHz
       BSET $3A,#$60          ; PLLCTL: PLLON, AUTO
wait:  BRCLR $37,#$08,wait    ; CRGFLG: LOCK
       BSET $39,#$80          ; PLLSEL=1: bus = PLLCLK / 2
done:  BRA done
`,
    );
    s.setRegisters({ pc: sym.get('start')! });
    s.addBreakpoint(sym.get('done')!);
    expect(s.run(1_000_000)).toBe('breakpoint');
    expect(crg.pllHz).toBe(20_000_000);
    expect(s.busHz).toBe(10_000_000);
    expect(crg.busHz).toBe(10_000_000);
    expect(s.peek(R.CLKSEL)).toBe(0x80);
    expect(s.peek(R.PLLCTL) & 0x60).toBe(0x60);
    // locked about 300 us after the REFDV write (8 MHz bus): ~2400 cycles + a few instructions
    expect(s.cycles).toBeGreaterThan(2400);
    expect(s.cycles).toBeLessThan(2500);
  });

  itFx('Lab3 Project.abs runs Lib_Startup to main on the real CRG (fakes elsewhere): bus = 10 MHz', () => {
    const abs = new Uint8Array(readFileSync(fixture('Lab3', 'bin', 'Project.abs')));
    const s = new S12XSystem({ oscHz: 16_000_000 });
    const syms = s.loadAbs(abs).symbols;
    addLab3Fakes(s);
    const crg = new Crg();
    s.addPeripheral(crg, [CRG_RANGE]); // overrides the fake CRG
    s.reset();
    s.addBreakpoint(syms.get('main')!);
    expect(s.run(5_000_000)).toBe('breakpoint');
    expect(s.busHz).toBe(10_000_000);
    expect(crg.pllSelected).toBe(true);
    expect(s.peek(R.CRGFLG) & 0x0c).toBe(0x0c);
    expect(s.events.filter((e) => e.kind === 'peripheral')).toEqual([]);
  });

  it('PLLSEL=1 is ignored while not locked (AUTO=1); clearing PLLSEL returns to OSCCLK/2', () => {
    const { s } = rig();
    wr(s, R.CLKSEL, B.PLLSEL);
    expect(s.peek(R.CLKSEL)).toBe(0);
    expect(s.busHz).toBe(8_000_000);
    expect(s.events.some((e) => e.kind === 'peripheral' && /PLLSEL=1 ignored/.test(e.message))).toBe(true);
    lockAndSelect(s);
    expect(s.busHz).toBe(16_000_000); // SYNR=REFDV=0: PLLCLK = 2*OSC = 32 MHz
    wr(s, R.CLKSEL, 0);
    expect(s.busHz).toBe(8_000_000);
  });

  it('SYNR/REFDV/PLLON writes are ignored while PLLSEL=1', () => {
    const { s } = rig();
    lockAndSelect(s);
    wr(s, R.SYNR, 4);
    wr(s, R.REFDV, 7);
    wr(s, R.PLLCTL, 0xb1); // try PLLON=0
    expect([s.peek(R.SYNR), s.peek(R.REFDV), s.peek(R.PLLCTL)]).toEqual([0, 0, 0xf1]);
    expect(s.peek(R.CRGFLG) & B.LOCK).toBe(B.LOCK);
  });

  it('a SYNR write clears LOCK (LOCKIF set) and the PLL re-locks after lockTime; PLLON=0 unlocks', () => {
    const { s } = rig({ lockTimeSeconds: 100e-6 });
    idle(s, 2000);
    wr(s, R.CRGFLG, 0xff); // clear LOCKIF/PORF
    expect(s.peek(R.CRGFLG)).toBe(B.LOCK | B.TRACK);
    const t = s.totalCycles;
    wr(s, R.SYNR, 4);
    expect(rd(s, R.CRGFLG)).toBe(B.LOCKIF);
    wr(s, R.CRGFLG, B.LOCKIF);
    expect(rdAt(s, R.CRGFLG, t + 799)).toBe(0);
    expect(rdAt(s, R.CRGFLG, t + 800)).toBe(B.LOCKIF | B.LOCK | B.TRACK);
    const s2 = rig().s;
    idle(s2, 5000);
    wr(s2, R.CRGFLG, 0xff);
    wr(s2, R.PLLCTL, 0xb1);
    expect(rd(s2, R.CRGFLG)).toBe(B.LOCKIF);
    idle(s2, 20_000);
    expect(rd(s2, R.CRGFLG) & B.LOCK).toBe(0);
  });

  it('AUTO=0: TRACK follows ACQ and gates PLLSEL', () => {
    const { s } = rig();
    wr(s, R.PLLCTL, 0xd1); // AUTO=0, ACQ=1 (acquisition)
    idle(s, 10_000);
    expect(rd(s, R.CRGFLG) & (B.LOCK | B.TRACK)).toBe(B.LOCK);
    wr(s, R.CLKSEL, B.PLLSEL);
    expect(s.peek(R.CLKSEL)).toBe(0);
    wr(s, R.PLLCTL, 0xc1); // ACQ=0: tracking
    expect(rd(s, R.CRGFLG) & (B.LOCK | B.TRACK)).toBe(B.LOCK | B.TRACK);
    wr(s, R.CLKSEL, B.PLLSEL);
    expect(s.peek(R.CLKSEL)).toBe(B.PLLSEL);
  });

  it('the PLLSEL bus-clock switch takes effect at the write cycle, not the instruction start (sim time)', () => {
    const { s } = rig();
    idle(s, 10_000);
    const t0 = s.totalCycles;
    const tw = t0 + 7; // the CLKSEL write lands 7 cycles into an instruction that started at t0
    const atWrite = s.bus.seconds(tw); // OSCCLK/2 = 8 MHz up to the write
    s.bus.regWrite(R.CLKSEL, B.PLLSEL, tw);
    expect(s.busHz).toBe(16_000_000); // SYNR=REFDV=0: PLLCLK = 2*16 MHz*1/1 = 32 MHz, bus 16 MHz
    expect(s.bus.seconds(tw)).toBeCloseTo(atWrite, 15);
    expect(s.bus.seconds(tw + 1600)).toBeCloseTo(atWrite + 100e-6, 15);
    expect(s.bus.seconds(t0)).toBeCloseTo(atWrite - 7 / 16e6, 15);
  });

  it('PLLWAI forces AUTO=1', () => {
    const { s } = rig();
    wr(s, R.PLLCTL, 0xd1);
    wr(s, R.CLKSEL, B.PLLWAI);
    expect(s.peek(R.PLLCTL) & B.AUTO).toBe(B.AUTO);
    wr(s, R.PLLCTL, 0xd1);
    expect(s.peek(R.PLLCTL) & B.AUTO).toBe(B.AUTO);
  });

  it('LOCKIE: the lock interrupt is taken through Vcrgplllck ($FFC6)', () => {
    const { s } = rig();
    const sym = load(
      s,
      ` ORG $4000
start: MOVB #$10,$38
       CLI
loop:  BRA loop
isr:   MOVB #$10,$37
       INC $2000
       RTI
`,
    );
    s.poke(0xffc6, sym.get('isr')! >> 8);
    s.poke(0xffc7, sym.get('isr')! & 0xff);
    s.setRegisters({ pc: sym.get('start')! });
    s.run(10_000);
    expect(s.peek(0x2000)).toBe(1);
    expect(s.peek(R.CRGFLG) & B.LOCKIF).toBe(0);
  });
});

describe('CRG RTI', () => {
  it('period table: binary (RTDEC=0) and decimal (RTDEC=1) dividers', () => {
    expect(rtiPeriodOsc(0x00)).toBe(0);
    expect(rtiPeriodOsc(0x0f)).toBe(0);
    expect(rtiPeriodOsc(0x10)).toBe(1024);
    expect(rtiPeriodOsc(0x1f)).toBe(16 * 1024);
    expect(rtiPeriodOsc(0x23)).toBe(4 * 2048);
    expect(rtiPeriodOsc(0x7f)).toBe(16 * 65536);
    expect(rtiPeriodOsc(0x80)).toBe(1000);
    expect(rtiPeriodOsc(0x89)).toBe(10 * 1000);
    expect(rtiPeriodOsc(0xa0)).toBe(5000);
    expect(rtiPeriodOsc(0xff)).toBe(16 * 200000);
  });

  it('RTIF sets on the exact bus cycle (OSCCLK-based), is W1C, and an RTICTL write restarts the period', () => {
    const { s } = rig();
    const t = s.totalCycles;
    wr(s, R.RTICTL, 0x10); // 1024 OSC = 512 bus cycles at 8 MHz
    expect(rdAt(s, R.CRGFLG, t + 511) & B.RTIF).toBe(0);
    expect(rdAt(s, R.CRGFLG, t + 512) & B.RTIF).toBe(B.RTIF);
    s.bus.regWrite(R.CRGFLG, 0x7f, t + 512); // writing 0 to RTIF has no effect
    expect(rdAt(s, R.CRGFLG, t + 512) & B.RTIF).toBe(B.RTIF);
    s.bus.regWrite(R.CRGFLG, B.RTIF, t + 600);
    expect(rdAt(s, R.CRGFLG, t + 1023) & B.RTIF).toBe(0);
    expect(rdAt(s, R.CRGFLG, t + 1024) & B.RTIF).toBe(B.RTIF);
    s.bus.regWrite(R.CRGFLG, B.RTIF, t + 1100);
    s.bus.regWrite(R.RTICTL, 0x10, t + 1200); // restart
    expect(rdAt(s, R.CRGFLG, t + 1200 + 511) & B.RTIF).toBe(0);
    expect(rdAt(s, R.CRGFLG, t + 1200 + 512) & B.RTIF).toBe(B.RTIF);
  });

  it('RTI period in bus cycles follows the PLL (1024 OSC = 640 bus cycles at 10 MHz)', () => {
    const { s } = rig();
    wr(s, R.SYNR, 4);
    wr(s, R.REFDV, 7);
    lockAndSelect(s);
    expect(s.busHz).toBe(10_000_000);
    const t = s.totalCycles;
    wr(s, R.CRGFLG, B.RTIF);
    wr(s, R.RTICTL, 0x10);
    for (let k = 1; k <= 5; k++) {
      expect(rdAt(s, R.CRGFLG, t + 640 * k - 1) & B.RTIF).toBe(0);
      expect(rdAt(s, R.CRGFLG, t + 640 * k) & B.RTIF).toBe(B.RTIF);
      s.bus.regWrite(R.CRGFLG, B.RTIF, t + 640 * k);
    }
  });

  it('RTIE: periodic interrupt through Vrti ($FFF0) at the programmed rate', () => {
    const { s } = rig();
    const sym = load(
      s,
      ` ORG $4000
start: MOVB #$80,$37
       MOVB #$80,$38
       MOVB #$13,$3B
       CLI
loop:  BRA loop
isr:   MOVB #$80,$37
       INC $2000
       RTI
`,
    );
    s.poke(0xfff0, sym.get('isr')! >> 8);
    s.poke(0xfff1, sym.get('isr')! & 0xff);
    s.setRegisters({ pc: sym.get('start')! });
    // RTICTL=$13: 4 * 1024 OSC = 2048 bus cycles at 8 MHz
    s.run(2048 * 20 + 100);
    expect(s.peek(0x2000)).toBe(20);
  });
});

describe('CRG COP', () => {
  it('period table and FCTL -> COPCTL mapping (critique C7)', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(copPeriodOsc)).toEqual([0, 2 ** 14, 2 ** 16, 2 ** 18, 2 ** 20, 2 ** 22, 2 ** 23, 2 ** 24]);
    expect(copctlFromFctl(0xff)).toBe(0);
    expect(copctlFromFctl(0xfe)).toBe(1);
    expect(copctlFromFctl(0xf8)).toBe(7);
    expect(copctlFromFctl(0xf7)).toBe(0x80);
    expect(FCTL_FLASH_GLOBAL).toBe(0x7fff0e);
  });

  it('reset loads WCOP/CR from the flash configuration byte $7FFF0E', () => {
    const { s } = rig({}, (sys) => sys.pokeGlobal(FCTL_FLASH_GLOBAL, 0xf6)); // NV = 1111 0110 -> WCOP=1, CR=001
    expect(s.peek(R.COPCTL)).toBe(0x81);
    s.pokeGlobal(FCTL_FLASH_GLOBAL, 0xff);
    s.reset('external');
    expect(s.peek(R.COPCTL)).toBe(0);
  });

  function copRig(opts: CrgOptions = {}) {
    const r = rig(opts);
    const { s } = r;
    // COP reset vector -> a marker loop.
    load(s, ' ORG $4E00\ncopv: BRA copv\n');
    s.poke(0xfffa, 0x4e);
    s.poke(0xfffb, 0x00);
    return r;
  }
  const copResets = (s: S12XSystem) => s.events.filter((e) => e.kind === 'reset' && e.data?.cause === 'cop').length;

  it('time-out causes a COP reset through $FFFA (CR=1: 2^14 OSC = 8192 bus cycles)', () => {
    const { s } = copRig();
    wr(s, R.COPCTL, 0x01);
    const t = s.totalCycles;
    s.setRegisters({ pc: IDLE });
    s.run(8000);
    expect(copResets(s)).toBe(0);
    s.run(400);
    expect(copResets(s)).toBe(1);
    expect(s.registers.pc).toBe(0x4e00);
    const ev = s.events.find((e) => e.kind === 'reset')!;
    expect(ev.cycle - t).toBeGreaterThanOrEqual(8192);
    expect(ev.cycle - t).toBeLessThan(8192 + 8);
    // CR reloaded from erased flash: COP off after the reset, PORF kept clear? (PORF unaffected by COP reset)
    expect(s.peek(R.COPCTL)).toBe(0);
    expect(s.peek(R.CRGFLG) & B.PORF).toBe(B.PORF);
  });

  it('$55/$AA servicing restarts the period; $AA alone or repeated $55 do not reset', () => {
    const { s } = copRig();
    wr(s, R.COPCTL, 0x01);
    for (let k = 0; k < 5; k++) {
      idle(s, 6000);
      wr(s, R.ARMCOP, 0x55);
      wr(s, R.ARMCOP, 0x55);
      wr(s, R.ARMCOP, 0xaa);
    }
    expect(copResets(s)).toBe(0);
    idle(s, 6000);
    wr(s, R.ARMCOP, 0xaa); // no preceding $55: no restart
    idle(s, 3000);
    expect(copResets(s)).toBe(1);
  });

  it('any other ARMCOP value resets at once; ARMCOP reads 0; writes do nothing while the COP is off', () => {
    const { s } = copRig();
    wr(s, R.ARMCOP, 0x12);
    s.step();
    expect(copResets(s)).toBe(0);
    wr(s, R.COPCTL, 0x07);
    expect(s.peek(R.ARMCOP)).toBe(0);
    wr(s, R.ARMCOP, 0x12);
    s.step();
    expect(copResets(s)).toBe(1);
    expect(s.registers.pc).toBe(0x4e00);
    expect(s.events.some((e) => e.kind === 'peripheral' && /ARMCOP write of \$12/.test(e.message))).toBe(true);
  });

  it('window COP: a write in the first 75% resets, in the last 25% services', () => {
    const { s } = copRig();
    wr(s, R.COPCTL, 0x81);
    idle(s, 6300); // > 75% of 8192
    wr(s, R.ARMCOP, 0x55);
    wr(s, R.ARMCOP, 0xaa);
    s.step();
    expect(copResets(s)).toBe(0);
    idle(s, 1000); // only ~12% into the new period
    wr(s, R.ARMCOP, 0x55);
    s.step();
    expect(copResets(s)).toBe(1);
  });

  it('normal mode: COPWAI is write-once (first CLKSEL write counts), other CLKSEL bits stay writable', () => {
    const { s } = rig({ mode: 'normal' });
    wr(s, R.CLKSEL, B.COPWAI | B.RTIWAI);
    expect(s.peek(R.CLKSEL)).toBe(B.COPWAI | B.RTIWAI);
    wr(s, R.CLKSEL, B.PSTP);
    expect(s.peek(R.CLKSEL)).toBe(B.COPWAI | B.PSTP);
    const r2 = rig({ mode: 'normal' });
    wr(r2.s, R.CLKSEL, 0); // a write of 0 also uses the one write
    wr(r2.s, R.CLKSEL, B.COPWAI);
    expect(r2.s.peek(R.CLKSEL)).toBe(0);
    r2.s.reset('external'); // reset re-opens the write
    wr(r2.s, R.CLKSEL, B.COPWAI);
    expect(r2.s.peek(R.CLKSEL)).toBe(B.COPWAI);
    const sp = rig().s;
    wr(sp, R.CLKSEL, B.COPWAI);
    wr(sp, R.CLKSEL, 0);
    expect(sp.peek(R.CLKSEL)).toBe(0);
  });

  it('normal mode: WCOP/CR write-once (WRTMASK does not count), RSBCK set-only; special mode rewritable', () => {
    const { s } = rig({ mode: 'normal' });
    wr(s, R.COPCTL, 0x20 | 0x07); // WRTMASK: ignored, not counted
    expect(s.peek(R.COPCTL)).toBe(0);
    wr(s, R.COPCTL, 0x00); // CR=000 counts as the one write
    wr(s, R.COPCTL, 0x83);
    expect(s.peek(R.COPCTL)).toBe(0);
    wr(s, R.COPCTL, 0x40);
    expect(s.peek(R.COPCTL)).toBe(0x40);
    wr(s, R.COPCTL, 0x00);
    expect(s.peek(R.COPCTL)).toBe(0x40);
    const sp = rig().s;
    wr(sp, R.COPCTL, 0x43);
    wr(sp, R.COPCTL, 0x81);
    expect(sp.peek(R.COPCTL)).toBe(0x81);
  });
});

describe('CRG reset flags, clock monitor, snapshot', () => {
  it('PORF set by power-on only, W1C; ILAF set by an illegal-address reset and kept by other resets', () => {
    const { s } = rig();
    expect(s.peek(R.CRGFLG) & B.PORF).toBe(B.PORF);
    wr(s, R.CRGFLG, B.PORF);
    expect(s.peek(R.CRGFLG) & B.PORF).toBe(0);
    s.reset('external');
    expect(s.peek(R.CRGFLG) & B.PORF).toBe(0);
    s.reset('illegal-address');
    expect(s.peek(R.CRGINT)).toBe(B.ILAF);
    s.reset('external');
    expect(s.peek(R.CRGINT)).toBe(B.ILAF);
    wr(s, R.CRGINT, B.ILAF | B.RTIE);
    expect(s.peek(R.CRGINT)).toBe(B.RTIE);
    s.reset('power-on');
    expect(s.peek(R.CRGFLG) & B.PORF).toBe(B.PORF);
    expect(s.peek(R.CRGINT)).toBe(0);
  });

  it('a real illegal access sets ILAF via the CRG model', () => {
    const { s } = rig();
    // GPAGE $20:$0000 = global $200000: unimplemented on the XDP512 -> illegal access reset
    load(s, ' ORG $4100\nbad: MOVB #$20,$10\n GLDAA $0000\nhere: BRA here\n');
    s.poke(0xfffe, 0x4f);
    s.poke(0xffff, 0x00);
    s.setRegisters({ pc: 0x4100 });
    s.run(100);
    expect(s.events.some((e) => e.kind === 'illegal-access')).toBe(true);
    expect(s.peek(R.CRGINT) & B.ILAF).toBe(B.ILAF);
  });

  it('clock-monitor stub: SCME=1 enters self-clock mode, SCME=0 resets through $FFFC', () => {
    const { s, crg } = rig();
    lockAndSelect(s);
    wr(s, R.CRGINT, B.SCMIE);
    crg.simulateClockLoss();
    expect(s.peek(R.CRGFLG) & (B.SCM | B.SCMIF | B.LOCK)).toBe(B.SCM | B.SCMIF);
    expect(s.peek(R.CLKSEL) & B.PLLSEL).toBe(0);
    expect(s.busHz).toBe(1_000_000);
    expect(s.bus.xint.line[CRG_VECTORS.scm >> 1]).toBeTruthy();
    crg.simulateClockRecovery();
    expect(s.peek(R.CRGFLG) & B.SCM).toBe(0);
    expect(s.busHz).toBe(8_000_000);
    const r2 = rig();
    r2.s.poke(0xfffc, 0x4f);
    r2.s.poke(0xfffd, 0x00);
    wr(r2.s, R.PLLCTL, 0xf0); // SCME=0
    r2.crg.simulateClockLoss();
    r2.s.step();
    expect(r2.s.events.some((e) => e.kind === 'reset' && e.data?.cause === 'clock-monitor')).toBe(true);
  });

  it('SCME cannot be cleared (nor CME changed) while in self-clock mode', () => {
    const { s, crg } = rig();
    expect(s.peek(R.PLLCTL) & B.SCME).toBe(B.SCME);
    crg.simulateClockLoss();
    expect(s.peek(R.CRGFLG) & B.SCM).toBe(B.SCM);
    const before = s.peek(R.PLLCTL);
    wr(s, R.PLLCTL, before & ~(B.SCME | B.CME));
    expect(s.peek(R.PLLCTL) & (B.SCME | B.CME)).toBe(before & (B.SCME | B.CME));
    crg.simulateClockRecovery();
    wr(s, R.PLLCTL, before & ~B.SCME); // special mode, out of SCM: clearable
    expect(s.peek(R.PLLCTL) & B.SCME).toBe(0);
  });

  it('snapshot/restore round-trips PLL, RTI and COP state', () => {
    const { s } = rig();
    wr(s, R.SYNR, 4);
    wr(s, R.REFDV, 7);
    lockAndSelect(s);
    wr(s, R.RTICTL, 0x20);
    wr(s, R.COPCTL, 0x03);
    idle(s, 1000);
    const snap = s.snapshot();
    const t = s.totalCycles;
    const flagsAt = (k: number) => rdAt(s, R.CRGFLG, t + k);
    const a = [flagsAt(100), flagsAt(2000), flagsAt(5000)];
    s.restore(snap);
    expect(s.busHz).toBe(10_000_000);
    expect([flagsAt(100), flagsAt(2000), flagsAt(5000)]).toEqual(a);
    expect(s.peek(R.COPCTL)).toBe(3);
  });

  it('addr() of the CRG registers agrees with the exported constants', () => {
    for (const [n, a] of Object.entries(R)) expect(addr(n)).toBe(a);
  });
});
