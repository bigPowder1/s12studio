import { describe, expect, it } from 'vitest';
import { S12XSystem } from '@s12/sim';
import { SimTarget } from '@s12/debug';

// The SimTarget tests on the golden Lab3 build are private (s12studio-fixtures: tests/debug/sim-target-lab3.test.ts).
describe('SimTarget (synthetic programs)', () => {
  it('conditional and counting breakpoints (synthetic loop in RAM)', async () => {
    const t = new SimTarget({ createSystem: () => new S12XSystem({ ramInit: 'zero' }) });
    // 2300: CLRA ; 2301: INCA ; 2302: STAA $2500 ; 2305: BRA 2301
    await t.writeMemory(0x2300, [0x87, 0x42, 0x7a, 0x25, 0x00, 0x20, 0xfa]);
    await t.writeRegister('PC', 0x2300);
    await t.writeRegister('SP', 0x2f00);
    const bp = await t.addBreakpoint({ address: 0x2302, condition: '$A == 5' });
    await t.go();
    let h = await t.waitForHalt(5000);
    expect(h.reason).toBe('breakpoint');
    expect((await t.readRegisters()).A).toBe(5);
    expect(h.breakpoint?.hits).toBe(5);
    // counting: halts every 3rd hit, counter reloads
    await t.updateBreakpoint(bp.id, { condition: undefined, counter: { current: 3, interval: 3 } });
    await t.go();
    h = await t.waitForHalt(5000);
    expect((await t.readRegisters()).A).toBe(8);
    await t.go();
    h = await t.waitForHalt(5000);
    expect((await t.readRegisters()).A).toBe(11);
    expect(t.breakpoints()[0].counter).toEqual({ current: 3, interval: 3 });
    // a condition referring to memory
    await t.updateBreakpoint(bp.id, { counter: undefined, condition: '[0x2500] == 0x20' });
    await t.go();
    h = await t.waitForHalt(5000);
    expect((await t.readRegisters()).A).toBe(0x21);
    // a bad condition stops with a message
    await t.updateBreakpoint(bp.id, { condition: 'nosuchsym == 1' });
    await t.go();
    h = await t.waitForHalt(5000);
    expect(h.message).toMatch(/Incorrect Condition/);
    // disabled breakpoints are ignored; halt stops a free run
    await t.updateBreakpoint(bp.id, { enabled: false });
    await t.go();
    h = await t.halt();
    expect(h.reason).toBe('halt');
  });

  it('true-time pacing keeps simulated time near wall time', async () => {
    let wall = 0;
    const t = new SimTarget({
      createSystem: () => new S12XSystem({ ramInit: 'zero' }),
      pacing: 'true-time',
      now: () => wall,
      sleep: async (ms) => {
        wall += ms;
        await new Promise((r) => setImmediate(r));
      },
      yieldNow: () => new Promise((r) => setImmediate(r)),
    });
    await t.writeMemory(0x2300, [0x20, 0xfe]); // BRA *
    await t.writeRegister('PC', 0x2300);
    await t.go();
    while (wall < 200) await new Promise((r) => setTimeout(r, 1));
    await t.halt();
    const simMs = (t.cycles / t.busHz) * 1000;
    expect(simMs).toBeGreaterThan(150);
    expect(simMs).toBeLessThan(300);
  });

});
