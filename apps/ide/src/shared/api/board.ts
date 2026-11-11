/**
 * Board API (debugger window, "ME3305 Board" and VisualizationTool components): the simulated ME3305 board of the
 * debug session (@s12/sim Me3305BoardModel). State is pushed with `state` events at the snapshot rate while running
 * and after every halt.
 */

export interface LcdState {
  /** Visible text per row (40 chars; CGRAM glyphs as U+E000+n; blank when the display is off). */
  lines: string[];
  cursor: { row: number; col: number } | null;
  cursorVisible: boolean;
  blinkOn: boolean;
  displayOn: boolean;
  /** 8 CGRAM glyphs x 8 rows, 5 LSBs = pixels (bit 4 leftmost). */
  cgram: number[][];
  /** Underline cursor bit (C of Display Control; HD44780 view().cursorOn), separate from blink (B). */
  cursorOn?: boolean; // added-by: board-ui
}

export interface LedState {
  /** Port pin, e.g. "PP4". */
  pin: string;
  color: 'green' | 'red';
  pair: number;
  on: boolean;
  /** Fraction of simulated time the LED was on since the previous board state (0..1; Leds edge history). */
  onFraction?: number; // added-by: board-ui
}

export interface KeyDef {
  /** Label printed on the key ('0'..'9', 'A'..'F', 'F1', 'F2', 'BKSP', 'ENT'). */
  label: string;
  code: number;
  row: number;
  col: number;
  /** PC keyboard keys (KeyboardEvent.key values). */
  pcKeys: string[];
}

export interface MotorStateInfo {
  current: number;
  omega: number;
  rpm: number;
  angle: number;
  volts: number;
  duty: number;
  direction: 1 | -1;
  enabled: boolean;
  encoderEdges: number;
  senseVolts: number;
}

export interface BoardState {
  /** False when the session has no board (bare MCU) or no session. */
  present: boolean;
  seq: number;
  simSeconds: number;
  lcd: LcdState | null;
  leds: LedState[];
  /** Labels of keys currently held down. */
  keysDown: string[];
  /** LS7366R counter (CNTR). */
  encoderCount: number;
  dac: { a: number; b: number };
  motor: MotorStateInfo | null;
}

export interface MotorParamsPatch {
  /** Any @s12/sim MotorParams field (R, L, Kt, Ke, J, b, supplyVolts...). */
  [key: string]: number;
}

export interface BoardApi {
  state(): Promise<BoardState>;
  keys(): Promise<KeyDef[]>;
  pressKey(label: string): Promise<void>;
  releaseKey(label: string): Promise<void>;
  /** Press and release after `holdSeconds` of simulated time (default 0.1). */
  tapKey(label: string, holdSeconds?: number): Promise<void>;
  setMotorParams(patch: MotorParamsPatch): Promise<void>;
  setLoadTorque(nm: number): Promise<void>;
  /** Analog input voltage on an ATD channel (stimulus). */
  setAnalogInput(atd: 0 | 1, channel: number, volts: number): Promise<void>;
  /** Drive an input pin from outside ("PH0", level 0/1, or null = release). */
  setPin(pin: string, level: 0 | 1 | null): Promise<void>;
  /** Board power cycle (LCD, encoder, DAC, motor, keypad to power-on). */
  powerCycle(): Promise<void>;
}

export interface BoardEvents {
  state: BoardState;
}

export const BOARD_METHODS = ['state', 'keys', 'pressKey', 'releaseKey', 'tapKey', 'setMotorParams', 'setLoadTorque', 'setAnalogInput', 'setPin', 'powerCycle'] as const;
