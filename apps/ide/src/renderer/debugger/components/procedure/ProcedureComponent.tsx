/**
 * hiwave "Procedure" component (docs/research/r1/ide.md §6 Procedure): the call chain, newest on top, refreshed on
 * every halt from `debug.callStack`. Double-click a frame (or pop-up Show Location) shows its location in Source and
 * Assembly. Menu: Show Values, Show Types.
 * UNCERTAIN: assembly programs carry no frame information; the engine currently reports only the current procedure.
 */
import { useEffect, useMemo, useState } from 'react';
import type { FrameInfo } from '../../../../shared/api';
import { addr } from '../../../common/format';
import { ContextMenu, type ContextMenuState } from '../../../common/menu/MenuBar';
import type { MenuEntry } from '../../../common/menu/model';
import { useDebugSnapshot, useS12 } from '../../../common/s12';
import { useComponentHost, useComponentMenu, useUiCommands, type DebuggerComponentProps } from '../contract';
import { showLocation, useDebuggerBus } from '../../shell/bus';

const attrOn = (attrs: readonly { name: string; value: string }[], name: string, def: boolean) => {
  const v = attrs.find((a) => a.name.toUpperCase() === name)?.value;
  return v === undefined ? def : !/^(off|0|false)$/i.test(v.trim());
};

/** One row as hiwave prints it: `main ( )` (+ location when "Show Values" is on). */
export function frameText(f: FrameInfo, showValues: boolean): string {
  const base = /^0x/i.test(f.name) ? f.name : `${f.name} ( )`;
  if (!showValues) return base;
  const where = f.source ? `${f.source.file.split(/[\\/]/).pop()}:${f.source.line}` : addr(f.pc);
  return `${base}    ${where}`;
}

export function ProcedureComponent({ attributes }: DebuggerComponentProps) {
  const s12 = useS12();
  const host = useComponentHost();
  const bus = useDebuggerBus();
  const snap = useDebugSnapshot();
  const [frames, setFrames] = useState<FrameInfo[]>([]);
  const [sel, setSel] = useState(0);
  const [values, setValues] = useState(() => attrOn(attributes, 'VALUES', true));
  // UNCERTAIN: hiwave's Show Types adds parameter types to each frame; assembly procedures have no parameters and the
  // contract's FrameInfo carries no type information, so the toggle only round-trips the TYPES layout attribute.
  const [types, setTypes] = useState(() => attrOn(attributes, 'TYPES', false));
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const halted = snap.state === 'halted';
  const haltKey = halted ? `${snap.halt?.cycles ?? ''}:${snap.registers?.PC ?? ''}` : null;

  useEffect(() => {
    if (!haltKey) return;
    let live = true;
    void Promise.resolve(s12.debug.callStack()).then(
      (f) => {
        if (!live) return;
        setFrames(Array.isArray(f) ? f : []);
        setSel(0);
      },
      () => live && setFrames([]),
    );
    return () => {
      live = false;
    };
  }, [s12, haltKey]);

  useEffect(() => {
    if (snap.state === 'none') setFrames([]);
  }, [snap.state]);

  useEffect(() => {
    host.setHeadline(frames[sel] ? frames[sel].name : '');
  }, [host, frames, sel]);

  useEffect(() => {
    bus.setAttributes([
      { name: 'VALUES', value: values ? 'on' : 'off' },
      { name: 'TYPES', value: types ? 'on' : 'off' },
    ]);
  }, [bus, values, types]);

  useUiCommands((c) => {
    const kw = c.keyword.toUpperCase();
    if (kw === 'SPROC') {
      const lvl = parseInt(c.argText.trim(), 10);
      if (Number.isFinite(lvl) && frames[lvl]) {
        setSel(lvl);
        showLocation(bus, frames[lvl].pc);
      }
    } else if (kw === 'ATTRIBUTES') {
      const v = /VALUES\s+(\w+)/i.exec(c.argText);
      const t = /TYPES\s+(\w+)/i.exec(c.argText);
      if (v) setValues(!/off/i.test(v[1]));
      if (t) setTypes(!/off/i.test(t[1]));
    }
  });

  const compMenu = useMemo<MenuEntry[]>(
    () => [
      { id: 'procedure.values', label: 'Show &Values', checked: values, onSelect: () => setValues((v) => !v) },
      { id: 'procedure.types', label: 'Show &Types', checked: types, onSelect: () => setTypes((v) => !v) },
    ],
    [values, types],
  );
  useComponentMenu(compMenu);

  if (!snap.registers) return <div className="cw-placeholder">No application loaded</div>;

  return (
    <div className="s12-code cw-mono" data-testid="procedure-component" tabIndex={0}>
      {snap.state === 'running' && frames.length === 0 && <div className="cw-placeholder">Running...</div>}
      {frames.map((f, i) => (
        <div
          key={`${f.level}:${f.pc}`}
          className={`s12-code-line${i === sel ? ' sel' : ''}`}
          data-testid={`proc-frame-${i}`}
          onMouseDown={() => setSel(i)}
          onDoubleClick={() => showLocation(bus, f.pc)}
          onContextMenu={(e) => {
            e.preventDefault();
            setSel(i);
            setMenu({ x: e.clientX, y: e.clientY, items: [{ id: 'proc.showLoc', label: 'Show &Location', onSelect: () => showLocation(bus, f.pc) }] });
          }}
          title={addr(f.pc)}
        >
          <span style={{ paddingLeft: 4 }}>{frameText(f, values)}</span>
        </div>
      ))}
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
