/**
 * CodeWarrior HC12 assembler messages: codes, default severities, texts and the output formats.
 *
 * Source: Metrowerks "HC12 Assembler" manual (2003), chapter "Assembler Messages" (A1..A12704), plus
 * docs/research/r1/asm.md §11. The manual prints every message with the classes it may be re-classed to,
 * e.g. "A2328: Value is truncated [DISABLE, INFORMATION, WARNING, ERROR]"; the default class was printed in
 * bold and lost in text extraction.
 * UNCERTAIN: every message listed with several classes defaults to WARNING here; messages listed with a single
 * class ([ERROR], [FATAL]) use that class.
 */
export type Severity = 'ERROR' | 'WARNING' | 'INFORMATION' | 'FATAL';

export interface AsmMessage {
  /** "A1104" etc. Non-CodeWarrior diagnostics of this clone use the "A9xxx" range. */
  code: string;
  severity: Severity;
  /** Path of the file the message refers to (as given to/derived by the assembler). */
  file: string;
  /** 1-based line in `file` (0 when not tied to a line). */
  line: number;
  /** 1-based column (0 when unknown). */
  column: number;
  /** Message text with placeholders filled in. */
  text: string;
  /** 0-based character position of the error in `file` (the `pos` of CW's verbose format). */
  pos?: number;
  /** The source line the message refers to (for the verbose format). */
  sourceLine?: string;
  /** For messages raised inside a macro expansion: the macro-call context line (CW "Macro Call :"). */
  macroContext?: string;
  /**
   * For messages raised inside a macro expansion (where `file`/`line` are the line of the macro DEFINITION):
   * file and line of the outermost macro call in a source file, so an IDE can jump to the offending call.
   */
  callFile?: string;
  callLine?: number;
  /** Line number in the .dbg (Abs.), when the message is tied to an assembled line. */
  absLine?: number;
  /** Index of the statement (source line in assembly order) the message belongs to. */
  stmt?: number;
}

type Def = [Severity, string];

/** Message catalogue: code → [default severity, text template]. */
export const MESSAGES: Record<string, Def> = {
  A1: ['FATAL', 'Unknown message occurred'],
  A2: ['WARNING', 'Message overflow, skipping <kind> messages'],
  A50: ['FATAL', "Input file '<file>' not found"],
  A51: ['WARNING', 'Cannot open statistic log file <file>'],
  A52: ['FATAL', 'Error in command line <cmd>'],
  A64: ['WARNING', 'Line Continuation occurred in <FileName>'],
  A65: ['WARNING', "Environment macro expansion error '<description>' for <variablename>"],
  A66: ['WARNING', 'Search path <Name> does not exist'],
  A1000: ['ERROR', 'Conditional directive not closed'],
  A1001: ['ERROR', 'Conditional else not allowed here'],
  A1004: ['ERROR', 'Macro nesting too deep'],
  A1051: ['WARNING', 'Zero Division in expression'],
  A1052: ['ERROR', 'Right parenthesis expected'],
  A1053: ['ERROR', 'Left parenthesis expected'],
  A1054: ['ERROR', 'References on non-absolute objects are not allowed when options -FA1 or -FA2 are enabled'],
  A1055: ['ERROR', 'Error in expression'],
  A1056: ['WARNING', 'Error at end of expression'],
  A1057: ['WARNING', 'Cutting constant because of overflow'],
  A1059: ['WARNING', '!= is taken as EQUAL'],
  A1060: ['WARNING', 'Implicit comment start'],
  A1101: ['ERROR', 'Illegal label: label is reserved'],
  A1103: ['ERROR', 'Illegal redefinition of label'],
  A1104: ['ERROR', 'Undeclared user defined symbol: <symbolName>'],
  A1201: ['ERROR', 'Label <labelName> referenced in directive ABSENTRY. Only labels defined in a code segment are allowed'],
  A1251: ['ERROR', 'Cannot open object file: Object file name too long'],
  A1401: ['ERROR', 'Value out of range -128..127'],
  A1402: ['ERROR', 'Value out of range -32768..32767'],
  A1405: ['ERROR', 'PAGE with initialized RAM not supported'],
  A1406: ['ERROR', 'HIGH with initialized RAM not supported'],
  A1407: ['ERROR', 'LOW with initialized RAM not supported'],
  A1410: ['ERROR', 'EQU or SET labels are not allowed in a PC Relative addressing mode'],
  A1411: ['ERROR', 'PC Relative addressing mode is not supported to constants'],
  A1412: ['ERROR', 'Relocatable object <Symbol> not allowed if generating absolute file'],
  A1413: ['WARNING', 'Value out of relative range'],
  A1414: ['ERROR', 'Cannot set fixup to constant'],
  A1415: ['WARNING', 'Cutting fixup overflow'],
  A1416: ['WARNING', 'Absolute section starting at <Address> size <Size> overlaps with absolute section starting at <Address2>'],
  A1417: ['WARNING', 'Value out of possible range'],
  A1502: ['ERROR', 'Reserved identifiers are not allowed as instruction or directive'],
  A1503: ['WARNING', 'Error in option -D: <Description>'],
  A1601: ['ERROR', 'Label must be terminated with a ":"'],
  A1602: ['ERROR', 'Invalid character at end of label (<LabelName>): semicolon or space expected'],
  A1603: ['ERROR', 'Directive, instruction or macro name expected: <SymbolName> detected'],
  A1604: ['ERROR', 'Invalid character detected at the beginning of the line: <Character>'],
  A1605: ['ERROR', 'Invalid label name: <LabelName>'],
  A2301: ['ERROR', 'Label is missing'],
  A2302: ['ERROR', 'Macro name is missing'],
  A2303: ['ERROR', 'ENDM is illegal'],
  A2304: ['ERROR', 'Macro definition within definition'],
  A2305: ['ERROR', 'Illegal redefinition of instruction or directive name'],
  A2306: ['ERROR', 'Macro not closed at end of source'],
  A2307: ['WARNING', 'Macro redefinition'],
  A2308: ['ERROR', 'File name expected'],
  A2309: ['ERROR', 'File not found'],
  A2310: ['ERROR', 'Size specification expected'],
  A2311: ['ERROR', 'Symbol name expected'],
  A2312: ['ERROR', 'String expected'],
  A2313: ['ERROR', 'Nesting of include files exceeds 50'],
  A2314: ['ERROR', 'Expression must be absolute'],
  A2316: ['ERROR', 'Section name required'],
  A2317: ['ERROR', 'Illegal redefinition of section name'],
  A2318: ['ERROR', 'Section not declared'],
  A2319: ['ERROR', 'No section link to this label'],
  A2320: ['ERROR', 'Value too small'],
  A2321: ['ERROR', 'Value too big'],
  A2323: ['WARNING', 'Label is ignored'],
  A2324: ['ERROR', 'Illegal Base (2,8,10,16)'],
  A2325: ['ERROR', 'Comma or Line end expected'],
  A2326: ['ERROR', 'Label <Name> is redefined'],
  A2327: ['ERROR', 'ON or OFF expected'],
  A2328: ['WARNING', 'Value is truncated'],
  A2329: ['ERROR', 'FAIL found'],
  A2330: ['ERROR', 'String is not allowed'],
  A2332: ['WARNING', 'FAIL found'],
  A2333: ['ERROR', 'Forward reference not allowed'],
  A2335: ['ERROR', 'Exported SET label is not supported'],
  A2338: ['ERROR', '<FailReason>'],
  A2340: ['ERROR', 'Macro parameter already defined'],
  A2341: ['ERROR', 'Relocatable Section Not Allowed: an Absolute file is currently directly generated'],
  A2342: ['ERROR', 'Label in an OFFSET section cannot be exported'],
  A2350: ['ERROR', 'MEXIT is illegal (detected outside of a macro)'],
  A2351: ['WARNING', 'Expected Comma to separate macro arguments'],
  A2352: ['ERROR', 'Invalid Character'],
  A2354: ['WARNING', "Ignoring directive '<directive>'"],
  A2355: ['WARNING', 'Illegal size specification'],
  A2356: ['WARNING', 'Illegal RAD50 character'],
  A2380: ['WARNING', 'Cutting very long line'],
  A2382: ['ERROR', "Illegal character ('\\0') in source file"],
  A2383: ['ERROR', 'Input line too long'],
  A2400: ['WARNING', 'End of Line expected'],
  A2401: ['ERROR', 'Complex relocatable expression not supported'],
  A2402: ['ERROR', 'Comma expected'],
  A2500: ['ERROR', 'Equal expected'],
  A2501: ['ERROR', 'TO expected'],
  A2502: ['ERROR', 'ENDFOR missing'],
  A2503: ['ERROR', 'ENDFOR without FOR'],
  A4000: ['ERROR', 'Recursive definition of label <Label name>'],
  A4001: ['WARNING', 'Data directive contains no data'],
  A4003: ['WARNING', 'Found XREF, but no XDEF for label <Label>, ignoring XREF'],
  A12001: ['ERROR', 'Illegal Addressing Mode'],
  A12003: ['WARNING', 'Value is truncated to one byte'],
  A12004: ['WARNING', 'Value is truncated to two bytes'],
  A12005: ['ERROR', 'Value must be between 1 and 8'],
  A12006: ['WARNING', 'Value is truncated to five bits'],
  A12008: ['ERROR', 'Relative branch with illegal target'],
  A12009: ['ERROR', 'Illegal expression'],
  A12010: ['ERROR', 'Register expected'],
  A12102: ['ERROR', 'Page value expected'],
  A12103: ['ERROR', 'Operand not allowed'],
  A12104: ['ERROR', 'Immediate value expected'],
  A12105: ['ERROR', 'Immediate Address Mode not allowed'],
  A12107: ['ERROR', 'Illegal size specification for HC12-instruction'],
  A12111: ['WARNING', 'Invalid Offset in TRAP instruction. valid offsets are $30 .. $39 and $40 .. $FF'],
  A12202: ['ERROR', 'Not a hc12 instruction or directive'],
  A12403: ['ERROR', 'Value out of range -256..255'],
  A12404: ['ERROR', 'Value out of range -16..15'],
  A12409: [
    'ERROR',
    'In PC relative addressing mode, references to object located in another section or file are only allowed for IDX2 addressing mode',
  ],
  A12411: [
    'ERROR',
    'Restriction: label specified in a DBNE, DBEQ, IBNE, IBEQ, TBNE or TBEQ instruction should be defined in the same section they are used',
  ],
  A12412: ['WARNING', 'PCR is ignored for this addressing mode'],
  A12600: ['ERROR', 'Address lower than segment current position'],
  // ---- Not CodeWarrior messages: limitations of this clone (A9xxx) ----
  A9001: ['ERROR', 'Relocation not supported by the S12 Studio object writer: <Description>'],
  A9002: ['ERROR', 'Internal assembler error: <Description>'],
  A9003: ['WARNING', 'Unknown option ignored: <Option>'],
  A9004: ['INFORMATION', 'Option <Option> not supported by S12 Studio: a relocatable ELF object file is generated instead'],
  A9005: ['WARNING', 'Character code above 0xFF in <Description>: only the low 8 bits are used'],
};

/** Fill `<...>` placeholders in order with `args`. */
export function messageText(code: string, ...args: Array<string | number>): string {
  const def = MESSAGES[code];
  let t = def ? def[1] : `Unknown message ${code}`;
  for (const a of args) t = t.replace(/<[^<>]+>/, String(a));
  return t;
}

export function defaultSeverity(code: string): Severity {
  return MESSAGES[code]?.[0] ?? 'ERROR';
}

/** -W1/-W2 and -WmsgS<x><code> handling. */
export interface MessagePolicy {
  /** 0 = all, 1 = no INFORMATION, 2 = no INFORMATION/WARNING. */
  warningLevel: 0 | 1 | 2;
  /** Re-classification per code ('DISABLE' drops the message). */
  overrides: Record<string, Severity | 'DISABLE'>;
}

/** Severity after policy, or undefined when the message is suppressed. */
export function applyPolicy(code: string, sev: Severity, policy?: MessagePolicy): Severity | undefined {
  if (!policy) return sev;
  const o = policy.overrides[code];
  if (o === 'DISABLE') return undefined;
  const s = o ?? sev;
  if (s === 'INFORMATION' && policy.warningLevel >= 1) return undefined;
  if (s === 'WARNING' && policy.warningLevel >= 2) return undefined;
  return s;
}

export type MessageFormat = 'verbose' | 'batch' | 'microsoft' | 'ide';

const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1);

/**
 * Render a message like the CodeWarrior tools do.
 * - 'verbose' (-WmsgFoi default, interactive): `\n>> in "%f%e", line %l, col %c, pos %o\n%s\n%K %d: %m\n`,
 *   where %s is the source line followed by a caret line under the column; a "Macro Call :" context line is
 *   appended for messages raised inside a macro expansion (see the FAIL examples of the manual).
 * - 'batch' (-WmsgFob default): `%f%e(%l): %K %d: %m\n`.
 * - 'microsoft': `%f%e(%l): %k %d: %m\n` (UNCERTAIN: lower-case kind as in MS tools).
 * - Messages without a file use -WmsgFonf `%K %d: %m\n`; with a file but no line, -WmsgFonp `%f%e: %K %d: %m\n`.
 * - 'ide': the CodeWarrior IDE "Errors & Warnings" rendering, `Error   : A1104: ...\nmain.asm line 25\n`.
 *   UNCERTAIN: exact IDE spacing (from memory, docs/research/r1/asm.md §11).
 */
export function formatMessage(m: AsmMessage, format: MessageFormat = 'verbose'): string {
  const kind = format === 'microsoft' ? m.severity.toLowerCase() : m.severity;
  if (format !== 'ide') {
    // Manual defaults: -WmsgFonf "%K %d: %m\n" (no file information) and -WmsgFonp "%f%e: %K %d: %m\n" (a file but
    // no position, e.g. A50 "Input file not found"). They apply in every mode.
    if (!m.file) return `${kind} ${m.code}: ${m.text}\n`;
    if (!m.line) return `${m.file}: ${kind} ${m.code}: ${m.text}\n`;
  }
  switch (format) {
    case 'batch':
      return `${m.file}(${m.line}): ${m.severity} ${m.code}: ${m.text}\n`;
    case 'microsoft':
      return `${m.file}(${m.line}): ${m.severity.toLowerCase()} ${m.code}: ${m.text}\n`;
    case 'ide': {
      const k = m.severity === 'ERROR' || m.severity === 'FATAL' ? 'Error' : m.severity === 'WARNING' ? 'Warning' : 'Information';
      const where = !m.file ? '' : m.line ? `${baseName(m.file)} line ${m.line}\n` : `${baseName(m.file)}\n`;
      return `${k.padEnd(8)}: ${m.code}: ${m.text}\n${where}`;
    }
    default: {
      let s = `\n>> in "${m.file}", line ${m.line}, col ${m.column}, pos ${m.pos ?? 0}\n`;
      if (m.sourceLine !== undefined) {
        s += `${m.sourceLine}\n${' '.repeat(Math.max(0, m.column - 1))}^\n`;
      }
      s += `${m.severity} ${m.code}: ${m.text}\n`;
      if (m.macroContext) s += `Macro Call : ${m.macroContext}\n`;
      return s;
    }
  }
}
