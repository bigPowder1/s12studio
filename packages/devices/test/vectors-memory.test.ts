import { describe, expect, it } from 'vitest';
import {
  CPU_RESET,
  MMC_RESET,
  SEGMENTS,
  VECTORS,
  busClockHz,
  copResetFromNv,
  globalToFixedLocal,
  globalToLogical,
  localToGlobal,
  logicalToGlobal,
  regionOfGlobal,
  vectorAddress,
  vectorByAddress,
  vectorByName,
  vectorByOffset,
} from '../src/index.js';
import { readFixture, itFx } from '../../formats/test/fixtures.js';

describe('vectors', () => {
  it('covers every vector slot $FF10-$FFFE exactly once', () => {
    expect(VECTORS).toHaveLength(120);
    const offs = new Set(VECTORS.map((v) => v.offset));
    for (let o = 0x10; o <= 0xfe; o += 2) expect(offs.has(o), o.toString(16)).toBe(true);
    const names = new Set(VECTORS.map((v) => v.name.toLowerCase()));
    expect(names.size).toBe(VECTORS.length);
  });

  it('well-known addresses and CW numbers', () => {
    const at = (a: number) => vectorByAddress(a)?.name;
    expect(at(0xfffe)).toBe('Vreset');
    expect(at(0xfffc)).toBe('Vclkmon');
    expect(at(0xfffa)).toBe('Vcop');
    expect(at(0xfff8)).toBe('Vtrap');
    expect(at(0xfff6)).toBe('Vswi');
    expect(at(0xfff4)).toBe('Vxirq');
    expect(at(0xfff2)).toBe('Virq');
    expect(at(0xfff0)).toBe('Vrti');
    expect(at(0xffee)).toBe('Vtimch0');
    expect(at(0xffe0)).toBe('Vtimch7');
    expect(at(0xffde)).toBe('Vtimovf');
    expect(at(0xffd8)).toBe('Vspi0');
    expect(at(0xffd6)).toBe('Vsci0');
    expect(at(0xffd0)).toBe('Vatd1');
    expect(at(0xffce)).toBe('Vportj');
    expect(at(0xffcc)).toBe('Vporth');
    expect(at(0xffb6)).toBe('Vcan0wkup');
    expect(at(0xff90)).toBe('Vcan4tx');
    expect(at(0xff8e)).toBe('Vportp');
    expect(at(0xff7a)).toBe('Vpit0');
    expect(at(0xff74)).toBe('Vpit3');
    expect(at(0xff60)).toBe('Vxsramav');
    expect(at(0xff12)).toBe('Vsyscall');
    expect(at(0xff10)).toBe('Vsi');
    expect(vectorByName('Vportj')!.number).toBe(24); // prm: VECTOR 24 ISR_KEYPAD
    expect(vectorByName('Vreset')!.number).toBe(0);
    expect(vectorByName('vspurious')!.address).toBe(0xff10);
    expect(vectorByOffset(0xce)!.name).toBe('Vportj');
  });

  it('classification, masks, levels', () => {
    expect(vectorByName('Vreset')!.kind).toBe('reset');
    expect(vectorByName('Vxirq')!.mask).toBe('X');
    expect(vectorByName('Vswi')!.mask).toBeNull();
    expect(vectorByName('Virq')!.mask).toBe('I');
    expect(vectorByName('Vportj')!.defaultLevel).toBe(1);
    expect(vectorByName('Vportj')!.enables).toContain('PIEJ.PIEJ7');
    expect(vectorByName('Vportj')!.flags).toContain('PIFJ.PIFJ7');
    expect(vectorByName('Vtimch1')!.flags).toEqual(['TFLG1.C1F']);
    expect(vectorByName('Vrti')!.xgateChannel).toBe(0x78);
    const order = ['Vreset', 'Vclkmon', 'Vcop', 'Vtrap', 'Vswi', 'Vxirq', 'Virq', 'Vrti', 'Vportj'].map(
      (n) => vectorByName(n)!.priorityRank,
    );
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
  });

  it('IVBR relocation: only $FFFA-$FFFE are fixed', () => {
    expect(vectorAddress(vectorByName('Vportj')!, 0xc0)).toBe(0xc0ce);
    expect(vectorAddress(vectorByName('Vswi')!, 0xc0)).toBe(0xc0f6);
    expect(vectorAddress(vectorByName('Vreset')!, 0xc0)).toBe(0xfffe);
    expect(vectorAddress(vectorByName('Vcop')!, 0xc0)).toBe(0xfffa);
  });

  itFx('Lab3 vectors in the S19 are $FFFE and $FFCE', () => {
    const s19 = readFixture('Lab3', 'bin', 'Project.abs.s19').toString('latin1');
    const vecs = [...s19.matchAll(/^S105(FF[0-9A-F]{2})/gm)].map((m) => parseInt(m[1], 16));
    expect(vecs.sort()).toEqual([0xffce, 0xfffe]);
    expect(vecs.map((a) => vectorByAddress(a)!.name).sort()).toEqual(['Vportj', 'Vreset']);
  });
});

describe('memory map', () => {
  it('localToGlobal at reset page values', () => {
    expect(localToGlobal(0x4000)).toBe(0x7f4000);
    expect(localToGlobal(0xc000)).toBe(0x7fc000);
    expect(localToGlobal(0xfffe)).toBe(CPU_RESET.resetVectorGlobal);
    expect(localToGlobal(0x0800, { epage: 0xfe })).toBe(0x13f800);
    expect(localToGlobal(0x0c00)).toBe(0x13fc00);
    expect(localToGlobal(0x1000, { rpage: 0xfd })).toBe(0x0fd000);
    expect(localToGlobal(0x2000)).toBe(0x0fe000);
    expect(localToGlobal(0x3fff)).toBe(0x0fffff);
    expect(localToGlobal(0x8000)).toBe(0x7f8000);
    expect(localToGlobal(0x0258)).toBe(0x0258);
  });

  it('paging windows', () => {
    expect(localToGlobal(0x8000, { ppage: 0xe0 })).toBe(0x780000);
    expect(localToGlobal(0xbfff, { ppage: 0xff })).toBe(0x7fffff);
    expect(localToGlobal(0x0800, { epage: 0xfc })).toBe(0x13f000);
    expect(localToGlobal(0x1000, { rpage: 0xf8 })).toBe(0x0f8000);
    expect(localToGlobal(0x1fff, { rpage: 0xff })).toBe(0x0fffff);
    expect(localToGlobal(0x1000, { rpage: 0x00 })).toBe(0x000000); // RAM page 0 aliases the register block
  });

  it('reset MMC values', () => {
    expect(MMC_RESET).toEqual({ rpage: 0xfd, epage: 0xfe, ppage: 0xfe, gpage: 0, direct: 0 });
  });

  it('regions', () => {
    expect(regionOfGlobal(0x0f8000)?.kind).toBe('ram');
    expect(regionOfGlobal(0x13f000)?.kind).toBe('eeprom');
    expect(regionOfGlobal(0x780000)?.kind).toBe('flash');
    expect(regionOfGlobal(0x0007ff)?.kind).toBe('registers');
    expect(regionOfGlobal(0x200000)).toBeNull();
  });

  it('CW logical addresses (Project.prm segments)', () => {
    expect(logicalToGlobal(0xe08000)).toBe(0x780000);
    expect(logicalToGlobal(0xfe8000)).toBe(0x7f8000);
    expect(logicalToGlobal(0xfc0800)).toBe(0x13f000);
    expect(logicalToGlobal(0xf81000)).toBe(0x0f8000);
    expect(logicalToGlobal(0xc000)).toBe(0x7fc000);
    expect(globalToLogical(0x780000)).toBe(0xe08000);
    expect(globalToLogical(0x13f800)).toBe(0xfe0800);
    expect(globalToLogical(0x0fd000)).toBe(0xfd1000);
    expect(globalToFixedLocal(0x7fc000)).toBe(0xc000);
    expect(globalToFixedLocal(0x7f8000)).toBeNull();
    expect(() => logicalToGlobal(0xfe4000)).toThrow();
    for (let g = 0x780000; g < 0x800000; g += 0x1234) expect(logicalToGlobal(globalToLogical(g)!)).toBe(g);
  });

  itFx('every paged segment in Lab3 Project.prm maps into an implemented region', () => {
    const prm = readFixture('Lab3', 'prm', 'Project.prm').toString('latin1');
    const segs = [...prm.matchAll(/^\s*(\w+)\s*=\s*READ_\w+.*?0x([0-9A-F]+)\s+TO\s+0x([0-9A-F]+)/gim)];
    expect(segs.length).toBeGreaterThan(30);
    for (const [, name, s, e] of segs) {
      const gs = logicalToGlobal(parseInt(s, 16));
      const ge = logicalToGlobal(parseInt(e, 16));
      expect(regionOfGlobal(gs), name).not.toBeNull();
      expect(regionOfGlobal(gs)!.kind, name).toBe(regionOfGlobal(ge)!.kind);
      const ours = SEGMENTS.find((x) => x.name === name);
      if (ours && /^(PAGE|RAM_|EEPROM_)/.test(name)) expect([ours.start, ours.end], name).toEqual([parseInt(s, 16), parseInt(e, 16)]);
    }
  });

  itFx('burner.bbl global s-record mappings agree with localToGlobal/logicalToGlobal', () => {
    const bbl = readFixture('Lab3', 'prm', 'burner.bbl').toString('latin1');
    const globalPart = bbl.split('logical s-record file')[0];
    const pairs: Array<[number, number]> = [];
    let dest: number | null = null;
    for (const line of globalPart.split(/\r?\n/)) {
      const d = /^destination\s*=\s*0x([0-9a-f]+)/i.exec(line);
      if (d) dest = parseInt(d[1], 16);
      const o = /^origin\s*=\s*0x([0-9a-f]+)/i.exec(line);
      if (o && dest !== null) pairs.push([parseInt(o[1], 16), dest]);
    }
    const checked = pairs.filter(([o]) => o < 0x1000000);
    expect(checked.length).toBeGreaterThan(60);
    for (const [origin, destination] of checked) expect(logicalToGlobal(origin), origin.toString(16)).toBe(destination);
  });

  it('COP reset from FCTL NV byte (critique C7)', () => {
    expect(copResetFromNv(0xff)).toEqual({ cr: 0, wcop: false }); // erased => COP off
    expect(copResetFromNv(0xf8)).toEqual({ cr: 7, wcop: false });
    expect(copResetFromNv(0xf0)).toEqual({ cr: 7, wcop: true });
    expect(copResetFromNv(0xfe)).toEqual({ cr: 1, wcop: false });
  });

  it('CPU reset and clocks', () => {
    expect(CPU_RESET.ccr).toBe(0xd0);
    expect(busClockHz(16e6, { pllsel: false, synr: 4, refdv: 7 })).toBe(8e6);
    expect(busClockHz(16e6, { pllsel: true, synr: 4, refdv: 7 })).toBe(10e6);
  });
});
