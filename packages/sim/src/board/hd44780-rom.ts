/**
 * HD44780 character generator ROM "A00" (Japanese standard font) as Unicode, for rendering the LCD as text.
 * Codes $00-$0F select CGRAM glyphs (code & 7 for 5x8 fonts); they are rendered as private-use characters
 * U+E000..U+E007 so a UI can substitute the user-defined bitmaps.
 */

/** First private-use code point used for CGRAM glyphs (glyph n -> CGRAM_BASE + n). */
export const CGRAM_BASE = 0xe000;

function buildA00(): string[] {
  const t: string[] = new Array(256).fill(' ');
  for (let c = 0; c < 16; c++) t[c] = String.fromCodePoint(CGRAM_BASE + (c & 7));
  for (let c = 0x20; c < 0x7e; c++) t[c] = String.fromCharCode(c);
  // A00 differences from ASCII.
  t[0x5c] = '¥'; // yen sign in place of backslash
  t[0x7e] = '→'; // right arrow
  t[0x7f] = '←'; // left arrow
  // $A1-$DF: half-width katakana and punctuation map 1:1 onto U+FF61..U+FF9F.
  for (let c = 0xa1; c <= 0xdf; c++) t[c] = String.fromCharCode(0xff61 + (c - 0xa1));
  // $E0-$FF: Greek/math row. UNCERTAIN: several glyphs have no exact Unicode equivalent (closest shown).
  const hi = [
    'α', 'ä', 'β', 'ε', 'μ', 'σ', 'ρ', 'g',
    '√', '⁻', 'j', 'ˣ', '¢', '£', 'ñ', 'ö',
    'p', 'q', 'θ', '∞', 'Ω', 'ü', 'Σ', 'π',
    'x̄', 'y', '千', '万', '円', '÷', ' ', '█',
  ];
  for (let i = 0; i < 32; i++) t[0xe0 + i] = hi[i];
  // $10-$1F, $80-$A0 are blank in A00.
  return t;
}

/** Character code -> display string (one grapheme). */
export const HD44780_A00: readonly string[] = buildA00();
