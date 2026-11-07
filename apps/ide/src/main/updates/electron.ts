/** Electron wiring of the UpdateService (policy: ./policy.ts). */
import { app, net } from 'electron';
import type { UpdateNotice } from '../../shared/api/app';
import { parseGithubRepo, updateMode } from './policy';
import { UpdateService, type AutoUpdaterLike } from './update-service';

/**
 * Environment:
 *   S12_NO_UPDATE=1           never check for updates
 *   S12_UPDATE_REPO=owner/repo   override the package.json "repository" (testing a fork's releases)
 */
export function createUpdateService(opts: { repository: unknown; emit(n: UpdateNotice): void; quit(): void }): UpdateService {
  const repo = parseGithubRepo(process.env.S12_UPDATE_REPO || opts.repository);
  const { mode, reason } = updateMode({ platform: process.platform, packaged: app.isPackaged, env: process.env, repo });
  if (app.isPackaged) console.log(`updates: ${mode} (${reason})`);
  return new UpdateService({
    mode,
    currentVersion: app.getVersion(),
    repo,
    emit: opts.emit,
    quit: opts.quit,
    log: (m) => console.log(m),
    loadAutoUpdater: async () => {
      // the feed is the same repository as the notify path (package.json "repository" / S12_UPDATE_REPO), not only
      // the app-update.yml electron-builder wrote
      // CommonJS package: the namespace's default export is module.exports
      const m = (await import('electron-updater')) as unknown as { autoUpdater?: unknown; default?: { autoUpdater?: unknown } };
      const u = (m.autoUpdater ?? m.default?.autoUpdater) as (AutoUpdaterLike & { logger?: unknown }) | undefined;
      if (!u) throw new Error('electron-updater has no autoUpdater');
      u.logger = null; // our own log line per error is enough
      if (repo) (u as unknown as { setFeedURL(o: object): void }).setFeedURL({ provider: 'github', owner: repo.owner, repo: repo.repo });
      return u;
    },
    fetchJson: async (url) => {
      const r = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `S12Studio/${app.getVersion()}` } });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return (await r.json()) as unknown;
    },
  });
}
