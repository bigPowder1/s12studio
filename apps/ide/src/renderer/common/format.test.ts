import { describe, expect, it } from 'vitest';
import { addr, ccrString, formatMHz, formatNumber, parseNumber } from './format';

describe('format', () => {
  it('formats values like hiwave', () => {
    expect(formatNumber(0x4a, 'hex')).toBe('4A');
    expect(formatNumber(0xff, 'dec')).toBe('-1');
    expect(formatNumber(0xff, 'udec')).toBe('255');
    expect(formatNumber(5, 'bin', 8)).toBe('00000101');
    expect(formatNumber(0x01, 'bitrev', 8)).toBe('80');
    expect(formatNumber(0xc000, 'hex', 16)).toBe('C000');
    expect(addr(0x4000)).toBe('0x4000');
    expect(addr(0x7fc000)).toBe('0x7FC000');
    expect(formatMHz(10e6)).toBe('10.000000 MHz');
    expect(ccrString(0xd0)).toBe('SX-I----');
  });
  it('parses CodeWarrior number syntaxes', () => {
    expect(parseNumber('$FF')).toBe(255);
    expect(parseNumber('0x10')).toBe(16);
    expect(parseNumber('%101')).toBe(5);
    expect(parseNumber('@17')).toBe(15);
    expect(parseNumber('1Fh')).toBe(31);
    expect(parseNumber('-12')).toBe(-12);
    expect(parseNumber('C000', 16)).toBe(0xc000);
    expect(parseNumber('C000')).toBeNull();
    expect(parseNumber('')).toBeNull();
  });
});
