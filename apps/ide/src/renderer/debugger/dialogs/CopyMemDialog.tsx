/**
 * "Copy Memory" dialog (Memory > CopyMem): source From / To, Destination address, "Hex Format" check box.
 * Spec: docs/research/r1/ide.md §6 Memory menu ("CopyMem"); the command language has COPYMEM.
 * UNCERTAIN: the exact hiwave field layout; this mirrors the Fill Memory dialog.
 */
import { useEffect, useState } from 'react';
import { parseApiError, type AddressSpace } from '../../../shared/api';
import { Button, Dialog } from '../../common/controls';
import { useS12 } from '../../common/s12';
import { copyMemory } from './memtools';
import { hexText, resolveAddress } from './resolve';

export interface CopyMemDialogProps {
  open: boolean;
  from?: number;
  to?: number;
  space?: AddressSpace;
  onClose: () => void;
  /** Called after a successful copy with the destination range. */
  onCopied?: (dest: number, length: number) => void;
}

export function CopyMemDialog({ open, from, to, space = 'local', onClose, onCopied }: CopyMemDialogProps) {
  const s12 = useS12();
  const [fromText, setFrom] = useState('');
  const [toText, setTo] = useState('');
  const [destText, setDest] = useState('');
  const [hexFormat, setHexFormat] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setFrom(from !== undefined ? hexText(from) : '');
    setTo(to !== undefined ? hexText(to) : '');
    setDest('');
    setError(null);
  }, [open, from, to]);

  const ok = async () => {
    const radix = hexFormat ? 16 : 10;
    const start = await resolveAddress(s12, fromText, radix);
    const end = await resolveAddress(s12, toText, radix);
    const dest = await resolveAddress(s12, destText, radix);
    if (start === null) return setError('Invalid "From" address');
    if (end === null) return setError('Invalid "To" address');
    if (end < start) return setError('"To" must not be below "From"');
    if (dest === null) return setError('Invalid destination address');
    const limit = space === 'global' ? 0x800000 : 0x10000;
    if (dest + (end - start) >= limit) return setError('Destination range exceeds the address space');
    setBusy(true);
    try {
      await copyMemory(s12, start, end, dest, space);
      onCopied?.(dest, end - start + 1);
      onClose();
    } catch (e) {
      setError(parseApiError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, value: string, set: (v: string) => void) => (
    <label style={{ display: 'grid', gridTemplateColumns: '110px 1fr', alignItems: 'center', marginBottom: 6 }}>
      <span>{label}</span>
      <input aria-label={label.replace(/:$/, '')} className="cw-field cw-mono" value={value} onChange={(e) => set(e.target.value)} />
    </label>
  );
  return (
    <Dialog
      open={open}
      title="Copy Memory"
      onClose={onClose}
      width={320}
      testId="copymem-dialog"
      buttons={
        <>
          <Button isDefault disabled={busy} onClick={() => void ok()} testId="copymem-ok">
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
        {row('Destination:', destText, setDest)}
        <label>
          <input type="checkbox" checked={hexFormat} onChange={(e) => setHexFormat(e.target.checked)} /> Hex Format
        </label>
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
