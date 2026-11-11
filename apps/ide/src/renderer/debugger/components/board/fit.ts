/**
 * Fit-to-window scaling of the ME3305 Board drawing: the unit is laid out at its natural size (one row: keypad |
 * LEDs/encoder/DAC | motor) and scaled with a CSS transform so the whole board (LCD, keypad, motor) is visible in
 * whatever window size the layout gives it. Below MIN_SCALE the panel scrolls instead (text would be unreadable).
 */
export const MIN_SCALE = 0.5;
export const MAX_SCALE = 1.5;

/** Scale that fits `natural` into `avail` (both px), clamped to [min, max]; 1 when a size is unknown (0). */
export function fitScale(avail: { w: number; h: number }, natural: { w: number; h: number }, min = MIN_SCALE, max = MAX_SCALE): number {
  if (!(avail.w > 0 && avail.h > 0 && natural.w > 0 && natural.h > 0)) return 1;
  const s = Math.min(avail.w / natural.w, avail.h / natural.h);
  return Math.max(min, Math.min(max, Math.floor(s * 1000) / 1000));
}
