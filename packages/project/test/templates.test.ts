import { describe, expect, it } from 'vitest';
import { readSRecords } from '@s12/formats';
import { MemoryFs, installCompilerRoot, make, newMinimalProject, newProjectFromTemplate, openProject } from '../src/index';
import { COMPILER, goldenBytes, latin1, loadFixture, describeFx } from './helpers';

describeFx('newProjectFromTemplate (Cal Poly blank_project)', async () => {
  const fs = new MemoryFs();
  loadFixture(fs, 'blank_project', '/templates/blank_project');
  await installCompilerRoot(fs, COMPILER);
  const before = fs.list('/templates').map((p) => [p, fs.readSync(p)!.slice()] as const);
  const res = await newProjectFromTemplate(fs, '/templates/blank_project', '/work/MyLab', 'MyLab');

  it('renames the .mcp and the data folder and leaves the template untouched', () => {
    expect(res.projectPath).toBe('/work/MyLab/MyLab.mcp');
    expect(Buffer.from(fs.readSync('/work/MyLab/MyLab.mcp')!).equals(Buffer.from(goldenBytes('blank_project', 'blank_project.mcp')))).toBe(true);
    expect(fs.readSync('/work/MyLab/MyLab_Data/CWSettingsWindows.stg')).toBeDefined();
    expect(fs.list('/work/MyLab').some((p) => p.includes('blank_project'))).toBe(false);
    for (const [p, b] of before) expect(Buffer.from(fs.readSync(p)!).equals(Buffer.from(b))).toBe(true);
  });

  it('skips build products by default', () => {
    expect(fs.readSync('/work/MyLab/bin/Project.abs')).toBeUndefined();
    expect(fs.readSync('/work/MyLab/bin/main.lst')).toBeUndefined();
    expect(fs.readSync('/work/MyLab/bin/Project.xpr')).toBeDefined();
    expect(fs.list('/work/MyLab/MyLab_Data/Standard/ObjectCode')).toEqual([]);
    expect(fs.list('/work/MyLab').some((p) => p.endsWith('.tdt'))).toBe(false);
    expect(fs.readSync('/work/MyLab/Sources/Libraries/ME305LibV4.0.lib')).toBeDefined();
  });

  it('opens and builds like the template', async () => {
    const proj = await openProject(fs, res.projectPath, { compilerDir: COMPILER });
    expect(proj.name).toBe('MyLab');
    expect(proj.dataDir).toBe('/work/MyLab/MyLab_Data');
    const r = await make(proj, { user: 'u', stamp: () => 'Thu Oct 29 12:00:00 2026' });
    expect(r.ok).toBe(true);
    expect(latin1(fs.readSync('/work/MyLab/bin/main.lst'))).toBe(latin1(goldenBytes('blank_project', 'bin/main.lst')));
    expect(fs.readSync('/work/MyLab/MyLab_Data/Standard/ObjectCode/main.asm.o')).toBeDefined();
    const s19 = readSRecords(latin1(fs.readSync('/work/MyLab/bin/Project.abs.s19')));
    const gold = readSRecords(latin1(goldenBytes('blank_project', 'bin/Project.abs.s19')));
    expect(s19.blocks).toEqual(gold.blocks);
  });

  it('can keep build products and refuses a non-empty destination', async () => {
    const r = await newProjectFromTemplate(fs, '/templates/blank_project', '/work/Copy', 'Copy', { clean: false });
    expect(r.files).toContain('/work/Copy/bin/Project.abs');
    expect(r.files).toContain('/work/Copy/Copy_Data/Standard/ObjectCode/main.asm.o');
    await expect(newProjectFromTemplate(fs, '/templates/blank_project', '/work/Copy', 'X')).rejects.toThrow(/not empty/);
    await expect(newProjectFromTemplate(fs, '/templates/blank_project', '/work/Bad', 'a/b')).rejects.toThrow(/invalid/);
  });

  it('drops stale data folders of older project names (Lab3 as a template)', async () => {
    loadFixture(fs, 'Lab3', '/templates/Lab3');
    const r = await newProjectFromTemplate(fs, '/templates/Lab3', '/work/L4', 'Lab4');
    expect(r.projectPath).toBe('/work/L4/Lab4.mcp');
    // the fixture's IDE data folders of older project names (found, not named here)
    const stale = [...new Set(fs.list('/templates/Lab3').map((p) => /^\/templates\/Lab3\/([^/]+_[Dd]ata)\//.exec(p)?.[1]))].filter((n) => n && n !== 'Lab3_Data');
    expect(stale.length).toBeGreaterThan(0);
    expect(fs.list('/work/L4').some((p) => stale.some((n) => p.includes(`/${n}/`)))).toBe(false);
    expect(fs.readSync('/work/L4/Lab4_Data/CWSettingsWindows.stg')).toBeDefined();
  });
});

describe('newMinimalProject (generic template, no .mcp)', () => {
  it('creates a standalone project that builds with the bundled compiler root', async () => {
    const fs = new MemoryFs();
    await installCompilerRoot(fs, COMPILER);
    const res = await newMinimalProject(fs, '/work/Blinky', 'Blinky');
    expect(res.projectPath).toBe('/work/Blinky/Blinky.s12studio.json');
    const proj = await openProject(fs, res.projectPath, { compilerDir: COMPILER });
    expect(proj.mcpPath).toBeUndefined();
    expect(proj.dataDir).toBe('/work/Blinky/Blinky_Data');
    expect(proj.file('main.asm')?.path).toBe('/work/Blinky/Sources/main.asm');
    const r = await make(proj, { user: 'u', stamp: () => 'Thu Oct 29 12:00:00 2026' });
    expect(r.messages.map((m) => m.display)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.files[0].includes).toEqual(['/work/Blinky/Sources/derivative.inc', '/cw/lib/HC12c/include/mc9s12xdp512.inc']);
    const s19 = readSRecords(latin1(fs.readSync('/work/Blinky/bin/Project.abs.s19')));
    expect(s19.blocks.some((b) => b.address === 0xfffe)).toBe(true); // reset vector from the PRM's VECTOR 0
    expect(s19.blocks.some((b) => b.address === 0xc000)).toBe(true); // MyCode holds INIT Entry, so it becomes .init (ROM_C000)
    const d = await proj.debuggerConfig();
    expect(d.connection).toBe('Full_Chip_Simulation');
    expect(d.connections.map((c) => [c.name, c.target])).toEqual([['Full_Chip_Simulation', 'sim']]);

    // edits of a standalone project persist in the same sidecar
    fs.writeSync('/work/Blinky/Sources/util.asm', new TextEncoder().encode('            XDEF util\r\nMyCode: SECTION\r\nutil:       RTS\r\n'));
    await proj.addFile('/work/Blinky/Sources/util.asm');
    const again = await openProject(fs, res.projectPath, { compilerDir: COMPILER });
    expect(again.currentTarget.linkOrder.at(-1)).toBe('util.asm');
    const r2 = await make(again, { user: 'u', stamp: () => 'Thu Oct 29 12:00:00 2026' });
    expect(r2).toMatchObject({ ok: true, compiled: ['util.asm'], skipped: ['main.asm'] });
  });
});
