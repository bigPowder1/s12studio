/**
 * File > New... : CodeWarrior's "HC(S)12(X) Microcontrollers New Project" wizard (ide.md §2) with a Wizard Map on the
 * left and Back / Next / Finish / Cancel. Pages: Device and Connection, Project Parameters (language, name, location,
 * plus S12 Studio's stationery choice), Add Additional Files. Finish creates <location>/<name>/ (a standalone
 * <name>.s12studio.json project; <name>.mcp only from a copy of the course's blank_project in <userData>/templates)
 * through ProjectApi.newProject and opens it. What S12 Studio cannot do is shown greyed out: other derivatives,
 * hardware connections other than the ME305 lab's, C/C++ and absolute assembly, adding extra files.
 * S12 Studio ships no course content: the ME 305 entry is available only when the user copied the course's
 * blank_project folder into the templates folder. Otherwise (AppInfo.courseTemplate === false) the generic
 * stationery is selected and the ME 305 entry is greyed with a note pointing to File > Open... .
 * UNCERTAIN: page titles/wording from ide.md §2 (no screenshot of the 5.1 S12X wizard); XGATE Setup page omitted
 * (assembly-only course). Finish is allowed on every page, as in CodeWarrior's wizards.
 */
import { useEffect, useState } from 'react';
import { Button, Checkbox, Dialog, GroupBox } from '../../common/controls';
import { useProject, useS12 } from '../../common/s12';
import { ListView } from '../../common/views';
import { parseApiError, type ProjectTemplate } from '../../../shared/api';

export const TEMPLATES: { id: ProjectTemplate; label: string; description: string }[] = [
  {
    id: 'blank_project',
    label: 'ME 305 blank_project (from your course)',
    description:
      'A copy of the blank_project folder from your course (found in your templates folder): its .mcp, sources, ME 305 library and settings are copied as they are and renamed to the new project name.',
  },
  {
    id: 'minimal',
    label: 'MC9S12XDP512 assembly (generic)',
    description: 'A minimal relocatable-assembly project for the MC9S12XDP512: main.asm, derivative.inc, Project.prm, burner.bbl and a Full Chip Simulation connection.',
  },
];

/** Same rules as @s12/project validateProjectName (Windows-safe file name). Returns an error or null. */
export function projectNameError(name: string): string | null {
  if (!name.trim()) return 'Enter a project name.';
  if (name.length > 200 || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^\s/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(name)) {
    return `"${name}" is not a valid project name.`;
  }
  return null;
}

const parentDir = (p: string) => p.replace(/[\\/][^\\/]*$/, '');

/**
 * Shown when no blank_project copy is in the templates folder. `templatesDir`: AppInfo.userTemplatesDir (the real
 * <userData>/templates path of this OS), else a placeholder.
 */
export function noCourseTemplateText(templatesDir?: string): string {
  return `ME 305 labs: use File > Open... on a copy of the blank_project folder from your course. (To list it here, copy that folder into ${templatesDir || '<user data folder>/templates'}.)`;
}

export const WIZARD_PAGES = ['Device and Connection', 'Project Parameters', 'Add Additional Files'] as const;

/** Derivative tree of page 1: only the course's MC9S12XDP512 is available. */
const DERIVATIVES: { family: string; group: string; parts: { name: string; ok: boolean }[] }[] = [
  { family: 'HC12', group: 'HC12 Family', parts: [{ name: 'MC68HC912B32', ok: false }] },
  { family: 'HCS12', group: 'HCS12D Family', parts: [{ name: 'MC9S12DG256B', ok: false }, { name: 'MC9S12DP512', ok: false }] },
  { family: 'HCS12X', group: 'HCS12XD Family', parts: [{ name: 'MC9S12XDP512', ok: true }, { name: 'MC9S12XDT256', ok: false }] },
];

/** Connections of page 1 (ide.md §2). The course's blank_project has Full Chip Simulation and P&E Multilink connections. */
const CONNECTIONS: { name: string; ok: boolean; description: string }[] = [
  { name: 'Full Chip Simulation', ok: true, description: 'Simulates the MC9S12XDP512 and the ME305 board on the PC (no hardware needed).' },
  { name: 'P&E Multilink/Cyclone Pro', ok: true, description: 'BDM pod used in the ME305 lab. Debugging real hardware arrives later; until then the project debugs on Full Chip Simulation.' },
  { name: 'SofTec HCS12', ok: false, description: 'Not supported by S12 Studio.' },
  { name: 'Abatron BDI', ok: false, description: 'Not supported by S12 Studio.' },
  { name: 'HCS12 Serial Monitor', ok: false, description: 'Not supported by S12 Studio.' },
];

export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s12 = useS12();
  const project = useProject();
  const [page, setPage] = useState(0);
  const [name, setName] = useState('Project');
  const [dir, setDir] = useState('');
  const [template, setTemplate] = useState<ProjectTemplate>('blank_project');
  const [connInfo, setConnInfo] = useState(CONNECTIONS[0]!.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A blank_project copy is in the templates folder (unknown -> assume yes; main refuses cleanly if it is not). */
  const [course, setCourse] = useState(true);
  /** AppInfo.userTemplatesDir: where to copy blank_project to list it here. */
  const [templatesDir, setTemplatesDir] = useState<string | undefined>(undefined);
  /** app.info() has answered (data-course on the template hint: lets E2E wait for it instead of sleeping). */
  const [courseKnown, setCourseKnown] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setPage(0);
    if (!dir && project) setDir(parentDir(project.dir)); // default: next to the open project
    let live = true;
    setCourseKnown(false);
    void Promise.resolve()
      .then(() => s12.app.info())
      .then(
        (i) => {
          if (!live) return;
          const has = i?.courseTemplate !== false;
          setCourse(has);
          setTemplatesDir(i?.userTemplatesDir);
          setCourseKnown(true);
          if (!has) setTemplate('minimal');
        },
        () => {
          if (live) setCourseKnown(true); // unknown: assume installed (main refuses cleanly if it is not)
        },
      );
    return () => {
      live = false;
    };
  }, [open]); // only when the dialog opens

  const stem = name.replace(/\.mcp$/i, '');
  const finish = async () => {
    const e = projectNameError(stem) ?? (dir.trim() ? null : 'Choose a location for the project.');
    if (e) {
      setError(e);
      setPage(1); // the fields to fix are on Project Parameters
      return;
    }
    setBusy(true);
    try {
      await s12.project.newProject({ template, dir, name: stem });
      onClose();
    } catch (err) {
      setError(parseApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const tpl = TEMPLATES.find((t) => t.id === template)!;
  const noCourse = noCourseTemplateText(templatesDir);
  const rows = course ? TEMPLATES : TEMPLATES.map((t) => (t.id === 'blank_project' ? { ...t, label: `${t.label} - not found` } : t));
  // the generic stationery has a Full Chip Simulation connection only
  const connChecked = (c: string) => c === 'Full Chip Simulation' || (template === 'blank_project' && c === 'P&E Multilink/Cyclone Pro');
  const pageBody = [
    // ------------------------------------------------------------------ 1. Device and Connection
    <div key="dev" style={{ display: 'flex', gap: 8 }} data-testid="np-page-device">
      <GroupBox label="Select the derivative you would like to use" style={{ flex: 1 }}>
        <div className="cw-sunken" style={{ height: 180, overflow: 'auto', background: 'var(--cw-window)', padding: 2 }} role="tree" aria-label="Derivatives">
          {DERIVATIVES.map((f) => (
            <div key={f.family} role="treeitem" aria-expanded="true">
              <div>{'\u25BE'} {f.family}</div>
              <div style={{ paddingLeft: 12 }}>{'\u25BE'} {f.group}</div>
              {f.parts.map((p) => (
                <div
                  key={p.name}
                  role="treeitem"
                  aria-selected={p.ok}
                  aria-disabled={!p.ok}
                  style={{ paddingLeft: 28, color: p.ok ? 'var(--cw-highlight-text)' : 'var(--cw-gray-text)', background: p.ok ? 'var(--cw-highlight)' : undefined, width: 'fit-content', paddingRight: 4 }}
                  title={p.ok ? undefined : 'Not available in S12 Studio'}
                >
                  {p.name}
                </div>
              ))}
            </div>
          ))}
        </div>
      </GroupBox>
      <GroupBox label="Connections" style={{ flex: 1 }}>
        <div className="cw-sunken" style={{ height: 120, overflow: 'auto', background: 'var(--cw-window)', padding: 2 }} data-testid="np-connections">
          {CONNECTIONS.map((c) => (
            <div key={c.name} onMouseDown={() => setConnInfo(c.name)} style={{ background: connInfo === c.name ? 'var(--cw-face)' : undefined }}>
              <Checkbox label={c.name} checked={c.ok && connChecked(c.name)} disabled title={c.ok ? 'Set by the stationery' : 'Not supported by S12 Studio'} />
            </div>
          ))}
        </div>
        <div className="ide-hint" style={{ minHeight: 52 }}>
          {CONNECTIONS.find((c) => c.name === connInfo)?.description}
        </div>
      </GroupBox>
    </div>,
    // ------------------------------------------------------------------ 2. Project Parameters
    <div key="params" data-testid="np-page-params">
      <div style={{ display: 'flex', gap: 8 }}>
        {/* the long legend wraps to two lines: room for it above the first checkbox; one checkbox per row */}
        <GroupBox
          label="Please choose the set of languages to be supported initially"
          style={{ flex: 1, paddingTop: 24, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}
        >
          {/* UNCERTAIN: lab handouts tick "Absolute assembly"; ME 305 projects are relocatable assembly */}
          <Checkbox label="Absolute assembly" checked={false} disabled title="Not offered: ME 305 projects are relocatable assembly" />
          <Checkbox label="Relocatable assembly" checked disabled />
          <Checkbox label="C" checked={false} disabled title="S12 Studio has no C compiler" />
          <Checkbox label="C++" checked={false} disabled title="S12 Studio has no C++ compiler" />
        </GroupBox>
        <GroupBox label="Project Stationery (S12 Studio)" style={{ flex: 1.4 }}>
          <div style={{ height: 62, display: 'flex' }}>
            <ListView
              testId="np-templates"
              columns={[{ id: 'l', header: 'Stationery', render: (t: (typeof TEMPLATES)[number]) => t.label }]}
              rows={rows}
              rowKey={(t) => t.id}
              selected={template}
              onSelect={(k) => (course || k !== 'blank_project') && setTemplate(k as ProjectTemplate)} // the hint below explains a missing course copy
              onActivate={() => void finish()}
            />
          </div>
          <div className="ide-hint" style={{ minHeight: 42 }} data-testid="np-template-hint" data-course={courseKnown ? String(course) : undefined}>
            {tpl.description}
            {!course && (
              <div style={{ marginTop: 4 }} data-testid="np-no-course">
                {noCourse}
              </div>
            )}
          </div>
        </GroupBox>
      </div>
      <GroupBox label="Project Parameters">
        <label className="ide-form-row">
          <span>Project name:</span>
          <input className="cw-field" value={name} autoFocus aria-label="Project name" onChange={(e) => setName(e.target.value)} data-testid="np-name" />
        </label>
        <label className="ide-form-row">
          <span>Location:</span>
          <span className="ide-inline">
            <input className="cw-field" style={{ flex: 1 }} value={dir} aria-label="Location" onChange={(e) => setDir(e.target.value)} data-testid="np-dir" />
            <Button
              onClick={() =>
                void s12.files.openDialog({ title: 'Project Location', directory: true, defaultPath: dir || undefined }).then(([d]) => {
                  if (d) setDir(d);
                })
              }
            >
              Set...
            </Button>
          </span>
        </label>
        <div className="ide-hint">
          Creates {dir ? `${dir.replace(/[\\/]+$/, '')}/` : ''}
          {stem || '<name>'}/{template === 'minimal' ? `${stem || '<name>'}.s12studio.json` : ''}
        </div>
      </GroupBox>
    </div>,
    // ------------------------------------------------------------------ 3. Add Additional Files
    <div key="files" data-testid="np-page-files">
      <GroupBox label="Add existing files to the project">
        <div className="cw-sunken" style={{ height: 140, background: 'var(--cw-window)', color: 'var(--cw-gray-text)', padding: 4 }}>
          Adding files from the wizard is not available: use Project &gt; Add Files... after Finish.
        </div>
        <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
          <Button disabled>Add</Button>
          <Button disabled>Remove</Button>
        </div>
        <Checkbox label="Copy files to project" checked={false} disabled />
      </GroupBox>
      <Checkbox label="Create main.c/main.asm file" checked disabled title="The stationery always has Sources/main.asm" />
    </div>,
  ];

  return (
    <Dialog
      title="HC(S)12(X) Microcontrollers New Project"
      open={open}
      onClose={onClose}
      width={720}
      testId="new-project-dialog"
      buttons={
        <>
          <Button disabled={busy || page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} testId="np-back">
            &lt; Back
          </Button>
          <Button disabled={busy || page === WIZARD_PAGES.length - 1} onClick={() => setPage((p) => Math.min(WIZARD_PAGES.length - 1, p + 1))} testId="np-next">
            Next &gt;
          </Button>
          <Button isDefault disabled={busy} onClick={() => void finish()} testId="np-finish">
            Finish
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 8 }}>
        <div className="cw-sunken" style={{ width: 150, flex: 'none', background: 'var(--cw-window)', padding: 4 }} data-testid="np-wizard-map" aria-label="Wizard Map">
          <div style={{ fontWeight: 'bold', marginBottom: 4 }}>Wizard Map</div>
          {WIZARD_PAGES.map((t, i) => (
            <div key={t} style={{ padding: '2px 0', fontWeight: i === page ? 'bold' : undefined, color: i > page ? 'var(--cw-gray-text)' : undefined, cursor: 'default' }} onMouseDown={() => setPage(i)} aria-current={i === page ? 'step' : undefined}>
              {i + 1}. {t}
            </div>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 'bold', marginBottom: 6 }} data-testid="np-page-title">
            {WIZARD_PAGES[page]}
          </div>
          {pageBody[page]}
        </div>
      </div>
      {error && (
        <div className="ide-error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  );
}
