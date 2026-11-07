import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DebugSnapshot, MemoryRange, RegisterSetInfo, SessionInfo, TextFile } from '../../../../shared/api';
import { S12Provider } from '../../../common/s12';
import { createMockS12, type MockS12 } from '../../../common/testing/mockS12';
import { autoLabel, configKey, configPath, formatText, freeSlot, ledOn, newInstrument, SLOT_W, parseConfig, readValue, resolveLocal, sanitizeInstrument, seg7Digits, SEG_DIGITS, watchRanges, type Instrument } from './model';
import { VisualizationComponent } from './VisualizationComponent';

const regs = (over: Partial<RegisterSetInfo> = {}): RegisterSetInfo => ({
  A: 0,
  B: 0,
  D: 0,
  X: 0,
  Y: 0,
  SP: 0,
  PC: 0xc000,
  CCR: 0,
  IPL: 0,
  CCRW: 0,
  PPAGE: 0,
  RPAGE: 0,
  EPAGE: 0,
  GPAGE: 0,
  DIRECT: 0,
  ...over,
});
const session: SessionInfo = {
  projectDir: '/proj/Lab3',
  connection: 'sim',
  connectionMenu: 'HCS12X FCS',
  derivative: 'MC9S12XDP512',
  title: 'S12 Studio Debugger',
};

describe('VisualizationTool model', () => {
  it('resolves CPU registers, numbers and device registers locally', () => {
    expect(resolveLocal('a')).toEqual({ kind: 'reg', name: 'A' });
    expect(resolveLocal('IX')).toEqual({ kind: 'reg', name: 'X' });
    expect(resolveLocal('PTP')).toEqual({ kind: 'mem', address: 0x258 });
    expect(resolveLocal('portb')).toEqual({ kind: 'mem', address: 0x001 });
    expect(resolveLocal('$1000')).toEqual({ kind: 'mem', address: 0x1000 });
    expect(resolveLocal('0x4000')).toEqual({ kind: 'mem', address: 0x4000 });
    expect(resolveLocal('600')).toEqual({ kind: 'mem', address: 600 });
    expect(resolveLocal('KEY_CHAR')).toBeNull(); // symbol: ask the debugger
    expect(resolveLocal(' ')).toMatchObject({ kind: 'error' });
  });

  it('reads byte/word values (big-endian) and registers', () => {
    const snap = { registers: regs({ D: 0x1234 }) } as DebugSnapshot;
    const mem = new Map([
      [0x1000, 0xab],
      [0x1001, 0xcd],
    ]);
    expect(readValue({ size: 2 }, { kind: 'mem', address: 0x1000 }, snap, mem)).toBe(0xabcd);
    expect(readValue({ size: 1 }, { kind: 'mem', address: 0x1001 }, snap, mem)).toBe(0xcd);
    expect(readValue({ size: 2 }, { kind: 'mem', address: 0x1001 }, snap, mem)).toBeNull();
    expect(readValue({ size: 2 }, { kind: 'reg', name: 'D' }, snap, null)).toBe(0x1234);
    expect(readValue({ size: 1 }, { kind: 'error', message: 'x' }, snap, mem)).toBeNull();
  });

  it('merges watch ranges', () => {
    expect(
      watchRanges([
        { address: 0x258, size: 1 },
        { address: 0x1000, size: 2 },
        { address: 0x1001, size: 2 },
        { address: 0x258, size: 1 },
        { address: 0x259, size: 1 },
      ]),
    ).toEqual([
      { address: 0x258, length: 2 },
      { address: 0x1000, length: 3 },
    ]);
  });

  it('LED bits, 7-segment digits and text formats', () => {
    const led = { ...newInstrument('led'), bit: 4 };
    expect(ledOn(led, 0x10)).toBe(true);
    expect(ledOn(led, 0xef)).toBe(false);
    expect(ledOn({ ...led, activeLow: true }, 0xef)).toBe(true);
    expect(ledOn(led, null)).toBeNull();
    const seg = newInstrument('seg7');
    expect(seg7Digits(seg, 0x3a)).toEqual([SEG_DIGITS[3], SEG_DIGITS[10]]);
    expect(seg7Digits({ ...seg, mode: 'dec' }, 7)).toEqual([0, 0, SEG_DIGITS[7]]);
    expect(seg7Digits({ ...seg, mode: 'dec', size: 2 }, 1234)).toEqual([0, ...[1, 2, 3, 4].map((d) => SEG_DIGITS[d])]);
    expect(seg7Digits({ ...seg, mode: 'segments' }, 0x86)).toEqual([0x86]);
    const txt = newInstrument('text');
    expect(formatText(txt, 0xc000)).toBe('$C000');
    expect(formatText({ ...txt, format: 'dec' }, 0xffff)).toBe('-1');
    expect(formatText({ ...txt, size: 1, format: 'bin' }, 5)).toBe('%00000101');
    expect(formatText(txt, null)).toBe('--');
  });

  it('config file: path next to the project, sanitized on load', () => {
    expect(configPath('/p/Lab3/')).toBe('/p/Lab3/S12Studio.vtl.json');
    expect(configPath('C:\\Lab3')).toBe('C:\\Lab3\\S12Studio.vtl.json');
    const c = parseConfig(
      JSON.stringify({
        windows: {
          VisualizationTool: [{ kind: 'led', expr: 'PTP', bit: 99, x: -5 }, { kind: 'nope', expr: 'A' }, 42],
        },
      }),
    );
    expect(c.windows.VisualizationTool).toHaveLength(1);
    expect(c.windows.VisualizationTool[0]).toMatchObject({
      kind: 'led',
      bit: 15,
      x: 0,
      color: 'red',
      size: 1,
    });
    expect(parseConfig('not json')).toEqual({ version: 1, windows: {} });
    expect(sanitizeInstrument({ kind: 'bar', expr: 'A', size: 2 })).toMatchObject({ min: 0, max: 0xffff });
  });
});

// ------------------------------------------------------------------------------------------------ component

const stored: Instrument[] = [
  {
    id: 'led1',
    kind: 'led',
    label: 'PP4',
    x: 10,
    y: 10,
    expr: 'PTP',
    size: 1,
    bit: 4,
    color: 'green',
  },
  {
    id: 'pc',
    kind: 'text',
    label: 'PC',
    x: 60,
    y: 10,
    expr: 'PC',
    size: 2,
    format: 'hex',
  },
  {
    id: 'seg',
    kind: 'seg7',
    label: 'key',
    x: 10,
    y: 60,
    expr: 'KEY_CHAR',
    size: 1,
    mode: 'hex',
  },
];

function setup(files: Record<string, string> = {}, props: { title?: string; instance?: number } = {}) {
  const written: { path: string; text: string }[] = [];
  const m = createMockS12({
    debug: {
      session: async () => session,
      resolve: async (e: string) => (e === 'KEY_CHAR' ? 0x1001 : null),
    },
    files: {
      readText: async (p: string): Promise<TextFile> => {
        if (!(p in files)) throw new Error('[not-found] no file');
        return {
          path: p,
          text: files[p],
          eol: 'lf',
          mtimeMs: 1,
          readOnly: false,
        } as TextFile;
      },
      writeText: async (req: { path: string; text: string }) => {
        written.push(req);
        files[req.path] = req.text;
        return { mtimeMs: 2 };
      },
    },
  });
  const el = (title: string, instance: number) => (
    <S12Provider api={m.api}>
      <VisualizationComponent instanceId={`w${instance}`} title={title} instance={instance} attributes={[]} active />
    </S12Provider>
  );
  const r = render(el(props.title ?? 'VisualizationTool', props.instance ?? 1));
  return { m, written, files, rerender: (title: string, instance: number) => r.rerender(el(title, instance)), unmount: r.unmount };
}

function lastWatch(m: MockS12): [string, MemoryRange[]] {
  const c = m.calls('debug', 'watchMemory');
  return c[c.length - 1] as [string, MemoryRange[]];
}

describe('VisualizationTool component', () => {
  it('loads the project config and shows live values from registers and watched memory', async () => {
    const path = '/proj/Lab3/S12Studio.vtl.json';
    const { m } = setup({
      [path]: JSON.stringify({
        version: 1,
        windows: { VisualizationTool: stored },
      }),
    });
    await waitFor(() => expect(screen.getByTestId('vis-item-led1')).toBeInTheDocument());
    // PTP local, KEY_CHAR through debug.resolve
    await waitFor(() =>
      expect(lastWatch(m)[1]).toEqual([
        { address: 0x258, length: 1 },
        { address: 0x1001, length: 1 },
      ]),
    );
    const [id] = lastWatch(m);
    const snap: DebugSnapshot = {
      seq: 5,
      state: 'halted',
      statusText: 'HALTED',
      cycles: 1,
      busHz: 8e6,
      simSeconds: 0,
      registers: regs({ PC: 0xc0de }),
      memory: {
        [id]: [
          {
            address: 0x258,
            space: 'local',
            bytes: new Uint8Array([0x10]),
            status: new Uint8Array([0]),
          },
          {
            address: 0x1001,
            space: 'local',
            bytes: new Uint8Array([0x4b]),
            status: new Uint8Array([0]),
          },
        ],
      },
    };
    act(() => m.emit('debug', 'snapshot', snap));
    expect(screen.getByTestId('vis-item-pc')).toHaveTextContent('$C0DE');
    expect(screen.getByTestId('vis-item-led1').querySelector('svg')).toHaveAttribute('data-state', 'on');
    expect(screen.getByTestId('vis-item-seg').querySelector('svg')).toHaveAttribute('data-digits', `${SEG_DIGITS[4].toString(16).padStart(2, '0')} ${SEG_DIGITS[11].toString(16).padStart(2, '0')}`);
    act(() =>
      m.emit('debug', 'snapshot', {
        ...snap,
        seq: 6,
        memory: {
          [id]: [{ ...snap.memory[id][0], bytes: new Uint8Array([0xef]) }, snap.memory[id][1]],
        },
      }),
    );
    expect(screen.getByTestId('vis-item-led1').querySelector('svg')).toHaveAttribute('data-state', 'off');
  });

  it('adds an instrument through the dialog and saves it per project; edit and delete', async () => {
    const { written, files } = setup();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText(/saved with the project/)).toBeInTheDocument());
    await user.click(screen.getByTestId('vis-add-bar'));
    const dlg = screen.getByTestId('vis-dialog');
    await user.clear(within(dlg).getByTestId('vis-expr'));
    await user.type(within(dlg).getByTestId('vis-expr'), 'B');
    await user.clear(within(dlg).getByTestId('vis-max'));
    await user.type(within(dlg).getByTestId('vis-max'), '100');
    await user.click(within(dlg).getByTestId('vis-dialog-ok'));
    expect(screen.queryByTestId('vis-dialog')).toBeNull();
    const item = document.querySelector('[data-kind="bar"]') as HTMLElement;
    expect(item).toBeTruthy();
    await waitFor(() => expect(written).toHaveLength(1), { timeout: 2000 });
    expect(written[0].path).toBe('/proj/Lab3/S12Studio.vtl.json');
    const saved = parseConfig(files[written[0].path]).windows.VisualizationTool;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      kind: 'bar',
      expr: 'B',
      min: 0,
      max: 100,
    });

    // edit (double-click) -> change label
    fireEvent.doubleClick(item);
    const dlg2 = screen.getByTestId('vis-dialog');
    await user.clear(within(dlg2).getByTestId('vis-label'));
    await user.type(within(dlg2).getByTestId('vis-label'), 'Speed');
    await user.click(within(dlg2).getByTestId('vis-dialog-ok'));
    expect(item).toHaveTextContent('Speed');
    await waitFor(() => expect(parseConfig(files[written[0].path]).windows.VisualizationTool[0].label).toBe('Speed'), { timeout: 2000 });

    // delete
    fireEvent.doubleClick(document.querySelector('[data-kind="bar"]') as HTMLElement);
    await user.click(screen.getByTestId('vis-dialog-delete'));
    expect(document.querySelector('[data-kind="bar"]')).toBeNull();
    await waitFor(() => expect(parseConfig(files[written[0].path]).windows.VisualizationTool).toEqual([]), { timeout: 2000 });
  });

  it('rejects an empty expression and keeps the dialog open', async () => {
    setup();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('vis-add-led'));
    const dlg = screen.getByTestId('vis-dialog');
    await user.clear(within(dlg).getByTestId('vis-expr'));
    await user.click(within(dlg).getByTestId('vis-dialog-ok'));
    expect(screen.getByRole('alert')).toHaveTextContent(/expression/);
    expect(screen.getByTestId('vis-dialog')).toBeInTheDocument();
  });

  it('drags an instrument to a new position (grid 4 px)', async () => {
    const path = '/proj/Lab3/S12Studio.vtl.json';
    const { files } = setup({
      [path]: JSON.stringify({ windows: { VisualizationTool: [stored[1]] } }),
    });
    await waitFor(() => expect(screen.getByTestId('vis-item-pc')).toBeInTheDocument());
    const el = screen.getByTestId('vis-item-pc');
    fireEvent.mouseDown(el, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 141, clientY: 119 });
    fireEvent.mouseUp(window);
    expect(el.style.left).toBe('100px');
    expect(el.style.top).toBe('28px'); // 10 + 19 = 29 -> grid 28
    await waitFor(() => expect(parseConfig(files[path]).windows.VisualizationTool[0]).toMatchObject({ x: 100, y: 28 }), { timeout: 2000 });
  });
  it('keeps its instruments when the shell renumbers the title (second window opened) and keys by instance', async () => {
    const path = '/proj/Lab3/S12Studio.vtl.json';
    const second: Instrument = { id: 'two', kind: 'text', label: 'second', x: 8, y: 8, expr: 'A', size: 1, format: 'hex' };
    const { files, written, rerender } = setup({ [path]: JSON.stringify({ windows: { VisualizationTool: stored, 'VisualizationTool:2': [second] } }) });
    await waitFor(() => expect(screen.getByTestId('vis-item-led1')).toBeInTheDocument());
    // "VisualizationTool" -> "VisualizationTool:1": same window (instance 1), same instruments
    rerender('VisualizationTool:1', 1);
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(screen.getByTestId('vis-item-led1')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-testid^="vis-item-"]')).toHaveLength(3);
    // an edit is saved under the instance key; the other window's entry is kept
    fireEvent.mouseDown(screen.getByTestId('vis-item-pc'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 40, clientY: 0 });
    fireEvent.mouseUp(window);
    await waitFor(() => expect(written).toHaveLength(1), { timeout: 2000 });
    const cfg = parseConfig(files[path]);
    expect(Object.keys(cfg.windows).sort()).toEqual(['VisualizationTool', 'VisualizationTool:2']);
    expect(cfg.windows.VisualizationTool.find((i) => i.id === 'pc')).toMatchObject({ x: 100 });
    expect(cfg.windows['VisualizationTool:2']).toEqual([second]);
    expect(configKey(1)).toBe('VisualizationTool');
    expect(configKey(3)).toBe('VisualizationTool:3');
  });

  it('a second window (instance 2) loads its own instruments', async () => {
    const path = '/proj/Lab3/S12Studio.vtl.json';
    setup({ [path]: JSON.stringify({ windows: { VisualizationTool: stored, 'VisualizationTool:2': [{ ...stored[1], id: 'only2' }] } }) }, { title: 'VisualizationTool:2', instance: 2 });
    await waitFor(() => expect(screen.getByTestId('vis-item-only2')).toBeInTheDocument());
    expect(screen.queryByTestId('vis-item-led1')).toBeNull();
  });

  it('places instruments added from the toolbar in free slots instead of stacking them', async () => {
    const { files, written } = setup();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText(/saved with the project/)).toBeInTheDocument());
    for (const k of ['led', 'seg7', 'text', 'bar']) {
      await user.click(screen.getByTestId(`vis-add-${k}`));
      await user.click(within(screen.getByTestId('vis-dialog')).getByTestId('vis-dialog-ok'));
    }
    const pos = [...document.querySelectorAll<HTMLElement>('[data-testid^="vis-item-"]')].map((e) => `${e.style.left},${e.style.top}`);
    expect(new Set(pos).size).toBe(4);
    await waitFor(() => expect(written.length).toBeGreaterThan(0), { timeout: 2000 });
    await waitFor(() => expect(parseConfig(files[written[0].path]).windows.VisualizationTool).toHaveLength(4), { timeout: 2000 });
  });

  it('a new instrument is labelled after its expression/bit unless the user types a label', async () => {
    const { files, written } = setup();
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByText(/saved with the project/)).toBeInTheDocument());
    await user.click(screen.getByTestId('vis-add-led'));
    const dlg = screen.getByTestId('vis-dialog');
    expect(within(dlg).getByTestId('vis-label')).toHaveValue('');
    await user.clear(within(dlg).getByTestId('vis-expr'));
    await user.type(within(dlg).getByTestId('vis-expr'), 'PORTB');
    await user.clear(within(dlg).getByTestId('vis-bit'));
    await user.type(within(dlg).getByTestId('vis-bit'), '2');
    expect(within(dlg).getByTestId('vis-label')).toHaveAttribute('placeholder', 'PORTB.2');
    await user.click(within(dlg).getByTestId('vis-dialog-ok'));
    expect(document.querySelector('[data-kind="led"] .vis-label')).toHaveTextContent('PORTB.2');
    await waitFor(() => expect(written).toHaveLength(1), { timeout: 2000 });
    expect(parseConfig(files[written[0].path]).windows.VisualizationTool[0]).toMatchObject({ label: '', expr: 'PORTB', bit: 2 });
  });

  it('switching to a project without a config starts empty; a pending edit is saved to its own project first', async () => {
    const pathA = '/proj/Lab3/S12Studio.vtl.json';
    const { m, files } = setup({ [pathA]: JSON.stringify({ windows: { VisualizationTool: [stored[1]] } }) });
    await waitFor(() => expect(screen.getByTestId('vis-item-pc')).toBeInTheDocument());
    // edit (drag) and switch project before the save delay elapses
    fireEvent.mouseDown(screen.getByTestId('vis-item-pc'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 0, clientY: 40 });
    fireEvent.mouseUp(window);
    act(() => m.emit('debug', 'session', { ...session, projectDir: '/proj/Other' }));
    await waitFor(() => expect(screen.queryByTestId('vis-item-pc')).toBeNull());
    expect(screen.getByTestId('vis-canvas')).toHaveTextContent(/Right-click or use Add/);
    await waitFor(() => expect(parseConfig(files[pathA]).windows.VisualizationTool[0]).toMatchObject({ y: 52 }));
    expect('/proj/Other/S12Studio.vtl.json' in files).toBe(false);
    // session gone: nothing shown, nothing saved
    act(() => m.emit('debug', 'session', null));
    await waitFor(() => expect(screen.getByText(/not saved/)).toBeInTheDocument());
  });

  it('flushes a pending edit when the window closes', async () => {
    const path = '/proj/Lab3/S12Studio.vtl.json';
    const { files, unmount } = setup({ [path]: JSON.stringify({ windows: { VisualizationTool: [stored[1]] } }) });
    await waitFor(() => expect(screen.getByTestId('vis-item-pc')).toBeInTheDocument());
    fireEvent.mouseDown(screen.getByTestId('vis-item-pc'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 20, clientY: 0 });
    fireEvent.mouseUp(window);
    unmount();
    await waitFor(() => expect(parseConfig(files[path]).windows.VisualizationTool[0]).toMatchObject({ x: 80 }));
  });
});

describe('VisualizationTool placement and labels', () => {
  it('freeSlot fills a row of slots, then the next row, skipping occupied ones', () => {
    const led = newInstrument('led');
    expect(freeSlot([], led, 500)).toEqual({ x: 8, y: 8 });
    const a = { ...led, x: 8, y: 8 };
    expect(freeSlot([a], led, 500)).toEqual({ x: 8 + SLOT_W, y: 8 });
    const b = { ...led, x: 8 + SLOT_W, y: 8 };
    const c = { ...newInstrument('bar'), x: 8 + 2 * SLOT_W, y: 8 };
    expect(freeSlot([a, b, c], led, 500)).toEqual({ x: 8, y: 80 });
    // narrow canvas: one column
    expect(freeSlot([a], led, 100)).toEqual({ x: 8, y: 80 });
    // a dragged instrument anywhere still blocks the slot it overlaps
    expect(freeSlot([{ ...led, x: 30, y: 20 }], led, 500)).toEqual({ x: 8 + SLOT_W, y: 8 });
  });

  it('autoLabel follows expression and bit', () => {
    expect(autoLabel({ kind: 'led', expr: ' PTT ', bit: 3 })).toBe('PTT.3');
    expect(autoLabel({ kind: 'bar', expr: 'TCNT' })).toBe('TCNT');
    expect(newInstrument('seg7').label).toBe('');
  });
});
