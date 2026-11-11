/**
 * Wiring of the full MC9S12XDP512 model (createMc9s12xdp512): register map coverage, PinNet time/sync hooks, the
 * IRQ vector-fetch hook, the flash array-write handler, MODRR -> SPI routing, SPI/SCI input pins vs GPIO drive,
 * ATD DIEN -> port AD, board clock, dispose.
 */
import { describe, expect, it } from 'vitest';
import { fixture, itFx } from '../../formats/test/fixtures';
import { readFileSync } from 'node:fs';
import { addr, DEFAULT_DEVICE } from '@s12/devices';
import { createBoardNets, createMc9s12xdp512, type Mc9s12xdp512 } from '@s12/sim';

const CODE = 0x3000;
/** Put `code` + BGND at $3000 in RAM, run it, return the cycle at which it started. */
function exec(m: Mc9s12xdp512, code: number[], ccr = 0xd0, max = 1_000_000): number {
  [...code, 0x00].forEach((b, i) => m.system.poke(CODE + i, b));
  m.system.setRegisters({ pc: CODE, sp: 0x3f00, ccr });
  const t0 = m.system.totalCycles;
  expect(m.system.run(max)).toBe('bgnd');
  return t0;
}
const movb = (v: number, a: number) => [0x18, 0x0b, v, a >> 8, a & 0xff];

describe('createMc9s12xdp512 wiring', () => {
  it('registers every module without overlap; only core (MMC/XINT/RAM-protection) registers stay unclaimed', () => {
    const m = createMc9s12xdp512({ board: 'none' });
    const owner = new Map<number, string>();
    for (const { peripheral, ranges } of m.registry)
      for (const [s, e] of ranges)
        for (let a = s; a <= e; a++) {
          expect(owner.get(a), `$${a.toString(16)} claimed by ${owner.get(a)} and ${peripheral.name}`).toBeUndefined();
          owner.set(a, peripheral.name);
        }
    const unclaimed = DEFAULT_DEVICE.registers.filter((r) => r.address < 0x800 && !owner.has(r.address)).map((r) => r.name);
    expect(unclaimed.sort()).toEqual(
      [
        'MMCCTL0', 'MODE', 'GPAGE', 'DIRECT', 'MMCCTL1', 'RPAGE', 'EPAGE', 'PARTID', 'PPAGE', 'RAMWPC', 'RAMXGU', 'RAMSHL',
        'RAMSHU', 'IVBR', 'INT_XGPRIO', 'INT_CFADDR', 'INT_CFDATA0', 'INT_CFDATA1', 'INT_CFDATA2', 'INT_CFDATA3',
        'INT_CFDATA4', 'INT_CFDATA5', 'INT_CFDATA6', 'INT_CFDATA7',
      ].sort(),
    );
    const names = m.registry.map((r) => r.peripheral.name);
    for (const n of ['CRG', 'MEBI', 'PIM', 'ECT', 'SPI0', 'SPI2', 'SCI5', 'IIC1', 'ATD0', 'ATD1', 'FTX512K4', 'VREG', 'DBG']) expect(names).toContain(n);
    expect(m.board).toBeNull();
  });

  it('comes out of reset with the device reset values (8 MHz bus, PERS/PERJ pull-ups, PLL off)', () => {
    const m = createMc9s12xdp512({ board: 'none' });
    expect(m.system.busHz).toBe(8_000_000);
    expect(m.system.peek(addr('PERS'))).toBe(0xff);
    expect(m.system.peek(addr('PERJ'))).toBe(0xf7);
    expect(m.system.peek(addr('CLKSEL'))).toBe(0);
    expect(m.nets.pins.state('PJ7').pull).toBe('up');
    expect(m.system.events).toEqual([]);
  });

  it('PinNet.now is the exact access cycle of a port write inside an instruction', () => {
    const m = createMc9s12xdp512({ board: 'me3305' });
    const seen: number[] = [];
    m.nets.pins.on('PP4', (_p, s, c) => seen.push(s.level === 1 ? c : -c));
    // MOVB #$10,DDRP (drives PP4 low: no LED edge) ; MOVB #$10,PTP
    const t0 = exec(m, [...movb(0x10, addr('DDRP')), ...movb(0x10, addr('PTP'))]);
    const rise = seen.filter((c) => c > 0);
    expect(rise).toHaveLength(1);
    // the second MOVB starts 4 cycles after the first (MOVB #,ext = 4 cycles "OPwP"): its write is cycle 2 of it
    expect(rise[0]).toBeGreaterThan(t0 + 4);
    expect(rise[0]).toBeLessThan(t0 + 8);
    const led = m.board!.leds.edges('PP4');
    expect(led.map((e) => e.cycle)).toEqual([rise[0]]);
    expect(led[0].seconds).toBeCloseTo(rise[0] / 8e6, 12);
  });

  it('external pin changes sync the peripherals first (key wakeup flag at the exact cycle) and raise the interrupt', () => {
    const m = createMc9s12xdp512({ board: 'none' });
    m.system.poke(addr('PPSJ'), 0x80); // rising edge on PJ7
    m.system.poke(addr('PIEJ'), 0x80);
    m.system.run(1000);
    m.nets.pins.externalChange([['PJ7', 0]]);
    expect(m.system.peek(addr('PIFJ')) & 0x80).toBe(0);
    m.nets.pins.externalChange([['PJ7', 1]]);
    expect(m.system.peek(addr('PIFJ')) & 0x80).toBe(0x80);
    expect(m.system.bus.xint.pending).toContain(0xce); // Vportj
  });

  it('IRQ edge mode: a short PE1 pulse while I=1 is latched until the vector fetch (onVectorTaken wired)', () => {
    const m = createMc9s12xdp512({ board: 'none' });
    const ISR = 0x3100;
    // ISR: INC $2100 ; RTI
    [0x72, 0x21, 0x00, 0x0b].forEach((b, i) => m.system.poke(ISR + i, b));
    m.system.poke(0xfff2, ISR >> 8);
    m.system.poke(0xfff3, ISR & 0xff);
    m.system.poke(0x2100, 0);
    m.system.poke(addr('IRQCR'), 0xc0); // IRQE (falling edge) | IRQEN
    m.nets.pins.externalChange([['PE1', 0]]);
    m.system.run(100);
    m.nets.pins.externalChange([['PE1', 1]]); // pulse over before the CPU unmasks
    // CLI ; NOP x4 ; BGND
    exec(m, [0x10, 0xef, 0xa7, 0xa7, 0xa7, 0xa7], 0xd0);
    expect(m.system.peek(0x2100)).toBe(1);
    // taken exactly once: the vector fetch cleared the latch
    exec(m, [0x10, 0xef, 0xa7, 0xa7], 0xd0);
    expect(m.system.peek(0x2100)).toBe(1);
  });

  it('CPU writes to the flash array go to the FTX512K4 command controller (program a word)', () => {
    const m = createMc9s12xdp512({ board: 'none' });
    expect(m.system.peekGlobal(0x7f4100)).toBe(0xff);
    const F = addr('FCLKDIV');
    exec(m, [
      ...movb(0x49, F), // FCLKDIV: PRDIV8, FDIV=9 (16 MHz osc -> ~190 kHz)
      ...movb(0x30, F + 5), // FSTAT: clear PVIOL/ACCERR
      0xcc, 0x12, 0x34, // LDD #$1234
      0x7c, 0x41, 0x00, // STD $4100 (flash page $FD -> global $7F4100)
      ...movb(0x20, F + 6), // FCMD = program
      ...movb(0x80, F + 5), // FSTAT = CBEIF: launch
      0x1f, F >> 8, (F + 5) & 0xff, 0x40, 0xfb, // BRCLR FSTAT,#CCIF,*
    ]);
    expect(m.system.peekGlobal(0x7f4100)).toBe(0x12);
    expect(m.system.peekGlobal(0x7f4101)).toBe(0x34);
    expect(m.system.peek(F + 5) & 0x30).toBe(0);
    expect(m.system.events.filter((e) => e.kind === 'rom-write')).toEqual([]);
  });

  it('MODRR reroutes SPI0 (port S -> port M); SPI input pins disconnect the GPIO output driver', () => {
    const m = createMc9s12xdp512({ board: 'none' });
    const pins = m.nets.pins;
    m.system.poke(addr('DDRS'), 0xff);
    m.system.poke(addr('PTS'), 0x00);
    expect(pins.mcuOutput('PS4')).toBe(0);
    m.system.poke(addr('SPI0CR1'), 0x50); // SPE | MSTR
    const claim = () => m.periph.spi0.claimedPins().map((c) => `${c.role}:${c.pin}:${c.dir}`).sort();
    expect(claim()).toContain('miso:PS4:in');
    expect(pins.mcuOutput('PS4')).toBeNull(); // MISO is an input although DDRS4 = 1
    m.system.poke(addr('MODRR'), 0x10);
    expect(claim()).toContain('miso:PM2:in');
    expect(pins.mcuOutput('PS4')).toBe(0); // back to GPIO
    m.system.poke(addr('SPI0CR1'), 0x00);
    expect(m.periph.spi0.claimedPins()).toEqual([]);
  });

  it('ATD DIEN bits enable the port AD digital inputs seen through the PIM', () => {
    const m = createMc9s12xdp512({ board: 'none' });
    m.nets.pins.externalChange([['PAD00', 0], ['PAD09', 0]]);
    expect(m.system.peek(addr('PT1AD0')) & 1).toBe(1); // input buffer disabled: reads 1
    m.system.poke(addr('ATD0DIEN'), 0x01);
    expect(m.system.peek(addr('PT1AD0')) & 1).toBe(0);
    expect(m.system.peek(addr('PT1AD1')) & 2).toBe(2);
    m.system.poke(addr('ATD1DIEN1'), 0x02); // ATD1 AN1 = PAD09
    expect(m.system.peek(addr('PT1AD1')) & 2).toBe(0);
  });

  itFx('runSeconds integrates across the PLL switch; board time = system time', () => {
    const m = createMc9s12xdp512({ board: 'me3305' });
    m.loadAbs(new Uint8Array(readFileSync(fixture('blank_project', 'bin', 'Project.abs'))));
    expect(m.system.busHz).toBe(8_000_000);
    expect(m.runSeconds(0.01)).toBe('limit');
    expect(m.system.busHz).toBe(10_000_000);
    expect(m.system.simTimeSeconds).toBeGreaterThanOrEqual(0.01);
    expect(m.system.simTimeSeconds).toBeLessThan(0.0101);
    // fewer cycles than 10 ms at 10 MHz: the first ~0.3 ms ran at 8 MHz
    expect(m.system.totalCycles).toBeLessThan(100_000);
    expect(m.system.totalCycles).toBeGreaterThan(99_000);
    expect(m.board!.clock.seconds(m.system.totalCycles)).toBe(m.system.simTimeSeconds);
    expect(m.now()).toBe(m.system.totalCycles);
  });

  it('dispose detaches the board and the pin listeners from shared nets', () => {
    const nets = createBoardNets();
    const a = createMc9s12xdp512({ nets, board: 'me3305' });
    a.dispose();
    const b = createMc9s12xdp512({ nets, board: 'me3305' });
    b.system.poke(addr('DDRP'), 0x10);
    b.system.poke(addr('PTP'), 0x10);
    expect(a.board!.leds.edgeCount).toBe(0);
    expect(b.board!.leds.edgeCount).toBe(1);
  });
});
