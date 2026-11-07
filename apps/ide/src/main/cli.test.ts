import { describe, expect, it } from 'vitest';
import { isProjectFile, parseCli } from './cli';

describe('parseCli', () => {
  it('packaged: every positional is a file to open', () => {
    expect(parseCli(['S12Studio.exe', 'C:\\Lab3\\Lab3.mcp', 'main.asm'], true)).toEqual({ open: ['C:\\Lab3\\Lab3.mcp', 'main.asm'], debug: false, devtools: false });
  });
  it('dev / E2E: skips electron switches and the app path', () => {
    const argv = ['/x/electron', '--inspect=0', '--remote-debugging-port=0', '--disable-gpu', '/repo/apps/ide', '--open', '/tmp/Lab3/Lab3.mcp', '--debug'];
    expect(parseCli(argv, false)).toEqual({ open: ['/tmp/Lab3/Lab3.mcp'], debug: true, devtools: false });
    expect(parseCli(['electron', '.', 'a.asm', '--devtools', '--open=b.inc'], false)).toEqual({ open: ['a.asm', 'b.inc'], debug: false, devtools: true });
  });
  it('skips switches that take a separate value', () => {
    expect(parseCli(['electron', '--user-data-dir', '/u', 'app', '--lang', 'en', 'x.mcp'], false).open).toEqual(['x.mcp']);
  });
  it('recognises project files', () => {
    expect(isProjectFile('a/Lab3.MCP')).toBe(true);
    expect(isProjectFile('p.s12studio.json')).toBe(true);
    expect(isProjectFile('main.asm')).toBe(false);
  });
});
