import { describe, it, expect } from 'vitest';
import { readFixture, itFx } from './fixtures';
import { parseXpr, writeXpr } from '../src/text/xpr';

describe('.xpr watch list', () => {
  itFx('Lab3/bin/Project.xpr', () => {
    const text = readFixture('Lab3', 'bin', 'Project.xpr').toString('latin1');
    const x = parseXpr(text);
    expect(x.warnings).toEqual([]);
    // every "Data < ADDXPR ... <name>" line, in file order (the names are the lab's variables, read from the file)
    const names = [...text.matchAll(/^Data < ADDXPR\b.*?"?(\w+)"?\s*$/gm)].map((m) => m[1]);
    expect(names).toHaveLength(12);
    expect(x.entries.map((e) => e.expression)).toEqual(names);
    expect(x.entries.every((e) => e.component === 'Data' && e.onlyIfNew)).toBe(true);
    expect(writeXpr(x.entries.map((e) => e.expression))).toBe(text);
    expect(writeXpr(x.entries, x.eol)).toBe(text);
  });

  itFx('blank_project/bin/Project.xpr round-trips', () => {
    const text = readFixture('blank_project', 'bin', 'Project.xpr').toString('latin1');
    const x = parseXpr(text);
    expect(x.warnings).toEqual([]);
    expect(writeXpr(x.entries, x.eol)).toBe(text);
  });

  it('warns on unexpected content', () => {
    const x = parseXpr('Data < ADDXPR foo\nG\nData < ADDXPR "a.b"\n');
    expect(x.entries.map((e) => [e.expression, e.onlyIfNew])).toEqual([['a.b', false]]);
    expect(x.warnings).toHaveLength(2);
  });
});
