/**
 * SimTarget factories over the fully wired MC9S12XDP512 model (+ ME3305 board) from @s12/sim: the hiwave
 * "Full Chip Simulation" connection for real programs (no fakes).
 *
 *   const { target, mcu } = createMcuSimTarget({ mcu: { board: 'me3305' } });
 *   await target.load({ kind: 'abs', data });   // load + reset
 *   mcu.board!.keypad.tap('F1', 0.08);           // board stimulus (call while halted, or between slices)
 *   await runForSeconds(target, mcu, 3.5);       // go, halt at a simulated time
 *
 * SimTarget resets with its `resetCause` option (default 'external', RAM kept). The CRG reloads COPCTL from the FCTL
 * flash byte on every reset, so a load + reset sees the loaded image as on hardware.
 */
import { createMc9s12xdp512, type Mc9s12xdp512, type Mc9s12xdp512Options, type S12XSystem } from '@s12/sim';
import { SimTarget, type SimTargetOptions } from './sim-target';
import type { HaltInfo } from './target';

export interface McuSystemFactory {
  /** Pass as `SimTargetOptions.createSystem`. Each call builds a new MCU (and board). */
  createSystem: () => S12XSystem;
  /** The MCU built by the last `createSystem()` call (null before the first). */
  readonly mcu: Mc9s12xdp512 | null;
}

/** A `createSystem` for SimTarget that builds the full MCU model and remembers it (board access, alarms...). */
export function mcuSystemFactory(opts: Mc9s12xdp512Options = {}, onCreate?: (mcu: Mc9s12xdp512) => void): McuSystemFactory {
  let last: Mc9s12xdp512 | null = null;
  return {
    createSystem: () => {
      last?.dispose();
      last = createMc9s12xdp512(opts);
      onCreate?.(last);
      return last.system;
    },
    get mcu() {
      return last;
    },
  };
}

export interface McuSimTargetOptions {
  /** MCU/board model options (default: ME3305 board, 16 MHz oscillator). */
  mcu?: Mc9s12xdp512Options;
  /** SimTarget options (pacing, slices, reset cause...). */
  target?: Omit<SimTargetOptions, 'createSystem'>;
}

/** SimTarget on the full MC9S12XDP512 + ME3305 model. */
export function createMcuSimTarget(opts: McuSimTargetOptions = {}): { target: SimTarget; mcu: Mc9s12xdp512 } {
  const f = mcuSystemFactory(opts.mcu);
  const target = new SimTarget({ ...opts.target, createSystem: f.createSystem });
  return { target, mcu: f.mcu! };
}

/**
 * Run the target (debugger `go`) until `seconds` more of simulated time have elapsed, then halt there (reason
 * 'halt'). An earlier stop (breakpoint, BGND...) ends the run first; its halt is returned.
 */
export async function runForSeconds(target: SimTarget, mcu: Mc9s12xdp512, seconds: number, timeoutMs?: number): Promise<HaltInfo> {
  const cancel = mcu.haltAtSeconds(mcu.system.simTimeSeconds + seconds);
  try {
    await target.go();
    return await target.waitForHalt(timeoutMs);
  } finally {
    cancel();
  }
}
