/** ME305 Board auto-dock: the pure layout step (dockBoard) and the shell's once-per-session trigger. */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { parseHwl } from '@s12/formats';
// hiwave-format test data of our own (the same layout/ini shapes as a CodeWarrior project's)
import { ASM_LAYOUT_HWL as asmLayoutText, FCS_INI as fcsIniText } from '../../common/monaco/testing/hiwave-texts';
import { createMockS12, type MockOverrides } from '../../common/testing/mockS12';
import { S12Provider } from '../../common/s12';
import type { BoardState, HwlLayoutInfo } from '../../../shared/api';
import { BOARD_DOCK_WIDTH, dockBoard, hwlToMdi, mdiReducer, mdiToHwl } from './layout';
import { SESSION } from './testing';
import { DebuggerShell } from './DebuggerShell';

// Stub components (the board drawing has its own tests).
vi.mock('../components/registry', async () => {
  const Stub = ({ title }: { title: string }) => <div data-testid={`stub-${title}`}>{title}</div>;
  const names = ['Source', 'Assembly', 'Register', 'Procedure', 'Memory', 'Data', 'Command', 'Terminal', 'ME305 Board', 'VisualizationTool'] as const;
  const COMPONENTS = names.map((name) => ({ name, component: Stub, multiInstance: ['Memory', 'Data', 'VisualizationTool'].includes(name), description: `${name} window`, aliases: name === 'ME305 Board' ? ['me305', 'board', 'me305board'] : [] }));
  const findComponent = (n: string) => {
    const k = n.trim().toLowerCase().replace(/[\s_]/g, '');
    return COMPONENTS.find((c) => c.name.toLowerCase().replace(/\s/g, '') === k || c.aliases.includes(k));
  };
  return { COMPONENTS, findComponent };
});

const asmLayout = (): HwlLayoutInfo => {
  const l = parseHwl(asmLayoutText);
  return { ...l, otherRaw: l.other.map((c) => c.raw) };
};

const BOARD = { present: true } as BoardState;

describe('dockBoard', () => {
  it('squeezes the .hwl windows into the left part and docks the board on the right, full height', () => {
    const s = hwlToMdi(asmLayout());
    const d = dockBoard(s);
    const k = (100 - BOARD_DOCK_WIDTH) / 100;
    expect(d.windows).toHaveLength(s.windows.length + 1);
    for (const w of s.windows) {
      const after = d.windows.find((x) => x.id === w.id)!;
      expect(after.rect).toEqual({ x: w.rect.x * k, y: w.rect.y, w: w.rect.w * k, h: w.rect.h });
      expect(after.rect.x + after.rect.w).toBeLessThanOrEqual(100 - BOARD_DOCK_WIDTH + 1e-9);
    }
    const board = d.windows.find((w) => w.component === 'ME305 Board')!;
    expect(board.rect).toEqual({ x: 100 - BOARD_DOCK_WIDTH, y: 0, w: BOARD_DOCK_WIDTH, h: 100 });
    // the layout's active window (ACTIVATE ... "Data") stays active
    expect(d.active).toBe(s.active);
    // written back as an ordinary OPEN line (only if the user saves the configuration)
    expect(mdiToHwl(d).windows.at(-1)).toMatchObject({ component: 'me305board', x: 60, y: 0, w: 40, h: 100 });
  });

  it('leaves a layout that already has the board alone (also through the reducer)', () => {
    const s = mdiReducer(hwlToMdi(asmLayout()), { type: 'open', component: 'ME305 Board', rect: { x: 10, y: 10, w: 30, h: 30 } });
    expect(dockBoard(s)).toBe(s);
    expect(mdiReducer(s, { type: 'dockBoard' })).toBe(s);
  });
});

function setup(over: MockOverrides = {}) {
  const m = createMockS12({
    ...over,
    debug: { session: async () => SESSION, ...over.debug },
    layout: { read: async () => asmLayout(), defaultLayout: async () => asmLayout(), ...over.layout },
    files: { readText: async (path: string) => ({ path, text: fcsIniText, eol: 'crlf' as const, mtimeMs: 0, readOnly: false }) },
  });
  render(
    <S12Provider api={m.api}>
      <DebuggerShell />
    </S12Provider>,
  );
  return m;
}

describe('DebuggerShell: ME305 Board window', () => {
  it('opens the board on the right when the session has the board and its .hwl does not', async () => {
    const m = setup({ board: { state: async () => BOARD } });
    const board = await screen.findByTestId('mdi-window-ME305 Board');
    expect([board.style.left, board.style.top, board.style.width, board.style.height]).toEqual(['60%', '0%', '40%', '100%']);
    // the .hwl windows keep their arrangement, squeezed into the left 60%
    expect(screen.getByTestId('mdi-window-Register').style.left).toBe(`${58 * 0.6}%`);
    expect(screen.getByTestId('mdi-caption-Data')).toHaveClass('active');
    // nothing is written to the .hwl
    expect(m.calls('layout', 'write')).toEqual([]);
  });

  it('only once per session: closing the board is respected until a new session', async () => {
    const m = setup({ board: { state: async () => BOARD } });
    await screen.findByTestId('mdi-window-ME305 Board');
    act(() => m.emit('debug', 'uiCommand', { keyword: 'CLOSE', argText: '"ME305 Board"', raw: 'CLOSE "ME305 Board"' }));
    await waitFor(() => expect(screen.queryByTestId('mdi-window-ME305 Board')).toBeNull());
    act(() => m.emit('debug', 'session', { ...SESSION }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('mdi-window-ME305 Board')).toBeNull();
    // another project's session: the board comes back
    act(() => m.emit('debug', 'session', { ...SESSION, projectDir: '/p/Other', iniPath: '/p/Other/Full_Chip_Simulation.ini', layoutPath: '/p/Other/ASM_layout.hwl' }));
    await screen.findByTestId('mdi-window-ME305 Board');
  });

  it('a relaunch of the same project (null session, then the session again) docks the board in the reloaded layout', async () => {
    const m = setup({ board: { state: async () => BOARD } });
    await screen.findByTestId('mdi-window-ME305 Board');
    act(() => m.emit('debug', 'session', null));
    await new Promise((r) => setTimeout(r, 20));
    act(() => m.emit('debug', 'session', { ...SESSION }));
    await new Promise((r) => setTimeout(r, 20));
    await screen.findByTestId('mdi-window-Source');
    await screen.findByTestId('mdi-window-ME305 Board');
    expect(screen.getAllByTestId('mdi-window-ME305 Board')).toHaveLength(1);
  });

  it('a stale default layout that resolves after the new session layout does not replace it', async () => {
    let releaseDefault: () => void = () => undefined;
    let slow = false;
    const m = setup({
      board: { state: async () => BOARD },
      layout: {
        defaultLayout: () =>
          slow ? new Promise<HwlLayoutInfo>((res) => (releaseDefault = () => res(asmLayout()))) : Promise.resolve(asmLayout()),
      },
    });
    await screen.findByTestId('mdi-window-ME305 Board');
    slow = true;
    act(() => m.emit('debug', 'session', null));
    act(() => m.emit('debug', 'session', { ...SESSION }));
    await screen.findByTestId('mdi-window-ME305 Board');
    await act(async () => releaseDefault());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('mdi-window-ME305 Board')).not.toBeNull();
  });

  it('no board in the session (or no session): the .hwl layout is used as is', async () => {
    setup({ board: { state: async () => ({ present: false }) as BoardState } });
    await screen.findByTestId('mdi-window-Source');
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('mdi-window-ME305 Board')).toBeNull();
    expect(screen.getByTestId('mdi-window-Source').style.width).toBe('58%');
  });
});
