/**
 * Project > Debug connection fallbacks on a temp copy of the public examples/blinky:
 *  - the selected connection .ini is missing -> Full_Chip_Simulation.ini of the project plus one informational line;
 *  - missing and no Full Chip Simulation .ini -> a clear not-found error;
 *  - a hardware connection (Target=icd12) -> Full Chip Simulation with `fallbackFrom` (the engine shows the notice).
 * And the worker side: the hardware notice is calm (no "warning") and shown once per project per app run.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyExample } from '../../../test/fixtures';
import type { OutputLineInfo } from '../../shared/api/debug';
import { DebugEngine, hardwareFallbackMessage } from '../../worker/engine';
import { EventBus } from '../events';
import { resolveLaunch } from './debug-launch';
import { ProjectService } from './project-service';

const PE_INI = '[HI-WAVE]\r\nTarget=icd12\r\nLayout=ASM_layout.hwl\r\n';

const cwDir = mkdtempSync(join(tmpdir(), 's12ide-cw-'));
const copies: { dispose: () => void }[] = [];
afterAll(() => {
  for (const c of copies) c.dispose();
  rmSync(cwDir, { recursive: true, force: true });
});

/** blinky copy opened in a ProjectService, with P&E_Multilink_USB.ini added and selected as the connection. */
async function blinkyOnPe(): Promise<{ dir: string; svc: ProjectService }> {
  const copy = copyExample('blinky');
  copies.push(copy);
  writeFileSync(join(copy.dir, 'P&E_Multilink_USB.ini'), PE_INI, 'latin1');
  const svc = new ProjectService(new EventBus(), { compilerDir: join(cwDir, 'cw'), ensureCompilerRoot: true });
  await svc.open(join(copy.dir, 'blinky.s12studio.json'));
  await svc.edit((p) => p.setConnection('P&E_Multilink_USB'));
  return { dir: copy.dir, svc };
}

describe('resolveLaunch connection fallbacks', () => {
  it('a hardware connection is debugged on Full_Chip_Simulation.ini (fallbackFrom set, no extra note)', async () => {
    const { dir, svc } = await blinkyOnPe();
    const r = await resolveLaunch(svc, {});
    expect(r.iniPath).toBe(join(dir, 'Full_Chip_Simulation.ini'));
    expect(r.fallbackFrom).toMatchObject({ name: 'P&E_Multilink_USB', target: 'icd12' });
    expect(r.notes).toBeUndefined();
  });

  it("the .mcp's connection .ini is missing: Full_Chip_Simulation.ini with one informational line", async () => {
    const { dir, svc } = await blinkyOnPe();
    unlinkSync(join(dir, 'P&E_Multilink_USB.ini'));
    const r = await resolveLaunch(svc, {});
    expect(r.iniPath).toBe(join(dir, 'Full_Chip_Simulation.ini'));
    expect(r.fallbackFrom).toBeUndefined();
    expect(r.notes).toEqual(["Note: the project's connection file P&E_Multilink_USB.ini was not found, so S12 Studio uses Full_Chip_Simulation.ini."]);
    expect(r.projectDir).toBe(dir);
  });

  it('missing and no Full Chip Simulation .ini: a clear not-found error', async () => {
    const { dir, svc } = await blinkyOnPe();
    unlinkSync(join(dir, 'P&E_Multilink_USB.ini'));
    unlinkSync(join(dir, 'Full_Chip_Simulation.ini'));
    await expect(resolveLaunch(svc, {})).rejects.toMatchObject({ code: 'not-found', message: expect.stringContaining('P&E_Multilink_USB.ini is missing') });
  });
});

describe('DebugEngine hardware-fallback notice', () => {
  it('is information (not a warning), shown once per project per app run; notes are printed every time', async () => {
    const a = copyExample('blinky');
    const b = copyExample('blinky');
    copies.push(a, b);
    const events: { event: string; payload: unknown }[] = [];
    const engine = new DebugEngine((_d, event, payload) => events.push({ event, payload }), { forcePacing: 'max' });
    const open = (dir: string, notes?: string[]) =>
      engine.openSession({
        iniPath: join(dir, 'Full_Chip_Simulation.ini'),
        projectDir: dir,
        load: false,
        fallbackFrom: { name: 'P&E_Multilink_USB', target: 'icd12', iniPath: join(dir, 'P&E_Multilink_USB.ini') },
        notes,
      });
    const message = hardwareFallbackMessage('P&E_Multilink_USB');
    const notices = () => events.filter((e) => e.event === 'notice').map((e) => e.payload);
    const lines = () => events.filter((e) => e.event === 'output').flatMap((e) => e.payload as OutputLineInfo[]);
    const settle = () => new Promise((r) => setTimeout(r, 50)); // command-window output is batched (15 ms)
    try {
      expect(message).toBe("Note: this project's connection is P&E Multilink USB (real board). S12 Studio runs it in Full Chip Simulation.");
      const s1 = await open(a.dir);
      await settle();
      expect(s1.fallbackFrom).toMatchObject({ name: 'P&E_Multilink_USB', target: 'icd12' });
      expect(notices()).toEqual([{ kind: 'hardware-fallback', message }]);
      expect(lines().filter((l) => l.text === message).map((l) => l.kind)).toEqual(['normal']);
      expect(lines().some((l) => /not yet supported|^warning/i.test(l.text))).toBe(false);

      // Debug again on the same project: no second notice, but the session still says what it runs on
      const s2 = await open(a.dir, ['Note: something informational.']);
      await settle();
      expect(s2.fallbackFrom).toMatchObject({ name: 'P&E_Multilink_USB' });
      expect(notices()).toHaveLength(1);
      expect(lines().filter((l) => l.text === message)).toHaveLength(1);
      expect(lines().filter((l) => l.text === 'Note: something informational.').map((l) => l.kind)).toEqual(['normal']);

      // another project gets its own notice
      await open(b.dir);
      expect(notices()).toHaveLength(2);
    } finally {
      await engine.dispose();
    }
  }, 30_000);
});
