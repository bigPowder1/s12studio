/**
 * IDE menu bar, CodeWarrior 5.1 (docs/research/r1/ide.md §1): File, Edit, View, Search, Project, Window, Help.
 * (CodeWarrior also shows a Processor Expert menu, an NXP product S12 Studio does not have, so it is left out.) There is no Debug or Run menu in the HCS12 IDE: Debug (F5) and Run live in the Project menu.
 * Confirmed shortcuts: Project > Debug F5, "<target> Settings..." Alt+F7. The others are from memory (UNCERTAIN).
 */
import { SEP, type MenuEntry, type TopMenu } from '../../common/menu/model';
import type { ProjectInfo } from '../../../shared/api';
import type { IdeCommand, IdeCommandMap } from '../commands';
import { baseName } from './open-dispatch';
import { projectFileName } from '../project/project-file-name';

export interface IdeMenuState {
  project: ProjectInfo | null;
  building: boolean;
  /** Active editor document (editor track via setIdeContext). */
  activeFile: string | null;
  /** An editor document is active, untitled ones included (default: `activeFile` is set). */
  hasDocument?: boolean;
  openFiles: string[];
  dirtyCount: number;
  recent: string[];
  toolbarVisible: boolean;
  statusBarVisible: boolean;
  errorsVisible?: boolean;
  /** File selected in the project window (Compile/Check Syntax target when no project file is being edited). */
  selectedFile?: string | null;
}

export interface IdeMenuActions {
  /** Run an IDE command (editor.*, errors.show, dialogs). */
  cmd<C extends IdeCommand>(c: C, arg?: IdeCommandMap[C]): void;
  open(): void;
  openPath(path: string): void;
  closeProject(): void;
  quit(): void;
  make(): void;
  bringUpToDate(): void;
  compile(): void;
  checkSyntax(): void;
  stopBuild(): void;
  debug(): void;
  run(): void;
  addWindow(): void;
  synchronize(): void;
  setTarget(name: string): void;
  setConnection(name: string | null): void;
  toggleToolbar(): void;
  toggleStatusBar(): void;
  focusDebugger(): void;
  showShortcuts(): void;
}

/** Escape '&' for a menu label (single '&' marks the mnemonic): "P&E_Multilink" shows as "P&E_Multilink". */
export const esc = (t: string) => t.replace(/&/g, '&&');

/** Display name of a connection .ini stem ("Full_Chip_Simulation" -> "Full Chip Simulation"). */
export const connectionLabel = (stem: string) => stem.replace(/_/g, ' ');

/**
 * The connection Project > Debug uses: the sidecar's choice, else the one in the target's debugger arguments
 * ("-Prod=%projectFileDir\P&E_Multilink_USB.ini" -> "P&E_Multilink_USB").
 */
export function effectiveConnection(p: ProjectInfo): string | undefined {
  if (p.connection) return p.connection;
  const t = p.targets.find((x) => x.name === p.currentTarget);
  const m = /-Prod=\S*?([^\\/\s]+)\.ini\b/i.exec(t?.debugger?.args ?? '');
  return m?.[1];
}

/** Project files Compile / Check Syntax act on: the active editor document, else the project window's selection. */
export function compileNames(p: ProjectInfo | null, activeFile: string | null, selectedFile?: string | null): string[] {
  if (!p) return [];
  const a = activeFile ? p.files.find((f) => f.path === activeFile) : undefined;
  if (a) return [a.name];
  const s = selectedFile ? p.files.find((f) => f.name === selectedFile) : undefined;
  return s && (s.kind === 'asm' || s.kind === 'c') ? [s.name] : [];
}

export function ideMenus(a: IdeMenuActions, st: IdeMenuState): TopMenu[] {
  const { project, building } = st;
  const noProj = !project;
  const target = project?.currentTarget ?? 'Target';
  const inProject = !!project && !!st.activeFile && project.files.some((f) => f.path === st.activeFile);
  const canCompileActive = compileNames(project, st.activeFile, st.selectedFile).length > 0 && !building;
  const conn = project ? effectiveConnection(project) : undefined;
  // UNCERTAIN: CW 5.1 greys the document commands while no editor window is active (Windows MDI convention; not
  // confirmed on a 5.1 screenshot). Find, Find in Files, New and Open stay enabled.
  const noDoc = !(st.hasDocument ?? !!st.activeFile);
  const recent: MenuEntry[] = st.recent.length ? st.recent.slice(0, 10).map((p, i) => ({ id: `file.recent.${i}`, label: `&${(i + 1) % 10} ${esc(p)}`, onSelect: () => a.openPath(p) })) : [{ label: '(empty)', disabled: true }];

  return [
    {
      label: '&File',
      items: [
        // UNCERTAIN: New Text File Ctrl+N, New... Ctrl+Shift+N (CW convention from memory)
        { id: 'file.newText', label: 'New &Text File', shortcut: 'Ctrl+N', onSelect: () => a.cmd('editor.new') },
        { id: 'file.new', label: '&New...', shortcut: 'Ctrl+Shift+N', onSelect: () => a.cmd('project.new') },
        { id: 'file.open', label: '&Open...', shortcut: 'Ctrl+O', onSelect: a.open },
        { id: 'file.findAndOpen', label: '&Find and Open File...', shortcut: 'Ctrl+D', onSelect: () => a.cmd('file.findAndOpen') },
        { id: 'file.close', label: '&Close', shortcut: 'Ctrl+W', onSelect: () => a.cmd('editor.close') },
        { id: 'file.closeProject', label: 'Close Pro&ject', disabled: noProj, onSelect: a.closeProject },
        SEP,
        { id: 'file.save', label: '&Save', shortcut: 'Ctrl+S', disabled: noDoc, onSelect: () => a.cmd('editor.save') },
        { id: 'file.saveAll', label: 'Save A&ll', shortcut: 'Ctrl+Shift+S', onSelect: () => a.cmd('editor.saveAll') },
        { id: 'file.saveAs', label: 'Save &As...', disabled: noDoc, onSelect: () => a.cmd('editor.saveAs') },
        { id: 'file.saveCopyAs', label: 'Save a Cop&y As...', disabled: true },
        { id: 'file.revert', label: '&Revert', onSelect: () => a.cmd('editor.revert') },
        SEP,
        { id: 'file.openWorkspace', label: 'Open &Workspace...', disabled: true },
        { id: 'file.closeWorkspace', label: 'Close Wor&kspace', disabled: true },
        { id: 'file.saveWorkspace', label: 'Save Works&pace', disabled: true },
        { id: 'file.saveWorkspaceAs', label: 'Save Workspace As...', disabled: true },
        SEP,
        { id: 'file.importComponents', label: 'Import Co&mponents...', disabled: true },
        { id: 'file.closeCatalog', label: 'Close Catalo&g', disabled: true },
        SEP,
        { id: 'file.import', label: '&Import Project...', disabled: true },
        { id: 'file.export', label: '&Export Project...', disabled: true },
        SEP,
        { id: 'file.pageSetup', label: 'Page Set&up...', disabled: true },
        { id: 'file.print', label: '&Print...', shortcut: 'Ctrl+P', disabled: true },
        SEP,
        { id: 'file.recent', label: 'Open Recen&t', submenu: recent },
        SEP,
        { id: 'file.exit', label: 'E&xit', onSelect: a.quit },
      ],
    },
    {
      label: '&Edit',
      items: [
        { id: 'edit.undo', label: '&Undo', shortcut: 'Ctrl+Z', disabled: noDoc, onSelect: () => a.cmd('editor.undo') },
        { id: 'edit.redo', label: '&Redo', shortcut: 'Ctrl+Shift+Z', disabled: noDoc, onSelect: () => a.cmd('editor.redo') },
        SEP,
        { id: 'edit.cut', label: 'Cu&t', shortcut: 'Ctrl+X', disabled: noDoc, onSelect: () => a.cmd('editor.cut') },
        { id: 'edit.copy', label: '&Copy', shortcut: 'Ctrl+C', disabled: noDoc, onSelect: () => a.cmd('editor.copy') },
        { id: 'edit.paste', label: '&Paste', shortcut: 'Ctrl+V', disabled: noDoc, onSelect: () => a.cmd('editor.paste') },
        { id: 'edit.delete', label: '&Delete', disabled: true },
        { id: 'edit.selectAll', label: 'Select &All', shortcut: 'Ctrl+A', onSelect: () => a.cmd('editor.selectAll') },
        SEP,
        // UNCERTAIN: Balance Ctrl+B, Shift Left/Right Ctrl+[ / Ctrl+] (from memory)
        { id: 'edit.balance', label: '&Balance', shortcut: 'Ctrl+B', onSelect: () => a.cmd('editor.balance') },
        { id: 'edit.shiftLeft', label: 'Shift &Left', shortcut: 'Ctrl+[', onSelect: () => a.cmd('editor.shiftLeft') },
        { id: 'edit.shiftRight', label: 'Shift Ri&ght', shortcut: 'Ctrl+]', onSelect: () => a.cmd('editor.shiftRight') },
        SEP,
        { id: 'edit.prevCompletion', label: 'Get Pre&vious Completion', disabled: true },
        { id: 'edit.nextCompletion', label: 'Get Ne&xt Completion', disabled: true },
        { id: 'edit.completeCode', label: 'C&omplete Code', disabled: true },
        SEP,
        { id: 'edit.preferences', label: 'Pr&eferences...', onSelect: () => a.cmd('app.preferences') },
        { id: 'edit.targetSettings', label: `${esc(target)} &Settings...`, shortcut: 'Alt+F7', disabled: noProj, onSelect: () => a.cmd('project.settings') },
        { id: 'edit.vcsSettings', label: '&Version Control Settings...', disabled: true },
        { id: 'edit.keyBindings', label: 'Commands && &Key Bindings...', disabled: true },
      ],
    },
    {
      label: '&View',
      items: [
        {
          id: 'view.toolbars',
          label: '&Toolbars',
          submenu: [
            { id: 'view.toolbar.main', label: '&Main Toolbar', checked: st.toolbarVisible, onSelect: a.toggleToolbar },
            { id: 'view.toolbar.status', label: '&Status Bar', checked: st.statusBarVisible, onSelect: a.toggleStatusBar },
          ],
        },
        { id: 'view.inspector', label: 'Project &Inspector', disabled: noProj, onSelect: () => a.cmd('project.inspect') },
        { id: 'view.browserContents', label: '&Browser Contents', disabled: true },
        { id: 'view.classBrowser', label: '&Class Browser', disabled: true },
        { id: 'view.classHierarchy', label: 'Class &Hierarchy', disabled: true },
        SEP,
        { id: 'view.buildProgress', label: 'Build Progre&ss', disabled: true },
        { id: 'view.errors', label: '&Errors && Warnings Window', shortcut: 'Ctrl+Shift+E', checked: st.errorsVisible, onSelect: () => a.cmd('errors.show') },
        SEP,
        // inactive with an external debugger (ide.md §1)
        { id: 'view.processes', label: '&Processes', disabled: true },
        { id: 'view.expressions', label: 'E&xpressions', disabled: true },
        { id: 'view.globals', label: '&Global Variables', disabled: true },
      ],
    },
    {
      label: '&Search',
      items: [
        // UNCERTAIN: Find Ctrl+F, Find Next F3, Find in Files Ctrl+Shift+F, Replace Ctrl+H, Go to Line Ctrl+G (memory)
        { id: 'search.find', label: '&Find...', shortcut: 'Ctrl+F', onSelect: () => a.cmd('editor.find') },
        { id: 'search.replace', label: '&Replace...', shortcut: 'Ctrl+H', disabled: noDoc, onSelect: () => a.cmd('editor.replace') },
        { id: 'search.findInFiles', label: 'Find in F&iles...', shortcut: 'Ctrl+Shift+F', onSelect: () => a.cmd('editor.findInFiles') },
        SEP,
        { id: 'search.findNext', label: 'Find &Next', shortcut: 'F3', disabled: noDoc, onSelect: () => a.cmd('editor.findNext') },
        { id: 'search.findPrevious', label: 'Find Pre&vious', shortcut: 'Shift+F3', disabled: noDoc, onSelect: () => a.cmd('editor.findPrevious') },
        { id: 'search.findInNextFile', label: 'Find In Next Fi&le', disabled: true },
        SEP,
        { id: 'search.enterFindString', label: '&Enter Find String', disabled: true },
        { id: 'search.findSelection', label: 'Find &Selection', disabled: true },
        SEP,
        { id: 'search.replaceSelection', label: 'Replace Selec&tion', disabled: true },
        { id: 'search.replaceFindNext', label: 'Replace and Find Ne&xt', disabled: true },
        { id: 'search.replaceAll', label: 'Replace &All', disabled: true },
        SEP,
        { id: 'search.findDefinition', label: 'Find &Definition', disabled: true },
        { id: 'search.goBack', label: 'Go &Back', disabled: true },
        { id: 'search.goForward', label: 'Go &Forward', disabled: true },
        SEP,
        { id: 'search.gotoLine', label: '&Go to Line...', shortcut: 'Ctrl+G', onSelect: () => a.cmd('editor.gotoLine') },
        SEP,
        { id: 'search.compareFiles', label: '&Compare Files...', disabled: true },
        { id: 'search.applyDiff', label: 'Apply Difference', disabled: true },
        { id: 'search.unapplyDiff', label: 'Unapply Difference', disabled: true },
      ],
    },
    {
      label: '&Project',
      items: [
        { id: 'project.addWindow', label: 'Add &Window', disabled: noProj || !st.activeFile || inProject, onSelect: a.addWindow },
        { id: 'project.addFiles', label: 'Add &Files...', disabled: noProj, onSelect: () => a.cmd('project.addFiles') },
        { id: 'project.createGroup', label: 'Create Gro&up...', disabled: noProj, onSelect: () => a.cmd('project.createGroup') },
        { id: 'project.createTarget', label: 'Create &Target...', disabled: true },
        SEP,
        { id: 'project.checkSyntax', label: 'Check S&yntax', shortcut: 'Ctrl+;', disabled: !canCompileActive, onSelect: a.checkSyntax },
        { id: 'project.preprocess', label: 'Prepr&ocess', disabled: true },
        { id: 'project.precompile', label: 'Precom&pile', disabled: true },
        { id: 'project.compile', label: '&Compile', shortcut: 'Ctrl+F7', disabled: !canCompileActive, onSelect: a.compile },
        { id: 'project.disassemble', label: 'Disasse&mble', disabled: true },
        SEP,
        // UNCERTAIN: Bring Up To Date Ctrl+U, Make F7 (memory)
        { id: 'project.bringUpToDate', label: '&Bring Up To Date', shortcut: 'Ctrl+U', disabled: noProj || building, onSelect: a.bringUpToDate },
        { id: 'project.make', label: '&Make', shortcut: 'F7', disabled: noProj || building, onSelect: a.make },
        { id: 'project.stopBuild', label: 'S&top Build', shortcut: 'Ctrl+Break', disabled: !building, onSelect: a.stopBuild },
        { id: 'project.removeObjectCode', label: '&Remove Object Code...', disabled: noProj || building, onSelect: () => a.cmd('project.removeObjectCode') },
        SEP,
        { id: 'project.research', label: 'Re-search for Fi&les', disabled: noProj, onSelect: a.synchronize },
        { id: 'project.resetEntryPaths', label: 'Reset Project Entry Pat&hs', disabled: true },
        { id: 'project.synchronize', label: '&Synchronize Modification Dates', disabled: noProj, onSelect: a.synchronize },
        SEP,
        // UNCERTAIN: Run Ctrl+F5 (memory). Confirmed: Debug F5 (wizard readme).
        { id: 'project.run', label: 'R&un', shortcut: 'Ctrl+F5', disabled: noProj || building, onSelect: a.run },
        { id: 'project.debug', label: '&Debug', shortcut: 'F5', disabled: noProj || building, onSelect: a.debug },
        SEP,
        {
          id: 'project.setDefaultProject',
          label: 'Set Default Pro&ject',
          disabled: noProj,
          submenu: project ? [{ label: esc(projectFileName(project)), checked: true }] : [],
        },
        {
          id: 'project.setDefaultTarget',
          label: 'Set Default T&arget',
          disabled: noProj,
          submenu: (project?.targets ?? []).map((t) => ({ id: `target:${t.name}`, label: esc(t.name), checked: t.name === project?.currentTarget, onSelect: () => a.setTarget(t.name) })),
        },
        {
          id: 'project.connection',
          label: 'Change MCU/Co&nnection',
          disabled: noProj || !project?.connections.length,
          submenu: (project?.connections ?? []).map((c) => ({
            id: `connection:${c.name}`,
            label: esc(connectionLabel(c.name)),
            checked: c.name === conn,
            onSelect: () => a.setConnection(c.name),
          })),
        },
      ],
    },
    {
      label: '&Window',
      items: [
        { id: 'window.close', label: '&Close', shortcut: 'Ctrl+F4', onSelect: () => a.cmd('editor.close') },
        { id: 'window.closeAll', label: 'Close &All', onSelect: () => a.cmd('editor.closeAll') },
        SEP,
        { id: 'window.cascade', label: 'Ca&scade', onSelect: () => a.cmd('window.arrange', { mode: 'cascade' }) },
        { id: 'window.tileH', label: 'Tile &Horizontally', onSelect: () => a.cmd('window.arrange', { mode: 'tileHorizontal' }) },
        { id: 'window.tileV', label: 'Tile &Vertically', onSelect: () => a.cmd('window.arrange', { mode: 'tileVertical' }) },
        { id: 'window.saveDefault', label: 'Sa&ve Default Window', disabled: true },
        SEP,
        ...(project ? [{ id: 'window.project', label: `&0 ${esc(projectFileName(project))}`, checked: !st.activeFile, onSelect: () => a.cmd('project.focus') }] : []),
        ...st.openFiles.slice(0, 9).map((p, i) => ({
          id: `window.doc.${i}`,
          label: `&${i + 1} ${esc(baseName(p))}`,
          checked: p === st.activeFile,
          onSelect: () => a.cmd('editor.open', { path: p }),
        })),
      ],
    },
    {
      label: '&Help',
      items: [
        // CodeWarrior Help / Index / Search: S12 Studio has no help system; Help Topics (F1) shows the keyboard
        // shortcuts, the only help content there is.
        { id: 'help.shortcuts', label: 'S12 Studio &Help (Keyboard Shortcuts)...', shortcut: 'F1', onSelect: a.showShortcuts },
        { id: 'help.index', label: '&Index', disabled: true },
        { id: 'help.search', label: '&Search', disabled: true },
        SEP,
        // S12 Studio addition: the blinky demo (examples/blinky; the startup dialog's "Load Example Project")
        { id: 'help.openDemo', label: 'Open &Demo Project', onSelect: () => a.cmd('help.openDemo') },
        SEP,
        { id: 'help.about', label: '&About S12 Studio...', onSelect: () => a.cmd('help.about') },
      ],
    },
  ];
}
