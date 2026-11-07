import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S12Provider } from '../../common/s12';
import { createMockS12, type MockS12 } from '../../common/testing/mockS12';
import { setMonacoLoader } from '../../common/monaco/loader';
import { createFakeMonaco, type FakeEditor, type FakeMonaco } from '../../common/monaco/testing/fakeMonaco';
import { ApiError, type ProjectInfo, type WriteTextRequest } from '../../../shared/api';
import { runIdeCommand } from '../commands';
import { getEditorArea, type EditorAreaHandle } from './bridge';
import { visualColumn } from './documents';
import { EditorArea } from './EditorArea';
import { shouldForwardKey } from './keys';

const MAIN = '/p/Lab3/Sources/main.asm';
const INC = '/p/Lab3/Sources/derivative.inc';
const MAIN_TEXT = ['        XDEF  main', "        INCLUDE 'derivative.inc'", 'main:   clr   mode1       ; start', 'top:    jsr   POLL_1', '        bra   top', 'POLL_1: rts', 'mode1: DS.B 1'].join('\n');

interface Disk {
  [path: string]: { text: string; eol: 'crlf' | 'lf'; mtimeMs: number; readOnly?: boolean };
}

let fake: FakeMonaco;
let disk: Disk;
let writes: WriteTextRequest[];
let mock: MockS12;

function setup(opts: { project?: ProjectInfo | null; saveAs?: string | null; busyOnce?: boolean } = {}) {
  let busy = !!opts.busyOnce;
  mock = createMockS12({
    files: {
      readText: async (path: string) => {
        const f = disk[path];
        if (!f) throw new Error(`[not-found] ${path}: ENOENT`);
        return { path, text: f.text, eol: f.eol, mtimeMs: f.mtimeMs, readOnly: !!f.readOnly };
      },
      writeText: async (req: WriteTextRequest) => {
        if (busy && req.expectMtimeMs !== undefined) {
          busy = false;
          throw new Error(`[busy] ${req.path} was changed on disk`);
        }
        writes.push(req);
        const mtimeMs = (disk[req.path]?.mtimeMs ?? 0) + 1000;
        disk[req.path] = { text: req.text, eol: req.eol ?? 'crlf', mtimeMs };
        return { mtimeMs };
      },
      saveDialog: async () => opts.saveAs ?? null,
      stat: async (p: string) => (disk[p] ? { path: p, isFile: true, isDirectory: false, size: disk[p].text.length, mtimeMs: disk[p].mtimeMs } : null),
      readDir: async () => [],
    },
    project: { current: async () => opts.project ?? null },
    settings: { get: async () => undefined as never },
  });
  const ref = createRef<EditorAreaHandle>();
  const utils = render(
    <S12Provider api={mock.api}>
      <EditorArea ref={ref} />
    </S12Provider>,
  );
  return { ref, ...utils };
}

const editor = async (): Promise<FakeEditor> => {
  await waitFor(() => expect(fake.editors).toHaveLength(1));
  return fake.editors[0];
};

async function openMain(ref: React.RefObject<EditorAreaHandle | null>, line?: number) {
  let ok = false;
  await act(async () => {
    ok = await ref.current!.openFile(MAIN, line);
  });
  return ok;
}

beforeEach(() => {
  fake = createFakeMonaco();
  setMonacoLoader(() => Promise.resolve(fake.monaco));
  disk = {
    [MAIN]: { text: MAIN_TEXT, eol: 'crlf', mtimeMs: 100 },
    [INC]: { text: 'PORTA EQU $0000', eol: 'crlf', mtimeMs: 50 },
  };
  writes = [];
});
afterEach(() => setMonacoLoader(null));

describe('EditorArea: opening files', () => {
  it('opens via the editor.open IDE command, shows a tab, path, Line/Col, and watches the file', async () => {
    setup();
    const ed = await editor();
    act(() => runIdeCommand('editor.open', { path: MAIN, line: 4 }));
    await screen.findByTestId('editor-tab-main.asm');
    expect(ed.getModel()!.getValue()).toBe(MAIN_TEXT);
    expect(ed.getModel()!.language).toBe('hc12asm');
    expect(ed.getModel()!.options).toMatchObject({ tabSize: 8, insertSpaces: false });
    expect(screen.getByTestId('editor-toolbar')).toHaveTextContent(`Path: ${MAIN}`);
    // jump selects the whole line (CodeWarrior error jump) and reveals it
    await waitFor(() => expect(ed.selection).toEqual({ startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 21 }));
    expect(ed.revealed).toContain(4);
    expect(screen.getByTestId('editor-linecol')).toHaveTextContent('Line 4 Col 21');
    expect(mock.calls('files', 'watch')).toEqual([[MAIN]]);
    expect(ed.options).toMatchObject({ autoIndent: 'none', theme: 'cw-ide', minimap: { enabled: false }, fontFamily: "'Courier New', Courier, monospace", fontSize: 13 });
    expect(screen.getByTestId('editor-status')).toHaveTextContent('DOS');
  });

  it('activates an already open file instead of opening it twice; column jumps put the cursor', async () => {
    const { ref } = setup();
    const ed = await editor();
    await openMain(ref);
    await act(async () => void (await ref.current!.openFile(INC)));
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(ed.getModel()!.getValue()).toBe('PORTA EQU $0000');
    await act(async () => void (await ref.current!.openFile(MAIN, 3, 9)));
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(ed.getModel()!.getValue()).toBe(MAIN_TEXT);
    expect(ed.getPosition()).toEqual({ lineNumber: 3, column: 9 });
    expect(ref.current!.activePath()).toBe(MAIN);
    expect(ref.current!.openPaths()).toEqual([MAIN, INC]);
    // tab click switches documents
    await userEvent.pointer({ keys: '[MouseLeft]', target: screen.getByTestId('editor-tab-derivative.inc') });
    expect(ref.current!.activePath()).toBe(INC);
  });

  it('reports files that cannot be opened', async () => {
    const { ref } = setup();
    await editor();
    let ok = true;
    act(() => {
      void ref.current!.openFile('/p/missing.asm').then((v) => (ok = v));
    });
    const dlg = await screen.findByTestId('editor-message');
    expect(dlg).toHaveTextContent('Could not open "missing.asm"');
    await userEvent.click(within(dlg).getByText('OK'));
    await waitFor(() => expect(ok).toBe(false));
    act(() => {
      void ref.current!.openFile('/p/bin/Project.abs');
    });
    expect(await screen.findByTestId('editor-message')).toHaveTextContent('not a text file');
  });
});

describe('EditorArea: dirty / save / close / revert', () => {
  it('marks edits dirty and saves with the file EOL and the mtime guard', async () => {
    const { ref } = setup();
    const ed = await editor();
    await openMain(ref);
    expect(screen.getByTestId('editor-tab-main.asm')).toHaveTextContent(/^main\.asm×$/);
    act(() => ed.typeText(MAIN_TEXT + '\n        nop'));
    expect(screen.getByTestId('editor-tab-main.asm')).toHaveTextContent('main.asm *');
    expect(screen.getByTestId('editor-modified')).toHaveClass('dirty');
    expect(ref.current!.dirtyPaths()).toEqual([MAIN]);
    act(() => runIdeCommand('editor.save'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({ path: MAIN, text: MAIN_TEXT + '\n        nop', eol: 'crlf', expectMtimeMs: 100 });
    await waitFor(() => expect(screen.getByTestId('editor-tab-main.asm')).not.toHaveTextContent('*'));
    expect(ref.current!.hasUnsavedChanges()).toBe(false);
  });

  it('keeps LF files LF; changing the EOL format makes the document dirty', async () => {
    disk[MAIN].eol = 'lf';
    const { ref } = setup();
    await editor();
    await openMain(ref);
    expect(screen.getByTestId('editor-status')).toHaveTextContent('Unix');
    await userEvent.click(screen.getByTestId('editor-docsettings'));
    await userEvent.click(screen.getByText('Windows (CR/LF) Line Endings'));
    expect(ref.current!.dirtyPaths()).toEqual([MAIN]);
    await act(async () => void (await ref.current!.save()));
    expect(writes[0].eol).toBe('crlf');
  });

  it('asks before overwriting a file changed on disk', async () => {
    const { ref } = setup({ busyOnce: true });
    const ed = await editor();
    await openMain(ref);
    act(() => ed.typeText('x'));
    act(() => void ref.current!.save());
    const dlg = await screen.findByTestId('editor-confirm');
    expect(dlg).toHaveTextContent('was changed on disk');
    await userEvent.click(screen.getByTestId('editor-confirm-ok'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].expectMtimeMs).toBeUndefined();
  });

  it('close: save prompt with Cancel / Don\'t Save / Save', async () => {
    const { ref } = setup();
    const ed = await editor();
    await openMain(ref);
    act(() => ed.typeText('changed'));
    let closed: boolean | undefined;
    act(() => void ref.current!.close().then((v) => (closed = v)));
    expect(await screen.findByTestId('editor-save-prompt')).toHaveTextContent('Save changes to the document “main.asm” before closing?');
    await userEvent.click(screen.getByTestId('save-prompt-cancel'));
    await waitFor(() => expect(closed).toBe(false));
    expect(screen.getAllByRole('tab')).toHaveLength(1);

    act(() => void ref.current!.close().then((v) => (closed = v)));
    await userEvent.click(await screen.findByTestId('save-prompt-save'));
    await waitFor(() => expect(closed).toBe(true));
    expect(writes.map((w) => w.text)).toEqual(['changed']);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByTestId('editor-empty')).toBeInTheDocument();
    expect(fake.models[0].disposed).toBe(true);
    expect(mock.calls('files', 'unwatch')).toEqual([[MAIN]]);

    await openMain(ref);
    act(() => ed.typeText('again'));
    act(() => runIdeCommand('editor.close'));
    await userEvent.click(await screen.findByTestId('save-prompt-discard'));
    await waitFor(() => expect(screen.queryAllByRole('tab')).toHaveLength(0));
    expect(writes).toHaveLength(1);
  });

  it('closes clean documents without asking; the tab close button works', async () => {
    const { ref } = setup();
    await editor();
    await openMain(ref);
    await userEvent.click(screen.getByLabelText('Close main.asm'));
    expect(screen.queryByTestId('editor-save-prompt')).toBeNull();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(await act(async () => ref.current!.closeAll())).toBe(true);
  });

  it('revert asks and reloads the saved file', async () => {
    const { ref } = setup();
    const ed = await editor();
    await openMain(ref);
    act(() => ed.typeText('garbage'));
    act(() => runIdeCommand('editor.revert'));
    expect(await screen.findByTestId('editor-confirm')).toHaveTextContent('Revert "main.asm" to the last saved version?');
    await userEvent.click(screen.getByTestId('editor-confirm-ok'));
    await waitFor(() => expect(ed.getModel()!.getValue()).toBe(MAIN_TEXT));
    expect(ref.current!.hasUnsavedChanges()).toBe(false);
  });

  it('new text file + Save As writes the chosen path and renames the tab', async () => {
    const { ref } = setup({ saveAs: '/p/Lab3/Sources/new.asm' });
    const ed = await editor();
    act(() => runIdeCommand('editor.new'));
    await screen.findByTestId('editor-tab-Untitled 1');
    act(() => ed.typeText('        nop'));
    await act(async () => void (await ref.current!.save()));
    expect(mock.calls('files', 'saveDialog')).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: '/p/Lab3/Sources/new.asm', text: '        nop', eol: 'crlf', expectMtimeMs: undefined });
    expect(await screen.findByTestId('editor-tab-new.asm')).toBeInTheDocument();
    expect(ref.current!.activePath()).toBe('/p/Lab3/Sources/new.asm');
    expect(mock.calls('files', 'watch')).toContainEqual(['/p/Lab3/Sources/new.asm']);
  });

  it('reloads clean documents changed on disk and asks for dirty ones', async () => {
    const { ref } = setup();
    const ed = await editor();
    await openMain(ref);
    disk[MAIN] = { text: 'reloaded', eol: 'crlf', mtimeMs: 200 };
    act(() => mock.emit('files', 'changed', { path: MAIN, kind: 'change', mtimeMs: 200 }));
    await waitFor(() => expect(ed.getModel()!.getValue()).toBe('reloaded'));
    act(() => ed.typeText('mine'));
    disk[MAIN] = { text: 'theirs', eol: 'crlf', mtimeMs: 300 };
    act(() => mock.emit('files', 'changed', { path: MAIN, kind: 'change', mtimeMs: 300 }));
    expect(await screen.findByTestId('editor-confirm')).toHaveTextContent('modified outside the editor');
    expect(screen.getByTestId('editor-toolbar')).toHaveTextContent('File changed on disk');
    await userEvent.click(screen.getByTestId('editor-confirm-cancel'));
    expect(ed.getModel()!.getValue()).toBe('mine');
    act(() => mock.emit('files', 'changed', { path: MAIN, kind: 'delete' }));
    expect(screen.getByTestId('editor-toolbar')).toHaveTextContent('File deleted on disk');
  });
});

describe('EditorArea: navigation, find, comments', () => {
  it('Go to Line dialog (Ctrl+G command) and direct gotoLine', async () => {
    const { ref } = setup();
    const ed = await editor();
    await openMain(ref);
    act(() => runIdeCommand('editor.gotoLine'));
    const dlg = await screen.findByTestId('goto-line-dialog');
    expect(dlg).toHaveTextContent('Line Number (1-7):');
    const input = within(dlg).getByRole('textbox');
    await userEvent.clear(input);
    await userEvent.type(input, '5{Enter}');
    await waitFor(() => expect(ed.selection.startLineNumber).toBe(5));
    expect(ed.revealed).toContain(5);
    act(() => ref.current!.gotoLine(99));
    await waitFor(() => expect(ed.selection.startLineNumber).toBe(7));
  });

  it('find / replace / find next / edit commands drive Monaco actions', async () => {
    const { ref } = setup();
    const ed = await editor();
    await openMain(ref);
    act(() => {
      runIdeCommand('editor.find');
      runIdeCommand('editor.replace');
      runIdeCommand('editor.findNext');
      ref.current!.findPrevious();
      runIdeCommand('editor.shiftRight');
      runIdeCommand('editor.selectAll');
      runIdeCommand('editor.balance');
      runIdeCommand('editor.undo');
    });
    await waitFor(() =>
      expect(ed.triggered).toEqual(['actions.find', 'editor.action.startFindReplaceAction', 'editor.action.nextMatchFindAction', 'editor.action.previousMatchFindAction', 'editor.action.indentLines', 'editor.action.selectAll', 'editor.action.selectToBracket', 'undo']),
    );
  });

  it('comment / uncomment the selected lines at column 1 (context-menu actions too)', async () => {
    const { ref } = setup();
    const ed = await editor();
    await openMain(ref);
    ed.setSelection({ startLineNumber: 4, startColumn: 3, endLineNumber: 5, endColumn: 4 });
    act(() => ref.current!.comment('comment'));
    expect(ed.getModel()!.getLinesContent().slice(3, 5)).toEqual([';top:    jsr   POLL_1', ';        bra   top']);
    expect(ref.current!.hasUnsavedChanges()).toBe(true);
    await act(async () => void (await ed.getAction('s12.uncomment').run()));
    expect(ed.getModel()!.getLinesContent().slice(3, 5)).toEqual(['top:    jsr   POLL_1', '        bra   top']);
    ed.setSelection({ startLineNumber: 3, startColumn: 1, endLineNumber: 4, endColumn: 1 }); // ends at column 1: one line
    await act(async () => void (await ed.getAction('s12.toggleComment').run()));
    expect(ed.getModel()!.getLinesContent().slice(2, 4)).toEqual([';main:   clr   mode1       ; start', 'top:    jsr   POLL_1']);
  });

  it('{ } Functions popup lists the labels and goes to one; h. lists INCLUDE files and opens them', async () => {
    const { ref } = setup();
    const ed = await editor();
    await openMain(ref);
    await userEvent.click(screen.getByTestId('editor-functions'));
    const menu = await screen.findByTestId('context-menu');
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent?.trim())).toEqual(['main', 'top', 'POLL_1']);
    await userEvent.click(within(menu).getByText('POLL_1'));
    expect(ed.getPosition()).toEqual({ lineNumber: 6, column: 1 });
    // Shift+click: every label; Ctrl+click: alphabetical
    fireEvent.click(screen.getByTestId('editor-functions'), { shiftKey: true });
    expect(within(await screen.findByTestId('context-menu')).getAllByRole('menuitem').map((m) => m.textContent?.trim())).toEqual(['main', 'top', 'POLL_1', 'mode1  (data)']);
    await userEvent.keyboard('{Escape}');
    fireEvent.click(screen.getByTestId('editor-functions'), { ctrlKey: true });
    expect(within(await screen.findByTestId('context-menu')).getAllByRole('menuitem').map((m) => m.textContent?.trim())).toEqual(['main', 'POLL_1', 'top']);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByTestId('editor-interfaces'));
    await userEvent.click(within(await screen.findByTestId('context-menu')).getByText('derivative.inc'));
    await waitFor(() => expect(ref.current!.activePath()).toBe(INC));
  });

  it('Find in Files searches the project files (open documents with their unsaved text) and opens hits', async () => {
    const project = { path: '/p/Lab3/Lab3.mcp', dir: '/p/Lab3', name: 'Lab3', files: [{ name: 'main.asm', path: MAIN }, { name: 'derivative.inc', path: INC }, { name: 'Project.abs', path: '/p/Lab3/bin/Project.abs' }] } as unknown as ProjectInfo;
    const { ref } = setup({ project });
    const ed = await editor();
    await openMain(ref);
    act(() => ed.typeText(MAIN_TEXT + '\n        jsr   POLL_1 ; unsaved'));
    act(() => ref.current!.findInFiles('poll_1'));
    const dlg = await screen.findByTestId('find-in-files-dialog');
    await waitFor(() => expect(within(dlg).getByLabelText('Project files')).toBeChecked());
    expect(within(dlg).getByTestId('find-in-files-query')).toHaveValue('poll_1');
    await userEvent.click(within(dlg).getByTestId('find-in-files-find'));
    const results = await screen.findByTestId('search-results');
    await waitFor(() => expect(results).toHaveTextContent('3 matches for "poll_1" in 1 of 2 files'));
    const rows = within(results).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(['main.asm4top:    jsr   POLL_1', 'main.asm6POLL_1: rts', 'main.asm8        jsr   POLL_1 ; unsaved']);
    await userEvent.dblClick(rows[1]);
    await waitFor(() => expect(ed.getPosition()).toEqual({ lineNumber: 6, column: 1 }));
    expect(mock.calls('files', 'readText').map((c) => c[0])).not.toContain('/p/Lab3/bin/Project.abs');
  });
});

describe('EditorArea: plumbing', () => {
  it('registers itself as the bridge and offers Ctrl shortcuts to the menus', async () => {
    const { ref, unmount } = setup();
    await editor();
    expect(getEditorArea()).not.toBeNull();
    await openMain(ref);
    expect(getEditorArea()!.activePath()).toBe(MAIN);
    // a Ctrl+S typed in Monaco's textarea is re-dispatched on document.body for the menu shortcuts
    const seen = vi.fn();
    document.body.addEventListener('keydown', seen);
    fireEvent.keyDown(fake.editors[0].textarea, { key: 's', ctrlKey: true });
    fireEvent.keyDown(fake.editors[0].textarea, { key: 'c', ctrlKey: true });
    document.body.removeEventListener('keydown', seen);
    // only the unhandled Ctrl+S is re-dispatched (Ctrl+C stays with the text area and just bubbles natively)
    const redispatched = seen.mock.calls.map((c) => c[0] as KeyboardEvent).filter((e) => e.target === document.body);
    expect(redispatched.map((e) => [e.key, e.ctrlKey])).toEqual([['s', true]]);
    unmount();
    expect(getEditorArea()).toBeNull();
    expect(fake.editors[0].disposed).toBe(true);
  });

  it('shouldForwardKey / visualColumn', () => {
    const k = (key: string, mods: Partial<KeyboardEvent> = {}) => shouldForwardKey({ key, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, ...mods });
    expect(k('s', { ctrlKey: true })).toBe(true);
    expect(k('G', { ctrlKey: true, shiftKey: true } as never)).toBe(true);
    expect(k('c', { ctrlKey: true })).toBe(false);
    expect(k('v', { ctrlKey: true })).toBe(false);
    expect(k('s')).toBe(false);
    expect(k('F7', { ctrlKey: true })).toBe(false); // function keys reach the menus anyway
    expect(k('s', { ctrlKey: true, defaultPrevented: true })).toBe(false);
    expect(visualColumn('\tldaa', 2, 8)).toBe(9);
    expect(visualColumn('ab\tc', 4, 8)).toBe(9);
    expect(visualColumn('abc', 3, 8)).toBe(3);
  });

  it('surfaces save errors', async () => {
    const { ref } = setup();
    const ed = await editor();
    await openMain(ref);
    mock.api.files.writeText = async () => {
      throw new ApiError('io', 'EACCES: permission denied');
    };
    act(() => ed.typeText('x'));
    act(() => void ref.current!.save());
    expect(await screen.findByTestId('editor-message')).toHaveTextContent('Could not save "main.asm"');
  });
});

describe('EditorArea: review fixes', () => {
  it('reloads an outside change that arrives right after a save; ignores the notice of its own save', async () => {
    const { ref } = setup();
    const ed = await editor();
    await openMain(ref);
    act(() => ed.typeText('saved by me'));
    await act(async () => void (await ref.current!.save()));
    const own = disk[MAIN].mtimeMs;
    const reads = mock.calls('files', 'readText').length;
    // the watcher's notice for our own write (same mtime): no reload
    await act(async () => mock.emit('files', 'changed', { path: MAIN, kind: 'change', mtimeMs: own }));
    expect(mock.calls('files', 'readText')).toHaveLength(reads);
    // an outside write immediately after the save (no grace period): reloaded
    disk[MAIN] = { text: 'written by another tool', eol: 'crlf', mtimeMs: own + 7 };
    act(() => mock.emit('files', 'changed', { path: MAIN, kind: 'change', mtimeMs: own + 7 }));
    await waitFor(() => expect(ed.getModel()!.getValue()).toBe('written by another tool'));
    expect(ref.current!.hasUnsavedChanges()).toBe(false);
    // a notice without mtime is checked with files.stat
    await act(async () => mock.emit('files', 'changed', { path: MAIN, kind: 'change' }));
    expect(mock.calls('files', 'stat')).toContainEqual([MAIN]);
  });

  it('the bridge handle is a plain object with exactly the handle methods (await / JSON / String are safe)', async () => {
    const { ref } = setup();
    await editor();
    const h = getEditorArea()!;
    expect(h).toBe(ref.current);
    expect((h as unknown as { then?: unknown }).then).toBeUndefined();
    expect(await Promise.resolve(h)).toBe(h);
    expect(() => JSON.stringify(h)).not.toThrow();
    expect(String(h)).toBe('[object Object]');
    expect(Object.keys(h).sort()).toEqual(
      ['activePath', 'close', 'closeAll', 'comment', 'dirtyPaths', 'edit', 'find', 'findInFiles', 'findNext', 'findPrevious', 'focus', 'gotoLine', 'hasUnsavedChanges', 'newFile', 'openFile', 'openPaths', 'replace', 'revert', 'save', 'saveAll', 'saveAs'].sort(),
    );
    await openMain(ref);
    expect(h.activePath()).toBe(MAIN); // still calls the latest closures
  });

  it('Edit > Paste uses the system clipboard, else the last text copied in the editor', async () => {
    const { ref } = setup();
    const ed = await editor();
    await openMain(ref);
    const clip = { readText: vi.fn(async (): Promise<string> => 'from clipboard') };
    Object.defineProperty(navigator, 'clipboard', { value: clip, configurable: true });
    try {
      act(() => runIdeCommand('editor.paste'));
      await waitFor(() => expect(ed.triggeredArgs).toContainEqual(['paste', { text: 'from clipboard' }]));
      // permission denied (main refuses clipboard-read): fall back to the editor's last copy
      clip.readText.mockRejectedValue(new DOMException('Read permission denied.', 'NotAllowedError'));
      const copy = new Event('copy', { bubbles: true }) as Event & { clipboardData: unknown };
      copy.clipboardData = { getData: (t: string) => (t === 'text/plain' ? 'ldaa #$10' : '') };
      fireEvent(ed.textarea, copy);
      act(() => ref.current!.edit('paste'));
      await waitFor(() => expect(ed.triggeredArgs).toContainEqual(['paste', { text: 'ldaa #$10' }]));
      expect(ed.triggered).not.toContain('editor.action.clipboardPasteAction');
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('window close with unsaved changes is cancelled, asks "save changes?", then closes the window', async () => {
    const { ref } = setup();
    const ed = await editor();
    await openMain(ref);
    // clean: the close goes through
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    act(() => ed.typeText('unsaved'));
    const ev = new Event('beforeunload', { cancelable: true });
    act(() => void window.dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(true);
    expect(await screen.findByTestId('editor-save-prompt')).toHaveTextContent('main.asm');
    // a second close attempt while asking does not stack prompts
    const again = new Event('beforeunload', { cancelable: true });
    act(() => void window.dispatchEvent(again));
    expect(again.defaultPrevented).toBe(true);
    expect(screen.getAllByTestId('editor-save-prompt')).toHaveLength(1);
    // Cancel keeps the window and the document
    await userEvent.click(screen.getByTestId('save-prompt-cancel'));
    await waitFor(() => expect(screen.queryByTestId('editor-save-prompt')).toBeNull());
    expect(mock.calls('app', 'closeWindow')).toHaveLength(0);
    expect(ref.current!.hasUnsavedChanges()).toBe(true);
    // Save, then the window is closed for real
    act(() => void window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
    await userEvent.click(await screen.findByTestId('save-prompt-save'));
    await waitFor(() => expect(mock.calls('app', 'closeWindow')).toHaveLength(1));
    expect(writes.map((w) => w.text)).toEqual(['unsaved']);
  });

  it('syntax colouring can be switched on for non-assembly text files (.prm)', async () => {
    const PRM = '/p/Lab3/prm/Project.prm';
    disk[PRM] = { text: 'NAMES END', eol: 'crlf', mtimeMs: 1 };
    const { ref } = setup();
    const ed = await editor();
    await act(async () => void (await ref.current!.openFile(PRM)));
    expect(ed.getModel()!.language).toBe('plaintext');
    await userEvent.click(screen.getByTestId('editor-docsettings'));
    await userEvent.click(screen.getByText('Syntax Coloring'));
    expect(ed.getModel()!.language).toBe('hc12asm');
    await userEvent.click(screen.getByTestId('editor-docsettings'));
    await userEvent.click(screen.getByText('Syntax Coloring'));
    expect(ed.getModel()!.language).toBe('plaintext');
  });
});
