import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMockS12 } from '../../../common/testing/mockS12';
import { S12Provider } from '../../../common/s12';
import { HC12_LANGUAGE_ID, setMonacoLoader } from '../../../common/monaco';
import { createFakeMonaco, MOUSE_TARGET, type FakeEditor, type FakeMonaco } from '../../../common/monaco/testing/fakeMonaco';
import { ComponentHostContext, type ComponentHost } from '../contract';
import { SESSION, snapshot } from '../../shell/testing';
import type { BreakpointInfo, UiCommandInfo } from '../../../../shared/api';
import { breakpointKind, SourceComponent } from './SourceComponent';
import { addressForLine, breakpointsByLine, findLine } from './model';

const DBG = ['; Lab 3', '', '              XDEF  main', 'main:', 'Entry:        LDS   #$2400   ; stack', '              JSR   INIT', 'spin:         BRA   spin', '* end'].join('\n');
const LINES = [
  { line: 5, address: 0xc000 },
  { line: 6, address: 0xc003 },
  { line: 7, address: 0xc006 },
];
const FILE = 'C:\\Lab3\\bin\\main.dbg';
const bpInfo = (p: Partial<BreakpointInfo>): BreakpointInfo => ({ id: 1, address: 0xc000, enabled: true, temporary: false, hits: 0, ...p });

describe('source model', () => {
  it('maps lines to addresses (next line with code) and breakpoints to lines', () => {
    expect(addressForLine(LINES, 4)).toEqual({ line: 5, address: 0xc000 });
    expect(addressForLine(LINES, 8)).toBeUndefined();
    const bp = bpInfo({ address: 0xc006 });
    expect([...breakpointsByLine(LINES, [bp])]).toEqual([[7, bp]]);
    expect(findLine(DBG.split('\n'), 'spin', 1)).toBe(7);
    expect(findLine(DBG.split('\n'), 'xdef', 8)).toBe(3);
  });

  it('gives each breakpoint kind its own margin icon', () => {
    expect(breakpointKind(bpInfo({}))).toBe('permanent');
    expect(breakpointKind(bpInfo({ temporary: true, condition: 'A==1' }))).toBe('temporary');
    expect(breakpointKind(bpInfo({ condition: 'A==1' }))).toBe('conditional');
    expect(breakpointKind(bpInfo({ condition: 'A==1', conditionEnabled: false }))).toBe('permanent');
    expect(breakpointKind(bpInfo({ counter: { current: 0, interval: 5 } }))).toBe('counting');
    expect(breakpointKind(bpInfo({ counter: { current: 0, interval: 1 } }))).toBe('permanent');
  });
});

let fake: FakeMonaco;
beforeEach(() => {
  fake = createFakeMonaco();
  setMonacoLoader(() => Promise.resolve(fake.monaco));
});
afterEach(() => setMonacoLoader(null));

function setup(opts: { withSource?: boolean; sourceLocation?: (a: number) => { file: string; line: number } | null } = {}) {
  const { withSource = true } = opts;
  const listeners: ((c: UiCommandInfo) => void)[] = [];
  const m = createMockS12({
    debug: {
      session: async () => SESSION,
      readSource: async (file) => {
        if (!withSource) throw new Error('[not-found] no source');
        return { file, path: '/p/Lab3/bin/main.dbg', text: DBG };
      },
      lineAddresses: async () => LINES,
      sourceLocation: async (a) => (opts.sourceLocation ? opts.sourceLocation(a) : a === 0xc006 ? { file: FILE, line: 7 } : null),
      setBreakpoint: async (spec) => ({ id: 3, temporary: false, enabled: true, hits: 0, ...spec }) as BreakpointInfo,
    },
  });
  const headlines: string[] = [];
  const host: ComponentHost = { setMenu: () => undefined, setHeadline: (t) => headlines.push(t), open: () => undefined, activate: () => undefined, onUiCommand: (fn) => (listeners.push(fn), () => undefined) };
  render(
    <S12Provider api={m.api}>
      <ComponentHostContext.Provider value={host}>
        <SourceComponent instanceId="w1" title="Source" instance={1} attributes={[{ name: 'MARKS', value: 'off' }]} active />
      </ComponentHostContext.Provider>
    </S12Provider>,
  );
  return { m, headlines, listeners };
}

const root = () => screen.getByTestId('source-component');
/** The Monaco editor once it shows the .dbg file. */
async function editor(): Promise<FakeEditor> {
  await waitFor(() => expect(fake.editors.at(-1)?.model?.getValue()).toBe(DBG));
  return fake.editors.at(-1)!;
}
const pcBar = (ed: FakeEditor) => ed.decorations().filter((d) => d.options.className === 's12-pc-line').map((d) => d.range.startLineNumber);
const glyphs = (ed: FakeEditor) => ed.decorations().filter((d) => d.options.glyphMarginClassName).map((d) => [d.range.startLineNumber, d.options.glyphMarginClassName]);
const marginClick = (ed: FakeEditor, line: number) => act(() => ed.mouseDown.fire({ target: { type: MOUSE_TARGET.GUTTER_GLYPH_MARGIN, position: { lineNumber: line, column: 1 } }, event: { leftButton: true } }));
const popup = (ed: FakeEditor, line: number) => act(() => ed.contextMenu.fire({ target: { position: { lineNumber: line, column: 16 } }, event: { posx: 20, posy: 30, preventDefault() {} } }));

describe('SourceComponent (Monaco SourceView)', () => {
  it('shows the .dbg file of the PC in the Monaco view with the PC line highlighted', async () => {
    const { m, headlines } = setup();
    act(() => m.emit('debug', 'snapshot', snapshot({ regs: { PC: 0xc000 }, source: { file: FILE, line: 5 } })));
    const ed = await editor();
    await waitFor(() => expect(pcBar(ed)).toEqual([5]));
    expect(root()).toHaveAttribute('data-pc-line', '5');
    expect(ed.options.readOnly).toBe(true);
    expect(fake.models.at(-1)!.language).toBe(HC12_LANGUAGE_ID);
    expect(ed.revealed).toContain(5);
    await waitFor(() => expect(headlines.at(-1)).toBe('/p/Lab3/bin/main.dbg\tLine: 1'));
    expect(m.calls('debug', 'readSource')).toEqual([[FILE]]);
  });

  it('moves the PC line after Set Program Counter / a PC edit without a halt (review finding 2)', async () => {
    const { m } = setup({ sourceLocation: (a) => (a === 0xc003 ? { file: FILE, line: 6 } : null) });
    const halt = snapshot({ regs: { PC: 0xc000 }, source: { file: FILE, line: 5 } });
    act(() => m.emit('debug', 'snapshot', halt));
    const ed = await editor();
    await waitFor(() => expect(pcBar(ed)).toEqual([5]));
    // engine snapshot after writeRegister('PC'): new registers, but halt + source still from the last halt
    act(() => m.emit('debug', 'snapshot', { ...halt, seq: halt.seq + 1, registers: { ...halt.registers!, PC: 0xc003 } }));
    await waitFor(() => expect(pcBar(ed)).toEqual([6]));
    expect(m.calls('debug', 'sourceLocation')).toEqual([[0xc003]]);
    expect(root()).toHaveAttribute('data-pc-line', '6');
  });

  it('margin click toggles a breakpoint at the line address; marks show per kind', async () => {
    const { m } = setup();
    act(() => m.emit('debug', 'snapshot', snapshot({ regs: { PC: 0xc000 }, source: { file: FILE, line: 5 } })));
    const ed = await editor();
    await waitFor(() => expect(pcBar(ed)).toEqual([5]));
    marginClick(ed, 6);
    marginClick(ed, 4); // no code on this line: the view ignores the click (breakpoints only where Marks are)
    await waitFor(() => expect(m.calls('debug', 'setBreakpoint')).toEqual([[{ address: 0xc003 }]]));
    act(() =>
      m.emit('debug', 'breakpoints', [
        bpInfo({ id: 3, address: 0xc003 }),
        bpInfo({ id: 4, address: 0xc006, condition: 'A==2' }),
      ]),
    );
    await waitFor(() =>
      expect(glyphs(ed)).toEqual([
        [6, 's12-bp s12-bp-permanent'],
        [7, 's12-bp s12-bp-conditional'],
        [5, 's12-pc-arrow'],
      ]),
    );
    expect(root()).toHaveAttribute('data-bp-lines', '6 7');
    marginClick(ed, 6);
    await waitFor(() => expect(m.calls('debug', 'removeBreakpoint')).toEqual([[3]]));
  });

  it('pop-up Run To Cursor / Set Program Counter use the line address; Marks toggles the code marks', async () => {
    const { m } = setup();
    act(() => m.emit('debug', 'snapshot', snapshot({ regs: { PC: 0xc000 }, source: { file: FILE, line: 5 } })));
    const ed = await editor();
    popup(ed, 7);
    const labels = [...document.querySelectorAll('[data-menu-id]')].map((e) => e.getAttribute('data-menu-id'));
    expect(labels).toEqual(['src.setBreakpoint', 'src.runToCursor', 'src.showBreakpoints', 'src.showLocation', 'src.setProgramCounter', 'src.openSourceFile', 'src.copy', 'src.gotoLine', 'src.find', 'src.findProcedure', 'src.marks']);
    fireEvent.click(document.querySelector('[data-menu-id="src.runToCursor"]')!);
    expect(m.calls('debug', 'runTo')).toEqual([[0xc006]]);
    popup(ed, 6);
    fireEvent.click(document.querySelector('[data-menu-id="src.setProgramCounter"]')!);
    expect(m.calls('debug', 'writeRegister')).toEqual([['PC', 0xc003]]);
    expect(ed.decorations().some((d) => d.options.linesDecorationsClassName === 's12-code-mark')).toBe(false);
    popup(ed, 6);
    fireEvent.click(document.querySelector('[data-menu-id="src.marks"]')!);
    await waitFor(() => expect(ed.decorations().filter((d) => d.options.linesDecorationsClassName === 's12-code-mark').map((d) => d.range.startLineNumber)).toEqual([5, 6, 7]));
  });

  it('greys out Run To Cursor / Set Program Counter while running', async () => {
    const { m } = setup();
    act(() => m.emit('debug', 'snapshot', snapshot({ regs: { PC: 0xc000 }, source: { file: FILE, line: 5 } })));
    const ed = await editor();
    act(() => m.emit('debug', 'snapshot', snapshot({ state: 'running' })));
    popup(ed, 7);
    expect(document.querySelector('[data-menu-id="src.runToCursor"]')).toHaveAttribute('aria-disabled', 'true');
    expect(document.querySelector('[data-menu-id="src.setProgramCounter"]')).toHaveAttribute('aria-disabled', 'true');
  });

  it('says "no source" when the PC is in library code', async () => {
    const { m } = setup();
    act(() => m.emit('debug', 'snapshot', snapshot({ regs: { PC: 0x8000 } })));
    // hiwave leaves the body empty: the reason is the tooltip (final fidelity F11)
    await waitFor(() => expect(screen.getByTestId('source-empty').getAttribute('title')).toContain('No source for PC 0x8000'));
    expect(root().textContent).toBe('');
  });

  it('says "no source" when the .dbg file cannot be found, and does not retry the read', async () => {
    const { m } = setup({ withSource: false });
    act(() => m.emit('debug', 'snapshot', snapshot({ regs: { PC: 0xc000 }, source: { file: FILE, line: 5 } })));
    const reason = () => screen.getByTestId('source-empty').getAttribute('title') ?? '';
    await waitFor(() => expect(reason()).toContain('not found'));
    act(() => m.emit('debug', 'snapshot', snapshot({ regs: { PC: 0xc000 }, source: { file: FILE, line: 5 } })));
    await waitFor(() => expect(reason()).toContain('not found'));
    expect(m.calls('debug', 'readSource')).toHaveLength(1);
  });

  it('shows a location on `Source < SPC addr` (command-language numbers)', async () => {
    const { m, listeners } = setup();
    act(() => m.emit('debug', 'snapshot', snapshot({ regs: { PC: 0xc000 }, source: { file: FILE, line: 5 } })));
    const ed = await editor();
    act(() => listeners.forEach((l) => l({ component: 'Source', keyword: 'SPC', argText: '0xC006', raw: '' })));
    await waitFor(() => expect(ed.position.lineNumber).toBe(7));
    expect(m.calls('debug', 'sourceLocation').at(-1)).toEqual([0xc006]);
  });

  it('Go to Line and Find dialogs (Ctrl+G / Ctrl+F) move the cursor', async () => {
    const { m } = setup();
    act(() => m.emit('debug', 'snapshot', snapshot({ regs: { PC: 0xc000 }, source: { file: FILE, line: 5 } })));
    const ed = await editor();
    fireEvent.keyDown(screen.getByTestId('source-view'), { key: 'g', ctrlKey: true });
    const line = screen.getByTestId('source-goto-dialog').querySelector('input')!;
    fireEvent.change(line, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(ed.position.lineNumber).toBe(3);
    fireEvent.keyDown(screen.getByTestId('source-view'), { key: 'f', ctrlKey: true });
    fireEvent.change(screen.getByTestId('source-find-dialog').querySelector('input')!, { target: { value: 'spin' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(ed.position.lineNumber).toBe(7);
  });

  it('Find Procedure (Ctrl+I) shows the procedure; an empty Source window offers Open Source File (final fidelity F10)', async () => {
    const { m } = setup();
    fireEvent.contextMenu(screen.getByTestId('source-empty'));
    expect(document.querySelector('[data-menu-id="src.openSourceFile"]')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    act(() => m.emit('debug', 'snapshot', snapshot({ regs: { PC: 0xc000 }, source: { file: FILE, line: 5 } })));
    const ed = await editor();
    fireEvent.keyDown(screen.getByTestId('source-view'), { key: 'i', ctrlKey: true });
    fireEvent.change(screen.getByTestId('source-findproc-dialog').querySelector('input')!, { target: { value: '0xC006' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(ed.position.lineNumber).toBe(7));
  });
});
