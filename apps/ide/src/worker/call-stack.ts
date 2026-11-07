/**
 * Procedure component (call chain) for assembly programs: there is no frame information, so the chain is recovered
 * from the stack with a return-address heuristic (the way hiwave's Procedure window degrades without frame info):
 * every stacked word that points just after a JSR/BSR/CALL is taken as a return address.
 *
 * UNCERTAIN: hiwave's exact stack unwinding for assembly modules; data words that happen to look like return
 * addresses give extra frames (we only accept addresses inside known symbols' code).
 */
import { callAt, type ReadByte } from '@s12/debug';

export interface StackFrameRaw {
  level: number;
  /** Frame PC: current PC for level 0, the call instruction's address for callers. */
  pc: number;
  /** Return address found on the stack (callers only). */
  returnAddress?: number;
  /** Stack address the return address was found at. */
  stackAddress?: number;
}

export interface CallStackOptions {
  /** Bytes of stack scanned above SP (default 256). */
  scanBytes?: number;
  maxFrames?: number;
  /** Highest stack address + 1 (default $4000: end of the S12X local RAM window). */
  stackTop?: number;
  /** Accept `addr` as code (e.g. "inside a symbol of a code section"); default: any address >= $4000. */
  isCode?: (addr: number) => boolean;
}

/** Candidate call-instruction lengths before a return address: BSR/JSR dir/JSR idx (2), JSR ext/idx1 (3), JSR idx2/CALL (4), CALL idx2 (5). */
const CALL_LENGTHS = [2, 3, 4, 5];

/** The call instruction that returns to `ret`, if one ends exactly there. */
export function callBefore(read: ReadByte, ret: number): number | undefined {
  for (const len of CALL_LENGTHS) {
    const at = (ret - len) & 0xffff;
    const c = callAt(read, at);
    if (c && c.mnemonic !== 'SWI' && c.mnemonic !== 'TRAP' && c.returnAddress === (ret & 0xffff)) return at;
  }
  return undefined;
}

export function unwindStack(read: ReadByte, pc: number, sp: number, opts: CallStackOptions = {}): StackFrameRaw[] {
  const frames: StackFrameRaw[] = [{ level: 0, pc: pc & 0xffff }];
  const top = Math.min(opts.stackTop ?? 0x4000, 0x10000);
  const end = Math.min(top, sp + (opts.scanBytes ?? 256));
  const max = opts.maxFrames ?? 32;
  const isCode = opts.isCode ?? ((a: number) => a >= 0x4000);
  for (let a = sp; a + 1 < end && frames.length < max; ) {
    const w = ((read(a) & 0xff) << 8) | (read(a + 1) & 0xff);
    const call = isCode(w) ? callBefore(read, w) : undefined;
    if (call !== undefined) {
      frames.push({ level: frames.length, pc: call, returnAddress: w, stackAddress: a });
      a += 2;
    } else a += 1;
  }
  return frames;
}
