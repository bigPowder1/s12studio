/**
 * Golden checks against CodeWarrior's own compiled mc9s12xdp512.c (test/data/cw-mc9s12xdp512.json: ELF symbol
 * addresses/sizes + DWARF bit fields), the blank_project fixture, and regression tests for the review findings.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MC9S12XDP512,
  REGISTERS,
  REGISTER_ALIASES,
  VECTORS,
  WINDOWS,
  bitField,
  byteHalves,
  generateIncFile,
  localToGlobal,
  mask,
  registerByAddress,
  registerByName,
  registerHalves,
  vectorAddress,
  vectorByAddress,
  vectorByName,
  w1cMaskOf,
  windowToGlobal,
} from '../src/index.js';
import type { RegisterDef } from '../src/index.js';
import { readFixture, describeFx } from '../../formats/test/fixtures.js';

type CwBit = [string, number, number];
type CwEntry = [number, number, CwBit[], Array<[string, CwBit[]]>];
const CW = (
  JSON.parse(readFileSync(new URL('./data/cw-mc9s12xdp512.json', import.meta.url), 'utf8')) as {
    registers: Record<string, CwEntry>;
  }
).registers;

/** C identifiers in CW's header -> .inc/datasheet names. */
const norm = (n: string) => n.replace(/_(bit|grp)$/, '');
/** CW group fields that only restate the byte halves (FADDR.FADDRHI_grp = FADDRHI); we model them as halves. */
const SKIP_FIELDS = new Set(['FADDR.FADDRHI_grp', 'FADDR.FADDRLO_grp', 'FDATA.FDATAHI_grp', 'FDATA.FDATALO_grp']);

function checkBits(name: string, ours: RegisterDef | undefined, cw: CwBit[], problems: string[]): void {
  if (!ours) {
    problems.push(`${name}: missing`);
    return;
  }
  for (const [bn, lsb, width] of cw) {
    if (SKIP_FIELDS.has(`${name}.${bn}`)) continue;
    const f = ours.bits?.find((b) => b.name === norm(bn));
    if (!f || f.bit !== lsb || f.width !== width)
      problems.push(`${name}.${norm(bn)}: CW ${lsb}/${width}, ours ${f ? `${f.bit}/${f.width}` : 'missing'}`);
  }
}

describe('CodeWarrior golden (mc9s12xdp512.c.o)', () => {
  const entries = Object.entries(CW);

  it('covers all 647 CW register symbols with the same address and size', () => {
    expect(entries).toHaveLength(647);
    const bad: string[] = [];
    for (const [name, [address, size]] of entries) {
      const r = registerByName(name);
      if (!r || r.address !== address || r.size !== size) bad.push(`${name}: CW $${address.toString(16)}/${size}`);
    }
    expect(bad).toEqual([]);
  });

  it('byte-overlay names (halves, composites, banked alternates) resolve to the right byte', () => {
    const bad: string[] = [];
    for (const [name, [address, size, , overlaps]] of entries)
      overlaps.forEach(([ov], i) => {
        const r = registerByName(ov);
        const want = size === 2 ? address + i : address;
        if (!r || r.address !== want || r.size !== 1) bad.push(`${name}/${ov}: want $${want.toString(16)}`);
      });
    expect(bad).toEqual([]);
  });

  it('every CW bit and field exists in our table with the same position and width', () => {
    const problems: string[] = [];
    for (const [name, [, , bits, overlaps]] of entries) {
      checkBits(name, registerByName(name), bits, problems);
      for (const [ov, ovBits] of overlaps) if (ov !== name) checkBits(ov, registerByName(ov), ovBits, problems);
    }
    expect(problems).toEqual([]);
  });

  it('byte-half names of 16-bit registers match CW exactly (finding 2: MCCNThi, TC0Hhi, CAN0RXTSRH)', () => {
    const bad: string[] = [];
    for (const r of REGISTERS) {
      const cw = CW[r.name];
      if (!cw || r.size !== 2 || cw[3].length !== 2 || /^SCI\dBD$/.test(r.name)) continue;
      const cwHalves = cw[3].map(([n]) => n);
      if (JSON.stringify(r.halves) !== JSON.stringify(cwHalves)) bad.push(`${r.name}: CW ${cwHalves} ours ${r.halves}`);
    }
    expect(bad).toEqual([]);
    expect(registerByName('MCCNT')!.halves).toEqual(['MCCNThi', 'MCCNTlo']);
    expect(registerByName('TC2H')!.halves).toEqual(['TC2Hhi', 'TC2Hlo']);
    expect(registerByName('CAN3TXTSR')!.halves).toEqual(['CAN3TXTSRH', 'CAN3TXTSRL']);
  });

  it('our only names beyond CW are test registers and the datasheet SCI baud byte names', () => {
    const cwNames = new Set<string>();
    for (const [n, [, , , ov]] of entries) {
      cwNames.add(n);
      for (const [o] of ov) cwNames.add(o);
    }
    const extra = [...REGISTERS, ...REGISTER_ALIASES, ...registerHalves()].map((r) => r.name).filter((n) => !cwNames.has(n));
    for (const n of extra) expect(n).toMatch(/^(CTFLG|FORBYP|CTCTL|TIMTST|ATD[01]TEST0|VREGHTCL|PWMTST|PWMPRSC|PWMSCNT[AB]|SCI\dBD[HL])$/);
  });
});

describe('review findings (regressions)', () => {
  it('F1: registerByName resolves byte halves as 1-byte views with their bits', () => {
    const cases: Array<[string, number, string]> = [
      ['SCI0BDH', 0x00c8, '16-bit SCI0BD high'],
      ['SCI0BDL', 0x00c9, 'low'],
      ['TCNTHi', 0x0044, ''],
      ['TCNTLo', 0x0045, ''],
      ['PARTIDH', 0x001a, ''],
      ['ATD0DR0H', 0x02d0, ''],
      ['FADDRHI', 0x0108, ''],
      ['MCCNTlo', 0x0077, ''],
      ['CAN0RXTSRL', 0x016f, ''],
    ];
    for (const [n, a] of cases) {
      const r = registerByName(n);
      expect(r, n).toBeDefined();
      expect(r!.address, n).toBe(a);
      expect(r!.size, n).toBe(1);
      expect('half' in r! && r.half, n).toBe(a % 2 === 0 ? 'high' : 'low');
    }
    expect(registerByName('sci0bdl')!.name).toBe('SCI0BDL');
    expect(mask('SCI0BDH', 'IREN')).toBe(0x80);
    expect(mask('SCI0BDH', 'TNP')).toBe(0x60);
    expect(mask('SCI0BDL', 'SBR0')).toBe(0x01);
    expect(mask('PARTIDH', 'ID15')).toBe(0x80);
    expect(mask('EADDRHI', 'EABHI')).toBe(0x07);
    expect(registerByName('PARTIDL')!.reset).toBe(0x10);
    expect(registerByName('SCI0BDL')!.reset).toBe(0x04);
    // canonical names still win over halves; registerByAddress still returns the canonical register
    expect(registerByName('PORTA')!.size).toBe(1);
    expect(registerByAddress(0xc9)!.name).toBe('SCI0BD');
    expect(byteHalves(registerByName('TC0')! as RegisterDef).map((h) => h.name)).toEqual(['TC0Hi', 'TC0Lo']);
    expect(byteHalves(registerByName('PTP')! as RegisterDef)).toEqual([]);
  });

  it('F3: Port J has bits 7,6,5,4,2,1,0 and Vportj lists PIFJ4/5 and PIEJ4/5', () => {
    for (const reg of ['PTJ', 'PTIJ', 'DDRJ', 'RDRJ', 'PERJ', 'PPSJ', 'PIEJ', 'PIFJ']) {
      expect(mask(reg, `${reg}5`), reg).toBe(0x20);
      expect(mask(reg, `${reg}4`), reg).toBe(0x10);
      expect(bitField(reg, `${reg}3`), reg).toBeUndefined();
    }
    const v = vectorByName('Vportj')!;
    expect(v.flags).toEqual(expect.arrayContaining(['PIFJ.PIFJ4', 'PIFJ.PIFJ5']));
    expect(v.enables).toEqual(expect.arrayContaining(['PIEJ.PIEJ4', 'PIEJ.PIEJ5']));
  });

  it('F4-F7: ECLKCTL, FSTAT/ESTAT.FAIL, MMCCTL0.CS3E, RAMWPC.RWPE', () => {
    expect(registerByName('ECLKCTL')!.bits!.map((b) => b.name)).toEqual(['NECLK', 'NCLKX2', 'EDIV', 'EDIV1', 'EDIV0']);
    expect(mask('ECLKCTL', 'EDIV')).toBe(0x03);
    expect(mask('FSTAT', 'FAIL')).toBe(0x02);
    expect(mask('ESTAT', 'FAIL')).toBe(0x02);
    expect(mask('MMCCTL0', 'CS3E')).toBe(0x08);
    expect(mask('RAMWPC', 'RWPE')).toBe(0x80);
    expect(bitField('RAMWPC', 'RPWE')).toBeUndefined();
  });

  it('F8: CodeWarrior bit names for ports, PARTID, IIC data, flash/EEPROM protection, DBG', () => {
    expect(mask('PORTB', 'PB0')).toBe(0x01);
    expect(mask('DDRA', 'DDRA7')).toBe(0x80);
    expect(mask('PORTE', 'PE1')).toBe(0x02);
    expect(mask('DDRE', 'DDRE2')).toBe(0x04);
    expect(mask('PORTK', 'PK7')).toBe(0x80);
    expect(mask('PARTID', 'ID15')).toBe(0x8000);
    expect(mask('IIC0_IBDR', 'D7')).toBe(0x80);
    expect(mask('FSEC', 'RNV2')).toBe(0x04);
    expect(mask('FPROT', 'RNV6')).toBe(0x40);
    expect(mask('EPROT', 'EPS')).toBe(0x07);
    expect(mask('EPROT', 'RNV4')).toBe(0x10);
    expect(mask('PT0AD1', 'PT0AD116')).toBe(0x01);
    expect(mask('PT1AD1', 'PT1AD115')).toBe(0x80);
    expect(mask('DBGXAH', 'BIT22')).toBe(0x40);
    expect(mask('DBGXCTL', 'NDB_SZ')).toBe(0x40);
    expect(mask('DBGTCR', 'TALIGN')).toBe(0x03);
    expect(bitField('ATD0CTL5', 'CD')).toBeUndefined();
    expect(mask('ATD1CTL5', 'CD')).toBe(0x08);
    const mfr = registerByName('DBGMFR')!;
    expect(mfr.address).toBe(0x27);
    expect(mask('DBGMFR', 'MC3')).toBe(0x08);
    expect(bitField('PORTB', 'BIT0')).toBeUndefined();
    // composites carry both bytes' bits
    expect(mask('PORTAB', 'PA0')).toBe(0x0100);
    expect(mask('ATD0CTL23', 'ASCIF')).toBe(0x0100);
    expect(mask('ATD1DIEN', 'IEN')).toBe(0xffff);
    expect(mask('ATD1DIEN', 'IEN15')).toBe(0x8000);
    expect(registerByName('PWMDTY01')!.bits).toBeUndefined();
  });

  it('F9/F10: every register with a w1cMask has access w1c (CRGINT.ILAF, LVIF, APIF, PWMIF)', () => {
    for (const r of [...REGISTERS, ...REGISTER_ALIASES]) if (r.w1cMask !== undefined) expect(r.access, r.name).toBe('w1c');
    expect(w1cMaskOf(registerByName('CRGINT')!)).toBe(0x40);
    expect(w1cMaskOf(registerByName('VREGCTRL')!)).toBe(0x01);
    expect(w1cMaskOf(registerByName('VREGAPICL')!)).toBe(0x01);
    expect(w1cMaskOf(registerByName('PWMSDN')!)).toBe(0x80);
    expect(w1cMaskOf(registerByName('TFLG1')!)).toBe(0xff);
    expect(w1cMaskOf(registerByName('PTP')!)).toBe(0);
    expect(w1cMaskOf(registerByName('CAN0RFLG')!)).toBe(0xc3);
  });

  it('F11: every vector flag/enable is a REG.BIT that resolves in the register table', () => {
    const bad: string[] = [];
    for (const v of VECTORS)
      for (const ref of [...v.flags, ...v.enables]) {
        const m = /^(\w+)\.(\w+)$/.exec(ref);
        if (!m || !bitField(m[1], m[2])) bad.push(`${v.name}: ${ref}`);
      }
    expect(bad).toEqual([]);
    expect(vectorByName('Vporth')!.flags).toHaveLength(8);
    expect(vectorByName('Vsci3')!.enables).toContain('SCI3CR2.RIE');
    expect(vectorByName('Vcan2rx')!.flags).toEqual(['CAN2RFLG.RXF']);
    expect(vectorByName('Vcan0tx')!.enables).toEqual(['CAN0TIER.TXEIE0', 'CAN0TIER.TXEIE1', 'CAN0TIER.TXEIE2']);
    expect(vectorByName('Vxsei')!.flags).toEqual(['XGMCTL.XGSWEIF']);
  });

  it('F12: every fixed window spans one page and agrees with localToGlobal at every 256-byte step', () => {
    for (const w of WINDOWS)
      for (let a = w.localStart; a <= w.localEnd; a += 0x100) {
        expect(windowToGlobal(w, a), `${w.name} $${a.toString(16)}`).toBe(localToGlobal(a));
        expect(windowToGlobal(w, a + 0xff), w.name).toBe(localToGlobal(a + 0xff));
      }
    const ramHi = WINDOWS.find((w) => w.localStart === 0x3000)!;
    expect(ramHi.fixedPage).toBe(0xff);
    expect(windowToGlobal(ramHi, 0x3000)).toBe(0x0ff000);
    const eWin = WINDOWS.find((w) => w.pageRegister === 'EPAGE')!;
    expect(windowToGlobal(eWin, 0x0800, 0xfc)).toBe(0x13f000);
    expect(() => windowToGlobal(eWin, 0x0c00)).toThrow();
  });

  it('F13: vectorByAddress honours IVBR and inverts vectorAddress', () => {
    for (const ivbr of [0xff, 0xc0, 0x40])
      for (const v of VECTORS) expect(vectorByAddress(vectorAddress(v, ivbr), ivbr)?.name, `${v.name}@${ivbr}`).toBe(v.name);
    expect(vectorByAddress(0xc0ce, 0xc0)!.name).toBe('Vportj');
    expect(vectorByAddress(0xffce, 0xc0)).toBeUndefined(); // the $FF table is not in use any more
    expect(vectorByAddress(0xfffe, 0xc0)!.name).toBe('Vreset'); // fixed
    expect(vectorByAddress(0xc0fe, 0xc0)).toBeUndefined(); // reset does not move with IVBR
    expect(vectorByAddress(0xc00e, 0xc0)).toBeUndefined(); // below the table
    expect(vectorByAddress(0xffce)!.name).toBe('Vportj');
  });
});

describeFx('blank_project fixture (F14)', () => {
  it('S19 vectors are exactly Vportj -> ISR_KEYPAD and Vreset -> Entry ($C000)', () => {
    const s19 = readFixture('blank_project', 'bin', 'Project.abs.s19').toString('latin1');
    const recs = [...s19.matchAll(/^S105(FF[0-9A-F]{2})([0-9A-F]{4})/gm)].map((m) => [m[1], m[2]]);
    const map = readFixture('blank_project', 'bin', 'Project.map').toString('latin1');
    // the keypad ISR's address is read from the map (library code: not repeated here)
    const isr = /ISR_KEYPAD\s+([0-9A-F]+)\s/.exec(map)![1].padStart(4, '0');
    expect(recs.sort()).toEqual([
      ['FFCE', isr],
      ['FFFE', 'C000'],
    ]);
    expect(recs.map(([a]) => vectorByAddress(parseInt(a, 16))!.name).sort()).toEqual(['Vportj', 'Vreset']);
    expect(map).toMatch(/Entry point: 0xC000/);
  });

  it("derivative.inc INCLUDEs the file name generateIncFile's header advertises", () => {
    const deriv = readFixture('blank_project', 'Sources', 'derivative.inc').toString('latin1');
    const m = /INCLUDE\s+'([^']+)'/.exec(deriv)!;
    expect(m[1]).toBe(`${MC9S12XDP512.name.toLowerCase()}.inc`);
    expect(generateIncFile(MC9S12XDP512)).toContain(`INCLUDE '${m[1]}'`);
  });

  it('main.asm ORG addresses are named vectors and point at registers/RAM/flash correctly', () => {
    const src = readFixture('blank_project', 'Sources', 'main.asm').toString('latin1');
    const orgs = [...src.matchAll(/^\s*ORG\s+\$([0-9A-F]{4})/gim)].map((x) => parseInt(x[1], 16));
    expect(orgs.length).toBeGreaterThanOrEqual(2);
    for (const a of orgs.filter((x) => x >= 0xff10)) expect(vectorByAddress(a), a.toString(16)).toBeDefined();
  });
});
