# CodeWarrior for HCS12 v5.x: IDE and hiwave debugger UI and file formats (clone design notes)

**Scope.** These notes cover the classic IDE (8/16-bit IDE, about v5.9) and the "True-Time Simulator & Real-Time Debugger" (hiwave.exe) for an assembly-only Dragon12-Plus (MC9S12DG256B) clone. Anything marked **UNCERTAIN** comes from my own memory or inference and was not confirmed in a source.

**Sources read in full or in large part:**
- HC(S)12(X) Debugger Manual, rev. 18 Feb 2006 (about 600 pages, text extracted locally): https://my.eng.utah.edu/~cs5780/doc/CW_Debugger_HC12_RM.pdf
- CodeWarrior 8/16-Bit IDE User's Guide, rev. 20 Feb 2009: https://www.nxp.jp/docs/en/user-guide/CW816BITIDEUG.pdf
- CW S12(X) V5.0 Quick Start, with screenshots: https://www.nxp.jp/docs/en/supporting-information/CWS-HCS12X-V5_1-QS.pdf
- Three real wizard-generated projects whose `.mcp` files I downloaded and decoded byte by byte:
  - https://github.com/FreeRTOS/FreeRTOS/tree/main/FreeRTOS/Demo/HCS12_CodeWarrior_small (v4.x era)
  - https://www.rose-hulman.edu/class/ee/hoover/ece331/old%20stuff/Using%20CSM9S12C32%20Modules%20Stand-Alone%20with%20Serial%20Debugger/standalone1/ (v5.0, two targets)
  - https://github.com/JerchafliePeter/FPGA_Independent_Study (v5.x, MC9S12DG256B, single "Standard" target)
- Lab handouts:
  - Ryerson COE538 Lab 1: https://www.ee.torontomu.ca/~courses/coe538/Labs/lab1.pdf
  - Oakland ECE470 Lab 1: https://www.secs.oakland.edu/~llamocca/Courses/ECE470/Lab/Lab%201.pdf
  - Utah CS5780 Lab 2: https://my.eng.utah.edu/~cs5780/10labs/Lab2.pdf
  - USC EE459 HC08 assembly guide: https://ece-classes.usc.edu/ee459/library/documents/CodeWarrior-ASM.pdf
- Wizard assembly template example: https://my.eng.utah.edu/~cs5780/10labs/Lab2counter.asm
- makeprojects `.mcp` header parser: https://github.com/burgerbecky/makeprojects/blob/master/makeprojects/codewarrior.py

---

## 1. IDE main window

**Main window.** The title is "Freescale CodeWarrior". It is an MDI frame. The project window is docked on the left and shows a tab named after the project file (e.g. `Project.mcp`). The right side is the MDI area for editor windows.

**Startup dialog** (shown at launch, with a "Display on Startup" checkbox). Buttons:
- Create New Project
- Load Example Project
- Load Previous Project
- Run Getting Started Tutorial
- Start Using CodeWarrior

**Menu bar** (from V5 screenshots): File, Edit, View, Search, Project, Processor Expert, Window, Help. Some installs also show "Device Initialization".
- **There is no Debug or Run menu in the HCS12 IDE.** Debugging is done by the external hiwave.exe. The Debug command lives in the Project menu.

**File menu** (8/16 IDE UG Table 22.1):
- New Text File; New (wizard or stationery); Open; Find and Open File; Close
- Save; Save All; Save As; Save A Copy As; Revert
- Open / Close / Save / Save Workspace As
- Import Components; Close Catalog
- **Import Project** (XML to .mcp); **Export Project** (.mcp to XML)
- Page Setup; Print; Open Recent; Exit

**Edit menu:**
- Undo, Redo, Cut, Copy, Paste, Delete, Select All
- Balance, Shift Left, Shift Right
- Get Previous Completion, Get Next Completion, Complete Code
- Preferences
- **"<TargetName> Settings…"** (the label changes with the active target; Alt+F7 according to the wizard readme)
- Version Control Settings; Commands & Key Bindings

**View menu:**
- Toolbars; Project Inspector; Browser Contents; Class Browser; Class Hierarchy
- Build Progress; **Errors & Warnings Window**
- Processes, Expressions, Global Variables (inactive for an external debugger)

**Search menu:**
- Find, Replace, Find in Files, Find Next, Find In Next File
- Enter Find String, Find Selection, Replace Selection, Replace and Find Next, Replace All
- Find Definition, Go Back, Go Forward, Go to Line
- Compare Files, Apply Difference, Unapply Difference

**Project menu:**
- Add Window, Add Files, Create Group, Create Target
- Check Syntax, Preprocess, Precompile, **Compile**, Disassemble
- Bring Up To Date, **Make**, Stop Build, Remove Object Code
- Re-search for Files, Reset Project Entry Paths, Synchronize Modification Dates
- Run, **Debug**, Set Default Project, Set Default Target

**Window menu:** Close, Close All, Cascade, Tile Horizontally, Tile Vertically, Save Default Window, then a list of open windows.

**Help menu:** CodeWarrior Help, Index, Search, Freescale Website, About Freescale CodeWarrior (with an Installed Products button).

**Keyboard shortcuts:**
- Confirmed: Project > Debug is F5 (wizard readme); target settings is Alt+F7 (readme).
- UNCERTAIN (from memory): Make F7, Compile Ctrl+F7, Bring Up To Date Ctrl+U, Find Ctrl+F, Find Next F3, Find in Files Ctrl+Shift+F, Go to Line Ctrl+G, Balance Ctrl+B, Shift Left/Right Ctrl+[ and Ctrl+].

## 2. New Project Wizard ("HC(S)12(X) Microcontrollers New Project")

The left pane is a "Wizard Map" of pages. Buttons are Back, Next, Finish, Cancel.

1. **Device and Connection.**
   - A derivative tree: HC12, HCS12, HCS12X families. For the Dragon12 the path is HCS12 > HCS12D Family > MC9S12DG256B.
   - A "Connections" list:
     - Full Chip Simulation
     - P&E Multilink/Cyclone Pro
     - SofTec HCS12
     - Abatron BDI
     - HCS12 Serial Monitor
     - TBDML (on some versions)
   - A description box under the list.
   - In the debugger-manual version of the wizard, multiple connections can be selected.
2. **XGATE Setup** (HCS12X parts only).
3. **Project Parameters.**
   - Language checkboxes: Absolute assembly, Relocatable assembly, C, C++.
   - "Project name:" (the default is `Project.mcp`; the IDE adds `.mcp` and creates a folder of the same name).
   - "Location:" with a Set… button.
   - Lab handouts check **only Absolute assembly**.
4. **Add Additional Files.**
   - A file-system tree with Add and Remove buttons and a "Project Files" list.
   - "Copy files to project" checkbox.
   - **"Create main.c/main.asm file"** checkbox.
5. C/C++ Options, Memory model options, PC-Lint. These do not apply to assembly-only projects.
6. Finish. The IDE generates the folder and the project window appears.

**Generated `main.asm`** (absolute assembly):
- Contains `XDEF Entry`, `ABSENTRY Entry`, `INCLUDE 'derivative.inc'` (some versions write `'mc9s12xx.inc'` directly) and `ROMStart EQU $4000`.
- The data section uses `ifdef _HCS12_SERIALMON / ORG $3FFF-(RAMEnd-RAMStart) / else ORG RAMStart`.
- Sample variables `Counter DS.W 1` and `FiboRes DS.W 1`.
- Code at `ORG ROMStart`, `Entry:`, then the serial-monitor INITRG/INITRM/INITEE remap block, then `LDS #RAMEnd+1`.
- A Fibonacci loop.
- `ORG $FFFE / DC.W Entry ; Reset Vector`.
- The full text is in Lab2counter.asm (link above).
- The Serial Monitor target defines `-D_HCS12_SERIALMON` in the assembler and compiler options (seen in the `.mcp`: ` -CpuHCS12 -Ms -D_HCS12_SERIALMON=1`).

## 3. Project window

**Toolbar** (UG Table 4.1 and screenshots), left to right:
- **Current Connection/Target drop-down** with an icon (e.g. "Full Chip Simulation", "P&E Multilink/Cyclone Pro")
- **Change MCU/Connection** (chip icon)
- Target Settings
- **Synchronize Modification Dates** (red check mark)
- **Make**
- **Debug** (green arrow with a bug)
- Run and Project Inspector also exist.

**Tabs:** Files, Link Order, Targets. Processor Expert adds a tab when it is enabled.

**Files tab columns:**

| Column | Header | Content |
|---|---|---|
| Touch | red check-mark icon | A red check means the file is touched or needs compiling. Click to toggle. Click the header to sort. |
| File | "File" | Hierarchical groups (folder icons) and files. Double-click opens the file. |
| Code | "Code" | Object code size. Shows `n/a` for non-code files such as .prm, .map, .bbl. |
| Data | "Data" | Data size. |
| Target | dot | Black dot = file is in the current target. Shown only when there is more than one target. |
| Debug | bug icon | Dot = debug info generated. Click to toggle. |
| Checkout Status | — | VCS only. |
| Interfaces | small pop-up arrow | Lists the #include files of a source, or the files in a group. |

- The footer row shows "N files" plus total Code and Data.
- The right-click menu includes "Open in Windows Explorer".

**Typical groups:**
- V5 C template: Sources, Includes, Project Settings > Linker Files, Libs.
- V5 assembly project (from the USC screenshot): Sources (`main.asm`), Includes (`derivative.inc`, `mc9s12dg256.inc`), Project Settings > Linker Files (`burner.bbl`, `Project.prm`, `Project.map`).
- V5.0 multi-target project: Sources, Startup Code, Prm, Linker Map, Libraries, **Debugger Project File** (`*.ini`), **Debugger Cmd Files** > `Full_Chip_Simulation` / `HCS12_Serial_Monitor` (`*_Startup.cmd`, `*_Reset.cmd`, `*_Preload.cmd`, `*_Postload.cmd`, `*_SetCPU.cmd`).
- UNCERTAIN: assembly-only absolute projects may omit the Linker Files and Startup groups. In absolute assembly the assembler emits the .abs directly and the linker is not used.

**Link Order tab:** the per-target file order. It has Synchronize Modification Dates and Synchronize Status (pencil) buttons.

**Targets tab:** the target list. One icon marks the active target and another marks inactive targets. A Link column shows dependencies.

**Build targets and connections differ between versions** (confirmed from the real `.mcp` files):
- **v4.x (FreeRTOS demo):** targets were named per connection, e.g. "Simulator" and "SofTec". The IDE launched the debugger with `%targetFilePath -W -Prod=%projectFileDir\Simulator.ini -instance=sim`.
- **v5.0 (Rose-Hulman project):** **one build target per selected connection, named "Full Chip Simulation" and "HCS12 Serial Monitor".** File and folder names use underscores: `Full_Chip_Simulation.ini`, `Full_Chip_Simulation_linker.prm`, `bin\Full_Chip_Simulation.abs`, `<proj>_Data\Full_Chip_Simulation\`. Debugger arguments:
  - `%targetFilePath -Prod=%projectFileDir\Full_Chip_Simulation.ini -instance=sim`
  - `%targetFilePath -Prod=%projectFileDir\HCS12_Serial_Monitor.ini -instance=smon`
- **Later v5.x (DG256B student project):** a **single target named "Standard"**. The connection is stored in an embedded wizard XML (`<SelectedWizardElement name="Target" term="HCS12 Serial Monitor" id="ID_CONN_MON"…>`), and "Change MCU/Connection" rewrites the settings. The output name seen there was `bin\Project.absHCS12_Serial_Monitor.abs`. UNCERTAIN whether that is a standard pattern or user damage. Lab handouts on similar setups mention `bin\Project.abs.s19`.
- **The clone must handle both the multi-target and the "Standard" styles.**

## 4. Target Settings window (Edit > "<target> Settings…")

**Layout:** a tree of panels on the left grouped as Target, Language Settings, Code Generation, Linker, Editor, Debugger. Buttons: Factory Settings, Revert Panel, Export Panel (XML), Import Panel, OK, Cancel, Apply.

**Panels stored in a real HCS12 V5 `.mcp`:**
- Source Trees; Access Paths; Target Settings; File Mappings; Build Extras; Custom Keywords; PEOptions
- Panel for Assembler for HC12; Burner for HC12; Compiler for HC12; Importer for HC12; Libmaker for HC12; Linker for HC12
- The same tool panels for XGATE
- OSEK Sysgen Panel; BatchRunner Panel; BatchRunner PreLinker Panel; PCLint Options; PCLint Main Settings; External Build Panel; Simulink(r)
- v4.x additionally had Debugger Runtime, Debugger Target, Remote Debug, Auto-target, Analyzer Connections.

**Panels that matter for an assembly clone:**
- **Target Settings:** Target Name (26 characters or fewer), Linker (e.g. "Linker for HC12"; for absolute assembly the selection may differ, UNCERTAIN), Pre-linker, Post-linker, Output Directory (e.g. `bin`), "Save project entries using relative paths".
- **Access Paths:** User Paths and System Paths lists with search/recursive flags; path types are Absolute, Project, CodeWarrior, System, Source tree; options "Always Search User Paths" and "Source relative includes". The real project had `{Project}` paths `bin`, `prm`, `cmd`, `Sources` and `{Compiler}` paths `lib\HC12c\lib`, `lib\HC12c\src`, `lib\HC12c\include`.
- **Build Extras:** "Use modification date caching", Cache Subprojects, Generate Browser Data From, **Use External Debugger**, Application `{Compiler}prog\hiwave.exe` (stored as `prog\hiwave.exe` relative to the compiler root), **Arguments** as listed above.
- **File Mappings:** maps extensions to plug-ins.
  - `.asm`, `.s`, `.inc`, `.dbg` go to "Assembler for HC12" (`mwe_asm_HC12`).
  - `.c`, `.h` and similar go to the compiler.
  - `.prm` goes to `mwe_prm`; `.bbl` to `mwe_bbl`.
  - `.abs`, `.elf`, `.lib`, `.obj` go to "Importer for HC12".
  - `.ini`, `.cmd`, `.map`, `.s19`, `.txt` are plain text (no plug-in).
- **Assembler for HC12 panel:** stores the option string, e.g. ` -CpuHCS12 -Ms` (Serial Monitor adds `-D_HCS12_SERIALMON=1`). It has a "Messages…/Options…" style dialog. UNCERTAIN: exact UI; this belongs to the assembler-manual topic.
- **Linker for HC12 panel:** prm file name (e.g. `Full_Chip_Simulation_linker.prm`), output `Full_Chip_Simulation.abs`, and a default/template prm name (`MC9S12C32.prm`).
- **Burner panel:** runs `burner.bbl`, which produces `%ABS_FILE%.s19` (logical S-record) and `%ABS_FILE%.phy` (physical addresses).

## 5. Editor and Errors & Warnings window

**Editor window parts:**
- Toolbar pop-ups: Interfaces ({}), Functions (M), Markers, Document Settings (syntax-coloring toggle and EOL format), VCS.
- "Path:" caption; file-modification icon.
- Text area; "Line N  Col N" indicator at bottom left; pane splitter.
- Preferences panels: Editor Settings, Font & Tabs, Text Colors, Custom Keywords, Code Completion.
- Screenshot colors for C: keywords blue, comments red, normal text black. UNCERTAIN: default coloring for .asm (likely only Custom Keywords and comments). The **debugger's** Source window uses keywords blue, comments green, strings red (debugger manual).

**Errors & Warnings window** (View > Errors & Warnings Window; opens automatically after Make when there are messages):
- Confirmed: it exists and is printable.
- UNCERTAIN (from memory): toolbar filter toggles with counts for Errors, Warnings and Messages; a list of entries such as `Error : A1104: Undeclared user defined symbol: FOO` followed by `main.asm line 42`; a lower pane showing the source context; double-click jumps to the editor line.

## 6. Debugger: hiwave.exe, the "True-Time Simulator & Real-Time Debugger"

**Launch:**
- `HIWAVE.EXE [<abs>] {-options}`. Options:
  - `-T=<s>` test-mode timeout
  - `-Target=<sim|...>` sets the connection
  - `-W` wait (do not run after load)
  - `-Instance=<name>` reuse an existing debugger instance
  - `-Prod=<file.ini|.pjt>` project file
  - `-Nodefaults`
  - `-Cmd="..."` run a command
  - `-C <cmdfile>`
  - `-Env<VAR>=<value>`
- Start-up order:
  1. Load the project file (default `project.ini`).
  2. Load the .abs.
  3. Run the command file given by `-C`.
  4. Run the command given by `-Cmd`.
  5. Start running unless `-W` was given.
- Window title: `True-Time Simulator & Real-Time Debugger  <path>\Full_Chip_Simulation.ini`.

**Menu bar:**
- File, View, Run, **<Connection>** (e.g. "HC12FCS"/"HCS12 FCS", "MONITOR-HCS12", "MultilinkCyclonePro"), Component, **<active component's menu>** (Source, Assembly, Memory, Data, Register…; can be turned off with Window > Options > Component Menu), Window, Help.
- File: New, Load Application (with recent .abs list), Open Configuration (.ini/.pjt/.hwc), Save Configuration, Save Project As, Configuration (Preferences dialog for environment variables), recent project list, Exit.
- View: Toolbar, Status Bar, Hide Title, Hide Headline, Small Borders, Customize (Customize Toolbar dialog).
- Run (with shortcuts):

| Command | Shortcut |
|---|---|
| Start/Continue | F5 |
| Restart | Ctrl+Shift+F5 |
| Halt | F6 |
| Single Step | F11 |
| Step Over | F10 |
| Step Out | Shift+F11 |
| Assembly Step | Ctrl+F11 |
| Assembly Step Over | Ctrl+F10 |
| Assembly Step Out | Ctrl+Shift+F11 |
| Control Points… | — |

- Component: Open… (Open Window Component dialog with Icon, List and Details tabs; multi-select allowed), Set Connection… (Processor and Connection combo boxes plus an info box), Fonts, Background Color.
- Window: Cascade, Tile, Arrange Icons, Options (Autosize, Component Menu; both on by default), Layout (Load/Store `.hwl`).
- Help: Help Topics, About (with "Extended Information").

**Default toolbar** (screenshot plus the `TOOLBAR=` key in the ini):
- New, Open, Save | Cut, Copy, Paste | Help, Context Help | **Start/Continue (green →)**, **Single Step**, **Step Over**, **Step Out**, **Assembly Step**, **Halt (red)** | **Reset Target (red circle)**.
- The ini stores `TOOLBAR=57600 57601 32795 0 57635 57634 57637 0 57671 57669 0 32777 32776 32782 32780 32781 32778 0 32806`. 0 is a separator; the 5760x/5763x/5766x values are standard MFC IDs.
- UNCERTAIN: the exact mapping of 32776 to 32806, inferred from the button order as Start, Step, StepOver, StepOut, AsmStep, Halt, Reset.

**Status bar** (FCS):
- Contents: "For Help, press F1" | CPU frequency (e.g. `2.000000 MHz`; click opens Clock Frequency Setup) | CPU cycles (64-bit) or elapsed time (double-click resets) | derivative (e.g. `mc9s12dg256b`; click opens Set Derivative) | run state.
- Run-state strings include RUNNING, HALTED, Breakpoint, STEPPED, TRACED, STOPPED, "STEP INTO", "STEP OUT".

**Default layout** (`C_Layout.hwl` is a command script; coordinates are percentages of the main window):
```
OPEN source 0 0 60 39          / OPEN assembly 60 0 40 31
OPEN procedure 0 39 60 17      / OPEN register 60 31 40 25
OPEN memory 60 56 40 22        / OPEN data 0 56 60 22 (Data:1 global)
OPEN data 0 78 60 22 (Data:2 local) / OPEN command 60 78 40 22
Assembly < attributes ADR on,CODE off,ABSADR on,SYMB off,TOPPC 0xF88C
Register < attributes FORMAT AUTO,COMPLEMENT None
Memory < attributes FORMAT hex,COMPLEMENT None,WORD 1,ASC on,ADR on,ADDRESS 0x80
Data:1 < attributes SCOPE global,...,FORMAT Symb,MODE automatic,UPDATERATE 10,NAMEWIDTH 16
Command < attributes CACHESIZE 1000
bckcolor 50331647 / font 'Courier New' 9 BLACK / AUTOSIZE on / ACTIVATE ...
```

**General component behaviour:**
- Each component has a title bar ("Source", or "Memory:2" when there are several), an **Object Info Bar** (headline), its own main menu and a right-click pop-up.
- **Drag and drop between components is a core feature.** Examples: register to Memory dumps at the register's value; Assembly to Register loads the PC; Data name to Memory dumps at the variable; Memory to Command appends the range.
- Mouse+key gestures: hold the left button and press a key letter in a component, e.g. T temporary breakpoint, P permanent breakpoint, S breakpoint with Setup dialog, D delete, R/W/B read/write/read-write watchpoint, A jump to address.

**Source component:**
- Read-only viewer with chroma coding. Info bar shows the full path and "Line: N" (first visible line).
- For assembly projects the source is located via the `.dbg` file, searched in OBJPATH/GENPATH. In ELF, assembler module names have the `.dbg` extension.
- The current PC statement is highlighted.
- Breakpoint icons appear in the left margin; the debugger manual shows a red arrow-style marker. Optional "Marks" show small red triangles where breakpoints are possible.
- Folding/unfolding; tooltips showing variable values (Enable, Mode, Format).
- Pop-up menu: Set/Delete/Enable/Disable Breakpoint, Run To Cursor, Show Breakpoints, Show Location, Set/Delete/Show Markpoints, **Set Program Counter**, Open Source File, Copy (Ctrl+C), Go to Line (Ctrl+G), Find (Ctrl+F), Find Procedure (Ctrl+I), Foldings, Marks, ToolTips.

**Assembly component:**
- Shows address, machine code (optional), instruction, and absolute target address for branches. Current PC is highlighted; breakpoint symbols shown; info bar shows the procedure name.
- Menu: Address… (Show PC dialog), Display Code, Display Symbolic, Display Address, Display Absolute Address.
- Pop-up: the breakpoint items, Run To Cursor, Show Breakpoints, Show Location, Markpoints. Labs right-click here and choose "Set Breakpoint".
- Listing format (Ryerson lab): `4000 B63000   LDAA 0x3000`.

**Register component:**
- Registers for HCS12: D, A, B, IX, IY, IP, PC, SP, CCR, PPAGE (screenshot), plus CCR bits S X H I N Z V C.
- Set bits are drawn dark and clear bits grey; double-click a bit to toggle it.
- Values that changed are shown in **red**, except the CCR bits.
- Info bar: "HC12  CPU Cycles: 42" and "Auto".
- Double-click a register opens an in-place edit box: Esc cancels, Enter commits, Tab commits and moves to the next register.
- Hold the left button + A to show that address in Source, Assembly and Memory.
- Format menu: Hex, Bin, Oct, Dec, UDec, Float, Auto, Bit Reverse.

**Memory component:**
- Address column, data, and an ASCII column (Display > Address and Display > ASCII toggles).
- Menu:
  - Word size: Byte, Word, Lword
  - Format: Hex, Bin, Oct, Dec, UDec, Bit Reverse
  - Mode: Automatic, Periodical, Frozen
  - Display; Fill… (from, to, value, "Hex Format"); Address… (Display Address dialog); CopyMem; Search Pattern; Update Rate (in 100 ms steps)
- **"uu" means uninitialized; "--" means unconfigured (no memory).**
- **Values changed since the last refresh are red**; rewriting the same value stays black.
- Double-click a byte to edit it; Tab moves to the next byte. Drag to select a range.
- Watchpoint ranges are underlined: read green, write red, read/write black (the pop-up's Set Watchpoint text says yellow).
- Pop-up: Set/Delete/Show Watchpoints, Set/Show Markpoints, Show Location.

**Data component** (Data:1 global, Data:2 local):
- Columns: name, value, type. Changed values are red.
- Info bar: module or procedure name, mode ("Auto"), format ("Symb"), scope ("Global"/"Local").
- Menu:
  - Zoom
  - Scope: Global, Local, User
  - Format: Symbolic, Hex, Bin, Oct, Dec, UDec, Bit Reverse (selected item or all items)
  - Mode: Automatic, Periodical, Locked, Frozen
  - Options: Pointer as Array, Name Width
  - Sort
- Double-click a variable to edit it. Double-click a blank line to open Edit Expression; user expressions are saved to `<app>.xpr`.
- Watchpoint bars on the left of a variable: read = green, write = red, read/write = yellow, with Setup dialog = grey.
- Pop-up: Open Module…, Set/Delete/Enable/Disable/Show Watchpoint(s), Show Location.
- UNCERTAIN: what the Data window shows for pure absolute-assembly programs (probably labels from DS directives with byte or word types).

**Procedure component:** the call chain, newest on top. Menu: Show Values, Show Types. Double-click a frame to sync the other windows. UNCERTAIN: how useful it is for assembly (it relies on stack-frame info).

**Command component:**
- Prompt `in>`. Command echo is blue, responses black, errors red; the FCS warnings that appear in screenshots are shown in green.
- Up/Down arrows or F3 recall history (10 entries); Esc clears the line; Home, End, PgUp, PgDn work.
- Menu: Execute File… (.cmd), Copy, Paste, Cache Size.
- The busy message is "Command Component is busy. Closing will be delayed".
- Typical post-load output: `Postload command file correctly executed.`, `main 0x8000 T`, `STARTED`, `RUNNING`, `Breakpoint`.

**Other components in Component > Open:** Coverage, Profiler, Recorder, SoftTrace, Module, Inspector, **VisualizationTool**, Terminal, TestTerm, Stimulation, IO_Led, Led, Phone, Monitor, Push Buttons, Programmable IO_Ports, 7-Segments Display, Wagon, Analog Meter, ADC/DAC, IT_Keyboard, LCD, Signal IO / Pinconn, DA-C Link, MicroC.

**Control points** (Run > Control Points…, the "Controlpoints Configuration" dialog with Breakpoints, Watchpoints and Markpoints tabs):
- Breakpoint types: Temporary (deleted when hit; set by Run To Cursor), Permanent, Counting, Conditional. Each kind has its own margin icon.
- Breakpoints tab:
  - A list of breakpoints with Shift/Ctrl multi-select.
  - "Breakpoint:" group: Address (hex or expression), procedure name, Disable, Temporary.
  - "Condition:" group: ANSI-C expression, registers as `$RegisterName`, Disable. A bad entry gives "Incorrect Condition. Do you want to correct it?".
  - "Command:" group: one debugger command (G, GO and STOP are not allowed; `CF file.cmd` is allowed), Disable, Continue.
  - "Counter:" group: Current and Interval (maximum 2,147,483,647). Current counts down each hit; the program halts at 0; a non-temporary breakpoint reloads from Interval.
  - "Save & Restore on load" checkbox. Buttons: Delete, Update, Add, OK, Cancel, Help.
- Watchpoints: Read, Write, Read/Write, Counting and Conditional, over an address range, with the same fields.
- Markpoints: named bookmarks in source, data or memory.
- Breakpoints persist in **`<app>.BPT`** next to the .abs:
  ```
  savebp on
  BS &fibo.c:main+21 P E; cond = "fiboCount==5" E; cmd = "Assembly < spc 0x800" E; cdSz = 42 srSz = 0
  ```
  A breakpoint is re-enabled on reload only if the function's code size and source size are unchanged.

**Command language** (Book IV). Syntax `[component[:n] <] command`; case-insensitive; `cmd?` prints usage. Numbers: `$FF`, `0xFF`, `0377`. Ranges: `a..b` or `a,size`.
- Kernel (command files only): A, AT, CALL file [;C][;NL], DEFINE, UNDEF, IF/ELSEIF/ELSE/ENDIF, FOR/ENDFOR, WHILE/ENDWHILE, REPEAT/UNTIL, GOTO, GOTOIF, FOCUS/ENDFOCUS, PRINTF, FPRINTF, PAUSETEST, TESTBOX, R, **WAIT [time in 0.1 s][;s]** (no argument = 5 s; `;s` waits until the target halts).
- Base:
  - Breakpoints: **BS** `addr|func [{mark}] [P|T[E|D]][;cond=..][;cmd=..][;cur=.. inter=..][;cdSz=.. srSz=..]` (default P); **BC** `addr|*`.
  - Memory display/set: DASM [addr|range][;OBJ]; **DB/DW/DL** [addr|range]; **MS/WB** range list; WW; WL; MEM (memory map table).
  - Execution: **G/GO** [addr]; **S/STOP**; **T** [addr][,count 1..65535] (trace into; prints registers and the disassembled next instruction); **P** [addr] (step over BSR/JSR/SWI); STEPINTO; STEPOVER; STEPOUT; RESTART.
  - Registers: **RD** {list|CPU|*}; **RS** reg[=]val{,…}.
  - Logging/misc: CD, CR/NOCR (record), LF/NOLF/LOG (log), SAVEBP on|off.
- Environment: ACTIVATE, AUTOSIZE, BCKCOLOR, CLOSE, DDEPROTOCOL, FONT, **LOAD** [abs] [CODEONLY|SYMBOLSONLY] [NOPROGRESSBAR] [NOBPT] [NOXPR] [NOPRELOADCMD] [NOPOSTLOADCMD] [DELAY] [VERIFY…], LOADCODE, LOADSYMBOLS, **OPEN** comp [x y w h][;I|;MAX], SET target, SLAY file.
- Component: CMDFILE kind ON|OFF "file", EXIT, HELP, RESET, SMEM range, SMOD module, SPC addr, SPROC level, VER.
- Component-specific: ADDXPR, ATTRIBUTES list (per component, e.g. `ADR ON, CODE ON, ABSADR, SYMB, TOPPC, SMEM, SPC`; Register `FORMAT BIN`; Memory `ASC OFF, ADR OFF`; Data `MODE FROZEN`), BD, CF, CLOCK, COPYMEM, CYCLE, DUMP, **E** expr[;O|D|X|C|B], EXECUTE (stimulation file), FILL range val, FIND, FINDPROC, FOLD/UNFOLD, FRAMES, LS, NB, PTRARRAY, RECORD, SAVE range file (S-records), **SREC** file [offset], SLINE, TUPDATE, UPDATERATE, ZOOM.
- FCS-only: `warning_setup`, MESSAGE_HIDE_ID, MESSAGE_HIDE_RES.
- **Serial-Monitor-style aliases from the Ryerson HELP listing:** VER, LOAD, EXIT, RESET, HELP, BS, STEPINTO, STEPOUT, STEPOVER, RESTART, BC, BD, G/GO, S/STOP, P, T, RD, RS, DB, DW, DL, WB/MS, WW, WL, MEM, DASM, SREC, CALL, SPC, SMEM, FILL, DUMP, **CLR** (clear window), PROTOCOL. Students use exactly these.
  - DB output format: `4000: CF 40 00 10 EF 86 FF 7A 02 44 7A 02 62 41 7A 02 .@.....z.Dz.bAz.`
  - Manual example: `8000: FE 80 45 FD 80 43 27 10-35 ED …`, with a dash between bytes 7 and 8.

**Command-file hooks:**
- Default files are STARTUP.CMD, RESET.CMD, PRELOAD.CMD, POSTLOAD.CMD, plus SETCPU.CMD for FCS only. The wizard generates per-connection files in `cmd\`.
- When each runs:
  - Startup: after the connection is loaded.
  - Reset: on the connection's Reset command.
  - Preload: before loading an .abs or S-records.
  - Postload: after loading.
  - SetCPU: when the FCS CPU is set or changed.
- They are configured in **<Connection> > Command Files**, a dialog with one tab per event, a Browse button and "Enable Command File". They are stored in the ini as `CMDFILE0=CMDFILE STARTUP ON ".\cmd\..."`.
- Generated contents are comment lines only, e.g. `// After load the commands written below will be executed`. The postload file of some C templates contains `FindProc main`.

**Full Chip Simulation (FCS) connection:**
- Menu "HCS12 FCS": Load, Reset, Set Derivative, Configure (Memory Configuration, saved to `default.mem`, binary), Reset Ram, Reset Mem (to "undefined"), Reset Statistic, Load I/Os, Close I/Os, Clock Frequency, Command Files, Bus Trace.
- Set Derivative also offers "HC(S)12(X) CORE" (instructions only) and "SAMPLE" (register block, memory expansion, CRG, **SCI0** and PortB).
- **MC9S12DG256B is a supported derivative.** Simulated modules: ATD, CRG, ECT, EEPROM, FTS flash, IIC, MEBI, MSCAN, PIM, PWM, **SCI**, SPI, VREG.
- Accesses to unimplemented registers print `FCS Warning (ID 12): reading from unimplemented register at pc = 0x400a'L …` in the Command window.
- The Load Executable dialog has: Open; Load Code / Load Symbols / Verify Code; "Automatically erase and program into FLASH and EEPROM"; "Verify memory image after loading code"; "Run after successful load"; "Stop at Function".
- The ini stores `LoadDialogOptions=AUTOERASEANDFLASH RUNANDSTOPAFTERLOAD="main"`. UNCERTAIN: what an assembly project stores for the stop function (likely Entry or none).

**VisualizationTool:**
- Edit and Display modes (Ctrl+E). Right-click "Add New Instrument" offers Analog, Bar, Bitmap, DILSwitch, Knob, LED, 7-Segment Display, Switch, Text, Chart, and others.
- Instrument properties (double-click or Ctrl+P): X/Y position, Height, Width, Bounding Box, Background color, **Kind of Port** (Memory, Variable, Register, Subscribe, Substitute), **Port to Display** (e.g. `0x210`, `PORTB`), Size of Port (up to 4 bytes), and **bitnumber to display** for LEDs.
- Tool-level properties: grid, refresh mode (Automatic, Periodical, Each access, CPU Cycles).
- Layouts are saved as `*.vtl`. The Utah lab uses it to make 3 LEDs from PTAD bits.
- A Dragon12 panel (8 PORTB LEDs, 4-digit 7-segment display, DIP switches on PTH, pushbuttons) can be built from these instruments. I found no official Dragon12 .vtl.

**Terminal component (simulated SCI):**
- Configure Connections dialog: default configurations, From/To devices (keyboard, display, virtual SCI, serial port, files), Serial Port settings, Virtual SCI port names.
- The default virtual SCI uses object `Sci0` (`Sci0.SerialInput` for writes, `Sci0.SerialOutput` subscription).
- Input File and Output File items; escape sequences `ESC h 1`…`ESC h 7` for file control.
- Cache Size setting.

**HCS12 Serial Monitor connection (real Dragon12):**
- Set Connection: Processor HC12, Connection "HCS12 Serial Monitor".
- **Monitor Setup** window:
  - Monitor Communication tab: "HOST Serial Communication Port" drop-down; "Show Monitor TX/RX" (logs frames to the Command window).
  - The monitor reads the silicon ID, then shows the **Derivative Selection** dialog (SDID/PARTID can match several parts).
  - Vector Table Mirroring tab: Enable Vector Table Mirroring, Monitor Start Address, Vector Table Address, Vectors reserved by Monitor, **Auto Detect**.
- Menu "MONITOR-HCS12": Monitor Communication…, Vector Mirroring Setup…, Erase Flash, Trigger Module Settings…, Bus Trace, Select Derivative.
- Labs also see a confirm dialog "Erase and program flash?" on load.
- Ini keys: `Target=HCS12SERIALMON`; `[MONITOR-HCS12_GDI_SETTINGS] MCUID=0x03D9`, `HWBPD_…` (hardware breakpoint module), `NV_…`; `[HCS12 Serial Monitor] COMSETTINGS=SETCOMM DRIVER NOPROTOCOL NOPERIODICAL`; `[MONITOR_HCS12_STATE] ERASEONLOAD=1 ERASEEEPROM=1 COMPORT=8 PROTOCOL=0`.
- The protocol is in NXP AN2548 (https://www.nxp.com/docs/en/application-note/AN2548.pdf). Oakland's Dragon12 lab requires **SW7 left switch in the LOAD position**. Breakpoints in flash use the on-chip DBG/BKP module; the Ryerson lab notes RAM breakpoints work by SWI substitution.

## 7. Debugger project file (`<Connection>.ini`, Windows INI)

```
[Environment Variables]  GENPATH={Project}Sources;{Compiler}lib\hc12c\src;... LIBPATH=... OBJPATH={Project}bin TEXTPATH={Project}bin ABSPATH={Project}bin
[HI-WAVE]  Target=sim|HCS12SERIALMON|gdi  Layout=C_layout.hwl  LoadDialogOptions=AUTOERASEANDFLASH RUNANDSTOPAFTERLOAD="main"  CPU=HC12  MainFrame=2,3,-1,-1,-1,-1,x1,y1,x2,y2  TOOLBAR=...
[Simulator]       CMDFILE0=CMDFILE STARTUP ON ".\cmd\Full_Chip_Simulation_startup.cmd"
[Simulator HC12]  CMDFILE0..3= RESET/PRELOAD/POSTLOAD/SETCPU ...  HCS12_SUPPORT=1  FCS=MC9S12DG256B
[Recent Applications File List] File0=...\bin\Full_Chip_Simulation.abs  LoadFlags0=...
[Recent Layout File List] File0=C_layout.hwl
```

Other files the debugger writes next to the .abs: `.bpt` (breakpoints), `.xpr` (Data-window expressions), `default.mem` (FCS memory configuration, binary), `.vtl` (visualization layout), `.hwl` (window layout).

## 8. The `.mcp` binary format (decoded from 3 real files)

I found no public specification or full parser. makeprojects reads only the header and the target-name strings. The layout below is consistent across all three files.

**Header** (little-endian on Windows; the magic bytes are `"looc"`, i.e. `'cool'` stored LE; big-endian Mac files use `"cool"`):
- +0: magic
- +4: u32 3
- +8: u32 0x128 (offset of the first chunk)
- +12: u32 (offset of a free block)
- **+16: u32 index-table offset**
- +20: u32 index size = 24 × N
- +24: u32 N (number of entries)
- +28: version bytes `02 03 04 00`
- +40: ASCII `"CodeWarrior Project"`

**Index table** (at the end of the file): N × 24-byte entries `{u32 offset, u32 size, u32 tag (4CC as a LE u32 of e.g. 'mstr'), u32 id, u32 seq, u32 0}`.

**Chunk tags:**
- **`mstr`** (id 0): NUL-separated **"Target:Panel"** strings plus "Project File List" and "HC12 Wizard Configuration". Target names are the prefix before the colon.
- **`mstr`** (id 0x3E8): pool of **file names (bare names, no directory)**, group names and plug-in names.
- **`mstl`**: 12-byte records `{u32 offsetInPool, u32 stringId (1-based), u32 0}`.
- `mstn`: sorted name index (for lookup).
- **`mtpl`** (id = target number 1, 2, …): one 40-byte record per file in that target: `{u32 ref = fileIdx | target<<24, u32 nameStringId, u32 flags 0x0202, …, u32 0x00010001 (likely the debug flag)}`.
- `mtlo`: link order (list of u32 refs). `mtps`: sorted order. `mtsl`, `mtpi`, `mtgl`, `moti`, `msti`, `mall`, `mapl`, `mpsi`: bookkeeping, not decoded.
- **`PLst`** ("Project File List", the group tree):
  - `u16 1, u32 ?, 'TOOR'(ROOT) u32 0 u32 0 pstr"" u32 childCount`
  - children: `'PURG'(GRUP) u32 0 u32 groupId pstr name u32 childCount …`
  - and `'ELIF'(FILE) u24 fileIdx u8 targetNo`. A file belonging to several targets appears once per target.
- **`pref`**: one per Target:Panel. The `seq` field is the 1-based string id of its "Target:Panel" name in mstr(0). Payloads seen:
  - Target Settings: target name, linker name, output dir `bin`.
  - Access Paths: `bin`, `prm`, `cmd`, `Sources`, `lib\HC12c\…`.
  - Build Extras: `prog\hiwave.exe` and the argument string.
  - HC12 tool panels: header `01 01 00 00`, `u32 dataOffset (0x28)`, `u32 0x18`, `u32 count`, then option strings such as ` -CpuHCS12 -Ms`; the Linker panel holds the prm name, abs name and template prm.
- **`prpl`**: project-level preferences, including the embedded **`<WizardConfiguration version="1.3">` XML** (Chip, Target/connection, Language, …).

**Implications for the clone:**
- Reading target names, file lists, groups, the per-target linker prm, debugger arguments and assembler options is feasible with a **read-only parser plus a filesystem fallback**: resolve bare names through Access Paths, i.e. Sources/, prm/, cmd/, the project root.
- **Do not write `.mcp`.** Keep the clone's state in a sidecar file (e.g. `<proj>.cwclone.json`). Optionally support CodeWarrior's XML Export/Import Project format.
- The IDE rewrites `.mcp` on every open, according to forum users.

## 9. On-disk layout of a wizard project (v5.0 multi-target, generalized to an assembly project on DG256B)

```
<Project>/
  <Project>.mcp
  Full_Chip_Simulation.ini, HCS12_Serial_Monitor.ini      (debugger project files)
  C_Layout.hwl                                            (debugger window layout)
  Default.mem                                             (FCS memory configuration, created by the debugger)
  readme.txt, tips.txt
  Sources/        main.asm  (+ derivative.inc, mc9s12dg256.inc: either here or listed under Includes from {Compiler}lib\hc12c\include; UNCERTAIN)
  prm/            burner.bbl, Full_Chip_Simulation_linker.prm, HCS12_Serial_Monitor_linker.prm  (relocatable/C; absolute assembly may not use the prm; UNCERTAIN)
  cmd/            Full_Chip_Simulation_{Startup,Reset,Preload,Postload,SetCPU}.cmd, HCS12_Serial_Monitor_{Startup,Reset,Preload,Postload}.cmd
  bin/            <Target>.abs, <Target>.abs.s19, <Target>.abs.phy, <Target>.map, *.lst, *.dbg (asm debug source), .bpt/.xpr
  <Project>_Data/ CWSettingsWindows.stg, <Target>/ObjectCode/*.o, <Target>/TargetDataWindows.tdt   (IDE caches, safe to ignore or regenerate)
```

- Older and single-target projects use `bin/Project.abs` and `bin/Project.abs.s19`, as described by the Ryerson and USC labs.
- **Absolute assembly** (Oakland/Ryerson): one .asm plus includes produces the .abs directly; ORG and ABSENTRY define placement; S19 output lands in `bin`.

---

## Key risks / open questions

1. **Version split.** v5.0 uses one build target per connection ("Full Chip Simulation", "HCS12 Serial Monitor"); later v5.x uses a single "Standard" target plus a wizard-XML connection. **Ask the student for a real `.mcp` from the lab** to confirm which applies to their projects and what an assembly-only `.mcp` contains (groups, whether the linker is used).
2. **`.mcp` decode is empirical.** It is verified on 3 C projects but on no assembly-only project. The meaning of some bookkeeping chunks (`mtsl`, `mtgl`, `mpsi`, `msti`, the Code/Data size fields, the relative-path storage) is unknown. Writing `.mcp` is high-risk; parse read-only.
3. **Exact names and strings are unconfirmed** for: debugger toolbar command IDs, the Reset shortcut, IDE shortcuts other than F5 and Alt+F7, the Errors & Warnings window layout, assembler message formats, and default .asm syntax colors. Screenshots of the lab's actual installation would settle these.
4. **What an assembly-only debug session shows** (Data and Procedure windows; `.dbg` file generation and location) needs checking against a real build (UNCERTAIN).
5. **FCS for DG256B** simulates SCI, ECT, ATD, PWM and others, but fidelity details (cycle timing, PLL, flash/EEPROM programming) must come from the HCS12 reference manuals. Unimplemented-register warnings should be reproduced.
6. **Real-board support** depends on the Dragon12-Plus monitor firmware: Freescale Serial Monitor (AN2548) in SW7 LOAD mode versus D-Bug12 in run mode. Also open: vector-table mirroring, flash erase/program over the monitor, hardware breakpoints in flash (the `HWBPD` keys), and COM-port handling from Electron (node-serialport). This needs its own research topic.
7. **VisualizationTool and Dragon12 I/O:** there is no official Dragon12 layout. The clone needs its own `.vtl`-like panel (PORTB LEDs, 7-segment digits via PTP, PTH DIP switches and buttons, LCD), and must decide whether to read real `.vtl` files (format unknown, probably binary).
8. **Legal and branding:** reproducing NXP/Freescale names, icons and manual text in a redistributed clone may be an IP problem. Mimic the layout, but use original artwork and text.