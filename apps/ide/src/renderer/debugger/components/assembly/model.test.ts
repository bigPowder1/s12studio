import { describe, expect, it } from 'vitest';
import { unwindScroll, type ScrollStep } from './model';

describe('unwindScroll (Assembly PgUp after PgDn)', () => {
  it('undoes the last forward scroll exactly', () => {
    const h: ScrollStep[] = [{ from: 0xbfee, to: 0xc019, n: 14 }];
    expect(unwindScroll(h, 0xc019, 14)).toEqual({ top: 0xbfee, rest: 0 });
    expect(h).toEqual([]);
  });

  it('page grew in between (window resized): returns to the old top, then scrolls the extra rows back', () => {
    const h: ScrollStep[] = [{ from: 0xbfee, to: 0xc019, n: 14 }];
    expect(unwindScroll(h, 0xc019, 15)).toEqual({ top: 0xbfee, rest: 1 });
    expect(h).toEqual([]);
  });

  it('page shrank in between: lands inside the recorded step on its instruction grid', () => {
    const h: ScrollStep[] = [{ from: 0xbfee, to: 0xc019, n: 14 }];
    expect(unwindScroll(h, 0xc019, 11)).toEqual({ top: 0xc019, rest: 0, partial: { from: 0xbfee, index: 3 } });
    expect(h).toEqual([]);
  });

  it('several PgDn then one big PgUp unwinds them all', () => {
    const h: ScrollStep[] = [
      { from: 0xbfee, to: 0xc00f, n: 11 },
      { from: 0xc00f, to: 0xc030, n: 11 },
    ];
    expect(unwindScroll(h, 0xc030, 22)).toEqual({ top: 0xbfee, rest: 0 });
  });

  it('history that no longer matches the top is dropped', () => {
    const h: ScrollStep[] = [{ from: 0xbfee, to: 0xc019, n: 14 }];
    expect(unwindScroll(h, 0xd000, 5)).toEqual({ top: 0xd000, rest: 5 });
    expect(h).toEqual([]);
  });
});
