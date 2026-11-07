/**
 * Repo root and private fixtures for jsdom tests (import.meta.url is not a file: URL under jsdom): walk up from the
 * cwd to the npm-workspaces root (package.json with "workspaces" next to vitest.config.ts). The fixtures are
 * $S12_FIXTURES, else <repo>/fixtures; gate tests that need them with `describe.skipIf(!hasFixtures)`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { locateFixtures } from '../../../../../../../packages/formats/test/fixtures-locate';

export function repoRoot(): string {
  let d = process.cwd();
  for (let i = 0; i < 8; i++) {
    const pkg = join(d, 'package.json');
    if (existsSync(pkg) && existsSync(join(d, 'vitest.config.ts')) && existsSync(join(d, 'packages'))) {
      try {
        if ((JSON.parse(readFileSync(pkg, 'utf8')) as { workspaces?: unknown }).workspaces) return d;
      } catch {
        // not the root; keep walking
      }
    }
    d = dirname(d);
  }
  throw new Error('repo root (npm workspaces package.json) not found from ' + process.cwd());
}

/** The private fixtures directory ($S12_FIXTURES, relative to the repo root when relative; else <repo>/fixtures). */
export function fixturesDir(): string {
  return locateFixtures(repoRoot()).dir;
}

/** True when the private fixtures (Lab3 and blank_project) are present (a boolean, like the other test helpers). */
export const hasFixtures: boolean = locateFixtures(repoRoot()).present;
