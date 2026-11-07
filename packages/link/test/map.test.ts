// Map writer details that the goldens pin only implicitly.
import { describe, expect, it } from 'vitest';
import { wrapWords, WRAP_SECTION_USE, WRAP_USES } from '../src/map';

describe('map word wrapping (limits fitted to the golden maps)', () => {
  it('SECTION USE: a word that would end past column 79 starts a new line', () => {
    const w76 = 'x'.repeat(74); // "  " + 74 + " " = 77 columns
    expect(wrapWords([w76, 'ab'], '  ', '  ', WRAP_SECTION_USE)).toEqual([`  ${w76} ab `]); // 77 + 2 = 79: kept
    expect(wrapWords([w76, 'abc'], '  ', '  ', WRAP_SECTION_USE)).toEqual([`  ${w76} `, '  abc ']); // 80: wrapped
  });
  it('USES: 78 on the first line, 80 on continuation lines', () => {
    const first = `${'A'.padEnd(25)} USES `; // 31 columns
    // 31 + "x"*40 + " " = 72 columns; +6 = 78 kept, +7 = 79 wrapped
    expect(wrapWords(['x'.repeat(40), 'y'.repeat(6)], first, ' '.repeat(32), WRAP_USES)).toHaveLength(1);
    expect(wrapWords(['x'.repeat(40), 'y'.repeat(7)], first, ' '.repeat(32), WRAP_USES)).toHaveLength(2);
    // continuation: 32 + "x"*41 + " " = 74 columns; +6 = 80 kept, +7 = 81 wrapped
    const cont = wrapWords(['q'.repeat(60), 'x'.repeat(41), 'y'.repeat(6)], first, ' '.repeat(32), WRAP_USES);
    expect(cont).toEqual([`${first}${'q'.repeat(60)} `, `${' '.repeat(32)}${'x'.repeat(41)} ${'y'.repeat(6)} `]);
    expect(wrapWords(['q'.repeat(60), 'x'.repeat(41), 'y'.repeat(7)], first, ' '.repeat(32), WRAP_USES)).toHaveLength(3);
  });
  it('a single over-long word is never wrapped away from its prefix', () => {
    expect(wrapWords(['z'.repeat(100)], '  ', '  ', WRAP_SECTION_USE)).toEqual([`  ${'z'.repeat(100)} `]);
  });
});
