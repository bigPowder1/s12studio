import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { createMockS12 } from '../testing/mockS12';
import { S12Provider } from './context';
import { useDebugSnapshot, useMemoryWatch, usePreviousHaltSnapshot, useProject } from './hooks';
import type { DebugSnapshot, RegisterSetInfo } from '../../../shared/api';

const regs = (pc: number): RegisterSetInfo => ({ A: 0, B: 0, D: 0, X: 0, Y: 0, SP: 0, PC: pc, CCR: 0, IPL: 0, CCRW: 0, PPAGE: 0, RPAGE: 0, EPAGE: 0, GPAGE: 0, DIRECT: 0 });
const snap = (seq: number, pc: number, extra: Partial<DebugSnapshot> = {}): DebugSnapshot => ({ seq, state: 'halted', statusText: 'HALTED', cycles: seq, busHz: 8e6, simSeconds: 0, registers: regs(pc), memory: {}, ...extra });

function Pc() {
  const s = useDebugSnapshot();
  const prev = usePreviousHaltSnapshot();
  return (
    <div>
      <span data-testid="pc">{s.registers?.PC.toString(16) ?? 'none'}</span>
      <span data-testid="prev">{prev?.registers?.PC.toString(16) ?? 'none'}</span>
    </div>
  );
}

describe('S12 hooks', () => {
  it('useDebugSnapshot follows snapshot events; previous-halt snapshot tracks the halt before', () => {
    const m = createMockS12();
    render(
      <S12Provider api={m.api}>
        <Pc />
      </S12Provider>,
    );
    expect(screen.getByTestId('pc')).toHaveTextContent('none');
    act(() => m.emit('debug', 'snapshot', snap(1, 0xc000)));
    expect(screen.getByTestId('pc')).toHaveTextContent('c000');
    act(() => m.emit('debug', 'snapshot', { ...snap(2, 0xc003), state: 'running' }));
    act(() => m.emit('debug', 'snapshot', snap(3, 0xc006)));
    expect(screen.getByTestId('pc')).toHaveTextContent('c006');
    expect(screen.getByTestId('prev')).toHaveTextContent('c000');
    act(() => m.emit('debug', 'snapshot', snap(1, 0x1234))); // stale seq ignored
    expect(screen.getByTestId('pc')).toHaveTextContent('c006');
  });

  it('useMemoryWatch registers the range and returns the snapshot blocks', async () => {
    const m = createMockS12({ debug: { session: async () => ({ projectDir: '/p', connection: 'sim', connectionMenu: 'X', derivative: 'D', title: 'T' }) } });
    let id = '';
    function Mem() {
      const b = useMemoryWatch([{ address: 0x80, length: 2 }]);
      return <span data-testid="mem">{b ? [...b[0].bytes].join(',') : 'none'}</span>;
    }
    const { unmount } = render(
      <S12Provider api={m.api}>
        <Mem />
      </S12Provider>,
    );
    await act(async () => undefined);
    const [call] = m.calls('debug', 'watchMemory');
    id = call[0] as string;
    expect(call[1]).toEqual([{ address: 0x80, length: 2 }]);
    act(() => m.emit('debug', 'snapshot', snap(5, 0, { memory: { [id]: [{ address: 0x80, space: 'local', bytes: new Uint8Array([1, 2]), status: new Uint8Array(2) }] } })));
    expect(screen.getByTestId('mem')).toHaveTextContent('1,2');
    unmount();
    expect(m.calls('debug', 'unwatchMemory')).toEqual([[id]]);
  });

  it('useProject pulls the current project and follows changes', async () => {
    const m = createMockS12({ project: { current: async () => ({ name: 'Lab3' }) as never } });
    function P() {
      return <span data-testid="p">{useProject()?.name ?? 'none'}</span>;
    }
    render(
      <S12Provider api={m.api}>
        <P />
      </S12Provider>,
    );
    await act(async () => undefined);
    expect(screen.getByTestId('p')).toHaveTextContent('Lab3');
    act(() => m.emit('project', 'closed', {}));
    expect(screen.getByTestId('p')).toHaveTextContent('none');
  });
});
