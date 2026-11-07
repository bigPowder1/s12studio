/**
 * File > Exit (WindowManager.quit) closes the IDE window first and quits only once it has closed, so a "save
 * changes?" Cancel in the IDE keeps the debugger window and its session (m6c-verify major finding).
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ log: [] as string[], wins: [] as unknown[], quit: (): void => undefined }));

vi.mock('electron', async () => {
  const { EventEmitter: EE } = await import('node:events');
  let nextId = 1;
  class FakeWebContents extends EE {
    id = nextId++;
    setWindowOpenHandler(): void {}
    getURL(): string {
      return '';
    }
    send(): void {}
    openDevTools(): void {}
  }
  class FakeWindow extends EE {
    webContents = new FakeWebContents();
    destroyed = false;
    /** The renderer's beforeunload guard: true = it prevents the unload (a "save changes?" prompt is shown). */
    guard = false;
    title: string;
    constructor(o: { title: string }) {
      super();
      this.title = o.title;
      h.wins.push(this);
    }
    setMenuBarVisibility(): void {}
    loadFile(): Promise<void> {
      return Promise.resolve();
    }
    loadURL(): Promise<void> {
      return Promise.resolve();
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    show(): void {}
    close(): void {
      if (this.destroyed) return;
      if (this.guard) {
        h.log.push(`prevented ${this.title}`);
        this.webContents.emit('will-prevent-unload', { preventDefault() {} });
        return;
      }
      this.destroyed = true;
      h.log.push(`closed ${this.title}`);
      this.emit('closed');
    }
  }
  return {
    BrowserWindow: FakeWindow,
    app: { quit: () => h.quit() },
    dialog: {},
    screen: { getAllDisplays: () => [] },
    shell: {},
  };
});

const { WindowManager, IDE_TITLE, DEBUGGER_TITLE } = await import('./windows');

interface Fake extends EventEmitter {
  title: string;
  guard: boolean;
  destroyed: boolean;
  close(): void;
}

function setup() {
  h.log.length = 0;
  h.wins.length = 0;
  const wm = new WindowManager();
  wm.onAllClosed = () => h.log.push('all closed');
  wm.onClosed = (k) => h.log.push(`onClosed ${k}`);
  wm.create('ide');
  wm.create('debugger');
  const [ide, dbg] = h.wins as Fake[];
  // app.quit closes every remaining window (Electron)
  h.quit = () => {
    h.log.push('app.quit');
    for (const w of h.wins as Fake[]) w.close();
  };
  return { wm, ide: ide!, dbg: dbg! };
}

describe('WindowManager.quit (File > Exit)', () => {
  beforeEach(() => {
    h.quit = () => undefined;
  });

  it('closes the IDE window first, then quits (closing the debugger)', () => {
    const { wm } = setup();
    wm.quit();
    expect(h.log).toEqual([`closed ${IDE_TITLE}`, 'onClosed ide', 'app.quit', `closed ${DEBUGGER_TITLE}`, 'onClosed debugger', 'all closed']);
  });

  it('a "save changes?" Cancel in the IDE keeps the debugger window open and does not quit', () => {
    const { wm, ide, dbg } = setup();
    ide.guard = true;
    wm.quit();
    expect(h.log).toEqual([`prevented ${IDE_TITLE}`]);
    expect(dbg.destroyed).toBe(false);
    expect(wm.debuggerWindow).toBeDefined();
    // later the user closes just the IDE window (close box / the guard after Don't Save): no stale quit
    ide.guard = false;
    ide.close();
    expect(h.log).not.toContain('app.quit');
    expect(dbg.destroyed).toBe(false);
  });

  it('reports a cancelled File > Exit once (onQuitCancelled: "Restart to update" must not relaunch later)', () => {
    const { wm, ide } = setup();
    const cancelled: string[] = [];
    wm.onQuitCancelled = () => cancelled.push('cancelled');
    ide.guard = true;
    ide.close(); // close box with unsaved changes: no File > Exit pending, nothing to cancel
    expect(cancelled).toEqual([]);
    wm.quit();
    expect(cancelled).toEqual(['cancelled']);
  });

  it('quits directly when there is no IDE window', () => {
    const { wm, ide } = setup();
    ide.close();
    h.log.length = 0;
    wm.quit();
    expect(h.log[0]).toBe('app.quit');
  });
});
