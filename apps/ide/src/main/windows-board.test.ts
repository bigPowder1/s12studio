// The ME3305 board window's pure rules: which debugger events it gets, and where a new board window opens.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, dialog: {}, screen: { getAllDisplays: () => [] }, shell: {} }));
const { boardPlacement, boardWantsEvent } = await import('./windows');

describe('board window events', () => {
  it('gets the board and session events of the debugger, not the debug snapshots', () => {
    expect(boardWantsEvent('board', 'state')).toBe(true);
    expect(boardWantsEvent('debug', 'session')).toBe(true);
    expect(boardWantsEvent('debug', 'engineError')).toBe(true);
    expect(boardWantsEvent('debug', 'snapshot')).toBe(false);
    expect(boardWantsEvent('debug', 'uiCommand')).toBe(false);
  });
});

describe('board window placement', () => {
  const screen1 = { x: 0, y: 0, width: 1920, height: 1040 };
  const debuggerWin = { x: 100, y: 50, width: 1280, height: 860 };

  it('first time: the top-right corner of the debugger window', () => {
    expect(boardPlacement(undefined, debuggerWin, [screen1])).toEqual({ x: 100 + 1280 - 640 - 24, y: 50 + 90, width: 640, height: 300 });
  });

  it('remembers where the student put it (even outside the debugger window)', () => {
    const saved = { x: 1300, y: 600, width: 500, height: 260 };
    expect(boardPlacement(saved, debuggerWin, [screen1])).toEqual(saved);
  });

  it('a remembered spot on a monitor that is gone falls back to the debugger corner', () => {
    const saved = { x: 2500, y: 100, width: 500, height: 260 };
    expect(boardPlacement(saved, debuggerWin, [screen1])).toEqual({ x: 716, y: 140, width: 640, height: 300 });
  });
});
