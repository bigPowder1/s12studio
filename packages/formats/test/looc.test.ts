import { describe, it, expect } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, readFixture, itFx, describeFx, hasFixtures } from './fixtures';
import { readLooc, readStringTable, readStringTables, findChunk, findChunks, LoocError, LOOC_NS_ATOMS } from '../src/looc';

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const u8 = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

describe('looc container', () => {
  itFx('parses Lab3.mcp header and chunk table', () => {
    const f = readLooc(u8(readFixture('Lab3', 'Lab3.mcp')));
    expect(f.endianness).toBe('le');
    expect(f.subtitle).toBe('CodeWarrior Project');
    expect(f.usedFallback).toBe(false);
    expect(f.warnings).toEqual([]);
    expect(f.header).toMatchObject({ magic: 'looc', version: 3, heapOff: 0x128, heapLen: 0xfe56, tableOff: 0xff7e, tableSize: 0x450, count: 46 });
    expect([...f.header.formatBytes]).toEqual([2, 3, 4, 0]);
    expect(f.chunks).toHaveLength(46);
    expect(f.chunks[0]).toMatchObject({ off: 0x128, size: 0x800, tag: 'mstr', ns: 0, id: 0 });
    expect(f.chunks[44]).toMatchObject({ off: 0xc531, size: 0xd8, tag: 'PLst', id: 53 });
    expect(f.chunks[45]).toMatchObject({ off: 0xd672, size: 0x58a, tag: 'prpl', id: 54 });
    expect(findChunks(f, 'pref')).toHaveLength(26);
    expect(findChunk(f, 'mtpl', 1)?.size).toBe(0x500);
  });

  itFx('decodes the string tables per namespace', () => {
    const f = readLooc(u8(readFixture('Lab3', 'Lab3.mcp')));
    const tables = readStringTables(f);
    expect([...tables.keys()].sort((a, b) => a - b)).toEqual([0, 0x3e8]);
    const ns0 = tables.get(0)!;
    expect(ns0.count).toBe(54);
    expect(ns0.capacity).toBe(64);
    expect(ns0.strings.get(1)).toMatch(/^\w+:Source Trees$/); // a stale target's panel
    expect(ns0.strings.get(28)).toBe('Standard:Access Paths');
    expect(ns0.strings.get(53)).toBe('Project File List');
    expect(ns0.strings.get(54)).toBe('HC12 Wizard Configuration');
    const atoms = readStringTable(f, LOOC_NS_ATOMS)!;
    expect(atoms.count).toBe(70);
    expect(atoms.strings.get(4)).toBe('Standard');
    expect(atoms.strings.get(22)).toBe('bin\\Project.abs');
    expect(atoms.strings.get(69)).toBe('ME305LibV4.0.lib');
    expect(atoms.strings.get(70)).toMatch(/\.asm$/); // a stale file name
  });

  itFx('parses every .mcp/.stg/.tdt in the fixtures without warnings', () => {
    const files = walk(FIXTURES).filter((p) => /\.(mcp|stg|tdt)$/i.test(p));
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const p of files) {
      const f = readLooc(u8(readFixture(p.slice(FIXTURES.length))));
      expect(f.usedFallback, p).toBe(false);
      expect(f.warnings, p).toEqual([]);
      const sub = p.endsWith('.mcp') ? 'CodeWarrior Project' : p.endsWith('.stg') ? 'Windows Project Settings' : 'Windows Target Data';
      expect(f.subtitle, p).toBe(sub);
      expect(f.chunks.length, p).toBe(f.header.count);
      const t = readStringTable(f, 0);
      expect(t, p).toBeDefined();
      expect(t!.strings.size, p).toBe(t!.count);
    }
  });

  itFx('decodes .stg pref names', () => {
    const f = readLooc(u8(readFixture('Lab3', 'Lab3_Data', 'CWSettingsWindows.stg')));
    const names = readStringTable(f, 0)!;
    const prefNames = findChunks(f, 'pref').map((c) => names.strings.get(c.id));
    expect(prefNames).toContain('Expanded Group List');
    expect(prefNames).toContain('Target List Settings');
  });

  itFx('.tdt carries byte-identical copies of the Standard:* panels', () => {
    const mcp = readLooc(u8(readFixture('Lab3', 'Lab3.mcp')));
    const tdt = readLooc(u8(readFixture('Lab3', 'Lab3_Data', 'Standard', 'TargetDataWindows.tdt')));
    const n1 = readStringTable(mcp, 0)!, n2 = readStringTable(tdt, 0)!;
    const tdtPrefs = new Map(findChunks(tdt, 'pref').map((c) => [n2.strings.get(c.id), c]));
    const as = findChunks(mcp, 'pref').find((c) => n1.strings.get(c.id) === 'Standard:Access Paths')!;
    expect(Buffer.from(tdtPrefs.get('Standard:Access Paths')!.data).equals(Buffer.from(as.data))).toBe(true);
  });

  it('rejects non-looc data', () => {
    expect(() => readLooc(new Uint8Array(0x200))).toThrow(LoocError);
    expect(() => readLooc(new Uint8Array(10))).toThrow(LoocError);
  });

  itFx('recovers the chunk table by scanning when the header pointer is corrupt', () => {
    const b = new Uint8Array(readFixture('Lab3', 'Lab3.mcp'));
    new DataView(b.buffer).setUint32(0x10, 0xdeadbeef, true);
    const f = readLooc(b);
    expect(f.usedFallback).toBe(true);
    expect(f.chunks).toHaveLength(46);
    expect(f.chunks[44].tag).toBe('PLst');
  });

  itFx('drops out-of-bounds chunks with a warning', () => {
    const b = new Uint8Array(readFixture('Lab3', 'Lab3.mcp'));
    // chunk #2 (mstn) offset → beyond file
    new DataView(b.buffer).setUint32(0xff7e + 2 * 24, 0x7fffffff, true);
    const f = readLooc(b);
    expect(f.chunks).toHaveLength(45);
    expect(f.warnings.some((w) => /out of bounds/.test(w))).toBe(true);
  });

  it('reads big-endian "cool" containers', () => {
    // Build a minimal BE container: header + one 'mstr' chunk + table.
    const data = new TextEncoder().encode('abc\0');
    const tableOff = 0x128 + data.length;
    const b = new Uint8Array(tableOff + 24);
    const dv = new DataView(b.buffer);
    b.set(new TextEncoder().encode('cool'), 0);
    dv.setUint32(4, 3);
    dv.setUint32(8, 0x128);
    dv.setUint32(0xc, data.length);
    dv.setUint32(0x10, tableOff);
    dv.setUint32(0x14, 24);
    dv.setUint32(0x18, 1);
    b.set(new TextEncoder().encode('Mac Project\0'), 0x28);
    b.set(data, 0x128);
    dv.setUint32(tableOff, 0x128);
    dv.setUint32(tableOff + 4, data.length);
    b.set(new TextEncoder().encode('mstr'), tableOff + 8);
    const f = readLooc(b);
    expect(f.endianness).toBe('be');
    expect(f.subtitle).toBe('Mac Project');
    expect(f.chunks[0]).toMatchObject({ tag: 'mstr', off: 0x128, size: 4 });
  });
});

describeFx('looc fallback: review regressions (finding 4)', () => {
  const orig = new Uint8Array(readFixture('Lab3', 'Lab3.mcp'));
  const base = readLooc(orig);
  const sig = (f: ReturnType<typeof readLooc>) => f.chunks.map((c) => [c.tag, c.ns, c.id, c.off, c.size]);

  for (const extra of [1, 8, 23, 24, 100]) {
    it(`trailing ${extra} bytes: header table is still used`, () => {
      const b = new Uint8Array(orig.length + extra);
      b.set(orig);
      b.fill(0xa5, orig.length);
      const f = readLooc(b);
      expect(f.usedFallback).toBe(false);
      expect(sig(f)).toEqual(sig(base));
      expect(f.warnings).toEqual([`${extra} bytes after the chunk table ignored`]);
    });
  }

  for (const cut of [1, 10, 23]) {
    it(`truncated by ${cut} bytes: fallback scan at the table's alignment recovers all but the last entry`, () => {
      const f = readLooc(orig.slice(0, orig.length - cut));
      expect(f.usedFallback).toBe(true);
      expect(sig(f)).toEqual(sig(base).slice(0, -1));
    });
  }

  it('corrupt table pointer with table at end of file: plain fallback still works', () => {
    const b = orig.slice();
    new DataView(b.buffer).setUint32(0x10, 0x12345, true);
    const f = readLooc(b);
    expect(f.usedFallback).toBe(true);
    expect(sig(f)).toEqual(sig(base));
  });
});
