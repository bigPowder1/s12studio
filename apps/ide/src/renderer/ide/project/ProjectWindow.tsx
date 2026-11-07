/**
 * Project window (docs/research/r1/ide.md §3), docked at the left of the IDE frame like CW 5.1's:
 *   caption "<name>.mcp"; toolbar with the current-target drop-down, Change MCU/Connection, Target Settings,
 *   Synchronize Modification Dates, Make, Debug, Run, Project Inspector; tabs Files / Link Order / Targets.
 * Files tab: touch column (red check = needs compiling, click toggles), group tree, Code, Data, target dot (only with
 * several targets), debug column (dot = debug info, click toggles). Double-click opens a file; right-click menus;
 * drag files between groups. Link Order: drag to reorder. Targets: double-click sets the default target.
 */
import { useCallback, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ContextMenu, type ContextMenuState } from '../../common/menu/MenuBar';
import { SEP, type MenuEntry } from '../../common/menu/model';
import { Button, Caption, Dialog, PromptDialog, Tabs, ToolButton } from '../../common/controls';
import { Icons } from '../../common/icons';
import { useProject, useS12, useS12Store } from '../../common/s12';
import { ListView, TreeView, type TreeNode } from '../../common/views';
import { parseApiError, type GroupChild, type ProjectFileInfo, type ProjectInfo } from '../../../shared/api';
import { runIdeCommand, useIdeCommand } from '../commands';
import { setIdeStatus, useIdeActions, type IdeActions } from '../shell/actions';
import { connectionLabel, effectiveConnection } from '../shell/menus';
import { projectFileName } from './project-file-name';

// ------------------------------------------------------------------------------------------------ model

export type ProjNodeData = { kind: 'group'; path: string[] } | { kind: 'file'; name: string; group: string[]; file: ProjectFileInfo | null };
type Node = TreeNode<ProjNodeData>;

const COMPILED_KINDS = new Set(['asm', 'c', 'lib', 'o']);
const isCompiled = (f: ProjectFileInfo | null) => !!f && COMPILED_KINDS.has(f.kind);

function fileIcon(f: ProjectFileInfo | null): ReactNode {
  if (f && (f.kind === 'lib' || f.kind === 'o')) return Icons.library;
  if (f && ['asm', 'inc', 'prm', 'bbl', 'c', 'h', 'ini', 'cmd', 'txt', 'map'].includes(f.kind)) return Icons.textFile;
  return Icons.file;
}

/** Group tree of the Files tab. Node keys: `g:<path/...>` for groups, `f:<name>` for files. */
export function groupTree(info: ProjectInfo): Node[] {
  const byName = new Map(info.files.map((f) => [f.name.toLowerCase(), f]));
  const conv = (c: GroupChild, parent: string[]): Node => {
    if (c.type === 'group') {
      const path = [...parent, c.name];
      return { key: `g:${path.join('/')}`, label: c.name, icon: Icons.folder, children: c.children.map((x) => conv(x, path)), data: { kind: 'group', path } };
    }
    const f = byName.get(c.name.toLowerCase()) ?? null;
    return {
      key: `f:${c.name}`,
      label: f && !f.path ? <span style={{ color: 'var(--cw-gray-text)' }} title="File not found in the access paths">{c.name}</span> : c.name,
      icon: fileIcon(f),
      data: { kind: 'file', name: c.name, group: parent, file: f },
    };
  };
  return info.groups.map((g) => conv(g, []));
}

/** Files of a node (a file, or every file under a group). */
function filesUnder(n: Node): ProjectFileInfo[] {
  if (n.data?.kind === 'file') return n.data.file ? [n.data.file] : [];
  return (n.children ?? []).flatMap(filesUnder);
}

/** Code/Data column text (CW: n/a for files without object code; groups show the sum). */
export function sizeText(n: Node, k: 'code' | 'data'): string {
  if (n.data?.kind === 'group') {
    const fs = filesUnder(n).filter(isCompiled);
    return fs.length ? String(fs.reduce((s, f) => s + (f[k] ?? 0), 0)) : '';
  }
  const f = n.data?.kind === 'file' ? n.data.file : null;
  if (!f) return '';
  if (!isCompiled(f)) return 'n/a';
  return String(f[k] ?? 0);
}

/** Move list[from] so it lands in front of the item that is at index `before` in the original list (0..length). */
export function reorder<T>(list: readonly T[], from: number, before: number): T[] {
  const c = [...list];
  const [x] = c.splice(from, 1);
  c.splice(before > from ? before - 1 : before, 0, x);
  return c;
}

// ------------------------------------------------------------------------------------------------ component

export interface ProjectWindowProps {
  /** Selected file name changed (Project Inspector default). */
  onSelectFile?: (name: string | null) => void;
  /** Override actions (tests); default: the shared IDE actions. */
  actions?: IdeActions;
  /** A build is running: Make/Debug/Run and Compile are disabled, as in the menu bar and main toolbar. */
  building?: boolean;
}

type Confirm = { text: string; ok: () => void } | null;
type Prompt = { title: string; label: string; initial?: string; ok: (v: string) => void } | null;

export function ProjectWindow({ onSelectFile, actions: actionsProp, building = false }: ProjectWindowProps) {
  const project = useProject();
  const s12 = useS12();
  const store = useS12Store();
  const defaults = useIdeActions(store.project.get);
  const actions = actionsProp ?? defaults;
  const [tab, setTab] = useState('files');
  const [sel, setSel] = useState<Node | null>(null);
  const [linkSel, setLinkSel] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const drag = useRef<{ kind: 'file'; name: string } | { kind: 'link'; index: number } | null>(null);
  const [dropMark, setDropMark] = useState<{ key: string; where: 'before' | 'after' | 'into' } | null>(null);

  const call = useCallback(<T,>(p: Promise<T>) => void p.catch((e) => setIdeStatus(parseApiError(e).message)), []);
  const select = (n: Node | null) => {
    setSel(n);
    onSelectFile?.(n?.data?.kind === 'file' ? n.data.name : null);
  };
  const selGroup = (): string[] | undefined => (sel?.data?.kind === 'group' ? sel.data.path : sel?.data?.kind === 'file' ? sel.data.group : undefined);

  const addFiles = useCallback(
    async (group?: string[]) => {
      const paths = await s12.files.openDialog({ title: 'Add Files', multi: true, defaultPath: project?.dir, filters: [{ name: 'All Files', extensions: ['*'] }] });
      if (paths.length) call(s12.project.addFiles(paths, group?.length ? group : undefined));
    },
    [s12, project, call],
  );
  const createGroup = useCallback(
    (parent?: string[]) =>
      setPrompt({
        title: 'Create Group',
        label: 'Enter name for new group:',
        initial: 'New Group',
        ok: (name) => call(s12.project.addGroup([...(parent ?? []), name.trim()])),
      }),
    [s12, call],
  );

  // menu bar / toolbar commands that act on the project window's selection
  useIdeCommand('project.addFiles', (a) => void addFiles(a?.group ?? selGroup()));
  const filesRef = useRef<HTMLDivElement>(null);
  useIdeCommand('project.focus', () => {
    setTab('files');
    // the Files page mounts on the next render when another tab was showing
    setTimeout(() => filesRef.current?.focus(), 0);
  });
  useIdeCommand('project.createGroup', (a) => createGroup(a?.parent ?? (sel?.data?.kind === 'group' ? sel.data.path : undefined)));

  const tree = useMemo(() => (project ? groupTree(project) : []), [project]);

  if (!project) {
    return (
      <div className="ide-projwin" data-testid="project-window">
        <Caption title="Project" />
        <div className="cw-placeholder">No project open. Use File &gt; Open... to open a .mcp project, or File &gt; New... to create one.</div>
      </div>
    );
  }

  const target = project.targets.find((t) => t.name === project.currentTarget) ?? project.targets[0];
  const multiTarget = project.targets.length > 1;
  const open = (f: ProjectFileInfo | null) => {
    if (f?.path) runIdeCommand('editor.open', { path: f.path });
    else if (f) setIdeStatus(`${f.name} was not found in the access paths`);
  };

  const removeNode = (n: Node) => {
    const d = n.data;
    if (!d) return;
    if (d.kind === 'file') setConfirm({ text: `Remove "${d.name}" from the project?`, ok: () => call(s12.project.removeFile(d.name)) });
    else setConfirm({ text: `Remove the group "${d.path[d.path.length - 1]}" and the files in it from the project?`, ok: () => call(s12.project.removeGroup(d.path)) });
  };

  const fileMenu = (n: Node): MenuEntry[] => {
    const d = n.data;
    if (d?.kind === 'file') {
      const f = d.file;
      return [
        { id: 'pw.open', label: '&Open', disabled: !f?.path, onSelect: () => open(f) },
        { id: 'pw.reveal', label: 'Open in &File Manager', disabled: !f?.path, onSelect: () => f?.path && call(s12.files.reveal(f.path)) },
        SEP,
        { id: 'pw.compile', label: '&Compile', disabled: building || !isCompiled(f) || f?.kind === 'lib', onSelect: () => void actions.compile([d.name]) },
        { id: 'pw.checkSyntax', label: 'Check S&yntax', disabled: building || f?.kind !== 'asm', onSelect: () => void actions.checkSyntax([d.name]) },
        { id: 'pw.touch', label: f?.touched ? '&Untouch' : '&Touch', disabled: !isCompiled(f), onSelect: () => call(s12.project.setTouched(d.name, !f?.touched)) },
        { id: 'pw.debug', label: 'Generate &Debug Info', checked: !!f?.debug, onSelect: () => call(s12.project.setDebugFlag(d.name, !f?.debug)) },
        SEP,
        { id: 'pw.remove', label: '&Remove', shortcut: 'Del', onSelect: () => removeNode(n) },
        SEP,
        { id: 'pw.addFiles', label: 'Add &Files...', onSelect: () => void addFiles(d.group) },
        { id: 'pw.createGroup', label: 'Create &Group...', onSelect: () => createGroup(d.group) },
        SEP,
        { id: 'pw.inspect', label: 'Project &Inspector', onSelect: () => runIdeCommand('project.inspect', { name: d.name }) },
      ];
    }
    if (d?.kind === 'group') {
      return [
        { id: 'pw.addFiles', label: 'Add &Files...', onSelect: () => void addFiles(d.path) },
        { id: 'pw.createGroup', label: 'Create &Group...', onSelect: () => createGroup(d.path) },
        SEP,
        { id: 'pw.compile', label: '&Compile', disabled: building || !filesUnder(n).some((f) => f.kind === 'asm'), onSelect: () => void actions.compile(filesUnder(n).filter((f) => f.kind === 'asm').map((f) => f.name)) },
        {
          id: 'pw.rename',
          label: 'Re&name Group...',
          onSelect: () => setPrompt({ title: 'Rename Group', label: 'New group name:', initial: d.path[d.path.length - 1], ok: (v) => call(s12.project.renameGroup(d.path, v.trim())) }),
        },
        { id: 'pw.remove', label: '&Remove', shortcut: 'Del', onSelect: () => removeNode(n) },
      ];
    }
    return [
      { id: 'pw.addFiles', label: 'Add &Files...', onSelect: () => void addFiles() },
      { id: 'pw.createGroup', label: 'Create &Group...', onSelect: () => createGroup() },
    ];
  };

  // ---- drag and drop (files between groups) ----
  const where = (e: DragEvent<HTMLElement>): 'before' | 'after' => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? 'before' : 'after';
  };
  const fileRowProps = (n: Node) => ({
    draggable: n.data?.kind === 'file',
    onDragStart: (e: DragEvent<HTMLTableRowElement>) => {
      if (n.data?.kind !== 'file') return;
      drag.current = { kind: 'file', name: n.data.name };
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', n.data.name);
      } catch {
        /* jsdom */
      }
    },
    onDragOver: (e: DragEvent<HTMLTableRowElement>) => {
      if (drag.current?.kind !== 'file') return;
      e.preventDefault();
      setDropMark({ key: n.key, where: n.data?.kind === 'group' ? 'into' : where(e) });
    },
    onDragLeave: () => setDropMark(null),
    onDrop: (e: DragEvent<HTMLTableRowElement>) => {
      e.preventDefault();
      const d = drag.current;
      drag.current = null;
      setDropMark(null);
      if (d?.kind !== 'file' || !n.data) return;
      if (n.data.kind === 'group') return call(s12.project.moveFile(d.name, n.data.path));
      if (n.data.name === d.name) return;
      const parent = findGroupChildren(project.groups, n.data.group).filter((c) => c.name !== d.name);
      const idx = parent.findIndex((c) => c.type === 'file' && c.name === (n.data as { name: string }).name);
      call(s12.project.moveFile(d.name, n.data.group, idx + (where(e) === 'after' ? 1 : 0)));
    },
    onDragEnd: () => {
      drag.current = null;
      setDropMark(null);
    },
  });

  // ---- link order ----
  const linkOrder = target?.linkOrder ?? [];
  const byName = new Map(project.files.map((f) => [f.name, f]));
  const linkRowProps = (_name: string, i: number) => ({
    draggable: true,
    onDragStart: (e: DragEvent<HTMLTableRowElement>) => {
      drag.current = { kind: 'link', index: i };
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', linkOrder[i]);
      } catch {
        /* jsdom */
      }
    },
    onDragOver: (e: DragEvent<HTMLTableRowElement>) => {
      if (drag.current?.kind !== 'link') return;
      e.preventDefault();
      setDropMark({ key: `l:${i}`, where: where(e) });
    },
    onDragLeave: () => setDropMark(null),
    onDrop: (e: DragEvent<HTMLTableRowElement>) => {
      e.preventDefault();
      const d = drag.current;
      drag.current = null;
      setDropMark(null);
      if (d?.kind !== 'link' || !target) return;
      const next = reorder(linkOrder, d.index, i + (where(e) === 'after' ? 1 : 0));
      if (next.join('\n') !== linkOrder.join('\n')) call(s12.project.setLinkOrder(target.name, next));
    },
    onDragEnd: () => {
      drag.current = null;
      setDropMark(null);
    },
  });
  const moveLink = (name: string, d: -1 | 1) => {
    const i = linkOrder.indexOf(name);
    const j = i + d;
    if (!target || i < 0 || j < 0 || j >= linkOrder.length) return;
    call(s12.project.setLinkOrder(target.name, reorder(linkOrder, i, d > 0 ? j + 1 : j)));
  };

  const totals = { files: project.files.length, code: 0, data: 0 };
  for (const f of project.files) if (isCompiled(f)) (totals.code += f.code ?? 0), (totals.data += f.data ?? 0);

  // the same connection the menu bar marks: the sidecar's choice, else the one in the debugger arguments
  const conn = effectiveConnection(project);
  const connMenu = (x: number, y: number) =>
    setMenu({
      x,
      y,
      items: project.connections.length
        ? project.connections.map((c) => ({ id: `conn:${c.name}`, label: connectionLabel(c.name).replace(/&/g, '&&'), checked: c.name === conn, onSelect: () => void actions.setConnection(c.name) }))
        : [{ label: '(no connection .ini files)', disabled: true }],
    });

  const dot = <span className="ide-dot">●</span>;

  return (
    <div className="ide-projwin" data-testid="project-window">
      <Caption title={projectFileName(project)} active />
      <div className="ide-projwin-toolbar" role="toolbar" aria-label="Project">
        <select className="cw-field ide-target-select" value={project.currentTarget} aria-label="Current target" data-testid="pw-target" onChange={(e) => void actions.setTarget(e.target.value)}>
          {project.targets.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
        <ToolButton
          title={`Change MCU/Connection${conn ? ` (${connectionLabel(conn)})` : ''}`}
          icon={Icons.chip}
          testId="pw-connection"
          onClick={() => {
            const b = document.querySelector('[data-testid="pw-connection"]')?.getBoundingClientRect();
            connMenu(b?.left ?? 40, (b?.bottom ?? 60) + 1);
          }}
        />
        <ToolButton title="Target Settings (Alt+F7)" icon={Icons.settings} testId="pw-settings" onClick={() => runIdeCommand('project.settings')} />
        <ToolButton title="Synchronize Modification Dates" icon={Icons.sync} testId="pw-sync" onClick={() => void actions.synchronize()} />
        <ToolButton title="Make (F7)" icon={Icons.make} disabled={building} testId="pw-make" onClick={() => void actions.make()} />
        <ToolButton title="Debug (F5)" icon={Icons.debug} disabled={building} testId="pw-debug" onClick={() => void actions.debug()} />
        <ToolButton title="Run (Ctrl+F5)" icon={Icons.run} disabled={building} testId="pw-run" onClick={() => void actions.run()} />
        <ToolButton title="Project Inspector" icon={Icons.inspector} testId="pw-inspector" onClick={() => runIdeCommand('project.inspect', sel?.data?.kind === 'file' ? { name: sel.data.name } : undefined)} />
      </div>
      <Tabs
        style={{ flex: 1 }}
        selected={tab}
        onSelect={setTab}
        testId="project-tabs"
        tabs={[
          {
            id: 'files',
            label: 'Files',
            content: (
              <div
                ref={filesRef}
                className="ide-fill"
                data-testid="project-files-pane"
                onContextMenu={(e) => {
                  if (e.defaultPrevented) return;
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, items: fileMenu({ key: '', label: '' }) });
                }}
                onKeyDown={(e) => {
                  if (!sel) return;
                  if (e.key === 'Delete') removeNode(sel);
                  else if (e.key === 'Enter' && sel.data?.kind === 'file') open(sel.data.file);
                  else return;
                  e.preventDefault();
                }}
                tabIndex={0}
              >
                <TreeView
                  testId="project-files"
                  nodes={tree}
                  treeHeader="File"
                  leadingColumns={[
                    {
                      id: 'touch',
                      header: <span title="Touch">{Icons.touch}</span>,
                      width: 24,
                      align: 'center',
                      render: (n) => {
                        const d = n.data;
                        if (d?.kind !== 'file' || !isCompiled(d.file)) return null;
                        const f = d.file!;
                        return (
                          <span
                            className="ide-click-cell"
                            role="checkbox"
                            aria-checked={!!f.touched}
                            aria-label={`Touch ${d.name}`}
                            data-testid={`touch-${d.name}`}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={() => call(s12.project.setTouched(d.name, !f.touched))}
                          >
                            {f.touched ? Icons.touch : null}
                          </span>
                        );
                      },
                    },
                  ]}
                  columns={[
                    { id: 'code', header: 'Code', width: 58, align: 'right', render: (n) => sizeText(n, 'code') },
                    { id: 'data', header: 'Data', width: 52, align: 'right', render: (n) => sizeText(n, 'data') },
                    ...(multiTarget
                      ? [{ id: 'target', header: <span title="Target">{dot}</span>, width: 20, align: 'center' as const, render: (n: Node) => (n.data?.kind === 'file' && n.data.file?.targets.includes(project.currentTarget) ? dot : null) }]
                      : []),
                    {
                      id: 'debug',
                      header: <span title="Debug">{Icons.bug}</span>,
                      width: 24,
                      align: 'center',
                      render: (n) => {
                        const d = n.data;
                        if (d?.kind !== 'file' || !d.file) return null;
                        const f = d.file;
                        return (
                          <span
                            className="ide-click-cell"
                            role="checkbox"
                            aria-checked={f.debug}
                            aria-label={`Debug ${d.name}`}
                            data-testid={`debug-${d.name}`}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={() => call(s12.project.setDebugFlag(d.name, !f.debug))}
                          >
                            {f.debug ? dot : null}
                          </span>
                        );
                      },
                    },
                  ]}
                  selected={sel?.key ?? null}
                  onSelect={select}
                  onActivate={(n) => n.data?.kind === 'file' && open(n.data.file)}
                  onContextMenu={(e, n) => {
                    e.preventDefault();
                    select(n);
                    setMenu({ x: e.clientX, y: e.clientY, items: fileMenu(n) });
                  }}
                  rowProps={fileRowProps}
                  rowClass={(n) => (dropMark?.key === n.key ? `drop-${dropMark.where}` : undefined)}
                />
              </div>
            ),
          },
          {
            id: 'link',
            label: 'Link Order',
            content: (
              <ListView
                testId="project-link-order"
                columns={[
                  { id: 'f', header: 'File', render: (n: string) => n },
                  { id: 'code', header: 'Code', width: 58, align: 'right', render: (n) => sizeText({ key: n, label: n, data: { kind: 'file', name: n, group: [], file: byName.get(n) ?? null } }, 'code') },
                  { id: 'data', header: 'Data', width: 52, align: 'right', render: (n) => sizeText({ key: n, label: n, data: { kind: 'file', name: n, group: [], file: byName.get(n) ?? null } }, 'data') },
                ]}
                rows={linkOrder}
                rowKey={(n) => n}
                selected={linkSel}
                onSelect={(k) => setLinkSel(k)}
                onActivate={(k) => open(byName.get(k) ?? null)}
                onContextMenu={(e, k) => {
                  e.preventDefault();
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      { id: 'lo.open', label: '&Open', onSelect: () => open(byName.get(k) ?? null) },
                      SEP,
                      { id: 'lo.up', label: 'Move &Up', disabled: linkOrder.indexOf(k) <= 0, onSelect: () => moveLink(k, -1) },
                      { id: 'lo.down', label: 'Move &Down', disabled: linkOrder.indexOf(k) >= linkOrder.length - 1, onSelect: () => moveLink(k, 1) },
                    ],
                  });
                }}
                rowProps={linkRowProps}
                rowClass={(_n, i) => (dropMark?.key === `l:${i}` ? `drop-${dropMark.where}` : undefined)}
              />
            ),
          },
          {
            id: 'targets',
            label: 'Targets',
            content: (
              <ListView
                testId="project-targets"
                columns={[
                  { id: 'i', header: '', width: 24, align: 'center', render: (t: { name: string }) => (t.name === project.currentTarget ? Icons.target : Icons.targetInactive) },
                  { id: 't', header: 'Targets', render: (t) => t.name },
                ]}
                rows={project.targets}
                rowKey={(t) => t.name}
                selected={project.currentTarget}
                onActivate={(k) => void actions.setTarget(k)}
                onContextMenu={(e, k) => {
                  e.preventDefault();
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      { id: 'tg.default', label: 'Set &Default Target', checked: k === project.currentTarget, onSelect: () => void actions.setTarget(k) },
                      { id: 'tg.settings', label: `${k.replace(/&/g, '&&')} &Settings...`, onSelect: () => runIdeCommand('project.settings', { target: k }) },
                    ],
                  });
                }}
              />
            ),
          },
        ]}
      />
      <div className="ide-projwin-footer" data-testid="project-footer">
        <span style={{ flex: 1 }}>
          {totals.files} file{totals.files === 1 ? '' : 's'}
        </span>
        <span className="ide-num">{totals.code}</span>
        <span className="ide-num">{totals.data}</span>
      </div>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
      <Dialog
        title="Project"
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        width={360}
        testId="pw-confirm"
        buttons={
          <>
            <Button
              isDefault
              testId="pw-confirm-ok"
              onClick={() => {
                confirm?.ok();
                setConfirm(null);
              }}
            >
              OK
            </Button>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
          </>
        }
      >
        {confirm?.text}
      </Dialog>
      <PromptDialog
        title={prompt?.title ?? ''}
        label={prompt?.label ?? ''}
        initial={prompt?.initial}
        open={prompt !== null}
        testId="pw-prompt"
        validate={(v) => (v.trim() ? (/[\\/]/.test(v) ? 'Group names cannot contain / or \\.' : null) : 'Enter a name.')}
        onCancel={() => setPrompt(null)}
        onOk={(v) => {
          prompt?.ok(v);
          setPrompt(null);
        }}
      />
    </div>
  );
}

function findGroupChildren(groups: GroupChild[], path: string[]): GroupChild[] {
  let cur = groups;
  for (const name of path) {
    const g = cur.find((c) => c.type === 'group' && c.name === name);
    if (!g || g.type !== 'group') return [];
    cur = g.children;
  }
  return cur;
}
