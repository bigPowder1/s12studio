import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { lab3Info } from '../testing/lab3-model';
import { ideMenus, type IdeMenuActions, type IdeMenuState } from './menus';
import { IDE_TOOLBAR, IdeToolbar } from './ide-toolbar';

/** Menu actions that record what ran ("make", "cmd:project.settings"). */
function recorder() {
  const log: string[] = [];
  const a = new Proxy({} as IdeMenuActions, {
    get: (_t, k: string) => (k === 'cmd' ? (c: string) => void log.push(`cmd:${c}`) : () => void log.push(k)),
  });
  return { a, log };
}

const base: IdeMenuState = { project: lab3Info(), building: false, activeFile: '/p/Sources/main.asm', openFiles: ['/p/Sources/main.asm'], dirtyCount: 0, recent: [], toolbarVisible: true, statusBarVisible: true };

function show(over: Partial<IdeMenuState> = {}) {
  const r = recorder();
  const view = render(<IdeToolbar menus={ideMenus(r.a, { ...base, ...over })} />);
  return { ...r, view };
}

const buttons = () => screen.getAllByRole('button');
const enabled = (id: string) => !(screen.getByTestId(id) as HTMLButtonElement).disabled;

describe('IDE main toolbar', () => {
  it('has the 19 CodeWarrior 5.1 buttons in order, tooltips with the menu shortcuts', () => {
    show();
    expect(IDE_TOOLBAR).toHaveLength(19);
    expect(buttons().map((b) => b.getAttribute('title'))).toEqual([
      'New Text File (Ctrl+N)',
      'New... (Ctrl+Shift+N)',
      'Open (Ctrl+O)',
      'Save (Ctrl+S)',
      'Undo (Ctrl+Z)',
      'Redo (Ctrl+Shift+Z)',
      'Cut (Ctrl+X)',
      'Copy (Ctrl+C)',
      'Paste (Ctrl+V)',
      'Find (Ctrl+F)',
      'Find Next (F3)',
      'Replace (Ctrl+H)',
      'Project Window',
      'Make (F7)',
      'Stop Build (Ctrl+Break)',
      'Debug (F5)',
      'Errors & Warnings Window (Ctrl+Shift+E)',
      'Compile (Ctrl+F7)',
      'Target Settings (Alt+F7)',
    ]);
    expect(buttons().map((b) => b.dataset.testid)).toEqual(IDE_TOOLBAR.map((t) => t.testId));
    expect(screen.getByTestId('tb-new')).toBeInTheDocument();
    expect(screen.getByTestId('tb-open')).toBeInTheDocument();
    expect(screen.getByTestId('tb-save')).toBeInTheDocument();
    // Save All and Find in Files stay in the menus only
    expect(screen.queryByTestId('tb-saveall')).toBeNull();
    expect(screen.queryByTitle(/Find in Files/)).toBeNull();
    // every button draws a 16x16 icon
    for (const b of buttons()) expect(b.querySelector('svg')).toHaveAttribute('width', '16');
  });

  it('each button runs its menu command', () => {
    const { log } = show();
    for (const id of ['tb-make', 'tb-debug', 'tb-compile', 'tb-settings', 'tb-errors', 'tb-project', 'tb-new', 'tb-new-project', 'tb-open', 'tb-save', 'tb-undo', 'tb-redo', 'tb-cut', 'tb-copy', 'tb-paste', 'tb-find', 'tb-find-next', 'tb-replace']) fireEvent.click(screen.getByTestId(id));
    expect(log).toEqual([
      'make',
      'debug',
      'compile',
      'cmd:project.settings',
      'cmd:errors.show',
      'cmd:project.focus',
      'cmd:editor.new',
      'cmd:project.new',
      'open',
      'cmd:editor.save',
      'cmd:editor.undo',
      'cmd:editor.redo',
      'cmd:editor.cut',
      'cmd:editor.copy',
      'cmd:editor.paste',
      'cmd:editor.find',
      'cmd:editor.findNext',
      'cmd:editor.replace',
    ]);
  });

  it('Stop Build is enabled only while building, and stops the build; Make/Debug/Compile grey out meanwhile', () => {
    const { log } = show({ building: true });
    expect(enabled('tb-stop')).toBe(true);
    for (const id of ['tb-make', 'tb-debug', 'tb-compile']) expect(enabled(id)).toBe(false);
    fireEvent.click(screen.getByTestId('tb-stop'));
    fireEvent.click(screen.getByTestId('tb-make'));
    expect(log).toEqual(['stopBuild']);
  });

  it('with a project and idle: Stop Build greyed, the project buttons enabled', () => {
    show();
    expect(enabled('tb-stop')).toBe(false);
    for (const id of ['tb-make', 'tb-debug', 'tb-compile', 'tb-settings', 'tb-project']) expect(enabled(id)).toBe(true);
    // as in the 5.1 screenshot, a disabled button keeps its colour icon (Stop Build's red octagon): nothing greys it
    expect(screen.getByTestId('ide-toolbar')).toHaveClass('ide-toolbar');
    expect(screen.getByTestId('tb-stop').querySelector('[style*="grayscale"]')).toBeNull();
    expect(screen.getByTestId('tb-stop').querySelector(':scope > svg')).not.toBeNull();
  });

  it('without a project or document: only New, New..., Open, Find and Errors & Warnings stay enabled', () => {
    const { log } = show({ project: null, activeFile: null, openFiles: [] });
    for (const id of ['tb-make', 'tb-stop', 'tb-debug', 'tb-compile', 'tb-settings', 'tb-project']) expect(enabled(id)).toBe(false);
    for (const id of ['tb-save', 'tb-undo', 'tb-redo', 'tb-cut', 'tb-copy', 'tb-paste', 'tb-find-next', 'tb-replace']) expect(enabled(id)).toBe(false);
    for (const id of ['tb-new', 'tb-new-project', 'tb-open', 'tb-find', 'tb-errors']) expect(enabled(id)).toBe(true);
    fireEvent.click(screen.getByTestId('tb-make'));
    fireEvent.click(screen.getByTestId('tb-save'));
    expect(log).toEqual([]);
  });

  it('an untitled document (no path) still enables Save and the edit buttons', () => {
    show({ project: null, activeFile: null, openFiles: [], hasDocument: true });
    for (const id of ['tb-save', 'tb-undo', 'tb-redo', 'tb-cut', 'tb-copy', 'tb-paste', 'tb-find-next', 'tb-replace']) expect(enabled(id)).toBe(true);
  });

  it('Compile needs a compilable project file (active editor or project window selection)', () => {
    show({ activeFile: '/elsewhere/notes.txt', selectedFile: null });
    expect(enabled('tb-compile')).toBe(false);
    expect(enabled('tb-make')).toBe(true);
  });
});
