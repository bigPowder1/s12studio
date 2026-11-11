import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockS12 } from '../../common/testing/mockS12';
import { S12Provider, useS12 } from '../../common/s12';
import { StatusBar } from '../../common/controls';
import { NewProjectDialog, noCourseTemplateText, TEMPLATES } from '../dialogs/NewProjectDialog';
import { updatePane, useUpdateNotice } from './update-notice';
import { setEditorArea, type EditorAreaHandle } from '../editor/bridge';

function Bar() {
  const s12 = useS12();
  const p = updatePane(useUpdateNotice(), s12);
  return <StatusBar testId="bar" panes={[{ id: 'status', content: 'Ready' }, ...(p ? [p] : [])]} />;
}

describe('update notice in the IDE status bar', () => {
  it('downloaded: "Restart to update" calls app.installUpdate', async () => {
    const m = createMockS12();
    render(
      <S12Provider api={m.api}>
        <Bar />
      </S12Provider>,
    );
    expect(screen.queryByTestId('ide-update-notice')).toBeNull();
    act(() => m.emit('app', 'update', { state: 'downloaded', version: '0.2.0' }));
    const n = await screen.findByTestId('ide-update-notice');
    expect(n.textContent).toBe('S12 Studio 0.2.0 downloaded — Restart to update');
    fireEvent.click(n);
    await waitFor(() => expect(m.calls('app', 'installUpdate')).toHaveLength(1));
  });

  it('available (macOS): "Download" opens the release page', async () => {
    const m = createMockS12();
    render(
      <S12Provider api={m.api}>
        <Bar />
      </S12Provider>,
    );
    act(() => m.emit('app', 'update', { state: 'available', version: '0.3.0', url: 'https://github.com/someone/s12studio/releases/tag/v0.3.0' }));
    fireEvent.click(await screen.findByTestId('ide-update-notice'));
    await waitFor(() => expect(m.calls('app', 'openExternal')).toEqual([['https://github.com/someone/s12studio/releases/tag/v0.3.0']]));
    expect(m.calls('app', 'installUpdate')).toHaveLength(0);
  });
});

describe('update notice: restart and window reloads', () => {
  it('"Restart to update" asks "save changes?" first; Cancel does not restart', async () => {
    let ok = false;
    const closeAll = vi.fn(async () => ok);
    setEditorArea({ closeAll } as unknown as EditorAreaHandle);
    try {
      const m = createMockS12();
      render(
        <S12Provider api={m.api}>
          <Bar />
        </S12Provider>,
      );
      act(() => m.emit('app', 'update', { state: 'downloaded', version: '0.2.0' }));
      const n = await screen.findByTestId('ide-update-notice');
      fireEvent.click(n);
      await waitFor(() => expect(closeAll).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 10));
      expect(m.calls('app', 'installUpdate')).toHaveLength(0);
      ok = true;
      fireEvent.click(n);
      await waitFor(() => expect(m.calls('app', 'installUpdate')).toHaveLength(1));
    } finally {
      setEditorArea(null);
    }
  });

  it('a window that loads after the notice was sent gets it from app.info()', async () => {
    const m = createMockS12({
      app: { info: async () => ({ name: 'S12 Studio', version: '0.1.0', platform: 'win32', electron: '0', windowKind: 'ide', e2e: false, updateNotice: { state: 'downloaded', version: '0.2.0' } }) },
    });
    render(
      <S12Provider api={m.api}>
        <Bar />
      </S12Provider>,
    );
    expect((await screen.findByTestId('ide-update-notice')).textContent).toBe('S12 Studio 0.2.0 downloaded — Restart to update');
  });
});

describe('New Project without a blank_project in the templates folder', () => {
  it('selects the generic stationery and points ME 3305 students to File > Open', async () => {
    const tdir = '/home/u/.config/S12 Studio/templates';
    const m = createMockS12({
      app: { info: async () => ({ name: 'S12 Studio', version: '0', platform: 'linux', electron: '0', windowKind: 'ide', e2e: false, courseTemplate: false, userTemplatesDir: tdir }) },
    });
    render(
      <S12Provider api={m.api}>
        <NewProjectDialog open onClose={() => undefined} />
      </S12Provider>,
    );
    fireEvent.click(screen.getByTestId('np-next'));
    await waitFor(() => expect(screen.getByTestId('np-template-hint').getAttribute('data-course')).toBe('false'));
    expect(screen.getByTestId('np-no-course').textContent).toBe(
      `ME 3305 labs: use File > Open... on a copy of the blank_project folder from your course. (To list it here, copy that folder into ${tdir}.)`,
    );
    expect(screen.getByTestId('np-template-hint').textContent).toContain('A minimal relocatable-assembly project');
    expect(screen.getByText(/ME 3305 blank_project \(from your course\) - not found/)).toBeTruthy();
    expect(TEMPLATES.map((t) => t.description).join(' ')).not.toMatch(/P&E|Cyclone/);
    fireEvent.mouseDown(screen.getByText(/ME 3305 blank_project/));
    // the greyed row stays unselected; the hint above already explains (no second copy of the message)
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByText(/use File > Open\.\.\. on a copy/)).toHaveLength(1);
    fireEvent.change(screen.getByTestId('np-dir'), { target: { value: '/tmp/x' } });
    fireEvent.click(screen.getByTestId('np-finish'));
    await waitFor(() => expect(m.calls('project', 'newProject')).toEqual([[{ template: 'minimal', dir: '/tmp/x', name: 'Project' }]]));
    expect(noCourseTemplateText()).toContain('<user data folder>/templates');
  });

  it('keeps the ME 3305 blank_project as the default when one is in the templates folder', async () => {
    const m = createMockS12({ app: { info: async () => ({ name: 'S12 Studio', version: '0', platform: 'linux', electron: '0', windowKind: 'ide', e2e: false, courseTemplate: true }) } });
    render(
      <S12Provider api={m.api}>
        <NewProjectDialog open onClose={() => undefined} />
      </S12Provider>,
    );
    fireEvent.click(screen.getByTestId('np-next'));
    await waitFor(() => expect(screen.getByTestId('np-template-hint').getAttribute('data-course')).toBe('true'));
    fireEvent.change(screen.getByTestId('np-dir'), { target: { value: '/tmp/x' } });
    fireEvent.click(screen.getByTestId('np-finish'));
    await waitFor(() => expect(m.calls('project', 'newProject')).toEqual([[{ template: 'blank_project', dir: '/tmp/x', name: 'Project' }]]));
    expect(screen.queryByText(/not found/)).toBeNull();
    expect(screen.queryByTestId('np-no-course')).toBeNull();
  });
});
