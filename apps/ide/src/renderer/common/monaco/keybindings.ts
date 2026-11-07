/**
 * Monaco default keybindings that would swallow a CodeWarrior / hiwave menu shortcut. Monaco handles (and
 * preventDefault()s) its own keys before the shell's window-level menu shortcuts see them, so any Monaco default on a
 * menu key silently disables that menu command while an editor or Source view has focus. Each entry below removes
 * one such Monaco binding. keybindings.test.ts checks every IDE and debugger menu shortcut against Monaco's live
 * default keymap, so a new clash (new menu shortcut or new Monaco feature) fails the test.
 *
 * Bindings Monaco shares with CW on purpose (same meaning) are kept: Ctrl+F find, Ctrl+H replace, F3 / Shift+F3 find
 * next / previous, Ctrl+[ / Ctrl+] shift left / right, and the clipboard / undo / select-all keys.
 */
import type { Monaco } from './loader';

export interface RemovedMonacoKey {
  /** Shortcut in menu notation ("Ctrl+D"). */
  shortcut: string;
  /** Monaco command bound to it by default. */
  command: string;
  /** The CW / hiwave menu command that owns the key. */
  owner: string;
  keybinding: (m: Monaco) => number;
}

export const REMOVED_MONACO_KEYS: readonly RemovedMonacoKey[] = [
  {
    shortcut: 'Ctrl+D',
    command: 'editor.action.addSelectionToNextFindMatch',
    owner: 'File > Find and Open File...',
    keybinding: (m) => m.KeyMod.CtrlCmd | m.KeyCode.KeyD,
  },
  {
    // macOS only (Cmd+G = Find Next there; F3 still is); elsewhere Monaco has no such binding and the rule is a no-op
    shortcut: 'Ctrl+G',
    command: 'editor.action.nextMatchFindAction',
    owner: 'Search > Go to Line...',
    keybinding: (m) => m.KeyMod.CtrlCmd | m.KeyCode.KeyG,
  },
];

const applied = new WeakSet<object>();

/** Remove the clashing Monaco defaults (idempotent per Monaco instance; no-op on a stand-in without the API). */
export function applyCwKeybindings(monaco: Monaco): void {
  if (applied.has(monaco)) return;
  const add = (monaco.editor as Partial<Monaco['editor']>).addKeybindingRules;
  if (typeof add !== 'function') return;
  applied.add(monaco);
  add(REMOVED_MONACO_KEYS.map((k) => ({ keybinding: k.keybinding(monaco), command: `-${k.command}` })));
}
