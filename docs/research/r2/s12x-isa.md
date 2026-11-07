# S12X CPU (HCS12X / S12XCPU) instruction-set deltas vs. classic CPU12: research for an exact assembler and cycle-accurate simulator

Nothing was created or modified. All analysis used read-only commands and web fetches.

## 0. Verified against the Lab3 golden files

- **Assembler options:** `Lab3.mcp` contains `-CPUHCS12X -L=%(TEXTPATH)\%n.lst -Li`. The assembler must therefore accept the S12X instruction set.
- **S12X-only instructions in `main.asm`:** only `decw` and `incw`, both in extended form. Everything else is base CPU12, including the classic page-2 moves (verified encodings):

| Form | Listing obj | Absolute (S19) | Meaning |
|---|---|---|---|
| `decw <var>` | `1873 xxxx` | `18 73 hh ll` | DECW ext |
| `incw <var>` | `1872 xxxx` | `18 72 hh ll` | INCW ext |
| `movw #0,<var>` | `1803 0000 xxxx` | | MOVW #imm,ext = `18 03 jj kk hh ll` (immediate first) |
| `movb #$01,<var>` | `180B 01xx(xx)` | | MOVB #imm,ext = `18 0B ii hh ll` |
| `movw <var>,<var>` | `1804 xxxx xxxx` | | MOVW ext,ext = `18 04 hh ll hh ll` |

The Lab3 lines, addresses and symbols behind these rows are in the private notes, s12studio-fixtures research/s12x-isa.md §0.

- **Listing format:** the `.lst` "Loc" column is relative to the section. MyCode is placed at 0x4000 (see the map), so absolute = 0x4000 + Loc.
- **Unresolved fixups:** bytes not yet relocated print as `xx`. Byte groups are split as `1873 xxxx` (4 hex digits per group).

## 1. Machine-readable sources (where to transcribe from)

| Source | URL | What to take | Caveats |
|---|---|---|---|
| GNU binutils opcode table | https://sourceware.org/git/?p=binutils-gdb.git;a=blob_plain;f=opcodes/m68hc11-opc.c;hb=HEAD | Lines 115–1713 hold `m68hc11_opcodes[]`. Filter rows whose CPU field contains `cpu9s12x` and has no `cpu6812` (S12X-only). Fields are `{name, format, size, opcode, min_cyc, max_cyc, ccr, cpu, ...}`. Aliases are at 1719–1738. | Line 5 says "min/max cycles not updated for S12X opcodes", so **do not use its cycle counts**. Line 817 is a bug: `gsts` ext is given as `0x6f`; it should be `0x7f`. At lines 1082–1179 the S12X MOVB/MOVW extended modes are **commented out** ("uncommenting here causes a problem"), and two bogus `0x0d` rows sit inside that block. S12X support was added by James Murray (header lines 1–4, ~2012, binutils 2.23). Pin to a release tag, not HEAD. |
| GNU gas | https://sourceware.org/git/?p=binutils-gdb.git;a=blob_plain;f=gas/config/tc-m68hc11.c;hb=HEAD | 2135–2215: S12X MOVB/MOVW operands may use IDX1/IDX2/[D,r]/[n,r] (forced 16-bit reloc when the symbol is unknown). 2328–2360 `build_reg_mode`: TFR/EXG/SEX postbyte; `SEX D,X/Y` ORs in `0x08`. 1549–1582: TRAP id range check. | The TRAP range `[0x30..0x39]∪[0x40..0xff]` is CPU12-only and **wrong for S12X**. gas has no CCRW/XH/etc. register names. |
| binutils disassembler | https://sourceware.org/git/?p=binutils-gdb.git;a=blob_plain;f=opcodes/m68hc11-dis.c;hb=HEAD | 36–44: TFR register tables (A,B,CCR,TMP3/TMP2,D,X,Y,SP). 454–466: S12X SEX `0x4D`/`0x4E`. 814–816: trap fallback. | Incomplete for the S12X TFR/EXG LS=8–F encodings. |
| **Ghidra SLEIGH (best for TFR/EXG)** | https://raw.githubusercontent.com/NationalSecurityAgency/ghidra/master/Ghidra/Processors/HCS12/data/languages/HCS_HC12.sinc | 21–30: registers incl. TMP1/2/3, CCRW, CCRH. 55: `PrefixHCS12X` (GPAGE use). 61–67: IPL = CCRH[2:0]. 188–218: register attach tables. 917–919: `setCCRW` X-bit rule. 3172–3500: EXG matrix. 4632/4669: PSHCW/PULCW. 5176–5240: SEX. 5675–5850: TFR matrix. Also see `HCS12X.slaspec`/`.pspec` in the same directory. | Ghidra's naming has suspected slips; see §4. |
| S12XCPU Reference Manual v01.01 (S12XCPUV1, 502 pp, mirror) | https://www.yumpu.com/en/document/view/10431751/s12xcpuv1-reference-manual-freescale-semiconductor | Per-instruction "Access Detail" (HCS12X column) for cycles. Page numbers in the viewer: ADDX 88, DECW 173, EXG 193–194, GLDAA 196, INCW 215, MOVB 269–275, MOVW 276–282, PSHCW 299, RTI 327, SWI 351, TFR 358–359, TRAP 361, Exceptions ch. 7 at 377–378, Appendix A (Table A-1 summary, Table A-5 TFR/EXG, opcode map) 425–460, cycle legend 429. | Text extraction is garbled. Some prose is copied from CPU12 (e.g. the TRAP range). |
| Official: CPU12/CPU12X Reference Manual Rev 1.04 (2017-05-01), covering CPU12XV0/V1/V2 | https://www.nxp.com/webapp/Download?colCode=CPU12/CPU12X (linked from https://www.nxp.com/products/S12XS) | Authoritative tables. Get the PDF and transcribe Appendix A (instruction summary, opcode map, TFR/EXG table, cycle legend). | Needs an NXP login. Direct `docs/en/reference-manual/S12XCPUV2.pdf` returns 404. |
| CPU12RM Rev 4 (base CPU12) | https://mil.ufl.edu/4744/docs/hc12/cpu12rm.rev4.pdf | Base page-1/page-2 map, indexed postbyte table, PC-offset rule for MOVB/MOVW, access-detail legend. | HCS12 column only. |

Device-level vector list: MC9S12XDP512 RM, Table 1-12 "Interrupt Vector Locations" (per an NXP forum answer, [community.nxp.com thread](https://community.nxp.com/t5/CodeWarrior-for-MCU/Problem-with-Interrupts-MC9S12XDP512/m-p/267386)). Easier: the stock CodeWarrior `mc9s12xdp512.inc`/`.h`, which the lab's `derivative.inc` includes but which is not in the repo.

## 2. What changes vs. CPU12 (overview)

1. **Page-1 opcode map is unchanged.** All new opcodes are page-2 (`$18 xx`).
2. **TFR/EXG postbyte:** S12X defines LS nibble values 8–F, adding CCRW, CCRH, XH/YH/SPH/TMP2H, `SEX D,X/Y` and others. TFR is still opcode `B7`.
3. **MOVB/MOVW:** the indexed operands accept **all** indexed modes (IDX1 9-bit, IDX2 16-bit, `[D,r]`, `[n,r]`). CPU12 allowed only 5-bit/auto-inc/accumulator offsets. The opcodes are unchanged.
4. **16-bit CCR (CCRW = CCRH:CCRL):**
   - IPL[2:0] is in CCRH bits 2..0; the rest of CCRH reads 0 (UNCERTAIN whether writable).
   - Interrupts stack **CCRW (2 bytes)**, so a frame is **10 bytes** (CPU12: 9).
   - RTI pulls CCRW, which restores the IPL.
5. **New behaviors:**
   - GPAGE global addressing (GLD*/GST*).
   - The DIRECT register forms the high byte of direct-mode addresses (UNCERTAIN in detail; reset value $00 means identical to CPU12 by default).
   - The vector base comes from IVBR (high byte, reset $FF, so $FFxx).
   - New SYS instruction and vector.
   - Spurious-interrupt vector.
   - BTAS atomic semaphore.
6. **Not deltas:** MAXA/MINA/EMAXD/EMIND/MAXM/MINM/EMAXM/EMINM (`18 18`–`18 1F`), EMACS, ETBL/TBL and LBcc already exist on CPU12.
   - Fuzzy MEM/REV/REVW/WAV: binutils marks them `cpu6812|cpu9s12x`. NXP says CPU12XV1 (S12XS) drops 5 fuzzy instructions. The XDP512 is likely CPU12XV0/"S12XCPUV1" with fuzzy present (UNCERTAIN).

## 3. New page-2 instructions (opcode = `18 xx`; from binutils, corrected)

Notation: IMM/DIR/EXT/IDX(`xb`)/IDX1(`xb ff`)/IDX2(`xb ee ff`)/[D,IDX](`xb`)/[IDX2](`xb ee ff`). The indexed forms share one opcode, and the postbyte selects the mode exactly as in CPU12.

| Mnemonic | IMM | DIR | EXT | IDX* | Op / CCR |
|---|---|---|---|---|---|
| ADDX / ADDY | 8B / CB | 9B / DB | BB / FB | AB / EB | X(Y) += M:M+1, NZVC |
| ADED / ADEX / ADEY | C3 / 89 / C9 | D3 / 99 / D9 | F3 / B9 / F9 | E3 / A9 / E9 | add with carry, NZVC (Z chaining UNCERTAIN) |
| SUBX / SUBY | 80 / C0 | 90 / D0 | B0 / F0 | A0 / E0 | NZVC |
| SBED / SBEX / SBEY | 83 / 82 / C2 | 93 / 92 / D2 | B3 / B2 / F2 | A3 / A2 / E2 | subtract with borrow |
| CPED / CPES / CPEX / CPEY | 8C / 8F / 8E / 8D | 9C / 9F / 9E / 9D | BC / BF / BE / BD | AC / AF / AE / AD | compare with borrow (Z = Zold AND result==0, UNCERTAIN) |
| ANDX / ANDY | 84 / C4 | 94 / D4 | B4 / F4 | A4 / E4 | NZ, V=0 |
| ORX / ORY | 8A / CA | 9A / DA | BA / FA | AA / EA | NZ, V=0 |
| EORX / EORY | 88 / C8 | 98 / D8 | B8 / F8 | A8 / E8 | NZ, V=0 |
| BITX / BITY | 85 / C5 | 95 / D5 | B5 / F5 | A5 / E5 | NZ, V=0 |
| GLDAA / GLDAB | – | 96 / D6 | B6 / F6 | A6 / E6 | load from G(M), NZ, V=0 |
| GLDD / GLDX / GLDY / GLDS | – | DC / DE / DD / DF | FC / FE / FD / FF | EC / EE / ED / EF | |
| GSTAA / GSTAB / GSTD | – | 5A / 5B / 5C | 7A / 7B / 7C | 6A / 6B / 6C | |
| GSTX / GSTY / GSTS | – | 5E / 5D / 5F | 7E / 7D / **7F** (binutils wrongly says 6F) | 6E / 6D / 6F | |

Memory word and register-direct operations:

| Mnemonic | EXT | IDX* | X-reg (INH) | Y-reg (INH) |
|---|---|---|---|---|
| NEGW / NEGX / NEGY | 70 | 60 | 40 | 50 |
| COMW (C=1, V=0) | 71 | 61 | 41 | 51 |
| INCW (NZV, C unchanged) | **72** ✔ | 62 | 42 | 52 |
| DECW (NZV, C unchanged; V iff $8000) | **73** ✔ | 63 | 43 | 53 |
| LSRW | 74 | 64 | 44 | 54 |
| ROLW | 75 | 65 | 45 | 55 |
| RORW | 76 | 66 | 46 | 56 |
| ASRW | 77 | 67 | 47 | 57 |
| ASLW = LSLW | 78 | 68 | 48 | 58 |
| CLRW (N0 Z1 V0 C0) | 79 | 69 | CLRX 87 | CLRY C7 |
| TSTW (NZ, V0 C0) | F7 | E7 | TSTX 97 | TSTY D7 |

Other new page-2 instructions:
- **BTAS** (bit test and set, atomic): `18 35 dd mm` (DIR), `18 36 hh ll mm` (EXT), `18 37 xb[off] mm` (IDX, IDX1, IDX2 only). The operand order is like BSET. CCR effect is UNCERTAIN; take it from the RM.
- **PULCW** `18 38`, **PSHCW** `18 39`. PSHC/PULC (`36`/`38`) stay 8-bit (CCRL only).
- **SYS** `18 A7`: vectors through IVBR:$12, stacks like SWI, sets I.

Trap set: **all undefined page-2 opcodes** trap through the vector at IVBR:$F8. Derived from binutils (fixed for GSTS 7F), the remaining page-2 holes are: `18 30–34, 49–4F, 59, 81, 86, 91, A1, B1, B7, C1, C6, CC–CF, D1, E1, F1`. This is UNCERTAIN; cross-check against the RM's page-2 opcode map. The yumpu TRAP page still prints the CPU12 ranges, and so does gas's `trap #n` check.

## 4. TFR/EXG postbyte (opcode `B7 eb`)

- bit 7: 0 = TFR/SEX, 1 = EXG.
- bits 6–4: source/MS nibble (0..7 = A, B, CCR, TMP3, D, X, Y, SP).
- bits 3–0: destination/LS nibble.
- LS 0–7 behave exactly as on CPU12:
  - 16→8 takes the low byte (D→A gives B; X→A gives XL).
  - 8→16 sign-extends (SEX).
- LS 8–F are S12X-only. Derived from Ghidra lines 5675–5850 and 3172–3500:

| LS (dest) | src 0 = A | 1 = B | 2 = CCR | 3 = TMP3 | 4 = D | 5 = X | 6 = Y | 7 = SP |
|---|---|---|---|---|---|---|---|---|
| 8 (→A) | A | B | **CCRH** | TMP3H | B? (expected A = D high, UNCERTAIN) | **XH** | **YH** | **SPH** |
| 9 (→B) | A | B | CCRL | TMP3L | B | XL | YL | SPL |
| A (→CCR) | **A→CCRH** | B→CCRL | CCRW→CCRW | TMP3→CCRW | **D→CCRW** (`$4A`) | X→CCRW | Y→CCRW | SP→CCRW |
| B (→TMP2) | A→TMP2H | B→TMP2L | CCRW→TMP2 | TMP3→TMP2 | D→TMP1 | X→TMP2 | Y→TMP2 | SP→TMP2 |
| C (→D) | SEX A? (UNCERTAIN) | SEX B? | **CCRW→D** (`$2C`) | TMP1→D | D | X | Y | SP |
| D (→X) | **A→XH** | B→XL | CCRW→X | TMP3→X | **SEX D,X** (`$4D`: X = D<0 ? $FFFF : 0) | X | Y | SP |
| E (→Y) | A→YH | B→YL | CCRW→Y | TMP3→Y | **SEX D,Y** (`$4E`) | X | Y | SP |
| F (→SP) | A→SPH | B→SPL | CCRW→SP | TMP3→SP | D | X | Y | SP |

- **EXG** uses MS 8–F, mirrored. Examples: `$A8` = EXG CCRH,A; `$AA` = EXG CCRW,CCRW; `$CA`/`$DA` = EXG with CCRW. CPU12 8↔16 EXG zero-extends (`$00:A ⇒ X`, `XL ⇒ A`).
- **X-bit rule** for any write of CCR/CCRW (TFR, EXG, TAP, PULC/PULCW, RTI): X can go 1→0 but never 0→1 (Ghidra lines 917–919; RM RTI page).
- **Cycles:** TFR/EXG/SEX are 1 cycle ("P") on CPU12; assumed the same on S12X (UNCERTAIN).
- **Assembler syntax:** register names CodeWarrior accepts (CCRW, CCRH, CCRL, XH, XL, YH, YL, SPH, SPL) are UNCERTAIN. Test them on real CW, or follow the RM syntax column.

## 5. MOVB/MOVW (S12X indexed extensions)

| Op | Form | Byte layout |
|---|---|---|
| MOVW | #imm → idx | `18 00 xb [ff / ee ff] jj kk` (destination postbyte before the immediate) |
| MOVW | ext → idx | `18 01 xb [off] hh ll` (RM p. 277: "dest xb precedes the source") |
| MOVW | idx → idx | `18 02 xb_src [off] xb_dst [off]` (offset placement UNCERTAIN; confirm in RM pp. 276–282) |
| MOVW | #imm → ext | `18 03 jj kk hh ll` ✔ |
| MOVW | ext → ext | `18 04 hh ll hh ll` ✔ |
| MOVW | idx → ext | `18 05 xb [off] hh ll` |
| MOVB | same pattern | `18 08 / 09 / 0A / 0B ✔ / 0C / 0D` |

- **Indexed operand range:** CPU12 only allows 5-bit constant offsets (−16..+15), auto-increment/decrement, or accumulator offsets (A/B/D,r) here. S12X allows the full indexed set (gas 2135–2215). With a forward or unknown symbol, gas forces the 16-bit form (`0xE2|rr<<3`).
- **PC-relative operands** in moves need offset adjustment (CPU12RM "PC offsets for move instructions"). The S12X rule for IDX1/IDX2 is UNCERTAIN; it is a risk item.
- **Cycles:** S12X access strings differ from HCS12 for moves (RM p. 277 has separate columns). Transcribe the HCS12X column.

## 6. Cycle counts (S12X "Access Detail"; each letter = 1 bus cycle; uppercase = 16-bit access)

Retrieved from the RM mirror:

| Instruction | IMM | DIR | EXT | IDX | IDX1 | IDX2 | [D,IDX] | [IDX2] |
|---|---|---|---|---|---|---|---|---|
| ADDX (all NZVC-family X/Y ops presumably the same) | OPO 3 | ORPf 4 | ORPO 4 | ORPf 4 | ORPO 4 | OfRPP 5 | OfIfRPf 7 | OfIPRPf 7 |
| DECW (INCW/NEGW/COMW/shifts/CLRW presumably similar) | – | – | **ORPWO 5** | ORPW 4 | ORPWO 5 | OfRPWP 6 | OfIfRPW 7 | OfIPRPW 7 |
| GLDAA (8-bit global loads) | – | OrPf 4 | OrPO 4 | OrPf 4 | OrPO 4 | OfrPP 5 | OfIfrPf 7 | OfIPrPf 7 |

Pattern: an S12X page-2 instruction ≈ "O" (prefix fetch) + the equivalent CPU12 page-1 access string, using 16-bit R/W.

Exceptions and returns:
- TRAP: `OVSPSSPSSP` = 10 cycles.
- SWI and hardware interrupt entry: likely `VSPSSPSSP` = 9 (UNCERTAIN; CPU12 has `VSPSSPSsP`).
- RTI: `UUUUUPPP` = 8; with an interrupt pending, likely `UUUUUVfPPP` = 10 (UNCERTAIN).
- SYS: likely the same as TRAP (binutils says 9; unreliable).

Inherent X/Y operations (`18 4x`/`18 5x`/CLRX/TSTX): likely "OO" = 2 (UNCERTAIN).

## 7. Exceptions, CCRW, IPL

**Stack frame, high to low address:**
- RTNH:L at SP+8
- Y at SP+6
- X at SP+4
- A at SP+3
- B at SP+2
- CCRL at SP+1
- CCRH at SP+0 (10 bytes total)

**RTI** pulls in the reverse order (CCRW, B:A, X, Y, PC). If another interrupt is pending, it re-vectors without fully unstacking.

**Interrupt entry:**
- Stack, then set I.
- **IPL ← priority of the serviced request** (1..7, from the INT module's INT_CFADDR/INT_CFDATA registers; default level 1).
- XIRQ also sets X.
- A maskable request is taken only if I = 0 and its level > IPL. This allows nesting after CLI.
- SWI/TRAP/SYS set I. Whether they change IPL is UNCERTAIN; assume unchanged.

**Reset:** CCRL = $D0 (S, X, I set); IPL = 0 (UNCERTAIN).

**Vectors:** base = IVBR:$00 (IVBR reset value $FF, so the table is at $FF00).

| Vector | Address |
|---|---|
| Reset | FFFE |
| Clock monitor | FFFC |
| COP | FFFA |
| TRAP | base+F8 |
| SWI / BDM | base+F6 |
| XIRQ | base+F4 |
| IRQ | base+F2 |
| Device sources | base+F0 down to $10 (Port J = $FFCE, matches the lab) |
| SYS | base+$12 (UNCERTAIN) |
| Spurious | base+$10 (UNCERTAIN) |

Evidence for the last two: the lab prm comments `OSVECTORS 0xFF10 TO 0xFFFF`. Verify against `mc9s12xdp512.inc`.

**Global addressing:** GLD*/GST* use address = GPAGE[6:0]:EA16 (23-bit); GPAGE is at $0010 (UNCERTAIN). Global map for the XDP512, consistent with the lab prm page ranges:

| Region | Global range |
|---|---|
| Registers | 0x000000–0x0007FF |
| RAM (32 KB) | 0x0F8000–0x0FFFFF |
| EEPROM (4 KB) | 0x13F000–0x13FFFF |
| Flash (512 KB) | 0x780000–0x7FFFFF |

## Key risks / open questions

1. **No official S12X RM PDF was obtainable** (NXP login wall; mirror text is garbled). Cycle strings for most new instructions, the exact meaning of TFR/EXG LS=8 with source D and LS=C with sources A/B, the BTAS CCR effect, the ADE*/SBE*/CPE* Z-chaining semantics, and the SYS/RTI/SWI cycles all need transcription from the CPU12/CPU12X RM Rev 1.04, Appendix A.
2. **binutils is reliable for opcodes only.** Its cycles are stale, GSTS ext is wrong (6F should be 7F), and its MOVB/MOVW S12X table rows are commented out. Ghidra may itself have slips.
3. **CPU version naming is confusing** (S12XCPUV1/V2 vs. CPU12XV0/V1/V2). Confirm which the XDP512 implements and whether fuzzy MEM/REV/REVW/WAV exist on it.
4. **MOVB/MOVW idx→idx** offset-byte ordering, the PC-relative adjustment rule, and the S12X cycle strings are unverified. No golden example exists in `main.lst`. Disassembling the `ME305LibV4.0.lib` ELF objects could provide more S12X samples.
5. **SYS ($FF12) and Spurious ($FF10) vectors, the GPAGE/DIRECT register addresses, and IPL behavior for SWI/TRAP** need checking against `mc9s12xdp512.inc` and the XDP512 RM Table 1-12.
6. **The CodeWarrior assembler's exact syntax** for the S12X register names in TFR/EXG and for `SEX D,X` is unknown. It should be validated against real CW output if any is available.
7. **The trap opcode set (§3) is derived, not transcribed.** Validate it against the RM page-2 opcode map before the simulator relies on it.