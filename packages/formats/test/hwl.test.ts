import { describe, it, expect } from 'vitest';
import { readFixture, itFx } from './fixtures';
import { parseHwl, writeHwl } from '../src/text/hwl';
import { parseHiwaveScript } from '../src/text/hiwave-cmd';

describe('hiwave layout (.hwl)', () => {
  for (const proj of ['Lab3', 'blank_project']) {
    itFx(`${proj}/ASM_layout.hwl parses and re-serializes byte-identically`, () => {
      const text = readFixture(proj, 'ASM_layout.hwl').toString('latin1');
      expect(parseHiwaveScript(text).errors).toEqual([]);
      const l = parseHwl(text);
      expect(l.warnings).toEqual([]);
      expect(l.other).toEqual([]);
      expect(writeHwl(l)).toBe(text);
    });
  }

  itFx('interprets the ASM layout', () => {
    const l = parseHwl(readFixture('Lab3', 'ASM_layout.hwl').toString('latin1'));
    expect(l.windows.map((w) => [w.title, w.x, w.y, w.w, w.h])).toEqual([
      ['Source', 0, 0, 60, 42],
      ['Assembly', 60, 0, 40, 30],
      ['Procedure', 60, 60, 40, 17],
      ['Register', 60, 30, 40, 30],
      ['Memory', 60, 77, 40, 23],
      ['Data', 0, 42, 60, 28],
      ['Command', 0, 70, 60, 30],
    ]);
    expect(l.windows.map((w) => w.component)).toEqual(['source', 'assembly', 'procedure', 'register', 'memory', 'data', 'command']);
    const asm = l.windows[1];
    expect(asm.attributes.find((a) => a.name === 'TOPPC')!.value).toBe('0x4000');
    const mem = l.windows[4];
    expect(Object.fromEntries(mem.attributes.map((a) => [a.name, a.value]))).toMatchObject({ FORMAT: 'hex', WORD: '1', ADDRESS: '0x80', MODE: 'automatic', UPDATERATE: '10', SHOW_ADDRESSSPACE: '0' });
    expect(l.windows[5].attributes.map((a) => a.name)).toEqual(['SCOPE', 'COMPLEMENT', 'FORMAT', 'MODE', 'SORT', 'UPDATERATE', 'NAMEWIDTH']);
    expect(l.windows[6].attributes).toEqual([{ name: 'CACHESIZE', value: '1000' }]);
    expect(l.bckcolor).toBe(50331647);
    expect(l.font).toEqual({ face: 'Courier New', size: 9, color: 'BLACK' });
    expect(l.autosize).toBe(true);
    expect(l.activate).toEqual(['Assembly', 'Memory', 'Register', 'Command', 'Source', 'Procedure', 'Data']);
    expect(l.eol).toBe('\r\n');
  });

  it('numbers multiple windows of the same component', () => {
    const l = parseHwl('OPEN data 0 56 60 22\nOPEN data 0 78 60 22\nData:2 < attributes SCOPE local\nData:1 < attributes SCOPE global\nfoo 1\n');
    expect(l.windows.map((w) => w.title)).toEqual(['Data:1', 'Data:2']);
    expect(l.windows[0].attributes).toEqual([{ name: 'SCOPE', value: 'global' }]);
    expect(l.windows[1].attributes).toEqual([{ name: 'SCOPE', value: 'local' }]);
    expect(l.other.map((c) => c.keyword)).toEqual(['FOO']);
    expect(l.eol).toBe('\n');
  });

  it('warns about attributes for unknown windows and malformed OPEN', () => {
    const l = parseHwl('Memory < attributes ADR on\r\nOPEN source 1 2\r\n');
    expect(l.warnings).toHaveLength(2);
  });
});

describe('hiwave layout: review regressions', () => {
  it('multi-token attribute values round-trip exactly (finding 7)', () => {
    const text = 'OPEN data 0 0 50 50\r\nData < attributes SCOPE global,FOO -1,BAR &main\r\n';
    const l = parseHwl(text);
    expect(l.warnings).toEqual([]);
    expect(l.windows[0].attributes).toEqual([
      { name: 'SCOPE', value: 'global' },
      { name: 'FOO', value: '-1' },
      { name: 'BAR', value: '&main' },
    ]);
    expect(writeHwl(l)).toBe(text);
  });

  it('OPEN without geometry is not written back as a zero-size window (finding 8)', () => {
    const text = 'OPEN source\r\nOPEN data 1 2 3 4\r\n';
    const l = parseHwl(text);
    expect(l.windows[0]).toMatchObject({ component: 'source', hasGeometry: false });
    expect(l.windows[1].hasGeometry).toBeUndefined();
    expect(writeHwl(l)).toBe(text);
  });
});
