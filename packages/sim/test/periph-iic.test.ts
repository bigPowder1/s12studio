import { describe, expect, it } from 'vitest';
import { S12XSystem, createBoardNets } from '@s12/sim';
import { addr } from '@s12/devices';
import { IIC_BASES, IIC_RANGES, IIC_VECTORS, IicModule, iicSclDivider } from '../src/periph/iic';

function rig(index: 0 | 1 = 0) {
  const s = new S12XSystem({ ramInit: 'zero' });
  const iic = new IicModule(createBoardNets(), { index });
  s.addPeripheral(iic, [IIC_RANGES[index]]);
  s.reset();
  [0x20, 0xfe].forEach((b, i) => s.poke(0x4f00 + i, b)); // BRA *
  const wait = (n: number) => {
    s.setRegisters({ pc: 0x4f00 });
    s.run(n);
  };
  const rd = (a: number) => s.bus.regRead(a, s.totalCycles);
  const wr = (a: number, v: number) => s.bus.regWrite(a, v, s.totalCycles);
  return { s, iic, wait, rd, wr };
}

const IBAD = 0xe0;
const IBFD = 0xe1;
const IBCR = 0xe2;
const IBSR = 0xe3;
const IBDR = 0xe4;

describe('IIC stub', () => {
  it('bases/vectors from @s12/devices', () => {
    expect(IIC_BASES).toEqual([addr('IIC0_IBAD'), addr('IIC1_IBAD')]);
    expect(IIC_BASES).toEqual([0xe0, 0xb0]);
    expect(IIC_VECTORS).toEqual([0xc0, 0x82]);
  });

  it('reset values and register masks', () => {
    const { s } = rig();
    expect([IBAD, IBFD, IBCR, IBSR, IBDR, 0xe5].map((a) => s.peek(a))).toEqual([0, 0, 0, 0x80, 0, 0]);
    s.poke(IBAD, 0xff);
    s.poke(IBCR, 0x04 | 0x02); // RSTA write-only, bit 1 reserved
    expect([s.peek(IBAD), s.peek(IBCR)]).toEqual([0xfe, 0]);
  });

  it('SCL divider table', () => {
    expect(iicSclDivider(0x00)).toBe(20);
    expect(iicSclDivider(0x07)).toBe(40);
    expect(iicSclDivider(0x40)).toBe(40);
  });

  it('SCL divider matches the S12IICV2 V02.08 divider table, incl. the IBC5-3=%011 rows (tap2tap 8, regression)', () => {
    const table: Record<number, number> = {
      0x08: 28, 0x0f: 68, 0x10: 48, 0x17: 128, 0x18: 80, 0x19: 96, 0x1b: 128, 0x1e: 192, 0x1f: 240, 0x20: 160, 0x3f: 3840,
      0x58: 160, 0x9f: 960,
    };
    for (const [ibfd, div] of Object.entries(table)) expect([Number(ibfd), iicSclDivider(Number(ibfd))]).toEqual([Number(ibfd), div]);
    const { wr, iic } = rig();
    wr(IBFD, 0x1f);
    expect(iic.byteCycles).toBe(9 * 240);
  });

  it('master transmit: START sets IBB, a byte completes after 9 SCL periods with IBIF/TCF and RXAK=1 (no device)', () => {
    const { s, wait, wr, rd } = rig();
    const line = () => s.bus.xint.line[0xc0 >> 1];
    wr(IBFD, 0x00);
    wr(IBCR, 0xc0); // IBEN IBIE
    expect(s.events.some((e) => e.kind === 'peripheral' && /IIC bus not modelled/.test(e.message))).toBe(true);
    wr(IBCR, 0xf0); // + MS_SL TX_RX -> START
    expect(s.peek(IBSR) & 0x20).toBe(0x20);
    wr(IBDR, 0xa0);
    expect(s.peek(IBSR) & 0x80).toBe(0);
    wait(9 * 20 + 5);
    expect(s.peek(IBSR) & 0x83).toBe(0x83); // TCF IBIF RXAK
    expect(line()).toBe(1);
    wr(IBSR, 0x02); // IBIF w1c
    expect(s.peek(IBSR) & 0x02).toBe(0);
    expect(line()).toBe(0);
    wr(IBCR, 0xd0); // STOP
    expect(s.peek(IBSR) & 0x20).toBe(0);
    rd(IBSR);
  });

  it('master receive returns $FF; disabling resets IBSR; snapshot/restore', () => {
    const { s, wait, wr, rd } = rig();
    wr(IBCR, 0xa0); // IBEN MS_SL (receive)
    rd(IBDR); // dummy read starts a byte
    const snap = s.snapshot();
    wait(200);
    expect(s.peek(IBDR)).toBe(0xff);
    expect(s.peek(IBSR) & 0x82).toBe(0x82);
    s.restore(snap);
    expect(s.peek(IBSR) & 0x80).toBe(0);
    wait(200);
    expect(s.peek(IBSR) & 0x82).toBe(0x82);
    wr(IBCR, 0);
    expect(s.peek(IBSR)).toBe(0x80);
  });
});
