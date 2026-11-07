/**
 * Small one-field dialogs of the data components: Update Rate (100 ms steps), Cache Size, Name Width,
 * "Edit Expression" (Data). `validate` returns an error text or null.
 */
import { useState } from 'react';
import { Button, Dialog, useResetOnOpen, useSelectOnOpen } from '../../common/controls';

export interface PromptDialogProps {
  open: boolean;
  title: string;
  label: string;
  initial?: string;
  /** Error text for an invalid entry, or null. */
  validate?: (text: string) => string | null;
  onOk: (text: string) => void;
  onClose: () => void;
  testId?: string;
}

export function PromptDialog({ open, title, label, initial = '', validate, onOk, onClose, testId = 'prompt-dialog' }: PromptDialogProps) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setText(initial);
    setError(null);
  });
  const field = useSelectOnOpen(open);
  const ok = () => {
    const err = validate?.(text) ?? null;
    if (err) return setError(err);
    onOk(text);
    onClose();
  };
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      width={320}
      testId={testId}
      buttons={
        <>
          <Button isDefault onClick={ok} testId={`${testId}-ok`}>
            OK
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ok();
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>{label}</span>
          <input ref={field} aria-label={label} className="cw-field cw-mono" autoFocus value={text} onChange={(e) => setText(e.target.value)} />
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

/** Validator for integer fields within [min, max]. */
export const intRange =
  (min: number, max: number) =>
  (t: string): string | null => {
    const n = Number(t.trim());
    return Number.isInteger(n) && n >= min && n <= max ? null : `Enter a number between ${min} and ${max}`;
  };
