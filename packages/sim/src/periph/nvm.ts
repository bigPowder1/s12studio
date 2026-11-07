/**
 * Flash (FTX512K4, registers $0100-$010F) and EEPROM (EETX4K, $0110-$011B) command controllers of the
 * MC9S12XDP512: clock divider, protection, security, the 3-step command write sequence
 * (aligned word write to the array -> FCMD/ECMD -> write 1 to CBEIF), a 2-stage command pipeline (CBEIF/CCIF),
 * error flags (ACCERR, PVIOL), and timed command execution that modifies the arrays through
 * `ctx.readGlobal/writeGlobal`.
 *
 * Sources: FTS256K block guide V03.01 and EETS4K V02.07 (the HCS12 predecessors of FTX512K4/EETX4K: same register
 * layout, flags and command sequence rules) plus docs/research/r2/xdp512-device.md §9. Things the XDP512 RM would
 * pin down and that are UNCERTAIN here: flash sector size (1 KB), protection ranges, the $47 sector-erase-abort
 * details, command durations, and how FADDR/EADDR encode the address (word index inside the block here).
 *
 * WIRING (integrator): register both modules, then route CPU writes to the flash/EEPROM arrays to them:
 *
 *   const flash = new FlashModule(nets, { specialMode: () => (sys.bus.modeReg & 0x80) === 0 });
 *   const ee = new EepromModule(nets, { secured: () => flash.secured });
 *   sys.addPeripheral(flash, [FLASH_RANGE]);
 *   sys.addPeripheral(ee, [EEPROM_RANGE]);
 *   sys.setRomWriteHandler(createNvmRomWriteHandler(flash, ee));
 *   sys.reset();
 *
 * The handler consumes every write to the arrays (no 'rom-write' warning) and latches the data for the command
 * sequence exactly as the hardware does (an array write never changes memory by itself). Debugger memory edits
 * (`S12XSystem.poke`) still write the arrays directly, like hiwave's simulator. A hardware-style `.cmd` script
 * (`wb`/`ww` to the array, e.g. the P&E unsecure script's `ww 0xFF0E 0xFFFE`) must call the same handler for
 * array addresses; its `wait` should call `finishCommands()` on both modules (or run the CPU), since the commands
 * take real (simulated) time.
 */
import { addr as regAddr, vectorByName } from '@s12/devices';
import type { BoardNets } from '../pins.js';
import type { Peripheral, PeripheralContext, RegisterRange, ResetCause } from '../types.js';

export const FLASH_BASE = regAddr('FCLKDIV');
export const EEPROM_BASE = regAddr('ECLKDIV');
export const FLASH_RANGE: RegisterRange = [FLASH_BASE, FLASH_BASE + 0x0f];
export const EEPROM_RANGE: RegisterRange = [EEPROM_BASE, EEPROM_BASE + 0x0b];
/** Vflash $B8, Veeprom $BA. */
export const FLASH_VECTOR = vectorByName('Vflash')!.offset;
export const EEPROM_VECTOR = vectorByName('Veeprom')!.offset;

/** Global array ranges. Flash block n covers $7E0000 - n*$20000 .. +$1FFFF (block 0 = top 128 KB). */
export const FLASH_ARRAY = { start: 0x780000, end: 0x7fffff, blockSize: 0x20000, blocks: 4 } as const;
export const EEPROM_ARRAY = { start: 0x13f000, end: 0x13ffff } as const;

/** FSTAT/ESTAT bits. */
export const NVM_STAT = { CBEIF: 0x80, CCIF: 0x40, PVIOL: 0x20, ACCERR: 0x10, BLANK: 0x04 } as const;
const ST = NVM_STAT;

/** Command codes. */
export const NVM_CMD = { ERASE_VERIFY: 0x05, PROGRAM: 0x20, SECTOR_ERASE: 0x40, MASS_ERASE: 0x41, SECTOR_ERASE_ABORT: 0x47, SECTOR_MODIFY: 0x60 } as const;
const C = NVM_CMD;

/**
 * Command durations. FCLK = OSCCLK / (PRDIV8 ? 8 : 1) / (FDIV + 1) (C14: the divider is fed by the oscillator).
 * UNCERTAIN: values from the HCS12 Flash/EEPROM electrical characteristics (t_swpgm = 9 t_fclk + 25 t_bus,
 * t_era = 4000 t_fclk, t_mass = 20000 t_fclk, t_check = 11 t_bus + 1 t_bus per word).
 */
export interface NvmTiming {
  programFclk: number;
  programBus: number;
  sectorEraseFclk: number;
  massEraseFclk: number;
  verifyBusBase: number;
  /** Sector-erase-abort latency (bus cycles). */
  abortBus: number;
  /** Every command completes in 1 bus cycle (handy for scripts/tests). */
  instant: boolean;
}

export const DEFAULT_NVM_TIMING: NvmTiming = {
  programFclk: 9,
  programBus: 25,
  sectorEraseFclk: 4000,
  massEraseFclk: 20000,
  verifyBusBase: 11,
  abortBus: 10,
  instant: false,
};

export interface NvmOptions {
  /** True in special single-chip mode (FTSTMOD.WRALL, FADDR/FDATA writable, FPROT/EPROT fully writable as under BDM). Default: always special (the simulator's default MODE). */
  specialMode?: () => boolean;
  timing?: Partial<NvmTiming>;
  /**
   * Enforce security for commands (secured => only erase verify and mass erase), as for a BDM-driven session.
   * Default false: the simulated CPU runs from internal memory, where security does not restrict commands.
   */
  enforceSecurity?: boolean;
}

export interface EepromOptions extends NvmOptions {
  /** MCU security state (wire to `flash.secured`). */
  secured?: () => boolean;
}

interface Cmd {
  cmd: number;
  /** Bank (flash block) the command was written to, or -1 for "all" (WRALL). */
  bank: number;
  /** Global byte address of the latched word. */
  global: number;
  data: number;
  end: number;
}

interface Bank {
  stat: number; // PVIOL, ACCERR, BLANK (CBEIF/CCIF derived)
  prot: number;
  cmd: number;
  addr: number;
  data: number;
  /** 'idle' | array word latched | command written. */
  seq: 0 | 1 | 2;
  latchGlobal: number;
  active: Cmd | null;
  pending: Cmd | null;
}

export interface NvmSnapshot {
  clkdiv: number;
  cnfg: number;
  tstmod: number;
  sec: number;
  fctl: number;
  banks: Bank[];
  t: number;
  half: { g: number; v: number; at: number } | null;
  keyWords: number[];
  keyLocked: boolean;
  unsecuredByKey: boolean;
  blankUnsecure: boolean;
}

/** Common command state machine for the flash and EEPROM controllers. */
abstract class NvmController implements Peripheral {
  abstract readonly name: string;
  abstract readonly base: number;
  abstract readonly vector: number;
  protected ctx: PeripheralContext | null = null;
  protected readonly timing: NvmTiming;
  protected readonly special: () => boolean;
  protected readonly enforceSecurity: boolean;
  protected s: NvmSnapshot;
  private warned = new Set<string>();

  constructor(
    protected readonly nets: BoardNets,
    opts: NvmOptions,
    protected readonly nBanks: number,
  ) {
    this.timing = { ...DEFAULT_NVM_TIMING, ...opts.timing };
    this.special = opts.specialMode ?? (() => true);
    this.enforceSecurity = opts.enforceSecurity ?? false;
    this.s = this.initial(0);
  }

  // ---- device specifics
  /** Global byte range of bank `b`. */
  protected abstract bankRange(b: number): readonly [number, number];
  /** Bank containing global `g`, or -1. */
  abstract bankOf(g: number): number;
  protected abstract sectorSize(): number;
  protected abstract validCommand(cmd: number): boolean;
  /** True when the global range [a, b] touches a protected area of bank `bank`. */
  protected abstract protectedRange(bank: number, a: number, b: number): boolean;
  /** Mass erase allowed: protection fully disabled. */
  protected abstract massEraseAllowed(bank: number): boolean;
  abstract get secured(): boolean;
  protected abstract writeProt(b: Bank, v: number): void;
  protected abstract loadFromArray(): void;
  /** Selected bank (FCNFG.BKSEL for flash). */
  protected abstract get selected(): number;
  protected get wrall(): boolean {
    return false;
  }

  protected initial(t: number): NvmSnapshot {
    const banks: Bank[] = [];
    for (let i = 0; i < this.nBanks; i++) {
      banks.push({ stat: 0, prot: 0xff, cmd: 0, addr: 0, data: 0, seq: 0, latchGlobal: 0, active: null, pending: null });
    }
    return {
      clkdiv: 0,
      cnfg: 0,
      tstmod: 0,
      sec: 0xff,
      fctl: 0xff,
      banks,
      t,
      half: null,
      keyWords: [],
      keyLocked: false,
      unsecuredByKey: false,
      blankUnsecure: false,
    };
  }

  attach(ctx: PeripheralContext): void {
    this.ctx = ctx;
  }

  protected get now(): number {
    const n = this.ctx ? this.ctx.now : 0;
    return n > this.s.t ? n : this.s.t;
  }

  /** Reset: any command in progress is aborted (its target words are left as they were); protection/security reload from the array. */
  reset(_cause?: ResetCause): void {
    this.s = this.initial(this.ctx ? this.ctx.now : 0);
    this.loadFromArray();
    this.updateIrq();
  }

  protected warnOnce(key: string, msg: string, data?: Record<string, unknown>): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.ctx?.warn(`${this.name}: ${msg}`, data);
  }

  // ------------------------------------------------------------------ clock / timing

  get clockDividerLoaded(): boolean {
    return (this.s.clkdiv & 0x80) !== 0;
  }

  /** FCLK/ECLK (Hz) from the oscillator and the divider. */
  get fclkHz(): number {
    const osc = this.ctx ? this.ctx.oscHz : 16e6;
    const d = this.s.clkdiv;
    return osc / (d & 0x40 ? 8 : 1) / ((d & 0x3f) + 1);
  }

  /** Bus cycles a command takes (without pipelining effects). */
  commandCycles(cmd: number, bank: number): number {
    const tm = this.timing;
    if (tm.instant) return 1;
    const bus = this.ctx ? this.ctx.busHz : 8e6;
    const fclk = bus / this.fclkHz; // bus cycles per FCLK period
    const r = (x: number) => Math.max(1, Math.round(x));
    switch (cmd) {
      case C.PROGRAM:
        return r(tm.programFclk * fclk + tm.programBus);
      case C.SECTOR_ERASE:
        return r(tm.sectorEraseFclk * fclk);
      case C.SECTOR_MODIFY:
        return r(tm.sectorEraseFclk * fclk + tm.programFclk * fclk + tm.programBus);
      case C.MASS_ERASE:
        return r(tm.massEraseFclk * fclk);
      case C.ERASE_VERIFY: {
        const [a, b] = this.bankRange(bank < 0 ? 0 : bank);
        return r(tm.verifyBusBase + (b - a + 1) / 2);
      }
      default:
        return r(tm.abortBus);
    }
  }

  // ------------------------------------------------------------------ time

  private advance(t: number): void {
    // A lone even byte write whose odd partner did not arrive in the same instruction (same cycle) is a byte write:
    // flag ACCERR as soon as time moves on, so the very next FSTAT/ESTAT read already shows it.
    const h = this.s.half;
    if (h && t > h.at) this.flushHalf();
    for (const b of this.s.banks) {
      while (b.active && b.active.end <= t) this.complete(b);
    }
    if (t > this.s.t) this.s.t = t;
    this.updateIrq();
  }

  tick(_n: number): void {
    this.advance(this.ctx ? this.ctx.now : this.s.t);
  }

  nextEventCycles(): number {
    let m = Infinity;
    for (const b of this.s.banks) if (b.active) m = Math.min(m, b.active.end - this.s.t);
    return m === Infinity ? m : Math.max(0, m);
  }

  /** Complete every command in progress or queued now (for a debugger `wait` while the CPU is halted). */
  finishCommands(): void {
    this.ctx?.sync();
    for (const b of this.s.banks) {
      while (b.active) {
        b.active.end = Math.min(b.active.end, this.s.t);
        this.complete(b);
      }
    }
    this.updateIrq();
    this.ctx?.reschedule();
  }

  /** True while any command is executing or queued. */
  get busy(): boolean {
    return this.s.banks.some((b) => b.active !== null);
  }

  private complete(b: Bank): void {
    const c = b.active!;
    this.execute(b, c);
    b.active = null;
    if (b.pending) {
      const p = b.pending;
      b.pending = null;
      p.end = c.end + this.commandCycles(p.cmd, p.bank);
      b.active = p;
    }
  }

  private fill(a: number, z: number, v: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (let g = a; g <= z; g++) ctx.writeGlobal(g, v);
  }

  private blank(a: number, z: number): boolean {
    const ctx = this.ctx;
    if (!ctx) return true;
    for (let g = a; g <= z; g++) if (ctx.readGlobal(g) !== 0xff) return false;
    return true;
  }

  private programWord(g: number, w: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const hi = ctx.readGlobal(g);
    const lo = ctx.readGlobal(g + 1);
    if (hi !== 0xff || lo !== 0xff) {
      this.warnOnce(`prog:${g}`, `programming a word that is not erased at global 0x${g.toString(16).toUpperCase()} (bits can only be cleared)`, {
        global: g,
      });
    }
    // Programming can only clear bits.
    ctx.writeGlobal(g, hi & (w >> 8));
    ctx.writeGlobal(g + 1, lo & w & 0xff);
  }

  private execute(b: Bank, c: Cmd): void {
    const ss = this.sectorSize();
    const sector = c.global - (c.global % ss);
    switch (c.cmd) {
      case C.ERASE_VERIFY: {
        const [a, z] = this.bankRange(this.s.banks.indexOf(b));
        if (this.blank(a, z)) b.stat |= ST.BLANK;
        break;
      }
      case C.PROGRAM:
        this.programWord(c.global, c.data);
        break;
      case C.SECTOR_ERASE:
        this.fill(sector, sector + ss - 1, 0xff);
        break;
      case C.SECTOR_MODIFY:
        this.fill(sector, sector + ss - 1, 0xff);
        this.programWord(c.global, c.data);
        break;
      case C.MASS_ERASE: {
        const [a, z] = this.bankRange(this.s.banks.indexOf(b));
        this.fill(a, z, 0xff);
        break;
      }
      case C.SECTOR_ERASE_ABORT:
        break;
    }
  }

  // ------------------------------------------------------------------ interrupts

  protected statValue(b: Bank): number {
    // CBEIF reads 0 only while a launched command waits in the buffer behind the active one (2-stage pipeline);
    // a written but not yet launched command keeps CBEIF=1 (the launch is the write of 1 to CBEIF).
    const cbe = b.pending === null ? ST.CBEIF : 0;
    const ccif = b.active === null ? ST.CCIF : 0;
    return cbe | ccif | (b.stat & (ST.PVIOL | ST.ACCERR | ST.BLANK));
  }

  protected updateIrq(): void {
    if (!this.ctx) return;
    const b = this.s.banks[this.selected];
    const st = this.statValue(b);
    const on = (this.s.cnfg & 0x80 && st & ST.CBEIF) || (this.s.cnfg & 0x40 && st & ST.CCIF);
    this.ctx.setInterrupt(this.vector, !!on);
  }

  // ------------------------------------------------------------------ command sequence

  private targetBanks(): Bank[] {
    return this.wrall ? this.s.banks : [this.s.banks[this.selected]];
  }

  private accerr(b: Bank, why: string): void {
    b.stat |= ST.ACCERR;
    b.seq = 0;
    this.warnOnce(`acc:${why}`, `ACCERR: ${why}`);
  }

  /**
   * A block's command state machine is locked while its own ACCERR/PVIOL is set (each block has its own FSTAT and
   * state machine; an error left in another block does not affect this one).
   */
  private locked(banks: readonly Bank[]): boolean {
    return banks.some((b) => (b.stat & (ST.ACCERR | ST.PVIOL)) !== 0);
  }

  /** A lone even byte write that never got its odd partner is a byte write: ACCERR. */
  private flushHalf(): void {
    const h = this.s.half;
    if (!h) return;
    this.s.half = null;
    if (this.bankOf(h.g) >= 0) this.accerr(this.s.banks[this.selected], `byte write to the array at global 0x${h.g.toString(16).toUpperCase()}`);
  }

  /**
   * CPU (or BDM) write of one byte to the array at global `g`. Returns false when `g` is not in this array.
   * Word writes arrive as two byte writes (even address first) in the same instruction.
   */
  arrayWrite(g: number, v: number): boolean {
    const bank = this.bankOf(g);
    if (bank < 0) return false;
    const t = this.now;
    this.advance(t);
    const h = this.s.half;
    if (h && h.g + 1 === g && h.at === t) {
      this.s.half = null;
      this.wordWrite(h.g, (h.v << 8) | (v & 0xff));
    } else {
      this.flushHalf();
      if (g & 1) this.accerr(this.s.banks[this.selected], `misaligned word or byte write to the array at global 0x${g.toString(16).toUpperCase()}`);
      else this.s.half = { g, v: v & 0xff, at: t };
    }
    this.updateIrq();
    this.ctx?.reschedule();
    return true;
  }

  /** Hook for flash backdoor-key writes (KEYACC); returns true when consumed. */
  protected keyWrite(_g: number, _w: number): boolean {
    return false;
  }

  private wordWrite(g: number, w: number): void {
    if (this.keyWrite(g, w)) return;
    const bank = this.bankOf(g);
    const sel = this.selected;
    const targets = this.wrall ? this.s.banks : [this.s.banks[bank]];
    // Errors are flagged in the FSTAT bank the program is looking at (the selected one).
    const own = this.s.banks[sel];
    if (this.locked(targets)) return; // target block(s) locked until their ACCERR/PVIOL are cleared
    if (!this.clockDividerLoaded) return this.accerr(own, 'array write before the clock divider (FCLKDIV/ECLKDIV) was written');
    if (!this.wrall && bank !== sel) return this.accerr(own, 'array write to a block not selected by FCNFG.BKSEL');
    for (const b of targets) {
      if (b.pending) return this.accerr(own, 'array write while CBEIF=0 (command buffer full)');
      if (b.seq !== 0) return this.accerr(own, 'second array write before the command was launched');
    }
    for (const b of targets) {
      b.seq = 1;
      b.latchGlobal = g;
      const [a] = this.bankRange(this.s.banks.indexOf(b));
      b.addr = ((g - a) >> 1) & 0xffff;
      b.data = w & 0xffff;
    }
  }

  /** Global address of a bank's latched word (array write, or FADDR written directly in special mode). */
  private latchedGlobal(b: Bank): number {
    const [a] = this.bankRange(this.s.banks.indexOf(b));
    return a + b.addr * 2;
  }

  private writeCmd(v: number): void {
    const cmd = v & 0x7f;
    const banks = this.targetBanks();
    if (this.locked(banks)) return;
    for (const b of banks) {
      if (b.seq === 0) return this.accerr(b, 'command written without a preceding array write');
      if (b.seq === 2) return this.accerr(b, 'second command written before the first was launched');
      if (!this.validCommand(cmd)) return this.accerr(b, `invalid command $${cmd.toString(16).toUpperCase()}`);
      if (this.enforceSecurity && this.secured && cmd !== C.ERASE_VERIFY && cmd !== C.MASS_ERASE) {
        return this.accerr(b, 'only mass erase / erase verify are allowed while the MCU is secured');
      }
    }
    for (const b of this.targetBanks()) {
      const bi = this.s.banks.indexOf(b);
      const g = this.latchedGlobal(b);
      const ss = this.sectorSize();
      let viol = false;
      if (cmd === C.PROGRAM) viol = this.protectedRange(bi, g, g + 1);
      else if (cmd === C.SECTOR_ERASE || cmd === C.SECTOR_MODIFY) {
        const sec = g - (g % ss);
        viol = this.protectedRange(bi, sec, sec + ss - 1);
      } else if (cmd === C.MASS_ERASE) viol = !this.massEraseAllowed(bi);
      if (viol) {
        b.stat |= ST.PVIOL;
        b.seq = 0;
        this.warnOnce(`pviol:${cmd}`, `PVIOL: command $${cmd.toString(16).toUpperCase()} at global 0x${g.toString(16).toUpperCase()} hits a protected area`);
        continue;
      }
      b.cmd = cmd;
      b.seq = 2;
    }
  }

  private writeStat(v: number): void {
    const banks = this.targetBanks();
    // Flag clears first (writing 1 to PVIOL/ACCERR), then CBEIF.
    for (const b of banks) b.stat &= ~(v & (ST.PVIOL | ST.ACCERR));
    if (v & ST.CBEIF) {
      for (const b of banks) {
        if (b.seq === 1) this.accerr(b, 'CBEIF written before a command was written');
        else if (b.seq === 2) this.launch(b);
      }
    } else {
      // Writing 0 to CBEIF inside a command sequence aborts it with ACCERR; outside it has no effect.
      for (const b of banks) if (b.seq !== 0) this.accerr(b, 'command sequence aborted by writing 0 to CBEIF');
    }
  }

  private launch(b: Bank): void {
    const t = this.now;
    b.seq = 0;
    b.stat &= ~ST.BLANK;
    const bi = this.wrall ? -1 : this.s.banks.indexOf(b);
    const c: Cmd = { cmd: b.cmd, bank: bi, global: this.latchedGlobal(b), data: b.data, end: 0 };
    if (c.cmd === C.SECTOR_ERASE_ABORT) {
      const act = b.active;
      if (act && act.cmd === C.SECTOR_ERASE) {
        // UNCERTAIN: the aborted sector is left as it was; ACCERR flags the early termination.
        b.active = null;
        b.stat |= ST.ACCERR;
      }
    }
    if (!b.active) {
      c.end = t + this.commandCycles(c.cmd, bi);
      b.active = c;
    } else {
      b.pending = c;
    }
    const f = this.fclkHz;
    if (f < 150e3 || f > 200e3) {
      this.warnOnce('fclk', `command launched with FCLK = ${(f / 1e3).toFixed(1)} kHz (must be 150-200 kHz; check the clock divider)`, { fclkHz: f });
    }
  }

  // ------------------------------------------------------------------ registers

  /** Register offsets: 0 CLKDIV, 1 SEC, 2 TSTMOD, 3 CNFG, 4 PROT, 5 STAT, 6 CMD, 7 CTL, 8/9 ADDR, A/B DATA. */
  protected regValue(off: number): number {
    const s = this.s;
    const b = s.banks[this.selected];
    const sp = this.special();
    switch (off) {
      case 0:
        return s.clkdiv;
      case 3:
        return s.cnfg;
      case 4:
        return b.prot;
      case 5:
        return this.statValue(b);
      case 6:
        return b.cmd;
      case 8:
        return sp ? (b.addr >> 8) & this.addrHiMask() : 0;
      case 9:
        return sp ? b.addr & 0xff : 0;
      case 0x0a:
        return sp ? b.data >> 8 : 0;
      case 0x0b:
        return sp ? b.data & 0xff : 0;
      default:
        return 0;
    }
  }

  protected addrHiMask(): number {
    return 0xff;
  }

  read(a: number): number {
    this.advance(this.now);
    return this.regValue(a - this.base);
  }

  peek(a: number): number {
    return this.regValue(a - this.base);
  }

  write(a: number, v: number): void {
    const t = this.now;
    this.advance(t);
    this.flushHalf();
    v &= 0xff;
    const off = a - this.base;
    const s = this.s;
    const sp = this.special();
    const inSeq = s.banks.some((b) => b.seq !== 0);
    // Writing any register but CMD (after the array write) or STAT (after CMD) aborts a sequence with ACCERR.
    const allowed = off === 5 || off === 6 || (sp && off >= 8 && off <= 0x0b) || this.writeAllowedInSeq(off);
    if (inSeq && !allowed) {
      for (const b of s.banks) if (b.seq !== 0) this.accerr(b, 'register written during a command sequence');
    }
    switch (off) {
      case 0:
        // Bits 6-0 write once in normal modes (anytime in special modes); FDIVLD set by the write.
        if (!this.clockDividerLoaded || sp) s.clkdiv = 0x80 | (v & 0x7f);
        break;
      case 3:
        this.writeCnfg(v);
        break;
      case 4:
        // UNCERTAIN: FPROT is banked by BKSEL (FTS-style); without WRALL only the selected block's FPROT is written.
        // The P&E unsecure script writes FPROT=$FF before setting WRALL, so blocks 1-3 keep the FPROT loaded from
        // the array at reset; if those were programmed, the WRALL mass erase flags PVIOL on them here.
        for (const b of this.targetBanks()) this.writeProt(b, v);
        break;
      case 5:
        this.writeStat(v);
        break;
      case 6:
        this.writeCmd(v);
        break;
      case 8:
      case 9:
      case 0x0a:
      case 0x0b:
        if (!sp) break;
        for (const b of this.targetBanks()) {
          if (off === 8) b.addr = (b.addr & 0x00ff) | ((v & this.addrHiMask()) << 8);
          else if (off === 9) b.addr = (b.addr & 0xff00) | v;
          else if (off === 0x0a) b.data = (b.data & 0x00ff) | (v << 8);
          else b.data = (b.data & 0xff00) | v;
          // Special modes: FADDR/FDATA written directly stand in for the array write (P&E unsecure script).
          if (b.seq === 0 && !this.locked([b])) b.seq = 1;
        }
        break;
      default:
        this.writeOther(off, v);
    }
    this.updateIrq();
  }

  protected writeAllowedInSeq(_off: number): boolean {
    return false;
  }
  protected writeCnfg(v: number): void {
    this.s.cnfg = v & 0xc0;
  }
  protected writeOther(_off: number, _v: number): void {}

  // ------------------------------------------------------------------ snapshot

  snapshot(): NvmSnapshot {
    const s = this.s;
    return {
      ...s,
      banks: s.banks.map((b) => ({ ...b, active: b.active && { ...b.active }, pending: b.pending && { ...b.pending } })),
      half: s.half && { ...s.half },
      keyWords: [...s.keyWords],
    };
  }

  restore(state: unknown): void {
    const st = state as NvmSnapshot;
    this.s = {
      ...st,
      banks: st.banks.map((b) => ({ ...b, active: b.active && { ...b.active }, pending: b.pending && { ...b.pending } })),
      half: st.half && { ...st.half },
      keyWords: [...st.keyWords],
    };
    this.updateIrq();
  }
}

// ==================================================================== flash

/**
 * FTX512K4: 4 blocks of 128 KB with banked FPROT/FSTAT/FCMD/FADDR/FDATA selected by FCNFG.BKSEL;
 * FTSTMOD.WRALL (special modes) writes all banks at once and launches a command on all blocks in parallel.
 */
export class FlashModule extends NvmController {
  readonly name = 'FTX512K4';
  readonly base = FLASH_BASE;
  readonly vector = FLASH_VECTOR;
  /** UNCERTAIN: S12X flash sector = 1 KB. */
  static readonly SECTOR = 1024;

  constructor(nets: BoardNets, opts: NvmOptions = {}) {
    super(nets, opts, FLASH_ARRAY.blocks);
  }

  protected bankRange(b: number): readonly [number, number] {
    const top = FLASH_ARRAY.end - b * FLASH_ARRAY.blockSize;
    return [top - FLASH_ARRAY.blockSize + 1, top];
  }

  bankOf(g: number): number {
    if (g < FLASH_ARRAY.start || g > FLASH_ARRAY.end) return -1;
    return Math.floor((FLASH_ARRAY.end - g) / FLASH_ARRAY.blockSize);
  }

  protected sectorSize(): number {
    return FlashModule.SECTOR;
  }

  protected validCommand(cmd: number): boolean {
    return cmd === C.ERASE_VERIFY || cmd === C.PROGRAM || cmd === C.SECTOR_ERASE || cmd === C.MASS_ERASE || cmd === C.SECTOR_ERASE_ABORT;
  }

  protected get selected(): number {
    return this.s.cnfg & 0x03;
  }

  protected override get wrall(): boolean {
    return (this.s.tstmod & 0x10) !== 0 && this.special();
  }

  /**
   * Protected ranges of block `bank` (FPROT). UNCERTAIN (FTX512K4 table not available; FTS-style semantics):
   * FPOPEN=0 protects the whole block; FPHDIS=0 protects the top 2/4/8/16 KB (FPHS); FPLDIS=0 protects
   * 1/2/4/8 KB (FPLS) starting 32 KB below the block top (global $7F8000 for block 0 = local $8000 of page $FE... ).
   */
  protectedAreas(bank: number): Array<readonly [number, number]> {
    const p = this.s.banks[bank].prot;
    const [lo, top] = this.bankRange(bank);
    if (!(p & 0x80)) return [[lo, top]];
    const out: Array<readonly [number, number]> = [];
    if (!(p & 0x20)) out.push([top - (0x800 << ((p >> 3) & 3)) + 1, top]);
    if (!(p & 0x04)) {
      const base = top - 0x7fff;
      out.push([base, base + (0x400 << (p & 3)) - 1]);
    }
    return out;
  }

  protected protectedRange(bank: number, a: number, b: number): boolean {
    return this.protectedAreas(bank).some(([x, y]) => a <= y && b >= x);
  }

  protected massEraseAllowed(bank: number): boolean {
    return (this.s.banks[bank].prot & 0xa4) === 0xa4;
  }

  /** FSEC.SEC != 10 (and not unsecured by the backdoor key or the BDM blank check). */
  get secured(): boolean {
    if (this.s.unsecuredByKey || this.s.blankUnsecure) return false;
    return (this.s.sec & 0x03) !== 0x02;
  }

  protected writeProt(b: Bank, v: number): void {
    if (this.special()) {
      // BDM / special modes: FPROT writable (NV6 is not).
      b.prot = (b.prot & 0x40) | (v & 0xbf);
      return;
    }
    let p = b.prot;
    // FPOPEN/FPHDIS/FPLDIS only towards the protected state (0); size fields while their range is disabled.
    p &= v | ~0xa4;
    if (b.prot & 0x20) p = (p & ~0x18) | (v & 0x18);
    if (b.prot & 0x04) p = (p & ~0x03) | (v & 0x03);
    b.prot = p;
  }

  protected loadFromArray(): void {
    const ctx = this.ctx;
    const rd = (g: number) => (ctx ? ctx.readGlobal(g) : 0xff);
    const s = this.s;
    s.sec = rd(0x7fff0f);
    s.fctl = rd(0x7fff0e);
    // FPROT of block n from $FF0D - n (FTS256K Table 3-7). UNCERTAIN for FTX512K4 blocks 1-3.
    s.banks.forEach((b, i) => (b.prot = rd(0x7fff0d - i)));
    // BDM firmware: in special single-chip mode a secured part whose flash and EEPROM are erased runs unsecured.
    // UNCERTAIN: modelled only when security is enforced.
    s.blankUnsecure = false;
    if (this.enforceSecurity && this.special() && (s.sec & 3) !== 2 && ctx) {
      let blank = true;
      for (let g = FLASH_ARRAY.start; blank && g <= FLASH_ARRAY.end; g++) if (ctx.readGlobal(g) !== 0xff) blank = false;
      for (let g = EEPROM_ARRAY.start; blank && g <= EEPROM_ARRAY.end; g++) if (ctx.readGlobal(g) !== 0xff) blank = false;
      s.blankUnsecure = blank;
    }
  }

  protected override regValue(off: number): number {
    const s = this.s;
    switch (off) {
      case 1: {
        // SEC forced to 10 after a successful backdoor key access.
        return s.unsecuredByKey ? (s.sec & 0xfc) | 0x02 : s.sec;
      }
      case 2:
        return this.special() ? s.tstmod & 0x30 : 0;
      case 3:
        return s.cnfg & 0xe3;
      case 6:
        return super.regValue(off) & 0x7f;
      case 7:
        return s.fctl;
      default:
        return super.regValue(off);
    }
  }

  protected override writeAllowedInSeq(off: number): boolean {
    return off === 1 || off === 7;
  }

  protected override writeCnfg(v: number): void {
    const s = this.s;
    const wasKey = (s.cnfg & 0x20) !== 0;
    s.cnfg = v & 0xe3;
    if (wasKey && !(v & 0x20)) this.endKeyAccess();
    if (!wasKey && v & 0x20) s.keyWords = [];
  }

  protected override writeOther(off: number, v: number): void {
    // FTSTMOD: WRALL (and MRDS) writable in special modes only.
    if (off === 2 && this.special()) this.s.tstmod = v & 0x30;
  }

  // ---- backdoor key (FSEC.KEYEN = 10, FCNFG.KEYACC = 1, four words to $7FFF00-$7FFF07 in order)

  protected override keyWrite(g: number, w: number): boolean {
    const s = this.s;
    if (!(s.cnfg & 0x20)) return false;
    const n = s.keyWords.length;
    if (g !== 0x7fff00 + 2 * n || n >= 4 || w === 0 || w === 0xffff) s.keyLocked = true;
    s.keyWords.push(w);
    return true;
  }

  private endKeyAccess(): void {
    const s = this.s;
    const ctx = this.ctx;
    const keyen = (s.sec >> 6) & 3;
    if (!s.keyLocked && s.keyWords.length === 4 && keyen === 2 && ctx && !this.special()) {
      const ok = s.keyWords.every((w, i) => w === ((ctx.readGlobal(0x7fff00 + 2 * i) << 8) | ctx.readGlobal(0x7fff01 + 2 * i)));
      if (ok) s.unsecuredByKey = true;
      else s.keyLocked = true;
    }
    s.keyWords = [];
  }
}

// ==================================================================== EEPROM

/** EETX4K: 4 KB, 4-byte sectors, sector modify ($60). */
export class EepromModule extends NvmController {
  readonly name = 'EETX4K';
  readonly base = EEPROM_BASE;
  readonly vector = EEPROM_VECTOR;
  static readonly SECTOR = 4;
  private readonly securedFn: () => boolean;

  constructor(nets: BoardNets, opts: EepromOptions = {}) {
    super(nets, opts, 1);
    this.securedFn = opts.secured ?? (() => false);
  }

  protected bankRange(): readonly [number, number] {
    return [EEPROM_ARRAY.start, EEPROM_ARRAY.end];
  }

  bankOf(g: number): number {
    return g >= EEPROM_ARRAY.start && g <= EEPROM_ARRAY.end ? 0 : -1;
  }

  protected sectorSize(): number {
    return EepromModule.SECTOR;
  }

  protected validCommand(cmd: number): boolean {
    return (
      cmd === C.ERASE_VERIFY ||
      cmd === C.PROGRAM ||
      cmd === C.SECTOR_ERASE ||
      cmd === C.MASS_ERASE ||
      cmd === C.SECTOR_ERASE_ABORT ||
      cmd === C.SECTOR_MODIFY
    );
  }

  protected get selected(): number {
    return 0;
  }

  /** EPOPEN=0: all protected; EPDIS=0: top 64*(EP+1) bytes protected (EETS4K Table 3-3). */
  protectedAreas(): Array<readonly [number, number]> {
    const p = this.s.banks[0].prot;
    if (!(p & 0x80)) return [[EEPROM_ARRAY.start, EEPROM_ARRAY.end]];
    if (p & 0x08) return [];
    return [[EEPROM_ARRAY.end - 64 * ((p & 7) + 1) + 1, EEPROM_ARRAY.end]];
  }

  protected protectedRange(_bank: number, a: number, b: number): boolean {
    return this.protectedAreas().some(([x, y]) => a <= y && b >= x);
  }

  protected massEraseAllowed(): boolean {
    return (this.s.banks[0].prot & 0x88) === 0x88;
  }

  get secured(): boolean {
    return this.securedFn();
  }

  protected writeProt(b: Bank, v: number): void {
    if (this.special()) {
      b.prot = (b.prot & 0x70) | (v & 0x8f);
      return;
    }
    let p = b.prot;
    p &= v | ~0x88;
    if (b.prot & 0x08) p = (p & ~0x07) | (v & 0x07);
    b.prot = p;
  }

  protected loadFromArray(): void {
    // EPROT from the EEPROM protection byte $13FFFD.
    this.s.banks[0].prot = this.ctx ? this.ctx.readGlobal(0x13fffd) : 0xff;
  }

  protected override addrHiMask(): number {
    return 0x07;
  }

  protected override regValue(off: number): number {
    // $111/$112/$117 reserved; ECNFG has only CBEIE/CCIE.
    if (off === 1 || off === 2 || off === 7) return 0;
    return super.regValue(off);
  }
}

/**
 * The `S12XSystem.setRomWriteHandler` callback: routes CPU writes in the flash/EEPROM arrays to the controllers.
 * Returns true (consumed) for every array address handled by one of the modules.
 */
export function createNvmRomWriteHandler(...modules: Array<{ arrayWrite(g: number, v: number): boolean }>): (g: number, v: number) => boolean {
  return (g, v) => {
    for (const m of modules) if (m.arrayWrite(g, v)) return true;
    return false;
  };
}
