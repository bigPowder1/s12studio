/** Status-bar text helpers (ide.md §6 "Status bar": message | frequency | cycles | derivative | run state). */
import type { DebugSnapshot } from '../../../shared/api';
import { formatMHz } from '../../common/format';

export const HELP_MESSAGE = 'For Help, press F1';

/**
 * Run-state pane text. The engine provides hiwave's strings (RUNNING, HALTED, Breakpoint, STEPPED, TRACED,
 * STEP INTO...). UNCERTAIN: hiwave's text before an application is loaded; we show "Ready".
 */
export function runStateText(snap: Pick<DebugSnapshot, 'state' | 'statusText'>): string {
  if (snap.state === 'none') return 'Ready';
  if (snap.state === 'running') return snap.statusText || 'RUNNING';
  return snap.statusText || 'HALTED';
}

/** Frequency pane ("8.000000 MHz"), empty without a target. */
export function clockText(snap: Pick<DebugSnapshot, 'busHz' | 'registers'>): string {
  return snap.registers && snap.busHz ? formatMHz(snap.busHz) : '';
}

/**
 * Cycle pane: the 64-bit CPU cycle counter (exact to 2^53 in a JS number) minus the displayed-counter base (set when
 * the user double-clicks the pane and the engine could not reset its own counter).
 */
export function cyclesText(snap: Pick<DebugSnapshot, 'cycles' | 'registers'>, base: number): string {
  if (!snap.registers) return '';
  const v = snap.cycles - base;
  return String(v < 0 ? snap.cycles : v);
}
