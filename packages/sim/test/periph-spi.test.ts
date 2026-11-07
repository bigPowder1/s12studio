import { describe, expect, it } from 'vitest';
import { Assembler, resolveOptions } from '@s12/asm';
import { S12XSystem, createBoardNets, type BoardNets, type SpiSlave } from '@s12/sim';
import { addr, mask } from '@s12/devices';
import { SPI_BASES, SPI_RANGES, SPI_VECTORS, SpiModule, type SpiOptions } from '../src/periph/spi';

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

interface Rig {
  s: S12XSystem;
  nets: BoardNets;
  spi: SpiModule;
  log: Array<{ mosi: number; cycle: number; mode: { cpol: number; cpha: number; lsbFirst: boolean } }>;
}

function rig(opts: SpiOptions = {}, respond: (m: number) => number = (m) => ~m & 0xff, selected = () => true): Rig {
  const s = new S12XSystem({ ramInit: 'zero' });
  const nets = createBoardNets();
  const spi = new SpiModule(nets, opts);
  s.addPeripheral(spi, [SPI_RANGES[opts.index ?? 0]]);
  s.reset();
  s.setRegisters({ sp: 0x3f00, ccr: 0, ipl: 0 });
  const log: Rig['log'] = [];
  const slave: SpiSlave = {
    name: 'probe',
    selected,
    exchange: (mosi, cycle, mode) => {
      log.push({ mosi, cycle, mode: { ...mode } });
      return respond(mosi);
    },
  };
  nets.spi[`SPI${opts.index ?? 0}` as 'SPI0'].attach(slave);
  // Idle loop for advancing time without touching the SPI.
  load(s, ' ORG $4F00\nidle: BRA idle\n');
  return { s, nets, spi, log };
}

/** Let `n` bus cycles (at least) pass with the CPU spinning in an idle loop. */
function wait(s: S12XSystem, n: number): void {
  s.setRegisters({ pc: 0x4f00 });
  s.run(n);
}
const rd = (s: S12XSystem, a: number) => s.bus.regRead(a, s.totalCycles);
const wr = (s: S12XSystem, a: number, v: number) => s.bus.regWrite(a, v, s.totalCycles);

const CR1 = 0xd8;
const CR2 = 0xd9;
const BR = 0xda;
const SR = 0xdb;
const DR = 0xdd;

describe('SPI register map', () => {
  it('bases, ranges, vectors and bits come from @s12/devices', () => {
    expect(SPI_BASES).toEqual([addr('SPI0CR1'), addr('SPI1CR1'), addr('SPI2CR1')]);
    expect(SPI_BASES).toEqual([0xd8, 0xf0, 0xf8]);
    expect(SPI_RANGES[0]).toEqual([0xd8, 0xdf]);
    expect(addr('SPI0DR')).toBe(0xdd);
    expect(SPI_VECTORS).toEqual([0xd8, 0xbe, 0xbc]);
    expect(mask('SPI0SR', 'SPTEF')).toBe(0x20);
  });

  it('reset values; reserved and write-only bits read 0; SPISR is read-only', () => {
    const { s } = rig();
    expect([CR1, CR2, BR, SR, 0xdc, DR, 0xde, 0xdf].map((a) => s.peek(a))).toEqual([0x04, 0, 0, 0x20, 0, 0, 0, 0]);
    s.poke(CR2, 0xff);
    s.poke(BR, 0xff);
    s.poke(SR, 0xff);
    expect([s.peek(CR2), s.peek(BR), s.peek(SR)]).toEqual([0x1b, 0x77, 0x20]);
  });

  it('baud divisor = (SPPR+1) * 2^(SPR+1); a byte takes 8 SCK periods', () => {
    const { s, spi } = rig();
    const div = (br: number) => {
      s.poke(BR, br);
      return spi.divisor;
    };
    expect(div(0x00)).toBe(2);
    expect(div(0x50)).toBe(12);
    expect(div(0x07)).toBe(256);
    expect(div(0x77)).toBe(2048);
    s.poke(BR, 0x50);
    expect(spi.transferCycles).toBe(96);
    expect(spi.baudHz).toBeCloseTo(8_000_000 / 12);
  });
});

describe('SPI master transfers (polled, mode 0, bus/12)', () => {
  const prog = `
 ORG $4000
 MOVB #$50,$D8     ; SPE | MSTR, mode 0
 CLR  $D9
 MOVB #$50,$DA     ; SPI0BR = $50 -> bus/12
 LDAA #$A5
 JSR  XFER
 STAB $2000
 LDAA #$3C
 JSR  XFER
 STAB $2001
 BGND
XFER: BRCLR $DB,#$20,XFER
 STAA $DD
W2:  BRCLR $DB,#$80,W2
 LDAB $DD
 RTS
`;
  it('exchanges bytes on SpiBus 96 bus cycles after the SPIDR write and clears SPIF on SR+DR reads', () => {
    const { s, log } = rig();
    load(s, prog);
    const writes: number[] = [];
    s.setTracer((acc, local, _g, _v, cycle) => {
      if (acc === 'write' && local === DR) writes.push(cycle);
    });
    s.setRegisters({ pc: 0x4000 });
    expect(s.run(100_000)).toBe('bgnd');
    expect([s.peek(0x2000), s.peek(0x2001)]).toEqual([0x5a, 0xc3]);
    expect(log.map((l) => l.mosi)).toEqual([0xa5, 0x3c]);
    expect(log[0].mode).toEqual({ cpol: 0, cpha: 0, lsbFirst: false });
    expect(writes.length).toBe(2);
    expect(log[0].cycle - writes[0]).toBe(96);
    expect(log[1].cycle - writes[1]).toBe(96);
    // flags after the last DR read: SPIF clear, SPTEF set
    expect(s.peek(SR)).toBe(0x20);
  });

  it('startDelayCycles adds a fixed latency', () => {
    const { s, log } = rig({ startDelayCycles: 10 });
    load(s, prog);
    const writes: number[] = [];
    s.setTracer((acc, local, _g, _v, cycle) => acc === 'write' && local === DR && writes.push(cycle));
    s.setRegisters({ pc: 0x4000 });
    expect(s.run(100_000)).toBe('bgnd');
    expect(log[0].cycle - writes[0]).toBe(106);
  });

  it('SPTEF sets again when the byte enters the shifter; a buffered byte follows back-to-back', () => {
    const { s, log } = rig();
    wr(s, CR1, 0x50);
    wr(s, BR, 0x50);
    expect(rd(s, SR)).toBe(0x20);
    const t0 = s.totalCycles;
    wr(s, DR, 0x11);
    expect(s.peek(SR) & 0x20).toBe(0x20); // moved to the shifter at once
    expect(rd(s, SR)).toBe(0x20);
    wr(s, DR, 0x22); // buffered
    expect(s.peek(SR)).toBe(0x00);
    wait(s, 300);
    expect(log.map((l) => [l.mosi, l.cycle - t0])).toEqual([
      [0x11, 96],
      [0x22, 192],
    ]);
  });

  it('a write to SPIDR without reading SPTEF=1 first is ignored (with a warning)', () => {
    const { s, log } = rig();
    wr(s, CR1, 0x50);
    wr(s, DR, 0x77);
    wait(s, 200);
    expect(log.length).toBe(0);
    expect(s.events.some((e) => e.kind === 'peripheral' && /SPI0DR ignored/.test(e.message))).toBe(true);
  });

  it('SPIF needs the SR read before the DR read', () => {
    const { s } = rig();
    wr(s, CR1, 0x50);
    rd(s, SR);
    wr(s, DR, 0x01);
    wait(s, 100);
    expect(s.peek(SR)).toBe(0xa0);
    expect(rd(s, DR)).toBe(0xfe);
    expect(s.peek(SR)).toBe(0xa0); // still set
    rd(s, SR);
    rd(s, DR);
    expect(s.peek(SR)).toBe(0x20);
  });

  it('receive overrun: second byte waits in the shift register; lost once a third transfer starts', () => {
    let n = 0;
    const { s } = rig({}, () => 0x10 + n++);
    wr(s, CR1, 0x50);
    rd(s, SR);
    wr(s, DR, 0xaa);
    rd(s, SR);
    wr(s, DR, 0xbb);
    wait(s, 400);
    // SPIF set by the first byte, second kept in the shift register
    rd(s, SR);
    expect(rd(s, DR)).toBe(0x10);
    expect(s.peek(SR) & 0x80).toBe(0x80); // SPIF stays set: second byte moved in
    rd(s, SR);
    expect(rd(s, DR)).toBe(0x11);
    expect(s.peek(SR) & 0x80).toBe(0);
    // Now: two transfers without servicing, then start a third before servicing
    rd(s, SR);
    wr(s, DR, 1);
    rd(s, SR);
    wr(s, DR, 2);
    wait(s, 400); // 0x12 in SPIDR, 0x13 pending
    rd(s, SR);
    wr(s, DR, 3); // third transmission starts -> pending invalid
    rd(s, SR);
    expect(rd(s, DR)).toBe(0x12);
    expect(s.peek(SR) & 0x80).toBe(0); // 0x13 lost
    wait(s, 200);
    rd(s, SR);
    expect(rd(s, DR)).toBe(0x14);
  });

  it('clearing SPE aborts the transfer and resets SPISR', () => {
    const { s, log } = rig();
    wr(s, BR, 0x50);
    wr(s, CR1, 0x50);
    rd(s, SR);
    wr(s, DR, 0x55);
    wait(s, 30);
    wr(s, CR1, 0x10);
    wait(s, 200);
    expect(log.length).toBe(0);
    expect(s.peek(SR)).toBe(0x20);
    expect(s.peek(CR1)).toBe(0x10);
  });

  it('passes CPOL/CPHA/LSBFE to the slaves', () => {
    const { s, log } = rig();
    wr(s, CR1, 0x5d); // SPE MSTR CPOL CPHA LSBFE
    rd(s, SR);
    wr(s, DR, 0x80);
    wait(s, 100);
    expect(log[0].mode).toEqual({ cpol: 1, cpha: 1, lsbFirst: true });
  });

  it('snapshot/restore mid-transfer replays the same completion', () => {
    const { s, log } = rig();
    wr(s, BR, 0x50);
    wr(s, CR1, 0x50);
    rd(s, SR);
    wr(s, DR, 0x42);
    wait(s, 40);
    const snap = s.snapshot();
    wait(s, 100);
    const first = log.map((l) => l.cycle);
    s.restore(snap);
    wait(s, 100);
    expect(log.length).toBe(2);
    expect(log[1].cycle).toBe(first[0]);
    expect(s.peek(SR)).toBe(0xa0);
  });
});

describe('SPI interrupts', () => {
  it('SPIE raises Vspi0 at transfer completion; the ISR clears SPIF', () => {
    const { s } = rig();
    load(
      s,
      `
 ORG $4000
 MOVB #$D0,$D8    ; SPIE SPE MSTR
 MOVB #$50,$DA
 CLI
 LDAA $DB
 MOVB #$99,$DD
loop: BRA loop
 ORG $4200
isr: LDAA $DB
 LDAA $DD
 STAA $2002
 INC  $2003
 RTI
 ORG $FFD8
 DC.W isr
`,
    );
    s.setRegisters({ pc: 0x4000 });
    s.run(2000);
    expect(s.peek(0x2003)).toBe(1);
    expect(s.peek(0x2002)).toBe(0x66);
  });

  it('SPTIE requests while SPTEF is set (only when SPE=1)', () => {
    const { s } = rig();
    const line = () => s.bus.xint.line[0xd8 >> 1];
    wr(s, CR1, 0x20); // SPTIE, SPE=0
    expect(line()).toBe(0);
    wr(s, CR1, 0x70); // SPTIE SPE MSTR
    expect(line()).toBe(1);
    rd(s, SR);
    wr(s, DR, 0x01); // SPTEF set again at once (byte moved to the shifter)
    expect(line()).toBe(1);
    rd(s, SR);
    wr(s, DR, 0x02); // buffered: SPTEF=0
    expect(line()).toBe(0);
    wr(s, CR1, 0x50);
    expect(line()).toBe(0);
  });
});

describe('SPI pins and slave select', () => {
  it('claims PS4-PS7 when enabled (SCK idles at CPOL); releases when disabled', () => {
    const { s, nets, spi } = rig();
    expect(spi.claimedPins()).toEqual([]);
    wr(s, CR1, 0x58); // SPE MSTR CPOL
    expect(nets.pins.state('PS6')).toMatchObject({ mcu: 1, mcuLayer: 'periph' });
    expect(nets.pins.state('PS5').mcuLayer).toBe('periph');
    expect(spi.isPinClaimed('PS4')).toBe(true);
    expect(spi.isPinClaimed('PS7')).toBe(false); // MODFEN=0: SS is GPIO
    wr(s, CR1, 0x00);
    expect(nets.pins.state('PS6').mcu).toBeNull();
    expect(spi.claimedPins()).toEqual([]);
  });

  it('MODRR routes SPI0 to port M and SPI1 to port H', () => {
    let modrr = 0;
    const { s, nets, spi } = rig({ modrr: () => modrr });
    wr(s, CR1, 0x50);
    modrr = 0x10;
    spi.routingChanged();
    expect(nets.pins.state('PS6').mcu).toBeNull();
    expect(nets.pins.state('PM5').mcuLayer).toBe('periph');
    expect(spi.pins).toEqual({ miso: 'PM2', mosi: 'PM4', sck: 'PM5', ss: 'PM3' });
    const s1 = new SpiModule(createBoardNets(), { index: 1, modrr: () => 0x20 });
    expect(s1.pins).toEqual({ miso: 'PH0', mosi: 'PH1', sck: 'PH2', ss: 'PH3' });
  });

  it('SSOE=1, MODFEN=1: SS is driven low for the duration of each transfer', () => {
    let nets!: BoardNets;
    const r = rig({}, (m) => m, () => nets.pins.read('PS7') === 0);
    nets = r.nets;
    const { s, log } = r;
    const levels: number[] = [];
    nets.pins.on('PS7', (_p, st) => levels.push(st.level));
    wr(s, CR2, 0x10);
    wr(s, CR1, 0x52);
    expect(nets.pins.read('PS7')).toBe(1);
    rd(s, SR);
    wr(s, DR, 0x33);
    expect(nets.pins.read('PS7')).toBe(0);
    wait(s, 200);
    expect(nets.pins.read('PS7')).toBe(1);
    expect(log.map((l) => l.mosi)).toEqual([0x33]); // slave saw SS low at the exchange
    expect(levels).toEqual([1, 0, 1]);
  });

  it('automatic SS between back-to-back bytes: deasserted with CPHA=0, held low with CPHA=1 (regression)', () => {
    for (const [cr1, expected] of [
      [0x52, [1, 0, 1, 0, 1]], // CPHA=0: (zero-width) deselect between the two bytes
      [0x56, [1, 0, 1]], // CPHA=1: SS stays low across back-to-back bytes
    ] as const) {
      const r = rig({}, (m) => m, () => r.nets.pins.read('PS7') === 0);
      const { s, nets, log } = r;
      const levels: number[] = [];
      nets.pins.on('PS7', (_p, st) => levels.push(st.level));
      wr(s, BR, 0x50);
      wr(s, CR2, 0x10);
      wr(s, CR1, cr1);
      rd(s, SR);
      wr(s, DR, 0x11);
      rd(s, SR);
      wr(s, DR, 0x22); // buffered: starts at the completion cycle of 0x11
      wait(s, 300);
      expect(log.map((l) => l.mosi)).toEqual([0x11, 0x22]);
      expect(levels).toEqual(expected);
      expect(nets.pins.read('PS7')).toBe(1);
    }
  });

  it('mode fault ignores the port own stale GPIO drive on SS (DDRS7=1, PTS7=0) (regression)', () => {
    const { s, nets, log } = rig();
    nets.pins.setMcuOutput('PS7', 0, 'gpio'); // PIM still driving PS7 low as a GPIO output
    wr(s, BR, 0x50);
    wr(s, CR2, 0x10);
    wr(s, CR1, 0x50); // SPE MSTR, MODFEN=1 SSOE=0: SS becomes the mode-fault input
    expect(s.peek(SR)).toBe(0x20);
    expect(s.peek(CR1)).toBe(0x50);
    rd(s, SR);
    wr(s, DR, 0x01);
    wait(s, 200);
    expect(log.map((l) => l.mosi)).toEqual([0x01]);
    // An external device pulling SS low still faults.
    nets.pins.externalChange([['PS7', 0]]);
    expect(s.peek(SR) & 0x10).toBe(0x10);
    expect(s.peek(CR1) & 0x10).toBe(0);
  });

  it('mode fault: MODFEN=1, SSOE=0 and SS driven low sets MODF and drops to slave mode', () => {
    const { s, nets, log } = rig();
    wr(s, BR, 0x50);
    wr(s, CR2, 0x10);
    wr(s, CR1, 0xd0); // SPIE SPE MSTR
    rd(s, SR);
    wr(s, DR, 0x01);
    wait(s, 20);
    nets.pins.externalChange([['PS7', 0]]);
    expect(s.peek(SR) & 0x10).toBe(0x10);
    expect(s.peek(CR1)).toBe(0xc0);
    wait(s, 200);
    expect(log.length).toBe(0); // aborted
    // clear: read SR with MODF set, then write CR1
    nets.pins.externalChange([['PS7', 1]]);
    rd(s, SR);
    wr(s, CR1, 0x50);
    expect(s.peek(SR) & 0x10).toBe(0);
    expect(s.peek(CR1)).toBe(0x50);
  });

  it('slave mode: an external master exchanges a byte while SS is low', () => {
    const { s, nets, spi } = rig();
    wr(s, CR1, 0x40); // SPE, slave
    rd(s, SR);
    wr(s, DR, 0x5a);
    expect(spi.slaveTransfer(0x11)).toBeNull(); // SS high
    nets.pins.drive('PS7', 0);
    expect(spi.slaveTransfer(0x11)).toBe(0x5a);
    expect(s.peek(SR) & 0xa0).toBe(0xa0);
    rd(s, SR);
    expect(rd(s, DR)).toBe(0x11);
  });
});
