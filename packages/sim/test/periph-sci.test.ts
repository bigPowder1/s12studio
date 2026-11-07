import { describe, expect, it } from 'vitest';
import { Assembler, resolveOptions } from '@s12/asm';
import { S12XSystem, createBoardNets, type BoardNets } from '@s12/sim';
import { addr, mask } from '@s12/devices';
import { SCI_BASES, SCI_RANGES, SCI_VECTORS, SciModule, type SciOptions, type SciTxInfo } from '../src/periph/sci';

function load(s: S12XSystem, src: string): void {
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
}

interface Rig {
  s: S12XSystem;
  nets: BoardNets;
  sci: SciModule;
  tx: Array<{ byte: number; cycle: number; info: SciTxInfo }>;
}

function rig(opts: SciOptions = {}): Rig {
  const s = new S12XSystem({ ramInit: 'zero' });
  const nets = createBoardNets();
  const sci = new SciModule(nets, opts);
  s.addPeripheral(sci, [SCI_RANGES[opts.index ?? 0]]);
  s.reset();
  s.setRegisters({ sp: 0x3f00, ccr: 0, ipl: 0 });
  const tx: Rig['tx'] = [];
  sci.onTransmit((byte, cycle, info) => tx.push({ byte, cycle, info }));
  load(s, ' ORG $4F00\nidle: BRA idle\n');
  return { s, nets, sci, tx };
}

function wait(s: S12XSystem, n: number): void {
  s.setRegisters({ pc: 0x4f00 });
  s.run(n);
}
const rd = (s: S12XSystem, a: number) => s.bus.regRead(a, s.totalCycles);
const wr = (s: S12XSystem, a: number, v: number) => s.bus.regWrite(a, v, s.totalCycles);

const BDH = 0xc8;
const BDL = 0xc9;
const CR1 = 0xca;
const CR2 = 0xcb;
const SR1 = 0xcc;
const SR2 = 0xcd;
const DRH = 0xce;
const DRL = 0xcf;
/** 9600 baud at the 8 MHz reset bus clock: SBR = 52, 832 bus cycles per bit, 8320 per 10-bit frame. */
const BIT = 832;
const FRAME = 10 * BIT;

function setup(s: S12XSystem, cr2: number, cr1 = 0): void {
  wr(s, BDH, 0);
  wr(s, BDL, 52);
  wr(s, CR1, cr1);
  wr(s, CR2, cr2);
}

describe('SCI register map', () => {
  it('bases, ranges and vectors come from @s12/devices', () => {
    expect(SCI_BASES).toEqual([0xc8, 0xd0, 0xb8, 0xc0, 0x130, 0x138]);
    expect(SCI_BASES[4]).toBe(addr('SCI4BDH'));
    expect(SCI_RANGES[5]).toEqual([0x138, 0x13f]);
    expect(SCI_VECTORS).toEqual([0xd6, 0xd4, 0x8a, 0x88, 0x86, 0x84]);
    expect(mask('SCI0SR1', 'RDRF')).toBe(0x20);
  });

  it('reset values; SCISR1 read-only; RAF read-only', () => {
    const { s } = rig();
    expect([BDH, BDL, CR1, CR2, SR1, SR2, DRH, DRL].map((a) => s.peek(a))).toEqual([0, 4, 0, 0, 0xc0, 0, 0, 0]);
    s.poke(SR1, 0);
    s.poke(SR2, 0xff);
    expect(s.peek(SR1)).toBe(0xc0);
    expect(s.peek(SR2)).toBe(0x9e);
  });

  it('SCIBDH is held until SCIBDL is written; baud = bus / (16 * SBR)', () => {
    const { s, sci } = rig();
    wr(s, BDH, 0x01);
    expect(sci.sbr).toBe(4);
    wr(s, BDL, 0xa0);
    expect(sci.sbr).toBe(0x1a0);
    wr(s, BDH, 0);
    wr(s, BDL, 52);
    expect(sci.bitCycles).toBe(BIT);
    expect(sci.baud).toBeCloseTo(8_000_000 / 832);
    wr(s, BDH, 0x80); // IREN: bus / (32 * SBR[12:1])
    wr(s, BDL, 53);
    expect(sci.bitCycles).toBe(32 * 26);
  });

  it('AMAP=1 exposes SCIASR1/ACR1/ACR2 at offsets 0..2', () => {
    const { s } = rig();
    setup(s, 0x04);
    wr(s, SR2, 0x80);
    wr(s, BDL, 0xff); // ACR1
    wr(s, CR1, 0xff); // ACR2
    expect([s.peek(BDL), s.peek(CR1)]).toEqual([0x83, 0x07]);
    wr(s, SR2, 0x00);
    expect([s.peek(BDH), s.peek(BDL), s.peek(CR1)]).toEqual([0, 52, 0]);
  });
});

describe('SCI transmitter', () => {
  it('polled "Hi": preamble after TE, then one frame per 10 bit-times; TC at the end', () => {
    const { s, tx } = rig();
    load(
      s,
      `
 ORG $4000
 MOVW #52,$C8      ; SCI0BD = 52 (9600 @ 8 MHz)
 CLR  $CA
 MOVB #$08,$CB     ; TE
 LDX  #msg
nxt: LDAA 1,X+
 BEQ  done
w: BRCLR $CC,#$80,w
 STAA $CF
 BRA  nxt
done: BRCLR $CC,#$40,done
 BGND
msg: DC.B "Hi",0
`,
    );
    let teAt = -1;
    s.setTracer((acc, local, _g, v, cycle) => {
      if (acc === 'write' && local === CR2 && v === 0x08) teAt = cycle;
    });
    s.setRegisters({ pc: 0x4000 });
    expect(s.run(200_000)).toBe('bgnd');
    expect(tx.map((t) => String.fromCharCode(t.byte))).toEqual(['H', 'i']);
    expect(tx[0].cycle - teAt).toBe(2 * FRAME); // preamble + 'H'
    expect(tx[1].cycle - tx[0].cycle).toBe(FRAME);
    expect(tx[0].info).toEqual({ dataBits: 8, raw: 0x48 });
    expect(s.peek(SR1) & 0xc0).toBe(0xc0);
  });

  it('a SCIDRL write without reading TDRE first is queued with a warning (default) or ignored (strictTdreSequence)', () => {
    const a = rig({ strictTdreSequence: true });
    setup(a.s, 0x08);
    wr(a.s, DRL, 0x41);
    wait(a.s, 3 * FRAME);
    expect(a.tx.length).toBe(0);
    expect(a.s.events.some((e) => /SCI0DRL ignored/.test(e.message))).toBe(true);
    const b = rig();
    expect(b.sci.strictTdreSequence).toBe(false);
    setup(b.s, 0x08);
    wr(b.s, DRL, 0x41);
    wait(b.s, 3 * FRAME);
    expect(b.tx.map((t) => t.byte)).toEqual([0x41]);
    expect(b.s.events.some((e) => /SCI0DRL accepted without reading TDRE/.test(e.message))).toBe(true);
    // The proper sequence logs nothing.
    const n = b.s.events.length;
    rd(b.s, SR1);
    wr(b.s, DRL, 0x42);
    wait(b.s, 2 * FRAME);
    expect(b.tx.map((t) => t.byte)).toEqual([0x41, 0x42]);
    expect(b.s.events.slice(n).some((e) => /SCI0DRL/.test(e.message))).toBe(false);
  });

  it('writing a valid SBR starts a transmitter that was waiting with SBR=0 (regression)', () => {
    const { s, tx } = rig();
    wr(s, BDH, 0);
    wr(s, BDL, 0); // baud-rate generator off
    wr(s, CR2, 0x08); // TE: preamble pending
    rd(s, SR1);
    wr(s, DRL, 0x41);
    wait(s, 3 * FRAME);
    expect(tx.length).toBe(0);
    const t0 = s.totalCycles;
    wr(s, BDH, 0);
    wr(s, BDL, 52);
    wait(s, 3 * FRAME);
    expect(tx.map((t) => t.byte)).toEqual([0x41]);
    expect(tx[0].cycle - t0).toBe(2 * FRAME); // preamble + frame from the SBR write
    expect(s.peek(SR1) & 0xc0).toBe(0xc0);
  });

  it('TDRE/TC flags and the TIE/TCIE interrupt line', () => {
    const { s } = rig();
    const line = () => s.bus.xint.line[0xd6 >> 1];
    setup(s, 0x08);
    expect(s.peek(SR1) & 0xc0).toBe(0x80); // preamble in progress: TDRE=1, TC=0
    wait(s, FRAME + 10);
    expect(s.peek(SR1) & 0xc0).toBe(0xc0);
    wr(s, CR2, 0x48); // TCIE TE
    expect(line()).toBe(1);
    rd(s, SR1);
    wr(s, DRL, 0x55); // goes straight to the shifter: TDRE=1, TC=0
    expect(s.peek(SR1) & 0xc0).toBe(0x80);
    expect(line()).toBe(0);
    rd(s, SR1);
    wr(s, DRL, 0x56); // buffered: TDRE=0
    expect(s.peek(SR1) & 0xc0).toBe(0x00);
    wr(s, CR2, 0x88); // TIE TE
    expect(line()).toBe(0);
    wait(s, FRAME + 10);
    expect(line()).toBe(1); // TDRE set again when the 2nd byte entered the shifter
  });

  it('9-bit frames carry T8; parity replaces the MSB', () => {
    const { s, tx } = rig();
    setup(s, 0x08, 0x10); // M=1
    wr(s, DRH, 0x40); // T8
    wait(s, 2 * 11 * BIT);
    rd(s, SR1);
    wr(s, DRL, 0x12);
    wait(s, 2 * 11 * BIT);
    expect(tx[0]).toMatchObject({ byte: 0x12, info: { dataBits: 9, bit8: 1, raw: 0x112 } });
    const b = rig();
    setup(b.s, 0x08, 0x03); // M=0, PE, odd parity
    wait(b.s, FRAME);
    rd(b.s, SR1);
    wr(b.s, DRL, 0xc1); // 7 data bits 0x41 (2 ones) -> odd parity bit 1
    wait(b.s, 2 * FRAME);
    expect(b.tx[0]).toMatchObject({ byte: 0x41, info: { dataBits: 7, parity: 1, raw: 0xc1 } });
  });

  it('SBK sends break characters', () => {
    const { s, sci } = rig();
    const brk: Array<[number, number]> = [];
    sci.onBreak((c, bits) => brk.push([c, bits]));
    setup(s, 0x08);
    wait(s, FRAME);
    wr(s, CR2, 0x09);
    wait(s, 10 * BIT + 5);
    wr(s, CR2, 0x08);
    wait(s, 30 * BIT);
    expect(brk.length).toBeGreaterThanOrEqual(1);
    expect(brk[0][1]).toBe(10);
  });

  it('claims TXD (PS1, idle high) while TE=1 and RXD (PS0) while RE=1', () => {
    const { s, nets, sci } = rig();
    setup(s, 0x0c);
    expect(nets.pins.state('PS1')).toMatchObject({ mcu: 1, mcuLayer: 'periph' });
    expect(sci.claimedPins().map((c) => [c.pin, c.dir])).toEqual([
      ['PS1', 'out'],
      ['PS0', 'in'],
    ]);
    wait(s, FRAME + 1);
    wr(s, CR2, 0);
    expect(nets.pins.state('PS1').mcu).toBeNull();
    expect(sci.claimedPins()).toEqual([]);
  });
});

describe('SCI receiver', () => {
  it('host bytes arrive one frame after injection; RDRF cleared by SR1 then DRL reads', () => {
    const { s, sci } = rig();
    setup(s, 0x04);
    wait(s, 100);
    sci.receive(0x41);
    const t0 = s.totalCycles;
    expect(s.peek(SR2) & 1).toBe(1); // RAF
    wait(s, FRAME - 20);
    expect(s.peek(SR1) & 0x20).toBe(0);
    s.run(Math.max(1, t0 + FRAME - s.totalCycles));
    expect(s.peek(SR1) & 0x20).toBe(0x20);
    expect(rd(s, DRL)).toBe(0x41);
    expect(s.peek(SR1) & 0x20).toBe(0x20); // no SR1 read yet
    rd(s, SR1);
    rd(s, DRL);
    expect(s.peek(SR1) & 0x20).toBe(0);
  });

  it('overrun keeps the first byte and sets OR', () => {
    const { s, sci } = rig();
    setup(s, 0x04);
    sci.receive([1, 2, 3]);
    expect(sci.rxPending).toBe(3);
    wait(s, 3 * FRAME + 10);
    expect(s.peek(SR1) & 0x28).toBe(0x28);
    rd(s, SR1);
    expect(rd(s, DRL)).toBe(1);
    expect(s.peek(SR1) & 0x28).toBe(0);
  });

  it('IDLE: ILT=1 counts a full idle character after the stop bit; ILT=0 counts the trailing ones', () => {
    const cases: Array<[number, number, number]> = [
      [0x04, 0x41, 9], // ILT=0, MSB 0: only the stop bit counts
      [0x04, 0xff, 1], // ILT=0: 8 data ones + stop
      [0x04 | 0x100, 0x41, 10], // ILT=1
    ];
    for (const [cfg, byte, bits] of cases) {
      const { s, sci } = rig();
      setup(s, cfg & 0xff, cfg & 0x100 ? 0x04 : 0);
      sci.receive(byte);
      const t0 = s.totalCycles;
      const idleAt = t0 + FRAME + bits * BIT;
      wait(s, idleAt - s.totalCycles - 10);
      expect(s.peek(SR1) & 0x10).toBe(0);
      wait(s, 20);
      expect(s.peek(SR1) & 0x10).toBe(0x10);
      rd(s, SR1);
      rd(s, DRL);
      expect(s.peek(SR1) & 0x30).toBe(0);
    }
  });

  it('RIE interrupt-driven echo program', () => {
    const { s, sci, tx } = rig();
    load(
      s,
      `
 ORG $4000
 MOVW #52,$C8
 MOVB #$2C,$CB     ; RIE TE RE
 CLI
loop: BRA loop
 ORG $4200
isr: LDAA $CC
 LDAB $CF
 LDX  $2010
 STAB 1,X+
 STX  $2010
w: BRCLR $CC,#$80,w
 STAB $CF
 RTI
 ORG $FFD6
 DC.W isr
`,
    );
    s.poke(0x2010, 0x20);
    s.poke(0x2011, 0x00);
    s.setRegisters({ pc: 0x4000 });
    s.run(100);
    sci.receive('OK!');
    s.run(6 * FRAME);
    expect(s.readBlock(0x2000, 3)).toEqual([0x4f, 0x4b, 0x21]);
    expect(tx.map((t) => t.byte)).toEqual([0x4f, 0x4b, 0x21]);
  });

  it('9-bit receive sets R8; parity error sets PF; framing error sets FE; break reads 0 with FE', () => {
    const { s, sci } = rig();
    setup(s, 0x04, 0x10);
    sci.receive(0x33, { bit8: 1 });
    wait(s, 11 * BIT + 10);
    expect(s.peek(DRH) & 0x80).toBe(0x80);
    rd(s, SR1);
    expect(rd(s, DRL)).toBe(0x33);
    wr(s, CR1, 0x02); // M=0, PE, even
    sci.receive(0x41, { parityError: true });
    wait(s, FRAME + 10);
    expect(s.peek(SR1) & 0x21).toBe(0x21);
    rd(s, SR1);
    expect(rd(s, DRL)).toBe(0xc1); // parity bit lands in bit 7
    expect(s.peek(SR1) & 0x21).toBe(0);
    wr(s, CR1, 0);
    sci.receive(0x55, { framingError: true });
    wait(s, FRAME + 10);
    expect(s.peek(SR1) & 0x22).toBe(0x22);
    rd(s, SR1);
    rd(s, DRL);
    sci.receiveBreak();
    wait(s, FRAME + 10);
    expect(s.peek(SR1) & 0x22).toBe(0x22);
    expect(s.peek(DRL)).toBe(0);
  });

  it('LOOPS=1, RSRC=0 loops the transmitter into the receiver (host sees nothing)', () => {
    const { s, tx } = rig();
    setup(s, 0x0c, 0x80);
    wait(s, FRAME);
    rd(s, SR1);
    wr(s, DRL, 0x5a);
    wait(s, FRAME + 10);
    expect(tx.length).toBe(0);
    rd(s, SR1);
    expect(rd(s, DRL)).toBe(0x5a);
  });

  it('receiver wakeup: address mark (WAKE=1) wakes on a frame with MSB set', () => {
    const { s, sci } = rig();
    setup(s, 0x06, 0x08); // RE RWU, WAKE=1
    sci.receive([0x01, 0x81, 0x02]);
    wait(s, FRAME + 10);
    expect(s.peek(SR1) & 0x20).toBe(0); // standby
    wait(s, FRAME);
    expect(s.peek(SR1) & 0x20).toBe(0x20);
    expect(s.peek(CR2) & 0x02).toBe(0); // RWU cleared
    rd(s, SR1);
    expect(rd(s, DRL)).toBe(0x81);
  });

  it('RXEDGIF (AMAP=1) is set at the start bit and is write-1-to-clear; RXEDGIE interrupts', () => {
    const { s, sci } = rig();
    const line = () => s.bus.xint.line[0xd6 >> 1];
    setup(s, 0x04);
    wr(s, SR2, 0x80);
    wr(s, BDL, 0x80); // ACR1.RXEDGIE
    sci.receive(0x00);
    expect(s.peek(BDH) & 0x80).toBe(0x80);
    expect(line()).toBe(1);
    wr(s, BDH, 0x80);
    expect(s.peek(BDH) & 0x80).toBe(0);
    expect(line()).toBe(0);
  });

  it('a host listener may call receive() from onTransmit (loopback plug): echo arrives one frame later', () => {
    const { s, sci, tx } = rig();
    sci.onTransmit((b) => sci.receive(b ^ 0x20));
    setup(s, 0x0c);
    wait(s, FRAME);
    rd(s, SR1);
    wr(s, DRL, 0x61);
    wait(s, FRAME + 10);
    expect(tx.length).toBe(1);
    expect(s.peek(SR1) & 0x20).toBe(0);
    s.run(Math.max(1, tx[0].cycle + FRAME - s.totalCycles));
    expect(s.peek(SR1) & 0x20).toBe(0x20);
    expect(s.peek(DRL)).toBe(0x41);
  });

  it('snapshot/restore in the middle of a received frame', () => {
    const { s, sci } = rig();
    setup(s, 0x04);
    sci.receive([0x10, 0x20]);
    wait(s, FRAME / 2);
    const snap = s.snapshot();
    wait(s, 2 * FRAME);
    const after = [s.peek(SR1), s.peek(DRL)];
    s.restore(snap);
    expect(sci.rxPending).toBe(2);
    wait(s, 2 * FRAME);
    expect([s.peek(SR1), s.peek(DRL)]).toEqual(after);
    expect(after[0] & 0x28).toBe(0x28);
  });
});
