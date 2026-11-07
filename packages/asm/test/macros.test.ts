import { describe, expect, it } from 'vitest';
import { asmSource, hex, listingBody, sectionBytes } from './helpers.js';

describe('macros', () => {
  const clear = ['clear: MACRO', '       LDX #\\1', '       LDAA #16', '\\@LOOP: CLR 1,X+', '       DBNE A,\\@LOOP', '       ENDM'];
  it('expands parameters and unique \\@ labels; listing marks expansions (manual Listing 9.9)', () => {
    const r = asmSource([...clear, 'Data: SECTION', 'temporary: DS 16', 'data: DS 16', 'Code: SECTION', ' clear temporary', ' clear data'].join('\n'));
    expect(r.messages).toEqual([]);
    expect(listingBody(r.listing!.text).slice(10)).toEqual([
      '   11   11                       clear temporary',
      '   12   2m   000000 CExx xx    +       LDX #temporary',
      '   13   3m   000003 8610       +       LDAA #16',
      '   14   4m   000005 6930       +_00001LOOP: CLR 1,X+',
      '   15   5m   000007 0430 FB    +       DBNE A,_00001LOOP',
      '   16   12                       clear data',
      '   17   2m   00000A CExx xx    +       LDX #data',
      '   18   3m   00000D 8610       +       LDAA #16',
      '   19   4m   00000F 6930       +_00002LOOP: CLR 1,X+',
      '   20   5m   000011 0430 FB    +       DBNE A,_00002LOOP',
    ]);
    // The .dbg contains the macro call followed by its expansion.
    expect(r.dbg.text.split('\r\n').slice(10, 16)).toEqual([' clear temporary', '       LDX #temporary', '       LDAA #16', '_00001LOOP: CLR 1,X+', '       DBNE A,_00001LOOP', ' clear data']);
  });

  it('\\0 is the size suffix of the call; missing arguments are empty', () => {
    const r = asmSource(['MyMacro: MACRO', ' DC.\\0 \\1, \\2', ' ENDM', ' ORG 0', ' MyMacro.B $10, $56', ' MyMacro.W 1, 2'].join('\n'));
    expect(hex(sectionBytes(r, '_ORG00001'))).toBe('10 56 00 01 00 02');
  });

  it('argument grouping with [? ?] and escapes', () => {
    const r = asmSource(['MyMacro: MACRO', ' DC \\1', ' ENDM', 'MyMacro1: MACRO', ' \\1', ' ENDM', ' ORG 0', ' MyMacro [?$10, $56?]', ' MyMacro1 [?MyMacro \\[?$11, $57\\?]?]'].join('\n'));
    expect(r.messages).toEqual([]);
    expect(hex(sectionBytes(r, '_ORG00001'))).toBe('10 56 11 57');
  });

  it('nested and recursive calls', () => {
    const r = asmSource(['inner: MACRO', ' DC.B \\1', ' ENDM', 'outer: MACRO', ' inner \\1+1', ' inner \\1+2', ' ENDM', 'rec: MACRO', ' IFNE \\1', ' DC.B \\1', ' rec \\1-1', ' ENDIF', ' ENDM', ' ORG 0', ' outer 10', ' rec 3'].join('\n'));
    expect(r.messages).toEqual([]);
    expect(hex(sectionBytes(r, '_ORG00001'))).toBe('0B 0C 03 02 01');
  });

  it('MEXIT ends the expansion; the remaining lines are listed without code (manual Listing 8.41)', () => {
    const r = asmSource(['save: MACRO', ' LDAA \\1', " IFC '\\2', ''", ' MEXIT', ' ENDC', ' STAA \\2', ' ENDM', 'C: SECTION', ' save #1', ' save #2, [?3,X?]'].join('\n'));
    expect(r.messages).toEqual([]);
    expect(hex(sectionBytes(r, 'C'))).toBe('86 01 86 02 6A 03');
    const l = listingBody(r.listing!.text);
    expect(l.slice(8, 14)).toEqual([
      '    9    9                       save #1',
      '   10   2m   000000 8601       + LDAA #1',
      "   11   3m          0000 0001  + IFC '', ''",
      '   12   4m                     + MEXIT',
      '   13   5m                     + ENDC',
      '   14   6m                     + STAA ',
    ]);
  });

  it('-Lc / -Ld / -Le / MLIST OFF control what is listed (Abs keeps counting)', () => {
    const src = ['m: MACRO', ' NOP', ' ENDM', ' m', ' MLIST OFF', ' m', ' MLIST ON', ' NOP'].join('\n');
    const nums = (opts: string) => listingBody(asmSource(src, opts).listing!.text).map((l) => l.slice(0, 10).trim().replace(/\s+/g, '/'));
    expect(nums('-L')).toEqual(['1/1', '2/2', '3/3', '4/4', '5/2m', '7/6', '10/8']);
    expect(nums('-Lc')).toEqual(['1/1', '2/2', '3/3', '5/2m', '10/8']);
    expect(nums('-Ld')).toEqual(['4/4', '5/2m', '7/6', '10/8']);
    expect(nums('-Le')).toEqual(['1/1', '2/2', '3/3', '4/4', '7/6', '10/8']);
  });

  it('errors: nested definition, ENDM outside, MEXIT outside, unclosed macro', () => {
    expect(asmSource('a: MACRO\nb: MACRO\n ENDM\n').messages.map((m) => m.code)).toContain('A2304');
    expect(asmSource(' ENDM\n').messages.map((m) => m.code)).toEqual(['A2303']);
    expect(asmSource(' MEXIT\n').messages.map((m) => m.code)).toEqual(['A2350']);
    expect(asmSource('a: MACRO\n NOP\n').messages.map((m) => m.code)).toEqual(['A2306']);
    expect(asmSource(' MACRO\n ENDM\n').messages.map((m) => m.code)).toEqual(['A2302']);
  });

  it('messages inside an expansion carry the macro call context', () => {
    const r = asmSource(['m: MACRO', ' FAIL 200', ' ENDM', ' m'].join('\n'));
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ code: 'A2329', line: 2, macroContext: 'm' });
  });
});

describe('conditional assembly', () => {
  const run = (src: string) => {
    const r = asmSource(' ORG 0\n' + src);
    expect(r.messages.filter((m) => m.severity === 'ERROR')).toEqual([]);
    return hex(sectionBytes(r, '_ORG00001'));
  };
  it('IF / ELSE / ENDIF and nesting', () => {
    expect(run(' IF 1\n DC.B 1\n IF 0\n DC.B 2\n ELSE\n DC.B 3\n ENDIF\n ELSE\n DC.B 4\n ENDIF')).toBe('01 03');
    expect(run(' IF 0\n IF 1\n DC.B 1\n ELSE\n DC.B 2\n ENDIF\n ELSE\n DC.B 3\n ENDIF')).toBe('03');
  });
  it('IFEQ / IFNE / IFLT / IFLE / IFGT / IFGE', () => {
    const t = (d: string, v: number) => run(` ${d} ${v}\n DC.B 1\n ELSE\n DC.B 0\n ENDIF`);
    expect([t('IFEQ', 0), t('IFEQ', 1), t('IFNE', 0), t('IFNE', 2)]).toEqual(['01', '00', '00', '01']);
    expect([t('IFLT', -1), t('IFLT', 0), t('IFLE', 0), t('IFLE', 1)]).toEqual(['01', '00', '01', '00']);
    expect([t('IFGT', 1), t('IFGT', 0), t('IFGE', 0), t('IFGE', -1)]).toEqual(['01', '00', '01', '00']);
  });
  it('IFC / IFNC compare strings; IFDEF / IFNDEF test symbols', () => {
    expect(run(" IFC 'ab','ab'\n DC.B 1\n ENDIF\n IFNC \"ab\",ab\n DC.B 2\n ENDIF\n IFNC ab,AB\n DC.B 3\n ENDIF")).toBe('01 03');
    expect(run('xx: EQU 1\n IFDEF xx\n DC.B 1\n ENDIF\n IFNDEF y\n DC.B 2\n ENDIF\n IFDEF y\n DC.B 3\n ENDIF')).toBe('01 02');
  });
  it('ELSEC / ENDC synonyms', () => {
    expect(run(' IF 0\n DC.B 1\n ELSEC\n DC.B 2\n ENDC')).toBe('02');
  });
  it('-D defines a label as if EQU at the start', () => {
    const r = asmSource(' ORG 0\n IFDEF ADD_COPYRIGHT\n DC.B YEAR/100, YEAR%100\n ENDIF\n', '-L -DADD_COPYRIGHT -DYEAR=2005');
    expect(hex(sectionBytes(r, '_ORG00001'))).toBe('14 05');
  });
  it('errors: stray ELSE/ENDIF (A1001), unclosed IF (A1000), second ELSE (A1001)', () => {
    expect(asmSource(' ELSE\n').messages.map((m) => m.code)).toEqual(['A1001']);
    expect(asmSource(' ENDIF\n').messages.map((m) => m.code)).toEqual(['A1001']);
    expect(asmSource(' IF 1\n').messages.map((m) => m.code)).toEqual(['A1000']);
    expect(asmSource(' IF 1\n ELSE\n ELSE\n ENDIF\n').messages.map((m) => m.code)).toEqual(['A1001']);
    expect(asmSource(' IF fwd\n ENDIF\nfwd: EQU 1\n').messages.map((m) => m.code)).toEqual(['A2333']);
  });
});
