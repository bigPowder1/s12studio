/**
 * "HC12 Assembler Option Settings" (Assembler for HC12 panel > Options...): tabbed checkboxes/radio groups over the
 * option string; the resulting command line is shown live. UNCERTAIN: exact page names/labels of CW's dialog (taken
 * from the assembler manual's option groups, ide.md §4).
 */
import { useState } from 'react';
import { Button, Checkbox, Dialog, GroupBox, Tabs, useResetOnOpen } from '../../common/controls';
import { ASM_OPTION_PAGES, DEFAULT_LISTING, choiceValue, definesValue, flagOn, listingValue, otherOptions, setChoice, setDefines, setFlag, setListing } from './asm-options';

export interface AsmOptionsDialogProps {
  open: boolean;
  value: string;
  onOk: (value: string) => void;
  onCancel: () => void;
}

export function AsmOptionsDialog({ open, value, onOk, onCancel }: AsmOptionsDialogProps) {
  const [v, setV] = useState(value);
  const [page, setPage] = useState('output');
  const [listingName, setListingName] = useState(DEFAULT_LISTING.slice(3));
  useResetOnOpen(open, () => {
    setV(value);
    const l = listingValue(value);
    setListingName(l ? l : DEFAULT_LISTING.slice(3));
  });
  const listing = listingValue(v);

  const pages = ASM_OPTION_PAGES.map((p) => ({
    id: p.id,
    label: p.label,
    content: (
      <div className="ide-opt-page">
        {p.id === 'output' && (
          <GroupBox label="Listing">
            <Checkbox label="Generate a listing file (-L)" checked={listing !== null} onChange={(on) => setV(setListing(v, on ? listingName : null))} testId="asmopt--L" />
            <label className="ide-form-row">
              <span>Listing file name:</span>
              <input
                className="cw-field"
                aria-label="Listing file name"
                disabled={listing === null}
                value={listing ?? listingName}
                onChange={(e) => {
                  setListingName(e.target.value);
                  setV(setListing(v, e.target.value));
                }}
              />
            </label>
          </GroupBox>
        )}
        {p.id === 'language' && (
          <GroupBox label="Input">
            <label className="ide-form-row">
              <span>Define (-D):</span>
              <input
                className="cw-field"
                aria-label="Defines"
                placeholder="NAME=1 OTHER"
                value={definesValue(v).join(' ')}
                onChange={(e) => setV(setDefines(v, e.target.value.split(/\s+/)))}
              />
            </label>
          </GroupBox>
        )}
        {(p.choices ?? []).map((c) => (
          <GroupBox key={c.id} label={c.label}>
            <div role="radiogroup" aria-label={c.label} className="ide-col">
              {c.choices.map((ch) => (
                <label key={ch.label} className="cw-check">
                  <input type="radio" name={`asmopt-${c.id}`} checked={choiceValue(v, c) === ch.token} onChange={() => setV(setChoice(v, c, ch.token))} data-testid={`asmopt-${c.id}-${ch.token ?? 'default'}`} />
                  <span>{ch.label}</span>
                </label>
              ))}
            </div>
          </GroupBox>
        ))}
        {(p.flags ?? []).length > 0 && (
          <GroupBox label="Options">
            <div className="ide-col">
              {(p.flags ?? []).map((f) => (
                <Checkbox key={f.flag} label={f.label} checked={flagOn(v, f)} onChange={(on) => setV(setFlag(v, f, on))} testId={`asmopt-${f.flag}`} />
              ))}
            </div>
          </GroupBox>
        )}
      </div>
    ),
  }));

  const other = otherOptions(v);
  return (
    <Dialog
      title="HC12 Assembler Option Settings"
      open={open}
      onClose={onCancel}
      width={520}
      testId="asm-options-dialog"
      buttons={
        <>
          <Button isDefault onClick={() => onOk(v)} testId="asm-options-ok">
            OK
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </>
      }
    >
      <Tabs tabs={pages} selected={page} onSelect={setPage} style={{ height: 250 }} />
      {other.length > 0 && <div className="ide-hint">Other options (kept as written): {other.join(' ')}</div>}
      <div className="ide-form-row" style={{ marginTop: 6 }}>
        <span>Command line:</span>
        <input className="cw-field cw-mono" readOnly value={v} aria-label="Assembler command line" data-testid="asm-options-cmdline" />
      </div>
    </Dialog>
  );
}
