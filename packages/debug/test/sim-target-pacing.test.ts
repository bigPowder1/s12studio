/** SimTarget pacing changes while running (IDE: Run > pacing toggle, settings change during a run). */
import { describe, expect, it } from 'vitest';
import { S12XSystem } from '@s12/sim';
import { SimTarget } from '../src/sim-target';

describe('SimTarget pacing changes while running', () => {
  it("switching from 'max' to 'true-time' mid-run re-anchors pacing (no stall while wall time catches up)", async () => {
    let wall = 0;
    let slept = 0;
    const t = new SimTarget({
      createSystem: () => new S12XSystem({ ramInit: 'zero' }),
      pacing: 'max',
      sliceCycles: 400_000, // 50 ms of 8 MHz bus per slice
      now: () => wall,
      sleep: async (ms) => {
        slept += ms;
        wall += ms;
        await new Promise((r) => setImmediate(r));
      },
      yieldNow: () =>
        new Promise((r) => {
          wall += 1; // max pacing: 1 ms of wall time per 50 ms slice
          setImmediate(r);
        }),
    });
    await t.writeMemory(0x2300, [0x20, 0xfe]); // BRA *
    await t.writeRegister('PC', 0x2300);
    await t.go();
    while (wall < 20) await new Promise((r) => setTimeout(r, 1));
    const simAtSwitch = t.system.simTimeSeconds;
    expect(simAtSwitch).toBeGreaterThan(0.5); // far ahead of the 20 ms wall clock
    t.pacing = 'true-time';
    expect(t.speedFactor).toBe(1);
    const wallAtSwitch = wall;
    while (wall < wallAtSwitch + 100) await new Promise((r) => setTimeout(r, 1));
    await t.halt();
    // the old anchor would have slept ~simAtSwitch seconds before running again; now it keeps simulating
    const progressed = (t.system.simTimeSeconds - simAtSwitch) * 1000;
    expect(progressed).toBeGreaterThan(50);
    expect(progressed).toBeLessThan(200);
    expect(slept).toBeLessThan(200);
  });
});
