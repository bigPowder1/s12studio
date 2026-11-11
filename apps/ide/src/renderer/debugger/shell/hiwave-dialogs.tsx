/**
 * hiwave dialogs added by the final fidelity pass (docs/research/r1/ide.md §6):
 *  - "Load Executable File" (File > Load Application..., <Connection> > Load...): file + Load Code / Load Symbols /
 *    Verify, "Automatically erase and program into FLASH and EEPROM", "Verify memory image after loading code",
 *    "Run after successful load", "Stop at Function"; preset from the ini's `[HI-WAVE] LoadDialogOptions=`.
 *  - "Set Connection" (Component > Set Connection...): Processor and Connection combo boxes plus an info box.
 */
import { useState } from 'react';
import { Button, Checkbox, Dialog, GroupBox, useResetOnOpen } from '../../common/controls';

// ------------------------------------------------------------------------------------------------ Load Executable

export interface LoadDialogState {
  path: string;
  /** 'all' = Load (code + symbols), 'code' = Load Code, 'symbols' = Load Symbols. */
  what: 'all' | 'code' | 'symbols';
  autoErase: boolean;
  verify: boolean;
  runAfterLoad: boolean;
  stopAtFunction: boolean;
  stopAt: string;
}

/** Preset of the Load Executable dialog from `LoadDialogOptions=` (e.g. `AUTOERASEANDFLASH NORUNAFTERLOAD`). */
export function loadDialogPreset(options: string | undefined, path = ''): LoadDialogState {
  const s: LoadDialogState = { path, what: 'all', autoErase: false, verify: false, runAfterLoad: false, stopAtFunction: false, stopAt: 'main' };
  for (const w of (options ?? '').match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    const [k = '', v] = w.split('=');
    switch (k.toUpperCase()) {
      case 'AUTOERASEANDFLASH':
        s.autoErase = true;
        break;
      case 'NORUNAFTERLOAD':
        s.runAfterLoad = false;
        break;
      case 'RUNAFTERLOAD':
        s.runAfterLoad = true;
        break;
      case 'RUNANDSTOPAFTERLOAD':
        s.runAfterLoad = true;
        s.stopAtFunction = true;
        s.stopAt = v?.replace(/^"|"$/g, '') || 'main';
        break;
      case 'CODEONLY':
        s.what = 'code';
        break;
      case 'SYMBOLSONLY':
        s.what = 'symbols';
        break;
      default:
        if (k.toUpperCase().startsWith('VERIFY')) s.verify = true;
    }
  }
  return s;
}

/** LOAD options for debug.loadApplication (session.ts parseLoadOptions understands every word). */
export function loadOptionsOf(s: LoadDialogState): string[] {
  const o: string[] = [];
  if (s.what === 'code') o.push('CODEONLY');
  if (s.what === 'symbols') o.push('SYMBOLSONLY');
  if (s.autoErase) o.push('AUTOERASEANDFLASH');
  if (s.verify) o.push('VERIFY');
  if (!s.runAfterLoad) o.push('NORUNAFTERLOAD');
  else if (s.stopAtFunction && s.stopAt.trim()) o.push(`RUNANDSTOPAFTERLOAD="${s.stopAt.trim()}"`);
  else o.push('RUNAFTERLOAD');
  return o;
}

/** `[HI-WAVE] LoadDialogOptions=` of an ini text. */
export function loadDialogOptionsFromIni(text: string): string | undefined {
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[([^\]]*)\]/.exec(line);
    if (sec) section = sec[1]!.trim().toUpperCase();
    else if (section === 'HI-WAVE') {
      const m = /^LoadDialogOptions\s*=\s*(.*)$/i.exec(line);
      if (m) return m[1];
    }
  }
  return undefined;
}

export function LoadExecutableDialog({
  open,
  initial,
  onBrowse,
  onLoad,
  onClose,
}: {
  open: boolean;
  initial: LoadDialogState;
  /** Native file picker; resolves to the chosen path or undefined. */
  onBrowse: (current: string) => Promise<string | undefined>;
  onLoad: (s: LoadDialogState) => void;
  onClose: () => void;
}) {
  const [s, setS] = useState(initial);
  useResetOnOpen(open, () => setS(initial));
  const set = (p: Partial<LoadDialogState>) => setS((x) => ({ ...x, ...p }));
  const load = (what: LoadDialogState['what']) => {
    if (!s.path.trim()) return;
    onLoad({ ...s, path: s.path.trim(), what });
    onClose();
  };
  return (
    <Dialog
      title="Load Executable File"
      open={open}
      onClose={onClose}
      width={520}
      testId="load-dialog"
      buttons={
        <>
          <Button isDefault onClick={() => load('all')} disabled={!s.path.trim()} testId="load-dialog-open">
            Open
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <label style={{ display: 'block', marginBottom: 6 }}>
        File name:
        <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
          <input className="cw-field" style={{ flex: 1 }} value={s.path} onChange={(e) => set({ path: e.target.value })} aria-label="File name" data-testid="load-dialog-path" />
          <Button onClick={() => void onBrowse(s.path).then((p) => p && set({ path: p }))} testId="load-dialog-browse">
            Browse...
          </Button>
        </div>
      </label>
      <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
        <Button onClick={() => load('code')} disabled={!s.path.trim()} testId="load-dialog-code">
          Load Code
        </Button>
        <Button onClick={() => load('symbols')} disabled={!s.path.trim()} testId="load-dialog-symbols">
          Load Symbols
        </Button>
        {/* UNCERTAIN: Verify Code compares target memory with the file; the simulator has nothing to verify against. */}
        <Button disabled>Verify Code</Button>
      </div>
      <GroupBox label="Load Options">
        <Checkbox label="Automatically erase and program into FLASH and EEPROM" checked={s.autoErase} onChange={(v) => set({ autoErase: v })} testId="load-dialog-erase" />
        <Checkbox label="Verify memory image after loading code" checked={s.verify} onChange={(v) => set({ verify: v })} />
      </GroupBox>
      <GroupBox label="Run Options" style={{ marginTop: 6 }}>
        <Checkbox label="Run after successful load" checked={s.runAfterLoad} onChange={(v) => set({ runAfterLoad: v })} testId="load-dialog-run" />
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Checkbox label="Stop at Function:" checked={s.stopAtFunction} disabled={!s.runAfterLoad} onChange={(v) => set({ stopAtFunction: v })} />
          <input className="cw-field" style={{ width: 160 }} value={s.stopAt} disabled={!s.runAfterLoad || !s.stopAtFunction} onChange={(e) => set({ stopAt: e.target.value })} aria-label="Stop at function" />
        </div>
      </GroupBox>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ Set Connection

export interface ConnectionChoice {
  /** Display name ("Full Chip Simulation"). */
  name: string;
  /** Available in this build (real hardware connections arrive with M8). */
  supported: boolean;
  info: string;
}

/** hiwave's HC12 connection list (ide.md §2 "Connections"); only the simulator is implemented. */
export const HC12_CONNECTIONS: readonly ConnectionChoice[] = [
  { name: 'Full Chip Simulation', supported: true, info: 'Simulates the MC9S12XDP512 and its peripherals (CPU, timers, SPI, SCI, ATD...) with the ME3305 board.' },
  { name: 'P&E Multilink/Cyclone Pro', supported: false, info: 'BDM connection to real hardware: not supported yet (planned, M8).' },
  { name: 'HCS12 Serial Monitor', supported: false, info: 'Serial monitor connection to real hardware: not supported yet.' },
  { name: 'SofTec HCS12', supported: false, info: 'Not supported.' },
  { name: 'Abatron BDI', supported: false, info: 'Not supported.' },
];

export function SetConnectionDialog({ open, current, onOk, onClose }: { open: boolean; current: string; onOk: (connection: string) => void; onClose: () => void }) {
  const [conn, setConn] = useState(current);
  useResetOnOpen(open, () => setConn(HC12_CONNECTIONS.some((c) => c.name === current) ? current : HC12_CONNECTIONS[0]!.name));
  const choice = HC12_CONNECTIONS.find((c) => c.name === conn);
  return (
    <Dialog
      title="Set Connection"
      open={open}
      onClose={onClose}
      width={420}
      testId="set-connection-dialog"
      buttons={
        <>
          <Button
            isDefault
            disabled={!choice?.supported}
            testId="set-connection-ok"
            onClick={() => {
              onOk(conn);
              onClose();
            }}
          >
            OK
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 6, alignItems: 'center' }}>
        <span>Processor:</span>
        <select className="cw-field" value="HC12" onChange={() => undefined} aria-label="Processor">
          <option>HC12</option>
        </select>
        <span>Connection:</span>
        <select className="cw-field" value={conn} onChange={(e) => setConn(e.target.value)} aria-label="Connection" data-testid="set-connection-select">
          {HC12_CONNECTIONS.map((c) => (
            <option key={c.name} value={c.name} disabled={!c.supported}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="cw-sunken" style={{ marginTop: 8, padding: 6, minHeight: 48, background: 'var(--cw-window)' }} data-testid="set-connection-info">
        {choice?.info}
      </div>
    </Dialog>
  );
}
