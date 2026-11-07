/**
 * Update policy (pure: no Electron imports, unit-tested).
 *
 * Release builds are published to GitHub Releases of ONE repository, configured in apps/ide/package.json
 * "repository" (CI overrides it with GITHUB_REPOSITORY; see electron-builder.config.cjs and docs/RELEASING.md).
 *   auto    Windows (NSIS) and Linux AppImage: electron-updater checks on startup, downloads in the background and
 *           installs on quit ("Version X downloaded - Restart to update" in the IDE status bar).
 *   notify  macOS (ad-hoc signed: Squirrel.Mac refuses to replace an app without a Developer ID signature) and Linux
 *           builds that are not an AppImage: ask the GitHub Releases API for the latest release and show
 *           "S12 Studio X is available - Download" (opens the release page).
 *   off     development runs, E2E runs, S12_NO_UPDATE=1, or no repository configured (the OWNER placeholder).
 */

export interface GithubRepo {
  owner: string;
  repo: string;
}

/** Placeholder owner used until the public repository exists (docs/RELEASING.md). */
export const PLACEHOLDER_OWNER = 'OWNER';

/**
 * Owner/repo from a package.json "repository" field (string or { url }), or a GITHUB_REPOSITORY-style "owner/repo".
 * Accepts "owner/repo", "github:owner/repo", "https://github.com/owner/repo(.git)", "git+https://...", "git@github.com:owner/repo.git".
 * Null for anything else, and for the OWNER placeholder.
 */
export function parseGithubRepo(field: unknown): GithubRepo | null {
  const raw = typeof field === 'string' ? field : field && typeof field === 'object' && typeof (field as { url?: unknown }).url === 'string' ? (field as { url: string }).url : '';
  const s = raw.trim();
  const m = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(s) ?? /^(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/]+@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(s) ?? /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s);
  if (!m) return null;
  const owner = m[1]!;
  const repo = m[2]!.replace(/\.git$/, '');
  if (owner === PLACEHOLDER_OWNER) return null;
  return { owner, repo };
}

export type UpdateMode = 'off' | 'auto' | 'notify';

export interface UpdateContext {
  platform: string;
  /** app.isPackaged */
  packaged: boolean;
  env: Readonly<Record<string, string | undefined>>;
  repo: GithubRepo | null;
}

export function updateMode(c: UpdateContext): { mode: UpdateMode; reason: string } {
  if (!c.packaged) return { mode: 'off', reason: 'development build' };
  if (c.env.S12_NO_UPDATE === '1') return { mode: 'off', reason: 'S12_NO_UPDATE=1' };
  if (c.env.S12_E2E === '1') return { mode: 'off', reason: 'E2E run' };
  if (!c.repo) return { mode: 'off', reason: 'no release repository configured' };
  if (c.platform === 'win32') return { mode: 'auto', reason: 'Windows installer (electron-updater)' };
  if (c.platform === 'linux' && c.env.APPIMAGE) return { mode: 'auto', reason: 'Linux AppImage (electron-updater)' };
  if (c.platform === 'darwin') return { mode: 'notify', reason: 'macOS ad-hoc signed build cannot self-update' };
  return { mode: 'notify', reason: `${c.platform} build without self-update` };
}

/** "v1.2.3-beta.1" -> comparable parts; null when not a version. */
function parseVersion(v: string): { nums: number[]; pre: string[] } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** SemVer precedence: negative if a < b, 0 if equal, positive if a > b. Unparseable versions compare as equal. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! - y.nums[i]!;
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) - (y.pre.length ? -1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export const latestReleaseApiUrl = (r: GithubRepo): string => `https://api.github.com/repos/${r.owner}/${r.repo}/releases/latest`;
export const releasesPageUrl = (r: GithubRepo): string => `https://github.com/${r.owner}/${r.repo}/releases/latest`;

/**
 * The GitHub "latest release" API answer -> { version, url } when it is newer than `current`, else null.
 * Drafts and prereleases are ignored (the API normally excludes them already).
 */
export function newerRelease(json: unknown, current: string, repo: GithubRepo): { version: string; url: string } | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
  if (r.draft === true || r.prerelease === true || typeof r.tag_name !== 'string') return null;
  const version = r.tag_name.replace(/^v/, '');
  if (!parseVersion(version) || compareVersions(version, current) <= 0) return null;
  const url = typeof r.html_url === 'string' && /^https:\/\/github\.com\//.test(r.html_url) ? r.html_url : releasesPageUrl(repo);
  return { version, url };
}
