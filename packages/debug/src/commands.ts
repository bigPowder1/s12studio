/**
 * hiwave command-language interpreter (Command component, .cmd hook files, .hwl layouts, .xpr and .BPT files).
 * Spec: docs/research/r1/ide.md §6 "Command language", docs/research/r2/critique.md G5.
 *
 * Lines are split by the @s12/formats hiwave-cmd parser (`[Component[:n] <] COMMAND args // comment`, case-
 * insensitive); arguments are parsed here with the expression language of expr.ts. Window/layout commands are
 * forwarded to a UiHandler (headless: ignored). Output lines carry a kind for the Command window colours
 * (echo = blue, normal = black, error = red, warning = green FCS messages).
 */
import { parseHiwaveLine, tokenizeHiwave, writeSRecords, HiwaveSyntaxError, type HiwaveCommand, type HiwaveToken } from '@s12/formats';
import { decode, formatLine } from '@s12/isa';
import { REGIONS, WINDOWS } from '@s12/devices';
import { BsSyntaxError, parseBsArgs, splitTopLevel } from './bpt';
import { evaluateAsync, ExprError, parseExpr, type AsyncExprEnv, type Expr } from './expr';
import { cFormat, formatDump, formatRegisters, formatValue, hex, type ValueFormat } from './format';
import { joinPath, readText, resolvePathCI, type DebugFileSystem } from './fs';
import type { DebugSymbols } from './symbols';
import {
  canonicalRegister,
  haltStatusText,
  MEM_UNMAPPED,
  type Breakpoint,
  type IdentValue,
  type RegisterName,
  type StepKind,
  type Target,
} from './target';

export type OutputKind = 'echo' | 'normal' | 'error' | 'warning';

export interface OutputLine {
  text: string;
  kind: OutputKind;
}

/** A window/layout command for the UI (OPEN, ACTIVATE, ATTRIBUTES, SPC...). */
export interface UiCommand {
  /** `Comp` of `Comp < cmd`, if given. */
  component?: string;
  keyword: string;
  args: HiwaveToken[];
  argText: string;
  raw: string;
}

export interface UiHandler {
  /** Window/layout commands. Headless sessions ignore them. */
  command?(cmd: UiCommand): void | Promise<void>;
  /** DEFINEVALUEDLG: ask the user for a value. undefined = keep the default. */
  defineValueDialog?(title: string, variable: string, defaultValue: number, text: string): Promise<number | undefined> | number | undefined;
  /** CLR: clear the Command window. */
  clear?(): void;
}

/** Session services the interpreter needs. */
export interface CommandHost {
  readonly target: Target;
  readonly symbols: DebugSymbols | null;
  readonly fs: DebugFileSystem;
  /** Directory relative command-file paths resolve against (the project directory). */
  readonly baseDir: string;
  /** LOAD [file] [options...] */
  load?(file: string | undefined, options: string[]): Promise<void>;
  /** SREC file [offset] */
  loadSrec?(file: string, offset: number): Promise<void>;
  /** RESET (target reset + RESET command file). */
  reset?(): Promise<void>;
  /** CMDFILE kind ON|OFF "file" */
  setCommandFile?(kind: string, enabled: boolean, file: string): void;
  /** ADDXPR */
  addExpression?(expression: string, onlyIfNew: boolean, component: string): void;
  /** SAVEBP on|off */
  setSaveBp?(on: boolean): void;
}

export interface InterpreterOptions {
  ui?: UiHandler;
  /** WAIT time multiplier (1 = real time, 0 = do not sleep). Default 1. */
  waitScale?: number;
  /** Echo the commands of command files (default true). */
  echoScripts?: boolean;
  /** Dash between bytes 7 and 8 in DB output (default false). */
  dumpDash?: boolean;
  /** Default E output format (default 'hex'). UNCERTAIN: hiwave's default. */
  evalFormat?: ValueFormat;
  /**
   * Meaning of `G addr`: 'start' (default; set PC, then run, as the debugger manual describes GO [address]) or
   * 'until' (temporary breakpoint). UNCERTAIN.
   */
  goAddress?: 'start' | 'until';
  /** Stop a command file at the first failing command (default true). */
  stopOnError?: boolean;
  /** Safety limit on executed command-file lines (default 1 000 000). */
  maxScriptSteps?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class CommandError extends Error {}

/** Usage strings (HELP, `cmd?`). */
export const COMMAND_HELP: Readonly<Record<string, string>> = {
  BS: 'BS address|function [{mark}] [P|T[E|D]] [;cond="expr" [E|D]] [;cmd="command" [E|D] [C]] [;cur=n inter=n]',
  BC: 'BC address|*',
  BD: 'BD : display breakpoints',
  G: 'G [address] : start execution',
  GO: 'GO [address] : start execution',
  S: 'S : stop execution',
  STOP: 'STOP : stop execution',
  T: 'T [address][,count] : trace instructions',
  P: 'P [address] : step over (BSR/JSR/CALL/SWI)',
  STEPINTO: 'STEPINTO : source step into',
  STEPOVER: 'STEPOVER : source step over',
  STEPOUT: 'STEPOUT : source step out',
  RESTART: 'RESTART : reset and run',
  RESET: 'RESET : reset the target',
  RD: 'RD [register list|CPU|*] : display registers',
  RS: 'RS register[=]value{,register[=]value} : set registers',
  DB: 'DB [address|range] : display bytes',
  DW: 'DW [address|range] : display words',
  DL: 'DL [address|range] : display longs',
  WB: 'WB address|range list : write bytes',
  MS: 'MS address|range list : write bytes',
  WW: 'WW address|range list : write words',
  WL: 'WL address|range list : write longs',
  FILL: 'FILL range value',
  MEM: 'MEM : memory map',
  DASM: 'DASM [address|range][;OBJ] : disassemble',
  LOAD: 'LOAD [file] [CODEONLY|SYMBOLSONLY] [NOBPT] [NOXPR] [NOPRELOADCMD] [NOPOSTLOADCMD]',
  SREC: 'SREC file [offset] : load S-records',
  SAVE: 'SAVE range file [;A] : save memory as S-records',
  E: 'E expression [;O|D|X|C|B] : evaluate ($A is the hex number 0xA here; in BS conditions $A is register A)',
  SPC: 'SPC address : show address in Source/Assembly',
  SMEM: 'SMEM range : show memory range',
  WAIT: 'WAIT [time in 0.1 s] [;s]',
  CF: 'CF file : execute command file',
  CALL: 'CALL file [;C] [;NL] : execute command file',
  CMDFILE: 'CMDFILE STARTUP|RESET|PRELOAD|POSTLOAD|SETCPU ON|OFF "file"',
  DEFINE: 'DEFINE name [=] expression',
  UNDEF: 'UNDEF name|*',
  A: 'A name = expression : assign',
  IF: 'IF condition ... [ELSEIF condition ...] [ELSE ...] ENDIF',
  FOR: 'FOR name = from..to [,step] ... ENDFOR',
  WHILE: 'WHILE condition ... ENDWHILE',
  REPEAT: 'REPEAT ... UNTIL condition',
  GOTO: 'GOTO label',
  GOTOIF: 'GOTOIF condition label',
  PRINTF: 'PRINTF("format", args...)',
  DEFINEVALUEDLG: 'DEFINEVALUEDLG "title" "name" default "text"',
  ADDXPR: 'ADDXPR [ONLY_ADD_IF_NEW] "expression"',
  SAVEBP: 'SAVEBP on|off',
  VER: 'VER : version',
  HELP: 'HELP : list commands',
  CLR: 'CLR : clear the command window',
};

const UI_COMMANDS = new Set([
  'OPEN',
  'ACTIVATE',
  'SLAY',
  'CLOSE',
  'ATTRIBUTES',
  'FONT',
  'BCKCOLOR',
  'AUTOSIZE',
  'SPC',
  'SMEM',
  'SMOD',
  'SPROC',
  'FOCUS',
  'ENDFOCUS',
  'ZOOM',
  'UPDATERATE',
  'FOLD',
  'UNFOLD',
  'FRAMES',
  'PTRARRAY',
  'LS',
  'TUPDATE',
  'SLINE',
  'FINDPROC',
  'FIND',
  'EXIT',
  'DDEPROTOCOL',
  'SET',
  'EXECUTE',
  'CLOCK',
  'COPYMEM',
  'DUMP',
  'RECORD',
  'NB',
  'MESSAGE_HIDE_ID',
  'MESSAGE_HIDE_RES',
  'WARNING_SETUP',
  'PROTOCOL',
]);

/** Accepted and ignored (logging, test-tool commands). */
const IGNORED = new Set(['LF', 'NOLF', 'LOG', 'CR', 'NOCR', 'PAUSETEST', 'TESTBOX', 'FLASH', 'CHIPSECURE', 'DBG', 'MCUID']);

const FLOW = new Set(['IF', 'ELSEIF', 'ELSE', 'ENDIF', 'WHILE', 'ENDWHILE', 'REPEAT', 'UNTIL', 'FOR', 'ENDFOR', 'GOTO', 'GOTOIF']);

interface ScriptLine {
  line: number;
  raw: string;
  cmd?: HiwaveCommand;
  label?: string;
  error?: string;
}

interface ScriptContext {
  name: string;
  baseDir: string;
  /** Echo the commands (default: InterpreterOptions.echoScripts). */
  echo?: boolean;
}

export interface ScriptResult {
  ok: boolean;
  errors: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CommandInterpreter {
  /** DEFINE variables (keys upper-case). */
  readonly defines = new Map<string, number>();
  private listeners = new Set<(l: OutputLine) => void>();
  private opts: Required<Omit<InterpreterOptions, 'ui'>> & { ui?: UiHandler };
  private lastDump: { address: number; unit: 1 | 2 | 4 } | null = null;
  private lastDasm: number | null = null;
  private focus: string | undefined;
  private cwd: string | undefined;
  private callDepth = 0;

  constructor(
    readonly host: CommandHost,
    opts: InterpreterOptions = {},
  ) {
    this.opts = {
      ui: opts.ui,
      waitScale: opts.waitScale ?? 1,
      echoScripts: opts.echoScripts ?? true,
      dumpDash: opts.dumpDash ?? false,
      evalFormat: opts.evalFormat ?? 'hex',
      goAddress: opts.goAddress ?? 'start',
      stopOnError: opts.stopOnError ?? true,
      maxScriptSteps: opts.maxScriptSteps ?? 1_000_000,
      sleep: opts.sleep ?? defaultSleep,
    };
  }

  get ui(): UiHandler | undefined {
    return this.opts.ui;
  }
  set ui(u: UiHandler | undefined) {
    this.opts.ui = u;
  }
  set waitScale(s: number) {
    this.opts.waitScale = s;
  }

  onOutput(fn: (l: OutputLine) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  print(text: string, kind: OutputKind = 'normal'): void {
    for (const t of text.split(/\r?\n/)) for (const l of [...this.listeners]) l({ text: t, kind });
  }

  private get target(): Target {
    return this.host.target;
  }

  private get baseDir(): string {
    return this.cwd ?? this.host.baseDir;
  }

  // ------------------------------------------------------------------------------------------ expressions

  /** Name lookup: DEFINE variables, symbols (exact case), registers, symbols (any case). */
  lookupIdent(name: string): IdentValue | undefined {
    const d = this.defines.get(name.toUpperCase());
    if (d !== undefined) return { kind: 'const', value: d };
    const syms = this.host.symbols;
    const exact = syms?.identValue(name, { caseInsensitive: false });
    if (exact) return exact;
    const r = canonicalRegister(name);
    if (r) return { kind: 'register', name: r };
    return syms?.identValue(name, { caseInsensitive: true });
  }

  exprEnv(): AsyncExprEnv {
    let regs: Promise<Record<RegisterName, number>> | null = null;
    return {
      lookup: (n) => this.lookupIdent(n),
      readMemory: async (address, size) => {
        const b = await this.target.readMemory(address, size);
        let v = 0;
        for (let i = 0; i < size; i++) v = v * 256 + b.bytes[i];
        return v;
      },
      readRegister: async (name) => {
        regs ??= this.target.readRegisters() as Promise<Record<RegisterName, number>>;
        return (await regs)[name];
      },
    };
  }

  /** Evaluate a full expression string. */
  async evaluate(text: string, opts: { address?: boolean; condition?: boolean } = {}): Promise<number> {
    return evaluateAsync(text.trim(), this.exprEnv(), { addressContext: opts.address, dollarRegisters: opts.condition });
  }

  private async evalAst(ast: Expr, address = false): Promise<number> {
    return evaluateAsync(ast, this.exprEnv(), { addressContext: address });
  }

  /** Parse+evaluate an expression at `pos` of `text`. */
  private async exprAt(text: string, pos: number, address = false): Promise<{ value: number; end: number }> {
    const { ast, end } = parseExpr(text, pos);
    return { value: await this.evalAst(ast, address), end };
  }

  /**
   * Address or range argument: `a`, `a..b` (inclusive), `a,size`. Returns the start, an optional byte length,
   * and the offset after the argument.
   */
  private async rangeAt(text: string, pos: number): Promise<{ start: number; length?: number; end: number }> {
    const a = await this.exprAt(text, pos, true);
    let i = skipWs(text, a.end);
    if (text.startsWith('..', i)) {
      const b = await this.exprAt(text, i + 2, true);
      if (b.value < a.value) throw new CommandError('Invalid range');
      return { start: a.value, length: b.value - a.value + 1, end: b.end };
    }
    if (text[i] === ',') {
      const n = await this.exprAt(text, i + 1);
      return { start: a.value, length: n.value, end: n.end };
    }
    return { start: a.value, end: a.end };
  }

  // ------------------------------------------------------------------------------------------ entry points

  /**
   * Execute one interactive command line (Command window). Echoes it (unless `echo: false`), prints errors.
   * Returns true on success.
   */
  async execute(line: string, opts: { echo?: boolean } = {}): Promise<boolean> {
    if (opts.echo !== false && line.trim()) this.print(line, 'echo');
    let cmd: HiwaveCommand | null;
    try {
      cmd = parseHiwaveLine(line);
    } catch (e) {
      this.print(`Syntax error: ${(e as Error).message}`, 'error');
      return false;
    }
    if (!cmd) return true;
    if (FLOW.has(cmd.keyword)) {
      this.print(`${cmd.keyword} is only allowed in command files`, 'error');
      return false;
    }
    return this.run(cmd, { name: '', baseDir: this.baseDir });
  }

  /** Execute command-file text. */
  async executeScript(text: string, ctx: { name?: string; baseDir?: string; echo?: boolean } = {}): Promise<ScriptResult> {
    const sc: ScriptContext = { name: ctx.name ?? '', baseDir: ctx.baseDir ?? this.baseDir, echo: ctx.echo };
    const lines = this.parseScript(text);
    return this.runScript(lines, sc);
  }

  /** Execute a command file (path relative to the project directory, case-insensitive). */
  async executeFile(path: string): Promise<ScriptResult> {
    const resolved = await resolvePathCI(this.host.fs, this.baseDir, path);
    if (!resolved) {
      this.print(`Could not open command file ${path}`, 'error');
      return { ok: false, errors: 1 };
    }
    const text = await readText(this.host.fs, resolved);
    return this.executeScript(text, { name: resolved, baseDir: this.baseDir });
  }

  private parseScript(text: string): ScriptLine[] {
    const out: ScriptLine[] = [];
    text.split(/\r?\n/).forEach((raw, i) => {
      const line = i + 1;
      try {
        const cmd = parseHiwaveLine(raw, line);
        if (!cmd) return;
        if (!cmd.target && cmd.args.length === 1 && cmd.args[0].type === 'op' && cmd.args[0].text === ':') out.push({ line, raw, label: cmd.command.toUpperCase() });
        else out.push({ line, raw, cmd });
      } catch (e) {
        out.push({ line, raw, error: e instanceof HiwaveSyntaxError ? e.message : String(e) });
      }
    });
    return out;
  }

  private async runScript(lines: ScriptLine[], sc: ScriptContext): Promise<ScriptResult> {
    if (this.callDepth > 32) {
      this.print('Command files nested too deeply', 'error');
      return { ok: false, errors: 1 };
    }
    this.callDepth++;
    let errors = 0;
    try {
      const { match, errors: blockErrors } = matchBlocks(lines);
      if (blockErrors.length) {
        // unmatched IF/WHILE/REPEAT/FOR blocks: refuse to run (a missing ENDIF would otherwise run a false branch)
        for (const b of blockErrors) this.print(`${sc.name ? `${sc.name}(${lines[b.index].line}): ` : ''}${b.message}`, 'error');
        return { ok: false, errors: blockErrors.length };
      }
      const labels = new Map<string, number>();
      lines.forEach((l, i) => l.label && labels.set(l.label, i));
      const forState = new Map<number, { end: number; step: number; name: string }>();
      let pc = 0;
      let steps = 0;
      const fail = (l: ScriptLine, msg: string): boolean => {
        errors++;
        this.print(`${sc.name ? `${sc.name}(${l.line}): ` : ''}${msg}`, 'error');
        return this.opts.stopOnError;
      };
      while (pc < lines.length) {
        if (++steps > this.opts.maxScriptSteps) {
          fail(lines[pc], 'Command file aborted: too many steps (endless loop?)');
          break;
        }
        const l = lines[pc];
        if (l.error) {
          if (fail(l, `Syntax error: ${l.error}`)) break;
          pc++;
          continue;
        }
        if (l.label || !l.cmd) {
          pc++;
          continue;
        }
        const cmd = l.cmd;
        const kw = cmd.keyword;
        if (FLOW.has(kw) && !cmd.target) {
          try {
            const m = match.get(pc);
            switch (kw) {
              case 'IF': {
                if (await this.cond(cmd.argText)) pc++;
                else pc = await this.nextBranch(lines, match, pc);
                break;
              }
              case 'ELSEIF':
              case 'ELSE':
                // reached sequentially: the previous branch ran; leave the IF
                pc = (m?.end ?? pc) + 1;
                break;
              case 'ENDIF':
              case 'REPEAT':
                pc++;
                break;
              case 'WHILE':
                if (await this.cond(cmd.argText)) pc++;
                else pc = (m?.end ?? pc) + 1;
                break;
              case 'ENDWHILE':
                pc = m?.start ?? pc + 1;
                break;
              case 'UNTIL':
                if (await this.cond(cmd.argText)) pc++;
                else pc = (m?.start ?? pc) + 1;
                break;
              case 'FOR': {
                const f = await this.parseFor(cmd.argText);
                this.defines.set(f.name, f.from);
                forState.set(pc, { end: f.to, step: f.step, name: f.name });
                const inRange = f.step >= 0 ? f.from <= f.to : f.from >= f.to;
                pc = inRange ? pc + 1 : (m?.end ?? pc) + 1;
                break;
              }
              case 'ENDFOR': {
                const start = m?.start;
                const st = start !== undefined ? forState.get(start) : undefined;
                if (start === undefined || !st) throw new CommandError('ENDFOR without FOR');
                const v = (this.defines.get(st.name) ?? 0) + st.step;
                this.defines.set(st.name, v);
                pc = (st.step >= 0 ? v <= st.end : v >= st.end) ? start + 1 : pc + 1;
                break;
              }
              case 'GOTO':
              case 'GOTOIF': {
                let labelText = cmd.argText.trim();
                if (kw === 'GOTOIF') {
                  const { ast, end } = parseExpr(cmd.argText, 0);
                  labelText = cmd.argText.slice(end).trim();
                  if (!(await this.evalAst(ast))) {
                    pc++;
                    break;
                  }
                }
                const target = labels.get(labelText.toUpperCase());
                if (target === undefined) throw new CommandError(`Label ${labelText} not found`);
                pc = target + 1;
                break;
              }
            }
          } catch (e) {
            if (fail(l, errText(e))) break;
            pc++;
          }
          continue;
        }
        if (sc.echo ?? this.opts.echoScripts) this.print(l.raw.trim(), 'echo');
        const ok = await this.run(cmd, sc, l);
        if (!ok) {
          errors++;
          if (this.opts.stopOnError) break;
        }
        pc++;
      }
    } finally {
      this.callDepth--;
    }
    return { ok: errors === 0, errors };
  }

  /** From a failed IF/ELSEIF at `pc`, find the branch to run. */
  private async nextBranch(lines: ScriptLine[], match: Map<number, BlockMatch>, pc: number): Promise<number> {
    const m = match.get(pc);
    const branches = m?.branches ?? [];
    for (const b of branches) {
      const c = lines[b].cmd!;
      if (c.keyword === 'ELSE') return b + 1;
      if (c.keyword === 'ELSEIF' && (await this.cond(c.argText))) return b + 1;
    }
    return (m?.end ?? pc) + 1;
  }

  private async cond(text: string): Promise<boolean> {
    if (!text.trim()) throw new CommandError('condition expected');
    return (await this.evaluate(text)) !== 0;
  }

  private async parseFor(text: string): Promise<{ name: string; from: number; to: number; step: number }> {
    const m = /^\s*([A-Za-z_]\w*)\s*=\s*/.exec(text);
    if (!m) throw new CommandError('FOR: syntax is FOR name = from..to [,step]');
    const name = m[1].toUpperCase();
    const a = await this.exprAt(text, m[0].length);
    let i = skipWs(text, a.end);
    let to: number;
    if (text.startsWith('..', i)) {
      const b = await this.exprAt(text, i + 2);
      to = b.value;
      i = skipWs(text, b.end);
    } else {
      const tm = /^TO\b/i.exec(text.slice(i));
      if (!tm) throw new CommandError('FOR: range expected');
      const b = await this.exprAt(text, i + 2);
      to = b.value;
      i = skipWs(text, b.end);
    }
    let step = 1;
    if (text[i] === ',') step = (await this.exprAt(text, i + 1)).value;
    else if (/^STEP\b/i.test(text.slice(i))) step = (await this.exprAt(text, i + 4)).value;
    if (step === 0) throw new CommandError('FOR: step must not be 0');
    return { name, from: a.value, to, step };
  }

  /** Run one (non flow-control) command; prints errors. */
  private async run(cmd: HiwaveCommand, sc: ScriptContext, line?: ScriptLine): Promise<boolean> {
    try {
      if (cmd.argText === '?' && COMMAND_HELP[cmd.keyword]) {
        this.print(COMMAND_HELP[cmd.keyword]);
        return true;
      }
      await this.dispatch(cmd, sc);
      return true;
    } catch (e) {
      const where = line && sc.name ? `${sc.name}(${line.line}): ` : '';
      this.print(`${where}${errText(e)}`, 'error');
      return false;
    }
  }

  // ------------------------------------------------------------------------------------------ commands

  private async dispatch(cmd: HiwaveCommand, sc: ScriptContext): Promise<void> {
    const kw = cmd.keyword;
    const t = cmd.argText;
    const component = cmd.target ?? this.focus;
    switch (kw) {
      case 'BS':
        return this.cmdBs(t);
      case 'BC':
        return this.cmdBc(t);
      case 'BD':
      case 'BL':
        return this.cmdBd();
      case 'G':
      case 'GO':
        return this.cmdGo(t);
      case 'S':
      case 'STOP':
      case 'HALT':
        await this.target.halt();
        return;
      case 'T':
        return this.cmdTrace(t, 'instr');
      case 'P':
        return this.cmdTrace(t, 'over');
      case 'STEPINTO':
        await this.target.step('srcLine');
        return;
      case 'STEPOVER':
        await this.target.step('srcOver');
        return;
      case 'STEPOUT':
        await this.target.step('srcOut');
        return;
      case 'RESTART':
        await this.doReset();
        await this.target.go();
        this.print('STARTED');
        this.print('RUNNING');
        return;
      case 'RESET':
        return this.doReset();
      case 'RD':
        return this.cmdRd(t);
      case 'RS':
        return this.cmdRs(t);
      case 'DB':
        return this.cmdDump(t, 1);
      case 'DW':
        return this.cmdDump(t, 2);
      case 'DL':
        return this.cmdDump(t, 4);
      case 'WB':
      case 'MS':
        return this.cmdWrite(t, 1);
      case 'WW':
        return this.cmdWrite(t, 2);
      case 'WL':
        return this.cmdWrite(t, 4);
      case 'FILL':
        return this.cmdFill(t);
      case 'MEM':
        return this.cmdMem();
      case 'DASM':
        return this.cmdDasm(t);
      case 'LOAD':
      case 'LOADCODE':
      case 'LOADSYMBOLS':
        return this.cmdLoad(t, kw);
      case 'SREC':
        return this.cmdSrec(t);
      case 'SAVE':
        return this.cmdSave(t);
      case 'E':
        return this.cmdEval(t);
      case 'WAIT':
        return this.cmdWait(t);
      case 'CF':
      case 'CALL':
        return this.cmdCall(t);
      case 'CMDFILE':
        return this.cmdCmdFile(cmd);
      case 'DEFINE':
        return this.cmdDefine(t);
      case 'UNDEF':
        return this.cmdUndef(t);
      case 'A':
        return this.cmdAssign(t);
      case 'PRINTF':
        return this.cmdPrintf(t);
      case 'DEFINEVALUEDLG':
        return this.cmdDefineValueDlg(cmd);
      case 'ADDXPR':
        return this.cmdAddXpr(cmd, component);
      case 'SAVEBP': {
        const v = t.trim().toLowerCase();
        if (v !== 'on' && v !== 'off') throw new CommandError('SAVEBP on|off');
        this.host.setSaveBp?.(v === 'on');
        return;
      }
      case 'CD': {
        const p = unquote(t.trim());
        if (!p) this.print(this.baseDir);
        else this.cwd = joinPath(this.baseDir, p);
        return;
      }
      case 'VER':
        this.print('S12 Studio debugger engine V-0.1 (hiwave command language)');
        this.print(`Target: ${this.target.kind}`);
        return;
      case 'HELP':
        for (const [k, v] of Object.entries(COMMAND_HELP)) if (k === v.split(' ')[0]) this.print(v);
        return;
      case 'CLR':
        this.opts.ui?.clear?.();
        return;
    }
    if (kw === 'FOCUS') this.focus = t.trim() ? unquote(t.trim()) : undefined;
    if (kw === 'ENDFOCUS') this.focus = undefined;
    if (UI_COMMANDS.has(kw)) {
      await this.opts.ui?.command?.({ component, keyword: kw, args: cmd.args, argText: t, raw: cmd.raw });
      return;
    }
    if (IGNORED.has(kw)) return;
    // UNCERTAIN: hiwave's exact message for unknown commands
    throw new CommandError(`Unknown command: ${cmd.command}`);
  }

  private async doReset(): Promise<void> {
    if (this.host.reset) await this.host.reset();
    else await this.target.reset();
  }

  // --- breakpoints

  private async cmdBs(text: string): Promise<void> {
    if (!text.trim()) return this.cmdBd();
    let a;
    try {
      a = parseBsArgs(text);
    } catch (e) {
      if (e instanceof BsSyntaxError || e instanceof ExprError) throw new CommandError(`BS: ${e.message}`);
      throw e;
    }
    const address = await this.evaluate(a.addressText, { address: true });
    const syms = this.host.symbols;
    const f = syms?.symbolFor(address);
    let enabled = a.enabled ?? true;
    if (a.codeSize !== undefined && f && f.symbol.size && a.codeSize !== f.symbol.size) {
      enabled = false;
      this.print(`Breakpoint at ${a.addressText} disabled: code size changed`, 'warning');
    }
    const bp = await this.target.addBreakpoint({
      address,
      temporary: a.temporary ?? false,
      enabled,
      condition: a.condition,
      conditionEnabled: a.conditionEnabled,
      command: a.command,
      commandEnabled: a.commandEnabled,
      commandContinue: a.commandContinue,
      counter: a.counter,
      label: a.addressText,
      codeSize: a.codeSize ?? (f?.symbol.size || undefined),
      sourceSize: a.sourceSize,
    });
    this.print(this.describeBp(bp));
  }

  /** `main 0x4000 T` (hiwave post-load output style). */
  describeBp(bp: Breakpoint): string {
    const name = this.host.symbols?.formatAddress(bp.address);
    let s = `${name ? name + ' ' : ''}0x${hex(bp.address, 4)} ${bp.temporary ? 'T' : 'P'}`;
    if (!bp.enabled) s += ' D';
    if (bp.condition) s += ` cond="${bp.condition}"`;
    if (bp.counter) s += ` cur=${bp.counter.current} inter=${bp.counter.interval}`;
    if (bp.command) s += ` cmd="${bp.command}"`;
    return s;
  }

  private async cmdBc(text: string): Promise<void> {
    const t = text.trim();
    if (t === '*' || /^all$/i.test(t)) {
      await this.target.clearBreakpoints();
      return;
    }
    if (!t) throw new CommandError('BC: address or * expected');
    const address = await this.evaluate(t, { address: true });
    const hits = this.target.breakpoints().filter((b) => b.address === address || (b.address & 0xffff) === address);
    if (!hits.length) throw new CommandError(`No breakpoint at 0x${hex(address, 4)}`);
    for (const b of hits) await this.target.removeBreakpoint(b.id);
  }

  private cmdBd(): void {
    const bps = this.target.breakpoints();
    if (!bps.length) {
      this.print('No breakpoints');
      return;
    }
    for (const b of bps) this.print(this.describeBp(b));
  }

  // --- execution

  private async cmdGo(text: string): Promise<void> {
    // UNCERTAIN: hiwave's text; G while running (e.g. during a long step) would otherwise be silently ignored
    if (this.target.state === 'running') throw new CommandError('Target is already running');
    const t = text.trim();
    if (t) {
      const a = await this.evaluate(t, { address: true });
      if (this.opts.goAddress === 'until') await this.target.go({ until: a });
      else await this.target.go({ from: a });
    } else await this.target.go();
    this.print('STARTED');
    this.print('RUNNING');
  }

  private async cmdTrace(text: string, kind: StepKind): Promise<void> {
    let count = 1;
    const t = text.trim();
    if (t) {
      let pos = 0;
      if (t[0] !== ',') {
        const a = await this.exprAt(t, 0, true);
        await this.target.writeRegister('PC', a.value);
        pos = skipWs(t, a.end);
      }
      if (t[pos] === ',') {
        const n = await this.exprAt(t, pos + 1);
        count = n.value;
        pos = skipWs(t, n.end);
      }
      if (pos < t.length) throw new CommandError(`unexpected '${t.slice(pos)}'`);
      if (count < 1 || count > 65535) throw new CommandError('count must be 1..65535');
    }
    for (let i = 0; i < count; i++) {
      const h = await this.target.step(kind);
      await this.printTrace();
      if (h.reason !== 'step') {
        this.print(haltStatusText(h));
        break;
      }
    }
  }

  private async printTrace(): Promise<void> {
    const r = await this.target.readRegisters();
    for (const l of formatRegisters(r)) this.print(l);
    this.print(await this.disasmLine(r.PC, true));
  }

  private async disasmLine(pc: number, code: boolean): Promise<string> {
    const b = await this.target.readMemory(pc, 8);
    const insn = decode((a) => b.bytes[(a - pc) & 0xffff] ?? 0xff, pc, { symbols: (a) => this.host.symbols?.labelAt(a) });
    const label = this.host.symbols?.labelAt(pc);
    return (label ? `${label}:\n` : '') + formatLine(insn, { showCode: code, codeWidth: 10 });
  }

  // --- registers

  private async cmdRd(text: string): Promise<void> {
    const t = text.trim();
    const r = await this.target.readRegisters();
    if (!t || t === '*' || /^cpu$/i.test(t)) {
      for (const l of formatRegisters(r)) this.print(l);
      return;
    }
    const parts: string[] = [];
    for (const n of t.split(/[\s,]+/).filter(Boolean)) {
      const reg = canonicalRegister(n);
      if (!reg) throw new CommandError(`Unknown register ${n}`);
      const width = ['A', 'B', 'CCR', 'IPL', 'PPAGE', 'RPAGE', 'EPAGE', 'GPAGE', 'DIRECT'].includes(reg) ? 2 : 4;
      parts.push(`${n.toUpperCase()}=${hex(r[reg], width)}`);
    }
    this.print(parts.join('  '));
  }

  private async cmdRs(text: string): Promise<void> {
    const items = splitTopLevel(text, ',').map((s) => s.trim()).filter(Boolean);
    if (!items.length) throw new CommandError('RS register[=]value');
    for (const it of items) {
      const m = /^([A-Za-z]+)\s*=?\s*(.+)$/.exec(it);
      const reg = m && canonicalRegister(m[1]);
      if (!m || !reg) throw new CommandError(`RS: invalid register assignment '${it}'`);
      const v = await this.evaluate(m[2]);
      await this.target.writeRegister(reg, v);
    }
  }

  // --- memory

  private async cmdDump(text: string, unit: 1 | 2 | 4): Promise<void> {
    const t = text.trim();
    let start: number;
    let length = 16;
    if (t) {
      const r = await this.rangeAt(t, 0);
      if (skipWs(t, r.end) < t.length) throw new CommandError(`unexpected '${t.slice(r.end).trim()}'`);
      start = r.start;
      if (r.length !== undefined) length = r.length;
    } else start = this.lastDump ? this.lastDump.address : 0;
    if (length < 1 || length > 0x10000) throw new CommandError('Invalid range');
    length = Math.ceil(length / unit) * unit;
    const block = await this.target.readMemory(start, length);
    for (const l of formatDump(block, { unit, dash: this.opts.dumpDash })) this.print(l);
    this.lastDump = { address: start + length, unit };
  }

  /** Values for WB/WW/WL: expressions separated by blanks or commas. */
  private async valueList(text: string, pos: number): Promise<number[]> {
    const vals: number[] = [];
    let i = skipWs(text, pos);
    while (i < text.length) {
      if (text[i] === ',') {
        i = skipWs(text, i + 1);
        continue;
      }
      const v = await this.exprAt(text, i);
      vals.push(v.value);
      i = skipWs(text, v.end);
    }
    return vals;
  }

  private async cmdWrite(text: string, unit: 1 | 2 | 4): Promise<void> {
    const t = text.trim();
    if (!t) throw new CommandError(COMMAND_HELP[unit === 1 ? 'WB' : unit === 2 ? 'WW' : 'WL']);
    const r = await this.rangeAt(t, 0);
    const vals = await this.valueList(t, r.end);
    if (!vals.length) throw new CommandError('value list expected');
    const items = r.length !== undefined ? Math.max(1, Math.floor(r.length / unit)) : vals.length;
    const bytes: number[] = [];
    for (let i = 0; i < items; i++) bytes.push(...toBytes(vals[i % vals.length], unit));
    await this.target.writeMemory(r.start, bytes);
  }

  private async cmdFill(text: string): Promise<void> {
    const t = text.trim();
    const r = await this.rangeAt(t, 0);
    if (r.length === undefined) throw new CommandError('FILL range value');
    const vals = await this.valueList(t, r.end);
    if (vals.length !== 1) throw new CommandError('FILL range value');
    await this.target.writeMemory(r.start, new Array(r.length).fill(vals[0] & 0xff));
  }

  private cmdMem(): void {
    this.print('Local memory map (MC9S12XDP512, single chip):');
    for (const w of WINDOWS) {
      const page = w.pageRegister ? `paged by ${w.pageRegister}` : w.fixedPage !== undefined ? `page 0x${hex(w.fixedPage, 2)}` : '';
      this.print(`  0x${hex(w.localStart, 4)}-0x${hex(w.localEnd, 4)}  ${w.name.padEnd(20)} ${page}`.trimEnd());
    }
    this.print('Global memory:');
    for (const g of REGIONS) this.print(`  0x${hex(g.globalStart, 6)}-0x${hex(g.globalEnd, 6)}  ${g.name.padEnd(10)} ${g.size / 1024} KB`);
  }

  private async cmdDasm(text: string): Promise<void> {
    const parts = splitTopLevel(text);
    const t = parts[0].trim();
    const obj = parts.slice(1).some((p) => /^\s*obj\s*$/i.test(p));
    let start: number;
    let end: number | undefined;
    if (t) {
      const r = await this.rangeAt(t, 0);
      start = r.start;
      if (r.length !== undefined) end = r.start + r.length;
    } else start = this.lastDasm ?? (await this.target.readRegisters()).PC;
    let pc = start;
    const maxLines = end === undefined ? 16 : 4096;
    for (let n = 0; n < maxLines && (end === undefined || pc < end); n++) {
      const b = await this.target.readMemory(pc, 8);
      if (b.status[0] === MEM_UNMAPPED) {
        this.print(`${hex(pc, 4)} --`);
        pc++;
        continue;
      }
      const insn = decode((a) => b.bytes[(a - pc) & 0xffff] ?? 0xff, pc, { symbols: (a) => this.host.symbols?.labelAt(a) });
      const label = this.host.symbols?.labelAt(pc);
      if (label) this.print(`${label}:`);
      this.print(formatLine(insn, { showCode: obj, codeWidth: 10 }));
      pc = (pc + insn.length) & 0xffff;
    }
    this.lastDasm = pc;
  }

  // --- files

  /** First argument as a file name (quoted, or up to the first blank); returns it and the rest. */
  private fileArg(text: string): { file?: string; rest: string } {
    const t = text.trim();
    if (!t) return { rest: '' };
    if (t[0] === '"' || t[0] === "'") {
      const e = t.indexOf(t[0], 1);
      if (e < 0) throw new CommandError('unterminated file name');
      return { file: t.slice(1, e), rest: t.slice(e + 1).trim() };
    }
    const m = /^\S+/.exec(t)!;
    return { file: m[0], rest: t.slice(m[0].length).trim() };
  }

  private async cmdLoad(text: string, kw: string): Promise<void> {
    if (!this.host.load) throw new CommandError('LOAD is not available');
    const { file, rest } = this.fileArg(text);
    const isOption = (f?: string) => !!f && LOAD_OPTION.test(f);
    const opts = rest ? rest.split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/).filter(Boolean) : [];
    let f = file;
    if (isOption(file)) {
      opts.unshift(file!);
      f = undefined;
    }
    if (kw === 'LOADCODE') opts.push('CODEONLY');
    if (kw === 'LOADSYMBOLS') opts.push('SYMBOLSONLY');
    await this.host.load(f, opts.map((o) => o.toUpperCase().startsWith('RUNANDSTOPAFTERLOAD') ? o : o.toUpperCase()));
  }

  private async cmdSrec(text: string): Promise<void> {
    if (!this.host.loadSrec) throw new CommandError('SREC is not available');
    const { file, rest } = this.fileArg(text);
    if (!file) throw new CommandError(COMMAND_HELP.SREC);
    const offset = rest ? await this.evaluate(rest) : 0;
    await this.host.loadSrec(file, offset);
  }

  private async cmdSave(text: string): Promise<void> {
    const parts = splitTopLevel(text);
    const append = parts.slice(1).some((p) => /^\s*a\s*$/i.test(p));
    const t = parts[0].trim();
    const r = await this.rangeAt(t, 0);
    if (r.length === undefined) throw new CommandError(COMMAND_HELP.SAVE);
    const { file } = this.fileArg(t.slice(r.end));
    if (!file) throw new CommandError(COMMAND_HELP.SAVE);
    const block = await this.target.readMemory(r.start, r.length);
    const srec = writeSRecords([{ address: r.start, data: block.bytes }], { recordType: 'auto', bytesPerRecord: 32 });
    const path = joinPath(this.baseDir, file);
    let prev = '';
    if (append && (await this.host.fs.exists(path))) prev = await readText(this.host.fs, path);
    await this.host.fs.writeFile(path, prev + srec);
  }

  private async cmdCall(text: string): Promise<void> {
    const parts = splitTopLevel(text);
    const { file } = this.fileArg(parts[0]);
    if (!file) throw new CommandError(COMMAND_HELP.CF);
    const r = await this.executeFile(file);
    if (!r.ok) throw new CommandError(`Command file ${file} failed`);
  }

  private cmdCmdFile(cmd: HiwaveCommand): void {
    // CMDFILE <kind> ON|OFF "file"
    const a = cmd.args;
    const kind = a[0]?.type === 'ident' ? a[0].text.toUpperCase() : undefined;
    const on = a[1]?.type === 'ident' ? a[1].text.toUpperCase() : undefined;
    const fileTok = a[2];
    if (!kind || (on !== 'ON' && on !== 'OFF') || !fileTok) throw new CommandError(COMMAND_HELP.CMDFILE);
    const file = fileTok.type === 'string' ? fileTok.inner : fileTok.text;
    this.host.setCommandFile?.(kind, on === 'ON', file);
  }

  // --- evaluation, variables

  private async cmdEval(text: string): Promise<void> {
    const parts = splitTopLevel(text);
    if (!parts[0].trim()) throw new CommandError(COMMAND_HELP.E);
    const v = await this.evaluate(parts[0]);
    const f = (parts[1] ?? '').trim().toUpperCase();
    const fmt: ValueFormat = f === 'O' ? 'oct' : f === 'D' ? 'dec' : f === 'X' ? 'hex' : f === 'C' ? 'char' : f === 'B' ? 'bin' : this.opts.evalFormat;
    this.print(formatValue(v, fmt));
  }

  private async cmdDefine(text: string): Promise<void> {
    const m = /^\s*([A-Za-z_]\w*)\s*(?:=\s*)?(.*)$/.exec(text);
    if (!m) throw new CommandError(COMMAND_HELP.DEFINE);
    const value = m[2].trim() ? await this.evaluate(m[2]) : 0;
    this.defines.set(m[1].toUpperCase(), value);
  }

  private cmdUndef(text: string): void {
    const n = text.trim();
    if (n === '*') this.defines.clear();
    else if (!this.defines.delete(n.toUpperCase())) throw new CommandError(`${n} is not defined`);
  }

  private async cmdAssign(text: string): Promise<void> {
    const m = /^\s*([A-Za-z_][\w.:]*)\s*=\s*(.+)$/.exec(text);
    if (!m) throw new CommandError(COMMAND_HELP.A);
    const v = await this.evaluate(m[2]);
    const key = m[1].toUpperCase();
    if (this.defines.has(key)) {
      this.defines.set(key, v);
      return;
    }
    const id = this.lookupIdent(m[1]);
    if (id?.kind === 'var') await this.target.writeMemory(id.address, toBytes(v, id.size as 1 | 2 | 4));
    else if (id?.kind === 'register') await this.target.writeRegister(id.name, v);
    else this.defines.set(key, v);
  }

  private async cmdPrintf(text: string): Promise<void> {
    let t = text.trim();
    if (t.startsWith('(') && t.endsWith(')')) t = t.slice(1, -1);
    const parts = splitTopLevel(t, ',').map((s) => s.trim());
    const fmtTok = tokenizeHiwave(parts[0] ?? '');
    if (fmtTok.length !== 1 || fmtTok[0].type !== 'string') throw new CommandError(COMMAND_HELP.PRINTF);
    const args: (number | string)[] = [];
    for (const p of parts.slice(1)) {
      const tk = /^["']/.test(p) ? tokenizeHiwave(p) : [];
      if (tk.length === 1 && tk[0].type === 'string') args.push(tk[0].value);
      else args.push(await this.evaluate(p));
    }
    this.print(cFormat(fmtTok[0].value, args));
  }

  private async cmdDefineValueDlg(cmd: HiwaveCommand): Promise<void> {
    const a = cmd.args;
    const str = (t?: HiwaveToken) => (t?.type === 'string' ? t.value : t?.text);
    const title = str(a[0]) ?? '';
    const name = str(a[1]);
    if (!name || !a[2]) throw new CommandError(COMMAND_HELP.DEFINEVALUEDLG);
    // default value: tokens between the variable name and the trailing text string
    const last = a[a.length - 1];
    const defToks = a.slice(2, last.type === 'string' && a.length > 3 ? -1 : undefined);
    const def = await this.evaluate(defToks.map((x) => x.text).join(' '));
    const text = last.type === 'string' && a.length > 3 ? last.value : '';
    const answer = await this.opts.ui?.defineValueDialog?.(title, name, def, text);
    this.defines.set(name.toUpperCase(), answer ?? def);
  }

  private cmdAddXpr(cmd: HiwaveCommand, component: string | undefined): void {
    let args = cmd.args;
    let onlyIfNew = false;
    if (args[0]?.type === 'ident' && args[0].text.toUpperCase() === 'ONLY_ADD_IF_NEW') {
      onlyIfNew = true;
      args = args.slice(1);
    }
    const e = args[0];
    const expr = e?.type === 'string' ? e.value : cmd.argText.replace(/^ONLY_ADD_IF_NEW\s*/i, '').trim();
    if (!expr) throw new CommandError(COMMAND_HELP.ADDXPR);
    this.host.addExpression?.(expr, onlyIfNew, component ?? 'Data');
  }

  private async cmdWait(text: string): Promise<void> {
    const parts = splitTopLevel(text);
    const t = parts[0].trim();
    const untilHalt = parts.slice(1).some((p) => /^\s*s\s*$/i.test(p));
    const tenths = t ? await this.evaluate(t) : untilHalt ? undefined : 50; // UNCERTAIN: default 5 s
    if (untilHalt) {
      if (this.target.state === 'running') {
        try {
          await this.target.waitForHalt(tenths === undefined ? undefined : tenths * 100 * Math.max(this.opts.waitScale, 0.001));
        } catch {
          // timeout: continue the script
        }
      }
      return;
    }
    const ms = (tenths ?? 0) * 100 * this.opts.waitScale;
    if (ms > 0) await this.opts.sleep(ms);
  }
}

// ---------------------------------------------------------------------------------------------- helpers

interface BlockMatch {
  start: number;
  end: number;
  /** IF chains: ELSEIF/ELSE line indices. */
  branches?: number[];
}

/**
 * Match IF/ELSEIF/ELSE/ENDIF, WHILE/ENDWHILE, REPEAT/UNTIL, FOR/ENDFOR. Keys: every participating line. Unclosed
 * blocks, closers without an opener (or closing a different block) and ELSE/ELSEIF outside an IF are errors.
 * UNCERTAIN: hiwave's message texts.
 */
function matchBlocks(lines: ScriptLine[]): { match: Map<number, BlockMatch>; errors: { index: number; message: string }[] } {
  const out = new Map<number, BlockMatch>();
  const errors: { index: number; message: string }[] = [];
  const stack: { kw: string; start: number; branches: number[]; sawElse: boolean }[] = [];
  const OPEN: Record<string, string> = { IF: 'ENDIF', WHILE: 'ENDWHILE', REPEAT: 'UNTIL', FOR: 'ENDFOR' };
  const CLOSE: Record<string, string> = { ENDIF: 'IF', ENDWHILE: 'WHILE', UNTIL: 'REPEAT', ENDFOR: 'FOR' };
  lines.forEach((l, i) => {
    const c = l.cmd;
    if (!c || c.target) return;
    const kw = c.keyword;
    if (OPEN[kw]) stack.push({ kw, start: i, branches: [], sawElse: false });
    else if (kw === 'ELSEIF' || kw === 'ELSE') {
      const top = stack[stack.length - 1];
      if (top?.kw !== 'IF') errors.push({ index: i, message: `${kw} without IF` });
      else if (top.sawElse) errors.push({ index: i, message: `${kw} after ELSE` });
      else {
        top.branches.push(i);
        if (kw === 'ELSE') top.sawElse = true;
      }
    } else if (CLOSE[kw]) {
      const top = stack[stack.length - 1];
      if (top && OPEN[top.kw] === kw) {
        stack.pop();
        const m: BlockMatch = { start: top.start, end: i, branches: top.branches };
        out.set(top.start, m);
        out.set(i, m);
        for (const b of top.branches) out.set(b, m);
      } else errors.push({ index: i, message: top ? `${kw} found, ${OPEN[top.kw]} expected` : `${kw} without ${CLOSE[kw]}` });
    }
  });
  for (const b of stack) errors.push({ index: b.start, message: `${b.kw} without ${OPEN[b.kw]}` });
  errors.sort((a, b) => a.index - b.index);
  return { match: out, errors };
}

/** LOAD options (any case); anything else in first position is the file name. */
const LOAD_OPTION =
  /^(AUTOERASEANDFLASH|NORUNAFTERLOAD|RUNAFTERLOAD|RUNANDSTOPAFTERLOAD(=.*)?|CODEONLY|SYMBOLSONLY|NOBPT|NOXPR|NOPRELOADCMD|NOPOSTLOADCMD|VERIFY\w*|DELAY(=.*)?)$/i;

function skipWs(s: string, i: number): number {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}

function unquote(s: string): string {
  return /^(["']).*\1$/.test(s) ? s.slice(1, -1) : s;
}

function toBytes(v: number, unit: 1 | 2 | 4): number[] {
  const out: number[] = [];
  for (let i = unit - 1; i >= 0; i--) out.push(Math.floor((v >>> 0) / 2 ** (8 * i)) & 0xff);
  return out;
}

function errText(e: unknown): string {
  if (e instanceof ExprError) return `Error: ${e.message}`;
  if (e instanceof CommandError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

