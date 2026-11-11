# Hardware debug link for the MC9S12XDP512 from an Electron/Node app on Windows

## TL;DR

- **Recommended main hardware path: USBDM**, an open-source GPLv2 project by Peter O'Donoghue ("pgo").
  - It is actively maintained: v4.12.1.340, Dec 2024, with a commit pushed Apr 2026.
  - It has a flat C API (`usbdm.4.dll`) that koffi can call from an x64 process.
  - Its device database already lists **MC9S12XDP512**, but marks it `Untested`. It also ships a CLI flash programmer and a Tcl scripting shell.
  - The catch: it needs a USBDM pod (cheap JS16-class hardware), not the lab's P&E Multilink.
- **Fallback for the lab's P&E Multilink: the free CodeWarrior S12(X) v5.2 Special Edition**, driven as an external tool. Our IDE builds a CodeWarrior-compatible `.abs` and starts `hiwave.exe` with the lab's `P&E_Multilink_USB.ini`.
  - P&E publishes **no** USB protocol and I found no open-source driver.
  - Loading P&E's GDI DLL ourselves can be done, but it is undocumented. It needs a **32-bit** sidecar process and an emulation of CodeWarrior's callback interface. Treat it as a stretch goal.
- **Serial monitor (AN2548): last resort.** It was written for HCS12, not S12X. It needs a BDM pod once to flash, it takes SCI0, and it breaks interrupt-driven code such as the keypad ISR.
- **Writing our own BDM-over-generic-adapter: no.** It needs hard real-time bit timing (each bit is 16 BDM clocks at MHz rates), which an FTDI or Arduino link cannot hold. The protocol is still documented below, because the USBDM backend and our own flash algorithm work in terms of it.

---

## 1. Facts from the Lab3 sample project (`fixtures/Lab3`) that affect the debug link

| Item | Evidence | Consequence |
|---|---|---|
| The P&E target is CodeWarrior's GDI plug-in | `P&E_Multilink_USB.ini`: `[HI-WAVE] Target=icd12`, `[HC12MultilinkCyclonePro_GDI_SETTINGS]`, `[STARTUP] PORT=21 interface_selection=1`, `MCUID=0x03F0`, `NV_PARAMETER_FILE=C:\Program Files (x86)\Freescale\CWS12v5.1\prog\FPP\mcu03F0.fpp`, `[ICD12] BDMClockSpeed=14 BDMAutoSpeed=0` | P&E's GDI layer uses its own flash-algorithm files (`prog\FPP\mcu03F0.fpp`). The lab install is **CWS12 v5.1**. |
| Load options | `LoadDialogOptions=AUTOERASEANDFLASH NORUNAFTERLOAD`; `CHIPSECURE=CHIPSECURE SETUP 0xFF0F 0x3 0x2` | Every load erases and programs, then halts at the entry point. FSEC is at `0xFF0F`. |
| **The S19 does NOT contain the library** | Python decode of `bin/Project.abs.s19`: only MyCode at `0x4000`, `.init` at `0xC000` and the two vectors. ELF `Project.abs` program headers also have LOAD segments for the library code in **EEPROM** (from `0x0800`; details in the private notes, s12studio-fixtures research/hw-link.md). | **The loader must work from ELF PT_LOAD segments (or our own S19 that includes EEPROM), not from CodeWarrior's S19.** Any S19-only flasher (PROG12Z, the USBDM CLI) given CodeWarrior's `.s19` would leave the library unprogrammed. Our linker clone should emit an S19 that includes the EEPROM records. |
| Erase/unsecure script | `cmd/P&E_Multilink_USB_Erase_unsecure_hcs12.cmd` pokes `0x100..0x10A` (FCLKDIV/FPROT/FSTAT/FTSTMOD/FADDR/FDATA/FCMD), `0x110..0x11A` (EEPROM), and writes FSEC with `ww 0xFF0E 0xFFFE` + cmd `0x20`. Default `CLKDIV=0x49`, which is the 16 MHz-oscillator value in its table. | This is a ready-made template for programming over plain BDM memory writes (section 6). The board's oscillator frequency is not stated (risk). |
| Memory map | `prm/Project.prm`: EEPROM `0x0800–0x0FFB`, LIBRAM `0x1000–0x1FFF`, RAM `0x2000–0x3FFF`, ROM_4000 (PPAGE `0xFD`), ROM_C000 (PPAGE `0xFF`) | Global addresses: flash `0x4000` → `0x7F4000`, `0xC000` → `0x7FC000`. EEPROM `0x0800` (EPAGE `0xFE` at reset) → `0x13F800`, and `0x0C00` → `0x13FC00`. |

The USBDM device database (fetched from GitHub) agrees with this map:

```xml
<device family="HCS12" name="MC9S12XDP512">
  <memory pageAddress="0x0017" registerAddress="0x0110" type="eeprom">  <!-- EPAGE, EEPROM regs -->
     <memoryRange start="0x0800" end="0x0BFF" pages="4" pageEnd="0xFF"/> <memoryRange start="0x0C00" end="0x0FFF"/>
  <memory pageAddress="0x0030" registerAddress="0x0100" type="flash" securityAddress="0xFF00" sectorSize="1024">
     ... 0x4000-0x7FFF, 0x8000-0xBFFF pages="512K" pageEnd="0xFF", 0xC000-0xFFFF
  <sdid value="0xC410"/><sdid value="0xC411"/>   <!-- PARTID, readable at 0x001A for the connect check -->
  <flashProgramRef ref="HCS12-XMMC-XFTXK-flash-program"/>  <note>Untested</note>
```

Source: [hcs12_devices.xml](https://github.com/podonoghue/usbdm-eclipse-makefiles-build/blob/master/PackageFiles/DeviceData/hcs12_devices.xml), lines ~1889–1908.

---

## 2. Option 1: P&E Multilink

### 2a. Protocol and open-source drivers
- **There is no public protocol documentation** for the USB Multilink (USB-ML-12 / "USB BDM Multilink" / Multilink Universal). P&E's technical summaries cover only driver install (`PEUSBV1.SYS/.DLL`) and firmware. ([USB-ML-12E Tech Summary](https://www.mikrocontroller.net/attachment/85552/USB-ML-12E_Rev_C_Tech_Summary_1_04.pdf), [USBMULTILINKUM](https://www.nxp.jp/docs/en/user-guide/USBMULTILINKUM.pdf))
- I found **no open-source or reverse-engineered HCS12 driver** for P&E pods. Linux users run P&E's Windows tools under Wine. ([NXP thread](https://community.nxp.com/t5/Classic-Legacy-CodeWarrior/CodeWarrior-10-Eclipse-Linux-Getting-USB-P-E-Multilink-drivers/m-p/199623/highlight/true), [embeddedrelated](https://www.embeddedrelated.com/showthread/68hc12/16975-1.php))

### 2b. P&E SDKs and tools
- **"Interface Libraries" (UNIT\*)** are Windows DLLs with VC++/Delphi examples. The HC12 one was historically `unit_12z.dll`, and it needs the P&E kernel drivers (`PEDRV.SYS`, `PEUSBV1`). ([embeddedrelated](https://embeddedrelated.com/showthread/68hc12/3957-1.php), [Farnell datasheet](https://www.farnell.com/datasheets/727795.pdf))
  - P&E's current download page lists a **free UNITACMP (ARM Cortex-M only)** and a generic "Sample UNIT API Documentation" (derived from UNITHCS08). **No HCS12 UNIT library is listed.** ([pemicro downloads](https://www.pemicro.com/support/download_processor.cfm?family=5))
  - Whether an HCS12 UNIT library is still available, and on what terms, is **UNCERTAIN**. Ask P&E.
- **PROG12Z / CPROG12Z**: GUI and command-line HC(S)12(X) flash programmers, using P&E's `.fpp` algorithms over a Multilink. ([NXP PROG12Z page](https://www.nxp.com/products/processors-and-microcontrollers/additional-mpu-mcus-architectures/16-bit-s12-and-s12x-mcus/hcs12x-flash-eeprom-programmer:PROG12Z), [CPROG12Z guide](https://www.pemicro.com/downloads/download_file.cfm?download_id=91))
  - It is **paid**: P&E's "-HL-" hardware licences are installed into a specific Multilink. One reseller lists PROG-HL-12Z at €219 ([evision](https://evision-webshop.de/en/pemicro/Programmer-Software)); a ~2010 forum post said $169.
  - It is a programmer only (no run control) and takes S19, so it hits the EEPROM issue from section 1.
- **PKGHCS12Z**: I found no information on it (**UNCERTAIN**).

### 2c. Loading CodeWarrior's P&E GDI DLL ourselves
- hiwave talks to targets through the **GDI ("Generic Debug Instrument") API**, a Tasking-originated spec with Metrowerks extensions.
- **Best public reference:** USBDM's GPL re-implementation of the same API, which works as a drop-in CodeWarrior 5.x target.
  - [`Shared/src/GDI.h`](https://github.com/podonoghue/usbdm-eclipse-makefiles-build/blob/master/Shared/src/GDI.h): on Windows every export is `extern "C" __stdcall __declspec(dllexport)`.
  - [`GDI_DLL/src/GDI_Common.cpp`](https://github.com/podonoghue/usbdm-eclipse-makefiles-build/blob/master/GDI_DLL/src/GDI_Common.cpp) and [`Metrowerks.h`](https://github.com/podonoghue/usbdm-eclipse-makefiles-build/blob/master/GDI_DLL/src/Metrowerks.h).
- **Exported surface (from USBDM):**
  - Session: `DiGdiOpen(verH, verL, argc, const char* argv[], void(*UdProcessEvents)())`, `DiGdiClose`, `DiGdiVersion`, `DiGdiGetFeatures`, `DiGdiSetConfig`, `DiGdiInitIO(pDiCommSetupT)`, `DiGdiInitRegisterMap`, `DiGdiInitMemorySpaceMap`, `DiGdiAddCallback(type, fn)`, `DiGdiSynchronize`, `DiGdiCancel`.
  - Memory: `DiMemoryDownload`, `DiMemoryWrite(DiAddrT, DiMemValueT*, n)`, `DiMemoryRead(...)`.
  - Registers and run control: `DiRegisterRead/Write(regNo, ...)`, `DiExecResetChild`, `DiExecContinue`, `DiExecContinueUntil`, `DiExecSingleStep`, `DiExecStop`, `DiExecGetStatus`, `DiBreakpointSet/Clear`.
  - Other: `DiDirectCommand(const char*)` (receives `.cmd` lines such as `wb`/`ww`/`reset`), plus `DiMee*` and `DiCpu*`.
  - `DiAddrT = { DiUInt32T dmsMemSpace; DiValueT(8 bytes) dlaLinAddress; }`. Struct packing changed in 4.4.0 for Eclipse, so **packing must be verified** against P&E's DLL.
- **The CodeWarrior callback interface is undocumented.** The plug-in calls back into hiwave through `DiGdiAddCallback` using `DI_CB_MTWKS_EXTENSION=0x4000` with sub-codes such as:
  - `MTWKS_CB_PROJECTACCESS=0x80000000`, used to read `.ini` keys like `[HC12MultilinkCyclonePro_GDI_SETTINGS]`;
  - `MTWKS_CB_DISPLAYLINE=0x80`, `MTWKS_CB_HC12AUTOCONFIG=0x10000`, `MTWKS_CB_SETMEEID=0xC0001B58`.
  
  Our host would have to implement these as stdcall callbacks. koffi supports stdcall C→JS callbacks on ia32 ([koffi.dev](https://koffi.dev/)).
- **Bitness:** CodeWarrior 5.x and hiwave are 32-bit, so the P&E GDI DLL is PE32 (**UNCERTAIN**: the exact file name, likely in `…\CWS12v5.x\prog\gdi\`, was not confirmed online). It cannot be loaded in an x64 Electron main process. Use a separate ia32 process: an ia32 `node.exe` + koffi, or a small C++ ia32 exe, speaking JSON-RPC over stdio.
- **Reverse-engineering technique:** build a **logging proxy GDI DLL** with the same exports. Rename the real DLL, forward every call, and log arguments and callbacks while the real hiwave runs a lab session. This records the exact call order and `argv` strings.
- **Licence:** load the DLL from the user's own CodeWarrior install path and never redistribute it. The CodeWarrior EULA terms on third-party hosting are **UNCERTAIN**.
- **Feasibility: medium-low.** Expect weeks of reverse engineering. Bundled P&E drivers must also work on Windows 10/11.

### 2d. Free CodeWarrior S12(X) v5.2 Special Edition (verified)
- NXP's "CodeWarrior Development Suite – Special" page lists *"Special Edition: CodeWarrior for HCS12(X) Microcontrollers (Classic) v5.2"*. Its limits:
  - C compiler and C source-level debugger: code and data limited to **32 KB**;
  - XGATE: 512 bytes;
  - the fetch reported no account required. ([NXP CW-SUITE-SPECIAL](https://www.nxp.com/design/software/development-software/codewarrior-development-tools/codewarrior-legacy/codewarrior-development-suite-special:CW-SUITE-SPECIAL))
- The v5.2 product page lists:
  - **unlimited assembler** ("restrictions based on suite");
  - host interfaces: USB Multilink Universal (FX) and Cyclone;
  - OS: **Windows 7/8/8.1/10** (Windows 11 is not listed). ([CW-HCS12X v5.2](https://www.nxp.com/design/design-center/software/development-software/codewarrior-development-tools/codewarrior-legacy/codewarrior-development-studio-for-hcs12x-microcontrollers-classic-ide-v5-2:CW-HCS12X))
- **For an assembly-only student this is effectively unrestricted, and it installs at home.** The lab project is v5.1, and 5.2 opens 5.1 projects (normal behaviour; not tested here).
- Older "USB BDM Multilink" pods versus Multilink Universal may need updated P&E drivers. ([NXP thread](https://community.nxp.com/thread/319083))
- **Bridge mode ("HiwaveExternal" connection):** our IDE writes `bin/Project.abs` and runs:
  ```
  hiwave.exe -W -Prod=<abs path>\P&E_Multilink_USB.ini -instance=pe <abs path>\bin\Project.abs
  ```
  Forum-sourced flag meanings ([NXP thread](https://community.nxp.com/t5/CodeWarrior-Development-Tools/Executing-CodeWarrior-app-from-command-line-DEMO9S12XEP100/m-p/452630), [Rose-Hulman tips](https://rose-hulman.edu/class/ee/hoover/ece331/Quizzes/ECE331_Quiz%209/tips.txt)) are **UNCERTAIN**. Check them against the HC12 debugger manual.
  - This gives real hardware debugging on day one with the lab pod.
  - The cost: the debugging UI is hiwave's, not ours.

---

## 3. Option 2: USBDM (recommended)

**Project status**
- GitHub [podonoghue/usbdm-eclipse-makefiles-build](https://github.com/podonoghue/usbdm-eclipse-makefiles-build) (GPLv2, last push 2026-04-25) and [usbdm-firmware](https://github.com/podonoghue/usbdm-firmware).
- Releases are on [SourceForge](https://sourceforge.net/projects/usbdm/): latest `USBDM_4_12_1_340_Win.msi` (Dec 2024).
- Windows drivers come as a separate signed package ("will not be updated"). The installer itself is **unsigned**, so SmartScreen will warn. The release notes for 4.12.1.295 say *"Tested with Codewarrior V5.1/2 HCS12 (Windows)"*, so a USBDM pod also works inside real CodeWarrior.

**Targets**
- `T_HCS12 = T_HC12 = 0` covers HC12, HCS12 and S12X. S12Z is separate (`T_S12Z = 11`).
- XDP512 is in the device database but marked "Untested" (section 1). A forum user loaded a serial monitor onto an XDP512 with the USBDM HCS12 programmer ([NXP thread](https://community.nxp.com/message/365280)).

**Hardware**
- JS16 designs (MC9S08JS16): DIY, or clones from Wytec and others. JMxx designs; OSBDM/TBDML-class firmware. ([USBDM docs](https://usbdm.sourceforge.io/USBDM_V4.12/html/index.html))
- Same 6-pin BDM header as the Multilink: 1 BKGD, 2 GND, 4 RESET, 6 VDD. Pricing (assumed): about $20–40.
- **The P&E Multilink cannot run USBDM firmware.**

**Native API** (`usbdm.4.dll`; names follow `VSUFFIX=.4` in [Common.mk](https://github.com/podonoghue/usbdm-eclipse-makefiles-build/blob/master/Common.mk)). Built with MinGW on libusb-1.0 + WinUSB. 64-bit DLLs are the default; some 32-bit DLLs ship for CodeWarrior plug-ins. Prototypes from [USBDM_API.h docs](https://usbdm.sourceforge.io/USBDM_V4.12/Freedom/html/_u_s_b_d_m___a_p_i_8h.html) and [Shared/src/USBDM_API.h](https://github.com/podonoghue/usbdm-eclipse-makefiles-build/blob/master/Shared/src/USBDM_API.h):

```c
USBDM_ErrorCode USBDM_Init(void);  USBDM_Exit(void);
USBDM_FindDevices(unsigned *count); USBDM_Open(unsigned char devNo); USBDM_Close(void); USBDM_ReleaseDevices(void);
USBDM_GetDefaultExtendedOptions(USBDM_ExtendedOptions_t*); USBDM_SetExtendedOptions(const USBDM_ExtendedOptions_t*); // .size MUST be set
USBDM_SetTargetType(TargetType_t /*T_HCS12=0*/); USBDM_SetTargetVdd(TargetVddSelect_t);
USBDM_Connect(void); USBDM_GetSpeedHz(unsigned long*); USBDM_GetBDMStatus(USBDMStatus_t*);
USBDM_TargetReset(TargetMode_t /*RESET_SPECIAL=0|RESET_NORMAL=1 , RESET_HARDWARE=1<<2, RESET_SOFTWARE=2<<2, RESET_DEFAULT=7<<2*/);
USBDM_TargetHalt(void); USBDM_TargetGo(void); USBDM_TargetStep(void);
USBDM_ReadReg(unsigned regNo, unsigned long*); USBDM_WriteReg(...);   // HCS12_RegPC=3 D=4 X=5 Y=6 SP=7
USBDM_ReadDReg(unsigned regNo, unsigned long*); USBDM_WriteDReg(...); // BD space: BDMSTS=0xFF01, CCR=0xFF06 (8-bit)
USBDM_ReadStatusReg(unsigned long*) /*=BDMSTS*/; USBDM_WriteControlReg(unsigned);
USBDM_ReadMemory(unsigned memSpace, unsigned byteCount, unsigned address, unsigned char *data);
USBDM_WriteMemory(unsigned memSpace, unsigned byteCount, unsigned address, const unsigned char *data);
const char* USBDM_GetErrorString(USBDM_ErrorCode);
// MemorySpace_t: MS_Byte=1 MS_Word=2 MS_Long=4 MS_Program=0x10 MS_Data=0x20 MS_Global=0x30 ("HCS12 global addresses, using BDMPPR/0xFF08") MS_Fast=0x80
```

- Extended options: `targetVdd`, `cycleVddOnReset`, `autoReconnect`, `guessSpeed`, `bdmClockSource`, `useResetSignal`, `maskInterrupts`, reset and power timings.
- **S12X CCRH:** not covered by the API. Read it with `USBDM_ReadDReg(0xFF07)`. This is **UNCERTAIN**: on plain HCS12, `0xFF07` is BDMINR.

**koffi sketch (x64 Electron `utilityProcess`):**
```ts
const u = koffi.load(path.join(usbdmDir, 'usbdm.4.dll'));          // install dir UNCERTAIN, e.g. C:\Program Files\pgo\USBDM 4.12.1
const ReadMemory = u.func('int USBDM_ReadMemory(uint32, uint32, uint32, _Out_ uint8 *)');
const buf = Buffer.alloc(256); ReadMemory(0x01 /*MS_Byte*/, 256, 0x2000, buf);
const ReadGlobal = (ga: number, n: number) => ReadMemory(0x31 /*MS_Global|MS_Byte*/, n, ga, Buffer.alloc(n));
```
On x64 there is only one calling convention, so the cdecl/stdcall question goes away.

**Programming**
- `USBDM_API` itself is low-level debugging only; it does not program. ([NXP forum](https://community.nxp.com/t5/OSBDM-and-TBDML/Programming-with-the-USBDM-API/m-p/145664))
- The programmer library (`usbdm-programmer-hcs12.4.dll`) is a **C++ factory API**: `FlashProgrammerFactory::createFlashProgrammer(bdm)->programFlash(image)` ([example](https://github.com/podonoghue/usbdm-eclipse-makefiles-build/blob/master/USBDM_Programmer_API_Example/src/USBDM_API_Example.cpp)). koffi cannot call it directly. Three ways in:
  - (i) **Spawn the stand-alone programmer CLI.** Options from [FlashProgrammerApp.cpp](https://github.com/podonoghue/usbdm-eclipse-makefiles-build/blob/master/Programmer/src/FlashProgrammerApp.cpp): `<file.s19> -target=HCS12 -device=MC9S12XDP512 -erase=Selective|Mass -program -verify -unsecure -execute -resetMethod=hardware -vdd=5V -verbose`. The exe name is **UNCERTAIN**; the target type is inferred from argv0 containing "HCS12". It downloads a RAM-resident flash routine (`HCS12-XMMC-XFTXK-flash-program.s19`), so it is fast. **We must give it an S19 that includes the EEPROM records.**
  - (ii) **`UsbdmScript`**, a Tcl shell. Commands from [UsbdmTclInterpreterImp.cpp](https://github.com/podonoghue/usbdm-eclipse-makefiles-build/blob/master/UsbdmTcl_DLL/src/UsbdmTclInterpreterImp.cpp): `settarget openbdm connect reset halt go step gs regs rreg wreg rdreg wdreg rb rw rl wb ww wl rblock wblock wpc speed sync setdevice load program verify closebdm`. Since 4.12.1.320 it supports `G:` linear addresses. Driving it over stdin is the quickest working prototype.
  - (iii) Our own algorithm through `USBDM_WriteMemory` (section 6).
- The BDM handle is exclusive: close it before spawning the CLI.

**Pure-TypeScript alternative**
- Speak USBDM's USB command protocol with `node-usb` (libusb + WinUSB). Command codes are in [firmware Commands.h](https://github.com/podonoghue/usbdm-firmware/blob/master/USBDM_JMxx_V4_12/Sources/Commands.h): `SET_TARGET=1`, `CONNECT=15`, `TARGET_RESET=22`, `STEP=23`, `GO=24`, `HALT=25`, `READ_REG=27`, `READ_DREG=31`, `WRITE_MEM=32`, `READ_MEM=33`, `READ_ALL_REGS=34`.
- This drops the native DLL, but packet framing has to be reproduced from GPL source.
- VID/PID (0x16D0/0x0567?) is **UNCERTAIN**.

**Feasibility: high.** A plain C ABI, x64, and an active maintainer.

---

## 4. BDM protocol (S12/S12X), for our own flash algorithm and breakpoints

Opcodes are confirmed in USBDM's [BDMMacros.h](https://github.com/podonoghue/usbdm-firmware/blob/master/USBDM_JMxx_V4_12/Sources/BDMMacros.h) and [AN2104](https://NXP.com/docs/en/application-note/AN2104.pdf).

| Kind | Cmd | Opcode | Frame |
|---|---|---|---|
| HW (works while running, steals cycles) | BACKGROUND | `0x90` | needs ENBDM=1 |
| HW | ACK_ENABLE / ACK_DISABLE | `0xD5` / `0xD6` | |
| HW | READ_BYTE / READ_WORD | `0xE0` / `0xE8` | op, addr16, [delay or ACK], data16 out (byte at even address is high byte, odd address is low byte) |
| HW | WRITE_BYTE / WRITE_WORD | `0xC0` / `0xC8` | op, addr16, data16, [delay or ACK] |
| HW | READ_BD_BYTE / READ_BD_WORD | `0xE4` / `0xEC` | BDM ROM and registers mapped in at `0xFF00–0xFFFF` |
| HW | WRITE_BD_BYTE / WRITE_BD_WORD | `0xC4` / `0xCC` | |
| FW (halted only) | READ_NEXT, PC, D, X, Y, SP | `0x62`–`0x67` | op, [delay], data16 |
| FW | WRITE_NEXT, PC, D, X, Y, SP | `0x42`–`0x47` | op, data16 |
| FW | GO / TRACE1 / GO_UNTIL / TAGGO | `0x08` / `0x10` / `0x0C` / `0x18` | |

**BDM registers** ([USBDM TargetDefines.h](https://github.com/podonoghue/usbdm-firmware/blob/master/USBDM_JMxx_V4_12/Sources/TargetDefines.h)):
- `BDMSTS = 0xFF01`: ENBDM `0x80`, BDMACT `0x40`, CLKSW `0x04`, UNSEC `0x02`.
- `BDMCCR(L) = 0xFF06`.
- `0xFF08` is BDMPPR on S12, **BDMGPR on S12X** (BGAE bit 7 + global address bits 22:16, used by MS_Global). The S12X role is **UNCERTAIN**; verify in the S12XBDMV2 chapter of the [MC9S12XDP512 RM](https://www.nxp.com/docs/en/data-sheet/MC9S12XDP512RMV2.pdf).
- `BDMCCRH = 0xFF07` on S12X: **UNCERTAIN**.

**Timing (from memory, verify):**
- One bit = 16 BDM clocks. Host-to-target: drive low 4 clocks for "1", 13 for "0"; the target samples around clock 10. Target-to-host: the host starts a 4-clock low and the target stretches it to 13 for "0".
- **SYNC:** host holds BKGD low ≥128 clocks of the slowest possible BDM clock; the target answers with a 128-clock low pulse, which gives the BDM speed.
- **Delays without ACK:** about 150 BDM clocks for hardware commands, about 44 (read) / 32 (write) for firmware commands, and about 64 after GO/TRACE1 (the 64-cycle figure is confirmed in a Freescale BDM reference). With ACK, the target sends a 16-clock low pulse instead.
- **CLKSW** = 0 selects the oscillator clock, 1 the bus clock (**UNCERTAIN** for S12X). If it is the oscillator, SYNC measures the crystal frequency, which also gives FCLKDIV automatically.

**Entering debug:** hold BKGD low while releasing RESET. The part starts in **special single-chip mode** with BDM active and ENBDM set, halted before the first instruction. USBDM does this with `RESET_SPECIAL|RESET_HARDWARE`.

**Errata:** MC9S12XDP512 has BDM-related errata, e.g. hardware reads corrupted on entering STOP, and PRU register accesses by BDM ([MSE9S12XDP512_1L15Y](https://www.nxp.com/docs/en/errata/MSE9S12XDP512_1L15Y.htm)).

---

## 5. Run control features our debugger needs, on BDM

- **Registers:** PC/D/X/Y/SP via firmware commands; CCR via BD space (`0xFF06` L, `0xFF07` H on S12X, **UNCERTAIN**); PPAGE/RPAGE/EPAGE/GPAGE are memory-mapped at `0x30` / `0x16` / `0x17` / `0x10`.
- **Step:** TRACE1. For step-over of `JSR`/`BSR`, set a temporary breakpoint at the next instruction and GO.
- **Breakpoints in RAM:** patch in `BGND` (opcode `0x00`), which drops into BDM when ENBDM=1.
- **Breakpoints in flash and EEPROM** (all lab code lives there): use the **S12XDBG comparators A–D** at `0x0020–0x002F`.
  - Select a comparator with COMRV in DBGC1, then write DBGXCTL/DBGXAH/M/L.
  - Set DBGC1 ARM plus BDM=1 so a match enters BDM instead of SWI.
  - Register layout is **UNCERTAIN**: verify in the RM's S12XDBGV3 chapter. hiwave's `DBG_S12X_*` / `S12XDBG_TRIGGER_A..D` ini lines show that CodeWarrior drives this module itself; the GDI layer only does memory, registers and run control.
  - That gives 2–4 hardware breakpoints, which is acceptable.
- **Live watch while running:** hardware READ commands work without halting (cycle stealing). Poll the memory and Data windows at about 5–10 Hz.
- **Stop detection:** poll `BDMSTS.BDMACT`, or `USBDM_GetBDMStatus`, every 50–100 ms.

---

## 6. Flash and EEPROM programming over plain BDM writes (fallback to the vendor algorithms)

- **Registers:**
  - Flash: `FCLKDIV 0x100`, `FSEC 0x101`, `FTSTMOD 0x102`, `FCNFG 0x103`, `FPROT 0x104`, `FSTAT 0x105` (CBEIF `0x80`, CCIF `0x40`, PVIOL `0x20`, ACCERR `0x10`), `FCMD 0x106`, `FADDR 0x108`, `FDATA 0x10A`.
  - EEPROM: the same layout at `0x110..0x11A`.
  - Taken from the lab's `.cmd` script.
- **Commands:** `0x05` erase-verify, `0x20` word program, `0x40` sector erase, `0x41` mass erase; EEPROM `0x60` sector modify (**UNCERTAIN**).
- **Sector sizes:** flash 1 KB (USBDM database); EEPROM 4 bytes (**UNCERTAIN**).
- **Sequence per word:**
  1. Clear ACCERR/PVIOL.
  2. Write the word to the target address. Use the PPAGE window, or a global address via BDMGPR or `MS_Global`.
  3. Write FCMD.
  4. Write `FSTAT = 0x80`.
  5. Poll CCIF.
- **FCLKDIV:** must give a 150–200 kHz flash clock. The script's rules: f_osc < 10 MHz → osc_kHz/175; otherwise osc_kHz/1400 + `0x40`. The default `0x49` corresponds to 16 MHz.
- **Speed estimate:** about 4 USB transactions per word at about 1 ms each gives about 4 ms/word. A lab program plus the library is about 3 KB, roughly 1500 words, so about **6 s**. That is acceptable. For speed, download a RAM routine instead (USBDM's `.s19` algorithms are GPL).
- **SECURITY (critical):** erasing the `0xFC00–0xFFFF` sector sets FSEC (`0xFF0F`) to `0xFF`, which reads as SEC=11, i.e. **secured** after the next reset. Always reprogram the word at `0xFF0E` as `0xFFFE`, as the lab script and `CHIPSECURE SETUP 0xFF0F` do.
- **Recovery:** a secured part needs a mass erase, then the unsecure sequence from `cmd/*Erase_unsecure_hcs12.cmd`.
- **COP:** write `0x03C` = 0 to disable it first, as the script does.

---

## 7. Option 4: serial monitor (AN2548)

Source: [AN2548](https://NXP.com/docs/en/application-note/AN2548.pdf), extracted locally.

- **Design:** a 2 KB monitor in block-protected `0xF800–0xFFFF`. It uses **SCI0 at 115.2 kbaud** and sets the PLL to 24 MHz from a 4/8/16 MHz crystal. User vectors are redirected to pseudo-vectors at `0xF780–0xF7FE`, and the monitor rewrites vector programming automatically. It uses the COP for hard reset. A RUN/LOAD switch on a GPIO selects the mode.
- **Handshake:** the host sends `0x0D`; the monitor's prompt is `<err><status>'>'`, with `E0 00 3E` after a cold reset.
- **Commands:** `A1` RdByte, `A2` WrByte, `A3`/`A4` word, `A5`/`A6` next, `A7`/`A8` block (≤256), `A9` regs (SP, PC, IY, IX, D, CCR), `AA`–`AF` write SP/PC/IY/IX/D/CCR, `B1` Go, `B2` Trace1, `B3` Halt, `B4` Reset, `B6` EraseAll, `B7` DeviceInfo (`DC`+PARTID), `B8` ErasePage (by PPAGE), `B9` EraseEEPROM.
- **Errors:** `E1`–`E6`, `E9`. **Status:** `00` active, `01` running, `02` halted, `04` trace, `08` cold, `0C` warm.
- **Problems for this lab:**
  - (a) It is written for HCS12 (INITRG/INITRM/INITEE, FTS flash, HCS12 DBG used for Trace1). **S12X needs a port** of the flash module code, the debug module code and the fixed memory map. A forum user reports CodeWarrior's serial monitor is "not supported on the X processors" ([NXP thread](https://community.nxp.com/thread/384399)).
  - (b) Halt and memory access depend on **SCI0 interrupts with I=0**, so stopping inside `ISR_KEYPAD` is unreliable.
  - (c) The `$FFCE`/`$FFFE` vectors and the protected top 2 KB must be handled.
  - (d) It needs a BDM pod once to flash the monitor.
  - (e) Whether the board's RS-232 is wired to SCI0 is unknown.
- **Alternative:** Elmicro's TwinPEEKs is a ready-made S12X(DP512) monitor ([elmicro](https://elmicro.com/en/hcs12tb.html)).
- **Feasibility: low-medium.** Its advantage is cost: only `serialport` and a USB-serial cable.

---

## 8. Recommended architecture

```
Electron main ──IPC──► DebugSession (TS, UI-agnostic)
                          │ uses
                          ▼
                   interface TargetConnection
   ┌───────────────┬───────────────┬──────────────────┬─────────────────┬────────────────┐
   Simulator(FCS)  UsbdmConnection  PeGdiConnection     HiwaveExternal    SerialMonitor
   (in-proc TS)    (utilityProcess  (ia32 sidecar exe,  (spawn hiwave.exe (node serialport,
                    x64 + koffi →    JSON-RPC stdio,     w/ lab .ini;      AN2548 protocol)
                    usbdm.4.dll;     hosts P&E GDI DLL   no live UI)
                    spawns USBDM     + MTWKS callbacks)
                    CLI/UsbdmScript
                    for flashing)
```

```ts
type Addr = { space: 'local'; addr: number; ppage?: number; rpage?: number; epage?: number }
          | { space: 'global'; addr: number }      // 23-bit S12X global
          | { space: 'bdm'; addr: number };        // 0xFF00-0xFFFF BD map
interface Caps { hwBreakpoints: number; ramSwBreakpoints: boolean; readWhileRunning: boolean;
                 programsFlash: boolean; programsEeprom: boolean; unsecure: boolean; trace: boolean }
interface Regs { PC: number; D: number; X: number; Y: number; SP: number; CCR: number /*16-bit S12X*/;
                 PPAGE: number; RPAGE: number; EPAGE: number; GPAGE: number }
type StopReason = 'breakpoint'|'step'|'halt'|'reset'|'bgnd'|'lostConnection';
interface TargetConnection {
  readonly kind: string; readonly caps: Caps;
  open(o: { device: 'MC9S12XDP512'; vdd?: 'off'|'3V3'|'5V'; speedHz?: number }): Promise<{ partId: number; bdmHz: number }>;
  close(): Promise<void>;
  reset(mode: 'special'|'normal'): Promise<void>;
  halt(): Promise<void>; go(): Promise<void>; step(): Promise<void>;
  isRunning(): Promise<boolean>;
  readRegs(): Promise<Regs>; writeReg(r: keyof Regs, v: number): Promise<void>;
  readMem(a: Addr, len: number): Promise<Uint8Array>; writeMem(a: Addr, d: Uint8Array): Promise<void>;
  setBreakpoint(a: Addr, kind: 'exec'|'read'|'write'): Promise<number>; clearBreakpoint(id: number): Promise<void>;
  program(img: LoadImage /* from ELF PT_LOAD: flash + EEPROM segments */,
          opt: { erase: 'selective'|'mass'; keepUnsecure: true; fclkdiv?: number },
          progress: (p: number, msg: string) => void): Promise<void>;
  on(ev: 'stopped', cb: (r: StopReason, pc: number) => void): void;
}
```

**Design rules**
- Breakpoints, step-over, the ELF/S19 loader, symbol mapping, and the local↔global address translation (section 1 formulas) live **above** the connection, in shared TS.
- Backends only provide primitives. The fallback programming algorithm (section 6) is likewise built from `readMem`/`writeMem`, so it works on any backend that cannot program by itself.
- All hardware backends run **out of process**, so a native crash or USB hang cannot kill the UI. Use JSON-RPC with timeouts; 32-bit hosts get their own ia32 exe.

**Ranking for a student**

| Rank | Backend | Hardware cost | Effort | Risk |
|---|---|---|---|---|
| 1 | **UsbdmConnection** | about $20–40 pod | Medium (koffi + spawn) | XDP512 "Untested" in USBDM; S12X CCRH and global access need verifying |
| 2 | **HiwaveExternal** + free CW 5.2 SE | Uses the lab's P&E pod | Low | No integrated UI; Windows 11 not listed; CLI flags only forum-documented |
| 3 | Simulator (already planned) | None | — | Not real hardware |
| 4 | PeGdiConnection | Lab pod | High (reverse engineering, ia32 sidecar) | Undocumented callbacks and packing; EULA |
| 5 | SerialMonitor | Serial cable (plus a pod once) | High (S12X port of AN2548) | SCI0 and interrupt conflicts with lab code |
| ✗ | Own bit-bang BDM | — | Very high | Timing is impossible over USB-serial; reinvents USBDM |

---

## 9. WSL2 caveat

- USB devices are not visible inside WSL2 unless attached with **usbipd-win** ([Microsoft docs](https://learn.microsoft.com/windows/wsl/connect-usb)).
- The P&E DLLs and drivers are Windows-only, and CodeWarrior/hiwave is Windows-only.
- **So the Electron app and all hardware sidecars must run as native Windows processes.** Develop in WSL if preferred, but build and run with Windows Node, e.g. `npm run dev` from a Windows terminal on the `\\wsl$` checkout, or package with electron-builder `--win`.
- USBDM does build on Linux and could work through usbipd, but that is not worth supporting.
- Paths: never pass `/home/...` paths to Windows tools; convert with `wslpath -w` or keep the project on the Windows filesystem.

---

## Key risks / open questions

1. **EEPROM library programming.** CodeWarrior's `.s19` lacks the EEPROM library segments that the `.abs` contains. Any S19-based flasher must get our own S19 with EEPROM included; otherwise use ELF PT_LOAD. Also check whether lab boards already hold the library in EEPROM and the instructors expect it to be reflashed every load.
2. **Security bricking.** Erasing the top flash sector leaves FSEC = `0xFF` (secured). Always rewrite `0xFF0E/0xFF0F = 0xFFFE`, and provide an "Unsecure / mass erase" command.
3. **Oscillator frequency of the ME3305 board** is unknown. FCLKDIV/ECLKDIV depend on it; the lab script defaults to `0x49` (16 MHz). Measure it with BDM SYNC, assuming CLKSW=0 selects the oscillator (**UNCERTAIN**).
4. **USBDM on XDP512** is marked "Untested" in its own database. Unverified: CCRH access (`0xFF07`?), `MS_Global` on S12X (BDMGPR vs "BDMPPR"), EEPROM paging (`pages=4`, `pageEnd=0xFF`) for plain local `0x0800` S19 records, and the exact Windows exe and DLL install paths.
5. **The student needs a USBDM pod.** The lab's P&E Multilink cannot run USBDM. Confirm the board has a standard 6-pin BDM header (BKGD/GND/RESET/VDD).
6. **P&E route:** HCS12 UNIT library availability, price and licence; the exact GDI DLL file name and bitness (assumed PE32); the CodeWarrior callback semantics; struct packing; whether the P&E DLL opens modal dialogs (`SHOWDIALOG=0` suggests it can be suppressed); EULA limits on hosting the DLL outside hiwave.
7. **CW 5.2 Special Edition on Windows 10/11 with P&E drivers.** NXP lists Windows 7–10 only. Test the P&E driver install and hiwave flags (`-Prod`, `-Target`, `-instance`, `-W`) against the official debugger manual. The lab used v5.1 project files.
8. **S12XDBG register layout** (`0x0020–0x002F`, COMRV banking, BDM-vs-SWI selection) and the BDM delay constants (150/44/32/64 clocks) come from memory and must be checked against the MC9S12XDP512 RM chapters S12XBDMV2 and S12XDBGV3.
9. **Licensing.** USBDM is GPLv2. Loading `usbdm.4.dll` via FFI, or porting its flash routines or USB protocol, may impose GPL obligations on the IDE. Decide the IDE's licence early.
10. **Interrupt-driven lab code** (Port J keypad ISR, encoder, timers) complicates TRACE1 stepping through ISRs. Decide whether to mask interrupts during step, as USBDM's `maskInterrupts` option and CodeWarrior's STEPATRUN setting do.