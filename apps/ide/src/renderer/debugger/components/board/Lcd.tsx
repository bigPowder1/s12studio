/**
 * 40x2 HD44780-style character LCD of the ME3305 benchtop unit, drawn as an SVG dot matrix (5x8 dots per character,
 * yellow-green backlight, dark dots). One <g> per character cell with two paths (dark dots, faint unlit dots); cells
 * are memoized so a snapshot only redraws the characters that changed.
 *
 * Cursor: underline on dot row 8; blink = whole cell alternates with an all-dots block (~0.4 s phases, real time).
 * UNCERTAIN: the board state does not say whether the underline cursor (C) is on when the blink (B) is on; without
 * `cursorOn` the underline is drawn only when blink is off.
 */
import { memo, useMemo } from 'react';
import type { LcdState } from '../../../../shared/api';
import { useTicker } from '../../../common/s12';
import { glyphRows, type GlyphRows } from './lcdFont';

export const LCD_COLS = 40;
export const LCD_ROWS = 2;
const PITCH = 1;
const DOT = 0.84;
const CELL_W = 6; // 5 dots + 1 gap
const CELL_H = 10; // 8 dots + 2 gap
const MARGIN = 2;
const W = MARGIN * 2 + LCD_COLS * CELL_W - 1;
const H = MARGIN * 2 + LCD_ROWS * CELL_H - 2;
/** HD44780 blink phase (409.6 ms at fosc = 250 kHz). */
export const BLINK_MS = 410;

const BLOCK: GlyphRows = [0x1f, 0x1f, 0x1f, 0x1f, 0x1f, 0x1f, 0x1f, 0x1f];

function dotsPath(rows: GlyphRows, lit: boolean): string {
  let d = '';
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 5; c++) {
      const on = ((rows[r] ?? 0) >> (4 - c)) & 1;
      if ((on === 1) === lit) d += `M${c * PITCH} ${r * PITCH}h${DOT}v${DOT}h-${DOT}z`;
    }
  }
  return d;
}

const pathCache = new Map<string, [string, string]>();
function paths(rows: GlyphRows): [string, string] {
  const key = rows.join(',');
  let p = pathCache.get(key);
  if (!p) {
    p = [dotsPath(rows, true), dotsPath(rows, false)];
    pathCache.set(key, p);
  }
  return p;
}

interface CellProps {
  ch: string;
  row: number;
  col: number;
  /** Glyph rows key (CGRAM content for custom characters). */
  rows: GlyphRows;
  underline: boolean;
  block: boolean;
}

const Cell = memo(function Cell({ ch, row, col, rows, underline, block }: CellProps) {
  let shown = block ? BLOCK : rows;
  if (underline && !block) shown = [...shown.slice(0, 7), 0x1f];
  const [lit, unlit] = paths(shown);
  return (
    <g transform={`translate(${MARGIN + col * CELL_W} ${MARGIN + row * CELL_H})`} data-char={ch} data-row={row} data-col={col} data-cursor={underline || block ? (block ? 'block' : 'underline') : undefined}>
      <path d={unlit} className="me3305-lcd-dot-off" />
      <path d={lit} className="me3305-lcd-dot-on" />
    </g>
  );
});

/** Pad/cut a line to exactly 40 characters (code points). */
export function lcdLine(text: string | undefined): string[] {
  const chars = [...(text ?? '')].slice(0, LCD_COLS);
  while (chars.length < LCD_COLS) chars.push(' ');
  return chars;
}

export function Lcd({ lcd, cursorOn }: { lcd: LcdState | null; cursorOn?: boolean }) {
  const blinking = !!lcd && lcd.displayOn && lcd.cursorVisible && lcd.blinkOn;
  const tick = useTicker(BLINK_MS, blinking);
  const blockPhase = blinking && tick % 2 === 0;
  const lines = useMemo(() => Array.from({ length: LCD_ROWS }, (_, r) => lcdLine(lcd?.displayOn ? lcd.lines[r] : '')), [lcd]);
  const cursor = lcd?.displayOn && lcd.cursorVisible ? lcd.cursor : null;
  const underlineOn = cursorOn ?? lcd?.cursorOn ?? !lcd?.blinkOn;
  const cg = lcd?.cgram ?? null;
  return (
    <div className={`me3305-lcd${lcd?.displayOn ? '' : ' off'}`} data-testid="me3305-lcd" data-display={lcd ? (lcd.displayOn ? 'on' : 'off') : 'none'}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={lines.map((l) => l.join('').trimEnd()).join('\n')}>
        <rect x={0} y={0} width={W} height={H} className="me3305-lcd-glass" />
        {lines.map((chars, r) =>
          chars.map((ch, c) => {
            const here = !!cursor && cursor.row === r && cursor.col === c;
            return <Cell key={`${r}:${c}`} ch={ch} row={r} col={c} rows={glyphRows(ch, cg)} underline={here && underlineOn} block={here && blockPhase} />;
          }),
        )}
      </svg>
      {/* plain-text copy of the display (screen readers, copy, tests) */}
      {lines.map((chars, r) => (
        <div key={r} className="me3305-sr-only" data-testid={`lcd-row-${r}`}>
          {chars.join('')}
        </div>
      ))}
    </div>
  );
}
