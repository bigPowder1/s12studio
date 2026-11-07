;*****************************************************************************************
;* allmodes_core.asm - S12 Studio assembler conformance source                           *
;*                                                                                       *
;* Part 1: every CPU12/HCS12 instruction form and indexed variant (generated from the    *
;* @s12/isa opcode table; S12X-only forms are in allmodes_s12x.asm). Part 2: probes of   *
;* behaviour the clone had to GUESS, written ONLY with syntax that the CodeWarrior       *
;* manual, the golden fixtures or the CPU12 reference manual confirm (riskier syntax is  *
;* in allmodes_probes.asm). Each probe names the UNCERTAIN item it settles.              *
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

            XDEF  AmEntry, AmGlobalData
            XREF  AmExtern, AmExtern2

AmBackDir:  EQU   $41                   ; used by probe P1 (defined before use)
AmBackOff:  EQU   4                     ; used by probe P2

; ---- data ---------------------------------------------------------------------------------
AmData:     SECTION
AmByte:     DS.B  1                 ; DWARF: unsigned char
AmWord:     DS.W  1                 ; DWARF: int
AmLong:     DS.L  1                 ; DWARF: long
AmBuf:      DS.B  5                 ; DWARF: array[5] of unsigned char
AmWords:    DS.W  3                 ; PROBE P9: array of int - bit stride 16?
AmGlobalData: DS.B 2                ; global data label
AmLabelOnly:                        ; PROBE P9: label alone, DS on the next line - type?
            DS.W  1

AmConst:    SECTION
AmTable:    DC.B  1,2,3,4           ; constant section (PROGBITS, flags A)
            DC.W  $1234             ; PROBE P5: unlabelled DC in a constant section -> VARnnnnn?
AmStr:      DC.B  "ABC",0,'xyz'
            DC.W  "ABCDE"           ; strings right-aligned in DC.W: 0041 4243 4445
            DC.L  "AB"              ; 0000 4142
            DCB.B 3,$FF
            DCB.W 2,$1234
            FCB   1,2
            FDB   $1234
            FCC   "fcc"             ; PROBE: FCC accepted as DC.B of a string?

AmFarCode:  SECTION
AmFar:      RTC                     ; target of CALL (PAGE(AmFar) -> PAGE8 relocation)

; ---- code ---------------------------------------------------------------------------------
AllModes:   SECTION
AmEntry:
; ===== Part 1: every CPU12/HCS12 instruction form =========================================
        BGND                            ; INH 00
        MEM                             ; INH 01
        INY                             ; INH 02
        DEY                             ; INH 03
        DBEQ    A,*                     ; LOOP 04 lb rr
        DBEQ    B,*                     ; LOOP 04 lb rr
        DBEQ    D,*                     ; LOOP 04 lb rr
        DBEQ    X,*                     ; LOOP 04 lb rr
        DBEQ    Y,*                     ; LOOP 04 lb rr
        DBEQ    SP,*                    ; LOOP 04 lb rr
        DBNE    A,*                     ; LOOP 04 lb rr
        DBNE    B,*                     ; LOOP 04 lb rr
        DBNE    D,*                     ; LOOP 04 lb rr
        DBNE    X,*                     ; LOOP 04 lb rr
        DBNE    Y,*                     ; LOOP 04 lb rr
        DBNE    SP,*                    ; LOOP 04 lb rr
        TBEQ    A,*                     ; LOOP 04 lb rr
        TBEQ    B,*                     ; LOOP 04 lb rr
        TBEQ    D,*                     ; LOOP 04 lb rr
        TBEQ    X,*                     ; LOOP 04 lb rr
        TBEQ    Y,*                     ; LOOP 04 lb rr
        TBEQ    SP,*                    ; LOOP 04 lb rr
        TBNE    A,*                     ; LOOP 04 lb rr
        TBNE    B,*                     ; LOOP 04 lb rr
        TBNE    D,*                     ; LOOP 04 lb rr
        TBNE    X,*                     ; LOOP 04 lb rr
        TBNE    Y,*                     ; LOOP 04 lb rr
        TBNE    SP,*                    ; LOOP 04 lb rr
        IBEQ    A,*                     ; LOOP 04 lb rr
        IBEQ    B,*                     ; LOOP 04 lb rr
        IBEQ    D,*                     ; LOOP 04 lb rr
        IBEQ    X,*                     ; LOOP 04 lb rr
        IBEQ    Y,*                     ; LOOP 04 lb rr
        IBEQ    SP,*                    ; LOOP 04 lb rr
        IBNE    A,*                     ; LOOP 04 lb rr
        IBNE    B,*                     ; LOOP 04 lb rr
        IBNE    D,*                     ; LOOP 04 lb rr
        IBNE    X,*                     ; LOOP 04 lb rr
        IBNE    Y,*                     ; LOOP 04 lb rr
        IBNE    SP,*                    ; LOOP 04 lb rr
        JMP     5,X                     ; IDX 05 xb [ff|ee ff]: 5-bit constant offset
        JMP     -16,Y                   ; IDX 05 xb [ff|ee ff]: 5-bit, most negative
        JMP     15,SP                   ; IDX 05 xb [ff|ee ff]: 5-bit, most positive
        JMP     0,PC                    ; IDX 05 xb [ff|ee ff]: 5-bit, PC literal
        JMP     A,X                     ; IDX 05 xb [ff|ee ff]: accumulator A offset
        JMP     B,Y                     ; IDX 05 xb [ff|ee ff]: accumulator B offset
        JMP     D,SP                    ; IDX 05 xb [ff|ee ff]: accumulator D offset
        JMP     1,+X                    ; IDX 05 xb [ff|ee ff]: pre-increment
        JMP     8,-Y                    ; IDX 05 xb [ff|ee ff]: pre-decrement
        JMP     2,SP+                   ; IDX 05 xb [ff|ee ff]: post-increment
        JMP     7,X-                    ; IDX 05 xb [ff|ee ff]: post-decrement
        JMP     16,X                    ; IDX 05 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        JMP     -17,Y                   ; IDX 05 xb [ff|ee ff]: 9-bit negative
        JMP     255,SP                  ; IDX 05 xb [ff|ee ff]: 9-bit max
        JMP     -256,X                  ; IDX 05 xb [ff|ee ff]: 9-bit min
        JMP     256,Y                   ; IDX 05 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        JMP     $8000,X                 ; IDX 05 xb [ff|ee ff]: 16-bit large
        JMP     [$1234,X]               ; IDX 05 xb [ff|ee ff]: indexed indirect 16-bit
        JMP     [D,SP]                  ; IDX 05 xb [ff|ee ff]: accumulator D indirect
        JMP     $1234                   ; EXT 06 hh ll
        JMP     >$40                    ; EXT 06 hh ll (forced extended)
        BSR     *                       ; REL8 07 rr
        INX                             ; INH 08
        DEX                             ; INH 09
        RTC                             ; INH 0A
        RTI                             ; INH 0B
        BSET    5,X,#$5A                ; BIT_IDX 0C xb [ff|ee ff] mm: 5-bit constant offset
        BSET    -16,Y,#$5A              ; BIT_IDX 0C xb [ff|ee ff] mm: 5-bit, most negative
        BSET    15,SP,#$5A              ; BIT_IDX 0C xb [ff|ee ff] mm: 5-bit, most positive
        BSET    0,PC,#$5A               ; BIT_IDX 0C xb [ff|ee ff] mm: 5-bit, PC literal
        BSET    A,X,#$5A                ; BIT_IDX 0C xb [ff|ee ff] mm: accumulator A offset
        BSET    B,Y,#$5A                ; BIT_IDX 0C xb [ff|ee ff] mm: accumulator B offset
        BSET    D,SP,#$5A               ; BIT_IDX 0C xb [ff|ee ff] mm: accumulator D offset
        BSET    1,+X,#$5A               ; BIT_IDX 0C xb [ff|ee ff] mm: pre-increment
        BSET    8,-Y,#$5A               ; BIT_IDX 0C xb [ff|ee ff] mm: pre-decrement
        BSET    2,SP+,#$5A              ; BIT_IDX 0C xb [ff|ee ff] mm: post-increment
        BSET    7,X-,#$5A               ; BIT_IDX 0C xb [ff|ee ff] mm: post-decrement
        BSET    16,X,#$5A               ; BIT_IDX 0C xb [ff|ee ff] mm: 9-bit (just outside 5-bit)
        BSET    -17,Y,#$5A              ; BIT_IDX 0C xb [ff|ee ff] mm: 9-bit negative
        BSET    255,SP,#$5A             ; BIT_IDX 0C xb [ff|ee ff] mm: 9-bit max
        BSET    -256,X,#$5A             ; BIT_IDX 0C xb [ff|ee ff] mm: 9-bit min
        BSET    256,Y,#$5A              ; BIT_IDX 0C xb [ff|ee ff] mm: 16-bit (just outside 9-bit)
        BSET    $8000,X,#$5A            ; BIT_IDX 0C xb [ff|ee ff] mm: 16-bit large
        BCLR    5,X,#$5A                ; BIT_IDX 0D xb [ff|ee ff] mm: 5-bit constant offset
        BCLR    -16,Y,#$5A              ; BIT_IDX 0D xb [ff|ee ff] mm: 5-bit, most negative
        BCLR    15,SP,#$5A              ; BIT_IDX 0D xb [ff|ee ff] mm: 5-bit, most positive
        BCLR    0,PC,#$5A               ; BIT_IDX 0D xb [ff|ee ff] mm: 5-bit, PC literal
        BCLR    A,X,#$5A                ; BIT_IDX 0D xb [ff|ee ff] mm: accumulator A offset
        BCLR    B,Y,#$5A                ; BIT_IDX 0D xb [ff|ee ff] mm: accumulator B offset
        BCLR    D,SP,#$5A               ; BIT_IDX 0D xb [ff|ee ff] mm: accumulator D offset
        BCLR    1,+X,#$5A               ; BIT_IDX 0D xb [ff|ee ff] mm: pre-increment
        BCLR    8,-Y,#$5A               ; BIT_IDX 0D xb [ff|ee ff] mm: pre-decrement
        BCLR    2,SP+,#$5A              ; BIT_IDX 0D xb [ff|ee ff] mm: post-increment
        BCLR    7,X-,#$5A               ; BIT_IDX 0D xb [ff|ee ff] mm: post-decrement
        BCLR    16,X,#$5A               ; BIT_IDX 0D xb [ff|ee ff] mm: 9-bit (just outside 5-bit)
        BCLR    -17,Y,#$5A              ; BIT_IDX 0D xb [ff|ee ff] mm: 9-bit negative
        BCLR    255,SP,#$5A             ; BIT_IDX 0D xb [ff|ee ff] mm: 9-bit max
        BCLR    -256,X,#$5A             ; BIT_IDX 0D xb [ff|ee ff] mm: 9-bit min
        BCLR    256,Y,#$5A              ; BIT_IDX 0D xb [ff|ee ff] mm: 16-bit (just outside 9-bit)
        BCLR    $8000,X,#$5A            ; BIT_IDX 0D xb [ff|ee ff] mm: 16-bit large
        BRSET   5,X,#$5A,*              ; BRBIT_IDX 0E xb [ff|ee ff] mm rr: 5-bit constant offset
        BRSET   -16,Y,#$5A,*            ; BRBIT_IDX 0E xb [ff|ee ff] mm rr: 5-bit, most negative
        BRSET   15,SP,#$5A,*            ; BRBIT_IDX 0E xb [ff|ee ff] mm rr: 5-bit, most positive
        BRSET   0,PC,#$5A,*             ; BRBIT_IDX 0E xb [ff|ee ff] mm rr: 5-bit, PC literal
        BRSET   A,X,#$5A,*              ; BRBIT_IDX 0E xb [ff|ee ff] mm rr: accumulator A offset
        BRSET   B,Y,#$5A,*              ; BRBIT_IDX 0E xb [ff|ee ff] mm rr: accumulator B offset
        BRSET   D,SP,#$5A,*             ; BRBIT_IDX 0E xb [ff|ee ff] mm rr: accumulator D offset
        BRSET   1,+X,#$5A,*             ; BRBIT_IDX 0E xb [ff|ee ff] mm rr: pre-increment
        BRSET   8,-Y,#$5A,*             ; BRBIT_IDX 0E xb [ff|ee ff] mm rr: pre-decrement
        BRSET   2,SP+,#$5A,*            ; BRBIT_IDX 0E xb [ff|ee ff] mm rr: post-increment
        BRSET   7,X-,#$5A,*             ; BRBIT_IDX 0E xb [ff|ee ff] mm rr: post-decrement
        BRSET   16,X,#$5A,*             ; BRBIT_IDX 0E xb [ff|ee ff] mm rr: 9-bit (just outside 5-bit)
        BRSET   -17,Y,#$5A,*            ; BRBIT_IDX 0E xb [ff|ee ff] mm rr: 9-bit negative
        BRSET   255,SP,#$5A,*           ; BRBIT_IDX 0E xb [ff|ee ff] mm rr: 9-bit max
        BRSET   -256,X,#$5A,*           ; BRBIT_IDX 0E xb [ff|ee ff] mm rr: 9-bit min
        BRSET   256,Y,#$5A,*            ; BRBIT_IDX 0E xb [ff|ee ff] mm rr: 16-bit (just outside 9-bit)
        BRSET   $8000,X,#$5A,*          ; BRBIT_IDX 0E xb [ff|ee ff] mm rr: 16-bit large
        BRCLR   5,X,#$5A,*              ; BRBIT_IDX 0F xb [ff|ee ff] mm rr: 5-bit constant offset
        BRCLR   -16,Y,#$5A,*            ; BRBIT_IDX 0F xb [ff|ee ff] mm rr: 5-bit, most negative
        BRCLR   15,SP,#$5A,*            ; BRBIT_IDX 0F xb [ff|ee ff] mm rr: 5-bit, most positive
        BRCLR   0,PC,#$5A,*             ; BRBIT_IDX 0F xb [ff|ee ff] mm rr: 5-bit, PC literal
        BRCLR   A,X,#$5A,*              ; BRBIT_IDX 0F xb [ff|ee ff] mm rr: accumulator A offset
        BRCLR   B,Y,#$5A,*              ; BRBIT_IDX 0F xb [ff|ee ff] mm rr: accumulator B offset
        BRCLR   D,SP,#$5A,*             ; BRBIT_IDX 0F xb [ff|ee ff] mm rr: accumulator D offset
        BRCLR   1,+X,#$5A,*             ; BRBIT_IDX 0F xb [ff|ee ff] mm rr: pre-increment
        BRCLR   8,-Y,#$5A,*             ; BRBIT_IDX 0F xb [ff|ee ff] mm rr: pre-decrement
        BRCLR   2,SP+,#$5A,*            ; BRBIT_IDX 0F xb [ff|ee ff] mm rr: post-increment
        BRCLR   7,X-,#$5A,*             ; BRBIT_IDX 0F xb [ff|ee ff] mm rr: post-decrement
        BRCLR   16,X,#$5A,*             ; BRBIT_IDX 0F xb [ff|ee ff] mm rr: 9-bit (just outside 5-bit)
        BRCLR   -17,Y,#$5A,*            ; BRBIT_IDX 0F xb [ff|ee ff] mm rr: 9-bit negative
        BRCLR   255,SP,#$5A,*           ; BRBIT_IDX 0F xb [ff|ee ff] mm rr: 9-bit max
        BRCLR   -256,X,#$5A,*           ; BRBIT_IDX 0F xb [ff|ee ff] mm rr: 9-bit min
        BRCLR   256,Y,#$5A,*            ; BRBIT_IDX 0F xb [ff|ee ff] mm rr: 16-bit (just outside 9-bit)
        BRCLR   $8000,X,#$5A,*          ; BRBIT_IDX 0F xb [ff|ee ff] mm rr: 16-bit large
        ANDCC   #$5A                    ; IMM8 10 ii
        EDIV                            ; INH 11
        MUL                             ; INH 12
        EMUL                            ; INH 13
        ORCC    #$5A                    ; IMM8 14 ii
        JSR     5,X                     ; IDX 15 xb [ff|ee ff]: 5-bit constant offset
        JSR     -16,Y                   ; IDX 15 xb [ff|ee ff]: 5-bit, most negative
        JSR     15,SP                   ; IDX 15 xb [ff|ee ff]: 5-bit, most positive
        JSR     0,PC                    ; IDX 15 xb [ff|ee ff]: 5-bit, PC literal
        JSR     A,X                     ; IDX 15 xb [ff|ee ff]: accumulator A offset
        JSR     B,Y                     ; IDX 15 xb [ff|ee ff]: accumulator B offset
        JSR     D,SP                    ; IDX 15 xb [ff|ee ff]: accumulator D offset
        JSR     1,+X                    ; IDX 15 xb [ff|ee ff]: pre-increment
        JSR     8,-Y                    ; IDX 15 xb [ff|ee ff]: pre-decrement
        JSR     2,SP+                   ; IDX 15 xb [ff|ee ff]: post-increment
        JSR     7,X-                    ; IDX 15 xb [ff|ee ff]: post-decrement
        JSR     16,X                    ; IDX 15 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        JSR     -17,Y                   ; IDX 15 xb [ff|ee ff]: 9-bit negative
        JSR     255,SP                  ; IDX 15 xb [ff|ee ff]: 9-bit max
        JSR     -256,X                  ; IDX 15 xb [ff|ee ff]: 9-bit min
        JSR     256,Y                   ; IDX 15 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        JSR     $8000,X                 ; IDX 15 xb [ff|ee ff]: 16-bit large
        JSR     [$1234,X]               ; IDX 15 xb [ff|ee ff]: indexed indirect 16-bit
        JSR     [D,SP]                  ; IDX 15 xb [ff|ee ff]: accumulator D indirect
        JSR     $1234                   ; EXT 16 hh ll
        JSR     >$40                    ; EXT 16 hh ll (forced extended)
        JSR     $40                     ; DIR 17 dd
        LEAY    5,X                     ; IDX 19 xb [ff|ee ff]: 5-bit constant offset
        LEAY    -16,Y                   ; IDX 19 xb [ff|ee ff]: 5-bit, most negative
        LEAY    15,SP                   ; IDX 19 xb [ff|ee ff]: 5-bit, most positive
        LEAY    0,PC                    ; IDX 19 xb [ff|ee ff]: 5-bit, PC literal
        LEAY    A,X                     ; IDX 19 xb [ff|ee ff]: accumulator A offset
        LEAY    B,Y                     ; IDX 19 xb [ff|ee ff]: accumulator B offset
        LEAY    D,SP                    ; IDX 19 xb [ff|ee ff]: accumulator D offset
        LEAY    1,+X                    ; IDX 19 xb [ff|ee ff]: pre-increment
        LEAY    8,-Y                    ; IDX 19 xb [ff|ee ff]: pre-decrement
        LEAY    2,SP+                   ; IDX 19 xb [ff|ee ff]: post-increment
        LEAY    7,X-                    ; IDX 19 xb [ff|ee ff]: post-decrement
        LEAY    16,X                    ; IDX 19 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        LEAY    -17,Y                   ; IDX 19 xb [ff|ee ff]: 9-bit negative
        LEAY    255,SP                  ; IDX 19 xb [ff|ee ff]: 9-bit max
        LEAY    -256,X                  ; IDX 19 xb [ff|ee ff]: 9-bit min
        LEAY    256,Y                   ; IDX 19 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        LEAY    $8000,X                 ; IDX 19 xb [ff|ee ff]: 16-bit large
        LEAX    5,X                     ; IDX 1A xb [ff|ee ff]: 5-bit constant offset
        LEAX    -16,Y                   ; IDX 1A xb [ff|ee ff]: 5-bit, most negative
        LEAX    15,SP                   ; IDX 1A xb [ff|ee ff]: 5-bit, most positive
        LEAX    0,PC                    ; IDX 1A xb [ff|ee ff]: 5-bit, PC literal
        LEAX    A,X                     ; IDX 1A xb [ff|ee ff]: accumulator A offset
        LEAX    B,Y                     ; IDX 1A xb [ff|ee ff]: accumulator B offset
        LEAX    D,SP                    ; IDX 1A xb [ff|ee ff]: accumulator D offset
        LEAX    1,+X                    ; IDX 1A xb [ff|ee ff]: pre-increment
        LEAX    8,-Y                    ; IDX 1A xb [ff|ee ff]: pre-decrement
        LEAX    2,SP+                   ; IDX 1A xb [ff|ee ff]: post-increment
        LEAX    7,X-                    ; IDX 1A xb [ff|ee ff]: post-decrement
        LEAX    16,X                    ; IDX 1A xb [ff|ee ff]: 9-bit (just outside 5-bit)
        LEAX    -17,Y                   ; IDX 1A xb [ff|ee ff]: 9-bit negative
        LEAX    255,SP                  ; IDX 1A xb [ff|ee ff]: 9-bit max
        LEAX    -256,X                  ; IDX 1A xb [ff|ee ff]: 9-bit min
        LEAX    256,Y                   ; IDX 1A xb [ff|ee ff]: 16-bit (just outside 9-bit)
        LEAX    $8000,X                 ; IDX 1A xb [ff|ee ff]: 16-bit large
        LEAS    5,X                     ; IDX 1B xb [ff|ee ff]: 5-bit constant offset
        LEAS    -16,Y                   ; IDX 1B xb [ff|ee ff]: 5-bit, most negative
        LEAS    15,SP                   ; IDX 1B xb [ff|ee ff]: 5-bit, most positive
        LEAS    0,PC                    ; IDX 1B xb [ff|ee ff]: 5-bit, PC literal
        LEAS    A,X                     ; IDX 1B xb [ff|ee ff]: accumulator A offset
        LEAS    B,Y                     ; IDX 1B xb [ff|ee ff]: accumulator B offset
        LEAS    D,SP                    ; IDX 1B xb [ff|ee ff]: accumulator D offset
        LEAS    1,+X                    ; IDX 1B xb [ff|ee ff]: pre-increment
        LEAS    8,-Y                    ; IDX 1B xb [ff|ee ff]: pre-decrement
        LEAS    2,SP+                   ; IDX 1B xb [ff|ee ff]: post-increment
        LEAS    7,X-                    ; IDX 1B xb [ff|ee ff]: post-decrement
        LEAS    16,X                    ; IDX 1B xb [ff|ee ff]: 9-bit (just outside 5-bit)
        LEAS    -17,Y                   ; IDX 1B xb [ff|ee ff]: 9-bit negative
        LEAS    255,SP                  ; IDX 1B xb [ff|ee ff]: 9-bit max
        LEAS    -256,X                  ; IDX 1B xb [ff|ee ff]: 9-bit min
        LEAS    256,Y                   ; IDX 1B xb [ff|ee ff]: 16-bit (just outside 9-bit)
        LEAS    $8000,X                 ; IDX 1B xb [ff|ee ff]: 16-bit large
        BSET    $1234,#$5A              ; BIT_EXT 1C hh ll mm
        BCLR    $1234,#$5A              ; BIT_EXT 1D hh ll mm
        BRSET   $1234,#$5A,*            ; BRBIT_EXT 1E hh ll mm rr
        BRCLR   $1234,#$5A,*            ; BRBIT_EXT 1F hh ll mm rr
        BRA     *                       ; REL8 20 rr
        BRN     *                       ; REL8 21 rr
        BHI     *                       ; REL8 22 rr
        BLS     *                       ; REL8 23 rr
        BCC     *                       ; REL8 24 rr
        BCS     *                       ; REL8 25 rr
        BNE     *                       ; REL8 26 rr
        BEQ     *                       ; REL8 27 rr
        BVC     *                       ; REL8 28 rr
        BVS     *                       ; REL8 29 rr
        BPL     *                       ; REL8 2A rr
        BMI     *                       ; REL8 2B rr
        BGE     *                       ; REL8 2C rr
        BLT     *                       ; REL8 2D rr
        BGT     *                       ; REL8 2E rr
        BLE     *                       ; REL8 2F rr
        PULX                            ; INH 30
        PULY                            ; INH 31
        PULA                            ; INH 32
        PULB                            ; INH 33
        PSHX                            ; INH 34
        PSHY                            ; INH 35
        PSHA                            ; INH 36
        PSHB                            ; INH 37
        PULC                            ; INH 38
        PSHC                            ; INH 39
        PULD                            ; INH 3A
        PSHD                            ; INH 3B
        WAVR                            ; INH 3C
        RTS                             ; INH 3D
        WAI                             ; INH 3E
        SWI                             ; INH 3F
        NEGA                            ; INH 40
        NEGB                            ; INH 50
        NEG     5,X                     ; IDX 60 xb [ff|ee ff]: 5-bit constant offset
        NEG     -16,Y                   ; IDX 60 xb [ff|ee ff]: 5-bit, most negative
        NEG     15,SP                   ; IDX 60 xb [ff|ee ff]: 5-bit, most positive
        NEG     0,PC                    ; IDX 60 xb [ff|ee ff]: 5-bit, PC literal
        NEG     A,X                     ; IDX 60 xb [ff|ee ff]: accumulator A offset
        NEG     B,Y                     ; IDX 60 xb [ff|ee ff]: accumulator B offset
        NEG     D,SP                    ; IDX 60 xb [ff|ee ff]: accumulator D offset
        NEG     1,+X                    ; IDX 60 xb [ff|ee ff]: pre-increment
        NEG     8,-Y                    ; IDX 60 xb [ff|ee ff]: pre-decrement
        NEG     2,SP+                   ; IDX 60 xb [ff|ee ff]: post-increment
        NEG     7,X-                    ; IDX 60 xb [ff|ee ff]: post-decrement
        NEG     16,X                    ; IDX 60 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        NEG     -17,Y                   ; IDX 60 xb [ff|ee ff]: 9-bit negative
        NEG     255,SP                  ; IDX 60 xb [ff|ee ff]: 9-bit max
        NEG     -256,X                  ; IDX 60 xb [ff|ee ff]: 9-bit min
        NEG     256,Y                   ; IDX 60 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        NEG     $8000,X                 ; IDX 60 xb [ff|ee ff]: 16-bit large
        NEG     [$1234,X]               ; IDX 60 xb [ff|ee ff]: indexed indirect 16-bit
        NEG     [D,SP]                  ; IDX 60 xb [ff|ee ff]: accumulator D indirect
        NEG     $1234                   ; EXT 70 hh ll
        NEG     >$40                    ; EXT 70 hh ll (forced extended)
        COMA                            ; INH 41
        COMB                            ; INH 51
        COM     5,X                     ; IDX 61 xb [ff|ee ff]: 5-bit constant offset
        COM     -16,Y                   ; IDX 61 xb [ff|ee ff]: 5-bit, most negative
        COM     15,SP                   ; IDX 61 xb [ff|ee ff]: 5-bit, most positive
        COM     0,PC                    ; IDX 61 xb [ff|ee ff]: 5-bit, PC literal
        COM     A,X                     ; IDX 61 xb [ff|ee ff]: accumulator A offset
        COM     B,Y                     ; IDX 61 xb [ff|ee ff]: accumulator B offset
        COM     D,SP                    ; IDX 61 xb [ff|ee ff]: accumulator D offset
        COM     1,+X                    ; IDX 61 xb [ff|ee ff]: pre-increment
        COM     8,-Y                    ; IDX 61 xb [ff|ee ff]: pre-decrement
        COM     2,SP+                   ; IDX 61 xb [ff|ee ff]: post-increment
        COM     7,X-                    ; IDX 61 xb [ff|ee ff]: post-decrement
        COM     16,X                    ; IDX 61 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        COM     -17,Y                   ; IDX 61 xb [ff|ee ff]: 9-bit negative
        COM     255,SP                  ; IDX 61 xb [ff|ee ff]: 9-bit max
        COM     -256,X                  ; IDX 61 xb [ff|ee ff]: 9-bit min
        COM     256,Y                   ; IDX 61 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        COM     $8000,X                 ; IDX 61 xb [ff|ee ff]: 16-bit large
        COM     [$1234,X]               ; IDX 61 xb [ff|ee ff]: indexed indirect 16-bit
        COM     [D,SP]                  ; IDX 61 xb [ff|ee ff]: accumulator D indirect
        COM     $1234                   ; EXT 71 hh ll
        COM     >$40                    ; EXT 71 hh ll (forced extended)
        INCA                            ; INH 42
        INCB                            ; INH 52
        INC     5,X                     ; IDX 62 xb [ff|ee ff]: 5-bit constant offset
        INC     -16,Y                   ; IDX 62 xb [ff|ee ff]: 5-bit, most negative
        INC     15,SP                   ; IDX 62 xb [ff|ee ff]: 5-bit, most positive
        INC     0,PC                    ; IDX 62 xb [ff|ee ff]: 5-bit, PC literal
        INC     A,X                     ; IDX 62 xb [ff|ee ff]: accumulator A offset
        INC     B,Y                     ; IDX 62 xb [ff|ee ff]: accumulator B offset
        INC     D,SP                    ; IDX 62 xb [ff|ee ff]: accumulator D offset
        INC     1,+X                    ; IDX 62 xb [ff|ee ff]: pre-increment
        INC     8,-Y                    ; IDX 62 xb [ff|ee ff]: pre-decrement
        INC     2,SP+                   ; IDX 62 xb [ff|ee ff]: post-increment
        INC     7,X-                    ; IDX 62 xb [ff|ee ff]: post-decrement
        INC     16,X                    ; IDX 62 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        INC     -17,Y                   ; IDX 62 xb [ff|ee ff]: 9-bit negative
        INC     255,SP                  ; IDX 62 xb [ff|ee ff]: 9-bit max
        INC     -256,X                  ; IDX 62 xb [ff|ee ff]: 9-bit min
        INC     256,Y                   ; IDX 62 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        INC     $8000,X                 ; IDX 62 xb [ff|ee ff]: 16-bit large
        INC     [$1234,X]               ; IDX 62 xb [ff|ee ff]: indexed indirect 16-bit
        INC     [D,SP]                  ; IDX 62 xb [ff|ee ff]: accumulator D indirect
        INC     $1234                   ; EXT 72 hh ll
        INC     >$40                    ; EXT 72 hh ll (forced extended)
        DECA                            ; INH 43
        DECB                            ; INH 53
        DEC     5,X                     ; IDX 63 xb [ff|ee ff]: 5-bit constant offset
        DEC     -16,Y                   ; IDX 63 xb [ff|ee ff]: 5-bit, most negative
        DEC     15,SP                   ; IDX 63 xb [ff|ee ff]: 5-bit, most positive
        DEC     0,PC                    ; IDX 63 xb [ff|ee ff]: 5-bit, PC literal
        DEC     A,X                     ; IDX 63 xb [ff|ee ff]: accumulator A offset
        DEC     B,Y                     ; IDX 63 xb [ff|ee ff]: accumulator B offset
        DEC     D,SP                    ; IDX 63 xb [ff|ee ff]: accumulator D offset
        DEC     1,+X                    ; IDX 63 xb [ff|ee ff]: pre-increment
        DEC     8,-Y                    ; IDX 63 xb [ff|ee ff]: pre-decrement
        DEC     2,SP+                   ; IDX 63 xb [ff|ee ff]: post-increment
        DEC     7,X-                    ; IDX 63 xb [ff|ee ff]: post-decrement
        DEC     16,X                    ; IDX 63 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        DEC     -17,Y                   ; IDX 63 xb [ff|ee ff]: 9-bit negative
        DEC     255,SP                  ; IDX 63 xb [ff|ee ff]: 9-bit max
        DEC     -256,X                  ; IDX 63 xb [ff|ee ff]: 9-bit min
        DEC     256,Y                   ; IDX 63 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        DEC     $8000,X                 ; IDX 63 xb [ff|ee ff]: 16-bit large
        DEC     [$1234,X]               ; IDX 63 xb [ff|ee ff]: indexed indirect 16-bit
        DEC     [D,SP]                  ; IDX 63 xb [ff|ee ff]: accumulator D indirect
        DEC     $1234                   ; EXT 73 hh ll
        DEC     >$40                    ; EXT 73 hh ll (forced extended)
        LSRA                            ; INH 44
        LSRB                            ; INH 54
        LSR     5,X                     ; IDX 64 xb [ff|ee ff]: 5-bit constant offset
        LSR     -16,Y                   ; IDX 64 xb [ff|ee ff]: 5-bit, most negative
        LSR     15,SP                   ; IDX 64 xb [ff|ee ff]: 5-bit, most positive
        LSR     0,PC                    ; IDX 64 xb [ff|ee ff]: 5-bit, PC literal
        LSR     A,X                     ; IDX 64 xb [ff|ee ff]: accumulator A offset
        LSR     B,Y                     ; IDX 64 xb [ff|ee ff]: accumulator B offset
        LSR     D,SP                    ; IDX 64 xb [ff|ee ff]: accumulator D offset
        LSR     1,+X                    ; IDX 64 xb [ff|ee ff]: pre-increment
        LSR     8,-Y                    ; IDX 64 xb [ff|ee ff]: pre-decrement
        LSR     2,SP+                   ; IDX 64 xb [ff|ee ff]: post-increment
        LSR     7,X-                    ; IDX 64 xb [ff|ee ff]: post-decrement
        LSR     16,X                    ; IDX 64 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        LSR     -17,Y                   ; IDX 64 xb [ff|ee ff]: 9-bit negative
        LSR     255,SP                  ; IDX 64 xb [ff|ee ff]: 9-bit max
        LSR     -256,X                  ; IDX 64 xb [ff|ee ff]: 9-bit min
        LSR     256,Y                   ; IDX 64 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        LSR     $8000,X                 ; IDX 64 xb [ff|ee ff]: 16-bit large
        LSR     [$1234,X]               ; IDX 64 xb [ff|ee ff]: indexed indirect 16-bit
        LSR     [D,SP]                  ; IDX 64 xb [ff|ee ff]: accumulator D indirect
        LSR     $1234                   ; EXT 74 hh ll
        LSR     >$40                    ; EXT 74 hh ll (forced extended)
        ROLA                            ; INH 45
        ROLB                            ; INH 55
        ROL     5,X                     ; IDX 65 xb [ff|ee ff]: 5-bit constant offset
        ROL     -16,Y                   ; IDX 65 xb [ff|ee ff]: 5-bit, most negative
        ROL     15,SP                   ; IDX 65 xb [ff|ee ff]: 5-bit, most positive
        ROL     0,PC                    ; IDX 65 xb [ff|ee ff]: 5-bit, PC literal
        ROL     A,X                     ; IDX 65 xb [ff|ee ff]: accumulator A offset
        ROL     B,Y                     ; IDX 65 xb [ff|ee ff]: accumulator B offset
        ROL     D,SP                    ; IDX 65 xb [ff|ee ff]: accumulator D offset
        ROL     1,+X                    ; IDX 65 xb [ff|ee ff]: pre-increment
        ROL     8,-Y                    ; IDX 65 xb [ff|ee ff]: pre-decrement
        ROL     2,SP+                   ; IDX 65 xb [ff|ee ff]: post-increment
        ROL     7,X-                    ; IDX 65 xb [ff|ee ff]: post-decrement
        ROL     16,X                    ; IDX 65 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        ROL     -17,Y                   ; IDX 65 xb [ff|ee ff]: 9-bit negative
        ROL     255,SP                  ; IDX 65 xb [ff|ee ff]: 9-bit max
        ROL     -256,X                  ; IDX 65 xb [ff|ee ff]: 9-bit min
        ROL     256,Y                   ; IDX 65 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        ROL     $8000,X                 ; IDX 65 xb [ff|ee ff]: 16-bit large
        ROL     [$1234,X]               ; IDX 65 xb [ff|ee ff]: indexed indirect 16-bit
        ROL     [D,SP]                  ; IDX 65 xb [ff|ee ff]: accumulator D indirect
        ROL     $1234                   ; EXT 75 hh ll
        ROL     >$40                    ; EXT 75 hh ll (forced extended)
        RORA                            ; INH 46
        RORB                            ; INH 56
        ROR     5,X                     ; IDX 66 xb [ff|ee ff]: 5-bit constant offset
        ROR     -16,Y                   ; IDX 66 xb [ff|ee ff]: 5-bit, most negative
        ROR     15,SP                   ; IDX 66 xb [ff|ee ff]: 5-bit, most positive
        ROR     0,PC                    ; IDX 66 xb [ff|ee ff]: 5-bit, PC literal
        ROR     A,X                     ; IDX 66 xb [ff|ee ff]: accumulator A offset
        ROR     B,Y                     ; IDX 66 xb [ff|ee ff]: accumulator B offset
        ROR     D,SP                    ; IDX 66 xb [ff|ee ff]: accumulator D offset
        ROR     1,+X                    ; IDX 66 xb [ff|ee ff]: pre-increment
        ROR     8,-Y                    ; IDX 66 xb [ff|ee ff]: pre-decrement
        ROR     2,SP+                   ; IDX 66 xb [ff|ee ff]: post-increment
        ROR     7,X-                    ; IDX 66 xb [ff|ee ff]: post-decrement
        ROR     16,X                    ; IDX 66 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        ROR     -17,Y                   ; IDX 66 xb [ff|ee ff]: 9-bit negative
        ROR     255,SP                  ; IDX 66 xb [ff|ee ff]: 9-bit max
        ROR     -256,X                  ; IDX 66 xb [ff|ee ff]: 9-bit min
        ROR     256,Y                   ; IDX 66 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        ROR     $8000,X                 ; IDX 66 xb [ff|ee ff]: 16-bit large
        ROR     [$1234,X]               ; IDX 66 xb [ff|ee ff]: indexed indirect 16-bit
        ROR     [D,SP]                  ; IDX 66 xb [ff|ee ff]: accumulator D indirect
        ROR     $1234                   ; EXT 76 hh ll
        ROR     >$40                    ; EXT 76 hh ll (forced extended)
        ASRA                            ; INH 47
        ASRB                            ; INH 57
        ASR     5,X                     ; IDX 67 xb [ff|ee ff]: 5-bit constant offset
        ASR     -16,Y                   ; IDX 67 xb [ff|ee ff]: 5-bit, most negative
        ASR     15,SP                   ; IDX 67 xb [ff|ee ff]: 5-bit, most positive
        ASR     0,PC                    ; IDX 67 xb [ff|ee ff]: 5-bit, PC literal
        ASR     A,X                     ; IDX 67 xb [ff|ee ff]: accumulator A offset
        ASR     B,Y                     ; IDX 67 xb [ff|ee ff]: accumulator B offset
        ASR     D,SP                    ; IDX 67 xb [ff|ee ff]: accumulator D offset
        ASR     1,+X                    ; IDX 67 xb [ff|ee ff]: pre-increment
        ASR     8,-Y                    ; IDX 67 xb [ff|ee ff]: pre-decrement
        ASR     2,SP+                   ; IDX 67 xb [ff|ee ff]: post-increment
        ASR     7,X-                    ; IDX 67 xb [ff|ee ff]: post-decrement
        ASR     16,X                    ; IDX 67 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        ASR     -17,Y                   ; IDX 67 xb [ff|ee ff]: 9-bit negative
        ASR     255,SP                  ; IDX 67 xb [ff|ee ff]: 9-bit max
        ASR     -256,X                  ; IDX 67 xb [ff|ee ff]: 9-bit min
        ASR     256,Y                   ; IDX 67 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        ASR     $8000,X                 ; IDX 67 xb [ff|ee ff]: 16-bit large
        ASR     [$1234,X]               ; IDX 67 xb [ff|ee ff]: indexed indirect 16-bit
        ASR     [D,SP]                  ; IDX 67 xb [ff|ee ff]: accumulator D indirect
        ASR     $1234                   ; EXT 77 hh ll
        ASR     >$40                    ; EXT 77 hh ll (forced extended)
        ASLA                            ; INH 48
        ASLB                            ; INH 58
        ASL     5,X                     ; IDX 68 xb [ff|ee ff]: 5-bit constant offset
        ASL     -16,Y                   ; IDX 68 xb [ff|ee ff]: 5-bit, most negative
        ASL     15,SP                   ; IDX 68 xb [ff|ee ff]: 5-bit, most positive
        ASL     0,PC                    ; IDX 68 xb [ff|ee ff]: 5-bit, PC literal
        ASL     A,X                     ; IDX 68 xb [ff|ee ff]: accumulator A offset
        ASL     B,Y                     ; IDX 68 xb [ff|ee ff]: accumulator B offset
        ASL     D,SP                    ; IDX 68 xb [ff|ee ff]: accumulator D offset
        ASL     1,+X                    ; IDX 68 xb [ff|ee ff]: pre-increment
        ASL     8,-Y                    ; IDX 68 xb [ff|ee ff]: pre-decrement
        ASL     2,SP+                   ; IDX 68 xb [ff|ee ff]: post-increment
        ASL     7,X-                    ; IDX 68 xb [ff|ee ff]: post-decrement
        ASL     16,X                    ; IDX 68 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        ASL     -17,Y                   ; IDX 68 xb [ff|ee ff]: 9-bit negative
        ASL     255,SP                  ; IDX 68 xb [ff|ee ff]: 9-bit max
        ASL     -256,X                  ; IDX 68 xb [ff|ee ff]: 9-bit min
        ASL     256,Y                   ; IDX 68 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        ASL     $8000,X                 ; IDX 68 xb [ff|ee ff]: 16-bit large
        ASL     [$1234,X]               ; IDX 68 xb [ff|ee ff]: indexed indirect 16-bit
        ASL     [D,SP]                  ; IDX 68 xb [ff|ee ff]: accumulator D indirect
        ASL     $1234                   ; EXT 78 hh ll
        ASL     >$40                    ; EXT 78 hh ll (forced extended)
        LSRD                            ; INH 49
        CALL    $8000,$3E               ; CALL_EXT 4A hh ll pg
        CALL    AmFar,PAGE(AmFar)       ; CALL_EXT 4A hh ll pg (page from PAGE())
        CALL    5,X,$3E                 ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): 5-bit constant offset
        CALL    -16,Y,$3E               ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): 5-bit, most negative
        CALL    15,SP,$3E               ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): 5-bit, most positive
        CALL    0,PC,$3E                ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): 5-bit, PC literal
        CALL    A,X,$3E                 ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): accumulator A offset
        CALL    B,Y,$3E                 ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): accumulator B offset
        CALL    D,SP,$3E                ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): accumulator D offset
        CALL    1,+X,$3E                ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): pre-increment
        CALL    8,-Y,$3E                ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): pre-decrement
        CALL    2,SP+,$3E               ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): post-increment
        CALL    7,X-,$3E                ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): post-decrement
        CALL    16,X,$3E                ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): 9-bit (just outside 5-bit)
        CALL    -17,Y,$3E               ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): 9-bit negative
        CALL    255,SP,$3E              ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): 9-bit max
        CALL    -256,X,$3E              ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): 9-bit min
        CALL    256,Y,$3E               ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): 16-bit (just outside 9-bit)
        CALL    $8000,X,$3E             ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): 16-bit large
        CALL    [$1234,X]               ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): indexed indirect 16-bit
        CALL    [D,SP]                  ; CALL_IDX 4B xb [ff|ee ff] pg | xb [ee ff] (indirect, no pg): accumulator D indirect
        BSET    $40,#$5A                ; BIT_DIR 4C dd mm
        BCLR    $40,#$5A                ; BIT_DIR 4D dd mm
        BRSET   $40,#$5A,*              ; BRBIT_DIR 4E dd mm rr
        BRCLR   $40,#$5A,*              ; BRBIT_DIR 4F dd mm rr
        ASLD                            ; INH 59
        STAA    $40                     ; DIR 5A dd
        STAA    5,X                     ; IDX 6A xb [ff|ee ff]: 5-bit constant offset
        STAA    -16,Y                   ; IDX 6A xb [ff|ee ff]: 5-bit, most negative
        STAA    15,SP                   ; IDX 6A xb [ff|ee ff]: 5-bit, most positive
        STAA    0,PC                    ; IDX 6A xb [ff|ee ff]: 5-bit, PC literal
        STAA    A,X                     ; IDX 6A xb [ff|ee ff]: accumulator A offset
        STAA    B,Y                     ; IDX 6A xb [ff|ee ff]: accumulator B offset
        STAA    D,SP                    ; IDX 6A xb [ff|ee ff]: accumulator D offset
        STAA    1,+X                    ; IDX 6A xb [ff|ee ff]: pre-increment
        STAA    8,-Y                    ; IDX 6A xb [ff|ee ff]: pre-decrement
        STAA    2,SP+                   ; IDX 6A xb [ff|ee ff]: post-increment
        STAA    7,X-                    ; IDX 6A xb [ff|ee ff]: post-decrement
        STAA    16,X                    ; IDX 6A xb [ff|ee ff]: 9-bit (just outside 5-bit)
        STAA    -17,Y                   ; IDX 6A xb [ff|ee ff]: 9-bit negative
        STAA    255,SP                  ; IDX 6A xb [ff|ee ff]: 9-bit max
        STAA    -256,X                  ; IDX 6A xb [ff|ee ff]: 9-bit min
        STAA    256,Y                   ; IDX 6A xb [ff|ee ff]: 16-bit (just outside 9-bit)
        STAA    $8000,X                 ; IDX 6A xb [ff|ee ff]: 16-bit large
        STAA    [$1234,X]               ; IDX 6A xb [ff|ee ff]: indexed indirect 16-bit
        STAA    [D,SP]                  ; IDX 6A xb [ff|ee ff]: accumulator D indirect
        STAA    $1234                   ; EXT 7A hh ll
        STAA    >$40                    ; EXT 7A hh ll (forced extended)
        STAB    $40                     ; DIR 5B dd
        STAB    5,X                     ; IDX 6B xb [ff|ee ff]: 5-bit constant offset
        STAB    -16,Y                   ; IDX 6B xb [ff|ee ff]: 5-bit, most negative
        STAB    15,SP                   ; IDX 6B xb [ff|ee ff]: 5-bit, most positive
        STAB    0,PC                    ; IDX 6B xb [ff|ee ff]: 5-bit, PC literal
        STAB    A,X                     ; IDX 6B xb [ff|ee ff]: accumulator A offset
        STAB    B,Y                     ; IDX 6B xb [ff|ee ff]: accumulator B offset
        STAB    D,SP                    ; IDX 6B xb [ff|ee ff]: accumulator D offset
        STAB    1,+X                    ; IDX 6B xb [ff|ee ff]: pre-increment
        STAB    8,-Y                    ; IDX 6B xb [ff|ee ff]: pre-decrement
        STAB    2,SP+                   ; IDX 6B xb [ff|ee ff]: post-increment
        STAB    7,X-                    ; IDX 6B xb [ff|ee ff]: post-decrement
        STAB    16,X                    ; IDX 6B xb [ff|ee ff]: 9-bit (just outside 5-bit)
        STAB    -17,Y                   ; IDX 6B xb [ff|ee ff]: 9-bit negative
        STAB    255,SP                  ; IDX 6B xb [ff|ee ff]: 9-bit max
        STAB    -256,X                  ; IDX 6B xb [ff|ee ff]: 9-bit min
        STAB    256,Y                   ; IDX 6B xb [ff|ee ff]: 16-bit (just outside 9-bit)
        STAB    $8000,X                 ; IDX 6B xb [ff|ee ff]: 16-bit large
        STAB    [$1234,X]               ; IDX 6B xb [ff|ee ff]: indexed indirect 16-bit
        STAB    [D,SP]                  ; IDX 6B xb [ff|ee ff]: accumulator D indirect
        STAB    $1234                   ; EXT 7B hh ll
        STAB    >$40                    ; EXT 7B hh ll (forced extended)
        STD     $40                     ; DIR 5C dd
        STD     5,X                     ; IDX 6C xb [ff|ee ff]: 5-bit constant offset
        STD     -16,Y                   ; IDX 6C xb [ff|ee ff]: 5-bit, most negative
        STD     15,SP                   ; IDX 6C xb [ff|ee ff]: 5-bit, most positive
        STD     0,PC                    ; IDX 6C xb [ff|ee ff]: 5-bit, PC literal
        STD     A,X                     ; IDX 6C xb [ff|ee ff]: accumulator A offset
        STD     B,Y                     ; IDX 6C xb [ff|ee ff]: accumulator B offset
        STD     D,SP                    ; IDX 6C xb [ff|ee ff]: accumulator D offset
        STD     1,+X                    ; IDX 6C xb [ff|ee ff]: pre-increment
        STD     8,-Y                    ; IDX 6C xb [ff|ee ff]: pre-decrement
        STD     2,SP+                   ; IDX 6C xb [ff|ee ff]: post-increment
        STD     7,X-                    ; IDX 6C xb [ff|ee ff]: post-decrement
        STD     16,X                    ; IDX 6C xb [ff|ee ff]: 9-bit (just outside 5-bit)
        STD     -17,Y                   ; IDX 6C xb [ff|ee ff]: 9-bit negative
        STD     255,SP                  ; IDX 6C xb [ff|ee ff]: 9-bit max
        STD     -256,X                  ; IDX 6C xb [ff|ee ff]: 9-bit min
        STD     256,Y                   ; IDX 6C xb [ff|ee ff]: 16-bit (just outside 9-bit)
        STD     $8000,X                 ; IDX 6C xb [ff|ee ff]: 16-bit large
        STD     [$1234,X]               ; IDX 6C xb [ff|ee ff]: indexed indirect 16-bit
        STD     [D,SP]                  ; IDX 6C xb [ff|ee ff]: accumulator D indirect
        STD     $1234                   ; EXT 7C hh ll
        STD     >$40                    ; EXT 7C hh ll (forced extended)
        STY     $40                     ; DIR 5D dd
        STY     5,X                     ; IDX 6D xb [ff|ee ff]: 5-bit constant offset
        STY     -16,Y                   ; IDX 6D xb [ff|ee ff]: 5-bit, most negative
        STY     15,SP                   ; IDX 6D xb [ff|ee ff]: 5-bit, most positive
        STY     0,PC                    ; IDX 6D xb [ff|ee ff]: 5-bit, PC literal
        STY     A,X                     ; IDX 6D xb [ff|ee ff]: accumulator A offset
        STY     B,Y                     ; IDX 6D xb [ff|ee ff]: accumulator B offset
        STY     D,SP                    ; IDX 6D xb [ff|ee ff]: accumulator D offset
        STY     1,+X                    ; IDX 6D xb [ff|ee ff]: pre-increment
        STY     8,-Y                    ; IDX 6D xb [ff|ee ff]: pre-decrement
        STY     2,SP+                   ; IDX 6D xb [ff|ee ff]: post-increment
        STY     7,X-                    ; IDX 6D xb [ff|ee ff]: post-decrement
        STY     16,X                    ; IDX 6D xb [ff|ee ff]: 9-bit (just outside 5-bit)
        STY     -17,Y                   ; IDX 6D xb [ff|ee ff]: 9-bit negative
        STY     255,SP                  ; IDX 6D xb [ff|ee ff]: 9-bit max
        STY     -256,X                  ; IDX 6D xb [ff|ee ff]: 9-bit min
        STY     256,Y                   ; IDX 6D xb [ff|ee ff]: 16-bit (just outside 9-bit)
        STY     $8000,X                 ; IDX 6D xb [ff|ee ff]: 16-bit large
        STY     [$1234,X]               ; IDX 6D xb [ff|ee ff]: indexed indirect 16-bit
        STY     [D,SP]                  ; IDX 6D xb [ff|ee ff]: accumulator D indirect
        STY     $1234                   ; EXT 7D hh ll
        STY     >$40                    ; EXT 7D hh ll (forced extended)
        STX     $40                     ; DIR 5E dd
        STX     5,X                     ; IDX 6E xb [ff|ee ff]: 5-bit constant offset
        STX     -16,Y                   ; IDX 6E xb [ff|ee ff]: 5-bit, most negative
        STX     15,SP                   ; IDX 6E xb [ff|ee ff]: 5-bit, most positive
        STX     0,PC                    ; IDX 6E xb [ff|ee ff]: 5-bit, PC literal
        STX     A,X                     ; IDX 6E xb [ff|ee ff]: accumulator A offset
        STX     B,Y                     ; IDX 6E xb [ff|ee ff]: accumulator B offset
        STX     D,SP                    ; IDX 6E xb [ff|ee ff]: accumulator D offset
        STX     1,+X                    ; IDX 6E xb [ff|ee ff]: pre-increment
        STX     8,-Y                    ; IDX 6E xb [ff|ee ff]: pre-decrement
        STX     2,SP+                   ; IDX 6E xb [ff|ee ff]: post-increment
        STX     7,X-                    ; IDX 6E xb [ff|ee ff]: post-decrement
        STX     16,X                    ; IDX 6E xb [ff|ee ff]: 9-bit (just outside 5-bit)
        STX     -17,Y                   ; IDX 6E xb [ff|ee ff]: 9-bit negative
        STX     255,SP                  ; IDX 6E xb [ff|ee ff]: 9-bit max
        STX     -256,X                  ; IDX 6E xb [ff|ee ff]: 9-bit min
        STX     256,Y                   ; IDX 6E xb [ff|ee ff]: 16-bit (just outside 9-bit)
        STX     $8000,X                 ; IDX 6E xb [ff|ee ff]: 16-bit large
        STX     [$1234,X]               ; IDX 6E xb [ff|ee ff]: indexed indirect 16-bit
        STX     [D,SP]                  ; IDX 6E xb [ff|ee ff]: accumulator D indirect
        STX     $1234                   ; EXT 7E hh ll
        STX     >$40                    ; EXT 7E hh ll (forced extended)
        STS     $40                     ; DIR 5F dd
        STS     5,X                     ; IDX 6F xb [ff|ee ff]: 5-bit constant offset
        STS     -16,Y                   ; IDX 6F xb [ff|ee ff]: 5-bit, most negative
        STS     15,SP                   ; IDX 6F xb [ff|ee ff]: 5-bit, most positive
        STS     0,PC                    ; IDX 6F xb [ff|ee ff]: 5-bit, PC literal
        STS     A,X                     ; IDX 6F xb [ff|ee ff]: accumulator A offset
        STS     B,Y                     ; IDX 6F xb [ff|ee ff]: accumulator B offset
        STS     D,SP                    ; IDX 6F xb [ff|ee ff]: accumulator D offset
        STS     1,+X                    ; IDX 6F xb [ff|ee ff]: pre-increment
        STS     8,-Y                    ; IDX 6F xb [ff|ee ff]: pre-decrement
        STS     2,SP+                   ; IDX 6F xb [ff|ee ff]: post-increment
        STS     7,X-                    ; IDX 6F xb [ff|ee ff]: post-decrement
        STS     16,X                    ; IDX 6F xb [ff|ee ff]: 9-bit (just outside 5-bit)
        STS     -17,Y                   ; IDX 6F xb [ff|ee ff]: 9-bit negative
        STS     255,SP                  ; IDX 6F xb [ff|ee ff]: 9-bit max
        STS     -256,X                  ; IDX 6F xb [ff|ee ff]: 9-bit min
        STS     256,Y                   ; IDX 6F xb [ff|ee ff]: 16-bit (just outside 9-bit)
        STS     $8000,X                 ; IDX 6F xb [ff|ee ff]: 16-bit large
        STS     [$1234,X]               ; IDX 6F xb [ff|ee ff]: indexed indirect 16-bit
        STS     [D,SP]                  ; IDX 6F xb [ff|ee ff]: accumulator D indirect
        STS     $1234                   ; EXT 7F hh ll
        STS     >$40                    ; EXT 7F hh ll (forced extended)
        CLR     5,X                     ; IDX 69 xb [ff|ee ff]: 5-bit constant offset
        CLR     -16,Y                   ; IDX 69 xb [ff|ee ff]: 5-bit, most negative
        CLR     15,SP                   ; IDX 69 xb [ff|ee ff]: 5-bit, most positive
        CLR     0,PC                    ; IDX 69 xb [ff|ee ff]: 5-bit, PC literal
        CLR     A,X                     ; IDX 69 xb [ff|ee ff]: accumulator A offset
        CLR     B,Y                     ; IDX 69 xb [ff|ee ff]: accumulator B offset
        CLR     D,SP                    ; IDX 69 xb [ff|ee ff]: accumulator D offset
        CLR     1,+X                    ; IDX 69 xb [ff|ee ff]: pre-increment
        CLR     8,-Y                    ; IDX 69 xb [ff|ee ff]: pre-decrement
        CLR     2,SP+                   ; IDX 69 xb [ff|ee ff]: post-increment
        CLR     7,X-                    ; IDX 69 xb [ff|ee ff]: post-decrement
        CLR     16,X                    ; IDX 69 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        CLR     -17,Y                   ; IDX 69 xb [ff|ee ff]: 9-bit negative
        CLR     255,SP                  ; IDX 69 xb [ff|ee ff]: 9-bit max
        CLR     -256,X                  ; IDX 69 xb [ff|ee ff]: 9-bit min
        CLR     256,Y                   ; IDX 69 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        CLR     $8000,X                 ; IDX 69 xb [ff|ee ff]: 16-bit large
        CLR     [$1234,X]               ; IDX 69 xb [ff|ee ff]: indexed indirect 16-bit
        CLR     [D,SP]                  ; IDX 69 xb [ff|ee ff]: accumulator D indirect
        CLR     $1234                   ; EXT 79 hh ll
        CLR     >$40                    ; EXT 79 hh ll (forced extended)
        SUBA    #$5A                    ; IMM8 80 ii
        SUBA    $40                     ; DIR 90 dd
        SUBA    5,X                     ; IDX A0 xb [ff|ee ff]: 5-bit constant offset
        SUBA    -16,Y                   ; IDX A0 xb [ff|ee ff]: 5-bit, most negative
        SUBA    15,SP                   ; IDX A0 xb [ff|ee ff]: 5-bit, most positive
        SUBA    0,PC                    ; IDX A0 xb [ff|ee ff]: 5-bit, PC literal
        SUBA    A,X                     ; IDX A0 xb [ff|ee ff]: accumulator A offset
        SUBA    B,Y                     ; IDX A0 xb [ff|ee ff]: accumulator B offset
        SUBA    D,SP                    ; IDX A0 xb [ff|ee ff]: accumulator D offset
        SUBA    1,+X                    ; IDX A0 xb [ff|ee ff]: pre-increment
        SUBA    8,-Y                    ; IDX A0 xb [ff|ee ff]: pre-decrement
        SUBA    2,SP+                   ; IDX A0 xb [ff|ee ff]: post-increment
        SUBA    7,X-                    ; IDX A0 xb [ff|ee ff]: post-decrement
        SUBA    16,X                    ; IDX A0 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        SUBA    -17,Y                   ; IDX A0 xb [ff|ee ff]: 9-bit negative
        SUBA    255,SP                  ; IDX A0 xb [ff|ee ff]: 9-bit max
        SUBA    -256,X                  ; IDX A0 xb [ff|ee ff]: 9-bit min
        SUBA    256,Y                   ; IDX A0 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        SUBA    $8000,X                 ; IDX A0 xb [ff|ee ff]: 16-bit large
        SUBA    [$1234,X]               ; IDX A0 xb [ff|ee ff]: indexed indirect 16-bit
        SUBA    [D,SP]                  ; IDX A0 xb [ff|ee ff]: accumulator D indirect
        SUBA    $1234                   ; EXT B0 hh ll
        SUBA    >$40                    ; EXT B0 hh ll (forced extended)
        CMPA    #$5A                    ; IMM8 81 ii
        CMPA    $40                     ; DIR 91 dd
        CMPA    5,X                     ; IDX A1 xb [ff|ee ff]: 5-bit constant offset
        CMPA    -16,Y                   ; IDX A1 xb [ff|ee ff]: 5-bit, most negative
        CMPA    15,SP                   ; IDX A1 xb [ff|ee ff]: 5-bit, most positive
        CMPA    0,PC                    ; IDX A1 xb [ff|ee ff]: 5-bit, PC literal
        CMPA    A,X                     ; IDX A1 xb [ff|ee ff]: accumulator A offset
        CMPA    B,Y                     ; IDX A1 xb [ff|ee ff]: accumulator B offset
        CMPA    D,SP                    ; IDX A1 xb [ff|ee ff]: accumulator D offset
        CMPA    1,+X                    ; IDX A1 xb [ff|ee ff]: pre-increment
        CMPA    8,-Y                    ; IDX A1 xb [ff|ee ff]: pre-decrement
        CMPA    2,SP+                   ; IDX A1 xb [ff|ee ff]: post-increment
        CMPA    7,X-                    ; IDX A1 xb [ff|ee ff]: post-decrement
        CMPA    16,X                    ; IDX A1 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        CMPA    -17,Y                   ; IDX A1 xb [ff|ee ff]: 9-bit negative
        CMPA    255,SP                  ; IDX A1 xb [ff|ee ff]: 9-bit max
        CMPA    -256,X                  ; IDX A1 xb [ff|ee ff]: 9-bit min
        CMPA    256,Y                   ; IDX A1 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        CMPA    $8000,X                 ; IDX A1 xb [ff|ee ff]: 16-bit large
        CMPA    [$1234,X]               ; IDX A1 xb [ff|ee ff]: indexed indirect 16-bit
        CMPA    [D,SP]                  ; IDX A1 xb [ff|ee ff]: accumulator D indirect
        CMPA    $1234                   ; EXT B1 hh ll
        CMPA    >$40                    ; EXT B1 hh ll (forced extended)
        SBCA    #$5A                    ; IMM8 82 ii
        SBCA    $40                     ; DIR 92 dd
        SBCA    5,X                     ; IDX A2 xb [ff|ee ff]: 5-bit constant offset
        SBCA    -16,Y                   ; IDX A2 xb [ff|ee ff]: 5-bit, most negative
        SBCA    15,SP                   ; IDX A2 xb [ff|ee ff]: 5-bit, most positive
        SBCA    0,PC                    ; IDX A2 xb [ff|ee ff]: 5-bit, PC literal
        SBCA    A,X                     ; IDX A2 xb [ff|ee ff]: accumulator A offset
        SBCA    B,Y                     ; IDX A2 xb [ff|ee ff]: accumulator B offset
        SBCA    D,SP                    ; IDX A2 xb [ff|ee ff]: accumulator D offset
        SBCA    1,+X                    ; IDX A2 xb [ff|ee ff]: pre-increment
        SBCA    8,-Y                    ; IDX A2 xb [ff|ee ff]: pre-decrement
        SBCA    2,SP+                   ; IDX A2 xb [ff|ee ff]: post-increment
        SBCA    7,X-                    ; IDX A2 xb [ff|ee ff]: post-decrement
        SBCA    16,X                    ; IDX A2 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        SBCA    -17,Y                   ; IDX A2 xb [ff|ee ff]: 9-bit negative
        SBCA    255,SP                  ; IDX A2 xb [ff|ee ff]: 9-bit max
        SBCA    -256,X                  ; IDX A2 xb [ff|ee ff]: 9-bit min
        SBCA    256,Y                   ; IDX A2 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        SBCA    $8000,X                 ; IDX A2 xb [ff|ee ff]: 16-bit large
        SBCA    [$1234,X]               ; IDX A2 xb [ff|ee ff]: indexed indirect 16-bit
        SBCA    [D,SP]                  ; IDX A2 xb [ff|ee ff]: accumulator D indirect
        SBCA    $1234                   ; EXT B2 hh ll
        SBCA    >$40                    ; EXT B2 hh ll (forced extended)
        SUBD    #$1234                  ; IMM16 83 jj kk
        SUBD    $40                     ; DIR 93 dd
        SUBD    5,X                     ; IDX A3 xb [ff|ee ff]: 5-bit constant offset
        SUBD    -16,Y                   ; IDX A3 xb [ff|ee ff]: 5-bit, most negative
        SUBD    15,SP                   ; IDX A3 xb [ff|ee ff]: 5-bit, most positive
        SUBD    0,PC                    ; IDX A3 xb [ff|ee ff]: 5-bit, PC literal
        SUBD    A,X                     ; IDX A3 xb [ff|ee ff]: accumulator A offset
        SUBD    B,Y                     ; IDX A3 xb [ff|ee ff]: accumulator B offset
        SUBD    D,SP                    ; IDX A3 xb [ff|ee ff]: accumulator D offset
        SUBD    1,+X                    ; IDX A3 xb [ff|ee ff]: pre-increment
        SUBD    8,-Y                    ; IDX A3 xb [ff|ee ff]: pre-decrement
        SUBD    2,SP+                   ; IDX A3 xb [ff|ee ff]: post-increment
        SUBD    7,X-                    ; IDX A3 xb [ff|ee ff]: post-decrement
        SUBD    16,X                    ; IDX A3 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        SUBD    -17,Y                   ; IDX A3 xb [ff|ee ff]: 9-bit negative
        SUBD    255,SP                  ; IDX A3 xb [ff|ee ff]: 9-bit max
        SUBD    -256,X                  ; IDX A3 xb [ff|ee ff]: 9-bit min
        SUBD    256,Y                   ; IDX A3 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        SUBD    $8000,X                 ; IDX A3 xb [ff|ee ff]: 16-bit large
        SUBD    [$1234,X]               ; IDX A3 xb [ff|ee ff]: indexed indirect 16-bit
        SUBD    [D,SP]                  ; IDX A3 xb [ff|ee ff]: accumulator D indirect
        SUBD    $1234                   ; EXT B3 hh ll
        SUBD    >$40                    ; EXT B3 hh ll (forced extended)
        ANDA    #$5A                    ; IMM8 84 ii
        ANDA    $40                     ; DIR 94 dd
        ANDA    5,X                     ; IDX A4 xb [ff|ee ff]: 5-bit constant offset
        ANDA    -16,Y                   ; IDX A4 xb [ff|ee ff]: 5-bit, most negative
        ANDA    15,SP                   ; IDX A4 xb [ff|ee ff]: 5-bit, most positive
        ANDA    0,PC                    ; IDX A4 xb [ff|ee ff]: 5-bit, PC literal
        ANDA    A,X                     ; IDX A4 xb [ff|ee ff]: accumulator A offset
        ANDA    B,Y                     ; IDX A4 xb [ff|ee ff]: accumulator B offset
        ANDA    D,SP                    ; IDX A4 xb [ff|ee ff]: accumulator D offset
        ANDA    1,+X                    ; IDX A4 xb [ff|ee ff]: pre-increment
        ANDA    8,-Y                    ; IDX A4 xb [ff|ee ff]: pre-decrement
        ANDA    2,SP+                   ; IDX A4 xb [ff|ee ff]: post-increment
        ANDA    7,X-                    ; IDX A4 xb [ff|ee ff]: post-decrement
        ANDA    16,X                    ; IDX A4 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        ANDA    -17,Y                   ; IDX A4 xb [ff|ee ff]: 9-bit negative
        ANDA    255,SP                  ; IDX A4 xb [ff|ee ff]: 9-bit max
        ANDA    -256,X                  ; IDX A4 xb [ff|ee ff]: 9-bit min
        ANDA    256,Y                   ; IDX A4 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        ANDA    $8000,X                 ; IDX A4 xb [ff|ee ff]: 16-bit large
        ANDA    [$1234,X]               ; IDX A4 xb [ff|ee ff]: indexed indirect 16-bit
        ANDA    [D,SP]                  ; IDX A4 xb [ff|ee ff]: accumulator D indirect
        ANDA    $1234                   ; EXT B4 hh ll
        ANDA    >$40                    ; EXT B4 hh ll (forced extended)
        BITA    #$5A                    ; IMM8 85 ii
        BITA    $40                     ; DIR 95 dd
        BITA    5,X                     ; IDX A5 xb [ff|ee ff]: 5-bit constant offset
        BITA    -16,Y                   ; IDX A5 xb [ff|ee ff]: 5-bit, most negative
        BITA    15,SP                   ; IDX A5 xb [ff|ee ff]: 5-bit, most positive
        BITA    0,PC                    ; IDX A5 xb [ff|ee ff]: 5-bit, PC literal
        BITA    A,X                     ; IDX A5 xb [ff|ee ff]: accumulator A offset
        BITA    B,Y                     ; IDX A5 xb [ff|ee ff]: accumulator B offset
        BITA    D,SP                    ; IDX A5 xb [ff|ee ff]: accumulator D offset
        BITA    1,+X                    ; IDX A5 xb [ff|ee ff]: pre-increment
        BITA    8,-Y                    ; IDX A5 xb [ff|ee ff]: pre-decrement
        BITA    2,SP+                   ; IDX A5 xb [ff|ee ff]: post-increment
        BITA    7,X-                    ; IDX A5 xb [ff|ee ff]: post-decrement
        BITA    16,X                    ; IDX A5 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        BITA    -17,Y                   ; IDX A5 xb [ff|ee ff]: 9-bit negative
        BITA    255,SP                  ; IDX A5 xb [ff|ee ff]: 9-bit max
        BITA    -256,X                  ; IDX A5 xb [ff|ee ff]: 9-bit min
        BITA    256,Y                   ; IDX A5 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        BITA    $8000,X                 ; IDX A5 xb [ff|ee ff]: 16-bit large
        BITA    [$1234,X]               ; IDX A5 xb [ff|ee ff]: indexed indirect 16-bit
        BITA    [D,SP]                  ; IDX A5 xb [ff|ee ff]: accumulator D indirect
        BITA    $1234                   ; EXT B5 hh ll
        BITA    >$40                    ; EXT B5 hh ll (forced extended)
        LDAA    #$5A                    ; IMM8 86 ii
        LDAA    $40                     ; DIR 96 dd
        LDAA    5,X                     ; IDX A6 xb [ff|ee ff]: 5-bit constant offset
        LDAA    -16,Y                   ; IDX A6 xb [ff|ee ff]: 5-bit, most negative
        LDAA    15,SP                   ; IDX A6 xb [ff|ee ff]: 5-bit, most positive
        LDAA    0,PC                    ; IDX A6 xb [ff|ee ff]: 5-bit, PC literal
        LDAA    A,X                     ; IDX A6 xb [ff|ee ff]: accumulator A offset
        LDAA    B,Y                     ; IDX A6 xb [ff|ee ff]: accumulator B offset
        LDAA    D,SP                    ; IDX A6 xb [ff|ee ff]: accumulator D offset
        LDAA    1,+X                    ; IDX A6 xb [ff|ee ff]: pre-increment
        LDAA    8,-Y                    ; IDX A6 xb [ff|ee ff]: pre-decrement
        LDAA    2,SP+                   ; IDX A6 xb [ff|ee ff]: post-increment
        LDAA    7,X-                    ; IDX A6 xb [ff|ee ff]: post-decrement
        LDAA    16,X                    ; IDX A6 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        LDAA    -17,Y                   ; IDX A6 xb [ff|ee ff]: 9-bit negative
        LDAA    255,SP                  ; IDX A6 xb [ff|ee ff]: 9-bit max
        LDAA    -256,X                  ; IDX A6 xb [ff|ee ff]: 9-bit min
        LDAA    256,Y                   ; IDX A6 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        LDAA    $8000,X                 ; IDX A6 xb [ff|ee ff]: 16-bit large
        LDAA    [$1234,X]               ; IDX A6 xb [ff|ee ff]: indexed indirect 16-bit
        LDAA    [D,SP]                  ; IDX A6 xb [ff|ee ff]: accumulator D indirect
        LDAA    $1234                   ; EXT B6 hh ll
        LDAA    >$40                    ; EXT B6 hh ll (forced extended)
        EORA    #$5A                    ; IMM8 88 ii
        EORA    $40                     ; DIR 98 dd
        EORA    5,X                     ; IDX A8 xb [ff|ee ff]: 5-bit constant offset
        EORA    -16,Y                   ; IDX A8 xb [ff|ee ff]: 5-bit, most negative
        EORA    15,SP                   ; IDX A8 xb [ff|ee ff]: 5-bit, most positive
        EORA    0,PC                    ; IDX A8 xb [ff|ee ff]: 5-bit, PC literal
        EORA    A,X                     ; IDX A8 xb [ff|ee ff]: accumulator A offset
        EORA    B,Y                     ; IDX A8 xb [ff|ee ff]: accumulator B offset
        EORA    D,SP                    ; IDX A8 xb [ff|ee ff]: accumulator D offset
        EORA    1,+X                    ; IDX A8 xb [ff|ee ff]: pre-increment
        EORA    8,-Y                    ; IDX A8 xb [ff|ee ff]: pre-decrement
        EORA    2,SP+                   ; IDX A8 xb [ff|ee ff]: post-increment
        EORA    7,X-                    ; IDX A8 xb [ff|ee ff]: post-decrement
        EORA    16,X                    ; IDX A8 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        EORA    -17,Y                   ; IDX A8 xb [ff|ee ff]: 9-bit negative
        EORA    255,SP                  ; IDX A8 xb [ff|ee ff]: 9-bit max
        EORA    -256,X                  ; IDX A8 xb [ff|ee ff]: 9-bit min
        EORA    256,Y                   ; IDX A8 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        EORA    $8000,X                 ; IDX A8 xb [ff|ee ff]: 16-bit large
        EORA    [$1234,X]               ; IDX A8 xb [ff|ee ff]: indexed indirect 16-bit
        EORA    [D,SP]                  ; IDX A8 xb [ff|ee ff]: accumulator D indirect
        EORA    $1234                   ; EXT B8 hh ll
        EORA    >$40                    ; EXT B8 hh ll (forced extended)
        ADCA    #$5A                    ; IMM8 89 ii
        ADCA    $40                     ; DIR 99 dd
        ADCA    5,X                     ; IDX A9 xb [ff|ee ff]: 5-bit constant offset
        ADCA    -16,Y                   ; IDX A9 xb [ff|ee ff]: 5-bit, most negative
        ADCA    15,SP                   ; IDX A9 xb [ff|ee ff]: 5-bit, most positive
        ADCA    0,PC                    ; IDX A9 xb [ff|ee ff]: 5-bit, PC literal
        ADCA    A,X                     ; IDX A9 xb [ff|ee ff]: accumulator A offset
        ADCA    B,Y                     ; IDX A9 xb [ff|ee ff]: accumulator B offset
        ADCA    D,SP                    ; IDX A9 xb [ff|ee ff]: accumulator D offset
        ADCA    1,+X                    ; IDX A9 xb [ff|ee ff]: pre-increment
        ADCA    8,-Y                    ; IDX A9 xb [ff|ee ff]: pre-decrement
        ADCA    2,SP+                   ; IDX A9 xb [ff|ee ff]: post-increment
        ADCA    7,X-                    ; IDX A9 xb [ff|ee ff]: post-decrement
        ADCA    16,X                    ; IDX A9 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        ADCA    -17,Y                   ; IDX A9 xb [ff|ee ff]: 9-bit negative
        ADCA    255,SP                  ; IDX A9 xb [ff|ee ff]: 9-bit max
        ADCA    -256,X                  ; IDX A9 xb [ff|ee ff]: 9-bit min
        ADCA    256,Y                   ; IDX A9 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        ADCA    $8000,X                 ; IDX A9 xb [ff|ee ff]: 16-bit large
        ADCA    [$1234,X]               ; IDX A9 xb [ff|ee ff]: indexed indirect 16-bit
        ADCA    [D,SP]                  ; IDX A9 xb [ff|ee ff]: accumulator D indirect
        ADCA    $1234                   ; EXT B9 hh ll
        ADCA    >$40                    ; EXT B9 hh ll (forced extended)
        ORAA    #$5A                    ; IMM8 8A ii
        ORAA    $40                     ; DIR 9A dd
        ORAA    5,X                     ; IDX AA xb [ff|ee ff]: 5-bit constant offset
        ORAA    -16,Y                   ; IDX AA xb [ff|ee ff]: 5-bit, most negative
        ORAA    15,SP                   ; IDX AA xb [ff|ee ff]: 5-bit, most positive
        ORAA    0,PC                    ; IDX AA xb [ff|ee ff]: 5-bit, PC literal
        ORAA    A,X                     ; IDX AA xb [ff|ee ff]: accumulator A offset
        ORAA    B,Y                     ; IDX AA xb [ff|ee ff]: accumulator B offset
        ORAA    D,SP                    ; IDX AA xb [ff|ee ff]: accumulator D offset
        ORAA    1,+X                    ; IDX AA xb [ff|ee ff]: pre-increment
        ORAA    8,-Y                    ; IDX AA xb [ff|ee ff]: pre-decrement
        ORAA    2,SP+                   ; IDX AA xb [ff|ee ff]: post-increment
        ORAA    7,X-                    ; IDX AA xb [ff|ee ff]: post-decrement
        ORAA    16,X                    ; IDX AA xb [ff|ee ff]: 9-bit (just outside 5-bit)
        ORAA    -17,Y                   ; IDX AA xb [ff|ee ff]: 9-bit negative
        ORAA    255,SP                  ; IDX AA xb [ff|ee ff]: 9-bit max
        ORAA    -256,X                  ; IDX AA xb [ff|ee ff]: 9-bit min
        ORAA    256,Y                   ; IDX AA xb [ff|ee ff]: 16-bit (just outside 9-bit)
        ORAA    $8000,X                 ; IDX AA xb [ff|ee ff]: 16-bit large
        ORAA    [$1234,X]               ; IDX AA xb [ff|ee ff]: indexed indirect 16-bit
        ORAA    [D,SP]                  ; IDX AA xb [ff|ee ff]: accumulator D indirect
        ORAA    $1234                   ; EXT BA hh ll
        ORAA    >$40                    ; EXT BA hh ll (forced extended)
        ADDA    #$5A                    ; IMM8 8B ii
        ADDA    $40                     ; DIR 9B dd
        ADDA    5,X                     ; IDX AB xb [ff|ee ff]: 5-bit constant offset
        ADDA    -16,Y                   ; IDX AB xb [ff|ee ff]: 5-bit, most negative
        ADDA    15,SP                   ; IDX AB xb [ff|ee ff]: 5-bit, most positive
        ADDA    0,PC                    ; IDX AB xb [ff|ee ff]: 5-bit, PC literal
        ADDA    A,X                     ; IDX AB xb [ff|ee ff]: accumulator A offset
        ADDA    B,Y                     ; IDX AB xb [ff|ee ff]: accumulator B offset
        ADDA    D,SP                    ; IDX AB xb [ff|ee ff]: accumulator D offset
        ADDA    1,+X                    ; IDX AB xb [ff|ee ff]: pre-increment
        ADDA    8,-Y                    ; IDX AB xb [ff|ee ff]: pre-decrement
        ADDA    2,SP+                   ; IDX AB xb [ff|ee ff]: post-increment
        ADDA    7,X-                    ; IDX AB xb [ff|ee ff]: post-decrement
        ADDA    16,X                    ; IDX AB xb [ff|ee ff]: 9-bit (just outside 5-bit)
        ADDA    -17,Y                   ; IDX AB xb [ff|ee ff]: 9-bit negative
        ADDA    255,SP                  ; IDX AB xb [ff|ee ff]: 9-bit max
        ADDA    -256,X                  ; IDX AB xb [ff|ee ff]: 9-bit min
        ADDA    256,Y                   ; IDX AB xb [ff|ee ff]: 16-bit (just outside 9-bit)
        ADDA    $8000,X                 ; IDX AB xb [ff|ee ff]: 16-bit large
        ADDA    [$1234,X]               ; IDX AB xb [ff|ee ff]: indexed indirect 16-bit
        ADDA    [D,SP]                  ; IDX AB xb [ff|ee ff]: accumulator D indirect
        ADDA    $1234                   ; EXT BB hh ll
        ADDA    >$40                    ; EXT BB hh ll (forced extended)
        CPD     #$1234                  ; IMM16 8C jj kk
        CPD     $40                     ; DIR 9C dd
        CPD     5,X                     ; IDX AC xb [ff|ee ff]: 5-bit constant offset
        CPD     -16,Y                   ; IDX AC xb [ff|ee ff]: 5-bit, most negative
        CPD     15,SP                   ; IDX AC xb [ff|ee ff]: 5-bit, most positive
        CPD     0,PC                    ; IDX AC xb [ff|ee ff]: 5-bit, PC literal
        CPD     A,X                     ; IDX AC xb [ff|ee ff]: accumulator A offset
        CPD     B,Y                     ; IDX AC xb [ff|ee ff]: accumulator B offset
        CPD     D,SP                    ; IDX AC xb [ff|ee ff]: accumulator D offset
        CPD     1,+X                    ; IDX AC xb [ff|ee ff]: pre-increment
        CPD     8,-Y                    ; IDX AC xb [ff|ee ff]: pre-decrement
        CPD     2,SP+                   ; IDX AC xb [ff|ee ff]: post-increment
        CPD     7,X-                    ; IDX AC xb [ff|ee ff]: post-decrement
        CPD     16,X                    ; IDX AC xb [ff|ee ff]: 9-bit (just outside 5-bit)
        CPD     -17,Y                   ; IDX AC xb [ff|ee ff]: 9-bit negative
        CPD     255,SP                  ; IDX AC xb [ff|ee ff]: 9-bit max
        CPD     -256,X                  ; IDX AC xb [ff|ee ff]: 9-bit min
        CPD     256,Y                   ; IDX AC xb [ff|ee ff]: 16-bit (just outside 9-bit)
        CPD     $8000,X                 ; IDX AC xb [ff|ee ff]: 16-bit large
        CPD     [$1234,X]               ; IDX AC xb [ff|ee ff]: indexed indirect 16-bit
        CPD     [D,SP]                  ; IDX AC xb [ff|ee ff]: accumulator D indirect
        CPD     $1234                   ; EXT BC hh ll
        CPD     >$40                    ; EXT BC hh ll (forced extended)
        CPY     #$1234                  ; IMM16 8D jj kk
        CPY     $40                     ; DIR 9D dd
        CPY     5,X                     ; IDX AD xb [ff|ee ff]: 5-bit constant offset
        CPY     -16,Y                   ; IDX AD xb [ff|ee ff]: 5-bit, most negative
        CPY     15,SP                   ; IDX AD xb [ff|ee ff]: 5-bit, most positive
        CPY     0,PC                    ; IDX AD xb [ff|ee ff]: 5-bit, PC literal
        CPY     A,X                     ; IDX AD xb [ff|ee ff]: accumulator A offset
        CPY     B,Y                     ; IDX AD xb [ff|ee ff]: accumulator B offset
        CPY     D,SP                    ; IDX AD xb [ff|ee ff]: accumulator D offset
        CPY     1,+X                    ; IDX AD xb [ff|ee ff]: pre-increment
        CPY     8,-Y                    ; IDX AD xb [ff|ee ff]: pre-decrement
        CPY     2,SP+                   ; IDX AD xb [ff|ee ff]: post-increment
        CPY     7,X-                    ; IDX AD xb [ff|ee ff]: post-decrement
        CPY     16,X                    ; IDX AD xb [ff|ee ff]: 9-bit (just outside 5-bit)
        CPY     -17,Y                   ; IDX AD xb [ff|ee ff]: 9-bit negative
        CPY     255,SP                  ; IDX AD xb [ff|ee ff]: 9-bit max
        CPY     -256,X                  ; IDX AD xb [ff|ee ff]: 9-bit min
        CPY     256,Y                   ; IDX AD xb [ff|ee ff]: 16-bit (just outside 9-bit)
        CPY     $8000,X                 ; IDX AD xb [ff|ee ff]: 16-bit large
        CPY     [$1234,X]               ; IDX AD xb [ff|ee ff]: indexed indirect 16-bit
        CPY     [D,SP]                  ; IDX AD xb [ff|ee ff]: accumulator D indirect
        CPY     $1234                   ; EXT BD hh ll
        CPY     >$40                    ; EXT BD hh ll (forced extended)
        CPX     #$1234                  ; IMM16 8E jj kk
        CPX     $40                     ; DIR 9E dd
        CPX     5,X                     ; IDX AE xb [ff|ee ff]: 5-bit constant offset
        CPX     -16,Y                   ; IDX AE xb [ff|ee ff]: 5-bit, most negative
        CPX     15,SP                   ; IDX AE xb [ff|ee ff]: 5-bit, most positive
        CPX     0,PC                    ; IDX AE xb [ff|ee ff]: 5-bit, PC literal
        CPX     A,X                     ; IDX AE xb [ff|ee ff]: accumulator A offset
        CPX     B,Y                     ; IDX AE xb [ff|ee ff]: accumulator B offset
        CPX     D,SP                    ; IDX AE xb [ff|ee ff]: accumulator D offset
        CPX     1,+X                    ; IDX AE xb [ff|ee ff]: pre-increment
        CPX     8,-Y                    ; IDX AE xb [ff|ee ff]: pre-decrement
        CPX     2,SP+                   ; IDX AE xb [ff|ee ff]: post-increment
        CPX     7,X-                    ; IDX AE xb [ff|ee ff]: post-decrement
        CPX     16,X                    ; IDX AE xb [ff|ee ff]: 9-bit (just outside 5-bit)
        CPX     -17,Y                   ; IDX AE xb [ff|ee ff]: 9-bit negative
        CPX     255,SP                  ; IDX AE xb [ff|ee ff]: 9-bit max
        CPX     -256,X                  ; IDX AE xb [ff|ee ff]: 9-bit min
        CPX     256,Y                   ; IDX AE xb [ff|ee ff]: 16-bit (just outside 9-bit)
        CPX     $8000,X                 ; IDX AE xb [ff|ee ff]: 16-bit large
        CPX     [$1234,X]               ; IDX AE xb [ff|ee ff]: indexed indirect 16-bit
        CPX     [D,SP]                  ; IDX AE xb [ff|ee ff]: accumulator D indirect
        CPX     $1234                   ; EXT BE hh ll
        CPX     >$40                    ; EXT BE hh ll (forced extended)
        CPS     #$1234                  ; IMM16 8F jj kk
        CPS     $40                     ; DIR 9F dd
        CPS     5,X                     ; IDX AF xb [ff|ee ff]: 5-bit constant offset
        CPS     -16,Y                   ; IDX AF xb [ff|ee ff]: 5-bit, most negative
        CPS     15,SP                   ; IDX AF xb [ff|ee ff]: 5-bit, most positive
        CPS     0,PC                    ; IDX AF xb [ff|ee ff]: 5-bit, PC literal
        CPS     A,X                     ; IDX AF xb [ff|ee ff]: accumulator A offset
        CPS     B,Y                     ; IDX AF xb [ff|ee ff]: accumulator B offset
        CPS     D,SP                    ; IDX AF xb [ff|ee ff]: accumulator D offset
        CPS     1,+X                    ; IDX AF xb [ff|ee ff]: pre-increment
        CPS     8,-Y                    ; IDX AF xb [ff|ee ff]: pre-decrement
        CPS     2,SP+                   ; IDX AF xb [ff|ee ff]: post-increment
        CPS     7,X-                    ; IDX AF xb [ff|ee ff]: post-decrement
        CPS     16,X                    ; IDX AF xb [ff|ee ff]: 9-bit (just outside 5-bit)
        CPS     -17,Y                   ; IDX AF xb [ff|ee ff]: 9-bit negative
        CPS     255,SP                  ; IDX AF xb [ff|ee ff]: 9-bit max
        CPS     -256,X                  ; IDX AF xb [ff|ee ff]: 9-bit min
        CPS     256,Y                   ; IDX AF xb [ff|ee ff]: 16-bit (just outside 9-bit)
        CPS     $8000,X                 ; IDX AF xb [ff|ee ff]: 16-bit large
        CPS     [$1234,X]               ; IDX AF xb [ff|ee ff]: indexed indirect 16-bit
        CPS     [D,SP]                  ; IDX AF xb [ff|ee ff]: accumulator D indirect
        CPS     $1234                   ; EXT BF hh ll
        CPS     >$40                    ; EXT BF hh ll (forced extended)
        SUBB    #$5A                    ; IMM8 C0 ii
        SUBB    $40                     ; DIR D0 dd
        SUBB    5,X                     ; IDX E0 xb [ff|ee ff]: 5-bit constant offset
        SUBB    -16,Y                   ; IDX E0 xb [ff|ee ff]: 5-bit, most negative
        SUBB    15,SP                   ; IDX E0 xb [ff|ee ff]: 5-bit, most positive
        SUBB    0,PC                    ; IDX E0 xb [ff|ee ff]: 5-bit, PC literal
        SUBB    A,X                     ; IDX E0 xb [ff|ee ff]: accumulator A offset
        SUBB    B,Y                     ; IDX E0 xb [ff|ee ff]: accumulator B offset
        SUBB    D,SP                    ; IDX E0 xb [ff|ee ff]: accumulator D offset
        SUBB    1,+X                    ; IDX E0 xb [ff|ee ff]: pre-increment
        SUBB    8,-Y                    ; IDX E0 xb [ff|ee ff]: pre-decrement
        SUBB    2,SP+                   ; IDX E0 xb [ff|ee ff]: post-increment
        SUBB    7,X-                    ; IDX E0 xb [ff|ee ff]: post-decrement
        SUBB    16,X                    ; IDX E0 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        SUBB    -17,Y                   ; IDX E0 xb [ff|ee ff]: 9-bit negative
        SUBB    255,SP                  ; IDX E0 xb [ff|ee ff]: 9-bit max
        SUBB    -256,X                  ; IDX E0 xb [ff|ee ff]: 9-bit min
        SUBB    256,Y                   ; IDX E0 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        SUBB    $8000,X                 ; IDX E0 xb [ff|ee ff]: 16-bit large
        SUBB    [$1234,X]               ; IDX E0 xb [ff|ee ff]: indexed indirect 16-bit
        SUBB    [D,SP]                  ; IDX E0 xb [ff|ee ff]: accumulator D indirect
        SUBB    $1234                   ; EXT F0 hh ll
        SUBB    >$40                    ; EXT F0 hh ll (forced extended)
        CMPB    #$5A                    ; IMM8 C1 ii
        CMPB    $40                     ; DIR D1 dd
        CMPB    5,X                     ; IDX E1 xb [ff|ee ff]: 5-bit constant offset
        CMPB    -16,Y                   ; IDX E1 xb [ff|ee ff]: 5-bit, most negative
        CMPB    15,SP                   ; IDX E1 xb [ff|ee ff]: 5-bit, most positive
        CMPB    0,PC                    ; IDX E1 xb [ff|ee ff]: 5-bit, PC literal
        CMPB    A,X                     ; IDX E1 xb [ff|ee ff]: accumulator A offset
        CMPB    B,Y                     ; IDX E1 xb [ff|ee ff]: accumulator B offset
        CMPB    D,SP                    ; IDX E1 xb [ff|ee ff]: accumulator D offset
        CMPB    1,+X                    ; IDX E1 xb [ff|ee ff]: pre-increment
        CMPB    8,-Y                    ; IDX E1 xb [ff|ee ff]: pre-decrement
        CMPB    2,SP+                   ; IDX E1 xb [ff|ee ff]: post-increment
        CMPB    7,X-                    ; IDX E1 xb [ff|ee ff]: post-decrement
        CMPB    16,X                    ; IDX E1 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        CMPB    -17,Y                   ; IDX E1 xb [ff|ee ff]: 9-bit negative
        CMPB    255,SP                  ; IDX E1 xb [ff|ee ff]: 9-bit max
        CMPB    -256,X                  ; IDX E1 xb [ff|ee ff]: 9-bit min
        CMPB    256,Y                   ; IDX E1 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        CMPB    $8000,X                 ; IDX E1 xb [ff|ee ff]: 16-bit large
        CMPB    [$1234,X]               ; IDX E1 xb [ff|ee ff]: indexed indirect 16-bit
        CMPB    [D,SP]                  ; IDX E1 xb [ff|ee ff]: accumulator D indirect
        CMPB    $1234                   ; EXT F1 hh ll
        CMPB    >$40                    ; EXT F1 hh ll (forced extended)
        SBCB    #$5A                    ; IMM8 C2 ii
        SBCB    $40                     ; DIR D2 dd
        SBCB    5,X                     ; IDX E2 xb [ff|ee ff]: 5-bit constant offset
        SBCB    -16,Y                   ; IDX E2 xb [ff|ee ff]: 5-bit, most negative
        SBCB    15,SP                   ; IDX E2 xb [ff|ee ff]: 5-bit, most positive
        SBCB    0,PC                    ; IDX E2 xb [ff|ee ff]: 5-bit, PC literal
        SBCB    A,X                     ; IDX E2 xb [ff|ee ff]: accumulator A offset
        SBCB    B,Y                     ; IDX E2 xb [ff|ee ff]: accumulator B offset
        SBCB    D,SP                    ; IDX E2 xb [ff|ee ff]: accumulator D offset
        SBCB    1,+X                    ; IDX E2 xb [ff|ee ff]: pre-increment
        SBCB    8,-Y                    ; IDX E2 xb [ff|ee ff]: pre-decrement
        SBCB    2,SP+                   ; IDX E2 xb [ff|ee ff]: post-increment
        SBCB    7,X-                    ; IDX E2 xb [ff|ee ff]: post-decrement
        SBCB    16,X                    ; IDX E2 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        SBCB    -17,Y                   ; IDX E2 xb [ff|ee ff]: 9-bit negative
        SBCB    255,SP                  ; IDX E2 xb [ff|ee ff]: 9-bit max
        SBCB    -256,X                  ; IDX E2 xb [ff|ee ff]: 9-bit min
        SBCB    256,Y                   ; IDX E2 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        SBCB    $8000,X                 ; IDX E2 xb [ff|ee ff]: 16-bit large
        SBCB    [$1234,X]               ; IDX E2 xb [ff|ee ff]: indexed indirect 16-bit
        SBCB    [D,SP]                  ; IDX E2 xb [ff|ee ff]: accumulator D indirect
        SBCB    $1234                   ; EXT F2 hh ll
        SBCB    >$40                    ; EXT F2 hh ll (forced extended)
        ADDD    #$1234                  ; IMM16 C3 jj kk
        ADDD    $40                     ; DIR D3 dd
        ADDD    5,X                     ; IDX E3 xb [ff|ee ff]: 5-bit constant offset
        ADDD    -16,Y                   ; IDX E3 xb [ff|ee ff]: 5-bit, most negative
        ADDD    15,SP                   ; IDX E3 xb [ff|ee ff]: 5-bit, most positive
        ADDD    0,PC                    ; IDX E3 xb [ff|ee ff]: 5-bit, PC literal
        ADDD    A,X                     ; IDX E3 xb [ff|ee ff]: accumulator A offset
        ADDD    B,Y                     ; IDX E3 xb [ff|ee ff]: accumulator B offset
        ADDD    D,SP                    ; IDX E3 xb [ff|ee ff]: accumulator D offset
        ADDD    1,+X                    ; IDX E3 xb [ff|ee ff]: pre-increment
        ADDD    8,-Y                    ; IDX E3 xb [ff|ee ff]: pre-decrement
        ADDD    2,SP+                   ; IDX E3 xb [ff|ee ff]: post-increment
        ADDD    7,X-                    ; IDX E3 xb [ff|ee ff]: post-decrement
        ADDD    16,X                    ; IDX E3 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        ADDD    -17,Y                   ; IDX E3 xb [ff|ee ff]: 9-bit negative
        ADDD    255,SP                  ; IDX E3 xb [ff|ee ff]: 9-bit max
        ADDD    -256,X                  ; IDX E3 xb [ff|ee ff]: 9-bit min
        ADDD    256,Y                   ; IDX E3 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        ADDD    $8000,X                 ; IDX E3 xb [ff|ee ff]: 16-bit large
        ADDD    [$1234,X]               ; IDX E3 xb [ff|ee ff]: indexed indirect 16-bit
        ADDD    [D,SP]                  ; IDX E3 xb [ff|ee ff]: accumulator D indirect
        ADDD    $1234                   ; EXT F3 hh ll
        ADDD    >$40                    ; EXT F3 hh ll (forced extended)
        ANDB    #$5A                    ; IMM8 C4 ii
        ANDB    $40                     ; DIR D4 dd
        ANDB    5,X                     ; IDX E4 xb [ff|ee ff]: 5-bit constant offset
        ANDB    -16,Y                   ; IDX E4 xb [ff|ee ff]: 5-bit, most negative
        ANDB    15,SP                   ; IDX E4 xb [ff|ee ff]: 5-bit, most positive
        ANDB    0,PC                    ; IDX E4 xb [ff|ee ff]: 5-bit, PC literal
        ANDB    A,X                     ; IDX E4 xb [ff|ee ff]: accumulator A offset
        ANDB    B,Y                     ; IDX E4 xb [ff|ee ff]: accumulator B offset
        ANDB    D,SP                    ; IDX E4 xb [ff|ee ff]: accumulator D offset
        ANDB    1,+X                    ; IDX E4 xb [ff|ee ff]: pre-increment
        ANDB    8,-Y                    ; IDX E4 xb [ff|ee ff]: pre-decrement
        ANDB    2,SP+                   ; IDX E4 xb [ff|ee ff]: post-increment
        ANDB    7,X-                    ; IDX E4 xb [ff|ee ff]: post-decrement
        ANDB    16,X                    ; IDX E4 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        ANDB    -17,Y                   ; IDX E4 xb [ff|ee ff]: 9-bit negative
        ANDB    255,SP                  ; IDX E4 xb [ff|ee ff]: 9-bit max
        ANDB    -256,X                  ; IDX E4 xb [ff|ee ff]: 9-bit min
        ANDB    256,Y                   ; IDX E4 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        ANDB    $8000,X                 ; IDX E4 xb [ff|ee ff]: 16-bit large
        ANDB    [$1234,X]               ; IDX E4 xb [ff|ee ff]: indexed indirect 16-bit
        ANDB    [D,SP]                  ; IDX E4 xb [ff|ee ff]: accumulator D indirect
        ANDB    $1234                   ; EXT F4 hh ll
        ANDB    >$40                    ; EXT F4 hh ll (forced extended)
        BITB    #$5A                    ; IMM8 C5 ii
        BITB    $40                     ; DIR D5 dd
        BITB    5,X                     ; IDX E5 xb [ff|ee ff]: 5-bit constant offset
        BITB    -16,Y                   ; IDX E5 xb [ff|ee ff]: 5-bit, most negative
        BITB    15,SP                   ; IDX E5 xb [ff|ee ff]: 5-bit, most positive
        BITB    0,PC                    ; IDX E5 xb [ff|ee ff]: 5-bit, PC literal
        BITB    A,X                     ; IDX E5 xb [ff|ee ff]: accumulator A offset
        BITB    B,Y                     ; IDX E5 xb [ff|ee ff]: accumulator B offset
        BITB    D,SP                    ; IDX E5 xb [ff|ee ff]: accumulator D offset
        BITB    1,+X                    ; IDX E5 xb [ff|ee ff]: pre-increment
        BITB    8,-Y                    ; IDX E5 xb [ff|ee ff]: pre-decrement
        BITB    2,SP+                   ; IDX E5 xb [ff|ee ff]: post-increment
        BITB    7,X-                    ; IDX E5 xb [ff|ee ff]: post-decrement
        BITB    16,X                    ; IDX E5 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        BITB    -17,Y                   ; IDX E5 xb [ff|ee ff]: 9-bit negative
        BITB    255,SP                  ; IDX E5 xb [ff|ee ff]: 9-bit max
        BITB    -256,X                  ; IDX E5 xb [ff|ee ff]: 9-bit min
        BITB    256,Y                   ; IDX E5 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        BITB    $8000,X                 ; IDX E5 xb [ff|ee ff]: 16-bit large
        BITB    [$1234,X]               ; IDX E5 xb [ff|ee ff]: indexed indirect 16-bit
        BITB    [D,SP]                  ; IDX E5 xb [ff|ee ff]: accumulator D indirect
        BITB    $1234                   ; EXT F5 hh ll
        BITB    >$40                    ; EXT F5 hh ll (forced extended)
        LDAB    #$5A                    ; IMM8 C6 ii
        LDAB    $40                     ; DIR D6 dd
        LDAB    5,X                     ; IDX E6 xb [ff|ee ff]: 5-bit constant offset
        LDAB    -16,Y                   ; IDX E6 xb [ff|ee ff]: 5-bit, most negative
        LDAB    15,SP                   ; IDX E6 xb [ff|ee ff]: 5-bit, most positive
        LDAB    0,PC                    ; IDX E6 xb [ff|ee ff]: 5-bit, PC literal
        LDAB    A,X                     ; IDX E6 xb [ff|ee ff]: accumulator A offset
        LDAB    B,Y                     ; IDX E6 xb [ff|ee ff]: accumulator B offset
        LDAB    D,SP                    ; IDX E6 xb [ff|ee ff]: accumulator D offset
        LDAB    1,+X                    ; IDX E6 xb [ff|ee ff]: pre-increment
        LDAB    8,-Y                    ; IDX E6 xb [ff|ee ff]: pre-decrement
        LDAB    2,SP+                   ; IDX E6 xb [ff|ee ff]: post-increment
        LDAB    7,X-                    ; IDX E6 xb [ff|ee ff]: post-decrement
        LDAB    16,X                    ; IDX E6 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        LDAB    -17,Y                   ; IDX E6 xb [ff|ee ff]: 9-bit negative
        LDAB    255,SP                  ; IDX E6 xb [ff|ee ff]: 9-bit max
        LDAB    -256,X                  ; IDX E6 xb [ff|ee ff]: 9-bit min
        LDAB    256,Y                   ; IDX E6 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        LDAB    $8000,X                 ; IDX E6 xb [ff|ee ff]: 16-bit large
        LDAB    [$1234,X]               ; IDX E6 xb [ff|ee ff]: indexed indirect 16-bit
        LDAB    [D,SP]                  ; IDX E6 xb [ff|ee ff]: accumulator D indirect
        LDAB    $1234                   ; EXT F6 hh ll
        LDAB    >$40                    ; EXT F6 hh ll (forced extended)
        EORB    #$5A                    ; IMM8 C8 ii
        EORB    $40                     ; DIR D8 dd
        EORB    5,X                     ; IDX E8 xb [ff|ee ff]: 5-bit constant offset
        EORB    -16,Y                   ; IDX E8 xb [ff|ee ff]: 5-bit, most negative
        EORB    15,SP                   ; IDX E8 xb [ff|ee ff]: 5-bit, most positive
        EORB    0,PC                    ; IDX E8 xb [ff|ee ff]: 5-bit, PC literal
        EORB    A,X                     ; IDX E8 xb [ff|ee ff]: accumulator A offset
        EORB    B,Y                     ; IDX E8 xb [ff|ee ff]: accumulator B offset
        EORB    D,SP                    ; IDX E8 xb [ff|ee ff]: accumulator D offset
        EORB    1,+X                    ; IDX E8 xb [ff|ee ff]: pre-increment
        EORB    8,-Y                    ; IDX E8 xb [ff|ee ff]: pre-decrement
        EORB    2,SP+                   ; IDX E8 xb [ff|ee ff]: post-increment
        EORB    7,X-                    ; IDX E8 xb [ff|ee ff]: post-decrement
        EORB    16,X                    ; IDX E8 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        EORB    -17,Y                   ; IDX E8 xb [ff|ee ff]: 9-bit negative
        EORB    255,SP                  ; IDX E8 xb [ff|ee ff]: 9-bit max
        EORB    -256,X                  ; IDX E8 xb [ff|ee ff]: 9-bit min
        EORB    256,Y                   ; IDX E8 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        EORB    $8000,X                 ; IDX E8 xb [ff|ee ff]: 16-bit large
        EORB    [$1234,X]               ; IDX E8 xb [ff|ee ff]: indexed indirect 16-bit
        EORB    [D,SP]                  ; IDX E8 xb [ff|ee ff]: accumulator D indirect
        EORB    $1234                   ; EXT F8 hh ll
        EORB    >$40                    ; EXT F8 hh ll (forced extended)
        ADCB    #$5A                    ; IMM8 C9 ii
        ADCB    $40                     ; DIR D9 dd
        ADCB    5,X                     ; IDX E9 xb [ff|ee ff]: 5-bit constant offset
        ADCB    -16,Y                   ; IDX E9 xb [ff|ee ff]: 5-bit, most negative
        ADCB    15,SP                   ; IDX E9 xb [ff|ee ff]: 5-bit, most positive
        ADCB    0,PC                    ; IDX E9 xb [ff|ee ff]: 5-bit, PC literal
        ADCB    A,X                     ; IDX E9 xb [ff|ee ff]: accumulator A offset
        ADCB    B,Y                     ; IDX E9 xb [ff|ee ff]: accumulator B offset
        ADCB    D,SP                    ; IDX E9 xb [ff|ee ff]: accumulator D offset
        ADCB    1,+X                    ; IDX E9 xb [ff|ee ff]: pre-increment
        ADCB    8,-Y                    ; IDX E9 xb [ff|ee ff]: pre-decrement
        ADCB    2,SP+                   ; IDX E9 xb [ff|ee ff]: post-increment
        ADCB    7,X-                    ; IDX E9 xb [ff|ee ff]: post-decrement
        ADCB    16,X                    ; IDX E9 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        ADCB    -17,Y                   ; IDX E9 xb [ff|ee ff]: 9-bit negative
        ADCB    255,SP                  ; IDX E9 xb [ff|ee ff]: 9-bit max
        ADCB    -256,X                  ; IDX E9 xb [ff|ee ff]: 9-bit min
        ADCB    256,Y                   ; IDX E9 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        ADCB    $8000,X                 ; IDX E9 xb [ff|ee ff]: 16-bit large
        ADCB    [$1234,X]               ; IDX E9 xb [ff|ee ff]: indexed indirect 16-bit
        ADCB    [D,SP]                  ; IDX E9 xb [ff|ee ff]: accumulator D indirect
        ADCB    $1234                   ; EXT F9 hh ll
        ADCB    >$40                    ; EXT F9 hh ll (forced extended)
        ORAB    #$5A                    ; IMM8 CA ii
        ORAB    $40                     ; DIR DA dd
        ORAB    5,X                     ; IDX EA xb [ff|ee ff]: 5-bit constant offset
        ORAB    -16,Y                   ; IDX EA xb [ff|ee ff]: 5-bit, most negative
        ORAB    15,SP                   ; IDX EA xb [ff|ee ff]: 5-bit, most positive
        ORAB    0,PC                    ; IDX EA xb [ff|ee ff]: 5-bit, PC literal
        ORAB    A,X                     ; IDX EA xb [ff|ee ff]: accumulator A offset
        ORAB    B,Y                     ; IDX EA xb [ff|ee ff]: accumulator B offset
        ORAB    D,SP                    ; IDX EA xb [ff|ee ff]: accumulator D offset
        ORAB    1,+X                    ; IDX EA xb [ff|ee ff]: pre-increment
        ORAB    8,-Y                    ; IDX EA xb [ff|ee ff]: pre-decrement
        ORAB    2,SP+                   ; IDX EA xb [ff|ee ff]: post-increment
        ORAB    7,X-                    ; IDX EA xb [ff|ee ff]: post-decrement
        ORAB    16,X                    ; IDX EA xb [ff|ee ff]: 9-bit (just outside 5-bit)
        ORAB    -17,Y                   ; IDX EA xb [ff|ee ff]: 9-bit negative
        ORAB    255,SP                  ; IDX EA xb [ff|ee ff]: 9-bit max
        ORAB    -256,X                  ; IDX EA xb [ff|ee ff]: 9-bit min
        ORAB    256,Y                   ; IDX EA xb [ff|ee ff]: 16-bit (just outside 9-bit)
        ORAB    $8000,X                 ; IDX EA xb [ff|ee ff]: 16-bit large
        ORAB    [$1234,X]               ; IDX EA xb [ff|ee ff]: indexed indirect 16-bit
        ORAB    [D,SP]                  ; IDX EA xb [ff|ee ff]: accumulator D indirect
        ORAB    $1234                   ; EXT FA hh ll
        ORAB    >$40                    ; EXT FA hh ll (forced extended)
        ADDB    #$5A                    ; IMM8 CB ii
        ADDB    $40                     ; DIR DB dd
        ADDB    5,X                     ; IDX EB xb [ff|ee ff]: 5-bit constant offset
        ADDB    -16,Y                   ; IDX EB xb [ff|ee ff]: 5-bit, most negative
        ADDB    15,SP                   ; IDX EB xb [ff|ee ff]: 5-bit, most positive
        ADDB    0,PC                    ; IDX EB xb [ff|ee ff]: 5-bit, PC literal
        ADDB    A,X                     ; IDX EB xb [ff|ee ff]: accumulator A offset
        ADDB    B,Y                     ; IDX EB xb [ff|ee ff]: accumulator B offset
        ADDB    D,SP                    ; IDX EB xb [ff|ee ff]: accumulator D offset
        ADDB    1,+X                    ; IDX EB xb [ff|ee ff]: pre-increment
        ADDB    8,-Y                    ; IDX EB xb [ff|ee ff]: pre-decrement
        ADDB    2,SP+                   ; IDX EB xb [ff|ee ff]: post-increment
        ADDB    7,X-                    ; IDX EB xb [ff|ee ff]: post-decrement
        ADDB    16,X                    ; IDX EB xb [ff|ee ff]: 9-bit (just outside 5-bit)
        ADDB    -17,Y                   ; IDX EB xb [ff|ee ff]: 9-bit negative
        ADDB    255,SP                  ; IDX EB xb [ff|ee ff]: 9-bit max
        ADDB    -256,X                  ; IDX EB xb [ff|ee ff]: 9-bit min
        ADDB    256,Y                   ; IDX EB xb [ff|ee ff]: 16-bit (just outside 9-bit)
        ADDB    $8000,X                 ; IDX EB xb [ff|ee ff]: 16-bit large
        ADDB    [$1234,X]               ; IDX EB xb [ff|ee ff]: indexed indirect 16-bit
        ADDB    [D,SP]                  ; IDX EB xb [ff|ee ff]: accumulator D indirect
        ADDB    $1234                   ; EXT FB hh ll
        ADDB    >$40                    ; EXT FB hh ll (forced extended)
        LDD     #$1234                  ; IMM16 CC jj kk
        LDD     $40                     ; DIR DC dd
        LDD     5,X                     ; IDX EC xb [ff|ee ff]: 5-bit constant offset
        LDD     -16,Y                   ; IDX EC xb [ff|ee ff]: 5-bit, most negative
        LDD     15,SP                   ; IDX EC xb [ff|ee ff]: 5-bit, most positive
        LDD     0,PC                    ; IDX EC xb [ff|ee ff]: 5-bit, PC literal
        LDD     A,X                     ; IDX EC xb [ff|ee ff]: accumulator A offset
        LDD     B,Y                     ; IDX EC xb [ff|ee ff]: accumulator B offset
        LDD     D,SP                    ; IDX EC xb [ff|ee ff]: accumulator D offset
        LDD     1,+X                    ; IDX EC xb [ff|ee ff]: pre-increment
        LDD     8,-Y                    ; IDX EC xb [ff|ee ff]: pre-decrement
        LDD     2,SP+                   ; IDX EC xb [ff|ee ff]: post-increment
        LDD     7,X-                    ; IDX EC xb [ff|ee ff]: post-decrement
        LDD     16,X                    ; IDX EC xb [ff|ee ff]: 9-bit (just outside 5-bit)
        LDD     -17,Y                   ; IDX EC xb [ff|ee ff]: 9-bit negative
        LDD     255,SP                  ; IDX EC xb [ff|ee ff]: 9-bit max
        LDD     -256,X                  ; IDX EC xb [ff|ee ff]: 9-bit min
        LDD     256,Y                   ; IDX EC xb [ff|ee ff]: 16-bit (just outside 9-bit)
        LDD     $8000,X                 ; IDX EC xb [ff|ee ff]: 16-bit large
        LDD     [$1234,X]               ; IDX EC xb [ff|ee ff]: indexed indirect 16-bit
        LDD     [D,SP]                  ; IDX EC xb [ff|ee ff]: accumulator D indirect
        LDD     $1234                   ; EXT FC hh ll
        LDD     >$40                    ; EXT FC hh ll (forced extended)
        LDY     #$1234                  ; IMM16 CD jj kk
        LDY     $40                     ; DIR DD dd
        LDY     5,X                     ; IDX ED xb [ff|ee ff]: 5-bit constant offset
        LDY     -16,Y                   ; IDX ED xb [ff|ee ff]: 5-bit, most negative
        LDY     15,SP                   ; IDX ED xb [ff|ee ff]: 5-bit, most positive
        LDY     0,PC                    ; IDX ED xb [ff|ee ff]: 5-bit, PC literal
        LDY     A,X                     ; IDX ED xb [ff|ee ff]: accumulator A offset
        LDY     B,Y                     ; IDX ED xb [ff|ee ff]: accumulator B offset
        LDY     D,SP                    ; IDX ED xb [ff|ee ff]: accumulator D offset
        LDY     1,+X                    ; IDX ED xb [ff|ee ff]: pre-increment
        LDY     8,-Y                    ; IDX ED xb [ff|ee ff]: pre-decrement
        LDY     2,SP+                   ; IDX ED xb [ff|ee ff]: post-increment
        LDY     7,X-                    ; IDX ED xb [ff|ee ff]: post-decrement
        LDY     16,X                    ; IDX ED xb [ff|ee ff]: 9-bit (just outside 5-bit)
        LDY     -17,Y                   ; IDX ED xb [ff|ee ff]: 9-bit negative
        LDY     255,SP                  ; IDX ED xb [ff|ee ff]: 9-bit max
        LDY     -256,X                  ; IDX ED xb [ff|ee ff]: 9-bit min
        LDY     256,Y                   ; IDX ED xb [ff|ee ff]: 16-bit (just outside 9-bit)
        LDY     $8000,X                 ; IDX ED xb [ff|ee ff]: 16-bit large
        LDY     [$1234,X]               ; IDX ED xb [ff|ee ff]: indexed indirect 16-bit
        LDY     [D,SP]                  ; IDX ED xb [ff|ee ff]: accumulator D indirect
        LDY     $1234                   ; EXT FD hh ll
        LDY     >$40                    ; EXT FD hh ll (forced extended)
        LDX     #$1234                  ; IMM16 CE jj kk
        LDX     $40                     ; DIR DE dd
        LDX     5,X                     ; IDX EE xb [ff|ee ff]: 5-bit constant offset
        LDX     -16,Y                   ; IDX EE xb [ff|ee ff]: 5-bit, most negative
        LDX     15,SP                   ; IDX EE xb [ff|ee ff]: 5-bit, most positive
        LDX     0,PC                    ; IDX EE xb [ff|ee ff]: 5-bit, PC literal
        LDX     A,X                     ; IDX EE xb [ff|ee ff]: accumulator A offset
        LDX     B,Y                     ; IDX EE xb [ff|ee ff]: accumulator B offset
        LDX     D,SP                    ; IDX EE xb [ff|ee ff]: accumulator D offset
        LDX     1,+X                    ; IDX EE xb [ff|ee ff]: pre-increment
        LDX     8,-Y                    ; IDX EE xb [ff|ee ff]: pre-decrement
        LDX     2,SP+                   ; IDX EE xb [ff|ee ff]: post-increment
        LDX     7,X-                    ; IDX EE xb [ff|ee ff]: post-decrement
        LDX     16,X                    ; IDX EE xb [ff|ee ff]: 9-bit (just outside 5-bit)
        LDX     -17,Y                   ; IDX EE xb [ff|ee ff]: 9-bit negative
        LDX     255,SP                  ; IDX EE xb [ff|ee ff]: 9-bit max
        LDX     -256,X                  ; IDX EE xb [ff|ee ff]: 9-bit min
        LDX     256,Y                   ; IDX EE xb [ff|ee ff]: 16-bit (just outside 9-bit)
        LDX     $8000,X                 ; IDX EE xb [ff|ee ff]: 16-bit large
        LDX     [$1234,X]               ; IDX EE xb [ff|ee ff]: indexed indirect 16-bit
        LDX     [D,SP]                  ; IDX EE xb [ff|ee ff]: accumulator D indirect
        LDX     $1234                   ; EXT FE hh ll
        LDX     >$40                    ; EXT FE hh ll (forced extended)
        LDS     #$1234                  ; IMM16 CF jj kk
        LDS     $40                     ; DIR DF dd
        LDS     5,X                     ; IDX EF xb [ff|ee ff]: 5-bit constant offset
        LDS     -16,Y                   ; IDX EF xb [ff|ee ff]: 5-bit, most negative
        LDS     15,SP                   ; IDX EF xb [ff|ee ff]: 5-bit, most positive
        LDS     0,PC                    ; IDX EF xb [ff|ee ff]: 5-bit, PC literal
        LDS     A,X                     ; IDX EF xb [ff|ee ff]: accumulator A offset
        LDS     B,Y                     ; IDX EF xb [ff|ee ff]: accumulator B offset
        LDS     D,SP                    ; IDX EF xb [ff|ee ff]: accumulator D offset
        LDS     1,+X                    ; IDX EF xb [ff|ee ff]: pre-increment
        LDS     8,-Y                    ; IDX EF xb [ff|ee ff]: pre-decrement
        LDS     2,SP+                   ; IDX EF xb [ff|ee ff]: post-increment
        LDS     7,X-                    ; IDX EF xb [ff|ee ff]: post-decrement
        LDS     16,X                    ; IDX EF xb [ff|ee ff]: 9-bit (just outside 5-bit)
        LDS     -17,Y                   ; IDX EF xb [ff|ee ff]: 9-bit negative
        LDS     255,SP                  ; IDX EF xb [ff|ee ff]: 9-bit max
        LDS     -256,X                  ; IDX EF xb [ff|ee ff]: 9-bit min
        LDS     256,Y                   ; IDX EF xb [ff|ee ff]: 16-bit (just outside 9-bit)
        LDS     $8000,X                 ; IDX EF xb [ff|ee ff]: 16-bit large
        LDS     [$1234,X]               ; IDX EF xb [ff|ee ff]: indexed indirect 16-bit
        LDS     [D,SP]                  ; IDX EF xb [ff|ee ff]: accumulator D indirect
        LDS     $1234                   ; EXT FF hh ll
        LDS     >$40                    ; EXT FF hh ll (forced extended)
        CLRA                            ; INH 87
        TSTA                            ; INH 97
        NOP                             ; INH A7
        TFR     A,B                     ; TFR_EXG B7 eb
        TFR     B,A                     ; TFR_EXG B7 eb
        TFR     CCR,A                   ; TFR_EXG B7 eb
        TFR     A,CCR                   ; TFR_EXG B7 eb
        TFR     D,X                     ; TFR_EXG B7 eb
        TFR     X,Y                     ; TFR_EXG B7 eb
        TFR     Y,SP                    ; TFR_EXG B7 eb
        TFR     SP,D                    ; TFR_EXG B7 eb
        TFR     A,X                     ; TFR_EXG B7 eb
        TFR     X,A                     ; TFR_EXG B7 eb
        EXG     A,B                     ; TFR_EXG B7 eb
        EXG     B,A                     ; TFR_EXG B7 eb
        EXG     CCR,A                   ; TFR_EXG B7 eb
        EXG     A,CCR                   ; TFR_EXG B7 eb
        EXG     D,X                     ; TFR_EXG B7 eb
        EXG     X,Y                     ; TFR_EXG B7 eb
        EXG     Y,SP                    ; TFR_EXG B7 eb
        EXG     SP,D                    ; TFR_EXG B7 eb
        EXG     A,X                     ; TFR_EXG B7 eb
        EXG     X,A                     ; TFR_EXG B7 eb
        SEX     A,D                     ; TFR_EXG B7 eb
        SEX     B,X                     ; TFR_EXG B7 eb
        CLRB                            ; INH C7
        TSTB                            ; INH D7
        TST     5,X                     ; IDX E7 xb [ff|ee ff]: 5-bit constant offset
        TST     -16,Y                   ; IDX E7 xb [ff|ee ff]: 5-bit, most negative
        TST     15,SP                   ; IDX E7 xb [ff|ee ff]: 5-bit, most positive
        TST     0,PC                    ; IDX E7 xb [ff|ee ff]: 5-bit, PC literal
        TST     A,X                     ; IDX E7 xb [ff|ee ff]: accumulator A offset
        TST     B,Y                     ; IDX E7 xb [ff|ee ff]: accumulator B offset
        TST     D,SP                    ; IDX E7 xb [ff|ee ff]: accumulator D offset
        TST     1,+X                    ; IDX E7 xb [ff|ee ff]: pre-increment
        TST     8,-Y                    ; IDX E7 xb [ff|ee ff]: pre-decrement
        TST     2,SP+                   ; IDX E7 xb [ff|ee ff]: post-increment
        TST     7,X-                    ; IDX E7 xb [ff|ee ff]: post-decrement
        TST     16,X                    ; IDX E7 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        TST     -17,Y                   ; IDX E7 xb [ff|ee ff]: 9-bit negative
        TST     255,SP                  ; IDX E7 xb [ff|ee ff]: 9-bit max
        TST     -256,X                  ; IDX E7 xb [ff|ee ff]: 9-bit min
        TST     256,Y                   ; IDX E7 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        TST     $8000,X                 ; IDX E7 xb [ff|ee ff]: 16-bit large
        TST     [$1234,X]               ; IDX E7 xb [ff|ee ff]: indexed indirect 16-bit
        TST     [D,SP]                  ; IDX E7 xb [ff|ee ff]: accumulator D indirect
        TST     $1234                   ; EXT F7 hh ll
        TST     >$40                    ; EXT F7 hh ll (forced extended)
        MOVW    #$1234,5,X              ; MOV_IMM_IDX 18 00 xb jj kk: dst 5-bit constant offset
        MOVW    #$1234,-16,Y            ; MOV_IMM_IDX 18 00 xb jj kk: dst 5-bit, most negative
        MOVW    #$1234,15,SP            ; MOV_IMM_IDX 18 00 xb jj kk: dst 5-bit, most positive
        MOVW    #$1234,0,PC             ; MOV_IMM_IDX 18 00 xb jj kk: dst 5-bit, PC literal
        MOVW    #$1234,A,X              ; MOV_IMM_IDX 18 00 xb jj kk: dst accumulator A offset
        MOVW    #$1234,B,Y              ; MOV_IMM_IDX 18 00 xb jj kk: dst accumulator B offset
        MOVW    #$1234,D,SP             ; MOV_IMM_IDX 18 00 xb jj kk: dst accumulator D offset
        MOVW    #$1234,1,+X             ; MOV_IMM_IDX 18 00 xb jj kk: dst pre-increment
        MOVW    #$1234,8,-Y             ; MOV_IMM_IDX 18 00 xb jj kk: dst pre-decrement
        MOVW    #$1234,2,SP+            ; MOV_IMM_IDX 18 00 xb jj kk: dst post-increment
        MOVW    #$1234,7,X-             ; MOV_IMM_IDX 18 00 xb jj kk: dst post-decrement
        MOVB    #$5A,5,X                ; MOV_IMM_IDX 18 08 xb ii: dst 5-bit constant offset
        MOVB    #$5A,-16,Y              ; MOV_IMM_IDX 18 08 xb ii: dst 5-bit, most negative
        MOVB    #$5A,15,SP              ; MOV_IMM_IDX 18 08 xb ii: dst 5-bit, most positive
        MOVB    #$5A,0,PC               ; MOV_IMM_IDX 18 08 xb ii: dst 5-bit, PC literal
        MOVB    #$5A,A,X                ; MOV_IMM_IDX 18 08 xb ii: dst accumulator A offset
        MOVB    #$5A,B,Y                ; MOV_IMM_IDX 18 08 xb ii: dst accumulator B offset
        MOVB    #$5A,D,SP               ; MOV_IMM_IDX 18 08 xb ii: dst accumulator D offset
        MOVB    #$5A,1,+X               ; MOV_IMM_IDX 18 08 xb ii: dst pre-increment
        MOVB    #$5A,8,-Y               ; MOV_IMM_IDX 18 08 xb ii: dst pre-decrement
        MOVB    #$5A,2,SP+              ; MOV_IMM_IDX 18 08 xb ii: dst post-increment
        MOVB    #$5A,7,X-               ; MOV_IMM_IDX 18 08 xb ii: dst post-decrement
        MOVW    $1234,5,X               ; MOV_EXT_IDX 18 01 xb hh ll: dst 5-bit constant offset
        MOVW    $1234,-16,Y             ; MOV_EXT_IDX 18 01 xb hh ll: dst 5-bit, most negative
        MOVW    $1234,15,SP             ; MOV_EXT_IDX 18 01 xb hh ll: dst 5-bit, most positive
        MOVW    $1234,0,PC              ; MOV_EXT_IDX 18 01 xb hh ll: dst 5-bit, PC literal
        MOVW    $1234,A,X               ; MOV_EXT_IDX 18 01 xb hh ll: dst accumulator A offset
        MOVW    $1234,B,Y               ; MOV_EXT_IDX 18 01 xb hh ll: dst accumulator B offset
        MOVW    $1234,D,SP              ; MOV_EXT_IDX 18 01 xb hh ll: dst accumulator D offset
        MOVW    $1234,1,+X              ; MOV_EXT_IDX 18 01 xb hh ll: dst pre-increment
        MOVW    $1234,8,-Y              ; MOV_EXT_IDX 18 01 xb hh ll: dst pre-decrement
        MOVW    $1234,2,SP+             ; MOV_EXT_IDX 18 01 xb hh ll: dst post-increment
        MOVW    $1234,7,X-              ; MOV_EXT_IDX 18 01 xb hh ll: dst post-decrement
        MOVB    $1234,5,X               ; MOV_EXT_IDX 18 09 xb hh ll: dst 5-bit constant offset
        MOVB    $1234,-16,Y             ; MOV_EXT_IDX 18 09 xb hh ll: dst 5-bit, most negative
        MOVB    $1234,15,SP             ; MOV_EXT_IDX 18 09 xb hh ll: dst 5-bit, most positive
        MOVB    $1234,0,PC              ; MOV_EXT_IDX 18 09 xb hh ll: dst 5-bit, PC literal
        MOVB    $1234,A,X               ; MOV_EXT_IDX 18 09 xb hh ll: dst accumulator A offset
        MOVB    $1234,B,Y               ; MOV_EXT_IDX 18 09 xb hh ll: dst accumulator B offset
        MOVB    $1234,D,SP              ; MOV_EXT_IDX 18 09 xb hh ll: dst accumulator D offset
        MOVB    $1234,1,+X              ; MOV_EXT_IDX 18 09 xb hh ll: dst pre-increment
        MOVB    $1234,8,-Y              ; MOV_EXT_IDX 18 09 xb hh ll: dst pre-decrement
        MOVB    $1234,2,SP+             ; MOV_EXT_IDX 18 09 xb hh ll: dst post-increment
        MOVB    $1234,7,X-              ; MOV_EXT_IDX 18 09 xb hh ll: dst post-decrement
        MOVW    5,X,B,Y                 ; MOV_IDX_IDX 18 02 xb xb: 5-bit constant offset -> accumulator B offset
        MOVW    -16,Y,D,SP              ; MOV_IDX_IDX 18 02 xb xb: 5-bit, most negative -> accumulator D offset
        MOVW    15,SP,1,+X              ; MOV_IDX_IDX 18 02 xb xb: 5-bit, most positive -> pre-increment
        MOVW    0,PC,8,-Y               ; MOV_IDX_IDX 18 02 xb xb: 5-bit, PC literal -> pre-decrement
        MOVW    A,X,2,SP+               ; MOV_IDX_IDX 18 02 xb xb: accumulator A offset -> post-increment
        MOVW    B,Y,7,X-                ; MOV_IDX_IDX 18 02 xb xb: accumulator B offset -> post-decrement
        MOVB    5,X,B,Y                 ; MOV_IDX_IDX 18 0A xb xb: 5-bit constant offset -> accumulator B offset
        MOVB    -16,Y,D,SP              ; MOV_IDX_IDX 18 0A xb xb: 5-bit, most negative -> accumulator D offset
        MOVB    15,SP,1,+X              ; MOV_IDX_IDX 18 0A xb xb: 5-bit, most positive -> pre-increment
        MOVB    0,PC,8,-Y               ; MOV_IDX_IDX 18 0A xb xb: 5-bit, PC literal -> pre-decrement
        MOVB    A,X,2,SP+               ; MOV_IDX_IDX 18 0A xb xb: accumulator A offset -> post-increment
        MOVB    B,Y,7,X-                ; MOV_IDX_IDX 18 0A xb xb: accumulator B offset -> post-decrement
        MOVW    #$1234,$1234            ; MOV_IMM_EXT 18 03 jj kk hh ll
        MOVB    #$5A,$1234              ; MOV_IMM_EXT 18 0B ii hh ll
        MOVW    $1234,$5678             ; MOV_EXT_EXT 18 04 hh ll hh ll
        MOVB    $1234,$5678             ; MOV_EXT_EXT 18 0C hh ll hh ll
        MOVW    5,X,$1234               ; MOV_IDX_EXT 18 05 xb hh ll: src 5-bit constant offset
        MOVW    -16,Y,$1234             ; MOV_IDX_EXT 18 05 xb hh ll: src 5-bit, most negative
        MOVW    15,SP,$1234             ; MOV_IDX_EXT 18 05 xb hh ll: src 5-bit, most positive
        MOVW    0,PC,$1234              ; MOV_IDX_EXT 18 05 xb hh ll: src 5-bit, PC literal
        MOVW    A,X,$1234               ; MOV_IDX_EXT 18 05 xb hh ll: src accumulator A offset
        MOVW    B,Y,$1234               ; MOV_IDX_EXT 18 05 xb hh ll: src accumulator B offset
        MOVW    D,SP,$1234              ; MOV_IDX_EXT 18 05 xb hh ll: src accumulator D offset
        MOVW    1,+X,$1234              ; MOV_IDX_EXT 18 05 xb hh ll: src pre-increment
        MOVW    8,-Y,$1234              ; MOV_IDX_EXT 18 05 xb hh ll: src pre-decrement
        MOVW    2,SP+,$1234             ; MOV_IDX_EXT 18 05 xb hh ll: src post-increment
        MOVW    7,X-,$1234              ; MOV_IDX_EXT 18 05 xb hh ll: src post-decrement
        MOVB    5,X,$1234               ; MOV_IDX_EXT 18 0D xb hh ll: src 5-bit constant offset
        MOVB    -16,Y,$1234             ; MOV_IDX_EXT 18 0D xb hh ll: src 5-bit, most negative
        MOVB    15,SP,$1234             ; MOV_IDX_EXT 18 0D xb hh ll: src 5-bit, most positive
        MOVB    0,PC,$1234              ; MOV_IDX_EXT 18 0D xb hh ll: src 5-bit, PC literal
        MOVB    A,X,$1234               ; MOV_IDX_EXT 18 0D xb hh ll: src accumulator A offset
        MOVB    B,Y,$1234               ; MOV_IDX_EXT 18 0D xb hh ll: src accumulator B offset
        MOVB    D,SP,$1234              ; MOV_IDX_EXT 18 0D xb hh ll: src accumulator D offset
        MOVB    1,+X,$1234              ; MOV_IDX_EXT 18 0D xb hh ll: src pre-increment
        MOVB    8,-Y,$1234              ; MOV_IDX_EXT 18 0D xb hh ll: src pre-decrement
        MOVB    2,SP+,$1234             ; MOV_IDX_EXT 18 0D xb hh ll: src post-increment
        MOVB    7,X-,$1234              ; MOV_IDX_EXT 18 0D xb hh ll: src post-decrement
        ABA                             ; INH 18 06
        DAA                             ; INH 18 07
        TAB                             ; INH 18 0E
        TBA                             ; INH 18 0F
        IDIV                            ; INH 18 10
        FDIV                            ; INH 18 11
        EMACS   $1234                   ; EXT 18 12 hh ll
        EMACS   >$40                    ; EXT 18 12 hh ll (forced extended)
        EMULS                           ; INH 18 13
        EDIVS                           ; INH 18 14
        IDIVS                           ; INH 18 15
        SBA                             ; INH 18 16
        CBA                             ; INH 18 17
        MAXA    5,X                     ; IDX 18 18 xb [ff|ee ff]: 5-bit constant offset
        MAXA    -16,Y                   ; IDX 18 18 xb [ff|ee ff]: 5-bit, most negative
        MAXA    15,SP                   ; IDX 18 18 xb [ff|ee ff]: 5-bit, most positive
        MAXA    0,PC                    ; IDX 18 18 xb [ff|ee ff]: 5-bit, PC literal
        MAXA    A,X                     ; IDX 18 18 xb [ff|ee ff]: accumulator A offset
        MAXA    B,Y                     ; IDX 18 18 xb [ff|ee ff]: accumulator B offset
        MAXA    D,SP                    ; IDX 18 18 xb [ff|ee ff]: accumulator D offset
        MAXA    1,+X                    ; IDX 18 18 xb [ff|ee ff]: pre-increment
        MAXA    8,-Y                    ; IDX 18 18 xb [ff|ee ff]: pre-decrement
        MAXA    2,SP+                   ; IDX 18 18 xb [ff|ee ff]: post-increment
        MAXA    7,X-                    ; IDX 18 18 xb [ff|ee ff]: post-decrement
        MAXA    16,X                    ; IDX 18 18 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        MAXA    -17,Y                   ; IDX 18 18 xb [ff|ee ff]: 9-bit negative
        MAXA    255,SP                  ; IDX 18 18 xb [ff|ee ff]: 9-bit max
        MAXA    -256,X                  ; IDX 18 18 xb [ff|ee ff]: 9-bit min
        MAXA    256,Y                   ; IDX 18 18 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        MAXA    $8000,X                 ; IDX 18 18 xb [ff|ee ff]: 16-bit large
        MAXA    [$1234,X]               ; IDX 18 18 xb [ff|ee ff]: indexed indirect 16-bit
        MAXA    [D,SP]                  ; IDX 18 18 xb [ff|ee ff]: accumulator D indirect
        MINA    5,X                     ; IDX 18 19 xb [ff|ee ff]: 5-bit constant offset
        MINA    -16,Y                   ; IDX 18 19 xb [ff|ee ff]: 5-bit, most negative
        MINA    15,SP                   ; IDX 18 19 xb [ff|ee ff]: 5-bit, most positive
        MINA    0,PC                    ; IDX 18 19 xb [ff|ee ff]: 5-bit, PC literal
        MINA    A,X                     ; IDX 18 19 xb [ff|ee ff]: accumulator A offset
        MINA    B,Y                     ; IDX 18 19 xb [ff|ee ff]: accumulator B offset
        MINA    D,SP                    ; IDX 18 19 xb [ff|ee ff]: accumulator D offset
        MINA    1,+X                    ; IDX 18 19 xb [ff|ee ff]: pre-increment
        MINA    8,-Y                    ; IDX 18 19 xb [ff|ee ff]: pre-decrement
        MINA    2,SP+                   ; IDX 18 19 xb [ff|ee ff]: post-increment
        MINA    7,X-                    ; IDX 18 19 xb [ff|ee ff]: post-decrement
        MINA    16,X                    ; IDX 18 19 xb [ff|ee ff]: 9-bit (just outside 5-bit)
        MINA    -17,Y                   ; IDX 18 19 xb [ff|ee ff]: 9-bit negative
        MINA    255,SP                  ; IDX 18 19 xb [ff|ee ff]: 9-bit max
        MINA    -256,X                  ; IDX 18 19 xb [ff|ee ff]: 9-bit min
        MINA    256,Y                   ; IDX 18 19 xb [ff|ee ff]: 16-bit (just outside 9-bit)
        MINA    $8000,X                 ; IDX 18 19 xb [ff|ee ff]: 16-bit large
        MINA    [$1234,X]               ; IDX 18 19 xb [ff|ee ff]: indexed indirect 16-bit
        MINA    [D,SP]                  ; IDX 18 19 xb [ff|ee ff]: accumulator D indirect
        EMAXD   5,X                     ; IDX 18 1A xb [ff|ee ff]: 5-bit constant offset
        EMAXD   -16,Y                   ; IDX 18 1A xb [ff|ee ff]: 5-bit, most negative
        EMAXD   15,SP                   ; IDX 18 1A xb [ff|ee ff]: 5-bit, most positive
        EMAXD   0,PC                    ; IDX 18 1A xb [ff|ee ff]: 5-bit, PC literal
        EMAXD   A,X                     ; IDX 18 1A xb [ff|ee ff]: accumulator A offset
        EMAXD   B,Y                     ; IDX 18 1A xb [ff|ee ff]: accumulator B offset
        EMAXD   D,SP                    ; IDX 18 1A xb [ff|ee ff]: accumulator D offset
        EMAXD   1,+X                    ; IDX 18 1A xb [ff|ee ff]: pre-increment
        EMAXD   8,-Y                    ; IDX 18 1A xb [ff|ee ff]: pre-decrement
        EMAXD   2,SP+                   ; IDX 18 1A xb [ff|ee ff]: post-increment
        EMAXD   7,X-                    ; IDX 18 1A xb [ff|ee ff]: post-decrement
        EMAXD   16,X                    ; IDX 18 1A xb [ff|ee ff]: 9-bit (just outside 5-bit)
        EMAXD   -17,Y                   ; IDX 18 1A xb [ff|ee ff]: 9-bit negative
        EMAXD   255,SP                  ; IDX 18 1A xb [ff|ee ff]: 9-bit max
        EMAXD   -256,X                  ; IDX 18 1A xb [ff|ee ff]: 9-bit min
        EMAXD   256,Y                   ; IDX 18 1A xb [ff|ee ff]: 16-bit (just outside 9-bit)
        EMAXD   $8000,X                 ; IDX 18 1A xb [ff|ee ff]: 16-bit large
        EMAXD   [$1234,X]               ; IDX 18 1A xb [ff|ee ff]: indexed indirect 16-bit
        EMAXD   [D,SP]                  ; IDX 18 1A xb [ff|ee ff]: accumulator D indirect
        EMIND   5,X                     ; IDX 18 1B xb [ff|ee ff]: 5-bit constant offset
        EMIND   -16,Y                   ; IDX 18 1B xb [ff|ee ff]: 5-bit, most negative
        EMIND   15,SP                   ; IDX 18 1B xb [ff|ee ff]: 5-bit, most positive
        EMIND   0,PC                    ; IDX 18 1B xb [ff|ee ff]: 5-bit, PC literal
        EMIND   A,X                     ; IDX 18 1B xb [ff|ee ff]: accumulator A offset
        EMIND   B,Y                     ; IDX 18 1B xb [ff|ee ff]: accumulator B offset
        EMIND   D,SP                    ; IDX 18 1B xb [ff|ee ff]: accumulator D offset
        EMIND   1,+X                    ; IDX 18 1B xb [ff|ee ff]: pre-increment
        EMIND   8,-Y                    ; IDX 18 1B xb [ff|ee ff]: pre-decrement
        EMIND   2,SP+                   ; IDX 18 1B xb [ff|ee ff]: post-increment
        EMIND   7,X-                    ; IDX 18 1B xb [ff|ee ff]: post-decrement
        EMIND   16,X                    ; IDX 18 1B xb [ff|ee ff]: 9-bit (just outside 5-bit)
        EMIND   -17,Y                   ; IDX 18 1B xb [ff|ee ff]: 9-bit negative
        EMIND   255,SP                  ; IDX 18 1B xb [ff|ee ff]: 9-bit max
        EMIND   -256,X                  ; IDX 18 1B xb [ff|ee ff]: 9-bit min
        EMIND   256,Y                   ; IDX 18 1B xb [ff|ee ff]: 16-bit (just outside 9-bit)
        EMIND   $8000,X                 ; IDX 18 1B xb [ff|ee ff]: 16-bit large
        EMIND   [$1234,X]               ; IDX 18 1B xb [ff|ee ff]: indexed indirect 16-bit
        EMIND   [D,SP]                  ; IDX 18 1B xb [ff|ee ff]: accumulator D indirect
        MAXM    5,X                     ; IDX 18 1C xb [ff|ee ff]: 5-bit constant offset
        MAXM    -16,Y                   ; IDX 18 1C xb [ff|ee ff]: 5-bit, most negative
        MAXM    15,SP                   ; IDX 18 1C xb [ff|ee ff]: 5-bit, most positive
        MAXM    0,PC                    ; IDX 18 1C xb [ff|ee ff]: 5-bit, PC literal
        MAXM    A,X                     ; IDX 18 1C xb [ff|ee ff]: accumulator A offset
        MAXM    B,Y                     ; IDX 18 1C xb [ff|ee ff]: accumulator B offset
        MAXM    D,SP                    ; IDX 18 1C xb [ff|ee ff]: accumulator D offset
        MAXM    1,+X                    ; IDX 18 1C xb [ff|ee ff]: pre-increment
        MAXM    8,-Y                    ; IDX 18 1C xb [ff|ee ff]: pre-decrement
        MAXM    2,SP+                   ; IDX 18 1C xb [ff|ee ff]: post-increment
        MAXM    7,X-                    ; IDX 18 1C xb [ff|ee ff]: post-decrement
        MAXM    16,X                    ; IDX 18 1C xb [ff|ee ff]: 9-bit (just outside 5-bit)
        MAXM    -17,Y                   ; IDX 18 1C xb [ff|ee ff]: 9-bit negative
        MAXM    255,SP                  ; IDX 18 1C xb [ff|ee ff]: 9-bit max
        MAXM    -256,X                  ; IDX 18 1C xb [ff|ee ff]: 9-bit min
        MAXM    256,Y                   ; IDX 18 1C xb [ff|ee ff]: 16-bit (just outside 9-bit)
        MAXM    $8000,X                 ; IDX 18 1C xb [ff|ee ff]: 16-bit large
        MAXM    [$1234,X]               ; IDX 18 1C xb [ff|ee ff]: indexed indirect 16-bit
        MAXM    [D,SP]                  ; IDX 18 1C xb [ff|ee ff]: accumulator D indirect
        MINM    5,X                     ; IDX 18 1D xb [ff|ee ff]: 5-bit constant offset
        MINM    -16,Y                   ; IDX 18 1D xb [ff|ee ff]: 5-bit, most negative
        MINM    15,SP                   ; IDX 18 1D xb [ff|ee ff]: 5-bit, most positive
        MINM    0,PC                    ; IDX 18 1D xb [ff|ee ff]: 5-bit, PC literal
        MINM    A,X                     ; IDX 18 1D xb [ff|ee ff]: accumulator A offset
        MINM    B,Y                     ; IDX 18 1D xb [ff|ee ff]: accumulator B offset
        MINM    D,SP                    ; IDX 18 1D xb [ff|ee ff]: accumulator D offset
        MINM    1,+X                    ; IDX 18 1D xb [ff|ee ff]: pre-increment
        MINM    8,-Y                    ; IDX 18 1D xb [ff|ee ff]: pre-decrement
        MINM    2,SP+                   ; IDX 18 1D xb [ff|ee ff]: post-increment
        MINM    7,X-                    ; IDX 18 1D xb [ff|ee ff]: post-decrement
        MINM    16,X                    ; IDX 18 1D xb [ff|ee ff]: 9-bit (just outside 5-bit)
        MINM    -17,Y                   ; IDX 18 1D xb [ff|ee ff]: 9-bit negative
        MINM    255,SP                  ; IDX 18 1D xb [ff|ee ff]: 9-bit max
        MINM    -256,X                  ; IDX 18 1D xb [ff|ee ff]: 9-bit min
        MINM    256,Y                   ; IDX 18 1D xb [ff|ee ff]: 16-bit (just outside 9-bit)
        MINM    $8000,X                 ; IDX 18 1D xb [ff|ee ff]: 16-bit large
        MINM    [$1234,X]               ; IDX 18 1D xb [ff|ee ff]: indexed indirect 16-bit
        MINM    [D,SP]                  ; IDX 18 1D xb [ff|ee ff]: accumulator D indirect
        EMAXM   5,X                     ; IDX 18 1E xb [ff|ee ff]: 5-bit constant offset
        EMAXM   -16,Y                   ; IDX 18 1E xb [ff|ee ff]: 5-bit, most negative
        EMAXM   15,SP                   ; IDX 18 1E xb [ff|ee ff]: 5-bit, most positive
        EMAXM   0,PC                    ; IDX 18 1E xb [ff|ee ff]: 5-bit, PC literal
        EMAXM   A,X                     ; IDX 18 1E xb [ff|ee ff]: accumulator A offset
        EMAXM   B,Y                     ; IDX 18 1E xb [ff|ee ff]: accumulator B offset
        EMAXM   D,SP                    ; IDX 18 1E xb [ff|ee ff]: accumulator D offset
        EMAXM   1,+X                    ; IDX 18 1E xb [ff|ee ff]: pre-increment
        EMAXM   8,-Y                    ; IDX 18 1E xb [ff|ee ff]: pre-decrement
        EMAXM   2,SP+                   ; IDX 18 1E xb [ff|ee ff]: post-increment
        EMAXM   7,X-                    ; IDX 18 1E xb [ff|ee ff]: post-decrement
        EMAXM   16,X                    ; IDX 18 1E xb [ff|ee ff]: 9-bit (just outside 5-bit)
        EMAXM   -17,Y                   ; IDX 18 1E xb [ff|ee ff]: 9-bit negative
        EMAXM   255,SP                  ; IDX 18 1E xb [ff|ee ff]: 9-bit max
        EMAXM   -256,X                  ; IDX 18 1E xb [ff|ee ff]: 9-bit min
        EMAXM   256,Y                   ; IDX 18 1E xb [ff|ee ff]: 16-bit (just outside 9-bit)
        EMAXM   $8000,X                 ; IDX 18 1E xb [ff|ee ff]: 16-bit large
        EMAXM   [$1234,X]               ; IDX 18 1E xb [ff|ee ff]: indexed indirect 16-bit
        EMAXM   [D,SP]                  ; IDX 18 1E xb [ff|ee ff]: accumulator D indirect
        EMINM   5,X                     ; IDX 18 1F xb [ff|ee ff]: 5-bit constant offset
        EMINM   -16,Y                   ; IDX 18 1F xb [ff|ee ff]: 5-bit, most negative
        EMINM   15,SP                   ; IDX 18 1F xb [ff|ee ff]: 5-bit, most positive
        EMINM   0,PC                    ; IDX 18 1F xb [ff|ee ff]: 5-bit, PC literal
        EMINM   A,X                     ; IDX 18 1F xb [ff|ee ff]: accumulator A offset
        EMINM   B,Y                     ; IDX 18 1F xb [ff|ee ff]: accumulator B offset
        EMINM   D,SP                    ; IDX 18 1F xb [ff|ee ff]: accumulator D offset
        EMINM   1,+X                    ; IDX 18 1F xb [ff|ee ff]: pre-increment
        EMINM   8,-Y                    ; IDX 18 1F xb [ff|ee ff]: pre-decrement
        EMINM   2,SP+                   ; IDX 18 1F xb [ff|ee ff]: post-increment
        EMINM   7,X-                    ; IDX 18 1F xb [ff|ee ff]: post-decrement
        EMINM   16,X                    ; IDX 18 1F xb [ff|ee ff]: 9-bit (just outside 5-bit)
        EMINM   -17,Y                   ; IDX 18 1F xb [ff|ee ff]: 9-bit negative
        EMINM   255,SP                  ; IDX 18 1F xb [ff|ee ff]: 9-bit max
        EMINM   -256,X                  ; IDX 18 1F xb [ff|ee ff]: 9-bit min
        EMINM   256,Y                   ; IDX 18 1F xb [ff|ee ff]: 16-bit (just outside 9-bit)
        EMINM   $8000,X                 ; IDX 18 1F xb [ff|ee ff]: 16-bit large
        EMINM   [$1234,X]               ; IDX 18 1F xb [ff|ee ff]: indexed indirect 16-bit
        EMINM   [D,SP]                  ; IDX 18 1F xb [ff|ee ff]: accumulator D indirect
        LBRA    *                       ; REL16 18 20 qq rr
        LBRN    *                       ; REL16 18 21 qq rr
        LBHI    *                       ; REL16 18 22 qq rr
        LBLS    *                       ; REL16 18 23 qq rr
        LBCC    *                       ; REL16 18 24 qq rr
        LBCS    *                       ; REL16 18 25 qq rr
        LBNE    *                       ; REL16 18 26 qq rr
        LBEQ    *                       ; REL16 18 27 qq rr
        LBVC    *                       ; REL16 18 28 qq rr
        LBVS    *                       ; REL16 18 29 qq rr
        LBPL    *                       ; REL16 18 2A qq rr
        LBMI    *                       ; REL16 18 2B qq rr
        LBGE    *                       ; REL16 18 2C qq rr
        LBLT    *                       ; REL16 18 2D qq rr
        LBGT    *                       ; REL16 18 2E qq rr
        LBLE    *                       ; REL16 18 2F qq rr
        REV                             ; INH 18 3A
        REVW                            ; INH 18 3B
        WAV                             ; INH 18 3C
        TBL     5,X                     ; IDX 18 3D xb [ff|ee ff]: 5-bit constant offset
        TBL     -16,Y                   ; IDX 18 3D xb [ff|ee ff]: 5-bit, most negative
        TBL     15,SP                   ; IDX 18 3D xb [ff|ee ff]: 5-bit, most positive
        TBL     0,PC                    ; IDX 18 3D xb [ff|ee ff]: 5-bit, PC literal
        TBL     A,X                     ; IDX 18 3D xb [ff|ee ff]: accumulator A offset
        TBL     B,Y                     ; IDX 18 3D xb [ff|ee ff]: accumulator B offset
        TBL     D,SP                    ; IDX 18 3D xb [ff|ee ff]: accumulator D offset
        TBL     1,+X                    ; IDX 18 3D xb [ff|ee ff]: pre-increment
        TBL     8,-Y                    ; IDX 18 3D xb [ff|ee ff]: pre-decrement
        TBL     2,SP+                   ; IDX 18 3D xb [ff|ee ff]: post-increment
        TBL     7,X-                    ; IDX 18 3D xb [ff|ee ff]: post-decrement
        STOP                            ; INH 18 3E
        ETBL    5,X                     ; IDX 18 3F xb [ff|ee ff]: 5-bit constant offset
        ETBL    -16,Y                   ; IDX 18 3F xb [ff|ee ff]: 5-bit, most negative
        ETBL    15,SP                   ; IDX 18 3F xb [ff|ee ff]: 5-bit, most positive
        ETBL    0,PC                    ; IDX 18 3F xb [ff|ee ff]: 5-bit, PC literal
        ETBL    A,X                     ; IDX 18 3F xb [ff|ee ff]: accumulator A offset
        ETBL    B,Y                     ; IDX 18 3F xb [ff|ee ff]: accumulator B offset
        ETBL    D,SP                    ; IDX 18 3F xb [ff|ee ff]: accumulator D offset
        ETBL    1,+X                    ; IDX 18 3F xb [ff|ee ff]: pre-increment
        ETBL    8,-Y                    ; IDX 18 3F xb [ff|ee ff]: pre-decrement
        ETBL    2,SP+                   ; IDX 18 3F xb [ff|ee ff]: post-increment
        ETBL    7,X-                    ; IDX 18 3F xb [ff|ee ff]: post-decrement
        TRAP    #$30                    ; TRAP 18 30

; ===== Part 2: probes for UNCERTAIN behaviour ==============================================

; P1 (encoder.ts "forward reference"): an absolute value <= $FF that is defined AFTER its use.
;    The clone assembles it EXTENDED (B6 0040) because pass 1 does not know it yet.
AmP1:       LDAA  AmFwdDir              ; direct (96 40) or extended (B6 0040)?
            STAA  AmFwdDir
            BSET  AmFwdDir,#$01
            LDAA  AmBackDir             ; defined before use: direct (96 41)
; P2: forward-referenced indexed offset: the clone uses 16 bits (A6 E2 0004).
            LDAA  AmFwdOff,X            ; 5-bit (A6 04) or 16-bit (A6 E2 0004)?
            LDAA  AmBackOff,X           ; known: 5-bit (A6 04)
; P3: PC-relative (PCR) offsets, backward and forward, all sizes.
AmP3:       LDAA  AmP3,PCR              ; backward, 5-bit
            LDAA  AmP1,PCR              ; backward, 9-bit
            LDAA  AmEntry,PCR           ; backward, 16-bit
            LDAA  AmP3Fwd,PCR           ; forward: clone uses 16-bit
            LDAA  [AmP3,PCR]            ; indirect PCR
AmP3Fwd:    NOP
; P4: two labels at one address - which one gets the symbol size (clone: first allocated)?
AmP4a:
AmP4b:      NOP
            NOP
            BRA   AmP4b                 ; references AmP4b first
; P5: unlabelled data in a code section -> one VARnnnnn per DC line?
            DC.B  $AA
            DC.W  $BBCC
            DS.B  1                     ; unlabelled DS: VAR or not?
; P6: symbol order of a local code label that is never referenced (clone: last, in definition order).
AmNeverUsed: NOP
; P7: listing values of conditional directives (IF shows the expression value).
            IF    1+1
            NOP
            ELSE
            SWI
            ENDIF
            IFEQ  0
            IFDEF AmEntry               ; listed value for IFDEF?
            NOP
            ENDIF
            ENDIF
            IFC   'abc','abc'
            NOP
            ENDIF
            IFNE  0
            SWI                         ; skipped line (CLIST ON default)
            ENDIF
; P8: macro listing - Rel. column 'm' line numbers, '+' marker column, \@ labels, MEXIT.
AmMac:      MACRO
\@L:        LDAA  \1
            IFC   '\2',''
            MEXIT
            ENDIF
            STAA  \2
            ENDM
            AmMac #1,AmByte
            AmMac #2
            AmMac.B #3,AmByte           ; \0 = B (unused here)
; P10: listing-control lines and the .dbg/Abs numbering.
            NOLIST
            NOP                         ; not listed
            LIST
            MLIST OFF
            AmMac #4,AmByte             ; expansion not listed
            MLIST ON
            CLIST OFF
            IFNE  0
            SWI                         ; skipped and not listed with CLIST OFF
            ENDIF
            CLIST ON
; P11: TAB characters (TABS 8 expansion in the listing?)
	LDAA	#1	; tab-separated fields
; P13: low byte of a 16-bit register (TFR XL,A spelling: see allmodes_probes.asm P13).
            TFR   X,A
; P14: label on ALIGN / EVEN lines (before or after the padding?).
            NOP
AmAlign:    EVEN
AmAlign4:   ALIGN 4
; P15: branches and long branches to an external symbol / other section.
            LBRA  AmExtern              ; PCREL16 relocation, in-place FFFE
            LBEQ  AmFar                 ; other section
            JSR   AmExtern              ; ABS16
            LDX   #AmExtern+2           ; ABS16 with in-place addend 2
            LDD   AmBuf+3               ; label + addend
            DC.W  AmExtern2, *          ; DC.W of an external and of the location counter
; P16: expression precedence and constant forms (MASM suffix forms and unary ! are in allmodes_probes.asm).
            DC.B  2+3*4, (2+3)*4, 1<<3|1, ~0&$FF, -1&$FF, 7%3, 10/3
            DC.B  $1F, %101, @17, 'A', 'A'+1
            DC.W  HIGH($1234), LOW($1234), PAGE($123456)
            DC.B  3>2, 3<2, 3=3, 3<>3, 3!=4, 3>=3, 3<=2
; P17: include (listed with 'i' only without -Li; .dbg numbering with/without -Li).
            INCLUDE 'allmodes_inc.inc'
            LDAA  #AmIncConst
; P18: SET redefinition and its listing value.
AmCnt:      SET   1
            DC.B  AmCnt
AmCnt:      SET   AmCnt+1
            DC.B  AmCnt
; P19: OFFSET section (struct offsets).
            OFFSET 0
AmOffA:     DS.B  1
AmOffB:     DS.W  1
AmOffSize:  EQU   *
AllModes2:  SECTION
            LDAA  AmOffB,X
            LDAA  #AmOffSize
; P20: absolute (ORG) code: labels are absolute, branches resolved, line info?
            ORG   $3F00
AmOrgCode:  LDAA  AmOrgData             ; absolute label < $100? no: extended
            BRA   AmOrgCode
            JMP   AmOrgCode
AmOrgData:  DC.B  1
            ORG   $0080
AmZeroPage: DS.B  2                     ; DS in an ORG section (NOBITS)
            ORG   $3F80
            LDAA  AmZeroPage            ; absolute label in the direct page: direct
            DC.W  AmEntry               ; vector-style entry: relocation in an ORG section

; The probe symbols defined late (see P1/P2):
AmFwdDir:   EQU   $40
AmFwdOff:   EQU   4
