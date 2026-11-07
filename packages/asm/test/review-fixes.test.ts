/**
 * Regression tests for the round-1 review findings: \0 keeps the size as written, A1057, -Lasmc/-Lasms columns,
 * -WmsgFonf/-WmsgFonp formats, the Latin-1 text contract (A9005) and macro call-site positions.
 */
import { describe, expect, it } from 'vitest';
import { encodeLatin1, formatMessage, type AsmMessage } from '../src/index.js';
import { asmSource, hex, listingBody, sectionBytes } from './helpers.js';

describe('macro \\0 substitution', () => {
  it('substitutes the size suffix exactly as written at the call (listing and .dbg)', () => {
    const r = asmSource(['rep: MACRO', ' dc.\\0 \\1', ' ENDM', ' ORG 0', ' rep.w 3', ' rep.B 4'].join('\n'));
    expect(r.messages).toEqual([]);
    expect(hex(sectionBytes(r, '_ORG00001'))).toBe('00 03 04');
    const dbg = r.dbg.text.split('\r\n');
    expect(dbg).toContain(' dc.w 3');
    expect(dbg).toContain(' dc.B 4');
    expect(listingBody(r.listing!.text).some((l) => l.endsWith('+ dc.w 3'))).toBe(true);
  });
});

describe('A1057 constant overflow', () => {
  it('warns and keeps the low 32 bits (manual example DC $123456789)', () => {
    const r = asmSource(' ORG 0\n DC.L $123456789\n');
    expect(r.messages.map((m) => [m.code, m.severity, m.column])).toEqual([['A1057', 'WARNING', 7]]);
    expect(hex(sectionBytes(r, '_ORG00001'))).toBe('23 45 67 89');
    expect(r.ok).toBe(true);
  });
  it('covers every radix and the MASM suffixes, but not 32-bit values', () => {
    for (const c of ['4294967296', '%1' + '0'.repeat(32), '@40000000000', '100000000h']) {
      expect(asmSource(` ORG 0\n DC.L ${c}\n`).messages.map((m) => m.code)).toEqual(['A1057']);
    }
    for (const c of ['4294967295', '$FFFFFFFF', '%' + '1'.repeat(32), '@37777777777']) {
      expect(asmSource(` ORG 0\n DC.L ${c}\n`).messages).toEqual([]);
    }
  });
  it('is reported once although the expression is evaluated in both passes', () => {
    expect(asmSource(' ORG 0\n LDD #$100000000\n').messages.map((m) => m.code)).toEqual(['A1057']);
  });
});

describe('-Lasmc / -Lasms listing columns', () => {
  const src = ' ORG $10\n DC.B "Hello World"\n DC.B 0\n';
  const lst = (opts: string) => asmSource(src, `-CpuHCS12X -L ${opts}`).listing!.text.split('\r\n');
  it('default layout is unchanged', () => {
    const t = lst('');
    expect(t.slice(4, 6)).toEqual([' Abs. Rel.   Loc    Obj. code   Source line', ' ---- ----   ------ ---------   -----------']);
    expect(t.slice(7, 11)).toEqual([
      '    2    2  a000010 4865 6C6C    DC.B "Hello World"',
      '             000014 6F20 576F  ',
      '             000018 726C 64    ',
      '    3    3  a00001B 00           DC.B 0',
    ]);
  });
  it('-Lasms1 / -Lasms4 change the Loc width of the main and the continuation lines', () => {
    // Round 2: the Loc column stays 3 wide for the "Loc" header (manual Listings 5.23/5.24).
    expect(lst('-Lasms1').slice(4, 6)).toEqual([' Abs. Rel.   Loc Obj. code   Source line', ' ---- ----   --- ---------   -----------']);
    expect(lst('-Lasms1').slice(7, 10)).toEqual(['    2    2  a10  4865 6C6C    DC.B "Hello World"', '             14  6F20 576F  ', '             18  726C 64    ']);
    expect(lst('-Lasms4').slice(7, 9)).toEqual(['    2    2  a00000010 4865 6C6C    DC.B "Hello World"', '             00000014 6F20 576F  ']);
  });
  it('-Lasmc=ramki keeps Loc, object code and source (manual Listing 5.32)', () => {
    const t = lst('-Lasmc=ramki');
    expect(t.slice(4, 6)).toEqual(['Loc    Obj. code  Source line', '------ ---------  -----------']);
    expect(t.slice(7, 11)).toEqual(['000010 4865 6C6C   DC.B "Hello World"', '000014 6F20 576F  ', '000018 726C 64    ', '00001B 00          DC.B 0']);
  });
  it('-Lasmc=c drops the object code and its continuation lines; -Lasmc=s the source', () => {
    expect(lst('-Lasmc=c').slice(7, 9)).toEqual(['    2    2  a000010   DC.B "Hello World"', '    3    3  a00001B   DC.B 0']);
    expect(lst('-Lasmc=s')[7]).toBe('    2    2  a000010 4865 6C6C   ');
  });
  it('-Lasmc=i drops the include/macro mark but keeps the Rel. number', () => {
    const r = asmSource(' INCLUDE "x.inc"\n', '-CpuHCS12X -L -Lasmc=i', { 'x.inc': ' NOP\n' });
    expect(listingBody(r.listing!.text)[1]).toBe('    2    1   000000 A7           NOP');
    const full = asmSource(' INCLUDE "x.inc"\n', '-CpuHCS12X -L', { 'x.inc': ' NOP\n' });
    expect(listingBody(full.listing!.text)[1]).toBe('    2   1i   000000 A7           NOP');
  });
});

describe('message formats without file / position (-WmsgFonf, -WmsgFonp)', () => {
  const base: AsmMessage = { code: 'A9003', severity: 'WARNING', file: '', line: 0, column: 0, text: 'Unknown option ignored: -X' };
  it('no file: "%K %d: %m"', () => {
    for (const f of ['verbose', 'batch'] as const) expect(formatMessage(base, f)).toBe('WARNING A9003: Unknown option ignored: -X\n');
    expect(formatMessage(base, 'microsoft')).toBe('warning A9003: Unknown option ignored: -X\n');
    expect(formatMessage(base, 'ide')).toBe('Warning : A9003: Unknown option ignored: -X\n');
  });
  it('file but no line: "%f%e: %K %d: %m" (e.g. A50)', () => {
    const m: AsmMessage = { ...base, code: 'A50', severity: 'FATAL', file: 'C:\\nope.asm', text: "Input file 'C:\\nope.asm' not found" };
    expect(formatMessage(m)).toBe("C:\\nope.asm: FATAL A50: Input file 'C:\\nope.asm' not found\n");
    expect(formatMessage(m, 'batch')).toBe("C:\\nope.asm: FATAL A50: Input file 'C:\\nope.asm' not found\n");
    expect(formatMessage(m, 'ide')).toBe("Error   : A50: Input file 'C:\\nope.asm' not found\nnope.asm\n");
  });
  it('option problems carry no file', () => {
    const r = asmSource(' NOP\n', '-CpuHCS12X -Bogus');
    expect(r.messages).toEqual([{ code: 'A9003', severity: 'WARNING', file: '', line: 0, column: 0, text: 'Unknown option ignored: -Bogus' }]);
    expect(asmSource(' NOP\n', '-Bogus -WmsgSd9003').messages).toEqual([]);
  });
});

describe('Latin-1 text contract', () => {
  it('Latin-1 characters pass through 1:1 (DC strings, listing, .dbg)', () => {
    const r = asmSource(' ORG 0\n DC.B "\u00e9\u00ff" ; \u00e4\n');
    expect(r.messages).toEqual([]);
    expect(hex(sectionBytes(r, '_ORG00001'))).toBe('E9 FF');
    expect(Array.from(encodeLatin1(r.dbg.text))).toEqual([0x20, 0x4f, 0x52, 0x47, 0x20, 0x30, 13, 10, ...Array.from(encodeLatin1(' DC.B "\u00e9\u00ff" ; \u00e4')), 13, 10]);
  });
  it('characters above U+00FF warn A9005 and keep their low 8 bits', () => {
    const r = asmSource(' ORG 0\n DC.B "\u20ac"\n LDAA #\'\u0141\'\n');
    expect(r.messages.map((m) => [m.code, m.severity, m.line, m.text])).toEqual([
      ['A9005', 'WARNING', 2, 'Character code above 0xFF in string: only the low 8 bits are used'],
      ['A9005', 'WARNING', 3, 'Character code above 0xFF in character constant: only the low 8 bits are used'],
    ]);
    expect(hex(sectionBytes(r, '_ORG00001'))).toBe('AC 86 41');
  });
});

describe('macro call-site position in messages', () => {
  it('gives the outermost call file/line for errors inside (nested) expansions', () => {
    const r = asmSource(
      ['inner: MACRO', ' FAIL 200', ' ENDM', 'outer: MACRO', ' inner', ' ENDM', ' NOP', ' outer', ' INCLUDE "m.inc"'].join('\n'),
      '-CpuHCS12X -L',
      { 'm.inc': ' NOP\n inner\n' },
    );
    expect(r.messages.map((m) => [m.code, m.line, m.callFile, m.callLine])).toEqual([
      ['A2329', 2, 'C:\\proj\\Sources\\t.asm', 8],
      ['A2329', 2, 'C:\\proj\\Sources\\m.inc', 2],
    ]);
  });
  it('messages outside macros have no call site', () => {
    const r = asmSource(' FAIL 200\n');
    expect(r.messages[0].callFile).toBeUndefined();
  });
});
