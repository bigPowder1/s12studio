/**
 * MC9S12XDP512 register block $0000-$07FF.
 *
 * Source: MC9S12XDP512RMV2 Rev 2.21 Table 1-1 and Appendix G as transcribed in docs/research/r2/xdp512-device.md (§2-§9),
 * names per the CodeWarrior-compiled mc9s12xdp512.c symbol table ([S5] in that note). Register names, addresses, sizes,
 * byte-half names and bit names were cross-checked against the DWARF of CodeWarrior's own compiled mc9s12xdp512.c.o
 * (test/data/cw-mc9s12xdp512.json, see test/cw-golden.test.ts). C-only artifacts of that header are normalised:
 * `TIE_bit` -> `TIE`, `<NAME>_grp` -> `<NAME>`.
 * UNCERTAIN: entries the research did not cover explicitly carry an `uncertain` field explaining what is unverified
 * (the NXP PDF could not be re-fetched in this pass; XGATE/CAN/DBG/EBI details are from S12X family knowledge).
 *
 * `REGISTERS` is the canonical, non-overlapping list. `REGISTER_ALIASES` holds 16-bit composites of 8-bit registers
 * (PWMDTY01, PACN32, ...) and banked alternates (SCI AMAP=1 registers).
 */
import { parseBits } from '../bits.js';
import type { Access, BitField, RegisterAlias, RegisterDef } from '../types.js';

interface Opt {
  size?: 1 | 2;
  reset?: number;
  access?: Access;
  bits?: string;
  /** Byte-half names for 16-bit registers; default `<NAME>Hi`/`<NAME>Lo`, null = none (CW defines none). */
  halves?: [string, string] | null;
  w1cMask?: number;
  uncertain?: string;
}

function reg(module: string, name: string, address: number, description: string, o: Opt = {}): RegisterDef {
  const size = o.size ?? 1;
  const r: RegisterDef = {
    name,
    address,
    size,
    module,
    reset: o.reset ?? 0,
    access: o.access ?? 'rw',
    description,
  };
  if (o.bits !== undefined) r.bits = parseBits(o.bits, size);
  // Default byte-half spelling `<NAME>Hi`/`<NAME>Lo` matches CW's TCNTHi/TCnHi/...; exceptions are passed explicitly.
  if (size === 2 && o.halves !== null) r.halves = o.halves ?? [`${name}Hi`, `${name}Lo`];
  if (o.w1cMask !== undefined) r.w1cMask = o.w1cMask;
  if (o.uncertain) r.uncertain = o.uncertain;
  return r;
}

/** 16-bit register; plain data registers carry no bit names (as in CodeWarrior's header). */
const w16 = (o: Opt = {}): Opt => ({ size: 2, ...o });

// ---------------------------------------------------------------- core / MMC / MEBI / PIM A,B,C,D,E,K
function core(): RegisterDef[] {
  const M = 'MEBI';
  return [
    reg('PIM', 'PORTA', 0x0000, 'Port A Register', { bits: 'PA#8' }),
    reg('PIM', 'PORTB', 0x0001, 'Port B Register', { bits: 'PB#8' }),
    reg('PIM', 'DDRA', 0x0002, 'Port A Data Direction Register', { bits: 'DDRA#8' }),
    reg('PIM', 'DDRB', 0x0003, 'Port B Data Direction Register', { bits: 'DDRB#8' }),
    reg('PIM', 'PORTC', 0x0004, 'Port C Register', { bits: 'PC#8', uncertain: 'not bonded on the 112-pin package' }),
    reg('PIM', 'PORTD', 0x0005, 'Port D Register', { bits: 'PD#8', uncertain: 'not bonded on the 112-pin package' }),
    reg('PIM', 'DDRC', 0x0006, 'Port C Data Direction Register', { bits: 'DDRC#8' }),
    reg('PIM', 'DDRD', 0x0007, 'Port D Data Direction Register', { bits: 'DDRD#8' }),
    reg('PIM', 'PORTE', 0x0008, 'Port E Register', { bits: 'PE#8' }),
    reg('PIM', 'DDRE', 0x0009, 'Port E Data Direction Register', { bits: 'DDRE#7:2 - -' }),
    reg('MMC', 'MMCCTL0', 0x000a, 'MMC Control Register 0', { bits: '- - - - CS3E CS2E CS1E CS0E' }),
    reg('MMC', 'MODE', 0x000b, 'Mode Register', {
      bits: 'MODC MODB MODA - - - - -',
      reset: 0x80,
      access: 'rw-once',
      uncertain: 'reset depends on mode pins: $80 normal single-chip, $00 special single-chip',
    }),
    reg('PIM', 'PUCR', 0x000c, 'Pull-Up Control Register', { bits: 'PUPKE BKPUE - PUPEE PUPDE PUPCE PUPBE PUPAE', reset: 0xd0 }),
    reg('PIM', 'RDRIV', 0x000d, 'Reduced Drive Register', { bits: 'RDPK - - RDPE RDPD RDPC RDPB RDPA' }),
    reg(M, 'EBICTL0', 0x000e, 'External Bus Interface Control Register 0', {
      bits: 'ITHRS - HDBE ASIZ[5]',
      reset: 0x3f,
      uncertain: 'reset value',
    }),
    reg(M, 'EBICTL1', 0x000f, 'External Bus Interface Control Register 1', {
      bits: 'EWAITE - - - - EXSTR[3]',
      reset: 0x07,
      uncertain: 'reset value',
    }),
    reg('MMC', 'GPAGE', 0x0010, 'Global Page Index Register', { bits: '- GP[7]' }),
    reg('MMC', 'DIRECT', 0x0011, 'Direct Page Register', { bits: 'DP[15:8]', access: 'rw-once' }),
    reg('MMC', 'MMCCTL1', 0x0013, 'MMC Control Register 1', {
      bits: '- - - - - EROMON ROMHM ROMON',
      reset: 0x05,
      uncertain: 'reset value in single-chip mode (ROMON=1, EROMON=1 assumed)',
    }),
    reg('MMC', 'RPAGE', 0x0016, 'RAM Page Index Register', { bits: 'RP[8]', reset: 0xfd }),
    reg('MMC', 'EPAGE', 0x0017, 'EEPROM Page Index Register', { bits: 'EP[8]', reset: 0xfe }),
    reg('MISC', 'PARTID', 0x001a, 'Part ID Register', {
      size: 2,
      bits: 'ID#16',
      reset: 0xc410,
      access: 'r',
      halves: ['PARTIDH', 'PARTIDL'],
      uncertain: 'PARTIDL is maskset dependent; $10 assumed',
    }),
    reg(M, 'ECLKCTL', 0x001c, 'ECLK Control Register', {
      bits: 'NECLK NCLKX2 - - - - EDIV[2]',
      reset: 0xc0,
      uncertain: 'reset value in single-chip mode',
    }),
    reg('MISC', 'IRQCR', 0x001e, 'Interrupt Control Register', { bits: 'IRQE IRQEN - - - - - -', reset: 0x40 }),
    reg('MMC', 'PPAGE', 0x0030, 'Program Page Index Register', { bits: 'PIX[8]', reset: 0xfe }),
    reg('PIM', 'PORTK', 0x0032, 'Port K Data Register', { bits: 'PK#8' }),
    reg('PIM', 'DDRK', 0x0033, 'Port K Data Direction Register', { bits: 'DDRK#8' }),
  ];
}

// ---------------------------------------------------------------- DBG $0020-$002F
function dbg(): RegisterDef[] {
  const M = 'DBG';
  // Bit names per CodeWarrior's header; reset values / access of the S12XDBG registers are not verified.
  return [
    reg(M, 'DBGC1', 0x0020, 'Debug Control Register 1', { bits: 'ARM TRIG XGSBPE BDM DBGBRK(2) COMRV(2)' }),
    reg(M, 'DBGSR', 0x0021, 'Debug Status Register', { bits: 'TBF EXTF - - - SSF[3]', access: 'r' }),
    reg(M, 'DBGTCR', 0x0022, 'Debug Trace Control Register', { bits: 'TSOURCE(2) TRANGE(2) TRCMOD(2) TALIGN(2)' }),
    reg(M, 'DBGC2', 0x0023, 'Debug Control Register 2', { bits: '- - - - CDCM(2) ABCM(2)' }),
    reg(M, 'DBGTB', 0x0024, 'Debug Trace Buffer Register', w16({ bits: 'D', access: 'r', halves: ['DBGTBH', 'DBGTBL'] })),
    reg(M, 'DBGCNT', 0x0026, 'Debug Count Register', { bits: '- CNT(7)', access: 'r' }),
    // $0027 reads as DBGMFR (match flags) while the debugger is armed; see REGISTER_ALIASES.
    reg(M, 'DBGSCRX', 0x0027, 'Debug State Control Register', { bits: '- - - - SC[4]' }),
    reg(M, 'DBGXCTL', 0x0028, 'Debug Comparator Control Register', { bits: 'SZE NDB_SZ TAG BRK RW RWE SRC COMPE' }),
    reg(M, 'DBGXAH', 0x0029, 'Debug Comparator Address High Register', { bits: '- BIT#22:16' }),
    reg(M, 'DBGXAM', 0x002a, 'Debug Comparator Address Mid Register', { bits: 'BIT#15:8' }),
    reg(M, 'DBGXAL', 0x002b, 'Debug Comparator Address Low Register', { bits: 'D' }),
    reg(M, 'DBGXDH', 0x002c, 'Debug Comparator Data High Register', { bits: 'BIT#15:8' }),
    reg(M, 'DBGXDL', 0x002d, 'Debug Comparator Data Low Register', { bits: 'D' }),
    reg(M, 'DBGXDHM', 0x002e, 'Debug Comparator Data High Mask Register', { bits: 'BIT#15:8' }),
    reg(M, 'DBGXDLM', 0x002f, 'Debug Comparator Data Low Mask Register', { bits: 'D' }),
  ];
}

// ---------------------------------------------------------------- CRG $0034-$003F
function crg(): RegisterDef[] {
  const M = 'CRG';
  return [
    reg(M, 'SYNR', 0x0034, 'CRG Synthesizer Register', { bits: '- - SYN[6]' }),
    reg(M, 'REFDV', 0x0035, 'CRG Reference Divider Register', { bits: '- - REFDV[6]' }),
    reg(M, 'CTFLG', 0x0036, 'CRG Test Flags Register', { access: 'test' }),
    reg(M, 'CRGFLG', 0x0037, 'CRG Flags Register', {
      bits: 'RTIF PORF LVRF LOCKIF LOCK TRACK SCMIF SCM',
      reset: 0x40,
      access: 'w1c',
      w1cMask: 0xf2,
      uncertain: 'reset value after power-on (PORF=1); LOCK/TRACK/SCM are read-only status',
    }),
    // ILAF (illegal address reset flag) is a write-1-to-clear flag inside an enable register.
    reg(M, 'CRGINT', 0x0038, 'CRG Interrupt Enable Register', { bits: 'RTIE ILAF - LOCKIE - - SCMIE -', access: 'w1c', w1cMask: 0x40 }),
    reg(M, 'CLKSEL', 0x0039, 'CRG Clock Select Register', { bits: 'PLLSEL PSTP - - PLLWAI - RTIWAI COPWAI' }),
    reg(M, 'PLLCTL', 0x003a, 'CRG PLL Control Register', { bits: 'CME PLLON AUTO ACQ FSTWKP PRE PCE SCME', reset: 0xf1 }),
    reg(M, 'RTICTL', 0x003b, 'CRG RTI Control Register', { bits: 'RTDEC RTR[7]' }),
    reg(M, 'COPCTL', 0x003c, 'CRG COP Control Register', {
      bits: 'WCOP RSBCK WRTMASK - - CR[3]',
      access: 'rw-once',
      uncertain: 'WCOP/CR reset values are loaded from FCTL (flash $7FFF0E): CR = ~NV[2:0], WCOP = ~NV[3]; erased => 0',
    }),
    reg(M, 'FORBYP', 0x003d, 'CRG Force and Bypass Test Register', { access: 'test' }),
    reg(M, 'CTCTL', 0x003e, 'CRG Test Control Register', { access: 'test' }),
    reg(M, 'ARMCOP', 0x003f, 'CRG COP Timer Arm/Reset Register', { bits: 'D', access: 'w' }),
  ];
}

// ---------------------------------------------------------------- ECT $0040-$007F
function ect(): RegisterDef[] {
  const M = 'ECT';
  const r: RegisterDef[] = [
    reg(M, 'TIOS', 0x0040, 'Timer Input Capture/Output Compare Select', { bits: 'IOS[8]' }),
    reg(M, 'CFORC', 0x0041, 'Timer Compare Force Register', { bits: 'FOC[8]', access: 'w' }),
    reg(M, 'OC7M', 0x0042, 'Output Compare 7 Mask Register', { bits: 'OC7M[8]' }),
    reg(M, 'OC7D', 0x0043, 'Output Compare 7 Data Register', { bits: 'OC7D[8]' }),
    reg(M, 'TCNT', 0x0044, 'Timer Count Register', w16()),
    reg(M, 'TSCR1', 0x0046, 'Timer System Control Register 1', { bits: 'TEN TSWAI TSFRZ TFFCA PRNT - - -' }),
    reg(M, 'TTOV', 0x0047, 'Timer Toggle On Overflow Register', { bits: 'TOV[8]' }),
    reg(M, 'TCTL1', 0x0048, 'Timer Control Register 1', { bits: 'OM7 OL7 OM6 OL6 OM5 OL5 OM4 OL4' }),
    reg(M, 'TCTL2', 0x0049, 'Timer Control Register 2', { bits: 'OM3 OL3 OM2 OL2 OM1 OL1 OM0 OL0' }),
    reg(M, 'TCTL3', 0x004a, 'Timer Control Register 3', { bits: 'EDG7B EDG7A EDG6B EDG6A EDG5B EDG5A EDG4B EDG4A' }),
    reg(M, 'TCTL4', 0x004b, 'Timer Control Register 4', { bits: 'EDG3B EDG3A EDG2B EDG2A EDG1B EDG1A EDG0B EDG0A' }),
    reg(M, 'TIE', 0x004c, 'Timer Interrupt Enable Register', { bits: 'C7I C6I C5I C4I C3I C2I C1I C0I' }),
    reg(M, 'TSCR2', 0x004d, 'Timer System Control Register 2', { bits: 'TOI - - - TCRE PR[3]' }),
    reg(M, 'TFLG1', 0x004e, 'Main Timer Interrupt Flag 1', { bits: 'C7F C6F C5F C4F C3F C2F C1F C0F', access: 'w1c' }),
    reg(M, 'TFLG2', 0x004f, 'Main Timer Interrupt Flag 2', { bits: 'TOF - - - - - - -', access: 'w1c' }),
  ];
  for (let i = 0; i < 8; i++)
    r.push(reg(M, `TC${i}`, 0x0050 + 2 * i, `Timer Input Capture/Output Compare Register ${i}`, w16()));
  r.push(
    reg(M, 'PACTL', 0x0060, '16-Bit Pulse Accumulator A Control Register', { bits: '- PAEN PAMOD PEDGE CLK[2] PAOVI PAI' }),
    reg(M, 'PAFLG', 0x0061, 'Pulse Accumulator A Flag Register', { bits: '- - - - - - PAOVF PAIF', access: 'w1c' }),
    reg(M, 'PACN3', 0x0062, 'Pulse Accumulator Count Register 3'),
    reg(M, 'PACN2', 0x0063, 'Pulse Accumulator Count Register 2'),
    reg(M, 'PACN1', 0x0064, 'Pulse Accumulator Count Register 1'),
    reg(M, 'PACN0', 0x0065, 'Pulse Accumulator Count Register 0'),
    reg(M, 'MCCTL', 0x0066, 'Modulus Down Counter Control Register', { bits: 'MCZI MODMC RDMCL ICLAT FLMC MCEN MCPR[2]' }),
    reg(M, 'MCFLG', 0x0067, 'Modulus Down Counter Flag Register', { bits: 'MCZF - - - POLF3 POLF2 POLF1 POLF0', access: 'w1c', w1cMask: 0x80 }),
    reg(M, 'ICPAR', 0x0068, 'Input Control Pulse Accumulator Register', { bits: '- - - - PA3EN PA2EN PA1EN PA0EN' }),
    reg(M, 'DLYCT', 0x0069, 'Delay Counter Control Register', { bits: 'DLY[8]' }),
    reg(M, 'ICOVW', 0x006a, 'Input Control Overwrite Register', { bits: 'NOVW[8]' }),
    reg(M, 'ICSYS', 0x006b, 'Input Control System Register', { bits: 'SH37 SH26 SH15 SH04 TFMOD PACMX BUFEN LATQ' }),
    reg(M, 'TIMTST', 0x006c, 'Timer Test Register', { access: 'test', uncertain: 'name' }),
    reg(M, 'PTPSR', 0x006e, 'Precision Timer Prescaler Select Register', { bits: 'PTPS[8]' }),
    reg(M, 'PTMCPSR', 0x006f, 'Precision Timer Modulus Counter Prescaler Select Register', { bits: 'PTMPS[8]' }),
    reg(M, 'PBCTL', 0x0070, '16-Bit Pulse Accumulator B Control Register', { bits: '- PBEN - - - - PBOVI -' }),
    reg(M, 'PBFLG', 0x0071, 'Pulse Accumulator B Flag Register', { bits: '- - - - - - PBOVF -', access: 'w1c' }),
    reg(M, 'PA3H', 0x0072, '8-Bit Pulse Accumulator Holding Register 3', { access: 'r' }),
    reg(M, 'PA2H', 0x0073, '8-Bit Pulse Accumulator Holding Register 2', { access: 'r' }),
    reg(M, 'PA1H', 0x0074, '8-Bit Pulse Accumulator Holding Register 1', { access: 'r' }),
    reg(M, 'PA0H', 0x0075, '8-Bit Pulse Accumulator Holding Register 0', { access: 'r' }),
    reg(M, 'MCCNT', 0x0076, 'Modulus Down-Counter Count Register', w16({ reset: 0xffff, halves: ['MCCNThi', 'MCCNTlo'] })),
  );
  for (let i = 0; i < 4; i++)
    r.push(reg(M, `TC${i}H`, 0x0078 + 2 * i, `Timer Input Capture Holding Register ${i}`, w16({ access: 'r', halves: [`TC${i}Hhi`, `TC${i}Hlo`] })));
  return r;
}

// ---------------------------------------------------------------- ATD0 / ATD1
function atd(n: 0 | 1, base: number): RegisterDef[] {
  const M = `ATD${n}`;
  const p = `ATD${n}`;
  const ch16 = n === 1;
  const r: RegisterDef[] = [
    reg(M, `${p}CTL0`, base + 0, `ATD ${n} Control Register 0`, {
      bits: ch16 ? '- - - - WRAP[4]' : '- - - - - WRAP[3]',
      reset: ch16 ? 0x0f : 0x07,
    }),
    reg(M, `${p}CTL1`, base + 1, `ATD ${n} Control Register 1`, {
      bits: ch16 ? 'ETRIGSEL - - - ETRIGCH[4]' : 'ETRIGSEL - - - - ETRIGCH[3]',
      reset: ch16 ? 0x0f : 0x07,
    }),
    reg(M, `${p}CTL2`, base + 2, `ATD ${n} Control Register 2`, { bits: 'ADPU AFFC AWAI ETRIGLE ETRIGP ETRIGE ASCIE ASCIF' }),
    reg(M, `${p}CTL3`, base + 3, `ATD ${n} Control Register 3`, { bits: '- S8C S4C S2C S1C FIFO FRZ[2]', reset: 0x20 }),
    reg(M, `${p}CTL4`, base + 4, `ATD ${n} Control Register 4`, { bits: 'SRES8 SMP[2] PRS[5]', reset: 0x05 }),
    reg(M, `${p}CTL5`, base + 5, `ATD ${n} Control Register 5`, { bits: ch16 ? 'DJM DSGN SCAN MULT CD CC CB CA' : 'DJM DSGN SCAN MULT - CC CB CA' }),
    reg(M, `${p}STAT0`, base + 6, `ATD ${n} Status Register 0`, {
      bits: ch16 ? 'SCF - ETORF FIFOR CC[4]' : 'SCF - ETORF FIFOR - CC[3]',
      access: 'w1c',
      w1cMask: 0xb0,
    }),
    reg(M, `${p}TEST0`, base + 8, `ATD ${n} Test Register 0`, { access: 'test' }),
    reg(M, `${p}TEST1`, base + 9, `ATD ${n} Test Register 1`, { bits: '- - - - - - - SC' }),
  ];
  if (ch16) {
    r.push(
      reg(M, 'ATD1STAT2', base + 0x0a, 'ATD 1 Status Register 2', { bits: 'CCF[15:8]', access: 'r' }),
      reg(M, 'ATD1STAT1', base + 0x0b, 'ATD 1 Status Register 1', { bits: 'CCF[8]', access: 'r' }),
      reg(M, 'ATD1DIEN0', base + 0x0c, 'ATD 1 Input Enable Register 0', { bits: 'IEN[15:8]' }),
      reg(M, 'ATD1DIEN1', base + 0x0d, 'ATD 1 Input Enable Register 1', { bits: 'IEN[8]' }),
      reg(M, 'ATD1PTAD0', base + 0x0e, 'Port AD1 Data Register 0', { bits: 'PTAD[15:8]', access: 'r' }),
      reg(M, 'ATD1PTAD1', base + 0x0f, 'Port AD1 Data Register 1', { bits: 'PTAD[8]', access: 'r' }),
    );
  } else {
    r.push(
      reg(M, 'ATD0STAT1', base + 0x0b, 'ATD 0 Status Register 1', { bits: 'CCF[8]', access: 'r' }),
      reg(M, 'ATD0DIEN', base + 0x0d, 'ATD 0 Input Enable Register', { bits: 'IEN[8]' }),
      reg(M, 'ATD0PTAD0', base + 0x0f, 'Port AD0 Data Register 0', { bits: 'PTAD[8]', access: 'r' }),
    );
  }
  const nDr = ch16 ? 16 : 8;
  for (let i = 0; i < nDr; i++)
    r.push(
      reg(M, `${p}DR${i}`, base + 0x10 + 2 * i, `ATD ${n} Conversion Result Register ${i}`,
        w16({ bits: 'BIT#15:6 - - - - - -', access: 'r', halves: [`${p}DR${i}H`, `${p}DR${i}L`] })),
    );
  return r;
}

// ---------------------------------------------------------------- IIC
function iic(n: 0 | 1, base: number): RegisterDef[] {
  const M = `IIC${n}`;
  const p = `IIC${n}_`;
  return [
    reg(M, `${p}IBAD`, base + 0, `IIC ${n} Address Register`, { bits: 'ADR[7:1] -' }),
    reg(M, `${p}IBFD`, base + 1, `IIC ${n} Frequency Divider Register`, { bits: 'IBC[8]' }),
    reg(M, `${p}IBCR`, base + 2, `IIC ${n} Control Register`, { bits: 'IBEN IBIE MS_SL TX_RX TXAK RSTA - IBSWAI' }),
    reg(M, `${p}IBSR`, base + 3, `IIC ${n} Status Register`, {
      bits: 'TCF IAAS IBB IBAL - SRW IBIF RXAK',
      reset: 0x80,
      access: 'w1c',
      w1cMask: 0x12,
    }),
    reg(M, `${p}IBDR`, base + 4, `IIC ${n} Data I/O Register`, { bits: 'D#8' }),
  ];
}

// ---------------------------------------------------------------- SCI
function sci(n: number, base: number): RegisterDef[] {
  const M = `SCI${n}`;
  const p = `SCI${n}`;
  return [
    reg(M, `${p}BD`, base + 0, `SCI ${n} Baud Rate Register`, {
      size: 2,
      bits: 'IREN TNP[2] SBR[13]',
      reset: 0x0004,
      halves: [`${p}BDH`, `${p}BDL`],
    }),
    reg(M, `${p}CR1`, base + 2, `SCI ${n} Control Register 1`, { bits: 'LOOPS SCISWAI RSRC M WAKE ILT PE PT' }),
    reg(M, `${p}CR2`, base + 3, `SCI ${n} Control Register 2`, { bits: 'TIE TCIE RIE ILIE TE RE RWU SBK' }),
    reg(M, `${p}SR1`, base + 4, `SCI ${n} Status Register 1`, { bits: 'TDRE TC RDRF IDLE OR NF FE PF', reset: 0xc0, access: 'r' }),
    reg(M, `${p}SR2`, base + 5, `SCI ${n} Status Register 2`, { bits: 'AMAP - - TXPOL RXPOL BRK13 TXDIR RAF' }),
    reg(M, `${p}DRH`, base + 6, `SCI ${n} Data Register High`, { bits: 'R8 T8 - - - - - -' }),
    reg(M, `${p}DRL`, base + 7, `SCI ${n} Data Register Low`, { bits: 'R7_T7 R6_T6 R5_T5 R4_T4 R3_T3 R2_T2 R1_T1 R0_T0' }),
  ];
}

function sciAliases(n: number, base: number): RegisterAlias[] {
  const M = `SCI${n}`;
  const p = `SCI${n}`;
  const a = (r: RegisterDef, of: string): RegisterAlias => ({ ...r, aliasOf: [of], composite: false });
  return [
    a(reg(M, `${p}ASR1`, base + 0, `SCI ${n} Alternative Status Register 1 (AMAP=1)`, {
      bits: 'RXEDGIF - - - - BERRV BERRIF BKDIF',
      access: 'w1c',
      w1cMask: 0x83,
    }), `${p}BD`),
    a(reg(M, `${p}ACR1`, base + 1, `SCI ${n} Alternative Control Register 1 (AMAP=1)`, {
      bits: 'RXEDGIE - - - - - BERRIE BKDIE',
    }), `${p}BD`),
    a(reg(M, `${p}ACR2`, base + 2, `SCI ${n} Alternative Control Register 2 (AMAP=1)`, {
      bits: '- - - - - BERRM[2] BKDFE',
    }), `${p}CR1`),
  ];
}

// ---------------------------------------------------------------- SPI
function spi(n: number, base: number): RegisterDef[] {
  const M = `SPI${n}`;
  const p = `SPI${n}`;
  return [
    reg(M, `${p}CR1`, base + 0, `SPI ${n} Control Register 1`, { bits: 'SPIE SPE SPTIE MSTR CPOL CPHA SSOE LSBFE', reset: 0x04 }),
    reg(M, `${p}CR2`, base + 1, `SPI ${n} Control Register 2`, { bits: '- - - MODFEN BIDIROE - SPISWAI SPC0' }),
    reg(M, `${p}BR`, base + 2, `SPI ${n} Baud Rate Register`, { bits: '- SPPR[3] - SPR[3]' }),
    reg(M, `${p}SR`, base + 3, `SPI ${n} Status Register`, { bits: 'SPIF - SPTEF MODF - - - -', reset: 0x20, access: 'r' }),
    reg(M, `${p}DR`, base + 5, `SPI ${n} Data Register`),
  ];
}

// ---------------------------------------------------------------- Flash / EEPROM / MMC RAM protection / XINT
function nvm(): RegisterDef[] {
  const F = 'FTX512K4';
  const E = 'EETX4K';
  return [
    reg(F, 'FCLKDIV', 0x0100, 'Flash Clock Divider Register', { bits: 'FDIVLD PRDIV8 FDIV[6]' }),
    reg(F, 'FSEC', 0x0101, 'Flash Security Register', {
      bits: 'KEYEN[2] RNV[5:2] SEC[2]',
      access: 'r',
      reset: 0xfe,
      uncertain: 'loaded from flash $7FFF0F at reset; $FE (unsecured) assumed',
    }),
    reg(F, 'FTSTMOD', 0x0102, 'Flash Test Mode Register', { bits: '- MRDS(2) WRALL - - - -' }),
    reg(F, 'FCNFG', 0x0103, 'Flash Configuration Register', { bits: 'CBEIE CCIE KEYACC - - - BKSEL[2]' }),
    reg(F, 'FPROT', 0x0104, 'Flash Protection Register', {
      bits: 'FPOPEN RNV6 FPHDIS FPHS[2] FPLDIS FPLS[2]',
      reset: 0xff,
      uncertain: 'loaded from flash $7FFF0D at reset; erased ($FF) assumed',
    }),
    reg(F, 'FSTAT', 0x0105, 'Flash Status Register', {
      bits: 'CBEIF CCIF PVIOL ACCERR - BLANK FAIL -',
      reset: 0xc0,
      access: 'w1c',
      w1cMask: 0xb0,
    }),
    reg(F, 'FCMD', 0x0106, 'Flash Command Register', { bits: '- CMDB[7]' }),
    reg(F, 'FCTL', 0x0107, 'Flash Control Register', {
      bits: 'NV[8]',
      access: 'r',
      reset: 0xff,
      uncertain: 'loaded from flash $7FFF0E at reset; erased ($FF) => COP disabled',
    }),
    // CW defines only byte-group fields on FADDR/FDATA (FADDRHI_grp, ...), which are just the byte halves.
    reg(F, 'FADDR', 0x0108, 'Flash Address Register', w16({ halves: ['FADDRHI', 'FADDRLO'] })),
    reg(F, 'FDATA', 0x010a, 'Flash Data Register', w16({ halves: ['FDATAHI', 'FDATALO'] })),
    reg(E, 'ECLKDIV', 0x0110, 'EEPROM Clock Divider Register', { bits: 'EDIVLD PRDIV8 EDIV[6]' }),
    reg(E, 'ECNFG', 0x0113, 'EEPROM Configuration Register', { bits: 'CBEIE CCIE - - - - - -' }),
    reg(E, 'EPROT', 0x0114, 'EEPROM Protection Register', {
      bits: 'EPOPEN RNV[6:4] EPDIS EPS[3]',
      reset: 0xff,
      uncertain: 'loaded from EEPROM $13FFFD at reset; erased ($FF) assumed',
    }),
    reg(E, 'ESTAT', 0x0115, 'EEPROM Status Register', {
      bits: 'CBEIF CCIF PVIOL ACCERR - BLANK FAIL -',
      reset: 0xc0,
      access: 'w1c',
      w1cMask: 0xb0,
    }),
    reg(E, 'ECMD', 0x0116, 'EEPROM Command Register', { bits: '- CMDB(7)' }),
    reg(E, 'EADDR', 0x0118, 'EEPROM Address Register', w16({ bits: '- - - - - EABHI(3) EABLO(8)', halves: ['EADDRHI', 'EADDRLO'] })),
    reg(E, 'EDATA', 0x011a, 'EEPROM Data Register', w16({ bits: 'EDHI(8) EDLO(8)', halves: ['EDATAHI', 'EDATALO'] })),
    reg('MMC', 'RAMWPC', 0x011c, 'RAM Write Protection Control Register', {
      bits: 'RWPE - - - - - AVIE AVIF',
      access: 'w1c',
      w1cMask: 0x01,
    }),
    reg('MMC', 'RAMXGU', 0x011d, 'RAM XGATE Upper Boundary Register', { bits: '- XGU[7]', reset: 0xff }),
    reg('MMC', 'RAMSHL', 0x011e, 'RAM Shared Region Lower Boundary Register', { bits: '- SHL[7]', reset: 0xff }),
    reg('MMC', 'RAMSHU', 0x011f, 'RAM Shared Region Upper Boundary Register', { bits: '- SHU[7]', reset: 0xff }),
    reg('XINT', 'IVBR', 0x0121, 'Interrupt Vector Base Register', { bits: 'IVB_ADDR(8)', reset: 0xff }),
    reg('XINT', 'INT_XGPRIO', 0x0126, 'XGATE Interrupt Priority Configuration Register', { bits: '- - - - - XILVL(3)', reset: 0x01 }),
    reg('XINT', 'INT_CFADDR', 0x0127, 'Interrupt Request Configuration Address Register', {
      bits: 'INT_CFADDR(4) - - - -',
      reset: 0x10,
      uncertain: 'reset value',
    }),
    ...Array.from({ length: 8 }, (_, i) =>
      reg('XINT', `INT_CFDATA${i}`, 0x0128 + i, `Interrupt Request Configuration Data Register ${i}`, {
        bits: 'RQST - - - - PRIOLVL(3)',
        reset: 0x01,
      })),
  ];
}

// ---------------------------------------------------------------- MSCAN (bit names per CodeWarrior's header)
function can(n: number, base: number): RegisterDef[] {
  const M = `CAN${n}`;
  const p = `CAN${n}`;
  const out: RegisterDef[] = [];
  const add = (name: string, off: number, desc: string, o: Opt = {}) =>
    out.push(reg(M, `${p}${name}`, base + off, `MSCAN ${n} ${desc}`, o));
  add('CTL0', 0x00, 'Control Register 0', { bits: 'RXFRM RXACT CSWAI SYNCH TIME WUPE SLPRQ INITRQ', reset: 0x01 });
  add('CTL1', 0x01, 'Control Register 1', { bits: 'CANE CLKSRC LOOPB LISTEN BORM WUPM SLPAK INITAK', reset: 0x11 });
  add('BTR0', 0x02, 'Bus Timing Register 0', { bits: 'SJW[2] BRP[6]' });
  add('BTR1', 0x03, 'Bus Timing Register 1', { bits: 'SAMP TSEG2[3] TSEG1[4]' });
  // RSTAT/TSTAT are read-only status; WUPIF, CSCIF, OVRIF, RXF clear on write-1.
  add('RFLG', 0x04, 'Receiver Flag Register', { bits: 'WUPIF CSCIF RSTAT[2] TSTAT[2] OVRIF RXF', access: 'w1c', w1cMask: 0xc3 });
  add('RIER', 0x05, 'Receiver Interrupt Enable Register', { bits: 'WUPIE CSCIE RSTATE[2] TSTATE[2] OVRIE RXFIE' });
  add('TFLG', 0x06, 'Transmitter Flag Register', { bits: '- - - - - TXE[3]', reset: 0x07, access: 'w1c', w1cMask: 0x07 });
  add('TIER', 0x07, 'Transmitter Interrupt Enable Register', { bits: '- - - - - TXEIE[3]' });
  add('TARQ', 0x08, 'Transmitter Message Abort Request', { bits: '- - - - - ABTRQ[3]' });
  add('TAAK', 0x09, 'Transmitter Message Abort Acknowledge', { bits: '- - - - - ABTAK[3]', access: 'r' });
  add('TBSEL', 0x0a, 'Transmit Buffer Selection', { bits: '- - - - - TX[3]' });
  add('IDAC', 0x0b, 'Identifier Acceptance Control Register', { bits: '- - IDAM[2] - IDHIT[3]' });
  add('MISC', 0x0d, 'Miscellaneous Register', { bits: '- - - - - - - BOHOLD' });
  add('RXERR', 0x0e, 'Receive Error Counter Register', { bits: 'RXERR#8', access: 'r' });
  add('TXERR', 0x0f, 'Transmit Error Counter Register', { bits: 'TXERR#8', access: 'r' });
  for (let i = 0; i < 4; i++) add(`IDAR${i}`, 0x10 + i, `Identifier Acceptance Register ${i}`, { bits: 'AC#8' });
  for (let i = 0; i < 4; i++) add(`IDMR${i}`, 0x14 + i, `Identifier Mask Register ${i}`, { bits: 'AM#8' });
  for (let i = 4; i < 8; i++) add(`IDAR${i}`, 0x14 + i, `Identifier Acceptance Register ${i}`, { bits: 'AC#8' });
  for (let i = 4; i < 8; i++) add(`IDMR${i}`, 0x18 + i, `Identifier Mask Register ${i}`, { bits: 'AM#8' });
  // Extended-identifier mapping of the IDR0-3 foreground buffers.
  const idr = ['ID#28:21', 'ID#20:18 SRR IDE ID#17:15', 'ID#14:7', 'ID#6:0 RTR'];
  for (let i = 0; i < 4; i++) add(`RXIDR${i}`, 0x20 + i, `Receive Identifier Register ${i}`, { bits: idr[i], access: 'r' });
  for (let i = 0; i < 8; i++) add(`RXDSR${i}`, 0x24 + i, `Receive Data Segment Register ${i}`, { bits: 'DB#8', access: 'r' });
  add('RXDLR', 0x2c, 'Receive Data Length Register', { bits: '- - - - DLC[4]', access: 'r' });
  add('RXTSR', 0x2e, 'Receive Time Stamp Register', { size: 2, bits: 'TSR#16', access: 'r', halves: [`${p}RXTSRH`, `${p}RXTSRL`] });
  for (let i = 0; i < 4; i++) add(`TXIDR${i}`, 0x30 + i, `Transmit Identifier Register ${i}`, { bits: idr[i] });
  for (let i = 0; i < 8; i++) add(`TXDSR${i}`, 0x34 + i, `Transmit Data Segment Register ${i}`, { bits: 'DB#8' });
  add('TXDLR', 0x3c, 'Transmit Data Length Register', { bits: '- - - - DLC[4]' });
  add('TXTBPR', 0x3d, 'Transmit Buffer Priority Register', { bits: 'PRIO#8' });
  add('TXTSR', 0x3e, 'Transmit Time Stamp Register', { size: 2, bits: 'TSR#16', access: 'r', halves: [`${p}TXTSRH`, `${p}TXTSRL`] });
  return out;
}

// ---------------------------------------------------------------- PIM ports T,S,M,P,H,J,AD
function pim(): RegisterDef[] {
  const M = 'PIM';
  const out: RegisterDef[] = [];
  const port = (x: string, base: number, extra: Array<[string, number, string, Opt]>, mask = '') => {
    const b = (pfx: string) => mask ? mask.replace(/\*/g, pfx) : `${pfx}#8`;
    out.push(
      reg(M, `PT${x}`, base + 0, `Port ${x} I/O Register`, { bits: b(`PT${x}`) }),
      reg(M, `PTI${x}`, base + 1, `Port ${x} Input Register`, { bits: b(`PTI${x}`), access: 'r' }),
      reg(M, `DDR${x}`, base + 2, `Port ${x} Data Direction Register`, { bits: b(`DDR${x}`) }),
      reg(M, `RDR${x}`, base + 3, `Port ${x} Reduced Drive Register`, { bits: b(`RDR${x}`) }),
      reg(M, `PER${x}`, base + 4, `Port ${x} Pull Device Enable Register`, { bits: b(`PER${x}`) }),
      reg(M, `PPS${x}`, base + 5, `Port ${x} Polarity Select Register`, { bits: b(`PPS${x}`) }),
    );
    for (const [name, off, desc, o] of extra) out.push(reg(M, name, base + off, desc, o));
  };
  port('T', 0x0240, []);
  port('S', 0x0248, [['WOMS', 6, 'Port S Wired-Or Mode Register', { bits: 'WOMS#8' }]]);
  port('M', 0x0250, [
    ['WOMM', 6, 'Port M Wired-Or Mode Register', { bits: 'WOMM#8' }],
    ['MODRR', 7, 'Module Routing Register', { bits: '- MODRR#7' }],
  ]);
  port('P', 0x0258, [
    ['PIEP', 6, 'Port P Interrupt Enable Register', { bits: 'PIEP#8' }],
    ['PIFP', 7, 'Port P Interrupt Flag Register', { bits: 'PIFP#8', access: 'w1c' }],
  ]);
  port('H', 0x0260, [
    ['PIEH', 6, 'Port H Interrupt Enable Register', { bits: 'PIEH#8' }],
    ['PIFH', 7, 'Port H Interrupt Flag Register', { bits: 'PIFH#8', access: 'w1c' }],
  ]);
  // Port J: PJ7, PJ6, PJ5, PJ4, PJ2, PJ1, PJ0 (PJ5/PJ4/PJ2 bonded on the 144-pin package only); no bit 3.
  const pj = '*7 *6 *5 *4 - *2 *1 *0';
  port('J', 0x0268, [
    ['PIEJ', 6, 'Port J Interrupt Enable Register', { bits: pj.replace(/\*/g, 'PIEJ') }],
    ['PIFJ', 7, 'Port J Interrupt Flag Register', { bits: pj.replace(/\*/g, 'PIFJ'), access: 'w1c' }],
  ], pj);
  // Port AD bit names per CodeWarrior: <REG><global AD1 channel>, e.g. PT0AD1 bit 0 = PT0AD116 (AN16 of the
  // combined numbering), PT1AD1 bit 0 = PT1AD18.
  out.push(
    reg(M, 'PT1AD0', 0x0271, 'Port AD0 I/O Register 1', { bits: 'PT1AD0#8' }),
    reg(M, 'DDR1AD0', 0x0273, 'Port AD0 Data Direction Register 1', { bits: 'DDR1AD0#8' }),
    reg(M, 'RDR1AD0', 0x0275, 'Port AD0 Reduced Drive Register 1', { bits: 'RDR1AD0#8' }),
    reg(M, 'PER1AD0', 0x0277, 'Port AD0 Pull Up Enable Register 1', { bits: 'PER1AD0#8' }),
    reg(M, 'PT0AD1', 0x0278, 'Port AD1 I/O Register 0', { bits: 'PT0AD1#23:16' }),
    reg(M, 'PT1AD1', 0x0279, 'Port AD1 I/O Register 1', { bits: 'PT1AD1#15:8' }),
    reg(M, 'DDR0AD1', 0x027a, 'Port AD1 Data Direction Register 0', { bits: 'DDR0AD1#23:16' }),
    reg(M, 'DDR1AD1', 0x027b, 'Port AD1 Data Direction Register 1', { bits: 'DDR1AD1#15:8' }),
    reg(M, 'RDR0AD1', 0x027c, 'Port AD1 Reduced Drive Register 0', { bits: 'RDR0AD1#23:16' }),
    reg(M, 'RDR1AD1', 0x027d, 'Port AD1 Reduced Drive Register 1', { bits: 'RDR1AD1#15:8' }),
    reg(M, 'PER0AD1', 0x027e, 'Port AD1 Pull Up Enable Register 0', { bits: 'PER0AD1#23:16' }),
    reg(M, 'PER1AD1', 0x027f, 'Port AD1 Pull Up Enable Register 1', { bits: 'PER1AD1#15:8' }),
  );
  return out;
}

// ---------------------------------------------------------------- VREG / PWM / PIT / XGATE
function vreg(): RegisterDef[] {
  const M = 'VREG';
  return [
    reg(M, 'VREGHTCL', 0x02f0, 'Voltage Regulator High Temperature Control Register', { access: 'test' }),
    reg(M, 'VREGCTRL', 0x02f1, 'Voltage Regulator Control Register', { bits: '- - - - - LVDS LVIE LVIF', access: 'w1c', w1cMask: 0x01 }),
    reg(M, 'VREGAPICL', 0x02f2, 'Autonomous Periodical Interrupt Control Register', {
      bits: 'APICLK - - - - APIFE APIE APIF',
      access: 'w1c',
      w1cMask: 0x01,
    }),
    reg(M, 'VREGAPITR', 0x02f3, 'Autonomous Periodical Interrupt Trimming Register', { bits: 'APITR[6] - -' }),
    reg(M, 'VREGAPIR', 0x02f4, 'Autonomous Periodical Interrupt Rate Register', {
      size: 2,
      bits: '- - - - APIR[12]',
      halves: ['VREGAPIRH', 'VREGAPIRL'],
    }),
  ];
}

function pwm(): RegisterDef[] {
  const M = 'PWM';
  const r: RegisterDef[] = [
    reg(M, 'PWME', 0x0300, 'PWM Enable Register', { bits: 'PWME#8' }),
    reg(M, 'PWMPOL', 0x0301, 'PWM Polarity Register', { bits: 'PPOL#8' }),
    reg(M, 'PWMCLK', 0x0302, 'PWM Clock Select Register', { bits: 'PCLK#8' }),
    reg(M, 'PWMPRCLK', 0x0303, 'PWM Prescale Clock Select Register', { bits: '- PCKB[3] - PCKA[3]' }),
    reg(M, 'PWMCAE', 0x0304, 'PWM Center Align Enable Register', { bits: 'CAE#8' }),
    reg(M, 'PWMCTL', 0x0305, 'PWM Control Register', { bits: 'CON67 CON45 CON23 CON01 PSWAI PFRZ - -' }),
    reg(M, 'PWMTST', 0x0306, 'PWM Test Register', { access: 'test' }),
    reg(M, 'PWMPRSC', 0x0307, 'PWM Prescale Counter Register', { access: 'test' }),
    reg(M, 'PWMSCLA', 0x0308, 'PWM Scale A Register', { bits: 'D' }),
    reg(M, 'PWMSCLB', 0x0309, 'PWM Scale B Register', { bits: 'D' }),
    reg(M, 'PWMSCNTA', 0x030a, 'PWM Scale A Counter Register', { access: 'test' }),
    reg(M, 'PWMSCNTB', 0x030b, 'PWM Scale B Counter Register', { access: 'test' }),
  ];
  for (let i = 0; i < 8; i++) r.push(reg(M, `PWMCNT${i}`, 0x030c + i, `PWM Channel Counter Register ${i}`));
  for (let i = 0; i < 8; i++)
    r.push(reg(M, `PWMPER${i}`, 0x0314 + i, `PWM Channel Period Register ${i}`, { reset: 0xff }));
  for (let i = 0; i < 8; i++)
    r.push(reg(M, `PWMDTY${i}`, 0x031c + i, `PWM Channel Duty Register ${i}`, { reset: 0xff }));
  r.push(
    reg(M, 'PWMSDN', 0x0324, 'PWM Shutdown Register', {
      bits: 'PWMIF PWMIE PWMRSTRT PWMLVL - PWM7IN PWM7INL PWM7ENA',
      access: 'w1c',
      w1cMask: 0x80,
    }),
  );
  return r;
}

function pit(): RegisterDef[] {
  const M = 'PIT';
  const r: RegisterDef[] = [
    reg(M, 'PITCFLMT', 0x0340, 'PIT Control and Force Load Micro Timer Register', { bits: 'PITE PITSWAI PITFRZ - - - PFLMT1 PFLMT0' }),
    reg(M, 'PITFLT', 0x0341, 'PIT Force Load Timer Register', { bits: '- - - - PFLT3 PFLT2 PFLT1 PFLT0', access: 'w' }),
    reg(M, 'PITCE', 0x0342, 'PIT Channel Enable Register', { bits: '- - - - PCE3 PCE2 PCE1 PCE0' }),
    reg(M, 'PITMUX', 0x0343, 'PIT Multiplex Register', { bits: '- - - - PMUX3 PMUX2 PMUX1 PMUX0' }),
    reg(M, 'PITINTE', 0x0344, 'PIT Interrupt Enable Register', { bits: '- - - - PINTE3 PINTE2 PINTE1 PINTE0' }),
    reg(M, 'PITTF', 0x0345, 'PIT Time-Out Flag Register', { bits: '- - - - PTF3 PTF2 PTF1 PTF0', access: 'w1c' }),
    reg(M, 'PITMTLD0', 0x0346, 'PIT Micro Timer Load Register 0', { bits: 'PMTLD#8' }),
    reg(M, 'PITMTLD1', 0x0347, 'PIT Micro Timer Load Register 1', { bits: 'PMTLD#8' }),
  ];
  for (let i = 0; i < 4; i++) {
    r.push(reg(M, `PITLD${i}`, 0x0348 + 4 * i, `PIT Load Register ${i}`, w16({ halves: null })));
    r.push(reg(M, `PITCNT${i}`, 0x034a + 4 * i, `PIT Count Register ${i}`, w16({ access: 'r', halves: null })));
  }
  return r;
}

function xgate(): RegisterDef[] {
  const M = 'XGATE';
  // Names, addresses, sizes and bit names per CodeWarrior's header; reset values/access not modelled (no XGATE core).
  const u = 'XGATE reset values/access not modelled';
  const h = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  const r: RegisterDef[] = [
    reg(M, 'XGMCTL', 0x0380, 'XGATE Module Control Register', {
      size: 2,
      halves: null,
      bits: 'XGEM XGFRZM XGDBGM XGSSM XGFACTM - XGSWEIFM XGIEM XGE XGFRZ XGDBG XGSS XGFACT - XGSWEIF XGIE',
      uncertain: u,
    }),
    reg(M, 'XGCHID', 0x0382, 'XGATE Channel ID Register', { bits: '- XGCHID(7)', access: 'r', uncertain: u }),
    reg(M, 'XGVBR', 0x0386, 'XGATE Vector Base Address Register', { size: 2, halves: null, bits: 'XGVBR(15) -', uncertain: u }),
  ];
  for (let i = 0; i < 8; i++) {
    const hi = (7 - i) * 16 + 15;
    const lo = (7 - i) * 16;
    // One flag per XGATE channel; channels $09-$78 exist.
    const toks: string[] = [];
    for (let b = 15; b >= 0; b--) {
      const ch = lo + b;
      toks.push(ch >= 0x09 && ch <= 0x78 ? `XGIF_${h(ch)}` : '-');
    }
    r.push(
      reg(M, `XGIF_${h(hi)}_${h(lo)}`, 0x0388 + 2 * i, `XGATE Channel Interrupt Flag Vector ${h(hi)}-${h(lo)}`, {
        size: 2,
        halves: null,
        bits: toks.join(' '),
        access: 'w1c',
        uncertain: u,
      }),
    );
  }
  r.push(
    // XGSWTM/XGSEMM are the write masks for the low byte; per-bit names XGSWTn/XGSEMn are ours (CW: group only).
    reg(M, 'XGSWT', 0x0398, 'XGATE Software Trigger Register', { size: 2, halves: null, bits: 'XGSWTM(8) XGSWT[8]', uncertain: u }),
    reg(M, 'XGSEM', 0x039a, 'XGATE Semaphore Register', { size: 2, halves: null, bits: 'XGSEMM(8) XGSEM[8]', uncertain: u }),
    reg(M, 'XGCCR', 0x039d, 'XGATE Condition Code Register', { bits: '- - - - XGN XGZ XGV XGC', uncertain: u }),
    reg(M, 'XGPC', 0x039e, 'XGATE Program Counter Register', { size: 2, halves: null, uncertain: u }),
  );
  for (let i = 1; i <= 7; i++)
    r.push(reg(M, `XGR${i}`, 0x03a2 + 2 * (i - 1), `XGATE Register ${i}`, { size: 2, halves: null, uncertain: u }));
  return r;
}

const byAddr = (a: RegisterDef, b: RegisterDef) => a.address - b.address;

/** Canonical, non-overlapping register list for $0000-$07FF, sorted by address. */
export const REGISTERS: readonly RegisterDef[] = [
  ...core(),
  ...dbg(),
  ...crg(),
  ...ect(),
  ...atd(1, 0x0080),
  ...iic(1, 0x00b0),
  ...sci(2, 0x00b8),
  ...sci(3, 0x00c0),
  ...sci(0, 0x00c8),
  ...sci(1, 0x00d0),
  ...spi(0, 0x00d8),
  ...iic(0, 0x00e0),
  ...spi(1, 0x00f0),
  ...spi(2, 0x00f8),
  ...nvm(),
  ...sci(4, 0x0130),
  ...sci(5, 0x0138),
  ...can(0, 0x0140),
  ...can(1, 0x0180),
  ...can(2, 0x01c0),
  ...can(3, 0x0200),
  ...pim(),
  ...can(4, 0x0280),
  ...atd(0, 0x02c0),
  ...vreg(),
  ...pwm(),
  ...pit(),
  ...xgate(),
].sort(byAddr);

const canon = new Map(REGISTERS.map((r) => [r.name, r]));

/**
 * Bits of a composite: high-byte bits moved up by 8, low-byte bits as-is (as CodeWarrior does for PORTAB, ATD0CTL23,
 * ...). A field present in both bytes under the same name is merged when contiguous (ATD1DIEN.IEN = IEN15..IEN0),
 * otherwise dropped. If single-bit names clash, the composite gets no bits.
 */
function compositeBits(h: RegisterDef, l: RegisterDef): BitField[] | undefined {
  if (!h.bits || !l.bits) return undefined;
  const hb = h.bits.map((b) => ({ ...b, bit: b.bit + 8 }));
  const lb = l.bits.map((b) => ({ ...b }));
  const out: BitField[] = [];
  const lowByName = new Map(lb.map((b) => [b.name, b]));
  const merged = new Set<string>();
  for (const b of hb) {
    const twin = lowByName.get(b.name);
    if (!twin) {
      out.push(b);
      continue;
    }
    if (b.width === 1 || twin.width === 1) return undefined; // clashing single-bit names
    if (twin.bit + twin.width === 8 && b.bit === 8) out.push({ name: b.name, bit: twin.bit, width: twin.width + b.width });
    merged.add(b.name);
  }
  for (const b of lb) if (!merged.has(b.name)) out.push(b);
  return out.sort((a, b) => b.bit + b.width - (a.bit + a.width) || b.width - a.width);
}

/** 16-bit concatenation of two canonical 8-bit registers (high byte first). */
function composite(name: string, hi: string, lo: string, description: string): RegisterAlias {
  const h = canon.get(hi);
  const l = canon.get(lo);
  if (!h || !l || h.size !== 1 || l.size !== 1 || l.address !== h.address + 1)
    throw new Error(`bad composite ${name}=${hi}:${lo}`);
  const a: RegisterAlias = {
    name,
    address: h.address,
    size: 2,
    module: h.module,
    reset: (h.reset << 8) | l.reset,
    access: h.access,
    description,
    aliasOf: [hi, lo],
    composite: true,
  };
  const bits = compositeBits(h, l);
  if (bits) a.bits = bits;
  return a;
}

function aliases(): RegisterAlias[] {
  const a: RegisterAlias[] = [
    composite('PORTAB', 'PORTA', 'PORTB', 'Port AB Register'),
    composite('DDRAB', 'DDRA', 'DDRB', 'Port AB Data Direction Register'),
    composite('PORTCD', 'PORTC', 'PORTD', 'Port CD Register'),
    composite('DDRCD', 'DDRC', 'DDRD', 'Port CD Data Direction Register'),
    composite('PACN32', 'PACN3', 'PACN2', 'Pulse Accumulators Count 32 Register'),
    composite('PACN10', 'PACN1', 'PACN0', 'Pulse Accumulators Count 10 Register'),
    composite('PA32H', 'PA3H', 'PA2H', '8-Bit Pulse Accumulators Holding 32 Register'),
    composite('PA10H', 'PA1H', 'PA0H', '8-Bit Pulse Accumulators Holding 10 Register'),
    composite('ATD1DIEN', 'ATD1DIEN0', 'ATD1DIEN1', 'ATD 1 Input Enable Register'),
    composite('ATD1PTAD', 'ATD1PTAD0', 'ATD1PTAD1', 'Port AD1 Data Register'),
    composite('PT01AD1', 'PT0AD1', 'PT1AD1', 'Port AD1 I/O Register'),
    composite('DDR01AD1', 'DDR0AD1', 'DDR1AD1', 'Port AD1 Data Direction Register'),
    composite('RDR01AD1', 'RDR0AD1', 'RDR1AD1', 'Port AD1 Reduced Drive Register'),
    composite('PER01AD1', 'PER0AD1', 'PER1AD1', 'Port AD1 Pull Up Enable Register'),
  ];
  for (const n of [0, 1]) {
    const p = `ATD${n}`;
    a.push(
      composite(`${p}CTL01`, `${p}CTL0`, `${p}CTL1`, `ATD ${n} Control Register 01`),
      composite(`${p}CTL23`, `${p}CTL2`, `${p}CTL3`, `ATD ${n} Control Register 23`),
      composite(`${p}CTL45`, `${p}CTL4`, `${p}CTL5`, `ATD ${n} Control Register 45`),
    );
  }
  for (const k of ['CNT', 'PER', 'DTY'] as const)
    for (const [i, j] of [[0, 1], [2, 3], [4, 5], [6, 7]])
      a.push(composite(`PWM${k}${i}${j}`, `PWM${k}${i}`, `PWM${k}${j}`, `PWM Channel ${k === 'CNT' ? 'Counter' : k === 'PER' ? 'Period' : 'Duty'} Register ${i}${j}`));
  for (const [n, base] of [[0, 0xc8], [1, 0xd0], [2, 0xb8], [3, 0xc0], [4, 0x130], [5, 0x138]] as const)
    a.push(...sciAliases(n, base));
  // $0027 is DBGSCRX while the S12XDBG is disarmed and DBGMFR (read-only match flags) while armed.
  a.push({
    ...reg('DBG', 'DBGMFR', 0x0027, 'Debug Match Flag Register', { bits: '- - - - MC[4]', access: 'r' }),
    aliasOf: ['DBGSCRX'],
    composite: false,
  });
  return a.sort(byAddr);
}

export const REGISTER_ALIASES: readonly RegisterAlias[] = aliases();
