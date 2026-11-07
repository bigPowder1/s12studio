import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockS12 } from '../../../common/testing/mockS12';
import { S12Provider } from '../../../common/s12';
import { ComponentHostContext, type ComponentHost } from '../contract';
import { DebuggerBusContext, type DebuggerBus } from '../../shell/bus';
import { disasmFixture, SESSION, snapshot } from '../../shell/testing';
import type { BreakpointInfo, DisasmRequest, UiCommandInfo } from '../../../../shared/api';
import { AssemblyComponent } from './AssemblyComponent';
import { asmRows, attributesFromOptions, DEFAULT_ASM_OPTIONS, optionsFromAttributes, rowText } from './model';

const LAB3_ATTRS = [
  { name: 'ADR', value: 'on' },
  { name: 'CODE', value: 'off' },
  { name: 'ABSADR', value: 'on' },
  { name: 'SYMB', value: 'off' },
  { name: 'FORMAT', value: 'Auto' },
  { name: 'FREEZE', value: 'off' },
  { name: 'TOPPC', value: '0x4000' },
];

describe('assembly rows (disasm fixture: start-up code decoded by @s12/isa)', () => {
  const lines = disasmFixture();

  it('formats address | instruction | absolute target, with label rows', () => {
    const rows = asmRows(lines, DEFAULT_ASM_OPTIONS, 0xc003, []);
    expect(rows.map(rowText)).toEqual(['Entry:', 'C000 LDS    #0x2400', 'C003 JSR    0xC020', 'C006 JSR    0xC040', 'C009 JSR    0xC060', 'C00C JSR    0x0900', 'C00F BRA    *+0 ;abs = 0xC00F']);
    expect(rows.filter((r) => r.isPc).map((r) => r.address)).toEqual([0xc003]);
  });

  it('shows machine code with Display Code and hides the address/abs columns when off', () => {
    const rows = asmRows(lines, { address: false, code: true, symbolic: false, absAddress: false }, undefined, []);
    expect(rowText(rows[1])).toBe('CF2400       LDS    #0x2400');
    expect(rowText(rows[6])).toBe('20FE         BRA    *+0');
  });

  it('marks breakpoints by address', () => {
    const bp: BreakpointInfo = { id: 1, address: 0xc006, enabled: false, temporary: false, hits: 0 };
    const rows = asmRows(lines, DEFAULT_ASM_OPTIONS, undefined, [bp]);
    expect(rows.find((r) => r.address === 0xc006 && r.kind === 'insn')?.bp).toBe(bp);
  });

  it('reads and writes the layout attributes (ASM_layout.hwl)', () => {
    const { options, topPc } = optionsFromAttributes(LAB3_ATTRS);
    expect(options).toEqual({ address: true, code: false, absAddress: true, symbolic: false });
    expect(topPc).toBe(0x4000);
    expect(attributesFromOptions(LAB3_ATTRS, { ...options, code: true }, 0xc000)).toEqual([
      { name: 'ADR', value: 'on' },
      { name: 'CODE', value: 'on' },
      { name: 'ABSADR', value: 'on' },
      { name: 'SYMB', value: 'off' },
      { name: 'FORMAT', value: 'Auto' },
      { name: 'FREEZE', value: 'off' },
      { name: 'TOPPC', value: '0xC000' },
    ]);
  });
});

function setup(resyncBack = false) {
  const lines = disasmFixture();
  const listeners: ((c: UiCommandInfo) => void)[] = [];
  const m = createMockS12({
    debug: {
      session: async () => SESSION,
      disassemble: async (req: DisasmRequest) => {
        // like the engine in erased code: decoding backwards resyncs on a different (odd) instruction start
        const odd = (a: number) => ({ address: a, bytes: [0], mnemonic: 'BGND', operands: '' });
        if (resyncBack && req.before) return [odd(req.address - 1), ...lines.filter((l) => l.address >= req.address).slice(0, req.count)];
        if (resyncBack && !lines.some((l) => l.address === req.address)) return [odd(req.address), ...lines.filter((l) => l.address > req.address).slice(0, req.count - 1)];
        const i = Math.max(0, lines.findIndex((l) => l.address >= req.address) - (req.before ?? 0));
        return lines.slice(i, i + req.count);
      },
      symbols: async () => [{ name: 'Entry', address: 0xc000, size: 0, kind: 'notype', global: true }],
      setBreakpoint: async (spec) => ({ id: 7, temporary: false, enabled: true, hits: 0, ...spec }) as BreakpointInfo,
    },
  });
  const headlines: string[] = [];
  const host: ComponentHost = { setMenu: () => undefined, setHeadline: (t) => headlines.push(t), open: () => undefined, activate: () => undefined, onUiCommand: (fn) => (listeners.push(fn), () => undefined) };
  const bus: DebuggerBus = { send: () => undefined, setAttributes: () => undefined, status: () => undefined };
  render(
    <S12Provider api={m.api}>
      <ComponentHostContext.Provider value={host}>
        <DebuggerBusContext.Provider value={bus}>
          <AssemblyComponent instanceId="w2" title="Assembly" instance={1} attributes={LAB3_ATTRS} active />
        </DebuggerBusContext.Provider>
      </ComponentHostContext.Provider>
    </S12Provider>,
  );
  return { m, headlines, listeners };
}

describe('AssemblyComponent', () => {
  it('follows the PC after a halt and toggles breakpoints from the margin', async () => {
    const { m, headlines } = setup();
    act(() => m.emit('debug', 'snapshot', snapshot({ regs: { PC: 0xc003 } })));
    await waitFor(() => expect(screen.getByTestId('asm-row-C003')).toHaveAttribute('data-pc', 'true'));
    expect(screen.getByTestId('asm-row-C000')).toHaveTextContent('C000 LDS #0x2400');
    expect(screen.getByText('Entry:')).toBeInTheDocument();
    await waitFor(() => expect(headlines.at(-1)).toBe('Entry'));

    fireEvent.click(screen.getByTestId('asm-gutter-C006'));
    await waitFor(() => expect(m.calls('debug', 'setBreakpoint')).toEqual([[{ address: 0xc006 }]]));
    act(() => m.emit('debug', 'breakpoints', [{ id: 7, address: 0xc006, enabled: true, temporary: false, hits: 0 }]));
    expect(screen.getByTestId('asm-row-C006')).toHaveAttribute('data-bp', 'enabled');
    fireEvent.click(screen.getByTestId('asm-gutter-C006'));
    await waitFor(() => expect(m.calls('debug', 'removeBreakpoint')).toEqual([[7]]));
  });

  it('pop-up Run To Cursor and Set Program Counter use the row address', async () => {
    const { m } = setup();
    act(() => m.emit('debug', 'snapshot', snapshot({ regs: { PC: 0xc000 } })));
    await waitFor(() => screen.getByTestId('asm-row-C009'));
    fireEvent.contextMenu(screen.getByTestId('asm-row-C009'));
    fireEvent.click(document.querySelector('[data-menu-id="asm.runTo"]')!);
    expect(m.calls('debug', 'runTo')).toEqual([[0xc009]]);
    fireEvent.contextMenu(screen.getByTestId('asm-row-C00C'));
    fireEvent.click(document.querySelector('[data-menu-id="asm.setPc"]')!);
    expect(m.calls('debug', 'writeRegister')).toEqual([['PC', 0xc00c]]);
  });

  it('scrolls to an address on `Assembly < SPC`', async () => {
    const { m, listeners } = setup();
    act(() => m.emit('debug', 'snapshot', snapshot({ regs: { PC: 0xc000 } })));
    await waitFor(() => screen.getByTestId('asm-row-C000'));
    act(() => listeners.forEach((l) => l({ component: 'Assembly', keyword: 'SPC', argText: '0xC00C', raw: '' })));
    await waitFor(() => expect(screen.queryByTestId('asm-row-C000')).toBeNull());
    expect(screen.getByTestId('asm-row-C00C')).toHaveClass('sel');
  });

  it('scrolling back by the amount just scrolled forward returns to the same top (review finding 10)', async () => {
    const { m } = setup(true);
    act(() => m.emit('debug', 'snapshot', snapshot({ regs: { PC: 0xc000 } })));
    await waitFor(() => screen.getByTestId('asm-row-C000'));
    const firstRow = () => screen.getAllByTestId(/^asm-row-/)[0].dataset.testid;
    await waitFor(() => expect(firstRow()).toBe('asm-row-BFFF'));
    const box = screen.getByTestId('assembly-component');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    await waitFor(() => expect(firstRow()).toBe('asm-row-C000'));
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    await waitFor(() => expect(firstRow()).toBe('asm-row-C003'));
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    await waitFor(() => expect(firstRow()).toBe('asm-row-C000'));
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    await waitFor(() => expect(firstRow()).toBe('asm-row-BFFF'));
    // nothing left to undo: decodes backwards again
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    await waitFor(() => expect(m.calls('debug', 'disassemble').some(([r]) => (r as DisasmRequest).address === 0xbfff && (r as DisasmRequest).before === 1)).toBe(true));
  });
});
