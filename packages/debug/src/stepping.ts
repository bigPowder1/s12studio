/**
 * Stepping semantics shared by targets (hiwave Run menu):
 *  - Assembly Step (instr): one instruction.
 *  - Assembly Step Over (over): a call (JSR, BSR, CALL, and SWI/TRAP: hiwave's `P` "steps over BSR/JSR/SWI")
 *    runs until control is back at the instruction after it with the stack at (or above) its depth before
 *    the call (so recursion re-hitting the return address does not stop early). Anything else = one instruction.
 *  - Assembly Step Out (out): run until a return instruction (RTS/RTC/RTI) leaves SP above its value when the
 *    step started, i.e. the current frame has been popped.
 *  - Source Step (srcLine): run until PC is at the first address of a line-table row whose (file, line)
 *    differs from the starting row and whose source is available; calls into code without source are stepped
 *    over. srcOver steps over every call. srcOut = step out, then on to the next row start.
 *    Without line info at PC, source steps fall back to the assembly steps.
 */
import { decode, type DecodedInstruction } from '@s12/isa';

export type ReadByte = (address: number) => number;

export const OP_RTS = 0x3d;
export const OP_RTC = 0x0a;
export const OP_RTI = 0x0b;

export interface CallInfo {
  /** Address of the instruction after the call. */
  returnAddress: number;
  /** Statically known call target (BSR, JSR ext/dir, CALL ext...). */
  target?: number;
  mnemonic: string;
}

const CALLS = new Set(['JSR', 'BSR', 'CALL', 'SWI', 'TRAP']);

/**
 * First opcode bytes that can start a call: BSR $07, JSR $15/$16/$17, CALL $4A/$4B, SWI $3F, and the page-2
 * prefix $18 (TRAP). Checked before decoding, so instruction-by-instruction stepping only decodes candidates.
 */
const CALL_OPCODE = new Uint8Array(256);
for (const op of [0x07, 0x15, 0x16, 0x17, 0x3f, 0x4a, 0x4b, 0x18]) CALL_OPCODE[op] = 1;

/** Decode the instruction at `pc` and report whether it is a call to step over. */
export function callAt(read: ReadByte, pc: number, opts: { overSwi?: boolean } = {}): CallInfo | undefined {
  if (!CALL_OPCODE[read(pc & 0xffff) & 0xff]) return undefined;
  const insn = decode(read, pc);
  return callInfo(insn, opts);
}

export function callInfo(insn: DecodedInstruction, opts: { overSwi?: boolean } = {}): CallInfo | undefined {
  if (!CALLS.has(insn.mnemonic)) return undefined;
  // UNCERTAIN: hiwave steps over SWI with P; TRAP treated the same. Configurable for targets.
  if ((insn.mnemonic === 'SWI' || insn.mnemonic === 'TRAP') && opts.overSwi === false) return undefined;
  return { returnAddress: (insn.address + insn.length) & 0xffff, target: insn.targetAddress, mnemonic: insn.mnemonic };
}

/** Is the instruction at `pc` a return (RTS / RTC / RTI)? */
export function isReturnAt(read: ReadByte, pc: number): boolean {
  const op = read(pc & 0xffff);
  return op === OP_RTS || op === OP_RTC || op === OP_RTI;
}
