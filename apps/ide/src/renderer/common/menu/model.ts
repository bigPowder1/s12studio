/**
 * Menu model shared by the IDE and debugger menu bars, component menus and context menus.
 * Labels use `&` before the mnemonic letter ("&File", "Single &Step"); `&&` is a literal ampersand.
 * Shortcuts are display + binding strings: "F5", "Ctrl+Shift+F5", "Alt+F7", "Shift+F11".
 */
export interface MenuCommand {
  kind?: 'item';
  /** Stable id (tests, enable/disable by id, toolbar mapping). */
  id?: string;
  label: string;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  submenu?: MenuEntry[];
}

export interface MenuSeparator {
  kind: 'separator';
}

export type MenuEntry = MenuCommand | MenuSeparator;

export interface TopMenu {
  /** "&File" */
  label: string;
  id?: string;
  items: MenuEntry[];
  disabled?: boolean;
}

export const SEP: MenuSeparator = { kind: 'separator' };

export const isSeparator = (e: MenuEntry): e is MenuSeparator => e.kind === 'separator';

/** Split "&File" into parts for rendering; returns the mnemonic letter (lower case) or undefined. */
export function parseMnemonic(label: string): { before: string; key?: string; after: string; plain: string } {
  let plain = '';
  let before = '';
  let key: string | undefined;
  let after = '';
  for (let i = 0; i < label.length; i++) {
    const c = label[i];
    if (c === '&' && label[i + 1] === '&') {
      (key === undefined ? (before += '&') : (after += '&'));
      plain += '&';
      i++;
    } else if (c === '&' && key === undefined && i + 1 < label.length) {
      key = label[i + 1];
      plain += key;
      i++;
    } else {
      if (key === undefined) before += c;
      else after += c;
      plain += c;
    }
  }
  return { before, key: key?.toLowerCase(), after, plain };
}

/** Canonical shortcut string of a KeyboardEvent ("Ctrl+Shift+F5"), or null for bare modifiers. */
export function shortcutOf(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (key === ' ') key = 'Space';
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/** Normalise a written shortcut ("ctrl+shift+f5" -> "Ctrl+Shift+F5") for comparison. */
export function normalizeShortcut(s: string): string {
  const parts = s.split('+').map((p) => p.trim());
  const key = parts.pop() ?? '';
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const out: string[] = [];
  if (mods.has('ctrl') || mods.has('cmd')) out.push('Ctrl');
  if (mods.has('alt')) out.push('Alt');
  if (mods.has('shift')) out.push('Shift');
  out.push(key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
  return out.join('+');
}

/** Every enabled command with a shortcut, depth-first (the first binding of a shortcut wins). */
export function collectShortcuts(menus: readonly TopMenu[]): Map<string, MenuCommand> {
  const out = new Map<string, MenuCommand>();
  const walk = (items: readonly MenuEntry[]) => {
    for (const e of items) {
      if (isSeparator(e)) continue;
      if (e.shortcut && !e.disabled && e.onSelect) {
        const k = normalizeShortcut(e.shortcut);
        if (!out.has(k)) out.set(k, e);
      }
      if (e.submenu) walk(e.submenu);
    }
  };
  for (const m of menus) if (!m.disabled) walk(m.items);
  return out;
}

/** Find a command by id (tests, toolbar state). */
export function findCommand(menus: readonly TopMenu[], id: string): MenuCommand | undefined {
  const walk = (items: readonly MenuEntry[]): MenuCommand | undefined => {
    for (const e of items) {
      if (isSeparator(e)) continue;
      if (e.id === id) return e;
      const r = e.submenu && walk(e.submenu);
      if (r) return r;
    }
    return undefined;
  };
  for (const m of menus) {
    const r = walk(m.items);
    if (r) return r;
  }
  return undefined;
}
