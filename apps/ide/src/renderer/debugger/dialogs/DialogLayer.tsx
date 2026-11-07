/**
 * Container for dialogs a debugger component mounts inside its own root element.
 *
 * React events bubble through the component tree, so a key or click inside an Address / Fill / Controlpoints
 * dialog would also reach the component's own handlers (Memory starts an in-place byte edit on hex digits, Data
 * deletes the selected expression on Delete, Command moves focus to `in>` on mouse up). Two layers of defence:
 *   - the components' own handlers return early for targets inside a dialog (`inDialog`), for keys as well;
 *   - this layer stops the mouse/drag events at the dialog boundary (the dialogs are modal).
 * Keyboard events are NOT stopped here: the shared `Dialog` presses its default button from a bubble-phase
 * `window` keydown listener, and Esc is handled in the capture phase.
 */
import type { ReactNode, SyntheticEvent } from 'react';

const stop = (e: SyntheticEvent) => e.stopPropagation();

export function DialogLayer({ children }: { children: ReactNode }) {
  return (
    <div
      className="dbg-dialog-layer"
      style={{ display: 'contents' }}
      onMouseUp={stop}
      onMouseOver={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onDragStart={stop}
      onDragOver={stop}
      onDrop={stop}
    >
      {children}
    </div>
  );
}

/** True when an event target sits inside a dialog (or the dialog layer); component handlers ignore those. */
export function inDialog(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.('.cw-dialog, .cw-dialog-backdrop, .dbg-dialog-layer');
}
