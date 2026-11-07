// Lexer/parser for hiwave (True-Time Simulator & Real-Time Debugger) command-language lines,
// as found in .cmd scripts, .hwl layouts and .xpr watch files. Spec: docs/research/r1/ide.md §6
// ("Command language"), docs/research/r2/critique.md G5.
//
// Line syntax: `[Component[:n] <] COMMAND args...  // comment`. Commands are case-insensitive.
// The parser is generic: it produces tokens; interpreting a command is the debugger's job.

export type HiwaveToken =
  | { type: 'ident'; text: string; value: string }
  | { type: 'number'; text: string; value: number; radix: 2 | 8 | 10 | 16 }
  /**
   * Quoted string. `value` has C escapes (\n \t \r \" \' \\) processed; unknown escapes such as `\c` are kept
   * verbatim so Windows paths survive. UNCERTAIN: hiwave escape rules; use `inner` (unprocessed) for paths.
   */
  | { type: 'string'; text: string; value: string; inner: string; quote: '"' | "'" }
  /** `&sym` (address of symbol); value is the symbol path, e.g. "main" or "fibo.c:main" */
  | { type: 'symref'; text: string; value: string }
  | { type: 'op'; text: string; value: string }
  /** `a..b`; built from two operand tokens around '..' */
  | { type: 'range'; text: string; from: HiwaveToken; to: HiwaveToken };

export interface HiwaveCommand {
  /** 1-based line number */
  line: number;
  /** component the command is sent to (`Data < ...`), as written, e.g. "Data" or "Data:1" */
  target?: string;
  /** command word as written */
  command: string;
  /** upper-cased command word */
  keyword: string;
  args: HiwaveToken[];
  /** raw argument text (after the command word, before any comment), trimmed */
  argText: string;
  /** trailing `//` comment text without the slashes */
  comment?: string;
  raw: string;
}

export interface HiwaveScriptLine {
  line: number;
  raw: string;
  kind: 'blank' | 'comment' | 'command' | 'error';
  command?: HiwaveCommand;
  comment?: string;
  error?: string;
}

export interface HiwaveScript {
  lines: HiwaveScriptLine[];
  commands: HiwaveCommand[];
  errors: { line: number; message: string }[];
  /** EOL detected in the input ('\r\n' if any CRLF is present) */
  eol: '\r\n' | '\n';
}

export class HiwaveSyntaxError extends Error {
  constructor(message: string, readonly column: number) {
    super(message);
  }
}

const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdChar = (c: string) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" };

/**
 * Index of a `//` comment start outside quotes, or -1.
 * Backslash escapes the next character inside a string; if that leaves a string unterminated (a Windows path
 * ending in `\`, e.g. `"C:\dir\"`), the line is re-scanned with backslash as an ordinary character.
 */
export function findCommentStart(s: string): number {
  const scan = (escapes: boolean): { pos: number; open: boolean } => {
    let q: string | null = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (escapes && c === '\\') i++;
        else if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === '/' && s[i + 1] === '/') return { pos: i, open: false };
    }
    return { pos: -1, open: q !== null };
  };
  const r = scan(true);
  return r.open ? scan(false).pos : r.pos;
}

export function parseHiwaveNumber(text: string): { value: number; radix: 2 | 8 | 10 | 16 } | undefined {
  let m: RegExpExecArray | null;
  if ((m = /^\$([0-9A-Fa-f]+)$/.exec(text))) return { value: parseInt(m[1], 16), radix: 16 };
  if ((m = /^0[xX]([0-9A-Fa-f]+)$/.exec(text))) return { value: parseInt(m[1], 16), radix: 16 };
  // UNCERTAIN: '%' binary prefix (assembler convention); hiwave docs only list $, 0x and leading-0 octal.
  if ((m = /^%([01]+)$/.exec(text))) return { value: parseInt(m[1], 2), radix: 2 };
  if ((m = /^0([0-7]+)$/.exec(text))) return { value: parseInt(m[1], 8), radix: 8 };
  if (/^[0-9]+$/.test(text)) return { value: parseInt(text, 10), radix: 10 };
  return undefined;
}

/**
 * Tokenize a command-line fragment (no comment). Throws HiwaveSyntaxError on unterminated strings.
 * Strings are first read with C escapes; if that leaves a string unterminated, the whole fragment is re-read with
 * backslash as an ordinary character, so `"C:\dir\"` is the path `C:\dir\` (its `value` then equals `inner`).
 * UNCERTAIN: hiwave's real escape rules.
 */
export function tokenizeHiwave(s: string): HiwaveToken[] {
  try {
    return tokenize(s, true);
  } catch (e) {
    if (!(e instanceof HiwaveSyntaxError) || !s.includes('\\')) throw e;
    return tokenize(s, false);
  }
}

function tokenize(s: string, escapes: boolean): HiwaveToken[] {
  const out: HiwaveToken[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    const start = i;
    if (c === '"' || c === "'") {
      let v = '';
      i++;
      for (;;) {
        if (i >= s.length) throw new HiwaveSyntaxError('unterminated string', start);
        const d = s[i];
        if (escapes && d === '\\' && i + 1 < s.length) {
          const e = s[i + 1];
          v += ESCAPES[e] ?? d + e;
          i += 2;
          continue;
        }
        if (d === c) {
          i++;
          break;
        }
        v += d;
        i++;
      }
      out.push({ type: 'string', text: s.slice(start, i), value: v, inner: s.slice(start + 1, i - 1), quote: c });
      continue;
    }
    if (c === '&' && i + 1 < s.length && (isIdStart(s[i + 1]) || s[i + 1] === '.')) {
      i++;
      // symbol path: identifiers joined by '.' or ':' (e.g. &fibo.c:main)
      while (i < s.length && (isIdChar(s[i]) || ((s[i] === '.' || s[i] === ':') && i + 1 < s.length && isIdChar(s[i + 1]) && s[i - 1] !== '.'))) i++;
      out.push({ type: 'symref', text: s.slice(start, i), value: s.slice(start + 1, i) });
      continue;
    }
    if (c === '$' || isDigit(c) || (c === '%' && /[01]/.test(s[i + 1] ?? ''))) {
      i++;
      while (i < s.length && /[0-9A-Za-z]/.test(s[i])) i++;
      const text = s.slice(start, i);
      const n = parseHiwaveNumber(text);
      if (n) out.push({ type: 'number', text, ...n });
      else out.push({ type: 'ident', text, value: text }); // e.g. "9MHz" — keep as a word
      continue;
    }
    if (isIdStart(c)) {
      i++;
      // allow '.' inside a word when followed by an identifier char (file.c, Sci0.SerialInput) but not '..'
      while (i < s.length && (isIdChar(s[i]) || (s[i] === '.' && i + 1 < s.length && isIdChar(s[i + 1])))) i++;
      const text = s.slice(start, i);
      out.push({ type: 'ident', text, value: text });
      continue;
    }
    const two = s.slice(i, i + 2);
    if (['..', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>'].includes(two)) {
      out.push({ type: 'op', text: two, value: two });
      i += 2;
      continue;
    }
    out.push({ type: 'op', text: c, value: c });
    i++;
  }
  return mergeRanges(out);
}

function mergeRanges(t: HiwaveToken[]): HiwaveToken[] {
  const out: HiwaveToken[] = [];
  const operand = (x: HiwaveToken | undefined) => !!x && (x.type === 'number' || x.type === 'ident' || x.type === 'symref');
  for (let i = 0; i < t.length; i++) {
    if (t[i].type === 'op' && t[i].text === '..' && operand(out[out.length - 1]) && operand(t[i + 1])) {
      const from = out.pop()!;
      const to = t[++i];
      out.push({ type: 'range', text: `${from.text}..${to.text}`, from, to });
    } else out.push(t[i]);
  }
  return out;
}

const TARGET_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*(?::\d+)?)\s*<(?![<=])/;

/** Parse one line. Returns null for blank/comment-only lines. Throws HiwaveSyntaxError on lexical errors. */
export function parseHiwaveLine(raw: string, line = 1): HiwaveCommand | null {
  const cpos = findCommentStart(raw);
  const body = cpos >= 0 ? raw.slice(0, cpos) : raw;
  const comment = cpos >= 0 ? raw.slice(cpos + 2) : undefined;
  let rest = body;
  let target: string | undefined;
  const m = TARGET_RE.exec(rest);
  if (m) {
    target = m[1];
    rest = rest.slice(m[0].length);
  }
  const cm = /^\s*([^\s]+)/.exec(rest);
  if (!cm) {
    if (target) throw new HiwaveSyntaxError(`missing command after '${target} <'`, raw.length);
    return null;
  }
  // command word: identifier (letters/digits/_) — anything else is tokenized normally
  const wm = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
  if (!wm) throw new HiwaveSyntaxError(`expected a command, found ${JSON.stringify(cm[1])}`, body.length - rest.length);
  const command = wm[1];
  const argSrc = rest.slice(wm[0].length);
  return {
    line,
    target,
    command,
    keyword: command.toUpperCase(),
    args: tokenizeHiwave(argSrc),
    argText: argSrc.trim(),
    comment,
    raw,
  };
}

/** Split text into lines, keeping track of the EOL style. */
export function splitLines(text: string): { lines: string[]; eol: '\r\n' | '\n'; finalNewline: boolean } {
  const eol = text.includes('\r\n') || !text.includes('\n') ? '\r\n' : '\n';
  const parts = text.split(/\r?\n/);
  const finalNewline = parts.length > 1 && parts[parts.length - 1] === '';
  if (finalNewline) parts.pop();
  return { lines: text === '' ? [] : parts, eol, finalNewline };
}

/** Parse a whole command script (.cmd/.hwl/.xpr). Lexical errors are collected, not thrown. */
export function parseHiwaveScript(text: string): HiwaveScript {
  const { lines, eol } = splitLines(text);
  const out: HiwaveScript = { lines: [], commands: [], errors: [], eol };
  lines.forEach((raw, i) => {
    const line = i + 1;
    try {
      const cmd = parseHiwaveLine(raw, line);
      if (cmd) {
        out.lines.push({ line, raw, kind: 'command', command: cmd });
        out.commands.push(cmd);
      } else {
        const c = findCommentStart(raw);
        out.lines.push(c >= 0 ? { line, raw, kind: 'comment', comment: raw.slice(c + 2) } : { line, raw, kind: 'blank' });
      }
    } catch (e) {
      const message = (e as Error).message;
      out.lines.push({ line, raw, kind: 'error', error: message });
      out.errors.push({ line, message });
    }
  });
  return out;
}

export interface HiwaveAttribute {
  name: string;
  /** remaining tokens of this comma-separated item */
  values: HiwaveToken[];
  /**
   * value text, e.g. "on", "0x4000", "-1", "". When `argText` is passed to parseAttributeList this is the exact
   * source text after the name (trimmed), so it round-trips; otherwise the value tokens joined with spaces.
   */
  value: string;
}

/** Split text at commas outside quotes (backslash-escape aware, with the same literal-backslash retry as strings). */
function splitTopLevelCommas(text: string): string[] | undefined {
  const scan = (escapes: boolean): string[] | undefined => {
    const parts: string[] = [];
    let q: string | null = null;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (escapes && c === '\\') i++;
        else if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === ',') {
        parts.push(text.slice(start, i));
        start = i + 1;
      }
    }
    if (q) return undefined;
    parts.push(text.slice(start));
    return parts;
  };
  return scan(true) ?? scan(false);
}

/**
 * Split `attributes K V,K V,...` argument tokens (after the ATTRIBUTES word) into items.
 * Pass the command's `argText` to get exact source text in `value` (needed for lossless re-writing, e.g. `FOO -1`).
 */
export function parseAttributeList(tokens: HiwaveToken[], argText?: string): HiwaveAttribute[] {
  const items: HiwaveToken[][] = [[]];
  for (const t of tokens) {
    if (t.type === 'op' && t.text === ',') items.push([]);
    else items[items.length - 1].push(t);
  }
  const raw = argText !== undefined ? splitTopLevelCommas(argText) : undefined;
  const useRaw = !!raw && raw.length === items.length;
  const out: HiwaveAttribute[] = [];
  items.forEach((item, idx) => {
    if (item.length === 0) return;
    const [n, ...vals] = item;
    let value = vals.map((v) => v.text).join(' ');
    if (useRaw) {
      const r = raw![idx].trim();
      if (r.startsWith(n.text)) value = r.slice(n.text.length).trim();
    }
    out.push({ name: n.text, values: vals, value });
  });
  return out;
}
