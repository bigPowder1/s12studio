/**
 * "Fill Memory" dialog (Memory > Fill...): From address, To address, Value, "Hex Format" check box.
 * Calls debug.fillMemory(start, end, value, space). Spec: docs/research/r1/ide.md §6 Memory menu.
 */
import { useEffect, useState } from 'react';
import { parseApiError, type AddressSpace } from '../../../shared/api';
import { Button, Dialog } from '../../common/controls';
import { parseNumber } from '../../common/format';
import { useS12 } from '../../common/s12';
import { hexText, resolveAddress } from './resolve';

export interface FillMemoryDialogProps {
  open: boolean;
  from?: number;
  to?: number;
  space?: AddressSpace;
  onClose: () => void;
  /** Called after a successful fill. */
  onFilled?: (start: number, end: number, value: number) => void;
}

export function FillMemoryDialog({ open, from, to, space = 'local', onClose, onFilled }: FillMemoryDialogProps) {
  const s12 = useS12();
  const [fromText, setFrom] = useState('');
  const [toText, setTo] = useState('');
  const [valueText, setValue] = useState('');
  const [hexFormat, setHexFormat] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setFrom(from !== undefined ? hexText(from) : '');
    setTo(to !== undefined ? hexText(to) : '');
    setValue('');
    setError(null);
  }, [open, from, to]);

  const ok = async () => {
    const radix = hexFormat ? 16 : 10;
    const start = await resolveAddress(s12, fromText, radix);
    const end = await resolveAddress(s12, toText, radix);
    const value = parseNumber(valueText, radix);
    if (start === null) return setError('Invalid "From" address');
    if (end === null) return setError('Invalid "To" address');
    if (end < start) return setError('"To" must not be below "From"');
    if (value === null || value < -128 || value > 0xff) return setError('Value must be a byte (0..FF)');
    try {
      await s12.debug.fillMemory(start, end, value & 0xff, space);
      onFilled?.(start, end, value & 0xff);
      onClose();
    } catch (e) {
      setError(parseApiError(e).message);
    }
  };

  const row = (label: string, value: string, set: (v: string) => void) => (
    <label style={{ display: 'grid', gridTemplateColumns: '90px 1fr', alignItems: 'center', marginBottom: 6 }}>
      <span>{label}</span>
      <input aria-label={label.replace(/:$/, '')} className="cw-field cw-mono" value={value} onChange={(e) => set(e.target.value)} />
    </label>
  );
  return (
    <Dialog
      open={open}
      title="Fill Memory"
      onClose={onClose}
      width={300}
      testId="fill-dialog"
      buttons={
        <>
          <Button isDefault onClick={() => void ok()} testId="fill-ok">
            OK
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ok();
        }}
      >
        {row('From Address:', fromText, setFrom)}
        {row('To Address:', toText, setTo)}
        {row('Value:', valueText, setValue)}
        <label>
          <input type="checkbox" checked={hexFormat} onChange={(e) => setHexFormat(e.target.checked)} /> Hex Format
        </label>
        {/* submit on Enter */}
        <button type="submit" hidden />
        {error && (
          <div role="alert" style={{ color: 'var(--cw-cmd-error)', marginTop: 6 }}>
            {error}
          </div>
        )}
      </form>
    </Dialog>
  );
}
