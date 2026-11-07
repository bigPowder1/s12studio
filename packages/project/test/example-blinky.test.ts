/**
 * The public demo project examples/blinky (our own code, no private fixtures): Make it with the project engine, then
 * run it on the full MC9S12XDP512 + ME305 board model. LEDs step at the default 500 ms, the LCD shows the message,
 * and key '2' changes the step to 200 ms.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createMc9s12xdp512, type Mc9s12xdp512 } from '@s12/sim';
import { MemoryFs, installCompilerRoot, make, openProject } from '../src/index';
import { REPO } from '../../formats/test/fixtures';

const EXAMPLE = join(REPO, 'examples', 'blinky');
const DEST = '/work/blinky';

/** Copy examples/blinky into an in-memory fs. */
function loadExample(fs: MemoryFs): void {
  const rec = (rel: string) => {
    for (const n of readdirSync(join(EXAMPLE, rel))) {
      const r = rel ? `${rel}/${n}` : n;
      if (statSync(join(EXAMPLE, r)).isDirectory()) rec(r);
      else fs.writeSync(`${DEST}/${r}`, new Uint8Array(readFileSync(join(EXAMPLE, r))));
    }
  };
  rec('');
}

/** The program's own LCD texts, read from its source (DC.B strings). */
function asmStrings(): Record<string, string> {
  const src = readFileSync(join(EXAMPLE, 'Sources', 'main.asm'), 'latin1');
  return Object.fromEntries([...src.matchAll(/^(\w+):\s+DC\.B\s+'([^']*)'/gm)].map((m) => [m[1], m[2]]));
}

describe('examples/blinky (public demo project)', () => {
  let fs: MemoryFs;
  let abs: Uint8Array;
  let m: Mc9s12xdp512;
  const lines = () => m.board!.lcd.lines.map((l) => l.trimEnd());
  /** Times (s) of PP4 edges after `from` seconds. */
  const pp4Edges = (from: number) => m.board!.leds.edges().filter((e) => e.pin === 'PP4' && e.seconds > from).map((e) => e.seconds);
  const msgs = asmStrings();

  beforeAll(async () => {
    fs = new MemoryFs();
    loadExample(fs);
    await installCompilerRoot(fs, '/cw');
  });

  it('is a standalone sidecar project (no .mcp) with our Apache-2.0 header', async () => {
    const files = readdirSync(EXAMPLE);
    expect(files.filter((f) => /\.mcp$/i.test(f))).toEqual([]);
    expect(files).toContain('blinky.s12studio.json');
    expect(readFileSync(join(EXAMPLE, 'Sources', 'main.asm'), 'latin1')).toMatch(/S12 Studio example -+ Apache-2\.0/);
  });

  it('Make: 0 errors, 0 warnings, writes Project.abs and the S19', async () => {
    const proj = await openProject(fs, `${DEST}/blinky.s12studio.json`, { compilerDir: '/cw' });
    expect(proj.mcpPath).toBeUndefined();
    const r = await make(proj, { user: 'student', stamp: () => 'Thu Nov 05 12:00:00 2026' });
    expect(r.messages.map((x) => x.display)).toEqual([]);
    expect(r.ok).toBe(true);
    abs = fs.readSync(`${DEST}/bin/Project.abs`)!;
    expect(abs.length).toBeGreaterThan(0);
    expect(fs.readSync(`${DEST}/bin/Project.abs.s19`)).toBeDefined();
  });

  it('runs on the full MCU model: PLL to 10 MHz, LCD message on both lines', () => {
    m = createMc9s12xdp512({ board: 'me305', ramInit: 'zero' });
    const { symbols } = m.loadAbs(abs);
    expect(m.system.registers.pc).toBe(symbols.get('Entry'));
    expect(m.runSeconds(0.2)).toBe('limit');
    expect(m.system.busHz).toBe(10_000_000);
    expect(lines()).toEqual([msgs.msg1, msgs.msg2]);
    expect(m.board!.lcd.view().displayOn).toBe(true);
  });

  it('LEDs: PP4+PP6 and PP5+PP7 alternate every 500 ms (RATE 5)', () => {
    const t0 = m.system.simTimeSeconds;
    expect(m.runSeconds(2.6)).toBe('limit');
    const e = pp4Edges(t0);
    expect(e.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < e.length; i++) expect((e[i] - e[i - 1]) * 1e3).toBeCloseTo(500, 0);
    // the pairs are always opposite
    const pins = m.board!.leds.edges().filter((x) => x.seconds > t0);
    const last = (pin: string) => pins.filter((x) => x.pin === pin).at(-1)!.on;
    expect(last('PP4')).toBe(last('PP6'));
    expect(last('PP5')).toBe(last('PP7'));
    expect(last('PP4')).toBe(!last('PP5'));
  });

  it("key '2' sets 200 ms steps and shows the new rate on the LCD", () => {
    m.board!.keypad.tap('2', 0.08);
    expect(m.runSeconds(0.6)).toBe('limit'); // the step already counting finishes at the old rate
    expect(lines()[1]).toBe(msgs.msg2.replace('500', '200'));
    const t0 = m.system.simTimeSeconds;
    expect(m.runSeconds(1.5)).toBe('limit');
    const e = pp4Edges(t0);
    expect(e.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < e.length; i++) expect((e[i] - e[i - 1]) * 1e3).toBeCloseTo(200, 0);
  });

  it("key '0' and function keys are ignored", () => {
    for (const k of ['0', 'F1', 'ENT']) {
      m.board!.keypad.tap(k, 0.05);
      expect(m.runSeconds(0.1)).toBe('limit');
    }
    expect(lines()[1]).toBe(msgs.msg2.replace('500', '200'));
  });
});
