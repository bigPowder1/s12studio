/** Add/edit dialog of one VisualizationTool-lite instrument. */
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Dialog } from '../../../common/controls';
import { parseNumber } from '../../../common/format';
import { autoLabel, KIND_NAMES, type Instrument, type LedColor, type Seg7Mode, type TextFormat } from './model';

export interface InstrumentDialogProps {
  /** Instrument being edited (null = closed). */
  value: Instrument | null;
  isNew: boolean;
  onOk(inst: Instrument): void;
  onCancel(): void;
  onDelete(id: string): void;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '3px 0' }}>
      <span style={{ width: 90 }}>{label}</span>
      {children}
    </label>
  );
}

export function InstrumentDialog({ value, isNew, onOk, onCancel, onDelete }: InstrumentDialogProps) {
  const [d, setD] = useState<Instrument | null>(value);
  const [minText, setMinText] = useState('');
  const [maxText, setMaxText] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    setD(value);
    setMinText(String(value?.min ?? 0));
    setMaxText(String(value?.max ?? (value?.size === 2 ? 0xffff : 0xff)));
    setError('');
  }, [value]);
  if (!value || !d) return null;
  const set = (p: Partial<Instrument>) => setD({ ...d, ...p });
  const ok = () => {
    if (!d.expr.trim()) return setError('Enter an expression (register, address or symbol).');
    const out: Instrument = {
      ...d,
      expr: d.expr.trim(),
      label: d.label.trim(),
    };
    if (d.kind === 'bar') {
      const mn = parseNumber(minText, 10);
      const mx = parseNumber(maxText, 10);
      if (mn === null || mx === null || mx === mn) return setError('Min and Max must be different numbers.');
      out.min = mn;
      out.max = mx;
    }
    if (d.kind === 'led') out.bit = Math.max(0, Math.min(d.size * 8 - 1, d.bit ?? 0));
    onOk(out);
  };
  const field = { className: 'cw-field', style: { flex: 1 } };
  return (
    <Dialog
      title={`${isNew ? 'Add' : 'Edit'} ${KIND_NAMES[d.kind]}`}
      open
      onClose={onCancel}
      width={320}
      testId="vis-dialog"
      buttons={
        <>
          {!isNew && (
            <Button onClick={() => onDelete(d.id)} testId="vis-dialog-delete">
              Delete
            </Button>
          )}
          <Button isDefault onClick={ok} testId="vis-dialog-ok">
            OK
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ok();
        }}
      >
        <Row label="Label">
          <input {...field} value={d.label} onChange={(e) => set({ label: e.target.value })} aria-label="Label" placeholder={autoLabel(d) || '(expression)'} data-testid="vis-label" />
        </Row>
        <Row label="Expression">
          <input {...field} value={d.expr} onChange={(e) => set({ expr: e.target.value })} aria-label="Expression" placeholder="PTP, $0258, A, symbol" data-testid="vis-expr" autoFocus />
        </Row>
        <Row label="Size">
          <select {...field} value={d.size} onChange={(e) => set({ size: Number(e.target.value) === 2 ? 2 : 1 })} aria-label="Size">
            <option value={1}>Byte</option>
            <option value={2}>Word</option>
          </select>
        </Row>
        {d.kind === 'led' && (
          <>
            <Row label="Bit">
              <input {...field} type="number" min={0} max={d.size * 8 - 1} value={d.bit ?? 0} onChange={(e) => set({ bit: Number(e.target.value) | 0 })} aria-label="Bit" data-testid="vis-bit" />
            </Row>
            <Row label="Color">
              <select {...field} value={d.color ?? 'red'} onChange={(e) => set({ color: e.target.value as LedColor })} aria-label="Color">
                <option value="red">Red</option>
                <option value="green">Green</option>
                <option value="yellow">Yellow</option>
                <option value="blue">Blue</option>
              </select>
            </Row>
            <Row label="Active low">
              <input type="checkbox" checked={!!d.activeLow} onChange={(e) => set({ activeLow: e.target.checked })} aria-label="Active low" />
            </Row>
          </>
        )}
        {d.kind === 'seg7' && (
          <Row label="Display">
            <select {...field} value={d.mode ?? 'hex'} onChange={(e) => set({ mode: e.target.value as Seg7Mode })} aria-label="Display">
              <option value="hex">Hex digits</option>
              <option value="dec">Decimal digits</option>
              <option value="segments">Segment bits (a=bit0 .. dp=bit7)</option>
            </select>
          </Row>
        )}
        {d.kind === 'bar' && (
          <>
            <Row label="Min">
              <input {...field} value={minText} onChange={(e) => setMinText(e.target.value)} aria-label="Min" data-testid="vis-min" />
            </Row>
            <Row label="Max">
              <input {...field} value={maxText} onChange={(e) => setMaxText(e.target.value)} aria-label="Max" data-testid="vis-max" />
            </Row>
          </>
        )}
        {d.kind === 'text' && (
          <Row label="Format">
            <select {...field} value={d.format ?? 'hex'} onChange={(e) => set({ format: e.target.value as TextFormat })} aria-label="Format">
              <option value="hex">Hex</option>
              <option value="dec">Signed decimal</option>
              <option value="udec">Unsigned decimal</option>
              <option value="bin">Binary</option>
              <option value="char">Char</option>
            </select>
          </Row>
        )}
        {error && (
          <div style={{ color: 'var(--cw-cmd-error)', marginTop: 4 }} role="alert">
            {error}
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
