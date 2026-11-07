/** Engine-track handler wiring: settings pacing -> running session, File > Open default filters, EOL-preserving writes. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildService } from '../engine/build-service';
import type { DebugHost } from '../engine/debug-host';
import { FileWatchers } from '../engine/file-watchers';
import { ProjectService } from '../engine/project-service';
import { SettingsStore } from '../engine/settings-store';
import { DEFAULT_OPEN_FILTERS, TextFiles } from '../engine/text-files';
import { EventBus } from '../events';
import type { MainServices, WindowsPort } from '../services';
import { createRouter } from './index';
import { encodeError } from './router';
import { ApiError } from '../../shared/api/common';

function services(debugRunning: boolean) {
  const bus = new EventBus();
  const projects = new ProjectService(bus);
  const dialogs: unknown[] = [];
  const debugCalls: unknown[][] = [];
  const windows = new Proxy({} as WindowsPort, {
    get: (_t, k) => (...a: unknown[]) => {
      if (k === 'showOpenDialog') dialogs.push(a[1]);
      return Promise.resolve(k === 'showOpenDialog' ? [] : undefined);
    },
  });
  const debug = { running: debugRunning, call: async (m: string, a: unknown[]) => void debugCalls.push([m, ...a]) } as unknown as DebugHost;
  const s: MainServices = {
    bus,
    projects,
    builds: new BuildService(bus, projects),
    debug,
    settings: new SettingsStore(join(mkdtempSync(join(tmpdir(), 's12ide-eh-')), 'settings.json'), bus),
    watchers: new FileWatchers(bus),
    textFiles: new TextFiles(),
    windows,
    meta: { name: 'S12 Studio', version: '0', platform: 'test', electron: '0', e2e: false },
  };
  return { s, router: createRouter(s), dialogs, debugCalls };
}

describe('engine handler wiring', () => {
  it('settings.update with a pacing change re-paces the running session', async () => {
    const { router, debugCalls } = services(true);
    await router.call('settings', 'update', [{ debugger: { pacing: 'max' } }]);
    expect(debugCalls).toEqual([['debug.setPacing', 'max', 1]]);
    await router.call('settings', 'update', [{ editor: { fontSize: 14 } }]);
    expect(debugCalls).toHaveLength(1);
  });

  it('no session: settings change does not start the engine', async () => {
    const { router, debugCalls } = services(false);
    await router.call('settings', 'update', [{ debugger: { speedFactor: 2 } }]);
    expect(debugCalls).toEqual([]);
  });

  it('files.openDialog without filters uses the CodeWarrior file kinds; explicit filters are kept', async () => {
    const { router, dialogs } = services(false);
    await router.call('files', 'openDialog', [{ title: 'Open' }]);
    await router.call('files', 'openDialog', [{ filters: [{ name: 'Asm', extensions: ['asm'] }] }]);
    await router.call('files', 'openDialog', [{ directory: true }]);
    expect((dialogs[0] as { filters: unknown }).filters).toEqual(DEFAULT_OPEN_FILTERS);
    expect((dialogs[1] as { filters: unknown }).filters).toEqual([{ name: 'Asm', extensions: ['asm'] }]);
    expect((dialogs[2] as { filters?: unknown }).filters).toBeUndefined();
  });

  it('files.readText + writeText round-trip keeps an LF file LF and a CRLF file CRLF', async () => {
    const { router } = services(false);
    const dir = mkdtempSync(join(tmpdir(), 's12ide-eh-txt-'));
    const lf = join(dir, 'a.inc');
    const crlf = join(dir, 'b.asm');
    writeFileSync(lf, 'x\ny\n');
    writeFileSync(crlf, 'x\r\ny\r\n');
    for (const p of [lf, crlf]) {
      const f = (await router.call('files', 'readText', [p])) as { text: string };
      await router.call('files', 'writeText', [{ path: p, text: f.text + 'z\n' }]);
    }
    expect(readFileSync(lf, 'utf8')).toBe('x\ny\nz\n');
    expect(readFileSync(crlf, 'utf8')).toBe('x\r\ny\r\nz\r\n');
  });

  it('files.writeText accepts an explicit encoding; board.setPin accepts PAD08-style pins and rejects junk', async () => {
    const { router, debugCalls } = services(true);
    const dir = mkdtempSync(join(tmpdir(), 's12ide-eh-enc-'));
    const p = join(dir, 'u.asm');
    await router.call('files', 'writeText', [{ path: p, text: '; →\n', encoding: 'utf-8' }]);
    expect(readFileSync(p, 'utf8')).toBe('; →\r\n');
    await expect(router.call('files', 'writeText', [{ path: p, text: 'x', encoding: 'utf-16' }])).rejects.toThrow(/^\[invalid-argument\]/);
    await router.call('board', 'setPin', ['PAD08', 1], { windowKind: 'debugger', senderId: 1 });
    await router.call('board', 'setPin', ['PT0', null], { windowKind: 'debugger', senderId: 1 });
    expect(debugCalls).toEqual([
      ['board.setPin', 'PAD08', 1],
      ['board.setPin', 'PT0', null],
    ]);
    for (const bad of ['PAD8', 'PADX1', 'P0', 'pt0x']) await expect(router.call('board', 'setPin', [bad, 1], { windowKind: 'debugger', senderId: 1 })).rejects.toThrow(/^\[invalid-argument\]/);
  });

  it('expected API errors carry a one-line stack (Electron logs rejected handlers with the stack); internal ones keep it', () => {
    const nf = encodeError(new ApiError('not-found', 'source library.dbg not found'));
    expect(nf.message).toBe('[not-found] source library.dbg not found');
    expect(nf.stack).toBe('Error: [not-found] source library.dbg not found');
    const internal = encodeError(new Error('boom'));
    expect(internal.message).toBe('[internal] boom');
    expect(internal.stack!.split('\n').length).toBeGreaterThan(1);
  });
});
