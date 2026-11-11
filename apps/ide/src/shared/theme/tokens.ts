/**
 * Theme tokens of the classic Win2000/XP-era CodeWarrior / hiwave look. The CSS custom properties in
 * src/renderer/common/theme.css use the same names (`--cw-<key>`); TS code (canvas drawing, Monaco theme, xterm
 * theme) reads them from here.
 */
export const THEME = {
  face: '#d4d0c8', // 3D face (button/menu/chrome grey)
  faceLight: '#ffffff', // bevel highlight
  faceShadow: '#808080', // bevel shadow
  faceDarkShadow: '#404040',
  window: '#ffffff', // client area of list/edit views
  windowText: '#000000',
  grayText: '#808080',
  highlight: '#0a246a', // selection (Win2000 classic)
  highlightText: '#ffffff',
  activeCaption: '#0a246a',
  activeCaptionGradient: '#a6caf0',
  inactiveCaption: '#808080',
  inactiveCaptionGradient: '#c0c0c0',
  captionText: '#ffffff',
  /** hiwave: values changed since the last refresh. */
  changed: '#ff0000',
  /** hiwave Source/Assembly: current PC line. */
  pcLine: '#0000ff',
  pcLineText: '#ffffff',
  breakpoint: '#ff0000',
  /** Debugger Source chroma coding (debugger manual): keywords blue, comments green, strings red. */
  syntaxKeyword: '#0000ff',
  syntaxComment: '#008000',
  syntaxString: '#ff0000',
  /** Command component: echo blue, errors red, FCS warnings green. */
  cmdEcho: '#0000ff',
  cmdError: '#ff0000',
  cmdWarning: '#008000',
  uiFont: "Tahoma, 'MS Sans Serif', 'Microsoft Sans Serif', 'Segoe UI', Arial, sans-serif",
  uiFontSize: '11px',
  /** The only code font (editor, debugger, errors, board). Consolas: Courier New's hairline strokes strain the eyes. */
  monoFont: "Consolas, Menlo, 'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', monospace",
  monoFontSize: '12px',
} as const;

export type ThemeKey = keyof typeof THEME;
