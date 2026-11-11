/**
 * The private CodeWarrior fixtures (Lab3 and blank_project with CodeWarrior's golden outputs, the ME3305 library).
 * They live in a separate private repo checked out at `<repo>/fixtures`, or wherever `S12_FIXTURES` points.
 * Every package's tests resolve them through this module; fixture-dependent tests are skipped when they are absent:
 *
 *   describe.skipIf(!hasFixtures)('golden ...', () => { ... });   // or itFx / describeFx below
 *
 * Without fixtures `describeFx` does not run its body, but module-level reads in test files (and `describe.each`
 * tables, `itFx` in plain suites) must stay lazy or be guarded by `hasFixtures`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';

export { REPO, FIXTURES, hasFixtures, NO_FIXTURES_REASON } from './fixtures-dir';
import { FIXTURES, hasFixtures, NO_FIXTURES_REASON } from './fixtures-dir';

/**
 * `describe` that runs only when the private fixtures are present. Without them its body is NOT run (it may read
 * fixtures while collecting); one skipped placeholder test carries the reason instead.
 */
export const describeFx = (name: string, fn: () => void): void => {
  if (hasFixtures) describe(name, fn);
  else describe.skip(`${name} [needs private fixtures]`, () => it(NO_FIXTURES_REASON, () => {}));
};

/** `it` that is skipped when the fixtures are absent. */
export const itFx = hasFixtures ? it : it.skip;

export const fixture = (...p: string[]) => join(FIXTURES, ...p);
export const readFixture = (...p: string[]) => readFileSync(fixture(...p));
