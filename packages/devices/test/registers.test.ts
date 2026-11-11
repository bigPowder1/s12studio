import { describe, expect, it } from 'vitest';
import {
  ME3305_MASKS,
  REGISTERS,
  REGISTER_ALIASES,
  addr,
  mask,
  parseBits,
  registerByAddress,
  registerByName,
} from '../src/index.js';

describe('register table', () => {
  // Addresses used by the ME3305 library and Lab3 (datasheet Table 1-1 / App. G via docs/research/r2).
  const expected: Record<string, number> = {
    PORTA: 0x0000, PORTB: 0x0001, DDRA: 0x0002, DDRB: 0x0003, PORTE: 0x0008, DDRE: 0x0009,
    MMCCTL0: 0x000a, MODE: 0x000b, PUCR: 0x000c, RDRIV: 0x000d, EBICTL0: 0x000e, EBICTL1: 0x000f,
    GPAGE: 0x0010, DIRECT: 0x0011, MMCCTL1: 0x0013, RPAGE: 0x0016, EPAGE: 0x0017,
    PARTID: 0x001a, PARTIDH: 0x001a, PARTIDL: 0x001b, ECLKCTL: 0x001c, IRQCR: 0x001e,
    PPAGE: 0x0030, PORTK: 0x0032, DDRK: 0x0033,
    SYNR: 0x0034, REFDV: 0x0035, CRGFLG: 0x0037, CRGINT: 0x0038, CLKSEL: 0x0039, PLLCTL: 0x003a,
    RTICTL: 0x003b, COPCTL: 0x003c, ARMCOP: 0x003f,
    TIOS: 0x0040, CFORC: 0x0041, TCNT: 0x0044, TSCR1: 0x0046, TCTL2: 0x0049, TIE: 0x004c, TSCR2: 0x004d,
    TFLG1: 0x004e, TFLG2: 0x004f, TC0: 0x0050, TC1: 0x0052, TC7: 0x005e, PACTL: 0x0060, PACN32: 0x0062,
    MCCTL: 0x0066, MCCNT: 0x0076, TC0H: 0x0078, TC3H: 0x007e,
    ATD1CTL2: 0x0082, ATD1CTL3: 0x0083, ATD1CTL4: 0x0084, ATD1CTL5: 0x0085, ATD1STAT0: 0x0086,
    ATD1DIEN0: 0x008c, ATD1DIEN1: 0x008d, ATD1DR0: 0x0090, ATD1DR7: 0x009e, ATD1DR15: 0x00ae,
    IIC1_IBAD: 0x00b0, SCI2BDH: 0x00b8, SCI3BD: 0x00c0, SCI0BD: 0x00c8, SCI0CR2: 0x00cb, SCI0DRL: 0x00cf,
    SCI1BD: 0x00d0,
    SPI0CR1: 0x00d8, SPI0CR2: 0x00d9, SPI0BR: 0x00da, SPI0SR: 0x00db, SPI0DR: 0x00dd,
    IIC0_IBAD: 0x00e0, SPI1CR1: 0x00f0, SPI2CR1: 0x00f8,
    FCLKDIV: 0x0100, FSEC: 0x0101, FCNFG: 0x0103, FPROT: 0x0104, FSTAT: 0x0105, FCMD: 0x0106, FCTL: 0x0107,
    FADDR: 0x0108, FDATA: 0x010a, ECLKDIV: 0x0110, ECNFG: 0x0113, EPROT: 0x0114, ESTAT: 0x0115, ECMD: 0x0116,
    EADDR: 0x0118, EDATA: 0x011a, RAMWPC: 0x011c,
    IVBR: 0x0121, INT_XGPRIO: 0x0126, INT_CFADDR: 0x0127, INT_CFDATA0: 0x0128, INT_CFDATA7: 0x012f,
    SCI4BD: 0x0130, SCI5BD: 0x0138, CAN0CTL0: 0x0140, CAN1CTL0: 0x0180, CAN2CTL0: 0x01c0, CAN3CTL0: 0x0200,
    CAN4CTL0: 0x0280,
    PTT: 0x0240, PTIT: 0x0241, DDRT: 0x0242, PERT: 0x0244, PPST: 0x0245, PTS: 0x0248, PERS: 0x024c,
    PTM: 0x0250, DDRM: 0x0252, PERM: 0x0254, PPSM: 0x0255, MODRR: 0x0257,
    PTP: 0x0258, PTIP: 0x0259, DDRP: 0x025a, PERP: 0x025c, PPSP: 0x025d, PIEP: 0x025e, PIFP: 0x025f,
    PTH: 0x0260, DDRH: 0x0262, PERH: 0x0264, PPSH: 0x0265, PIEH: 0x0266, PIFH: 0x0267,
    PTJ: 0x0268, PTIJ: 0x0269, DDRJ: 0x026a, PERJ: 0x026c, PPSJ: 0x026d, PIEJ: 0x026e, PIFJ: 0x026f,
    PT1AD0: 0x0271, PER1AD0: 0x0277, PT0AD1: 0x0278, PER1AD1: 0x027f,
    ATD0CTL2: 0x02c2, ATD0STAT0: 0x02c6, ATD0DIEN: 0x02cd, ATD0PTAD0: 0x02cf, ATD0DR0: 0x02d0, ATD0DR7: 0x02de,
    VREGCTRL: 0x02f1, VREGAPICL: 0x02f2, VREGAPIR: 0x02f4,
    PWME: 0x0300, PWMPOL: 0x0301, PWMCLK: 0x0302, PWMPRCLK: 0x0303, PWMCAE: 0x0304, PWMCTL: 0x0305,
    PWMSCLA: 0x0308, PWMCNT0: 0x030c, PWMPER0: 0x0314, PWMPER01: 0x0314, PWMDTY0: 0x031c, PWMDTY01: 0x031c,
    PWMDTY7: 0x0323, PWMSDN: 0x0324,
    PITCFLMT: 0x0340, PITTF: 0x0345, PITMTLD0: 0x0346, PITLD0: 0x0348, PITCNT0: 0x034a, PITLD3: 0x0354,
    PITCNT3: 0x0356,
    XGMCTL: 0x0380, XGVBR: 0x0386, XGIF_7F_70: 0x0388, XGIF_0F_00: 0x0396, XGSWT: 0x0398, XGPC: 0x039e,
    XGR1: 0x03a2, XGR7: 0x03ae,
    DBGC1: 0x0020, DBGTB: 0x0024, DBGXDLM: 0x002f,
  };
  for (const [name, a] of Object.entries(expected)) {
    it(`${name} = $${a.toString(16).toUpperCase().padStart(4, '0')}`, () => {
      // Halves (PARTIDH, SCI2BDH) resolve via the 16-bit register; check those by name lookup of the owner.
      const r = registerByName(name);
      if (r) expect(r.address).toBe(a);
      else expect(registerByAddress(a)?.halves).toContain(name);
    });
  }

  it('has no duplicate names (case-insensitive) across registers, aliases and byte halves', () => {
    const names = new Map<string, number>();
    const add = (n: string) => names.set(n.toUpperCase(), (names.get(n.toUpperCase()) ?? 0) + 1);
    for (const r of REGISTERS) {
      add(r.name);
      if (r.halves) r.halves.forEach(add);
    }
    for (const r of REGISTER_ALIASES) add(r.name);
    const dups = [...names].filter(([, c]) => c > 1).map(([n]) => n);
    expect(dups).toEqual([]);
  });

  it('has no overlapping canonical register addresses and stays inside $0000-$07FF', () => {
    const used = new Map<number, string>();
    for (const r of REGISTERS) {
      for (let i = 0; i < r.size; i++) {
        const a = r.address + i;
        expect(used.get(a), `${r.name} overlaps ${used.get(a)} at $${a.toString(16)}`).toBeUndefined();
        used.set(a, r.name);
        expect(a).toBeLessThan(0x800);
      }
    }
    expect(REGISTERS.length).toBeGreaterThan(500);
  });

  it('is sorted by address and 16-bit registers are word-aligned', () => {
    for (let i = 1; i < REGISTERS.length; i++) expect(REGISTERS[i].address).toBeGreaterThan(REGISTERS[i - 1].address);
    for (const r of REGISTERS) if (r.size === 2) expect(r.address % 2, r.name).toBe(0);
  });

  it('aliases overlay existing canonical registers', () => {
    for (const a of REGISTER_ALIASES) {
      const owner = registerByAddress(a.address);
      expect(owner, a.name).toBeDefined();
      for (const n of a.aliasOf) expect(registerByName(n), `${a.name} -> ${n}`).toBeDefined();
      if (a.composite) {
        const [hi, lo] = a.aliasOf.map((n) => registerByName(n)!);
        expect(lo.address).toBe(hi.address + 1);
        expect(a.reset).toBe((hi.reset << 8) | lo.reset);
      }
    }
  });

  it('bit layouts are consistent: bits fit, no two single bits share a position', () => {
    for (const r of [...REGISTERS, ...REGISTER_ALIASES]) {
      if (!r.bits) continue;
      const seen = new Set<number>();
      const names = new Set<string>();
      for (const b of r.bits) {
        expect(b.bit + b.width, `${r.name}.${b.name}`).toBeLessThanOrEqual(r.size * 8);
        expect(names.has(b.name), `${r.name}.${b.name} dup`).toBe(false);
        names.add(b.name);
        if (b.width === 1) {
          expect(seen.has(b.bit), `${r.name} bit ${b.bit}`).toBe(false);
          seen.add(b.bit);
        }
      }
    }
  });

  it('reset values (research §11, critique C7/C9)', () => {
    const reset = (n: string) => registerByName(n)!.reset;
    expect(reset('RPAGE')).toBe(0xfd);
    expect(reset('EPAGE')).toBe(0xfe);
    expect(reset('PPAGE')).toBe(0xfe);
    expect(reset('GPAGE')).toBe(0x00);
    expect(reset('DIRECT')).toBe(0x00);
    expect(reset('IVBR')).toBe(0xff);
    expect(reset('PLLCTL')).toBe(0xf1);
    expect(reset('PUCR')).toBe(0xd0);
    expect(reset('IRQCR')).toBe(0x40);
    expect(reset('INT_CFDATA3')).toBe(0x01);
    expect(reset('COPCTL')).toBe(0x00);
    expect(reset('FCTL')).toBe(0xff);
    expect(reset('SPI0SR')).toBe(0x20);
    expect(reset('PWMPER01')).toBe(0xffff);
  });

  it('access classes for flag registers', () => {
    for (const n of ['TFLG1', 'TFLG2', 'PIFJ', 'PIFH', 'PIFP', 'CRGFLG', 'PITTF', 'FSTAT', 'ESTAT'])
      expect(registerByName(n)!.access, n).toBe('w1c');
    expect(registerByName('FCTL')!.access).toBe('r');
    expect(registerByName('DIRECT')!.access).toBe('rw-once');
    expect(registerByName('CRGFLG')!.w1cMask).toBe(0xf2);
  });

  it('ME3305 masks match the bit table', () => {
    for (const [key, value] of Object.entries(ME3305_MASKS)) {
      const i = key.indexOf('_');
      expect(mask(key.slice(0, i), key.slice(i + 1)), key).toBe(value);
    }
    expect(mask('SYNR', 'SYN')).toBe(0x3f);
    expect(mask('TSCR2', 'PR')).toBe(0x07);
    expect(mask('SPI0BR', 'SPPR')).toBe(0x70);
  });

  it('registerByAddress resolves both bytes of 16-bit registers', () => {
    expect(registerByAddress(0x44)?.name).toBe('TCNT');
    expect(registerByAddress(0x45)?.name).toBe('TCNT');
    expect(registerByAddress(0x31)).toBeUndefined();
    expect(registerByAddress(0x0500)).toBeUndefined();
    expect(registerByName('pwmdty01')?.name).toBe('PWMDTY01');
  });

});

describe('parseBits', () => {
  it('expands fields, port bits and data registers', () => {
    expect(parseBits('- - SYN[6]', 1).map((b) => `${b.name}:${b.bit}/${b.width}`)).toEqual([
      'SYN:0/6', 'SYN5:5/1', 'SYN4:4/1', 'SYN3:3/1', 'SYN2:2/1', 'SYN1:1/1', 'SYN0:0/1',
    ]);
    expect(parseBits('DP[15:8]', 1)[1]).toEqual({ name: 'DP15', bit: 7, width: 1 });
    expect(parseBits('PTP#8', 1).map((b) => b.name)).toEqual(['PTP7', 'PTP6', 'PTP5', 'PTP4', 'PTP3', 'PTP2', 'PTP1', 'PTP0']);
    expect(parseBits('D', 2)).toHaveLength(16);
    // field-only token (CW defines just the group, e.g. DBGC1.COMRV)
    expect(parseBits('ARM - - - DBGBRK(2) COMRV(2)', 1)).toEqual([
      { name: 'ARM', bit: 7, width: 1 },
      { name: 'DBGBRK', bit: 2, width: 2 },
      { name: 'COMRV', bit: 0, width: 2 },
    ]);
    expect(() => parseBits('X(9)', 1)).toThrow();
    expect(() => parseBits('A B', 1)).toThrow();
  });
});
