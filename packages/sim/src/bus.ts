/**
 * System bus: S12X MMC (local -> global, page registers), the register block dispatcher with the
 * peripheral registry, the event-driven peripheral scheduler, watchpoints, access tracing and the
 * structured warning-event log. The CPU reads RAM/flash directly through the shared block maps
 * (`rmap`/`wmap`/`fmap`) and only calls into the bus for the slow path (registers, ROM writes,
 * unimplemented addresses, watched/traced blocks).
 */
import { MMC_RESET, localToGlobal, registerByAddress, type DeviceDescription } from '@s12/devices';
import { InterruptController } from './interrupts.js';
import { BLOCK, G_REGS, type Memory } from './memory.js';
import type {
  AccessTracer,
  Peripheral,
  PeripheralContext,
  RegisterRange,
  ResetCause,
  SimEvent,
  WatchHit,
  WatchpointSpec,
} from './types.js';

/** Thrown (by identity) from a CPU access to an unimplemented global address; caught by the run loop. */
export const ILLEGAL_ACCESS: { readonly illegal: true } = Object.freeze({ illegal: true as const });

export interface IllegalAccessInfo {
  global: number;
  local: number;
  access: 'read' | 'write' | 'fetch';
  pc: number;
  cycle: number;
}

/** The CPU-side state the bus needs (implemented by Cpu). */
export interface BusClient {
  cycles: number;
  /** Start address of the executing instruction. */
  ipc: number;
  /** Mirror of the DIRECT register. */
  direct: number;
  /** Recompute the run-loop deadline after the scheduler changed `nextEvent`. */
  scheduleChanged(): void;
  /** An interrupt line was asserted / a reset requested: look at it at the next boundary. */
  wake(): void;
  /** A watchpoint matched: halt after the current instruction. */
  watchHit(hit: WatchHit): void;
  /** A peripheral requested a reset. */
  requestReset(cause: ResetCause): void;
}

interface Watch {
  start: number;
  end: number;
  read: boolean;
  write: boolean;
  id: number;
}

/** MMC registers handled by the core. */
const R_MMCCTL0 = 0x0a;
const R_MODE = 0x0b;
const R_GPAGE = 0x10;
const R_DIRECT = 0x11;
const R_MMCCTL1 = 0x13;
const R_RPAGE = 0x16;
const R_EPAGE = 0x17;
const R_PARTIDH = 0x1a;
const R_PARTIDL = 0x1b;
const R_PPAGE = 0x30;

export interface BusOptions {
  /** 'special' single-chip (default; write-once registers stay writable, as under a BDM debugger) or 'normal'. */
  mode: 'special' | 'normal';
  /** Unclaimed registers behave as RAM initialised with the device reset value (default) or read 0. */
  unimplementedRegisters: 'ram' | 'zero';
  /** Warn once per address (default) or on every access to an unimplemented register. */
  warnEveryAccess: boolean;
  /** Emit 'uninitialized-read' events for CPU reads of never-written RAM (slower: RAM goes through the slow path). */
  warnUninitializedReads: boolean;
}

export class Bus {
  readonly memory: Memory;
  readonly device: DeviceDescription;
  readonly xint = new InterruptController();
  client!: BusClient;

  /** Global base address of each local 1 KB block (current MMC state). */
  readonly lg = new Int32Array(64);
  /** CPU fast-path maps (offset into memory.mem, or -1 = slow path): data reads, data writes, fetches. */
  readonly rmap = new Int32Array(64);
  readonly wmap = new Int32Array(64);
  readonly fmap = new Int32Array(64);

  // MMC state
  gpage = 0;
  direct = 0;
  rpage = MMC_RESET.rpage;
  epage = MMC_RESET.epage;
  ppage = MMC_RESET.ppage;
  mmcctl0 = 0;
  mmcctl1 = 0x05;
  modeReg = 0;
  private directWritten = false;
  private modeWritten = false;
  private partid: number;

  /** RAM-backed register file for registers no peripheral claims. */
  readonly regfile = new Uint8Array(0x800);
  private readonly regReset = new Uint8Array(0x800);
  /** Register address -> peripheral index + 1 (0 = unclaimed). */
  private readonly dispatch = new Uint8Array(0x800);
  readonly peripherals: Peripheral[] = [];
  private readonly ranges: RegisterRange[][] = [];
  private last: number[] = [];
  private due: number[] = [];
  /** Earliest scheduled peripheral event (absolute bus cycle). */
  nextEvent = Infinity;
  /** Time of the access/tick being dispatched (PeripheralContext.now) while `depth` > 0. */
  private cur = 0;
  private depth = 0;

  busHz: number;
  oscHz: number;
  /** Simulated seconds at `timeBaseCycle` (bus clock changes integrate piecewise). */
  private timeBase = 0;
  private timeBaseCycle = 0;

  opts: BusOptions;

  // debug
  private watches: Watch[] = [];
  private watchId = 1;
  tracer: AccessTracer | null = null;
  lastIllegal: IllegalAccessInfo | null = null;
  private listeners: Array<(e: SimEvent) => void> = [];
  private warned = new Set<string>();
  /** Bounded log of the most recent events. */
  readonly eventLog: SimEvent[] = [];
  eventLogLimit = 1000;
  romWriteHandler: ((global: number, value: number) => boolean) | null = null;
  /** Global top (last) byte of each on-chip RAM/EEPROM/register block whose next byte is outside it (C8). */
  private readonly blockTops = new Set<number>();

  constructor(memory: Memory, device: DeviceDescription, oscHz: number, opts: Partial<BusOptions> = {}) {
    this.memory = memory;
    this.device = device;
    this.oscHz = oscHz;
    this.busHz = oscHz / 2;
    this.opts = {
      mode: opts.mode ?? 'special',
      unimplementedRegisters: opts.unimplementedRegisters ?? 'ram',
      warnEveryAccess: opts.warnEveryAccess ?? false,
      warnUninitializedReads: opts.warnUninitializedReads ?? false,
    };
    for (const r of device.registers) {
      for (let i = 0; i < r.size; i++) {
        const a = r.address + i;
        if (a < 0x800) this.regReset[a] = (r.reset >> (8 * (r.size - 1 - i))) & 0xff;
      }
    }
    this.partid = (this.regReset[R_PARTIDH] << 8) | this.regReset[R_PARTIDL];
    for (const r of device.regions) {
      if (r.kind === 'flash') continue;
      const next = device.regions.find((o) => o !== r && o.kind === r.kind && o.globalStart === r.globalEnd + 1);
      if (!next) this.blockTops.add(r.globalEnd);
    }
    this.xint.onXgate = (o) =>
      this.warnOnce(`xgate:${o}`, {
        kind: 'xgate-request',
        message: `interrupt request at vector offset 0x${o.toString(16).toUpperCase()} is routed to XGATE (RQST=1), which is not simulated`,
        data: { vectorOffset: o },
      });
    this.resetMmc();
  }

  // ------------------------------------------------------------------ reset / MMC

  /** Reset MMC, XINT and the unclaimed-register file (peripherals are reset by `resetPeripherals`). */
  resetMmc(): void {
    this.gpage = 0;
    this.direct = 0;
    this.rpage = MMC_RESET.rpage;
    this.epage = MMC_RESET.epage;
    this.ppage = MMC_RESET.ppage;
    this.mmcctl0 = 0;
    // UNCERTAIN: MMCCTL1 single-chip reset ($05: EROMON=1, ROMON=1) from the devices table.
    this.mmcctl1 = this.regReset[R_MMCCTL1];
    // MODE: normal single-chip $80, special single-chip $00 (xdp512-device.md §2.1).
    this.modeReg = this.opts.mode === 'special' ? 0x00 : 0x80;
    this.directWritten = false;
    this.modeWritten = false;
    this.xint.reset();
    if (this.opts.unimplementedRegisters === 'ram') this.regfile.set(this.regReset);
    else this.regfile.fill(0);
    if (this.client) this.client.direct = 0;
    this.remap();
  }

  /** Recompute the local block maps from the page registers and the debug state. */
  remap(from = 0, to = 63): void {
    const mem = this.memory;
    const slowAll = this.tracer !== null;
    const slowRam = this.opts.warnUninitializedReads;
    const pages = { rpage: this.rpage, epage: this.epage, ppage: this.ppage };
    for (let i = from; i <= to; i++) {
      const g = localToGlobal(i * BLOCK, pages);
      this.lg[i] = g;
      const o = mem.gmap[g >>> 10];
      const watched = this.watches.length > 0 && this.watchOverlaps(g, g + BLOCK - 1);
      this.fmap[i] = o >= 0 ? o : -1;
      this.rmap[i] = o >= 0 && !slowAll && !watched && !(slowRam && o < mem.romStart) ? o : -1;
      this.wmap[i] = o >= 0 && o < mem.romStart && !slowAll && !watched ? o : -1;
    }
  }

  /** Local -> global with the current page registers. */
  toGlobal(local: number): number {
    const a = local & 0xffff;
    return this.lg[a >>> 10] + (a & 0x3ff);
  }

  setPpage(v: number): void {
    v &= 0xff;
    if (v === this.ppage) return;
    this.ppage = v;
    this.remap(32, 47);
  }

  // ------------------------------------------------------------------ peripherals

  /** Register a peripheral on register-block ranges (later registrations override earlier ones). */
  addPeripheral(p: Peripheral, ranges: readonly RegisterRange[]): number {
    const idx = this.peripherals.length;
    if (idx >= 255) throw new Error('too many peripherals');
    this.peripherals.push(p);
    this.ranges.push([...ranges]);
    for (const [s, e] of ranges) {
      if (s < 0 || e > 0x7ff || e < s) throw new RangeError(`bad register range ${s}-${e} for ${p.name}`);
      for (let a = s; a <= e; a++) this.dispatch[a] = idx + 1;
    }
    const now = this.client ? this.client.cycles : 0;
    this.last.push(now);
    this.due.push(Infinity);
    p.attach?.(this.makeContext(idx));
    this.resched(idx);
    return idx;
  }

  peripheralAt(addr: number): Peripheral | undefined {
    const i = this.dispatch[addr & 0x7ff];
    return i ? this.peripherals[i - 1] : undefined;
  }

  resetPeripherals(cause: ResetCause): void {
    const now = this.client ? this.client.cycles : 0;
    for (let i = 0; i < this.peripherals.length; i++) {
      this.last[i] = now;
      this.peripherals[i].reset(cause);
    }
    for (let i = 0; i < this.peripherals.length; i++) this.resched(i);
    // CRGINT.ILAF ($0038 bit 6) flags an illegal-address reset; set it here when no CRG model claims it.
    if (cause === 'illegal-address' && !this.dispatch[0x38]) this.regfile[0x38] |= 0x40;
  }

  private makeContext(idx: number): PeripheralContext {
    const bus = this;
    return {
      get now() {
        return bus.depth > 0 ? bus.cur : bus.client ? bus.client.cycles : 0;
      },
      get busHz() {
        return bus.busHz;
      },
      get oscHz() {
        return bus.oscHz;
      },
      requestInterrupt: (o, level) => this.xint.request(o, level),
      clearInterrupt: (o) => this.xint.clear(o),
      setInterrupt: (o, on) => (on ? this.xint.request(o) : this.xint.clear(o)),
      // Inside a register access/tick dispatch, sync to that access's time (same as `now`), not the
      // instruction start.
      sync: () => this.sync(idx, this.depth > 0 ? this.cur : this.client ? this.client.cycles : 0),
      reschedule: () => this.resched(idx),
      requestReset: (cause) => this.client.requestReset(cause),
      setBusClockHz: (hz) => this.setBusClockHz(hz),
      warn: (message, data) =>
        this.emit({ kind: 'peripheral', message, data: { peripheral: this.peripherals[idx].name, ...data } }),
      readGlobal: (g) => {
        const o = this.memory.offsetOf(g);
        return o >= 0 ? this.memory.mem[o] : 0xff;
      },
      writeGlobal: (g, v) => {
        this.memory.load(g, v);
      },
    };
  }

  /** Bring peripheral `i` to time `t`. */
  private sync(i: number, t: number): void {
    const dt = t - this.last[i];
    if (dt > 0) {
      this.last[i] = t;
      const p = this.peripherals[i];
      if (p.tick) {
        const save = this.cur;
        this.cur = t;
        this.depth++;
        try {
          p.tick(dt);
        } finally {
          this.depth--;
          this.cur = save;
        }
      }
    }
  }

  private resched(i: number): void {
    const p = this.peripherals[i];
    this.due[i] = this.last[i] + nextRel(p);
    this.recomputeNext();
  }

  private recomputeNext(): void {
    let m = Infinity;
    const d = this.due;
    for (let i = 0; i < d.length; i++) if (d[i] < m) m = d[i];
    if (m !== this.nextEvent) {
      this.nextEvent = m;
      if (this.client) this.client.scheduleChanged();
    }
  }

  /** Service every peripheral whose deadline is <= now (called at instruction boundaries). */
  service(now: number): void {
    const d = this.due;
    for (let i = 0; i < d.length; i++) {
      if (d[i] <= now) {
        this.sync(i, now);
        d[i] = now + nextRel(this.peripherals[i]);
      }
    }
    this.recomputeNext();
  }

  /** Sync every peripheral to `now` (before a snapshot or a debugger read). */
  syncAll(now: number): void {
    for (let i = 0; i < this.peripherals.length; i++) this.sync(i, now);
  }

  setBusClockHz(hz: number): void {
    // During a register access the change takes effect at the access cycle, not the instruction start.
    const now = this.depth > 0 ? this.cur : this.client ? this.client.cycles : 0;
    this.timeBase += (now - this.timeBaseCycle) / this.busHz;
    this.timeBaseCycle = now;
    this.busHz = hz;
  }

  /** Simulated time in seconds at bus cycle `cycles` (>= the last clock change). */
  seconds(cycles: number): number {
    return this.timeBase + (cycles - this.timeBaseCycle) / this.busHz;
  }

  resetTime(): void {
    this.timeBase = 0;
    this.timeBaseCycle = 0;
  }

  // ------------------------------------------------------------------ CPU slow path

  /** Data read of local address `a` at bus time `t` (slow path). */
  read(a: number, t: number): number {
    return this.readG(this.lg[a >>> 10] + (a & 0x3ff), a, t);
  }

  write(a: number, v: number, t: number): void {
    this.writeG(this.lg[a >>> 10] + (a & 0x3ff), a, v, t);
  }

  /** Instruction fetch that is not in RAM/EEPROM/flash (register space or unimplemented). */
  fetch(a: number): number {
    const g = this.lg[a >>> 10] + (a & 0x3ff);
    if (this.memory.gmap[g >>> 10] === G_REGS) return this.regRead(g & 0x7ff, this.client.cycles);
    return this.illegal(g, a, 'fetch');
  }

  /** CPU data read of a global address (G-instructions, slow local path). */
  readG(g: number, local: number, t: number): number {
    const mem = this.memory;
    const o = mem.gmap[g >>> 10];
    let v: number;
    if (o >= 0) {
      const i = o + (g & 0x3ff);
      v = mem.mem[i];
      if (this.opts.warnUninitializedReads && mem.init[i] === 0) {
        this.warnOnce(`uu:${g}`, {
          kind: 'uninitialized-read',
          message: `reading uninitialized memory at 0x${hex(local, 4)} (global 0x${hex(g, 6)})`,
          address: local,
          global: g,
          access: 'read',
        });
      }
    } else if (o === G_REGS) {
      v = this.regRead(g & 0x7ff, t);
    } else {
      return this.illegal(g, local, 'read');
    }
    if (this.watches.length) this.checkWatch(g, local, 'read', v, t);
    if (this.tracer) this.tracer('read', local, g, v, t);
    return v;
  }

  writeG(g: number, local: number, v: number, t: number): void {
    const mem = this.memory;
    const o = mem.gmap[g >>> 10];
    if (o >= 0) {
      const i = o + (g & 0x3ff);
      if (o < mem.romStart) {
        mem.mem[i] = v;
        mem.init[i] = 1;
      } else if (!this.romWriteHandler || !this.romWriteHandler(g, v)) {
        // UNCERTAIN: normal CPU writes to the flash/EEPROM array are ignored (they only latch data for
        // the FCMD/ECMD state machines, not modelled yet).
        this.warnOnce(`rom:${g}`, {
          kind: 'rom-write',
          message: `write of 0x${hex(v, 2)} to read-only ${mem.regionOf(g)?.region.name ?? 'memory'} at 0x${hex(local, 4)} (global 0x${hex(g, 6)}) ignored`,
          address: local,
          global: g,
          access: 'write',
          value: v,
        });
      }
    } else if (o === G_REGS) {
      this.regWrite(g & 0x7ff, v, t);
    } else {
      this.illegal(g, local, 'write');
      return;
    }
    if (this.watches.length) this.checkWatch(g, local, 'write', v, t);
    if (this.tracer) this.tracer('write', local, g, v, t);
  }

  /**
   * C8: in single-chip modes a CPU word access whose first byte is the top address of an on-chip RAM,
   * EEPROM or register block (flash excepted) causes an illegal access reset. Called by the CPU for word
   * accesses at local/global addresses ending in $3FF (all block tops are 1 KB aligned); `g` < 0 means
   * "translate `local` through the MMC". BDM/debugger accesses (peek/poke) are exempt.
   * UNCERTAIN: no reset happens before either byte is transferred; wording of the event.
   */
  misalignedWord(local: number, g: number, access: 'read' | 'write'): void {
    if (g < 0) g = this.lg[local >>> 10] + (local & 0x3ff);
    if (this.blockTops.has(g)) this.illegal(g, local, access, 'misaligned word ');
  }

  private illegal(g: number, local: number, access: 'read' | 'write' | 'fetch', what = ''): never {
    const c = this.client;
    this.lastIllegal = { global: g, local, access, pc: c.ipc, cycle: c.cycles };
    this.emit({
      kind: 'illegal-access',
      message: what
        ? `illegal access reset: ${what}${access} at top address 0x${hex(local, 4)} (global 0x${hex(g, 6)}) of an on-chip block at PC=0x${hex(c.ipc, 4)}`
        : `illegal access reset: ${access} of unimplemented address 0x${hex(local, 4)} (global 0x${hex(g, 6)}) at PC=0x${hex(c.ipc, 4)}`,
      address: local,
      global: g,
      access,
    });
    throw ILLEGAL_ACCESS;
  }

  // ------------------------------------------------------------------ register block

  regRead(addr: number, t: number): number {
    const pi = this.dispatch[addr];
    if (pi !== 0) {
      const i = pi - 1;
      this.sync(i, t);
      const save = this.cur;
      this.cur = t;
      this.depth++;
      let v: number;
      try {
        v = this.peripherals[i].read(addr) & 0xff;
      } finally {
        this.depth--;
        this.cur = save;
      }
      this.resched(i);
      return v;
    }
    const core = this.coreRead(addr);
    if (core >= 0) return core;
    this.unimplemented(addr, 'read');
    return this.regfile[addr];
  }

  regWrite(addr: number, v: number, t: number): void {
    const pi = this.dispatch[addr];
    if (pi !== 0) {
      const i = pi - 1;
      this.sync(i, t);
      const save = this.cur;
      this.cur = t;
      this.depth++;
      try {
        this.peripherals[i].write(addr, v & 0xff);
      } finally {
        this.depth--;
        this.cur = save;
      }
      this.resched(i);
      return;
    }
    if (this.coreWrite(addr, v)) return;
    this.unimplemented(addr, 'write');
    if (this.opts.unimplementedRegisters === 'ram') this.regfile[addr] = v;
  }

  /** Side-effect-free register read for the debugger. */
  regPeek(addr: number): number {
    const pi = this.dispatch[addr];
    if (pi !== 0) {
      const p = this.peripherals[pi - 1];
      this.sync(pi - 1, this.client ? this.client.cycles : 0);
      return (p.peek ? p.peek(addr) : p.read(addr)) & 0xff;
    }
    const core = this.coreRead(addr);
    return core >= 0 ? core : this.regfile[addr];
  }

  /** Debugger register write (as the CPU would, but no warnings). */
  regPoke(addr: number, v: number): void {
    const pi = this.dispatch[addr];
    if (pi !== 0) {
      const now = this.client ? this.client.cycles : 0;
      this.sync(pi - 1, now);
      const save = this.cur;
      this.cur = now;
      this.depth++;
      try {
        this.peripherals[pi - 1].write(addr, v & 0xff);
      } finally {
        this.depth--;
        this.cur = save;
      }
      this.resched(pi - 1);
    } else if (!this.coreWrite(addr, v)) this.regfile[addr] = v & 0xff;
  }

  private coreRead(addr: number): number {
    switch (addr) {
      case R_MMCCTL0:
        return this.mmcctl0;
      case R_MODE:
        return this.modeReg;
      case R_GPAGE:
        return this.gpage;
      case R_DIRECT:
        return this.direct;
      case R_MMCCTL1:
        return this.mmcctl1;
      case R_RPAGE:
        return this.rpage;
      case R_EPAGE:
        return this.epage;
      case R_PPAGE:
        return this.ppage;
      case R_PARTIDH:
        return this.partid >> 8;
      case R_PARTIDL:
        return this.partid & 0xff;
    }
    if (this.xint.ownsRegister(addr)) return this.xint.readRegister(addr);
    return -1;
  }

  private coreWrite(addr: number, v: number): boolean {
    v &= 0xff;
    const special = this.opts.mode === 'special';
    switch (addr) {
      case R_MMCCTL0:
        this.mmcctl0 = v & 0x0f;
        return true;
      case R_MODE:
        if (special || !this.modeWritten) this.modeReg = v & 0xe0;
        this.modeWritten = true;
        return true;
      case R_GPAGE:
        this.gpage = v & 0x7f;
        return true;
      case R_DIRECT:
        // Write-once in normal modes, anytime in special modes.
        if (special || !this.directWritten) {
          this.direct = v;
          if (this.client) this.client.direct = v;
        }
        this.directWritten = true;
        return true;
      case R_MMCCTL1:
        // UNCERTAIN: ROMHM/ROMON/EROMON mapping changes are not modelled (value is only stored).
        this.mmcctl1 = v & 0x07;
        return true;
      case R_RPAGE:
        this.rpage = v;
        this.remap(4, 7);
        return true;
      case R_EPAGE:
        this.epage = v;
        this.remap(2, 2);
        return true;
      case R_PPAGE:
        this.setPpage(v);
        return true;
      case R_PARTIDH:
      case R_PARTIDL:
        return true; // read-only
    }
    if (this.xint.ownsRegister(addr)) {
      this.xint.writeRegister(addr, v);
      return true;
    }
    return false;
  }

  private unimplemented(addr: number, access: 'read' | 'write'): void {
    const key = `ur:${access}:${addr}`;
    if (!this.opts.warnEveryAccess && this.warned.has(key)) return;
    this.warned.add(key);
    const reg = registerByAddress(addr, this.device);
    // UNCERTAIN: exact hiwave wording/IDs; ID 12 is the read warning quoted in the task, 13 assumed for writes.
    const id = access === 'read' ? 12 : 13;
    const verb = access === 'read' ? 'reading from' : 'writing to';
    this.emit({
      kind: 'unimplemented-register',
      message: `FCS Warning (ID ${id}): ${verb} unimplemented register 0x${hex(addr, 4)}${reg ? ` (${reg.name})` : ''}`,
      address: addr,
      global: addr,
      access,
      register: reg?.name,
    });
  }

  // ------------------------------------------------------------------ watchpoints / tracing

  addWatchpoint(spec: WatchpointSpec): number {
    const id = this.watchId++;
    const read = spec.kind !== 'write';
    const write = spec.kind !== 'read';
    if (spec.space === 'local') {
      // Split into global runs (a local range may cross window boundaries).
      let runStart = -1;
      let prev = -2;
      for (let a = spec.start; a <= spec.end; a++) {
        const g = this.toGlobal(a);
        if (g !== prev + 1) {
          if (runStart >= 0) this.watches.push({ start: runStart, end: prev, read, write, id });
          runStart = g;
        }
        prev = g;
      }
      if (runStart >= 0) this.watches.push({ start: runStart, end: prev, read, write, id });
    } else {
      this.watches.push({ start: spec.start, end: spec.end, read, write, id });
    }
    this.remap();
    return id;
  }

  removeWatchpoint(id: number): boolean {
    const n = this.watches.length;
    this.watches = this.watches.filter((w) => w.id !== id);
    this.remap();
    return this.watches.length !== n;
  }

  clearWatchpoints(): void {
    this.watches = [];
    this.remap();
  }

  private watchOverlaps(s: number, e: number): boolean {
    for (const w of this.watches) if (w.start <= e && w.end >= s) return true;
    return false;
  }

  private checkWatch(g: number, local: number, access: 'read' | 'write', v: number, t: number): void {
    for (const w of this.watches) {
      if (g < w.start || g > w.end) continue;
      if (access === 'read' ? !w.read : !w.write) continue;
      this.client.watchHit({ global: g, local, access, value: v, pc: this.client.ipc, cycle: t });
      return;
    }
  }

  setTracer(t: AccessTracer | null): void {
    this.tracer = t;
    this.remap();
  }

  // ------------------------------------------------------------------ events

  onEvent(fn: (e: SimEvent) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((f) => f !== fn);
    };
  }

  emit(e: Omit<SimEvent, 'cycle' | 'pc'> & Partial<Pick<SimEvent, 'cycle' | 'pc'>>): void {
    const ev: SimEvent = {
      ...e,
      cycle: e.cycle ?? (this.client ? this.client.cycles : 0),
      pc: e.pc ?? (this.client ? this.client.ipc : 0),
    } as SimEvent;
    this.eventLog.push(ev);
    if (this.eventLog.length > this.eventLogLimit) this.eventLog.splice(0, this.eventLog.length - this.eventLogLimit);
    for (const l of this.listeners) l(ev);
  }

  warnOnce(key: string, e: Omit<SimEvent, 'cycle' | 'pc'>): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.emit(e);
  }

  /** Forget which warnings were already reported (on reset). */
  clearWarnings(): void {
    this.warned.clear();
  }

  // ------------------------------------------------------------------ snapshot

  snapshot(): BusState {
    return {
      gpage: this.gpage,
      direct: this.direct,
      rpage: this.rpage,
      epage: this.epage,
      ppage: this.ppage,
      mmcctl0: this.mmcctl0,
      mmcctl1: this.mmcctl1,
      modeReg: this.modeReg,
      directWritten: this.directWritten,
      modeWritten: this.modeWritten,
      regfile: this.regfile.slice(),
      xint: this.xint.snapshot(),
      last: [...this.last],
      due: [...this.due],
      peripherals: this.peripherals.map((p) => (p.snapshot ? p.snapshot() : undefined)),
      busHz: this.busHz,
      timeBase: this.timeBase,
      timeBaseCycle: this.timeBaseCycle,
      mem: this.memory.mem.slice(),
      init: this.memory.init.slice(),
    };
  }

  restore(s: BusState): void {
    this.gpage = s.gpage;
    this.direct = s.direct;
    this.rpage = s.rpage;
    this.epage = s.epage;
    this.ppage = s.ppage;
    this.mmcctl0 = s.mmcctl0;
    this.mmcctl1 = s.mmcctl1;
    this.modeReg = s.modeReg;
    this.directWritten = s.directWritten;
    this.modeWritten = s.modeWritten;
    this.regfile.set(s.regfile);
    this.xint.restore(s.xint);
    this.busHz = s.busHz;
    this.timeBase = s.timeBase;
    this.timeBaseCycle = s.timeBaseCycle;
    this.memory.mem.set(s.mem);
    this.memory.init.set(s.init);
    s.peripherals.forEach((st, i) => {
      const p = this.peripherals[i];
      if (p && p.restore && st !== undefined) p.restore(st);
    });
    this.last = [...s.last];
    this.due = [...s.due];
    this.remap();
    this.nextEvent = NaN; // force recompute + notify
    this.recomputeNext();
  }
}

export interface BusState {
  gpage: number;
  direct: number;
  rpage: number;
  epage: number;
  ppage: number;
  mmcctl0: number;
  mmcctl1: number;
  modeReg: number;
  directWritten: boolean;
  modeWritten: boolean;
  regfile: Uint8Array;
  xint: ReturnType<InterruptController['snapshot']>;
  last: number[];
  due: number[];
  peripherals: unknown[];
  busHz: number;
  timeBase: number;
  timeBaseCycle: number;
  mem: Uint8Array;
  init: Uint8Array;
}

/** Relative deadline of a peripheral, at least 1 cycle (Infinity = idle). */
function nextRel(p: Peripheral): number {
  if (!p.nextEventCycles) return Infinity;
  const n = p.nextEventCycles();
  if (n === Infinity) return Infinity;
  return n >= 1 ? Math.ceil(n) : 1;
}

export function hex(v: number, digits: number): string {
  return (v >>> 0).toString(16).toUpperCase().padStart(digits, '0');
}

