/**
 * VisualizationTool-lite model: instruments, expression bindings, value decoding and the per-project config file.
 *
 * hiwave's VisualizationTool has dozens of instrument types and saves `.vtl` files; this is a small subset with our
 * own JSON format. UNCERTAIN: file name/format are ours, not CodeWarrior's (`<projectDir>/S12Studio.vtl.json`,
 * `{ version: 1, windows: { "<key>": Instrument[] } }`; key = configKey(window instance): "VisualizationTool" for the
 * first window, "VisualizationTool:<n>" for the n-th, so renumbered titles never lose a window's instruments).
 *
 * Bindings ("expressions"): a CPU register (A, B, D, X, Y, SP, PC, CCR...), a number ($258, 0x258, 600), an
 * MC9S12XDP512 register name (PTP, PORTB, PTT...), or any symbol/expression the debugger can resolve to an address
 * (debug.resolve). Memory values are read with useMemoryWatch (big-endian for 2-byte values).
 */
import { registerByName } from '@s12/devices';
import { REGISTER_NAMES, type DebugSnapshot, type MemoryBlockInfo, type RegisterName } from '../../../../shared/api';
import { formatNumber, parseNumber } from '../../../common/format';

export type InstrumentKind = 'led' | 'seg7' | 'bar' | 'text';
export type LedColor = 'red' | 'green' | 'yellow' | 'blue';
export type Seg7Mode = 'hex' | 'dec' | 'segments';
export type TextFormat = 'hex' | 'dec' | 'udec' | 'bin' | 'char';

export interface Instrument {
  id: string;
  kind: InstrumentKind;
  label: string;
  /** Position in the canvas (px). */
  x: number;
  y: number;
  /** Binding: register, address, device register or symbol. */
  expr: string;
  /** Value width in bytes (1 or 2). */
  size: 1 | 2;
  /** LED: bit number (0-7 for bytes, 0-15 for words). */
  bit?: number;
  activeLow?: boolean;
  color?: LedColor;
  /** 7-segment: digits from the value (hex/dec) or the byte drives the segments (bit0 = a ... bit6 = g, bit7 = dp). */
  mode?: Seg7Mode;
  /** Bar graph range. */
  min?: number;
  max?: number;
  format?: TextFormat;
}

export interface VisConfig {
  version: 1;
  windows: Record<string, Instrument[]>;
}

export const KIND_NAMES: Record<InstrumentKind, string> = {
  led: 'LED',
  seg7: '7-Segment',
  bar: 'Bar Graph',
  text: 'Text Value',
};

let idSeq = 0;
export const newId = (): string => `i${Date.now().toString(36)}${(idSeq++).toString(36)}`;

/**
 * A new instrument with sensible defaults (LED on PTP bit 4 = the green LED of pair 2). The label is empty: the
 * instrument then shows autoLabel() (follows the expression/bit) until the user types a label.
 */
export function newInstrument(kind: InstrumentKind, x = 8, y = 8): Instrument {
  const base = { id: newId(), kind, label: '', x, y, size: 1 as const };
  switch (kind) {
    case 'led':
      return { ...base, expr: 'PTP', bit: 4, color: 'green', activeLow: false };
    case 'seg7':
      return { ...base, expr: 'PORTB', mode: 'hex' };
    case 'bar':
      return { ...base, expr: 'A', min: 0, max: 255 };
    case 'text':
      return { ...base, expr: 'PC', size: 2, format: 'hex' };
  }
}

/** Label shown when the user gave none: the expression, plus the bit for LEDs ("PTP.4"). */
export function autoLabel(inst: Pick<Instrument, 'kind' | 'expr' | 'bit'>): string {
  const e = inst.expr.trim();
  return inst.kind === 'led' ? `${e}.${inst.bit ?? 0}` : e;
}

export const displayLabel = (inst: Instrument): string => inst.label.trim() || autoLabel(inst);

// ------------------------------------------------------------------------------------------------ placement

/** Approximate rendered size (px, incl. label and padding) of an instrument; used to place new ones. */
export function approxSize(inst: Pick<Instrument, 'kind' | 'size' | 'mode'>): {
  w: number;
  h: number;
} {
  switch (inst.kind) {
    case 'led':
      return { w: 48, h: 48 };
    case 'seg7': {
      const mode = inst.mode ?? 'hex';
      const digits = mode === 'segments' ? inst.size : mode === 'hex' ? inst.size * 2 : inst.size === 2 ? 5 : 3;
      return { w: digits * 24 + 12, h: 62 };
    }
    case 'bar':
      return { w: 150, h: 48 };
    case 'text':
      return { w: 96, h: 40 };
  }
}

/** Slot grid for new instruments (px). */
export const SLOT_W = 160;
export const SLOT_H = 72;
const MARGIN = 8;

/**
 * Top-left of the first free slot (row by row, `canvasWidth` wide) for a new instrument, so instruments added from
 * the toolbar/menu do not pile up on each other. A slot is free when the new instrument's box does not overlap any
 * existing instrument's (approximate) box.
 */
export function freeSlot(items: readonly Instrument[], next: Pick<Instrument, 'kind' | 'size' | 'mode'>, canvasWidth: number): { x: number; y: number } {
  const cols = Math.max(1, Math.floor((Math.max(0, canvasWidth) - MARGIN) / SLOT_W));
  const me = approxSize(next);
  const boxes = items.map((i) => ({ x: i.x, y: i.y, ...approxSize(i) }));
  for (let n = 0; n < 10_000; n++) {
    const x = MARGIN + (n % cols) * SLOT_W;
    const y = MARGIN + Math.floor(n / cols) * SLOT_H;
    if (!boxes.some((b) => x < b.x + b.w && b.x < x + me.w && y < b.y + b.h && b.y < y + me.h)) return { x, y };
  }
  return { x: MARGIN, y: MARGIN };
}

// ------------------------------------------------------------------------------------------------ bindings

export type Binding = { kind: 'reg'; name: RegisterName } | { kind: 'mem'; address: number } | { kind: 'error'; message: string };

/** Resolve without the debugger: CPU register, number, or device register. Null = ask debug.resolve. */
export function resolveLocal(expr: string): Binding | null {
  const e = expr.trim();
  if (!e) return { kind: 'error', message: 'empty expression' };
  const reg = REGISTER_NAMES.find((r) => r.toLowerCase() === e.toLowerCase());
  if (reg) return { kind: 'reg', name: reg };
  if (/^(IX|IY)$/i.test(e)) return { kind: 'reg', name: e.toUpperCase() === 'IX' ? 'X' : 'Y' };
  const n = /^[$%@]|^0[xbo]|^\d/i.test(e) ? parseNumber(e, 10) : null;
  if (n !== null) return n >= 0 && n <= 0xffffff ? { kind: 'mem', address: n } : { kind: 'error', message: 'address out of range' };
  const dev = registerByName(e);
  if (dev) return { kind: 'mem', address: dev.address };
  return null;
}

/** Instrument value (unsigned, `size` bytes) from the snapshot / watched memory; null when unavailable. */
export function readValue(inst: Pick<Instrument, 'size'>, b: Binding | undefined, snap: DebugSnapshot, mem: ReadonlyMap<number, number> | null): number | null {
  if (!b || b.kind === 'error') return null;
  if (b.kind === 'reg') {
    const v = snap.registers?.[b.name];
    return v === undefined ? null : v;
  }
  if (!mem) return null;
  let v = 0;
  for (let i = 0; i < inst.size; i++) {
    const byte = mem.get(b.address + i);
    if (byte === undefined) return null;
    v = (v << 8) | byte;
  }
  return v >>> 0;
}

/** Byte map (address -> byte) from watched blocks; unmapped/uninitialized bytes are left out. */
export function bytesOf(blocks: readonly MemoryBlockInfo[] | null): Map<number, number> | null {
  if (!blocks) return null;
  const m = new Map<number, number>();
  for (const b of blocks) for (let i = 0; i < b.bytes.length; i++) if (b.status[i] === 0) m.set(b.address + i, b.bytes[i]);
  return m;
}

/** Merge memory bindings into a few watch ranges (sorted, adjacent/overlapping ranges joined). */
export function watchRanges(items: readonly { address: number; size: number }[]): { address: number; length: number }[] {
  const s = [...items].sort((a, b) => a.address - b.address);
  const out: { address: number; length: number }[] = [];
  for (const it of s) {
    const last = out[out.length - 1];
    if (last && it.address <= last.address + last.length) last.length = Math.max(last.length, it.address + it.size - last.address);
    else out.push({ address: it.address, length: it.size });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ display

export function ledOn(inst: Instrument, v: number | null): boolean | null {
  if (v === null) return null;
  const on = ((v >>> (inst.bit ?? 0)) & 1) === 1;
  return inst.activeLow ? !on : on;
}

export function formatText(inst: Instrument, v: number | null): string {
  if (v === null) return '--';
  const bits = inst.size === 2 ? 16 : 8;
  const f = inst.format ?? 'hex';
  if (f === 'hex') return '$' + formatNumber(v, 'hex', bits);
  if (f === 'bin') return '%' + formatNumber(v, 'bin', bits);
  if (f === 'char' && inst.size === 2) return formatNumber(v >> 8, 'char') + formatNumber(v, 'char');
  return formatNumber(v, f, bits);
}

/** Segment masks (bit0 = a ... bit6 = g) of hex digits 0-F. */
export const SEG_DIGITS = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71];
/** All segments off except g ("-"), for unknown values. */
export const SEG_DASH = 0x40;

/** Segment masks (bit 7 = dp), one per digit, most significant first. */
export function seg7Digits(inst: Instrument, v: number | null): number[] {
  const mode = inst.mode ?? 'hex';
  if (mode === 'segments') {
    const n = inst.size;
    if (v === null) return Array(n).fill(SEG_DASH);
    return Array.from({ length: n }, (_, i) => (v >>> (8 * (n - 1 - i))) & 0xff);
  }
  const n = mode === 'hex' ? inst.size * 2 : inst.size === 2 ? 5 : 3;
  if (v === null) return Array(n).fill(SEG_DASH);
  const radix = mode === 'hex' ? 16 : 10;
  const digits: number[] = [];
  let x = v;
  for (let i = 0; i < n; i++) {
    digits.unshift(SEG_DIGITS[x % radix]);
    x = Math.floor(x / radix);
  }
  // blank leading zeros in decimal mode (keep the last digit)
  if (mode === 'dec') for (let i = 0; i < n - 1 && digits[i] === SEG_DIGITS[0]; i++) digits[i] = 0;
  return digits;
}

export function barFraction(inst: Instrument, v: number | null): number {
  if (v === null) return 0;
  const min = inst.min ?? 0;
  const max = inst.max ?? (inst.size === 2 ? 0xffff : 0xff);
  if (max === min) return 0;
  return Math.max(0, Math.min(1, (v - min) / (max - min)));
}

// ------------------------------------------------------------------------------------------------ persistence

export const CONFIG_FILE = 'S12Studio.vtl.json';

/**
 * Config key of a VisualizationTool window: by its instance number, not its title (the shell renames the first
 * window "VisualizationTool" -> "VisualizationTool:1" when a second one opens). Instance 1 uses the plain name, which
 * is also what a single window was saved under before.
 */
export function configKey(instance: number): string {
  return instance > 1 ? `VisualizationTool:${instance}` : 'VisualizationTool';
}

export function configPath(projectDir: string): string {
  const sep = projectDir.includes('\\') && !projectDir.includes('/') ? '\\' : '/';
  return projectDir.replace(/[\\/]+$/, '') + sep + CONFIG_FILE;
}

const KINDS: readonly InstrumentKind[] = ['led', 'seg7', 'bar', 'text'];

/** Validate one instrument read from disk (drops unknown fields, fixes ranges); null if unusable. */
export function sanitizeInstrument(raw: unknown): Instrument | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind as InstrumentKind;
  if (!KINDS.includes(kind) || typeof r.expr !== 'string') return null;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const inst: Instrument = {
    id: typeof r.id === 'string' && r.id ? r.id : newId(),
    kind,
    label: typeof r.label === 'string' ? r.label : '',
    x: Math.max(0, num(r.x, 8)),
    y: Math.max(0, num(r.y, 8)),
    expr: r.expr,
    size: r.size === 2 ? 2 : 1,
  };
  if (kind === 'led') {
    inst.bit = Math.max(0, Math.min(15, Math.trunc(num(r.bit, 0))));
    inst.activeLow = r.activeLow === true;
    inst.color = (['red', 'green', 'yellow', 'blue'] as const).find((c) => c === r.color) ?? 'red';
  } else if (kind === 'seg7') inst.mode = (['hex', 'dec', 'segments'] as const).find((c) => c === r.mode) ?? 'hex';
  else if (kind === 'bar') {
    inst.min = num(r.min, 0);
    inst.max = num(r.max, inst.size === 2 ? 0xffff : 0xff);
  } else inst.format = (['hex', 'dec', 'udec', 'bin', 'char'] as const).find((c) => c === r.format) ?? 'hex';
  return inst;
}

export function parseConfig(text: string): VisConfig {
  try {
    const j = JSON.parse(text) as { windows?: Record<string, unknown> };
    const windows: Record<string, Instrument[]> = {};
    for (const [k, v] of Object.entries(j.windows ?? {})) if (Array.isArray(v)) windows[k] = v.map(sanitizeInstrument).filter((x): x is Instrument => x !== null);
    return { version: 1, windows };
  } catch {
    return { version: 1, windows: {} };
  }
}

export function serializeConfig(c: VisConfig): string {
  return JSON.stringify(c, null, 2) + '\n';
}
