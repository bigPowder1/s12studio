/**
 * CodeWarrior HC12 assembler command-line / option-string parser.
 *
 * Option syntax follows the HC(S)12 Assembler Manual ("Assembler Options"): options are separated by blanks,
 * a value may be quoted anywhere inside the token (`-env"GENPATH=a;b c"`, `-objn"C:\x y\main.asm.o"`), option
 * names are case-insensitive for the documented spellings (`-CpuHCS12X` / `-CPUHCS12X`). Unknown options produce
 * a warning (A9003) and are ignored instead of failing.
 */
import { MESSAGES, type MessagePolicy, type Severity } from './messages.js';

export type AsmCpu = 'CPU12' | 'HCS12' | 'HCS12X';

export interface AsmOptions {
  /** -Cpu{CPU12|HCS12|HCS12X}; default CPU12 (manual). */
  cpu: AsmCpu;
  /** -L[=file] given. */
  listing: boolean;
  /** -L=<dest> template (special modifiers not yet expanded). */
  listingFile?: string;
  /** -Lc: no macro calls in the listing. */
  noMacroCalls: boolean;
  /** -Ld: no macro definitions in the listing. */
  noMacroDefs: boolean;
  /** -Le: no macro expansions in the listing. */
  noMacroExpansions: boolean;
  /** -Li: included files are not expanded in the listing. */
  noIncludes: boolean;
  /** -Lasmc=<flags>: columns NOT written (s r m l k i c a). */
  lasmc: string;
  /** -Lasms{1..4}: address digits = 2*n (default 3 → 6 digits). */
  lasms: 1 | 2 | 3 | 4;
  /** -D<name>[=<value>]. */
  defines: Array<{ name: string; value: number }>;
  /** -Ms / -Mb / -Ml memory model. */
  memoryModel: 'SMALL' | 'BANKED' | 'LARGE';
  /** -F2 (default) / -FA2 / -Fh / -F2o / -FA2o. */
  format: 'F2' | 'FA2' | 'Fh' | 'F2o' | 'FA2o';
  /** -Ci: case-insensitive labels. */
  caseInsensitive: boolean;
  /** -CpDirect<num>: DIRECT page window start (HCS12X). */
  cpDirect: number;
  /** -Compat[=flags]. */
  compat: string;
  /** -MCUasm. */
  mcuAsm: boolean;
  /** -MacroNest<n> (UNCERTAIN default 1000). */
  macroNest: number;
  /** -CMacBrackets (default on) / -CMacAngBrack. */
  macroBrackets: boolean;
  macroAngleBrackets: boolean;
  /** -W1 / -W2 and -WmsgS{d,e,i,w}<code>. */
  messages: MessagePolicy;
  /** -I<path> include search paths. */
  includePaths: string[];
  /** -Env<NAME>=<value> / -env"NAME=value". */
  env: Record<string, string>;
  /** -ObjN=<file> / -objn"file": object file name. */
  objectFile?: string;
  /** -Prod=<file>. */
  prod?: string;
  /** -NoDebugInfo. */
  noDebugInfo: boolean;
  /** Options that were not recognised (each also reported as A9003). */
  unknown: string[];
  /** The raw option string (used as the default `.note` command line). */
  raw: string;
}

export function defaultOptions(): AsmOptions {
  return {
    cpu: 'CPU12',
    listing: false,
    noMacroCalls: false,
    noMacroDefs: false,
    noMacroExpansions: false,
    noIncludes: false,
    lasmc: '',
    lasms: 3,
    defines: [],
    memoryModel: 'SMALL',
    format: 'F2',
    caseInsensitive: false,
    cpDirect: 0,
    compat: '',
    mcuAsm: false,
    macroNest: 1000,
    macroBrackets: true,
    macroAngleBrackets: true,
    messages: { warningLevel: 0, overrides: {} },
    includePaths: [],
    env: {},
    noDebugInfo: false,
    unknown: [],
    raw: '',
  };
}

/** Split an option string into tokens: blanks separate, double quotes group (and are removed). */
export function tokenizeOptions(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  let any = false;
  for (const ch of s) {
    if (ch === '"') {
      inQ = !inQ;
      any = true;
      continue;
    }
    if (!inQ && /\s/.test(ch)) {
      if (any || cur) out.push(cur);
      cur = '';
      any = false;
      continue;
    }
    cur += ch;
  }
  if (any || cur) out.push(cur);
  return out;
}

/** Parse a C-like or CW number: 0x.., $.., decimal. */
function parseNum(s: string): number | undefined {
  const t = s.trim();
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2), 16);
  if (/^\$[0-9a-f]+$/i.test(t)) return parseInt(t.slice(1), 16);
  if (/^-?[0-9]+$/.test(t)) return parseInt(t, 10);
  return undefined;
}

export interface ParsedOptions {
  options: AsmOptions;
  /** Problems found while parsing (unknown options, bad values). */
  problems: Array<{ code: string; text: string; option: string }>;
  /** Source files named on the command line (tokens not starting with '-'). */
  files: string[];
}

const SEV: Record<string, Severity | 'DISABLE'> = { d: 'DISABLE', e: 'ERROR', i: 'INFORMATION', w: 'WARNING' };

/** Options accepted and ignored (host/UI related). */
const IGNORED = /^-(H|N|NoBeep|NoEnv|V|View\w*|Lic\w*|WErrFile\w*|WOutFile\w*|WStdout\w*|Wmsg8x3|WmsgC\w+|WmsgF\w*|WmsgN[eiuw]\d*|Struct\w*|C=SAvocet|Prod(=.*)?)$/i;

/** Parse a CodeWarrior assembler option string (or command line). */
export function parseOptions(input: string): ParsedOptions {
  const o = defaultOptions();
  o.raw = input;
  const problems: ParsedOptions['problems'] = [];
  const files: string[] = [];
  for (const tok of tokenizeOptions(input)) {
    if (!tok.startsWith('-')) {
      if (tok) files.push(tok);
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = tok.match(/^-cpu(cpu12|hcs12x|hcs12|hc12)$/i))) {
      const c = m[1].toUpperCase();
      o.cpu = c === 'HCS12X' ? 'HCS12X' : c === 'HCS12' ? 'HCS12' : 'CPU12';
    } else if ((m = tok.match(/^-L(?:=(.*))?$/i))) {
      o.listing = true;
      if (m[1] !== undefined && m[1] !== '') o.listingFile = m[1];
    } else if (/^-Lc$/i.test(tok)) {
      o.listing = true;
      o.noMacroCalls = true;
    } else if (/^-Ld$/i.test(tok)) {
      o.listing = true;
      o.noMacroDefs = true;
    } else if (/^-Le$/i.test(tok)) {
      o.listing = true;
      o.noMacroExpansions = true;
    } else if (/^-Li$/i.test(tok)) {
      o.listing = true;
      o.noIncludes = true;
    } else if ((m = tok.match(/^-Lasmc=([srmlkica]*)$/i))) {
      o.lasmc = m[1].toLowerCase();
    } else if ((m = tok.match(/^-Lasms([1-4])$/i))) {
      o.lasms = Number(m[1]) as 1 | 2 | 3 | 4;
    } else if ((m = tok.match(/^-D([A-Za-z_.][A-Za-z0-9_.]*)(?:=(.*))?$/i))) {
      const v = m[2] === undefined ? 0 : parseNum(m[2]);
      if (v === undefined) problems.push({ code: 'A1503', text: MESSAGES.A1503[1].replace('<Description>', tok), option: tok });
      else o.defines.push({ name: m[1], value: v });
    } else if ((m = tok.match(/^-M([sbl])$/i))) {
      o.memoryModel = m[1].toLowerCase() === 's' ? 'SMALL' : m[1].toLowerCase() === 'b' ? 'BANKED' : 'LARGE';
    } else if ((m = tok.match(/^-F(A2o|A2|2o|2|h)$/i))) {
      const f = m[1].toUpperCase();
      o.format = f === 'A2O' ? 'FA2o' : f === 'A2' ? 'FA2' : f === '2O' ? 'F2o' : f === '2' ? 'F2' : 'Fh';
    } else if (/^-Ci$/i.test(tok)) {
      o.caseInsensitive = true;
    } else if ((m = tok.match(/^-CpDirect(.+)$/i))) {
      const v = parseNum(m[1]);
      if (v === undefined) problems.push({ code: 'A52', text: `Error in command line ${tok}`, option: tok });
      else o.cpDirect = v & 0xff00;
    } else if ((m = tok.match(/^-Compat(?:=(.*))?$/i))) {
      o.compat = m[1] ?? 'cs!=a$b';
    } else if (/^-MCUasm$/i.test(tok)) {
      o.mcuAsm = true;
    } else if ((m = tok.match(/^-MacroNest(\d+)$/i))) {
      o.macroNest = Number(m[1]);
    } else if (/^-CMacBrackets$/i.test(tok)) {
      o.macroBrackets = true;
    } else if (/^-CMacAngBrack$/i.test(tok)) {
      o.macroAngleBrackets = true;
    } else if (/^-W1$/i.test(tok)) {
      o.messages.warningLevel = 1;
    } else if (/^-W2$/i.test(tok)) {
      o.messages.warningLevel = 2;
    } else if ((m = tok.match(/^-WmsgS([deiw])((?:A?\d+)(?:,A?\d+)*)$/i))) {
      for (const c of m[2].split(',')) o.messages.overrides[c.toUpperCase().startsWith('A') ? c.toUpperCase() : 'A' + c] = SEV[m[1].toLowerCase()];
    } else if ((m = tok.match(/^-I(.+)$/i))) {
      o.includePaths.push(m[1]);
    } else if ((m = tok.match(/^-env(.+?)=(.*)$/i))) {
      o.env[m[1]] = m[2];
    } else if ((m = tok.match(/^-objn=?(.+)$/i))) {
      o.objectFile = m[1];
    } else if (/^-NoDebugInfo$/i.test(tok)) {
      o.noDebugInfo = true;
    } else if ((m = tok.match(/^-Prod=?(.*)$/i))) {
      o.prod = m[1];
    } else if (IGNORED.test(tok)) {
      // accepted, no effect on the generated files
    } else {
      o.unknown.push(tok);
      problems.push({ code: 'A9003', text: MESSAGES.A9003[1].replace('<Option>', tok), option: tok });
    }
  }
  if (o.format === 'FA2' || o.format === 'FA2o' || o.format === 'Fh') {
    // Absolute (-FA2) and HIWARE (-Fh) object output are not implemented; SECTION still gives A2341 under -FA2.
    const opt = '-F' + o.format.replace(/^F/, '');
    problems.push({ code: 'A9004', text: MESSAGES.A9004[1].replace('<Option>', opt), option: opt });
  }
  return { options: o, problems, files };
}

/** Merge an options object over defaults (for API callers passing objects instead of strings). */
export function resolveOptions(input: string | Partial<AsmOptions> | undefined): ParsedOptions {
  if (input === undefined) return { options: defaultOptions(), problems: [], files: [] };
  if (typeof input === 'string') return parseOptions(input);
  const o = { ...defaultOptions(), ...input };
  o.messages = { ...defaultOptions().messages, ...(input.messages ?? {}) };
  return { options: o, problems: [], files: [] };
}
