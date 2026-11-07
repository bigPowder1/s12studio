import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES } from '../../formats/test/fixtures';
import {
  MemoryFs,
  PathMapper,
  baseName,
  copyTree,
  createNodeFs,
  dirName,
  expandRootedPath,
  extOf,
  fileKindOf,
  installCompilerRoot,
  joinPath,
  joinTool,
  make,
  normPath,
  openProject,
  relativePath,
  resolveCase,
  walkFiles,
} from '../src/index';
import { goldenBuildOptions, goldenBytes, OUTPUTS, itFx } from './helpers';

describe('paths', () => {
  it('normalises real paths', () => {
    expect(normPath('C:\\a\\b\\..\\c\\')).toBe('C:/a/c');
    expect(normPath('/a//b/./c')).toBe('/a/b/c');
    expect(joinPath('/p', 'Sources\\Libraries', 'x.lib')).toBe('/p/Sources/Libraries/x.lib');
    expect(joinPath('/p', '..\\..\\Other')).toBe('/Other');
    expect(joinPath('/p', 'E:\\abs')).toBe('E:/abs');
    expect(dirName('/p/a.asm')).toBe('/p');
    expect(dirName('C:/a.asm')).toBe('C:/');
    expect(baseName('C:\\x\\Main.ASM')).toBe('Main.ASM');
    expect(extOf('Project.abs.s19')).toBe('.s19');
    expect(relativePath('/p', '/p/Sources/x.asm')).toBe('Sources/x.asm');
    expect(relativePath('/p/q', '/p/r/x')).toBe('../r/x');
    expect(joinTool('C:\\P', 'bin/x.lst')).toBe('C:\\P\\bin\\x.lst');
  });

  it('maps real paths to tool paths and back', () => {
    const m = new PathMapper('/work/Lab3', '/cw', { project: 'C:\\Users\\me\\Lab3', compiler: 'C:\\Program Files (x86)\\Freescale\\CWS12v5.1' });
    expect(m.toTool('/work/Lab3')).toBe('C:\\Users\\me\\Lab3');
    expect(m.toTool('/work/Lab3/bin/Project.abs')).toBe('C:\\Users\\me\\Lab3\\bin\\Project.abs');
    expect(m.toTool('/cw/lib/HC12c/include')).toBe('C:\\Program Files (x86)\\Freescale\\CWS12v5.1\\lib\\HC12c\\include');
    expect(m.toTool('/elsewhere/x')).toBe('/elsewhere/x');
    expect(m.toReal('C:\\Users\\me\\Lab3\\bin\\main.lst')).toBe('/work/Lab3/bin/main.lst');
    expect(m.toReal('c:\\users\\ME\\lab3\\Sources\\main.asm')).toBe('/work/Lab3/Sources/main.asm');
    expect(m.toReal('C:\\Program Files (x86)\\Freescale\\CWS12v5.1\\lib\\HC12c\\include\\x.inc')).toBe('/cw/lib/HC12c/include/x.inc');
    const plain = new PathMapper('C:/Users/me/P', undefined);
    expect(plain.toTool('C:/Users/me/P/bin/Project.abs')).toBe('C:\\Users\\me\\P\\bin\\Project.abs');
    expect(plain.toReal('C:\\Users\\me\\P\\bin\\main.lst')).toBe('C:/Users/me/P/bin/main.lst');
    const posix = new PathMapper('/home/me/P', undefined);
    expect(posix.toTool('/home/me/P/bin')).toBe('/home/me/P/bin');
    expect(posix.toReal('/home/me/P/bin\\main.lst')).toBe('/home/me/P/bin/main.lst');
  });

  it('expands CodeWarrior rooted paths', () => {
    expect(expandRootedPath('{Project}', '/p')).toBe('/p');
    expect(expandRootedPath('{Project}Sources\\Libraries', '/p')).toBe('/p/Sources/Libraries');
    expect(expandRootedPath('{Compiler}lib\\HC12c\\include', '/p', '/cw')).toBe('/cw/lib/HC12c/include');
    expect(expandRootedPath('{Compiler}lib', '/p')).toBeUndefined();
    expect(expandRootedPath('E:\\Lab work\\Lab 1 2024\\Sources', '/p')).toBe('E:/Lab work/Lab 1 2024/Sources');
  });

  it('classifies files', () => {
    expect(['a.asm', 'b.INC', 'c.lib', 'd.o', 'e.prm', 'f.bbl', 'g.map', 'h.ini', 'i.cmd', 'j.xyz'].map((n) => fileKindOf(n))).toEqual([
      'asm', 'inc', 'lib', 'o', 'prm', 'bbl', 'map', 'ini', 'cmd', 'other',
    ]);
    expect(fileKindOf('x.s12', 'Assembler for HC12')).toBe('asm');
  });
});

describe('MemoryFs and helpers', () => {
  it('reads, writes, lists and removes', async () => {
    const fs = new MemoryFs({ '/a/b/c.txt': 'hi', '/a/D.TXT': 'x' });
    expect(await fs.readdir('/a')).toEqual(['D.TXT', 'b']);
    expect((await fs.stat('/a/b'))?.isDirectory).toBe(true);
    expect((await fs.stat('/a/b/c.txt'))?.size).toBe(2);
    const m1 = (await fs.stat('/a/b/c.txt'))!.mtime;
    fs.touch('/a/b/c.txt');
    expect((await fs.stat('/a/b/c.txt'))!.mtime).toBeGreaterThan(m1);
    expect(await resolveCase(fs, '/A/B/C.TXT')).toBe('/a/b/c.txt');
    expect(await resolveCase(fs, '/a/d.txt')).toBe('/a/D.TXT');
    expect(await resolveCase(fs, '/a/nope')).toBeUndefined();
    expect(await walkFiles(fs, '/a')).toEqual(['/a/D.TXT', '/a/b/c.txt']);
    await copyTree(fs, '/a', '/z', (r) => (r === 'D.TXT' ? undefined : r.replace('b', 'q')));
    expect(fs.list('/z')).toEqual(['/z/q/c.txt']);
    await fs.remove('/a/b');
    expect(await fs.exists('/a/b/c.txt')).toBe(false);
    expect(await fs.readFile('/a/b/c.txt')).toBeUndefined();
  });
});

describe('Node fs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 's12project-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('basic operations', async () => {
    const fs = createNodeFs();
    await fs.writeFile(`${tmp}/x/y/z.bin`, Uint8Array.of(1, 2, 3));
    expect(await fs.readFile(`${tmp}/x/y/z.bin`)).toEqual(Uint8Array.of(1, 2, 3));
    expect(await fs.readFile(`${tmp}/x/missing`)).toBeUndefined();
    expect(await fs.readdir(`${tmp}/x`)).toEqual(['y']);
    expect(await fs.readdir(`${tmp}/nope`)).toBeUndefined();
    expect((await fs.stat(`${tmp}/x/y/z.bin`))?.size).toBe(3);
    expect(await fs.exists(`${tmp}/x/y`)).toBe(true);
    await fs.remove(`${tmp}/x`);
    expect(await fs.exists(`${tmp}/x`)).toBe(false);
  });

  itFx('golden Make of a disk copy of Lab3 (fixture untouched)', async () => {
    const dir = `${tmp}/Lab3`;
    cpSync(join(FIXTURES, 'Lab3'), dir, { recursive: true });
    const fs = createNodeFs();
    for (const o of OUTPUTS('Lab3')) await fs.remove(`${dir}/${o}`);
    await installCompilerRoot(fs, `${tmp}/cw`);
    const proj = await openProject(fs, `${dir}/lab3.MCP`, { compilerDir: `${tmp}/cw` });
    const r = await make(proj, goldenBuildOptions('Lab3'));
    expect(r.messages).toEqual([]);
    for (const o of OUTPUTS('Lab3')) expect(Buffer.from(readFileSync(`${dir}/${o}`)).equals(Buffer.from(goldenBytes('Lab3', o))), o).toBe(true);
    expect((await make(proj, goldenBuildOptions('Lab3'))).upToDate).toBe(true);
  });
});
