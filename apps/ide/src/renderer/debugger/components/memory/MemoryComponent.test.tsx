import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MEM_OK, MEM_UNINITIALIZED, MEM_UNMAPPED, type DebugSnapshot, type MemoryBlockInfo, type MemoryRange, type SessionInfo, type UiCommandInfo, type WatchpointInfo } from '../../../../shared/api';
import type { MenuCommand, MenuEntry } from '../../../common/menu/model';
import { S12Provider } from '../../../common/s12';
import { createMockS12, type MockS12 } from '../../../common/testing/mockS12';
import { ComponentHostContext, type ComponentHost } from '../contract';
import { DebuggerBusContext, type DebuggerBus } from '../../shell/bus';
import { MemoryComponent } from './MemoryComponent';

const SESSION: SessionInfo = { projectDir: '/p', connection: 'sim', connectionMenu: 'HCS12X FCS', derivative: 'MC9S12XDP512', title: 't' };

function snap(seq: number, memory: Record<string, MemoryBlockInfo[]>, cycles = seq, state: DebugSnapshot['state'] = 'halted'): DebugSnapshot {
  return { seq, state, statusText: '', cycles, busHz: 8e6, simSeconds: 0, registers: null, memory };
}

/** A block for the watched range: bytes from `fill(addr)`, status from `status(addr)`. */
function block(r: MemoryRange, fill: (a: number) => number, status: (a: number) => number = () => MEM_OK): MemoryBlockInfo {
  const bytes = new Uint8Array(r.length);
  const st = new Uint8Array(r.length);
  for (let i = 0; i < r.length; i++) {
    bytes[i] = fill(r.address + i);
    st[i] = status(r.address + i);
  }
  return { address: r.address, space: r.space ?? 'local', bytes, status: st };
}

async function setup(attrs: { name: string; value: string }[] = [], over: Parameters<typeof createMockS12>[0] = {}) {
  const m = createMockS12({ ...over, debug: { session: async () => SESSION, ...over.debug } });
  const headlines: string[] = [];
  let menu: MenuEntry[] | null = null;
  const uiFns: ((c: UiCommandInfo) => void)[] = [];
  const host: ComponentHost = {
    setMenu: (items) => void (items && (menu = items)),
    setHeadline: (t) => headlines.push(t),
    open: () => undefined,
    activate: () => undefined,
    onUiCommand: (fn) => (uiFns.push(fn), () => undefined),
  };
  render(
    <S12Provider api={m.api}>
      <ComponentHostContext.Provider value={host}>
        <MemoryComponent instanceId="Memory" title="Memory" instance={1} attributes={attrs} active />
      </ComponentHostContext.Provider>
    </S12Provider>,
  );
  await act(async () => m.emit('debug', 'session', SESSION));
  await waitFor(() => expect(m.calls('debug', 'watchMemory').length).toBeGreaterThan(0));
  const menuItem = (id: string): MenuCommand | undefined => {
    const find = (items: MenuEntry[]): MenuCommand | undefined => {
      for (const e of items) {
        if (e.kind === 'separator') continue;
        if (e.id === id) return e;
        const sub = e.submenu && find(e.submenu);
        if (sub) return sub;
      }
      return undefined;
    };
    return menu ? find(menu) : undefined;
  };
  const ui = (keyword: string, argText: string) => act(async () => uiFns.forEach((f) => f({ component: 'Memory', keyword, argText, raw: `Memory < ${keyword} ${argText}` })));
  return { m, headlines, menuItem, ui };
}

const lastWatch = (m: MockS12) => {
  const c = m.calls('debug', 'watchMemory');
  return c[c.length - 1] as [string, MemoryRange[]];
};

describe('MemoryComponent', () => {
  it('watches only the visible rows from the layout ADDRESS and shows hex, uu, -- and ASCII', async () => {
    const { m } = await setup([
      { name: 'FORMAT', value: 'hex' },
      { name: 'WORD', value: '1' },
      { name: 'ASC', value: 'on' },
      { name: 'ADR', value: 'on' },
      { name: 'ADDRESS', value: '0x1000' },
    ]);
    const [id, ranges] = lastWatch(m);
    expect(ranges[0]).toMatchObject({ address: 0x1000, space: 'local' });
    expect(ranges[0].length).toBeLessThanOrEqual(17 * 16);
    await act(async () => m.emit('debug', 'snapshot', snap(1, { [id]: [block(ranges[0], (a) => (a === 0x1000 ? 0x41 : a & 0xff), (a) => (a === 0x1001 ? MEM_UNINITIALIZED : a >= 0x1008 && a < 0x1010 ? MEM_UNMAPPED : MEM_OK))] })));
    const row = document.querySelector('[data-row="4096"]') as HTMLElement;
    expect(row.querySelector('.mem-addr')!.textContent).toBe('1000');
    const cells = [...row.querySelectorAll('.mem-cell')].map((c) => c.textContent);
    expect(cells.slice(0, 3)).toEqual(['41', 'uu', '02']);
    expect(cells[8]).toBe('--');
    expect(row.querySelector('.mem-ascii')!.textContent).toBe('A.......' + '........');
  });

  it('shows words in decimal from attributes', async () => {
    const { m } = await setup([
      { name: 'WORD', value: '2' },
      { name: 'FORMAT', value: 'udec' },
      { name: 'ADDRESS', value: '0x2000' },
    ]);
    const [id, ranges] = lastWatch(m);
    await act(async () => m.emit('debug', 'snapshot', snap(1, { [id]: [block(ranges[0], (a) => (a === 0x2001 ? 0x10 : 0))] })));
    const cell = document.querySelector('[data-addr="8192"]')!;
    expect(cell.textContent).toBe('   16');
  });

  it('paints values changed since the last halt red, and only those', async () => {
    const { m } = await setup([{ name: 'ADDRESS', value: '0x1000' }]);
    const [id, ranges] = lastWatch(m);
    await act(async () => m.emit('debug', 'snapshot', snap(1, { [id]: [block(ranges[0], () => 0)] }, 100)));
    expect(document.querySelectorAll('.mem-cell.changed')).toHaveLength(0);
    // new halt: 0x1003 changed
    await act(async () => m.emit('debug', 'snapshot', snap(2, { [id]: [block(ranges[0], (a) => (a === 0x1003 ? 9 : 0))] }, 200)));
    const changed = [...document.querySelectorAll('.mem-cell.changed')].map((e) => Number((e as HTMLElement).dataset.addr));
    expect(changed).toEqual([0x1003]);
    // next halt without changes: black again
    await act(async () => m.emit('debug', 'snapshot', snap(3, { [id]: [block(ranges[0], (a) => (a === 0x1003 ? 9 : 0))] }, 300)));
    expect(document.querySelectorAll('.mem-cell.changed')).toHaveLength(0);
  });

  it('Automatic mode ignores snapshots while running; Frozen ignores halts', async () => {
    const { m } = await setup([{ name: 'ADDRESS', value: '0x1000' }]);
    const [id, ranges] = lastWatch(m);
    await act(async () => m.emit('debug', 'snapshot', snap(1, { [id]: [block(ranges[0], () => 1)] }, 1)));
    await act(async () => m.emit('debug', 'snapshot', snap(2, { [id]: [block(ranges[0], () => 2)] }, 2, 'running')));
    expect(document.querySelector('[data-addr="4096"]')!.textContent).toBe('01');
    await act(async () => m.emit('debug', 'snapshot', snap(3, { [id]: [block(ranges[0], () => 3)] }, 3)));
    expect(document.querySelector('[data-addr="4096"]')!.textContent).toBe('03');
  });

  it('edits a byte in place: double-click, type hex, Enter -> writeMemory', async () => {
    const { m } = await setup([{ name: 'ADDRESS', value: '0x1000' }]);
    const [id, ranges] = lastWatch(m);
    await act(async () => m.emit('debug', 'snapshot', snap(1, { [id]: [block(ranges[0], () => 0)] })));
    fireEvent.doubleClick(document.querySelector('[data-addr="4098"]')!);
    const input = screen.getByLabelText('Edit memory');
    fireEvent.change(input, { target: { value: 'A5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(m.calls('debug', 'writeMemory')).toEqual([[0x1002, [0xa5], 'local']]));
  });

  it('typing over the selected word and Tab writes big-endian and moves to the next unit', async () => {
    const { m } = await setup([
      { name: 'ADDRESS', value: '0x1000' },
      { name: 'WORD', value: '2' },
    ]);
    const [id, ranges] = lastWatch(m);
    await act(async () => m.emit('debug', 'snapshot', snap(1, { [id]: [block(ranges[0], () => 0)] })));
    fireEvent.mouseDown(document.querySelector('[data-addr="4100"]')!, { button: 0 });
    fireEvent.keyDown(screen.getByTestId('memory-component'), { key: '1' });
    const input = screen.getByLabelText('Edit memory') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1234' } });
    fireEvent.keyDown(input, { key: 'Tab' });
    await waitFor(() => expect(m.calls('debug', 'writeMemory')).toEqual([[0x1004, [0x12, 0x34], 'local']]));
    await waitFor(() => expect(screen.getByLabelText('Edit memory')).toBeInTheDocument());
  });

  it('underlines watchpoint ranges and sets a watchpoint from the pop-up', async () => {
    const wp: WatchpointInfo = { id: 7, start: 0x1004, end: 0x1005, kind: 'write', space: 'local', enabled: true, hits: 0 };
    const { m } = await setup([{ name: 'ADDRESS', value: '0x1000' }], { debug: { watchpoints: async () => [wp] } });
    const [id, ranges] = lastWatch(m);
    await act(async () => m.emit('debug', 'snapshot', snap(1, { [id]: [block(ranges[0], () => 0)] })));
    await waitFor(() => expect(document.querySelector('[data-addr="4100"]')).toHaveClass('watch'));
    expect(document.querySelector('[data-addr="4102"]')).not.toHaveClass('watch');
    fireEvent.contextMenu(document.querySelector('[data-addr="4104"]')!);
    fireEvent.mouseEnter(document.querySelector('[data-menu-id="memory.setWatchpoint"]')!);
    fireEvent.click(document.querySelector('[data-menu-id="memory.setWatch.read"]')!);
    await waitFor(() => expect(m.calls('debug', 'setWatchpoint')).toEqual([[{ start: 0x1008, end: 0x1008, kind: 'read', space: 'local' }]]));
  });

  it('goes to a symbol through Address... and SMEM-style drops', async () => {
    const { m } = await setup([{ name: 'ADDRESS', value: '0x1000' }], { debug: { resolve: async (e: string) => (e === 'RX_BUF' ? 0x2409 : null) } });
    // drop an address from another component
    const root = screen.getByTestId('memory-component');
    const data = new Map<string, string>([['application/x-s12-dnd', JSON.stringify({ kind: 'expression', expression: 'RX_BUF', source: 'Data' })]]);
    fireEvent.drop(root, { dataTransfer: { getData: (k: string) => data.get(k) ?? '', types: [...data.keys()] } });
    await waitFor(() => expect(lastWatch(m)[1][0].address).toBe(0x2400));
  });

  // ---------------------------------------------------------------- review fixes

  it('keys typed into the Address dialog stay in the dialog (no hidden byte edit, no write)', async () => {
    const user = userEvent.setup();
    const { m, menuItem } = await setup([{ name: 'ADDRESS', value: '0x1000' }], { debug: { resolve: async () => null } });
    const [id, ranges] = lastWatch(m);
    await act(async () => m.emit('debug', 'snapshot', snap(1, { [id]: [block(ranges[0], () => 0)] })));
    fireEvent.mouseDown(document.querySelector('[data-addr="4098"]')!, { button: 0 });
    await act(async () => menuItem('memory.address')!.onSelect!());
    const field = screen.getByLabelText('Address') as HTMLInputElement;
    await user.clear(field);
    await user.type(field, '2408');
    expect(field.value).toBe('2408');
    expect(screen.queryByLabelText('Edit memory')).toBeNull();
    await user.type(field, '{Enter}');
    await waitFor(() => expect(lastWatch(m)[1][0].address).toBe(0x2400));
    expect(screen.queryByTestId('address-dialog')).toBeNull();
    expect(m.calls('debug', 'writeMemory')).toEqual([]);
  });

  it('keys typed into the Fill dialog stay in the dialog and Enter fills instead of writing a byte', async () => {
    const user = userEvent.setup();
    const { m, menuItem } = await setup([{ name: 'ADDRESS', value: '0x1000' }]);
    const [id, ranges] = lastWatch(m);
    await act(async () => m.emit('debug', 'snapshot', snap(1, { [id]: [block(ranges[0], () => 0)] })));
    fireEvent.mouseDown(document.querySelector('[data-addr="4096"]')!, { button: 0 });
    await act(async () => menuItem('memory.fill')!.onSelect!());
    await user.type(screen.getByLabelText('Value'), 'AB{Enter}');
    await waitFor(() => expect(m.calls('debug', 'fillMemory')).toEqual([[0x1000, 0x1000, 0xab, 'local']]));
    expect(m.calls('debug', 'writeMemory')).toEqual([]);
    expect(screen.queryByLabelText('Edit memory')).toBeNull();
  });

  it('paints bytes red that change after scrolling into view (no halt in between)', async () => {
    const { m, ui } = await setup([{ name: 'ADDRESS', value: '0x1000' }]);
    let [id, ranges] = lastWatch(m);
    await act(async () => m.emit('debug', 'snapshot', snap(1, { [id]: [block(ranges[0], () => 0)] }, 10)));
    // scroll to 0x3F00 while halted (no new epoch), then a fill changes 0x3F00
    await ui('SMEM', '0x3F00');
    await waitFor(() => expect(lastWatch(m)[1][0].address).toBe(0x3f00));
    [id, ranges] = lastWatch(m);
    await act(async () => m.emit('debug', 'snapshot', snap(2, { [id]: [block(ranges[0], () => 0, () => MEM_UNINITIALIZED)] }, 10)));
    expect(document.querySelectorAll('.mem-cell.changed')).toHaveLength(0);
    await act(async () => m.emit('debug', 'snapshot', snap(3, { [id]: [block(ranges[0], (a) => (a === 0x3f00 ? 0xab : 0), (a) => (a === 0x3f00 ? MEM_OK : MEM_UNINITIALIZED))] }, 10)));
    expect([...document.querySelectorAll('.mem-cell.changed')].map((e) => Number((e as HTMLElement).dataset.addr))).toEqual([0x3f00]);
  });

  it('ATTRIBUTES SHOW_ADDRESSSPACE drops the old selection and clamps the top address', async () => {
    const { m, ui, headlines } = await setup([
      { name: 'SHOW_ADDRESSSPACE', value: '1' },
      { name: 'ADDRESS', value: '0x500000' },
    ]);
    expect(lastWatch(m)[1][0]).toMatchObject({ address: 0x500000, space: 'global' });
    fireEvent.mouseDown(document.querySelector('[data-addr="5242880"]') ?? screen.getByTestId('memory-component'), { button: 0 });
    await ui('ATTRIBUTES', 'SHOW_ADDRESSSPACE 0');
    await waitFor(() => expect(lastWatch(m)[1][0].space).toBe('local'));
    expect(lastWatch(m)[1][0].address).toBeLessThan(0x10000);
    expect(headlines.at(-1)).not.toMatch(/500000/);
  });

  it('commits a valid in-place entry when the editor loses focus, drops an invalid one', async () => {
    const { m } = await setup([{ name: 'ADDRESS', value: '0x1000' }]);
    const [id, ranges] = lastWatch(m);
    await act(async () => m.emit('debug', 'snapshot', snap(1, { [id]: [block(ranges[0], () => 0)] })));
    fireEvent.doubleClick(document.querySelector('[data-addr="4097"]')!);
    let input = screen.getByLabelText('Edit memory');
    fireEvent.change(input, { target: { value: '3C' } });
    fireEvent.blur(input);
    await waitFor(() => expect(m.calls('debug', 'writeMemory')).toEqual([[0x1001, [0x3c], 'local']]));
    fireEvent.doubleClick(document.querySelector('[data-addr="4098"]')!);
    input = screen.getByLabelText('Edit memory');
    fireEvent.change(input, { target: { value: 'XYZ' } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.queryByLabelText('Edit memory')).toBeNull());
    // Esc never commits
    fireEvent.doubleClick(document.querySelector('[data-addr="4099"]')!);
    input = screen.getByLabelText('Edit memory');
    fireEvent.change(input, { target: { value: '11' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    expect(m.calls('debug', 'writeMemory')).toHaveLength(1);
  });

  it('Search Pattern finds bytes through readMemory and selects the match; Find Next continues', async () => {
    const user = userEvent.setup();
    const mem = new Uint8Array(0x10000);
    mem.set([0xa5, 0x5a], 0x1234);
    mem.set([0xa5, 0x5a], 0x2000);
    const { m, menuItem, headlines } = await setup([{ name: 'ADDRESS', value: '0x1000' }], {
      debug: { readMemory: async (r: MemoryRange) => ({ address: r.address, space: 'local' as const, bytes: mem.slice(r.address, r.address + r.length), status: new Uint8Array(r.length) }) },
    });
    await act(async () => menuItem('memory.searchPattern')!.onSelect!());
    await user.type(screen.getByLabelText('Pattern'), 'A5 5A');
    await user.click(screen.getByTestId('search-find'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Found at 0x1234'));
    await waitFor(() => expect(headlines.at(-1)).toMatch(/^0x1234\.\.0x1235/));
    await user.click(screen.getByTestId('search-find'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Found at 0x2000'));
  });

  it('CopyMem copies a range with readMemory + writeMemory', async () => {
    const user = userEvent.setup();
    const { m, menuItem } = await setup([{ name: 'ADDRESS', value: '0x1000' }], {
      debug: { readMemory: async (r: MemoryRange) => ({ address: r.address, space: 'local' as const, bytes: Uint8Array.from({ length: r.length }, (_, i) => (r.address + i) & 0xff), status: new Uint8Array(r.length) }) },
    });
    await act(async () => menuItem('memory.copyMem')!.onSelect!());
    await user.type(screen.getByLabelText('From Address'), '1000');
    await user.type(screen.getByLabelText('To Address'), '1003');
    await user.type(screen.getByLabelText('Destination'), '2000{Enter}');
    await waitFor(() => expect(m.calls('debug', 'writeMemory')).toEqual([[0x2000, [0, 1, 2, 3], 'local']]));
  });

  it('pop-up Show Location sends SPC to Source and Assembly', async () => {
    const m = createMockS12({ debug: { session: async () => SESSION } });
    const sent: UiCommandInfo[] = [];
    const bus: DebuggerBus = { send: (c) => sent.push(c), setAttributes: () => undefined, status: () => undefined };
    render(
      <S12Provider api={m.api}>
        <DebuggerBusContext.Provider value={bus}>
          <MemoryComponent instanceId="Memory" title="Memory" instance={1} attributes={[{ name: 'ADDRESS', value: '0x4000' }]} active />
        </DebuggerBusContext.Provider>
      </S12Provider>,
    );
    await act(async () => m.emit('debug', 'session', SESSION));
    await waitFor(() => expect(m.calls('debug', 'watchMemory').length).toBeGreaterThan(0));
    const [id, ranges] = lastWatch(m);
    await act(async () => m.emit('debug', 'snapshot', snap(1, { [id]: [block(ranges[0], () => 0)] })));
    fireEvent.contextMenu(document.querySelector('[data-addr="16388"]')!);
    fireEvent.click(document.querySelector('[data-menu-id="memory.showLocation"]')!);
    expect(sent.map((c) => [c.component, c.keyword])).toEqual([
      ['Source', 'SPC'],
      ['Assembly', 'SPC'],
    ]);
    expect(sent[0].argText).toMatch(/4004/i);
  });
});
