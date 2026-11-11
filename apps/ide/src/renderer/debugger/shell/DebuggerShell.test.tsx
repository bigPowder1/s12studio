import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { parseHwl } from '@s12/formats';
// hiwave-format test data of our own (the same layout/ini shapes as a CodeWarrior project's)
import { ASM_LAYOUT_HWL as asmLayoutText, FCS_INI as fcsIniText } from '../../common/monaco/testing/hiwave-texts';
import { createMockS12, type MockOverrides } from '../../common/testing/mockS12';
import { S12Provider } from '../../common/s12';
import type { HwlLayoutInfo } from '../../../shared/api';
import { SESSION, snapshot } from './testing';
import { DebuggerShell } from './DebuggerShell';

// Stub components: the shell is tested on its own (real components have their own tests).
vi.mock('../components/registry', async () => {
  const { useComponentMenu } = await import('../components/contract');
  const MENU = [{ id: 'stub.item', label: '&Stub Item', onSelect: () => undefined }];
  const Stub = ({ title }: { title: string }) => {
    useComponentMenu(MENU);
    return <div data-testid={`stub-${title}`}>{title}</div>;
  };
  const names = ['Source', 'Assembly', 'Register', 'Procedure', 'Memory', 'Data', 'Command', 'Terminal', 'ME3305 Board', 'VisualizationTool'] as const;
  const COMPONENTS = names.map((name) => ({ name, component: Stub, multiInstance: ['Memory', 'Data', 'VisualizationTool'].includes(name), infoBar: ['Source', 'Assembly', 'Register', 'Procedure', 'Memory', 'Data'].includes(name), description: `${name} window` }));
  const findComponent = (n: string) => {
    const k = n.trim().toLowerCase().replace(/[\s_]/g, '');
    return COMPONENTS.find((c) => c.name.toLowerCase().replace(/\s/g, '') === k);
  };
  return { COMPONENTS, findComponent };
});

const asmLayout = (): HwlLayoutInfo => {
  const l = parseHwl(asmLayoutText);
  return { ...l, otherRaw: l.other.map((c) => c.raw) };
};

function setup(over: MockOverrides = {}) {
  const m = createMockS12({
    ...over,
    debug: { session: async () => SESSION, ...over.debug },
    layout: { read: async () => asmLayout(), defaultLayout: async () => asmLayout(), ...over.layout },
    files: { readText: async (path: string) => ({ path, text: fcsIniText, eol: 'crlf' as const, mtimeMs: 0, readOnly: false }), ...over.files },
  });
  render(
    <S12Provider api={m.api}>
      <DebuggerShell />
    </S12Provider>,
  );
  return m;
}

const pane = (id: string) => document.querySelector(`[data-testid="debugger-status"] [data-pane="${id}"]`) as HTMLElement;
const openMenu = (label: string) => fireEvent.mouseDown(document.querySelector(`[data-menu="${label}"]`)!);
/** The layout is applied and the active component (Data) has registered its menu (menu indices are stable). */
const ready = () => waitFor(() => expect(document.querySelector('[role="menubar"] > [data-menu="Data"]')).not.toBeNull());
const menuItem = (id: string) => document.querySelector(`[data-menu-id="${id}"]`) as HTMLElement;

describe('DebuggerShell', () => {
  it('lays out the session .hwl as positioned MDI windows (assembly layout)', async () => {
    const m = setup();
    await waitFor(() => screen.getByTestId('mdi-window-Source'));
    expect(m.calls('layout', 'read')).toEqual([[SESSION.layoutPath]]);
    const src = screen.getByTestId('mdi-window-Source');
    expect(src.style.left).toBe('0%');
    expect(src.style.width).toBe('58%');
    expect(src.style.height).toBe('46%');
    const reg = screen.getByTestId('mdi-window-Register');
    expect([reg.style.left, reg.style.top, reg.style.width, reg.style.height]).toEqual(['58%', '0%', '42%', '28%']);
    // ACTIVATE "Procedure" ... "Data": Data is active and on top
    expect(screen.getByTestId('mdi-caption-Data')).toHaveClass('active');
    expect(Number(screen.getByTestId('mdi-window-Data').style.zIndex)).toBeGreaterThan(Number(src.style.zIndex));
    expect(document.title).toBe(SESSION.title.replace(/\s+/g, ' ')); // document.title collapses spaces
    // the active component's own menu sits between Component and Window
    const labels = () => [...document.querySelectorAll('[role="menubar"] > [data-menu]')].map((e) => e.getAttribute('data-menu'));
    await waitFor(() => expect(labels()).toEqual(['File', 'View', 'Run', 'HCS12X FCS', 'Component', 'Data', 'Window', 'Help']));
  });

  it('keeps the Object Info Bar of hiwave view components even while it has no text (no body height jumps)', async () => {
    setup();
    await waitFor(() => screen.getByTestId('mdi-window-Assembly'));
    // the stubs never set a headline: Assembly/Source keep an empty bar, Command (no info bar in hiwave) has none
    expect(screen.getByTestId('headline-Assembly')).toHaveTextContent('');
    expect(screen.getByTestId('headline-Source')).toBeInTheDocument();
    expect(screen.queryByTestId('headline-Command')).toBeNull();
  });

  it('builds the toolbar from the ini TOOLBAR= key and enables it by run state', async () => {
    const m = setup();
    await waitFor(() => expect(m.calls('files', 'readText')).toEqual([[SESSION.iniPath]]));
    await waitFor(() => screen.getByTestId('tb-cut'));
    const ids = [...screen.getByTestId('debugger-toolbar').querySelectorAll('button')].map((b) => b.getAttribute('data-testid'));
    expect(ids).toEqual(['tb-new', 'tb-open', 'tb-save', 'tb-cut', 'tb-copy', 'tb-paste', 'tb-help', 'tb-context-help', 'tb-go', 'tb-step', 'tb-step-over', 'tb-step-out', 'tb-asm-step', 'tb-halt', 'tb-reset']);
    expect(screen.getByTestId('tb-go')).toBeDisabled();
    act(() => m.emit('debug', 'snapshot', snapshot()));
    expect(screen.getByTestId('tb-go')).toBeEnabled();
    expect(screen.getByTestId('tb-asm-step')).toBeEnabled();
    expect(screen.getByTestId('tb-halt')).toBeDisabled();
    act(() => m.emit('debug', 'snapshot', snapshot({ state: 'running' })));
    expect(screen.getByTestId('tb-go')).toBeDisabled();
    expect(screen.getByTestId('tb-halt')).toBeEnabled();
    fireEvent.click(screen.getByTestId('tb-halt'));
    expect(m.calls('debug', 'halt')).toEqual([[]]);
  });

  it('status bar: message, frequency, cycles (double-click resets), derivative, run state', async () => {
    const m = setup({ debug: { resetCycles: async () => Promise.reject(new Error('[not-implemented] no')) } });
    await waitFor(() => expect(pane('derivative')).toHaveTextContent('MC9S12XDP512'));
    expect(pane('help')).toHaveTextContent('For Help, press F1');
    expect(pane('state')).toHaveTextContent('Ready');
    act(() => m.emit('debug', 'snapshot', snapshot({ cycles: 123456789012, busHz: 8_000_000, statusText: 'Breakpoint' })));
    expect(pane('clock')).toHaveTextContent('8.000000 MHz');
    expect(pane('cycles')).toHaveTextContent('123456789012');
    expect(pane('state')).toHaveTextContent('Breakpoint');
    fireEvent.doubleClick(pane('cycles'));
    expect(m.calls('debug', 'resetCycles')).toEqual([[]]);
    // the engine could not reset: the displayed counter restarts from 0 anyway
    await waitFor(() => expect(pane('cycles')).toHaveTextContent(/^0$/));
    act(() => m.emit('debug', 'snapshot', snapshot({ cycles: 123456789112, statusText: 'STEPPED' })));
    expect(pane('cycles')).toHaveTextContent(/^100$/);
    expect(pane('state')).toHaveTextContent('STEPPED');
    act(() => m.emit('debug', 'snapshot', snapshot({ state: 'running', statusText: 'RUNNING' })));
    expect(pane('state')).toHaveTextContent('RUNNING');
  });

  it('binds the Run shortcuts on the window, honouring the run state', async () => {
    const m = setup();
    await waitFor(() => screen.getByTestId('mdi-window-Source'));
    fireEvent.keyDown(window, { key: 'F5' });
    expect(m.calls('debug', 'go')).toEqual([]); // nothing loaded yet
    act(() => m.emit('debug', 'snapshot', snapshot()));
    fireEvent.keyDown(window, { key: 'F11', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'F10' });
    fireEvent.keyDown(window, { key: 'F11', shiftKey: true });
    fireEvent.keyDown(window, { key: 'F5' });
    expect(m.calls('debug', 'step')).toEqual([['instr'], ['srcOver'], ['srcOut']]);
    expect(m.calls('debug', 'go')).toEqual([[]]);
    act(() => m.emit('debug', 'snapshot', snapshot({ state: 'running' })));
    fireEvent.keyDown(window, { key: 'F6' });
    expect(m.calls('debug', 'halt')).toEqual([[]]);
    fireEvent.keyDown(window, { key: 'R', ctrlKey: true });
    expect(m.calls('debug', 'reset')).toEqual([[]]);
  });

  it('run shortcuts are inert while a modal dialog is open (review finding 7)', async () => {
    const m = setup();
    await ready();
    act(() => m.emit('debug', 'snapshot', snapshot()));
    openMenu('Help');
    fireEvent.click(menuItem('help.about'));
    expect(screen.getByTestId('about-dialog')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'F5' });
    fireEvent.keyDown(window, { key: 'F11' });
    expect(m.calls('debug', 'go')).toEqual([]);
    expect(m.calls('debug', 'step')).toEqual([]);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('about-dialog')).toBeNull();
    fireEvent.keyDown(window, { key: 'F5' });
    expect(m.calls('debug', 'go')).toEqual([[]]);
  });

  it('Component > Open lists every registered component and opens the selection', async () => {
    setup();
    await ready();
    openMenu('Component');
    fireEvent.click(menuItem('component.open'));
    const dlg = screen.getByTestId('component-open-dialog');
    // the 10 implemented components plus hiwave's other components, greyed out (final fidelity F12)
    expect(within(dlg).getAllByRole('option').filter((o) => o.getAttribute('aria-disabled') !== 'true')).toHaveLength(10);
    expect(within(dlg).getAllByRole('option').filter((o) => o.getAttribute('aria-disabled') === 'true').map((o) => o.textContent)).toContain('Profiler');
    for (const t of ['list', 'details', 'icon']) fireEvent.mouseDown(screen.getByTestId(`component-open-tab-${t}`));
    expect(within(dlg).getByRole('listbox').getAttribute('data-view')).toBe('icon');
    fireEvent.mouseDown(screen.getByTestId('component-option-Memory'));
    fireEvent.mouseDown(screen.getByTestId('component-option-Terminal'), { ctrlKey: true });
    fireEvent.click(screen.getByTestId('component-open-ok'));
    expect(screen.queryByTestId('component-open-dialog')).toBeNull();
    expect(screen.getByTestId('mdi-window-Memory:1')).toBeInTheDocument();
    expect(screen.getByTestId('mdi-window-Memory:2')).toBeInTheDocument();
    expect(screen.getByTestId('mdi-caption-Terminal')).toHaveClass('active');
    // the Window menu lists the windows and checks the active one
    openMenu('Window');
    const list = [...document.querySelectorAll('[data-menu-id^="window.select."]')].map((e) => e.textContent);
    expect(list).toContain('✓9 Terminal');
  });

  it('Window > Tile re-arranges, and Save Configuration writes the layout back to the .hwl', async () => {
    const m = setup();
    await ready();
    openMenu('Window');
    fireEvent.click(menuItem('window.tile'));
    expect(screen.getByTestId('mdi-window-Source').style.width).toBe(`${100 / 3}%`);
    openMenu('File');
    fireEvent.click(menuItem('file.saveConfig'));
    await waitFor(() => expect(m.calls('layout', 'write')).toHaveLength(1));
    const [path, layout] = m.calls('layout', 'write')[0] as [string, HwlLayoutInfo];
    expect(path).toBe(SESSION.layoutPath);
    expect(layout.windows.map((w) => w.component)).toEqual(['source', 'register', 'assembly', 'memory', 'procedure', 'data', 'command']);
    expect(layout.windows[0]).toMatchObject({ x: 0, y: 0, w: 33, h: 33 });
    expect(layout.activate.at(-1)).toBe('Data');
    expect(layout.font).toEqual({ face: 'Consolas', size: 10, color: 'BLACK' });
  });

  it('handles OPEN / ACTIVATE / CLOSE window commands from the interpreter', async () => {
    const m = setup();
    await waitFor(() => screen.getByTestId('mdi-window-Source'));
    act(() => m.emit('debug', 'uiCommand', { keyword: 'OPEN', argText: 'terminal 10 20 30 40', raw: 'OPEN terminal 10 20 30 40' }));
    const t = screen.getByTestId('mdi-window-Terminal');
    expect([t.style.left, t.style.top, t.style.width, t.style.height]).toEqual(['10%', '20%', '30%', '40%']);
    act(() => m.emit('debug', 'uiCommand', { keyword: 'ACTIVATE', argText: '"Source"', raw: '' }));
    expect(screen.getByTestId('mdi-caption-Source')).toHaveClass('active');
    act(() => m.emit('debug', 'uiCommand', { keyword: 'CLOSE', argText: 'Terminal', raw: '' }));
    expect(screen.queryByTestId('mdi-window-Terminal')).toBeNull();
    // review finding 6: ;I (iconic) and ;MAX flags, also glued to the last number
    act(() => m.emit('debug', 'uiCommand', { keyword: 'OPEN', argText: 'terminal 5 5 30 30;I', raw: '' }));
    const ti = screen.getByTestId('mdi-window-Terminal');
    expect(ti).toHaveClass('minimized');
    expect([ti.style.left, ti.style.top, ti.style.width, ti.style.height].join()).not.toBe('26%,26%,50%,40%');
    act(() => m.emit('debug', 'uiCommand', { keyword: 'OPEN', argText: 'Terminal 5 5 30 30 ;MAX', raw: '' }));
    expect(screen.getByTestId('mdi-window-Terminal')).toHaveClass('maximized');
  });

  it('minimizes, maximizes and closes windows from the caption buttons', async () => {
    setup();
    await waitFor(() => screen.getByTestId('mdi-window-Command'));
    const cap = screen.getByTestId('mdi-caption-Command');
    fireEvent.click(within(cap).getByLabelText('Maximize'));
    expect(screen.getByTestId('mdi-window-Command')).toHaveClass('maximized');
    fireEvent.click(within(cap).getByLabelText('Restore'));
    fireEvent.click(within(cap).getByLabelText('Minimize'));
    expect(screen.getByTestId('mdi-window-Command')).toHaveClass('minimized');
    fireEvent.click(screen.getByTestId('mdi-close-Command'));
    expect(screen.queryByTestId('mdi-window-Command')).toBeNull();
  });

  it('menus follow hiwave: Reset in the connection menu (Ctrl+R), no IDE entry in Window, Set Connection enabled', async () => {
    const m = setup();
    await ready();
    openMenu('Run');
    expect(menuItem('run.reset')).toBeNull();
    openMenu('HCS12X FCS');
    expect(menuItem('conn.reset').textContent).toContain('Ctrl+R');
    expect(menuItem('conn.busTrace')).toHaveClass('disabled');
    openMenu('Window');
    expect(menuItem('window.ide')).toBeNull();
    openMenu('View');
    expect(menuItem('view.customize')).not.toBeNull();
    openMenu('Component');
    fireEvent.click(menuItem('component.setConnection'));
    expect(screen.getByTestId('set-connection-select')).toHaveValue('Full Chip Simulation');
    fireEvent.click(screen.getByTestId('set-connection-ok'));
    await waitFor(() => expect(m.calls('debug', 'launch')).toHaveLength(1));
  });

  it('File > Load Application opens "Load Executable File" preset from LoadDialogOptions', async () => {
    const m = setup();
    await ready();
    await waitFor(() => expect(m.calls('files', 'readText').length).toBeGreaterThan(0));
    openMenu('File');
    fireEvent.click(menuItem('file.load'));
    expect(screen.getByTestId('load-dialog')).toBeInTheDocument();
    // Full_Chip_Simulation.ini: LoadDialogOptions=AUTOERASEANDFLASH NORUNAFTERLOAD
    await waitFor(() => expect(screen.getByTestId('load-dialog-erase')).toBeChecked());
    expect(screen.getByTestId('load-dialog-run')).not.toBeChecked();
    fireEvent.change(screen.getByTestId('load-dialog-path'), { target: { value: '/p/Lab3/bin/Project.abs' } });
    fireEvent.click(screen.getByTestId('load-dialog-open'));
    await waitFor(() => expect(m.calls('debug', 'loadApplication')).toEqual([[{ path: '/p/Lab3/bin/Project.abs', options: ['AUTOERASEANDFLASH', 'NORUNAFTERLOAD'] }]]));
  });
  it('shows a status-bar note when Make rebuilt the loaded application', async () => {
    const m = setup();
    await waitFor(() => expect(pane('help')).toHaveTextContent('For Help, press F1'));
    await act(async () => m.emit('debug', 'applicationRebuilt', { absPath: 'C:\\Lab3\\bin\\Project.abs', target: 'Standard' }));
    expect(pane('help')).toHaveTextContent('Project.abs was rebuilt.');
  });
});
