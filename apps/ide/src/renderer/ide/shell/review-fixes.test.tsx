/**
 * Regression tests for the M6 IDE-shell review findings (Run after a failed build, '&' in dynamic menu labels,
 * Window > project entry, project window build state / connection mark, Keyboard Shortcuts list, Add Default paths,
 * errors of Find and Open File).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockS12 } from '../../common/testing/mockS12';
import { S12Provider } from '../../common/s12';
import { findCommand, parseMnemonic, type MenuCommand } from '../../common/menu/model';
import { runIdeCommand } from '../commands';
import { lab3Info } from '../testing/lab3-model';
import type { BuildResultInfo } from '../../../shared/api';
import { createIdeActions, setIdeStatus, useIdeStatus, type IdeActions } from './actions';
import { esc, ideMenus, type IdeMenuActions, type IdeMenuState } from './menus';
import { ProjectWindow } from '../project/ProjectWindow';
import { FindAndOpenDialog, shortcutRows } from '../dialogs/MiscDialogs';
import { mergeDefaultPaths } from '../dialogs/target-settings-model';

const build = (ok: boolean): BuildResultInfo =>
  ({ ok, target: 'Standard', errors: ok ? 0 : 1, warnings: 0, messages: [], upToDate: false, compiled: [], skipped: [], linked: ok, burned: ok, outputs: [], files: [], elapsedMs: 1 }) as BuildResultInfo;

afterEach(() => setIdeStatus('Ready'));

describe('Project > Debug / Run (finding 3)', () => {
  it('Run after a failed build does not resume the old debug session', async () => {
    const m = createMockS12({ build: { make: async () => build(false) }, debug: { session: async () => ({}) as never } });
    const a = createIdeActions(m.api, () => lab3Info());
    expect(await a.debug()).toBe(false);
    await a.run();
    expect(m.calls('debug', 'launch')).toHaveLength(0);
    expect(m.calls('debug', 'go')).toHaveLength(0);
  });

  it('Run after a failed launch does not call go', async () => {
    const m = createMockS12({
      build: { make: async () => build(true) },
      debug: {
        launch: async () => {
          throw new Error('no target');
        },
        session: async () => ({}) as never,
      },
    });
    const a = createIdeActions(m.api, () => lab3Info());
    await a.run();
    expect(m.calls('debug', 'launch')).toHaveLength(1);
    expect(m.calls('debug', 'go')).toHaveLength(0);
  });

  it('Run after a good build launches and goes', async () => {
    const m = createMockS12({ build: { make: async () => build(true) }, debug: { launch: async () => ({}) as never } });
    const a = createIdeActions(m.api, () => lab3Info());
    expect(await a.debug()).toBe(true);
    await a.run();
    expect(m.calls('debug', 'go')).toHaveLength(1);
  });
});

const noop = new Proxy({}, { get: () => () => undefined }) as IdeMenuActions;
const state = (over: Partial<IdeMenuState> = {}): IdeMenuState => ({
  project: lab3Info(),
  building: false,
  activeFile: null,
  openFiles: [],
  dirtyCount: 0,
  recent: [],
  toolbarVisible: true,
  statusBarVisible: true,
  ...over,
});

describe('menu labels with & (finding 4)', () => {
  it('esc doubles ampersands', () => {
    expect(esc('P&E Multilink')).toBe('P&&E Multilink');
    expect(parseMnemonic(esc('P&E Multilink')).plain).toBe('P&E Multilink');
  });

  it('connection, recent, window and target labels show a literal &', () => {
    const info = lab3Info({ name: 'A&B', currentTarget: 'T&1', targets: lab3Info().targets.map((t) => ({ ...t, name: 'T&1' })) });
    const menus = ideMenus(noop, state({ project: info, recent: ['/x/R&D.mcp'], openFiles: ['/x/a&b.asm'] }));
    const conn = findCommand(menus, 'project.connection')!;
    expect(conn.submenu!.map((e) => parseMnemonic((e as MenuCommand).label).plain)).toContain('P&E Multilink USB');
    expect(parseMnemonic(findCommand(menus, 'file.recent.0')!.label).plain).toBe('1 /x/R&D.mcp');
    expect(parseMnemonic(findCommand(menus, 'window.project')!.label).plain).toBe('0 A&B.mcp');
    expect(parseMnemonic(findCommand(menus, 'window.doc.0')!.label).plain).toBe('1 a&b.asm');
    expect(parseMnemonic(findCommand(menus, 'edit.targetSettings')!.label).plain).toBe('T&1 Settings...');
  });
});

describe('Window > 0 <project>.mcp (finding 11)', () => {
  it('runs project.focus', () => {
    const cmd = vi.fn();
    const menus = ideMenus({ ...noop, cmd } as IdeMenuActions, state());
    findCommand(menus, 'window.project')!.onSelect!();
    expect(cmd).toHaveBeenCalledWith('project.focus');
  });

  it('the project window focuses its Files list on project.focus', async () => {
    const m = createMockS12({ project: { current: async () => lab3Info() } });
    render(
      <S12Provider api={m.api}>
        <ProjectWindow actions={{} as IdeActions} />
      </S12Provider>,
    );
    await screen.findByText('main.asm');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Link Order' }));
    expect(screen.queryByTestId('project-files-pane')).toBeNull();
    act(() => runIdeCommand('project.focus'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('project-files-pane')));
  });
});

describe('project window (findings 7 and 10)', () => {
  const setup = (building: boolean) => {
    const m = createMockS12({ project: { current: async () => lab3Info() } });
    const actions = { make: vi.fn(), debug: vi.fn(), run: vi.fn(), compile: vi.fn(), setConnection: vi.fn() } as unknown as IdeActions;
    render(
      <S12Provider api={m.api}>
        <ProjectWindow actions={actions} building={building} />
      </S12Provider>,
    );
    return actions;
  };

  it('disables Make / Debug / Run and Compile while building', async () => {
    setup(true);
    await screen.findByText('main.asm');
    for (const id of ['pw-make', 'pw-debug', 'pw-run']) expect(screen.getByTestId(id)).toBeDisabled();
    fireEvent.contextMenu(screen.getByText('main.asm'));
    expect(document.querySelector('[data-menu-id="pw.compile"]')).toHaveAttribute('aria-disabled', 'true');
  });

  it('enables them when idle', async () => {
    setup(false);
    await screen.findByText('main.asm');
    for (const id of ['pw-make', 'pw-debug', 'pw-run']) expect(screen.getByTestId(id)).toBeEnabled();
  });

  it('the connection popup marks the connection from the debugger arguments, like the menu bar', async () => {
    setup(false);
    await screen.findByText('main.asm');
    expect(screen.getByTestId('pw-connection')).toHaveAttribute('title', 'Change MCU/Connection (P&E Multilink USB)');
    fireEvent.click(screen.getByTestId('pw-connection'));
    expect(document.querySelector('[data-menu-id="conn:P&E_Multilink_USB"]')).toHaveAttribute('aria-checked', 'true');
    expect(document.querySelector('[data-menu-id="conn:Full_Chip_Simulation"]')).not.toHaveAttribute('aria-checked', 'true');
  });
});

describe('Keyboard Shortcuts list (finding 13)', () => {
  it('lists the shortcuts of disabled commands too (no project open)', () => {
    const rows = shortcutRows(ideMenus(noop, state({ project: null })));
    const keys = rows.map((r) => r.k);
    expect(keys).toEqual(expect.arrayContaining(['F7', 'F5', 'Alt+F7', 'Ctrl+F5', 'Ctrl+U']));
    expect(rows.find((r) => r.k === 'F7')).toEqual({ k: 'F7', label: 'Make', menu: 'Project' });
  });
});

describe('Access Paths > Add Default (finding 9)', () => {
  it('merges the defaults into the list and keeps custom paths', () => {
    expect(mergeDefaultPaths(['{Project}Custom', '{Project}Sources'], ['{Project}', '{Project}sources'])).toEqual(['{Project}Custom', '{Project}Sources', '{Project}']);
  });
});

describe('Find and Open File errors (finding 12)', () => {
  function StatusProbe() {
    return <div data-testid="status">{useIdeStatus()}</div>;
  }
  it('reports an open failure on the status bar', async () => {
    const m = createMockS12({
      project: {
        current: async () => lab3Info(),
        open: async () => {
          throw new Error('cannot read /nope/x.mcp');
        },
      },
    });
    render(
      <S12Provider api={m.api}>
        <FindAndOpenDialog open onClose={() => undefined} />
        <StatusProbe />
      </S12Provider>,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/nope/x.mcp' } });
    fireEvent.click(screen.getByTestId('find-open-dialog-ok'));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('cannot read /nope/x.mcp'));
  });
});
