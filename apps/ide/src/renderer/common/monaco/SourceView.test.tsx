import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMonacoLoader } from './loader';
import { buildSourceContextMenu, glyphClassFor, sourceDecorations, SourceView, type SourceLineInfo, type SourceViewHandle } from './SourceView';
import { createFakeMonaco, MOUSE_TARGET, type FakeMonaco } from './testing/fakeMonaco';

const TEXT = ['main:   clr   state', '        ; comment', 'top:    jsr   task1', '        bra   top', ''].join('\n');

let fake: FakeMonaco;
beforeEach(() => {
  fake = createFakeMonaco();
  setMonacoLoader(() => Promise.resolve(fake.monaco));
});
afterEach(() => setMonacoLoader(null));

const info = (p: Partial<SourceLineInfo> = {}): SourceLineInfo => ({ line: 3, hasCode: true, isPc: false, selection: '', ...p });

describe('SourceView helpers', () => {
  it('glyph classes per breakpoint kind / state and PC', () => {
    expect(glyphClassFor({ line: 1, enabled: true }, false)).toBe('s12-bp s12-bp-permanent');
    expect(glyphClassFor({ line: 1, enabled: false, kind: 'conditional' }, false)).toBe('s12-bp s12-bp-conditional s12-bp-disabled');
    expect(glyphClassFor({ line: 1, enabled: true, kind: 'counting' }, true)).toBe('s12-bp s12-bp-counting s12-pc-arrow');
    expect(glyphClassFor(undefined, true)).toBe('s12-pc-arrow');
  });

  it('decorations: PC bar + arrow, breakpoints, code marks, out-of-range lines ignored', () => {
    const model = { getLineCount: () => 4, getLineMaxColumn: (l: number) => [0, 22, 18, 22, 18][l] };
    const d = sourceDecorations(model, { pcLine: 3, breakpoints: [{ line: 1, enabled: true, kind: 'temporary' }, { line: 9, enabled: true }], codeLines: new Set([1, 3, 4, 7]), showMarks: true });
    const glyph = d.filter((x) => x.options.glyphMarginClassName);
    expect(glyph.map((x) => [x.range.startLineNumber, x.options.glyphMarginClassName])).toEqual([
      [1, 's12-bp s12-bp-temporary'],
      [3, 's12-pc-arrow'],
    ]);
    const pc = d.find((x) => x.options.className === 's12-pc-line')!;
    expect(pc.range).toEqual({ startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 22 });
    expect(pc.options.isWholeLine).toBe(true);
    expect(pc.options.inlineClassName).toBe('s12-pc-text');
    expect(d.filter((x) => x.options.linesDecorationsClassName === 's12-code-mark').map((x) => x.range.startLineNumber)).toEqual([1, 3, 4]);
    expect(sourceDecorations(model, { showMarks: false, codeLines: new Set([1]) })).toEqual([]);
  });

  it('hiwave context menu items', () => {
    const h = { setBreakpoint: vi.fn(), deleteBreakpoint: vi.fn(), enableBreakpoint: vi.fn(), disableBreakpoint: vi.fn(), runToCursor: vi.fn(), showBreakpoints: vi.fn(), showLocation: vi.fn(), setProgramCounter: vi.fn(), openSourceFile: vi.fn(), copy: vi.fn(), gotoLine: vi.fn(), find: vi.fn() };
    const labels = (items: ReturnType<typeof buildSourceContextMenu>) => items.map((i) => ('label' in i ? i.label : '-'));
    expect(labels(buildSourceContextMenu(info(), h))).toEqual(['Set Breakpoint', 'Run To Cursor', 'Show Breakpoints...', '-', 'Show Location', 'Set Program Counter', 'Open Source File...', '-', 'Copy', 'Go to Line...', 'Find...']);
    expect(labels(buildSourceContextMenu(info({ breakpoint: { line: 3, enabled: true } }), h)).slice(0, 2)).toEqual(['Delete Breakpoint', 'Disable Breakpoint']);
    expect(labels(buildSourceContextMenu(info({ breakpoint: { line: 3, enabled: false } }), h)).slice(0, 2)).toEqual(['Delete Breakpoint', 'Enable Breakpoint']);
    const noCode = buildSourceContextMenu(info({ hasCode: false }), h);
    const item = (id: string) => noCode.find((i) => 'id' in i && i.id === id) as { disabled?: boolean; onSelect?: () => void };
    expect(item('src.setBreakpoint').disabled).toBe(true);
    expect(item('src.runToCursor').disabled).toBe(true);
    expect(item('src.setProgramCounter').disabled).toBe(true);
    buildSourceContextMenu(info(), h).forEach((i) => 'onSelect' in i && i.onSelect?.());
    expect(h.setBreakpoint).toHaveBeenCalledWith(expect.objectContaining({ line: 3 }));
    expect(h.runToCursor).toHaveBeenCalled();
    expect(h.setProgramCounter).toHaveBeenCalled();
    expect(labels(buildSourceContextMenu(info(), { runToCursor: vi.fn() }))).toEqual(['Run To Cursor']);
  });
});

describe('<SourceView>', () => {
  it('creates a read-only hiwave-themed editor, paints PC/breakpoints/marks and follows the PC', async () => {
    const { rerender } = render(<SourceView text={TEXT} path="C:/Lab3/bin/main.dbg" pcLine={1} codeLines={[1, 3, 4]} breakpoints={[{ line: 3, enabled: true }]} />);
    await waitFor(() => expect(fake.editors).toHaveLength(1));
    const ed = fake.editors[0];
    await waitFor(() => expect(ed.getModel()?.getValue()).toBe(TEXT));
    expect(ed.options).toMatchObject({ readOnly: true, glyphMargin: true, contextmenu: false, theme: 'cw-hiwave', lineNumbers: 'off' });
    expect(ed.getModel()!.language).toBe('hc12asm');
    const glyphs = () => ed.decorations().filter((d) => d.options.glyphMarginClassName).map((d) => [d.range.startLineNumber, d.options.glyphMarginClassName]);
    expect(glyphs()).toEqual([
      [3, 's12-bp s12-bp-permanent'],
      [1, 's12-pc-arrow'],
    ]);
    expect(ed.decorations().filter((d) => d.options.linesDecorationsClassName).length).toBe(3);
    expect(ed.revealed).toContain(1);
    rerender(<SourceView text={TEXT} path="C:/Lab3/bin/main.dbg" pcLine={4} codeLines={[1, 3, 4]} breakpoints={[]} />);
    expect(glyphs()).toEqual([[4, 's12-pc-arrow']]);
    expect(ed.revealed).toContain(4);
    // same path, new text: same model, value replaced
    const model = ed.getModel();
    rerender(<SourceView text={TEXT + 'x'} path="C:/Lab3/bin/main.dbg" pcLine={4} />);
    expect(ed.getModel()).toBe(model);
    expect(model!.getValue()).toBe(TEXT + 'x');
    // other path: new model, old one disposed
    rerender(<SourceView text="other" path="C:/x/other.dbg" />);
    expect(ed.getModel()).not.toBe(model);
    expect(model!.disposed).toBe(true);
  });

  it('margin clicks toggle breakpoints on code lines only', async () => {
    const onToggle = vi.fn();
    render(<SourceView text={TEXT} path="main.dbg" codeLines={[1, 3, 4]} breakpoints={[{ line: 2, enabled: true }]} onToggleBreakpoint={onToggle} />);
    await waitFor(() => expect(fake.editors[0]?.getModel()).toBeTruthy());
    const ed = fake.editors[0];
    const click = (line: number, type: number = MOUSE_TARGET.GUTTER_GLYPH_MARGIN) => act(() => ed.mouseDown.fire({ target: { type, position: { lineNumber: line, column: 1 } }, event: { leftButton: true } }));
    click(3);
    click(2); // no code, but has a breakpoint: may be removed
    click(5); // no code: ignored
    click(4, MOUSE_TARGET.GUTTER_LINE_DECORATIONS);
    click(1, MOUSE_TARGET.CONTENT_TEXT); // text clicks are not margin clicks
    expect(onToggle.mock.calls.map((c) => [c[0], c[1].hasCode, !!c[1].breakpoint])).toEqual([
      [3, true, false],
      [2, false, true],
      [4, true, false],
    ]);
  });

  it('right-click shows the owner-built context menu and runs the chosen item', async () => {
    const run = vi.fn();
    render(<SourceView text={TEXT} path="main.dbg" codeLines={[1, 3, 4]} contextMenu={(i) => buildSourceContextMenu(i, { runToCursor: run, setProgramCounter: vi.fn() })} />);
    await waitFor(() => expect(fake.editors[0]?.getModel()).toBeTruthy());
    const ed = fake.editors[0];
    act(() => ed.contextMenu.fire({ target: { position: { lineNumber: 3, column: 10 } }, event: { posx: 40, posy: 50, preventDefault() {} } }));
    const menu = await screen.findByTestId('context-menu');
    expect(menu).toHaveTextContent('Run To Cursor');
    expect(menu).toHaveTextContent('Set Program Counter');
    await userEvent.click(screen.getByText('Run To Cursor'));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ line: 3, hasCode: true, selection: 'jsr' }));
    expect(screen.queryByTestId('context-menu')).toBeNull();
  });

  it('ref API: reveal, goto, top line, find', async () => {
    const ref = createRef<SourceViewHandle>();
    const onTop = vi.fn();
    render(<SourceView ref={ref} text={TEXT} path="main.dbg" onTopLineChange={onTop} />);
    await waitFor(() => expect(fake.editors[0]?.getModel()).toBeTruthy());
    const ed = fake.editors[0];
    ref.current!.revealLine(4);
    ref.current!.gotoLine(99);
    expect(ed.getPosition()).toEqual({ lineNumber: 5, column: 1 });
    expect(ref.current!.getCursorLine()).toBe(5);
    ed.topLine = 3;
    act(() => ed.scroll.fire({}));
    expect(onTop).toHaveBeenLastCalledWith(3);
    expect(ref.current!.getTopLine()).toBe(3);
    ref.current!.find();
    await waitFor(() => expect(ed.triggered).toContain('actions.find'));
    ed.setSelection({ startLineNumber: 3, startColumn: 9, endLineNumber: 3, endColumn: 12 });
    expect(ref.current!.getSelectedText()).toBe('jsr');
    expect(ref.current!.editor()).toBe(ed);
  });
});
