import { describe, expect, it } from 'vitest';
import { fixture, itFx } from '../../formats/test/fixtures';
import { readFileSync } from 'node:fs';
import { Assembler, resolveOptions } from '@s12/asm';
import { S12XSystem, createBoardNets } from '@s12/sim';
import { addr, registerByName } from '@s12/devices';
import {
  EEPROM_RANGE,
  EEPROM_VECTOR,
  EepromModule,
  FLASH_RANGE,
  FLASH_VECTOR,
  FlashModule,
  createNvmRomWriteHandler,
  type NvmOptions,
} from '../src/periph/nvm';

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

function rig(opts: NvmOptions = {}, setup?: (s: S12XSystem) => void): Rig {
  const s = new S12XSystem({ ramInit: 'zero' });
  setup?.(s);
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

const EE = 0x13f000;
const eeLocal = (g: number) => 0x0c00 + (g - 0x13fc00);
/** CPU-equivalent word write to the array (both bytes at the same cycle). */
function arrayWord(r: Rig, g: number, w: number): void {
  r.handler(g, w >> 8);
  r.handler(g + 1, w & 0xff);
}
const wb = (r: Rig, a: number, v: number) => r.s.poke(a, v);
const ESTAT = 0x115;
const ECMD = 0x116;
const FSTAT = 0x105;
const FCMD = 0x106;

describe('NVM register map and reset', () => {
  it('addresses and vectors from @s12/devices', () => {
    expect(FLASH_RANGE).toEqual([addr('FCLKDIV'), addr('FCLKDIV') + 15]);
    expect(EEPROM_RANGE).toEqual([0x110, 0x11b]);
    expect(addr('EDATA')).toBe(0x11a);
    expect(FLASH_VECTOR).toBe(0xb8);
    expect(EEPROM_VECTOR).toBe(0xba);
  });

  it('reset: FSTAT/ESTAT = $C0; FSEC/FPROT/FCTL/EPROT loaded from the configuration fields', () => {
    const r = rig();
    expect(r.s.peek(FSTAT)).toBe(registerByName('FSTAT')!.reset);
    expect(r.s.peek(ESTAT)).toBe(0xc0);
    expect(r.s.peek(0x101)).toBe(0xff); // erased flash: SEC=11 (secured pattern)
    expect(r.flash.secured).toBe(true);
    r.s.poke(0xff0f, 0xfe);
    r.s.poke(0xff0d, 0x9b);
    r.s.poke(0xff0e, 0x7f);
    r.s.poke(0x0ffd, 0x8a);
    r.s.reset();
    expect(r.s.peek(0x101)).toBe(0xfe);
    expect(r.flash.secured).toBe(false);
    expect(r.s.peek(0x104)).toBe(0x9b);
    expect(r.s.peek(0x107)).toBe(0x7f);
    expect(r.s.peek(0x114)).toBe(0x8a);
  });
});

describe('EEPROM command sequence', () => {
  it('word program from code in RAM: FDIVLD, CCIF polling, exact duration (9 FCLK + 25 bus)', () => {
    const r = rig();
    const sym = load(
      r.s,
      `
 ORG $3000
start: MOVB #$49,$110       ; ECLKDIV: 16 MHz / 8 / 10 = 200 kHz
 LDD #$1234
 STD $0C10                  ; array write (latches address + data)
 MOVB #$20,$116             ; ECMD = program
 MOVB #$80,$115             ; launch
 LDX #0
wt: INX
 BRCLR $115,#$40,wt
 STX $2000
done: BRA done
`,
    );
    r.s.setRegisters({ pc: sym.get('start')! });
    expect(r.s.peek(0x0c10)).toBe(0xff);
    r.s.run(2000);
    expect(r.s.peek(0x110)).toBe(0xc9);
    expect([r.s.peek(0x0c10), r.s.peek(0x0c11)]).toEqual([0x12, 0x34]);
    // FCLK = 200 kHz at an 8 MHz bus: 40 bus cycles per FCLK -> 9*40+25 = 385 cycles; the loop is 6 cycles/iteration
    expect(r.ee.commandCycles(0x20, 0)).toBe(385);
    const iters = r.s.peek(0x2000) * 256 + r.s.peek(0x2001);
    expect(iters).toBeGreaterThanOrEqual(62);
    expect(iters).toBeLessThanOrEqual(66);
    expect(r.s.events.some((e) => e.kind === 'rom-write')).toBe(false);
  });

  it('ACCERR cases: no clock divider, byte write, misaligned word, command without array write, invalid command, CBEIF=0', () => {
    const r = rig({ timing: { instant: true } });
    arrayWord(r, 0x13fc00, 0x0000);
    expect(r.s.peek(ESTAT) & 0x10).toBe(0x10); // ECLKDIV not written
    wb(r, ESTAT, 0x10);
    expect(r.s.peek(ESTAT)).toBe(0xc0);
    wb(r, 0x110, 0x49);
    r.handler(0x13fc00, 0x00); // byte write: flagged at the next register write
    wb(r, ECMD, 0x20);
    expect(r.s.peek(ESTAT) & 0x10).toBe(0x10);
    wb(r, ESTAT, 0x30);
    r.handler(0x13fc01, 0x00); // odd address
    expect(r.s.peek(ESTAT) & 0x10).toBe(0x10);
    wb(r, ESTAT, 0x30);
    wb(r, ECMD, 0x20); // no array write
    expect(r.s.peek(ESTAT) & 0x10).toBe(0x10);
    wb(r, ESTAT, 0x30);
    arrayWord(r, 0x13fc00, 0x0000);
    wb(r, ECMD, 0x33); // invalid
    expect(r.s.peek(ESTAT) & 0x10).toBe(0x10);
    wb(r, ESTAT, 0x30);
    arrayWord(r, 0x13fc00, 0x0000);
    wb(r, ECMD, 0x20);
    wb(r, ESTAT, 0x00); // 0 to CBEIF aborts
    expect(r.s.peek(ESTAT) & 0x10).toBe(0x10);
    wb(r, ESTAT, 0x30);
    arrayWord(r, 0x13fc00, 0x0000);
    wb(r, 0x113, 0x00); // other register written mid-sequence
    expect(r.s.peek(ESTAT) & 0x10).toBe(0x10);
    // ACCERR locks the state machine
    arrayWord(r, 0x13fc00, 0x0000);
    wb(r, ECMD, 0x20);
    wb(r, ESTAT, 0x80);
    r.ee.finishCommands();
    expect(r.s.peek(0x0c00)).toBe(0xff);
    // a correct sequence after clearing works
    wb(r, ESTAT, 0x30);
    arrayWord(r, 0x13fc00, 0xa55a);
    wb(r, ECMD, 0x20);
    wb(r, ESTAT, 0x80);
    r.ee.finishCommands();
    expect([r.s.peek(0x0c00), r.s.peek(0x0c01)]).toEqual([0xa5, 0x5a]);
    expect(r.s.peek(ESTAT)).toBe(0xc0);
  });

  it('sector erase (4 bytes), sector modify, erase verify (BLANK), mass erase', () => {
    const r = rig({ timing: { instant: true } });
    for (let i = 0; i < 16; i++) r.s.poke(0x0c00 + i, i);
    wb(r, 0x110, 0x49);
    const cmd = (g: number, w: number, c: number) => {
      arrayWord(r, g, w);
      wb(r, ECMD, c);
      wb(r, ESTAT, 0x80);
      r.ee.finishCommands();
    };
    cmd(0x13fc06, 0, 0x40); // sector $0C04-$0C07
    expect([3, 4, 5, 6, 7, 8].map((i) => r.s.peek(0x0c00 + i))).toEqual([3, 0xff, 0xff, 0xff, 0xff, 8]);
    cmd(0x13fc0a, 0xbeef, 0x60); // sector modify $0C08-$0C0B, program $0C0A
    expect([8, 9, 10, 11, 12].map((i) => r.s.peek(0x0c00 + i))).toEqual([0xff, 0xff, 0xbe, 0xef, 12]);
    cmd(0x13fc00, 0, 0x05);
    expect(r.s.peek(ESTAT) & 0x04).toBe(0);
    cmd(0x13fc00, 0, 0x41);
    expect(r.s.peek(0x0c0a)).toBe(0xff);
    expect(r.s.peek(0x0800)).toBe(0xff); // whole 4 KB
    cmd(0x13fc00, 0, 0x05);
    expect(r.s.peek(ESTAT)).toBe(0xc4);
    expect(eeLocal(0x13fc0a)).toBe(0x0c0a);
    expect(EE).toBe(0x13f000);
  });

  it('protection: EPDIS=0 protects the top 64*(EP+1) bytes; EPOPEN=0 everything; mass erase needs both open', () => {
    const r = rig({ timing: { instant: true }, specialMode: () => false });
    wb(r, 0x110, 0x49);
    wb(r, 0x114, 0xf1); // EPDIS=0, EP=1 -> top 128 bytes ($13FF80-$13FFFF); normal mode: only towards protection
    expect(r.s.peek(0x114)).toBe(0xf1);
    expect(r.ee.protectedAreas()).toEqual([[0x13ff80, 0x13ffff]]);
    arrayWord(r, 0x13ff80, 0);
    wb(r, ECMD, 0x20);
    expect(r.s.peek(ESTAT) & 0x20).toBe(0x20);
    wb(r, ESTAT, 0x20);
    arrayWord(r, 0x13ff7e, 0x1111);
    wb(r, ECMD, 0x20);
    wb(r, ESTAT, 0x80);
    r.ee.finishCommands();
    expect(r.s.peek(0x0f7e)).toBe(0x11);
    arrayWord(r, 0x13f000, 0);
    wb(r, ECMD, 0x41);
    expect(r.s.peek(ESTAT) & 0x20).toBe(0x20);
    wb(r, ESTAT, 0x20);
    wb(r, 0x114, 0xff); // cannot re-open in normal mode
    expect(r.s.peek(0x114)).toBe(0xf1);
    wb(r, 0x114, 0x71);
    expect(r.ee.protectedAreas()).toEqual([[0x13f000, 0x13ffff]]);
  });

  it('2-stage pipeline: CBEIF=0 while a second command waits; CCIF only after both', () => {
    const r = rig();
    wb(r, 0x110, 0x49);
    arrayWord(r, 0x13fc00, 0x1111);
    wb(r, ECMD, 0x20);
    wb(r, ESTAT, 0x80);
    expect(r.s.peek(ESTAT)).toBe(0x80); // CBEIF=1, CCIF=0
    arrayWord(r, 0x13fc02, 0x2222);
    wb(r, ECMD, 0x20);
    wb(r, ESTAT, 0x80);
    expect(r.s.peek(ESTAT)).toBe(0x00);
    expect(r.ee.busy).toBe(true);
    const t0 = r.s.totalCycles;
    load(r.s, ' ORG $3000\nl: BRA l\n');
    r.s.setRegisters({ pc: 0x3000 });
    r.s.run(385 + 10);
    expect(r.s.peek(ESTAT)).toBe(0x80);
    expect(r.s.peek(0x0c00)).toBe(0x11);
    expect(r.s.peek(0x0c02)).toBe(0xff);
    r.s.run(400);
    expect(r.s.peek(ESTAT)).toBe(0xc0);
    expect(r.s.peek(0x0c02)).toBe(0x22);
    expect(r.s.totalCycles - t0).toBeGreaterThan(770);
  });

  it('CCIE interrupt (Veeprom) wakes an ISR', () => {
    const r = rig();
    const sym = load(
      r.s,
      `
 ORG $3000
start: MOVB #$49,$110
 MOVW #$5678,$0C20
 MOVB #$20,$116
 MOVB #$80,$115
 MOVB #$40,$113             ; CCIE
 CLI
l: BRA l
isr: CLR $113
 INC $2000
 RTI
`,
    );
    r.s.poke(0xffba, sym.get('isr')! >> 8);
    r.s.poke(0xffbb, sym.get('isr')! & 0xff);
    r.s.setRegisters({ pc: sym.get('start')! });
    r.s.run(2000);
    expect(r.s.peek(0x2000)).toBe(1);
    expect(r.s.peek(0x0c20)).toBe(0x56);
  });
});

describe('Flash command sequence', () => {
  it('program and sector erase (1 KB) in block 0; BKSEL must select the written block', () => {
    const r = rig({ timing: { instant: true } });
    wb(r, 0x100, 0x49);
    arrayWord(r, 0x7fc100, 0xc0de);
    wb(r, FCMD, 0x20);
    wb(r, FSTAT, 0x80);
    r.flash.finishCommands();
    expect([r.s.peek(0xc100), r.s.peek(0xc101)]).toEqual([0xc0, 0xde]);
    // block 3 ($780000-$79FFFF) while BKSEL = 0 -> ACCERR
    arrayWord(r, 0x780000, 0);
    expect(r.s.peek(FSTAT) & 0x10).toBe(0x10);
    wb(r, FSTAT, 0x10);
    wb(r, 0x103, 0x03);
    expect(r.s.peek(FSTAT) & 0x10).toBe(0); // bank 3 status is clean
    arrayWord(r, 0x780002, 0x0102);
    wb(r, FCMD, 0x20);
    wb(r, FSTAT, 0x80);
    r.flash.finishCommands();
    expect(r.s.peekGlobal(0x780002)).toBe(0x01);
    wb(r, 0x103, 0x00);
    for (const g of [0x7fc3ff, 0x7fc400, 0x7fc000]) r.s.pokeGlobal(g, 0);
    arrayWord(r, 0x7fc2fe, 0);
    wb(r, FCMD, 0x40);
    wb(r, FSTAT, 0x80);
    r.flash.finishCommands();
    expect([r.s.peekGlobal(0x7fc000), r.s.peekGlobal(0x7fc100), r.s.peekGlobal(0x7fc3ff), r.s.peekGlobal(0x7fc400)]).toEqual([
      0xff, 0xff, 0xff, 0,
    ]);
  });

  it('FPROT ranges (FPHS/FPLS), PVIOL, durations from FCLKDIV', () => {
    const r = rig({ specialMode: () => false });
    wb(r, 0x100, 0x49);
    wb(r, 0x104, 0xd9); // FPHDIS=0 FPHS=11 (16 KB), FPLDIS=0 FPLS=01 (2 KB)
    expect(r.flash.protectedAreas(0)).toEqual([
      [0x7fc000, 0x7fffff],
      [0x7f8000, 0x7f87ff],
    ]);
    arrayWord(r, 0x7fc000, 0);
    wb(r, FCMD, 0x20);
    expect(r.s.peek(FSTAT) & 0x20).toBe(0x20);
    expect(r.flash.commandCycles(0x40, 0)).toBe(4000 * 40);
    expect(r.flash.commandCycles(0x41, 0)).toBe(20000 * 40);
  });

  it('backdoor key access unsecures (normal mode, KEYEN=10)', () => {
    const r = rig({ specialMode: () => false }, (s) => {
      const key = [0x1111, 0x2222, 0x3333, 0x4444];
      key.forEach((w, i) => {
        s.pokeGlobal(0x7fff00 + 2 * i, w >> 8);
        s.pokeGlobal(0x7fff01 + 2 * i, w & 0xff);
      });
      s.pokeGlobal(0x7fff0f, 0x80 | 0x3f); // KEYEN=10, SEC=11
    });
    expect(r.flash.secured).toBe(true);
    wb(r, 0x103, 0x20);
    for (const [i, w] of [0x1111, 0x2222, 0x3333, 0x4444].entries()) arrayWord(r, 0x7fff00 + 2 * i, w);
    wb(r, 0x103, 0x00);
    expect(r.flash.secured).toBe(false);
    expect(r.s.peek(0x101) & 3).toBe(2);
  });
});

describe('P&E Multilink "Erase_unsecure_hcs12" script executed as register pokes', () => {
  itFx('mass-erases flash (WRALL) and EEPROM, then programs the security word: FSEC = $FE after reset', () => {
    const r = rig({ enforceSecurity: true }, (s) => {
      // A secured part with code in flash and data in EEPROM.
      for (let g = 0x780000; g < 0x780010; g++) s.pokeGlobal(g, 0x12);
      s.pokeGlobal(0x7ec000, 0x34);
      s.pokeGlobal(0x7fff0f, 0x7f); // SEC=11: secured
      s.pokeGlobal(0x13f800, 0x56);
    });
    expect(r.flash.secured).toBe(true);
    const script = readFileSync(fixture('Lab3', 'cmd', 'P&E_Multilink_USB_Erase_unsecure_hcs12.cmd'), 'latin1');
    const CLKDIV = 0x49;
    for (const raw of script.split(/\r?\n/)) {
      const line = raw.replace(/\/\/.*$/, '').trim();
      if (!line) continue;
      const [cmd, ...args] = line.split(/\s+/);
      const num = (x: string) => (x === 'CLKDIV' ? CLKDIV : parseInt(x, 16));
      switch (cmd.toLowerCase()) {
        case 'reset':
          r.s.reset('external');
          break;
        case 'wait':
          r.flash.finishCommands();
          r.ee.finishCommands();
          break;
        case 'wb': {
          const a = num(args[0]);
          const g = r.s.toGlobal(a);
          if (!r.handler(g, num(args[1]))) r.s.poke(a, num(args[1]));
          break;
        }
        case 'ww': {
          const a = num(args[0]);
          const v = num(args[1]);
          const g = r.s.toGlobal(a);
          if (r.flash.bankOf(g) >= 0 || r.ee.bankOf(g) >= 0) {
            r.handler(g, v >> 8);
            r.handler(g + 1, v & 0xff);
          } else {
            r.s.poke(a, v >> 8);
            r.s.poke(a + 1, v & 0xff);
          }
          break;
        }
        default:
          break; // DEFINEVALUEDLG, FLASH RELEASE, undef: debugger-level
      }
    }
    expect(r.s.peekGlobal(0x780000)).toBe(0xff);
    expect(r.s.peekGlobal(0x7ec000)).toBe(0xff);
    expect(r.s.peekGlobal(0x13f800)).toBe(0xff);
    expect([r.s.peekGlobal(0x7fff0e), r.s.peekGlobal(0x7fff0f)]).toEqual([0xff, 0xfe]);
    expect(r.s.peek(0x101)).toBe(0xfe);
    expect(r.flash.secured).toBe(false);
    expect(r.s.peek(FSTAT)).toBe(0xc0);
  });

  it('a secured part refuses program commands when security is enforced', () => {
    const r = rig({ enforceSecurity: true, timing: { instant: true } }, (s) => {
      s.pokeGlobal(0x7fff0f, 0x7f);
      s.pokeGlobal(0x780000, 0); // not blank -> no BDM unsecure
    });
    wb(r, 0x100, 0x49);
    arrayWord(r, 0x7fc000, 0);
    wb(r, FCMD, 0x20);
    expect(r.s.peek(FSTAT) & 0x10).toBe(0x10);
  });
});

describe('NVM plumbing', () => {
  it('handler ignores non-array addresses; snapshot/restore mid-command', () => {
    const r = rig();
    expect(r.handler(0x0f8000, 1)).toBe(false);
    wb(r, 0x110, 0x49);
    arrayWord(r, 0x13fc00, 0x1234);
    wb(r, ECMD, 0x20);
    wb(r, ESTAT, 0x80);
    const snap = r.ee.snapshot();
    r.ee.finishCommands();
    expect(r.s.peek(0x0c00)).toBe(0x12);
    r.s.poke(0x0c00, 0xff);
    r.s.poke(0x0c01, 0xff);
    r.ee.restore(snap);
    expect(r.ee.busy).toBe(true);
    r.ee.finishCommands();
    expect(r.s.peek(0x0c01)).toBe(0x34);
  });
});
