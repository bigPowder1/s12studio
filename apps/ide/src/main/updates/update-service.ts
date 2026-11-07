/**
 * Update checks for packaged builds (policy in ./policy.ts). Electron-free: index.ts injects electron-updater's
 * autoUpdater loader, fetch and the event sink, so the decision logic runs under plain Node in tests.
 */
import type { UpdateNotice } from '../../shared/api/app';
import { latestReleaseApiUrl, newerRelease, type GithubRepo, type UpdateMode } from './policy';

/** The part of electron-updater's AppUpdater used here. */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'update-downloaded', fn: (info: { version: string }) => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateServiceDeps {
  mode: UpdateMode;
  currentVersion: string;
  repo: GithubRepo | null;
  /** Deliver a notice to the IDE window. */
  emit(notice: UpdateNotice): void;
  /** Load electron-updater (lazy: only packaged Windows/AppImage builds pay for it). */
  loadAutoUpdater(): Promise<AutoUpdaterLike>;
  /** GET a JSON document (GitHub API). */
  fetchJson(url: string): Promise<unknown>;
  /** Quit the app the normal way (windows get their "save changes?" prompts and may cancel). */
  quit(): void;
  log?(message: string): void;
}

export class UpdateService {
  private updater: AutoUpdaterLike | null = null;
  private current: UpdateNotice | null = null;
  private restartRequested = false;

  constructor(private readonly d: UpdateServiceDeps) {}

  get mode(): UpdateMode {
    return this.d.mode;
  }

  /** Latest notice sent (null: none). */
  get notice(): UpdateNotice | null {
    return this.current;
  }

  /** Check once (startup). Never throws: update problems are logged, not shown. */
  async check(): Promise<void> {
    try {
      if (this.d.mode === 'auto') await this.checkAuto();
      else if (this.d.mode === 'notify') await this.checkNotify();
    } catch (e) {
      this.d.log?.(`update check failed: ${(e as Error).message}`);
    }
  }

  private async checkAuto(): Promise<void> {
    if (!this.updater) {
      const u = await this.d.loadAutoUpdater();
      u.autoDownload = true;
      u.autoInstallOnAppQuit = true;
      u.on('update-downloaded', (info) => this.send({ state: 'downloaded', version: String(info.version).replace(/^v/, '') }));
      u.on('error', (err) => this.d.log?.(`update error: ${err.message}`));
      this.updater = u;
    }
    await this.updater.checkForUpdates();
  }

  private async checkNotify(): Promise<void> {
    if (!this.d.repo) return;
    const found = newerRelease(await this.d.fetchJson(latestReleaseApiUrl(this.d.repo)), this.d.currentVersion, this.d.repo);
    if (found) this.send({ state: 'available', version: found.version, url: found.url });
    else this.d.log?.(`update: ${this.d.currentVersion} is the latest release`);
  }

  private send(n: UpdateNotice): void {
    this.d.log?.(`update ${n.state}: ${n.version}${n.url ? ` ${n.url}` : ''}`);
    this.current = n;
    this.d.emit(n);
  }

  /**
   * "Restart to update": quit normally; the install runs from onWillQuit once every window agreed to close. The IDE
   * asks "save changes?" before it calls this (like File > Exit); should a window still keep itself open, main calls
   * cancelRestart() and the update stays queued for a silent install on the next quit (no relaunch).
   */
  requestRestart(): void {
    if (this.current?.state !== 'downloaded' || !this.updater) return;
    this.restartRequested = true;
    this.d.quit();
  }

  /** The quit started by requestRestart() was cancelled (a window kept itself open): a later quit must not relaunch. */
  cancelRestart(): void {
    if (this.restartRequested) this.d.log?.('update: restart cancelled; installs on the next quit');
    this.restartRequested = false;
  }

  /** App 'will-quit'. Without a restart request electron-updater's autoInstallOnAppQuit installs silently. */
  onWillQuit(): void {
    if (this.restartRequested && this.updater) {
      this.restartRequested = false;
      this.updater.quitAndInstall(true, true);
    }
  }
}
