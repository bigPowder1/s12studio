/**
 * Source component model (pure): the line <-> address mapping used for breakpoint marks, Set Breakpoint, Run To
 * Cursor and Set Program Counter (chroma coding is the Monaco HC12 language in common/monaco).
 */
import type { BreakpointInfo, LineAddress } from '../../../../shared/api';

/** First code address of a line, or of the next line that has code (hiwave sets the breakpoint there). */
export function addressForLine(lines: readonly LineAddress[], line: number): { line: number; address: number } | undefined {
  let best: LineAddress | undefined;
  for (const l of lines) if (l.line >= line && (!best || l.line < best.line)) best = l;
  return best ? { line: best.line, address: best.address } : undefined;
}

/** Breakpoints by source line (first line that starts at the breakpoint's address). */
export function breakpointsByLine(lines: readonly LineAddress[], bps: readonly BreakpointInfo[]): Map<number, BreakpointInfo> {
  const lineOf = new Map<number, number>();
  for (const l of [...lines].sort((a, b) => a.line - b.line)) if (!lineOf.has(l.address)) lineOf.set(l.address, l.line);
  const out = new Map<number, BreakpointInfo>();
  for (const b of bps) {
    const ln = lineOf.get(b.address);
    if (ln !== undefined && !out.has(ln)) out.set(ln, b);
  }
  return out;
}

/** Same DWARF file? (case and slash insensitive, like Windows paths) */
export const sameFile = (a: string | undefined, b: string | undefined): boolean => !!a && !!b && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

/** Next line (1-based) at or after `from` containing `text` (case-insensitive), wrapping; undefined if none. */
export function findLine(textLines: readonly string[], text: string, from: number): number | undefined {
  const t = text.toLowerCase();
  if (!t) return undefined;
  const n = textLines.length;
  for (let k = 0; k < n; k++) {
    const i = (from - 1 + k) % n;
    if (textLines[i].toLowerCase().includes(t)) return i + 1;
  }
  return undefined;
}
