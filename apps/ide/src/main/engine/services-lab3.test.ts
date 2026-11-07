/**
 * Main-process services on a temp copy of fixtures/Lab3 (+ blank_project) with the real engine packages: project
 * open/edit (sidecar only, the .mcp bytes never change), external-change watching, Make with streamed messages and
 * per-file Code/Data, outputs vs the golden files, New Project (blank_project copy, generic), rebuild-while-debugging notice.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSRecords } from '@s12/formats';
import { normPath } from '@s12/project';
import { copyFixture, FIXTURES, hasFixtures, describeFx, itFx } from '../../../test/fixtures';
import type { BuildMessageInfo, BuildProgressInfo, BuildResultInfo } from '../../shared/api/build';
import type { ProjectInfo } from '../../shared/api/project';
import { EventBus } from '../events';
import { BuildService } from './build-service';
import { resolveLaunch } from './debug-launch';
import { ProjectService } from './project-service';
import { notifyRebuild } from './rebuild-notify';
import { findTemplatesDir } from './templates-dir';

// private fixtures (Lab3 copy, blank_project template); the generic-template tests run without them
const lab3 = hasFixtures ? copyFixture('Lab3') : { dir: '/nonexistent/Lab3', dispose: () => undefined };
const work = mkdtempSync(join(tmpdir(), 's12ide-svc-'));
afterAll(() => {
  svc.close();
  lab3.dispose();
  rmSync(work, { recursive: true, force: true });
});

const golden = (rel: string) => readFileSync(join(FIXTURES, 'Lab3', rel));
const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');
const mcpPath = join(lab3.dir, 'Lab3.mcp');
const mcpBytes = hasFixtures ? readFileSync(mcpPath) : Buffer.alloc(0);

const bus = new EventBus();
const events: { domain: string; event: string; payload: unknown; to?: string }[] = [];
bus.attach((domain, event, payload, to) => events.push({ domain, event, payload, to }));
const of = <T,>(domain: string, event: string) => events.filter((e) => e.domain === domain && e.event === event).map((e) => e.payload as T);
const templatesDir = findTemplatesDir([FIXTURES]);
const svc = new ProjectService(bus, { compilerDir: join(work, 'cw'), ensureCompilerRoot: true, templatesDir, watchExternal: true, watchDebounceMs: 50 });
const builds = new BuildService(bus, svc);

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describeFx('ProjectService + BuildService on a Lab3 copy', () => {
  let info: ProjectInfo;

  it('opens Lab3.mcp: groups, targets, link order, connections', async () => {
    info = await svc.open(mcpPath);
    expect(info.name).toBe('Lab3');
    expect(info.mcpPath).toBe(mcpPath);
    expect(info.sidecarPath).toBe(normPath(join(lab3.dir, 'Lab3.s12studio.json')));
    expect(info.targets.map((t) => t.name)).toEqual(['Standard']);
    expect(info.targets[0].linkOrder).toContain('main.asm');
    expect(info.connections.map((c) => c.target)).toEqual(expect.arrayContaining(['sim', 'icd12']));
    expect(of('project', 'changed').length).toBeGreaterThan(0);
  });

  it('Make (force): 0 errors, streamed progress/messages, Code/Data columns, outputs equal the goldens', async () => {
    events.length = 0;
    const r = await builds.make({ force: true });
    expect(r.ok).toBe(true);
    expect(r.errors).toBe(0);
    expect(r.compiled).toContain('main.asm');
    expect(r.linked).toBe(true);
    expect(r.absPath).toBe(normPath(join(lab3.dir, 'bin/Project.abs')));
    expect(of('build', 'started')).toEqual([{ kind: 'make', target: 'Standard' }]);
    expect(of<BuildProgressInfo>('build', 'progress').map((p) => p.step)).toEqual(expect.arrayContaining(['assemble', 'link', 'done']));
    expect(of<BuildResultInfo>('build', 'finished')[0].ok).toBe(true);
    expect(events.filter((e) => e.domain === 'build').every((e) => e.to === 'ide')).toBe(true);
    for (const m of of<BuildMessageInfo>('build', 'message')) expect(m.severity).not.toBe('error');
    // project window Code/Data + touch columns
    const main = (await svc.fullInfo()).files.find((f) => f.name === 'main.asm')!;
    expect(main.code).toBeGreaterThan(0);
    expect(main.touched).toBe(false);
    expect(r.files.find((f) => f.name === 'main.asm')?.code).toBe(main.code);
    // byte-identical where no path/user/time is embedded; the rest differs only in those
    const out = (rel: string) => readFileSync(join(lab3.dir, rel));
    expect(latin1(out('bin/main.lst'))).toBe(latin1(golden('bin/main.lst')));
    expect(latin1(out('bin/main.dbg'))).toBe(latin1(golden('bin/main.dbg')));
    const a = latin1(out('bin/Project.map')).split('\r\n');
    const b = latin1(golden('bin/Project.map')).split('\r\n');
    const i = b.findIndex((l) => l.startsWith('PROGRAM '));
    expect([...a.slice(0, i), ...a.slice(i + 1)]).toEqual([...b.slice(0, i), ...b.slice(i + 1)]);
    for (const f of ['bin/Project.abs.s19', 'bin/Project.abs.glo']) {
      expect(latin1(out(f)).split('\r\n').slice(1)).toEqual(latin1(golden(f)).split('\r\n').slice(1));
      expect(readSRecords(latin1(out(f))).header).toBe(join(lab3.dir, 'bin/Project.abs'));
    }
  });

  it('a second Make is up to date; touching main.asm marks it and Make recompiles it', async () => {
    const r = await builds.make();
    expect(r.upToDate).toBe(true);
    const src = join(lab3.dir, 'Sources/main.asm');
    writeFileSync(src, readFileSync(src, 'latin1') + '\r\n; touched\r\n', 'latin1');
    await svc.refreshStatus();
    expect((await svc.fullInfo()).files.find((f) => f.name === 'main.asm')?.touched).toBe(true);
    const r2 = await builds.make();
    expect(r2.compiled).toEqual(['main.asm']);
    expect((await svc.fullInfo()).files.find((f) => f.name === 'main.asm')?.touched).toBe(false);
  });

  it('Touch column: a touched up-to-date file is reassembled and relinked by Make; the mark clears only on success', async () => {
    expect((await builds.make()).upToDate).toBe(true);
    await svc.setTouched('main.asm', true);
    await svc.refreshStatus(); // a status refresh (content is up to date) keeps the user's mark
    expect((await svc.fullInfo()).files.find((f) => f.name === 'main.asm')?.touched).toBe(true);
    const r = await builds.make();
    expect(r).toMatchObject({ ok: true, upToDate: false, compiled: ['main.asm'], linked: true });
    expect((await svc.fullInfo()).files.find((f) => f.name === 'main.asm')?.touched).toBe(false);
    expect((await builds.make()).upToDate).toBe(true);
    // untouch before building: nothing is forced
    await svc.setTouched('main.asm', true);
    await svc.setTouched('main.asm', false);
    expect((await builds.make()).upToDate).toBe(true);
  });

  it('a Make that throws (output not writable) ends as a failed build with an error message; the next Make works', async () => {
    const abs = join(lab3.dir, 'bin/Project.abs');
    const saved = readFileSync(abs);
    rmSync(abs);
    mkdirSync(join(abs, 'blocker'), { recursive: true }); // writing the .abs now fails (EISDIR)
    events.length = 0;
    try {
      const r = await builds.make({ force: true });
      expect(r.ok).toBe(false);
      expect(r.errors).toBeGreaterThan(0);
      expect(builds.building).toBe(false);
      const fin = of<BuildResultInfo>('build', 'finished');
      expect(fin).toHaveLength(1);
      expect(fin[0].ok).toBe(false);
      const err = of<BuildMessageInfo>('build', 'message').find((m) => m.severity === 'error')!;
      expect(err.tool).toBe('linker');
      expect(err.display).toMatch(/^Error\s*: Linking Project\.abs failed: /);
      expect(r.messages).toContainEqual(err);
    } finally {
      rmSync(abs, { recursive: true, force: true });
      writeFileSync(abs, saved);
    }
    const again = await builds.make({ force: true });
    expect(again.ok).toBe(true);
  });

  it('Compile streams assembler errors with CW code, file, line and column', async () => {
    const src = join(lab3.dir, 'Sources/main.asm');
    const orig = readFileSync(src, 'latin1');
    writeFileSync(src, orig + '\r\n        BOGUSOP  #1\r\n', 'latin1');
    events.length = 0;
    const r = await builds.compile(['main.asm']);
    expect(r.ok).toBe(false);
    expect(r.errors).toBeGreaterThan(0);
    const err = of<BuildMessageInfo>('build', 'message').find((m) => m.severity === 'error')!;
    expect(err.tool).toBe('assembler');
    expect(err.code).toMatch(/^A\d+$/);
    expect(err.file).toBe(src);
    expect(err.line).toBe((orig + '\r\n').split(/\r\n|\r|\n/).length);
    expect(err.column).toBeGreaterThan(0);
    expect(err.display).toMatch(/BOGUSOP|A\d+/);
    writeFileSync(src, orig, 'latin1');
    expect((await builds.make()).ok).toBe(true);
  });

  it('a build while building is busy; Remove Object Code removes objects and marks files touched', async () => {
    const p = builds.make({ force: true });
    await expect(builds.make()).rejects.toMatchObject({ code: 'busy' });
    await p;
    const removed = await builds.removeObjectCode();
    expect(removed.some((x) => x.endsWith('main.asm.o'))).toBe(true);
    expect((await svc.fullInfo()).files.find((f) => f.name === 'main.asm')?.touched).toBe(true);
    expect((await builds.bringUpToDate()).compiled).toEqual(['main.asm']);
  });

  it('every edit goes to the sidecar; the .mcp bytes never change', async () => {
    const order = [...svc.require().target('Standard').linkOrder];
    await svc.edit((p) => p.addGroup(['Docs']));
    await svc.edit((p) => p.setDebug('main.asm', false));
    await svc.edit((p) => p.setOption('Standard', 'assembler', '-WmsgSd1106'));
    await svc.edit((p) => p.setAccessPaths('Standard', { user: ['{Project}Sources', '{Project}extra'], system: ['{Compiler}lib/hc12c/include'] }));
    await svc.edit((p) => p.setLinkOrder('Standard', [...p.target('Standard').linkOrder].reverse()));
    const after = await svc.edit((p) => p.setDebuggerArgs('Standard', '-W -Prod=Full_Chip_Simulation.ini'));
    expect(after.groups.map((g) => g.name)).toContain('Docs');
    expect(after.targets[0].options.assembler).toBe('-WmsgSd1106');
    expect(after.files.find((f) => f.name === 'main.asm')?.debug).toBe(false);
    expect(readFileSync(mcpPath).equals(mcpBytes)).toBe(true);
    const side = JSON.parse(readFileSync(join(lab3.dir, 'Lab3.s12studio.json'), 'utf8'));
    expect(JSON.stringify(side)).toContain('-WmsgSd1106');
    // reopen: the sidecar edits are still there
    const re = await svc.reload();
    expect(re.targets[0].options.assembler).toBe('-WmsgSd1106');
    // back to the .mcp settings (null = remove the override)
    await svc.edit((p) => p.setOption('Standard', 'assembler', undefined));
    await svc.edit((p) => p.setAccessPaths('Standard', undefined));
    await svc.edit((p) => p.setLinkOrder('Standard', order));
    await svc.edit((p) => p.setDebuggerArgs('Standard', undefined));
    expect((await builds.make()).ok).toBe(true);
    expect(readFileSync(mcpPath).equals(mcpBytes)).toBe(true);
  });

  it('our own sidecar saves are not external changes; another program writing it is', async () => {
    events.length = 0;
    await svc.edit((p) => p.setDebug('main.asm', true));
    await new Promise((r) => setTimeout(r, 300));
    expect(of('project', 'externalChange')).toEqual([]);
    const sc = join(lab3.dir, 'Lab3.s12studio.json');
    writeFileSync(sc, readFileSync(sc, 'utf8').replace('"version"', '"version"'), 'utf8'); // same content: no event
    await new Promise((r) => setTimeout(r, 300));
    expect(of('project', 'externalChange')).toEqual([]);
    const j = JSON.parse(readFileSync(sc, 'utf8'));
    j.connection = 'Full_Chip_Simulation';
    writeFileSync(sc, JSON.stringify(j, null, 2), 'utf8');
    await waitFor(() => of('project', 'externalChange').length > 0);
    expect(of('project', 'externalChange')[0]).toEqual({ mcp: false, sidecar: true });
    const re = await svc.reload();
    expect(re.connection).toBe('Full_Chip_Simulation');
    expect(readFileSync(mcpPath).equals(mcpBytes)).toBe(true);
  });

  it('Project > Debug on the icd12 connection falls back to Full Chip Simulation and says so', async () => {
    await svc.edit((p) => p.setConnection('P&E_Multilink_USB'));
    const r = await resolveLaunch(svc, {});
    expect(r.iniPath).toBe(normPath(join(lab3.dir, 'Full_Chip_Simulation.ini')));
    expect(r.fallbackFrom).toMatchObject({ name: 'P&E_Multilink_USB', target: 'icd12' });
    await svc.edit((p) => p.setConnection('Full_Chip_Simulation'));
    expect((await resolveLaunch(svc, {})).fallbackFrom).toBeUndefined();
  });

  it('rebuild while debugging: applicationRebuilt goes out only for the loaded .abs', async () => {
    const r = (await builds.make({ force: true })) as BuildResultInfo;
    const host = (absPath?: string, running = true) => ({ running, call: async () => (absPath ? { absPath } : null) });
    events.length = 0;
    expect(await notifyRebuild(host(join(lab3.dir, 'bin', 'Project.abs')), bus, r)).toBe(true);
    expect(of('debug', 'applicationRebuilt')).toEqual([{ absPath: join(lab3.dir, 'bin', 'Project.abs'), target: 'Standard' }]);
    expect(await notifyRebuild(host('/elsewhere/Other.abs'), bus, r)).toBe(false);
    expect(await notifyRebuild(host(join(lab3.dir, 'bin', 'Project.abs'), false), bus, r)).toBe(false);
    expect(await notifyRebuild(host(join(lab3.dir, 'bin', 'Project.abs')), bus, { ...r, ok: false })).toBe(false);
  });

  it('BuildService.onFinished runs after a build', async () => {
    const seen: string[] = [];
    builds.onFinished = (i, k) => {
      seen.push(`${k}:${i.ok}`);
    };
    await builds.make();
    builds.onFinished = null;
    expect(seen).toEqual(['make:true']);
  });
});

describe('New Project', () => {
  itFx('finds the blank_project template (the private fixtures dir in a source checkout)', () => {
    expect(templatesDir).toBe(FIXTURES);
    expect(findTemplatesDir([join(work, 'none'), undefined])).toBeUndefined();
  });

  itFx('from blank_project: copies the tree, renames .mcp + _Data, opens it and it builds', async () => {
    const info = await svc.newProject({ template: 'blank_project', dir: work, name: 'MyLab' });
    expect(info.name).toBe('MyLab');
    expect(info.mcpPath).toBe(normPath(join(work, 'MyLab', 'MyLab.mcp')));
    expect(existsSync(join(work, 'MyLab', 'MyLab_Data'))).toBe(true);
    expect(existsSync(join(work, 'MyLab', 'bin', 'Project.abs'))).toBe(false); // template outputs not copied
    const r = await builds.make();
    expect(r.ok).toBe(true);
    expect(existsSync(join(work, 'MyLab', 'bin', 'Project.abs'))).toBe(true);
    // the template on disk is untouched
    expect(existsSync(join(FIXTURES, 'blank_project', 'MyLab.mcp'))).toBe(false);
  });

  it('from the generic template: a sidecar-only project that builds', async () => {
    const info = await svc.newProject({ template: 'minimal', dir: work, name: 'Generic' });
    expect(info.mcpPath).toBeUndefined();
    expect(info.sidecarPath).toBe(normPath(join(work, 'Generic', 'Generic.s12studio.json')));
    const r = await builds.make();
    expect(r.errors).toBe(0);
    expect(r.ok).toBe(true);
  });

  it('refuses a non-empty destination and bad names', async () => {
    await expect(svc.newProject({ template: 'minimal', dir: work, name: 'Generic' })).rejects.toThrow();
    await expect(svc.newProject({ template: 'minimal', dir: work, name: 'a/b' })).rejects.toThrow();
    await expect(svc.newProject({ template: 'minimal', dir: work, name: 'bad:name' })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(svc.newProject({ template: 'minimal', dir: work, name: 'Generic' })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('without a blank_project in the templates folder, blank_project is not-found (pointing to File > Open)', async () => {
    const bare = new ProjectService(new EventBus(), { compilerDir: join(work, 'cw') });
    await expect(bare.newProject({ template: 'blank_project', dir: work, name: 'X' })).rejects.toMatchObject({ code: 'not-found', message: expect.stringMatching(/File > Open/) });
  });
});
