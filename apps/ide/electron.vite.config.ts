/**
 * electron-vite build of S12 Studio.
 *   out/main/index.js          main process (ESM)
 *   out/main/debug-worker.js   debug engine worker thread (ESM, same bundle graph as main)
 *   out/preload/index.cjs      sandboxed preload (must be CommonJS)
 *   out/renderer/{ide,debugger}/index.html   the two windows
 * The @s12/* engine packages are TypeScript sources resolved through aliases (mirrors tsconfig.base.json paths)
 * and bundled; nothing else from node_modules is needed by main.
 */
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const ENGINE = ['formats', 'asm', 'link', 'sim', 'debug', 'hw', 'project', 'devices', 'isa'];

/** @s12/<pkg> -> packages/<pkg>/src/index.ts, plus the app-internal aliases. */
export const alias: Record<string, string> = {
  ...Object.fromEntries(ENGINE.map((p) => [`@s12/${p}`, r(`../../packages/${p}/src/index.ts`)])),
  '@shared': r('./src/shared'),
  '@common': r('./src/renderer/common'),
};

/**
 * Dev server only: @vitejs/plugin-react injects an inline React Refresh preamble, which the production CSP
 * (script-src 'self') would block. Production builds keep the strict CSP from the HTML files.
 */
const devCsp: Plugin = {
  name: 's12-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ENGINE.map((p) => `@s12/${p}`) })],
    resolve: { alias },
    build: {
      outDir: 'out/main',
      sourcemap: true,
      rollupOptions: {
        input: { index: r('./src/main/index.ts'), 'debug-worker': r('./src/worker/debug-worker.ts') },
        output: { format: 'es', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      outDir: 'out/preload',
      sourcemap: true,
      rollupOptions: {
        input: { index: r('./src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: r('./src/renderer'),
    plugins: [react(), devCsp],
    resolve: { alias },
    worker: { format: 'es' },
    build: {
      outDir: r('./out/renderer'),
      sourcemap: true,
      chunkSizeWarningLimit: 8000,
      minify: process.env.S12_NO_MINIFY ? false : 'esbuild',
      rollupOptions: {
        input: { ide: r('./src/renderer/ide/index.html'), debugger: r('./src/renderer/debugger/index.html') },
      },
    },
  },
});
