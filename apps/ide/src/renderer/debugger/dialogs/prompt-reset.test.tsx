/**
 * Text-entry dialogs show their default text in the very first frame after opening and never overwrite what the user
 * typed afterwards (m6c-verify: Address `fill("top")` replaced by the default; "0x800x2400" while running).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { PromptDialog as CommonPrompt } from '../../common/controls';
import { S12Provider } from '../../common/s12';
import { createMockS12 } from '../../common/testing/mockS12';
import { PromptDialog as ShellPrompt } from '../shell/PromptDialog';
import { AddressDialog } from './AddressDialog';
import { PromptDialog as DataPrompt } from './PromptDialog';

/** Records the field's value in the layout phase of every commit, i.e. what the first painted frame shows. */
function Probe({ open, seen }: { open: boolean; seen: string[] }) {
  useLayoutEffect(() => {
    if (open) seen.push((document.querySelector('input') as HTMLInputElement | null)?.value ?? '<none>');
  }, [open, seen]);
  return null;
}

type Make = (open: boolean, initial: string) => ReactElement;

const noop = () => undefined;
const DIALOGS: [string, Make][] = [
  ['shell PromptDialog (Assembly/Source)', (open, initial) => <ShellPrompt title="Address" label="Address:" initial={initial} open={open} onOk={noop} onClose={noop} />],
  ['dialogs PromptDialog (Memory/Data/Command)', (open, initial) => <DataPrompt title="Address" label="Address:" initial={initial} open={open} onOk={noop} onClose={noop} />],
  ['common PromptDialog (IDE)', (open, initial) => <CommonPrompt title="Rename" label="Name:" initial={initial} open={open} onOk={noop} onCancel={noop} />],
  ['AddressDialog', (open, initial) => <AddressDialog open={open} initial={Number(initial)} onOk={noop} onClose={noop} />],
];

function setup(make: Make) {
  const m = createMockS12();
  const seen: string[] = [];
  const ui = (open: boolean, initial: string) => (
    <S12Provider api={m.api}>
      {make(open, initial)}
      <Probe open={open} seen={seen} />
    </S12Provider>
  );
  const r = render(ui(false, '0x4000'));
  return { seen, rerender: (open: boolean, initial: string) => r.rerender(ui(open, initial)) };
}

const input = () => screen.getByRole('dialog').querySelector('input') as HTMLInputElement;

describe.each(DIALOGS)('%s', (_name, make) => {
  it('shows the current default in the first frame after opening, not the text of the last open', () => {
    const { seen, rerender } = setup(make);
    rerender(true, '0x4000');
    fireEvent.change(input(), { target: { value: 'old text' } });
    rerender(false, '0x4000');
    seen.length = 0;
    rerender(true, '0xC000');
    expect(seen[0]?.toUpperCase()).toMatch(/C000/);
    expect(input().value.toUpperCase()).toMatch(/C000/);
    // the default is selected, so typing replaces it (Windows dialog behaviour)
    expect([input().selectionStart, input().selectionEnd]).toEqual([0, input().value.length]);
  });

  it('keeps typed text when the default changes while open (e.g. the PC while running)', () => {
    const { rerender } = setup(make);
    rerender(true, '0x4000');
    fireEvent.change(input(), { target: { value: 'top' } });
    rerender(true, '0x4201');
    rerender(true, '0x4202');
    expect(input().value).toBe('top');
  });
});
