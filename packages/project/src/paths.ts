/**
 * Path helpers.
 *
 * Two path spaces exist:
 *  - "real" paths: what the ProjectFs reads and writes. Always normalised to forward slashes ("C:/x/y" on Windows,
 *    "/home/x/y" on POSIX); Node's fs accepts both forms on Windows.
 *  - "tool" paths: what CodeWarrior's tools would have seen (Windows paths with backslashes, e.g.
 *    "C:\Users\student\...\Lab3\bin\Project.abs"). They end up inside build outputs (.note command lines, DWARF
 *    comp_dir, map PROGRAM line, S0 records). A PathMapper converts between the two.
 * Data stored in .mcp files (access paths, output directories) uses backslashes; `toSlash` converts it.
 */

export const toSlash = (p: string): string => p.replace(/\\/g, '/');
export const toBackslash = (p: string): string => p.replace(/\//g, '\\');

/** True for "C:\x", "C:/x", "/x", "\\server\share". */
export function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\');
}

export const isWindowsDrivePath = (p: string): boolean => /^[A-Za-z]:([\\/]|$)/.test(p);

/** Normalise a real path: slashes, no duplicate separators, "." and ".." resolved, no trailing slash. */
export function normPath(p: string): string {
  const s = toSlash(p);
  let prefix = '';
  let rest = s;
  const drive = /^([A-Za-z]:)(\/|$)/.exec(s);
  if (drive) {
    prefix = drive[1] + '/';
    rest = s.slice(drive[0].length);
  } else if (s.startsWith('//')) {
    prefix = '//';
    rest = s.slice(2);
  } else if (s.startsWith('/')) {
    prefix = '/';
    rest = s.slice(1);
  }
  const out: string[] = [];
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!prefix) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const joined = out.join('/');
  if (!prefix) return joined || '.';
  return prefix + joined;
}

/** Join real path segments (later absolute segments win). */
export function joinPath(...parts: string[]): string {
  let acc = '';
  for (const p of parts) {
    if (p === '' || p === undefined) continue;
    if (isAbsolutePath(p) || acc === '') acc = toSlash(p);
    else acc = acc.replace(/[\\/]+$/, '') + '/' + toSlash(p);
  }
  return normPath(acc || '.');
}

export function dirName(p: string): string {
  const s = normPath(p);
  const i = s.lastIndexOf('/');
  if (i < 0) return '.';
  if (i === 0) return '/';
  if (/^[A-Za-z]:$/.test(s.slice(0, i))) return s.slice(0, i + 1);
  return s.slice(0, i);
}

export function baseName(p: string): string {
  const s = p.replace(/[\\/]+$/, '');
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
}

/** Extension in lower case including the dot (".asm"), '' when none. */
export function extOf(p: string): string {
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i).toLowerCase();
}

export function stemOf(p: string): string {
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? b : b.slice(0, i);
}

/** True when `p` equals `dir` or lies below it (case-insensitive when `ci`). */
export function isUnder(p: string, dir: string, ci = true): boolean {
  const a = normPath(p), d = normPath(dir);
  const eq = (x: string, y: string) => (ci ? x.toLowerCase() === y.toLowerCase() : x === y);
  if (eq(a, d)) return true;
  const dd = d.endsWith('/') ? d : d + '/';
  return a.length > dd.length && eq(a.slice(0, dd.length), dd);
}

/** Path of `p` relative to `dir` with '/' separators ('..' segments when outside); absolute `p` kept when on another drive. */
export function relativePath(dir: string, p: string): string {
  const a = normPath(p).split('/'), d = normPath(dir).split('/');
  if (a[0].toLowerCase() !== d[0].toLowerCase()) return normPath(p);
  let i = 0;
  while (i < a.length && i < d.length && a[i].toLowerCase() === d[i].toLowerCase()) i++;
  const up = d.slice(i).filter((s) => s !== '').map(() => '..');
  return [...up, ...a.slice(i)].join('/') || '.';
}

/** The directories CodeWarrior's tools see for {Project} and {Compiler} (golden builds inject the lab-PC paths). */
export interface ToolRoots {
  /** tool path of the project directory, e.g. "C:\\Users\\me\\Lab3" (no trailing separator) */
  project?: string;
  /** tool path of the compiler root, e.g. "C:\\Program Files (x86)\\Freescale\\CWS12v5.1" */
  compiler?: string;
}

/**
 * Converts real paths to tool paths and back. A real path under the project (compiler) directory maps to the
 * configured tool root with backslashes; without a configured root, real paths are used as tool paths (Windows
 * drive paths get backslashes, POSIX paths keep slashes).
 */
export class PathMapper {
  readonly roots: { real: string; tool: string }[] = [];

  constructor(realProjectDir: string, realCompilerDir: string | undefined, tool: ToolRoots = {}) {
    const add = (real: string | undefined, t: string | undefined) => {
      if (!real) return;
      const r = normPath(real);
      this.roots.push({ real: r, tool: t !== undefined ? stripSep(t) : defaultTool(r) });
    };
    add(realProjectDir, tool.project);
    add(realCompilerDir, tool.compiler);
    // Longest real prefix first (a compiler root inside the project dir must win).
    this.roots.sort((a, b) => b.real.length - a.real.length);
  }

  /** Tool path of a real path. */
  toTool(real: string): string {
    const r = normPath(real);
    for (const root of this.roots) {
      if (isUnder(r, root.real)) {
        const rest = r.slice(root.real.length).replace(/^\/+/, '');
        return rest ? joinTool(root.tool, rest) : root.tool;
      }
    }
    return defaultTool(r);
  }

  /** Real path of a tool path (inverse of toTool). */
  toReal(tool: string): string {
    const tn = toolNorm(tool);
    const sorted = [...this.roots].sort((a, b) => b.tool.length - a.tool.length);
    for (const root of sorted) {
      const rt = toolNorm(root.tool);
      if (tn.toLowerCase() === rt.toLowerCase()) return root.real;
      const prefix = rt.endsWith('/') ? rt : rt + '/';
      if (tn.toLowerCase().startsWith(prefix.toLowerCase())) return joinPath(root.real, tn.slice(prefix.length));
    }
    return normPath(tool);
  }
}

const stripSep = (p: string) => (/^[A-Za-z]:[\\/]$/.test(p) || p === '/' ? p : p.replace(/[\\/]+$/, ''));
const toolNorm = (p: string) => normPath(p);
function defaultTool(real: string): string {
  return isWindowsDrivePath(real) || real.startsWith('//') ? toBackslash(real) : real;
}

/** Join a tool path and a relative (slash or backslash) path using the tool path's separator style. */
export function joinTool(dir: string, rel: string): string {
  if (!rel) return dir;
  const win = dir.includes('\\') || isWindowsDrivePath(dir);
  const d = dir.replace(/[\\/]+$/, '');
  if (win) return toBackslash(normPath(toSlash(d) + '/' + toSlash(rel)));
  return normPath(d + '/' + toSlash(rel));
}
