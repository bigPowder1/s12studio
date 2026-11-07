/**
 * Original 16x16 colour icons for the IDE main toolbar, drawn for S12 Studio in the style of the CodeWarrior 5.1
 * toolbar (same metaphors and the classic 16-colour Windows palette: navy, olive, yellow, red, green). Nothing here is
 * traced from or copied out of NXP/Metrowerks bitmaps.
 */
import type { ReactNode } from 'react';

const Svg = ({ children }: { children: ReactNode }) => (
  <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden shapeRendering="geometricPrecision">
    {children}
  </svg>
);

const NAVY = '#000080';
const OLIVE = '#808040';
const YELLOW = '#ffd800';

/** Yellow "new" sparkle centred on (3, 3). */
const sparkle = <path d="M3 0v6M0 3h6M1 1l4 4M5 1L1 5" stroke={YELLOW} strokeWidth="1.1" />;

/** Yellow/black hazard band down the left edge: CodeWarrior's mark for project/target windows. */
const hazard = (
  <>
    <rect x="1" y="1" width="3" height="14" fill={YELLOW} stroke="#000" strokeWidth="0.6" />
    <path d="M1 3.5l3-2v2l-3 2zM1 7.5l3-2v2l-3 2zM1 11.5l3-2v2l-3 2zM1 15l3-2v2z" fill="#000" />
  </>
);

/** White page with a magnifier over its top-left corner (Find family). */
const findPage = (
  <>
    <path d="M4.5 2.5h7l3 3v9h-10z" fill="#fff" stroke="#000" />
    <path d="M11.5 2.5v3h3" fill="none" stroke="#000" />
    <path d="M3.7 7.3L0.8 10.2" stroke="#000" strokeWidth="2" />
    <circle cx="6" cy="5" r="3.3" fill="#d6d6ff" stroke={NAVY} strokeWidth="1.2" />
  </>
);

/** Page with bullet lines (Compile, Target Settings). */
const bulletPage = (x: number) => (
  <>
    <path d={`M${x + 0.5} 1.5h${12.5 - x}l2 2v11h-${14.5 - x}z`} fill="#fff" stroke="#000" />
    <rect x={x + 2} y="5" width="2" height="2" fill="#000" />
    <rect x={x + 2} y="10" width="2" height="2" fill="#000" />
    <path d={`M${x + 5} 6.5h${8 - x}M${x + 5} 11.5h${8 - x}`} stroke={NAVY} />
  </>
);

export const IdeToolbarIcons = {
  /** New Text File: dark text page with the "new" sparkle. */
  newText: (
    <Svg>
      <path d="M4.5 2.5h6l3 3v9h-9z" fill="#3c4a6e" stroke="#000" />
      <path d="M10.5 2.5v3h3z" fill="#a8b4d0" stroke="#000" strokeLinejoin="round" />
      <path d="M6 8.5h6M6 10.5h6M6 12.5h4" stroke="#a8b4d0" />
      {sparkle}
    </Svg>
  ),
  /** New... (project wizard): window with the "new" sparkle. */
  newProject: (
    <Svg>
      <rect x="2.5" y="4.5" width="13" height="10" fill="#fff" stroke="#000" />
      <rect x="3" y="5" width="12" height="2.5" fill={NAVY} />
      {sparkle}
    </Svg>
  ),
  /** Open: olive folder opening, with a curved arrow out. */
  open: (
    <Svg>
      <path d="M1.5 14.5v-10h4l1 1h5v2" fill="#a0a040" stroke="#404000" />
      <path d="M1.5 14.5l3-7h11l-3 7z" fill="#e0e080" stroke="#404000" strokeLinejoin="round" />
      <path d="M8.5 4.5C9.5 1.5 12.5 1 14 3.5" fill="none" stroke="#000" strokeWidth="1.2" />
      <path d="M12.3 4.2l2.6 1 .5-2.8z" fill="#000" />
    </Svg>
  ),
  /** Save: dark olive floppy disk. */
  save: (
    <Svg>
      <path d="M1.5 1.5h12l1 1v12h-13z" fill="#5a5a3c" stroke="#000" />
      <rect x="4" y="2" width="8" height="5" fill="#e8e8d8" />
      <rect x="9" y="2.8" width="2" height="3.4" fill="#5a5a3c" />
      <rect x="4" y="10" width="8" height="4.5" fill="#a0a080" />
    </Svg>
  ),
  undo: (
    <Svg>
      <path d="M4 6.5h5.5a3.5 3.5 0 010 7H6.5" fill="none" stroke="#000" strokeWidth="2" />
      <path d="M0.5 6.5L5 2.5v8z" fill="#000" />
    </Svg>
  ),
  redo: (
    <Svg>
      <path d="M12 6.5H6.5a3.5 3.5 0 000 7h3" fill="none" stroke="#000" strokeWidth="2" />
      <path d="M15.5 6.5L11 2.5v8z" fill="#000" />
    </Svg>
  ),
  cut: (
    <Svg>
      <circle cx="4" cy="12" r="2.4" fill="none" stroke="#000" strokeWidth="1.4" />
      <circle cx="12" cy="12" r="2.4" fill="none" stroke="#000" strokeWidth="1.4" />
      <path d="M5.4 10L11.5 1M10.6 10L4.5 1" stroke="#000" strokeWidth="1.4" />
    </Svg>
  ),
  /** Copy: two text pages, navy edged. */
  copy: (
    <Svg>
      <path d="M1.5 1.5h5l2 2v7h-7z" fill="#fff" stroke={NAVY} />
      <path d="M3 4.5h3M3 6.5h4M3 8.5h4" stroke="#000" />
      <path d="M7.5 5.5h5l2 2v7h-7z" fill="#fff" stroke={NAVY} />
      <path d="M9 8.5h3M9 10.5h4M9 12.5h4" stroke="#000" />
    </Svg>
  ),
  /** Paste: olive clipboard with a page on it. */
  paste: (
    <Svg>
      <rect x="1.5" y="2.5" width="10" height="12" rx="1" fill={OLIVE} stroke="#3c3c10" />
      <rect x="4.5" y="1.5" width="4" height="3" fill="#c0c0c0" stroke="#000" />
      <path d="M7.5 6.5h5l2 2v6h-7z" fill="#fff" stroke={NAVY} />
      <path d="M9 9.5h4M9 11.5h4" stroke="#000" />
    </Svg>
  ),
  find: (
    <Svg>
      {findPage}
      <path d="M9 9.5h4M8 11.5h5M6 13.5h7" stroke="#808080" />
    </Svg>
  ),
  /** Find Next: magnifier page with a red "next" play mark. */
  findNext: (
    <Svg>
      {findPage}
      <path d="M8.5 8.5l5 3-5 3z" fill="#e00000" />
    </Svg>
  ),
  /** Replace: magnifier page with a pencil. */
  replace: (
    <Svg>
      {findPage}
      <path d="M6 13.5h3" stroke="#808080" />
      <path d="M9 14.5l.8-2.6 5-5 1.8 1.8-5 5z" fill="#e8a040" stroke="#000" strokeWidth="0.8" strokeLinejoin="round" />
      <path d="M9 14.5l.8-2.6 1.8 1.8z" fill="#000" />
    </Svg>
  ),
  /** Project window: hazard band beside a file grid. */
  projectWindow: (
    <Svg>
      {hazard}
      <rect x="5.5" y="2.5" width="10" height="11" fill="#fff" stroke="#000" />
      <path d="M6 5.5h9M6 8.5h9M6 11.5h9M9.5 3v10M12.5 3v10" stroke="#808080" />
    </Svg>
  ),
  /** Make: tilted page under a hammer. */
  make: (
    <Svg>
      <g transform="rotate(-35 7 10)">
        <rect x="1.5" y="6.5" width="10" height="7" fill="#fff" stroke="#000" />
        <path d="M3 9h7M3 11h5" stroke="#808080" />
      </g>
      <path d="M7.5 9.5L12.5 4.5" stroke="#8a5a20" strokeWidth="1.8" />
      <path d="M10 2.6l2.4-2.1 3.1 3.1-2.1 2.4z" fill={OLIVE} stroke="#303000" strokeWidth="0.8" strokeLinejoin="round" />
      <path d="M11.4 3.3l1.3 1.3" stroke="#40c040" strokeWidth="1.2" />
    </Svg>
  ),
  /** Stop Build: red stop sign over a grey build box. */
  stopBuild: (
    <Svg>
      <rect x="5.5" y="7.5" width="10" height="7" fill="#c0c0c0" stroke="#000" />
      <rect x="8" y="10" width="2" height="2" fill="#000" />
      <rect x="12" y="10" width="2" height="2" fill="#000" />
      <path d="M3.3 0.5h3.4L9 2.8v3.4L6.7 8.5H3.3L1 6.2V2.8z" fill="#e00000" stroke="#800000" />
      <path d="M2.8 4.5h4.4" stroke="#fff" strokeWidth="1.5" />
    </Svg>
  ),
  /** Debug: green go arrow with a small green bug below. */
  debug: (
    <Svg>
      <path d="M3.5 1v9.5" stroke="#004000" />
      <path d="M4 1.5l8 4-8 4z" fill="#00b000" stroke="#005000" strokeLinejoin="round" />
      <path d="M7 10.5l-1-1.5M10 10.5l0-1.6M7 14.5l-1 1M10 14.5l0 1.5" stroke="#003000" />
      <ellipse cx="8.5" cy="12.5" rx="3.6" ry="2.2" fill="#2a6a3a" stroke="#003000" />
      <circle cx="13.3" cy="12.5" r="1.3" fill="#2a6a3a" stroke="#003000" />
    </Svg>
  ),
  /** Errors & Warnings window: window with a yellow warning triangle. */
  errors: (
    <Svg>
      <rect x="1.5" y="1.5" width="13" height="13" fill="#fff" stroke="#000" />
      <rect x="2" y="2" width="12" height="2.5" fill={NAVY} />
      <path d="M8 5.5l4.5 8h-9z" fill={YELLOW} stroke="#000" strokeLinejoin="round" />
      <path d="M8 8v2.8" stroke="#000" strokeWidth="1.3" />
      <rect x="7.35" y="11.6" width="1.3" height="1.2" fill="#000" />
    </Svg>
  ),
  /** Compile (current file): page with bullet lines. */
  compile: <Svg>{bulletPage(2)}</Svg>,
  /** Target Settings: hazard band beside a page of settings. */
  targetSettings: (
    <Svg>
      {hazard}
      {bulletPage(5)}
    </Svg>
  ),
} as const;
