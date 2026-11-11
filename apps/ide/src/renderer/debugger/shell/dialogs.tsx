/**
 * Debugger dialogs: Component > Open ("Open Window Component"), Fonts, Background Color, About. The generic one-field
 * PromptDialog lives in PromptDialog.tsx (components import it without pulling in the registry).
 */
import { useEffect, useState } from 'react';
import { Button, Dialog, useResetOnOpen } from '../../common/controls';
import { COMPONENTS, type ComponentEntry } from '../components/registry';
import type { HiwaveComponentName } from '../components/contract';
import { THEME } from '../../../shared/theme/tokens';
import { ToolbarIcons } from './toolbar-icons';

export { PromptDialog, type PromptDialogProps } from './PromptDialog';

// ------------------------------------------------------------------------------------------------ Component > Open

/**
 * hiwave components that S12 Studio does not implement (ide.md §6 "Other components in Component > Open"). Listed
 * greyed out so the dialog looks like hiwave's; they cannot be opened.
 */
export const UNIMPLEMENTED_COMPONENTS: readonly { name: string; description: string }[] = [
  { name: 'Coverage', description: 'Code coverage' },
  { name: 'Inspector', description: 'Simulator object inspector' },
  { name: 'Module', description: 'Modules of the application' },
  { name: 'Profiler', description: 'Profiling' },
  { name: 'Recorder', description: 'Command recorder' },
  { name: 'SoftTrace', description: 'Software trace' },
  { name: 'Stimulation', description: 'Stimulation files' },
  { name: 'TestTerm', description: 'Test terminal' },
  { name: 'IO_Led', description: 'I/O LEDs' },
  { name: 'Led', description: 'LEDs' },
  { name: 'Phone', description: 'Phone simulation' },
  { name: 'Push Buttons', description: 'Push buttons' },
  { name: 'Programmable IO_Ports', description: 'Programmable I/O ports' },
  { name: '7-Segments Display', description: '7-segment display' },
  { name: 'Wagon', description: 'Wagon simulation' },
  { name: 'Analog Meter', description: 'Analog meter' },
  { name: 'ADC/DAC', description: 'ADC/DAC simulation' },
  { name: 'IT_Keyboard', description: 'Interrupt keyboard' },
  { name: 'LCD', description: 'LCD display' },
  { name: 'Signal IO', description: 'Signal I/O / pin connections' },
];

type OpenView = 'icon' | 'list' | 'details';

export function ComponentOpenDialog({ open, onClose, onOpen }: { open: boolean; onClose: () => void; onOpen: (names: HiwaveComponentName[]) => void }) {
  const [sel, setSel] = useState<HiwaveComponentName[]>([]);
  // UNCERTAIN: which tab hiwave shows first; Icon is the first tab in ide.md's description.
  const [view, setView] = useState<OpenView>('icon');
  useEffect(() => {
    if (open) setSel([]);
  }, [open]);
  const all = [...COMPONENTS.map((c) => ({ ...c, implemented: true as const })), ...UNIMPLEMENTED_COMPONENTS.map((c) => ({ ...c, implemented: false as const }))].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  const click = (e: React.MouseEvent, c: ComponentEntry) => {
    if (e.ctrlKey || e.metaKey) setSel((s) => (s.includes(c.name) ? s.filter((x) => x !== c.name) : [...s, c.name]));
    else if (e.shiftKey && sel.length) {
      const names = all.filter((x) => x.implemented).map((x) => x.name as HiwaveComponentName);
      const a = names.indexOf(sel[sel.length - 1]);
      const b = names.indexOf(c.name);
      setSel(names.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else setSel([c.name]);
  };
  const ok = () => {
    if (sel.length) onOpen(sel);
    onClose();
  };
  const tab = (id: OpenView, label: string) => (
    <div role="tab" aria-selected={view === id} className={`cw-tab${view === id ? ' selected' : ''}`} onMouseDown={() => setView(id)} data-testid={`component-open-tab-${id}`}>
      {label}
    </div>
  );
  return (
    <Dialog
      title="Open Window Component"
      open={open}
      onClose={onClose}
      width={view === 'details' ? 520 : 460}
      testId="component-open-dialog"
      buttons={
        <>
          <Button isDefault onClick={ok} disabled={!sel.length} testId="component-open-ok">
            OK
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div className="cw-tabs">
        <div className="cw-tab-strip" role="tablist">
          {tab('icon', 'Icon')}
          {tab('list', 'List')}
          {tab('details', 'Details')}
        </div>
        <div
          className="cw-listview cw-sunken"
          style={{ height: 240, overflow: 'auto', background: 'var(--cw-window)', display: view === 'icon' ? 'flex' : 'block', flexWrap: 'wrap', alignContent: 'flex-start', gap: view === 'icon' ? 4 : 0, padding: view === 'icon' ? 4 : 0 }}
          role="listbox"
          aria-multiselectable="true"
          aria-label="Components"
          data-view={view}
        >
          {view === 'details' && (
            <div style={{ display: 'flex', gap: 6, padding: '1px 4px', borderBottom: '1px solid var(--cw-face-shadow)', background: 'var(--cw-face)' }}>
              <span style={{ width: 22 }} />
              <span style={{ width: 150 }}>Name</span>
              <span>Description</span>
            </div>
          )}
          {all.map((c) => {
            const on = c.implemented && sel.includes(c.name as HiwaveComponentName);
            const style: React.CSSProperties = {
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              padding: '1px 4px',
              background: on ? 'var(--cw-highlight)' : undefined,
              color: on ? 'var(--cw-highlight-text)' : c.implemented ? undefined : 'var(--cw-gray-text)',
              cursor: 'default',
              ...(view === 'icon' ? { flexDirection: 'column', width: 84, textAlign: 'center', padding: 4 } : {}),
            };
            return (
              <div
                key={c.name}
                role="option"
                aria-selected={on}
                aria-disabled={!c.implemented}
                className="cw-row"
                data-testid={c.implemented ? `component-option-${c.name}` : undefined}
                title={c.implemented ? c.description : `${c.description} (not available in S12 Studio)`}
                style={style}
                onMouseDown={(e) => c.implemented && click(e, c as ComponentEntry)}
                onDoubleClick={() => {
                  if (!c.implemented) return;
                  onOpen([c.name as HiwaveComponentName]);
                  onClose();
                }}
              >
                <span style={{ opacity: c.implemented ? 1 : 0.4 }}>{ToolbarIcons.component}</span>
                <span style={view === 'details' ? { width: 150 } : view === 'list' ? undefined : { fontSize: 10 }}>{c.name}</span>
                {view === 'details' && <span>{c.description}</span>}
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ marginTop: 4, color: 'var(--cw-gray-text)' }}>Ctrl+click or Shift+click selects several components.</div>
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ fonts / background

export const FONT_SIZES = [7, 8, 9, 10, 11, 12, 14, 16, 18];

export function FontDialog({ open, onClose, font, onApply }: { open: boolean; onClose: () => void; font: { face: string; size: number; color: string }; onApply: (f: { face: string; size: number; color: string }) => void }) {
  // Only the size is a choice: the code font is always THEME.monoFont (Consolas). The layout's face passes through.
  const [size, setSize] = useState(font.size);
  useResetOnOpen(open, () => setSize(font.size));
  return (
    <Dialog
      title="Font"
      open={open}
      onClose={onClose}
      width={360}
      testId="font-dialog"
      buttons={
        <>
          <Button
            isDefault
            onClick={() => {
              onApply({ face: font.face, size, color: font.color || 'BLACK' });
              onClose();
            }}
          >
            OK
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 8 }}>
        <label>
          Size:
          <select className="cw-field" style={{ display: 'block', width: 70 }} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Size">
            {FONT_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="cw-sunken" style={{ marginTop: 8, padding: 6, background: 'var(--cw-window)', fontFamily: THEME.monoFont, fontSize: `${(size * 96) / 72}px` }}>
        LDAA #$FF ; AaBbYyZz
      </div>
    </Dialog>
  );
}

export function BackgroundDialog({ open, onClose, color, onApply }: { open: boolean; onClose: () => void; color: string; onApply: (css: string) => void }) {
  const [c, setC] = useState(color);
  useResetOnOpen(open, () => setC(color));
  const presets = ['#ffffff', '#ffffe1', '#f0f0f0', '#e0f0ff', '#e8ffe8', '#c0c0c0'];
  return (
    <Dialog
      title="Background Color"
      open={open}
      onClose={onClose}
      width={300}
      testId="background-dialog"
      buttons={
        <>
          <Button
            isDefault
            onClick={() => {
              onApply(c);
              onClose();
            }}
          >
            OK
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
        {presets.map((p) => (
          <button key={p} type="button" aria-label={p} onClick={() => setC(p)} style={{ width: 24, height: 24, background: p, border: c === p ? '2px solid #000' : '1px solid #808080' }} />
        ))}
      </div>
      <label>
        Custom: <input type="color" value={c} onChange={(e) => setC(e.target.value)} aria-label="Custom color" />
      </label>
    </Dialog>
  );
}

export function AboutDialog({ open, onClose, version }: { open: boolean; onClose: () => void; version: string }) {
  return (
    <Dialog title="About S12 Studio Debugger" open={open} onClose={onClose} width={380} testId="about-dialog">
      <div style={{ lineHeight: 1.6 }}>
        <b>S12 Studio Debugger</b>
        <br />
        S12 Studio {version} - a debugger compatible with CodeWarrior S12(X) 5.1 projects (not affiliated with NXP/Freescale)
        <br />
        MC9S12XDP512 full chip simulation with the ME3305 board.
      </div>
    </Dialog>
  );
}
