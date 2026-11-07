/**
 * Vitest setup for apps/ide component tests. Runs for every test file in the repo (root config), but only does
 * anything in jsdom files (src/renderer/**): jest-dom matchers + React Testing Library cleanup.
 */
import { afterEach, expect } from 'vitest';

const g = globalThis as { window?: unknown; document?: unknown };
if (g.window !== undefined && g.document !== undefined) {
  const matchers = await import('@testing-library/jest-dom/matchers');
  expect.extend(matchers.default ?? matchers);
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => cleanup());
}
