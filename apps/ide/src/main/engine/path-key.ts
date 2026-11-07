/**
 * Map key for a file path: the same file must hit the same entry however the path was spelled. Windows: separators
 * unified to "\", "." / ".." / doubled separators resolved, case folded (NTFS is case-insensitive). macOS: case folded
 * (APFS/HFS+ default volumes are case-insensitive). Linux: path.posix.normalize only.
 * UNCERTAIN: a case-sensitive APFS volume on macOS would make two different files share a key (rare; the cost is a
 * shared EOL/encoding memory or watcher).
 */
import { posix, win32 } from 'node:path';

export function normKey(path: string, platform: string = process.platform): string {
  if (platform === 'win32') return win32.normalize(path).replace(/\\$/, (m, i: number) => (i <= 2 ? m : '')).toLowerCase();
  const n = posix.normalize(path).replace(/(.)\/$/, '$1');
  return platform === 'darwin' ? n.toLowerCase() : n;
}
