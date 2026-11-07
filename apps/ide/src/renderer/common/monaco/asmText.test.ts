import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commentLines, findInText, maskMatcher, scanIncludes, scanLabels, splitFields, stripComment } from './asmText';
import { repoRoot } from './testing/repo';

/** The public demo program examples/blinky/Sources/main.asm. */
const mainAsm = readFileSync(join(repoRoot(), 'examples/blinky/Sources/main.asm'), 'latin1');

describe('asmText', () => {
  it('splits fields like the assembler', () => {
    expect(splitFields('main:   clr   state         ; first')).toEqual({ label: { name: 'main', column: 1 }, op: 'CLR', operands: 'state' });
    expect(splitFields('F1        EQU   $F1         ; ASCII')).toEqual({ label: { name: 'F1', column: 1 }, op: 'EQU', operands: '$F1' });
    expect(splitFields('  loop: dbne D,loop')).toEqual({ label: { name: 'loop', column: 3 }, op: 'DBNE', operands: 'D,loop' });
    expect(splitFields('state:   DS.B 1')).toEqual({ label: { name: 'state', column: 1 }, op: 'DS', operands: '1' });
    expect(splitFields('        ;movw  #0, ticks')).toEqual({ label: undefined, operands: '' });
    expect(splitFields('* comment')).toEqual({ operands: '' });
    expect(stripComment("MSG: DC.B 'a;b' ; c")).toBe("MSG: DC.B 'a;b' ");
  });

  it('scans the labels of main.asm for the Functions popup', () => {
    const labels = scanLabels(mainAsm);
    const by = (n: string) => labels.find((l) => l.name === n);
    expect(by('main')).toMatchObject({ kind: 'code', column: 1 });
    expect(by('main')!.line).toBe(mainAsm.split('\n').findIndex((l) => l.startsWith('main:')) + 1);
    expect(by('LCD_RS')).toMatchObject({ kind: 'constant' });
    expect(by('rate')).toMatchObject({ kind: 'data' });
    expect(by('DEFAULT_RAM')).toMatchObject({ kind: 'section' });
    expect(by('MyCode')).toMatchObject({ kind: 'section' });
    // a label alone on its line takes the kind of the next statement
    expect(by('Entry')).toMatchObject({ kind: 'code' });
    expect(by('lcd_busy')).toMatchObject({ kind: 'code' });
    expect(by('msg1')).toMatchObject({ kind: 'data' });
    // file order, no duplicates of comment text
    const lines = labels.map((l) => l.line);
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
    expect(labels.some((l) => l.name === 'MOVB' || l.name === 'movb')).toBe(false);
    expect(labels.length).toBeGreaterThan(30);
  });

  it('scans INCLUDE directives', () => {
    expect(scanIncludes(" INCLUDE 'derivative.inc'\n\tinclude \"lcd.inc\" ; x\nX: EQU 1")).toEqual([
      { file: 'derivative.inc', line: 1 },
      { file: 'lcd.inc', line: 2 },
    ]);
    const incLine = mainAsm.split('\n').findIndex((l) => /^\s+INCLUDE 'derivative\.inc'/.test(l)) + 1;
    expect(scanIncludes(mainAsm)).toEqual([{ file: 'derivative.inc', line: incLine }]);
  });

  it('comments and uncomments lines at column 1', () => {
    expect(commentLines(['  ldaa #1', '', '  rts'], 'comment')).toEqual([';  ldaa #1', '', ';  rts']);
    expect(commentLines([';  ldaa #1', '', '  ;rts'], 'uncomment')).toEqual(['  ldaa #1', '', '  rts']);
    expect(commentLines([';a', ';b'], 'toggle')).toEqual(['a', 'b']);
    expect(commentLines([';a', 'b'], 'toggle')).toEqual([';;a', ';b']);
    expect(commentLines(['x ; trailing'], 'uncomment')).toEqual(['x ; trailing']);
  });

  it('finds text (Find in Files)', () => {
    const t = 'POLL_1: ldaa state\n        jsr POLL_1\n        jsr POLL_10';
    expect(findInText(t, 'poll_1').map((m) => [m.line, m.column])).toEqual([
      [1, 1],
      [2, 13],
      [3, 13],
    ]);
    expect(findInText(t, 'poll_1', { matchCase: true })).toEqual([]);
    expect(findInText(t, 'POLL_1', { wholeWord: true }).map((m) => m.line)).toEqual([1, 2]);
    expect(findInText(t, 'jsr\\s+\\w+', { regex: true }).map((m) => m.length)).toEqual([10, 11]);
    expect(findInText(t, '')).toEqual([]);
    expect(() => findInText(t, '(', { regex: true })).toThrow();
    expect(findInText(mainAsm, 'lcd_data', { wholeWord: true, matchCase: true }).length).toBeGreaterThanOrEqual(2);
  });

  it('matches file masks', () => {
    const m = maskMatcher('*.asm; *.inc');
    expect(m('main.asm')).toBe(true);
    expect(m('MAIN.ASM')).toBe(true);
    expect(m('derivative.inc')).toBe(true);
    expect(m('Project.prm')).toBe(false);
    expect(maskMatcher('')('anything')).toBe(true);
    expect(maskMatcher('m?in.*')('main.dbg')).toBe(true);
  });
});
