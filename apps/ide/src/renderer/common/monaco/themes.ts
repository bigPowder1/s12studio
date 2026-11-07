/**
 * Monaco themes:
 *   - 'cw-ide'    CodeWarrior IDE editor defaults (Edit > Preferences > Text Colors): keywords blue, comments red,
 *                 normal text black (docs/research/r1/ide.md §5, C screenshots).
 *   - 'cw-hiwave' hiwave Source component chroma coding (debugger manual): keywords blue, comments green, strings red.
 * Both are plain white-background, classic-Windows looking. Colours are in one table so they are easy to change.
 */
import type * as Monaco from 'monaco-editor/editor/editor.api';
import { THEME } from '../../../shared/theme/tokens';

export const CW_IDE_THEME = 'cw-ide';
export const CW_HIWAVE_THEME = 'cw-hiwave';
/** Syntax colouring off (Document Settings toggle): everything black. */
export const CW_PLAIN_THEME = 'cw-plain';

export interface SyntaxColors {
  text: string;
  keyword: string;
  directive: string;
  comment: string;
  string: string;
  number: string;
  label: string;
  register: string;
}

/**
 * UNCERTAIN: the CW default colours for .asm are not confirmed (ide.md §5: "likely only Custom Keywords and
 * comments"). Keywords blue / comments red are the confirmed C defaults; strings grey and black numbers/labels are
 * from memory of the classic Text Colors panel.
 */
export const CW_IDE_COLORS: SyntaxColors = {
  text: '#000000',
  keyword: '#0000ff',
  directive: '#0000ff',
  comment: '#b30000',
  string: '#666666',
  number: '#000000',
  label: '#000000',
  register: '#000000',
};

export const CW_HIWAVE_COLORS: SyntaxColors = {
  text: '#000000',
  keyword: THEME.syntaxKeyword,
  directive: THEME.syntaxKeyword,
  comment: THEME.syntaxComment,
  string: THEME.syntaxString,
  number: '#000000',
  label: '#000000',
  register: '#000000',
};

const hex = (c: string) => c.replace('#', '');

export function themeFor(colors: SyntaxColors): Monaco.editor.IStandaloneThemeData {
  return {
    base: 'vs',
    inherit: false,
    rules: [
      { token: '', foreground: hex(colors.text) },
      { token: 'comment', foreground: hex(colors.comment) },
      { token: 'keyword', foreground: hex(colors.keyword) },
      { token: 'keyword.directive', foreground: hex(colors.directive) },
      { token: 'string', foreground: hex(colors.string) },
      { token: 'number', foreground: hex(colors.number) },
      { token: 'label', foreground: hex(colors.label) },
      { token: 'variable.predefined', foreground: hex(colors.register) },
      { token: 'identifier', foreground: hex(colors.text) },
      { token: 'invalid', foreground: hex(colors.text) },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': colors.text,
      'editorLineNumber.foreground': '#808080',
      'editorLineNumber.activeForeground': '#000000',
      'editor.selectionBackground': THEME.highlight,
      'editor.selectionForeground': '#ffffff',
      'editor.inactiveSelectionBackground': '#c0c0c0',
      'editor.lineHighlightBackground': '#00000000',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#000000',
      'editorGutter.background': '#ffffff',
      'editorWhitespace.foreground': '#c0c0c0',
      'editorIndentGuide.background1': '#00000000',
      'editorIndentGuide.activeBackground1': '#00000000',
      'scrollbarSlider.background': '#c0c0c080',
      'editor.findMatchBackground': THEME.highlight,
      'editor.findMatchForeground': '#ffffff',
      'editor.findMatchHighlightBackground': '#a6caf080',
    },
  };
}

export const PLAIN_COLORS: SyntaxColors = { text: '#000000', keyword: '#000000', directive: '#000000', comment: '#000000', string: '#000000', number: '#000000', label: '#000000', register: '#000000' };

export const MONACO_THEMES: Record<string, Monaco.editor.IStandaloneThemeData> = {
  [CW_IDE_THEME]: themeFor(CW_IDE_COLORS),
  [CW_HIWAVE_THEME]: themeFor(CW_HIWAVE_COLORS),
  [CW_PLAIN_THEME]: themeFor(PLAIN_COLORS),
};
