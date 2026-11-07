/**
 * hiwave "Register" component (docs/research/r1/ide.md §6 Register): CPU registers A B D IX IY PC SP, CCRW with the
 * S X H I N Z V C bits as toggleable letters (set = dark, clear = grey) and IPL, PPAGE/GPAGE/RPAGE/EPAGE.
 * Values that changed since the previous halt are red (not the CCR bits). Double-click a value to edit it in place:
 * Enter commits, Esc cancels, Tab commits and moves to the next register. Menu: Hex, Bin, Oct, Dec, UDec, Auto,
 * Bit Reverse. Info bar: "HC12  CPU Cycles: N" and the format.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseApiError, type RegisterName } from '../../../../shared/api';
import type { MenuEntry } from '../../../common/menu/model';
import { ContextMenu, type ContextMenuState } from '../../../common/menu/MenuBar';
import { useDebugSnapshot, usePreviousHaltSnapshot, useS12 } from '../../../common/s12';
import { setDnd, useComponentHost, useComponentMenu, useUiCommands, type DebuggerComponentProps } from '../contract';
import { useDebuggerBus } from '../../shell/bus';
import { CCR_BITS, changedRegisters, formatFromAttr, formatReg, parseReg, REG_FORMATS, REGISTERS, valueWidthCh, type RegDef, type RegFormat } from './model';

const attrValue = (attrs: readonly { name: string; value: string }[], name: string) => attrs.find((a) => a.name.toUpperCase() === name)?.value;

export function RegisterComponent({ attributes }: DebuggerComponentProps) {
  const s12 = useS12();
  const host = useComponentHost();
  const bus = useDebuggerBus();
  const snap = useDebugSnapshot();
  const prev = usePreviousHaltSnapshot();
  const [fmt, setFmt] = useState<RegFormat>(() => formatFromAttr(attrValue(attributes, 'FORMAT')));
  const [editing, setEditing] = useState<RegisterName | null>(null);
  const r = snap.registers;
  const running = snap.state === 'running';

  const menu = useMemo<MenuEntry[]>(() => REG_FORMATS.map((f) => ({ id: `register.format.${f.id}`, label: f.label, checked: fmt === f.id, onSelect: () => setFmt(f.id) })), [fmt]);
  useComponentMenu(menu);
  // hiwave's Register pop-up offers the same Format items as the component menu (final fidelity F10)
  const [popup, setPopup] = useState<ContextMenuState | null>(null);

  useUiCommands((c) => {
    if (c.keyword.toUpperCase() === 'ATTRIBUTES') {
      const m = /FORMAT\s+(\w+)/i.exec(c.argText);
      if (m) setFmt(formatFromAttr(m[1]));
    }
  });

  useEffect(() => {
    bus.setAttributes([
      { name: 'FORMAT', value: REG_FORMATS.find((f) => f.id === fmt)!.attr },
      { name: 'COMPLEMENT', value: attrValue(attributes, 'COMPLEMENT') ?? 'None' },
    ]);
  }, [bus, fmt, attributes]);

  useEffect(() => {
    host.setHeadline(r ? `HC12  CPU Cycles: ${snap.cycles}\t${fmt === 'auto' ? 'Auto' : REG_FORMATS.find((f) => f.id === fmt)!.label.replace('&', '')}` : '');
  }, [host, r, snap.cycles, fmt]);

  const changed = useMemo(() => changedRegisters(r, prev?.registers), [r, prev]);

  const write = (name: RegisterName, value: number) => {
    void s12.debug.writeRegister(name, value).catch((e) => bus.status(parseApiError(e).message));
  };

  if (!r) return <div className="cw-placeholder">No application loaded</div>;

  const editable = REGISTERS.map((d) => d.name);
  const next = (name: RegisterName) => editable[(editable.indexOf(name) + 1) % editable.length];

  const cell = (d: RegDef) => {
    const v = r[d.name];
    return (
      <div key={d.name} className="s12-reg" data-reg={d.name}>
        <span className="s12-reg-name">{d.label}</span>
        {editing === d.name ? (
          <RegEdit
            def={d}
            initial={formatReg(v, fmt, d.bits)}
            fmt={fmt}
            onCommit={(value, tab) => {
              if (value !== null) write(d.name, value);
              setEditing(tab ? next(d.name) : null);
            }}
            onCancel={() => setEditing(null)}
            onInvalid={(t) => bus.status(`Invalid value: ${t}`)}
          />
        ) : (
          <span
            className={`s12-reg-value${changed.has(d.name) ? ' changed' : ''}`}
            data-testid={`reg-${d.name}`}
            data-changed={changed.has(d.name) || undefined}
            title={`${d.label} = ${formatReg(v, 'hex', d.bits)}h (${v})`}
            draggable
            onDragStart={(e) => setDnd(e, { kind: 'register', name: d.name, value: v, source: 'Register' })}
            onDoubleClick={() => !running && setEditing(d.name)}
          >
            {formatReg(v, fmt, d.bits)}
          </span>
        )}
      </div>
    );
  };

  return (
    // columns sized in ch from the widest value of the format, so they scale with the font (FONT / Component > Fonts)
    <div
      className="s12-regs cw-mono"
      data-testid="register-component"
      style={{ ['--reg-val-ch' as string]: valueWidthCh(fmt) } as React.CSSProperties}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('input')) return;
        e.preventDefault();
        setPopup({ x: e.clientX, y: e.clientY, items: menu });
      }}
    >
      <div className="s12-reg-grid">{REGISTERS.filter((d) => d.name !== 'CCRW' && d.name !== 'IPL').map(cell)}</div>
      <div className="s12-reg" style={{ marginTop: 2 }} data-reg="CCR">
        <span className="s12-reg-name">CCR</span>
        {CCR_BITS.map((b, i) => {
          const mask = 0x80 >> i;
          const on = (r.CCR & mask) !== 0;
          return (
            <span
              key={b}
              className={`s12-ccr-bit${on ? '' : ' clear'}`}
              data-testid={`ccr-${b}`}
              aria-pressed={on}
              title={`${b} = ${on ? 1 : 0} (double-click toggles)`}
              onDoubleClick={() => !running && write('CCR', r.CCR ^ mask)}
            >
              {b}
            </span>
          );
        })}
      </div>
      <div className="s12-reg-grid">{REGISTERS.filter((d) => d.name === 'CCRW' || d.name === 'IPL').map(cell)}</div>
      <ContextMenu state={popup} onClose={() => setPopup(null)} />
    </div>
  );
}

function RegEdit({ def, initial, fmt, onCommit, onCancel, onInvalid }: { def: RegDef; initial: string; fmt: RegFormat; onCommit: (v: number | null, tab: boolean) => void; onCancel: () => void; onInvalid: (t: string) => void }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  // set once committed/cancelled: a blur caused by the unmount (Tab moves on) must not cancel the next edit
  const done = useRef(false);
  useEffect(() => {
    ref.current?.select();
  }, []);
  const commit = (tab: boolean) => {
    const v = parseReg(text, fmt, def.bits);
    if (v === null) {
      onInvalid(text);
      return;
    }
    done.current = true;
    onCommit(v, tab);
  };
  return (
    <input
      ref={ref}
      className="s12-reg-edit cw-mono"
      value={text}
      aria-label={`${def.label} value`}
      data-testid={`reg-edit-${def.name}`}
      autoFocus
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (!done.current) {
          done.current = true;
          onCancel();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(false);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          done.current = true;
          onCancel();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          commit(true);
        }
      }}
    />
  );
}
