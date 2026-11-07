import { describe, expect, it } from 'vitest';
import { Assembler, resolveOptions } from '@s12/asm';
import { S12XSystem } from '@s12/sim';
import { addr, registerByName } from '@s12/devices';
import {
  CAN_BASES,
  CAN_RANGES,
  CanStub,
  DBG_RANGE,
  DbgModule,
  VREG_RANGE,
  VREG_VECTORS,
  VregModule,
  XGATE_RANGE,
  XgateStub,
} from '../src/periph/misc';

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

function sys(): S12XSystem {
  const s = new S12XSystem({ ramInit: 'zero' });
  return s;
}

describe('VREG', () => {
  it('map and reset values', () => {
    const s = sys();
    const v = new VregModule();
    s.addPeripheral(v, [VREG_RANGE]);
    s.reset();
    expect(VREG_RANGE).toEqual([0x2f0, 0x2f7]);
    expect(VREG_VECTORS).toEqual({ lvi: 0x80, api: 0x7e });
    for (const n of ['VREGCTRL', 'VREGAPICL', 'VREGAPITR', 'VREGAPIRH', 'VREGAPIRL']) {
      const r = registerByName(n)!;
      expect(s.peek(r.address), n).toBe(r.reset);
    }
  });

  it('API with the bus clock: APIF every 2*(APIR+1) bus cycles, Vapi interrupt, W1C', () => {
    const s = sys();
    const v = new VregModule();
    s.addPeripheral(v, [VREG_RANGE]);
    s.reset();
    s.setRegisters({ sp: 0x3f00, ccr: 0, ipl: 0 });
    const sym = load(
      s,
      `
 ORG $3000
start: MOVW #499,$2F4       ; APIR = 499 -> 1000 bus cycles
 MOVB #$86,$2F2             ; APICLK=bus, APIFE, APIE
 CLI
l: BRA l
isr: MOVB #$87,$2F2         ; clear APIF (keep enabled)
 INC $2000
 RTI
`,
    );
    s.poke(0xff7e, sym.get('isr')! >> 8);
    s.poke(0xff7f, sym.get('isr')! & 0xff);
    s.setRegisters({ pc: sym.get('start')! });
    expect(s.peek(0x2f2)).toBe(0);
    s.run(10_500);
    expect(s.peek(0x2000)).toBe(10);
    expect(v.apiPeriodCycles).toBe(1000);
  });

  it('API with ACLK; APICLK locked while enabled; LVI', () => {
    const s = sys();
    const v = new VregModule({ aclkHz: 10_000 });
    s.addPeripheral(v, [VREG_RANGE]);
    s.reset();
    s.poke(0x2f5, 0); // APIR = 0 -> 2 ACLK periods = 200 us = 1600 cycles at 8 MHz
    s.poke(0x2f2, 0x04);
    expect(v.apiPeriodCycles).toBe(1600);
    s.poke(0x2f2, 0x84); // APICLK change ignored while APIFE=1
    expect(s.peek(0x2f2) & 0x80).toBe(0);
    s.bus.regRead(0x2f2, 1599);
    expect(s.peek(0x2f2) & 1).toBe(0);
    expect(s.bus.regRead(0x2f2, 1600) & 1).toBe(1);
    s.poke(0x2f1, 0x02); // LVIE
    v.setLowVoltage(true);
    expect(s.peek(0x2f1)).toBe(0x07);
    expect(s.bus.xint.pending).toContain(VREG_VECTORS.lvi);
    s.poke(0x2f1, 0x03);
    expect(s.peek(0x2f1)).toBe(0x06);
    v.setLowVoltage(false);
    expect(s.peek(0x2f1)).toBe(0x03);
    const snap = v.snapshot();
    v.reset();
    v.restore(snap);
    expect(s.peek(0x2f1)).toBe(0x03);
  });
});

describe('DBG register file', () => {
  it('comparator window by COMRV; values exposed; locked while armed; warns once on ARM', () => {
    const s = sys();
    let changes = 0;
    const d = new DbgModule({ onChange: () => changes++ });
    s.addPeripheral(d, [DBG_RANGE]);
    s.reset();
    expect(DBG_RANGE).toEqual([0x20, 0x2f]);
    expect(addr('DBGXAH')).toBe(0x29);
    // comparator A: CPU, write, BRK, enabled at global $7FC123, data $1234 mask $FFFF
    s.poke(0x20, 0x00);
    for (const [a, v] of [
      [0x28, 0x15],
      [0x29, 0x7f],
      [0x2a, 0xc1],
      [0x2b, 0x23],
      [0x2c, 0x12],
      [0x2d, 0x34],
      [0x2e, 0xff],
      [0x2f, 0xff],
    ] as const)
      s.poke(a, v);
    s.poke(0x20, 0x01); // COMRV = B
    s.poke(0x28, 0x01);
    s.poke(0x2b, 0x55);
    s.poke(0x2c, 0x99); // B has no data registers
    expect(s.peek(0x2c)).toBe(0);
    const [a, b] = d.comparators();
    expect(a).toMatchObject({ name: 'A', enabled: true, brk: true, access: 'write', source: 'cpu', address: 0x7fc123, data: 0x1234, dataMask: 0xffff });
    expect(b).toMatchObject({ name: 'B', enabled: true, address: 0x55, data: 0 });
    s.poke(0x20, 0x00);
    expect(s.peek(0x2a)).toBe(0xc1);
    s.poke(0x27, 0x05);
    expect(s.peek(0x27)).toBe(0x05);
    s.poke(0x20, 0x80); // ARM
    expect(s.peek(0x21)).toBe(0x01);
    expect(s.peek(0x27)).toBe(0); // DBGMFR
    s.poke(0x2a, 0x00); // locked
    expect(d.comparators()[0].address).toBe(0x7fc123);
    s.poke(0x20, 0xc0);
    expect(s.peek(0x20)).toBe(0x80); // TRIG reads 0
    expect(s.events.filter((e) => e.message.includes('S12XDBG')).length).toBe(1);
    expect(changes).toBeGreaterThan(10);
    const snap = d.snapshot();
    s.reset();
    expect(d.armed).toBe(false);
    d.restore(snap);
    expect(d.armed).toBe(true);
  });
});

describe('XGATE and MSCAN stubs', () => {
  it('XGATE: reset values, masked XGMCTL writes, XGIF W1C, read-only XGCHID, warns', () => {
    const s = sys();
    const x = new XgateStub();
    s.addPeripheral(x, [XGATE_RANGE]);
    s.reset();
    expect(XGATE_RANGE).toEqual([0x380, 0x3bf]);
    // 16-bit write $8080 = XGEM|XGE -> XGE set
    s.bus.regWrite(0x380, 0x80, 5);
    s.bus.regWrite(0x381, 0x80, 5);
    expect(s.peek(0x381)).toBe(0x80);
    expect(s.peek(0x380)).toBe(0);
    expect(x.enabled).toBe(true);
    // byte write to the low byte alone: mask 0 -> no change
    s.bus.regWrite(0x381, 0x00, 9);
    expect(s.peek(0x381)).toBe(0x80);
    x.setReg(0x397, 0xff);
    s.poke(0x397, 0x0f);
    expect(s.peek(0x397)).toBe(0xf0);
    s.poke(0x382, 0x12);
    expect(s.peek(0x382)).toBe(0);
    s.poke(0x3a2, 0x34);
    expect(s.peek(0x3a2)).toBe(0x34);
    const msgs = s.events.map((e) => e.message);
    expect(msgs.filter((m) => m.includes('XGATE is not simulated')).length).toBe(1);
    expect(msgs.some((m) => m.includes('XGE=1'))).toBe(true);
  });

  it('MSCAN: device reset values, INITAK follows INITRQ, RFLG W1C, one warning per module', () => {
    const s = sys();
    const cans = [0, 1, 2, 3, 4].map((i) => new CanStub(i));
    cans.forEach((c, i) => s.addPeripheral(c, [CAN_RANGES[i]]));
    s.reset();
    expect(CAN_BASES).toEqual([0x140, 0x180, 0x1c0, 0x200, 0x280]);
    expect(s.peek(0x140)).toBe(registerByName('CAN0CTL0')!.reset);
    expect(s.peek(0x141)).toBe(0x11);
    expect(s.peek(0x146)).toBe(0x07);
    s.poke(0x140, 0x00); // leave init mode
    expect(s.peek(0x141) & 0x01).toBe(0);
    s.poke(0x140, 0x01);
    expect(s.peek(0x141) & 0x01).toBe(1);
    cans[0].setReg(0x144, 0xc3);
    s.poke(0x144, 0x40);
    expect(s.peek(0x144)).toBe(0x83);
    s.poke(0x284, 0);
    const msgs = s.events.map((e) => e.message).filter((m) => m.includes('not simulated'));
    expect(msgs).toEqual([expect.stringContaining('CAN0'), expect.stringContaining('CAN4')]);
    const snap = cans[0].snapshot();
    s.poke(0x140, 0x00);
    cans[0].restore(snap);
    expect(s.peek(0x140)).toBe(0x01);
  });
});
