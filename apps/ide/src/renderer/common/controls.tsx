/**
 * Classic Windows controls: Toolbar + ToolButton, StatusBar panes, Button, Dialog, Tabs, GroupBox, Splitter,
 * Caption. All styling lives in theme.css (`cw-*` classes).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

// ------------------------------------------------------------------------------------------------ dialog state

/**
 * Run `reset` (state setters of the calling component) when `open` turns true, during that same render, so the first
 * frame of an opened dialog already shows its fresh field values. Do not reset dialog fields from a
 * `useEffect(..., [open, initial])`: the effect runs after the dialog painted (stale text from the last time) and runs
 * again whenever `initial` changes while the dialog is open (e.g. the PC while running), overwriting what the user
 * already typed. Later changes of the values `reset` reads are ignored until the next open.
 */
export function useResetOnOpen(open: boolean, reset: () => void): void {
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) reset();
  }
}

/**
 * Ref for a dialog's text field whose whole text is selected when the dialog opens (the Windows dialog manager selects
 * the edit control that gets the initial focus), before the first paint, so the first key typed replaces it.
 */
export function useSelectOnOpen(open: boolean) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (open) ref.current?.select();
  }, [open]);
  return ref;
}

// ------------------------------------------------------------------------------------------------ toolbar

export function Toolbar({ children, testId, className }: { children: ReactNode; testId?: string; className?: string }) {
  return (
    <div className={className ? `cw-toolbar ${className}` : 'cw-toolbar'} role="toolbar" data-testid={testId}>
      {children}
    </div>
  );
}

export interface ToolButtonProps {
  /** Tooltip (also the accessible name). */
  title: string;
  /** Icon: an inline SVG/element or short text. */
  icon: ReactNode;
  /** Optional caption after the icon. */
  text?: string;
  onClick?: () => void;
  disabled?: boolean;
  pressed?: boolean;
  testId?: string;
}

export function ToolButton({ title, icon, text, onClick, disabled, pressed, testId }: ToolButtonProps) {
  return (
    <button type="button" className={`cw-tool-btn${pressed ? ' pressed' : ''}`} title={title} aria-label={title} aria-pressed={pressed} disabled={disabled} onClick={onClick} data-testid={testId}>
      {icon}
      {text && <span>{text}</span>}
    </button>
  );
}

export function ToolSeparator() {
  return <span className="cw-tool-sep" role="separator" />;
}

// ------------------------------------------------------------------------------------------------ status bar

export interface StatusPane {
  id: string;
  content: ReactNode;
  /** Fixed width (px); omit for the growing first pane. */
  width?: number;
  title?: string;
  onClick?: () => void;
  onDoubleClick?: () => void;
}

export function StatusBar({ panes, testId }: { panes: StatusPane[]; testId?: string }) {
  return (
    <div className="cw-statusbar" data-testid={testId}>
      {panes.map((p) => (
        <div key={p.id} data-pane={p.id} className={`cw-status-pane${p.width ? '' : ' grow'}`} style={p.width ? { width: p.width } : undefined} title={p.title} onClick={p.onClick} onDoubleClick={p.onDoubleClick}>
          {p.content}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ buttons, group boxes

export function Button({ children, onClick, disabled, isDefault, testId, type = 'button' }: { children: ReactNode; onClick?: () => void; disabled?: boolean; isDefault?: boolean; testId?: string; type?: 'button' | 'submit' }) {
  return (
    <button type={type} className={`cw-button${isDefault ? ' default' : ''}`} onClick={onClick} disabled={disabled} data-testid={testId}>
      {children}
    </button>
  );
}

export function GroupBox({ label, children, style }: { label: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="cw-groupbox" style={style} role="group" aria-label={label}>
      <span className="legend">{label}</span>
      {children}
    </div>
  );
}

export function Caption({ title, active, children }: { title: string; active?: boolean; children?: ReactNode }) {
  return (
    <div className={`cw-caption${active ? ' active' : ''}`}>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ dialog

export interface DialogProps {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Bottom-right buttons; default a single OK. */
  buttons?: ReactNode;
  width?: number | string;
  testId?: string;
}

/** Open dialogs, innermost last: only the top one reacts to Esc (nested dialogs, e.g. Options... in Settings). */
const dialogStack: object[] = [];

/** True while any modal `Dialog` is open (global shortcuts and Alt+mnemonics must not reach the window behind it). */
export function isModalDialogOpen(): boolean {
  return dialogStack.length > 0;
}

/** Modal dialog with a classic caption bar. Esc closes (the topmost dialog only). */
export function Dialog({ title, open, onClose, children, buttons, width, testId }: DialogProps) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const me = {};
    dialogStack.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dialogStack[dialogStack.length - 1] === me) {
        e.stopPropagation();
        closeRef.current();
      }
    };
    // Enter in a text field / check box presses the default button (Windows dialog behaviour). Bubble phase, so a
    // field that handles Enter itself (preventDefault) wins; fields inside a <form> submit it instead.
    const onEnter = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
      if (dialogStack[dialogStack.length - 1] !== me) return;
      const t = e.target as HTMLInputElement | null;
      if (!t || t.tagName !== 'INPUT' || t.form || !boxRef.current?.contains(t)) return;
      if (['button', 'submit', 'reset', 'file', 'image'].includes(t.type)) return;
      const def = boxRef.current.querySelector<HTMLButtonElement>('.cw-dialog-buttons .cw-button.default');
      if (!def || def.disabled) return;
      e.preventDefault();
      def.click();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keydown', onEnter);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keydown', onEnter);
      const i = dialogStack.indexOf(me);
      if (i >= 0) dialogStack.splice(i, 1);
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="cw-dialog-backdrop" onMouseDown={(e) => e.stopPropagation()}>
      <div ref={boxRef} className="cw-dialog" role="dialog" aria-modal="true" aria-label={title} style={{ width }} data-testid={testId}>
        <Caption title={title} active>
          <button type="button" className="cw-tool-btn" style={{ minWidth: 16, height: 14, padding: 0, color: 'var(--cw-window-text)' }} aria-label="Close" onClick={onClose}>
            {'×'}
          </button>
        </Caption>
        <div className="cw-dialog-body">{children}</div>
        <div className="cw-dialog-buttons">
          {buttons ?? (
            <Button isDefault onClick={onClose}>
              OK
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ tabs

export interface TabDef {
  id: string;
  label: string;
  content: ReactNode;
}

export function Tabs({ tabs, selected, onSelect, style, testId }: { tabs: TabDef[]; selected: string; onSelect: (id: string) => void; style?: CSSProperties; testId?: string }) {
  const cur = tabs.find((t) => t.id === selected) ?? tabs[0];
  return (
    <div className="cw-tabs" style={style} data-testid={testId}>
      <div className="cw-tab-strip" role="tablist">
        {tabs.map((t) => (
          <div key={t.id} role="tab" aria-selected={t.id === cur?.id} className={`cw-tab${t.id === cur?.id ? ' selected' : ''}`} onMouseDown={() => onSelect(t.id)}>
            {t.label}
          </div>
        ))}
      </div>
      <div className="cw-tab-page" role="tabpanel">
        {cur?.content}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ splitter

export interface SplitterProps {
  /** 'horizontal' = side by side (vertical bar), 'vertical' = stacked. */
  direction: 'horizontal' | 'vertical';
  /** First pane size in px (controlled or initial). */
  initial: number;
  min?: number;
  first: ReactNode;
  second: ReactNode;
  onResize?: (size: number) => void;
}

export function Splitter({ direction, initial, min = 60, first, second, onResize }: SplitterProps) {
  const [size, setSize] = useState(initial);
  const ref = useRef<HTMLDivElement>(null);
  const onDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const box = ref.current?.getBoundingClientRect();
      if (!box) return;
      const move = (ev: MouseEvent) => {
        const total = direction === 'horizontal' ? box.width : box.height;
        const pos = direction === 'horizontal' ? ev.clientX - box.left : ev.clientY - box.top;
        const s = Math.max(min, Math.min(total - min, pos));
        setSize(s);
        onResize?.(s);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    },
    [direction, min, onResize],
  );
  const horiz = direction === 'horizontal';
  return (
    <div ref={ref} className={`cw-split${horiz ? '' : ' vertical'}`}>
      <div className="cw-split-pane" style={horiz ? { width: size, flex: 'none' } : { height: size, flex: 'none' }}>
        {first}
      </div>
      <div className="cw-split-bar" onMouseDown={onDown} role="separator" aria-orientation={horiz ? 'vertical' : 'horizontal'} />
      <div className="cw-split-pane" style={{ flex: 1 }}>
        {second}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ prompt dialog
// added by the IDE shell track

export interface PromptDialogProps {
  title: string;
  /** Label above the text field. */
  label: string;
  open: boolean;
  initial?: string;
  okLabel?: string;
  /** Return an error message to keep the dialog open. */
  validate?: (value: string) => string | null;
  onOk: (value: string) => void;
  onCancel: () => void;
  testId?: string;
}

/** Single-line text input dialog (Create Group..., Rename..., Find and Open File...). Enter = OK, Esc = Cancel. */
export function PromptDialog({ title, label, open, initial = '', okLabel = 'OK', validate, onOk, onCancel, testId }: PromptDialogProps) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  useResetOnOpen(open, () => {
    setValue(initial);
    setError(null);
  });
  const field = useSelectOnOpen(open);
  const ok = () => {
    const e = validate?.(value) ?? null;
    if (e) {
      setError(e);
      return;
    }
    onOk(value);
  };
  return (
    <Dialog
      title={title}
      open={open}
      onClose={onCancel}
      width={360}
      testId={testId}
      buttons={
        <>
          <Button isDefault onClick={ok} testId={testId && `${testId}-ok`}>
            {okLabel}
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </>
      }
    >
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {label}
        <input
          ref={field}
          className="cw-field"
          autoFocus
          value={value}
          aria-label={label}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              ok();
            }
          }}
        />
      </label>
      {error && <div style={{ color: 'var(--cw-changed)', marginTop: 4 }}>{error}</div>}
    </Dialog>
  );
}

// ------------------------------------------------------------------------------------------------ checkbox
// added by the IDE shell track

export function Checkbox({ label, checked, onChange, disabled, title, testId }: { label: ReactNode; checked: boolean; onChange?: (v: boolean) => void; disabled?: boolean; title?: string; testId?: string }) {
  return (
    <label className={`cw-check${disabled ? ' disabled' : ''}`} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} data-testid={testId} />
      <span>{label}</span>
    </label>
  );
}
