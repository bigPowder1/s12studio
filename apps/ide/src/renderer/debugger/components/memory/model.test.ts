import { describe, expect, it } from 'vitest';
import { MEM_OK, MEM_UNINITIALIZED, MEM_UNMAPPED, type DebugSnapshot } from '../../../../shared/api';
import { asciiChar, formatUnit, parseMemoryAttributes, parseRangeText, parseUnitInput, splitAttributes, unitBytes, unitValue, unitWidth, watchAt } from './model';
import { ChangeTracker, RefreshPolicy, V_UNINIT, V_UNMAPPED } from './refresh';

const snap = (seq: number, state: DebugSnapshot['state'], cycles = 0, pc = 0xc000): DebugSnapshot => ({
  seq,
  state,
  statusText: '',
  cycles,
  busHz: 8e6,
  simSeconds: 0,
  registers: { A: 0, B: 0, D: 0, X: 0, Y: 0, SP: 0, PC: pc, CCR: 0, IPL: 0, CCRW: 0, PPAGE: 0, RPAGE: 0, EPAGE: 0, GPAGE: 0, DIRECT: 0 },
  memory: {},
});

describe('memory model', () => {
  it('formats units in every format with uu / -- markers', () => {
    expect(formatUnit(0x4a, 1, 'hex')).toBe('4A');
    expect(formatUnit(0x1234, 2, 'hex')).toBe('1234');
    expect(formatUnit(0x05, 1, 'bin')).toBe('00000101');
    expect(formatUnit(0xff, 1, 'dec')).toBe('  -1');
    expect(formatUnit(0xff, 1, 'udec')).toBe('255');
    expect(formatUnit(8, 1, 'oct')).toBe('010');
    expect(formatUnit(0x01, 1, 'bitrev')).toBe('80');
    expect(formatUnit(V_UNINIT, 1, 'hex')).toBe('uu');
    expect(formatUnit(V_UNMAPPED, 1, 'hex')).toBe('--');
    expect(formatUnit(V_UNINIT, 2, 'hex')).toBe('uuuu');
    expect(unitWidth(4, 'hex')).toBe(8);
  });

  it('combines big-endian units and propagates byte status', () => {
    const bytes = [0x12, 0x34, 0x56, 0x78];
    expect(unitValue(bytes, [MEM_OK, MEM_OK, MEM_OK, MEM_OK], 0, 4)).toBe(0x12345678);
    expect(unitValue(bytes, [MEM_OK, MEM_UNINITIALIZED], 0, 2)).toBe(V_UNINIT);
    expect(unitValue(bytes, [MEM_UNINITIALIZED, MEM_UNMAPPED], 0, 2)).toBe(V_UNMAPPED);
    expect(unitBytes(0x1234, 2)).toEqual([0x12, 0x34]);
    expect(asciiChar(0x41, MEM_OK)).toBe('A');
    expect(asciiChar(0x41, MEM_UNINITIALIZED)).toBe('.');
  });

  it('parses edits in the display format', () => {
    expect(parseUnitInput('ff', 1, 'hex')).toBe(0xff);
    expect(parseUnitInput('100', 1, 'hex')).toBeNull();
    expect(parseUnitInput('255', 1, 'dec')).toBe(255);
    expect(parseUnitInput('-1', 1, 'dec')).toBe(0xff);
    expect(parseUnitInput('$12', 1, 'dec')).toBe(0x12);
    expect(parseUnitInput('1010', 1, 'bin')).toBe(10);
    expect(parseUnitInput('xyz', 1, 'hex')).toBeNull();
    expect(parseUnitInput('ABCD', 2, 'hex')).toBe(0xabcd);
  });

  it('parses layout attributes and SMEM ranges', () => {
    const a = parseMemoryAttributes(splitAttributes('FORMAT hex,COMPLEMENT None,WORD 2,ASC off,ADR on,MODE periodical,UPDATERATE 5,SHOW_ADDRESSSPACE 0,ADDRESS 0x80'));
    expect(a).toEqual({ format: 'hex', unit: 2, ascii: false, showAddress: true, mode: 'periodical', updateRate: 5, space: 'local', address: 0x80 });
    expect(parseRangeText('0x1000..0x100F')).toEqual({ start: '0x1000', end: '0x100F' });
    expect(parseRangeText('RX_BUF,4')).toEqual({ start: 'RX_BUF', size: '4' });
  });

  it('finds watchpoints over a unit', () => {
    const w = { id: 1, start: 0x1000, end: 0x1001, kind: 'write' as const, space: 'local' as const, enabled: true, hits: 0 };
    expect(watchAt([w], 'local', 0x1001)).toBe(w);
    expect(watchAt([w], 'local', 0x0fff, 2)).toBe(w);
    expect(watchAt([w], 'local', 0x1002)).toBeUndefined();
    expect(watchAt([w], 'global', 0x1000)).toBeUndefined();
  });
});

describe('refresh policy / change tracking', () => {
  it('Automatic refreshes on halts only, Periodical while running, Frozen never', () => {
    const p = new RefreshPolicy();
    expect(p.update(snap(1, 'halted', 10), 'automatic', 1000, 0)).toEqual({ accept: true, epoch: true });
    expect(p.update(snap(2, 'halted', 10), 'automatic', 1000, 0)).toEqual({ accept: true, epoch: false });
    expect(p.update(snap(3, 'running', 20), 'automatic', 1000, 0).accept).toBe(false);
    expect(p.update(snap(4, 'halted', 30), 'automatic', 1000, 0)).toEqual({ accept: true, epoch: true });
    const q = new RefreshPolicy();
    expect(q.update(snap(1, 'running', 1), 'periodical', 100, 0)).toEqual({ accept: true, epoch: true });
    expect(q.update(snap(2, 'running', 2), 'periodical', 100, 50).accept).toBe(false);
    expect(q.update(snap(3, 'running', 3), 'periodical', 100, 120).accept).toBe(true);
    expect(new RefreshPolicy().update(snap(1, 'halted', 1), 'frozen', 100, 0).accept).toBe(false);
  });

  it('marks values that differ from the previous refresh', () => {
    const t = new ChangeTracker();
    t.observe([[1, 5], [2, 6]], true);
    expect(t.changed(1)).toBe(false);
    t.observe([[1, 5], [2, 7]], true);
    expect(t.changed(1)).toBe(false);
    expect(t.changed(2)).toBe(true);
    // a write of the same value while halted (no new epoch) keeps the mark, writing the old value back clears it
    t.observe([[2, 6]], false);
    expect(t.changed(2)).toBe(false);
    t.observe([[2, 6]], true);
    expect(t.changed(2)).toBe(false);
  });
});
