## Corrections

### C1. Which CodeWarrior version to clone: 5.1, not 5.2 (high impact)
- **CW S12(X) v5.2 dropped the MC9S12DG256 and the "HCS12 Serial Monitor" connection.**
  - The V5.2 release note lists SofTec, HCS12 Serial Monitor, Abatron BDI and TBDML as removed connections, and says some v5.1 devices are no longer supported: https://www.nxp.jp/docs/en/release-note/CW-HCS12-RN.pdf
  - NXP forum threads say DG256 is 5.1-only: https://community.nxp.com/thread/382638 and https://community.nxp.com/t5/Classic-Legacy-CodeWarrior/How-to-Add-missing-derivatives-to-CodeWarrior-Classic-HCS12-X-5/m-p/585472
  - Several notes used "CW 5.x" loosely. **Treat CW 5.1 as the reference.**
- **Real build fingerprint.** A real Dragon12 assembly `.abs` names its producer as `Assembler for HC12 V-5.0.30 Build 10203, Jul 23 2010` from `...\Freescale\CWS12v5.1\...`. This matches the SmartLinker V-5.0.40 Build 10203 seen in the `.map` sample. (Verified by parsing `bin/Project.abs` from https://github.com/billhhh/hcs12_dragon12_asm.)

### C2. `.mcp` header: the **ide** note is right and **oss** is wrong for HC12
I parsed the billhhh `Project.mcp` byte by byte (an **absolute-assembly** project, DG256B, Serial Monitor).

| Offset | Value | Meaning |
|---|---|---|
| +0 | `looc` | Magic (little-endian Windows file) |
| +4 | 3 | |
| +8 | 0x128 | Offset of first chunk |
| +16 | 0xE33E | Index offset |
| +20 | 0x450 | Index size, = 24 × 46 |
| +24 | 46 | Entry count |
| **+28** | **`02 03 04 00`** | Not makeprojects' "50/58/59" version numbers. The oss note's "u32 at 28 = version 50…" does not apply to HC12 CW 5.1. |
| +40 | `CodeWarrior Project` | |

The index entries match the ide decode: `{off,size,tag,id,seq,0}`, with tags mstr/mstl/mstn/mtpl/mtps/mtsl/mtpi/mtlo/moti/msti/mtgl/mpsi/pref/mall/mapl/PLst/prpl.
- `pref.id` is a large opaque number, e.g. 0x1ab9f44.
- `pref.seq` (27…52) is the string id.

### C3. The "verbatim" absolute-assembly template is misattributed
- The **asm** note says the template with `XDEF Entry, _Startup` and `_Startup:` is "confirmed by billhhh and TMU". **No billhhh source file contains `_Startup` or `XDEF`.** Their files use `ABSENTRY Entry` plus `INCLUDE 'mc9s12dp256.inc'` (Mazidi style).
- The Utah v5.x template (https://my.eng.utah.edu/~cs5780/10labs/Lab2counter.asm) has:
  - `XDEF Entry` only
  - `INCLUDE 'mc9s12c32.inc'` (direct, no derivative.inc)
  - the `ifdef _HCS12_SERIALMON` blocks: `ORG $3FFF-(RAMEnd-RAMStart)`, then `CLR $11` / `LDAB #$39 STAB $10` / `LDAA #$9 STAA $12` / `LDS #$3FFF+1`
- So the **ide** note's template description is the one that has evidence. The `_Startup` variant is UNCERTAIN; it may come from the TMU handout or a later 5.1 build.
- billhhh's `Sources/derivative.inc` is the 5.1 wizard file (`INCLUDE 'mc9s12dg256.inc'`), so 5.1 does use derivative.inc. **Generate the 5.1 wizard template with `XDEF Entry`, `ABSENTRY Entry`, `INCLUDE 'derivative.inc'` and the SERIALMON ifdefs.** Keep the exact text UNCERTAIN until it is checked against a lab install.

### C4. Absolute-assembly projects do not use the generic C layout or load options (corrects ide §3, §6, §7)
- **Window layout.** The layout file is `ASM_layout.hwl`, not `C_Layout.hwl`. Verbatim:
  ```
  OPEN source 0 0 60 42 / Source < attributes MARKS off
  OPEN assembly 60 0 40 30 / Assembly < attributes ADR on,CODE off,ABSADR on,SYMB off,TOPPC 0xF800
  OPEN procedure 60 60 40 17 / Procedure < attributes VALUES on,TYPES off
  OPEN register 60 30 40 30 / OPEN memory 60 77 40 23 (ADDRESS 0x80)
  OPEN data 0 42 60 28 (single Data window, SCOPE global) / OPEN command 0 70 60 30
  bckcolor 50331647 / font 'Courier New' 9 BLACK / AUTOSIZE on
  ACTIVATE Assembly Memory Register Command Data Source Procedure
  ```
- **Load options.** Both `.ini` files use `LoadDialogOptions=AUTOERASEANDFLASH NORUNAFTERLOAD`, not `RUNANDSTOPAFTERLOAD="main"`.
- **Project groups in the asm `.mcp` PLst:** `Sources`, `Includes` (derivative.inc, mc9s12dg256.inc), `Project Settings > Linker Files` (burner.bbl only).
  - **No `.prm` and no `.map`.**
  - No "Debugger Project File" or "Debugger Cmd Files" groups, even though `cmd/*.cmd` and both `.ini` files exist on disk.
- **Assembler options.** The panel string is ` -CpuHCS12 -FA2 -D_HCS12_SERIALMON=1 `. `-FA2` is explicit; ide showed only ` -CpuHCS12 -Ms`, which is the C/relocatable form. The compiler panel holds ` -CpuHCS12 -D_HCS12_SERIALMON `.
- **Target style.** One target named `Standard`. The connection is stored only in the `prpl` WizardConfiguration XML: `Chip=MC9S12DG256B`, `Language="Absolute assembly"` (ID_LANG_ABS_ASM), `Target="HCS12 Serial Monitor"` (ID_CONN_MON). Build Extras holds `prog\hiwave.exe` and `%targetFilePath -Prod=%projectFileDir\HCS12_Serial_Monitor.ini -instance=smon`.
- **The `bin\Project.absHCS12_Serial_Monitor.abs` naming is a real 5.1 pattern, not user damage.** It appears in two independent student projects (billhhh and JerchafliePeter). `bin/` holds both `Project.abs*` and `Project.absHCS12_Serial_Monitor.abs{,.s19,.phy}`.

### C5. Real-board priority: Serial Monitor first, not D-Bug12 (hw §7.5 vs the user's request)
- The user wants CodeWarrior behaviour, and CW cannot talk to D-Bug12 (EVBplus manual). The dominant curriculum (Mazidi & Causey, *HCS12 … with CodeWarrior*) uses **Dragon12-Plus + CW + AN2548 Serial Monitor**.
  - billhhh's sources say so explicitly: "with HCS12 Serial Monitor Program installed. This code is for CodeWarrior IDE"
  - Code at `ORG $4000` (flash), `LDS #$4000`, vectors via `ORG $FFFE`.
- Boards ship as either the **-DB** (D-Bug12) or **-SM** (Serial Monitor) variant, not both (https://www.almy.us/classes/ee333/EE333F13Lab1.pdf; Dragon12-Light manual).
- **Recommendation:** `SerialMonitorTarget` is the primary hardware back end. D-Bug12 is a secondary or "York-style" profile.
- **The student may have no board at home** ("I need to go into the lab"). The simulator is the primary deliverable and hardware is optional; confirm this.

### C6. Smaller corrections and contradictions
- **mcu/asm vs real .inc.** Note this as a fact rather than "from memory": CW 5.1 `.inc` lines look like `PORTB:  equ  $00000001  ;*** PORTB - Port B Register; 0x00000001 ***`, then `PORTB_BIT0: equ 0` and `mPORTB_BIT0: equ %00000001`.
  - The header comment reads `Based on CPU DB MC9S12DP512_112 … (RegistersPrg V2.28)`.
  - Memory-map equates: `EEPROMStart/End`, `RAMStart/End`, `ROM_4000Start/End`, `ROM_C000Start/End`, `PAGE_xxStart/End` (24-bit, e.g. `$00208000`). Vectors are named `Vreset`, `Vswi`, `Vtrap`, `Virq`, `Vxirq`, `Vcop`, `Vclkmon`, ….
  - In `mc9s12dp256.inc`, RAM is $1000–$3FFF and EEPROM is **$0400–$0FEF** (not $0FFF).
  - The file ends with a "DEPRECIATED SYMBOLS" block: `IFNDEF __GENERATE_APPLICATION__ … ENDIF`.
- **Students include several derivative files, not just DG256.** The samples use `mc9s12dp256.inc`, `mc9s12dp512.inc` and `mc9s12c32.inc`. The clone needs an include library on its GENPATH (`{Compiler}lib\hc12c\include`) covering at least DG256/DP256/DP512/C32, or the user's own CW 5.1 install.
- **hw:** "RAM user limit $3BFF vs $3FFF" is only a D-Bug12 conflict. Under the Serial Monitor, all of $1000–$3FFF is user RAM (minus 35 bytes of monitor stack). No contradiction.
- **ide:** `[MONITOR_HCS12_STATE] COMPORT=8` is just an instance value; billhhh has `COMPORT=1`. These keys persist the COM port.
- **ISA:** the HCS12 cycle values (MUL=1, RTC=7, TBL=6) could not be re-verified. The Utah PDF's glossary streams use font encodings my quick extractor couldn't decode. They remain the ISA author's transcription; hand-check them against rendered pages.

## Gaps filled

### G1. Absolute-assembly build pipeline (verified from real CW 5.1 artifacts)
- **Assembler command line** (from the `.note` section of the produced `.abs`):
  ```
  -CpuHCS12 -FA2 -env"GENPATH=<proj>;<proj>\bin;<proj>\prm;<proj>\cmd;<proj>\Sources;<CW>\lib\HC12c\lib;<CW>\lib\HC12c\src;<CW>\lib\HC12c\include" -env"OBJPATH=<proj>\bin" -env"TEXTPATH=<proj>\bin" -objn"<proj>\Project_Data\Standard\ObjectCode\<file>.asm.o"
  ```
- **What gets written:**
  - `Project_Data/Standard/ObjectCode/<file>.asm.o`, which is absolute ELF.
  - `<file>.asm.sx`, an S-record. Its S0 holds a path ending `…\ObjectCode\main.asm.prm`, and its **S9 carries the entry address** (`S9038000…`).
  - `bin/<file>.dbg`.
  - The IDE then produces `bin/Project.abs`, and Burner applies `burner.bbl` to give `Project.abs.s19` (logical addresses) and `Project.abs.phy`.
  - The `.s19`'s S0 holds the path of the `.abs`, and its S9 is `S9030000FC` (address 0, unlike the `.sx`).
  - Sample record: `S105FFFEC02914` (vector).
- **One `.dbg` per `.asm` file**, written to TEXTPATH=bin. It is the **source text with every INCLUDE file pasted inline at the INCLUDE line and every macro call followed by its expanded body**, and it stops at `END`.
  - The DWARF compile unit is named `<file>.dbg`, and line info refers to the `.dbg`.
  - **So hiwave's Source window shows the expanded `.dbg`**, e.g. about 12,800 lines with the derivative `.inc` inline. A faithful clone shows that file, not the raw `.asm`.
- **`END` really discards later lines.** billhhh `main.asm` has `END` before `ORG $FFFE / DC.W Entry`, and its `.sx` has no vector record.
- **Multiple `.asm` files in one absolute target:** each is assembled into its own `.o`, `.sx` and `.dbg`, but `bin/Project.abs` came from one of them (Name_LCD_Main). Which file wins is UNCERTAIN; it is probably the last one assembled, or the one with the Target column set. Lab practice is one active `.asm` per target.

### G2. `.abs` format (verified by parsing a real file)
- **ELF header:** ELF32, **big-endian** (EI_DATA=2), `e_type=2` (EXEC), **`e_machine=53` (EM_68HC12)**, `e_entry=0x4000` (from ABSENTRY), flags 0.
- **Program headers:** PT_LOAD with p_vaddr = logical address and p_paddr = 0. One per ORG block (e.g. 0x4000 size 211, 0xFFFE size 2), one empty PT_LOAD, and one PT_NOTE.
- **Sections:** `.symtab`, `.strtab`, `.debug_info`, `.debug_abbrev`, `.debug_loc`, `.debug_line`, `.debug_frame`, `_SEC000000` (NOBITS, size 0), **`_ORG00001`, `_ORG00002`** (one per ORG), `.note`, `.shstrtab`.
- **`.note`:** "HIWARE AG" records holding the tool name and version, build date, user name, timestamp, and the full option string.
- **Symbols:**
  - Code labels are STT_FUNC with a computed size (e.g. `Entry` size 87, up to the next label).
  - ABSENTRY/exported symbols are GLOBAL; others are LOCAL.
  - **EQU symbols are not emitted.**
  - Unnamed `DC.W` gets a generated name, **`VAR00001`** (an OBJECT at 0xFFFE).
- **Edge case:** a `NAME DC.B 5` placed **before the first ORG** produced no bytes and no symbol (`_SEC000000` has size 0). Exact semantics are UNCERTAIN; reproduce as "silently dropped" pending a test.
- **Recommendation:** to read CW-built `.abs` files, an ELF32-BE reader plus a DWARF2 `.debug_line` reader is enough. The clone does not need to emit DWARF.

### G3. Byte-level assembler behaviour from the samples
Checked against `Project.abs.s19`:
- `LDS #$4000` → `CF 40 00`
- `STAA DDRK` where DDRK EQU $33 is defined earlier → **direct** `5A 33`
- `JSR COMWRT4` (forward reference) → **extended** `16 40 59`
- `BCLR LCD_CTRL,RS` → `4D 32 01` (direct, **mask given without `#`**)
- `BSET` → `4C 32 02`
- `NOP` → `A7`, `RTS` → `3D`, `PSHA` → `36`
- `JMP HERE` → `06 80 0D` (no direct mode for JMP)
- `STAA SUM` with SUM EQU $4210 → `7A 42 10`
- A column-1 label without a colon (`HERE JMP HERE`, `SUM EQU …`) is accepted.
- Macros come from an INCLUDEd `.mac` file. `DISPLAY: MACRO … ENDM` is invoked as a bare `DISPLAY` and expanded inline in the `.dbg`.
- Still unconfirmed: whether a **forward reference** to a page-0 address defaults to extended. These samples have none.

### G4. How CW's Serial Monitor connection sets up breakpoints
From the real `HCS12_Serial_Monitor.ini`, `[MONITOR-HCS12_GDI_SETTINGS]`:
```
MCUID=0x03D9
HWBPD_MCUID03D9_HWBPM0=HWBPM MODE AUTOMATIC BPM22BITS 0x28 SKIP_OFF
HWBPD_MCUID03D9_BKPT_REMAP0=HWBPM REMAP_22BITS RANGE 0x4000 0x7FFF 0x3E
HWBPD_MCUID03D9_BKPT_REMAP1=HWBPM REMAP_22BITS RANGE 0xC000 0xFFFF 0x3F
HWBPD_MCUID03D9_HWBPM1=HWBPM SET16BITS 0x0 0x0 0x0 0x0
HWBPD_MCUID03D9_HWBPM2=HWBPM SET22BITS 0x0 0x0 0x0 0x0
NV_AUTO_ID=1
```
- CW drives the on-chip BKP module at $0028 in **22-bit (page-extended) mode**.
- Non-banked $4000–$7FFF is treated as page $3E and $C000–$FFFF as page $3F for the comparison.
- This partly answers hw open question 3. The register-level sequence is still per S12BKPV1.
- `[MONITOR_HCS12_STATE] ERASEONLOAD=1 ERASEEEPROM=1 COMPORT=n PROTOCOL=0` means **the default load erases all flash and EEPROM**. The clone should copy this, with a warning.

### G5. FCS `.ini` for an assembly project (verbatim structure)
- `[HI-WAVE] Target=sim, Layout=ASM_layout.hwl, CPU=HC12`, plus the `TOOLBAR=` line already in the ide note.
- `[Simulator] CMDFILE0=CMDFILE STARTUP ON ".\cmd\Full_Chip_Simulation_startup.cmd"`
- `[Simulator HC12] CMDFILE0..3` = RESET, PRELOAD, POSTLOAD, SETCPU; `HCS12_SUPPORT=1`; `FCS=MC9S12DG256B`.
- Each `.cmd` contains one comment line, e.g. `// After load the commands written below will be executed`.
- On disk the files are named with capitals (`Full_Chip_Simulation_Postload.cmd`) while the ini uses lowercase, so path resolution must be **case-insensitive**.

### G6. Firmware choice summary
| Setup | Code location | Vectors | Tool |
|---|---|---|---|
| **-SM board (CW labs, Mazidi)** | Flash $4000/$C000 | `ORG $FFxx`, redirected by the monitor to $F7xx | CW hiwave "HCS12 Serial Monitor", 115200 binary (AN2548) |
| **-DB board (York-style)** | RAM $2000 | $3E00 RAM table | Terminal `LOAD` / `G 2000`; CW used only as an assembler |

- The clone's firmware probe (hw §7.2) is the right approach.
- Detect the firmware at power-up: D-Bug12 lights the LEDs left-to-right with an "EVB MODE" LCD; the Serial Monitor lights them right-to-left.

### G7. Practical alternative to flag to the user
- **CW 5.1 SE is still the officially supported tool for DG256** (5.1 is under the "Previous" tab on NXP's product page, per the forum).
- The 5.2 SE installer (`cache.nxp.com/lgfiles/devsuites/HC12/CWS12v5.2_Win_b151201_se.exe`) is the wrong version.
- A home install of 5.1 on Windows is an option. Installation on Windows 10 reportedly has problems: https://community.nxp.com/t5/CodeWarrior-Development-Tools/LFEBS12UB-Codewarrior-will-not-install-on-Windows-10/m-p/478954
- In any case, the student's lab access or a 5.1 install should be used to **capture golden outputs**: `.abs`, `.s19`, `.dbg`, `.lst` (with `-L`), and FCS cycle counts.

## Remaining unknowns
1. **Absolute-mode multi-file behaviour:** which `.asm` becomes `bin/Project.abs`, and what "Absolute, Single-File Assembly" does when several files are in the target.
2. **Assembler encoding policy for forward references to $00–$FF addresses** (direct or extended), and 5/9/16-bit indexed choice for forward symbols. Needs `-L` listings from real CW.
3. **Data before the first ORG** (seen silently dropped once) and the default `-CpDirect`.
4. **`.mcp` chunk semantics on asm projects:**
   - The billhhh PLst shows `Sources` with **0 children** while `mtpl` lists five files (fileIdx 2, 3, 4, 0x16, 0x19).
   - `mtlo` has only 2, 3, 4.
   - So real student `.mcp` files can be internally inconsistent. The parser must be tolerant and fall back to scanning the filesystem.
   - Not decoded: Code/Data size fields, the relative-path encoding, and the `mtsl`/`mpsi`/`mtgl` chunks.
5. **What FCS does after load:**
   - Is PC set from ELF `e_entry` or from the $FFFE vector?
   - What are SP, CCR and registers at reset?
   - What do uninitialized memory ("uu") reads warn?
   - How are BGND, STOP and WAI shown?
6. **IDE Errors & Warnings wording.** Forum posts show both "error A1104: User undefined symbol: 'Entry'" and "Undeclared user defined symbol: PORTA" (https://community.nxp.com/t5/Other-NXP-Products/XDEF-Entry-and-ABSENTRY-Entry-error/td-p/416714). The exact text and layout need a screenshot.
7. **HCS12 cycle table:** MUL=1, RTC=7, TBL=6 are not re-verified. The EXG X,B → $FF:B and D↔A/B cases need a hardware or FCS test.
8. **Does the CW assembler accept both `BSET opr,#mask` and `BSET opr,mask`?** Only the no-`#` form is observed.
9. **Exact 5.1 wizard `main.asm` text** for DG256B absolute assembly, including whether `_Startup` is present.
10. **SE license limits of CW 5.1** (code-size cap for asm vs C): UNCERTAIN.
11. **MCUID 0x03D9:** whether it is CW's internal derivative ID or comes from the chip. NV_AUTO_ID=1 suggests the monitor's B7 PARTID is mapped to it.

## Key risks / open questions
1. **Ask the student:**
   - Is the lab board a Dragon12-Plus **-SM** (Serial Monitor) or **-DB**?
   - Does the lab connect with "HCS12 Serial Monitor" or P&E?
   - Does the student own a board, or is it simulator-only at home?
2. **Get one real lab project folder** (`.mcp`, `.ini`, `.hwl`, `bin/*.dbg`, `.abs`, `.s19`) plus a CW 5.1 `-L` listing. This removes most assembler and `.mcp` guesswork. The billhhh repo is a good proxy and is MIT-licensed.
3. **Reproduce the `.dbg` model** (includes and macros inlined, the debugger stepping through the expanded file). Without it, the Source window and line stepping won't feel like CW.
4. **Include files:** the clone needs DG256, DP256, DP512 and C32 `.inc` equivalents generated from datasheets (`equ $000000xx` style, `m`-prefixed masks, `Vxxx` vector names, `RAMStart`/`RAMEnd` and the other memory equates), or must import them from a user's CW install. Freescale copyright applies to the originals.
5. **Default Serial Monitor load erases all flash and EEPROM.** The clone must protect the monitor region ($F780–$FFFF) and warn.
6. **CW 5.2 is a dead end for DG256 and the Serial Monitor.** Any "use real CW for goldens" path must use 5.1.
7. **Hardware back end order:** AN2548 first, D-Bug12 second, USBDM optional. This is a change from the hw note's recommendation.
8. **Development environment:** the dev box is WSL2. Electron with serialport must be built and run on Windows (usbipd is not practical for COM ports). Assembler and simulator work can stay in WSL.

Sources: https://github.com/billhhh/hcs12_dragon12_asm (Project.mcp, *.ini, ASM_layout.hwl, bin/*.dbg, bin/Project.abs, ObjectCode/*.sx, parsed directly) · https://my.eng.utah.edu/~cs5780/10labs/Lab2counter.asm · https://www.nxp.jp/docs/en/release-note/CW-HCS12-RN.pdf · https://community.nxp.com/thread/382638 · https://community.nxp.com/t5/Classic-Legacy-CodeWarrior/How-to-Add-missing-derivatives-to-CodeWarrior-Classic-HCS12-X-5/m-p/585472 · https://community.nxp.com/t5/CodeWarrior-Development-Tools/LFEBS12UB-Codewarrior-will-not-install-on-Windows-10/m-p/478954 · https://www.almy.us/classes/ee333/EE333F13Lab1.pdf · https://www.secs.oakland.edu/~llamocca/Courses/ECE470/Lab/Dragon12_light_hcs12_manual_A.pdf · https://community.nxp.com/t5/Other-NXP-Products/XDEF-Entry-and-ABSENTRY-Entry-error/td-p/416714