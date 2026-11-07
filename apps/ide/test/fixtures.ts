/**
 * The private CodeWarrior fixtures for app tests (node environment): $S12_FIXTURES, else <repo>/fixtures. Tests that
 * need them are gated with `describeFx` / `itFx` (skipped with a reason when the private fixtures are absent).
 * Tests get temp copies (never write next to fixtures/). jsdom tests use src/renderer/common/monaco/testing/repo.ts.
 */
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { locateFixtures } from '../../../packages/formats/test/fixtures-locate';

export const REPO = fileURLToPath(new URL('../../..', import.meta.url));

const loc = locateFixtures(REPO);

/** Fixtures directory (no trailing separator). */
export const FIXTURES = loc.dir;

/** True when the private fixtures (Lab3 and blank_project) are present. */
export const hasFixtures = loc.present;

/**
 * `describe` that runs only when the private fixtures are present. Without them its body is NOT run (it may read
 * fixtures while collecting); one skipped placeholder test carries the reason instead.
 */
export const describeFx = (name: string, fn: () => void): void => {
  if (hasFixtures) describe(name, fn);
  else describe.skip(`${name} [needs private fixtures]`, () => it(loc.reason, () => {}));
};

/** `it` skipped when the private fixtures are absent. */
export const itFx = hasFixtures ? it : it.skip;

export function copyFixture(name: 'Lab3' | 'blank_project'): { dir: string; dispose: () => void } {
  const base = mkdtempSync(join(tmpdir(), `s12ide-${name}-`));
  const dir = join(base, name);
  // keep the fixtures' modification times (CodeWarrior's outputs are newer than the sources, like on a lab PC)
  cpSync(join(FIXTURES, name), dir, { recursive: true, preserveTimestamps: true });
  return { dir, dispose: () => rmSync(base, { recursive: true, force: true }) };
}

/** Temp copy of a public example project (examples/<name>), e.g. 'blinky'. */
export function copyExample(name: string): { dir: string; dispose: () => void } {
  const base = mkdtempSync(join(tmpdir(), `s12ide-${name}-`));
  const dir = join(base, name);
  cpSync(join(REPO, 'examples', name), dir, { recursive: true, preserveTimestamps: true });
  return { dir, dispose: () => rmSync(base, { recursive: true, force: true }) };
}
