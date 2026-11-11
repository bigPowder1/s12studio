/** App settings persisted as JSON (Electron userData/settings.json). Pure Node; tolerant of a corrupt file. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_SETTINGS, type AppSettings, type AppSettingsPatch } from '../../shared/api/settings';
import type { EventBus } from '../events';

const MAX_RECENT = 10;

export function mergeSettings(base: AppSettings, patch: AppSettingsPatch): AppSettings {
  const out: Record<string, unknown> = { ...base };
  for (const [k, val] of Object.entries(patch)) {
    if (val === undefined) continue;
    const cur = (base as unknown as Record<string, unknown>)[k];
    if (val && typeof val === 'object' && !Array.isArray(val) && cur && typeof cur === 'object' && !Array.isArray(cur)) out[k] = { ...cur, ...val };
    else out[k] = val;
  }
  const s = out as unknown as AppSettings;
  s.recentProjects = s.recentProjects.slice(0, MAX_RECENT);
  s.recentFiles = s.recentFiles.slice(0, MAX_RECENT);
  return s;
}

/**
 * Bring a settings file from an older version up to date:
 * - v1 -> v2: the editor font is no longer a setting (drop `editor.fontFamily`), and the old default size 13 becomes
 *   the new default 15 (a size the user picked themselves is kept).
 * - v2 -> v3: CodeWarrior-style tabs. The old defaults (8-column tabs, real tab characters) become 2-column stops (the
 *   lab's CodeWarrior: Tab from column 1 goes to 3, 5, 7, ...) that insert spaces; tab settings the user changed themselves are kept.
 */
export function migrateSettings(raw: Record<string, unknown>): AppSettingsPatch {
  const s = { ...raw };
  const editor = s.editor && typeof s.editor === 'object' && !Array.isArray(s.editor) ? { ...(s.editor as Record<string, unknown>) } : undefined;
  if (editor) {
    delete editor.fontFamily;
    const version = typeof s.version === 'number' ? s.version : 1;
    if (version < 2 && editor.fontSize === 13) editor.fontSize = DEFAULT_SETTINGS.editor.fontSize;
    if (version < 3 && (editor.tabSize ?? 8) === 8 && (editor.insertSpaces ?? false) === false) {
      editor.tabSize = DEFAULT_SETTINGS.editor.tabSize;
      editor.insertSpaces = DEFAULT_SETTINGS.editor.insertSpaces;
    }
    s.editor = editor;
  }
  s.version = DEFAULT_SETTINGS.version;
  return s as AppSettingsPatch;
}

export class SettingsStore {
  private settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly bus?: EventBus,
  ) {}

  async get(): Promise<AppSettings> {
    if (!this.loaded) {
      this.loaded = true;
      try {
        const parsed = migrateSettings(JSON.parse(await readFile(this.file, 'utf8')) as Record<string, unknown>);
        this.settings = mergeSettings(structuredClone(DEFAULT_SETTINGS), parsed);
      } catch {
        // missing or corrupt: defaults
      }
    }
    return structuredClone(this.settings);
  }

  async update(patch: AppSettingsPatch): Promise<AppSettings> {
    await this.get();
    this.settings = mergeSettings(this.settings, patch);
    const snapshot = JSON.stringify(this.settings, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, snapshot, 'utf8');
      await rename(tmp, this.file);
    });
    await this.writing;
    const s = structuredClone(this.settings);
    this.bus?.emit('settings', 'changed', s);
    return s;
  }

  async addRecent(kind: 'recentProjects' | 'recentFiles', path: string): Promise<void> {
    const s = await this.get();
    const list = [path, ...s[kind].filter((p) => p !== path)];
    await this.update({ [kind]: list });
  }
}
