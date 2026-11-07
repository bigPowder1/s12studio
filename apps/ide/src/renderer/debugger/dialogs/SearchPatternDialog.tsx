/**
 * "Search Pattern" dialog (Memory > Search Pattern): pattern (hex bytes or a quoted string), search range, "Hex
 * Format". Find Next selects the match in the Memory window and keeps the dialog open; the next search starts one
 * byte after the previous match. Spec: docs/research/r1/ide.md §6 Memory menu ("Search Pattern").
 * UNCERTAIN: the exact hiwave dialog layout and wrap-around behaviour (here: no wrap; "Pattern not found").
 */
import { useEffect, useRef, useState } from 'react';
import { parseApiError, type AddressSpace } from '../../../shared/api';
import { Button, Dialog } from '../../common/controls';
import { useS12 } from '../../common/s12';
import { parsePattern, searchMemory } from './memtools';
import { hexText, resolveAddress } from './resolve';

export interface SearchPatternDialogProps {
  open: boolean;
  /** Search start (the Memory selection or the top of the window). */
  from?: number;
  space?: AddressSpace;
  onClose: () => void;
  onFound: (address: number, length: number) => void;
}

export function SearchPatternDialog({ open, from, space = 'local', onClose, onFound }: SearchPatternDialogProps) {
  const s12 = useS12();
  const limit = space === 'global' ? 0x7fffff : 0xffff;
  const [pattern, setPattern] = useState('');
  const [fromText, setFrom] = useState('');
  const [toText, setTo] = useState('');
  const [hexFormat, setHexFormat] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = useRef<number | null>(null);
  useEffect(() => {
    if (!open) return;
    setFrom(hexText(from ?? 0));
    setTo(hexText(limit));
    setMsg(null);
    next.current = null;
    // initialise on opening only: a match moves the Memory selection (`from`), which must not restart the search
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const find = async () => {
    const bytes = parsePattern(pattern, hexFormat);
    if (!bytes) return setMsg('Invalid pattern (hex bytes like "A5 5A" or a quoted string)');
    const radix = hexFormat ? 16 : 10;
    const start = await resolveAddress(s12, fromText, radix);
    const end = await resolveAddress(s12, toText, radix);
    if (start === null) return setMsg('Invalid "From" address');
    if (end === null || end < start) return setMsg('Invalid "To" address');
    setBusy(true);
    setMsg('Searching...');
    try {
      const a = await searchMemory(s12, next.current ?? start, Math.min(end, limit), bytes, space);
      if (a === null) {
        setMsg('Pattern not found');
        next.current = null;
      } else {
        setMsg(`Found at ${hexText(a)}`);
        next.current = a + 1;
        onFound(a, bytes.length);
      }
    } catch (e) {
      setMsg(parseApiError(e).message);
    } finally {
      setBusy(false);
    }
  };
  const reset = () => (next.current = null);

  const row = (label: string, value: string, set: (v: string) => void) => (
    <label style={{ display: 'grid', gridTemplateColumns: '90px 1fr', alignItems: 'center', marginBottom: 6 }}>
      <span>{label}</span>
      <input
        aria-label={label.replace(/:$/, '')}
        className="cw-field cw-mono"
        value={value}
        onChange={(e) => {
          set(e.target.value);
          reset();
        }}
      />
    </label>
  );
  return (
    <Dialog
      open={open}
      title="Search Pattern"
      onClose={onClose}
      width={340}
      testId="search-dialog"
      buttons={
        <>
          <Button isDefault disabled={busy} onClick={() => void find()} testId="search-find">
            Find Next
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        {row('Pattern:', pattern, setPattern)}
        {row('From:', fromText, setFrom)}
        {row('To:', toText, setTo)}
        <label>
          <input
            type="checkbox"
            checked={hexFormat}
            onChange={(e) => {
              setHexFormat(e.target.checked);
              reset();
            }}
          />{' '}
          Hex Format
        </label>
        <button type="submit" hidden />
        {msg && (
          <div role="status" style={{ marginTop: 6, color: /not found|Invalid/.test(msg) ? 'var(--cw-cmd-error)' : undefined }}>
            {msg}
          </div>
        )}
      </form>
    </Dialog>
  );
}
