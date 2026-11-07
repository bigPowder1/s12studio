/**
 * Injected file-system interface used by the project model and the build (the Electron main process passes the Node
 * implementation, tests use the in-memory one). Paths are "real" paths (see paths.ts); implementations must accept
 * forward slashes.
 */
import { dirName, joinPath, normPath } from './paths';

export interface FileStat {
  /** modification time, milliseconds */
  mtime: number;
  size: number;
  isDirectory: boolean;
}

export interface ProjectFs {
  /** File contents, or undefined when the file does not exist (or is a directory). */
  readFile(path: string): Promise<Uint8Array | undefined>;
  /** Write a file, creating parent directories. */
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat | undefined>;
  /** Entry names of a directory, or undefined when it does not exist. */
  readdir(path: string): Promise<string[] | undefined>;
  mkdirp(path: string): Promise<void>;
  /** Delete a file or a whole directory tree; no error when missing. */
  remove(path: string): Promise<void>;
  /** Optional fast recursive copy; `copyTree` falls back to readdir/readFile/writeFile. */
  copyDir?(src: string, dst: string): Promise<void>;
}

// ------------------------------------------------------------------------------------------------ Node implementation

/**
 * ProjectFs over node:fs/promises. The module is loaded lazily so this file can be bundled for non-Node hosts
 * that never call it.
 */
export function createNodeFs(): ProjectFs {
  type FsP = typeof import('node:fs/promises');
  let mod: Promise<FsP> | undefined;
  const fsp = () => (mod ??= import('node:fs/promises'));
  const isMissing = (e: unknown) => {
    const c = (e as { code?: string }).code;
    return c === 'ENOENT' || c === 'ENOTDIR' || c === 'EISDIR';
  };
  return {
    async readFile(p) {
      try {
        const b = await (await fsp()).readFile(p);
        return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      } catch (e) {
        if (isMissing(e)) return undefined;
        throw e;
      }
    },
    async writeFile(p, bytes) {
      const f = await fsp();
      await f.mkdir(dirName(p), { recursive: true });
      await f.writeFile(p, bytes);
    },
    async exists(p) {
      try {
        await (await fsp()).stat(p);
        return true;
      } catch {
        return false;
      }
    },
    async stat(p) {
      try {
        const s = await (await fsp()).stat(p);
        return { mtime: s.mtimeMs, size: s.size, isDirectory: s.isDirectory() };
      } catch (e) {
        if (isMissing(e)) return undefined;
        throw e;
      }
    },
    async readdir(p) {
      try {
        return await (await fsp()).readdir(p);
      } catch (e) {
        if (isMissing(e)) return undefined;
        throw e;
      }
    },
    async mkdirp(p) {
      await (await fsp()).mkdir(p, { recursive: true });
    },
    async remove(p) {
      await (await fsp()).rm(p, { recursive: true, force: true });
    },
    async copyDir(src, dst) {
      await (await fsp()).cp(src, dst, { recursive: true });
    },
  };
}

// ------------------------------------------------------------------------------------------------ in-memory implementation

interface MemEntry {
  dir: boolean;
  bytes?: Uint8Array;
  mtime: number;
}

/**
 * In-memory ProjectFs (case-sensitive, like Linux). Every write gets a strictly increasing mtime so that "touching"
 * a file is always observable; `clock` can be replaced for deterministic tests.
 */
export class MemoryFs implements ProjectFs {
  private entries = new Map<string, MemEntry>();
  private tick = 0;
  clock: () => number = () => 1_700_000_000_000 + ++this.tick * 1000;
  /** number of readFile calls (tests use it to check incremental builds) */
  reads = 0;
  writes: string[] = [];

  constructor(files: Record<string, Uint8Array | string> = {}) {
    this.entries.set('/', { dir: true, mtime: 0 });
    for (const [p, v] of Object.entries(files)) this.writeSync(p, typeof v === 'string' ? latin1(v) : v);
  }

  private key(p: string): string {
    return normPath(p);
  }

  private ensureDir(p: string): void {
    const k = this.key(p);
    if (k === '.' || this.entries.get(k)?.dir) return;
    const parent = dirName(k);
    if (parent !== k) this.ensureDir(parent);
    this.entries.set(k, { dir: true, mtime: this.clock() });
  }

  writeSync(p: string, bytes: Uint8Array, mtime?: number): void {
    const k = this.key(p);
    this.ensureDir(dirName(k));
    this.entries.set(k, { dir: false, bytes: bytes.slice(), mtime: mtime ?? this.clock() });
  }

  readSync(p: string): Uint8Array | undefined {
    const e = this.entries.get(this.key(p));
    return e && !e.dir ? e.bytes : undefined;
  }

  /** Update a file's mtime without changing its contents. */
  touch(p: string, mtime?: number): void {
    const e = this.entries.get(this.key(p));
    if (!e) throw new Error(`touch: no such file ${p}`);
    e.mtime = mtime ?? this.clock();
  }

  /** All file paths (sorted). */
  list(prefix = '/'): string[] {
    const pre = this.key(prefix);
    return [...this.entries.entries()]
      .filter(([k, e]) => !e.dir && (pre === '/' || k === pre || k.startsWith(pre + '/')))
      .map(([k]) => k)
      .sort();
  }

  async readFile(p: string) {
    this.reads++;
    return this.readSync(p)?.slice();
  }
  async writeFile(p: string, bytes: Uint8Array) {
    this.writes.push(this.key(p));
    this.writeSync(p, bytes);
  }
  async exists(p: string) {
    return this.entries.has(this.key(p));
  }
  async stat(p: string): Promise<FileStat | undefined> {
    const e = this.entries.get(this.key(p));
    if (!e) return undefined;
    return { mtime: e.mtime, size: e.bytes?.length ?? 0, isDirectory: e.dir };
  }
  async readdir(p: string) {
    const k = this.key(p);
    const e = this.entries.get(k);
    if (!e || !e.dir) return undefined;
    const pre = k === '/' ? '/' : k + '/';
    const out: string[] = [];
    for (const key of this.entries.keys()) {
      if (key !== k && key.startsWith(pre) && !key.slice(pre.length).includes('/')) out.push(key.slice(pre.length));
    }
    return out.sort();
  }
  async mkdirp(p: string) {
    this.ensureDir(p);
  }
  async remove(p: string) {
    const k = this.key(p);
    for (const key of [...this.entries.keys()]) if (key === k || key.startsWith(k + '/')) this.entries.delete(key);
  }
}

const latin1 = (s: string): Uint8Array => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
};

// ------------------------------------------------------------------------------------------------ helpers

/**
 * Find a path case-insensitively (Windows semantics on a case-sensitive fs): the exact path when it exists, else
 * each component is matched against the directory listing ignoring case. Returns the real spelling or undefined.
 */
export async function resolveCase(fs: ProjectFs, path: string, cache?: Map<string, string[] | undefined>): Promise<string | undefined> {
  const p = normPath(path);
  if (await fs.exists(p)) return p;
  const m = /^([A-Za-z]:\/|\/\/|\/)?(.*)$/.exec(p)!;
  let cur = m[1] ?? '';
  const segs = m[2].split('/').filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const dir = cur || '.';
    let names: string[] | undefined;
    if (cache?.has(dir)) names = cache.get(dir);
    else {
      names = await fs.readdir(dir);
      cache?.set(dir, names);
    }
    if (!names) return undefined;
    const want = segs[i];
    const hit = names.find((n) => n === want) ?? names.find((n) => n.toLowerCase() === want.toLowerCase());
    if (hit === undefined) return undefined;
    cur = cur ? (cur.endsWith('/') ? cur + hit : cur + '/' + hit) : hit;
  }
  return cur || undefined;
}

/** Recursively list files below `dir` (real paths), depth-limited. */
export async function walkFiles(fs: ProjectFs, dir: string, maxDepth = 16): Promise<string[]> {
  const out: string[] = [];
  const rec = async (d: string, depth: number) => {
    const names = await fs.readdir(d);
    if (!names) return;
    for (const n of names.sort()) {
      const p = joinPath(d, n);
      const st = await fs.stat(p);
      if (!st) continue;
      if (st.isDirectory) {
        if (depth < maxDepth) await rec(p, depth + 1);
      } else out.push(p);
    }
  };
  await rec(normPath(dir), 0);
  return out;
}

/**
 * Copy a directory tree. `map(relPath)` may rename an entry (return the new relative path) or skip it (return
 * undefined); relPath uses '/' and directory entries end without a slash.
 */
export async function copyTree(
  fs: ProjectFs,
  src: string,
  dst: string,
  map: (rel: string, isDir: boolean) => string | undefined = (r) => r,
): Promise<string[]> {
  const written: string[] = [];
  const rec = async (rel: string, outRel: string) => {
    const from = rel ? joinPath(src, rel) : normPath(src);
    const names = await fs.readdir(from);
    await fs.mkdirp(outRel ? joinPath(dst, outRel) : normPath(dst));
    if (!names) return;
    for (const n of names.sort()) {
      const r = rel ? `${rel}/${n}` : n;
      const st = await fs.stat(joinPath(src, r));
      if (!st) continue;
      const mapped = map(r, st.isDirectory);
      if (mapped === undefined) continue;
      if (st.isDirectory) await rec(r, mapped);
      else {
        const bytes = await fs.readFile(joinPath(src, r));
        if (!bytes) continue;
        const to = joinPath(dst, mapped);
        await fs.writeFile(to, bytes);
        written.push(to);
      }
    }
  };
  await rec('', '');
  return written;
}

/** Read a text file as Latin-1 (CodeWarrior's 8-bit files). */
export async function readText(fs: ProjectFs, path: string): Promise<string | undefined> {
  const b = await fs.readFile(path);
  return b === undefined ? undefined : bytesToLatin1(b);
}

export function bytesToLatin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}

export const latin1Bytes = latin1;

export function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
export function utf8Text(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

