import { describe, expect, it } from 'vitest';
import { joinPath, MemoryFileSystem, normalizePath, resolvePathCI } from '../src/fs';

describe('normalizePath: Windows roots', () => {
  it('keeps a drive root that ".." cannot climb above', () => {
    expect(normalizePath('C:\\Lab3\\..\\..\\x')).toBe('C:/x');
    expect(normalizePath('C:/Lab3/prm/../Sources/./main.asm')).toBe('C:/Lab3/Sources/main.asm');
    expect(normalizePath('c:\\')).toBe('c:/');
    expect(normalizePath('C:/..')).toBe('C:/');
    expect(normalizePath('D:\\\\a\\\\b\\')).toBe('D:/a/b/');
  });
  it('keeps a UNC root', () => {
    expect(normalizePath('\\\\server\\share\\Lab3\\..\\..\\x.asm')).toBe('//server/share/x.asm');
    expect(normalizePath('//server/share')).toBe('//server/share');
  });
  it('POSIX paths are unchanged', () => {
    expect(normalizePath('/a/b/../c')).toBe('/a/c');
    expect(normalizePath('a/../../b')).toBe('../b');
    expect(normalizePath('/..')).toBe('/');
    expect(normalizePath('')).toBe('.');
  });
  it('joinPath with a drive base', () => {
    expect(joinPath('C:\\Users\\me\\Lab3', '..\\..\\..\\..\\cmd\\a.cmd')).toBe('C:/cmd/a.cmd');
    expect(joinPath('C:/Users/me/Lab3', '.\\cmd\\Full_Chip_Simulation_startup.cmd')).toBe('C:/Users/me/Lab3/cmd/Full_Chip_Simulation_startup.cmd');
  });
  it('resolvePathCI walks below a drive root', async () => {
    const fs = new MemoryFileSystem({ 'C:/Proj/cmd/Full_Chip_Simulation_Startup.cmd': '' });
    expect(await resolvePathCI(fs, 'C:\\Proj', '.\\cmd\\full_chip_simulation_startup.cmd')).toBe('C:/Proj/cmd/Full_Chip_Simulation_Startup.cmd');
  });
});
