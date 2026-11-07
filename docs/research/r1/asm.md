# CodeWarrior HC(S)12 v5.x build tools: ahc12 assembler, SmartLinker (linker.exe) and Burner, research notes for the clone

Method: I downloaded the primary manuals and extracted their text myself; the claims below summarise or paraphrase that Freescale/Metrowerks documentation (with short cited excerpts only where the exact syntax matters). Anything marked **UNCERTAIN** comes from my own recall and should be checked against a real CW 5.1 install. I created no project files.

---

## 0. Primary-source manuals

| Doc | What it covers | URL |
|---|---|---|
| **HC(S)12 Assembler Manual**, rev. 9 Feb 2006 (FrameMaker "assemble.book"; same content as the installed `Assembler_HC12.pdf`) | Syntax, directives, macros, listing format, wizard walkthrough, options. **No message list.** | https://my.eng.utah.edu/~cs5780/doc/CW_Assembler_HC12_RM.pdf |
| **S12(X) Assembler Manual**, rev. 27 Feb 2009 (newer revision; I did not extract its text) | Same, newer | https://www.secs.oakland.edu/~llamocca/Courses/ECE470/Lab/CodeWarrior_Assembler_HC12_Manual.pdf |
| **Metrowerks HC12 Assembler Manual**, 2003 (modified 2005) | **Contains the full "Assembler Messages" chapter (A1…A12704)** | https://www.nxp.com/docs/en/reference-manual/HC12ASMRM.pdf |
| **HC(S)08/RS08 and HC(S)12 Build Tools Utilities Manual**, rev. 16 Mar 2007 | SmartLinker, PRM syntax, map file, Burner, Decoder, Libmaker, Maker | https://my.eng.utah.edu/~cs5780/doc/CWMCUBTURM.pdf |
| **S12(X) Build Tools Utilities Manual**, rev. 2 Mar 2009 | Same family, newer | https://www.nxp.jp/docs/en/reference-manual/CWMCUBTURM.pdf |
| **CW MCU V10.x HC(S)08/RS08 Build Tools Utilities**, 2014 | **Contains the full SmartLinker message list (L1…L2079)**. The linker core is shared across targets. | https://www.nxp.com/docs/en/reference-manual/Build_Tools_Utilities.pdf |

- Installed copies live in `C:\Freescale\CWS12v5.1\Help\PDF\` (`Assembler_HC12.pdf`, `Build_Tools_Utilities.pdf`, `Compiler_HC12.pdf`), according to an NXP forum answer.
- Tool executables are in `<CW>\prog\`: `ahc12.exe` (assembler), `linker.exe` (SmartLinker), `burner.exe`, `hiwave.exe` (simulator/debugger), `decoder.exe`, `libmaker.exe`, `maker.exe`, `piper.exe`.
- Derivative includes are in `{Compiler}\lib\hc12c\include` (e.g. `mc9s12dg256.inc`).

Real wizard-generated Dragon12/DG256 project files, the best ground truth I found:
- Absolute-asm project: https://github.com/billhhh/hcs12_dragon12_asm. It contains `Sources/main.asm`, `Sources/derivative.inc`, `prm/burner.bbl`, `Full_Chip_Simulation.ini`, `HCS12_Serial_Monitor.ini`, `cmd/*.cmd` and `Project.mcp`.
- DG256B wizard project (C language, but the PRM, map and s19 formats are identical): https://github.com/semakse/CSE334-Microprocessors, under `SimpleBodyMassIndexCalculator/Project_1/`. It contains `prm/Project.prm`, `prm/HCS12_Serial_Monitor.prm`, `prm/burner.bbl`, `bin/Project.map`, `bin/Project.abs.s19` and `bin/Project.abs.phy`.

---

## 1. Source line syntax (ahc12)

**Fields.** Each line is: label, operation, operand(s), comment. Directives and mnemonics are case-insensitive. Symbols are case-sensitive unless `-Ci` is given.

**Labels**
- Allowed characters: letters, digits, `_` and `.`. The first character must not be a digit.
- Normally a label is followed by `:`. The manual says: "For compatibility with other macro assembler vendors, an identifier starting on column 1 is considered to be a label, even when it is not terminated by a colon."
  - Real wizard code depends on this: `Counter ds.w 1`, `ROMStart EQU $4000`, `HERE JMP HERE`.
  - With `-MCUasm`, a colon is mandatory (A1601).
- A label with a colon may be indented. Real code puts labels like `Entry:` on their own line.
- `EQU`/`SET` require a label. A label on any other line takes the current location counter value.
- Avoid labels that start with `_`, because macro expansion generates `_nnnnn` names. Avoid labels that end in `.B` or `.W`, because those are force-size suffixes.

**Operation field.** It "must not begin in the first column". A non-label character in column 1 gives **A1604** "Invalid character detected at the beginning of the line" (everything in column 1 is assumed to be a label).

**Comments**
- `;` starts a comment anywhere on a line.
- A line whose first character is `*` is a full-line comment (listed under MASM compatibility, but always active). Real lab code uses `****` banner lines.
- An empty line counts as a comment line.
- A trailing comment that starts with `*`, or with nothing at all, is only legal with **`-Compat=c`**. That option makes "comments implicitly start when a space is present after the argument list", and it warns (A1060) if such a comment doesn't start with `;` or `*`.
  - Without `-Compat=c`, `DC.B 1 + 1 , 1` is four bytes: 2, 1, 2, 1. Spaces inside operands are allowed.

**Operands.** Separated by commas.

**Location counter.** `*` is the location counter at the start of the current instruction/directive, even with several arguments. Examples: `DC.W 1,2,*-2` and `BRA *-2`.

**Limits** (manual, "Translation limits"):
- Maximum line length 1023 characters. A macro call is limited to one line of 1024 characters.
- INCLUDE nesting up to 50.
- No floating-point constants. No "complex relocatable" expressions.

**Reserved symbols:** `A B CCR D X Y SP PC PCR TEMP1 TEMP2`, plus `HIGH`, `LOW` and `PAGE`.

## 2. Constants

| Form | Syntax |
|---|---|
| Decimal | `512` (default base) |
| Hex | `$1F` |
| Octal | `@17` |
| Binary | `%1010` |
| MASM-style suffixes (always accepted; Appendix C) | `512d` / `512D`, `200h` / `200H`, `1000o` / `O` / `q` / `Q`, `101b` / `B` |
| Strings | `'ABCD'` or `"ABCD"`. Double quotes are only allowed inside single-quoted strings, and vice versa. **No escape sequences.** |

- `BASE n` (2/8/10/16) changes the default radix. The operand itself may carry a prefix: `BASE $a` and `BASE @12` both mean decimal. Once the base isn't decimal, decimal values can't be written at all, since decimal has no prefix.
- Gotcha that comes from the suffix forms: in base 16, `45D` is decimal 45, so hex values ending in D need `$`.
- Gotcha for the clone's tokenizer: tokens like `10b` and `0FFh` must parse as numbers.

## 3. Expressions and operators

Operators: `+ -` (binary and unary), `* / %`, `<< >>`, `& | ^`, `~` (one's complement), `!` (logical NOT), and relationals `= == != <> < <= > >=` (these return 1 or 0). There is no `&&` or `||`.

**Precedence** (Table 7.3, "follows ANSI-C"), highest first:
1. `()`
2. unary `~ + -`
3. `* / %`
4. `+ -`
5. `<< >>`
6. `< <= > >=`
7. `= == != <>`
8. `&`
9. `^`
10. `|`

Binary operators associate left to right.
- **UNCERTAIN:** where unary `!` sits. Treat it like unary `~`.
- Arithmetic is 32-bit (`~$C` = `$FFFFFFF3`). Results are truncated to the field size with a warning (A1057, A2328, A12003/12004).

**HIGH / LOW / PAGE.** Function-like syntax: `HIGH(expr)` gives bits 8–15, `LOW(expr)` gives bits 0–7, `PAGE(expr)` gives bits 16–23 of a 24-bit address.
- Example: `data1` at `$28050` → `PAGE(data1) = $2`.
- `#HIGH(x)` is immediate. Plain `HIGH(x)` is a direct/extended memory operand.
- Not allowed on initialized RAM: A1405, A1406, A1407.

**Force-size operators**
- `<expr` or `expr.B` forces 8-bit (direct, or 8-bit immediate/indexed).
- `>expr` or `expr.W` forces 16-bit (extended).

**Expression types.** Each expression evaluates to absolute, simple relocatable (`reloc ± abs`), or complex (rejected with A2401).
- `reloc - reloc` in the same section and file is absolute.
- `reloc + reloc` is complex.
- `*`, `/`, `%`, shifts and bitwise operators require absolute operands.
- Full truth tables are in Tables 7.4 and 7.5.

**MASM operator aliases** (Appendix C): `!<` shl, `!>` shr, `!.` AND, `!+` OR, `!x`/`!X` XOR.

**`-Compat` sub-options**
- `-Compat=!` adds `!^ !m !@ !g !% !t !$ !S !& !l !n !w !h`.
- `-Compat==` makes `!=` mean *equal* (warns A1059).
- `-Compat=s` accepts the `pgz:` and `byte:` symbol prefixes.
- `-Compat=$` allows `$` at the start of identifiers.
- `-Compat=a` adds `SECT`.
- `-Compat=b` enables `FOR`.

## 4. Addressing-mode syntax (operand field)

| Mode | Syntax |
|---|---|
| Inherent | no operand |
| Immediate | `#expr`. Size is implied by the instruction. |
| Direct | addr < $100 |
| Extended | 16-bit address |
| Relative | `label` or `*±n`. Short branch range −128..127, long branch range ±32 K. |
| Indexed, 5-, 9- or 16-bit offset | `n,X\|Y\|SP\|PC\|PCR` |
| Indexed indirect | `[n,xysp]` |
| Pre/post increment/decrement | `n,-X`, `n,+X`, `n,X-`, `n,X+` (n = 1..8, else A12005) |
| Accumulator offset | `A\|B\|D,xysp` |
| Accumulator-D indirect | `[D,xysp]` |
| PC-relative | `label,PCR`. The assembler computes the offset. `n,PC` inserts n literally. |

- EQU/SET labels are not allowed with PCR (A1410).
- `SECTION SHORT` and `XREF.B`/`XREFB` let the assembler use direct mode on relocatable symbols. Otherwise relocatable or external symbols get extended mode.
- **UNCERTAIN:** how forward references to absolute addresses below $100 are encoded. The assembler probably commits to extended mode. This matters for byte-exact output.
- **UNCERTAIN:** the exact `-CpDirect` default for HCS12. Treat the direct page as $0000–$00FF.

## 5. Directives (exhaustive, from Ch. 8 plus Appendices C/D/E)

**Sections**
- `ORG expr` creates an *absolute* section. The listing shows Loc as `a004000`.
- `name: SECTION [SHORT] [number]` creates a relocatable section.
  - A section is a code section if it has any instruction, a constant section if it has only DC/DCB, and a data section if it has any DS or is empty.
  - Re-opening a section with the same name continues where it left off.
- `OFFSET expr` creates an offset (struct) section. Any location-affecting statement other than EVEN/LONGEVEN/ALIGN/DS ends it.

**Constants**
- `label: EQU expr`. No redefinition. No forward references.
- `label: SET expr`. Redefinable. Absolute only, unless `-MCUasm`.

**Data**
- `[label:] DC[.B|.W|.L] expr{,expr}`. Default size is B.
  - Synonyms: `DCW` (=DC.W), `DCL` (=DC.L), `FCB` (=DC.B), `FDB` (2-byte), `FQB` (4-byte).
  - Strings in `DC.W`/`DC.L` are right-aligned within their 2/4-byte unit: `DC.W "ABCDE"` → `0041 4243 4445`.
  - In the listing, unresolved relocatable values show as `xxxx`.
- `FCC`: **accepted**. Message A2310 lists "DCB, DC, DS, FCC, FCB, FDB, FQB, RMB". The detailed chapter does not document its semantics. **UNCERTAIN:** treat it as DC.B of a quoted string.
- `[label:] DCB[.size] count, value`. Count 1..4096, no forward references.
- `[label:] DS[.size] count`. Count 1..4096. Synonyms `RMB` (=DS.B), `RMD` (2·n), `RMQ` (4·n).
- `RAD50 "str"[, cnt]`.

**Linkage**
- `XDEF[.B|.W|.L] sym{,sym}`. Synonyms `GLOBAL`, `PUBLIC`.
- `XREF[.size] sym{,sym}`. Synonym `EXTERNAL`.
- `XREFB sym`, the same as `XREF.B` (direct page).
- `ABSENTRY label`. Only meaningful with `-FA2`. It writes the entry point into the .abs header.

**Assembly control**
- `ALIGN n` (1..32767, filled with 0), `EVEN` (= ALIGN 2), `LONGEVEN` (= ALIGN 4).
- `BASE n`.
- `END`. Later lines are ignored. Inside an include it ends only that file.
- `INCLUDE "file"`. Quoted (single quotes work too), case-insensitive. Searched in the current directory, then GENPATH.
- `FAIL n|"string"`:
  - 0..499 → error **A2329**, no object file.
  - 500..$FFFFFFFF → warning **A2332**.
  - string → error **A2338** with that text.
- `FOR label=n TO m` … `ENDFOR`. Requires `-Compat=b`.

**Conditionals**
- `IF expr` … `[ELSE]` … `ENDIF`. Synonyms `ELSEC` and `ENDC`.
- `IFEQ`, `IFNE`, `IFLT`, `IFLE`, `IFGT`, `IFGE` test an expression against 0.
- `IFC s1,s2` and `IFNC s1,s2` compare strings.
- `IFDEF sym` and `IFNDEF sym`.
- Nesting depth is limited only by memory. An unclosed block gives A1000. A stray ELSE gives A1001.

**Macros**
- `name: MACRO` … `ENDM`. `MEXIT` ends the expansion early.
- No nested definitions (A2304). Recursive and nested *calls* are allowed. `-MacroNest` caps the depth (A1004).

**Listing control**
- `LIST`; `NOLIST` (synonym `NOL`). Neither appears in the listing.
- `CLIST [ON|OFF]`, default ON when `-L` is given. `MLIST [ON|OFF]`, default ON.
- `LLEN n` (0..132). `PLEN n` (10..10000, default 65). `TABS n` (0..128, default 8). `SPC n` (0..65).
- `PAGE`, `NOPAGE`.
- `TITLE "..."` (synonym `TTL`). Must be the first source line.

**MASM extras:** `SWITCH`, `ASCT`, `BSCT`, `CSCT`, `DSCT`, `IDSCT`, `IPSCT`, `PSCT`.

**Avocet extras** (only with `-C=SAvocet`): `DEFSEG`, `SEG`, `ELSEIF`, `EXITM`, `IFB`, `IFNB`, `SM`, `NOSM`, `SUBTITLE`, `TEQ`, `SWITCH`/`CASE`/`DEFAULT`/`ENDSW`, named macro parameters.

**`-MCUasm` mode** drops `RMB`, `NOL`, `TTL`, `GLOBAL`, `PUBLIC` and `EXTERNAL`.

## 6. Macros

**Parameters**
- `\1`..`\9` and `\A`..`\Z` are positional arguments (the manual mentions 36 or 35 slots).
- `\0` is the size suffix of the call: `MyMacro.B $10,$56` with body `DC.\0 \1, \2` → `DC.B $10, $56`.
- Substitution is literal text. A missing argument becomes an empty string. A null argument is written `a,,b`.

**Grouping arguments that contain commas**
- `[? … ?]` (`-CMacBrackets`, default ON). Inside it, `\[`, `\]`, `\?` and `\\` are escapes.
- The old `<…>` syntax is controlled by `-CMacAngBrack`.

**Unique labels.** `\@` in a label expands to `_nnnnn`, a 5-digit counter that increments per macro call. Example: `\@LOOP:` → `_00001LOOP:`, then `_00002LOOP:`.

**Listing of expansions.** Expanded lines are marked with a `+` before the source text and an `m` suffix on the Rel line number (`2m`). Lines from include files get an `i` suffix (`1i`).

## 7. Relocatable vs. absolute modes, and what the wizard sets up

**Relocatable mode**
- The assembler produces ELF objects (`-F2`; the manual's option page says `-F2` is the default) in `<proj>_Data/<target>/ObjectCode/main.asm.o`.
- SmartLinker, driven by the PRM, produces `bin/Project.abs` and `Project.map`.
- The Burner post-step uses `prm/burner.bbl` to produce `Project.abs.s19` and `Project.abs.phy`.
- The manual says it is required for more than one .asm file.

**Absolute mode**
- The assembler is run with `-FA2` and writes the `.abs` directly, with no linker. In the IDE this is the Linker for HC12 panel's "Absolute, Single-File Assembly project" radio button.
- Only ORG sections are allowed. A `SECTION` gives **A2341** "Relocatable Section Not Allowed: an Absolute file is currently directly generated".
- The reset vector must be in source: `ORG $FFFE` / `DC.W Entry`.
- The standalone assembler can also write an S-record `.sx`.

**IDE output naming.** The Linker for HC12 panel offers: Use Custom PRM file, Use Template PRM file, Use PRM file from project (default), Absolute Single-File Assembly. The application filename is configurable; the wizard default is `Project.abs` with `Project.prm`, regardless of the .mcp name. Evidence: `Project_1.mcp` → `bin/Project.abs`.

**CW 5.x wizard flow** (TMU COE538 lab1: https://www.ee.torontomu.ca/~courses/coe538/Labs/lab1.pdf):
1. Create New Project.
2. Family HCS12D → derivative **MC9S12DG256B** (DG128B in that lab). Tick one or more connections (Full Chip Simulation, HCS12 Serial Monitor, P&E Multilink USB, …). Each connection becomes a build target with its own `<Conn>.ini` and `cmd/<Conn>_{Startup,Reset,Preload,Postload,SetCPU}.cmd`. P&E also gets Vppon/Vppoff/Erase cmd files.
3. Languages: C / C++ / **Absolute assembly** / **Relocatable assembly**, plus project name and location.
4. Finish.

**UNCERTAIN:** the exact page count and the Processor Expert/PC-lint pages.

**Project tree.** Groups: Sources, Includes/Libraries, Prm, Linker Map, Debugger Project File, Debugger Cmd Files. Folders on disk: `Sources/`, `prm/`, `cmd/`, `bin/`, `<name>_Data/`.

### Wizard v5.x absolute-assembly `main.asm`

Confirmed by the billhhh repo and the TMU COE538 handout; the full text is Listing 1.7 of the 2006 assembler manual.
Summary of its structure (not the template text, which is Freescale copyright):
- A boxed comment header saying the file is a single-file absolute-assembly framework and pointing to the examples
  folder of the CodeWarrior install.
- `XDEF Entry, _Startup` and `ABSENTRY Entry`, then `INCLUDE 'derivative.inc'`.
- `ROMStart EQU $4000`; `ORG RAMStart` with two `DS.W 1` variables (`Counter`, `FiboRes`).
- `ORG ROMStart`, `Entry:`/`_Startup:` load the stack pointer with `#RAMEnd+1` and `CLI`, then a main loop computing
  Fibonacci numbers via a `CalcFibo` subroutine (`LEAY D,Y` / `EXG D,Y` / `DBNE X,...`).
- An "Interrupt Vectors" block: `ORG $FFFE` / `DC.W Entry` (reset vector).

The CW 5.x copy adds `_Startup` and `derivative.inc` relative to the 2006 manual. The v5 template reportedly labels
the inner loop `couterLoop` (sic); that spelling is UNCERTAIN.

### Wizard v5.x relocatable `main.asm`

From the 2006 manual, C32 version:
- `XDEF Entry, main`
- `XREF __SEG_END_SSTACK`
- `INCLUDE 'mc9s12c32.inc'`
- `MY_EXTENDED_RAM: SECTION` with `Counter ds.w 1` and `FiboRes ds.w 1`
- `MyCode: SECTION`, then `main:` / `Entry:` / `LDS #__SEG_END_SSTACK`, …

**UNCERTAIN:** whether the v5.x version also exports `_Startup` and includes `derivative.inc`. I expect it does.

### `derivative.inc` (billhhh repo)

A few comment lines saying the project wizard regenerates the file whenever the MCU changes and that it should not
be edited by hand, then a single `INCLUDE 'mc9s12dg256.inc'` (the derivative's register file). S12 Studio writes its
own equivalent (`packages/project/src/templates.ts` `minimalDerivativeInc`).

### `mc9s12dg256.inc`

This is the Freescale-generated register file in `lib\hc12c\include`. From memory (**UNCERTAIN** formatting):
- Lines look like `PORTA: equ $00000000`.
- Bit numbers look like `PORTA_BIT0: equ 0`; masks look like `mPORTA_BIT0: equ %00000001`.
- It defines `RAMStart`/`RAMEnd` ($1000/$3FFF on DG256; a forum post confirms RAM is 0x1000–0x3FFF) and vector address equates (`Vreset` …).

The file is Freescale copyright. The clone should generate its own from the DG256 datasheet, using the same symbol names.

### Wizard DG256B `Project.prm` (semakse repo, C project)

Facts from the wizard file (paraphrased; the comments are Freescale text and are not reproduced):

| Segment | Qualifier | Range |
|---|---|---|
| (IO_SEG, $0000–$03FF) | commented out ("intentionally not defined") | |
| `EEPROM` | READ_ONLY | $0400–$0FEF |
| `RAM` | READ_WRITE | $1000–$3FFF |
| `ROM_4000` | READ_ONLY | $4000–$7FFF |
| `ROM_C000` | READ_ONLY | $C000–$FEFF (Serial Monitor target: $C000–$F77F) |
| (VECTORS $FF00–$FFFF) | commented out; the `VECTOR` commands fill it | |
| `PAGE_30` … `PAGE_3D` | READ_ONLY | $xx8000–$xxBFFF per page (`$3E`/`$3F` omitted: same as ROM_4000/ROM_C000) |

- `PLACEMENT`: `_PRESTART, STARTUP, ROM_VAR, STRINGS, VIRTUAL_TABLE_SEGMENT, DEFAULT_ROM, NON_BANKED, COPY INTO ROM_C000`
  (with `ROM_4000` commented out); `OTHER_ROM INTO PAGE_30 … PAGE_3D`; `SSTACK` placed first in RAM (to keep a stack
  overflow from overwriting variables), then `DEFAULT_RAM INTO RAM`.
- Empty `NAMES END` and `ENTRIES END` blocks; `STACKSIZE 0x100`.
- `VECTOR 0 _Startup` active, with `VECTOR 0 Entry` and `INIT Entry` commented out as the assembly alternatives.
- The 2006 manual's assembly version has `VECTOR 0 Entry` and `INIT Entry` active and `VECTOR 0 _Startup` commented out.
- The Serial Monitor target differs only in `ROM_C000 … TO 0xF77F`, because the monitor occupies $F780–$FFFF and the vectors are relocated.

### Wizard `burner.bbl` (billhhh repo)

Structure (paraphrased):
- **Logical S-record file:** `OPENFILE "%ABS_FILE%.s19"`, `format=motorola`, `busWidth=1`, `origin=0`,
  `len=0x1000000`, `destination=0`, `SRECORD=Sx`, `SENDBYTE 1 "%ABS_FILE%"`, `CLOSE`. One pass over the whole
  24-bit logical address space.
- **Physical S-record file:** `OPENFILE "%ABS_FILE%.phy"`, `len = 0x4000`, then one `origin`/`destination`/`SENDBYTE`
  triple per 16 KB window: non-banked $4000 → $0F8000 and $C000 → $0FC000, then pages $20–$3F
  (`origin = 0xPP8000`, `destination` = $080000 + (PP−$20)×$4000, so $3F8000 → $0FC000). Commented variants exist for
  smaller flash sizes.

So `.s19` holds *logical* (PPAGE:addr, e.g. `0x308000`) addresses and `.phy` holds physical flash addresses. Our
generated equivalent is `packages/project/src/templates.ts` `minimalBbl`.

## 8. PRM (SmartLinker parameter file) syntax

The EBNF is in BTU Ch. 6.

**Commands**
- `LINK file.abs`. Optional under the IDE, which passes `-O`.
- `NAMES obj… END`. Mandatory.
- `SEGMENTS … END`, or the old `SECTIONS` without an `END` before `PLACEMENT`.
- `PLACEMENT … END`. Mandatory.
- `STACKSIZE n` or `STACKTOP n`. Not both (L1200). `STACK` is an old synonym.
- `INIT func`. Mandatory for assembly applications. Without it the linker looks for `_Startup`.
- `MAIN func`.
- `ENTRIES … END`. `*` means link everything (turns smart linking off). `file.o:*` and `file.o:obj` are also accepted.
- `VECTOR n target` or `VECTOR ADDRESS addr target [OFFSET n]`. On HC12, vector n maps to `0xFFFE − 2n`, so `VECTOR 8` → `0xFFEE`. The target is a function name or a number.
- `MAPFILE ALL|NONE|TARGET|FILE|STARTUP_STRUCT|SEC_ALLOC|OBJ_ALLOC|SORTED_OBJECT_LIST|OBJ_DEP|OBJ_UNUSED|COPYDOWN|OVERLAP_TREE|STATISTIC|MODULE_STATISTIC`. `ON` and `OFF` are aliases.
- `HEXFILE f [OFFSET n]`, `CHECKSUM`, `DEPENDENCY`, `OVERLAP_GROUP`, `HAS_BANKED_DATA`, `START`, `DATA`, `PRESTART`.
- `INCLUDE file` can appear anywhere.

**Segment definitions.** Form: `Name = QUAL start (TO end | SIZE n) [RELOCATE_TO a] [ALIGN …] [FILL hh hh…] [DO_(NOT_)OVERLAP_CONSTS CODE|DATA];`
- Qualifiers: `READ_ONLY` (loaded at download time), `READ_WRITE` (zeroed or copied down by startup code), `NO_INIT`, `PAGED` (overlap allowed, not checked), `CODE` (Harvard targets).
- **24-bit "logical" paged addresses** such as `0x308000` are just numbers to the linker.

**Placement.** Form: `sec{,sec} INTO|DISTRIBUTE_INTO seg{,seg};`
- Sections are allocated in the order listed. Segments are filled in order: when one fills, allocation spills into the next.
- Names are case-sensitive.
- The SEGMENTS block must come before PLACEMENT.

**Predefined sections.** Freescale/ELF alias pairs: `DEFAULT_ROM`/`.text`, `DEFAULT_RAM`/`.data`, `SSTACK`/`.stack`, `ROM_VAR`/`.rodata`, `STRINGS`/`.rodata1`, `COPY`/`.copy` (must be last in its list, else L1122), `STARTUP`/`.startData`, `_PRESTART`/`.init`. Also `NON_BANKED`, `OTHER_ROM`, `.bss`, `.common`.
- Unplaced code and constant sections go after `.text`. Unplaced data sections go after `.data`, followed by the stack.

**Stack placement.**
- `STACKSIZE 0x60` alone puts the stack after `.data`.
- With `SSTACK INTO seg`, the stack runs from the segment start up to start+size.

**Linker-defined symbols.** `__SEG_START_<seg>`, `__SEG_END_<seg>` (the first byte *after* the segment) and `__SEG_SIZE_<seg>`. A missing user segment gives a warning and the value 0. No warning is issued for SSTACK.

**Comments.** C-style `/* */` and `//` (both appear in the wizard file), plus Modula-2 `(* *)`. Numbers: decimal, `0x…` hex, octal.

**Assembly smart linking.** Smart linking works per *section* for asm. An unreferenced section is dropped unless it is listed in ENTRIES or reached through a VECTOR or INIT. Warnings about missing `_startupData` or `main` are normal for asm and can be ignored (the manual says so).

## 9. Output formats

**`.abs`**
- ELF32 with DWARF 2.0 (`-F2`/`-FA2`; `-F2o`/`-FA2o` produce "compatible" ELF for HI-WAVE ≤ 5.2). The legacy HIWARE format is `-Fh`.
- The ELF header carries the entry point (ABSENTRY or INIT). Paged code uses the 24-bit logical addresses.
- **UNCERTAIN:** the ELF `e_machine` value (probably EM_68HC12 = 53) and the DWARF details for asm line info.
- The assembler also writes `<name>.dbg`, a debug listing the debugger uses to show asm source with macros expanded.

**`.map`.** Real CW 5.x sample from the semakse repo. Sections appear in this order, each preceded by a row of `*` and a row of `-`:
1. `PROGRAM "path\Project.abs"` header line.
2. `TARGET SECTION`: Processor `Freescale HC12`, Memory Model `SMALL`, File Format `ELF\DWARF 2.0`, Linker `SmartLinker V-5.0.40 Build 10203, Jul 23 2010`.
3. `FILE SECTION`: `file.o  Model: SMALL,  Lang: Assembler|ANSI-C`.
4. `STARTUP SECTION`: `Entry point: 0xC029 (_Startup)`.
5. `SECTION-ALLOCATION SECTION`. Columns: `Section Name  Size  Type(R|R/W|N/I)  From  To  Segment`. Absolute ORG blocks appear as `.abs_section_xx` in `.absSegN`; vectors as `.vectSegN_vect`. Followed by "Summary of section sizes per section type: READ_ONLY (R): 77E (dec: 1918)".
6. `VECTOR-ALLOCATION SECTION`: `Address  InitValue  InitFunction`.
7. `OBJECT-ALLOCATION SECTION`: `Name  Module  Addr  hSize  dSize  Ref  Section  RLIB`, grouped by `MODULE: -- x.o --` with `- PROCEDURES:` and `- VARIABLES:`.
8. `MODULE STATISTIC`: `Name  Data  Code  Const`.
9. `SECTION USE IN OBJECT-ALLOCATION SECTION`.
10. `OBJECT LIST SORTED BY ADDRESS`.
11. `UNUSED-OBJECTS SECTION`.
12. `COPYDOWN SECTION`.
13. `OBJECT-DEPENDENCIES SECTION` (`X USES Y Z`).
14. `STATISTIC SECTION`: "ExeFile: Number of blocks to be downloaded: 5 / Total size of all blocks to be downloaded: 1918".

**`.lst`** (assembler, generated only with `-L`; the wizard doesn't enable it). The page header has three lines: optional TITLE, `Freescale HC12-Assembler`, `(c) Copyright Freescale 1987-20xx`. The column header is `Abs. Rel.   Loc    Obj. code   Source line` followed by a row of dashes.
- **Abs** = line number in the expanded stream.
- **Rel** = line number in the source file, with an `i` suffix for include lines and `m` for macro lines.
- **Loc** = 6-hex-digit section offset, or `aXXXXXX` for absolute sections. It is empty for non-code lines. EQU/SET lines show the value as `0000 4000`.
- **Obj** = hex bytes in 2-byte groups (`CF10 00`), with `x` placeholders for fixups.
- Expanded macro lines are prefixed with `+`.
- No .lst is written if errors occurred.
- Listing options: `-Lasmc` (columns), `-Lasms` (address size), `-Lc`, `-Ld`, `-Le`, `-Li`.

**`.s19`.** A real sample begins with `S0` + the path of the .abs in hex, then `S123C000…` (32 data bytes per record by default; Burner `SLINELEN` default is 32), then `S105FFFEC02914`, then `S9030000FC`.
- The S-record type is set by `SRECORD=Sx|S1|S2|S3` (auto picks S2 when addresses exceed 16 bits).
- Extensions: `.s1`/`.s2`/`.s3`/`.sx` for the linker `-B` option; the IDE uses `.abs.s19` via the bbl.

## 10. Burner (`burner.exe`, `.bbl`)

- Statement grammar: `OPENFILE "f"`, `OPENCOM n`, `format = freescale|intel|binary` (`motorola` is accepted, as the wizard uses it), `SRECORD = Sx|S1|S2|S3`, `origin`, `len` (default 0x10000), `destination`, `busWidth 1|2|4`, `swapByte`, `undefByte` (default 0xFF), `SLINELEN`, `SENDBYTE n "file"`, `SENDWORD n "file"`, `CLOSE`, `ECHO`, `PAUSE`, `IF … THEN … ELSE … END`, `FOR i = a TO b DO … END` (the loop variable must be `i`; `#` in a string is replaced by i).
- Assignment is `=` or `:=`. Comments are `/* */` or `(* *)`.
- `%ABS_FILE%` is an environment macro.
- Command line: `burner.exe -F="burner.bbl" -Env"ABS_FILE=…"` (mcuoneclipse example).
- Messages use the B prefix: B50 input file not found, B1000 could not open, B1001 error in input file format, and so on.

## 11. Message formats and codes

**Kinds:** INFORMATION, WARNING, ERROR, FATAL, DISABLE. An ERROR stops assembly; FATAL aborts. Prefixes: A (assembler), L (linker), B (burner), C (compiler), D (decoder), LM (libmaker).
- Messages can be re-classed with `-WmsgSd`, `-WmsgSe`, `-WmsgSi`, `-WmsgSw`.
- The manual shows the allowed classes in brackets, e.g. `A2332: FAIL found [DISABLE, INFORMATION, WARNING, ERROR]`. **UNCERTAIN:** which kind is the default for each message. The default was shown in bold, which my extraction lost.

**Interactive (tool window) default**, from `-WmsgFoi`: `"\n>> in \"%f%e\", line %l, col %c, pos %o\n%s\n%K %d: %m\n"`. Example:

```
>> in "C:\Freescale\demo\errfail.asm", line 6, col 19, pos 96
        FAIL 200
                   ^
ERROR A2329: FAIL found
```

**Batch default**, from `-WmsgFob`: `"%f%e(%l): %K %d: %m\n"` → `x:\Freescale\sourcefile.asmx(3): error A1051: Right parenthesis expected`.
- Format codes: `%s` source extract, `%p` path, `%f` path+name, `%n` name, `%e` extension, `%N`/`%E` 8.3 forms, `%l` line, `%c` column, `%o` position, `%K`/`%k` kind in upper/lower case, `%d` number, `%m` text.
- Error file: `ERR.TXT` (interactive) or `EDOUT` (batch), or whatever `ERRORFILE` says.
- The IDE window shows each message as a code-prefixed line plus file and line. **UNCERTAIN:** the exact CW IDE "Errors & Warnings" rendering. My recollection is `Error : A1104: Undeclared user defined symbol: foo` above `main.asm line 25`, and linker messages as `Link Error : L1822: …`.

**Assembler messages** most relevant to students. The 2003 manual lists them with a title, the allowed message
classes and an explanation; the exact one-line texts CodeWarrior prints are reproduced (for compatibility only) in
`packages/asm/src/messages.ts`. Groups, paraphrased:

- **A1000–A1060, expressions and conditionals:** unclosed conditional (`A1000`), misplaced ELSE, macro nesting too
  deep, division by zero, missing parenthesis, malformed expression, constant cut on overflow, implicit comment start.
- **A1101–A1201, labels and symbols:** reserved or redefined label, `A1104` undeclared symbol (the most common
  student error, printed as "Undeclared user defined symbol: <name>"), ABSENTRY label problems.
- **A1401–A1416, ranges:** 8/16-bit value out of range, relocatable object in an absolute build, branch target out of
  relative range, overlapping absolute sections.
- **A1601–A1605, line syntax:** label not terminated with `:`, bad character after a label, directive/instruction
  expected, bad first character, invalid label name.
- **A2301–A2402, directives and macros:** missing label or macro name, misplaced ENDM/MEXIT, nested or unclosed macro
  definitions, file name expected / file not found, size or symbol or string expected, include nesting > 50,
  expression must be absolute, section not declared, value too small/big/truncated, FAIL messages
  (`A2329`/`A2332`/`A2338`), forward reference not allowed, `A2341` relocatable section in an absolute-assembly
  build, long-line warnings, end of line / comma expected, complex relocatable expression.
- **A4000–A4003:** recursive label definition, data directive with no data, XREF without matching XDEF.
- **A12001–A12600, HC12-specific:** illegal addressing mode, value truncated to one/two bytes, bit number range,
  illegal relative-branch target, register expected, operand or immediate mode not allowed, "not a hc12
  instruction or directive" (`A12202`), indexed offset ranges (−256..255, −16..15), PC-relative references to other
  sections only with IDX2, loop-primitive (DBNE/IBEQ/TBNE...) restrictions, address below the section's current
  position.

The generic messages A1/A2/A50/A51/A52/A64/A65/A66 are shared across all tools.

**Linker messages** (from the 2014 Build Tools Utilities manual; the core is shared). Exact texts are in
`packages/link/src/messages.ts`. Groups, paraphrased:

- **PRM parsing:** command defined twice (`L1001`), token expected (`L1004`), unknown segment (`L1009`), lexer
  errors (`L1620`–`L1626`), unexpected symbol (`L1903`).
- **Result lines:** `L1037` link failed, `L1038` success with the executable's name.
- **Placement:** overlapping segments (`L1100`), out of allocation space in a segment (`L1102`), section missing from
  PLACEMENT (`L1103`) or listed twice (`L1110`), absolute object overlapping a segment (`L1104`), `.copy` not last
  (`L1122`).
- **Objects and vectors:** object not found (`L1106`/`L1107`), vector initialisation failed (`L1108`), vector
  overlapping other sections (`L1118`–`L1120`; real-world `L1119` at 0xFFFE is the classic mistake of combining
  `ORG $FFFE` in source with a PRM `VECTOR 0`), value cut (`L1128`).
- **Stack:** both STACKTOP and STACKSIZE (`L1200`), no stack (`L1201`).
- **Files:** cannot open / not found / not a valid ELF file (`L1301`–`L1303`).
- **Symbols and fixups:** duplicate symbol (`L1818`), `L1822` undefined symbol in a file, external object created by
  default (`L1823`), fixup overflow (`L1907`), function allocated inside another (`L1951`), 8-bit/16-bit branch out of
  range (`L2072`/`L2074`).

---

## Key risks / open questions

1. **Byte-exact encoding choices are undocumented.** Direct vs. extended for forward references, 5/9/16-bit indexed offset selection, and default `-CpDirect`/`-Cpu` are not specified. The only way to confirm parity is to diff the clone's output against real CW `.lst`/`.s19` from the lab PCs. Collect golden outputs before building.
2. **Default message severity** (which A/L codes are warning vs. error by default) was lost in PDF extraction (it was shown in bold). The installed `Assembler_HC12.pdf`, or the help files in `CWS12v5.1\Help`, would settle it.
3. **The exact CW 5.1 relocatable-asm wizard `main.asm` and PRM** for DG256B (whether `_Startup` is exported, whether VECTOR/INIT use Entry or _Startup) are inferred. I found real copies only of the absolute-asm template and a C-project PRM.
4. **FCC semantics** are confirmed only indirectly (A2310 text). Its delimiter rules (quotes vs. arbitrary delimiters) are UNCERTAIN.
5. **Licensing:** `mc9s12dg256.inc`, the template text and the message texts are Freescale copyright. Generating equivalents (register equates from the datasheet) is safer than shipping the originals. The user's own installed files could be imported if present.
6. **ELF/DWARF `.abs` fidelity.** If the clone must interoperate with real HI-WAVE or other agents' debugger work, the exact ELF layout (program headers for paged 24-bit logical addresses, DWARF line tables for .asm, the `.dbg` file role) needs reverse-engineering from a real `.abs`. Readelf on the semakse repo's `bin/Project.abs` is a good start.
7. **IDE message-window rendering** (Errors & Warnings layout and wording such as "Link Error :") is from memory.
8. **`.mcp` is a binary format.** Parsing it is outside this topic but blocks "open CodeWarrior project files". Sample `.mcp` files exist in both GitHub repos above.
9. **Serial Monitor target memory map.** It uses `ROM_C000 … 0xF77F`, with the monitor at $F800 and vectors relocated to $F780–$F7FF. How the Dragon12-Plus is actually configured in this lab (Serial Monitor vs. D-Bug12 firmware) changes the PRM and download path and must be confirmed with the student.
10. **The two assembler manual revisions (2006 HC(S)12, 2009 S12(X)) may differ** in small behaviours. I extracted the 2006 and 2003 texts; the 2009 Oakland copy was not checked.