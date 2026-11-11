/**
 * ME3305 board window: the board is never an MDI child of the debugger; a session with the board shows the separate
 * board window (app.showBoard) once per applied layout, and Component > Open / OPEN bring it to the front.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { parseHwl } from '@s12/formats';
// hiwave-format test data of our own (the same layout/ini shapes as a CodeWarrior project's)
import { ASM_LAYOUT_HWL as asmLayoutText, FCS_INI as fcsIniText } from '../../common/monaco/testing/hiwave-texts';
import { createMockS12, type MockOverrides } from '../../common/testing/mockS12';
import { S12Provider } from '../../common/s12';
import type { BoardState, HwlLayoutInfo } from '../../../shared/api';
import { hwlToMdi, mdiReducer } from './layout';
import { SESSION } from './testing';
import { DebuggerShell } from './DebuggerShell';

// Stub components (the board drawing has its own tests).
vi.mock('../components/registry', async () => {
  const Stub = ({ title }: { title: string }) => <div data-testid={`stub-${title}`}>{title}</div>;
  const names = ['Source', 'Assembly', 'Register', 'Procedure', 'Memory', 'Data', 'Command', 'Terminal', 'ME3305 Board', 'VisualizationTool'] as const;
  const COMPONENTS = names.map((name) => ({ name, component: Stub, multiInstance: ['Memory', 'Data', 'VisualizationTool'].includes(name), description: `${name} window`, aliases: name === 'ME3305 Board' ? ['me3305', 'board', 'me3305board'] : [] }));
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

describe('layout: the board is not an MDI window', () => {
  it('a layout saved with the board (0.1.x, old or new name) loads without it', () => {
    const l = asmLayout();
    const withBoard = { ...l, windows: [...l.windows, { ...l.windows[0], component: 'ME305 Board', title: '' }, { ...l.windows[0], component: 'me3305board', title: '' }] };
    const s = hwlToMdi(withBoard);
    expect(s.windows.map((w) => w.component)).toEqual(hwlToMdi(l).windows.map((w) => w.component));
    expect(s.windows.some((w) => w.component === 'ME3305 Board')).toBe(false);
  });

  it('the reducer ignores opening the board', () => {
    const s = hwlToMdi(asmLayout());
    expect(mdiReducer(s, { type: 'open', component: 'ME3305 Board' })).toBe(s);
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

describe('DebuggerShell: ME3305 board window', () => {
  const shows = (m: ReturnType<typeof setup>) => m.calls('app', 'showBoard');

  it('shows the board window (without focus) when the session has the board; the debugger layout is untouched', async () => {
    const m = setup({ board: { state: async () => BOARD } });
    await waitFor(() => expect(shows(m)).toEqual([[{ focus: false }]]));
    expect(screen.queryByTestId('mdi-window-ME3305 Board')).toBeNull();
    // the .hwl windows keep their own size (no squeeze)
    expect(screen.getByTestId('mdi-window-Source').style.width).toBe('58%');
    expect(m.calls('layout', 'write')).toEqual([]);
  });

  it('once per session and layout; another project shows it again', async () => {
    const m = setup({ board: { state: async () => BOARD } });
    await waitFor(() => expect(shows(m)).toHaveLength(1));
    act(() => m.emit('debug', 'session', { ...SESSION }));
    await new Promise((r) => setTimeout(r, 20));
    expect(shows(m)).toHaveLength(1);
    act(() => m.emit('debug', 'session', { ...SESSION, projectDir: '/p/Other', iniPath: '/p/Other/Full_Chip_Simulation.ini', layoutPath: '/p/Other/ASM_layout.hwl' }));
    await waitFor(() => expect(shows(m)).toHaveLength(2));
  });

  it('OPEN "ME3305 Board" (or the old name) brings the board window to the front instead of an MDI child', async () => {
    const m = setup({ board: { state: async () => BOARD } });
    await screen.findByTestId('mdi-window-Source');
    act(() => m.emit('debug', 'uiCommand', { keyword: 'OPEN', argText: 'me3305board', raw: 'OPEN me3305board' }));
    await waitFor(() => expect(shows(m)).toContainEqual([{ focus: true }]));
    expect(screen.queryByTestId('mdi-window-ME3305 Board')).toBeNull();
  });

  it('no board in the session: no board window', async () => {
    const m = setup({ board: { state: async () => ({ present: false }) as BoardState } });
    await screen.findByTestId('mdi-window-Source');
    await new Promise((r) => setTimeout(r, 20));
    expect(shows(m)).toEqual([]);
    expect(screen.getByTestId('mdi-window-Source').style.width).toBe('58%');
  });
});
