import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/api/settings';
import { migrateSettings, SettingsStore } from './settings-store';

describe('settings migration (v2: fixed code font; v3: CodeWarrior tabs)', () => {
  it('drops the old editor font and moves the old default size 13 to 15', () => {
    const m = migrateSettings({ version: 1, editor: { fontFamily: "'Courier New', Courier, monospace", fontSize: 13, tabSize: 4 } });
    expect(m.version).toBe(3);
    expect(m.editor).toEqual({ fontSize: 15, tabSize: 4 });
  });

  it('keeps a size the user picked', () => {
    expect(migrateSettings({ version: 1, editor: { fontFamily: 'Consolas', fontSize: 18 } }).editor).toEqual({ fontSize: 18, tabSize: 2, insertSpaces: true });
  });

  it('a v2 file keeps its size (13 chosen after the change stays 13)', () => {
    expect(migrateSettings({ version: 2, editor: { fontSize: 13, tabSize: 8, insertSpaces: false } }).editor).toEqual({ fontSize: 13, tabSize: 2, insertSpaces: true });
  });

  it('a v1 settings.json loads without fontFamily, and the next save writes v3', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's12-settings-'));
    const file = join(dir, 'settings.json');
    await writeFile(file, JSON.stringify({ version: 1, showStartupDialog: false, editor: { fontFamily: "'Courier New'", fontSize: 13 } }));
    const store = new SettingsStore(file);
    const s = await store.get();
    expect(s.version).toBe(3);
    expect(s.showStartupDialog).toBe(false);
    expect(s.editor).toEqual({ ...DEFAULT_SETTINGS.editor, fontSize: 15 });
    expect('fontFamily' in s.editor).toBe(false);
    await store.update({ editor: { tabSize: 4 } });
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.version).toBe(3);
    expect(saved.editor.fontFamily).toBeUndefined();
  });

  it('v2 -> v3: the old tab defaults become CodeWarrior tabs; tab settings the user changed are kept', () => {
    expect(migrateSettings({ version: 2, editor: { tabSize: 8, insertSpaces: false } }).editor).toEqual({ tabSize: 2, insertSpaces: true });
    expect(migrateSettings({ version: 2, editor: { tabSize: 2, insertSpaces: false } }).editor).toEqual({ tabSize: 2, insertSpaces: false });
    expect(migrateSettings({ version: 2, editor: { tabSize: 8, insertSpaces: true } }).editor).toEqual({ tabSize: 8, insertSpaces: true });
    expect(migrateSettings({ version: 3, editor: { tabSize: 8, insertSpaces: false } }).editor).toEqual({ tabSize: 8, insertSpaces: false });
  });

  it('defaults: size 15, no font setting, 2-column tab stops inserting spaces', () => {
    expect(DEFAULT_SETTINGS.editor).toMatchObject({ tabSize: 2, insertSpaces: true });
    expect(DEFAULT_SETTINGS.editor.fontSize).toBe(15);
    expect('fontFamily' in DEFAULT_SETTINGS.editor).toBe(false);
  });
});
