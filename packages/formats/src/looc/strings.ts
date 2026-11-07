// looc string tables: per namespace an 'mstr' pool, 'mstl' index (12-byte entries) and 'msti' info.
// 'mstn' (hash buckets, hash function unknown) is ignored. Spec: mcp-format.md §1.3, §5.1.
import { chunkReader, cstr, findChunk, type LoocFile } from './container';

export interface LoocStringTable {
  ns: number;
  /** live entry count from msti[0] */
  count: number;
  /** capacity from msti[1] */
  capacity: number;
  /** raw msti words (count, capacity, usedBytes, poolCap, lastId, ...) */
  info: number[];
  strings: Map<number, string>;
}

/** Read the string table of one namespace (0 = pref names, 0x3E8 = atoms). Returns undefined if absent. */
export function readStringTable(f: LoocFile, ns: number, warnings: string[] = []): LoocStringTable | undefined {
  const mstr = findChunk(f, 'mstr', ns);
  const mstl = findChunk(f, 'mstl', ns);
  const msti = findChunk(f, 'msti', ns);
  if (!mstr || !mstl) return undefined;
  const info: number[] = [];
  if (msti) {
    const r = chunkReader(f, msti);
    for (let o = 0; o + 4 <= msti.size; o += 4) info.push(r.u32(o));
  }
  const maxEntries = Math.floor(mstl.size / 12);
  let count = info.length > 0 ? info[0] : maxEntries;
  if (count > maxEntries) {
    warnings.push(`string table ns=0x${ns.toString(16)}: msti count ${count} exceeds index capacity ${maxEntries}`);
    count = maxEntries;
  }
  const strings = new Map<number, string>();
  const lr = chunkReader(f, mstl);
  for (let i = 0; i < count; i++) {
    const strOff = lr.u32(i * 12);
    const id = lr.u32(i * 12 + 4);
    if (strOff >= mstr.size) {
      warnings.push(`string table ns=0x${ns.toString(16)}: entry ${i} offset out of pool`);
      continue;
    }
    strings.set(id, cstr(mstr.data, strOff));
  }
  return { ns, count, capacity: info.length > 1 ? info[1] : maxEntries, info, strings };
}

/** All string tables in the file keyed by namespace. */
export function readStringTables(f: LoocFile, warnings: string[] = []): Map<number, LoocStringTable> {
  const out = new Map<number, LoocStringTable>();
  for (const c of f.chunks) {
    if (c.tag !== 'mstr' || out.has(c.ns)) continue;
    const t = readStringTable(f, c.ns, warnings);
    if (t) out.set(c.ns, t);
  }
  return out;
}

export const LOOC_NS_NAMES = 0;
export const LOOC_NS_ATOMS = 0x3e8;

/** Map "<Target>:<Panel>" (or other ns-0 names) → chunk, for named chunks (pref/PLst/prpl). */
export function namedChunks(f: LoocFile, names: LoocStringTable | undefined, warnings: string[] = []) {
  const out = new Map<string, import('./container').LoocChunk>();
  for (const c of f.chunks) {
    if (c.tag !== 'pref' && c.tag !== 'PLst' && c.tag !== 'prpl') continue;
    const name = names?.strings.get(c.id);
    if (name === undefined) {
      warnings.push(`'${c.tag}' chunk #${c.index} has unknown name id ${c.id}`);
      continue;
    }
    if (out.has(name)) warnings.push(`duplicate named chunk "${name}"; keeping the first`);
    else out.set(name, c);
  }
  return out;
}
