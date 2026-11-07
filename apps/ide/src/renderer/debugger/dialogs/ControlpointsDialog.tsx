/**
 * "Controlpoints Configuration" dialog (Run > Control Points...; Memory/Data/Source "Show Breakpoints/Watchpoints").
 * Tabs Breakpoints / Watchpoints / Markpoints. Spec: docs/research/r1/ide.md §6 "Control points".
 *
 * Breakpoints tab: list (check box = enabled, Ctrl/Shift multi-select), "Breakpoint:" (Address, procedure, Disable,
 * Temporary), "Condition:" (expression, Disable), "Command:" (one debugger command, Disable, Continue), "Counter:"
 * (Current, Interval <= 2147483647), Delete / Update / Add. Watchpoints: same with a From..To range and Read / Write /
 * Read-Write. Every change goes through the debug contract (setBreakpoint, updateBreakpoint, removeBreakpoint, ...).
 *
 * UNCERTAIN: hiwave applies list check boxes, Delete and Add immediately and the field edits on Update/OK; Cancel
 * only drops un-applied field edits. "Save & Restore on load" runs `SAVEBP on|off`.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { parseApiError, type BreakpointInfo, type BreakpointSpecInfo, type WatchKind, type WatchpointInfo, type WatchpointSpecInfo } from '../../../shared/api';
import { Button, Dialog, GroupBox, Tabs } from '../../common/controls';
import { useS12 } from '../../common/s12';
import { markpoints, useMarkpoints, type Markpoint } from './markpoints';
import { hexText, resolveAddress } from './resolve';
import { useBreakpoints, useWatchpoints } from './useControlpoints';

export type ControlpointsTab = 'breakpoints' | 'watchpoints' | 'markpoints';

export interface ControlpointsDialogProps {
  open: boolean;
  onClose: () => void;
  initialTab?: ControlpointsTab;
  /** Pre-select this breakpoint/watchpoint id. */
  selectId?: number;
}

const MAX_COUNTER = 2147483647;

// ------------------------------------------------------------------------------------------------ drafts

interface CommonDraft {
  disabled: boolean;
  condition: string;
  conditionDisabled: boolean;
  command: string;
  commandDisabled: boolean;
  commandContinue: boolean;
  current: string;
  interval: string;
}
interface BpDraft extends CommonDraft {
  address: string;
  temporary: boolean;
}
interface WpDraft extends CommonDraft {
  from: string;
  to: string;
  kind: WatchKind;
}

const EMPTY_COMMON: CommonDraft = { disabled: false, condition: '', conditionDisabled: false, command: '', commandDisabled: false, commandContinue: false, current: '', interval: '' };

function commonOf(p: BreakpointInfo | WatchpointInfo): CommonDraft {
  return {
    disabled: !p.enabled,
    condition: p.condition ?? '',
    conditionDisabled: p.conditionEnabled === false,
    command: p.command ?? '',
    commandDisabled: p.commandEnabled === false,
    commandContinue: !!p.commandContinue,
    current: p.counter ? String(p.counter.current) : '',
    interval: p.counter ? String(p.counter.interval) : '',
  };
}

export const bpDraftOf = (b: BreakpointInfo): BpDraft => ({ ...commonOf(b), address: hexText(b.address), temporary: b.temporary });
export const wpDraftOf = (w: WatchpointInfo): WpDraft => ({ ...commonOf(w), from: hexText(w.start), to: hexText(w.end), kind: w.kind });

type CommonPatch = Pick<BreakpointSpecInfo, 'enabled' | 'condition' | 'conditionEnabled' | 'command' | 'commandEnabled' | 'commandContinue' | 'counter'>;

/** Validate the shared groups; returns the patch or an error text. */
export function commonPatch(d: CommonDraft, had?: { counter?: unknown }): CommonPatch | string {
  const command = d.command.trim();
  if (/^(g|go|stop)(\s|$)/i.test(command)) return 'Commands G, GO and STOP are not allowed in a control point';
  const cur = d.current.trim();
  const int = d.interval.trim();
  let counter: CommonPatch['counter'];
  if (cur || int) {
    const c = Number(cur || int);
    const i = Number(int || cur);
    if (!Number.isInteger(c) || !Number.isInteger(i) || c < 1 || i < 1 || c > MAX_COUNTER || i > MAX_COUNTER) return `Counter values must be between 1 and ${MAX_COUNTER}`;
    counter = { current: c, interval: i };
  }
  const p: CommonPatch = {
    enabled: !d.disabled,
    condition: d.condition.trim(),
    conditionEnabled: !d.conditionDisabled,
    command,
    commandEnabled: !d.commandDisabled,
    commandContinue: d.commandContinue,
  };
  if (counter || had?.counter) p.counter = counter;
  return p;
}

// ------------------------------------------------------------------------------------------------ shared field groups

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ whiteSpace: 'nowrap' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

function Field({ label, value, onChange, width }: { label: string; value: string; onChange: (v: string) => void; width?: number }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 4, flex: width ? undefined : 1 }}>
      <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
      <input aria-label={label.replace(/:$/, '')} className="cw-field cw-mono" style={{ width, flex: width ? undefined : 1, minWidth: 0 }} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function CommonGroups<D extends CommonDraft>({ d, set }: { d: D; set: (p: Partial<CommonDraft>) => void }) {
  return (
    <>
      <GroupBox label="Condition:">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Field label="Condition" value={d.condition} onChange={(v) => set({ condition: v })} />
          <Check label="Disable" checked={d.conditionDisabled} onChange={(v) => set({ conditionDisabled: v })} />
        </div>
      </GroupBox>
      <GroupBox label="Command:">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Field label="Command" value={d.command} onChange={(v) => set({ command: v })} />
          <Check label="Disable" checked={d.commandDisabled} onChange={(v) => set({ commandDisabled: v })} />
          <Check label="Continue" checked={d.commandContinue} onChange={(v) => set({ commandContinue: v })} />
        </div>
      </GroupBox>
      <GroupBox label="Counter:">
        <div style={{ display: 'flex', gap: 12 }}>
          <Field label="Current:" value={d.current} onChange={(v) => set({ current: v })} width={90} />
          <Field label="Interval:" value={d.interval} onChange={(v) => set({ interval: v })} width={90} />
        </div>
      </GroupBox>
    </>
  );
}

/** Report-style list with check boxes and multi-selection. */
function PointList<T extends { id: number; enabled: boolean }>({
  items,
  selected,
  onSelect,
  onToggle,
  columns,
  testId,
}: {
  items: T[];
  selected: number[];
  onSelect: (ids: number[], focus: number) => void;
  onToggle: (item: T, enabled: boolean) => void;
  columns: { header: string; width?: number; render: (t: T) => ReactNode }[];
  testId: string;
}) {
  const click = (e: React.MouseEvent, t: T) => {
    if (e.ctrlKey || e.metaKey) onSelect(selected.includes(t.id) ? selected.filter((x) => x !== t.id) : [...selected, t.id], t.id);
    else if (e.shiftKey && selected.length) {
      const a = items.findIndex((x) => x.id === selected[selected.length - 1]);
      const b = items.findIndex((x) => x.id === t.id);
      onSelect(items.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id), t.id);
    } else onSelect([t.id], t.id);
  };
  return (
    <div className="cw-listview cw-sunken" style={{ height: 110, flex: 'none' }} data-testid={testId}>
      <table>
        <colgroup>
          <col style={{ width: 22 }} />
          {columns.map((c) => (
            <col key={c.header} style={{ width: c.width }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th />
            {columns.map((c) => (
              <th key={c.header}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((t) => (
            <tr key={t.id} className={`cw-row${selected.includes(t.id) ? ' selected' : ''}`} data-id={t.id} onMouseDown={(e) => click(e, t)}>
              <td>
                <input type="checkbox" aria-label={`Enable ${t.id}`} checked={t.enabled} onMouseDown={(e) => e.stopPropagation()} onChange={(e) => onToggle(t, e.target.checked)} />
              </td>
              {columns.map((c) => (
                <td key={c.header}>{c.render(t)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const flags = (p: BreakpointInfo | WatchpointInfo): string =>
  [p.condition && p.conditionEnabled !== false ? 'cond' : '', p.counter ? `cnt ${p.counter.current}/${p.counter.interval}` : '', p.command && p.commandEnabled !== false ? 'cmd' : ''].filter(Boolean).join(', ');

// ------------------------------------------------------------------------------------------------ dialog

export function ControlpointsDialog({ open, onClose, initialTab = 'breakpoints', selectId }: ControlpointsDialogProps) {
  const s12 = useS12();
  const bps = useBreakpoints();
  const wps = useWatchpoints();
  const marks = useMarkpoints();
  const [tab, setTab] = useState<ControlpointsTab>(initialTab);
  const [error, setError] = useState<string | null>(null);
  const [saveRestore, setSaveRestore] = useState(true);

  const [bpSel, setBpSel] = useState<number[]>([]);
  const [bpFocus, setBpFocus] = useState<number | null>(null);
  const [bpDraft, setBpDraft] = useState<BpDraft>({ ...EMPTY_COMMON, address: '', temporary: false });
  const [bpDirty, setBpDirty] = useState(false);

  const [wpSel, setWpSel] = useState<number[]>([]);
  const [wpFocus, setWpFocus] = useState<number | null>(null);
  const [wpDraft, setWpDraft] = useState<WpDraft>({ ...EMPTY_COMMON, from: '', to: '', kind: 'readwrite' });
  const [wpDirty, setWpDirty] = useState(false);

  const [mpSel, setMpSel] = useState<number | null>(null);
  const [mpName, setMpName] = useState('');
  const [mpAddr, setMpAddr] = useState('');

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setError(null);
    setBpDirty(false);
    setWpDirty(false);
    if (selectId !== undefined) {
      if (initialTab === 'watchpoints') (setWpSel([selectId]), setWpFocus(selectId));
      else if (initialTab === 'breakpoints') (setBpSel([selectId]), setBpFocus(selectId));
    }
  }, [open, initialTab, selectId]);

  // load the focused item into the fields (unless the user is editing them)
  const bpFocused = useMemo(() => bps.find((b) => b.id === bpFocus), [bps, bpFocus]);
  const wpFocused = useMemo(() => wps.find((w) => w.id === wpFocus), [wps, wpFocus]);
  useEffect(() => {
    if (bpFocused && !bpDirty) setBpDraft(bpDraftOf(bpFocused));
  }, [bpFocused, bpDirty]);
  useEffect(() => {
    if (wpFocused && !wpDirty) setWpDraft(wpDraftOf(wpFocused));
  }, [wpFocused, wpDirty]);

  const fail = (e: unknown) => setError(typeof e === 'string' ? e : parseApiError(e).message);
  const editBp = (p: Partial<BpDraft>) => (setBpDraft((d) => ({ ...d, ...p })), setBpDirty(true));
  const editWp = (p: Partial<WpDraft>) => (setWpDraft((d) => ({ ...d, ...p })), setWpDirty(true));

  // ---- breakpoint actions
  const bpSpec = async (): Promise<BreakpointSpecInfo | string> => {
    const address = await resolveAddress(s12, bpDraft.address);
    if (address === null) return `Invalid address "${bpDraft.address.trim()}"`;
    const c = commonPatch(bpDraft, bpFocused);
    if (typeof c === 'string') return c;
    return { address, temporary: bpDraft.temporary, ...c };
  };
  const bpUpdate = async (): Promise<boolean> => {
    if (!bpFocused) return true;
    const spec = await bpSpec();
    if (typeof spec === 'string') return (fail(spec), false);
    const patch: Partial<BreakpointSpecInfo> = { ...spec };
    if (spec.address === bpFocused.address) delete patch.address;
    try {
      await s12.debug.updateBreakpoint(bpFocused.id, patch);
      setBpDirty(false);
      setError(null);
      return true;
    } catch (e) {
      return (fail(e), false);
    }
  };
  const bpAdd = async () => {
    const spec = await bpSpec();
    if (typeof spec === 'string') return fail(spec);
    try {
      const b = await s12.debug.setBreakpoint(spec);
      setBpDirty(false);
      setBpSel([b.id]);
      setBpFocus(b.id);
      setError(null);
    } catch (e) {
      fail(e);
    }
  };
  const bpDelete = async () => {
    for (const id of bpSel) await s12.debug.removeBreakpoint(id).catch(fail);
    setBpSel([]);
    setBpFocus(null);
    setBpDirty(false);
  };

  // ---- watchpoint actions
  const wpSpec = async (): Promise<WatchpointSpecInfo | string> => {
    const start = await resolveAddress(s12, wpDraft.from);
    if (start === null) return `Invalid address "${wpDraft.from.trim()}"`;
    const end = wpDraft.to.trim() ? await resolveAddress(s12, wpDraft.to) : start;
    if (end === null || end < start) return `Invalid range end "${wpDraft.to.trim()}"`;
    const c = commonPatch(wpDraft, wpFocused);
    if (typeof c === 'string') return c;
    return { start, end, kind: wpDraft.kind, space: wpFocused?.space, ...c };
  };
  const wpUpdate = async (): Promise<boolean> => {
    if (!wpFocused) return true;
    const spec = await wpSpec();
    if (typeof spec === 'string') return (fail(spec), false);
    try {
      await s12.debug.updateWatchpoint(wpFocused.id, spec);
      setWpDirty(false);
      setError(null);
      return true;
    } catch (e) {
      return (fail(e), false);
    }
  };
  const wpAdd = async () => {
    const spec = await wpSpec();
    if (typeof spec === 'string') return fail(spec);
    try {
      const w = await s12.debug.setWatchpoint({ ...spec, space: spec.space ?? 'local' });
      setWpDirty(false);
      setWpSel([w.id]);
      setWpFocus(w.id);
      setError(null);
    } catch (e) {
      fail(e);
    }
  };
  const wpDelete = async () => {
    for (const id of wpSel) await s12.debug.removeWatchpoint(id).catch(fail);
    setWpSel([]);
    setWpFocus(null);
    setWpDirty(false);
  };

  // ---- markpoints
  const mpFocused = marks.find((m) => m.id === mpSel);
  const mpAdd = async () => {
    const a = await resolveAddress(s12, mpAddr);
    if (a === null) return fail(`Invalid address "${mpAddr.trim()}"`);
    const m = markpoints.add({ name: mpName.trim() || hexText(a), address: a, kind: 'memory' });
    setMpSel(m.id);
    setError(null);
  };

  const ok = async () => {
    if (bpDirty && !(await bpUpdate())) return setTab('breakpoints');
    if (wpDirty && !(await wpUpdate())) return setTab('watchpoints');
    onClose();
  };

  const bpTab = (
    <div style={{ display: 'flex', flexDirection: 'column' }} data-testid="cp-breakpoints">
      <PointList
        items={bps}
        selected={bpSel}
        onSelect={(ids, f) => (setBpSel(ids), setBpFocus(f), setBpDirty(false))}
        onToggle={(b, en) => void s12.debug.updateBreakpoint(b.id, { enabled: en }).catch(fail)}
        testId="cp-bp-list"
        columns={[
          { header: 'Address', width: 80, render: (b) => hexText(b.address) },
          { header: 'Name', width: 110, render: (b) => b.label ?? '' },
          { header: 'Type', width: 60, render: (b) => (b.temporary ? 'Temporary' : 'Permanent') },
          { header: 'Info', render: flags },
        ]}
      />
      <GroupBox label="Breakpoint:">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Field label="Address:" value={bpDraft.address} onChange={(v) => editBp({ address: v })} width={110} />
          <span style={{ flex: 1, color: 'var(--cw-gray-text)' }}>{bpFocused?.label ?? ''}</span>
          <Check label="Disable" checked={bpDraft.disabled} onChange={(v) => editBp({ disabled: v })} />
          <Check label="Temporary" checked={bpDraft.temporary} onChange={(v) => editBp({ temporary: v })} />
        </div>
      </GroupBox>
      <CommonGroups d={bpDraft} set={editBp} />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <Check
          label="Save & Restore on load"
          checked={saveRestore}
          onChange={(v) => {
            setSaveRestore(v);
            void s12.debug.exec(`SAVEBP ${v ? 'on' : 'off'}`, { echo: false }).catch(fail);
          }}
        />
        <span style={{ flex: 1 }} />
        <Button onClick={() => void bpDelete()} disabled={!bpSel.length} testId="cp-bp-delete">
          Delete
        </Button>
        <Button onClick={() => void bpUpdate()} disabled={!bpFocused} testId="cp-bp-update">
          Update
        </Button>
        <Button onClick={() => void bpAdd()} testId="cp-bp-add">
          Add
        </Button>
      </div>
    </div>
  );

  const wpTab = (
    <div style={{ display: 'flex', flexDirection: 'column' }} data-testid="cp-watchpoints">
      <PointList
        items={wps}
        selected={wpSel}
        onSelect={(ids, f) => (setWpSel(ids), setWpFocus(f), setWpDirty(false))}
        onToggle={(w, en) => void s12.debug.updateWatchpoint(w.id, { enabled: en }).catch(fail)}
        testId="cp-wp-list"
        columns={[
          { header: 'Range', width: 130, render: (w) => (w.end > w.start ? `${hexText(w.start)}..${hexText(w.end)}` : hexText(w.start)) },
          { header: 'Name', width: 80, render: (w) => w.label ?? '' },
          { header: 'Type', width: 80, render: (w) => (w.kind === 'read' ? 'Read' : w.kind === 'write' ? 'Write' : 'Read/Write') },
          { header: 'Info', render: flags },
        ]}
      />
      <GroupBox label="Watchpoint:">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Field label="From:" value={wpDraft.from} onChange={(v) => editWp({ from: v })} width={90} />
          <Field label="To:" value={wpDraft.to} onChange={(v) => editWp({ to: v })} width={90} />
          <Check label="Disable" checked={wpDraft.disabled} onChange={(v) => editWp({ disabled: v })} />
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 6 }} role="radiogroup" aria-label="Watchpoint type">
          {(
            [
              ['read', 'Read'],
              ['write', 'Write'],
              ['readwrite', 'Read/Write'],
            ] as const
          ).map(([k, l]) => (
            <label key={k}>
              <input type="radio" name="wp-kind" checked={wpDraft.kind === k} onChange={() => editWp({ kind: k })} /> {l}
            </label>
          ))}
        </div>
      </GroupBox>
      <CommonGroups d={wpDraft} set={editWp} />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <Button onClick={() => void wpDelete()} disabled={!wpSel.length} testId="cp-wp-delete">
          Delete
        </Button>
        <Button onClick={() => void wpUpdate()} disabled={!wpFocused} testId="cp-wp-update">
          Update
        </Button>
        <Button onClick={() => void wpAdd()} testId="cp-wp-add">
          Add
        </Button>
      </div>
    </div>
  );

  const mpTab = (
    <div style={{ display: 'flex', flexDirection: 'column' }} data-testid="cp-markpoints">
      <PointList<Markpoint & { enabled: boolean }>
        items={marks.map((m) => ({ ...m, enabled: true }))}
        selected={mpSel === null ? [] : [mpSel]}
        onSelect={(_ids, f) => {
          setMpSel(f);
          const m = marks.find((x) => x.id === f);
          if (m) (setMpName(m.name), setMpAddr(hexText(m.address)));
        }}
        onToggle={() => undefined}
        testId="cp-mp-list"
        columns={[
          { header: 'Name', width: 140, render: (m) => m.name },
          { header: 'Address', width: 90, render: (m) => hexText(m.address) },
          { header: 'Kind', render: (m) => m.kind },
        ]}
      />
      <GroupBox label="Markpoint:">
        <div style={{ display: 'flex', gap: 8 }}>
          <Field label="Name:" value={mpName} onChange={setMpName} />
          <Field label="Address:" value={mpAddr} onChange={setMpAddr} width={100} />
        </div>
      </GroupBox>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <Button onClick={() => mpFocused && (markpoints.remove(mpFocused.id), setMpSel(null))} disabled={!mpFocused}>
          Delete
        </Button>
        <Button
          onClick={() =>
            void (async () => {
              if (!mpFocused) return;
              const a = await resolveAddress(s12, mpAddr);
              if (a === null) return fail(`Invalid address "${mpAddr.trim()}"`);
              markpoints.update(mpFocused.id, { name: mpName.trim() || mpFocused.name, address: a });
            })()
          }
          disabled={!mpFocused}
        >
          Update
        </Button>
        <Button onClick={() => void mpAdd()}>Add</Button>
      </div>
    </div>
  );

  return (
    <Dialog
      open={open}
      title="Controlpoints Configuration"
      onClose={onClose}
      width={560}
      testId="controlpoints-dialog"
      buttons={
        <>
          <Button isDefault onClick={() => void ok()} testId="cp-ok">
            OK
          </Button>
          <Button onClick={onClose} testId="cp-cancel">
            Cancel
          </Button>
        </>
      }
    >
      <Tabs
        selected={tab}
        onSelect={(t) => setTab(t as ControlpointsTab)}
        tabs={[
          { id: 'breakpoints', label: 'Breakpoints', content: bpTab },
          { id: 'watchpoints', label: 'Watchpoints', content: wpTab },
          { id: 'markpoints', label: 'Markpoints', content: mpTab },
        ]}
      />
      {error && (
        <div role="alert" style={{ color: 'var(--cw-cmd-error)', marginTop: 6 }}>
          {error}
        </div>
      )}
    </Dialog>
  );
}
