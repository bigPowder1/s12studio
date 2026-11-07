import { describe, expect, it } from 'vitest';
import { createMockS12 } from '../../common/testing/mockS12';
import { registerIdeCommand } from '../commands';
import { ZIP_PROJECT_MESSAGE } from '../../../shared/zip-path';
import { baseName, classifyOpen, openDemoProject, openPath } from './open-dispatch';

describe('File > Open dispatch', () => {
  it('classifies paths', () => {
    expect(classifyOpen('/p/Lab3.MCP')).toBe('project');
    expect(classifyOpen('/p/Lab3.s12studio.json')).toBe('project');
    expect(classifyOpen('/p/bin/Project.abs')).toBe('debugger');
    expect(classifyOpen('/p/Sources/main.asm')).toBe('editor');
    expect(classifyOpen('/p/prm/Project.prm')).toBe('editor');
    expect(classifyOpen('/p/x.inc')).toBe('editor');
    expect(baseName('C:\\a\\b.asm')).toBe('b.asm');
  });

  it('.mcp opens the project, .abs launches the debugger, text goes to the editor; all are added to recent', async () => {
    const m = createMockS12();
    const opened: unknown[] = [];
    const off = registerIdeCommand('editor.open', (a) => void opened.push(a));
    expect(await openPath(m.api, '/p/Lab3.mcp')).toBe('project');
    expect(await openPath(m.api, '/p/bin/Project.abs')).toBe('debugger');
    expect(await openPath(m.api, '/p/Sources/main.asm', { line: 7 })).toBe('editor');
    expect(m.calls('project', 'open')).toEqual([['/p/Lab3.mcp']]);
    expect(m.calls('debug', 'launch')).toEqual([[{ absPath: '/p/bin/Project.abs', load: true }]]);
    expect(opened).toEqual([{ path: '/p/Sources/main.asm', line: 7 }]);
    expect(m.calls('files', 'addRecent')).toHaveLength(3);
    off();
  });

  it('refuses a project inside a zip (message box, nothing opened, not added to recent)', async () => {
    const m = createMockS12();
    const p = 'C:\\Users\\st\\AppData\\Local\\Temp\\Temp1_Lab3.zip\\Lab3\\Lab3.mcp';
    await expect(openPath(m.api, p)).rejects.toThrow(ZIP_PROJECT_MESSAGE);
    expect(m.calls('app', 'showMessage')).toEqual([[{ type: 'error', message: ZIP_PROJECT_MESSAGE, detail: p }]]);
    expect(m.calls('project', 'open')).toEqual([]);
    expect(m.calls('files', 'addRecent')).toEqual([]);
  });

  it('openDemoProject opens the copy main prepared', async () => {
    const m = createMockS12({ app: { prepareDemo: async () => '/docs/S12 Studio/Demo (blinky)/blinky.s12studio.json' } });
    expect(await openDemoProject(m.api)).toBe('/docs/S12 Studio/Demo (blinky)/blinky.s12studio.json');
    expect(m.calls('project', 'open')).toEqual([['/docs/S12 Studio/Demo (blinky)/blinky.s12studio.json']]);
  });
});
