/**
 * ME305 20-key keypad. Mouse down presses the key, mouse up (or leaving the key while held) releases it, so a
 * key can be held as long as the button is down. Keys shown pressed: held by this panel or reported held by the
 * board model (board.state keysDown, e.g. after a `tapKey` from the Command window).
 */
import { useRef } from 'react';
import type { KeyDef } from '../../../../shared/api';
import { keyRows } from './keymap';

export interface KeypadProps {
  keys: readonly KeyDef[];
  /** Labels held (panel + board model). */
  down: ReadonlySet<string>;
  onPress(label: string): void;
  onRelease(label: string): void;
}

const isFn = (l: string) => l.length > 1;

export function Keypad({ keys, down, onPress, onRelease }: KeypadProps) {
  const held = useRef<string | null>(null);
  const release = () => {
    const l = held.current;
    if (l === null) return;
    held.current = null;
    onRelease(l);
  };
  return (
    <div className="me305-keypad" data-testid="me305-keypad" role="group" aria-label="Keypad" onMouseLeave={release}>
      {keyRows(keys).map((row, r) => (
        <div key={r} className="me305-keypad-row">
          {row.map((k) => (
            <button
              key={k.label}
              type="button"
              tabIndex={-1}
              className={`me305-key${isFn(k.label) ? ' fn' : ''}${down.has(k.label) ? ' down' : ''}`}
              data-testid={`key-${k.label}`}
              aria-pressed={down.has(k.label)}
              title={`${k.label} (code ${k.code}; PC key ${k.pcKeys.join(' / ')})`}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault(); // keep focus on the board panel
                release();
                held.current = k.label;
                onPress(k.label);
              }}
              onMouseUp={(e) => e.button === 0 && release()}
              onMouseLeave={release}
            >
              {k.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
