import { describe, expect, it } from 'vitest';
import { MemoryFs, groupPathOf, installCompilerRoot, openProject, utf8Text, type GroupChild } from '../src/index';
import { COMPILER, loadFixture, describeFx } from './helpers';

async function lab3() {
  const fs = new MemoryFs();
  loadFixture(fs, 'Lab3', '/work/Lab3');
  await installCompilerRoot(fs, COMPILER);
  const mcpBytes = fs.readSync('/work/Lab3/Lab3.mcp')!.slice();
  const proj = await openProject(fs, '/work/Lab3/Lab3.mcp', { compilerDir: COMPILER });
  return { fs, proj, mcpBytes };
}

const names = (g: GroupChild[]): unknown => g.map((c) => (c.type === 'group' ? { [c.name]: names(c.children) } : c.name));

describeFx('openProject (Lab3.mcp)', async () => {
  const { proj } = await lab3();

  it('has the decoded target and paths', () => {
    expect(proj.name).toBe('Lab3');
    expect(proj.dataDir).toBe('/work/Lab3/Lab3_Data');
    expect(proj.targets.map((t) => t.name)).toEqual(['Standard']);
    const t = proj.currentTarget;
    expect(t.linker).toBe('Linker for HC12');
    expect(t.outputDir).toBe('{Project}bin');
    expect(t.absPath).toBe('/work/Lab3/bin/Project.abs');
    expect(t.options.assembler).toBe('-CPUHCS12X -L=%(TEXTPATH)\\%n.lst -Li');
    expect(t.accessPaths.user).toHaveLength(19);
    expect(t.accessPaths.user.filter((a) => a.exists).map((a) => a.display)).toEqual([
      '{Project}', '{Project}bin', '{Project}prm', '{Project}cmd', '{Project}Sources',
      '{Compiler}lib\\HC12c\\lib', '{Compiler}lib\\HC12c\\src', '{Project}Sources\\Libraries',
    ]);
    expect(t.accessPaths.system[0]).toMatchObject({ display: '{Compiler}lib\\HC12c\\include', path: '/cw/lib/HC12c/include', exists: true });
    expect(proj.objectDir()).toBe('/work/Lab3/Lab3_Data/Standard/ObjectCode');
  });

  it('resolves files through the access paths and classifies them', () => {
    const f = Object.fromEntries(proj.files.map((x) => [x.name, [x.kind, x.path, x.foundIn]]));
    expect(f).toEqual({
      'derivative.inc': ['inc', '/work/Lab3/Sources/derivative.inc', '{Project}Sources'],
      'burner.bbl': ['bbl', '/work/Lab3/prm/burner.bbl', '{Project}prm'],
      'Project.prm': ['prm', '/work/Lab3/prm/Project.prm', '{Project}prm'],
      'mc9s12xdp512.inc': ['inc', '/cw/lib/HC12c/include/mc9s12xdp512.inc', '{Compiler}lib\\HC12c\\include'],
      'Project.map': ['map', '/work/Lab3/bin/Project.map', '{Project}bin'],
      'ME305LibV4.0.lib': ['lib', '/work/Lab3/Sources/Libraries/ME305LibV4.0.lib', '{Project}Sources\\Libraries'],
      'main.asm': ['asm', '/work/Lab3/Sources/main.asm', '{Project}Sources'],
    });
    expect(proj.file('MAIN.ASM')?.name).toBe('main.asm');
  });

  it('has the group tree and link order', () => {
    expect(names(proj.groups)).toEqual([
      { Sources: ['main.asm'] },
      { Includes: ['derivative.inc', 'mc9s12xdp512.inc'] },
      { Libraries: ['ME305LibV4.0.lib'] },
      { 'Project Settings': [{ 'Linker Files': ['burner.bbl', 'Project.map', 'Project.prm'] }] },
    ]);
    expect(proj.currentTarget.linkOrder).toEqual(['derivative.inc', 'mc9s12xdp512.inc', 'burner.bbl', 'Project.prm', 'Project.map', 'ME305LibV4.0.lib', 'main.asm']);
  });

  it('decodes the debugger configuration and the connections', async () => {
    const d = await proj.debuggerConfig();
    expect(d.app).toBe('{Compiler}prog\\hiwave.exe');
    expect(d.appPath).toBe('/cw/prog/hiwave.exe');
    expect(d.connection).toBe('P&E_Multilink_USB');
    expect(d.iniPath).toBe('/work/Lab3/P&E_Multilink_USB.ini');
    expect(d.instance).toBe('icd12');
    expect(d.args).toBe('/work/Lab3/bin/Project.abs -Prod=/work/Lab3/P&E_Multilink_USB.ini -instance=icd12');
    expect(d.argv).toEqual(['/work/Lab3/bin/Project.abs', '-Prod=/work/Lab3/P&E_Multilink_USB.ini', '-instance=icd12']);
    expect(d.connections.map((c) => [c.name, c.target])).toEqual([
      ['CyclonePro_Serial', 'icd12'],
      ['CyclonePro_USB', 'icd12'],
      ['Full_Chip_Simulation', 'sim'],
      ['P&E_Multilink_USB', 'icd12'],
    ]);
    const env = await proj.debuggerEnvironment(d.iniPath!);
    expect(env.OBJPATH).toBe('/work/Lab3/bin');
    expect(env.GENPATH.split(';')[0]).toBe('/work/Lab3/Sources');
    // normalised and in the on-disk spelling of the bundled compiler root (lib/HC12c, lib/xgatec)
    expect(env.LIBPATH).toBe('/cw/lib/HC12c/include;/cw/lib/xgatec/include');
    expect(Object.values(env).some((v) => v.includes('\\'))).toBe(false);
  });

  it('exposes the wizard settings', () => {
    expect(proj.base.wizard).toEqual({ chip: 'MC9S12XDP512', language: 'Relocatable assembly', connection: 'P&E USB BDM Multilink' });
  });
});

describeFx('sidecar edits', () => {
  it('persist only to the sidecar; the .mcp bytes never change', async () => {
    const { fs, proj, mcpBytes } = await lab3();
    fs.writeSync('/work/Lab3/Sources/extra.asm', new TextEncoder().encode('  NOP\n'));
    await proj.addFile('/work/Lab3/Sources/extra.asm');
    await proj.moveFile('derivative.inc', ['Project Settings']);
    await proj.removeFile('Project.map');
    await proj.addGroup(['Docs']);
    await proj.renameGroup(['Docs'], 'Notes');
    await proj.setOption('Standard', 'assembler', '-CPUHCS12X -L=%(TEXTPATH)\\%n.lst');
    await proj.moveInLinkOrder('Standard', 'extra.asm', 0);
    await proj.setConnection('Full_Chip_Simulation');
    await proj.setCurrentTarget('Standard');

    expect(Buffer.from(fs.readSync('/work/Lab3/Lab3.mcp')!).equals(Buffer.from(mcpBytes))).toBe(true);
    const side = JSON.parse(utf8Text(fs.readSync('/work/Lab3/Lab3.s12studio.json')!));
    expect(side.addedFiles).toEqual([{ name: 'extra.asm', path: 'Sources/extra.asm' }]);
    expect(side.removedFiles).toEqual(['Project.map']);
    expect(side.mcpHash).toBe(proj.mcpHash);

    const again = await openProject(fs, '/work/Lab3/Lab3.mcp', { compilerDir: COMPILER });
    expect(again.file('extra.asm')).toMatchObject({ kind: 'asm', path: '/work/Lab3/Sources/extra.asm', origin: 'sidecar', targets: ['Standard'] });
    expect(again.file('Project.map')).toBeUndefined();
    expect(groupPathOf(again.groups, 'derivative.inc')).toEqual(['Project Settings']);
    expect(groupPathOf(again.groups, 'extra.asm')).toEqual(['Sources']);
    expect(names(again.groups)).toContainEqual({ Notes: [] });
    expect(again.currentTarget.options.assembler).toBe('-CPUHCS12X -L=%(TEXTPATH)\\%n.lst');
    expect(again.currentTarget.linkOrder).toEqual(['extra.asm', 'derivative.inc', 'mc9s12xdp512.inc', 'burner.bbl', 'Project.prm', 'ME305LibV4.0.lib', 'main.asm']);
    const d = await again.debuggerConfig();
    expect(d.connection).toBe('Full_Chip_Simulation');
    expect(d.argsTemplate).toBe('%targetFilePath -Prod=%projectFileDir\\Full_Chip_Simulation.ini -instance=sim');
    expect(again.warnings.some((w) => /changed outside/.test(w))).toBe(false);

    // undo: re-adding a removed .mcp file and restoring the option
    await again.addFile('/work/Lab3/bin/Project.map');
    await again.setOption('Standard', 'assembler', undefined);
    expect(again.file('Project.map')).toBeDefined();
    expect(again.currentTarget.options.assembler).toBe('-CPUHCS12X -L=%(TEXTPATH)\\%n.lst -Li');
    await again.removeFile('extra.asm');
    const side2 = JSON.parse(utf8Text(fs.readSync('/work/Lab3/Lab3.s12studio.json')!));
    expect(side2.addedFiles.map((a: { name: string }) => a.name)).toEqual(['Project.map']);
    expect(side2.removedFiles).toEqual([]);
    expect(Buffer.from(fs.readSync('/work/Lab3/Lab3.mcp')!).equals(Buffer.from(mcpBytes))).toBe(true);
  });

  it('removing a group removes its files from the project', async () => {
    const { proj } = await lab3();
    await proj.removeGroup(['Project Settings', 'Linker Files']);
    expect(proj.file('burner.bbl')).toBeUndefined();
    expect(proj.file('Project.prm')).toBeUndefined();
    expect(proj.sidecar.removedFiles.sort()).toEqual(['Project.map', 'Project.prm', 'burner.bbl']);
  });

  it('rejects duplicates and unknown names', async () => {
    const { proj } = await lab3();
    await expect(proj.addFile('/work/Lab3/Sources/main.asm')).rejects.toThrow(/already/);
    await expect(proj.removeFile('nope.asm')).rejects.toThrow(/not in the project/);
    await expect(proj.setOption('Nope', 'assembler', '')).rejects.toThrow(/no target/);
  });

  it('detects external .mcp changes and re-imports', async () => {
    const { fs, proj } = await lab3();
    await proj.setConnection('Full_Chip_Simulation');
    expect(await proj.checkExternalChanges()).toEqual({ mcp: false, sidecar: false });
    const b = fs.readSync('/work/Lab3/Lab3.mcp')!.slice();
    b[0x40] ^= 0xff; // inside the subtitle padding: still a valid project
    fs.writeSync('/work/Lab3/Lab3.mcp', b);
    expect(await proj.checkExternalChanges()).toEqual({ mcp: true, sidecar: false });
    const re = await openProject(fs, '/work/Lab3/Lab3.mcp', { compilerDir: COMPILER });
    expect(re.mcpChangedExternally).toBe(true);
    expect(re.warnings.some((w) => /changed outside S12 Studio/.test(w))).toBe(true);
    expect((await re.debuggerConfig()).connection).toBe('Full_Chip_Simulation');
  });

  it('finds the .mcp and data folder case-insensitively', async () => {
    const fs = new MemoryFs();
    loadFixture(fs, 'blank_project', '/w/BP');
    const p = await openProject(fs, '/w/bp/BLANK_PROJECT.MCP');
    expect(p.mcpPath).toBe('/w/BP/blank_project.mcp');
    expect(p.dataDir).toBe('/w/BP/blank_project_Data');
    // without a compiler root, {Compiler} paths do not exist and mc9s12xdp512.inc stays unresolved
    expect(p.file('mc9s12xdp512.inc')?.path).toBeUndefined();
    expect(p.file('main.asm')?.path).toBe('/w/BP/Sources/main.asm');
  });
});
