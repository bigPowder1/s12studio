/**
 * CodeWarrior "Errors & Warnings" window (View > Errors & Warnings Window; opens after Make when there are messages;
 * ide.md §5). Layout, top to bottom:
 *   caption | toolbar: Errors / Warnings / Messages filter toggles with counts, previous/next | message list (icon +
 *   "Error   : A1104: text" + "main.asm line 42") | source pane with the message's line in context.
 * Double-click or Enter jumps to the file and line in the editor (`editor.open`); F4 / Shift+F4 go to the next /
 * previous message with a location.
 * UNCERTAIN (ide.md: from memory): the toggle-button-with-count toolbar and the lower source pane.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useS12, useS12Event } from '../../common/s12';
import type { BuildMessageInfo, BuildSeverity } from '../../../shared/api';
import { runIdeCommand, useIdeCommand } from '../commands';
import './errors.css';

const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);

/** The two display lines of a message ("Error   : A1104: ..." and "main.asm line 42"). */
export function messageLines(m: BuildMessageInfo): [string, string] {
  const lines = (m.display ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const kind = m.severity === 'error' ? 'Error' : m.severity === 'warning' ? 'Warning' : 'Information';
  const first = lines[0] ?? `${kind.padEnd(8)}: ${m.code ? `${m.code}: ` : ''}${m.text}`;
  const where = lines.slice(1).join(' ') || (m.file ? (m.line ? `${baseName(m.file)} line ${m.line}` : baseName(m.file)) : '');
  return [first, where];
}

export interface ErrorsFilter {
  error: boolean;
  warning: boolean;
  information: boolean;
}

export const ALL_MESSAGES: ErrorsFilter = { error: true, warning: true, information: true };

export function countBySeverity(ms: readonly BuildMessageInfo[]): Record<BuildSeverity, number> {
  const c = { error: 0, warning: 0, information: 0 };
  for (const m of ms) c[m.severity]++;
  return c;
}

/** Index (into `visible`) of the next/previous message that has a file location, wrapping around. */
export function stepMessage(visible: readonly BuildMessageInfo[], from: number, dir: 1 | -1): number {
  const n = visible.length;
  if (!n) return -1;
  for (let k = 1; k <= n; k++) {
    const i = (((from < 0 ? (dir > 0 ? -1 : 0) : from) + dir * k) % n + n) % n;
    if (visible[i].file) return i;
  }
  return -1;
}

export function SeverityIcon({ severity }: { severity: BuildSeverity }) {
  if (severity === 'error')
    return (
      <svg width={16} height={16} viewBox="0 0 16 16" role="img" aria-label="Error">
        <circle cx="8" cy="8" r="7" fill="#e00000" stroke="#7a0000" />
        <path d="M5 5l6 6M11 5l-6 6" stroke="#fff" strokeWidth={2} />
      </svg>
    );
  if (severity === 'warning')
    return (
      <svg width={16} height={16} viewBox="0 0 16 16" role="img" aria-label="Warning">
        <path d="M8 1l7 14H1z" fill="#ffd700" stroke="#806000" />
        <rect x="7.2" y="5.5" width="1.6" height="5" fill="#000" />
        <rect x="7.2" y="11.5" width="1.6" height="1.6" fill="#000" />
      </svg>
    );
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" role="img" aria-label="Message">
      <circle cx="8" cy="8" r="7" fill="#2050d0" stroke="#102870" />
      <rect x="7.1" y="7" width="1.8" height="5" fill="#fff" />
      <rect x="7.1" y="4" width="1.8" height="1.8" fill="#fff" />
    </svg>
  );
}

// ------------------------------------------------------------------------------------------------ presentational list

export interface ErrorsListProps {
  messages: readonly BuildMessageInfo[];
  filter?: ErrorsFilter;
  onFilterChange?: (f: ErrorsFilter) => void;
  /** Jump to a message's location (double-click, Enter, next/previous). */
  onJump: (m: BuildMessageInfo) => void;
  /** Source text for the context pane (null = unavailable). */
  readSource?: (path: string) => Promise<string | null>;
  /** Imperative next/previous trigger: increments run the step (F4 handled by the connected window). */
  stepRequest?: { dir: 1 | -1; n: number };
}

export function ErrorsList({ messages, filter = ALL_MESSAGES, onFilterChange, onJump, readSource, stepRequest }: ErrorsListProps) {
  const counts = useMemo(() => countBySeverity(messages), [messages]);
  const visible = useMemo(() => messages.filter((m) => filter[m.severity]), [messages, filter]);
  // UNCERTAIN (final fidelity F14): CodeWarrior selects the first message of a new list, so the source pane shows it
  // without a click; F4 (next message) then goes to that first message.
  const [sel, setSel] = useState(() => (visible.length ? 0 : -1));
  const autoSelected = useRef(visible.length > 0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSel((s) => (s >= visible.length ? -1 : s));
  }, [visible]);
  // a new message list (rebuild) starts on its first message: the old row number would point at another message
  // (reset during render, so the stale row never reaches the source pane)
  const [listOf, setListOf] = useState(messages);
  if (listOf !== messages) {
    setListOf(messages);
    setSel(visible.length ? 0 : -1);
    autoSelected.current = visible.length > 0;
  }

  const select = useCallback(
    (i: number, jump = false) => {
      autoSelected.current = false;
      setSel(i);
      const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${i}"]`);
      row?.scrollIntoView?.({ block: 'nearest' });
      if (jump && visible[i]?.file) onJump(visible[i]);
    },
    [visible, onJump],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      const i = stepMessage(visible, autoSelected.current ? -1 : sel, dir);
      if (i >= 0) select(i, true);
    },
    [visible, sel, select],
  );

  const lastStep = useRef(stepRequest?.n ?? 0);
  useEffect(() => {
    if (!stepRequest || stepRequest.n === lastStep.current) return;
    lastStep.current = stepRequest.n;
    step(stepRequest.dir);
  }, [stepRequest, step]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') select(Math.min(visible.length - 1, sel + 1));
    else if (e.key === 'ArrowUp') select(Math.max(0, sel - 1));
    else if (e.key === 'Home') select(0);
    else if (e.key === 'End') select(visible.length - 1);
    else if (e.key === 'Enter' && sel >= 0) onJump(visible[sel]);
    else return;
    e.preventDefault();
  };

  const toggle = (k: BuildSeverity) => onFilterChange?.({ ...filter, [k]: !filter[k] });
  const selected = sel >= 0 ? visible[sel] : undefined;

  return (
    <div className="s12-errors-body">
      <div className="s12-errors-toolbar" role="toolbar">
        {(
          [
            ['error', 'Errors'],
            ['warning', 'Warnings'],
            ['information', 'Messages'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`s12-errors-toggle${filter[k] ? ' pressed' : ''}`}
            aria-pressed={filter[k]}
            title={`Show ${label}`}
            onClick={() => toggle(k)}
            data-testid={`errors-filter-${k}`}
          >
            <SeverityIcon severity={k} />
            <span>{counts[k]}</span>
          </button>
        ))}
        <span className="s12-errors-sep" />
        <button type="button" className="s12-errors-toggle" title="Previous message (Shift+F4)" onClick={() => step(-1)} disabled={!visible.length} data-testid="errors-prev">
          {'▲'}
        </button>
        <button type="button" className="s12-errors-toggle" title="Next message (F4)" onClick={() => step(1)} disabled={!visible.length} data-testid="errors-next">
          {'▼'}
        </button>
        <span className="s12-errors-summary" data-testid="errors-summary">
          {counts.error} error{counts.error === 1 ? '' : 's'}, {counts.warning} warning{counts.warning === 1 ? '' : 's'}
          {counts.information ? `, ${counts.information} message${counts.information === 1 ? '' : 's'}` : ''}
        </span>
      </div>
      <div className="s12-errors-list cw-sunken" role="listbox" tabIndex={0} ref={listRef} onKeyDown={onKeyDown} aria-label="Errors and warnings" data-testid="errors-list">
        {visible.map((m, i) => {
          const [first, where] = messageLines(m);
          return (
            <div
              key={i}
              role="option"
              aria-selected={i === sel}
              data-index={i}
              className={`s12-errors-row${i === sel ? ' selected' : ''}`}
              onMouseDown={() => select(i)}
              onDoubleClick={(e: ReactMouseEvent) => {
                e.preventDefault();
                onJump(m);
              }}
              data-testid="errors-row"
              data-severity={m.severity}
            >
              <span className="s12-errors-icon">
                <SeverityIcon severity={m.severity} />
              </span>
              <span className="s12-errors-text">
                <span>{first}</span>
                {where && <span className="s12-errors-where">{where}</span>}
              </span>
            </div>
          );
        })}
        {!visible.length && <div className="s12-errors-none">{messages.length ? 'All messages are filtered out' : 'No errors or warnings'}</div>}
      </div>
      <SourceContext message={selected} readSource={readSource} epoch={messages} />
    </div>
  );
}

/**
 * Lower pane: the selected message's source line with a few lines of context. The file text is cached per message
 * list (`epoch`): a rebuild produces a new list, so the pane re-reads the file the new messages refer to.
 */
function SourceContext({ message, readSource, epoch }: { message?: BuildMessageInfo; readSource?: (path: string) => Promise<string | null>; epoch?: unknown }) {
  const [text, setText] = useState<{ path: string; epoch: unknown; text: string | null } | null>(null);
  const file = message?.file;
  const cached = !!text && text.path === file && text.epoch === epoch;
  useEffect(() => {
    if (!file || !readSource || cached) return;
    let live = true;
    void readSource(file).then((t) => {
      if (live) setText({ path: file, epoch, text: t });
    });
    return () => {
      live = false;
    };
  }, [file, readSource, cached, epoch]);
  const curRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    curRef.current?.scrollIntoView?.({ block: 'center' });
  }, [message, text]);
  if (!message?.file || !message.line || !text || !cached || text.text === null) return <div className="s12-errors-source cw-sunken cw-mono" data-testid="errors-source" />;
  const lines = text.text.split('\n');
  const from = Math.max(1, message.line - 3);
  const to = Math.min(lines.length, message.line + 3);
  const rows = [];
  for (let l = from; l <= to; l++)
    rows.push(
      <div key={l} ref={l === message.line ? curRef : undefined} className={l === message.line ? 's12-errors-source-line current' : 's12-errors-source-line'}>
        {lines[l - 1] || ' '}
      </div>,
    );
  return (
    <div className="s12-errors-source cw-sunken cw-mono" data-testid="errors-source">
      {rows}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ connected window

let stepper: ((dir: 1 | -1) => void) | null = null;

/** Next / previous build message with a location (F4 / Shift+F4); opens the window when needed. */
export function nextBuildMessage(): void {
  stepper?.(1);
}
export function previousBuildMessage(): void {
  stepper?.(-1);
}

export interface ErrorsWindowProps {
  /** Override the jump (default: `editor.open` IDE command with path/line/column). */
  onJump?: (m: BuildMessageInfo) => void;
  /** Start open (tests / previews). */
  initiallyOpen?: boolean;
}

export function ErrorsWindow({ onJump, initiallyOpen = false }: ErrorsWindowProps) {
  const s12 = useS12();
  const [open, setOpen] = useState(initiallyOpen);
  const [messages, setMessages] = useState<BuildMessageInfo[]>([]);
  const [filter, setFilter] = useState<ErrorsFilter>(ALL_MESSAGES);
  const [height, setHeight] = useState(200);
  const [stepReq, setStepReq] = useState<{ dir: 1 | -1; n: number }>({ dir: 1, n: 0 });
  const live = useRef(false);

  // restore the last build's messages (window reopened / renderer reloaded)
  useEffect(() => {
    let alive = true;
    void Promise.resolve(s12.build.lastResult())
      .then((r) => {
        if (alive && r && !live.current) setMessages(r.messages);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [s12]);

  useS12Event('build', 'started', () => {
    live.current = true;
    setMessages([]);
  });
  useS12Event('build', 'message', (m) => setMessages((ms) => [...ms, m]));
  useS12Event('build', 'finished', (r) => {
    live.current = true;
    setMessages(r.messages);
  });
  useIdeCommand('errors.show', () => setOpen(true));

  const jump = useCallback(
    (m: BuildMessageInfo) => {
      if (!m.file) return;
      if (onJump) onJump(m);
      else runIdeCommand('editor.open', { path: m.file, line: m.line, column: m.column });
    },
    [onJump],
  );

  const readSource = useCallback((p: string) => Promise.resolve(s12.files.readText(p)).then((f) => f?.text ?? null, () => null), [s12]);

  // F4 / Shift+F4
  useEffect(() => {
    stepper = (dir) => {
      setOpen(true);
      setStepReq((r) => ({ dir, n: r.n + 1 }));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F4' || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (!messages.length) return;
      e.preventDefault();
      stepper?.(e.shiftKey ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      stepper = null;
    };
  }, [messages.length]);

  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = height;
    const move = (ev: MouseEvent) => setHeight(Math.max(90, Math.min(window.innerHeight - 120, h0 + (y0 - ev.clientY))));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // Closed = hidden, not unmounted: the list keeps its selection, and F4 pressed while the window is closed both
  // opens it and steps in the same render (an unmounted list would treat that step request as already handled).
  return (
    <div className="s12-errors-window" style={{ height, display: open ? undefined : 'none' }} aria-hidden={!open} data-testid={open ? 'errors-window' : 'errors-window-closed'}>
      <div className="s12-errors-resize" onMouseDown={startResize} />
      <div className="cw-caption active">
        <span style={{ flex: 1 }}>Errors &amp; Warnings</span>
        <button type="button" className="cw-tool-btn" style={{ height: 14, minWidth: 16 }} onClick={() => setOpen(false)} aria-label="Close">
          {'×'}
        </button>
      </div>
      <ErrorsList messages={messages} filter={filter} onFilterChange={setFilter} onJump={jump} readSource={readSource} stepRequest={stepReq} />
    </div>
  );
}
