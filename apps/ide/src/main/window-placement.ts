/**
 * hiwave `[HI-WAVE] MainFrame=` window placement (docs/research/r1/ide.md §7). Pure (no Electron) so it is testable.
 *
 * UNCERTAIN: the field order is inferred from the Win32 WINDOWPLACEMENT structure, which hiwave appears to dump
 * verbatim: `flags, showCmd, ptMinPosition.x, ptMinPosition.y, ptMaxPosition.x, ptMaxPosition.y,
 * rcNormalPosition.left, .top, .right, .bottom`. Evidence: Full_Chip_Simulation.ini has `2,3,...` (WPF_RESTORETOMAXIMIZED,
 * SW_SHOWMAXIMIZED) and CyclonePro_Serial.ini `0,1,...` (SW_SHOWNORMAL), and the last four fields always form a
 * plausible left<right, top<bottom rectangle.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MainFramePlacement {
  /** showCmd 3 (SW_SHOWMAXIMIZED). */
  maximized: boolean;
  /** showCmd 2/6/7 (minimized variants): opened normal, hiwave would restore it anyway. */
  minimized: boolean;
  /** rcNormalPosition as x/y/width/height (screen pixels). */
  normal: Rect;
}

const SW_SHOWMINIMIZED = 2;
const SW_SHOWMAXIMIZED = 3;
const SW_MINIMIZE = 6;
const SW_SHOWMINNOACTIVE = 7;

/** Parse a MainFrame value; undefined when it is not 10 integers or the normal rectangle is empty. */
export function parseMainFrame(value: string | undefined | null): MainFramePlacement | undefined {
  if (!value) return undefined;
  const f = value.split(',').map((s) => s.trim());
  if (f.length < 10 || !f.slice(0, 10).every((s) => /^-?\d+$/.test(s))) return undefined;
  const n = f.slice(0, 10).map(Number);
  const showCmd = n[1]!;
  const [l, t, r, b] = n.slice(6, 10) as [number, number, number, number];
  if (r <= l || b <= t) return undefined;
  return {
    maximized: showCmd === SW_SHOWMAXIMIZED,
    minimized: showCmd === SW_SHOWMINIMIZED || showCmd === SW_MINIMIZE || showCmd === SW_SHOWMINNOACTIVE,
    normal: { x: l, y: t, width: r - l, height: b - t },
  };
}

/** `[HI-WAVE] MainFrame=` of an .ini text (no full INI parse: only the HI-WAVE section is looked at). */
export function mainFrameFromIni(text: string): MainFramePlacement | undefined {
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[([^\]]*)\]/.exec(line);
    if (sec) {
      section = sec[1]!.trim().toUpperCase();
      continue;
    }
    if (section !== 'HI-WAVE') continue;
    const kv = /^MainFrame\s*=\s*(.*)$/i.exec(line);
    if (kv) return parseMainFrame(kv[1]);
  }
  return undefined;
}

/**
 * Fit the normal rectangle into one of the work areas (the display it overlaps most, else the first): a placement
 * saved on a lab PC's second monitor (P&E_Multilink_USB.ini: x=1284) must not open off-screen here.
 */
export function fitToWorkArea(r: Rect, workAreas: Rect[], min = { width: 480, height: 320 }): Rect {
  if (workAreas.length === 0) return r;
  const overlap = (a: Rect): number => Math.max(0, Math.min(a.x + a.width, r.x + r.width) - Math.max(a.x, r.x)) * Math.max(0, Math.min(a.y + a.height, r.y + r.height) - Math.max(a.y, r.y));
  let best = workAreas[0]!;
  for (const a of workAreas) if (overlap(a) > overlap(best)) best = a;
  const width = Math.max(Math.min(r.width, best.width), Math.min(min.width, best.width));
  const height = Math.max(Math.min(r.height, best.height), Math.min(min.height, best.height));
  const x = Math.min(Math.max(r.x, best.x), best.x + best.width - width);
  const y = Math.min(Math.max(r.y, best.y), best.y + best.height - height);
  return { x, y, width, height };
}
