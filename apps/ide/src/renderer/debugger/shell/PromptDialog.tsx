/** Generic one-field dialog for components: "Address...", "Go to Line...", "Find...". */
import { useState } from 'react';
import { Button, Dialog, useResetOnOpen, useSelectOnOpen } from '../../common/controls';

export interface PromptDialogProps {
  title: string;
  label: string;
  initial?: string;
  open: boolean;
  onOk: (value: string) => void;
  onClose: () => void;
  /** Validation message for the current text (shown under the field; disables OK). */
  validate?: (value: string) => string | null;
  testId?: string;
}

export function PromptDialog({ title, label, initial = '', open, onOk, onClose, validate, testId }: PromptDialogProps) {
  const [text, setText] = useState(initial);
  useResetOnOpen(open, () => setText(initial));
  const ref = useSelectOnOpen(open);
  const error = validate ? validate(text) : null;
  const ok = () => {
    if (error) return;
    onOk(text);
    onClose();
  };
  return (
    <Dialog
      title={title}
      open={open}
      onClose={onClose}
      width={320}
      testId={testId}
      buttons={
        <>
          <Button isDefault onClick={ok} disabled={!!error} testId={testId ? `${testId}-ok` : undefined}>
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
        <label style={{ display: 'block', marginBottom: 4 }}>
          {label}
          <input ref={ref} className="cw-field" style={{ display: 'block', width: '100%', marginTop: 2 }} value={text} onChange={(e) => setText(e.target.value)} aria-label={label} data-testid={testId ? `${testId}-input` : undefined} autoFocus />
        </label>
        {error && <div style={{ color: 'var(--cw-changed)' }}>{error}</div>}
      </form>
    </Dialog>
  );
}

