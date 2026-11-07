# CodeWarrior 5.x `.mcp` project format, IDE side files and HI-WAVE files: reverse-engineering notes

Everything here was checked by byte analysis of the Lab3 sample project (`fixtures/Lab3`, private fixtures) using read-only commands. Anything inferred rather than verified is marked **UNCERTAIN**.

## 0. Headline findings

- **The two `.mcp` files are byte-identical.** `Lab3.mcp` and `blank_project/blank_project.mcp` have the same MD5 (`054701b4cc3818b1d97e0e539a190e27`), so `cmp` finds 0 differences. The student copied the blank project and renamed the `.mcp`, and the IDE never rewrote it because no project settings changed.
- **The `.mcp` does not store its own name.** The IDE derives the data folder name from the file's basename (`Lab3.mcp` uses `Lab3_Data/`). Data folders of earlier project names are left over from renames.
- **One container format covers three file types.** `.mcp`, `CWSettingsWindows.stg` and `TargetDataWindows.tdt` all use the same "looc" chunk container. Only the subtitle string and the set of chunks differ.
- **The file uses a heap with free space, and the free space is not zeroed.** Stale data exists in two forms:
  - Append-only name tables that are never pruned: names of old library versions, removed source files and a removed target are still in the table but are not project members.
  - Old chunk copies left in unreferenced gaps. An older `PLst` group tree sits at `0xd252–0xd672`.
  - **Parse only through the chunk table. Never parse with a raw `strings` scan.**
- **The settings are a single target, `Standard`**, linker `Linker for HC12`.
  - Output: `bin\Project.abs`.
  - Assembler options: `-CPUHCS12X -L=%(TEXTPATH)\%n.lst -Li`.
  - Debugger: Build Extras, External debugger `{Compiler}prog\hiwave.exe`, arguments `%targetFilePath -Prod=%projectFileDir\P&E_Multilink_USB.ini -instance=icd12`.

---

## 1. Container format ("looc"), shared by `.mcp`, `.stg` and `.tdt`

All integers are **little-endian** on Windows. The magic `"looc"` is the reversed form of `'cool'`. Mac CodeWarrior writes `"cool"` and stores integers big-endian; makeprojects' `parse_mcp_file` uses this to detect endianness ([makeprojects codewarrior.py](https://github.com/burgerbecky/makeprojects/blob/master/makeprojects/codewarrior.py)).

### 1.1 Header (0x128 bytes)

| Off | Type | Lab3.mcp | Meaning |
|---|---|---|---|
| 0x00 | char[4] | `looc` | magic (LE). `cool` means BE/Mac |
| 0x04 | u32 | 3 | container version |
| 0x08 | u32 | 0x128 | start of data heap (always 0x128) |
| 0x0C | u32 | 0xFE56 | data heap length (`= tableOff - 0x128`) |
| 0x10 | u32 | 0xFF7E | **chunk table offset** |
| 0x14 | u32 | 0x450 | chunk table byte size (`= n*24`) |
| 0x18 | u32 | 46 | chunk count |
| 0x1C | u8[4] | `02 03 04 00` | IDE or format version bytes. The same value appears in `.stg` and `.tdt`. Exact meaning is **UNCERTAIN**. makeprojects reads it as "cw_version" |
| 0x20 | u32×2 | 0 | reserved |
| 0x28 | char[256] | `"CodeWarrior Project"` | subtitle: `"Windows Project Settings"` (.stg), `"Windows Target Data"` (.tdt) |

Invariant (verified on all three file types): `tableOff + tableSize == fileSize`. The table is always the last thing in the file.

### 1.2 Chunk table entry (24 bytes)

```
u32 offset;      // absolute file offset
u32 size;        // byte length (blocks are often capacity-sized, e.g. string pools 0x800)
u32 tag;         // FourCC stored little-endian: bytes "rtsm" => tag 'mstr'
u32 ns_or_hash;  // namespace for structural chunks (0, 0x3E8=1000, 1, 0x3E9, 0x3ED);
                 // for 'pref' chunks a 20-bit-ish value (0xF26BD...) — NOT a content hash
                 // (same bytes have different values in .mcp vs .tdt). UNCERTAIN: sequence/stamp. Preserve as-is.
u32 id;          // for 'pref'/'PLst'/'prpl': name-ID into namespace-0 string table
u32 reserved;    // always 0
```

Chunks are placed in any order and leave gaps. In Lab3.mcp the gaps are `0xc609–0xcaae` (1189 bytes, holding stray `"2.1"`) and `0xd252–0xd672` (1056 bytes, holding a stale old `PLst`).

### 1.3 Chunk tags seen in Lab3.mcp (FourCC after byte reversal)

| Tag | ns | Offset/size | Role (✓ means decoded) |
|---|---|---|---|
| `mstr` | 0 | 0x128/0x800 | ✓ string pool: **settings-panel key names** (`"Standard:Access Paths"`, …) |
| `mstl` | 0 | 0x928/0x300 | ✓ string index: 12-byte entries `{u32 strOff, u32 id(1-based), u32 0}`, capacity 64 |
| `mstn` | 0 | 0xc28/0x100 | hash buckets (u32 ids, capacity 64). Hash function unknown (**UNCERTAIN**) |
| `msti` | 0 | 0x17a8/0x28 | ✓ table info `{count=54, capacity=64, usedBytes=1580, poolCap=2048, lastId=54, …}` |
| `mstr/mstl/mstn/msti` | 0x3E8 | 0x17d0, 0xd48, 0x11c8, 0x1406 | ✓ second "atom" table: **target names, file names, output names** (70 entries, append-only) |
| `mtgl` | 1000 | 0x142e/0x21c | target list: `{count=1, cap=4, …, u16 nameId=4 ("Standard"), …, u32 0x16 (atom 22 = "bin\Project.abs"), u32 0xE319BA49 (Mac-epoch seconds = 2024-09-25), …}`. Record layout **UNCERTAIN** |
| `mtpl` | 1 | 0x1fd0/0x500 | ✓ **target file records**, 40 bytes each, capacity 32 (see §2.2) |
| `mtpi` | 1 | 0x13da/0x10 | ✓ `{count=7, capacity=32, 1, lastFileRef=0x0100008E}` |
| `mtlo` | 1 | 0x13ea/0x1c | ✓ **link order**: array of u32 fileRefs |
| `mtps`, `mtsl`, `moti`, `mall`, `mapl`, `mpsi` | – | small | bookkeeping (segments, ID allocation, timestamps). **UNCERTAIN**, not needed for the clone |
| `pref` | – | – | ✓ one settings panel per chunk; `id` gives the panel name (`"<Target>:<Panel>"`) via the ns-0 table |
| `PLst` | – | 0xc531/0xd8 | ✓ **"Project File List"**, the group tree (§2.3) |
| `prpl` | – | 0xd672/0x58a | ✓ **"HC12 Wizard Configuration"**, plain XML (§2.6) |

### 1.4 Name lookup

To find the name of a `pref` chunk, look up its `id` in the ns-0 name table (`mstl` gives the string offset into the `mstr` pool). Every pref name has the form `<TargetName>:<PanelName>`. Panels found for `Standard` (IDs 27–52):

- Source Trees, Access Paths, Target Settings, File Mappings, Build Extras, Custom Keywords, PEOptions.
- Panel for Assembler, Burner, Compiler, Importer, Libmaker and Linker, each for HC12 and for XGATE.
- OSEK Sysgen Panel, BatchRunner Panel, BatchRunner PreLinker Panel, PCLint Options, PCLint Main Settings, x86 Exceptions Panel, External Build Panel.

IDs 1–26 are the same names prefixed with an old target name, but **no `pref` chunk references them**. They are leftovers from a target that has been renamed or deleted. The rule: **a target exists only if `mtgl` lists it and its prefs exist. Never infer targets from the name strings.**

Note: makeprojects lists targets by splitting `Target:Panel` strings, which would wrongly report that old target. Do not copy that heuristic.

---

## 2. Decoded `.mcp` content for Lab3

### 2.1 ns-1000 atom table (IDs 1–70, never pruned)

Atoms include the target name, the panel and tool names, the output paths (`bin\Project.abs`) and the leaf names of
the project files (e.g. 22 `bin\Project.abs`, 23 `main.asm`, 69 `ME305LibV4.0.lib`). The full listing is in the
private notes, s12studio-fixtures research/mcp-format.md §2.1.

Most of them are stale names of files and targets that are no longer in the project.

### 2.2 `mtpl`: target file records (40 bytes; the first `mtpi.count` = 7 are live)

```
+0  u32 fileRef      // 0x01000000 | serial  (high byte 0x01 = file object)
+4  u32 nameAtom     // ns-1000 atom id (leaf file name only, NO path)
+8  u32 0x00000202   // UNCERTAIN (kind/format)
+C  u32 1
+10 u16 1, u16 dbg   // dbg=1 for sources, 0 for the .lib  (UNCERTAIN: "Debug" column flag)
+14..+27 mostly 0 / 1
```

| # | fileRef | atom | File | Status |
|---|---|---|---|---|
| 0 | 0x01000002 | 35 | derivative.inc | live |
| 1 | 0x01000003 | 36 | burner.bbl | live |
| 2 | 0x01000004 | 37 | Project.prm | live |
| 3 | 0x01000005 | 38 | mc9s12xdp512.inc | live |
| 4 | 0x01000006 | 39 | Project.map | live |
| 5 | 0x0100008B | 69 | ME305LibV4.0.lib | live |
| 6 | 0x0100008E | 23 | main.asm | live |
| 7–14 | | | old file records | **stale** (beyond the count) |

**Files are stored by leaf name only.** The IDE resolves them by searching the Access Paths in order. That is why the copied project works from any folder. The actual resolved locations are cached in the `.tdt` (§3.2).

### 2.3 `mtlo`: link order (7 entries)

The order is derivative.inc, mc9s12xdp512.inc, burner.bbl, Project.prm, Project.map, **ME305LibV4.0.lib, main.asm**. Only `.lib` and `.asm` produce linker inputs. This matches the golden `bin/Project.map` FILE SECTION: `Lib_*.asm.o (ME305LibV4.0.lib)` modules first, then `main.asm.o`.

### 2.4 `PLst`: group tree (format verified)

```
u16 version=1
u32 groupCount (=5)
node := 'TOOR' u32 0, u32 0, u8 nameLen=0, u32 nChildren         // ROOT
      | 'PURG' u32 flags(0), u32 groupId, u8 len, char name[len], u32 nChildren   // GROUP (Pascal string)
      | 'ELIF' u32 fileRef                                          // FILE -> mtpl.fileRef
(children follow parent depth-first)
```

Decoded result:

```
ROOT
├─ Sources (id1):           main.asm (0x8E)
├─ Includes (id2):          derivative.inc (0x02), mc9s12xdp512.inc (0x05)
├─ Libraries (id5):         ME305LibV4.0.lib (0x8B)
└─ Project Settings (id3)
   └─ Linker Files (id4):   burner.bbl (0x03), Project.map (0x06), Project.prm (0x04)
```

The stale copy at `0xd360` refers to fileRefs 0x01000001, 0x01000076 and 0x0100006C, which no longer exist, plus a run of repeated garbage `ELIF 0x01000004` entries. Expanded or collapsed state is not stored here. It lives in `.stg` under "Expanded Group List".

### 2.5 `pref` panel layouts (decoded)

**Target Settings** (v=0x0A, 0x614 bytes):
- `u32 ver`
- `char linker[256]` = "Linker for HC12"
- `char preLinker[256]` = ""
- `char postLinker[256]` = ""
- `char targetName[256]` @0x304 = "Standard"
- @0x404: `u16 root=1, u16 fmt=2, char outputDir[512]` = "bin"
- 12 bytes of flags (all 0)

**Access Paths** (0x29F4 bytes):
- Header: `u32 0x10, u32 0, u16 userCount=19, u16 systemCount=1`.
- Then 20 records with a **0x218 stride**. Each record contains `u32 marker(0xFFFFFFFF), u32 id[|0x40000000], u16 root, u16 fmt(2=Windows), char path[512]`.
- Root values: 0 = absolute, 1 = `{Project}`, 2 = `{Compiler}`.
- **UNCERTAIN:** the exact alignment of the first and last record. The first record carries `0x1B / 0x40000003` and the last 8 bytes are `FFFFFFFF 40000002`. The Recursive and host flags were not located, and may be the 0x40000000 bit. Robust approach: scan for `FF FF FF FF` followed by `u32 id, u16 root∈{0,1,2,3}, u16 fmt∈{1,2}` and a NUL-terminated path.
- Values in order:
  - User paths: `{Project}` (empty path), `bin`, `prm`, `cmd`, `Sources`, `{Compiler}lib\HC12c\lib`, `{Compiler}lib\HC12c\src`, `Sources\Libraries`.
  - Then about a dozen user paths added by hand over several labs, many of which do not exist (relative paths to other folders, one absolute path on another drive, root 0).
  - System path: `{Compiler}lib\HC12c\include`. This is where `mc9s12xdp512.inc` resolves.
- **These are live settings, not stale data.** The clone must tolerate missing directories silently, as CodeWarrior does.

**File Mappings** (v5, 0x5378 bytes):
- Header: `u16 ver=5, u16 sectionCount=7`.
- Each section: `char linkerName[32], u32 count`, then `count × 104-byte` records.
- Record: `u32 type FourCC ('TEXT' or 0), char ext[32], char compiler[32], char editLanguage[32], u32 flags`.
- Flags: 0x10 = Ignored-by-make, 0x40 = Launchable, 0x80 = Precompile, 0x20 = Resource (the bit names are **UNCERTAIN**, but .pdf=0x50 and .oil=0xC0 fit them).
- Sections: None, External Build Linker, Libmaker for HC12, **Linker for HC12** (39 records), Libmaker for XGATE, Linker for XGATE, PCLint Linker.
- Relevant mappings in the Linker for HC12 section:

| Ext | Tool | Flags |
|---|---|---|
| .asm, .s, .a12 | Assembler for HC12 | 0 |
| .inc, .equ, .dbg | Assembler for HC12 | 0x10 |
| .prm | (none), edit language `mwe_prm` | 0 |
| .bbl | (none), edit language `mwe_bbl` | 0 |
| .lib, .o, .obj, .abs, .elf, .a | Importer for HC12 (type 0) | 0 |
| .map, .s19, .lst, .ini, .cmd, .txt | (none) | 0x10 |

**Build Extras** (v9, 0x824 bytes):
- Bytes 2–7 are u8 flags `01 01 00 01 01 00`. **UNCERTAIN** which one is "Use external debugger".
- @0x08: `u16 root=2, u16 fmt=2, char app[512]` = `prog\hiwave.exe`
- @0x20C: `char args[512]` = `%targetFilePath -Prod=%projectFileDir\P&E_Multilink_USB.ini -instance=icd12`
- @0x410: `u16 root=1, u16 fmt=2, char initialDir[512]` = "" (`{Project}`)

**HIWARE "Panel for <Tool> for HC12"** uses a generic field-blob format (verified on all 12 panels):

```
u8 1, u8 1, u16 0
u32 dataOffset          // = 0x18 + 4*N
u32 0x18                // dir offset
u32 N                   // number of fields
u32 0, u32 0xFFFFFFFF
u32 fieldSize[N]
u8  data[sum(fieldSize)] // fields concatenated; strings NUL-terminated
```

- **Assembler HC12:** sizes `[37,0,4,4]`. field0 = `"-CPUHCS12X -L=%(TEXTPATH)\%n.lst -Li"` (the tool command-line options). The rest is zeros.
- **Compiler HC12:** field0 = `" -CpuHCS12X "`.
- **Linker HC12:** sizes `[1,8,0,4,12,4,17,0,0,4]`. Fields: options `""`, `"out.prm"`, –, u32 0, **`"Project.abs"`** (application file name), u32 **2** (PRM mode; **UNCERTAIN**, probably "use PRM file in project"), `"mc9s12xdp512.prm"` (template PRM), …
- **Libmaker:** `"out.lib"`. **Burner:** no strings. **Importer:** none.
- **Rule: field0 is always the extra command-line options for the tool.** Treat it as authoritative.

**Other panels:**
- OSEK: `{Project}gen\…` defaults plus a sysgen command line. Irrelevant.
- PCLint: `{Compiler}Lint\Lint-nt.exe`.
- Source Trees: `{2, 0}`, empty.
- Custom Keywords, PEOptions, x86, BatchRunner, External Build: defaults.

### 2.6 `prpl`: wizard XML (plain text, 0x58A bytes, ends with `\n`)

```xml
<WizardConfiguration version="1.3">
  <SelectedWizardElement name="Chip" term="MC9S12XDP512" id="ID_CHIP_XDP512"
     idrefs="ID_CHIP_LIST ID_CHIP_FAMILY_hcs12x ID_CHIP_hcs12x_SUBFAMILY_D ID_CHIP_XDP512"/>
  <SelectedWizardElement name="Language" term="Relocatable assembly" id="ID_LANG_ASM" .../>
  <SelectedWizardElement name="XGATE_yes_no" term="Single Core (HCS12X)" id="ID_XGATE_NO" .../>
  <SelectedWizardElement name="Target" term="P&amp;E USB BDM Multilink" id="ID_CONN_PEHW_HCS12" .../>
  ... PRM_Adaptations, Standard, PrcExpInstallation, PCLintInstallation (hidden="Yes"), PrcExp=None, DoBackup
</WizardConfiguration>
```

**This is the cleanest source for the derivative and connection.** Parse it with an XML parser to get `chip`, `language` and `connection`.

---

## 3. IDE side files

### 3.1 `<proj>_Data/CWSettingsWindows.stg` (per-user IDE state, same container)

| Pref name | Content |
|---|---|
| Expanded Group List | `{2, 0, 1}` (expanded group IDs) |
| Project Document Settings | u16 5, then the project window rectangle as u16s, … |
| Current Target | `02 00 01` (index of the current target) |
| Target List Settings | `03 00 01 00 00 00 'PRGT'(LE "TGRP") u32 8 "Standard"` |
| VCS Setup | contains the Windows username of whoever last saved the project |
| mwCVS Panel, SourceSafe Pref | defaults |

The `-<lab-PC host>` variants (a lab-PC host name and IP suffix) are copies keyed by host (CodeWarrior writes a per-machine variant when the project lives in a shared network or cloud-synced folder). **UNCERTAIN.** Ignore them.

### 3.2 `<proj>_Data/<Target>/TargetDataWindows.tdt` (build cache, same container)

- **Contains a full copy of all 26 `Standard:*` pref chunks, byte-identical to the `.mcp`.** This was verified for every panel. It is a usable fallback source of settings if the `.mcp` is damaged.
- `mtfl`: 104-byte records, one per file: `{tfId, fileRef, nameAtom, accessPathIndex?, type 'TEXT' / creator '????', …, modTime (Mac-epoch u32), …}`. Resolved strings in its atom table include the absolute object directory `C:\Users\<user>\…\Lab3_Data\Standard\ObjectCode\` and `…\prm\Project.prm`. main.asm.o is recorded with type `' FLE'` and creator `'????'` (rendered `" FLE????"` in the dump).
- `depg` (dependency graph), `bs70` and `symt` (browser symbols of the program), `head`, `ctrb` and `mtbi` are build and browse caches.
- **Recommendation: never read or write `.tdt`.** CodeWarrior rebuilds it when it is deleted; this is documented "Remove Object Code" behaviour.
- `ObjectCode/` holds `main.asm.o` and tool `project.ini` files (for example a `[Libmaker]` section with a RecentCommandLine that shows how ME305LibV4.0.lib was built).

### 3.3 Debugger side files (project root)

**`*.ini` (HI-WAVE `-Prod=` file, one per connection).** The clone should honour these keys:

| Section | Keys |
|---|---|
| `[HI-WAVE]` | `Target=icd12` (BDM GDI) or `sim` (Full Chip Sim); `Layout=ASM_layout.hwl`; `LoadDialogOptions=AUTOERASEANDFLASH NORUNAFTERLOAD`; `CPU=HC12`; `MainFrame=flags,showCmd,minX,minY,maxX,maxY,left,top,right,bottom` (a Win32 WINDOWPLACEMENT, rewritten on exit; this is the **only** difference between the Lab3 and blank `.ini`); `TOOLBAR=<MFC cmd IDs>`; `Configuration=P&E_Multilink_USB.hwc`; `Statusbar`, `ShowToolbar`, `Smallborder`, `Hideheadline`, `Hidetitle`, `AEFWarningDialog` |
| `[Environment Variables]` | `GENPATH` (source search for the debugger), `LIBPATH`, `OBJPATH`, `TEXTPATH`, `ABSPATH` (all `{Project}…` / `{Compiler}…`) |
| `[HC12MultilinkCyclonePro_GDI_SETTINGS]` | `CMDFILE0..6=CMDFILE <STARTUP\|RESET\|PRELOAD\|POSTLOAD\|VPPON\|VPPOFF\|UNSECURE> ON ".\cmd\<name>.cmd"`; `MCUID=0x03F0` (XDP512); `CHIPSECURE=CHIPSECURE SETUP 0xFF0F 0x3 0x2`; `DBG_S12X_0..3`, `S12XDBG_TRIGGER_A..D`; `NV_PARAMETER_FILE` (an absolute `…\prog\FPP\mcu03F0.fpp`); `NV_SAVE_WSP`, `NV_AUTO_ID` |
| `[STARTUP]` | `interface_selection` (1 = Multilink USB, 0 = Cyclone USB, 2 = serial, inferred **UNCERTAIN**), `PORT`, `IO_DELAY_*`, `RESET_DELAY`, `SHOWDIALOG`, … |
| `[ICD12]` | `COMSETTINGS`, `BDMAutoSpeed`, `BDMClockSpeed=14`, `HOTPLUGGING`, `DETECTRUNNING`, `HIGHIODELAYCONSTFORPLL` |
| `[Simulator]` / `[Simulator HC12]` | `CMDFILEn` (STARTUP/RESET/PRELOAD/POSTLOAD/SETCPU), `HCS12_SUPPORT=2`, **`FCS=MC9S12XDP512`**, `HCS12X_FLASH=524288`, `XGATE_RAM=32768` |
| `[Recent Applications File List]` | `File0..3`, `LoadFlags0..3` (stale lab-PC path) |
| `[Recent Layout File List]` | `File0..3` |

**`cmd/*.cmd`** are HI-WAVE command scripts; `//` starts a comment. Most are empty stubs.
- `P&E_Multilink_USB_Postload.cmd` contains `bs &main t` and `g`: a temporary breakpoint at `main`, then run. Students rely on this, so it must be supported.
- `*_Erase_unsecure_hcs12.cmd` uses `DEFINEVALUEDLG`, `FLASH RELEASE`, `reset`, `wb`/`ww`, `wait` and `undef`.
- **The `.ini` refers to the scripts in lower case (`P&E_Multilink_USB_startup.cmd`) while the files on disk are `…_Startup.cmd`, so lookup must be case-insensitive on Linux and macOS.**

**`ASM_layout.hwl`** is a plain-text HI-WAVE command script with CRLF line endings.

```
OPEN <component> <x%> <y%> <w%> <h%>        // percent of main-frame client area
<WindowTitle> < attributes K V,K V,...       // '<' = send command to that window
bckcolor <decimal COLORREF>                  // 50331647 = 0x02FFFFFF (PALETTERGB white)
font '<face>' <pt> <COLORNAME>
AUTOSIZE on|off
ACTIVATE "<title>" ...                      // z-order/activation sequence
```

- Components: source, assembly, procedure, register, memory, data, command.
- Attributes:
  - Source: `TOOLTIP`, `TOOLTIP_FORMAT`, `TOOLTIP_MODE`, `FREEZE`, `MARKS`.
  - Assembly: `ADR`, `CODE`, `ABSADR`, `SYMB`, `FORMAT`, `TOPPC 0x4000`.
  - Register: `FORMAT`, `COMPLEMENT`.
  - Memory: `FORMAT hex`, `WORD 1`, `ASC`, `ADR`, `MODE automatic`, `UPDATERATE 10`, `SHOW_ADDRESSSPACE`, `ADDRESS 0x80`.
  - Data: `SCOPE global`, `FORMAT Symb`, `MODE periodical`, `SORT`, `UPDATERATE 1`, `NAMEWIDTH 16`.
  - Command: `CACHESIZE 1000`.
  - Procedure: `VALUES`, `TYPES`.

**`bin/Project.xpr`** (named after the .abs) stores the Data-window watch list as HI-WAVE commands: `Data < ADDXPR ONLY_ADD_IF_NEW "<symbol>"` with CRLF. The clone should read and write this.

**`P&E_Multilink_USB.hwc`** is 0 bytes. It is the HI-WAVE "Configuration" file referenced by `[HI-WAVE] Configuration=`; create it empty if missing.

**`Default.mem`** is 161 bytes of binary simulator memory configuration with three entries: `AUTO MEM / RAM`, `AUTO ROM / ROM`, `AUTO RAM / RAM`. Numbers look biased by 0x80. Encoding is **UNCERTAIN**. Preserve it as-is and generate our own FCS memory map from the derivative.

---

## 4. CodeWarrior XML export (File → Export Project)

The IDE can export a project to XML and re-import it. The import can also be done headless through the IDE command line ([NXP forum notes on Export](https://community.nxp.com/t5/S12-MagniV-Microcontrollers/Script-wizard-to-convert-exported-mcp-xml-Project-to-makefile/m-p/131384)). Forum users report that the export, like the `.mcp`, lists only files explicitly added to the project, not headers found through includes ([NXP thread](https://community.nxp.com/t5/Classic-Legacy-CodeWarrior/Code-Warrior-Project-File-Listing/td-p/153613)).

The DTD below is taken from makeprojects, which writes these files ([codewarrior.py](https://github.com/burgerbecky/makeprojects/blob/master/makeprojects/codewarrior.py)):

```
<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<?codewarrior exportversion="1.0.1" ideversion="5.0" ?>     (IDE 5.8/5.9: exportversion="2.0")
PROJECT     := TARGETLIST, TARGETORDER, GROUPLIST, DESIGNLIST?
TARGET      := NAME, SETTINGLIST, FILELIST?, LINKORDER?, SEGMENTLIST?, OVERLAYGROUPLIST?,
               SUBTARGETLIST?, SUBPROJECTLIST?, FRAMEWORKLIST?, PACKAGEACTIONSLIST?
SETTINGLIST := (SETTING | PANELDATA)+
SETTING     := NAME?, (VALUE | SETTING+)            // nested key/value tree
PANELDATA   := NAME, VALUE                          // opaque plugin panel blob
FILE        := PATHTYPE, PATHROOT?, ACCESSPATH?, PATH, PATHFORMAT?, ROOTFILEREF?, FILEKIND?, FILEFLAGS?
FILEREF     := TARGETNAME?, PATHTYPE, PATHROOT?, ACCESSPATH?, PATH, PATHFORMAT?
LINKORDER   := FILEREF*
TARGETORDER := (ORDEREDTARGET(NAME) | ORDEREDDESIGN)*
GROUPLIST   := (GROUP | FILEREF)*;  GROUP := NAME, (GROUP|FILEREF)*
```

Typical values:
- `PATHTYPE` = `Name`, `PATHFORMAT` = `Windows`, `FILEKIND` = `Text` or `Library`, `FILEFLAGS` = `Debug` or empty.
- IDE panels map to SETTING keys, for example `UserSearchPaths` / `SystemSearchPaths` → `SearchPath{Path, PathFormat, PathRoot}`, `Recursive`, `FrameworkPath`, `HostFlags=All`; `Linker`, `Targetname`, `OutputDirectory`; `FileMappings{FileType, FileExtension, Compiler, EditLanguage, Precompile, Launchable, ResourceFile, IgnoredByMake}`.
- **UNCERTAIN:** HIWARE plugin panels ("Panel for Assembler for HC12", …) are probably exported as `PANELDATA` with a hex-dumped `VALUE`. That would be the same field-blob described in §2.5. No HC12 export sample was found online. **Asking the instructor for one exported `.xml` from a lab PC would settle this cheaply.**

Recommendation: support **importing** CodeWarrior-export XML as a second input format, and use the **same element vocabulary** for our own sidecar so a human can diff the two. Do not attempt to emit XML that CodeWarrior will import unless a real HC12 export sample confirms the PANELDATA encoding.

---

## 5. Strategy for reading `.mcp` robustly (TypeScript)

```ts
interface Chunk { off:number; size:number; tag:string; ns:number; id:number; data:Buffer }
function readContainer(b: Buffer) {
  const magic = b.toString('latin1',0,4);
  const le = magic === 'looc'; if (!le && magic !== 'cool') throw 'not CW';
  const u32 = (o:number)=> le ? b.readUInt32LE(o) : b.readUInt32BE(o);
  const tabOff=u32(0x10), tabSz=u32(0x14), n=u32(0x18);
  // sanity: tabOff+tabSz===b.length && n*24===tabSz; else fallback: scan backwards for 24-byte
  // records whose tag ∈ KNOWN_TAGS and off+size<=tabOff
  const subtitle = cstr(b,0x28);                  // "CodeWarrior Project"
  const chunks = range(n).map(i=>{ const o=tabOff+24*i;
     const tag = le ? b.toString('latin1',o+8,o+12).split('').reverse().join('') : b.toString('latin1',o+8,o+12);
     return {off:u32(o), size:u32(o+4), tag, ns:u32(o+12), id:u32(o+16), data:b.subarray(u32(o),u32(o)+u32(o+4))}; });
  return { subtitle, chunks, u32 };
}
```

1. **String tables.** For each namespace `ns`, find `mstr`, `mstl` and `msti` with the same `ns`. Read `count` from `msti[0]`. Build `Map<id,string>` from the first `count` live entries of `mstl`. Ignore `mstn`.
2. **Panels.** Build `prefs = Map<"Target:Panel", Buffer>` from all `pref`/`PLst`/`prpl` chunks via their ns-0 name. **Targets** are the distinct prefixes that actually have `pref` chunks. Cross-check against `mtgl` and the "Target Settings" `targetName` @0x304.
3. **Files.** Take the first `mtpi.count` records of `mtpl` and build `fileRef → leafName` (ns-1000 atom).
4. **Link order** comes from `mtlo` (u32 × size/4), filtered to known fileRefs.
5. **Groups** come from the `PLst` recursive descent (§2.4). Drop `ELIF` refs not in the file map, and warn.
6. **Settings:**
   - Target Settings → linker, targetName, outputDir.
   - Access Paths → scan for the `FFFFFFFF` marker per §2.5.
   - File Mappings → the section matching the target's linker.
   - Build Extras → debugger application, arguments, initial directory.
   - HIWARE panels → field-blob decode, where field0 holds the tool options.
   - `prpl` → XML parse.
7. **Path resolution.** Resolve each leaf name by searching access paths in order: user paths first, then system paths. Expand `{Project}` to the `.mcp` directory and `{Compiler}` to our bundled tool root. Search recursively as CodeWarrior does by default (Recursive flag **UNCERTAIN**, so assume recursive for `{Project}`). Take the first match. Report a missing file the way CodeWarrior does ("file not found"). It is not fatal for `.map`, which is a generated output.
8. **Validation fallback.** If the `.mcp` is corrupt, or the table check fails, use the `.tdt` pref copies for settings, then the `.stg` for the current target. As a last resort, use heuristics: regex the `prpl` XML, the `-Prod=` string and the HIWARE option strings. **Never take membership from raw strings.**
9. **Golden test.** `Lab3.mcp` must produce:
   - Target `Standard`.
   - 7 files.
   - The group tree above.
   - Link order lib before main.
   - Output `bin\Project.abs`.
   - Assembler options `-CPUHCS12X -L=%(TEXTPATH)\%n.lst -Li`.
   - Debugger `-Prod=…P&E_Multilink_USB.ini -instance=icd12`.
   - Chip `MC9S12XDP512`, language Relocatable assembly, connection "P&E USB BDM Multilink".

Notes for the build engine:
- `%(TEXTPATH)` and `%n` in tool options are HIWARE macros. TEXTPATH comes from `[Environment Variables]`, giving `{Project}bin`, so the listing goes to `bin\main.lst`. This matches the golden file.
- `%targetFilePath` and `%projectFileDir` are IDE macros used in Build Extras.

---

## 6. Opinion on writing `.mcp`

**Do not write `.mcp` in v1.** The reasons:
- The `mstn` hash function is unknown, so adding a name would require a correct rehash.
- The `pref` `ns_or_hash` stamps, the `mtgl`, `mtps` and `mpsi` semantics, the Access Paths flags and the record capacity growth (relocating chunks into free space) are all unverified.
- A corrupted `.mcp` is a disaster for a student who must also open the project in real CodeWarrior on lab PCs.

Instead:
1. **Treat `.mcp` as read-only and byte-preserve it.** Hash it on open and warn if CodeWarrior changed it underneath us. Then re-import, merging our sidecar on top.
2. **Use a sidecar** `<name>.cwclone.json` (or XML in the §4 vocabulary) next to the `.mcp`. It holds only our deltas: files added or removed, group edits, link order, tool options, connection choice. The effective project is the `.mcp` parse plus the sidecar.
3. **Offer an "Export for CodeWarrior" action** that produces an import-ready XML file (`exportversion="1.0.1"` or `"2.0"`) only after a real HC12 export sample validates PANELDATA. For the simplest safe in-place edits (changing a string inside an existing fixed-size field, such as the `-Prod=` argument within its 512-byte buffer, or panel field0 *within the same length*), a patch-in-place writer is possible later. Keep chunk sizes unchanged and back up to `.mcp.bak`.
4. **Write the debugger files freely**, because they are plain text CodeWarrior also uses: `.ini` (MainFrame, recent lists), `.xpr` and `.hwl`. Keep CRLF line endings and the existing key order, and use an INI writer that preserves unknown keys and blank lines.

---

## Key risks / open questions

1. **Access Paths records.** The exact record alignment and the Recursive, Framework and Host flag bits are unverified, so resolution assumes recursive search. One project where Recursive is toggled would settle it.
2. **The `pref` `ns_or_hash` field and `mstn` hashing are unknown.** These are what block safe `.mcp` writing.
3. **Unused chunks.** `mtgl` (target record size of 133 bytes is odd), `mtps`, `mtsl`, `moti`, `mall`, `mapl` and `mpsi` are only partly decoded. They are not needed for reading Lab3, but they are needed for multi-target projects. **We have only one sample `.mcp`**, and the two files are identical, so no differential analysis was possible. Ask for 3–5 more student or instructor `.mcp` files: multi-target, C projects, Full-Chip-Sim-only, files added or removed. Before/after pairs from a single IDE action would be ideal.
4. **XML export with HIWARE panels (PANELDATA encoding) is unconfirmed** (no HC12 sample found online). Get one exported `.xml` from a lab PC.
5. **Linker panel field meanings.** The meaning of the u32 `2` and of `"out.prm"` / `"mc9s12xdp512.prm"` is uncertain. The build should use the `.prm` file in the project (Linker Files group), as CodeWarrior appears to.
6. **How `Project.abs.s19` is produced** (burner.bbl run implicitly by the linker plugin, versus Linker panel options) is not determined from the `.mcp` alone. The build-system work stream needs to cross-check this against the golden outputs.
7. **Case-insensitive lookups** for `.cmd`, `.ini` and source files are required on Linux and macOS. Windows absolute and drive-letter paths, such as `E:\…` and `NV_PARAMETER_FILE=C:\Program Files (x86)\…\mcu03F0.fpp`, must degrade gracefully.
8. **Mac-epoch timestamps** in `mtgl`, `mpsi` and `.tdt` were verified only by plausibility (dates in 2024 and 2026).
9. **Encodings.** `Default.mem` and the bytes in the `.stg` "Project Document Settings" are undecoded; preserve them as-is.

**Sources:**
- [makeprojects codewarrior.py (XML DTD, `cool`/`looc` endianness, `.mcp` signature parsing)](https://github.com/burgerbecky/makeprojects/blob/master/makeprojects/codewarrior.py)
- [makeprojects CodeWarrior Project docs](https://makeprojects.readthedocs.io/en/latest/doxygen/classmakeprojects_1_1codewarrior_1_1_project.html)
- [NXP: Code Warrior Project File Listing](https://community.nxp.com/t5/Classic-Legacy-CodeWarrior/Code-Warrior-Project-File-Listing/td-p/153613)
- [NXP: Script/wizard to convert exported .mcp.xml to makefile](https://community.nxp.com/t5/S12-MagniV-Microcontrollers/Script-wizard-to-convert-exported-mcp-xml-Project-to-makefile/m-p/131384)
- [CW Compiler HC12 RM (Linker for HC12 preference panel)](https://my.eng.utah.edu/~cs5780/doc/CW_Compiler_HC12_RM.pdf)

The NXP pages returned 403 when fetched, so their content above comes from search-result summaries.