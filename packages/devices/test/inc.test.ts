import { describe, expect, it } from 'vitest';
import { INC_LINE_PATTERNS, MC9S12XDP512, VECTORS, generateIncFile, registerByName } from '../src/index.js';

const inc = generateIncFile(MC9S12XDP512);
const lines = inc.split('\r\n');

function symbols(): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of lines) {
    const x = INC_LINE_PATTERNS.equ.exec(l);
    if (x) m.set(x[1], x[2]);
  }
  return m;
}

describe('generateIncFile', () => {
  it('is non-empty CRLF text ending in CRLF with no bare LF', () => {
    expect(inc.length).toBeGreaterThan(50_000);
    expect(inc.endsWith('\r\n')).toBe(true);
    expect(/[^\r]\n/.test(inc)).toBe(false);
    expect(/\r(?!\n)/.test(inc)).toBe(false);
  });

  it('every line matches the documented style', () => {
    lines.pop(); // empty string after the final CRLF
    const bad = lines.filter(
      (l) => !INC_LINE_PATTERNS.equ.test(l) && !INC_LINE_PATTERNS.comment.test(l) && !INC_LINE_PATTERNS.blank.test(l),
    );
    expect(bad).toEqual([]);
    lines.push('');
  });

  it('register lines carry the ;*** NAME - desc; 0x... *** comment', () => {
    const regLine = lines.find((l) => l.startsWith('PORTB:'))!;
    expect(regLine).toMatch(INC_LINE_PATTERNS.register);
    expect(regLine).toMatch(/^PORTB:\s+equ\s+\$00000001\s+;\*\*\* PORTB - Port B Register; 0x00000001 \*\*\*$/);
    let regs = 0;
    for (const r of MC9S12XDP512.registers) {
      const l = lines.find((x) => x.startsWith(`${r.name}:`));
      expect(l, r.name).toBeDefined();
      expect(l!, r.name).toMatch(INC_LINE_PATTERNS.register);
      regs++;
    }
    expect(regs).toBe(MC9S12XDP512.registers.length);
  });

  it('has no duplicate symbols (case-insensitive)', () => {
    const seen = new Set<string>();
    for (const l of lines) {
      const x = INC_LINE_PATTERNS.equ.exec(l);
      if (!x) continue;
      const k = x[1].toUpperCase();
      expect(seen.has(k), x[1]).toBe(false);
      seen.add(k);
    }
    expect(seen.size).toBeGreaterThan(3000);
  });

  it('defines register, bit, mask, half, memory-map and vector symbols with the right values', () => {
    const s = symbols();
    expect(s.get('PTP')).toBe('$00000258');
    expect(s.get('DDRP')).toBe('$0000025A');
    expect(s.get('PORTB')).toBe('$00000001');
    expect(s.get('PTP_PTP4')).toBe('4');
    expect(s.get('mPTP_PTP4')).toBe('%00010000');
    // CodeWarrior's XDP512 header names (review finding 8): PORTB_PB0, not the DP256-style PORTB_BIT0.
    expect(s.get('PORTB_PB0')).toBe('0');
    expect(s.get('mPORTB_PB7')).toBe('%10000000');
    expect(s.has('PORTB_BIT0')).toBe(false);
    expect(s.get('mDDRB_DDRB3')).toBe('%00001000');
    expect(s.get('mPORTK_PK5')).toBe('%00100000');
    expect(s.get('mPORTAB_PA0')).toBe('%0000000100000000');
    expect(s.get('mPORTAB_PB0')).toBe('%0000000000000001');
    expect(s.get('mATD1CTL23_ADPU')).toBe('%1000000000000000');
    expect(s.get('mPARTIDH_ID15')).toBe('%10000000');
    expect(s.get('mFSTAT_FAIL')).toBe('%00000010');
    expect(s.get('mECLKCTL_EDIV')).toBe('%00000011');
    expect(s.has('ECLKCTL_DIV16')).toBe(false);
    expect(s.get('mPTJ_PTJ5')).toBe('%00100000');
    expect(s.get('mRAMWPC_RWPE')).toBe('%10000000');
    expect(s.get('MCCNThi')).toBe('$00000076');
    expect(s.get('MCCNTlo')).toBe('$00000077');
    expect(s.get('TC3Hhi')).toBe('$0000007E');
    expect(s.get('CAN0RXTSRH')).toBe('$0000016E');
    expect(s.get('CAN4TXTSRL')).toBe('$000002BF');
    expect(s.get('DBGMFR')).toBe('$00000027');
    expect(s.get('TSCR1_TFFCA')).toBe('4');
    expect(s.get('mTSCR1_TFFCA')).toBe('%00010000');
    expect(s.get('mCRGFLG_LOCK')).toBe('%00001000');
    expect(s.get('mCLKSEL_PLLSEL')).toBe('%10000000');
    expect(s.get('mSYNR_SYN')).toBe('%00111111');
    expect(s.get('mPIFJ_PIFJ7')).toBe('%10000000');
    expect(s.get('TCNT')).toBe('$00000044');
    expect(s.get('TCNTHi')).toBe('$00000044');
    expect(s.get('TCNTLo')).toBe('$00000045');
    expect(s.has('TCNT_BIT15')).toBe(false); // plain data registers carry no bit equates (as in CW)
    expect(s.get('SCI0BDH')).toBe('$000000C8');
    expect(s.get('SCI0BDL')).toBe('$000000C9');
    expect(s.get('mSCI0BDH_IREN')).toBe('%10000000');
    expect(s.get('SCI0ASR1')).toBe('$000000C8');
    expect(s.get('PWMDTY01')).toBe('$0000031C');
    expect(s.get('PWMDTY0')).toBe('$0000031C');
    expect(s.get('PACN32')).toBe('$00000062');
    expect(s.get('IIC0_IBCR')).toBe('$000000E2');
    expect(s.get('RAMStart')).toBe('$00002000');
    expect(s.get('RAMEnd')).toBe('$00003FFF');
    expect(s.get('ROM_4000Start')).toBe('$00004000');
    expect(s.get('ROM_C000Start')).toBe('$0000C000');
    expect(s.get('EEPROMStart')).toBeDefined();
    expect(s.get('PAGE_E0Start')).toBe('$00E08000');
    expect(s.get('PAGE_E0End')).toBe('$00E0BFFF');
    expect(s.get('PAGE_FEStart')).toBe('$00FE8000');
    expect(s.get('Vreset')).toBe('$0000FFFE');
    expect(s.get('Vportj')).toBe('$0000FFCE');
    for (const v of VECTORS) expect(s.get(v.name), v.name).toBe(`$0000${v.address.toString(16).toUpperCase()}`);
  });

  it('bit-number equates are 0..15 and masks agree with bit numbers', () => {
    const s = symbols();
    for (const [name, value] of s) {
      if (!name.startsWith('m')) continue;
      const bitName = name.slice(1);
      const n = s.get(bitName);
      if (n === undefined || !/^\d+$/.test(n) || !value.startsWith('%')) continue;
      const m = parseInt(value.slice(1), 2);
      expect(m & -m, name).toBe(1 << Number(n)); // lowest set bit of mask == bit number
    }
  });

  it('every name in the register table resolves through registerByName or appears in the .inc', () => {
    const s = symbols();
    for (const r of [...MC9S12XDP512.registers, ...MC9S12XDP512.aliases]) {
      expect(s.has(r.name), r.name).toBe(true);
      expect(registerByName(r.name), r.name).toBeDefined();
    }
  });

  it('LF option and bit suppression', () => {
    const lf = generateIncFile(MC9S12XDP512, { eol: '\n', bits: false });
    expect(lf.includes('\r')).toBe(false);
    expect(lf).not.toMatch(/^PTP_PTP0:/m);
    expect(lf).toMatch(/^PTP:/m);
  });
});
