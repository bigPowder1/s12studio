/**
 * hiwave "Terminal" component (docs/research/r1/ide.md §6 Terminal): an xterm.js terminal on the simulated SCI.
 * Bytes the MCU transmits (`debug.sciOutput` for the chosen channel) are written to the terminal; keystrokes go to the
 * SCI receiver through `debug.sciSend(channel, data)`. Menu: Clear, Configure Connections... (SCI channel, local echo,
 * LF -> CR/LF, what Enter sends), Copy, Paste.
 *
 * UNCERTAIN: hiwave's default virtual SCI is `Sci0`; the Configure Connections dialog here only offers the six
 * on-chip SCIs of the MC9S12XDP512 (no serial port / file redirection).
 */
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseApiError } from '../../../../shared/api';
import { Button, Dialog, GroupBox, useResetOnOpen } from '../../../common/controls';
import { DialogLayer } from '../../dialogs/DialogLayer';
import { ContextMenu, type ContextMenuState } from '../../../common/menu/MenuBar';
import { SEP, type MenuEntry } from '../../../common/menu/model';
import { useS12 } from '../../../common/s12';
import { useComponentHost, useComponentMenu, type DebuggerComponentProps } from '../contract';
import { sciBufferFor } from './sciBuffer';

export type EnterKey = 'cr' | 'lf' | 'crlf';

export interface TerminalSettings {
  channel: number;
  localEcho: boolean;
  /** Show a received LF as CR+LF. */
  convertEol: boolean;
  enter: EnterKey;
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = { channel: 0, localEcho: false, convertEol: true, enter: 'cr' };
const STORAGE_KEY = 's12.terminal.settings';
export const SCI_CHANNELS = [0, 1, 2, 3, 4, 5];

function loadSettings(): TerminalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_TERMINAL_SETTINGS, ...(JSON.parse(raw) as Partial<TerminalSettings>) };
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_TERMINAL_SETTINGS;
}

function saveSettings(s: TerminalSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

/** Bytes to send for typed terminal data (xterm sends "\r" for Enter). */
export function encodeInput(data: string, enter: EnterKey): number[] {
  const out: number[] = [];
  for (const ch of data) {
    if (ch === '\r') {
      if (enter === 'cr' || enter === 'crlf') out.push(0x0d);
      if (enter === 'lf' || enter === 'crlf') out.push(0x0a);
    } else {
      const c = ch.codePointAt(0)!;
      out.push(c <= 0xff ? c : 0x3f);
    }
  }
  return out;
}

export function TerminalComponent(_props: DebuggerComponentProps) {
  const s12 = useS12();
  const host = useComponentHost();
  const sci = sciBufferFor(s12);
  const [settings, setSettings] = useState<TerminalSettings>(loadSettings);
  const [configOpen, setConfigOpen] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // create the terminal once
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const term = new Terminal({
      convertEol: settingsRef.current.convertEol,
      fontFamily: "'Courier New', Courier, 'Liberation Mono', monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#ffffff', foreground: '#000000', cursor: '#000000', selectionBackground: '#0a246a80' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    const doFit = () => {
      try {
        fit.fit();
      } catch {
        /* not laid out yet */
      }
    };
    doFit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(doFit) : null;
    ro?.observe(el);
    const sub = term.onData((data) => {
      const s = settingsRef.current;
      const bytes = encodeInput(data, s.enter);
      if (s.localEcho) term.write(Uint8Array.from(bytes));
      void s12.debug.sciSend(s.channel, bytes).catch((e) => setError(parseApiError(e).message));
    });
    return () => {
      sub.dispose();
      ro?.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, [s12]);

  // (re)attach to the selected channel: replay its history, then stream
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.convertEol = settings.convertEol;
    term.reset();
    const h = sci.history(settings.channel);
    if (h.length) term.write(h);
    return sci.subscribe((ch, data) => {
      if (ch === settings.channel) term.write(data);
    });
  }, [sci, settings.channel, settings.convertEol]);

  useEffect(() => {
    host.setHeadline(error ?? `SCI${settings.channel}${settings.localEcho ? '  echo' : ''}`);
  }, [host, settings.channel, settings.localEcho, error]);

  const clear = useCallback(() => {
    sci.clear(settingsRef.current.channel);
    termRef.current?.reset();
  }, [sci]);
  const copy = useCallback(() => {
    const t = termRef.current?.getSelection() ?? '';
    if (t) void navigator.clipboard?.writeText(t).catch(() => undefined);
  }, []);
  const paste = useCallback(async () => {
    try {
      const t = await navigator.clipboard.readText();
      termRef.current?.paste(t);
    } catch {
      termRef.current?.focus();
    }
  }, []);

  const items = useMemo<MenuEntry[]>(
    () => [
      { id: 'terminal.clear', label: 'C&lear', onSelect: clear },
      { id: 'terminal.configure', label: 'Configure &Connections...', onSelect: () => setConfigOpen(true) },
      SEP,
      { id: 'terminal.copy', label: '&Copy', onSelect: copy },
      { id: 'terminal.paste', label: '&Paste', onSelect: () => void paste() },
    ],
    [clear, copy, paste],
  );
  useComponentMenu(items);

  return (
    <div
      style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#fff' }}
      data-testid="terminal-component"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, items });
      }}
    >
      <div ref={boxRef} style={{ flex: 1, minHeight: 0, padding: 2 }} data-testid="terminal-xterm" />
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
      <DialogLayer>
        <TerminalConfigDialog
          open={configOpen}
          settings={settings}
          onClose={() => setConfigOpen(false)}
          onOk={(s) => {
            setSettings(s);
            saveSettings(s);
            setError(null);
          }}
        />
      </DialogLayer>
    </div>
  );
}

export function TerminalConfigDialog({ open, settings, onOk, onClose }: { open: boolean; settings: TerminalSettings; onOk: (s: TerminalSettings) => void; onClose: () => void }) {
  const [d, setD] = useState(settings);
  useResetOnOpen(open, () => setD(settings));
  return (
    <Dialog
      open={open}
      title="Configure Connections"
      onClose={onClose}
      width={320}
      testId="terminal-config"
      buttons={
        <>
          <Button isDefault onClick={() => (onOk(d), onClose())} testId="terminal-config-ok">
            OK
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <GroupBox label="Virtual SCI">
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span>SCI channel</span>
          <select aria-label="SCI channel" className="cw-field" value={d.channel} onChange={(e) => setD({ ...d, channel: Number(e.target.value) })}>
            {SCI_CHANNELS.map((c) => (
              <option key={c} value={c}>
                Sci{c}
              </option>
            ))}
          </select>
        </label>
      </GroupBox>
      <GroupBox label="Options">
        <label style={{ display: 'block' }}>
          <input type="checkbox" checked={d.localEcho} onChange={(e) => setD({ ...d, localEcho: e.target.checked })} /> Local echo
        </label>
        <label style={{ display: 'block' }}>
          <input type="checkbox" checked={d.convertEol} onChange={(e) => setD({ ...d, convertEol: e.target.checked })} /> Show received LF as CR/LF
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
          <span>Enter sends</span>
          <select aria-label="Enter sends" className="cw-field" value={d.enter} onChange={(e) => setD({ ...d, enter: e.target.value as EnterKey })}>
            <option value="cr">CR</option>
            <option value="lf">LF</option>
            <option value="crlf">CR/LF</option>
          </select>
        </label>
      </GroupBox>
    </Dialog>
  );
}
