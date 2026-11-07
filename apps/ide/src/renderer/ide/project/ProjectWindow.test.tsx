import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMockS12 } from '../../common/testing/mockS12';
import { S12Provider } from '../../common/s12';
import { registerIdeCommand } from '../commands';
import { lab3Info } from '../testing/lab3-model';
import { ProjectWindow, groupTree, reorder, sizeText } from './ProjectWindow';
import type { IdeActions } from '../shell/actions';

function setup(info = lab3Info()) {
  const m = createMockS12({ project: { current: async () => info } });
  const actions = { make: vi.fn(), debug: vi.fn(), run: vi.fn(), synchronize: vi.fn(), setTarget: vi.fn(), setConnection: vi.fn(), compile: vi.fn(), checkSyntax: vi.fn() } as unknown as IdeActions;
  const r = render(
    <S12Provider api={m.api}>
      <ProjectWindow actions={actions} />
    </S12Provider>,
  );
  return { m, actions, ...r };
}

const row = (name: string) => screen.getByText(name).closest('tr')!;

describe('groupTree / sizeText / reorder', () => {
  it('builds the Lab3 group tree with nested groups and CW Code/Data texts', () => {
    const t = groupTree(lab3Info());
    expect(t.map((n) => n.label)).toEqual(['Sources', 'Includes', 'Libraries', 'Project Settings']);
    const linker = t[3].children![0];
    expect(linker.data).toEqual({ kind: 'group', path: ['Project Settings', 'Linker Files'] });
    expect(linker.children!.map((n) => n.key)).toEqual(['f:burner.bbl', 'f:Project.map', 'f:Project.prm']);
    expect(sizeText(t[0].children![0], 'code')).toBe('812');
    expect(sizeText(t[0], 'code')).toBe('812'); // group total
    expect(sizeText(linker.children![1], 'data')).toBe('n/a');
    expect(sizeText(t[1], 'code')).toBe(''); // only includes: no total
  });

  it('reorder moves an item in front of a target index', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 0, 3)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorder(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(reorder(['a', 'b', 'c', 'd'], 1, 4)).toEqual(['a', 'c', 'd', 'b']);
    expect(reorder(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('ProjectWindow', () => {
  it('shows a hint without a project', () => {
    const m = createMockS12();
    render(
      <S12Provider api={m.api}>
        <ProjectWindow />
      </S12Provider>,
    );
    expect(screen.getByText(/No project open/)).toBeInTheDocument();
  });

  it('renders groups/files of a fixture-shaped model with Code, Data, touch and debug columns', async () => {
    setup();
    const files = await screen.findByTestId('project-files');
    for (const n of ['Sources', 'Includes', 'Libraries', 'Project Settings', 'Linker Files', 'main.asm', 'derivative.inc', 'mc9s12xdp512.inc', 'ME305LibV4.0.lib', 'burner.bbl', 'Project.map', 'Project.prm']) {
      expect(within(files).getByText(n)).toBeInTheDocument();
    }
    expect(within(row('main.asm')).getAllByText('812')).toHaveLength(1);
    expect(within(row('Project.prm')).getAllByText('n/a')).toHaveLength(2);
    expect(screen.getByTestId('touch-main.asm')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('debug-main.asm')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('debug-ME305LibV4.0.lib')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Lab3.mcp')).toBeInTheDocument();
    expect(screen.getByTestId('project-footer')).toHaveTextContent('7 files');
    expect(screen.getByTestId('project-footer')).toHaveTextContent('2812'); // 812 + 2000
    // a single target: no target column; the header select lists the targets
    expect(screen.getByTestId('pw-target')).toHaveValue('Standard');
  });

  it('double-click opens the file; touch/debug clicks call the contract', async () => {
    const { m } = setup();
    const opened: unknown[] = [];
    const off = registerIdeCommand('editor.open', (a) => void opened.push(a));
    await screen.findByTestId('project-files');
    fireEvent.doubleClick(screen.getByText('main.asm'));
    expect(opened).toEqual([{ path: '/p/Sources/main.asm' }]);
    fireEvent.click(screen.getByTestId('touch-main.asm'));
    fireEvent.click(screen.getByTestId('debug-main.asm'));
    await waitFor(() => expect(m.calls('project', 'setDebugFlag')).toEqual([['main.asm', false]]));
    expect(m.calls('project', 'setTouched')).toEqual([['main.asm', false]]);
    off();
  });

  it('context menu: Remove asks and removes; Create Group prompts and adds into the group', async () => {
    const { m } = setup();
    await screen.findByTestId('project-files');
    fireEvent.contextMenu(screen.getByText('derivative.inc'));
    const menu = screen.getByTestId('context-menu');
    const ids = [...menu.querySelectorAll('[data-menu-id]')].map((e) => e.getAttribute('data-menu-id'));
    for (const id of ['pw.open', 'pw.compile', 'pw.remove', 'pw.addFiles', 'pw.createGroup', 'pw.checkSyntax']) expect(ids).toContain(id);
    fireEvent.click(menu.querySelector('[data-menu-id="pw.remove"]')!);
    expect(screen.getByTestId('pw-confirm')).toHaveTextContent('Remove "derivative.inc" from the project?');
    fireEvent.click(screen.getByTestId('pw-confirm-ok'));
    expect(m.calls('project', 'removeFile')).toEqual([['derivative.inc']]);

    fireEvent.contextMenu(screen.getByText('Libraries'));
    fireEvent.click(screen.getByTestId('context-menu').querySelector('[data-menu-id="pw.createGroup"]')!);
    const input = within(screen.getByTestId('pw-prompt')).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Extra' } });
    fireEvent.click(screen.getByTestId('pw-prompt-ok'));
    expect(m.calls('project', 'addGroup')).toEqual([[['Libraries', 'Extra']]]);
  });

  it('context menu Compile compiles that file', async () => {
    const { actions } = setup();
    await screen.findByTestId('project-files');
    fireEvent.contextMenu(screen.getByText('main.asm'));
    fireEvent.click(screen.getByTestId('context-menu').querySelector('[data-menu-id="pw.compile"]')!);
    expect(actions.compile).toHaveBeenCalledWith(['main.asm']);
  });

  it('dragging a file onto a group moves it there', async () => {
    const { m } = setup();
    await screen.findByTestId('project-files');
    fireEvent.dragStart(row('main.asm'));
    fireEvent.dragOver(row('Libraries'));
    fireEvent.drop(row('Libraries'));
    expect(m.calls('project', 'moveFile')).toEqual([['main.asm', ['Libraries']]]);
  });

  it('Link Order tab: drag reorders and saves the new order', async () => {
    const { m } = setup();
    await screen.findByTestId('project-files');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Link Order' }));
    const lo = screen.getByTestId('project-link-order');
    const rows = within(lo).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.firstChild?.textContent)).toEqual(['derivative.inc', 'mc9s12xdp512.inc', 'burner.bbl', 'Project.prm', 'Project.map', 'ME305LibV4.0.lib', 'main.asm']);
    // drag main.asm (last row) onto the first row: jsdom has no DragEvent/clientY and zero-size rects, so the drop
    // lands in the lower half -> after derivative.inc
    fireEvent.dragStart(rows[6]);
    fireEvent.dragOver(rows[0]);
    expect(rows[0]).toHaveClass('drop-after');
    fireEvent.drop(rows[0]);
    expect(m.calls('project', 'setLinkOrder')).toEqual([['Standard', ['derivative.inc', 'main.asm', 'mc9s12xdp512.inc', 'burner.bbl', 'Project.prm', 'Project.map', 'ME305LibV4.0.lib']]]);
    expect(rows[0]).not.toHaveClass('drop-after');
  });

  it('Link Order context menu Move Down', async () => {
    const { m } = setup();
    await screen.findByTestId('project-files');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Link Order' }));
    fireEvent.contextMenu(within(screen.getByTestId('project-link-order')).getByText('burner.bbl'));
    fireEvent.click(screen.getByTestId('context-menu').querySelector('[data-menu-id="lo.down"]')!);
    expect(m.calls('project', 'setLinkOrder')).toEqual([['Standard', ['derivative.inc', 'mc9s12xdp512.inc', 'Project.prm', 'burner.bbl', 'Project.map', 'ME305LibV4.0.lib', 'main.asm']]]);
  });

  it('Targets tab lists targets; double-click sets the default target; toolbar buttons run the actions', async () => {
    const info = lab3Info();
    info.targets = [info.targets[0], { ...info.targets[0], name: 'Simulator' }];
    const { actions } = setup(info);
    await screen.findByTestId('project-files');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Targets' }));
    const tl = screen.getByTestId('project-targets');
    expect(within(tl).getByText('Standard')).toBeInTheDocument();
    fireEvent.doubleClick(within(tl).getByText('Simulator'));
    expect(actions.setTarget).toHaveBeenCalledWith('Simulator');
    fireEvent.click(screen.getByTestId('pw-make'));
    fireEvent.click(screen.getByTestId('pw-debug'));
    expect(actions.make).toHaveBeenCalled();
    expect(actions.debug).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('pw-connection'));
    fireEvent.click(within(screen.getByTestId('context-menu')).getByText('Full Chip Simulation'));
    expect(actions.setConnection).toHaveBeenCalledWith('Full_Chip_Simulation');
  });

  it('re-renders on project.changed (new group appears expanded)', async () => {
    const { m } = setup();
    await screen.findByTestId('project-files');
    const next = lab3Info();
    next.groups = [...next.groups, { type: 'group', name: 'Docs', children: [{ type: 'file', name: 'notes.txt' }] }];
    next.files = [...next.files, { name: 'notes.txt', kind: 'txt', tool: '', ignoredByMake: true, debug: false, targets: ['Standard'], origin: 'sidecar', path: '/p/notes.txt' }];
    act(() => m.emit('project', 'changed', next));
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
  });
});
