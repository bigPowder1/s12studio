// Order-, comment- and whitespace-preserving Windows INI document (hiwave <Connection>.ini, project.ini).
// Unmodified documents serialize byte-for-byte identical (per-line EOLs are kept, including mixed endings).
// Lookups are case-insensitive like GetPrivateProfileString; the first occurrence of a duplicate key wins.

export type IniLine =
  | { kind: 'blank'; raw: string; eol: string }
  | { kind: 'comment'; raw: string; eol: string }
  | { kind: 'section'; name: string; raw: string; eol: string }
  | { kind: 'entry'; key: string; value: string; raw: string; eol: string }
  /** a non-empty line that is neither a section, comment nor key=value; kept verbatim */
  | { kind: 'other'; raw: string; eol: string };

export interface IniSectionView {
  /** '' for lines before the first [section] */
  name: string;
  /** index of the [section] header in `lines` (-1 for the implicit global section) */
  headerIndex: number;
  /** index one past the last line of this section */
  endIndex: number;
}

const norm = (s: string) => s.trim().toLowerCase();

function classify(raw: string, eol: string): IniLine {
  const t = raw.trim();
  if (t === '') return { kind: 'blank', raw, eol };
  if (t.startsWith(';') || t.startsWith('#')) return { kind: 'comment', raw, eol };
  if (t.startsWith('[')) {
    const close = t.indexOf(']');
    if (close > 0) return { kind: 'section', name: t.slice(1, close).trim(), raw, eol };
  }
  const eq = raw.indexOf('=');
  if (eq > 0) return { kind: 'entry', key: raw.slice(0, eq).trim(), value: raw.slice(eq + 1).trim(), raw, eol };
  return { kind: 'other', raw, eol };
}

export class IniDocument {
  lines: IniLine[] = [];
  /** EOL used for newly created lines (detected from the input: CRLF if any CRLF is present) */
  eol: '\r\n' | '\n' = '\r\n';
  /** a leading UTF-8 BOM, preserved */
  bom = false;

  static parse(text: string): IniDocument {
    const doc = new IniDocument();
    if (text.startsWith('﻿')) {
      doc.bom = true;
      text = text.slice(1);
    }
    doc.eol = text.includes('\r\n') || !text.includes('\n') ? '\r\n' : '\n';
    let i = 0;
    while (i < text.length) {
      let j = text.indexOf('\n', i);
      let eol: string;
      let raw: string;
      if (j < 0) {
        raw = text.slice(i);
        eol = '';
        j = text.length;
      } else if (j > i && text[j - 1] === '\r') {
        raw = text.slice(i, j - 1);
        eol = '\r\n';
      } else {
        raw = text.slice(i, j);
        eol = '\n';
      }
      doc.lines.push(classify(raw, eol));
      i = j + 1;
    }
    return doc;
  }

  toString(): string {
    return (this.bom ? '﻿' : '') + this.lines.map((l) => l.raw + l.eol).join('');
  }

  /** Sections in document order (duplicates appear once per header). */
  sectionViews(): IniSectionView[] {
    const out: IniSectionView[] = [];
    let cur: IniSectionView = { name: '', headerIndex: -1, endIndex: 0 };
    this.lines.forEach((l, i) => {
      if (l.kind === 'section') {
        cur.endIndex = i;
        if (cur.headerIndex >= 0 || i > 0) out.push(cur);
        cur = { name: l.name, headerIndex: i, endIndex: i + 1 };
      }
    });
    cur.endIndex = this.lines.length;
    if (cur.headerIndex >= 0 || this.lines.length > 0) out.push(cur);
    return out;
  }

  /** Distinct section names in order of first appearance (excluding the implicit global section). */
  sections(): string[] {
    const out: string[] = [];
    for (const s of this.sectionViews()) {
      if (s.headerIndex < 0) continue;
      if (!out.some((n) => norm(n) === norm(s.name))) out.push(s.name);
    }
    return out;
  }

  hasSection(section: string): boolean {
    return this.sectionViews().some((s) => s.headerIndex >= 0 && norm(s.name) === norm(section));
  }

  private views(section: string): IniSectionView[] {
    return this.sectionViews().filter((s) => norm(s.name) === norm(section) && (section !== '' || s.headerIndex < 0));
  }

  private findEntries(section: string, key: string): number[] {
    const out: number[] = [];
    for (const v of this.views(section)) {
      for (let i = v.headerIndex + 1; i < v.endIndex; i++) {
        const l = this.lines[i];
        if (l.kind === 'entry' && norm(l.key) === norm(key)) out.push(i);
      }
    }
    return out;
  }

  get(section: string, key: string): string | undefined {
    const idx = this.findEntries(section, key);
    return idx.length ? (this.lines[idx[0]] as Extract<IniLine, { kind: 'entry' }>).value : undefined;
  }

  getAll(section: string, key: string): string[] {
    return this.findEntries(section, key).map((i) => (this.lines[i] as Extract<IniLine, { kind: 'entry' }>).value);
  }

  /** All key/value pairs of a section (all headers with that name), in order, duplicates included. */
  entries(section: string): [string, string][] {
    const out: [string, string][] = [];
    for (const v of this.views(section)) {
      for (let i = v.headerIndex + 1; i < v.endIndex; i++) {
        const l = this.lines[i];
        if (l.kind === 'entry') out.push([l.key, l.value]);
      }
    }
    return out;
  }

  /**
   * Set a value. Rewrites the first existing entry in place (`key=value`, keeping its original key spelling),
   * otherwise inserts after the section's last entry, otherwise appends a new section at the end.
   */
  set(section: string, key: string, value: string): void {
    const idx = this.findEntries(section, key);
    if (idx.length) {
      const l = this.lines[idx[0]] as Extract<IniLine, { kind: 'entry' }>;
      if (l.value === value) return;
      const eqPos = l.raw.indexOf('=');
      l.raw = l.raw.slice(0, eqPos + 1) + value;
      l.value = value;
      return;
    }
    const line: IniLine = { kind: 'entry', key, value, raw: `${key}=${value}`, eol: this.eol };
    const views = this.views(section);
    if (views.length) {
      const v = views[views.length - 1];
      // insert after the last non-blank line of the section, so trailing blank separators stay below
      let at = v.endIndex;
      while (at > v.headerIndex + 1 && this.lines[at - 1].kind === 'blank') at--;
      this.ensureEol(at - 1);
      this.lines.splice(at, 0, line);
      return;
    }
    if (section === '') {
      this.lines.unshift(line);
      return;
    }
    this.ensureEol(this.lines.length - 1);
    this.lines.push({ kind: 'section', name: section, raw: `[${section}]`, eol: this.eol }, line);
  }

  /** Delete all occurrences of a key. Returns the number removed. */
  delete(section: string, key: string): number {
    const idx = this.findEntries(section, key);
    for (let k = idx.length - 1; k >= 0; k--) this.lines.splice(idx[k], 1);
    return idx.length;
  }

  /** Delete every header (and body) of a section. Returns true if anything was removed. */
  deleteSection(section: string): boolean {
    const views = this.views(section).filter((v) => v.headerIndex >= 0);
    for (let k = views.length - 1; k >= 0; k--) this.lines.splice(views[k].headerIndex, views[k].endIndex - views[k].headerIndex);
    return views.length > 0;
  }

  private ensureEol(i: number) {
    if (i >= 0 && i < this.lines.length && this.lines[i].eol === '') this.lines[i].eol = this.eol;
  }
}

export function parseIni(text: string): IniDocument {
  return IniDocument.parse(text);
}
