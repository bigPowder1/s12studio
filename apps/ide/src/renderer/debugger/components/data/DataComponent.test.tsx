import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MEM_OK, type DebugSnapshot, type ExpressionItem, type MemoryBlockInfo, type MemoryRange, type SessionInfo, type VariableEntry, type WatchpointInfo } from '../../../../shared/api';
import { S12Provider } from '../../../common/s12';
import { createMockS12, type MockOverrides } from '../../../common/testing/mockS12';
import type { MenuCommand, MenuEntry } from '../../../common/menu/model';
import { ComponentHostContext, type ComponentHost } from '../contract';
import { DataComponent } from './DataComponent';
import { expressionBelongs, exprValueSize, formatDataValue, parseDataAttributes, parseDataInput, pointeeSize, typeText, valueBytes } from './model';

const SESSION: SessionInfo = { projectDir: '/p', connection: 'sim', connectionMenu: 'HCS12X FCS', derivative: 'MC9S12XDP512', title: 't' };
const GLOBALS: VariableEntry[] = [
  { name: 'RX_FLAG', address: 0x2500, byteSize: 1, typeName: 'unsigned char', signed: false, module: 'main.dbg' },
  { name: 'COUNT_A', address: 0x2502, byteSize: 2, typeName: 'int', signed: true, module: 'main.dbg' },
  { name: 'BUFFER', address: 0x2510, byteSize: 1, typeName: 'unsigned char', signed: false, arrayLength: 4, module: 'main.dbg' },
  { name: 'LIB_FLAG', address: 0x1000, byteSize: 1, typeName: 'unsigned char', signed: false, module: 'Lib_Other.dbg' },
];

const snap = (seq: number, memory: Record<string, MemoryBlockInfo[]>, cycles = seq, state: DebugSnapshot['state'] = 'halted'): DebugSnapshot => ({ seq, state, statusText: '', cycles, busHz: 8e6, simSeconds: 0, registers: null, memory });

const mem = (ranges: MemoryRange[], values: Record<number, number>): MemoryBlockInfo[] =>
  ranges.map((r) => {
    const bytes = new Uint8Array(r.length);
    for (let i = 0; i < r.length; i++) bytes[i] = values[r.address + i] ?? 0;
    return { address: r.address, space: 'local', bytes, status: new Uint8Array(r.length).fill(MEM_OK) };
  });

async function setup(opts: { attrs?: { name: string; value: string }[]; exprs?: ExpressionItem[]; debug?: MockOverrides['debug']; files?: MockOverrides['files']; title?: string } = {}) {
  let exprs = opts.exprs ?? [];
  const m = createMockS12({
    files: opts.files,
    debug: {
      session: async () => SESSION,
      globals: async () => GLOBALS,
      expressions: async () => exprs,
      addExpression: async (expression: string, component?: string) => {
        exprs = [...exprs, { expression, component: component ?? 'Data' }];
      },
      ...opts.debug,
    },
  });
  const headlines: string[] = [];
  let menu: MenuEntry[] | null = null;
  const host: ComponentHost = { setMenu: (items) => void (items && (menu = items)), setHeadline: (t) => headlines.push(t), open: () => undefined, activate: () => undefined, onUiCommand: () => () => undefined };
  const title = opts.title ?? 'Data';
  render(
    <S12Provider api={m.api}>
      <ComponentHostContext.Provider value={host}>
        <DataComponent instanceId={title} title={title} instance={1} attributes={opts.attrs ?? []} active />
      </ComponentHostContext.Provider>
    </S12Provider>,
  );
  await act(async () => m.emit('debug', 'session', SESSION));
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
  return { m, headlines, menuItem };
}

const lastWatch = (m: ReturnType<typeof createMockS12>) => {
  const c = m.calls('debug', 'watchMemory');
  return c[c.length - 1] as [string, MemoryRange[]];
};

describe('data model', () => {
  it('formats and parses values', () => {
    expect(formatDataValue(0xff, 1, true, 'symb')).toBe('-1');
    expect(formatDataValue(0xff, 1, false, 'symb')).toBe('255');
    expect(formatDataValue(0x12, 2, false, 'hex')).toBe('0x0012');
    expect(formatDataValue(5, 1, false, 'bin')).toBe('%00000101');
    expect(formatDataValue(0x41, 1, false, 'char')).toBe("'A'");
    expect(parseDataInput('0x10', 'symb')).toBe(16);
    expect(parseDataInput('10', 'hex')).toBe(16);
    expect(parseDataInput("'A'", 'symb')).toBe(65);
    expect(valueBytes(-1, 2)).toEqual([0xff, 0xff]);
    expect(valueBytes(256, 1)).toBeNull();
    expect(typeText({ typeName: '', size: 1, signed: false, count: 5 })).toBe('unsigned char[5]');
    expect(parseDataAttributes('SCOPE global,COMPLEMENT None,FORMAT Symb,MODE periodical,SORT NotSort,UPDATERATE 1,NAMEWIDTH 16')).toEqual({ scope: 'global', format: 'symb', mode: 'periodical', sort: false, updateRate: 1, nameWidth: 16 });
    expect(expressionBelongs({ expression: 'x', component: 'Data' }, 'Data:1', 1)).toBe(true);
    expect(expressionBelongs({ expression: 'x', component: 'Data' }, 'Data:2', 2)).toBe(false);
  });

  it('parses Bit Reverse entries back (shown value round-trips) and sizes expression results by value', () => {
    expect(formatDataValue(0x01, 1, false, 'bitrev')).toBe('0x80');
    expect(parseDataInput('0x80', 'bitrev', 1)).toBe(0x01);
    expect(parseDataInput('80', 'bitrev', 1)).toBe(0x01);
    expect(parseDataInput('0x0001', 'bitrev', 2)).toBe(0x8000);
    expect(parseDataInput('0x100', 'bitrev', 1)).toBeNull();
    expect(exprValueSize(0xffff)).toBe(2);
    expect(exprValueSize(0x12345)).toBe(4);
    expect(exprValueSize(-1)).toBe(2);
    expect(exprValueSize(-70000)).toBe(4);
    expect(pointeeSize('unsigned char *')).toBe(1);
    expect(pointeeSize('int *')).toBe(2);
    expect(pointeeSize('long*')).toBe(4);
  });
});

describe('DataComponent', () => {
  it('Global scope lists user expressions first, then module globals, with values from memory', async () => {
    const { m, headlines } = await setup({ exprs: [{ expression: 'COUNT_A', component: 'Data' }] });
    await waitFor(() => expect(screen.getByTestId('value-RX_FLAG')).toBeInTheDocument());
    const names = [...document.querySelectorAll('.data-name')].map((e) => e.textContent);
    expect(names).toEqual(['COUNT_A', 'RX_FLAG', '+BUFFER', 'LIB_FLAG']);
    const [id, ranges] = lastWatch(m);
    expect(ranges).toContainEqual({ address: 0x2510, length: 4, space: 'local' });
    await act(async () => m.emit('debug', 'snapshot', snap(1, { [id]: mem(ranges, { 0x2500: 7, 0x2502: 0xff, 0x2503: 0xfe, 0x2510: 1, 0x2511: 2 }) })));
    expect(screen.getByTestId('value-RX_FLAG').textContent).toBe('7');
    expect(screen.getByTestId('value-COUNT_A').textContent).toBe('-2');
    expect(screen.getByTestId('value-BUFFER').textContent).toBe('{1,2,0,0}');
    expect(headlines.at(-1)).toMatch(/Auto\s+Symb\s+Global/);
  });

  it('User scope shows only user expressions; Local shows the procedure', async () => {
    const { m } = await setup({ attrs: [{ name: 'SCOPE', value: 'user' }], exprs: [{ expression: 'RX_FLAG', component: 'Data' }, { expression: 'PC+2', component: 'Data' }], debug: { evaluate: async (e: string[]) => e.map((x) => ({ expression: x, value: 0xc002 })) } });
    await waitFor(() => expect(screen.getByTestId('value-RX_FLAG')).toBeInTheDocument());
    expect([...document.querySelectorAll('.data-name')].map((e) => e.textContent)).toEqual(['RX_FLAG', 'PC+2']);
    const [id, ranges] = lastWatch(m);
    await act(async () => m.emit('debug', 'snapshot', snap(1, { [id]: mem(ranges, {}) })));
    await waitFor(() => expect(screen.getByTestId('value-PC+2').textContent).toBe('49154'));
    expect(m.calls('debug', 'evaluate')[0]).toEqual([['PC+2']]);
  });

  it('paints a variable red when it changed since the previous halt', async () => {
    const { m } = await setup();
    await waitFor(() => expect(screen.getByTestId('value-RX_FLAG')).toBeInTheDocument());
    const [id, ranges] = lastWatch(m);
    await act(async () => m.emit('debug', 'snapshot', snap(1, { [id]: mem(ranges, { 0x2500: 1 }) }, 10)));
    expect(screen.getByTestId('value-RX_FLAG')).not.toHaveClass('changed');
    await act(async () => m.emit('debug', 'snapshot', snap(2, { [id]: mem(ranges, { 0x2500: 2 }) }, 20)));
    expect(screen.getByTestId('value-RX_FLAG')).toHaveClass('changed');
    expect(screen.getByTestId('value-COUNT_A')).not.toHaveClass('changed');
  });

  it('Frozen mode keeps the values', async () => {
    const { m } = await setup({ attrs: [{ name: 'MODE', value: 'frozen' }] });
    await waitFor(() => expect(screen.getByTestId('value-RX_FLAG')).toBeInTheDocument());
    const [id, ranges] = lastWatch(m);
    await act(async () => m.emit('debug', 'snapshot', snap(1, { [id]: mem(ranges, { 0x2500: 1 }) }, 10)));
    await act(async () => m.emit('debug', 'snapshot', snap(2, { [id]: mem(ranges, { 0x2500: 9 }) }, 20)));
    expect(screen.getByTestId('value-RX_FLAG').textContent).toBe('1');
  });

  it('edits a value in place -> writeMemory (big-endian, sized)', async () => {
    const { m } = await setup();
    await waitFor(() => expect(screen.getByTestId('value-COUNT_A')).toBeInTheDocument());
    fireEvent.doubleClick(screen.getByTestId('value-COUNT_A'));
    const input = screen.getByLabelText('Edit COUNT_A');
    fireEvent.change(input, { target: { value: '0x1234' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(m.calls('debug', 'writeMemory')).toEqual([[0x2502, [0x12, 0x34], 'local']]));
  });

  it('adds an expression with the Edit Expression dialog (double-click a blank line)', async () => {
    const { m } = await setup();
    await waitFor(() => expect(screen.getByTestId('value-RX_FLAG')).toBeInTheDocument());
    fireEvent.doubleClick(screen.getByTestId('data-component'));
    fireEvent.change(screen.getByLabelText('Expression:'), { target: { value: 'SHOW_A' } });
    fireEvent.click(screen.getByTestId('expression-dialog-ok'));
    await waitFor(() => expect(m.calls('debug', 'addExpression')).toEqual([['SHOW_A', 'Data']]));
  });

  it('shows watchpoint bars and opens .xpr files into the window', async () => {
    const wp: WatchpointInfo = { id: 1, start: 0x2500, end: 0x2500, kind: 'write', space: 'local', enabled: true, hits: 0 };
    const { m, menuItem } = await setup({
      debug: { watchpoints: async () => [wp] },
      files: { openDialog: async () => ['/p/bin/Project.xpr'], readText: async () => ({ path: '/p/bin/Project.xpr', text: 'Data < ADDXPR ONLY_ADD_IF_NEW "ECHO_ON"\n', eol: 'crlf' as const, mtimeMs: 0, readOnly: false }) },
    });
    await waitFor(() => expect(screen.getByTestId('watchbar-RX_FLAG')).toBeInTheDocument());
    expect(screen.queryByTestId('watchbar-COUNT_A')).toBeNull();
    await act(async () => menuItem('data.openXpr')!.onSelect!());
    await waitFor(() => expect(m.calls('debug', 'addExpression')).toEqual([['ECHO_ON', 'Data']]));
    await act(async () => m.emit('debug', 'expressions', [{ expression: 'ECHO_ON', component: 'Data' }]));
    await act(async () => menuItem('data.scope.user')!.onSelect!());
    expect([...document.querySelectorAll('.data-name')].map((e) => e.textContent)).toEqual(['ECHO_ON']);
    await act(async () => menuItem('data.scope.global')!.onSelect!());
    fireEvent.contextMenu(screen.getByTestId('value-RX_FLAG'));
    fireEvent.click(document.querySelector('[data-menu-id="data.popup.deleteWatch"]')!);
    await waitFor(() => expect(m.calls('debug', 'removeWatchpoint')).toEqual([[1]]));
  });

  // ---------------------------------------------------------------- review fixes

  it('keys typed into the Edit Expression dialog stay there (Delete does not remove the selected row, Enter submits)', async () => {
    const user = userEvent.setup();
    const { m } = await setup({ exprs: [{ expression: 'RX_FLAG', component: 'Data' }] });
    await waitFor(() => expect(screen.getByTestId('value-RX_FLAG')).toBeInTheDocument());
    fireEvent.mouseDown(document.querySelector('[data-key="xpr:RX_FLAG"]')!);
    fireEvent.contextMenu(document.querySelector('[data-key="xpr:RX_FLAG"]')!);
    fireEvent.click(document.querySelector('[data-menu-id="data.popup.edit"]')!);
    const field = screen.getByLabelText('Expression:') as HTMLInputElement;
    await user.click(field);
    await user.keyboard('{End}{Backspace}{Delete}');
    expect(m.calls('debug', 'removeExpression')).toEqual([]);
    expect(field.value).toBe('RX_FLA');
    await user.type(field, 'X{Enter}');
    await waitFor(() => expect(m.calls('debug', 'addExpression')).toEqual([['RX_FLAX', 'Data']]));
    expect(m.calls('debug', 'removeExpression')).toEqual([['RX_FLAG']]);
    expect(screen.queryByLabelText('Edit RX_FLAG')).toBeNull();
  });

  it('formats a non-variable expression wider than 16 bits without truncation', async () => {
    const { m } = await setup({ attrs: [{ name: 'SCOPE', value: 'user' }, { name: 'FORMAT', value: 'hex' }], exprs: [{ expression: '0x12345', component: 'Data' }], debug: { evaluate: async (e: string[]) => e.map((x) => ({ expression: x, value: 0x12345 })) } });
    await waitFor(() => expect(screen.getByTestId('value-0x12345')).toBeInTheDocument());
    await act(async () => m.emit('debug', 'snapshot', snap(1, {})));
    await waitFor(() => expect(screen.getByTestId('value-0x12345').textContent).toBe('0x00012345'));
  });

  it('writes the un-reversed value when editing in Bit Reverse format', async () => {
    const { m } = await setup({ attrs: [{ name: 'FORMAT', value: 'bitrev' }] });
    await waitFor(() => expect(screen.getByTestId('value-RX_FLAG')).toBeInTheDocument());
    fireEvent.doubleClick(screen.getByTestId('value-RX_FLAG'));
    const input = screen.getByLabelText('Edit RX_FLAG');
    fireEvent.change(input, { target: { value: '0x80' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(m.calls('debug', 'writeMemory')).toEqual([[0x2500, [0x01], 'local']]));
  });

  it('re-runs an evaluation that arrived while one was in flight (halt refresh not lost)', async () => {
    let value = 1;
    const pending: (() => void)[] = [];
    const { m } = await setup({
      attrs: [{ name: 'SCOPE', value: 'user' }],
      exprs: [{ expression: 'PC+2', component: 'Data' }],
      debug: {
        evaluate: (e: string[]) => {
          const v = value;
          return new Promise((res) => pending.push(() => res(e.map((x) => ({ expression: x, value: v })))));
        },
      },
    });
    await waitFor(() => expect(screen.getByTestId('value-PC+2')).toBeInTheDocument());
    await act(async () => m.emit('debug', 'snapshot', snap(1, {}, 10)));
    await waitFor(() => expect(pending).toHaveLength(1));
    // the target halts again while the first evaluation is still running
    value = 2;
    await act(async () => m.emit('debug', 'snapshot', snap(2, {}, 20)));
    await act(async () => pending.shift()!());
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending.shift()!());
    await waitFor(() => expect(screen.getByTestId('value-PC+2').textContent).toBe('2'));
    expect(screen.getByTestId('value-PC+2')).toHaveClass('changed');
  });

  it('refuses a duplicate expression and keeps row keys unique', async () => {
    const { m, headlines } = await setup({ exprs: [{ expression: 'RX_FLAG', component: 'Data' }, { expression: 'PC', component: 'Data' }, { expression: 'PC', component: 'Data' }], debug: { evaluate: async (e: string[]) => e.map((x) => ({ expression: x, value: 1 })) } });
    await waitFor(() => expect(screen.getByTestId('value-RX_FLAG')).toBeInTheDocument());
    const keys = [...document.querySelectorAll('[data-key]')].map((e) => (e as HTMLElement).dataset.key);
    expect(new Set(keys).size).toBe(keys.length);
    fireEvent.doubleClick(screen.getByTestId('data-component'));
    fireEvent.change(screen.getByLabelText('Expression:'), { target: { value: 'RX_FLAG' } });
    fireEvent.click(screen.getByTestId('expression-dialog-ok'));
    expect(m.calls('debug', 'addExpression')).toEqual([]);
    expect(headlines.at(-1)).toMatch(/already in the list/);
  });

  it('Zoom In shows the elements of an array, Zoom Out returns', async () => {
    const { m, menuItem, headlines } = await setup();
    await waitFor(() => expect(screen.getByTestId('value-BUFFER')).toBeInTheDocument());
    fireEvent.mouseDown(document.querySelector('[data-key="var:BUFFER"]')!);
    await act(async () => menuItem('data.zoom.in')!.onSelect!());
    expect([...document.querySelectorAll('.data-name')].map((e) => e.textContent)).toEqual(['[0]', '[1]', '[2]', '[3]']);
    expect(headlines.at(-1)).toMatch(/^BUFFER/);
    const [id, ranges] = lastWatch(m);
    expect(ranges).toEqual([{ address: 0x2510, length: 4, space: 'local' }]);
    await act(async () => m.emit('debug', 'snapshot', snap(1, { [id]: mem(ranges, { 0x2512: 9 }) })));
    expect(screen.getByTestId('value-[2]').textContent).toBe('9');
    await act(async () => menuItem('data.zoom.out')!.onSelect!());
    expect([...document.querySelectorAll('.data-name')].map((e) => e.textContent)).toContain('RX_FLAG');
  });

  it('Pointer as Array shows a pointer variable as N elements at the pointed-to address', async () => {
    const user = userEvent.setup();
    const PTR: VariableEntry = { name: 'PTR', address: 0x2520, byteSize: 2, typeName: 'unsigned char *', signed: false, module: 'main.dbg' };
    const { m, menuItem } = await setup({ debug: { globals: async () => [PTR] } });
    await waitFor(() => expect(screen.getByTestId('value-PTR')).toBeInTheDocument());
    await act(async () => menuItem('data.ptrArray')!.onSelect!());
    await user.click(screen.getByLabelText(/Display pointers as arrays/));
    const n = screen.getByLabelText('Number of elements');
    await user.clear(n);
    await user.type(n, '3{Enter}');
    let [id, ranges] = lastWatch(m);
    await act(async () => m.emit('debug', 'snapshot', snap(1, { [id]: mem(ranges, { 0x2520: 0x30, 0x2521: 0x00 }) })));
    fireEvent.mouseDown(screen.getByText('+'));
    await waitFor(() => expect(lastWatch(m)[1]).toContainEqual({ address: 0x3000, length: 1, space: 'local' }));
    [id, ranges] = lastWatch(m);
    await act(async () => m.emit('debug', 'snapshot', snap(2, { [id]: mem(ranges, { 0x2520: 0x30, 0x3001: 0x41 }) })));
    expect([...document.querySelectorAll('.data-name')].map((e) => e.textContent)).toEqual(['−PTR', '[0]', '[1]', '[2]']);
    expect(screen.getByTestId('value-[1]').textContent).toBe('65');
  });
});
