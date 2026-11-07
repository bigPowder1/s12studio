/**
 * MC9S12XDP512 interrupt vector table (S12XINTV1, datasheet Table 1-12), see docs/research/r2/xdp512-device.md §8
 * and critique C5/C6.
 *
 * Names follow the CodeWarrior `VectorNumber_Vxxx` / `Vxxx` spelling. Offsets are relative to the vector base
 * (IVBR:00); `address` assumes the reset IVBR = $FF.
 */
import type { VectorDef, VectorKind } from '../types.js';

interface Row {
  offset: number;
  name: string;
  source: string;
  kind: VectorKind;
  mask?: 'I' | 'X' | null;
  xg?: number | null;
  flags?: string[];
  enables?: string[];
  aliases?: string[];
  uncertain?: string;
}

const I = (
  offset: number,
  name: string,
  source: string,
  xg: number | null,
  flags: string[],
  enables: string[],
  extra: Partial<Row> = {},
): Row => ({ offset, name, source, kind: 'maskable', mask: 'I', xg, flags, enables, ...extra });

const bitsOf = (reg: string, names: string[]) => names.map((n) => `${reg}.${n}`);
const port8 = (reg: string, bits: number[]) => bits.map((b) => `${reg}.${reg}${b}`);
const PJ_BITS = [0, 1, 2, 4, 5, 6, 7];
const ALL8 = [0, 1, 2, 3, 4, 5, 6, 7];
const sciFlags = (n: number) => bitsOf(`SCI${n}SR1`, ['TDRE', 'TC', 'RDRF', 'OR', 'IDLE']);
const sciEnables = (n: number) => bitsOf(`SCI${n}CR2`, ['TIE', 'TCIE', 'RIE', 'ILIE']);

function rows(): Row[] {
  const r: Row[] = [
    { offset: 0xfe, name: 'Vreset', source: 'Reset (power-on, low-voltage, external pin, illegal address)', kind: 'reset' },
    { offset: 0xfc, name: 'Vclkmon', source: 'Clock monitor fail reset', kind: 'reset', enables: ['PLLCTL.CME', 'PLLCTL.SCME'] },
    { offset: 0xfa, name: 'Vcop', source: 'COP watchdog reset', kind: 'reset', enables: ['COPCTL.CR'] },
    { offset: 0xf8, name: 'Vtrap', source: 'Unimplemented instruction trap', kind: 'non-maskable' },
    { offset: 0xf6, name: 'Vswi', source: 'SWI instruction', kind: 'non-maskable' },
    { offset: 0xf4, name: 'Vxirq', source: 'XIRQ pin', kind: 'xirq', mask: 'X' },
    I(0xf2, 'Virq', 'IRQ pin', null, [], ['IRQCR.IRQEN']),
    I(0xf0, 'Vrti', 'Real-time interrupt', 0x78, ['CRGFLG.RTIF'], ['CRGINT.RTIE']),
  ];
  for (let c = 0; c < 8; c++)
    r.push(I(0xee - 2 * c, `Vtimch${c}`, `Enhanced capture timer channel ${c}`, 0x77 - c, [`TFLG1.C${c}F`], [`TIE.C${c}I`]));
  r.push(
    I(0xde, 'Vtimovf', 'Enhanced capture timer overflow', 0x6f, ['TFLG2.TOF'], ['TSCR2.TOI']),
    I(0xdc, 'Vtimpaaovf', 'Pulse accumulator A overflow', 0x6e, ['PAFLG.PAOVF'], ['PACTL.PAOVI']),
    I(0xda, 'Vtimpaie', 'Pulse accumulator input edge', 0x6d, ['PAFLG.PAIF'], ['PACTL.PAI']),
    I(0xd8, 'Vspi0', 'SPI0', 0x6c, ['SPI0SR.SPIF', 'SPI0SR.SPTEF', 'SPI0SR.MODF'], ['SPI0CR1.SPIE', 'SPI0CR1.SPTIE']),
    I(0xd6, 'Vsci0', 'SCI0', 0x6b, sciFlags(0), sciEnables(0)),
    I(0xd4, 'Vsci1', 'SCI1', 0x6a, sciFlags(1), sciEnables(1)),
    I(0xd2, 'Vatd0', 'ATD0 sequence complete', 0x69, ['ATD0CTL2.ASCIF'], ['ATD0CTL2.ASCIE']),
    I(0xd0, 'Vatd1', 'ATD1 sequence complete', 0x68, ['ATD1CTL2.ASCIF'], ['ATD1CTL2.ASCIE']),
    I(0xce, 'Vportj', 'Port J key wakeup', 0x67, port8('PIFJ', PJ_BITS), port8('PIEJ', PJ_BITS)),
    I(0xcc, 'Vporth', 'Port H key wakeup', 0x66, port8('PIFH', ALL8), port8('PIEH', ALL8)),
    I(0xca, 'Vtimmdcu', 'Modulus down counter underflow', 0x65, ['MCFLG.MCZF'], ['MCCTL.MCZI']),
    I(0xc8, 'Vtimpabovf', 'Pulse accumulator B overflow', 0x64, ['PBFLG.PBOVF'], ['PBCTL.PBOVI']),
    I(0xc6, 'Vcrgplllck', 'CRG PLL lock', 0x63, ['CRGFLG.LOCKIF'], ['CRGINT.LOCKIE']),
    I(0xc4, 'Vcrgscm', 'CRG self-clock mode', 0x62, ['CRGFLG.SCMIF'], ['CRGINT.SCMIE']),
    { offset: 0xc2, name: 'Vreserved30', source: 'Reserved', kind: 'reserved', mask: 'I' },
    I(0xc0, 'Viic0', 'IIC0 bus', 0x60, ['IIC0_IBSR.IBIF'], ['IIC0_IBCR.IBIE']),
    I(0xbe, 'Vspi1', 'SPI1', 0x5f, ['SPI1SR.SPIF', 'SPI1SR.SPTEF', 'SPI1SR.MODF'], ['SPI1CR1.SPIE', 'SPI1CR1.SPTIE']),
    I(0xbc, 'Vspi2', 'SPI2', 0x5e, ['SPI2SR.SPIF', 'SPI2SR.SPTEF', 'SPI2SR.MODF'], ['SPI2CR1.SPIE', 'SPI2CR1.SPTIE']),
    I(0xba, 'Veeprom', 'EEPROM command', 0x5d, ['ESTAT.CBEIF', 'ESTAT.CCIF'], ['ECNFG.CBEIE', 'ECNFG.CCIE']),
    I(0xb8, 'Vflash', 'Flash command', 0x5c, ['FSTAT.CBEIF', 'FSTAT.CCIF'], ['FCNFG.CBEIE', 'FCNFG.CCIE']),
  );
  const canKinds: Array<[string, string]> = [['wkup', 'wake-up'], ['err', 'errors'], ['rx', 'receive'], ['tx', 'transmit']];
  for (let n = 0; n < 5; n++)
    canKinds.forEach(([k, d], j) => {
      const off = 0xb6 - 8 * n - 2 * j;
      r.push(I(off, `Vcan${n}${k}`, `CAN${n} ${d}`, off / 2, ...canSources(n, k)));
    });
  r.push(
    I(0x8e, 'Vportp', 'Port P key wakeup', 0x47, port8('PIFP', ALL8), port8('PIEP', ALL8)),
    I(0x8c, 'Vpwmesdn', 'PWM emergency shutdown', 0x46, ['PWMSDN.PWMIF'], ['PWMSDN.PWMIE']),
    I(0x8a, 'Vsci2', 'SCI2', 0x45, sciFlags(2), sciEnables(2)),
    I(0x88, 'Vsci3', 'SCI3', 0x44, sciFlags(3), sciEnables(3)),
    I(0x86, 'Vsci4', 'SCI4', 0x43, sciFlags(4), sciEnables(4)),
    I(0x84, 'Vsci5', 'SCI5', 0x42, sciFlags(5), sciEnables(5)),
    I(0x82, 'Viic1', 'IIC1 bus', 0x41, ['IIC1_IBSR.IBIF'], ['IIC1_IBCR.IBIE']),
    I(0x80, 'Vlvi', 'Low-voltage interrupt', 0x40, ['VREGCTRL.LVIF'], ['VREGCTRL.LVIE']),
    I(0x7e, 'Vapi', 'Autonomous periodical interrupt', 0x3f, ['VREGAPICL.APIF'], ['VREGAPICL.APIE']),
    { offset: 0x7c, name: 'Vreserved65', source: 'Reserved', kind: 'reserved', mask: 'I' },
  );
  for (let c = 0; c < 4; c++)
    r.push(I(0x7a - 2 * c, `Vpit${c}`, `Periodic interrupt timer channel ${c}`, 0x3d - c, [`PITTF.PTF${c}`], [`PITINTE.PINTE${c}`]));
  for (let c = 0; c < 8; c++)
    r.push(
      I(0x72 - 2 * c, `Vxst${c}`, `XGATE software trigger ${c}`, 0x39 - c, [`XGSWT.XGSWT${c}`], ['XGMCTL.XGIE'], {
        uncertain: 'CW name; XGIE as the enable',
      }),
    );
  r.push(
    I(0x62, 'Vxsei', 'XGATE software error interrupt', null, ['XGMCTL.XGSWEIF'], ['XGMCTL.XGIE'], { uncertain: 'CW name' }),
    I(0x60, 'Vxsramav', 'S12X RAM access violation', null, ['RAMWPC.AVIF'], ['RAMWPC.AVIE'], { uncertain: 'CW name' }),
  );
  for (let off = 0x5e; off >= 0x14; off -= 2)
    r.push({ offset: off, name: `Vreserved${(0xfe - off) / 2}`, source: 'Reserved', kind: 'reserved', mask: 'I' });
  r.push(
    {
      offset: 0x12,
      name: 'Vsyscall',
      source: 'SYS instruction',
      kind: 'non-maskable',
      uncertain: 'device Table 1-12 lists $12 as reserved; SYS -> IVBR:$12 comes from the S12XCPU RM (critique C5); CW name',
    },
    // UNCERTAIN: CW spelling of the spurious vector ($FF10) is assumed to be Vsi; Vspurious accepted as alias.
    {
      offset: 0x10,
      name: 'Vsi',
      aliases: ['Vspurious'],
      source: 'Spurious interrupt',
      kind: 'spurious',
      uncertain: 'CW spelling Vsi assumed',
    },
  );
  return r;
}

/** MSCAN interrupt sources per vector kind (flags, enables). */
function canSources(n: number, k: string): [string[], string[]] {
  const f = `CAN${n}RFLG`;
  const e = `CAN${n}RIER`;
  switch (k) {
    case 'wkup': return [[`${f}.WUPIF`], [`${e}.WUPIE`]];
    case 'err': return [[`${f}.CSCIF`, `${f}.OVRIF`], [`${e}.CSCIE`, `${e}.OVRIE`]];
    case 'rx': return [[`${f}.RXF`], [`${e}.RXFIE`]];
    default: return [[0, 1, 2].map((i) => `CAN${n}TFLG.TXE${i}`), [0, 1, 2].map((i) => `CAN${n}TIER.TXEIE${i}`)];
  }
}

/** Fixed hardware priority rank (0 = highest), critique C6 / research §8. */
function rank(row: Row): number {
  switch (row.name) {
    case 'Vreset': return 0;
    case 'Vclkmon': return 1;
    case 'Vcop': return 2;
    case 'Vtrap': return 3;
    case 'Vswi': return 4;
    case 'Vsyscall': return 4; // instruction-synchronous like SWI; UNCERTAIN
    case 'Vxirq': return 5;
    case 'Vsi': return 1000;
    default: return 6 + (0xf2 - row.offset) / 2; // IRQ first, then descending vector address
  }
}

export const VECTORS: readonly VectorDef[] = rows()
  .map((row): VectorDef => {
    const fixed = row.offset >= 0xfa;
    const maskable = row.kind === 'maskable';
    const v: VectorDef = {
      name: row.name,
      offset: row.offset,
      address: 0xff00 + row.offset,
      number: (0xfe - row.offset) / 2,
      source: row.source,
      kind: row.kind,
      fixed,
      mask: row.mask ?? null,
      priorityRank: rank(row),
      defaultLevel: maskable ? 1 : null,
      xgateChannel: row.xg ?? null,
      flags: row.flags ?? [],
      enables: row.enables ?? [],
    };
    if (row.aliases) v.aliases = row.aliases;
    if (row.uncertain) v.uncertain = row.uncertain;
    return v;
  })
  .sort((a, b) => b.offset - a.offset);

/** Absolute vector address for a given IVBR (only $FFFA-$FFFE ignore IVBR). */
export function vectorAddress(v: VectorDef, ivbr = 0xff): number {
  return v.fixed ? 0xff00 + v.offset : ((ivbr & 0xff) << 8) | v.offset;
}
