/**
 * Debug symbols of a loaded CodeWarrior `.abs`: ELF symbol table (name -> address/size/type/section/module),
 * DWARF 2 line table (address <-> `.dbg` file + line) and compile-unit info (subprograms, variables with
 * their base types), plus source-file resolution and the identifier lookup used by the expression evaluator.
 *
 * Library modules (ME305LibV4.0.lib) carry DWARF line info for `Lib_*.dbg`, but those files are not in the
 * project, so their code has "no source" and is shown/stepped as disassembly.
 */
import {
  decodeCwCompileUnits,
  findSection,
  parseDebugLine,
  readElf,
  readSymbols,
  STT_FILE,
  STT_FUNC,
  STT_OBJECT,
  STT_SECTION,
  STB_GLOBAL,
  SHN_ABS,
  type CwCompileUnit,
  type ElfFile,
} from '@s12/formats';
import { baseName, findInPaths, type DebugFileSystem } from './fs';
import type { IdentValue, SourceLine } from './target';

export type SymbolKind = 'func' | 'object' | 'notype';

export interface SymbolInfo {
  name: string;
  /** Logical address (local 16-bit for non-paged code/data). */
  address: number;
  size: number;
  kind: SymbolKind;
  global: boolean;
  /** ELF section name (MyCode, .data, Lib_LCD...). */
  section?: string;
  /** Module (`main.dbg`, `Lib_LCD.dbg`): the preceding STT_FILE symbol. */
  module?: string;
  /** Variables from DWARF: element byte size, array length. */
  variable?: { byteSize: number; arrayLength?: number; typeName: string; signed: boolean };
}

export interface LineEntry extends SourceLine {
  /** Exclusive end address of the row (next row's address; for the last row of a sequence: address + 1). */
  endAddress: number;
  /** Compile unit (module) name, e.g. `main.dbg`. */
  module: string;
}

export interface SubprogramInfo {
  name: string;
  low: number;
  high: number;
  external: boolean;
}

export interface VariableInfo {
  name: string;
  address: number;
  byteSize: number;
  typeName: string;
  signed: boolean;
  arrayLength?: number;
  external: boolean;
}

export interface CompileUnitInfo {
  name: string;
  /** Line-table file path as stored (absolute Windows path of bin\<module>.dbg). */
  file: string;
  compDir: string;
  subprograms: SubprogramInfo[];
  variables: VariableInfo[];
  lowPc: number;
  highPc: number;
}

const DW_ATE_SIGNED = 5;
const DW_ATE_SIGNED_CHAR = 6;

export class DebugSymbols {
  readonly symbols: SymbolInfo[] = [];
  readonly units: CompileUnitInfo[] = [];
  /** Line rows sorted by address. */
  readonly lines: LineEntry[] = [];
  entry?: number;
  /** Problems while reading debug info (the symbol table is still usable). */
  readonly warnings: string[] = [];
  private byName = new Map<string, SymbolInfo[]>();
  private byNameCI = new Map<string, SymbolInfo[]>();
  private byAddress = new Map<number, SymbolInfo[]>();
  private funcsSorted: SymbolInfo[] = [];
  private rowsByFileLine = new Map<string, LineEntry[]>();

  /** Read symbols + DWARF from `.abs` bytes. */
  static fromAbs(bytes: Uint8Array): DebugSymbols {
    const s = new DebugSymbols();
    s.readElf(readElf(bytes));
    return s;
  }

  /** Empty symbol table (S-record loads). */
  static empty(): DebugSymbols {
    return new DebugSymbols();
  }

  private readElf(elf: ElfFile): void {
    this.entry = elf.header.entry;
    let module: string | undefined;
    try {
      for (const sym of readSymbols(elf)) {
        if (sym.type === STT_FILE) {
          module = sym.name || undefined;
          continue;
        }
        if (!sym.name || sym.type === STT_SECTION || sym.type === 13) continue;
        const section = sym.shndx > 0 && sym.shndx < elf.sections.length && sym.shndx !== SHN_ABS ? elf.sections[sym.shndx].name : undefined;
        this.add({
          name: sym.name,
          address: sym.value,
          size: sym.size,
          kind: sym.type === STT_FUNC ? 'func' : sym.type === STT_OBJECT ? 'object' : 'notype',
          global: sym.bind === STB_GLOBAL,
          section,
          // ELF lists all locals (grouped after their STT_FILE) before the globals: a global's module comes from DWARF
          module: sym.bind === STB_GLOBAL ? undefined : module,
        });
      }
    } catch (e) {
      this.warnings.push(`symbol table: ${(e as Error).message}`);
    }
    const sec = (n: string) => findSection(elf, n)?.data;
    const info = sec('.debug_info');
    const abbrev = sec('.debug_abbrev');
    const line = sec('.debug_line');
    let cus: CwCompileUnit[] | undefined;
    if (info && abbrev && line) {
      try {
        cus = decodeCwCompileUnits({ info, abbrev, line });
      } catch (e) {
        this.warnings.push(`DWARF (CodeWarrior decoder): ${(e as Error).message}; using the generic line-table reader`);
      }
    }
    if (cus) this.addUnits(cus);
    else if (line) this.addGenericLines(line);
    this.finish();
  }

  private add(s: SymbolInfo): void {
    this.symbols.push(s);
    const push = <K>(m: Map<K, SymbolInfo[]>, k: K) => {
      const l = m.get(k);
      if (l) l.push(s);
      else m.set(k, [s]);
    };
    push(this.byName, s.name);
    push(this.byNameCI, s.name.toLowerCase());
    push(this.byAddress, s.address);
  }

  private addUnits(cus: CwCompileUnit[]): void {
    for (const cu of cus) {
      const unit: CompileUnitInfo = { name: cu.name, file: cu.lineFile, compDir: cu.compDir, subprograms: [], variables: [], lowPc: Infinity, highPc: -Infinity };
      for (const e of cu.entries) {
        if (e.kind === 'subprogram') {
          unit.subprograms.push({ name: e.name, low: e.low.value, high: e.high.value, external: e.external });
        } else {
          const bt = cu.baseTypes[e.type];
          unit.variables.push({
            name: e.name,
            address: e.location.value,
            byteSize: bt?.byteSize ?? 1,
            typeName: bt?.name ?? 'unsigned char',
            signed: bt ? bt.encoding === DW_ATE_SIGNED || bt.encoding === DW_ATE_SIGNED_CHAR : false,
            arrayLength: e.array?.length,
            external: e.external,
          });
        }
      }
      for (const seq of cu.sequences) {
        const rows = seq.rows;
        for (let i = 0; i < rows.length; i++) {
          // several rows at one address: the last one wins (the code line after label-only lines)
          if (i + 1 < rows.length && rows[i + 1].address === rows[i].address) continue;
          let end = rows[i].address + 1;
          for (let j = i + 1; j < rows.length; j++)
            if (rows[j].address > rows[i].address) {
              end = rows[j].address;
              break;
            }
          this.lines.push({ file: cu.lineFile, module: cu.name, line: rows[i].line, address: rows[i].address, endAddress: end });
          unit.lowPc = Math.min(unit.lowPc, rows[i].address);
          unit.highPc = Math.max(unit.highPc, end);
        }
      }
      this.units.push(unit);
    }
  }

  private addGenericLines(data: Uint8Array): void {
    try {
      for (const prog of parseDebugLine(data)) {
        const files = prog.header.files;
        const rows = prog.rows;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          if (r.endSequence) continue;
          if (i + 1 < rows.length && rows[i + 1].address === r.address && !rows[i + 1].endSequence) continue;
          const file = files[r.file - 1]?.name ?? '?';
          const next = rows.slice(i + 1).find((x) => x.address > r.address);
          this.lines.push({ file, module: baseName(file), line: r.line, address: r.address, endAddress: next ? next.address : r.address + 1 });
        }
      }
    } catch (e) {
      this.warnings.push(`.debug_line: ${(e as Error).message}`);
    }
  }

  private finish(): void {
    this.lines.sort((a, b) => a.address - b.address);
    for (const l of this.lines) {
      const k = `${baseName(l.file).toLowerCase()}:${l.line}`;
      const arr = this.rowsByFileLine.get(k);
      if (arr) arr.push(l);
      else this.rowsByFileLine.set(k, [l]);
    }
    // modules of globals: the CU declaring the subprogram/variable, else the CU whose line rows cover the address
    for (const u of this.units)
      for (const sp of u.subprograms) for (const s of this.byName.get(sp.name) ?? []) if (!s.module && s.address === sp.low) s.module = u.name;
    for (const s of this.symbols) if (!s.module && s.kind !== 'object') s.module = this.lineAt(s.address)?.module;
    // attach DWARF variable types to symbols
    for (const u of this.units)
      for (const v of u.variables) {
        const s = (this.byName.get(v.name) ?? []).find((x) => x.address === v.address);
        const variable = { byteSize: v.byteSize, arrayLength: v.arrayLength, typeName: v.typeName, signed: v.signed };
        if (s) {
          s.variable = variable;
          s.module = u.name;
        } else this.add({ name: v.name, address: v.address, size: v.byteSize * (v.arrayLength ?? 1), kind: 'object', global: v.external, module: u.name, variable });
      }
    this.funcsSorted = this.symbols.filter((s) => s.kind === 'func' || (s.kind === 'notype' && s.section)).sort((a, b) => a.address - b.address);
  }

  // ------------------------------------------------------------------------------------------- queries

  /**
   * Symbol by name. `module:name` (or `file.dbg:name`) restricts to a module. Exact case first, then any case.
   * Globals win over locals with the same name.
   */
  lookup(name: string, opts: { caseInsensitive?: boolean } = {}): SymbolInfo | undefined {
    let module: string | undefined;
    const c = name.lastIndexOf(':');
    if (c > 0) {
      module = name.slice(0, c).toLowerCase();
      name = name.slice(c + 1);
    }
    const pick = (l: SymbolInfo[] | undefined) => {
      if (!l?.length) return undefined;
      const m = module ? l.filter((s) => s.module && (s.module.toLowerCase() === module || s.module.toLowerCase() === `${module}.dbg` || s.module.toLowerCase().replace(/\.dbg$/, '') === module.replace(/\.(asm|c|dbg)$/, ''))) : l;
      return m.find((s) => s.global) ?? m[0];
    };
    return pick(this.byName.get(name)) ?? (opts.caseInsensitive !== false ? pick(this.byNameCI.get(name.toLowerCase())) : undefined);
  }

  /** Symbols exactly at an address. */
  symbolsAt(address: number): SymbolInfo[] {
    return this.byAddress.get(address) ?? [];
  }

  /** Best label for an address: a code symbol (func) preferred over data/notype, globals first. */
  labelAt(address: number): string | undefined {
    const l = this.symbolsAt(address);
    if (!l.length) return undefined;
    const rank = (s: SymbolInfo) => (s.kind === 'func' ? 0 : s.kind === 'notype' ? 1 : 2) * 2 + (s.global ? 0 : 1);
    return [...l].sort((a, b) => rank(a) - rank(b))[0].name;
  }

  /** Nearest code symbol at or before `address` that covers it (within its size, or up to 0x1000 if size 0). */
  symbolFor(address: number): { symbol: SymbolInfo; offset: number } | undefined {
    const f = this.funcsSorted;
    let lo = 0;
    let hi = f.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (f[mid].address <= address) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best < 0) return undefined;
    // among symbols at the same address prefer a global
    let s = f[best];
    for (let i = best; i >= 0 && f[i].address === s.address; i--) if (f[i].global) s = f[i];
    const off = address - s.address;
    if (s.size ? off >= s.size : off >= 0x1000) return undefined;
    return { symbol: s, offset: off };
  }

  /** `name` or `name+off` for an address, or undefined. */
  formatAddress(address: number): string | undefined {
    const exact = this.labelAt(address);
    if (exact) return exact;
    const f = this.symbolFor(address);
    return f ? `${f.symbol.name}+${f.offset}` : undefined;
  }

  /** Line row containing `address`. */
  lineAt(address: number): LineEntry | undefined {
    const l = this.lines;
    let lo = 0;
    let hi = l.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (l[mid].address <= address) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best < 0) return undefined;
    const r = l[best];
    return address < r.endAddress ? r : undefined;
  }

  /** Is `address` the first address of a line-table row? */
  isLineStart(address: number): boolean {
    const r = this.lineAt(address);
    return !!r && r.address === address;
  }

  /** Addresses of a source line (file matched by base name, case-insensitive). */
  addressesOf(file: string, line: number): number[] {
    return (this.rowsByFileLine.get(`${baseName(file).toLowerCase()}:${line}`) ?? []).map((r) => r.address);
  }

  /** Nearest line with code at or after `line` in `file` (for setting breakpoints on blank/comment lines). */
  nearestCodeLine(file: string, line: number, maxDistance = 1000): { line: number; address: number } | undefined {
    for (let l = line; l <= line + maxDistance; l++) {
      const a = this.addressesOf(file, l);
      if (a.length) return { line: l, address: a[0] };
    }
    return undefined;
  }

  unitAt(address: number): CompileUnitInfo | undefined {
    const r = this.lineAt(address);
    if (r) return this.units.find((u) => u.name === r.module);
    return this.units.find((u) => u.subprograms.some((s) => address >= s.low && address < s.high));
  }

  /** Subprogram (DWARF) containing address. */
  subprogramAt(address: number): SubprogramInfo | undefined {
    let best: SubprogramInfo | undefined;
    for (const u of this.units)
      for (const s of u.subprograms) if (address >= s.low && address < s.high && (!best || s.low >= best.low)) best = s;
    return best;
  }

  /** Global data objects (Data window "Global" scope). */
  globalVariables(): SymbolInfo[] {
    return this.symbols.filter((s) => s.kind === 'object');
  }

  /** Line-table files (DWARF paths), one per CU. */
  sourceFiles(): string[] {
    return [...new Set(this.lines.map((l) => l.file))];
  }

  /** Identifier meaning for the expression evaluator. */
  identValue(name: string, opts: { caseInsensitive?: boolean } = {}): IdentValue | undefined {
    const s = this.lookup(name, opts);
    return s ? DebugSymbols.identOf(s) : undefined;
  }

  /** Expression meaning of a symbol: data objects are variables (value read from memory), the rest are labels. */
  static identOf(s: SymbolInfo): IdentValue {
    if (s.kind === 'object') {
      const v = s.variable;
      const elem = v?.byteSize ?? (s.size === 1 || s.size === 2 || s.size === 4 ? s.size : 1);
      const array = v ? (v.arrayLength ?? 1) > 1 : s.size > 4 || s.size === 3;
      return { kind: 'var', address: s.address, size: elem, signed: v?.signed, array };
    }
    return { kind: 'label', address: s.address };
  }
}

/**
 * Locates `.dbg`/`.asm` source files named in the DWARF line table (absolute Windows paths from the build PC)
 * by base name in the search paths (OBJPATH, GENPATH, project bin...), case-insensitively. Results are cached.
 */
export class SourceResolver {
  private cache = new Map<string, string | null>();
  constructor(
    readonly fs: DebugFileSystem,
    public searchPaths: string[] = [],
  ) {}

  async resolve(path: string): Promise<string | undefined> {
    const key = path.toLowerCase();
    if (this.cache.has(key)) return this.cache.get(key) ?? undefined;
    let hit: string | undefined;
    if (!/^[A-Za-z]:[\\/]/.test(path) && (await this.fs.exists(path))) hit = path;
    else hit = await findInPaths(this.fs, baseName(path), this.searchPaths);
    this.cache.set(key, hit ?? null);
    return hit;
  }

  /** Synchronous answer for paths already resolved (undefined = unknown or missing). */
  resolvedSync(path: string): string | null | undefined {
    return this.cache.get(path.toLowerCase());
  }

  clear(): void {
    this.cache.clear();
  }
}
