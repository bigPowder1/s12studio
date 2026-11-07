import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { S12Provider } from '../../../common/s12';
import { createMockS12 } from '../../../common/testing/mockS12';
import type { MenuCommand, MenuEntry } from '../../../common/menu/model';
import { ComponentHostContext, type ComponentHost } from '../contract';
import { CommandComponent, pushHistory } from './CommandComponent';
import { outputBufferFor } from './outputBuffer';

function setup(attrs: { name: string; value: string }[] = []) {
  const m = createMockS12({ debug: { exec: async () => true } });
  // output emitted before the component mounts (STARTUP / POSTLOAD hooks) must still show
  outputBufferFor(m.api);
  m.emit('debug', 'output', [{ text: 'Startup command file correctly executed.', kind: 'normal' }]);
  render(
    <S12Provider api={m.api}>
      <CommandComponent instanceId="Command" title="Command" instance={1} attributes={attrs} active />
    </S12Provider>,
  );
  return m;
}

describe('CommandComponent', () => {
  it('shows output buffered before mounting and colours echo / normal / error / warning', async () => {
    const m = setup();
    expect(screen.getByText('Startup command file correctly executed.')).toBeInTheDocument();
    await act(async () =>
      m.emit('debug', 'output', [
        { text: 'rd PC', kind: 'echo' },
        { text: 'PC: C000', kind: 'normal' },
        { text: 'Error: unknown command', kind: 'error' },
        { text: 'FCS Warning (ID 12): reading from unimplemented register', kind: 'warning' },
      ]),
    );
    expect(screen.getByText('rd PC')).toHaveStyle({ color: 'var(--cw-cmd-echo)' });
    expect(screen.getByText('rd PC')).toHaveClass('cmd-echo');
    expect(screen.getByText('PC: C000')).toHaveClass('cmd-normal');
    expect(screen.getByText('Error: unknown command')).toHaveClass('cmd-error');
    expect(screen.getByText('Error: unknown command')).toHaveStyle({ color: 'var(--cw-cmd-error)' });
    expect(screen.getByText(/FCS Warning/)).toHaveClass('cmd-warning');
    await act(async () => m.emit('debug', 'clearOutput', {}));
    expect(screen.queryByText('PC: C000')).toBeNull();
  });

  it('executes at in> and recalls history with Up/Down/F3, Esc clears', async () => {
    const m = setup();
    const input = screen.getByLabelText('Command') as HTMLInputElement;
    for (const c of ['bs 0xC000', 'g', 'rd *']) {
      fireEvent.change(input, { target: { value: c } });
      fireEvent.keyDown(input, { key: 'Enter' });
    }
    await waitFor(() => expect(m.calls('debug', 'exec')).toEqual([['bs 0xC000'], ['g'], ['rd *']]));
    expect(input.value).toBe('');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('rd *');
    fireEvent.keyDown(input, { key: 'F3' });
    expect(input.value).toBe('g');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('bs 0xC000');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.value).toBe('g');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
  });

  it('keeps 10 unique history entries, newest first', () => {
    let h: string[] = [];
    for (let i = 0; i < 12; i++) h = pushHistory(h, `t ${i}`);
    h = pushHistory(h, 't 5');
    expect(h).toHaveLength(10);
    expect(h[0]).toBe('t 5');
    expect(h.filter((x) => x === 't 5')).toHaveLength(1);
  });

  it('honours CACHESIZE', async () => {
    const m = setup([{ name: 'CACHESIZE', value: '20' }]);
    await act(async () => m.emit('debug', 'output', Array.from({ length: 50 }, (_, i) => ({ text: `line ${i}`, kind: 'normal' as const }))));
    expect(document.querySelectorAll('.cmd-line')).toHaveLength(20);
    expect(screen.getByText('line 49')).toBeInTheDocument();
    expect(screen.queryByText('line 29')).toBeNull();
  });

  it('clicking and typing in the Cache Size dialog stays in the dialog (focus not stolen by in>)', async () => {
    const user = userEvent.setup();
    const m = createMockS12({ debug: { exec: async () => true } });
    let menu: MenuEntry[] = [];
    const host: ComponentHost = { setMenu: (items) => void (items && (menu = items)), setHeadline: () => undefined, open: () => undefined, activate: () => undefined, onUiCommand: () => () => undefined };
    render(
      <S12Provider api={m.api}>
        <ComponentHostContext.Provider value={host}>
          <CommandComponent instanceId="Command" title="Command" instance={1} attributes={[]} active />
        </ComponentHostContext.Provider>
      </S12Provider>,
    );
    const item = menu.find((e): e is MenuCommand => e.kind !== 'separator' && e.id === 'command.cacheSize')!;
    await act(async () => item.onSelect!());
    const field = screen.getByLabelText('Number of lines:') as HTMLInputElement;
    await user.click(field);
    expect(document.activeElement).toBe(field);
    await user.clear(field);
    await user.type(field, '77');
    expect(field.value).toBe('77');
    expect((screen.getByLabelText('Command') as HTMLInputElement).value).toBe('');
  });
  it('says so when Make rebuilt the loaded application (debug.applicationRebuilt)', async () => {
    const m = setup();
    await act(async () => m.emit('debug', 'applicationRebuilt', { absPath: '/home/u/Lab3/bin/Project.abs', target: 'Standard' }));
    const line = screen.getByText(/Project\.abs was rebuilt\. Project > Debug \(F5\) in the IDE/);
    expect(line).toHaveClass('cmd-warning');
  });
});
