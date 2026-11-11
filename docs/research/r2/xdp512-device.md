# MC9S12XDP512 device model for the full-chip simulator (research notes)

This was a read-only pass. I created, changed or deleted no files.

## 0. Sources

- **[S1] Datasheet: MC9S12XDP512RMV2, Rev 2.21 (Oct 2009), "Covers S12XD, S12XB & S12XA Families":** https://www.nxp.com/docs/en/data-sheet/MC9S12XDP512RMV2.pdf
  - The file is 12.9 MB, too large for WebFetch. I streamed it with `curl | python3` and extracted text in memory.
  - Sections used: Table 1-1 (Device Register Memory Map, p.37–38), Table 1-12 (Interrupt Vector Locations, p.73–75), Ch.2 CRG, Ch.7 ECT, Ch.16 S12XINT, Ch.17 S12XMMCV2 (Ch.18 is MMCV3), Ch.22/24 PIM/EBI, and Appendix G Detailed Register Map (p.1309–1348).
- **[S2] Related device guides:** https://NXP.com/docs/en/data-sheet/9S12XDP512DGV1.pdf and the mirror https://docs.ampnuts.ru/nxp.com.datasheet/9S12XDP512DGV2.pdf. I could not read either: the first returned compressed or unrelated content, the second refused the connection.
- **[S3] CW S12(X) Assembler manual:** https://www.nxp.com/docs/en/reference-manual/CW_Assembler_HC12_RM.pdf. It documents the derivative `.inc` include mechanism.
- **[S4] NXP Community:** https://community.nxp.com/t5/S12-MagniV-Microcontrollers/Getting-started-with-MC9S12XDP512/td-p/154810. It shows `INCLUDE 'mc9s12xdp512.inc'` and says the `.inc` mask definitions carry bit numbers.
- **[S5] A CW-compiled `mc9s12xdp512.c.o`** (the stock CW register-definition source compiled into an object) on GitHub: https://github.com/TheTrueTrooper/C-Libs-For-CNT9S12XDP512Mirco-Using-MC9S12XDP512-Chip (path `Project_5_Data/Standard/ObjectCode/mc9s12xdp512.c.o`).
  - I parsed its ELF symbol table. It contains 647 register symbols with sizes.
  - It is authoritative for CodeWarrior naming, including the 16-bit register names.
- **[S6] S12XCPU reference manual (CPU12X cycle counts and stacking):** https://www.nxp.com/docs/en/reference-manual/S12XCPUV2.pdf. I did not re-fetch this URL; it is cited from knowledge.
- **[S7] The Lab3 project:** `fixtures/Lab3` (private fixtures). I used `bin/Project.map`, `bin/Project.abs`, `bin/Project.abs.s19`, `bin/Project.abs.glo`, `prm/Project.prm`, `prm/burner.bbl`, `Sources/Libraries/ME305LibV4.0.lib`, `Full_Chip_Simulation.ini` and `Sources/main.asm`.

**Stock `mc9s12xdp512.inc`: no public copy found.**
- I searched the web, the GitHub API (repository search only, because code search needs authentication) and Sourcegraph. None returned the file. The local Windows drive has no CodeWarrior install.
- The original path is known from the GENPATH baked into `main.asm.o`: `C:\Program Files (x86)\Freescale\CWS12v5.1\lib\HC12c\include\mc9s12xdp512.inc`.
- Our clone has to generate an equivalent from [S1] using the [S5] naming (§10).

---

## 1. Board-level facts the simulator relies on

How the course library drives the chip and the board, and what the golden binaries show, is in the private notes
(s12studio-fixtures research/xdp512-device.md §1). This public summary keeps only the board-level facts.

### 1.1 Reset state
- The entry point is the start of `.init` at 0xC000. Course programs start with `main` at $4000.
- Course start-up code does not write IVBR, RPAGE, EPAGE, PPAGE, DIRECT or COPCTL, so programs depend on the
  **reset defaults** (RPAGE = $FD, EPAGE = $FE, IVBR = $FF). Model them exactly.
- Course code uses CPU12X opcodes (e.g. `CLRW`), so the core must implement the S12X extensions.
- Start-up code enables the PLL and waits for LOCK, so **the simulator must eventually set LOCK**.

### 1.2 Clock (inferred; treat as strong evidence)
- **The board crystal (OSCCLK) is 16 MHz; with the PLL on, the bus is 10 MHz.** Before the PLL is engaged, the bus is 8 MHz.
  - The simulator default must be fOSC = 16 MHz.
  - UNCERTAIN: no board schematic was seen.
- **TFFCA must be emulated.** Delay code that writes an output-compare register and relies on fast-flag-clear to
  clear the flag returns immediately on every call after the first if TFFCA is ignored.

### 1.3 Board wiring (useful for the board model)

| Function | Pins / module |
|---|---|
| 40×2 HD44780 LCD | Data on PORTB ($0001, DDRB=$FF). PM4=RS, PM5=R/W, PM6=E. |
| LCD busy-flag polling | Course code polls the busy flag after each write. **The LCD model must answer status reads with BF=0, otherwise the code hangs.** |
| Keypad (encoder chip with DA line) | PK0–4 = key code (inputs), PK5 = output (driven 0), PJ7 = DA, falling-edge interrupt with pull-up. Key table in `packages/devices/src/me3305.ts` (codes 0..19). **PJ7 must still be low when a key ISR waits on it, otherwise it spins.** |
| Quadrature counter (LS7366R) | SPI0, chip select PH0 (active low). |
| 12-bit dual DAC (MCP4922-style; part UNCERTAIN) | SPI0, chip select PH1 (active low). One 16-bit word per write: config nibble + 12-bit data. |
| DC motor | PWM ch0:1 concatenated, output on **PP1**. PA4 = direction, PA6 = enable (PA5/PA7 inputs). |
| Motor current / analog | ATD1 ch0 |
| LEDs | PTP4–7 (student code) |

### 1.4 Loader note
- `prm/burner.bbl` exports only $4000–$7FFF, $C000–$FFFF and the paged flash into `.s19`/`.glo`. **Code placed in
  EEPROM is absent from the S19** and appears only in `Project.abs` (ELF PT_LOAD segments).
- The simulator must load the `.abs` ELF, not the S19.
- ELF vaddrs are local (logical) addresses, including the paged EEPROM window. Load them through the MMC, assuming reset page registers (EPAGE=$FE), or map them explicitly to global addresses (§2.3).

---

## 2. S12X MMC (S12XMMCV2/V3, [S1] Ch.17/18)

### 2.1 Registers and reset values

| Addr | Name | Bits | Reset | Write rules |
|---|---|---|---|---|
| $000A | MMCCTL0 | CS2E..CS0E (chip selects) | $00 | n/a for single-chip |
| $000B | MODE | MODC MODB MODA (bits 7..5) | from mode pins; normal single-chip = $80, special single-chip = $00 | see [S1] |
| $0010 | GPAGE | GP6..0 | $00 | anytime |
| $0011 | DIRECT | DP15..8 | $00 | **once only in normal modes**, anytime in special modes |
| $0013 | MMCCTL1 | EROMON, ROMHM, ROMON | ROMON=1 in single-chip | ROMHM: once in normal mode |
| $0016 | RPAGE | RP7..0 | **$FD** | anytime |
| $0017 | EPAGE | EP7..0 | **$FE** | anytime |
| $0030 | PPAGE | PIX7..0 | **$FE** | anytime |
| $011C | RAMWPC | RPWE, AVIE, AVIF | $00 | XGATE RAM protection (vector $FF60) |
| $011D–$011F | RAMXGU / RAMSHL / RAMSHU | | $FF-ish (bit 7 reads 1) | |
| $0121 | IVBR | IVB_ADDR | **$FF** | anytime (S12XINT) |

The `DIRECT` reset value is $00. Its effect: the direct-addressing (8-bit operand) effective address is `DIRECT<<8 | opr8`.

### 2.2 Device memory sizes (XDP512) and their global ranges

| Resource | Size | Global range | Page register range |
|---|---|---|---|
| Registers | 2 KB | $00_0000–$00_07FF | |
| RAM | 32 KB | $0F_8000–$0F_FFFF | RPAGE $F8–$FF |
| EEPROM | 4 KB | $13_F000–$13_FFFF | EPAGE $FC–$FF |
| Flash | 512 KB | $78_0000–$7F_FFFF | PPAGE $E0–$FF |

These ranges match `Project.prm` (RAM_F8.., EEPROM_FC.., PAGE_E0..) and `burner.bbl` (local $4000 → $7F4000, $C000 → $7FC000). Global space is 8 MB ($00_0000–$7F_FFFF); $14_0000–$3F_FFFF is external space, which does not exist in single-chip mode.

### 2.3 Local (CPU 16-bit) to global (23-bit) translation, exact for this device in single-chip mode with ROMHM=0
```ts
function localToGlobal(a: number, s: MMC): number {
  if (a < 0x0800) return a;                                        // registers
  if (a < 0x0C00) return 0x100000 | (s.EPAGE << 10) | (a & 0x3FF); // EEPROM window
  if (a < 0x1000) return 0x13FC00 | (a & 0x3FF);                   // fixed EEPROM page $FF
  if (a < 0x2000) return (s.RPAGE << 12) | (a & 0xFFF);            // RAM window
  if (a < 0x4000) return 0x0FC000 + a;                             // fixed RAM pages $FE,$FF -> $0F_E000..$0F_FFFF
  if (a < 0x8000) return 0x7F4000 + (a - 0x4000);                  // fixed flash page $FD
  if (a < 0xC000) return 0x400000 | (s.PPAGE << 14) | (a & 0x3FFF);// flash window
  return 0x7FC000 + (a - 0xC000);                                  // fixed flash page $FF (vectors)
}
// Global instructions (GLDAA/GSTAA/GLDD... prefix 0x18): global = (GPAGE<<16) | addr16
```
- The RPAGE, EPAGE and PPAGE formulas come from [S1] figures 17-12, 17-13 and 17-15. Fixed-page equivalences come from the [S1] text: "$2000–$2FFF = RAM page $FE, $3000–$3FFF = page $FF", "$0C00–$0FFF = EEPROM page $FF", and "Unpaged 16K or PPAGE $FD/$FF" in Fig 17-21.
- **Caveat [S1]:** "Because RAM page 0 has the same global address as the register space, it is possible to write to registers through the RAM space when RPAGE = $00." Emulate this: global $00_0000–$00_07FF must dispatch to the register file.
- **Unimplemented pages** (RPAGE < $F8, EPAGE < $FC, PPAGE < $E0 in single-chip mode): [S1] lists an "illegal address reset" as a reset source (vector $FFFE) and sets CRGINT.ILAF.
  - UNCERTAIN: exactly which unimplemented accesses trigger it in MMCV2 vs V3.
  - Recommendation: make it configurable as (a) illegal-address reset with ILAF=1 (default), or (b) halt the debugger with a message.
- **Flash and EEPROM are read-only to normal CPU writes.** Writes go through the FCMD/ECMD state machines (§9). The simulator loader writes them directly.
- **Porting hazard:** HCS12 (DG256 / Dragon12) code writes INITRM/INITRG/INITEE at $0010/$0011/$0012. On S12X those addresses are GPAGE, DIRECT (write-once) and reserved. The simulator should warn when it sees such writes.
- `Project.prm` keeps `EEPROM` ending at 0x0FFB. UNCERTAIN: $0FFC–$0FFF is probably the EEPROM protection/config field (EPROT loaded from $0FFD). Do not let the linker place code there.

---

## 3. Register map, $0000–$07FF ([S1] Table 1-1 and Appendix G, verified)

| Range | Module |
|---|---|
| $0000–$0009 | PIM: PORTA $00, PORTB $01, DDRA $02, DDRB $03, PORTC $04, PORTD $05, DDRC $06, DDRD $07, PORTE $08, DDRE $09 (DDRE1:0 read 0; PE0=IRQ, PE1=XIRQ inputs) |
| $000A–$000B | MMCCTL0, MODE |
| $000C–$000D | PUCR $0C (PUPKE BKPUE – PUPEE PUPDE PUPCE PUPBE PUPAE; **reset $D0**), RDRIV $0D |
| $000E–$000F | EBICTL0/1 |
| $0010–$0017 | GPAGE, DIRECT, rsvd, MMCCTL1, rsvd, rsvd, RPAGE, EPAGE |
| $001A–$001B | PARTIDH = $C4, PARTIDL = maskset-dependent (UNCERTAIN) |
| $001C | ECLKCTL (NECLK NCLKX2 .. EDIV1:0) |
| $001E | IRQCR (IRQE IRQEN; reset $40) |
| $0020–$002F | DBG (§9) |
| $0030 | PPAGE |
| $0032–$0033 | PORTK, DDRK |
| $0034–$003F | CRG: SYNR $34, REFDV $35, CTFLG $36, CRGFLG $37, CRGINT $38, CLKSEL $39, PLLCTL $3A, RTICTL $3B, COPCTL $3C, FORBYP $3D, CTCTL $3E, ARMCOP $3F |
| $0040–$007F | ECT (§5) |
| $0080–$00AF | ATD1 (16 ch): CTL0..5 $80–$85, STAT0 $86, TEST0/1 $88/$89, STAT2/1 $8A/$8B, **ATD1DIEN0/1 $8C/$8D**, ATD1PTAD0/1 $8E/$8F, DR0H..DR15L $90–$AF |
| $00B0–$00B7 | IIC1: IBAD, IBFD, IBCR, IBSR, IBDR |
| $00B8 / $00C0 / $00C8 / $00D0 | SCI2 / SCI3 / SCI0 / SCI1 (8 bytes each) |
| $00D8–$00DF | SPI0: CR1 $D8, CR2 $D9, BR $DA, SR $DB, DR $DD |
| $00E0–$00E7 | IIC0 |
| $00F0 / $00F8 | SPI1 / SPI2 (same layout: CR1, CR2, BR, SR, –, DR) |
| $0100–$010B | Flash FTX512K4 (§9) |
| $0110–$011B | EEPROM: ECLKDIV $110, ECNFG $113, EPROT $114, ESTAT $115, ECMD $116, EADDRHI/LO $118/$119, EDATAHI/LO $11A/$11B |
| $011C–$011F | MMC RAMWPC / RAMXGU / RAMSHL / RAMSHU |
| $0120–$012F | XINT: IVBR $121, INT_XGPRIO $126, INT_CFADDR $127, INT_CFDATA0–7 $128–$12F |
| $0130 / $0138 | SCI4 / SCI5 |
| $0140 / $0180 / $01C0 / $0200 / $0280 | CAN0 / CAN1 / CAN2 / CAN3 / CAN4 (64 bytes each). Stub only. |
| $0240–$027F | PIM ports T/S/M/P/H/J/AD (§6) |
| $02C0–$02DF | ATD0 (8 ch): CTL0..5 $2C0–$2C5, STAT0 $2C6, TEST0/1 $2C8/$2C9, STAT1 $2CB, **ATD0DIEN $2CD**, ATD0PTAD0 $2CF, DR0H..DR7L $2D0–$2DF |
| $02F0–$02F7 | VREG: VREGHTCL, VREGCTRL $2F1 (LVDS LVIE LVIF), VREGAPICL $2F2 (APICLK APIFE APIE APIF), VREGAPITR $2F3, VREGAPIRH/L $2F4/$2F5 |
| $0300–$0327 | PWM (§7) |
| $0340–$0357 | PIT (§5) |
| $0380–$03BF | XGATE: XGMCTL $380/1, XGCHID $382, XGVBR $384–7, XGIF $388–$397, XGSWT $398, XGSEM $39A, XGCCR $39D, XGPC $39E, XGR1–7 $3A2–$3AF. Stub, no XGATE execution. |
| $03C0–$07FF | unimplemented: reads 0, writes ignored |

### CRG bit layouts [S1] App G / Ch.2

| Register | Bits (7..0) | Reset |
|---|---|---|
| SYNR | – – SYN5..0 | $00 |
| REFDV | – – REFDV5..0 | $00 |
| CRGFLG | RTIF PORF LVRF LOCKIF LOCK TRACK SCMIF SCM | PORF=1 after power-on; flags W1C |
| CRGINT | RTIE ILAF – LOCKIE – – SCMIE – | $00 (ILAF set by illegal-address reset) |
| CLKSEL | PLLSEL PSTP – – PLLWAI – RTIWAI COPWAI | $00 |
| PLLCTL | CME PLLON AUTO ACQ FSTWKP PRE PCE SCME | **$F1** |
| RTICTL | RTDEC RTR6..0 | $00 |
| COPCTL | WCOP RSBCK WRTMASK(write-only) – – CR2 CR1 CR0 | device-specific, see §4 |
| ARMCOP | write $55 then $AA | $00 |

---

## 4. CRG behaviour to implement

- **Clocks:**
  - `PLLCLK = 2·OSCCLK·(SYNR+1)/(REFDV+1)` [S1 eq. under Fig 2-5].
  - `SYSCLK = PLLSEL ? PLLCLK : OSCCLK`; `BUSCLK = SYSCLK/2`.
  - VCO range 8–80 MHz [S1 App A].
- **SYNR/REFDV:** writes are ignored while PLLSEL=1 [S1]. A write re-initialises the lock detector, which clears LOCK and TRACK [S1].
  - Model: once PLLON=1 and SYNR/REFDV are stable, set LOCK=1 and LOCKIF=1 after `tLock`. Make tLock configurable; default about 100–500 µs of simulated time. UNCERTAIN: exact spec value.
  - Setting PLLSEL while LOCK=0 (with AUTO=1) has no effect. This is from memory; UNCERTAIN.
- **RTI:** clocked from OSCCLK, not the bus.
  - RTDEC=0: period = (RTR[3:0]+1) × 2^(RTR[6:4]+9) OSC cycles, and RTR[6:4]=000 means off [S1 Table 2-7].
  - RTDEC=1 (decimal): (RTR[3:0]+1) × {1,2,5,10,20,50,100,200}×10³ for RTR[6:4]=0..7. From memory; UNCERTAIN.
  - The tick sets RTIF; the interrupt goes to vector $FFF0 when RTIE=1.
- **COP:**
  - CR[2:0] = 000 means disabled; 001..111 give 2^14, 2^16, 2^18, 2^20, 2^22, 2^23, 2^24 OSCCLK cycles [S1 Table 2-10].
  - Service it by writing $55 then $AA to ARMCOP. Any other write, or the wrong order, while the COP is enabled causes a COP reset (vector $FFFA).
  - When WCOP=1, a write in the first 75% of the period also causes a reset [S1 Fig 2-15 text].
  - COPCTL is write-once in normal modes; RSBCK stops the COP and RTI in active BDM.
  - Reset value: [S1] says "Refer to Device User Guide (Section: CRG) for reset values of WCOP, CR2..CR0". On S12XD these are loaded from the flash configuration byte at **$FF0E** (via FCTL NV bits).
    - An [S1] code example disables the COP with `ORG $FF0E / DW $FFFE`. That implies an erased $FF0E = COP disabled, i.e. an inverted NV→CR mapping. UNCERTAIN.
    - Lab3 never writes $FF0E, so **the default simulator configuration should start with the COP disabled.** Still implement the COP for students who enable it.
- **Self-clock mode, clock monitor, PSTP, WAI/STOP:** low priority. Model STOP/WAI as CPU halt until an interrupt.

---

## 5. ECT ($0040–$007F) and PIT ($0340–$0357)

### 5.1 ECT registers [S1] App G

| Addr | Register |
|---|---|
| $40 | TIOS |
| $41 | CFORC (write-only FOC7..0) |
| $42 / $43 | OC7M / OC7D |
| $44–$45 | TCNT |
| $46 | TSCR1 = TEN TSWAI TSFRZ **TFFCA** PRNT |
| $47 | TTOV |
| $48–$49 | TCTL1/2 (OMn:OLn pairs: 00 disconnected, 01 toggle, 10 clear, 11 set) |
| $4A–$4B | TCTL3/4 (EDGnB:A pairs: 00 off, 01 rising, 10 falling, 11 both) |
| $4C | TIE |
| $4D | TSCR2 = TOI – – – TCRE PR2..0 |
| $4E / $4F | TFLG1 / TFLG2 (TOF) |
| $50–$5F | TC0–TC7 |
| $60 | PACTL = – PAEN PAMOD PEDGE CLK1 CLK0 PAOVI PAI |
| $61 | PAFLG |
| $62–$65 | PACN3..0 (CW 16-bit names `PACN32` = PACA, `PACN10` = PACB) |
| $66 | MCCTL = MCZI MODMC RDMCL ICLAT(w) FLMC(w) MCEN MCPR1:0 |
| $67 | MCFLG |
| $68 / $69 / $6A / $6B | ICPAR / DLYCT / ICOVW / ICSYS |
| $6E / $6F | PTPSR / PTMCPSR |
| $70 / $71 | PBCTL / PBFLG |
| $72–$75 | PA3H..PA0H |
| $76–$77 | MCCNT |
| $78–$7F | TC0H..TC3H (holding registers) |

### 5.2 ECT semantics
- **Counter:** TCNT runs at bus/2^PR when TEN=1. If PRNT=1, the precision prescaler PTPSR applies instead. TOF is set on overflow. TCRE resets the counter on an OC7 match.
- **Flag clearing:**
  - TFLG1/TFLG2 are write-1-to-clear.
  - **With TFFCA=1:** a read of TCn clears CnF for input captures; a write of TCn clears CnF for output compares; any access to TCNT clears TOF; an access to PACNT clears PAFLG.
- **TSFRZ:** the timer stops while the debugger is halted. Natural in the simulator.
- **Interrupt vectors:** ch0–7 at $FFEE..$FFE0, overflow $FFDE, PA overflow $FFDC, PA edge $FFDA, modulus down counter $FFCA, PB overflow $FFC8.
- The input-capture "enhanced" features (holding registers, ICOVW, delay counter) can be simplified at first.

### 5.3 PIT [S1] App G

| Addr | Register |
|---|---|
| $340 | PITCFLMT = PITE PITSWAI PITFRZ – – – PFLMT1:0 (write-only force-load micro timers) |
| $341 | PITFLT (write-only PFLT3..0) |
| $342 | PITCE |
| $343 | PITMUX (channel n uses micro time base 0 or 1) |
| $344 | PITINTE |
| $345 | PITTF (W1C) |
| $346 / $347 | PITMTLD0 / PITMTLD1 (8-bit) |
| $348 / $34C / $350 / $354 | PITLD0..3 (16-bit) |
| $34A / $34E / $352 / $356 | PITCNT0..3 |

- **Period:** (PITMTLD[mux]+1)·(PITLDn+1)/f_BUS. On timeout, set PTFn and reload.
- **Vectors:** $FF7A (ch0), $FF78, $FF76, $FF74 (ch3).

---

## 6. PIM: ports T, S, M, P, H, J, AD ($0240–$027F) [S1] App G

| Port | Data | Input | DDR | RDR | PER | PPS | Other |
|---|---|---|---|---|---|---|---|
| T | PTT $240 | PTIT $241 | DDRT $242 | $243 | PERT $244 | PPST $245 | |
| S | PTS $248 | PTIS $249 | DDRS $24A | $24B | PERS $24C | PPSS $24D | WOMS $24E |
| M | PTM $250 | PTIM $251 | DDRM $252 | $253 | PERM $254 | PPSM $255 | WOMM $256, MODRR $257 |
| P | PTP $258 | PTIP $259 | DDRP $25A | $25B | PERP $25C | PPSP $25D | **PIEP $25E, PIFP $25F** |
| H | PTH $260 | PTIH $261 | DDRH $262 | $263 | PERH $264 | PPSH $265 | **PIEH $266, PIFH $267** |
| J | PTJ $268 | PTIJ $269 | DDRJ $26A | $26B | PERJ $26C | PPSJ $26D | **PIEJ $26E, PIFJ $26F** (bit 3 unimplemented) |
| AD0 | PT1AD0 $271 | | DDR1AD0 $273 | $275 | PER1AD0 $277 | | digital input enable in ATD0DIEN $2CD |
| AD1 | PT0AD1/PT1AD1 $278/9 | | DDR0AD1/1 $27A/B | $27C/D | PER0AD1/1 $27E/F | | ATD1DIEN0/1 $8C/$8D |

Plus PORTA/B/E/K and PUCR in low register space (§3).

Semantics:
- **Pin reads:** reading PTx returns the latch for output bits and the pin level for input bits. PTIx always returns the pin level.
- **Pulls:** PPSx=0 selects a pull-up, PPSx=1 a pull-down, both gated by PERx and applied only when the pin is an input.
- **Key wakeups (P, H, J):** an active edge on an input pin sets PIFx.n. PPS=0 means falling edge, PPS=1 means rising edge. PIFx is write-1-to-clear. A pending PIEx.n & PIFx.n raises an interrupt.
- **KWU vectors:** Port J $FFCE (#24), Port H $FFCC (#25), Port P $FF8E (#56).
- UNCERTAIN: the [S1] PIM chapter mentions a digital glitch filter on KWU pins. Ignore it, or model a minimum pulse width.
- **MODRR** reroutes SPI0/1/2 (and CAN) onto port M/P/H pins. Default 0 means SPI0 uses PS4 MISO, PS5 MOSI, PS6 SCK, PS7 SS.
- **Package:** the 112-pin XDP512 has no Port C or D (stub them as RAM-backed).

---

## 7. ATD, PWM, SPI, SCI, IIC (key formulas)

- **ATDx:**
  - CTL2 bits: ADPU AFFC AWAI ETRIGLE ETRIGP ETRIGE ASCIE ASCIF.
  - CTL3 bits: – S8C S4C S2C S1C FIFO FRZ1 FRZ0. A sequence length of 0 means 8 conversions on ATD0, and 8 on ATD1 as well (16 when S8C..S1C allow it).
  - CTL4 bits: SRES8 SMP1:0 PRS4:0. f_ATDclk = bus/(2·(PRS+1)).
  - CTL5 bits: DJM DSGN SCAN MULT CD CC CB CA. Writing CTL5 starts a sequence. STAT0 SCF is set when it completes.
  - Result registers are 16-bit: DJM=0 left-justified, DJM=1 right-justified.
  - Conversion time ≈ (2+2^(SMP+1)+10 or 8) ATD clocks. UNCERTAIN: exact constants.
  - Vectors: ATD0 $FFD2, ATD1 $FFD0.
- **PWM:**
  - Registers: PWME $300, PWMPOL $301, PWMCLK $302, PWMPRCLK $303 (PCKB2:0, PCKA2:0), PWMCAE $304, PWMCTL $305 (CON67 CON45 CON23 CON01 PSWAI PFRZ), PWMSCLA/B $308/$309, PWMCNT0-7 $30C–$313, PWMPER0-7 $314–$31B, PWMDTY0-7 $31C–$323, PWMSDN $324.
  - Clocks: A = bus/2^PCKA, SA = A/(2·SCLA) where SCLA=0 means 256. B and SB work the same way.
  - Left-aligned period = PER·Tclk and duty = DTY/PER; PPOL=1 means the output starts high.
  - When concatenated (CONxy), the even channel holds the high byte and the odd channel's pin is the output.
  - Emergency-shutdown vector: $FF8C.
- **SPIx:**
  - CR1 bits: SPIE SPE SPTIE MSTR CPOL CPHA SSOE LSBFE. CR2 bits: MODFEN BIDIROE SPISWAI SPC0.
  - BR: SPPR2:0, SPR2:0. Baud = bus/((SPPR+1)·2^(SPR+1)). For example, $50 gives bus/12 ≈ 833 kHz.
  - SR bits: SPIF, SPTEF, MODF. SPIF is cleared by reading SR and then DR. SPTEF is cleared by reading SR and then writing DR.
  - A transfer takes 8 SPI bit-times. The board model receives MOSI and returns MISO.
  - Vectors: SPI0 $FFD8, SPI1 $FFBE, SPI2 $FFBC.
- **SCIx:**
  - With AMAP=0: BDH (IREN TNP1:0 SBR12:8), BDL, CR1. With AMAP=1: ASR1, ACR1, ACR2 at the same addresses.
  - CR2 bits: TIE TCIE RIE ILIE TE RE RWU SBK. SR1 bits: TDRE TC RDRF IDLE OR NF FE PF.
  - SR2 bits: AMAP TXPOL RXPOL BRK13 TXDIR RAF. Data registers: DRH (R8 T8), DRL.
  - Baud = bus/(16·SBR).
  - Vectors: SCI0 $FFD6, SCI1 $FFD4, SCI2 $FF8A, SCI3 $FF88, SCI4 $FF86, SCI5 $FF84.
- **IIC0/IIC1:** IBAD, IBFD, IBCR (IBEN IBIE MS/SL TX/RX TXAK RSTA IBSWAI), IBSR (TCF IAAS IBB IBAL SRW IBIF RXAK), IBDR. Vectors: IIC0 $FFC0, IIC1 $FF82.

---

## 8. S12XINT and the full vector table

**XINT registers:**
- IVBR $0121 (reset $FF).
- INT_XGPRIO $0126 (XILVL2:0, reset $01).
- INT_CFADDR $0127 (bits 7:4 select a block of 8 vectors).
- INT_CFDATA0..7 $0128–$012F (RQST, PRIOLVL2:0; **reset $01**).
  - CFDATAn configures the vector at `IVBR:(CFADDR&$F0) + 2n`. Example: Port J ($CE) is CFADDR=$C0, CFDATA7.
  - RQST=1 routes the request to XGATE.
  - PRIOLVL=0 disables the source. Unused channels read 0.

**Arbitration rule:**
- An I-maskable request is taken when I=0 and PRIOLVL > CCR.IPL (IPL is CCRH bits 10:8 on the S12X CPU).
- Among requests of equal level, the higher vector address wins.
- On entry the CPU sets I and sets IPL to the request's level. RTI restores both.
- Fixed priority order: reset > clock-monitor reset > COP reset > TRAP > SWI > XIRQ > IRQ > I-maskable.
- Only $FFFA–$FFFE are independent of IVBR. TRAP, SWI, XIRQ, IRQ and the spurious vector are all relative to IVBR.

**Vector table** ([S1] Table 1-12; "Vector base" = IVBR·$100, $FF00 at reset). Vector # = (0xFE − offset)/2, which is the CodeWarrior `VECTOR n` number (the prm comment `VECTOR 24 ISR_KEYPAD` matches $FFCE).

| Addr | # | XG ch | Source | Mask | Local enable |
|---|---|---|---|---|---|
| FFFE | 0 | – | Reset (pin/POR/LVR/illegal address) | none | – |
| FFFC | 1 | – | Clock-monitor reset | none | PLLCTL CME, SCME |
| FFFA | 2 | – | COP reset | none | COP rate |
| FFF8 | 3 | – | Unimplemented-opcode trap | none | – |
| FFF6 | 4 | – | SWI (also BDM vector request) | none | – |
| FFF4 | 5 | – | XIRQ | X | – |
| FFF2 | 6 | – | IRQ | I | IRQCR.IRQEN |
| FFF0 | 7 | 78 | RTI | I | CRGINT.RTIE |
| FFEE–FFE0 | 8–15 | 77–70 | ECT ch0..ch7 | I | TIE.C0I..C7I |
| FFDE | 16 | 6F | ECT overflow | I | TSCR2.TOI |
| FFDC | 17 | 6E | PA-A overflow | I | PACTL.PAOVI |
| FFDA | 18 | 6D | PA input edge | I | PACTL.PAI |
| FFD8 | 19 | 6C | SPI0 | I | SPI0CR1 SPIE, SPTIE |
| FFD6 | 20 | 6B | SCI0 | I | SCI0CR2 TIE TCIE RIE ILIE |
| FFD4 | 21 | 6A | SCI1 | I | SCI1CR2 |
| FFD2 | 22 | 69 | ATD0 | I | ATD0CTL2.ASCIE |
| FFD0 | 23 | 68 | ATD1 | I | ATD1CTL2.ASCIE |
| **FFCE** | **24** | 67 | **Port J** | I | PIEJ |
| FFCC | 25 | 66 | Port H | I | PIEH |
| FFCA | 26 | 65 | Modulus down-counter underflow | I | MCCTL.MCZI |
| FFC8 | 27 | 64 | PA-B overflow | I | PBCTL.PBOVI |
| FFC6 | 28 | 63 | CRG PLL lock | I | CRGINT.LOCKIE |
| FFC4 | 29 | 62 | CRG self-clock mode | I | CRGINT.SCMIE |
| FFC2 | 30 | – | reserved | | |
| FFC0 | 31 | 60 | IIC0 | I | IBCR0.IBIE |
| FFBE | 32 | 5F | SPI1 | I | SPI1CR1 |
| FFBC | 33 | 5E | SPI2 | I | SPI2CR1 |
| FFBA | 34 | 5D | EEPROM | I | ECNFG CCIE, CBEIE |
| FFB8 | 35 | 5C | Flash | I | FCNFG CCIE, CBEIE |
| FFB6–FFB0 | 36–39 | 5B–58 | CAN0 wake/err/rx/tx | I | CAN0RIER/TIER |
| FFAE–FFA8 | 40–43 | 57–54 | CAN1 | I | |
| FFA6–FFA0 | 44–47 | 53–50 | CAN2 | I | |
| FF9E–FF98 | 48–51 | 4F–4C | CAN3 | I | |
| FF96–FF90 | 52–55 | 4B–48 | CAN4 | I | |
| FF8E | 56 | 47 | Port P | I | PIEP |
| FF8C | 57 | 46 | PWM emergency shutdown | I | PWMSDN.PWMIE |
| FF8A | 58 | 45 | SCI2 | I | |
| FF88 | 59 | 44 | SCI3 | I | |
| FF86 | 60 | 43 | SCI4 | I | |
| FF84 | 61 | 42 | SCI5 | I | |
| FF82 | 62 | 41 | IIC1 | I | |
| FF80 | 63 | 40 | Low-voltage interrupt | I | VREGCTRL.LVIE |
| FF7E | 64 | 3F | API (autonomous periodic interrupt) | I | VREGAPICL.APIE |
| FF7C | 65 | – | reserved | | |
| FF7A–FF74 | 66–69 | 3D–3A | PIT ch0..3 | I | PITINTE |
| FF72–FF64 | 70–77 | 39–32 | XGATE software trigger 0..7 | I | XGMCTL.XGIE |
| FF62 | 78 | – | XGATE software error | I | XGMCTL.XGIE |
| FF60 | 79 | – | CPU RAM access violation | I | RAMWPC.AVIE |
| FF12–FF5E | 80–118 | – | reserved | | |
| FF10 | 119 | – | Spurious interrupt | none | – |

**Lab3 only programs $FFFE and $FFCE.** Every other vector is erased ($FFFF). The simulator should warn ("vector not initialised") when it takes one, instead of jumping to $FFFF silently.

---

## 9. DBG / BDM and the Flash/EEPROM controllers

**DBG (S12XDBG, $0020–$002F):**
- DBGC1 ($20: ARM, TRIG, XGSBPE, BDM, DBGBRK, COMRV1:0), DBGSR ($21: TBF EXTF SSF2:0), DBGTCR ($22: TSOURCE TRANGE TRCMOD TALIGN), DBGC2 ($23: CDCM ABCM), DBGTBH/L ($24/$25, `DBGTB`), DBGCNT ($26), DBGSCRX ($27).
- The comparator window is selected by COMRV: DBGXCTL $28, DBGXAH/AM/AL $29–$2B (24-bit global address), DBGXDH/DL $2C/$2D, DBGXDHM/DLM $2E/$2F.
- Recommendation: simulator breakpoints stay internal, as in hiwave. Expose the DBG registers as RAM-backed with ARM/TRIG to breakpoint behaviour as a stretch goal. The user does not normally touch them.
- **BGND** (opcode $00): with BDM enabled (debugger attached) the simulator should halt like a breakpoint.
- BDM firmware registers ($7F_FF00 area / BDMSTS) are invisible to user code.

**Flash (FTX512K4, $0100–$010B):**
- FCLKDIV ($100: FDIVLD, PRDIV8, FDIV5:0), FSEC ($101: KEYEN1:0, SEC1:0, loaded from $FF0F), FTSTMOD ($102), FCNFG ($103: CBEIE CCIE KEYACC), FPROT ($104: FPOPEN FPHDIS FPHS1:0 FPLDIS FPLS1:0, loaded from $FF0D), FSTAT ($105: CBEIF CCIF PVIOL ACCERR BLANK), FCMD ($106), FCTL ($107: NV7:0, read-only), FADDR ($108/9), FDATA ($10A/B).
- Command set from memory (UNCERTAIN): $05 erase-verify, $20 word program, $40 sector erase, $41 mass erase, $47 sector-erase abort.
- **EEPROM (EETX4K):** same model, plus $60 sector modify (UNCERTAIN).
- Flash configuration field $FF00–$FF0F: backdoor key $FF00–$FF07, FPROT $FF0D, COP/NV byte $FF0E, FSEC $FF0F ($FE = unsecured).
- Recommendation: implement a minimal command state machine (CBEIF/CCIF/ACCERR/PVIOL) with immediate completion. A student who writes EEPROM from assembly then gets plausible results.

---

## 10. Equivalent of the stock `mc9s12xdp512.inc` our clone must ship

**What is established:**
- It is in `{Compiler}lib\HC12c\include` (from the GENPATH in [S7]).
- `derivative.inc` does `INCLUDE 'mc9s12xdp512.inc'` [S4, S7].
- [S4] says the file defines bit-number and mask symbols.
- Any EQU name in our file must not clash with typical student labels, since student projects include it.

**Register names:** take them from [S5], the symbol table of the stock compiled `mc9s12xdp512.c`. The 16-bit composites are:
- `PORTAB DDRAB PORTCD DDRCD PARTID TCNT TC0..TC7 TC0H..TC3H PACN32 PACN10 PA32H PA10H MCCNT PITLD0..3 PITCNT0..3 PWMCNT01/23/45/67 PWMPER01.. PWMDTY01.. SCI0BD..SCI5BD ATD0CTL01/23/45 ATD1CTL01/23/45 ATD0DR0..7 ATD1DR0..15 ATD1DIEN ATD1PTAD PT01AD1 DDR01AD1 RDR01AD1 PER01AD1 FADDR FDATA EADDR EDATA DBGTB VREGAPIR XGMCTL XGVBR XGSWT XGSEM XGPC XGR1..7 XGIF_7F_70..`
- The IIC names are prefixed: `IIC0_IBAD`, `IIC0_IBCR`, `IIC1_...`.
- Byte names (PORTA, PORTB, TC0Hi?) must also exist.

**Recommended generated layout** (the CW 5.x pattern; exact comment text and the Hi/Lo naming are UNCERTAIN):
```asm
;*** PTP - Port P I/O Register; 0x00000258 ***
PTP:                equ       $00000258
            ;bit numbers for usage in BCLR, BSET, BRCLR and BRSET
PTP_PTP0:           equ       0
...
            ;bit masks
mPTP_PTP0:          equ       %00000001
...
; 16-bit registers: TCNT equ $0044 plus TCNT_BIT15..TCNT_BIT0 ; also provide byte aliases (UNCERTAIN names, e.g. TCNTHi/TCNTLo)
; Trailer: interrupt vector addresses (Vreset equ $FFFE ... Vportj equ $FFCE ...), memory-map EQUs (RAMStart/RAMEnd, ROM_4000Start...)
```

**Generate it from one JSON device description** (registers, bits, reset values, access type). The same JSON should drive:
1. the `.inc` file,
2. the simulator register file, including reset values and W1C/RO/write-once masks, and
3. the debugger's register window (hiwave "Register" component groups).

Validate addresses against [S1] Appendix G, which is the full list above.

---

## 11. Simulator implementation checklist for this device

1. **Memory:** an 8 MB sparse global space with backing arrays RAM[32K]@0x0F8000, EE[4K]@0x13F000 and FLASH[512K]@0x780000, plus an I/O dispatch for 0x000000–0x0007FF. CPU accesses use `localToGlobal` (§2.3); G-instructions use GPAGE.
2. **Reset:**
   - Load register reset values: RPAGE=$FD, EPAGE=$FE, PPAGE=$FE, IVBR=$FF, PLLCTL=$F1, PUCR=$D0, IRQCR=$40, INT_CFDATA*=$01.
   - Set CCR to I=1 and X=1. Fetch PC from $FFFE (global $7F_FFFE).
   - MODE depends on the target: normal single-chip $80, or special single-chip $00 under BDM.
     - UNCERTAIN which mode hiwave FCS and the Multilink use. Recommended default: special single-chip, so write-once registers stay writable, matching debugger sessions.
3. **Time base:** advance peripherals by bus cycles from the CPU core. Clock tree from §4 with fOSC default 16 MHz, configurable. The RTI and COP use OSCCLK.
4. **Must-haves for Lab3:**
   - CRG PLL lock flag.
   - ECT with TFFCA, prescaler and output compare.
   - PIM with PIF/PIE edge detection on Port J and pull devices.
   - SPI0 master transfers with SPIF/SPTEF timing.
   - PWM 16-bit concatenation (for the motor labs).
   - ATD sequence completion.
   - XINT vectoring through IVBR and priority.
   - EEPROM code execution through the EPAGE window.
5. **Board models (separate layer):** HD44780 on PORTB/PM4-6 (with busy flag), keypad on PK0-4/PJ7, LS7366 on SPI0+PH0, DAC on SPI0+PH1, motor plus encoder on PP1/PA4/PA6, LEDs on PTP4-7.

---

## Key risks / open questions

1. **No copy of the stock `mc9s12xdp512.inc` was found online.** Exact symbol spellings (byte halves of 16-bit registers, vector EQU names, the memory-map EQUs trailer) are UNCERTAIN.
   - Mitigation: generate the file from [S1] plus the [S5] names.
   - Better: get the real file from any CW 5.1 install, e.g. a Cal Poly lab PC.
2. **The 16 MHz crystal is inferred** from the timing the course code expects, not from a schematic. Confirm against the Cal Poly ME3305 board documentation.
3. **COP reset configuration** (the $FF0E → COPCTL mapping on S12XD) and the reset MODE under hiwave FCS or a BDM connection are not verified. The defaults chosen are: COP off, special single-chip.
4. **Illegal or unimplemented-page access behaviour** differs between MMCV2 and MMCV3 maskset chapters in [S1]. Which maskset the lab boards use (PARTIDL) is unknown.
5. **The PLL lock time** and the exact PLLSEL-gating rule are from memory. A wrong model could make start-up code hang (LOCK never set) or behave unrealistically.
6. **Board-level parts are inferred from command bytes, not documentation.** The LS7366R encoder, the MCP4922-style DAC, the keypad encoder chip and its DA polarity all need confirming. The keypad ISR busy-waits on PJ7, so a wrong polarity hangs the simulator.
7. **EEPROM code is absent from the S19/GLO.** The loader must use the `.abs` ELF. hiwave's real FCS behaviour when the EEPROM is uninitialised (erased $FF) should be mirrored with a clear error.
8. **ATD conversion timing, ECT input-capture "enhanced" features, CAN, XGATE and the DBG comparators** are only stubbed. Students who explore beyond the lab libraries may hit gaps.
9. **Shared timer channels:** delay code that reprograms the timer and uses an output-compare channel will interfere with student code using the same channel, as on real hardware. The simulator should reproduce this, not "fix" it.