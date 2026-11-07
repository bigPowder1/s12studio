/**
 * hiwave's main toolbar (MFC CToolBar, classic non-flat style): raised 3D 23x22 buttons, groups split by a plain
 * 8px gap, disabled glyphs embossed. Buttons come from the connection .ini's TOOLBAR= (toolbar.ts); each mirrors its
 * menu command's enabled state (except New/Cut/Copy/Paste: toolbarDisabled() in toolbar.ts). Styling in debugger-toolbar.css (scoped to the debugger; the IDE toolbar is unchanged).
 */
import type { ToolbarItem } from './toolbar';
import { DisabledGlyphFilter, ToolbarIcons } from './toolbar-icons';
import './debugger-toolbar.css';

export interface DebuggerToolbarProps {
  items: readonly ToolbarItem[];
  /** Whether a menu command (toolbar.ts `command`) is currently disabled. */
  isDisabled: (command: string) => boolean;
  /** Run a menu command. */
  onCommand: (command: string) => void;
  testId?: string;
}

export function DebuggerToolbar({ items, isDisabled, onCommand, testId = 'debugger-toolbar' }: DebuggerToolbarProps) {
  return (
    <div className="cw-toolbar s12-dbg-toolbar" role="toolbar" data-testid={testId}>
      <DisabledGlyphFilter />
      {items.map((t, i) => {
        if ('separator' in t) return <span key={`sep${i}`} className="s12-dbg-tb-sep" role="separator" />;
        return (
          <button
            key={t.cmdId}
            type="button"
            className="s12-dbg-tb-btn"
            title={t.title}
            aria-label={t.title}
            disabled={isDisabled(t.command)}
            // as an MFC toolbar, a click does not take the focus: Cut/Copy/Paste act on the focused component
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onCommand(t.command)}
            data-testid={t.testId}
            data-icon={t.icon}
          >
            {ToolbarIcons[t.icon] ?? t.title}
          </button>
        );
      })}
    </div>
  );
}
