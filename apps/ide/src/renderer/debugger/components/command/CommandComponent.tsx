/**
 * hiwave "Command" component (docs/research/r1/ide.md §6 Command): output with command echo blue, responses black,
 * errors red, FCS warnings green; `in>` prompt; history (Up/Down or F3, 10 entries); Esc clears the line;
 * PgUp/PgDn scroll; menu Execute File..., Copy, Paste, Cache Size..., Clear. Commands run through `debug.exec`
 * (the @s12/debug hiwave interpreter: BS, BC, G, S, T, P, RD, RS, DB, WB, MEM, DASM, LOAD, CF, ...).
 *
 * The output is a selectable DOM text list rather than xterm.js: hiwave's Command window is an edit control (mouse
 * selection, Ctrl+C), not a terminal; CSS colours come from the theme tokens and the list is testable in jsdom.
 * Output is buffered from window load (outputBuffer.ts) so STARTUP/POSTLOAD output shows even before mounting.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseApiError, type OutputLineInfo } from '../../../../shared/api';
import { ContextMenu, type ContextMenuState } from '../../../common/menu/MenuBar';
import { SEP, type MenuEntry } from '../../../common/menu/model';
import { useS12 } from '../../../common/s12';
import { DialogLayer, inDialog } from '../../dialogs/DialogLayer';
import { PromptDialog, intRange } from '../../dialogs/PromptDialog';
import { DND_MIME, getDnd, useComponentHost, useComponentMenu, useUiCommands, type DebuggerComponentProps } from '../contract';
import { outputBufferFor, useOutputLines } from './outputBuffer';

export const OUTPUT_COLORS: Record<OutputLineInfo['kind'], string | undefined> = { echo: 'var(--cw-cmd-echo)', normal: undefined, error: 'var(--cw-cmd-error)', warning: 'var(--cw-cmd-warning)' };
export const HISTORY_SIZE = 10;

/** Command history: newest first, no duplicates, HISTORY_SIZE entries. */
export function pushHistory(hist: readonly string[], line: string): string[] {
  return [line, ...hist.filter((h) => h !== line)].slice(0, HISTORY_SIZE);
}

const cacheSizeOf = (attrs: readonly { name: string; value: string }[]): number | undefined => {
  const a = attrs.find((x) => x.name.toUpperCase() === 'CACHESIZE');
  const n = a ? parseInt(a.value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    document.execCommand?.('copy');
  }
}

export function CommandComponent({ attributes }: DebuggerComponentProps) {
  const s12 = useS12();
  const host = useComponentHost();
  const buffer = outputBufferFor(s12);
  const lines = useOutputLines(s12);
  const [input, setInput] = useState('');
  const [hist, setHist] = useState<string[]>([]);
  const histPos = useRef(-1);
  const [busy, setBusy] = useState(0);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [cacheDialog, setCacheDialog] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const n = cacheSizeOf(attributes);
    if (n) buffer.setCacheSize(n);
  }, [attributes, buffer]);
  useUiCommands((c) => {
    if (c.keyword.toUpperCase() === 'ATTRIBUTES') {
      const n = cacheSizeOf(c.argText.split(',').map((p) => ({ name: p.trim().split(/\s+/)[0] ?? '', value: p.trim().split(/\s+/)[1] ?? '' })));
      if (n) buffer.setCacheSize(n);
    }
  });

  // keep the newest output (and the prompt) visible unless the user scrolled up
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines, busy]);

  useEffect(() => {
    host.setHeadline(busy ? 'Command Component is busy' : '');
  }, [host, busy]);

  const run = useCallback(
    async (line: string) => {
      setBusy((b) => b + 1);
      stick.current = true;
      try {
        await s12.debug.exec(line);
      } catch (e) {
        buffer.push([{ text: parseApiError(e).message, kind: 'error' }]);
      } finally {
        setBusy((b) => b - 1);
      }
    },
    [s12, buffer],
  );

  const executeFile = useCallback(async () => {
    const [p] = await s12.files.openDialog({ title: 'Execute Command File', filters: [{ name: 'Command files', extensions: ['cmd', 'txt'] }, { name: 'All files', extensions: ['*'] }] });
    if (!p) return;
    setBusy((b) => b + 1);
    try {
      await s12.debug.execFile(p);
    } catch (e) {
      buffer.push([{ text: parseApiError(e).message, kind: 'error' }]);
    } finally {
      setBusy((b) => b - 1);
    }
  }, [s12, buffer]);

  const copy = useCallback(() => {
    const sel = window.getSelection()?.toString() ?? '';
    void copyText(sel || buffer.get().map((l) => l.text).join('\n'));
  }, [buffer]);
  const paste = useCallback(async () => {
    try {
      const t = await navigator.clipboard.readText();
      setInput((cur) => cur + t.replace(/\r?\n/g, ' '));
    } catch {
      // UNCERTAIN: the sandboxed renderer may be refused clipboard-read; Ctrl+V in the prompt always works
      inputRef.current?.focus();
    }
  }, []);

  const items = useMemo<MenuEntry[]>(
    () => [
      { id: 'command.executeFile', label: '&Execute File...', onSelect: () => void executeFile() },
      SEP,
      { id: 'command.copy', label: '&Copy', shortcut: 'Ctrl+C', onSelect: copy },
      { id: 'command.paste', label: '&Paste', shortcut: 'Ctrl+V', onSelect: () => void paste() },
      SEP,
      { id: 'command.cacheSize', label: 'Cache &Size...', onSelect: () => setCacheDialog(true) },
      { id: 'command.clear', label: 'C&lear', onSelect: () => buffer.clear() },
    ],
    [executeFile, copy, paste, buffer],
  );
  useComponentMenu(items);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const el = scrollRef.current;
    if (e.key === 'Enter') {
      const line = input;
      if (line.trim()) setHist((h) => pushHistory(h, line.trim()));
      histPos.current = -1;
      setInput('');
      if (line.trim()) void run(line.trim());
    } else if (e.key === 'ArrowUp' || e.key === 'F3') {
      if (!hist.length) return;
      histPos.current = Math.min(hist.length - 1, histPos.current + 1);
      setInput(hist[histPos.current] ?? '');
    } else if (e.key === 'ArrowDown') {
      histPos.current = Math.max(-1, histPos.current - 1);
      setInput(histPos.current < 0 ? '' : hist[histPos.current]);
    } else if (e.key === 'Escape') {
      histPos.current = -1;
      setInput('');
    } else if (e.key === 'PageUp' && el) {
      el.scrollTop -= el.clientHeight;
      stick.current = false;
    } else if (e.key === 'PageDown' && el) {
      el.scrollTop += el.clientHeight;
    } else return;
    e.preventDefault();
  };

  return (
    <div
      ref={scrollRef}
      className="cw-mono"
      style={{ background: 'var(--cw-window)', height: '100%', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', padding: 2, userSelect: 'text' }}
      data-testid="command-component"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      }}
      onMouseUp={(e) => {
        // click (not a selection) focuses the prompt, like hiwave; clicks in the Cache Size dialog stay there
        if (inDialog(e.target)) return;
        if (!window.getSelection()?.toString()) inputRef.current?.focus();
      }}
      onContextMenu={(e) => {
        if (inDialog(e.target)) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, items });
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DND_MIME)) e.preventDefault();
      }}
      onDrop={(e) => {
        // hiwave: dropping from another component appends its address/range to the command line
        const p = getDnd(e);
        if (!p) return;
        e.preventDefault();
        const text =
          p.kind === 'range' ? `0x${p.start.toString(16).toUpperCase()}..0x${p.end.toString(16).toUpperCase()}` : p.kind === 'address' ? `0x${p.address.toString(16).toUpperCase()}` : p.kind === 'register' ? p.name : p.expression;
        setInput((cur) => (cur && !cur.endsWith(' ') ? `${cur} ` : cur) + text);
        inputRef.current?.focus();
      }}
    >
      {lines.map((l) => (
        <div key={l.id} className={`cmd-line cmd-${l.kind}`} style={{ color: OUTPUT_COLORS[l.kind] }}>
          {l.text || ' '}
        </div>
      ))}
      <div style={{ display: 'flex' }}>
        <span>in&gt;</span>
        <input
          ref={inputRef}
          aria-label="Command"
          className="cw-mono"
          spellCheck={false}
          autoComplete="off"
          style={{ flex: 1, border: 'none', outline: 'none', padding: 0, marginLeft: 2, background: 'transparent', color: 'var(--cw-window-text)' }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
      <DialogLayer>
        <PromptDialog
          open={cacheDialog}
          title="Cache Size"
          label="Number of lines:"
          initial={String(buffer.cacheSize)}
          validate={intRange(10, 100000)}
          onOk={(t) => buffer.setCacheSize(Number(t))}
          onClose={() => setCacheDialog(false)}
        />
      </DialogLayer>
    </div>
  );
}
