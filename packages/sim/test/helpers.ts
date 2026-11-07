import { S12XSystem, type Registers, type SystemOptions } from '@s12/sim';

export const CODE = 0x4000;
export const STACK = 0x3f00;

/** A system with erased flash, SP set, PC at CODE, CCR = 0 (all flags/masks clear). */
export function mk(opts: SystemOptions = {}): S12XSystem {
  const s = new S12XSystem({ ramInit: 'zero', ...opts });
  s.setRegisters({ sp: STACK, pc: CODE, ccr: 0, ipl: 0 });
  return s;
}

/** Write bytes at a local address (flash/EEPROM written directly). */
export function put(s: S12XSystem, local: number, bytes: readonly number[]): void {
  bytes.forEach((b, i) => s.poke((local + i) & 0xffff, b));
}

export function putW(s: S12XSystem, local: number, w: number): void {
  put(s, local, [(w >> 8) & 0xff, w & 0xff]);
}

export function getW(s: S12XSystem, local: number): number {
  return (s.peek(local) << 8) | s.peek((local + 1) & 0xffff);
}

export interface ExecResult {
  s: S12XSystem;
  cycles: number;
  r: Registers;
}

/**
 * Run `code` (at CODE) for one instruction with initial registers `regs`. Returns the cycles of that
 * instruction and the registers afterwards.
 */
export function exec1(code: readonly number[], regs: Partial<Registers> = {}, setup?: (s: S12XSystem) => void): ExecResult {
  const s = mk();
  put(s, CODE, code);
  s.setRegisters({ pc: CODE, ...regs });
  setup?.(s);
  const c0 = s.cycles;
  const reason = s.step();
  if (reason !== 'step' && reason !== 'bgnd') throw new Error(`unexpected halt ${reason}`);
  return { s, cycles: s.cycles - c0, r: s.registers };
}

/** Run instructions until PC reaches `until` (or n steps). */
export function runTo(s: S12XSystem, until: number, maxSteps = 100000): void {
  for (let i = 0; i < maxSteps; i++) {
    if (s.registers.pc === until) return;
    const r = s.step();
    if (r !== 'step') throw new Error(`halted: ${r} at ${s.registers.pc.toString(16)}`);
  }
  throw new Error(`did not reach ${until.toString(16)}`);
}

export const CCR = { C: 1, V: 2, Z: 4, N: 8, I: 0x10, H: 0x20, X: 0x40, S: 0x80 } as const;
