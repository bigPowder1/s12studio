/**
 * Window manager: the two CodeWarrior window kinds. The IDE window ("S12 Studio", like the CodeWarrior IDE frame)
 * and the separate debugger window ("S12 Studio Debugger", like hiwave.exe), opened by
 * Project > Debug. Both use in-window React menu bars; the native menu bar is hidden.
 *
 * Security: contextIsolation, sandbox, no nodeIntegration, navigation and window.open blocked, permission requests
 * denied, IPC accepted only from our own windows.
 */
import { BrowserWindow, dialog, screen, shell, app, type WebContents } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Domain, WindowKind } from '../shared/api';
import type { OpenDialogRequest, SaveDialogRequest } from '../shared/api/files';
import { EVENT_CHANNEL } from '../shared/ipc';
import type { WindowsPort } from './services';
import { fitToWorkArea, type MainFramePlacement } from './window-placement';

const here = dirname(fileURLToPath(import.meta.url));

export const DEBUGGER_TITLE = 'S12 Studio Debugger';
export const IDE_TITLE = 'S12 Studio';

/**
 * Window icon (Windows/Linux; macOS uses the bundle's .icns). Packaged: electron-builder extraResources copies
 * build/icon.png to <resources>/icon.png (Windows also has it in the .exe; Linux AppImage windows need it here).
 */
function windowIcon(): string | undefined {
  if (process.platform === 'darwin') return undefined;
  const p = app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(here, '../../build/icon.png');
  return existsSync(p) ? p : undefined;
}

interface Managed {
  kind: WindowKind;
  win: BrowserWindow;
  ready: boolean;
  queue: [Domain, string, unknown][];
  loaded: Promise<void>;
}

const MAX_QUEUE = 2000;
/** Latest-value events: while a window is loading only the newest one is queued. */
const COALESCED = new Set(['debug:snapshot', 'board:state', 'project:changed', 'settings:changed']);

export class WindowManager implements WindowsPort {
  private windows = new Map<number, Managed>();
  /** Open DevTools for every new window (--devtools). */
  devtools = false;
  /** Called when the last window closed. */
  onAllClosed: () => void = () => app.quit();
  /** Called when a File > Exit (quit()) was cancelled by the IDE window's "save changes?" guard. */
  onQuitCancelled: () => void = () => undefined;
  /** Called when a window closed (main ends the debug session with the debugger window). */
  onClosed: (kind: WindowKind) => void = () => undefined;

  /** Window kind of an IPC sender, or undefined when it is not one of ours. */
  kindOf(wc: WebContents): WindowKind | undefined {
    return this.windows.get(wc.id)?.kind;
  }

  private byKind(kind: WindowKind): Managed | undefined {
    for (const m of this.windows.values()) if (m.kind === kind && !m.win.isDestroyed()) return m;
    return undefined;
  }

  get ideWindow(): BrowserWindow | undefined {
    return this.byKind('ide')?.win;
  }

  get debuggerWindow(): BrowserWindow | undefined {
    return this.byKind('debugger')?.win;
  }

  /** Forward a bus event to windows (queued until the window's renderer called app.ready). */
  send(domain: Domain, event: string, payload: unknown, to?: WindowKind): void {
    for (const m of this.windows.values()) {
      if (to && m.kind !== to) continue;
      if (m.win.isDestroyed()) continue;
      if (!m.ready) {
        if (COALESCED.has(`${domain}:${event}`)) {
          const i = m.queue.findIndex(([d, e]) => d === domain && e === event);
          if (i >= 0) m.queue.splice(i, 1);
        }
        if (m.queue.length < MAX_QUEUE) m.queue.push([domain, event, payload]);
        continue;
      }
      m.win.webContents.send(EVENT_CHANNEL, domain, event, payload);
    }
  }

  rendererReady(senderId: number): void {
    const m = this.windows.get(senderId);
    if (!m) return;
    m.ready = true;
    const q = m.queue;
    m.queue = [];
    for (const [d, e, p] of q) m.win.webContents.send(EVENT_CHANNEL, d, e, p);
  }

  create(kind: WindowKind): Managed {
    const existing = this.byKind(kind);
    if (existing) return existing;
    const win = new BrowserWindow({
      width: kind === 'ide' ? 1200 : 1280,
      height: kind === 'ide' ? 800 : 860,
      minWidth: 480,
      minHeight: 320,
      title: kind === 'ide' ? IDE_TITLE : DEBUGGER_TITLE,
      backgroundColor: '#d4d0c8',
      icon: windowIcon(),
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(here, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    win.setMenuBarVisibility(false);
    const wc = win.webContents;
    // The debugger title has two spaces before the .ini path (ide.md §6); document.title collapses whitespace, so
    // main sets the native title (setDebuggerTitle) and ignores page title updates for that window.
    if (kind === 'debugger') win.on('page-title-updated', (e) => e.preventDefault());
    const id = wc.id;
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      if (url !== wc.getURL()) e.preventDefault();
    });
    win.once('ready-to-show', () => win.show());
    // the IDE's "save changes?" guard kept the window open: a pending File > Exit is cancelled (should the user then
    // confirm, the guard closes just the IDE window, like its close box)
    if (kind === 'ide')
      wc.on('will-prevent-unload', () => {
        if (!this.quitting) return;
        this.quitting = false;
        this.onQuitCancelled();
      });
    win.on('closed', () => {
      this.windows.delete(id);
      this.onClosed(kind);
      if (this.windows.size === 0) this.onAllClosed();
      else if (kind === 'ide' && this.quitting) {
        this.quitting = false;
        app.quit();
      }
    });
    const m: Managed = { kind, win, ready: false, queue: [], loaded: Promise.resolve() };
    this.windows.set(id, m);
    const page = kind === 'ide' ? 'ide' : 'debugger';
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    m.loaded = (devUrl ? win.loadURL(`${devUrl}/${page}/index.html`) : win.loadFile(join(here, `../renderer/${page}/index.html`))).catch((e: Error) => {
      console.error(`failed to load ${page} window: ${e.message}`);
    });
    if (this.devtools) wc.openDevTools({ mode: 'detach' });
    return m;
  }

  async openDebugger(): Promise<void> {
    const m = this.create('debugger');
    await m.loaded;
    if (!m.win.isVisible()) m.win.show();
    m.win.focus();
  }

  async focus(kind: WindowKind): Promise<void> {
    if (kind === 'debugger') return this.openDebugger();
    const m = this.create('ide');
    await m.loaded;
    m.win.show();
    m.win.focus();
  }

  private win(senderId: number): BrowserWindow | undefined {
    const m = this.windows.get(senderId);
    return m && !m.win.isDestroyed() ? m.win : undefined;
  }

  close(senderId: number): void {
    this.win(senderId)?.close();
  }

  minimize(senderId: number): void {
    this.win(senderId)?.minimize();
  }

  toggleMaximize(senderId: number): void {
    const w = this.win(senderId);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  }

  setTitle(senderId: number, title: string): void {
    this.win(senderId)?.setTitle(title);
  }

  /** Native debugger window title, verbatim (keeps the double space of "...Debugger  <ini path>"). */
  setDebuggerTitle(title: string): void {
    const w = this.debuggerWindow;
    if (w && !w.isDestroyed() && w.getTitle() !== title) w.setTitle(title);
  }

  private placed = new WeakSet<BrowserWindow>();

  /**
   * Apply the connection .ini's `[HI-WAVE] MainFrame=` placement to the debugger window, once per window (like
   * hiwave at startup; later sessions in the same window keep what the user did). Normal bounds are fitted to a
   * visible display, then the window is maximized when showCmd says so.
   */
  applyDebuggerPlacement(p: MainFramePlacement): void {
    const w = this.debuggerWindow;
    if (!w || w.isDestroyed() || this.placed.has(w)) return;
    this.placed.add(w);
    const areas = screen.getAllDisplays().map((d) => d.workArea);
    if (w.isMaximized()) w.unmaximize();
    w.setBounds(fitToWorkArea(p.normal, areas));
    if (p.maximized) w.maximize();
  }

  toggleDevTools(senderId: number): void {
    this.win(senderId)?.webContents.toggleDevTools();
  }

  /** File > Exit is in progress: the IDE window was asked to close; the rest follows once it has closed. */
  private quitting = false;

  /**
   * File > Exit: close the IDE window first and quit (closing the debugger window and its session) only once the IDE
   * window has really closed. app.quit() alone closes every window at once, so the unguarded debugger window (and
   * its simulation) was gone before a "save changes?" Cancel kept the IDE open.
   */
  quit(): void {
    const ide = this.byKind('ide');
    if (!ide) {
      app.quit();
      return;
    }
    this.quitting = true;
    ide.win.close();
  }

  async openExternal(url: string): Promise<void> {
    await shell.openExternal(url);
  }

  async showOpenDialog(senderId: number, req: OpenDialogRequest): Promise<string[]> {
    const props: ('openFile' | 'openDirectory' | 'multiSelections')[] = [req.directory ? 'openDirectory' : 'openFile'];
    if (req.multi) props.push('multiSelections');
    const opts = { title: req.title, defaultPath: req.defaultPath, filters: req.filters, properties: props };
    const parent = this.win(senderId);
    const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? [] : r.filePaths;
  }

  async showSaveDialog(senderId: number, req: SaveDialogRequest): Promise<string | null> {
    const opts = { title: req.title, defaultPath: req.defaultPath, filters: req.filters };
    const parent = this.win(senderId);
    const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
    return r.canceled || !r.filePath ? null : r.filePath;
  }

  reveal(path: string): void {
    shell.showItemInFolder(path);
  }
}
