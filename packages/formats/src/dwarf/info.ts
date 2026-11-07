// Generic DWARF 2 .debug_info reader (DIE trees).
import { ByteReader, readCString } from '../util/bytes';
import { parseAbbrevTable, type Abbrev, type AbbrevTable } from './abbrev';
import { DW_FORM } from './constants';

export type DwValue = number | string | boolean | Uint8Array;

export interface DieAttr {
  at: number;
  form: number;
  value: DwValue;
  /** Offset of the attribute's value within .debug_info. */
  offset: number;
}

export interface Die {
  /** Offset of the DIE within .debug_info. */
  offset: number;
  code: number;
  tag: number;
  attrs: DieAttr[];
  children: Die[];
}

export interface CompileUnitHeader {
  /** Offset of the CU header within .debug_info. */
  offset: number;
  unitLength: number;
  version: number;
  abbrevOffset: number;
  addressSize: number;
  /** Offset just past the unit (offset + 4 + unitLength). */
  end: number;
}

export interface CompileUnit extends CompileUnitHeader {
  abbrevs: AbbrevTable;
  die: Die;
}

export class DwarfError extends Error {}

export function parseCompileUnitHeader(info: Uint8Array, offset: number): CompileUnitHeader {
  const r = new ByteReader(info, offset);
  const unitLength = r.u32();
  if (unitLength >= 0xfffffff0) throw new DwarfError('64-bit DWARF not supported');
  const version = r.u16();
  const abbrevOffset = r.u32();
  const addressSize = r.u8();
  return { offset, unitLength, version, abbrevOffset, addressSize, end: offset + 4 + unitLength };
}

/** Read one attribute value of `form`. */
export function readForm(r: ByteReader, form: number, addressSize: number, cuOffset: number, strSection?: Uint8Array): DwValue {
  switch (form) {
    case DW_FORM.addr:
      return r.uN(addressSize);
    case DW_FORM.block1:
      return r.bytesN(r.u8());
    case DW_FORM.block2:
      return r.bytesN(r.u16());
    case DW_FORM.block4:
      return r.bytesN(r.u32());
    case DW_FORM.block:
      return r.bytesN(r.uleb128());
    case DW_FORM.data1:
      return r.u8();
    case DW_FORM.data2:
      return r.u16();
    case DW_FORM.data4:
      return r.u32();
    case DW_FORM.data8: {
      const hi = r.u32();
      const lo = r.u32();
      return hi * 0x100000000 + lo;
    }
    case DW_FORM.string:
      return r.cstr();
    case DW_FORM.strp: {
      const off = r.u32();
      return strSection ? readCString(strSection, off) : off;
    }
    case DW_FORM.flag:
      return r.u8() !== 0;
    case DW_FORM.sdata:
      return r.sleb128();
    case DW_FORM.udata:
      return r.uleb128();
    case DW_FORM.ref_addr:
      return r.u32();
    // CU-relative references are returned as CU-relative offsets (as stored).
    case DW_FORM.ref1:
      return r.u8();
    case DW_FORM.ref2:
      return r.u16();
    case DW_FORM.ref4:
      return r.u32();
    case DW_FORM.ref_udata:
      return r.uleb128();
    case DW_FORM.indirect:
      return readForm(r, r.uleb128(), addressSize, cuOffset, strSection);
    default:
      throw new DwarfError(`unsupported DW_FORM 0x${form.toString(16)} at 0x${r.pos.toString(16)}`);
  }
}

/** Parse every compile unit of a .debug_info section. */
export function parseDebugInfo(info: Uint8Array, abbrevSection: Uint8Array, strSection?: Uint8Array): CompileUnit[] {
  const units: CompileUnit[] = [];
  let off = 0;
  while (off + 11 <= info.length) {
    const cu = parseCompileUnit(info, abbrevSection, off, strSection);
    units.push(cu);
    off = cu.end;
  }
  return units;
}

/** Parse the compile unit at `offset`. */
export function parseCompileUnit(info: Uint8Array, abbrevSection: Uint8Array, offset: number, strSection?: Uint8Array): CompileUnit {
  const h = parseCompileUnitHeader(info, offset);
  if (h.version < 2 || h.version > 3) throw new DwarfError(`unsupported DWARF version ${h.version}`);
  const abbrevs = parseAbbrevTable(abbrevSection, h.abbrevOffset);
  const r = new ByteReader(info.subarray(0, h.end), offset + 11);

  const readDie = (): Die | null => {
    const dieOff = r.pos;
    const code = r.uleb128();
    if (code === 0) return null;
    const ab: Abbrev | undefined = abbrevs.byCode.get(code);
    if (!ab) throw new DwarfError(`unknown abbrev code ${code} at 0x${dieOff.toString(16)}`);
    const attrs: DieAttr[] = ab.attrs.map((a) => {
      const vo = r.pos;
      return { at: a.at, form: a.form, value: readForm(r, a.form, h.addressSize, offset, strSection), offset: vo };
    });
    const die: Die = { offset: dieOff, code, tag: ab.tag, attrs, children: [] };
    if (ab.hasChildren) {
      for (;;) {
        if (r.eof) break; // tolerate a missing terminator at end of unit
        const c = readDie();
        if (!c) break;
        die.children.push(c);
      }
    }
    return die;
  };
  const die = readDie();
  if (!die) throw new DwarfError(`empty compile unit at 0x${offset.toString(16)}`);
  return { ...h, abbrevs, die };
}

/** First attribute value with `at` (undefined if absent). */
export function dieAttr(die: Die, at: number): DwValue | undefined {
  return die.attrs.find((a) => a.at === at)?.value;
}

/** Depth-first walk over a DIE tree. */
export function* walkDies(die: Die, depth = 0): Generator<{ die: Die; depth: number }> {
  yield { die, depth };
  for (const c of die.children) yield* walkDies(c, depth + 1);
}
