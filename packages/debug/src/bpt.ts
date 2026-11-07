/**
 * hiwave breakpoint syntax: the BS command arguments and the `<app>.BPT` persistence file (ide.md §6):
 *
 *   BS addr|func [{mark}] [P|T[E|D]][;cond="expr" [E|D]][;cmd="command" [E|D] [C]][;cur=n inter=n][;cdSz=n srSz=n]
 *
 *   savebp on
 *   BS &fibo.c:main+21 P E; cond = "fiboCount==5" E; cmd = "Assembly < spc 0x800" E; cdSz = 42 srSz = 0
 *
 * A saved breakpoint is re-enabled on reload only if the function's code size (cdSz) is unchanged.
 * UNCERTAIN: the spelling of the command "Continue" flag in .BPT files (written here as a trailing `C`), and what srSz
 * measures (written as 0, ignored on reload).
 */
import { tokenizeHiwave, type HiwaveToken } from '@s12/formats';
import { parseExpr } from './expr';
import type { Breakpoint } from './target';
import type { DebugSymbols } from './symbols';
import { hex } from './format';

export interface BsArgs {
  /** Address expression text (`&main`, `0x4000`, `main+3`). */
  addressText: string;
  mark?: string;
  temporary?: boolean;
  enabled?: boolean;
  condition?: string;
  conditionEnabled?: boolean;
  command?: string;
  commandEnabled?: boolean;
  commandContinue?: boolean;
  counter?: { current: number; interval: number };
  codeSize?: number;
  sourceSize?: number;
}

/** Split at `;` outside quotes. */
export function splitTopLevel(text: string, sep = ';'): string[] {
  const out: string[] = [];
  let q: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === sep) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

const FLAG_RE = /^(P|T)?(E|D)?$/i;

export class BsSyntaxError extends Error {}

export function parseBsArgs(text: string): BsArgs {
  const segs = splitTopLevel(text);
  const first = segs[0];
  const { end } = parseExpr(first, 0);
  const out: BsArgs = { addressText: first.slice(0, end).trim() };
  let rest = first.slice(end).trim();
  const mark = /^\{([^}]*)\}/.exec(rest);
  if (mark) {
    out.mark = mark[1];
    rest = rest.slice(mark[0].length).trim();
  }
  for (const w of rest.split(/\s+/).filter(Boolean)) {
    const m = FLAG_RE.exec(w);
    if (!m || (!m[1] && !m[2])) throw new BsSyntaxError(`invalid breakpoint option '${w}'`);
    if (m[1]) out.temporary = m[1].toUpperCase() === 'T';
    if (m[2]) out.enabled = m[2].toUpperCase() === 'E';
  }
  for (const seg of segs.slice(1)) {
    if (!seg.trim()) continue;
    const toks = tokenizeHiwave(seg);
    let i = 0;
    while (i < toks.length) {
      const k = toks[i];
      if (k.type !== 'ident' || toks[i + 1]?.type !== 'op' || toks[i + 1].text !== '=') throw new BsSyntaxError(`invalid breakpoint field '${seg.trim()}'`);
      const key = k.text.toLowerCase();
      const v = toks[i + 2];
      if (!v) throw new BsSyntaxError(`missing value for ${k.text}`);
      i += 3;
      const flags: string[] = [];
      while (i < toks.length && toks[i].type === 'ident' && /^[EDC]$/i.test(toks[i].text) && toks[i + 1]?.text !== '=') flags.push(toks[i++].text.toUpperCase());
      const str = (t: HiwaveToken) => (t.type === 'string' ? t.value : t.text);
      const num = (t: HiwaveToken) => {
        if (t.type !== 'number') throw new BsSyntaxError(`${k.text} expects a number`);
        return t.value;
      };
      switch (key) {
        case 'cond':
          out.condition = str(v);
          if (flags.includes('D')) out.conditionEnabled = false;
          else out.conditionEnabled = true;
          break;
        case 'cmd':
          out.command = str(v);
          out.commandEnabled = !flags.includes('D');
          if (flags.includes('C')) out.commandContinue = true;
          break;
        case 'cur':
          out.counter = { current: num(v), interval: out.counter?.interval ?? num(v) };
          break;
        case 'inter':
          out.counter = { current: out.counter?.current ?? num(v), interval: num(v) };
          break;
        case 'cdsz':
          out.codeSize = num(v);
          break;
        case 'srsz':
          out.sourceSize = num(v);
          break;
        default:
          throw new BsSyntaxError(`unknown breakpoint field '${k.text}'`);
      }
    }
  }
  return out;
}

/** Address expression for a .BPT line: `&sym+off` when a code symbol covers the address, else hex. */
export function bptAddressText(address: number, symbols: DebugSymbols | null): string {
  const f = symbols?.symbolFor(address);
  if (f) return `&${f.symbol.name}${f.offset ? `+${f.offset}` : ''}`;
  return `0x${hex(address, address > 0xffff ? 6 : 4)}`;
}

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** One `BS ...` line in .BPT format. */
export function formatBsLine(bp: Breakpoint, symbols: DebugSymbols | null): string {
  let s = `BS ${bptAddressText(bp.address, symbols)} ${bp.temporary ? 'T' : 'P'} ${bp.enabled ? 'E' : 'D'}`;
  if (bp.condition) s += `; cond = ${q(bp.condition)} ${bp.conditionEnabled === false ? 'D' : 'E'}`;
  if (bp.command) s += `; cmd = ${q(bp.command)} ${bp.commandEnabled === false ? 'D' : 'E'}${bp.commandContinue ? ' C' : ''}`;
  if (bp.counter) s += `; cur = ${bp.counter.current} inter = ${bp.counter.interval}`;
  const f = symbols?.symbolFor(bp.address);
  s += `; cdSz = ${bp.codeSize ?? f?.symbol.size ?? 0} srSz = ${bp.sourceSize ?? 0}`;
  return s;
}

/** Whole .BPT file (CRLF). Temporary breakpoints are not saved. */
export function writeBpt(bps: readonly Breakpoint[], symbols: DebugSymbols | null, saveBp = true): string {
  const lines = [`savebp ${saveBp ? 'on' : 'off'}`];
  for (const bp of bps) if (!bp.temporary) lines.push(formatBsLine(bp, symbols));
  return lines.map((l) => l + '\r\n').join('');
}
