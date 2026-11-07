/**
 * "Display Address" dialog (Memory > Address...; also usable as Assembly's "Show PC"): one address field that accepts
 * numbers, symbols and expressions. Spec: docs/research/r1/ide.md §6 Memory menu.
 */
import { useState } from 'react';
import { Button, Dialog, useResetOnOpen, useSelectOnOpen } from '../../common/controls';
import { useS12 } from '../../common/s12';
import { hexText, resolveAddress } from './resolve';

export interface AddressDialogProps {
  open: boolean;
  title?: string;
  label?: string;
  initial?: number;
  onOk: (address: number) => void;
  onClose: () => void;
}

export function AddressDialog({ open, title = 'Display Address', label = 'Show Address', initial, onOk, onClose }: AddressDialogProps) {
  const s12 = useS12();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setText(initial !== undefined ? hexText(initial) : '');
    setError(null);
  });
  const field = useSelectOnOpen(open);
  const ok = async () => {
    const a = await resolveAddress(s12, text);
    if (a === null) {
      setError(`Cannot resolve "${text.trim()}"`);
      return;
    }
    onOk(a);
    onClose();
  };
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      width={300}
      testId="address-dialog"
      buttons={
        <>
          <Button isDefault onClick={() => void ok()} testId="address-ok">
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
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span>{label}</span>
          <input ref={field} aria-label="Address" className="cw-field cw-mono" style={{ flex: 1 }} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        {error && (
          <div role="alert" style={{ color: 'var(--cw-cmd-error)', marginTop: 6 }}>
            {error}
          </div>
        )}
      </form>
    </Dialog>
  );
}
