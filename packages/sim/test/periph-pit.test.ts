import { describe, expect, it } from 'vitest';
import { Assembler, resolveOptions } from '@s12/asm';
import { S12XSystem, createBoardNets } from '@s12/sim';
import { addr } from '@s12/devices';
import { PIT_RANGE, PIT_REGS as P, PIT_VECTORS, PitModule } from '../src/periph/pit';

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

function rig() {
  const s = new S12XSystem({ ramInit: 'zero' });
  const pit = new PitModule(createBoardNets());
  s.addPeripheral(pit, [PIT_RANGE]);
  s.reset();
  s.setRegisters({ sp: 0x3f00, ccr: 0, ipl: 0 });
  const at = (t: number) => {
    if (t < s.cpu.cycles) throw new Error('time going backwards');
    s.cpu.cycles = t;
  };
  const rd = (t: number, a: number) => {
    at(t);
    return s.bus.regRead(a, t);
  };
  const wr = (t: number, a: number, v: number) => {
    at(t);
    s.bus.regWrite(a, v, t);
  };
  return {
    s,
    pit,
    at,
    rd,
    wr,
    rd16: (t: number, a: number) => (rd(t, a) << 8) | rd(t, a + 1),
    wr16: (t: number, a: number, v: number) => {
      wr(t, a, v >> 8);
      wr(t, a + 1, v & 0xff);
    },
    irq: (o: number) => s.bus.xint.pending.includes(o),
  };
}

const LD = (n: number) => P.PITLD0 + 4 * n;
const CNT = (n: number) => P.PITCNT0 + 4 * n;

describe('PIT register map', () => {
  it('range, addresses and vectors come from @s12/devices', () => {
    expect(PIT_RANGE).toEqual([0x340, 0x357]);
    expect([P.PITCFLMT, P.PITTF, P.PITMTLD1, LD(0), CNT(0), LD(3), CNT(3)]).toEqual([
      0x340, 0x345, 0x347, 0x348, 0x34a, 0x354, 0x356,
    ]);
    expect(CNT(2)).toBe(addr('PITCNT2'));
    expect(PIT_VECTORS).toEqual([0x7a, 0x78, 0x76, 0x74]);
  });

  it('reset values and read masks; PITFLT/PFLMT read 0; PITCNT is read-only', () => {
    const r = rig();
    for (let a = 0x340; a <= 0x357; a++) expect([a, r.s.peek(a)]).toEqual([a, 0]);
    r.wr(0, P.PITCFLMT, 0xff);
    r.wr(0, P.PITCE, 0xff);
    r.wr(0, P.PITMUX, 0xff);
    r.wr(0, P.PITINTE, 0xff);
    r.wr(0, P.PITFLT, 0xff);
    r.wr16(0, CNT(1), 0x1234);
    expect([0x340, 0x341, 0x342, 0x343, 0x344].map((a) => r.s.peek(a))).toEqual([0xe0, 0, 0x0f, 0x0f, 0x0f]);
    expect(r.rd16(0, CNT(1))).toBe(0);
  });
});

describe('PIT timing', () => {
  it('period = (PITMTLD+1)*(PITLD+1) bus cycles from the PITE write; PITCNT counts micro-timer triggers', () => {
    const r = rig();
    r.wr(0, P.PITMTLD0, 9);
    r.wr16(0, LD(0), 99);
    r.wr(0, P.PITCE, 0x01);
    r.wr(0, P.PITINTE, 0x01);
    r.wr(100, P.PITCFLMT, 0x80);
    expect(r.pit.periodCycles(0)).toBe(1000);
    expect(r.pit.nextEventCycles()).toBe(1000);
    expect(r.rd16(100, CNT(0))).toBe(99);
    expect(r.rd16(109, CNT(0))).toBe(99);
    expect(r.rd16(110, CNT(0))).toBe(98);
    expect(r.rd16(1099, CNT(0))).toBe(0);
    expect(r.rd(1099, P.PITTF)).toBe(0);
    expect(r.irq(0x7a)).toBe(false);
    expect(r.rd(1100, P.PITTF)).toBe(1);
    expect(r.irq(0x7a)).toBe(true);
    expect(r.rd16(1100, CNT(0))).toBe(99);
    r.wr(1101, P.PITTF, 0x01);
    expect(r.irq(0x7a)).toBe(false);
    expect(r.pit.nextEventCycles()).toBe(999);
    // many periods later: still exactly on the grid
    expect(r.rd16(100 + 1000 * 1234 + 10, CNT(0))).toBe(98);
    expect(r.rd(100 + 1000 * 1234 + 10, P.PITTF)).toBe(1);
  });

  it('a flag set in the same cycle as its clearing write stays set', () => {
    const r = rig();
    r.wr(0, P.PITCE, 0x02);
    r.wr16(0, LD(1), 4);
    r.wr(0, P.PITCFLMT, 0x80); // MTLD0=0: period 5
    r.wr(5, P.PITTF, 0x02);
    expect(r.s.peek(P.PITTF)).toBe(0x02);
    r.wr(6, P.PITTF, 0x02);
    expect(r.s.peek(P.PITTF)).toBe(0);
  });

  it('PITMUX selects micro timer 1; PITMTLD and PITLD changes apply at the next reload; PFLMT/PFLT force-load', () => {
    const r = rig();
    r.wr(0, P.PITMTLD1, 3); // 4 cycles per trigger
    r.wr16(0, LD(2), 9);
    r.wr(0, P.PITMUX, 0x04);
    r.wr(0, P.PITCE, 0x04);
    r.wr(0, P.PITCFLMT, 0x80);
    expect(r.rd16(39, CNT(2))).toBe(0);
    expect(r.rd(40, P.PITTF)).toBe(0x04);
    r.wr16(41, LD(2), 1); // used at the next reload (at 80)
    r.wr(41, P.PITMTLD1, 0); // next trigger still at 44, then every cycle
    expect(r.rd16(43, CNT(2))).toBe(9);
    expect(r.rd16(44, CNT(2))).toBe(8);
    expect(r.rd16(52, CNT(2))).toBe(0);
    expect(r.rd16(53, CNT(2))).toBe(1); // reloaded with the new PITLD
    expect(r.rd16(55, CNT(2))).toBe(1);
    r.wr16(60, LD(2), 500);
    r.wr(60, P.PITFLT, 0x04);
    expect(r.rd16(60, CNT(2))).toBe(500);
    r.wr(61, P.PITMTLD1, 99);
    r.wr(61, P.PITCFLMT, 0x82); // force-load micro timer 1: next trigger at 61 + 100
    expect(r.rd16(160, CNT(2))).toBe(499);
    expect(r.rd16(161, CNT(2))).toBe(498);
  });

  it('PCE 0->1 loads the channel; PCE 1->0 and PITE 1->0 clear the flags', () => {
    const r = rig();
    r.wr16(0, LD(0), 2);
    r.wr16(0, LD(3), 7);
    r.wr(0, P.PITCE, 0x01);
    r.wr(0, P.PITCFLMT, 0x80);
    r.wr(10, P.PITCE, 0x09); // ch3 loads at 10: time-out at 18
    expect(r.rd(17, P.PITTF)).toBe(0x01);
    expect(r.rd(18, P.PITTF)).toBe(0x09);
    r.wr(19, P.PITCE, 0x08);
    expect(r.s.peek(P.PITTF)).toBe(0x08);
    r.wr(20, P.PITCFLMT, 0x00);
    expect(r.s.peek(P.PITTF)).toBe(0);
    const c = r.rd16(1000, CNT(3));
    expect(r.rd16(5000, CNT(3))).toBe(c); // stopped
    expect(r.pit.nextEventCycles()).toBe(Infinity);
  });

  it('periodic interrupt in a running program: ISR entries exactly one period apart', () => {
    const r = rig();
    const s = r.s;
    load(
      s,
      `
 ORG $4000
 MOVB #7,$346        ; PITMTLD0: 8 cycles
 MOVW #999,$348      ; PITLD0: 1000 triggers -> 8000 cycles
 MOVB #$01,$342      ; PITCE
 MOVB #$01,$344      ; PITINTE
 MOVB #$80,$340      ; PITE
 CLI
loop: BRA loop
isr: MOVB #$01,$345  ; clear PTF0
 INC  $2000
 RTI
 ORG $FF7A
 DC.W isr
`,
    );
    const entries: number[] = [];
    s.setTracer((acc, local, _g, _v, cyc) => {
      if (acc === 'write' && local === 0x345) entries.push(cyc);
    });
    s.setRegisters({ pc: 0x4000, ccr: 0x10 });
    s.run(80_500);
    expect(s.peek(0x2000)).toBe(10);
    // time-outs are exactly 8000 cycles apart; entry jitters by < one idle-loop instruction (BRA, 3 cycles)
    const ph = entries.map((c) => (c - entries[0]) % 8000);
    for (const x of ph) expect(x < 3 || x > 8000 - 3).toBe(true);
    expect(Math.round((entries[entries.length - 1] - entries[0]) / 8000)).toBe(entries.length - 1);
  });

  it('snapshot/restore round-trips the counters', () => {
    const r = rig();
    r.wr16(0, LD(0), 99);
    r.wr(0, P.PITCE, 0x01);
    r.wr(0, P.PITCFLMT, 0x80);
    r.at(250);
    const snap = r.s.snapshot();
    expect(r.rd16(250, CNT(0))).toBe(99 - (250 % 100) + 0);
    r.rd(400, P.PITTF);
    r.s.restore(snap);
    expect(r.s.totalCycles).toBe(250);
    expect((r.s.peek(CNT(0)) << 8) | r.s.peek(CNT(0) + 1)).toBe(49);
    expect(r.rd16(300, CNT(0))).toBe(99);
  });
});
