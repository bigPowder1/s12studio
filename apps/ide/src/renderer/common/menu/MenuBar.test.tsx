import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MenuBar, useMenuShortcuts } from './MenuBar';
import { SEP, type TopMenu } from './model';

function Bar({ menus }: { menus: TopMenu[] }) {
  useMenuShortcuts(menus);
  return <MenuBar menus={menus} />;
}

describe('MenuBar', () => {
  it('opens on mousedown, runs a command on click, binds shortcuts, skips disabled', () => {
    const go = vi.fn();
    const halt = vi.fn();
    const menus: TopMenu[] = [{ label: '&Run', items: [{ id: 'go', label: '&Start/Continue', shortcut: 'F5', onSelect: go }, SEP, { id: 'halt', label: '&Halt', shortcut: 'F6', disabled: true, onSelect: halt }] }];
    render(<Bar menus={menus} />);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.mouseDown(screen.getByText('un', { exact: false }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('F5')).toBeInTheDocument();
    fireEvent.click(screen.getByText('tart/Continue', { exact: false }));
    expect(go).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(window, { key: 'F5' });
    expect(go).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: 'F6' });
    expect(halt).not.toHaveBeenCalled();
  });

  it('a real press + click on a dropdown item runs it (mousedown inside the dropdown does not close the menu)', () => {
    const about = vi.fn();
    render(<Bar menus={[{ label: '&Help', items: [{ id: 'about', label: '&About', onSelect: about }] }]} />);
    fireEvent.mouseDown(screen.getByText('elp', { exact: false }));
    const item = document.querySelector('[data-menu-id="about"]')!;
    fireEvent.mouseDown(item);
    fireEvent.click(item);
    expect(about).toHaveBeenCalledTimes(1);
  });

  it('Alt+mnemonic opens the menu; Escape closes', () => {
    render(<Bar menus={[{ label: '&File', items: [{ label: 'E&xit', onSelect: () => undefined }] }]} />);
    fireEvent.keyDown(window, { key: 'f', altKey: true });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
