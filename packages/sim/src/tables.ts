/**
 * Precomputed per-opcode tables for the CPU core, derived once at module load from the @s12/isa
 * opcode table (CPU12X access-detail strings). The core never parses access strings or calls the
 * disassembler while executing.
 *
 * Key layout: `key = page << 8 | opcode` (page 0 = page 1, page 1 = `$18` page 2), 512 keys.
 * Indexed tables are `key * 5 + cls` where cls follows `IDX_CLASSES` (IDX, IDX1, IDX2, [D,IDX], [IDX2]).
 */
import {
  IDX_CLASSES,
  accessCycles,
  accessFor,
  formAccess,
  formCycles,
  formsAt,
  formsByMnemonic,
  parseAccess,
  type IdxClass,
  type OpForm,
} from '@s12/isa';

const CPU = 's12x' as const;

/** Base (taken) cycles of every non-indexed form. */
export const CYC = new Uint8Array(512);
/** Not-taken cycles (conditional branches, loop primitives); equals CYC otherwise. */
export const CYCN = new Uint8Array(512);
/** Cycles of indexed forms by postbyte class: [key * 5 + cls]. */
export const CYCI = new Uint8Array(512 * 5);
/** MOVB/MOVW (page 2 $00-$0D) cycles: [op * 25 + srcCls * 5 + dstCls]; single-indexed forms use [op*25 + cls*5]. */
export const CYCM = new Uint8Array(16 * 25);
/**
 * Bus-cycle offset (0-based, inside the instruction) of the first data read / write in the access string:
 * [key * 5 + cls] (0 when the form has none). Used only to time register (peripheral) accesses exactly.
 */
export const RDOFF = new Uint8Array(512 * 5);
export const WROFF = new Uint8Array(512 * 5);
/** Page-2 opcodes that are unimplemented-opcode TRAPs on the CPU12X. */
export const TRAP2 = new Uint8Array(256);

const IDX_MODES = new Set(['IDX', 'BIT_IDX', 'BRBIT_IDX', 'CALL_IDX']);

function letters(s: string): string {
  return s.replace(/\([^)]*\)/g, '').replace(/[^A-Za-z]/g, '');
}

function offsets(s: string | undefined): [number, number] {
  if (!s) return [-1, -1];
  const l = letters(s);
  let r = -1;
  let w = -1;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (r < 0 && (c === 'r' || c === 'R')) r = i;
    if (w < 0 && (c === 'w' || c === 'W')) w = i;
  }
  return [r, w];
}

function clsCycles(form: OpForm, cls: IdxClass): number {
  const a = accessFor(form, CPU);
  // UNCERTAIN: an indexed variant the form does not accept (e.g. BSET [D,X]) has no access string;
  // charge the closest defined variant ([IDX2] -> IDX2 -> IDX) so execution can still proceed.
  const order: IdxClass[] = [cls, cls === '[D,IDX]' ? '[IDX2]' : 'IDX2', 'IDX2', 'IDX1', 'IDX'];
  for (const c of order) if (a[c]) return formCycles(form, { cpu: CPU, idx: c, taken: true });
  return formCycles(form, { cpu: CPU, taken: true });
}

function build(): void {
  for (let page = 0; page < 2; page++) {
    const prefix = page === 0 ? 0 : 0x18;
    for (let op = 0; op < 256; op++) {
      const forms = formsAt(CPU, prefix, op);
      if (!forms.length) continue;
      const form = forms[0];
      const key = (page << 8) | op;
      if (page === 1 && form.mode === 'TRAP') TRAP2[op] = 1;
      CYC[key] = formCycles(form, { cpu: CPU, taken: true });
      CYCN[key] = formCycles(form, { cpu: CPU, taken: false });
      for (let c = 0; c < 5; c++) {
        const cls = IDX_CLASSES[c];
        const isIdx = IDX_MODES.has(form.mode);
        if (isIdx) CYCI[key * 5 + c] = clsCycles(form, cls);
        const acc = isIdx ? formAccess(form, { cpu: CPU, idx: cls }) : formAccess(form, { cpu: CPU });
        const [r, w] = offsets(acc ?? accessFor(form, CPU).base);
        RDOFF[key * 5 + c] = Math.max(r, 0);
        WROFF[key * 5 + c] = Math.max(w, 0);
      }
      if (page === 1 && form.mode.startsWith('MOV_')) {
        for (let s = 0; s < 5; s++) {
          for (let d = 0; d < 5; d++) {
            const ctx =
              form.mode === 'MOV_IDX_IDX'
                ? { cpu: CPU, idx: IDX_CLASSES[s], idxDst: IDX_CLASSES[d] }
                : { cpu: CPU, idx: IDX_CLASSES[s] };
            CYCM[op * 25 + s * 5 + d] = formCycles(form, ctx);
          }
        }
      }
    }
  }
}
build();

function one(m: string, mode?: string): OpForm {
  const f = formsByMnemonic(m, CPU).find((x) => !mode || x.mode === mode);
  if (!f) throw new Error(`isa table has no ${m}`);
  return f;
}
const altCycles = (f: OpForm): number => accessCycles(accessFor(f, CPU).alt ?? '');
/** Cycles of the parenthesised loop of an access string (the whole string when it has no parentheses). */
const loopPer = (s: string | undefined): number => (s ? (parseAccess(s.includes('(') ? s : `(${s})`).loopCycles ?? 0) : 0);

const SWI = one('SWI');
const RTI = one('RTI');
const WAI = one('WAI');
const STOP = one('STOP');
const REV = one('REV');
const REVW = one('REVW');
const WAV = one('WAV');
const WAVR = one('WAVR');

/** Hardware interrupt entry: same microcode as SWI (CPU12X `VSPSSPSSP`). UNCERTAIN (CPU12X string derived). */
export const CYC_IRQ_ENTRY = accessCycles(accessFor(SWI, CPU).base ?? '');
/** RTI when another interrupt is pending (re-vector without re-stacking). */
export const CYC_RTI_PENDING = altCycles(RTI);
/** WAI / STOP exit on an interrupt (`fVfPPP`): vector fetch + refill, no stacking. */
export const CYC_WAKE = altCycles(WAI);
/** STOP with S=1: 2-cycle NOP. */
export const CYC_STOP_DISABLED = altCycles(STOP);
/** Reset sequence `VfPPP` (vector fetch + queue fill). UNCERTAIN whether hiwave counts it. */
export const CYC_RESET = 5;

/** REV/REVW/WAV fixed parts and per-iteration loop costs (CPU12RM access detail). */
export const CYC_REV_FIXED = formCycles(REV, { cpu: CPU });
export const CYC_REV_PER = loopPer(accessFor(REV, CPU).alt);
export const CYC_REVW_FIXED = formCycles(REVW, { cpu: CPU });
export const CYC_REVW_PER = loopPer(accessFor(REVW, CPU).alt);
export const CYC_REVW_PER_WEIGHTED = loopPer(accessFor(REVW, CPU).altWeighted);
export const CYC_WAV_FIXED = formCycles(WAV, { cpu: CPU });
export const CYC_WAV_PER = loopPer(accessFor(WAV, CPU).alt);
/**
 * UNCERTAIN: WAVR = re-entry pulls + operand re-reads (`UUUrr`) + the rest of the interrupted iteration and
 * the exit (`ffff` ... `O`, i.e. the alt string outside its loop); each remaining iteration adds the loop.
 */
export const CYC_WAVR_FIXED =
  accessCycles(accessFor(WAVR, CPU).base ?? '') + accessCycles((accessFor(WAVR, CPU).alt ?? '').replace(/\([^)]*\)/g, ''));
export const CYC_WAVR_PER = loopPer(accessFor(WAVR, CPU).alt);
