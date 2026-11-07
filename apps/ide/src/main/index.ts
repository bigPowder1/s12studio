/**
 * S12 Studio main process entry: services, IPC, windows, command line.
 *
 * Environment:
 *   S12_USER_DATA=<dir>   use this userData directory (E2E isolation)
 *   S12_E2E=1             started by the Playwright harness (no single-instance lock, no startup dialog, no updates)
 *   S12_TEMPLATES_DIR     directory holding a course blank_project/ (with its .mcp) for New Project's ME 305 entry,
 *                         searched before <userData>/templates; S12 Studio ships none
 *   S12_FIXTURES          private fixtures checkout (dev runs only: last fallback for that blank_project)
 *   S12_EXAMPLES_DIR      directory holding blinky/ (the demo project), searched instead of the bundled examples
 *   S12_NO_UPDATE=1       no update check (src/main/updates)
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, session, webContents, type MessageBoxOptions } from 'electron';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageBoxRequest } from '../shared/api/app';
import { parseApiError } from '../shared/api/common';
import type { SessionInfo } from '../shared/api/debug';
import { E2E_ENV } from '../shared/ipc';
import { isInsideZip, ZIP_PROJECT_MESSAGE } from '../shared/zip-path';
import { readAppPackage } from './app-package';
import { isProjectFile, parseCli, type CliOptions } from './cli';
import { BuildService } from './engine/build-service';
import { DebugHost } from './engine/debug-host';
import { resolveLaunch } from './engine/debug-launch';
import { demoProjectSource, prepareDemoProject } from './engine/examples-dir';
import { FileWatchers } from './engine/file-watchers';
import { ProjectService } from './engine/project-service';
import { notifyRebuild } from './engine/rebuild-notify';
import { SettingsStore } from './engine/settings-store';
import { findTemplatesDir, templateCandidates, userTemplatesDir } from './engine/templates-dir';
import { TextFiles } from './engine/text-files';
import { EventBus } from './events';
import { createRouter } from './ipc';
import type { MainServices } from './services';
import { createUpdateService } from './updates/electron';
import { mainFrameFromIni } from './window-placement';
import { DEBUGGER_TITLE, WindowManager } from './windows';

const here = dirname(fileURLToPath(import.meta.url));
const e2e = process.env[E2E_ENV] === '1';
if (process.env.S12_USER_DATA) app.setPath('userData', resolve(process.env.S12_USER_DATA));

const cli: CliOptions = parseCli(process.argv, app.isPackaged);
const appPackage = readAppPackage(app.getAppPath());
// Windows: the AppUserModelID must equal the installer's appId (taskbar pinning/grouping, toast notifications)
if (process.platform === 'win32') app.setAppUserModelId(appPackage.appId);

// macOS delivers files opened from Finder / the Dock (file association) as 'open-file', possibly before 'ready':
// queue them until the services exist.
let openFile: ((path: string) => void) | null = null;
const pendingOpenFiles: string[] = [];
app.on('open-file', (e, path) => {
  e.preventDefault();
  if (openFile) openFile(path);
  else pendingOpenFiles.push(path);
});

if (!e2e && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  await app.whenReady();

  // Deny every permission request (camera, notifications...) except reading the clipboard from our own windows:
  // Edit > Paste (menu/toolbar) uses navigator.clipboard.readText() for text copied in other programs.
  const windowsRef: { current: WindowManager | null } = { current: null };
  const clipboardOk = (wc: Electron.WebContents | null, perm: string) => (perm === 'clipboard-read' || perm === 'clipboard-sanitized-write') && !!wc && !!windowsRef.current?.kindOf(wc);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(clipboardOk(wc, perm)));
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null);

  const userData = app.getPath('userData');
  const bus = new EventBus();
  const windows = new WindowManager();
  windowsRef.current = windows;
  windows.devtools = cli.devtools;
  bus.attach((domain, event, payload, to) => windows.send(domain, event, payload, to));
  // Debugger window chrome from the session: native title (verbatim) and the .ini's MainFrame placement.
  bus.attach((domain, event, payload) => {
    if (domain !== 'debug' || event !== 'session') return;
    const info = payload as SessionInfo | null;
    windows.setDebuggerTitle(info?.title || DEBUGGER_TITLE);
    if (info?.iniPath)
      void readFile(info.iniPath, 'latin1').then(
        (text) => {
          const p = mainFrameFromIni(text);
          if (p) windows.applyDebuggerPlacement(p);
        },
        () => undefined,
      );
  });

  const compilerDir = join(userData, 'compiler');
  const templatesDir = findTemplatesDir(
    // appDir: apps/ide (dev) or app.asar (packaged)
    templateCandidates({ env: process.env, userData, appDir: join(here, '../..'), packaged: app.isPackaged, resourcesPath: process.resourcesPath }),
  );
  const projects = new ProjectService(bus, { compilerDir, ensureCompilerRoot: true, templatesDir, watchExternal: true });
  const builds = new BuildService(bus, projects);
  const showMessage = async (win: BrowserWindow | null | undefined, req: MessageBoxRequest): Promise<void> => {
    const opts: MessageBoxOptions = { type: req.type ?? 'info', title: req.title ?? 'S12 Studio', message: req.message, detail: req.detail, buttons: ['OK'], noLink: true };
    await (win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
  };
  const services: MainServices = {
    bus,
    projects,
    builds,
    debug: DebugHost.forScript(bus, join(here, 'debug-worker.js')),
    settings: new SettingsStore(join(userData, 'settings.json'), bus),
    watchers: new FileWatchers(bus),
    textFiles: new TextFiles(),
    windows,
    meta: { name: 'S12 Studio', version: app.getVersion(), platform: process.platform, electron: process.versions.electron, e2e, courseTemplate: !!templatesDir, userTemplatesDir: userTemplatesDir(userData) },
    compilerDir,
    student: {
      prepareDemo: () =>
        prepareDemoProject(
          demoProjectSource({ env: process.env, appDir: join(here, '../..'), packaged: app.isPackaged, resourcesPath: process.resourcesPath }),
          // E2E runs keep the copy inside their isolated userData, never in the real Documents folder
          e2e ? join(userData, 'Documents') : documentsDir(),
        ),
      showMessage: (senderId, req) => {
        const wc = webContents.fromId(senderId);
        return showMessage(wc ? BrowserWindow.fromWebContents(wc) : null, req);
      },
    },
  };
  // Opening a project from the command line / a double-click / Finder: failures get a visible message box (no console
  // for a double-clicked app). Never during E2E (a modal native box would hang the harness).
  openFailed = (req) => (e2e ? console.error(`${req.message} ${req.detail ?? ''}`) : void showMessage(windows.ideWindow, { type: 'error', ...req }).catch(() => undefined));
  const updates = createUpdateService({ repository: appPackage.repository, emit: (n) => bus.emit('app', 'update', n, 'ide'), quit: () => windows.quit() });
  services.updates = updates;
  // "Restart to update" whose quit a window cancelled: no relaunch on a later, deliberate quit
  windows.onQuitCancelled = () => updates.cancelRestart();

  builds.onFinished = (r) => notifyRebuild(services.debug, bus, r).then(() => undefined);

  const router = createRouter(services);
  for (const channel of router.channels()) {
    const dispatch = router.dispatcher(channel)!;
    ipcMain.handle(channel, (e, ...args: unknown[]) => {
      const kind = windows.kindOf(e.sender);
      if (!kind) throw new Error('[invalid-argument] IPC from an unknown window');
      return dispatch({ windowKind: kind, senderId: e.sender.id }, args);
    });
  }

  windows.onClosed = (kind) => {
    // closing hiwave ends its session (the simulation must not keep running headless)
    if (kind === 'debugger' && services.debug.running) void services.debug.call('debug.closeSession').catch(() => undefined);
  };
  windows.onAllClosed = () => {
    void services.debug.dispose().finally(() => app.quit());
  };
  // will-quit, not before-quit: before-quit fires before the windows close, and the IDE window may still cancel the
  // quit at its "save changes?" prompt; the file watchers and the debug engine must survive that.
  app.on('will-quit', () => {
    services.watchers.dispose();
    void services.debug.dispose();
    updates.onWillQuit();
  });

  windows.create('ide');
  const startupFiles = [...cli.open, ...pendingOpenFiles.splice(0)];
  openFile = (path) => void openPaths(services, [path], false);
  await openPaths(services, startupFiles, cli.debug);
  // after startup has settled; never in dev/E2E (updateMode)
  if (updates.mode !== 'off') setTimeout(() => void updates.check(), 5000).unref?.();

  app.on('second-instance', (_e, argv) => {
    const again = parseCli(argv, app.isPackaged);
    void windows.focus('ide').then(() => openPaths(services, again.open, again.debug));
  });
}

/** The user's Documents folder (the home folder where the platform has none). */
function documentsDir(): string {
  try {
    return app.getPath('documents');
  } catch {
    return app.getPath('home');
  }
}

/** Reports a project that could not be opened from the command line (set in main()). */
let openFailed: (req: MessageBoxRequest) => void = (req) => console.error(`${req.message} ${req.detail ?? ''}`);

/** Open command-line files: projects in main, other files in the IDE editor (files.openRequest). */
async function openPaths(s: MainServices, paths: string[], debug: boolean): Promise<void> {
  for (const raw of paths) {
    const p = resolve(raw);
    if (isProjectFile(p)) {
      // Windows Explorer extracts only the double-clicked .mcp from a zip: refuse it before it fails confusingly
      if (isInsideZip(p)) {
        openFailed({ message: ZIP_PROJECT_MESSAGE, detail: p });
        continue;
      }
      try {
        await s.projects.open(p);
        await s.settings.addRecent('recentProjects', p);
      } catch (e) {
        console.error(`cannot open ${p}: ${(e as Error).message}`);
        openFailed({ message: 'The project could not be opened.', detail: `${p}\n\n${parseApiError(e).message}` });
      }
    } else s.bus.emit('files', 'openRequest', { path: p }, 'ide');
  }
  if (debug && s.projects.current) {
    try {
      await s.windows.openDebugger();
      const prefs = (await s.settings.get()).debugger;
      await s.debug.call('engine.openSession', [await resolveLaunch(s.projects, {}, { pacing: prefs.pacing, speedFactor: prefs.speedFactor, snapshotHz: prefs.snapshotHz, compilerDir: s.compilerDir })]);
    } catch (e) {
      console.error(`cannot start the debugger: ${(e as Error).message}`);
    }
  }
}
