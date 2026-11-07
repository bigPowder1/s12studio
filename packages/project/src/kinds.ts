/** File kinds as the project window and the build use them. */
import { extOf } from './paths';

export type FileKind =
  | 'asm'
  | 'inc'
  | 'lib'
  | 'o'
  | 'abs'
  | 'prm'
  | 'bbl'
  | 'map'
  | 'c'
  | 'h'
  | 'ini'
  | 'cmd'
  | 'text'
  | 'other';

const BY_EXT: Record<string, FileKind> = {
  '.asm': 'asm', '.s': 'asm', '.a12': 'asm',
  '.inc': 'inc', '.equ': 'inc',
  '.lib': 'lib', '.a': 'lib',
  '.o': 'o', '.obj': 'o',
  '.abs': 'abs', '.elf': 'abs',
  '.prm': 'prm', '.bbl': 'bbl', '.map': 'map',
  '.c': 'c', '.h': 'h',
  '.ini': 'ini', '.cmd': 'cmd',
  '.txt': 'text', '.lst': 'text', '.dbg': 'text', '.s19': 'text', '.glo': 'text', '.xpr': 'text', '.hwl': 'text',
};

/** Kind from the extension; a CodeWarrior file mapping (tool name) refines unknown extensions. */
export function fileKindOf(name: string, tool = ''): FileKind {
  const k = BY_EXT[extOf(name)];
  if (k) return k;
  if (/^Assembler\b/.test(tool)) return 'asm';
  if (/^Compiler\b/.test(tool)) return 'c';
  if (/^Importer\b/.test(tool)) return 'lib';
  return 'other';
}

/** Does this kind produce linker input? */
export const isLinkInput = (k: FileKind): boolean => k === 'asm' || k === 'lib' || k === 'o';

/** Default group (path) for a file added without one, after the Cal Poly template's layout. */
export function defaultGroupFor(k: FileKind): string[] {
  switch (k) {
    case 'asm':
    case 'c':
      return ['Sources'];
    case 'inc':
    case 'h':
      return ['Includes'];
    case 'lib':
    case 'o':
      return ['Libraries'];
    case 'prm':
    case 'bbl':
    case 'map':
      return ['Project Settings', 'Linker Files'];
    default:
      return ['Other'];
  }
}

/** CodeWarrior's default file-mapping tool for an extension (used for files added by S12 Studio). */
export function defaultToolFor(k: FileKind): { tool: string; ignoredByMake: boolean } {
  switch (k) {
    case 'asm':
      return { tool: 'Assembler for HC12', ignoredByMake: false };
    case 'inc':
      return { tool: 'Assembler for HC12', ignoredByMake: true };
    case 'lib':
    case 'o':
    case 'abs':
      return { tool: 'Importer for HC12', ignoredByMake: false };
    case 'c':
      return { tool: 'Compiler for HC12', ignoredByMake: false };
    case 'h':
      return { tool: 'Compiler for HC12', ignoredByMake: true };
    case 'prm':
    case 'bbl':
      return { tool: '', ignoredByMake: false };
    default:
      return { tool: '', ignoredByMake: true };
  }
}
