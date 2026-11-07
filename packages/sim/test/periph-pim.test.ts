import { describe, expect, it } from 'vitest';
import { Assembler, resolveOptions } from '@s12/asm';
import { S12XSystem, createBoardNets, type BoardNets } from '@s12/sim';
import { MC9S12XDP512, addr, vectorByName } from '@s12/devices';
import { PIM_RANGE, PIM_RESET_OVERRIDES, PIM_VECTORS, Pim, atdDienFromRegisters, regMask, type PimOptions } from '../src/periph/pim';
import { MEBI_RANGES, Mebi } from '../src/periph/mebi';

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

function rig(opts: PimOptions = {}) {
  const s = new S12XSystem({ ramInit: 'zero' });
  const nets = createBoardNets();
  nets.pins.now = () => s.totalCycles;
  nets.pins.syncHook = () => s.bus.syncAll(s.totalCycles);
  const pim = new Pim(nets, opts);
  s.addPeripheral(pim, [PIM_RANGE]);
  const mebi = new Mebi(nets);
  s.addPeripheral(mebi, MEBI_RANGES);
  s.reset('power-on');
  s.setRegisters({ sp: 0x3f00, ccr: 0, ipl: 0 });
  return { s, nets, pim, mebi };
}

const A = (n: string) => addr(n);
const wr = (s: S12XSystem, n: string, v: number) => s.bus.regWrite(A(n), v, s.totalCycles);
const rd = (s: S12XSystem, n: string) => s.bus.regRead(A(n), s.totalCycles);
const line = (s: S12XSystem, vec: number) => !!s.bus.xint.line[vec >> 1];

describe('PIM register map', () => {
  it('range, vectors and masks come from @s12/devices', () => {
    expect(PIM_RANGE).toEqual([0x240, 0x27f]);
    expect(PIM_VECTORS).toEqual({ P: 0x8e, H: 0xcc, J: 0xce });
    expect(vectorByName('Vportj')!.offset).toBe(0xce);
    expect(regMask('PTJ')).toBe(0xf7);
    expect(regMask('MODRR')).toBe(0x7f);
    expect(regMask('PTT')).toBe(0xff);
  });

  it('every PIM register resets to its table value, except the PERS/PERJ overrides (data/input regs read pins)', () => {
    const { s } = rig();
    const pimRegs = MC9S12XDP512.registers.filter((r) => r.address >= 0x240 && r.address <= 0x27f);
    expect(pimRegs.length).toBeGreaterThan(50);
    for (const r of pimRegs) {
      if (/^PTI?[TSMPHJ]$|^PT[01]AD[01]$/.test(r.name)) continue;
      const want = r.name in PIM_RESET_OVERRIDES ? PIM_RESET_OVERRIDES[r.name] & regMask(r.name) : r.reset;
      expect([r.name, s.peek(r.address)]).toEqual([r.name, want]);
    }
    // nothing drives, no pulls: floating inputs read 1; AD inputs read 1 with DIEN=0
    expect(['PTT', 'PTIT', 'PTS', 'PTM', 'PTP', 'PTH', 'PTIH'].map((n) => s.peek(A(n)))).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect([s.peek(A('PTJ')), s.peek(A('PTIJ'))]).toEqual([0xf7, 0xf7]);
    expect(['PT1AD0', 'PT0AD1', 'PT1AD1'].map((n) => s.peek(A(n)))).toEqual([0xff, 0xff, 0xff]);
    // reserved addresses read 0, ignore writes
    for (const a of [0x246, 0x247, 0x24f, 0x270, 0x272, 0x274, 0x276]) {
      s.bus.regWrite(a, 0xff, s.totalCycles);
      expect(s.peek(a)).toBe(0);
    }
  });

  it('reset pull state per 9S12XDP512DGV2 Table 2-1: S and J pull-ups, T/M/P/H/AD disabled', () => {
    const { s, nets } = rig();
    expect([s.peek(A('PERS')), s.peek(A('PPSS')), s.peek(A('PERJ')), s.peek(A('PPSJ'))]).toEqual([0xff, 0, 0xf7, 0]);
    for (const n of ['PERT', 'PERM', 'PERP', 'PERH', 'PER1AD0', 'PER0AD1', 'PER1AD1']) expect([n, s.peek(A(n))]).toEqual([n, 0]);
    for (let i = 0; i < 8; i++) expect(nets.pins.state(`PS${i}`).pull).toBe('up');
    for (const i of [0, 1, 2, 4, 5, 6, 7]) expect(nets.pins.state(`PJ${i}`).pull).toBe('up');
    expect(nets.pins.state('PT0').pull).toBeNull();
    expect(nets.pins.state('PH0').pull).toBeNull();
    // a non-power-on reset restores them too, and pulling a floating pin up raises no key-wakeup flag
    wr(s, 'PERJ', 0);
    wr(s, 'PERS', 0);
    s.reset('cop');
    expect([s.peek(A('PERS')), s.peek(A('PERJ')), s.peek(A('PIFJ'))]).toEqual([0xff, 0xf7, 0]);
    expect(nets.pins.state('PJ7').pull).toBe('up');
  });

  it('masks unimplemented bits: Port J bit 3, MODRR bit 7; PTIx and writes to them are read-only', () => {
    const { s, nets } = rig();
    for (const n of ['DDRJ', 'RDRJ', 'PERJ', 'PPSJ', 'PIEJ']) {
      wr(s, n, 0xff);
      expect([n, s.peek(A(n))]).toEqual([n, 0xf7]);
    }
    wr(s, 'MODRR', 0xff);
    expect(s.peek(A('MODRR'))).toBe(0x7f);
    expect(nets.pins.mcuOutput('PJ3')).toBeNull();
    wr(s, 'PTIT', 0x00);
    expect(s.peek(A('PTIT'))).toBe(0xff);
  });
});

describe('PIM pins', () => {
  it('DDR + data drive the gpio layer; PTx reads latch for outputs and pins for inputs; PTIx always pins', () => {
    const { s, nets } = rig();
    wr(s, 'PTT', 0xa5);
    expect(nets.pins.mcuOutput('PT0')).toBeNull(); // DDR=0: not driven yet
    wr(s, 'DDRT', 0x0f);
    expect([0, 1, 2, 3].map((i) => nets.pins.mcuOutput(`PT${i}`))).toEqual([1, 0, 1, 0]);
    expect(nets.pins.state('PT0').mcuLayer).toBe('gpio');
    nets.pins.driveByte('PT', null);
    nets.pins.drive('PT4', 0);
    nets.pins.drive('PT0', 0); // board fights an output: board wins (PinNet rule)
    expect(rd(s, 'PTT')).toBe(0xe5); // latch $5 low nibble, pins $E high nibble
    expect(rd(s, 'PTIT')).toBe(0xe4);
    wr(s, 'DDRT', 0x00);
    expect(nets.pins.mcuOutput('PT2')).toBeNull();
  });

  it('pull devices: PER enables, PPS 0=up / 1=down, only for inputs', () => {
    const { s, nets } = rig();
    wr(s, 'PERT', 0xff);
    wr(s, 'PPST', 0xf0);
    expect(nets.pins.state('PT0').pull).toBe('up');
    expect(nets.pins.state('PT7').pull).toBe('down');
    expect(rd(s, 'PTT')).toBe(0x0f);
    wr(s, 'DDRT', 0x01);
    wr(s, 'PTT', 0x00);
    expect(nets.pins.state('PT0').pull).toBeNull(); // push-pull output: pull off
    expect(nets.pins.read('PT0')).toBe(0);
    nets.pins.drive('PT7', 1);
    expect(rd(s, 'PTT') & 0x80).toBe(0x80);
    // port AD: pull-ups only (PER), no PPS register
    wr(s, 'PER1AD1', 0x01);
    expect(nets.pins.state('PAD08').pull).toBe('up');
  });

  it('WOMS/WOMM: open-drain outputs drive 0 only; pull devices stay active', () => {
    const { s, nets } = rig();
    wr(s, 'PERS', 0x01);
    wr(s, 'WOMS', 0x01);
    wr(s, 'DDRS', 0x01);
    wr(s, 'PTS', 0x01);
    expect(nets.pins.mcuOutput('PS0')).toBeNull();
    expect(nets.pins.state('PS0').pull).toBe('up');
    wr(s, 'PTS', 0x00);
    expect(nets.pins.mcuOutput('PS0')).toBe(0);
    wr(s, 'WOMM', 0x80);
    wr(s, 'DDRM', 0x80);
    wr(s, 'PTM', 0x80);
    expect(nets.pins.mcuOutput('PM7')).toBeNull();
  });

  it('port AD: inputs read the pin only when the ATD digital input buffer is enabled', () => {
    let dien = 0;
    const { s, nets } = rig({ atdDien: () => dien });
    nets.pins.driveByte('PAD0', null);
    for (let i = 0; i < 24; i++) nets.pins.drive(`PAD${String(i).padStart(2, '0')}`, 0);
    expect(['PT1AD0', 'PT1AD1', 'PT0AD1'].map((n) => rd(s, n))).toEqual([0xff, 0xff, 0xff]);
    dien = 0x0f00f0; // PAD04-07, PAD16-19
    expect(['PT1AD0', 'PT1AD1', 'PT0AD1'].map((n) => rd(s, n))).toEqual([0x0f, 0xff, 0xf0]);
    // outputs read the latch, drive PADnn
    wr(s, 'DDR1AD1', 0x03);
    wr(s, 'PT1AD1', 0x02);
    expect(nets.pins.mcuOutput('PAD08')).toBe(0);
    expect(nets.pins.mcuOutput('PAD09')).toBe(1);
    expect(rd(s, 'PT1AD1')).toBe(0xfe);
  });

  it('atdDienFromRegisters reads ATD0DIEN / ATD1DIEN1 / ATD1DIEN0 into PAD bit order', () => {
    const regs: Record<number, number> = { [addr('ATD0DIEN')]: 0x12, [addr('ATD1DIEN1')]: 0x34, [addr('ATD1DIEN0')]: 0x56 };
    expect(atdDienFromRegisters((a) => regs[a] ?? 0)()).toBe(0x563412);
  });

  it('MODRR change callback and peripheral input claims disconnect the gpio driver', () => {
    const seen: number[] = [];
    const { s, nets, pim } = rig({ onModrrChange: (v) => seen.push(v) });
    wr(s, 'MODRR', 0x10);
    wr(s, 'MODRR', 0x10);
    expect(seen).toEqual([0x10]); // reset to the same value (0) does not call back
    expect(pim.modrr).toBe(0x10);
    wr(s, 'DDRS', 0x10);
    wr(s, 'PTS', 0x10);
    expect(nets.pins.mcuOutput('PS4')).toBe(1);
    pim.setPeripheralInputs('SPI0', ['PS4']);
    expect(nets.pins.mcuOutput('PS4')).toBeNull();
    pim.setPeripheralInputs('SPI0', []);
    expect(nets.pins.mcuOutput('PS4')).toBe(1);
  });
});

describe('PIM key wake-up (ports P, H, J)', () => {
  for (const [port, vec] of [
    ['J', PIM_VECTORS.J],
    ['H', PIM_VECTORS.H],
    ['P', PIM_VECTORS.P],
  ] as const) {
    it(`port ${port}: PPS selects the edge, PIF is W1C, PIE gates the request on vector $${vec.toString(16)}`, () => {
      const { s, nets } = rig();
      const pin = `P${port}7`;
      nets.pins.externalChange([[pin, 1]]);
      nets.pins.externalChange([[pin, 0]]); // falling edge, PPS=0: flag even with PIE=0
      expect(rd(s, `PIF${port}`)).toBe(0x80);
      expect(line(s, vec)).toBe(false);
      wr(s, `PIE${port}`, 0x80);
      expect(line(s, vec)).toBe(true);
      wr(s, `PIF${port}`, 0x7f); // writing 0 to bit 7 does nothing
      expect(rd(s, `PIF${port}`)).toBe(0x80);
      wr(s, `PIF${port}`, 0x80);
      expect(rd(s, `PIF${port}`)).toBe(0);
      expect(line(s, vec)).toBe(false);
      nets.pins.externalChange([[pin, 1]]); // rising: not active with PPS=0
      expect(rd(s, `PIF${port}`)).toBe(0);
      wr(s, `PPS${port}`, 0x80);
      nets.pins.externalChange([[pin, 0]]);
      expect(rd(s, `PIF${port}`)).toBe(0);
      nets.pins.externalChange([[pin, 1]]);
      expect(rd(s, `PIF${port}`)).toBe(0x80);
      expect(line(s, vec)).toBe(true);
    });
  }

  it('edges caused by the MCU itself (output pin) are detected too; repeated equal levels are not edges', () => {
    const { s, nets } = rig();
    wr(s, 'PTH', 0x01);
    wr(s, 'DDRH', 0x01); // floating 1 -> driven 1: no edge
    expect(rd(s, 'PIFH')).toBe(0);
    wr(s, 'PTH', 0x00); // falling
    expect(rd(s, 'PIFH')).toBe(0x01);
    nets.pins.setPull('PH0', 'down'); // driver change without level change
    wr(s, 'PIFH', 0xff);
    wr(s, 'PTH', 0x00);
    expect(rd(s, 'PIFH')).toBe(0);
  });

  it('a key wake-up interrupt is taken by a running program (Vportj via the vector table)', () => {
    const { s, nets } = rig();
    const sym = load(
      s,
      ` ORG $4000
start: BSET $026C,#$80   ; PERJ7
       BCLR $026D,#$80   ; PPSJ7=0: pull-up, falling edge
       MOVB #$FF,$026F   ; PIFJ
       BSET $026E,#$80   ; PIEJ7
       CLI
loop:  BRA loop
isr:   INC $2000
       MOVB #$80,$026F
       RTI
`,
    );
    s.poke(0xffce, sym.get('isr')! >> 8);
    s.poke(0xffcf, sym.get('isr')! & 0xff);
    s.setRegisters({ pc: sym.get('start')! });
    s.run(200);
    expect(nets.pins.read('PJ7')).toBe(1);
    expect(s.peek(0x2000)).toBe(0);
    nets.pins.externalChange([['PJ7', 0]]);
    s.run(200);
    expect(s.peek(0x2000)).toBe(1);
    nets.pins.externalChange([['PJ7', 1]]);
    s.run(200);
    nets.pins.externalChange([['PJ7', null]]); // released: pull-up keeps it high: no edge
    s.run(200);
    expect(s.peek(0x2000)).toBe(1);
  });

  it('re-driving pins on restore/reset does not leave spurious key-wakeup flags', () => {
    const { s } = rig();
    wr(s, 'DDRH', 0x01);
    wr(s, 'PTH', 0x00); // falling edge: flag
    wr(s, 'PIFH', 0xff);
    const snap = s.snapshot();
    wr(s, 'PTH', 0x01); // rising: no flag (PPS=0)
    expect(rd(s, 'PIFH')).toBe(0);
    s.restore(snap); // drives PH0 back to 0 = a falling edge on the PinNet
    expect(rd(s, 'PIFH')).toBe(0);
    wr(s, 'PTH', 0x01);
    wr(s, 'PPSH', 0x01); // rising-sensitive; reset drops the output -> floating 1 (no edge) ...
    wr(s, 'PTH', 0x00);
    wr(s, 'PIFH', 0xff);
    s.reset('external');
    expect(rd(s, 'PIFH')).toBe(0);
  });

  it('snapshot/restore keeps registers, pin drive and pending flags', () => {
    const { s, nets } = rig();
    wr(s, 'DDRP', 0xf0);
    wr(s, 'PTP', 0x50);
    wr(s, 'PIEJ', 0x80);
    nets.pins.externalChange([['PJ7', 0]]);
    const snap = s.snapshot();
    wr(s, 'PTP', 0xa0);
    wr(s, 'PIFJ', 0xff);
    s.restore(snap);
    expect(s.peek(A('PTP')) & 0xf0).toBe(0x50);
    expect(nets.pins.mcuOutput('PP4')).toBe(1);
    expect(nets.pins.mcuOutput('PP5')).toBe(0);
    expect(s.peek(A('PIFJ'))).toBe(0x80);
    expect(line(s, PIM_VECTORS.J)).toBe(true);
  });
});
