/**
 * Layout API (debugger window): hiwave `.hwl` window layouts (Window > Layout > Load/Store), parsed and written by
 * @s12/formats (parseHwl / writeHwl). Geometry is in percent of the main-frame client area.
 */

export interface HwlAttributeInfo {
  name: string;
  value: string;
}

export interface HwlWindowInfo {
  /** Component kind as written in OPEN ("source", "data"). */
  component: string;
  /** Window title used by `<Title> <` commands ("Source", "Data:1"). */
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  hasGeometry?: boolean;
  openFlags?: string;
  attributes: HwlAttributeInfo[];
}

export interface HwlLayoutInfo {
  windows: HwlWindowInfo[];
  bckcolor?: number;
  font?: { face: string; size: number; color: string };
  autosize?: boolean;
  activate: string[];
  /** Commands the layout interpreter did not understand, as raw lines (kept on write). */
  otherRaw: string[];
  warnings: string[];
  eol: '\r\n' | '\n';
}

export interface LayoutApi {
  read(path: string): Promise<HwlLayoutInfo>;
  /** Write a layout (CRLF unless layout.eol says otherwise). */
  write(path: string, layout: HwlLayoutInfo): Promise<void>;
  /** The session's layout file ([HI-WAVE] Layout=) or null. */
  sessionLayoutPath(): Promise<string | null>;
  /** Built-in default layout (ASM_layout.hwl equivalent) when the project has none. */
  defaultLayout(): Promise<HwlLayoutInfo>;
}

export type LayoutEvents = Record<string, never>;

export const LAYOUT_METHODS = ['read', 'write', 'sessionLayoutPath', 'defaultLayout'] as const;
