;******************************************************************************
;* S12 Studio example -- Apache-2.0
;* blinky: ME3305 board demo for the MC9S12XDP512 (relocatable assembly, no
;* course library). Everything here is our own code:
;*   - CRG: 16 MHz crystal -> PLL 20 MHz -> 10 MHz bus
;*   - ECT: TCNT at bus/32 (3.2 us), output compare 0 = 10 ms tick, TC1 = delays
;*   - LEDs PP4..PP7: PP4+PP6 and PP5+PP7 alternate every RATE x 100 ms
;*   - 40x2 HD44780 LCD: data on PORTB, RS = PM4, R/W = PM5, E = PM6
;*   - keypad encoder (74C923): key code on PK0..PK4, /OE = PK5, DA = PJ7;
;*     keys 1..9 set RATE (default 5 = 500 ms per LED step)
;******************************************************************************

            XDEF    Entry, main
            XREF    __SEG_END_SSTACK      ; top of the stack, set by the linker

            INCLUDE 'derivative.inc'

TICK        EQU     3125                  ; 10 ms in TCNT ticks (10 MHz / 32)
DELAY5MS    EQU     1563                  ; ~5 ms in TCNT ticks
LCD_RS      EQU     $10                   ; PM4
LCD_RW      EQU     $20                   ; PM5
LCD_E       EQU     $40                   ; PM6
KEY_DA      EQU     $80                   ; PJ7
KEY_OE      EQU     $20                   ; PK5 (encoder output enable, active low)
LINE2       EQU     $40                   ; DDRAM address of LCD line 2
RATE_POS    EQU     LINE2+7               ; DDRAM address of the rate digit

;------------------------------------------------------------------------------
; variables
;------------------------------------------------------------------------------
DEFAULT_RAM: SECTION
ticks:      DS.B    1                     ; 10 ms ticks left until the next LED step
reload:     DS.B    1                     ; RATE x 10
rate:       DS.B    1                     ; 1..9 (x 100 ms)
lastda:     DS.B    1                     ; previous PJ7 level (edge detection)

;------------------------------------------------------------------------------
; code
;------------------------------------------------------------------------------
MyCode:     SECTION
Entry:
main:       LDS     #__SEG_END_SSTACK     ; set up the stack
            JSR     init_pll
            JSR     init_timer
            ; LEDs: PP4..PP7 outputs, start with PP4 + PP6 on
            MOVB    #$50, PTP
            MOVB    #$F0, DDRP
            ; keypad: PK0..PK4 inputs, PK5 = 0 enables the encoder outputs
            BCLR    PORTK, #KEY_OE
            MOVB    #KEY_OE, DDRK
            BCLR    DDRJ, #KEY_DA
            LDAA    PTJ
            ANDA    #KEY_DA
            STAA    lastda
            ; blink rate
            MOVB    #5, rate
            MOVB    #50, reload
            MOVB    #50, ticks
            ; LCD
            JSR     lcd_init
            LDAA    #$00
            LDX     #msg1
            JSR     lcd_str_at
            LDAA    #LINE2
            LDX     #msg2
            JSR     lcd_str_at

loop:       BRCLR   TFLG1, #$01, keys     ; 10 ms tick?
            MOVB    #$01, TFLG1           ; clear C0F (write 1)
            LDD     TC0
            ADDD    #TICK                 ; next tick, drift-free
            STD     TC0
            DEC     ticks
            BNE     keys
            MOVB    reload, ticks
            LDAA    PTP                   ; LED step: swap the two pairs
            EORA    #$F0
            STAA    PTP
keys:       LDAA    PTJ                   ; key data available (DA rising edge)?
            ANDA    #KEY_DA
            CMPA    lastda
            BEQ     loop
            STAA    lastda
            TSTA
            BEQ     loop                  ; falling edge: key released
            LDAB    PORTK
            ANDB    #$1F                  ; encoder code 0..19
            CMPB    #20
            BHS     loop
            LDX     #keytab
            LDAA    B,X                   ; key value
            CMPA    #1
            BLO     loop                  ; 0 and function keys: ignored
            CMPA    #9
            BHI     loop
            STAA    rate
            LDAB    #10
            MUL                           ; D = rate x 10
            STAB    reload
            LDAA    #RATE_POS             ; show the new rate digit
            JSR     lcd_addr
            LDAA    rate
            ADDA    #'0'
            JSR     lcd_data
            BRA     loop

;------------------------------------------------------------------------------
; clock: PLLCLK = 2 x 16 MHz x (SYNR+1) / (REFDV+1) = 20 MHz, bus 10 MHz
;------------------------------------------------------------------------------
init_pll:   BCLR    CLKSEL, #$80          ; run from the oscillator while changing
            BSET    PLLCTL, #$40          ; PLL on
            MOVB    #4, SYNR
            MOVB    #7, REFDV
            NOP
            NOP
pll_wait:   BRCLR   CRGFLG, #$08, pll_wait ; wait for LOCK
            BSET    CLKSEL, #$80          ; PLLSEL: bus = PLLCLK / 2
            RTS

;------------------------------------------------------------------------------
; timer: TCNT at bus/32, OC0 = periodic tick, OC1 = delays
;------------------------------------------------------------------------------
init_timer: MOVB    #$80, TSCR1           ; TEN
            MOVB    #$05, TSCR2           ; prescaler 32
            BSET    TIOS, #$03            ; channels 0 and 1 output compare
            LDD     TCNT
            ADDD    #TICK
            STD     TC0
            MOVB    #$03, TFLG1           ; clear C0F and C1F
            RTS

; wait ~5 ms (TC1 compare)
delay5ms:   LDD     TCNT
            ADDD    #DELAY5MS
            STD     TC1
            MOVB    #$02, TFLG1
d5_wait:    BRCLR   TFLG1, #$02, d5_wait
            RTS

;------------------------------------------------------------------------------
; HD44780 LCD, 8-bit bus, busy flag polled
;------------------------------------------------------------------------------
lcd_init:   MOVB    #$FF, DDRB
            BCLR    PTM, #LCD_RS|LCD_RW|LCD_E
            BSET    DDRM, #LCD_RS|LCD_RW|LCD_E
            JSR     delay5ms
            LDAA    #$30                  ; 3 x function set "8-bit" (no busy flag yet)
            JSR     lcd_raw
            JSR     delay5ms
            LDAA    #$30
            JSR     lcd_raw
            JSR     delay5ms
            LDAA    #$30
            JSR     lcd_raw
            JSR     delay5ms
            LDAA    #$38                  ; 8-bit, 2 lines, 5x8 font
            JSR     lcd_cmd
            LDAA    #$08                  ; display off
            JSR     lcd_cmd
            LDAA    #$01                  ; clear
            JSR     lcd_cmd
            LDAA    #$06                  ; entry mode: increment, no shift
            JSR     lcd_cmd
            LDAA    #$0C                  ; display on, cursor off
            JSR     lcd_cmd
            RTS

; write A as a command without the busy check (RS = 0, R/W = 0)
lcd_raw:    BCLR    PTM, #LCD_RS|LCD_RW
            MOVB    #$FF, DDRB
            STAA    PORTB
            BSET    PTM, #LCD_E
            NOP                           ; E high >= 450 ns (PW_EH) at a 10 MHz bus
            NOP
            BCLR    PTM, #LCD_E           ; latched on the falling edge
            RTS

; set the DDRAM address to A
lcd_addr:   ORAA    #$80
; write command A, then wait until the LCD is ready
lcd_cmd:    BCLR    PTM, #LCD_RS
            BRA     lcd_write
; write character A, then wait until the LCD is ready
lcd_data:   BSET    PTM, #LCD_RS
lcd_write:  BCLR    PTM, #LCD_RW
            MOVB    #$FF, DDRB
            STAA    PORTB
            BSET    PTM, #LCD_E
            NOP                           ; E high >= 450 ns (PW_EH)
            NOP
            BCLR    PTM, #LCD_E
            ; busy flag: RS = 0, R/W = 1, read D7 while E is high (B is clobbered)
            CLR     DDRB
            BCLR    PTM, #LCD_RS
            BSET    PTM, #LCD_RW
lcd_busy:   BSET    PTM, #LCD_E
            NOP                           ; data valid 360 ns after E rises (t_DDR)
            NOP
            LDAB    PORTB
            BCLR    PTM, #LCD_E
            TSTB
            BMI     lcd_busy
            BCLR    PTM, #LCD_RW
            RTS

; write the NUL-terminated string at X from DDRAM address A
lcd_str_at: JSR     lcd_addr
lcd_str:    LDAA    1,X+
            BEQ     lcd_done
            JSR     lcd_data
            BRA     lcd_str
lcd_done:   RTS

;------------------------------------------------------------------------------
; constant data
;------------------------------------------------------------------------------
msg1:       DC.B    'S12 Studio blinky demo', 0
msg2:       DC.B    'Blink: 500 ms per step  (keys 1-9)', 0

; 74C923 encoder code -> key value (0..15 = hex digit, $10 ENT, $11 BKSP, $12 F2, $13 F1)
keytab:     DC.B    $0C, $08, $04, $00, $0D, $09, $05, $01
            DC.B    $0E, $0A, $06, $02, $0F, $0B, $07, $03
            DC.B    $10, $11, $12, $13
