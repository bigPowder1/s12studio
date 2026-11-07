/**
 * hiwave toolbar from the connection .ini (`[HI-WAVE] TOOLBAR=57600 57601 32795 0 ...`): a list of MFC command ids,
 * 0 = separator. The 576xx ids are standard MFC ids (afxres.h): ID_FILE_NEW 0xE100, ID_FILE_OPEN 0xE101,
 * ID_EDIT_COPY 0xE122, ID_EDIT_CUT 0xE123, ID_EDIT_PASTE 0xE125, ID_CONTEXT_HELP 0xE145, ID_DEFAULT_HELP 0xE147.
 * The 327xx ids are hiwave's own (docs/research/r1/ide.md §6 "Default toolbar").
 */
import { parseIni } from '@s12/formats';

/** Menu command id (see menus.ts) a toolbar button triggers; the button mirrors that command's enabled state. */
export interface ToolbarButtonDef {
  /** MFC command id from the ini. */
  cmdId: number;
  /** Menu command id in menus.ts. */
  command: string;
  /** Tooltip (also the accessible name). */
  title: string;
  /** Icon key (common/icons Icons or shell/toolbar-icons). */
  icon: string;
  /** data-testid kept stable for the E2E specs. */
  testId: string;
}

export type ToolbarItem = ToolbarButtonDef | { separator: true };

export const DEFAULT_TOOLBAR = '57600 57601 32795 0 57635 57634 57637 0 57671 57669 0 32777 32776 32782 32780 32781 32778 0 32806';

/**
 * MFC id -> command. UNCERTAIN: 32776-32806 are inferred from the default button order (Start, Single Step, Step Over,
 * Step Out, Assembly Step, Halt | Reset Target); 32795 from its place after Open (Save Configuration). Unknown ids are
 * skipped.
 */
export const TOOLBAR_IDS: Readonly<Record<number, Omit<ToolbarButtonDef, 'cmdId'>>> = {
  57600: { command: 'file.new', title: 'New', icon: 'newFile', testId: 'tb-new' },
  57601: { command: 'file.openConfig', title: 'Open Configuration', icon: 'open', testId: 'tb-open' },
  32795: { command: 'file.saveConfig', title: 'Save Configuration', icon: 'save', testId: 'tb-save' },
  57635: { command: 'edit.cut', title: 'Cut', icon: 'cut', testId: 'tb-cut' },
  57634: { command: 'edit.copy', title: 'Copy', icon: 'copy', testId: 'tb-copy' },
  57637: { command: 'edit.paste', title: 'Paste', icon: 'paste', testId: 'tb-paste' },
  57671: { command: 'help.about', title: 'Help', icon: 'help', testId: 'tb-help' },
  57669: { command: 'help.context', title: 'Context Help', icon: 'contextHelp', testId: 'tb-context-help' },
  32777: { command: 'run.go', title: 'Start/Continue (F5)', icon: 'go', testId: 'tb-go' },
  32776: { command: 'run.srcLine', title: 'Single Step (F11)', icon: 'step', testId: 'tb-step' },
  32782: { command: 'run.srcOver', title: 'Step Over (F10)', icon: 'stepOver', testId: 'tb-step-over' },
  32780: { command: 'run.srcOut', title: 'Step Out (Shift+F11)', icon: 'stepOut', testId: 'tb-step-out' },
  32781: { command: 'run.instr', title: 'Assembly Step (Ctrl+F11)', icon: 'asmStep', testId: 'tb-asm-step' },
  32778: { command: 'run.halt', title: 'Halt (F6)', icon: 'halt', testId: 'tb-halt' },
  32806: { command: 'conn.reset', title: 'Reset Target', icon: 'reset', testId: 'tb-reset' },
};

/** Parse a TOOLBAR= value into buttons and separators (no leading/trailing/double separators). */
export function parseToolbar(value: string | undefined | null): ToolbarItem[] {
  const ids = (value ?? DEFAULT_TOOLBAR)
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((t) => parseInt(t, 10))
    .filter((n) => Number.isFinite(n));
  const out: ToolbarItem[] = [];
  for (const id of ids) {
    if (id === 0) {
      if (out.length && !('separator' in out[out.length - 1])) out.push({ separator: true });
      continue;
    }
    const def = TOOLBAR_IDS[id];
    if (def) out.push({ cmdId: id, ...def });
  }
  while (out.length && 'separator' in out[out.length - 1]) out.pop();
  return out;
}

/** Read `[HI-WAVE] TOOLBAR=` from ini text (case-insensitive, via @s12/formats); undefined when absent. */
export function toolbarFromIni(text: string): string | undefined {
  return parseIni(text).get('HI-WAVE', 'TOOLBAR');
}

/**
 * Whether a toolbar button is disabled: as its menu command (`menuDisabled`), except the buttons hiwave greys on its
 * own. Cut/Copy/Paste follow what the focused component can take (clipboard-state.ts). New is greyed in the hiwave
 * screenshot; File > New stays in the menu (re-applies the default layout).
 */
export function toolbarDisabled(command: string, clip: { cut: boolean; copy: boolean; paste: boolean }, menuDisabled: (command: string) => boolean): boolean {
  switch (command) {
    // UNCERTAIN: why hiwave greys New (no new-configuration handler in this build?); we grey the button only
    case 'file.new':
      return true;
    case 'edit.cut':
      return !clip.cut;
    case 'edit.copy':
      return !clip.copy;
    case 'edit.paste':
      return !clip.paste;
    default:
      return menuDisabled(command);
  }
}
