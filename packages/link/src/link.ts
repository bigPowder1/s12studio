// SmartLinker V-5.0.40 clone: PRM placement, smart linking, relocation, .abs + .map generation.
// Specs: docs/research/r2/elf-lib-formats.md §4, r2/critique.md G3/C10/C13, r1/asm.md §8-11.
import {
  parsePrm,
  readElf,
  readHiwareLib,
  relocKind,
  inPlaceAddend,
  applyRelocation,
  SHN_ABS,
  SHN_UNDEF,
  SHT_NOBITS,
  SHT_PROGBITS,
  SHF_ALLOC,
  SHF_WRITE,
  STB_LOCAL,
  STT_FUNC,
  STT_OBJECT,
  STT_SECTION,
  type ElfRela,
  type PrmFile,
  type PrmSegment,
} from '@s12/formats';
import { LinkMessages, isError } from './messages';
import {
  buildModule,
  isGlobalDef,
  isObjectSymbol,
  moduleBase,
  moduleDisplayName,
  realSymbolIndex,
  sectionAccess,
  type InSection,
  type Module,
  type OutSection,
} from './model';
import { canonicalSection, DEFAULT_SECTION_ORDER, SEG_SYMBOL } from './sections';
import { byAddress, type LinkObject } from './objects';
import { buildAbs, loadSegments, DEBUG_SECTION_ORDER } from './abs';
import { writeMap, type TreeGroup } from './map';
import { ctime, linkerCommandLine } from './note';
import type { LinkInput, LinkInputEntry, LinkLayout, LinkMessage, LinkResult, NoteMeta } from './types';

/** Link CodeWarrior-dialect ELF objects and HIWARE libraries according to a PRM file. */
export function link(input: LinkInput): LinkResult {
  return new Linker(input).run();
}

type Target =
  | { kind: 'sym'; mod: Module; idx: number }
  | { kind: 'linker'; name: string }
  | { kind: 'section'; sec: InSection }
  | { kind: 'debugsec'; mod: Module; index: number };

/** PRM commands that need no linker action here (HAS_BANKED_DATA only affects C banked data). */
const HARMLESS_COMMANDS = new Set(['HAS_BANKED_DATA']);

/** HC12 program counter size: the stack STACKTOP alone defines. */
const PC_STACK_SIZE = 2;

/** Predefined ELF sections: never "user" sections in the unplaced-section rules. */
const PREDEFINED = new Set(['.init', '.startData', '.text', '.rodata', '.rodata1', '.copy', '.data', '.bss', '.stack']);

interface SegState {
  seg: PrmSegment;
  fill: number;
}

/**
 * Order the inputs: explicit `inputs` first, then `libraries`, then `objects` (libraries before objects is the
 * CodeWarrior ME305 project link order, used both with and without `inputs`).
 */
export function orderLinkInputs(input: Pick<LinkInput, 'inputs' | 'objects' | 'libraries'>): LinkInputEntry[] {
  const objs = (input.objects ?? []).map((f) => ({ ...f, kind: 'object' as const }));
  const libs = (input.libraries ?? []).map((f) => ({ ...f, kind: 'library' as const }));
  return [...(input.inputs ?? []), ...libs, ...objs];
}

class Linker {
  readonly messages: LinkMessage[] = [];
  private mods: Module[] = [];
  private prm!: PrmFile;
  private readonly globals = new Map<string, { mod: Module; idx: number }>();
  private readonly libIndex = new Map<string, Module>();
  private readonly undefinedSeen = new Set<string>();
  private readonly work: InSection[] = [];
  private init?: { mod: Module; idx: number; name: string };
  private initSection?: InSection;
  private readonly outsByName = new Map<string, OutSection>();
  private stack?: OutSection;
  /** SECTION-ALLOCATION order: placed sections in allocation order, then ORG sections, then vectors */
  private readonly allocOrder: OutSection[] = [];
  private readonly orgOuts: OutSection[] = [];
  private readonly vectorOuts: OutSection[] = [];
  private readonly placementNames: string[] = [];
  private readonly segs = new Map<string, SegState>();
  private readonly linkerValues = new Map<string, number>();
  private readonly debugBase = new Map<string, number>();
  private entries: LinkInputEntry[] = [];

  constructor(private readonly input: LinkInput) {}

  run(): LinkResult {
    const empty: LinkLayout = { sections: [], symbols: [], modules: [] };
    this.entries = orderLinkInputs(this.input);
    if (!this.load()) return { ok: false, messages: this.messages, layout: empty };
    this.prm = parsePrm(this.input.prmText, { include: this.input.prmInclude });
    for (const e of this.prm.errors) {
      // the PRM parser already rejects STACKSIZE + STACKTOP: report it with SmartLinker's own code
      if (/STACKSIZE and STACKTOP/.test(e.message)) this.messages.push({ ...LinkMessages.bothStack(), line: e.line });
      else this.messages.push(LinkMessages.prmSyntax(e.message, e.file ?? this.input.prmPath, e.line));
    }
    for (const f of this.prm.includes) {
      if (this.input.prmInclude?.(f) === undefined) this.messages.push(LinkMessages.fileNotFound(f, this.input.prmPath));
    }
    if (this.prm.errors.length || this.messages.some(isError)) return { ok: false, messages: this.messages, layout: empty };

    for (const m of this.mods) if (m.loaded) this.register(m);
    for (const m of this.mods) {
      if (!m.library) continue;
      m.syms.forEach((s) => {
        if (isGlobalDef(s) && !this.libIndex.has(s.name)) this.libIndex.set(s.name, m);
      });
    }

    this.smartLink();
    this.place();
    this.computeLinkerSymbols();
    this.buildVectors();
    this.computeDebugBases();
    const sectionData = this.relocateAlloc();
    const objects = this.buildObjects();
    const linked = this.linkedModules();
    this.checkOverlaps(objects);
    this.checkUnsupported();

    const layout = this.layout(objects, linked);
    if (this.messages.some(isError)) return { ok: false, messages: this.messages, layout };

    const allocOuts = [...this.allocOrder].filter((o) => o.size > 0);
    const absOuts = [...allocOuts].sort((a, b) => a.address - b.address);
    const debug = this.buildDebug(linked);
    const note = this.noteMeta();
    const { elf, bytes } = buildAbs({
      entry: this.entryAddress(),
      outs: absOuts,
      sectionData,
      objects,
      debug,
      aranges: this.aranges(linked, debug.infoBase),
      note,
    });

    let mapText: string | undefined;
    const mapOn = (this.input.options?.mapFile ?? true) && !this.prm.mapFile.some((k) => /^(NONE|OFF)$/i.test(k));
    if (mapOn) {
      const segsLoad = loadSegments(absOuts);
      mapText = writeMap({
        outputPath: this.input.outputPath,
        modules: linked,
        entry: this.init ? { name: this.init.name, address: this.entryAddress() } : undefined,
        allocOrder: allocOuts,
        vectors: this.vectorOuts,
        objects,
        sectionUseOrder: this.sectionUseOrder(),
        otherData: this.stack?.size ?? 0,
        tree: this.treeGroups(objects),
        blocks: segsLoad.filter((p) => p.filesz > 0).length,
        blockBytes: segsLoad.reduce((n, p) => n + p.filesz, 0),
      });
    }
    return { ok: true, absBytes: bytes, abs: elf, mapText, messages: this.messages, layout };
  }

  // ------------------------------------------------------------------ inputs and symbols
  private load(): boolean {
    for (const e of this.entries) {
      const path = e.path ?? e.name;
      try {
        if (e.kind === 'object') {
          this.mods.push(buildModule(readElf(e.bytes), e.name, this.mods.length, path));
        } else {
          for (const m of readHiwareLib(e.bytes).members)
            this.mods.push(buildModule(m.elf ?? readElf(m.bytes), m.name, this.mods.length, path, e.name));
        }
      } catch (err) {
        this.messages.push(LinkMessages.notElf(path, err instanceof Error ? err.message : String(err)));
        return false;
      }
    }
    return true;
  }

  private register(m: Module): void {
    m.loaded = true;
    m.syms.forEach((s, idx) => {
      if (!isGlobalDef(s)) return;
      const prev = this.globals.get(s.name);
      if (prev && prev.mod !== m) this.messages.push(LinkMessages.duplicate(idx, s.name, moduleDisplayName(prev.mod), moduleDisplayName(m)));
      else if (!prev) this.globals.set(s.name, { mod: m, idx });
    });
  }

  /** Resolve a global name: loaded modules, then linker-defined __SEG_ symbols, then library members (loads one). */
  private resolveGlobal(name: string): Target | undefined {
    const g = this.globals.get(name);
    if (g) return { kind: 'sym', ...g };
    if (SEG_SYMBOL.test(name)) return { kind: 'linker', name };
    const m = this.libIndex.get(name);
    if (m && !m.loaded) {
      this.register(m);
      const g2 = this.globals.get(name);
      if (g2) return { kind: 'sym', ...g2 };
    }
    return undefined;
  }

  /** What relocation symbol `symIdx` of `mod` refers to. */
  private target(mod: Module, symIdx: number): Target | undefined {
    const i = realSymbolIndex(mod, symIdx);
    const s = mod.syms[i];
    if (s.shndx === SHN_UNDEF) return s.name ? this.resolveGlobal(s.name) : undefined;
    if (s.type === STT_SECTION) {
      const sec = mod.secs.get(s.shndx);
      return sec ? { kind: 'section', sec } : { kind: 'debugsec', mod, index: s.shndx };
    }
    return { kind: 'sym', mod, idx: i };
  }

  // ------------------------------------------------------------------ smart linking
  private keep(sec: InSection | undefined): void {
    if (!sec || sec.kept) return;
    sec.kept = true;
    this.work.push(sec);
  }

  private keepSym(mod: Module, idx: number): void {
    const s = mod.syms[idx];
    if (s.shndx === SHN_ABS) {
      for (const sec of mod.secs.values()) if (sec.isOrg && s.value >= sec.orgAddress && s.value < sec.orgAddress + sec.size) this.keep(sec);
      return;
    }
    this.keep(mod.secs.get(s.shndx));
  }

  private keepTarget(t: Target | undefined): void {
    if (t?.kind === 'sym') this.keepSym(t.mod, t.idx);
    else if (t?.kind === 'section') this.keep(t.sec);
  }

  private undefinedRef(mod: Module, symIdx: number): void {
    const name = mod.syms[realSymbolIndex(mod, symIdx)].name;
    const key = `${mod.order}:${name}`;
    if (this.undefinedSeen.has(key)) return;
    this.undefinedSeen.add(key);
    // UNCERTAIN: the <File name> CodeWarrior prints for a library member.
    this.messages.push(LinkMessages.undefinedSymbol(name, moduleDisplayName(mod)));
  }

  /**
   * Section-granular smart linking: a section is linked when a relocation of a linked section references a symbol
   * in it (a bare XREF never counts). Roots: the INIT object, MAIN, ENTRIES, VECTOR targets and every ORG section
   * of the object files.
   */
  private smartLink(): void {
    // UNCERTAIN: without INIT SmartLinker looks for _Startup (asm.md §8).
    const initName = this.prm.init ?? '_Startup';
    const it = this.resolveGlobal(initName);
    if (it?.kind === 'sym') {
      this.init = { ...it, name: initName };
      const s = it.mod.syms[it.idx];
      this.initSection = s.shndx !== SHN_ABS ? it.mod.secs.get(s.shndx) : undefined;
      this.keepSym(it.mod, it.idx);
    } else this.messages.push(LinkMessages.objectNotFound(initName));

    if (this.prm.main !== undefined) {
      const t = this.resolveGlobal(this.prm.main);
      if (t) this.keepTarget(t);
      else this.messages.push(LinkMessages.objectNotFound(this.prm.main));
    } else {
      // UNCERTAIN: the default MAIN object `main` is treated as a root only when an object file defines it.
      const g = this.globals.get('main');
      if (g) this.keepSym(g.mod, g.idx);
    }

    for (const e of this.prm.entries) this.keepEntry(e);
    for (const m of this.mods) if (m.loaded && !m.library) for (const sec of m.secs.values()) if (sec.isOrg) this.keep(sec);
    for (const v of this.prm.vectors) {
      if (typeof v.target !== 'string') continue;
      const t = this.resolveGlobal(v.target);
      if (t) this.keepTarget(t);
      else this.messages.push(LinkMessages.objectNotFound(v.target));
    }

    for (;;) {
      while (this.work.length) {
        const sec = this.work.pop()!;
        for (const r of sec.relocs) {
          const t = this.target(sec.mod, r.sym);
          if (!t) this.undefinedRef(sec.mod, r.sym);
          else this.keepTarget(t);
        }
      }
      // UNCERTAIN: ORG sections of a library member are linked together with the member.
      for (const m of this.mods) {
        if (!m.library || !m.loaded || ![...m.secs.values()].some((s) => s.kept)) continue;
        for (const sec of m.secs.values()) if (sec.isOrg) this.keep(sec);
      }
      if (!this.work.length) break;
    }
  }

  private keepEntry(e: string): void {
    if (e === '*') {
      for (const m of this.mods) if (m.loaded) for (const sec of m.secs.values()) this.keep(sec);
      return;
    }
    const colon = e.indexOf(':');
    if (colon > 0) {
      const file = e.slice(0, colon).toLowerCase();
      const obj = e.slice(colon + 1);
      const m = this.mods.find((x) => x.name.toLowerCase() === file);
      if (!m) return void this.messages.push(LinkMessages.objectNotFound(e));
      if (!m.loaded) this.register(m);
      if (obj === '*') for (const sec of m.secs.values()) this.keep(sec);
      else {
        const idx = m.syms.findIndex((s) => s.name === obj && isObjectSymbol(s));
        if (idx < 0) this.messages.push(LinkMessages.objectNotFound(e));
        else this.keepSym(m, idx);
      }
      return;
    }
    const t = this.resolveGlobal(e);
    if (t) this.keepTarget(t);
    else this.messages.push(LinkMessages.objectNotFound(e));
  }

  /** Modules listed in the map / debug info: loaded modules with a linked section (objects always). */
  private linkedModules(): Module[] {
    // UNCERTAIN: an object file none of whose sections is linked is still listed (it is on the command line).
    return this.mods.filter((m) => m.loaded && (!m.library || [...m.secs.values()].some((s) => s.kept)));
  }

  // ------------------------------------------------------------------ placement
  private place(): void {
    for (const s of this.prm.segments) this.segs.set(s.name, { seg: s, fill: s.start });

    // Output sections from kept input sections, concatenated in link order.
    for (const m of this.mods) {
      if (!m.loaded) continue;
      for (const sec of m.secs.values()) {
        if (!sec.kept || sec.isOrg) continue;
        // The section holding the INIT object goes to .init (golden: Lib_Startup -> .init in ROM_C000 even though
        // the PRM says `Lib_Startup INTO EEPROM`). Applied per input piece: another module's section of the same
        // name stays where PLACEMENT puts it. UNCERTAIN as a general rule (two samples, both single-piece).
        const name = sec === this.initSection ? '.init' : canonicalSection(sec.name);
        let out = this.outsByName.get(name);
        if (!out) {
          out = { name, kind: 'placed', segment: '', type: SHT_NOBITS, flags: 0, address: 0, size: 0, pieces: [], placed: false };
          this.outsByName.set(name, out);
        }
        sec.out = out;
        sec.offset = out.size;
        out.size += sec.size;
        out.pieces.push(sec);
        out.flags |= sec.flags;
        if (sec.type !== SHT_NOBITS) out.type = SHT_PROGBITS;
      }
    }

    const mentioned = new Set(this.prm.placements.flatMap((p) => p.sections.map(canonicalSection)));
    if (this.prm.stackSize !== undefined && this.prm.stackTop !== undefined) this.messages.push(LinkMessages.bothStack());
    if (this.prm.stackSize !== undefined && this.prm.stackSize > 0) {
      this.stack = this.newStack(this.prm.stackSize);
    } else if (this.prm.stackTop !== undefined) {
      // STACKTOP with `.stack` placed: the stack runs from where it is placed up to STACKTOP (size computed at
      // allocation). STACKTOP alone: no section, a PC-sized stack just below STACKTOP (see segSymbolValue).
      if (mentioned.has('.stack')) this.stack = this.newStack(0);
    } else this.messages.push(LinkMessages.noStack());

    this.checkPlacementLists();
    const reported = new Set<string>();
    for (const p of this.prm.placements) {
      let segNames = p.segments;
      if (p.inlineSegment) {
        // UNCERTAIN: name of an inline (`INTO READ_ONLY 0x.. TO 0x..`) segment in the map.
        const name = p.inlineSegment.name || `${p.sections[0]}_SEG`;
        if (!this.segs.has(name)) this.segs.set(name, { seg: { ...p.inlineSegment, name }, fill: p.inlineSegment.start });
        segNames = [name];
      }
      for (const n of segNames) {
        if (!this.segs.has(n) && !reported.has(n)) {
          reported.add(n);
          this.messages.push(LinkMessages.segmentUnknown(n));
        }
      }
      // one allocation cursor per placement statement (SmartLinker -AllocNext)
      const list = segNames.filter((n) => this.segs.has(n));
      const cursor = { i: 0 };
      const put = (o: OutSection | undefined) => {
        if (o && !o.placed) this.allocate(o, list, cursor);
      };
      const unmentioned = (n: string) => (mentioned.has(n) ? undefined : this.outsByName.get(n));
      for (const raw of p.sections) {
        const name = canonicalSection(raw);
        if (!this.placementNames.includes(name)) this.placementNames.push(name);
        if (name === '.stack') {
          put(this.stack);
        } else if (name === '.text') {
          // Sections missing from PLACEMENT are allocated next to .text / .data in the manual's fixed order
          // (BTU "Allocating User-Defined Sections (ELF)"): .init .startData .text .rodata .rodata1 <user code> .copy
          put(unmentioned('.init'));
          put(unmentioned('.startData'));
          put(this.outsByName.get('.text'));
          put(unmentioned('.rodata'));
          put(unmentioned('.rodata1'));
          for (const o of this.userSections(mentioned, false)) put(o);
          put(unmentioned('.copy'));
        } else if (name === '.data') {
          // .data .bss <user data> .stack (when STACKSIZE and SSTACK is not in PLACEMENT)
          put(this.outsByName.get('.data'));
          put(unmentioned('.bss'));
          for (const o of this.userSections(mentioned, true)) put(o);
          if (!mentioned.has('.stack')) put(this.stack);
        } else {
          put(this.outsByName.get(name));
        }
      }
    }
    for (const o of this.outsByName.values()) if (!o.placed && o.size > 0) this.messages.push(LinkMessages.notPlaced(o.name));
    // A STACKSIZE stack that found no home (neither SSTACK nor DEFAULT_RAM in PLACEMENT) is an error, never a
    // silent `__SEG_END_SSTACK = 0`.
    if (this.stack && !this.stack.placed) this.messages.push(LinkMessages.notPlaced('.stack'));

    // ORG sections: one output section each, `<module>_<section>` in `.absSegN`.
    for (const m of this.mods) {
      if (!m.loaded) continue;
      for (const sec of m.secs.values()) {
        if (!sec.kept || !sec.isOrg || sec.size === 0) continue;
        const out: OutSection = {
          name: `${moduleBase(m.name)}_${sec.name}`, kind: 'org', segment: `.absSeg${this.orgOuts.length}`,
          type: sec.type, flags: sec.flags, address: sec.orgAddress, size: sec.size, pieces: [sec], placed: true,
        };
        sec.out = out;
        sec.offset = 0;
        this.orgOuts.push(out);
      }
    }
    this.allocOrder.push(...this.orgOuts);
    this.checkSegments();
  }

  private newStack(size: number): OutSection {
    return {
      name: '.stack', kind: 'stack', segment: '', type: SHT_NOBITS, flags: SHF_ALLOC | SHF_WRITE,
      address: 0, size, pieces: [], placed: false,
    };
  }

  /** Output sections absent from PLACEMENT, in link order: code/constants (`data` false) or variables. */
  private userSections(mentioned: ReadonlySet<string>, data: boolean): OutSection[] {
    return [...this.outsByName.values()].filter(
      (o) => !mentioned.has(o.name) && !PREDEFINED.has(o.name) && !!(o.flags & SHF_WRITE) === data,
    );
  }

  /** L1122 (.copy not last), L1110 (section in two statements / segment twice in one list). */
  private checkPlacementLists(): void {
    const seen = new Set<string>();
    for (const p of this.prm.placements) {
      const names = p.sections.map(canonicalSection);
      const copy = names.indexOf('.copy');
      if (copy >= 0 && copy !== names.length - 1) this.messages.push(LinkMessages.copyNotLast(p.line));
      for (const n of names) {
        if (seen.has(n)) this.messages.push(LinkMessages.twiceInPlacement(n, p.line));
        seen.add(n);
      }
      const segSeen = new Set<string>();
      for (const s of p.segments) {
        if (segSeen.has(s)) this.messages.push(LinkMessages.twiceInPlacement(s, p.line));
        segSeen.add(s);
      }
    }
  }

  /** L1100 for overlapping segments; clone warning for variables placed in a READ_ONLY segment. */
  private checkSegments(): void {
    const all = [...this.segs.values()].map((s) => s.seg);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i];
        const b = all[j];
        // "objects located in two PAGED segments may overlap" (BTU, PAGED qualifier)
        if (a.qualifier === 'PAGED' && b.qualifier === 'PAGED') continue;
        if (a.start <= b.end && b.start <= a.end) this.messages.push(LinkMessages.segmentsOverlap(a.name, b.name));
      }
    }
    for (const o of this.allocOrder) {
      if (o.kind === 'placed' && o.flags & SHF_WRITE && o.qualifier === 'READ_ONLY') {
        this.messages.push(LinkMessages.suspicious(`Variables section ${o.name} placed in READ_ONLY segment ${o.segment}`, o.name));
      }
    }
  }

  /**
   * Allocate `out` along a placement statement's segment list (SmartLinker -Alloc, default Next: once a section
   * does not fit the current segment, the next one is used and the gap is never filled later).
   */
  private allocate(out: OutSection, segNames: readonly string[], cursor: { i: number }): void {
    const stackTopMode = out.kind === 'stack' && this.prm.stackSize === undefined && this.prm.stackTop !== undefined;
    if (out.size === 0 && !stackTopMode) return;
    const mode = this.input.options?.alloc ?? 'next';
    const range = (from: number) => Array.from({ length: Math.max(0, segNames.length - from) }, (_, k) => from + k);
    const candidates =
      mode === 'first' ? range(0) : mode === 'next' ? range(cursor.i) : [cursor.i, ...range(0).filter((k) => k !== cursor.i)];
    for (const k of candidates) {
      const st = this.segs.get(segNames[k]);
      if (!st) continue;
      let size = out.size;
      if (stackTopMode) {
        // UNCERTAIN: STACKTOP + placed .stack: from the segment's next free byte up to (excluding) STACKTOP, so that
        // the initial SP (__SEG_END_SSTACK) equals STACKTOP like the manual's "stack pointer initial value".
        size = this.prm.stackTop! - st.fill;
        if (size <= 0 || this.prm.stackTop! > st.seg.end + 1) continue;
      }
      if (size > 0 && st.fill + size - 1 <= st.seg.end) {
        out.size = size;
        out.address = st.fill;
        st.fill += size;
        out.segment = segNames[k];
        out.qualifier = st.seg.qualifier;
        out.placed = true;
        cursor.i = k;
        this.allocOrder.push(out);
        return;
      }
    }
    // UNCERTAIN: the segment named by L1102 when a list of several segments is exhausted (the last one).
    // The cursor is NOT moved: a section that does not fit must not make the following (smaller) sections of the
    // same statement fail too. One message per text; every section it concerns is listed in `file`.
    const lastName = mode === 'next' ? segNames[segNames.length - 1] : segNames[cursor.i];
    const last = lastName !== undefined ? this.segs.get(lastName) : undefined;
    out.placed = true; // do not report again
    const m = LinkMessages.outOfSpace(last?.seg.name ?? '?', last?.fill ?? 0, out.name);
    const same = this.messages.find((x) => x.code === m.code && x.text === m.text);
    if (same) same.file = `${same.file}, ${out.name}`;
    else this.messages.push(m);
  }

  // ------------------------------------------------------------------ addresses
  private symAddress(mod: Module, idx: number): number {
    const s = mod.syms[idx];
    if (s.shndx === SHN_ABS) return s.value;
    const sec = mod.secs.get(s.shndx);
    if (!sec?.out) return 0;
    if (sec.isOrg) {
      // UNCERTAIN: st_value of a label inside an ORG section may be absolute or section-relative.
      return s.value >= sec.orgAddress && s.value <= sec.orgAddress + sec.size ? s.value : sec.orgAddress + s.value;
    }
    return sec.out.address + sec.offset + s.value;
  }

  private targetValue(mod: Module, symIdx: number): number {
    const t = this.target(mod, symIdx);
    if (!t) return 0;
    switch (t.kind) {
      case 'sym':
        return this.symAddress(t.mod, t.idx);
      case 'linker':
        return this.linkerValues.get(t.name) ?? 0;
      case 'section':
        return t.sec.out ? t.sec.out.address + t.sec.offset : 0;
      case 'debugsec':
        return this.debugBase.get(`${t.mod.order}:${t.index}`) ?? 0;
    }
  }

  private computeLinkerSymbols(): void {
    const names = new Set<string>();
    for (const m of this.mods) {
      if (!m.loaded) continue;
      for (const sec of m.secs.values()) {
        if (!sec.kept) continue;
        for (const r of sec.relocs) {
          const t = this.target(m, r.sym);
          if (t?.kind === 'linker' && !names.has(t.name)) {
            names.add(t.name);
            const v = this.segSymbolValue(t.name);
            if (v === undefined) this.messages.push(LinkMessages.createdByDefault(t.name, moduleDisplayName(m)));
            this.linkerValues.set(t.name, v ?? 0);
          }
        }
      }
    }
  }

  /** __SEG_START_/END_/SIZE_ of a section (alias names allowed) or of a PRM segment. */
  segSymbolValue(name: string): number | undefined {
    const m = SEG_SYMBOL.exec(name);
    if (!m) return undefined;
    const [, what, target] = m;
    const canon = canonicalSection(target);
    let start: number, size: number;
    const out = canon === '.stack' ? this.stack : this.outsByName.get(canon) ?? this.allocOrder.find((o) => o.name === target);
    if (out?.placed) {
      start = out.address;
      size = out.size;
    } else if (canon === '.stack' && this.prm.stackTop !== undefined) {
      // STACKTOP alone: "a default stack size big enough to store the target processor PC" (BTU STACKTOP).
      // UNCERTAIN: modelled as 2 bytes just below STACKTOP so that the initial SP (__SEG_END_SSTACK) = STACKTOP.
      start = this.prm.stackTop - PC_STACK_SIZE;
      size = PC_STACK_SIZE;
    } else if (canon === '.stack') {
      // SSTACK symbols never give L1823 (asm.md §8); a missing / unplaced stack is reported separately (L1201/L1103).
      start = 0;
      size = 0;
    } else {
      const seg = this.segs.get(target);
      if (!seg) return undefined;
      start = seg.seg.start;
      size = seg.seg.size;
    }
    return what === 'START' ? start : what === 'END' ? start + size : size;
  }

  private buildVectors(): void {
    this.prm.vectors.forEach((v, i) => {
      let value = 0;
      let target: string | undefined;
      if (typeof v.target === 'number') value = v.target;
      else {
        target = v.target;
        const t = this.globals.get(v.target);
        value = t ? this.symAddress(t.mod, t.idx) : 0;
      }
      value += v.offset ?? 0;
      if (value < 0 || value > 0xffff) {
        // A 16-bit vector cannot hold a banked (24-bit logical) address. CodeWarrior reports a fixup overflow for
        // vector entries pointing to banked ISRs. UNCERTAIN: the exact wording/offset for a PRM VECTOR command.
        this.messages.push(LinkMessages.fixup(`.vectSeg${i}_vect`, target ?? `0x${value.toString(16).toUpperCase()}`, 1, 0, this.input.prmPath));
        value &= 0xffff;
      }
      const data = Uint8Array.of(value >> 8, value & 0xff);
      // UNCERTAIN: name/segment of VECTOR sections (`.vectSegN_vect` in `.vectSegN`, from CW map samples).
      const out: OutSection = {
        name: `.vectSeg${i}_vect`, kind: 'vector', segment: `.vectSeg${i}`, type: SHT_PROGBITS, flags: SHF_ALLOC,
        address: v.address, size: 2, pieces: [], placed: true, data, vector: { address: v.address, value, target },
      };
      this.vectorOuts.push(out);
    });
    this.allocOrder.push(...this.vectorOuts);
  }

  /** Name of what relocation symbol `symIdx` refers to (section name for STT_SECTION relocations). */
  private targetName(sec: InSection, symIdx: number): string {
    const s = sec.mod.syms[realSymbolIndex(sec.mod, symIdx)];
    if (s.type === STT_SECTION) return sec.mod.secs.get(s.shndx)?.name ?? sec.mod.elf.sections[s.shndx]?.name ?? '?';
    return s.name;
  }

  /**
   * The object (procedure / variable / label) of `sec` containing address `P` (for L1907): the symbol whose
   * [address, address+size) holds P, else the closest one before P, else the section itself.
   */
  private objectAt(sec: InSection, P: number): { name: string; address: number } {
    const base = sec.out ? sec.out.address + sec.offset : 0;
    let best: { name: string; address: number } | undefined;
    let containing: { name: string; address: number } | undefined;
    sec.mod.syms.forEach((s, idx) => {
      if (!isObjectSymbol(s)) return;
      const inSec = s.shndx === sec.index || (s.shndx === SHN_ABS && sec.isOrg && s.value >= sec.orgAddress && s.value < sec.orgAddress + sec.size);
      if (!inSec) return;
      const a = this.symAddress(sec.mod, idx);
      if (a > P) return;
      if (P < a + s.size && (!containing || a > containing.address)) containing = { name: s.name, address: a };
      if (!best || a > best.address) best = { name: s.name, address: a };
    });
    return containing ?? best ?? { name: sec.name, address: base };
  }

  // ------------------------------------------------------------------ overlap / unsupported checks
  /**
   * ORG sections and VECTOR entries against placed sections and each other (CodeWarrior would otherwise write
   * overlapping blocks into the .abs and one would silently win in the S-records):
   *  - ORG vs placed section / ORG vs ORG: L1104 "Absolute object <first object> overlaps with segment <seg>";
   *  - VECTOR vs ORG / placed / VECTOR: L1119 "Vector allocated at absolute address .. overlaps with sections
   *    placed in segment <seg>" (the real CW example names `.absSeg2`).
   * UNCERTAIN: CodeWarrior may also reject ORG data inside a segment's unused part; ranges are not reserved, so a
   * placed section is never moved around an ORG block.
   */
  private checkOverlaps(objects: readonly LinkObject[]): void {
    const hit = (a: OutSection, b: OutSection) => a.address < b.address + b.size && b.address < a.address + a.size;
    const placed = this.allocOrder.filter((o) => (o.kind === 'placed' || o.kind === 'stack') && o.placed && o.size > 0);
    const orgName = (o: OutSection) =>
      byAddress(objects.filter((x) => x.out === o && x.binding !== 'linker'))[0]?.name ?? o.pieces[0]?.name ?? o.name;
    this.orgOuts.forEach((org, i) => {
      for (const p of placed) if (hit(org, p)) this.messages.push(LinkMessages.absOverlap(orgName(org), p.segment));
      for (const other of this.orgOuts.slice(i + 1)) if (hit(org, other)) this.messages.push(LinkMessages.absOverlap(orgName(other), org.segment));
    });
    this.vectorOuts.forEach((v, i) => {
      for (const o of [...this.orgOuts, ...placed, ...this.vectorOuts.slice(0, i)]) {
        if (hit(v, o)) this.messages.push(LinkMessages.vectorOverlap(v.address, o.segment));
      }
    });
  }

  /** Clone warnings for PRM features that are parsed but not implemented. */
  private checkUnsupported(): void {
    const W = LinkMessages.unsupported;
    const inputs = new Set(this.entries.map((e) => e.name.toLowerCase()));
    for (const n of this.prm.names) {
      const base = n.replace(/\+$/, '').replace(/^.*[\\/]/, '').toLowerCase();
      if (!inputs.has(base)) this.messages.push(W(`NAMES file ${n} is not linked (pass it as a link input)`));
    }
    for (const s of this.prm.segments) {
      if (s.fill) this.messages.push(W(`FILL of segment ${s.name} is ignored`, s.line));
      if (s.align) this.messages.push(W(`ALIGN of segment ${s.name} is ignored`, s.line));
      if (s.relocateTo !== undefined) this.messages.push(W(`RELOCATE_TO of segment ${s.name} is ignored`, s.line));
    }
    // DISTRIBUTE_INTO distributes single objects (functions) among the segments (manual, -OnB=b compiler output);
    // here a section is allocated as one block exactly like INTO. Only worth a warning when the statement places
    // something (the stock PRM's DISTRIBUTE / CONST_DISTRIBUTE / DATA_DISTRIBUTE are empty in assembly projects).
    for (const p of this.prm.placements) {
      if (!p.distribute) continue;
      const used = p.sections.map(canonicalSection).filter((n) => (this.outsByName.get(n)?.size ?? 0) > 0);
      if (used.length) this.messages.push(W(`DISTRIBUTE_INTO is allocated like INTO (no object distribution): ${used.join(', ')}`, p.line));
    }
    // `LINK <file>` needs no handling: `outputPath` is SmartLinker's -O option, which overrides the PRM's LINK
    // command (asm.md §8 "Optional under the IDE, which passes -O").
    if (this.prm.hexFile) this.messages.push(W(`HEXFILE ${this.prm.hexFile.file} is ignored`));
    if (this.prm.objectFile) this.messages.push(W(`OBJECTFILE ${this.prm.objectFile} is ignored`));
    for (const d of this.prm.dependencies) this.messages.push(W(`DEPENDENCY ${d.kind} is ignored`, d.line));
    if (this.prm.overlapGroups.length) this.messages.push(W('OVERLAP_GROUP is ignored'));
    for (const o of this.prm.other) if (!HARMLESS_COMMANDS.has(o.keyword)) this.messages.push(W(`${o.keyword} is ignored`, o.line));
    const sel = this.prm.mapFile.filter((k) => !/^(ALL|ON|NONE|OFF)$/i.test(k));
    if (sel.length && !this.prm.mapFile.some((k) => /^(NONE|OFF)$/i.test(k))) {
      this.messages.push(W(`MAPFILE ${sel.join(' ')}: section selection is not supported; the complete map is written`));
    }
  }

  // ------------------------------------------------------------------ relocation
  /**
   * `checkOverflow` is false for non-allocated (debug) sections: CodeWarrior encodes a 24-bit logical address there
   * as PAGE8 (page byte) + ABS16 (low 16 bits), and the ABS16 half just takes the low 16 bits.
   */
  private applyRelocs(sec: InSection, buf: Uint8Array, base: number, relocs: readonly ElfRela[], where: string, checkOverflow = true): void {
    // ABS16 halves of a far (24-bit) address: a PAGE8 to the same symbol right before (debug info, `pg hi lo`)
    // or right after (CALL `4A hi lo pg`) the 16-bit field.
    const page8 = new Set(relocs.filter((r) => relocKind(r) === 'PAGE8').map((r) => `${r.sym}:${r.offset}`));
    const farHalf = (r: ElfRela) => page8.has(`${r.sym}:${r.offset - 1}`) || page8.has(`${r.sym}:${r.offset + 2}`);
    for (const r of relocs) {
      const kind = relocKind(r);
      if (!kind) {
        this.messages.push(
          LinkMessages.unknownFixup(
            `Unknown fixup type ${r.type} (width ${r.rawAddend + 1}) at offset 0x${r.offset.toString(16).toUpperCase()} in ${where}`,
            moduleDisplayName(sec.mod),
          ),
        );
        continue;
      }
      const S = this.targetValue(sec.mod, r.sym);
      const P = base + r.offset;
      try {
        const A = inPlaceAddend(buf, r);
        // PCREL16 (LBRA/LBcc) is modulo 64K on the CPU12, so only absolute fields narrower than 32 bits can
        // overflow (ABS16 today; any future ABS8 the same way). PAGE8 takes bits 16-23 and never overflows.
        // UNCERTAIN: L1907 only for 16-bit fields NOT paired with a PAGE8 (JSR/JMP/vector words to banked code,
        // as in NXP forum reports of L1907); paired far-address halves and debug sections are never checked.
        const width = r.rawAddend + 1;
        const overflow = S + A < 0 || S + A > 2 ** width - 1;
        if (checkOverflow && kind.startsWith('ABS') && width < 32 && overflow && !farHalf(r)) {
          const user = this.objectAt(sec, P);
          this.messages.push(LinkMessages.fixup(user.name, this.targetName(sec, r.sym), r.type, P - user.address, moduleDisplayName(sec.mod)));
        }
        applyRelocation(buf, r, S, P);
      } catch (err) {
        this.messages.push(LinkMessages.unknownFixup(err instanceof Error ? err.message : String(err), moduleDisplayName(sec.mod)));
      }
    }
  }

  /** Contents of every PROGBITS output section with relocations applied. */
  private relocateAlloc(): Map<OutSection, Uint8Array> {
    const out = new Map<OutSection, Uint8Array>();
    for (const o of this.allocOrder) {
      if (o.data) {
        out.set(o, o.data);
        continue;
      }
      if (o.type === SHT_NOBITS) continue;
      const data = new Uint8Array(o.size);
      for (const sec of o.pieces) {
        if (sec.type === SHT_NOBITS) continue;
        const buf = sec.data.slice();
        this.applyRelocs(sec, buf, o.address + sec.offset, sec.relocs, sec.name);
        data.set(buf, sec.offset);
      }
      out.set(o, data);
    }
    return out;
  }

  private computeDebugBases(): void {
    for (const name of DEBUG_SECTION_ORDER) {
      let off = 0;
      for (const m of this.linkedModules()) {
        const idx = m.elf.sections.findIndex((s) => s.name === name);
        if (idx <= 0) continue;
        this.debugBase.set(`${m.order}:${idx}`, off);
        off += m.elf.sections[idx].data.length;
      }
    }
  }

  /** Debug sections: per-module pieces concatenated in link order, relocations applied (critique C13). */
  private buildDebug(linked: Module[]): { sections: Map<string, Uint8Array>; infoBase: Map<Module, number> } {
    const sections = new Map<string, Uint8Array>();
    const infoBase = new Map<Module, number>();
    for (const name of DEBUG_SECTION_ORDER) {
      const parts: Uint8Array[] = [];
      let off = 0;
      for (const m of linked) {
        const idx = m.elf.sections.findIndex((s) => s.name === name);
        if (idx <= 0) continue;
        const buf = m.elf.sections[idx].data.slice();
        const pseudo: InSection = {
          mod: m, index: idx, name, type: SHT_PROGBITS, flags: 0, size: buf.length, data: buf,
          isOrg: false, orgAddress: 0, relocs: [], kept: true, offset: 0,
        };
        this.applyRelocs(pseudo, buf, 0, m.relocsByTarget.get(idx) ?? [], name, false);
        if (name === '.debug_info') infoBase.set(m, off);
        parts.push(buf);
        off += buf.length;
      }
      const all = new Uint8Array(off);
      let p = 0;
      for (const b of parts) {
        all.set(b, p);
        p += b.length;
      }
      sections.set(name, all);
    }
    return { sections, infoBase };
  }

  /** .debug_aranges: one set per compile unit listing its linked allocatable pieces by address. */
  private aranges(linked: Module[], infoBase: Map<Module, number>) {
    return linked
      .filter((m) => infoBase.has(m))
      .map((m) => ({
        infoOffset: infoBase.get(m)!,
        addressSize: 4,
        segmentSize: 0,
        ranges: [...m.secs.values()]
          .filter((s) => s.kept && s.out && s.size > 0)
          .map((s) => ({ address: s.out!.address + s.offset, length: s.size }))
          .sort((a, b) => a.address - b.address),
      }));
  }

  // ------------------------------------------------------------------ objects (map / symtab)
  private buildObjects(): LinkObject[] {
    const objects: LinkObject[] = [];
    const byKey = new Map<string, LinkObject>();
    const bySection = new Map<InSection, LinkObject[]>();
    const linked = this.linkedModules();
    for (const m of linked) {
      m.syms.forEach((s, idx) => {
        if (!isObjectSymbol(s)) return;
        let sec: InSection | undefined;
        let isOrgAbs = false;
        if (s.shndx === SHN_ABS) {
          sec = [...m.secs.values()].find((x) => x.isOrg && x.kept && x.out && s.value >= x.orgAddress && s.value < x.orgAddress + x.size);
          // UNCERTAIN: absolute symbols outside every ORG section (EQU-like XDEFs) are not listed.
          if (!sec) return;
          isOrgAbs = true;
        } else {
          sec = m.secs.get(s.shndx);
          if (!sec?.kept || !sec.out) return;
        }
        const o: LinkObject = {
          name: s.name,
          address: this.symAddress(m, idx),
          size: s.size,
          kind: s.type === STT_FUNC ? 'procedure' : s.type === STT_OBJECT ? 'variable' : 'label',
          binding: s.bind === STB_LOCAL ? 'local' : 'global',
          mod: m,
          symIdx: idx,
          elfType: s.type,
          sec,
          out: sec.out,
          isOrgAbs,
          mapSection: sec.isOrg ? '.text' : sec.out!.name,
          rank: m.order * 0x100000 + idx,
          secOrder: sec.index,
          refs: 0,
          uses: [],
        };
        objects.push(o);
        byKey.set(`${m.order}:${idx}`, o);
        const list = bySection.get(sec) ?? [];
        list.push(o);
        bySection.set(sec, list);
      });
    }

    // Ref counts and USES lists from the relocations of linked (non-debug) sections.
    const labels = new Map<string, LinkObject>();
    for (const m of linked) {
      for (const sec of m.secs.values()) {
        if (!sec.kept || !sec.out) continue;
        const inSec = bySection.get(sec) ?? [];
        const base = sec.out.address + sec.offset;
        for (const r of sec.relocs) {
          const t = this.target(m, r.sym);
          let obj: LinkObject | undefined;
          if (t?.kind === 'sym') obj = byKey.get(`${t.mod.order}:${t.idx}`);
          else if (t?.kind === 'linker') {
            obj = labels.get(t.name);
            if (!obj) {
              obj = {
                name: t.name, address: this.linkerValues.get(t.name) ?? 0, size: 0, kind: 'label', binding: 'linker',
                mod: m, symIdx: -1, elfType: 0, isOrgAbs: false, mapSection: '', rank: m.order * 0x100000 + 0xfffff,
                secOrder: Number.MAX_SAFE_INTEGER, refs: 0, uses: [],
              };
              labels.set(t.name, obj);
              objects.push(obj);
            }
          }
          if (!obj) continue;
          obj.refs++;
          const P = base + r.offset;
          for (const user of inSec) {
            if (P >= user.address && P < user.address + user.size && !user.uses.includes(obj)) user.uses.push(obj);
          }
        }
      }
    }
    return objects;
  }

  /** Map DEPENDENCY TREE roots: "main and _Startup Group" (MAIN, INIT), then each ORG section. */
  private treeGroups(objects: LinkObject[]): TreeGroup[] {
    const find = (name: string) => {
      const g = this.globals.get(name);
      return g ? objects.find((o) => o.mod === g.mod && o.symIdx === g.idx) : undefined;
    };
    const groups: TreeGroup[] = [];
    const first: LinkObject[] = [];
    const main = find(this.prm.main ?? 'main');
    if (main) first.push(main);
    const init = this.init ? objects.find((o) => o.mod === this.init!.mod && o.symIdx === this.init!.idx) : undefined;
    if (init) first.push(init);
    // UNCERTAIN: group title is fixed text in every sample ("main and _Startup Group").
    groups.push({ title: 'main and _Startup Group', children: first });
    for (const out of this.orgOuts) {
      const sec = out.pieces[0];
      const users = objects.filter((o) => o.sec === sec);
      const children: LinkObject[] = [];
      for (const u of users) for (const c of u.uses) if (c.kind === 'procedure' && !children.includes(c)) children.push(c);
      groups.push({ title: sec.name, children, pad: true });
    }
    // UNCERTAIN: VECTOR command targets are not shown in the tree (no sample).
    return groups;
  }

  private sectionUseOrder(): string[] {
    const order: string[] = [...DEFAULT_SECTION_ORDER];
    for (const n of this.placementNames) if (!order.includes(n)) order.push(n);
    for (const o of this.allocOrder) if (!order.includes(o.name)) order.push(o.name);
    return order;
  }

  // ------------------------------------------------------------------ results
  private entryAddress(): number {
    return this.init ? this.symAddress(this.init.mod, this.init.idx) : 0;
  }

  private noteMeta(): NoteMeta {
    const meta = this.input.noteMeta ?? {};
    return {
      user: meta.user ?? 'user',
      created: meta.created ?? `${ctime(this.input.options?.now ?? new Date())}\n`,
      commandLine: meta.commandLine ?? linkerCommandLine(this.entries.map((e) => e.path ?? e.name), this.input.outputPath),
    };
  }

  private layout(objects: LinkObject[], linked: Module[]): LinkLayout {
    return {
      sections: this.allocOrder.map((o) => ({
        name: o.name,
        kind: o.kind,
        segment: o.segment,
        address: o.address,
        size: o.size,
        type: o.type,
        flags: o.flags,
        access: sectionAccess(o),
        pieces: o.pieces.map((p) => ({
          module: p.mod.name,
          library: p.mod.library,
          section: p.name,
          offset: p.offset,
          address: o.address + p.offset,
          size: p.size,
        })),
      })),
      symbols: byAddress(objects).map((o) => ({
        name: o.name,
        address: o.address,
        size: o.size,
        kind: o.kind,
        binding: o.binding,
        module: o.mod.name,
        library: o.mod.library,
        section: o.mapSection,
        refs: o.refs,
      })),
      modules: linked.map((m) => ({ name: m.name, library: m.library })),
      entry: this.init ? { name: this.init.name, address: this.entryAddress() } : undefined,
    };
  }
}

