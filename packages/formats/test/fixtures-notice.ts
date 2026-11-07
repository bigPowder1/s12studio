/** Vitest globalSetup: say once, up front, when the private fixtures are absent (their tests are skipped). */
import { hasFixtures, NO_FIXTURES_REASON } from './fixtures-dir';

export default function setup(): void {
  if (!hasFixtures) console.warn(`\n[s12] ${NO_FIXTURES_REASON}: golden/Lab3 tests and the private tests (s12studio-fixtures tests/) are skipped; public tests still run.\n`);
}
