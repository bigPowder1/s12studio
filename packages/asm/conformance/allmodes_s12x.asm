;*****************************************************************************************
;* allmodes_s12x.asm - S12 Studio assembler conformance source                           *
;*                                                                                       *
;* Every instruction form and indexed variant that exists ONLY on the CPU12X (HCS12X):   *
;* new instructions, S12X MOVB/MOVW operand combinations, global (G...) accesses,        *
;* TFR/EXG/SEX with the S12X register pairs. The CPU12X register spellings that no CW    *
;* document confirms (CCRW, CCRH, CCRL, XH, XL, ...) are in a separate block that        *
;* -DNO_XREGS switches off.                                                              *
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

            XDEF  AxEntry

AmFarCode:  SECTION
AmFar:      RTC                     ; target of CALL

AllModesX:  SECTION
AxEntry:
        SEX     D,X                     ; TFR_EXG B7 eb S12X SEX D,X
        MOVW    #$1234,16,X             ; MOV_IMM_IDX 18 00 xb jj kk: dst 9-bit (just outside 5-bit)
        MOVW    #$1234,-17,Y            ; MOV_IMM_IDX 18 00 xb jj kk: dst 9-bit negative
        MOVW    #$1234,255,SP           ; MOV_IMM_IDX 18 00 xb jj kk: dst 9-bit max
        MOVW    #$1234,-256,X           ; MOV_IMM_IDX 18 00 xb jj kk: dst 9-bit min
        MOVW    #$1234,256,Y            ; MOV_IMM_IDX 18 00 xb jj kk: dst 16-bit (just outside 9-bit)
        MOVW    #$1234,$8000,X          ; MOV_IMM_IDX 18 00 xb jj kk: dst 16-bit large
        MOVW    #$1234,[$1234,X]        ; MOV_IMM_IDX 18 00 xb jj kk: dst indexed indirect 16-bit
        MOVW    #$1234,[D,SP]           ; MOV_IMM_IDX 18 00 xb jj kk: dst accumulator D indirect
        MOVB    #$5A,16,X               ; MOV_IMM_IDX 18 08 xb ii: dst 9-bit (just outside 5-bit)
        MOVB    #$5A,-17,Y              ; MOV_IMM_IDX 18 08 xb ii: dst 9-bit negative
        MOVB    #$5A,255,SP             ; MOV_IMM_IDX 18 08 xb ii: dst 9-bit max
        MOVB    #$5A,-256,X             ; MOV_IMM_IDX 18 08 xb ii: dst 9-bit min
        MOVB    #$5A,256,Y              ; MOV_IMM_IDX 18 08 xb ii: dst 16-bit (just outside 9-bit)
        MOVB    #$5A,$8000,X            ; MOV_IMM_IDX 18 08 xb ii: dst 16-bit large
        MOVB    #$5A,[$1234,X]          ; MOV_IMM_IDX 18 08 xb ii: dst indexed indirect 16-bit
        MOVB    #$5A,[D,SP]             ; MOV_IMM_IDX 18 08 xb ii: dst accumulator D indirect
        MOVW    $1234,16,X              ; MOV_EXT_IDX 18 01 xb hh ll: dst 9-bit (just outside 5-bit)
        MOVW    $1234,-17,Y             ; MOV_EXT_IDX 18 01 xb hh ll: dst 9-bit negative
        MOVW    $1234,255,SP            ; MOV_EXT_IDX 18 01 xb hh ll: dst 9-bit max
        MOVW    $1234,-256,X            ; MOV_EXT_IDX 18 01 xb hh ll: dst 9-bit min
        MOVW    $1234,256,Y             ; MOV_EXT_IDX 18 01 xb hh ll: dst 16-bit (just outside 9-bit)
        MOVW    $1234,$8000,X           ; MOV_EXT_IDX 18 01 xb hh ll: dst 16-bit large
        MOVW    $1234,[$1234,X]         ; MOV_EXT_IDX 18 01 xb hh ll: dst indexed indirect 16-bit
        MOVW    $1234,[D,SP]            ; MOV_EXT_IDX 18 01 xb hh ll: dst accumulator D indirect
        MOVB    $1234,16,X              ; MOV_EXT_IDX 18 09 xb hh ll: dst 9-bit (just outside 5-bit)
        MOVB    $1234,-17,Y             ; MOV_EXT_IDX 18 09 xb hh ll: dst 9-bit negative
        MOVB    $1234,255,SP            ; MOV_EXT_IDX 18 09 xb hh ll: dst 9-bit max
        MOVB    $1234,-256,X            ; MOV_EXT_IDX 18 09 xb hh ll: dst 9-bit min
        MOVB    $1234,256,Y             ; MOV_EXT_IDX 18 09 xb hh ll: dst 16-bit (just outside 9-bit)
        MOVB    $1234,$8000,X           ; MOV_EXT_IDX 18 09 xb hh ll: dst 16-bit large
        MOVB    $1234,[$1234,X]         ; MOV_EXT_IDX 18 09 xb hh ll: dst indexed indirect 16-bit
        MOVB    $1234,[D,SP]            ; MOV_EXT_IDX 18 09 xb hh ll: dst accumulator D indirect
        MOVW    D,SP,16,X               ; MOV_IDX_IDX 18 02 xb xb: accumulator D offset -> 9-bit (just outside 5-bit)
        MOVW    1,+X,-17,Y              ; MOV_IDX_IDX 18 02 xb xb: pre-increment -> 9-bit negative
        MOVW    8,-Y,255,SP             ; MOV_IDX_IDX 18 02 xb xb: pre-decrement -> 9-bit max
        MOVW    2,SP+,-256,X            ; MOV_IDX_IDX 18 02 xb xb: post-increment -> 9-bit min
        MOVW    7,X-,256,Y              ; MOV_IDX_IDX 18 02 xb xb: post-decrement -> 16-bit (just outside 9-bit)
        MOVW    16,X,$8000,X            ; MOV_IDX_IDX 18 02 xb xb: 9-bit (just outside 5-bit) -> 16-bit large
        MOVW    -17,Y,[$1234,X]         ; MOV_IDX_IDX 18 02 xb xb: 9-bit negative -> indexed indirect 16-bit
        MOVW    255,SP,[D,SP]           ; MOV_IDX_IDX 18 02 xb xb: 9-bit max -> accumulator D indirect
        MOVW    -256,X,5,X              ; MOV_IDX_IDX 18 02 xb xb: 9-bit min -> 5-bit constant offset
        MOVW    256,Y,-16,Y             ; MOV_IDX_IDX 18 02 xb xb: 16-bit (just outside 9-bit) -> 5-bit, most negative
        MOVW    $8000,X,15,SP           ; MOV_IDX_IDX 18 02 xb xb: 16-bit large -> 5-bit, most positive
        MOVW    [$1234,X],0,PC          ; MOV_IDX_IDX 18 02 xb xb: indexed indirect 16-bit -> 5-bit, PC literal
        MOVW    [D,SP],A,X              ; MOV_IDX_IDX 18 02 xb xb: accumulator D indirect -> accumulator A offset
        MOVB    D,SP,16,X               ; MOV_IDX_IDX 18 0A xb xb: accumulator D offset -> 9-bit (just outside 5-bit)
        MOVB    1,+X,-17,Y              ; MOV_IDX_IDX 18 0A xb xb: pre-increment -> 9-bit negative
        MOVB    8,-Y,255,SP             ; MOV_IDX_IDX 18 0A xb xb: pre-decrement -> 9-bit max
        MOVB    2,SP+,-256,X            ; MOV_IDX_IDX 18 0A xb xb: post-increment -> 9-bit min
        MOVB    7,X-,256,Y              ; MOV_IDX_IDX 18 0A xb xb: post-decrement -> 16-bit (just outside 9-bit)
        MOVB    16,X,$8000,X            ; MOV_IDX_IDX 18 0A xb xb: 9-bit (just outside 5-bit) -> 16-bit large
        MOVB    -17,Y,[$1234,X]         ; MOV_IDX_IDX 18 0A xb xb: 9-bit negative -> indexed indirect 16-bit
        MOVB    255,SP,[D,SP]           ; MOV_IDX_IDX 18 0A xb xb: 9-bit max -> accumulator D indirect
        MOVB    -256,X,5,X              ; MOV_IDX_IDX 18 0A xb xb: 9-bit min -> 5-bit constant offset
        MOVB    256,Y,-16,Y             ; MOV_IDX_IDX 18 0A xb xb: 16-bit (just outside 9-bit) -> 5-bit, most negative
        MOVB    $8000,X,15,SP           ; MOV_IDX_IDX 18 0A xb xb: 16-bit large -> 5-bit, most positive
        MOVB    [$1234,X],0,PC          ; MOV_IDX_IDX 18 0A xb xb: indexed indirect 16-bit -> 5-bit, PC literal
        MOVB    [D,SP],A,X              ; MOV_IDX_IDX 18 0A xb xb: accumulator D indirect -> accumulator A offset
        MOVW    16,X,$1234              ; MOV_IDX_EXT 18 05 xb hh ll: src 9-bit (just outside 5-bit)
        MOVW    -17,Y,$1234             ; MOV_IDX_EXT 18 05 xb hh ll: src 9-bit negative
        MOVW    255,SP,$1234            ; MOV_IDX_EXT 18 05 xb hh ll: src 9-bit max
        MOVW    -256,X,$1234            ; MOV_IDX_EXT 18 05 xb hh ll: src 9-bit min
        MOVW    256,Y,$1234             ; MOV_IDX_EXT 18 05 xb hh ll: src 16-bit (just outside 9-bit)
        MOVW    $8000,X,$1234           ; MOV_IDX_EXT 18 05 xb hh ll: src 16-bit large
        MOVW    [$1234,X],$1234         ; MOV_IDX_EXT 18 05 xb hh ll: src indexed indirect 16-bit
        MOVW    [D,SP],$1234            ; MOV_IDX_EXT 18 05 xb hh ll: src accumulator D indirect
        MOVB    16,X,$1234              ; MOV_IDX_EXT 18 0D xb hh ll: src 9-bit (just outside 5-bit)
        MOVB    -17,Y,$1234             ; MOV_IDX_EXT 18 0D xb hh ll: src 9-bit negative
        MOVB    255,SP,$1234            ; MOV_IDX_EXT 18 0D xb hh ll: src 9-bit max
        MOVB    -256,X,$1234            ; MOV_IDX_EXT 18 0D xb hh ll: src 9-bit min
        MOVB    256,Y,$1234             ; MOV_IDX_EXT 18 0D xb hh ll: src 16-bit (just outside 9-bit)
        MOVB    $8000,X,$1234           ; MOV_IDX_EXT 18 0D xb hh ll: src 16-bit large
        MOVB    [$1234,X],$1234         ; MOV_IDX_EXT 18 0D xb hh ll: src indexed indirect 16-bit
        MOVB    [D,SP],$1234            ; MOV_IDX_EXT 18 0D xb hh ll: src accumulator D indirect
        BTAS    $40,#$5A                ; BIT_DIR 18 35 dd mm [S12X]
        BTAS    $1234,#$5A              ; BIT_EXT 18 36 hh ll mm [S12X]
        BTAS    5,X,#$5A                ; BIT_IDX 18 37 xb [ff|ee ff] mm [S12X]: 5-bit constant offset
        BTAS    -16,Y,#$5A              ; BIT_IDX 18 37 xb [ff|ee ff] mm [S12X]: 5-bit, most negative
        BTAS    15,SP,#$5A              ; BIT_IDX 18 37 xb [ff|ee ff] mm [S12X]: 5-bit, most positive
        BTAS    0,PC,#$5A               ; BIT_IDX 18 37 xb [ff|ee ff] mm [S12X]: 5-bit, PC literal
        BTAS    A,X,#$5A                ; BIT_IDX 18 37 xb [ff|ee ff] mm [S12X]: accumulator A offset
        BTAS    B,Y,#$5A                ; BIT_IDX 18 37 xb [ff|ee ff] mm [S12X]: accumulator B offset
        BTAS    D,SP,#$5A               ; BIT_IDX 18 37 xb [ff|ee ff] mm [S12X]: accumulator D offset
        BTAS    1,+X,#$5A               ; BIT_IDX 18 37 xb [ff|ee ff] mm [S12X]: pre-increment
        BTAS    8,-Y,#$5A               ; BIT_IDX 18 37 xb [ff|ee ff] mm [S12X]: pre-decrement
        BTAS    2,SP+,#$5A              ; BIT_IDX 18 37 xb [ff|ee ff] mm [S12X]: post-increment
        BTAS    7,X-,#$5A               ; BIT_IDX 18 37 xb [ff|ee ff] mm [S12X]: post-decrement
        BTAS    16,X,#$5A               ; BIT_IDX 18 37 xb [ff|ee ff] mm [S12X]: 9-bit (just outside 5-bit)
        BTAS    -17,Y,#$5A              ; BIT_IDX 18 37 xb [ff|ee ff] mm [S12X]: 9-bit negative
        BTAS    255,SP,#$5A             ; BIT_IDX 18 37 xb [ff|ee ff] mm [S12X]: 9-bit max
        BTAS    -256,X,#$5A             ; BIT_IDX 18 37 xb [ff|ee ff] mm [S12X]: 9-bit min
        BTAS    256,Y,#$5A              ; BIT_IDX 18 37 xb [ff|ee ff] mm [S12X]: 16-bit (just outside 9-bit)
        BTAS    $8000,X,#$5A            ; BIT_IDX 18 37 xb [ff|ee ff] mm [S12X]: 16-bit large
        PULCW                           ; INH 18 38 [S12X]
        PSHCW                           ; INH 18 39 [S12X]
        NEGX                            ; INH 18 40 [S12X]
        NEGY                            ; INH 18 50 [S12X]
        NEGW    5,X                     ; IDX 18 60 xb [ff|ee ff] [S12X]: 5-bit constant offset
        NEGW    -16,Y                   ; IDX 18 60 xb [ff|ee ff] [S12X]: 5-bit, most negative
        NEGW    15,SP                   ; IDX 18 60 xb [ff|ee ff] [S12X]: 5-bit, most positive
        NEGW    0,PC                    ; IDX 18 60 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        NEGW    A,X                     ; IDX 18 60 xb [ff|ee ff] [S12X]: accumulator A offset
        NEGW    B,Y                     ; IDX 18 60 xb [ff|ee ff] [S12X]: accumulator B offset
        NEGW    D,SP                    ; IDX 18 60 xb [ff|ee ff] [S12X]: accumulator D offset
        NEGW    1,+X                    ; IDX 18 60 xb [ff|ee ff] [S12X]: pre-increment
        NEGW    8,-Y                    ; IDX 18 60 xb [ff|ee ff] [S12X]: pre-decrement
        NEGW    2,SP+                   ; IDX 18 60 xb [ff|ee ff] [S12X]: post-increment
        NEGW    7,X-                    ; IDX 18 60 xb [ff|ee ff] [S12X]: post-decrement
        NEGW    16,X                    ; IDX 18 60 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        NEGW    -17,Y                   ; IDX 18 60 xb [ff|ee ff] [S12X]: 9-bit negative
        NEGW    255,SP                  ; IDX 18 60 xb [ff|ee ff] [S12X]: 9-bit max
        NEGW    -256,X                  ; IDX 18 60 xb [ff|ee ff] [S12X]: 9-bit min
        NEGW    256,Y                   ; IDX 18 60 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        NEGW    $8000,X                 ; IDX 18 60 xb [ff|ee ff] [S12X]: 16-bit large
        NEGW    [$1234,X]               ; IDX 18 60 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        NEGW    [D,SP]                  ; IDX 18 60 xb [ff|ee ff] [S12X]: accumulator D indirect
        NEGW    $1234                   ; EXT 18 70 hh ll [S12X]
        NEGW    >$40                    ; EXT 18 70 hh ll [S12X] (forced extended)
        COMX                            ; INH 18 41 [S12X]
        COMY                            ; INH 18 51 [S12X]
        COMW    5,X                     ; IDX 18 61 xb [ff|ee ff] [S12X]: 5-bit constant offset
        COMW    -16,Y                   ; IDX 18 61 xb [ff|ee ff] [S12X]: 5-bit, most negative
        COMW    15,SP                   ; IDX 18 61 xb [ff|ee ff] [S12X]: 5-bit, most positive
        COMW    0,PC                    ; IDX 18 61 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        COMW    A,X                     ; IDX 18 61 xb [ff|ee ff] [S12X]: accumulator A offset
        COMW    B,Y                     ; IDX 18 61 xb [ff|ee ff] [S12X]: accumulator B offset
        COMW    D,SP                    ; IDX 18 61 xb [ff|ee ff] [S12X]: accumulator D offset
        COMW    1,+X                    ; IDX 18 61 xb [ff|ee ff] [S12X]: pre-increment
        COMW    8,-Y                    ; IDX 18 61 xb [ff|ee ff] [S12X]: pre-decrement
        COMW    2,SP+                   ; IDX 18 61 xb [ff|ee ff] [S12X]: post-increment
        COMW    7,X-                    ; IDX 18 61 xb [ff|ee ff] [S12X]: post-decrement
        COMW    16,X                    ; IDX 18 61 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        COMW    -17,Y                   ; IDX 18 61 xb [ff|ee ff] [S12X]: 9-bit negative
        COMW    255,SP                  ; IDX 18 61 xb [ff|ee ff] [S12X]: 9-bit max
        COMW    -256,X                  ; IDX 18 61 xb [ff|ee ff] [S12X]: 9-bit min
        COMW    256,Y                   ; IDX 18 61 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        COMW    $8000,X                 ; IDX 18 61 xb [ff|ee ff] [S12X]: 16-bit large
        COMW    [$1234,X]               ; IDX 18 61 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        COMW    [D,SP]                  ; IDX 18 61 xb [ff|ee ff] [S12X]: accumulator D indirect
        COMW    $1234                   ; EXT 18 71 hh ll [S12X]
        COMW    >$40                    ; EXT 18 71 hh ll [S12X] (forced extended)
        INCX                            ; INH 18 42 [S12X]
        INCY                            ; INH 18 52 [S12X]
        INCW    5,X                     ; IDX 18 62 xb [ff|ee ff] [S12X]: 5-bit constant offset
        INCW    -16,Y                   ; IDX 18 62 xb [ff|ee ff] [S12X]: 5-bit, most negative
        INCW    15,SP                   ; IDX 18 62 xb [ff|ee ff] [S12X]: 5-bit, most positive
        INCW    0,PC                    ; IDX 18 62 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        INCW    A,X                     ; IDX 18 62 xb [ff|ee ff] [S12X]: accumulator A offset
        INCW    B,Y                     ; IDX 18 62 xb [ff|ee ff] [S12X]: accumulator B offset
        INCW    D,SP                    ; IDX 18 62 xb [ff|ee ff] [S12X]: accumulator D offset
        INCW    1,+X                    ; IDX 18 62 xb [ff|ee ff] [S12X]: pre-increment
        INCW    8,-Y                    ; IDX 18 62 xb [ff|ee ff] [S12X]: pre-decrement
        INCW    2,SP+                   ; IDX 18 62 xb [ff|ee ff] [S12X]: post-increment
        INCW    7,X-                    ; IDX 18 62 xb [ff|ee ff] [S12X]: post-decrement
        INCW    16,X                    ; IDX 18 62 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        INCW    -17,Y                   ; IDX 18 62 xb [ff|ee ff] [S12X]: 9-bit negative
        INCW    255,SP                  ; IDX 18 62 xb [ff|ee ff] [S12X]: 9-bit max
        INCW    -256,X                  ; IDX 18 62 xb [ff|ee ff] [S12X]: 9-bit min
        INCW    256,Y                   ; IDX 18 62 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        INCW    $8000,X                 ; IDX 18 62 xb [ff|ee ff] [S12X]: 16-bit large
        INCW    [$1234,X]               ; IDX 18 62 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        INCW    [D,SP]                  ; IDX 18 62 xb [ff|ee ff] [S12X]: accumulator D indirect
        INCW    $1234                   ; EXT 18 72 hh ll [S12X]
        INCW    >$40                    ; EXT 18 72 hh ll [S12X] (forced extended)
        DECX                            ; INH 18 43 [S12X]
        DECY                            ; INH 18 53 [S12X]
        DECW    5,X                     ; IDX 18 63 xb [ff|ee ff] [S12X]: 5-bit constant offset
        DECW    -16,Y                   ; IDX 18 63 xb [ff|ee ff] [S12X]: 5-bit, most negative
        DECW    15,SP                   ; IDX 18 63 xb [ff|ee ff] [S12X]: 5-bit, most positive
        DECW    0,PC                    ; IDX 18 63 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        DECW    A,X                     ; IDX 18 63 xb [ff|ee ff] [S12X]: accumulator A offset
        DECW    B,Y                     ; IDX 18 63 xb [ff|ee ff] [S12X]: accumulator B offset
        DECW    D,SP                    ; IDX 18 63 xb [ff|ee ff] [S12X]: accumulator D offset
        DECW    1,+X                    ; IDX 18 63 xb [ff|ee ff] [S12X]: pre-increment
        DECW    8,-Y                    ; IDX 18 63 xb [ff|ee ff] [S12X]: pre-decrement
        DECW    2,SP+                   ; IDX 18 63 xb [ff|ee ff] [S12X]: post-increment
        DECW    7,X-                    ; IDX 18 63 xb [ff|ee ff] [S12X]: post-decrement
        DECW    16,X                    ; IDX 18 63 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        DECW    -17,Y                   ; IDX 18 63 xb [ff|ee ff] [S12X]: 9-bit negative
        DECW    255,SP                  ; IDX 18 63 xb [ff|ee ff] [S12X]: 9-bit max
        DECW    -256,X                  ; IDX 18 63 xb [ff|ee ff] [S12X]: 9-bit min
        DECW    256,Y                   ; IDX 18 63 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        DECW    $8000,X                 ; IDX 18 63 xb [ff|ee ff] [S12X]: 16-bit large
        DECW    [$1234,X]               ; IDX 18 63 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        DECW    [D,SP]                  ; IDX 18 63 xb [ff|ee ff] [S12X]: accumulator D indirect
        DECW    $1234                   ; EXT 18 73 hh ll [S12X]
        DECW    >$40                    ; EXT 18 73 hh ll [S12X] (forced extended)
        LSRX                            ; INH 18 44 [S12X]
        LSRY                            ; INH 18 54 [S12X]
        LSRW    5,X                     ; IDX 18 64 xb [ff|ee ff] [S12X]: 5-bit constant offset
        LSRW    -16,Y                   ; IDX 18 64 xb [ff|ee ff] [S12X]: 5-bit, most negative
        LSRW    15,SP                   ; IDX 18 64 xb [ff|ee ff] [S12X]: 5-bit, most positive
        LSRW    0,PC                    ; IDX 18 64 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        LSRW    A,X                     ; IDX 18 64 xb [ff|ee ff] [S12X]: accumulator A offset
        LSRW    B,Y                     ; IDX 18 64 xb [ff|ee ff] [S12X]: accumulator B offset
        LSRW    D,SP                    ; IDX 18 64 xb [ff|ee ff] [S12X]: accumulator D offset
        LSRW    1,+X                    ; IDX 18 64 xb [ff|ee ff] [S12X]: pre-increment
        LSRW    8,-Y                    ; IDX 18 64 xb [ff|ee ff] [S12X]: pre-decrement
        LSRW    2,SP+                   ; IDX 18 64 xb [ff|ee ff] [S12X]: post-increment
        LSRW    7,X-                    ; IDX 18 64 xb [ff|ee ff] [S12X]: post-decrement
        LSRW    16,X                    ; IDX 18 64 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        LSRW    -17,Y                   ; IDX 18 64 xb [ff|ee ff] [S12X]: 9-bit negative
        LSRW    255,SP                  ; IDX 18 64 xb [ff|ee ff] [S12X]: 9-bit max
        LSRW    -256,X                  ; IDX 18 64 xb [ff|ee ff] [S12X]: 9-bit min
        LSRW    256,Y                   ; IDX 18 64 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        LSRW    $8000,X                 ; IDX 18 64 xb [ff|ee ff] [S12X]: 16-bit large
        LSRW    [$1234,X]               ; IDX 18 64 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        LSRW    [D,SP]                  ; IDX 18 64 xb [ff|ee ff] [S12X]: accumulator D indirect
        LSRW    $1234                   ; EXT 18 74 hh ll [S12X]
        LSRW    >$40                    ; EXT 18 74 hh ll [S12X] (forced extended)
        ROLX                            ; INH 18 45 [S12X]
        ROLY                            ; INH 18 55 [S12X]
        ROLW    5,X                     ; IDX 18 65 xb [ff|ee ff] [S12X]: 5-bit constant offset
        ROLW    -16,Y                   ; IDX 18 65 xb [ff|ee ff] [S12X]: 5-bit, most negative
        ROLW    15,SP                   ; IDX 18 65 xb [ff|ee ff] [S12X]: 5-bit, most positive
        ROLW    0,PC                    ; IDX 18 65 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        ROLW    A,X                     ; IDX 18 65 xb [ff|ee ff] [S12X]: accumulator A offset
        ROLW    B,Y                     ; IDX 18 65 xb [ff|ee ff] [S12X]: accumulator B offset
        ROLW    D,SP                    ; IDX 18 65 xb [ff|ee ff] [S12X]: accumulator D offset
        ROLW    1,+X                    ; IDX 18 65 xb [ff|ee ff] [S12X]: pre-increment
        ROLW    8,-Y                    ; IDX 18 65 xb [ff|ee ff] [S12X]: pre-decrement
        ROLW    2,SP+                   ; IDX 18 65 xb [ff|ee ff] [S12X]: post-increment
        ROLW    7,X-                    ; IDX 18 65 xb [ff|ee ff] [S12X]: post-decrement
        ROLW    16,X                    ; IDX 18 65 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        ROLW    -17,Y                   ; IDX 18 65 xb [ff|ee ff] [S12X]: 9-bit negative
        ROLW    255,SP                  ; IDX 18 65 xb [ff|ee ff] [S12X]: 9-bit max
        ROLW    -256,X                  ; IDX 18 65 xb [ff|ee ff] [S12X]: 9-bit min
        ROLW    256,Y                   ; IDX 18 65 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        ROLW    $8000,X                 ; IDX 18 65 xb [ff|ee ff] [S12X]: 16-bit large
        ROLW    [$1234,X]               ; IDX 18 65 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        ROLW    [D,SP]                  ; IDX 18 65 xb [ff|ee ff] [S12X]: accumulator D indirect
        ROLW    $1234                   ; EXT 18 75 hh ll [S12X]
        ROLW    >$40                    ; EXT 18 75 hh ll [S12X] (forced extended)
        RORX                            ; INH 18 46 [S12X]
        RORY                            ; INH 18 56 [S12X]
        RORW    5,X                     ; IDX 18 66 xb [ff|ee ff] [S12X]: 5-bit constant offset
        RORW    -16,Y                   ; IDX 18 66 xb [ff|ee ff] [S12X]: 5-bit, most negative
        RORW    15,SP                   ; IDX 18 66 xb [ff|ee ff] [S12X]: 5-bit, most positive
        RORW    0,PC                    ; IDX 18 66 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        RORW    A,X                     ; IDX 18 66 xb [ff|ee ff] [S12X]: accumulator A offset
        RORW    B,Y                     ; IDX 18 66 xb [ff|ee ff] [S12X]: accumulator B offset
        RORW    D,SP                    ; IDX 18 66 xb [ff|ee ff] [S12X]: accumulator D offset
        RORW    1,+X                    ; IDX 18 66 xb [ff|ee ff] [S12X]: pre-increment
        RORW    8,-Y                    ; IDX 18 66 xb [ff|ee ff] [S12X]: pre-decrement
        RORW    2,SP+                   ; IDX 18 66 xb [ff|ee ff] [S12X]: post-increment
        RORW    7,X-                    ; IDX 18 66 xb [ff|ee ff] [S12X]: post-decrement
        RORW    16,X                    ; IDX 18 66 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        RORW    -17,Y                   ; IDX 18 66 xb [ff|ee ff] [S12X]: 9-bit negative
        RORW    255,SP                  ; IDX 18 66 xb [ff|ee ff] [S12X]: 9-bit max
        RORW    -256,X                  ; IDX 18 66 xb [ff|ee ff] [S12X]: 9-bit min
        RORW    256,Y                   ; IDX 18 66 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        RORW    $8000,X                 ; IDX 18 66 xb [ff|ee ff] [S12X]: 16-bit large
        RORW    [$1234,X]               ; IDX 18 66 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        RORW    [D,SP]                  ; IDX 18 66 xb [ff|ee ff] [S12X]: accumulator D indirect
        RORW    $1234                   ; EXT 18 76 hh ll [S12X]
        RORW    >$40                    ; EXT 18 76 hh ll [S12X] (forced extended)
        ASRX                            ; INH 18 47 [S12X]
        ASRY                            ; INH 18 57 [S12X]
        ASRW    5,X                     ; IDX 18 67 xb [ff|ee ff] [S12X]: 5-bit constant offset
        ASRW    -16,Y                   ; IDX 18 67 xb [ff|ee ff] [S12X]: 5-bit, most negative
        ASRW    15,SP                   ; IDX 18 67 xb [ff|ee ff] [S12X]: 5-bit, most positive
        ASRW    0,PC                    ; IDX 18 67 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        ASRW    A,X                     ; IDX 18 67 xb [ff|ee ff] [S12X]: accumulator A offset
        ASRW    B,Y                     ; IDX 18 67 xb [ff|ee ff] [S12X]: accumulator B offset
        ASRW    D,SP                    ; IDX 18 67 xb [ff|ee ff] [S12X]: accumulator D offset
        ASRW    1,+X                    ; IDX 18 67 xb [ff|ee ff] [S12X]: pre-increment
        ASRW    8,-Y                    ; IDX 18 67 xb [ff|ee ff] [S12X]: pre-decrement
        ASRW    2,SP+                   ; IDX 18 67 xb [ff|ee ff] [S12X]: post-increment
        ASRW    7,X-                    ; IDX 18 67 xb [ff|ee ff] [S12X]: post-decrement
        ASRW    16,X                    ; IDX 18 67 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        ASRW    -17,Y                   ; IDX 18 67 xb [ff|ee ff] [S12X]: 9-bit negative
        ASRW    255,SP                  ; IDX 18 67 xb [ff|ee ff] [S12X]: 9-bit max
        ASRW    -256,X                  ; IDX 18 67 xb [ff|ee ff] [S12X]: 9-bit min
        ASRW    256,Y                   ; IDX 18 67 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        ASRW    $8000,X                 ; IDX 18 67 xb [ff|ee ff] [S12X]: 16-bit large
        ASRW    [$1234,X]               ; IDX 18 67 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        ASRW    [D,SP]                  ; IDX 18 67 xb [ff|ee ff] [S12X]: accumulator D indirect
        ASRW    $1234                   ; EXT 18 77 hh ll [S12X]
        ASRW    >$40                    ; EXT 18 77 hh ll [S12X] (forced extended)
        ASLX                            ; INH 18 48 [S12X]
        ASLY                            ; INH 18 58 [S12X]
        ASLW    5,X                     ; IDX 18 68 xb [ff|ee ff] [S12X]: 5-bit constant offset
        ASLW    -16,Y                   ; IDX 18 68 xb [ff|ee ff] [S12X]: 5-bit, most negative
        ASLW    15,SP                   ; IDX 18 68 xb [ff|ee ff] [S12X]: 5-bit, most positive
        ASLW    0,PC                    ; IDX 18 68 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        ASLW    A,X                     ; IDX 18 68 xb [ff|ee ff] [S12X]: accumulator A offset
        ASLW    B,Y                     ; IDX 18 68 xb [ff|ee ff] [S12X]: accumulator B offset
        ASLW    D,SP                    ; IDX 18 68 xb [ff|ee ff] [S12X]: accumulator D offset
        ASLW    1,+X                    ; IDX 18 68 xb [ff|ee ff] [S12X]: pre-increment
        ASLW    8,-Y                    ; IDX 18 68 xb [ff|ee ff] [S12X]: pre-decrement
        ASLW    2,SP+                   ; IDX 18 68 xb [ff|ee ff] [S12X]: post-increment
        ASLW    7,X-                    ; IDX 18 68 xb [ff|ee ff] [S12X]: post-decrement
        ASLW    16,X                    ; IDX 18 68 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        ASLW    -17,Y                   ; IDX 18 68 xb [ff|ee ff] [S12X]: 9-bit negative
        ASLW    255,SP                  ; IDX 18 68 xb [ff|ee ff] [S12X]: 9-bit max
        ASLW    -256,X                  ; IDX 18 68 xb [ff|ee ff] [S12X]: 9-bit min
        ASLW    256,Y                   ; IDX 18 68 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        ASLW    $8000,X                 ; IDX 18 68 xb [ff|ee ff] [S12X]: 16-bit large
        ASLW    [$1234,X]               ; IDX 18 68 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        ASLW    [D,SP]                  ; IDX 18 68 xb [ff|ee ff] [S12X]: accumulator D indirect
        ASLW    $1234                   ; EXT 18 78 hh ll [S12X]
        ASLW    >$40                    ; EXT 18 78 hh ll [S12X] (forced extended)
        CLRW    5,X                     ; IDX 18 69 xb [ff|ee ff] [S12X]: 5-bit constant offset
        CLRW    -16,Y                   ; IDX 18 69 xb [ff|ee ff] [S12X]: 5-bit, most negative
        CLRW    15,SP                   ; IDX 18 69 xb [ff|ee ff] [S12X]: 5-bit, most positive
        CLRW    0,PC                    ; IDX 18 69 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        CLRW    A,X                     ; IDX 18 69 xb [ff|ee ff] [S12X]: accumulator A offset
        CLRW    B,Y                     ; IDX 18 69 xb [ff|ee ff] [S12X]: accumulator B offset
        CLRW    D,SP                    ; IDX 18 69 xb [ff|ee ff] [S12X]: accumulator D offset
        CLRW    1,+X                    ; IDX 18 69 xb [ff|ee ff] [S12X]: pre-increment
        CLRW    8,-Y                    ; IDX 18 69 xb [ff|ee ff] [S12X]: pre-decrement
        CLRW    2,SP+                   ; IDX 18 69 xb [ff|ee ff] [S12X]: post-increment
        CLRW    7,X-                    ; IDX 18 69 xb [ff|ee ff] [S12X]: post-decrement
        CLRW    16,X                    ; IDX 18 69 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        CLRW    -17,Y                   ; IDX 18 69 xb [ff|ee ff] [S12X]: 9-bit negative
        CLRW    255,SP                  ; IDX 18 69 xb [ff|ee ff] [S12X]: 9-bit max
        CLRW    -256,X                  ; IDX 18 69 xb [ff|ee ff] [S12X]: 9-bit min
        CLRW    256,Y                   ; IDX 18 69 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        CLRW    $8000,X                 ; IDX 18 69 xb [ff|ee ff] [S12X]: 16-bit large
        CLRW    [$1234,X]               ; IDX 18 69 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        CLRW    [D,SP]                  ; IDX 18 69 xb [ff|ee ff] [S12X]: accumulator D indirect
        CLRW    $1234                   ; EXT 18 79 hh ll [S12X]
        CLRW    >$40                    ; EXT 18 79 hh ll [S12X] (forced extended)
        CLRX                            ; INH 18 87 [S12X]
        CLRY                            ; INH 18 C7 [S12X]
        TSTX                            ; INH 18 97 [S12X]
        TSTY                            ; INH 18 D7 [S12X]
        TSTW    5,X                     ; IDX 18 E7 xb [ff|ee ff] [S12X]: 5-bit constant offset
        TSTW    -16,Y                   ; IDX 18 E7 xb [ff|ee ff] [S12X]: 5-bit, most negative
        TSTW    15,SP                   ; IDX 18 E7 xb [ff|ee ff] [S12X]: 5-bit, most positive
        TSTW    0,PC                    ; IDX 18 E7 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        TSTW    A,X                     ; IDX 18 E7 xb [ff|ee ff] [S12X]: accumulator A offset
        TSTW    B,Y                     ; IDX 18 E7 xb [ff|ee ff] [S12X]: accumulator B offset
        TSTW    D,SP                    ; IDX 18 E7 xb [ff|ee ff] [S12X]: accumulator D offset
        TSTW    1,+X                    ; IDX 18 E7 xb [ff|ee ff] [S12X]: pre-increment
        TSTW    8,-Y                    ; IDX 18 E7 xb [ff|ee ff] [S12X]: pre-decrement
        TSTW    2,SP+                   ; IDX 18 E7 xb [ff|ee ff] [S12X]: post-increment
        TSTW    7,X-                    ; IDX 18 E7 xb [ff|ee ff] [S12X]: post-decrement
        TSTW    16,X                    ; IDX 18 E7 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        TSTW    -17,Y                   ; IDX 18 E7 xb [ff|ee ff] [S12X]: 9-bit negative
        TSTW    255,SP                  ; IDX 18 E7 xb [ff|ee ff] [S12X]: 9-bit max
        TSTW    -256,X                  ; IDX 18 E7 xb [ff|ee ff] [S12X]: 9-bit min
        TSTW    256,Y                   ; IDX 18 E7 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        TSTW    $8000,X                 ; IDX 18 E7 xb [ff|ee ff] [S12X]: 16-bit large
        TSTW    [$1234,X]               ; IDX 18 E7 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        TSTW    [D,SP]                  ; IDX 18 E7 xb [ff|ee ff] [S12X]: accumulator D indirect
        TSTW    $1234                   ; EXT 18 F7 hh ll [S12X]
        TSTW    >$40                    ; EXT 18 F7 hh ll [S12X] (forced extended)
        SYS                             ; INH 18 A7 [S12X]
        SUBX    #$1234                  ; IMM16 18 80 jj kk [S12X]
        SUBX    $40                     ; DIR 18 90 dd [S12X]
        SUBX    5,X                     ; IDX 18 A0 xb [ff|ee ff] [S12X]: 5-bit constant offset
        SUBX    -16,Y                   ; IDX 18 A0 xb [ff|ee ff] [S12X]: 5-bit, most negative
        SUBX    15,SP                   ; IDX 18 A0 xb [ff|ee ff] [S12X]: 5-bit, most positive
        SUBX    0,PC                    ; IDX 18 A0 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        SUBX    A,X                     ; IDX 18 A0 xb [ff|ee ff] [S12X]: accumulator A offset
        SUBX    B,Y                     ; IDX 18 A0 xb [ff|ee ff] [S12X]: accumulator B offset
        SUBX    D,SP                    ; IDX 18 A0 xb [ff|ee ff] [S12X]: accumulator D offset
        SUBX    1,+X                    ; IDX 18 A0 xb [ff|ee ff] [S12X]: pre-increment
        SUBX    8,-Y                    ; IDX 18 A0 xb [ff|ee ff] [S12X]: pre-decrement
        SUBX    2,SP+                   ; IDX 18 A0 xb [ff|ee ff] [S12X]: post-increment
        SUBX    7,X-                    ; IDX 18 A0 xb [ff|ee ff] [S12X]: post-decrement
        SUBX    16,X                    ; IDX 18 A0 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        SUBX    -17,Y                   ; IDX 18 A0 xb [ff|ee ff] [S12X]: 9-bit negative
        SUBX    255,SP                  ; IDX 18 A0 xb [ff|ee ff] [S12X]: 9-bit max
        SUBX    -256,X                  ; IDX 18 A0 xb [ff|ee ff] [S12X]: 9-bit min
        SUBX    256,Y                   ; IDX 18 A0 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        SUBX    $8000,X                 ; IDX 18 A0 xb [ff|ee ff] [S12X]: 16-bit large
        SUBX    [$1234,X]               ; IDX 18 A0 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        SUBX    [D,SP]                  ; IDX 18 A0 xb [ff|ee ff] [S12X]: accumulator D indirect
        SUBX    $1234                   ; EXT 18 B0 hh ll [S12X]
        SUBX    >$40                    ; EXT 18 B0 hh ll [S12X] (forced extended)
        SBEX    #$1234                  ; IMM16 18 82 jj kk [S12X]
        SBEX    $40                     ; DIR 18 92 dd [S12X]
        SBEX    5,X                     ; IDX 18 A2 xb [ff|ee ff] [S12X]: 5-bit constant offset
        SBEX    -16,Y                   ; IDX 18 A2 xb [ff|ee ff] [S12X]: 5-bit, most negative
        SBEX    15,SP                   ; IDX 18 A2 xb [ff|ee ff] [S12X]: 5-bit, most positive
        SBEX    0,PC                    ; IDX 18 A2 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        SBEX    A,X                     ; IDX 18 A2 xb [ff|ee ff] [S12X]: accumulator A offset
        SBEX    B,Y                     ; IDX 18 A2 xb [ff|ee ff] [S12X]: accumulator B offset
        SBEX    D,SP                    ; IDX 18 A2 xb [ff|ee ff] [S12X]: accumulator D offset
        SBEX    1,+X                    ; IDX 18 A2 xb [ff|ee ff] [S12X]: pre-increment
        SBEX    8,-Y                    ; IDX 18 A2 xb [ff|ee ff] [S12X]: pre-decrement
        SBEX    2,SP+                   ; IDX 18 A2 xb [ff|ee ff] [S12X]: post-increment
        SBEX    7,X-                    ; IDX 18 A2 xb [ff|ee ff] [S12X]: post-decrement
        SBEX    16,X                    ; IDX 18 A2 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        SBEX    -17,Y                   ; IDX 18 A2 xb [ff|ee ff] [S12X]: 9-bit negative
        SBEX    255,SP                  ; IDX 18 A2 xb [ff|ee ff] [S12X]: 9-bit max
        SBEX    -256,X                  ; IDX 18 A2 xb [ff|ee ff] [S12X]: 9-bit min
        SBEX    256,Y                   ; IDX 18 A2 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        SBEX    $8000,X                 ; IDX 18 A2 xb [ff|ee ff] [S12X]: 16-bit large
        SBEX    [$1234,X]               ; IDX 18 A2 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        SBEX    [D,SP]                  ; IDX 18 A2 xb [ff|ee ff] [S12X]: accumulator D indirect
        SBEX    $1234                   ; EXT 18 B2 hh ll [S12X]
        SBEX    >$40                    ; EXT 18 B2 hh ll [S12X] (forced extended)
        SBED    #$1234                  ; IMM16 18 83 jj kk [S12X]
        SBED    $40                     ; DIR 18 93 dd [S12X]
        SBED    5,X                     ; IDX 18 A3 xb [ff|ee ff] [S12X]: 5-bit constant offset
        SBED    -16,Y                   ; IDX 18 A3 xb [ff|ee ff] [S12X]: 5-bit, most negative
        SBED    15,SP                   ; IDX 18 A3 xb [ff|ee ff] [S12X]: 5-bit, most positive
        SBED    0,PC                    ; IDX 18 A3 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        SBED    A,X                     ; IDX 18 A3 xb [ff|ee ff] [S12X]: accumulator A offset
        SBED    B,Y                     ; IDX 18 A3 xb [ff|ee ff] [S12X]: accumulator B offset
        SBED    D,SP                    ; IDX 18 A3 xb [ff|ee ff] [S12X]: accumulator D offset
        SBED    1,+X                    ; IDX 18 A3 xb [ff|ee ff] [S12X]: pre-increment
        SBED    8,-Y                    ; IDX 18 A3 xb [ff|ee ff] [S12X]: pre-decrement
        SBED    2,SP+                   ; IDX 18 A3 xb [ff|ee ff] [S12X]: post-increment
        SBED    7,X-                    ; IDX 18 A3 xb [ff|ee ff] [S12X]: post-decrement
        SBED    16,X                    ; IDX 18 A3 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        SBED    -17,Y                   ; IDX 18 A3 xb [ff|ee ff] [S12X]: 9-bit negative
        SBED    255,SP                  ; IDX 18 A3 xb [ff|ee ff] [S12X]: 9-bit max
        SBED    -256,X                  ; IDX 18 A3 xb [ff|ee ff] [S12X]: 9-bit min
        SBED    256,Y                   ; IDX 18 A3 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        SBED    $8000,X                 ; IDX 18 A3 xb [ff|ee ff] [S12X]: 16-bit large
        SBED    [$1234,X]               ; IDX 18 A3 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        SBED    [D,SP]                  ; IDX 18 A3 xb [ff|ee ff] [S12X]: accumulator D indirect
        SBED    $1234                   ; EXT 18 B3 hh ll [S12X]
        SBED    >$40                    ; EXT 18 B3 hh ll [S12X] (forced extended)
        ANDX    #$1234                  ; IMM16 18 84 jj kk [S12X]
        ANDX    $40                     ; DIR 18 94 dd [S12X]
        ANDX    5,X                     ; IDX 18 A4 xb [ff|ee ff] [S12X]: 5-bit constant offset
        ANDX    -16,Y                   ; IDX 18 A4 xb [ff|ee ff] [S12X]: 5-bit, most negative
        ANDX    15,SP                   ; IDX 18 A4 xb [ff|ee ff] [S12X]: 5-bit, most positive
        ANDX    0,PC                    ; IDX 18 A4 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        ANDX    A,X                     ; IDX 18 A4 xb [ff|ee ff] [S12X]: accumulator A offset
        ANDX    B,Y                     ; IDX 18 A4 xb [ff|ee ff] [S12X]: accumulator B offset
        ANDX    D,SP                    ; IDX 18 A4 xb [ff|ee ff] [S12X]: accumulator D offset
        ANDX    1,+X                    ; IDX 18 A4 xb [ff|ee ff] [S12X]: pre-increment
        ANDX    8,-Y                    ; IDX 18 A4 xb [ff|ee ff] [S12X]: pre-decrement
        ANDX    2,SP+                   ; IDX 18 A4 xb [ff|ee ff] [S12X]: post-increment
        ANDX    7,X-                    ; IDX 18 A4 xb [ff|ee ff] [S12X]: post-decrement
        ANDX    16,X                    ; IDX 18 A4 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        ANDX    -17,Y                   ; IDX 18 A4 xb [ff|ee ff] [S12X]: 9-bit negative
        ANDX    255,SP                  ; IDX 18 A4 xb [ff|ee ff] [S12X]: 9-bit max
        ANDX    -256,X                  ; IDX 18 A4 xb [ff|ee ff] [S12X]: 9-bit min
        ANDX    256,Y                   ; IDX 18 A4 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        ANDX    $8000,X                 ; IDX 18 A4 xb [ff|ee ff] [S12X]: 16-bit large
        ANDX    [$1234,X]               ; IDX 18 A4 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        ANDX    [D,SP]                  ; IDX 18 A4 xb [ff|ee ff] [S12X]: accumulator D indirect
        ANDX    $1234                   ; EXT 18 B4 hh ll [S12X]
        ANDX    >$40                    ; EXT 18 B4 hh ll [S12X] (forced extended)
        BITX    #$1234                  ; IMM16 18 85 jj kk [S12X]
        BITX    $40                     ; DIR 18 95 dd [S12X]
        BITX    5,X                     ; IDX 18 A5 xb [ff|ee ff] [S12X]: 5-bit constant offset
        BITX    -16,Y                   ; IDX 18 A5 xb [ff|ee ff] [S12X]: 5-bit, most negative
        BITX    15,SP                   ; IDX 18 A5 xb [ff|ee ff] [S12X]: 5-bit, most positive
        BITX    0,PC                    ; IDX 18 A5 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        BITX    A,X                     ; IDX 18 A5 xb [ff|ee ff] [S12X]: accumulator A offset
        BITX    B,Y                     ; IDX 18 A5 xb [ff|ee ff] [S12X]: accumulator B offset
        BITX    D,SP                    ; IDX 18 A5 xb [ff|ee ff] [S12X]: accumulator D offset
        BITX    1,+X                    ; IDX 18 A5 xb [ff|ee ff] [S12X]: pre-increment
        BITX    8,-Y                    ; IDX 18 A5 xb [ff|ee ff] [S12X]: pre-decrement
        BITX    2,SP+                   ; IDX 18 A5 xb [ff|ee ff] [S12X]: post-increment
        BITX    7,X-                    ; IDX 18 A5 xb [ff|ee ff] [S12X]: post-decrement
        BITX    16,X                    ; IDX 18 A5 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        BITX    -17,Y                   ; IDX 18 A5 xb [ff|ee ff] [S12X]: 9-bit negative
        BITX    255,SP                  ; IDX 18 A5 xb [ff|ee ff] [S12X]: 9-bit max
        BITX    -256,X                  ; IDX 18 A5 xb [ff|ee ff] [S12X]: 9-bit min
        BITX    256,Y                   ; IDX 18 A5 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        BITX    $8000,X                 ; IDX 18 A5 xb [ff|ee ff] [S12X]: 16-bit large
        BITX    [$1234,X]               ; IDX 18 A5 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        BITX    [D,SP]                  ; IDX 18 A5 xb [ff|ee ff] [S12X]: accumulator D indirect
        BITX    $1234                   ; EXT 18 B5 hh ll [S12X]
        BITX    >$40                    ; EXT 18 B5 hh ll [S12X] (forced extended)
        EORX    #$1234                  ; IMM16 18 88 jj kk [S12X]
        EORX    $40                     ; DIR 18 98 dd [S12X]
        EORX    5,X                     ; IDX 18 A8 xb [ff|ee ff] [S12X]: 5-bit constant offset
        EORX    -16,Y                   ; IDX 18 A8 xb [ff|ee ff] [S12X]: 5-bit, most negative
        EORX    15,SP                   ; IDX 18 A8 xb [ff|ee ff] [S12X]: 5-bit, most positive
        EORX    0,PC                    ; IDX 18 A8 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        EORX    A,X                     ; IDX 18 A8 xb [ff|ee ff] [S12X]: accumulator A offset
        EORX    B,Y                     ; IDX 18 A8 xb [ff|ee ff] [S12X]: accumulator B offset
        EORX    D,SP                    ; IDX 18 A8 xb [ff|ee ff] [S12X]: accumulator D offset
        EORX    1,+X                    ; IDX 18 A8 xb [ff|ee ff] [S12X]: pre-increment
        EORX    8,-Y                    ; IDX 18 A8 xb [ff|ee ff] [S12X]: pre-decrement
        EORX    2,SP+                   ; IDX 18 A8 xb [ff|ee ff] [S12X]: post-increment
        EORX    7,X-                    ; IDX 18 A8 xb [ff|ee ff] [S12X]: post-decrement
        EORX    16,X                    ; IDX 18 A8 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        EORX    -17,Y                   ; IDX 18 A8 xb [ff|ee ff] [S12X]: 9-bit negative
        EORX    255,SP                  ; IDX 18 A8 xb [ff|ee ff] [S12X]: 9-bit max
        EORX    -256,X                  ; IDX 18 A8 xb [ff|ee ff] [S12X]: 9-bit min
        EORX    256,Y                   ; IDX 18 A8 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        EORX    $8000,X                 ; IDX 18 A8 xb [ff|ee ff] [S12X]: 16-bit large
        EORX    [$1234,X]               ; IDX 18 A8 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        EORX    [D,SP]                  ; IDX 18 A8 xb [ff|ee ff] [S12X]: accumulator D indirect
        EORX    $1234                   ; EXT 18 B8 hh ll [S12X]
        EORX    >$40                    ; EXT 18 B8 hh ll [S12X] (forced extended)
        ADEX    #$1234                  ; IMM16 18 89 jj kk [S12X]
        ADEX    $40                     ; DIR 18 99 dd [S12X]
        ADEX    5,X                     ; IDX 18 A9 xb [ff|ee ff] [S12X]: 5-bit constant offset
        ADEX    -16,Y                   ; IDX 18 A9 xb [ff|ee ff] [S12X]: 5-bit, most negative
        ADEX    15,SP                   ; IDX 18 A9 xb [ff|ee ff] [S12X]: 5-bit, most positive
        ADEX    0,PC                    ; IDX 18 A9 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        ADEX    A,X                     ; IDX 18 A9 xb [ff|ee ff] [S12X]: accumulator A offset
        ADEX    B,Y                     ; IDX 18 A9 xb [ff|ee ff] [S12X]: accumulator B offset
        ADEX    D,SP                    ; IDX 18 A9 xb [ff|ee ff] [S12X]: accumulator D offset
        ADEX    1,+X                    ; IDX 18 A9 xb [ff|ee ff] [S12X]: pre-increment
        ADEX    8,-Y                    ; IDX 18 A9 xb [ff|ee ff] [S12X]: pre-decrement
        ADEX    2,SP+                   ; IDX 18 A9 xb [ff|ee ff] [S12X]: post-increment
        ADEX    7,X-                    ; IDX 18 A9 xb [ff|ee ff] [S12X]: post-decrement
        ADEX    16,X                    ; IDX 18 A9 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        ADEX    -17,Y                   ; IDX 18 A9 xb [ff|ee ff] [S12X]: 9-bit negative
        ADEX    255,SP                  ; IDX 18 A9 xb [ff|ee ff] [S12X]: 9-bit max
        ADEX    -256,X                  ; IDX 18 A9 xb [ff|ee ff] [S12X]: 9-bit min
        ADEX    256,Y                   ; IDX 18 A9 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        ADEX    $8000,X                 ; IDX 18 A9 xb [ff|ee ff] [S12X]: 16-bit large
        ADEX    [$1234,X]               ; IDX 18 A9 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        ADEX    [D,SP]                  ; IDX 18 A9 xb [ff|ee ff] [S12X]: accumulator D indirect
        ADEX    $1234                   ; EXT 18 B9 hh ll [S12X]
        ADEX    >$40                    ; EXT 18 B9 hh ll [S12X] (forced extended)
        ORX     #$1234                  ; IMM16 18 8A jj kk [S12X]
        ORX     $40                     ; DIR 18 9A dd [S12X]
        ORX     5,X                     ; IDX 18 AA xb [ff|ee ff] [S12X]: 5-bit constant offset
        ORX     -16,Y                   ; IDX 18 AA xb [ff|ee ff] [S12X]: 5-bit, most negative
        ORX     15,SP                   ; IDX 18 AA xb [ff|ee ff] [S12X]: 5-bit, most positive
        ORX     0,PC                    ; IDX 18 AA xb [ff|ee ff] [S12X]: 5-bit, PC literal
        ORX     A,X                     ; IDX 18 AA xb [ff|ee ff] [S12X]: accumulator A offset
        ORX     B,Y                     ; IDX 18 AA xb [ff|ee ff] [S12X]: accumulator B offset
        ORX     D,SP                    ; IDX 18 AA xb [ff|ee ff] [S12X]: accumulator D offset
        ORX     1,+X                    ; IDX 18 AA xb [ff|ee ff] [S12X]: pre-increment
        ORX     8,-Y                    ; IDX 18 AA xb [ff|ee ff] [S12X]: pre-decrement
        ORX     2,SP+                   ; IDX 18 AA xb [ff|ee ff] [S12X]: post-increment
        ORX     7,X-                    ; IDX 18 AA xb [ff|ee ff] [S12X]: post-decrement
        ORX     16,X                    ; IDX 18 AA xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        ORX     -17,Y                   ; IDX 18 AA xb [ff|ee ff] [S12X]: 9-bit negative
        ORX     255,SP                  ; IDX 18 AA xb [ff|ee ff] [S12X]: 9-bit max
        ORX     -256,X                  ; IDX 18 AA xb [ff|ee ff] [S12X]: 9-bit min
        ORX     256,Y                   ; IDX 18 AA xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        ORX     $8000,X                 ; IDX 18 AA xb [ff|ee ff] [S12X]: 16-bit large
        ORX     [$1234,X]               ; IDX 18 AA xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        ORX     [D,SP]                  ; IDX 18 AA xb [ff|ee ff] [S12X]: accumulator D indirect
        ORX     $1234                   ; EXT 18 BA hh ll [S12X]
        ORX     >$40                    ; EXT 18 BA hh ll [S12X] (forced extended)
        ADDX    #$1234                  ; IMM16 18 8B jj kk [S12X]
        ADDX    $40                     ; DIR 18 9B dd [S12X]
        ADDX    5,X                     ; IDX 18 AB xb [ff|ee ff] [S12X]: 5-bit constant offset
        ADDX    -16,Y                   ; IDX 18 AB xb [ff|ee ff] [S12X]: 5-bit, most negative
        ADDX    15,SP                   ; IDX 18 AB xb [ff|ee ff] [S12X]: 5-bit, most positive
        ADDX    0,PC                    ; IDX 18 AB xb [ff|ee ff] [S12X]: 5-bit, PC literal
        ADDX    A,X                     ; IDX 18 AB xb [ff|ee ff] [S12X]: accumulator A offset
        ADDX    B,Y                     ; IDX 18 AB xb [ff|ee ff] [S12X]: accumulator B offset
        ADDX    D,SP                    ; IDX 18 AB xb [ff|ee ff] [S12X]: accumulator D offset
        ADDX    1,+X                    ; IDX 18 AB xb [ff|ee ff] [S12X]: pre-increment
        ADDX    8,-Y                    ; IDX 18 AB xb [ff|ee ff] [S12X]: pre-decrement
        ADDX    2,SP+                   ; IDX 18 AB xb [ff|ee ff] [S12X]: post-increment
        ADDX    7,X-                    ; IDX 18 AB xb [ff|ee ff] [S12X]: post-decrement
        ADDX    16,X                    ; IDX 18 AB xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        ADDX    -17,Y                   ; IDX 18 AB xb [ff|ee ff] [S12X]: 9-bit negative
        ADDX    255,SP                  ; IDX 18 AB xb [ff|ee ff] [S12X]: 9-bit max
        ADDX    -256,X                  ; IDX 18 AB xb [ff|ee ff] [S12X]: 9-bit min
        ADDX    256,Y                   ; IDX 18 AB xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        ADDX    $8000,X                 ; IDX 18 AB xb [ff|ee ff] [S12X]: 16-bit large
        ADDX    [$1234,X]               ; IDX 18 AB xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        ADDX    [D,SP]                  ; IDX 18 AB xb [ff|ee ff] [S12X]: accumulator D indirect
        ADDX    $1234                   ; EXT 18 BB hh ll [S12X]
        ADDX    >$40                    ; EXT 18 BB hh ll [S12X] (forced extended)
        CPED    #$1234                  ; IMM16 18 8C jj kk [S12X]
        CPED    $40                     ; DIR 18 9C dd [S12X]
        CPED    5,X                     ; IDX 18 AC xb [ff|ee ff] [S12X]: 5-bit constant offset
        CPED    -16,Y                   ; IDX 18 AC xb [ff|ee ff] [S12X]: 5-bit, most negative
        CPED    15,SP                   ; IDX 18 AC xb [ff|ee ff] [S12X]: 5-bit, most positive
        CPED    0,PC                    ; IDX 18 AC xb [ff|ee ff] [S12X]: 5-bit, PC literal
        CPED    A,X                     ; IDX 18 AC xb [ff|ee ff] [S12X]: accumulator A offset
        CPED    B,Y                     ; IDX 18 AC xb [ff|ee ff] [S12X]: accumulator B offset
        CPED    D,SP                    ; IDX 18 AC xb [ff|ee ff] [S12X]: accumulator D offset
        CPED    1,+X                    ; IDX 18 AC xb [ff|ee ff] [S12X]: pre-increment
        CPED    8,-Y                    ; IDX 18 AC xb [ff|ee ff] [S12X]: pre-decrement
        CPED    2,SP+                   ; IDX 18 AC xb [ff|ee ff] [S12X]: post-increment
        CPED    7,X-                    ; IDX 18 AC xb [ff|ee ff] [S12X]: post-decrement
        CPED    16,X                    ; IDX 18 AC xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        CPED    -17,Y                   ; IDX 18 AC xb [ff|ee ff] [S12X]: 9-bit negative
        CPED    255,SP                  ; IDX 18 AC xb [ff|ee ff] [S12X]: 9-bit max
        CPED    -256,X                  ; IDX 18 AC xb [ff|ee ff] [S12X]: 9-bit min
        CPED    256,Y                   ; IDX 18 AC xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        CPED    $8000,X                 ; IDX 18 AC xb [ff|ee ff] [S12X]: 16-bit large
        CPED    [$1234,X]               ; IDX 18 AC xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        CPED    [D,SP]                  ; IDX 18 AC xb [ff|ee ff] [S12X]: accumulator D indirect
        CPED    $1234                   ; EXT 18 BC hh ll [S12X]
        CPED    >$40                    ; EXT 18 BC hh ll [S12X] (forced extended)
        CPEY    #$1234                  ; IMM16 18 8D jj kk [S12X]
        CPEY    $40                     ; DIR 18 9D dd [S12X]
        CPEY    5,X                     ; IDX 18 AD xb [ff|ee ff] [S12X]: 5-bit constant offset
        CPEY    -16,Y                   ; IDX 18 AD xb [ff|ee ff] [S12X]: 5-bit, most negative
        CPEY    15,SP                   ; IDX 18 AD xb [ff|ee ff] [S12X]: 5-bit, most positive
        CPEY    0,PC                    ; IDX 18 AD xb [ff|ee ff] [S12X]: 5-bit, PC literal
        CPEY    A,X                     ; IDX 18 AD xb [ff|ee ff] [S12X]: accumulator A offset
        CPEY    B,Y                     ; IDX 18 AD xb [ff|ee ff] [S12X]: accumulator B offset
        CPEY    D,SP                    ; IDX 18 AD xb [ff|ee ff] [S12X]: accumulator D offset
        CPEY    1,+X                    ; IDX 18 AD xb [ff|ee ff] [S12X]: pre-increment
        CPEY    8,-Y                    ; IDX 18 AD xb [ff|ee ff] [S12X]: pre-decrement
        CPEY    2,SP+                   ; IDX 18 AD xb [ff|ee ff] [S12X]: post-increment
        CPEY    7,X-                    ; IDX 18 AD xb [ff|ee ff] [S12X]: post-decrement
        CPEY    16,X                    ; IDX 18 AD xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        CPEY    -17,Y                   ; IDX 18 AD xb [ff|ee ff] [S12X]: 9-bit negative
        CPEY    255,SP                  ; IDX 18 AD xb [ff|ee ff] [S12X]: 9-bit max
        CPEY    -256,X                  ; IDX 18 AD xb [ff|ee ff] [S12X]: 9-bit min
        CPEY    256,Y                   ; IDX 18 AD xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        CPEY    $8000,X                 ; IDX 18 AD xb [ff|ee ff] [S12X]: 16-bit large
        CPEY    [$1234,X]               ; IDX 18 AD xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        CPEY    [D,SP]                  ; IDX 18 AD xb [ff|ee ff] [S12X]: accumulator D indirect
        CPEY    $1234                   ; EXT 18 BD hh ll [S12X]
        CPEY    >$40                    ; EXT 18 BD hh ll [S12X] (forced extended)
        CPEX    #$1234                  ; IMM16 18 8E jj kk [S12X]
        CPEX    $40                     ; DIR 18 9E dd [S12X]
        CPEX    5,X                     ; IDX 18 AE xb [ff|ee ff] [S12X]: 5-bit constant offset
        CPEX    -16,Y                   ; IDX 18 AE xb [ff|ee ff] [S12X]: 5-bit, most negative
        CPEX    15,SP                   ; IDX 18 AE xb [ff|ee ff] [S12X]: 5-bit, most positive
        CPEX    0,PC                    ; IDX 18 AE xb [ff|ee ff] [S12X]: 5-bit, PC literal
        CPEX    A,X                     ; IDX 18 AE xb [ff|ee ff] [S12X]: accumulator A offset
        CPEX    B,Y                     ; IDX 18 AE xb [ff|ee ff] [S12X]: accumulator B offset
        CPEX    D,SP                    ; IDX 18 AE xb [ff|ee ff] [S12X]: accumulator D offset
        CPEX    1,+X                    ; IDX 18 AE xb [ff|ee ff] [S12X]: pre-increment
        CPEX    8,-Y                    ; IDX 18 AE xb [ff|ee ff] [S12X]: pre-decrement
        CPEX    2,SP+                   ; IDX 18 AE xb [ff|ee ff] [S12X]: post-increment
        CPEX    7,X-                    ; IDX 18 AE xb [ff|ee ff] [S12X]: post-decrement
        CPEX    16,X                    ; IDX 18 AE xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        CPEX    -17,Y                   ; IDX 18 AE xb [ff|ee ff] [S12X]: 9-bit negative
        CPEX    255,SP                  ; IDX 18 AE xb [ff|ee ff] [S12X]: 9-bit max
        CPEX    -256,X                  ; IDX 18 AE xb [ff|ee ff] [S12X]: 9-bit min
        CPEX    256,Y                   ; IDX 18 AE xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        CPEX    $8000,X                 ; IDX 18 AE xb [ff|ee ff] [S12X]: 16-bit large
        CPEX    [$1234,X]               ; IDX 18 AE xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        CPEX    [D,SP]                  ; IDX 18 AE xb [ff|ee ff] [S12X]: accumulator D indirect
        CPEX    $1234                   ; EXT 18 BE hh ll [S12X]
        CPEX    >$40                    ; EXT 18 BE hh ll [S12X] (forced extended)
        CPES    #$1234                  ; IMM16 18 8F jj kk [S12X]
        CPES    $40                     ; DIR 18 9F dd [S12X]
        CPES    5,X                     ; IDX 18 AF xb [ff|ee ff] [S12X]: 5-bit constant offset
        CPES    -16,Y                   ; IDX 18 AF xb [ff|ee ff] [S12X]: 5-bit, most negative
        CPES    15,SP                   ; IDX 18 AF xb [ff|ee ff] [S12X]: 5-bit, most positive
        CPES    0,PC                    ; IDX 18 AF xb [ff|ee ff] [S12X]: 5-bit, PC literal
        CPES    A,X                     ; IDX 18 AF xb [ff|ee ff] [S12X]: accumulator A offset
        CPES    B,Y                     ; IDX 18 AF xb [ff|ee ff] [S12X]: accumulator B offset
        CPES    D,SP                    ; IDX 18 AF xb [ff|ee ff] [S12X]: accumulator D offset
        CPES    1,+X                    ; IDX 18 AF xb [ff|ee ff] [S12X]: pre-increment
        CPES    8,-Y                    ; IDX 18 AF xb [ff|ee ff] [S12X]: pre-decrement
        CPES    2,SP+                   ; IDX 18 AF xb [ff|ee ff] [S12X]: post-increment
        CPES    7,X-                    ; IDX 18 AF xb [ff|ee ff] [S12X]: post-decrement
        CPES    16,X                    ; IDX 18 AF xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        CPES    -17,Y                   ; IDX 18 AF xb [ff|ee ff] [S12X]: 9-bit negative
        CPES    255,SP                  ; IDX 18 AF xb [ff|ee ff] [S12X]: 9-bit max
        CPES    -256,X                  ; IDX 18 AF xb [ff|ee ff] [S12X]: 9-bit min
        CPES    256,Y                   ; IDX 18 AF xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        CPES    $8000,X                 ; IDX 18 AF xb [ff|ee ff] [S12X]: 16-bit large
        CPES    [$1234,X]               ; IDX 18 AF xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        CPES    [D,SP]                  ; IDX 18 AF xb [ff|ee ff] [S12X]: accumulator D indirect
        CPES    $1234                   ; EXT 18 BF hh ll [S12X]
        CPES    >$40                    ; EXT 18 BF hh ll [S12X] (forced extended)
        SUBY    #$1234                  ; IMM16 18 C0 jj kk [S12X]
        SUBY    $40                     ; DIR 18 D0 dd [S12X]
        SUBY    5,X                     ; IDX 18 E0 xb [ff|ee ff] [S12X]: 5-bit constant offset
        SUBY    -16,Y                   ; IDX 18 E0 xb [ff|ee ff] [S12X]: 5-bit, most negative
        SUBY    15,SP                   ; IDX 18 E0 xb [ff|ee ff] [S12X]: 5-bit, most positive
        SUBY    0,PC                    ; IDX 18 E0 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        SUBY    A,X                     ; IDX 18 E0 xb [ff|ee ff] [S12X]: accumulator A offset
        SUBY    B,Y                     ; IDX 18 E0 xb [ff|ee ff] [S12X]: accumulator B offset
        SUBY    D,SP                    ; IDX 18 E0 xb [ff|ee ff] [S12X]: accumulator D offset
        SUBY    1,+X                    ; IDX 18 E0 xb [ff|ee ff] [S12X]: pre-increment
        SUBY    8,-Y                    ; IDX 18 E0 xb [ff|ee ff] [S12X]: pre-decrement
        SUBY    2,SP+                   ; IDX 18 E0 xb [ff|ee ff] [S12X]: post-increment
        SUBY    7,X-                    ; IDX 18 E0 xb [ff|ee ff] [S12X]: post-decrement
        SUBY    16,X                    ; IDX 18 E0 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        SUBY    -17,Y                   ; IDX 18 E0 xb [ff|ee ff] [S12X]: 9-bit negative
        SUBY    255,SP                  ; IDX 18 E0 xb [ff|ee ff] [S12X]: 9-bit max
        SUBY    -256,X                  ; IDX 18 E0 xb [ff|ee ff] [S12X]: 9-bit min
        SUBY    256,Y                   ; IDX 18 E0 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        SUBY    $8000,X                 ; IDX 18 E0 xb [ff|ee ff] [S12X]: 16-bit large
        SUBY    [$1234,X]               ; IDX 18 E0 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        SUBY    [D,SP]                  ; IDX 18 E0 xb [ff|ee ff] [S12X]: accumulator D indirect
        SUBY    $1234                   ; EXT 18 F0 hh ll [S12X]
        SUBY    >$40                    ; EXT 18 F0 hh ll [S12X] (forced extended)
        SBEY    #$1234                  ; IMM16 18 C2 jj kk [S12X]
        SBEY    $40                     ; DIR 18 D2 dd [S12X]
        SBEY    5,X                     ; IDX 18 E2 xb [ff|ee ff] [S12X]: 5-bit constant offset
        SBEY    -16,Y                   ; IDX 18 E2 xb [ff|ee ff] [S12X]: 5-bit, most negative
        SBEY    15,SP                   ; IDX 18 E2 xb [ff|ee ff] [S12X]: 5-bit, most positive
        SBEY    0,PC                    ; IDX 18 E2 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        SBEY    A,X                     ; IDX 18 E2 xb [ff|ee ff] [S12X]: accumulator A offset
        SBEY    B,Y                     ; IDX 18 E2 xb [ff|ee ff] [S12X]: accumulator B offset
        SBEY    D,SP                    ; IDX 18 E2 xb [ff|ee ff] [S12X]: accumulator D offset
        SBEY    1,+X                    ; IDX 18 E2 xb [ff|ee ff] [S12X]: pre-increment
        SBEY    8,-Y                    ; IDX 18 E2 xb [ff|ee ff] [S12X]: pre-decrement
        SBEY    2,SP+                   ; IDX 18 E2 xb [ff|ee ff] [S12X]: post-increment
        SBEY    7,X-                    ; IDX 18 E2 xb [ff|ee ff] [S12X]: post-decrement
        SBEY    16,X                    ; IDX 18 E2 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        SBEY    -17,Y                   ; IDX 18 E2 xb [ff|ee ff] [S12X]: 9-bit negative
        SBEY    255,SP                  ; IDX 18 E2 xb [ff|ee ff] [S12X]: 9-bit max
        SBEY    -256,X                  ; IDX 18 E2 xb [ff|ee ff] [S12X]: 9-bit min
        SBEY    256,Y                   ; IDX 18 E2 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        SBEY    $8000,X                 ; IDX 18 E2 xb [ff|ee ff] [S12X]: 16-bit large
        SBEY    [$1234,X]               ; IDX 18 E2 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        SBEY    [D,SP]                  ; IDX 18 E2 xb [ff|ee ff] [S12X]: accumulator D indirect
        SBEY    $1234                   ; EXT 18 F2 hh ll [S12X]
        SBEY    >$40                    ; EXT 18 F2 hh ll [S12X] (forced extended)
        ADED    #$1234                  ; IMM16 18 C3 jj kk [S12X]
        ADED    $40                     ; DIR 18 D3 dd [S12X]
        ADED    5,X                     ; IDX 18 E3 xb [ff|ee ff] [S12X]: 5-bit constant offset
        ADED    -16,Y                   ; IDX 18 E3 xb [ff|ee ff] [S12X]: 5-bit, most negative
        ADED    15,SP                   ; IDX 18 E3 xb [ff|ee ff] [S12X]: 5-bit, most positive
        ADED    0,PC                    ; IDX 18 E3 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        ADED    A,X                     ; IDX 18 E3 xb [ff|ee ff] [S12X]: accumulator A offset
        ADED    B,Y                     ; IDX 18 E3 xb [ff|ee ff] [S12X]: accumulator B offset
        ADED    D,SP                    ; IDX 18 E3 xb [ff|ee ff] [S12X]: accumulator D offset
        ADED    1,+X                    ; IDX 18 E3 xb [ff|ee ff] [S12X]: pre-increment
        ADED    8,-Y                    ; IDX 18 E3 xb [ff|ee ff] [S12X]: pre-decrement
        ADED    2,SP+                   ; IDX 18 E3 xb [ff|ee ff] [S12X]: post-increment
        ADED    7,X-                    ; IDX 18 E3 xb [ff|ee ff] [S12X]: post-decrement
        ADED    16,X                    ; IDX 18 E3 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        ADED    -17,Y                   ; IDX 18 E3 xb [ff|ee ff] [S12X]: 9-bit negative
        ADED    255,SP                  ; IDX 18 E3 xb [ff|ee ff] [S12X]: 9-bit max
        ADED    -256,X                  ; IDX 18 E3 xb [ff|ee ff] [S12X]: 9-bit min
        ADED    256,Y                   ; IDX 18 E3 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        ADED    $8000,X                 ; IDX 18 E3 xb [ff|ee ff] [S12X]: 16-bit large
        ADED    [$1234,X]               ; IDX 18 E3 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        ADED    [D,SP]                  ; IDX 18 E3 xb [ff|ee ff] [S12X]: accumulator D indirect
        ADED    $1234                   ; EXT 18 F3 hh ll [S12X]
        ADED    >$40                    ; EXT 18 F3 hh ll [S12X] (forced extended)
        ANDY    #$1234                  ; IMM16 18 C4 jj kk [S12X]
        ANDY    $40                     ; DIR 18 D4 dd [S12X]
        ANDY    5,X                     ; IDX 18 E4 xb [ff|ee ff] [S12X]: 5-bit constant offset
        ANDY    -16,Y                   ; IDX 18 E4 xb [ff|ee ff] [S12X]: 5-bit, most negative
        ANDY    15,SP                   ; IDX 18 E4 xb [ff|ee ff] [S12X]: 5-bit, most positive
        ANDY    0,PC                    ; IDX 18 E4 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        ANDY    A,X                     ; IDX 18 E4 xb [ff|ee ff] [S12X]: accumulator A offset
        ANDY    B,Y                     ; IDX 18 E4 xb [ff|ee ff] [S12X]: accumulator B offset
        ANDY    D,SP                    ; IDX 18 E4 xb [ff|ee ff] [S12X]: accumulator D offset
        ANDY    1,+X                    ; IDX 18 E4 xb [ff|ee ff] [S12X]: pre-increment
        ANDY    8,-Y                    ; IDX 18 E4 xb [ff|ee ff] [S12X]: pre-decrement
        ANDY    2,SP+                   ; IDX 18 E4 xb [ff|ee ff] [S12X]: post-increment
        ANDY    7,X-                    ; IDX 18 E4 xb [ff|ee ff] [S12X]: post-decrement
        ANDY    16,X                    ; IDX 18 E4 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        ANDY    -17,Y                   ; IDX 18 E4 xb [ff|ee ff] [S12X]: 9-bit negative
        ANDY    255,SP                  ; IDX 18 E4 xb [ff|ee ff] [S12X]: 9-bit max
        ANDY    -256,X                  ; IDX 18 E4 xb [ff|ee ff] [S12X]: 9-bit min
        ANDY    256,Y                   ; IDX 18 E4 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        ANDY    $8000,X                 ; IDX 18 E4 xb [ff|ee ff] [S12X]: 16-bit large
        ANDY    [$1234,X]               ; IDX 18 E4 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        ANDY    [D,SP]                  ; IDX 18 E4 xb [ff|ee ff] [S12X]: accumulator D indirect
        ANDY    $1234                   ; EXT 18 F4 hh ll [S12X]
        ANDY    >$40                    ; EXT 18 F4 hh ll [S12X] (forced extended)
        BITY    #$1234                  ; IMM16 18 C5 jj kk [S12X]
        BITY    $40                     ; DIR 18 D5 dd [S12X]
        BITY    5,X                     ; IDX 18 E5 xb [ff|ee ff] [S12X]: 5-bit constant offset
        BITY    -16,Y                   ; IDX 18 E5 xb [ff|ee ff] [S12X]: 5-bit, most negative
        BITY    15,SP                   ; IDX 18 E5 xb [ff|ee ff] [S12X]: 5-bit, most positive
        BITY    0,PC                    ; IDX 18 E5 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        BITY    A,X                     ; IDX 18 E5 xb [ff|ee ff] [S12X]: accumulator A offset
        BITY    B,Y                     ; IDX 18 E5 xb [ff|ee ff] [S12X]: accumulator B offset
        BITY    D,SP                    ; IDX 18 E5 xb [ff|ee ff] [S12X]: accumulator D offset
        BITY    1,+X                    ; IDX 18 E5 xb [ff|ee ff] [S12X]: pre-increment
        BITY    8,-Y                    ; IDX 18 E5 xb [ff|ee ff] [S12X]: pre-decrement
        BITY    2,SP+                   ; IDX 18 E5 xb [ff|ee ff] [S12X]: post-increment
        BITY    7,X-                    ; IDX 18 E5 xb [ff|ee ff] [S12X]: post-decrement
        BITY    16,X                    ; IDX 18 E5 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        BITY    -17,Y                   ; IDX 18 E5 xb [ff|ee ff] [S12X]: 9-bit negative
        BITY    255,SP                  ; IDX 18 E5 xb [ff|ee ff] [S12X]: 9-bit max
        BITY    -256,X                  ; IDX 18 E5 xb [ff|ee ff] [S12X]: 9-bit min
        BITY    256,Y                   ; IDX 18 E5 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        BITY    $8000,X                 ; IDX 18 E5 xb [ff|ee ff] [S12X]: 16-bit large
        BITY    [$1234,X]               ; IDX 18 E5 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        BITY    [D,SP]                  ; IDX 18 E5 xb [ff|ee ff] [S12X]: accumulator D indirect
        BITY    $1234                   ; EXT 18 F5 hh ll [S12X]
        BITY    >$40                    ; EXT 18 F5 hh ll [S12X] (forced extended)
        EORY    #$1234                  ; IMM16 18 C8 jj kk [S12X]
        EORY    $40                     ; DIR 18 D8 dd [S12X]
        EORY    5,X                     ; IDX 18 E8 xb [ff|ee ff] [S12X]: 5-bit constant offset
        EORY    -16,Y                   ; IDX 18 E8 xb [ff|ee ff] [S12X]: 5-bit, most negative
        EORY    15,SP                   ; IDX 18 E8 xb [ff|ee ff] [S12X]: 5-bit, most positive
        EORY    0,PC                    ; IDX 18 E8 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        EORY    A,X                     ; IDX 18 E8 xb [ff|ee ff] [S12X]: accumulator A offset
        EORY    B,Y                     ; IDX 18 E8 xb [ff|ee ff] [S12X]: accumulator B offset
        EORY    D,SP                    ; IDX 18 E8 xb [ff|ee ff] [S12X]: accumulator D offset
        EORY    1,+X                    ; IDX 18 E8 xb [ff|ee ff] [S12X]: pre-increment
        EORY    8,-Y                    ; IDX 18 E8 xb [ff|ee ff] [S12X]: pre-decrement
        EORY    2,SP+                   ; IDX 18 E8 xb [ff|ee ff] [S12X]: post-increment
        EORY    7,X-                    ; IDX 18 E8 xb [ff|ee ff] [S12X]: post-decrement
        EORY    16,X                    ; IDX 18 E8 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        EORY    -17,Y                   ; IDX 18 E8 xb [ff|ee ff] [S12X]: 9-bit negative
        EORY    255,SP                  ; IDX 18 E8 xb [ff|ee ff] [S12X]: 9-bit max
        EORY    -256,X                  ; IDX 18 E8 xb [ff|ee ff] [S12X]: 9-bit min
        EORY    256,Y                   ; IDX 18 E8 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        EORY    $8000,X                 ; IDX 18 E8 xb [ff|ee ff] [S12X]: 16-bit large
        EORY    [$1234,X]               ; IDX 18 E8 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        EORY    [D,SP]                  ; IDX 18 E8 xb [ff|ee ff] [S12X]: accumulator D indirect
        EORY    $1234                   ; EXT 18 F8 hh ll [S12X]
        EORY    >$40                    ; EXT 18 F8 hh ll [S12X] (forced extended)
        ADEY    #$1234                  ; IMM16 18 C9 jj kk [S12X]
        ADEY    $40                     ; DIR 18 D9 dd [S12X]
        ADEY    5,X                     ; IDX 18 E9 xb [ff|ee ff] [S12X]: 5-bit constant offset
        ADEY    -16,Y                   ; IDX 18 E9 xb [ff|ee ff] [S12X]: 5-bit, most negative
        ADEY    15,SP                   ; IDX 18 E9 xb [ff|ee ff] [S12X]: 5-bit, most positive
        ADEY    0,PC                    ; IDX 18 E9 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        ADEY    A,X                     ; IDX 18 E9 xb [ff|ee ff] [S12X]: accumulator A offset
        ADEY    B,Y                     ; IDX 18 E9 xb [ff|ee ff] [S12X]: accumulator B offset
        ADEY    D,SP                    ; IDX 18 E9 xb [ff|ee ff] [S12X]: accumulator D offset
        ADEY    1,+X                    ; IDX 18 E9 xb [ff|ee ff] [S12X]: pre-increment
        ADEY    8,-Y                    ; IDX 18 E9 xb [ff|ee ff] [S12X]: pre-decrement
        ADEY    2,SP+                   ; IDX 18 E9 xb [ff|ee ff] [S12X]: post-increment
        ADEY    7,X-                    ; IDX 18 E9 xb [ff|ee ff] [S12X]: post-decrement
        ADEY    16,X                    ; IDX 18 E9 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        ADEY    -17,Y                   ; IDX 18 E9 xb [ff|ee ff] [S12X]: 9-bit negative
        ADEY    255,SP                  ; IDX 18 E9 xb [ff|ee ff] [S12X]: 9-bit max
        ADEY    -256,X                  ; IDX 18 E9 xb [ff|ee ff] [S12X]: 9-bit min
        ADEY    256,Y                   ; IDX 18 E9 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        ADEY    $8000,X                 ; IDX 18 E9 xb [ff|ee ff] [S12X]: 16-bit large
        ADEY    [$1234,X]               ; IDX 18 E9 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        ADEY    [D,SP]                  ; IDX 18 E9 xb [ff|ee ff] [S12X]: accumulator D indirect
        ADEY    $1234                   ; EXT 18 F9 hh ll [S12X]
        ADEY    >$40                    ; EXT 18 F9 hh ll [S12X] (forced extended)
        ORY     #$1234                  ; IMM16 18 CA jj kk [S12X]
        ORY     $40                     ; DIR 18 DA dd [S12X]
        ORY     5,X                     ; IDX 18 EA xb [ff|ee ff] [S12X]: 5-bit constant offset
        ORY     -16,Y                   ; IDX 18 EA xb [ff|ee ff] [S12X]: 5-bit, most negative
        ORY     15,SP                   ; IDX 18 EA xb [ff|ee ff] [S12X]: 5-bit, most positive
        ORY     0,PC                    ; IDX 18 EA xb [ff|ee ff] [S12X]: 5-bit, PC literal
        ORY     A,X                     ; IDX 18 EA xb [ff|ee ff] [S12X]: accumulator A offset
        ORY     B,Y                     ; IDX 18 EA xb [ff|ee ff] [S12X]: accumulator B offset
        ORY     D,SP                    ; IDX 18 EA xb [ff|ee ff] [S12X]: accumulator D offset
        ORY     1,+X                    ; IDX 18 EA xb [ff|ee ff] [S12X]: pre-increment
        ORY     8,-Y                    ; IDX 18 EA xb [ff|ee ff] [S12X]: pre-decrement
        ORY     2,SP+                   ; IDX 18 EA xb [ff|ee ff] [S12X]: post-increment
        ORY     7,X-                    ; IDX 18 EA xb [ff|ee ff] [S12X]: post-decrement
        ORY     16,X                    ; IDX 18 EA xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        ORY     -17,Y                   ; IDX 18 EA xb [ff|ee ff] [S12X]: 9-bit negative
        ORY     255,SP                  ; IDX 18 EA xb [ff|ee ff] [S12X]: 9-bit max
        ORY     -256,X                  ; IDX 18 EA xb [ff|ee ff] [S12X]: 9-bit min
        ORY     256,Y                   ; IDX 18 EA xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        ORY     $8000,X                 ; IDX 18 EA xb [ff|ee ff] [S12X]: 16-bit large
        ORY     [$1234,X]               ; IDX 18 EA xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        ORY     [D,SP]                  ; IDX 18 EA xb [ff|ee ff] [S12X]: accumulator D indirect
        ORY     $1234                   ; EXT 18 FA hh ll [S12X]
        ORY     >$40                    ; EXT 18 FA hh ll [S12X] (forced extended)
        ADDY    #$1234                  ; IMM16 18 CB jj kk [S12X]
        ADDY    $40                     ; DIR 18 DB dd [S12X]
        ADDY    5,X                     ; IDX 18 EB xb [ff|ee ff] [S12X]: 5-bit constant offset
        ADDY    -16,Y                   ; IDX 18 EB xb [ff|ee ff] [S12X]: 5-bit, most negative
        ADDY    15,SP                   ; IDX 18 EB xb [ff|ee ff] [S12X]: 5-bit, most positive
        ADDY    0,PC                    ; IDX 18 EB xb [ff|ee ff] [S12X]: 5-bit, PC literal
        ADDY    A,X                     ; IDX 18 EB xb [ff|ee ff] [S12X]: accumulator A offset
        ADDY    B,Y                     ; IDX 18 EB xb [ff|ee ff] [S12X]: accumulator B offset
        ADDY    D,SP                    ; IDX 18 EB xb [ff|ee ff] [S12X]: accumulator D offset
        ADDY    1,+X                    ; IDX 18 EB xb [ff|ee ff] [S12X]: pre-increment
        ADDY    8,-Y                    ; IDX 18 EB xb [ff|ee ff] [S12X]: pre-decrement
        ADDY    2,SP+                   ; IDX 18 EB xb [ff|ee ff] [S12X]: post-increment
        ADDY    7,X-                    ; IDX 18 EB xb [ff|ee ff] [S12X]: post-decrement
        ADDY    16,X                    ; IDX 18 EB xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        ADDY    -17,Y                   ; IDX 18 EB xb [ff|ee ff] [S12X]: 9-bit negative
        ADDY    255,SP                  ; IDX 18 EB xb [ff|ee ff] [S12X]: 9-bit max
        ADDY    -256,X                  ; IDX 18 EB xb [ff|ee ff] [S12X]: 9-bit min
        ADDY    256,Y                   ; IDX 18 EB xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        ADDY    $8000,X                 ; IDX 18 EB xb [ff|ee ff] [S12X]: 16-bit large
        ADDY    [$1234,X]               ; IDX 18 EB xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        ADDY    [D,SP]                  ; IDX 18 EB xb [ff|ee ff] [S12X]: accumulator D indirect
        ADDY    $1234                   ; EXT 18 FB hh ll [S12X]
        ADDY    >$40                    ; EXT 18 FB hh ll [S12X] (forced extended)
        GLDAA   $40                     ; DIR 18 96 dd [S12X]
        GLDAA   5,X                     ; IDX 18 A6 xb [ff|ee ff] [S12X]: 5-bit constant offset
        GLDAA   -16,Y                   ; IDX 18 A6 xb [ff|ee ff] [S12X]: 5-bit, most negative
        GLDAA   15,SP                   ; IDX 18 A6 xb [ff|ee ff] [S12X]: 5-bit, most positive
        GLDAA   0,PC                    ; IDX 18 A6 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        GLDAA   A,X                     ; IDX 18 A6 xb [ff|ee ff] [S12X]: accumulator A offset
        GLDAA   B,Y                     ; IDX 18 A6 xb [ff|ee ff] [S12X]: accumulator B offset
        GLDAA   D,SP                    ; IDX 18 A6 xb [ff|ee ff] [S12X]: accumulator D offset
        GLDAA   1,+X                    ; IDX 18 A6 xb [ff|ee ff] [S12X]: pre-increment
        GLDAA   8,-Y                    ; IDX 18 A6 xb [ff|ee ff] [S12X]: pre-decrement
        GLDAA   2,SP+                   ; IDX 18 A6 xb [ff|ee ff] [S12X]: post-increment
        GLDAA   7,X-                    ; IDX 18 A6 xb [ff|ee ff] [S12X]: post-decrement
        GLDAA   16,X                    ; IDX 18 A6 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        GLDAA   -17,Y                   ; IDX 18 A6 xb [ff|ee ff] [S12X]: 9-bit negative
        GLDAA   255,SP                  ; IDX 18 A6 xb [ff|ee ff] [S12X]: 9-bit max
        GLDAA   -256,X                  ; IDX 18 A6 xb [ff|ee ff] [S12X]: 9-bit min
        GLDAA   256,Y                   ; IDX 18 A6 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        GLDAA   $8000,X                 ; IDX 18 A6 xb [ff|ee ff] [S12X]: 16-bit large
        GLDAA   [$1234,X]               ; IDX 18 A6 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        GLDAA   [D,SP]                  ; IDX 18 A6 xb [ff|ee ff] [S12X]: accumulator D indirect
        GLDAA   $1234                   ; EXT 18 B6 hh ll [S12X]
        GLDAA   >$40                    ; EXT 18 B6 hh ll [S12X] (forced extended)
        GLDAB   $40                     ; DIR 18 D6 dd [S12X]
        GLDAB   5,X                     ; IDX 18 E6 xb [ff|ee ff] [S12X]: 5-bit constant offset
        GLDAB   -16,Y                   ; IDX 18 E6 xb [ff|ee ff] [S12X]: 5-bit, most negative
        GLDAB   15,SP                   ; IDX 18 E6 xb [ff|ee ff] [S12X]: 5-bit, most positive
        GLDAB   0,PC                    ; IDX 18 E6 xb [ff|ee ff] [S12X]: 5-bit, PC literal
        GLDAB   A,X                     ; IDX 18 E6 xb [ff|ee ff] [S12X]: accumulator A offset
        GLDAB   B,Y                     ; IDX 18 E6 xb [ff|ee ff] [S12X]: accumulator B offset
        GLDAB   D,SP                    ; IDX 18 E6 xb [ff|ee ff] [S12X]: accumulator D offset
        GLDAB   1,+X                    ; IDX 18 E6 xb [ff|ee ff] [S12X]: pre-increment
        GLDAB   8,-Y                    ; IDX 18 E6 xb [ff|ee ff] [S12X]: pre-decrement
        GLDAB   2,SP+                   ; IDX 18 E6 xb [ff|ee ff] [S12X]: post-increment
        GLDAB   7,X-                    ; IDX 18 E6 xb [ff|ee ff] [S12X]: post-decrement
        GLDAB   16,X                    ; IDX 18 E6 xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        GLDAB   -17,Y                   ; IDX 18 E6 xb [ff|ee ff] [S12X]: 9-bit negative
        GLDAB   255,SP                  ; IDX 18 E6 xb [ff|ee ff] [S12X]: 9-bit max
        GLDAB   -256,X                  ; IDX 18 E6 xb [ff|ee ff] [S12X]: 9-bit min
        GLDAB   256,Y                   ; IDX 18 E6 xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        GLDAB   $8000,X                 ; IDX 18 E6 xb [ff|ee ff] [S12X]: 16-bit large
        GLDAB   [$1234,X]               ; IDX 18 E6 xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        GLDAB   [D,SP]                  ; IDX 18 E6 xb [ff|ee ff] [S12X]: accumulator D indirect
        GLDAB   $1234                   ; EXT 18 F6 hh ll [S12X]
        GLDAB   >$40                    ; EXT 18 F6 hh ll [S12X] (forced extended)
        GLDD    $40                     ; DIR 18 DC dd [S12X]
        GLDD    5,X                     ; IDX 18 EC xb [ff|ee ff] [S12X]: 5-bit constant offset
        GLDD    -16,Y                   ; IDX 18 EC xb [ff|ee ff] [S12X]: 5-bit, most negative
        GLDD    15,SP                   ; IDX 18 EC xb [ff|ee ff] [S12X]: 5-bit, most positive
        GLDD    0,PC                    ; IDX 18 EC xb [ff|ee ff] [S12X]: 5-bit, PC literal
        GLDD    A,X                     ; IDX 18 EC xb [ff|ee ff] [S12X]: accumulator A offset
        GLDD    B,Y                     ; IDX 18 EC xb [ff|ee ff] [S12X]: accumulator B offset
        GLDD    D,SP                    ; IDX 18 EC xb [ff|ee ff] [S12X]: accumulator D offset
        GLDD    1,+X                    ; IDX 18 EC xb [ff|ee ff] [S12X]: pre-increment
        GLDD    8,-Y                    ; IDX 18 EC xb [ff|ee ff] [S12X]: pre-decrement
        GLDD    2,SP+                   ; IDX 18 EC xb [ff|ee ff] [S12X]: post-increment
        GLDD    7,X-                    ; IDX 18 EC xb [ff|ee ff] [S12X]: post-decrement
        GLDD    16,X                    ; IDX 18 EC xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        GLDD    -17,Y                   ; IDX 18 EC xb [ff|ee ff] [S12X]: 9-bit negative
        GLDD    255,SP                  ; IDX 18 EC xb [ff|ee ff] [S12X]: 9-bit max
        GLDD    -256,X                  ; IDX 18 EC xb [ff|ee ff] [S12X]: 9-bit min
        GLDD    256,Y                   ; IDX 18 EC xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        GLDD    $8000,X                 ; IDX 18 EC xb [ff|ee ff] [S12X]: 16-bit large
        GLDD    [$1234,X]               ; IDX 18 EC xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        GLDD    [D,SP]                  ; IDX 18 EC xb [ff|ee ff] [S12X]: accumulator D indirect
        GLDD    $1234                   ; EXT 18 FC hh ll [S12X]
        GLDD    >$40                    ; EXT 18 FC hh ll [S12X] (forced extended)
        GLDY    $40                     ; DIR 18 DD dd [S12X]
        GLDY    5,X                     ; IDX 18 ED xb [ff|ee ff] [S12X]: 5-bit constant offset
        GLDY    -16,Y                   ; IDX 18 ED xb [ff|ee ff] [S12X]: 5-bit, most negative
        GLDY    15,SP                   ; IDX 18 ED xb [ff|ee ff] [S12X]: 5-bit, most positive
        GLDY    0,PC                    ; IDX 18 ED xb [ff|ee ff] [S12X]: 5-bit, PC literal
        GLDY    A,X                     ; IDX 18 ED xb [ff|ee ff] [S12X]: accumulator A offset
        GLDY    B,Y                     ; IDX 18 ED xb [ff|ee ff] [S12X]: accumulator B offset
        GLDY    D,SP                    ; IDX 18 ED xb [ff|ee ff] [S12X]: accumulator D offset
        GLDY    1,+X                    ; IDX 18 ED xb [ff|ee ff] [S12X]: pre-increment
        GLDY    8,-Y                    ; IDX 18 ED xb [ff|ee ff] [S12X]: pre-decrement
        GLDY    2,SP+                   ; IDX 18 ED xb [ff|ee ff] [S12X]: post-increment
        GLDY    7,X-                    ; IDX 18 ED xb [ff|ee ff] [S12X]: post-decrement
        GLDY    16,X                    ; IDX 18 ED xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        GLDY    -17,Y                   ; IDX 18 ED xb [ff|ee ff] [S12X]: 9-bit negative
        GLDY    255,SP                  ; IDX 18 ED xb [ff|ee ff] [S12X]: 9-bit max
        GLDY    -256,X                  ; IDX 18 ED xb [ff|ee ff] [S12X]: 9-bit min
        GLDY    256,Y                   ; IDX 18 ED xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        GLDY    $8000,X                 ; IDX 18 ED xb [ff|ee ff] [S12X]: 16-bit large
        GLDY    [$1234,X]               ; IDX 18 ED xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        GLDY    [D,SP]                  ; IDX 18 ED xb [ff|ee ff] [S12X]: accumulator D indirect
        GLDY    $1234                   ; EXT 18 FD hh ll [S12X]
        GLDY    >$40                    ; EXT 18 FD hh ll [S12X] (forced extended)
        GLDX    $40                     ; DIR 18 DE dd [S12X]
        GLDX    5,X                     ; IDX 18 EE xb [ff|ee ff] [S12X]: 5-bit constant offset
        GLDX    -16,Y                   ; IDX 18 EE xb [ff|ee ff] [S12X]: 5-bit, most negative
        GLDX    15,SP                   ; IDX 18 EE xb [ff|ee ff] [S12X]: 5-bit, most positive
        GLDX    0,PC                    ; IDX 18 EE xb [ff|ee ff] [S12X]: 5-bit, PC literal
        GLDX    A,X                     ; IDX 18 EE xb [ff|ee ff] [S12X]: accumulator A offset
        GLDX    B,Y                     ; IDX 18 EE xb [ff|ee ff] [S12X]: accumulator B offset
        GLDX    D,SP                    ; IDX 18 EE xb [ff|ee ff] [S12X]: accumulator D offset
        GLDX    1,+X                    ; IDX 18 EE xb [ff|ee ff] [S12X]: pre-increment
        GLDX    8,-Y                    ; IDX 18 EE xb [ff|ee ff] [S12X]: pre-decrement
        GLDX    2,SP+                   ; IDX 18 EE xb [ff|ee ff] [S12X]: post-increment
        GLDX    7,X-                    ; IDX 18 EE xb [ff|ee ff] [S12X]: post-decrement
        GLDX    16,X                    ; IDX 18 EE xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        GLDX    -17,Y                   ; IDX 18 EE xb [ff|ee ff] [S12X]: 9-bit negative
        GLDX    255,SP                  ; IDX 18 EE xb [ff|ee ff] [S12X]: 9-bit max
        GLDX    -256,X                  ; IDX 18 EE xb [ff|ee ff] [S12X]: 9-bit min
        GLDX    256,Y                   ; IDX 18 EE xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        GLDX    $8000,X                 ; IDX 18 EE xb [ff|ee ff] [S12X]: 16-bit large
        GLDX    [$1234,X]               ; IDX 18 EE xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        GLDX    [D,SP]                  ; IDX 18 EE xb [ff|ee ff] [S12X]: accumulator D indirect
        GLDX    $1234                   ; EXT 18 FE hh ll [S12X]
        GLDX    >$40                    ; EXT 18 FE hh ll [S12X] (forced extended)
        GLDS    $40                     ; DIR 18 DF dd [S12X]
        GLDS    5,X                     ; IDX 18 EF xb [ff|ee ff] [S12X]: 5-bit constant offset
        GLDS    -16,Y                   ; IDX 18 EF xb [ff|ee ff] [S12X]: 5-bit, most negative
        GLDS    15,SP                   ; IDX 18 EF xb [ff|ee ff] [S12X]: 5-bit, most positive
        GLDS    0,PC                    ; IDX 18 EF xb [ff|ee ff] [S12X]: 5-bit, PC literal
        GLDS    A,X                     ; IDX 18 EF xb [ff|ee ff] [S12X]: accumulator A offset
        GLDS    B,Y                     ; IDX 18 EF xb [ff|ee ff] [S12X]: accumulator B offset
        GLDS    D,SP                    ; IDX 18 EF xb [ff|ee ff] [S12X]: accumulator D offset
        GLDS    1,+X                    ; IDX 18 EF xb [ff|ee ff] [S12X]: pre-increment
        GLDS    8,-Y                    ; IDX 18 EF xb [ff|ee ff] [S12X]: pre-decrement
        GLDS    2,SP+                   ; IDX 18 EF xb [ff|ee ff] [S12X]: post-increment
        GLDS    7,X-                    ; IDX 18 EF xb [ff|ee ff] [S12X]: post-decrement
        GLDS    16,X                    ; IDX 18 EF xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        GLDS    -17,Y                   ; IDX 18 EF xb [ff|ee ff] [S12X]: 9-bit negative
        GLDS    255,SP                  ; IDX 18 EF xb [ff|ee ff] [S12X]: 9-bit max
        GLDS    -256,X                  ; IDX 18 EF xb [ff|ee ff] [S12X]: 9-bit min
        GLDS    256,Y                   ; IDX 18 EF xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        GLDS    $8000,X                 ; IDX 18 EF xb [ff|ee ff] [S12X]: 16-bit large
        GLDS    [$1234,X]               ; IDX 18 EF xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        GLDS    [D,SP]                  ; IDX 18 EF xb [ff|ee ff] [S12X]: accumulator D indirect
        GLDS    $1234                   ; EXT 18 FF hh ll [S12X]
        GLDS    >$40                    ; EXT 18 FF hh ll [S12X] (forced extended)
        GSTAA   $40                     ; DIR 18 5A dd [S12X]
        GSTAA   5,X                     ; IDX 18 6A xb [ff|ee ff] [S12X]: 5-bit constant offset
        GSTAA   -16,Y                   ; IDX 18 6A xb [ff|ee ff] [S12X]: 5-bit, most negative
        GSTAA   15,SP                   ; IDX 18 6A xb [ff|ee ff] [S12X]: 5-bit, most positive
        GSTAA   0,PC                    ; IDX 18 6A xb [ff|ee ff] [S12X]: 5-bit, PC literal
        GSTAA   A,X                     ; IDX 18 6A xb [ff|ee ff] [S12X]: accumulator A offset
        GSTAA   B,Y                     ; IDX 18 6A xb [ff|ee ff] [S12X]: accumulator B offset
        GSTAA   D,SP                    ; IDX 18 6A xb [ff|ee ff] [S12X]: accumulator D offset
        GSTAA   1,+X                    ; IDX 18 6A xb [ff|ee ff] [S12X]: pre-increment
        GSTAA   8,-Y                    ; IDX 18 6A xb [ff|ee ff] [S12X]: pre-decrement
        GSTAA   2,SP+                   ; IDX 18 6A xb [ff|ee ff] [S12X]: post-increment
        GSTAA   7,X-                    ; IDX 18 6A xb [ff|ee ff] [S12X]: post-decrement
        GSTAA   16,X                    ; IDX 18 6A xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        GSTAA   -17,Y                   ; IDX 18 6A xb [ff|ee ff] [S12X]: 9-bit negative
        GSTAA   255,SP                  ; IDX 18 6A xb [ff|ee ff] [S12X]: 9-bit max
        GSTAA   -256,X                  ; IDX 18 6A xb [ff|ee ff] [S12X]: 9-bit min
        GSTAA   256,Y                   ; IDX 18 6A xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        GSTAA   $8000,X                 ; IDX 18 6A xb [ff|ee ff] [S12X]: 16-bit large
        GSTAA   [$1234,X]               ; IDX 18 6A xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        GSTAA   [D,SP]                  ; IDX 18 6A xb [ff|ee ff] [S12X]: accumulator D indirect
        GSTAA   $1234                   ; EXT 18 7A hh ll [S12X]
        GSTAA   >$40                    ; EXT 18 7A hh ll [S12X] (forced extended)
        GSTAB   $40                     ; DIR 18 5B dd [S12X]
        GSTAB   5,X                     ; IDX 18 6B xb [ff|ee ff] [S12X]: 5-bit constant offset
        GSTAB   -16,Y                   ; IDX 18 6B xb [ff|ee ff] [S12X]: 5-bit, most negative
        GSTAB   15,SP                   ; IDX 18 6B xb [ff|ee ff] [S12X]: 5-bit, most positive
        GSTAB   0,PC                    ; IDX 18 6B xb [ff|ee ff] [S12X]: 5-bit, PC literal
        GSTAB   A,X                     ; IDX 18 6B xb [ff|ee ff] [S12X]: accumulator A offset
        GSTAB   B,Y                     ; IDX 18 6B xb [ff|ee ff] [S12X]: accumulator B offset
        GSTAB   D,SP                    ; IDX 18 6B xb [ff|ee ff] [S12X]: accumulator D offset
        GSTAB   1,+X                    ; IDX 18 6B xb [ff|ee ff] [S12X]: pre-increment
        GSTAB   8,-Y                    ; IDX 18 6B xb [ff|ee ff] [S12X]: pre-decrement
        GSTAB   2,SP+                   ; IDX 18 6B xb [ff|ee ff] [S12X]: post-increment
        GSTAB   7,X-                    ; IDX 18 6B xb [ff|ee ff] [S12X]: post-decrement
        GSTAB   16,X                    ; IDX 18 6B xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        GSTAB   -17,Y                   ; IDX 18 6B xb [ff|ee ff] [S12X]: 9-bit negative
        GSTAB   255,SP                  ; IDX 18 6B xb [ff|ee ff] [S12X]: 9-bit max
        GSTAB   -256,X                  ; IDX 18 6B xb [ff|ee ff] [S12X]: 9-bit min
        GSTAB   256,Y                   ; IDX 18 6B xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        GSTAB   $8000,X                 ; IDX 18 6B xb [ff|ee ff] [S12X]: 16-bit large
        GSTAB   [$1234,X]               ; IDX 18 6B xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        GSTAB   [D,SP]                  ; IDX 18 6B xb [ff|ee ff] [S12X]: accumulator D indirect
        GSTAB   $1234                   ; EXT 18 7B hh ll [S12X]
        GSTAB   >$40                    ; EXT 18 7B hh ll [S12X] (forced extended)
        GSTD    $40                     ; DIR 18 5C dd [S12X]
        GSTD    5,X                     ; IDX 18 6C xb [ff|ee ff] [S12X]: 5-bit constant offset
        GSTD    -16,Y                   ; IDX 18 6C xb [ff|ee ff] [S12X]: 5-bit, most negative
        GSTD    15,SP                   ; IDX 18 6C xb [ff|ee ff] [S12X]: 5-bit, most positive
        GSTD    0,PC                    ; IDX 18 6C xb [ff|ee ff] [S12X]: 5-bit, PC literal
        GSTD    A,X                     ; IDX 18 6C xb [ff|ee ff] [S12X]: accumulator A offset
        GSTD    B,Y                     ; IDX 18 6C xb [ff|ee ff] [S12X]: accumulator B offset
        GSTD    D,SP                    ; IDX 18 6C xb [ff|ee ff] [S12X]: accumulator D offset
        GSTD    1,+X                    ; IDX 18 6C xb [ff|ee ff] [S12X]: pre-increment
        GSTD    8,-Y                    ; IDX 18 6C xb [ff|ee ff] [S12X]: pre-decrement
        GSTD    2,SP+                   ; IDX 18 6C xb [ff|ee ff] [S12X]: post-increment
        GSTD    7,X-                    ; IDX 18 6C xb [ff|ee ff] [S12X]: post-decrement
        GSTD    16,X                    ; IDX 18 6C xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        GSTD    -17,Y                   ; IDX 18 6C xb [ff|ee ff] [S12X]: 9-bit negative
        GSTD    255,SP                  ; IDX 18 6C xb [ff|ee ff] [S12X]: 9-bit max
        GSTD    -256,X                  ; IDX 18 6C xb [ff|ee ff] [S12X]: 9-bit min
        GSTD    256,Y                   ; IDX 18 6C xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        GSTD    $8000,X                 ; IDX 18 6C xb [ff|ee ff] [S12X]: 16-bit large
        GSTD    [$1234,X]               ; IDX 18 6C xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        GSTD    [D,SP]                  ; IDX 18 6C xb [ff|ee ff] [S12X]: accumulator D indirect
        GSTD    $1234                   ; EXT 18 7C hh ll [S12X]
        GSTD    >$40                    ; EXT 18 7C hh ll [S12X] (forced extended)
        GSTY    $40                     ; DIR 18 5D dd [S12X]
        GSTY    5,X                     ; IDX 18 6D xb [ff|ee ff] [S12X]: 5-bit constant offset
        GSTY    -16,Y                   ; IDX 18 6D xb [ff|ee ff] [S12X]: 5-bit, most negative
        GSTY    15,SP                   ; IDX 18 6D xb [ff|ee ff] [S12X]: 5-bit, most positive
        GSTY    0,PC                    ; IDX 18 6D xb [ff|ee ff] [S12X]: 5-bit, PC literal
        GSTY    A,X                     ; IDX 18 6D xb [ff|ee ff] [S12X]: accumulator A offset
        GSTY    B,Y                     ; IDX 18 6D xb [ff|ee ff] [S12X]: accumulator B offset
        GSTY    D,SP                    ; IDX 18 6D xb [ff|ee ff] [S12X]: accumulator D offset
        GSTY    1,+X                    ; IDX 18 6D xb [ff|ee ff] [S12X]: pre-increment
        GSTY    8,-Y                    ; IDX 18 6D xb [ff|ee ff] [S12X]: pre-decrement
        GSTY    2,SP+                   ; IDX 18 6D xb [ff|ee ff] [S12X]: post-increment
        GSTY    7,X-                    ; IDX 18 6D xb [ff|ee ff] [S12X]: post-decrement
        GSTY    16,X                    ; IDX 18 6D xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        GSTY    -17,Y                   ; IDX 18 6D xb [ff|ee ff] [S12X]: 9-bit negative
        GSTY    255,SP                  ; IDX 18 6D xb [ff|ee ff] [S12X]: 9-bit max
        GSTY    -256,X                  ; IDX 18 6D xb [ff|ee ff] [S12X]: 9-bit min
        GSTY    256,Y                   ; IDX 18 6D xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        GSTY    $8000,X                 ; IDX 18 6D xb [ff|ee ff] [S12X]: 16-bit large
        GSTY    [$1234,X]               ; IDX 18 6D xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        GSTY    [D,SP]                  ; IDX 18 6D xb [ff|ee ff] [S12X]: accumulator D indirect
        GSTY    $1234                   ; EXT 18 7D hh ll [S12X]
        GSTY    >$40                    ; EXT 18 7D hh ll [S12X] (forced extended)
        GSTX    $40                     ; DIR 18 5E dd [S12X]
        GSTX    5,X                     ; IDX 18 6E xb [ff|ee ff] [S12X]: 5-bit constant offset
        GSTX    -16,Y                   ; IDX 18 6E xb [ff|ee ff] [S12X]: 5-bit, most negative
        GSTX    15,SP                   ; IDX 18 6E xb [ff|ee ff] [S12X]: 5-bit, most positive
        GSTX    0,PC                    ; IDX 18 6E xb [ff|ee ff] [S12X]: 5-bit, PC literal
        GSTX    A,X                     ; IDX 18 6E xb [ff|ee ff] [S12X]: accumulator A offset
        GSTX    B,Y                     ; IDX 18 6E xb [ff|ee ff] [S12X]: accumulator B offset
        GSTX    D,SP                    ; IDX 18 6E xb [ff|ee ff] [S12X]: accumulator D offset
        GSTX    1,+X                    ; IDX 18 6E xb [ff|ee ff] [S12X]: pre-increment
        GSTX    8,-Y                    ; IDX 18 6E xb [ff|ee ff] [S12X]: pre-decrement
        GSTX    2,SP+                   ; IDX 18 6E xb [ff|ee ff] [S12X]: post-increment
        GSTX    7,X-                    ; IDX 18 6E xb [ff|ee ff] [S12X]: post-decrement
        GSTX    16,X                    ; IDX 18 6E xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        GSTX    -17,Y                   ; IDX 18 6E xb [ff|ee ff] [S12X]: 9-bit negative
        GSTX    255,SP                  ; IDX 18 6E xb [ff|ee ff] [S12X]: 9-bit max
        GSTX    -256,X                  ; IDX 18 6E xb [ff|ee ff] [S12X]: 9-bit min
        GSTX    256,Y                   ; IDX 18 6E xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        GSTX    $8000,X                 ; IDX 18 6E xb [ff|ee ff] [S12X]: 16-bit large
        GSTX    [$1234,X]               ; IDX 18 6E xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        GSTX    [D,SP]                  ; IDX 18 6E xb [ff|ee ff] [S12X]: accumulator D indirect
        GSTX    $1234                   ; EXT 18 7E hh ll [S12X]
        GSTX    >$40                    ; EXT 18 7E hh ll [S12X] (forced extended)
        GSTS    $40                     ; DIR 18 5F dd [S12X]
        GSTS    5,X                     ; IDX 18 6F xb [ff|ee ff] [S12X]: 5-bit constant offset
        GSTS    -16,Y                   ; IDX 18 6F xb [ff|ee ff] [S12X]: 5-bit, most negative
        GSTS    15,SP                   ; IDX 18 6F xb [ff|ee ff] [S12X]: 5-bit, most positive
        GSTS    0,PC                    ; IDX 18 6F xb [ff|ee ff] [S12X]: 5-bit, PC literal
        GSTS    A,X                     ; IDX 18 6F xb [ff|ee ff] [S12X]: accumulator A offset
        GSTS    B,Y                     ; IDX 18 6F xb [ff|ee ff] [S12X]: accumulator B offset
        GSTS    D,SP                    ; IDX 18 6F xb [ff|ee ff] [S12X]: accumulator D offset
        GSTS    1,+X                    ; IDX 18 6F xb [ff|ee ff] [S12X]: pre-increment
        GSTS    8,-Y                    ; IDX 18 6F xb [ff|ee ff] [S12X]: pre-decrement
        GSTS    2,SP+                   ; IDX 18 6F xb [ff|ee ff] [S12X]: post-increment
        GSTS    7,X-                    ; IDX 18 6F xb [ff|ee ff] [S12X]: post-decrement
        GSTS    16,X                    ; IDX 18 6F xb [ff|ee ff] [S12X]: 9-bit (just outside 5-bit)
        GSTS    -17,Y                   ; IDX 18 6F xb [ff|ee ff] [S12X]: 9-bit negative
        GSTS    255,SP                  ; IDX 18 6F xb [ff|ee ff] [S12X]: 9-bit max
        GSTS    -256,X                  ; IDX 18 6F xb [ff|ee ff] [S12X]: 9-bit min
        GSTS    256,Y                   ; IDX 18 6F xb [ff|ee ff] [S12X]: 16-bit (just outside 9-bit)
        GSTS    $8000,X                 ; IDX 18 6F xb [ff|ee ff] [S12X]: 16-bit large
        GSTS    [$1234,X]               ; IDX 18 6F xb [ff|ee ff] [S12X]: indexed indirect 16-bit
        GSTS    [D,SP]                  ; IDX 18 6F xb [ff|ee ff] [S12X]: accumulator D indirect
        GSTS    $1234                   ; EXT 18 7F hh ll [S12X]
        GSTS    >$40                    ; EXT 18 7F hh ll [S12X] (forced extended)

; ---- S12X register spellings (TFR/EXG with CCRW, CCRH, XH, XL ...) ----------------------
            IFNDEF NO_XREGS
        TFR     CCRW,D                  ; TFR_EXG B7 eb
        TFR     D,CCRW                  ; TFR_EXG B7 eb
        TFR     A,XH                    ; TFR_EXG B7 eb
        TFR     B,XL                    ; TFR_EXG B7 eb
        TFR     XH,A                    ; TFR_EXG B7 eb
        TFR     CCRH,A                  ; TFR_EXG B7 eb
        TFR     A,CCRH                  ; TFR_EXG B7 eb
        EXG     CCRW,D                  ; TFR_EXG B7 eb
        EXG     D,CCRW                  ; TFR_EXG B7 eb
        EXG     A,XH                    ; TFR_EXG B7 eb
        EXG     B,XL                    ; TFR_EXG B7 eb
        EXG     XH,A                    ; TFR_EXG B7 eb (S12X extended registers)
        EXG     CCRH,A                  ; TFR_EXG B7 eb (S12X extended registers)
        EXG     A,CCRH                  ; TFR_EXG B7 eb
            ENDIF
