import { describe, expect, it } from 'vitest';
import { Assembler, resolveOptions } from '@s12/asm';
import { S12XSystem, createBoardNets, VEC_IRQ, VEC_XIRQ } from '@s12/sim';
import { ME3305_MASKS, addr } from '@s12/devices';
import { IRQ_PIN, MEBI_BITS, MEBI_RANGES, MEBI_VECTORS, Mebi, PORTE_PULLUP_BITS, XIRQ_PIN, type MebiOptions } from '../src/periph/mebi';

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

function rig(opts: MebiOptions = {}, wireVectorHook = false) {
  const s = new S12XSystem({ ramInit: 'zero' });
  const nets = createBoardNets();
  nets.pins.now = () => s.totalCycles;
  nets.pins.syncHook = () => s.bus.syncAll(s.totalCycles);
  const mebi = new Mebi(nets, opts);
  s.addPeripheral(mebi, MEBI_RANGES);
  if (wireVectorHook) s.bus.xint.onVectorTaken = (o) => mebi.vectorTaken(o);
  s.reset('power-on');
  s.setRegisters({ sp: 0x3f00, ccr: 0, ipl: 0 });
  return { s, nets, mebi };
}

const A = (n: string) => addr(n);
const wr = (s: S12XSystem, n: string, v: number) => s.bus.regWrite(A(n), v, s.totalCycles);
const rd = (s: S12XSystem, n: string) => s.bus.regRead(A(n), s.totalCycles);
const line = (s: S12XSystem, vec: number) => !!s.bus.xint.line[vec >> 1];

describe('MEBI core ports: map and reset', () => {
  it('ranges cover ports A-E/K, PUCR..EBICTL1, ECLKCTL, IRQCR (MODE/MMCCTL0 stay in the core)', () => {
    expect(MEBI_RANGES).toEqual([
      [0x00, 0x09],
      [0x0c, 0x0f],
      [0x1c, 0x1c],
      [0x1e, 0x1e],
      [0x32, 0x33],
    ]);
    expect(MEBI_VECTORS).toEqual({ irq: VEC_IRQ, xirq: VEC_XIRQ });
    expect(MEBI_BITS.PUPKE).toBe(ME3305_MASKS.PUCR_PUPKE);
    expect(MEBI_BITS.PUPEE).toBe(ME3305_MASKS.PUCR_PUPEE);
    expect(MEBI_BITS.PUPBE).toBe(ME3305_MASKS.PUCR_PUPBE);
    expect(MEBI_BITS.PUPAE).toBe(ME3305_MASKS.PUCR_PUPAE);
    expect(MEBI_BITS.NECLK).toBe(ME3305_MASKS.ECLKCTL_NECLK);
  });

  it('reset values: PUCR $D0, ECLKCTL $C0, IRQCR $40, EBICTL0/1 per table; DDRE1:0 read 0; MODE still core', () => {
    const { s, nets } = rig();
    const vals = ['DDRA', 'DDRB', 'DDRE', 'DDRK', 'PUCR', 'RDRIV', 'EBICTL0', 'EBICTL1', 'ECLKCTL', 'IRQCR'].map((n) => s.peek(A(n)));
    expect(vals).toEqual([0, 0, 0, 0, 0xd0, 0, 0x3f, 0x07, 0xc0, 0x40]);
    wr(s, 'DDRE', 0xff);
    expect(s.peek(A('DDRE'))).toBe(0xfc);
    expect(s.peek(A('MODE'))).toBe(0x00); // special single-chip, core register
    // out of reset: pull-ups on port K and E (PUPKE, PUPEE), none on A/B
    expect(nets.pins.state('PK0').pull).toBe('up');
    expect(nets.pins.state('PE0').pull).toBe('up');
    expect(nets.pins.state('PE5').pull).toBeNull();
    expect(nets.pins.state('PA0').pull).toBeNull();
    expect(PORTE_PULLUP_BITS).toBe(0x9f);
    // ECLK/ECLKX2 disabled out of reset
    expect(nets.pins.state('PE4').mcuLayer).toBe('gpio'); // DDRE=$FC written above; no 'periph' (ECLK) claim
    expect(nets.pins.state('PE7').mcuLayer).toBe('gpio');
  });

  it('register masks: PUCR bit 5, RDRIV bits 6:5, ECLKCTL bits 5:2, IRQCR bits 5:0 read 0', () => {
    const { s } = rig();
    for (const [n, m] of [
      ['PUCR', 0xdf],
      ['RDRIV', 0x9f],
      ['ECLKCTL', 0xc3],
      ['IRQCR', 0xc0],
      ['EBICTL0', 0xbf],
      ['EBICTL1', 0x87],
    ] as const) {
      wr(s, n, 0xff);
      expect([n, s.peek(A(n))]).toEqual([n, m]);
    }
  });
});

describe('MEBI ports A/B/E/K', () => {
  it('DDR + data drive pins, data reads latch/pins; PUCR pull-ups only on inputs', () => {
    const { s, nets } = rig();
    wr(s, 'PUCR', 0x93);
    expect(nets.pins.state('PA0').pull).toBe('up');
    expect(nets.pins.state('PB7').pull).toBe('up');
    expect(rd(s, 'PORTA')).toBe(0xff);
    wr(s, 'PORTA', 0x50);
    wr(s, 'DDRA', 0x50); // ME3305 motor direction/enable pins PA4/PA6 as outputs
    expect([nets.pins.mcuOutput('PA4'), nets.pins.mcuOutput('PA6'), nets.pins.mcuOutput('PA5')]).toEqual([1, 1, null]);
    expect(nets.pins.state('PA4').pull).toBeNull();
    nets.pins.drive('PA5', 0);
    expect(rd(s, 'PORTA')).toBe(0xdf);
    wr(s, 'DDRB', 0xff);
    wr(s, 'PORTB', 0x3c);
    expect(nets.pins.mcuByte('PB')).toBe(0x3c);
    wr(s, 'DDRB', 0x00); // LCD read: bus released, pulled up
    expect(rd(s, 'PORTB')).toBe(0xff);
    nets.pins.driveByte('PB', 0x41);
    expect(rd(s, 'PORTB')).toBe(0x41);
    wr(s, 'PUCR', 0x00);
    expect(nets.pins.state('PK0').pull).toBeNull();
  });

  it('PE1:0 are input-only; ports C/D are plain storage (not bonded)', () => {
    const { s, nets } = rig();
    wr(s, 'DDRE', 0xff);
    wr(s, 'PORTE', 0x00);
    expect(nets.pins.mcuOutput('PE0')).toBeNull();
    expect(nets.pins.mcuOutput('PE2')).toBe(0);
    expect(rd(s, 'PORTE') & 0x03).toBe(0x03); // pins (pulled up)
    wr(s, 'PORTC', 0x5a);
    wr(s, 'DDRD', 0xa5);
    expect([s.peek(A('PORTC')), s.peek(A('DDRD'))]).toEqual([0x5a, 0xa5]);
  });

  it('ECLK: NECLK=0 claims PE4 on the periph layer; frequency = bus/(EDIV+1); NCLKX2=0 claims PE7', () => {
    const { s, nets, mebi } = rig();
    wr(s, 'ECLKCTL', 0x40);
    expect(nets.pins.state('PE4').mcuLayer).toBe('periph');
    expect(mebi.eclkHz).toBe(8_000_000);
    wr(s, 'ECLKCTL', 0x43);
    expect(mebi.eclkHz).toBe(2_000_000);
    expect(mebi.eclkx2Hz).toBe(0);
    wr(s, 'ECLKCTL', 0x80);
    expect(nets.pins.state('PE4').mcuLayer).toBeNull();
    expect(nets.pins.state('PE7').mcuLayer).toBe('periph');
    expect(mebi.eclkx2Hz).toBe(16_000_000);
  });
});

describe('MEBI IRQ / XIRQ pins', () => {
  it('IRQ is PE1 and XIRQ is PE0 (9S12XDP512DGV2 §2.3.20-21, Table 2-1)', () => {
    expect([IRQ_PIN, XIRQ_PIN]).toEqual(['PE1', 'PE0']);
    const { s, nets } = rig();
    nets.pins.externalChange([['PE1', 0]]);
    expect([line(s, VEC_IRQ), line(s, VEC_XIRQ)]).toEqual([true, false]);
    nets.pins.externalChange([['PE1', null], ['PE0', 0]]);
    expect([line(s, VEC_IRQ), line(s, VEC_XIRQ)]).toEqual([false, true]);
    nets.pins.externalChange([['PE0', null]]);
    expect([line(s, VEC_IRQ), line(s, VEC_XIRQ)]).toEqual([false, false]);
  });

  it('IRQ level mode: request while PE1 is low and IRQEN=1', () => {
    const { s, nets } = rig();
    nets.pins.externalChange([['PE1', 0]]);
    expect(line(s, VEC_IRQ)).toBe(true);
    wr(s, 'IRQCR', 0x00);
    expect(line(s, VEC_IRQ)).toBe(false);
    wr(s, 'IRQCR', 0x40);
    expect(line(s, VEC_IRQ)).toBe(true);
    nets.pins.externalChange([['PE1', null]]);
    expect(line(s, VEC_IRQ)).toBe(false);
  });

  it("IRQ edge mode (default 'pin-high'): falling edge latches; acknowledgeIrq or PE1 high clears (UNCERTAIN fallback)", () => {
    const { s, nets, mebi } = rig();
    wr(s, 'IRQCR', 0xc0);
    nets.pins.externalChange([['PE1', 0]]);
    expect(line(s, VEC_IRQ)).toBe(true);
    mebi.acknowledgeIrq();
    expect(line(s, VEC_IRQ)).toBe(false); // still low, but edge consumed
    nets.pins.externalChange([['PE1', 1]]);
    nets.pins.externalChange([['PE1', 0]]);
    expect(line(s, VEC_IRQ)).toBe(true);
    wr(s, 'IRQCR', 0xc0); // an IRQCR write does not clear a latched edge
    expect(line(s, VEC_IRQ)).toBe(true);
    nets.pins.externalChange([['PE1', 1]]);
    expect(line(s, VEC_IRQ)).toBe(false);
  });

  it("IRQ edge mode ('vector'): a short pulse stays latched until the IRQ vector is fetched", () => {
    const { s, nets } = rig({ irqEdgeClear: 'vector' }, true);
    const sym = load(
      s,
      ` ORG $4000
start: NOP
       NOP
       CLI
loop:  BRA loop
isr:   INC $2000
       RTI
`,
    );
    s.poke(0xfff2, sym.get('isr')! >> 8);
    s.poke(0xfff3, sym.get('isr')! & 0xff);
    s.setRegisters({ pc: sym.get('start')!, ccr: 0xd0 }); // I=1: masked
    wr(s, 'IRQCR', 0xc0);
    nets.pins.externalChange([['PE1', 0]]);
    nets.pins.externalChange([['PE1', 1]]); // pulse over before the CPU can take it
    expect(line(s, VEC_IRQ)).toBe(true);
    wr(s, 'IRQCR', 0xc0);
    expect(line(s, VEC_IRQ)).toBe(true);
    s.run(200);
    expect(s.peek(0x2000)).toBe(1); // taken exactly once: the vector fetch cleared the latch
    expect(line(s, VEC_IRQ)).toBe(false);
    // other vectors do not clear it
    nets.pins.externalChange([['PE1', 0]]);
    s.bus.xint.onVectorTaken!(VEC_XIRQ);
    expect(line(s, VEC_IRQ)).toBe(true);
    // switching to level mode drops the latch (PE1 high: no request)
    nets.pins.externalChange([['PE1', 1]]);
    wr(s, 'IRQCR', 0x40);
    expect(line(s, VEC_IRQ)).toBe(false);
  });

  it('IRQE is write-once in normal mode', () => {
    const { s } = rig({ mode: 'normal' });
    wr(s, 'IRQCR', 0x80);
    wr(s, 'IRQCR', 0x40);
    expect(s.peek(A('IRQCR'))).toBe(0xc0);
    const sp = rig().s;
    wr(sp, 'IRQCR', 0x80);
    wr(sp, 'IRQCR', 0x40);
    expect(sp.peek(A('IRQCR'))).toBe(0x40);
  });

  it('an IRQ button (PE1) interrupts a running program through $FFF2; XIRQ (PE0) through $FFF4 once X is clear', () => {
    const { s, nets } = rig();
    const sym = load(
      s,
      ` ORG $4000
start: ANDCC #$AF        ; CLI + clear X
loop:  BRA loop
isr:   INC $2000
wt:    BRCLR $08,#$02,wt ; wait for PE1 (IRQ) high again (level mode)
       RTI
xisr:  INC $2001
wx:    BRCLR $08,#$01,wx ; wait for PE0 (XIRQ) high again
       RTI
`,
    );
    s.poke(0xfff2, sym.get('isr')! >> 8);
    s.poke(0xfff3, sym.get('isr')! & 0xff);
    s.poke(0xfff4, sym.get('xisr')! >> 8);
    s.poke(0xfff5, sym.get('xisr')! & 0xff);
    s.setRegisters({ pc: sym.get('start')!, ccr: 0xd0 });
    s.run(100);
    nets.pins.externalChange([['PE1', 0]]);
    s.run(100);
    nets.pins.externalChange([['PE1', null]]);
    s.run(100);
    expect([s.peek(0x2000), s.peek(0x2001)]).toEqual([1, 0]);
    nets.pins.externalChange([['PE0', 0]]);
    s.run(100);
    nets.pins.externalChange([['PE0', null]]);
    s.run(100);
    expect([s.peek(0x2000), s.peek(0x2001)]).toEqual([1, 1]);
  });

  it('irqPins:false leaves the interrupt lines alone', () => {
    const { s, nets } = rig({ irqPins: false });
    nets.pins.externalChange([['PE0', 0], ['PE1', 0]]);
    expect(line(s, VEC_IRQ) || line(s, VEC_XIRQ)).toBe(false);
  });

  it('snapshot/restore', () => {
    const { s, nets } = rig();
    wr(s, 'PUCR', 0x93);
    wr(s, 'DDRB', 0xff);
    wr(s, 'PORTB', 0x12);
    wr(s, 'ECLKCTL', 0x40);
    const snap = s.snapshot();
    wr(s, 'PORTB', 0x34);
    wr(s, 'PUCR', 0);
    wr(s, 'ECLKCTL', 0xc0);
    s.restore(snap);
    expect(nets.pins.mcuByte('PB')).toBe(0x12);
    expect(s.peek(A('PUCR'))).toBe(0x93);
    expect(nets.pins.state('PA0').pull).toBe('up');
    expect(nets.pins.state('PE4').mcuLayer).toBe('periph');
  });

  it('restore keeps the snapshot IRQ edge latch even when restoring PUCR re-pulls a board-driven IRQ pin', () => {
    const { s, nets } = rig({ irqEdgeClear: 'vector' });
    wr(s, 'IRQCR', 0xc0);
    const snap = s.snapshot(); // latch clear, PE1 high, PUCR $D0
    expect(line(s, VEC_IRQ)).toBe(false);
    wr(s, 'PUCR', 0x00); // PE1 pull-up off
    nets.pins.drive('PE1', 0); // board pulls IRQ low: edge latched
    expect(line(s, VEC_IRQ)).toBe(true);
    // board model not restored yet: PE1 still driven low while the MEBI restores PUCR (pull change -> listener)
    s.restore(snap);
    expect(line(s, VEC_IRQ)).toBe(false);
    expect(s.peek(A('PUCR'))).toBe(0xd0);
    // the board model then restores its own drive: no edge, no spurious latch
    nets.pins.drive('PE1', null);
    expect(line(s, VEC_IRQ)).toBe(false);
  });
});
