// Regression tests for review findings on nvm.ts (per-block lock, immediate byte-write ACCERR).
import { describe, expect, it } from 'vitest';
import { Assembler, resolveOptions } from '@s12/asm';
import { S12XSystem, createBoardNets } from '@s12/sim';
import { EEPROM_RANGE, EepromModule, FLASH_RANGE, FlashModule, createNvmRomWriteHandler, type NvmOptions } from '../src/periph/nvm';

function load(s: S12XSystem, src: string): Map<string, number> {
  const a = new Assembler({
    sourcePath: 't.asm',
    readFile: (p: string) => (p === 't.asm' ? src : undefined),
    options: resolveOptions('-CPUHCS12X').options,
    env: {},
  });
  a.run();
  const errs = a.messages.filter((m) => m.severity === 'ERROR' || m.severity === 'FATAL');
  if (errs.length) throw new Error(errs.map((m) => m.text).join('\n'));
  for (const st of a.stmts) if (st.bytes && st.section?.kind === 'org') st.bytes.forEach((b, i) => s.poke(st.loc + i, b));
  return new Map(a.symList.filter((x) => x.defined).map((x) => [x.name, x.value]));
}

interface Rig {
  s: S12XSystem;
  flash: FlashModule;
  ee: EepromModule;
  handler: (g: number, v: number) => boolean;
}

function rig(opts: NvmOptions = {}): Rig {
  const s = new S12XSystem({ ramInit: 'zero' });
  const nets = createBoardNets();
  const flash = new FlashModule(nets, opts);
  const ee = new EepromModule(nets, { ...opts, secured: () => flash.secured });
  s.addPeripheral(flash, [FLASH_RANGE]);
  s.addPeripheral(ee, [EEPROM_RANGE]);
  const handler = createNvmRomWriteHandler(flash, ee);
  s.setRomWriteHandler(handler);
  s.reset();
  s.setRegisters({ sp: 0x3f00, ccr: 0, ipl: 0 });
  return { s, flash, ee, handler };
}

const arrayWord = (r: Rig, g: number, w: number) => {
  r.handler(g, w >> 8);
  r.handler(g + 1, w & 0xff);
};
const FCNFG = 0x103;
const FSTAT = 0x105;
const FCMD = 0x106;
const ESTAT = 0x115;

describe('flash blocks have independent command state machines', () => {
  it('ACCERR left in block 1 does not block a program command in block 0', () => {
    const r = rig({ timing: { instant: true }, specialMode: () => false });
    r.s.poke(0x100, 0x49);
    r.s.poke(FCNFG, 0x01); // BKSEL = 1
    r.s.poke(FCMD, 0x20); // command without array write -> ACCERR in block 1
    expect(r.s.peek(FSTAT) & 0x10).toBe(0x10);
    r.s.poke(FCNFG, 0x00);
    expect(r.s.peek(FSTAT)).toBe(0xc0);
    arrayWord(r, 0x7fc100, 0x1234);
    r.s.poke(FCMD, 0x20);
    r.s.poke(FSTAT, 0x80);
    r.flash.finishCommands();
    expect([r.s.peekGlobal(0x7fc100), r.s.peekGlobal(0x7fc101)]).toEqual([0x12, 0x34]);
    expect(r.s.peek(FSTAT)).toBe(0xc0);
    // Block 1 still holds its error until cleared there.
    r.s.poke(FCNFG, 0x01);
    expect(r.s.peek(FSTAT) & 0x10).toBe(0x10);
  });

  it('an error in the selected block still locks that block', () => {
    const r = rig({ timing: { instant: true }, specialMode: () => false });
    r.s.poke(0x100, 0x49);
    r.s.poke(FCMD, 0x20); // ACCERR in block 0
    arrayWord(r, 0x7fc100, 0x1234);
    r.s.poke(FCMD, 0x20);
    r.s.poke(FSTAT, 0x80);
    r.flash.finishCommands();
    expect(r.s.peekGlobal(0x7fc100)).toBe(0xff);
    expect(r.s.peek(FSTAT) & 0x10).toBe(0x10);
  });

  it('WRALL commands are locked by an error in any block', () => {
    const r = rig({ timing: { instant: true }, specialMode: () => true });
    r.s.poke(0x100, 0x49);
    r.s.poke(FCNFG, 0x02);
    r.s.poke(FCMD, 0x41); // ACCERR in block 2
    r.s.poke(FCNFG, 0x00);
    r.s.poke(0x102, 0x10); // FTSTMOD.WRALL (special mode)
    r.s.pokeGlobal(0x7fc100, 0);
    arrayWord(r, 0x7fc100, 0xffff);
    r.s.poke(FCMD, 0x41);
    r.s.poke(FSTAT, 0x80);
    r.flash.finishCommands();
    expect(r.s.peekGlobal(0x7fc100)).toBe(0); // mass erase not started
    // Clear the error in every block (WRALL writes FSTAT of all blocks), then the same sequence erases.
    r.s.poke(FSTAT, 0x30);
    arrayWord(r, 0x7fc100, 0xffff);
    r.s.poke(FCMD, 0x41);
    r.s.poke(FSTAT, 0x80);
    r.flash.finishCommands();
    expect(r.s.peekGlobal(0x7fc100)).toBe(0xff);
  });
});

describe('array byte writes', () => {
  it('a lone byte write flags ACCERR by the next instruction (STAA then LDAB ESTAT)', () => {
    const r = rig({ timing: { instant: true } });
    const sym = load(
      r.s,
      `
 ORG $3000
start: MOVB #$49,$110
 LDAA #$55
 STAA $0C00                 ; byte write to the EEPROM array
 LDAB $115                  ; ESTAT right after
 STAB $2000
done: BRA done
`,
    );
    r.s.setRegisters({ pc: sym.get('start')! });
    r.s.run(200);
    expect(r.s.peek(0x2000) & 0x10).toBe(0x10);
    expect(r.s.events.some((e) => e.kind === 'rom-write')).toBe(false);
  });

  it('a lone byte write is visible to a later register read without any other write', () => {
    const r = rig({ timing: { instant: true } });
    r.s.poke(0x110, 0x49);
    r.handler(0x13fc00, 0x55);
    expect(r.s.bus.regRead(ESTAT, 100) & 0x10).toBe(0x10);
  });

  it('STD word writes still pair (no ACCERR) and program', () => {
    const r = rig({ timing: { instant: true } });
    const sym = load(
      r.s,
      `
 ORG $3000
start: MOVB #$49,$110
 LDD #$BEEF
 STD $0C20
 LDAB $115
 STAB $2000
 MOVB #$20,$116
 MOVB #$80,$115
wt: BRCLR $115,#$40,wt
done: BRA done
`,
    );
    r.s.setRegisters({ pc: sym.get('start')! });
    r.s.run(500);
    expect(r.s.peek(0x2000)).toBe(0xc0);
    expect([r.s.peek(0x0c20), r.s.peek(0x0c21)]).toEqual([0xbe, 0xef]);
  });
});
