import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockS12 } from '../../common/testing/mockS12';
import { S12Provider } from '../../common/s12';
import { runIdeCommand } from '../commands';
import { ZIP_PROJECT_MESSAGE } from '../../../shared/zip-path';
import { StartupDialog } from './MiscDialogs';

const DEMO = '/home/st/Documents/S12 Studio/Demo (blinky)/blinky.s12studio.json';

function setup(overrides: Parameters<typeof createMockS12>[0] = {}) {
  const onClose = vi.fn();
  const m = createMockS12({
    settings: { get: async () => ({ showStartupDialog: true, recentProjects: [] }) as never },
    app: { prepareDemo: async () => DEMO, ...overrides.app },
    files: { openDialog: async () => ['/home/st/blank_project/blank_project.mcp'], ...overrides.files },
    project: { open: async () => ({}) as never, ...overrides.project },
  });
  render(
    <S12Provider api={m.api}>
      <StartupDialog open onClose={onClose} />
    </S12Provider>,
  );
  return { m, onClose };
}

describe('Startup dialog', () => {
  it('Open Project... runs File > Open and opens the chosen .mcp', async () => {
    const { m, onClose } = setup();
    fireEvent.click(screen.getByTestId('startup-open'));
    expect(onClose).toHaveBeenCalled();
    await waitFor(() => expect(m.calls('project', 'open')).toEqual([['/home/st/blank_project/blank_project.mcp']]));
    expect(m.calls('files', 'openDialog')[0][0]).toMatchObject({ title: 'Open' });
  });

  it('Load Example Project is enabled and opens the writable copy of the demo', async () => {
    const { m } = setup();
    const b = screen.getByTestId('startup-example');
    expect(b).toBeEnabled();
    fireEvent.click(b);
    await waitFor(() => expect(m.calls('project', 'open')).toEqual([[DEMO]]));
    expect(m.calls('app', 'prepareDemo')).toHaveLength(1);
    expect(m.calls('app', 'showMessage')).toEqual([]);
  });

  it('Help > Open Demo Project opens the demo too', async () => {
    const { m } = setup();
    runIdeCommand('help.openDemo');
    await waitFor(() => expect(m.calls('project', 'open')).toEqual([[DEMO]]));
  });

  it('a missing demo is reported in a message box', async () => {
    const { m } = setup({ app: { prepareDemo: async () => Promise.reject(new Error('[not-found] The demo project is not installed (/x)')) } });
    fireEvent.click(screen.getByTestId('startup-example'));
    await waitFor(() => expect(m.calls('app', 'showMessage')).toHaveLength(1));
    expect(m.calls('app', 'showMessage')[0][0]).toMatchObject({ type: 'error', detail: 'The demo project is not installed (/x)' });
    expect(m.calls('project', 'open')).toEqual([]);
  });

  it('a project picked inside a zip is refused with the "extract first" message', async () => {
    const zipped = 'C:\\Users\\st\\AppData\\Local\\Temp\\Temp1_Lab3.zip\\Lab3\\Lab3.mcp';
    const { m } = setup({ files: { openDialog: async () => [zipped] } });
    fireEvent.click(screen.getByTestId('startup-open'));
    await waitFor(() => expect(m.calls('app', 'showMessage')).toEqual([[{ type: 'error', message: ZIP_PROJECT_MESSAGE, detail: zipped }]]));
    expect(m.calls('project', 'open')).toEqual([]);
  });
});
