import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events';
import { FileWatchers } from './file-watchers';
import { normKey } from './path-key';
import { TextFiles } from './text-files';

describe('normKey', () => {
  it('win32: separators, dot segments and case', () => {
    const k = normKey('C:\\Users\\Me\\Lab3\\Sources\\main.asm', 'win32');
    expect(normKey('c:/users/me/Lab3/Sources/MAIN.asm', 'win32')).toBe(k);
    expect(normKey('C:\\Users\\Me\\Lab3\\prm\\..\\Sources\\.\\main.asm', 'win32')).toBe(k);
    expect(normKey('C:\\\\Users\\Me\\Lab3\\Sources\\main.asm', 'win32')).toBe(k);
    expect(normKey('C:\\Users\\Me\\Lab3\\Sources\\', 'win32')).toBe(normKey('C:/Users/Me/Lab3/Sources', 'win32'));
    expect(normKey('C:\\', 'win32')).toBe('c:\\');
    expect(normKey('\\\\server\\share\\Lab3\\main.asm', 'win32')).toBe(normKey('//SERVER/share/lab3/main.asm', 'win32'));
  });
  it('darwin folds case; linux keeps it', () => {
    expect(normKey('/Users/me/Lab3/Main.asm', 'darwin')).toBe(normKey('/users/me/lab3/./main.asm', 'darwin'));
    expect(normKey('/home/me/Lab3/Main.asm', 'linux')).not.toBe(normKey('/home/me/lab3/main.asm', 'linux'));
    expect(normKey('/home/me/Lab3//Sources/../Main.asm', 'linux')).toBe('/home/me/Lab3/Main.asm');
    expect(normKey('/home/me/Lab3/', 'linux')).toBe('/home/me/Lab3');
    expect(normKey('/', 'linux')).toBe('/');
  });
});

describe('path keys in TextFiles / FileWatchers', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('TextFiles remembers a file read through a non-normalised spelling', async () => {
    dir = mkdtempSync(join(tmpdir(), 's12-pathkey-'));
    writeFileSync(join(dir, 'a.asm'), 'x\n');
    const t = new TextFiles();
    await t.read(join(dir, 'sub', '..', 'a.asm'));
    expect(t.eolOf(join(dir, 'a.asm'))).toBe('lf');
    expect(t.eolOf(`${dir}//./a.asm`)).toBe('lf');
  });

  it('FileWatchers: one watch per file however it is spelled; unwatch by another spelling', () => {
    dir = mkdtempSync(join(tmpdir(), 's12-pathkey-'));
    writeFileSync(join(dir, 'a.asm'), 'x\n');
    const w = new FileWatchers(new EventBus());
    w.add(join(dir, 'a.asm'));
    w.add(join(dir, '.', 'a.asm'));
    const map = (w as unknown as { watchers: Map<string, unknown> }).watchers;
    expect(map.size).toBe(1);
    w.remove(`${dir}/sub/../a.asm`);
    expect(map.size).toBe(0);
    w.dispose();
  });
});
