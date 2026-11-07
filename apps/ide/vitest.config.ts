/** `npm test -w @s12/ide`: the root Vitest config restricted to this app's tests (and the private ones under tests/ide/). */
import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vitest/config';
import base, { PRIVATE_TESTS } from '../../vitest.config';

const config = mergeConfig(base, { root: fileURLToPath(new URL('../..', import.meta.url)) });
config.test = { ...config.test, include: ['apps/ide/src/**/*.test.{ts,tsx}', ...PRIVATE_TESTS.map((g) => g.replace('/**/', '/ide/**/'))] };
export default config;
