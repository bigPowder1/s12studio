/** Extra original 16x16 toolbar icons for the debugger (no NXP artwork), merged with common/icons. */
import type { ReactNode } from 'react';
import { Icons } from '../../common/icons';

const Svg = ({ children }: { children: ReactNode }) => (
  <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
    {children}
  </svg>
);

const extra = {
  cut: (
    <Svg>
      <circle cx="4.5" cy="12" r="2.2" fill="none" stroke="#202020" />
      <circle cx="11.5" cy="12" r="2.2" fill="none" stroke="#202020" />
      <path d="M5.5 10.5L11 2M10.5 10.5L5 2" stroke="#202020" />
    </Svg>
  ),
  copy: (
    <Svg>
      <path d="M2 2h6l2 2v7H2z" fill="#fff" stroke="#404040" />
      <path d="M6 5h6l2 2v7H6z" fill="#fff" stroke="#404040" />
    </Svg>
  ),
  paste: (
    <Svg>
      <rect x="2" y="3" width="9" height="11" fill="#c8a050" stroke="#6a4a10" />
      <rect x="5" y="2" width="3" height="2" fill="#808080" />
      <path d="M7 7h6l1 1v7H7z" fill="#fff" stroke="#404040" />
    </Svg>
  ),
  help: (
    <Svg>
      <circle cx="8" cy="8" r="6.5" fill="#fffbe0" stroke="#0b3a9a" />
      <text x="5" y="12" fontSize="10" fontWeight="bold" fontFamily="sans-serif" fill="#0b3a9a">
        ?
      </text>
    </Svg>
  ),
  contextHelp: (
    <Svg>
      <path d="M1 1v10l3-3 2 4 1.5-.7-2-4H9z" fill="#fff" stroke="#000" />
      <text x="9" y="14" fontSize="9" fontWeight="bold" fontFamily="sans-serif" fill="#0b3a9a">
        ?
      </text>
    </Svg>
  ),
  /** Component window system icon (caption). */
  component: (
    <Svg>
      <rect x="1.5" y="2.5" width="13" height="11" fill="#fff" stroke="#404040" />
      <rect x="1.5" y="2.5" width="13" height="3" fill="#0a246a" />
    </Svg>
  ),
} as const;

export const ToolbarIcons: Record<string, ReactNode> = { ...Icons, ...extra };
