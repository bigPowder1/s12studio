import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMockS12 } from '../../common/testing/mockS12';
import { S12Provider } from '../../common/s12';
import { registerIdeCommand, setIdeContext } from '../commands';
import { lab3Info } from '../testing/lab3-model';
import type { BuildResultInfo } from '../../../shared/api';
import { IdeShell, ideTitle } from './IdeShell';
import { compileNames, effectiveConnection, ideMenus, type IdeMenuActions } from './menus';
import { collectShortcuts } from '../../common/menu/model';

// the editor track's Monaco editor and Errors & Warnings window are not under test here
const editorHandle = { current: null as null | { activePath: () => string | null; openPaths: () => string[]; dirtyPaths: () => string[] } };
vi.mock('../editor', () => ({ EditorArea: () => <div data-testid="editor-area" />, getEditorArea: () => editorHandle.current }));
vi.mock('../errors', () => ({ ErrorsWindow: () => null }));

const okBuild = (over: Partial<BuildResultInfo> = {}): BuildResultInfo => ({
  ok: true,
  target: 'Standard',
  errors: 0,
  warnings: 0,
  messages: [],
  upToDate: false,
  compiled: ['main.asm'],
  skipped: [],
  linked: true,
  burned: true,
  outputs: [],
  files: [],
  elapsedMs: 120,
  ...over,
});

function setup(overrides: Parameters<typeof createMockS12>[0] = {}) {
  const info = lab3Info();
  const m = createMockS12({
    project: { current: async () => info, setCurrentTarget: async () => info, ...overrides.project },
    build: { make: async () => okBuild(), bringUpToDate: async () => okBuild(), compile: async () => okBuild(), ...overrides.build },
    debug: { launch: async () => ({}) as never, ...overrides.debug },
    files: { openDialog: async () => [], recent: async () => ['/p/Lab3.mcp'], ...overrides.files },
    settings: { get: async () => ({ showStartupDialog: false }) as never },
  });
  render(
    <S12Provider api={m.api}>
      <IdeShell />
    </S12Provider>,
  );
  return m;
}

const key = (k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) => fireEvent.keyDown(window, { key: k, ...mods });

afterEach(() => {
  editorHandle.current = null;
  setIdeContext({ activeFile: null, openFiles: [], dirtyCount: 0 });
});

describe('IDE menus (model)', () => {
  const noop = new Proxy({}, { get: () => () => undefined }) as IdeMenuActions;
  it('has the CW 5.1 menu bar and shortcuts', () => {
    const menus = ideMenus(noop, { project: lab3Info(), building: false, activeFile: '/p/Sources/main.asm', openFiles: [], dirtyCount: 0, recent: [], toolbarVisible: true, statusBarVisible: true });
    expect(menus.map((m) => m.label.replace('&', ''))).toEqual(['File', 'Edit', 'View', 'Search', 'Project', 'Window', 'Help']);
    const sc = collectShortcuts(menus);
    const ids = Object.fromEntries([...sc].map(([k, c]) => [k, c.id]));
    expect(ids).toMatchObject({
      'Ctrl+N': 'file.newText',
      'Ctrl+O': 'file.open',
      'Ctrl+S': 'file.save',
      'Ctrl+W': 'file.close',
      'Ctrl+F': 'search.find',
      'Ctrl+G': 'search.gotoLine',
      F3: 'search.findNext',
      F7: 'project.make',
      'Ctrl+F7': 'project.compile',
      'Ctrl+U': 'project.bringUpToDate',
      F5: 'project.debug',
      'Ctrl+F5': 'project.run',
      'Alt+F7': 'edit.targetSettings',
    });
  });

  it('disables project commands without a project; Compile needs a project file in the active editor', () => {
    const none = ideMenus(noop, { project: null, building: false, activeFile: null, openFiles: [], dirtyCount: 0, recent: [], toolbarVisible: true, statusBarVisible: true });
    const sc = collectShortcuts(none);
    expect(sc.has('F7')).toBe(false);
    expect(sc.has('F5')).toBe(false);
    expect(sc.has('Ctrl+O')).toBe(true);
    const notInProj = ideMenus(noop, { project: lab3Info(), building: false, activeFile: '/tmp/x.asm', openFiles: [], dirtyCount: 0, recent: [], toolbarVisible: true, statusBarVisible: true });
    expect(collectShortcuts(notInProj).has('Ctrl+F7')).toBe(false);
  });
});

describe('menu helpers', () => {
  it('effective connection: sidecar choice, else the .mcp debugger arguments', () => {
    expect(effectiveConnection(lab3Info())).toBe('P&E_Multilink_USB');
    expect(effectiveConnection(lab3Info({ connection: 'Full_Chip_Simulation' }))).toBe('Full_Chip_Simulation');
  });
  it('Compile targets the active project file, else the selected .asm', () => {
    const p = lab3Info();
    expect(compileNames(p, '/p/Sources/main.asm')).toEqual(['main.asm']);
    expect(compileNames(p, '/elsewhere.asm', 'main.asm')).toEqual(['main.asm']);
    expect(compileNames(p, null, 'Project.prm')).toEqual([]);
    expect(compileNames(null, '/p/Sources/main.asm')).toEqual([]);
  });
});

describe('IdeShell', () => {
  it('titles the window "S12 Studio - [Lab3.mcp]" and shows the project window', async () => {
    setup();
    await waitFor(() => expect(document.title).toBe('S12 Studio - [Lab3.mcp]'));
    expect(ideTitle(null)).toBe('S12 Studio');
    expect(screen.getByTestId('project-files')).toHaveTextContent('main.asm');
    expect(screen.getByTestId('editor-area')).toBeInTheDocument();
    // target and connection are in the project window toolbar, not the status bar (final fidelity F7)
    expect(screen.getByTestId('pw-target')).toHaveValue('Standard');
    expect(screen.getByTestId('pw-connection')).toHaveAttribute('title', 'Change MCU/Connection (P&E Multilink USB)');
    expect(screen.getByTestId('ide-status')).not.toHaveTextContent('P&E Multilink USB');
    expect(screen.queryByTestId('tb-make')).toBeNull();
    expect(document.querySelector('[data-menu-id="window.debugger"]')).toBeNull();
  });

  it('F7 makes, Ctrl+U brings up to date, Ctrl+F7 compiles the active editor file', async () => {
    const m = setup();
    await screen.findByTestId('project-files');
    key('F7');
    key('u', { ctrlKey: true });
    await waitFor(() => expect(m.calls('build', 'make')).toHaveLength(1));
    expect(m.calls('build', 'bringUpToDate')).toHaveLength(1);
    act(() => setIdeContext({ activeFile: '/p/Sources/main.asm', openFiles: ['/p/Sources/main.asm'] }));
    key('F7', { ctrlKey: true });
    await waitFor(() => expect(m.calls('build', 'compile')).toEqual([[['main.asm']]]));
  });

  it('F5 makes the target (assemble + link), then launches the debugger; build errors cancel it', async () => {
    const m = setup();
    await screen.findByTestId('project-files');
    key('F5');
    await waitFor(() => expect(m.calls('debug', 'launch')).toHaveLength(1));
    expect(m.calls('build', 'make')).toHaveLength(1);
    expect(m.calls('build', 'bringUpToDate')).toHaveLength(0);

    const m2 = setup({ build: { make: async () => okBuild({ ok: false, errors: 1 }) } });
    await waitFor(() => expect(screen.getAllByTestId('project-files')).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId('pw-debug')[1]);
    await waitFor(() => expect(m2.calls('build', 'make')).toHaveLength(1));
    expect(m2.calls('debug', 'launch')).toHaveLength(0);
  });

  it('follows the editor area (getEditorArea) for Compile and the Window menu', async () => {
    const m = setup();
    await screen.findByTestId('project-files');
    editorHandle.current = { activePath: () => '/p/Sources/main.asm', openPaths: () => ['/p/Sources/main.asm', '/p/prm/Project.prm'], dirtyPaths: () => [] };
    fireEvent.mouseDown(document.body); // clicking into the editor syncs the IDE context (also a 500 ms timer)
    key('F7', { ctrlKey: true });
    await waitFor(() => expect(m.calls('build', 'compile')).toEqual([[['main.asm']]]));
    fireEvent.mouseDown(screen.getByText('indow', { exact: false, selector: '[role=menubar] > [role=menuitem] *, [role=menubar] > [role=menuitem]' }));
    const menu = screen.getByTestId('menu-Window');
    expect(menu).toHaveTextContent('1 main.asm');
    expect(menu).toHaveTextContent('2 Project.prm');
  });

  it('Ctrl+F5 runs (debug + go)', async () => {
    const m = setup({ debug: { launch: async () => ({}) as never, session: async () => ({}) as never } });
    await screen.findByTestId('project-files');
    key('F5', { ctrlKey: true });
    await waitFor(() => expect(m.calls('debug', 'go')).toHaveLength(1));
  });

  it('Ctrl+N / Ctrl+S / Ctrl+F dispatch editor commands, even from a text field', async () => {
    setup();
    await screen.findByTestId('project-files');
    const got: string[] = [];
    const offs = (['editor.new', 'editor.save', 'editor.find'] as const).map((c) => registerIdeCommand(c, () => void got.push(c)));
    key('n', { ctrlKey: true });
    key('s', { ctrlKey: true });
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'f', ctrlKey: true });
    fireEvent.keyDown(input, { key: 'c', ctrlKey: true }); // copy stays with the field
    expect(got).toEqual(['editor.new', 'editor.save', 'editor.find']);
    offs.forEach((o) => o());
    input.remove();
  });

  it('Alt+F7 opens "<target> Settings"; Ctrl+Shift+N opens New Project; Help > About says not affiliated', async () => {
    setup();
    await screen.findByTestId('project-files');
    key('F7', { altKey: true });
    expect(await screen.findByRole('dialog', { name: 'Standard Settings' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ts-cancel'));
    key('N', { ctrlKey: true, shiftKey: true });
    expect(await screen.findByTestId('new-project-dialog')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByText('elp', { exact: false }));
    fireEvent.click(screen.getByTestId('menu-Help').querySelector('[data-menu-id="help.about"]')!);
    expect(await screen.findByTestId('about-not-affiliated')).toHaveTextContent('not affiliated with');
  });

  it('File > Open: .mcp opens a project, .abs starts the debugger, .asm goes to the editor', async () => {
    let next: string[] = [];
    const m = setup({ files: { openDialog: async () => next, recent: async () => [] } });
    await screen.findByTestId('project-files');
    const opened: unknown[] = [];
    const off = registerIdeCommand('editor.open', (a) => void opened.push(a));
    next = ['/q/Other.mcp', '/p/bin/Project.abs', '/p/Sources/main.asm'];
    key('o', { ctrlKey: true });
    await waitFor(() => expect(opened).toEqual([{ path: '/p/Sources/main.asm' }]));
    expect(m.calls('project', 'open')).toEqual([['/q/Other.mcp']]);
    expect(m.calls('debug', 'launch')).toEqual([[{ absPath: '/p/bin/Project.abs', load: true }]]);
    off();
  });

  it('build events drive the status bar and open Errors & Warnings on messages', async () => {
    const m = setup();
    await screen.findByTestId('project-files');
    const shown: unknown[] = [];
    const off = registerIdeCommand('errors.show', () => void shown.push(1));
    act(() => m.emit('build', 'started', { kind: 'make', target: 'Standard' }));
    expect(screen.getByTestId('ide-status')).toHaveTextContent('Making...');
    expect(screen.getByTestId('pw-make')).toBeDisabled();
    act(() => m.emit('build', 'progress', { step: 'assemble', file: 'main.asm', done: 1, total: 3 }));
    expect(screen.getByTestId('ide-status')).toHaveTextContent('Assembling main.asm (1/3)');
    act(() => m.emit('build', 'finished', okBuild({ ok: false, errors: 2, warnings: 1 })));
    expect(screen.getByTestId('ide-status')).toHaveTextContent('Build failed: 2 error(s), 1 warning(s)');
    expect(shown).toHaveLength(1);
    expect(screen.getByTestId('pw-make')).toBeEnabled();
    off();
  });

  it('Project > Set Default Target and the toolbar target selector call setCurrentTarget', async () => {
    const info = lab3Info();
    info.targets = [info.targets[0], { ...info.targets[0], name: 'Simulator' }];
    const m = setup({ project: { current: async () => info, setCurrentTarget: async () => info } });
    await screen.findByTestId('project-files');
    fireEvent.change(screen.getByTestId('pw-target'), { target: { value: 'Simulator' } });
    await waitFor(() => expect(m.calls('project', 'setCurrentTarget')).toEqual([['Simulator']]));
    fireEvent.mouseDown(screen.getByText('roject', { exact: false, selector: '[role=menubar] > [role=menuitem] *, [role=menubar] > [role=menuitem]' }));
    const menu = screen.getByTestId('menu-Project');
    fireEvent.mouseEnter(menu.querySelector('[data-menu-id="project.setDefaultTarget"]')!);
    fireEvent.click(within(menu).getByText('Standard'));
    await waitFor(() => expect(m.calls('project', 'setCurrentTarget')).toEqual([['Simulator'], ['Standard']]));
  });
});
