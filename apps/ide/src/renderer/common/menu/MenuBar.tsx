/**
 * Classic Windows menu bar (in-window, like CodeWarrior 5.1 / hiwave), dropdowns, cascading submenus and context
 * menus. Keyboard: Alt+mnemonic opens a menu, arrows move, Enter selects, Esc closes. Shortcuts of the commands are
 * bound by useMenuShortcuts().
 */
import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { isModalDialogOpen } from '../controls';
import { collectShortcuts, isSeparator, parseMnemonic, shortcutOf, type MenuCommand, type MenuEntry, type TopMenu } from './model';

function Label({ text, underline }: { text: string; underline: boolean }) {
  const m = parseMnemonic(text);
  if (!m.key) return <>{m.plain}</>;
  const k = m.plain[m.before.length];
  return (
    <>
      {m.before}
      <span className={underline ? 'cw-mnemonic' : undefined}>{k}</span>
      {m.after}
    </>
  );
}

interface MenuListProps {
  items: readonly MenuEntry[];
  style?: CSSProperties;
  onDone: () => void;
  /** Keyboard-highlighted index managed by the parent (top-level dropdown) */
  initialActive?: number;
  showMnemonics: boolean;
  role?: string;
  testId?: string;
}

/** A dropdown/popup list of entries (also used by ContextMenu). */
export function MenuList({ items, style, onDone, initialActive = -1, showMnemonics, testId }: MenuListProps) {
  const [active, setActive] = useState(initialActive);
  const [subOpen, setSubOpen] = useState<number>(-1);
  const ref = useRef<HTMLDivElement>(null);

  const selectable = (i: number) => {
    const e = items[i];
    return !!e && !isSeparator(e) && !e.disabled;
  };
  const run = (e: MenuCommand) => {
    if (e.disabled || e.submenu) return;
    onDone();
    e.onSelect?.();
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKey = (ev: KeyboardEvent) => {
      if (subOpen >= 0) return;
      const step = (d: number) => {
        let i = active;
        for (let n = 0; n < items.length; n++) {
          i = (i + d + items.length) % items.length;
          if (selectable(i)) break;
        }
        setActive(i);
      };
      if (ev.key === 'ArrowDown') step(1);
      else if (ev.key === 'ArrowUp') step(-1);
      else if (ev.key === 'ArrowRight' && active >= 0 && (items[active] as MenuCommand).submenu) setSubOpen(active);
      else if (ev.key === 'Enter' && active >= 0 && selectable(active)) run(items[active] as MenuCommand);
      else if (ev.key.length === 1) {
        const i = items.findIndex((e) => !isSeparator(e) && !e.disabled && parseMnemonic(e.label).key === ev.key.toLowerCase());
        if (i >= 0) {
          const e = items[i] as MenuCommand;
          if (e.submenu) {
            setActive(i);
            setSubOpen(i);
          } else run(e);
        }
      } else return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <div className="cw-menu" style={style} ref={ref} role="menu" data-testid={testId}>
      {items.map((e, i) =>
        isSeparator(e) ? (
          <div key={i} className="cw-menu-sep" role="separator" />
        ) : (
          <div
            key={i}
            role="menuitem"
            aria-disabled={e.disabled || undefined}
            aria-checked={e.checked}
            data-menu-id={e.id}
            className={`cw-menu-item${i === active ? ' active' : ''}${e.disabled ? ' disabled' : ''}`}
            style={{ position: 'relative' }}
            onMouseEnter={() => {
              setActive(i);
              setSubOpen(e.submenu ? i : -1);
            }}
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => run(e)}
          >
            <span className="check">{e.checked ? '✓' : ''}</span>
            <span className="label">
              <Label text={e.label} underline={showMnemonics} />
            </span>
            {e.shortcut && <span className="shortcut">{e.shortcut}</span>}
            <span className="arrow">{e.submenu ? '▸' : ''}</span>
            {e.submenu && subOpen === i && (
              <MenuList items={e.submenu} style={{ left: '100%', top: -3 }} onDone={onDone} showMnemonics={showMnemonics} initialActive={-1} />
            )}
          </div>
        ),
      )}
    </div>
  );
}

export interface MenuBarProps {
  menus: readonly TopMenu[];
  /** Extra content right-aligned in the bar (e.g. window controls). */
  right?: ReactNode;
  testId?: string;
}

export function MenuBar({ menus, right, testId = 'menubar' }: MenuBarProps) {
  const [open, setOpen] = useState(-1);
  const [hot, setHot] = useState(-1);
  const [altMode, setAltMode] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(-1);
    setHot(-1);
    setAltMode(false);
  }, []);

  useEffect(() => {
    if (open < 0) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const d = e.key === 'ArrowRight' ? 1 : -1;
        setOpen((o) => (o + d + menus.length) % menus.length);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close, menus.length]);

  // Alt+letter opens a menu
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isModalDialogOpen()) return; // the menu bar is inert behind a modal dialog
      if (e.altKey && !e.ctrlKey && e.key.length === 1) {
        const i = menus.findIndex((m) => !m.disabled && parseMnemonic(m.label).key === e.key.toLowerCase());
        if (i >= 0) {
          e.preventDefault();
          setAltMode(true);
          setOpen(i);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menus]);

  return (
    <div className="cw-menubar" ref={barRef} role="menubar" data-testid={testId}>
      {menus.map((m, i) => (
        <div
          key={m.id ?? m.label}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open === i}
          aria-disabled={m.disabled || undefined}
          data-menu={parseMnemonic(m.label).plain}
          className={`cw-menubar-item${open === i ? ' open' : hot === i ? ' hot' : ''}`}
          style={{ position: 'relative', color: m.disabled ? 'var(--cw-gray-text)' : undefined }}
          onMouseEnter={() => {
            setHot(i);
            if (open >= 0 && open !== i) setOpen(i);
          }}
          onMouseLeave={() => setHot(-1)}
          onMouseDown={(e) => {
            e.preventDefault();
            // a press inside the open dropdown (it is a DOM child of this item) must not toggle the menu shut before
            // the item's click arrives
            if (m.disabled || (e.target as HTMLElement).closest?.('.cw-menu')) return;
            setOpen(open === i ? -1 : i);
          }}
        >
          <Label text={m.label} underline={altMode} />
          {open === i && (
            <Fragment>
              <MenuList items={m.items} style={{ left: -1, top: '100%' }} onDone={close} showMnemonics={altMode} initialActive={altMode ? 0 : -1} testId={`menu-${parseMnemonic(m.label).plain}`} />
            </Fragment>
          )}
        </div>
      ))}
      <div style={{ flex: 1 }} />
      {right}
    </div>
  );
}

/** Shortcuts a focused text field handles itself (they never trigger a menu command while typing). */
const TEXT_EDITING = new Set(['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Ctrl+Insert', 'Shift+Insert', 'Shift+Delete', 'Ctrl+Backspace', 'Ctrl+Delete']);

export function isTextEditingShortcut(s: string): boolean {
  if (TEXT_EDITING.has(s)) return true;
  if (/(^|\+)F\d+$/.test(s)) return false; // function keys always reach the menu
  // Ctrl+caret movement stays with the field; other Ctrl/Alt combinations go to the menu
  if (/^(Ctrl|Alt)\+/.test(s)) return /^Ctrl\+(Shift\+)?(Home|End|ArrowLeft|ArrowRight|ArrowUp|ArrowDown)$/.test(s);
  return true; // plain and shifted keys are typing
}

/** True while a dropdown, submenu or context menu is showing. */
function isMenuOpen(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('.cw-menu');
}

/** Bind the shortcuts of all enabled menu commands on `window` (keydown). */
export function useMenuShortcuts(menus: readonly TopMenu[], enabled = true): void {
  const ref = useRef(menus);
  ref.current = menus;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // a modal dialog owns the keyboard, and an open dropdown/context menu handles its own keys (Windows: an
      // accelerator does not fire while a menu is tracking)
      if (isModalDialogOpen() || isMenuOpen()) return;
      const s = shortcutOf(e);
      if (!s) return;
      const cmd = collectShortcuts(ref.current).get(s);
      if (!cmd) return;
      // let text fields keep their own editing keys (clipboard, undo, select all, caret movement); other shortcuts
      // (Ctrl+S, Ctrl+O, F7...) still reach the menu, as in a Windows MDI app (IDE shell track)
      const t = e.target as HTMLElement | null;
      const editing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (editing && isTextEditingShortcut(s)) return;
      e.preventDefault();
      cmd.onSelect?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuEntry[];
}

/** Right-click popup: render `<ContextMenu state={s} onClose={...} />` with state from an onContextMenu handler. */
export function ContextMenu({ state, onClose }: { state: ContextMenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!state) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [state, onClose]);
  if (!state) return null;
  return (
    <div ref={ref} style={{ position: 'fixed', left: state.x, top: state.y, zIndex: 3000 }}>
      <MenuList items={state.items} style={{ position: 'relative' }} onDone={onClose} showMnemonics={false} testId="context-menu" />
    </div>
  );
}
