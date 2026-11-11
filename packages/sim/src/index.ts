/**
 * @s12/sim: cycle-counting S12X (CPU12X) core, S12X MMC, XINT arbitration and the peripheral/bus
 * framework for the MC9S12XDP512 full-chip simulator.
 */
export * from './types.js';
export { S12XSystem, type SystemOptions, type Registers, type SystemSnapshot, type CpuRunState } from './system.js';
export { Cpu, CPU_RUN, CPU_WAIT, CPU_STOP, type CpuOptions, type CpuState } from './cpu.js';
export { Bus, ILLEGAL_ACCESS, type BusOptions, type BusState, type IllegalAccessInfo } from './bus.js';
export { Memory, G_NONE, G_REGS } from './memory.js';
export * from './interrupts.js';
export { loadAbs, loadSrec, LoadError, type LoadResult, type LoadedSegment, type SrecLoadOptions } from './loader.js';
export * from './pins.js';
// Peripheral models (MC9S12XDP512 register blocks).
export * from './periph/crg.js';
export * from './periph/mebi.js';
export * from './periph/pim.js';
export * from './periph/ect.js';
export * from './periph/pit.js';
export * from './periph/spi.js';
export * from './periph/sci.js';
export * from './periph/iic.js';
export * from './periph/atd.js';
export * from './periph/pwm.js';
export * from './periph/nvm.js';
export * from './periph/misc.js';
// Board device models and the ME3305 board.
export * from './board/index.js';
// Fully wired MCU (+ board).
export * from './mcu.js';
