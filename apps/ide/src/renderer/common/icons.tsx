/**
 * Original 16x16 toolbar/tree icons (simple SVG; no NXP artwork). Placeholder set; the shell tracks may refine them.
 */
import type { ReactNode } from 'react';

const Svg = ({ children, title }: { children: ReactNode; title?: string }) => (
  <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
    {title && <title>{title}</title>}
    {children}
  </svg>
);

export const Icons = {
  folder: (
    <Svg>
      <path d="M1 4h5l1 1h8v9H1z" fill="#f4d36b" stroke="#8a6d1d" />
    </Svg>
  ),
  file: (
    <Svg>
      <path d="M3 1h7l3 3v11H3z" fill="#fff" stroke="#555" />
      <path d="M10 1v3h3" fill="none" stroke="#555" />
    </Svg>
  ),
  /** Green right arrow: Start/Continue. */
  go: (
    <Svg>
      <path d="M4 2l9 6-9 6z" fill="#1a9a1a" stroke="#0b5a0b" />
    </Svg>
  ),
  /** Red square: Halt. */
  halt: (
    <Svg>
      <rect x="3" y="3" width="10" height="10" fill="#d42020" stroke="#7a0b0b" />
    </Svg>
  ),
  /** Red circle: Reset Target. */
  reset: (
    <Svg>
      <circle cx="8" cy="8" r="5.5" fill="#d42020" stroke="#7a0b0b" />
    </Svg>
  ),
  step: (
    <Svg>
      <path d="M3 3v6h7" fill="none" stroke="#0b3a9a" strokeWidth="2" />
      <path d="M9 6l4 3-4 3z" fill="#0b3a9a" />
    </Svg>
  ),
  stepOver: (
    <Svg>
      <path d="M2 10C3 3 11 3 12 9" fill="none" stroke="#0b3a9a" strokeWidth="2" />
      <path d="M9 8l4 2 1-4z" fill="#0b3a9a" />
      <rect x="2" y="12" width="12" height="2" fill="#555" />
    </Svg>
  ),
  stepOut: (
    <Svg>
      <path d="M8 13V4" stroke="#0b3a9a" strokeWidth="2" />
      <path d="M4 7l4-5 4 5z" fill="#0b3a9a" />
    </Svg>
  ),
  asmStep: (
    <Svg>
      <text x="1" y="12" fontSize="9" fontFamily="monospace" fill="#0b3a9a">
        A
      </text>
      <path d="M8 4l6 4-6 4z" fill="#0b3a9a" />
    </Svg>
  ),
  make: (
    <Svg>
      <rect x="2" y="6" width="12" height="8" fill="#c0c0c0" stroke="#404040" />
      <path d="M4 6V3h8v3" fill="none" stroke="#404040" />
    </Svg>
  ),
  debug: (
    <Svg>
      <path d="M2 2l8 6-8 6z" fill="#1a9a1a" />
      <circle cx="12" cy="10" r="3" fill="#8a3a0b" />
    </Svg>
  ),
  settings: (
    <Svg>
      <circle cx="8" cy="8" r="3" fill="none" stroke="#404040" strokeWidth="2" />
      <path d="M8 1v3M8 12v3M1 8h3M12 8h3" stroke="#404040" strokeWidth="2" />
    </Svg>
  ),
  sync: (
    <Svg>
      <path d="M3 8l3 3 7-8" fill="none" stroke="#c00" strokeWidth="2" />
    </Svg>
  ),
  open: (
    <Svg>
      <path d="M1 4h5l1 1h7v2H4l-3 7z" fill="#f4d36b" stroke="#8a6d1d" />
    </Svg>
  ),
  save: (
    <Svg>
      <rect x="2" y="2" width="12" height="12" fill="#3a5a9a" />
      <rect x="4" y="2" width="8" height="5" fill="#fff" />
    </Svg>
  ),
  newFile: (
    <Svg>
      <path d="M3 1h7l3 3v11H3z" fill="#fff" stroke="#555" />
      <path d="M11 9v5M8.5 11.5h5" stroke="#1a9a1a" strokeWidth="1.5" />
    </Svg>
  ),
  // ---- added by the IDE shell track (CodeWarrior IDE toolbar / project window) ----
  saveAll: (
    <Svg>
      <rect x="4" y="1" width="11" height="11" fill="#6a8acb" />
      <rect x="1" y="4" width="11" height="11" fill="#3a5a9a" stroke="#d4d0c8" />
      <rect x="3" y="4" width="7" height="4" fill="#fff" />
    </Svg>
  ),
  undo: (
    <Svg>
      <path d="M5 6h6a3 3 0 010 6H7" fill="none" stroke="#0b3a9a" strokeWidth="1.6" />
      <path d="M1 6l4-4v8z" fill="#0b3a9a" />
    </Svg>
  ),
  redo: (
    <Svg>
      <path d="M11 6H5a3 3 0 000 6h4" fill="none" stroke="#0b3a9a" strokeWidth="1.6" />
      <path d="M15 6l-4-4v8z" fill="#0b3a9a" />
    </Svg>
  ),
  cut: (
    <Svg>
      <circle cx="4.5" cy="12" r="2.3" fill="none" stroke="#202020" strokeWidth="1.3" />
      <circle cx="11.5" cy="12" r="2.3" fill="none" stroke="#202020" strokeWidth="1.3" />
      <path d="M6 10.5L11 1M10 10.5L5 1" stroke="#202020" strokeWidth="1.2" />
    </Svg>
  ),
  copy: (
    <Svg>
      <path d="M1 1h7l2 2v8H1z" fill="#fff" stroke="#555" />
      <path d="M6 5h7l2 2v8H6z" fill="#fff" stroke="#555" />
    </Svg>
  ),
  paste: (
    <Svg>
      <rect x="2" y="2" width="10" height="13" fill="#b8860b" stroke="#6b4a06" />
      <rect x="5" y="1" width="4" height="3" fill="#ccc" stroke="#555" />
      <path d="M7 6h7v9H7z" fill="#fff" stroke="#555" />
    </Svg>
  ),
  find: (
    <Svg>
      <circle cx="6" cy="6" r="4" fill="#e8f2ff" stroke="#202020" strokeWidth="1.5" />
      <path d="M9 9l5 5" stroke="#202020" strokeWidth="2.2" />
    </Svg>
  ),
  findInFiles: (
    <Svg>
      <path d="M1 1h7l2 2v10H1z" fill="#fff" stroke="#555" />
      <circle cx="10" cy="9" r="3" fill="#e8f2ff" stroke="#202020" strokeWidth="1.3" />
      <path d="M12 11l3 3" stroke="#202020" strokeWidth="2" />
    </Svg>
  ),
  /** Run: green arrow (no bug). */
  run: (
    <Svg>
      <path d="M3 2l10 6-10 6z" fill="#1a9a1a" stroke="#0b5a0b" />
    </Svg>
  ),
  /** Bug (project window Debug column header). */
  bug: (
    <Svg>
      <ellipse cx="8" cy="9.5" rx="3.5" ry="4.5" fill="#202020" />
      <circle cx="8" cy="4" r="2" fill="#202020" />
      <path d="M2 6l3 2M14 6l-3 2M2 10h3M14 10h-3M2 14l3-2M14 14l-3-2" stroke="#202020" strokeWidth="1.1" />
    </Svg>
  ),
  /** Red check mark: touch column (needs compiling). */
  touch: (
    <Svg>
      <path d="M2.5 8.5l3.5 3.5 7.5-9" fill="none" stroke="#d00000" strokeWidth="2.2" />
    </Svg>
  ),
  /** Chip: Change MCU/Connection. */
  chip: (
    <Svg>
      <rect x="4" y="4" width="8" height="8" fill="#303030" />
      <path d="M5 1v3M8 1v3M11 1v3M5 12v3M8 12v3M11 12v3M1 5h3M1 8h3M1 11h3M12 5h3M12 8h3M12 11h3" stroke="#808080" />
    </Svg>
  ),
  /** Project Inspector (i in a page). */
  inspector: (
    <Svg>
      <path d="M3 1h7l3 3v11H3z" fill="#fff" stroke="#555" />
      <circle cx="8" cy="5" r="1.2" fill="#0b3a9a" />
      <path d="M8 7.5v5" stroke="#0b3a9a" strokeWidth="2" />
    </Svg>
  ),
  compile: (
    <Svg>
      <path d="M3 1h7l3 3v11H3z" fill="#fff" stroke="#555" />
      <path d="M5 6h6M5 8h6M5 10h4" stroke="#0b3a9a" />
    </Svg>
  ),
  stop: (
    <Svg>
      <path d="M5 1h6l4 4v6l-4 4H5l-4-4V5z" fill="#d42020" stroke="#7a0b0b" />
      <path d="M5 8h6" stroke="#fff" strokeWidth="2" />
    </Svg>
  ),
  /** Active target marker (Targets tab). */
  target: (
    <Svg>
      <circle cx="8" cy="8" r="6" fill="#fff" stroke="#d42020" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="3" fill="#d42020" />
    </Svg>
  ),
  /** Inactive target marker. */
  targetInactive: (
    <Svg>
      <circle cx="8" cy="8" r="6" fill="#fff" stroke="#808080" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="3" fill="#c0c0c0" />
    </Svg>
  ),
  /** Text / document (editor files: .asm, .inc, .prm). */
  textFile: (
    <Svg>
      <path d="M3 1h7l3 3v11H3z" fill="#fff" stroke="#555" />
      <path d="M10 1v3h3" fill="none" stroke="#555" />
      <path d="M5 7h6M5 9h6M5 11h6" stroke="#9a9a9a" />
    </Svg>
  ),
  /** Library (.lib / .o). */
  library: (
    <Svg>
      <rect x="2" y="2" width="3" height="12" fill="#3a5a9a" />
      <rect x="6" y="2" width="3" height="12" fill="#9a3a3a" />
      <path d="M10 3l3-1 2 12-3 1z" fill="#3a9a5a" />
    </Svg>
  ),
} as const;
