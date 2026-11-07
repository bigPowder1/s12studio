/**
 * Interpreter throughput. Skipped by default; run with
 *   SIM_BENCH=1 npx vitest run packages/sim/test/bench.test.ts
 */
import { describe, expect, it } from 'vitest';
import { fixture, itFx } from '../../formats/test/fixtures';
import { readFileSync } from 'node:fs';
import { S12XSystem } from '@s12/sim';
import { addLab3Fakes } from './fakes';
import { CODE, mk, put } from './helpers';

const bench = process.env.SIM_BENCH ? describe : describe.skip;

function measure(s: S12XSystem, cyclesPerIter: number, insnsPerIter: number, seconds = 1.5): number {
  s.run(2_000_000); // warm-up (JIT)
  const slice = 5_000_000;
  let cycles = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < seconds * 1000) {
    const c0 = s.cycles;
    s.run(slice);
    cycles += s.cycles - c0;
  }
  const dt = (performance.now() - t0) / 1000;
  return (cycles / cyclesPerIter) * insnsPerIter / dt / 1e6;
}

bench('throughput (MIPS)', () => {
  it('tight loop: LDAA 0,X ; ADDA #1 ; STAA 0,X ; DBNE Y,loop (; BRA loop every 65536)', () => {
    const s = mk();
    put(s, CODE, [0xa6, 0x00, 0x8b, 0x01, 0x6a, 0x00, 0x04, 0x36, 0xf7, 0x20, 0xf5]);
    s.setRegisters({ x: 0x2100, y: 0 });
    const mips = measure(s, 3 + 1 + 2 + 3, 4);
    console.log(`tight loop: ${mips.toFixed(1)} MIPS`);
    expect(mips).toBeGreaterThan(1);
  });
  it('mixed loop: LDD ext ; ADDD #imm ; STD ext ; LDX 2,Y+ ; CPX #0 ; BNE ; MOVB ; JSR/RTS ; BRA', () => {
    const s = mk();
    // loop: LDD $2100 ; ADDD #3 ; STD $2100 ; LDX 2,Y+ ; CPX #0 ; BNE +0 ; MOVB #1,$2102 ; JSR sub ; LDY #$2200 ; BRA loop
    // sub: INX ; RTS
    const loop = [
      0xfc, 0x21, 0x00, 0xc3, 0x00, 0x03, 0x7c, 0x21, 0x00, 0xed, 0x71, 0x8e, 0x00, 0x00, 0x26, 0x00, 0x18, 0x0b,
      0x01, 0x21, 0x02, 0x16, 0x40, 0x40, 0xcd, 0x22, 0x00,
    ];
    put(s, CODE, [...loop, 0x20, 0x100 - (loop.length + 2)]);
    put(s, 0x4040, [0x08, 0x3d]);
    s.setRegisters({ y: 0x2200 });
    // cycles: LDD 3, ADDD 2, STD 3, LDX 3, CPX 2, BNE(nt) 1, MOVB 4, JSR 4, INX 1, RTS 5, LDY 2, BRA 3 = 33 / 12 insns
    const mips = measure(s, 33, 12);
    console.log(`mixed loop: ${mips.toFixed(1)} MIPS`);
    expect(mips).toBeGreaterThan(1);
  });
  itFx('Lab3 main loop with fake peripherals (register-polling heavy)', () => {
    const abs = new Uint8Array(readFileSync(fixture('Lab3', 'bin', 'Project.abs')));
    const s = new S12XSystem();
    s.loadAbs(abs);
    addLab3Fakes(s);
    s.reset();
    s.run(40_000_000); // past INITLCD
    const t0 = performance.now();
    const c0 = s.cycles;
    s.run(50_000_000);
    const dt = (performance.now() - t0) / 1000;
    const mcps = (s.cycles - c0) / dt / 1e6;
    console.log(`Lab3: ${mcps.toFixed(1)} M bus cycles/s (${((mcps * 1e6) / s.busHz).toFixed(1)}x real time at ${s.busHz / 1e6} MHz)`);
    expect(mcps).toBeGreaterThan(1);
  });
});
