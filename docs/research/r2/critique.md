## Completeness critique: CodeWarrior S12(X) v5.1 clone research (6 researcher reports)

No files were changed. I re-checked the claims below with read-only commands against the Lab3 sample project (`fixtures/Lab3`): listing column layout, `readelf`, byte dumps of `bin/Project.abs`, the `.prm`, `.bbl`, `.cmd` and `.ini` files, and an `md5sum` of both `.mcp` files. I also streamed the NXP datasheet [MC9S12XDP512RMV2 Rev 2.21](https://www.nxp.com/docs/en/data-sheet/MC9S12XDP512RMV2.pdf) through Python in memory and searched its text. "VERIFIED" means I checked it this pass. UNCERTAIN marks guesses.

---

## Corrections

### C1. The LCD is 40×2, not 16×2 (this corrects the task context)
VERIFIED, three ways:
- The library's own strings and the lab's LCD fields need 40 columns (details in the private notes, s12studio-fixtures research/critique.md §C1).
- Any program that writes past DDRAM column `$0F` on one line needs more than 16 columns.
- DDRAM layout: line 1 is `$00–$27`, line 2 is `$40–$67`. The me305 report is right; the "16x2" in the task context is wrong.

### C2. The golden build does not need the stock `.inc`
VERIFIED. Details in the private notes, s12studio-fixtures research/critique.md §C2.
- `derivative.inc` (which does `INCLUDE 'mc9s12xdp512.inc'`) and `mc9s12xdp512.inc` are only project members in the Includes group.
- Getting the stock `.inc`'s exact symbol spellings is a compatibility item for other students' code, not a blocker for the golden test.

### C3. Line endings
- `Sources/main.asm` on disk is LF-only, with no final newline.
- `bin/main.dbg`, `bin/main.lst` and `derivative.inc` are CRLF.
- elf-lib said only the final CRLF differs. In fact every line differs in its ending. Content is identical once line endings are normalised (0 differing lines).
- Rule: the assembler must accept LF, CRLF or no final EOL, and must write `.lst` and `.dbg` with CRLF.

### C4. s12x-isa §0 line numbers are physical `main.lst` lines, not source lines
The encodings quoted are correct; the line numbers there are `main.lst` lines (details in the private notes, s12studio-fixtures research/critique.md §C4).

### C5. SYS vector
Datasheet Table 1-12 (S12XINTV1) lists "Vector base + $12 to Vector base + $5E: Reserved" and "Vector base + $10: Spurious interrupt".
- The `SYS` → IVBR:$12 mapping comes from the S12XCPU, not the device table (UNCERTAIN; confirm in the CPU12X RM).
- xdp512's table is right for the device.
- A SYS instruction will fetch an erased `$FFFF` vector in Lab3. The simulator should warn ("vector not initialised").

### C6. IPL on non-maskable exceptions (resolves an s12x-isa open item)
Datasheet S12XINTV1 says: "If an I bit maskable interrupt request is interrupted by a non I bit maskable interrupt request, the currently active interrupt processing level (IPL) remains unaffected."
- So SWI, TRAP, XIRQ (and presumably SYS) do not change IPL.
- An I-maskable request is taken only when all of these hold:
  - `PRIOLVL[2:0] > IPL[2:0]`;
  - I = 0;
  - no SWI, TRAP or XIRQ is pending.
- A request whose level is at or below the current IPL is ignored, even for wake-up.

### C7. COP reset configuration (resolves the xdp512 UNCERTAIN)
Datasheet §1.7 "COP Configuration", Tables 1-13 and 1-14:
- On the rising edge of RESET, CR[2:0] and WCOP are loaded from FCTL (`$0107`). FCTL is loaded from the flash configuration byte at **global `$7FFF0E`** (local `$FF0E`).
- **CR[2:0] = NOT NV[2:0]**: 000→111, 001→110, …, 111→000. **WCOP = NOT NV[3]**.
- An erased `$FF0E` (Lab3 never programs it) gives CR = 000, i.e. **COP disabled**, and WCOP = 0. This is now VERIFIED, not a guess.
- If the MCU is secured, CR is forced to 111 after a COP reset.
- COPCTL write rules:
  - WCOP and CR are write-once in normal modes and writable anytime in special modes.
  - Writing CR = 000 still counts as the one write.
  - RSBCK can be set but not cleared in normal modes.
  - WRTMASK = 1 suppresses the WCOP/CR write and does not count as the one write.

### C8. Illegal-address behaviour is a defined reset, not a choice
Datasheet S12XMMCV2 says:
- In single-chip modes, any CPU access to an unimplemented area causes an illegal access reset (vector `$FFFE`, CRGINT.ILAF set). BDM and firmware accesses are exempt.
- In single-chip modes, a misaligned word access to the top address of an on-chip block also causes the reset, except for flash.
- The simulator should emulate the reset by default. It should also offer a debugger "break on illegal access" option, which is what hiwave users would expect.

### C9. Reset CCR is `$D0` (S, X and I set)
xdp512 §11 left out S. IVBR's reset value is `$FF`, and a system reset re-initialises IVBR *before* the reset vector is fetched (VERIFIED in the datasheet).

### C10. An unresolved library XREF (xdp512 and me305 agree; made precise)
- One library member XREFs a start-up routine that no member defines (it is never relocated). Linking that member must behave as SmartLinker does (the message text is UNCERTAIN). Details in the private notes, s12studio-fixtures research/critique.md §C10.

### C11. Delay-loop race: the instruction forms were wrong; the conclusion gets stronger
Details in the private notes, s12studio-fixtures research/critique.md §C11.

General warning (UNCERTAIN until checked on hardware):
- A delay loop that polls an output compare and then re-arms it only a few ticks ahead can write the new compare
  value after TCNT has already passed it. That iteration then misses its compare and waits for a full TCNT wrap of
  65536 ticks (6.5536 ms at 10 MHz).

Simulator requirement: evaluate the output compare on each timer-clock edge as an equality test (TCNT == TCn), never `>=`. Define and document what happens when a TCn write lands on the matching tick.

### C12. Relocation scope in the listing (confirms elf-lib, adds a rule)
- A `jsr` to a local label in the same section lists as `16xx xx`. All absolute references to relocatable labels are left as fixups, even within the same section.
- Only PC-relative branches inside one section are resolved by the assembler, e.g. an `lbeq` lists as `1827 rrrr` and a `beq` as `27rr`.

### C13. Debug-section concatenation order
elf-lib said "alphabetical". The observed order (the library modules, then main) is also exactly library-member order followed by `mtlo` link order (lib before `main.asm`). Use the **link order, with members in archive order** (UNCERTAIN: the two rules give the same result for this sample).

### C14. FCLKDIV clock source
The `.cmd` script contradicts itself: the dialog says "bus frequency", the comments say "oscillator frequency".
- On the FTX512K4 flash, FCLKDIV divides **OSCCLK** (UNCERTAIN, but consistent with the `$49` = 16 MHz default).
- The library starts the PLL; the unsecure script runs after reset, before the PLL is running. Either way, OSC = 16 MHz gives `$49`.

---

## Gaps filled

### G1. `.lst` format, exact enough for a byte-identical listing (VERIFIED against `bin/main.lst`)

**File and page structure:**
- CRLF line endings. The file starts with an empty line.
- Page header, 6 lines: `""`, `"Freescale HC12-Assembler "` (note the trailing space), `"(c) Copyright Freescale 1987-2010"`, `""`, `" Abs. Rel.   Loc    Obj. code   Source line"`, `" ---- ----   ------ ---------   -----------"`.
- Each page is **70 lines: 6 header lines plus 64 body lines**. Page 2 onward starts with a line containing only `\f`, which replaces the first empty line.
- There is no symbol table or summary at the end.

**Body line columns:**

| Columns | Content |
|---|---|
| 0–4 | Abs line number `%5d` (line in the `.dbg`, includes expanded) |
| 5–9 | Rel line number `%5d` (line in the physical file) |
| 10–11 | two spaces |
| 12 | `' '` for relocatable, `'a'` for absolute (ORG) |
| 13–18 | Loc `%06X`: section-relative, or the absolute address for ORG |
| 19 | space |
| 20–30 | object field |
| 31 | space |
| 32+ | the source line, verbatim and never truncated (longest line seen: 119 = 32 + 87) |

Lines with no source text are padded to column 32.

**Object field:**
- Up to 4 bytes per line, written `HHHH HHHH`, with an odd trailing byte as `HH`.
- Unrelocated nibbles print as `x`.
- Extra bytes go on continuation lines: 13 spaces, `%06X` loc, a space, the bytes, then padding. No line numbers or source.
- EQU lines: Loc is blank and the object field holds the 32-bit value as `0000 00F1`.
- `DS` lines: Loc only.
- `SECTION`, `XDEF`/`XREF`, `ORG` and comment lines: neither Loc nor object.

### G2. Assembler encoding policy seen in the golden files
- An operand is **extended** if it is an XREF, a label in a relocatable section, or an absolute value of `$100` or more. Examples: `bset PTP,#$10` → `1C 02 58 10`; `clr <variable>` → `79xx xx`.
- An absolute value up to `$FF` is assembled **direct**, e.g. `LDD TCNT` = `DC 44`. This relies on DIRECT = `$00`.
- Indexed forms: `0,X` → `E6 00` (5-bit offset); `stab A,X` → `6B E4` (accumulator offset).
- Branches are **not** relaxed automatically. Students write `lbeq` explicitly. An out-of-range short branch must be an error (the CW error number is UNCERTAIN).

**Directive surface that must work (all used in Lab3 or the blank project):**
- `XDEF`, `XREF` (comma lists).
- `EQU`.
- `name: SECTION`.
- `DS.B`, `DS.W`.
- `DC.B` with `'…'` strings mixed with bytes.
- `DC.W sym`.
- `ORG`.
- Labels with or without a colon; `;` comments.
- Number prefixes `$`, `%` and decimal.

The rest of the CW assembler set is UNCERTAIN until checked against [CW_Assembler_HC12_RM](https://www.nxp.com/docs/en/reference-manual/CW_Assembler_HC12_RM.pdf): `INCLUDE`, `IF`/`ELSE`/`ENDIF`/`IFDEF`, `MACRO`/`ENDM`, `SET`, `ALIGN`/`EVEN`, `DCB`, `ABSENTRY`, `XREFB`, `LIST`/`NOLIST`, `END`.

Option `-Li` is "do not list included files" (UNCERTAIN). It cannot be tested because Lab3 has no includes.

### G3. `Project.map` layout (VERIFIED; needed for a faithful map)
1. `PROGRAM "<abs path>"`.
2. Sections, each framed by a line of 93 `*`, a title, and a line of 93 `-`:
   - **TARGET**: Processor, Memory Model SMALL, `ELF\DWARF 2.0`, SmartLinker version.
   - **FILE**: `Lib_X.asm.o (ME305LibV4.0.lib)` padded to column 40, then `Model: SMALL,         Lang: Assembler`.
   - **STARTUP**: `Entry point: 0xC000 (Entry)`.
   - **SECTION-ALLOCATION**: Name, Size (decimal), Type `R` or `R/W`, From/To (`0x%X`, not zero-padded), Segment. Followed by a per-type summary in hex and decimal.
   - **VECTOR-ALLOCATION**: empty here.
   - **OBJECT-ALLOCATION**: per module, `- PROCEDURES:`, `- VARIABLES:` and `- LABELS:` lists with columns Name, Addr (hex), hSize (hex), dSize (decimal), Ref, Section.
   - **MODULE STATISTIC**: Data/Code/Const per module plus an "other" row (the 1024-byte stack).
   - **SECTION USE IN OBJECT-ALLOCATION**.
   - **OBJECT LIST SORTED BY ADDRESS**.
   - **UNUSED-OBJECTS** and **COPYDOWN**: empty.
   - **OBJECT-DEPENDENCIES**: `X USES a b c`, wrapped.
   - **DEPENDENCY TREE**: groups "main and _Startup", `_ORG00001`, `_ORG00002`, with `(see above)` back-references.
   - **STATISTIC**: "Number of blocks to be downloaded: <n>", "Total size…: <n>".
3. **COPYDOWN is empty, so nothing initialises RAM.** `main` clears its own variables. The datasheet says "RAM array is not initialized out of reset". The simulator should not silently zero RAM: offer random fill or "uninitialised" marking (hiwave's exact behaviour is UNCERTAIN).

### G4. "New Project" template
- `blank_project/` is the Cal Poly template, not the CodeWarrior wizard output. Its `main.asm` has the same XREF block and `main: spin: bra spin`, and it carries its own golden `bin/*`. Its `.mcp` is byte-identical to `Lab3.mcp` (VERIFIED, MD5 `054701b4…`).
- The clone's "New Project" should copy this tree and rename `<name>_Data`.
- It should be golden test #2.

### G5. Debug-session behaviour from the files
- **Full Chip Simulation:** `Full_Chip_Simulation_Postload.cmd` is comment-only and `LoadDialogOptions=… NORUNAFTERLOAD`. After a load, FCS stops at the reset entry `$C000` (`Entry`).
- **P&E connection:** Postload is `bs &main t` then `g`, so it runs through the library startup to `main` (temporary breakpoint `t`). The clone needs this distinction per connection.
- **Command subset that must parse:**
  - From the `.cmd` scripts: `bs <expr> [t|p]`, `g`, `reset`, `wb`, `ww`, `wait <n>`, `DEFINEVALUEDLG "title" "VAR" default "text"`, `undef VAR`, `FLASH RELEASE`.
  - From the `.hwl` layout and `.xpr` watch file: `OPEN <comp> x y w h`, `<Comp> < attributes …`, `ACTIVATE`, `bckcolor`, `font`, `AUTOSIZE`, and `Data < ADDXPR ONLY_ADD_IF_NEW "sym"`.
  - `//` comments; `&sym` means "address of".
  - Command reference: the [HC(S)12(X) Debugger Manual](https://my.eng.utah.edu/~cs5780/doc/CW_Debugger_HC12_RM.pdf), "Commands" book; the install has `Help\PDF\Debugger_HC12.pdf` ([NXP thread](https://community.nxp.com/t5/CodeWarrior-for-MCU/Information-about-the-COMMAND-window-in-debugger/m-p/160788/highlight/true)).
- **FCS ini:** uses `Target=sim`, `FCS=MC9S12XDP512`, `HCS12_SUPPORT=2`, `HCS12X_FLASH=524288`, `XGATE_RAM=32768`.
- **Default windows:** Memory opens at `0x80`; Assembly `TOPPC` is `0x4000`.

### G6. Keypad ISR bytes (confirms the reports and adds S12X move forms)
Bytes and disassembly in the private notes, s12studio-fixtures research/critique.md §G6. What they confirm:
- the `18 0D xb hh ll` idx→ext MOVB layout (source postbyte first);
- PTJ input reads return the pin level;
- PIFJ is write-1-to-clear.

### G7. Load and erase facts
- The real CodeWarrior flow programs the EEPROM library because hiwave loads the ELF `.abs` (`AUTOERASEANDFLASH`). Only third-party S19 flashers have the missing-EEPROM problem.
- The unsecure script mass-erases the EEPROM (EADDR `0x0C00`) as well as flash, using FTSTMOD.WRALL. After that, the library code is gone until the next load.
- The datasheet's own unsecure procedure programs `0xFFBE` at `$FF0E`. The lab script programs `0xFFFE`. Both are unsecured (SEC = 10). `0xFFBE` also enables the backdoor key (KEYEN = 10).

---

## Remaining unknowns
1. **hiwave FCS semantics** when it hits erased memory, uninitialised RAM or illegal addresses. Its `UU`/`--` display markers and stop messages are unverified. Default.mem's encoding is undecoded.
2. **S12X cycle strings** for most page-2 instructions, plus RTI/SWI/SYS. These are needed for C11-level fidelity. Transcribe them from the CPU12/CPU12X RM Rev 1.04, Appendix A.
3. **The full assembler grammar**: operator precedence, `HIGH`/`LOW`/`PAGE`, macro and conditional semantics, error codes and texts, and the S12X register-name spellings in `TFR`/`EXG`.
4. **The full PRM grammar** beyond Lab3 (`DISTRIBUTE`, `VECTOR n`, `OFFSET`, …), and the exact rule that moved `Lib_Startup` into `.init`.
5. **Board hardware**: keypad DA polarity and layout, the 16 MHz crystal (strongly supported but unconfirmed), DAC Vref, motor and encoder constants, and whether the boards have a 6-pin BDM header.
6. **Exact compare-on-write timing in the ECT** for the C11 race edge case.
7. **The stock `mc9s12xdp512.inc` symbol spellings.** Lower priority given C2.
8. **XGATE/CAN/DBG behaviour**: stubbed only.

## Key risks / open questions
- **The C11 timing race decides whether the simulator matches the board.** An "approximately right" timer will make the LCD init and student delays behave differently from hardware. Validate on a real board: time `DELAY_MICRO(2)` against a port-toggle scope trace.
- **The UI must say 40×2, not 16×2.** Any mock-up or LCD model built from the task context is wrong.
- **The listing and map must be byte-exact** if students or graders diff them against CodeWarrior. G1 and G3 give enough layout; the edge cases (INCLUDE expansion, macro lines, error lines) are untested.
- **The default-COP-off decision now rests on the datasheet.** A student who programs `$FF0E` must get a COP reset after the next reset. Model FCTL loading at reset.
- **Illegal-address resets** (C8) will look like mysterious restarts to students. Show an explicit "illegal access reset at PC=…" notice in the debugger.
- **Lab3 never programs the SYS vector, TRAP or any vector other than `$FFFE`/`$FFCE`.** Taking any other vector jumps to `$FFFF`. Warn, don't silently execute.
- **The clone must not "fix" library behaviour**, odd or not (list in the private notes, s12studio-fixtures research/critique.md §Key risks).

Sources: [MC9S12XDP512RMV2 datasheet](https://www.nxp.com/docs/en/data-sheet/MC9S12XDP512RMV2.pdf) (§1.7 and Tables 1-12/1-13/1-14, Ch. 2 COPCTL, Ch. 16 S12XINTV1, Ch. 17/18 MMC); [HC(S)12(X) Debugger Manual](https://my.eng.utah.edu/~cs5780/doc/CW_Debugger_HC12_RM.pdf); [NXP: debugger command window help](https://community.nxp.com/t5/CodeWarrior-for-MCU/Information-about-the-COMMAND-window-in-debugger/m-p/160788/highlight/true); [CW Assembler HC12 RM](https://www.nxp.com/docs/en/reference-manual/CW_Assembler_HC12_RM.pdf). Files checked: `fixtures/Lab3/{Sources/main.asm, bin/main.lst, bin/main.dbg, bin/Project.map, bin/Project.abs, bin/Project.abs.s19, bin/Project.xpr, prm/Project.prm, prm/burner.bbl, Full_Chip_Simulation.ini, P&E_Multilink_USB.ini, ASM_layout.hwl, cmd/*.cmd, Sources/Libraries/ME305LibV4.0.lib, blank_project/}`.