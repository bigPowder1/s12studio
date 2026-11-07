/**
 * The ONE rule for finding the private fixtures, shared by every test helper (packages, app unit tests, jsdom tests,
 * Playwright harness). Pure Node (no Vitest, no import.meta), so any of them can import it:
 *   - $S12_FIXTURES if set (a relative value is taken relative to the repo root, whatever the cwd), else <repo>/fixtures;
 *   - present when both Lab3/Lab3.mcp and blank_project/blank_project.mcp exist there.
 * The private tests and specs inside the fixtures repo (tests/, e2e/) additionally need it at <repo>/fixtures: their
 * tsconfig extends ../../tsconfig.base.json and the specs import ../../apps/ide/e2e/harness (privateSuite()).
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface FixturesLocation {
  /** Absolute fixtures directory (no trailing separator). */
  dir: string;
  /** True when the private fixtures (Lab3 and blank_project) are present. */
  present: boolean;
  /** Why fixture-dependent tests are skipped (suite names, notices). */
  reason: string;
}

export function locateFixtures(repoRoot: string, env: string | undefined = process.env.S12_FIXTURES): FixturesLocation {
  const dir = resolve(repoRoot, env || 'fixtures');
  const present = existsSync(join(dir, 'Lab3', 'Lab3.mcp')) && existsSync(join(dir, 'blank_project', 'blank_project.mcp'));
  return { dir, present, reason: `private fixtures not found at ${dir} (check out s12studio-fixtures there or set S12_FIXTURES)` };
}

export interface PrivateSuite {
  /** Absolute directory of the private suite (e.g. <repo>/fixtures/tests), or null when it does not run. */
  dir: string | null;
  /** Why a present suite is skipped (fixtures outside <repo>/fixtures), else ''. */
  notice: string;
}

/** The private suite `sub` (tests, e2e) of the fixtures repo: it runs only from <repo>/fixtures/<sub>. */
export function privateSuite(repoRoot: string, sub: string, loc: FixturesLocation = locateFixtures(repoRoot)): PrivateSuite {
  const dir = join(loc.dir, sub);
  if (!loc.present || !existsSync(dir)) return { dir: null, notice: '' };
  if (resolve(loc.dir) !== resolve(repoRoot, 'fixtures')) {
    return { dir: null, notice: `private ${sub} in ${dir} skipped: they run only from ${join(resolve(repoRoot), 'fixtures', sub)} (they use paths relative to the repo)` };
  }
  return { dir, notice: '' };
}
