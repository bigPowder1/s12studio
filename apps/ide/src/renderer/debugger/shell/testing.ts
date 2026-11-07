/** Test helpers for the debugger shell and components (snapshots, registers, session, disassembly fixture). */
import { bufferReader, decode } from '@s12/isa';
import type { DebugSnapshot, DisasmLine, RegisterSetInfo, SessionInfo } from '../../../shared/api';

export const REGS: RegisterSetInfo = { A: 0, B: 0, D: 0, X: 0, Y: 0, SP: 0x2400, PC: 0xc000, CCR: 0xd0, IPL: 0, CCRW: 0xd0, PPAGE: 0xfe, RPAGE: 0xfd, EPAGE: 0xfe, GPAGE: 0, DIRECT: 0 };

let seq = 100;

/** A snapshot with increasing seq. */
export function snapshot(p: Partial<DebugSnapshot> & { regs?: Partial<RegisterSetInfo> } = {}): DebugSnapshot {
  const { regs, ...rest } = p;
  const state = rest.state ?? 'halted';
  return {
    seq: ++seq,
    state,
    statusText: state === 'running' ? 'RUNNING' : 'HALTED',
    cycles: 0,
    busHz: 8_000_000,
    simSeconds: 0,
    registers: { ...REGS, ...regs },
    memory: {},
    halt: state === 'halted' ? { reason: 'step', pc: regs?.PC ?? REGS.PC, cycles: seq } : undefined,
    ...rest,
  };
}

export const SESSION: SessionInfo = {
  iniPath: '/p/Lab3/Full_Chip_Simulation.ini',
  projectDir: '/p/Lab3',
  connection: 'sim',
  connectionMenu: 'HCS12X FCS',
  layoutPath: '/p/Lab3/ASM_layout.hwl',
  absPath: '/p/Lab3/bin/Project.abs',
  derivative: 'MC9S12XDP512',
  title: 'S12 Studio Debugger  /p/Lab3/Full_Chip_Simulation.ini',
};

/**
 * A made-up start-up routine at $C000 (LDS, four JSRs, BRA *), decoded with @s12/isa exactly like the engine's
 * `debug.disassemble` (apps/ide/src/worker/engine.ts).
 */
export const START_CODE = { base: 0xc000, bytes: [0xcf, 0x24, 0x00, 0x16, 0xc0, 0x20, 0x16, 0xc0, 0x40, 0x16, 0xc0, 0x60, 0x16, 0x09, 0x00, 0x20, 0xfe] };

export function disasmFixture(labels: Record<number, string> = { 0xc000: 'Entry' }): DisasmLine[] {
  const read = bufferReader(Uint8Array.from(START_CODE.bytes), START_CODE.base);
  const out: DisasmLine[] = [];
  let pc = START_CODE.base;
  while (pc < START_CODE.base + START_CODE.bytes.length) {
    const insn = decode(read, pc);
    out.push({ address: insn.address, bytes: [...insn.bytes], mnemonic: insn.mnemonic, operands: insn.operandsText, comment: insn.comment, target: insn.targetAddress, label: labels[insn.address], illegal: insn.illegal || undefined });
    pc += Math.max(1, insn.length);
  }
  return out;
}
