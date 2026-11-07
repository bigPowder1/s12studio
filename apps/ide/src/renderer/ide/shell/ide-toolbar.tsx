/**
 * IDE main toolbar, CodeWarrior 5.1 (19 buttons, left to right as in the 5.1 screenshot; readings confirmed by the
 * owner). Every button is a view of a menu command from ideMenus(): it runs that command's onSelect, is disabled when
 * the command is disabled (or absent, e.g. Window > project entry without a project) and shows its shortcut in the
 * tooltip, so the toolbar never needs its own enable logic. A disabled button keeps its colour icon (see below).
 */
import type { ReactNode } from 'react';
import { ToolButton, Toolbar } from '../../common/controls';
import { findCommand, type TopMenu } from '../../common/menu/model';
import { IdeToolbarIcons as I } from './ide-toolbar-icons';

export interface IdeToolSpec {
  /** data-testid ("tb-make"). */
  testId: string;
  /** Tooltip name; the menu command's shortcut is appended ("Make (F7)"). */
  name: string;
  /** ideMenus() command id the button mirrors. */
  menuId: string;
  icon: ReactNode;
}

// UNCERTAIN: no separators. The 5.1 screenshot shows the 19 buttons evenly spaced with no group gaps or etched lines.
export const IDE_TOOLBAR: readonly IdeToolSpec[] = [
  { testId: 'tb-new', name: 'New Text File', menuId: 'file.newText', icon: I.newText },
  { testId: 'tb-new-project', name: 'New...', menuId: 'file.new', icon: I.newProject },
  { testId: 'tb-open', name: 'Open', menuId: 'file.open', icon: I.open },
  { testId: 'tb-save', name: 'Save', menuId: 'file.save', icon: I.save },
  { testId: 'tb-undo', name: 'Undo', menuId: 'edit.undo', icon: I.undo },
  { testId: 'tb-redo', name: 'Redo', menuId: 'edit.redo', icon: I.redo },
  { testId: 'tb-cut', name: 'Cut', menuId: 'edit.cut', icon: I.cut },
  { testId: 'tb-copy', name: 'Copy', menuId: 'edit.copy', icon: I.copy },
  { testId: 'tb-paste', name: 'Paste', menuId: 'edit.paste', icon: I.paste },
  { testId: 'tb-find', name: 'Find', menuId: 'search.find', icon: I.find },
  { testId: 'tb-find-next', name: 'Find Next', menuId: 'search.findNext', icon: I.findNext },
  { testId: 'tb-replace', name: 'Replace', menuId: 'search.replace', icon: I.replace },
  // UNCERTAIN: #13 read as "bring the project window forward" (Window > 0 <project>.mcp)
  { testId: 'tb-project', name: 'Project Window', menuId: 'window.project', icon: I.projectWindow },
  // the button students use most: builds the target without opening the debugger
  { testId: 'tb-make', name: 'Make', menuId: 'project.make', icon: I.make },
  { testId: 'tb-stop', name: 'Stop Build', menuId: 'project.stopBuild', icon: I.stopBuild },
  { testId: 'tb-debug', name: 'Debug', menuId: 'project.debug', icon: I.debug },
  // UNCERTAIN: #17 read as View > Errors & Warnings Window
  { testId: 'tb-errors', name: 'Errors & Warnings Window', menuId: 'view.errors', icon: I.errors },
  // UNCERTAIN: #18 read as Project > Compile (the active/selected source file)
  { testId: 'tb-compile', name: 'Compile', menuId: 'project.compile', icon: I.compile },
  { testId: 'tb-settings', name: 'Target Settings', menuId: 'edit.targetSettings', icon: I.targetSettings },
];

// UNCERTAIN: disabled buttons are not greyed. The 5.1 screenshot (no project open, nothing building) shows every
// button in colour, Stop Build's red octagon and Save/Undo/Cut/Paste included, so the IDE toolbar seems never to grey
// its icons: a disabled button only ignores clicks and shows no hover bevel (ide.css `.ide-toolbar`). The menus do grey.
export function IdeToolbar({ menus }: { menus: readonly TopMenu[] }) {
  return (
    <Toolbar testId="ide-toolbar" className="ide-toolbar">
      {IDE_TOOLBAR.map((t) => {
        const c = findCommand(menus, t.menuId);
        const disabled = !c?.onSelect || !!c.disabled;
        return (
          <ToolButton
            key={t.testId}
            testId={t.testId}
            title={c?.shortcut ? `${t.name} (${c.shortcut})` : t.name}
            icon={t.icon}
            disabled={disabled}
            onClick={() => c?.onSelect?.()}
          />
        );
      })}
    </Toolbar>
  );
}
