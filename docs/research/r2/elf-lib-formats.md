# CodeWarrior HC12 (S12X) object formats, reverse-engineered from Lab3

I relinked the library members the map pulls in plus `main.asm.o` at the `Project.map` addresses, using the rules below. The result is byte-identical to `bin/Project.abs`, for every loadable section and for `.debug_info`, `.debug_line`, `.debug_abbrev` and `.debug_frame`.

Every S19 byte is also reproduced. The catch is that **the golden `.s19` does not contain the library code in EEPROM at all.** Only the `.abs` does (see §6).

All analysis was read-only Python over stdin plus readelf/xxd. No files were written.

---

## 1. Library container (`.lib`, as written by the HIWARE librarian)

The full analysis of the course library file (its header strings, member list and member offsets) is in the
private notes (`s12studio-fixtures`: `research/elf-lib-formats.md` §1). The container format itself:

### 1.1 Header (offset 0)
| Off | Bytes | Meaning |
|---|---|---|
| 0x00 | `FE 82 0A 8C` | magic |
| 0x04 | u32 BE | `0` in the sample; flags or reserved? **UNCERTAIN** |
| 0x08 | u32 BE | equals the length of the library file name in the sample; may be a version number. **UNCERTAIN** |
| 0x0C | 5 NUL-terminated strings | library file name, user login, librarian build date, creation time (ctime text with a trailing `\n`), `""` (empty) |
| after the strings | — | first member's ELF starts here, with no padding |

### 1.2 Members
- Members are raw ELF32 relocatable objects, stored back to back with no padding and no per-member header. Each one's
  length equals `e_shoff + e_shnum*40` exactly.

### 1.3 Directory (at the end of the file)
- The last 4 bytes are a u32 BE, the directory size **including these 4 bytes**. The directory starts at
  `filesize − size`, which is also the end of the last member.
- Layout: a lead byte (`0x42` in the sample; the same value appears in note type 10, meaning unknown) → `varint count`
  → `count ×` entries → u32 size trailer.
- Each entry is `name\0`, `varint start`, `varint end` (e.g. `"<module>.asm.o"`, start, end).
- **varint encoding**: 7-bit groups, least significant first. The **last** byte has bit 7 set; continuation bytes have
  it clear (the opposite of LEB128). Example: `3B 6A 81` = 0x3B | 0x6A<<7 | 1<<14 = 0x753B.
- There is no global symbol index. To resolve a symbol, the linker has to scan each member's `.symtab`.

**Writing a .lib is optional.** We only need to read them, which takes about 60 lines of TypeScript.

---

## 2. HIWARE ELF object dialect (`.o`, and the members inside the lib)

### 2.1 ELF header
- ELF32, big-endian, `e_machine = 0x35` (EM_68HC12), `e_type = REL`, `e_flags = 0`, `e_entry = 0`, `e_phnum = 0`.
- Quirk: `e_phoff` equals the file size, so it points just past the section header table. readelf warns about this.
- File layout: ELF header, then section bodies (each file offset aligned to 4, while `sh_addralign` is 1), then the section header table, then the empty phdr area. `.shstrtab` is the last section.

### 2.2 Section set (main.asm.o)
`.symtab`, `.strtab`, `.debug_info`, `.debug_abbrev`, `.debug_loc` (empty), `.debug_line`, `.debug_frame`, `_SEC000000` (NOBITS, size 0: the default unnamed section), then the user `SECTION`s:
- `DEFAULT_RAM`: NOBITS, WA.
- `MyCode`: PROGBITS, AX.
- One PROGBITS section per `ORG` block, named `_ORG00001`, `_ORG00002`, …, with flags `A` and **`sh_addr` set to the absolute address** (0xFFFE, 0xFFCE).

These are followed by `.rela.<target>` for each section that has relocations (`sh_link` = symtab, `sh_info` = target), then `.note`, then `.shstrtab`. Library code sections are named `Lib_Xxx`; library data goes in `LIBRARY_RAM` (NOBITS).

### 2.3 Symbols (standard `Elf32_Sym`, `sh_info` = first global)
- Order: null, one SECTION symbol per section from `.debug_info` onward, a FILE symbol `"main.dbg"` (shndx ABS), locals, defined globals (from XDEF), then **every XREF as GLOBAL UND, in declaration order, even if unused**.
- Code labels are `STT_FUNC`. Their size is the distance to the next label in the same section, or to the section end.
- `DS` labels are `STT_OBJECT` with size equal to the DS size.
- Anonymous `ORG` data gets symbols `VAR00001`, `VAR00002`: LOCAL OBJECT, shndx ABS, value = absolute address.
- EQUs are **not** emitted in main.o.
- Objects assembled with the stock `mc9s12xdp512.inc` can carry many symbols with **st_type 13** (processor-specific) whose `st_shndx` is a *symbol index* that points at an undefined marker symbol. These are aliases created by deprecated-name EQUs in the `.inc`. The linker can ignore them unless a relocation references one (none did in the golden projects).

### 2.4 Relocations: non-GNU, REL-style addends stored in the section bytes
Entries are standard `Elf32_Rela`: `r_info = sym<<8 | type`. Readelf labels them with GNU m68hc11 names (R_M68HC11_8/16), which is **wrong for these files**.

**`r_addend` is not an addend.** It holds the field width minus 1: 0x07 = 8 bits, 0x0F = 16 bits, 0x1F = 32 bits. **The real addend is the value already stored at `r_offset`** (big-endian).

| type | addend | where seen | semantics (verified by relinking) |
|---|---|---|---|
| 1 | 0x0F | 747 in code, plus vectors | `field16 = S + A_inplace`. Used for extended/immediate addresses (e.g. `79 xx xx` clr, `16 xx xx` jsr, `CD 00 01` = `ldy #<sym>+1` with in-place 1, `79 00 04` = `clr <sym>+4`) |
| 1 | 0x0F / 0x1F | debug | 16-bit low part of an address; 32-bit section offsets (`abbrev_offset`, `stmt_list`) against SECTION symbols |
| 3 | 0x0F | 1, in the library | **PC-relative 16-bit**: `field = S + A − P`, where P = address of the field. An `LBRA` lists as `18 20 FF FE`, in-place A = −2 |
| 5 | 0x07 | debug only (always paired with type 1 at offset+1) | 8-bit **page byte** = `(S + A) >> 16`. Every value here was 0. Ambiguous for paged code. **UNCERTAIN** |

Not observed in these samples: 8-bit PC-relative (cross-section `BRA`/`DBNE`), direct-page 8-bit, `CALL` page byte, and XGATE. Branches inside one section are resolved by the assembler and get no relocation. Relocations reference the **named label symbol** even for locals (main) or a section symbol (debug).

Mapping to `main.lst`: each `xx xx` in the listing corresponds to one type-1/0x0F relocation at `Loc+1`. Exceptions: `movb #imm,ext` (`18 0B ii hh ll`) relocates at `Loc+3`, and `DC.W` vector entries (`a00FFFE xxxx`) at offset 0 of the `_ORG` section. Relocations in `.rela.debug_info` are stored in descending offset order.

### 2.5 `.note` (non-standard packing)
- Records are `{u32 namesz=10, u32 descsz, u32 type, "HIWARE AG\0" (10 bytes, **unpadded**), desc (**unpadded**)}`, packed with no 4-byte alignment. readelf misparses them.
- Types:
  - 1: producer string (`"Assembler for HC12 V-5.0.30 Build 10203, Jul 23 2010"`)
  - 2: u32 version (0x13A6 = 5030; the linker writes 0x13B0 = 5040)
  - 3: build date
  - 4: `00 35 00 73` (0x35 is EM_68HC12; 0x73 unknown)
  - 5: user
  - 6: 1 byte, 0
  - 7: ctime with `\n`
  - 8: `'A'` (assembler)
  - 9: command line (truncated at about 1024 bytes)
  - 10: u32 0x42
- Readers can ignore all of this. A writer would copy it.

---

## 3. DWARF 2 as emitted for assembly
- **CU header**: version 2, address_size 4. `abbrev_offset` and `stmt_list` are type-1 32-bit relocations against section symbols.
- **Abbrev codes are 128–133** (two-byte ULEB):
  - 128 `compile_unit`: name `"<module>.dbg"`, producer `"Freescale"`, comp_dir = the project `bin` dir, **language udata 0x41** (vendor value), stmt_list data4.
  - 129 `base_type`: `"unsigned char"` enc 8 size 1, `"int"` enc 5 size 2, `"long"` enc 5 size 4. These are used for DS.B / DS.W / DS.L.
  - 130 `subprogram` (no children): low_pc addr, high_pc addr, external flag, name. One per code label. In-place values are 0 and the size; both get page+16 relocations against the label symbol.
  - 131 `variable`: `location` block2 = `03 <4-byte addr>` (DW_OP_addr), name, type ref4, external flag.
  - 132 `array_type` (bit_stride 8) with 133 `subrange` (lower 0, upper n−1) for `DS.B n`.
- **Every address field is 4 bytes**: `[00][page: type 5][addr16: type 1]`.
- **.debug_line**: min_inst 1, default_is_stmt 1, line_base 0, line_range 4, opcode_base 10. There is no directory table. There is one file entry: the **absolute path of `bin\<module>.dbg`**. One `DW_LNE_set_address` per code section (relocated at +1 page / +2 addr16), special opcodes per instruction, and `end_sequence`. ORG'd vector sections have no line rows.
- **Line numbers are the "Abs." column of the listing**, i.e. line numbers in the `.dbg` file. `bin/main.dbg` is a copy of the source with INCLUDEs expanded (identical to main.asm here; only a final CRLF differs). **This is how hiwave shows source: it opens the `.dbg`, not the `.asm`.**
- The library CUs point at `C:\Users\<instructor>\...\bin\Lib_*.dbg`, which do not exist on student machines, so library code is disassembly-only.
- **.debug_frame**: one CIE per CU (0x53 bytes), RA column 32, CFA = r15. Copy it verbatim.

---

## 4. Linked `bin/Project.abs`
- ELF EXEC, `e_entry = 0xC000` (the INIT symbol `Entry`).
- Sections are sorted by address:
  - the library code sections in EEPROM from 0x800 (addresses in the private notes, s12studio-fixtures research/elf-lib-formats.md §4)
  - LIBRARY_RAM 0x1000 (NOBITS)
  - `.stack` 0x2000 (0x400, NOBITS), `.data` 0x2400 (= DEFAULT_RAM)
  - MyCode 0x4000, `.init` 0xC000
  - `main.asm__ORG00002` 0xFFCE, `main.asm__ORG00001` 0xFFFE

  These are followed by .symtab/.strtab, the debug sections, an empty `.debug_pubnames`, `.debug_aranges` (generated), .note (linker version) and .shstrtab. Sections are 4-aligned in the file, then come the shdrs, then **phdrs at the end of the file**.
- **Program headers**: one PT_LOAD per allocated section (contiguous `.stack` and `.data` are merged into one), `p_paddr = 0`, align 0, plus one PT_NOTE. The map's "blocks to be downloaded: 8" equals the number of LOAD segments with filesz > 0.
- **Section naming rules seen**:
  - `DEFAULT_RAM` → `.data`
  - `SSTACK` → `.stack` (the linker synthesizes `__SEG_END_SSTACK = 0x2400`)
  - ORG sections → `<module>__ORGnnnnn` (segment `.absSeg0/1`; the map lists their objects under `.text`)
  - **Lib_Startup's section became `.init` and went into ROM_C000 even though the PRM says `Lib_Startup INTO EEPROM`.** The blank project shows the same behaviour. My hypothesis is that the section containing the `INIT` symbol is moved into `_PRESTART`, which is an alias of `.init` ([NXP forum](https://community.nxp.com/thread/474375)). **UNCERTAIN**, but the golden output fixes the behaviour we must copy.
- **Debug sections are plain concatenations of each module's section in FILE-SECTION order** (the library modules alphabetically, then main), with relocations applied. Section-symbol relocations resolve to the module's offset within the concatenation. All four match byte for byte. `.debug_aranges` is one set per CU listing that CU's alloc sections (address, length).
- **Symtab**: grouped per section (SECTION symbol, FILE `"<mod>.dbg"`, locals), then globals. EQUs and UND symbols are dropped.
- **Smart linking happens at section level**: a member is pulled in only if a *relocation* references one of its globals. A bare XREF does not count: routines that are XREF'd but never called do not pull their member in. Whole sections are kept even when a procedure has Ref 0.

### 4.1 Cross-check algorithm (passes 100%)
```
base = map section addresses; LIBRARY_RAM concatenated in member order from 0x1000
S = UND ? global[name] : ABS ? st_value : base[module, section] + st_value
w = (r_addend + 1) / 8;  A = BE(field) (signed for type 3)
type1: S+A   type3: S+A-(secbase+r_offset)   type5: (S+A)>>16
```

---

## 5. Other files
- **`main.dbg`**: the source after INCLUDE expansion, with CRLF line endings. This is the file DWARF refers to. Our assembler should write it too if we want hiwave compatibility.
- **`Project.abs.s19`** (written by the burner from `prm/burner.bbl`, `SRECORD=Sx`, CRLF):
  - S0: address 0000, data = ASCII absolute path of the `.abs`, no NUL.
  - Data records: S1 with **32 data bytes** each (count 0x23), one run per contiguous block, in ascending address order.
  - Terminator: **`S9030000FC`**. The address is 0000, not the entry point.
- **`Project.abs.glo`**: the same data as S2 records at global addresses (0x7F4000, 0x7FC000, 0x7FFFCE …), still terminated by **S9** (not S8).
- **The burner only exports the 0x4000–0x7FFF and 0xC000–0xFFFF windows and paged flash.** There is no EEPROM range, so the library in EEPROM (from 0x0800) is not in either file.

---

## 6. Assessment and recommendations

**Read side (required):**
| Item | Effort |
|---|---|
| .lib reader (header, directory, varint, member slicing) | 0.5 day |
| ELF32-BE object reader (shdrs, symtab, rela, the type-13 aliases) | 1 day |
| Relocation engine (types 1, 3, 5 with width-from-addend) plus error on unknown types | 0.5 day |
| PRM-subset parser (SEGMENTS, PLACEMENT, STACKSIZE, INIT, ENTRIES) plus the placement rules above, including the INIT→`.init` quirk and smart linking | 2–3 days |
| Golden test: reproduce Project.abs sections and the S19 for Lab3 and blank_project | 0.5 day (already proven in Python) |

**Write side (choices):**
- **Recommended: internal object format.** Our own assembler emits an in-memory or JSON object (sections, symbols, fixups with explicit kinds: ABS16, PCREL8/9/16, PAGE8, …). The linker accepts both those objects and CW ELF members. This avoids encoding fixups we haven't seen, such as 8-bit PC-relative.
- **Outputs:**
  - **S19** matching the golden format: 32 bytes per record, S0 = path, S9 0000.
  - An **image that includes the EEPROM ranges**. Either use our own download format or an S19 with an "include EEPROM" option; the golden S19 alone would leave the library out.
  - **Optional ELF `.abs`**, 3–5 days with DWARF lines, for interoperability with real hiwave/P&E. The layout in §4 is simple and fully characterised.
  - Our own debugger can use an internal line map: address → (file, line), using Rel. lines directly, so there is no need for `.dbg`.
- Writing CW-dialect `.o` files is easy, about 1–2 days given this spec, but has little value unless users mix our tools with real CodeWarrior.

**Overall: about 1.5 weeks** for read, link, S19/abs output and golden tests, plus about 1 week for an optional DWARF-emitting `.abs` writer.

---

## Key risks / open questions
1. **The library lives in EEPROM (from 0x0800) and is absent from the S19.** Our flasher must program the S12XD EEPROM through its own command set and window mapping: 0x0800–0x0BFF via EPAGE (reset value 0xFE), 0x0C00–0x0FFF fixed. The exact global mapping is **UNCERTAIN**. If we flash from S19 only, the board crashes on its first `jsr` into the library. We also need to decide whether to skip re-programming unchanged EEPROM.
2. **The `.init` rule** for the section containing `INIT` is inferred from two samples. Another possibility is that SmartLinker treats a module's section specially through the note or symbol flags.
3. **Relocation coverage is incomplete**: only types 1/3/5 with widths 8/16/32 were seen. Paged `CALL`/`PAGE()` and `LOW`/`HIGH` operators, 8-bit PC-relative, and the type-5 semantics with a non-zero page are unverified. Linking a library rebuilt with paged code could break silently, so reject unknown (type, addend) pairs.
4. **Unknown header fields**: lib header words (0, 0x10), the directory lead byte 0x42, and note types 4 and 10. These don't matter for reading; they matter only if we write .lib files.
5. **Debug source for the library** points at nonexistent `C:\Users\<instructor>\...\Lib_*.dbg` paths, so library code can only be debugged as disassembly. We could ship pretty-printed disassembly with symbols from the member symtab.
6. **S19 record-splitting alignment** (32 bytes from block start vs absolute 32-byte boundaries) can't be told apart because every block starts aligned. Our output will be correct either way, but may not be byte-identical in edge cases.
7. **Smart-link "referenced" semantics** at symbol vs section granularity were only checked for asm. They match the maps for both Lab3 and blank_project.

Sources:
- [GNU binutils include/elf/m68hc11.h](https://gnu.googlesource.com/binutils-gdb/+/cr-0x5f1/include/elf/m68hc11.h): GNU relocation numbering, which is why readelf's type names don't apply here.
- [NXP community thread](https://community.nxp.com/thread/474375): `_PRESTART` is an alias of `.init`; SSTACK/ROM_VAR aliases.
- [NXP CodeWarrior build tools reference (CWMCUBTURM.pdf)](https://www.nxp.jp/docs/en/reference-manual/CWMCUBTURM.pdf): SmartLinker PRM reference (only the table of contents was retrieved).
- [FreeRTOS HCS12 CodeWarrior PRM example](https://dev.begriffs.com/freertos/blob/dbf2ff140073fa49dfc830dfc221f7e7aa511cd2:/Demo/HCS12_CodeWarrior_small/CODE/RTOSDemo.PRM)

Files analysed (in the private fixtures, `fixtures/Lab3` and `fixtures/blank_project`):
- `Sources/Libraries/ME305LibV4.0.lib`
- `Lab3_Data/Standard/ObjectCode/main.asm.o`
- `bin/Project.abs`, `Project.abs.s19`, `Project.abs.glo`, `Project.map`, `main.lst`, `main.dbg`
- `prm/Project.prm`, `prm/burner.bbl`
- `blank_project/bin/Project.map`