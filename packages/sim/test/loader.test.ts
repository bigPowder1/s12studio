/**
 * S-record loading through the paging window. The loader golden checks and the Lab3 integration run (reset ->
 * main -> the main loop) are private: s12studio-fixtures tests/sim/lab3.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { S12XSystem } from '@s12/sim';

describe('loader', () => {
  it('S2 logical $PPAAAA records map through the paging window', () => {
    const s = new S12XSystem();
    // S2 record at $E08000 (page $E0) with 2 data bytes
    const body = [0x06, 0xe0, 0x80, 0x00, 0x12, 0x34];
    const sum = (~body.reduce((x, y) => x + y, 0) & 0xff).toString(16).padStart(2, '0').toUpperCase();
    s.loadSrec(`S2${body.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('')}${sum}\r\n`);
    expect([s.peekGlobal(0x780000), s.peekGlobal(0x780001)]).toEqual([0x12, 0x34]);
  });
});
