// Burner (burner.exe) clone: executes a .bbl plan against a linked .abs and writes S-record files.
// Spec: docs/research/r1/asm.md §10, r2/elf-lib-formats.md §5. Plan/transfer/S-record logic lives in @s12/formats.
import {
  applyBblTransfers,
  bblOutputWriteOptions,
  latin1ToBytes,
  parseBbl,
  planBbl,
  readElf,
  writeElf,
  writeSRecords,
  PT_LOAD,
  type BblBlock,
  type ElfFile,
} from '@s12/formats';

export interface BurnInput {
  absBytes?: Uint8Array;
  abs?: ElfFile;
  bblText: string;
  bblPath?: string;
  /**
   * Absolute path of the .abs as CodeWarrior saw it: the value of %ABS_FILE% and the S0 header text
   * (e.g. "C:\\...\\bin\\Project.abs"). Defaults to env.ABS_FILE.
   */
  absPath?: string;
  /** extra macros (%NAME%) for the .bbl */
  env?: Record<string, string>;
}

export interface BurnOutputFile {
  /** output path with macros expanded (e.g. "<abs>.s19") */
  path: string;
  text: string;
  bytes: Uint8Array;
}

export interface BurnResult {
  ok: boolean;
  outputs: BurnOutputFile[];
  /** Burner messages (`B`-codes are not modelled; plan messages / warnings verbatim) */
  messages: string[];
  warnings: string[];
}

/** Memory image of a linked .abs: one block per PT_LOAD with file contents, at p_vaddr (CW sets p_paddr = 0). */
export function absLoadBlocks(abs: Uint8Array | ElfFile): BblBlock[] {
  const bytes = abs instanceof Uint8Array ? abs : writeElf(abs);
  const elf = readElf(bytes);
  return elf.programHeaders
    .filter((p) => p.type === PT_LOAD && p.filesz > 0)
    .map((p) => ({ address: p.vaddr, data: bytes.slice(p.offset, p.offset + p.filesz) }))
    .sort((a, b) => a.address - b.address);
}

/**
 * Run a .bbl (e.g. prm/burner.bbl) on the .abs. Byte-identical to CodeWarrior's Project.abs.s19 / .glo: S0 = abs path,
 * 32 data bytes per record (SLINELEN), S9 0000 terminator, only the address windows the .bbl lists — so the
 * EEPROM library code at 0x0800 is omitted exactly like CodeWarrior does (use burnFull for a complete image).
 */
export function burn(input: BurnInput): BurnResult {
  const absPath = input.absPath ?? input.env?.ABS_FILE ?? '';
  // The .abs path is %ABS_FILE% (output names like "%ABS_FILE%.s19") and the S0 header: without it the outputs
  // would be named ".s19" / ".glo" with an empty S0, so refuse instead of producing them.
  if (!absPath) return { ok: false, outputs: [], messages: ['no .abs path given (absPath or env.ABS_FILE)'], warnings: [] };
  const env = { ABS_FILE: absPath, ...input.env };
  const bbl = parseBbl(input.bblText);
  const messages: string[] = bbl.errors.map((e) => `${input.bblPath ?? 'bbl'}(${e.line}): ${e.message}`);
  if (bbl.errors.length) return { ok: false, outputs: [], messages, warnings: [] };
  const plan = planBbl(bbl, { env });
  const warnings = [...plan.warnings];
  messages.push(...plan.messages);
  const src = input.absBytes ?? input.abs;
  if (!src) return { ok: false, outputs: [], messages: [...messages, 'no .abs given'], warnings };
  const blocks = absLoadBlocks(src);
  const outputs: BurnOutputFile[] = [];
  for (const out of plan.outputs) {
    if (out.isCom) {
      warnings.push(`line ${out.line}: OPENCOM output not supported (skipped)`);
      continue;
    }
    if (out.format !== 'srecord') {
      warnings.push(`line ${out.line}: format ${out.format} not supported (skipped)`);
      continue;
    }
    for (const t of out.transfers) {
      // UNCERTAIN: SENDBYTE of a file other than the .abs is not supported; the .abs image is used.
      if (t.input !== absPath) warnings.push(`line ${t.line}: input "${t.input}" is not the linked .abs; using the .abs image`);
    }
    const text = writeSRecords(applyBblTransfers(blocks, out.transfers, warnings), bblOutputWriteOptions(out, absPath));
    outputs.push({ path: out.file, text, bytes: latin1ToBytes(text) });
  }
  return { ok: true, outputs, messages, warnings };
}

export interface BurnFullOptions {
  /** S0 header text (default: the .abs path, like Burner) */
  absPath?: string;
  /** data bytes per record (default 32) */
  bytesPerRecord?: number;
}

/** Suffix of the complete image written next to the .abs (PLAN.md M3). */
export const FULL_S19_SUFFIX = '.full.s19';

/**
 * NOT a CodeWarrior output: an S19 of EVERY loadable byte of the .abs at its LOGICAL (CPU) address — including the
 * EEPROM-resident library code that CodeWarrior's burner.bbl leaves out. Intended for our own
 * loader/flasher. Record type is chosen automatically (S1 when every address fits 16 bits, else S2/S3), S9 0000.
 *
 * Addresses are NOT translated: paged code appears at its 24-bit logical address (e.g. 0xFE8000 for PAGE_FE, as
 * S2 records) and EEPROM at 0x0800, exactly as in the .abs program headers. A flasher must map pages to global
 * addresses itself (as the .glo path of burner.bbl does: 0xFE8000 -> 0x7F8000), e.g. with @s12/devices
 * `logicalToGlobal`.
 */
export function burnFull(abs: Uint8Array | ElfFile, opts: BurnFullOptions = {}): BurnOutputFile {
  const text = writeSRecords(absLoadBlocks(abs), { header: opts.absPath, recordType: 'auto', bytesPerRecord: opts.bytesPerRecord ?? 32 });
  return { path: `${opts.absPath ?? 'Project.abs'}${FULL_S19_SUFFIX}`, text, bytes: latin1ToBytes(text) };
}
