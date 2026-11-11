// Regression tests for the review of @s12/project (Clean safety, dependency tracking, options, API additions).
import { describe, expect, it } from 'vitest';
import { readElf } from '@s12/formats';
import { readNoteMeta } from '@s12/link';
import {
  MemoryFs,
  buildStatus,
  clean,
  installCompilerRoot,
  latin1Bytes,
  make,
  newMinimalProject,
  newProjectFromTemplate,
  openProject,
  parseLinkerOptions,
  removeObjectCode,
  utf8Bytes,
  utf8Text,
  validateProjectName,
} from '../src/index';
import { COMPILER, freshProject, loadFixture, describeFx, itFx } from './helpers';

const S = { user: 'student', stamp: () => 'Thu Oct 29 12:00:00 2026' };
const text = (b: Uint8Array | undefined) => new TextDecoder('latin1').decode(b!);
const UTIL = '            XDEF util\r\nMyCode: SECTION\r\nutil:       RTS\r\n';

/** Copy every file below `from` to `to` (a student copying a lab folder). */
function copyDir(fs: MemoryFs, from: string, to: string): void {
  for (const p of fs.list(from)) fs.writeSync(to + p.slice(from.length), fs.readSync(p)!);
}

describeFx('Clean only deletes our outputs inside the project (finding 1)', () => {
  it('cleaning a copied project leaves the original untouched', async () => {
    const { fs, proj, dir } = await freshProject('Lab3');
    expect((await make(proj, S)).ok).toBe(true);
    const before = fs.list(dir);
    copyDir(fs, dir, '/work/Lab3 - Copy');
    const copy = await openProject(fs, '/work/Lab3 - Copy/Lab3.mcp', { compilerDir: COMPILER });
    const removed = await clean(copy);
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.every((p) => p.startsWith('/work/Lab3 - Copy/'))).toBe(true);
    expect(fs.list(dir)).toEqual(before);
    expect(fs.readSync('/work/Lab3 - Copy/bin/Project.abs')).toBeUndefined();
  });

  it('a project made from a built template carries no build cache, and Clean spares the template', async () => {
    const { fs, proj, dir } = await freshProject('Lab3');
    await make(proj, S);
    const before = fs.list(dir);
    const res = await newProjectFromTemplate(fs, dir, '/work/Lab4', 'Lab4');
    expect(fs.list('/work/Lab4').some((p) => p.endsWith('s12studio-build.json'))).toBe(false);
    const lab4 = await openProject(fs, res.projectPath, { compilerDir: COMPILER });
    await clean(lab4);
    expect(fs.list(dir)).toEqual(before);
  });

  it('ignores cache entries that point outside the project and never deletes directories', async () => {
    const { fs, proj, dir } = await freshProject('blank_project');
    await make(proj, S);
    fs.writeSync('/home/student/Documents/thesis.docx', latin1Bytes('precious'));
    fs.writeSync('/work/outside.txt', latin1Bytes('precious'));
    const cachePath = `${dir}/blank_project_Data/Standard/s12studio-build.json`;
    const cache = JSON.parse(utf8Text(fs.readSync(cachePath)!));
    expect(cache.version).toBe(2);
    expect(cache.link.outputs).toContain('bin/Project.abs'); // project-relative
    cache.link.outputs.push('/home/student', '../outside.txt', 'Sources');
    cache.objects['main.asm'].outputs.push('/home/student/Documents/thesis.docx');
    fs.writeSync(cachePath, utf8Bytes(JSON.stringify(cache)));
    const removed = await clean(proj);
    expect(fs.readSync('/home/student/Documents/thesis.docx')).toBeDefined();
    expect(fs.readSync('/work/outside.txt')).toBeDefined();
    expect(fs.readSync(`${dir}/Sources/main.asm`)).toBeDefined();
    expect(removed).toContain(`${dir}/bin/Project.abs`);
    expect(fs.readSync(`${dir}/bin/Project.abs`)).toBeUndefined();

    // the old (version 1) absolute-path cache format is not trusted at all
    fs.writeSync(cachePath, utf8Bytes(JSON.stringify({ format: 's12studio-build', version: 1, target: 'Standard', objects: {}, link: { cmd: '', inputs: {}, outputs: ['/home/student'] } })));
    await clean(proj);
    expect(fs.readSync('/home/student/Documents/thesis.docx')).toBeDefined();
  });

  it('a directory named like an output is never removed', async () => {
    const { fs, proj, dir } = await freshProject('blank_project');
    fs.writeSync(`${dir}/bin/Project.abs.glo/keep.txt`, latin1Bytes('x'));
    await clean(proj);
    expect(fs.readSync(`${dir}/bin/Project.abs.glo/keep.txt`)).toBeDefined();
  });
});

describeFx('dependency tracking', () => {
  it('relinks when a PRM INCLUDE file changes and reports errors at the included file (finding 2)', async () => {
    const { fs, proj, dir } = await freshProject('blank_project');
    const prm = text(fs.readSync(`${dir}/prm/Project.prm`));
    fs.writeSync(`${dir}/prm/Project.prm`, latin1Bytes(prm.replace('NAMES\r\n', 'INCLUDE extra.prm\r\nNAMES\r\n')));
    fs.writeSync(`${dir}/prm/extra.prm`, latin1Bytes('/* nothing */\r\n'));
    expect(await make(proj, S)).toMatchObject({ ok: true, linked: true });
    expect((await make(proj, S)).upToDate).toBe(true);
    fs.writeSync(`${dir}/prm/extra.prm`, latin1Bytes('/* x */\r\nBOGUS;\r\n'));
    const r = await make(proj, S);
    expect(r).toMatchObject({ ok: false, linked: false, upToDate: false });
    const e = r.messages.find((m) => m.severity === 'error')!;
    expect(e).toMatchObject({ tool: 'linker', file: `${dir}/prm/extra.prm`, line: 2 });
    expect(e.display).toMatch(/extra\.prm line 2\n$/);
  });

  it('rebuilds when a new include file would now be found earlier on GENPATH (finding 3)', async () => {
    const { fs, proj, dir } = await freshProject('blank_project');
    const src = text(fs.readSync(`${dir}/Sources/main.asm`));
    fs.writeSync(`${dir}/Sources/main.asm`, latin1Bytes(src.replace(/^(\s*XDEF)/m, " INCLUDE 'derivative.inc'\r\n$1")));
    const r1 = await make(proj, S);
    expect(r1.files[0].includes).toContain('/cw/lib/HC12c/include/mc9s12xdp512.inc');
    expect((await make(proj, S)).upToDate).toBe(true);
    fs.writeSync(`${dir}/Sources/MC9S12XDP512.INC`, fs.readSync('/cw/lib/HC12c/include/mc9s12xdp512.inc')!); // case-insensitive hit
    const r2 = await make(proj, S);
    expect(r2.compiled).toEqual(['main.asm']);
    expect(r2.files[0].includes).toContain(`${dir}/Sources/MC9S12XDP512.INC`);
    expect((await make(proj, S)).upToDate).toBe(true);
  });

  it('notices an edit that keeps mtime and size (FAT 2 s resolution, save during the build) (finding 7)', async () => {
    const { fs, proj, dir } = await freshProject('blank_project');
    const p = `${dir}/Sources/main.asm`;
    // the save lands while the build is linking, after the assembler read the file, with the same mtime and size
    let edited = false;
    const mtime = (await fs.stat(p))!.mtime;
    const r1 = await make(proj, {
      ...S,
      onProgress: (pr) => {
        if (pr.step !== 'link' || edited) return;
        edited = true;
        const old = fs.readSync(p)!;
        const b = old.slice();
        const i = text(b).indexOf('spin');
        b[i] = 'S'.charCodeAt(0); // same length
        fs.writeSync(p, b, mtime);
      },
    });
    expect(r1.ok).toBe(true);
    expect(edited).toBe(true);
    expect((await make(proj, S)).compiled).toEqual(['main.asm']);
  });

  it('warns about C sources instead of silently skipping them (finding 4)', async () => {
    const { fs, proj, dir } = await freshProject('blank_project');
    fs.writeSync(`${dir}/Sources/foo.c`, latin1Bytes('void foo(void) {}\n'));
    await proj.addFile(`${dir}/Sources/foo.c`);
    const r = await make(proj, S);
    expect(r.ok).toBe(true);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ severity: 'warning', tool: 'project', file: `${dir}/Sources/foo.c` });
    expect(r.messages[0].text).toMatch(/No C compiler.*foo\.c/);
  });
});

describe('linker and burner panel options (finding 5)', () => {
  it('parses -Alloc* and reports the rest', () => {
    expect(parseLinkerOptions('-AllocFirst -WmsgSd1100')).toEqual({ options: { alloc: 'first' }, ignored: ['-WmsgSd1100'] });
    expect(parseLinkerOptions('')).toEqual({ options: {}, ignored: [] });
  });

  itFx('passes -Alloc to the linker, records it on the command line, warns about unsupported options', async () => {
    const { fs, proj, dir } = await freshProject('blank_project');
    await make(proj, S);
    await proj.setOption('Standard', 'linker', '-AllocFirst');
    const r = await make(proj, S);
    expect(r).toMatchObject({ ok: true, linked: true, compiled: [] });
    expect(r.messages).toEqual([]);
    expect(readNoteMeta(fs.readSync(`${dir}/bin/Project.abs`)!)!.commandLine).toMatch(/^-AllocFirst -add\(/);
    await proj.setOption('Standard', 'linker', '-NoSuchOption');
    await proj.setOption('Standard', 'burner', '-F2');
    const r2 = await make(proj, S);
    expect(r2.ok).toBe(true);
    expect(r2.messages.map((m) => [m.severity, m.tool, m.text])).toEqual([
      ['warning', 'linker', 'Linker option "-NoSuchOption" is not supported by S12 Studio and was ignored'],
      ['warning', 'burner', 'Burner option "-F2" is not supported by S12 Studio and was ignored'],
    ]);
  });
});

describeFx('Remove Object Code (finding 8)', () => {
  it('also removes objects of files no longer in the project', async () => {
    const { fs, proj, dir } = await freshProject('blank_project');
    fs.writeSync(`${dir}/Sources/util.asm`, latin1Bytes(UTIL));
    await proj.addFile(`${dir}/Sources/util.asm`);
    expect((await make(proj, S)).compiled).toEqual(['main.asm', 'util.asm']);
    const obj = `${dir}/blank_project_Data/Standard/ObjectCode/util.asm.o`;
    expect(fs.readSync(obj)).toBeDefined();
    await proj.removeFile('util.asm');
    await make(proj, S);
    const removed = await removeObjectCode(proj);
    expect(removed).toContain(obj);
    expect(fs.readSync(obj)).toBeUndefined();
  });
});

describe('templates (finding 9)', () => {
  it('rejects names Windows cannot use', () => {
    for (const bad of ['con', 'CON', 'nul.lab', 'com1', 'LPT9', 'a.b.', 'trailing ', ' lead', 'a/b', 'a:b', 'tab\tname', '']) expect(() => validateProjectName(bad), bad).toThrow(/invalid/);
    for (const ok of ['Lab3', 'My Lab 4', 'console', 'lab.v2', 'com10']) expect(() => validateProjectName(ok), ok).not.toThrow();
  });

  itFx("copies a user's own *_data folder but drops IDE data folders of older project names", async () => {
    const fs = new MemoryFs();
    loadFixture(fs, 'Lab3', '/t/Lab3');
    fs.writeSync('/t/Lab3/sensor_data/run1.csv', latin1Bytes('1,2,3\r\n'));
    const r = await newProjectFromTemplate(fs, '/t/Lab3', '/w/Lab4', 'Lab4');
    expect(r.files).toContain('/w/Lab4/sensor_data/run1.csv');
    // the fixture's IDE data folders of older project names (found, not named here)
    const stale = [...new Set(fs.list('/t/Lab3').map((p) => /^\/t\/Lab3\/([^/]+_[Dd]ata)\//.exec(p)?.[1]))].filter((n) => n && n !== 'Lab3_Data' && n !== 'sensor_data');
    expect(stale.length).toBeGreaterThan(0);
    expect(fs.list('/w/Lab4').some((p) => stale.some((n) => p.includes(`/${n}/`)))).toBe(false);
    await expect(newProjectFromTemplate(fs, '/t/Lab3', '/w/Con', 'con')).rejects.toThrow(/invalid/);
    await expect(newMinimalProject(fs, '/w/x', 'x.')).rejects.toThrow(/invalid/);
  });
});

describe('model (findings 6, 10) and API additions', () => {
  async function lab3At(dir: string) {
    const fs = new MemoryFs();
    loadFixture(fs, 'Lab3', dir);
    await installCompilerRoot(fs, COMPILER);
    return { fs, proj: await openProject(fs, `${dir}/Lab3.mcp`, { compilerDir: COMPILER }) };
  }

  itFx('debugger arguments are normalised, split into argv and quoted when they contain spaces', async () => {
    const { proj } = await lab3At('C:/Users/Jane Doe/ME 3305/Lab3');
    const d = await proj.debuggerConfig();
    expect(d.argv).toEqual(['C:/Users/Jane Doe/ME 3305/Lab3/bin/Project.abs', '-Prod=C:/Users/Jane Doe/ME 3305/Lab3/P&E_Multilink_USB.ini', '-instance=icd12']);
    expect(d.args).toBe('"C:/Users/Jane Doe/ME 3305/Lab3/bin/Project.abs" "-Prod=C:/Users/Jane Doe/ME 3305/Lab3/P&E_Multilink_USB.ini" -instance=icd12');
    const env = await proj.debuggerEnvironment(d.iniPath!);
    expect(env.GENPATH.split(';')).toContain('C:/Users/Jane Doe/ME 3305/Lab3/Sources');
    expect(env.LIBPATH).toBe('/cw/lib/HC12c/include;/cw/lib/xgatec/include');
  });

  itFx('setConnection only accepts existing connections (case-insensitive)', async () => {
    const { fs, proj } = await lab3At('/work/Lab3');
    await expect(proj.setConnection('Nonexistent')).rejects.toThrow(/no connection "Nonexistent".*Full_Chip_Simulation/);
    expect(fs.readSync('/work/Lab3/Lab3.s12studio.json')).toBeUndefined();
    await proj.setConnection('full_chip_simulation');
    const d = await proj.debuggerConfig();
    expect(d).toMatchObject({ connection: 'Full_Chip_Simulation', instance: 'sim', iniPath: '/work/Lab3/Full_Chip_Simulation.ini' });
  });

  itFx('setDebug persists the per-file debug flag to the sidecar', async () => {
    const { fs, proj } = await lab3At('/work/Lab3');
    const mcp = fs.readSync('/work/Lab3/Lab3.mcp')!.slice();
    expect(proj.file('main.asm')!.debug).toBe(true);
    await proj.setDebug('MAIN.ASM', false);
    expect(proj.file('main.asm')!.debug).toBe(false);
    const again = await openProject(fs, '/work/Lab3/Lab3.mcp', { compilerDir: COMPILER });
    expect(again.file('main.asm')!.debug).toBe(false);
    await again.setDebug('main.asm', true);
    expect(again.sidecar.fileDebug).toBeUndefined();
    expect(Buffer.from(fs.readSync('/work/Lab3/Lab3.mcp')!).equals(Buffer.from(mcp))).toBe(true);
  });

  itFx('buildStatus reports out-of-date files and Code/Data without building', async () => {
    const { fs, proj, dir } = await freshProject('Lab3');
    fs.writes = [];
    const s0 = await buildStatus(proj);
    expect(fs.writes).toEqual([]);
    expect(s0.files).toMatchObject([{ name: 'main.asm', outOfDate: true, reason: 'never built', code: 0 }]);
    expect(s0.linkOutOfDate).toBe(true);
    const r = await make(proj, S);
    const s1 = await buildStatus(proj);
    expect(s1.files[0]).toMatchObject({ outOfDate: false, code: r.files[0].code, data: r.files[0].data });
    expect(s1).toMatchObject({ linkOutOfDate: false, absPath: `${dir}/bin/Project.abs` });
    fs.touch(`${dir}/prm/Project.prm`);
    expect(await buildStatus(proj)).toMatchObject({ files: [{ outOfDate: false }], linkOutOfDate: true, absPath: undefined });
    fs.touch(`${dir}/Sources/main.asm`);
    expect((await buildStatus(proj)).files[0]).toMatchObject({ outOfDate: true, reason: 'source or include changed' });
  });

  itFx('a build can be cancelled and concurrent builds of one project run one after the other', async () => {
    const { fs, proj, dir } = await freshProject('blank_project');
    const ac = new AbortController();
    ac.abort();
    const c = await make(proj, { ...S, signal: ac.signal });
    expect(c).toMatchObject({ ok: false, cancelled: true, compiled: [], linked: false });
    expect(fs.readSync(`${dir}/bin/Project.abs`)).toBeUndefined();
    const [a, b] = await Promise.all([make(proj, S), make(proj, S)]);
    expect(a).toMatchObject({ ok: true, compiled: ['main.asm'], linked: true });
    expect(b).toMatchObject({ ok: true, upToDate: true });
    expect(readElf(fs.readSync(`${dir}/bin/Project.abs`)!).sections.length).toBeGreaterThan(0);
  });
});
