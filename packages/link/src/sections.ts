// Section-name conventions of SmartLinker (docs/research/r1/asm.md §8, r2/elf-lib-formats.md §4).

/** Freescale predefined section name -> ELF name. Both spellings may appear in PLACEMENT and in objects. */
export const SECTION_ALIASES: Readonly<Record<string, string>> = {
  DEFAULT_ROM: '.text',
  DEFAULT_RAM: '.data',
  SSTACK: '.stack',
  ROM_VAR: '.rodata',
  STRINGS: '.rodata1',
  COPY: '.copy',
  STARTUP: '.startData',
  _PRESTART: '.init',
};

/** Canonical (ELF) output name of a section / placement name. */
export const canonicalSection = (name: string): string => SECTION_ALIASES[name] ?? name;

/**
 * Order in which the map's "SECTION USE IN OBJECT-ALLOCATION" lists sections: the two default sections first, then
 * every other section in PLACEMENT order. Derived from both golden maps (".text", ".data", ".init", "LIBRARY_RAM",
 * "MyCode", ...). UNCERTAIN: modelled as SmartLinker's internal section list (defaults created first).
 */
export const DEFAULT_SECTION_ORDER = ['.text', '.data'] as const;

/** Linker-defined segment symbols: __SEG_START_x, __SEG_END_x (first byte after), __SEG_SIZE_x. */
export const SEG_SYMBOL = /^__SEG_(START|END|SIZE)_(.+)$/;
