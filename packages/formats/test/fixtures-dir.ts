/**
 * Where the private fixtures are (no Vitest import, so the globalSetup notice can use it too): $S12_FIXTURES (relative
 * to the repo root when relative), else <repo>/fixtures (rule in ./fixtures-locate.ts). Tests import these through
 * ./fixtures.ts.
 */
import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';
import { locateFixtures } from './fixtures-locate';

/** Repository root (this file is packages/formats/test/fixtures-dir.ts). */
export const REPO = fileURLToPath(new URL('../../../', import.meta.url));

const loc = locateFixtures(REPO);

/** Fixtures directory with a trailing separator: $S12_FIXTURES, else <repo>/fixtures. */
export const FIXTURES = loc.dir + sep;

/** True when the private fixtures are present (Lab3 and blank_project). */
export const hasFixtures = loc.present;

/** Why fixture-dependent tests are skipped (used in suite names and the one-time notice). */
export const NO_FIXTURES_REASON = loc.reason;
