/**
 * "ME3305 Board" debugger component (S12 Studio addition; not a hiwave component): a drawing of the Cal Poly ME3305
 * benchtop unit driven by the board state stream (`board.state` events at the snapshot rate, no per-instruction
 * traffic). Spec: private me3305-board.md §3-§8.
 *
 *   - 40x2 HD44780 LCD (Lcd.tsx), 20-key keypad (Keypad.tsx), LEDs PP7..PP4 (Leds.tsx), motor/encoder/DAC (Motor.tsx)
 *   - keypad: mouse down/up = board.pressKey/releaseKey (calls are serialized, so a release never overtakes its
 *     press); with the panel focused the PC keyboard drives the keypad (0-9, A-F, Enter, Backspace, F1, F2) unless
 *     Settings debugger.keyboardToKeypad is off. Mapped keys are swallowed (preventDefault + stopPropagation) so F1/F2
 *     or Enter never reach the window-level menu shortcuts. Keys still held when the panel closes are released.
 *   - the drawing is scaled to fit the window (fit.ts), so the motor is visible at Component > Open's default size.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { BoardState, KeyDef } from '../../../../shared/api';
import type { MenuEntry } from '../../../common/menu/model';
import { useBoardState, useS12, useS12Event, useSession } from '../../../common/s12';
import { useComponentMenu, type DebuggerComponentProps } from '../contract';
import { fitScale } from './fit';
import { Keypad } from './Keypad';
import { defaultKeys, keypadLabelFor } from './keymap';
import { Lcd } from './Lcd';
import { defaultLeds, Leds } from './Leds';
import { DacMeter, EncoderView, MotorView } from './Motor';
import './board.css';

export function BoardComponent(_props: DebuggerComponentProps) {
  const api = useS12();
  const session = useSession();
  const live = useBoardState();
  const [pulled, setPulled] = useState<BoardState | null>(null);
  const [keys, setKeys] = useState<KeyDef[]>(defaultKeys);
  const [kbdEnabled, setKbdEnabled] = useState(true);
  const [panelDown, setPanelDown] = useState<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const kbdHeld = useRef(new Map<string, string>()); // KeyboardEvent.code (or key) -> keypad label
  const panelDownRef = useRef<ReadonlySet<string>>(panelDown);
  panelDownRef.current = panelDown;
  const unitRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{
    scale: number;
    w: number;
    h: number;
  } | null>(null);

  // initial pull (the store only fills on the next pushed state) + key table of the session's board
  useEffect(() => {
    let alive = true;
    void api.board.state().then(
      (s) => alive && s && setPulled(s),
      () => undefined,
    );
    void api.board.keys().then(
      (k) => alive && Array.isArray(k) && k.length > 0 && setKeys(k),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, session]);

  useEffect(() => {
    let alive = true;
    void api.settings.get().then(
      (s) => alive && s && setKbdEnabled(s.debugger.keyboardToKeypad !== false),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api]);
  useS12Event('settings', 'changed', (s) => setKbdEnabled(s.debugger.keyboardToKeypad !== false));

  const board = live ?? pulled;
  const present = !!board?.present;

  /** Run board calls strictly in order (press before release). Errors (no session) are ignored. */
  const enqueue = useCallback((fn: () => Promise<unknown>) => {
    queue.current = queue.current.then(fn).catch(() => undefined);
  }, []);

  const press = useCallback(
    (label: string) => {
      setPanelDown((s) => new Set(s).add(label));
      enqueue(() => api.board.pressKey(label));
    },
    [api, enqueue],
  );
  const release = useCallback(
    (label: string) => {
      setPanelDown((s) => {
        const n = new Set(s);
        n.delete(label);
        return n;
      });
      enqueue(() => api.board.releaseKey(label));
    },
    [api, enqueue],
  );
  const releaseAll = useCallback(() => {
    for (const l of new Set([...panelDown, ...(board?.keysDown ?? [])])) release(l);
    kbdHeld.current.clear();
  }, [panelDown, board, release]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!kbdEnabled) return;
    const label = keypadLabelFor(e, keys);
    if (!label) return;
    e.preventDefault();
    e.stopPropagation();
    const id = e.code || e.key;
    if (e.repeat || kbdHeld.current.has(id)) return;
    kbdHeld.current.set(id, label);
    press(label);
  };
  const onKeyUp = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const id = e.code || e.key;
    const label = kbdHeld.current.get(id);
    if (label === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    kbdHeld.current.delete(id);
    release(label);
  };
  const onBlur = () => {
    setFocused(false);
    for (const label of kbdHeld.current.values()) release(label);
    kbdHeld.current.clear();
  };

  // keys still held (mouse or PC keyboard) when the panel closes / the layout reloads: release them, or the
  // simulated 74C923 would keep DA asserted until a power cycle
  useEffect(
    () => () => {
      for (const label of new Set([...panelDownRef.current, ...kbdHeld.current.values()])) enqueue(() => api.board.releaseKey(label));
      kbdHeld.current.clear();
    },
    [api, enqueue],
  );

  // fit-to-window scaling (no ResizeObserver in jsdom: natural size, scrolling)
  useLayoutEffect(() => {
    const root = rootRef.current;
    const unit = unitRef.current;
    if (!root || !unit || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const cs = getComputedStyle(root);
      const padW = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) || 0;
      const padH = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) || 0;
      // offsetWidth/Height ignore the transform: the natural size
      const natural = { w: unit.offsetWidth, h: unit.offsetHeight };
      const scale = fitScale({ w: root.clientWidth - padW, h: root.clientHeight - padH }, natural);
      setFit((f) => (f && f.scale === scale && f.w === natural.w && f.h === natural.h ? f : { scale, ...natural }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    ro.observe(unit);
    measure();
    return () => ro.disconnect();
  }, []);

  const down = useMemo(() => new Set([...panelDown, ...(board?.keysDown ?? [])]), [panelDown, board]);

  const menu = useMemo<MenuEntry[]>(
    () => [
      {
        id: 'board.powerCycle',
        label: '&Power Cycle Board',
        disabled: !present,
        onSelect: () => enqueue(() => api.board.powerCycle()),
      },
      {
        id: 'board.releaseAll',
        label: '&Release All Keys',
        onSelect: releaseAll,
      },
      { kind: 'separator' },
      {
        id: 'board.keyboard',
        label: 'Map PC &Keyboard to Keypad',
        checked: kbdEnabled,
        onSelect: () => {
          const v = !kbdEnabled;
          setKbdEnabled(v);
          void api.settings.update({ debugger: { keyboardToKeypad: v } }).catch(() => undefined);
        },
      },
    ],
    [api, enqueue, present, releaseAll, kbdEnabled],
  );
  useComponentMenu(menu);

  return (
    <div
      ref={rootRef}
      className={`me3305-board${focused ? ' focused' : ''}`}
      tabIndex={0}
      data-testid="me3305-board"
      data-present={present ? '1' : '0'}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
      onMouseDown={() => rootRef.current?.focus({ preventScroll: true })}
    >
      <div
        className="me3305-fit"
        style={
          fit
            ? {
                width: Math.ceil(fit.w * fit.scale),
                height: Math.ceil(fit.h * fit.scale),
              }
            : undefined
        }
      >
        <div ref={unitRef} className={`me3305-unit${fit ? ' scaled' : ''}`} style={fit ? { transform: `scale(${fit.scale})` } : undefined} data-scale={fit?.scale ?? 1}>
          <div className="me3305-title">
            <span>ME3305 Board</span>
            <span className="me3305-status" data-testid="me3305-status">
              {present ? `t = ${(board?.simSeconds ?? 0).toFixed(3)} s` : 'no simulated board (start a debug session)'}
            </span>
          </div>
          <div className="me3305-lcd-bezel">
            <Lcd lcd={board?.lcd ?? null} />
          </div>
          <div className="me3305-lower">
            <div className="me3305-section">
              <div className="me3305-caption">KEYPAD{focused && kbdEnabled ? ' (keyboard active)' : ''}</div>
              <Keypad keys={keys} down={down} onPress={press} onRelease={release} />
            </div>
            <div className="me3305-section">
              <div className="me3305-caption">LEDS</div>
              <Leds leds={board?.leds?.length ? board.leds : defaultLeds()} />
              <div className="me3305-caption">ENCODER</div>
              <EncoderView count={board?.encoderCount ?? 0} />
              <div className="me3305-caption">DAC (MCP4922)</div>
              <DacMeter name="A" volts={board?.dac.a ?? 0} />
              <DacMeter name="B" volts={board?.dac.b ?? 0} />
            </div>
            <div className="me3305-section">
              <div className="me3305-caption">MOTOR</div>
              <MotorView motor={board?.motor ?? null} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
