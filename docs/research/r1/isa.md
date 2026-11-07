# CPU12 / HCS12 (S12CPUV2) instruction set notes for the assembler and cycle-counting simulator

**Primary source used:** *CPU12 Reference Manual*, CPU12RM Rev. 4.0, 03/2006, Freescale. It covers both the M68HC12 and the HCS12, and every timing table has separate **HCS12** and **M68HC12** columns. I got the text from a university mirror (https://my.eng.utah.edu/~cs5780/doc/CPU12RM.pdf) using a small text extractor I wrote for this task. NXP's own URLs returned 404 to my fetcher. Page numbers below are the manual's printed page numbers.

**The Dragon12-Plus MC9S12DG256 has an HCS12 core (S12CPUV2). Always use the HCS12 cycle column.**

---

## 0. Sources and machine-readable tables

| Source | URL | What it gives you | Caveats |
|---|---|---|---|
| CPU12RM Rev 4.0 (authoritative) | https://my.eng.utah.edu/~cs5780/doc/CPU12RM.pdf (NXP path `nxp.com/docs/en/reference-manual/CPU12RM.pdf` returned 404 to the fetcher) | Ch.3 addressing (p.29–39); Ch.4 queue; Ch.6 per-instruction glossary with CCR formulas and HCS12/HC12 access-detail strings; Ch.7 exceptions (p.285–292); Ch.9 fuzzy (MEM/REV/REVW/WAV flow diagrams); Ch.10 memory expansion (CALL/RTC/PPAGE); App. A: Table A-1 instruction summary (14 sheets, p.351–364), A-2 opcode map with HCS12 cycles (p.365–366), A-3/A-4 indexed postbyte (p.367–368), A-5 TFR/EXG (p.369), A-6 loop primitive (p.370) | PDF table text pulls out with columns interleaved, so transcribe from the rendered PDF |
| S12CPUV2 Reference Manual (HCS12-only edition) | `https://www.nxp.com/docs/en/reference-manual/S12CPUV2.pdf` (pointed to by NXP community thread https://community.nxp.com/thread/477473). Mirror: https://www.eecs.yorku.ca/course_archive/2011-12/W/3215/labs%20documentation/S12CPUV2.pdf | Same content, HCS12 only | York copy is PDF-encrypted (RC4/40, R2), so text extraction needs decryption |
| CPU12 Reference Guide (pocket card) | https://my.eng.utah.edu/~cs5780/doc/CPU12RG.pdf | Compact opcode map, postbyte tables | That copy is the **2001 Motorola M68HC12** edition, so its cycles are HC12, not HCS12 |
| GNU binutils `opcodes/m68hc11-opc.c` (plus `include/opcode/m68hc11.h`) | https://gnu.googlesource.com/binutils-gdb/+/refs/heads/master/opcodes/m68hc11-opc.c (sourceware gitweb is bot-blocked; raw.githubusercontent bminor path returned 404) | Full opcode table: `{name, format flags, size, opcode, min_cyc, max_cyc, CCR set/clr/chg, arch}`. Page 2 is `OP_PAGE2` plus the opcode byte. CPU12 rows are tagged `cpu6812` | **Cycles are HC12 values, not HCS12.** For example `mul` = 3 there, but HCS12 MUL = 1 cycle. Its comment "after daa Z is undefined" is wrong: the manual says **V** is undefined |
| GDB simulator `sim/m68hc11/gencode.c` (plus `m68hc11_sim.c`, `interp.c`) | https://gnu.googlesource.com/binutils-gdb/+/refs/heads/master/sim/m68hc11/gencode.c | Working 68HC12 simulator: `m6812_page1_opcodes[]`, `m6812_page2_opcodes[]` with semantics patterns (`movtst8`, `dbcc8`, `call8`…), sizes, cycles, CCR masks | Same HC12-era cycle counts (`call` 8, `mul` 3). Useful as a semantics cross-check only |
| libasm (Tadashi Takaoka, Apache-2.0) | https://github.com/tgtakaoka/libasm/blob/main/src/table_mc68hc12.cpp ; tests https://github.com/tgtakaoka/libasm/blob/main/test/test_asm_mc68hc12.cpp and `test/gen_mc68hc12.cpp`; PR adding HCS12/S12X: https://github.com/tgtakaoka/libasm/pull/156 | Clean encoding tables split by prefix page (0x00, 0x18, 0x04 loop, 0x4B CALL, 0xB7 TFR/EXG). The **test file is a ready source of golden encode/decode vectors** | No cycles or semantics |
| Ghidra HCS12 SLEIGH | https://github.com/NationalSecurityAgency/ghidra/blob/master/Ghidra/Processors/HCS12/data/languages/HCS_HC12.sinc (also `HCS12.slaspec`, `HC12.slaspec`) | Bit-exact postbyte decode constructors and p-code semantics (flags, EXG zero/$FF fill, EDIV/FDIV flags, EMUL/EMULS) | DAA, ETBL and fuzzy ops are opaque `pcodeop`s. Has TODO comments about signed 5-bit offsets and some EXG cases |
| MAME | (none found) | No HC12/HCS12 core or disassembler turned up in my searches | — |

**Recommendation.** Use libasm or binutils for encodings and as cross-checks. Hand-transcribe the HCS12 access-detail strings from CPU12RM Table A-1 into your own table (opcode, mode, bytes, HCS12 access string). The cycle count is the number of letters, ignoring `(`, `)` and `,`. Check against libasm's tests and, if possible, against CodeWarrior's simulator cycle counter.

---

## 1. Programming model

- **A, B**: 8-bit. **D = A:B** (A is the high byte).
- **X, Y**: 16-bit index registers. **SP**: 16-bit. **PC**: 16-bit.
- **CCR** = `S X H I N Z V C`, bit 7 down to bit 0:
  - **S** (bit 7): STOP disable. When 1, STOP acts as a 2-cycle NOP. Reset sets it to 1.
  - **X** (bit 6): XIRQ mask. Set by reset. **Software can clear X but never set it.** That covers ANDCC/ORCC, TFR/EXG to CCR, PULC and RTI. Only reset or XIRQ recognition sets X.
  - **H** (bit 5): half carry. Set only by ABA, ADDA/B and ADCA/B. Consumed by DAA.
  - **I** (bit 4): I-interrupt mask. Set by reset, SWI, TRAP and any interrupt.
  - **N** (bit 3), **Z** (bit 2), **V** (bit 1), **C** (bit 0).
- **Reset:** sets S, X and I (CPU12RM §7.8.2). Other CCR bits and the A/B/X/Y/SP values are **not defined** by the manual. See open questions.
- **Stack:** "last-used" convention, so SP points at the last pushed byte. A push pre-decrements then writes; a pull reads then post-increments. 16-bit values are big-endian (high byte at the lower address).
  - `STAA 1,-SP` ≡ PSHA.
  - `LDX 2,SP+` ≡ PULX.
- **Addresses:** 16-bit and wrap modulo 64K (UNCERTAIN, see open questions). Direct page is $0000–$00FF.
- **Paged program window:** $8000–$BFFF, selected by the PPAGE register (`$0030` on the S12 MMC; device topic). CALL/RTC push and pop PPAGE.

---

## 2. Addressing modes and encodings

### 2.1 Mode summary (CPU12RM Table 3-1)

| Mode | Syntax | Notes |
|---|---|---|
| INH | `INST` | |
| IMM | `#opr8i` / `#opr16i` | Operand size comes from the instruction. `LDY #$67` emits `$0067` |
| DIR | `opr8a` | High byte is assumed $00 |
| EXT | `opr16a` | |
| REL | `rel8` / `rel9` (loop) / `rel16` (LBcc) | Offset is relative to the address after the last byte of the instruction |
| IDX | `n,r` (5-bit), `n,-r` / `n,+r` / `n,r-` / `n,r+`, `A,r` / `B,r` / `D,r` | Postbyte only, 0 extension bytes |
| IDX1 | `n,r` (9-bit) | Postbyte plus 1 extension byte |
| IDX2 | `n,r` (16-bit) | Postbyte plus 2 extension bytes |
| [IDX2] | `[n16,r]` | Indirect: reads a 16-bit pointer at r+n16 |
| [D,IDX] | `[D,r]` | Indirect: reads a 16-bit pointer at r+D |

### 2.2 Indexed postbyte `xb` (CPU12RM Table 3-2 / A-3 / A-4)

Register codes are `rr`: 00=X, 01=Y, 10=SP, 11=PC.

| Pattern | Meaning | Hex ranges (X / Y / SP / PC) | Extension bytes |
|---|---|---|---|
| `rr0nnnnn` | 5-bit signed constant offset, −16..+15 | $00–1F / $40–5F / $80–9F / $C0–DF | none |
| `rr1pnnnn` | Auto pre/post inc/dec. p=0 pre, p=1 post. `nnnn`: +1..+8 = 0000..0111 (value−1); −1..−8 = 1111..1000 (4-bit two's complement). **X, Y, SP only (no PC)** | $20–3F / $60–7F / $A0–BF / — | none |
| `111rr0zs`, z=0 | 9-bit signed offset −256..+255. s = sign (bit 8); the low 8 bits are in byte `ff` | E0/E1, E8/E9, F0/F1, F8/F9 | ff |
| `111rr010` | 16-bit offset (signed or unsigned does not matter; wraps) | E2 / EA / F2 / FA | ee ff |
| `111rr011` | `[n16,r]` 16-bit offset indexed-indirect | E3 / EB / F3 / FB | ee ff |
| `111rr100` | `A,r` (A zero-extended, unsigned) | E4 / EC / F4 / FC | none |
| `111rr101` | `B,r` (unsigned) | E5 / ED / F5 / FD | none |
| `111rr110` | `D,r` (16-bit) | E6 / EE / F6 / FE | none |
| `111rr111` | `[D,r]` accumulator-D indirect | E7 / EF / F7 / FF | none |

Note that in the `111…` forms, `rr` sits in bits 4:3, not 7:6.

Worked encodings:

| Source | Postbyte |
|---|---|
| `1,-SP` | $AF |
| `2,-SP` | $AE |
| `1,SP+` | $B0 |
| `2,SP+` | $B1 |
| `1,X+` | $30 |
| `1,+X` | $20 |
| `1,X-` | $3F |
| `8,X+` | $37 |
| `-8,X+` | $38 |
| `$FF,X` | E0 FF |
| `-20,Y` | E9 EC |
| `0,X` / `,X` | $00 |

**Semantics**
- **Pre-modify:** the register is changed, then used as the effective address (EA).
- **Post-modify:** the old value is the EA, then the register is changed. The register keeps the change.
- **PC-relative** (any `n,PC`, `[n,PC]`, `A/B/D,PC`): the base is the address of the next instruction, after all extension bytes. The assembler therefore needs the instruction size before it picks 5/9/16-bit, so iterate to a fixed point.
- **LEAS/LEAX/LEAY with auto-modify** (§3.9.5 and the LEAS glossary): the loaded value is what would have gone onto the address bus. Pre-modification shows in the result; post-modification does not. Example: `LEAS 4,Y+` gives SP = old Y, and Y is incremented by 4. Both registers change.
- Computing the EA costs no extra cycles (§3.3). The cycle differences come from the extension-byte fetches and indirect reads (see §5).

**Assembler size choice:** use the smallest form that fits, so 5-bit (IDX), then 9-bit (IDX1), then 16-bit (IDX2). For forward references, CodeWarrior's assembler policy is UNCERTAIN (see the assembler-manual topic).

### 2.3 Which modes each class allows

- **Read-modify-write (RMW) and CLR/TST** (NEG COM INC DEC LSR ROL ROR ASR ASL/LSL CLR TST): **IDX and EXT only. There is no direct mode.** The assembler must promote a page-0 address to EXT, so `INC $20` assembles to `72 00 20`.
- **JMP:** EXT and indexed only, no DIR.
- **JSR:** DIR, EXT and indexed.
- **BSET/BCLR/BRSET/BRCLR:** DIR, EXT, IDX, IDX1, IDX2. **No indirect.**
- **MOVB/MOVW:**
  - Source can be IMM, EXT or "IDX" (one-byte postbyte only: 5-bit, auto inc/dec, or accumulator offset). Destination can be EXT or IDX.
  - **No 9/16-bit offsets and no indirect** (glossary p.212–213).
- **TBL/ETBL:** IDX only (no IDX1/IDX2/indirect).
- **LEAx:** IDX/IDX1/IDX2, no indirect.
- **CALL:** all indexed modes. Indirect forms carry no page byte (see §4.8).

### 2.4 PC-relative MOVB/MOVW (§3.10.1, Table 3-3)

On the original M68HC12, PC-relative MOVB/MOVW needed an offset correction: Freescale's MCUasm emits `18 09 C0 20 00` instead of `…C2…`. **On the HCS12 they work as written, with no correction.** The assembler should not apply the HC12 correction for an HCS12 target. Whether CodeWarrior HCS12 applies it is UNCERTAIN; it is rarely used.

### 2.5 Relative branches

| Branch | Encoding | Offset base / range |
|---|---|---|
| Short Bcc | `op rr` (2 bytes) | Offset from PC+2, range −128..+127 |
| Long LBcc | `18 op qq rr` (4 bytes) | Offset from PC+4, 16-bit. `LBRA` with `$FFFC` is a self-loop |
| BRSET/BRCLR | | rel8 measured from the end of the whole 4–6-byte instruction |
| BRN | | 2-byte NOP |
| LBRN | | 4-byte NOP |

An offset of 0 always continues to the next instruction.

### 2.6 Loop primitives `04 lb rr` (Table A-6; DBEQ/IBEQ glossary p.138, 160)

- **bits 7:5** = operation: 000 DBEQ, 001 DBNE, 010 TBEQ, 011 TBNE, 100 IBEQ, 101 IBNE. 110 and 111 are unused (UNCERTAIN what hardware does).
- **bit 4** = sign bit (bit 8) of the 9-bit offset; `rr` holds the low 8 bits.
  - The IBEQ glossary text wrongly says "bit 0". The tables show bit 4, e.g. `04 80 rr` vs `04 90 rr`.
- **bit 3**: don't care.
- **bits 2:0** = counter register: 000 A, 001 B, 100 D, 101 X, 110 Y, 111 SP. 010 and 011 are unused.
- Range −256..+255 from PC+3. **No CCR change.** The counter wraps silently (A=$00, DBNE gives $FF).
- Examples: `DBNE X,*` (self-loop) = `04 35 FD`. `DBEQ A,+5` = `04 00 05`.

### 2.7 TFR/EXG/SEX `B7 eb` (Table A-5; p.157–158, 271, 273)

**Postbyte layout**
- **bit 7**: 0 = TFR, 1 = EXG.
- **bits 6:4**: source (r1). **bit 3**: don't care. **bits 2:0**: destination (r2).
- Register codes: 0 A, 1 B, 2 CCR, 3 TMP3 (as source) / TMP2 (as destination) — reserved, factory use; 4 D, 5 X, 6 Y, 7 SP.

**TFR rules**
- 8→8 and 16→16: plain copy.
- 16→8: copies the low byte (TFR D,A puts B into A).
- **8→16: sign-extends.** This is exactly SEX: `SEX A,D` = `B7 04`, `SEX B,X` = `B7 15`.

**EXG rules (asymmetric)**
- 8-bit register written first (e.g. `EXG A,X` = 85, `EXG B,Y` = 96): `r2 ← $00:r1`, `r1 ← r2_low` (zero fill).
- 16-bit first and 8-bit second:
  - `EXG X,A` (D0): `A ← X_L`, `X ← $00:A`.
  - **`EXG X,B` (D1): `B ← X_L`, `X ← $FF:B`. B as the second operand fills with $FF.**
  - CCR as the second operand (e.g. `EXG X,CCR`): `X ← $FF:CCR`.
  - Ghidra models the B case as `0xFF00 | zext(B)`.
- EXG between D and A/B is called "ambiguous" by the manual. Avoid relying on it and verify against the CodeWarrior simulator.

**CCR as destination:** all bits copy except X, which cannot go 0→1.

**HC11-compatible aliases the assembler must accept**

| Alias | Encoding |
|---|---|
| TAP = TFR A,CCR | B7 02 |
| TPA = TFR CCR,A | B7 20 |
| TSX = TFR SP,X | B7 75 |
| TSY | B7 76 |
| TXS = TFR X,SP | B7 57 |
| TYS | B7 67 |
| XGDX = EXG D,X | B7 C5 |
| XGDY | B7 C6 |
| CLC | 10 FE |
| CLI | 10 EF |
| CLV | 10 FD |
| SEC | 14 01 |
| SEI | 14 10 |
| SEV | 14 02 |
| INS = LEAS 1,SP | 1B 81 |
| DES = LEAS -1,SP | 1B 9F |
| ABX = LEAX B,X | 1A E5 |
| ABY = LEAY B,Y | 19 ED |

Also: LSLx = ASLx, BHS = BCC, BLO = BCS, LBHS/LBLO likewise.

---

## 3. Opcode maps with HCS12 cycles

Cycles are taken from Table A-2 ("Number of HCS12 cycles; ‡ indicates HC12 different") and cross-checked against the glossary HCS12 columns. "x–y" ranges cover the IDX…indirect variants (details in §5).

### 3.1 Page 1

| lo \ hi | 0x | 1x | 2x | 3x |
|---|---|---|---|---|
| 0 | BGND 5 | ANDCC # 1 | BRA 3 | PULX 3 |
| 1 | MEM 5 | EDIV 11 | BRN 1 | PULY 3 |
| 2 | INY 1 | **MUL 1** (HC12: 3) | BHI 3/1 | PULA 3 |
| 3 | DEY 1 | EMUL 3 | BLS 3/1 | PULB 3 |
| 4 | *loop* (DBEQ… `04 lb rr`) 3 | ORCC # 1 | BCC/BHS 3/1 | PSHX 2 |
| 5 | JMP idx 3–6 | JSR idx 4–7 | BCS/BLO 3/1 | PSHY 2 |
| 6 | JMP ext 3 | JSR ext 4 | BNE 3/1 | PSHA 2 |
| 7 | BSR 4 | JSR dir 4 | BEQ 3/1 | PSHB 2 |
| 8 | INX 1 | *page 2 prefix* | BVC 3/1 | PULC 3 |
| 9 | DEX 1 | LEAY 2 | BVS 3/1 | PSHC 2 |
| A | RTC 7 (HC12 6) | LEAX 2 | BPL 3/1 | PULD 3 |
| B | RTI 8 (11 if another interrupt is pending) | LEAS 2 | BMI 3/1 | PSHD 2 |
| C | BSET idx 4–6 | BSET ext 4 | BGE 3/1 | *wavr* (WAV resume) |
| D | BCLR idx 4–6 | BCLR ext 4 | BLT 3/1 | RTS 5 |
| E | BRSET idx 4–6 | BRSET ext 5 | BGT 3/1 | WAI 7 (+6 on wake) |
| F | BRCLR idx 4–6 | BRCLR ext 5 | BLE 3/1 | SWI 9 |

- **Row 4x:** NEGA COMA INCA DECA LSRA ROLA RORA ASRA ASLA (40–48) = 1. LSRD (49) = 1. CALL ext (4A) = 7. CALL idx (4B) = 7–10. BSET/BCLR/BRSET/BRCLR dir (4C–4F) = 4.
- **Row 5x:** NEGB…ASLB (50–58) = 1. ASLD (59) = 1. STAA STAB STD STY STX STS dir (5A–5F) = 2.
- **Row 6x (idx):** NEG COM INC DEC LSR ROL ROR ASR ASL (60–68) = 3–6. CLR (69), STAA, STAB, STD, STY, STX, STS (6A–6F) = 2–4.
- **Row 7x (ext):** the same mnemonics. 70–78 = 4, 79–7F = 3.
- **Rows 8x / 9x / Ax / Bx** (A-side ALU for IMM / DIR / IDX / EXT): SUBA CMPA SBCA SUBD ANDA BITA LDAA [col 7] EORA ADCA ORAA ADDA CPD CPY CPX CPS.
  - Column 7 holds CLRA (87) 1, TSTA (97) 1, NOP (A7) 1, TFR/EXG (B7) 1.
  - Cycles: IMM 1, or 2 for 16-bit ops (SUBD, CPD, CPY, CPX, CPS). DIR 3. IDX 3–6. EXT 3.
- **Rows Cx / Dx / Ex / Fx** (B side): SUBB CMPB SBCB ADDD ANDB BITB LDAB [col 7] EORB ADCB ORAB ADDB LDD LDY LDX LDS.
  - Column 7 holds CLRB (C7) 1, TSTB (D7) 1, TST idx (E7) 3–6, TST ext (F7) 3.
  - Cycles as for the A side; ADDD and LDD/LDY/LDX/LDS immediate are 2.
- There is no STAA immediate. All 256 page-1 positions are defined.

### 3.2 Page 2 (`$18 xx`). Cycles include the prebyte's "O" cycle

| | |
|---|---|
| 00–05 MOVW | IMM→IDX 4, EXT→IDX 5, IDX→IDX 5, IMM→EXT 5, EXT→EXT 6, IDX→EXT 5 |
| 06 ABA 2, 07 DAA 3 | |
| 08–0D MOVB | IMM→IDX 4, EXT→IDX 5, IDX→IDX 5, IMM→EXT 4, EXT→EXT 6, IDX→EXT 5 |
| 0E TAB 2, 0F TBA 2 | |
| 10 IDIV 12, 11 FDIV 12, 12 EMACS (ext) 13, 13 EMULS 3, 14 EDIVS 12, 15 IDIVS 12, 16 SBA 2, 17 CBA 2 | |
| 18 MAXA, 19 MINA, 1A EMAXD, 1B EMIND, 1C MAXM, 1D MINM, 1E EMAXM, 1F EMINM | all idx, 4–7 |
| 20–2F LBRA 4, LBRN 3, LBHI…LBLE 4/3 (taken/not taken) | |
| 30–39 TRAP 10 | |
| 3A REV (3 per element), 3B REVW (3 per element, 5 for separators with weights), 3C WAV (7 per B iteration), 3D TBL 6 (HC12 8), 3E STOP 8 to enter (2 if S=1), 3F ETBL 10 | |
| 40–FF TRAP 10 | |

- Exactly **54 opcodes are implemented on page 2**. The other 202 positions trap through vector $FFF8 (§7.6).
- TRAP is 10 cycles on HCS12 (`OVSPSSPSsP`) and 11 on HC12.

### 3.3 Operand byte layouts to watch (glossary p.212–213)

**The indexed postbyte comes before the immediate or extended operand.**

| Instruction | Encoding |
|---|---|
| `MOVB #ii,xb` | `18 08 xb ii` |
| `MOVB ext,xb` | `18 09 xb hh ll` |
| `MOVB xb,xb` | `18 0A xb_src xb_dst` |
| `MOVB #ii,ext` | `18 0B ii hh ll` |
| `MOVB ext,ext` | `18 0C hh ll hh ll` |
| `MOVB xb,ext` | `18 0D xb hh ll` |
| `MOVW` | Same pattern with `jj kk` immediates (`18 00 xb jj kk`, …, `18 03 jj kk hh ll`) |
| `BSET/BCLR` | `4C dd mm`, `1C hh ll mm`, `0C xb [ff/ee ff] mm` |
| `BRSET/BRCLR` | `4E dd mm rr`, `1E hh ll mm rr`, `0E xb [ext] mm rr` (mask, then offset) |
| `CALL` (non-indirect) | `4A hh ll pg`, `4B xb pg`, `4B xb ff pg`, `4B xb ee ff pg` |
| `CALL` (indirect) | `4B xb` ([D,r]) and `4B xb ee ff` ([n16,r]), with no pg byte |
| `TRAP` | `18 tn`, where tn is in $30–$39 or $40–$FF |

---

## 4. Instruction semantics and CCR rules

Notation: R = result; A/M = operands; bits are from the MSB unless stated.

### 4.1 Flag formulas

**8-bit add** (ABA, ADDA/B, ADCA/B)
- **H** = A3·M3 + M3·¬R3 + ¬R3·A3
- **V** = A7·M7·¬R7 + ¬A7·¬M7·R7
- **C** = A7·M7 + M7·¬R7 + ¬R7·A7
- N and Z from the result.
- **Only these instructions set H.**

**8-bit subtract / compare** (SUB, SBC, CMP, SBA, CBA, NEG as 0−M)
- **V** = A7·¬M7·¬R7 + ¬A7·M7·R7
- **C** = ¬A7·M7 + M7·R7 + R7·¬A7 (unsigned borrow)

**16-bit add/sub** (ADDD, SUBD, CPD/CPX/CPY/CPS, EMAXD…): the same formulas on bit 15. No H.
- CPD's glossary text says C is set "if the absolute value of memory is larger". **Implement the borrow formula**, which is what the manual's equation shows.

**Loads, stores, logic**
- LDAA/B, LDD/X/Y/S, **STAA/B and STD/X/Y/S (stores also set flags)**, ANDA/B, ORAA/B, EORA/B, BITA/B: N, Z; V=0; C unchanged.
- **TST, TSTA/B:** N, Z; V=0; C=0.
- **CLR, CLRA/B:** N=0, Z=1, V=0, C=0.
- **COM:** N, Z; V=0; C=1.
- **NEG:** N, Z; V=(R==$80); C=(R≠0). $80 stays $80.
- **INC/DEC:** N, Z. V = (R==$80) for INC, (R==$7F) for DEC. C unchanged.

**Shifts and rotates** (ASL/LSL, ASR, LSR, ROL, ROR, ASLD, LSRD)
- C = bit shifted out; V = N⊕C (computed after the operation); N, Z from the result.
- LSR always gives N=0.

**Index increments, LEA, transfers**
- **INX/DEX/INY/DEY:** Z only.
- **No CCR change:** INS/DES (LEAS), **LEAS/LEAX/LEAY**, ABX/ABY, TFR/EXG/SEX (unless the destination is CCR), MOVB/MOVW, loop primitives, BRSET/BRCLR, pushes and pulls other than PULC.

**Other groups**
- **TAB/TBA:** N, Z; V=0.
- **BSET/BCLR:** N, Z from the resulting byte; V=0.
- **MINA/MAXA/MINM/MAXM and EMIND/EMAXD/EMINM/EMAXM:** N Z V C from the internal subtraction A−M (or D−M:M+1), whichever value is kept.
  - C=1 means memory > accumulator (unsigned).
  - MAX keeps memory when C=1; MIN keeps memory when C=0 (p.149–152).
- **ANDCC/ORCC, TFR/EXG to CCR, PULC, RTI:** write the CCR, subject to the X rule.
  - ANDCC/CLI clearing I takes effect one cycle late. The instruction after CLI always executes, which makes `CLI; WAI` and `CLI; SEI` atomic (p.86, 123).

### 4.2 Multiply and divide

| Instruction | Operation | Flags | Notes |
|---|---|---|---|
| MUL | A×B → D | C = R7 (bit 7 of B, for rounding) | 1 cycle on HCS12 |
| EMUL / EMULS | D×Y → Y:D (unsigned / signed) | N, Z (32-bit), C = bit 15 of result | |
| EDIV | Y:D ÷ X → quotient Y, remainder D (unsigned) | V = quotient > $FFFF; C = (X==0) | ÷0: Y and D unchanged, C=1, N/Z/V undefined. Overflow: N/Z undefined (register results UNCERTAIN) |
| EDIVS | Signed version of EDIV | V on quotient outside $8000..$7FFF | Same ÷0 rule |
| IDIV | D ÷ X → quotient X, remainder D (unsigned) | Z (quotient), V=0, C=(X==0) | ÷0: X=$FFFF, D indeterminate |
| IDIVS | Signed version of IDIV | N Z V C | ÷0: D and X unchanged, C=1, N/Z/V undefined. Only overflow: $8000 ÷ $FFFF |
| FDIV | (D·2¹⁶) ÷ X → quotient X, remainder D | Z, V = (X ≤ D), C = (X==0) | Overflow or ÷0: X=$FFFF, remainder indeterminate |

**EMACS opr16a:** (X)(16-bit) × (Y)(16-bit), signed, added to the 32-bit value at opr16a, result written back. X and Y are unchanged. N, Z (32-bit); V = signed overflow of the 32-bit add; C = carry from bit 15 of the add. 13 cycles.

### 4.3 TBL / ETBL (p.157, 270)

- TBL: `A = Y1 + B×(Y2−Y1)` with 8-bit table entries.
- ETBL: `D = Y1 + B×(Y2−Y1)` with 16-bit entries.
- B is a binary fraction (0.B).
- The intermediate product is 16-bit (24-bit for ETBL) with the radix point between bits 7 and 8, and the result is unrounded.
- Flags: N, Z; **C = "result can be rounded up"** (the fractional MSB; exact bit is UNCERTAIN, see open questions). C was undefined on the original HC12. V unchanged.
- Signed handling of a negative slope Y2<Y1 is UNCERTAIN; test it.

### 4.4 DAA (p.137)

- Uses A, C and H from a preceding ABA, ADD or ADC. Applies the standard correction table (adds $06/$60/$66) and sets C as the BCD carry.
- N and Z are set from the result. **V is undefined.**

### 4.5 MEM (p.209; Fig 9-5 p.318)

**Setup:** A = crisp input; X → 4-byte trapezoid {point1, point2, slope1, slope2}; Y → output byte.

**Algorithm**
1. Delta1 = A − P1; Delta2 = P2 − A.
2. If either delta is negative, grade = 0.
3. Otherwise compute G1 = S1·Δ1 and G2 = S2·Δ2. A slope of $00 means infinite slope, giving grade $FF on that side.
4. grade = $FF if (S2==0 or G2>$FF), else G2. That is then overridden by G1 unless (S1==0 or G1>$FF).

**Afterwards:** store grade at (Y), Y += 1, X += 4. A is unchanged.

**Flags:** H, N, Z, V and C are undefined. 5 cycles (RRfOw).

### 4.6 REV / REVW (p.234–237)

**Setup**
- X → rule list. Y = base address of the fuzzy I/O.
- A = $FF and V = 0 (`LDAA #$FF` does both).
- Outputs cleared to 0.

**REV list format:** 8-bit offsets from Y. $FE separates antecedents from consequents and rules from each other; $FF ends the list.
- Antecedent phase: MIN into A.
- Consequent phase: MAX into the output.
- V flips at each $FE (0 = antecedents, 1 = consequents). A is reset to $FF at each rule boundary.

**REVW:** same structure with 16-bit pointers, $FFFE separators and $FFFF end. If C=1, rules are weighted: Y → 8-bit weights, and `A = (A × (w+1)) >> 8`.

**End state:** X points past the end marker. V should be 1.

**Interrupts:** both are interruptible. On an interrupt, the PC is moved back to the REV opcode and X backs up one element, so execution resumes after RTI.

**Flags:** V normally 1; H, N, Z and C may change. For REVW, C is an input (enables weighting).

### 4.7 WAV / wavr (p.282; §9.6)

**Loop (B times):** SOP(24-bit) += (X)·(Y); SOW(16-bit) += (Y); X++; Y++.
**Result:** Y:D = SOP, X = SOW (follow with EDIV for the weighted average).
**Flags:** Z = 1; H, N, V and C may change.

**Interrupt handling (re-entrant)**
- The CPU stacks 6 extra bytes before the normal frame: SOW[15:0], SOP[15:0], $00:SOP[23:16], in that order.
- It sets the stacked PC to the **second byte of the WAV instruction ($3C)**.
- After RTI, the page-1 opcode $3C runs as **wavr**. It pulls the temporaries and re-enters the loop.
- The disassembler should show $3C as `wavr`. Running it without a WAV frame on the stack misbehaves by design.

**Cycles:** HCS12 7 per iteration (`Of(frr,ffff)O`); HC12 8.

### 4.8 CALL / RTC (p.120, 244; Ch.10)

**CALL**
1. SP −= 2; push the return address (address of the next instruction).
2. SP −= 1; push PPAGE.
3. PPAGE ← pg; PC ← target.

The frame is 3 bytes: (SP) = old PPAGE, (SP+1:SP+2) = return address.

Indirect forms read 3 bytes from the pointer location: target high, target low, then the new PPAGE.

**RTC:** pull PPAGE, then pull PC.

**Cycles (HCS12)**

| Instruction / mode | Cycles | Access detail |
|---|---|---|
| CALL EXT | 7 | gnSsPPP |
| CALL IDX | 7 | gnSsPPP |
| CALL IDX1 | 7 | gnSsPPP |
| CALL IDX2 | 8 | fgnSsPPP |
| CALL [D,IDX] | 10 | fIignSsPPP |
| CALL [IDX2] | 10 | fIignSsPPP |
| RTC | 7 | uUnfPPP |

HC12 is about one cycle longer for CALL and one shorter for RTC (6).

CALL and RTC also work on devices without paging.

---

## 5. Cycle counting

**Access-detail letters (Table A-1 legend, p.350).** Each letter is one bus cycle; `(`, `)` and `,` are not counted.

| Letter | Meaning |
|---|---|
| f | Free cycle |
| g / n | Read / write PPAGE internally |
| I | Read indirect pointer |
| i | Read indirect PPAGE (CALL indirect) |
| O | Optional program fetch |
| P | Program word fetch |
| r / R | 8-bit / 16-bit data read |
| s / S | 8-bit / 16-bit stack write |
| w / W | 8-bit / 16-bit data write |
| u / U | 8-bit / 16-bit stack read |
| V | Vector fetch |
| t / T / x | Conditional read or write, otherwise free |
| ( ) | Microcode loop |
| , | Point where an interrupt can be taken |

- **"O" always costs one cycle.** Alignment only changes whether it is a program fetch or a free cycle, so **cycle counts do not depend on alignment** (§4.2). Only bus traffic does.
- The $18 prebyte counts as its own one-cycle "O".
- Taken / not taken: short branches PPP/P (3/1). Long branches OPPP/OPO (4/3). BRSET/BRCLR and loop primitives take the same count either way, because they always prefetch.

**HCS12 per-mode patterns** (from the glossary HCS12 columns)

| Class | IMM | DIR | EXT | IDX | IDX1 | IDX2 | [D,IDX] | [IDX2] |
|---|---|---|---|---|---|---|---|---|
| 8-bit read/ALU (LDAA, ADDA, CMPA, BITA, TST…) | 1 P | 3 rPf | 3 rPO | 3 rPf | 3 rPO | 4 frPP | 6 fIfrPf | 6 fIPrPf |
| 16-bit read (LDD/X/Y/S, ADDD, SUBD, CPD/X/Y/S) | 2 PO | 3 RPf | 3 RPO | 3 RPf | 3 RPO | 4 fRPP | 6 fIfRPf | 6 fIPRPf |
| Store 8/16 (STAA… STD…, CLR) | — | 2 Pw | 3 PwO | 2 Pw | 3 PwO | 3 PwP | 4 PIfw | 4 PIPw |
| RMW (NEG COM INC DEC shifts rotates) | — | — | 4 rPwO | 3 rPw | 4 rPwO | 5 frPwP | 6 fIfrPw | 6 fIPrPw |
| JMP | — | — | 3 PPP | 3 | 3 | 4 fPPP | 6 fIfPPP | 6 |
| JSR | — | 4 SPPP | 4 SPPP | 4 PPPS | 4 | 5 fPPPS | 7 fIfPPPS | 7 |
| LEAX/Y/S | — | — | — | 2 Pf | 2 PO | 2 PP | n/a | n/a |
| BSET/BCLR | — | 4 rPwO | 4 rPwP | 4 rPwO | 4 rPwP | 6 frPwPO | n/a | n/a |
| BRSET/BRCLR | — | 4 rPPP | 5 rfPPP | 4 rPPP | 5 rfPPP | 6 PrfPPP | n/a | n/a |
| EMAXD/EMIND (page 2) | — | — | — | 4 ORPf | 4 ORPO | 5 OfRPP | 7 OfIfRPf | 7 OfIPRPf |
| EMAXM/EMINM (page 2) | — | — | — | 4 ORPW | 5 ORPWO | 6 OfRPWP | 7 OfIfRPW | 7 OfIPRPW |

The "IDX" column covers every one-byte-postbyte form: 5-bit offset, auto inc/dec, and A/B/D offsets.

**Other fixed counts (HCS12)**

| Instruction | Cycles | Access detail |
|---|---|---|
| PSHA/B/C | 2 | Os |
| PSHD/X/Y | 2 | OS |
| PULA/B/C | 3 | ufO |
| PULD/X/Y | 3 | UfO |
| TFR/EXG/SEX | 1 | |
| ANDCC/ORCC | 1 | |
| BSR | 4 | |
| RTS | 5 | UfPPP |
| RTI | 8 | uUUUUPPP |
| RTI with another interrupt pending | 11 | uUUUUfVfPPP (HC12: 10) |
| SWI | 9 | VSPSSPSsP |
| Hardware interrupt entry | 9 | Same sequence as SWI |
| Reset | 5 | VfPPP |
| BGND | 5 | VfPPP |
| WAI | 7 + 6 after wake | OSSSSsf + fVfPPP |
| STOP | 8 to enter (OOSSSSsf), 6 to exit (fVfPPP); 2 if disabled (OO) | |
| MEM | 5 | |
| EDIV | 11 | ffffffffffO |

**HC12 vs HCS12 differences to remember:** MUL 3 vs 1, TRAP 11 vs 10, RTI-pending 10 vs 11, RTC 6 vs 7, CALL, TBL 8 vs 6, WAV loop 8 vs 7, the [D,IDX] store forms, and others. **The binutils and GDB tables use HC12 counts.**

---

## 6. Exceptions, interrupts and reset (Ch.7, p.285–292)

**Vectors**

| Address | Source |
|---|---|
| $FFFE | Reset (POR / external pin) |
| $FFFC | Clock monitor |
| $FFFA | COP |
| $FFF8 | Unimplemented-opcode TRAP |
| $FFF6 | SWI |
| $FFF4 | XIRQ |
| $FFF2 | IRQ |
| $FF00–$FFF1 | Device-specific (HCS12) |

- Fixed priority: RESET/POR > clock monitor > COP > XIRQ > TRAP > SWI.
- Maskable sources: higher vector address means higher priority. The device's HPRIO register can promote one source (device topic).
- TRAP and SWI cannot be interrupted once they start, but any interrupt already pending wins over them.

**Stacking order** (Table 7-2): SP −= 9.

| Address | Contents |
|---|---|
| SP | CCR |
| SP+1 | **B** |
| SP+2 | **A** (B is at the lower address, not D's A:B order) |
| SP+3, +4 | X high, X low |
| SP+5, +6 | Y high, Y low |
| SP+7, +8 | Return address high, low |

- The microcode push order is RTN, then Y, then X, then B:A, then CCR (Fig 7-1).
- After stacking: I = 1. X = 1 too if the source was XIRQ. SWI and TRAP set only I.

**Return addresses**
- SWI and TRAP: the next address after the instruction. TRAP's is after the 2-byte `18 xx`, unlike the HC11.
- Hardware interrupts: the instruction that would have executed next.
- REV, REVW and WAV are the only instructions that can be interrupted mid-way (see §4.6–4.7). All others complete first.

**RTI**
- Pulls CCR, B:A, X, Y, PC. X cannot go 0→1.
- If an interrupt is pending after the pulls, it fetches the new vector and sets SP back by 9 instead of re-stacking (11 cycles).

**WAI**
- Stacks the full context immediately, then stops the CPU clock.
- An unmasked interrupt then fetches its vector without stacking again. I is set, plus X for XIRQ.

**STOP**
- With S=1 it is a 2-cycle NOP. Reset leaves S=1, so STOP does nothing until software clears S.
- With S=0 it stacks the context and stops all clocks. RESET, XIRQ or IRQ wake it.
- If XIRQ wakes it while X=1, execution continues with the next instruction (2-cycle recovery).

**Reset:** vector fetch, then set S, X and I, then three program fetches.

**BGND**
- Saves PC in TMP2 and enters BDM firmware.
- If BDM is disabled, the firmware returns at once, so BGND is effectively a NOP.

---

## 7. Other subtle behaviors

1. LEAS, LEAX and LEAY never touch the CCR. INS and DES (which are LEAS) don't either. INX, DEX, INY and DEY change only Z.
2. Store instructions set N and Z and clear V.
3. CLR/TST/COM/NEG and the shifts have no direct mode; direct addresses must be promoted to extended.
4. H is defined only after ABA, ADD and ADC. MEM, REV, REVW and WAV leave H undefined. DAA leaves V undefined.
5. EXG fills with $00 or $FF depending on operand order and whether B or CCR is involved. TFR from 8-bit to 16-bit sign-extends.
6. MOVB/MOVW put the indexed postbyte before the immediate or extended bytes. IDX→IDX encodes the source postbyte first.
7. The 9-bit offset sign sits in postbyte bit 0. The loop-primitive offset sign sits in `lb` bit 4.
8. PC-relative forms use the address after the whole instruction. On HCS12 there is no MOVB/MOVW correction.
9. The interrupt frame stores B below A.
10. Cycle counts do not depend on alignment. The indexed variant (IDX/IDX1/IDX2/indirect) and branch taken/not taken are what change the count.
11. CLI/ANDCC take effect after a one-instruction delay.
12. Opcodes `$18 $30–$39` and `$18 $40–$FF` trap. They are legal "TRAP n" instructions, and the disassembler should show them that way.
13. Page-1 $3C is wavr, not an illegal opcode.
14. EDIVS/IDIVS divide by zero leaves the registers unchanged. IDIV/FDIV divide by zero sets the quotient to $FFFF.

---

## Key risks / open questions

1. **Register contents after reset.** The manual defines only S, X and I. To match CodeWarrior's simulator or the board you need to measure. The CCR is probably $D0 and the other registers 0 or random — UNCERTAIN.
2. **Undefined flags** (DAA V; EDIV/EDIVS/IDIVS N/Z/V on overflow or ÷0; MEM, REV, REVW, WAV H/N/Z/V/C). Real silicon and CodeWarrior's simulator each produce *some* value. Matching them bit-for-bit needs test runs on the board or in hiwave.
3. **EXG between D and A/B, and the TMP2/TMP3 encodings** (eb with source or destination 3). The manual calls these ambiguous or reserved. Also unknown: what hardware does with loop-primitive `lb` operation codes 110/111 and register codes 010/011.
4. **TBL/ETBL arithmetic details:** signed handling when Y2<Y1, and exactly which bit sets C ("can be rounded up"). Needs test vectors.
5. **Auto-increment with the same register as the load or store target** (e.g. `LDX 2,X+`, `STX 1,-X`). The manual defines this only for LEAx. Verify on hardware or in the simulator.
6. **Cycle-table transcription accuracy.** The PDF-extracted text of Table A-1 and A-2 is column-scrambled. The per-class patterns above are consistent with the glossary and opcode map, but the final table should be hand-checked against the rendered CPU12RM pages. Two values to double-check: RTC = 7 and TBL = 6 on HCS12. Do not use the binutils or GDB cycle columns; they are HC12 values.
7. **Misaligned 16-bit accesses and memory stretching** on MC9S12DG256 (RAM, flash, registers, external bus). The CPU12RM counts assume single-cycle accesses. Whether CodeWarrior's simulator or the S12 MMC adds cycles for misaligned words is UNCERTAIN.
8. **CodeWarrior assembler conventions** are left to the assembler-manual topic: PCR syntax, choice of offset size for forward references, whether it applies the HC12 MOVB/MOVW PC correction, and the accepted alias set.
9. **How hiwave/CodeWarrior's simulator handles BGND, STOP and WAI.** It might halt or idle; that decides what the clone should show.
10. **PDF access.** NXP's direct PDF URLs returned 404 to the fetcher, and the York S12CPUV2 mirror is encrypted. The Utah CPU12RM Rev 4.0 copy is the readable primary source. Keep a local copy for transcription.