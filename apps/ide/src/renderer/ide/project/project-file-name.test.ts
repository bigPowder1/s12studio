import { describe, expect, it } from 'vitest';
import { ideTitle } from '../shell/IdeShell';
import { projectFileName } from './project-file-name';

describe('projectFileName', () => {
  it('names a CodeWarrior project <name>.mcp and a standalone one <name>.s12studio.json', () => {
    expect(projectFileName({ name: 'Lab3', mcpPath: '/w/Lab3/Lab3.mcp', path: '/w/Lab3/Lab3.mcp' })).toBe('Lab3.mcp');
    expect(projectFileName({ name: 'blinky', mcpPath: undefined, path: '/w/blinky/blinky.s12studio.json' })).toBe('blinky.s12studio.json');
    expect(ideTitle({ name: 'blinky', mcpPath: undefined, path: 'C:\\w\\blinky\\blinky.s12studio.json' })).toBe('S12 Studio - [blinky.s12studio.json]');
    expect(ideTitle({ name: 'Lab3', mcpPath: '/w/Lab3.mcp', path: '/w/Lab3.mcp' })).toBe('S12 Studio - [Lab3.mcp]');
    expect(ideTitle(null)).toBe('S12 Studio');
  });
});
