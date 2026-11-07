/**
 * Program loaders: CodeWarrior `.abs` (ELF PT_LOAD segments, so the EEPROM library code that the
 * Burner leaves out of the `.s19` is loaded too) and Motorola S-records.
 *
 * Address forms (CodeWarrior "logical" addresses, see @s12/devices logicalToGlobal):
 *  - <= $FFFF: local address mapped with the RESET page registers (EEPROM $0800-$0BFF under EPAGE $FE,
 *    RAM $1000-$1FFF under RPAGE $FD, flash $8000-$BFFF under PPAGE $FE);
 *  - $PPAAAA with AAAA in a paging window: page PP of that window (e.g. $E08000, $FC0800, $F81000).
 */
import { logicalToGlobal } from '@s12/devices';
import { PT_LOAD, readElf, readSRecords, readSymbols, STT_FILE, STT_SECTION } from '@s12/formats';
import type { Memory } from './memory.js';

export interface LoadedSegment {
  /** Address as stored in the file (logical, or global for S2/S3 records <= $7FFFFF). */
  address: number;
  /** Global address of the first byte. */
  global: number;
  size: number;
}

export interface LoadResult {
  /** ELF entry point (logical), or the S7/S8/S9 address. */
  entry?: number;
  segments: LoadedSegment[];
  /** Global symbols (name -> value) from the ELF symbol table (.abs only). */
  symbols: Map<string, number>;
  /** Bytes that could not be placed (unmapped addresses). */
  skipped: number;
}

export class LoadError extends Error {}

/** Global address of byte `i` of a logical range starting at `logical`. */
function logicalByteToGlobal(logical: number, i: number): number {
  if (logical <= 0xffff) return logicalToGlobal((logical + i) & 0xffff);
  const page = logical & 0xff0000;
  return logicalToGlobal(page | ((logical + i) & 0xffff));
}

function place(mem: Memory, address: number, data: Uint8Array, toGlobal: (i: number) => number): LoadedSegment & { skipped: number } {
  let skipped = 0;
  let first = -1;
  for (let i = 0; i < data.length; i++) {
    let g: number;
    try {
      g = toGlobal(i);
    } catch {
      skipped++;
      continue;
    }
    if (!mem.load(g, data[i])) skipped++;
    else if (first < 0) first = g;
  }
  return { address, global: first, size: data.length, skipped };
}

/** Load the PT_LOAD segments of a CodeWarrior `.abs` into memory (flash/EEPROM written directly). */
export function loadAbs(mem: Memory, abs: Uint8Array): LoadResult {
  const elf = readElf(abs);
  const segments: LoadedSegment[] = [];
  let skipped = 0;
  for (const ph of elf.programHeaders) {
    if (ph.type !== PT_LOAD || ph.filesz === 0) continue;
    if (ph.offset + ph.filesz > abs.length) throw new LoadError(`segment at 0x${ph.vaddr.toString(16)} extends past end of file`);
    const data = abs.subarray(ph.offset, ph.offset + ph.filesz);
    const s = place(mem, ph.vaddr, data, (i) => logicalByteToGlobal(ph.vaddr, i));
    skipped += s.skipped;
    segments.push({ address: s.address, global: s.global, size: s.size });
  }
  const symbols = new Map<string, number>();
  try {
    for (const sym of readSymbols(elf)) {
      if (!sym.name || sym.type === STT_FILE || sym.type === STT_SECTION) continue;
      if (!symbols.has(sym.name)) symbols.set(sym.name, sym.value);
    }
  } catch {
    // no symbol table
  }
  return { entry: elf.header.entry, segments, symbols, skipped };
}

export interface SrecLoadOptions {
  /**
   * How to interpret S2/S3 addresses: 'auto' (default) treats addresses <= $FFFF as local (non-paged, as
   * S1), $10000-$7FFFFF as global (.glo files) and larger ones as CodeWarrior logical $PPAAAA;
   * 'logical' / 'global' force one interpretation. S1 addresses are always local (reset page registers).
   * UNCERTAIN: global $000000-$00FFFF is only the register block + unimplemented space, so a <= $FFFF
   * S2/S3 address is far more likely a non-paged local address (e.g. Burner output) than a global one.
   */
  addressing?: 'auto' | 'logical' | 'global';
}

/** Load Motorola S-records (S1 local / S2-S3 logical or global). */
export function loadSrec(mem: Memory, text: string | Uint8Array, opts: SrecLoadOptions = {}): LoadResult {
  const f = readSRecords(text);
  if (f.errors.length) throw new LoadError(`S-record errors: ${f.errors.map((e) => `line ${e.line}: ${e.message}`).join('; ')}`);
  const segments: LoadedSegment[] = [];
  let skipped = 0;
  const mode = opts.addressing ?? 'auto';
  for (const r of f.records) {
    if (r.type < 1 || r.type > 3 || r.data.length === 0) continue;
    const a = r.address;
    const global = r.type !== 1 && (mode === 'global' || (mode === 'auto' && a > 0xffff && a <= 0x7fffff));
    const s = place(mem, a, r.data, (i) => (global ? a + i : logicalByteToGlobal(a, i)));
    skipped += s.skipped;
    const prev = segments[segments.length - 1];
    if (prev && prev.address + prev.size === a && prev.global + prev.size === s.global) prev.size += s.size;
    else segments.push({ address: a, global: s.global, size: s.size });
  }
  const res: LoadResult = { segments, symbols: new Map(), skipped };
  if (f.terminator) res.entry = f.terminator.address;
  return res;
}
