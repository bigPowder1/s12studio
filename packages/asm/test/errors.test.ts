import { describe, expect, it } from 'vitest';
import { formatMessage, messageText, MESSAGES, type AsmMessage } from '../src/index.js';
import { asmSource } from './helpers.js';

const codes = (src: string, opts = '-CpuHCS12X -L') => asmSource(src, opts).messages.map((m) => m.code);

describe('CodeWarrior messages', () => {
  const cases: Array<[string, string, string[]]> = [
    ['undeclared symbol', ' LDAA undefinedsym', ['A1104']],
    ['short branch out of range', 'C: SECTION\n BRA far\n DS.B 200\nfar: NOP', ['A1401']],
    ['short branch to another section', 'S1: SECTION\nxx: NOP\nS2: SECTION\n BEQ xx', ['A12008']],
    ['short branch to an external', ' XREF e\n BRA e', ['A12008']],
    ['loop primitive to another section', 'S1: SECTION\nxx: NOP\nS2: SECTION\n DBNE A,xx', ['A12411']],
    ['loop primitive out of range', 'C: SECTION\nl: DS.B 300\n DBNE X,l', ['A12403']],
    ['long branch out of range (absolute)', ' ORG $1000\n LBRA $9004', ['A1402']],
    ['label redefinition', 'dd: NOP\ndd: NOP', ['A1103']],
    ['EQU redefinition', 'k: EQU 1\nk: EQU 2', ['A2326']],
    ['reserved label', 'X: NOP', ['A1101']],
    ['unknown mnemonic', ' FOO 1', ['A12202']],
    ['S12X instruction in CPU12 mode', ' DECW $1234', ['A12202']],
    ['missing right parenthesis', ' LDAA (1+2', ['A1052']],
    ['error in expression', ' LDAA 1+', ['A1055']],
    ['complex relocatable', 'S1: SECTION\na1: NOP\na2: NOP\n DC.W a1+a2', ['A2401']],
    ['EQU forward reference', 'k: EQU later\nlater: EQU 1', ['A2333']],
    ['immediate not allowed', ' MOVB #1,#2', ['A12105']],
    ['immediate expected for the mask', ' BSET $40,$01', ['A12104']],
    ['auto increment range', ' LDAA 9,X+', ['A12005']],
    ['register expected', ' LDAB 0,Z', ['A12010']],
    ['illegal addressing mode', ' LEAX $1234', ['A12001']],
    ['size suffix on an instruction', ' ADDD.W #1', ['A12107']],
    ['FAIL < 500 is an error', ' FAIL 200', ['A2329']],
    ['FAIL >= 500 is a warning', ' FAIL 600', ['A2332']],
    ['FAIL with a string', ' FAIL "my reason"', ['A2338']],
    ['ELSE without IF', ' ELSE', ['A1001']],
    ['unclosed IF', ' IF 1', ['A1000']],
    ['label missing for EQU', ' EQU 5', ['A2301']],
    ['bad BASE', ' BASE 7', ['A2324']],
    ['DS count must be absolute', ' XREF e\n DS.B e', ['A2314']],
    ['CALL without page', ' CALL $8000', ['A12102']],
    ['8-bit value truncated', ' LDAA #$1FF', ['A12003']],
    ['DC.B value truncated', ' DC.B 256', ['A2328']],
    ['data directive without data', ' DC.B', ['A4001']],
    ['PCR to an EQU constant', 'k: EQU 5\nC: SECTION\n LDAA k,PCR', ['A1410']],
    ['5-bit offset on a CPU12 move', ' MOVB #1,100,X', ['A12404']],
    ['unknown option', ' NOP', ['A9003']],
  ];
  for (const [name, src, want] of cases) {
    it(name, () => {
      const opts = name === 'S12X instruction in CPU12 mode' || name === '5-bit offset on a CPU12 move' ? '-CpuCPU12 -L' : name === 'unknown option' ? '-L -Bogus' : '-CpuHCS12X -L';
      expect(codes(src, opts)).toEqual(want);
    });
  }

  it('8-bit relocations are rejected (object writer limitation, A9001)', () => {
    expect(codes(' XREF.B dp\n LDAA dp')).toEqual(['A9001']);
    expect(codes('S: SECTION SHORT\nv: DS.B 1\nC: SECTION\n STAA v')).toEqual(['A9001']);
    expect(codes(' XREF e\n DC.B e')).toEqual(['A9001']);
    expect(codes(' XREF e\n LDAA #LOW(e)')).toEqual(['A9001']);
  });

  it('no listing and no object when errors occurred; the .dbg is still produced', () => {
    const r = asmSource(' LDAA undefinedsym\n NOP');
    expect(r.ok).toBe(false);
    expect(r.listing).toBeUndefined();
    expect(r.objectBytes).toBeUndefined();
    expect(r.dbg.text).toBe(' LDAA undefinedsym\r\n NOP\r\n');
  });

  it('warnings do not prevent output', () => {
    const r = asmSource(' FAIL 600\n NOP');
    expect(r.ok).toBe(true);
    expect(r.objectBytes).toBeDefined();
  });

  it('messages carry file, line, column, position and are reported in source order', () => {
    const r = asmSource('C: SECTION\n LDAA nosuch\n BRA far\n DS.B 200\nfar: NOP\n FOO');
    expect(r.messages.map((m) => [m.code, m.line, m.column])).toEqual([
      ['A1104', 2, 7],
      ['A1401', 3, 6],
      ['A12202', 6, 2],
    ]);
    expect(r.messages[0]).toMatchObject({ file: 'C:\\proj\\Sources\\t.asm', severity: 'ERROR', text: 'Undeclared user defined symbol: nosuch', pos: 17 });
  });

  it('-W2 / -WmsgSd suppress, -WmsgSe escalates', () => {
    expect(codes(' FAIL 600', '-L -W2')).toEqual([]);
    expect(codes(' FAIL 600', '-L -WmsgSd2332')).toEqual([]);
    const r = asmSource(' FAIL 600', '-L -WmsgSe2332');
    expect(r.messages[0].severity).toBe('ERROR');
    expect(r.ok).toBe(false);
  });

  it('formats like the CodeWarrior tools', () => {
    const m: AsmMessage = {
      code: 'A2329',
      severity: 'ERROR',
      file: 'C:\\Freescale\\demo\\errfail.asm',
      line: 6,
      column: 19,
      pos: 96,
      text: 'FAIL found',
      sourceLine: '            FAIL 200',
      macroContext: 'cpChar , char2',
    };
    expect(formatMessage(m)).toBe(
      '\n>> in "C:\\Freescale\\demo\\errfail.asm", line 6, col 19, pos 96\n            FAIL 200\n                  ^\nERROR A2329: FAIL found\nMacro Call : cpChar , char2\n',
    );
    expect(formatMessage(m, 'batch')).toBe('C:\\Freescale\\demo\\errfail.asm(6): ERROR A2329: FAIL found\n');
    expect(formatMessage(m, 'ide')).toBe('Error   : A2329: FAIL found\nerrfail.asm line 6\n');
  });

  it('message catalogue has the documented texts', () => {
    expect(messageText('A1104', 'foo')).toBe('Undeclared user defined symbol: foo');
    expect(MESSAGES.A2341[1]).toBe('Relocatable Section Not Allowed: an Absolute file is currently directly generated');
    expect(MESSAGES.A12001).toEqual(['ERROR', 'Illegal Addressing Mode']);
  });

  it('a missing main file is fatal (A50)', () => {
    const r = asmSource('');
    expect(r.ok).toBe(true);
    const missing = asmSource('', '-L', {}, { sourcePath: 'C:\\nope.asm' });
    expect(missing.messages.map((m) => [m.code, m.severity])).toEqual([['A50', 'FATAL']]);
  });
});
