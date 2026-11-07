import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { copyFixture, hasFixtures, describeFx } from '../../test/fixtures';
import type { BoardState } from '../shared/api/board';
import type { DebugSnapshot, DisasmLine, HaltInfoDTO, OutputLineInfo, SessionInfo } from '../shared/api/debug';
import { DebugEngine } from './engine';

// private fixture: the whole file is skipped without it
const lab3 = hasFixtures ? copyFixture('Lab3') : { dir: '/nonexistent/Lab3', dispose: () => undefined };
const events: { domain: string; event: string; payload: unknown }[] = [];
const engine = new DebugEngine((domain, event, payload) => events.push({ domain, event, payload }), { forcePacing: 'max' });
const last = <T,>(event: string): T | undefined => [...events].reverse().find((e) => e.event === event)?.payload as T | undefined;
const call = <T,>(m: string, ...a: unknown[]) => engine.call(m, a) as Promise<T>;

beforeAll(async () => {
  if (!hasFixtures) return;
  await engine.openSession({ iniPath: join(lab3.dir, 'Full_Chip_Simulation.ini'), projectDir: lab3.dir, absPath: join(lab3.dir, 'bin', 'Project.abs') });
}, 60000);
afterAll(async () => {
  await engine.dispose();
  lab3.dispose();
});

describeFx('DebugEngine (worker side) on Lab3', () => {
  it('opens the FCS session, loads Project.abs and stops at Entry $C000', async () => {
    const s = (await call<SessionInfo>('debug.session'))!;
    expect(s.connection).toBe('sim');
    expect(s.title).toBe(`S12 Studio Debugger  ${join(lab3.dir, 'Full_Chip_Simulation.ini')}`);
    expect(s.layoutPath).toBe(join(lab3.dir, 'ASM_layout.hwl'));
    expect(s.absPath).toBe(join(lab3.dir, 'bin', 'Project.abs'));
    const snap = await call<DebugSnapshot>('debug.snapshot');
    expect(snap.state).toBe('halted');
    expect(snap.registers?.PC).toBe(0xc000);
    expect(last<SessionInfo>('session')?.connection).toBe('sim');
  });

  it('steps one instruction: halted event + snapshot with the new PC', async () => {
    events.length = 0;
    const h = await call<HaltInfoDTO>('debug.step', 'instr');
    expect(h.reason).toBe('step');
    expect(h.pc).not.toBe(0xc000);
    expect(last<{ info: HaltInfoDTO }>('halted')?.info.pc).toBe(h.pc);
    const snap = last<DebugSnapshot>('snapshot')!;
    expect(snap.registers?.PC).toBe(h.pc);
    expect(snap.statusText).toBe('TRACED');
  });

  it('includes watched memory in snapshots', async () => {
    await call('debug.watchMemory', 'w1', [{ address: 0xc000, length: 4 }]);
    const snap = last<DebugSnapshot>('snapshot')!;
    expect([...snap.memory.w1[0].bytes]).toHaveLength(4);
    expect(snap.memory.w1[0].bytes[0]).toBe(0xcf); // LDS #
    await call('debug.unwatchMemory', 'w1');
  });

  it('disassembles with labels', async () => {
    const lines = await call<DisasmLine[]>('debug.disassemble', { address: 0xc000, count: 3 });
    expect(lines[0]).toMatchObject({ address: 0xc000, mnemonic: 'LDS' });
    expect(lines).toHaveLength(3);
  });

  it('runs commands with batched output events', async () => {
    events.length = 0;
    expect(await call<boolean>('debug.exec', 'rd PC')).toBe(true);
    const out = events.filter((e) => e.event === 'output').flatMap((e) => e.payload as OutputLineInfo[]);
    expect(out.some((l) => /PC/.test(l.text))).toBe(true);
  });

  it('reports the ME305 board', async () => {
    const b = await call<BoardState>('board.state');
    expect(b.present).toBe(true);
    expect(b.lcd?.lines).toHaveLength(2);
    expect(b.leds.map((l) => l.pin)).toEqual(expect.arrayContaining(['PP4', 'PP5', 'PP6', 'PP7']));
    const keys = await call<{ label: string }[]>('board.keys');
    expect(keys.map((k) => k.label)).toContain('F1');
  });

  it('unknown methods are not-implemented errors', async () => {
    await expect(call('debug.nope')).rejects.toMatchObject({ code: 'not-implemented' });
  });
});
