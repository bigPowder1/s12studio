/**
 * Debugger-window services for components beyond contract.ts (owned by the debugger shell):
 *   - useDebuggerBus().send(cmd)        deliver a `Comp < cmd` UI command to other open components (no IPC round trip),
 *                                       e.g. Procedure "show location" -> `Source < SPC 0xC003` + `Assembly < SPC ...`
 *   - useDebuggerBus().setAttributes()  report this window's current attributes (written back by Save Configuration)
 *   - useBreakpoints()                  breakpoint list (initial pull + `debug.breakpoints` events)
 *   - toggleBreakpointAt()              hiwave Set/Delete Breakpoint on an address
 * Outside the shell (component tests) the bus is a no-op.
 */
import { createContext, useContext, useEffect, useState } from 'react';
import type { BreakpointInfo, HwlAttributeInfo, S12Api, UiCommandInfo } from '../../../shared/api';
import { useS12, useS12Event, useSession } from '../../common/s12';
import { addr, parseNumber } from '../../common/format';

export interface DebuggerBus {
  send(cmd: UiCommandInfo): void;
  setAttributes(attributes: HwlAttributeInfo[]): void;
  /** Status-bar message ("For Help, press F1" pane). */
  status(text: string): void;
}

const noop: DebuggerBus = { send: () => undefined, setAttributes: () => undefined, status: () => undefined };

export const DebuggerBusContext = createContext<DebuggerBus>(noop);

export function useDebuggerBus(): DebuggerBus {
  return useContext(DebuggerBusContext);
}

/** Build a UI command as the interpreter would emit it. */
export function uiCommand(component: string, keyword: string, argText = ''): UiCommandInfo {
  return { component, keyword, argText, raw: `${component} < ${keyword}${argText ? ' ' + argText : ''}` };
}

/** "Show Location": scroll Source and Assembly to an address (hiwave SPC). */
export function showLocation(bus: DebuggerBus, address: number, targets: readonly string[] = ['Source', 'Assembly']): void {
  for (const t of targets) bus.send(uiCommand(t, 'SPC', addr(address)));
}

/** Current breakpoints (refreshed on every `debug.breakpoints` event and after a session/application change). */
export function useBreakpoints(): BreakpointInfo[] {
  const s12 = useS12();
  const session = useSession();
  const [bps, setBps] = useState<BreakpointInfo[]>([]);
  const [gen, setGen] = useState(0);
  useS12Event('debug', 'breakpoints', setBps);
  useS12Event('debug', 'loaded', () => setGen((g) => g + 1));
  useEffect(() => {
    if (!session) {
      setBps([]);
      return;
    }
    let live = true;
    void s12.debug.breakpoints().then((b) => live && Array.isArray(b) && setBps(b), () => undefined);
    return () => {
      live = false;
    };
  }, [s12, session, gen]);
  return bps;
}

/** Set Breakpoint / Delete Breakpoint on an address (hiwave's toggle on margin click). */
export async function toggleBreakpointAt(s12: S12Api, bps: readonly BreakpointInfo[], address: number): Promise<void> {
  const hit = bps.find((b) => b.address === address);
  if (hit) await s12.debug.removeBreakpoint(hit.id);
  else await s12.debug.setBreakpoint({ address });
}

/** Breakpoint items of the Source/Assembly pop-up menus for an address. */
export function breakpointMenuState(bps: readonly BreakpointInfo[], address: number | undefined): { bp?: BreakpointInfo; canSet: boolean } {
  if (address === undefined) return { canSet: false };
  const bp = bps.find((b) => b.address === address);
  return { bp, canSet: !bp };
}

/**
 * A number as the command language writes it (docs/research/r1/ide.md "Command language": `$FF`, `0xFF`, `0377`
 * octal, `%1010` binary, `255` decimal; same rules as @s12/debug expr.ts). Null when the text is not a plain number.
 */
export function parseCommandNumber(text: string): number | null {
  const t = text.trim();
  let m: RegExpExecArray | null;
  if ((m = /^\$([0-9a-f]+)$/i.exec(t)) || (m = /^0x([0-9a-f]+)$/i.exec(t))) return parseInt(m[1], 16);
  if ((m = /^%([01]+)$/.exec(t))) return parseInt(m[1], 2);
  if (/^0[0-7]+$/.test(t)) return parseInt(t, 8);
  if (/^(0|[1-9][0-9]*)$/.test(t)) return parseInt(t, 10);
  return null;
}

/**
 * Address of a `Comp < SPC expr` argument: a plain number by the command-language rules (no IPC), anything else
 * (symbols, `main+3`) through the engine's expression evaluator. Null when it cannot be resolved.
 */
export async function resolveCommandAddress(s12: S12Api, text: string): Promise<number | null> {
  const n = parseCommandNumber(text);
  if (n !== null) return n;
  const r = await s12.debug.resolve(text.trim());
  return typeof r === 'number' ? r : null;
}

/**
 * Address typed in an "Address..." dialog (hex number or symbol). A bare identifier is tried as a symbol first, so
 * labels such as `ADD`, `CAFE` or `DEAD` are not taken for hex numbers; when no such symbol exists it is read as hex.
 * Text starting with a digit or a prefix ($, 0x, %, @) is a hex-default number; other text is an expression.
 */
export async function resolveDialogAddress(s12: S12Api, text: string): Promise<number | null> {
  const t = text.trim();
  if (!t) return null;
  if (/^[A-Za-z_][\w.]*$/.test(t)) {
    const r = await s12.debug.resolve(t).catch(() => null);
    if (typeof r === 'number') return r;
    return parseNumber(t, 16);
  }
  if (/^[0-9a-f]+$/i.test(t)) return parseInt(t, 16); // "0B10" is hex here, not binary
  const n = parseNumber(t, 16);
  if (n !== null) return n;
  const r = await s12.debug.resolve(t).catch(() => null);
  return typeof r === 'number' ? r : null;
}
