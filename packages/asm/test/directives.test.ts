import { describe, expect, it } from 'vitest';
import { readElf, readRelocationSections, readSymbols } from '@s12/formats';
import { assemble } from '../src/index.js';
import { asmSource, hex, listingBody, sectionBytes } from './helpers.js';

const body = (src: string, opts = '-CpuHCS12X -L') => {
  const r = asmSource(src, opts);
  expect(r.messages.filter((m) => m.severity === 'ERROR')).toEqual([]);
  return listingBody(r.listing!.text);
};

describe('listing layout (critique G1)', () => {
  it('formats code, data, DS, EQU, labels and comments in fixed columns', () => {
    const l = body(
      [
        '; comment',
        '* star comment',
        'Data:   SECTION',
        'v:      DS.W 1',
        'K       EQU  $F1',
        'Code:   SECTION',
        'top:',
        '        LDAA #K',
        '        JSR  top',
        '        MOVB #1,v',
        '        DC.B "Hello world"',
        '',
        '        ORG  $FFFE',
        '        DC.W top',
      ].join('\n'),
    );
    expect(l).toEqual([
      '    1    1                      ; comment',
      '    2    2                      * star comment',
      '    3    3                      Data:   SECTION',
      '    4    4   000000             v:      DS.W 1',
      '    5    5          0000 00F1   K       EQU  $F1',
      '    6    6                      Code:   SECTION',
      '    7    7                      top:',
      '    8    8   000000 86F1                LDAA #K',
      '    9    9   000002 16xx xx             JSR  top',
      '   10   10   000005 180B 01xx           MOVB #1,v',
      '             000009 xx         ',
      '   11   11   00000A 4865 6C6C           DC.B "Hello world"',
      '             00000E 6F20 776F  ',
      '             000012 726C 64    ',
      '   12   12                      ',
      '   13   13                              ORG  $FFFE',
      '   14   14  a00FFFE xxxx                DC.W top',
    ]);
  });

  it('pages: 6 header lines + 64 body lines, later pages start with a form feed', () => {
    const src = Array.from({ length: 130 }, (_, i) => `; line ${i + 1}`).join('\n');
    const r = asmSource(src);
    const lines = r.listing!.text.split('\r\n');
    expect(lines[0]).toBe('');
    expect(lines[1]).toBe('Freescale HC12-Assembler ');
    expect(lines[2]).toBe('(c) Copyright Freescale 1987-2010');
    expect(lines[6]).toBe('    1    1                      ; line 1');
    expect(lines[69]).toBe('   64   64                      ; line 64');
    expect(lines[70]).toBe('\f');
    expect(lines[71]).toBe('Freescale HC12-Assembler ');
    expect(lines[76]).toBe('   65   65                      ; line 65');
    expect(lines[139]).toBe('  128  128                      ; line 128');
    expect(lines[140]).toBe('\f');
    expect(r.listing!.text.endsWith('; line 130\r\n')).toBe(true);
  });

  it('continuation lines count towards the page length', () => {
    const src = Array.from({ length: 63 }, () => '        NOP').join('\n') + '\n        DC.B 1,2,3,4,5,6\n        NOP';
    const lines = asmSource(src).listing!.text.split('\r\n');
    expect(lines[69]).toBe('   64   64   00003F 0102 0304           DC.B 1,2,3,4,5,6');
    expect(lines[70]).toBe('\f');
    expect(lines[76]).toBe('             000043 0506       ');
  });

  it('lines are never truncated and the input may use LF, CRLF or no final newline', () => {
    const long = '; ' + 'x'.repeat(200);
    for (const src of [`${long}\n NOP\n`, `${long}\r\n NOP\r\n`, `${long}\n NOP`]) {
      const r = asmSource(src);
      expect(listingBody(r.listing!.text)[0]).toBe(`    1    1                      ${long}`);
      expect(r.dbg.text).toBe(`${long}\r\n NOP\r\n`);
    }
  });

  it('PAGE, SPC, LLEN, TITLE, NOLIST/LIST', () => {
    const r = asmSource([' TITLE "My Title"', ' NOP', ' NOLIST', ' NOP', ' LIST', ' LLEN 20', ' NOP ; a long comment', ' SPC 1', ' PAGE', ' NOP'].join('\n'));
    const lines = r.listing!.text.split('\r\n');
    expect(lines[0]).toBe('My Title');
    expect(lines.slice(6, 10)).toEqual(['    2    2   000000 A7           NOP', '    7    7   000002 A7           NOP ; a long commen', '', '\fMy Title']);
    expect(lines[15]).toBe('   10   10   000003 A7           NOP');
  });

  it('IF lines show the condition value; ELSE/ENDIF nothing; skipped lines listed (CLIST ON)', () => {
    const l = body(['Try: EQU 1', ' IF Try != 0', ' LDAA #103', ' ELSE', ' LDAA #0', ' ENDIF', ' CLIST OFF', ' IFEQ Try', ' NOP', ' ENDIF'].join('\n'));
    expect(l).toEqual([
      '    1    1          0000 0001   Try: EQU 1',
      '    2    2          0000 0001    IF Try != 0',
      '    3    3   000000 8667         LDAA #103',
      '    4    4                       ELSE',
      '    5    5                       LDAA #0',
      '    6    6                       ENDIF',
      '    8    8          0000 0001    IFEQ Try',
      '   10   10                       ENDIF',
    ]);
  });

  it('-Lasms changes the Loc width', () => {
    const r = asmSource(' NOP', '-L -Lasms2');
    expect(listingBody(r.listing!.text)[0]).toBe('    1    1   0000 A7           NOP');
  });

  it('TAB characters are expanded (TABS 8)', () => {
    expect(body('\tNOP\t; c')[0]).toBe('    1    1   000000 A7                  NOP     ; c');
  });
});

describe('data directives', () => {
  it('DC.B/W/L strings right-aligned and values', () => {
    const r = asmSource(' ORG 0\n DC.B "ABCDE"\n DC.B %1010, @12, 1,$A\n DC.W "ABCDE"\n DC.W %1010, @12, 1, $A\n DC.L "ABCDE"\n DC.L 1\n DC "x"\n FCB 1\n FDB 2\n FQB 3\n DCW 4\n DCL 5\n FCC "fcc"');
    expect(r.messages).toEqual([]);
    expect(hex(sectionBytes(r, '_ORG00001'))).toBe(
      '41 42 43 44 45 0A 0A 01 0A 00 41 42 43 44 45 00 0A 00 0A 00 01 00 0A 00 00 00 41 42 43 44 45 00 00 00 01 78 01 00 02 00 00 00 03 00 04 00 00 00 05 66 63 63',
    );
  });
  it('DCB repeats a value; DS reserves', () => {
    const r = asmSource(' ORG 0\nLabel: DCB.B 3, $FF\n DCB.W 3, $FFFE\n DCB.L 3, $FFFE\n DS.W 2\n DC.B 1\n RMB 1\n RMD 1\n RMQ 1');
    expect(hex(sectionBytes(r, '_ORG00001'))).toBe(
      'FF FF FF FF FE FF FE FF FE 00 00 FF FE 00 00 FF FE 00 00 FF FE 00 00 00 00 01 00 00 00 00 00 00 00',
    );
    expect(r.sections[1].size).toBe(33);
  });
  it('ALIGN / EVEN / LONGEVEN pad with zeros relative to the section start', () => {
    const r = asmSource('C: SECTION\n DC.B "high"\n ALIGN 16\nHEX: DC.B 127\n EVEN\n DC.B 1\n LONGEVEN\n DC.B 2');
    expect(hex(sectionBytes(r, 'C'))).toBe('68 69 67 68 00 00 00 00 00 00 00 00 00 00 00 00 7F 00 01 00 02');
    const l = listingBody(r.listing!.text);
    expect(l.slice(2, 10)).toEqual([
      '    3    3   000004 0000 0000    ALIGN 16',
      '             000008 0000 0000  ',
      '             00000C 0000 0000  ',
      '    4    4   000010 7F          HEX: DC.B 127',
      '    5    5   000011 00           EVEN',
      '    6    6   000012 01           DC.B 1',
      '    7    7   000013 00           LONGEVEN',
      '    8    8   000014 02           DC.B 2',
    ]);
  });
  it('EQU (absolute, relocatable), SET redefinition, A2326 for EQU redefinition', () => {
    const r = asmSource('D: SECTION\nTime: DS.B 3\nHour: EQU Time\nMinute: EQU Time+1\nc: SET 2\n ORG 0\n DC.B c\nc: SET c-1\n DC.B c\n LDAA Minute\nxx: EQU 1\nxx: EQU 2');
    expect(r.messages.map((m) => m.code)).toEqual(['A2326']);
    const ok = asmSource('D: SECTION\nTime: DS.B 3\nHour: EQU Time\nMinute: EQU Time+1\nc: SET 2\nC2: SECTION\n DC.B c\nc: SET c-1\n DC.B c\n LDAA Minute');
    expect(ok.ok).toBe(true);
    expect(hex(sectionBytes(ok, 'C2'))).toBe('02 01 B6 00 01');
    const elf = readElf(ok.objectBytes!);
    const syms = readSymbols(elf);
    const rel = readRelocationSections(elf).find((x) => x.section.name === '.rela.C2')!.relocs;
    expect(rel).toHaveLength(1);
    expect(syms[rel[0].sym].name).toBe('Time');
  });
  it('OFFSET defines absolute struct offsets and ends at the next code', () => {
    const r = asmSource(' OFFSET 0\nID: DS.B 1\nCOUNT: DS.W 1\nVALUE: DS.L 1\nSIZE: EQU *\nDataSec: SECTION\nStruct: DS.B SIZE\nCodeSec: SECTION\n LDX #Struct\n STAA ID,X\n INC COUNT,X\n STAA VALUE,X');
    expect(r.ok).toBe(true);
    expect(hex(sectionBytes(r, 'CodeSec'))).toBe('CE 00 00 6A 00 62 01 6A 03');
    const l = listingBody(r.listing!.text);
    expect(l[1]).toBe('    2    2   000000             ID: DS.B 1');
    expect(l[4]).toBe('    5    5          0000 0007   SIZE: EQU *');
    expect(r.symbols.find((s) => s.name === 'ID')?.elfIndex).toBeUndefined();
  });
  it('SECTION re-opening continues where it left off', () => {
    const r = asmSource('aaa: SECTION 4\nxx: NOP\nbbb: SECTION 5\nyy: NOP\n NOP\naaa: SECTION 4\nzz: NOP');
    expect(r.symbols.find((s) => s.name === 'zz')).toMatchObject({ section: 'aaa', value: 1 });
    expect(r.sections.map((s) => s.name)).toEqual(['_SEC000000', 'aaa', 'bbb']);
  });
  it('END stops reading (in an include it ends only that file)', () => {
    const r = asmSource(' NOP\n INCLUDE "a.inc"\n NOP\n END\n SWI\n', '-L', { 'a.inc': ' NOP\n END\n SWI\n' });
    expect(hex(sectionBytes(r, '_SEC000000'))).toBe('A7 A7 A7');
    expect(r.dbg.text).toBe(' NOP\r\n INCLUDE "a.inc"\r\n NOP\r\n END\r\n NOP\r\n END\r\n');
  });
  it('RAD50 packs three characters per word', () => {
    const r = asmSource(' ORG 0\nrad50: RAD50 "Hello World"\n');
    expect(hex(sectionBytes(r, '_ORG00001'))).toBe('32 D4 4D 58 92 2A 4B A0');
  });
});

describe('INCLUDE', () => {
  const files = { 'C:\\proj\\Sources\\defs.inc': 'K: EQU 5\n NOP\n' };
  it('is searched in the source directory and GENPATH, case-insensitively via the host', () => {
    const r = asmSource(' INCLUDE "DEFS.INC"\n LDAA #K\n', '-L', files);
    expect(r.ok).toBe(true);
    expect(r.includes).toEqual(['C:\\proj\\Sources\\DEFS.INC']);
    const viaGen = asmSource(" INCLUDE 'x.inc'\n", '-L', { 'C:\\lib\\x.inc': ' NOP\n' }, { env: { GENPATH: 'C:\\nope;C:\\lib' } });
    expect(viaGen.ok).toBe(true);
  });
  it('without -Li the included lines are listed with an i suffix and are part of the .dbg', () => {
    const r = asmSource(' INCLUDE "defs.inc"\n LDAA #K\n', '-L', files);
    expect(listingBody(r.listing!.text)).toEqual([
      '    1    1                       INCLUDE "defs.inc"',
      '    2   1i          0000 0005   K: EQU 5',
      '    3   2i   000000 A7           NOP',
      '    4    2   000001 8605         LDAA #K',
    ]);
    expect(r.dbg.text).toBe(' INCLUDE "defs.inc"\r\nK: EQU 5\r\n NOP\r\n LDAA #K\r\n');
  });
  it('with -Li they are neither listed nor in the .dbg (UNCERTAIN, see LI_EXCLUDES_INCLUDES_FROM_DBG)', () => {
    const r = asmSource(' INCLUDE "defs.inc"\n LDAA #K\n', '-L -Li', files);
    expect(listingBody(r.listing!.text)).toEqual(['    1    1                       INCLUDE "defs.inc"', '    2    2   000001 8605         LDAA #K']);
    expect(r.dbg.text).toBe(' INCLUDE "defs.inc"\r\n LDAA #K\r\n');
  });
  it('falls back to lower/upper-case spellings when the host is case-sensitive', () => {
    const r = assemble({
      sourcePath: '/p/t.asm',
      readFile: (p) => (p === '/p/t.asm' ? ' INCLUDE "Defs.Inc"\n LDAA #K\n' : p === '/p/defs.inc' ? 'K: EQU 5\n' : undefined),
      options: '-L',
    });
    expect(r.ok).toBe(true);
    expect(r.includes).toEqual(['/p/defs.inc']);
  });
  it('missing include → A2309', () => {
    expect(asmSource(' INCLUDE "none.inc"\n').messages.map((m) => m.code)).toEqual(['A2309']);
  });
});
