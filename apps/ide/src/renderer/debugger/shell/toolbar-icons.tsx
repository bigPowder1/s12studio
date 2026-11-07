/**
 * Original 16x16 toolbar icons for the debugger (no NXP artwork), merged over common/icons. The toolbar glyphs are
 * drawn in hiwave's style (same metaphors and Windows 16-colour palette: bright green Start, blue step arrows over a
 * black "code line", red Reset ring, yellow folder/'?'), but are our own drawings, not traced bitmaps.
 */
import type { ReactNode } from 'react';
import { Icons } from '../../common/icons';

/** `crisp` (default) snaps straight edges to pixels like a toolbar bitmap; curved glyphs turn it off. */
const Svg = ({ children, crisp = true }: { children: ReactNode; crisp?: boolean }) => (
  <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden shapeRendering={crisp ? 'crispEdges' : undefined}>
    {children}
  </svg>
);

// Windows 16-colour palette (what the hiwave toolbar bitmap uses).
const BLACK = '#000000';
const BLUE = '#0000ff';
const NAVY = '#000080';
const GREEN = '#00ff00';
const RED = '#ff0000';
const YELLOW = '#ffff00';
const OLIVE = '#808000';
const SILVER = '#c0c0c0';
const WHITE = '#ffffff';
const SMOOTH = 'geometricPrecision';

/** The black "code line" the step arrows act on: a ledge with a sunken slot (the current line) in the middle. */
const codeLine = <path d="M1 10H6V13H10V10H15V12H12V15H4V12H1Z" fill={BLACK} />;

/** Short text lines on a page (copy/paste). */
const lines = (x: number, y: number, w: number, n: number) =>
  Array.from({ length: n }, (_, i) => <rect key={i} x={x} y={y + 2 * i} width={w} height={1} fill={NAVY} />);

/** hiwave default-toolbar glyphs, keyed like toolbar.ts `icon`. */
const hiwave = {
  /** White page with a folded corner. */
  newFile: (
    <Svg>
      <path d="M3.5 1.5H10.5L13.5 4.5V14.5H3.5Z" fill={WHITE} stroke={BLACK} />
      <path d="M10.5 1.5V4.5H13.5" fill="none" stroke={BLACK} />
    </Svg>
  ),
  /** Yellow folder opening, with a curved arrow over it. */
  open: (
    <Svg>
      <path d="M1.5 3.5H5.5L6.5 4.5H11.5V7.5H4.5L1.5 13.5Z" fill={OLIVE} stroke={BLACK} />
      <path d="M1.5 13.5L4.5 7.5H15.5L12.5 13.5Z" fill={YELLOW} stroke={BLACK} />
      <path d="M7.6 4.6C8.4 1.4 12 0.6 13.8 3.2" fill="none" stroke={BLACK} strokeWidth={1.4} shapeRendering={SMOOTH} />
      <path d="M11.4 3.2H16L13.8 6.6Z" fill={BLACK} shapeRendering={SMOOTH} />
    </Svg>
  ),
  /** Floppy disk: black body, olive label, grey shutter with its slot. */
  save: (
    <Svg>
      <path d="M1 1H14L15 2V15H1Z" fill={BLACK} />
      <rect x={3} y={2} width={10} height={6} fill={OLIVE} />
      <rect x={4} y={3} width={8} height={1} fill={WHITE} />
      <rect x={4} y={10} width={8} height={5} fill={SILVER} />
      <rect x={9} y={11} width={2} height={3} fill={BLACK} />
    </Svg>
  ),
  /** Scissors: two finger loops, crossed blades. */
  cut: (
    <Svg crisp={false}>
      <circle cx={4.8} cy={12} r={2.2} fill="none" stroke={BLACK} strokeWidth={1.4} />
      <circle cx={11.2} cy={12} r={2.2} fill="none" stroke={BLACK} strokeWidth={1.4} />
      <path d="M6 10.2L10.6 1.2M10 10.2L5.4 1.2" stroke={BLACK} strokeWidth={1.4} />
    </Svg>
  ),
  /** Two overlapping written pages. */
  copy: (
    <Svg>
      <path d="M1.5 1.5H6.5L8.5 3.5V10.5H1.5Z" fill={WHITE} stroke={BLACK} />
      {lines(3, 4, 4, 3)}
      <path d="M6.5 5.5H11.5L13.5 7.5V14.5H6.5Z" fill={WHITE} stroke={BLACK} />
      {lines(8, 8, 4, 3)}
    </Svg>
  ),
  /** Olive clipboard with a grey clip and a written page on it. */
  paste: (
    <Svg>
      <rect x={1.5} y={2.5} width={10} height={11} fill={OLIVE} stroke={BLACK} />
      <rect x={4.5} y={1.5} width={4} height={3} fill={SILVER} stroke={BLACK} />
      <path d="M7.5 6.5H12.5L14.5 8.5V14.5H7.5Z" fill={WHITE} stroke={BLACK} />
      {lines(9, 9, 4, 3)}
    </Svg>
  ),
  /** Yellow question mark with a black outline. */
  help: (
    <Svg crisp={false}>
      <path d="M4.6 5.6C4.6 1.6 11.4 1.6 11.4 5.2C11.4 7.6 8 7.6 8 10.4" fill="none" stroke={BLACK} strokeWidth={4} />
      <path d="M4.6 5.6C4.6 1.6 11.4 1.6 11.4 5.2C11.4 7.6 8 7.6 8 10.4" fill="none" stroke={YELLOW} strokeWidth={2} />
      <rect x={6} y={11.6} width={4} height={3.6} fill={YELLOW} stroke={BLACK} />
    </Svg>
  ),
  /** Black mouse pointer with a navy question mark (What's This? help). */
  contextHelp: (
    <Svg crisp={false}>
      <path d="M1 1V13L3.9 10.3L6 14.8L7.9 13.9L5.8 9.5H9.6Z" fill={BLACK} />
      <path d="M9.4 4.4C9.4 1.5 14.6 1.5 14.6 4.2C14.6 6.1 12 6 12 8.6" fill="none" stroke={NAVY} strokeWidth={1.8} />
      <rect x={11.1} y={10} width={1.8} height={1.8} fill={NAVY} />
    </Svg>
  ),
  /** Start/Continue: bright green arrow pointing right. */
  go: (
    <Svg>
      <path d="M1 6H8V2L14 8L8 14V10H1Z" fill={GREEN} />
    </Svg>
  ),
  /** Single Step: blue arrow comes in from the left and steps down into the current line. */
  step: (
    <Svg>
      {codeLine}
      <path d="M1 2H9V7H11.5L8 11L4.5 7H7V4H1Z" fill={BLUE} />
    </Svg>
  ),
  /** Step Over: blue arrow rising from the left and running straight over the current line (square, as in hiwave). */
  stepOver: (
    <Svg>
      {codeLine}
      <path d="M1 8V3H10V0L14 4L10 8V5H3V8Z" fill={BLUE} />
    </Svg>
  ),
  /** Step Out: blue arrow rising out of the current line's slot, then away to the right. */
  stepOut: (
    <Svg>
      {codeLine}
      <path d="M7 13V3H11V0L15 4L11 8V5H9V13Z" fill={BLUE} />
    </Svg>
  ),
  /** Assembly Step: a small dotted blue loop (one instruction) dropping into the current line. */
  asmStep: (
    <Svg>
      {codeLine}
      <circle cx={8} cy={3.8} r={2.8} fill="none" stroke={BLUE} strokeWidth={1.6} strokeDasharray="2.2 1.1" shapeRendering={SMOOTH} />
      <path d="M5 7H11L8 10.5Z" fill={BLUE} />
    </Svg>
  ),
  /** Halt: a bar running into a stop post. */
  halt: (
    <Svg>
      <rect x={2} y={7} width={10} height={3} fill={BLACK} />
      <rect x={11} y={3} width={3} height={11} fill={BLACK} />
    </Svg>
  ),
  /** Reset Target: black arrow driving into a red ring. */
  reset: (
    <Svg>
      <circle cx={9.5} cy={8} r={5} fill="none" stroke={RED} strokeWidth={2} shapeRendering={SMOOTH} />
      <path d="M1 7H7V4L11 8L7 12V9H1Z" fill={BLACK} />
    </Svg>
  ),
} as const;

/** Icon keys of the hiwave toolbar glyphs (every TOOLBAR_IDS entry in toolbar.ts uses one of these). */
export const HIWAVE_TOOLBAR_ICON_KEYS = Object.keys(hiwave) as readonly (keyof typeof hiwave)[];

const extra = {
  ...hiwave,
  /** Component window system icon (caption). */
  component: (
    <Svg crisp={false}>
      <rect x="1.5" y="2.5" width="13" height="11" fill="#fff" stroke="#404040" />
      <rect x="1.5" y="2.5" width="13" height="3" fill="#0a246a" />
    </Svg>
  ),
} as const;

/** common/icons with the hiwave glyphs above taking precedence (the IDE keeps the common ones). */
export const ToolbarIcons: Record<string, ReactNode> = { ...Icons, ...extra };

/** id of the SVG filter that draws a disabled button's glyph embossed (see DisabledGlyphFilter). */
export const DISABLED_GLYPH_FILTER_ID = 's12-dbg-tb-disabled';

/**
 * Windows' disabled toolbar glyph: the glyph's dark pixels (light ones -- white page fills, yellow -- drop out) drawn
 * in the 3D shadow grey over a copy in white offset 1px down-right, so it looks etched into the button face.
 * Rendered once (zero-size) inside the toolbar; debugger-toolbar.css applies it to disabled buttons' SVGs.
 * UNCERTAIN: the light/dark cut-off (luminance 0.75) is a judgement call against the reference screenshot.
 */
export function DisabledGlyphFilter() {
  return (
    <svg width={0} height={0} aria-hidden focusable="false" style={{ position: 'absolute', overflow: 'hidden' }}>
      <filter id={DISABLED_GLYPH_FILTER_ID} x="-10%" y="-10%" width="130%" height="130%" colorInterpolationFilters="sRGB">
        {/* alpha = darkness (1 - luminance), kept only where the glyph is opaque, then cut to 0/1 */}
        <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -0.299 -0.587 -0.114 0 1" result="dark" />
        <feComposite in="dark" in2="SourceAlpha" operator="in" result="darkOnly" />
        <feComponentTransfer in="darkOnly" result="mask">
          <feFuncA type="discrete" tableValues="0 1 1 1" />
        </feComponentTransfer>
        <feFlood style={{ floodColor: 'var(--cw-face-light, #ffffff)' }} result="hiColor" />
        <feComposite in="hiColor" in2="mask" operator="in" result="hiMask" />
        <feOffset in="hiMask" dx="1" dy="1" result="hi" />
        <feFlood style={{ floodColor: 'var(--cw-face-shadow, #808080)' }} result="shColor" />
        <feComposite in="shColor" in2="mask" operator="in" result="sh" />
        <feMerge>
          <feMergeNode in="hi" />
          <feMergeNode in="sh" />
        </feMerge>
      </filter>
    </svg>
  );
}
