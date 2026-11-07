/**
 * MC9S12XDP512 full-chip model: an `S12XSystem` with every peripheral model registered on its register block and
 * wired to the shared `BoardNets` (PinNet / SpiBus / AnalogBus / PwmBus), optionally with the ME305 board on the
 * same nets.
 *
 *   const mcu = createMc9s12xdp512({ board: 'me305' });
 *   mcu.loadAbs(absBytes);           // ELF PT_LOAD + power-on reset (the CRG reads FCTL from the loaded flash)
 *   mcu.runSeconds(3.5);              // simulated time
 *   mcu.board!.lcd.lines;             // ['<LCD line 1>', '<LCD line 2>']
 *
 * Wiring done here (each module's header documents the hook it needs):
 * - `PinNet.now` = the exact bus time of the access/tick being dispatched (or the CPU cycle count between
 *   instructions), taken from a register-less "glue" peripheral's context, so pin edges carry exact cycles.
 * - `PinNet.syncHook` brings every peripheral to that time before an external (board/UI) pin change;
 *   `PinNet.rescheduleHook` recomputes every peripheral's next event afterwards.
 * - XINT `onVectorTaken` -> `Mebi.vectorTaken` (IRQ edge latch cleared by the vector fetch, `irqEdgeClear:'vector'`).
 * - Mode getters (`() => sys.bus.opts.mode`) for the CRG/MEBI/ECT write-once rules; flash `specialMode` from MODE.
 * - PIM MODRR -> SPI pin routing; SPI/SCI input pins (MISO, RXD...) disconnect the GPIO output driver
 *   (`Pim.setPeripheralInputs`); ATD DIEN -> PIM port-AD digital input enables.
 * - CPU writes to the flash/EEPROM arrays -> FTX512K4/EETX4K command controllers (`createNvmRomWriteHandler`).
 * - ME305 board clock = the system's exact cycle->seconds mapping; board timers fire inside `run()`.
 * Finally the system is power-on reset (addPeripheral does not reset).
 */
import { ME305 } from '@s12/devices';
import { BoardScheduler } from './board/clock.js';
import { createMe305Board, type Me305BoardModel, type Me305BoardOptions } from './board/me305/index.js';
import type { LoadResult, SrecLoadOptions } from './loader.js';
import { createBoardNets, type BoardNets } from './pins.js';
import { ATD_RANGES, AtdModule, type AtdOptions } from './periph/atd.js';
import { Crg, CRG_RANGE, type CrgOptions } from './periph/crg.js';
import { ECT_RANGE, EctModule, type EctOptions } from './periph/ect.js';
import { IIC_RANGES, IicModule } from './periph/iic.js';
import { Mebi, MEBI_RANGES, type MebiOptions } from './periph/mebi.js';
import {
  CAN_RANGES,
  CanStub,
  DBG_RANGE,
  DbgModule,
  VREG_RANGE,
  VregModule,
  XGATE_RANGE,
  XgateStub,
  type DbgOptions,
  type VregOptions,
} from './periph/misc.js';
import { createNvmRomWriteHandler, EEPROM_RANGE, EepromModule, FLASH_RANGE, FlashModule, type NvmOptions } from './periph/nvm.js';
import { Pim, PIM_RANGE } from './periph/pim.js';
import { PIT_RANGE, PitModule } from './periph/pit.js';
import { PWM_RANGE, PwmModule } from './periph/pwm.js';
import { SCI_RANGES, SciModule, type SciIndex } from './periph/sci.js';
import { SPI_RANGES, SpiModule, type SpiIndex } from './periph/spi.js';
import { S12XSystem, type SystemOptions } from './system.js';
import type { HaltReason, Peripheral, PeripheralContext, RamInit, RegisterRange } from './types.js';

export interface Mc9s12xdp512Options extends Omit<SystemOptions, 'oscHz' | 'ramInit' | 'ramSeed'> {
  /** Oscillator (Hz). Default 16 MHz (ME305, UNCERTAIN: inferred from the library's PLL/delay math). */
  oscHz?: number;
  /** Board on the nets: 'me305' (default) or 'none' (bare MCU; pins float / pulls only). */
  board?: 'me305' | 'none';
  /** ME305 board model options (the board clock is always wired to the system). */
  boardOptions?: Omit<Me305BoardOptions, 'clock'>;
  ramInit?: RamInit;
  ramSeed?: number;
  /** Use these nets instead of fresh ones (e.g. a board model built elsewhere). */
  nets?: BoardNets;
  /** Per-module options (mode getters, pin hooks and indices are set here and override these). */
  crg?: Omit<CrgOptions, 'mode'>;
  mebi?: Omit<MebiOptions, 'mode'>;
  ect?: Omit<EctOptions, 'mode' | 'onPinsChanged'>;
  atd?: [Omit<AtdOptions, 'index'>?, Omit<AtdOptions, 'index'>?];
  nvm?: Omit<NvmOptions, 'specialMode'>;
  vreg?: VregOptions;
  dbg?: DbgOptions;
  /** SCI: a bare SCIDRL write is ignored (true) or accepted with a warning (false, default). */
  sciStrictTdreSequence?: boolean;
}

export interface Mc9s12xdp512Peripherals {
  crg: Crg;
  mebi: Mebi;
  pim: Pim;
  ect: EctModule;
  pit: PitModule;
  spi0: SpiModule;
  spi1: SpiModule;
  spi2: SpiModule;
  sci0: SciModule;
  sci1: SciModule;
  sci2: SciModule;
  sci3: SciModule;
  sci4: SciModule;
  sci5: SciModule;
  iic0: IicModule;
  iic1: IicModule;
  atd0: AtdModule;
  atd1: AtdModule;
  pwm: PwmModule;
  flash: FlashModule;
  eeprom: EepromModule;
  vreg: VregModule;
  dbg: DbgModule;
  xgate: XgateStub;
  can: readonly CanStub[];
}

export interface Mc9s12xdp512 {
  readonly system: S12XSystem;
  readonly nets: BoardNets;
  readonly periph: Mc9s12xdp512Peripherals;
  /** The ME305 board model (null with board 'none'). */
  readonly board: Me305BoardModel | null;
  /** Every registered peripheral with its register ranges (registration order). */
  readonly registry: ReadonlyArray<{ peripheral: Peripheral; ranges: readonly RegisterRange[] }>;
  /** Exact current bus time (access cycle during a register access/tick, else the CPU cycle count). */
  now(): number;
  /** Bring every peripheral (and the board timers) up to `now()`. */
  syncAll(): void;
  /** Recompute every peripheral's next event (after changing peripheral state from outside the CPU loop). */
  rescheduleAll(): void;
  /** Load an `.abs` and power-on reset (so the CRG sees the loaded FCTL byte and the CPU the loaded vector). */
  loadAbs(abs: Uint8Array, opts?: { reset?: boolean }): LoadResult;
  loadSrec(text: string | Uint8Array, opts?: SrecLoadOptions & { reset?: boolean }): LoadResult;
  /**
   * Run until `seconds` more of simulated time have elapsed (bus-clock changes honoured) or the CPU halts for
   * another reason (breakpoint, BGND, stop...). Returns the last halt reason ('limit' when the time was reached).
   */
  runSeconds(seconds: number): HaltReason;
  /** Run until simulated time reaches `t` seconds (absolute, `system.simTimeSeconds`). */
  runUntilSeconds(t: number): HaltReason;
  /**
   * Call `fn(cycle)` from inside `run()` once simulated time reaches `t` seconds (absolute). Fires at the first bus
   * cycle whose time is >= t (bus-clock changes honoured). Returns a cancel function.
   */
  atSeconds(t: number, fn: (cycle: number) => void): () => void;
  /** `atSeconds(t, () => system.requestHalt())`: a run (also a debugger `go`) stops with reason 'halt' at time t. */
  haltAtSeconds(t: number): () => void;
  /** Detach the board and the modules' PinNet listeners (for shared nets). */
  dispose(): void;
}

/** Register a peripheral and capture its context (the bus keeps per-peripheral contexts private). */
function register(sys: S12XSystem, p: Peripheral, ranges: readonly RegisterRange[], ctxs: PeripheralContext[]): void {
  const own = Object.prototype.hasOwnProperty.call(p, 'attach');
  const orig = p.attach;
  (p as { attach?: (c: PeripheralContext) => void }).attach = (c: PeripheralContext) => {
    ctxs.push(c);
    orig?.call(p, c);
  };
  try {
    sys.addPeripheral(p, ranges);
  } finally {
    if (own) (p as { attach?: unknown }).attach = orig;
    else delete (p as { attach?: unknown }).attach;
  }
}

/** Register-less peripheral whose context gives `PinNet.now` the bus's exact dispatch time. */
function glue(): Peripheral & { ctx: PeripheralContext | null } {
  return {
    name: 'MCU glue',
    ctx: null,
    attach(c) {
      this.ctx = c;
    },
    reset() {},
    read: () => 0xff,
    write: () => {},
  };
}

export function createMc9s12xdp512(opts: Mc9s12xdp512Options = {}): Mc9s12xdp512 {
  const {
    board: boardKind = 'me305',
    boardOptions,
    nets: givenNets,
    crg: crgOpts,
    mebi: mebiOpts,
    ect: ectOpts,
    atd: atdOpts,
    nvm: nvmOpts,
    vreg: vregOpts,
    dbg: dbgOpts,
    sciStrictTdreSequence,
    ...sysOpts
  } = opts;
  const sys = new S12XSystem({ ...sysOpts, oscHz: opts.oscHz ?? ME305.oscillatorHz });
  const nets = givenNets ?? createBoardNets();
  const ctxs: PeripheralContext[] = [];
  const registry: Array<{ peripheral: Peripheral; ranges: readonly RegisterRange[] }> = [];
  const add = <P extends Peripheral>(p: P, ranges: readonly RegisterRange[]): P => {
    register(sys, p, ranges, ctxs);
    registry.push({ peripheral: p, ranges });
    return p;
  };
  const mode = () => sys.bus.opts.mode;

  // ---- time / sync glue (first, so `now` is valid while the other modules attach)
  const g = add(glue(), []);
  const now = () => (g.ctx ? g.ctx.now : sys.totalCycles);
  const syncAll = () => sys.bus.syncAll(now());
  const rescheduleAll = () => {
    for (const c of ctxs) c.reschedule();
  };
  nets.pins.now = now;
  nets.pins.syncHook = syncAll;
  nets.pins.rescheduleHook = rescheduleAll;

  // ---- late-bound cross references (constructed below)
  let pim!: Pim;
  let atd0!: AtdModule;
  let atd1!: AtdModule;
  const spis: SpiModule[] = [];
  const scis: SciModule[] = [];

  /** Input pins the SPI/SCI modules use: the GPIO output driver is disconnected from them. */
  const updateInputs = (): void => {
    if (!pim) return;
    for (const s of spis) pim.setPeripheralInputs(s.name, s.claimedPins().filter((c) => c.dir === 'in').map((c) => c.pin));
    for (const s of scis) pim.setPeripheralInputs(s.name, s.claimedPins().filter((c) => c.dir === 'in').map((c) => c.pin));
  };

  // ---- core / clocks / ports
  const crg = add(new Crg({ ...crgOpts, mode }), [CRG_RANGE]);
  const mebi = add(new Mebi(nets, { irqEdgeClear: 'vector', ...mebiOpts, mode }), MEBI_RANGES);
  const prevVec = sys.bus.xint.onVectorTaken;
  sys.bus.xint.onVectorTaken = (o) => {
    prevVec?.(o);
    mebi.vectorTaken(o);
  };
  const dienOf = (a: AtdModule | undefined): number => {
    if (!a) return 0;
    let m = 0;
    for (let ch = 0; ch < a.channels; ch++) if (a.digitalInputEnabled(ch)) m |= 1 << ch;
    return m;
  };
  pim = add(
    new Pim(nets, {
      // ATD0 IEN7-0 -> PAD00-07, ATD1 IEN15-0 -> PAD08-23.
      atdDien: () => dienOf(atd0) | (dienOf(atd1) << 8),
      onModrrChange: () => {
        for (const s of spis) s.routingChanged();
      },
    }),
    [PIM_RANGE],
  );

  // ---- timers
  const ect = add(new EctModule(nets, { ...ectOpts, mode }), [ECT_RANGE]);
  const pit = add(new PitModule(nets), [PIT_RANGE]);

  // ---- serial
  for (const i of [0, 1, 2] as SpiIndex[]) {
    spis.push(add(new SpiModule(nets, { index: i, modrr: () => pim.modrr, onPinsChanged: updateInputs }), [SPI_RANGES[i]]));
  }
  for (const i of [0, 1, 2, 3, 4, 5] as SciIndex[]) {
    scis.push(
      add(new SciModule(nets, { index: i, strictTdreSequence: sciStrictTdreSequence, onPinsChanged: updateInputs }), [SCI_RANGES[i]]),
    );
  }
  const iic0 = add(new IicModule(nets, { index: 0 }), [IIC_RANGES[0]]);
  const iic1 = add(new IicModule(nets, { index: 1 }), [IIC_RANGES[1]]);

  // ---- analog / PWM
  atd0 = add(new AtdModule(nets, { ...atdOpts?.[0], index: 0 }), [ATD_RANGES[0]]);
  atd1 = add(new AtdModule(nets, { ...atdOpts?.[1], index: 1 }), [ATD_RANGES[1]]);
  const pwm = add(new PwmModule(nets), [PWM_RANGE]);

  // ---- NVM
  const flash = add(new FlashModule(nets, { ...nvmOpts, specialMode: () => (sys.bus.modeReg & 0x80) === 0 }), [FLASH_RANGE]);
  const eeprom = add(new EepromModule(nets, { ...nvmOpts, specialMode: () => (sys.bus.modeReg & 0x80) === 0, secured: () => flash.secured }), [
    EEPROM_RANGE,
  ]);
  sys.setRomWriteHandler(createNvmRomWriteHandler(flash, eeprom));

  // ---- misc / stubs
  const vreg = add(new VregModule(vregOpts), [VREG_RANGE]);
  const dbg = add(new DbgModule(dbgOpts), [DBG_RANGE]);
  const xgate = add(new XgateStub(), [XGATE_RANGE]);
  const can = [0, 1, 2, 3, 4].map((i) => add(new CanStub(i), [CAN_RANGES[i]]));

  // ---- board
  let board: Me305BoardModel | null = null;
  if (boardKind === 'me305') {
    board = createMe305Board(nets, {
      ...boardOptions,
      clock: { busHz: () => sys.busHz, seconds: (c) => sys.bus.seconds(c), now },
    });
    add(board.peripheral, []);
  }

  // ---- simulated-time alarms (not cleared by MCU resets)
  const alarms = new BoardScheduler();
  add(alarms.asPeripheral('MCU alarms'), []);
  const atSeconds = (t: number, fn: (cycle: number) => void): (() => void) => {
    let cancel: () => void = () => {};
    let cancelled = false;
    const arm = () => {
      const from = now();
      const left = t - sys.bus.seconds(from);
      cancel = alarms.at(from + Math.max(0, Math.ceil(left * sys.busHz - 1e-6)), (cycle) => {
        if (cancelled) return;
        if (sys.bus.seconds(cycle) + 1e-12 < t) arm(); // the bus clock slowed down since: re-arm
        else fn(cycle);
      });
    };
    arm();
    return () => {
      cancelled = true;
      cancel();
    };
  };

  updateInputs();
  sys.reset('power-on');
  sys.bus.eventLog.length = 0;

  const periph: Mc9s12xdp512Peripherals = {
    crg,
    mebi,
    pim,
    ect,
    pit,
    spi0: spis[0],
    spi1: spis[1],
    spi2: spis[2],
    sci0: scis[0],
    sci1: scis[1],
    sci2: scis[2],
    sci3: scis[3],
    sci4: scis[4],
    sci5: scis[5],
    iic0,
    iic1,
    atd0,
    atd1,
    pwm,
    flash,
    eeprom,
    vreg,
    dbg,
    xgate,
    can,
  };

  const runUntilSeconds = (t: number): HaltReason => {
    let r: HaltReason = 'limit';
    for (;;) {
      const left = t - sys.simTimeSeconds;
      if (left <= 0) return 'limit';
      // At most 50 ms per slice so a bus-clock change (PLL engage) is honoured promptly.
      const cycles = Math.max(1, Math.ceil(Math.min(left, 0.05) * sys.busHz));
      r = sys.run(cycles);
      if (r !== 'limit') return r;
    }
  };

  return {
    system: sys,
    nets,
    periph,
    board,
    registry,
    now,
    syncAll,
    rescheduleAll,
    loadAbs(abs, o = {}) {
      const r = sys.loadAbs(abs);
      if (o.reset !== false) sys.reset('power-on');
      return r;
    },
    loadSrec(text, o = {}) {
      const r = sys.loadSrec(text, o);
      if (o.reset !== false) sys.reset('power-on');
      return r;
    },
    runSeconds: (s) => runUntilSeconds(sys.simTimeSeconds + s),
    runUntilSeconds,
    atSeconds,
    haltAtSeconds: (t) => atSeconds(t, () => sys.requestHalt()),
    dispose() {
      alarms.clear();
      board?.dispose();
      ect.dispose();
      mebi.dispose();
      pim.dispose();
      if (sys.bus.xint.onVectorTaken) sys.bus.xint.onVectorTaken = prevVec;
      nets.pins.now = () => 0;
      nets.pins.syncHook = () => {};
      nets.pins.rescheduleHook = () => {};
    },
  };
}
