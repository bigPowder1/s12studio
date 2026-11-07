import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_METHODS, parseApiError } from '../../shared/api';
import { BuildService } from '../engine/build-service';
import { DebugHost } from '../engine/debug-host';
import { FileWatchers } from '../engine/file-watchers';
import { ProjectService } from '../engine/project-service';
import { SettingsStore } from '../engine/settings-store';
import { DEFAULT_OPEN_FILTERS, TextFiles } from '../engine/text-files';
import { EventBus } from '../events';
import type { MainServices, WindowsPort } from '../services';
import { createRouter } from './index';

function services(): MainServices & { calls: unknown[][] } {
  const bus = new EventBus();
  const projects = new ProjectService(bus);
  const calls: unknown[][] = [];
  const windows = new Proxy({} as WindowsPort, { get: (_t, k) => (...a: unknown[]) => (calls.push([k, ...a]), Promise.resolve(k === 'showOpenDialog' ? ['/x.mcp'] : undefined)) });
  const debug = new DebugHost(bus, () => {
    throw new Error('no worker in this test');
  });
  return {
    bus,
    projects,
    builds: new BuildService(bus, projects),
    debug,
    settings: new SettingsStore(join(mkdtempSync(join(tmpdir(), 's12ide-set-')), 'settings.json'), bus),
    watchers: new FileWatchers(bus),
    textFiles: new TextFiles(),
    windows,
    meta: { name: 'S12 Studio', version: '0', platform: 'test', electron: '0', e2e: false },
    calls,
  };
}

describe('IPC router', () => {
  it('registers a handler for every contract method', () => {
    const r = createRouter(services());
    expect(r.missing()).toEqual([]);
    const total = Object.values(API_METHODS).reduce((n, m) => n + m.length, 0);
    expect(r.channels()).toHaveLength(total);
  });

  it('validates arguments before running handlers', async () => {
    const s = services();
    const r = createRouter(s);
    await expect(r.call('debug', 'writeRegister', ['PC', 0x10000])).rejects.toThrow(/^\[invalid-argument\] debug\.writeRegister#1/);
    await expect(r.call('debug', 'writeRegister', ['ZZ', 1])).rejects.toThrow(/invalid-argument/);
    await expect(r.call('files', 'openDialog', [{ title: 'x', evil: true }])).rejects.toThrow(/unexpected field/);
    await expect(r.call('app', 'openExternal', ['file:///etc/passwd'])).rejects.toThrow(/invalid-argument/);
    expect(await r.call('files', 'openDialog', [{ title: 'Open' }])).toEqual(['/x.mcp']);
    expect(s.calls[0]).toEqual(['showOpenDialog', -1, { title: 'Open', filters: DEFAULT_OPEN_FILTERS }]);
  });

  it('maps service errors to [code] messages the renderer can parse', async () => {
    const r = createRouter(services());
    const e = await r.call('project', 'reload').catch((x: unknown) => x);
    expect(parseApiError(e)).toEqual({ code: 'no-project', message: 'no project is open' });
    expect(parseApiError(new Error("Error invoking remote method 's12:project.reload': Error: [no-project] no project is open"))).toEqual({ code: 'no-project', message: 'no project is open' });
  });

  it('app.info reports the calling window kind; settings round-trip', async () => {
    const r = createRouter(services());
    expect(await r.call('app', 'info', [], { windowKind: 'debugger', senderId: 3 })).toMatchObject({ name: 'S12 Studio', windowKind: 'debugger' });
    const st = (await r.call('settings', 'update', [{ debugger: { snapshotHz: 60 } }])) as { debugger: { snapshotHz: number; pacing: string } };
    expect(st.debugger).toMatchObject({ snapshotHz: 60, pacing: 'true-time' });
  });

  it('layout.defaultLayout parses the built-in hwl', async () => {
    const r = createRouter(services());
    const l = (await r.call('layout', 'defaultLayout')) as { windows: { component: string }[] };
    expect(l.windows.map((w) => w.component)).toEqual(['source', 'assembly', 'register', 'procedure', 'memory', 'data', 'command']);
  });

  it('layout.write only writes .hwl files', async () => {
    const r = createRouter(services());
    const l = await r.call('layout', 'defaultLayout');
    await expect(r.call('layout', 'write', ['/tmp/not-a-layout/main.asm', l])).rejects.toThrow(/invalid-argument/);
  });
});
