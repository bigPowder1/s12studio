/**
 * Review fixes in the shared primitives: global shortcuts and Alt+mnemonics stay out of modal dialogs and open menus,
 * Enter presses a dialog's default button (submenu color: theme.test.ts).
 */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Button, Dialog, isModalDialogOpen } from '../controls';
import { MenuBar, useMenuShortcuts } from './MenuBar';
import type { TopMenu } from './model';

function App({ menus, dialog = false }: { menus: TopMenu[]; dialog?: boolean }) {
  useMenuShortcuts(menus);
  const [open, setOpen] = useState(dialog);
  return (
    <>
      <MenuBar menus={menus} />
      <Dialog title="Settings" open={open} onClose={() => setOpen(false)}>
        <input aria-label="Output" />
      </Dialog>
    </>
  );
}

const menus = (make: () => void, newProj: () => void): TopMenu[] => [
  { label: '&Edit', items: [{ id: 'undo', label: '&Undo', onSelect: () => undefined }] },
  { label: '&Project', items: [{ id: 'make', label: '&Make', shortcut: 'F7', onSelect: make }, { id: 'new', label: '&New...', shortcut: 'Ctrl+Shift+N', onSelect: newProj }] },
];

describe('shortcuts behind a modal dialog / open menu (review finding 2)', () => {
  it('a modal dialog blocks menu shortcuts and Alt+mnemonics', () => {
    const make = vi.fn();
    const np = vi.fn();
    render(<App menus={menus(make, np)} dialog />);
    expect(isModalDialogOpen()).toBe(true);
    const field = screen.getByLabelText('Output');
    field.focus();
    fireEvent.keyDown(field, { key: 'F7' });
    fireEvent.keyDown(field, { key: 'N', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: 'p', altKey: true });
    expect(make).not.toHaveBeenCalled();
    expect(np).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    // closed: shortcuts work again
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(isModalDialogOpen()).toBe(false);
    fireEvent.keyDown(window, { key: 'F7' });
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('an open dropdown blocks menu shortcuts', () => {
    const make = vi.fn();
    render(<App menus={menus(make, () => undefined)} />);
    fireEvent.mouseDown(screen.getByText('dit', { exact: false }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'F7' });
    expect(make).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(window, { key: 'F7' });
    expect(make).toHaveBeenCalledTimes(1);
  });
});

describe('Enter presses the default button (review finding 5)', () => {
  function D({ ok, inner, form }: { ok: () => void; inner?: () => void; form?: () => void }) {
    return (
      <Dialog
        title="T"
        open
        onClose={() => undefined}
        buttons={
          <>
            <Button isDefault onClick={ok}>
              OK
            </Button>
            <Button>Cancel</Button>
          </>
        }
      >
        <input aria-label="plain" />
        <textarea aria-label="area" />
        <input
          aria-label="own"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              inner?.();
            }
          }}
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            form?.();
          }}
        >
          <input aria-label="in form" />
        </form>
      </Dialog>
    );
  }

  it('in a text field: clicks the default button', () => {
    const ok = vi.fn();
    render(<D ok={ok} />);
    fireEvent.keyDown(screen.getByLabelText('plain'), { key: 'Enter' });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('not in a textarea, a field handling Enter itself, or a form field', () => {
    const ok = vi.fn();
    const inner = vi.fn();
    render(<D ok={ok} inner={inner} />);
    fireEvent.keyDown(screen.getByLabelText('area'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByLabelText('own'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByLabelText('in form'), { key: 'Enter' });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(ok).not.toHaveBeenCalled();
  });

  it('only the topmost dialog reacts', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <>
        <Dialog title="Outer" open onClose={() => undefined} buttons={<Button isDefault onClick={outer}>OK</Button>}>
          <input aria-label="outer field" />
        </Dialog>
        <Dialog title="Inner" open onClose={() => undefined} buttons={<Button isDefault onClick={inner}>OK</Button>}>
          <input aria-label="inner field" />
        </Dialog>
      </>,
    );
    fireEvent.keyDown(screen.getByLabelText('outer field'), { key: 'Enter' });
    expect(outer).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('inner field'), { key: 'Enter' });
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
