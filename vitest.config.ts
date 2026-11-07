import { defineConfig } from 'vitest/config';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateSuite } from './packages/formats/test/fixtures-locate';

const REPO = fileURLToPath(new URL('.', import.meta.url));
const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));
const app = (p: string) => fileURLToPath(new URL(`./apps/ide/${p}`, import.meta.url));

/**
 * Private tests: the tests that spell out details of the private fixtures (Lab3 names, library code) live in the
 * private fixtures repo under tests/ (s12studio-fixtures: tests/<pkg>/*.test.ts). They run only when that repo is
 * checked out at <repo>/fixtures (their tsconfig extends ../../tsconfig.base.json); with S12_FIXTURES pointing
 * elsewhere the golden tests still run and the private tests are skipped with a notice. They import repo modules
 * through `@s12-repo/...`.
 */
const priv = privateSuite(REPO, 'tests');
if (priv.notice) console.warn(`[s12] ${priv.notice}`);
const privateDir = priv.dir ?? join(REPO, 'fixtures', 'tests');
export const PRIVATE_TESTS: string[] = priv.dir ? [`${priv.dir.replaceAll('\\', '/')}/**/*.test.{ts,tsx}`] : [];

export default defineConfig({
  resolve: {
    alias: {
      '@s12/formats': pkg('formats'),
      '@s12/asm': pkg('asm'),
      '@s12/link': pkg('link'),
      '@s12/sim': pkg('sim'),
      '@s12/debug': pkg('debug'),
      '@s12/hw': pkg('hw'),
      '@s12/project': pkg('project'),
      '@s12/devices': pkg('devices'),
      '@s12/isa': pkg('isa'),
      // apps/ide internal aliases (mirror apps/ide/electron.vite.config.ts)
      '@shared': app('src/shared'),
      '@common': app('src/renderer/common'),
      // repo root, for the private tests (e.g. '@s12-repo/packages/formats/test/fixtures')
      '@s12-repo': REPO.replace(/[\\/]$/, ''),
    },
  },
  // apps/ide .tsx tests: React 17+ automatic runtime
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tools/*/test/**/*.test.ts', 'apps/ide/src/**/*.test.{ts,tsx}', ...PRIVATE_TESTS],
    // renderer tests run in jsdom; main/worker/shared tests in node (private renderer tests: tests/ide/renderer/)
    environmentMatchGlobs: [
      ['apps/ide/src/renderer/**', 'jsdom'],
      [`${privateDir.replaceAll('\\', '/')}/ide/renderer/**`, 'jsdom'],
    ],
    // jest-dom matchers + RTL cleanup (only acts in jsdom files)
    setupFiles: [app('test/setup.ts')],
    // one notice when the private fixtures (S12_FIXTURES or <repo>/fixtures) are absent
    globalSetup: [fileURLToPath(new URL('./packages/formats/test/fixtures-notice.ts', import.meta.url))],
    testTimeout: 60000,
  },
});
