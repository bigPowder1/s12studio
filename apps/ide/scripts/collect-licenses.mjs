#!/usr/bin/env node
/**
 * Licence texts for the installers (run by the dist scripts after `electron-vite build`):
 *
 *   resources/licenses/LICENSE.txt                 S12 Studio (Apache-2.0)      <- <repo>/LICENSE
 *   resources/licenses/NOTICE.txt                  Apache-2.0 section 4 NOTICE  <- <repo>/NOTICE
 *   resources/licenses/THIRD_PARTY_NOTICES.md                                    <- <repo>/THIRD_PARTY_NOTICES.md
 *   resources/licenses/THIRD_PARTY_LICENSES.txt    every npm package bundled into out/ (found through the build's
 *                                                  sourcemaps) plus the runtime dependencies shipped in app.asar
 *                                                  (electron-updater and its closure), with their licence files
 *
 * electron-builder ships resources/licenses as <resources>/licenses (extraResources; Electron's own LICENSE.electron.txt
 * and LICENSES.chromium.html are added by electron-builder). The folder is generated: gitignored (resources/.gitignore).
 * Exits 1 when out/ has no sourcemaps (the bundled set would be unknown) or a package has neither a licence file nor
 * a "license" field.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(appDir, '../..');
const outDir = join(appDir, 'out');
const dest = join(appDir, 'resources', 'licenses');

const LICENSE_FILE = /^(licen[cs]e|copying|notice|thirdpartynotices)([.-].*)?$/i;

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, files);
    else files.push(p);
  }
  return files;
}

/**
 * Package root of a sourcemap source inside node_modules. The path itself when it exists, else the package name
 * resolved from apps/ide (some bundler-generated maps, e.g. Vite's worker chunks, use a different base directory).
 */
function packageRootOf(file) {
  const parts = file.split(/[\\/]/);
  const i = parts.lastIndexOf('node_modules');
  if (i < 0) return null;
  const n = parts[i + 1]?.startsWith('@') ? 2 : 1;
  const root = parts.slice(0, i + 1 + n).join(sep);
  if (existsSync(join(root, 'package.json'))) return root;
  const name = parts.slice(i + 1, i + 1 + n).join('/');
  const found = resolvePackage(name, appDir);
  if (!found) throw new Error(`bundled package ${name} is not installed`);
  return found;
}

/** Packages bundled into out/ according to the sourcemaps. */
function bundledPackages() {
  if (!existsSync(outDir)) throw new Error(`${relative(repoDir, outDir)} is missing: run electron-vite build first`);
  const maps = walk(outDir).filter((f) => f.endsWith('.map'));
  if (maps.length === 0) throw new Error('no sourcemaps in out/: cannot tell which npm packages are bundled');
  const roots = new Set();
  for (const m of maps) {
    const map = JSON.parse(readFileSync(m, 'utf8'));
    const base = resolve(dirname(m), map.sourceRoot ?? '');
    for (const s of map.sources ?? []) {
      if (!s.includes('node_modules')) continue;
      const root = packageRootOf(resolve(base, s.replace(/^[a-z]+:\/\//i, '')));
      if (root) roots.add(root);
    }
  }
  return roots;
}

/** Node resolution of `name` from directory `from`. */
function resolvePackage(name, from) {
  for (let d = from; ; d = dirname(d)) {
    const p = join(d, 'node_modules', name);
    if (existsSync(join(p, 'package.json'))) return p;
    if (dirname(d) === d) return null;
  }
}

/** Runtime dependency closure of apps/ide/package.json (what electron-builder copies into app.asar). */
function runtimePackages() {
  const roots = new Set();
  const visit = (name, from) => {
    const p = resolvePackage(name, from);
    if (!p) throw new Error(`runtime dependency ${name} is not installed`);
    if (roots.has(p)) return;
    roots.add(p);
    const pkg = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8'));
    for (const d of Object.keys(pkg.dependencies ?? {})) visit(d, p);
  };
  const app = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
  for (const d of Object.keys(app.dependencies ?? {})) visit(d, appDir);
  return roots;
}

function section(root, why) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const files = readdirSync(root).filter((n) => LICENSE_FILE.test(n) && statSync(join(root, n)).isFile()).sort();
  const lic = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? '';
  if (files.length === 0 && !lic) throw new Error(`${pkg.name}: no licence file and no "license" field`);
  const head = `${pkg.name}@${pkg.version}  (${lic || 'see below'}; ${why})${pkg.homepage ? `\n${pkg.homepage}` : ''}`;
  const body = files.length
    ? files.map((f) => `--- ${f} ---\n${readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n').trimEnd()}`).join('\n\n')
    : `(the package ships no licence file; package.json "license": ${lic})`;
  return { name: pkg.name, text: `${'='.repeat(100)}\n${head}\n${'='.repeat(100)}\n${body}\n` };
}

function main() {
  const bundled = bundledPackages();
  const runtime = runtimePackages();
  const all = new Map();
  for (const r of bundled) all.set(r, 'bundled into the app');
  for (const r of runtime) all.set(r, all.has(r) ? 'bundled; runtime dependency' : 'runtime dependency in app.asar');
  const sections = [...all].map(([root, why]) => section(root, why)).sort((a, b) => a.name.localeCompare(b.name));

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const [src, to] of [
    ['LICENSE', 'LICENSE.txt'],
    ['NOTICE', 'NOTICE.txt'],
    ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ]) {
    const p = join(repoDir, src);
    if (!existsSync(p)) throw new Error(`${src} is missing at the repository root`);
    copyFileSync(p, join(dest, to));
  }
  const intro =
    'S12 Studio: licences of the open-source packages included in this application\n' +
    '(Electron and Chromium: LICENSE.electron.txt and LICENSES.chromium.html next to the application).\n\n' +
    sections.map((s) => `  ${s.name}`).join('\n') +
    '\n\n';
  writeFileSync(join(dest, 'THIRD_PARTY_LICENSES.txt'), intro + sections.map((s) => s.text).join('\n'));
  console.log(`[licenses] ${sections.length} packages (${bundled.size} bundled, ${runtime.size} runtime) -> ${relative(repoDir, dest)}`);
}

try {
  main();
} catch (e) {
  console.error(`[licenses] ${e.message}`);
  process.exit(1);
}
