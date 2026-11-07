import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readElf } from '@s12/formats';
import { copyExample, copyFixture, hasFixtures, describeFx } from '../../../test/fixtures';
import { EventBus } from '../events';
import { BuildService } from './build-service';
import { resolveLaunch } from './debug-launch';
import { ProjectService } from './project-service';

const lab3 = hasFixtures ? copyFixture('Lab3') : { dir: '/nonexistent/Lab3', dispose: () => undefined };
const blinky = copyExample('blinky');
const cwDir = mkdtempSync(join(tmpdir(), 's12ide-cw-'));
afterAll(() => {
  lab3.dispose();
  blinky.dispose();
  rmSync(cwDir, { recursive: true, force: true });
});

describeFx('ProjectService (Lab3 copy)', () => {
  const bus = new EventBus();
  const events: string[] = [];
  bus.attach((d, e) => events.push(`${d}.${e}`));
  const svc = new ProjectService(bus, { compilerDir: join(cwDir, 'cw'), ensureCompilerRoot: true });

  it('opens the .mcp and emits project.changed with the file tree', async () => {
    const info = await svc.open(join(lab3.dir, 'Lab3.mcp'));
    expect(info.name).toBe('Lab3');
    expect(info.currentTarget).toBe('Standard');
    expect(info.files.map((f) => f.name)).toContain('main.asm');
    expect(info.groups.map((g) => g.name)).toEqual(['Sources', 'Includes', 'Libraries', 'Project Settings']);
    expect(info.connections.map((c) => c.name)).toContain('Full_Chip_Simulation');
    expect(info.targets[0].absPath).toBe(join(lab3.dir, 'bin/Project.abs'));
    expect(events).toContain('project.changed');
    // final fidelity F5: CodeWarrior's own outputs are current, so main.asm is not marked and shows its sizes
    const main = info.files.find((f) => f.name === 'main.asm')!;
    expect(main.touched).toBe(false);
    // sizes of CodeWarrior's main.asm.o (allocated PROGBITS = Code, NOBITS = Data), read rather than repeated here
    const o = readElf(new Uint8Array(readFileSync(join(lab3.dir, 'Lab3_Data/Standard/ObjectCode/main.asm.o'))));
    const size = (nobits: boolean) => o.sections.filter((x) => x.flags & 2 && (x.type === 8) === nobits).reduce((n, x) => n + x.size, 0);
    expect([main.code, main.data]).toEqual([size(false), size(true)]);
  });

  it('Project > Debug uses the Full Chip Simulation connection for the icd12 .mcp setting (UNCERTAIN fallback)', async () => {
    const r = await resolveLaunch(svc, {});
    expect(r.iniPath).toBe(join(lab3.dir, 'Full_Chip_Simulation.ini'));
    expect(r.absPath).toBe(join(lab3.dir, 'bin/Project.abs'));
    expect(r.projectDir).toBe(lab3.dir);
    expect(r.load).toBe(true);
  });

  it('edits go to the sidecar and re-emit', async () => {
    events.length = 0;
    const info = await svc.edit((p) => p.setDebug('main.asm', false));
    expect(info.files.find((f) => f.name === 'main.asm')?.debug).toBe(false);
    expect(events).toEqual(['project.changed']);
    await expect(svc.edit((p) => p.removeFile('nope.asm'))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('close emits project.closed and require() fails', async () => {
    await svc.close();
    expect(events).toContain('project.closed');
    expect(() => svc.require()).toThrow(/no project/);
  });
});

// public: the same main-process flow on a temp copy of examples/blinky (standalone sidecar project, no fixtures)
describe('ProjectService + BuildService (examples/blinky copy, public)', () => {
  const bus = new EventBus();
  const events: string[] = [];
  bus.attach((d, e) => events.push(`${d}.${e}`));
  const svc = new ProjectService(bus, { compilerDir: join(cwDir, 'cw-blinky'), ensureCompilerRoot: true });
  const builds = new BuildService(bus, svc);
  const sidecar = join(blinky.dir, 'blinky.s12studio.json');
  const mainAsm = join(blinky.dir, 'Sources', 'main.asm');

  it('opens the sidecar project (no .mcp): file tree, target, Full Chip Simulation connection', async () => {
    const info = await svc.open(sidecar);
    expect(info.name).toBe('blinky');
    expect(info.mcpPath ?? null).toBeNull();
    expect(info.sidecarPath).toBe(sidecar);
    expect(info.files.map((f) => f.name)).toContain('main.asm');
    expect(info.targets.length).toBeGreaterThan(0);
    expect(info.connections.map((c) => c.name)).toContain('Full_Chip_Simulation');
    expect(events).toContain('project.changed');
  });

  it('Make: 0 errors, outputs in bin/; a second Make is up to date', async () => {
    const r = await builds.make({ force: true });
    expect(r.messages.filter((m) => m.severity === 'error')).toEqual([]);
    expect(r).toMatchObject({ ok: true, errors: 0, linked: true });
    expect(r.compiled).toContain('main.asm');
    expect(existsSync(r.absPath!)).toBe(true);
    expect(r.absPath!.startsWith(join(blinky.dir, 'bin'))).toBe(true);
    expect((await builds.make()).upToDate).toBe(true);
  });

  it('an edit with an error is reported with file and line; fixing it rebuilds only main.asm', async () => {
    const good = readFileSync(mainAsm, 'latin1');
    writeFileSync(mainAsm, good + '\r\n            BOGUS   #1\r\n', 'latin1');
    await svc.refreshStatus();
    const bad = await builds.make();
    expect(bad.ok).toBe(false);
    expect(bad.errors).toBeGreaterThan(0);
    const err = bad.messages.find((m) => m.severity === 'error')!;
    expect(err.file).toBe(mainAsm);
    expect(err.line).toBe(good.split(/\r?\n/).length + 1);
    writeFileSync(mainAsm, good, 'latin1');
    await svc.refreshStatus();
    const fixed = await builds.make();
    expect(fixed).toMatchObject({ ok: true, errors: 0, compiled: ['main.asm'], linked: true });
  });

  it('Project > Debug resolves the Full Chip Simulation .ini and the built application', async () => {
    const r = await resolveLaunch(svc, {});
    expect(r.iniPath).toBe(join(blinky.dir, 'Full_Chip_Simulation.ini'));
    expect(r.absPath).toBe(builds.lastResult()!.absPath);
    expect(r.projectDir).toBe(blinky.dir);
  });

  it('close emits project.closed', async () => {
    await svc.close();
    expect(events).toContain('project.closed');
    expect(() => svc.require()).toThrow(/no project/);
  });
});
