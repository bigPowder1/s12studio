import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DebuggerToolbar } from './DebuggerToolbar';
import { clipboardState, NO_CLIPBOARD } from './clipboard-state';
import { DEFAULT_TOOLBAR, parseToolbar, TOOLBAR_IDS, toolbarDisabled } from './toolbar';
import { DISABLED_GLYPH_FILTER_ID, HIWAVE_TOOLBAR_ICON_KEYS, ToolbarIcons } from './toolbar-icons';

const ORDER = ['tb-new', 'tb-open', 'tb-save', 'tb-cut', 'tb-copy', 'tb-paste', 'tb-help', 'tb-context-help', 'tb-go', 'tb-step', 'tb-step-over', 'tb-step-out', 'tb-asm-step', 'tb-halt', 'tb-reset'];

function setup(disabled: string[] = [], spec = DEFAULT_TOOLBAR) {
  const onCommand = vi.fn();
  render(<DebuggerToolbar items={parseToolbar(spec)} isDisabled={(c) => disabled.includes(c)} onCommand={onCommand} />);
  const bar = screen.getByTestId('debugger-toolbar');
  return { bar, onCommand };
}

describe('DebuggerToolbar (hiwave look)', () => {
  it('has a hiwave glyph for every toolbar id', () => {
    for (const def of Object.values(TOOLBAR_IDS)) {
      expect(HIWAVE_TOOLBAR_ICON_KEYS).toContain(def.icon);
      expect(ToolbarIcons[def.icon]).toBeTruthy();
    }
  });

  it('renders the default toolbar in order, each button an SVG icon in a raised hiwave button', () => {
    const { bar } = setup();
    expect(bar).toHaveAttribute('role', 'toolbar');
    expect(bar).toHaveClass('cw-toolbar', 's12-dbg-toolbar');
    const buttons = [...bar.querySelectorAll('button')];
    expect(buttons.map((b) => b.getAttribute('data-testid'))).toEqual(ORDER);
    for (const b of buttons) {
      expect(b).toHaveClass('s12-dbg-tb-btn');
      expect(b).not.toHaveClass('cw-tool-btn');
      const svg = b.querySelector(':scope > svg');
      expect(svg, b.getAttribute('data-testid')!).not.toBeNull();
      expect(svg).toHaveAttribute('viewBox', '0 0 16 16');
      expect(svg!.childElementCount).toBeGreaterThan(0);
      // the debugger's own glyph, not the common/icons placeholder
      expect(HIWAVE_TOOLBAR_ICON_KEYS).toContain(b.getAttribute('data-icon'));
    }
    expect(screen.getByTestId('tb-go')).toHaveAccessibleName('Start/Continue (F5)');
  });

  it('puts gap separators between the groups (New Open Save | Cut Copy Paste | Help ? | run | Reset)', () => {
    const { bar } = setup();
    const seq = [...bar.children].filter((e) => e.tagName !== 'svg').map((e) => (e.getAttribute('role') === 'separator' ? '|' : e.getAttribute('data-testid')));
    expect(seq.join(' ')).toBe('tb-new tb-open tb-save | tb-cut tb-copy tb-paste | tb-help tb-context-help | tb-go tb-step tb-step-over tb-step-out tb-asm-step tb-halt | tb-reset');
    for (const s of bar.querySelectorAll('[role="separator"]')) expect(s).toHaveClass('s12-dbg-tb-sep');
  });

  it('disables buttons from the command state and provides the emboss filter for their glyphs', () => {
    const { bar, onCommand } = setup(['edit.cut', 'edit.copy', 'edit.paste', 'run.halt']);
    for (const id of ['tb-cut', 'tb-copy', 'tb-paste', 'tb-halt']) expect(screen.getByTestId(id)).toBeDisabled();
    for (const id of ['tb-go', 'tb-step', 'tb-reset']) expect(screen.getByTestId(id)).toBeEnabled();
    expect(bar.querySelector(`filter#${DISABLED_GLYPH_FILTER_ID}`)).not.toBeNull();
    fireEvent.click(screen.getByTestId('tb-halt'));
    expect(onCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('tb-step-over'));
    expect(onCommand).toHaveBeenCalledWith('run.srcOver');
  });

  it('a click does not take the focus from the active component', () => {
    setup();
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    screen.getByTestId('tb-copy').dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('greys New, and Cut/Copy/Paste unless the focused component can take them (hiwave screenshot); others follow the menu', () => {
    const menu = (c: string) => c === 'run.halt';
    for (const c of ['file.new', 'edit.cut', 'edit.copy', 'edit.paste', 'run.halt']) expect(toolbarDisabled(c, NO_CLIPBOARD, menu), c).toBe(true);
    for (const c of ['file.openConfig', 'file.saveConfig', 'run.go']) expect(toolbarDisabled(c, NO_CLIPBOARD, menu), c).toBe(false);
    const all = { cut: true, copy: true, paste: true };
    for (const c of ['edit.cut', 'edit.copy', 'edit.paste']) expect(toolbarDisabled(c, all, menu), c).toBe(false);
    expect(toolbarDisabled('file.new', all, menu)).toBe(true);
  });

  it('clipboard state: Copy needs a selection, Paste an editable field, Cut both', () => {
    document.body.innerHTML = '<p id="t">some text</p><input id="cmd" value="hello" /><input id="ro" readonly value="abc" />';
    (document.activeElement as HTMLElement | null)?.blur();
    window.getSelection()!.removeAllRanges();
    expect(clipboardState()).toEqual(NO_CLIPBOARD);
    window.getSelection()!.selectAllChildren(document.getElementById('t')!);
    expect(clipboardState()).toEqual({ cut: false, copy: true, paste: false });
    window.getSelection()!.removeAllRanges();
    const cmd = document.getElementById('cmd') as HTMLInputElement;
    cmd.focus();
    cmd.setSelectionRange(5, 5);
    expect(clipboardState()).toEqual({ cut: false, copy: false, paste: true });
    cmd.setSelectionRange(0, 5);
    expect(clipboardState()).toEqual({ cut: true, copy: true, paste: true });
    const ro = document.getElementById('ro') as HTMLInputElement;
    ro.focus();
    ro.setSelectionRange(0, 3);
    expect(clipboardState()).toEqual({ cut: false, copy: true, paste: false });
    document.body.innerHTML = '';
  });

  it('follows a custom TOOLBAR= list', () => {
    const { bar } = setup([], '32777 0 32778 32806');
    expect([...bar.querySelectorAll('button')].map((b) => b.getAttribute('data-icon'))).toEqual(['go', 'halt', 'reset']);
    expect(bar.querySelectorAll('[role="separator"]')).toHaveLength(1);
  });
});
