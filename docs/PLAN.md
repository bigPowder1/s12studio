# Plan: "S12 Studio", a local CodeWarrior S12(X) v5.1 clone (Electron)

## Context

> Distribution (installers, GitHub, download site) is planned separately: see `docs/DISTRIBUTION.md` (Release 1 =
> simulator edition, Release 2 = real board on Windows) and `docs/RELEASING.md`.

The project owner (a Cal Poly ME 3305 student) could only write and debug lab code at the lab PCs, which run **CodeWarrior Development Studio for S12(X) v5.1** (classic IDE plus the "True-Time Simulator & Real-Time Debugger", hiwave). The goal is a local desktop app that:
- feels like CodeWarrior,
- opens CodeWarrior `.mcp` projects and `.asm` files,
- builds them with **byte-identical** output,
- runs them in a full-chip simulator of the **ME 3305 board**,
- debugs with hiwave-style windows,
- can also drive the real board through a P&E Multilink.

The app is named "S12 Studio" to avoid NXP trademarks. Its behaviour and window layout follow CodeWarrior.

**What the sample project (`fixtures/Lab3`, in the private fixtures) showed, and how it changed the brief:**
- **Chip.** The MCU is an **MC9S12XDP512 (S12X core)**, not a Dragon12. The code uses CPU12X instructions (`decw`, `incw`). The assembler options are `-CPUHCS12X -L=%(TEXTPATH)\%n.lst -Li`.
- **Project type.** It is a relocatable assembly project: `main.asm` uses XDEF/XREF and `SECTION`s, and is linked with `prm/Project.prm` against a precompiled Cal Poly library, `Sources/Libraries/ME305LibV4.0.lib`.
  - The library is a HIWARE container of big-endian ELF objects. Its format is fully decoded.
  - A Python relink of `main.asm.o` plus the lib members reproduced `bin/Project.abs` byte for byte, so byte-identical linking is proven feasible.
- **Library location quirk.**
  - The library code lives in **EEPROM** (from 0x0800), and it is **absent from CodeWarrior's `.s19`**. Only the ELF `.abs` carries it.
  - The `INIT Entry` section (Lib_Startup) is moved to `.init` at 0xC000, even though the PRM says EEPROM.
- **Board (worked out from what the library sends to the board).** Bus clock is 10 MHz (16 MHz oscillator with PLL). Devices:
  - a **40×2 HD44780 LCD** on PORTB with control lines on PM4–6;
  - a **20-key encoded keypad** on PK0–4, interrupting via PJ7 (vector $FFCE);
  - 4 LEDs on PP4–7;
  - an LS7366R encoder on SPI0 (chip select PH0);
  - an MCP4922-style DAC on SPI0 (chip select PH1);
  - a motor driven by PWM01 on PP1 plus PA4/PA6, with current sense on ATD1.
  - Delays use ECT channel 1 with TFFCA.
- **Debug connection.** The lab uses **"P&E USB BDM Multilink"** (hiwave `Target=icd12`), not the Serial Monitor.
  - P&E's USB protocol is closed.
  - **Free alternative to flag to the owner:** NXP's free CodeWarrior S12(X) v5.2 Special Edition has an unlimited assembler and supports the Multilink on Windows 10. Our P&E path relies on that install's DLLs anyway.

Decisions taken with the owner:
- Electron desktop app.
- Assembly only.
- Byte-identical toolchain output.
- Full simulator plus the real ME3305 board through the lab's P&E pod.

Research notes from two research workflows are saved in `…/scratchpad/r1/*.md` and `…/scratchpad/r2/n7..n12.md`. Copy them into the repo as `docs/research/` at the start.

---

## Architecture

The code is a monorepo (npm workspaces, TypeScript, strict). **All engine code is pure TypeScript with no Electron dependency**, so it can be built and tested headless in WSL. Electron packaging and the hardware path run on Windows.

```
packages/
  formats/   looc container (.mcp/.stg/.tdt) reader; HIWARE .lib reader; ELF32-BE reader+writer;
             DWARF2 line/info reader+writer; S-record (S19/.glo) writer; order-preserving INI r/w;
             .hwl/.cmd/.xpr/.BPT parsers; .prm + .bbl parsers
  asm/       CW HC12 assembler clone (CPU12 + CPU12X), emits CW-dialect ELF .o, .lst, .dbg
  link/      SmartLinker clone: PRM placement, smart linking, .abs (ELF+DWARF), .map; Burner (.bbl → .s19/.glo)
  sim/       S12X CPU core + MMC + peripherals + XINT; board models (ME3305, generic I/O)
  debug/     Target interface, SimTarget, breakpoints/watchpoints, stepping, symbols/lines,
             hiwave command-language interpreter, .cmd hooks
  hw/        PeGdiTarget (ia32 sidecar hosting P&E GDI DLL), UsbdmTarget (koffi → usbdm.dll), flash/EEPROM loader
  project/   project model = .mcp parse + sidecar JSON; build orchestration (make, dependency tracking)
  devices/   generated mc9s12xdp512.inc (+ DG256/DP512/C32 later), memory maps, vector tables, ME3305 board profile
apps/
  ide/       electron-vite + React. Main process, preload IPC, two window kinds:
             IDE window (CodeWarrior IDE) and Debugger window (hiwave), like the real two-app split
tools/       golden-diff CLI, GDI logging-proxy DLL (C, ia32) for P&E reverse-engineering, opcode-table generator
```

**Libraries:**
- electron-vite (react-ts template)
- Monaco editor, using a Monarch tokenizer for HC12 asm, glyph-margin breakpoints and a current-line decoration
- dockview for the hiwave-style floating or tiled component windows
- `@xterm/xterm` for the Terminal/SCI and Command windows
- koffi for the native DLLs
- Vitest and Playwright `_electron` for tests

**Simulator threading:** the simulator runs in an Electron `utilityProcess` (or worker). The UI polls snapshots at 30–60 Hz.

GPL sources (binutils, gdb sim, USBDM) are **references and test oracles only**. NXP-copyrighted files (`.inc`, templates) are never shipped; they are generated or loaded from the user's lab files or CW install.

---

## Work breakdown (in build order)

### M0. Scaffold
- `git init`; set up workspaces, tsconfig, Vitest, ESLint, and electron-vite in `apps/ide`.
- Copy `Lab3/` to `fixtures/Lab3` and `Lab3/blank_project` to `fixtures/blank_project`, read-only. Copy the research notes to `docs/research/`.
- `tools/golden-diff`: compares our outputs against `fixtures/*/bin/*`.

### M1. Formats (`packages/formats`)
Specs are in `docs/research/n7.md` and `n10.md`.

- **`.lib` reader.**
  - Header: `FE 82 0A 8C` plus 5 C-strings.
  - Members are back-to-back ELF objects.
  - The trailing directory uses an inverted-varint encoding, and the u32 at the end of the file gives the directory size.
- **ELF32-BE reader and writer, HIWARE dialect.**
  - Relocations are `Rela`. `r_addend` holds the field width minus 1; the real addend is the value already stored in place.
  - Types: 1 = abs16/32, 3 = pcrel16, 5 = page8.
  - Read and ignore type-13 alias symbols.
  - Unknown (type, width) pairs are a hard error.
  - `.note` records are packed without alignment ("HIWARE AG").
- **DWARF 2.**
  - Abbrev codes 128–133.
  - Every address field is 4 bytes: `00 page addr16`.
  - Line programs use line_base 0 and line_range 4, and refer to `bin\<module>.dbg`.
- **looc container (.mcp/.stg/.tdt).**
  - 0x128-byte header and a table of 24-byte chunks.
  - Parse **only through the chunk table** (free space contains stale strings).
  - String tables: mstr/mstl/msti. Files: mtpl/mtpi. Link order: mtlo. Groups: PLst.
  - Panels: `pref`, with Target Settings, Access Paths, Build Extras and HIWARE tool options. Wizard XML: `prpl`.
- **Other files.**
  - INI reader/writer that preserves key order, unknown keys and CRLF.
  - `.hwl` layout script, `.cmd`, `.xpr`, `.prm` and `.bbl` parsers.
  - S19 writer: 32 data bytes per record, S0 holds the `.abs` path, S9 `0000`. GLO uses S2 records at global addresses.
- **Golden tests:**
  - `Lab3.mcp` gives its target, files, group tree, link order, output path, the asm options and the debugger `-Prod=… -instance=…` options.
  - The `.lib` gives its members with their sections and symbols.

### M2. Assembler (`packages/asm`)
Specs are in `r1/asm.md`, `r1/isa.md` and `r2/n9.md`.

- **Opcode tables.**
  - Generate them into a TS table: CPU12 page 1, page 2 (`$18`) and the S12X additions. Sources are CPU12RM Rev 4 Appendix A and the S12X RM (HCS12X access-detail strings, which give cycle counts for the simulator too).
  - Cross-check with binutils `m68hc11-opc.c` and libasm test vectors, noting known binutils bugs (gsts ext, the S12X MOVB/MOVW rows).
- **CW dialect.**
  - Labels with or without a colon; `;` comments, and `*` comments in column 1.
  - Number formats `$ % @` and decimal; full operator precedence; HIGH/LOW/PAGE.
  - Directives: ORG, SECTION (incl. SHORT), ABSENTRY, XDEF/XREF/XREFB, INCLUDE (searched on GENPATH, case-insensitive), DC/DCB/DS (.B/.W/.L), FCB/FDB/FCC/RMB, EQU/SET, ALIGN/EVEN, IF/IFDEF/IFNDEF/IFEQ…/ELSE/ENDIF, MACRO/ENDM (`\1`…, `\@`), LIST/NOLIST, END, and so on.
  - **Addressing-mode selection must match CW exactly:**
    - direct vs extended for known and forward symbols;
    - 5/9/16-bit indexed offsets;
    - MOVB/MOVW operand order;
    - `BSET opr,#mask` and `opr,mask`.
- **Outputs.**
  - CW-dialect ELF `.o`: sections incl. `_ORGnnnnn`, symbol ordering rules, `VARnnnnn` names for anonymous ORG data, FUNC sizes up to the next label, XREFs as UND globals in declaration order, and DWARF.
  - **`.lst` in the exact CW format.** Columns: Abs., Rel., Loc, Obj. code, Source line. Unresolved bytes show as `xx`, and code splits onto continuation lines. Header: "Freescale HC12-Assembler".
  - `bin/<module>.dbg`: source with INCLUDEs and macros expanded, CRLF line endings.
- **Messages** use CW codes and texts: `A1001`-style codes, error/warning/information severity, and file/line positions for the Errors & Warnings window.
- **Exact behaviour already pinned down (`r2/critique.md` G1/G2/C3/C12):**
  - `.lst` layout:
    - pages of 70 lines (6 header + 64 body), with a form feed (`\f`) between pages;
    - column map for line numbers, Loc, the `a` (absolute) flag, and the object field (`HHHH HHHH`);
    - continuation lines for extra bytes; EQU lines show the 32-bit value.
  - Input may use LF or CRLF line endings; `.lst` and `.dbg` are written with CRLF.
  - Operand mode: any XREF or relocatable label is extended; absolute values ≤$FF are direct.
  - All absolute references to relocatable labels stay as fixups. Only intra-section PC-relative branches are resolved.
  - Branches are never relaxed automatically; a short branch out of range is an error.
- **Golden test:** assembling `fixtures/Lab3/Sources/main.asm` must match `main.lst` byte for byte, and its sections, symbols, relocations and DWARF must match `Lab3_Data/Standard/ObjectCode/main.asm.o` (ignoring `.note` timestamp and user fields).

### M3. Linker and Burner (`packages/link`)
Spec is in `r2/n7.md` §4.

- **PRM support.**
  - NAMES, SEGMENTS (incl. 24-bit paged), PLACEMENT (incl. DISTRIBUTE_INTO and fill order), STACKSIZE/STACKTOP, INIT, ENTRIES, VECTOR, `//` and `/* */` comments.
  - Section aliases: DEFAULT_RAM→`.data`, SSTACK→`.stack` (plus `__SEG_END_SSTACK`), `_PRESTART`/`.init`.
  - **The section holding INIT is forced into `.init`.**
- **Smart linking.** A library member is linked when a *relocation* references one of its globals; a bare XREF does not count. Whole sections are kept.
- **Outputs.**
  - `.abs`: sections sorted by address; one PT_LOAD per allocated section (adjacent RAM merged); program headers at the end of the file; debug sections concatenated in FILE-SECTION order; generated `.debug_aranges`.
  - `.map` in the exact SmartLinker V-5.0.40 layout: TARGET, FILE, STARTUP, SECTION-ALLOCATION, VECTOR-ALLOCATION, OBJECT-ALLOCATION, and so on.
  - Burner runs `burner.bbl` to produce `.abs.s19` and `.abs.glo`. It exports only the windows the `.bbl` lists, which reproduces CW's omission of EEPROM.
  - Also write `bin/Project.abs.full.s19`, which includes EEPROM, for our own loader and flasher.
- **Golden tests:** Lab3 and blank_project produce `.map` identical except for the path and date lines, `.s19` data records identical, and `.abs` loadable and debug sections identical.

### M4. Simulator (`packages/sim`)
Specs are in `r2/n12.md`, `r2/n8.md` and `r1/isa.md`.

- **CPU.**
  - S12X core with A, B, D, X, Y, SP, PC and a 16-bit CCRW (IPL); 10-byte interrupt frame; IVBR; SYS, TRAP and spurious vectors; GPAGE G-instructions.
  - All CPU12 instructions, including fuzzy, EMACS, TBL/ETBL, EDIV(S), FDIV/IDIV(S), DAA and loop primitives.
  - Exact CCR rules and cycle counts.
  - WAI, STOP and BGND handled as a debugger halt.
- **Memory (MMC).**
  - 23-bit global space: RAM 32 KB @0x0F8000, EEPROM 4 KB @0x13F000, flash 512 KB @0x780000.
  - Local windows via RPAGE, EPAGE and PPAGE (reset values $FD, $FE, $FE).
  - Register block 0x0000–0x07FF.
  - "uu" tracking for uninitialised memory.
- **Peripherals, in priority order:**
  1. CRG (PLL lock, PLLSEL, RTI, COP);
  2. PIM ports with DDR, pull devices and Port H/J/P key-wakeup edge interrupts;
  3. ECT (TCNT, prescaler, output compare and input capture, TFFCA fast-clear, TOI, pulse accumulators);
  4. SPI0–2 (SPIF/SPTEF timing);
  5. PWM (8- and 16-bit concatenated);
  6. ATD0/1 (sequences, AFFC);
  7. SCI0–5 (wired to the Terminal);
  8. PIT;
  9. XINT priority/IPL;
  10. EEPROM and flash command state machines (enough for the erase/unsecure `.cmd` pokes).
  
  Unimplemented registers log an "FCS Warning" to the Command window, as hiwave does.
- **ME3305 board model.**
  - HD44780 40×2 LCD: 8-bit, busy flag and address counter readback, latch on the E falling edge, entry mode defaults to I/D=1.
  - Keypad: MM74C923-style. Key codes appear on PK0–4 and DA on PJ7 with configurable polarity; the code-to-key table is in `packages/devices/src/me3305.ts`.
  - LS7366R on SPI0 with chip select PH0.
  - MCP4922 DAC with chip select PH1.
  - Motor: DC-motor ODE driven by PWM01, PA4 and PA6, feeding the encoder count and ATD1 AN0 current. Parameters are tunable.
  - LEDs on PP4–7.
  - Oscillator 16 MHz (configurable).
- **Reset and fault behaviour, per the datasheet (`r2/critique.md` C6–C9):**
  - Reset sets CCR=$D0 and IVBR=$FF.
  - COP CR/WCOP load from FCTL, i.e. the flash byte at $7FFF0E. Erased, that byte means COP is off.
  - Single-chip illegal accesses cause an illegal-access reset. Show a visible "illegal access reset at PC=…" notice and offer a break-on-illegal option.
  - Taking an unprogrammed ($FFFF) vector raises a warning.
  - RAM is **not** zeroed at power-up: it is shown as `uu`, with a random-fill option.
  - SWI, TRAP and XIRQ leave IPL unchanged.
- **ECT accuracy is critical.**
  - Output compare must be an *equality* check (TCNT == TCn) on each timer tick, never `>=`.
  - Per the critique (C11), a multi-iteration library delay on real hardware likely misses its compare and waits a full TCNT wrap (~6.55 ms per extra iteration). The simulator must reproduce this, not "fix" it.
  - Confirm it on the board with a scope or port-toggle test.
  - The same rule applies to the other library quirks (list in the private notes, s12studio-fixtures research/PLAN.md §M4), e.g. ECT channel 1 being reprogrammed by the library's delays.
- **Timing.**
  - Cycle-exact bus-cycle stepping of peripherals.
  - "True-time" mode paces simulated time to wall clock; a "max speed" mode runs as fast as possible.
  - If the TypeScript interpreter falls short of real-time 10 MHz, move the hot loop to WASM (AssemblyScript or Rust) behind the same interface.

### M5. Debug engine (`packages/debug`)
- **`Target` interface:** load(image), reset, go, halt, step (instruction, source line, over, out), read/write memory and registers, breakpoints and watchpoints, status events.
- **`SimTarget`** implements it.
- **Symbols and lines** come from the `.abs` DWARF (address ↔ `.dbg` line) plus the symtab. Library code has no source and is shown as disassembly.
- **Loader** uses ELF PT_LOAD, not S19, so the EEPROM library is loaded. Load options follow `LoadDialogOptions`.
- **Control points.** Temporary, permanent, counting and conditional breakpoints, plus read, write and read/write watchpoints. Saved to `<app>.BPT`.
- **hiwave command language.** BS, BC, G/GO, S/STOP, T, P, STEPINTO/OVER/OUT, RESTART, RESET, RD, RS, DB/DW/DL, WB/WW/WL/MS, MEM, DASM, LOAD, SREC, SAVE, FILL, E, SPC, SMEM, WAIT, CF, CMDFILE, OPEN, ACTIVATE, SLAY, ADDXPR, PRINTF, IF/FOR/WHILE, DEFINE, and so on.
- **Command-file hooks.** Run STARTUP, RESET, PRELOAD, POSTLOAD and SETCPU `.cmd` files from the `.ini` (path resolution is case-insensitive).
  - This gives the right post-load behaviour for each connection: FCS stops at `Entry` ($C000), while P&E's postload runs `bs &main t` then `g`, so it stops at `main`.
  - The dialects that must parse include `DEFINEVALUEDLG`, `undef`, `FLASH RELEASE`, `wb`/`ww` and `wait`.

### M6. IDE UI (`apps/ide`, IDE window)
Spec is in `r1/ide.md` §1–5.

- **Menus.** File, Edit, View, Search, Project, Debug, Window, Help, with CW shortcuts; toolbar buttons Make, Debug and Run.
- **Project window.**
  - Files, Link Order and Targets tabs.
  - Columns: File, Code, Data, debug dot, touch mark.
  - Groups come from PLst. Supports add and remove, drag reorder, and a target selector.
- **Target Settings dialog.** Panels: Target Settings, Access Paths, Build Extras, Assembler for HC12 (options), Linker for HC12, Burner.
- **Editor.** Monaco with CW-like colours, a function popup, line/column display, Find in Files, and Go to Line.
- **Errors & Warnings window.** Double-clicking a message jumps to the source.
- **Other actions.**
  - New Project: the default template is the Cal Poly `blank_project` tree. It is copied, the `.mcp` is renamed, and the matching `<name>_Data` folder is created (the `.mcp` does not store its own name). There is also a generic MC9S12XDP512 relocatable-asm wizard.
  - File→Open accepts `.mcp`, `.asm`, `.inc`, `.prm` and `.abs`.
- **Saving.** Settings save to the sidecar `<name>.s12studio.json`. **The `.mcp` itself is never modified**: it is hashed and re-imported if CW changed it. The `.ini`, `.xpr` and `.hwl` files are written in place, since they are plain text.

### M7. Debugger UI (`apps/ide`, debugger window, styled as hiwave)
Spec is in `r1/ide.md` §6–7.

- **Window and menus.** A separate window titled "True-Time Simulator & Real-Time Debugger" (renamed "S12 Studio Debugger" for the public release). Menus: File, View, Run, <Connection>, Component, <component menu>, Window, Help. The toolbar is taken from the `TOOLBAR=` ini key. Shortcuts: F5, F6, F10, F11, Shift+F11, Ctrl+F11, Ctrl+F10, Ctrl+Shift+F5.
- **Status bar.** Clock frequency, a 64-bit cycle counter (double-click resets it), derivative, and run state.
- **Components (dockview panels, layout from `ASM_layout.hwl`):**
  - Source (the `.dbg` file): PC highlight, breakpoint margin, right-click menu with Set Program Counter, Run To Cursor, and so on.
  - Assembly: address, code, symbolic.
  - Register: changed values in red, CCR bit toggles, in-place edit, formats.
  - Memory: byte/word/long, formats, Automatic/Periodical/Frozen modes, `uu` and `--`, changed values in red, edit, fill, watchpoint underlines.
  - Data: Global/Local/User scopes, `.xpr` expressions.
  - Procedure.
  - Command: `in>` prompt, history, colour-coded output.
  - Terminal (SCI).
  - ME3305 Board panel: LCD, keypad (also mapped to the PC keyboard), LEDs, motor, encoder, DAC meters.
  - VisualizationTool-lite: LED, 7-segment and bar instruments bound to ports.
- **Drag and drop between components** (register → memory, and so on), plus Controlpoints Configuration dialogs.

### M8. Real hardware (`packages/hw`): P&E Multilink first, USBDM as backup
Spec is in `r2/n11.md`.

- **Prerequisite on Windows:** install the free **CodeWarrior S12(X) v5.2 SE**. It provides P&E's drivers and the `HC12MultilinkCyclonePro_GDI` DLL, which we load from that install and never redistribute.
- **Step 1, spike (time-boxed).**
  - Build `tools/gdi-proxy`, an ia32 C DLL that exports the GDI API (`DiGdiOpen`, `DiMemoryWrite`/`DiMemoryRead`, `DiRegisterRead`/`DiRegisterWrite`, `DiExecContinue`/`DiExecSingleStep`/`DiExecStop`, `DiBreakpointSet`, `DiDirectCommand`, …) and logs, then forwards, to the real DLL.
  - Run real hiwave against the board, using USBDM's `GDI.h` and `Metrowerks.h` as the API reference, and record the call sequence, `argv`, callbacks (`MTWKS_CB_PROJECTACCESS` and others) and flashing behaviour.
- **Step 2, `PeGdiTarget`.**
  - An **ia32 sidecar process** (ia32 node with koffi, or a small C++ exe) hosts the DLL, implements the callbacks (serving `.ini` keys from the project), and speaks JSON-RPC over stdio.
  - The main app implements `Target` on top of it.
  - Load and flash program both flash and the **EEPROM library** via the DLL's download path (`AUTOERASEANDFLASH`).
- **Fallbacks, in order:**
  1. "Launch real hiwave" bridge mode: our build, then `hiwave.exe -W -Prod=…P&E_Multilink_USB.ini …\bin\Project.abs`, which works on day one.
  2. **`UsbdmTarget`** (koffi → `usbdm.4.dll`, x64) if a ~$30 USBDM pod is available. Its flash/EEPROM programming uses BDM memory writes plus the FTX/EETX command sequences, as in the lab's erase/unsecure `.cmd`.
- **Safety.** Confirm before every erase or program. Never touch the security byte at FSEC 0xFF0F, apart from the unsecure flow.

### Execution approach
Ultracode is on, so each milestone is executed as its own workflow:
- implement packages in parallel, using worktree isolation for independent packages (formats ∥ opcode tables ∥ device files, then asm ∥ sim core, then link ∥ peripherals ∥ UI shells);
- adversarially verify each against the goldens and the spec;
- run a completeness critic.

Between milestones I report back. The order is M0 → M1 → (M2 ∥ M4-core) → M3 → (M4-peripherals ∥ M5) → (M6 ∥ M7) → M8. A usable simulator build (open Lab3, build, debug in sim) comes before any hardware work.

---

## Things needed from the owner (non-blocking, the sooner the better)
1. From a lab PC, copy `C:\Program Files (x86)\Freescale\CWS12v5.1\lib\hc12c\include\mc9s12xdp512.inc` (plus the `.prm` and `.h` alongside it). Until then we generate an equivalent from the datasheet.
   - This doesn't block Lab3, whose `main.asm` defines its own EQUs.
   - It matters for code that does `INCLUDE 'derivative.inc'`.
2. 2–4 more lab `.mcp` projects, ideally including a before/after pair from one IDE change such as adding a file, plus a File→Export Project `.xml`. These widen `.mcp` coverage.
3. A few lab screenshots of the IDE and hiwave windows, for visual fidelity.
4. One assembler listing of a test file exercising every addressing mode (provided by us), assembled on a lab PC, to settle edge cases of CW's mode selection.
5. Confirmation of the board's oscillator (16 MHz inferred), the keypad interrupt timing (on press or on release), and the motor/encoder/DAC part numbers, if the lab has documentation.

---

## Verification
- **Unit and golden tests (Vitest, headless in WSL):**
  - formats parsers against the Lab3 files;
  - assembler: `main.lst` identical, `.o` sections, symbols, relocations and DWARF identical;
  - linker: `.map` identical apart from header path/date, `.s19` data identical, `.abs` sections identical, for both Lab3 and blank_project;
  - encoder cross-checks against libasm, binutils and gas test vectors;
  - per-opcode CPU tests generated from the opcode table (bytes, cycles, CCR);
  - differential tests against the gdb m68hc12 sim for the base CPU12 (in Docker, CI only).
- **Simulation acceptance (headless script).** Build Lab3 and run it in SimTarget.
  - Assert the LCD shows the library splash, then the lab's prompts; enter a value on the keypad and assert the LEDs toggle with the expected simulated period while the library's ECT delay timing holds.
  - Break in the lab's key handling and check registers. Single-step an S12X `decw`.
  - The exact keys, texts and labels are in the private tests (s12studio-fixtures tests/ and e2e/).
- **E2E (Playwright `_electron`):**
  - open `fixtures/Lab3/Lab3.mcp`, then Make, and expect 0 errors;
  - Debug opens the debugger window with the `ASM_layout.hwl` layout;
  - set a breakpoint in Source, press F5, and expect it to be hit;
  - edit a register and see the memory window update.
- **Hardware (manual, Windows plus board):**
  - the bridge mode flashes and runs Lab3;
  - `PeGdiTarget` connects, reads PARTID at 0x001A, programs flash and EEPROM, and verifies the result against `Project.abs`;
  - breakpoints, single step and halt work.

## Key risks
- **P&E closed protocol:** `PeGdiTarget` depends on reverse-engineering the GDI callbacks. Mitigated by the bridge mode and the USBDM backup.
- **Undocumented CW assembler and linker edge cases:** mitigated by the golden-test loop and items 2 and 4 from the owner.
- **S12X cycle tables:** the official RM is behind a login, so they are transcribed from mirrors and must be validated.
- **Real-time TypeScript simulation speed:** keep a WASM fallback.
- **Board inferences:** keypad DA polarity, oscillator and analog constants are all configurable.
