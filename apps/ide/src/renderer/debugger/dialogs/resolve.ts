/**
 * Address / value fields of the debugger dialogs accept numbers ($FF, 0xFF, FFh, %1010, @17, decimal) and, through
 * the engine's expression evaluator (`debug.resolve`), symbols and expressions ("COUNT_A", "main+4", "PC").
 */
import type { S12Api } from '../../../shared/api';
import { parseNumber } from '../../common/format';

/** Address of `text`: a number in `radix` (bare digits) or a symbol/expression resolved by the engine. */
export async function resolveAddress(s12: S12Api, text: string, radix: 10 | 16 = 16): Promise<number | null> {
  const t = text.trim();
  if (!t) return null;
  const n = parseNumber(t, radix);
  if (n !== null) return n >= 0 ? n : null;
  try {
    const v = await s12.debug.resolve(t);
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}

/** "0x1000" or the hex address hiwave shows in dialogs. */
export const hexText = (v: number): string => '0x' + v.toString(16).toUpperCase();
