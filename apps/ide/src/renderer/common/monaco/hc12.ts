/**
 * HC12 / HCS12 / HCS12X (CPU12 + CPU12X) assembly language for Monaco: Monarch tokenizer + language configuration.
 * Pure data (type-only Monaco import), so it is testable without the editor and shared by the IDE editor and the
 * debugger Source component.
 *
 * Field rules mirror the CodeWarrior assembler (@s12/asm line.ts):
 *   [label[:]] [operation[.size]] [operands] [;comment]
 *   - an identifier starting in column 1 is a label, with or without ':'; an indented label needs ':'
 *   - '*' or ';' in column 1 starts a comment line; ';' anywhere outside a string starts a comment
 *   - numbers: $hex, %bin, @oct, decimal (also 0x.. as accepted by the assembler's expression parser)
 *
 * Token names (theme rules in themes.ts):
 *   comment, keyword (CPU mnemonic), keyword.directive, label, identifier, identifier.macro (unknown operation =
 *   macro call), number / number.hex / number.binary / number.octal, string, variable.predefined (register),
 *   variable.parameter (macro \1..\9, \@), delimiter, operator, invalid.
 */
import type * as Monaco from 'monaco-editor/editor/editor.api';
import { ALIASES, OPCODE_FORMS } from '@s12/isa';

export const HC12_LANGUAGE_ID = 'hc12asm';

/** File extensions mapped to the HC12 assembler (CW File Mappings: .asm .s .inc .dbg go to "Assembler for HC12"). */
export const HC12_EXTENSIONS = ['.asm', '.s', '.inc', '.dbg', '.def'];

/** Every CPU12 + CPU12X mnemonic the assembler accepts (canonical forms + aliases), upper case, sorted. */
export const HC12_MNEMONICS: readonly string[] = [...new Set([...OPCODE_FORMS.map((f) => f.mnemonic), ...ALIASES.map((a) => a.alias)])].sort();

/**
 * Assembler directives. Same list as @s12/asm assembler.ts DIRECTIVES (not exported there; kept in sync by the
 * hc12 tokenizer test), plus the CodeWarrior spellings the assembler treats as synonyms.
 */
export const HC12_DIRECTIVES: readonly string[] = [
  'ORG', 'SECTION', 'OFFSET', 'END', 'EQU', 'SET', 'XDEF', 'GLOBAL', 'PUBLIC', 'XREF', 'EXTERNAL', 'XREFB',
  'ABSENTRY', 'INCLUDE', 'DC', 'DCB', 'DS', 'FCB', 'FDB', 'FQB', 'DCW', 'DCL', 'FCC', 'RMB', 'RMD', 'RMQ', 'RAD50',
  'ALIGN', 'EVEN', 'LONGEVEN', 'BASE', 'IF', 'IFEQ', 'IFNE', 'IFLT', 'IFLE', 'IFGT', 'IFGE', 'IFC', 'IFNC', 'IFDEF',
  'IFNDEF', 'ELSE', 'ELSEC', 'ENDIF', 'ENDC', 'MACRO', 'ENDM', 'MEXIT', 'LIST', 'NOLIST', 'NOL', 'CLIST', 'MLIST',
  'PLEN', 'LLEN', 'TABS', 'SPC', 'PAGE', 'NOPAGE', 'TITLE', 'TTL', 'FAIL',
];

/** Register names that can appear in operands (indexed modes, TFR/EXG, incl. the CPU12X 8/16-bit halves). */
export const HC12_REGISTERS: readonly string[] = [
  'A', 'B', 'D', 'X', 'Y', 'SP', 'PC', 'PCR', 'CCR', 'CCRH', 'CCRL', 'CCRW', 'XH', 'XL', 'YH', 'YL', 'SPH', 'SPL',
  'TMP1', 'TMP2', 'TMP3', 'TEMP1', 'TEMP2',
];

/** Monarch definition. `ignoreCase` makes the keyword lists case-insensitive (`ldaa` == `LDAA`). */
export const hc12Monarch: Monaco.languages.IMonarchLanguage & { mnemonics: readonly string[]; directives: readonly string[]; registers: readonly string[] } = {
  defaultToken: '',
  ignoreCase: true,
  tokenPostfix: '.hc12',
  mnemonics: HC12_MNEMONICS,
  directives: HC12_DIRECTIVES,
  registers: HC12_REGISTERS,
  tokenizer: {
    // Every state starts with the column-1 rules, so each line begins with a fresh field split whatever state the
    // previous line ended in (Monarch carries the state across lines). No rule matches empty text at column 0.
    lineStart: [
      [/^\*.*$/, 'comment'],
      [/^;.*$/, 'comment'],
      [/^[A-Za-z_.][\w.]*:?/, { token: 'label', switchTo: '@operation' }],
      [/^[ \t]+/, { token: 'white', switchTo: '@operation' }],
    ],
    root: [{ include: '@lineStart' }, { include: '@operation' }],
    operation: [
      { include: '@lineStart' },
      [/[ \t]+/, 'white'],
      [/;.*$/, 'comment'],
      // indented label (needs the colon)
      [/[A-Za-z_.][\w.]*:/, 'label'],
      [
        /([A-Za-z_][\w]*)(\.[A-Za-z]+)?/,
        {
          cases: {
            '$1@mnemonics': { token: 'keyword', switchTo: '@operands' },
            '$1@directives': { token: 'keyword.directive', switchTo: '@operands' },
            '@default': { token: 'identifier.macro', switchTo: '@operands' },
          },
        },
      ],
      [/\S+/, { token: 'invalid', switchTo: '@operands' }],
    ],
    operands: [
      { include: '@lineStart' },
      [/[ \t]+/, 'white'],
      [/;.*$/, 'comment'],
      [/'(?:[^']|'')*'?/, 'string'],
      [/"(?:[^"]|"")*"?/, 'string'],
      [/0[xX][0-9A-Fa-f]+/, 'number.hex'],
      [/\$[0-9A-Fa-f]+/, 'number.hex'],
      [/%[01]+/, 'number.binary'],
      [/@[0-7]+/, 'number.octal'],
      [/\d+/, 'number'],
      [/\\[0-9@@A-Za-z]/, 'variable.parameter'], // @@ = literal @ in Monarch
      [/[A-Za-z_.][\w.]*/, { cases: { '@registers': 'variable.predefined', '@default': 'identifier' } }],
      [/#/, 'operator'],
      [/[+\-*/&|^~!<>=%]+/, 'operator'],
      [/[()[\],]/, 'delimiter'],
      [/./, 'invalid'],
    ],
  },
};

export const hc12LanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: ';' },
  brackets: [
    ['(', ')'],
    ['[', ']'],
  ],
  autoClosingPairs: [],
  surroundingPairs: [],
  // labels may contain '.' and '_' (word navigation, double-click selection, find whole word)
  wordPattern: /(-?\d*\.\d\w*)|([$%@]?[\w.]+)/,
};

/** Monaco language id for a file path (HC12 for assembler files, plaintext otherwise). */
export function languageForPath(path: string): string {
  const p = path.toLowerCase();
  if (HC12_EXTENSIONS.some((e) => p.endsWith(e))) return HC12_LANGUAGE_ID;
  return 'plaintext';
}
