import { describe, expect, it } from 'vitest';
import { createMockS12 } from '../../common/testing/mockS12';
import { parseCommandNumber, resolveCommandAddress, resolveDialogAddress } from './bus';

describe('address input (review finding 8)', () => {
  it('reads command-language numbers: $FF 0xFF 0377 (octal) %1010 255 (decimal)', () => {
    expect(['$FF', '0xFF', '0377', '%1010', '255', '0', 'main', 'CAFE', '4000h'].map(parseCommandNumber)).toEqual([255, 255, 255, 10, 255, 0, null, null, null]);
  });

  it('`SPC` resolves symbols and expressions through the engine, numbers locally', async () => {
    const m = createMockS12({ debug: { resolve: async (t: string) => ({ main: 0x4000, 'main+3': 0x4003 })[t] ?? null } });
    expect(await resolveCommandAddress(m.api, ' 0377 ')).toBe(0o377);
    expect(await resolveCommandAddress(m.api, '0xC000')).toBe(0xc000);
    expect(await resolveCommandAddress(m.api, 'main+3')).toBe(0x4003);
    expect(await resolveCommandAddress(m.api, 'nope')).toBeNull();
    expect(m.calls('debug', 'resolve')).toEqual([['main+3'], ['nope']]);
  });

  it('the Address dialog tries a bare identifier as a symbol before reading it as hex', async () => {
    const m = createMockS12({ debug: { resolve: async (t: string) => ({ ADD: 0x4010, CAFE: 0x4020, 'main+1': 0x4001 })[t] ?? null } });
    expect(await resolveDialogAddress(m.api, 'ADD')).toBe(0x4010);
    expect(await resolveDialogAddress(m.api, 'CAFE')).toBe(0x4020);
    expect(await resolveDialogAddress(m.api, 'BEEF')).toBe(0xbeef); // no such symbol: hex
    expect(await resolveDialogAddress(m.api, 'C000')).toBe(0xc000);
    expect(await resolveDialogAddress(m.api, '0B10')).toBe(0x0b10);
    expect(await resolveDialogAddress(m.api, '0x4000')).toBe(0x4000);
    expect(await resolveDialogAddress(m.api, 'main+1')).toBe(0x4001);
    expect(await resolveDialogAddress(m.api, 'zork')).toBeNull();
  });
});
