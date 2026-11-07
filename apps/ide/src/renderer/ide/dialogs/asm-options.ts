/**
 * Assembler for HC12 > "Options..." (the "HC12 Assembler Option Settings" dialog): checkboxes and radio groups that
 * edit the assembler's command-line option string in place. Unknown options are kept as they are, in order.
 * Option spellings follow packages/asm/src/options.ts (case-insensitive; Lab3 writes -CPUHCS12X).
 */

/** Split an option string into raw tokens (blanks separate; double-quoted parts stay inside their token). */
export function splitOptions(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (const ch of s) {
    if (ch === '"') inQ = !inQ;
    if (!inQ && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export const joinOptions = (tokens: string[]) => tokens.join(' ');

/**
 * Replace every token matching `match` with `token` (at the first match's position), or remove them all when
 * `token` is null. Appends when nothing matched.
 */
export function setOption(s: string, match: RegExp, token: string | null): string {
  const toks = splitOptions(s);
  const at = toks.findIndex((t) => match.test(t));
  const rest = toks.filter((t) => !match.test(t));
  if (token === null) return at < 0 ? s : joinOptions(rest);
  if (at < 0) return joinOptions([...toks, token]);
  rest.splice(at, 0, token); // `at` is the first match, so nothing before it was removed
  return joinOptions(rest);
}

export function findOption(s: string, match: RegExp): string | undefined {
  return splitOptions(s).find((t) => match.test(t));
}

// ------------------------------------------------------------------------------------------------ flag table

export interface FlagDef {
  /** The option as written ("-Li"). */
  flag: string;
  label: string;
  /** Matches the option's spellings. */
  match: RegExp;
}

export interface ChoiceDef {
  id: string;
  label: string;
  /** Matches any token of this group. */
  match: RegExp;
  choices: { token: string | null; label: string }[];
}

export interface OptionsPage {
  id: string;
  label: string;
  choices?: ChoiceDef[];
  flags?: FlagDef[];
}

const exact = (f: string) => new RegExp(`^${f}$`, 'i');

export const LISTING_MATCH = /^-L(=.*)?$/i;
/** Default listing destination: next to the source in the object/text path (as the ME305 projects use). */
export const DEFAULT_LISTING = '-L=%(TEXTPATH)\\%n.lst';

export const ASM_OPTION_PAGES: OptionsPage[] = [
  {
    id: 'output',
    label: 'Output',
    flags: [
      { flag: '-Lc', label: 'No macro call in listing file (-Lc)', match: exact('-Lc') },
      { flag: '-Ld', label: 'No macro definition in listing file (-Ld)', match: exact('-Ld') },
      { flag: '-Le', label: 'No macro expansion in listing file (-Le)', match: exact('-Le') },
      { flag: '-Li', label: 'Do not write included files in listing file (-Li)', match: exact('-Li') },
      { flag: '-NoDebugInfo', label: 'No debug information for ELF/DWARF files (-NoDebugInfo)', match: exact('-NoDebugInfo') },
    ],
  },
  {
    id: 'language',
    label: 'Language',
    flags: [
      { flag: '-Ci', label: 'Switch case sensitivity on label names OFF (-Ci)', match: exact('-Ci') },
      { flag: '-MCUasm', label: 'Switch on compatibility with MCUasm (-MCUasm)', match: exact('-MCUasm') },
      { flag: '-Compat', label: 'Compatibility modes (-Compat)', match: /^-Compat(=.*)?$/i },
    ],
  },
  {
    id: 'codegen',
    label: 'Code Generation',
    choices: [
      {
        id: 'cpu',
        label: 'Derivative family',
        match: /^-Cpu(CPU12|HC12|HCS12|HCS12X|HCS12XE)$/i,
        choices: [
          { token: null, label: 'HC12 (default)' },
          { token: '-CPUHCS12', label: 'HCS12 (-CpuHCS12)' },
          { token: '-CPUHCS12X', label: 'HCS12X (-CpuHCS12X)' },
        ],
      },
      {
        id: 'model',
        label: 'Memory model',
        match: /^-M[sbl]$/i,
        choices: [
          { token: null, label: 'Default' },
          { token: '-Ms', label: 'Small (-Ms)' },
          { token: '-Mb', label: 'Banked (-Mb)' },
          { token: '-Ml', label: 'Large (-Ml)' },
        ],
      },
    ],
  },
  {
    id: 'messages',
    label: 'Messages',
    choices: [
      {
        id: 'warn',
        label: 'Message level',
        match: /^-W[12]$/i,
        choices: [
          { token: null, label: 'Show all messages' },
          { token: '-W1', label: 'Do not print INFORMATION messages (-W1)' },
          { token: '-W2', label: 'Do not print INFORMATION or WARNING messages (-W2)' },
        ],
      },
    ],
  },
];

/** Current choice token of a radio group (null = default / none), normalised to the table's spelling. */
export function choiceValue(s: string, c: ChoiceDef): string | null {
  const t = findOption(s, c.match);
  if (!t) return null;
  return c.choices.find((x) => x.token && x.token.toLowerCase() === t.toLowerCase())?.token ?? t;
}

export const flagOn = (s: string, f: FlagDef) => !!findOption(s, f.match);

export const setFlag = (s: string, f: FlagDef, on: boolean) => setOption(s, f.match, on ? f.flag : null);

export const setChoice = (s: string, c: ChoiceDef, token: string | null) => setOption(s, c.match, token);

/** -L state: null = no listing, otherwise the -L token's destination ('' for plain -L). */
export function listingValue(s: string): string | null {
  const t = findOption(s, LISTING_MATCH);
  if (t === undefined) return null;
  return t.length > 2 ? t.slice(3) : '';
}

export function setListing(s: string, dest: string | null): string {
  return setOption(s, LISTING_MATCH, dest === null ? null : dest ? `-L=${dest}` : '-L');
}

/** -D defines as "NAME[=value]" strings. */
export function definesValue(s: string): string[] {
  return splitOptions(s)
    .filter((t) => /^-D[A-Za-z_.]/.test(t))
    .map((t) => t.slice(2));
}

export function setDefines(s: string, defs: string[]): string {
  const toks = splitOptions(s);
  const at = toks.findIndex((t) => /^-D[A-Za-z_.]/.test(t));
  const rest = toks.filter((t) => !/^-D[A-Za-z_.]/.test(t));
  const add = defs.map((d) => d.trim()).filter(Boolean).map((d) => `-D${d}`);
  if (at < 0) return joinOptions([...rest, ...add]);
  rest.splice(at, 0, ...add);
  return joinOptions(rest);
}

/** Tokens no checkbox/radio of the dialog covers ("Other options"). */
export function otherOptions(s: string): string[] {
  const known: RegExp[] = [LISTING_MATCH, /^-D[A-Za-z_.]/];
  for (const p of ASM_OPTION_PAGES) {
    for (const f of p.flags ?? []) known.push(f.match);
    for (const c of p.choices ?? []) known.push(c.match);
  }
  return splitOptions(s).filter((t) => !known.some((m) => m.test(t)));
}
