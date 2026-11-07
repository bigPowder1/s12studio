/**
 * No Monaco default keybinding may swallow a CW / hiwave menu shortcut (review finding: Monaco's multicursor Ctrl+D
 * hid File > Find and Open File while the editor had focus). Loads the real S12 Studio Monaco bundle in jsdom,
 * applies applyCwKeybindings and checks the resolved keymap against every shortcut of the IDE and debugger menus.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { isSeparator, normalizeShortcut, type MenuEntry, type TopMenu } from '../menu/model';
import { ideMenus, type IdeMenuActions } from '../../ide/shell/menus';
import { debuggerMenus } from '../../debugger/shell/menus';
import { applyCwKeybindings, REMOVED_MONACO_KEYS } from './keybindings';
import type { Monaco } from './loader';

/** Monaco commands that do what the CW menu command on the same key does (kept on purpose). */
const SAME_MEANING: Record<string, readonly string[]> = {
  'Ctrl+F': ['actions.find'],
  'Ctrl+H': ['editor.action.startFindReplaceAction'],
  F3: ['editor.action.nextMatchFindAction'],
  'Shift+F3': ['editor.action.previousMatchFindAction'],
  'Ctrl+[': ['editor.action.outdentLines'],
  'Ctrl+]': ['editor.action.indentLines'],
  'Ctrl+A': ['editor.action.selectAll'],
  'Ctrl+C': ['editor.action.clipboardCopyAction'],
  'Ctrl+X': ['editor.action.clipboardCutAction'],
  'Ctrl+V': ['editor.action.clipboardPasteAction'],
  'Ctrl+Z': ['undo'],
  'Ctrl+Y': ['redo'],
  'Ctrl+Shift+Z': ['redo'],
};

function shortcutsOf(menus: readonly TopMenu[]): Set<string> {
  const out = new Set<string>();
  const walk = (items: readonly MenuEntry[]) => {
    for (const e of items) {
      if (isSeparator(e)) continue;
      if (e.shortcut) out.add(normalizeShortcut(e.shortcut));
      if (e.submenu) walk(e.submenu);
    }
  };
  for (const m of menus) walk(m.items);
  return out;
}

/**
 * Monaco user-settings label ("ctrl+shift+f5") -> menu notation ("Ctrl+Shift+F5"). On macOS (labels use "cmd") Mac
 * users press the menus' Ctrl shortcuts as Cmd, so "cmd" maps to Ctrl and Monaco's emacs-style Control bindings
 * ("ctrl+n" = cursor down) are a different key that no menu shortcut is pressed with.
 */
const fromMonacoLabel = (s: string, mac: boolean) =>
  mac && /\bctrl\b/.test(s) ? `MacControl:${s}` : normalizeShortcut(s.replace(/\bcmd\b/, 'ctrl'));

interface KeybindingService {
  getKeybindings(): { command: string | null; resolvedKeybinding?: { getUserSettingsLabel(): string | null } }[];
}

let monaco: Monaco;
let keymap: { shortcut: string; command: string }[];

beforeAll(async () => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as never;
  monaco = (await import('./monaco-bundle')) as unknown as Monaco;
  applyCwKeybindings(monaco);
  applyCwKeybindings(monaco); // idempotent
  // Monaco internals (untyped ESM modules of the same monaco-editor package the bundle uses)
  // @ts-expect-error no declaration file for this internal module
  const services = (await import('monaco-editor/editor/standalone/browser/standaloneServices')) as { StandaloneServices: { get(id: unknown): KeybindingService } };
  // @ts-expect-error no declaration file for this internal module
  const keybinding = (await import('monaco-editor/platform/keybinding/common/keybinding')) as { IKeybindingService: unknown };
  const kb = services.StandaloneServices.get(keybinding.IKeybindingService);
  const bindings = kb.getKeybindings();
  const mac = bindings.some((k) => /\bcmd\b/.test(k.resolvedKeybinding?.getUserSettingsLabel() ?? ''));
  keymap = bindings.flatMap((k) => {
    const label = k.resolvedKeybinding?.getUserSettingsLabel();
    // only the first chord can steal a single menu key
    const first = label?.split(' ')[0];
    return first && k.command && !k.command.startsWith('-') ? [{ shortcut: fromMonacoLabel(first, mac), command: k.command }] : [];
  });
}, 60000);

describe('Monaco keybindings vs CW menu shortcuts', () => {
  it('reads Monaco’s live default keymap', () => {
    expect(keymap.length).toBeGreaterThan(50);
    expect(keymap).toContainEqual({ shortcut: 'Ctrl+F', command: 'actions.find' });
  });

  it('removes Ctrl+D (multicursor) so File > Find and Open File works in the editor', () => {
    expect(REMOVED_MONACO_KEYS.map((k) => k.shortcut)).toContain('Ctrl+D');
    expect(keymap.filter((k) => k.shortcut === 'Ctrl+D')).toEqual([]);
  });

  it('leaves no Monaco binding on an IDE or debugger menu shortcut (except same-meaning ones)', () => {
    const actions = new Proxy({}, { get: () => () => undefined }) as IdeMenuActions;
    const ide = ideMenus(actions, { project: null, building: false, activeFile: null, openFiles: [], dirtyCount: 0, recent: [], toolbarVisible: true, statusBarVisible: true });
    const dbg = debuggerMenus(
      { state: 'halted', hasSession: true, connectionMenu: 'HCS12X FCS', showToolbar: true, showStatusBar: true, hideHeadline: false, componentMenuOn: true, autosize: false, windows: [], activeId: null, componentTitle: null, componentMenu: null },
      () => undefined,
    );
    const menuKeys = new Set([...shortcutsOf(ide), ...shortcutsOf(dbg)]);
    expect(menuKeys.has('Ctrl+D')).toBe(true);
    expect(menuKeys.has('F5')).toBe(true);
    const clashes = keymap.filter((k) => menuKeys.has(k.shortcut) && !(SAME_MEANING[k.shortcut] ?? []).includes(k.command));
    expect(clashes).toEqual([]);
  });
});
