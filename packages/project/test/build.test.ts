import { describe, expect, it } from 'vitest';
import { bringUpToDate, clean, compileFile, latin1Bytes, make, preprocessFile, removeObjectCode, type BuildMessage } from '../src/index';
import { freshProject, describeFx } from './helpers';

const STAMP = { user: 'student', stamp: () => 'Thu Oct 29 12:00:00 2026' };

describeFx('incremental Make', () => {
  it('skips unchanged files, rebuilds after a touch, an option change or a deleted output', async () => {
    const { fs, proj, dir } = await freshProject('Lab3');
    const r1 = await make(proj, STAMP);
    expect(r1.ok).toBe(true);
    expect(r1.compiled).toEqual(['main.asm']);

    fs.writes = [];
    const r2 = await make(proj, STAMP);
    expect(r2).toMatchObject({ ok: true, upToDate: true, compiled: [], skipped: ['main.asm'], linked: false });
    expect(r2.absPath).toBe(`${dir}/bin/Project.abs`);
    expect(r2.files[0].code).toBe(r1.files[0].code);
    expect(fs.writes).toEqual([]);

    fs.touch(`${dir}/Sources/main.asm`);
    const r3 = await make(proj, STAMP);
    expect(r3).toMatchObject({ ok: true, upToDate: false, compiled: ['main.asm'], linked: true });

    // touching the linker parameter file relinks without reassembling
    fs.touch(`${dir}/prm/Project.prm`);
    const r4 = await make(proj, STAMP);
    expect(r4).toMatchObject({ compiled: [], linked: true });

    await proj.setOption('Standard', 'assembler', '-CPUHCS12X -L=%(TEXTPATH)\\%n.lst');
    expect((await make(proj, STAMP)).compiled).toEqual(['main.asm']);

    await fs.remove(`${dir}/bin/Project.abs.s19`);
    const r6 = await make(proj, STAMP);
    expect(r6).toMatchObject({ compiled: [], linked: true });
    expect(fs.readSync(`${dir}/bin/Project.abs.s19`)).toBeDefined();

    const r7 = await make(proj, { ...STAMP, force: true });
    expect(r7).toMatchObject({ compiled: ['main.asm'], linked: true });
  });

  it('tracks INCLUDEd files', async () => {
    const { fs, proj, dir } = await freshProject('blank_project');
    const src = new TextDecoder('latin1').decode(fs.readSync(`${dir}/Sources/main.asm`)!);
    fs.writeSync(`${dir}/Sources/main.asm`, latin1Bytes(src.replace(/^(\s*XDEF)/m, " INCLUDE 'derivative.inc'\r\n$1")));
    const r1 = await make(proj, STAMP);
    expect(r1.ok, r1.messages.map((m) => m.display).join('')).toBe(true);
    expect(r1.files[0].includes).toEqual([`${dir}/Sources/derivative.inc`, '/cw/lib/HC12c/include/mc9s12xdp512.inc']);
    expect((await make(proj, STAMP)).upToDate).toBe(true);
    fs.touch('/cw/lib/HC12c/include/mc9s12xdp512.inc');
    expect((await make(proj, STAMP)).compiled).toEqual(['main.asm']);
  });
});

describeFx('errors', () => {
  it('reports assembler errors with file/line and does not link', async () => {
    const { fs, proj, dir } = await freshProject('blank_project');
    const lines = new TextDecoder('latin1').decode(fs.readSync(`${dir}/Sources/main.asm`)!).split(/\r?\n/);
    const at = lines.findIndex((l) => /^\s*spin:/.test(l) || /bra\s+spin/i.test(l));
    expect(at).toBeGreaterThan(0);
    lines.splice(at, 0, '            LDAA  UNDEFINED_SYMBOL');
    fs.writeSync(`${dir}/Sources/main.asm`, latin1Bytes(lines.join('\r\n')));
    const seen: BuildMessage[] = [];
    const r = await make(proj, { ...STAMP, onMessage: (m) => seen.push(m) });
    expect(r.ok).toBe(false);
    expect(r.linked).toBe(false);
    expect(r.errors).toBeGreaterThan(0);
    const e = r.messages.find((m) => m.severity === 'error')!;
    expect(e).toMatchObject({ tool: 'assembler', file: `${dir}/Sources/main.asm`, line: at + 1 });
    expect(e.code).toMatch(/^A\d+/);
    expect(e.display).toMatch(new RegExp(`^Error   : ${e.code}: .*\\nmain\\.asm line ${at + 1}\\n$`));
    expect(seen).toEqual(r.messages);
    expect(fs.readSync(`${dir}/bin/Project.abs`)).toBeUndefined();
    expect(fs.readSync(`${dir}/blank_project_Data/Standard/ObjectCode/main.asm.o`)).toBeUndefined();

    // the next Make retries the failed file; fixing it builds and links
    lines.splice(at, 1);
    fs.writeSync(`${dir}/Sources/main.asm`, latin1Bytes(lines.join('\r\n')));
    const r2 = await make(proj, STAMP);
    expect(r2).toMatchObject({ ok: true, compiled: ['main.asm'], linked: true });
  });

  it('reports errors inside an included file at the included file', async () => {
    const { fs, proj, dir } = await freshProject('blank_project');
    fs.writeSync(`${dir}/Sources/bad.inc`, latin1Bytes('; ok\r\n            BOGUS_OPCODE 1\r\n'));
    const src = new TextDecoder('latin1').decode(fs.readSync(`${dir}/Sources/main.asm`)!);
    fs.writeSync(`${dir}/Sources/main.asm`, latin1Bytes(src.replace(/^(\s*XDEF)/m, " INCLUDE 'BAD.INC'\r\n$1")));
    const r = await make(proj, STAMP);
    expect(r.ok).toBe(false);
    expect(r.messages.find((m) => m.severity === 'error')).toMatchObject({ file: `${dir}/Sources/bad.inc`, line: 2 });
  });

  it('reports a missing source file and a missing PRM', async () => {
    const { fs, proj, dir } = await freshProject('blank_project');
    await fs.remove(`${dir}/Sources/main.asm`);
    const r = await make(proj, STAMP);
    expect(r.ok).toBe(false);
    expect(r.messages[0].text).toMatch(/Could not find file "main\.asm"/);

    const b = await freshProject('blank_project');
    await b.proj.removeFile('Project.prm');
    const r2 = await make(b.proj, STAMP);
    expect(r2.ok).toBe(false);
    expect(r2.compiled).toEqual(['main.asm']);
    expect(r2.messages[0].text).toMatch(/no linker parameter/);
  });

  it('reports linker errors', async () => {
    const { fs, proj, dir } = await freshProject('blank_project');
    const src = new TextDecoder('latin1').decode(fs.readSync(`${dir}/Sources/main.asm`)!);
    fs.writeSync(`${dir}/Sources/main.asm`, latin1Bytes(src.replace(/^(spin:.*)$/m, '         XREF  NOT_DEFINED_ANYWHERE\r\n         JSR   NOT_DEFINED_ANYWHERE\r\n$1')));
    const r = await make(proj, STAMP);
    expect(r.ok).toBe(false);
    expect(r.compiled).toEqual(['main.asm']);
    expect(r.linked).toBe(false);
    const e = r.messages.find((m) => m.severity === 'error')!;
    expect(e.tool).toBe('linker');
    expect(e.text).toContain('NOT_DEFINED_ANYWHERE');
    expect(e.display).toMatch(/^Link Error\s*: L\d+/);
    expect(fs.readSync(`${dir}/bin/Project.abs`)).toBeUndefined();
  });
});

describeFx('other build operations', () => {
  it('Compile, Bring Up To Date, Preprocess, Remove Object Code, Clean', async () => {
    const { fs, proj, dir } = await freshProject('Lab3');
    const c = await compileFile(proj, 'main.asm', STAMP);
    expect(c).toMatchObject({ ok: true, compiled: ['main.asm'], linked: false });
    expect(fs.readSync(`${dir}/Lab3_Data/Standard/ObjectCode/main.asm.o`)).toBeDefined();
    expect(fs.readSync(`${dir}/bin/Project.abs`)).toBeUndefined();
    expect((await bringUpToDate(proj, STAMP)).compiled).toEqual([]);
    expect((await compileFile(proj, 'Project.prm', STAMP)).ok).toBe(false);
    expect((await preprocessFile(proj, 'main.asm'))[0].severity).toBe('information');

    const m = await make(proj, STAMP);
    expect(m).toMatchObject({ compiled: [], linked: true });

    const removed = await removeObjectCode(proj);
    expect(removed).toEqual([`${dir}/Lab3_Data/Standard/ObjectCode/main.asm.o`, `${dir}/Lab3_Data/Standard/s12studio-build.json`]);
    expect(fs.readSync(`${dir}/Lab3_Data/Standard/TargetDataWindows.tdt`)).toBeDefined();
    expect((await make(proj, STAMP)).compiled).toEqual(['main.asm']);

    const cleaned = await clean(proj);
    for (const f of ['bin/main.lst', 'bin/main.dbg', 'bin/Project.abs', 'bin/Project.map', 'bin/Project.abs.s19', 'bin/Project.abs.glo', 'bin/Project.abs.full.s19']) {
      expect(cleaned).toContain(`${dir}/${f}`);
      expect(fs.readSync(`${dir}/${f}`)).toBeUndefined();
    }
    expect(fs.readSync(`${dir}/bin/Project.xpr`)).toBeDefined();
    expect(fs.readSync(`${dir}/Lab3.mcp`)).toBeDefined();
  });
});

describeFx('forceFiles (Touch mark)', () => {
  it('Make and Bring Up To Date reassemble touched files even when up to date, and Make relinks', async () => {
    const { proj } = await freshProject('Lab3');
    expect((await make(proj, STAMP)).ok).toBe(true);
    expect(await make(proj, STAMP)).toMatchObject({ upToDate: true, compiled: [] });
    expect(await make(proj, { ...STAMP, forceFiles: ['MAIN.ASM'] })).toMatchObject({ ok: true, upToDate: false, compiled: ['main.asm'], linked: true });
    expect(await bringUpToDate(proj, { ...STAMP, forceFiles: ['main.asm'] })).toMatchObject({ compiled: ['main.asm'] });
    // the freshly assembled object relinks without reassembling; then an unknown name forces nothing
    expect(await make(proj, STAMP)).toMatchObject({ compiled: [], linked: true });
    expect(await make(proj, { ...STAMP, forceFiles: ['other.asm'] })).toMatchObject({ upToDate: true, compiled: [] });
  });
});
