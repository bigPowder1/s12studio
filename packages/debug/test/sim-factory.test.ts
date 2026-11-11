/**
 * sim-factory.ts: the MCU system factory behind the debugger's Full Chip Simulation. The Lab3 acceptance run through
 * SimTarget + the full MC9S12XDP512/ME3305 model is private (s12studio-fixtures: tests/debug/integration-lab3.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { mcuSystemFactory, runForSeconds } from '../src/sim-factory';
import { SimTarget } from '../src/sim-target';
import { itFx } from './helpers';
import { fixture } from '../../formats/test/fixtures';

describe('mcuSystemFactory', () => {
  it('builds a fresh MCU per createSystem() and disposes the previous one', () => {
    const f = mcuSystemFactory({ board: 'none' });
    expect(f.mcu).toBeNull();
    const a = f.createSystem();
    const ma = f.mcu!;
    expect(ma.system).toBe(a);
    const b = f.createSystem();
    expect(b).not.toBe(a);
    expect(f.mcu!.system).toBe(b);
    expect(f.mcu!.board).toBeNull();
  });

  itFx('a SimTarget built on it runs the blank project to its spin loop', async () => {
    const f = mcuSystemFactory();
    const t = new SimTarget({ createSystem: f.createSystem });
    const { readFileSync } = await import('node:fs');
    const blank = new Uint8Array(readFileSync(fixture('blank_project', 'bin', 'Project.abs')));
    await t.load({ kind: 'abs', data: blank });
    const h = await runForSeconds(t, f.mcu!, 0.05);
    expect(h.reason).toBe('halt');
    expect(h.pc).toBe(0x4000);
    expect(t.busHz).toBe(10_000_000);
    await t.dispose();
  });
});
