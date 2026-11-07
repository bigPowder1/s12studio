/**
 * HC12 Monarch tokenizer, run through Monaco's real Monarch lexer (monaco.editor.tokenize works in jsdom with a
 * matchMedia stub; only the editor widget needs a real browser). Lines come from examples/blinky/Sources/main.asm (public).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixturesDir, hasFixtures, repoRoot } from './testing/repo';
import { HC12_DIRECTIVES, HC12_LANGUAGE_ID, HC12_MNEMONICS, languageForPath } from './hc12';
import type { Monaco } from './loader';

type Tok = [text: string, type: string];

const FX = hasFixtures;
let monaco: Monaco;
let mainAsm: string[];

beforeAll(async () => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as never;
  monaco = (await import('monaco-editor/editor/editor.api')) as unknown as Monaco;
  const { registerHc12 } = await import('./loader');
  registerHc12(monaco);
  mainAsm = readFileSync(join(repoRoot(), 'examples/blinky/Sources/main.asm'), 'latin1').split(/\r?\n/);
}, 60000);

/** Tokenize a whole text; returns per-line [text, type] lists with the '.hc12' postfix and whitespace removed. */
function tokenize(text: string): Tok[][] {
  const lines = text.split('\n');
  return monaco.editor.tokenize(text, HC12_LANGUAGE_ID).map((toks, li) =>
    toks
      .map((t, i): Tok => [lines[li].slice(t.offset, toks[i + 1]?.offset ?? lines[li].length), t.type.replace(/\.hc12$/, '')])
      .filter(([s, ty]) => ty !== 'white' && s.trim() !== ''),
  );
}

const line = (text: string): Tok[] => tokenize(text)[0];

/** Tokens of the first blinky main.asm line that equals `src` (tokenized in the context of the whole file). */
function fromMain(src: string): Tok[] {
  const i = mainAsm.findIndex((l) => l.trimEnd() === src.trimEnd());
  expect(i, `line not found in examples/blinky/Sources/main.asm: ${src}`).toBeGreaterThanOrEqual(0);
  return tokenize(mainAsm.join('\n'))[i];
}

describe('HC12 Monarch tokenizer on examples/blinky main.asm', () => {
  it('banner comments (; in column 1)', () => {
    expect(fromMain(';* S12 Studio example -- Apache-2.0')).toEqual([[';* S12 Studio example -- Apache-2.0', 'comment']]);
  });

  it('directives with symbol operands', () => {
    expect(fromMain('            XDEF    Entry, main')).toEqual([
      ['XDEF', 'keyword.directive'],
      ['Entry', 'identifier'],
      [',', 'delimiter'],
      ['main', 'identifier'],
    ]);
    expect(fromMain('            XREF    __SEG_END_SSTACK      ; top of the stack, set by the linker')).toEqual([
      ['XREF', 'keyword.directive'],
      ['__SEG_END_SSTACK', 'identifier'],
      ['; top of the stack, set by the linker', 'comment'],
    ]);
  });

  it('EQU with hex / binary / decimal numbers and trailing comments', () => {
    expect(fromMain('LCD_RS      EQU     $10                   ; PM4')).toEqual([
      ['LCD_RS', 'label'],
      ['EQU', 'keyword.directive'],
      ['$10', 'number.hex'],
      ['; PM4', 'comment'],
    ]);
    expect(line('G1        EQU   %00010000   ; bit 4')).toEqual([
      ['G1', 'label'],
      ['EQU', 'keyword.directive'],
      ['%00010000', 'number.binary'],
      ['; bit 4', 'comment'],
    ]);
    expect(fromMain('TICK        EQU     3125                  ; 10 ms in TCNT ticks (10 MHz / 32)')[2]).toEqual(['3125', 'number']);
  });

  it('labels with colon, sections, sized data directives', () => {
    expect(fromMain('DEFAULT_RAM: SECTION')).toEqual([
      ['DEFAULT_RAM:', 'label'],
      ['SECTION', 'keyword.directive'],
    ]);
    expect(fromMain('rate:       DS.B    1                     ; 1..9 (x 100 ms)')).toEqual([
      ['rate:', 'label'],
      ['DS.B', 'keyword.directive'],
      ['1', 'number'],
      ['; 1..9 (x 100 ms)', 'comment'],
    ]);
    expect(fromMain('Entry:')).toEqual([['Entry:', 'label']]);
  });

  it('instructions: label + mnemonic + operand + comment, either case', () => {
    expect(fromMain('main:       LDS     #__SEG_END_SSTACK     ; set up the stack')).toEqual([
      ['main:', 'label'],
      ['LDS', 'keyword'],
      ['#', 'operator'],
      ['__SEG_END_SSTACK', 'identifier'],
      ['; set up the stack', 'comment'],
    ]);
    expect(fromMain('            BNE     keys')).toEqual([
      ['BNE', 'keyword'],
      ['keys', 'identifier'],
    ]);
    expect(line('loop:   clr   state       ; lower case works too')).toEqual([
      ['loop:', 'label'],
      ['clr', 'keyword'],
      ['state', 'identifier'],
      ['; lower case works too', 'comment'],
    ]);
    expect(line('        rts                 ; done')).toEqual([
      ['rts', 'keyword'],
      ['; done', 'comment'],
    ]);
  });

  it('immediate operands, registers, character constants', () => {
    expect(fromMain('            MOVB    #$50, PTP')).toEqual([
      ['MOVB', 'keyword'],
      ['#', 'operator'],
      ['$50', 'number.hex'],
      [',', 'delimiter'],
      ['PTP', 'identifier'],
    ]);
    expect(fromMain('            LDAA    B,X                   ; key value')).toEqual([
      ['LDAA', 'keyword'],
      ['B', 'variable.predefined'],
      [',', 'delimiter'],
      ['X', 'variable.predefined'],
      ['; key value', 'comment'],
    ]);
    expect(fromMain("            ADDA    #'0'")).toEqual([
      ['ADDA', 'keyword'],
      ['#', 'operator'],
      ["'0'", 'string'],
    ]);
  });

  it('commented-out code stays a comment; the next line is tokenized afresh', () => {
    const toks = tokenize(['        ;movw  #0, ticks', '        ;bgnd               ; uncomment to stop here', 'top:    jsr   task1         ; first task'].join('\n'));
    expect(toks[0]).toEqual([[';movw  #0, ticks', 'comment']]);
    expect(toks[1]).toEqual([[';bgnd               ; uncomment to stop here', 'comment']]);
    expect(toks[2].slice(0, 3)).toEqual([
      ['top:', 'label'],
      ['jsr', 'keyword'],
      ['task1', 'identifier'],
    ]);
  });

  it('string data with a ; inside quotes', () => {
    expect(line("MSG:  DC.B 'A;B',$00 ; text")).toEqual([
      ['MSG:', 'label'],
      ['DC.B', 'keyword.directive'],
      ["'A;B'", 'string'],
      [',', 'delimiter'],
      ['$00', 'number.hex'],
      ['; text', 'comment'],
    ]);
  });

  it('tokenizes every line of main.asm without invalid tokens, labels only in column 1 or with a colon', () => {
    const all = tokenize(mainAsm.join('\n'));
    expect(all).toHaveLength(mainAsm.length);
    const invalid = all.flatMap((t, i) => t.filter(([, ty]) => ty === 'invalid').map(([s]) => `${i + 1}: ${s}`));
    expect(invalid).toEqual([]);
    const macros = all.flatMap((t, i) => t.filter(([, ty]) => ty === 'identifier.macro').map(([s]) => `${i + 1}: ${s}`));
    expect(macros).toEqual([]); // no macros: every operation is a known mnemonic or directive
    const keywords = all.flat().filter(([, ty]) => ty === 'keyword').length;
    expect(keywords).toBeGreaterThan(100);
  });
});

/** Lab3 main.asm (private fixtures) must tokenize cleanly too. */
describe.skipIf(!FX)('HC12 Monarch tokenizer on the private Lab3 main.asm', () => {
  it('no invalid tokens, no macros', () => {
    const lab3 = readFileSync(join(fixturesDir(), 'Lab3/Sources/main.asm'), 'latin1').split(/\r?\n/);
    const all = tokenize(lab3.join('\n'));
    expect(all.flatMap((t) => t.filter(([, ty]) => ty === 'invalid' || ty === 'identifier.macro'))).toEqual([]);
  });
});

describe('HC12 tokenizer: other syntax', () => {
  it('column-1 * comments, octal, 0x hex, location counter, indented labels', () => {
    expect(line('* full line comment')).toEqual([['* full line comment', 'comment']]);
    expect(line('  loop: dbne  D,loop')).toEqual([
      ['loop:', 'label'],
      ['dbne', 'keyword'],
      ['D', 'variable.predefined'],
      [',', 'delimiter'],
      ['loop', 'identifier'],
    ]);
    expect(line(' ldaa @17')[1]).toEqual(['@17', 'number.octal']);
    expect(line(' ldx #0x1F00')[2]).toEqual(['0x1F00', 'number.hex']);
    expect(line(' bra *')).toEqual([
      ['bra', 'keyword'],
      ['*', 'operator'],
    ]);
  });

  it('S12X mnemonics, aliases and unknown operations (macro calls)', () => {
    for (const m of ['gldaa', 'DECW', 'addx', 'TFR', 'lbne', 'CLI', 'BHS', 'XGDX', 'call', 'rtc']) expect(line(` ${m} x`)[0], m).toEqual([m, 'keyword']);
    expect(line(' MyMacro 1,2')[0]).toEqual(['MyMacro', 'identifier.macro']);
    expect(line(' INCLUDE "derivative.inc"')).toEqual([
      ['INCLUDE', 'keyword.directive'],
      ['"derivative.inc"', 'string'],
    ]);
  });

  it('macro parameters and IF/ELSE/ENDIF', () => {
    expect(line(' ldaa \\1')[1]).toEqual(['\\1', 'variable.parameter']);
    expect(tokenize(' IFDEF _HCS12_SERIALMON\n ORG $3FFF\n ELSE\n ORG RAMStart\n ENDIF').map((t) => t[0])).toEqual([
      ['IFDEF', 'keyword.directive'],
      ['ORG', 'keyword.directive'],
      ['ELSE', 'keyword.directive'],
      ['ORG', 'keyword.directive'],
      ['ENDIF', 'keyword.directive'],
    ]);
  });

  it('mnemonic list comes from @s12/isa (CPU12 + CPU12X) and the directive list matches @s12/asm', () => {
    expect(HC12_MNEMONICS).toContain('LDAA');
    expect(HC12_MNEMONICS).toContain('GLDAA');
    expect(HC12_MNEMONICS).toContain('LSLA'); // alias
    expect(HC12_MNEMONICS.length).toBeGreaterThan(200);
    const src = readFileSync(join(repoRoot(), 'packages/asm/src/assembler.ts'), 'utf8');
    const m = /const DIRECTIVES = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(m).not.toBeNull();
    const asmDirectives = [...m![1].matchAll(/'([A-Z0-9]+)'/g)].map((x) => x[1]).sort();
    expect([...HC12_DIRECTIVES].sort()).toEqual(asmDirectives);
  });

  it('language by file extension', () => {
    expect(languageForPath('C:\\Lab3\\Sources\\main.asm')).toBe(HC12_LANGUAGE_ID);
    expect(languageForPath('/x/derivative.INC')).toBe(HC12_LANGUAGE_ID);
    expect(languageForPath('/x/bin/main.dbg')).toBe(HC12_LANGUAGE_ID);
    expect(languageForPath('/x/Project.prm')).toBe('plaintext');
  });
});
