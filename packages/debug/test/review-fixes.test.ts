/**
 * Regression tests for the adversarial review of @s12/debug (findings 1-12; findings 1, 3/11 and 9 name Lab3 symbols
 * and are private: s12studio-fixtures tests/debug/review-fixes-lab3.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { decode } from '@s12/isa';
import { S12XSystem } from '@s12/sim';
import { callAt, CommandInterpreter, MemoryFileSystem, SimTarget, joinPath, dirName, type CommandHost } from '@s12/debug';
import { collect, lab3Target, describeFx } from './helpers';

async function interp(extra: Partial<CommandHost> = {}) {
  const { t, syms } = await lab3Target();
  const host: CommandHost = { target: t, symbols: syms, fs: new MemoryFileSystem(), baseDir: '/p', ...extra };
  const c = new CommandInterpreter(host, { waitScale: 0 });
  const out = collect();
  c.onOutput(out.push);
  t.setDebugInfo({ lookup: (n) => c.lookupIdent(n), lineAt: (a) => syms.lineAt(a) });
  return { t, c, out };
}

/**
 * RAM program: LDS #$3F00; CLI; NOP; loop: NOP; BRA loop. IRQ ($FFF2) -> $2100: BSET 1,SP,#$10; RTI (returns
 * with I set, so the level-asserted request is taken once).
 */
async function irqTarget() {
  const t = new SimTarget();
  await t.writeMemory(0x2000, [0xcf, 0x3f, 0x00, 0x10, 0xef, 0xa7, 0xa7, 0x20, 0xfd]);
  await t.writeMemory(0x2100, [0x0c, 0x81, 0x10, 0x0b]);
  await t.writeMemory(0xfff2, [0x21, 0x00]);
  await t.writeRegister('PC', 0x2000);
  for (let i = 0; i < 3; i++) await t.step('instr');
  expect((await t.readRegisters()).PC).toBe(0x2006);
  return t;
}

describe('finding 2: interrupt entry during instruction stepping', () => {
  it('S12XSystem.step({stopAfterException}) stops at the vector target; plain step() is unchanged', () => {
    const mk = () => {
      const s = new S12XSystem();
      for (const [a, v] of [[0x2000, 0xa7], [0x2001, 0xa7], [0x2100, 0xa7], [0x2101, 0xa7], [0xfff2, 0x21], [0xfff3, 0x00]] as const) s.poke(a, v);
      s.setRegisters({ pc: 0x2000, sp: 0x3f00, ccr: 0 });
      s.requestInterrupt(0xf2);
      return s;
    };
    const a = mk();
    expect(a.step()).toBe('step');
    expect(a.registers.pc).toBe(0x2101); // entry + first ISR instruction
    const b = mk();
    expect(b.step({ stopAfterException: true })).toBe('step');
    expect(b.registers.pc).toBe(0x2100);
    expect(b.registers.sp).toBe(0x3f00 - 10);
    expect(b.step({ stopAfterException: true })).toBe('step'); // I is set now: the ISR's first instruction
    expect(b.registers.pc).toBe(0x2101);
  });

  it("step('instr') with an IRQ pending lands on the ISR entry", async () => {
    const t = await irqTarget();
    t.system.requestInterrupt(0xf2);
    const h = await t.step('instr');
    expect(h.reason).toBe('step');
    expect(h.pc).toBe(0x2100);
    expect((await t.readRegisters()).SP).toBe(0x3f00 - 10);
  });

  it("step('out') stops at a breakpoint on the ISR entry", async () => {
    const t = await irqTarget();
    await t.addBreakpoint({ address: 0x2100 });
    t.system.requestInterrupt(0xf2);
    const h = await t.step('out');
    expect(h.reason).toBe('breakpoint');
    expect(h.pc).toBe(0x2100);
    expect(t.breakpoints()[0].hits).toBe(1);
  });

  it('source step into code with source stops at the ISR entry line', async () => {
    const t = await irqTarget();
    // fake line table: every RAM byte is its own line with source
    t.setDebugInfo({ lineAt: (a) => ({ address: a, endAddress: a + 1, file: 'x.dbg', line: a, module: 'x.dbg' }), hasSource: () => true });
    t.system.requestInterrupt(0xf2);
    const h = await t.step('srcLine');
    expect(h.pc).toBe(0x2100);
  });
});

describe('finding 4: call detection pre-filter', () => {
  it('callAt agrees with the full decoder for every opcode', () => {
    for (let op = 0; op < 256; op++)
      for (const b1 of [0x00, 0x30, 0x40, 0x80, 0xff]) {
        const bytes = [op, b1, 0x12, 0x34, 0x56];
        const read = (a: number) => bytes[a - 0x4000] ?? 0;
        const full = ['JSR', 'BSR', 'CALL', 'SWI', 'TRAP'].includes(decode(read, 0x4000).mnemonic);
        expect(!!callAt(read, 0x4000), `opcode ${op.toString(16)} ${b1.toString(16)}`).toBe(full);
      }
  });
});

describeFx('finding 5: control-point tables are rebuilt only when they change', () => {
  it('T ,200 does not rebuild the breakpoint table per step', async () => {
    const { t, c } = await interp();
    await t.addBreakpoint({ address: 0x4500 });
    const spy = vi.spyOn(t.system, 'clearBreakpoints');
    await c.execute('T ,200', { echo: false });
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    await t.addBreakpoint({ address: 0x4502 });
    await t.step('instr');
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describeFx('finding 6: unmatched command-file blocks are errors', () => {
  it('IF without ENDIF does not run its body; stray closers and ELSE are reported', async () => {
    const { c, out } = await interp();
    let r = await c.executeScript('IF 0\nPRINTF("BODY")\n', { name: 'a.cmd' });
    expect(r.ok).toBe(false);
    expect(out.texts()).toEqual(['a.cmd(1): IF without ENDIF']);
    out.lines.length = 0;
    r = await c.executeScript('PRINTF("x")\nENDWHILE\nUNTIL 1\nELSE\n');
    expect(r).toEqual({ ok: false, errors: 3 });
    expect(out.texts()).toEqual(['ENDWHILE without WHILE', 'UNTIL without REPEAT', 'ELSE without IF']);
    out.lines.length = 0;
    r = await c.executeScript('WHILE 0\nENDIF\nENDWHILE\n');
    expect(out.texts()).toEqual(['ENDIF found, ENDWHILE expected']);
    // well-formed scripts still run
    out.lines.length = 0;
    r = await c.executeScript('IF 0\nPRINTF("no")\nELSE\nPRINTF("yes")\nENDIF\n');
    expect(r.ok).toBe(true);
    expect(out.texts().filter((l) => !l.startsWith('PRINTF'))).toEqual(['yes']);
  });
});

describeFx('finding 7: LOAD options in any case', () => {
  it('load norunafterload / load file.abs codeonly', async () => {
    const calls: [string | undefined, string[]][] = [];
    const { c, out } = await interp({ load: async (f, o) => void calls.push([f, o]) });
    await c.execute('load norunafterload', { echo: false });
    await c.execute('load bin/Project.abs codeonly nobpt', { echo: false });
    await c.execute('load project', { echo: false }); // an extension-less file name is still a file
    expect(calls).toEqual([
      [undefined, ['NORUNAFTERLOAD']],
      ['bin/Project.abs', ['CODEONLY', 'NOBPT']],
      ['project', []],
    ]);
    expect(out.lines.filter((l) => l.kind === 'error')).toEqual([]);
  });
});

describe('finding 8: paged breakpoints match only their page during instruction stepping', () => {
  it('a $FC8000 breakpoint does not fire at $8000 with PPAGE=$FE', async () => {
    const t = new SimTarget();
    // 0x7FFF: NOP (fixed page FD); 0x8000: NOP (PPAGE window); 0x8001: RTS back to 0x7FFF
    await t.writeMemory(0x7fff, [0xa7]);
    await t.writeMemory(0x3000, [0x7f, 0xff]);
    const run = async (ppage: number) => {
      await t.writeRegister('PPAGE', ppage);
      await t.writeMemory(0x8000, [0xa7, 0x3d]);
      await t.writeRegister('PC', 0x7fff);
      await t.writeRegister('SP', 0x3000);
      return t.step('out');
    };
    const bp = await t.addBreakpoint({ address: 0xfc8000 });
    expect(bp.global).toBeDefined();
    let h = await run(0xfe);
    expect(h.reason).toBe('step');
    expect(h.pc).toBe(0x7fff);
    h = await run(0xfc);
    expect(h.reason).toBe('breakpoint');
    expect(h.pc).toBe(0x8000);
  });
});

describeFx('finding 10: G while running is an error', () => {
  it('reports instead of printing STARTED', async () => {
    const { t, c, out } = await interp();
    await t.go();
    out.lines.length = 0;
    expect(await c.execute('G', { echo: false })).toBe(false);
    expect(out.lines).toEqual([{ text: 'Target is already running', kind: 'error' }]);
    await t.halt();
  });
});

describe('fs helpers without node:path', () => {
  it('joinPath / dirName match path.posix', () => {
    expect(joinPath('/proj', 'cmd\\x.cmd')).toBe('/proj/cmd/x.cmd');
    expect(joinPath('/proj/bin', '../cmd/./a.cmd')).toBe('/proj/cmd/a.cmd');
    expect(joinPath('/proj', '.')).toBe('/proj');
    expect(joinPath('.', 'a')).toBe('a');
    expect(joinPath('a', '../..')).toBe('..');
    expect(joinPath('/', '..')).toBe('/');
    expect(joinPath('/p', 'C:\\x\\y')).toBe('C:/x/y');
    expect(dirName('/proj/bin/Project.abs')).toBe('/proj/bin');
    expect(dirName('/proj')).toBe('/');
    expect(dirName('a')).toBe('.');
    expect(dirName('a/b/')).toBe('a');
    expect(dirName('C:\\x\\y.abs')).toBe('C:/x');
  });
});
