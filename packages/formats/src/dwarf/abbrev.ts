import { ByteReader, ByteWriter } from '../util/bytes';

export interface AbbrevAttr {
  at: number;
  form: number;
}

export interface Abbrev {
  code: number;
  tag: number;
  hasChildren: boolean;
  attrs: AbbrevAttr[];
}

export interface AbbrevTable {
  /** Abbreviations in table (file) order. */
  list: Abbrev[];
  byCode: Map<number, Abbrev>;
  /** Byte length of the table including its terminating 0. */
  length: number;
}

/** Parse one abbreviation table starting at `offset` (terminated by code 0). */
export function parseAbbrevTable(data: Uint8Array, offset = 0): AbbrevTable {
  const r = new ByteReader(data, offset);
  const list: Abbrev[] = [];
  const byCode = new Map<number, Abbrev>();
  for (;;) {
    const code = r.uleb128();
    if (code === 0) break;
    const tag = r.uleb128();
    const hasChildren = r.u8() !== 0;
    const attrs: AbbrevAttr[] = [];
    for (;;) {
      const at = r.uleb128();
      const form = r.uleb128();
      if (at === 0 && form === 0) break;
      attrs.push({ at, form });
    }
    const a = { code, tag, hasChildren, attrs };
    list.push(a);
    byCode.set(code, a);
  }
  return { list, byCode, length: r.pos - offset };
}

export function encodeAbbrevTable(list: readonly Abbrev[]): Uint8Array {
  const w = new ByteWriter(128);
  for (const a of list) {
    w.uleb128(a.code).uleb128(a.tag).u8(a.hasChildren ? 1 : 0);
    for (const at of a.attrs) w.uleb128(at.at).uleb128(at.form);
    w.u8(0).u8(0);
  }
  w.u8(0);
  return w.finish();
}
