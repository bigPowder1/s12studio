import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BoardState, LcdState, LedState } from '../../../../shared/api';
import { S12Provider } from '../../../common/s12';
import { createMockS12, type MockS12 } from '../../../common/testing/mockS12';
import { BoardComponent } from './BoardComponent';
import { defaultKeys, keypadLabelFor, keyRows } from './keymap';
import { Lcd } from './Lcd';
import { CGRAM_BASE, FONT_CHARS, glyphRows, hasGlyph } from './lcdFont';
import { fitScale, MAX_SCALE, MIN_SCALE } from './fit';
import { Leds, PERSIST_MS } from './Leds';

const L1 = 'S12 Studio blinky demo';
const L2 = 'Blink: 500 ms per step  (keys 1-9)';
const pad = (s: string) => s.padEnd(40, ' ');

const lcd = (over: Partial<LcdState> = {}): LcdState => ({
  lines: [pad(L1), pad(L2)],
  cursor: null,
  cursorVisible: false,
  blinkOn: false,
  displayOn: true,
  cgram: Array.from({ length: 8 }, () => [0, 0, 0, 0, 0, 0, 0, 0]),
  ...over,
});

const leds = (on: string[] = []): LedState[] =>
  [
    { pin: 'PP4', color: 'green', pair: 2 },
    { pin: 'PP5', color: 'red', pair: 2 },
    { pin: 'PP6', color: 'green', pair: 1 },
    { pin: 'PP7', color: 'red', pair: 1 },
  ].map((l) => ({ ...(l as Omit<LedState, 'on'>), on: on.includes(l.pin) }));

const board = (over: Partial<BoardState> = {}): BoardState => ({
  present: true,
  seq: 1,
  simSeconds: 1.5,
  lcd: lcd(),
  leds: leds(),
  keysDown: [],
  encoderCount: 0,
  dac: { a: 0, b: 0 },
  motor: null,
  ...over,
});

function setup(m: MockS12 = createMockS12()) {
  const r = render(
    <S12Provider api={m.api}>
      <BoardComponent instanceId="ME305 Board" title="ME305 Board" instance={1} attributes={[]} active />
    </S12Provider>,
  );
  return { m, ...r };
}

const boardCalls = (m: MockS12) => m.log.filter((c) => c.domain === 'board' && /Key$/.test(c.method)).map((c) => `${c.method}:${c.args[0]}`);

describe('ME305 LCD', () => {
  it('renders the 80 characters of a board state as 5x8 dot cells', () => {
    const { m, container } = setup();
    act(() => m.emit('board', 'state', board()));
    expect(screen.getByTestId('lcd-row-0').textContent).toBe(pad(L1));
    expect(screen.getByTestId('lcd-row-1').textContent).toBe(pad(L2));
    const cells = container.querySelectorAll('[data-testid="me305-lcd"] g[data-char]');
    expect(cells).toHaveLength(80);
    const text = [...cells].map((c) => c.getAttribute('data-char')).join('');
    expect(text).toBe(pad(L1) + pad(L2));
    // every printable character of the splash has a drawn glyph
    for (const ch of L1 + L2) expect(hasGlyph(ch)).toBe(true);
    // the first cell has dark dots, a space cell has none
    const m0 = container.querySelector('g[data-row="0"][data-col="0"] path.me305-lcd-dot-on');
    expect(m0?.getAttribute('d')).toMatch(/^M/);
    const sp = container.querySelector(`g[data-row="0"][data-col="${L1.indexOf(' ')}"] path.me305-lcd-dot-on`);
    expect(sp?.getAttribute('d')).toBe('');
  });

  it('shows a blank glass when the display is off and the underline cursor when on', () => {
    const m = createMockS12();
    const { container, rerender } = render(<Lcd lcd={lcd({ displayOn: false, lines: [pad(''), pad('')] })} />);
    expect(screen.getByTestId('me305-lcd')).toHaveAttribute('data-display', 'off');
    expect([...container.querySelectorAll('path.me305-lcd-dot-on')].every((p) => p.getAttribute('d') === '')).toBe(true);
    rerender(<Lcd lcd={lcd({ cursor: { row: 1, col: 3 }, cursorVisible: true })} />);
    const cur = container.querySelector('g[data-cursor]');
    expect(cur).toHaveAttribute('data-row', '1');
    expect(cur).toHaveAttribute('data-col', '3');
    expect(cur).toHaveAttribute('data-cursor', 'underline');
    void m;
  });

  it('blinks the cursor cell as a full block', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<Lcd lcd={lcd({ cursor: { row: 0, col: 0 }, cursorVisible: true, blinkOn: true })} />);
      expect(container.querySelector('g[data-cursor]')).toHaveAttribute('data-cursor', 'block');
      act(() => vi.advanceTimersByTime(420));
      expect(container.querySelector('g[data-cursor]')).toBeNull();
      act(() => vi.advanceTimersByTime(420));
      expect(container.querySelector('g[data-cursor]')).toHaveAttribute('data-cursor', 'block');
    } finally {
      vi.useRealTimers();
    }
  });

  it('font: 8 rows of 5 bits, CGRAM glyphs from the board state, unknown glyph box', () => {
    for (const ch of FONT_CHARS) {
      const g = glyphRows(ch);
      expect(g).toHaveLength(8);
      for (const r of g) expect(r).toBeLessThanOrEqual(0x1f);
      expect(g[7]).toBe(0); // row 8 is the cursor row
    }
    expect(FONT_CHARS.length).toBeGreaterThanOrEqual(95);
    const cg = Array.from({ length: 8 }, (_, i) => (i === 2 ? [0x1f, 1, 2, 3, 4, 5, 6, 0x10] : [0, 0, 0, 0, 0, 0, 0, 0]));
    expect(glyphRows(String.fromCodePoint(CGRAM_BASE + 2), cg)).toEqual([0x1f, 1, 2, 3, 4, 5, 6, 0x10]);
    expect(glyphRows('ｱ')[0]).toBe(0x1f); // katakana: box
    expect(hasGlyph('ｱ')).toBe(false);
    expect(glyphRows('A')).toEqual([0x0e, 0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0]);
  });
});

describe('ME305 keypad', () => {
  it('lays out the 20 keys in 4 rows of 5 (0-F + F1, F2, BKSP, ENT)', () => {
    const rows = keyRows(defaultKeys());
    expect(rows.map((r) => r.map((k) => k.label))).toEqual([
      ['0', '1', '2', '3', 'F1'],
      ['4', '5', '6', '7', 'F2'],
      ['8', '9', 'A', 'B', 'BKSP'],
      ['C', 'D', 'E', 'F', 'ENT'],
    ]);
    setup();
    expect(screen.getAllByRole('button')).toHaveLength(20);
  });

  it('mouse down/up on a key -> pressKey then releaseKey, in order; held key shows pressed', async () => {
    let releaseFirst!: () => void;
    const slowPress = new Promise<void>((r) => (releaseFirst = r));
    const m = createMockS12({ board: { pressKey: () => slowPress } });
    setup(m);
    const user = userEvent.setup();
    const k5 = screen.getByTestId('key-5');
    await user.pointer({ keys: '[MouseLeft>]', target: k5 });
    expect(k5).toHaveAttribute('aria-pressed', 'true');
    await user.pointer({ keys: '[/MouseLeft]', target: k5 });
    expect(k5).toHaveAttribute('aria-pressed', 'false');
    // release waits for the press to complete
    expect(boardCalls(m)).toEqual(['pressKey:5']);
    releaseFirst();
    await waitFor(() => expect(boardCalls(m)).toEqual(['pressKey:5', 'releaseKey:5']));

    await user.click(screen.getByTestId('key-F1'));
    await user.click(screen.getByTestId('key-ENT'));
    await waitFor(() => expect(boardCalls(m)).toEqual(['pressKey:5', 'releaseKey:5', 'pressKey:F1', 'releaseKey:F1', 'pressKey:ENT', 'releaseKey:ENT']));
  });

  it('leaving a held key releases it', async () => {
    const { m } = setup();
    const kA = screen.getByTestId('key-A');
    fireEvent.mouseDown(kA, { button: 0 });
    fireEvent.mouseLeave(kA);
    await waitFor(() => expect(boardCalls(m)).toEqual(['pressKey:A', 'releaseKey:A']));
  });

  it('keys held by the board model (keysDown) are shown pressed', () => {
    const { m } = setup();
    act(() => m.emit('board', 'state', board({ keysDown: ['F2'] })));
    expect(screen.getByTestId('key-F2')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('key-F1')).toHaveAttribute('aria-pressed', 'false');
  });

  it('maps the PC keyboard when focused: 0-9, A-F, Enter, Backspace, F1/F2; F-keys do not reach window shortcuts', async () => {
    const { m } = setup();
    const winKeys: string[] = [];
    const onWin = (e: KeyboardEvent) => winKeys.push(e.key);
    window.addEventListener('keydown', onWin);
    try {
      const panel = screen.getByTestId('me305-board');
      panel.focus();
      const tap = (key: string, code: string) => {
        const down = fireEvent.keyDown(panel, { key, code });
        fireEvent.keyUp(panel, { key, code });
        return down;
      };
      expect(tap('7', 'Digit7')).toBe(false); // default prevented
      tap('a', 'KeyA');
      tap('F', 'KeyF');
      tap('Enter', 'Enter');
      tap('Backspace', 'Backspace');
      expect(tap('F1', 'F1')).toBe(false);
      tap('F2', 'F2');
      // not mapped: G, Ctrl+A, F5
      expect(tap('g', 'KeyG')).toBe(true);
      fireEvent.keyDown(panel, { key: 'a', code: 'KeyA', ctrlKey: true });
      fireEvent.keyDown(panel, { key: 'F5', code: 'F5' });
      // auto-repeat does not press again
      fireEvent.keyDown(panel, { key: '1', code: 'Digit1' });
      fireEvent.keyDown(panel, { key: '1', code: 'Digit1', repeat: true });
      fireEvent.keyUp(panel, { key: '1', code: 'Digit1' });
      await waitFor(() =>
        expect(boardCalls(m)).toEqual([
          'pressKey:7', 'releaseKey:7',
          'pressKey:A', 'releaseKey:A',
          'pressKey:F', 'releaseKey:F',
          'pressKey:ENT', 'releaseKey:ENT',
          'pressKey:BKSP', 'releaseKey:BKSP',
          'pressKey:F1', 'releaseKey:F1',
          'pressKey:F2', 'releaseKey:F2',
          'pressKey:1', 'releaseKey:1',
        ]),
      );
      expect(winKeys).toEqual(['g', 'a', 'F5']);
    } finally {
      window.removeEventListener('keydown', onWin);
    }
  });

  it('losing focus releases keyboard-held keys; mapping can be turned off in settings', async () => {
    const { m } = setup();
    const panel = screen.getByTestId('me305-board');
    panel.focus();
    fireEvent.keyDown(panel, { key: '3', code: 'Digit3' });
    fireEvent.blur(panel);
    await waitFor(() => expect(boardCalls(m)).toEqual(['pressKey:3', 'releaseKey:3']));
    act(() => m.emit('settings', 'changed', { debugger: { keyboardToKeypad: false } } as never));
    expect(fireEvent.keyDown(panel, { key: '4', code: 'Digit4' })).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(boardCalls(m)).toEqual(['pressKey:3', 'releaseKey:3']);
  });

  it('closing the panel releases keys still held with the mouse or the keyboard', async () => {
    const m = createMockS12();
    const { unmount } = setup(m);
    fireEvent.mouseDown(screen.getByTestId('key-7'), { button: 0 });
    const panel = screen.getByTestId('me305-board');
    fireEvent.keyDown(panel, { key: 'F2', code: 'F2' });
    await waitFor(() => expect(boardCalls(m)).toEqual(['pressKey:7', 'pressKey:F2']));
    unmount();
    await waitFor(() => expect(boardCalls(m).slice(2).sort()).toEqual(['releaseKey:7', 'releaseKey:F2']));
    expect(boardCalls(m)).toHaveLength(4);
  });

  it('keypadLabelFor uses the engine key table pcKeys', () => {
    const keys = defaultKeys();
    expect(keypadLabelFor({ key: 'Delete', ctrlKey: false, altKey: false, metaKey: false }, keys)).toBe('BKSP');
    expect(keypadLabelFor({ key: 'c', ctrlKey: false, altKey: false, metaKey: false }, keys)).toBe('C');
    expect(keypadLabelFor({ key: 'F1', ctrlKey: false, altKey: true, metaKey: false }, keys)).toBeNull();
    expect(keypadLabelFor({ key: 'x', ctrlKey: false, altKey: false, metaKey: false }, keys)).toBeNull();
  });
});

describe('ME305 LEDs and readouts', () => {
  it('shows PP7..PP4 (R G R G) with the on/off state of the board', () => {
    const { m } = setup();
    act(() => m.emit('board', 'state', board({ leds: leds(['PP4', 'PP7']) })));
    const els = screen.getAllByTestId(/^led-PP/);
    expect(els.map((e) => e.getAttribute('data-testid'))).toEqual(['led-PP7', 'led-PP6', 'led-PP5', 'led-PP4']);
    expect(els.map((e) => e.getAttribute('data-color'))).toEqual(['red', 'green', 'red', 'green']);
    expect(els.map((e) => e.getAttribute('data-on'))).toEqual(['1', '0', '0', '1']);
    expect(els.map((e) => e.getAttribute('data-lit'))).toEqual(['1', '0', '0', '1']);
  });

  it('keeps an LED lit for a short persistence after it turns off (fast blinking stays visible)', () => {
    vi.useFakeTimers();
    try {
      let t = 1000;
      const now = () => t;
      const { rerender } = render(<Leds leds={leds(['PP5'])} now={now} />);
      expect(screen.getByTestId('led-PP5')).toHaveAttribute('data-lit', '1');
      t += 33;
      rerender(<Leds leds={leds([])} now={now} />);
      expect(screen.getByTestId('led-PP5')).toHaveAttribute('data-on', '0');
      expect(screen.getByTestId('led-PP5')).toHaveAttribute('data-lit', '1');
      t += PERSIST_MS;
      act(() => vi.advanceTimersByTime(PERSIST_MS + 1));
      expect(screen.getByTestId('led-PP5')).toHaveAttribute('data-lit', '0');
      // engine-reported duty sets the brightness
      rerender(<Leds leds={leds([]).map((l) => (l.pin === 'PP6' ? { ...l, onFraction: 0.5 } : l))} now={now} />);
      expect(screen.getByTestId('led-PP6')).toHaveAttribute('data-lit', '1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows encoder, DAC and motor values', () => {
    const { m } = setup();
    act(() =>
      m.emit(
        'board',
        'state',
        board({
          encoderCount: 0xfffe,
          dac: { a: 2.5, b: 1.25 },
          motor: { current: 0.1234, omega: 10, rpm: 95.5, angle: Math.PI / 2, volts: 6, duty: 0.5, direction: 1, enabled: true, encoderEdges: 0, senseVolts: 0 },
        }),
      ),
    );
    expect(screen.getByTestId('encoder-count')).toHaveTextContent('-2');
    expect(screen.getByTestId('dac-A')).toHaveTextContent('2.500 V');
    expect(screen.getByTestId('dac-B')).toHaveTextContent('1.250 V');
    expect(screen.getByTestId('motor-rpm')).toHaveTextContent('95.5 rpm');
    expect(screen.getByTestId('motor-current')).toHaveTextContent('123.4 mA');
    expect(screen.getByTestId('motor-enabled')).toHaveTextContent('ENABLED');
    expect(screen.getByTestId('me305-motor-disc')).toHaveAttribute('data-angle', '90.0');
  });

  it('pulls the board state on mount and reports when there is no board', async () => {
    const m = createMockS12({ board: { state: async () => board({ encoderCount: 42 }) } });
    setup(m);
    await waitFor(() => expect(screen.getByTestId('encoder-count')).toHaveTextContent('42'));
    act(() => m.emit('board', 'state', board({ present: false })));
    expect(screen.getByTestId('me305-status')).toHaveTextContent('no simulated board');
  });
});

describe('ME305 board fit-to-window', () => {
  it('scales the natural layout to the window, clamped; unknown sizes keep 1:1', () => {
    expect(fitScale({ w: 700, h: 330 }, { w: 800, h: 400 })).toBe(0.825);
    expect(fitScale({ w: 1600, h: 1200 }, { w: 800, h: 400 })).toBe(MAX_SCALE);
    expect(fitScale({ w: 100, h: 100 }, { w: 800, h: 400 })).toBe(MIN_SCALE);
    expect(fitScale({ w: 0, h: 0 }, { w: 800, h: 400 })).toBe(1);
    expect(fitScale({ w: 900, h: 450 }, { w: 0, h: 0 })).toBe(1);
  });

  it('without ResizeObserver (jsdom) the board is drawn unscaled', () => {
    setup();
    expect(document.querySelector('.me305-unit')).toHaveAttribute('data-scale', '1');
  });
});
