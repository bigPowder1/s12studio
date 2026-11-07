/**
 * File access for the debugger engine (command files, .abs/.s19 loading, .BPT/.xpr persistence, source lookup),
 * behind a small interface so the UI process can substitute its own implementation. CodeWarrior projects come
 * from Windows: paths use backslashes and differ in case from the files on disk (`.\cmd\Full_Chip_Simulation_startup.cmd`
 * vs `Full_Chip_Simulation_Startup.cmd`), so lookups are case-insensitive per path segment.
 */
// No top-level Node imports: the engine also bundles into a non-Node renderer (with its own DebugFileSystem);
// nodeFileSystem loads node:fs on first use.

export interface DebugFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Entry names of a directory ([] if it does not exist). */
  readdir(path: string): Promise<string[]>;
}

let nodeFsPromises: Promise<typeof import('node:fs').promises> | undefined;
const nodeFs = () => (nodeFsPromises ??= import('node:fs').then((m) => m.promises));

export const nodeFileSystem: DebugFileSystem = {
  async readFile(p) {
    return new Uint8Array(await (await nodeFs()).readFile(p));
  },
  async writeFile(p, data) {
    await (await nodeFs()).writeFile(p, data);
  },
  async exists(p) {
    const fsp = await nodeFs();
    try {
      await fsp.stat(p);
      return true;
    } catch {
      return false;
    }
  },
  async readdir(p) {
    const fsp = await nodeFs();
    try {
      return await fsp.readdir(p);
    } catch {
      return [];
    }
  },
};

/** In-memory file system (tests, UI previews). Keys are '/'-separated absolute paths. */
export class MemoryFileSystem implements DebugFileSystem {
  readonly files = new Map<string, Uint8Array>();
  constructor(files: Record<string, Uint8Array | string> = {}) {
    for (const [k, v] of Object.entries(files)) this.files.set(toSlashes(k), typeof v === 'string' ? new TextEncoder().encode(v) : v);
  }
  async readFile(p: string): Promise<Uint8Array> {
    const f = this.files.get(toSlashes(p));
    if (!f) throw new Error(`ENOENT: ${p}`);
    return f;
  }
  async writeFile(p: string, data: Uint8Array | string): Promise<void> {
    this.files.set(toSlashes(p), typeof data === 'string' ? new TextEncoder().encode(data) : data);
  }
  async exists(p: string): Promise<boolean> {
    const k = toSlashes(p).replace(/\/$/, '');
    if (this.files.has(k)) return true;
    for (const f of this.files.keys()) if (f.startsWith(k + '/')) return true;
    return false;
  }
  async readdir(p: string): Promise<string[]> {
    const k = toSlashes(p).replace(/\/$/, '') + '/';
    const out = new Set<string>();
    for (const f of this.files.keys()) if (f.startsWith(k)) out.add(f.slice(k.length).split('/')[0]);
    return [...out];
  }
}

export const toSlashes = (p: string): string => p.replace(/\\/g, '/');

const isWindowsAbsolute = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');

/** Is `p` absolute (POSIX or Windows form)? */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || isWindowsAbsolute(p);
}

/**
 * Path normalisation ('.', '..', repeated slashes) with '/' separators, as path.posix.normalize, keeping Windows
 * roots: a drive root "C:/" (or "C:\") and a UNC root "//server/share" are never removed by '..' and stay in front
 * ("C:\Lab3\..\.." -> "C:/"). A drive-relative "C:x" is left to the posix rules.
 */
export function normalizePath(p: string): string {
  const s0 = toSlashes(p);
  if (!s0) return '.';
  const drive = /^[A-Za-z]:\//.exec(s0);
  const unc = drive ? null : /^\/\/([^/]+)\/([^/]+)(?=\/|$)/.exec(s0);
  if (drive || unc) {
    const root = drive ? drive[0].slice(0, 2) : `//${unc![1]}/${unc![2]}`;
    const tail = s0.slice(root.length);
    return tail ? root + normalizePath(tail) : root; // tail starts with '/': absolute, so '..' stops at the root
  }
  const s = s0;
  const abs = s.startsWith('/');
  const out: string[] = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
    } else out.push(seg);
  }
  let r = (abs ? '/' : '') + out.join('/');
  if (!r) r = abs ? '/' : '.';
  if (s.endsWith('/') && !r.endsWith('/')) r += '/';
  return r;
}

/** Join a base directory and a (Windows- or POSIX-style) relative path. */
export function joinPath(base: string, rel: string): string {
  if (isAbsolutePath(rel)) return toSlashes(rel);
  const b = toSlashes(base);
  const r = toSlashes(rel);
  if (!b) return normalizePath(r);
  if (!r) return normalizePath(b);
  return normalizePath(`${b}/${r}`);
}

/** Directory part of a path, as path.posix.dirname. */
export function dirName(p: string): string {
  let s = toSlashes(p);
  if (!s) return '.';
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  const i = s.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  s = s.slice(0, i);
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** Last path segment of a Windows or POSIX path. */
export function baseName(p: string): string {
  const s = toSlashes(p);
  return s.slice(s.lastIndexOf('/') + 1);
}

export function stripExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/**
 * Resolve `rel` against `base` matching each path segment case-insensitively. Returns the on-disk path, or
 * undefined if any segment is missing. Exact matches are preferred; `.`/`..` are handled.
 */
export async function resolvePathCI(fs: DebugFileSystem, base: string, rel: string): Promise<string | undefined> {
  const full = joinPath(base, rel);
  if (await fs.exists(full)) return full;
  if (isWindowsAbsolute(rel)) return undefined; // a Windows absolute path on a POSIX host: caller falls back to the base name
  const parts = full.split('/');
  let cur = parts[0] === '' ? '/' : /^[A-Za-z]:$/.test(parts[0]) ? parts[0] + '/' : parts[0];
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === '') continue;
    const entries = await fs.readdir(cur);
    const hit = entries.find((e) => e === seg) ?? entries.find((e) => e.toLowerCase() === seg.toLowerCase());
    if (!hit) return undefined;
    cur = cur.endsWith('/') ? cur + hit : `${cur}/${hit}`;
  }
  return (await fs.exists(cur)) ? cur : undefined;
}

/** Find a file by name in a list of directories (case-insensitive). */
export async function findInPaths(fs: DebugFileSystem, name: string, dirs: readonly string[]): Promise<string | undefined> {
  for (const d of dirs) {
    if (!d) continue;
    const r = await resolvePathCI(fs, d, name);
    if (r) return r;
  }
  return undefined;
}

export async function readText(fs: DebugFileSystem, p: string): Promise<string> {
  return new TextDecoder('latin1').decode(await fs.readFile(p));
}
