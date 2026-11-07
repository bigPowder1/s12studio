/**
 * Minimal path helpers that work on both Windows-style (`C:\a\b`) and POSIX paths without touching the file
 * system (the assembler is a pure function; CodeWarrior paths in options/notes are Windows paths).
 */

/** Separator used by `p`: backslash when the path contains one, else slash. */
export function sepOf(p: string): '\\' | '/' {
  return p.includes('\\') ? '\\' : '/';
}

export function lastSep(p: string): number {
  return Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
}

/** Directory part without trailing separator ('' when none). */
export function dirName(p: string): string {
  const i = lastSep(p);
  if (i < 0) return '';
  if (i === 0) return p[0];
  return p.slice(0, i);
}

export function baseName(p: string): string {
  return p.slice(lastSep(p) + 1);
}

/** File name without extension. */
export function stemName(p: string): string {
  const b = baseName(p);
  const d = b.lastIndexOf('.');
  return d > 0 ? b.slice(0, d) : b;
}

/** Extension without the dot ('' when none). */
export function extName(p: string): string {
  const b = baseName(p);
  const d = b.lastIndexOf('.');
  return d > 0 ? b.slice(d + 1) : '';
}

export function isAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\');
}

/** Join `dir` and `rel` with the separator style of `dir` (or of `rel` when `dir` is empty). */
export function joinPath(dir: string, rel: string): string {
  if (!dir) return rel;
  if (isAbsolute(rel)) return rel;
  const sep = dir.includes('\\') || (!dir.includes('/') && rel.includes('\\')) ? '\\' : '/';
  const d = dir.endsWith('\\') || dir.endsWith('/') ? dir.slice(0, -1) : dir;
  const r = sep === '\\' ? rel.replace(/\//g, '\\') : rel.replace(/\\/g, '/');
  return d + sep + r;
}

/**
 * CodeWarrior option "special modifiers" (Assembler manual, "Using special modifiers"):
 * %p path incl. separator, %N 8.3 file name, %n file name w/o extension, %E 8.3 extension, %e extension (with
 * the dot, so that "%f%e" is the whole name), %f path + name w/o extension, %" / %' a quote when the name
 * contains a space, %(ENV) environment variable, %% a percent sign.
 * UNCERTAIN: whether %e includes the dot (the manual's message format "%f%e" implies it does).
 */
export function expandModifiers(template: string, file: string, env: Record<string, string | undefined>): string {
  const dir = dirName(file);
  const sep = sepOf(file);
  const pathWithSep = dir ? dir + sep : '';
  const stem = stemName(file);
  const ext = extName(file);
  const hasSpace = file.includes(' ');
  return template.replace(/%(\([^)]*\)|.)/g, (m, k: string) => {
    if (k.startsWith('(')) return env[k.slice(1, -1)] ?? '';
    switch (k) {
      case 'p':
        return pathWithSep;
      case 'N':
        return stem.slice(0, 8);
      case 'n':
        return stem;
      case 'E':
        return ext.slice(0, 3);
      case 'e':
        return ext ? '.' + ext : '';
      case 'f':
        return pathWithSep + stem;
      case '"':
        return hasSpace ? '"' : '';
      case "'":
        return hasSpace ? "'" : '';
      case '%':
        return '%';
      default:
        return m;
    }
  });
}
