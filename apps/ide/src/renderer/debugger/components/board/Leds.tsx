/**
 * The four ME3305 LEDs on PP7..PP4 (two red/green pairs: PP7 red / PP6 green = pair 1, PP5 red / PP4 green = pair 2,
 * from the Lab3 comments; order and positions UNCERTAIN).
 *
 * Persistence: board states arrive at the snapshot rate (~30 Hz while running), so a short "on" would be visible for
 * one frame at most. An LED that was seen on stays lit for PERSIST_MS after its last on sample and then fades
 * (CSS transition), which keeps fast (PWM-like) blinking visible. If the engine reports `onFraction` (fraction of
 * time on since the previous state) it sets the brightness directly.
 */
import { useEffect, useReducer, useRef } from 'react';
import { ME3305 } from '@s12/devices';
import type { LedState } from '../../../../shared/api';

export const PERSIST_MS = 120;

/** LED list shown before the first board state (all off). */
export function defaultLeds(): LedState[] {
  return ME3305.leds.map((l) => ({ pin: l.pin, color: l.color, pair: l.pair, on: false }));
}

/** Display order: PP7, PP6, PP5, PP4 (R G R G). */
export function ledOrder(leds: readonly LedState[]): LedState[] {
  return [...leds].sort((a, b) => b.pin.localeCompare(a.pin, undefined, { numeric: true }));
}

export function Leds({ leds, now = () => performance.now() }: { leds: readonly LedState[]; now?: () => number }) {
  const lastOn = useRef(new Map<string, number>());
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const t = now();
  for (const l of leds) if (l.on) lastOn.current.set(l.pin, t);
  const persisting = leds.some((l) => !l.on && t - (lastOn.current.get(l.pin) ?? -Infinity) < PERSIST_MS);
  useEffect(() => {
    if (!persisting) return;
    const h = setTimeout(rerender, PERSIST_MS);
    return () => clearTimeout(h);
  });
  return (
    <div className="me3305-leds" data-testid="me3305-leds" role="group" aria-label="LEDs">
      {ledOrder(leds).map((l) => {
        const f = l.onFraction;
        const recent = t - (lastOn.current.get(l.pin) ?? -Infinity) < PERSIST_MS;
        const brightness = f !== undefined ? Math.max(f, l.on ? 1 : 0) : l.on || recent ? 1 : 0;
        const lit = brightness > 0;
        return (
          <div key={l.pin} className="me3305-led-wrap" title={`${l.pin} (${l.color}, pair ${l.pair})${l.on ? ' ON' : ''}`}>
            <div className={`me3305-led ${l.color}${lit ? ' lit' : ''}`} data-testid={`led-${l.pin}`} data-on={l.on ? '1' : '0'} data-lit={lit ? '1' : '0'} data-color={l.color}>
              <div className="me3305-led-glow" style={{ opacity: lit ? 0.35 + 0.65 * Math.min(1, brightness) : 0 }} />
            </div>
            <div className="me3305-led-label">{l.pin}</div>
          </div>
        );
      })}
    </div>
  );
}
