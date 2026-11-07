/**
 * File > Open dispatch (CodeWarrior: a .mcp opens a project window, text files open in an editor window; S12 Studio
 * additionally opens a .abs/.elf in the debugger window, like double-clicking it in CW's
 * project window starts hiwave on it).
 */
import { ApiError, type S12Api } from '../../../shared/api';
import { isInsideZip, ZIP_PROJECT_MESSAGE } from '../../../shared/zip-path';
import { runIdeCommand } from '../commands';

export type OpenTarget = 'project' | 'debugger' | 'editor';

/** What File > Open does with a path. */
export function classifyOpen(path: string): OpenTarget {
  if (/\.mcp$/i.test(path) || /\.s12studio\.json$/i.test(path)) return 'project';
  // UNCERTAIN: CW's IDE opens a .abs through the Importer ("Importer for HC12") / hiwave; we start the debugger.
  if (/\.(abs|elf)$/i.test(path)) return 'debugger';
  return 'editor';
}

/** Filters of the File > Open dialog. */
export const OPEN_FILTERS = [
  { name: 'All CodeWarrior Files', extensions: ['mcp', 'asm', 'inc', 's', 'prm', 'bbl', 'abs', 'map', 'lst', 'ini', 'cmd', 'txt', 'json'] },
  { name: 'Project Files (*.mcp)', extensions: ['mcp'] },
  { name: 'Assembler Files (*.asm;*.inc;*.s)', extensions: ['asm', 'inc', 's'] },
  { name: 'Linker Files (*.prm;*.bbl;*.map)', extensions: ['prm', 'bbl', 'map'] },
  { name: 'Absolute Files (*.abs)', extensions: ['abs', 'elf'] },
  { name: 'All Files (*.*)', extensions: ['*'] },
];

/**
 * Open one path the CodeWarrior way. Resolves to what happened (for the status bar). Errors propagate (the caller
 * shows them). A project inside a zip file is refused with a message box (see shared/zip-path.ts).
 */
export async function openPath(s12: S12Api, path: string, opts: { line?: number } = {}): Promise<OpenTarget> {
  const kind = classifyOpen(path);
  if (kind === 'project') {
    if (isInsideZip(path)) {
      await s12.app.showMessage({ type: 'error', message: ZIP_PROJECT_MESSAGE, detail: path }).catch(() => undefined);
      throw new ApiError('invalid-argument', ZIP_PROJECT_MESSAGE);
    }
    await s12.project.open(path);
  } else if (kind === 'debugger') {
    await s12.debug.launch({ absPath: path, load: true });
  } else {
    runIdeCommand('editor.open', opts.line !== undefined ? { path, line: opts.line } : { path });
  }
  void s12.files.addRecent(path).catch(() => undefined);
  return kind;
}

/** Last path component (either separator). */
export function baseName(p: string): string {
  return p.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '');
}

/**
 * Startup dialog "Load Example Project" / Help > Open Demo Project: main copies the demo (examples/blinky) to
 * <Documents>/S12 Studio/Demo (blinky) once, and the copy is opened like File > Open. Resolves to the opened project
 * file. Errors propagate.
 */
export async function openDemoProject(s12: S12Api): Promise<string> {
  const path = await s12.app.prepareDemo();
  await openPath(s12, path);
  return path;
}
