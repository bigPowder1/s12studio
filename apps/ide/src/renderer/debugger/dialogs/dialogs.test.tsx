import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BreakpointInfo, WatchpointInfo } from '../../../shared/api';
import { S12Provider } from '../../common/s12';
import { createMockS12, type MockOverrides } from '../../common/testing/mockS12';
import { AddressDialog } from './AddressDialog';
import { ControlpointsDialog, commonPatch } from './ControlpointsDialog';
import { FillMemoryDialog } from './FillMemoryDialog';
import { markpoints } from './markpoints';

const BP: BreakpointInfo = { id: 3, address: 0xc010, temporary: false, enabled: true, hits: 0, label: 'main+16' };
const WP: WatchpointInfo = { id: 5, start: 0x2500, end: 0x2501, kind: 'write', space: 'local', enabled: true, hits: 0 };
const resolve = async (e: string) => (e === 'RX_FLAG' ? 0x2500 : e === 'main' ? 0xc000 : null);

function renderCp(over: MockOverrides['debug'] = {}, tab?: 'breakpoints' | 'watchpoints' | 'markpoints') {
  let closed = 0;
  const m = createMockS12({
    debug: {
      session: async () => ({ projectDir: '/p', connection: 'sim', connectionMenu: 'HCS12X FCS', derivative: 'MC9S12XDP512', title: 't' }),
      breakpoints: async () => [BP],
      watchpoints: async () => [WP],
      resolve,
      updateBreakpoint: async (id: number, p: object) => ({ ...BP, ...p, id }),
      setBreakpoint: async (s: object) => ({ ...BP, ...s, id: 9 }),
      updateWatchpoint: async (id: number, p: object) => ({ ...WP, ...p, id }),
      setWatchpoint: async (s: object) => ({ ...WP, ...s, id: 11 }),
      ...over,
    },
  });
  render(
    <S12Provider api={m.api}>
      <ControlpointsDialog open initialTab={tab} onClose={() => closed++} />
    </S12Provider>,
  );
  return { m, closed: () => closed };
}

describe('Controlpoints Configuration', () => {
  it('validates the shared groups', () => {
    const base = { disabled: false, condition: '', conditionDisabled: false, command: '', commandDisabled: false, commandContinue: false, current: '', interval: '' };
    expect(commonPatch({ ...base, command: 'G' })).toMatch(/not allowed/);
    expect(commonPatch({ ...base, current: '0' })).toMatch(/Counter/);
    expect(commonPatch({ ...base, current: '3', interval: '5' })).toMatchObject({ counter: { current: 3, interval: 5 } });
    expect(commonPatch({ ...base, command: 'CF hook.cmd' })).toMatchObject({ command: 'CF hook.cmd', enabled: true });
  });

  it('lists breakpoints; Update sends condition, counter, command and flags', async () => {
    const { m } = renderCp();
    const list = await screen.findByTestId('cp-bp-list');
    await waitFor(() => expect(within(list).getByText('0xC010')).toBeInTheDocument());
    fireEvent.mouseDown(within(list).getByText('0xC010'));
    await waitFor(() => expect((screen.getAllByLabelText('Address')[0] as HTMLInputElement).value).toBe('0xC010'));
    fireEvent.change(screen.getAllByLabelText('Condition')[0], { target: { value: 'RX_FLAG==1' } });
    fireEvent.change(screen.getAllByLabelText('Current')[0], { target: { value: '3' } });
    fireEvent.change(screen.getAllByLabelText('Interval')[0], { target: { value: '4' } });
    fireEvent.change(screen.getAllByLabelText('Command')[0], { target: { value: 'Memory < SMEM 0x2500,16' } });
    fireEvent.click(screen.getByText('Temporary').querySelector('input') ?? screen.getByLabelText(/Temporary/));
    fireEvent.click(screen.getByTestId('cp-bp-update'));
    await waitFor(() =>
      expect(m.calls('debug', 'updateBreakpoint')).toEqual([
        [3, { temporary: true, enabled: true, condition: 'RX_FLAG==1', conditionEnabled: true, command: 'Memory < SMEM 0x2500,16', commandEnabled: true, commandContinue: false, counter: { current: 3, interval: 4 } }],
      ]),
    );
  });

  it('enables/disables from the list check box and deletes the selection', async () => {
    const { m } = renderCp();
    const list = await screen.findByTestId('cp-bp-list');
    await waitFor(() => expect(within(list).getByLabelText('Enable 3')).toBeInTheDocument());
    fireEvent.click(within(list).getByLabelText('Enable 3'));
    await waitFor(() => expect(m.calls('debug', 'updateBreakpoint')).toEqual([[3, { enabled: false }]]));
    fireEvent.mouseDown(within(list).getByText('0xC010'));
    fireEvent.click(screen.getByTestId('cp-bp-delete'));
    await waitFor(() => expect(m.calls('debug', 'removeBreakpoint')).toEqual([[3]]));
  });

  it('adds a breakpoint at a symbol and rejects G as a command', async () => {
    const { m } = renderCp();
    await screen.findByTestId('cp-bp-list');
    fireEvent.change(screen.getAllByLabelText('Address')[0], { target: { value: 'main' } });
    fireEvent.change(screen.getAllByLabelText('Command')[0], { target: { value: 'g' } });
    fireEvent.click(screen.getByTestId('cp-bp-add'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not allowed/);
    fireEvent.change(screen.getAllByLabelText('Command')[0], { target: { value: '' } });
    fireEvent.click(screen.getByTestId('cp-bp-add'));
    await waitFor(() => expect(m.calls('debug', 'setBreakpoint')).toHaveLength(1));
    expect(m.calls('debug', 'setBreakpoint')[0][0]).toMatchObject({ address: 0xc000, temporary: false, enabled: true });
  });

  it('watchpoints tab: edit type and range, add one by symbol', async () => {
    const { m } = renderCp({}, 'watchpoints');
    const list = await screen.findByTestId('cp-wp-list');
    await waitFor(() => expect(within(list).getByText('0x2500..0x2501')).toBeInTheDocument());
    fireEvent.mouseDown(within(list).getByText('0x2500..0x2501'));
    await waitFor(() => expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('0x2500'));
    fireEvent.click(screen.getByLabelText(/^\s*Read\s*$/));
    fireEvent.click(screen.getByTestId('cp-wp-update'));
    await waitFor(() => expect(m.calls('debug', 'updateWatchpoint')[0]).toEqual([5, expect.objectContaining({ start: 0x2500, end: 0x2501, kind: 'read' })]));
    await act(async () => m.emit('debug', 'watchpoints', [{ ...WP, kind: 'read' }]));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: 'RX_FLAG' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('cp-wp-add'));
    await waitFor(() => expect(m.calls('debug', 'setWatchpoint')[0][0]).toMatchObject({ start: 0x2500, end: 0x2500, kind: 'read', space: 'local' }));
  });

  it('OK applies pending edits then closes; markpoints are listed', async () => {
    markpoints.clear();
    markpoints.add({ name: 'buffer', address: 0x2510, kind: 'memory' });
    const { m, closed } = renderCp();
    const list = await screen.findByTestId('cp-bp-list');
    await waitFor(() => expect(within(list).getByText('0xC010')).toBeInTheDocument());
    fireEvent.mouseDown(within(list).getByText('0xC010'));
    await waitFor(() => expect((screen.getAllByLabelText('Address')[0] as HTMLInputElement).value).toBe('0xC010'));
    fireEvent.click(screen.getAllByText('Disable', { selector: 'label' })[0]);
    fireEvent.click(screen.getByTestId('cp-ok'));
    await waitFor(() => expect(closed()).toBe(1));
    expect(m.calls('debug', 'updateBreakpoint')[0][1]).toMatchObject({ enabled: false });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Markpoints' }));
    expect(within(screen.getByTestId('cp-mp-list')).getByText('buffer')).toBeInTheDocument();
  });
});

describe('Fill Memory / Address dialogs', () => {
  it('fills a hex range', async () => {
    const m = createMockS12({ debug: { resolve } });
    let filled = 0;
    render(
      <S12Provider api={m.api}>
        <FillMemoryDialog open from={0x1000} to={0x100f} onClose={() => undefined} onFilled={() => filled++} />
      </S12Provider>,
    );
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'AA' } });
    fireEvent.click(screen.getByTestId('fill-ok'));
    await waitFor(() => expect(m.calls('debug', 'fillMemory')).toEqual([[0x1000, 0x100f, 0xaa, 'local']]));
    expect(filled).toBe(1);
  });

  it('rejects a reversed range and a non-byte value', async () => {
    const m = createMockS12({ debug: { resolve } });
    render(
      <S12Provider api={m.api}>
        <FillMemoryDialog open from={0x2000} to={0x1000} onClose={() => undefined} />
      </S12Provider>,
    );
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('fill-ok'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/To/);
    fireEvent.change(screen.getByLabelText('To Address'), { target: { value: 'RX_FLAG' } });
    fireEvent.change(screen.getByLabelText('From Address'), { target: { value: '2400' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '1FF' } });
    fireEvent.click(screen.getByTestId('fill-ok'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/byte/));
    expect(m.calls('debug', 'fillMemory')).toEqual([]);
  });

  it('Address... resolves symbols', async () => {
    const m = createMockS12({ debug: { resolve } });
    const got: number[] = [];
    render(
      <S12Provider api={m.api}>
        <AddressDialog open onOk={(a) => got.push(a)} onClose={() => undefined} />
      </S12Provider>,
    );
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('address-ok'));
    expect(await screen.findByRole('alert')).toHaveTextContent('nope');
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'RX_FLAG' } });
    await act(async () => fireEvent.click(screen.getByTestId('address-ok')));
    await waitFor(() => expect(got).toEqual([0x2500]));
  });
});
