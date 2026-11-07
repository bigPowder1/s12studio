;*****************************************************************************************
;* allmodes_probes.asm - S12 Studio assembler conformance source                         *
;*                                                                                       *
;* Probes whose SYNTAX itself is unconfirmed: any of them may be rejected by CW. Each    *
;* probe is wrapped in IFNDEF NO_Pnn ... ENDIF so it can be switched off with -DNO_Pnn   *
;* without editing the file. Probe P21 (8-bit relocations) is OFF unless -DP21 is given, *
;* because the S12 Studio clone cannot assemble it yet.                                  *
;*                                                                                       *
;* HOW TO RUN ON A LAB PC (CodeWarrior S12(X) v5.1):                                     *
;*  1. Copy blank_project. Put allmodes_core.asm, allmodes_s12x.asm, allmodes_probes.asm *
;*     and allmodes_inc.inc into its Sources folder and add the three .asm files to the  *
;*     Sources group (each .asm is a separate assembly unit: an error in one file does   *
;*     not stop the listing/object of the others).                                       *
;*  2. Keep the default assembler options  -CPUHCS12X -L=%(TEXTPATH)\%n.lst -Li          *
;*     and press Make. Linking may fail on the XREFs - only the assembler outputs matter.*
;*  3. Collect bin\<name>.lst, bin\<name>.dbg and ObjectCode\<name>.asm.o of each file.  *
;*  4. Remove -Li, Make again, collect the same files again (keep the two sets apart).   *
;*                                                                                       *
;* IF CODEWARRIOR REPORTS AN ERROR: CW writes NO .lst/.o for a file with errors. Copy    *
;* the full message text (code, line, column), then either comment the offending line    *
;* out with ';' or, in allmodes_probes.asm / allmodes_s12x.asm, switch the whole probe   *
;* off with an assembler option -D<guard> (e.g. -DNO_P13; the guard names are on each    *
;* IFNDEF line). Rebuild and bring back the error text together with the outputs.        *
;*****************************************************************************************

            XREF  PrExtern
            XREF.B PrExternDirect

PrConst:    SECTION
PrTable:    DC.B  1,2,3,4

Probes:     SECTION
PrEntry:    NOP

; P2b: S12X MOVB with a forward-referenced indexed offset (clone: 16-bit offset).
            IFNDEF NO_P2B
            MOVB  #1,PrFwdOff,Y
            ENDIF

; P3b: PC-relative offset to a label of ANOTHER section (clone: 16-bit + PCREL16 relocation).
            IFNDEF NO_P3B
            LDAA  PrTable,PCR
            ENDIF

; P3c: S12X MOVB/MOVW with PCR operands (which PC is the base of each operand?).
            IFNDEF NO_P3C
PrP3:       NOP
            MOVB  PrP3,PCR,PrP3Fwd,PCR  ; S12X idx,idx PCR: source PC base?
            MOVW  #$1234,PrP3,PCR
            MOVB  PrP3,PCR,$1234
PrP3Fwd:    NOP
            ENDIF

; P12: S12X MOVB/MOVW with large indexed offsets on both sides.
            IFNDEF NO_P12
            MOVB  100,X,$1234,Y
            MOVW  [D,X],[$10,Y]
            ENDIF

; P13: TFR spelling of the low byte of a 16-bit register (clone accepts TFR XL,A = TFR X,A).
            IFNDEF NO_P13
            TFR   XL,A
            ENDIF

; P16b: MASM-style constant suffixes (manual appendix "MASM Compatibility" - maybe only with -Compat?).
            IFNDEF NO_P16B
            DC.B  101b, 0FFh, 17o, 12q, 99d
            ENDIF

; P16c: unary logical NOT (the manual operator table does not list it).
            IFNDEF NO_P16C
            DC.B  !0, !5
            ENDIF

; P21: 8-bit relocations - NOT supported by the clone (error A9001); give -DP21 on the lab PC.
            IFDEF P21
            LDAA  PrExternDirect        ; XREF.B -> direct with an 8-bit relocation
            LDAA  #LOW(PrTable)         ; LOW() of a relocatable symbol
            DC.B  PrTable               ; 8-bit data relocation
            ENDIF

PrFwdOff:   EQU   4                     ; defined after its use (P2b)
