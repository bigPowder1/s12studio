/**
 * Keyboard glue between Monaco and the IDE menu shortcuts. The shell binds menu shortcuts on `window` but ignores
 * keys typed into text areas (Monaco's input is a textarea) except function keys, so Ctrl+S / Ctrl+G / Ctrl+W ...
 * typed in the editor would never reach the menus. Ctrl+letter/digit keys Monaco did not handle are re-dispatched
 * on document.body, where the shell's handler accepts them.
 */

/** Ctrl shortcuts that stay with the text field (clipboard, select all, undo/redo). */
const EDITING = new Set(['c', 'v', 'x', 'a', 'z', 'y']);

export function shouldForwardKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'defaultPrevented'>): boolean {
  if (e.defaultPrevented) return false;
  if (!(e.ctrlKey || e.metaKey)) return false;
  if (e.key.length !== 1 || !/[a-z0-9]/i.test(e.key)) return false;
  return !EDITING.has(e.key.toLowerCase()) || e.altKey;
}

/** Install the forwarder on an editor host element; returns the uninstall function. */
export function forwardMenuShortcuts(host: HTMLElement): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (!shouldForwardKey(e)) return;
    const clone = new KeyboardEvent('keydown', { key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey, bubbles: true, cancelable: true });
    e.stopPropagation();
    document.body.dispatchEvent(clone);
    if (clone.defaultPrevented) e.preventDefault();
  };
  host.addEventListener('keydown', onKey);
  return () => host.removeEventListener('keydown', onKey);
}
