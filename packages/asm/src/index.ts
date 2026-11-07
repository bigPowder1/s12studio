/**
 * @s12/asm: clone of the CodeWarrior "HC12-Assembler" (Assembler for HC12 V-5.0.30 Build 10203).
 *
 * `assemble()` is a pure function: all file access goes through `readFile`. It returns the CW-dialect ELF object,
 * the `.lst` listing (when -L is given), the `.dbg` debug source and CodeWarrior-style messages.
 */
import type { ElfFile } from '@s12/formats';
import { Assembler, type SourceFile } from './assembler.js';
import { writeDbg, writeListing } from './listing.js';
import { applyPolicy, defaultSeverity, messageText, type AsmMessage } from './messages.js';
import { buildAssemblerNotes, buildObject, isObjectSymbol, type NoteMeta } from './object.js';
import { resolveOptions, type AsmOptions } from './options.js';
import { dirName, expandModifiers, joinPath, stemName } from './paths.js';

export * from './messages.js';
export * from './options.js';
export * from './expr.js';
export { parseLine, splitOperands, commentStart, type ParsedLine } from './line.js';
export { InstructionEncoder, isInstruction, type EncodeContext, type EncodeResult, type Fixup, type FixupKind } from './encoder.js';
export { writeListing, writeDbg, formatObject } from './listing.js';
export { buildAssemblerNotes, ctime, computeSizes, ASSEMBLER_PRODUCER, type NoteMeta } from './object.js';
export { Assembler, splitLines, LI_EXCLUDES_INCLUDES_FROM_DBG, type SourceFile } from './assembler.js';
export { expandModifiers, joinPath, dirName, baseName } from './paths.js';
export type { Section, Sym, Stmt } from './types.js';

export interface AssembleInput {
  /** Path of the main source file (passed to `readFile`). */
  sourcePath: string;
  /**
   * File access. Return undefined when the file does not exist. Should match names case-insensitively on Windows.
   * Text encoding: CodeWarrior works on 8-bit bytes. Return the raw bytes (Uint8Array, decoded 1:1 as Latin-1) or a
   * string whose char codes are those bytes (e.g. Node `readFileSync(p, 'latin1')`). Characters above U+00FF in a
   * string are reduced to their low 8 bits in DC/FCC strings and character constants (warning A9005).
   */
  readFile: (path: string) => string | Uint8Array | undefined;
  /** CodeWarrior option string (e.g. "-CPUHCS12X -L=%(TEXTPATH)\\%n.lst -Li") or an options object. */
  options?: string | Partial<AsmOptions>;
  /** Environment (GENPATH, OBJPATH, TEXTPATH, ...). `-env` options override it. */
  env?: Record<string, string>;
  /** `.note` metadata (user, time, command line). */
  noteMeta?: NoteMeta;
  /** Path of the .dbg (default: first OBJPATH entry, else the source directory, + <name>.dbg). */
  dbgPath?: string;
  /** DW_AT_comp_dir (default: directory of dbgPath). */
  compDir?: string;
  /** Working directory used first when searching INCLUDE files (default: directory of the source). */
  cwd?: string;
  /**
   * Subdirectories of a directory (full paths); enables recursive GENPATH entries (`C:\\lib*`). Optional: without
   * it a recursive entry searches only the folder itself.
   */
  listSubdirs?: (dir: string) => string[] | undefined;
  /** -Li: drop included lines from the .dbg (default LI_EXCLUDES_INCLUDES_FROM_DBG; UNCERTAIN, lab-PC check). */
  liExcludesIncludesFromDbg?: boolean;
}

export interface AsmSymbolInfo {
  name: string;
  kind: 'label' | 'equ' | 'set' | 'xref';
  section?: string;
  /** Section offset (relocatable) or absolute address / value. */
  value: number;
  size?: number;
  global: boolean;
  defined: boolean;
  /** Object symbol index (when emitted). */
  elfIndex?: number;
  file?: string;
  line?: number;
}

export interface AsmSectionInfo {
  name: string;
  kind: 'default' | 'reloc' | 'org';
  /** ORG address (0 for relocatable sections). */
  address: number;
  size: number;
  type: 'code' | 'const' | 'data';
  elfIndex?: number;
}

/** Address → source mapping for debuggers: one entry per code/data statement. */
export interface AsmLineInfo {
  section: string;
  /** Section offset (relocatable) or absolute address (ORG). */
  address: number;
  size: number;
  /** Line in the .dbg. */
  absLine: number;
  file: string;
  line: number;
}

export interface AssembleResult {
  ok: boolean;
  objectBytes?: Uint8Array;
  object?: ElfFile;
  /**
   * Object file path: -ObjN (default `%n.o`) with special modifiers expanded; a name without a directory goes to
   * the first OBJPATH entry (else the source directory). CW's IDE passes `-objn"<abs path>.asm.o"`.
   */
  objectPath: string;
  /**
   * `.lst` text. Like `dbg.text` it is a Latin-1 "binary string" (one char per output byte, CRLF line ends): write it
   * with `encodeLatin1(text)` / Node `writeFileSync(path, text, 'latin1')` to get the byte-identical file.
   */
  listing?: { path: string; text: string };
  /** `.dbg` text (Latin-1 binary string, see `listing`). */
  dbg: { path: string; text: string };
  messages: AsmMessage[];
  symbols: AsmSymbolInfo[];
  sections: AsmSectionInfo[];
  lines: AsmLineInfo[];
  /** Files read through INCLUDE. */
  includes: string[];
  options: AsmOptions;
}

/** Bytes of a Latin-1 "binary string" (`listing.text`, `dbg.text`); char codes above 0xFF keep their low 8 bits. */
export function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Default -ObjN (manual: "Default: -ObjN%n.o").
 * UNCERTAIN: the manual's default; CW's IDE always passes an explicit -objn"<full path>\\<name>.asm.o".
 */
export const DEFAULT_OBJN = '%n.o';

/** First entry of a ';'-separated path list (undefined when empty). */
function firstPath(list: string | undefined): string | undefined {
  const p = (list ?? '').split(';').map((s) => s.trim()).find(Boolean);
  return p || undefined;
}

/** Expand an output-file option (-ObjN, -L) and put a bare file name into `dir`. */
function outputPath(tmpl: string, src: string, env: Record<string, string>, dir: string): string {
  const name = expandModifiers(tmpl, src, env);
  return /[\\/]/.test(name) || /^[A-Za-z]:/.test(name) ? name : joinPath(dir, name);
}

/** Assemble one source file. */
export function assemble(input: AssembleInput): AssembleResult {
  const parsed = resolveOptions(input.options);
  const options = parsed.options;
  const env: Record<string, string> = { ...(input.env ?? {}), ...options.env };
  const src = input.sourcePath;
  const asm = new Assembler({ sourcePath: src, readFile: input.readFile, options, env, cwd: input.cwd, listSubdirs: input.listSubdirs, liExcludesIncludesFromDbg: input.liExcludesIncludesFromDbg });
  for (const p of parsed.problems) {
    // Command-line problems carry no file/position information (formatted with -WmsgFonf).
    const sev = applyPolicy(p.code, defaultSeverity(p.code), options.messages);
    if (sev) asm.messages.push({ code: p.code, severity: sev, file: '', line: 0, column: 0, text: p.text });
  }
  try {
    asm.run();
  } catch (e) {
    // Never let an internal failure escape to the IDE build call: report it like CodeWarrior's internal error.
    const cur = asm.currentStmt;
    const where = cur ? { file: cur.file, line: cur.line } : { file: src, line: 0 };
    asm.messages.push({ code: 'A9002', severity: 'ERROR', ...where, column: 0, text: messageText('A9002', e instanceof Error ? e.message : String(e)) });
  }

  // Output directories (manual "Environment"): OBJPATH receives the object and the debug listing (.dbg),
  // TEXTPATH the .lst; with several ';'-separated entries the first one is used. Without them: the source directory.
  const objDir = firstPath(env.OBJPATH) ?? dirName(src);
  const textDir = firstPath(env.TEXTPATH) ?? dirName(src);
  const dbgPath = input.dbgPath ?? joinPath(objDir, stemName(src) + '.dbg');
  const compDir = input.compDir ?? dirName(dbgPath);
  const objectPath = outputPath(options.objectFile ?? DEFAULT_OBJN, src, env, objDir);
  const dbg = { path: dbgPath, text: writeDbg(asm.stmts) };
  const ok = !asm.hasErrors;

  const result: AssembleResult = {
    ok,
    objectPath,
    dbg,
    messages: asm.messages,
    symbols: [],
    sections: [],
    lines: [],
    includes: asm.includedFiles,
    options,
  };

  if (ok) {
    const notes = buildAssemblerNotes(input.noteMeta ?? {}, options.raw);
    const obj = buildObject({ sections: asm.sections, symbols: asm.symList, stmts: asm.stmts, dbgPath, compDir, notes });
    result.object = obj.elf;
    result.objectBytes = obj.bytes;
    // CodeWarrior writes no listing when errors occurred (manual, "Assembler Listing File").
    if (options.listing) {
      result.listing = { path: outputPath(options.listingFile ?? '%n.lst', src, env, textDir), text: writeListing(asm.stmts, { lasmc: options.lasmc, lasms: options.lasms }) };
    }
  }

  for (const s of asm.symList) {
    if (s.kind === 'none') continue;
    const info: AsmSymbolInfo = {
      name: s.name,
      kind: s.kind,
      value: s.value,
      global: s.xdef || s.kind === 'xref',
      defined: s.defined,
    };
    if (s.section && s.section.kind !== 'offset') info.section = s.section.name;
    if (s.size !== undefined) info.size = s.size;
    if (s.elfIndex !== undefined && isObjectSymbol(s)) info.elfIndex = s.elfIndex;
    if (s.defStmt) {
      info.file = s.defStmt.file;
      info.line = s.defStmt.line;
    }
    result.symbols.push(info);
  }
  for (const s of asm.sections) {
    if (s.kind === 'offset') continue;
    const sec: AsmSectionInfo = {
      name: s.name,
      kind: s.kind as 'default' | 'reloc' | 'org',
      address: s.kind === 'org' ? s.base : 0,
      size: s.size,
      type: s.hasCode ? 'code' : s.hasConst ? 'const' : 'data',
    };
    if (s.elfIndex !== undefined) sec.elfIndex = s.elfIndex;
    result.sections.push(sec);
  }
  for (const st of asm.stmts) {
    if ((st.type === 'instr' || st.type === 'dc') && st.size > 0 && !st.skipped && st.section && st.section.kind !== 'offset') {
      result.lines.push({ section: st.section.name, address: st.loc, size: st.size, absLine: st.absLine, file: st.file, line: st.line });
    }
  }
  return result;
}

export type { SourceFile as AsmSourceFile };
