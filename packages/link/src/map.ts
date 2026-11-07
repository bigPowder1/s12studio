// SmartLinker V-5.0.40 `.map` writer. Layout derived from fixtures/Lab3/bin/Project.map and
// fixtures/blank_project/bin/Project.map (critique G3). CRLF line endings.
import { moduleDisplayName, sectionAccess, type Module, type OutSection } from './model';
import { byAddress, byModuleSection, type LinkObject } from './objects';
import { SMARTLINKER_PRODUCER } from './abs';
import { SHF_EXECINSTR, SHF_WRITE } from '@s12/formats';

export interface TreeGroup {
  /** root text: "main and _Startup Group" or an ORG section name ("_ORG00001") */
  title: string;
  /** pad the root text to 20 columns (ORG roots are padded, the group title is longer anyway) */
  pad?: boolean;
  children: LinkObject[];
}

export interface MapInput {
  outputPath: string;
  modules: Module[];
  entry?: { name: string; address: number };
  /** SECTION-ALLOCATION order (size > 0) */
  allocOrder: OutSection[];
  vectors: OutSection[];
  objects: LinkObject[];
  sectionUseOrder: string[];
  /** MODULE STATISTIC "other" Data column (the stack) */
  otherData: number;
  tree: TreeGroup[];
  blocks: number;
  blockBytes: number;
}

const STAR = '*'.repeat(93);
const DASH = '-'.repeat(93);
const hx = (v: number) => v.toString(16).toUpperCase();
/**
 * Word-list wrapping (SECTION USE, USES). A word moves to a new line when (line length so far + word length)
 * exceeds the limit. Limits fitted to every wrapped line of both golden maps:
 *   SECTION USE: 79 on every line;
 *   USES: 78 on the first line, 80 on continuation lines (i.e. 48 columns of content measured from column 30 on
 *   the first line and from column 32 on continuation lines).
 * UNCERTAIN: the continuation limit is only bracketed (80..89) by the samples.
 */
export const WRAP_SECTION_USE = { first: 79, cont: 79 } as const;
export const WRAP_USES = { first: 78, cont: 80 } as const;

export function wrapWords(words: readonly string[], first: string, cont: string, limit: { first: number; cont: number }): string[] {
  const out: string[] = [];
  let cur = first;
  let n = 0;
  for (const w of words) {
    if (n > 0 && cur.length + w.length > (out.length ? limit.cont : limit.first)) {
      out.push(cur);
      cur = cont;
      n = 0;
    }
    cur += `${w} `;
    n++;
  }
  out.push(cur);
  return out;
}

/** OBJECT-ALLOCATION / OBJECT LIST row. UNCERTAIN: the split of the 46-column Name+Addr field for long names. */
function objectRow(o: LinkObject): string {
  return `     ${o.name.padEnd(40)}${hx(o.address).padStart(6)}${hx(o.size).padStart(8)}${String(o.size).padStart(8)}${String(o.refs).padStart(8)}   ${o.mapSection.padEnd(12)}`;
}

/** DEPENDENCY TREE renderer (format reverse-engineered from the goldens; see map.test.ts). */
function renderTree(groups: readonly TreeGroup[]): string[] {
  const lines: string[] = [];
  const shown = new Set<LinkObject>();
  const node = (prefix: string, o: LinkObject, last: boolean) => {
    const seen = shown.has(o);
    lines.push(`${prefix}+- ${o.name.padEnd(20)}${seen ? ' (see above)' : ''}`);
    const cp = prefix + (last ? '   ' : '|  ');
    if (seen) {
      lines.push(cp);
      return;
    }
    shown.add(o);
    const kids = o.uses.filter((u) => u.kind === 'procedure');
    if (!kids.length) {
      lines.push(`${cp}  `);
      return;
    }
    lines.push(`${cp}| `);
    kids.forEach((k, i) => node(cp, k, i === kids.length - 1));
  };
  for (const g of groups) {
    lines.push(` ${g.pad ? g.title.padEnd(20) : g.title}`);
    // UNCERTAIN: rendering of a root without children (never observed).
    if (!g.children.length) continue;
    lines.push(' | ');
    g.children.forEach((c, i) => node(' ', c, i === g.children.length - 1));
  }
  return lines;
}

export function writeMap(m: MapInput): string {
  const L: string[] = ['', `PROGRAM "${m.outputPath}"`, ''];
  const head = (title: string, columns?: string) => {
    L.push(STAR, title);
    if (columns !== undefined) L.push(columns);
    L.push(DASH);
  };

  head('TARGET SECTION');
  L.push('Processor   : Freescale HC12', 'Memory Model: SMALL', 'File Format : ELF\\DWARF 2.0', `Linker      : ${SMARTLINKER_PRODUCER}`, '');

  head('FILE SECTION');
  for (const mod of m.modules) {
    const n = moduleDisplayName(mod);
    // UNCERTAIN: names of 40+ characters (a single space is inserted).
    L.push(`${n.length >= 40 ? `${n} ` : n.padEnd(40)}Model: SMALL,         Lang: Assembler`);
  }
  L.push('');

  head('STARTUP SECTION');
  // UNCERTAIN: text without an entry point.
  L.push(m.entry ? `Entry point: 0x${hx(m.entry.address)} (${m.entry.name})` : 'Entry point: none', '');

  head('SECTION-ALLOCATION SECTION', 'Section Name                    Size  Type     From       To       Segment');
  const totals = new Map<string, number>();
  for (const o of m.allocOrder) {
    const acc = sectionAccess(o);
    totals.set(acc, (totals.get(acc) ?? 0) + o.size);
    L.push(
      `${o.name.padEnd(30)}${String(o.size).padStart(6)}${acc.padStart(6)}${`0x${hx(o.address)}`.padStart(11)}${`0x${hx(o.address + o.size - 1)}`.padStart(11)}   ${o.segment}`,
    );
  }
  L.push('', 'Summary of section sizes per section type:');
  for (const [acc, label] of [
    ['R', 'READ_ONLY (R):'],
    ['R/W', 'READ_WRITE (R/W):'],
    ['N/I', 'NO_INIT (N/I):'],
  ] as const) {
    const t = totals.get(acc);
    if (t === undefined) continue;
    L.push(`${label}${hx(t).padStart(26 - label.length)} (dec: ${String(t).padStart(8)})`);
  }
  L.push('');

  head('VECTOR-ALLOCATION SECTION', '    Address     InitValue   InitFunction');
  // UNCERTAIN: row format (no golden contains a VECTOR command).
  for (const v of m.vectors) L.push(`${`0x${hx(v.address)}`.padStart(11)}${`0x${hx(v.vector!.value)}`.padStart(14)}   ${v.vector!.target ?? ''}`);
  L.push('');

  head('OBJECT-ALLOCATION SECTION', '     Name               Module                 Addr   hSize   dSize     Ref    Section   RLIB');
  for (const mod of m.modules) {
    L.push(`MODULE:                 -- ${moduleDisplayName(mod)} --`);
    const mine = byModuleSection(m.objects.filter((o) => o.mod === mod));
    L.push('- PROCEDURES:', ...mine.filter((o) => o.kind === 'procedure').map(objectRow));
    L.push('- VARIABLES:', ...mine.filter((o) => o.kind === 'variable').map(objectRow));
    const labels = mine.filter((o) => o.kind === 'label');
    if (labels.length) L.push('- LABELS:', ...labels.map(objectRow));
  }
  L.push('');

  head('MODULE STATISTIC', '  Name                                      Data   Code  Const');
  const stat = (name: string, d: number, c: number, k: number) =>
    `  ${name.padEnd(40)}${String(d).padStart(6)}${String(c).padStart(7)}${String(k).padStart(7)}`;
  for (const mod of m.modules) {
    let d = 0, c = 0, k = 0;
    for (const s of mod.secs.values()) {
      if (!s.kept || !s.out) continue;
      if (s.flags & SHF_WRITE) d += s.size;
      else if (s.flags & SHF_EXECINSTR) c += s.size;
      else k += s.size;
    }
    L.push(stat(moduleDisplayName(mod), d, c, k));
  }
  // UNCERTAIN: VECTOR entries are not counted in "other".
  L.push(stat('other', m.otherData, 0, 0), '');

  head('SECTION USE IN OBJECT-ALLOCATION SECTION');
  const sorted = byAddress(m.objects.filter((o) => o.kind !== 'label'));
  for (const name of m.sectionUseOrder) {
    const list = sorted.filter((o) => o.mapSection === name);
    if (!list.length) continue;
    L.push(`SECTION: "${name}"`, ...wrapWords(list.map((o) => o.name), '  ', '  ', WRAP_SECTION_USE));
  }
  L.push('');

  head('OBJECT LIST SORTED BY ADDRESS', '     Name                                      Addr   hSize   dSize     Ref    Section   RLIB');
  L.push(...sorted.map(objectRow), '');

  // UNCERTAIN: never populated in the samples (unreferenced sections of object files might be listed here).
  head('UNUSED-OBJECTS SECTION');
  L.push('');
  // Assembly sections are never copied down (no C startup); always empty in the samples.
  head('COPYDOWN SECTION');
  L.push('');

  head('OBJECT-DEPENDENCIES SECTION');
  for (const o of sorted) {
    // ORG data (VARnnnnn) is shown in the DEPENDENCY TREE instead.
    if (o.isOrgAbs || !o.uses.length) continue;
    // UNCERTAIN: names of 26+ characters.
    L.push(...wrapWords(o.uses.map((u) => u.name), `${o.name.padEnd(25)} USES `, ' '.repeat(32), WRAP_USES));
  }
  L.push('');

  L.push(STAR, 'DEPENDENCY TREE', STAR, ...renderTree(m.tree));

  head('STATISTIC SECTION');
  L.push(
    '',
    'ExeFile:',
    '--------',
    `Number of blocks to be downloaded: ${m.blocks}`,
    `Total size of all blocks to be downloaded: ${m.blockBytes}`,
    '',
  );
  return `${L.join('\r\n')}\r\n`;
}
