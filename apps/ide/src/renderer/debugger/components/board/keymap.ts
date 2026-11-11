/**
 * ME3305 keypad layout and PC keyboard mapping.
 *
 * Labels and codes are certain (the keypad table, private me3305-board.md §4). The physical layout is
 * UNCERTAIN: we use ME3305.keypad.layout from @s12/devices (hex grid read row by row, function keys in a fifth
 * column), the same rows the simulator reports through board.keys().
 *
 * PC keys (panel focused): 0-9, A-F (either case), Enter = ENT, Backspace/Delete = BKSP, F1, F2.
 */
import { ME3305 } from '@s12/devices';
import type { KeyDef } from '../../../../shared/api';

const PC_KEYS: Record<string, string[]> = {
  F1: ['F1'],
  F2: ['F2'],
  BKSP: ['Backspace', 'Delete'],
  ENT: ['Enter'],
};

/** Keys from the device description (used before a session exists, or when board.keys() returns nothing). */
export function defaultKeys(): KeyDef[] {
  const out: KeyDef[] = [];
  ME3305.keypad.layout.forEach((row, r) =>
    row.forEach((label, c) => {
      const k = ME3305.keypad.table.find((t) => t.label === label);
      out.push({ label, code: k?.code ?? -1, row: r, col: c, pcKeys: PC_KEYS[label] ?? [...new Set([label.toLowerCase(), label.toUpperCase()])] });
    }),
  );
  return out;
}

/** Keys arranged in rows (by KeyDef.row/col); keys without a position go to an extra last row. */
export function keyRows(keys: readonly KeyDef[]): KeyDef[][] {
  const rows: KeyDef[][] = [];
  const extra: KeyDef[] = [];
  for (const k of keys) {
    if (k.row < 0 || k.col < 0) extra.push(k);
    else (rows[k.row] ??= [])[k.col] = k;
  }
  const out = rows.filter(Boolean).map((r) => r.filter(Boolean));
  if (extra.length) out.push(extra);
  return out;
}

/**
 * Keypad label for a keydown/keyup event, or null when the key is not mapped (or a modifier other than Shift is
 * held: Ctrl/Alt/Meta combinations stay with the app's shortcuts).
 */
export function keypadLabelFor(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'>, keys: readonly KeyDef[]): string | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  const k = e.key;
  for (const d of keys) if (d.pcKeys.includes(k)) return d.label;
  // case-insensitive fallback for letters (CapsLock / Shift)
  if (k.length === 1) {
    const u = k.toUpperCase();
    for (const d of keys) if (d.label === u) return d.label;
  }
  return null;
}
