/**
 * Cycle counting from CPU12/CPU12X access-detail strings.
 *
 * Each letter is one bus cycle (f g I i n O P r R s S t T u U V w W x). `,` marks an interrupt
 * point and costs nothing. Text in parentheses is a microcode loop that repeats a data-dependent
 * number of times (REV/REVW/WAV) and is reported separately.
 */
import type { IdxClass } from './postbyte.js';
import { accessFor, type AccessKey, type Cpu, type OpForm } from './table.js';

export interface AccessInfo {
  text: string;
  /** Cycles outside any loop. */
  cycles: number;
  /** Loop body text (without parentheses), when present. */
  loop?: string;
  /** Cycles per loop iteration (longest comma-separated path counted in full). */
  loopCycles?: number;
}

const CYCLE_LETTER = /[A-Za-z]/;

/** Count bus cycles in an access string, ignoring `(`, `)` and `,` and anything inside parentheses. */
export function accessCycles(access: string): number {
  return parseAccess(access).cycles;
}

export function parseAccess(access: string): AccessInfo {
  let depth = 0;
  let cycles = 0;
  let loop = '';
  for (const ch of access) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth > 0) loop += ch;
    else if (CYCLE_LETTER.test(ch)) cycles++;
  }
  const info: AccessInfo = { text: access, cycles };
  if (loop) {
    info.loop = loop;
    info.loopCycles = [...loop].filter((c) => CYCLE_LETTER.test(c)).length;
  }
  return info;
}

export interface CycleContext {
  /** Indexed class of the (first / source) indexed operand. */
  idx?: IdxClass;
  /** Indexed class of the destination operand of MOVB/MOVW idx->idx (CPU12X). */
  idxDst?: IdxClass;
  /** Branch / loop primitive outcome. Default: taken. */
  taken?: boolean;
  /** Use the form's `alt` string (RTI with pending interrupt, STOP with S=1, WAI wake-up...). */
  alt?: boolean;
  /** Selects the CPU12X-specific access strings where a form has them. Default 's12x' (MC9S12XDP512). */
  cpu?: Cpu;
}

/**
 * Extra cycles for CPU12X MOVB/MOVW operands that use the extended indexed modes.
 * UNCERTAIN: derived from the page-1 HCS12 patterns (IDX1/IDX2 cost one extra program fetch,
 * indirection costs an indirect read plus a free cycle on a source and one on a destination);
 * the S12XCPU RM access detail for these combinations was not available.
 */
const MOVE_SRC_EXTRA: Record<IdxClass, number> = { IDX: 0, IDX1: 1, IDX2: 1, '[D,IDX]': 3, '[IDX2]': 3 };
const MOVE_DST_EXTRA: Record<IdxClass, number> = { IDX: 0, IDX1: 1, IDX2: 1, '[D,IDX]': 2, '[IDX2]': 2 };

/** Access-detail key for a form in a context. */
export function accessKey(form: OpForm, ctx: CycleContext = {}): AccessKey {
  const a = accessFor(form, ctx.cpu);
  if (ctx.alt && a.alt !== undefined) return 'alt';
  if (form.mode.startsWith('MOV_')) return 'base';
  if (ctx.taken === false && a.notTaken !== undefined) return 'notTaken';
  if (ctx.idx && a[ctx.idx] !== undefined) return ctx.idx;
  if (a.base !== undefined) return 'base';
  return ctx.idx ?? 'IDX';
}

/** The access string for a form in a context (for MOV forms with extended indexing: the base string). */
export function formAccess(form: OpForm, ctx: CycleContext = {}): string | undefined {
  return accessFor(form, ctx.cpu)[accessKey(form, ctx)];
}

/**
 * Cycle count of one execution of `form`. Loops (REV/REVW/WAV) count only the fixed part; use
 * `loopedCycles` (or `parseAccess(accessFor(form, cpu).alt)`) for the per-iteration cost. Uses the
 * CPU12X-specific strings when `ctx.cpu` is 's12x' (the default) and the form has them.
 */
export function formCycles(form: OpForm, ctx: CycleContext = {}): number {
  const s = formAccess(form, ctx);
  let n = s ? accessCycles(s) : 0;
  if (form.mode.startsWith('MOV_')) {
    const srcIdx = form.mode.startsWith('MOV_IDX') ? ctx.idx : undefined;
    const dstIdx = form.mode.endsWith('_IDX') ? (form.mode === 'MOV_IDX_IDX' ? ctx.idxDst : ctx.idx) : undefined;
    if (srcIdx) n += MOVE_SRC_EXTRA[srcIdx];
    if (dstIdx) n += MOVE_DST_EXTRA[dstIdx];
  }
  return n;
}

/** Branch/loop cycle pair. `notTaken` equals `taken` for forms that cost the same either way. */
export function branchCycles(form: OpForm, ctx: CycleContext = {}): { taken: number; notTaken: number } {
  return { taken: formCycles(form, { ...ctx, taken: true }), notTaken: formCycles(form, { ...ctx, taken: false }) };
}

export interface LoopOptions {
  cpu?: Cpu;
  /**
   * REVW with C=1 (weighted rules): how many of the `iterations` elements are separators ($FFFE /
   * $FFFF). Each costs the `altWeighted` loop (5 cycles, `(r,RfRf)`) instead of `alt` (3, `(t,Tx)`)
   * per the CPU12RM REVW footnote. Ignored for forms without `altWeighted`.
   */
  weightedSeparators?: number;
}

const loopLen = (s: string | undefined): number =>
  s ? (parseAccess(`(${s.replace(/[()]/g, '')})`).loopCycles ?? 0) : 0;

/** Cycles of a REV/REVW/WAV-style instruction with `iterations` loop passes. */
export function loopedCycles(form: OpForm, iterations: number, opts: LoopOptions = {}): number {
  const a = accessFor(form, opts.cpu);
  const fixed = formCycles(form, { cpu: opts.cpu });
  const per = loopLen(a.alt);
  let n = fixed + per * iterations;
  const sep = opts.weightedSeparators ?? 0;
  if (sep > 0 && a.altWeighted !== undefined) {
    if (sep > iterations) throw new RangeError('weightedSeparators exceeds iterations');
    n += (loopLen(a.altWeighted) - per) * sep;
  }
  return n;
}
