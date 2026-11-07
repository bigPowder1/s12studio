import { defineConfig } from '@playwright/test';
import { privateSuite } from '../../../packages/formats/test/fixtures-locate';
import { repoDir } from '../scripts/env.mjs';

/**
 * Specs that spell out details of the private fixtures (Lab3 names, LCD texts, library behaviour) live in the private
 * fixtures repo (s12studio-fixtures: e2e/*.spec.ts). They run as the extra 'private' project only when that repo is
 * checked out at <repo>/fixtures (they import ../../apps/ide/e2e/harness); with S12_FIXTURES pointing elsewhere the
 * public specs run alone and a notice says why.
 */
const priv = privateSuite(repoDir, 'e2e');
if (priv.notice) console.warn(`[s12] ${priv.notice}`);

export default defineConfig({
  testMatch: /.*\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: '../test-results/e2e',
  projects: [{ name: 'public', testDir: '.' }, ...(priv.dir ? [{ name: 'private', testDir: priv.dir }] : [])],
});
