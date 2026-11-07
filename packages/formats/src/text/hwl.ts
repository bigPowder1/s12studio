// hiwave window layout (.hwl) interpreter and writer. A .hwl is a command script:
//   OPEN <component> x y w h      (percent of the main-frame client area)
//   <Title> < attributes K V,K V,...
//   bckcolor <COLORREF> / font '<face>' <pt> <COLOR> / AUTOSIZE on|off / ACTIVATE "<title>" ...
// Spec: docs/research/r2/mcp-format.md §3.3, docs/research/r1/ide.md §6.
import { parseAttributeList, parseHiwaveScript, type HiwaveCommand, type HiwaveToken } from './hiwave-cmd';

export interface HwlAttribute {
  name: string;
  value: string;
}

export interface HwlWindow {
  /** component kind as written in OPEN, e.g. "source", "data" */
  component: string;
  /** window title used by `<Title> <` commands: "Source", or "Data:1"/"Data:2" when several of a kind exist */
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * false when the OPEN had no geometry (`OPEN source`): x/y/w/h are then 0 placeholders and writeHwl omits them.
   * Absent/true means the geometry is real. UNCERTAIN: the debugger's default placement for such windows.
   */
  hasGeometry?: boolean;
  /** extra OPEN arguments after the geometry (e.g. ";I" iconic, ";MAX"), raw text */
  openFlags?: string;
  attributes: HwlAttribute[];
}

export interface HwlLayout {
  windows: HwlWindow[];
  /** Win32 COLORREF (e.g. 50331647 = 0x02FFFFFF, PALETTERGB white) */
  bckcolor?: number;
  font?: { face: string; size: number; color: string };
  autosize?: boolean;
  /** activation / z-order sequence of window titles */
  activate: string[];
  /** commands not understood by the layout interpreter, preserved */
  other: HiwaveCommand[];
  warnings: string[];
  eol: '\r\n' | '\n';
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);

const tokText = (t: HiwaveToken | undefined) => (t ? (t.type === 'string' ? t.value : t.text) : '');

export function parseHwl(text: string): HwlLayout {
  const script = parseHiwaveScript(text);
  const layout: HwlLayout = { windows: [], activate: [], other: [], warnings: [], eol: script.eol };
  for (const e of script.errors) layout.warnings.push(`line ${e.line}: ${e.message}`);
  const pending: { cmd: HiwaveCommand; target: string }[] = [];

  for (const cmd of script.commands) {
    const a = cmd.args;
    if (cmd.target) {
      if (cmd.keyword === 'ATTRIBUTES') pending.push({ cmd, target: cmd.target });
      else layout.other.push(cmd);
      continue;
    }
    switch (cmd.keyword) {
      case 'OPEN': {
        const comp = a[0];
        const nums = a.slice(1, 5);
        if (!comp || comp.type !== 'ident' || nums.length < 4 || nums.some((n) => n.type !== 'number')) {
          // OPEN without geometry is legal (debugger chooses a position); UNCERTAIN default geometry
          if (comp && comp.type === 'ident' && a.length === 1) {
            layout.windows.push({ component: comp.text, title: '', x: 0, y: 0, w: 0, h: 0, hasGeometry: false, attributes: [] });
          } else layout.warnings.push(`line ${cmd.line}: malformed OPEN`);
          break;
        }
        const [x, y, w, h] = nums.map((n) => (n as { value: number }).value);
        const restTok = a.slice(5);
        layout.windows.push({
          component: comp.text,
          title: '',
          x, y, w, h,
          openFlags: restTok.length ? restTok.map((t) => t.text).join('') : undefined,
          attributes: [],
        });
        break;
      }
      case 'BCKCOLOR':
        if (a[0]?.type === 'number') layout.bckcolor = a[0].value;
        else layout.warnings.push(`line ${cmd.line}: bckcolor expects a number`);
        break;
      case 'FONT':
        if (a.length >= 2 && a[1].type === 'number') layout.font = { face: tokText(a[0]), size: a[1].value, color: tokText(a[2]) };
        else layout.warnings.push(`line ${cmd.line}: malformed font`);
        break;
      case 'AUTOSIZE':
        layout.autosize = tokText(a[0]).toLowerCase() !== 'off';
        break;
      case 'ACTIVATE':
        layout.activate = a.map(tokText);
        break;
      default:
        layout.other.push(cmd);
    }
  }

  // titles: "Source", or "Data:1", "Data:2" when a component is opened more than once (UNCERTAIN numbering rule)
  const counts = new Map<string, number>();
  for (const w of layout.windows) counts.set(w.component.toLowerCase(), (counts.get(w.component.toLowerCase()) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const w of layout.windows) {
    const k = w.component.toLowerCase();
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    w.title = counts.get(k)! > 1 ? `${cap(w.component)}:${n}` : cap(w.component);
  }

  for (const { cmd, target } of pending) {
    const t = target.toLowerCase();
    const win = layout.windows.find((w) => w.title.toLowerCase() === t) ?? layout.windows.find((w) => w.title.toLowerCase() === `${t}:1`);
    if (!win) {
      layout.warnings.push(`line ${cmd.line}: attributes for unknown window "${target}"`);
      layout.other.push(cmd);
      continue;
    }
    for (const at of parseAttributeList(cmd.args, cmd.argText)) win.attributes.push({ name: at.name, value: at.value });
  }
  return layout;
}

/** Serialize a layout in CodeWarrior's order: OPEN+attributes per window, then bckcolor, font, AUTOSIZE, ACTIVATE. */
export function writeHwl(layout: Omit<HwlLayout, 'warnings' | 'other'> & { other?: HiwaveCommand[] }, eol: '\r\n' | '\n' = layout.eol ?? '\r\n'): string {
  const out: string[] = [];
  for (const w of layout.windows) {
    const geom = w.hasGeometry === false ? '' : ` ${w.x} ${w.y} ${w.w} ${w.h}`;
    out.push(`OPEN ${w.component}${geom}${w.openFlags ? ' ' + w.openFlags : ''}`);
    if (w.attributes.length) out.push(`${w.title} < attributes ${w.attributes.map((a) => (a.value ? `${a.name} ${a.value}` : a.name)).join(',')}`);
  }
  for (const c of layout.other ?? []) out.push(c.raw);
  if (layout.bckcolor !== undefined) out.push(`bckcolor ${layout.bckcolor}`);
  if (layout.font) out.push(`font '${layout.font.face}' ${layout.font.size} ${layout.font.color}`);
  if (layout.autosize !== undefined) out.push(`AUTOSIZE ${layout.autosize ? 'on' : 'off'}`);
  if (layout.activate.length) out.push(`ACTIVATE ${layout.activate.map((t) => `"${t}"`).join(' ')}`);
  return out.map((l) => l + eol).join('');
}
