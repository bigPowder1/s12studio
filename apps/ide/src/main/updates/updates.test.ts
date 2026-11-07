import { describe, expect, it, vi } from 'vitest';
import type { UpdateNotice } from '../../shared/api/app';
import { compareVersions, newerRelease, parseGithubRepo, updateMode, type GithubRepo } from './policy';
import { UpdateService, type AutoUpdaterLike, type UpdateServiceDeps } from './update-service';

const REPO: GithubRepo = { owner: 'someone', repo: 's12studio' };

describe('parseGithubRepo', () => {
  it.each([
    ['someone/s12studio', REPO],
    ['github:someone/s12studio', REPO],
    ['https://github.com/someone/s12studio', REPO],
    ['https://github.com/someone/s12studio.git', REPO],
    ['git+https://github.com/someone/s12studio.git', REPO],
    ['git@github.com:someone/s12studio.git', REPO],
    [{ type: 'git', url: 'https://github.com/someone/s12studio.git' }, REPO],
  ])('%j', (field, want) => expect(parseGithubRepo(field)).toEqual(want));

  it('rejects the OWNER placeholder and non-GitHub values', () => {
    expect(parseGithubRepo('https://github.com/OWNER/s12studio.git')).toBeNull();
    expect(parseGithubRepo('OWNER/s12studio')).toBeNull();
    expect(parseGithubRepo('https://gitlab.com/a/b')).toBeNull();
    expect(parseGithubRepo(undefined)).toBeNull();
    expect(parseGithubRepo('')).toBeNull();
  });
});

describe('updateMode', () => {
  const base = { platform: 'win32', packaged: true, env: {}, repo: REPO };
  it('is off in development, E2E, with S12_NO_UPDATE=1 and without a repository', () => {
    expect(updateMode({ ...base, packaged: false }).mode).toBe('off');
    expect(updateMode({ ...base, env: { S12_NO_UPDATE: '1' } }).mode).toBe('off');
    expect(updateMode({ ...base, env: { S12_E2E: '1' } }).mode).toBe('off');
    expect(updateMode({ ...base, repo: null }).mode).toBe('off');
  });
  it('self-updates on Windows and AppImage; notifies on macOS and other Linux builds', () => {
    expect(updateMode(base).mode).toBe('auto');
    expect(updateMode({ ...base, platform: 'linux', env: { APPIMAGE: '/home/u/S12Studio.AppImage' } }).mode).toBe('auto');
    expect(updateMode({ ...base, platform: 'linux' }).mode).toBe('notify');
    expect(updateMode({ ...base, platform: 'darwin' }).mode).toBe('notify');
  });
});

describe('compareVersions', () => {
  it('orders by SemVer precedence', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
  });
});

describe('newerRelease', () => {
  it('reports only a newer, final release', () => {
    expect(newerRelease({ tag_name: 'v0.2.0', html_url: 'https://github.com/someone/s12studio/releases/tag/v0.2.0' }, '0.1.0', REPO)).toEqual({
      version: '0.2.0',
      url: 'https://github.com/someone/s12studio/releases/tag/v0.2.0',
    });
    expect(newerRelease({ tag_name: 'v0.1.0' }, '0.1.0', REPO)).toBeNull();
    expect(newerRelease({ tag_name: 'v0.0.9' }, '0.1.0', REPO)).toBeNull();
    expect(newerRelease({ tag_name: 'v0.3.0', prerelease: true }, '0.1.0', REPO)).toBeNull();
    expect(newerRelease({ tag_name: 'nightly' }, '0.1.0', REPO)).toBeNull();
    expect(newerRelease({ message: 'Not Found' }, '0.1.0', REPO)).toBeNull();
  });
  it('falls back to the releases page for a non-GitHub html_url', () => {
    expect(newerRelease({ tag_name: '0.2.0', html_url: 'javascript:alert(1)' }, '0.1.0', REPO)?.url).toBe('https://github.com/someone/s12studio/releases/latest');
  });
});

function fakeUpdater(): AutoUpdaterLike & { fire(ev: string, arg: unknown): void } {
  const handlers = new Map<string, (a: unknown) => void>();
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on(ev: string, fn: (a: never) => void) {
      handlers.set(ev, fn as (a: unknown) => void);
      return this;
    },
    checkForUpdates: vi.fn(async () => null),
    quitAndInstall: vi.fn(),
    fire: (ev, arg) => handlers.get(ev)?.(arg),
  } as AutoUpdaterLike & { fire(ev: string, arg: unknown): void };
}

function service(over: Partial<UpdateServiceDeps>) {
  const notices: UpdateNotice[] = [];
  const deps: UpdateServiceDeps = {
    mode: 'off',
    currentVersion: '0.1.0',
    repo: REPO,
    emit: (n) => notices.push(n),
    loadAutoUpdater: vi.fn(async () => fakeUpdater()),
    fetchJson: vi.fn(async () => ({})),
    quit: vi.fn(),
    log: vi.fn(),
    ...over,
  };
  return { svc: new UpdateService(deps), deps, notices };
}

describe('UpdateService', () => {
  it('does nothing when off', async () => {
    const { svc, deps, notices } = service({ mode: 'off' });
    await svc.check();
    expect(deps.loadAutoUpdater).not.toHaveBeenCalled();
    expect(deps.fetchJson).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it('auto: downloads in the background, notifies, restarts into the update only after a normal quit', async () => {
    const u = fakeUpdater();
    const { svc, deps, notices } = service({ mode: 'auto', loadAutoUpdater: async () => u });
    svc.requestRestart(); // nothing downloaded yet
    expect(deps.quit).not.toHaveBeenCalled();
    await svc.check();
    expect(u.autoDownload).toBe(true);
    expect(u.autoInstallOnAppQuit).toBe(true);
    expect(u.checkForUpdates).toHaveBeenCalledTimes(1);
    u.fire('update-downloaded', { version: '0.2.0' });
    expect(notices).toEqual([{ state: 'downloaded', version: '0.2.0' }]);
    expect(svc.notice).toEqual({ state: 'downloaded', version: '0.2.0' });

    svc.onWillQuit(); // a plain quit: electron-updater's install-on-quit handles it
    expect(u.quitAndInstall).not.toHaveBeenCalled();
    svc.requestRestart();
    expect(deps.quit).toHaveBeenCalledTimes(1);
    expect(u.quitAndInstall).not.toHaveBeenCalled(); // waits for the windows to agree to close
    svc.onWillQuit();
    expect(u.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('auto: a restart whose quit a window cancelled does not relaunch on a later quit', async () => {
    const u = fakeUpdater();
    const { svc, deps } = service({ mode: 'auto', loadAutoUpdater: async () => u });
    await svc.check();
    u.fire('update-downloaded', { version: '0.2.0' });
    svc.requestRestart();
    expect(deps.quit).toHaveBeenCalledTimes(1);
    svc.cancelRestart(); // "save changes?" -> Cancel kept the IDE window open (WindowManager.onQuitCancelled)
    svc.onWillQuit(); // the user closes the app later, on purpose
    expect(u.quitAndInstall).not.toHaveBeenCalled(); // autoInstallOnAppQuit installs silently, no relaunch
    // asking again still works
    svc.requestRestart();
    svc.onWillQuit();
    expect(u.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('auto: updater errors are logged, never thrown', async () => {
    const u = fakeUpdater();
    u.checkForUpdates = vi.fn(async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    });
    const { svc, deps, notices } = service({ mode: 'auto', loadAutoUpdater: async () => u });
    await expect(svc.check()).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('ERR_INTERNET_DISCONNECTED'));
    u.fire('error', new Error('bad signature'));
    expect(deps.log).toHaveBeenCalledWith('update error: bad signature');
    expect(notices).toEqual([]);
  });

  it('notify (macOS): asks the GitHub API and offers the release page', async () => {
    const fetchJson = vi.fn(async () => ({ tag_name: 'v0.3.0', html_url: 'https://github.com/someone/s12studio/releases/tag/v0.3.0' }));
    const { svc, deps, notices } = service({ mode: 'notify', fetchJson });
    await svc.check();
    expect(fetchJson).toHaveBeenCalledWith('https://api.github.com/repos/someone/s12studio/releases/latest');
    expect(deps.loadAutoUpdater).not.toHaveBeenCalled();
    expect(notices).toEqual([{ state: 'available', version: '0.3.0', url: 'https://github.com/someone/s12studio/releases/tag/v0.3.0' }]);
    svc.requestRestart(); // not a downloaded update: no quit
    expect(deps.quit).not.toHaveBeenCalled();
  });

  it('notify: up to date or offline -> no notice', async () => {
    const a = service({ mode: 'notify', fetchJson: async () => ({ tag_name: 'v0.1.0' }) });
    await a.svc.check();
    expect(a.notices).toEqual([]);
    const b = service({
      mode: 'notify',
      fetchJson: async () => {
        throw new Error('offline');
      },
    });
    await b.svc.check();
    expect(b.notices).toEqual([]);
    expect(b.deps.log).toHaveBeenCalled();
  });
});
