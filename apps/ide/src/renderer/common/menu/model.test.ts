import { describe, expect, it } from 'vitest';
import { collectShortcuts, findCommand, normalizeShortcut, parseMnemonic, shortcutOf, SEP, type TopMenu } from './model';

describe('menu model', () => {
  it('parses & mnemonics', () => {
    expect(parseMnemonic('&File')).toEqual({ before: '', key: 'f', after: 'ile', plain: 'File' });
    expect(parseMnemonic('Errors && &Warnings')).toMatchObject({ plain: 'Errors & Warnings', key: 'w', before: 'Errors & ' });
    expect(parseMnemonic('Plain').key).toBeUndefined();
  });
  it('normalises shortcuts from events and text', () => {
    expect(shortcutOf({ key: 'F5', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false })).toBe('Ctrl+Shift+F5');
    expect(shortcutOf({ key: 'g', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })).toBe('Ctrl+G');
    expect(shortcutOf({ key: 'Shift', ctrlKey: false, shiftKey: true, altKey: false, metaKey: false })).toBeNull();
    expect(normalizeShortcut('shift+ctrl+f11')).toBe('Ctrl+Shift+F11');
  });
  it('collects enabled shortcuts and finds commands', () => {
    const run = () => undefined;
    const menus: TopMenu[] = [
      { label: '&Run', items: [{ id: 'go', label: 'Go', shortcut: 'F5', onSelect: run }, SEP, { id: 'halt', label: 'Halt', shortcut: 'F6', disabled: true, onSelect: run }] },
      { label: '&X', items: [{ label: 'Sub', submenu: [{ id: 'deep', label: 'Deep', shortcut: 'Ctrl+D', onSelect: run }] }] },
    ];
    const m = collectShortcuts(menus);
    expect([...m.keys()]).toEqual(['F5', 'Ctrl+D']);
    expect(findCommand(menus, 'deep')?.label).toBe('Deep');
  });
});
